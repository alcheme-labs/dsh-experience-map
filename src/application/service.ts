import type { CandidateId, ExperienceVersionId, ReceiptId, ExperienceRelationId, OverrideDecisionId } from '../ids.js'
import type {
  CandidateCommandInput,
  CandidateDispositionInput,
  CandidateSummaryView,
  CandidateView,
  DecideCandidateFieldInput,
  DomainReceipt,
  ExperienceDomainReceipt,
  M5DomainReceipt,
  ExperienceStatusView,
  ExperienceVersionView,
  ProposalSourceInspectionInput,
  ProposalSourceInspectionView,
  ProposeCandidateInput,
  PlanTaskCommandInput,
  DecidePlanCommandInput,
  PlanningCommandResult,
  PlanningResultView,
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
  ExperienceSuggestionGroupView,
  SaveExperienceSuggestionInput,
  SuggestionSaveDomainReceipt,
} from '../types.js'
import { ActorResolver, type TrustedCommandOrigin } from './actor-resolver.js'
import { ExperienceRepository } from '../persistence/repository.js'
import type { CandidateProposalService } from './candidate-service.js'
import type { ExperiencePlanningService } from './planning-service.js'
import type { ExperienceExecutionService } from './execution-service.js'
import type { WebUsageVerifier } from '../adapters/web-verifier.js'
import type { ExperienceForgetService } from './forget-service.js'
import { ExperienceError } from '../errors.js'
import type { RuntimeSettingsSource } from '../runtime-settings.js'

/** Application use cases; callers cannot access the repository or supply an ActorView. */
export class ExperienceApplicationService {
  /** Bind application use cases to their repository and trusted-origin resolver. */
  constructor(
    private readonly repository: ExperienceRepository,
    private readonly actors: ActorResolver,
    private readonly proposals?: CandidateProposalService,
    private readonly maxInlineFieldBytes = 16_384,
    private readonly planning?: ExperiencePlanningService,
    private readonly execution?: ExperienceExecutionService,
    private readonly verifier?: WebUsageVerifier,
    private readonly forget?: ExperienceForgetService,
    private readonly maxMarkdownProjectionBytes?: number,
    private readonly runtimeSettings?: RuntimeSettingsSource,
  ) {}

  /** Inspect a terminal Episode and return the exact external-model disclosure. */
  inspectProposalSource(
    input: ProposalSourceInspectionInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<ProposalSourceInspectionView> {
    return this.proposalService().inspect(
      input,
      this.actors.resolve(origin),
      signal,
      this.runtimeSettings?.capture(),
    )
  }

  /** Generate and persist one source-bound Candidate after explicit disclosure confirmation. */
  proposeCandidate(
    input: ProposeCandidateInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<DomainReceipt> {
    return this.proposalService().propose(
      input,
      this.actors.resolve(origin),
      signal,
      this.runtimeSettings?.capture(),
    )
  }

  /** Move a proposed Candidate into field review. */
  submitCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.repository.submitCandidate(input, this.actors.resolve(origin))
  }

  /** Persist one explicit field decision. */
  decideCandidateField(input: DecideCandidateFieldInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.repository.decideCandidateField(input, this.actors.resolve(origin), this.inlineFieldLimit())
  }

  /** Accept one fully and affirmatively reviewed Candidate. */
  acceptCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.repository.acceptCandidate(input, this.actors.resolve(origin), this.inlineFieldLimit())
  }

  /** Reject one in-review Candidate with a stable reason. */
  rejectCandidate(input: CandidateDispositionInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.repository.rejectCandidate(input, this.actors.resolve(origin))
  }

  /** Withdraw one unpublished Candidate. */
  withdrawCandidate(input: CandidateDispositionInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.repository.withdrawCandidate(input, this.actors.resolve(origin))
  }

  /** Publish one accepted Candidate as an immutable source-bound Version. */
  publishCandidate(input: CandidateCommandInput, origin: TrustedCommandOrigin): Promise<DomainReceipt> {
    return this.repository.publishCandidate(input, this.actors.resolve(origin), this.inlineFieldLimit())
  }

  /** Commit one already-resolved, owner-reviewed suggestion snapshot. */
  saveExperienceSuggestion(
    input: SaveExperienceSuggestionInput,
    group: ExperienceSuggestionGroupView,
    origin: TrustedCommandOrigin,
  ): Promise<SuggestionSaveDomainReceipt> {
    return this.repository.saveExperienceSuggestion(
      input,
      group,
      this.actors.resolve(origin),
      this.inlineFieldLimit(),
    )
  }

  /** Read one durable Candidate. */
  getCandidate(candidateId: CandidateId, origin: TrustedCommandOrigin): CandidateView {
    return this.repository.getCandidate(candidateId, this.actors.resolve(origin))
  }

  /** Read the owner Candidate inbox. */
  listCandidates(origin: TrustedCommandOrigin): CandidateSummaryView[] {
    return this.repository.listCandidates(this.actors.resolve(origin))
  }

  /** Query one durable receipt. */
  getReceipt(receiptId: ReceiptId, origin: TrustedCommandOrigin): ExperienceDomainReceipt {
    return this.repository.getReceipt(receiptId, this.actors.resolve(origin))
  }

  /** Query one immutable published version. */
  getVersion(versionId: ExperienceVersionId, origin: TrustedCommandOrigin): ExperienceVersionView {
    return this.repository.getVersion(versionId, this.actors.resolve(origin))
  }

  /** Declare one canonical typed relation. */
  declareRelation(input: DeclareExperienceRelationInput, origin: TrustedCommandOrigin): Promise<RelationDomainReceipt> {
    return this.repository.declareRelation(input, this.actors.resolve(origin))
  }

  /** Read one canonical typed relation. */
  getRelation(relationId: ExperienceRelationId, origin: TrustedCommandOrigin): ExperienceRelationView {
    return this.repository.getRelation(relationId, this.actors.resolve(origin))
  }

  /** List canonical relations touching one exact object. */
  listRelations(objectRef: ExperienceRelationObjectRef, origin: TrustedCommandOrigin): ExperienceRelationView[] {
    return this.repository.listRelations(objectRef, this.actors.resolve(origin))
  }

  /** Create one current-Usage conflict override. */
  createOverride(input: CreateOverrideDecisionInput, origin: TrustedCommandOrigin): Promise<RelationDomainReceipt> {
    return this.repository.createOverride(input, this.actors.resolve(origin))
  }

  /** Read one current-Usage conflict override. */
  getOverride(overrideDecisionId: OverrideDecisionId, origin: TrustedCommandOrigin): OverrideDecisionView {
    return this.repository.getOverride(overrideDecisionId, this.actors.resolve(origin))
  }

  /** Query the authoritative summary projected for one trusted origin. */
  getStatus(origin: TrustedCommandOrigin): ExperienceStatusView {
    return this.repository.getStatus(this.actors.resolve(origin))
  }

  /** Match current task facts and persist one exact M3 UsagePlan. */
  planTask(
    input: PlanTaskCommandInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<PlanningCommandResult> {
    return this.planningService().plan(
      input,
      this.actors.resolve(origin),
      signal,
      this.runtimeSettings?.capture(),
    )
  }

  /** Decide one exact pending plan revision. */
  decidePlan(input: DecidePlanCommandInput, origin: TrustedCommandOrigin): Promise<PlanningCommandResult> {
    return this.planningService().decide(input, this.actors.resolve(origin))
  }

  /** Read one durable M3 planning projection. */
  getPlanningResult(usageId: string, origin: TrustedCommandOrigin): PlanningResultView {
    return this.repository.getPlanningResult(usageId, this.actors.resolve(origin))
  }

  /** List recent M3 planning projections. */
  listPlanningResults(origin: TrustedCommandOrigin, limit?: number): PlanningResultView[] {
    const selectedLimit = limit ?? this.runtimeSettings?.capture().values.planningHistoryLimit
    if (selectedLimit === undefined) throw new ExperienceError('internal', 'Planning history limit is not configured')
    return this.repository.listPlanningResults(this.actors.resolve(origin), selectedLimit)
  }

  /** Read one Host-authoritative M4 Context delivery explanation. */
  getContextUsage(usageId: string, origin: TrustedCommandOrigin): ContextUsageView {
    return this.repository.getContextUsage(usageId, this.actors.resolve(origin))
  }

  /** Advance, pause, resume, deviate, or abort one exact guided cursor. */
  progressUsage(input: ProgressUsageInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.repository.progressUsage(input, this.actors.resolve(origin)).then(receipt => {
      const progress = this.repository.getUsageExecution(String(input.usageId), this.actors.resolve(origin)).progress
      if (progress?.state === 'aborted') this.executionService().finish(String(progress.usageId))
      return receipt
    })
  }

  /** Run and persist the five fixed Web authority verifiers. */
  async verifyUsage(
    input: VerifyUsageInput,
    origin: TrustedCommandOrigin,
    signal?: AbortSignal,
  ): Promise<M5DomainReceipt> {
    const runtime = this.runtimeSettings?.capture()
    await this.executionService().flush(String(input.usageId))
    const actor = this.actors.resolve(origin)
    const current = this.repository.getUsageExecution(String(input.usageId), actor)
    return this.verifierService().verify(
      input,
      current,
      actor,
      signal,
      runtime?.values.verificationTimeoutMs,
    )
  }

  /** Settle one Usage from its exact latest VerificationRun. */
  async settleUsage(input: SettleUsageInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    const settlement = await this.repository.settleUsage(input, this.actors.resolve(origin))
    this.executionService().finish(String(input.usageId))
    return settlement
  }

  /** Read one complete Host-authoritative M5 execution projection. */
  getUsageExecution(usageId: string, origin: TrustedCommandOrigin): UsageExecutionView {
    return this.repository.getUsageExecution(usageId, this.actors.resolve(origin))
  }

  /** Derive one bounded RevisionProposal from a settled stale Usage. */
  proposeRevision(input: ProposeRevisionInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.repository.proposeRevision(input, this.actors.resolve(origin))
  }

  /** Decide one exact RevisionProposal change. */
  decideRevisionChange(input: DecideRevisionChangeInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.repository.decideRevisionChange(input, this.actors.resolve(origin))
  }

  /** Publish one fully accepted RevisionProposal as a new immutable Version. */
  publishRevision(input: PublishRevisionInput, origin: TrustedCommandOrigin): Promise<M5DomainReceipt> {
    return this.repository.publishRevision(input, this.actors.resolve(origin))
  }

  /** Read one durable RevisionProposal. */
  getRevisionProposal(revisionProposalId: string, origin: TrustedCommandOrigin): RevisionProposalView {
    return this.repository.getRevisionProposal(revisionProposalId, this.actors.resolve(origin))
  }

  /** Read the rebuildable M6 learning projection. */
  getLearningProjection(origin: TrustedCommandOrigin): LearningProjectionView {
    return this.repository.getLearningProjection(this.actors.resolve(origin))
  }

  /** Read the current independent automation policies and frozen evaluations. */
  getLearningGovernance(origin: TrustedCommandOrigin): LearningGovernanceView {
    return this.repository.getLearningGovernance(this.actors.resolve(origin))
  }

  /** Read one exact Experience or Usage audit dossier. */
  getAuditDossier(input: AuditQueryInput, origin: TrustedCommandOrigin): AuditDossierView {
    return this.repository.getAuditDossier(input, this.actors.resolve(origin))
  }

  /** Export one immutable Version as a durable Markdown projection. */
  exportMarkdown(input: ExportMarkdownInput, origin: TrustedCommandOrigin): Promise<MarkdownProjectionView> {
    return this.repository.exportMarkdown(input, this.actors.resolve(origin), this.markdownLimit())
  }

  /** Create a reviewable structured RevisionProposal from one edited projection. */
  proposeMarkdownRevision(
    input: ProposeMarkdownRevisionInput,
    origin: TrustedCommandOrigin,
  ): Promise<MarkdownDomainReceipt> {
    return this.repository.proposeMarkdownRevision(input, this.actors.resolve(origin), this.markdownLimit())
  }

  /** Read one exact stored Markdown projection. */
  getMarkdownProjection(receiptId: string, origin: TrustedCommandOrigin): MarkdownProjectionView {
    return this.repository.getMarkdownProjection(receiptId, this.actors.resolve(origin))
  }

  /** Read the rebuildable relation map derived from canonical relations. */
  getRelationMap(origin: TrustedCommandOrigin): RelationMapView {
    return this.repository.getRelationMap(this.actors.resolve(origin))
  }

  /** Freeze current SQLite graph-storage readiness signals. */
  evaluateInfrastructureReadiness(
    input: EvaluateInfrastructureReadinessInput,
    origin: TrustedCommandOrigin,
  ): Promise<InfrastructureDomainReceipt> {
    return this.repository.evaluateInfrastructureReadiness(input, this.actors.resolve(origin))
  }

  /** Read current graph-storage readiness without changing storage. */
  getInfrastructureReadiness(origin: TrustedCommandOrigin): InfrastructureReadinessView {
    return this.repository.getInfrastructureReadiness(this.actors.resolve(origin))
  }

  /** Record one source-backed frozen-corpus evaluation result. */
  recordEvaluationObservation(
    input: RecordEvaluationObservationInput,
    origin: TrustedCommandOrigin,
  ): Promise<EvaluationDomainReceipt> {
    return this.repository.recordEvaluationObservation(input, this.actors.resolve(origin))
  }

  /** Read one comparability-checked three-arm evaluation report. */
  getEvaluationReport(cohortId: string, origin: TrustedCommandOrigin): EvaluationReportView {
    return this.repository.getEvaluationReport(cohortId, this.actors.resolve(origin))
  }

  private markdownLimit(): number {
    const limit = this.runtimeSettings?.capture().values.maxMarkdownProjectionBytes
      ?? this.maxMarkdownProjectionBytes
    if (limit === undefined) {
      throw new ExperienceError('internal', 'Markdown projection limit is not configured')
    }
    return limit
  }

  private inlineFieldLimit(): number {
    return this.runtimeSettings?.capture().values.maxInlineFieldBytes ?? this.maxInlineFieldBytes
  }

  /** Freeze one evaluation over the current source-bound learning rows. */
  evaluateUnlockContract(
    input: EvaluateUnlockContractInput,
    origin: TrustedCommandOrigin,
  ): Promise<LearningGovernanceReceipt> {
    return this.repository.evaluateUnlockContract(input, this.actors.resolve(origin))
  }

  /** Apply one bounded owner promotion or immediate safety demotion. */
  changeAutomationLevel(
    input: ChangeAutomationLevelInput,
    origin: TrustedCommandOrigin,
  ): Promise<LearningGovernanceReceipt> {
    return this.repository.changeAutomationLevel(input, this.actors.resolve(origin))
  }

  /** Record one owner-only review of a readable shadow history-ranking counterfactual. */
  reviewHistoryRanking(
    input: RankHistoryRankingInput,
    origin: TrustedCommandOrigin,
  ): Promise<LearningGovernanceReceipt> {
    return this.repository.reviewHistoryRanking(input, this.actors.resolve(origin))
  }

  /** Read the immutable owner history-ranking reviews. */
  readHistoryRankingReviews(origin: TrustedCommandOrigin): HistoryRankingReviewView[] {
    return this.repository.readHistoryRankingReviews(this.actors.resolve(origin))
  }

  /** Preview the current impact of stopping recall for one Experience. */
  previewForget(experienceId: ExperienceVersionView['experienceId'], origin: TrustedCommandOrigin): ForgetImpactPreviewView {
    return this.forgetService().preview(experienceId, origin)
  }

  /** Stop canonical recall, then reconcile active Context and rebuildable projections. */
  forgetExperience(input: ForgetExperienceInput, origin: TrustedCommandOrigin): Promise<ForgetDomainReceipt> {
    return this.forgetService().forget(input, origin)
  }

  /** Read one durable Forget request. */
  getForgetRequest(forgetRequestId: string, origin: TrustedCommandOrigin): ForgetRequestView {
    return this.forgetService().get(forgetRequestId, origin)
  }

  private proposalService(): CandidateProposalService {
    if (this.proposals === undefined) {
      throw new Error('Experience proposal service is unavailable in this Profile')
    }
    return this.proposals
  }

  private planningService(): ExperiencePlanningService {
    if (this.planning === undefined) throw new Error('Experience planning service is unavailable in this Profile')
    return this.planning
  }

  private executionService(): ExperienceExecutionService {
    if (this.execution === undefined) throw new Error('Experience execution service is unavailable in this Profile')
    return this.execution
  }

  private verifierService(): WebUsageVerifier {
    if (this.verifier === undefined) throw new Error('Experience verifier is unavailable in this Profile')
    return this.verifier
  }

  private forgetService(): ExperienceForgetService {
    if (this.forget === undefined) throw new Error('Experience Forget service is unavailable in this Profile')
    return this.forget
  }
}
