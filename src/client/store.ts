import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type {
  CandidateFieldReviewInput,
  CandidateSummaryView,
  CandidateView,
  DomainReceipt,
  ExperienceDomainReceipt,
  M5DomainReceipt,
  ExperienceStatusView,
  ExperienceVersionView,
  ProposalOutputTokenLimitInput,
  ProposalSourceInspectionView,
  PlanningResultView,
  PlanningCommandResult,
  PlanningTaskInput,
  PlanningConfigurationView,
  AutomationConfigurationView,
  ContextUsageView,
  UsageExecutionView,
  LearningProjectionView,
  ProgressUsageInput,
  RevisionProposalView,
  ForgetImpactPreviewView,
  ForgetRequestView,
  ForgetDomainReceipt,
  LearningGovernanceCapability,
  LearningPredictionView,
  LearningGovernanceReceipt,
  LearningGovernanceView,
  AuditDossierView,
  AuditSubjectRef,
  MarkdownProjectionView,
  RelationMapView,
  InfrastructureReadinessView,
  EvaluationReportView,
  ExperienceSuggestionGroupView,
  SuggestionProjectionView,
  SuggestionSaveDomainReceipt,
  SuggestionOwnerChoiceInput,
  ExperienceRetrievalProjectionView,
} from '../types.js'
import type { ExperienceKind } from '../domain/kind.js'
import { experienceRpcConnection } from './rpc.js'

const CHANNEL = '/experience-map'

/** Complete Browser read model; raw source excerpts remain only in the inspection response. */
export interface ViewState {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly status?: ExperienceStatusView | undefined
  readonly suggestions?: SuggestionProjectionView | undefined
  readonly retrieval?: ExperienceRetrievalProjectionView | undefined
  readonly candidates: readonly CandidateSummaryView[]
  readonly planningResults: readonly PlanningResultView[]
  readonly planningConfiguration?: PlanningConfigurationView | undefined
  readonly automationConfiguration?: AutomationConfigurationView | undefined
  readonly selectedPlanning?: PlanningResultView | undefined
  readonly selectedContext?: ContextUsageView | undefined
  readonly selectedExecution?: UsageExecutionView | undefined
  readonly selected?: CandidateView | undefined
  readonly learning?: LearningProjectionView | undefined
  readonly learningGovernance?: LearningGovernanceView | undefined
  readonly audit?: AuditDossierView | undefined
  readonly markdownProjection?: MarkdownProjectionView | undefined
  readonly markdownRevision?: RevisionProposalView | undefined
  readonly relationMap?: RelationMapView | undefined
  readonly infrastructureReadiness?: InfrastructureReadinessView | undefined
  readonly evaluationReport?: EvaluationReportView | undefined
  readonly forgetPreview?: ForgetImpactPreviewView | undefined
  readonly forgetRequest?: ForgetRequestView | undefined
  readonly inspection?: ProposalSourceInspectionView | undefined
  readonly receipt?: ExperienceDomainReceipt | undefined
  readonly version?: ExperienceVersionView | undefined
  readonly error?: string | undefined
  readonly proposalStatus: 'idle' | 'generating' | 'succeeded' | 'failed'
  readonly proposalFailure?: ProposalFailureView | undefined
  readonly running: boolean
  readonly confirmedDisclosureDigest?: string | undefined
}

/** Public Host failure retained for an adjacent, actionable proposal status. */
export interface ProposalFailureView {
  readonly code: string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/** State and commands owned by the in-Harness Experience tab. */
export interface ExperienceStore {
  getSnapshot(): ViewState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  reset(): Promise<void>
  inspect(sessionId: string, requestedKind: ExperienceKind, outputTokenLimit: ProposalOutputTokenLimitInput): Promise<void>
  confirmDisclosure(digest: string, confirmed: boolean): void
  propose(): Promise<void>
  select(candidateId: string): Promise<void>
  submit(): Promise<void>
  decide(field: string, review: Omit<CandidateFieldReviewInput, 'field'>): Promise<void>
  accept(): Promise<void>
  reject(reasonCode: string): Promise<void>
  withdraw(reasonCode: string): Promise<void>
  publishCandidate(): Promise<void>
  saveSuggestion(group: ExperienceSuggestionGroupView, ownerChoice?: SuggestionOwnerChoiceInput): Promise<void>
  dismissSuggestion(
    group: ExperienceSuggestionGroupView,
    reasonCode: 'not_reusable' | 'one_off_task' | 'incorrect_abstraction' | 'privacy_choice',
  ): Promise<void>
  planTask(sessionId: string, task: PlanningTaskInput, confirmExternalModelProcessing: boolean): Promise<void>
  selectPlanning(usageId: string): Promise<void>
  decidePlanning(decision: 'approve' | 'deny' | 'withdraw', reason: string): Promise<void>
  progressUsage(action: ProgressUsageInput['action'], reason: string, options?: {
    readonly targetStepRef?: string
    readonly branchRef?: string
  }): Promise<void>
  verifyUsage(): Promise<void>
  settleUsage(): Promise<void>
  proposeRevision(baseVersionId: string): Promise<void>
  decideRevision(changeId: string, decision: 'accept' | 'reject', reason: string): Promise<void>
  publishRevision(): Promise<void>
  previewForget(): Promise<void>
  forgetExperience(reason: string): Promise<void>
  reviewHistoryRanking(row: LearningPredictionView, preferredOrder: 'proposed' | 'baseline' | 'equivalent' | 'unknown', reason: string, sourceUsageId: string): Promise<void>
  evaluateLearningCapability(capability: LearningGovernanceCapability): Promise<void>
  changeAutomationLevel(
    capability: LearningGovernanceCapability,
    action: 'promote' | 'demote',
    targetLevel: 'disabled' | 'shadow' | 'suggest',
    evaluationId: string | null,
    reason: string,
    violationClass: 'none' | 'safety' | 'privacy' | 'permission' | 'metric_drift' | 'unknown_spike',
  ): Promise<void>
  loadAudit(subject: AuditSubjectRef, cursor?: string | null): Promise<void>
  exportMarkdown(): Promise<void>
  proposeMarkdownRevision(editedMarkdown: string): Promise<void>
  evaluateInfrastructureReadiness(): Promise<void>
  loadEvaluationReport(cohortId: string): Promise<void>
}

/** Create one connection-backed controller for one mounted Session-scoped view. */
export function createStore(hostConnection: ConnectionHandle): ExperienceStore {
  const connection = experienceRpcConnection(hostConnection)
  let state: ViewState = initialState()
  const listeners = new Set<() => void>()
  const publish = (next: ViewState): void => {
    state = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }
  const run = async (operation: () => Promise<void>, context?: 'proposal'): Promise<void> => {
    publish({
      ...state,
      running: true,
      error: undefined,
      ...(context === 'proposal' ? { proposalStatus: 'generating' as const, proposalFailure: undefined } : {}),
    })
    try {
      await operation()
      publish({
        ...state,
        phase: 'ready',
        running: false,
        error: undefined,
        ...(context === 'proposal' ? { proposalStatus: 'succeeded' as const } : {}),
      })
    } catch (error) {
      const failure = publicRpcFailure(error)
      publish({
        ...state,
        phase: context === 'proposal' ? 'ready' : 'error',
        running: false,
        error: context === 'proposal' ? undefined : failure.message,
        ...(context === 'proposal'
          ? { proposalStatus: 'failed' as const, proposalFailure: failure }
          : {}),
      })
    }
  }
  const readCandidate = async (candidateId: string): Promise<CandidateView> =>
    value(await connection.rpc.call(CHANNEL, 'candidate/get', { candidateId })) as CandidateView
  const refresh = (): Promise<void> => run(async () => {
    const [status, suggestions, retrieval, candidates, planning, planningConfiguration, automationConfiguration,
      learning, learningGovernance,
      relationMap, infrastructureReadiness] = await Promise.all([
      connection.rpc.call(CHANNEL, 'status/query', {}),
      connection.rpc.call(CHANNEL, 'suggestions/query', {}),
      connection.rpc.call(CHANNEL, 'retrieval/query', {}),
      connection.rpc.call(CHANNEL, 'candidate/list', {}),
      connection.rpc.call(CHANNEL, 'plan/list', {}),
      connection.rpc.call(CHANNEL, 'plan/config', {}),
      connection.rpc.call(CHANNEL, 'automation/config', {}),
      connection.rpc.call(CHANNEL, 'learning/query', {}),
      connection.rpc.call(CHANNEL, 'learning/governance', {}),
      connection.rpc.call(CHANNEL, 'relation-map/query', {}),
      connection.rpc.call(CHANNEL, 'infrastructure/readiness', {}),
    ])
    const nextStatus = readStatus(status)
    const nextCandidates = value(candidates) as CandidateSummaryView[]
    const nextPlanning = value(planning) as PlanningResultView[]
    const selectedId = state.selected?.candidateId
    const selected = selectedId === undefined || !nextCandidates.some(item => item.candidateId === selectedId)
      ? undefined
      : await readCandidate(selectedId)
    const selectedUsageId = state.selectedPlanning?.plan.usageId
    const selectedPlanning = selectedUsageId === undefined
      ? nextPlanning[0]
      : nextPlanning.find(item => item.plan.usageId === selectedUsageId) ?? nextPlanning[0]
    const [selectedContext, selectedExecution] = selectedPlanning === undefined ? [undefined, undefined]
      : await Promise.all([
        connection.rpc.call(CHANNEL, 'context/get', { usageId: selectedPlanning.plan.usageId })
          .then(result => value(result) as ContextUsageView),
        connection.rpc.call(CHANNEL, 'usage/get', { usageId: selectedPlanning.plan.usageId })
          .then(result => value(result) as UsageExecutionView),
      ])
    publish({
      ...state,
      phase: 'ready',
      status: nextStatus,
      suggestions: value(suggestions) as SuggestionProjectionView,
      retrieval: value(retrieval) as ExperienceRetrievalProjectionView,
      candidates: nextCandidates,
      receipt: nextStatus.latestReceipt ?? undefined,
      version: nextStatus.latestVersion ?? undefined,
      selected,
      planningResults: nextPlanning,
      selectedPlanning,
      selectedContext,
      selectedExecution,
      planningConfiguration: value(planningConfiguration) as PlanningConfigurationView,
      automationConfiguration: value(automationConfiguration) as AutomationConfigurationView,
      learning: value(learning) as LearningProjectionView,
      learningGovernance: value(learningGovernance) as LearningGovernanceView,
      relationMap: value(relationMap) as RelationMapView,
      infrastructureReadiness: value(infrastructureReadiness) as InfrastructureReadinessView,
      forgetRequest: nextStatus.latestForgetRequest ?? undefined,
    })
  })
  const mutate = async (endpoint: string, input: unknown): Promise<void> => run(async () => {
    const receipt = await writeAndReadCandidateReceipt(connection, endpoint, input)
    const selected = await readCandidate(receipt.candidateId)
    const candidates = value(await connection.rpc.call(CHANNEL, 'candidate/list', {})) as CandidateSummaryView[]
    let version: ExperienceVersionView | undefined
    if (receipt.experienceVersionId !== null) {
      version = value(await connection.rpc.call(CHANNEL, 'version/get', {
        experienceVersionId: receipt.experienceVersionId,
      })) as ExperienceVersionView
    }
    publish({
      ...state,
      phase: 'ready',
      candidates,
      selected,
      receipt,
      ...(version === undefined ? {} : { version }),
    })
  })
  const command = (candidate: CandidateView): Record<string, unknown> => ({
    commandId: crypto.randomUUID(),
    candidateId: candidate.candidateId,
    expectedRevision: candidate.candidateRevision,
    correlationId: crypto.randomUUID(),
    causationId: state.receipt?.receiptId ?? null,
    issuedAt: new Date().toISOString(),
  })
  const m5Command = (): Record<string, unknown> => ({
    commandId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    causationId: state.receipt?.receiptId ?? null,
    issuedAt: new Date().toISOString(),
  })
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    reset: async () => {
      publish(initialState())
      await refresh()
    },
    inspect: (sessionId, requestedKind, outputTokenLimit) => run(async () => {
      const inspection = value(await connection.rpc.call(CHANNEL, 'proposal-source/inspect', {
        episode: { sessionId },
        requestedKind,
        outputTokenLimit,
        requestedTriggerKind: 'terminal_success',
      })) as ProposalSourceInspectionView
      publish({
        ...state,
        phase: 'ready',
        inspection,
        receipt: undefined,
        version: undefined,
        proposalStatus: 'idle',
        proposalFailure: undefined,
        confirmedDisclosureDigest: undefined,
      })
    }),
    confirmDisclosure: (digest, confirmed) => {
      const current = state.inspection?.disclosure.disclosureDigest
      publish({
        ...state,
        confirmedDisclosureDigest: confirmed && current === digest ? digest : undefined,
      })
    },
    propose: () => run(async () => {
      const inspection = state.inspection
      if (inspection === undefined) throw new Error('Inspect the current Session before proposing')
      const inspectedItemCount = inspection.evidencePacket.items.length
      if (inspection.disclosure.evidenceItemCount !== inspectedItemCount) {
        throw new Error('The disclosed evidence count does not match the locally inspected packet')
      }
      const disclosureDigest = inspection.disclosure.disclosureDigest
      if (state.confirmedDisclosureDigest !== disclosureDigest) {
        throw new Error('Confirm the exact external model disclosure before proposing')
      }
      publish({ ...state, confirmedDisclosureDigest: undefined })
      const episode = inspection.episode.episodeRef
      const receipt = await writeAndReadCandidateReceipt(connection, 'candidate/propose', {
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        causationId: null,
        issuedAt: new Date().toISOString(),
        episode: {
          sessionId: episode.sessionOrRunId,
          eventStart: episode.eventStart,
          eventEnd: episode.eventEnd,
          contentDigest: episode.contentDigest,
        },
        requestedKind: inspection.requestedKind,
        eligibilityDigest: inspection.eligibilityDigest,
        outputTokenLimit: inspection.outputTokenLimit,
        proposalDisclosureDigest: disclosureDigest,
        confirmedMaxOutputTokens: inspection.disclosure.maxOutputTokens,
        confirmExternalModelProcessing: true,
      })
      const selected = await readCandidate(receipt.candidateId)
      const candidates = value(await connection.rpc.call(CHANNEL, 'candidate/list', {})) as CandidateSummaryView[]
      publish({ ...state, phase: 'ready', receipt, selected, candidates, confirmedDisclosureDigest: undefined })
    }, 'proposal'),
    select: candidateId => run(async () => {
      const selected = await readCandidate(candidateId)
      const version = selected.publishedVersionId === null
        ? undefined
        : value(await connection.rpc.call(CHANNEL, 'version/get', {
          experienceVersionId: selected.publishedVersionId,
        })) as ExperienceVersionView
      publish({ ...state, phase: 'ready', selected, version })
    }),
    submit: async () => {
      const candidate = requiredCandidate(state)
      await mutate('candidate/submit', command(candidate))
    },
    decide: async (field, review) => {
      const candidate = requiredCandidate(state)
      await mutate('candidate/field-decide', { ...command(candidate), field, ...review })
    },
    accept: async () => {
      const candidate = requiredCandidate(state)
      await mutate('candidate/accept', command(candidate))
    },
    reject: async (reasonCode) => {
      const candidate = requiredCandidate(state)
      await mutate('candidate/reject', { ...command(candidate), reasonCode })
    },
    withdraw: async (reasonCode) => {
      const candidate = requiredCandidate(state)
      await mutate('candidate/withdraw', { ...command(candidate), reasonCode })
    },
    publishCandidate: async () => {
      const candidate = requiredCandidate(state)
      await mutate('candidate/publish', command(candidate))
    },
    saveSuggestion: (group, ownerChoice) => run(async () => {
      if (group.reviewDigest === null || (group.saveReadiness !== 'ready' && ownerChoice === undefined)) {
        throw new Error('Refresh the suggestion before saving')
      }
      const receipt = await writeAndReadReceipt(connection, 'suggestions/save', {
        commandId: crypto.randomUUID(),
        suggestionGroupId: group.suggestionGroupId,
        expectedRevisionDigest: group.revisionDigest,
        reviewDigest: group.reviewDigest,
        sourceDigest: group.sourceDigest,
        ...(ownerChoice === undefined ? {} : { ownerChoice }),
        correlationId: crypto.randomUUID(),
        causationId: state.receipt?.receiptId ?? null,
        issuedAt: new Date().toISOString(),
      })
      if (receipt.action !== 'suggestion.save') {
        throw new Error('Suggestion save returned another receipt type')
      }
      const saved = receipt as SuggestionSaveDomainReceipt
      const [suggestions, version] = await Promise.all([
        connection.rpc.call(CHANNEL, 'suggestions/query', {})
          .then(result => value(result) as SuggestionProjectionView),
        connection.rpc.call(CHANNEL, 'version/get', {
          experienceVersionId: saved.experienceVersionId,
        }).then(result => value(result) as ExperienceVersionView),
      ])
      publish({ ...state, suggestions, version, receipt: saved })
    }),
    dismissSuggestion: (group, reasonCode) => run(async () => {
      const suggestions = value(await connection.rpc.call(CHANNEL, 'suggestions/dismiss', { input: {
        commandId: crypto.randomUUID(),
        suggestionGroupId: group.suggestionGroupId,
        expectedRevisionDigest: group.revisionDigest,
        reviewDigest: group.reviewDigest,
        reasonCode,
        issuedAt: new Date().toISOString(),
      } })) as SuggestionProjectionView
      publish({ ...state, suggestions })
    }),
    planTask: (sessionId, task, confirmExternalModelProcessing) => run(async () => {
      const result = value(await connection.rpc.call(CHANNEL, 'plan/create', { input: {
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        causationId: state.receipt?.receiptId ?? null,
        issuedAt: new Date().toISOString(),
        sessionId,
        interaction: 'ask_current_agent',
        confirmExternalModelProcessing,
        task,
      } })) as PlanningCommandResult
      const planningResults = value(await connection.rpc.call(CHANNEL, 'plan/list', {})) as PlanningResultView[]
      const selectedContext = value(await connection.rpc.call(CHANNEL, 'context/get', {
        usageId: result.planning.plan.usageId,
      })) as ContextUsageView
      const selectedExecution = value(await connection.rpc.call(CHANNEL, 'usage/get', {
        usageId: result.planning.plan.usageId,
      })) as UsageExecutionView
      publish({ ...state, planningResults, selectedPlanning: result.planning, selectedContext, selectedExecution })
    }),
    selectPlanning: usageId => run(async () => {
      const [planning, context, execution] = await Promise.all([
        connection.rpc.call(CHANNEL, 'plan/get', { usageId }),
        connection.rpc.call(CHANNEL, 'context/get', { usageId }),
        connection.rpc.call(CHANNEL, 'usage/get', { usageId }),
      ])
      const selectedPlanning = value(planning) as PlanningResultView
      const selectedContext = value(context) as ContextUsageView
      const selectedExecution = value(execution) as UsageExecutionView
      publish({ ...state, selectedPlanning, selectedContext, selectedExecution })
    }),
    decidePlanning: (decision, reason) => run(async () => {
      const planning = state.selectedPlanning
      const request = planning?.approvalRequest
      if (planning === undefined || request === null || request === undefined) throw new Error('Select a pending plan first')
      const result = value(await connection.rpc.call(CHANNEL, 'plan/decide', { input: {
        commandId: crypto.randomUUID(),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: request.planRevision,
        decision,
        reason,
        correlationId: crypto.randomUUID(),
        causationId: null,
        issuedAt: new Date().toISOString(),
      } })) as PlanningCommandResult
      const planningResults = value(await connection.rpc.call(CHANNEL, 'plan/list', {})) as PlanningResultView[]
      const selectedContext = value(await connection.rpc.call(CHANNEL, 'context/get', {
        usageId: result.planning.plan.usageId,
      })) as ContextUsageView
      const selectedExecution = value(await connection.rpc.call(CHANNEL, 'usage/get', {
        usageId: result.planning.plan.usageId,
      })) as UsageExecutionView
      publish({ ...state, planningResults, selectedPlanning: result.planning, selectedContext, selectedExecution })
    }),
    progressUsage: (action, reason, options = {}) => run(async () => {
      const execution = requiredExecution(state)
      const progress = execution.progress
      if (progress === null) throw new Error('This Usage has not started')
      const receipt = await writeAndReadM5Receipt(connection, 'usage/progress', {
        ...m5Command(),
        usageId: execution.usageId,
        expectedControllerRevision: progress.controllerRevision,
        action,
        reason,
        ...(action === 'advance' ? { checkpointRef: progress.stepRef } : {}),
        ...(action === 'deviate' ? {
          targetStepRef: options.targetStepRef,
          branchRef: options.branchRef,
          checkpointRef: progress.stepRef,
        } : {}),
      })
      const selectedExecution = value(await connection.rpc.call(CHANNEL, 'usage/get', {
        usageId: execution.usageId,
      })) as UsageExecutionView
      publish({ ...state, selectedExecution, receipt })
    }),
    verifyUsage: () => run(async () => {
      const execution = requiredExecution(state)
      if (execution.progress === null) throw new Error('This Usage has not started')
      const receipt = await writeAndReadM5Receipt(connection, 'usage/verify', {
        ...m5Command(),
        usageId: execution.usageId,
        expectedControllerRevision: execution.progress.controllerRevision,
      })
      const selectedExecution = value(await connection.rpc.call(CHANNEL, 'usage/get', {
        usageId: execution.usageId,
      })) as UsageExecutionView
      publish({ ...state, selectedExecution, receipt })
    }),
    settleUsage: () => run(async () => {
      const execution = requiredExecution(state)
      if (execution.progress === null || execution.verification === null) {
        throw new Error('Current StepProgress and VerificationRun are required')
      }
      const receipt = await writeAndReadM5Receipt(connection, 'usage/settle', {
        ...m5Command(),
        usageId: execution.usageId,
        expectedControllerRevision: execution.progress.controllerRevision,
        verificationRunId: execution.verification.verificationRunId,
      })
      const selectedExecution = value(await connection.rpc.call(CHANNEL, 'usage/get', {
        usageId: execution.usageId,
      })) as UsageExecutionView
      publish({ ...state, selectedExecution, receipt })
    }),
    proposeRevision: baseVersionId => run(async () => {
      const execution = requiredExecution(state)
      const receipt = await writeAndReadM5Receipt(connection, 'revision/propose', {
        ...m5Command(),
        usageId: execution.usageId,
        baseVersionId,
      })
      const selectedExecution = value(await connection.rpc.call(CHANNEL, 'usage/get', {
        usageId: execution.usageId,
      })) as UsageExecutionView
      publish({ ...state, selectedExecution, receipt })
    }),
    decideRevision: (changeId, decision, reason) => run(async () => {
      const execution = state.selectedExecution
      const proposal = state.markdownRevision ?? (execution === undefined ? undefined : currentRevision(execution))
      if (proposal === undefined) throw new Error('Create a RevisionProposal first')
      const receipt = await writeAndReadM5Receipt(connection, 'revision/decide', {
        ...m5Command(),
        revisionProposalId: proposal.revisionProposalId,
        expectedRevision: proposal.revision,
        revisionChangeId: changeId,
        decision,
        reason,
      })
      const updated = value(await connection.rpc.call(CHANNEL, 'revision/get', {
        revisionProposalId: proposal.revisionProposalId,
      })) as RevisionProposalView
      const selectedExecution = execution === undefined ? undefined
        : value(await connection.rpc.call(CHANNEL, 'usage/get', { usageId: execution.usageId })) as UsageExecutionView
      publish({ ...state, ...(selectedExecution === undefined ? {} : { selectedExecution }),
        ...(state.markdownRevision === undefined ? {} : { markdownRevision: updated }), receipt })
    }),
    publishRevision: () => run(async () => {
      const execution = state.selectedExecution
      const proposal = state.markdownRevision ?? (execution === undefined ? undefined : currentRevision(execution))
      if (proposal === undefined) throw new Error('Create a RevisionProposal first')
      const receipt = await writeAndReadM5Receipt(connection, 'revision/publish', {
        ...m5Command(),
        revisionProposalId: proposal.revisionProposalId,
        expectedRevision: proposal.revision,
      })
      if (receipt.experienceVersionId === null) throw new Error('Revision publish receipt has no Version')
      const version = value(await connection.rpc.call(CHANNEL, 'version/get', {
        experienceVersionId: receipt.experienceVersionId,
      })) as ExperienceVersionView
      const updated = value(await connection.rpc.call(CHANNEL, 'revision/get', {
        revisionProposalId: proposal.revisionProposalId,
      })) as RevisionProposalView
      const selectedExecution = execution === undefined ? undefined
        : value(await connection.rpc.call(CHANNEL, 'usage/get', { usageId: execution.usageId })) as UsageExecutionView
      publish({ ...state, ...(selectedExecution === undefined ? {} : { selectedExecution }),
        ...(state.markdownRevision === undefined ? {} : { markdownRevision: updated }), version, receipt })
    }),
    previewForget: () => run(async () => {
      const version = requiredVersion(state)
      const forgetPreview = value(await connection.rpc.call(CHANNEL, 'forget/preview', {
        experienceId: version.experienceId,
      })) as ForgetImpactPreviewView
      publish({ ...state, forgetPreview, forgetRequest: undefined })
    }),
    forgetExperience: reason => run(async () => {
      const preview = state.forgetPreview
      if (preview === undefined) throw new Error('Preview Forget impact before confirming')
      if (reason.trim() === '') throw new Error('Forget requires an explicit reason')
      const receipt = await writeAndReadForgetReceipt(connection, 'forget/commit', {
        ...m5Command(),
        experienceId: preview.experienceId,
        expectedSeriesRevision: preview.expectedSeriesRevision,
        previewDigest: preview.previewDigest,
        reason: reason.trim(),
      })
      const forgetRequest = value(await connection.rpc.call(CHANNEL, 'forget/get', {
        forgetRequestId: receipt.forgetRequestId,
      })) as ForgetRequestView
      const [planning, learning] = await Promise.all([
        connection.rpc.call(CHANNEL, 'plan/list', {}),
        connection.rpc.call(CHANNEL, 'learning/query', {}),
      ])
      publish({
        ...state,
        receipt,
        forgetRequest,
        forgetPreview: undefined,
        planningResults: value(planning) as PlanningResultView[],
        learning: value(learning) as LearningProjectionView,
      })
    }),
    reviewHistoryRanking: (row, preferredOrder, reason, sourceUsageId) => run(async () => {
      const projection = state.learning
      if (projection === undefined || !projection.rows.includes(row)) throw new Error('Refresh the comparison before reviewing')
      const rankingDigest = await browserDigest(JSON.stringify(sortReviewJson({
        projectionKey: projection.projectionKey, builderVersion: projection.builderVersion,
        ranking: row.prediction.ranking,
      })))
      const receipt = await writeAndReadLearningGovernanceReceipt(connection, 'learning/ranking-review', {
        ...m5Command(), predictionId: row.predictionId, rankingDigest, preferredOrder,
        reason, evidenceRefs: [{ kind: 'usage', id: sourceUsageId, digest: null }],
      })
      const learningGovernance = value(await connection.rpc.call(CHANNEL, 'learning/governance', {})) as LearningGovernanceView
      publish({ ...state, receipt, learningGovernance })
    }),
    evaluateLearningCapability: capability => run(async () => {
      const receipt = await writeAndReadLearningGovernanceReceipt(connection, 'learning/evaluate', {
        ...m5Command(), capability,
      })
      const learningGovernance = value(await connection.rpc.call(
        CHANNEL, 'learning/governance', {})) as LearningGovernanceView
      publish({ ...state, receipt, learningGovernance })
    }),
    changeAutomationLevel: (
      capability, action, targetLevel, evaluationId, reason, violationClass,
    ) => run(async () => {
      const receipt = await writeAndReadLearningGovernanceReceipt(connection, 'learning/change-level', {
        ...m5Command(), capability, action, targetLevel, evaluationId, reason, violationClass,
      })
      const learningGovernance = value(await connection.rpc.call(
        CHANNEL, 'learning/governance', {})) as LearningGovernanceView
      publish({ ...state, receipt, learningGovernance })
    }),
    loadAudit: (subject, cursor = null) => run(async () => {
      const dossier = value(await connection.rpc.call(CHANNEL, 'audit/query', { input: {
        subject, asOfRecordedAt: null, cursor, limit: 20,
      } })) as AuditDossierView
      const audit = cursor === null || state.audit?.subject.kind !== subject.kind
        || state.audit.subject.id !== subject.id
        ? dossier
        : { ...dossier, timeline: [...state.audit.timeline, ...dossier.timeline] }
      publish({ ...state, audit })
    }),
    exportMarkdown: () => run(async () => {
      const version = requiredVersion(state)
      const markdownProjection = value(await connection.rpc.call(CHANNEL, 'markdown/export', { input: {
        ...m5Command(), experienceVersionId: version.experienceVersionId,
      } })) as MarkdownProjectionView
      publish({ ...state, markdownProjection, markdownRevision: undefined })
    }),
    proposeMarkdownRevision: editedMarkdown => run(async () => {
      const projection = state.markdownProjection
      if (projection === undefined) throw new Error('Export a Markdown projection first')
      const key = value(await connection.rpc.call(CHANNEL, 'markdown/propose-revision', { input: {
        ...m5Command(),
        markdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
        editedMarkdown,
        editedMarkdownDigest: await browserDigest(editedMarkdown),
      } }))
      if (!isRecord(key) || typeof key.receiptId !== 'string') throw new Error('Markdown revision response is invalid')
      const receipt = value(await connection.rpc.call(CHANNEL, 'receipt/get', { receiptId: key.receiptId }))
      if (!isRecord(receipt) || typeof receipt.revisionProposalId !== 'string') {
        throw new Error('Markdown revision receipt has no RevisionProposal')
      }
      const markdownRevision = value(await connection.rpc.call(CHANNEL, 'revision/get', {
        revisionProposalId: receipt.revisionProposalId,
      })) as RevisionProposalView
      publish({ ...state, receipt: receipt as unknown as ExperienceDomainReceipt, markdownRevision })
    }),
    evaluateInfrastructureReadiness: () => run(async () => {
      await connection.rpc.call(CHANNEL, 'infrastructure/evaluate', { input: {
        ...m5Command(),
      } }).then(value)
      const infrastructureReadiness = value(await connection.rpc.call(
        CHANNEL, 'infrastructure/readiness', {})) as InfrastructureReadinessView
      publish({ ...state, infrastructureReadiness })
    }),
    loadEvaluationReport: cohortId => run(async () => {
      const evaluationReport = value(await connection.rpc.call(
        CHANNEL, 'evaluation/report', { cohortId })) as EvaluationReportView
      publish({ ...state, evaluationReport })
    }),
  }
}

function initialState(): ViewState {
  return Object.freeze({ phase: 'loading', candidates: [], planningResults: [], proposalStatus: 'idle', running: false })
}

async function writeAndReadReceipt(
  connection: ConnectionHandle,
  endpoint: string,
  input: unknown,
): Promise<ExperienceDomainReceipt> {
  const key = value(await connection.rpc.call(CHANNEL, endpoint, { input }))
  if (!isRecord(key) || typeof key.receiptId !== 'string') throw new Error('Experience write response is invalid')
  return value(await connection.rpc.call(CHANNEL, 'receipt/get', { receiptId: key.receiptId })) as ExperienceDomainReceipt
}

async function writeAndReadCandidateReceipt(
  connection: ConnectionHandle,
  endpoint: string,
  input: unknown,
): Promise<DomainReceipt> {
  const receipt = await writeAndReadReceipt(connection, endpoint, input)
  if (!('candidateId' in receipt)) throw new Error('Candidate write returned a non-Candidate receipt')
  return receipt
}

async function writeAndReadM5Receipt(
  connection: ConnectionHandle,
  endpoint: string,
  input: unknown,
): Promise<M5DomainReceipt> {
  const receipt = await writeAndReadReceipt(connection, endpoint, input)
  if (!('usageId' in receipt)) throw new Error('M5 write returned a non-M5 receipt')
  return receipt
}

async function writeAndReadLearningGovernanceReceipt(
  connection: ConnectionHandle,
  endpoint: string,
  input: unknown,
): Promise<LearningGovernanceReceipt> {
  const receipt = await writeAndReadReceipt(connection, endpoint, input)
  if (!('capability' in receipt)) throw new Error('Learning governance write returned another receipt type')
  return receipt as LearningGovernanceReceipt
}

async function writeAndReadForgetReceipt(
  connection: ConnectionHandle,
  endpoint: string,
  input: unknown,
): Promise<ForgetDomainReceipt> {
  const receipt = await writeAndReadReceipt(connection, endpoint, input)
  if (receipt.action !== 'experience.forget') throw new Error('Forget write returned another domain receipt')
  return receipt
}

function requiredCandidate(state: ViewState): CandidateView {
  if (state.selected === undefined) throw new Error('Select a Candidate first')
  return state.selected
}

function requiredExecution(state: ViewState): UsageExecutionView {
  if (state.selectedExecution === undefined) throw new Error('Select an Experience Usage first')
  return state.selectedExecution
}

function requiredVersion(state: ViewState): ExperienceVersionView {
  if (state.version === undefined) throw new Error('Select or publish an Experience Version first')
  return state.version
}

function currentRevision(execution: UsageExecutionView): RevisionProposalView {
  const proposal = execution.revisionProposals.at(-1)
  if (proposal === undefined) throw new Error('Create a RevisionProposal first')
  return proposal
}

function value(result: ConnectionRpcResult<unknown>): unknown {
  if (!result.ok) throw new ExperienceRpcError(
    result.error.code,
    result.error.message,
    isRecord(result.error.details) ? result.error.details : {},
  )
  return result.value
}

function readStatus(result: ConnectionRpcResult<unknown>): ExperienceStatusView {
  const item = value(result)
  if (!isRecord(item)
    || !isRecord(item.actor)
    || typeof item.principalId !== 'string'
    || typeof item.actor.actorId !== 'string'
    || !Number.isSafeInteger(item.candidateCount)
    || !Number.isSafeInteger(item.versionCount)) {
    throw new Error('Experience status response is invalid')
  }
  return item as unknown as ExperienceStatusView
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function browserDigest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function publicRpcFailure(error: unknown): ProposalFailureView {
  return error instanceof ExperienceRpcError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'client_error', message: errorMessage(error), details: {} }
}

class ExperienceRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'ExperienceRpcError'
  }
}

/** Match the Host canonical digest without importing Node-only domain code into the Browser. */
function sortReviewJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortReviewJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, sortReviewJson(item)]))
}
