import { TYPE_BEHAVIORS } from './behavior.js'
import { canonicalTaskFamily } from './planning.js'
import { validateWorkflowDraft } from './candidate-workflow.js'
import { ExperienceError } from '../errors.js'
import type {
  ComponentRole,
  ExperienceCandidateDraft,
  ExperienceSuggestionGroupView,
  ExperienceSuggestionOccurrenceView,
  ExperienceSuggestionSeedView,
  SaveExperienceSuggestionInput,
  SourceRefView,
} from '../types.js'
import { suggestionDigest } from './automatic-suggestion.js'
import {
  experienceComponentIdentityClass,
  experienceKernelIdentity,
  normalizeKernelText,
  projectExperienceKernel,
} from './experience-kernel.js'
import {
  parseAuthoritativeFact,
  parseCausalSignal,
  parseExplicitPreference,
  parseStrategySignal,
} from './suggestion-semantic-signals.js'

/** Version of the deterministic seed-to-publication-draft projection. */
export const SUGGESTION_MATERIALIZER_VERSION = 'six-kind-materializer-v3'
interface MaterializedSeed {
  readonly group: ExperienceSuggestionGroupView
  readonly taskFamilyKey: string
  readonly scopeKey: string
  readonly relationKey: string
}

interface StableActionProjection {
  readonly summaries: readonly string[]
  readonly sourceRefs: readonly string[]
  readonly complete: boolean
  readonly reason: 'stable_action_details_missing' | 'transient_action_parameter' | null
}

type GroundingChannel =
  | 'goal' | 'action' | 'action_first' | 'action_last' | 'verifier' | 'failure' | 'failure_and_verifier'
  | 'preference' | 'fact' | 'strategy' | 'causal_claim' | 'causal_effect' | 'causal_evidence'

/** Exhaustive component-to-Session grounding policy; identity lives in the shared Kernel owner. */
const COMPONENT_ROLE_GROUNDING = {
  goal_signature: 'goal', entry_condition: 'goal', forbidden_condition: 'goal', parameter: 'goal',
  environment_adapter: 'goal', step: 'action', checkpoint: 'verifier', side_effect_policy: 'goal',
  failure_branch: 'failure', verifier: 'verifier', symptom_signature: 'failure', environment_scope: 'goal',
  observed_fact: 'action', hypothesis: 'failure', discriminator: 'action_first',
  misleading_signal: 'goal', branch: 'action', resolution_candidate: 'action_last',
  falsifier: 'failure_and_verifier', recovery_verifier: 'verifier', directive: 'preference',
  modality: 'preference', subject_scope: 'preference', task_or_output_scope: 'preference',
  authority_source: 'preference', override_policy: 'preference', positive_example: 'preference',
  negative_example: 'preference', exception: 'preference', no_known_exception: 'preference',
  valid_from: 'fact', subject: 'fact', predicate: 'fact', object_or_value: 'fact', qualifiers: 'fact',
  source_evidence: 'fact', contradiction_policy: 'fact', decision_point: 'strategy',
  candidate_option: 'strategy', hard_constraint: 'strategy', decision_criterion: 'strategy',
  tradeoff: 'strategy', stop_exploration_rule: 'strategy', escalation_rule: 'strategy',
  outcome_measure: 'strategy', cause_or_intervention: 'causal_claim', effect_or_metric: 'causal_effect',
  applicability_condition: 'causal_claim', mechanism: 'causal_claim', competing_explanation: 'causal_claim',
  evidence_link: 'causal_evidence', causal_grade: 'causal_evidence', allowed_use: 'causal_claim',
} as const satisfies Readonly<Record<ComponentRole, GroundingChannel>>

/**
 * Components whose text is created by the deterministic materializer policy rather
 * than asserted by an occurrence. Their source refs retain auditable derivation,
 * but replaying another occurrence must not create empirical Evidence for them.
 */
const POLICY_DERIVED_COMPONENT_ROLES = new Set<ComponentRole>([
  'entry_condition', 'forbidden_condition', 'parameter', 'environment_adapter', 'side_effect_policy',
  'environment_scope', 'hypothesis', 'misleading_signal', 'falsifier', 'subject_scope',
  'contradiction_policy', 'causal_grade', 'allowed_use',
])

/** Policy boilerplate may change language without becoming empirical evidence or a distinct Experience. */
export function isPolicyDerivedSuggestionComponentRole(role: ComponentRole): boolean {
  return POLICY_DERIVED_COMPONENT_ROLES.has(role)
}

/** Return only occurrence refs that may become canonical component Evidence. */
export function suggestionEvidenceSourceRefsForComponent(
  component: Pick<ExperienceCandidateDraft['components'][number], 'role' | 'sourceRefs'>,
): readonly string[] {
  return isPolicyDerivedSuggestionComponentRole(component.role) ? [] : sortedUnique(component.sourceRefs)
}

/**
 * Materialize and consolidate all E1 seeds without invoking a model. Exact groups
 * share one save surface; structurally related but non-identical groups are only
 * marked for review and are never merged.
 */
export function materializeSuggestionGroups(
  seeds: readonly ExperienceSuggestionSeedView[],
  maxInlineFieldBytes: number,
  suppressedGroupIds: ReadonlySet<string> = new Set(),
): ExperienceSuggestionGroupView[] {
  const materialized = seeds.flatMap(seed => seed.suggestedKinds.map(kind =>
    materializeSeed(seed, kind, maxInlineFieldBytes)))
    .filter(item => !suppressedGroupIds.has(item.group.suggestionGroupId))
  const exact = new Map<string, MaterializedSeed[]>()
  for (const item of materialized) {
    const values = exact.get(item.group.suggestionGroupId) ?? []
    values.push(item)
    exact.set(item.group.suggestionGroupId, values)
  }
  const consolidated = [...exact.values()].map(items => consolidateExact(items))
  return consolidated.map(item => {
    const related = consolidated.filter(other => other.group.suggestionGroupId !== item.group.suggestionGroupId
      && other.group.kind === item.group.kind
      && other.taskFamilyKey === item.taskFamilyKey
      && other.relationKey === item.relationKey)
    const sameScope = related.filter(other => other.scopeKey === item.scopeKey)
    const specialization = related.filter(other => other.scopeKey !== item.scopeKey)
    const consolidation = sameScope.length > 0
      ? 'possible_duplicate'
      : specialization.length > 0 ? 'specialization' : item.group.consolidation
    const relatedGroupIds = [...related.map(other => other.group.suggestionGroupId)].sort()
    const needsReview = consolidation === 'possible_duplicate' || consolidation === 'specialization'
    const base = {
      ...item.group,
      consolidation,
      relatedGroupIds,
      saveReadiness: needsReview && item.group.saveReadiness === 'ready'
        ? 'needs_review' as const : item.group.saveReadiness,
      readinessReasons: needsReview && item.group.saveReadiness === 'ready'
        ? unique([...item.group.readinessReasons, consolidation]) : item.group.readinessReasons,
      reviewDigest: null,
    }
    return finalizeGroup(base)
  }).sort((left, right) => right.occurrences[0]!.detectedAt.localeCompare(left.occurrences[0]!.detectedAt)
    || left.suggestionGroupId.localeCompare(right.suggestionGroupId))
}

/** Compute the exact E2/E3 identity from one kind-specific stable kernel. */
export function suggestionKernelIdentity(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
): string {
  const sourceRefs = sourceRefsForKind(seed, kind)
  const actions = stableActionProjection(seed, kind)
  const draft = draftFor(seed, kind, sourceRefs, actions)
  return experienceKernelIdentity({ kind, scope: draft.scope, components: draft.components })
}

function materializeSeed(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
  maxInlineFieldBytes: number,
): MaterializedSeed {
  const sourceRefs = sourceRefsForKind(seed, kind)
  const actions = stableActionProjection(seed, kind)
  const draft = draftFor(seed, kind, sourceRefs, actions)
  const missingFields: string[] = [
    ...TYPE_BEHAVIORS[kind].validate(new Set(draft.components.map(component => component.role))),
  ]
  const readinessReasons: string[] = []
  let saveReadiness: ExperienceSuggestionGroupView['saveReadiness'] = 'ready'
  const goalEvidence = seed.evidenceSignals.some(signal =>
    signal.role === 'user_goal' && signal.evidenceClass === 'user_instruction')
  const verifierEvidence = seed.stableKernel.verifierTools.length > 0
    && seed.evidenceSignals.some(signal =>
      signal.role === 'terminal_readback' && signal.evidenceClass === 'observed_fact')
  const diagnosticEvidence = kind !== 'diagnostic' || (seed.stableKernel.failureCodes.some(code => code !== 'tool_error')
    && seed.evidenceSignals.some(signal => signal.role === 'symptom' && signal.evidenceClass === 'observed_fact'))
  if (kind === 'procedure' || kind === 'diagnostic') {
    if (!goalEvidence) missingFields.push('user_goal')
    if (!verifierEvidence) missingFields.push(kind === 'procedure' ? 'verifier' : 'recovery_verifier')
    if (!diagnosticEvidence) missingFields.push('symptom_signature')
    if (!actions.complete) missingFields.push(actions.reason ?? 'stable_action_details')
  } else {
    missingFields.push(...semanticMissingFields(seed, kind))
  }
  if (sourceRefs.length === 0) {
    saveReadiness = 'blocked'
    readinessReasons.push('source_evidence_missing')
  } else if (kind === 'strategy') {
    saveReadiness = missingFields.length === 0 ? 'needs_review' : 'needs_enrichment'
    readinessReasons.push(missingFields.length === 0
      ? 'strategy_requires_human_review' : 'strategy_fields_missing')
  } else if (kind === 'causal') {
    saveReadiness = missingFields.length === 0 ? 'needs_review' : 'needs_enrichment'
    readinessReasons.push(missingFields.length === 0
      ? 'causal_candidate_requires_promotion' : 'causal_evidence_incomplete')
  } else if ((kind === 'preference_policy' || kind === 'fact') && missingFields.length > 0) {
    saveReadiness = 'needs_enrichment'
    readinessReasons.push(kind === 'preference_policy'
      ? 'explicit_preference_incomplete' : 'authoritative_fact_incomplete')
  } else if ((kind === 'procedure' || kind === 'diagnostic') && !goalEvidence) {
    saveReadiness = 'needs_enrichment'
    readinessReasons.push('user_goal_evidence_missing')
  } else if ((kind === 'procedure' || kind === 'diagnostic') && !verifierEvidence) {
    saveReadiness = 'needs_enrichment'
    readinessReasons.push('verifier_evidence_missing')
  } else if (kind === 'diagnostic' && !diagnosticEvidence) {
    saveReadiness = 'needs_enrichment'
    readinessReasons.push('diagnostic_signature_missing')
  } else if ((kind === 'procedure' || kind === 'diagnostic') && !actions.complete) {
    saveReadiness = actions.reason === 'transient_action_parameter' ? 'needs_review' : 'needs_enrichment'
    readinessReasons.push(actions.reason ?? 'stable_action_details_missing')
  } else if (missingFields.length > 0) {
    saveReadiness = 'needs_enrichment'
    readinessReasons.push('mandatory_fields_missing')
  } else {
    try {
      validateWorkflowDraft(draft, [seed.episodeRef], sourceRefs, maxInlineFieldBytes)
    } catch (error) {
      saveReadiness = error instanceof ExperienceError && error.code === 'sensitive_content_unauthorized'
        ? 'blocked' : 'needs_enrichment'
      readinessReasons.push(error instanceof ExperienceError
        ? `publication_validation_failed:${error.code}` : 'publication_validation_failed:internal')
    }
  }
  const kernelIdentity = suggestionKernelIdentity(seed, kind)
  const kernel = projectExperienceKernel({ kind, scope: draft.scope, components: draft.components })
  const occurrence = occurrenceFor(seed, kind, sourceRefs)
  const base: ExperienceSuggestionGroupView = {
    suggestionGroupId: `suggestion-group:${kernelIdentity.slice('sha256:'.length)}`,
    kernelIdentity,
    revisionDigest: '',
    sourceDigest: suggestionDigest([seed.episodeRef.contentDigest, ...sourceRefs.map(ref => ref.contentDigest).sort()]),
    kind,
    title: draft.title,
    draft,
    saveReadiness,
    readinessReasons,
    missingFields: unique(missingFields),
    riskFlags: riskFlagsForKind(kind),
    reviewDigest: null,
    consolidation: 'distinct',
    relatedGroupIds: [],
    occurrences: [occurrence],
    occurrenceCount: 1,
    sessionIds: [seed.sessionId],
    crossSession: false,
    detectorVersions: [seed.detectorVersion],
    segmenterVersions: [seed.segmenterVersion],
    materializerVersion: SUGGESTION_MATERIALIZER_VERSION,
    expiresAt: seed.expiresAt,
  }
  return {
    group: finalizeGroup(base),
    taskFamilyKey: kernel.taskFamilyKey,
    scopeKey: kernel.scopeKey,
    relationKey: relationKeyFor(kind, kernel),
  }
}

function consolidateExact(items: readonly MaterializedSeed[]): MaterializedSeed {
  const sorted = [...items].sort((left, right) =>
    left.group.occurrences[0]!.occurrenceId.localeCompare(right.group.occurrences[0]!.occurrenceId))
  const first = sorted[0]!
  const occurrences = sorted.flatMap(item => item.group.occurrences)
  const componentConflict = sorted.some(item => !sameComponentContents(first.group.draft, item.group.draft))
  const draft = componentConflict
    ? first.group.draft
    : withConsolidatedDraftSources(first.group.draft, sorted.map(item => item.group.draft))
  const sessionIds = unique(occurrences.map(occurrence => occurrence.sessionId)).sort()
  const group = finalizeGroup({
    ...first.group,
    draft,
    sourceDigest: suggestionDigest(occurrences.map(occurrence => ({
      occurrenceId: occurrence.occurrenceId,
      episodeDigest: occurrence.episodeRef.contentDigest,
      sourceDigests: occurrence.sourceRefs.map(ref => ref.contentDigest).sort(),
    }))),
    consolidation: componentConflict ? 'possible_duplicate' : occurrences.length > 1 ? 'exact' : 'distinct',
    saveReadiness: componentConflict && first.group.saveReadiness === 'ready'
      ? 'needs_review' : first.group.saveReadiness,
    readinessReasons: componentConflict
      ? unique([...first.group.readinessReasons, 'exact_identity_component_conflict'])
      : first.group.readinessReasons,
    reviewDigest: componentConflict ? null : first.group.reviewDigest,
    occurrences,
    occurrenceCount: occurrences.length,
    sessionIds,
    crossSession: sessionIds.length > 1,
    detectorVersions: unique(sorted.flatMap(item => item.group.detectorVersions)).sort(),
    segmenterVersions: unique(sorted.flatMap(item => item.group.segmenterVersions)).sort(),
    expiresAt: sorted.map(item => item.group.expiresAt).sort().at(-1)!,
  })
  return {
    group,
    taskFamilyKey: first.taskFamilyKey,
    scopeKey: first.scopeKey,
    relationKey: first.relationKey,
  }
}

function relationKeyFor(
  kind: ExperienceSuggestionGroupView['kind'],
  kernel: ReturnType<typeof projectExperienceKernel>,
): string {
  if (kind === 'procedure' || kind === 'diagnostic') return kernel.taskFamilyKey
  const keys = kind === 'preference_policy' ? ['subject', 'taskOrOutput']
    : kind === 'fact' ? ['subjectPredicate']
      : kind === 'strategy' ? ['decisionPoint'] : ['intervention', 'effect']
  return suggestionDigest(keys.map(key => kernel.typeSpecific[key] ?? []))
}

function finalizeGroup(group: ExperienceSuggestionGroupView): ExperienceSuggestionGroupView {
  const digests = suggestionDecisionDigests(group)
  return { ...group, ...digests }
}

/** Recompute the immutable decision identity used by Sidecar and canonical save guards. */
export function suggestionDecisionDigests(group: ExperienceSuggestionGroupView): {
  readonly revisionDigest: string
  readonly reviewDigest: string | null
} {
  const decisionOccurrences = group.occurrences.map(occurrence => ({
    ...occurrence,
    sourceRefs: occurrence.sourceRefs.map(({ observedAt: _observedAt, ...sourceRef }) => sourceRef),
  }))
  const surface = {
    suggestionGroupId: group.suggestionGroupId,
    kernelIdentity: group.kernelIdentity,
    sourceDigest: group.sourceDigest,
    kind: group.kind,
    title: group.title,
    draft: group.draft,
    saveReadiness: group.saveReadiness,
    readinessReasons: group.readinessReasons,
    missingFields: group.missingFields,
    riskFlags: group.riskFlags,
    consolidation: group.consolidation,
    canonicalMatch: group.canonicalMatch ?? null,
    consolidationDetail: group.consolidationDetail ?? null,
    relatedGroupIds: group.relatedGroupIds,
    relatedExperienceVersionIds: group.relatedExperienceVersionIds ?? [],
    occurrences: decisionOccurrences,
    materializerVersion: group.materializerVersion,
    expiresAt: group.expiresAt,
  }
  const revisionDigest = suggestionDigest(surface)
  const reviewDigest = group.saveReadiness === 'ready' || duplicateOwnershipReviewEligible(group)
    ? suggestionDigest({ ...surface, revisionDigest, decision: 'save_experience_suggestion' })
    : null
  return { revisionDigest, reviewDigest }
}

/** One shared pure gate used before both sidecar and canonical save validation. */
export function suggestionSaveEligibility(
  group: ExperienceSuggestionGroupView,
  ownerChoice: SaveExperienceSuggestionInput['ownerChoice'],
): { readonly allowed: boolean; readonly reason: string } {
  if (group.reviewDigest === null) return { allowed: false, reason: 'review_digest_missing' }
  if (group.saveReadiness === 'ready') {
    const direct = group.consolidation === 'exact' || group.consolidation === 'distinct'
      || group.consolidation === 'semantic_consolidated'
      || (group.consolidation === 'semantic_duplicate' && publishedCorrespondenceComplete(group))
    if (!direct) return { allowed: false, reason: 'consolidation_not_saveable' }
    return ownerChoice === undefined
      ? { allowed: true, reason: 'direct_reviewed_save' }
      : { allowed: false, reason: 'owner_choice_not_expected' }
  }
  if (!duplicateOwnershipReviewEligible(group) || ownerChoice === undefined) {
    return { allowed: false, reason: 'duplicate_ownership_review_required' }
  }
  const detail = group.consolidationDetail!
  if (!detail.allowedOwnerChoices.includes(ownerChoice.choice)
    || detail.targetExperienceVersionId !== ownerChoice.targetExperienceVersionId) {
    return { allowed: false, reason: 'owner_choice_not_allowed' }
  }
  if (ownerChoice.choice === 'attach_existing') {
    return publishedCorrespondenceComplete(group) && ownerChoice.materialDifferences.length === 0
      ? { allowed: true, reason: 'reviewed_attach_existing' }
      : { allowed: false, reason: 'attach_correspondence_incomplete' }
  }
  const expected = [...detail.materialDifferences].sort(materialDifferenceOrder)
  const actual = [...ownerChoice.materialDifferences].sort(materialDifferenceOrder)
  return expected.length > 0 && suggestionDigest(actual) === suggestionDigest(expected)
    ? { allowed: true, reason: 'reviewed_keep_distinct' }
    : { allowed: false, reason: 'material_difference_mismatch' }
}

/** Stable source-group identities covered by one visible suggestion decision. */
export function suggestionSourceGroupIds(group: ExperienceSuggestionGroupView): readonly string[] {
  const values = group.consolidationDetail?.sourceSuggestionGroupIds ?? [group.suggestionGroupId]
  return [...new Set(values)].sort()
}

function publishedCorrespondenceComplete(group: ExperienceSuggestionGroupView): boolean {
  const detail = group.consolidationDetail
  if (group.canonicalMatch === undefined || detail === undefined || detail.targetExperienceVersionId === null
    || detail.targetExperienceVersionId !== group.canonicalMatch.experienceVersionId
    || detail.decision === 'different' || detail.decision === 'specialization') return false
  const sourceGroupCount = Math.max(1, detail.sourceGroups.length)
  const expectedMappings = group.draft.components.length * sourceGroupCount
  const keys = new Set(detail.componentCorrespondence.map(item =>
    `${item.incomingSuggestionGroupId}\u0000${item.incomingComponentKey}`))
  return detail.componentCorrespondence.length === expectedMappings && keys.size === expectedMappings
    && detail.componentCorrespondence.every(item => item.targetComponentRevisionId !== null)
}

function duplicateOwnershipReviewEligible(group: ExperienceSuggestionGroupView): boolean {
  const detail = group.consolidationDetail
  if (group.saveReadiness !== 'needs_review' || detail === undefined
    || detail.allowedOwnerChoices.length === 0 || group.missingFields.length > 0
    || group.draft.unresolvedFields.length > 0 || group.kind === 'strategy' || group.kind === 'causal') return false
  const allowedReasons = new Set([
    'current_permission_required',
    'semantic_duplicate_ambiguous',
    'semantic_specialization_review',
  ])
  return group.readinessReasons.every(reason => allowedReasons.has(reason))
}

function materialDifferenceOrder(
  left: NonNullable<SaveExperienceSuggestionInput['ownerChoice']>['materialDifferences'][number],
  right: NonNullable<SaveExperienceSuggestionInput['ownerChoice']>['materialDifferences'][number],
): number {
  return left.facet.localeCompare(right.facet)
    || left.incomingComponentKey.localeCompare(right.incomingComponentKey)
    || left.targetComponentRevisionId.localeCompare(right.targetComponentRevisionId)
    || left.reasonCode.localeCompare(right.reasonCode)
}

function draftFor(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
  sourceRefs: readonly SourceRefView[],
  actions: StableActionProjection,
): ExperienceCandidateDraft {
  const zh = /\p{Script=Han}/u.test(seed.stableKernel.taskGoal)
  const refIds = sourceRefs.map(ref => ref.sourceRefId)
  const workspace = seed.workspaceRoot ?? (zh ? '当前本地用户作用域' : 'current local-owner scope')
  const taskFamily = canonicalTaskFamily(seed.stableKernel.taskGoal)
  const stableTools = actions.summaries.length === 0
    ? (zh ? '已观测工具步骤' : 'observed tool steps')
    : actions.summaries.map((summary, index) => `${String(index + 1)}. ${summary}`).join(' → ')
  const recoveryTools = stableTools
  const failedTools = failedActionSummaries(seed).join(', ')
  const verifiers = seed.stableKernel.verifierTools.join(', ')
  const failures = seed.stableKernel.failureCodes.join(', ')
  const values = roleContentForKind(
    seed, kind, workspace, stableTools, recoveryTools, verifiers, failures, failedTools, zh,
  )
  const components = componentRolesFor(seed, kind).map((role, index) => ({
    componentKey: `${kind}:${role}:${String(index + 1)}`,
    role,
    content: values[role] ?? (zh ? `来自会话证据的${role}` : `${role} from Session evidence`),
    sourceRefs: sourceRefsForRole(seed, kind, role, actions, refIds),
  }))
  const fields = [
    'proposedKind', 'title', 'intent', 'scope', 'validity', 'authoritySpec', 'privacyClass',
    'riskAndEffectSpec', 'allowedUseModes',
    ...components.map(component => `component:${component.componentKey}`),
  ]
  const titlePrefix = titlePrefixForKind(kind, zh)
  const factWindow = kind === 'fact' ? authoritativeFactWindow(seed) : null
  const titleSubject = kind === 'fact' ? authoritativeFactSummary(seed) ?? seed.stableKernel.taskGoal
    : seed.stableKernel.taskGoal
  const allowedUseModes = kind === 'causal'
    ? ['reference' as const]
    : ['reference' as const, 'suggest' as const, ...(kind === 'procedure' || kind === 'diagnostic'
      ? ['guided' as const] : [])]
  return {
    proposedKind: kind,
    title: bounded(`${titlePrefix}：${titleSubject}`, 180),
    intent: intentForKind(kind, titleSubject, zh),
    scope: {
      ...(taskFamily === 'general' ? {} : { taskFamily }),
      ...(seed.workspaceRoot === null ? {} : { workspaceRoot: seed.workspaceRoot }),
    },
    validity: {
      source: 'completed_dsh_session_turn',
      observedAt: seed.detectedAt,
      revalidation: 'required_before_use',
      ...(factWindow === null ? {} : { validFrom: factWindow.validFrom, validUntil: factWindow.validUntil }),
    },
    authoritySpec: { source: 'dsh_session_log', decision: 'local_owner_review_required' },
    privacyClass: 'workspace',
    riskAndEffectSpec: {
      risk: 'tool_dependent',
      execution: 'not_authorized_by_suggestion',
      permission: 'must_revalidate_current_authority',
    },
    allowedUseModes,
    components,
    evidenceGrade: 'observation_supported',
    fieldSourceRefs: fieldSources(fields, components, refIds),
    excludedSteps: excludedFailures(seed, zh),
    missingEvidence: [],
    unresolvedFields: [],
  }
}

function componentRolesFor(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
): readonly ComponentRole[] {
  const required = TYPE_BEHAVIORS[kind].requiredRoles
  if (kind !== 'preference_policy') return required
  const preference = parseExplicitPreference(seed.stableKernel.taskGoal)
  return [
    ...required,
    preference?.exampleRole ?? 'positive_example',
    preference?.overridePolicy === 'no_known_exception' ? 'no_known_exception' : 'exception',
  ]
}

function roleContentForKind(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
  workspace: string,
  stableTools: string,
  recoveryTools: string,
  verifiers: string,
  failures: string,
  failedTools: string,
  zh: boolean,
): Partial<Record<ComponentRole, string>> {
  if (kind === 'procedure') {
    return procedureRoleContent(seed.stableKernel.taskGoal, workspace, stableTools, verifiers, failures, failedTools, zh)
  }
  if (kind === 'diagnostic') {
    return diagnosticRoleContent(seed.stableKernel.taskGoal, workspace, recoveryTools, verifiers, failures, failedTools, zh)
  }
  if (kind === 'preference_policy') return preferenceRoleContent(seed, zh)
  if (kind === 'fact') return factRoleContent(seed, zh)
  if (kind === 'strategy') return strategyRoleContent(seed, zh)
  return causalRoleContent(seed, zh)
}

function preferenceRoleContent(
  seed: ExperienceSuggestionSeedView,
  zh: boolean,
): Partial<Record<ComponentRole, string>> {
  const signal = parseExplicitPreference(seed.stableKernel.taskGoal)
  const unresolved = zh ? '需要用户确认' : 'requires user confirmation'
  const directive = signal?.directive ?? seed.stableKernel.taskGoal
  const override = signal?.overridePolicy ?? unresolved
  return {
    directive,
    modality: signal?.modality ?? unresolved,
    subject_scope: zh ? '当前本地用户' : 'current local owner',
    task_or_output_scope: signal?.taskOrOutputScope ?? unresolved,
    authority_source: zh ? '当前会话中的用户原话' : 'verbatim user instruction in the current Session',
    override_policy: override,
    valid_from: seed.detectedAt,
    positive_example: signal?.exampleRole === 'positive_example' ? directive : unresolved,
    negative_example: signal?.exampleRole === 'negative_example' ? directive : unresolved,
    exception: override === 'no_known_exception' ? unresolved : override,
    no_known_exception: override === 'no_known_exception'
      ? (zh ? '用户明确声明无例外' : 'the user explicitly declared no exception') : unresolved,
  }
}

function factRoleContent(
  seed: ExperienceSuggestionSeedView,
  zh: boolean,
): Partial<Record<ComponentRole, string>> {
  const match = seed.evidenceSignals.find(signal => signal.evidenceClass === 'observed_fact'
    && parseAuthoritativeFact(signal.content) !== null)
  const signal = match === undefined ? null : parseAuthoritativeFact(match.content)
  const unresolved = zh ? '需要权威结构化读回' : 'requires an authoritative structured readback'
  return {
    subject: signal?.subject ?? unresolved,
    predicate: signal?.predicate ?? unresolved,
    object_or_value: signal?.value ?? unresolved,
    qualifiers: signal?.qualifiers ?? unresolved,
    valid_from: signal?.validFrom ?? unresolved,
    source_evidence: match === undefined
      ? unresolved : signal?.sourceAuthority ?? 'dsh_tool_result',
    contradiction_policy: signal?.freshness === null || signal === null
      ? unresolved
      : (zh ? `超过 ${signal.freshness} 或出现更新权威读回时失效。` : `Invalidate after ${signal.freshness} or a newer authoritative readback.`),
  }
}

function strategyRoleContent(
  seed: ExperienceSuggestionSeedView,
  zh: boolean,
): Partial<Record<ComponentRole, string>> {
  const signal = parseStrategySignal(seed.stableKernel.taskGoal)
  const unresolved = zh ? '需要增强或人工审阅' : 'requires enrichment or human review'
  const text = signal?.text ?? seed.stableKernel.taskGoal
  return {
    decision_point: text,
    candidate_option: signal === null ? unresolved : `${signal.options.join(', ')} · ${text}`,
    hard_constraint: signal?.hasHardConstraint ? text : unresolved,
    decision_criterion: signal?.hasDecisionCriterion ? text : unresolved,
    tradeoff: signal?.hasTradeoff ? text : unresolved,
    stop_exploration_rule: signal?.hasStopRule ? text : unresolved,
    escalation_rule: signal?.hasEscalationRule ? text : unresolved,
    outcome_measure: signal?.hasOutcomeMeasure ? text : unresolved,
  }
}

function causalRoleContent(
  seed: ExperienceSuggestionSeedView,
  zh: boolean,
): Partial<Record<ComponentRole, string>> {
  const signal = parseCausalSignal(seed.stableKernel.taskGoal)
  const unresolved = zh ? '尚无足够证据' : 'insufficient evidence'
  const evidence = seed.evidenceSignals
    .filter(item => item.evidenceClass === 'observed_fact')
    .map(item => normalizeKernelText(item.content))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(' · ')
  return {
    cause_or_intervention: signal?.cause ?? unresolved,
    effect_or_metric: signal?.effect ?? unresolved,
    applicability_condition: signal?.applicability ?? unresolved,
    mechanism: signal?.mechanism ?? unresolved,
    competing_explanation: signal?.competingExplanation ?? unresolved,
    evidence_link: evidence || unresolved,
    falsifier: signal?.falsifier ?? unresolved,
    causal_grade: 'causal_candidate',
    allowed_use: zh ? '仅作为待验证假设参考；不得自动执行或视为因果定论。' : 'Reference-only hypothesis; never auto-execute or treat as an established cause.',
  }
}

function titlePrefixForKind(kind: ExperienceSuggestionGroupView['kind'], zh: boolean): string {
  const values: Record<ExperienceSuggestionGroupView['kind'], readonly [string, string]> = {
    procedure: ['可复用流程', 'Reusable procedure'],
    diagnostic: ['可复用排错', 'Reusable diagnostic'],
    preference_policy: ['明确偏好', 'Explicit preference'],
    fact: ['权威事实', 'Authoritative fact'],
    strategy: ['策略候选', 'Strategy candidate'],
    causal: ['因果候选', 'Causal candidate'],
  }
  return values[kind][zh ? 0 : 1]
}

function intentForKind(kind: ExperienceSuggestionGroupView['kind'], goal: string, zh: boolean): string {
  if (kind === 'procedure' || kind === 'diagnostic') return zh
    ? `在相同目标与边界下复用已验证路径，减少重复试错：${goal}`
    : `Reuse the verified path under the same goal and boundaries: ${goal}`
  if (kind === 'preference_policy') return zh ? `在适用任务中遵守用户明确偏好：${goal}` : `Honor the explicit user preference in its declared scope: ${goal}`
  if (kind === 'fact') return zh ? `在新鲜度边界内引用权威工具读回：${goal}` : `Reference an authoritative tool readback within its freshness boundary: ${goal}`
  if (kind === 'strategy') return zh ? `保留待审阅的方案选择框架：${goal}` : `Retain a reviewable option-selection frame: ${goal}`
  return zh ? `保留待验证且不得自动晋级的因果候选：${goal}` : `Retain a causal candidate that cannot be promoted automatically: ${goal}`
}

function procedureRoleContent(
  goal: string,
  workspace: string,
  tools: string,
  verifiers: string,
  failures: string,
  failedTools: string,
  zh: boolean,
): Partial<Record<ComponentRole, string>> {
  return zh ? {
    goal_signature: goal,
    entry_condition: `仅当当前目标与“${goal}”一致、工作区为 ${workspace}，且当前权限允许相应工具时进入。`,
    forbidden_condition: '工作区、权限或验证器不一致时禁止直接照搬执行；自动建议本身不授予执行权限。',
    parameter: '一次性参数不固化；执行时重新读取当前任务参数和环境。',
    environment_adapter: `在 ${workspace} 中按当前环境解析工具和路径，不复用会话中的临时绝对值。`,
    step: `按已验证顺序执行稳定步骤：${tools}。`,
    checkpoint: `在关键步骤后使用 ${verifiers || '记录中的验证器'} 检查当前结果。`,
    side_effect_policy: '所有工具副作用继续服从当前任务权限、批准和预检；本经验只提供指导。',
    failure_branch: failures === '' && failedTools === ''
      ? '任一步骤或最终验证失败时停止复用并重新诊断，不把 turn 完成当作成功。'
      : `出现 ${[failedTools, failures].filter(Boolean).join(' / ')} 或最终验证失败时停止稳定路径，先进入诊断分支。`,
    verifier: `只有 ${verifiers || '记录中的验证器'} 返回结构化成功结果时才算完成。`,
  } : {
    goal_signature: goal,
    entry_condition: `Enter only when the current goal matches “${goal}”, the workspace is ${workspace}, and current authority permits the tools.`,
    forbidden_condition: 'Do not copy the path when workspace, authority, or verifier differs; a suggestion grants no execution permission.',
    parameter: 'Do not freeze one-off values; resolve current task parameters and environment at use time.',
    environment_adapter: `Resolve tools and paths in ${workspace} from the current environment rather than retaining transient absolute values.`,
    step: `Run the stable observed sequence: ${tools}.`,
    checkpoint: `After material steps, inspect the current result with ${verifiers || 'the recorded verifier'}.`,
    side_effect_policy: 'All tool effects remain subject to current task authority, approval, and preflight; this Experience is guidance only.',
    failure_branch: failures === '' && failedTools === ''
      ? 'If any step or final verifier fails, stop reuse and diagnose; turn completion is not success.'
      : `On ${[failedTools, failures].filter(Boolean).join(' / ')} or verifier failure, stop the stable path and enter diagnosis.`,
    verifier: `Completion requires a structurally successful ${verifiers || 'recorded verifier'} result.`,
  }
}

function diagnosticRoleContent(
  goal: string,
  workspace: string,
  tools: string,
  verifiers: string,
  failures: string,
  failedTools: string,
  zh: boolean,
): Partial<Record<ComponentRole, string>> {
  return zh ? {
    symptom_signature: failures === '' ? `目标“${goal}”在稳定验证前出现结构化工具失败。` : `结构化失败信号：${failures}。`,
    environment_scope: `只适用于 ${workspace} 中目标与“${goal}”一致的任务。`,
    observed_fact: `会话先观测到 ${[failedTools, failures].filter(Boolean).join(' / ') || '工具失败'}，随后通过 ${verifiers || '记录中的验证器'} 得到成功读回。`,
    hypothesis: `失败与观测到的 ${failures || '结构化失败信号'} 相关；这不是未经验证的永久因果结论。`,
    discriminator: `应用前先核对当前错误码、工作区和目标是否与 ${failures || '记录信号'} 一致。`,
    misleading_signal: '会话结束或模型声称完成都不能替代工具结果和恢复验证器。',
    branch: `若区分信号一致，参考 ${tools} 的已验证顺序；不一致则保留为独立问题并重新诊断。`,
    resolution_candidate: `候选恢复路径：${tools}。`,
    falsifier: `当前错误信号不一致，或 ${verifiers || '恢复验证器'} 未成功时，否定该诊断路径。`,
    recovery_verifier: `只有 ${verifiers || '记录中的恢复验证器'} 返回结构化成功结果才确认恢复。`,
  } : {
    symptom_signature: failures === '' ? `The goal “${goal}” had a structured tool failure before stable verification.` : `Structured failure signal: ${failures}.`,
    environment_scope: `Applies only in ${workspace} when the current goal matches “${goal}”.`,
    observed_fact: `The Session observed ${[failedTools, failures].filter(Boolean).join(' / ') || 'a tool failure'} before a successful ${verifiers || 'recorded verifier'} readback.`,
    hypothesis: `The failure is associated with ${failures || 'the structured failure signal'}; this is not an unverified permanent causal claim.`,
    discriminator: `Confirm current error code, workspace, and goal against ${failures || 'the recorded signal'} before applying.`,
    misleading_signal: 'Turn completion or a model claim does not replace tool results and the recovery verifier.',
    branch: `When discriminators match, follow the verified ${tools} path; otherwise keep the problem distinct and diagnose again.`,
    resolution_candidate: `Candidate recovery path: ${tools}.`,
    falsifier: `Reject this diagnosis if the current signal differs or ${verifiers || 'the recovery verifier'} does not succeed.`,
    recovery_verifier: `Recovery requires a structurally successful ${verifiers || 'recorded recovery verifier'} result.`,
  }
}

function occurrenceFor(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
  sourceRefs: readonly SourceRefView[],
): ExperienceSuggestionOccurrenceView {
  return {
    occurrenceId: `occurrence:${suggestionDigest({
      sessionId: seed.sessionId,
      endSeq: seed.episodeRef.eventEnd,
      sourceRangeDigest: seed.episodeRef.contentDigest,
      detectorVersion: seed.detectorVersion,
      kernelRole: kind,
    }).slice('sha256:'.length)}`,
    seedOccurrenceId: seed.occurrenceId,
    sessionId: seed.sessionId,
    episodeRef: seed.episodeRef,
    sourceRefs,
    detectedAt: seed.detectedAt,
    expiresAt: seed.expiresAt,
  }
}

function withConsolidatedDraftSources(
  draft: ExperienceCandidateDraft,
  drafts: readonly ExperienceCandidateDraft[],
): ExperienceCandidateDraft {
  const excluded = new Map<string, ExperienceCandidateDraft['excludedSteps'][number]>()
  for (const item of drafts.flatMap(value => value.excludedSteps)) {
    const key = suggestionDigest({ summary: item.summary, reason: item.reason })
    const current = excluded.get(key)
    excluded.set(key, current === undefined ? item : {
      ...current,
      sourceRefs: sortedUnique([...current.sourceRefs, ...item.sourceRefs]),
    })
  }
  return {
    ...draft,
    components: draft.components.map(component => ({
      ...component,
      sourceRefs: sortedUnique(drafts.flatMap(item => item.components
        .filter(candidate => candidate.componentKey === component.componentKey
          && candidate.role === component.role
          && normalizeKernelText(candidate.content) === normalizeKernelText(component.content))
        .flatMap(candidate => candidate.sourceRefs))),
    })),
    fieldSourceRefs: Object.fromEntries(Object.keys(draft.fieldSourceRefs).map(field => [
      field,
      sortedUnique(drafts.flatMap(item => sameDraftField(draft, item, field)
        ? item.fieldSourceRefs[field] ?? [] : [])),
    ])),
    excludedSteps: [...excluded.values()],
  }
}

/** Merge only source references covered by an explicit incoming-to-representative component map. */
export function mergeSuggestionDraftSources(
  representative: ExperienceCandidateDraft,
  members: readonly {
    readonly draft: ExperienceCandidateDraft
    readonly correspondence: readonly {
      readonly incomingComponentKey: string
      readonly targetComponentKey: string
    }[]
  }[],
): ExperienceCandidateDraft {
  const refs = new Map(representative.components.map(component => [
    component.componentKey,
    new Set(component.sourceRefs),
  ] as const))
  for (const member of members) {
    for (const mapping of member.correspondence) {
      const incoming = member.draft.components.find(component =>
        component.componentKey === mapping.incomingComponentKey)
      const target = representative.components.find(component =>
        component.componentKey === mapping.targetComponentKey)
      if (incoming === undefined || target === undefined || incoming.role !== target.role) continue
      const targetRefs = refs.get(target.componentKey)!
      for (const sourceRef of incoming.sourceRefs) targetRefs.add(sourceRef)
    }
  }
  const components = representative.components.map(component => ({
    ...component,
    sourceRefs: [...refs.get(component.componentKey)!].sort(),
  }))
  return {
    ...representative,
    components,
    fieldSourceRefs: {
      ...representative.fieldSourceRefs,
      ...Object.fromEntries(components.map(component => [
        `component:${component.componentKey}`,
        component.sourceRefs,
      ])),
    },
  }
}

function sameComponentContents(left: ExperienceCandidateDraft, right: ExperienceCandidateDraft): boolean {
  if (left.components.length !== right.components.length) return false
  return left.components.every((component, index) => {
    const other = right.components[index]
    return other !== undefined && component.componentKey === other.componentKey && component.role === other.role
      && normalizeKernelText(component.content) === normalizeKernelText(other.content)
  })
}

function sameDraftField(left: ExperienceCandidateDraft, right: ExperienceCandidateDraft, field: string): boolean {
  if (field.startsWith('component:')) {
    const key = field.slice('component:'.length)
    const leftComponent = left.components.find(component => component.componentKey === key)
    const rightComponent = right.components.find(component => component.componentKey === key)
    return leftComponent !== undefined && rightComponent !== undefined
      && leftComponent.role === rightComponent.role
      && normalizeKernelText(leftComponent.content) === normalizeKernelText(rightComponent.content)
  }
  return suggestionDigest((left as unknown as Record<string, unknown>)[field])
    === suggestionDigest((right as unknown as Record<string, unknown>)[field])
}

function uniqueSourceRefs(values: readonly SourceRefView[]): SourceRefView[] {
  return [...new Map(values.map(value => [value.sourceRefId, value])).values()]
    .sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId))
}

function sourceRefsForKind(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
): SourceRefView[] {
  const signals = seed.evidenceSignals.filter(signal => {
    if (kind === 'preference_policy') {
      return signal.evidenceClass === 'user_instruction' && parseExplicitPreference(signal.content) !== null
    }
    if (kind === 'fact') {
      return signal.evidenceClass === 'observed_fact' && parseAuthoritativeFact(signal.content) !== null
    }
    if (kind === 'strategy') {
      return signal.evidenceClass === 'user_instruction' && parseStrategySignal(signal.content) !== null
    }
    if (kind === 'causal') {
      return (signal.evidenceClass === 'user_instruction' && parseCausalSignal(signal.content) !== null)
        || signal.evidenceClass === 'observed_fact'
    }
    return true
  })
  return uniqueSourceRefs(signals.map(signal => signal.sourceRef))
}

function sourceRefsForRole(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
  role: ComponentRole,
  actions: StableActionProjection,
  fallback: readonly string[],
): string[] {
  const signals = [...seed.evidenceSignals].sort(compareEvidenceOrder)
  const refs = (predicate: (signal: ExperienceSuggestionSeedView['evidenceSignals'][number]) => boolean) =>
    signals.filter(predicate).map(signal => signal.sourceRef.sourceRefId)
  const goal = refs(signal => signal.role === 'user_goal' && signal.evidenceClass === 'user_instruction')
  const verifier = refs(signal => signal.role === 'terminal_readback' && signal.evidenceClass === 'observed_fact')
  const failure = refs(signal => signal.role === 'symptom' && signal.evidenceClass === 'observed_fact')
  const preference = refs(signal => signal.evidenceClass === 'user_instruction'
    && parseExplicitPreference(signal.content) !== null)
  const fact = refs(signal => signal.evidenceClass === 'observed_fact'
    && parseAuthoritativeFact(signal.content) !== null)
  const strategy = refs(signal => signal.evidenceClass === 'user_instruction'
    && parseStrategySignal(signal.content) !== null)
  const causalClaim = refs(signal => signal.evidenceClass === 'user_instruction'
    && parseCausalSignal(signal.content) !== null)
  const causalEvidence = refs(signal => signal.evidenceClass === 'observed_fact'
    && signal.role !== 'symptom')
  const channel = COMPONENT_ROLE_GROUNDING[role]
  const selected = channel === 'goal' ? goal
    : channel === 'action' ? actions.sourceRefs
      : channel === 'action_first' ? actions.sourceRefs.slice(0, 1)
        : channel === 'action_last' ? actions.sourceRefs.slice(-1)
      : channel === 'verifier' ? verifier
        : channel === 'failure' ? failure
          : channel === 'failure_and_verifier' ? (failure.length > 0 ? [...failure, ...verifier] : verifier)
            : channel === 'preference' ? preference
              : channel === 'fact' ? fact
                : channel === 'strategy' ? strategy
                  : channel === 'causal_claim' ? causalClaim
                    : channel === 'causal_effect' ? causalEvidence.slice(0, 1) : causalEvidence.slice(-1)
  if (selected.length > 0) return sortedUnique(selected)
  const kindRefs = kind === 'procedure' || kind === 'diagnostic' ? [...goal, ...actions.sourceRefs, ...verifier]
    : fallback
  return sortedUnique(kindRefs).slice(0, 1)
}

function fieldSources(
  fields: readonly string[],
  components: readonly ExperienceCandidateDraft['components'][number][],
  fallback: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const anchorRefs = components.find(component => experienceComponentIdentityClass(component.role) === 'series')
    ?.sourceRefs ?? fallback.slice(0, 1)
  return Object.fromEntries(fields.map(field => {
    if (!field.startsWith('component:')) return [field, anchorRefs]
    const componentKey = field.slice('component:'.length)
    return [field, components.find(component => component.componentKey === componentKey)?.sourceRefs ?? []]
  }))
}

function excludedFailures(
  seed: ExperienceSuggestionSeedView,
  zh: boolean,
): ExperienceCandidateDraft['excludedSteps'] {
  return [...seed.evidenceSignals]
    .filter(signal => signal.role === 'symptom' && signal.evidenceClass === 'observed_fact')
    .sort(compareEvidenceOrder)
    .map(signal => ({
      summary: zh
        ? `已观测失败：${normalizeActionDetail(actionDetail(signal.content), seed.workspaceRoot)}`
        : `Observed failure: ${normalizeActionDetail(actionDetail(signal.content), seed.workspaceRoot)}`,
      reason: zh
        ? '该失败发生在成功验证之前，不能作为稳定路径复用。'
        : 'This failure preceded successful verification and is excluded from the stable path.',
      sourceRefs: [signal.sourceRef.sourceRefId],
    }))
}

function semanticMissingFields(
  seed: ExperienceSuggestionSeedView,
  kind: Exclude<ExperienceSuggestionGroupView['kind'], 'procedure' | 'diagnostic'>,
): string[] {
  if (kind === 'preference_policy') {
    const signal = parseExplicitPreference(seed.stableKernel.taskGoal)
    if (signal === null) return ['directive', 'modality', 'task_or_output_scope', 'override_policy']
    return unique([
      ...(signal.taskOrOutputScope === null ? ['task_or_output_scope'] : []),
      ...(signal.overridePolicy === null ? ['override_policy'] : []),
      ...(seed.evidenceSignals.some(item => item.evidenceClass === 'user_instruction'
        && item.projectionTruncated) ? ['directive'] : []),
    ])
  }
  if (kind === 'fact') {
    const signal = seed.evidenceSignals
      .filter(item => item.evidenceClass === 'observed_fact')
      .map(item => ({ item, fact: parseAuthoritativeFact(item.content) }))
      .find(item => item.fact !== null)
    if (signal === undefined || signal.fact === null) {
      return ['subject', 'predicate', 'object_or_value', 'valid_from', 'source_evidence']
    }
    const validFrom = signal.fact.validFrom === null ? Number.NaN : Date.parse(signal.fact.validFrom)
    const validUntil = signal.fact.freshness === null ? Number.NaN : Date.parse(signal.fact.freshness)
    return unique([
      ...(!Number.isFinite(validFrom) ? ['valid_from'] : []),
      ...(!Number.isFinite(validUntil) || validUntil <= validFrom ? ['contradiction_policy'] : []),
      ...(signal.fact.sourceAuthority === null ? ['source_evidence'] : []),
      ...(signal.item.projectionTruncated ? ['source_evidence'] : []),
    ])
  }
  if (kind === 'strategy') {
    const signal = parseStrategySignal(seed.stableKernel.taskGoal)
    if (signal === null) return ['candidate_option', 'hard_constraint', 'decision_criterion']
    return [
      ...(!signal.hasTradeoff ? ['tradeoff'] : []),
      ...(!signal.hasStopRule ? ['stop_exploration_rule'] : []),
      ...(!signal.hasEscalationRule ? ['escalation_rule'] : []),
      ...(!signal.hasOutcomeMeasure ? ['outcome_measure'] : []),
    ]
  }
  const signal = parseCausalSignal(seed.stableKernel.taskGoal)
  if (signal === null) return ['cause_or_intervention', 'effect_or_metric', 'applicability_condition']
  return [
    ...(signal.mechanism === null ? ['mechanism'] : []),
    ...(signal.competingExplanation === null ? ['competing_explanation'] : []),
    ...(signal.falsifier === null ? ['falsifier'] : []),
    ...(seed.evidenceSignals.some(item => item.evidenceClass === 'observed_fact') ? [] : ['evidence_link']),
  ]
}

function authoritativeFactWindow(seed: ExperienceSuggestionSeedView): {
  readonly validFrom: string
  readonly validUntil: string
} | null {
  const fact = seed.evidenceSignals
    .filter(item => item.evidenceClass === 'observed_fact')
    .map(item => parseAuthoritativeFact(item.content))
    .find(item => item !== null)
  if (fact?.validFrom === null || fact?.freshness === null || fact === undefined) return null
  const validFrom = Date.parse(fact.validFrom)
  const validUntil = Date.parse(fact.freshness)
  return Number.isFinite(validFrom) && Number.isFinite(validUntil) && validUntil > validFrom
    ? { validFrom: fact.validFrom, validUntil: fact.freshness }
    : null
}

function authoritativeFactSummary(seed: ExperienceSuggestionSeedView): string | null {
  const fact = seed.evidenceSignals
    .filter(item => item.evidenceClass === 'observed_fact')
    .map(item => parseAuthoritativeFact(item.content))
    .find(item => item !== null)
  return fact === undefined ? null : `${fact.subject} ${fact.predicate} ${fact.value}`
}

function riskFlagsForKind(kind: ExperienceSuggestionGroupView['kind']): string[] {
  if (kind === 'fact') return ['freshness_revalidation_required']
  if (kind === 'strategy') return ['human_decision_required']
  if (kind === 'causal') return ['causal_promotion_required', 'tool_side_effects_not_authorized']
  if (kind === 'preference_policy') return ['current_user_authority_required']
  return ['current_permission_required', 'tool_side_effects_not_authorized']
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function stableActionProjection(
  seed: ExperienceSuggestionSeedView,
  kind: ExperienceSuggestionGroupView['kind'],
): StableActionProjection {
  const expectedTools = kind === 'diagnostic'
    ? seed.stableKernel.recoveryToolSequence : seed.stableKernel.toolSequence
  if (expectedTools.length === 0) {
    return { summaries: [], sourceRefs: [], complete: false, reason: 'stable_action_details_missing' }
  }
  const lastSymptom = kind === 'diagnostic'
    ? seed.evidenceSignals.filter(signal => signal.role === 'symptom').sort(compareEvidenceOrder).at(-1)
    : undefined
  const candidates = seed.evidenceSignals
    .filter(signal => signal.eventType === 'tool/result'
      && signal.evidenceClass === 'observed_fact'
      && signal.role !== 'symptom'
      && (lastSymptom === undefined || compareEvidenceOrder(signal, lastSymptom) > 0))
    .sort(compareEvidenceOrder)
  const summaries: string[] = []
  const sourceRefs: string[] = []
  let cursor = 0
  let truncated = false
  for (const tool of expectedTools) {
    const index = candidates.findIndex((signal, candidateIndex) => candidateIndex >= cursor
      && normalizeKernelText(firstLine(signal.content)) === normalizeKernelText(tool))
    if (index === -1) {
      return {
        summaries: expectedTools.map(item => item),
        sourceRefs,
        complete: false,
        reason: 'stable_action_details_missing',
      }
    }
    const signal = candidates[index]!
    summaries.push(normalizeActionDetail(actionDetail(signal.content), seed.workspaceRoot))
    sourceRefs.push(signal.sourceRef.sourceRefId)
    truncated ||= signal.projectionTruncated
    cursor = index + 1
  }
  if (truncated) return { summaries, sourceRefs, complete: false, reason: 'stable_action_details_missing' }
  if (summaries.some(hasTransientActionParameter)) {
    return { summaries, sourceRefs, complete: false, reason: 'transient_action_parameter' }
  }
  return { summaries, sourceRefs, complete: true, reason: null }
}

function failedActionSummaries(seed: ExperienceSuggestionSeedView): string[] {
  const candidates = seed.evidenceSignals
    .filter(signal => signal.eventType === 'tool/result' && signal.role === 'symptom')
    .sort(compareEvidenceOrder)
  return seed.stableKernel.failedToolSequence.map(tool => {
    const signal = candidates.find(item => normalizeKernelText(firstLine(item.content)) === normalizeKernelText(tool))
    return signal === undefined ? tool : normalizeActionDetail(actionDetail(signal.content), seed.workspaceRoot)
  })
}

function actionDetail(content: string): string {
  return content.split(/\n\s*\n/u, 1)[0]?.trim() ?? ''
}

function firstLine(content: string): string {
  return content.split(/\r?\n/u, 1)[0]?.trim() ?? ''
}

function compareEvidenceOrder(
  left: ExperienceSuggestionSeedView['evidenceSignals'][number],
  right: ExperienceSuggestionSeedView['evidenceSignals'][number],
): number {
  const timeOrder = Date.parse(left.sourceRef.occurredAt) - Date.parse(right.sourceRef.occurredAt)
  if (timeOrder !== 0) return timeOrder
  const sequenceOrder = sourceSequence(left.sourceRef.locator) - sourceSequence(right.sourceRef.locator)
  return sequenceOrder !== 0 ? sequenceOrder : left.sourceRef.locator.localeCompare(right.sourceRef.locator)
}

function sourceSequence(locator: string): number {
  const match = locator.match(/#(\d+)(?:$|:)/u)
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1])
}

function normalizeActionDetail(content: string, workspaceRoot: string | null): string {
  const workspaceNeutral = workspaceRoot === null || workspaceRoot === ''
    ? content : content.split(workspaceRoot).join('<workspace>')
  return workspaceNeutral.normalize('NFKC').replace(/[ \t]+/gu, ' ').trim()
}

function hasTransientActionParameter(content: string): boolean {
  return /(?:\/(?:private\/)?tmp\/|\/private\/var\/folders\/|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b)/iu.test(content)
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}
