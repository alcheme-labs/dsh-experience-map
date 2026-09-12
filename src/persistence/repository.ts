import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  acceptCandidateWorkflow,
  createCandidateWorkflow,
  currentWorkflowDecisions,
  decideCandidateWorkflowField,
  publishCandidateWorkflow,
  rejectCandidateWorkflow,
  resolveWorkflowDraft,
  maximumSupportedEvidenceGrade,
  submitCandidateWorkflow,
  validateWorkflowDraft,
  workflowFields,
  workflowFieldViews,
  withdrawCandidateWorkflow,
  type CandidateWorkflowRecord,
} from '../domain/candidate-workflow.js'
import { TYPE_BEHAVIORS } from '../domain/behavior.js'
import { isExperienceKind } from '../domain/kind.js'
import {
  adaptUsagePlan,
  admissionTaskDigest,
  digest,
  matchingEligibilityFor,
  permissiveEligibility,
  registeredFailureSignatures,
  selectMatchingExperiences,
  type ExperienceMatchProjection,
} from '../domain/planning.js'
import {
  selectHybridMatchingExperiences,
  type HybridRetrievalOperation,
} from '../domain/hybrid-retrieval.js'
import { observationFactDigests } from '../domain/context.js'
import { usageGuardPolicyDigest } from '../domain/execution.js'
import { markdownDigest, parseExperienceMarkdownRevision, renderExperienceMarkdown } from '../domain/markdown.js'
import { ExperienceError } from '../errors.js'
import {
  experienceComparisonSetDigest,
  experienceHardScopeMatches,
  experienceKernelIdentity,
  normalizeKernelText,
} from '../domain/experience-kernel.js'
import {
  suggestionDecisionDigests,
  suggestionEvidenceSourceRefsForComponent,
  suggestionSaveEligibility,
  suggestionSourceGroupIds,
} from '../domain/suggestion-materializer.js'
import { brandedId } from '../ids.js'
import { assertExperienceStoreInvariants, assertStoredVersionConsistency } from '../invariant.js'
import { LEARNING_BUILDER_VERSION, LEARNING_CAPABILITIES, LEARNING_PROJECTION_KEY, HISTORY_RANKING_PREDICTOR, HISTORY_RANKING_CAPABILITY } from '../types.js'
import type {
  AssessmentId,
  CandidateId,
  ComponentId,
  ComponentRevisionId,
  EvidenceId,
  ExperienceId,
  ExperienceVersionId,
  ActorId,
  HumanLabelId,
  LearningPredictionId,
  LocalOwnerPrincipalId,
  ObservedOutcomeLabelId,
  ReceiptId,
  ForgetRequestId,
  ForgetStepResultId,
  ExperienceRelationId,
  OverrideDecisionId,
  SettlementId,
  UnlockContractEvaluationId,
  MarkdownProjectionReceiptId,
  InfrastructureReadinessEvaluationId,
  EvaluationObservationId,
} from '../ids.js'
import type {
  ActorView,
  CandidateCommandInput,
  CandidateDispositionInput,
  CandidateProposalMetadata,
  CandidateSummaryView,
  CandidateView,
  DecideCandidateFieldInput,
  MatchSetView,
  TaskFingerprintView,
  ExperienceCandidateDraft,
  DomainReceipt,
  ExperienceDomainReceipt,
  M5DomainReceipt,
  EpisodeRefView,
  ExperienceStatusView,
  ExperienceVersionView,
  PlanningTaskInput,
  PlanTaskCommandInput,
  DecidePlanCommandInput,
  PlanningCommandResult,
  PlanningReceipt,
  PlanningResultView,
  PlanApprovalRequestView,
  AdmissionAttemptView,
  UsagePlanView,
  AdmissionRetryBindingView,
  ContextDeliveryView,
  ContextRetirementView,
  ContextSnapshotView,
  ContextUsageView,
  PlanningObservationView,
  ProposeCandidateInput,
  SourceRefView,
  EpisodeOutcomeAssessmentView,
  ExtractionTriggerView,
  StepProgressView,
  ExecutionCorrelationView,
  VerificationRunView,
  UsageSettlementView,
  UsageExecutionView,
  ProgressUsageInput,
  VerifyUsageInput,
  SettleUsageInput,
  CriterionVerificationView,
  RevisionProposalView,
  RevisionChangeView,
  ProposeRevisionInput,
  DecideRevisionChangeInput,
  PublishRevisionInput,
  LearningCapability,
  LearningHumanLabelView,
  LearningObservedOutcomeView,
  LearningPredictionView,
  LearningProjectionView,
  LearningSourceRefView,
  LearningUsageHistoryView,
  LearningRankingView,
  LearningTaskOutcome,
  PreflightRecordView,
  HistoryRankingGateInput,
  HistoryRankingGateView,
  LearningGovernanceCapability,
  RankHistoryRankingInput,
  HistoryRankingReviewView,
  HistoryRankingGovernanceView,
  HistoryRankingApplyTicket,
  HistoryRankingApplyRecord,
  ForgetDomainReceipt,
  ForgetExperienceInput,
  ForgetImpactPreviewView,
  ForgetRequestView,
  ForgetStepResultView,
  ForgetContextTargetView,
  DeclareExperienceRelationInput,
  ExperienceRelationView,
  ExperienceRelationObjectRef,
  CreateOverrideDecisionInput,
  OverrideDecisionView,
  RelationDomainReceipt,
  AutomationCapabilityView,
  ChangeAutomationLevelInput,
  EvaluateUnlockContractInput,
  LearningGovernanceReceipt,
  LearningGovernanceView,
  UnlockContractEvaluationView,
  UnlockContractView,
  PreferenceOutputValidationView,
  AuditDossierView,
  AuditObjectView,
  AuditQueryInput,
  AuditSourceAvailabilityView,
  AuditTimelineEntryView,
  ExportMarkdownInput,
  MarkdownDomainReceipt,
  MarkdownProjectionReceiptView,
  MarkdownProjectionView,
  ProposeMarkdownRevisionInput,
  EvaluateInfrastructureReadinessInput,
  InfrastructureReadinessEvaluationView,
  InfrastructureReadinessView,
  RelationMapView,
  EvaluationDomainReceipt,
  RecordEvaluationObservationInput,
  EvaluationObservationView,
  EvaluationExecutionEvidence,
  EvaluationReportView,
  EvaluationArmReportView,
  EvaluationComparisonArm,
  InfrastructureDomainReceipt,
  ExperienceSuggestionGroupView,
  SaveExperienceSuggestionInput,
  SuggestionSaveDomainReceipt,
} from '../types.js'
import { ExperienceDatabase } from './database.js'

interface DeduplicationRow {
  readonly payload_digest: string
  readonly receipt_id: string
}

/** Claimed one-time admission that still requires current-state recheck. */
export interface ClaimedAdmission {
  readonly planning: PlanningResultView
  readonly binding: AdmissionRetryBindingView
  readonly attempt: AdmissionAttemptView
}

/** One outbox row identity and lease token owned by an M6 projection run. */
export interface ClaimedLearningOutbox {
  readonly outboxId: string
  readonly sourceOffset: number
  readonly leaseUntil: string
}

/** A required dependency that cannot be legally satisfied; it must block the Plan. */
export interface UnsatisfiableDependency {
  readonly relationId: ExperienceRelationId
  readonly sourceObjectRef: ExperienceRelationObjectRef
  readonly targetObjectRef: ExperienceRelationObjectRef
  readonly reasonCode: string
  readonly message: string
}

/** One `requires` edge resolved to an exact target version, or recorded as unsatisfiable. */
export interface ResolvedRequirement {
  readonly relationId: ExperienceRelationId
  readonly sourceObjectRef: ExperienceRelationObjectRef
  readonly targetObjectRef: ExperienceRelationObjectRef
  readonly targetVersion: ExperienceVersionView | null
  readonly unsatisfiable: UnsatisfiableDependency | null
}

/** The transitive `requires` closure resolved around already-selected contributions. */
export interface DependencyClosure {
  readonly versions: readonly ExperienceVersionView[]
  readonly relations: readonly ExperienceRelationView[]
  readonly requirements: readonly ResolvedRequirement[]
  readonly unsatisfiable: readonly UnsatisfiableDependency[]
}

/** Trusted, source-bound reason for ending one Usage before a new recall decision. */
export interface RecallSettlementTrigger {
  readonly contextDeliveryId: string
  readonly sessionId: string
  readonly kind: 'initial_user_turn' | 'registered_tool_failure' | 'environment_generation_changed'
  readonly generation: string
  readonly sourceRef: string
  readonly evidenceDigest: string
  readonly evidenceSummary: string
  readonly failureSignature: string | null
}

/** Canonical repository and transaction owner for the first Experience vertical. */
export class ExperienceRepository {
  /** Create the repository over the process's sole Experience connection. */
  constructor(private readonly database: ExperienceDatabase) {}

  /** Create or read the one database-owned local principal. */
  async initializePrincipal(): Promise<LocalOwnerPrincipalId> {
    return this.database.write((handle) => {
      const now = new Date().toISOString()
      ensureLearningGovernance(handle, now)
      const rows = handle.prepare(
        'SELECT principal_id FROM local_owner_principals ORDER BY principal_id',
      ).all() as Array<{ principal_id: string }>
      if (rows.length > 1) {
        throw new ExperienceError('database_schema_invalid', 'Experience database contains multiple local owner principals')
      }
      if (rows.length === 1) return localOwnerPrincipalId(rows[0]!.principal_id)
      const principalId = localOwnerPrincipalId(randomUUID())
      handle.prepare(
        'INSERT INTO local_owner_principals (principal_id, policy_revision, created_at) VALUES (?, 1, ?)',
      ).run(principalId, now)
      return principalId
    })
  }

  /** Read an already committed idempotent command before external proposal work. */
  findCommandReceipt(
    commandId: string,
    payloadDigest: string,
    actor: ActorView,
  ): DomainReceipt | null {
    requireOwner(actor, 'inspect command idempotency')
    const existing = this.database.handle.prepare(
      'SELECT payload_digest, receipt_id FROM command_deduplication WHERE command_id = ?',
    ).get(commandId) as DeduplicationRow | undefined
    if (existing === undefined) return null
    if (existing.payload_digest !== payloadDigest) {
      throw new ExperienceError('idempotency_conflict', 'CommandId was already used with a different payload')
    }
    return requireCandidateReceipt(readReceipt(this.database.handle, existing.receipt_id))
  }

  /** Persist one model proposal as a source-bound, unreviewed Candidate. */
  async proposeCandidate(
    input: ProposeCandidateInput,
    draft: ExperienceCandidateDraft,
    episodeRefs: readonly EpisodeRefView[],
    sourceRefs: readonly SourceRefView[],
    proposal: CandidateProposalMetadata,
    eligibility: {
      readonly extractionTrigger: ExtractionTriggerView
      readonly outcomeAssessment: EpisodeOutcomeAssessmentView
      readonly eligibilityDigest: string
    },
    actor: ActorView,
    maxInlineFieldBytes: number,
  ): Promise<DomainReceipt> {
    requireOwner(actor, 'propose Experience Candidates')
    const payloadDigest = workflowPayloadDigest('candidate.propose', actor, input)
    return this.database.write((handle) => {
      const existing = deduplicatedCandidateReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const now = new Date().toISOString()
      const candidateId = id<'ExperienceCandidateId', CandidateId>()
      const candidate = createCandidateWorkflow(
        draft,
        episodeRefs,
        sourceRefs,
        eligibility,
        proposal,
        actor.actorId,
        {
          candidateId,
          componentIds: draft.components.map(() => id<'ExperienceComponentId', ComponentId>()),
          componentRevisionIds: draft.components.map(() =>
            id<'ExperienceComponentRevisionId', ComponentRevisionId>()),
          evidenceIds: draft.components.map(() => id<'ExperienceEvidenceId', EvidenceId>()),
        },
        now,
        maxInlineFieldBytes,
      )
      handle.prepare(
        `INSERT INTO candidates
          (candidate_id, kind, protocol_version, trigger_kind, eligibility_status, eligibility_digest,
           revision, state, payload_json, created_at, published_version_id)
         VALUES (?, ?, 'm7-candidate-v4', ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        candidateId,
        candidate.draft.proposedKind,
        candidate.extractionTrigger.triggerKind,
        candidate.extractionTrigger.eligibilityStatus,
        candidate.eligibilityDigest,
        candidate.revision,
        candidate.state,
        JSON.stringify(candidate),
        now,
      )
      const receipt = commitWorkflowReceipt(handle, {
        input,
        action: 'candidate.propose',
        actor,
        candidate,
        payloadDigest,
        sourceRefs: [
          ...episodeRefs.map(ref => ref.episodeRefId as string),
          ...sourceRefs.map(ref => ref.sourceRefId as string),
        ],
      })
      enqueueLearningReconcile(handle, 'candidate', candidateId, now)
      return receipt
    })
  }

  /** Move one proposed Candidate into field review. */
  async submitCandidate(input: CandidateCommandInput, actor: ActorView): Promise<DomainReceipt> {
    return this.mutateCandidate('candidate.submit', input, actor, candidate =>
      submitCandidateWorkflow(candidate, input.expectedRevision))
  }

  /** Persist one exact field decision. */
  async decideCandidateField(
    input: DecideCandidateFieldInput,
    actor: ActorView,
    maxInlineFieldBytes: number,
  ): Promise<DomainReceipt> {
    return this.mutateCandidate('candidate.field_decide', input, actor, (candidate, now) =>
      decideCandidateWorkflowField(
        candidate,
        {
          field: input.field,
          decision: input.decision,
          ...input.value === undefined ? {} : { value: input.value },
          ...input.effectiveSourceRefs === undefined ? {} : { effectiveSourceRefs: input.effectiveSourceRefs },
          reason: input.reason,
        },
        randomUUID(),
        actor.actorId,
        now,
        input.expectedRevision,
        maxInlineFieldBytes,
      ), true)
  }

  /** Accept one fully decided Candidate without publishing it. */
  async acceptCandidate(
    input: CandidateCommandInput,
    actor: ActorView,
    maxInlineFieldBytes: number,
  ): Promise<DomainReceipt> {
    return this.mutateCandidate('candidate.accept', input, actor, candidate =>
      acceptCandidateWorkflow(candidate, input.expectedRevision, maxInlineFieldBytes))
  }

  /** Reject one in-review Candidate without publishing a Version. */
  async rejectCandidate(input: CandidateDispositionInput, actor: ActorView): Promise<DomainReceipt> {
    return this.mutateCandidate('candidate.reject', input, actor, candidate =>
      rejectCandidateWorkflow(candidate, input.expectedRevision, input.reasonCode))
  }

  /** Withdraw one unpublished Candidate without publishing a Version. */
  async withdrawCandidate(input: CandidateDispositionInput, actor: ActorView): Promise<DomainReceipt> {
    return this.mutateCandidate('candidate.withdraw', input, actor, candidate =>
      withdrawCandidateWorkflow(candidate, input.expectedRevision, input.reasonCode))
  }

  /** Atomically publish one accepted Candidate and its immutable Version. */
  async publishCandidate(
    input: CandidateCommandInput,
    actor: ActorView,
    maxInlineFieldBytes: number,
  ): Promise<DomainReceipt> {
    requireOwner(actor, 'publish Experience Candidates')
    const payloadDigest = workflowPayloadDigest('candidate.publish', actor, input)
    return this.database.write((handle) => {
      const existing = deduplicatedCandidateReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const candidate = readWorkflowCandidate(handle, input.candidateId)
      const draft = resolveWorkflowDraft(candidate)
      validateWorkflowDraft(
        draft,
        candidate.sourceEpisodeRefs,
        candidate.sourceRefs,
        maxInlineFieldBytes,
      )
      const experienceId = id<'ExperienceId', ExperienceId>()
      const experienceVersionId = id<'ExperienceVersionId', ExperienceVersionId>()
      const assessmentId = id<'ExperienceAssessmentId', AssessmentId>()
      const governanceDecisionId = randomUUID()
      const now = new Date().toISOString()
      const published = publishCandidateWorkflow(candidate, input.expectedRevision, experienceVersionId)
      const duplicate = findActiveVersionByKernel(handle, draft)
      if (duplicate !== null) {
        throw new ExperienceError('experience_duplicate', 'An active Experience already has the same stable kernel', {
          experienceId: duplicate.experienceId,
          experienceVersionId: duplicate.experienceVersionId,
          kernelIdentity: experienceKernelIdentity({
            kind: draft.proposedKind,
            scope: draft.scope,
            components: draft.components,
          }),
        })
      }
      const contentDigest = sha256(canonicalJson({
        contentDigestSchema: 'v2-source-bound',
        kind: draft.proposedKind,
        title: draft.title,
        intent: draft.intent,
        scope: draft.scope,
        validity: draft.validity,
        authoritySpec: draft.authoritySpec,
        privacyClass: draft.privacyClass,
        riskAndEffectSpec: draft.riskAndEffectSpec,
        allowedUseModes: draft.allowedUseModes,
        sourceEpisodeRefs: candidate.sourceEpisodeRefs,
        sourceRefs: candidate.sourceRefs,
        components: draft.components,
        evidenceGrade: draft.evidenceGrade,
      }))
      const components = draft.components.map((component, index) => ({
        ...component,
        componentId: candidate.componentIds[index]!,
        componentRevisionId: candidate.componentRevisionIds[index]!,
        evidenceIds: [candidate.evidenceIds[index]!],
      }))
      const version: ExperienceVersionView = {
        experienceVersionId,
        experienceId,
        versionNumber: 1,
        previousVersionId: null,
        kind: draft.proposedKind,
        title: draft.title,
        intent: draft.intent,
        scope: draft.scope,
        validity: draft.validity,
        authoritySpec: draft.authoritySpec,
        privacyClass: draft.privacyClass,
        riskAndEffectSpec: draft.riskAndEffectSpec,
        allowedUseModes: draft.allowedUseModes,
        sourceEpisodeRefs: candidate.sourceEpisodeRefs,
        sourceRefs: candidate.sourceRefs,
        components,
        componentRevisionIds: candidate.componentRevisionIds,
        initialAssessmentId: assessmentId,
        relationIds: [],
        createdByDecisionId: governanceDecisionId,
        evidenceGrade: draft.evidenceGrade,
        governanceState: 'accepted',
        operationalState: 'conditional',
        legacyWarnings: [],
        contentDigest,
        contentDigestSchema: 'v2-source-bound',
        createdAt: now,
      }
      handle.prepare(
        `UPDATE candidates SET revision = ?, state = ?, payload_json = ?, published_version_id = ?
          WHERE candidate_id = ? AND revision = ?`,
      ).run(published.revision, published.state, JSON.stringify(published), experienceVersionId,
        candidate.candidateId, candidate.revision)
      insertPublishedVersion(handle, draft, version, actor, governanceDecisionId, now, {
        subjectRef: candidate.candidateId,
        decisionType: 'publish_candidate',
        reasonCode: 'explicit_field_review_complete',
      })
      const receipt = commitWorkflowReceipt(handle, {
        input,
        action: 'candidate.publish',
        actor,
        candidate: published,
        payloadDigest,
        sourceRefs: [
          ...candidate.sourceEpisodeRefs.map(ref => ref.episodeRefId as string),
          ...candidate.sourceRefs.map(ref => ref.sourceRefId as string),
        ],
        experienceId,
        experienceVersionId,
      })
      handle.prepare(
        `INSERT INTO outbox_entries
          (outbox_id, topic, payload_json, state, attempts, next_attempt_at, lease_until, created_at)
         VALUES (?, 'experience.version.published', ?, 'pending', 0, ?, NULL, ?)`,
      ).run(randomUUID(), JSON.stringify({
        receiptId: receipt.receiptId,
        experienceVersionId,
        correlationId: input.correlationId,
        causationId: input.causationId,
      }), now, now)
      assertExperienceStoreInvariants(handle)
      return receipt
    })
  }

  /** Save one reviewed Session suggestion or attach its evidence to the exact active Experience. */
  async saveExperienceSuggestion(
    input: SaveExperienceSuggestionInput,
    group: ExperienceSuggestionGroupView,
    actor: ActorView,
    maxInlineFieldBytes: number,
  ): Promise<SuggestionSaveDomainReceipt> {
    requireOwner(actor, 'save Experience suggestions')
    const payloadDigest = sha256(canonicalJson({ action: 'suggestion.save', actor, input }))
    return this.database.write((handle) => {
      const existing = deduplicatedReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return requireSuggestionSaveReceipt(existing)
      validateSuggestionSaveSnapshot(input, group, maxInlineFieldBytes)
      const now = new Date().toISOString()
      if (Date.parse(group.expiresAt) <= Date.parse(now)) {
        throw new ExperienceError('stale_revision', 'suggestion group expired before canonical commit')
      }
      if (group.kind === 'fact'
        && (!Number.isFinite(Date.parse(group.draft.validity.validUntil ?? ''))
          || Date.parse(group.draft.validity.validUntil!) <= Date.parse(now))) {
        throw new ExperienceError('stale_revision', 'authoritative Fact expired before canonical commit')
      }
      const kernelIdentity = experienceKernelIdentity({
        kind: group.kind,
        scope: group.draft.scope,
        components: group.draft.components,
      })
      if (kernelIdentity !== group.kernelIdentity) {
        throw new ExperienceError('stale_revision', 'suggestion stable kernel changed before canonical commit')
      }
      const currentActiveVersions = listCurrentActiveVersions(handle)
      assertSuggestionComparisonSnapshot(group, currentActiveVersions)
      const episodeRefs = uniqueBy(
        group.occurrences.map(occurrence => occurrence.episodeRef),
        ref => ref.episodeRefId,
      )
      const sourceRefs = uniqueBy(
        group.occurrences.flatMap(occurrence => occurrence.sourceRefs),
        ref => ref.sourceRefId,
      )
      const attachExisting = group.consolidation === 'semantic_duplicate'
        || input.ownerChoice?.choice === 'attach_existing'
      const exactVersion = findActiveVersionByKernel(handle, group.draft, currentActiveVersions)
      let version: ExperienceVersionView | null
      if (attachExisting) {
        const semanticVersion = resolveSemanticDuplicateTarget(handle, group)
        if (exactVersion !== null
          && exactVersion.experienceVersionId !== semanticVersion.experienceVersionId) {
          throw new ExperienceError('experience_duplicate', 'Semantic target conflicts with the exact stable-kernel owner', {
            semanticExperienceId: semanticVersion.experienceId,
            semanticExperienceVersionId: semanticVersion.experienceVersionId,
            exactExperienceId: exactVersion.experienceId,
            exactExperienceVersionId: exactVersion.experienceVersionId,
            kernelIdentity: group.kernelIdentity,
          })
        }
        version = semanticVersion
      } else {
        version = exactVersion
      }
      if (input.ownerChoice?.choice === 'keep_distinct' && version !== null) {
        throw new ExperienceError('experience_duplicate', 'A reviewed distinct choice cannot override an exact stable-kernel collision', {
          experienceId: version.experienceId,
          experienceVersionId: version.experienceVersionId,
          kernelIdentity: group.kernelIdentity,
        })
      }
      let experienceId: ExperienceId
      let experienceVersionId: ExperienceVersionId
      let evidenceIds: EvidenceId[]
      let assessmentId: AssessmentId
      let outcome: SuggestionSaveDomainReceipt['outcome']
      if (version === null) {
        experienceId = id<'ExperienceId', ExperienceId>()
        experienceVersionId = id<'ExperienceVersionId', ExperienceVersionId>()
        const governanceDecisionId = randomUUID()
        const componentIds = group.draft.components.map((_component, index) =>
          deterministicId<'ExperienceComponentId', ComponentId>(
            'suggestion-component', `${experienceId}:${String(index)}`,
          ))
        const componentRevisionIds = group.draft.components.map((_component, index) =>
          deterministicId<'ExperienceComponentRevisionId', ComponentRevisionId>(
            'suggestion-component-revision', `${experienceVersionId}:${String(index)}`,
          ))
        const componentEvidenceIds = group.draft.components.map((component, index) =>
          suggestionEvidenceSourceRefsForComponent(component).map(sourceRefId =>
            deterministicId<'ExperienceEvidenceId', EvidenceId>(
              'suggestion-evidence',
              `${experienceVersionId}:${componentRevisionIds[index]!}:${sourceRefId}`,
            )))
        evidenceIds = componentEvidenceIds.flat()
        assessmentId = deterministicId<'ExperienceAssessmentId', AssessmentId>(
          'suggestion-assessment',
          `${experienceVersionId}:${group.draft.evidenceGrade}:${actor.actorId}:${[...evidenceIds].sort().join(':')}`,
        )
        const contentDigest = sha256(canonicalJson({
          contentDigestSchema: 'v2-source-bound',
          kind: group.draft.proposedKind,
          title: group.draft.title,
          intent: group.draft.intent,
          scope: group.draft.scope,
          validity: group.draft.validity,
          authoritySpec: group.draft.authoritySpec,
          privacyClass: group.draft.privacyClass,
          riskAndEffectSpec: group.draft.riskAndEffectSpec,
          allowedUseModes: group.draft.allowedUseModes,
          sourceEpisodeRefs: episodeRefs,
          sourceRefs,
          components: group.draft.components,
          evidenceGrade: group.draft.evidenceGrade,
        }))
        version = {
          experienceVersionId,
          experienceId,
          versionNumber: 1,
          previousVersionId: null,
          kind: group.draft.proposedKind,
          title: group.draft.title,
          intent: group.draft.intent,
          scope: group.draft.scope,
          validity: group.draft.validity,
          authoritySpec: group.draft.authoritySpec,
          privacyClass: group.draft.privacyClass,
          riskAndEffectSpec: group.draft.riskAndEffectSpec,
          allowedUseModes: group.draft.allowedUseModes,
          sourceEpisodeRefs: episodeRefs,
          sourceRefs,
          components: group.draft.components.map((component, index) => ({
            ...component,
            componentId: componentIds[index]!,
            componentRevisionId: componentRevisionIds[index]!,
            evidenceIds: componentEvidenceIds[index]!,
          })),
          componentRevisionIds,
          initialAssessmentId: assessmentId,
          relationIds: [],
          createdByDecisionId: governanceDecisionId,
          evidenceGrade: group.draft.evidenceGrade,
          governanceState: 'accepted',
          operationalState: 'conditional',
          legacyWarnings: [],
          contentDigest,
          contentDigestSchema: 'v2-source-bound',
          createdAt: now,
        }
        insertPublishedVersion(handle, group.draft, version, actor, governanceDecisionId, now, {
          subjectRef: group.suggestionGroupId,
          decisionType: 'save_experience_suggestion',
          reasonCode: 'owner_reviewed_suggestion_snapshot',
        })
        outcome = 'saved_new_experience'
      } else {
        experienceId = version.experienceId
        experienceVersionId = version.experienceVersionId
        const attached = attachSuggestionEvidence(
          handle,
          version,
          group,
          actor,
          now,
          attachExisting,
        )
        evidenceIds = attached.evidenceIds
        assessmentId = attached.assessmentId
        outcome = attached.changed ? 'attached_as_evidence' : 'already_recorded'
      }
      const receipt = commitSuggestionSaveReceipt(handle, {
        input,
        actor,
        group,
        payloadDigest,
        kernelIdentity,
        outcome,
        experienceId,
        experienceVersionId,
        evidenceIds,
        assessmentId,
        createdAt: now,
      })
      if (outcome === 'saved_new_experience') {
        handle.prepare(
          `INSERT INTO outbox_entries
            (outbox_id, topic, payload_json, state, attempts, next_attempt_at, lease_until, created_at)
           VALUES (?, 'experience.version.published', ?, 'pending', 0, ?, NULL, ?)`,
        ).run(randomUUID(), JSON.stringify({
          receiptId: receipt.receiptId,
          experienceVersionId,
          correlationId: input.correlationId,
          causationId: input.causationId,
        }), now, now)
      }
      assertExperienceStoreInvariants(handle)
      return receipt
    })
  }

  /** Read one durable Candidate through the current actor authorization. */
  getCandidate(candidateId: CandidateId, actor: ActorView): CandidateView {
    requireOwner(actor, 'read Experience Candidates')
    return candidateView(readWorkflowCandidate(this.database.handle, candidateId))
  }

  /** List the durable M2 Candidate inbox newest first. */
  listCandidates(actor: ActorView): CandidateSummaryView[] {
    requireOwner(actor, 'read Experience Candidates')
    const rows = this.database.handle.prepare(
      `SELECT candidate_id FROM candidates
        WHERE json_type(payload_json, '$.draft') = 'object'
        ORDER BY created_at DESC, candidate_id DESC`,
    ).all() as Array<{ candidate_id: string }>
    return rows.map(row => candidateSummary(readWorkflowCandidate(this.database.handle, row.candidate_id)))
  }

  private async mutateCandidate(
    action:
      | 'candidate.submit'
      | 'candidate.field_decide'
      | 'candidate.accept'
      | 'candidate.reject'
      | 'candidate.withdraw',
    input: CandidateCommandInput | DecideCandidateFieldInput | CandidateDispositionInput,
    actor: ActorView,
    mutate: (candidate: CandidateWorkflowRecord, now: string) => CandidateWorkflowRecord,
    insertDecision = false,
  ): Promise<DomainReceipt> {
    requireOwner(actor, 'review Experience Candidates')
    const payloadDigest = workflowPayloadDigest(action, actor, input)
    return this.database.write((handle) => {
      const existing = deduplicatedCandidateReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const candidate = readWorkflowCandidate(handle, input.candidateId)
      const now = new Date().toISOString()
      const updated = mutate(candidate, now)
      const changed = handle.prepare(
        `UPDATE candidates SET revision = ?, state = ?, payload_json = ?
          WHERE candidate_id = ? AND revision = ?`,
      ).run(updated.revision, updated.state, JSON.stringify(updated), updated.candidateId, candidate.revision)
      if (changed.changes !== 1) {
        throw new ExperienceError('stale_revision', 'Candidate changed before the command could commit')
      }
      if (insertDecision) {
        const decision = updated.decisions.at(-1)!
        handle.prepare(
          `INSERT INTO candidate_field_decisions
            (decision_id, candidate_id, field_name, decision, value_json, actor_id, reason, decided_at,
             effective_source_refs_json, supersedes_decision_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          decision.decisionId,
          candidate.candidateId,
          decision.field,
          decision.decision,
          decision.value === undefined ? null : JSON.stringify(decision.value),
          decision.actorId,
          decision.reason,
          decision.decidedAt,
          JSON.stringify(decision.effectiveSourceRefs ?? []),
          decision.supersedesDecisionId,
        )
      }
      const receipt = commitWorkflowReceipt(handle, {
        input,
        action,
        actor,
        candidate: updated,
        payloadDigest,
        sourceRefs: [],
      })
      enqueueLearningReconcile(handle, 'candidate', updated.candidateId, now)
      return receipt
    })
  }

  /** Read a durable receipt by opaque id. */
  getReceipt(receiptId: ReceiptId, actor: ActorView): ExperienceDomainReceipt {
    requireOwner(actor, 'read command receipts')
    return readReceipt(this.database.handle, receiptId)
  }

  /** Read unexpired canonical suggestion-save receipts for disposable sidecar repair. */
  listSuggestionSaveReceipts(actor: ActorView, asOf = new Date()): SuggestionSaveDomainReceipt[] {
    requireOwner(actor, 'reconcile saved Experience suggestions')
    const rows = this.database.handle.prepare(
      `SELECT receipt_id FROM domain_receipts
        WHERE action = 'suggestion.save'
          AND json_extract(payload_json, '$.expiresAt') > ?
        ORDER BY commit_sequence`,
    ).all(asOf.toISOString()) as Array<{ receipt_id: string }>
    return rows
      .map(row => requireSuggestionSaveReceipt(readReceipt(this.database.handle, row.receipt_id)))
  }

  /** Read an immutable published version by opaque id. */
  getVersion(experienceVersionId: ExperienceVersionId, actor: ActorView): ExperienceVersionView {
    const version = readVersion(this.database.handle, experienceVersionId)
    if (actor.authority !== 'owner' && version.privacyClass !== 'public') {
      throw new ExperienceError('principal_unauthorized', 'this actor cannot read the requested Experience version')
    }
    return version
  }

  /** Read the current durable summary for one already-resolved actor. */
  getStatus(actor: ActorView): ExperienceStatusView {
    requireOwner(actor, 'read Experience management status')
    const counts = this.database.handle.prepare(
      `SELECT
         (SELECT COUNT(*) FROM candidates) AS candidate_count,
         (SELECT COUNT(*) FROM experience_versions) AS version_count`,
    ).get() as { candidate_count: number; version_count: number }
    const latestRow = this.database.handle.prepare(
      `SELECT receipt_id FROM domain_receipts
        WHERE action = 'diagnostic.publish' OR action LIKE 'candidate.%' OR action = 'suggestion.save'
        ORDER BY commit_sequence DESC LIMIT 1`,
    ).get() as { receipt_id: string } | undefined
    const latestReceipt = latestRow === undefined ? null : (() => {
      const receipt = readReceipt(this.database.handle, latestRow.receipt_id)
      return receipt.action === 'suggestion.save' ? receipt : requireCandidateReceipt(receipt)
    })()
    const latestVersion = latestReceipt?.experienceVersionId == null
      ? null
      : readVersion(this.database.handle, latestReceipt.experienceVersionId)
    const pendingPlanApprovalCount = this.database.handle.prepare(
      "SELECT COUNT(*) AS count FROM plan_approval_requests WHERE status = 'pending'",
    ).get() as { count: number }
    const latestPlanningRow = this.database.handle.prepare(
      'SELECT usage_id FROM experience_usages ORDER BY created_at DESC, usage_id DESC LIMIT 1',
    ).get() as { usage_id: string } | undefined
    const latestForgetRow = this.database.handle.prepare(
      'SELECT forget_request_id FROM forget_requests ORDER BY created_at DESC, forget_request_id DESC LIMIT 1',
    ).get() as { forget_request_id: string } | undefined
    return {
      actor,
      principalId: actor.principalId,
      candidateCount: counts.candidate_count,
      versionCount: counts.version_count,
      latestReceipt,
      latestVersion,
      pendingPlanApprovalCount: pendingPlanApprovalCount.count,
      latestPlanning: latestPlanningRow === undefined ? null : readPlanningResult(this.database.handle, latestPlanningRow.usage_id),
      latestForgetRequest: latestForgetRow === undefined
        ? null : readForgetRequest(this.database.handle, latestForgetRow.forget_request_id),
    }
  }

  /** List each Series' current immutable version for bounded M3 retrieval. */
  listPlanningVersions(actor: ActorView, limit: number): ExperienceVersionView[] {
    requireOwner(actor, 'match Experience versions')
    const rows = this.database.handle.prepare(
      `SELECT v.experience_version_id
         FROM experience_series s
         JOIN experience_versions v ON v.experience_version_id = s.current_version_id
        WHERE s.lifecycle_projection = 'active'
        ORDER BY v.created_at DESC, v.experience_version_id DESC LIMIT ?`,
    ).all(limit) as Array<{ experience_version_id: string }>
    return rows.map(row => readVersion(this.database.handle, row.experience_version_id))
  }

  /** Read every current active immutable Version for the rebuildable retrieval sidecar. */
  listActiveVersionsForProjection(actor: ActorView): ExperienceVersionView[] {
    requireOwner(actor, 'project active Experience versions')
    const rows = this.database.handle.prepare(
      `SELECT v.experience_version_id
         FROM experience_series s
         JOIN experience_versions v ON v.experience_version_id = s.current_version_id
        WHERE s.lifecycle_projection = 'active'
        ORDER BY v.experience_version_id`,
    ).all() as Array<{ experience_version_id: string }>
    return rows.map(row => readVersion(this.database.handle, row.experience_version_id))
  }

  /**
   * Stream every active Series' current version as a narrow retrieval projection
   * for global matching, without a candidate window. Unlike listPlanningVersions
   * this carries no LIMIT; it is the legal read that lets an old, still-active
   * current version enter the ranking before the matcher applies top-N.
   *
   * This returns only a read-only projection for matching — it is NOT an
   * authoritative ExperienceVersionView and must never flow into Preflight or
   * Composition. The authoritative, validated full version for any selected
   * candidate is read through matchPlanningVersions in the same read snapshot.
   *
   * Consistency: page boundaries are only positionally consistent under the
   * caller's read snapshot (see matchPlanningVersions); this method does not
   * establish one. Memory stays bounded: one page of projection rows is
   * materialized at a time and then released.
   */
  *listMatchingVersions(actor: ActorView): Generator<ExperienceMatchProjection> {
    requireOwner(actor, 'match Experience versions')
    const pageSize = 128
    let offset = 0
    while (true) {
      const rows = this.database.handle.prepare(
        `SELECT v.experience_version_id, v.experience_id, s.kind, v.title, v.intent,
                v.scope_json,
                json_extract(v.payload_json, '$.validity') AS validity_json,
                json_extract(v.payload_json, '$.riskAndEffectSpec') AS risk_effect_json,
                v.privacy_class,
                v.allowed_use_modes_json, v.evidence_grade, v.content_digest
           FROM experience_series s
           JOIN experience_versions v ON v.experience_version_id = s.current_version_id
          WHERE s.lifecycle_projection = 'active'
          ORDER BY v.created_at DESC, v.experience_version_id DESC
          LIMIT ? OFFSET ?`,
      ).all(pageSize, offset) as Array<{
        experience_version_id: string
        experience_id: string
        kind: import('../types.js').ExperienceVersionView['kind']
        title: string
        intent: string
        scope_json: string
        validity_json: string
        risk_effect_json: string
        privacy_class: 'public' | 'workspace' | 'restricted' | 'secret_reference_only'
        allowed_use_modes_json: string
        evidence_grade: import('../types.js').ExperienceVersionView['evidenceGrade']
        content_digest: string
      }>
      if (rows.length === 0) return
      const versionIds = rows.map(row => row.experience_version_id)
      const placeholders = versionIds.map(() => '?').join(', ')
      const componentRows = this.database.handle.prepare(
        `SELECT vc.experience_version_id, r.component_revision_id, c.component_id,
                c.semantic_role, r.content_text
           FROM experience_version_components vc
           JOIN component_revisions r ON r.component_revision_id = vc.component_revision_id
           JOIN experience_components c ON c.component_id = r.component_id
          WHERE vc.experience_version_id IN (${placeholders})
          ORDER BY vc.experience_version_id, vc.ordinal`,
      ).all(...versionIds) as Array<{
        experience_version_id: string
        component_revision_id: string
        component_id: string
        semantic_role: string
        content_text: string
      }>
      const componentsByVersion = new Map<string, Array<{
        component_revision_id: string
        component_id: string
        semantic_role: import('../types.js').ComponentRole
        content_text: string
      }>>()
      for (const component of componentRows) {
        const semanticRole = component.semantic_role as import('../types.js').ComponentRole
        const list = componentsByVersion.get(component.experience_version_id)
        if (list === undefined) componentsByVersion.set(component.experience_version_id, [{
          component_revision_id: component.component_revision_id,
          component_id: component.component_id,
          semantic_role: semanticRole,
          content_text: component.content_text,
        }])
        else list.push({
          component_revision_id: component.component_revision_id,
          component_id: component.component_id,
          semantic_role: semanticRole,
          content_text: component.content_text,
        })
      }
      for (const row of rows) {
        const components = componentsByVersion.get(row.experience_version_id) ?? []
        yield {
          experienceVersionId: row.experience_version_id as ExperienceVersionId,
          experienceId: row.experience_id as ExperienceId,
          kind: row.kind,
          title: row.title,
          intent: row.intent,
          scope: JSON.parse(row.scope_json) as Record<string, string>,
          validity: JSON.parse(row.validity_json) as Record<string, string>,
          riskAndEffectSpec: JSON.parse(row.risk_effect_json) as Record<string, string>,
          privacyClass: row.privacy_class,
          allowedUseModes: JSON.parse(row.allowed_use_modes_json) as import('../types.js').AllowedUseMode[],
          evidenceGrade: row.evidence_grade,
          contentDigest: row.content_digest,
          componentRevisionIds: components.map(component => component.component_revision_id as ComponentRevisionId),
          components: components.map(component => ({
            componentId: component.component_id as ComponentId,
            componentRevisionId: component.component_revision_id as ComponentRevisionId,
            role: component.semantic_role,
            content: component.content_text,
          })),
        }
      }
      offset += rows.length
      if (rows.length < pageSize) return
    }
  }

  /**
   * Read the final MatchSet for the real planning entry inside one synchronous
   * read snapshot: the whole scan, the global ranking, and the authoritative
   * full-version validation of every selected candidate share the same database
   * snapshot. WAL writers may commit concurrently, but cannot shift the rows
   * visible to this scan. Selected versions must pass stored consistency checks.
   * All reads finish before any await. The snapshot is
   * released before the caller resumes asynchronous Observation or writes.
   */
  matchPlanningVersions(
    actor: ActorView,
    fingerprint: TaskFingerprintView,
    candidateLimit: number,
    now: string,
    task?: PlanningTaskInput,
    retrieval?: HybridRetrievalOperation,
  ): { readonly matchSet: MatchSetView; readonly versions: ExperienceVersionView[] } {
    requireOwner(actor, 'match Experience versions')
    const handle = this.database.handle
    handle.exec('BEGIN')
    try {
      const eligibility = task === undefined ? permissiveEligibility() : matchingEligibilityFor(task)
      const { matchSet, selectedProjections } = retrieval === undefined
        ? selectMatchingExperiences(
            fingerprint, this.listMatchingVersions(actor), candidateLimit, now, eligibility,
          )
        : selectHybridMatchingExperiences(
            fingerprint, this.listMatchingVersions(actor), candidateLimit, now, eligibility, retrieval,
          )
      const versions = selectedProjections.map(projection => readVersion(handle, projection.experienceVersionId))
      handle.exec('COMMIT')
      return { matchSet, versions }
    } catch (error) {
      handle.exec('ROLLBACK')
      throw error
    }
  }

  /** Declare one source-bound canonical relation after validating both endpoints and relation invariants. */
  async declareRelation(
    input: DeclareExperienceRelationInput,
    actor: ActorView,
  ): Promise<RelationDomainReceipt> {
    requireOwner(actor, 'declare Experience relations')
    const payloadDigest = sha256(canonicalJson({ action: 'relation.declare', actor, input }))
    return this.database.write(handle => {
      const existing = deduplicatedRelationReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      validateRelationInput(handle, input)
      const now = new Date().toISOString()
      const relationId = id<'ExperienceRelationId', ExperienceRelationId>()
      const decisionId = randomUUID()
      const relation: ExperienceRelationView = {
        relationId,
        relationType: input.relationType,
        sourceObjectRef: input.sourceObjectRef,
        targetObjectRef: input.targetObjectRef,
        scope: input.scope,
        qualifiers: input.qualifiers,
        validFrom: input.validFrom,
        validTo: input.validTo,
        evidenceIds: input.evidenceIds,
        status: 'active',
        createdByDecisionId: decisionId,
        createdAt: now,
      }
      handle.prepare(
        `INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(decisionId, actor.actorId, JSON.stringify({
        subjectRef: relationId,
        decisionType: 'declare_relation',
        outcome: 'accepted',
        authority: actor.authority,
        reasonCode: 'source_bound_relation_reviewed',
      }), now)
      handle.prepare(
        `INSERT INTO experience_relations
          (relation_id, relation_type, source_kind, source_id, target_kind, target_id,
           status, valid_from, valid_to, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(relationId, input.relationType, input.sourceObjectRef.kind, input.sourceObjectRef.id,
        input.targetObjectRef.kind, input.targetObjectRef.id, input.validFrom, input.validTo,
        JSON.stringify(relation), now)
      assertRelationGraph(handle, relation)
      enqueueLearningReconcile(handle, 'relation', relation.relationId, now)
      return commitRelationReceipt(handle, {
        input,
        action: 'relation.declare',
        actor,
        relationId,
        overrideDecisionId: null,
        payloadDigest,
        createdAt: now,
      })
    })
  }

  /** Read one canonical relation. */
  getRelation(relationId: ExperienceRelationId, actor: ActorView): ExperienceRelationView {
    requireOwner(actor, 'read Experience relations')
    return readRelation(this.database.handle, relationId)
  }

  /** List relations touching an exact object, preserving status and validity. */
  listRelations(
    objectRef: import('../types.js').ExperienceRelationObjectRef,
    actor: ActorView,
  ): ExperienceRelationView[] {
    requireOwner(actor, 'read Experience relations')
    return listRelationsForObject(this.database.handle, objectRef)
  }

  /** Build the current relation map directly from the sole canonical relation table. */
  getRelationMap(actor: ActorView): RelationMapView {
    requireOwner(actor, 'read the Experience relation map')
    return buildRelationMap(this.database.handle)
  }

  /** Evaluate measured SQLite demand without authorizing or performing a storage migration. */
  async evaluateInfrastructureReadiness(
    input: EvaluateInfrastructureReadinessInput,
    actor: ActorView,
  ): Promise<InfrastructureDomainReceipt> {
    requireOwner(actor, 'evaluate relation-map storage readiness')
    const payloadDigest = digest({ action: 'infrastructure.evaluate', actorId: actor.actorId, input })
    return this.database.write(handle => {
      const existing = deduplicatedInfrastructureReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const started = performance.now()
      const map = buildRelationMap(handle)
      const queryDurationMs = Math.max(0, performance.now() - started)
      const signals = {
        measured_query_bottleneck: false,
        stable_multi_hop_demand: false,
        rebuild_and_rollback_proven: false,
      } as const
      const blockers = Object.entries(signals).filter(([, present]) => !present).map(([signal]) => signal)
      const now = new Date().toISOString()
      const evaluation: InfrastructureReadinessEvaluationView = {
        evaluationId: id<'ExperienceInfrastructureReadinessEvaluationId', InfrastructureReadinessEvaluationId>(),
        contractId: 'graph-storage-readiness-v1',
        relationCount: map.edges.length,
        nodeCount: map.nodes.length,
        queryDurationMs,
        queryObservationRefs: [],
        currentStoreFailureRefs: [],
        latencyAndScaleMetrics: {
          sampleCount: 1,
          p95QueryDurationMs: queryDurationMs,
          relationCount: map.edges.length,
          nodeCount: map.nodes.length,
        },
        consistencyAssessment: 'not_evaluated',
        candidateMigrationCost: null,
        rollbackEvidenceRefs: [],
        signals,
        decision: blockers.length === 0 ? 'ready_for_review' : 'not_ready',
        blockers,
        evaluatedAt: now,
      }
      handle.prepare(
        `INSERT INTO infrastructure_readiness_evaluations (evaluation_id, payload_json, created_at)
         VALUES (?, ?, ?)`,
      ).run(evaluation.evaluationId, JSON.stringify(evaluation), now)
      return commitInfrastructureReceipt(handle, { input, actor, payloadDigest, evaluation, createdAt: now })
    })
  }

  /** Read the current graph-storage readiness decision and latest frozen evaluation. */
  getInfrastructureReadiness(actor: ActorView): InfrastructureReadinessView {
    requireOwner(actor, 'read relation-map storage readiness')
    const row = this.database.handle.prepare(
      'SELECT payload_json FROM infrastructure_readiness_evaluations ORDER BY created_at DESC, evaluation_id DESC LIMIT 1',
    ).get() as { payload_json: string } | undefined
    const latestEvaluation = row === undefined ? null
      : parsePlanningObject<InfrastructureReadinessEvaluationView>(row.payload_json, 'InfrastructureReadinessEvaluation')
    return {
      contract: infrastructureReadinessContract(),
      latestEvaluation,
      decision: latestEvaluation?.decision ?? 'not_ready',
    }
  }

  /** Read current canonical relations touching any bounded planning version or component. */
  listActivePlanningRelations(
    versionIds: readonly ExperienceVersionId[],
    actor: ActorView,
    now: string,
  ): ExperienceRelationView[] {
    requireOwner(actor, 'read planning relations')
    if (versionIds.length === 0) return []
    const versionSet = new Set<string>(versionIds)
    const placeholders = versionIds.map(() => '?').join(', ')
    const componentRows = this.database.handle.prepare(
      `SELECT DISTINCT c.component_id
         FROM experience_version_components vc
         JOIN component_revisions cr ON cr.component_revision_id = vc.component_revision_id
         JOIN experience_components c ON c.component_id = cr.component_id
        WHERE vc.experience_version_id IN (${placeholders})`,
    ).all(...versionIds) as Array<{ component_id: string }>
    const componentSet = new Set(componentRows.map(row => row.component_id))
    const rows = this.database.handle.prepare(
      `SELECT relation_id FROM experience_relations
        WHERE status = 'active' AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY created_at, relation_id`,
    ).all(now, now) as Array<{ relation_id: string }>
    return rows.map(row => readRelation(this.database.handle, row.relation_id)).filter(relation =>
      planningEndpointMatches(relation.sourceObjectRef, versionSet, componentSet)
      || planningEndpointMatches(relation.targetObjectRef, versionSet, componentSet))
  }

  /**
   * Resolve the transitive `requires` closure of already-selected contributions,
   * bypassing top-K retrieval. `baseVersions` are the authoritative versions that
   * actually contributed to the Plan. Every required version endpoint is resolved
   * to an exact, legal, current-active revision; every component endpoint is
   * resolved to the single current-active version that owns it. A required
   * version that cannot be read, has been Forgot, is superseded, is ambiguous
   * across current versions, or whose endpoint has no deterministic exact revision
   * is recorded as unsatisfiable (the Plan must block) instead of being silently
   * skipped. The returned relation set is the union of every active relation
   * touching the closure.
   */
  loadRequiredDependencyClosure(
    actor: ActorView,
    baseVersions: readonly ExperienceVersionView[],
    now: string,
  ): DependencyClosure {
    requireOwner(actor, 'resolve Experience required dependencies')
    const handle = this.database.handle
    const activeRelations = (handle.prepare(
      `SELECT relation_id FROM experience_relations
        WHERE status = 'active' AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY created_at, relation_id`,
    ).all(now, now) as Array<{ relation_id: string }>).map(row => readRelation(handle, row.relation_id))

    const versions = new Map<string, ExperienceVersionView>(
      baseVersions.map(version => [version.experienceVersionId, version as ExperienceVersionView]),
    )
    const componentIds = new Set<string>(
      baseVersions.flatMap(version => version.components.map(component => component.componentId)),
    )
    const unsatisfiable: UnsatisfiableDependency[] = []
    const requirements: ResolvedRequirement[] = []
    const endpointKnown = (ref: ExperienceRelationObjectRef): boolean => {
      if (ref.kind === 'version') return versions.has(ref.id)
      if (ref.kind === 'component') return componentIds.has(ref.id)
      return false
    }
    const processed = new Set<string>()
    let changed = true
    while (changed) {
      changed = false
      for (const relation of activeRelations) {
        if (relation.relationType !== 'requires') continue
        if (processed.has(relation.relationId)) continue
        if (!endpointKnown(relation.sourceObjectRef)) continue
        processed.add(relation.relationId)
        const resolution = resolveRequiredTarget(handle, relation.targetObjectRef)
        if (!resolution.resolved) {
          const failure: UnsatisfiableDependency = {
            relationId: relation.relationId,
            sourceObjectRef: relation.sourceObjectRef,
            targetObjectRef: relation.targetObjectRef,
            reasonCode: resolution.reasonCode,
            message: resolution.message,
          }
          unsatisfiable.push(failure)
          requirements.push({ relationId: relation.relationId, sourceObjectRef: relation.sourceObjectRef,
            targetObjectRef: relation.targetObjectRef, targetVersion: null, unsatisfiable: failure })
          continue
        }
        const version = resolution.version
        requirements.push({ relationId: relation.relationId, sourceObjectRef: relation.sourceObjectRef,
          targetObjectRef: relation.targetObjectRef, targetVersion: version, unsatisfiable: null })
        if (!versions.has(version.experienceVersionId)) {
          versions.set(version.experienceVersionId, version)
          for (const component of version.components) componentIds.add(component.componentId)
          changed = true
        }
      }
    }
    const relations = activeRelations.filter(relation =>
      endpointKnown(relation.sourceObjectRef) || endpointKnown(relation.targetObjectRef))
    const orderedVersions = [...versions.values()].sort((left, right) =>
      String(left.experienceVersionId).localeCompare(String(right.experienceVersionId)))
    const orderedRelations = relations.sort((left, right) =>
      String(left.relationId).localeCompare(String(right.relationId)))
    const orderedRequirements = requirements.sort((left, right) =>
      String(left.relationId).localeCompare(String(right.relationId)))
    return { versions: orderedVersions, relations: orderedRelations, requirements: orderedRequirements, unsatisfiable }
  }

  /** Read exact unexpired override decisions requested for the current Usage. */
  listActiveOverrides(
    overrideDecisionIds: readonly OverrideDecisionId[],
    actor: ActorView,
    now: string,
  ): OverrideDecisionView[] {
    requireOwner(actor, 'read planning overrides')
    return overrideDecisionIds.map(overrideDecisionId => readOverride(this.database.handle, overrideDecisionId))
      .filter(decision => Date.parse(decision.validFrom) <= Date.parse(now)
        && Date.parse(decision.validTo) > Date.parse(now))
  }

  /** Persist a current-scope override for one active Experience conflict. */
  async createOverride(
    input: CreateOverrideDecisionInput,
    actor: ActorView,
  ): Promise<RelationDomainReceipt> {
    requireOwner(actor, 'override an Experience conflict')
    const payloadDigest = sha256(canonicalJson({ action: 'override.create', actor, input }))
    return this.database.write(handle => {
      const existing = deduplicatedRelationReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const relation = readRelation(handle, input.targetRelationId)
      if (relation.relationType !== 'conflicts_with' || relation.status !== 'active') {
        throw new ExperienceError('invalid_command', 'Override requires one active conflicts_with relation')
      }
      nonEmptyStringRecord(input.exactScope, 'Override exactScope')
      if (input.replacementInstruction.trim() === '' || input.reason.trim() === '') {
        throw new ExperienceError('required_field_missing', 'Override instruction and reason are required')
      }
      const now = new Date().toISOString()
      if (!validInstant(input.validUntil) || Date.parse(input.validUntil) <= Date.parse(now)) {
        throw new ExperienceError('invalid_command', 'Override validUntil must be a future timestamp')
      }
      const overrideDecisionId = id<'ExperienceOverrideDecisionId', OverrideDecisionId>()
      const decision: OverrideDecisionView = {
        overrideDecisionId,
        targetRelationId: input.targetRelationId,
        replacementInstruction: input.replacementInstruction,
        exactScope: input.exactScope,
        validFrom: now,
        validTo: input.validUntil,
        actorRef: actor.actorId,
        reason: input.reason,
        nonOverridableChecks: ['safety', 'permission', 'privacy', 'legal', 'task_requirement', 'unknown_side_effect'],
        createdAt: now,
      }
      handle.prepare(
        `INSERT INTO override_decisions
          (override_decision_id, target_relation_id, actor_id, valid_until, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(overrideDecisionId, input.targetRelationId, actor.actorId, input.validUntil,
        JSON.stringify(decision), now)
      return commitRelationReceipt(handle, {
        input,
        action: 'override.create',
        actor,
        relationId: input.targetRelationId,
        overrideDecisionId,
        payloadDigest,
        createdAt: now,
      })
    })
  }

  /** Read one current-scope override decision. */
  getOverride(overrideDecisionId: OverrideDecisionId, actor: ActorView): OverrideDecisionView {
    requireOwner(actor, 'read Experience overrides')
    return readOverride(this.database.handle, overrideDecisionId)
  }

  /** Preview the exact current impact of retiring one Experience from future recall. */
  previewForget(experienceId: ExperienceId, actor: ActorView): ForgetImpactPreviewView {
    requireOwner(actor, 'preview Experience Forget impact')
    return buildForgetImpactPreview(this.database.handle, experienceId, new Date().toISOString())
  }

  /** Commit canonical no-retrieval and durable Forget work before any cross-store cleanup. */
  async forgetExperience(input: ForgetExperienceInput, actor: ActorView): Promise<ForgetDomainReceipt> {
    requireOwner(actor, 'forget an Experience')
    const payloadDigest = sha256(canonicalJson({ action: 'experience.forget', actor, input }))
    return this.database.write(handle => {
      const existing = deduplicatedForgetReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const preview = buildForgetImpactPreview(handle, input.experienceId, input.issuedAt)
      if (preview.expectedSeriesRevision !== input.expectedSeriesRevision) {
        throw new ExperienceError('stale_revision', 'Experience series changed after the Forget preview')
      }
      if (preview.previewDigest !== input.previewDigest) {
        throw new ExperienceError('stale_revision', 'Forget impact changed after the preview')
      }
      const now = new Date().toISOString()
      const requestId = id<'ExperienceForgetRequestId', ForgetRequestId>()
      const changed = handle.prepare(
        `UPDATE experience_series
            SET lifecycle_projection = 'retired', series_revision = series_revision + 1
          WHERE experience_id = ? AND series_revision = ? AND lifecycle_projection = 'active'`,
      ).run(input.experienceId, input.expectedSeriesRevision)
      if (changed.changes !== 1) {
        throw new ExperienceError('stale_revision', 'Experience series is no longer active at the preview revision')
      }
      const request = {
        forgetRequestId: requestId,
        experienceId: input.experienceId,
        currentVersionId: preview.currentVersionId,
        state: 'processing' as const,
        reason: input.reason,
        requestedBy: actor.actorId,
        previewDigest: preview.previewDigest,
        canonicalRecallStoppedAt: now,
        irreversibleHistory: preview.immutableHistory,
        requestedAt: now,
        updatedAt: now,
      }
      handle.prepare(
        `INSERT INTO forget_requests
          (forget_request_id, experience_id, state, payload_json, created_at, updated_at)
         VALUES (?, ?, 'processing', ?, ?, ?)`,
      ).run(requestId, input.experienceId, JSON.stringify(request), now, now)
      insertForgetStep(handle, requestId, 'recall_stop', 'completed', 'canonical_retrieval_stopped',
        [String(input.experienceId)], now, now)
      insertForgetStep(handle, requestId, 'context_retirement',
        preview.activeContextTargets.length === 0 ? 'not_applicable' : 'pending',
        preview.activeContextTargets.length === 0 ? 'no_active_context' : 'active_context_retirement_pending',
        preview.activeContextTargets.map(target => String(target.contextDeliveryId)), now,
        preview.activeContextTargets.length === 0 ? now : null)
      insertForgetStep(handle, requestId, 'vault_content', 'not_applicable',
        'governed_content_vault_not_enabled', [], now, now)
      insertForgetStep(handle, requestId, 'projection_invalidation', 'pending',
        'projection_rebuild_pending', [LEARNING_PROJECTION_KEY], now, null)
      insertForgetStep(handle, requestId, 'tombstone', 'completed', 'forget_tombstone_committed',
        [String(input.experienceId)], now, now)
      const insertTarget = handle.prepare(
        `INSERT INTO forget_context_targets
          (forget_request_id, context_delivery_id, state, context_retirement_id, reason_code, updated_at)
         VALUES (?, ?, 'pending', NULL, 'retirement_not_started', ?)`,
      )
      for (const target of preview.activeContextTargets) {
        insertTarget.run(requestId, target.contextDeliveryId, now)
      }
      handle.prepare(
        `INSERT INTO forget_tombstones (experience_id, forget_request_id, forgotten_at)
         VALUES (?, ?, ?)`,
      ).run(input.experienceId, requestId, now)
      enqueueLearningReconcile(handle, 'forget_request', requestId, now)
      return commitForgetReceipt(handle, { input, actor, requestId, payloadDigest,
        seriesRevision: input.expectedSeriesRevision + 1, createdAt: now })
    })
  }

  /** Read one durable Forget aggregate and its current cleanup results. */
  getForgetRequest(forgetRequestId: string, actor: ActorView): ForgetRequestView {
    requireOwner(actor, 'read an Experience Forget request')
    return readForgetRequest(this.database.handle, forgetRequestId)
  }

  /** Read the Context deliveries selected by a committed Forget preview. */
  listForgetContextDeliveries(forgetRequestId: string, actor: ActorView): ContextDeliveryView[] {
    requireOwner(actor, 'resume Experience Context retirement')
    readForgetRequest(this.database.handle, forgetRequestId)
    const rows = this.database.handle.prepare(
      `SELECT d.payload_json
         FROM forget_context_targets t
         JOIN context_deliveries d ON d.context_delivery_id = t.context_delivery_id
        WHERE t.forget_request_id = ? AND t.state <> 'retired'
        ORDER BY t.context_delivery_id`,
    ).all(forgetRequestId) as Array<{ payload_json: string }>
    return rows.map(row => parsePlanningObject<ContextDeliveryView>(row.payload_json, 'ContextDelivery'))
  }

  /** Bind one durable Session retirement to its Forget target. */
  async linkForgetContextRetirement(
    forgetRequestId: string,
    contextDeliveryId: string,
    contextRetirementId: string | null,
    status: 'pending' | 'retired' | 'unknown' | 'failed',
    reasonCode: string,
  ): Promise<void> {
    await this.database.write(handle => {
      const now = new Date().toISOString()
      const changed = handle.prepare(
        `UPDATE forget_context_targets
            SET state = ?, context_retirement_id = ?, reason_code = ?, updated_at = ?
          WHERE forget_request_id = ? AND context_delivery_id = ? AND state <> 'retired'`,
      ).run(status, contextRetirementId, reasonCode, now, forgetRequestId, contextDeliveryId)
      if (changed.changes !== 1) {
        const existing = handle.prepare(
          `SELECT state FROM forget_context_targets
            WHERE forget_request_id = ? AND context_delivery_id = ?`,
        ).get(forgetRequestId, contextDeliveryId) as { state: string } | undefined
        if (existing?.state !== 'retired') throw new ExperienceError('not_found', 'Forget Context target was not found')
      }
      reconcileForgetContextStep(handle, forgetRequestId, now)
    })
  }

  /** Record whether rebuildable projections were invalidated after canonical Forget. */
  async finishForgetProjection(forgetRequestId: string, failureReason?: string): Promise<ForgetRequestView> {
    return this.database.write(handle => {
      readForgetRequest(handle, forgetRequestId)
      const now = new Date().toISOString()
      updateForgetStep(handle, forgetRequestId, 'projection_invalidation',
        failureReason === undefined ? 'completed' : 'failed',
        failureReason === undefined ? 'projection_rebuilt_without_forgotten_series' : failureReason,
        [LEARNING_PROJECTION_KEY], now)
      reconcileForgetRequestState(handle, forgetRequestId, now)
      return readForgetRequest(handle, forgetRequestId)
    })
  }

  /** Persist one complete M3 planning projection in a single transaction. */
  async createPlanningResult(
    input: PlanTaskCommandInput,
    planning: PlanningResultView,
    actor: ActorView,
    historyRanking?: HistoryRankingApplyTicket,
  ): Promise<PlanningCommandResult> {
    requireOwner(actor, 'create Experience usage plans')
    validatePlanningResult(planning)
    const payloadDigest = planningPayloadDigest('usage.plan', actor, input)
    return this.database.write(handle => {
      const existing = planningDeduplicatedReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return {
        receipt: existing,
        planning: readPlanningResult(handle, existing.usageId),
      }
      if (planning.matchSet.recallDecisionKey !== undefined
        && planning.matchSet.recallDecisionKey !== null
        && handle.prepare(
          "SELECT 1 FROM match_sets WHERE json_extract(payload_json, '$.recallDecisionKey') = ? LIMIT 1",
        ).get(planning.matchSet.recallDecisionKey) !== undefined) {
        throw new ExperienceError('idempotency_conflict', 'RecallDecisionKey already produced a durable MatchSet')
      }
      // Claim the authorized history-ranking reorder in the SAME transaction as the Plan save.
      if (historyRanking?.authorized === true) {
        this.verifyAndClaimHistoryRankingApply(handle, planning, historyRanking, actor)
      }
      // A3: close the scan -> persist boundary inside the same transaction owner. Between the
      // scan in matchPlanningVersions and this committed write another SQLite connection may
      // have Forgot or superseded a selected version; never persist a Plan whose selected
      // contributions reference a version that is no longer the active current version.
      for (const contribution of planning.plan.selectedContributions) {
        if (isCurrentActiveVersion(handle, contribution.experienceVersionId)) continue
        throw new ExperienceError('stale_revision', 'Selected Experience version is no longer current')
      }
      const now = planning.plan.createdAt
      handle.prepare(
        'INSERT INTO match_sets (match_set_id, payload_json, created_at) VALUES (?, ?, ?)',
      ).run(planning.matchSet.matchSetId, JSON.stringify(planning.matchSet), planning.matchSet.createdAt)
      const insertPreflight = handle.prepare(
        'INSERT INTO preflight_records (preflight_id, payload_json, created_at) VALUES (?, ?, ?)',
      )
      for (const preflight of planning.preflights) {
        insertPreflight.run(preflight.preflightId, JSON.stringify(preflight), preflight.checkedAt)
      }
      handle.prepare(
        `INSERT INTO usage_plans
          (usage_plan_id, usage_id, plan_revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(planning.plan.usagePlanId, planning.plan.usageId, planning.plan.planRevision,
        JSON.stringify(planning.plan), planning.plan.createdAt)
      handle.prepare(
        `INSERT INTO experience_usages
          (usage_id, revision, state, payload_json, created_at) VALUES (?, 1, ?, ?, ?)`,
      ).run(planning.plan.usageId, usageState(planning), JSON.stringify(planning), now)
      if (planning.approvalRequest !== null) insertPlanApprovalRequest(handle, planning.approvalRequest)
      insertAdmissionAttempt(handle, planning.admissionAttempt)
      const receipt = commitPlanningReceipt(handle, {
        input,
        action: 'usage.plan',
        actor,
        planning,
        payloadDigest,
      })
      enqueueLearningReconcile(handle, 'usage', planning.plan.usageId, now)
      return { receipt, planning }
    })
  }

  /** Verify the gate still authorizes inside the save transaction, then claim once per Usage. */
  protected verifyAndClaimHistoryRankingApply(
    handle: DatabaseSync,
    planning: PlanningResultView,
    ticket: HistoryRankingApplyTicket,
    actor: ActorView,
  ): void {
    const contract = readUnlockContractForCapability(handle, HISTORY_RANKING_CAPABILITY)
    const capability = readAutomationCapability(handle, HISTORY_RANKING_CAPABILITY)
    const evalFresh = capability.lastEvaluationId !== null
      && rankingEvaluationIsFresh(handle, readUnlockEvaluation(handle, capability.lastEvaluationId))
    const scopeInput: HistoryRankingGateInput = {
      workspaceRoot: ticket.scope.workspaceRoot,
      targetExposure: ticket.scope.targetExposure,
      riskClass: ticket.scope.riskClass,
      environmentKey: ticket.environmentKey,
      taskInputDigest: ticket.taskInputDigest,
      candidates: [],
    }
    const scoped = rankingScopeAdmitted(capability.allowedScope, contract.excludedRiskClasses, scopeInput)
    const exhausted = rankingRolloutExhausted(handle, capability, contract, ticket.governanceDecisionId)
    // The ticket must still match the CURRENT policy identity: same authorize decision/evaluation and
    // same policy/contract revision. A demote + re-promote (new policy) or any policy change means an
    // old ticket cannot claim the new permission/quota.
    const policyIdentity = ticket.governanceDecisionId === capability.lastDecisionId
      && ticket.evaluationId === (capability.lastEvaluationId === null ? null : String(capability.lastEvaluationId))
      && ticket.policyRevision === capability.policyRevision
      && ticket.contractRevision === contract.contractVersion
    if (capability.currentLevel !== 'suggest' || !evalFresh || !scoped || exhausted
      || !policyIdentity || ticket.governanceDecisionId === null) {
      throw new ExperienceError('stale_revision', 'history-ranking gate no longer authorizes at plan save')
    }
    // One apply per Usage per authorize decision; a duplicate is a no-op (idempotent), never a leak.
    const prior = handle.prepare(
      `SELECT 1 FROM governance_decisions
        WHERE json_extract(payload_json, '$.decisionType') = 'history_ranking.apply'
          AND json_extract(payload_json, '$.apply.usageId') = ?`,
    ).get(String(planning.plan.usageId))
    if (prior !== undefined) return
    const decisionId = randomUUID()
    const now = new Date().toISOString()
    const appliedVersionIds = [...new Set(planning.plan.selectedContributions
      .map(contribution => String(contribution.experienceVersionId)))]
    handle.prepare(
      'INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(decisionId, actor.actorId, JSON.stringify({
      subjectRef: HISTORY_RANKING_CAPABILITY,
      decisionType: 'history_ranking.apply',
      outcome: 'applied',
      authorityScope: actor.authority,
      reasonCode: 'authorized_owner_ranking',
      explanation: 'history-ranking reorder applied in a new Plan',
      evaluationId: capability.lastEvaluationId,
      decisionId: ticket.governanceDecisionId,
      apply: {
        applyId: decisionId,
        schemaVersion: 'experience-history-ranking-apply-v1',
        usageId: String(planning.plan.usageId),
        taskInputDigest: ticket.taskInputDigest,
        scope: ticket.scope,
        baselineVersionIds: ticket.baselineVersionIds,
        proposedVersionIds: ticket.proposedVersionIds,
        appliedVersionIds,
        policyRevision: capability.policyRevision,
        contractRevision: contract.contractVersion,
        createdPlanRevision: planning.plan.planRevision,
        decisionId: ticket.governanceDecisionId,
        evaluationId: ticket.evaluationId,
        createdAt: now,
      },
    }), now)
  }

  /** Read the recorded history-ranking apply records (for readback/reconstruction). */
  readHistoryRankingApplies(actor: ActorView): HistoryRankingApplyRecord[] {
    requireOwner(actor, 'read history-ranking apply records')
    const rows = this.database.handle.prepare(
      `SELECT payload_json FROM governance_decisions
        WHERE json_extract(payload_json, '$.decisionType') = 'history_ranking.apply'
        ORDER BY created_at`,
    ).all() as Array<{ payload_json: string }>
    const records: HistoryRankingApplyRecord[] = []
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>
      if (isRecord(payload.apply) && payload.apply.schemaVersion === 'experience-history-ranking-apply-v1') {
        records.push(payload.apply as unknown as HistoryRankingApplyRecord)
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /** Persist an interaction failure without fabricating a governance decision. */
  async recordPlanInteractionOutcome(
    usageId: string,
    state: Extract<AdmissionAttemptView['state'], 'interaction_interrupted' | 'pending_external_decision' | 'no_answerer_continue'>,
    reasonCode: string,
    interactionOutcome: PlanningResultView['interactionOutcome'],
    actor: ActorView,
  ): Promise<PlanningResultView> {
    requireOwner(actor, 'record Experience plan interaction outcomes')
    return this.database.write(handle => {
      const planning = readPlanningResult(handle, usageId)
      const attempt = { ...planning.admissionAttempt, state, reasonCode }
      const updated = { ...planning, admissionAttempt: attempt, interactionOutcome }
      handle.prepare(
        'UPDATE admission_attempts SET state = ?, payload_json = ? WHERE admission_attempt_id = ?',
      ).run(state, JSON.stringify(attempt), attempt.admissionAttemptId)
      updateUsageProjection(handle, updated)
      return updated
    })
  }

  /** Supersede a pending request with a new immutable plan revision and request. */
  async adaptPlan(
    usageId: string,
    reason: string,
    actor: ActorView,
  ): Promise<PlanningResultView> {
    requireOwner(actor, 'adapt Experience usage plans')
    if (reason.trim() === '') throw new ExperienceError('required_field_missing', 'plan adaptation requires a reason')
    return this.database.write(handle => {
      const planning = readPlanningResult(handle, usageId)
      const currentRequest = planning.approvalRequest
      if (currentRequest === null || currentRequest.status !== 'pending') {
        throw new ExperienceError('stale_revision', 'only a pending exact plan can be adapted')
      }
      const now = new Date().toISOString()
      const oldRequest: PlanApprovalRequestView = {
        ...currentRequest,
        status: 'superseded',
        decidedAt: now,
        decisionId: null,
        reason,
      }
      const superseded = handle.prepare(
        "UPDATE plan_approval_requests SET status = 'superseded', payload_json = ? WHERE request_id = ? AND status = 'pending'",
      ).run(JSON.stringify(oldRequest), oldRequest.requestId)
      if (superseded.changes !== 1) {
        throw new ExperienceError('stale_revision', 'PlanApprovalRequest changed before adaptation could commit')
      }
      const plan = adaptUsagePlan(planning.plan, reason, now)
      const ttl = Math.max(60_000, Date.parse(currentRequest.expiresAt) - Date.parse(currentRequest.createdAt))
      const request: PlanApprovalRequestView = {
        ...currentRequest,
        requestId: brandedId<'ExperiencePlanApprovalRequestId'>(randomUUID(), 'requestId'),
        usagePlanId: plan.usagePlanId,
        planRevision: plan.planRevision,
        status: 'pending',
        scopeDigest: currentRequest.scopeDigest,
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + ttl).toISOString(),
        decidedAt: null,
        decisionId: null,
        reason: null,
      }
      const attempt: AdmissionAttemptView = {
        admissionAttemptId: brandedId<'ExperienceAdmissionAttemptId'>(randomUUID(), 'admissionAttemptId'),
        usageId: plan.usageId,
        requestId: request.requestId,
        sessionId: planning.admissionAttempt.sessionId,
        actorId: actor.actorId,
        state: 'pending_external_decision',
        reasonCode: 'adapted_plan_decision_pending',
        createdAt: now,
      }
      handle.prepare(
        `INSERT INTO usage_plans
          (usage_plan_id, usage_id, plan_revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(plan.usagePlanId, plan.usageId, plan.planRevision, JSON.stringify(plan), now)
      insertPlanApprovalRequest(handle, request)
      insertAdmissionAttempt(handle, attempt)
      const updated: PlanningResultView = {
        ...planning,
        plan,
        approvalRequest: request,
        admissionAttempt: attempt,
        retryBinding: null,
        interactionOutcome: 'adaptation_requested',
      }
      updateUsageProjection(handle, updated)
      handle.prepare(
        `INSERT INTO audit_events
          (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
           object_refs_json, payload_digest, source_refs_json, created_at)
         VALUES (?, ?, ?, 'plan.adapt', ?, NULL, ?, ?, ?, '[]', ?)`,
      ).run(randomUUID(), actor.actorId, randomUUID(), `plan-adapt:${planning.plan.usageId}`, now,
        JSON.stringify([planning.plan.usagePlanId, plan.usagePlanId, oldRequest.requestId, request.requestId]),
        digest({ usageId, reason }), now)
      enqueueLearningReconcile(handle, 'usage', plan.usageId, now)
      return updated
    })
  }

  /** Decide the exact immutable plan and create an approved retry binding atomically. */
  async decidePlan(
    input: DecidePlanCommandInput,
    actor: ActorView,
  ): Promise<PlanningCommandResult> {
    requireOwner(actor, 'decide Experience usage plans')
    const action = input.decision === 'approve' ? 'plan.approve'
      : input.decision === 'deny' ? 'plan.deny' : 'plan.withdraw'
    const payloadDigest = planningPayloadDigest(action, actor, input)
    return this.database.write(handle => {
      const existing = planningDeduplicatedReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return { receipt: existing, planning: readPlanningResult(handle, existing.usageId) }
      const row = handle.prepare(
        'SELECT payload_json, status FROM plan_approval_requests WHERE request_id = ?',
      ).get(input.requestId) as { payload_json: string; status: string } | undefined
      if (row === undefined) throw new ExperienceError('not_found', 'PlanApprovalRequest was not found')
      const request = parsePlanningObject<PlanApprovalRequestView>(row.payload_json, 'PlanApprovalRequest')
      if (request.usagePlanId !== input.usagePlanId || request.planRevision !== input.expectedPlanRevision) {
        throw new ExperienceError('stale_revision', 'Plan decision does not name the exact current plan revision')
      }
      if (request.status !== 'pending' || row.status !== 'pending') {
        throw new ExperienceError('stale_revision', 'PlanApprovalRequest is no longer pending')
      }
      if (Date.parse(request.expiresAt) <= Date.now()) {
        throw new ExperienceError('stale_revision', 'PlanApprovalRequest has expired')
      }
      const planning = readPlanningResult(handle, request.usageId)
      if (planning.plan.contentDigest === '' || planning.plan.usagePlanId !== input.usagePlanId) {
        throw new ExperienceError('database_schema_invalid', 'PlanApprovalRequest does not reference its stored plan')
      }
      // A3: close the approval boundary inside the same transaction owner. Between the Plan
      // (:pending approval) and this decision another connection may have Forgot or superseded
      // a selected version; never mint a new valid approval for a Plan whose selected
      // Experiences are no longer the current active version or no longer allow the approved
      // use mode. Idempotency is preserved by the earlier receipt dedup; the first-consumption
      // recheck in consumeClaimAndPrepareContext is unchanged.
      if (input.decision === 'approve') {
        for (const contribution of planning.plan.selectedContributions) {
          if (!isCurrentActiveVersion(handle, contribution.experienceVersionId)) {
            throw new ExperienceError('stale_revision', 'Selected Experience version is no longer current')
          }
          const selectedVersion = readVersion(handle, contribution.experienceVersionId)
          if (!selectedVersion.allowedUseModes.includes(planning.plan.useMode)) {
            throw new ExperienceError('stale_revision', 'Selected Experience no longer allows the approved use mode')
          }
        }
      }
      const now = new Date().toISOString()
      const binding = input.decision === 'approve'
        ? createRetryBinding(planning, request, now)
        : null
      if (binding !== null) assertRetryBindingKeyAvailable(handle, binding, now)
      const decisionId = input.decision === 'withdraw' ? null : randomUUID()
      const status = input.decision === 'approve' ? 'approved'
        : input.decision === 'deny' ? 'denied' : 'withdrawn'
      const updatedRequest: PlanApprovalRequestView = {
        ...request,
        status,
        decidedAt: now,
        decisionId,
        reason: input.reason,
      }
      const decided = handle.prepare(
        'UPDATE plan_approval_requests SET status = ?, payload_json = ? WHERE request_id = ? AND status = ?',
      ).run(status, JSON.stringify(updatedRequest), request.requestId, 'pending')
      if (decided.changes !== 1) {
        throw new ExperienceError('stale_revision', 'PlanApprovalRequest changed before the decision could commit')
      }
      if (decisionId !== null) {
        handle.prepare(
          'INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
        ).run(decisionId, actor.actorId, JSON.stringify({
          subjectRef: planning.plan.usagePlanId,
          requestId: request.requestId,
          planRevision: planning.plan.planRevision,
          outcome: input.decision,
          reason: input.reason,
        }), now)
      }
      const attemptState = input.decision === 'approve' ? 'approved' : 'denied'
      const attempt: AdmissionAttemptView = {
        ...planning.admissionAttempt,
        state: attemptState,
        reasonCode: input.decision === 'approve' ? 'exact_plan_approved'
          : input.decision === 'deny' ? 'exact_plan_denied' : 'plan_request_withdrawn',
      }
      handle.prepare(
        'UPDATE admission_attempts SET state = ?, payload_json = ? WHERE admission_attempt_id = ?',
      ).run(attempt.state, JSON.stringify(attempt), attempt.admissionAttemptId)
      if (binding !== null) {
        handle.prepare(
          `INSERT INTO admission_retry_bindings
            (binding_id, actor_id, task_input_digest, state, payload_json, lease_until, created_at)
           VALUES (?, ?, ?, 'active', ?, NULL, ?)`,
        ).run(binding.bindingId, binding.actorId, binding.taskInputDigest, JSON.stringify(binding), now)
      }
      const updated: PlanningResultView = {
        ...planning,
        approvalRequest: updatedRequest,
        admissionAttempt: attempt,
        retryBinding: binding,
        interactionOutcome: input.decision === 'approve' ? 'approved'
          : input.decision === 'deny' ? 'denied' : 'interaction_interrupted',
      }
      updateUsageProjection(handle, updated)
      const receipt = commitPlanningReceipt(handle, { input, action, actor, planning: updated, payloadDigest })
      enqueueLearningReconcile(handle, 'usage', updated.plan.usageId, now)
      return { receipt, planning: updated }
    })
  }

  /** Read one complete M3 planning result. */
  getPlanningResult(usageId: string, actor: ActorView): PlanningResultView {
    requireOwner(actor, 'read Experience usage plans')
    return readPlanningResult(this.database.handle, usageId)
  }

  /** List current M3 usage projections newest first. */
  listPlanningResults(actor: ActorView, limit: number): PlanningResultView[] {
    requireOwner(actor, 'read Experience usage plans')
    const rows = this.database.handle.prepare(
      'SELECT usage_id FROM experience_usages ORDER BY created_at DESC, usage_id DESC LIMIT ?',
    ).all(limit) as Array<{ usage_id: string }>
    return rows.map(row => readPlanningResult(this.database.handle, row.usage_id))
  }

  /** Read whether a supported step-1 trigger already produced its one durable MatchSet. */
  hasRecallDecisionKey(decisionKey: string, actor: ActorView): boolean {
    requireOwner(actor, 'read recall decisions')
    if (!sha256Digest(decisionKey)) throw new ExperienceError('invalid_command', 'RecallDecisionKey is invalid')
    return this.database.handle.prepare(
      "SELECT 1 FROM match_sets WHERE json_extract(payload_json, '$.recallDecisionKey') = ? LIMIT 1",
    ).get(decisionKey) !== undefined
  }

  /** Atomically claim the only exact, unexpired retry binding for a new runtime attempt. */
  async claimAdmissionRetryBinding(input: {
    readonly taskInputDigest: string
    readonly sessionId: string
    readonly scopeDigest: string
    readonly workspaceRoot: string | null
    readonly runtimeActor: ActorView
    readonly leaseMs: number
  }): Promise<ClaimedAdmission | null> {
    return this.database.write(handle => {
      const rows = handle.prepare(
        `SELECT payload_json, lease_until FROM admission_retry_bindings
         WHERE task_input_digest = ? AND state IN ('active', 'claimed')
         ORDER BY created_at, binding_id`,
      ).all(input.taskInputDigest) as Array<{ payload_json: string; lease_until: string | null }>
      const now = new Date()
      const eligible = rows.flatMap(row => {
        const binding = parsePlanningObject<AdmissionRetryBindingView>(row.payload_json, 'AdmissionRetryBinding')
        if (binding.principalId !== input.runtimeActor.principalId) return []
        if (binding.sessionId === null
          ? binding.scopeDigest !== input.scopeDigest
          : binding.sessionId !== input.sessionId) return []
        if (Date.parse(binding.expiresAt) <= now.getTime()) {
          expireBinding(handle, binding, now.toISOString(), 'approval_expired')
          return []
        }
        if (binding.state === 'claimed' && row.lease_until !== null && Date.parse(row.lease_until) > now.getTime()) {
          return []
        }
        if (binding.state === 'claimed') {
          finishClaimedAdmissionAttempt(handle, binding, 'interrupted', 'claim_lease_expired', now.toISOString())
        }
        const planning = readPlanningResult(handle, String(binding.usageId))
        const approvedRoot = planning.fingerprint.environmentRefs[0] ?? null
        if (approvedRoot !== input.workspaceRoot) return []
        return [{ binding, planning }]
      })
      if (eligible.length === 0) return null
      if (eligible.length > 1) {
        throw new ExperienceError('idempotency_conflict', 'More than one retry binding matches the exact admission input')
      }
      const candidate = eligible[0]!
      const attempt: AdmissionAttemptView = {
        admissionAttemptId: brandedId<'ExperienceAdmissionAttemptId'>(randomUUID(), 'admissionAttemptId'),
        usageId: candidate.planning.plan.usageId,
        requestId: candidate.binding.requestId,
        sessionId: input.sessionId,
        actorId: input.runtimeActor.actorId,
        state: 'ready_to_enter',
        reasonCode: 'exact_retry_binding_claimed',
        taskInputDigest: input.taskInputDigest,
        scopeDigest: candidate.binding.scopeDigest,
        retryBindingId: candidate.binding.bindingId,
        terminalAt: null,
        createdAt: now.toISOString(),
      }
      const claimed: AdmissionRetryBindingView = {
        ...candidate.binding,
        state: 'claimed',
        claimRevision: candidate.binding.claimRevision + 1,
        claimedByAdmissionAttemptId: attempt.admissionAttemptId,
        claimLeaseUntil: new Date(now.getTime() + input.leaseMs).toISOString(),
        stateReasonCode: 'exact_admission_claimed',
        updatedAt: now.toISOString(),
      }
      const updated = handle.prepare(
        `UPDATE admission_retry_bindings
         SET state = 'claimed', payload_json = ?, lease_until = ?
         WHERE binding_id = ? AND state = ?`,
      ).run(JSON.stringify(claimed), claimed.claimLeaseUntil, claimed.bindingId, candidate.binding.state)
      if (updated.changes !== 1) {
        throw new ExperienceError('idempotency_conflict', 'AdmissionRetryBinding was claimed concurrently')
      }
      insertAdmissionAttempt(handle, attempt)
      const planning = { ...candidate.planning, retryBinding: claimed }
      updateUsageProjection(handle, planning)
      return { planning, binding: claimed, attempt }
    })
  }

  /** Recheck the exact approval and observations, consume its lease, and prepare one delivery atomically. */
  async consumeClaimAndPrepareContext(input: {
    readonly claimed: ClaimedAdmission
    readonly currentObservations: readonly PlanningObservationView[]
    readonly snapshot: ContextSnapshotView
    readonly delivery: ContextDeliveryView
  }): Promise<ContextUsageView> {
    const outcome = await this.database.write(handle => {
      const row = handle.prepare(
        'SELECT payload_json, state, lease_until FROM admission_retry_bindings WHERE binding_id = ?',
      ).get(input.claimed.binding.bindingId) as {
        payload_json: string
        state: string
        lease_until: string | null
      } | undefined
      if (row === undefined) throw new ExperienceError('not_found', 'AdmissionRetryBinding was not found')
      const binding = parsePlanningObject<AdmissionRetryBindingView>(row.payload_json, 'AdmissionRetryBinding')
      const now = new Date()
      const planning = readPlanningResult(handle, String(binding.usageId))
      const request = planning.approvalRequest
      if (row.state !== 'claimed'
        || binding.claimRevision !== input.claimed.binding.claimRevision
        || binding.claimedByAdmissionAttemptId !== input.claimed.attempt.admissionAttemptId
        || row.lease_until === null
        || Date.parse(row.lease_until) <= now.getTime()) {
        throw new ExperienceError('stale_revision', 'AdmissionRetryBinding claim is no longer current')
      }
      if (request?.status !== 'approved'
        || request.requestId !== binding.requestId
        || request.usagePlanId !== binding.usagePlanId
        || request.planRevision !== binding.planRevision
        || Date.parse(request.expiresAt) <= now.getTime()) {
        supersedeBinding(handle, planning, binding, now.toISOString(), 'approval_not_current')
        return { failure: 'Approved UsagePlan is no longer current' } as const
      }
      const originalFacts = observationFactDigests(
        planning.preflights.flatMap(preflight => preflight.observations),
      )
      const currentFacts = observationFactDigests(input.currentObservations)
      if (JSON.stringify(originalFacts) !== JSON.stringify(currentFacts)) {
        supersedeBinding(handle, planning, binding, now.toISOString(), 'current_observation_changed')
        return { failure: 'Current observations differ from the approved Preflight' } as const
      }
      // A3: never first-deliver an approved plan whose selected Experiences have been
      // superseded by a newer current version or forgotten. Persist the supersede and
      // block the readback instead of rolling back the approval to a stale-but-valid state.
      for (const contribution of planning.plan.selectedContributions) {
        if (isCurrentActiveVersion(handle, contribution.experienceVersionId)) continue
        supersedeBinding(handle, planning, binding, now.toISOString(), 'version_not_current')
        return { failure: 'Selected Experience version is no longer current' } as const
      }
      if (input.snapshot.usageId !== planning.plan.usageId
        || input.snapshot.usagePlanId !== planning.plan.usagePlanId
        || input.snapshot.planRevision !== planning.plan.planRevision
        || input.snapshot.deliveryMessageId !== input.delivery.messageId
        || input.delivery.contextSnapshotId !== input.snapshot.contextSnapshotId
        || input.delivery.contentDigest !== input.snapshot.contentDigest) {
        throw new ExperienceError('invalid_command', 'Prepared Context identifiers do not match the claimed UsagePlan')
      }
      handle.prepare(
        `INSERT INTO context_snapshots
          (context_snapshot_id, usage_id, content_digest, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(input.snapshot.contextSnapshotId, input.snapshot.usageId, input.snapshot.contentDigest,
        JSON.stringify(input.snapshot), input.snapshot.materializedAt)
      handle.prepare(
        `INSERT INTO context_deliveries
          (context_delivery_id, context_snapshot_id, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(input.delivery.contextDeliveryId, input.delivery.contextSnapshotId,
        JSON.stringify(input.delivery), input.delivery.createdAt)
      const consumed: AdmissionRetryBindingView = {
        ...binding,
        state: 'consumed',
        claimLeaseUntil: null,
        stateReasonCode: 'context_prepared_for_agent_loop',
        updatedAt: now.toISOString(),
      }
      const consumedBinding = handle.prepare(
        `UPDATE admission_retry_bindings
         SET state = 'consumed', payload_json = ?, lease_until = NULL
         WHERE binding_id = ? AND state = 'claimed'`,
      ).run(JSON.stringify(consumed), consumed.bindingId)
      if (consumedBinding.changes !== 1) {
        throw new ExperienceError('stale_revision', 'AdmissionRetryBinding changed before Context preparation committed')
      }
      const entered: AdmissionAttemptView = {
        ...input.claimed.attempt,
        state: 'entered',
        reasonCode: 'context_prepared_for_agent_loop',
        terminalAt: now.toISOString(),
      }
      const enteredAttempt = handle.prepare(
        'UPDATE admission_attempts SET state = ?, payload_json = ? WHERE admission_attempt_id = ?',
      ).run(entered.state, JSON.stringify(entered), entered.admissionAttemptId)
      if (enteredAttempt.changes !== 1) {
        throw new ExperienceError('database_schema_invalid', 'Claimed AdmissionAttempt was not found')
      }
      const updatedPlanning: PlanningResultView = { ...planning, retryBinding: consumed }
      const changed = handle.prepare(
        `UPDATE experience_usages SET revision = revision + 1, state = 'context_prepared', payload_json = ?
         WHERE usage_id = ?`,
      ).run(JSON.stringify(updatedPlanning), planning.plan.usageId)
      if (changed.changes !== 1) throw new ExperienceError('not_found', 'ExperienceUsage was not found')
      return {
        value: {
          planning: updatedPlanning,
          admissionAttempts: readAdmissionAttempts(handle, String(planning.plan.usageId)),
          snapshot: input.snapshot,
          delivery: input.delivery,
          retirements: [],
        },
      } as const
    })
    if ('failure' in outcome) throw new ExperienceError('stale_revision', outcome.failure)
    return outcome.value
  }

  /** Record that Agent Loop appended the exact prepared MessageId into the Session log. */
  async recordContextAppended(input: {
    readonly contextDeliveryId: string
    readonly sessionId: string
    readonly messageId: string
    readonly contentDigest: string
    readonly sessionEventSeq: number
    readonly appendedAt: string
  }): Promise<ContextDeliveryView> {
    return this.database.write(handle => mutateDelivery(handle, input.contextDeliveryId, delivery => {
      if (delivery.sessionId !== input.sessionId
        || delivery.messageId !== input.messageId
        || delivery.contentDigest !== input.contentDigest) {
        throw new ExperienceError('idempotency_conflict', 'Session message does not match the prepared ContextDelivery')
      }
      if (delivery.sessionEventSeq !== null && delivery.sessionEventSeq !== input.sessionEventSeq) {
        throw new ExperienceError('idempotency_conflict', 'ContextDelivery already names a different Session event')
      }
      if (delivery.deliveryStatus === 'included_in_request') return delivery
      return {
        ...delivery,
        deliveryStatus: 'appended_to_session',
        sessionEventSeq: input.sessionEventSeq,
        appendedAt: input.appendedAt,
      }
    }))
  }

  /** Record the first exact LLM request boundary that contained the prepared MessageId. */
  async recordContextIncluded(input: {
    readonly contextDeliveryId: string
    readonly requestBoundaryRef: string
    readonly deliveredAt: string
  }): Promise<ContextDeliveryView> {
    return this.database.write(handle => mutateDelivery(handle, input.contextDeliveryId, delivery => {
      if (delivery.sessionEventSeq === null) {
        throw new ExperienceError('stale_revision', 'ContextDelivery cannot enter a request before Session append is observed')
      }
      if (delivery.deliveryStatus === 'included_in_request') return delivery
      return {
        ...delivery,
        deliveryStatus: 'included_in_request',
        requestBoundaryRef: input.requestBoundaryRef,
        deliveredAt: input.deliveredAt,
      }
    }))
  }

  /** Record a prepared or appended delivery that cannot be proven to have entered a model request. */
  async recordContextInterruption(input: {
    readonly contextDeliveryId: string
    readonly status: 'failed_before_send' | 'interrupted_before_request'
  }): Promise<ContextDeliveryView> {
    return this.database.write(handle => mutateDelivery(handle, input.contextDeliveryId, delivery => {
      if (delivery.deliveryStatus === 'included_in_request') return delivery
      return { ...delivery, deliveryStatus: input.status }
    }))
  }

  /** List exact delivery coordination rows for one Session crash reconciliation. */
  listContextDeliveries(sessionId: string): ContextDeliveryView[] {
    const rows = this.database.handle.prepare(
      `SELECT payload_json FROM context_deliveries
       WHERE json_extract(payload_json, '$.sessionId') = ?
       ORDER BY created_at, context_delivery_id`,
    ).all(sessionId) as Array<{ payload_json: string }>
    return rows.map(row => parsePlanningObject<ContextDeliveryView>(row.payload_json, 'ContextDelivery'))
  }

  /** List active delivered contexts for exact Session retirement. */
  listActiveContextDeliveries(sessionId: string): ContextDeliveryView[] {
    const rows = this.database.handle.prepare(
      `SELECT payload_json FROM context_deliveries
       WHERE json_extract(payload_json, '$.sessionId') = ?
         AND json_extract(payload_json, '$.deliveryStatus') IN
           ('appended_to_session', 'included_in_request', 'delivery_unknown', 'interrupted_before_request')
       ORDER BY created_at, context_delivery_id`,
    ).all(sessionId) as Array<{ payload_json: string }>
    return rows.map(row => parsePlanningObject<ContextDeliveryView>(row.payload_json, 'ContextDelivery'))
      .filter(delivery => !hasCompletedRetirement(this.database.handle, String(delivery.contextDeliveryId)))
  }

  /**
   * Read the latest Context delivery for every Session Usage that still lacks a
   * terminal Settlement. Completed retirements remain visible here so a crash
   * between surface replacement and settlement can finish before a new Usage.
   */
  listUnsettledSessionContextDeliveries(sessionId: string, actor: ActorView): ContextDeliveryView[] {
    requireOwner(actor, 'read unsettled Session Experience usages')
    const rows = this.database.handle.prepare(
      `SELECT d.payload_json
         FROM context_deliveries d
         JOIN context_snapshots s ON s.context_snapshot_id = d.context_snapshot_id
        WHERE json_extract(d.payload_json, '$.sessionId') = ?
          AND NOT EXISTS (
            SELECT 1 FROM usage_settlements u WHERE u.usage_id = s.usage_id
          )
        ORDER BY d.created_at, d.context_delivery_id`,
    ).all(sessionId) as Array<{ payload_json: string }>
    const latestByUsage = new Map<string, ContextDeliveryView>()
    for (const row of rows) {
      const delivery = parsePlanningObject<ContextDeliveryView>(row.payload_json, 'ContextDelivery')
      latestByUsage.set(String(delivery.usageId), delivery)
    }
    return [...latestByUsage.values()]
  }

  /** Persist the pending half of an exact Session surface replacement. */
  async requestContextRetirement(
    delivery: ContextDeliveryView,
    reason: ContextRetirementView['reason'],
  ): Promise<ContextRetirementView> {
    if (delivery.sessionEventSeq === null) {
      throw new ExperienceError('stale_revision', 'Context without a Session event cannot be retired from the surface')
    }
    const replacedSessionEventSeq = delivery.sessionEventSeq
    return this.database.write(handle => {
      const existing = readRetirementForDelivery(handle, String(delivery.contextDeliveryId))
      if (existing !== null && existing.status !== 'failed') return existing
      const now = new Date().toISOString()
      const retirement: ContextRetirementView = {
        contextRetirementId: brandedId<'ExperienceContextRetirementId'>(randomUUID(), 'contextRetirementId'),
        contextDeliveryId: delivery.contextDeliveryId,
        sessionId: delivery.sessionId,
        reason,
        status: 'pending',
        replacedSessionEventSeq,
        replacementSessionEventSeq: null,
        failureReason: null,
        requestedAt: now,
        completedAt: null,
      }
      handle.prepare(
        `INSERT INTO context_retirements
          (context_retirement_id, context_delivery_id, state, payload_json, created_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      ).run(retirement.contextRetirementId, retirement.contextDeliveryId, JSON.stringify(retirement), now)
      return retirement
    })
  }

  /** Complete or fail one exact ContextRetirement without rewriting Session history. */
  async finishContextRetirement(
    contextRetirementId: string,
    outcome: { readonly replacementSessionEventSeq: number } | { readonly failureReason: string },
  ): Promise<ContextRetirementView> {
    return this.database.write(handle => {
      const row = handle.prepare(
        'SELECT payload_json FROM context_retirements WHERE context_retirement_id = ?',
      ).get(contextRetirementId) as { payload_json: string } | undefined
      if (row === undefined) throw new ExperienceError('not_found', 'ContextRetirement was not found')
      const current = parsePlanningObject<ContextRetirementView>(row.payload_json, 'ContextRetirement')
      if (current.status === 'replaced_on_surface') return current
      const completedAt = new Date().toISOString()
      const updated: ContextRetirementView = 'replacementSessionEventSeq' in outcome
        ? { ...current, status: 'replaced_on_surface', replacementSessionEventSeq: outcome.replacementSessionEventSeq,
          failureReason: null, completedAt }
        : { ...current, status: 'failed', failureReason: outcome.failureReason, completedAt }
      handle.prepare(
        'UPDATE context_retirements SET state = ?, payload_json = ? WHERE context_retirement_id = ?',
      ).run(updated.status, JSON.stringify(updated), updated.contextRetirementId)
      const targetState = updated.status === 'replaced_on_surface' ? 'retired' : 'failed'
      const reasonCode = updated.status === 'replaced_on_surface'
        ? 'session_surface_replaced'
        : updated.failureReason ?? 'session_surface_replacement_failed'
      const targets = handle.prepare(
        `SELECT forget_request_id FROM forget_context_targets
          WHERE context_retirement_id = ? AND state <> 'retired'`,
      ).all(updated.contextRetirementId) as Array<{ forget_request_id: string }>
      handle.prepare(
        `UPDATE forget_context_targets SET state = ?, reason_code = ?, updated_at = ?
          WHERE context_retirement_id = ? AND state <> 'retired'`,
      ).run(targetState, reasonCode, completedAt, updated.contextRetirementId)
      for (const target of targets) reconcileForgetContextStep(handle, target.forget_request_id, completedAt)
      return updated
    })
  }

  /** Read one M4 Context explanation from the canonical Experience store. */
  getContextUsage(usageId: string, actor: ActorView): ContextUsageView {
    requireOwner(actor, 'read Experience context delivery')
    const planning = readPlanningResult(this.database.handle, usageId)
    const snapshotRow = this.database.handle.prepare(
      'SELECT payload_json FROM context_snapshots WHERE usage_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(usageId) as { payload_json: string } | undefined
    const snapshot = snapshotRow === undefined
      ? null : parsePlanningObject<ContextSnapshotView>(snapshotRow.payload_json, 'ContextSnapshot')
    const deliveryRow = snapshot === null ? undefined : this.database.handle.prepare(
      'SELECT payload_json FROM context_deliveries WHERE context_snapshot_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(snapshot.contextSnapshotId) as { payload_json: string } | undefined
    const delivery = deliveryRow === undefined
      ? null : parsePlanningObject<ContextDeliveryView>(deliveryRow.payload_json, 'ContextDelivery')
    const retirementRows = delivery === null ? [] : this.database.handle.prepare(
      'SELECT payload_json FROM context_retirements WHERE context_delivery_id = ? ORDER BY created_at',
    ).all(delivery.contextDeliveryId) as Array<{ payload_json: string }>
    return {
      planning,
      admissionAttempts: readAdmissionAttempts(this.database.handle, usageId),
      snapshot,
      delivery,
      retirements: retirementRows.map(row =>
        parsePlanningObject<ContextRetirementView>(row.payload_json, 'ContextRetirement')),
    }
  }

  /** Atomically enter one approved guided Usage and create its initial domain cursor. */
  async startUsage(usageId: string, sessionId: string, runtimeActor: ActorView): Promise<StepProgressView> {
    return this.database.write(handle => {
      const existing = readLatestProgress(handle, usageId)
      if (existing !== null) {
        if (existing.sessionId !== sessionId) {
          throw new ExperienceError('idempotency_conflict', 'Usage is already bound to another Session')
        }
        return existing
      }
      const planning = readPlanningResult(handle, usageId)
      if (planning.plan.disposition !== 'ready_for_approval'
        || planning.plan.orderedSteps.length === 0
        || planning.approvalRequest?.status !== 'approved'
        || planning.retryBinding?.state !== 'consumed') {
        throw new ExperienceError('invalid_command', 'Usage is not an approved consumed guided Plan')
      }
      const now = new Date().toISOString()
      const progress: StepProgressView = {
        stepProgressId: brandedId<'ExperienceStepProgressId'>(randomUUID(), 'stepProgressId'),
        executionId: brandedId<'ExperienceExecutionId'>(randomUUID(), 'executionId'),
        usageId: planning.plan.usageId,
        usagePlanId: planning.plan.usagePlanId,
        planRevision: planning.plan.planRevision,
        sessionId,
        guardPolicyDigest: usageGuardPolicyDigest(usageId, planning.plan.planRevision),
        controllerRevision: 1,
        stepIndex: 0,
        stepRef: planning.plan.orderedSteps[0]!.stepId,
        completedStepRefs: [],
        selectedBranchRefs: [],
        checkpointResults: [],
        state: 'ready',
        transition: 'start',
        branchRef: null,
        checkpointRef: null,
        reason: null,
        createdAt: now,
      }
      insertProgress(handle, progress)
      const changed = handle.prepare(
        "UPDATE experience_usages SET revision = revision + 1, state = 'in_progress' WHERE usage_id = ?",
      ).run(usageId)
      if (changed.changes !== 1) throw new ExperienceError('not_found', 'ExperienceUsage was not found')
      handle.prepare(
        `INSERT INTO audit_events
          (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
           object_refs_json, payload_digest, source_refs_json, created_at)
         VALUES (?, ?, ?, 'usage.start', ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), runtimeActor.actorId, `usage-start:${String(progress.stepProgressId)}`,
        progress.executionId, now,
        JSON.stringify([progress.usageId, progress.usagePlanId, progress.executionId, progress.stepProgressId]),
        digest({ progress, runtimeActor }),
        JSON.stringify([planning.plan.usagePlanId, planning.retryBinding.bindingId]), now)
      return progress
    })
  }

  /** Append one optimistic guided cursor transition without inferring tool success. */
  async progressUsage(input: ProgressUsageInput, actor: ActorView): Promise<M5DomainReceipt> {
    requireOwner(actor, 'control guided Experience usage')
    const payloadDigest = m5PayloadDigest('usage.progress', actor, input)
    return this.database.write(handle => {
      const existingReceipt = deduplicatedM5Receipt(handle, input.commandId, payloadDigest)
      if (existingReceipt !== null) return existingReceipt
      const current = requiredLatestProgress(handle, String(input.usageId))
      if (current.controllerRevision !== input.expectedControllerRevision) {
        throw new ExperienceError('stale_revision', 'StepProgress changed before the command could commit')
      }
      if (current.state === 'completed' || current.state === 'failed'
        || current.state === 'unknown' || current.state === 'aborted') {
        throw new ExperienceError('invalid_command', 'terminal StepProgress cannot transition')
      }
      const planning = readPlanningResult(handle, String(input.usageId))
      const now = new Date().toISOString()
      const nextRevision = current.controllerRevision + 1
      let next: StepProgressView
      if (input.action === 'pause') {
        if (current.state === 'paused') throw new ExperienceError('invalid_command', 'StepProgress is already paused')
        next = progressRecord(current, nextRevision, current.stepIndex, current.stepRef, 'paused', 'pause', input, now)
      } else if (input.action === 'resume') {
        if (current.state !== 'paused') throw new ExperienceError('invalid_command', 'only paused StepProgress can resume')
        next = progressRecord(current, nextRevision, current.stepIndex, current.stepRef, 'running', 'resume', input, now)
      } else if (input.action === 'abort') {
        next = progressRecord(current, nextRevision, current.stepIndex, current.stepRef, 'aborted', 'abort', input, now)
      } else if (input.action === 'deviate') {
        const target = input.targetStepRef
        if (target === undefined || input.branchRef === undefined || input.checkpointRef === undefined) {
          throw new ExperienceError('required_field_missing', 'deviation requires targetStepRef, branchRef and checkpointRef')
        }
        const index = planning.plan.orderedSteps.findIndex(step => step.stepId === target)
        if (index < 0) throw new ExperienceError('invalid_command', 'deviation target is not in the approved Plan')
        const approvedBranch = planning.plan.selectedContributions.some(contribution =>
          contribution.contributionId === input.branchRef
          && (contribution.role === 'branch' || contribution.role === 'failure_branch'))
        if (!approvedBranch) throw new ExperienceError('invalid_command', 'deviation branch is not in the approved Plan')
        if (input.checkpointRef !== current.stepRef) {
          throw new ExperienceError('invalid_command', 'deviation checkpoint must name the current step')
        }
        next = progressRecord(current, nextRevision, index, target, 'running', 'deviate', input, now)
      } else {
        if (current.state === 'paused') {
          throw new ExperienceError('invalid_command', 'paused StepProgress must resume before advancing')
        }
        if (input.checkpointRef !== current.stepRef) {
          throw new ExperienceError('required_field_missing', 'advance requires the current step as checkpointRef')
        }
        const nextIndex = current.stepIndex + 1
        const nextStep = planning.plan.orderedSteps[nextIndex]
        next = nextStep === undefined
          ? progressRecord(current, nextRevision, current.stepIndex, current.stepRef, 'completed', 'advance', input, now)
          : progressRecord(current, nextRevision, nextIndex, nextStep.stepId, 'running', 'advance', input, now)
      }
      insertProgress(handle, next)
      if (next.state === 'aborted') {
        handle.prepare("UPDATE experience_usages SET revision = revision + 1, state = 'settling' WHERE usage_id = ?")
          .run(input.usageId)
      }
      const receipt = commitM5Receipt(handle, {
        action: 'usage.progress', input, actor, payloadDigest,
        usageId: String(input.usageId), controllerRevision: next.controllerRevision,
        revisionProposalId: null, objectRevision: next.controllerRevision,
        experienceId: null, experienceVersionId: null,
      })
      enqueueLearningReconcile(handle, 'usage', input.usageId, now)
      return receipt
    })
  }

  /** Persist an exact durable Session tool invocation for the active Usage. */
  async recordExecutionCall(input: ExecutionCorrelationView): Promise<ExecutionCorrelationView> {
    return this.database.write(handle => {
      const existing = readCorrelationByCall(handle, input.usageId, input.callId)
      if (existing !== null) return existing
      handle.prepare(
        `INSERT INTO execution_correlations (correlation_id, usage_id, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(input.executionCorrelationId, input.usageId, JSON.stringify(input), input.createdAt)
      return input
    })
  }

  /** Attach the final Session result event and an opaque effect locator to one call. */
  async recordExecutionResult(input: {
    readonly usageId: string
    readonly callId: string
    readonly resultEventSeq: number
    readonly resultState: 'success' | 'failure'
    readonly externalEffectState: ExecutionCorrelationView['externalEffectState']
    readonly effectRef: ExecutionCorrelationView['effectRef']
  }): Promise<ExecutionCorrelationView> {
    return this.database.write(handle => {
      const current = readCorrelationByCall(handle, input.usageId, input.callId)
      if (current === null) throw new ExperienceError('not_found', 'Execution correlation call was not observed')
      if (current.resultEventSeq !== null) {
        if (current.resultEventSeq !== input.resultEventSeq) {
          throw new ExperienceError('idempotency_conflict', 'Tool call already names another Session result')
        }
        return current
      }
      const updated: ExecutionCorrelationView = {
        ...current,
        resultEventSeq: input.resultEventSeq,
        resultState: input.resultState,
        externalEffectState: input.externalEffectState,
        effectRef: input.effectRef === null ? null : { ...input.effectRef, labelDigest: current.argumentsDigest },
        updatedAt: new Date().toISOString(),
      }
      handle.prepare('UPDATE execution_correlations SET payload_json = ? WHERE correlation_id = ?')
        .run(JSON.stringify(updated), updated.executionCorrelationId)
      return updated
    })
  }

  /** Update only the verified process/socket fields of an existing opaque effect locator. */
  async confirmExecutionEffect(input: {
    readonly usageId: string
    readonly callId: string
    readonly listenerPid: number
    readonly host: string
    readonly port: number
  }): Promise<ExecutionCorrelationView> {
    return this.database.write(handle => {
      const current = readCorrelationByCall(handle, input.usageId, input.callId)
      if (current === null || current.effectRef === null) {
        throw new ExperienceError('not_found', 'Background execution effect was not observed')
      }
      const updated: ExecutionCorrelationView = {
        ...current,
        externalEffectState: 'confirmed',
        effectRef: { ...current.effectRef, listenerPid: input.listenerPid, host: input.host, port: input.port },
        updatedAt: new Date().toISOString(),
      }
      handle.prepare('UPDATE execution_correlations SET payload_json = ? WHERE correlation_id = ?')
        .run(JSON.stringify(updated), updated.executionCorrelationId)
      return updated
    })
  }

  /** Validate one complete assistant response against the exact selected Preference policies. */
  async recordPreferenceOutput(input: {
    readonly usageId: string
    readonly sessionId: string
    readonly messageId: string
    readonly text: string
  }): Promise<PreferenceOutputValidationView | null> {
    return this.database.write(handle => {
      const planning = readPlanningResult(handle, input.usageId)
      if (planning.plan.preferenceEnforcements.length === 0) return null
      const existing = handle.prepare(
        'SELECT payload_json FROM preference_validations WHERE usage_id = ? AND message_id = ?',
      ).get(input.usageId, input.messageId) as { payload_json: string } | undefined
      if (existing !== undefined) {
        return parsePlanningObject<PreferenceOutputValidationView>(existing.payload_json, 'PreferenceOutputValidation')
      }
      if (input.text.trim() === '') {
        throw new ExperienceError('invalid_command', 'Preference validation requires a complete non-empty assistant output')
      }
      const progress = readLatestProgress(handle, input.usageId)
      if (progress !== null && progress.sessionId !== input.sessionId) {
        throw new ExperienceError('principal_unauthorized', 'Preference output Session does not own this Usage')
      }
      const now = new Date().toISOString()
      const validation: PreferenceOutputValidationView = {
        preferenceValidationId: brandedId<'ExperiencePreferenceValidationId'>(
          `preference-validation:${sha256(canonicalJson({ usageId: input.usageId, messageId: input.messageId }))}`,
          'preferenceValidationId'),
        usageId: brandedId<'ExperienceUsageId'>(input.usageId, 'usageId'),
        sessionId: input.sessionId,
        messageId: input.messageId,
        messageDigest: digest(input.text),
        finalOutput: true,
        results: planning.plan.preferenceEnforcements.map(item => validatePreferenceEnforcement(item, input.text)),
        createdAt: now,
      }
      handle.prepare(
        `INSERT INTO preference_validations
          (preference_validation_id, usage_id, session_id, message_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(validation.preferenceValidationId, validation.usageId, validation.sessionId,
        validation.messageId, JSON.stringify(validation), validation.createdAt)
      return validation
    })
  }

  /** Persist one secret-free current-authority verification snapshot. */
  async recordVerification(
    input: VerifyUsageInput,
    run: VerificationRunView,
    actor: ActorView,
  ): Promise<M5DomainReceipt> {
    requireOwner(actor, 'verify guided Experience usage')
    const payloadDigest = m5PayloadDigest('usage.verify', actor, input)
    return this.database.write(handle => {
      const existingReceipt = deduplicatedM5Receipt(handle, input.commandId, payloadDigest)
      if (existingReceipt !== null) return existingReceipt
      const progress = requiredLatestProgress(handle, String(run.usageId))
      if (progress.controllerRevision !== run.controllerRevision) {
        throw new ExperienceError('stale_revision', 'StepProgress changed before verification committed')
      }
      insertVerificationRun(handle, run)
      return commitM5Receipt(handle, {
        action: 'usage.verify', input, actor, payloadDigest,
        usageId: String(run.usageId), controllerRevision: run.controllerRevision,
        revisionProposalId: null, objectRevision: run.controllerRevision,
        experienceId: null, experienceVersionId: null,
      })
    })
  }

  /** Atomically write one terminal Settlement, criterion rows, and Usage state. */
  async settleUsage(input: SettleUsageInput, actor: ActorView): Promise<M5DomainReceipt> {
    requireOwner(actor, 'settle guided Experience usage')
    const payloadDigest = m5PayloadDigest('usage.settle', actor, input)
    return this.database.write(handle => {
      const existingReceipt = deduplicatedM5Receipt(handle, input.commandId, payloadDigest)
      if (existingReceipt !== null) return existingReceipt
      const existing = readSettlement(handle, input.usageId)
      if (existing !== null) throw new ExperienceError('invalid_command', 'Usage is already settled by another command')
      const progress = requiredLatestProgress(handle, input.usageId)
      if (progress.controllerRevision !== input.expectedControllerRevision) {
        throw new ExperienceError('stale_revision', 'StepProgress changed before Settlement committed')
      }
      const verification = readVerification(handle, input.verificationRunId)
      if (verification.usageId !== input.usageId || verification.controllerRevision !== progress.controllerRevision) {
        throw new ExperienceError('invalid_command', 'VerificationRun does not match the current Usage cursor')
      }
      const latestVerification = readLatestVerification(handle, input.usageId)
      if (latestVerification?.verificationRunId !== input.verificationRunId) {
        throw new ExperienceError('stale_revision', 'VerificationRun is no longer the latest Usage readback')
      }
      const outcome = settlementOutcome(verification.criteria, progress.state)
      const settlement: UsageSettlementView = {
        settlementId: brandedId<'ExperienceSettlementId'>(randomUUID(), 'settlementId'),
        usageId: progress.usageId,
        verificationRunId: verification.verificationRunId,
        outcome,
        criteria: verification.criteria,
        createdAt: new Date().toISOString(),
      }
      insertUsageSettlement(handle, settlement)
      const receipt = commitM5Receipt(handle, {
        action: 'usage.settle', input, actor, payloadDigest,
        usageId: String(input.usageId), controllerRevision: progress.controllerRevision,
        revisionProposalId: null, objectRevision: progress.controllerRevision,
        experienceId: null, experienceVersionId: null,
      })
      handle.prepare(
        `INSERT INTO outbox_entries
          (outbox_id, topic, payload_json, state, attempts, next_attempt_at, lease_until, created_at)
         VALUES (?, 'experience.usage.settled', ?, 'pending', 0, ?, NULL, ?)`,
      ).run(randomUUID(), JSON.stringify({ receiptId: receipt.receiptId,
        usageId: settlement.usageId, settlementId: settlement.settlementId,
        outcome: settlement.outcome, correlationId: input.correlationId }),
      settlement.createdAt, settlement.createdAt)
      return receipt
    })
  }

  /**
   * End one delivered Usage from a trusted, deterministic recall trigger. This
   * is not a Browser command: the Session admission adapter supplies the exact
   * Session/source identity after the old Context is proven absent from the
   * current surface. The existing verification/settlement owners remain the
   * canonical result containers.
   */
  async settleUsageForRecall(
    trigger: RecallSettlementTrigger,
    actor: ActorView,
  ): Promise<UsageSettlementView> {
    requireOwner(actor, 'settle a superseded Session Experience usage')
    const triggerKinds: readonly RecallSettlementTrigger['kind'][] = [
      'initial_user_turn', 'registered_tool_failure', 'environment_generation_changed',
    ]
    const registeredFailure = trigger.failureSignature === null
      ? '' : registeredFailureSignatures(trigger.failureSignature).sort().join('+')
    if (!nonEmptyString(trigger.contextDeliveryId)
      || !nonEmptyString(trigger.sessionId)
      || !nonEmptyString(trigger.generation)
      || trigger.generation.length > 4_096
      || !nonEmptyString(trigger.sourceRef)
      || !sha256Digest(trigger.evidenceDigest)
      || !nonEmptyString(trigger.evidenceSummary)
      || trigger.evidenceSummary.length > 4_096
      || !triggerKinds.includes(trigger.kind)
      || (trigger.kind === 'registered_tool_failure'
        ? registeredFailure === '' || registeredFailure !== trigger.failureSignature
        : trigger.failureSignature !== null)) {
      throw new ExperienceError('invalid_command', 'Recall settlement trigger is invalid')
    }
    return this.database.write(handle => {
      const delivery = readContextDelivery(handle, trigger.contextDeliveryId)
      if (delivery.sessionId !== trigger.sessionId) {
        throw new ExperienceError('source_unresolvable', 'Recall trigger Session does not own the Context delivery')
      }
      const existing = readSettlement(handle, String(delivery.usageId))
      if (existing !== null) return existing
      const surfaceClosed = delivery.sessionEventSeq === null
        ? delivery.deliveryStatus === 'failed_before_send'
        : hasCompletedRetirement(handle, String(delivery.contextDeliveryId))
      if (!surfaceClosed) {
        throw new ExperienceError('stale_revision', 'Context must be retired before recall settlement')
      }
      const progress = requiredLatestProgress(handle, String(delivery.usageId))
      if (progress.sessionId !== trigger.sessionId) {
        throw new ExperienceError('source_unresolvable', 'Recall trigger Session does not own the Usage cursor')
      }
      const now = new Date().toISOString()
      const failed = trigger.kind === 'registered_tool_failure'
      const criterionBase = {
        criterionId: 'RECALL-TRIGGER-001' as const,
        mandatory: true as const,
        result: failed ? 'fail' as const : 'pass' as const,
        observedAt: now,
        boundedValue: {
          triggerKind: trigger.kind,
          triggerGeneration: trigger.generation,
          evidenceDigest: trigger.evidenceDigest,
          evidenceSummary: trigger.evidenceSummary,
          failureSignature: trigger.failureSignature,
        },
        sourceRef: trigger.sourceRef,
        reasonCode: failed ? 'registered_tool_failure' : trigger.kind === 'environment_generation_changed'
          ? 'environment_generation_changed' : 'next_user_turn',
      }
      const criterion: CriterionVerificationView = {
        ...criterionBase,
        integrityDigest: digest({
          ...criterionBase,
          usageId: delivery.usageId,
          evidenceDigest: trigger.evidenceDigest,
        }),
      }
      const verification: VerificationRunView = {
        verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
        usageId: delivery.usageId,
        controllerRevision: progress.controllerRevision,
        providerVersion: 'experience-recall-trigger-v1',
        criteria: [criterion],
        phase: 'complete',
        createdAt: now,
      }
      const settlement: UsageSettlementView = {
        settlementId: brandedId<'ExperienceSettlementId'>(randomUUID(), 'settlementId'),
        usageId: delivery.usageId,
        verificationRunId: verification.verificationRunId,
        // A new turn/environment generation proves supersession, not task failure or
        // partial completion. Keep it unknown so the learning projection cannot turn
        // a lifecycle boundary into a negative Experience-quality sample.
        outcome: failed ? 'failure' : 'unknown',
        criteria: verification.criteria,
        createdAt: now,
      }
      insertVerificationRun(handle, verification)
      insertUsageSettlement(handle, settlement)
      handle.prepare(
        `INSERT INTO audit_events
          (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
           object_refs_json, payload_digest, source_refs_json, created_at)
         VALUES (?, ?, ?, 'usage.auto_settle_for_recall', ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), actor.actorId, `recall-settle:${String(settlement.settlementId)}`,
        trigger.generation, now,
        JSON.stringify([delivery.usageId, delivery.contextDeliveryId, verification.verificationRunId,
          settlement.settlementId]),
        trigger.evidenceDigest, JSON.stringify([trigger.sourceRef]), now)
      handle.prepare(
        `INSERT INTO outbox_entries
          (outbox_id, topic, payload_json, state, attempts, next_attempt_at, lease_until, created_at)
         VALUES (?, 'experience.usage.settled', ?, 'pending', 0, ?, NULL, ?)`,
      ).run(randomUUID(), JSON.stringify({
        receiptId: `auto-recall:${String(settlement.settlementId)}`,
        usageId: settlement.usageId,
        settlementId: settlement.settlementId,
        outcome: settlement.outcome,
        triggerKind: trigger.kind,
        triggerGeneration: trigger.generation,
      }), now, now)
      return settlement
    })
  }

  /** Derive only stale verifier and applicability-condition replacements from one settled Usage. */
  async proposeRevision(input: ProposeRevisionInput, actor: ActorView): Promise<M5DomainReceipt> {
    requireOwner(actor, 'propose an Experience revision')
    const payloadDigest = m5PayloadDigest('revision.propose', actor, input)
    return this.database.write(handle => {
      const existingReceipt = deduplicatedM5Receipt(handle, input.commandId, payloadDigest)
      if (existingReceipt !== null) return existingReceipt
      const usageId = String(input.usageId)
      const baseVersionId = String(input.baseVersionId)
      const planning = readPlanningResult(handle, usageId)
      const settlement = readSettlement(handle, usageId)
      if (settlement === null) throw new ExperienceError('invalid_command', 'Usage must be settled before revision proposal')
      const preflight = planning.preflights.find(item => String(item.experienceVersionId) === baseVersionId)
      if (preflight === undefined || (preflight.disposition !== 'adaptable' && preflight.disposition !== 'stale')) {
        throw new ExperienceError('invalid_command', 'base Version was not stale or adaptable for this Usage')
      }
      const base = readVersion(handle, baseVersionId)
      const matched = planning.matchSet.candidates.find(item => String(item.experienceVersionId) === baseVersionId)
      if (matched === undefined || String(base.experienceId) !== String(matched.experienceId)) {
        throw new ExperienceError('invalid_command', 'base Version does not match the Usage retrieval result')
      }
      const existing = readRevisionForUsage(handle, usageId)
      if (existing !== null) {
        throw new ExperienceError('invalid_command', existing.baseVersionId === input.baseVersionId
          ? 'Usage already has a RevisionProposal' : 'Usage already has a proposal for another base Version')
      }
      const authChanged = preflight.reasonCodes.includes('condition_invalidated_by_current_auth_contract')
      const replaceableRoles = new Set(['recovery_verifier', 'entry_condition', 'environment_scope'])
      const candidates = base.components.filter(component => replaceableRoles.has(component.role)
        && (authChanged ? /anonymous|unauthenticated|without auth|http\s*200|200\b/iu.test(component.content) : true))
      if (candidates.length === 0) {
        throw new ExperienceError('invalid_command', 'no verifier or Condition component requires a minimal revision')
      }
      const sourceRefs = uniqueStrings([
        ...settlement.criteria.flatMap(item => item.sourceRef === null ? [] : [item.sourceRef]),
        ...preflight.observations.flatMap(item => item.sourceRefs),
      ])
      if (sourceRefs.length === 0) {
        throw new ExperienceError('required_field_missing', 'RevisionProposal requires current authority sources')
      }
      const changes: RevisionChangeView[] = candidates.map(component => ({
        revisionChangeId: randomUUID(),
        componentId: component.componentId,
        semanticRole: component.role,
        replacementContent: revisionContent(component.role),
        sourceRefs,
        decision: 'pending',
        decisionReason: null,
      }))
      const proposal: RevisionProposalView = {
        revisionProposalId: brandedId<'ExperienceRevisionProposalId'>(randomUUID(), 'revisionProposalId'),
        experienceId: base.experienceId,
        baseVersionId: base.experienceVersionId,
        sourceUsageId: input.usageId,
        sourceMarkdownProjectionReceiptId: null,
        diagnosis: {
          classification: authChanged ? 'auth_contract_changed'
            : settlement.outcome === 'failure' ? 'verification_failed'
              : settlement.outcome === 'aborted' ? 'aborted' : 'verification_unknown',
          reasonCodes: uniqueStrings([
            ...preflight.reasonCodes,
            ...settlement.criteria.filter(item => item.result !== 'pass').map(item => item.reasonCode),
          ]),
          criterionIds: settlement.criteria.filter(item => item.result !== 'pass').map(item => item.criterionId),
        },
        revision: 1,
        state: 'proposed',
        changes,
        publishedVersionId: null,
        createdAt: new Date().toISOString(),
      }
      handle.prepare(
        `INSERT INTO revision_proposals
          (revision_proposal_id, experience_id, base_version_id, state, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(proposal.revisionProposalId, proposal.experienceId, proposal.baseVersionId,
        proposal.state, JSON.stringify(proposal), proposal.createdAt)
      const insertChange = handle.prepare(
        'INSERT INTO revision_changes (revision_change_id, revision_proposal_id, payload_json) VALUES (?, ?, ?)',
      )
      for (const change of changes) insertChange.run(change.revisionChangeId, proposal.revisionProposalId, JSON.stringify(change))
      const receipt = commitM5Receipt(handle, {
        action: 'revision.propose', input, actor, payloadDigest,
        usageId, controllerRevision: null,
        revisionProposalId: String(proposal.revisionProposalId), objectRevision: proposal.revision,
        experienceId: proposal.experienceId, experienceVersionId: null,
      })
      enqueueLearningReconcile(handle, 'revision_proposal', proposal.revisionProposalId, proposal.createdAt)
      return receipt
    })
  }

  /** Export one immutable Version as a receipt-bound human-readable Markdown projection. */
  async exportMarkdown(
    input: ExportMarkdownInput,
    actor: ActorView,
    maxBytes: number,
  ): Promise<MarkdownProjectionView> {
    requireOwner(actor, 'export an Experience Markdown projection')
    const payloadDigest = digest({ action: 'markdown.export', actorId: actor.actorId, input })
    return this.database.write(handle => {
      const existing = deduplicatedMarkdownReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return readMarkdownProjection(handle, String(existing.markdownProjectionReceiptId))
      const version = readVersion(handle, String(input.experienceVersionId))
      if (version.privacyClass === 'secret_reference_only') {
        throw new ExperienceError('sensitive_content_unauthorized', 'secret-reference-only Versions cannot be exported to Markdown')
      }
      requireRecallableSeries(handle, String(version.experienceId))
      const markdown = renderExperienceMarkdown(version)
      if (Buffer.byteLength(markdown, 'utf8') > maxBytes) {
        throw new ExperienceError('invalid_command', 'Markdown projection exceeds the configured projection limit')
      }
      const now = new Date().toISOString()
      const projectionReceipt: MarkdownProjectionReceiptView = {
        markdownProjectionReceiptId: id<'ExperienceMarkdownProjectionReceiptId', MarkdownProjectionReceiptId>(),
        experienceId: version.experienceId,
        experienceVersionId: version.experienceVersionId,
        versionContentDigest: version.contentDigest,
        projectionFormat: 'experience-map-markdown-v1',
        projectionDigest: markdownDigest(markdown),
        exportedBy: actor.actorId,
        createdAt: now,
      }
      handle.prepare(
        `INSERT INTO markdown_projection_receipts
          (projection_receipt_id, experience_id, experience_version_id, payload_json, markdown_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectionReceipt.markdownProjectionReceiptId, version.experienceId, version.experienceVersionId,
        JSON.stringify(projectionReceipt), markdown, now)
      commitMarkdownReceipt(handle, {
        action: 'markdown.export', input, actor, payloadDigest,
        projectionReceipt, revisionProposalId: null, createdAt: now,
      })
      return { receipt: projectionReceipt, markdown }
    })
  }

  /** Parse one receipt-bound Markdown edit into a reviewable RevisionProposal only. */
  async proposeMarkdownRevision(
    input: ProposeMarkdownRevisionInput,
    actor: ActorView,
    maxBytes: number,
  ): Promise<MarkdownDomainReceipt> {
    requireOwner(actor, 'propose an Experience revision from Markdown')
    const payloadDigest = digest({ action: 'markdown.revision_propose', actorId: actor.actorId, input })
    return this.database.write(handle => {
      const existing = deduplicatedMarkdownReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const projection = readMarkdownProjection(handle, String(input.markdownProjectionReceiptId))
      if (markdownDigest(input.editedMarkdown) !== input.editedMarkdownDigest) {
        throw new ExperienceError('invalid_command', 'editedMarkdownDigest does not match the edited Markdown')
      }
      const base = readVersion(handle, String(projection.receipt.experienceVersionId))
      if (base.privacyClass === 'secret_reference_only') {
        throw new ExperienceError('sensitive_content_unauthorized', 'secret-reference-only Versions cannot be imported from Markdown')
      }
      const series = requireRecallableSeries(handle, String(base.experienceId))
      if (series.current_version_id !== base.experienceVersionId) {
        throw new ExperienceError('stale_revision', 'Markdown base Version is no longer current')
      }
      if (base.contentDigest !== projection.receipt.versionContentDigest
        || markdownDigest(projection.markdown) !== projection.receipt.projectionDigest) {
        throw new ExperienceError('database_schema_invalid', 'Markdown projection receipt no longer matches its stored base')
      }
      const changes = parseExperienceMarkdownRevision(
        input.editedMarkdown, base, projection.receipt.projectionDigest, maxBytes,
      )
      const now = new Date().toISOString()
      const proposal: RevisionProposalView = {
        revisionProposalId: id<'ExperienceRevisionProposalId', import('../ids.js').RevisionProposalId>(),
        experienceId: base.experienceId,
        baseVersionId: base.experienceVersionId,
        sourceUsageId: null,
        sourceMarkdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
        diagnosis: { classification: 'markdown_diff', reasonCodes: ['owner_edited_projection'], criterionIds: [] },
        revision: 1,
        state: 'proposed',
        changes,
        publishedVersionId: null,
        createdAt: now,
      }
      insertRevisionProposal(handle, proposal)
      const receipt = commitMarkdownReceipt(handle, {
        action: 'markdown.revision_propose', input, actor, payloadDigest,
        projectionReceipt: projection.receipt, revisionProposalId: proposal.revisionProposalId, createdAt: now,
      })
      enqueueLearningReconcile(handle, 'revision_proposal', proposal.revisionProposalId, now)
      return receipt
    })
  }

  /** Read one durable Markdown projection and its immutable receipt. */
  getMarkdownProjection(markdownProjectionReceiptId: string, actor: ActorView): MarkdownProjectionView {
    requireOwner(actor, 'read an Experience Markdown projection')
    return readMarkdownProjection(this.database.handle, markdownProjectionReceiptId)
  }

  /** Persist one explicit owner decision over one exact proposed replacement. */
  async decideRevisionChange(input: DecideRevisionChangeInput, actor: ActorView): Promise<M5DomainReceipt> {
    requireOwner(actor, 'review an Experience revision')
    const payloadDigest = m5PayloadDigest('revision.change_decide', actor, input)
    return this.database.write(handle => {
      const existingReceipt = deduplicatedM5Receipt(handle, input.commandId, payloadDigest)
      if (existingReceipt !== null) return existingReceipt
      const current = readRevisionProposal(handle, String(input.revisionProposalId))
      if (current.revision !== input.expectedRevision) {
        throw new ExperienceError('stale_revision', 'RevisionProposal changed before the decision could commit')
      }
      if (current.state === 'published' || current.state === 'rejected' || current.state === 'withdrawn') {
        throw new ExperienceError('invalid_command', 'terminal RevisionProposal cannot be reviewed')
      }
      const index = current.changes.findIndex(item => item.revisionChangeId === input.revisionChangeId)
      if (index < 0) throw new ExperienceError('not_found', 'Revision change was not found')
      if (current.changes[index]!.decision !== 'pending') {
        throw new ExperienceError('invalid_command', 'Revision change already has a decision')
      }
      const changes = current.changes.map((change, changeIndex) => changeIndex === index ? {
        ...change,
        decision: input.decision === 'accept' ? 'accepted' as const : 'rejected' as const,
        decisionReason: input.reason,
      } : change)
      const allDecided = changes.every(change => change.decision !== 'pending')
      const state: RevisionProposalView['state'] = allDecided
        ? changes.every(change => change.decision === 'accepted') ? 'accepted' : 'rejected'
        : 'in_review'
      const updated: RevisionProposalView = { ...current, revision: current.revision + 1, state, changes }
      persistRevisionProposal(handle, updated)
      handle.prepare('UPDATE revision_changes SET payload_json = ? WHERE revision_change_id = ?')
        .run(JSON.stringify(changes[index]!), input.revisionChangeId)
      const receipt = commitM5Receipt(handle, {
        action: 'revision.change_decide', input, actor, payloadDigest,
        usageId: updated.sourceUsageId === null ? null : String(updated.sourceUsageId), controllerRevision: null,
        revisionProposalId: String(updated.revisionProposalId), objectRevision: updated.revision,
        experienceId: updated.experienceId, experienceVersionId: null,
      })
      enqueueLearningReconcile(handle, 'revision_proposal', updated.revisionProposalId, receipt.createdAt)
      return receipt
    })
  }

  /** Publish accepted replacements as a new immutable Version while retaining all prior rows. */
  async publishRevision(input: PublishRevisionInput, actor: ActorView): Promise<M5DomainReceipt> {
    requireOwner(actor, 'publish an Experience revision')
    const payloadDigest = m5PayloadDigest('revision.publish', actor, input)
    return this.database.write(handle => {
      const existingReceipt = deduplicatedM5Receipt(handle, input.commandId, payloadDigest)
      if (existingReceipt !== null) return existingReceipt
      const proposal = readRevisionProposal(handle, String(input.revisionProposalId))
      if (proposal.revision !== input.expectedRevision) {
        throw new ExperienceError('stale_revision', 'RevisionProposal changed before publication')
      }
      if (proposal.state === 'published') throw new ExperienceError('invalid_command', 'RevisionProposal is already published')
      if (proposal.state !== 'accepted' || proposal.changes.some(change => change.decision !== 'accepted')) {
        throw new ExperienceError('invalid_command', 'all revision changes must be accepted before publication')
      }
      const base = readVersion(handle, String(proposal.baseVersionId))
      const series = handle.prepare(
        'SELECT current_version_id, series_revision FROM experience_series WHERE experience_id = ?',
      ).get(proposal.experienceId) as { current_version_id: string; series_revision: number } | undefined
      if (series === undefined || series.current_version_id !== proposal.baseVersionId) {
        throw new ExperienceError('stale_revision', 'base Version is no longer current')
      }
      const now = new Date().toISOString()
      const versionId = id<'ExperienceVersionId', ExperienceVersionId>()
      const assessmentId = id<'ExperienceAssessmentId', AssessmentId>()
      const decisionId = randomUUID()
      const changeByComponent = new Map(proposal.changes.map(change => [String(change.componentId), change]))
      const components = base.components.map(component => {
        const change = changeByComponent.get(String(component.componentId))
        if (change === undefined) return component
        const componentRevisionId = id<'ExperienceComponentRevisionId', ComponentRevisionId>()
        const evidenceId = id<'ExperienceEvidenceId', EvidenceId>()
        handle.prepare(
          `INSERT INTO component_revisions
            (component_revision_id, component_id, content_text, source_refs_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(componentRevisionId, component.componentId, change.replacementContent,
          JSON.stringify(change.sourceRefs), now)
        handle.prepare(
          `INSERT INTO evidence_statements
            (evidence_id, component_revision_id, claim_text, source_refs_json, direction)
           VALUES (?, ?, ?, ?, 'supports')`,
        ).run(evidenceId, componentRevisionId, change.replacementContent, JSON.stringify(change.sourceRefs))
        handle.prepare(
          'UPDATE experience_components SET current_revision_id = ? WHERE component_id = ?',
        ).run(componentRevisionId, component.componentId)
        return { ...component, content: change.replacementContent, sourceRefs: change.sourceRefs,
          componentRevisionId, evidenceIds: [evidenceId] }
      })
      const componentRevisionIds = components.map(component => component.componentRevisionId)
      const sourceEpisodeRefs = base.contentDigestSchema === 'v2-source-bound' ? base.sourceEpisodeRefs : []
      const sourceRefs = base.contentDigestSchema === 'v2-source-bound' ? base.sourceRefs : []
      const digestInput = {
        contentDigestSchema: 'v2-source-bound' as const,
        kind: base.kind,
        title: base.title,
        intent: base.intent,
        scope: base.scope,
        validity: base.validity,
        authoritySpec: base.authoritySpec,
        privacyClass: base.privacyClass,
        riskAndEffectSpec: base.riskAndEffectSpec,
        allowedUseModes: base.allowedUseModes,
        sourceEpisodeRefs,
        sourceRefs,
        components: components.map(({ componentId: _componentId, componentRevisionId: _revisionId,
          evidenceIds: _evidenceIds, ...component }) => component),
        evidenceGrade: base.evidenceGrade,
      }
      const version: ExperienceVersionView = {
        ...base,
        experienceVersionId: versionId,
        versionNumber: base.versionNumber + 1,
        previousVersionId: base.experienceVersionId,
        components,
        componentRevisionIds,
        initialAssessmentId: assessmentId,
        createdByDecisionId: decisionId,
        operationalState: 'conditional',
        legacyWarnings: [],
        contentDigest: sha256(canonicalJson(digestInput)),
        createdAt: now,
      }
      handle.prepare(
        'INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run(decisionId, actor.actorId, JSON.stringify({
        decisionId,
        kind: 'revision_publish',
        revisionProposalId: proposal.revisionProposalId,
        baseVersionId: proposal.baseVersionId,
        publishedVersionId: versionId,
        decidedAt: now,
      }), now)
      handle.prepare(
        `INSERT INTO experience_versions
          (experience_version_id, experience_id, version_number, previous_version_id, title, intent,
           scope_json, privacy_class, allowed_use_modes_json, evidence_grade, initial_assessment_id,
           created_by_decision_id, content_digest, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(version.experienceVersionId, version.experienceId, version.versionNumber, base.experienceVersionId,
        version.title, version.intent, JSON.stringify(version.scope), version.privacyClass,
        JSON.stringify(version.allowedUseModes), version.evidenceGrade, version.initialAssessmentId,
        version.createdByDecisionId, version.contentDigest, JSON.stringify(version), now)
      const insertMembership = handle.prepare(
        `INSERT INTO experience_version_components
          (experience_version_id, ordinal, component_revision_id) VALUES (?, ?, ?)`,
      )
      components.forEach((component, index) => insertMembership.run(versionId, index, component.componentRevisionId))
      const evidenceIds = components.flatMap(component => component.evidenceIds)
      handle.prepare(
        `INSERT INTO evidence_assessments
          (assessment_id, experience_version_id, grade, governance_state, operational_state,
           evidence_ids_json, decided_by, decided_at)
         VALUES (?, ?, ?, 'accepted', 'conditional', ?, ?, ?)`,
      ).run(assessmentId, versionId, version.evidenceGrade, JSON.stringify(evidenceIds), actor.actorId, now)
      const seriesChanged = handle.prepare(
        `UPDATE experience_series SET current_version_id = ?, series_revision = series_revision + 1
         WHERE experience_id = ? AND current_version_id = ? AND series_revision = ?`,
      ).run(versionId, proposal.experienceId, base.experienceVersionId, series.series_revision)
      if (seriesChanged.changes !== 1) throw new ExperienceError('stale_revision', 'Experience series changed before publication')
      const published: RevisionProposalView = {
        ...proposal,
        revision: proposal.revision + 1,
        state: 'published',
        publishedVersionId: versionId,
      }
      persistRevisionProposal(handle, published)
      assertStoredVersionConsistency(handle, String(versionId))
      const receipt = commitM5Receipt(handle, {
        action: 'revision.publish', input, actor, payloadDigest,
        usageId: proposal.sourceUsageId === null ? null : String(proposal.sourceUsageId), controllerRevision: null,
        revisionProposalId: String(proposal.revisionProposalId), objectRevision: published.revision,
        experienceId: version.experienceId, experienceVersionId: version.experienceVersionId,
      })
      handle.prepare(
        `INSERT INTO outbox_entries
          (outbox_id, topic, payload_json, state, attempts, next_attempt_at, lease_until, created_at)
         VALUES (?, 'experience.version.published', ?, 'pending', 0, ?, NULL, ?)`,
      ).run(randomUUID(), JSON.stringify({ receiptId: receipt.receiptId,
        experienceVersionId: version.experienceVersionId,
        correlationId: input.correlationId, causationId: input.causationId }), now, now)
      return receipt
    })
  }

  /** Read one durable RevisionProposal. */
  getRevisionProposal(revisionProposalId: string, actor: ActorView): RevisionProposalView {
    requireOwner(actor, 'read an Experience revision')
    return readRevisionProposal(this.database.handle, revisionProposalId)
  }

  /** Read the complete M5 execution projection from canonical tables. */
  getUsageExecution(usageId: string, actor: ActorView): UsageExecutionView {
    requireOwner(actor, 'read guided Experience usage')
    readPlanningResult(this.database.handle, usageId)
    return readUsageExecution(this.database.handle, usageId)
  }

  /** Enqueue one rebuild when the stored projection was produced by another implementation version. */
  async ensureLearningProjectionBuilder(): Promise<void> {
    await this.database.write(handle => {
      const checkpoint = handle.prepare(
        'SELECT builder_version FROM projection_checkpoints WHERE projection_key = ?',
      ).get(LEARNING_PROJECTION_KEY) as { builder_version: string } | undefined
      if (checkpoint?.builder_version === LEARNING_BUILDER_VERSION) return
      enqueueLearningReconcile(handle, 'projection_builder', LEARNING_BUILDER_VERSION, new Date().toISOString())
    })
  }

  /** Lease due learning source events without holding the database transaction during projection work. */
  async claimLearningOutbox(
    now: string,
    leaseUntil: string,
    limit: number,
  ): Promise<readonly ClaimedLearningOutbox[]> {
    return this.database.write(handle => {
      handle.prepare(
        `UPDATE outbox_entries SET state = 'pending', lease_until = NULL
         WHERE state = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?
           AND topic IN ('experience.version.published', 'experience.usage.settled', 'experience.learning.reconcile')`,
      ).run(now)
      const rows = handle.prepare(
        `SELECT rowid AS source_offset, outbox_id FROM outbox_entries
         WHERE state = 'pending' AND next_attempt_at <= ?
           AND topic IN ('experience.version.published', 'experience.usage.settled', 'experience.learning.reconcile')
         ORDER BY rowid LIMIT ?`,
      ).all(now, limit) as Array<{ source_offset: number; outbox_id: string }>
      const claim = handle.prepare(
        `UPDATE outbox_entries
         SET state = 'claimed', attempts = attempts + 1, lease_until = ?
         WHERE outbox_id = ? AND state = 'pending'`,
      )
      return rows.flatMap(row => claim.run(leaseUntil, row.outbox_id).changes === 1
        ? [{ outboxId: row.outbox_id, sourceOffset: row.source_offset, leaseUntil }]
        : [])
    })
  }

  /** Reconcile rows and complete a batch only while its exact lease tokens remain current. */
  async commitLearningProjection(claimed: readonly ClaimedLearningOutbox[]): Promise<LearningProjectionView> {
    if (claimed.length === 0) return this.getLearningProjectionInternal()
    return this.database.write(handle => {
      const isClaimed = handle.prepare("SELECT state, lease_until FROM outbox_entries WHERE outbox_id = ?")
      for (const item of claimed) {
        const row = isClaimed.get(item.outboxId) as { state: string; lease_until: string | null } | undefined
        if (row?.state !== 'claimed' || row.lease_until !== item.leaseUntil) {
          throw new ExperienceError('stale_revision', 'learning outbox lease is no longer owned by this projection run')
        }
      }
      const rows = buildLearningRows(handle)
      replaceLearningRows(handle, rows)
      const current = handle.prepare(
        'SELECT generation FROM projection_checkpoints WHERE projection_key = ?',
      ).get(LEARNING_PROJECTION_KEY) as { generation: number } | undefined
      const sourceOffset = Math.max(...claimed.map(item => item.sourceOffset))
      const generation = (current?.generation ?? 0) + 1
      handle.prepare(
        `INSERT INTO projection_checkpoints (projection_key, source_offset, generation, builder_version)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(projection_key) DO UPDATE SET
           source_offset = MAX(source_offset, excluded.source_offset),
           generation = excluded.generation,
           builder_version = excluded.builder_version`,
      ).run(LEARNING_PROJECTION_KEY, sourceOffset, generation, LEARNING_BUILDER_VERSION)
      const complete = handle.prepare(
        `UPDATE outbox_entries SET state = 'completed', lease_until = NULL
         WHERE outbox_id = ? AND state = 'claimed' AND lease_until = ?`,
      )
      for (const item of claimed) {
        if (complete.run(item.outboxId, item.leaseUntil).changes !== 1) {
          throw new ExperienceError('stale_revision', 'learning outbox completion lost its claim')
        }
      }
      return readLearningProjection(handle)
    })
  }

  /** Release only this run's lease tokens after a failed local projection batch. */
  async releaseLearningOutbox(claimed: readonly ClaimedLearningOutbox[], retryAt: string): Promise<void> {
    if (claimed.length === 0) return
    await this.database.write(handle => {
      const release = handle.prepare(
        `UPDATE outbox_entries SET state = 'pending', next_attempt_at = ?, lease_until = NULL
         WHERE outbox_id = ? AND state = 'claimed' AND lease_until = ?`,
      )
      for (const item of claimed) release.run(retryAt, item.outboxId, item.leaseUntil)
    })
  }

  /** Read the current source-bound M6 learning projection. */
  getLearningProjection(actor: ActorView): LearningProjectionView {
    requireOwner(actor, 'read Experience learning data')
    return this.getLearningProjectionInternal()
  }

  /** Read the projection inside the owning Host process without inventing an external actor. */
  readLearningProjection(): LearningProjectionView {
    return this.getLearningProjectionInternal()
  }

  private getLearningProjectionInternal(): LearningProjectionView {
    return readLearningProjection(this.database.handle)
  }

  /** Read versioned unlock policies, frozen evaluations, and current independent capability levels. */
  getLearningGovernance(actor: ActorView): LearningGovernanceView {
    requireOwner(actor, 'read Experience learning governance')
    return readLearningGovernance(this.database.handle)
  }

  /**
   * Runtime, conservative gate for turning the history-ranking counterfactual into an actual Plan
   * reorder. The ranking predictor is only authorized to suggest when a *dedicated* UnlockContract
   * (bound to the opt-history-ranking predictor), a passed evaluation, a LocalOwner
   * GovernanceDecision and currentLevel=suggest all hold for the query's exact scope, within the
   * rollout limit and not under demotion. The existing governance store keys contracts and levels
   * by capability only, so the default applicability contract/evaluation never binds this distinct
   * predictor; until a per-predictor gate is expressed the gate is conservatively closed (fallback),
   * which is exactly what prevents an old applicability approval from authorizing the new ranker.
   */
  /**
   * Runtime gate for turning the history-ranking counterfactual into a real Plan reorder. It reads the
   * actual dedicated governance subject (history_ranking contract binding the ranker, a passed+current
   * evaluation, a LocalOwner promote decision, currentLevel=suggest) and the exact scope, verifies the
   * rollout limit, and computes the legal baseline/proposed order for the supplied candidates.
   */
  readHistoryRankingGate(input: HistoryRankingGateInput, _actor: ActorView): HistoryRankingGateView {
    const handle = this.database.handle
    const contract = readUnlockContractForCapability(handle, HISTORY_RANKING_CAPABILITY)
    const capability = readAutomationCapability(handle, HISTORY_RANKING_CAPABILITY)
    const bound = contract.predictor === HISTORY_RANKING_PREDICTOR
    const evaluationId = capability.lastEvaluationId
    const decisionId = capability.lastDecisionId
    const scopeAdmitted = rankingScopeAdmitted(capability.allowedScope, contract.excludedRiskClasses, input)
    const evalFresh = evaluationId === null ? false : rankingEvaluationIsFresh(handle, readUnlockEvaluation(handle, evaluationId))
    const rolloutExhausted = rankingRolloutExhausted(handle, capability, contract, decisionId)
    const authorized = bound && scopeAdmitted && capability.currentLevel === 'suggest'
      && evaluationId !== null && decisionId !== null && evalFresh && !rolloutExhausted
    // The advisory counterfactual order is still computed for readable as-of comparison.
    const history = buildRankingHistoryIndex(handle)
    const candidates = input.candidates.map(candidate => ({
      versionId: candidate.versionId,
      disposition: candidate.disposition as PreflightRecordView['disposition'],
      structuralScore: candidate.structuralScore,
      lexicalScore: candidate.lexicalScore,
      rejected: candidate.rejected,
    }))
    const baseline = candidates.map(candidate => candidate.versionId)
    const proposed = proposeHistoryOrder(candidates, input.environmentKey, history, new Date().toISOString())
    const reasonCodes: string[] = []
    if (!bound) reasonCodes.push('no_dedicated_history_ranking_contract')
    if (!scopeAdmitted) reasonCodes.push('history_ranking_scope_not_admitted')
    if (capability.currentLevel !== 'suggest') reasonCodes.push('history_ranking_current_level_is_not_suggest')
    if (evaluationId === null || decisionId === null) reasonCodes.push('history_ranking_missing_owner_decision')
    if (!evalFresh) reasonCodes.push('history_ranking_evaluation_not_current')
    if (rolloutExhausted) reasonCodes.push('history_ranking_rollout_limit_reached')
    return {
      authorized,
      mode: authorized ? 'suggest' : 'fallback',
      reasonCodes,
      governanceDecisionId: authorized ? String(decisionId) : null,
      evaluationId: authorized ? String(evaluationId) : null,
      sampleCount: proposed.scored,
      baselineVersionIds: baseline,
      proposedVersionIds: proposed.ordered,
      policyRevision: capability.policyRevision,
      contractRevision: contract.contractVersion,
    }
  }

  /** Read one exact Experience or Usage dossier from canonical records and append-only audit events. */
  getAuditDossier(input: AuditQueryInput, actor: ActorView): AuditDossierView {
    requireOwner(actor, 'read Experience audit history')
    return readAuditDossier(this.database.handle, input)
  }

  /** Record one source-backed result from an externally executed frozen-corpus arm. */
  async recordEvaluationObservation(
    input: RecordEvaluationObservationInput,
    actor: ActorView,
  ): Promise<EvaluationDomainReceipt> {
    requireOwner(actor, 'record an Experience evaluation observation')
    const payloadDigest = digest({ action: 'evaluation.observe', actorId: actor.actorId, input })
    return this.database.write(handle => {
      const existing = deduplicatedEvaluationReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      validateEvaluationObservation(handle, input.observation)
      const now = new Date().toISOString()
      const observation: EvaluationObservationView = {
        ...input.observation,
        evaluationObservationId: id<'ExperienceEvaluationObservationId', EvaluationObservationId>(),
        recordedAt: now,
      }
      try {
        handle.prepare(
          `INSERT INTO evaluation_observations
            (evaluation_observation_id, cohort_id, comparison_arm, task_case_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(observation.evaluationObservationId, observation.cohortId, observation.comparisonArm,
          observation.taskCaseId, JSON.stringify(observation), now)
      } catch (error) {
        if (isSqliteConstraint(error)) {
          throw new ExperienceError('idempotency_conflict', 'This cohort arm already records the task case', {}, { cause: error })
        }
        throw error
      }
      return commitEvaluationReceipt(handle, { input, actor, payloadDigest, observation, createdAt: now })
    })
  }

  /** Read a comparability-checked three-arm report for one frozen cohort. */
  getEvaluationReport(cohortId: string, actor: ActorView): EvaluationReportView {
    requireOwner(actor, 'read Experience evaluation results')
    if (cohortId.trim() === '') throw new ExperienceError('invalid_command', 'cohortId must not be empty')
    return buildEvaluationReport(this.database.handle, cohortId)
  }

  /** Freeze one evaluation over the current exact prediction/label/outcome identities. */
  async evaluateUnlockContract(
    input: EvaluateUnlockContractInput,
    actor: ActorView,
  ): Promise<LearningGovernanceReceipt> {
    requireOwner(actor, 'evaluate Experience automation')
    const payloadDigest = sha256(canonicalJson({ action: 'learning.evaluate', actor, input }))
    return this.database.write(handle => {
      const existing = deduplicatedLearningGovernanceReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const now = new Date().toISOString()
      ensureLearningGovernance(handle, now)
      const contract = readUnlockContractForCapability(handle, input.capability)
      const projection = readLearningProjection(handle)
      const evaluation = input.capability === HISTORY_RANKING_CAPABILITY
        ? evaluateHistoryRankingContract(contract, readRankingReviews(handle), projection, now)
        : evaluateUnlockContract(contract, projection.rows.filter(row =>
            row.capability === input.capability && row.predictor.version !== HISTORY_RANKING_PREDICTOR), now)
      handle.prepare(
        `INSERT INTO unlock_contract_evaluations (evaluation_id, capability, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(evaluation.unlockContractEvaluationId, input.capability, JSON.stringify(evaluation), now)
      handle.prepare(
        `UPDATE automation_capabilities
            SET payload_json = json_set(payload_json, '$.lastEvaluationId', ?), updated_at = ?
          WHERE capability = ?`,
      ).run(evaluation.unlockContractEvaluationId, now, input.capability)
      return commitLearningGovernanceReceipt(handle, {
        action: 'learning.evaluate', input, actor, capability: input.capability, payloadDigest,
        evaluationId: evaluation.unlockContractEvaluationId, decisionId: null,
        policyRevision: readAutomationCapability(handle, input.capability).policyRevision,
        predictionId: null, rankingDigest: null,
        createdAt: now,
      })
    })
  }

  /** Apply an evaluated promotion or an immediate safety demotion as one governed transaction. */
  async changeAutomationLevel(
    input: ChangeAutomationLevelInput,
    actor: ActorView,
  ): Promise<LearningGovernanceReceipt> {
    requireOwner(actor, input.action === 'promote' ? 'promote Experience automation' : 'demote Experience automation')
    const action = input.action === 'promote' ? 'automation.promote' : 'automation.demote'
    const payloadDigest = sha256(canonicalJson({ action, actor, input }))
    return this.database.write(handle => {
      const existing = deduplicatedLearningGovernanceReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      const current = readAutomationCapability(handle, input.capability)
      const contract = readUnlockContractForCapability(handle, input.capability)
      if (input.reason.trim() === '') throw new ExperienceError('required_field_missing', 'Automation decision reason is required')
      let evaluationId: UnlockContractEvaluationId | null = null
      let promotedScope: Readonly<Record<string, string | null>> | null = null
      if (input.action === 'promote') {
        if (input.violationClass !== 'none' || input.evaluationId === null) {
          throw new ExperienceError('invalid_command', 'Automation promotion requires a passed evaluation and no violation')
        }
        const evaluation = readUnlockEvaluation(handle, input.evaluationId)
        const sameContract = evaluation.capability === input.capability
          && evaluation.unlockContractId === contract.unlockContractId
          && evaluation.outcome === 'passed'
        const stillFresh = sameContract && (input.capability === HISTORY_RANKING_CAPABILITY
          ? rankingEvaluationIsFresh(handle, evaluation)
          : unlockEvaluationMatchesRows(evaluation, readLearningProjection(handle).rows
            .filter(row => row.capability === input.capability)))
        if (!sameContract || !stillFresh) {
          throw new ExperienceError('invalid_command', 'Automation promotion requires a passed current-contract evaluation')
        }
        if (current.currentLevel !== contract.fromLevel || input.targetLevel !== contract.toLevel) {
          throw new ExperienceError('invalid_command', 'Automation promotion target is not admitted by the current contract')
        }
        // The new permission scope is the evaluation's EXACT single scope (workspace root incl null).
        if (input.capability === HISTORY_RANKING_CAPABILITY) {
          if (evaluation.scope === undefined) {
            throw new ExperienceError('database_schema_invalid', 'history_ranking evaluation is missing its qualified scope')
          }
          promotedScope = evaluation.scope
        }
        evaluationId = evaluation.unlockContractEvaluationId
      } else {
        if (input.violationClass === 'none' || !['shadow', 'disabled'].includes(input.targetLevel)) {
          throw new ExperienceError('invalid_command', 'Automation demotion requires a violation and shadow or disabled target')
        }
        if (automationLevelRank(input.targetLevel) >= automationLevelRank(current.currentLevel)) {
          throw new ExperienceError('invalid_command', 'Automation demotion must reduce the current capability level')
        }
      }
      const now = new Date().toISOString()
      const decisionId = randomUUID()
      const next: AutomationCapabilityView = {
        ...current,
        currentLevel: input.targetLevel,
        allowedScope: input.action === 'promote'
          ? (promotedScope ?? contract.allowedScope) : {},
        policyRevision: current.policyRevision + 1,
        lastEvaluationId: evaluationId ?? current.lastEvaluationId,
        lastDecisionId: decisionId,
        lastReason: input.reason,
        updatedAt: now,
      }
      handle.prepare(
        'INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run(decisionId, actor.actorId, JSON.stringify({
        subjectRef: input.capability,
        decisionType: action,
        outcome: input.targetLevel,
        authorityScope: actor.authority,
        reasonCode: input.violationClass,
        explanation: input.reason,
        evaluationId,
      }), now)
      handle.prepare(
        `UPDATE automation_capabilities SET state = ?, policy_revision = ?, payload_json = ?, updated_at = ?
          WHERE capability = ?`,
      ).run(next.currentLevel, next.policyRevision, JSON.stringify(next), now, input.capability)
      return commitLearningGovernanceReceipt(handle, {
        action, input, actor, capability: input.capability, payloadDigest, evaluationId, decisionId,
        policyRevision: next.policyRevision, predictionId: null, rankingDigest: null, createdAt: now,
      })
    })
  }

  /** Owner-only: record one immutable review of a readable, current shadow-ranking counterfactual. */
  async reviewHistoryRanking(
    input: RankHistoryRankingInput,
    actor: ActorView,
  ): Promise<LearningGovernanceReceipt> {
    requireOwner(actor, 'review history ranking')
    if (input.reason.trim() === '') {
      throw new ExperienceError('required_field_missing', 'History ranking review reason is required')
    }
    if (input.evidenceRefs.length === 0) {
      throw new ExperienceError('required_field_missing', 'History ranking review requires non-empty evidence references')
    }
    const payloadDigest = sha256(canonicalJson({ action: 'history_ranking.review', actor, input }))
    return this.database.write(handle => {
      const existing = deduplicatedLearningGovernanceReceipt(handle, input.commandId, payloadDigest)
      if (existing !== null) return existing
      ensureLearningGovernance(handle, new Date().toISOString())
      // Bind to a real readable opt-history-ranking counterfactual in the current projection.
      const projection = readLearningProjection(handle)
      const prediction = projection.rows.find(row => row.predictionId === input.predictionId
        && row.predictor.version === HISTORY_RANKING_PREDICTOR)
      if (prediction === undefined) {
        throw new ExperienceError('not_found', 'history-ranking counterfactual prediction is not readable')
      }
      const ranking = prediction.prediction.ranking as LearningRankingView
      const expectedDigest = digest({ projectionKey: projection.projectionKey, builderVersion: projection.builderVersion, ranking })
      if (input.rankingDigest !== expectedDigest) {
        throw new ExperienceError('invalid_command', 'History ranking review digest does not match the readable counterfactual')
      }
      if (ranking.mode !== 'shadow' || ranking.sourceUsageIds.length === 0) {
        throw new ExperienceError('invalid_command', 'History ranking review requires a real shadow comparison with bound source usages')
      }
      // One valid review per comparison (different comparison or exact command replay handled
      // above); a second review of the same comparison is a conflicting rewrite and is rejected.
      const prior = findReviewForComparison(handle, String(prediction.predictionId), input.rankingDigest)
      if (prior !== null) {
        throw new ExperienceError('idempotency_conflict', 'History ranking comparison was already reviewed')
      }
      const now = new Date().toISOString()
      const decisionId = randomUUID()
      const review: HistoryRankingReviewView = {
        reviewId: randomUUID(),
        schemaVersion: 'experience-history-ranking-review-v1',
        predictionId: prediction.predictionId,
        rankingDigest: input.rankingDigest,
        preferredOrder: input.preferredOrder,
        reason: input.reason,
        evidenceRefs: input.evidenceRefs,
        actorId: actor.actorId,
        usageId: String(ranking.usageId),
        scope: prediction.scope,
        baselineVersionIds: ranking.baselineVersionIds,
        proposedVersionIds: ranking.proposedVersionIds,
        decisionId,
        createdAt: now,
      }
      handle.prepare(
        'INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run(decisionId, actor.actorId, JSON.stringify({
        subjectRef: String(prediction.predictionId),
        decisionType: 'history_ranking.review',
        outcome: input.preferredOrder,
        authorityScope: actor.authority,
        reasonCode: 'owner_ranking_review',
        explanation: input.reason,
        evaluationId: null,
        review,
      }), now)
      return commitLearningGovernanceReceipt(handle, {
        action: 'history_ranking.review', input, actor, capability: HISTORY_RANKING_CAPABILITY, payloadDigest,
        evaluationId: null, decisionId,
        policyRevision: readAutomationCapability(handle, HISTORY_RANKING_CAPABILITY).policyRevision,
        predictionId: prediction.predictionId, rankingDigest: input.rankingDigest, createdAt: now,
      })
    })
  }

  /** Read the immutable owner history-ranking reviews (ordered by createdAt, reviewId). */
  readHistoryRankingReviews(actor: ActorView): HistoryRankingReviewView[] {
    requireOwner(actor, 'read history ranking reviews')
    return readRankingReviews(this.database.handle)
  }
}

interface LearningRowBuild {
  readonly prediction: Omit<LearningPredictionView, 'humanLabels' | 'observedOutcomes'>
  readonly humanLabels: readonly LearningHumanLabelView[]
  readonly observedOutcomes: readonly LearningObservedOutcomeView[]
}

function forgottenVersionIds(handle: DatabaseSync): ReadonlySet<string> {
  const rows = handle.prepare(
    `SELECT v.experience_version_id
       FROM forget_tombstones f
       JOIN experience_versions v ON v.experience_id = f.experience_id
      ORDER BY v.experience_version_id`,
  ).all() as Array<{ experience_version_id: string }>
  return new Set(rows.map(row => row.experience_version_id))
}

function buildLearningUsages(handle: DatabaseSync): readonly LearningUsageSource[] {
  const usageRows = handle.prepare(
    'SELECT usage_id, state FROM experience_usages ORDER BY created_at, usage_id',
  ).all() as Array<{ usage_id: string; state: string }>
  return usageRows.flatMap(row => {
    const context = readUsageContext(handle, row.usage_id)
    return [{ ...context, state: row.state, planning: readPlanningResult(handle, row.usage_id) }]
  }).map(item => ({ ...item, execution: readUsageExecution(handle, String(item.planning.plan.usageId)) }))
}

/** Deterministic same-environment used-sample index (success/failure/usageIds) from canonical usages. */
function buildRankingHistoryIndex(handle: DatabaseSync): Map<string, RankingSampleState> {
  const history = new Map<string, RankingSampleState>()
  for (const usage of buildLearningUsages(handle)) recordUsedSamples(history, usage)
  return history
}

function buildLearningRows(handle: DatabaseSync): LearningRowBuild[] {
  const forgottenVersions = forgottenVersionIds(handle)
  const usages = buildLearningUsages(handle)
  return [
    ...buildExtractionLearning(handle, usages, forgottenVersions),
    ...buildApplicabilityLearning(handle, usages, forgottenVersions),
    ...buildRevisionLearning(handle, usages, forgottenVersions),
    ...buildMergeLearning(handle, usages, forgottenVersions),
    ...buildCausalPromotionLearning(handle, forgottenVersions),
    ...buildExecutionLearning(handle, usages, forgottenVersions),
    ...buildHistoryRankingLearning(handle, usages, forgottenVersions),
  ].sort((left, right) => left.prediction.capability.localeCompare(right.prediction.capability)
    || String(left.prediction.predictionId).localeCompare(String(right.prediction.predictionId)))
}

function buildMergeLearning(
  handle: DatabaseSync,
  usages: readonly LearningUsageSource[],
  forgottenVersions: ReadonlySet<string>,
): LearningRowBuild[] {
  const usedRelationIds = new Set(usages.flatMap(item => item.planning.plan.selectedRelationIds.map(String)))
  const rows = handle.prepare(
    "SELECT relation_id FROM experience_relations WHERE relation_type = 'composes_with' ORDER BY created_at, relation_id",
  ).all() as Array<{ relation_id: string }>
  return rows.flatMap(row => {
    if (!usedRelationIds.has(row.relation_id)) return []
    const relation = readRelation(handle, row.relation_id)
    if (relationTouchesForgottenVersion(handle, relation, forgottenVersions)) return []
    const predictionId = learningPredictionId('merge', [relation.relationId, relation.createdByDecisionId])
    const decisionLabel = relationHumanLabel(handle, predictionId, relation, 'accepted_composition')
    const outcomes = usages.flatMap(({ planning, execution }) => {
      if (!planning.plan.selectedRelationIds.includes(relation.relationId)
        || execution.settlement === null || execution.settlement.outcome === 'unknown') return []
      return [settlementLearningOutcome(predictionId, execution.settlement)]
    })
    return [{
      prediction: {
        predictionId,
        schemaVersion: 'experience-shadow-prediction-v1',
        capability: 'merge',
        predictor: { kind: 'deterministic_rule', version: 'typed-relations-composition-v1' },
        scope: relation.scope,
        inputRefs: [learningRef('relation', relation.relationId, digest(relation))],
        prediction: {
          sourceObjectRef: relation.sourceObjectRef,
          targetObjectRef: relation.targetObjectRef,
          relationType: relation.relationType,
          disposition: 'compose',
        },
        createdAt: relation.createdAt,
      },
      humanLabels: [decisionLabel],
      observedOutcomes: outcomes,
    }]
  })
}

function buildCausalPromotionLearning(
  handle: DatabaseSync,
  forgottenVersions: ReadonlySet<string>,
): LearningRowBuild[] {
  const rows = handle.prepare(
    "SELECT relation_id FROM experience_relations WHERE relation_type = 'causal_candidate' ORDER BY created_at, relation_id",
  ).all() as Array<{ relation_id: string }>
  const promotions = handle.prepare(
    "SELECT relation_id FROM experience_relations WHERE relation_type = 'causally_influences' ORDER BY created_at, relation_id",
  ).all().map(row => readRelation(handle, (row as { relation_id: string }).relation_id))
  return rows.flatMap(row => {
    const relation = readRelation(handle, row.relation_id)
    if (relationTouchesForgottenVersion(handle, relation, forgottenVersions)) return []
    const predictionId = learningPredictionId('causal_promotion', [relation.relationId, relation.evidenceIds])
    const promotion = promotions.find(item => sameRelationPairAndScope(item, relation))
    return [{
      prediction: {
        predictionId,
        schemaVersion: 'experience-shadow-prediction-v1',
        capability: 'causal_promotion',
        predictor: { kind: 'deterministic_rule', version: 'causal-promotion-gate-v1' },
        scope: relation.scope,
        inputRefs: [
          learningRef('relation', relation.relationId, digest(relation)),
          ...relation.evidenceIds.map(id => learningRef('source_record', id, null)),
        ],
        prediction: {
          candidateRelationId: relation.relationId,
          currentGrade: relation.qualifiers.causalGrade ?? null,
          eligibleForPromotion: promotion !== undefined,
          mechanism: relation.qualifiers.mechanism ?? null,
          competingExplanation: relation.qualifiers.competingExplanation ?? null,
        },
        createdAt: relation.createdAt,
      },
      humanLabels: [promotion === undefined
        ? relationHumanLabel(handle, predictionId, relation, 'retained_candidate')
        : relationHumanLabel(handle, predictionId, promotion, 'promoted')],
      observedOutcomes: [],
    }]
  })
}

function relationHumanLabel(
  handle: DatabaseSync,
  predictionId: LearningPredictionId,
  relation: ExperienceRelationView,
  decision: string,
): LearningHumanLabelView {
  const row = handle.prepare(
    'SELECT actor_id, payload_json, created_at FROM governance_decisions WHERE decision_id = ?',
  ).get(relation.createdByDecisionId) as { actor_id: string; payload_json: string; created_at: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'Relation governance decision is missing')
  return {
    labelId: humanLabelId(predictionId, relation.createdByDecisionId),
    schemaVersion: 'experience-human-label-v1',
    decision,
    reason: 'source_bound_relation_reviewed',
    actorId: brandedId<'ExperienceActorId'>(row.actor_id, 'actorId'),
    sourceRefs: [
      learningRef('relation', relation.relationId, digest(relation)),
      learningRef('governance_decision', relation.createdByDecisionId, digest(JSON.parse(row.payload_json))),
    ],
    createdAt: row.created_at,
  }
}

function sameRelationPairAndScope(left: ExperienceRelationView, right: ExperienceRelationView): boolean {
  return canonicalJson(left.sourceObjectRef) === canonicalJson(right.sourceObjectRef)
    && canonicalJson(left.targetObjectRef) === canonicalJson(right.targetObjectRef)
    && canonicalJson(left.scope) === canonicalJson(right.scope)
}

function relationTouchesForgottenVersion(
  handle: DatabaseSync,
  relation: ExperienceRelationView,
  forgottenVersions: ReadonlySet<string>,
): boolean {
  for (const ref of [relation.sourceObjectRef, relation.targetObjectRef]) {
    if (ref.kind === 'version' && forgottenVersions.has(ref.id)) return true
    if (ref.kind === 'component') {
      const rows = handle.prepare(
        `SELECT vc.experience_version_id
           FROM experience_version_components vc
           JOIN component_revisions cr ON cr.component_revision_id = vc.component_revision_id
          WHERE cr.component_id = ?`,
      ).all(ref.id) as Array<{ experience_version_id: string }>
      if (rows.some(row => forgottenVersions.has(row.experience_version_id))) return true
    }
  }
  return false
}

function buildExtractionLearning(
  handle: DatabaseSync,
  usages: readonly LearningUsageSource[],
  forgottenVersions: ReadonlySet<string>,
): LearningRowBuild[] {
  const candidateRows = handle.prepare(
    "SELECT candidate_id FROM candidates WHERE json_type(payload_json, '$.draft') = 'object' ORDER BY created_at, candidate_id",
  ).all() as Array<{ candidate_id: string }>
  return candidateRows.flatMap(row => {
    const workflow = readWorkflowCandidate(handle, brandedId<'ExperienceCandidateId'>(row.candidate_id, 'candidateId'))
    const candidate = candidateView(workflow)
    if (candidate.publishedVersionId !== null && forgottenVersions.has(String(candidate.publishedVersionId))) return []
    const predictionId = learningPredictionId('extraction', [candidate.candidateId, candidate.proposal.schemaVersion])
    const inputRefs: LearningSourceRefView[] = [
      learningRef('candidate', candidate.candidateId, candidate.proposal.outputDigest),
      learningRef('proposal_session', candidate.proposal.proposalSessionId, candidate.proposal.sourceInputDigest),
      ...candidate.sourceEpisodeRefs.map(item => learningRef('episode', item.episodeRefId, item.contentDigest)),
    ]
    const humanLabels = workflow.decisions.map(decision => ({
      labelId: humanLabelId(predictionId, decision.decisionId),
      schemaVersion: 'experience-human-label-v1' as const,
      decision: `${decision.field}:${decision.decision}`,
      reason: decision.reason,
      actorId: decision.actorId,
      sourceRefs: [
        learningRef('candidate', candidate.candidateId, candidate.proposal.outputDigest),
        ...((decision.effectiveSourceRefs ?? []).map(id => learningRef('source_record', id, null))),
      ],
      createdAt: decision.decidedAt,
    }))
    const observedOutcomes = candidate.publishedVersionId === null ? [] : usages.flatMap(({ planning, execution }) => {
      if (execution.settlement === null || execution.settlement.outcome === 'unknown'
        || !planning.plan.selectedContributions.some(item => item.experienceVersionId === candidate.publishedVersionId)) return []
      return [settlementLearningOutcome(predictionId, execution.settlement)]
    })
    return [{
      prediction: {
        predictionId,
        schemaVersion: 'experience-shadow-prediction-v1',
        capability: 'extraction',
        predictor: {
          kind: 'model',
          version: `${candidate.proposal.promptVersion}/${candidate.proposal.schemaVersion}/${candidate.proposal.policyVersion}`,
        },
        scope: { ownerScope: candidate.sourceRefs[0]?.ownerScope ?? null, privacyClass: stringField(candidate, 'privacyClass') },
        inputRefs,
        prediction: {
          proposedKind: candidate.proposedKind,
          title: candidate.title,
          fields: candidate.fields.map(field => ({
            field: field.field,
            proposedValue: field.proposedValue,
            proposedSourceRefs: field.proposedSourceRefs,
          })),
          unresolvedFields: candidate.unresolvedFields,
        },
        createdAt: candidate.proposal.proposedAt,
      },
      humanLabels,
      observedOutcomes,
    }]
  })
}

interface LearningUsageSource {
  readonly state: string
  readonly planning: PlanningResultView
  readonly execution: UsageExecutionView
  readonly snapshot: ContextSnapshotView | null
  readonly delivery: ContextDeliveryView | null
}

function buildApplicabilityLearning(
  handle: DatabaseSync,
  usages: readonly LearningUsageSource[],
  forgottenVersions: ReadonlySet<string>,
): LearningRowBuild[] {
  return usages.flatMap(usage => usage.planning.preflights
    .filter(preflight => !forgottenVersions.has(String(preflight.experienceVersionId)))
    .map(preflight => {
    const predictionId = learningPredictionId('applicability', [preflight.preflightId, preflight.digest])
    const history = applicabilityHistory(usage, preflight)
    // The owner approval/denial human label belongs to any Version that was selected into the
    // approved plan, independent of whether it was later actually used (use is captured by the
    // outcome, not by the label). Not-selected Versions carry no such human decision.
    const selected = usage.planning.plan.selectedContributions.some(
      contribution => contribution.experienceVersionId === preflight.experienceVersionId,
    )
    const humanLabels = selected
      ? planHumanLabels(handle, predictionId, usage.planning.approvalRequest)
      : []
    const outcome = history.participation === 'used'
      ? (usage.execution.settlement === null
        ? rejectedBeforeUseOutcome(predictionId, usage.planning, preflight)
        : settlementLearningOutcome(predictionId, usage.execution.settlement))
      : null
    return {
      prediction: {
        predictionId,
        schemaVersion: 'experience-shadow-prediction-v1',
        capability: 'applicability',
        predictor: { kind: 'deterministic_rule', version: `${usage.planning.matchSet.retrievalVersion}/preflight-v1` },
        scope: {
          workspaceRoot: usage.planning.fingerprint.environmentRefs[0] ?? null,
          targetExposure: usage.planning.fingerprint.targetExposure,
          riskClass: usage.planning.fingerprint.riskClass,
        },
        inputRefs: [
          learningRef('usage', usage.planning.plan.usageId, usage.planning.fingerprint.taskInputDigest),
          learningRef('preflight', preflight.preflightId, preflight.digest),
          learningRef('version', preflight.experienceVersionId, null),
        ],
        prediction: {
          disposition: preflight.disposition,
          blockers: preflight.blockers,
          reasonCodes: preflight.reasonCodes,
          observationDigests: preflight.observations.map(item => item.contentDigest),
          history,
        },
        createdAt: preflight.checkedAt,
      },
      humanLabels,
      observedOutcomes: outcome === null ? [] : [outcome],
    }
  }))
}

/** Deterministic attribution for one preflighted version in one Usage. */
function applicabilityHistory(usage: LearningUsageSource, preflight: PreflightRecordView): LearningUsageHistoryView {
  const { state, planning, execution, snapshot, delivery } = usage
  const versionId = String(preflight.experienceVersionId)
  const selectedContributions = planning.plan.selectedContributions
    .filter(contribution => String(contribution.experienceVersionId) === versionId)
  const selected = selectedContributions.length > 0
  const environmentKey = planning.fingerprint.environmentRefs[0] ?? 'local'
  const reasonCodes: string[] = []
  const baseEvidence: LearningSourceRefView[] = [
    learningRef('usage', planning.plan.usageId, planning.fingerprint.taskInputDigest),
    learningRef('preflight', preflight.preflightId, preflight.digest),
    learningRef('version', versionId, null),
  ]

  // A rejected/withdrawn/no-match/blocked plan never yields actual use of any version.
  if (isRejectedBeforeUse(state) || planning.approvalRequest?.status === 'denied'
    || planning.approvalRequest?.status === 'withdrawn' || planning.approvalRequest?.status === 'expired') {
    return {
      usageId: String(planning.plan.usageId),
      experienceVersionId: versionId,
      taskInputDigest: planning.fingerprint.taskInputDigest,
      environmentKey,
      componentRevisionIds: selectedContributions.map(item => String(item.componentRevisionId)),
      participation: 'rejected',
      taskOutcome: null,
      attribution: 'task_participation',
      evidenceRefs: [...baseEvidence],
      reasonCodes: ['plan_rejected_before_use'],
    }
  }

  // An explicitly aborted Usage marks participating versions abandoned (never a success/failure).
  const aborted = execution.settlement?.outcome === 'aborted' || execution.progress?.state === 'aborted'
  if (aborted) {
    return {
      usageId: String(planning.plan.usageId),
      experienceVersionId: versionId,
      taskInputDigest: planning.fingerprint.taskInputDigest,
      environmentKey,
      componentRevisionIds: selectedContributions.map(item => String(item.componentRevisionId)),
      participation: selected ? 'abandoned' : 'not_selected',
      taskOutcome: null,
      attribution: 'task_participation',
      evidenceRefs: [...baseEvidence],
      reasonCodes: ['usage_aborted'],
    }
  }

  if (!selected) {
    return {
      usageId: String(planning.plan.usageId),
      experienceVersionId: versionId,
      taskInputDigest: planning.fingerprint.taskInputDigest,
      environmentKey,
      componentRevisionIds: [],
      participation: 'not_selected',
      taskOutcome: null,
      attribution: 'task_participation',
      evidenceRefs: [...baseEvidence],
      reasonCodes: ['not_in_selected_contributions'],
    }
  }

  // Selected: require a ContextSnapshot and ContextDelivery that bind to the exact approved plan,
  // the exact content, and the exact Usage. Any identity mismatch is conservatively 'unverified'.
  const snapshotMatches = snapshot !== null
    && snapshot.usageId === planning.plan.usageId
    && snapshot.usagePlanId === planning.plan.usagePlanId
    && snapshot.planRevision === planning.plan.planRevision
  const deliveryMatches = snapshotMatches && delivery !== null
    && delivery.contextSnapshotId === snapshot.contextSnapshotId
    && delivery.usageId === planning.plan.usageId
    && delivery.contentDigest === snapshot.contentDigest
  if (!snapshotMatches || !deliveryMatches) {
    return {
      usageId: String(planning.plan.usageId),
      experienceVersionId: versionId,
      taskInputDigest: planning.fingerprint.taskInputDigest,
      environmentKey,
      componentRevisionIds: selectedContributions.map(item => String(item.componentRevisionId)),
      participation: 'unverified',
      taskOutcome: null,
      attribution: 'task_participation',
      evidenceRefs: [...baseEvidence, ...(snapshot === null ? [] : [learningRef('context_snapshot', snapshot.contextSnapshotId, snapshot.contentDigest)])],
      reasonCodes: ['context_snapshot_or_delivery_mismatch'],
    }
  }

  // A delivery that never entered a model request ('prepared', 'appended_to_session',
  // 'failed_before_send', 'interrupted_before_request') is NOT proof of actual use. Only
  // 'included_in_request' is the exact request-inclusion evidence the contract requires.
  const includedInRequest = delivery.deliveryStatus === 'included_in_request'
  if (!includedInRequest) {
    return {
      usageId: String(planning.plan.usageId),
      experienceVersionId: versionId,
      taskInputDigest: planning.fingerprint.taskInputDigest,
      environmentKey,
      componentRevisionIds: selectedContributions.map(item => String(item.componentRevisionId)),
      participation: delivery.deliveryStatus === 'appended_to_session' ? 'delivered_only' : 'not_delivered',
      taskOutcome: null,
      attribution: 'task_participation',
      evidenceRefs: [
        ...baseEvidence,
        learningRef('context_snapshot', snapshot.contextSnapshotId, snapshot.contentDigest),
        learningRef('context_delivery', delivery.contextDeliveryId, delivery.contentDigest),
      ],
      reasonCodes: [`context_delivery_${delivery.deliveryStatus}_not_in_request`],
    }
  }

  const evidenceRefs: LearningSourceRefView[] = [
    ...baseEvidence,
    learningRef('context_snapshot', snapshot.contextSnapshotId, snapshot.contentDigest),
    learningRef('context_delivery', delivery.contextDeliveryId, delivery.contentDigest),
  ]
  // The exact request inclusion is proven; now require the same-Usage execution + settlement.
  const settled = execution.settlement !== null && execution.settlement.usageId === planning.plan.usageId
  if (settled) {
    reasonCodes.push('context_included_in_request', 'usage_executed_and_settled')
    if (execution.verification !== null) evidenceRefs.push(learningRef('verification', execution.verification.verificationRunId, digest(execution.verification.criteria)))
    if (execution.settlement !== null) evidenceRefs.push(learningRef('settlement', execution.settlement.settlementId, digest(execution.settlement.criteria)))
    return {
      usageId: String(planning.plan.usageId),
      experienceVersionId: versionId,
      taskInputDigest: planning.fingerprint.taskInputDigest,
      environmentKey,
      componentRevisionIds: selectedContributions.map(item => String(item.componentRevisionId)),
      participation: 'used',
      taskOutcome: mapSettlementOutcome(execution.settlement?.outcome ?? null),
      attribution: 'task_participation',
      evidenceRefs,
      reasonCodes,
    }
  }

  // Included in a request but no completed same-Usage execution/settlement yet.
  return {
    usageId: String(planning.plan.usageId),
    experienceVersionId: versionId,
    taskInputDigest: planning.fingerprint.taskInputDigest,
    environmentKey,
    componentRevisionIds: selectedContributions.map(item => String(item.componentRevisionId)),
    participation: 'delivered_only',
    taskOutcome: null,
    attribution: 'task_participation',
    evidenceRefs,
    reasonCodes: ['included_in_request_without_settlement'],
  }
}

/** Compute attribution for a specific Experience version within one Usage, if it was preflighted. */
function participationForVersion(
  usage: LearningUsageSource,
  versionId: string,
): LearningUsageHistoryView | null {
  const preflight = usage.planning.preflights.find(item => String(item.experienceVersionId) === versionId)
  return preflight === undefined ? null : applicabilityHistory(usage, preflight)
}

/** Map a persisted Settlement outcome to the fixed attribution task outcome vocabulary. */
function mapSettlementOutcome(outcome: UsageSettlementView['outcome'] | null): LearningTaskOutcome {
  if (outcome === 'success') return 'success'
  if (outcome === 'partial' || outcome === 'failure') return 'failure'
  if (outcome === 'unknown') return 'unknown'
  if (outcome === 'aborted') return 'abandoned'
  return null
}

interface RankingHistorySample {
  readonly outcome: 'success' | 'failure'
  readonly usageId: string
  readonly settledAt: string
}

interface RankingSampleState {
  readonly samples: readonly RankingHistorySample[]
}

/** Samples settled at-or-before `asOf` (as-of decision boundary; no future-settlement time leak). */
function samplesAsOf(state: RankingSampleState | undefined, asOf: string): readonly RankingHistorySample[] {
  if (state === undefined) return []
  return state.samples.filter(sample => sample.settledAt <= asOf)
}

function successFailureCounts(entries: readonly RankingHistorySample[]): { success: number; failure: number } {
  let success = 0
  let failure = 0
  for (const sample of entries) {
    if (sample.outcome === 'success') success += 1
    else failure += 1
  }
  return { success, failure }
}

/** One counterfactual baseline-vs-proposed ordering for a planning query, in shadow by default. */
function buildHistoryRankingLearning(
  handle: DatabaseSync,
  usages: readonly LearningUsageSource[],
  forgottenVersions: ReadonlySet<string>,
): LearningRowBuild[] {
  const rows: LearningRowBuild[] = []
  // Deterministic chronological history index of same-environment used samples; only the
  // *strictly earlier* usages contribute to a later query's counterfactual, so a rebuild is
  // idempotent (it recomputes every ranking from the same canonical ordering).
  const history = new Map<string, RankingSampleState>()
  // Past authorized reorders are authoritative facts; the projection must rebuild the ranking from
  // the recorded apply (never reverse-inferred from a later policy/settlement).
  const appliesByUsage = new Map(readRankingApplyRecords(handle).map(record => [record.usageId, record]))
  for (const usage of usages) {
    const preflights = usage.planning.preflights.filter(preflight =>
      !forgottenVersions.has(String(preflight.experienceVersionId)))
    if (preflights.length > 0) {
      const baseline = [...new Set(preflights.map(preflight => String(preflight.experienceVersionId)))]
      // Carry each candidate's current eligibility/relevance facts so the counterfactual can only
      // readjust order among *exactly-equally relevant, currently available* candidates, never
      // cross a relevance score or lift an unavailable/rejected version (H4/H-R2, review-02).
      const candidateById = new Map(usage.planning.matchSet.candidates.map(candidate => [String(candidate.experienceVersionId), candidate]))
      const candidates = preflights.map(preflight => {
        const match = candidateById.get(String(preflight.experienceVersionId))
        return {
          versionId: String(preflight.experienceVersionId),
          disposition: preflight.disposition,
          structuralScore: match?.structuralScore ?? null,
          lexicalScore: match?.lexicalScore ?? null,
          rejected: match?.rejected ?? false,
        }
      })
      const environmentKey = usage.planning.fingerprint.environmentRefs[0] ?? 'local'
      // As-of decision boundary: only samples settled at-or-before this new Plan's creation count.
      const asOf = usage.planning.plan.createdAt
      const proposed = proposeHistoryOrder(candidates, environmentKey, history, asOf)
      const scoredCount = proposed.scored
      const sourceUsageIds = sourceUsageIdsFor(baseline, environmentKey, history, asOf)
      const sampleCount = sampleCountFor(baseline, environmentKey, history, asOf)
      const usageId = String(usage.planning.plan.usageId)
      const applyRecord = appliesByUsage.get(usageId)
      const shadowMode: LearningRankingView['mode'] = scoredCount === 0 ? 'fallback' : 'shadow'
      const mode = applyRecord === undefined ? shadowMode : 'suggest'
      const ranking: LearningRankingView = {
        usageId,
        taskInputDigest: usage.planning.fingerprint.taskInputDigest,
        environmentKey,
        baselineVersionIds: baseline,
        proposedVersionIds: proposed.ordered,
        // A past authorized reorder is authoritative; otherwise shadow keeps the baseline selection.
        appliedVersionIds: applyRecord?.appliedVersionIds ?? baseline,
        mode,
        reasonCodes: applyRecord !== undefined
          ? ['history_counterfactual_suggest_applied']
          : shadowMode === 'fallback'
            ? ['insufficient_same_environment_used_samples']
            : ['history_counterfactual_shadow_order'],
        sampleCount,
        sourceUsageIds,
        governanceDecisionId: applyRecord?.decisionId ?? null,
        evaluationId: applyRecord?.evaluationId
          ? String(applyRecord.evaluationId) : null,
      }
      const predictionId = learningPredictionId('applicability', [String(usage.planning.plan.usageId), HISTORY_RANKING_PREDICTOR])
      rows.push({
        prediction: {
          predictionId,
          schemaVersion: 'experience-shadow-prediction-v1',
          capability: 'applicability',
          predictor: { kind: 'deterministic_rule', version: HISTORY_RANKING_PREDICTOR },
          scope: {
            workspaceRoot: usage.planning.fingerprint.environmentRefs[0] ?? null,
            targetExposure: usage.planning.fingerprint.targetExposure,
            riskClass: usage.planning.fingerprint.riskClass,
          },
          inputRefs: [learningRef('usage', usage.planning.plan.usageId, usage.planning.fingerprint.taskInputDigest)],
          prediction: { ranking },
          createdAt: usage.planning.plan.createdAt,
        },
        humanLabels: [],
        observedOutcomes: [],
      })
    }
    recordUsedSamples(history, usage)
  }
  return rows
}

interface RankingCandidate {
  readonly versionId: string
  readonly disposition: PreflightRecordView['disposition']
  readonly structuralScore: number | null
  readonly lexicalScore: number | null
  readonly rejected: boolean
}

/**
 * Deterministic smoothed ordering that readjusts order **only within a group of exactly-equally
 * relevant, currently available candidates** (identical structuralScore AND lexicalScore, and not
 * rejected/unusable), per review-02. Baseline positions are preserved; a member without >=5
 * same-environment used samples keeps its exact baseline position, and only members with >=5
 * samples are stably re-sorted (best-first, ties keep original order) across the group's remaining
 * positions. Different-relevance, rejected, or information-missing candidates keep their baseline
 * position and are never lifted by history.
 */
function proposeHistoryOrder(
  candidates: ReadonlyArray<RankingCandidate>,
  environmentKey: string,
  history: ReadonlyMap<string, RankingSampleState>,
  asOf: string,
): { readonly ordered: readonly string[]; readonly scored: number } {
  // groupKey ties together candidates that are genuinely interchangeable in relevance: exact equal
  // structural + lexical score and reorder-eligible. Anything missing/unsuitable is a fixed group.
  const indexed = candidates.map((candidate, index) => ({ candidate, index }))
  const groups = new Map<string, Array<{ candidate: RankingCandidate; index: number }>>()
  for (const item of indexed) {
    const { candidate } = item
    const eligible = !candidate.rejected
      && (candidate.disposition === 'applicable' || candidate.disposition === 'adaptable')
      && candidate.structuralScore !== null && candidate.lexicalScore !== null
    const key = eligible
      ? `rank:${String(candidate.structuralScore)}|${String(candidate.lexicalScore)}`
      : `fixed:${candidate.versionId}`
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const assigned = new Map<number, string>()
  let scored = 0
  for (const [key, group] of groups) {
    // A non-reorder group (unavailable/rejected/missing relevance) keeps its baseline positions.
    if (key.startsWith('fixed:')) {
      for (const item of group) assigned.set(item.index, item.candidate.versionId)
      continue
    }
    const withState = group.map(item => ({
      ...item,
      entries: samplesAsOf(history.get(`${environmentKey}\u0000${item.candidate.versionId}`), asOf),
    }))
    const unscored = withState.filter(item => {
      const { success, failure } = successFailureCounts(item.entries)
      return success + failure < 5
    })
    const scoredItems = withState
      .filter(item => {
        const { success, failure } = successFailureCounts(item.entries)
        return success + failure >= 5
      })
      .map(item => {
        const { success, failure } = successFailureCounts(item.entries)
        return {
          version: item.candidate.versionId,
          score: (success + 1) / (success + failure + 2),
          index: item.index,
        }
      })
    // Unscored members keep their exact baseline index.
    const taken = new Set(unscored.map(item => item.index))
    for (const item of unscored) assigned.set(item.index, item.candidate.versionId)
    // Scored members fill the group's remaining positions, best-first with ties keeping original order.
    scoredItems.sort((left, right) => right.score - left.score || left.index - right.index)
    const free = group.map(item => item.index).filter(index => !taken.has(index)).sort((a, b) => a - b)
    scoredItems.forEach((item, offset) => assigned.set(free[offset]!, item.version))
    scored += scoredItems.length
  }
  const ordered = indexed.map(item => assigned.get(item.index) ?? item.candidate.versionId)
  return { ordered, scored }
}

function sourceUsageIdsFor(
  baseline: readonly string[],
  environmentKey: string,
  history: ReadonlyMap<string, RankingSampleState>,
  asOf: string,
): string[] {
  const ids = new Set<string>()
  for (const version of baseline) {
    for (const sample of samplesAsOf(history.get(`${environmentKey}\u0000${version}`), asOf)) ids.add(sample.usageId)
  }
  return [...ids].sort()
}

function sampleCountFor(
  baseline: readonly string[],
  environmentKey: string,
  history: ReadonlyMap<string, RankingSampleState>,
  asOf: string,
): number {
  let count = 0
  for (const version of baseline) {
    count += samplesAsOf(history.get(`${environmentKey}\u0000${version}`), asOf).length
  }
  return count
}

/** Record this Usage's actually-used (success/failure) samples so later queries can use them. */
function recordUsedSamples(history: Map<string, RankingSampleState>, usage: LearningUsageSource): void {
  const environmentKey = usage.planning.fingerprint.environmentRefs[0] ?? 'local'
  if (usage.execution.settlement === null) return
  const settledAt = usage.execution.settlement.createdAt
  for (const preflight of usage.planning.preflights) {
    const participation = applicabilityHistory(usage, preflight)
    if (participation.participation !== 'used') continue
    if (participation.taskOutcome !== 'success' && participation.taskOutcome !== 'failure') continue
    const key = `${environmentKey}\u0000${participation.experienceVersionId}`
    const prior = history.get(key)
    const state: RankingSampleState = {
      samples: [...(prior?.samples ?? []), {
        outcome: participation.taskOutcome === 'success' ? 'success' : 'failure',
        usageId: participation.usageId,
        settledAt,
      }],
    }
    history.set(key, state)
  }
}

function buildRevisionLearning(
  handle: DatabaseSync,
  usages: readonly LearningUsageSource[],
  forgottenVersions: ReadonlySet<string>,
): LearningRowBuild[] {
  const rows = handle.prepare(
    'SELECT revision_proposal_id FROM revision_proposals ORDER BY created_at, revision_proposal_id',
  ).all() as Array<{ revision_proposal_id: string }>
  return rows.flatMap(row => {
    const proposal = readRevisionProposal(handle, row.revision_proposal_id)
    if (forgottenVersions.has(String(proposal.baseVersionId))
      || (proposal.publishedVersionId !== null && forgottenVersions.has(String(proposal.publishedVersionId)))) return []
    const predictionId = learningPredictionId('revision', [proposal.revisionProposalId, proposal.baseVersionId])
    const humanLabels = revisionHumanLabels(handle, predictionId, proposal)
    // Same strict attribution as applicability: only a genuinely updated Version that was selected,
    // delivered and executed in the same Usage earns a settlement result.
    const publishedVersionId = proposal.publishedVersionId
    const observedOutcomes = publishedVersionId === null ? [] : usages.flatMap(usage => {
      const participation = participationForVersion(usage, String(publishedVersionId))
      if (participation === null || participation.participation !== 'used' || usage.execution.settlement === null) return []
      return [settlementLearningOutcome(predictionId, usage.execution.settlement)]
    })
    return [{
      prediction: {
        predictionId,
        schemaVersion: 'experience-shadow-prediction-v1',
        capability: 'revision',
        predictor: { kind: 'deterministic_rule', version: 'm5-minimal-revision-v1' },
        scope: { experienceId: String(proposal.experienceId), baseVersionId: String(proposal.baseVersionId) },
        inputRefs: [
          learningRef('revision_proposal', proposal.revisionProposalId, digest(proposal.diagnosis)),
          ...(proposal.sourceUsageId === null ? [] : [learningRef('usage', proposal.sourceUsageId, null)]),
          ...(proposal.sourceMarkdownProjectionReceiptId === null ? []
            : [learningRef('markdown_projection', proposal.sourceMarkdownProjectionReceiptId, null)]),
          learningRef('version', proposal.baseVersionId, null),
        ],
        prediction: {
          diagnosis: proposal.diagnosis,
          changes: proposal.changes.map(change => ({
            revisionChangeId: change.revisionChangeId,
            componentId: change.componentId,
            semanticRole: change.semanticRole,
            replacementContent: change.replacementContent,
            sourceRefs: change.sourceRefs,
          })),
        },
        createdAt: proposal.createdAt,
      },
      humanLabels,
      observedOutcomes,
    }]
  })
}

function buildExecutionLearning(
  handle: DatabaseSync,
  usages: readonly LearningUsageSource[],
  forgottenVersions: ReadonlySet<string>,
): LearningRowBuild[] {
  return usages.filter(({ planning }) => !planning.plan.selectedContributions.some(
    contribution => forgottenVersions.has(String(contribution.experienceVersionId)),
  )).map(({ planning, execution }) => {
    const plan = planning.plan
    const predictionId = learningPredictionId('execution', [plan.usagePlanId, plan.contentDigest])
    const humanLabels = planHumanLabels(handle, predictionId, planning.approvalRequest)
    return {
      prediction: {
        predictionId,
        schemaVersion: 'experience-shadow-prediction-v1',
        capability: 'execution',
        predictor: { kind: 'deterministic_rule', version: 'm5-guided-execution-v1' },
        scope: {
          workspaceRoot: planning.fingerprint.environmentRefs[0] ?? null,
          targetExposure: planning.fingerprint.targetExposure,
          riskClass: planning.fingerprint.riskClass,
        },
        inputRefs: [
          learningRef('usage', plan.usageId, planning.fingerprint.taskInputDigest),
          learningRef('plan', plan.usagePlanId, plan.contentDigest),
          ...plan.preflightIds.map(id => learningRef('preflight', id, null)),
        ],
        prediction: {
          disposition: plan.disposition,
          orderedSteps: plan.orderedSteps,
          constraints: plan.constraints,
          recovery: plan.recovery,
          verification: plan.verification,
          requiresApproval: plan.requiresApproval,
        },
        createdAt: plan.createdAt,
      },
      humanLabels,
      observedOutcomes: execution.settlement === null
        ? [] : [settlementLearningOutcome(predictionId, execution.settlement)],
    }
  })
}

function planHumanLabels(
  handle: DatabaseSync,
  predictionId: LearningPredictionId,
  request: PlanApprovalRequestView | null,
): LearningHumanLabelView[] {
  if (request === null || request.status === 'pending' || request.status === 'expired') return []
  if (request.status === 'approved' || request.status === 'denied') {
    if (request.decisionId === null || request.decidedAt === null) {
      throw new ExperienceError('database_schema_invalid', 'decided PlanApprovalRequest is missing its decision identity')
    }
    const decision = handle.prepare(
      'SELECT actor_id, payload_json, created_at FROM governance_decisions WHERE decision_id = ?',
    ).get(request.decisionId) as { actor_id: string; payload_json: string; created_at: string } | undefined
    if (decision === undefined) {
      throw new ExperienceError('database_schema_invalid', 'PlanApprovalRequest governance decision is missing')
    }
    return [planHumanLabel(
      predictionId,
      request.status,
      request.reason,
      brandedId<'ExperienceActorId'>(decision.actor_id, 'actorId'),
      learningRef('governance_decision', request.decisionId, digest(JSON.parse(decision.payload_json))),
      request,
      decision.created_at,
    )]
  }
  if (request.status === 'withdrawn') {
    const rows = handle.prepare(
      `SELECT receipt_id, payload_json, created_at FROM domain_receipts
       WHERE action = 'plan.withdraw' AND json_extract(payload_json, '$.requestId') = ?
       ORDER BY commit_sequence`,
    ).all(request.requestId) as Array<{ receipt_id: string; payload_json: string; created_at: string }>
    if (rows.length !== 1) return []
    const receipt = parsePlanningObject<PlanningReceipt>(rows[0]!.payload_json, 'Plan withdrawal receipt')
    return [planHumanLabel(
      predictionId,
      'withdrawn',
      request.reason,
      receipt.actor.actorId,
      learningRef('receipt', receipt.receiptId, null),
      request,
      rows[0]!.created_at,
    )]
  }
  const adaptations = handle.prepare(
    `SELECT audit_id, actor_id, object_refs_json, payload_digest, created_at
     FROM audit_events WHERE action = 'plan.adapt' ORDER BY created_at, audit_id`,
  ).all() as Array<{
    audit_id: string
    actor_id: string
    object_refs_json: string
    payload_digest: string
    created_at: string
  }>
  const adaptation = adaptations.find(item => parseLearningStringArray(
    item.object_refs_json,
    'Plan adaptation object refs',
  ).includes(request.requestId))
  if (adaptation === undefined) return []
  return [planHumanLabel(
    predictionId,
    'adapted',
    request.reason,
    brandedId<'ExperienceActorId'>(adaptation.actor_id, 'actorId'),
    learningRef('audit', adaptation.audit_id, adaptation.payload_digest),
    request,
    adaptation.created_at,
  )]
}

function planHumanLabel(
  predictionId: LearningPredictionId,
  decision: string,
  reason: string | null,
  actorId: ActorId,
  decisionRef: LearningSourceRefView,
  request: PlanApprovalRequestView,
  createdAt: string,
): LearningHumanLabelView {
  return {
    labelId: humanLabelId(predictionId, decisionRef.id),
    schemaVersion: 'experience-human-label-v1',
    decision,
    reason,
    actorId,
    sourceRefs: [learningRef('approval_request', request.requestId, null), decisionRef],
    createdAt,
  }
}

function revisionHumanLabels(
  handle: DatabaseSync,
  predictionId: LearningPredictionId,
  proposal: RevisionProposalView,
): LearningHumanLabelView[] {
  const decided = proposal.changes.filter(change => change.decision !== 'pending')
  if (decided.length !== 1) return []
  const rows = handle.prepare(
    `SELECT receipt_id, payload_json FROM domain_receipts
     WHERE action = 'revision.change_decide'
       AND json_extract(payload_json, '$.revisionProposalId') = ?
     ORDER BY commit_sequence`,
  ).all(proposal.revisionProposalId) as Array<{ receipt_id: string; payload_json: string }>
  if (rows.length !== 1) return []
  const receipt = parsePlanningObject<M5DomainReceipt>(rows[0]!.payload_json, 'Revision decision receipt')
  const change = decided[0]!
  return [{
    labelId: humanLabelId(predictionId, rows[0]!.receipt_id),
    schemaVersion: 'experience-human-label-v1',
    decision: `${change.semanticRole}:${change.decision}`,
    reason: change.decisionReason,
    actorId: receipt.actor.actorId,
    sourceRefs: [
      learningRef('revision_change', change.revisionChangeId, digest(change)),
      learningRef('receipt', receipt.receiptId, null),
    ],
    createdAt: receipt.createdAt,
  }]
}

const AUTOMATION_LEVELS = ['disabled', 'shadow', 'suggest', 'human_approved', 'limited_auto', 'full_auto'] as const

function automationLevelRank(level: AutomationCapabilityView['currentLevel']): number {
  return AUTOMATION_LEVELS.indexOf(level)
}

/** Every independently governed subject: the six projection capabilities plus the history ranking. */
const LEARNING_GOVERNANCE_SUBJECTS: readonly LearningGovernanceCapability[] = [...LEARNING_CAPABILITIES, HISTORY_RANKING_CAPABILITY]

function ensureLearningGovernance(handle: DatabaseSync, createdAt: string): void {
  const insertContract = handle.prepare(
    `INSERT OR IGNORE INTO unlock_contracts
      (unlock_contract_id, capability, contract_version, payload_json, created_at)
     VALUES (?, ?, 1, ?, ?)`,
  )
  const insertCapability = handle.prepare(
    `INSERT OR IGNORE INTO automation_capabilities
      (capability, state, policy_revision, payload_json, updated_at)
     VALUES (?, 'shadow', 1, ?, ?)`,
  )
  for (const capability of LEARNING_GOVERNANCE_SUBJECTS) {
    const contract = capability === HISTORY_RANKING_CAPABILITY
      ? defaultHistoryRankingUnlockContract(createdAt)
      : defaultUnlockContract(capability, createdAt)
    const state: AutomationCapabilityView = {
      schemaVersion: 'experience-automation-capability-v1',
      capability,
      currentLevel: 'shadow',
      activeUnlockContractId: contract.unlockContractId,
      allowedScope: {},
      policyRevision: 1,
      lastEvaluationId: null,
      lastDecisionId: null,
      lastReason: 'initial_shadow_policy',
      updatedAt: createdAt,
    }
    insertContract.run(contract.unlockContractId, capability, JSON.stringify(contract), createdAt)
    insertCapability.run(capability, JSON.stringify(state), createdAt)
  }
}

/** The history_ranking contract binds the opt-history-ranking predictor with owner-preference metrics. */
function defaultHistoryRankingUnlockContract(createdAt: string): UnlockContractView {
  return {
    unlockContractId: brandedId<'ExperienceUnlockContractId'>(
      `unlock-contract:${HISTORY_RANKING_CAPABILITY}:1`, 'unlockContractId'),
    schemaVersion: 'experience-unlock-contract-v1',
    capability: HISTORY_RANKING_CAPABILITY,
    predictor: HISTORY_RANKING_PREDICTOR,
    fromLevel: 'shadow',
    toLevel: 'suggest',
    allowedScope: { authority: 'local_owner', riskClass: 'standard' },
    excludedRiskClasses: ['high', 'critical'],
    inputRequirements: ['source_bound_prediction', 'readable_comparison', 'owner_ranking_review'],
    hardSafetyInvariants: ['no_privacy_violation', 'no_permission_violation', 'no_self_prediction_as_label'],
    metricDefinitions: {
      [`predictor:${HISTORY_RANKING_PREDICTOR}`]: 'binding to the opt-history-ranking predictor',
      ownerProposedPreferenceRatio: 'owner proposed-first reviews divided by valid proposed-or-baseline reviews',
      baselineFirstCount: 'owner reviews preferring the unmodified baseline order',
      unknownOrEquivalentNotSuccess: 'unknown/equivalent reviews never count as a proposed win',
    },
    thresholdPolicy: {
      minimumHumanAgreement: 0,
      minimumOutcomeSuccess: 0,
      maximumUnknownRate: 0,
      minimumOwnerProposedRatio: 0.8,
    },
    minimumSampleCoverage: 5,
    requiredNegativeClasses: ['baseline_first_review'],
    evaluationWindow: { startsAt: null, endsAt: null },
    approverPolicy: 'local_owner',
    rolloutLimit: 10,
    stopConditions: ['safety', 'privacy', 'permission', 'metric_drift', 'unknown_spike'],
    demotionTarget: 'shadow',
    contractVersion: 1,
    createdAt,
  }
}

/** Does the query scope fall inside the ranking contract's exact allowed scope? */
/** Exact scope admission: workspace root (null-inclusive path equality), targetExposure, riskClass. */
function rankingScopeAdmitted(
  allowedScope: Readonly<Record<string, string | null>>,
  excludedRiskClasses: readonly string[],
  input: HistoryRankingGateInput,
): boolean {
  if (excludedRiskClasses.includes(input.riskClass)) return false
  const allowedWorkspace = allowedScope.workspaceRoot ?? null
  const inputWorkspace = input.workspaceRoot ?? null
  if (allowedWorkspace !== inputWorkspace) return false
  if (allowedScope.targetExposure !== undefined && allowedScope.targetExposure !== input.targetExposure) return false
  if (allowedScope.riskClass !== undefined && allowedScope.riskClass !== input.riskClass) return false
  return true
}

/** Has the ranking predictor hit the contract's rollout limit under the current authorize decision? */
function rankingRolloutExhausted(
  handle: DatabaseSync,
  _capability: AutomationCapabilityView,
  contract: UnlockContractView,
  decisionId: string | null,
): boolean {
  if (decisionId === null) return true
  const row = handle.prepare(
    `SELECT COUNT(*) AS n FROM governance_decisions
      WHERE json_extract(payload_json, '$.decisionType') = 'history_ranking.apply'
        AND json_extract(payload_json, '$.decisionId') = ?`,
  ).get(decisionId) as { n: number } | undefined
  const applied = row?.n ?? 0
  return applied >= contract.rolloutLimit
}

function defaultUnlockContract(capability: LearningCapability, createdAt: string): UnlockContractView {
  const requiresOutcome = capability === 'applicability' || capability === 'revision'
    || capability === 'merge' || capability === 'execution'
  return {
    unlockContractId: brandedId<'ExperienceUnlockContractId'>(
      `unlock-contract:${capability}:1`, 'unlockContractId'),
    schemaVersion: 'experience-unlock-contract-v1',
    capability,
    predictor: null,
    fromLevel: 'shadow',
    toLevel: 'suggest',
    allowedScope: { authority: 'local_owner', riskClass: 'standard' },
    excludedRiskClasses: ['high', 'critical'],
    inputRequirements: [
      'source_bound_prediction',
      'exact_human_label',
      ...(requiresOutcome ? ['non_unknown_observed_outcome'] : []),
    ],
    hardSafetyInvariants: ['no_privacy_violation', 'no_permission_violation', 'no_unknown_as_success'],
    metricDefinitions: {
      humanAgreementRate: 'affirmative human-labeled predictions divided by human-labeled predictions',
      outcomeSuccessRate: 'successful non-unknown outcomes divided by outcome-labeled predictions',
      unknownRate: 'explicit unknown outcomes divided by predictions',
      sampleCoverage: requiresOutcome
        ? 'predictions with human and non-unknown outcome labels'
        : 'predictions with a human label',
    },
    thresholdPolicy: {
      minimumHumanAgreement: 0.8,
      minimumOutcomeSuccess: requiresOutcome ? 0.8 : 0,
      maximumUnknownRate: 0,
    },
    minimumSampleCoverage: 3,
    requiredNegativeClasses: ['human_rejection_or_failed_outcome'],
    evaluationWindow: { startsAt: null, endsAt: null },
    approverPolicy: 'local_owner',
    rolloutLimit: 10,
    stopConditions: ['safety', 'privacy', 'permission', 'metric_drift', 'unknown_spike'],
    demotionTarget: 'shadow',
    contractVersion: 1,
    createdAt,
  }
}

function readUnlockContractForCapability(handle: DatabaseSync, capability: LearningGovernanceCapability): UnlockContractView {
  const row = handle.prepare(
    'SELECT payload_json FROM unlock_contracts WHERE capability = ? ORDER BY contract_version DESC LIMIT 1',
  ).get(capability) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'UnlockContract is missing')
  const value = parseLearningObject<UnlockContractView>(row.payload_json, 'UnlockContract', 'experience-unlock-contract-v1')
  if (value.capability !== capability) throw new ExperienceError('database_schema_invalid', 'UnlockContract capability is inconsistent')
  return value
}

function readUnlockEvaluation(
  handle: DatabaseSync,
  evaluationId: UnlockContractEvaluationId,
): UnlockContractEvaluationView {
  const row = handle.prepare(
    'SELECT capability, payload_json FROM unlock_contract_evaluations WHERE evaluation_id = ?',
  ).get(evaluationId) as { capability: string; payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'UnlockContractEvaluation was not found')
  const value = parseLearningObject<UnlockContractEvaluationView>(
    row.payload_json, 'UnlockContractEvaluation', 'experience-unlock-evaluation-v1')
  if (value.unlockContractEvaluationId !== evaluationId || value.capability !== row.capability) {
    throw new ExperienceError('database_schema_invalid', 'UnlockContractEvaluation durable identity is inconsistent')
  }
  return value
}

function readAutomationCapability(handle: DatabaseSync, capability: LearningGovernanceCapability): AutomationCapabilityView {
  const row = handle.prepare(
    'SELECT state, policy_revision, payload_json FROM automation_capabilities WHERE capability = ?',
  ).get(capability) as { state: string; policy_revision: number; payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'AutomationCapability is missing')
  const value = parseLearningObject<AutomationCapabilityView>(
    row.payload_json, 'AutomationCapability', 'experience-automation-capability-v1')
  if (value.capability !== capability || value.currentLevel !== row.state || value.policyRevision !== row.policy_revision) {
    throw new ExperienceError('database_schema_invalid', 'AutomationCapability durable state is inconsistent')
  }
  return value
}

function readLearningGovernance(handle: DatabaseSync): LearningGovernanceView {
  const contracts = LEARNING_CAPABILITIES.map(capability => readUnlockContractForCapability(handle, capability))
  const evaluationRows = handle.prepare(
    'SELECT evaluation_id FROM unlock_contract_evaluations ORDER BY created_at, evaluation_id',
  ).all() as Array<{ evaluation_id: string }>
  return {
    contracts,
    evaluations: evaluationRows.map(row => readUnlockEvaluation(
      handle, brandedId<'ExperienceUnlockContractEvaluationId'>(row.evaluation_id, 'evaluationId'))),
    capabilities: LEARNING_CAPABILITIES.map(capability => readAutomationCapability(handle, capability)),
    historyRanking: readHistoryRankingGovernance(handle),
  }
}

/** Read the independent history_ranking governance subject (kept out of the old six-capability view). */
function readHistoryRankingGovernance(handle: DatabaseSync): HistoryRankingGovernanceView {
  const contract = readUnlockContractForCapability(handle, HISTORY_RANKING_CAPABILITY)
  const capability = readAutomationCapability(handle, HISTORY_RANKING_CAPABILITY)
  const evaluationRows = handle.prepare(
    'SELECT evaluation_id FROM unlock_contract_evaluations WHERE capability = ? ORDER BY created_at, evaluation_id',
  ).all(HISTORY_RANKING_CAPABILITY) as Array<{ evaluation_id: string }>
  return {
    contract,
    capability,
    evaluations: evaluationRows.map(row => readUnlockEvaluation(
      handle, brandedId<'ExperienceUnlockContractEvaluationId'>(row.evaluation_id, 'evaluationId'))),
  }
}

function rankingReviewFromDecision(payload: Record<string, unknown>): HistoryRankingReviewView | null {
  const review = payload.review
  return isRecord(review) && review.schemaVersion === 'experience-history-ranking-review-v1'
    ? (review as unknown as HistoryRankingReviewView) : null
}

function readRankingReviews(handle: DatabaseSync): HistoryRankingReviewView[] {
  const rows = handle.prepare(
    `SELECT payload_json FROM governance_decisions
      WHERE json_extract(payload_json, '$.decisionType') = 'history_ranking.review'
      ORDER BY created_at`,
  ).all() as Array<{ payload_json: string }>
  const reviews: HistoryRankingReviewView[] = []
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    const review = rankingReviewFromDecision(payload)
    if (review !== null) reviews.push(review)
  }
  return reviews.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.reviewId.localeCompare(right.reviewId))
}

function findReviewForComparison(
  handle: DatabaseSync,
  predictionId: string,
  rankingDigest: string,
): HistoryRankingReviewView | null {
  return readRankingReviews(handle).find(review =>
    String(review.predictionId) === predictionId && review.rankingDigest === rankingDigest) ?? null
}

/** Read the recorded history-ranking apply records (no actor gate; used by the rebuildable projection). */
function readRankingApplyRecords(handle: DatabaseSync): HistoryRankingApplyRecord[] {
  const rows = handle.prepare(
    `SELECT payload_json FROM governance_decisions
      WHERE json_extract(payload_json, '$.decisionType') = 'history_ranking.apply'
      ORDER BY created_at`,
  ).all() as Array<{ payload_json: string }>
  const records: HistoryRankingApplyRecord[] = []
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    if (isRecord(payload.apply) && payload.apply.schemaVersion === 'experience-history-ranking-apply-v1') {
      records.push(payload.apply as unknown as HistoryRankingApplyRecord)
    }
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/** Exact comparison-scope identity (workspaceRoot incl null, targetExposure, riskClass). */
function reviewScopeKey(review: HistoryRankingReviewView): string {
  return canonicalJson({
    workspaceRoot: review.scope.workspaceRoot ?? null,
    targetExposure: review.scope.targetExposure,
    riskClass: review.scope.riskClass,
  })
}

/** Is a review's comparison still readable in the current projection with the same digest? */
function rankingReviewIsFresh(projection: LearningProjectionView, review: HistoryRankingReviewView): boolean {
  return projection.rows.some(row => row.predictionId === review.predictionId
    && row.predictor.version === HISTORY_RANKING_PREDICTOR
    && digest({ projectionKey: projection.projectionKey, builderVersion: projection.builderVersion, ranking: row.prediction.ranking })
      === review.rankingDigest)
}

/** Are all the evaluation-time owner reviews still current (same subject, same readable comparisons)? */
function rankingEvaluationIsFresh(handle: DatabaseSync, evaluation: UnlockContractEvaluationView): boolean {
  const reviews = readRankingReviews(handle)
  const projection = readLearningProjection(handle)
  const reviewIds = new Set(evaluation.reviewIds ?? [])
  if (reviewIds.size === 0) return false
  const matched = reviews.filter(review => reviewIds.has(review.reviewId))
  return matched.length === reviewIds.size && matched.every(review => rankingReviewIsFresh(projection, review))
}

/**
 * Dedicated history_ranking evaluation computed from the immutable owner reviews only. It never uses
 * the old applicability approval/outcome rates. Conservative rules: exact same scope (workspaceRoot
 * incl null, targetExposure, riskClass=standard), >=5 different-Usage valid comparisons, >=1
 * baseline-first negative, proposed-preference ratio >=0.8, unknown not a win and equivalent not a
 * win. A mixed-scope or stale/missing comparison makes the whole evaluation inconclusive.
 */
function evaluateHistoryRankingContract(
  contract: UnlockContractView,
  reviews: readonly HistoryRankingReviewView[],
  projection: LearningProjectionView,
  evaluatedAt: string,
): UnlockContractEvaluationView {
  const scopes = new Set(reviews.map(reviewScopeKey))
  const uniformScope = scopes.size <= 1
  const valid = reviews.filter(review =>
    canonicalJson(review.baselineVersionIds) !== canonicalJson(review.proposedVersionIds))
  const allFresh = valid.every(review => rankingReviewIsFresh(projection, review))
  const inconclusive = !uniformScope || !allFresh || valid.length < contract.minimumSampleCoverage
  const distinctUsages = new Set(valid.map(review => review.usageId))
  const proposedCount = valid.filter(review => review.preferredOrder === 'proposed').length
  const baselineFirstCount = valid.filter(review => review.preferredOrder === 'baseline').length
  const equivalentCount = valid.filter(review => review.preferredOrder === 'equivalent').length
  const unknownReviewCount = valid.filter(review => review.preferredOrder === 'unknown').length
  const ratio = proposedCount + baselineFirstCount > 0
    ? proposedCount / (proposedCount + baselineFirstCount) : null
  const requiredRatio = contract.thresholdPolicy.minimumOwnerProposedRatio ?? 0.8
  const complete = !inconclusive && distinctUsages.size >= contract.minimumSampleCoverage
    && baselineFirstCount >= 1 && ratio !== null && ratio >= requiredRatio
  const outcome = inconclusive ? 'inconclusive' : complete ? 'passed' : 'failed'
  const identity = canonicalJson({
    contractId: contract.unlockContractId,
    reviewIds: reviews.map(review => review.reviewId),
    evaluatedAt,
  })
  // The exact single scope (workspaceRoot incl null) this evaluation qualifies, from the first review.
  const qualifiedScope = reviews.length === 0 ? null : {
    workspaceRoot: reviews[0]!.scope.workspaceRoot ?? null,
    targetExposure: reviews[0]!.scope.targetExposure ?? null,
    riskClass: reviews[0]!.scope.riskClass ?? null,
  }
  return {
    unlockContractEvaluationId: brandedId<'ExperienceUnlockContractEvaluationId'>(
      `unlock-evaluation:${sha256(identity)}`, 'evaluationId'),
    schemaVersion: 'experience-unlock-evaluation-v1',
    unlockContractId: contract.unlockContractId,
    capability: HISTORY_RANKING_CAPABILITY,
    shadowPredictionIds: valid.map(review => review.predictionId),
    humanLabelIds: [],
    outcomeLabelIds: [],
    usageSettlementIds: [],
    evaluationWindow: contract.evaluationWindow,
    metricImplementationVersion: 'history-ranking-metrics-v1',
    metricResults: {
      totalPredictions: reviews.length,
      humanLabeledPredictions: 0,
      outcomeLabeledPredictions: 0,
      humanAgreementRate: null,
      outcomeSuccessRate: null,
      unknownRate: 0,
      reviewCount: valid.length,
      proposedPreferenceRatio: ratio,
      baselineFirstCount,
      equivalentCount,
      unknownReviewCount,
    },
    sampleCoverage: distinctUsages.size,
    negativeClassCoverage: baselineFirstCount >= 1 ? ['baseline_first_review'] : [],
    hardInvariantResults: {
      no_privacy_violation: 'pass',
      no_permission_violation: 'pass',
      no_self_prediction_as_label: 'pass',
    },
    outcome,
    evaluatedAt,
    reviewIds: reviews.map(review => review.reviewId),
    scope: qualifiedScope,
  }
}

function evaluateUnlockContract(
  contract: UnlockContractView,
  rows: readonly LearningPredictionView[],
  evaluatedAt: string,
): UnlockContractEvaluationView {
  const requiresOutcome = contract.inputRequirements.includes('non_unknown_observed_outcome')
  const humanLabeled = rows.filter(row => row.humanLabels.length > 0)
  const outcomeLabeled = rows.filter(row => row.observedOutcomes.length > 0)
  const paired = rows.filter(row => row.humanLabels.length > 0 && (!requiresOutcome
    || row.observedOutcomes.some(label => label.outcome !== 'unknown')))
  const humanAgreement = humanLabeled.filter(row =>
    row.humanLabels.every(label => affirmativeLearningDecision(label.decision)))
  const successfulOutcomes = outcomeLabeled.filter(row => row.observedOutcomes.some(label => label.outcome === 'success'))
  const negativeClassCoverage = rows.some(row => row.humanLabels.some(label => !affirmativeLearningDecision(label.decision))
    || row.observedOutcomes.some(label => label.outcome !== 'success'))
    ? ['human_rejection_or_failed_outcome'] : []
  const sourceBound = rows.every(row => row.inputRefs.length > 0 && row.inputRefs.every(ref => ref.id.trim() !== ''))
  const unknownOutcomes = rows.filter(row => row.observedOutcomes.some(label => label.outcome === 'unknown'))
  const unknownRate = rows.length === 0 ? 0 : unknownOutcomes.length / rows.length
  const humanAgreementRate = humanLabeled.length === 0 ? null : humanAgreement.length / humanLabeled.length
  const outcomeSuccessRate = outcomeLabeled.length === 0 ? null : successfulOutcomes.length / outcomeLabeled.length
  const sampleCoverage = paired.length
  const hardInvariantResults: UnlockContractEvaluationView['hardInvariantResults'] = {
    no_privacy_violation: 'pass',
    no_permission_violation: 'pass',
    no_unknown_as_success: sourceBound ? 'pass' : 'fail',
  }
  const complete = rows.length > 0
    && sampleCoverage >= contract.minimumSampleCoverage
    && contract.requiredNegativeClasses.every(item => negativeClassCoverage.includes(item))
    && humanAgreementRate !== null
    && (!requiresOutcome || outcomeSuccessRate !== null)
  const thresholdsPass = humanAgreementRate !== null
    && humanAgreementRate >= contract.thresholdPolicy.minimumHumanAgreement
    && (!requiresOutcome || (outcomeSuccessRate !== null
      && outcomeSuccessRate >= contract.thresholdPolicy.minimumOutcomeSuccess))
    && unknownRate <= contract.thresholdPolicy.maximumUnknownRate
  const invariantPass = Object.values(hardInvariantResults).every(result => result === 'pass')
  const outcome = !complete ? 'inconclusive' : thresholdsPass && invariantPass ? 'passed' : 'failed'
  const humanLabelIds = humanLabeled.flatMap(row => row.humanLabels.map(label => label.labelId))
  const outcomeLabelIds = outcomeLabeled.flatMap(row => row.observedOutcomes.map(label => label.labelId))
  const settlementIds = outcomeLabeled.flatMap(row => row.observedOutcomes.flatMap(label => label.sourceRefs
    .filter(ref => ref.kind === 'settlement')
    .map(ref => brandedId<'ExperienceSettlementId'>(ref.id, 'settlementId'))))
  const identity = canonicalJson({
    contractId: contract.unlockContractId,
    predictionIds: rows.map(row => row.predictionId),
    humanLabelIds,
    outcomeLabelIds,
    evaluatedAt,
  })
  return {
    unlockContractEvaluationId: brandedId<'ExperienceUnlockContractEvaluationId'>(
      `unlock-evaluation:${sha256(identity)}`, 'evaluationId'),
    schemaVersion: 'experience-unlock-evaluation-v1',
    unlockContractId: contract.unlockContractId,
    capability: contract.capability,
    shadowPredictionIds: rows.map(row => row.predictionId),
    humanLabelIds,
    outcomeLabelIds,
    usageSettlementIds: uniqueStrings(settlementIds) as unknown as SettlementId[],
    evaluationWindow: contract.evaluationWindow,
    metricImplementationVersion: 'learning-unlock-metrics-v1',
    metricResults: {
      totalPredictions: rows.length,
      humanLabeledPredictions: humanLabeled.length,
      outcomeLabeledPredictions: outcomeLabeled.length,
      humanAgreementRate,
      outcomeSuccessRate,
      unknownRate,
    },
    sampleCoverage,
    negativeClassCoverage,
    hardInvariantResults,
    outcome,
    evaluatedAt,
  }
}

function affirmativeLearningDecision(decision: string): boolean {
  return !/(?:reject|denied|withdrawn|failed|invalid|declined)/iu.test(decision)
}

function validatePreferenceEnforcement(
  enforcement: import('../types.js').PreferenceEnforcementView,
  output: string,
): PreferenceOutputValidationView['results'][number] {
  if (enforcement.classification !== 'post_output_validation') {
    return {
      experienceVersionId: enforcement.experienceVersionId,
      classification: enforcement.classification,
      result: 'not_applicable',
      reasonCode: 'preference_not_output_scoped',
    }
  }
  const normalized = output.normalize('NFKC').toLocaleLowerCase()
  const positive = enforcement.positiveExample?.normalize('NFKC').toLocaleLowerCase() ?? null
  const negative = enforcement.negativeExample?.normalize('NFKC').toLocaleLowerCase() ?? null
  if (negative !== null && negative !== '' && normalized.includes(negative)) {
    return {
      experienceVersionId: enforcement.experienceVersionId,
      classification: enforcement.classification,
      result: 'failed',
      reasonCode: 'preference_negative_example_observed',
    }
  }
  if (positive !== null && positive !== '' && normalized.includes(positive)) {
    return {
      experienceVersionId: enforcement.experienceVersionId,
      classification: enforcement.classification,
      result: 'passed',
      reasonCode: 'preference_positive_example_observed',
    }
  }
  return {
    experienceVersionId: enforcement.experienceVersionId,
    classification: enforcement.classification,
    result: 'unknown',
    reasonCode: positive === null && negative === null
      ? 'preference_has_no_machine_checkable_example'
      : 'preference_examples_not_observed',
  }
}

function unlockEvaluationMatchesRows(
  evaluation: UnlockContractEvaluationView,
  rows: readonly LearningPredictionView[],
): boolean {
  const predictionIds = rows.map(row => row.predictionId).sort()
  const humanLabelIds = rows.flatMap(row => row.humanLabels.map(label => label.labelId)).sort()
  const outcomeLabelIds = rows.flatMap(row => row.observedOutcomes.map(label => label.labelId)).sort()
  return canonicalJson(predictionIds) === canonicalJson([...evaluation.shadowPredictionIds].sort())
    && canonicalJson(humanLabelIds) === canonicalJson([...evaluation.humanLabelIds].sort())
    && canonicalJson(outcomeLabelIds) === canonicalJson([...evaluation.outcomeLabelIds].sort())
}

function replaceLearningRows(handle: DatabaseSync, rows: readonly LearningRowBuild[]): void {
  const ids = handle.prepare(
    "SELECT prediction_id FROM shadow_predictions WHERE capability IN ('extraction','applicability','revision','merge','causal_promotion','execution')",
  ).all() as Array<{ prediction_id: string }>
  const deleteHuman = handle.prepare('DELETE FROM human_labels WHERE prediction_id = ?')
  const deleteOutcome = handle.prepare('DELETE FROM observed_outcome_labels WHERE prediction_id = ?')
  const deletePrediction = handle.prepare('DELETE FROM shadow_predictions WHERE prediction_id = ?')
  for (const row of ids) {
    deleteHuman.run(row.prediction_id)
    deleteOutcome.run(row.prediction_id)
    deletePrediction.run(row.prediction_id)
  }
  const insertPrediction = handle.prepare(
    'INSERT INTO shadow_predictions (prediction_id, capability, payload_json, created_at) VALUES (?, ?, ?, ?)',
  )
  const insertHuman = handle.prepare(
    'INSERT INTO human_labels (label_id, prediction_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
  )
  const insertOutcome = handle.prepare(
    'INSERT INTO observed_outcome_labels (label_id, prediction_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const row of rows) {
    insertPrediction.run(row.prediction.predictionId, row.prediction.capability,
      JSON.stringify(row.prediction), row.prediction.createdAt)
    for (const label of row.humanLabels) {
      insertHuman.run(label.labelId, row.prediction.predictionId, JSON.stringify(label), label.createdAt)
    }
    for (const outcome of row.observedOutcomes) {
      insertOutcome.run(outcome.labelId, row.prediction.predictionId, JSON.stringify(outcome), outcome.createdAt)
    }
  }
}

function readLearningProjection(handle: DatabaseSync): LearningProjectionView {
  const checkpoint = handle.prepare(
    'SELECT source_offset, generation, builder_version FROM projection_checkpoints WHERE projection_key = ?',
  ).get(LEARNING_PROJECTION_KEY) as { source_offset: number; generation: number; builder_version: string } | undefined
  if (checkpoint !== undefined && checkpoint.builder_version !== LEARNING_BUILDER_VERSION) {
    throw new ExperienceError('database_schema_invalid', 'Experience learning projection builder version is unsupported')
  }
  const predictions = handle.prepare(
    "SELECT prediction_id, capability, payload_json FROM shadow_predictions WHERE capability IN ('extraction','applicability','revision','merge','causal_promotion','execution') ORDER BY capability, prediction_id",
  ).all() as Array<{ prediction_id: string; capability: string; payload_json: string }>
  const humanLabels = groupLearningLabels<LearningHumanLabelView>(handle.prepare(
    'SELECT label_id, prediction_id, payload_json FROM human_labels ORDER BY created_at, label_id',
  ).all() as Array<{ label_id: string; prediction_id: string; payload_json: string }>,
  'HumanLabel', 'experience-human-label-v1')
  const observedOutcomes = groupLearningLabels<LearningObservedOutcomeView>(handle.prepare(
    'SELECT label_id, prediction_id, payload_json FROM observed_outcome_labels ORDER BY created_at, label_id',
  ).all() as Array<{ label_id: string; prediction_id: string; payload_json: string }>,
  'ObservedOutcomeLabel', 'experience-observed-outcome-v1')
  const rows = predictions.map(row => {
    if (!isLearningCapability(row.capability)) {
      throw new ExperienceError('database_schema_invalid', 'Experience learning capability is invalid')
    }
    const prediction = parseLearningObject<Omit<LearningPredictionView, 'humanLabels' | 'observedOutcomes'>>(
      row.payload_json, 'ShadowPrediction', 'experience-shadow-prediction-v1')
    if (prediction.predictionId !== row.prediction_id || prediction.capability !== row.capability) {
      throw new ExperienceError('database_schema_invalid', 'ShadowPrediction durable identity is inconsistent')
    }
    return {
      ...prediction,
      humanLabels: humanLabels.get(row.prediction_id) ?? [],
      observedOutcomes: observedOutcomes.get(row.prediction_id) ?? [],
    }
  })
  const counts: Record<LearningCapability, number> = {
    extraction: 0, applicability: 0, revision: 0, merge: 0, causal_promotion: 0, execution: 0,
  }
  for (const row of rows) counts[row.capability] += 1
  return {
    projectionKey: LEARNING_PROJECTION_KEY,
    builderVersion: LEARNING_BUILDER_VERSION,
    generation: checkpoint?.generation ?? 0,
    sourceOffset: checkpoint?.source_offset ?? 0,
    rows,
    counts,
    unsupportedCapabilities: [],
  }
}

function settlementLearningOutcome(
  predictionId: LearningPredictionId,
  settlement: UsageSettlementView,
): LearningObservedOutcomeView {
  return {
    labelId: observedOutcomeLabelId(predictionId, settlement.settlementId),
    schemaVersion: 'experience-observed-outcome-v1',
    outcome: settlement.outcome,
    sourceRefs: [
      learningRef('settlement', settlement.settlementId, digest(settlement.criteria)),
      learningRef('verification', settlement.verificationRunId, digest(settlement.criteria)),
      learningRef('usage', settlement.usageId, null),
    ],
    createdAt: settlement.createdAt,
  }
}

function rejectedBeforeUseOutcome(
  predictionId: LearningPredictionId,
  planning: PlanningResultView,
  preflight: PlanningResultView['preflights'][number],
): LearningObservedOutcomeView {
  return {
    labelId: observedOutcomeLabelId(predictionId, `rejected-before-use:${planning.plan.usageId}`),
    schemaVersion: 'experience-observed-outcome-v1',
    outcome: 'rejected_before_use',
    sourceRefs: [
      learningRef('usage', planning.plan.usageId, planning.plan.contentDigest),
      learningRef('preflight', preflight.preflightId, preflight.digest),
    ],
    createdAt: planning.plan.createdAt,
  }
}

function learningRef(
  kind: LearningSourceRefView['kind'],
  id: string,
  digestValue: string | null,
): LearningSourceRefView {
  return { kind, id: String(id), digest: digestValue }
}

function learningPredictionId(capability: LearningCapability, refs: readonly unknown[]): LearningPredictionId {
  return brandedId<'ExperienceLearningPredictionId'>(
    `learning-prediction:${sha256(canonicalJson({ capability, refs }))}`,
    'LearningPredictionId',
  )
}

function humanLabelId(predictionId: LearningPredictionId, sourceId: string): HumanLabelId {
  return brandedId<'ExperienceHumanLabelId'>(
    `human-label:${sha256(canonicalJson({ predictionId, sourceId }))}`,
    'HumanLabelId',
  )
}

function observedOutcomeLabelId(
  predictionId: LearningPredictionId,
  sourceId: string,
): ObservedOutcomeLabelId {
  return brandedId<'ExperienceObservedOutcomeLabelId'>(
    `observed-outcome:${sha256(canonicalJson({ predictionId, sourceId }))}`,
    'ObservedOutcomeLabelId',
  )
}

interface LearningLabelRow {
  readonly label_id: string
  readonly prediction_id: string
  readonly payload_json: string
}

function groupLearningLabels<T extends { readonly labelId: string }>(
  rows: readonly LearningLabelRow[],
  label: string,
  schemaVersion: string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const value = parseLearningObject<T>(row.payload_json, label, schemaVersion)
    if (value.labelId !== row.label_id) {
      throw new ExperienceError('database_schema_invalid', `${label} durable identity is inconsistent`)
    }
    const current = grouped.get(row.prediction_id) ?? []
    current.push(value)
    grouped.set(row.prediction_id, current)
  }
  return grouped
}

function parseLearningObject<T>(value: string, label: string, schemaVersion: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw new ExperienceError('database_schema_invalid', `${label} durable JSON is invalid`, {}, { cause: error })
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== schemaVersion) {
    throw new ExperienceError('database_schema_invalid', `${label} durable JSON is incomplete`)
  }
  return parsed as T
}

function parseLearningStringArray(value: string, label: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw new ExperienceError('database_schema_invalid', `${label} JSON is invalid`, {}, { cause: error })
  }
  if (!isStringArray(parsed)) {
    throw new ExperienceError('database_schema_invalid', `${label} JSON is incomplete`)
  }
  return parsed
}

function isLearningCapability(value: string): value is LearningCapability {
  return LEARNING_CAPABILITIES.some(capability => capability === value)
}

function isLearningGovernanceCapability(value: string): value is LearningGovernanceCapability {
  return LEARNING_GOVERNANCE_SUBJECTS.some(capability => capability === value)
}

function isRejectedBeforeUse(state: string): boolean {
  return state === 'rejected_before_use' || state === 'withdrawn_before_use'
    || state === 'no_match' || state === 'blocked'
}

function stringField(candidate: CandidateView, fieldName: string): string | null {
  const value = candidate.fields.find(field => field.field === fieldName)?.proposedValue
  return typeof value === 'string' ? value : null
}

function enqueueLearningReconcile(
  handle: DatabaseSync,
  sourceKind: 'candidate' | 'usage' | 'revision_proposal' | 'relation' | 'projection_builder' | 'forget_request',
  sourceId: string,
  createdAt: string,
): void {
  handle.prepare(
    `INSERT INTO outbox_entries
      (outbox_id, topic, payload_json, state, attempts, next_attempt_at, lease_until, created_at)
     VALUES (?, 'experience.learning.reconcile', ?, 'pending', 0, ?, NULL, ?)`,
  ).run(randomUUID(), JSON.stringify({ sourceKind, sourceId }), createdAt, createdAt)
}

function insertProgress(handle: DatabaseSync, progress: StepProgressView): void {
  handle.prepare(
    `INSERT INTO step_progress
      (step_progress_id, usage_id, controller_revision, state, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(progress.stepProgressId, progress.usageId, progress.controllerRevision, progress.state,
    JSON.stringify(progress), progress.createdAt)
}

function readLatestProgress(handle: DatabaseSync, usageId: string): StepProgressView | null {
  const row = handle.prepare(
    'SELECT payload_json FROM step_progress WHERE usage_id = ? ORDER BY controller_revision DESC LIMIT 1',
  ).get(usageId) as { payload_json: string } | undefined
  return row === undefined ? null : parsePlanningObject<StepProgressView>(row.payload_json, 'StepProgress')
}

function requiredLatestProgress(handle: DatabaseSync, usageId: string): StepProgressView {
  const progress = readLatestProgress(handle, usageId)
  if (progress === null) throw new ExperienceError('not_found', 'StepProgress was not started')
  return progress
}

function progressRecord(
  current: StepProgressView,
  controllerRevision: number,
  stepIndex: number,
  stepRef: string,
  state: StepProgressView['state'],
  transition: StepProgressView['transition'],
  input: ProgressUsageInput,
  createdAt: string,
): StepProgressView {
  const checkpointAccepted = (input.action === 'advance' || input.action === 'deviate')
    && input.checkpointRef !== undefined
  return {
    ...current,
    stepProgressId: brandedId<'ExperienceStepProgressId'>(randomUUID(), 'stepProgressId'),
    controllerRevision,
    stepIndex,
    stepRef,
    completedStepRefs: input.action === 'advance'
      ? uniqueStrings([...current.completedStepRefs, current.stepRef])
      : current.completedStepRefs,
    selectedBranchRefs: input.action === 'deviate' && input.branchRef !== undefined
      ? uniqueStrings([...current.selectedBranchRefs, input.branchRef])
      : current.selectedBranchRefs,
    checkpointResults: checkpointAccepted ? [...current.checkpointResults, {
      stepRef: current.stepRef,
      checkpointRef: input.checkpointRef!,
      decision: 'accepted',
      reason: input.reason,
    }] : current.checkpointResults,
    state,
    transition,
    branchRef: input.branchRef ?? null,
    checkpointRef: input.checkpointRef ?? null,
    reason: input.reason,
    createdAt,
  }
}

function readCorrelationByCall(
  handle: DatabaseSync,
  usageId: string,
  callId: string,
): ExecutionCorrelationView | null {
  const row = handle.prepare(
    `SELECT payload_json FROM execution_correlations
     WHERE usage_id = ? AND json_extract(payload_json, '$.callId') = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(usageId, callId) as { payload_json: string } | undefined
  return row === undefined
    ? null : parsePlanningObject<ExecutionCorrelationView>(row.payload_json, 'ExecutionCorrelation')
}

function readVerification(handle: DatabaseSync, verificationRunId: string): VerificationRunView {
  const row = handle.prepare(
    'SELECT payload_json FROM verification_runs WHERE verification_run_id = ?',
  ).get(verificationRunId) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'VerificationRun was not found')
  return parsePlanningObject<VerificationRunView>(row.payload_json, 'VerificationRun')
}

function readLatestVerification(handle: DatabaseSync, usageId: string): VerificationRunView | null {
  const row = handle.prepare(
    `SELECT payload_json FROM verification_runs
     WHERE usage_id = ? ORDER BY rowid DESC LIMIT 1`,
  ).get(usageId) as { payload_json: string } | undefined
  return row === undefined ? null : parsePlanningObject<VerificationRunView>(row.payload_json, 'VerificationRun')
}

/** Sole low-level writer for canonical VerificationRun rows. */
function insertVerificationRun(handle: DatabaseSync, run: VerificationRunView): void {
  handle.prepare(
    `INSERT INTO verification_runs
      (verification_run_id, usage_id, controller_revision, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(run.verificationRunId, run.usageId, run.controllerRevision, JSON.stringify(run), run.createdAt)
}

/** Sole low-level writer for Settlement, criterion, and terminal Usage state. */
function insertUsageSettlement(handle: DatabaseSync, settlement: UsageSettlementView): void {
  handle.prepare(
    `INSERT INTO usage_settlements (settlement_id, usage_id, outcome, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(settlement.settlementId, settlement.usageId, settlement.outcome,
    JSON.stringify(settlement), settlement.createdAt)
  const insertCriterion = handle.prepare(
    'INSERT INTO criterion_results (criterion_result_id, settlement_id, payload_json) VALUES (?, ?, ?)',
  )
  for (const criterion of settlement.criteria) {
    insertCriterion.run(randomUUID(), settlement.settlementId, JSON.stringify(criterion))
  }
  const changed = handle.prepare(
    'UPDATE experience_usages SET revision = revision + 1, state = ? WHERE usage_id = ?',
  ).run(settlement.outcome, settlement.usageId)
  if (changed.changes !== 1) throw new ExperienceError('not_found', 'ExperienceUsage was not found')
}

function readSettlement(handle: DatabaseSync, usageId: string): UsageSettlementView | null {
  const row = handle.prepare(
    'SELECT payload_json FROM usage_settlements WHERE usage_id = ?',
  ).get(usageId) as { payload_json: string } | undefined
  return row === undefined ? null : parsePlanningObject<UsageSettlementView>(row.payload_json, 'UsageSettlement')
}

function readUsageExecution(handle: DatabaseSync, usageId: string): UsageExecutionView {
  const correlationRows = handle.prepare(
    'SELECT payload_json FROM execution_correlations WHERE usage_id = ? ORDER BY created_at, correlation_id',
  ).all(usageId) as Array<{ payload_json: string }>
  const revisionRows = handle.prepare(
    `SELECT payload_json FROM revision_proposals
     WHERE json_extract(payload_json, '$.sourceUsageId') = ? ORDER BY created_at`,
  ).all(usageId) as Array<{ payload_json: string }>
  const preferenceRows = handle.prepare(
    'SELECT payload_json FROM preference_validations WHERE usage_id = ? ORDER BY created_at, preference_validation_id',
  ).all(usageId) as Array<{ payload_json: string }>
  return {
    usageId: brandedId<'ExperienceUsageId'>(usageId, 'usageId'),
    progress: readLatestProgress(handle, usageId),
    correlations: correlationRows.map(row =>
      parsePlanningObject<ExecutionCorrelationView>(row.payload_json, 'ExecutionCorrelation')),
    verification: readLatestVerification(handle, usageId),
    settlement: readSettlement(handle, usageId),
    revisionProposals: revisionRows.map(row =>
      parsePlanningObject<RevisionProposalView>(row.payload_json, 'RevisionProposal')),
    preferenceValidations: preferenceRows.map(row =>
      parsePlanningObject<PreferenceOutputValidationView>(row.payload_json, 'PreferenceOutputValidation')),
  }
}

function readRevisionForUsage(handle: DatabaseSync, usageId: string): RevisionProposalView | null {
  const row = handle.prepare(
    `SELECT payload_json FROM revision_proposals
     WHERE json_extract(payload_json, '$.sourceUsageId') = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(usageId) as { payload_json: string } | undefined
  return row === undefined ? null : parsePlanningObject<RevisionProposalView>(row.payload_json, 'RevisionProposal')
}

function readRevisionProposal(handle: DatabaseSync, revisionProposalId: string): RevisionProposalView {
  const row = handle.prepare(
    'SELECT payload_json FROM revision_proposals WHERE revision_proposal_id = ?',
  ).get(revisionProposalId) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'RevisionProposal was not found')
  return parsePlanningObject<RevisionProposalView>(row.payload_json, 'RevisionProposal')
}

function insertRevisionProposal(handle: DatabaseSync, proposal: RevisionProposalView): void {
  handle.prepare(
    `INSERT INTO revision_proposals
      (revision_proposal_id, experience_id, base_version_id, state, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(proposal.revisionProposalId, proposal.experienceId, proposal.baseVersionId,
    proposal.state, JSON.stringify(proposal), proposal.createdAt)
  const insertChange = handle.prepare(
    'INSERT INTO revision_changes (revision_change_id, revision_proposal_id, payload_json) VALUES (?, ?, ?)',
  )
  for (const change of proposal.changes) {
    insertChange.run(change.revisionChangeId, proposal.revisionProposalId, JSON.stringify(change))
  }
}

function readMarkdownProjection(handle: DatabaseSync, projectionReceiptId: string): MarkdownProjectionView {
  const row = handle.prepare(
    `SELECT payload_json, markdown_text FROM markdown_projection_receipts
      WHERE projection_receipt_id = ?`,
  ).get(projectionReceiptId) as { payload_json: string; markdown_text: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'Markdown projection receipt was not found')
  const receipt = parsePlanningObject<MarkdownProjectionReceiptView>(row.payload_json, 'MarkdownProjectionReceipt')
  if (receipt.markdownProjectionReceiptId !== projectionReceiptId
    || receipt.projectionFormat !== 'experience-map-markdown-v1'
    || markdownDigest(row.markdown_text) !== receipt.projectionDigest) {
    throw new ExperienceError('database_schema_invalid', 'Markdown projection receipt is inconsistent')
  }
  return { receipt, markdown: row.markdown_text }
}

function requireRecallableSeries(
  handle: DatabaseSync,
  experienceId: string,
): { readonly current_version_id: string; readonly series_revision: number } {
  const row = handle.prepare(
    `SELECT current_version_id, series_revision, lifecycle_projection
       FROM experience_series WHERE experience_id = ?`,
  ).get(experienceId) as {
    current_version_id: string
    series_revision: number
    lifecycle_projection: string
  } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'Experience series was not found')
  const forgotten = handle.prepare('SELECT 1 FROM forget_tombstones WHERE experience_id = ?').get(experienceId)
  if (row.lifecycle_projection === 'retired' || forgotten !== undefined) {
    throw new ExperienceError('invalid_command', 'Forgotten Experience cannot be exported or revised through Markdown')
  }
  return row
}

function persistRevisionProposal(handle: DatabaseSync, proposal: RevisionProposalView): void {
  const changed = handle.prepare(
    'UPDATE revision_proposals SET state = ?, payload_json = ? WHERE revision_proposal_id = ?',
  ).run(proposal.state, JSON.stringify(proposal), proposal.revisionProposalId)
  if (changed.changes !== 1) throw new ExperienceError('not_found', 'RevisionProposal was not found')
}

function revisionContent(role: RevisionChangeView['semanticRole']): string {
  if (role === 'recovery_verifier') {
    return 'Verify the exact supported launcher event, owned live process and loopback listener, token-to-cookie exchange, authenticated clean-root boot manifest and RPC readback, then confirm owned cleanup and closed port.'
  }
  return 'The current Web readiness condition requires a token exchange, authenticated clean-root boot manifest, same-origin authenticated RPC success, loopback ownership, and confirmed cleanup; anonymous HTTP 200 alone is insufficient.'
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

type ForgetRequestRecord = Omit<ForgetRequestView, 'steps' | 'contextTargets'>

function buildForgetImpactPreview(
  handle: DatabaseSync,
  experienceId: ExperienceId,
  generatedAt: string,
): ForgetImpactPreviewView {
  const series = handle.prepare(
    `SELECT current_version_id, series_revision, lifecycle_projection
       FROM experience_series WHERE experience_id = ?`,
  ).get(experienceId) as {
    current_version_id: string
    series_revision: number
    lifecycle_projection: string
  } | undefined
  if (series === undefined) throw new ExperienceError('not_found', 'Experience series was not found')
  if (series.lifecycle_projection !== 'active') {
    throw new ExperienceError('invalid_command', 'Experience series is already retired from recall')
  }
  const versionCount = handle.prepare(
    'SELECT COUNT(*) AS count FROM experience_versions WHERE experience_id = ?',
  ).get(experienceId) as { count: number }
  const deliveries = handle.prepare(
    `SELECT DISTINCT d.context_delivery_id, d.payload_json
       FROM context_deliveries d
       JOIN context_snapshots s ON s.context_snapshot_id = d.context_snapshot_id
      WHERE json_extract(d.payload_json, '$.deliveryStatus') IN
        ('appended_to_session','included_in_request','delivery_unknown','interrupted_before_request')
        AND EXISTS (
          SELECT 1 FROM json_each(s.payload_json, '$.experienceVersionRefs') ref
          JOIN experience_versions v ON v.experience_version_id = ref.value
          WHERE v.experience_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM context_retirements r
          WHERE r.context_delivery_id = d.context_delivery_id AND r.state = 'replaced_on_surface'
        )
      ORDER BY d.context_delivery_id`,
  ).all(experienceId) as Array<{ context_delivery_id: string; payload_json: string }>
  const activeContextTargets = deliveries.map(row => {
    const delivery = parsePlanningObject<ContextDeliveryView>(row.payload_json, 'ContextDelivery')
    return {
      contextDeliveryId: delivery.contextDeliveryId,
      sessionId: delivery.sessionId,
      deliveryStatus: delivery.deliveryStatus,
    }
  })
  const immutableHistory = [
    'versions', 'receipts', 'audit', 'session_events', 'provider_copies',
  ] as const
  const preview = {
    experienceId,
    currentVersionId: brandedId<'ExperienceVersionId'>(series.current_version_id, 'currentVersionId'),
    expectedSeriesRevision: series.series_revision,
    versionCount: versionCount.count,
    activeContextTargets,
    futureRecall: 'will_stop_immediately' as const,
    immutableHistory,
    vaultContent: 'not_applicable' as const,
    vaultReasonCode: 'governed_content_vault_not_enabled' as const,
  }
  return {
    ...preview,
    previewDigest: digest({ schemaVersion: 'experience-forget-preview-v1', ...preview }),
    generatedAt,
  }
}

function insertForgetStep(
  handle: DatabaseSync,
  forgetRequestId: ForgetRequestId,
  phase: ForgetStepResultView['phase'],
  status: ForgetStepResultView['status'],
  reasonCode: string,
  affectedRefs: readonly string[],
  attemptedAt: string,
  completedAt: string | null,
): void {
  const step: ForgetStepResultView = {
    stepResultId: id<'ExperienceForgetStepResultId', ForgetStepResultId>(),
    forgetRequestId,
    phase,
    status,
    reasonCode,
    affectedRefs: uniqueStrings(affectedRefs),
    attemptedAt,
    completedAt,
  }
  handle.prepare(
    `INSERT INTO forget_step_results
      (step_result_id, forget_request_id, phase, status, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(step.stepResultId, forgetRequestId, phase, status, JSON.stringify(step), completedAt ?? attemptedAt)
}

function updateForgetStep(
  handle: DatabaseSync,
  forgetRequestId: string,
  phase: ForgetStepResultView['phase'],
  status: ForgetStepResultView['status'],
  reasonCode: string,
  affectedRefs: readonly string[],
  now: string,
): void {
  const row = handle.prepare(
    'SELECT payload_json FROM forget_step_results WHERE forget_request_id = ? AND phase = ?',
  ).get(forgetRequestId, phase) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'Forget step is missing')
  const current = parsePlanningObject<ForgetStepResultView>(row.payload_json, 'ForgetStepResult')
  const updated: ForgetStepResultView = {
    ...current,
    status,
    reasonCode,
    affectedRefs: uniqueStrings(affectedRefs),
    completedAt: status === 'pending' ? null : now,
  }
  handle.prepare(
    `UPDATE forget_step_results SET status = ?, payload_json = ?, updated_at = ?
      WHERE forget_request_id = ? AND phase = ?`,
  ).run(status, JSON.stringify(updated), now, forgetRequestId, phase)
}

function readForgetRequest(handle: DatabaseSync, forgetRequestId: string): ForgetRequestView {
  const row = handle.prepare(
    'SELECT state, payload_json, updated_at FROM forget_requests WHERE forget_request_id = ?',
  ).get(forgetRequestId) as { state: string; payload_json: string; updated_at: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'Forget request was not found')
  const record = parsePlanningObject<ForgetRequestRecord>(row.payload_json, 'ForgetRequest')
  if (record.forgetRequestId !== forgetRequestId || record.state !== row.state
    || record.updatedAt !== row.updated_at) {
    throw new ExperienceError('database_schema_invalid', 'Forget request durable state is inconsistent')
  }
  const steps = handle.prepare(
    `SELECT payload_json FROM forget_step_results
      WHERE forget_request_id = ?
      ORDER BY CASE phase
        WHEN 'recall_stop' THEN 1 WHEN 'context_retirement' THEN 2 WHEN 'vault_content' THEN 3
        WHEN 'projection_invalidation' THEN 4 ELSE 5 END`,
  ).all(forgetRequestId) as Array<{ payload_json: string }>
  const targets = handle.prepare(
    `SELECT context_delivery_id, state, context_retirement_id, reason_code, updated_at
       FROM forget_context_targets WHERE forget_request_id = ? ORDER BY context_delivery_id`,
  ).all(forgetRequestId) as Array<{
    context_delivery_id: string
    state: ForgetContextTargetView['status']
    context_retirement_id: string | null
    reason_code: string
    updated_at: string
  }>
  return {
    ...record,
    steps: steps.map(item => parsePlanningObject<ForgetStepResultView>(item.payload_json, 'ForgetStepResult')),
    contextTargets: targets.map(item => ({
      contextDeliveryId: brandedId<'ExperienceContextDeliveryId'>(item.context_delivery_id, 'contextDeliveryId'),
      sessionId: readContextDelivery(handle, item.context_delivery_id).sessionId,
      status: item.state,
      contextRetirementId: item.context_retirement_id === null ? null
        : brandedId<'ExperienceContextRetirementId'>(item.context_retirement_id, 'contextRetirementId'),
      reasonCode: item.reason_code,
      updatedAt: item.updated_at,
    })),
  }
}

function readContextDelivery(handle: DatabaseSync, contextDeliveryId: string): ContextDeliveryView {
  const row = handle.prepare(
    'SELECT payload_json FROM context_deliveries WHERE context_delivery_id = ?',
  ).get(contextDeliveryId) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'Forget target ContextDelivery is missing')
  return parsePlanningObject<ContextDeliveryView>(row.payload_json, 'ContextDelivery')
}

function reconcileForgetContextStep(handle: DatabaseSync, forgetRequestId: string, now: string): void {
  const rows = handle.prepare(
    `SELECT context_delivery_id, state FROM forget_context_targets
      WHERE forget_request_id = ? ORDER BY context_delivery_id`,
  ).all(forgetRequestId) as Array<{ context_delivery_id: string; state: ForgetContextTargetView['status'] }>
  if (rows.length === 0) {
    updateForgetStep(handle, forgetRequestId, 'context_retirement', 'not_applicable',
      'no_active_context', [], now)
  } else if (rows.every(row => row.state === 'retired')) {
    updateForgetStep(handle, forgetRequestId, 'context_retirement', 'completed',
      'all_active_contexts_retired', rows.map(row => row.context_delivery_id), now)
  } else if (rows.some(row => row.state === 'failed')) {
    updateForgetStep(handle, forgetRequestId, 'context_retirement',
      rows.some(row => row.state === 'retired') ? 'partial' : 'failed',
      'context_retirement_failed', rows.map(row => row.context_delivery_id), now)
  } else if (rows.some(row => row.state === 'unknown')) {
    updateForgetStep(handle, forgetRequestId, 'context_retirement',
      rows.some(row => row.state === 'retired') ? 'partial' : 'unknown',
      'session_not_live_retirement_deferred', rows.map(row => row.context_delivery_id), now)
  } else {
    updateForgetStep(handle, forgetRequestId, 'context_retirement', 'pending',
      'active_context_retirement_pending', rows.map(row => row.context_delivery_id), now)
  }
  reconcileForgetRequestState(handle, forgetRequestId, now)
}

function reconcileForgetRequestState(handle: DatabaseSync, forgetRequestId: string, now: string): void {
  const row = handle.prepare(
    'SELECT payload_json FROM forget_requests WHERE forget_request_id = ?',
  ).get(forgetRequestId) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'Forget request is missing')
  const current = parsePlanningObject<ForgetRequestRecord>(row.payload_json, 'ForgetRequest')
  const steps = handle.prepare(
    'SELECT status FROM forget_step_results WHERE forget_request_id = ?',
  ).all(forgetRequestId) as Array<{ status: ForgetStepResultView['status'] }>
  const state: ForgetRequestView['state'] = steps.some(step => step.status === 'pending')
    ? 'processing'
    : steps.some(step => step.status === 'failed' || step.status === 'unknown' || step.status === 'partial')
      ? 'partial'
      : 'completed'
  const updated: ForgetRequestRecord = { ...current, state, updatedAt: now }
  handle.prepare(
    'UPDATE forget_requests SET state = ?, payload_json = ?, updated_at = ? WHERE forget_request_id = ?',
  ).run(state, JSON.stringify(updated), now, forgetRequestId)
}

const MANDATORY_WEB_CRITERIA = new Set([
  'WEB-LAUNCH-001',
  'WEB-READY-002',
  'WEB-AUTH-003',
  'WEB-SCOPE-004',
  'WEB-CLEAN-005',
])

function settlementOutcome(
  criteria: readonly CriterionVerificationView[],
  progressState: StepProgressView['state'],
): UsageSettlementView['outcome'] {
  if (progressState === 'aborted') return 'aborted'
  const ids = new Set(criteria.filter(item => item.mandatory).map(item => item.criterionId))
  const completeSet = ids.size === MANDATORY_WEB_CRITERIA.size
    && [...MANDATORY_WEB_CRITERIA].every(id => ids.has(id as CriterionVerificationView['criterionId']))
  if (progressState === 'completed' && completeSet
    && criteria.every(item => !item.mandatory || item.result === 'pass')) return 'success'
  const criticalFailed = criteria.some(item =>
    item.result === 'fail' && item.criterionId !== 'WEB-CLEAN-005')
  if (criticalFailed) return 'failure'
  if (criteria.some(item => item.result === 'unknown')) return 'unknown'
  if (criteria.some(item => item.result === 'pass')) return 'partial'
  return 'unknown'
}

interface PlanningReceiptOptions {
  readonly input: PlanTaskCommandInput | DecidePlanCommandInput
  readonly action: PlanningReceipt['action']
  readonly actor: ActorView
  readonly planning: PlanningResultView
  readonly payloadDigest: string
}

function commitPlanningReceipt(handle: DatabaseSync, options: PlanningReceiptOptions): PlanningReceipt {
  const sequence = handle.prepare('SELECT next_value FROM commit_sequence WHERE singleton = 1')
    .get() as { next_value: number } | undefined
  if (sequence === undefined) throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing')
  const receipt: PlanningReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: options.action,
    actor: options.actor,
    usageId: options.planning.plan.usageId,
    usagePlanId: options.planning.plan.usagePlanId,
    planRevision: options.planning.plan.planRevision,
    requestId: options.planning.approvalRequest?.requestId ?? null,
    retryBindingId: options.planning.retryBinding?.bindingId ?? null,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequence.next_value,
    createdAt: new Date().toISOString(),
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at, commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(receipt.receiptId, receipt.commandId, receipt.action, receipt.correlationId, receipt.causationId,
    receipt.issuedAt, receipt.commitSequence, JSON.stringify(receipt), receipt.createdAt)
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
  ).run(randomUUID(), options.actor.actorId, receipt.commandId, receipt.action, receipt.correlationId,
    receipt.causationId, receipt.issuedAt,
    JSON.stringify([receipt.usageId, receipt.usagePlanId, ...(receipt.requestId === null ? [] : [receipt.requestId])]),
    options.payloadDigest, receipt.createdAt)
  handle.prepare(
    'INSERT INTO command_deduplication (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)',
  ).run(receipt.commandId, options.payloadDigest, receipt.receiptId, receipt.createdAt)
  return receipt
}

function planningDeduplicatedReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): PlanningReceipt | null {
  const existing = handle.prepare(
    'SELECT payload_digest, receipt_id FROM command_deduplication WHERE command_id = ?',
  ).get(commandId) as DeduplicationRow | undefined
  if (existing === undefined) return null
  if (existing.payload_digest !== payloadDigest) {
    throw new ExperienceError('idempotency_conflict', 'CommandId was already used with a different payload')
  }
  const row = handle.prepare('SELECT payload_json FROM domain_receipts WHERE receipt_id = ?')
    .get(existing.receipt_id) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'Planning receipt is missing')
  const receipt = parsePlanningObject<PlanningReceipt>(row.payload_json, 'PlanningReceipt')
  if (!isPlanningReceiptAction(receipt.action)) {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to a non-planning command')
  }
  return receipt
}

function planningPayloadDigest(
  action: PlanningReceipt['action'],
  actor: ActorView,
  input: PlanTaskCommandInput | DecidePlanCommandInput,
): string {
  return sha256(canonicalJson({ action, actor, input }))
}

function insertPlanApprovalRequest(handle: DatabaseSync, request: PlanApprovalRequestView): void {
  handle.prepare(
    `INSERT INTO plan_approval_requests
      (request_id, usage_plan_id, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(request.requestId, request.usagePlanId, request.status, JSON.stringify(request), request.createdAt)
}

function insertAdmissionAttempt(handle: DatabaseSync, attempt: AdmissionAttemptView): void {
  handle.prepare(
    `INSERT INTO admission_attempts
      (admission_attempt_id, actor_id, state, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(attempt.admissionAttemptId, attempt.actorId, attempt.state, JSON.stringify(attempt), attempt.createdAt)
}

function updateUsageProjection(handle: DatabaseSync, planning: PlanningResultView): void {
  const result = handle.prepare(
    'UPDATE experience_usages SET revision = revision + 1, state = ?, payload_json = ? WHERE usage_id = ?',
  ).run(usageState(planning), JSON.stringify(planning), planning.plan.usageId)
  if (result.changes !== 1) throw new ExperienceError('not_found', 'ExperienceUsage was not found')
}

function usageState(planning: PlanningResultView): string {
  if (planning.approvalRequest?.status === 'approved') return 'approved_not_started'
  if (planning.approvalRequest?.status === 'denied') return 'rejected_before_use'
  if (planning.approvalRequest?.status === 'withdrawn') return 'withdrawn_before_use'
  if (planning.plan.disposition === 'no_match') return 'no_match'
  if (planning.plan.disposition === 'blocked') return 'blocked'
  return planning.approvalRequest === null ? 'planned_no_approval' : 'awaiting_plan_approval'
}

function createRetryBinding(
  planning: PlanningResultView,
  request: PlanApprovalRequestView,
  now: string,
): AdmissionRetryBindingView {
  return {
    bindingId: brandedId<'ExperienceAdmissionRetryBindingId'>(randomUUID(), 'bindingId'),
    admissionAttemptId: planning.admissionAttempt.admissionAttemptId,
    usageId: planning.plan.usageId,
    requestId: request.requestId,
    usagePlanId: planning.plan.usagePlanId,
    planRevision: planning.plan.planRevision,
    actorId: request.actorId,
    principalId: request.principalId,
    sessionId: planning.admissionAttempt.sessionId,
    taskInputDigest: admissionTaskDigest(planning.fingerprint.taskText),
    scopeDigest: request.scopeDigest,
    state: 'active',
    claimRevision: 0,
    claimedByAdmissionAttemptId: null,
    claimLeaseUntil: null,
    stateReasonCode: null,
    expiresAt: request.expiresAt,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Read the latest ContextSnapshot and ContextDelivery for one Usage. These are
 * the canonical attribution facts that let the learning projection distinguish an
 * actually-used version from one that was merely preflighted or only prepared.
 */
function readUsageContext(
  handle: DatabaseSync,
  usageId: string,
): { readonly snapshot: ContextSnapshotView | null; readonly delivery: ContextDeliveryView | null } {
  const snapshotRow = handle.prepare(
    'SELECT payload_json FROM context_snapshots WHERE usage_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(usageId) as { payload_json: string } | undefined
  const snapshot = snapshotRow === undefined
    ? null : parsePlanningObject<ContextSnapshotView>(snapshotRow.payload_json, 'ContextSnapshot')
  const deliveryRow = snapshot === null ? undefined : handle.prepare(
    'SELECT payload_json FROM context_deliveries WHERE context_snapshot_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(snapshot.contextSnapshotId) as { payload_json: string } | undefined
  const delivery = deliveryRow === undefined
    ? null : parsePlanningObject<ContextDeliveryView>(deliveryRow.payload_json, 'ContextDelivery')
  return { snapshot, delivery }
}

function readPlanningResult(handle: DatabaseSync, usageId: string): PlanningResultView {
  const row = handle.prepare('SELECT payload_json FROM experience_usages WHERE usage_id = ?')
    .get(usageId) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', `ExperienceUsage ${JSON.stringify(usageId)} was not found`)
  const planning = parsePlanningObject<PlanningResultView>(row.payload_json, 'PlanningResult')
  validatePlanningResult(planning, usageId)
  return planning
}

function validatePlanningResult(planning: PlanningResultView, expectedUsageId?: string): void {
  const plan = planning.plan
  const request = planning.approvalRequest
  const attempt = planning.admissionAttempt
  const validRequestStates = new Set(['pending', 'approved', 'denied', 'withdrawn', 'expired', 'superseded'])
  const validAttemptStates = new Set([
    'not_required', 'pending_external_decision', 'approved', 'denied', 'interaction_interrupted', 'no_answerer_continue',
    'ready_to_enter', 'entered', 'delegated_without_experience', 'rejected', 'interrupted',
  ])
  const validBindingStates = new Set(['active', 'claimed', 'consumed', 'expired', 'superseded'])
  const selectedIds = plan.selectedContributions.map(item => item.contributionId)
  if (!nonEmptyString(planning.fingerprint.fingerprintId)
    || planning.fingerprint.schemaVersion !== 'task-fingerprint-v1'
    || !sha256Digest(planning.fingerprint.taskInputDigest)
    || planning.matchSet.fingerprintId !== planning.fingerprint.fingerprintId
    || planning.matchSet.matchSetId !== plan.matchSetId
    || !['bounded-structural-lexical-v1', 'conservative-hybrid-v1'].includes(planning.matchSet.retrievalVersion)
    || (planning.matchSet.retrievalVersion === 'conservative-hybrid-v1'
      && !validHybridRetrievalDecision(planning.matchSet))
    || (planning.matchSet.recallDecisionKey !== undefined
      && planning.matchSet.recallDecisionKey !== null
      && !sha256Digest(planning.matchSet.recallDecisionKey))
    || !Array.isArray(planning.matchSet.candidates)
    || !Number.isSafeInteger(planning.matchSet.candidateLimit)
    || planning.matchSet.candidateLimit < 1
    || planning.matchSet.candidates.length > planning.matchSet.candidateLimit
    || !Array.isArray(planning.preflights)
    || !nonEmptyString(plan.usageId)
    || (expectedUsageId !== undefined && plan.usageId !== expectedUsageId)
    || !nonEmptyString(plan.usagePlanId)
    || !Number.isSafeInteger(plan.planRevision) || plan.planRevision < 1
    || plan.fingerprintId !== planning.fingerprint.fingerprintId
    || !Array.isArray(plan.preflightIds)
    || (plan.useMode !== 'suggest' && plan.useMode !== 'guided')
    || plan.compositionPolicyVersion !== 'typed-relations-v1'
    || !isStringArray(plan.selectedRelationIds)
    || !isStringArray(plan.overrideDecisionIds)
    || !Array.isArray(plan.preferenceEnforcements)
    || !Array.isArray(plan.selectedContributions)
    || !Array.isArray(plan.discardedContributions)
    || !Array.isArray(plan.orderedSteps)
    || !Array.isArray(plan.constraints)
    || !Array.isArray(plan.premises)
    || !Array.isArray(plan.hypotheses)
    || !Array.isArray(plan.recovery)
    || !Array.isArray(plan.verification)
    || !Array.isArray(plan.blockers)
    || new Set(selectedIds).size !== selectedIds.length
    || plan.selectedContributions.some(item => !isStringArray(item.relationIds))
    || !sha256Digest(plan.contentDigest)
    || attempt.usageId !== plan.usageId
    || (attempt.sessionId !== null && !nonEmptyString(attempt.sessionId))
    || !validAttemptStates.has(attempt.state)
    || (request === null ? attempt.requestId !== null
      : request.usageId !== plan.usageId
        || request.usagePlanId !== plan.usagePlanId
        || request.planRevision !== plan.planRevision
        || attempt.requestId !== request.requestId
        || !validRequestStates.has(request.status))
    || (planning.retryBinding !== null && (
      request === null
      || !bindingMatchesRequestStatus(planning.retryBinding.state, request.status)
      || planning.retryBinding.usageId !== plan.usageId
      || planning.retryBinding.usagePlanId !== plan.usagePlanId
      || planning.retryBinding.planRevision !== plan.planRevision
      || planning.retryBinding.requestId !== request.requestId
      || planning.retryBinding.admissionAttemptId !== attempt.admissionAttemptId
      || planning.retryBinding.sessionId !== attempt.sessionId
      || !validBindingStates.has(planning.retryBinding.state)
      || !Number.isSafeInteger(planning.retryBinding.claimRevision)
      || planning.retryBinding.claimRevision < 0
    ))) {
    throw new ExperienceError('database_schema_invalid', 'PlanningResult durable JSON is inconsistent')
  }
}

function validHybridRetrievalDecision(matchSet: MatchSetView): boolean {
  const decision = matchSet.retrievalDecision
  if (decision === undefined
    || !['conservative-hybrid-policy-v1', 'conservative-hybrid-policy-v2'].includes(decision.policyVersion)
    || (decision.projectionGeneration !== null
      && (!Number.isSafeInteger(decision.projectionGeneration) || decision.projectionGeneration < 0))
    || (decision.projectionContentDigest !== null && !sha256Digest(decision.projectionContentDigest))
    || !sha256Digest(decision.queryProjectionDigest)
    || !['disabled', 'ready', 'unavailable', 'stale_generation'].includes(decision.denseState)
    || decision.lexicalMinimumOverlap < 1
    || !Number.isFinite(decision.lexicalRelativeMargin)
    || decision.lexicalRelativeMargin < 0 || decision.lexicalRelativeMargin > 1
    || !Number.isFinite(decision.denseSimilarityThreshold)
    || !Number.isFinite(decision.denseMargin) || decision.denseMargin < 0
    || !Number.isFinite(decision.rrfK) || decision.rrfK <= 0
    || !Array.isArray(decision.abstentionReasonCodes)
    || (decision.denseState === 'ready'
      ? !nonEmptyString(decision.queryEmbeddingReceiptId)
        || decision.denseFailureCode !== null
        || decision.projectionGeneration === null
        || decision.projectionContentDigest === null
      : decision.queryEmbeddingReceiptId !== null)
    || ((decision.denseState === 'unavailable' || decision.denseState === 'stale_generation')
      && !nonEmptyString(decision.denseFailureCode))
    || (decision.denseState === 'disabled' && decision.denseFailureCode !== null)
    || !validDenseApplicabilityReadback(matchSet)
    || matchSet.candidates.some(candidate => !validHybridCandidate(candidate, decision.denseState))) return false
  const primary = decision.primaryExperienceVersionId
  if (matchSet.noMatch) {
    return primary === null
      && decision.abstentionReasonCodes.length > 0
      && matchSet.candidates.every(candidate => candidate.selectedComponentRevisionIds.length === 0)
  }
  return primary !== null
    && decision.abstentionReasonCodes.length === 0
    && matchSet.candidates.filter(candidate => candidate.selectedComponentRevisionIds.length > 0).length === 1
    && matchSet.candidates.some(candidate => candidate.experienceVersionId === primary
      && !candidate.rejected && candidate.selectedComponentRevisionIds.length > 0)
}

function validDenseApplicabilityReadback(matchSet: MatchSetView): boolean {
  const decision = matchSet.retrievalDecision!
  if (decision.policyVersion === 'conservative-hybrid-policy-v1') {
    return decision.denseApplicabilityProfileDigest === undefined
      && decision.denseApplicabilityAllowedKinds === undefined
  }
  if (matchSet.recallDecisionKey === undefined) return false
  if (matchSet.recallDecisionKey === null) {
    return decision.denseApplicabilityProfileDigest === null
      && decision.denseApplicabilityAllowedKinds === null
  }
  const kinds = decision.denseApplicabilityAllowedKinds
  if (!Array.isArray(kinds)
    || kinds.some(kind => kind !== 'diagnostic' && kind !== 'procedure')
    || new Set(kinds).size !== kinds.length
    || [...kinds].sort().some((kind, index) => kind !== kinds[index])) return false
  const hasProfile = kinds.length > 0
  return (hasProfile
    ? sha256Digest(decision.denseApplicabilityProfileDigest)
    : decision.denseApplicabilityProfileDigest === null)
    && (decision.denseState !== 'ready' || hasProfile)
}

function validHybridCandidate(
  candidate: MatchSetView['candidates'][number],
  denseState: NonNullable<MatchSetView['retrievalDecision']>['denseState'],
): boolean {
  const finiteOrNull = (value: number | null | undefined, minimum: number, maximum = Number.POSITIVE_INFINITY) =>
    value === undefined || value === null || (Number.isFinite(value) && value >= minimum && value <= maximum)
  const rankOrNull = (value: number | null | undefined) =>
    value === undefined || value === null || (Number.isSafeInteger(value) && value >= 1)
  return finiteOrNull(candidate.lexicalBm25Score, 0)
    && finiteOrNull(candidate.semanticScore, -1, 1)
    && finiteOrNull(candidate.fusedScore, 0)
    && rankOrNull(candidate.lexicalRank)
    && rankOrNull(candidate.semanticRank)
    && (denseState === 'ready' || candidate.semanticScore === null || candidate.semanticScore === undefined)
}

function mutateDelivery(
  handle: DatabaseSync,
  contextDeliveryId: string,
  mutate: (delivery: ContextDeliveryView) => ContextDeliveryView,
): ContextDeliveryView {
  const row = handle.prepare(
    'SELECT payload_json FROM context_deliveries WHERE context_delivery_id = ?',
  ).get(contextDeliveryId) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'ContextDelivery was not found')
  const current = parsePlanningObject<ContextDeliveryView>(row.payload_json, 'ContextDelivery')
  const updated = mutate(current)
  handle.prepare(
    'UPDATE context_deliveries SET payload_json = ? WHERE context_delivery_id = ?',
  ).run(JSON.stringify(updated), contextDeliveryId)
  return updated
}

function expireBinding(
  handle: DatabaseSync,
  binding: AdmissionRetryBindingView,
  now: string,
  reasonCode: string,
): void {
  const planning = readPlanningResult(handle, String(binding.usageId))
  const request = terminalApprovalRequest(planning.approvalRequest, binding.requestId, 'expired', now, reasonCode)
  finishClaimedAdmissionAttempt(handle, binding, 'interrupted', reasonCode, now)
  const expired: AdmissionRetryBindingView = {
    ...binding,
    state: 'expired',
    claimLeaseUntil: null,
    stateReasonCode: reasonCode,
    updatedAt: now,
  }
  handle.prepare(
    `UPDATE admission_retry_bindings
     SET state = 'expired', payload_json = ?, lease_until = NULL
     WHERE binding_id = ? AND state IN ('active', 'claimed')`,
  ).run(JSON.stringify(expired), binding.bindingId)
  persistTerminalBindingProjection(handle, planning, request, expired, 'approval_expired')
}

/** True when a version is still the active current version of its Experience Series. */
function isCurrentActiveVersion(handle: DatabaseSync, versionId: string): boolean {
  const row = handle.prepare(
    `SELECT 1 AS present
       FROM experience_series s
      WHERE s.lifecycle_projection = 'active'
        AND s.current_version_id = ?`,
  ).get(versionId)
  return row !== undefined
}

function supersedeBinding(
  handle: DatabaseSync,
  planning: PlanningResultView,
  binding: AdmissionRetryBindingView,
  now: string,
  reasonCode: string,
): void {
  const request = terminalApprovalRequest(planning.approvalRequest, binding.requestId, 'superseded', now, reasonCode)
  finishClaimedAdmissionAttempt(handle, binding, 'rejected', reasonCode, now)
  const superseded: AdmissionRetryBindingView = {
    ...binding,
    state: 'superseded',
    claimLeaseUntil: null,
    stateReasonCode: reasonCode,
    updatedAt: now,
  }
  handle.prepare(
    `UPDATE admission_retry_bindings
     SET state = 'superseded', payload_json = ?, lease_until = NULL
     WHERE binding_id = ? AND state = 'claimed'`,
  ).run(JSON.stringify(superseded), binding.bindingId)
  persistTerminalBindingProjection(handle, planning, request, superseded, 'approval_superseded')
}

function terminalApprovalRequest(
  request: PlanApprovalRequestView | null,
  requestId: string,
  status: 'expired' | 'superseded',
  now: string,
  reason: string,
): PlanApprovalRequestView | null {
  if (request === null || request.requestId !== requestId || request.status !== 'approved') return request
  return { ...request, status, decidedAt: now, reason }
}

function persistTerminalBindingProjection(
  handle: DatabaseSync,
  planning: PlanningResultView,
  request: PlanApprovalRequestView | null,
  binding: AdmissionRetryBindingView,
  usageStateValue: 'approval_expired' | 'approval_superseded',
): void {
  if (request !== null && request !== planning.approvalRequest) {
    if (planning.approvalRequest === null) {
      throw new ExperienceError('database_schema_invalid', 'Retry binding has no PlanApprovalRequest projection')
    }
    const changed = handle.prepare(
      'UPDATE plan_approval_requests SET status = ?, payload_json = ? WHERE request_id = ? AND status = ?',
    ).run(request.status, JSON.stringify(request), request.requestId, planning.approvalRequest.status)
    if (changed.changes !== 1) {
      throw new ExperienceError('stale_revision', 'PlanApprovalRequest changed before retry authorization ended')
    }
  }
  const updated: PlanningResultView = { ...planning, approvalRequest: request, retryBinding: binding }
  const changed = handle.prepare(
    'UPDATE experience_usages SET revision = revision + 1, state = ?, payload_json = ? WHERE usage_id = ?',
  ).run(usageStateValue, JSON.stringify(updated), binding.usageId)
  if (changed.changes !== 1) throw new ExperienceError('not_found', 'ExperienceUsage was not found')
}

function assertRetryBindingKeyAvailable(
  handle: DatabaseSync,
  binding: AdmissionRetryBindingView,
  now: string,
): void {
  const rows = handle.prepare(
    `SELECT payload_json FROM admission_retry_bindings
     WHERE task_input_digest = ? AND state IN ('active', 'claimed')
     ORDER BY created_at, binding_id`,
  ).all(binding.taskInputDigest) as Array<{ payload_json: string }>
  for (const row of rows) {
    const current = parsePlanningObject<AdmissionRetryBindingView>(row.payload_json, 'AdmissionRetryBinding')
    if (current.principalId !== binding.principalId || current.scopeDigest !== binding.scopeDigest) continue
    if (Date.parse(current.expiresAt) <= Date.parse(now)) {
      expireBinding(handle, current, now, 'approval_expired')
      continue
    }
    throw new ExperienceError(
      'idempotency_conflict',
      'Another active retry binding already authorizes this exact actor, scope, and task input',
    )
  }
}

function bindingMatchesRequestStatus(
  bindingState: AdmissionRetryBindingView['state'],
  requestStatus: PlanApprovalRequestView['status'],
): boolean {
  if (bindingState === 'expired') return requestStatus === 'expired'
  if (bindingState === 'superseded') return requestStatus === 'superseded'
  return requestStatus === 'approved'
}

function finishClaimedAdmissionAttempt(
  handle: DatabaseSync,
  binding: AdmissionRetryBindingView,
  state: Extract<AdmissionAttemptView['state'], 'rejected' | 'interrupted'>,
  reasonCode: string,
  terminalAt: string,
): void {
  if (binding.claimedByAdmissionAttemptId === null) return
  const row = handle.prepare(
    'SELECT payload_json FROM admission_attempts WHERE admission_attempt_id = ?',
  ).get(binding.claimedByAdmissionAttemptId) as { payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('database_schema_invalid', 'Claimed AdmissionAttempt was not found')
  const attempt = parsePlanningObject<AdmissionAttemptView>(row.payload_json, 'AdmissionAttempt')
  if (attempt.state !== 'ready_to_enter') return
  const updated: AdmissionAttemptView = { ...attempt, state, reasonCode, terminalAt }
  const changed = handle.prepare(
    `UPDATE admission_attempts SET state = ?, payload_json = ?
     WHERE admission_attempt_id = ? AND state = 'ready_to_enter'`,
  ).run(updated.state, JSON.stringify(updated), updated.admissionAttemptId)
  if (changed.changes !== 1) {
    throw new ExperienceError('stale_revision', 'Claimed AdmissionAttempt changed before termination')
  }
}

function readAdmissionAttempts(handle: DatabaseSync, usageId: string): AdmissionAttemptView[] {
  const rows = handle.prepare(
    `SELECT payload_json FROM admission_attempts
     WHERE json_extract(payload_json, '$.usageId') = ?
     ORDER BY created_at, admission_attempt_id`,
  ).all(usageId) as Array<{ payload_json: string }>
  return rows.map(row => parsePlanningObject<AdmissionAttemptView>(row.payload_json, 'AdmissionAttempt'))
}

function hasCompletedRetirement(handle: DatabaseSync, contextDeliveryId: string): boolean {
  const row = handle.prepare(
    `SELECT 1 AS present FROM context_retirements
     WHERE context_delivery_id = ? AND state = 'replaced_on_surface' LIMIT 1`,
  ).get(contextDeliveryId) as { present: number } | undefined
  return row !== undefined
}

function readRetirementForDelivery(
  handle: DatabaseSync,
  contextDeliveryId: string,
): ContextRetirementView | null {
  const row = handle.prepare(
    'SELECT payload_json FROM context_retirements WHERE context_delivery_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(contextDeliveryId) as { payload_json: string } | undefined
  return row === undefined ? null : parsePlanningObject<ContextRetirementView>(row.payload_json, 'ContextRetirement')
}

function sha256Digest(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

function parsePlanningObject<T>(json: string, label: string): T {
  const value = parseObject(json, label)
  return value as unknown as T
}

function isPlanningReceiptAction(value: unknown): value is PlanningReceipt['action'] {
  return value === 'usage.plan' || value === 'plan.approve' || value === 'plan.deny' || value === 'plan.withdraw'
}

interface WorkflowReceiptOptions {
  readonly input: CandidateCommandInput | DecideCandidateFieldInput | ProposeCandidateInput
  readonly action: CandidateWorkflowAction
  readonly actor: ActorView
  readonly candidate: CandidateWorkflowRecord
  readonly payloadDigest: string
  readonly sourceRefs: readonly string[]
  readonly experienceId?: ExperienceId
  readonly experienceVersionId?: ExperienceVersionId
}

type CandidateWorkflowAction = Extract<DomainReceipt['action'], `candidate.${string}`>
type M5ReceiptAction = M5DomainReceipt['action']
type M5CommandInput = ProgressUsageInput | VerifyUsageInput | SettleUsageInput
  | ProposeRevisionInput | DecideRevisionChangeInput | PublishRevisionInput

interface M5ReceiptOptions {
  readonly action: M5ReceiptAction
  readonly input: M5CommandInput
  readonly actor: ActorView
  readonly payloadDigest: string
  readonly usageId: string | null
  readonly controllerRevision: number | null
  readonly revisionProposalId: string | null
  readonly objectRevision: number
  readonly experienceId: ExperienceId | null
  readonly experienceVersionId: ExperienceVersionId | null
}

interface MarkdownReceiptOptions {
  readonly action: MarkdownDomainReceipt['action']
  readonly input: ExportMarkdownInput | ProposeMarkdownRevisionInput
  readonly actor: ActorView
  readonly payloadDigest: string
  readonly projectionReceipt: MarkdownProjectionReceiptView
  readonly revisionProposalId: import('../ids.js').RevisionProposalId | null
  readonly createdAt: string
}

interface EvaluationReceiptOptions {
  readonly input: RecordEvaluationObservationInput
  readonly actor: ActorView
  readonly payloadDigest: string
  readonly observation: EvaluationObservationView
  readonly createdAt: string
}

interface InfrastructureReceiptOptions {
  readonly input: EvaluateInfrastructureReadinessInput
  readonly actor: ActorView
  readonly payloadDigest: string
  readonly evaluation: InfrastructureReadinessEvaluationView
  readonly createdAt: string
}

interface ForgetReceiptOptions {
  readonly input: ForgetExperienceInput
  readonly actor: ActorView
  readonly requestId: ForgetRequestId
  readonly payloadDigest: string
  readonly seriesRevision: number
  readonly createdAt: string
}

interface RelationReceiptOptions {
  readonly input: DeclareExperienceRelationInput | CreateOverrideDecisionInput
  readonly action: RelationDomainReceipt['action']
  readonly actor: ActorView
  readonly relationId: ExperienceRelationId
  readonly overrideDecisionId: OverrideDecisionId | null
  readonly payloadDigest: string
  readonly createdAt: string
}

interface LearningGovernanceReceiptOptions {
  readonly input: EvaluateUnlockContractInput | ChangeAutomationLevelInput | RankHistoryRankingInput
  readonly action: LearningGovernanceReceipt['action']
  readonly actor: ActorView
  readonly capability: LearningGovernanceCapability
  readonly payloadDigest: string
  readonly evaluationId: UnlockContractEvaluationId | null
  readonly decisionId: string | null
  readonly policyRevision: number
  readonly predictionId: LearningPredictionId | null
  readonly rankingDigest: string | null
  readonly createdAt: string
}

function commitWorkflowReceipt(handle: DatabaseSync, options: WorkflowReceiptOptions): DomainReceipt {
  const sequenceRow = handle.prepare(
    'SELECT next_value FROM commit_sequence WHERE singleton = 1',
  ).get() as { next_value: number } | undefined
  if (sequenceRow === undefined || !Number.isSafeInteger(sequenceRow.next_value)) {
    throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing or invalid')
  }
  const now = new Date().toISOString()
  const receiptId = id<'ExperienceReceiptId', ReceiptId>()
  const receipt: DomainReceipt = {
    receiptId,
    commandId: options.input.commandId,
    action: options.action,
    actor: options.actor,
    candidateId: options.candidate.candidateId,
    candidateRevision: options.candidate.revision,
    experienceId: options.experienceId ?? null,
    experienceVersionId: options.experienceVersionId ?? null,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequenceRow.next_value,
    createdAt: now,
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at,
       commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    options.input.commandId,
    options.action,
    options.input.correlationId,
    options.input.causationId,
    options.input.issuedAt,
    sequenceRow.next_value,
    JSON.stringify(receipt),
    now,
  )
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    options.actor.actorId,
    options.input.commandId,
    options.action,
    options.input.correlationId,
    options.input.causationId,
    options.input.issuedAt,
    JSON.stringify([
      options.candidate.candidateId,
      receiptId,
      ...(options.experienceId === undefined ? [] : [options.experienceId]),
      ...(options.experienceVersionId === undefined ? [] : [options.experienceVersionId]),
    ]),
    options.payloadDigest,
    JSON.stringify(options.sourceRefs),
    now,
  )
  handle.prepare(
    `INSERT INTO command_deduplication
      (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)`,
  ).run(options.input.commandId, options.payloadDigest, receiptId, now)
  return receipt
}

function commitM5Receipt(handle: DatabaseSync, options: M5ReceiptOptions): M5DomainReceipt {
  const sequenceRow = handle.prepare(
    'SELECT next_value FROM commit_sequence WHERE singleton = 1',
  ).get() as { next_value: number } | undefined
  if (sequenceRow === undefined || !Number.isSafeInteger(sequenceRow.next_value)) {
    throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing or invalid')
  }
  const now = new Date().toISOString()
  const receiptId = id<'ExperienceReceiptId', ReceiptId>()
  const receipt: M5DomainReceipt = {
    receiptId,
    commandId: options.input.commandId,
    action: options.action,
    actor: options.actor,
    usageId: options.usageId === null ? null : brandedId<'ExperienceUsageId'>(options.usageId, 'usageId'),
    controllerRevision: options.controllerRevision,
    revisionProposalId: options.revisionProposalId === null ? null
      : brandedId<'ExperienceRevisionProposalId'>(options.revisionProposalId, 'revisionProposalId'),
    objectRevision: options.objectRevision,
    experienceId: options.experienceId,
    experienceVersionId: options.experienceVersionId,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequenceRow.next_value,
    createdAt: now,
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at,
       commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(receiptId, options.input.commandId, options.action, options.input.correlationId,
    options.input.causationId, options.input.issuedAt, sequenceRow.next_value, JSON.stringify(receipt), now)
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
  ).run(randomUUID(), options.actor.actorId, options.input.commandId, options.action,
    options.input.correlationId, options.input.causationId, options.input.issuedAt,
    JSON.stringify([...(options.usageId === null ? [] : [options.usageId]), receiptId,
      ...(options.revisionProposalId === null ? [] : [options.revisionProposalId]),
      ...(options.experienceVersionId === null ? [] : [options.experienceVersionId])]),
    options.payloadDigest, now)
  handle.prepare(
    `INSERT INTO command_deduplication
      (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)`,
  ).run(options.input.commandId, options.payloadDigest, receiptId, now)
  return receipt
}

function commitMarkdownReceipt(handle: DatabaseSync, options: MarkdownReceiptOptions): MarkdownDomainReceipt {
  const sequence = nextCommitSequence(handle)
  const receipt: MarkdownDomainReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: options.action,
    actor: options.actor,
    markdownProjectionReceiptId: options.projectionReceipt.markdownProjectionReceiptId,
    experienceId: options.projectionReceipt.experienceId,
    experienceVersionId: options.projectionReceipt.experienceVersionId,
    revisionProposalId: options.revisionProposalId,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequence,
    createdAt: options.createdAt,
  }
  persistGenericReceipt(handle, receipt, options.payloadDigest, [
    receipt.markdownProjectionReceiptId,
    receipt.experienceId,
    receipt.experienceVersionId,
    ...(receipt.revisionProposalId === null ? [] : [receipt.revisionProposalId]),
  ], [])
  return receipt
}

function commitEvaluationReceipt(handle: DatabaseSync, options: EvaluationReceiptOptions): EvaluationDomainReceipt {
  const sequence = nextCommitSequence(handle)
  const receipt: EvaluationDomainReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: 'evaluation.observe',
    actor: options.actor,
    evaluationObservationId: options.observation.evaluationObservationId,
    cohortId: options.observation.cohortId,
    comparisonArm: options.observation.comparisonArm,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequence,
    createdAt: options.createdAt,
  }
  persistGenericReceipt(handle, receipt, options.payloadDigest,
    [receipt.evaluationObservationId], options.observation.metricSourceRefs)
  return receipt
}

function commitInfrastructureReceipt(
  handle: DatabaseSync,
  options: InfrastructureReceiptOptions,
): InfrastructureDomainReceipt {
  const receipt: InfrastructureDomainReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: 'infrastructure.evaluate',
    actor: options.actor,
    infrastructureEvaluationId: options.evaluation.evaluationId,
    decision: options.evaluation.decision,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: nextCommitSequence(handle),
    createdAt: options.createdAt,
  }
  persistGenericReceipt(handle, receipt, options.payloadDigest, [receipt.infrastructureEvaluationId], [])
  return receipt
}

function nextCommitSequence(handle: DatabaseSync): number {
  const row = handle.prepare('SELECT next_value FROM commit_sequence WHERE singleton = 1')
    .get() as { next_value: number } | undefined
  if (row === undefined || !Number.isSafeInteger(row.next_value)) {
    throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing or invalid')
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  return row.next_value
}

function persistGenericReceipt(
  handle: DatabaseSync,
  receipt: MarkdownDomainReceipt | EvaluationDomainReceipt | InfrastructureDomainReceipt,
  payloadDigest: string,
  objectRefs: readonly string[],
  sourceRefs: readonly string[],
): void {
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at,
       commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(receipt.receiptId, receipt.commandId, receipt.action, receipt.correlationId,
    receipt.causationId, receipt.issuedAt, receipt.commitSequence, JSON.stringify(receipt), receipt.createdAt)
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), receipt.actor.actorId, receipt.commandId, receipt.action,
    receipt.correlationId, receipt.causationId, receipt.issuedAt,
    JSON.stringify(objectRefs), payloadDigest, JSON.stringify(sourceRefs), receipt.createdAt)
  handle.prepare(
    `INSERT INTO command_deduplication
      (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)`,
  ).run(receipt.commandId, payloadDigest, receipt.receiptId, receipt.createdAt)
}

function commitForgetReceipt(handle: DatabaseSync, options: ForgetReceiptOptions): ForgetDomainReceipt {
  const sequenceRow = handle.prepare(
    'SELECT next_value FROM commit_sequence WHERE singleton = 1',
  ).get() as { next_value: number } | undefined
  if (sequenceRow === undefined || !Number.isSafeInteger(sequenceRow.next_value)) {
    throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing or invalid')
  }
  const receipt: ForgetDomainReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: 'experience.forget',
    actor: options.actor,
    forgetRequestId: options.requestId,
    experienceId: options.input.experienceId,
    seriesRevision: options.seriesRevision,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequenceRow.next_value,
    createdAt: options.createdAt,
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at,
       commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(receipt.receiptId, receipt.commandId, receipt.action, receipt.correlationId,
    receipt.causationId, receipt.issuedAt, receipt.commitSequence, JSON.stringify(receipt), receipt.createdAt)
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
  ).run(randomUUID(), options.actor.actorId, receipt.commandId, receipt.action,
    receipt.correlationId, receipt.causationId, receipt.issuedAt,
    JSON.stringify([receipt.experienceId, receipt.forgetRequestId, receipt.receiptId]),
    options.payloadDigest, receipt.createdAt)
  handle.prepare(
    `INSERT INTO command_deduplication
      (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)`,
  ).run(receipt.commandId, options.payloadDigest, receipt.receiptId, receipt.createdAt)
  return receipt
}

function commitRelationReceipt(handle: DatabaseSync, options: RelationReceiptOptions): RelationDomainReceipt {
  const sequence = handle.prepare('SELECT next_value FROM commit_sequence WHERE singleton = 1')
    .get() as { next_value: number } | undefined
  if (sequence === undefined || !Number.isSafeInteger(sequence.next_value)) {
    throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing or invalid')
  }
  const receipt: RelationDomainReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: options.action,
    actor: options.actor,
    relationId: options.relationId,
    overrideDecisionId: options.overrideDecisionId,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequence.next_value,
    createdAt: options.createdAt,
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at,
       commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(receipt.receiptId, receipt.commandId, receipt.action, receipt.correlationId,
    receipt.causationId, receipt.issuedAt, receipt.commitSequence, JSON.stringify(receipt), receipt.createdAt)
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
  ).run(randomUUID(), options.actor.actorId, receipt.commandId, receipt.action,
    receipt.correlationId, receipt.causationId, receipt.issuedAt,
    JSON.stringify([receipt.relationId, receipt.receiptId,
      ...(receipt.overrideDecisionId === null ? [] : [receipt.overrideDecisionId])]),
    options.payloadDigest, receipt.createdAt)
  handle.prepare(
    `INSERT INTO command_deduplication
      (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)`,
  ).run(receipt.commandId, options.payloadDigest, receipt.receiptId, receipt.createdAt)
  return receipt
}

function commitLearningGovernanceReceipt(
  handle: DatabaseSync,
  options: LearningGovernanceReceiptOptions,
): LearningGovernanceReceipt {
  const sequence = handle.prepare('SELECT next_value FROM commit_sequence WHERE singleton = 1')
    .get() as { next_value: number } | undefined
  if (sequence === undefined || !Number.isSafeInteger(sequence.next_value)) {
    throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing or invalid')
  }
  const input = options.input as Partial<RankHistoryRankingInput>
  const receipt: LearningGovernanceReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: options.action,
    actor: options.actor,
    capability: options.capability,
    predictionId: options.predictionId ?? input.predictionId ?? null,
    rankingDigest: options.rankingDigest ?? input.rankingDigest ?? null,
    evaluationId: options.evaluationId,
    decisionId: options.decisionId,
    policyRevision: options.policyRevision,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequence.next_value,
    createdAt: options.createdAt,
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at,
       commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(receipt.receiptId, receipt.commandId, receipt.action, receipt.correlationId,
    receipt.causationId, receipt.issuedAt, receipt.commitSequence, JSON.stringify(receipt), receipt.createdAt)
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
  ).run(randomUUID(), options.actor.actorId, receipt.commandId, receipt.action,
    receipt.correlationId, receipt.causationId, receipt.issuedAt,
    JSON.stringify([receipt.capability, receipt.receiptId,
      ...(receipt.evaluationId === null ? [] : [receipt.evaluationId]),
      ...(receipt.decisionId === null ? [] : [receipt.decisionId])]),
    options.payloadDigest, receipt.createdAt)
  handle.prepare(
    `INSERT INTO command_deduplication
      (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)`,
  ).run(receipt.commandId, options.payloadDigest, receipt.receiptId, receipt.createdAt)
  return receipt
}

function validateSuggestionSaveSnapshot(
  input: SaveExperienceSuggestionInput,
  group: ExperienceSuggestionGroupView,
  maxInlineFieldBytes: number,
): void {
  const decisionDigests = suggestionDecisionDigests(group)
  if (group.revisionDigest !== decisionDigests.revisionDigest
    || group.reviewDigest !== decisionDigests.reviewDigest
    || group.suggestionGroupId !== input.suggestionGroupId
    || group.revisionDigest !== input.expectedRevisionDigest
    || group.reviewDigest !== input.reviewDigest
    || group.sourceDigest !== input.sourceDigest) {
    throw new ExperienceError('stale_revision', 'suggestion save snapshot does not match the command')
  }
  const eligibility = suggestionSaveEligibility(group, input.ownerChoice)
  if (!eligibility.allowed) {
    throw new ExperienceError('invalid_command', 'suggestion snapshot is not ready for canonical save')
  }
  if (group.kind !== group.draft.proposedKind || group.occurrences.length === 0
    || group.occurrenceCount !== group.occurrences.length
    || new Set(group.occurrences.map(occurrence => occurrence.occurrenceId)).size !== group.occurrences.length) {
    throw new ExperienceError('invalid_command', 'suggestion snapshot structure is inconsistent')
  }
  const episodeRefs = uniqueBy(group.occurrences.map(occurrence => occurrence.episodeRef), ref => ref.episodeRefId)
  const sourceRefs = uniqueBy(group.occurrences.flatMap(occurrence => occurrence.sourceRefs), ref => ref.sourceRefId)
  validateWorkflowDraft(group.draft, episodeRefs, sourceRefs, maxInlineFieldBytes)
}

function findActiveVersionByKernel(
  handle: DatabaseSync,
  draft: Pick<ExperienceCandidateDraft, 'proposedKind' | 'scope' | 'components'>,
  activeVersions = listCurrentActiveVersions(handle),
): ExperienceVersionView | null {
  const expected = experienceKernelIdentity({
    kind: draft.proposedKind,
    scope: draft.scope,
    components: draft.components,
  })
  let match: ExperienceVersionView | null = null
  for (const version of activeVersions) {
    const actual = experienceKernelIdentity({
      kind: version.kind,
      scope: version.scope,
      components: version.components,
    })
    if (actual !== expected) continue
    if (match !== null) {
      throw new ExperienceError('database_schema_invalid', 'Multiple active Experiences share one exact stable kernel', {
        kernelIdentity: expected,
        experienceIds: [match.experienceId, version.experienceId],
      })
    }
    match = version
  }
  return match
}

function listCurrentActiveVersions(handle: DatabaseSync): ExperienceVersionView[] {
  const rows = handle.prepare(
    `SELECT current_version_id FROM experience_series
      WHERE lifecycle_projection = 'active' ORDER BY experience_id`,
  ).all() as Array<{ current_version_id: string }>
  return rows.map(row => readVersion(handle, row.current_version_id))
}

function resolveSemanticDuplicateTarget(
  handle: DatabaseSync,
  group: ExperienceSuggestionGroupView,
): ExperienceVersionView {
  const match = group.canonicalMatch
  const detail = group.consolidationDetail
  if (match === undefined || !Number.isFinite(match.similarity)
    || match.similarity < 0 || match.similarity > 1
    || !Number.isSafeInteger(match.retrievalGeneration) || match.retrievalGeneration < 0
    || match.modelId.trim() === '' || match.modelRevision.trim() === ''
    || match.title.trim() === '' || match.intent.trim() === ''
    || detail === undefined || detail.targetExperienceVersionId !== match.experienceVersionId
    || detail.targetVersionContentDigest !== match.versionContentDigest
    || detail.componentCorrespondence.length !== group.draft.components.length * Math.max(1, detail.sourceGroups.length)
    || detail.componentCorrespondence.some(item => item.targetComponentRevisionId === null)) {
    throw new ExperienceError('invalid_command', 'semantic duplicate match is incomplete or invalid')
  }
  const version = readVersion(handle, match.experienceVersionId)
  if (!isCurrentActiveVersion(handle, version.experienceVersionId)
    || version.experienceId !== match.experienceId
    || version.contentDigest !== match.versionContentDigest
    || version.title !== match.title
    || version.intent !== match.intent
    || version.kind !== group.kind
    || !experienceHardScopeMatches(version.scope, group.draft.scope)) {
    throw new ExperienceError('stale_revision', 'semantic duplicate target changed before canonical commit', {
      experienceVersionId: match.experienceVersionId,
    })
  }
  return version
}

function assertSuggestionComparisonSnapshot(
  group: ExperienceSuggestionGroupView,
  activeVersions: readonly ExperienceVersionView[],
): void {
  const expected = group.consolidationDetail?.activeComparisonSetDigest
  if (expected === undefined) return
  const actual = experienceComparisonSetDigest(
    { kind: group.kind, scope: group.draft.scope },
    activeVersions,
  )
  if (actual !== expected) {
    throw new ExperienceError('stale_revision', 'active Experience comparison set changed before canonical commit', {
      expectedComparisonSetDigest: expected,
      actualComparisonSetDigest: actual,
    })
  }
}

function attachSuggestionEvidence(
  handle: DatabaseSync,
  version: ExperienceVersionView,
  group: ExperienceSuggestionGroupView,
  actor: ActorView,
  now: string,
  semanticDuplicate = false,
): { readonly evidenceIds: EvidenceId[]; readonly assessmentId: AssessmentId; readonly changed: boolean } {
  const bindings = semanticDuplicate
    ? semanticSuggestionEvidenceBindings(version, group)
    : exactSuggestionEvidenceBindings(version, group)
  const insertEvidence = handle.prepare(
    `INSERT OR IGNORE INTO evidence_statements
      (evidence_id, component_revision_id, claim_text, source_refs_json, direction)
     VALUES (?, ?, ?, ?, 'supports')`,
  )
  const evidenceIds = bindings.map(({ sourceRefId, target }) => {
    const evidenceId = deterministicId<'ExperienceEvidenceId', EvidenceId>(
      'suggestion-evidence',
      `${version.experienceVersionId}:${target.componentRevisionId}:${sourceRefId}`,
    )
    const result = insertEvidence.run(
      evidenceId,
      target.componentRevisionId,
      target.content,
      JSON.stringify([sourceRefId]),
    )
    if (result.changes === 0) {
      const existing = handle.prepare(
        `SELECT component_revision_id, claim_text, source_refs_json, direction
           FROM evidence_statements WHERE evidence_id = ?`,
      ).get(evidenceId) as {
        component_revision_id: string
        claim_text: string
        source_refs_json: string
        direction: string
      } | undefined
      if (existing === undefined || existing.component_revision_id !== target.componentRevisionId
        || existing.claim_text !== target.content || existing.direction !== 'supports'
        || canonicalJson(parseLearningStringArray(existing.source_refs_json, 'Evidence source refs'))
          !== canonicalJson([sourceRefId])) {
        throw new ExperienceError('database_schema_invalid', 'Deterministic suggestion evidence identity conflicts')
      }
    }
    return { evidenceId, inserted: result.changes === 1 }
  })
  const allEvidence = (handle.prepare(
    `SELECT es.evidence_id
       FROM evidence_statements es
       JOIN experience_version_components vc ON vc.component_revision_id = es.component_revision_id
      WHERE vc.experience_version_id = ? ORDER BY es.evidence_id`,
  ).all(version.experienceVersionId) as Array<{ evidence_id: string }>).map(row => row.evidence_id)
  const assessmentId = deterministicId<'ExperienceAssessmentId', AssessmentId>(
    'suggestion-assessment',
    `${version.experienceVersionId}:${group.draft.evidenceGrade}:${actor.actorId}:${allEvidence.join(':')}`,
  )
  const assessmentInsert = handle.prepare(
    `INSERT OR IGNORE INTO evidence_assessments
      (assessment_id, experience_version_id, grade, governance_state, operational_state,
       evidence_ids_json, decided_by, decided_at)
     VALUES (?, ?, ?, 'accepted', 'conditional', ?, ?, ?)`,
  ).run(
    assessmentId,
    version.experienceVersionId,
    group.draft.evidenceGrade,
    JSON.stringify(allEvidence),
    actor.actorId,
    now,
  )
  if (assessmentInsert.changes === 0) {
    const existing = handle.prepare(
      `SELECT grade, governance_state, operational_state, evidence_ids_json, decided_by
         FROM evidence_assessments WHERE assessment_id = ?`,
    ).get(assessmentId) as {
      grade: string
      governance_state: string
      operational_state: string
      evidence_ids_json: string
      decided_by: string
    } | undefined
    if (existing === undefined || existing.grade !== group.draft.evidenceGrade
      || existing.governance_state !== 'accepted' || existing.operational_state !== 'conditional'
      || existing.decided_by !== actor.actorId
      || canonicalJson(parseLearningStringArray(existing.evidence_ids_json, 'Assessment evidence ids').sort())
        !== canonicalJson([...allEvidence].sort())) {
      throw new ExperienceError('database_schema_invalid', 'Deterministic suggestion assessment identity conflicts')
    }
  }
  return {
    evidenceIds: evidenceIds.map(item => item.evidenceId),
    assessmentId,
    changed: evidenceIds.some(item => item.inserted) || assessmentInsert.changes === 1,
  }
}

function exactSuggestionEvidenceBindings(
  version: ExperienceVersionView,
  group: ExperienceSuggestionGroupView,
): readonly SuggestionEvidenceBinding[] {
  const unused = new Set(version.components.map(component => component.componentRevisionId as string))
  const bindings: SuggestionEvidenceBinding[] = []
  for (const incoming of group.draft.components) {
    const target = version.components.find(component => unused.has(component.componentRevisionId)
      && component.role === incoming.role
      && normalizeKernelText(component.content) === normalizeKernelText(incoming.content))
    if (target === undefined) {
      throw new ExperienceError('experience_duplicate', 'Exact stable kernel has conflicting component content', {
        experienceId: version.experienceId,
        experienceVersionId: version.experienceVersionId,
        kernelIdentity: group.kernelIdentity,
        incomingComponentKey: incoming.componentKey,
        incomingRole: incoming.role,
      })
    }
    unused.delete(target.componentRevisionId)
    for (const sourceRefId of suggestionEvidenceSourceRefsForComponent(incoming)) {
      bindings.push({ sourceRefId, target })
    }
  }
  if (unused.size > 0) {
    throw new ExperienceError('experience_duplicate', 'Exact stable kernel has a different component set', {
      experienceId: version.experienceId,
      experienceVersionId: version.experienceVersionId,
      kernelIdentity: group.kernelIdentity,
    })
  }
  return [...new Map(bindings.map(binding => [
    `${binding.target.componentRevisionId}\u0000${binding.sourceRefId}`,
    binding,
  ] as const)).values()].sort((left, right) =>
    left.target.componentRevisionId.localeCompare(right.target.componentRevisionId)
      || left.sourceRefId.localeCompare(right.sourceRefId))
}

interface SuggestionEvidenceBinding {
  readonly sourceRefId: string
  readonly target: ExperienceVersionView['components'][number]
}

function semanticSuggestionEvidenceBindings(
  version: ExperienceVersionView,
  group: ExperienceSuggestionGroupView,
): readonly SuggestionEvidenceBinding[] {
  const detail = group.consolidationDetail
  const representative = detail?.sourceGroups[0]
  if (detail === undefined || representative === undefined
    || detail.targetExperienceVersionId !== version.experienceVersionId) {
    throw new ExperienceError('invalid_command', 'semantic evidence correspondence is missing')
  }
  const sourceGroupIds = new Set(detail.sourceGroups.map(sourceGroup => sourceGroup.suggestionGroupId))
  const targetByRevision = new Map(version.components.map(component => [component.componentRevisionId as string, component]))
  const correspondenceKeys = new Set<string>()
  const targetSetsBySourceGroup = new Map<string, Set<string>>()
  for (const item of detail.componentCorrespondence) {
    const target = item.targetComponentRevisionId === null
      ? undefined
      : targetByRevision.get(item.targetComponentRevisionId)
    const key = `${item.incomingSuggestionGroupId}\u0000${item.incomingComponentKey}`
    if (!sourceGroupIds.has(item.incomingSuggestionGroupId) || correspondenceKeys.has(key)
      || target === undefined || target.componentKey !== item.targetComponentKey
      || target.role !== item.targetRole || item.incomingRole !== item.targetRole
      || suggestionComponentContentDigest(target.content) !== item.targetContentDigest) {
      throw new ExperienceError('stale_revision', 'semantic evidence correspondence no longer matches the canonical Version')
    }
    correspondenceKeys.add(key)
    const targetSet = targetSetsBySourceGroup.get(item.incomingSuggestionGroupId) ?? new Set<string>()
    targetSet.add(target.componentRevisionId)
    targetSetsBySourceGroup.set(item.incomingSuggestionGroupId, targetSet)
  }
  const representativeMappings = new Map(detail.componentCorrespondence
    .filter(item => item.incomingSuggestionGroupId === representative.suggestionGroupId)
    .map(item => [item.incomingComponentKey, item]))
  const expectedTargetRevisions = new Set<string>()
  const bindings = new Map<string, SuggestionEvidenceBinding>()
  for (const component of group.draft.components) {
    const mapping = representativeMappings.get(component.componentKey)
    const target = mapping?.targetComponentRevisionId === null || mapping === undefined
      ? undefined
      : targetByRevision.get(mapping.targetComponentRevisionId)
    if (mapping === undefined || target === undefined || mapping.incomingRole !== component.role
      || mapping.incomingContentDigest !== suggestionComponentContentDigest(component.content)) {
      throw new ExperienceError('stale_revision', 'semantic evidence correspondence does not match the reviewed suggestion')
    }
    expectedTargetRevisions.add(target.componentRevisionId)
    for (const sourceRefId of suggestionEvidenceSourceRefsForComponent(component)) {
      bindings.set(`${target.componentRevisionId}\u0000${sourceRefId}`, { sourceRefId, target })
    }
  }
  for (const sourceGroup of detail.sourceGroups) {
    const actual = targetSetsBySourceGroup.get(sourceGroup.suggestionGroupId)
    if (actual === undefined || actual.size !== expectedTargetRevisions.size
      || [...expectedTargetRevisions].some(revisionId => !actual.has(revisionId))) {
      throw new ExperienceError('stale_revision', 'semantic source group does not map to every canonical component')
    }
  }
  return [...bindings.values()].sort((left, right) =>
    left.target.componentRevisionId.localeCompare(right.target.componentRevisionId)
      || left.sourceRefId.localeCompare(right.sourceRefId))
}

function suggestionComponentContentDigest(content: string): string {
  return `sha256:${sha256(canonicalJson(normalizeKernelText(content)))}`
}

interface SuggestionSaveReceiptOptions {
  readonly input: SaveExperienceSuggestionInput
  readonly actor: ActorView
  readonly group: ExperienceSuggestionGroupView
  readonly payloadDigest: string
  readonly kernelIdentity: string
  readonly outcome: SuggestionSaveDomainReceipt['outcome']
  readonly experienceId: ExperienceId
  readonly experienceVersionId: ExperienceVersionId
  readonly evidenceIds: readonly EvidenceId[]
  readonly assessmentId: AssessmentId
  readonly createdAt: string
}

function commitSuggestionSaveReceipt(
  handle: DatabaseSync,
  options: SuggestionSaveReceiptOptions,
): SuggestionSaveDomainReceipt {
  const sequence = handle.prepare('SELECT next_value FROM commit_sequence WHERE singleton = 1')
    .get() as { next_value: number } | undefined
  if (sequence === undefined || !Number.isSafeInteger(sequence.next_value)) {
    throw new ExperienceError('database_schema_invalid', 'Experience commit sequence is missing or invalid')
  }
  const receipt: SuggestionSaveDomainReceipt = {
    receiptId: id<'ExperienceReceiptId', ReceiptId>(),
    commandId: options.input.commandId,
    action: 'suggestion.save',
    actor: options.actor,
    suggestionGroupId: options.group.suggestionGroupId,
    kernelIdentity: options.kernelIdentity,
    outcome: options.outcome,
    experienceId: options.experienceId,
    experienceVersionId: options.experienceVersionId,
    evidenceIds: options.evidenceIds,
    assessmentId: options.assessmentId,
    reviewDigest: options.input.reviewDigest,
    sourceDigest: options.input.sourceDigest,
    suggestionRevisionDigest: options.input.expectedRevisionDigest,
    inputDigest: options.payloadDigest,
    scopeDigest: sha256(canonicalJson(options.group.draft.scope)),
    sourceSuggestionGroupIds: suggestionSourceGroupIds(options.group),
    occurrenceIds: [...options.group.occurrences.map(occurrence => occurrence.occurrenceId)].sort(),
    sourceEpisodeRefs: uniqueBy(
      options.group.occurrences.map(occurrence => occurrence.episodeRef),
      ref => ref.episodeRefId,
    ),
    sourceRefs: uniqueBy(
      options.group.occurrences.flatMap(occurrence => occurrence.sourceRefs),
      ref => ref.sourceRefId,
    ),
    expiresAt: options.group.expiresAt,
    correlationId: options.input.correlationId,
    causationId: options.input.causationId,
    issuedAt: options.input.issuedAt,
    commitSequence: sequence.next_value,
    createdAt: options.createdAt,
  }
  handle.prepare('UPDATE commit_sequence SET next_value = next_value + 1 WHERE singleton = 1').run()
  handle.prepare(
    `INSERT INTO domain_receipts
      (receipt_id, command_id, action, correlation_id, causation_id, issued_at,
       commit_sequence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.receiptId,
    receipt.commandId,
    receipt.action,
    receipt.correlationId,
    receipt.causationId,
    receipt.issuedAt,
    receipt.commitSequence,
    JSON.stringify(receipt),
    receipt.createdAt,
  )
  const sourceRefs = [
    ...options.group.occurrences.map(occurrence => occurrence.episodeRef.episodeRefId as string),
    ...options.group.occurrences.flatMap(occurrence => occurrence.sourceRefs.map(ref => ref.sourceRefId as string)),
  ]
  handle.prepare(
    `INSERT INTO audit_events
      (audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
       object_refs_json, payload_digest, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    options.actor.actorId,
    receipt.commandId,
    receipt.action,
    receipt.correlationId,
    receipt.causationId,
    receipt.issuedAt,
    JSON.stringify([
      receipt.suggestionGroupId,
      receipt.experienceId,
      receipt.experienceVersionId,
      ...receipt.evidenceIds,
      receipt.assessmentId,
    ]),
    options.payloadDigest,
    JSON.stringify([...new Set(sourceRefs)].sort()),
    receipt.createdAt,
  )
  handle.prepare(
    `INSERT INTO command_deduplication
      (command_id, payload_digest, receipt_id, completed_at) VALUES (?, ?, ?, ?)`,
  ).run(receipt.commandId, options.payloadDigest, receipt.receiptId, receipt.createdAt)
  return receipt
}

function insertPublishedVersion(
  handle: DatabaseSync,
  draft: ExperienceCandidateDraft,
  version: Extract<ExperienceVersionView, { contentDigestSchema: 'v2-source-bound' }>,
  actor: ActorView,
  governanceDecisionId: string,
  now: string,
  governance: {
    readonly subjectRef: string
    readonly decisionType: 'publish_candidate' | 'save_experience_suggestion'
    readonly reasonCode: string
  },
): void {
  handle.prepare(
    `INSERT INTO experience_series
      (experience_id, kind, current_version_id, series_revision, lifecycle_projection, created_at)
     VALUES (?, ?, ?, 1, 'active', ?)`,
  ).run(version.experienceId, draft.proposedKind, version.experienceVersionId, now)
  handle.prepare(
    `INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(governanceDecisionId, actor.actorId, JSON.stringify({
    subjectRef: governance.subjectRef,
    decisionType: governance.decisionType,
    outcome: 'accepted',
    authority: actor.authority,
    reasonCode: governance.reasonCode,
  }), now)
  handle.prepare(
    `INSERT INTO experience_versions
      (experience_version_id, experience_id, version_number, previous_version_id, title, intent,
       scope_json, privacy_class, allowed_use_modes_json, evidence_grade, initial_assessment_id,
       created_by_decision_id, content_digest, payload_json, created_at)
     VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version.experienceVersionId,
    version.experienceId,
    draft.title,
    draft.intent,
    JSON.stringify(draft.scope),
    draft.privacyClass,
    JSON.stringify(draft.allowedUseModes),
    draft.evidenceGrade,
    version.initialAssessmentId,
    governanceDecisionId,
    version.contentDigest,
    JSON.stringify(version),
    now,
  )
  const insertComponent = handle.prepare(
    `INSERT INTO experience_components
      (component_id, experience_id, semantic_role, current_revision_id) VALUES (?, ?, ?, ?)`,
  )
  const insertRevision = handle.prepare(
    `INSERT INTO component_revisions
      (component_revision_id, component_id, content_text, source_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const insertEvidence = handle.prepare(
    `INSERT INTO evidence_statements
      (evidence_id, component_revision_id, claim_text, source_refs_json, direction)
     VALUES (?, ?, ?, ?, 'supports')`,
  )
  const insertMembership = handle.prepare(
    `INSERT INTO experience_version_components
      (experience_version_id, ordinal, component_revision_id) VALUES (?, ?, ?)`,
  )
  for (let index = 0; index < draft.components.length; index++) {
    const component = draft.components[index]!
    const published = version.components[index]!
    insertComponent.run(
      published.componentId,
      version.experienceId,
      component.role,
      published.componentRevisionId,
    )
    insertRevision.run(
      published.componentRevisionId,
      published.componentId,
      component.content,
      JSON.stringify(component.sourceRefs),
      now,
    )
    for (const [evidenceIndex, evidenceId] of published.evidenceIds.entries()) {
      const sourceRefs = published.evidenceIds.length === component.sourceRefs.length
        ? [component.sourceRefs[evidenceIndex]!] : component.sourceRefs
      insertEvidence.run(
        evidenceId,
        published.componentRevisionId,
        component.content,
        JSON.stringify(sourceRefs),
      )
    }
    insertMembership.run(version.experienceVersionId, index, published.componentRevisionId)
  }
  handle.prepare(
    `INSERT INTO evidence_assessments
      (assessment_id, experience_version_id, grade, governance_state, operational_state,
       evidence_ids_json, decided_by, decided_at)
     VALUES (?, ?, ?, 'accepted', 'conditional', ?, ?, ?)`,
  ).run(
    version.initialAssessmentId,
    version.experienceVersionId,
    draft.evidenceGrade,
    JSON.stringify(version.components.flatMap(component => component.evidenceIds)),
    actor.actorId,
    now,
  )
}

function readWorkflowCandidate(handle: DatabaseSync, candidateId: string): CandidateWorkflowRecord {
  const row = handle.prepare(
    'SELECT candidate_id, revision, state, payload_json, published_version_id FROM candidates WHERE candidate_id = ?',
  ).get(candidateId) as {
    candidate_id: string
    revision: number
    state: string
    payload_json: string
    published_version_id: string | null
  } | undefined
  if (row === undefined) throw new ExperienceError('not_found', `Candidate ${JSON.stringify(candidateId)} was not found`)
  const value = parseObject(row.payload_json, 'ExperienceCandidate')
  if (value.candidateId !== row.candidate_id
    || value.revision !== row.revision
    || value.state !== row.state
    || value.publishedVersionId !== row.published_version_id
    || value.target !== 'new_experience'
    || !isCandidateState(value.state)
    || !isExtractionTrigger(value.extractionTrigger)
    || !isOutcomeAssessment(value.outcomeAssessment)
    || !nonEmptyString(value.eligibilityDigest)
    || typeof value.triggerReason !== 'string'
    || !isExperienceCandidateDraft(value.draft)
    || !isCandidateProposalMetadata(value.proposal)
    || !isEpisodeRefs(value.sourceEpisodeRefs)
    || !isSourceRefs(value.sourceRefs)
    || !isStringArray(value.componentIds)
    || !isStringArray(value.componentRevisionIds)
    || !isStringArray(value.evidenceIds)
    || !isCandidateDecisions(value.decisions)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || typeof value.createdAt !== 'string'
    || typeof value.proposedBy !== 'string'
    || (value.dispositionReason !== null && typeof value.dispositionReason !== 'string')) {
    throw new ExperienceError('database_schema_invalid', 'ExperienceCandidate durable JSON is invalid')
  }
  const candidate = value as unknown as CandidateWorkflowRecord
  try {
    validateStoredCandidateSemantics(candidate)
  } catch (error) {
    throw new ExperienceError(
      'database_schema_invalid',
      'ExperienceCandidate durable JSON is invalid',
      {},
      { cause: error },
    )
  }
  return candidate
}

function candidateView(candidate: CandidateWorkflowRecord): CandidateView {
  const resolved = resolveWorkflowDraft(candidate)
  return {
    candidateId: candidate.candidateId,
    candidateRevision: candidate.revision,
    state: candidate.state,
    target: candidate.target,
    proposedKind: resolved.proposedKind,
    title: resolved.title,
    extractionTrigger: candidate.extractionTrigger,
    outcomeAssessment: candidate.outcomeAssessment,
    eligibilityDigest: candidate.eligibilityDigest,
    triggerReason: candidate.triggerReason,
    sourceEpisodeRefs: candidate.sourceEpisodeRefs,
    sourceRefs: candidate.sourceRefs,
    proposal: candidate.proposal,
    evidenceGrade: maximumSupportedEvidenceGrade(candidate),
    fields: workflowFieldViews(candidate),
    excludedSteps: candidate.draft.excludedSteps,
    missingEvidence: candidate.draft.missingEvidence,
    unresolvedFields: resolved.unresolvedFields,
    publicationReadiness: publicationReadiness(candidate),
    createdAt: candidate.createdAt,
    publishedVersionId: candidate.publishedVersionId,
    dispositionReason: candidate.dispositionReason,
  }
}

function candidateSummary(candidate: CandidateWorkflowRecord): CandidateSummaryView {
  const decisions = currentWorkflowDecisions(candidate)
  const fields = workflowFieldViews(candidate)
  const resolved = resolveWorkflowDraft(candidate)
  return {
    candidateId: candidate.candidateId,
    candidateRevision: candidate.revision,
    state: candidate.state,
    proposedKind: resolved.proposedKind,
    title: resolved.title,
    triggerReason: candidate.triggerReason,
    eligibilityStatus: candidate.extractionTrigger.eligibilityStatus,
    pendingFieldCount: fields.filter(field => !decisions.has(field.field)).length,
    rejectedFieldCount: [...decisions.values()].filter(decision => decision.decision === 'reject').length,
    createdAt: candidate.createdAt,
    proposal: candidate.proposal,
  }
}

function publicationReadiness(candidate: CandidateWorkflowRecord): CandidateView['publicationReadiness'] {
  const blockers: string[] = []
  const resolved = resolveWorkflowDraft(candidate)
  if (candidate.extractionTrigger.eligibilityStatus !== 'eligible') blockers.push('extraction_not_eligible')
  if (candidate.draft.missingEvidence.length > 0) blockers.push('missing_evidence')
  if (resolved.unresolvedFields.length > 0) blockers.push('unresolved_fields')
  if (evidenceGradeRank(resolved.evidenceGrade) > evidenceGradeRank(maximumSupportedEvidenceGrade(candidate, resolved))) {
    blockers.push('evidence_grade_exceeds_sources')
  }
  const fields = workflowFields(candidate)
  const current = currentWorkflowDecisions(candidate)
  if (fields.some(([field]) => !current.has(field))) blockers.push('field_decisions_incomplete')
  if ([...current.values()].some(decision => decision.decision === 'reject')) blockers.push('field_rejected')
  return { ready: blockers.length === 0, blockers }
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

function deduplicatedReceipt(handle: DatabaseSync, commandId: string, payloadDigest: string): ExperienceDomainReceipt | null {
  const existing = handle.prepare(
    'SELECT payload_digest, receipt_id FROM command_deduplication WHERE command_id = ?',
  ).get(commandId) as DeduplicationRow | undefined
  if (existing === undefined) return null
  if (existing.payload_digest !== payloadDigest) {
    throw new ExperienceError('idempotency_conflict', 'CommandId was already used with a different payload')
  }
  return readReceipt(handle, existing.receipt_id)
}

function deduplicatedCandidateReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): DomainReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  return receipt === null ? null : requireCandidateReceipt(receipt)
}

function deduplicatedM5Receipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): M5DomainReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  if (receipt === null) return null
  if (!isM5ReceiptAction(receipt.action)) {
    throw new ExperienceError('database_schema_invalid', 'M5 command resolved to a Candidate receipt')
  }
  return receipt as M5DomainReceipt
}

function deduplicatedForgetReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): ForgetDomainReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  if (receipt === null) return null
  if (!isForgetReceiptAction(receipt.action)) {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to a non-Forget command')
  }
  return receipt as ForgetDomainReceipt
}

function deduplicatedRelationReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): RelationDomainReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  if (receipt === null) return null
  if (!isRelationReceiptAction(receipt.action)) {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to a non-relation command')
  }
  return receipt as RelationDomainReceipt
}

function deduplicatedLearningGovernanceReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): LearningGovernanceReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  if (receipt === null) return null
  if (!isLearningGovernanceReceiptAction(receipt.action)) {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to a non-learning-governance command')
  }
  return receipt as LearningGovernanceReceipt
}

function deduplicatedMarkdownReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): MarkdownDomainReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  if (receipt === null) return null
  if (!isMarkdownReceiptAction(receipt.action)) {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to a non-Markdown command')
  }
  return receipt as MarkdownDomainReceipt
}

function deduplicatedEvaluationReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): EvaluationDomainReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  if (receipt === null) return null
  if (receipt.action !== 'evaluation.observe') {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to another command')
  }
  return receipt as EvaluationDomainReceipt
}

function deduplicatedInfrastructureReceipt(
  handle: DatabaseSync,
  commandId: string,
  payloadDigest: string,
): InfrastructureDomainReceipt | null {
  const receipt = deduplicatedReceipt(handle, commandId, payloadDigest)
  if (receipt === null) return null
  if (receipt.action !== 'infrastructure.evaluate') {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to another command')
  }
  return receipt as InfrastructureDomainReceipt
}

function requireCandidateReceipt(receipt: ExperienceDomainReceipt): DomainReceipt {
  if (isM5ReceiptAction(receipt.action) || isForgetReceiptAction(receipt.action)
    || isRelationReceiptAction(receipt.action) || isLearningGovernanceReceiptAction(receipt.action)
    || isMarkdownReceiptAction(receipt.action) || receipt.action === 'evaluation.observe'
    || receipt.action === 'infrastructure.evaluate' || receipt.action === 'suggestion.save') {
    throw new ExperienceError('database_schema_invalid', 'Candidate command resolved to another domain receipt')
  }
  return receipt as DomainReceipt
}

function requireSuggestionSaveReceipt(receipt: ExperienceDomainReceipt): SuggestionSaveDomainReceipt {
  if (receipt.action !== 'suggestion.save') {
    throw new ExperienceError('idempotency_conflict', 'CommandId belongs to another command')
  }
  return receipt
}

/** Stable command digest shared by preflight dedup and the write transaction. */
export function workflowPayloadDigest(
  action: CandidateWorkflowAction,
  actor: ActorView,
  input: CandidateCommandInput | DecideCandidateFieldInput | ProposeCandidateInput,
): string {
  return sha256(canonicalJson({ action, actor, input }))
}

function m5PayloadDigest(action: M5ReceiptAction, actor: ActorView, input: M5CommandInput): string {
  return sha256(canonicalJson({ action, actor, input }))
}

function requireOwner(actor: ActorView, action: string): void {
  if (actor.authority !== 'owner') {
    throw new ExperienceError('principal_unauthorized', `this actor cannot ${action}`)
  }
}

function validateRelationInput(handle: DatabaseSync, input: DeclareExperienceRelationInput): void {
  if (input.sourceObjectRef.id.trim() === '' || input.targetObjectRef.id.trim() === '') {
    throw new ExperienceError('required_field_missing', 'Relation endpoints require non-empty ids')
  }
  if (input.sourceObjectRef.kind === input.targetObjectRef.kind
    && input.sourceObjectRef.id === input.targetObjectRef.id) {
    throw new ExperienceError('invalid_command', 'Relation cannot connect an object to itself')
  }
  nonEmptyStringRecord(input.scope, 'Relation scope')
  if (!validInstant(input.validFrom)
    || (input.validTo !== null && (!validInstant(input.validTo) || Date.parse(input.validTo) <= Date.parse(input.validFrom)))) {
    throw new ExperienceError('invalid_command', 'Relation validity interval is invalid')
  }
  validateRelationEndpoint(handle, input.sourceObjectRef)
  validateRelationEndpoint(handle, input.targetObjectRef)
  for (const evidenceId of input.evidenceIds) {
    if (handle.prepare('SELECT 1 FROM evidence_statements WHERE evidence_id = ?').get(evidenceId) === undefined) {
      throw new ExperienceError('source_unresolvable', 'Relation evidence does not exist', { evidenceId })
    }
  }
  validateRelationKinds(input)
  if (input.relationType === 'causal_candidate') {
    for (const key of ['mechanism', 'applicabilityCondition', 'competingExplanation', 'causalGrade']) {
      if (input.qualifiers[key]?.trim() === '') {
        throw new ExperienceError('required_field_missing', `causal_candidate qualifier ${key} is required`)
      }
    }
    if (input.evidenceIds.length === 0) {
      throw new ExperienceError('source_unresolvable', 'causal_candidate requires evidence')
    }
  }
  if (input.relationType === 'causally_influences') validateCausalPromotionRelation(handle, input)
  if (input.relationType === 'conflicts_with' || input.relationType === 'composes_with') {
    const opposite = input.relationType === 'conflicts_with' ? 'composes_with' : 'conflicts_with'
    const rows = handle.prepare(
      `SELECT payload_json FROM experience_relations
        WHERE relation_type = ? AND status = 'active'
          AND ((source_kind = ? AND source_id = ? AND target_kind = ? AND target_id = ?)
            OR (source_kind = ? AND source_id = ? AND target_kind = ? AND target_id = ?))`,
    ).all(opposite,
      input.sourceObjectRef.kind, input.sourceObjectRef.id, input.targetObjectRef.kind, input.targetObjectRef.id,
      input.targetObjectRef.kind, input.targetObjectRef.id, input.sourceObjectRef.kind, input.sourceObjectRef.id,
    ) as Array<{ payload_json: string }>
    if (rows.some(row => canonicalJson(parseObject(row.payload_json, 'ExperienceRelation').scope) === canonicalJson(input.scope))) {
      throw new ExperienceError('invalid_command', 'The same scoped pair cannot both conflict and compose')
    }
  }
  if (input.relationType === 'composes_with' && input.qualifiers.selectionPolicy === 'explicit_optional_component') {
    validateExplicitOptionalDeclaration(handle, input)
  }
}

function validateExplicitOptionalDeclaration(handle: DatabaseSync, input: DeclareExperienceRelationInput): void {
  if (input.sourceObjectRef.kind !== 'component' || input.targetObjectRef.kind !== 'component') {
    throw new ExperienceError('invalid_command', 'explicit_optional_component requires two component endpoints')
  }
  const anchorRevision = input.qualifiers.anchorComponentRevisionId
  const optionalRevision = input.qualifiers.optionalComponentRevisionId
  if (anchorRevision === undefined || optionalRevision === undefined) {
    throw new ExperienceError('required_field_missing', 'explicit_optional_component requires anchor and optional revisions')
  }
  if (input.qualifiers.independenceReason === undefined || input.qualifiers.independenceReason.trim() === '') {
    throw new ExperienceError('required_field_missing', 'explicit_optional_component requires a non-empty independenceReason')
  }
  const taskInputDigest = input.scope.taskInputDigest
  if (taskInputDigest === undefined || !/^sha256:[0-9a-f]{64}$/i.test(taskInputDigest)) {
    throw new ExperienceError('invalid_command', 'explicit_optional_component scope.taskInputDigest must be an exact sha256 digest')
  }
  if (anchorRevision === optionalRevision) {
    throw new ExperienceError('invalid_command', 'explicit_optional_component requires distinct revisions')
  }
  if (input.sourceObjectRef.id === input.targetObjectRef.id) {
    throw new ExperienceError('invalid_command', 'explicit_optional_component endpoints must be distinct components')
  }
  const source = resolveComponentInCurrentVersion(handle, input.sourceObjectRef.id, 'source')
  const target = resolveComponentInCurrentVersion(handle, input.targetObjectRef.id, 'target')
  if (source.versionId !== target.versionId) {
    throw new ExperienceError('invalid_command', 'explicit_optional_component endpoints must be in the same current-active version')
  }
  // composes_with is directionless: match the anchor/optional qualifiers to the two endpoints
  // by their exact revisions, so a positively-reversed declaration is accepted identically.
  const sourceIsAnchor = source.revisionId === anchorRevision
  const sourceIsOptional = source.revisionId === optionalRevision
  const targetIsAnchor = target.revisionId === anchorRevision
  const targetIsOptional = target.revisionId === optionalRevision
  if (!((sourceIsAnchor && targetIsOptional) || (sourceIsOptional && targetIsAnchor))) {
    throw new ExperienceError('invalid_command', 'explicit_optional_component revisions do not match the two endpoints')
  }
  for (const component of [source, target]) {
    if (component.role !== 'step' && component.role !== 'resolution_candidate') {
      throw new ExperienceError('invalid_command', 'explicit_optional_component may only prune step/resolution_candidate actions')
    }
  }
}

function resolveComponentInCurrentVersion(
  handle: DatabaseSync,
  componentId: string,
  label: string,
): { readonly versionId: string; readonly role: import('../types.js').ComponentRole; readonly revisionId: string } {
  const rows = handle.prepare(
    `SELECT DISTINCT vc.experience_version_id
       FROM experience_version_components vc
       JOIN component_revisions cr ON cr.component_revision_id = vc.component_revision_id
      WHERE cr.component_id = ?`,
  ).all(componentId) as Array<{ experience_version_id: string }>
  const currentActive = rows
    .filter(row => isCurrentActiveVersion(handle, row.experience_version_id))
    .map(row => row.experience_version_id)
  if (currentActive.length === 0) {
    throw new ExperienceError('source_unresolvable', `${label} component does not map to a current active version`)
  }
  if (currentActive.length > 1) {
    throw new ExperienceError('invalid_command', `${label} component is ambiguous across current versions`)
  }
  const version = readVersion(handle, currentActive[0]!)
  const component = version.components.find(item => item.componentId === componentId)
  if (component === undefined) {
    throw new ExperienceError('source_unresolvable', `${label} component is absent from its current version`)
  }
  return {
    versionId: version.experienceVersionId,
    role: component.role,
    revisionId: String(component.componentRevisionId),
  }
}

function validateRelationEndpoint(
  handle: DatabaseSync,
  ref: import('../types.js').ExperienceRelationObjectRef,
): void {
  const table = ref.kind === 'experience' ? ['experience_series', 'experience_id']
    : ref.kind === 'version' ? ['experience_versions', 'experience_version_id']
      : ref.kind === 'component' ? ['experience_components', 'component_id']
        : ref.kind === 'evidence' ? ['evidence_statements', 'evidence_id']
          : ref.kind === 'usage' ? ['experience_usages', 'usage_id'] : null
  if (table !== null && handle.prepare(`SELECT 1 FROM ${table[0]} WHERE ${table[1]} = ?`).get(ref.id) === undefined) {
    throw new ExperienceError('source_unresolvable', `Relation ${ref.kind} endpoint does not exist`, { id: ref.id })
  }
}

function validateRelationKinds(input: DeclareExperienceRelationInput): void {
  const source = input.sourceObjectRef.kind
  const target = input.targetObjectRef.kind
  const allowed = (() => {
    switch (input.relationType) {
      case 'derived_from': return (source === 'version' || source === 'component') && target === 'episode'
      case 'evidence_for': return source === 'evidence' && (target === 'claim' || target === 'component')
      case 'contradicts': return (source === 'evidence' || source === 'version')
        && (target === 'claim' || target === 'version' || target === 'component')
      case 'applies_to': return source === 'version' && (target === 'scope' || target === 'entity')
      case 'requires': return (source === 'component' || source === 'version')
        && (target === 'condition' || target === 'version' || target === 'component')
      case 'precedes': return source === 'component' && target === 'component'
      case 'conflicts_with': return (source === 'version' || source === 'component')
        && (target === 'version' || target === 'component')
      case 'specializes': return source === 'experience' && target === 'experience'
      case 'composes_with': return (source === 'experience' || source === 'component')
        && (target === 'experience' || target === 'component')
      case 'supersedes': return source === 'version' && target === 'version'
      case 'invalidated_by': return (source === 'version' || source === 'component')
        && (target === 'evidence' || target === 'condition')
      case 'failed_under': return (source === 'version' || source === 'component')
        && (target === 'usage' || target === 'scope')
      case 'causal_candidate':
      case 'causally_influences': return (source === 'claim' || source === 'component')
        && (target === 'claim' || target === 'component')
    }
  })()
  if (!allowed) throw new ExperienceError('invalid_command', `${input.relationType} endpoint kinds are invalid`)
}

function validateCausalPromotionRelation(handle: DatabaseSync, input: DeclareExperienceRelationInput): void {
  const versionId = input.qualifiers.causalExperienceVersionId
  const assessmentId = input.qualifiers.assessmentId
  if (versionId === undefined || assessmentId === undefined) {
    throw new ExperienceError('required_field_missing', 'causally_influences requires causal Experience and assessment refs')
  }
  const version = handle.prepare(
    `SELECT s.kind, v.initial_assessment_id
       FROM experience_versions v JOIN experience_series s ON s.experience_id = v.experience_id
      WHERE v.experience_version_id = ?`,
  ).get(versionId) as { kind: string; initial_assessment_id: string } | undefined
  const assessment = handle.prepare(
    'SELECT grade, governance_state FROM evidence_assessments WHERE assessment_id = ? AND experience_version_id = ?',
  ).get(assessmentId, versionId) as { grade: string; governance_state: string } | undefined
  if (version?.kind !== 'causal' || version.initial_assessment_id !== assessmentId
    || assessment?.governance_state !== 'accepted'
    || evidenceGradeRank(assessment.grade as ExperienceCandidateDraft['evidenceGrade']) < 3) {
    throw new ExperienceError('invalid_command', 'causally_influences requires an accepted intervention-supported Causal Experience')
  }
}

function assertRelationGraph(handle: DatabaseSync, inserted: ExperienceRelationView): void {
  if (!['supersedes', 'specializes', 'requires', 'precedes'].includes(inserted.relationType)) return
  const rows = handle.prepare(
    `SELECT source_kind, source_id, target_kind, target_id FROM experience_relations
      WHERE relation_type = ? AND status = 'active'`,
  ).all(inserted.relationType) as Array<{
    source_kind: string; source_id: string; target_kind: string; target_id: string
  }>
  const outgoing = new Map<string, string[]>()
  for (const row of rows) {
    const from = `${row.source_kind}:${row.source_id}`
    const to = `${row.target_kind}:${row.target_id}`
    outgoing.set(from, [...(outgoing.get(from) ?? []), to])
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new ExperienceError('composition_cycle', `${inserted.relationType} relations must be acyclic`)
    if (visited.has(node)) return
    visiting.add(node)
    for (const target of outgoing.get(node) ?? []) visit(target)
    visiting.delete(node)
    visited.add(node)
  }
  for (const node of [...outgoing.keys()].sort()) visit(node)
}

function readRelation(handle: DatabaseSync, relationId: string): ExperienceRelationView {
  const row = handle.prepare(
    'SELECT relation_id, relation_type, status, payload_json FROM experience_relations WHERE relation_id = ?',
  ).get(relationId) as { relation_id: string; relation_type: string; status: string; payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'ExperienceRelation was not found')
  const value = parseObject(row.payload_json, 'ExperienceRelation')
  if (value.relationId !== row.relation_id || value.relationType !== row.relation_type || value.status !== row.status) {
    throw new ExperienceError('database_schema_invalid', 'ExperienceRelation durable identity is inconsistent')
  }
  return value as unknown as ExperienceRelationView
}

function listRelationsForObject(
  handle: DatabaseSync,
  ref: import('../types.js').ExperienceRelationObjectRef,
): ExperienceRelationView[] {
  const rows = handle.prepare(
    `SELECT relation_id FROM experience_relations
      WHERE (source_kind = ? AND source_id = ?) OR (target_kind = ? AND target_id = ?)
      ORDER BY created_at, relation_id`,
  ).all(ref.kind, ref.id, ref.kind, ref.id) as Array<{ relation_id: string }>
  return rows.map(row => readRelation(handle, row.relation_id))
}

function buildRelationMap(handle: DatabaseSync): RelationMapView {
  const rows = handle.prepare(
    'SELECT relation_id FROM experience_relations ORDER BY created_at, relation_id',
  ).all() as Array<{ relation_id: string }>
  const relations = rows.map(row => readRelation(handle, row.relation_id))
  const nodeMap = new Map<string, RelationMapView['nodes'][number]>()
  const edges = relations.map(relation => {
    for (const ref of [relation.sourceObjectRef, relation.targetObjectRef]) {
      nodeMap.set(`${ref.kind}:${ref.id}`, ref)
    }
    const causalStatus = relation.relationType === 'causal_candidate' ? 'candidate' as const
      : relation.relationType === 'causally_influences' ? 'supported' as const : 'not_causal' as const
    const qualifierGrade = relation.qualifiers.causalGrade
    const causalGrade = causalStatus === 'not_causal' || !isEvidenceGrade(qualifierGrade)
      ? null : qualifierGrade
    return {
      relationId: relation.relationId,
      relationType: relation.relationType,
      source: relation.sourceObjectRef,
      target: relation.targetObjectRef,
      status: relation.status,
      evidenceIds: relation.evidenceIds,
      causalGrade,
      causalStatus,
    }
  })
  const nodes = [...nodeMap.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
  const projection = { nodes, edges }
  return {
    projectionKey: 'experience-relation-map-v1',
    builderVersion: 'experience-relation-map-v1',
    generationDigest: digest(projection),
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    textFallback: edges.map(edge =>
      `${edge.source.kind}:${edge.source.id} --${edge.relationType}/${edge.status}--> ${edge.target.kind}:${edge.target.id}`),
  }
}

function infrastructureReadinessContract(): import('../types.js').InfrastructureReadinessContractView {
  return {
    contractId: 'graph-storage-readiness-v1',
    capabilityKey: 'graph_projection_or_database',
    currentStore: 'sqlite',
    requiredQueryClasses: ['adjacency', 'bounded_multi_hop', 'shared_dependency'],
    failureDefinitions: [
      'sustained_p95_latency_above_threshold',
      'query_not_expressible_without_duplicate_authority',
      'canonical_parity_or_rollback_not_proven',
    ],
    metricDefinitions: {
      p95_query_duration_ms: 'P95 over source-referenced production relation queries in the closed observation window.',
      stable_multi_hop_query_classes: 'Distinct multi-hop query classes with repeated non-test consumers.',
      canonical_parity: 'Exact relation-id and payload parity between SQLite and a rebuildable candidate projection.',
    },
    minimumObservationCoverage: 30,
    consistencyRequirements: ['canonical_relation_id_parity', 'no_second_writer', 'rebuild_from_sqlite'],
    migrationSafetyRequirements: ['rollback_readback', 'interrupted_rebuild_recovery', 'dual_read_comparison_before_cutover'],
    thresholdPolicy: { p95QueryDurationMs: 250, minimumStableMultiHopQueryClasses: 2 },
    requiredSignals: ['measured_query_bottleneck', 'stable_multi_hop_demand', 'rebuild_and_rollback_proven'],
    decisionRule: 'all_required_signals',
    approverPolicy: 'architecture_review',
    contractVersion: 1,
    createdAt: '2026-09-03T00:00:00.000Z',
  }
}

function planningEndpointMatches(
  ref: import('../types.js').ExperienceRelationObjectRef,
  versionIds: ReadonlySet<string>,
  componentIds: ReadonlySet<string>,
): boolean {
  return (ref.kind === 'version' && versionIds.has(ref.id))
    || (ref.kind === 'component' && componentIds.has(ref.id))
}

/** Resolve one `requires` target to an exact current-active, readable authoritative version. */
function resolveRequiredTarget(
  handle: DatabaseSync,
  target: ExperienceRelationObjectRef,
): { readonly resolved: true; readonly version: ExperienceVersionView }
  | { readonly resolved: false; readonly reasonCode: string; readonly message: string } {
  if (target.kind === 'version') {
    let version: ExperienceVersionView
    try {
      version = readVersion(handle, target.id)
    } catch {
      return { resolved: false, reasonCode: 'required_dependency_unreadable',
        message: 'Required Experience version cannot be read' }
    }
    if (!isCurrentActiveVersion(handle, target.id)) {
      return { resolved: false, reasonCode: 'required_dependency_forgotten_or_superseded',
        message: 'Required Experience version is no longer the active current version' }
    }
    return { resolved: true, version }
  }
  if (target.kind === 'component') {
    const rows = handle.prepare(
      `SELECT DISTINCT vc.experience_version_id
         FROM experience_version_components vc
         JOIN component_revisions cr ON cr.component_revision_id = vc.component_revision_id
        WHERE cr.component_id = ?`,
    ).all(target.id) as Array<{ experience_version_id: string }>
    const currentActive = rows
      .filter(row => isCurrentActiveVersion(handle, row.experience_version_id))
      .map(row => row.experience_version_id)
    if (currentActive.length === 0) {
      return { resolved: false, reasonCode: 'required_dependency_unresolvable',
        message: 'Required Experience component does not resolve to a current active version' }
    }
    if (currentActive.length > 1) {
      return { resolved: false, reasonCode: 'required_dependency_cross_version_ambiguity',
        message: 'Required Experience component resolves to multiple current active versions' }
    }
    try {
      return { resolved: true, version: readVersion(handle, currentActive[0]!) }
    } catch {
      return { resolved: false, reasonCode: 'required_dependency_unreadable',
        message: 'Required Experience component revision cannot be read' }
    }
  }
  return { resolved: false, reasonCode: 'required_dependency_unresolvable_endpoint',
    message: `Requires target kind ${target.kind} has no deterministic exact revision` }
}

function readOverride(handle: DatabaseSync, overrideDecisionId: string): OverrideDecisionView {
  const row = handle.prepare(
    'SELECT override_decision_id, payload_json FROM override_decisions WHERE override_decision_id = ?',
  ).get(overrideDecisionId) as { override_decision_id: string; payload_json: string } | undefined
  if (row === undefined) throw new ExperienceError('not_found', 'OverrideDecision was not found')
  const value = parseObject(row.payload_json, 'OverrideDecision')
  if (value.overrideDecisionId !== row.override_decision_id) {
    throw new ExperienceError('database_schema_invalid', 'OverrideDecision durable identity is inconsistent')
  }
  return value as unknown as OverrideDecisionView
}

function nonEmptyStringRecord(value: Readonly<Record<string, string>>, label: string): void {
  if (Object.keys(value).length === 0 || Object.values(value).some(item => item.trim() === '')) {
    throw new ExperienceError('required_field_missing', `${label} requires non-empty values`)
  }
}

function validInstant(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Date.parse(value))
}

function readReceipt(handle: DatabaseSync, receiptId: string): ExperienceDomainReceipt {
  const row = handle.prepare(
    `SELECT receipt_id, command_id, action, correlation_id, causation_id, issued_at,
            commit_sequence, payload_json, created_at
       FROM domain_receipts WHERE receipt_id = ?`,
  ).get(receiptId) as {
    receipt_id: string
    command_id: string
    action: string
    correlation_id: string
    causation_id: string | null
    issued_at: string
    commit_sequence: number
    payload_json: string
    created_at: string
  } | undefined
  if (row === undefined) throw new ExperienceError('not_found', `Receipt ${JSON.stringify(receiptId)} was not found`)
  const value = parseObject(row.payload_json, 'DomainReceipt')
  const workflow = isWorkflowReceiptAction(value.action)
  const m5 = isM5ReceiptAction(value.action)
  const forget = isForgetReceiptAction(value.action)
  const relation = isRelationReceiptAction(value.action)
  const learningGovernance = isLearningGovernanceReceiptAction(value.action)
  const markdown = isMarkdownReceiptAction(value.action)
  const evaluation = value.action === 'evaluation.observe'
  const infrastructure = value.action === 'infrastructure.evaluate'
  const suggestionSave = value.action === 'suggestion.save'
  if (suggestionSave && value.sourceSuggestionGroupIds === undefined
    && typeof value.suggestionGroupId === 'string') {
    value.sourceSuggestionGroupIds = [value.suggestionGroupId]
  }
  if (typeof value.receiptId !== 'string'
    || typeof value.commandId !== 'string'
    || (value.action !== 'diagnostic.publish' && !workflow && !m5 && !forget && !relation
      && !learningGovernance && !markdown && !evaluation && !infrastructure && !suggestionSave)
    || (!m5 && !forget && !relation && !learningGovernance && !markdown && !evaluation && !infrastructure
      && !suggestionSave
      && typeof value.candidateId !== 'string')
    || (workflow && (!Number.isSafeInteger(value.candidateRevision)
      || (value.experienceId !== null && typeof value.experienceId !== 'string')
      || (value.experienceVersionId !== null && typeof value.experienceVersionId !== 'string')))
    || (!workflow && !m5 && !forget && !relation && !learningGovernance && !markdown && !evaluation && !infrastructure
      && !suggestionSave
      && (typeof value.experienceId !== 'string' || typeof value.experienceVersionId !== 'string'))
    || (m5 && (value.usageId !== null && typeof value.usageId !== 'string'
      || (value.controllerRevision !== null && !Number.isSafeInteger(value.controllerRevision))
      || (value.revisionProposalId !== null && typeof value.revisionProposalId !== 'string')
      || !Number.isSafeInteger(value.objectRevision)
      || (value.experienceId !== null && typeof value.experienceId !== 'string')
      || (value.experienceVersionId !== null && typeof value.experienceVersionId !== 'string')))
    || (forget && (typeof value.forgetRequestId !== 'string'
      || typeof value.experienceId !== 'string'
      || !Number.isSafeInteger(value.seriesRevision)
      || (value.seriesRevision as number) < 2))
    || (relation && (typeof value.relationId !== 'string'
      || (value.overrideDecisionId !== null && typeof value.overrideDecisionId !== 'string')))
    || (learningGovernance && (typeof value.capability !== 'string'
      || !isLearningGovernanceCapability(value.capability)
      || (value.evaluationId !== null && typeof value.evaluationId !== 'string')
      || (value.decisionId !== null && typeof value.decisionId !== 'string')
      || !Number.isSafeInteger(value.policyRevision)))
    || (markdown && (typeof value.markdownProjectionReceiptId !== 'string'
      || typeof value.experienceId !== 'string'
      || typeof value.experienceVersionId !== 'string'
      || (value.revisionProposalId !== null && typeof value.revisionProposalId !== 'string')))
    || (evaluation && (typeof value.evaluationObservationId !== 'string'
      || typeof value.cohortId !== 'string'
      || (value.comparisonArm !== 'no_memory' && value.comparisonArm !== 'retrieval_only'
        && value.comparisonArm !== 'experience_map')))
    || (infrastructure && (typeof value.infrastructureEvaluationId !== 'string'
      || (value.decision !== 'not_ready' && value.decision !== 'ready_for_review')))
    || (suggestionSave && (typeof value.suggestionGroupId !== 'string' || value.suggestionGroupId.trim() === ''
      || !sha256Digest(value.kernelIdentity)
      || (value.outcome !== 'saved_new_experience' && value.outcome !== 'attached_as_evidence'
        && value.outcome !== 'already_recorded')
      || typeof value.experienceId !== 'string'
      || typeof value.experienceVersionId !== 'string'
      || !isStringArray(value.evidenceIds)
      || typeof value.assessmentId !== 'string'
      || !sha256Digest(value.reviewDigest)
      || !sha256Digest(value.sourceDigest)
      || !sha256Digest(value.suggestionRevisionDigest)
      || typeof value.inputDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.inputDigest)
      || typeof value.scopeDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.scopeDigest)
      || !isStringArray(value.sourceSuggestionGroupIds) || value.sourceSuggestionGroupIds.length === 0
      || (value.sourceSuggestionGroupIds as string[]).some(item => item.trim() === '')
      || new Set(value.sourceSuggestionGroupIds as string[]).size
        !== (value.sourceSuggestionGroupIds as string[]).length
      || !isStringArray(value.occurrenceIds) || value.occurrenceIds.length === 0
      || new Set(value.occurrenceIds as string[]).size !== (value.occurrenceIds as string[]).length
      || !isEpisodeRefs(value.sourceEpisodeRefs)
      || !isSourceRefs(value.sourceRefs)
      || typeof value.expiresAt !== 'string' || !validInstant(value.expiresAt)))
    || typeof value.correlationId !== 'string'
    || (value.causationId !== null && typeof value.causationId !== 'string')
    || typeof value.issuedAt !== 'string'
    || !Number.isSafeInteger(value.commitSequence)
    || typeof value.createdAt !== 'string'
    || !isActor(value.actor)
    || value.receiptId !== row.receipt_id
    || value.commandId !== row.command_id
    || value.action !== row.action
    || value.correlationId !== row.correlation_id
    || value.causationId !== row.causation_id
    || value.issuedAt !== row.issued_at
    || value.commitSequence !== row.commit_sequence
    || value.createdAt !== row.created_at) {
    throw new ExperienceError('database_schema_invalid', 'DomainReceipt durable JSON is invalid')
  }
  return value as unknown as ExperienceDomainReceipt
}

function readVersion(handle: DatabaseSync, versionId: string): ExperienceVersionView {
  const row = handle.prepare(
    `SELECT experience_version_id, experience_id, version_number, previous_version_id, title, intent, privacy_class,
            evidence_grade, initial_assessment_id, created_by_decision_id,
            content_digest, payload_json, created_at
       FROM experience_versions WHERE experience_version_id = ?`,
  ).get(versionId) as {
    experience_version_id: string
    experience_id: string
    version_number: number
    previous_version_id: string | null
    title: string
    intent: string
    privacy_class: string
    evidence_grade: string
    initial_assessment_id: string
    created_by_decision_id: string
    content_digest: string
    payload_json: string
    created_at: string
  } | undefined
  if (row === undefined) throw new ExperienceError('not_found', `ExperienceVersion ${JSON.stringify(versionId)} was not found`)
  const value = parseObject(row.payload_json, 'ExperienceVersion')
  if (typeof value.experienceVersionId !== 'string'
    || typeof value.experienceId !== 'string'
    || !Number.isSafeInteger(value.versionNumber)
    || (value.versionNumber as number) < 1
    || (value.previousVersionId !== null && typeof value.previousVersionId !== 'string')
    || !isExperienceKind(value.kind)
    || typeof value.title !== 'string'
    || typeof value.intent !== 'string'
    || !isStringRecord(value.scope)
    || !isStringRecord(value.validity)
    || !isStringRecord(value.authoritySpec)
    || !isStringRecord(value.riskAndEffectSpec)
    || !isPrivacyClass(value.privacyClass)
    || !isAllowedUseModes(value.allowedUseModes)
    || (value.contentDigestSchema === 'v2-source-bound'
      && (!isEpisodeRefs(value.sourceEpisodeRefs) || !isSourceRefs(value.sourceRefs)))
    || (value.contentDigestSchema !== undefined && value.contentDigestSchema !== 'v2-source-bound')
    || !isPublishedComponentsForKind(value.components, value.kind)
    || !isStringArray(value.componentRevisionIds)
    || typeof value.initialAssessmentId !== 'string'
    || !isStringArray(value.relationIds)
    || typeof value.createdByDecisionId !== 'string'
    || !isEvidenceGrade(value.evidenceGrade)
    || value.governanceState !== 'accepted'
    || (value.operationalState !== 'active' && value.operationalState !== 'conditional')
    || !isStringArray(value.legacyWarnings)
    || (value.operationalState === 'active' && !value.legacyWarnings.includes('pre_v3_active_state_unverified'))
    || typeof value.contentDigest !== 'string'
    || typeof value.createdAt !== 'string'
    || value.experienceVersionId !== row.experience_version_id
    || value.experienceId !== row.experience_id
    || value.versionNumber !== row.version_number
    || value.previousVersionId !== row.previous_version_id
    || value.title !== row.title
    || value.intent !== row.intent
    || value.privacyClass !== row.privacy_class
    || value.evidenceGrade !== row.evidence_grade
    || value.initialAssessmentId !== row.initial_assessment_id
    || value.createdByDecisionId !== row.created_by_decision_id
    || value.contentDigest !== row.content_digest
    || value.createdAt !== row.created_at) {
    throw new ExperienceError('database_schema_invalid', 'ExperienceVersion durable JSON is invalid')
  }
  assertStoredVersionConsistency(handle, versionId)
  const relationIds = relationIdsForVersion(handle, versionId)
  return { ...(value as unknown as ExperienceVersionView), relationIds }
}

function relationIdsForVersion(handle: DatabaseSync, versionId: string): string[] {
  const rows = handle.prepare(
    `SELECT DISTINCT r.relation_id
       FROM experience_relations r
       LEFT JOIN experience_components c_source
         ON r.source_kind = 'component' AND r.source_id = c_source.component_id
       LEFT JOIN experience_version_components vc_source
         ON c_source.current_revision_id = vc_source.component_revision_id
       LEFT JOIN experience_components c_target
         ON r.target_kind = 'component' AND r.target_id = c_target.component_id
       LEFT JOIN experience_version_components vc_target
         ON c_target.current_revision_id = vc_target.component_revision_id
      WHERE (r.source_kind = 'version' AND r.source_id = ?)
         OR (r.target_kind = 'version' AND r.target_id = ?)
         OR vc_source.experience_version_id = ?
         OR vc_target.experience_version_id = ?
      ORDER BY r.relation_id`,
  ).all(versionId, versionId, versionId, versionId) as Array<{ relation_id: string }>
  return rows.map(row => row.relation_id)
}

function parseObject(json: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch (error) {
    throw new ExperienceError('database_schema_invalid', `${label} durable JSON is invalid`, {}, { cause: error })
  }
  throw new ExperienceError('database_schema_invalid', `${label} durable JSON is not an object`)
}

function validateStoredCandidateSemantics(candidate: CandidateWorkflowRecord): void {
  const componentCount = candidate.draft.components.length
  if (candidate.componentIds.length !== componentCount
    || candidate.componentRevisionIds.length !== componentCount
    || candidate.evidenceIds.length !== componentCount
    || !unique(candidate.componentIds)
    || !unique(candidate.componentRevisionIds)
    || !unique(candidate.evidenceIds)) {
    throw new Error('Candidate allocation does not match its components')
  }
  const published = candidate.state === 'published'
  if (published !== (candidate.publishedVersionId !== null)) {
    throw new Error('Candidate publication state does not match its Version reference')
  }
  const disposed = candidate.state === 'rejected' || candidate.state === 'withdrawn'
  if (disposed !== (candidate.dispositionReason !== null)) {
    throw new Error('Candidate disposition reason does not match its state')
  }
  const fields = new Set(workflowFields(candidate).map(([field]) => field))
  const decisionIds = candidate.decisions.map(decision => decision.decisionId)
  if (!unique(decisionIds)
    || candidate.decisions.some(decision => !fields.has(decision.field))
    || !validDecisionChain(candidate.decisions)) {
    throw new Error('Candidate decisions have duplicate IDs, invalid supersession, or address an unknown field')
  }
  if (candidate.state === 'proposed' && candidate.decisions.length > 0) {
    throw new Error('A proposed Candidate cannot already have field decisions')
  }
  validateWorkflowDraft(
    candidate.draft,
    candidate.sourceEpisodeRefs,
    candidate.sourceRefs,
    Number.MAX_SAFE_INTEGER,
  )
  if (candidate.state === 'accepted' || candidate.state === 'published') {
    const current = currentWorkflowDecisions(candidate)
    if (current.size !== fields.size
      || [...current.values()].some(decision => decision.decision === 'reject')) {
      throw new Error('An accepted Candidate requires one affirmative decision for every field')
    }
    validateWorkflowDraft(
      resolveWorkflowDraft(candidate),
      candidate.sourceEpisodeRefs,
      candidate.sourceRefs,
      Number.MAX_SAFE_INTEGER,
    )
  }
}

function validDecisionChain(decisions: readonly CandidateWorkflowRecord['decisions'][number][]): boolean {
  const byId = new Map(decisions.map(decision => [decision.decisionId, decision]))
  const latestByField = new Map<string, string>()
  for (const decision of decisions) {
    const expectedPredecessor = latestByField.get(decision.field) ?? null
    if (decision.supersedesDecisionId !== expectedPredecessor) return false
    if (decision.supersedesDecisionId !== null) {
      const predecessor = byId.get(decision.supersedesDecisionId)
      if (predecessor === undefined || predecessor.field !== decision.field) return false
    }
    latestByField.set(decision.field, decision.decisionId)
  }
  return true
}

function isCandidateProposalMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.generator === 'model'
    && nonEmptyString(value.proposalSessionId)
    && nonEmptyString(value.provider)
    && nonEmptyString(value.model)
    && nonEmptyString(value.promptVersion)
    && nonEmptyString(value.schemaVersion)
    && nonEmptyString(value.policyVersion)
    && nonEmptyString(value.sourceInputDigest)
    && nonEmptyString(value.disclosureDigest)
    && nonEmptyString(value.outputDigest)
    && nonEmptyString(value.proposedAt)
}

function isExperienceCandidateDraft(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isExperienceKind(value.proposedKind)
    && typeof value.title === 'string'
    && typeof value.intent === 'string'
    && isStringRecord(value.scope)
    && isStringRecord(value.validity)
    && isStringRecord(value.authoritySpec)
    && isPrivacyClass(value.privacyClass)
    && isStringRecord(value.riskAndEffectSpec)
    && isAllowedUseModes(value.allowedUseModes)
    && isCandidateComponents(value.components, value.proposedKind)
    && isEvidenceGrade(value.evidenceGrade)
    && isStringArrayRecord(value.fieldSourceRefs)
    && isExcludedSteps(value.excludedSteps)
    && isStringArray(value.missingEvidence)
    && isStringArray(value.unresolvedFields)
}

function isCandidateComponents(value: unknown, kind: import('../domain/kind.js').ExperienceKind): boolean {
  const roles = new Set<import('../types.js').ComponentRole>([
    ...TYPE_BEHAVIORS[kind].requiredRoles,
    ...(kind === 'preference_policy'
      ? ['positive_example', 'negative_example', 'exception', 'no_known_exception'] as const
      : []),
  ])
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && nonEmptyString(item.componentKey)
    && typeof item.role === 'string'
    && roles.has(item.role as import('../types.js').ComponentRole)
    && typeof item.content === 'string'
    && isStringArray(item.sourceRefs))
}

function isExcludedSteps(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item)
    && typeof item.summary === 'string'
    && typeof item.reason === 'string'
    && isStringArray(item.sourceRefs))
}

function isCandidateDecisions(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!isRecord(item)
      || !nonEmptyString(item.field)
      || (item.decision !== 'accept' && item.decision !== 'reject' && item.decision !== 'edit')
      || !nonEmptyString(item.reason)
      || !nonEmptyString(item.decisionId)
      || !nonEmptyString(item.actorId)
      || !nonEmptyString(item.decidedAt)
      || (item.effectiveSourceRefs !== undefined && !isStringArray(item.effectiveSourceRefs))
      || (item.supersedesDecisionId !== null && !nonEmptyString(item.supersedesDecisionId))) return false
    return item.decision === 'edit'
      ? Object.hasOwn(item, 'value') && isStringArray(item.effectiveSourceRefs)
      : !Object.hasOwn(item, 'value') && item.effectiveSourceRefs === undefined
  })
}

function isCandidateState(value: unknown): boolean {
  return value === 'proposed' || value === 'in_review' || value === 'accepted'
    || value === 'published' || value === 'rejected' || value === 'withdrawn'
}

function isExtractionTrigger(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isTriggerKind(value.triggerKind)
    && isStringArray(value.sourceRefIds)
    && (value.eligibilityStatus === 'eligible' || value.eligibilityStatus === 'candidate_only' || value.eligibilityStatus === 'ineligible')
    && isStringArray(value.eligibilityReasons)
    && (value.detectedBy === 'criterion_manifest' || value.detectedBy === 'user_request'
      || value.detectedBy === 'experience_policy' || value.detectedBy === 'migration')
    && nonEmptyString(value.detectorVersion)
    && nonEmptyString(value.detectedAt)
}

function isOutcomeAssessment(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (value.outcome === 'success' || value.outcome === 'partial' || value.outcome === 'failure'
      || value.outcome === 'unknown' || value.outcome === 'aborted')
    && (value.method === 'criterion_manifest' || value.method === 'none')
    && nonEmptyString(value.policyVersion)
    && (value.manifestDigest === null || nonEmptyString(value.manifestDigest))
    && nonEmptyString(value.assessedAt)
    && Array.isArray(value.criteria)
    && value.criteria.every(criterion => isRecord(criterion)
      && nonEmptyString(criterion.criterionId)
      && typeof criterion.mandatory === 'boolean'
      && (criterion.result === 'pass' || criterion.result === 'fail' || criterion.result === 'unknown')
      && isStringArray(criterion.evidenceRefIds))
}

function isTriggerKind(value: unknown): boolean {
  return value === 'terminal_success' || value === 'high_cost_resolution' || value === 'repeated_kernel'
    || value === 'user_correction' || value === 'diagnostic_exclusion'
    || value === 'environment_invalidation' || value === 'outcome_unknown'
}

function isStringArrayRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isStringArray)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function isActor(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actor = value as Record<string, unknown>
  return typeof actor.actorId === 'string'
    && typeof actor.principalId === 'string'
    && (actor.kind === 'browser_local_owner'
      || actor.kind === 'management_local_owner'
      || actor.kind === 'agent'
      || actor.kind === 'model'
      || actor.kind === 'system_policy'
      || actor.kind === 'automation')
    && (actor.authority === 'owner' || actor.authority === 'query_only')
}

function isStringRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string')
}

function isPrivacyClass(value: unknown): boolean {
  return value === 'public' || value === 'workspace' || value === 'restricted' || value === 'secret_reference_only'
}

function isAllowedUseModes(value: unknown): boolean {
  return Array.isArray(value) && value.every(item =>
    item === 'reference' || item === 'suggest' || item === 'guided' || item === 'guarded_execute')
}

function isEvidenceGrade(value: unknown): value is ExperienceCandidateDraft['evidenceGrade'] {
  return value === 'model_asserted'
    || value === 'observation_supported'
    || value === 'mechanism_supported'
    || value === 'intervention_supported'
    || value === 'counterfactual_supported'
}

function isPublishedComponentsForKind(
  value: unknown,
  kind: import('../domain/kind.js').ExperienceKind,
): boolean {
  const roles = new Set<import('../types.js').ComponentRole>([
    ...TYPE_BEHAVIORS[kind].requiredRoles,
    ...(kind === 'preference_policy'
      ? ['positive_example', 'negative_example', 'exception', 'no_known_exception'] as const
      : []),
  ])
  return Array.isArray(value) && value.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const component = item as Record<string, unknown>
    return typeof component.componentKey === 'string'
      && typeof component.role === 'string'
      && roles.has(component.role as import('../types.js').ComponentRole)
      && typeof component.content === 'string'
      && Array.isArray(component.sourceRefs)
      && component.sourceRefs.every(ref => typeof ref === 'string')
      && typeof component.componentId === 'string'
      && typeof component.componentRevisionId === 'string'
      && isStringArray(component.evidenceIds)
  })
}

function isWorkflowReceiptAction(value: unknown): value is CandidateWorkflowAction {
  return value === 'candidate.propose'
    || value === 'candidate.submit'
    || value === 'candidate.field_decide'
    || value === 'candidate.accept'
    || value === 'candidate.reject'
    || value === 'candidate.withdraw'
    || value === 'candidate.publish'
}

function isM5ReceiptAction(value: unknown): value is M5ReceiptAction {
  return value === 'usage.progress' || value === 'usage.verify' || value === 'usage.settle'
    || value === 'revision.propose' || value === 'revision.change_decide' || value === 'revision.publish'
}

function isForgetReceiptAction(value: unknown): value is ForgetDomainReceipt['action'] {
  return value === 'experience.forget'
}

function isRelationReceiptAction(value: unknown): value is RelationDomainReceipt['action'] {
  return value === 'relation.declare' || value === 'override.create'
}

function isLearningGovernanceReceiptAction(value: unknown): value is LearningGovernanceReceipt['action'] {
  return value === 'learning.evaluate' || value === 'automation.promote' || value === 'automation.demote'
    || value === 'history_ranking.review'
}

function isMarkdownReceiptAction(value: unknown): value is MarkdownDomainReceipt['action'] {
  return value === 'markdown.export' || value === 'markdown.revision_propose'
}

function validateEvaluationObservation(
  handle: DatabaseSync,
  observation: RecordEvaluationObservationInput['observation'],
): void {
  for (const [label, value] of [
    ['cohortId', observation.cohortId],
    ['taskCaseId', observation.taskCaseId],
    ['taskFamilyId', observation.taskFamilyId],
    ['modelVersion', observation.modelVersion],
    ['toolsetVersion', observation.toolsetVersion],
    ['verifierVersion', observation.verifierVersion],
    ['taskCorpusVersion', observation.taskCorpusVersion],
    ['routeSignature', observation.routeSignature],
  ] as const) {
    if (value.trim() === '') throw new ExperienceError('required_field_missing', `${label} must not be empty`)
  }
  if (observation.split !== 'test'
    || !validInstant(observation.taskOccurredAt)
    || !validInstant(observation.trainingWindowEndsAt)
    || Date.parse(observation.trainingWindowEndsAt) >= Date.parse(observation.taskOccurredAt)) {
    throw new ExperienceError('invalid_command', 'Evaluation requires a test task strictly after the training window')
  }
  for (const [label, value] of [
    ['contextBudget', observation.contextBudget],
    ['elapsedMs', observation.elapsedMs],
    ['modelRoundCount', observation.modelRoundCount],
    ['toolCallCount', observation.toolCallCount],
    ['inputTokens', observation.inputTokens],
    ['outputTokens', observation.outputTokens],
    ['humanActionCount', observation.humanActionCount],
    ['repeatedExplorationCount', observation.repeatedExplorationCount],
    ['erroneousSideEffectCount', observation.erroneousSideEffectCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ExperienceError('invalid_command', `${label} must be a non-negative safe integer`)
    }
  }
  if (!Number.isFinite(observation.explanationCoverage)
    || observation.explanationCoverage < 0 || observation.explanationCoverage > 1) {
    throw new ExperienceError('invalid_command', 'explanationCoverage must be from zero through one')
  }
  for (const [label, refs] of [
    ['acceptanceResultRefs', observation.acceptanceResultRefs],
    ['decisionAnchorRefs', observation.decisionAnchorRefs],
    ['metricSourceRefs', observation.metricSourceRefs],
    ['trainingEpisodeRefs', observation.trainingEpisodeRefs],
  ] as const) {
    if (refs.some(ref => ref.trim() === '') || new Set(refs).size !== refs.length) {
      throw new ExperienceError('invalid_command', `${label} must contain unique non-empty refs`)
    }
  }
  if (observation.acceptanceResultRefs.length === 0 || observation.metricSourceRefs.length === 0) {
    throw new ExperienceError('required_field_missing', 'Evaluation observations require acceptance and metric source refs')
  }
  const evaluationRefs = new Set([...observation.acceptanceResultRefs, ...observation.metricSourceRefs])
  if (observation.trainingEpisodeRefs.some(ref => evaluationRefs.has(ref))) {
    throw new ExperienceError('invalid_command', 'Training Episode refs must not appear in test metric sources')
  }
  if (observation.comparisonArm === 'no_memory') {
    if (observation.executionEvidence !== undefined) {
      throw new ExperienceError('invalid_command', 'no_memory observations must not carry Experience execution evidence')
    }
    if (observation.taskFingerprintId !== null || observation.usageId !== null || observation.settlementId !== null
      || observation.retrievalResult !== 'not_applicable' || observation.applicabilityDecision !== 'not_applicable') {
      throw new ExperienceError('invalid_command', 'no_memory observations must not contain Experience identities or retrieval decisions')
    }
    return
  }
  if (observation.comparisonArm === 'retrieval_only') {
    if (observation.executionEvidence !== undefined) {
      throw new ExperienceError('invalid_command', 'retrieval_only observations must not carry Experience execution evidence')
    }
    if (observation.taskFingerprintId !== null || observation.usageId !== null || observation.settlementId !== null
      || observation.retrievalResult === 'not_applicable' || observation.applicabilityDecision !== 'not_applicable') {
      throw new ExperienceError('invalid_command', 'retrieval_only observations expose retrieval outcome but no Experience planning identity')
    }
    return
  }
  if (observation.taskFingerprintId === null || observation.usageId === null
    || observation.retrievalResult === 'not_applicable' || observation.applicabilityDecision === 'not_applicable') {
    throw new ExperienceError('required_field_missing', 'experience_map observations require exact planning and settlement identities')
  }
  if (observation.executionEvidence !== undefined && observation.executionEvidence.kind === 'not_used') {
    validateNotUsedEvaluation(handle, observation, observation.executionEvidence)
    return
  }
  if (observation.settlementId === null) {
    throw new ExperienceError('required_field_missing', 'experience_map observations require a Settlement unless executionEvidence declares not_used')
  }
  const planning = readPlanningResult(handle, String(observation.usageId))
  const settlement = readSettlement(handle, String(observation.usageId))
  if (planning.fingerprint.fingerprintId !== observation.taskFingerprintId
    || settlement?.settlementId !== observation.settlementId) {
    throw new ExperienceError('source_unresolvable', 'Evaluation planning or Settlement identities do not match')
  }
  validateEvaluationPlanningClaims(planning, observation)
  const canonicalOutcome = settlement.outcome === 'success' ? 'success'
    : settlement.outcome === 'unknown' ? 'unknown' : 'failure'
  if (canonicalOutcome !== observation.outcome) {
    throw new ExperienceError('invalid_command', 'Evaluation outcome does not match the canonical Settlement')
  }
}

/**
 * Bind a genuinely-not-used experience_map sample to an exact UsagePlan and a terminal,
 * never-entered Experience Admission. Every identity is re-read from the current SQLite
 * authoritative data (never trusted as a bare non-empty string); the reason is checked against
 * the terminal Admission state that a real producer actually reaches; and the whole Usage is
 * re-checked to be free of any settlement, Context delivery, execution progress or entered
 * admission (a later entry can never masquerade as a final not-used).
 */
function validateNotUsedEvaluation(
  handle: DatabaseSync,
  observation: RecordEvaluationObservationInput['observation'],
  evidence: Extract<EvaluationExecutionEvidence, { kind: 'not_used' }>,
): void {
  if (observation.settlementId !== null) {
    throw new ExperienceError('invalid_command', 'not_used evidence requires a null settlementId, not a fabricated Settlement')
  }
  const usageId = String(observation.usageId!)
  const planning = readPlanningResult(handle, usageId)
  if (planning.plan.usagePlanId !== evidence.usagePlanId
    || planning.plan.contentDigest !== evidence.planDigest
    || planning.fingerprint.fingerprintId !== observation.taskFingerprintId
    || planning.plan.fingerprintId !== observation.taskFingerprintId) {
    throw new ExperienceError('source_unresolvable', 'not_used Execution identities do not match the current Plan')
  }
  validateEvaluationPlanningClaims(planning, observation)
  const attempts = readAdmissionAttempts(handle, usageId)
  const cited = attempts.find(attempt => attempt.admissionAttemptId === evidence.admissionAttemptId)
  if (cited === undefined) {
    throw new ExperienceError('source_unresolvable', 'not_used Admission was not found for this Usage')
  }
  if (attempts[attempts.length - 1]!.admissionAttemptId !== cited.admissionAttemptId) {
    throw new ExperienceError('invalid_command', 'a later Admission supersedes the cited not_used attempt; the Usage was not finally unused')
  }
  if (readSettlement(handle, usageId) !== null
    || readLatestProgress(handle, usageId) !== null
    || usageHasContext(handle, usageId)
    || attempts.some(attempt => attempt.state === 'entered' || attempt.state === 'ready_to_enter')) {
    throw new ExperienceError('invalid_command', 'the Usage was delivered, executed or settled; it cannot be recorded as not_used')
  }
  assertTerminalNotUsedReason(planning.plan.disposition, cited, evidence.reason)
}

/** Reject evaluation labels that contradict facts already owned by the exact PlanningResult. */
function validateEvaluationPlanningClaims(
  planning: PlanningResultView,
  observation: RecordEvaluationObservationInput['observation'],
): void {
  // `noMatch` means no component survived eligibility; it does not mean the retriever returned
  // no candidates. Rejected candidates are still real retrievals and may be labelled irrelevant
  // by the external evaluator. Applicability is likewise an observed evaluation label rather
  // than a second canonical Admission state, so exact Admission/Settlement checks stay below.
  const retrieved = planning.matchSet.candidates.length > 0
  const reportsNoRetrieval = observation.retrievalResult === 'none'
  if ((retrieved && reportsNoRetrieval) || (!retrieved && !reportsNoRetrieval)) {
    throw new ExperienceError('invalid_command', 'Evaluation retrieval result contradicts the canonical MatchSet')
  }
}

/** Confirm the evidence reason is consistent with a terminal state a real producer reaches. */
function assertTerminalNotUsedReason(
  disposition: UsagePlanView['disposition'],
  attempt: AdmissionAttemptView,
  reason: Extract<EvaluationExecutionEvidence, { kind: 'not_used' }>['reason'],
): void {
  const state = attempt.state
  const notUsedStates = new Set(['denied', 'no_answerer_continue', 'not_required', 'rejected', 'interrupted'])
  if (!notUsedStates.has(state)) {
    throw new ExperienceError('invalid_command', `Admission state ${state} cannot be recorded as not_used`)
  }
  if (reason === 'no_match') {
    const valid = disposition === 'no_match'
      && (state === 'no_answerer_continue' || state === 'not_required')
    if (!valid) throw new ExperienceError('invalid_command', 'not_used reason no_match is inconsistent with the terminal Admission')
    return
  }
  if (reason === 'refused') {
    if (disposition !== 'ready_for_approval' || state !== 'denied') {
      throw new ExperienceError('invalid_command', 'not_used reason refused is inconsistent with the terminal Admission')
    }
    return
  }
  // reason === 'not_used': a plan was formed but Experience was never used. A default no-match
  // affordance is not the same as the planned-but-unused path, and admitted-but-never-claimed is
  // deliberately excluded (the reviewer labels approved/pending/ready_to_enter as unusable).
  const valid = disposition !== 'no_match'
    && (state === 'no_answerer_continue' || state === 'not_required' || state === 'rejected' || state === 'interrupted')
  if (!valid) throw new ExperienceError('invalid_command', 'not_used reason not_used is inconsistent with the terminal Admission')
}

/** True when the Usage has ever materialized a ContextSnapshot (i.e. it was delivered). */
function usageHasContext(handle: DatabaseSync, usageId: string): boolean {
  const row = handle.prepare(
    'SELECT 1 AS present FROM context_snapshots WHERE usage_id = ? LIMIT 1',
  ).get(usageId)
  return row !== undefined
}


function buildEvaluationReport(handle: DatabaseSync, cohortId: string): EvaluationReportView {
  const rows = handle.prepare(
    `SELECT payload_json FROM evaluation_observations
      WHERE cohort_id = ? ORDER BY comparison_arm, task_case_id`,
  ).all(cohortId) as Array<{ payload_json: string }>
  const observations = rows.map(row =>
    parsePlanningObject<EvaluationObservationView>(row.payload_json, 'EvaluationObservation'))
  if (observations.length === 0) throw new ExperienceError('not_found', 'Evaluation cohort was not found')
  const blockers = new Set<string>()
  const arms: readonly EvaluationComparisonArm[] = ['no_memory', 'retrieval_only', 'experience_map']
  const expectedConfig = evaluationConfigurationKey(observations[0]!)
  if (observations.some(item => evaluationConfigurationKey(item) !== expectedConfig)) blockers.add('configuration_mismatch')
  const taskSets = arms.map(arm => new Set(observations.filter(item => item.comparisonArm === arm).map(item => item.taskCaseId)))
  const allTaskIds = [...new Set(observations.map(item => item.taskCaseId))].sort()
  for (const arm of arms) {
    if (!observations.some(item => item.comparisonArm === arm)) blockers.add(`missing_arm:${arm}`)
  }
  for (const taskCaseId of allTaskIds) {
    if (arms.some((_, index) => !taskSets[index]!.has(taskCaseId))) blockers.add(`incomplete_task:${taskCaseId}`)
  }
  if (observations.some(item => Date.parse(item.trainingWindowEndsAt) >= Date.parse(item.taskOccurredAt))) {
    blockers.add('time_split_violation')
  }
  return {
    cohortId,
    comparable: blockers.size === 0,
    blockers: [...blockers].sort(),
    taskCaseIds: allTaskIds,
    arms: arms.map(arm => buildArmReport(arm, observations.filter(item => item.comparisonArm === arm))),
    generatedAt: new Date().toISOString(),
  }
}

function evaluationConfigurationKey(observation: EvaluationObservationView): string {
  return canonicalJson({
    modelVersion: observation.modelVersion,
    toolsetVersion: observation.toolsetVersion,
    contextBudget: observation.contextBudget,
    verifierVersion: observation.verifierVersion,
    taskCorpusVersion: observation.taskCorpusVersion,
    trainingWindowEndsAt: observation.trainingWindowEndsAt,
    trainingEpisodeRefs: [...observation.trainingEpisodeRefs].sort(),
  })
}

function buildArmReport(
  comparisonArm: EvaluationComparisonArm,
  observations: readonly EvaluationObservationView[],
): EvaluationArmReportView {
  const successCount = observations.filter(item => item.outcome === 'success').length
  const failureCount = observations.filter(item => item.outcome === 'failure').length
  const knownCount = successCount + failureCount
  const families = new Map<string, EvaluationObservationView[]>()
  for (const item of observations) families.set(item.taskFamilyId, [...(families.get(item.taskFamilyId) ?? []), item])
  const repeatedFamilies = [...families.values()].filter(items => items.length > 1)
  const stable = repeatedFamilies.flatMap(items => {
    const counts = new Map<string, number>()
    for (const item of items) counts.set(item.routeSignature, (counts.get(item.routeSignature) ?? 0) + 1)
    return [Math.max(...counts.values()) / items.length]
  })
  return {
    comparisonArm,
    sampleCount: observations.length,
    successCount,
    failureCount,
    unknownCount: observations.length - knownCount,
    successRate: observations.length === 0 ? null : successCount / observations.length,
    successRateWilson95: observations.length === 0 ? null : wilson95(successCount, observations.length),
    resolvedSuccessRate: knownCount === 0 ? null : successCount / knownCount,
    resolvedSuccessRateWilson95: knownCount === 0 ? null : wilson95(successCount, knownCount),
    unknownRate: observations.length === 0 ? null
      : (observations.length - knownCount) / observations.length,
    averageElapsedMs: average(observations.map(item => item.elapsedMs)),
    averageModelRounds: average(observations.map(item => item.modelRoundCount)),
    averageToolCalls: average(observations.map(item => item.toolCallCount)),
    averageInputTokens: average(observations.map(item => item.inputTokens)),
    averageOutputTokens: average(observations.map(item => item.outputTokens)),
    averageHumanActions: average(observations.map(item => item.humanActionCount)),
    averageRepeatedExploration: average(observations.map(item => item.repeatedExplorationCount)),
    routeStabilityRate: average(stable),
    erroneousSideEffectRate: observations.length === 0 ? null
      : observations.filter(item => item.erroneousSideEffectCount > 0).length / observations.length,
    erroneousReuseRate: observations.length === 0 ? null
      : observations.filter(item => item.erroneousReuse).length / observations.length,
    pollutionIncidentRate: observations.length === 0 ? null
      : observations.filter(item => item.pollutionIncident).length / observations.length,
    averageExplanationCoverage: average(observations.map(item => item.explanationCoverage)),
  }
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function wilson95(successes: number, total: number): readonly [number, number] {
  const z = 1.959963984540054
  const proportion = successes / total
  const denominator = 1 + z * z / total
  const center = (proportion + z * z / (2 * total)) / denominator
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z * z / (4 * total)) / total) / denominator
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

function isSqliteConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
    return true
  }
  // node:sqlite surfaces constraint violations as ERR_SQLITE_ERROR with a numeric `errcode`.
  // Every SQLITE_CONSTRAINT_* extended code shares the primary result code SQLITE_CONSTRAINT (19)
  // in its low byte (e.g. UNIQUE = 2067, PRIMARYKEY = 1555, NOTNULL = 1299, CHECK = 275,
  // FOREIGNKEY = 787, TRIGGER = 1811), so a low byte of 19 identifies a real constraint failure
  // and never an arbitrary SQLite error.
  return 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 0xff) === 19
}

interface AuditObjectRow {
  readonly objectKind: string
  readonly objectId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly recordedAt: string
}

const AUDIT_OBJECT_QUERIES = [
  ['candidate', 'SELECT candidate_id AS object_id, payload_json, created_at AS recorded_at FROM candidates'],
  ['candidate_field_decision', `SELECT decision_id AS object_id,
    json_object('decisionId', decision_id, 'candidateId', candidate_id, 'field', field_name,
      'decision', decision, 'actorId', actor_id, 'reason', reason,
      'decidedAt', decided_at, 'supersedesDecisionId', supersedes_decision_id) AS payload_json,
    decided_at AS recorded_at FROM candidate_field_decisions`],
  ['experience', `SELECT experience_id AS object_id,
    json_object('experienceId', experience_id, 'kind', kind, 'currentVersionId', current_version_id,
      'seriesRevision', series_revision, 'lifecycleProjection', lifecycle_projection, 'createdAt', created_at) AS payload_json,
    created_at AS recorded_at FROM experience_series`],
  ['version', 'SELECT experience_version_id AS object_id, payload_json, created_at AS recorded_at FROM experience_versions'],
  ['relation', 'SELECT relation_id AS object_id, payload_json, created_at AS recorded_at FROM experience_relations'],
  ['override', 'SELECT override_decision_id AS object_id, payload_json, created_at AS recorded_at FROM override_decisions'],
  ['receipt', 'SELECT receipt_id AS object_id, payload_json, created_at AS recorded_at FROM domain_receipts'],
  ['match_set', 'SELECT match_set_id AS object_id, payload_json, created_at AS recorded_at FROM match_sets'],
  ['preflight', 'SELECT preflight_id AS object_id, payload_json, created_at AS recorded_at FROM preflight_records'],
  ['usage_plan', 'SELECT usage_plan_id AS object_id, payload_json, created_at AS recorded_at FROM usage_plans'],
  ['approval_request', 'SELECT request_id AS object_id, payload_json, created_at AS recorded_at FROM plan_approval_requests'],
  ['governance_decision', 'SELECT decision_id AS object_id, payload_json, created_at AS recorded_at FROM governance_decisions'],
  ['usage', 'SELECT usage_id AS object_id, payload_json, created_at AS recorded_at FROM experience_usages'],
  ['context_snapshot', 'SELECT context_snapshot_id AS object_id, payload_json, created_at AS recorded_at FROM context_snapshots'],
  ['context_delivery', 'SELECT context_delivery_id AS object_id, payload_json, created_at AS recorded_at FROM context_deliveries'],
  ['context_retirement', 'SELECT context_retirement_id AS object_id, payload_json, created_at AS recorded_at FROM context_retirements'],
  ['step_progress', 'SELECT step_progress_id AS object_id, payload_json, created_at AS recorded_at FROM step_progress'],
  ['verification', 'SELECT verification_run_id AS object_id, payload_json, created_at AS recorded_at FROM verification_runs'],
  ['settlement', 'SELECT settlement_id AS object_id, payload_json, created_at AS recorded_at FROM usage_settlements'],
  ['criterion_result', `SELECT criterion_result_id AS object_id,
    json_set(payload_json, '$.settlementId', settlement_id) AS payload_json,
    (SELECT created_at FROM usage_settlements WHERE settlement_id = criterion_results.settlement_id) AS recorded_at
    FROM criterion_results`],
  ['outcome_reconciliation', 'SELECT reconciliation_id AS object_id, payload_json, created_at AS recorded_at FROM outcome_reconciliations'],
  ['revision_proposal', 'SELECT revision_proposal_id AS object_id, payload_json, created_at AS recorded_at FROM revision_proposals'],
  ['revision_change', `SELECT revision_change_id AS object_id,
    json_set(payload_json, '$.revisionProposalId', revision_proposal_id) AS payload_json,
    (SELECT created_at FROM revision_proposals WHERE revision_proposal_id = revision_changes.revision_proposal_id) AS recorded_at
    FROM revision_changes`],
  ['markdown_projection', 'SELECT projection_receipt_id AS object_id, payload_json, created_at AS recorded_at FROM markdown_projection_receipts'],
  ['admission_attempt', 'SELECT admission_attempt_id AS object_id, payload_json, created_at AS recorded_at FROM admission_attempts'],
  ['admission_retry_binding', 'SELECT binding_id AS object_id, payload_json, created_at AS recorded_at FROM admission_retry_bindings'],
  ['execution_correlation', 'SELECT correlation_id AS object_id, payload_json, created_at AS recorded_at FROM execution_correlations'],
  ['preference_validation', 'SELECT preference_validation_id AS object_id, payload_json, created_at AS recorded_at FROM preference_validations'],
  ['forget_request', 'SELECT forget_request_id AS object_id, payload_json, created_at AS recorded_at FROM forget_requests'],
  ['forget_step', 'SELECT step_result_id AS object_id, payload_json, updated_at AS recorded_at FROM forget_step_results'],
  ['learning_prediction', 'SELECT prediction_id AS object_id, payload_json, created_at AS recorded_at FROM shadow_predictions'],
  ['learning_human_label', 'SELECT label_id AS object_id, payload_json, created_at AS recorded_at FROM human_labels'],
  ['learning_outcome_label', 'SELECT label_id AS object_id, payload_json, created_at AS recorded_at FROM observed_outcome_labels'],
  ['unlock_contract', 'SELECT unlock_contract_id AS object_id, payload_json, created_at AS recorded_at FROM unlock_contracts'],
  ['unlock_evaluation', 'SELECT evaluation_id AS object_id, payload_json, created_at AS recorded_at FROM unlock_contract_evaluations'],
  ['automation_capability', `SELECT capability AS object_id, payload_json, updated_at AS recorded_at
    FROM automation_capabilities`],
  ['infrastructure_readiness_evaluation', `SELECT evaluation_id AS object_id, payload_json, created_at AS recorded_at
    FROM infrastructure_readiness_evaluations`],
  ['evaluation_observation', `SELECT evaluation_observation_id AS object_id, payload_json, created_at AS recorded_at
    FROM evaluation_observations`],
  ['forget_tombstone', `SELECT experience_id AS object_id,
    json_object('experienceId', experience_id, 'forgetRequestId', forget_request_id, 'forgottenAt', forgotten_at) AS payload_json,
    forgotten_at AS recorded_at FROM forget_tombstones`],
] as const

const MUTABLE_AUDIT_OBJECT_KINDS = new Set([
  'candidate', 'experience', 'approval_request', 'usage', 'context_delivery', 'context_retirement',
  'revision_proposal', 'admission_attempt', 'admission_retry_binding', 'forget_request', 'forget_step',
  'automation_capability',
])

function readAuditDossier(handle: DatabaseSync, input: AuditQueryInput): AuditDossierView {
  validateAuditQuery(input)
  const subjectTable = input.subject.kind === 'experience' ? 'experience_series' : 'experience_usages'
  const subjectColumn = input.subject.kind === 'experience' ? 'experience_id' : 'usage_id'
  const present = input.asOfRecordedAt === null
    ? handle.prepare(`SELECT 1 AS present FROM ${subjectTable} WHERE ${subjectColumn} = ?`).get(input.subject.id)
    : handle.prepare(
      `SELECT 1 AS present FROM ${subjectTable} WHERE ${subjectColumn} = ? AND created_at <= ?`,
    ).get(input.subject.id, input.asOfRecordedAt)
  const typedPresent = present as { present: number } | undefined
  if (typedPresent === undefined) throw new ExperienceError('not_found', `Audit ${input.subject.kind} was not found`)

  const asOf = input.asOfRecordedAt === null ? Number.POSITIVE_INFINITY : Date.parse(input.asOfRecordedAt)
  const rows = AUDIT_OBJECT_QUERIES.flatMap(([objectKind, sql]) => {
    const values = handle.prepare(sql).all() as Array<{
      object_id: string
      payload_json: string
      recorded_at: string
    }>
    return values.flatMap((row): AuditObjectRow[] => {
      if (Date.parse(row.recorded_at) > asOf) return []
      const payload = input.asOfRecordedAt !== null && MUTABLE_AUDIT_OBJECT_KINDS.has(objectKind)
        ? { objectId: row.object_id, asOfRecordedAt: input.asOfRecordedAt }
        : parsePlanningObject<Record<string, unknown>>(row.payload_json, `${objectKind} audit payload`)
      return [{ objectKind, objectId: row.object_id, payload,
        recordedAt: row.recorded_at }]
    })
  })
  const audits = (handle.prepare(
    `SELECT audit_id, actor_id, command_id, action, correlation_id, causation_id, issued_at,
      object_refs_json, payload_digest, source_refs_json, created_at
     FROM audit_events ORDER BY created_at, audit_id`,
  ).all() as Array<{
    audit_id: string
    actor_id: string
    command_id: string
    action: string
    correlation_id: string
    causation_id: string | null
    issued_at: string
    object_refs_json: string
    payload_digest: string
    source_refs_json: string
    created_at: string
  }>).filter(row => Date.parse(row.created_at) <= asOf).map((row): AuditTimelineEntryView => ({
    auditId: row.audit_id,
    actorId: brandedId<'ExperienceActorId'>(row.actor_id, 'actorId'),
    commandId: brandedId<'ExperienceCommandId'>(row.command_id, 'commandId'),
    action: row.action,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    issuedAt: row.issued_at,
    objectRefs: parseLearningStringArray(row.object_refs_json, 'Audit object refs'),
    payloadDigest: row.payload_digest,
    sourceRefs: parseLearningStringArray(row.source_refs_json, 'Audit source refs'),
    recordedAt: row.created_at,
  }))

  const objectIds = new Set(rows.map(row => row.objectId))
  const connectedIds = new Set([input.subject.id])
  const selectedObjects = new Set<string>()
  const selectedAudits = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (selectedObjects.has(row.objectId)) continue
      const values = deepStringValues(row.payload)
      if (!connectedIds.has(row.objectId) && !values.some(value => connectedIds.has(value))) continue
      selectedObjects.add(row.objectId)
      if (!connectedIds.has(row.objectId)) { connectedIds.add(row.objectId); changed = true }
      for (const value of values) {
        if (objectIds.has(value) && !connectedIds.has(value)) { connectedIds.add(value); changed = true }
      }
    }
    for (const audit of audits) {
      if (selectedAudits.has(audit.auditId)) continue
      const refs = [...audit.objectRefs, ...audit.sourceRefs]
      if (!refs.some(ref => connectedIds.has(ref))) continue
      selectedAudits.add(audit.auditId)
      for (const ref of refs) {
        if (!connectedIds.has(ref)) { connectedIds.add(ref); changed = true }
      }
    }
  }

  const connectedObjects: AuditObjectView[] = rows.filter(row => selectedObjects.has(row.objectId))
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)
      || left.objectKind.localeCompare(right.objectKind) || left.objectId.localeCompare(right.objectId))
    .map(row => input.asOfRecordedAt !== null && MUTABLE_AUDIT_OBJECT_KINDS.has(row.objectKind)
      ? { ...row, availability: 'metadata_only' as const, reasonCode: 'historical_snapshot_not_recorded' }
      : { ...row, availability: 'available' as const, reasonCode: null })
  const connectedAudits = audits.filter(row => selectedAudits.has(row.auditId))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)
      || right.auditId.localeCompare(left.auditId))
  const cursor = input.cursor === null ? null : decodeAuditCursor(input.cursor, input)
  const afterCursor = cursor === null ? connectedAudits : connectedAudits.filter(row =>
    row.recordedAt < cursor.recordedAt || (row.recordedAt === cursor.recordedAt && row.auditId < cursor.auditId))
  const page = afterCursor.slice(0, input.limit)
  const nextCursor = afterCursor.length <= input.limit || page.length === 0
    ? null : encodeAuditCursor(page.at(-1)!, input)
  return {
    subject: input.subject,
    asOfRecordedAt: input.asOfRecordedAt,
    generatedAt: new Date().toISOString(),
    objects: connectedObjects,
    sources: auditSourceAvailability(connectedObjects),
    timeline: page,
    nextCursor,
  }
}

function validateAuditQuery(input: AuditQueryInput): void {
  if ((input.subject.kind !== 'experience' && input.subject.kind !== 'usage') || input.subject.id.trim() === '') {
    throw new ExperienceError('invalid_command', 'Audit subject must identify one Experience or Usage')
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new ExperienceError('invalid_command', 'Audit page limit must be from 1 through 100')
  }
  if (input.asOfRecordedAt !== null && !Number.isFinite(Date.parse(input.asOfRecordedAt))) {
    throw new ExperienceError('invalid_command', 'Audit asOfRecordedAt must be an ISO timestamp')
  }
}

function encodeAuditCursor(entry: AuditTimelineEntryView, input: AuditQueryInput): string {
  return Buffer.from(JSON.stringify({
    subject: input.subject,
    asOfRecordedAt: input.asOfRecordedAt,
    recordedAt: entry.recordedAt,
    auditId: entry.auditId,
  }), 'utf8').toString('base64url')
}

function decodeAuditCursor(
  value: string,
  input: AuditQueryInput,
): { readonly recordedAt: string; readonly auditId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!isRecord(parsed) || typeof parsed.recordedAt !== 'string' || typeof parsed.auditId !== 'string'
      || !isRecord(parsed.subject) || parsed.subject.kind !== input.subject.kind
      || parsed.subject.id !== input.subject.id || parsed.asOfRecordedAt !== input.asOfRecordedAt
      || !Number.isFinite(Date.parse(parsed.recordedAt)) || parsed.auditId.trim() === '') throw new Error('invalid')
    return { recordedAt: parsed.recordedAt, auditId: parsed.auditId }
  } catch (error) {
    throw new ExperienceError('invalid_command', 'Audit cursor is invalid', {}, { cause: error })
  }
}

function deepStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStringValues)
  if (!isRecord(value)) return []
  return Object.values(value).flatMap(deepStringValues)
}

function auditSourceAvailability(objects: readonly AuditObjectView[]): AuditSourceAvailabilityView[] {
  const found = new Map<string, AuditSourceAvailabilityView>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (!isRecord(value)) return
    if (typeof value.sourceRefId === 'string' && typeof value.locator === 'string'
      && typeof value.sourceSystem === 'string' && typeof value.contentDigest === 'string') {
      found.set(value.sourceRefId, {
        sourceRefId: value.sourceRefId,
        locator: value.locator,
        sourceSystem: value.sourceSystem,
        contentDigest: value.contentDigest,
        availability: 'metadata_only',
        reasonCode: 'source_body_owned_by_external_system',
      })
    }
    for (const item of Object.values(value)) visit(item)
  }
  for (const object of objects) visit(object.payload)
  return [...found.values()].sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId))
}

function isEpisodeRefs(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    if (!isRecord(item)) return false
    return typeof item.episodeRefId === 'string'
      && item.sourceSystem === 'dsh-session'
      && typeof item.sessionOrRunId === 'string'
      && Number.isSafeInteger(item.eventStart)
      && (item.eventStart as number) >= 0
      && Number.isSafeInteger(item.eventEnd)
      && (item.eventEnd as number) >= (item.eventStart as number)
      && isRecord(item.occurredAt)
      && typeof item.occurredAt.start === 'string'
      && typeof item.occurredAt.end === 'string'
      && typeof item.contentDigest === 'string'
      && item.redactionState === 'bounded_excerpt'
  })
}

function isSourceRefs(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    if (!isRecord(item)) return false
    return typeof item.sourceRefId === 'string'
      && (item.sourceSystem === 'dsh-session' || item.sourceSystem === 'codex-rollout'
        || item.sourceSystem === 'experience-verifier')
      && (item.sourceKind === 'session_event' || item.sourceKind === 'tool_result'
        || item.sourceKind === 'user_instruction' || item.sourceKind === 'external_document')
      && typeof item.locator === 'string'
      && typeof item.ownerScope === 'string'
      && item.accessScope === 'local_owner'
      && typeof item.occurredAt === 'string'
      && typeof item.observedAt === 'string'
      && typeof item.contentDigest === 'string'
      && (item.redactionState === 'bounded_excerpt' || item.redactionState === 'digest_only')
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function localOwnerPrincipalId(value: string): LocalOwnerPrincipalId {
  return brandedId<'ExperienceLocalOwnerPrincipalId'>(value, 'LocalOwnerPrincipalId')
}

function id<Tag extends string, Value extends string>(): Value {
  return brandedId<Tag>(randomUUID(), 'generated id') as unknown as Value
}

function deterministicId<Tag extends string, Value extends string>(namespace: string, value: string): Value {
  return brandedId<Tag>(`${namespace}:${sha256(value)}`, namespace) as unknown as Value
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const unique = new Map<string, T>()
  for (const value of values) {
    const identity = key(value)
    const existing = unique.get(identity)
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(value)) {
      throw new ExperienceError('source_unresolvable', 'A source identity resolved to conflicting snapshots')
    }
    if (existing === undefined) unique.set(identity, value)
  }
  return [...unique.values()].sort((left, right) => key(left).localeCompare(key(right)))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  }
  return value
}
