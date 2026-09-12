import { createHash, randomUUID } from 'node:crypto'
import { ExperienceError } from '../src/errors.js'
import { brandedId } from '../src/ids.js'
import type {
  ActorView,
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
  OverrideDecisionView,
  PreferenceEnforcementView,
} from '../src/types.js'

const MIN_LEXICAL_OVERLAP = 2

/** M3 planning bounds controlled by validated deployment configuration. */
export interface PlanningPolicy {
  readonly retrievalCandidateLimit: number
  readonly observationFreshnessMs: number
  readonly planApprovalTtlMs: number
  readonly maxPlanningTaskBytes: number
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

/** Retrieve accepted versions with bounded structural and lexical ranking. */
export function matchExperiences(
  fingerprint: TaskFingerprintView,
  versions: readonly ExperienceVersionView[],
  candidateLimit: number,
  now: string,
): MatchSetView {
  const taskTokens = new Set(tokenize([
    fingerprint.taskText,
    fingerprint.intent,
    fingerprint.taskFamily,
    ...fingerprint.capabilities,
    ...fingerprint.artifactKinds,
  ].join(' ')))
  const candidates = versions.map(version => matchVersion(fingerprint, taskTokens, version))
    .filter(candidate => candidate.lexicalScore > 0 || candidate.structuralScore > 0)
    .sort((left, right) => Number(left.rejected) - Number(right.rejected)
      || right.structuralScore - left.structuralScore
      || right.lexicalScore - left.lexicalScore
      || String(left.experienceVersionId).localeCompare(String(right.experienceVersionId)))
    .slice(0, candidateLimit)
  return {
    matchSetId: brandedId<'ExperienceMatchSetId'>(randomUUID(), 'matchSetId'),
    fingerprintId: fingerprint.fingerprintId,
    retrievalVersion: 'bounded-structural-lexical-v1',
    candidateLimit,
    candidates,
    noMatch: candidates.every(candidate => candidate.selectedComponentRevisionIds.length === 0),
    createdAt: now,
  }
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
  const webContract = observations.find(item => item.kind === 'web_contract')
  const invalidAnonymousVerifier = relevantComponents.some(component =>
    /anonymous|unauthenticated|without auth|200\b/iu.test(component.content))
    && webContract?.status === 'observed'
    && webContract.values.authRequired === true
  if (invalidAnonymousVerifier) reasons.push('condition_invalidated_by_current_auth_contract')
  const requiredUnknown = observations.some(item => item.status === 'unknown'
    && (item.kind === 'repository_state' || item.kind === 'build_artifact' || item.kind === 'web_contract'))
  if (candidate.rejected && candidate.selectedComponentRevisionIds.length === 0) blockers.push('hard_scope_conflict')
  if (requiredUnknown && fingerprint.riskClass !== 'standard') blockers.push('required_observation_unknown')
  const disposition: PreflightRecordView['disposition'] = blockers.length > 0
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
  } = {},
): UsagePlanView {
  const canonical = [...contributions].sort((left, right) => left.priority - right.priority
    || left.contributionId.localeCompare(right.contributionId))
  const byId = new Map(canonical.map(item => [item.contributionId, item]))
  if (byId.size !== canonical.length) throw new ExperienceError('invalid_command', 'plan contribution ids must be unique')
  const dispositionByVersion = new Map(preflights.map(item => [item.experienceVersionId, item.disposition]))
  const matchRankByVersion = new Map(matchSet.candidates.map((item, index) => [item.experienceVersionId, index]))
  const compareCurrentFit = (left: PlanContributionView, right: PlanContributionView): number =>
    preflightPriority(dispositionByVersion.get(left.experienceVersionId))
      - preflightPriority(dispositionByVersion.get(right.experienceVersionId))
    || (matchRankByVersion.get(left.experienceVersionId) ?? Number.MAX_SAFE_INTEGER)
      - (matchRankByVersion.get(right.experienceVersionId) ?? Number.MAX_SAFE_INTEGER)
    || compareContribution(left, right)
  const discarded = new Map<string, string>()
  const retainedContent = new Map<string, string>()
  for (const item of [...canonical].sort(compareCurrentFit)) {
    const key = contributionContentKey(item)
    if (retainedContent.has(key)) discarded.set(item.contributionId, 'equivalent_content')
    else retainedContent.set(key, item.contributionId)
  }
  for (const item of canonical) {
    for (const conflictId of item.conflictsWith) {
      const target = byId.get(conflictId)
      if (target === undefined || target.contributionId === item.contributionId) continue
      const loser = compareCurrentFit(item, target) <= 0 ? target : item
      discarded.set(loser.contributionId, 'experience_conflict')
    }
  }
  const live = canonical.filter(item => !discarded.has(item.contributionId))
  assertAcyclic(live)
  const blockers = unique(preflights.flatMap(item => item.blockers))
  const selected = topologicallyOrder(live)
  const steps = selected.filter(item => item.contributionType === 'step')
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
    preflightIds: preflights.map(item => item.preflightId).sort(),
    useMode,
    compositionPolicyVersion: 'typed-relations-v1' as const,
    selectedRelationIds: [...(options.selectedRelationIds ?? [])].sort(),
    overrideDecisionIds: [...(options.overrideDecisionIds ?? [])].sort(),
    preferenceEnforcements: options.preferenceEnforcements ?? [],
    selectedContributions: selected,
    discardedContributions: [...discarded].sort(([left], [right]) => left.localeCompare(right))
      .map(([contributionId, reasonCode]) => ({ contributionId, reasonCode })),
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
  version: ExperienceVersionView,
): MatchCandidateView {
  const searchable = [version.title, version.intent, ...version.components.map(item => item.content)].join(' ')
  const versionTokens = new Set(tokenize(searchable))
  const overlap = [...taskTokens].filter(token => versionTokens.has(token)).length
  const lexicalScore = taskTokens.size === 0 || overlap < MIN_LEXICAL_OVERLAP
    ? 0
    : overlap / taskTokens.size
  const structuralSignals = [
    fingerprint.capabilities.some(item => versionTokens.has(item.toLowerCase())),
    fingerprint.artifactKinds.some(item => versionTokens.has(item.toLowerCase())),
    versionTokens.has(fingerprint.taskFamily.toLowerCase()),
  ]
  const structuralScore = structuralSignals.filter(Boolean).length / structuralSignals.length
  const publicConflict = fingerprint.targetExposure === 'public'
    && Object.values(version.scope).some(value => /local|localhost|loopback|private/iu.test(value))
  const buildComponents = version.components.filter(component =>
    /build|artifact|asset|dist|bundle|package|compile|构建|产物/iu.test(component.content)
    && ['step', 'checkpoint', 'verifier', 'recovery_verifier', 'resolution_candidate', 'discriminator']
      .includes(component.role))
  const relevant = lexicalScore === 0 && structuralScore === 0 ? [] : version.components
  const selected = publicConflict ? buildComponents : relevant
  return {
    experienceVersionId: version.experienceVersionId,
    experienceId: version.experienceId,
    title: version.title,
    componentRevisionIds: version.componentRevisionIds,
    selectedComponentRevisionIds: selected.map(item => item.componentRevisionId),
    structuralScore,
    lexicalScore,
    rejected: publicConflict,
    reasonCodes: publicConflict
      ? selected.length === 0 ? ['hard_scope_conflict'] : ['local_procedure_rejected', 'independent_build_check_retained']
      : lexicalScore > 0 && structuralScore > 0 ? ['lexical_and_structural_match']
        : lexicalScore > 0 ? ['lexical_match_only'] : ['structural_match_only'],
  }
}

function contributionTypeFor(role: import('../src/types.js').ComponentRole): PlanContributionView['contributionType'] | null {
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

function topologicallyOrder(input: readonly PlanContributionView[]): PlanContributionView[] {
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
  const ready = input.filter(item => indegree.get(item.contributionId) === 0).sort(compareContribution)
  const ordered: PlanContributionView[] = []
  while (ready.length > 0) {
    const item = ready.shift()!
    ordered.push(item)
    for (const targetId of outgoing.get(item.contributionId) ?? []) {
      const next = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, next)
      if (next === 0) {
        ready.push(byId.get(targetId)!)
        ready.sort(compareContribution)
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

function inferCapabilities(words: readonly string[]): string[] {
  return unique(words.filter(word => ['build', 'web', 'cli', 'http', 'auth', '构建', '启动', '鉴权'].includes(word)))
}

function inferArtifacts(words: readonly string[]): string[] {
  return unique(words.filter(word => ['bundle', 'dist', 'artifact', 'assets', 'package', '产物'].includes(word)))
}

function tokenize(value: string): string[] {
  return unique((value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).map(item => item.trim()))
}

function bounded(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed.slice(0, 240)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
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
