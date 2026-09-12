import { ExperienceError } from '../errors.js'
import { isAbsolute } from 'node:path'
import { brandedId } from '../ids.js'
import { isExperienceKind } from '../domain/kind.js'
import type {
  CandidateCommandInput,
  CandidateDispositionInput,
  DecideCandidateFieldInput,
  EpisodeLocatorInput,
  ProposalOutputTokenLimitInput,
  ProposalSourceInspectionInput,
  ProposeCandidateInput,
  PlanTaskCommandInput,
  DecidePlanCommandInput,
  PlanningTaskInput,
  ProgressUsageInput,
  VerifyUsageInput,
  SettleUsageInput,
  ProposeRevisionInput,
  DecideRevisionChangeInput,
  PublishRevisionInput,
  ForgetExperienceInput,
  DeclareExperienceRelationInput,
  CreateOverrideDecisionInput,
  ChangeAutomationLevelInput,
  EvaluateUnlockContractInput,
  AuditQueryInput,
  ExportMarkdownInput,
  ProposeMarkdownRevisionInput,
  EvaluateInfrastructureReadinessInput,
  RecordEvaluationObservationInput,
  RankHistoryRankingInput,
  LearningSourceRefView,
  EvaluationExecutionEvidence,
  DismissExperienceSuggestionInput,
  SaveExperienceSuggestionInput,
} from '../types.js'
import { EXPERIENCE_RELATION_OBJECT_KINDS, EXPERIENCE_RELATION_TYPES, LEARNING_CAPABILITIES, HISTORY_RANKING_CAPABILITY } from '../types.js'
const EPISODE_KEYS = new Set(['sessionId', 'eventStart', 'eventEnd', 'contentDigest'])
const PROPOSE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'episode', 'eligibilityDigest',
  'requestedKind', 'outputTokenLimit', 'proposalDisclosureDigest', 'confirmedMaxOutputTokens', 'confirmExternalModelProcessing',
])
const OUTPUT_TOKEN_LIMIT_KEYS = new Set(['mode', 'maxTokens'])
const CANDIDATE_COMMAND_KEYS = new Set([
  'commandId', 'candidateId', 'expectedRevision', 'correlationId', 'causationId', 'issuedAt',
])
const FIELD_DECISION_KEYS = new Set([
  ...CANDIDATE_COMMAND_KEYS, 'field', 'decision', 'value', 'effectiveSourceRefs', 'reason',
])
const CANDIDATE_DISPOSITION_KEYS = new Set([...CANDIDATE_COMMAND_KEYS, 'reasonCode'])
const SUGGESTION_DISMISS_KEYS = new Set([
  'commandId', 'suggestionGroupId', 'expectedRevisionDigest', 'reviewDigest', 'reasonCode', 'issuedAt',
])
const SUGGESTION_SAVE_KEYS = new Set([
  'commandId', 'suggestionGroupId', 'expectedRevisionDigest', 'reviewDigest', 'sourceDigest',
  'ownerChoice', 'correlationId', 'causationId', 'issuedAt',
])
const SUGGESTION_OWNER_CHOICE_KEYS = new Set([
  'choice', 'targetExperienceVersionId', 'materialDifferences',
])
const SUGGESTION_MATERIAL_DIFFERENCE_KEYS = new Set([
  'facet', 'incomingComponentKey', 'targetComponentRevisionId',
  'incomingContentDigest', 'targetContentDigest', 'reasonCode',
])
const SUGGESTION_DISMISS_REASONS = new Set([
  'not_reusable', 'one_off_task', 'incorrect_abstraction', 'privacy_choice',
])
const TRIGGER_KINDS = new Set([
  'terminal_success', 'high_cost_resolution', 'repeated_kernel', 'user_correction',
  'diagnostic_exclusion', 'environment_invalidation', 'outcome_unknown',
])
const PLAN_TASK_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'sessionId', 'interaction',
  'confirmExternalModelProcessing', 'task',
])
const PLANNING_TASK_KEYS = new Set([
  'text', 'workspaceRoot', 'targetExposure', 'mustUseExperience', 'riskClass', 'requiredCapabilities',
  'requestedUseMode', 'overrideDecisionIds',
])
const PLAN_DECISION_KEYS = new Set([
  'commandId', 'requestId', 'usagePlanId', 'expectedPlanRevision', 'decision', 'reason',
  'correlationId', 'causationId', 'issuedAt',
])
const USAGE_PROGRESS_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt',
  'usageId', 'expectedControllerRevision', 'action', 'targetStepRef', 'branchRef', 'checkpointRef', 'reason',
])
const USAGE_VERIFY_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'usageId', 'expectedControllerRevision',
])
const USAGE_SETTLE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt',
  'usageId', 'expectedControllerRevision', 'verificationRunId',
])
const REVISION_PROPOSE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'usageId', 'baseVersionId',
])
const REVISION_DECIDE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt',
  'revisionProposalId', 'expectedRevision', 'revisionChangeId', 'decision', 'reason',
])
const REVISION_PUBLISH_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'revisionProposalId', 'expectedRevision',
])
const FORGET_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'experienceId',
  'expectedSeriesRevision', 'previewDigest', 'reason',
])
const RELATION_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'relationType',
  'sourceObjectRef', 'targetObjectRef', 'scope', 'qualifiers', 'validFrom', 'validTo', 'evidenceIds',
])
const RELATION_REF_KEYS = new Set(['kind', 'id'])
const OVERRIDE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'targetRelationId',
  'replacementInstruction', 'exactScope', 'validUntil', 'reason',
])
const LEARNING_EVALUATE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'capability',
])
const AUTOMATION_CHANGE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'capability', 'action',
  'targetLevel', 'evaluationId', 'reason', 'violationClass',
])
const RANKING_REVIEW_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'predictionId',
  'rankingDigest', 'preferredOrder', 'reason', 'evidenceRefs',
])
const SOURCE_REF_KEYS = new Set(['kind', 'id', 'digest'])
const AUDIT_QUERY_KEYS = new Set(['subject', 'asOfRecordedAt', 'cursor', 'limit'])
const AUDIT_SUBJECT_KEYS = new Set(['kind', 'id'])
const MARKDOWN_EXPORT_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'experienceVersionId',
])
const MARKDOWN_IMPORT_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt',
  'markdownProjectionReceiptId', 'editedMarkdown', 'editedMarkdownDigest',
])
const INFRASTRUCTURE_EVALUATE_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt',
])
const EVALUATION_RECORD_KEYS = new Set([
  'commandId', 'correlationId', 'causationId', 'issuedAt', 'observation',
])
const EVALUATION_OBSERVATION_KEYS = new Set([
  'cohortId', 'comparisonArm', 'taskCaseId', 'taskFamilyId', 'taskFingerprintId', 'usageId',
  'settlementId', 'split', 'taskOccurredAt', 'trainingWindowEndsAt', 'trainingEpisodeRefs',
  'modelVersion', 'toolsetVersion', 'contextBudget', 'verifierVersion', 'taskCorpusVersion',
  'outcome', 'acceptanceResultRefs', 'decisionAnchorRefs', 'routeSignature', 'elapsedMs',
  'modelRoundCount', 'toolCallCount', 'inputTokens', 'outputTokens', 'humanActionCount',
  'repeatedExplorationCount', 'erroneousSideEffectCount', 'retrievalResult',
  'erroneousReuse', 'applicabilityDecision', 'pollutionIncident', 'explanationCoverage', 'metricSourceRefs',
  'executionEvidence',
])
const SETTLED_EVIDENCE_KEYS = new Set(['kind'])
const NOT_USED_EVIDENCE_KEYS = new Set(['kind', 'usagePlanId', 'planDigest', 'admissionAttemptId', 'reason', 'outcomeSource'])

/** Decode one exact terminal Episode locator. */
export function parseEpisodeLocatorInput(value: unknown): EpisodeLocatorInput {
  const input = exactRecord(
    value,
    EPISODE_KEYS,
    'Episode locator',
    new Set(['eventStart', 'eventEnd', 'contentDigest']),
  )
  const eventStart = optionalNonNegativeInteger(input.eventStart, 'eventStart')
  const eventEnd = optionalNonNegativeInteger(input.eventEnd, 'eventEnd')
  if (eventStart !== undefined && eventEnd !== undefined && eventEnd < eventStart) {
    throw new ExperienceError('invalid_command', 'eventEnd must not precede eventStart')
  }
  const contentDigest = optionalString(input.contentDigest, 'contentDigest')
  return {
    sessionId: requiredString(input.sessionId, 'sessionId'),
    ...(eventStart === undefined ? {} : { eventStart }),
    ...(eventEnd === undefined ? {} : { eventEnd }),
    ...(contentDigest === undefined ? {} : { contentDigest }),
  }
}

/** Decode one local inspection request and its disclosure-bound token policy. */
export function parseProposalSourceInspectionInput(value: unknown): ProposalSourceInspectionInput {
  const input = exactRecord(
    value,
    new Set(['episode', 'requestedKind', 'outputTokenLimit', 'requestedTriggerKind']),
    'Proposal source inspection',
  )
  const requestedTriggerKind = requiredString(input.requestedTriggerKind, 'requestedTriggerKind')
  if (!TRIGGER_KINDS.has(requestedTriggerKind)) {
    throw new ExperienceError('invalid_command', 'requestedTriggerKind is not recognized')
  }
  return {
    episode: parseEpisodeLocatorInput(input.episode),
    requestedKind: experienceKind(input.requestedKind),
    outputTokenLimit: parseProposalOutputTokenLimitInput(input.outputTokenLimit),
    requestedTriggerKind: requestedTriggerKind as ProposalSourceInspectionInput['requestedTriggerKind'],
  }
}

/** Decode a configured-default, provider-default, or bounded custom output limit. */
export function parseProposalOutputTokenLimitInput(value: unknown): ProposalOutputTokenLimitInput {
  const input = exactRecord(value, OUTPUT_TOKEN_LIMIT_KEYS, 'Proposal output-token limit', new Set(['maxTokens']))
  const mode = requiredString(input.mode, 'outputTokenLimit.mode')
  if (mode === 'configured_default' || mode === 'provider_default') {
    if (Object.hasOwn(input, 'maxTokens')) {
      throw new ExperienceError('invalid_command', `${mode} output-token limit must not include maxTokens`)
    }
    return { mode }
  }
  if (mode !== 'custom') {
    throw new ExperienceError('invalid_command', 'outputTokenLimit.mode is not recognized')
  }
  if (!Number.isSafeInteger(input.maxTokens)
    || (input.maxTokens as number) < 1_024
    || (input.maxTokens as number) > 32_768) {
    throw new ExperienceError('invalid_command', 'custom outputTokenLimit.maxTokens must be an integer from 1024 through 32768')
  }
  return { mode, maxTokens: input.maxTokens as number }
}

/** Decode one disclosure-confirmed Candidate proposal command. */
export function parseProposeCandidateInput(value: unknown): ProposeCandidateInput {
  const input = exactRecord(value, PROPOSE_KEYS, 'Candidate proposal input')
  if (input.confirmExternalModelProcessing !== true) {
    throw new ExperienceError(
      'sensitive_content_unauthorized',
      'confirmExternalModelProcessing must be true for the disclosed input',
    )
  }
  return {
    ...parseCommandEnvelope(input),
    episode: parseEpisodeLocatorInput(input.episode),
    requestedKind: experienceKind(input.requestedKind),
    outputTokenLimit: parseProposalOutputTokenLimitInput(input.outputTokenLimit),
    eligibilityDigest: requiredString(input.eligibilityDigest, 'eligibilityDigest'),
    proposalDisclosureDigest: requiredString(input.proposalDisclosureDigest, 'proposalDisclosureDigest'),
    confirmedMaxOutputTokens: nullablePositiveInteger(input.confirmedMaxOutputTokens, 'confirmedMaxOutputTokens'),
    confirmExternalModelProcessing: true,
  }
}

function experienceKind(value: unknown): import('../domain/kind.js').ExperienceKind {
  if (!isExperienceKind(value)) throw new ExperienceError('invalid_command', 'requestedKind is not recognized')
  return value
}

/** Decode one optimistic Candidate state transition. */
export function parseCandidateCommandInput(value: unknown): CandidateCommandInput {
  const input = exactRecord(value, CANDIDATE_COMMAND_KEYS, 'Candidate command input')
  return parseCandidateCommandRecord(input)
}

/** Decode one exact Candidate field decision. */
export function parseDecideCandidateFieldInput(value: unknown): DecideCandidateFieldInput {
  const input = exactRecord(
    value,
    FIELD_DECISION_KEYS,
    'Candidate field decision',
    new Set(['value', 'effectiveSourceRefs']),
  )
  const decision = requiredString(input.decision, 'decision')
  if (decision !== 'accept' && decision !== 'reject' && decision !== 'edit') {
    throw new ExperienceError('invalid_command', 'decision is not recognized')
  }
  if (decision === 'edit' && !Object.hasOwn(input, 'value')) {
    throw new ExperienceError('required_field_missing', 'an edit decision requires value')
  }
  if (decision !== 'edit' && Object.hasOwn(input, 'value')) {
    throw new ExperienceError('invalid_command', 'only an edit decision may include value')
  }
  const effectiveSourceRefs = input.effectiveSourceRefs === undefined
    ? undefined
    : stringArray(input.effectiveSourceRefs, 'effectiveSourceRefs')
  if (decision === 'edit' && (effectiveSourceRefs === undefined || effectiveSourceRefs.length === 0)) {
    throw new ExperienceError('required_field_missing', 'an edit decision requires effectiveSourceRefs')
  }
  if (decision !== 'edit' && effectiveSourceRefs !== undefined) {
    throw new ExperienceError('invalid_command', 'only an edit decision may include effectiveSourceRefs')
  }
  return {
    ...parseCandidateCommandRecord(input),
    field: requiredString(input.field, 'field'),
    decision,
    ...(decision === 'edit' ? { value: input.value } : {}),
    ...(effectiveSourceRefs === undefined ? {} : { effectiveSourceRefs }),
    reason: requiredString(input.reason, 'reason'),
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new ExperienceError('invalid_command', `${field} must be an array of non-empty strings`)
  }
  if (new Set(value).size !== value.length) {
    throw new ExperienceError('invalid_command', `${field} must not contain duplicates`)
  }
  return value
}

/** Decode one terminal Candidate rejection or withdrawal command. */
export function parseCandidateDispositionInput(value: unknown): CandidateDispositionInput {
  const input = exactRecord(value, CANDIDATE_DISPOSITION_KEYS, 'Candidate disposition input')
  return {
    ...parseCandidateCommandRecord(input),
    reasonCode: requiredString(input.reasonCode, 'reasonCode'),
  }
}

/** Decode one exact, short-lived owner suppression decision. */
export function parseDismissExperienceSuggestionInput(value: unknown): DismissExperienceSuggestionInput {
  const input = exactRecord(value, SUGGESTION_DISMISS_KEYS, 'Suggestion dismissal input')
  const reasonCode = requiredString(input.reasonCode, 'reasonCode')
  if (!SUGGESTION_DISMISS_REASONS.has(reasonCode)) {
    throw new ExperienceError('invalid_command', 'suggestion dismissal reason is not recognized')
  }
  return {
    commandId: requiredString(input.commandId, 'commandId'),
    suggestionGroupId: requiredString(input.suggestionGroupId, 'suggestionGroupId'),
    expectedRevisionDigest: requiredSha256(input.expectedRevisionDigest, 'expectedRevisionDigest'),
    reviewDigest: input.reviewDigest === null ? null : requiredSha256(input.reviewDigest, 'reviewDigest'),
    reasonCode: reasonCode as DismissExperienceSuggestionInput['reasonCode'],
    issuedAt: dateTime(input.issuedAt, 'issuedAt'),
  }
}

/** Decode one exact owner save over an immutable suggestion snapshot. */
export function parseSaveExperienceSuggestionInput(value: unknown): SaveExperienceSuggestionInput {
  const input = exactRecord(value, SUGGESTION_SAVE_KEYS, 'Suggestion save input', new Set(['ownerChoice']))
  const ownerChoice = input.ownerChoice === undefined
    ? undefined : parseSuggestionOwnerChoice(input.ownerChoice)
  return {
    commandId: brandedId<'ExperienceCommandId'>(requiredString(input.commandId, 'commandId'), 'commandId'),
    suggestionGroupId: requiredString(input.suggestionGroupId, 'suggestionGroupId'),
    expectedRevisionDigest: requiredSha256(input.expectedRevisionDigest, 'expectedRevisionDigest'),
    reviewDigest: requiredSha256(input.reviewDigest, 'reviewDigest'),
    sourceDigest: requiredSha256(input.sourceDigest, 'sourceDigest'),
    ...(ownerChoice === undefined ? {} : { ownerChoice }),
    correlationId: requiredString(input.correlationId, 'correlationId'),
    causationId: nullableString(input.causationId, 'causationId'),
    issuedAt: dateTime(input.issuedAt, 'issuedAt'),
  }
}

function parseSuggestionOwnerChoice(value: unknown): NonNullable<SaveExperienceSuggestionInput['ownerChoice']> {
  const input = exactRecord(value, SUGGESTION_OWNER_CHOICE_KEYS, 'Suggestion owner choice')
  const choice = requiredString(input.choice, 'ownerChoice.choice')
  if (choice !== 'attach_existing' && choice !== 'keep_distinct') {
    throw new ExperienceError('invalid_command', 'ownerChoice.choice is not recognized')
  }
  if (!Array.isArray(input.materialDifferences) || input.materialDifferences.length > 32) {
    throw new ExperienceError('invalid_command', 'ownerChoice.materialDifferences must be a bounded array')
  }
  const facets = new Set(['scope', 'condition', 'action', 'outcome', 'value', 'authority', 'verifier'])
  return {
    choice,
    targetExperienceVersionId: brandedId<'ExperienceVersionId'>(
      requiredString(input.targetExperienceVersionId, 'ownerChoice.targetExperienceVersionId'),
      'ownerChoice.targetExperienceVersionId',
    ),
    materialDifferences: input.materialDifferences.map((value, index) => {
      const difference = exactRecord(value, SUGGESTION_MATERIAL_DIFFERENCE_KEYS, 'Suggestion material difference')
      const facet = requiredString(difference.facet, `ownerChoice.materialDifferences[${String(index)}].facet`)
      if (!facets.has(facet)) {
        throw new ExperienceError('invalid_command', 'Suggestion material difference facet is not recognized')
      }
      return {
        facet: facet as NonNullable<SaveExperienceSuggestionInput['ownerChoice']>['materialDifferences'][number]['facet'],
        incomingComponentKey: requiredString(difference.incomingComponentKey, 'incomingComponentKey'),
        targetComponentRevisionId: requiredString(difference.targetComponentRevisionId, 'targetComponentRevisionId'),
        incomingContentDigest: requiredSha256(difference.incomingContentDigest, 'incomingContentDigest'),
        targetContentDigest: requiredSha256(difference.targetContentDigest, 'targetContentDigest'),
        reasonCode: requiredString(difference.reasonCode, 'reasonCode'),
      }
    }),
  }
}

/** Decode one exact M3 task planning command. */
export function parsePlanTaskCommandInput(value: unknown): PlanTaskCommandInput {
  const input = exactRecord(value, PLAN_TASK_KEYS, 'Plan task command')
  const interaction = requiredString(input.interaction, 'interaction')
  if (interaction !== 'ask_current_agent' && interaction !== 'defer') {
    throw new ExperienceError('invalid_command', 'interaction is not recognized')
  }
  return {
    ...parseCommandEnvelope(input),
    sessionId: nullableString(input.sessionId, 'sessionId'),
    interaction,
    confirmExternalModelProcessing: requiredBoolean(
      input.confirmExternalModelProcessing,
      'confirmExternalModelProcessing',
    ),
    task: parsePlanningTaskInput(input.task),
  }
}

/** Decode explicit task facts; no actor, authority, or inferred eligibility is accepted. */
export function parsePlanningTaskInput(value: unknown): PlanningTaskInput {
  const input = exactRecord(value, PLANNING_TASK_KEYS, 'Planning task input')
  const exposure = requiredString(input.targetExposure, 'targetExposure')
  if (exposure !== 'local' && exposure !== 'public') {
    throw new ExperienceError('invalid_command', 'targetExposure is not recognized')
  }
  const riskClass = requiredString(input.riskClass, 'riskClass')
  if (riskClass !== 'standard' && riskClass !== 'medium' && riskClass !== 'high') {
    throw new ExperienceError('invalid_command', 'riskClass is not recognized')
  }
  if (typeof input.mustUseExperience !== 'boolean') {
    throw new ExperienceError('invalid_command', 'mustUseExperience must be boolean')
  }
  return {
    text: requiredString(input.text, 'task.text'),
    workspaceRoot: nullableAbsoluteString(input.workspaceRoot, 'workspaceRoot'),
    targetExposure: exposure,
    mustUseExperience: input.mustUseExperience,
    riskClass,
    requiredCapabilities: stringArray(input.requiredCapabilities, 'requiredCapabilities'),
    requestedUseMode: planningUseMode(input.requestedUseMode),
    overrideDecisionIds: stringArray(input.overrideDecisionIds, 'overrideDecisionIds').map(value =>
      brandedId<'ExperienceOverrideDecisionId'>(value, 'overrideDecisionId')),
  }
}

function planningUseMode(value: unknown): PlanningTaskInput['requestedUseMode'] {
  if (value !== 'suggest' && value !== 'guided') {
    throw new ExperienceError('invalid_command', 'requestedUseMode must be suggest or guided')
  }
  return value
}

/** Decode one exact plan approval, refusal, or withdrawal. */
export function parseDecidePlanCommandInput(value: unknown): DecidePlanCommandInput {
  const input = exactRecord(value, PLAN_DECISION_KEYS, 'Plan decision command')
  const decision = requiredString(input.decision, 'decision')
  if (decision !== 'approve' && decision !== 'deny' && decision !== 'withdraw') {
    throw new ExperienceError('invalid_command', 'plan decision is not recognized')
  }
  if (!Number.isSafeInteger(input.expectedPlanRevision) || (input.expectedPlanRevision as number) < 1) {
    throw new ExperienceError('invalid_command', 'expectedPlanRevision must be a positive safe integer')
  }
  return {
    ...parseCommandEnvelope(input),
    requestId: brandedId<'ExperiencePlanApprovalRequestId'>(requiredString(input.requestId, 'requestId'), 'requestId'),
    usagePlanId: brandedId<'ExperienceUsagePlanId'>(requiredString(input.usagePlanId, 'usagePlanId'), 'usagePlanId'),
    expectedPlanRevision: input.expectedPlanRevision as number,
    decision,
    reason: requiredString(input.reason, 'reason'),
  }
}

/** Decode one explicit StepProgress transition. */
export function parseProgressUsageInput(value: unknown): ProgressUsageInput {
  const input = exactRecord(value, USAGE_PROGRESS_KEYS, 'Usage progress input',
    new Set(['targetStepRef', 'branchRef', 'checkpointRef']))
  const action = requiredString(input.action, 'action')
  if (!['advance', 'deviate', 'pause', 'resume', 'abort'].includes(action)) {
    throw new ExperienceError('invalid_command', 'Usage progress action is not recognized')
  }
  return {
    ...parseCommandEnvelope(input),
    usageId: brandedId<'ExperienceUsageId'>(requiredString(input.usageId, 'usageId'), 'usageId'),
    expectedControllerRevision: positiveInteger(input.expectedControllerRevision, 'expectedControllerRevision'),
    action: action as ProgressUsageInput['action'],
    ...(input.targetStepRef === undefined ? {} : { targetStepRef: requiredString(input.targetStepRef, 'targetStepRef') }),
    ...(input.branchRef === undefined ? {} : { branchRef: requiredString(input.branchRef, 'branchRef') }),
    ...(input.checkpointRef === undefined ? {} : { checkpointRef: requiredString(input.checkpointRef, 'checkpointRef') }),
    reason: requiredString(input.reason, 'reason'),
  }
}

/** Decode one current-authority verification request. */
export function parseVerifyUsageInput(value: unknown): VerifyUsageInput {
  const input = exactRecord(value, USAGE_VERIFY_KEYS, 'Usage verification input')
  return {
    ...parseCommandEnvelope(input),
    usageId: brandedId<'ExperienceUsageId'>(requiredString(input.usageId, 'usageId'), 'usageId'),
    expectedControllerRevision: positiveInteger(input.expectedControllerRevision, 'expectedControllerRevision'),
  }
}

/** Decode one criterion-backed Settlement request. */
export function parseSettleUsageInput(value: unknown): SettleUsageInput {
  const input = exactRecord(value, USAGE_SETTLE_KEYS, 'Usage settlement input')
  return {
    ...parseCommandEnvelope(input),
    usageId: brandedId<'ExperienceUsageId'>(requiredString(input.usageId, 'usageId'), 'usageId'),
    expectedControllerRevision: positiveInteger(input.expectedControllerRevision, 'expectedControllerRevision'),
    verificationRunId: brandedId<'ExperienceVerificationRunId'>(
      requiredString(input.verificationRunId, 'verificationRunId'), 'verificationRunId'),
  }
}

/** Decode one deterministic minimal RevisionProposal request. */
export function parseProposeRevisionInput(value: unknown): ProposeRevisionInput {
  const input = exactRecord(value, REVISION_PROPOSE_KEYS, 'Revision proposal input')
  return {
    ...parseCommandEnvelope(input),
    usageId: brandedId<'ExperienceUsageId'>(requiredString(input.usageId, 'usageId'), 'usageId'),
    baseVersionId: brandedId<'ExperienceVersionId'>(requiredString(input.baseVersionId, 'baseVersionId'), 'baseVersionId'),
  }
}

/** Decode one exact RevisionProposal field decision. */
export function parseDecideRevisionChangeInput(value: unknown): DecideRevisionChangeInput {
  const input = exactRecord(value, REVISION_DECIDE_KEYS, 'Revision change decision input')
  const decision = requiredString(input.decision, 'decision')
  if (decision !== 'accept' && decision !== 'reject') {
    throw new ExperienceError('invalid_command', 'Revision change decision is not recognized')
  }
  return {
    ...parseCommandEnvelope(input),
    revisionProposalId: brandedId<'ExperienceRevisionProposalId'>(
      requiredString(input.revisionProposalId, 'revisionProposalId'), 'revisionProposalId'),
    expectedRevision: positiveInteger(input.expectedRevision, 'expectedRevision'),
    revisionChangeId: requiredString(input.revisionChangeId, 'revisionChangeId'),
    decision,
    reason: requiredString(input.reason, 'reason'),
  }
}

/** Decode one exact accepted RevisionProposal publication request. */
export function parsePublishRevisionInput(value: unknown): PublishRevisionInput {
  const input = exactRecord(value, REVISION_PUBLISH_KEYS, 'Revision publication input')
  return {
    ...parseCommandEnvelope(input),
    revisionProposalId: brandedId<'ExperienceRevisionProposalId'>(
      requiredString(input.revisionProposalId, 'revisionProposalId'), 'revisionProposalId'),
    expectedRevision: positiveInteger(input.expectedRevision, 'expectedRevision'),
  }
}

/** Decode one immutable-Version Markdown export command. */
export function parseExportMarkdownInput(value: unknown): ExportMarkdownInput {
  const input = exactRecord(value, MARKDOWN_EXPORT_KEYS, 'Markdown export input')
  return {
    ...parseCommandEnvelope(input),
    experienceVersionId: brandedId<'ExperienceVersionId'>(
      requiredString(input.experienceVersionId, 'experienceVersionId'), 'experienceVersionId'),
  }
}

/** Decode one receipt-bound edited Markdown import command. */
export function parseProposeMarkdownRevisionInput(value: unknown): ProposeMarkdownRevisionInput {
  const input = exactRecord(value, MARKDOWN_IMPORT_KEYS, 'Markdown revision input')
  return {
    ...parseCommandEnvelope(input),
    markdownProjectionReceiptId: brandedId<'ExperienceMarkdownProjectionReceiptId'>(
      requiredString(input.markdownProjectionReceiptId, 'markdownProjectionReceiptId'),
      'markdownProjectionReceiptId',
    ),
    editedMarkdown: requiredString(input.editedMarkdown, 'editedMarkdown'),
    editedMarkdownDigest: requiredSha256(input.editedMarkdownDigest, 'editedMarkdownDigest'),
  }
}

/** Decode one explicit current-workload graph-storage readiness evaluation. */
export function parseEvaluateInfrastructureReadinessInput(value: unknown): EvaluateInfrastructureReadinessInput {
  const input = exactRecord(value, INFRASTRUCTURE_EVALUATE_KEYS, 'Infrastructure readiness input')
  return parseCommandEnvelope(input)
}

/** Decode one strict frozen-corpus evaluation observation. */
export function parseRecordEvaluationObservationInput(value: unknown): RecordEvaluationObservationInput {
  const input = exactRecord(value, EVALUATION_RECORD_KEYS, 'Evaluation observation command')
  const item = exactRecord(input.observation, EVALUATION_OBSERVATION_KEYS, 'Evaluation observation',
    new Set(['executionEvidence']))
  const comparisonArm = requiredString(item.comparisonArm, 'comparisonArm')
  if (!['no_memory', 'retrieval_only', 'experience_map'].includes(comparisonArm)) {
    throw new ExperienceError('invalid_command', 'comparisonArm is not recognized')
  }
  const outcome = requiredString(item.outcome, 'outcome')
  if (!['success', 'failure', 'unknown'].includes(outcome)) {
    throw new ExperienceError('invalid_command', 'outcome is not recognized')
  }
  const retrievalResult = requiredString(item.retrievalResult, 'retrievalResult')
  if (!['not_applicable', 'none', 'relevant', 'irrelevant'].includes(retrievalResult)) {
    throw new ExperienceError('invalid_command', 'retrievalResult is not recognized')
  }
  const applicabilityDecision = requiredString(item.applicabilityDecision, 'applicabilityDecision')
  if (!['not_applicable', 'use', 'refuse', 'adapt', 'unknown'].includes(applicabilityDecision)) {
    throw new ExperienceError('invalid_command', 'applicabilityDecision is not recognized')
  }
  const taskFingerprintId = nullableString(item.taskFingerprintId, 'taskFingerprintId')
  const usageId = nullableString(item.usageId, 'usageId')
  const settlementId = nullableString(item.settlementId, 'settlementId')
  const split = requiredString(item.split, 'split')
  if (split !== 'test') throw new ExperienceError('invalid_command', 'split must be test')
  return {
    ...parseCommandEnvelope(input),
    observation: {
      cohortId: requiredString(item.cohortId, 'cohortId'),
      comparisonArm: comparisonArm as RecordEvaluationObservationInput['observation']['comparisonArm'],
      taskCaseId: requiredString(item.taskCaseId, 'taskCaseId'),
      taskFamilyId: requiredString(item.taskFamilyId, 'taskFamilyId'),
      taskFingerprintId: taskFingerprintId === null ? null
        : brandedId<'ExperienceTaskFingerprintId'>(taskFingerprintId, 'taskFingerprintId'),
      usageId: usageId === null ? null : brandedId<'ExperienceUsageId'>(usageId, 'usageId'),
      settlementId: settlementId === null ? null
        : brandedId<'ExperienceSettlementId'>(settlementId, 'settlementId'),
      split,
      taskOccurredAt: dateTime(item.taskOccurredAt, 'taskOccurredAt'),
      trainingWindowEndsAt: dateTime(item.trainingWindowEndsAt, 'trainingWindowEndsAt'),
      trainingEpisodeRefs: stringArray(item.trainingEpisodeRefs, 'trainingEpisodeRefs'),
      modelVersion: requiredString(item.modelVersion, 'modelVersion'),
      toolsetVersion: requiredString(item.toolsetVersion, 'toolsetVersion'),
      contextBudget: nonNegativeInteger(item.contextBudget, 'contextBudget'),
      verifierVersion: requiredString(item.verifierVersion, 'verifierVersion'),
      taskCorpusVersion: requiredString(item.taskCorpusVersion, 'taskCorpusVersion'),
      outcome: outcome as RecordEvaluationObservationInput['observation']['outcome'],
      acceptanceResultRefs: stringArray(item.acceptanceResultRefs, 'acceptanceResultRefs'),
      decisionAnchorRefs: stringArray(item.decisionAnchorRefs, 'decisionAnchorRefs'),
      routeSignature: requiredString(item.routeSignature, 'routeSignature'),
      elapsedMs: nonNegativeInteger(item.elapsedMs, 'elapsedMs'),
      modelRoundCount: nonNegativeInteger(item.modelRoundCount, 'modelRoundCount'),
      toolCallCount: nonNegativeInteger(item.toolCallCount, 'toolCallCount'),
      inputTokens: nonNegativeInteger(item.inputTokens, 'inputTokens'),
      outputTokens: nonNegativeInteger(item.outputTokens, 'outputTokens'),
      humanActionCount: nonNegativeInteger(item.humanActionCount, 'humanActionCount'),
      repeatedExplorationCount: nonNegativeInteger(item.repeatedExplorationCount, 'repeatedExplorationCount'),
      erroneousSideEffectCount: nonNegativeInteger(item.erroneousSideEffectCount, 'erroneousSideEffectCount'),
      erroneousReuse: requiredBoolean(item.erroneousReuse, 'erroneousReuse'),
      retrievalResult: retrievalResult as RecordEvaluationObservationInput['observation']['retrievalResult'],
      applicabilityDecision: applicabilityDecision as RecordEvaluationObservationInput['observation']['applicabilityDecision'],
      pollutionIncident: requiredBoolean(item.pollutionIncident, 'pollutionIncident'),
      explanationCoverage: boundedFraction(item.explanationCoverage, 'explanationCoverage'),
      metricSourceRefs: stringArray(item.metricSourceRefs, 'metricSourceRefs'),
      ...(item.executionEvidence === undefined ? {}
        : { executionEvidence: parseEvaluationExecutionEvidence(item.executionEvidence) }),
    },
  }
}

/** Decode the optional discriminated execution evidence for one arm observation. */
function parseEvaluationExecutionEvidence(value: unknown): EvaluationExecutionEvidence {
  if (!isRecord(value)) {
    throw new ExperienceError('invalid_command', 'Evaluation execution evidence must be an object')
  }
  const kind = requiredString(value.kind, 'kind')
  if (kind === 'settled') {
    exactRecord(value, SETTLED_EVIDENCE_KEYS, 'Evaluation execution evidence')
    return { kind: 'settled' }
  }
  if (kind !== 'not_used') {
    throw new ExperienceError('invalid_command', 'executionEvidence kind is not recognized')
  }
  const item = exactRecord(value, NOT_USED_EVIDENCE_KEYS, 'Evaluation execution evidence')
  const reason = requiredString(item.reason, 'reason')
  if (!['no_match', 'refused', 'not_used'].includes(reason)) {
    throw new ExperienceError('invalid_command', 'executionEvidence reason is not recognized')
  }
  const outcomeSource = requiredString(item.outcomeSource, 'outcomeSource')
  if (outcomeSource !== 'external_verifier') {
    throw new ExperienceError('invalid_command', 'not_used outcomeSource must be external_verifier')
  }
  return {
    kind: 'not_used',
    usagePlanId: brandedId<'ExperienceUsagePlanId'>(requiredString(item.usagePlanId, 'usagePlanId'), 'usagePlanId'),
    planDigest: requiredString(item.planDigest, 'planDigest'),
    admissionAttemptId: brandedId<'ExperienceAdmissionAttemptId'>(
      requiredString(item.admissionAttemptId, 'admissionAttemptId'), 'admissionAttemptId'),
    reason: reason as Extract<EvaluationExecutionEvidence, { kind: 'not_used' }>['reason'],
    outcomeSource: 'external_verifier' as const,
  }
}

/** Decode one impact-bound owner command that stops future Experience recall. */
export function parseForgetExperienceInput(value: unknown): ForgetExperienceInput {
  const input = exactRecord(value, FORGET_KEYS, 'Experience Forget input')
  return {
    ...parseCommandEnvelope(input),
    experienceId: brandedId<'ExperienceId'>(requiredString(input.experienceId, 'experienceId'), 'experienceId'),
    expectedSeriesRevision: positiveInteger(input.expectedSeriesRevision, 'expectedSeriesRevision'),
    previewDigest: requiredSha256(input.previewDigest, 'previewDigest'),
    reason: requiredString(input.reason, 'reason'),
  }
}

/** Decode one source-bound canonical Experience relation declaration. */
export function parseDeclareExperienceRelationInput(value: unknown): DeclareExperienceRelationInput {
  const input = exactRecord(value, RELATION_KEYS, 'Experience relation input')
  const relationType = requiredString(input.relationType, 'relationType')
  if (!(EXPERIENCE_RELATION_TYPES as readonly string[]).includes(relationType)) {
    throw new ExperienceError('invalid_command', 'relationType is not recognized')
  }
  return {
    ...parseCommandEnvelope(input),
    relationType: relationType as DeclareExperienceRelationInput['relationType'],
    sourceObjectRef: parseExperienceRelationObjectRef(input.sourceObjectRef, 'sourceObjectRef'),
    targetObjectRef: parseExperienceRelationObjectRef(input.targetObjectRef, 'targetObjectRef'),
    scope: stringRecord(input.scope, 'scope'),
    qualifiers: stringRecord(input.qualifiers, 'qualifiers', true),
    validFrom: dateTime(input.validFrom, 'validFrom'),
    validTo: nullableDateTime(input.validTo, 'validTo'),
    evidenceIds: stringArray(input.evidenceIds, 'evidenceIds').map(value =>
      brandedId<'ExperienceEvidenceId'>(value, 'evidenceId')),
  }
}

/** Decode one current-Usage conflict override without accepting hard-policy changes. */
export function parseCreateOverrideDecisionInput(value: unknown): CreateOverrideDecisionInput {
  const input = exactRecord(value, OVERRIDE_KEYS, 'Experience override input')
  return {
    ...parseCommandEnvelope(input),
    targetRelationId: brandedId<'ExperienceRelationId'>(
      requiredString(input.targetRelationId, 'targetRelationId'), 'targetRelationId'),
    replacementInstruction: requiredString(input.replacementInstruction, 'replacementInstruction'),
    exactScope: stringRecord(input.exactScope, 'exactScope'),
    validUntil: dateTime(input.validUntil, 'validUntil'),
    reason: requiredString(input.reason, 'reason'),
  }
}

/** Decode one exact typed relation endpoint. */
export function parseExperienceRelationObjectRef(
  value: unknown,
  field = 'objectRef',
): DeclareExperienceRelationInput['sourceObjectRef'] {
  const input = exactRecord(value, RELATION_REF_KEYS, field)
  const kind = requiredString(input.kind, `${field}.kind`)
  if (!(EXPERIENCE_RELATION_OBJECT_KINDS as readonly string[]).includes(kind)) {
    throw new ExperienceError('invalid_command', `${field}.kind is not recognized`)
  }
  return { kind: kind as DeclareExperienceRelationInput['sourceObjectRef']['kind'], id: requiredString(input.id, `${field}.id`) }
}

/** Decode one owner-requested evaluation over the current exact learning rows. */
export function parseEvaluateUnlockContractInput(value: unknown): EvaluateUnlockContractInput {
  const input = exactRecord(value, LEARNING_EVALUATE_KEYS, 'Unlock evaluation input')
  return { ...parseCommandEnvelope(input), capability: learningCapability(input.capability) }
}

/** Decode the bounded shadow/suggest governance transition exposed in the first product phase. */
export function parseChangeAutomationLevelInput(value: unknown): ChangeAutomationLevelInput {
  const input = exactRecord(value, AUTOMATION_CHANGE_KEYS, 'Automation level input')
  const action = requiredString(input.action, 'action')
  if (action !== 'promote' && action !== 'demote') {
    throw new ExperienceError('invalid_command', 'action must be promote or demote')
  }
  const targetLevel = requiredString(input.targetLevel, 'targetLevel')
  if (!['disabled', 'shadow', 'suggest'].includes(targetLevel)) {
    throw new ExperienceError('invalid_command', 'targetLevel must be disabled, shadow, or suggest')
  }
  const violationClass = requiredString(input.violationClass, 'violationClass')
  if (!['none', 'safety', 'privacy', 'permission', 'metric_drift', 'unknown_spike'].includes(violationClass)) {
    throw new ExperienceError('invalid_command', 'violationClass is not recognized')
  }
  const evaluationId = nullableString(input.evaluationId, 'evaluationId')
  return {
    ...parseCommandEnvelope(input),
    capability: learningCapability(input.capability),
    action,
    targetLevel: targetLevel as ChangeAutomationLevelInput['targetLevel'],
    evaluationId: evaluationId === null ? null : brandedId<'ExperienceUnlockContractEvaluationId'>(evaluationId, 'evaluationId'),
    reason: requiredString(input.reason, 'reason'),
    violationClass: violationClass as ChangeAutomationLevelInput['violationClass'],
  }
}

/** Decode one bounded exact-subject audit query. */
export function parseAuditQueryInput(value: unknown): AuditQueryInput {
  const input = exactRecord(value, AUDIT_QUERY_KEYS, 'Audit query')
  const subject = exactRecord(input.subject, AUDIT_SUBJECT_KEYS, 'Audit subject')
  const kind = requiredString(subject.kind, 'subject.kind')
  if (kind !== 'experience' && kind !== 'usage') {
    throw new ExperienceError('invalid_command', 'subject.kind must be experience or usage')
  }
  const limit = positiveInteger(input.limit, 'limit')
  if (limit > 100) throw new ExperienceError('invalid_command', 'limit must not exceed 100')
  const asOfRecordedAt = nullableString(input.asOfRecordedAt, 'asOfRecordedAt')
  return {
    subject: { kind, id: requiredString(subject.id, 'subject.id') },
    asOfRecordedAt: asOfRecordedAt === null ? null : dateTime(asOfRecordedAt, 'asOfRecordedAt'),
    cursor: nullableString(input.cursor, 'cursor'),
    limit,
  }
}

function learningCapability(value: unknown): EvaluateUnlockContractInput['capability'] {
  const parsed = requiredString(value, 'capability')
  if (!([...LEARNING_CAPABILITIES, HISTORY_RANKING_CAPABILITY] as readonly string[]).includes(parsed)) {
    throw new ExperienceError('invalid_command', 'capability is not recognized')
  }
  return parsed as EvaluateUnlockContractInput['capability']
}

/** Decode one owner-only history-ranking review of a readable shadow counterfactual. */
export function parseRankingReviewInput(value: unknown): RankHistoryRankingInput {
  const input = exactRecord(value, RANKING_REVIEW_KEYS, 'History ranking review input')
  const preferredOrder = requiredString(input.preferredOrder, 'preferredOrder')
  if (!['proposed', 'baseline', 'equivalent', 'unknown'].includes(preferredOrder)) {
    throw new ExperienceError('invalid_command', 'preferredOrder must be proposed, baseline, equivalent, or unknown')
  }
  return {
    ...parseCommandEnvelope(input),
    predictionId: brandedId<'ExperienceLearningPredictionId'>(requiredString(input.predictionId, 'predictionId'), 'predictionId'),
    rankingDigest: requiredString(input.rankingDigest, 'rankingDigest'),
    preferredOrder: preferredOrder as RankHistoryRankingInput['preferredOrder'],
    reason: requiredString(input.reason, 'reason'),
    evidenceRefs: sourceRefsArray(input.evidenceRefs, 'evidenceRefs'),
  }
}

function sourceRefsArray(value: unknown, field: string): LearningSourceRefView[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExperienceError('invalid_command', `${field} must be a non-empty array`)
  }
  return value.map((item, index) => {
    const record = exactRecord(item, SOURCE_REF_KEYS, 'source ref')
    const kind = requiredString(record.kind, `${field}[${index}].kind`)
    const id = requiredString(record.id, `${field}[${index}].id`)
    const digestValue = record.digest === undefined || record.digest === null
      ? null : requiredString(record.digest, `${field}[${index}].digest`)
    return { kind: kind as LearningSourceRefView['kind'], id, digest: digestValue }
  })
}

function stringRecord(value: unknown, field: string, allowEmpty = false): Record<string, string> {
  if (!isRecord(value) || (!allowEmpty && Object.keys(value).length === 0)
    || Object.values(value).some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new ExperienceError('invalid_command', `${field} must be ${allowEmpty ? 'a' : 'a non-empty'} string record`)
  }
  return value as Record<string, string>
}

function nullableDateTime(value: unknown, field: string): string | null {
  if (value === null) return null
  return dateTime(value, field)
}

function exactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  optional: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (!isRecord(value)) throw new ExperienceError('invalid_command', `${label} must be an object`)
  const unknownKeys = Object.keys(value).filter(key => !keys.has(key))
  if (unknownKeys.length > 0) {
    throw new ExperienceError('invalid_command', `${label} contains unrecognized fields`, { fields: unknownKeys.sort() })
  }
  const missing = [...keys].filter(key => !optional.has(key) && !Object.hasOwn(value, key))
  if (missing.length > 0) {
    throw new ExperienceError('required_field_missing', `${label} is missing required fields`, { fields: missing })
  }
  return value
}

function parseCommandEnvelope(input: Record<string, unknown>): Pick<
  ProposeCandidateInput,
  'commandId' | 'correlationId' | 'causationId' | 'issuedAt'
> {
  return {
    commandId: brandedId<'ExperienceCommandId'>(requiredString(input.commandId, 'commandId'), 'commandId'),
    correlationId: requiredString(input.correlationId, 'correlationId'),
    causationId: nullableString(input.causationId, 'causationId'),
    issuedAt: dateTime(input.issuedAt, 'issuedAt'),
  }
}

function parseCandidateCommandRecord(input: Record<string, unknown>): CandidateCommandInput {
  const expectedRevision = input.expectedRevision
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    throw new ExperienceError('invalid_command', 'expectedRevision must be a positive safe integer')
  }
  return {
    ...parseCommandEnvelope(input),
    candidateId: brandedId<'ExperienceCandidateId'>(requiredString(input.candidateId, 'candidateId'), 'candidateId'),
    expectedRevision: expectedRevision as number,
  }
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return requiredString(value, field)
}

function nullableAbsoluteString(value: unknown, field: string): string | null {
  const parsed = nullableString(value, field)
  if (parsed !== null && !isAbsolute(parsed)) {
    throw new ExperienceError('invalid_command', `${field} must be an absolute path or null`)
  }
  return parsed
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ExperienceError('invalid_command', `${field} must be boolean`)
  return value
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExperienceError('invalid_command', `${field} must be null or a positive safe integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExperienceError('invalid_command', `${field} must be a positive safe integer`)
  }
  return value as number
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ExperienceError('invalid_command', `${field} must be a non-negative safe integer`)
  }
  return value as number
}

function boundedFraction(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ExperienceError('invalid_command', `${field} must be from zero through one`)
  }
  return value
}

function dateTime(value: unknown, field: string): string {
  const parsed = requiredString(value, field)
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new ExperienceError('invalid_command', `${field} must be an ISO date-time`)
  }
  return parsed
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ExperienceError('invalid_command', `${field} must be a non-negative safe integer`)
  }
  return value as number
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExperienceError('required_field_missing', `${field} must be a non-empty string`, { field })
  }
  return value
}

function requiredSha256(value: unknown, field: string): string {
  const digest = requiredString(value, field)
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new ExperienceError('invalid_command', `${field} must be a lowercase sha256 digest`)
  }
  return digest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
