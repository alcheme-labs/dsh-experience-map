import { ExperienceError } from '../errors.js'
import type {
  ContextSnapshot,
  EvidenceAssessment,
  EvidenceStatement,
  ExperienceCandidate,
  ExperienceComponent,
  ExperienceSeries,
  ExperienceUsage,
  ExperienceVersion,
  MatchSet,
  PlanApprovalRequest,
  PreflightRecord,
  RevisionProposal,
  StepProgress,
  UsagePlan,
  UsageSettlement,
} from './model.js'

/** Assert invariants shared by every Candidate lifecycle transition. */
export function assertCandidateInvariant(candidate: ExperienceCandidate): void {
  positiveRevision(candidate.candidateRevision, 'candidateRevision')
  if (candidate.sourceEpisodeRefs.length === 0 && candidate.sourceRefs.length === 0) {
    invalid('Candidate requires a resolvable source')
  }
  unique(candidate.fieldDecisions.map(decision => decision.field), 'Candidate decision fields')
  if ((candidate.state === 'accepted' || candidate.state === 'published')
    && candidate.fieldDecisions.some(decision => decision.decision === 'reject')) {
    invalid('accepted or published Candidate cannot contain rejected fields')
  }
}

/** Assert stable series identity and current immutable head. */
export function assertSeriesInvariant(series: ExperienceSeries): void {
  nonEmpty(series.experienceId, 'experienceId')
  nonEmpty(series.currentVersionId, 'currentVersionId')
  positiveRevision(series.seriesRevision, 'seriesRevision')
}

/** Assert exact immutable component membership for a published Version. */
export function assertVersionInvariant(version: ExperienceVersion): void {
  positiveRevision(version.versionNumber, 'versionNumber')
  if (version.componentRevisionIds.length === 0) invalid('ExperienceVersion requires component revisions')
  unique(version.componentRevisionIds, 'ExperienceVersion component revisions')
  nonEmpty(version.initialAssessmentId, 'initialAssessmentId')
  nonEmpty(version.createdByDecisionId, 'createdByDecisionId')
  nonEmpty(version.contentDigest, 'contentDigest')
}

/** Assert a component points at one stable series and immutable current revision. */
export function assertComponentInvariant(component: ExperienceComponent): void {
  nonEmpty(component.componentId, 'componentId')
  nonEmpty(component.experienceId, 'experienceId')
  nonEmpty(component.currentRevisionId, 'currentRevisionId')
}

/** Assert Evidence remains attached to an exact ComponentRevision and source. */
export function assertEvidenceInvariant(statement: EvidenceStatement, assessment: EvidenceAssessment): void {
  nonEmpty(statement.componentRevisionId, 'componentRevisionId')
  if (statement.sourceRefs.length === 0) invalid('EvidenceStatement requires source references')
  if (!assessment.evidenceIds.includes(statement.evidenceId)) {
    invalid('EvidenceAssessment must contain the assessed EvidenceStatement')
  }
}

/** Assert MatchSet contains one result per immutable Version. */
export function assertMatchInvariant(match: MatchSet): void {
  unique(match.candidates.map(candidate => candidate.experienceVersionId), 'MatchSet versions')
  for (const candidate of match.candidates) {
    if (candidate.reasons.length === 0) invalid('MatchSet candidates require typed reasons')
  }
}

/** Assert each applicability condition is represented exactly once. */
export function assertPreflightInvariant(preflight: PreflightRecord): void {
  if (preflight.conditions.length === 0) invalid('Preflight requires conditions')
  unique(preflight.conditions.map(condition => condition.key), 'Preflight condition keys')
  for (const condition of preflight.conditions) {
    if (condition.result !== 'unknown' && condition.observationRefs.length === 0) {
      invalid('known Preflight results require observations')
    }
  }
}

/** Assert a composed Plan fixes unique versions, steps, and a positive revision. */
export function assertPlanInvariant(plan: UsagePlan): void {
  positiveRevision(plan.planRevision, 'planRevision')
  unique(plan.selectedVersions, 'UsagePlan selected versions')
  unique(plan.orderedStepRefs, 'UsagePlan ordered steps')
}

/** Assert an approval request has an exact Plan and parseable expiry. */
export function assertApprovalInvariant(approval: PlanApprovalRequest): void {
  nonEmpty(approval.usagePlanId, 'usagePlanId')
  if (!Number.isFinite(Date.parse(approval.validUntil))) invalid('PlanApprovalRequest validUntil is invalid')
  unique(approval.preflightIds, 'PlanApprovalRequest preflights')
}

/** Assert Usage state and immutable result references agree. */
export function assertUsageInvariant(usage: ExperienceUsage): void {
  positiveRevision(usage.usageRevision, 'usageRevision')
  const terminal = usage.state === 'success' || usage.state === 'partial' || usage.state === 'failure'
    || usage.state === 'unknown' || usage.state === 'aborted' || usage.state === 'rejected_before_use'
  if (terminal && usage.settlementId === null) invalid('terminal Usage requires a Settlement')
}

/** Assert execution cursor revisions are monotonic and address one step. */
export function assertStepProgressInvariant(progress: StepProgress): void {
  positiveRevision(progress.controllerRevision, 'controllerRevision')
  nonEmpty(progress.stepRef, 'stepRef')
}

/** Assert materialized Context can be traced to source and exact content. */
export function assertContextInvariant(context: ContextSnapshot): void {
  if (context.sectionDigests.length === 0 || context.sourceRefs.length === 0) {
    invalid('ContextSnapshot requires sections and source references')
  }
  unique(context.sectionDigests, 'ContextSnapshot section digests')
  nonEmpty(context.contentDigest, 'contentDigest')
}

/** Assert terminal outcome agrees with mandatory criterion results. */
export function assertSettlementInvariant(settlement: UsageSettlement): void {
  if (settlement.criteria.length === 0) invalid('UsageSettlement requires criteria')
  unique(settlement.criteria.map(criterion => criterion.criterionId), 'Settlement criteria')
  if (settlement.outcome === 'success'
    && settlement.criteria.some(criterion => criterion.mandatory && criterion.result !== 'pass')) {
    invalid('successful Settlement requires every mandatory criterion to pass')
  }
  for (const criterion of settlement.criteria) {
    if (criterion.result !== 'unknown' && criterion.result !== 'not_evaluated'
      && criterion.evidenceRefs.length === 0) {
      invalid('known Settlement criteria require evidence')
    }
  }
}

/** Assert a RevisionProposal changes exact components without duplication. */
export function assertRevisionInvariant(revision: RevisionProposal): void {
  if (revision.changes.length === 0) invalid('RevisionProposal requires component changes')
  unique(revision.changes.map(change => change.componentId), 'RevisionProposal components')
  for (const change of revision.changes) {
    nonEmpty(change.replacementContent, 'replacementContent')
    if (change.sourceRefs.length === 0) invalid('RevisionProposal changes require sources')
  }
}

function positiveRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${field} must be a positive safe integer`)
}

function nonEmpty(value: string, field: string): void {
  if (value.trim() === '') invalid(`${field} must not be empty`)
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`)
}

function invalid(message: string): never {
  throw new ExperienceError('invalid_command', message)
}
