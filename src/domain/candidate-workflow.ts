import { assertInlineValue, assertSafeText } from '../application/content-policy.js'
import { ExperienceError } from '../errors.js'
import type { ActorId, CandidateId, ComponentId, ComponentRevisionId, EvidenceId } from '../ids.js'
import type {
  CandidateDispositionInput,
  CandidateFieldReviewInput,
  CandidateFieldView,
  CandidateProposalMetadata,
  ExperienceCandidateDraft,
  ExperienceComponentInput,
  EpisodeRefView,
  EpisodeOutcomeAssessmentView,
  ExtractionTriggerView,
  SourceRefView,
} from '../types.js'
import { CANDIDATE_REJECTION_REASON_CODES, M2_ALLOWED_USE_MODES } from '../types.js'
import { TYPE_BEHAVIORS } from './behavior.js'
import { EXPERIENCE_KINDS, type ExperienceKind } from './kind.js'

/** Historical field decision retained inside a durable M2 Candidate. */
export interface CandidateDecisionRecord extends CandidateFieldReviewInput {
  readonly decisionId: string
  readonly actorId: ActorId
  readonly decidedAt: string
  readonly supersedesDecisionId: string | null
}

/** IDs allocated with a Candidate before publication. */
export interface CandidateWorkflowAllocation {
  readonly candidateId: CandidateId
  readonly componentIds: readonly ComponentId[]
  readonly componentRevisionIds: readonly ComponentRevisionId[]
  readonly evidenceIds: readonly EvidenceId[]
}

/** Durable M2 Candidate aggregate. */
export interface CandidateWorkflowRecord {
  readonly candidateId: CandidateId
  readonly target: 'new_experience'
  readonly extractionTrigger: ExtractionTriggerView
  readonly outcomeAssessment: EpisodeOutcomeAssessmentView
  readonly eligibilityDigest: string
  readonly triggerReason: string
  readonly sourceEpisodeRefs: readonly EpisodeRefView[]
  readonly sourceRefs: readonly SourceRefView[]
  readonly draft: ExperienceCandidateDraft
  readonly proposal: CandidateProposalMetadata
  readonly componentIds: readonly ComponentId[]
  readonly componentRevisionIds: readonly ComponentRevisionId[]
  readonly evidenceIds: readonly EvidenceId[]
  readonly decisions: readonly CandidateDecisionRecord[]
  readonly revision: number
  readonly state: 'proposed' | 'in_review' | 'accepted' | 'published' | 'rejected' | 'withdrawn'
  readonly proposedBy: ActorId
  readonly createdAt: string
  readonly publishedVersionId: import('../ids.js').ExperienceVersionId | null
  readonly dispositionReason: string | null
}

/** Candidate field/value set shared by review, acceptance, and publication. */
export function workflowFields(candidate: Pick<
  CandidateWorkflowRecord,
  'draft' | 'sourceEpisodeRefs' | 'sourceRefs'
>): ReadonlyArray<readonly [string, unknown]> {
  const { draft } = candidate
  return [
    ['proposedKind', draft.proposedKind],
    ['sourceEpisodeRefs', candidate.sourceEpisodeRefs],
    ['sourceRefs', candidate.sourceRefs],
    ['title', draft.title],
    ['intent', draft.intent],
    ['scope', draft.scope],
    ['validity', draft.validity],
    ['authoritySpec', draft.authoritySpec],
    ['privacyClass', draft.privacyClass],
    ['riskAndEffectSpec', draft.riskAndEffectSpec],
    ['allowedUseModes', draft.allowedUseModes],
    ...draft.components.map(component => [`component:${component.componentKey}`, component] as const),
  ]
}

/** Validate the selected kind's strict proposal semantics at model, import, and edit boundaries. */
export function validateWorkflowDraft(
  draft: ExperienceCandidateDraft,
  episodeRefs: readonly EpisodeRefView[],
  sourceRefs: readonly SourceRefView[],
  maxInlineFieldBytes: number,
): void {
  nonEmpty(draft.title, 'title')
  nonEmpty(draft.intent, 'intent')
  nonEmptyRecord(draft.scope, 'scope')
  nonEmptyRecord(draft.validity, 'validity')
  nonEmptyRecord(draft.authoritySpec, 'authoritySpec')
  nonEmptyRecord(draft.riskAndEffectSpec, 'riskAndEffectSpec')
  if (draft.privacyClass === 'secret_reference_only') {
    throw new ExperienceError(
      'governed_content_capability_unavailable',
      'secret_reference_only content cannot be persisted while Governed Content is disabled',
    )
  }
  if (draft.allowedUseModes.length === 0 || new Set(draft.allowedUseModes).size !== draft.allowedUseModes.length) {
    throw new ExperienceError('required_field_missing', 'allowedUseModes must be a non-empty unique list')
  }
  if (draft.allowedUseModes.some(mode => !M2_ALLOWED_USE_MODES.includes(mode as typeof M2_ALLOWED_USE_MODES[number]))) {
    throw new ExperienceError('invalid_command', 'M2 allowedUseModes cannot exceed guided without an executor binding')
  }
  const keys = new Set(draft.components.map(component => component.componentKey))
  if (keys.size !== draft.components.length) {
    throw new ExperienceError('invalid_command', 'Candidate component keys must be unique')
  }
  const behavior = TYPE_BEHAVIORS[draft.proposedKind]
  const roles = new Set(draft.components.map(component => component.role))
  const missingRoles = behavior.validate(roles)
  if (missingRoles.length > 0) {
    throw new ExperienceError('required_field_missing', `${draft.proposedKind} proposal lacks mandatory components`, {
      missing: missingRoles,
    })
  }
  for (const component of draft.components) behavior.contribute(component.role, component.content)
  validateKindSpecificSemantics(draft)
  const allowedRefs = new Set([
    ...episodeRefs.map(ref => ref.episodeRefId as string),
    ...sourceRefs.map(ref => ref.sourceRefId as string),
  ])
  for (const component of draft.components) validateComponent(component, allowedRefs, maxInlineFieldBytes)
  const draftRecord = { draft, sourceEpisodeRefs: episodeRefs, sourceRefs }
  const fields = workflowFields(draftRecord).map(([field]) => field)
  const sourcedFields = fields.filter(field => field !== 'sourceEpisodeRefs' && field !== 'sourceRefs')
  const unknownSourceFields = Object.keys(draft.fieldSourceRefs).filter(field => !sourcedFields.includes(field))
  if (unknownSourceFields.length > 0) {
    throw new ExperienceError('invalid_command', 'proposal fieldSourceRefs contains unknown fields', {
      fields: unknownSourceFields.sort(),
    })
  }
  for (const field of sourcedFields) {
    const refs = draft.fieldSourceRefs[field] ?? []
    if (refs.some(ref => !allowedRefs.has(ref))) {
      throw new ExperienceError('source_unresolvable', `proposal field ${JSON.stringify(field)} cites an unknown source`)
    }
  }
  const expectedUnresolved = sourcedFields.filter(field => (draft.fieldSourceRefs[field] ?? []).length === 0)
  if (!sameStringSet(draft.unresolvedFields, expectedUnresolved)) {
    throw new ExperienceError(
      'source_unresolvable',
      'unresolvedFields must exactly identify proposal fields without source references',
      { expected: expectedUnresolved.sort() },
    )
  }
  for (const excluded of draft.excludedSteps) {
    nonEmpty(excluded.summary, 'excludedSteps.summary')
    nonEmpty(excluded.reason, 'excludedSteps.reason')
    if (excluded.sourceRefs.length === 0 || excluded.sourceRefs.some(ref => !allowedRefs.has(ref))) {
      throw new ExperienceError('source_unresolvable', 'each excluded step requires resolvable source references')
    }
    assertInlineValue(excluded, maxInlineFieldBytes, 'excluded step')
  }
  for (const [field, value] of workflowFields(draftRecord)) {
    if (field === 'sourceEpisodeRefs' || field === 'sourceRefs') continue
    assertInlineValue(value, maxInlineFieldBytes, `Candidate field ${field}`)
  }
}

/** Create a proposed Candidate without accepting any model field. */
export function createCandidateWorkflow(
  draft: ExperienceCandidateDraft,
  episodeRefs: readonly EpisodeRefView[],
  sourceRefs: readonly SourceRefView[],
  eligibility: {
    readonly extractionTrigger: ExtractionTriggerView
    readonly outcomeAssessment: EpisodeOutcomeAssessmentView
    readonly eligibilityDigest: string
  },
  proposal: CandidateProposalMetadata,
  actorId: ActorId,
  allocation: CandidateWorkflowAllocation,
  createdAt: string,
  maxInlineFieldBytes: number,
): CandidateWorkflowRecord {
  const hostOwnedDraft = {
    ...draft,
    evidenceGrade: deriveSupportedEvidenceGrade(draft.components, sourceRefs),
    fieldSourceRefs: Object.fromEntries(
      Object.entries(draft.fieldSourceRefs).filter(([field]) => field !== 'evidenceGrade'),
    ),
    unresolvedFields: draft.unresolvedFields.filter(field => field !== 'evidenceGrade'),
  } satisfies ExperienceCandidateDraft
  validateWorkflowDraft(hostOwnedDraft, episodeRefs, sourceRefs, maxInlineFieldBytes)
  if (allocation.componentIds.length !== draft.components.length
    || allocation.componentRevisionIds.length !== draft.components.length
    || allocation.evidenceIds.length !== draft.components.length) {
    throw new ExperienceError('internal', 'Candidate allocation does not match its component proposal')
  }
  return checked({
    candidateId: allocation.candidateId,
    target: 'new_experience',
    extractionTrigger: eligibility.extractionTrigger,
    outcomeAssessment: eligibility.outcomeAssessment,
    eligibilityDigest: eligibility.eligibilityDigest,
    triggerReason: triggerReason(eligibility.extractionTrigger),
    sourceEpisodeRefs: episodeRefs,
    sourceRefs,
    draft: hostOwnedDraft,
    proposal,
    componentIds: allocation.componentIds,
    componentRevisionIds: allocation.componentRevisionIds,
    evidenceIds: allocation.evidenceIds,
    decisions: [],
    revision: 1,
    state: 'proposed',
    proposedBy: actorId,
    createdAt,
    publishedVersionId: null,
    dispositionReason: null,
  })
}

/** Submit one proposed Candidate for field review. */
export function submitCandidateWorkflow(
  candidate: CandidateWorkflowRecord,
  expectedRevision: number,
): CandidateWorkflowRecord {
  assertRevision(candidate, expectedRevision)
  if (candidate.state !== 'proposed') {
    throw new ExperienceError('invalid_command', 'only a proposed Candidate can enter review')
  }
  return checked({ ...candidate, state: 'in_review', revision: candidate.revision + 1 })
}

/** Append the single review decision for one Candidate field. */
export function decideCandidateWorkflowField(
  candidate: CandidateWorkflowRecord,
  review: CandidateFieldReviewInput,
  decisionId: string,
  actorId: ActorId,
  decidedAt: string,
  expectedRevision: number,
  maxInlineFieldBytes: number,
): CandidateWorkflowRecord {
  assertRevision(candidate, expectedRevision)
  if (candidate.state !== 'in_review') {
    throw new ExperienceError('invalid_command', 'field decisions require an in-review Candidate')
  }
  const fields = new Map(workflowFields(candidate))
  if (!fields.has(review.field)) {
    throw new ExperienceError('invalid_command', `Candidate field ${JSON.stringify(review.field)} is not reviewable`)
  }
  if (review.decision === 'edit') {
    if (review.field === 'proposedKind' || review.field === 'sourceEpisodeRefs' || review.field === 'sourceRefs') {
      throw new ExperienceError('invalid_command', `${review.field} cannot be edited; reject the Candidate instead`)
    }
    if (review.value === undefined) {
      throw new ExperienceError('required_field_missing', 'an edit decision requires a replacement value')
    }
    if (review.effectiveSourceRefs === undefined || review.effectiveSourceRefs.length === 0) {
      throw new ExperienceError('required_field_missing', 'an edit decision requires effective source references')
    }
    const allowedRefs = new Set([
      ...candidate.sourceEpisodeRefs.map(ref => ref.episodeRefId as string),
      ...candidate.sourceRefs.map(ref => ref.sourceRefId as string),
    ])
    if (review.effectiveSourceRefs.some(ref => !allowedRefs.has(ref))) {
      throw new ExperienceError('source_unresolvable', 'edited field cites an unknown effective source')
    }
    if (review.field.startsWith('component:')) {
      const replacement = componentValue(review.value, review.field)
      if (!sameStringSet(replacement.sourceRefs, review.effectiveSourceRefs)) {
        throw new ExperienceError('source_unresolvable', 'edited component sources must match effectiveSourceRefs')
      }
    }
    assertInlineValue(review.value, maxInlineFieldBytes, `edited Candidate field ${review.field}`)
  } else if (review.value !== undefined || review.effectiveSourceRefs !== undefined) {
    throw new ExperienceError('invalid_command', 'only an edit decision may carry a replacement value or effective sources')
  }
  nonEmpty(review.reason, 'field decision reason')
  const previous = currentWorkflowDecisions(candidate).get(review.field)
  return checked({
    ...candidate,
    decisions: [...candidate.decisions, {
      ...review,
      decisionId,
      actorId,
      decidedAt,
      supersedesDecisionId: previous?.decisionId ?? null,
    }],
    revision: candidate.revision + 1,
  })
}

/** Accept a Candidate only after every current decision is affirmative and source-backed. */
export function acceptCandidateWorkflow(
  candidate: CandidateWorkflowRecord,
  expectedRevision: number,
  maxInlineFieldBytes: number,
): CandidateWorkflowRecord {
  assertRevision(candidate, expectedRevision)
  if (candidate.state !== 'in_review') {
    throw new ExperienceError('invalid_command', 'only an in-review Candidate can be accepted')
  }
  if (candidate.extractionTrigger.eligibilityStatus !== 'eligible') {
    throw new ExperienceError('invalid_command', 'only an eligible Candidate can be accepted')
  }
  if (candidate.draft.missingEvidence.length > 0) {
    throw new ExperienceError('required_field_missing', 'Candidate missing evidence must be resolved before acceptance', {
      missingEvidence: candidate.draft.missingEvidence,
    })
  }
  const required = workflowFields(candidate).map(([field]) => field)
  const decisions = currentWorkflowDecisions(candidate)
  const missing = required.filter(field => !decisions.has(field))
  if (missing.length > 0) {
    throw new ExperienceError('required_field_missing', 'Candidate review is incomplete', { missing })
  }
  const rejected = required.filter(field => decisions.get(field)?.decision === 'reject')
  if (rejected.length > 0) {
    throw new ExperienceError('invalid_command', 'a Candidate with rejected fields cannot be accepted', { rejected })
  }
  const resolved = resolveWorkflowDraft(candidate)
  if (resolved.unresolvedFields.length > 0) {
    throw new ExperienceError('source_unresolvable', 'Candidate fields without sources cannot be accepted', {
      fields: resolved.unresolvedFields,
    })
  }
  validateWorkflowDraft(
    resolved,
    candidate.sourceEpisodeRefs,
    candidate.sourceRefs,
    maxInlineFieldBytes,
  )
  if (evidenceGradeRank(resolved.evidenceGrade) > evidenceGradeRank(maximumSupportedEvidenceGrade(candidate, resolved))) {
    throw new ExperienceError('invalid_command', 'Candidate evidenceGrade exceeds its accepted sources')
  }
  return checked({ ...candidate, state: 'accepted', revision: candidate.revision + 1 })
}

function triggerReason(trigger: ExtractionTriggerView): string {
  if (trigger.eligibilityStatus === 'eligible' && trigger.triggerKind === 'terminal_success') {
    return 'task outcome is supported by exact mandatory criterion evidence'
  }
  if (trigger.eligibilityStatus === 'candidate_only') {
    return 'the Episode may be reviewed, but current evidence does not authorize publication'
  }
  return 'the Episode is not eligible for Candidate extraction'
}

/** Mark an accepted Candidate published after its Version transaction is prepared. */
export function publishCandidateWorkflow(
  candidate: CandidateWorkflowRecord,
  expectedRevision: number,
  publishedVersionId: import('../ids.js').ExperienceVersionId,
): CandidateWorkflowRecord {
  assertRevision(candidate, expectedRevision)
  if (candidate.state !== 'accepted') {
    throw new ExperienceError('invalid_command', 'only an accepted Candidate can be published')
  }
  if (candidate.extractionTrigger.eligibilityStatus !== 'eligible') {
    throw new ExperienceError('invalid_command', 'only an eligible Candidate can be published')
  }
  const resolved = resolveWorkflowDraft(candidate)
  if (candidate.draft.missingEvidence.length > 0 || resolved.unresolvedFields.length > 0) {
    throw new ExperienceError('source_unresolvable', 'Candidate evidence must be complete before publication')
  }
  if (evidenceGradeRank(resolved.evidenceGrade) > evidenceGradeRank(maximumSupportedEvidenceGrade(candidate, resolved))) {
    throw new ExperienceError('invalid_command', 'Candidate evidenceGrade exceeds its accepted sources')
  }
  return checked({
    ...candidate,
    state: 'published',
    revision: candidate.revision + 1,
    publishedVersionId,
  })
}

/** Reject an in-review Candidate with a stable product reason. */
export function rejectCandidateWorkflow(
  candidate: CandidateWorkflowRecord,
  expectedRevision: number,
  reasonCode: CandidateDispositionInput['reasonCode'],
): CandidateWorkflowRecord {
  assertRevision(candidate, expectedRevision)
  if (candidate.state !== 'in_review') {
    throw new ExperienceError('invalid_command', 'only an in-review Candidate can be rejected')
  }
  if (!CANDIDATE_REJECTION_REASONS.has(reasonCode)) {
    throw new ExperienceError('invalid_command', 'Candidate rejection reasonCode is not recognized')
  }
  return checked({
    ...candidate,
    state: 'rejected',
    revision: candidate.revision + 1,
    dispositionReason: reasonCode,
  })
}

/** Withdraw an unpublished Candidate without creating an Experience Version. */
export function withdrawCandidateWorkflow(
  candidate: CandidateWorkflowRecord,
  expectedRevision: number,
  reasonCode: CandidateDispositionInput['reasonCode'],
): CandidateWorkflowRecord {
  assertRevision(candidate, expectedRevision)
  if (candidate.state === 'published' || candidate.state === 'rejected' || candidate.state === 'withdrawn') {
    throw new ExperienceError('invalid_command', 'only a non-terminal unpublished Candidate can be withdrawn')
  }
  if (!CANDIDATE_WITHDRAWAL_REASONS.has(reasonCode)) {
    throw new ExperienceError('invalid_command', 'Candidate withdrawal reasonCode is not recognized')
  }
  return checked({
    ...candidate,
    state: 'withdrawn',
    revision: candidate.revision + 1,
    dispositionReason: reasonCode,
  })
}

/** Resolve accepted and edited fields into the sole publish draft. */
export function resolveWorkflowDraft(candidate: CandidateWorkflowRecord): ExperienceCandidateDraft {
  const current = currentWorkflowDecisions(candidate)
  const value = (field: string, proposed: unknown): unknown => {
    const decision = current.get(field)
    return decision?.decision === 'edit' ? decision.value : proposed
  }
  const base = candidate.draft
  const components = base.components.map((component, index) => componentValue(
    value(`component:${component.componentKey}`, component),
    `components[${String(index)}]`,
  ))
  const fieldSourceRefs: Record<string, readonly string[]> = Object.fromEntries(
    Object.entries(base.fieldSourceRefs).filter(([field]) => field !== 'evidenceGrade').map(([field, refs]) => {
    const decision = current.get(field)
    return [field, decision?.decision === 'edit' ? decision.effectiveSourceRefs ?? [] : refs]
    }),
  )
  for (const component of components) fieldSourceRefs[`component:${component.componentKey}`] = component.sourceRefs
  return {
    ...base,
    proposedKind: experienceKindValue(value('proposedKind', base.proposedKind), base.proposedKind),
    title: stringValue(value('title', base.title), 'title'),
    intent: stringValue(value('intent', base.intent), 'intent'),
    scope: stringRecord(value('scope', base.scope), 'scope'),
    validity: stringRecord(value('validity', base.validity), 'validity'),
    authoritySpec: stringRecord(value('authoritySpec', base.authoritySpec), 'authoritySpec'),
    privacyClass: privacyValue(value('privacyClass', base.privacyClass)),
    riskAndEffectSpec: stringRecord(value('riskAndEffectSpec', base.riskAndEffectSpec), 'riskAndEffectSpec'),
    allowedUseModes: useModes(value('allowedUseModes', base.allowedUseModes)),
    evidenceGrade: deriveSupportedEvidenceGrade(components, candidate.sourceRefs),
    components,
    fieldSourceRefs,
    unresolvedFields: Object.entries(fieldSourceRefs).filter(([, refs]) => refs.length === 0).map(([field]) => field),
  }
}

/** Highest evidence grade supported by the Candidate's accepted non-model source kinds in M2. */
export function maximumSupportedEvidenceGrade(
  candidate: CandidateWorkflowRecord,
  draft = resolveWorkflowDraft(candidate),
): 'model_asserted' | 'observation_supported' {
  return deriveSupportedEvidenceGrade(draft.components, candidate.sourceRefs)
}

/** Derive the M2 evidence ceiling from resolvable non-model sources owned by the Host. */
export function deriveSupportedEvidenceGrade(
  components: readonly ExperienceComponentInput[],
  sourceRefs: readonly SourceRefView[],
): 'model_asserted' | 'observation_supported' {
  const sources = new Map(sourceRefs.map(ref => [ref.sourceRefId as string, ref]))
  const componentHasObservation = (refs: readonly string[]): boolean => refs.some(ref => {
    const source = sources.get(ref)
    return source?.sourceKind === 'tool_result' || source?.sourceKind === 'external_document'
  })
  return components.every(component => componentHasObservation(component.sourceRefs))
    ? 'observation_supported'
    : 'model_asserted'
}

/** Derive review fields without exposing raw source records to Browser state. */
export function workflowFieldViews(candidate: CandidateWorkflowRecord): CandidateFieldView[] {
  const current = currentWorkflowDecisions(candidate)
  const unresolved = new Set(resolveWorkflowDraft(candidate).unresolvedFields)
  const roles = new Map(candidate.draft.components.map(component => [
    `component:${component.componentKey}`,
    component.role,
  ]))
  return workflowFields(candidate).map(([field, proposedValue]) => {
    const decision = current.get(field)
    const proposedSourceRefs = field === 'sourceEpisodeRefs'
      ? candidate.sourceEpisodeRefs.map(ref => ref.episodeRefId as string)
      : field === 'sourceRefs'
        ? candidate.sourceRefs.map(ref => ref.sourceRefId as string)
        : candidate.draft.fieldSourceRefs[field] ?? []
    const sourceRefs = decision?.decision === 'edit'
      ? decision.effectiveSourceRefs ?? []
      : proposedSourceRefs
    return {
      field,
      stage: fieldStage(field, roles.get(field)),
      componentRole: roles.get(field) ?? null,
      proposedValue,
      proposedSourceRefs,
      sourceRefs,
      unresolved: unresolved.has(field),
      bulkAcceptAllowed: !SENSITIVE_REVIEW_FIELDS.has(field) && !unresolved.has(field),
      currentDecision: decision === undefined ? null : decision,
    }
  })
}

/** Return the latest decision for every field. */
export function currentWorkflowDecisions(candidate: CandidateWorkflowRecord): Map<string, CandidateDecisionRecord> {
  const result = new Map<string, CandidateDecisionRecord>()
  for (const decision of candidate.decisions) result.set(decision.field, decision)
  return result
}

function checked(candidate: CandidateWorkflowRecord): CandidateWorkflowRecord {
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) {
    throw new ExperienceError('invalid_command', 'Candidate revision must be a positive safe integer')
  }
  if (candidate.sourceEpisodeRefs.length === 0 && candidate.sourceRefs.length === 0) {
    throw new ExperienceError('source_unresolvable', 'Candidate requires a resolvable source')
  }
  const decisionIds = candidate.decisions.map(decision => decision.decisionId)
  if (new Set(decisionIds).size !== decisionIds.length
    || !hasValidDecisionChain(candidate.decisions)) {
    throw new ExperienceError('invalid_command', 'Candidate decisions must have unique IDs and valid field supersession')
  }
  if ((candidate.state === 'accepted' || candidate.state === 'published')
    && [...currentWorkflowDecisions(candidate).values()].some(decision => decision.decision === 'reject')) {
    throw new ExperienceError('invalid_command', 'accepted Candidate cannot have a current rejected field')
  }
  const terminalDisposition = candidate.state === 'rejected' || candidate.state === 'withdrawn'
  if (terminalDisposition !== (candidate.dispositionReason !== null)) {
    throw new ExperienceError('invalid_command', 'Candidate disposition reason does not match its state')
  }
  return candidate
}

function hasValidDecisionChain(decisions: readonly CandidateDecisionRecord[]): boolean {
  const latest = new Map<string, string>()
  for (const decision of decisions) {
    if (decision.supersedesDecisionId !== (latest.get(decision.field) ?? null)) return false
    latest.set(decision.field, decision.decisionId)
  }
  return true
}

function assertRevision(candidate: CandidateWorkflowRecord, expectedRevision: number): void {
  if (candidate.revision !== expectedRevision) {
    throw new ExperienceError('stale_revision', 'Candidate revision does not match', {
      expectedRevision,
      actualRevision: candidate.revision,
    })
  }
}

function validateComponent(component: ExperienceComponentInput, allowedRefs: ReadonlySet<string>, maxBytes: number): void {
  nonEmpty(component.componentKey, 'componentKey')
  nonEmpty(component.content, `component:${component.componentKey}`)
  if (component.sourceRefs.length === 0 || component.sourceRefs.some(ref => !allowedRefs.has(ref))) {
    throw new ExperienceError('source_unresolvable', 'each Candidate component requires resolvable sources', {
      componentKey: component.componentKey,
    })
  }
  assertInlineValue(component, maxBytes, `component:${component.componentKey}`)
}

function fieldStage(field: string, role: string | undefined): CandidateFieldView['stage'] {
  if (field === 'scope' || field === 'validity' || field === 'authoritySpec'
    || field === 'privacyClass' || field === 'riskAndEffectSpec' || field === 'allowedUseModes') {
    return 'scope_authority'
  }
  if (role === 'falsifier' || role === 'recovery_verifier') {
    return 'validation_safety'
  }
  return 'stable_kernel'
}

const SENSITIVE_REVIEW_FIELDS = new Set([
  'scope', 'authoritySpec', 'riskAndEffectSpec', 'privacyClass', 'allowedUseModes',
])

const CANDIDATE_REJECTION_REASONS = new Set<string>(CANDIDATE_REJECTION_REASON_CODES)

const CANDIDATE_WITHDRAWAL_REASONS = new Set([
  'user_withdrawn', 'source_selection_changed', 'proposal_replaced',
])

function componentValue(value: unknown, label: string): ExperienceComponentInput {
  if (!isRecord(value)
    || typeof value.componentKey !== 'string'
    || typeof value.role !== 'string'
    || typeof value.content !== 'string'
    || !isStringArray(value.sourceRefs)) {
    throw new ExperienceError('invalid_command', `${label} edit is not an Experience component`)
  }
  return value as unknown as ExperienceComponentInput
}

function experienceKindValue(value: unknown, expected: ExperienceKind): ExperienceKind {
  if (typeof value !== 'string' || !EXPERIENCE_KINDS.includes(value as ExperienceKind) || value !== expected) {
    throw new ExperienceError('wrong_experience_kind', 'Candidate kind is immutable; reject and create a new Candidate')
  }
  return value as ExperienceKind
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExperienceError('required_field_missing', `${field} must be a non-empty string`)
  }
  return value
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.values(value).some(item => typeof item !== 'string')) {
    throw new ExperienceError('invalid_command', `${field} must be a non-empty string record`)
  }
  return value as Record<string, string>
}

function privacyValue(value: unknown): ExperienceCandidateDraft['privacyClass'] {
  if (value !== 'public' && value !== 'workspace' && value !== 'restricted' && value !== 'secret_reference_only') {
    throw new ExperienceError('invalid_command', 'privacyClass is invalid')
  }
  return value
}

function useModes(value: unknown): ExperienceCandidateDraft['allowedUseModes'] {
  if (!Array.isArray(value) || value.some(item => item !== 'reference' && item !== 'suggest'
    && item !== 'guided' && item !== 'guarded_execute')) {
    throw new ExperienceError('invalid_command', 'allowedUseModes is invalid')
  }
  return value as ExperienceCandidateDraft['allowedUseModes']
}

function validateKindSpecificSemantics(draft: ExperienceCandidateDraft): void {
  const byRole = new Map(draft.components.map(component => [component.role, component.content.trim()] as const))
  if (draft.proposedKind === 'preference_policy') {
    const modality = byRole.get('modality')
    if (modality !== 'must' && modality !== 'must_not' && modality !== 'prefer' && modality !== 'avoid') {
      throw new ExperienceError('invalid_command', 'Preference modality must be must, must_not, prefer, or avoid')
    }
    const authority = byRole.get('authority_source') ?? ''
    if (/model[_ -]?inferred/iu.test(authority) && (modality === 'must' || modality === 'must_not')) {
      throw new ExperienceError('principal_unauthorized', 'model-inferred Preference cannot become mandatory or prohibitive')
    }
  }
  if (draft.proposedKind === 'causal') {
    const grade = byRole.get('causal_grade')
    if (grade === undefined || !isEvidenceGrade(grade)) {
      throw new ExperienceError('invalid_command', 'Causal causal_grade must use the evidence-grade vocabulary')
    }
    if (evidenceGradeRank(grade) > evidenceGradeRank(draft.evidenceGrade)) {
      throw new ExperienceError('invalid_command', 'Causal component grade exceeds source-supported evidence')
    }
    const allowedUse = byRole.get('allowed_use')
    if (allowedUse !== 'hypothesis' && allowedUse !== 'diagnostic_support'
      && allowedUse !== 'strategy_support' && allowedUse !== 'action_design_support') {
      throw new ExperienceError('invalid_command', 'Causal allowed_use is invalid')
    }
    if (evidenceGradeRank(grade) < evidenceGradeRank('intervention_supported')
      && allowedUse !== 'hypothesis' && allowedUse !== 'diagnostic_support') {
      throw new ExperienceError('invalid_command', 'Causal evidence below intervention support cannot guide strategy or action design')
    }
  }
}

function isEvidenceGrade(value: string): value is ExperienceCandidateDraft['evidenceGrade'] {
  return value === 'model_asserted' || value === 'observation_supported' || value === 'mechanism_supported'
    || value === 'intervention_supported' || value === 'counterfactual_supported'
}

function evidenceGradeRank(value: ExperienceCandidateDraft['evidenceGrade']): number {
  switch (value) {
    case 'model_asserted': return 0
    case 'observation_supported': return 1
    case 'mechanism_supported': return 2
    case 'intervention_supported': return 3
    case 'counterfactual_supported': return 4
  }
}

function nonEmpty(value: string, field: string): void {
  if (value.trim() === '') throw new ExperienceError('required_field_missing', `${field} must not be empty`)
  assertSafeText(value, field)
}

function nonEmptyRecord(value: Readonly<Record<string, string>>, field: string): void {
  if (Object.keys(value).length === 0 || Object.values(value).some(item => item.trim() === '')) {
    throw new ExperienceError('required_field_missing', `${field} must contain non-empty string values`)
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const l = [...left].sort()
  const r = [...right].sort()
  return l.every((value, index) => value === r[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
