import type { ViewState } from './store.js'
import type { CandidateFieldView, LearningSourceRefView } from '../types.js'

/** Client-only Experience workspace modes; neither value owns domain state. */
export type ExperienceMode = 'task' | 'management'

/** Task stages backed by current Host read models. */
export type TaskStage = 'match' | 'preflight' | 'plan' | 'context' | 'execution' | 'verification' | 'settlement' | 'revision'

/** Inspector tabs shared by task and management modes. */
export type InspectorTab = 'overview' | 'sources' | 'history' | 'technical'

/** Default product entry required by the interaction specification. */
export const DEFAULT_EXPERIENCE_MODE: ExperienceMode = 'task'

/** Ordered visible stages across experience selection, use, verification, and correction. */
export const TASK_STAGES: readonly TaskStage[] = [
  'match', 'preflight', 'plan', 'context', 'execution', 'verification', 'settlement', 'revision',
]

/** Determine the furthest current stage from Host-authoritative readback. */
export function currentTaskStage(state: ViewState): TaskStage {
  const planning = state.selectedPlanning
  if (planning === undefined) return 'match'
  if (!planning.matchSet.noMatch && planning.preflights.length === 0) return 'preflight'
  if (state.selectedContext?.snapshot === null || state.selectedContext?.snapshot === undefined) return 'plan'
  const execution = state.selectedExecution
  if (execution?.progress === null || execution === undefined) return 'context'
  if (execution.verification === null) {
    return execution.progress.state === 'completed' || execution.progress.state === 'aborted'
      ? 'verification'
      : 'execution'
  }
  if (execution.settlement === null) {
    return execution.verification.phase === 'complete' ? 'settlement' : 'verification'
  }
  if (execution.revisionProposals.length === 0) return 'settlement'
  return 'revision'
}

/** Completed and current stages can be inspected; future stages cannot be skipped. */
export function taskStageReachable(stage: TaskStage, current: TaskStage): boolean {
  return TASK_STAGES.indexOf(stage) <= TASK_STAGES.indexOf(current)
}

/** Stable visual state for one task stage. */
export function taskStageState(stage: TaskStage, current: TaskStage): 'done' | 'current' | 'blocked' {
  const index = TASK_STAGES.indexOf(stage)
  const currentIndex = TASK_STAGES.indexOf(current)
  return index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'blocked'
}

/** Review counts derived from the Host field decisions, never from scroll/expand state. */
export interface FieldReviewProgress {
  readonly accepted: number
  readonly edited: number
  readonly rejected: number
  readonly pending: number
  readonly total: number
}

/** Count decisions for a set of Host-projected fields. */
export function fieldReviewProgress(fields: readonly CandidateFieldView[]): FieldReviewProgress {
  let accepted = 0
  let edited = 0
  let rejected = 0
  let pending = 0
  for (const field of fields) {
    const decision = field.currentDecision
    if (decision === null) pending += 1
    else if (decision.decision === 'accept') accepted += 1
    else if (decision.decision === 'edit') edited += 1
    else if (decision.decision === 'reject') rejected += 1
  }
  return { accepted, edited, rejected, pending, total: fields.length }
}

/**
 * Next field in identifier order that still has no Host decision.
 * Skips already-reviewed fields and wraps so repeated activation never re-lands on a reviewed one.
 * Returns null when every field has been decided (the completed end state).
 */
export function nextUnreviewedField(
  fields: readonly CandidateFieldView[],
  from: string | null | undefined,
): string | null {
  const pending = fields.filter(field => field.currentDecision === null).map(field => field.field)
  if (pending.length === 0) return null
  if (from === null || from === undefined) return pending[0]!
  const fromIndex = fields.findIndex(field => field.field === from)
  if (fromIndex < 0) return pending[0]!
  const next = pending.find(name => {
    const index = fields.findIndex(field => field.field === name)
    return index > fromIndex
  })
  return next ?? pending[0]!
}

/** Participation categories the Host can report for one Experience usage. */
export const LEARNING_PARTICIPATIONS = [
  'used', 'delivered_only', 'not_selected', 'not_delivered', 'rejected', 'abandoned', 'unverified',
] as const
export type LearningParticipation = typeof LEARNING_PARTICIPATIONS[number]

/** Task outcomes the Host pairs to a usage; unknown never counts as success and null means no result. */
export const LEARNING_TASK_OUTCOMES = ['success', 'failure', 'unknown', 'abandoned'] as const
export type LearningTaskOutcome = (typeof LEARNING_TASK_OUTCOMES)[number] | null

/** The Host binds every participation record to task-level attribution, never component causation. */
export const LEARNING_PARTICIPATION_ATTRIBUTION = 'task_participation' as const
export type LearningParticipationAttribution = typeof LEARNING_PARTICIPATION_ATTRIBUTION

/** A Host-authoritative per-usage participation record for an Experience version. */
export interface LearningHistoryView {
  readonly usageId: string
  readonly experienceVersionId: string
  readonly taskInputDigest: string
  readonly environmentKey: string
  readonly componentRevisionIds: readonly string[]
  readonly participation: LearningParticipation
  readonly taskOutcome: LearningTaskOutcome
  readonly attribution: LearningParticipationAttribution
  readonly evidenceRefs: readonly LearningSourceRefView[]
  readonly reasonCodes: readonly string[]
}

/** Ranking modes the Host reports for the dedicated history-ranking predictor. */
export const LEARNING_RANKING_MODES = ['shadow', 'suggest', 'fallback'] as const
export type LearningRankingMode = (typeof LEARNING_RANKING_MODES)[number]

/** A Host-authoritative baseline/proposed/applied ranking comparison. */
export interface LearningRankingView {
  readonly usageId: string
  readonly taskInputDigest: string
  readonly environmentKey: string
  readonly baselineVersionIds: readonly string[]
  readonly proposedVersionIds: readonly string[]
  readonly appliedVersionIds: readonly string[]
  readonly mode: LearningRankingMode
  readonly reasonCodes: readonly string[]
  readonly sampleCount: number
  readonly sourceUsageIds: readonly string[]
  readonly governanceDecisionId: string | null
  readonly evaluationId: string | null
}

/**
 * Parse the Host history wire from the generic prediction Record.
 * The Host owns every field; the Client only renders. Any missing or malformed
 * field is treated as "no verifiable history" rather than a successful result.
 */
export function parseLearningHistory(value: unknown): LearningHistoryView | null {
  if (!isObject(value)) return null
  const usageId = nonEmptyString(value.usageId)
  if (usageId === null) return null
  const experienceVersionId = nonEmptyString(value.experienceVersionId)
  if (experienceVersionId === null) return null
  const taskInputDigest = nonEmptyString(value.taskInputDigest)
  if (taskInputDigest === null) return null
  const environmentKey = nonEmptyString(value.environmentKey)
  if (environmentKey === null) return null
  const componentRevisionIds = stringArray(value.componentRevisionIds)
  if (componentRevisionIds === null) return null
  const participation = participationValue(value.participation)
  if (participation === null) return null
  const taskOutcome = taskOutcomeValue(value.taskOutcome)
  if (taskOutcome === undefined) return null
  if (value.attribution !== LEARNING_PARTICIPATION_ATTRIBUTION) return null
  const evidenceRefs = sourceRefArray(value.evidenceRefs)
  if (evidenceRefs === null) return null
  const reasonCodes = stringArray(value.reasonCodes)
  if (reasonCodes === null) return null
  return {
    usageId,
    experienceVersionId,
    taskInputDigest,
    environmentKey,
    componentRevisionIds,
    participation,
    taskOutcome,
    attribution: LEARNING_PARTICIPATION_ATTRIBUTION,
    evidenceRefs,
    reasonCodes,
  }
}

/**
 * Parse the Host ranking wire from the generic prediction Record. The ordering of
 * baseline/proposed/applied arrays is Host-provided and is never re-sorted by the Client.
 */
export function parseLearningRanking(value: unknown): LearningRankingView | null {
  if (!isObject(value)) return null
  const usageId = nonEmptyString(value.usageId)
  if (usageId === null) return null
  const taskInputDigest = nonEmptyString(value.taskInputDigest)
  if (taskInputDigest === null) return null
  const environmentKey = nonEmptyString(value.environmentKey)
  if (environmentKey === null) return null
  const baselineVersionIds = stringArray(value.baselineVersionIds)
  if (baselineVersionIds === null) return null
  const proposedVersionIds = stringArray(value.proposedVersionIds)
  if (proposedVersionIds === null) return null
  const appliedVersionIds = stringArray(value.appliedVersionIds)
  if (appliedVersionIds === null) return null
  const mode = rankingModeValue(value.mode)
  if (mode === null) return null
  const reasonCodes = stringArray(value.reasonCodes)
  if (reasonCodes === null) return null
  const sampleCount = finiteCount(value.sampleCount)
  if (sampleCount === null) return null
  const sourceUsageIds = stringArray(value.sourceUsageIds)
  if (sourceUsageIds === null) return null
  const governanceDecisionId = nullableString(value.governanceDecisionId)
  if (governanceDecisionId === undefined) return null
  const evaluationId = nullableString(value.evaluationId)
  if (evaluationId === undefined) return null
  return {
    usageId,
    taskInputDigest,
    environmentKey,
    baselineVersionIds,
    proposedVersionIds,
    appliedVersionIds,
    mode,
    reasonCodes,
    sampleCount,
    sourceUsageIds,
    governanceDecisionId,
    evaluationId,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function participationValue(value: unknown): LearningParticipation | null {
  return typeof value === 'string'
    && (LEARNING_PARTICIPATIONS as readonly string[]).includes(value)
    ? value as LearningParticipation
    : null
}

function taskOutcomeValue(value: unknown): LearningTaskOutcome | undefined {
  if (value === null) return null
  if (typeof value === 'string'
    && (LEARNING_TASK_OUTCOMES as readonly string[]).includes(value)) {
    return value as (typeof LEARNING_TASK_OUTCOMES)[number]
  }
  return undefined
}

function rankingModeValue(value: unknown): LearningRankingMode | null {
  return typeof value === 'string'
    && (LEARNING_RANKING_MODES as readonly string[]).includes(value)
    ? value as LearningRankingMode
    : null
}

function sourceRefArray(value: unknown): readonly LearningSourceRefView[] | null {
  if (!Array.isArray(value)) return null
  const out: LearningSourceRefView[] = []
  for (const item of value) {
    const ref = sourceRefValue(item)
    if (ref === null) return null
    out.push(ref)
  }
  return out
}

function sourceRefValue(value: unknown): LearningSourceRefView | null {
  if (!isObject(value)) return null
  const kind = nonEmptyString(value.kind)
  if (kind === null) return null
  const id = nonEmptyString(value.id)
  if (id === null) return null
  // The raw digest must be explicitly null or a string. A missing value or a
  // non-string (e.g. 42) is unverifiable and must reject the whole reference, never
  // be coerced to null while the record still claims used/success.
  if (value.digest !== null && typeof value.digest !== 'string') return null
  const digest = value.digest as string | null
  return { kind: kind as LearningSourceRefView['kind'], id, digest } as LearningSourceRefView
}
