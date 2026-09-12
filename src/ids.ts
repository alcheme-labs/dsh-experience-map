import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque command identity used for durable idempotency. */
export type CommandId = Branded<'ExperienceCommandId'>
/** Candidate review identity. */
export type CandidateId = Branded<'ExperienceCandidateId'>
/** Stable Experience series identity. */
export type ExperienceId = Branded<'ExperienceId'>
/** Immutable published version identity. */
export type ExperienceVersionId = Branded<'ExperienceVersionId'>
/** Stable independently revisable component identity. */
export type ComponentId = Branded<'ExperienceComponentId'>
/** Immutable component revision identity. */
export type ComponentRevisionId = Branded<'ExperienceComponentRevisionId'>
/** Evidence statement identity. */
export type EvidenceId = Branded<'ExperienceEvidenceId'>
/** Evidence assessment identity. */
export type AssessmentId = Branded<'ExperienceAssessmentId'>
/** Durable commit receipt identity. */
export type ReceiptId = Branded<'ExperienceReceiptId'>
/** Deployment-local principal established by the canonical database. */
export type LocalOwnerPrincipalId = Branded<'ExperienceLocalOwnerPrincipalId'>
/** Resolved actor identity; never accepted from command payloads. */
export type ActorId = Branded<'ExperienceActorId'>
/** Stable source reference identity inside Candidate and Version records. */
export type SourceRefId = Branded<'ExperienceSourceRefId'>
/** Stable terminal Episode reference identity. */
export type EpisodeRefId = Branded<'ExperienceEpisodeRefId'>
/** Versioned fingerprint for one exact task input. */
export type TaskFingerprintId = Branded<'ExperienceTaskFingerprintId'>
/** Durable retrieval result identity. */
export type MatchSetId = Branded<'ExperienceMatchSetId'>
/** Durable current-fact preflight identity. */
export type PreflightId = Branded<'ExperiencePreflightId'>
/** One planned Experience use lifecycle. */
export type UsageId = Branded<'ExperienceUsageId'>
/** Immutable exact plan identity. */
export type UsagePlanId = Branded<'ExperienceUsagePlanId'>
/** Exact human decision request identity. */
export type PlanApprovalRequestId = Branded<'ExperiencePlanApprovalRequestId'>
/** Planning admission attempt identity. */
export type AdmissionAttemptId = Branded<'ExperienceAdmissionAttemptId'>
/** One approved retry binding identity. */
export type AdmissionRetryBindingId = Branded<'ExperienceAdmissionRetryBindingId'>
/** Immutable Context materialization identity. */
export type ContextSnapshotId = Branded<'ExperienceContextSnapshotId'>
/** One coordinated Session delivery identity. */
export type ContextDeliveryId = Branded<'ExperienceContextDeliveryId'>
/** One coordinated Session surface retirement identity. */
export type ContextRetirementId = Branded<'ExperienceContextRetirementId'>
/** One immutable guided-execution cursor record. */
export type StepProgressId = Branded<'ExperienceStepProgressId'>
/** One guided execution lifecycle bound to an approved Plan and Session. */
export type ExecutionId = Branded<'ExperienceExecutionId'>
/** One exact Session tool-call correlation. */
export type ExecutionCorrelationId = Branded<'ExperienceExecutionCorrelationId'>
/** One current-authority verification run. */
export type VerificationRunId = Branded<'ExperienceVerificationRunId'>
/** One terminal criterion-backed Usage result. */
export type SettlementId = Branded<'ExperienceSettlementId'>
/** One component-scoped revision proposal. */
export type RevisionProposalId = Branded<'ExperienceRevisionProposalId'>
/** Deterministic identity of one rebuildable learning prediction. */
export type LearningPredictionId = Branded<'ExperienceLearningPredictionId'>
/** Deterministic identity of one human learning label. */
export type HumanLabelId = Branded<'ExperienceHumanLabelId'>
/** Deterministic identity of one observed learning outcome. */
export type ObservedOutcomeLabelId = Branded<'ExperienceObservedOutcomeLabelId'>
/** Durable request to stop future recall of one Experience series. */
export type ForgetRequestId = Branded<'ExperienceForgetRequestId'>
/** One durable phase result inside a Forget request. */
export type ForgetStepResultId = Branded<'ExperienceForgetStepResultId'>
/** Canonical typed relation identity. */
export type ExperienceRelationId = Branded<'ExperienceRelationId'>
/** Current-Usage override decision identity. */
export type OverrideDecisionId = Branded<'ExperienceOverrideDecisionId'>
/** Versioned automation unlock policy identity. */
export type UnlockContractId = Branded<'ExperienceUnlockContractId'>
/** Immutable evaluation of one exact unlock policy and sample set. */
export type UnlockContractEvaluationId = Branded<'ExperienceUnlockContractEvaluationId'>
/** One final-output Preference Policy validation identity. */
export type PreferenceValidationId = Branded<'ExperiencePreferenceValidationId'>
/** One immutable Markdown projection export identity. */
export type MarkdownProjectionReceiptId = Branded<'ExperienceMarkdownProjectionReceiptId'>
/** One immutable infrastructure-readiness evaluation identity. */
export type InfrastructureReadinessEvaluationId = Branded<'ExperienceInfrastructureReadinessEvaluationId'>
/** One immutable three-arm evaluation observation identity. */
export type EvaluationObservationId = Branded<'ExperienceEvaluationObservationId'>

/** Brand a validated non-empty cross-boundary id. */
export function brandedId<T extends string>(value: string, label: string): Branded<T> {
  if (value.trim() === '') throw new Error(`${label} must not be empty`)
  return value as Branded<T>
}
