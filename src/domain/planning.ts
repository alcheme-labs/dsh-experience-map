import { createHash, randomUUID } from 'node:crypto'
import { ExperienceError } from '../errors.js'
import { brandedId } from '../ids.js'
import type {
  ComponentId,
  ComponentRevisionId,
  ExperienceId,
  ExperienceRelationId,
  ExperienceVersionId,
} from '../ids.js'
import type {
  ActorView,
  AllowedUseMode,
  ComponentRole,
  ExperienceVersionView,
  MatchCandidateView,
  MatchSetView,
  PlanContributionView,
  PlanningObservationView,
  PlanningTaskInput,
  PreflightRecordView,
  TaskFingerprintView,
  UsagePlanView,
  ExperienceRelationView,
  ExperienceRelationObjectRef,
  OverrideDecisionView,
  PreferenceEnforcementView,
} from '../types.js'

const MIN_LEXICAL_OVERLAP = 2

/** A2b finite Chinese term aliases; each group is exactly one lexical signal. */
const LEXICAL_ALIAS_GROUPS: readonly { readonly han: string; readonly canonical: string }[] = [
  { han: '证书', canonical: 'certificate' },
  { han: '过期', canonical: 'expired' },
  { han: '超时', canonical: 'timeout' },
]

/**
 * The only explicit symptom error codes that A2b recognizes as a positive
 * signal. Codes are matched whole (NFKC/lowercase/full-identifier boundary);
 * nothing outside this set receives special treatment.
 */
const EXPLICIT_SYMPTOM_CODES = new Set([
  'eaddrinuse',
  'eaddrnotavail',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eai_again',
  'cert_has_expired',
  'err_tls_cert_altname_invalid',
  '401',
  '404',
  'http_401',
  'http_404',
  'unsupported_engine',
])

/** Narrow cross-language aliases for the registered deterministic failure vocabulary. */
const EXPLICIT_SYMPTOM_ALIASES: readonly { readonly pattern: RegExp; readonly canonical: string }[] = [
  { pattern: /连接(?:被)?拒绝/u, canonical: 'econnrefused' },
  { pattern: /端口(?:已)?被占用|地址(?:已)?被占用/u, canonical: 'eaddrinuse' },
  { pattern: /请求超时|连接超时/u, canonical: 'etimedout' },
  { pattern: /未认证|未经认证/u, canonical: '401' },
]

/** Candidate rejection codes that must surface as a preflight blocker. */
const REJECTION_BLOCKER_CODES = new Set([
  'exact_signal_conflict',
  'hard_scope_conflict',
  'capability_mismatch',
  'use_mode_not_allowed',
  'version_not_current',
])

/** M3 planning bounds controlled by validated deployment configuration. */
export interface PlanningPolicy {
  readonly retrievalCandidateLimit: number
  readonly observationFreshnessMs: number
  readonly planApprovalTtlMs: number
  readonly maxPlanningTaskBytes: number
}

/**
 * Task-side hard-eligibility facts the matcher needs in addition to the
 * fingerprint. The public matchExperiences entry uses permissive defaults so
 * callers without a task keep the historic behavior; the real planning entry
 * passes the actual task facts so unusable Experiences never occupy a top-N
 * slot ahead of a usable one.
 */
export interface MatchingEligibility {
  readonly requestedUseMode: 'suggest' | 'guided'
  readonly workspaceRoot: string | null
  readonly requiredCapabilities: readonly string[]
}

/**
 * The narrow read-only retrieval projection produced by the scan. It carries
 * only the fields the matcher reads; it is NOT an authoritative
 * ExperienceVersionView and must not flow into Preflight/Composition. The full,
 * validated version for any selected candidate is read through the repository's
 * authoritative read inside the same snapshot.
 */
export interface ExperienceMatchProjection {
  readonly experienceVersionId: ExperienceVersionId
  readonly experienceId: ExperienceId
  readonly kind: ExperienceVersionView['kind']
  readonly title: string
  readonly intent: string
  readonly scope: Readonly<Record<string, string>>
  readonly validity: Readonly<Record<string, string>>
  readonly riskAndEffectSpec: Readonly<Record<string, string>>
  readonly privacyClass: 'public' | 'workspace' | 'restricted' | 'secret_reference_only'
  readonly allowedUseModes: readonly AllowedUseMode[]
  readonly evidenceGrade: ExperienceVersionView['evidenceGrade']
  readonly contentDigest: string
  readonly componentRevisionIds: readonly ComponentRevisionId[]
  readonly components: readonly {
    readonly componentId: ComponentId
    readonly componentRevisionId: ComponentRevisionId
    readonly role: ComponentRole
    readonly content: string
  }[]
}

/** Build the Host-owned stable fingerprint; proposal fields may widen retrieval only. */
export function fingerprintTask(
  task: PlanningTaskInput,
  actor: ActorView,
  now: string,
  proposal: Partial<Pick<TaskFingerprintView,
    'intent' | 'taskFamily' | 'entities' | 'expectedOutputs' | 'artifactKinds' | 'capabilities' | 'acceptanceCriteria'>> = {},
): TaskFingerprintView {
  const taskInputDigest = digest(task)
  const words = tokenize(task.text)
  const intent = bounded(proposal.intent) ?? task.text.trim().slice(0, 240)
  const taskFamily = bounded(proposal.taskFamily) ?? inferTaskFamily(words)
  const capabilities = unique([
    ...task.requiredCapabilities,
    ...(proposal.capabilities ?? []),
    ...inferCapabilities(words),
  ])
  return {
    fingerprintId: brandedId<'ExperienceTaskFingerprintId'>(randomUUID(), 'fingerprintId'),
    schemaVersion: 'task-fingerprint-v1',
    taskInputDigest,
    taskText: task.text,
    actorRef: actor.actorId,
    intent,
    taskFamily,
    entities: unique(proposal.entities ?? []),
    expectedOutputs: unique(proposal.expectedOutputs ?? []),
    artifactKinds: unique(proposal.artifactKinds ?? inferArtifacts(words)),
    capabilities,
    environmentRefs: task.workspaceRoot === null ? [] : [task.workspaceRoot],
    hardConstraints: [
      `target_exposure:${task.targetExposure}`,
      `risk_class:${task.riskClass}`,
      `must_use_experience:${String(task.mustUseExperience)}`,
      ...task.requiredCapabilities.map(value => `required_capability:${value}`),
    ],
    acceptanceCriteria: unique(proposal.acceptanceCriteria ?? []),
    riskClass: task.riskClass,
    targetExposure: task.targetExposure,
    fieldProvenance: {
      taskText: 'explicit_user_input',
      targetExposure: 'explicit_user_input',
      riskClass: 'explicit_user_input',
      requiredCapabilities: 'explicit_user_input',
      taskInputDigest: 'deterministic_host',
      actorRef: 'deterministic_host',
      intent: proposal.intent === undefined ? 'deterministic_host' : 'model_proposal',
      taskFamily: proposal.taskFamily === undefined ? 'deterministic_host' : 'model_proposal',
      entities: proposal.entities === undefined ? 'deterministic_host' : 'model_proposal',
      expectedOutputs: proposal.expectedOutputs === undefined ? 'deterministic_host' : 'model_proposal',
      artifactKinds: proposal.artifactKinds === undefined ? 'deterministic_host' : 'model_proposal',
      capabilities: proposal.capabilities === undefined ? 'deterministic_host' : 'model_proposal',
      acceptanceCriteria: proposal.acceptanceCriteria === undefined ? 'deterministic_host' : 'model_proposal',
    },
    createdAt: now,
  }
}

/** Exact direct-user task identity that the Agent pre-step can reconstruct without inferred fields. */
export function admissionTaskDigest(taskText: string): string {
  return digest({ schemaVersion: 'experience-admission-task-v1', text: taskText })
}

/** Deterministic approved scope kept separate from direct-user task identity. */
export function usageScopeDigest(task: PlanningTaskInput): string {
  return digest({
    schemaVersion: 'experience-usage-scope-v1',
    workspaceRoot: task.workspaceRoot,
    targetExposure: task.targetExposure,
    mustUseExperience: task.mustUseExperience,
    riskClass: task.riskClass,
    requiredCapabilities: [...task.requiredCapabilities].sort(),
    requestedUseMode: task.requestedUseMode,
    overrideDecisionIds: [...task.overrideDecisionIds].sort(),
  })
}

/** Durable identity for one supported automatic recall trigger. */
export function recallDecisionKey(input: {
  readonly sessionId: string
  readonly actorRef: string
  readonly task: PlanningTaskInput
  readonly triggerKind: 'initial_user_turn' | 'registered_tool_failure' | 'environment_generation_changed'
  readonly triggerGeneration: string
}): string {
  return digest({
    schemaVersion: 'experience-recall-decision-key-v1',
    sessionId: input.sessionId,
    actorRef: input.actorRef,
    taskFingerprintDigest: admissionTaskDigest(input.task.text),
    scopeDigest: usageScopeDigest(input.task),
    triggerKind: input.triggerKind,
    triggerGeneration: input.triggerGeneration,
  })
}

/** Stable candidate reorder to an authorized history-ranking version order (unknowns keep position). */
export function reorderCandidatesByRank(
  candidates: readonly MatchCandidateView[],
  historyRankOrder: readonly string[],
): MatchCandidateView[] {
  const rank = new Map(historyRankOrder.map((versionId, index) => [versionId, index]))
  return [...candidates].sort((left, right) => {
    const leftRank = rank.get(String(left.experienceVersionId)) ?? Number.MAX_SAFE_INTEGER
    const rightRank = rank.get(String(right.experienceVersionId)) ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank
      || String(left.experienceVersionId).localeCompare(String(right.experienceVersionId))
  })
}

/** Deterministic candidate ordering owned by the existing matcher semantics. */
export function compareMatchCandidates(
  left: MatchCandidateView,
  right: MatchCandidateView,
): number {
  return Number(left.rejected) - Number(right.rejected)
    || right.structuralScore - left.structuralScore
    || right.lexicalScore - left.lexicalScore
    || String(left.experienceVersionId).localeCompare(String(right.experienceVersionId))
}

/**
 * Rank every legal Experience projection and return only the top candidateLimit
 * candidates plus the projections that would enter the final MatchSet. The
 * input is iterated lazily so the whole corpus is never retained at once: only
 * the top-N projections stay in memory (a bounded number). This performs no
 * authorization and no authoritative validation; the caller must re-read and
 * validate the full version for every selected candidate in the same snapshot
 * before those versions reach Preflight/Composition.
 */
export function selectMatchingExperiences(
  fingerprint: TaskFingerprintView,
  versions: Iterable<ExperienceMatchProjection>,
  candidateLimit: number,
  now: string,
  eligibility: MatchingEligibility = permissiveEligibility(),
): { readonly matchSet: MatchSetView; readonly selectedProjections: ExperienceMatchProjection[] } {
  const taskTokens = taskTokensFor(fingerprint)
  const retained: { candidate: MatchCandidateView; projection: ExperienceMatchProjection }[] = []
  for (const version of versions) {
    const candidate = matchVersion(fingerprint, taskTokens, version, eligibility)
    if (candidate.lexicalScore === 0 && candidate.structuralScore === 0) continue
    retained.push({ candidate, projection: version })
    retained.sort((left, right) => compareMatchCandidates(left.candidate, right.candidate))
    if (retained.length > candidateLimit) retained.pop()
  }
  const selected = retained.slice(0, candidateLimit)
  const candidates = selected.map(item => item.candidate)
  const matchSet: MatchSetView = {
    matchSetId: brandedId<'ExperienceMatchSetId'>(randomUUID(), 'matchSetId'),
    fingerprintId: fingerprint.fingerprintId,
    retrievalVersion: 'bounded-structural-lexical-v1',
    candidateLimit,
    candidates,
    noMatch: candidates.every(candidate => candidate.selectedComponentRevisionIds.length === 0),
    createdAt: now,
  }
  return { matchSet, selectedProjections: selected.map(item => item.projection) }
}

/** Retrieve accepted versions with bounded structural and lexical ranking. */
export function matchExperiences(
  fingerprint: TaskFingerprintView,
  versions: readonly ExperienceVersionView[],
  candidateLimit: number,
  now: string,
): MatchSetView {
  return selectMatchingExperiences(fingerprint, versions, candidateLimit, now).matchSet
}

/** Build the default permissive eligibility used by callers without a task. */
export function permissiveEligibility(): MatchingEligibility {
  return { requestedUseMode: 'guided', workspaceRoot: null, requiredCapabilities: [] }
}

/** Marshal the real task facts into the matcher eligibility context. */
export function matchingEligibilityFor(
  task: Pick<PlanningTaskInput, 'requestedUseMode' | 'workspaceRoot' | 'requiredCapabilities'>,
): MatchingEligibility {
  return {
    requestedUseMode: task.requestedUseMode,
    workspaceRoot: task.workspaceRoot ?? null,
    requiredCapabilities: task.requiredCapabilities,
  }
}

function taskTokensFor(fingerprint: TaskFingerprintView): Set<string> {
  return new Set(tokenizeLanguage([
    fingerprint.taskText,
    fingerprint.intent,
    fingerprint.taskFamily,
    ...fingerprint.capabilities,
    ...fingerprint.artifactKinds,
  ].join(' ')))
}

/** Evaluate current observations before any component can enter a plan. */
export function preflightMatch(
  fingerprint: TaskFingerprintView,
  matchSet: MatchSetView,
  version: ExperienceVersionView,
  observations: readonly PlanningObservationView[],
  now: string,
  validUntil: string,
): PreflightRecordView {
  const candidate = matchSet.candidates.find(item => item.experienceVersionId === version.experienceVersionId)
  if (candidate === undefined) throw new ExperienceError('not_found', 'matched Experience version is unavailable')
  const blockers: string[] = []
  const reasons = [...candidate.reasonCodes]
  const relevantComponents = version.components.filter(component =>
    candidate.selectedComponentRevisionIds.includes(component.componentRevisionId))
  const factValidUntil = version.kind === 'fact' ? Date.parse(version.validity.validUntil ?? '') : Number.NaN
  const factStale = version.kind === 'fact'
    && (!Number.isFinite(factValidUntil) || factValidUntil <= Date.parse(now))
  if (factStale) reasons.push('fact_freshness_expired')
  const webContract = observations.find(item => item.kind === 'web_contract')
  const invalidAnonymousVerifier = relevantComponents.some(component =>
    /anonymous|unauthenticated|without auth|200\b/iu.test(component.content))
    && webContract?.status === 'observed'
    && webContract.values.authRequired === true
  if (invalidAnonymousVerifier) reasons.push('condition_invalidated_by_current_auth_contract')
  const requiredUnknown = observations.some(item => item.status === 'unknown'
    && (item.kind === 'repository_state' || item.kind === 'build_artifact' || item.kind === 'web_contract'))
  if (candidate.rejected && candidate.selectedComponentRevisionIds.length === 0) {
    const rejectionReasons = candidate.reasonCodes.filter(reason => REJECTION_BLOCKER_CODES.has(reason))
    blockers.push(...(rejectionReasons.length > 0 ? rejectionReasons : ['hard_scope_conflict']))
  }
  if (requiredUnknown && fingerprint.riskClass !== 'standard') blockers.push('required_observation_unknown')
  const disposition: PreflightRecordView['disposition'] = factStale
    ? 'stale'
    : blockers.length > 0
    ? 'blocked'
    : invalidAnonymousVerifier ? 'adaptable'
      : candidate.rejected ? 'adaptable'
        : requiredUnknown ? 'adaptable' : 'applicable'
  const recordWithoutDigest = {
    preflightId: brandedId<'ExperiencePreflightId'>(randomUUID(), 'preflightId'),
    fingerprintId: fingerprint.fingerprintId,
    matchSetId: matchSet.matchSetId,
    experienceVersionId: version.experienceVersionId,
    observations,
    disposition,
    blockers: unique(blockers),
    reasonCodes: unique(reasons),
    checkedAt: now,
    validUntil,
  }
  return { ...recordWithoutDigest, digest: digest({
    fingerprintTaskInputDigest: fingerprint.taskInputDigest,
    experienceVersionId: version.experienceVersionId,
    observations: observations.map(item => item.contentDigest),
    disposition,
    blockers: recordWithoutDigest.blockers,
    reasonCodes: recordWithoutDigest.reasonCodes,
    checkedAt: now,
    validUntil,
  }) }
}

/** Project version components into the closed contribution vocabulary. */
export function contributionsFor(
  version: ExperienceVersionView,
  candidate: MatchCandidateView,
  preflight: PreflightRecordView,
): PlanContributionView[] {
  if (preflight.disposition === 'blocked' || preflight.disposition === 'irrelevant'
    || preflight.disposition === 'conflicting' || preflight.disposition === 'stale') return []
  const invalidatedAnonymous = preflight.reasonCodes.includes('condition_invalidated_by_current_auth_contract')
  return version.components.flatMap((component, index) => {
    if (!candidate.selectedComponentRevisionIds.includes(component.componentRevisionId)) return []
    if (invalidatedAnonymous && /anonymous|unauthenticated|without auth|200\b/iu.test(component.content)) return []
    const contributionType = contributionTypeFor(component.role)
    if (contributionType === null) return []
    return [{
      contributionId: String(component.componentRevisionId),
      experienceVersionId: version.experienceVersionId,
      componentRevisionId: component.componentRevisionId,
      role: component.role,
      content: component.content,
      contributionType,
      priority: priorityFor(contributionType, index),
      precedes: [],
      conflictsWith: [],
      relationIds: [],
    }]
  })
}

/** Select every contribution-typed component of one required dependency version. */
function dependencyCandidate(version: ExperienceVersionView): MatchCandidateView {
  const selected = version.components
    .filter(component => contributionTypeFor(component.role) !== null)
    .map(component => component.componentRevisionId)
  return {
    experienceVersionId: version.experienceVersionId,
    experienceId: version.experienceId,
    title: version.title,
    componentRevisionIds: version.componentRevisionIds,
    selectedComponentRevisionIds: selected,
    structuralScore: 0,
    lexicalScore: 0,
    rejected: false,
    reasonCodes: ['required_dependency'],
  }
}

/** Build a minimal MatchSet carrying one dependency candidate, reusing the plan matchSetId. */
function dependencyMatchSet(
  fingerprint: TaskFingerprintView,
  candidate: MatchCandidateView,
  matchSetId: MatchSetView['matchSetId'],
  now: string,
): MatchSetView {
  return {
    matchSetId,
    fingerprintId: fingerprint.fingerprintId,
    retrievalVersion: 'bounded-structural-lexical-v1',
    candidateLimit: 1,
    candidates: [candidate],
    noMatch: false,
    createdAt: now,
  }
}

/**
 * Evaluate one required dependency version (already resolved by the repository to
 * an exact current-active readable revision) through the same permission,
 * integrity, applicability and safety checks as a matched version, bypassing
 * top-K. Returns its preflight (or null when it is unusable), its contributions,
 * and a reason code when the dependency cannot be legally satisfied: a
 * use-mode/scope mismatch or a blocking applicability/safety condition. Low
 * lexical relevance is explicitly NOT a reason to reject a legal dependency.
 */
export function planDependency(
  fingerprint: TaskFingerprintView,
  version: ExperienceVersionView,
  observations: readonly PlanningObservationView[],
  now: string,
  validUntil: string,
  task: PlanningTaskInput,
  matchSetId: MatchSetView['matchSetId'],
): {
  readonly preflight: PreflightRecordView | null
  readonly contributions: readonly PlanContributionView[]
  readonly unsatisfiableReason: string | null
} {
  const eligibility = matchingEligibilityFor(task)
  if (!version.allowedUseModes.includes(eligibility.requestedUseMode)) {
    return { preflight: null, contributions: [], unsatisfiableReason: 'required_dependency_use_mode_not_allowed' }
  }
  if (scopeDeclaredMismatch(version.scope, fingerprint, eligibility)) {
    return { preflight: null, contributions: [], unsatisfiableReason: 'required_dependency_scope_conflict' }
  }
  const candidate = dependencyCandidate(version)
  const matchSet = dependencyMatchSet(fingerprint, candidate, matchSetId, now)
  const preflight = preflightMatch(fingerprint, matchSet, version, observations, now, validUntil)
  if (preflight.disposition === 'blocked') {
    return { preflight, contributions: [], unsatisfiableReason: 'required_dependency_blocked' }
  }
  return { preflight, contributions: contributionsFor(version, candidate, preflight), unsatisfiableReason: null }
}

function automaticFocusRoles(kind: ExperienceMatchProjection['kind']): readonly ComponentRole[] {
  switch (kind) {
    case 'procedure': return ['goal_signature']
    case 'diagnostic': return ['symptom_signature']
    case 'preference_policy': return ['task_or_output_scope']
    case 'fact': return ['subject', 'predicate']
    case 'strategy': return ['decision_point']
    case 'causal': return ['cause_or_intervention', 'effect_or_metric', 'applicability_condition']
  }
}

/**
 * High-precision deterministic focus signal for every Experience saved directly
 * from an automatic Session suggestion. Every kind's identity component needs
 * 75% task-token coverage; Diagnostics may instead use one exact registered
 * failure signature. The hybrid owner may defer this one signal to its calibrated
 * dense policy, but hard scope, safety, capability and use-mode gates stay final.
 */
function automaticFocusMatches(
  taskText: string,
  taskTokens: ReadonlySet<string>,
  version: ExperienceMatchProjection,
): boolean {
  // E6 introduces this direct-save source. Older manually reviewed Versions
  // keep their established retrieval/relationship behavior.
  if (version.validity.source !== 'completed_dsh_session_turn') return true
  const roles = automaticFocusRoles(version.kind)
  const focusTokenSets = version.components
    .filter(component => roles.includes(component.role))
    .map(component => new Set(tokenizeLanguage(component.content)))
    .filter(tokens => tokens.size > 0)
  if (focusTokenSets.length === 0) return false
  if (version.kind === 'diagnostic') {
    const taskCodes = new Set(registeredFailureSignatures(taskText))
    const focusCodes = new Set(focusTokenSets.flatMap(tokens => [...tokens])
      .filter(token => EXPLICIT_SYMPTOM_CODES.has(token)))
    if (taskCodes.size > 0 && focusCodes.size > 0) {
      return [...taskCodes].some(code => focusCodes.has(code))
    }
  }
  return focusTokenSets.every(tokens => {
    const overlap = [...tokens].filter(token => taskTokens.has(token)).length
    return overlap / tokens.size >= 0.75
  })
}

function explicitPreferenceSubjectConflict(taskText: string, version: ExperienceMatchProjection): boolean {
  if (version.kind !== 'preference_policy') return false
  const subject = version.components.find(component => component.role === 'subject_scope')?.content ?? ''
  const identifier = (value: string): string | null => {
    const match = /(?:用户|user)\s*([A-Za-z0-9_-]+)/iu.exec(value)
    return match?.[1]?.toLowerCase() ?? null
  }
  const taskSubject = identifier(taskText)
  const experienceSubject = identifier(subject)
  return taskSubject !== null && experienceSubject !== null && taskSubject !== experienceSubject
}

/** A `requires` edge mapped to the contribution ids it binds, including unresolved targets. */
export interface RequiredDependencyEdge {
  readonly relationId: ExperienceRelationId
  readonly sourceContributionIds: readonly string[]
  readonly targetContributionIds: readonly string[]
  /** Exact blocker to surface only when the requiring source survives composition. */
  readonly unsatisfiableBlocker?: string
}

/** An explicit-optional component declaration that may prune one same-version action. */
export interface OptionalComponentPrune {
  readonly relationId: ExperienceRelationId
  readonly anchorContributionId: string
  readonly optionalContributionId: string
}

/** A contribution already removed before composition (e.g. an explicit-optional action). */
export interface PreDiscardedContribution {
  readonly contributionId: string
  readonly reasonCode: string
}

/** Return the contribution ids in `contributions` that belong to one canonical relation endpoint. */
export function endpointContributionIds(
  ref: ExperienceRelationObjectRef,
  contributions: readonly PlanContributionView[],
  versions: readonly ExperienceVersionView[],
): string[] {
  if (ref.kind === 'version') {
    return contributions.filter(item => item.experienceVersionId === ref.id).map(item => item.contributionId)
  }
  if (ref.kind !== 'component') return []
  const matched = new Set<string>()
  for (const version of versions) {
    const component = version.components.find(item => item.componentId === ref.id)
    if (component === undefined) continue
    const revision = String(component.componentRevisionId)
    for (const item of contributions) {
      if (item.experienceVersionId === version.experienceVersionId && String(item.componentRevisionId) === revision) {
        matched.add(item.contributionId)
      }
    }
  }
  return [...matched]
}

const OPTIONAL_COMPONENT_ROLES = new Set<ComponentRole>(['step', 'resolution_candidate'])

/**
 * H1 explicit-optional component selection (coordinator decision). A LocalOwner may declare,
 * on the canonical `composes_with` relation between two step/resolution_candidate components of
 * the SAME current-active version, that one exact task does not need one of them. Only the full
 * exact policy activates: scope.taskInputDigest must equal the fingerprint taskInputDigest,
 * selectionPolicy = explicit_optional_component, the two endpoint revisions must match the
 * anchor/optional revision qualifiers (which must belong to the same version and be distinct),
 * and the roles must be step/resolution_candidate. Anything else is conservatively retained.
 * Contradictory declarations (each optional of the other) are retained and flagged for
 * adaptation; the caller keeps both.
 */
export function applyExplicitOptionalSelection(
  contributions: readonly PlanContributionView[],
  versions: readonly ExperienceVersionView[],
  relations: readonly ExperienceRelationView[],
  fingerprint: TaskFingerprintView,
  now: string,
): {
  readonly prunes: readonly OptionalComponentPrune[]
  readonly discarded: readonly PreDiscardedContribution[]
  readonly blockers: readonly string[]
} {
  const versionByComponent = new Map<string, { version: ExperienceVersionView; component: ExperienceVersionView['components'][number] }>()
  for (const version of versions) {
    for (const component of version.components) versionByComponent.set(component.componentId, { version, component })
  }
  const contributionByComponent = new Map<string, PlanContributionView>()
  for (const contribution of contributions) {
    const version = versions.find(item => item.experienceVersionId === contribution.experienceVersionId)
    const component = version?.components.find(item => item.componentRevisionId === contribution.componentRevisionId)
    if (component !== undefined) contributionByComponent.set(component.componentId, contribution)
  }
  // Any `precedes` edge that touches the optional action makes its order/check dependency
  // unresolvable, so the action is conservatively retained (H1-DECISION rule 4).
  const precededComponentIds = new Set<string>()
  for (const relation of relations) {
    if (relation.relationType !== 'precedes') continue
    if (relation.sourceObjectRef.kind === 'component') precededComponentIds.add(relation.sourceObjectRef.id)
    if (relation.targetObjectRef.kind === 'component') precededComponentIds.add(relation.targetObjectRef.id)
  }

  interface Declaration { readonly anchorId: string; readonly optionalId: string; readonly relationId: ExperienceRelationId }
  const declarations: Declaration[] = []
  for (const relation of relations) {
    if (relation.relationType !== 'composes_with') continue
    if (relation.qualifiers.selectionPolicy !== 'explicit_optional_component') continue
    if (relation.scope.taskInputDigest !== fingerprint.taskInputDigest) continue
    if (Date.parse(relation.validFrom) > Date.parse(now)
      || (relation.validTo !== null && Date.parse(relation.validTo) <= Date.parse(now))) continue
    const source = versionByComponent.get(relation.sourceObjectRef.id)
    const target = versionByComponent.get(relation.targetObjectRef.id)
    // Both endpoints must be components in the SAME current-active version.
    if (source === undefined || target === undefined || source.version.experienceVersionId !== target.version.experienceVersionId) continue
    if (!OPTIONAL_COMPONENT_ROLES.has(source.component.role) || !OPTIONAL_COMPONENT_ROLES.has(target.component.role)) continue
    if (relation.sourceObjectRef.id === relation.targetObjectRef.id) continue
    const anchorRevision = relation.qualifiers.anchorComponentRevisionId
    const optionalRevision = relation.qualifiers.optionalComponentRevisionId
    if (anchorRevision === undefined || optionalRevision === undefined || anchorRevision === optionalRevision) continue
    // composes_with is directionless: match the anchor/optional qualifiers to the two endpoints
    // by their exact revisions, so a reversed declaration selects identically.
    let anchorComponent: ExperienceVersionView['components'][number] | undefined
    let optionalComponent: ExperienceVersionView['components'][number] | undefined
    if (String(source.component.componentRevisionId) === anchorRevision && String(target.component.componentRevisionId) === optionalRevision) {
      anchorComponent = source.component; optionalComponent = target.component
    } else if (String(source.component.componentRevisionId) === optionalRevision && String(target.component.componentRevisionId) === anchorRevision) {
      anchorComponent = target.component; optionalComponent = source.component
    } else continue
    const anchor = contributionByComponent.get(anchorComponent.componentId)
    const optional = contributionByComponent.get(optionalComponent.componentId)
    if (anchor === undefined || optional === undefined) continue
    // An unresolved order/check dependency involving the optional action conservatively retains it.
    if (precededComponentIds.has(optionalComponent.componentId)) continue
    declarations.push({ anchorId: anchor.contributionId, optionalId: optional.contributionId, relationId: relation.relationId })
  }

  const prunes: OptionalComponentPrune[] = []
  const discarded: PreDiscardedContribution[] = []
  const blockers: string[] = []
  const removed = new Set<string>()
  for (const declaration of declarations) {
    // Mutual declarations (A optional of B and B optional of A): keep both and require adaptation.
    const contradicting = declarations.find(other =>
      other.anchorId === declaration.optionalId && other.optionalId === declaration.anchorId)
    if (contradicting !== undefined && !removed.has(declaration.anchorId)) {
      blockers.push('explicit_optional_contradiction')
      continue
    }
    if (removed.has(declaration.optionalId)) continue
    prunes.push({
      relationId: declaration.relationId,
      anchorContributionId: declaration.anchorId,
      optionalContributionId: declaration.optionalId,
    })
    discarded.push({ contributionId: declaration.optionalId, reasonCode: 'explicit_optional_component' })
    removed.add(declaration.optionalId)
  }
  return { prunes, discarded, blockers }
}

/** Apply active canonical ordering and conflict relations to exact selected contributions. */
export function applyPlanningRelations(
  contributions: readonly PlanContributionView[],
  versions: readonly ExperienceVersionView[],
  relations: readonly ExperienceRelationView[],
  overrides: readonly OverrideDecisionView[],
  task: PlanningTaskInput,
): {
  readonly contributions: readonly PlanContributionView[]
  readonly selectedRelationIds: readonly ExperienceRelationView['relationId'][]
  readonly overrideDecisionIds: readonly OverrideDecisionView['overrideDecisionId'][]
  readonly preferenceEnforcements: readonly PreferenceEnforcementView[]
} {
  const activeOverrides = overrides.filter(override => overrideScopeMatches(override, task))
  const overrideByRelation = new Map(activeOverrides.map(override => [override.targetRelationId, override]))
  const selectedRelationIds: ExperienceRelationView['relationId'][] = []
  const byContribution = new Map(contributions.map(item => [item.contributionId, { ...item }]))
  const contributionsForRef = (ref: ExperienceRelationView['sourceObjectRef']): string[] => {
    if (ref.kind === 'version') {
      return contributions.filter(item => item.experienceVersionId === ref.id).map(item => item.contributionId)
    }
    if (ref.kind !== 'component') return []
    const revisionIds = versions.flatMap(version => version.components)
      .filter(component => component.componentId === ref.id)
      .map(component => String(component.componentRevisionId))
    return contributions.filter(item => revisionIds.includes(String(item.componentRevisionId)))
      .map(item => item.contributionId)
  }
  for (const relation of relations) {
    const sources = contributionsForRef(relation.sourceObjectRef)
    const targets = contributionsForRef(relation.targetObjectRef)
    if (sources.length === 0 || targets.length === 0) continue
    if (relation.relationType !== 'precedes' && relation.relationType !== 'conflicts_with'
      && relation.relationType !== 'requires' && relation.relationType !== 'composes_with') continue
    selectedRelationIds.push(relation.relationId)
    if (relation.relationType === 'conflicts_with' && overrideByRelation.has(relation.relationId)) continue
    for (const sourceId of sources) {
      const source = byContribution.get(sourceId)
      if (source === undefined) continue
      if (relation.relationType === 'precedes') {
        byContribution.set(sourceId, { ...source, precedes: unique([...source.precedes, ...targets]), relationIds: unique([
          ...source.relationIds, relation.relationId,
        ]) })
      } else if (relation.relationType === 'conflicts_with') {
        byContribution.set(sourceId, { ...source, conflictsWith: unique([
          ...source.conflictsWith, ...targets,
        ]), relationIds: unique([...source.relationIds, relation.relationId]) })
        for (const targetId of targets) {
          const target = byContribution.get(targetId)
          if (target !== undefined) byContribution.set(targetId, { ...target, conflictsWith: unique([
            ...target.conflictsWith, sourceId,
          ]), relationIds: unique([...target.relationIds, relation.relationId]) })
        }
      } else {
        byContribution.set(sourceId, { ...source, relationIds: unique([...source.relationIds, relation.relationId]) })
        if (relation.relationType === 'requires') {
          for (const targetId of targets) {
            const target = byContribution.get(targetId)
            if (target !== undefined) byContribution.set(targetId, {
              ...target,
              relationIds: unique([...target.relationIds, relation.relationId]),
            })
          }
        }
      }
    }
  }
  return {
    contributions: contributions.map(item => byContribution.get(item.contributionId) ?? item),
    selectedRelationIds: unique(selectedRelationIds).sort(),
    overrideDecisionIds: activeOverrides.map(item => item.overrideDecisionId).sort(),
    preferenceEnforcements: preferenceEnforcements(versions),
  }
}

/** Compose an immutable exact plan independent of retrieval or input order. */
export function composeUsagePlan(
  fingerprint: TaskFingerprintView,
  matchSet: MatchSetView,
  preflights: readonly PreflightRecordView[],
  contributions: readonly PlanContributionView[],
  now: string,
  options: {
    readonly useMode?: 'suggest' | 'guided'
    readonly selectedRelationIds?: readonly ExperienceRelationView['relationId'][]
    readonly overrideDecisionIds?: readonly OverrideDecisionView['overrideDecisionId'][]
    readonly preferenceEnforcements?: readonly PreferenceEnforcementView[]
    /** `requires` edges whose retained source forces a resolved target or its exact blocker. */
    readonly requiredDependencies?: readonly RequiredDependencyEdge[]
    /** Contributions fetched only through the required-dependency closure, never by base retrieval. */
    readonly importedDependencyContributionIds?: readonly string[]
    /** Replacement preflights produced while importing required dependencies. */
    readonly dependencyPreflightIds?: readonly string[]
    /** Explicit-optional component prunes; the anchor must be finally retained. */
    readonly optionalPrunes?: readonly OptionalComponentPrune[]
    /** Contributions already removed before composition (e.g. explicit-optional actions). */
    readonly preDiscardedContributions?: readonly PreDiscardedContribution[]
    /** Whole-plan blockers that are independent of any source-retained dependency edge. */
    readonly additionalBlockers?: readonly string[]
    /** Authorized history-ranking version order; readjusts selected order within equal-relevance candidates. */
    readonly historyRankOrder?: readonly string[]
  } = {},
): UsagePlanView {
  const allCanonical = [...contributions].sort((left, right) => left.priority - right.priority
    || left.contributionId.localeCompare(right.contributionId))
  const allById = new Map(allCanonical.map(item => [item.contributionId, item]))
  if (allById.size !== allCanonical.length) throw new ExperienceError('invalid_command', 'plan contribution ids must be unique')
  const importedDependencyIds = new Set(options.importedDependencyContributionIds ?? [])
  const availableIds = new Set(allCanonical.map(item => item.contributionId))
  const initiallyReachable = reachableRequiredContributions(
    allCanonical.filter(item => !importedDependencyIds.has(item.contributionId))
      .map(item => item.contributionId),
    availableIds,
    options.requiredDependencies ?? [],
  )
  // A dependency-only contribution cannot participate in dedup, conflicts, ordering or policy
  // enforcement until an actual base contribution reaches it through a `requires` edge.
  const canonical = allCanonical.filter(item =>
    !importedDependencyIds.has(item.contributionId) || initiallyReachable.has(item.contributionId))
  const byId = new Map(canonical.map(item => [item.contributionId, item]))
  const dispositionByVersion = new Map(preflights.map(item => [item.experienceVersionId, item.disposition]))
  // OPT-C: an authorized history-ranking reorder readjusts candidate positions (match rank) so the
  // approved proposed-first candidate also wins same-content/conflict selection and leads the plan.
  const candidateOrder = options.historyRankOrder === undefined
    ? matchSet.candidates
    : reorderCandidatesByRank(matchSet.candidates, options.historyRankOrder)
  const matchRankByVersion = new Map(candidateOrder.map((item, index) => [item.experienceVersionId, index]))
  const compareCurrentFit = (left: PlanContributionView, right: PlanContributionView): number =>
    preflightPriority(dispositionByVersion.get(left.experienceVersionId))
      - preflightPriority(dispositionByVersion.get(right.experienceVersionId))
    || (matchRankByVersion.get(left.experienceVersionId) ?? Number.MAX_SAFE_INTEGER)
      - (matchRankByVersion.get(right.experienceVersionId) ?? Number.MAX_SAFE_INTEGER)
    || compareContribution(left, right)
  const discarded = new Map<string, string>(allCanonical
    .filter(item => importedDependencyIds.has(item.contributionId) && !initiallyReachable.has(item.contributionId))
    .map(item => [item.contributionId, 'required_dependency_source_not_retained'] as const))
  const eliminatedBy = new Map<string, string>()
  const retainedContent = new Map<string, string>()
  for (const item of [...canonical].sort(compareCurrentFit)) {
    const key = contributionContentKey(item)
    if (retainedContent.has(key)) {
      discarded.set(item.contributionId, 'equivalent_content')
      eliminatedBy.set(item.contributionId, retainedContent.get(key)!)
    } else retainedContent.set(key, item.contributionId)
  }
  for (const item of canonical) {
    for (const conflictId of item.conflictsWith) {
      const target = byId.get(conflictId)
      if (target === undefined || target.contributionId === item.contributionId) continue
      const loser = compareCurrentFit(item, target) <= 0 ? target : item
      const winner = loser.contributionId === item.contributionId ? target : item
      discarded.set(loser.contributionId, 'experience_conflict')
      eliminatedBy.set(loser.contributionId, winner.contributionId)
    }
  }
  const live = canonical.filter(item => !discarded.has(item.contributionId))
  assertAcyclic(live)
  // OPT-C: an authorized history-ranking preference is consumed *within* the constrained topological
  // selection as a tie-break after mandatory priority — it can readjust the positions of equally
  // relevant, currently-ready (no remaining hard precedes edge), same-priority candidates, but never
  // reverses a required dependency edge nor crosses a contribution-type priority.
  const historyRank = options.historyRankOrder === undefined
    ? undefined
    : new Map(options.historyRankOrder.map((versionId, index) => [versionId, index]))
  let selected = topologicallyOrder(live, historyRank)
  let selectedIds = new Set(selected.map(item => item.contributionId))
  const finallyReachable = reachableRequiredContributions(
    selected.filter(item => !importedDependencyIds.has(item.contributionId))
      .map(item => item.contributionId),
    selectedIds,
    options.requiredDependencies ?? [],
  )
  for (const item of selected) {
    if (importedDependencyIds.has(item.contributionId) && !finallyReachable.has(item.contributionId)) {
      discarded.set(item.contributionId, 'required_dependency_source_not_retained')
    }
  }
  selected = selected.filter(item =>
    !importedDependencyIds.has(item.contributionId) || finallyReachable.has(item.contributionId))
  selectedIds = new Set(selected.map(item => item.contributionId))
  // OPT-B closure: a mandatory imported dependency must survive dedup/conflict. Replacing it
  // with unrelated equivalent-content content erases the source provenance that made it a
  // dependency, so unless a live survivor carries the same requires relation the closure is
  // broken and the whole Plan must block instead of silently proceeding without the dependency.
  const dependencyBlockers: string[] = []
  for (const edge of options.requiredDependencies ?? []) {
    const sourceRetained = edge.sourceContributionIds.some(id => selectedIds.has(id))
    if (!sourceRetained) continue
    if (edge.targetContributionIds.length === 0) {
      dependencyBlockers.push(edge.unsatisfiableBlocker ?? 'required_dependency_unusable')
      continue
    }
    for (const targetId of edge.targetContributionIds) {
      if (selectedIds.has(targetId)) continue
      const survivor = eliminatedBy.get(targetId)
      const survivorLive = survivor === undefined ? undefined : live.find(item => item.contributionId === survivor)
      const eliminated = byId.get(targetId)
      // A survivor is a safe substitute only when it is the SAME required dependency: it comes
      // from the same dependency version and shares a requires relation, i.e. it was a sibling
      // retained after content-equivalent dedup rather than an unrelated substitute from another
      // source. Replacing a required dependency with identical-content content from a different
      // source erases the dependency provenance that made it mandatory, so that plan must block.
      const sameDependency = survivorLive !== undefined && eliminated !== undefined
        && survivorLive.experienceVersionId === eliminated.experienceVersionId
        && survivorLive.relationIds.some(id => eliminated.relationIds.includes(id))
      if (!sameDependency) { dependencyBlockers.push('required_dependency_eliminated'); break }
    }
  }
  // H1: an explicit-optional component is only pruned when its anchor is finally retained.
  for (const prune of options.optionalPrunes ?? []) {
    if (!selectedIds.has(prune.anchorContributionId)) dependencyBlockers.push('explicit_optional_anchor_not_retained')
  }
  // Candidate-level rejection reasons (mode/scope/capability/symptom-code/version) are
  // explanations for the unusable neighbour, not whole-Plan blockers; excluding them keeps a
  // legal candidate approvable when an ineligible sibling is rejected. Safety blockers such as
  // required_observation_unknown are NOT rejection reasons and still surface even when the
  // version was rejected (e.g. a retained public/local independent-build component must still
  // satisfy the required environment check), so a must-be-blocked Plan never degrades to
  // read_only_only by dropping a rejected version's safety obligations.
  const blockers = unique([
    ...preflights.flatMap(item => item.blockers)
      .filter(reason => !REJECTION_BLOCKER_CODES.has(reason)),
    ...(options.additionalBlockers ?? []),
    ...dependencyBlockers,
  ])
  const discardedContributions = uniqueContributions([
    ...[...discarded].map(([contributionId, reasonCode]) => ({ contributionId, reasonCode })),
    ...(options.preDiscardedContributions ?? []),
  ])
  const steps = selected.filter(item => item.contributionType === 'step')
  const selectedVersionIds = new Set(selected.map(item => item.experienceVersionId))
  const dependencyPreflightIds = new Set(options.dependencyPreflightIds ?? [])
  const dependencyPreflightByVersion = new Map(preflights
    .filter(preflight => dependencyPreflightIds.has(preflight.preflightId))
    .map(preflight => [preflight.experienceVersionId, preflight.preflightId]))
  // A selected dependency uses its dependency-specific preflight. If its source disappears during
  // composition, preserve an ordinary MatchSet preflight when one existed and drop only the
  // dependency-only record so learning cannot attribute an unplanned imported version.
  const retainedPreflights = preflights.filter(preflight => {
    const dependencyPreflightId = dependencyPreflightByVersion.get(preflight.experienceVersionId)
    if (dependencyPreflightId === undefined) return true
    return selectedVersionIds.has(preflight.experienceVersionId)
      ? preflight.preflightId === dependencyPreflightId
      : preflight.preflightId !== dependencyPreflightId
  })
  const useMode = options.useMode ?? 'guided'
  const disposition: UsagePlanView['disposition'] = matchSet.noMatch
    ? 'no_match'
    : blockers.length > 0 ? 'blocked'
      : steps.length === 0 ? 'read_only_only'
        : useMode === 'suggest' ? 'suggested' : 'ready_for_approval'
  const planWithoutDigest = {
    usagePlanId: brandedId<'ExperienceUsagePlanId'>(randomUUID(), 'usagePlanId'),
    usageId: brandedId<'ExperienceUsageId'>(randomUUID(), 'usageId'),
    planRevision: 1,
    fingerprintId: fingerprint.fingerprintId,
    matchSetId: matchSet.matchSetId,
    preflightIds: retainedPreflights.map(item => item.preflightId).sort(),
    useMode,
    compositionPolicyVersion: 'typed-relations-v1' as const,
    selectedRelationIds: [...(options.selectedRelationIds ?? [])].sort(),
    overrideDecisionIds: [...(options.overrideDecisionIds ?? [])].sort(),
    preferenceEnforcements: (options.preferenceEnforcements ?? [])
      .filter(enforcement => selectedVersionIds.has(enforcement.experienceVersionId)),
    selectedContributions: selected,
    discardedContributions,
    orderedSteps: steps.map((item, index) => ({
      stepId: `step-${String(index + 1).padStart(2, '0')}`,
      content: item.content,
      componentRevisionId: String(item.componentRevisionId),
    })),
    constraints: contents(selected, 'constraint'),
    premises: contents(selected, 'premise'),
    hypotheses: contents(selected, 'hypothesis'),
    recovery: contents(selected, 'recovery'),
    verification: contents(selected, 'verification'),
    blockers,
    disposition,
    requiresApproval: disposition === 'ready_for_approval',
    createdAt: now,
  }
  return { ...planWithoutDigest, contentDigest: digest({
    schemaVersion: 'usage-plan-v1',
    taskInputDigest: fingerprint.taskInputDigest,
    selectedContributions: selected,
    useMode,
    compositionPolicyVersion: planWithoutDigest.compositionPolicyVersion,
    selectedRelationIds: planWithoutDigest.selectedRelationIds,
    overrideDecisionIds: planWithoutDigest.overrideDecisionIds,
    preferenceEnforcements: planWithoutDigest.preferenceEnforcements,
    discardedContributions: planWithoutDigest.discardedContributions,
    orderedSteps: planWithoutDigest.orderedSteps,
    constraints: planWithoutDigest.constraints,
    premises: planWithoutDigest.premises,
    hypotheses: planWithoutDigest.hypotheses,
    recovery: planWithoutDigest.recovery,
    verification: planWithoutDigest.verification,
    blockers,
    disposition,
    requiresApproval: planWithoutDigest.requiresApproval,
  }) }
}

/** Create a new immutable plan revision from explicit adaptation text. */
export function adaptUsagePlan(plan: UsagePlanView, reason: string, now: string): UsagePlanView {
  const constraints = unique([...plan.constraints, `User-requested adaptation: ${reason.trim()}`])
  const adapted = {
    ...plan,
    usagePlanId: brandedId<'ExperienceUsagePlanId'>(randomUUID(), 'usagePlanId'),
    planRevision: plan.planRevision + 1,
    constraints,
    createdAt: now,
  }
  return {
    ...adapted,
    contentDigest: digest({
      schemaVersion: 'usage-plan-v1',
      supersedesContentDigest: plan.contentDigest,
      selectedContributions: adapted.selectedContributions,
      useMode: adapted.useMode,
      compositionPolicyVersion: adapted.compositionPolicyVersion,
      selectedRelationIds: adapted.selectedRelationIds,
      overrideDecisionIds: adapted.overrideDecisionIds,
      preferenceEnforcements: adapted.preferenceEnforcements,
      discardedContributions: adapted.discardedContributions,
      orderedSteps: adapted.orderedSteps,
      constraints,
      premises: adapted.premises,
      hypotheses: adapted.hypotheses,
      recovery: adapted.recovery,
      verification: adapted.verification,
      blockers: adapted.blockers,
      disposition: adapted.disposition,
      requiresApproval: adapted.requiresApproval,
    }),
  }
}

/** Stable SHA-256 digest over canonical JSON keys. */
export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function matchVersion(
  fingerprint: TaskFingerprintView,
  taskTokens: ReadonlySet<string>,
  version: ExperienceMatchProjection,
  eligibility: MatchingEligibility,
): MatchCandidateView {
  const searchable = [version.title, version.intent, ...version.components.map(item => item.content)].join(' ')
  const versionTokens = new Set(tokenizeLanguage(searchable))
  const overlap = [...taskTokens].filter(token => versionTokens.has(token)).length
  const baseLexicalScore = taskTokens.size === 0 || overlap < MIN_LEXICAL_OVERLAP
    ? 0
    : overlap / taskTokens.size
  const structuralSignals = [
    fingerprint.capabilities.some(item => versionTokens.has(item.toLowerCase())),
    fingerprint.artifactKinds.some(item => versionTokens.has(item.toLowerCase())),
    versionTokens.has(fingerprint.taskFamily.toLowerCase()),
  ]
  const structuralScore = structuralSignals.filter(Boolean).length / structuralSignals.length
  // A2b explicit symptom codes: task side only from taskText, Experience side only from
  // role=symptom_signature. misleading_signal / falsifier / recovery / proposal never count.
  const taskCodes = new Set(registeredFailureSignatures(fingerprint.taskText))
  const versionCodes = new Set(version.components
    .filter(component => component.role === 'symptom_signature')
    .flatMap(component => registeredFailureSignatures(component.content)))
  const codeConflict = taskCodes.size > 0 && versionCodes.size > 0
    && ![...taskCodes].some(code => versionCodes.has(code))
  const codeMatch = [...taskCodes].some(code => versionCodes.has(code))
  // A2b alias_match is emitted only for a genuine cross-Chinese/English bridge: one side's
  // canonical token comes from the Han alias while the other side's token is the native
  // English term. Pure-Chinese same-word and pure-English same-word are NOT alias matches.
  const aliasHit = LEXICAL_ALIAS_GROUPS.some(group => {
    if (!taskTokens.has(group.canonical) || !versionTokens.has(group.canonical)) return false
    const taskHan = fingerprint.taskText.includes(group.han)
    const versionHan = searchable.includes(group.han)
    const taskEnglish = textHasToken(fingerprint.taskText, group.canonical)
    const versionEnglish = textHasToken(searchable, group.canonical)
    return (taskHan && versionEnglish) || (versionHan && taskEnglish)
  })
  // A2b rule 5: one shared explicit symptom code satisfies the lexical recall gate.
  const effectiveLexicalScore = codeMatch && overlap < MIN_LEXICAL_OVERLAP && taskTokens.size > 0
    ? 1 / taskTokens.size
    : baseLexicalScore
  const publicConflict = fingerprint.targetExposure === 'public'
    && Object.values(version.scope).some(value => /local|localhost|loopback|private/iu.test(value))
  const buildComponents = version.components.filter(component =>
    /build|artifact|asset|dist|bundle|package|compile|构建|产物/iu.test(component.content)
    && ['step', 'checkpoint', 'verifier', 'recovery_verifier', 'resolution_candidate', 'discriminator']
      .includes(component.role))
  const relevant = effectiveLexicalScore === 0 && structuralScore === 0 ? [] : version.components
  let selected = publicConflict ? buildComponents : relevant
  let rejected = publicConflict
  const reasonCodes: string[] = publicConflict
    ? selected.length === 0 ? ['hard_scope_conflict'] : ['local_procedure_rejected', 'independent_build_check_retained']
    : effectiveLexicalScore > 0 && structuralScore > 0 ? ['lexical_and_structural_match']
      : effectiveLexicalScore > 0 ? ['lexical_match_only']
        : structuralScore > 0 ? ['structural_match_only'] : []
  // A2b rule 4: an exact-signal conflict rejects the candidate entirely and also
  // overrides the public/local independent-build exception; no component is usable.
  if (codeConflict) {
    rejected = true
    selected = []
    if (!reasonCodes.includes('exact_signal_conflict')) reasonCodes.push('exact_signal_conflict')
  }
  // A3 hard eligibility: an unusable mode / explicitly-mismatched scope / zero
  // capability coverage never contributes, and must not occupy a top-N slot.
  if (!version.allowedUseModes.includes(eligibility.requestedUseMode)) {
    rejected = true
    selected = []
    if (!reasonCodes.includes('use_mode_not_allowed')) reasonCodes.push('use_mode_not_allowed')
  }
  if (scopeDeclaredMismatch(
    version.scope,
    fingerprint,
    eligibility,
    version.validity.source === 'completed_dsh_session_turn'
      && (version.kind === 'procedure' || version.kind === 'diagnostic'),
  )) {
    rejected = true
    selected = []
    if (!reasonCodes.includes('hard_scope_conflict')) reasonCodes.push('hard_scope_conflict')
  }
  if (explicitPreferenceSubjectConflict(fingerprint.taskText, version)) {
    rejected = true
    selected = []
    if (!reasonCodes.includes('preference_subject_conflict')) reasonCodes.push('preference_subject_conflict')
  }
  if (!automaticFocusMatches(fingerprint.taskText, taskTokens, version)) {
    rejected = true
    selected = []
    if (!reasonCodes.includes('automatic_focus_not_matched')) reasonCodes.push('automatic_focus_not_matched')
  }
  if (eligibility.requiredCapabilities.length > 0
    && !coversAnyCapability(eligibility.requiredCapabilities, versionTokens)) {
    rejected = true
    selected = []
    if (!reasonCodes.includes('capability_mismatch')) reasonCodes.push('capability_mismatch')
  }
  // A2b supplemental reasons surfaced for the Client: emit only on a real hit.
  if (codeMatch && !reasonCodes.includes('exact_signal_match')) reasonCodes.push('exact_signal_match')
  if (aliasHit && !reasonCodes.includes('alias_match')) reasonCodes.push('alias_match')
  return {
    experienceVersionId: version.experienceVersionId,
    experienceId: version.experienceId,
    title: version.title,
    componentRevisionIds: version.componentRevisionIds,
    selectedComponentRevisionIds: selected.map(item => item.componentRevisionId),
    structuralScore,
    lexicalScore: effectiveLexicalScore,
    rejected,
    reasonCodes,
  }
}

/** Reuse the existing hard-filter/exact-signal owner from alternate retrieval rankers. */
export function matchExperienceProjection(
  fingerprint: TaskFingerprintView,
  version: ExperienceMatchProjection,
  eligibility: MatchingEligibility,
): MatchCandidateView {
  return matchVersion(fingerprint, taskTokensFor(fingerprint), version, eligibility)
}

/** True when the Experience explicitly declares a scope workspace/taskFamily that contradicts the task. */
function scopeDeclaredMismatch(
  scope: Readonly<Record<string, string>>,
  fingerprint: TaskFingerprintView,
  eligibility: MatchingEligibility,
  inferredAutomaticTaskFamily = false,
): boolean {
  const workspaceDeclared = scope.workspaceRoot !== undefined
  const workspaceMismatch = workspaceDeclared && scope.workspaceRoot !== eligibility.workspaceRoot
  const taskFamilyDeclared = scope.taskFamily !== undefined
  // Direct Session Procedure/Diagnostic suggestions derive taskFamily from a
  // small deterministic language heuristic. It is useful ranking evidence, but
  // unlike workspace or exposure it is not an explicit authority boundary and
  // cannot safely veto a paraphrase. Other kinds encode stronger subject/policy
  // context in this field and remain hard until separately calibrated.
  const taskFamilyMismatch = !inferredAutomaticTaskFamily
    && taskFamilyDeclared && scope.taskFamily !== fingerprint.taskFamily
  const targetExposureMismatch = scope.targetExposure !== undefined
    && scope.targetExposure !== fingerprint.targetExposure
  return workspaceMismatch || taskFamilyMismatch || targetExposureMismatch
}

/** True when the Experience content covers at least one required capability (full-token/alias coverage). */
function coversAnyCapability(
  requiredCapabilities: readonly string[],
  versionTokens: ReadonlySet<string>,
): boolean {
  return requiredCapabilities.some(capability => {
    const capabilityTokens = new Set(tokenizeLanguage(capability))
    return [...capabilityTokens].some(token => versionTokens.has(token))
  })
}

/** Extract the registered exact failure signatures present whole in a text. */
export function registeredFailureSignatures(text: string): string[] {
  return unique([
    ...tokenizeLanguage(text).filter(token => EXPLICIT_SYMPTOM_CODES.has(token)),
    ...EXPLICIT_SYMPTOM_ALIASES.filter(alias => alias.pattern.test(text)).map(alias => alias.canonical),
  ])
}

/** True when a raw text contains the term as a whole normalized token (no alias expansion). */
function textHasToken(raw: string, term: string): boolean {
  return new Set(tokenize(raw)).has(term)
}

function contributionTypeFor(role: import('../types.js').ComponentRole): PlanContributionView['contributionType'] | null {
  switch (role) {
    case 'step':
    case 'branch':
    case 'resolution_candidate': return 'step'
    case 'candidate_option': return 'step'
    case 'entry_condition':
    case 'forbidden_condition':
    case 'parameter':
    case 'environment_adapter':
    case 'side_effect_policy':
    case 'misleading_signal':
    case 'discriminator':
    case 'falsifier':
    case 'hard_constraint':
    case 'stop_exploration_rule': return 'constraint'
    case 'directive':
    case 'modality':
    case 'subject_scope':
    case 'task_or_output_scope':
    case 'override_policy':
    case 'decision_criterion':
    case 'escalation_rule': return 'constraint'
    case 'observed_fact':
    case 'environment_scope':
    case 'symptom_signature': return 'premise'
    case 'subject':
    case 'predicate':
    case 'object_or_value':
    case 'qualifiers':
    case 'valid_from':
    case 'source_evidence':
    case 'contradiction_policy':
    case 'decision_point':
    case 'tradeoff':
    case 'cause_or_intervention':
    case 'effect_or_metric':
    case 'applicability_condition':
    case 'evidence_link':
    case 'causal_grade':
    case 'allowed_use': return 'premise'
    case 'hypothesis':
    case 'mechanism':
    case 'competing_explanation': return 'hypothesis'
    case 'failure_branch': return 'recovery'
    case 'checkpoint':
    case 'verifier':
    case 'recovery_verifier':
    case 'outcome_measure': return 'verification'
    default: return null
  }
}

function topologicallyOrder(
  input: readonly PlanContributionView[],
  versionRank?: ReadonlyMap<string, number>,
): PlanContributionView[] {
  const byId = new Map(input.map(item => [item.contributionId, item]))
  const indegree = new Map(input.map(item => [item.contributionId, 0]))
  const outgoing = new Map(input.map(item => [item.contributionId, [] as string[]]))
  for (const item of input) {
    for (const target of item.precedes) {
      if (!byId.has(target)) continue
      outgoing.get(item.contributionId)?.push(target)
      indegree.set(target, (indegree.get(target) ?? 0) + 1)
    }
  }
  // A history-ranking preference may only readjust candidate positions among the currently *ready*
  // (no remaining hard-dependency edge) and same-priority contributions: it is a tie-break after the
  // mandatory priority, and it never reorders across a required precedes edge (that edge keeps the
  // target blocked until its source is emitted) nor across contribution types.
  const compare = (left: PlanContributionView, right: PlanContributionView): number => {
    const priorityDiff = left.priority - right.priority
    if (priorityDiff !== 0) return priorityDiff
    if (versionRank !== undefined) {
      const leftRank = versionRank.get(String(left.experienceVersionId)) ?? Number.MAX_SAFE_INTEGER
      const rightRank = versionRank.get(String(right.experienceVersionId)) ?? Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank
    }
    return left.contributionId.localeCompare(right.contributionId)
  }
  const ready = input.filter(item => indegree.get(item.contributionId) === 0).sort(compare)
  const ordered: PlanContributionView[] = []
  while (ready.length > 0) {
    const item = ready.shift()!
    ordered.push(item)
    for (const targetId of outgoing.get(item.contributionId) ?? []) {
      const next = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, next)
      if (next === 0) {
        ready.push(byId.get(targetId)!)
        ready.sort(compare)
      }
    }
  }
  if (ordered.length !== input.length) throw new ExperienceError('composition_cycle', 'plan contribution dependencies must be acyclic')
  return ordered
}

function preferenceEnforcements(versions: readonly ExperienceVersionView[]): PreferenceEnforcementView[] {
  return versions.filter(version => version.kind === 'preference_policy').map(version => {
    const content = new Map(version.components.map(component => [component.role, component.content] as const))
    const modality = content.get('modality') as PreferenceEnforcementView['modality']
    const outputScoped = /output|response|answer|文案|输出|回答/iu.test(content.get('task_or_output_scope') ?? '')
    const classification: PreferenceEnforcementView['classification'] = modality === 'must' || modality === 'must_not'
      ? 'pre_execution_blocking' : outputScoped ? 'post_output_validation' : 'advisory'
    return {
      experienceVersionId: version.experienceVersionId,
      modality,
      classification,
      directive: content.get('directive') ?? '',
      authoritySource: content.get('authority_source') ?? '',
      positiveExample: content.get('positive_example') ?? null,
      negativeExample: content.get('negative_example') ?? null,
      exception: content.get('exception') ?? content.get('no_known_exception') ?? null,
      result: 'pending',
      reasonCode: `preference_${classification}`,
    }
  })
}

function overrideScopeMatches(override: OverrideDecisionView, task: PlanningTaskInput): boolean {
  const facts: Readonly<Record<string, string>> = {
    workspaceRoot: task.workspaceRoot ?? '',
    targetExposure: task.targetExposure,
    riskClass: task.riskClass,
    taskInputDigest: digest(task),
  }
  return Object.entries(override.exactScope).every(([key, value]) => facts[key] === value)
}

function priorityFor(type: PlanContributionView['contributionType'], index: number): number {
  const base = type === 'premise' ? 100 : type === 'constraint' ? 200 : type === 'hypothesis' ? 300
    : type === 'step' ? 400 : type === 'recovery' ? 500 : 600
  return base + index
}

function compareContribution(left: PlanContributionView, right: PlanContributionView): number {
  return left.priority - right.priority || left.contributionId.localeCompare(right.contributionId)
}

function preflightPriority(disposition: PreflightRecordView['disposition'] | undefined): number {
  switch (disposition) {
    case 'applicable': return 0
    case 'adaptable': return 1
    case 'stale': return 2
    case 'irrelevant': return 3
    case 'conflicting': return 4
    case 'blocked': return 5
    case undefined: return 6
  }
}

function contributionContentKey(contribution: PlanContributionView): string {
  return `${contribution.contributionType}\u0000${contribution.role}\u0000${contribution.content
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US')}`
}

function assertAcyclic(input: readonly PlanContributionView[]): void {
  const byId = new Map(input.map(item => [item.contributionId, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ExperienceError('composition_cycle', 'plan contribution dependencies must be acyclic')
    if (visited.has(id)) return
    visiting.add(id)
    for (const next of byId.get(id)?.precedes ?? []) if (byId.has(next)) visit(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of [...byId.keys()].sort()) visit(id)
}

function contents(input: readonly PlanContributionView[], type: PlanContributionView['contributionType']): string[] {
  return input.filter(item => item.contributionType === type).map(item => item.content)
}

function inferTaskFamily(words: readonly string[]): string {
  if (words.some(word => ['deploy', 'deployment', '发布', '部署'].includes(word))) return 'deployment'
  if (words.some(word => ['start', 'startup', '启动', '运行'].includes(word))) return 'application_startup'
  if (words.some(word => ['build', 'compile', '构建', '编译'].includes(word))) return 'build'
  if (words.some(word => ['fix', 'debug', 'diagnose', '修复', '诊断'].includes(word))) return 'diagnostic'
  return 'general'
}

/** Shared deterministic family used by automatic save and deterministic task fingerprints. */
export function canonicalTaskFamily(text: string): string {
  return inferTaskFamily(tokenize(text))
}

function inferCapabilities(words: readonly string[]): string[] {
  return unique(words.filter(word => ['build', 'web', 'cli', 'http', 'auth', '构建', '启动', '鉴权'].includes(word)))
}

function inferArtifacts(words: readonly string[]): string[] {
  return unique(words.filter(word => ['bundle', 'dist', 'artifact', 'assets', 'package', '产物'].includes(word)))
}

/**
 * Single reused Intl.Segmenter instance: constructing one per experience (or
 * per tokenize call) would reload the ICU dictionary each time. The matching
 * view is normalized once in tokenize; the original persisted taskText, title,
 * intent and component.content are never written back.
 */
const HAN_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })

/** Maximal runs of Han-script characters; these alone go through zh word segmentation. */
const HAN_RUN = /[\p{Script=Han}]+/gu

/** Non-Han letters, digits, underscores and hyphens, kept whole like the legacy matcher. */
const IDENTIFIER_TOKEN = /[\p{L}\p{N}_-]{2,}/gu

/** Append word-like Han tokens that are at least two Unicode code points, without n-grams. */
function appendHanTokens(tokens: string[], text: string): void {
  for (const segment of HAN_SEGMENTER.segment(text)) {
    if (!segment.isWordLike) continue
    const word = segment.segment
    if ([...word].length >= 2) tokens.push(word)
  }
}

/** Append non-Han identifiers whole so an adjacent error code is never split by the segmenter. */
function appendIdentifierTokens(tokens: string[], text: string): void {
  for (const match of text.matchAll(IDENTIFIER_TOKEN)) tokens.push(match[0].trim())
}

function tokenize(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase()
  const tokens: string[] = []
  let cursor = 0
  for (const match of normalized.matchAll(HAN_RUN)) {
    const index = match.index ?? 0
    if (index > cursor) appendIdentifierTokens(tokens, normalized.slice(cursor, index))
    appendHanTokens(tokens, match[0])
    cursor = index + match[0].length
  }
  if (cursor < normalized.length) appendIdentifierTokens(tokens, normalized.slice(cursor))
  return unique(tokens)
}

/**
 * A2b lexical tokenization: NFKC/lowercase first, then recognize the three
 * finite Chinese alias terms and place their canonical English token on each
 * side of a space, then run the A2a tokenizer and de-duplicate. No recursion:
 * a canonical token is never re-flagged as a Chinese term again. Each alias
 * group is exactly one lexical signal (a de-duplicated token).
 */
function tokenizeLanguage(value: string): string[] {
  let expanded = value.normalize('NFKC').toLowerCase()
  for (const group of LEXICAL_ALIAS_GROUPS) {
    expanded = expanded.split(group.han).join(` ${group.canonical} `)
  }
  return tokenize(expanded)
}

/** Stable tokenizer shared by the production MiniSearch projection and the frozen B0 matcher. */
export function tokenizeRetrievalText(value: string): string[] {
  return tokenizeLanguage(value)
}

function bounded(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed.slice(0, 240)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function uniqueContributions(
  values: readonly { readonly contributionId: string; readonly reasonCode: string }[],
): { readonly contributionId: string; readonly reasonCode: string }[] {
  const byId = new Map<string, string>()
  for (const value of values) if (!byId.has(value.contributionId)) byId.set(value.contributionId, value.reasonCode)
  return [...byId.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([contributionId, reasonCode]) => ({ contributionId, reasonCode }))
}

/** Compute the dependency-only contribution ids reachable from exact base/source contributions. */
function reachableRequiredContributions(
  rootIds: readonly string[],
  availableIds: ReadonlySet<string>,
  edges: readonly RequiredDependencyEdge[],
): Set<string> {
  const reachable = new Set(rootIds.filter(id => availableIds.has(id)))
  let changed = true
  while (changed) {
    changed = false
    for (const edge of edges) {
      if (!edge.sourceContributionIds.some(id => reachable.has(id))) continue
      for (const targetId of edge.targetContributionIds) {
        if (!availableIds.has(targetId) || reachable.has(targetId)) continue
        reachable.add(targetId)
        changed = true
      }
    }
  }
  return reachable
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]))
}
