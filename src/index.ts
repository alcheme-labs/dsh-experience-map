import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import {
  HistoricalSource,
  type HistoricalRecordConfig,
  type HistoricalSourceConfig,
} from './adapters/historical-source.js'
import type { ExtractionEvidenceConfig } from './adapters/extraction-evidence.js'
import { OutcomeEvidenceSource } from './adapters/outcome-evidence-source.js'
import { DiagnosticProposalLlm } from './adapters/proposal-llm.js'
import { TransformersLocalEmbeddingProvider } from './adapters/local-embedding.js'
import { DshSessionSource, type SessionSourceConfig } from './adapters/session-source.js'
import { registerExperienceTransport } from './adapters/transport.js'
import { PlanningObservationRegistry } from './adapters/observations.js'
import { PlanReviewInteraction } from './adapters/plan-interaction.js'
import { TaskFingerprintLlm, type TaskFingerprintProposalConfig } from './adapters/task-fingerprint-llm.js'
import { ActorResolver, type TrustedCommandOrigin } from './application/actor-resolver.js'
import { CandidateProposalService } from './application/candidate-service.js'
import { ContextRetirementCoordinator } from './application/context-retirement.js'
import { ExperienceForgetService } from './application/forget-service.js'
import { ExperienceApplicationService } from './application/service.js'
import { ExperiencePlanningService } from './application/planning-service.js'
import { SessionAdmission } from './application/session-admission.js'
import { ExperienceExecutionService } from './application/execution-service.js'
import { ExperienceLearningProjector, type LearningProjectorConfig } from './application/learning-projector.js'
import { ExperienceRetrievalProjection } from './application/retrieval-projection.js'
import { ConservativeRecall } from './application/conservative-recall.js'
import { consolidatePublishedSuggestionDuplicates } from './application/semantic-suggestion-consolidation.js'
import {
  DEFAULT_EXPERIENCE_PROJECTION_POLICY,
  ExperienceProjectionWorker,
} from './application/experience-projection-worker.js'
import { WebUsageVerifier } from './adapters/web-verifier.js'
import { ExperienceError } from './errors.js'
import { assertSupportedNodeVersion } from './node-compatibility.js'
import { assertExperienceStoreInvariants } from './invariant.js'
import type { CandidateId, ExperienceVersionId, ReceiptId, ExperienceRelationId, OverrideDecisionId } from './ids.js'
import { ExperienceDatabase, type DatabaseConfig } from './persistence/database.js'
import { ExperienceRepository } from './persistence/repository.js'
import { ExperienceProjectionStore } from './persistence/projection-store.js'
import { automationConfiguration, RuntimeSettingsSource } from './runtime-settings.js'
import { RuntimeSettingsSchema, type RuntimeSettings } from './runtime-settings-schema.js'
import type {
  DomainReceipt,
  ExperienceDomainReceipt,
  M5DomainReceipt,
  CandidateCommandInput,
  CandidateDispositionInput,
  CandidateSummaryView,
  CandidateView,
  DecideCandidateFieldInput,
  ProposalSourceInspectionInput,
  ExperienceStatusView,
  ExperienceVersionView,
  ProposalSourceInspectionView,
  ProposeCandidateInput,
  PlanTaskCommandInput,
  DecidePlanCommandInput,
  PlanningCommandResult,
  PlanningResultView,
  PlanningConfigurationView,
  AutomationConfigurationView,
  ContextUsageView,
  UsageExecutionView,
  ProgressUsageInput,
  VerifyUsageInput,
  SettleUsageInput,
  ProposeRevisionInput,
  DecideRevisionChangeInput,
  PublishRevisionInput,
  RevisionProposalView,
  LearningProjectionView,
  ForgetDomainReceipt,
  ForgetExperienceInput,
  ForgetImpactPreviewView,
  ForgetRequestView,
  DeclareExperienceRelationInput,
  CreateOverrideDecisionInput,
  ExperienceRelationObjectRef,
  ExperienceRelationView,
  OverrideDecisionView,
  RelationDomainReceipt,
  ChangeAutomationLevelInput,
  EvaluateUnlockContractInput,
  RankHistoryRankingInput,
  HistoryRankingReviewView,
  LearningGovernanceReceipt,
  LearningGovernanceView,
  AuditDossierView,
  AuditQueryInput,
  ExportMarkdownInput,
  MarkdownDomainReceipt,
  MarkdownProjectionView,
  ProposeMarkdownRevisionInput,
  EvaluateInfrastructureReadinessInput,
  InfrastructureDomainReceipt,
  InfrastructureReadinessView,
  RelationMapView,
  EvaluationDomainReceipt,
  EvaluationReportView,
  RecordEvaluationObservationInput,
  SuggestionProjectionView,
  DismissExperienceSuggestionInput,
  SaveExperienceSuggestionInput,
  SuggestionSaveDomainReceipt,
  ExperienceRetrievalProjectionView,
} from './types.js'

assertSupportedNodeVersion()

export type { TrustedCommandOrigin } from './application/actor-resolver.js'
export type {
  DomainReceipt,
  CandidateCommandInput,
  CandidateDispositionInput,
  CandidateSummaryView,
  CandidateView,
  DecideCandidateFieldInput,
  EpisodeLocatorInput,
  ExperienceStatusView,
  ExperienceVersionView,
  ProposalSourceInspectionView,
  ProposeCandidateInput,
  PlanTaskCommandInput,
  DecidePlanCommandInput,
  PlanningCommandResult,
  PlanningResultView,
  PlanningConfigurationView,
  ExperienceRetrievalProjectionView,
  ContextUsageView,
  UsageExecutionView,
  ProgressUsageInput,
  StepProgressView,
  VerifyUsageInput,
  VerificationRunView,
  SettleUsageInput,
  UsageSettlementView,
  ProposeRevisionInput,
  DecideRevisionChangeInput,
  PublishRevisionInput,
  RevisionProposalView,
  ForgetDomainReceipt,
  ForgetExperienceInput,
  ForgetImpactPreviewView,
  ForgetRequestView,
  DeclareExperienceRelationInput,
  CreateOverrideDecisionInput,
  ExperienceRelationObjectRef,
  ExperienceRelationView,
  OverrideDecisionView,
  RelationDomainReceipt,
  ChangeAutomationLevelInput,
  EvaluateUnlockContractInput,
  RankHistoryRankingInput,
  HistoryRankingReviewView,
  LearningGovernanceReceipt,
  LearningGovernanceView,
  AuditDossierView,
  AuditQueryInput,
  ExportMarkdownInput,
  MarkdownDomainReceipt,
  MarkdownProjectionView,
  ProposeMarkdownRevisionInput,
  EvaluateInfrastructureReadinessInput,
  InfrastructureDomainReceipt,
  InfrastructureReadinessView,
  RelationMapView,
  EvaluationDomainReceipt,
  EvaluationReportView,
  RecordEvaluationObservationInput,
  SuggestionProjectionView,
  DismissExperienceSuggestionInput,
  SaveExperienceSuggestionInput,
  SuggestionSaveDomainReceipt,
} from './types.js'

/** Validated Host plugin configuration. */
export interface Config extends DatabaseConfig, RuntimeSettings, SessionSourceConfig,
  ExtractionEvidenceConfig, TaskFingerprintProposalConfig, LearningProjectorConfig {
  readonly historicalSourcePath?: string
  readonly historicalSourceRunId?: string
  readonly historicalSourceAggregateDigest?: string
  readonly historicalSourceRecords: HistoricalRecordConfig[]
  readonly verifiedOutcomeManifest?: unknown
}

/** Startup-only configuration vocabulary; changing these fields requires plugin reload. */
export const RESTART_CONFIG_KEYS = [
  'databasePath',
  'journalMode',
  'synchronous',
  'busyTimeoutMs',
  'maxPendingWrites',
  'historicalSourcePath',
  'historicalSourceRunId',
  'historicalSourceAggregateDigest',
  'historicalSourceRecords',
  'verifiedOutcomeManifest',
  'taskFingerprintProposalMode',
  'learningPollIntervalMs',
] as const satisfies readonly (keyof Config)[]

/** Schemastery validator for the canonical database owner. */
export const Config: z<Config> = z.intersect([z.object({
  databasePath: z.string().required(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
  synchronous: z.union(['normal', 'full'] as const).default('normal'),
  busyTimeoutMs: z.number().step(1).min(0).max(2_147_483_647).default(5_000),
  maxPendingWrites: z.number().step(1).min(1).default(128),
  historicalSourcePath: z.string().required(false),
  historicalSourceRunId: z.string().required(false),
  historicalSourceAggregateDigest: z.string().required(false),
  historicalSourceRecords: z.array(z.object({
    line: z.number().step(1).min(1).required(),
    digest: z.string().required(),
    bytes: z.number().step(1).min(1).required(),
  })).default([]),
  verifiedOutcomeManifest: z.any().required(false),
  taskFingerprintProposalMode: z.union(['deterministic', 'model'] as const).default('deterministic'),
  learningPollIntervalMs: z.number().step(1).min(100).max(60_000).default(1_000),
}), RuntimeSettingsSchema]) as z<Config>

/** Public Host use cases shared by Browser, management CLI, and restricted runtime callers. */
export interface ExperiencesApi {
  /** Read the latest rebuildable recent-Session suggestion projection. */
  getSuggestionProjection(origin: TrustedCommandOrigin): SuggestionProjectionView
  /** Read the current lexical/dense generation without exposing vector payloads. */
  getRetrievalProjection(origin: TrustedCommandOrigin): ExperienceRetrievalProjectionView
  /** Suppress one exact current suggestion group for its short retention window. */
  dismissSuggestion(input: DismissExperienceSuggestionInput, origin: TrustedCommandOrigin): SuggestionProjectionView
  /** Save one exact reviewed suggestion into canonical Experience storage. */
  saveExperienceSuggestion(
    input: SaveExperienceSuggestionInput,
    origin: TrustedCommandOrigin,
  ): Promise<SuggestionSaveDomainReceipt>
  /** Inspect local sources without invoking a model. */
  inspectProposalSource(
    input: ProposalSourceInspectionInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<ProposalSourceInspectionView>
  /** Generate and persist one disclosure-confirmed Candidate. */
  proposeCandidate(
    input: ProposeCandidateInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<DomainReceipt>
  /** Submit one proposed Candidate for review. */
  submitCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt>
  /** Decide one Candidate field. */
  decideCandidateField(input: DecideCandidateFieldInput, origin: TrustedCommandOrigin): Promise<DomainReceipt>
  /** Accept one fully reviewed Candidate. */
  acceptCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt>
  /** Reject one in-review Candidate. */
  rejectCandidate(input: CandidateDispositionInput, origin: TrustedCommandOrigin): Promise<DomainReceipt>
  /** Withdraw one unpublished Candidate. */
  withdrawCandidate(input: CandidateDispositionInput, origin: TrustedCommandOrigin): Promise<DomainReceipt>
  /** Publish one accepted Candidate. */
  publishCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt>
  /** Read one Candidate. */
  getCandidate(candidateId: CandidateId, origin: TrustedCommandOrigin): CandidateView
  /** Read the Candidate inbox. */
  listCandidates(origin: TrustedCommandOrigin): CandidateSummaryView[]
  /** Read a durable command receipt. */
  getReceipt(receiptId: ReceiptId, origin: TrustedCommandOrigin): ExperienceDomainReceipt
  /** Read one immutable Experience version. */
  getVersion(versionId: ExperienceVersionId, origin: TrustedCommandOrigin): ExperienceVersionView
  /** Declare one canonical typed relation. */
  declareRelation(input: DeclareExperienceRelationInput, origin: TrustedCommandOrigin): Promise<RelationDomainReceipt>
  /** Read one canonical typed relation. */
  getRelation(relationId: ExperienceRelationId, origin: TrustedCommandOrigin): ExperienceRelationView
  /** List relations touching one exact object. */
  listRelations(objectRef: ExperienceRelationObjectRef, origin: TrustedCommandOrigin): ExperienceRelationView[]
  /** Create one current-Usage conflict override. */
  createOverride(input: CreateOverrideDecisionInput, origin: TrustedCommandOrigin): Promise<RelationDomainReceipt>
  /** Read one current-Usage conflict override. */
  getOverride(overrideDecisionId: OverrideDecisionId, origin: TrustedCommandOrigin): OverrideDecisionView
  /** Read the current authoritative summary. */
  getStatus(origin: TrustedCommandOrigin): ExperienceStatusView
  /** Create one exact M3 planning result. */
  planTask(input: PlanTaskCommandInput, origin: TrustedCommandOrigin, signal?: AbortSignal): Promise<PlanningCommandResult>
  /** Decide one exact pending plan. */
  decidePlan(input: DecidePlanCommandInput, origin: TrustedCommandOrigin): Promise<PlanningCommandResult>
  /** Read one M3 planning projection. */
  getPlanningResult(usageId: string, origin: TrustedCommandOrigin): PlanningResultView
  /** List recent M3 planning projections. */
  listPlanningResults(origin: TrustedCommandOrigin, limit?: number): PlanningResultView[]
  /** Read one M4 ContextSnapshot, delivery, and retirement explanation. */
  getContextUsage(usageId: string, origin: TrustedCommandOrigin): ContextUsageView
  /** Transition one exact guided cursor. */
  progressUsage(input: ProgressUsageInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt>
  /** Run the five fixed Web verifiers. */
  verifyUsage(input: VerifyUsageInput, origin: TrustedCommandOrigin, signal?: AbortSignal): Promise<M5DomainReceipt>
  /** Persist one criterion-backed terminal outcome. */
  settleUsage(input: SettleUsageInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt>
  /** Read one M5 execution projection. */
  getUsageExecution(usageId: string, origin: TrustedCommandOrigin): UsageExecutionView
  /** Derive one minimal RevisionProposal from a settled stale Usage. */
  proposeRevision(input: ProposeRevisionInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt>
  /** Decide one exact RevisionProposal change. */
  decideRevisionChange(input: DecideRevisionChangeInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt>
  /** Publish an accepted RevisionProposal as the next immutable Version. */
  publishRevision(input: PublishRevisionInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt>
  /** Read one durable RevisionProposal. */
  getRevisionProposal(revisionProposalId: string, origin: TrustedCommandOrigin): RevisionProposalView
  /** Disclose whether M3 fingerprint proposal is local or model-assisted. */
  getPlanningConfiguration(): PlanningConfigurationView
  /** Read automation preferences separately from their stricter effective Host behavior. */
  getAutomationConfiguration(origin: TrustedCommandOrigin): AutomationConfigurationView
  /** Reconcile and read the source-bound M6 learning projection. */
  getLearningProjection(origin: TrustedCommandOrigin): Promise<LearningProjectionView>
  /** Read current unlock policies, evaluations, and independent capability levels. */
  getLearningGovernance(origin: TrustedCommandOrigin): LearningGovernanceView
  /** Read one paginated exact-subject domain audit dossier. */
  getAuditDossier(input: AuditQueryInput, origin: TrustedCommandOrigin): AuditDossierView
  /** Export one immutable Version as a receipt-bound Markdown projection. */
  exportMarkdown(input: ExportMarkdownInput, origin: TrustedCommandOrigin): Promise<MarkdownProjectionView>
  /** Create a structured RevisionProposal from one receipt-bound Markdown edit. */
  proposeMarkdownRevision(input: ProposeMarkdownRevisionInput, origin: TrustedCommandOrigin): Promise<MarkdownDomainReceipt>
  /** Read one exact stored Markdown projection. */
  getMarkdownProjection(receiptId: string, origin: TrustedCommandOrigin): MarkdownProjectionView
  /** Read the rebuildable relation map derived from canonical relations. */
  getRelationMap(origin: TrustedCommandOrigin): RelationMapView
  /** Freeze current graph-storage readiness signals. */
  evaluateInfrastructureReadiness(input: EvaluateInfrastructureReadinessInput, origin: TrustedCommandOrigin): Promise<InfrastructureDomainReceipt>
  /** Read the current graph-storage readiness decision. */
  getInfrastructureReadiness(origin: TrustedCommandOrigin): InfrastructureReadinessView
  /** Record one source-backed frozen-corpus evaluation observation. */
  recordEvaluationObservation(input: RecordEvaluationObservationInput, origin: TrustedCommandOrigin): Promise<EvaluationDomainReceipt>
  /** Read one comparability-checked three-arm report. */
  getEvaluationReport(cohortId: string, origin: TrustedCommandOrigin): EvaluationReportView
  /** Freeze one evaluation over the current learning projection. */
  evaluateUnlockContract(input: EvaluateUnlockContractInput, origin: TrustedCommandOrigin): Promise<LearningGovernanceReceipt>
  /** Apply one bounded owner promotion or immediate safety demotion. */
  changeAutomationLevel(input: ChangeAutomationLevelInput, origin: TrustedCommandOrigin): Promise<LearningGovernanceReceipt>
  /** Record one owner-only review of a readable shadow history-ranking counterfactual. */
  reviewHistoryRanking(input: RankHistoryRankingInput, origin: TrustedCommandOrigin): Promise<LearningGovernanceReceipt>
  /** Read the immutable owner history-ranking reviews. */
  readHistoryRankingReviews(origin: TrustedCommandOrigin): HistoryRankingReviewView[]
  /** Preview the exact impact of forgetting one Experience series. */
  previewForget(
    experienceId: ExperienceVersionView['experienceId'],
    origin: TrustedCommandOrigin,
  ): ForgetImpactPreviewView
  /** Stop future recall and reconcile owned projections for one Experience series. */
  forgetExperience(input: ForgetExperienceInput, origin: TrustedCommandOrigin): Promise<ForgetDomainReceipt>
  /** Read one durable Forget request and its per-owner results. */
  getForgetRequest(forgetRequestId: string, origin: TrustedCommandOrigin): ForgetRequestView
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Canonical Experience application service. */
    experiences: Experiences
  }
}

/** Sole Cordis lifecycle owner for Experience storage and application use cases. */
export class Experiences extends Service implements ExperiencesApi {
  static Config = Config
  static inject = ['sessions', 'sessionQuery']

  private database: ExperienceDatabase | undefined
  private suggestionStore: ExperienceProjectionStore | undefined
  private suggestionWorker: ExperienceProjectionWorker | undefined
  private retrievalProjection: ExperienceRetrievalProjection | undefined
  private actors: ActorResolver | undefined
  private application: ExperienceApplicationService | undefined
  private learning: ExperienceLearningProjector | undefined
  private readonly runtimeSettings: RuntimeSettingsSource

  /** Register the service and optional Web transport; Browser absence remains legal. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'experiences')
    // Register the settings namespace before async database initialization so
    // the Client's one cold-boot settings.describe read cannot miss it.
    this.runtimeSettings = new RuntimeSettingsSource(ctx, config)
    ctx.inject(['connection'], connectionCtx => {
      registerExperienceTransport(connectionCtx)
    })
  }

  /** Open the canonical DB and establish its stable LocalOwnerPrincipalId. */
  protected async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const database = await ExperienceDatabase.open(this.config)
    let suggestionStore: ExperienceProjectionStore | undefined
    let suggestionWorker: ExperienceProjectionWorker | undefined
    let retrievalProjection: ExperienceRetrievalProjection | undefined
    try {
      const repository = new ExperienceRepository(database)
      const principalId = await repository.initializePrincipal()
      const actors = new ActorResolver(principalId)
      assertExperienceStoreInvariants(database.handle)
      const runtimeSettings = this.runtimeSettings
      const historicalConfig = resolveHistoricalSource(this.config)
      const outcomeManifest = resolveVerifiedOutcomeManifest(this.config.verifiedOutcomeManifest)
      const sessions = new DshSessionSource(this.ctx.sessionQuery, this.config)
      suggestionStore = await ExperienceProjectionStore.open(this.config.databasePath)
      const embedding = new TransformersLocalEmbeddingProvider()
      retrievalProjection = new ExperienceRetrievalProjection(
        repository,
        suggestionStore,
        actors.resolve({ kind: 'management-cli' }),
        () => runtimeSettings.capture(),
        embedding,
      )
      const recall = new ConservativeRecall(
        suggestionStore,
        embedding,
        async () => retrievalProjection!.rebuild(),
      )
      suggestionWorker = new ExperienceProjectionWorker(this.ctx, sessions, suggestionStore, {
        ...DEFAULT_EXPERIENCE_PROJECTION_POLICY,
        maxEvidenceItems: this.config.maxEvidenceItems,
        maxEvidenceItemBytes: this.config.maxEvidenceItemBytes,
        maxEvidencePacketBytes: this.config.maxEvidencePacketBytes,
        maxInlineFieldBytes: this.config.maxInlineFieldBytes,
      }, () => repository.listSuggestionSaveReceipts(
        actors.resolve({ kind: 'management-cli' }),
      ), async () => { await retrievalProjection!.rebuild() }, () => runtimeSettings.capture(),
      groups => consolidatePublishedSuggestionDuplicates(
        groups,
        suggestionStore!.readRetrievalInternal(),
        repository.listActiveVersionsForProjection(actors.resolve({ kind: 'management-cli' })),
        runtimeSettings.capture(),
        embedding,
      ))
      suggestionWorker.install()
      await suggestionWorker.drain()
      const historical = new HistoricalSource(historicalConfig, this.config)
      const outcomeEvidence = new OutcomeEvidenceSource(outcomeManifest, this.config)
      const proposer = new DiagnosticProposalLlm(
        () => this.ctx.get('llm'),
        () => this.ctx.get('sessions'),
        this.config,
      )
      const proposals = new CandidateProposalService(
        repository,
        sessions,
        historical,
        outcomeEvidence,
        proposer,
        this.config.maxInlineFieldBytes,
        this.config,
        this.config,
        outcomeManifest,
      )
      const fingerprintLlm = new TaskFingerprintLlm(
        () => this.ctx.get('llm'),
        () => this.ctx.get('sessions'),
        this.config.provider,
        this.config.model,
        this.config.taskFingerprintMaxTokens,
      )
      const observations = new PlanningObservationRegistry(this.ctx, this.config.observationFreshnessMs)
      const planning = new ExperiencePlanningService(
        repository,
        observations,
        new PlanReviewInteraction(this.ctx),
        {
          retrievalCandidateLimit: this.config.retrievalCandidateLimit,
          observationFreshnessMs: this.config.observationFreshnessMs,
          planApprovalTtlMs: this.config.planApprovalTtlMs,
          maxPlanningTaskBytes: this.config.maxPlanningTaskBytes,
        },
        this.config.taskFingerprintProposalMode,
        fingerprintLlm,
        recall,
      )
      const learning = new ExperienceLearningProjector(
        this.ctx,
        repository,
        this.config,
        () => runtimeSettings.capture(),
      )
      await repository.ensureLearningProjectionBuilder()
      await learning.drain()
      learning.install()
      const execution = new ExperienceExecutionService(this.ctx, repository)
      execution.install()
      const verifier = new WebUsageVerifier(this.ctx, repository, execution, this.config.verificationTimeoutMs)
      const retirement = new ContextRetirementCoordinator(this.ctx, repository)
      const forget = new ExperienceForgetService(this.ctx, repository, actors, retirement, learning)
      this.database = database
      this.suggestionStore = suggestionStore
      this.suggestionWorker = suggestionWorker
      this.retrievalProjection = retrievalProjection
      this.actors = actors
      this.learning = learning
      this.application = new ExperienceApplicationService(
        repository,
        actors,
        proposals,
        this.config.maxInlineFieldBytes,
        planning,
        execution,
        verifier,
        forget,
        this.config.maxMarkdownProjectionBytes,
        runtimeSettings,
      )
      new SessionAdmission(this.ctx, repository, actors, observations, planning, execution, {
        claimLeaseMs: this.config.admissionClaimLeaseMs,
        automaticRecall: this.config.automaticRecall,
        defaultTargetExposure: this.config.defaultTargetExposure,
        defaultRiskClass: this.config.defaultRiskClass,
        defaultMustUseExperience: this.config.defaultMustUseExperience,
      }, retirement, () => runtimeSettings.capture()).install()
    } catch (error) {
      await suggestionWorker?.stop()
      await retrievalProjection?.dispose()
      suggestionStore?.close()
      await database.close()
      throw error
    }
    yield async () => {
      const owned = this.database
      const ownedSuggestionStore = this.suggestionStore
      const ownedSuggestionWorker = this.suggestionWorker
      const ownedRetrievalProjection = this.retrievalProjection
      this.application = undefined
      this.learning = undefined
      this.actors = undefined
      this.suggestionWorker = undefined
      this.retrievalProjection = undefined
      this.suggestionStore = undefined
      this.database = undefined
      await ownedSuggestionWorker?.stop()
      await ownedRetrievalProjection?.dispose()
      ownedSuggestionStore?.close()
      if (owned !== undefined) await owned.close()
    }
  }

  /** Read the active sidecar generation for owner-facing Browser or management surfaces. */
  getSuggestionProjection(origin: TrustedCommandOrigin): SuggestionProjectionView {
    const actor = this.actors?.resolve(origin)
    const store = this.suggestionStore
    if (actor === undefined || store === undefined) {
      throw new ExperienceError('internal', 'Experience suggestion projection is not ready')
    }
    if (actor.authority !== 'owner') {
      throw new ExperienceError('principal_unauthorized', 'Experience suggestions are owner-only')
    }
    return store.read()
  }

  /** Read the active retrieval generation through the same owner authority boundary. */
  getRetrievalProjection(origin: TrustedCommandOrigin): ExperienceRetrievalProjectionView {
    const actor = this.actors?.resolve(origin)
    const store = this.suggestionStore
    if (actor === undefined || store === undefined) {
      throw new ExperienceError('internal', 'Experience retrieval projection is not ready')
    }
    if (actor.authority !== 'owner') {
      throw new ExperienceError('principal_unauthorized', 'Experience retrieval projection is owner-only')
    }
    return store.readRetrieval()
  }

  /** Apply an owner decision only to the disposable projection; no Candidate or Version is written. */
  dismissSuggestion(
    input: DismissExperienceSuggestionInput,
    origin: TrustedCommandOrigin,
  ): SuggestionProjectionView {
    const actor = this.actors?.resolve(origin)
    const store = this.suggestionStore
    if (actor === undefined || store === undefined) {
      throw new ExperienceError('internal', 'Experience suggestion projection is not ready')
    }
    if (actor.authority !== 'owner') {
      throw new ExperienceError('principal_unauthorized', 'Experience suggestion decisions are owner-only')
    }
    return store.dismiss(input, actor.actorId)
  }

  /** Commit the current reviewed snapshot, then project its disposition back to the sidecar. */
  async saveExperienceSuggestion(
    input: SaveExperienceSuggestionInput,
    origin: TrustedCommandOrigin,
  ): Promise<SuggestionSaveDomainReceipt> {
    const actor = this.actors?.resolve(origin)
    const store = this.suggestionStore
    if (actor === undefined || store === undefined) {
      throw new ExperienceError('internal', 'Experience suggestion projection is not ready')
    }
    if (actor.authority !== 'owner') {
      throw new ExperienceError('principal_unauthorized', 'Experience suggestion decisions are owner-only')
    }
    const group = store.resolveForSave(input)
    const receipt = await this.ready().saveExperienceSuggestion(input, group, origin)
    try {
      store.markSaved(input, group, receipt)
    } catch {
      this.ctx.logger('experience-map').warn(
        'Suggestion save committed as receipt %s; disposable inbox reconciliation will retry',
        receipt.receiptId,
      )
    }
    try {
      await this.suggestionWorker?.drain()
    } catch {
      this.ctx.logger('experience-map').warn(
        'Suggestion save committed as receipt %s; retrieval projection reconciliation will retry',
        receipt.receiptId,
      )
    }
    return receipt
  }

  /** Inspect one terminal Episode without invoking the proposal model. */
  inspectProposalSource(
    input: ProposalSourceInspectionInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<ProposalSourceInspectionView> {
    return this.ready().inspectProposalSource(input, origin, signal)
  }

  /** Generate and persist one source-bound Candidate. */
  proposeCandidate(
    input: ProposeCandidateInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<DomainReceipt> {
    return this.ready().proposeCandidate(input, origin, signal)
  }

  /** Submit one Candidate for field review. */
  submitCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.ready().submitCandidate(input, origin)
  }

  /** Persist one Candidate field decision. */
  decideCandidateField(input: DecideCandidateFieldInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.ready().decideCandidateField(input, origin)
  }

  /** Accept one fully reviewed Candidate. */
  acceptCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.ready().acceptCandidate(input, origin)
  }

  /** Reject one in-review Candidate. */
  rejectCandidate(input: CandidateDispositionInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.ready().rejectCandidate(input, origin)
  }

  /** Withdraw one unpublished Candidate. */
  withdrawCandidate(input: CandidateDispositionInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.ready().withdrawCandidate(input, origin)
  }

  /** Publish one accepted Candidate. */
  publishCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.ready().publishCandidate(input, origin)
  }

  /** Read one Candidate. */
  getCandidate(candidateId: CandidateId, origin: TrustedCommandOrigin): CandidateView {
    return this.ready().getCandidate(candidateId, origin)
  }

  /** Read the Candidate inbox. */
  listCandidates(origin: TrustedCommandOrigin): CandidateSummaryView[] {
    return this.ready().listCandidates(origin)
  }

  /** Read one durable receipt. */
  getReceipt(receiptId: ReceiptId, origin: TrustedCommandOrigin): ExperienceDomainReceipt {
    return this.ready().getReceipt(receiptId, origin)
  }

  /** Read one immutable published version. */
  getVersion(versionId: ExperienceVersionId, origin: TrustedCommandOrigin): ExperienceVersionView {
    return this.ready().getVersion(versionId, origin)
  }

  /** Declare one canonical typed relation. */
  declareRelation(input: DeclareExperienceRelationInput, origin: TrustedCommandOrigin): Promise<RelationDomainReceipt> {
    return this.ready().declareRelation(input, origin)
  }

  /** Read one canonical typed relation. */
  getRelation(relationId: ExperienceRelationId, origin: TrustedCommandOrigin): ExperienceRelationView {
    return this.ready().getRelation(relationId, origin)
  }

  /** List relations touching one exact object. */
  listRelations(objectRef: ExperienceRelationObjectRef, origin: TrustedCommandOrigin): ExperienceRelationView[] {
    return this.ready().listRelations(objectRef, origin)
  }

  /** Create one current-Usage conflict override. */
  createOverride(input: CreateOverrideDecisionInput, origin: TrustedCommandOrigin): Promise<RelationDomainReceipt> {
    return this.ready().createOverride(input, origin)
  }

  /** Read one current-Usage conflict override. */
  getOverride(overrideDecisionId: OverrideDecisionId, origin: TrustedCommandOrigin): OverrideDecisionView {
    return this.ready().getOverride(overrideDecisionId, origin)
  }

  /** Read the authoritative status. */
  getStatus(origin: TrustedCommandOrigin): ExperienceStatusView {
    return this.ready().getStatus(origin)
  }

  /** Create and optionally interact over one exact M3 plan. */
  planTask(
    input: PlanTaskCommandInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<PlanningCommandResult> {
    return this.ready().planTask(input, origin, signal)
  }

  /** Decide one exact pending M3 plan. */
  decidePlan(input: DecidePlanCommandInput, origin: TrustedCommandOrigin): Promise<PlanningCommandResult> {
    return this.ready().decidePlan(input, origin)
  }

  /** Read one durable M3 result. */
  getPlanningResult(usageId: string, origin: TrustedCommandOrigin): PlanningResultView {
    return this.ready().getPlanningResult(usageId, origin)
  }

  /** List recent durable M3 results. */
  listPlanningResults(origin: TrustedCommandOrigin, limit?: number): PlanningResultView[] {
    return this.ready().listPlanningResults(origin, limit)
  }

  /** Read one durable M4 context explanation. */
  getContextUsage(usageId: string, origin: TrustedCommandOrigin): ContextUsageView {
    return this.ready().getContextUsage(usageId, origin)
  }

  /** Transition one guided cursor. */
  progressUsage(input: ProgressUsageInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.ready().progressUsage(input, origin)
  }

  /** Run current-authority verification. */
  verifyUsage(
    input: VerifyUsageInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<M5DomainReceipt> {
    return this.ready().verifyUsage(input, origin, signal)
  }

  /** Settle one guided Usage. */
  settleUsage(input: SettleUsageInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.ready().settleUsage(input, origin)
  }

  /** Read one M5 execution projection. */
  getUsageExecution(usageId: string, origin: TrustedCommandOrigin): UsageExecutionView {
    return this.ready().getUsageExecution(usageId, origin)
  }

  /** Derive one minimal RevisionProposal from a settled stale Usage. */
  proposeRevision(input: ProposeRevisionInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.ready().proposeRevision(input, origin)
  }

  /** Decide one exact RevisionProposal change. */
  decideRevisionChange(input: DecideRevisionChangeInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.ready().decideRevisionChange(input, origin)
  }

  /** Publish an accepted RevisionProposal as the next immutable Version. */
  publishRevision(input: PublishRevisionInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.ready().publishRevision(input, origin)
  }

  /** Read one durable RevisionProposal. */
  getRevisionProposal(revisionProposalId: string, origin: TrustedCommandOrigin): RevisionProposalView {
    return this.ready().getRevisionProposal(revisionProposalId, origin)
  }

  /** Reconcile due outbox rows and read the current M6 learning projection. */
  async getLearningProjection(origin: TrustedCommandOrigin): Promise<LearningProjectionView> {
    const learning = this.learning
    if (learning === undefined) throw new ExperienceError('internal', 'Experience learning worker is not ready')
    await learning.drain()
    return this.ready().getLearningProjection(origin)
  }

  /** Read current automation governance without changing capability levels. */
  getLearningGovernance(origin: TrustedCommandOrigin): LearningGovernanceView {
    return this.ready().getLearningGovernance(origin)
  }

  /** Read one paginated exact-subject domain audit dossier. */
  getAuditDossier(input: AuditQueryInput, origin: TrustedCommandOrigin): AuditDossierView {
    return this.ready().getAuditDossier(input, origin)
  }

  /** Export one immutable Version as a receipt-bound Markdown projection. */
  exportMarkdown(input: ExportMarkdownInput, origin: TrustedCommandOrigin): Promise<MarkdownProjectionView> {
    return this.ready().exportMarkdown(input, origin)
  }

  /** Create a structured RevisionProposal from one receipt-bound Markdown edit. */
  proposeMarkdownRevision(
    input: ProposeMarkdownRevisionInput,
    origin: TrustedCommandOrigin,
  ): Promise<MarkdownDomainReceipt> {
    return this.ready().proposeMarkdownRevision(input, origin)
  }

  /** Read one exact stored Markdown projection. */
  getMarkdownProjection(receiptId: string, origin: TrustedCommandOrigin): MarkdownProjectionView {
    return this.ready().getMarkdownProjection(receiptId, origin)
  }

  /** Read the rebuildable relation map derived from canonical relations. */
  getRelationMap(origin: TrustedCommandOrigin): RelationMapView {
    return this.ready().getRelationMap(origin)
  }

  /** Freeze current SQLite graph-storage readiness signals. */
  evaluateInfrastructureReadiness(
    input: EvaluateInfrastructureReadinessInput,
    origin: TrustedCommandOrigin,
  ): Promise<InfrastructureDomainReceipt> {
    return this.ready().evaluateInfrastructureReadiness(input, origin)
  }

  /** Read current graph-storage readiness without changing storage. */
  getInfrastructureReadiness(origin: TrustedCommandOrigin): InfrastructureReadinessView {
    return this.ready().getInfrastructureReadiness(origin)
  }

  /** Record one source-backed frozen-corpus evaluation observation. */
  recordEvaluationObservation(
    input: RecordEvaluationObservationInput,
    origin: TrustedCommandOrigin,
  ): Promise<EvaluationDomainReceipt> {
    return this.ready().recordEvaluationObservation(input, origin)
  }

  /** Read one comparability-checked three-arm evaluation report. */
  getEvaluationReport(cohortId: string, origin: TrustedCommandOrigin): EvaluationReportView {
    return this.ready().getEvaluationReport(cohortId, origin)
  }

  /** Evaluate one capability after draining all due source records. */
  async evaluateUnlockContract(
    input: EvaluateUnlockContractInput,
    origin: TrustedCommandOrigin,
  ): Promise<LearningGovernanceReceipt> {
    const learning = this.learning
    if (learning === undefined) throw new ExperienceError('internal', 'Experience learning worker is not ready')
    await learning.drain()
    return this.ready().evaluateUnlockContract(input, origin)
  }

  /** Apply one bounded owner promotion or immediate safety demotion. */
  changeAutomationLevel(
    input: ChangeAutomationLevelInput,
    origin: TrustedCommandOrigin,
  ): Promise<LearningGovernanceReceipt> {
    return this.ready().changeAutomationLevel(input, origin)
  }

  /** Record one owner-only review of a readable shadow history-ranking counterfactual. */
  reviewHistoryRanking(
    input: RankHistoryRankingInput,
    origin: TrustedCommandOrigin,
  ): Promise<LearningGovernanceReceipt> {
    return this.ready().reviewHistoryRanking(input, origin)
  }

  /** Read the immutable owner history-ranking reviews. */
  readHistoryRankingReviews(origin: TrustedCommandOrigin): HistoryRankingReviewView[] {
    return this.ready().readHistoryRankingReviews(origin)
  }

  /** Preview the owner-visible consequences before committing Forget. */
  previewForget(
    experienceId: ExperienceVersionView['experienceId'],
    origin: TrustedCommandOrigin,
  ): ForgetImpactPreviewView {
    return this.ready().previewForget(experienceId, origin)
  }

  /** Stop future recall before reconciling Session and learning projections. */
  forgetExperience(input: ForgetExperienceInput, origin: TrustedCommandOrigin): Promise<ForgetDomainReceipt> {
    return this.ready().forgetExperience(input, origin)
  }

  /** Read one durable Forget result with honest partial-failure status. */
  getForgetRequest(forgetRequestId: string, origin: TrustedCommandOrigin): ForgetRequestView {
    return this.ready().getForgetRequest(forgetRequestId, origin)
  }

  /** Disclose the exact M3 proposal mode before task submission. */
  getPlanningConfiguration(): PlanningConfigurationView {
    const snapshot = this.runtimeSettings.capture()
    const runtime = snapshot.values
    return {
      taskFingerprintProposalMode: this.config.taskFingerprintProposalMode,
      provider: this.config.taskFingerprintProposalMode === 'model' ? runtime.provider : null,
      model: this.config.taskFingerprintProposalMode === 'model' ? runtime.model : null,
      maxOutputTokens: this.config.taskFingerprintProposalMode === 'model'
        ? runtime.taskFingerprintMaxTokens : null,
      promptVersion: 'task-fingerprint-v1',
    }
  }

  /** Read automation controls without conflating them with planning-model configuration. */
  getAutomationConfiguration(origin: TrustedCommandOrigin): AutomationConfigurationView {
    const actor = this.actors?.resolve(origin)
    if (actor === undefined) throw new ExperienceError('internal', 'Experience service is not ready')
    if (actor.authority !== 'owner') {
      throw new ExperienceError('principal_unauthorized', 'Experience automation configuration is owner-only')
    }
    return automationConfiguration(this.runtimeSettings.capture())
  }

  private ready(): ExperienceApplicationService {
    if (this.application === undefined) {
      throw new ExperienceError('internal', 'Experience service is not ready')
    }
    return this.application
  }
}

function resolveVerifiedOutcomeManifest(value: unknown): import('./types.js').VerifiedOutcomeManifestConfig | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !isRecord(value.episode) || !Array.isArray(value.criteria)) {
    throw new ExperienceError('invalid_command', 'verifiedOutcomeManifest must be a complete object or absent')
  }
  const episode = value.episode
  const sessionId = requiredConfigString(episode.sessionId, 'verifiedOutcomeManifest.episode.sessionId')
  const contentDigest = requiredConfigString(episode.contentDigest, 'verifiedOutcomeManifest.episode.contentDigest')
  if (!Number.isSafeInteger(episode.eventStart) || (episode.eventStart as number) < 0
    || !Number.isSafeInteger(episode.eventEnd) || (episode.eventEnd as number) < (episode.eventStart as number)) {
    throw new ExperienceError('invalid_command', 'verifiedOutcomeManifest Episode range is invalid')
  }
  const criteria = value.criteria.map((item, index) => {
    if (!isRecord(item) || typeof item.mandatory !== 'boolean'
      || (item.result !== 'pass' && item.result !== 'fail' && item.result !== 'unknown')
      || !Array.isArray(item.evidence)) {
      throw new ExperienceError('invalid_command', `verifiedOutcomeManifest criterion ${String(index)} is invalid`)
    }
    return {
      criterionId: requiredConfigString(item.criterionId, `verifiedOutcomeManifest.criteria[${String(index)}].criterionId`),
      mandatory: item.mandatory,
      result: item.result as 'pass' | 'fail' | 'unknown',
      evidence: item.evidence.map((source, sourceIndex) => {
        if (!isRecord(source)) {
          throw new ExperienceError('invalid_command', `verifiedOutcomeManifest criterion source ${String(sourceIndex)} is invalid`)
        }
        return {
          path: requiredAbsolutePath(source.path, 'verifiedOutcomeManifest.evidence.path'),
          locator: requiredConfigString(source.locator, 'verifiedOutcomeManifest.evidence.locator'),
          contentDigest: requiredConfigString(source.contentDigest, 'verifiedOutcomeManifest.evidence.contentDigest'),
          bytes: requiredPositiveInteger(source.bytes, 'verifiedOutcomeManifest.evidence.bytes'),
        }
      }),
    }
  })
  if (criteria.length === 0) {
    throw new ExperienceError('invalid_command', 'verifiedOutcomeManifest requires at least one criterion')
  }
  return {
    episode: {
      sessionId,
      eventStart: episode.eventStart as number,
      eventEnd: episode.eventEnd as number,
      contentDigest,
    },
    policyVersion: requiredConfigString(value.policyVersion, 'verifiedOutcomeManifest.policyVersion'),
    criteria,
  }
}

function requiredConfigString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExperienceError('invalid_command', `${field} must be a non-empty string`)
  }
  return value
}

function requiredAbsolutePath(value: unknown, field: string): string {
  const path = requiredConfigString(value, field)
  if (!isAbsolute(path)) throw new ExperienceError('invalid_command', `${field} must be absolute`)
  return path
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExperienceError('invalid_command', `${field} must be a positive safe integer`)
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default Experiences

function resolveHistoricalSource(config: Config): HistoricalSourceConfig | undefined {
  const values = [
    config.historicalSourcePath,
    config.historicalSourceRunId,
    config.historicalSourceAggregateDigest,
  ]
  const configured = values.filter(value => value !== undefined).length
  if (configured === 0 && config.historicalSourceRecords.length === 0) return undefined
  if (configured !== values.length || config.historicalSourceRecords.length === 0) {
    throw new ExperienceError('invalid_command', 'historical source configuration must be complete or absent')
  }
  const path = config.historicalSourcePath!
  if (!isAbsolute(path)) {
    throw new ExperienceError('invalid_command', 'historicalSource.path must be absolute')
  }
  const runId = config.historicalSourceRunId!
  const aggregateDigest = config.historicalSourceAggregateDigest!
  if (runId.trim() === '' || aggregateDigest.trim() === '') {
    throw new ExperienceError('invalid_command', 'historicalSource must identify one exact non-empty M0 selection')
  }
  return { path, runId, aggregateDigest, records: config.historicalSourceRecords }
}
