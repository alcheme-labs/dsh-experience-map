import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ActorId,
  CandidateId,
  CommandId,
  EpisodeRefId,
  ExperienceId,
  ExperienceVersionId,
  EvidenceId,
  LocalOwnerPrincipalId,
  ReceiptId,
  SourceRefId,
  TaskFingerprintId,
  MatchSetId,
  PreflightId,
  UsageId,
  UsagePlanId,
  PlanApprovalRequestId,
  AdmissionAttemptId,
  AdmissionRetryBindingId,
  ContextDeliveryId,
  ContextRetirementId,
  ContextSnapshotId,
  StepProgressId,
  ExecutionId,
  ExecutionCorrelationId,
  VerificationRunId,
  SettlementId,
  RevisionProposalId,
  ForgetRequestId,
  ForgetStepResultId,
  ExperienceRelationId,
  OverrideDecisionId,
  PreferenceValidationId,
  MarkdownProjectionReceiptId,
  InfrastructureReadinessEvaluationId,
  EvaluationObservationId,
} from './ids.js'
import type { ExperienceKind } from './domain/kind.js'

/** Component roles accepted by the first schema version. */
export type ComponentRole =
  | 'goal_signature' | 'entry_condition' | 'forbidden_condition' | 'parameter'
  | 'environment_adapter' | 'step' | 'checkpoint' | 'side_effect_policy'
  | 'failure_branch' | 'verifier'
  | 'symptom_signature' | 'environment_scope' | 'observed_fact' | 'hypothesis'
  | 'discriminator' | 'misleading_signal' | 'branch' | 'resolution_candidate'
  | 'falsifier' | 'recovery_verifier'
  | 'directive' | 'modality' | 'subject_scope' | 'task_or_output_scope'
  | 'authority_source' | 'override_policy' | 'positive_example' | 'negative_example'
  | 'exception' | 'no_known_exception' | 'valid_from'
  | 'subject' | 'predicate' | 'object_or_value' | 'qualifiers'
  | 'source_evidence' | 'contradiction_policy'
  | 'decision_point' | 'candidate_option' | 'hard_constraint' | 'decision_criterion'
  | 'tradeoff' | 'stop_exploration_rule' | 'escalation_rule' | 'outcome_measure'
  | 'cause_or_intervention' | 'effect_or_metric' | 'applicability_condition'
  | 'mechanism' | 'competing_explanation' | 'evidence_link' | 'causal_grade'
  | 'allowed_use'

/** Evidence strength; confidence is deliberately absent. */
export type EvidenceGrade =
  | 'model_asserted'
  | 'observation_supported'
  | 'mechanism_supported'
  | 'intervention_supported'
  | 'counterfactual_supported'

/** Maximum use a published version may contribute. */
export type AllowedUseMode = 'reference' | 'suggest' | 'guided' | 'guarded_execute'

/** Canonical relation vocabulary; relation names never imply evidence strength. */
export const EXPERIENCE_RELATION_TYPES = [
  'derived_from', 'evidence_for', 'contradicts', 'applies_to', 'requires', 'precedes',
  'conflicts_with', 'specializes', 'composes_with', 'supersedes', 'invalidated_by',
  'failed_under', 'causal_candidate', 'causally_influences',
] as const

/** One allowed canonical relation type. */
export type ExperienceRelationType = typeof EXPERIENCE_RELATION_TYPES[number]

/** Allowed object kinds addressed by canonical relation endpoints. */
export const EXPERIENCE_RELATION_OBJECT_KINDS = [
  'experience', 'version', 'component', 'evidence', 'episode',
  'condition', 'claim', 'usage', 'scope', 'entity',
] as const

/** Type of object addressed by a canonical relation endpoint. */
export type ExperienceRelationObjectKind = typeof EXPERIENCE_RELATION_OBJECT_KINDS[number]

/** Exact polymorphic relation endpoint. */
export interface ExperienceRelationObjectRef {
  readonly kind: ExperienceRelationObjectKind
  readonly id: string
}

/** Canonical relation whose status and evidence are independent dimensions. */
export interface ExperienceRelationView {
  readonly relationId: ExperienceRelationId
  readonly relationType: ExperienceRelationType
  readonly sourceObjectRef: ExperienceRelationObjectRef
  readonly targetObjectRef: ExperienceRelationObjectRef
  readonly scope: Readonly<Record<string, string>>
  readonly qualifiers: Readonly<Record<string, string>>
  readonly validFrom: string
  readonly validTo: string | null
  readonly evidenceIds: readonly EvidenceId[]
  readonly status: 'active' | 'contested' | 'invalidated'
  readonly createdByDecisionId: string
  readonly createdAt: string
}

/** Owner command that declares one immutable canonical relation. */
export interface DeclareExperienceRelationInput {
  readonly commandId: CommandId
  readonly relationType: ExperienceRelationType
  readonly sourceObjectRef: ExperienceRelationObjectRef
  readonly targetObjectRef: ExperienceRelationObjectRef
  readonly scope: Readonly<Record<string, string>>
  readonly qualifiers: Readonly<Record<string, string>>
  readonly validFrom: string
  readonly validTo: string | null
  readonly evidenceIds: readonly EvidenceId[]
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** Current-Usage conflict replacement; it cannot override hard policy. */
export interface OverrideDecisionView {
  readonly overrideDecisionId: OverrideDecisionId
  readonly targetRelationId: ExperienceRelationId
  readonly replacementInstruction: string
  readonly exactScope: Readonly<Record<string, string>>
  readonly validFrom: string
  readonly validTo: string
  readonly actorRef: ActorId
  readonly reason: string
  readonly nonOverridableChecks: readonly ['safety', 'permission', 'privacy', 'legal', 'task_requirement', 'unknown_side_effect']
  readonly createdAt: string
}

/** Owner command for a conflict-scoped, time-bounded override. */
export interface CreateOverrideDecisionInput {
  readonly commandId: CommandId
  readonly targetRelationId: ExperienceRelationId
  readonly replacementInstruction: string
  readonly exactScope: Readonly<Record<string, string>>
  readonly validUntil: string
  readonly reason: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** Use modes that the M2 Diagnostic vertical can publish without an executor binding. */
export const M2_ALLOWED_USE_MODES = ['reference', 'suggest', 'guided'] as const satisfies readonly AllowedUseMode[]

/** Stable reasons accepted when an owner rejects a Candidate. */
export const CANDIDATE_REJECTION_REASON_CODES = [
  'source_unresolvable',
  'success_unverified',
  'hidden_condition_unresolved',
  'one_off_noise',
  'high_risk_outcome_unknown',
  'sensitive_content_unauthorized',
  'governed_content_capability_unavailable',
  'non_actionable_abstraction',
  'exact_duplicate',
  'wrong_experience_kind',
  'required_field_missing',
  'trigger_ineligible',
] as const

/** Stable reason supplied by an owner when rejecting a Candidate. */
export type CandidateRejectionReasonCode = typeof CANDIDATE_REJECTION_REASON_CODES[number]

/** Terminal Session interval that remains owned by its source system. */
export interface EpisodeRefView {
  readonly episodeRefId: EpisodeRefId
  readonly sourceSystem: 'dsh-session'
  readonly sessionOrRunId: string
  readonly eventStart: number
  readonly eventEnd: number
  readonly occurredAt: { readonly start: string; readonly end: string }
  readonly contentDigest: string
  readonly redactionState: 'bounded_excerpt'
}

/** Exact external source locator; Experience records never copy the source body. */
export interface SourceRefView {
  readonly sourceRefId: SourceRefId
  readonly sourceSystem: 'dsh-session' | 'codex-rollout' | 'experience-verifier'
  readonly sourceKind: 'session_event' | 'tool_result' | 'user_instruction' | 'external_document'
  readonly locator: string
  readonly ownerScope: string
  readonly accessScope: 'local_owner'
  readonly occurredAt: string
  readonly observedAt: string
  readonly contentDigest: string
  readonly redactionState: 'bounded_excerpt' | 'digest_only'
}

/** Safe bounded record returned only by source inspection and proposal input. */
export interface BoundedSourceRecord {
  readonly sourceRef: SourceRefView
  readonly eventType: string
  readonly excerpt: string
}

/** Evidence role assigned by the deterministic extraction projection. */
export type ExtractionEvidenceRole =
  | 'user_goal'
  | 'acceptance_criterion'
  | 'environment_fact'
  | 'symptom'
  | 'attempted_action'
  | 'tool_observation'
  | 'terminal_readback'
  | 'terminal_outcome'
  | 'misleading_path'
  | 'model_claim'
  | 'historical_evidence'

/** Epistemic class retained for each item sent to the proposal model. */
export type ExtractionEvidenceClass =
  | 'user_instruction'
  | 'observed_fact'
  | 'model_claim'
  | 'historical_record'

/** One bounded, source-preserving item in the model-visible evidence packet. */
export interface ExtractionEvidenceItem {
  readonly itemId: string
  readonly sourceRef: SourceRefView
  readonly eventType: string
  readonly evidenceRole: ExtractionEvidenceRole
  readonly evidenceClass: ExtractionEvidenceClass
  readonly content: string
  readonly sourceContentDigest: string
  readonly projectionDigest: string
  readonly projectionTruncated: boolean
}

/** Why one source record or model-only block does not enter the evidence packet. */
export type ExtractionOmissionReason =
  | 'assistant_reasoning_removed'
  | 'intermediate_model_commentary'
  | 'lifecycle_noise'
  | 'low_relevance_action'
  | 'merged_into_tool_result'
  | 'empty_projection'
  | 'item_limit'
  | 'packet_byte_limit'

/** Exact local omission disclosed before external processing. */
export interface ExtractionOmissionView {
  readonly sourceRefId: string
  readonly eventType: string
  readonly reason: ExtractionOmissionReason
}

/** Deterministic, transient projection used for one Diagnostic proposal request. */
export interface ExtractionEvidencePacket {
  readonly builderVersion: string
  readonly episodeRefs: readonly EpisodeRefView[]
  readonly items: readonly ExtractionEvidenceItem[]
  readonly omissions: readonly ExtractionOmissionView[]
  readonly sourceRecordCount: number
  readonly sentSourceRecordCount: number
  readonly fullyOmittedSourceRecordCount: number
  readonly removedBlockCount: number
  readonly omissionReasonCounts: Readonly<Partial<Record<ExtractionOmissionReason, number>>>
  readonly sourceRecordBytes: number
  readonly packetBytes: number
  readonly packetDigest: string
}

/** Authoritative terminal-eligibility read model. */
export interface EpisodeInspectionView {
  readonly episodeRef: EpisodeRefView
  readonly sourceRefs: readonly SourceRefView[]
  readonly records: readonly BoundedSourceRecord[]
  readonly termination: TurnTerminationView
  readonly recordCount: number
  readonly omittedRecordCount: number
}

/** Harness turn termination projected without inferring the task outcome. */
export interface TurnTerminationView {
  readonly state: 'terminated' | 'running'
  readonly reason: 'completed' | 'aborted' | 'error' | 'max_tokens' | 'interrupted' | 'unknown'
  readonly terminalSourceRefId: import('./ids.js').SourceRefId | null
}

/** One criterion result used by an Experience-owned outcome assessment. */
export interface OutcomeCriterionResultView {
  readonly criterionId: string
  readonly mandatory: boolean
  readonly result: 'pass' | 'fail' | 'unknown'
  readonly evidenceRefIds: readonly import('./ids.js').SourceRefId[]
}

/** Task result assessment kept separate from Harness turn termination. */
export interface EpisodeOutcomeAssessmentView {
  readonly outcome: 'success' | 'partial' | 'failure' | 'unknown' | 'aborted'
  readonly method: 'criterion_manifest' | 'none'
  readonly policyVersion: string
  readonly manifestDigest: string | null
  readonly criteria: readonly OutcomeCriterionResultView[]
  readonly assessedAt: string
}

/** Supported M2 extraction reasons. */
export type ExtractionTriggerKind =
  | 'terminal_success'
  | 'high_cost_resolution'
  | 'repeated_kernel'
  | 'user_correction'
  | 'diagnostic_exclusion'
  | 'environment_invalidation'
  | 'outcome_unknown'

/** Stable reason codes explaining one Host-owned eligibility decision. */
export type EligibilityReasonCode =
  | 'criterion_outcome_verified'
  | 'task_outcome_unverified'
  | 'termination_contradicts_success'
  | 'outcome_evidence_changed'
  | 'review_requested_without_verified_outcome'
  | 'legacy_eligibility_unverified'

/** Complete extraction decision generated and owned by the Experience domain. */
export interface ExtractionTriggerView {
  readonly triggerKind: ExtractionTriggerKind
  readonly sourceRefIds: readonly import('./ids.js').SourceRefId[]
  readonly eligibilityStatus: 'eligible' | 'candidate_only' | 'ineligible'
  readonly eligibilityReasons: readonly EligibilityReasonCode[]
  readonly detectedBy: 'criterion_manifest' | 'user_request' | 'experience_policy' | 'migration'
  readonly detectorVersion: string
  readonly detectedAt: string
}

/** One exact source expected by a configured criterion result. */
export interface OutcomeEvidenceConfig {
  readonly path: string
  readonly locator: string
  readonly contentDigest: string
  readonly bytes: number
}

/** One deployment-configured task criterion for the fixed M0 acceptance Episode. */
export interface OutcomeCriterionManifestConfig {
  readonly criterionId: string
  readonly mandatory: boolean
  readonly result: 'pass' | 'fail' | 'unknown'
  readonly evidence: readonly OutcomeEvidenceConfig[]
}

/** Exact criterion-backed task result configured only by an acceptance Profile overlay. */
export interface VerifiedOutcomeManifestConfig {
  readonly episode: Required<EpisodeLocatorInput>
  readonly policyVersion: string
  readonly criteria: readonly OutcomeCriterionManifestConfig[]
}

/** Exact external-model disclosure produced locally before a proposal call. */
export interface ProposalDisclosureView {
  readonly provider: string
  readonly model: string
  readonly settingsRevision: number | null
  readonly settingsDigest: string
  readonly reasoningEffort: 'off' | 'low' | 'high' | 'max'
  readonly outputTokenLimitMode: ProposalOutputTokenLimitInput['mode']
  readonly configuredMaxOutputTokens: number | null
  readonly requestedMaxOutputTokens: number | null
  readonly maxOutputTokens: number | null
  readonly maxOutputTokensSource: 'experience_default' | 'user_override' | 'provider_default' | 'unresolved'
  readonly promptVersion: string
  readonly schemaVersion: string
  readonly policyVersion: string
  readonly resultToolName: string
  readonly resultSchemaDigest: string
  readonly sourceInputDigest: string
  readonly disclosureDigest: string
  readonly sourceRecordCount: number
  readonly evidenceItemCount: number
  readonly omittedEntryCount: number
  readonly sentSourceRecordCount: number
  readonly fullyOmittedSourceRecordCount: number
  readonly removedBlockCount: number
  readonly omissionReasonCounts: ExtractionEvidencePacket['omissionReasonCounts']
  readonly packetBytes: number
  readonly modelInputBytes: number
  readonly estimatedInputTokens: number
  readonly sourceRefIds: readonly string[]
}

/** Locally inspected proposal source and the consent identity required to send it. */
export interface ProposalSourceInspectionView {
  readonly requestedKind: ExperienceKind
  readonly outputTokenLimit: ProposalOutputTokenLimitInput
  readonly episode: EpisodeInspectionView
  readonly outcomeAssessment: EpisodeOutcomeAssessmentView
  readonly extractionTrigger: ExtractionTriggerView
  readonly eligibilityDigest: string
  readonly publicationMode: 'publishable_after_review' | 'review_only' | 'not_allowed'
  readonly historicalSourceRefs: readonly SourceRefView[]
  readonly outcomeSourceRefs: readonly SourceRefView[]
  readonly historicalRecords: readonly BoundedSourceRecord[]
  readonly outcomeRecords: readonly BoundedSourceRecord[]
  readonly evidencePacket: ExtractionEvidencePacket
  readonly disclosure: ProposalDisclosureView
}

/** One schema-valid inline component proposed for publication. */
export interface ExperienceComponentInput {
  /** Candidate-local key used to address this component during field review. */
  readonly componentKey: string
  readonly role: ComponentRole
  readonly content: string
  readonly sourceRefs: readonly string[]
}

/** Backward-compatible type name for the Diagnostic proposal adapter. */
export type DiagnosticComponentInput = ExperienceComponentInput

/** Generator identity retained beside a model-proposed Candidate. */
export interface CandidateProposalMetadata {
  readonly generator: 'model'
  readonly proposalSessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  readonly schemaVersion: string
  readonly policyVersion: string
  readonly sourceInputDigest: string
  readonly disclosureDigest: string
  readonly outputDigest: string
  readonly proposedAt: string
}

/** Source-resolved Candidate draft after Host-owned evidence-grade derivation and before human field decisions. */
export interface ExperienceCandidateDraft {
  readonly proposedKind: ExperienceKind
  readonly title: string
  readonly intent: string
  readonly scope: Readonly<Record<string, string>>
  readonly validity: Readonly<Record<string, string>>
  readonly authoritySpec: Readonly<Record<string, string>>
  readonly privacyClass: 'public' | 'workspace' | 'restricted' | 'secret_reference_only'
  readonly riskAndEffectSpec: Readonly<Record<string, string>>
  readonly allowedUseModes: readonly AllowedUseMode[]
  readonly components: readonly ExperienceComponentInput[]
  readonly evidenceGrade: EvidenceGrade
  readonly fieldSourceRefs: Readonly<Record<string, readonly string[]>>
  readonly excludedSteps: readonly {
    readonly summary: string
    readonly reason: string
    readonly sourceRefs: readonly string[]
  }[]
  readonly missingEvidence: readonly string[]
  readonly unresolvedFields: readonly string[]
}

/** Diagnostic-only view used by the current model proposal adapter. */
export type DiagnosticCandidateDraft = Omit<ExperienceCandidateDraft, 'proposedKind'> & {
  readonly proposedKind: 'diagnostic'
}

/** Exact current-Session selection submitted to the Host source reader. */
export interface EpisodeLocatorInput {
  readonly sessionId: string
  readonly eventStart?: number
  readonly eventEnd?: number
  readonly contentDigest?: string
}

/** User-selected output-token policy for one inspected and confirmed proposal call. */
export type ProposalOutputTokenLimitInput =
  | { readonly mode: 'configured_default' }
  | { readonly mode: 'provider_default' }
  | { readonly mode: 'custom'; readonly maxTokens: number }

/** Local inspection input that binds one Episode to one generation policy. */
export interface ProposalSourceInspectionInput {
  readonly requestedKind: ExperienceKind
  readonly episode: EpisodeLocatorInput
  readonly outputTokenLimit: ProposalOutputTokenLimitInput
  readonly requestedTriggerKind: ExtractionTriggerKind
}

/** Command that validates sources, invokes the proposer, and persists one draft. */
export interface ProposeCandidateInput {
  readonly requestedKind: ExperienceKind
  readonly commandId: CommandId
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly episode: EpisodeLocatorInput
  readonly outputTokenLimit: ProposalOutputTokenLimitInput
  readonly eligibilityDigest: string
  readonly proposalDisclosureDigest: string
  readonly confirmedMaxOutputTokens: number | null
  readonly confirmExternalModelProcessing: true
}

/** Shared envelope fields for one exact Candidate mutation. */
export interface CandidateCommandInput {
  readonly commandId: CommandId
  readonly candidateId: CandidateId
  readonly expectedRevision: number
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** One field decision command; a later decision supersedes the earlier field decision. */
export interface DecideCandidateFieldInput extends CandidateCommandInput {
  readonly field: string
  readonly decision: 'accept' | 'reject' | 'edit'
  readonly value?: unknown
  readonly effectiveSourceRefs?: readonly string[]
  readonly reason: string
}

/** Terminal Candidate disposition with a stable product reason code. */
export interface CandidateDispositionInput extends CandidateCommandInput {
  readonly reasonCode: string
}

/** Explicit human review of one publishable Candidate field. */
export interface CandidateFieldReviewInput {
  readonly field: string
  readonly decision: 'accept' | 'reject' | 'edit'
  readonly value?: unknown
  readonly effectiveSourceRefs?: readonly string[]
  readonly reason: string
}

/** Final publish command over one accepted Candidate; contents are read from storage. */
export type PublishCandidateInput = CandidateCommandInput

/** Actor identity resolved from a trusted local transport origin. */
export interface ActorView {
  readonly actorId: ActorId
  readonly principalId: LocalOwnerPrincipalId
  readonly kind:
    | 'browser_local_owner'
    | 'management_local_owner'
    | 'local_user_task'
    | 'agent'
    | 'model'
    | 'system_policy'
    | 'automation'
  readonly authority: 'owner' | 'query_only'
}

/** Durable write receipt; object reads remain authoritative. */
interface DomainReceiptBase {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly actor: ActorView
  readonly candidateId: CandidateId
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Durable write receipt; schema-v1 read compatibility remains distinct from current workflow receipts. */
export type DomainReceipt = DomainReceiptBase & (
  | {
    readonly action: 'diagnostic.publish'
    readonly experienceId: ExperienceId
    readonly experienceVersionId: ExperienceVersionId
  }
  | {
    readonly action:
      | 'candidate.propose'
      | 'candidate.submit'
      | 'candidate.field_decide'
      | 'candidate.accept'
      | 'candidate.reject'
      | 'candidate.withdraw'
      | 'candidate.publish'
    readonly candidateRevision: number
    readonly experienceId: ExperienceId | null
    readonly experienceVersionId: ExperienceVersionId | null
  }
)

/** Durable receipt for an M5 Usage or Revision write. */
export interface M5DomainReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action:
    | 'usage.progress'
    | 'usage.verify'
    | 'usage.settle'
    | 'revision.propose'
    | 'revision.change_decide'
    | 'revision.publish'
  readonly actor: ActorView
  readonly usageId: UsageId | null
  readonly controllerRevision: number | null
  readonly revisionProposalId: RevisionProposalId | null
  readonly objectRevision: number
  readonly experienceId: ExperienceId | null
  readonly experienceVersionId: ExperienceVersionId | null
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Durable receipt proving the canonical recall-stop transaction committed. */
export interface ForgetDomainReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'experience.forget'
  readonly actor: ActorView
  readonly forgetRequestId: ForgetRequestId
  readonly experienceId: ExperienceId
  readonly seriesRevision: number
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Durable receipt for canonical relation and current-Usage override writes. */
export interface RelationDomainReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'relation.declare' | 'override.create'
  readonly actor: ActorView
  readonly relationId: ExperienceRelationId
  readonly overrideDecisionId: OverrideDecisionId | null
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Durable receipt for an unlock evaluation or automation-level decision. */
export interface LearningGovernanceReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'learning.evaluate' | 'automation.promote' | 'automation.demote'
    | 'history_ranking.review'
  readonly actor: ActorView
  readonly capability: LearningGovernanceCapability
  readonly predictionId: import('./ids.js').LearningPredictionId | null
  readonly rankingDigest: string | null
  readonly evaluationId: import('./ids.js').UnlockContractEvaluationId | null
  readonly decisionId: string | null
  readonly policyRevision: number
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Durable receipt for Markdown export or structured revision proposal creation. */
export interface MarkdownDomainReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'markdown.export' | 'markdown.revision_propose'
  readonly actor: ActorView
  readonly markdownProjectionReceiptId: MarkdownProjectionReceiptId
  readonly experienceId: ExperienceId
  readonly experienceVersionId: ExperienceVersionId
  readonly revisionProposalId: RevisionProposalId | null
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Durable receipt for one evaluation observation write. */
export interface EvaluationDomainReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'evaluation.observe'
  readonly actor: ActorView
  readonly evaluationObservationId: EvaluationObservationId
  readonly cohortId: string
  readonly comparisonArm: EvaluationComparisonArm
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Durable receipt for one graph-storage readiness evaluation. */
export interface InfrastructureDomainReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'infrastructure.evaluate'
  readonly actor: ActorView
  readonly infrastructureEvaluationId: InfrastructureReadinessEvaluationId
  readonly decision: InfrastructureReadinessEvaluationView['decision']
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Any durable Experience command receipt returned by the shared readback query. */
export type ExperienceDomainReceipt = DomainReceipt | M5DomainReceipt | ForgetDomainReceipt | RelationDomainReceipt
  | LearningGovernanceReceipt | MarkdownDomainReceipt | EvaluationDomainReceipt
  | InfrastructureDomainReceipt | SuggestionSaveDomainReceipt

/** A phase of the governed Forget protocol. */
export type ForgetPhase =
  | 'recall_stop'
  | 'context_retirement'
  | 'vault_content'
  | 'projection_invalidation'
  | 'tombstone'

/** Current durable outcome for one Forget phase. */
export interface ForgetStepResultView {
  readonly stepResultId: ForgetStepResultId
  readonly forgetRequestId: ForgetRequestId
  readonly phase: ForgetPhase
  readonly status: 'pending' | 'completed' | 'partial' | 'failed' | 'unknown' | 'not_applicable'
  readonly reasonCode: string
  readonly affectedRefs: readonly string[]
  readonly attemptedAt: string
  readonly completedAt: string | null
}

/** One active Context that must be retired after canonical recall stops. */
export interface ForgetContextTargetView {
  readonly contextDeliveryId: ContextDeliveryId
  readonly sessionId: string
  readonly status: 'pending' | 'retired' | 'unknown' | 'failed'
  readonly contextRetirementId: ContextRetirementId | null
  readonly reasonCode: string
  readonly updatedAt: string
}

/** Owner-visible impact calculated before a destructive Forget command. */
export interface ForgetImpactPreviewView {
  readonly experienceId: ExperienceId
  readonly currentVersionId: ExperienceVersionId
  readonly expectedSeriesRevision: number
  readonly versionCount: number
  readonly activeContextTargets: readonly {
    readonly contextDeliveryId: ContextDeliveryId
    readonly sessionId: string
    readonly deliveryStatus: ContextDeliveryView['deliveryStatus']
  }[]
  readonly futureRecall: 'will_stop_immediately'
  readonly immutableHistory: readonly ['versions', 'receipts', 'audit', 'session_events', 'provider_copies']
  readonly vaultContent: 'not_applicable'
  readonly vaultReasonCode: 'governed_content_vault_not_enabled'
  readonly previewDigest: string
  readonly generatedAt: string
}

/** Exact owner command that commits canonical no-retrieval for one series. */
export interface ForgetExperienceInput {
  readonly commandId: CommandId
  readonly experienceId: ExperienceId
  readonly expectedSeriesRevision: number
  readonly previewDigest: string
  readonly reason: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** Durable Forget aggregate; history remains readable but never recallable. */
export interface ForgetRequestView {
  readonly forgetRequestId: ForgetRequestId
  readonly experienceId: ExperienceId
  readonly currentVersionId: ExperienceVersionId
  readonly state: 'processing' | 'completed' | 'partial'
  readonly reason: string
  readonly requestedBy: ActorId
  readonly previewDigest: string
  readonly canonicalRecallStoppedAt: string
  readonly irreversibleHistory: ForgetImpactPreviewView['immutableHistory']
  readonly steps: readonly ForgetStepResultView[]
  readonly contextTargets: readonly ForgetContextTargetView[]
  readonly requestedAt: string
  readonly updatedAt: string
}

/** Exact immutable component revision included in a published Version. */
export interface PublishedComponentView extends ExperienceComponentInput {
  readonly componentId: import('./ids.js').ComponentId
  readonly componentRevisionId: import('./ids.js').ComponentRevisionId
  readonly evidenceIds: readonly import('./ids.js').EvidenceId[]
}

/** Published immutable version read model. */
interface ExperienceVersionViewBase {
  readonly experienceVersionId: ExperienceVersionId
  readonly experienceId: ExperienceId
  readonly versionNumber: number
  readonly previousVersionId: ExperienceVersionId | null
  readonly kind: ExperienceKind
  readonly title: string
  readonly intent: string
  readonly scope: Readonly<Record<string, string>>
  readonly validity: Readonly<Record<string, string>>
  readonly authoritySpec: Readonly<Record<string, string>>
  readonly privacyClass: 'public' | 'workspace' | 'restricted' | 'secret_reference_only'
  readonly riskAndEffectSpec: Readonly<Record<string, string>>
  readonly allowedUseModes: readonly AllowedUseMode[]
  readonly components: readonly PublishedComponentView[]
  readonly componentRevisionIds: readonly import('./ids.js').ComponentRevisionId[]
  readonly initialAssessmentId: import('./ids.js').AssessmentId
  readonly relationIds: readonly string[]
  readonly createdByDecisionId: string
  readonly evidenceGrade: EvidenceGrade
  readonly governanceState: 'accepted'
  readonly operationalState: 'active' | 'conditional'
  readonly legacyWarnings: readonly string[]
  readonly contentDigest: string
  readonly createdAt: string
}

/** Immutable Version read model; M2 source-bound records are explicitly discriminated. */
export type ExperienceVersionView = ExperienceVersionViewBase & (
  | { readonly contentDigestSchema?: never }
  | {
    readonly contentDigestSchema: 'v2-source-bound'
    readonly sourceEpisodeRefs: readonly EpisodeRefView[]
    readonly sourceRefs: readonly SourceRefView[]
  }
)

/** One review field projected by the Host from the Candidate aggregate. */
export interface CandidateFieldView {
  readonly field: string
  readonly stage: 'stable_kernel' | 'scope_authority' | 'validation_safety'
  readonly componentRole: ComponentRole | null
  readonly proposedValue: unknown
  readonly proposedSourceRefs: readonly string[]
  /** Sources supporting the current accepted or edited value. */
  readonly sourceRefs: readonly string[]
  readonly unresolved: boolean
  readonly bulkAcceptAllowed: boolean
  readonly currentDecision: CandidateFieldReviewInput & {
    readonly decisionId: string
    readonly actorId: ActorId
    readonly decidedAt: string
  } | null
}

/** Durable Candidate read model used by Browser and management CLI. */
export interface CandidateView {
  readonly candidateId: CandidateId
  readonly candidateRevision: number
  readonly state: 'proposed' | 'in_review' | 'accepted' | 'published' | 'rejected' | 'withdrawn'
  readonly target: 'new_experience'
  readonly proposedKind: ExperienceKind
  readonly title: string
  readonly extractionTrigger: ExtractionTriggerView
  readonly outcomeAssessment: EpisodeOutcomeAssessmentView
  readonly eligibilityDigest: string
  readonly triggerReason: string
  readonly sourceEpisodeRefs: readonly EpisodeRefView[]
  readonly sourceRefs: readonly SourceRefView[]
  readonly proposal: CandidateProposalMetadata
  /** Host-derived ceiling from the Candidate component source types; never supplied by the model. */
  readonly evidenceGrade: EvidenceGrade
  readonly fields: readonly CandidateFieldView[]
  readonly excludedSteps: ExperienceCandidateDraft['excludedSteps']
  readonly missingEvidence: readonly string[]
  readonly unresolvedFields: readonly string[]
  readonly publicationReadiness: {
    readonly ready: boolean
    readonly blockers: readonly string[]
  }
  readonly createdAt: string
  readonly publishedVersionId: ExperienceVersionId | null
  readonly dispositionReason: string | null
}

/** Candidate inbox row; no proposal body is duplicated into Browser state. */
export interface CandidateSummaryView {
  readonly candidateId: CandidateId
  readonly candidateRevision: number
  readonly state: CandidateView['state']
  readonly proposedKind: ExperienceKind
  readonly title: string
  readonly triggerReason: string
  readonly eligibilityStatus: ExtractionTriggerView['eligibilityStatus']
  readonly pendingFieldCount: number
  readonly rejectedFieldCount: number
  readonly createdAt: string
  readonly proposal: CandidateProposalMetadata
}

/** Current durable status read by Browser and management CLI. */
export interface ExperienceStatusView {
  readonly actor: ActorView
  readonly principalId: LocalOwnerPrincipalId
  readonly candidateCount: number
  readonly versionCount: number
  readonly latestReceipt: DomainReceipt | SuggestionSaveDomainReceipt | null
  readonly latestVersion: ExperienceVersionView | null
  readonly pendingPlanApprovalCount: number
  readonly latestPlanning: PlanningResultView | null
  readonly latestForgetRequest: ForgetRequestView | null
}

/** Explicit task facts accepted at the M3 trust boundary. */
export interface PlanningTaskInput {
  readonly text: string
  readonly workspaceRoot: string | null
  readonly targetExposure: 'local' | 'public'
  readonly mustUseExperience: boolean
  readonly riskClass: 'standard' | 'medium' | 'high'
  readonly requiredCapabilities: readonly string[]
  readonly requestedUseMode: 'suggest' | 'guided'
  readonly overrideDecisionIds: readonly OverrideDecisionId[]
}

/** Command that creates one exact match, preflight, Usage, Plan, and optional decision request. */
export interface PlanTaskCommandInput {
  readonly commandId: CommandId
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly sessionId: string | null
  readonly interaction: 'ask_current_agent' | 'defer'
  readonly confirmExternalModelProcessing: boolean
  readonly task: PlanningTaskInput
}

/** Host-disclosed M3 fingerprint proposal route. */
export interface PlanningConfigurationView {
  readonly taskFingerprintProposalMode: 'deterministic' | 'model'
  readonly provider: string | null
  readonly model: string | null
  readonly maxOutputTokens: number | null
  readonly promptVersion: 'task-fingerprint-v1'
}

export type AutomationAvailability = 'enabled' | 'disabled' | 'constrained' | 'configured_but_unavailable'

/** One user preference paired with the stricter behavior currently enforceable by the Host. */
export interface AutomationControlView<Configured, Effective> {
  readonly configured: Configured
  readonly effective: Effective
  readonly availability: AutomationAvailability
  readonly reasonCodes: readonly string[]
}

/** Owner-visible readback; settings never grant governance, approval, permission, or execution powers. */
export interface AutomationConfigurationView {
  readonly schemaVersion: 'experience-automation-configuration-v1'
  readonly settingsRevision: number | null
  readonly settingsDigest: string
  readonly suggestionDetection: AutomationControlView<boolean, boolean>
  readonly recentSuggestionSessionLimit: number
  readonly suggestionTtlMs: number
  readonly recall: AutomationControlView<boolean, boolean>
  readonly contextInjection: AutomationControlView<
    'never' | 'after_current_plan_approval' | 'eligible_high_confidence',
    'never' | 'after_current_plan_approval'
  >
  readonly toolExecution: AutomationControlView<'disabled' | 'when_eligible', 'disabled'>
  readonly enrichment: AutomationControlView<'disabled' | 'on_ambiguity' | 'always', 'disabled'> & {
    readonly generationRoute: 'configured_dsh_provider' | 'current_agent_model'
  }
  readonly reranker: AutomationControlView<'disabled', 'disabled'>
}

/** Human or management decision over one immutable plan revision. */
export interface DecidePlanCommandInput {
  readonly commandId: CommandId
  readonly requestId: PlanApprovalRequestId
  readonly usagePlanId: UsagePlanId
  readonly expectedPlanRevision: number
  readonly decision: 'approve' | 'deny' | 'withdraw'
  readonly reason: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** Versioned proposal separated from Host-owned hard facts and filters. */
export interface TaskFingerprintView {
  readonly fingerprintId: TaskFingerprintId
  readonly schemaVersion: 'task-fingerprint-v1'
  readonly taskInputDigest: string
  readonly taskText: string
  readonly actorRef: string
  readonly intent: string
  readonly taskFamily: string
  readonly entities: readonly string[]
  readonly expectedOutputs: readonly string[]
  readonly artifactKinds: readonly string[]
  readonly capabilities: readonly string[]
  readonly environmentRefs: readonly string[]
  readonly hardConstraints: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly riskClass: PlanningTaskInput['riskClass']
  readonly targetExposure: PlanningTaskInput['targetExposure']
  readonly fieldProvenance: Readonly<Record<string, 'explicit_user_input' | 'deterministic_host' | 'model_proposal'>>
  readonly createdAt: string
}

/** One version or independent component considered by bounded retrieval. */
export interface MatchCandidateView {
  readonly experienceVersionId: ExperienceVersionId
  readonly experienceId: ExperienceId
  readonly title: string
  readonly componentRevisionIds: readonly import('./ids.js').ComponentRevisionId[]
  readonly selectedComponentRevisionIds: readonly import('./ids.js').ComponentRevisionId[]
  readonly structuralScore: number
  readonly lexicalScore: number
  /** MiniSearch BM25+ score from the immutable retrieval operation, when present. */
  readonly lexicalBm25Score?: number | null
  /** Exact cosine from the active dense generation, never a cross-generation score. */
  readonly semanticScore?: number | null
  /** Deterministic reciprocal-rank-fusion score; it never bypasses hard filters. */
  readonly fusedScore?: number | null
  readonly lexicalRank?: number | null
  readonly semanticRank?: number | null
  readonly rejected: boolean
  readonly reasonCodes: readonly string[]
}

/** Explainable policy/result attached to a conservative hybrid MatchSet. */
export interface RetrievalDecisionView {
  readonly policyVersion: 'conservative-hybrid-policy-v1' | 'conservative-hybrid-policy-v2'
  readonly projectionGeneration: number | null
  readonly projectionContentDigest: string | null
  readonly queryProjectionDigest: string
  readonly queryEmbeddingReceiptId: string | null
  readonly denseState: 'disabled' | 'ready' | 'unavailable' | 'stale_generation'
  readonly denseFailureCode: string | null
  /** V2 automatic-recall calibration readback; absent on durable V1 records. */
  readonly denseApplicabilityProfileDigest?: string | null
  readonly denseApplicabilityAllowedKinds?: readonly ExperienceKind[] | null
  readonly lexicalMinimumOverlap: number
  readonly lexicalRelativeMargin: number
  readonly denseSimilarityThreshold: number
  readonly denseMargin: number
  readonly rrfK: number
  readonly primaryExperienceVersionId: ExperienceVersionId | null
  readonly abstentionReasonCodes: readonly string[]
}

/** Durable, bounded retrieval result with positive and rejected candidates. */
export interface MatchSetView {
  readonly matchSetId: MatchSetId
  readonly fingerprintId: TaskFingerprintId
  readonly retrievalVersion: 'bounded-structural-lexical-v1' | 'conservative-hybrid-v1'
  readonly candidateLimit: number
  readonly candidates: readonly MatchCandidateView[]
  readonly noMatch: boolean
  /** Present only for the production hybrid path; old durable MatchSets remain readable. */
  readonly retrievalDecision?: RetrievalDecisionView
  /** Step-1 automatic admission identity; manual planning intentionally leaves it null. */
  readonly recallDecisionKey?: string | null
  readonly createdAt: string
}

/** Five typed facts used by the first Web startup scenario. */
export type PlanningObservationKind =
  | 'repository_state'
  | 'build_artifact'
  | 'web_contract'
  | 'process_socket'
  | 'authenticated_http'

/** One current observation; unavailable providers remain explicit data. */
export interface PlanningObservationView {
  readonly observationId: string
  readonly kind: PlanningObservationKind
  readonly providerVersion: string
  readonly status: 'observed' | 'unknown' | 'not_applicable' | 'invalidated'
  readonly summary: string
  readonly values: Readonly<Record<string, string | number | boolean | null>>
  readonly sourceRefs: readonly string[]
  readonly observedAt: string
  readonly validUntil: string
  readonly contentDigest: string
  readonly reasonCode: string | null
}

/** Current applicability decision for one matched immutable version. */
export interface PreflightRecordView {
  readonly preflightId: PreflightId
  readonly fingerprintId: TaskFingerprintId
  readonly matchSetId: MatchSetId
  readonly experienceVersionId: ExperienceVersionId
  readonly observations: readonly PlanningObservationView[]
  readonly disposition: 'applicable' | 'adaptable' | 'stale' | 'irrelevant' | 'conflicting' | 'blocked'
  readonly blockers: readonly string[]
  readonly reasonCodes: readonly string[]
  readonly checkedAt: string
  readonly validUntil: string
  readonly digest: string
}

/** One exact component contribution selected or rejected by deterministic composition. */
export interface PlanContributionView {
  readonly contributionId: string
  readonly experienceVersionId: ExperienceVersionId
  readonly componentRevisionId: import('./ids.js').ComponentRevisionId
  readonly role: ComponentRole
  readonly content: string
  readonly contributionType: 'step' | 'constraint' | 'premise' | 'hypothesis' | 'recovery' | 'verification'
  readonly priority: number
  readonly precedes: readonly string[]
  readonly conflictsWith: readonly string[]
  readonly relationIds: readonly ExperienceRelationId[]
}

/** One Preference Policy enforcement decision retained in the exact UsagePlan. */
export interface PreferenceEnforcementView {
  readonly experienceVersionId: ExperienceVersionId
  readonly modality: 'must' | 'must_not' | 'prefer' | 'avoid'
  readonly classification: 'advisory' | 'post_output_validation' | 'pre_execution_blocking'
  readonly directive: string
  readonly authoritySource: string
  readonly positiveExample: string | null
  readonly negativeExample: string | null
  readonly exception: string | null
  readonly result: 'pending' | 'passed' | 'failed' | 'unknown' | 'overridden'
  readonly reasonCode: string
}

/** Source-bound validation of one complete assistant output against selected Preference policies. */
export interface PreferenceOutputValidationView {
  readonly preferenceValidationId: PreferenceValidationId
  readonly usageId: UsageId
  readonly sessionId: string
  readonly messageId: string
  readonly messageDigest: string
  readonly finalOutput: true
  readonly results: readonly {
    readonly experienceVersionId: ExperienceVersionId
    readonly classification: PreferenceEnforcementView['classification']
    readonly result: 'passed' | 'failed' | 'unknown' | 'not_applicable'
    readonly reasonCode: string
  }[]
  readonly createdAt: string
}

/** Immutable exact plan; it is not permission to execute and M3 never starts it. */
export interface UsagePlanView {
  readonly usagePlanId: UsagePlanId
  readonly usageId: UsageId
  readonly planRevision: number
  readonly fingerprintId: TaskFingerprintId
  readonly matchSetId: MatchSetId
  readonly preflightIds: readonly PreflightId[]
  readonly useMode: 'suggest' | 'guided'
  readonly compositionPolicyVersion: 'typed-relations-v1'
  readonly selectedRelationIds: readonly ExperienceRelationId[]
  readonly overrideDecisionIds: readonly OverrideDecisionId[]
  readonly preferenceEnforcements: readonly PreferenceEnforcementView[]
  readonly selectedContributions: readonly PlanContributionView[]
  readonly discardedContributions: readonly { readonly contributionId: string; readonly reasonCode: string }[]
  readonly orderedSteps: readonly { readonly stepId: string; readonly content: string; readonly componentRevisionId: string }[]
  readonly constraints: readonly string[]
  readonly premises: readonly string[]
  readonly hypotheses: readonly string[]
  readonly recovery: readonly string[]
  readonly verification: readonly string[]
  readonly blockers: readonly string[]
  readonly disposition: 'ready_for_approval' | 'suggested' | 'read_only_only' | 'no_match' | 'blocked'
  readonly requiresApproval: boolean
  readonly contentDigest: string
  readonly createdAt: string
}

/** Durable request for an exact current plan revision. */
export interface PlanApprovalRequestView {
  readonly requestId: PlanApprovalRequestId
  readonly usagePlanId: UsagePlanId
  readonly usageId: UsageId
  readonly planRevision: number
  readonly actorId: ActorId
  readonly principalId: LocalOwnerPrincipalId
  readonly status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'expired' | 'superseded'
  readonly riskClass: PlanningTaskInput['riskClass']
  readonly scopeDigest: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly decidedAt: string | null
  readonly decisionId: string | null
  readonly reason: string | null
}

/** One attempt to obtain the current plan decision. */
export interface AdmissionAttemptView {
  readonly admissionAttemptId: AdmissionAttemptId
  readonly usageId: UsageId
  readonly requestId: PlanApprovalRequestId | null
  readonly sessionId: string | null
  readonly actorId: ActorId
  readonly state:
    | 'not_required'
    | 'pending_external_decision'
    | 'approved'
    | 'denied'
    | 'interaction_interrupted'
    | 'no_answerer_continue'
    | 'ready_to_enter'
    | 'entered'
    | 'delegated_without_experience'
    | 'rejected'
    | 'interrupted'
  readonly reasonCode: string
  readonly taskInputDigest?: string
  readonly scopeDigest?: string
  readonly retryBindingId?: AdmissionRetryBindingId | null
  readonly terminalAt?: string | null
  readonly createdAt: string
}

/** Approved exact retry authorization; M4 owns claim/recheck/consume. */
export interface AdmissionRetryBindingView {
  readonly bindingId: AdmissionRetryBindingId
  readonly admissionAttemptId: AdmissionAttemptId
  readonly usageId: UsageId
  readonly requestId: PlanApprovalRequestId
  readonly usagePlanId: UsagePlanId
  readonly planRevision: number
  readonly actorId: ActorId
  readonly principalId: LocalOwnerPrincipalId
  readonly sessionId: string | null
  readonly taskInputDigest: string
  readonly scopeDigest: string
  readonly state: 'active' | 'claimed' | 'consumed' | 'expired' | 'superseded'
  readonly claimRevision: number
  readonly claimedByAdmissionAttemptId: AdmissionAttemptId | null
  readonly claimLeaseUntil: string | null
  readonly stateReasonCode: string | null
  readonly expiresAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** One named, source-bound section in the exact model-facing snapshot. */
export interface ContextSnapshotSectionView {
  readonly name: string
  readonly text: string
  readonly contentDigest: string
  readonly sourceRefs: readonly string[]
}

/** Immutable minimal projection of one approved current UsagePlan. */
export interface ContextSnapshotView {
  readonly contextSnapshotId: ContextSnapshotId
  readonly usageId: UsageId
  readonly usagePlanId: UsagePlanId
  readonly planRevision: number
  readonly instructionScope: 'current_usage'
  readonly deliveryMessageId: string
  readonly experienceVersionRefs: readonly ExperienceVersionId[]
  readonly selectedComponentRevisionRefs: readonly import('./ids.js').ComponentRevisionId[]
  readonly matchReasons: readonly string[]
  readonly applicabilityResults: readonly string[]
  readonly currentFactRefs: readonly string[]
  readonly sections: readonly ContextSnapshotSectionView[]
  readonly provenanceRefs: readonly string[]
  readonly assemblerVersion: 'experience-context-v1'
  readonly contentDigest: string
  readonly materializedAt: string
}

/** Exact cross-store delivery state for one ContextSnapshot. */
export interface ContextDeliveryView {
  readonly contextDeliveryId: ContextDeliveryId
  readonly contextSnapshotId: ContextSnapshotId
  readonly usageId: UsageId
  readonly sessionId: string
  readonly messageId: string
  readonly contentDigest: string
  readonly deliveryStatus:
    | 'prepared'
    | 'appended_to_session'
    | 'included_in_request'
    | 'delivery_unknown'
    | 'failed_before_send'
    | 'interrupted_before_request'
  readonly sessionEventSeq: number | null
  readonly requestBoundaryRef: string | null
  readonly appendedAt: string | null
  readonly deliveredAt: string | null
  readonly createdAt: string
}

/** Exact Session-surface retirement of one previously delivered Context. */
export interface ContextRetirementView {
  readonly contextRetirementId: ContextRetirementId
  readonly contextDeliveryId: ContextDeliveryId
  readonly sessionId: string
  readonly reason: 'next_usage' | 'plan_superseded' | 'forgotten' | 'cancelled' | 'scope_ended'
  readonly status: 'pending' | 'replaced_on_surface' | 'failed'
  readonly replacedSessionEventSeq: number
  readonly replacementSessionEventSeq: number | null
  readonly failureReason: string | null
  readonly requestedAt: string
  readonly completedAt: string | null
}

/** Host-authoritative M4 explanation and reconciliation read model. */
export interface ContextUsageView {
  readonly planning: PlanningResultView
  readonly admissionAttempts: readonly AdmissionAttemptView[]
  readonly snapshot: ContextSnapshotView | null
  readonly delivery: ContextDeliveryView | null
  readonly retirements: readonly ContextRetirementView[]
}

/** Immutable domain cursor; the Browser never infers the current step. */
export interface StepProgressView {
  readonly stepProgressId: StepProgressId
  readonly executionId: ExecutionId
  readonly usageId: UsageId
  readonly usagePlanId: UsagePlanId
  readonly planRevision: number
  readonly sessionId: string
  readonly guardPolicyDigest: string
  readonly controllerRevision: number
  readonly stepIndex: number
  readonly stepRef: string
  readonly completedStepRefs: readonly string[]
  readonly selectedBranchRefs: readonly string[]
  readonly checkpointResults: readonly {
    readonly stepRef: string
    readonly checkpointRef: string
    readonly decision: 'accepted'
    readonly reason: string
  }[]
  readonly state: 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'unknown' | 'aborted'
  readonly transition: 'start' | 'advance' | 'deviate' | 'pause' | 'resume' | 'abort'
  readonly branchRef: string | null
  readonly checkpointRef: string | null
  readonly reason: string | null
  readonly createdAt: string
}

/** Opaque effect identity learned from a tool result and verified independently. */
export interface ExecutionEffectRefView {
  readonly kind: 'background_job'
  readonly jobId: string
  readonly labelDigest: string
  readonly listenerPid: number | null
  readonly host: string | null
  readonly port: number | null
}

/** Exact Session invocation and final ToolRuntime outcome correlated to one Usage. */
export interface ExecutionCorrelationView {
  readonly executionCorrelationId: ExecutionCorrelationId
  readonly usageId: UsageId
  readonly sessionId: string
  readonly callId: string
  readonly rootCallId: string
  readonly toolName: string
  readonly argumentsDigest: string
  readonly callEventSeq: number
  readonly resultEventSeq: number | null
  readonly resultState: 'pending' | 'success' | 'failure'
  readonly externalEffectState: 'none' | 'possible' | 'confirmed' | 'unknown'
  readonly effectRef: ExecutionEffectRefView | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One mandatory or supporting criterion read from its declared authority. */
export interface CriterionVerificationView {
  readonly criterionId:
    | 'WEB-LAUNCH-001'
    | 'WEB-READY-002'
    | 'WEB-AUTH-003'
    | 'WEB-SCOPE-004'
    | 'WEB-CLEAN-005'
    | 'RECALL-TRIGGER-001'
  readonly mandatory: true
  readonly result: 'pass' | 'fail' | 'unknown' | 'not_evaluated'
  readonly observedAt: string
  readonly boundedValue: Readonly<Record<string, string | number | boolean | null>>
  readonly sourceRef: string | null
  readonly integrityDigest: string
  readonly reasonCode: string
}

/** Persisted current-authority verification snapshot; secret material is absent. */
export interface VerificationRunView {
  readonly verificationRunId: VerificationRunId
  readonly usageId: UsageId
  readonly controllerRevision: number
  readonly providerVersion: 'dsh-web-guided-v1' | 'experience-recall-trigger-v1'
  readonly criteria: readonly CriterionVerificationView[]
  readonly phase: 'pre_cleanup' | 'complete' | 'unknown'
  readonly createdAt: string
}

/** Terminal immutable Usage outcome. */
export interface UsageSettlementView {
  readonly settlementId: SettlementId
  readonly usageId: UsageId
  readonly verificationRunId: VerificationRunId
  readonly outcome: 'success' | 'partial' | 'failure' | 'unknown' | 'aborted'
  readonly criteria: readonly CriterionVerificationView[]
  readonly createdAt: string
}

/** One independently reviewed component replacement. */
export interface RevisionChangeView {
  readonly revisionChangeId: string
  readonly componentId: import('./ids.js').ComponentId
  readonly semanticRole: ComponentRole
  readonly replacementContent: string
  readonly sourceRefs: readonly string[]
  readonly decision: 'pending' | 'accepted' | 'rejected'
  readonly decisionReason: string | null
}

/** Durable minimal revision proposal; publication creates a new immutable Version. */
export interface RevisionProposalView {
  readonly revisionProposalId: RevisionProposalId
  readonly experienceId: ExperienceId
  readonly baseVersionId: ExperienceVersionId
  readonly sourceUsageId: UsageId | null
  readonly sourceMarkdownProjectionReceiptId: MarkdownProjectionReceiptId | null
  readonly diagnosis: {
    readonly classification: 'auth_contract_changed' | 'verification_failed' | 'verification_unknown' | 'aborted' | 'markdown_diff'
    readonly reasonCodes: readonly string[]
    readonly criterionIds: readonly CriterionVerificationView['criterionId'][]
  }
  readonly revision: number
  readonly state: 'proposed' | 'in_review' | 'accepted' | 'published' | 'rejected' | 'withdrawn'
  readonly changes: readonly RevisionChangeView[]
  readonly publishedVersionId: ExperienceVersionId | null
  readonly createdAt: string
}

/** Complete Host-authoritative M5 read model. */
export interface UsageExecutionView {
  readonly usageId: UsageId
  readonly progress: StepProgressView | null
  readonly correlations: readonly ExecutionCorrelationView[]
  readonly verification: VerificationRunView | null
  readonly settlement: UsageSettlementView | null
  readonly revisionProposals: readonly RevisionProposalView[]
  readonly preferenceValidations: readonly PreferenceOutputValidationView[]
}

/** Explicit optimistic transition of one guided cursor. */
interface M5CommandEnvelope {
  readonly commandId: CommandId
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

export interface ProgressUsageInput extends M5CommandEnvelope {
  readonly usageId: UsageId
  readonly expectedControllerRevision: number
  readonly action: 'advance' | 'deviate' | 'pause' | 'resume' | 'abort'
  readonly targetStepRef?: string
  readonly branchRef?: string
  readonly checkpointRef?: string
  readonly reason: string
}

/** Run the fixed five Web verifiers using captured in-memory auth material. */
export interface VerifyUsageInput extends M5CommandEnvelope {
  readonly usageId: UsageId
  readonly expectedControllerRevision: number
}

/** Settle from the exact latest persisted verification snapshot. */
export interface SettleUsageInput extends M5CommandEnvelope {
  readonly usageId: UsageId
  readonly expectedControllerRevision: number
  readonly verificationRunId: VerificationRunId
}

/** Request the deterministic minimal stale-verifier revision. */
export interface ProposeRevisionInput extends M5CommandEnvelope {
  readonly usageId: UsageId
  readonly baseVersionId: ExperienceVersionId
}

/** Review one exact RevisionProposal change. */
export interface DecideRevisionChangeInput extends M5CommandEnvelope {
  readonly revisionProposalId: RevisionProposalId
  readonly expectedRevision: number
  readonly revisionChangeId: string
  readonly decision: 'accept' | 'reject'
  readonly reason: string
}

/** Publish an accepted exact RevisionProposal as the next immutable Version. */
export interface PublishRevisionInput extends M5CommandEnvelope {
  readonly revisionProposalId: RevisionProposalId
  readonly expectedRevision: number
}

/** Complete Host-authoritative M3 read model. */
export interface PlanningResultView {
  readonly fingerprint: TaskFingerprintView
  readonly matchSet: MatchSetView
  readonly preflights: readonly PreflightRecordView[]
  readonly plan: UsagePlanView
  readonly approvalRequest: PlanApprovalRequestView | null
  readonly admissionAttempt: AdmissionAttemptView
  readonly retryBinding: AdmissionRetryBindingView | null
  readonly interactionOutcome:
    | 'not_requested'
    | 'approved'
    | 'denied'
    | 'adaptation_requested'
    | 'interaction_answerer_unavailable'
    | 'interaction_interrupted'
    | 'no_answerer_continue'
}

/** Stable identity of the rebuildable M6 learning projection. */
export const LEARNING_PROJECTION_KEY = 'experience-learning-v1'

/** Current implementation version for deterministic M6 learning reconstruction. */
export const LEARNING_BUILDER_VERSION = 'm7-learning-v4'

/** M6 capabilities with real producers in the first Diagnostic vertical. */
export const LEARNING_CAPABILITIES = [
  'extraction', 'applicability', 'revision', 'merge', 'causal_promotion', 'execution',
] as const

/** Independently governed learning and automation capability. */
export type LearningCapability = typeof LEARNING_CAPABILITIES[number]

/** Levels admitted by one capability's explicit unlock policy. */
export type AutomationLevel = 'disabled' | 'shadow' | 'suggest' | 'human_approved' | 'limited_auto' | 'full_auto'

/** One exact canonical record referenced by a rebuildable learning row. */
export interface LearningSourceRefView {
  readonly kind:
    | 'candidate'
    | 'episode'
    | 'source_record'
    | 'proposal_session'
    | 'version'
    | 'usage'
    | 'plan'
    | 'preflight'
    | 'approval_request'
    | 'governance_decision'
    | 'audit'
    | 'step_progress'
    | 'verification'
    | 'settlement'
    | 'revision_proposal'
    | 'revision_change'
    | 'relation'
    | 'unlock_contract'
    | 'unlock_evaluation'
    | 'markdown_projection'
    | 'evaluation_observation'
    | 'receipt'
    | 'context_snapshot'
    | 'context_delivery'
  readonly id: string
  readonly digest: string | null
}

/** An authority-owned human decision paired to one prediction. */
export interface LearningHumanLabelView {
  readonly labelId: import('./ids.js').HumanLabelId
  readonly schemaVersion: 'experience-human-label-v1'
  readonly decision: string
  readonly reason: string | null
  readonly actorId: ActorId
  readonly sourceRefs: readonly LearningSourceRefView[]
  readonly createdAt: string
}

/** One explicit outcome paired to a prediction; unknown remains visible but never counts as success. */
export interface LearningObservedOutcomeView {
  readonly labelId: import('./ids.js').ObservedOutcomeLabelId
  readonly schemaVersion: 'experience-observed-outcome-v1'
  readonly outcome: string
  readonly sourceRefs: readonly LearningSourceRefView[]
  readonly createdAt: string
}

/** Exact participation classification of one Experience version in one Usage. */
export type LearningParticipation =
  | 'used'
  | 'delivered_only'
  | 'not_selected'
  | 'not_delivered'
  | 'rejected'
  | 'abandoned'
  | 'unverified'

/** Usage-level task outcome attributed to one actually-used Experience version. */
export type LearningTaskOutcome = 'success' | 'failure' | 'unknown' | 'abandoned' | null

/** Fixed Host-generated attribution history attached to one applicability row. */
export interface LearningUsageHistoryView {
  readonly usageId: string
  readonly experienceVersionId: string
  readonly taskInputDigest: string
  readonly environmentKey: string
  readonly componentRevisionIds: readonly string[]
  readonly participation: LearningParticipation
  readonly taskOutcome: LearningTaskOutcome
  readonly attribution: 'task_participation'
  readonly evidenceRefs: readonly LearningSourceRefView[]
  readonly reasonCodes: readonly string[]
}

/** One Host-provided baseline-vs-proposed counterfactual ranking for a planning query. */
export interface LearningRankingView {
  readonly usageId: string
  readonly taskInputDigest: string
  readonly environmentKey: string
  readonly baselineVersionIds: readonly string[]
  readonly proposedVersionIds: readonly string[]
  readonly appliedVersionIds: readonly string[]
  readonly mode: 'shadow' | 'suggest' | 'fallback'
  readonly reasonCodes: readonly string[]
  readonly sampleCount: number
  readonly sourceUsageIds: readonly string[]
  readonly governanceDecisionId: string | null
  readonly evaluationId: string | null
}

/** Stable predictor version for the Host history-driven applicability ranker. */
export const HISTORY_RANKING_PREDICTOR = 'opt-history-ranking'

/** Independent governed subject for the history-ranking predictor (kept out of LEARNING_CAPABILITIES). */
export const HISTORY_RANKING_CAPABILITY = 'history_ranking'

/** Any independently governed learning subject: the six projection capabilities plus the ranker. */
export type LearningGovernanceCapability = LearningCapability | typeof HISTORY_RANKING_CAPABILITY

/** Owner's explicit preference judgment between the proposed and the baseline ranking order. */
export type RankingReviewPreferredOrder = 'proposed' | 'baseline' | 'equivalent' | 'unknown'

/** Owner command to review one readable, current shadow-ranking counterfactual. */
export interface RankHistoryRankingInput {
  readonly commandId: CommandId
  readonly predictionId: import('./ids.js').LearningPredictionId
  readonly rankingDigest: string
  readonly preferredOrder: RankingReviewPreferredOrder
  readonly reason: string
  readonly evidenceRefs: readonly LearningSourceRefView[]
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** Immutable owner ranking-review record; the sole truth source for the history_ranking quality check. */
export interface HistoryRankingReviewView {
  readonly reviewId: string
  readonly schemaVersion: 'experience-history-ranking-review-v1'
  readonly predictionId: import('./ids.js').LearningPredictionId
  readonly rankingDigest: string
  readonly preferredOrder: RankingReviewPreferredOrder
  readonly reason: string
  readonly evidenceRefs: readonly LearningSourceRefView[]
  readonly actorId: ActorId
  readonly usageId: string
  readonly scope: Readonly<Record<string, string | null>>
  readonly baselineVersionIds: readonly string[]
  readonly proposedVersionIds: readonly string[]
  readonly decisionId: string
  readonly createdAt: string
}

/** Authorized history-ranking reorder claimed for one real Plan save. */
export interface HistoryRankingApplyTicket {
  readonly authorized: boolean
  readonly taskInputDigest: string
  readonly environmentKey: string
  readonly scope: { readonly workspaceRoot: string | null; readonly targetExposure: string; readonly riskClass: string }
  readonly baselineVersionIds: readonly string[]
  readonly proposedVersionIds: readonly string[]
  readonly governanceDecisionId: string | null
  readonly evaluationId: string | null
  /** Policy identity at gate time; the save re-verifies it is unchanged. */
  readonly policyRevision: number
  readonly contractRevision: number
}

/** One applied, quota-claimed history-ranking ordering recorded for a real Plan. */
export interface HistoryRankingApplyRecord {
  readonly applyId: string
  readonly schemaVersion: 'experience-history-ranking-apply-v1'
  readonly usageId: string
  readonly taskInputDigest: string
  readonly decisionId: string | null
  readonly evaluationId: string | null
  readonly scope: Readonly<Record<string, string | null>>
  readonly baselineVersionIds: readonly string[]
  readonly proposedVersionIds: readonly string[]
  readonly appliedVersionIds: readonly string[]
  readonly policyRevision: number
  readonly contractRevision: number
  readonly createdPlanRevision: number
  readonly createdAt: string
}

/** Runtime result of the conservative history-ranking suggest gate for one planning query. */
export interface HistoryRankingGateView {
  readonly authorized: boolean
  readonly mode: 'shadow' | 'suggest' | 'fallback'
  readonly reasonCodes: readonly string[]
  readonly governanceDecisionId: string | null
  readonly evaluationId: string | null
  readonly sampleCount: number
  readonly baselineVersionIds: readonly string[]
  readonly proposedVersionIds: readonly string[]
  /** Policy identity of the authorizing decision, re-verified at Plan save. */
  readonly policyRevision: number
  readonly contractRevision: number
}

/** One candidate's exact relevance facts the ranking may legally readjust. */
export interface HistoryRankingCandidateInput {
  readonly versionId: string
  readonly disposition: string
  readonly structuralScore: number | null
  readonly lexicalScore: number | null
  readonly rejected: boolean
}

/** Scope + candidate facts for one planning query, used to evaluate the history-ranking suggest gate. */
export interface HistoryRankingGateInput {
  readonly workspaceRoot: string | null
  readonly targetExposure: string
  readonly riskClass: string
  readonly environmentKey: string
  readonly taskInputDigest: string
  readonly candidates: readonly HistoryRankingCandidateInput[]
}

/** One versioned, source-bound shadow prediction and its available labels. */
export interface LearningPredictionView {
  readonly predictionId: import('./ids.js').LearningPredictionId
  readonly schemaVersion: 'experience-shadow-prediction-v1'
  readonly capability: LearningCapability
  readonly predictor: {
    readonly kind: 'model' | 'deterministic_rule'
    readonly version: string
  }
  readonly scope: Readonly<Record<string, string | null>>
  readonly inputRefs: readonly LearningSourceRefView[]
  readonly prediction: Readonly<Record<string, unknown>>
  readonly humanLabels: readonly LearningHumanLabelView[]
  readonly observedOutcomes: readonly LearningObservedOutcomeView[]
  readonly createdAt: string
}

/** Current rebuildable M6 learning projection; canonical Experience records remain authoritative. */
export interface LearningProjectionView {
  readonly projectionKey: typeof LEARNING_PROJECTION_KEY
  readonly builderVersion: typeof LEARNING_BUILDER_VERSION
  readonly generation: number
  readonly sourceOffset: number
  readonly rows: readonly LearningPredictionView[]
  readonly counts: Readonly<Record<LearningCapability, number>>
  readonly unsupportedCapabilities: readonly []
}

/** Versioned thresholds and safety conditions for one automation transition. */
export interface UnlockContractView {
  readonly unlockContractId: import('./ids.js').UnlockContractId
  readonly schemaVersion: 'experience-unlock-contract-v1'
  readonly capability: LearningGovernanceCapability
  /** When present, this contract is bound to a specific predictor (e.g. opt-history-ranking). */
  readonly predictor: string | null
  readonly fromLevel: AutomationLevel
  readonly toLevel: AutomationLevel
  readonly allowedScope: Readonly<Record<string, string | null>>
  readonly excludedRiskClasses: readonly string[]
  readonly inputRequirements: readonly string[]
  readonly hardSafetyInvariants: readonly string[]
  readonly metricDefinitions: Readonly<Record<string, string>>
  readonly thresholdPolicy: {
    readonly minimumHumanAgreement: number
    readonly minimumOutcomeSuccess: number
    readonly maximumUnknownRate: number
    /** Owner-proposed-preference ratio required for a history_ranking pass (0..1), else unused. */
    readonly minimumOwnerProposedRatio?: number
  }
  readonly minimumSampleCoverage: number
  readonly requiredNegativeClasses: readonly string[]
  readonly evaluationWindow: { readonly startsAt: string | null; readonly endsAt: string | null }
  readonly approverPolicy: 'local_owner'
  readonly rolloutLimit: number
  readonly stopConditions: readonly string[]
  readonly demotionTarget: 'shadow' | 'disabled'
  readonly contractVersion: number
  readonly createdAt: string
}

/** Immutable result over exact prediction, label, outcome, and policy identities. */
export interface UnlockContractEvaluationView {
  readonly unlockContractEvaluationId: import('./ids.js').UnlockContractEvaluationId
  readonly schemaVersion: 'experience-unlock-evaluation-v1'
  readonly unlockContractId: import('./ids.js').UnlockContractId
  readonly capability: LearningGovernanceCapability
  readonly shadowPredictionIds: readonly import('./ids.js').LearningPredictionId[]
  readonly humanLabelIds: readonly import('./ids.js').HumanLabelId[]
  readonly outcomeLabelIds: readonly import('./ids.js').ObservedOutcomeLabelId[]
  readonly usageSettlementIds: readonly import('./ids.js').SettlementId[]
  readonly evaluationWindow: { readonly startsAt: string | null; readonly endsAt: string | null }
  readonly metricImplementationVersion: 'learning-unlock-metrics-v1' | 'history-ranking-metrics-v1'
  readonly metricResults: {
    readonly totalPredictions: number
    readonly humanLabeledPredictions: number
    readonly outcomeLabeledPredictions: number
    readonly humanAgreementRate: number | null
    readonly outcomeSuccessRate: number | null
    readonly unknownRate: number
    /** history_ranking-only: owner review quality. */
    readonly reviewCount?: number
    readonly proposedPreferenceRatio?: number | null
    readonly baselineFirstCount?: number
    readonly equivalentCount?: number
    readonly unknownReviewCount?: number
  }
  readonly sampleCoverage: number
  readonly negativeClassCoverage: readonly string[]
  readonly hardInvariantResults: Readonly<Record<string, 'pass' | 'fail'>>
  readonly outcome: 'passed' | 'failed' | 'inconclusive'
  readonly evaluatedAt: string
  /** history_ranking-only: the immutable owner review identities this evaluation froze. */
  readonly reviewIds?: readonly string[]
  /** history_ranking-only: the exact single scope (incl null workspace) this evaluation qualifies. */
  readonly scope?: Readonly<Record<string, string | null>> | null
}

/** Current independently governed level for one learning capability. */
export interface AutomationCapabilityView {
  readonly schemaVersion: 'experience-automation-capability-v1'
  readonly capability: LearningGovernanceCapability
  readonly currentLevel: AutomationLevel
  readonly activeUnlockContractId: import('./ids.js').UnlockContractId
  readonly allowedScope: Readonly<Record<string, string | null>>
  readonly policyRevision: number
  readonly lastEvaluationId: import('./ids.js').UnlockContractEvaluationId | null
  readonly lastDecisionId: string | null
  readonly lastReason: string
  readonly updatedAt: string
}

/** Owner command to freeze a new evaluation over the current learning projection. */
export interface EvaluateUnlockContractInput {
  readonly commandId: CommandId
  readonly capability: LearningGovernanceCapability
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** Owner command for an evaluated promotion or immediate safety demotion. */
export interface ChangeAutomationLevelInput {
  readonly commandId: CommandId
  readonly capability: LearningGovernanceCapability
  readonly action: 'promote' | 'demote'
  readonly targetLevel: 'disabled' | 'shadow' | 'suggest'
  readonly evaluationId: import('./ids.js').UnlockContractEvaluationId | null
  readonly reason: string
  readonly violationClass: 'none' | 'safety' | 'privacy' | 'permission' | 'metric_drift' | 'unknown_spike'
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** Independent history_ranking governance subject (kept separate from the old six-capability view). */
export interface HistoryRankingGovernanceView {
  readonly contract: UnlockContractView
  readonly capability: AutomationCapabilityView
  readonly evaluations: readonly UnlockContractEvaluationView[]
}

/** Owner read model for automation policy, frozen evaluations, and current levels. */
export interface LearningGovernanceView {
  readonly contracts: readonly UnlockContractView[]
  readonly evaluations: readonly UnlockContractEvaluationView[]
  readonly capabilities: readonly AutomationCapabilityView[]
  /** Independent history_ranking governance subject; absent for consumers before this feature. */
  readonly historyRanking?: HistoryRankingGovernanceView
}

/** Exact Experience or Usage whose domain history is being inspected. */
export interface AuditSubjectRef {
  readonly kind: 'experience' | 'usage'
  readonly id: string
}

/** Bounded owner query over append-only domain audit events and their current canonical records. */
export interface AuditQueryInput {
  readonly subject: AuditSubjectRef
  readonly asOfRecordedAt: string | null
  readonly cursor: string | null
  readonly limit: number
}

/** One append-only domain audit event; it is never projected into the Chat transcript. */
export interface AuditTimelineEntryView {
  readonly auditId: string
  readonly actorId: ActorId
  readonly commandId: CommandId
  readonly action: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly objectRefs: readonly string[]
  readonly payloadDigest: string
  readonly sourceRefs: readonly string[]
  readonly recordedAt: string
}

/** One canonical object connected to the queried Experience or Usage. */
export interface AuditObjectView {
  readonly objectKind: string
  readonly objectId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly recordedAt: string
  readonly availability: 'available' | 'metadata_only' | 'unavailable'
  readonly reasonCode: string | null
}

/** Source metadata retained when the original body is not held by Experience Map. */
export interface AuditSourceAvailabilityView {
  readonly sourceRefId: string
  readonly locator: string
  readonly sourceSystem: string
  readonly contentDigest: string
  readonly availability: 'metadata_only'
  readonly reasonCode: 'source_body_owned_by_external_system'
}

/** Owner-visible domain dossier with stable pagination and explicit source availability. */
export interface AuditDossierView {
  readonly subject: AuditSubjectRef
  readonly asOfRecordedAt: string | null
  readonly generatedAt: string
  readonly objects: readonly AuditObjectView[]
  readonly sources: readonly AuditSourceAvailabilityView[]
  readonly timeline: readonly AuditTimelineEntryView[]
  readonly nextCursor: string | null
}

/** Shared envelope for an exact Markdown projection export. */
export interface ExportMarkdownInput extends M5CommandEnvelope {
  readonly experienceVersionId: ExperienceVersionId
}

/** Immutable export receipt plus the exact human-readable projection. */
export interface MarkdownProjectionReceiptView {
  readonly markdownProjectionReceiptId: MarkdownProjectionReceiptId
  readonly experienceId: ExperienceId
  readonly experienceVersionId: ExperienceVersionId
  readonly versionContentDigest: string
  readonly projectionFormat: 'experience-map-markdown-v1'
  readonly projectionDigest: string
  readonly exportedBy: ActorId
  readonly createdAt: string
}

/** Exact Markdown output whose edits can only create a RevisionProposal. */
export interface MarkdownProjectionView {
  readonly receipt: MarkdownProjectionReceiptView
  readonly markdown: string
}

/** Owner import of one edited projection; canonical Experience rows are not changed. */
export interface ProposeMarkdownRevisionInput extends M5CommandEnvelope {
  readonly markdownProjectionReceiptId: MarkdownProjectionReceiptId
  readonly editedMarkdown: string
  readonly editedMarkdownDigest: string
}

/** One node in the rebuildable relation-map projection. */
export interface RelationMapNodeView {
  readonly kind: ExperienceRelationObjectKind
  readonly id: string
}

/** One canonical relation rendered by the rebuildable map. */
export interface RelationMapEdgeView {
  readonly relationId: ExperienceRelationId
  readonly relationType: ExperienceRelationType
  readonly source: ExperienceRelationObjectRef
  readonly target: ExperienceRelationObjectRef
  readonly status: ExperienceRelationView['status']
  readonly evidenceIds: readonly EvidenceId[]
  readonly causalGrade: EvidenceGrade | null
  readonly causalStatus: 'not_causal' | 'candidate' | 'supported'
}

/** Rebuildable list/text/map view derived only from canonical ExperienceRelation rows. */
export interface RelationMapView {
  readonly projectionKey: 'experience-relation-map-v1'
  readonly builderVersion: 'experience-relation-map-v1'
  readonly generationDigest: string
  readonly generatedAt: string
  readonly nodes: readonly RelationMapNodeView[]
  readonly edges: readonly RelationMapEdgeView[]
  readonly textFallback: readonly string[]
}

/** Versioned gate that prevents speculative graph-database adoption. */
export interface InfrastructureReadinessContractView {
  readonly contractId: 'graph-storage-readiness-v1'
  readonly capabilityKey: 'graph_projection_or_database'
  readonly currentStore: 'sqlite'
  readonly requiredQueryClasses: readonly ['adjacency', 'bounded_multi_hop', 'shared_dependency']
  readonly failureDefinitions: readonly [
    'sustained_p95_latency_above_threshold',
    'query_not_expressible_without_duplicate_authority',
    'canonical_parity_or_rollback_not_proven',
  ]
  readonly metricDefinitions: Readonly<Record<string, string>>
  readonly minimumObservationCoverage: number
  readonly consistencyRequirements: readonly string[]
  readonly migrationSafetyRequirements: readonly string[]
  readonly thresholdPolicy: {
    readonly p95QueryDurationMs: number
    readonly minimumStableMultiHopQueryClasses: number
  }
  readonly requiredSignals: readonly [
    'measured_query_bottleneck',
    'stable_multi_hop_demand',
    'rebuild_and_rollback_proven',
  ]
  readonly decisionRule: 'all_required_signals'
  readonly approverPolicy: 'architecture_review'
  readonly contractVersion: 1
  readonly createdAt: string
}

/** Immutable evaluation of current relation-map workload against the readiness contract. */
export interface InfrastructureReadinessEvaluationView {
  readonly evaluationId: InfrastructureReadinessEvaluationId
  readonly contractId: InfrastructureReadinessContractView['contractId']
  readonly relationCount: number
  readonly nodeCount: number
  readonly queryDurationMs: number
  readonly queryObservationRefs: readonly string[]
  readonly currentStoreFailureRefs: readonly string[]
  readonly latencyAndScaleMetrics: {
    readonly sampleCount: number
    readonly p95QueryDurationMs: number
    readonly relationCount: number
    readonly nodeCount: number
  }
  readonly consistencyAssessment: 'not_evaluated' | 'passed' | 'failed'
  readonly candidateMigrationCost: null | Readonly<Record<string, number | string>>
  readonly rollbackEvidenceRefs: readonly string[]
  readonly signals: Readonly<Record<InfrastructureReadinessContractView['requiredSignals'][number], boolean>>
  readonly decision: 'not_ready' | 'ready_for_review'
  readonly blockers: readonly string[]
  readonly evaluatedAt: string
}

/** Current storage decision with the exact latest supporting evaluation. */
export interface InfrastructureReadinessView {
  readonly contract: InfrastructureReadinessContractView
  readonly latestEvaluation: InfrastructureReadinessEvaluationView | null
  readonly decision: 'not_ready' | 'ready_for_review'
}

/** Owner command to freeze the evidence currently observable by the SQLite relation-map owner. */
export interface EvaluateInfrastructureReadinessInput extends M5CommandEnvelope {}

/** The three isolated arms required by the Experience Map product evaluation. */
export type EvaluationComparisonArm = 'no_memory' | 'retrieval_only' | 'experience_map'

/**
 * Discriminated evidence for how one arm observation reached its sample. The
 * settled variant re-uses the original exact fingerprint/usage/Settlement and
 * canonical-outcome checks. The not_used variant binds an exact UsagePlan and a
 * genuinely terminal, never-entered-experience Admission; its outcome is reported
 * from the original task's independent external verifier rather than a Settlement.
 */
export type EvaluationExecutionEvidence =
  | { readonly kind: 'settled' }
  | {
      readonly kind: 'not_used'
      readonly usagePlanId: UsagePlanId
      readonly planDigest: string
      readonly admissionAttemptId: AdmissionAttemptId
      readonly reason: 'no_match' | 'refused' | 'not_used'
      readonly outcomeSource: 'external_verifier'
    }

/** Exact, source-backed observation from one frozen-corpus evaluation run. */
export interface EvaluationObservationView {
  readonly evaluationObservationId: EvaluationObservationId
  readonly cohortId: string
  readonly comparisonArm: EvaluationComparisonArm
  readonly taskCaseId: string
  readonly taskFamilyId: string
  readonly taskFingerprintId: TaskFingerprintId | null
  readonly usageId: UsageId | null
  readonly settlementId: SettlementId | null
  readonly split: 'test'
  readonly taskOccurredAt: string
  readonly trainingWindowEndsAt: string
  readonly trainingEpisodeRefs: readonly string[]
  readonly modelVersion: string
  readonly toolsetVersion: string
  readonly contextBudget: number
  readonly verifierVersion: string
  readonly taskCorpusVersion: string
  readonly outcome: 'success' | 'failure' | 'unknown'
  readonly acceptanceResultRefs: readonly string[]
  readonly decisionAnchorRefs: readonly string[]
  readonly routeSignature: string
  readonly elapsedMs: number
  readonly modelRoundCount: number
  readonly toolCallCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly humanActionCount: number
  readonly repeatedExplorationCount: number
  readonly erroneousSideEffectCount: number
  readonly erroneousReuse: boolean
  readonly retrievalResult: 'not_applicable' | 'none' | 'relevant' | 'irrelevant'
  readonly applicabilityDecision: 'not_applicable' | 'use' | 'refuse' | 'adapt' | 'unknown'
  readonly pollutionIncident: boolean
  readonly explanationCoverage: number
  readonly metricSourceRefs: readonly string[]
  /** Optional execution evidence discriminating a settled vs genuinely-not-used sample. */
  readonly executionEvidence?: EvaluationExecutionEvidence
  readonly recordedAt: string
}

/** Owner command that records one externally observed arm result without executing it. */
export interface RecordEvaluationObservationInput extends M5CommandEnvelope {
  readonly observation: Omit<EvaluationObservationView, 'evaluationObservationId' | 'recordedAt'>
}

/** Aggregate metrics that keep unknown outcomes and sample uncertainty visible. */
export interface EvaluationArmReportView {
  readonly comparisonArm: EvaluationComparisonArm
  readonly sampleCount: number
  readonly successCount: number
  readonly failureCount: number
  readonly unknownCount: number
  readonly successRate: number | null
  readonly successRateWilson95: readonly [number, number] | null
  readonly resolvedSuccessRate: number | null
  readonly resolvedSuccessRateWilson95: readonly [number, number] | null
  readonly unknownRate: number | null
  readonly averageElapsedMs: number | null
  readonly averageModelRounds: number | null
  readonly averageToolCalls: number | null
  readonly averageInputTokens: number | null
  readonly averageOutputTokens: number | null
  readonly averageHumanActions: number | null
  readonly averageRepeatedExploration: number | null
  readonly routeStabilityRate: number | null
  readonly erroneousSideEffectRate: number | null
  readonly erroneousReuseRate: number | null
  readonly pollutionIncidentRate: number | null
  readonly averageExplanationCoverage: number | null
}

/** Comparability-checked report for one frozen cohort. */
export interface EvaluationReportView {
  readonly cohortId: string
  readonly comparable: boolean
  readonly blockers: readonly string[]
  readonly taskCaseIds: readonly string[]
  readonly arms: readonly EvaluationArmReportView[]
  readonly generatedAt: string
}

/** Durable receipt for an M3 planning command. */
export interface PlanningReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'usage.plan' | 'plan.approve' | 'plan.deny' | 'plan.withdraw'
  readonly actor: ActorView
  readonly usageId: UsageId
  readonly usagePlanId: UsagePlanId
  readonly planRevision: number
  readonly requestId: PlanApprovalRequestId | null
  readonly retryBindingId: AdmissionRetryBindingId | null
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Authoritative result returned after a committed M3 command. */
export interface PlanningCommandResult {
  readonly receipt: PlanningReceipt
  readonly planning: PlanningResultView
}

/** One bounded, source-preserving signal retained by the disposable suggestion projection. */
export interface SuggestionEvidenceSignalView {
  readonly itemId: string
  readonly sourceRef: SourceRefView
  readonly eventType: string
  readonly role:
    | 'user_goal'
    | 'attempted_action'
    | 'symptom'
    | 'tool_observation'
    | 'terminal_readback'
    | 'model_claim'
    | 'terminal_outcome'
  readonly evidenceClass: 'user_instruction' | 'observed_fact' | 'model_claim'
  readonly content: string
  readonly projectionDigest: string
  readonly projectionTruncated: boolean
}

/** Deterministic detector output; it is not a Candidate and is never publishable by itself. */
export interface ExperienceSuggestionSeedView {
  readonly occurrenceId: string
  readonly sessionId: string
  readonly workspaceRoot: string | null
  readonly episodeRef: EpisodeRefView
  readonly suggestedKinds: readonly ExperienceKind[]
  readonly triggerKind:
    | 'terminal_success'
    | 'high_cost_resolution'
    | 'diagnostic_exclusion'
    | 'explicit_user_directive'
    | 'authoritative_fact'
    | 'strategy_candidate'
    | 'causal_candidate'
  readonly stableKernel: {
    readonly taskGoal: string
    /** Successful, source-ordered actions only; failed attempts never become the reusable path. */
    readonly toolSequence: readonly string[]
    /** Failed actions retained as negative evidence, not reusable steps. */
    readonly failedToolSequence: readonly string[]
    /** Successful actions observed after the last failure, used by Diagnostic materialization. */
    readonly recoveryToolSequence: readonly string[]
    readonly failureCodes: readonly string[]
    readonly verifierTools: readonly string[]
  }
  readonly evidenceSignals: readonly SuggestionEvidenceSignalView[]
  readonly detectorVersion: string
  readonly segmenterVersion: string
  readonly detectedAt: string
  readonly expiresAt: string
}

/** One exact Session occurrence retained inside a consolidated suggestion group. */
export interface ExperienceSuggestionOccurrenceView {
  readonly occurrenceId: string
  readonly seedOccurrenceId: string
  readonly sessionId: string
  readonly episodeRef: EpisodeRefView
  readonly sourceRefs: readonly SourceRefView[]
  readonly detectedAt: string
  readonly expiresAt: string
}

/** Complete suggestion decision surface derived through the existing publication validator. */
export interface ExperienceSuggestionGroupView {
  readonly suggestionGroupId: string
  readonly kernelIdentity: string
  readonly revisionDigest: string
  readonly sourceDigest: string
  readonly kind: ExperienceKind
  readonly title: string
  readonly draft: ExperienceCandidateDraft
  readonly saveReadiness: 'ready' | 'needs_enrichment' | 'needs_review' | 'blocked'
  readonly readinessReasons: readonly string[]
  readonly missingFields: readonly string[]
  readonly riskFlags: readonly string[]
  readonly reviewDigest: string | null
  readonly consolidation: 'exact' | 'semantic_consolidated' | 'semantic_duplicate' | 'possible_duplicate' | 'distinct' | 'specialization'
  /** High-confidence local semantic match, bound into the reviewed snapshot before canonical save. */
  readonly canonicalMatch?: {
    readonly experienceId: ExperienceId
    readonly experienceVersionId: ExperienceVersionId
    readonly versionContentDigest: string
    readonly title: string
    readonly intent: string
    readonly similarity: number
    readonly retrievalGeneration: number
    readonly modelId: string
    readonly modelRevision: string
  }
  /** Host-owned equivalence decision bound into revision/review digests; vectors never appear here. */
  readonly consolidationDetail?: {
    readonly algorithmVersion: 'experience-equivalence-v1'
    readonly decision: 'same' | 'different' | 'ambiguous' | 'specialization'
    readonly reasonCodes: readonly string[]
    readonly sourceSuggestionGroupIds: readonly string[]
    readonly sourceGroups: readonly {
      readonly suggestionGroupId: string
      readonly kernelIdentity: string
      readonly revisionDigest: string
      readonly occurrenceIds: readonly string[]
    }[]
    readonly targetExperienceId: ExperienceId | null
    readonly targetExperienceVersionId: ExperienceVersionId | null
    readonly targetVersionContentDigest: string | null
    readonly retrievalGeneration: number
    readonly modelIdentityDigest: string
    readonly operationSettingsDigest: string
    readonly activeComparisonSetDigest: string
    readonly allowedOwnerChoices: readonly ('attach_existing' | 'keep_distinct')[]
    readonly componentCorrespondence: readonly {
      readonly incomingSuggestionGroupId: string
      readonly incomingComponentKey: string
      readonly incomingRole: ComponentRole
      readonly incomingContentDigest: string
      readonly targetComponentKey: string
      readonly targetComponentRevisionId: string | null
      readonly targetRole: ComponentRole
      readonly targetContentDigest: string
      readonly matchBasis: 'exact' | 'semantic'
    }[]
    readonly materialDifferences: readonly SuggestionMaterialDifferenceInput[]
  }
  readonly relatedGroupIds: readonly string[]
  /** Published Version candidates are separate from same-batch suggestion group identities. */
  readonly relatedExperienceVersionIds?: readonly ExperienceVersionId[]
  readonly occurrences: readonly ExperienceSuggestionOccurrenceView[]
  readonly occurrenceCount: number
  readonly sessionIds: readonly string[]
  readonly crossSession: boolean
  readonly detectorVersions: readonly string[]
  readonly segmenterVersions: readonly string[]
  readonly materializerVersion: string
  readonly expiresAt: string
}

/** Short-lived owner decision that suppresses one stable suggestion group. */
export interface SuggestionDispositionProjectionView {
  readonly suggestionGroupId: string
  readonly kernelIdentity: string
  readonly decision: 'dismissed' | 'saved_new_experience' | 'attached_as_evidence'
  readonly commandId: string
  readonly actorId: ActorId
  readonly scopeDigest: string
  readonly occurrenceIds: readonly string[]
  readonly inputDigest: string
  readonly decidedAt: string
  readonly expiresAt: string
  readonly projectionReceiptId: string
  readonly targetRef: string | null
}

/** Owner command over the exact suggestion snapshot currently shown. */
export interface DismissExperienceSuggestionInput {
  readonly commandId: string
  readonly suggestionGroupId: string
  readonly expectedRevisionDigest: string
  readonly reviewDigest: string | null
  readonly reasonCode: 'not_reusable' | 'one_off_task' | 'incorrect_abstraction' | 'privacy_choice'
  readonly issuedAt: string
}

/** Owner command that saves the exact reviewed suggestion snapshot currently shown. */
export interface SaveExperienceSuggestionInput {
  readonly commandId: CommandId
  readonly suggestionGroupId: string
  readonly expectedRevisionDigest: string
  readonly reviewDigest: string
  readonly sourceDigest: string
  readonly ownerChoice?: SuggestionOwnerChoiceInput
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
}

/** A Host-projected material facet difference; clients may only echo an exact current item. */
export interface SuggestionMaterialDifferenceInput {
  readonly facet: 'scope' | 'condition' | 'action' | 'outcome' | 'value' | 'authority' | 'verifier'
  readonly incomingComponentKey: string
  readonly targetComponentRevisionId: string
  readonly incomingContentDigest: string
  readonly targetContentDigest: string
  readonly reasonCode: string
}

/** Optional reviewed duplicate ownership decision carried by the existing save command. */
export interface SuggestionOwnerChoiceInput {
  readonly choice: 'attach_existing' | 'keep_distinct'
  readonly targetExperienceVersionId: ExperienceVersionId
  readonly materialDifferences: readonly SuggestionMaterialDifferenceInput[]
}

/** Canonical write receipt for one automatic-suggestion save decision. */
export interface SuggestionSaveDomainReceipt {
  readonly receiptId: ReceiptId
  readonly commandId: CommandId
  readonly action: 'suggestion.save'
  readonly actor: ActorView
  readonly suggestionGroupId: string
  readonly kernelIdentity: string
  readonly outcome: 'saved_new_experience' | 'attached_as_evidence' | 'already_recorded'
  readonly experienceId: ExperienceId
  readonly experienceVersionId: ExperienceVersionId
  readonly evidenceIds: readonly EvidenceId[]
  readonly assessmentId: import('./ids.js').AssessmentId
  readonly reviewDigest: string
  readonly sourceDigest: string
  readonly suggestionRevisionDigest: string
  readonly inputDigest: string
  readonly scopeDigest: string
  readonly sourceSuggestionGroupIds: readonly string[]
  readonly occurrenceIds: readonly string[]
  readonly sourceEpisodeRefs: readonly EpisodeRefView[]
  readonly sourceRefs: readonly SourceRefView[]
  readonly expiresAt: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly issuedAt: string
  readonly commitSequence: number
  readonly createdAt: string
}

/** Processing readback for one recent Session, including legitimate zero-suggestion outcomes. */
export interface SessionSuggestionScanView {
  readonly sessionId: string
  readonly workspaceRoot: string | null
  readonly sessionCreatedAt: string
  readonly lastEventAt: string | null
  readonly capturedThroughSeq: number | null
  readonly lastCompletedEndSeq: number | null
  readonly state: 'processed' | 'no_suggestion' | 'blocked'
  readonly reason: string | null
  readonly occurrenceIds: readonly string[]
}

/** Bounded receipt for one atomic suggestion projection reconciliation. */
export interface SuggestionProjectionReceiptView {
  readonly receiptId: string
  readonly status: 'activated' | 'unchanged' | 'failed' | 'dismissed' | 'saved'
  readonly generation: number
  readonly sourceWatermarkDigest: string
  readonly processedSessionCount: number
  readonly occurrenceCount: number
  readonly startedAt: string
  readonly completedAt: string
  readonly reason: string | null
}

/** Owner-visible, rebuildable recent-Session suggestion projection. */
export interface SuggestionProjectionView {
  readonly projectionKey: 'experience-suggestions-v1'
  readonly schemaVersion: 5
  readonly projectorVersion: string
  readonly generation: number
  readonly sourceWatermarkDigest: string
  readonly state: 'ready' | 'degraded'
  readonly degradedReason: 'source_unavailable' | 'recovered_from_corruption' | null
  readonly sessions: readonly SessionSuggestionScanView[]
  readonly seeds: readonly ExperienceSuggestionSeedView[]
  readonly groups: readonly ExperienceSuggestionGroupView[]
  readonly dispositions: readonly SuggestionDispositionProjectionView[]
  readonly suppressedGroupCount: number
  readonly latestReceipt: SuggestionProjectionReceiptView
}

/** Symmetric semantic fields shared by published Experience documents and task queries. */
export interface RetrievalSemanticFields {
  readonly kind: readonly string[]
  readonly taskFamily: readonly string[]
  readonly goalOrIntent: readonly string[]
  readonly scope: readonly string[]
  readonly capabilitiesOrTools: readonly string[]
  readonly artifactsOrEntities: readonly string[]
  readonly environment: readonly string[]
  readonly validity: readonly string[]
  readonly risk: readonly string[]
  readonly typeSpecific: readonly string[]
}

/** Rebuildable lexical/semantic document projected from one active canonical Version. */
export interface ExperienceRetrievalDocumentView {
  readonly documentId: string
  readonly experienceId: ExperienceId
  readonly experienceVersionId: ExperienceVersionId
  readonly versionContentDigest: string
  readonly kind: ExperienceKind
  readonly projectionVersion: 'experience-retrieval-projector-v2'
  readonly fields: RetrievalSemanticFields
  readonly lexicalText: string
  readonly denseText: string
  readonly contentDigest: string
}

/** Exact generation/model identity; vectors are never exposed to Browser clients. */
export interface ExperienceRetrievalManifestView {
  readonly schemaVersion: 'experience-retrieval-projection-manifest-v2'
  readonly projectionVersion: 'experience-retrieval-projector-v2'
  readonly generation: number
  readonly state: 'lexical_ready' | 'dense_ready'
  readonly provider: 'disabled' | 'transformers_js'
  readonly providerState: 'disabled' | 'configured' | 'ready' | 'unavailable'
  readonly modelId: string | null
  readonly modelRevision: string | null
  readonly artifactSha256: string | null
  readonly dimension: number | null
  readonly dtype: 'q8' | 'fp32' | 'fp16' | null
  readonly pooling: 'mean' | 'cls' | null
  readonly queryPrefix: string | null
  readonly passagePrefix: string | null
  readonly tokenizerConfigBundleSha256: string | null
  readonly normalization: 'l2' | null
  readonly maxInputTokens: number | null
  readonly truncationPolicy: 'truncate_end' | null
  readonly operationSettingsRevision: number | null
  readonly operationSettingsDigest: string
  readonly sourceWatermarkDigest: string
  readonly contentDigest: string
  readonly documentCount: number
  readonly vectorCount: number
  readonly failureCode: Extract<import('./errors.js').ExperienceErrorCode,
    | 'embedding_provider_unavailable'
    | 'embedding_artifact_missing'
    | 'embedding_artifact_digest_mismatch'
    | 'embedding_model_drift'
    | 'embedding_timeout'
    | 'embedding_cancelled'
    | 'embedding_wrong_dimension'
    | 'embedding_non_finite_vector'> | null
  readonly builtAt: string
}

/** Owner-visible status for the current atomic retrieval generation. */
export interface ExperienceRetrievalProjectionView {
  readonly projectionKey: 'experience-retrieval-v1'
  readonly schemaVersion: 2
  readonly manifest: ExperienceRetrievalManifestView
  readonly documents: readonly ExperienceRetrievalDocumentView[]
}
