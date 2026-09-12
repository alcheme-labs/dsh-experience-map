import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it } from 'vitest'
import { createStore } from '../../src/client/store.js'
import { automationConfiguration } from '../../src/runtime-settings.js'
import { RuntimeSettingsSchema, type RuntimeSettings } from '../../src/runtime-settings-schema.js'
import type {
  CandidateSummaryView,
  CandidateView,
  DomainReceipt,
  ExperienceStatusView,
  ProposalSourceInspectionView,
  PlanningResultView,
  ContextUsageView,
  UsageExecutionView,
  M5DomainReceipt,
  ExperienceSuggestionGroupView,
  SuggestionProjectionView,
} from '../../src/types.js'
import { episodeRef, evidencePacket, proposalMetadata, sourceRef } from '../fixtures/workflow.js'
import { throughExperienceRpcCarrier } from '../fixtures/client-rpc.js'

describe('M2 Browser controller', () => {
  it('requires an exact one-time disclosure confirmation and reads writes back by Receipt key', async () => {
    const calls: string[] = []
    const inputs: unknown[] = []
    const candidate = candidateView()
    const receipt = proposalReceipt()
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string, input: unknown): Promise<ConnectionRpcResult<unknown>> => {
          calls.push(endpoint)
          inputs.push(input)
          switch (endpoint) {
            case 'status/query': return ok(status(receipt))
            case 'suggestions/query': return ok(suggestionProjection())
            case 'retrieval/query': return ok(retrievalProjection())
            case 'candidate/list': return ok([summary(candidate)])
            case 'plan/list': return ok([])
            case 'plan/config': return ok(planningConfig())
            case 'automation/config': return ok(automationConfig())
            case 'learning/query': return ok(learningProjection())
            case 'learning/governance': return ok(learningGovernance())
            case 'relation-map/query': return ok(relationMap())
            case 'infrastructure/readiness': return ok(infrastructureReadiness())
            case 'candidate/get': return ok(candidate)
            case 'proposal-source/inspect': return ok(inspection())
            case 'candidate/propose': return ok({ receiptId: receipt.receiptId })
            case 'receipt/get': return ok(receipt)
            default: throw new Error(`unexpected endpoint ${endpoint}`)
          }
        },
      },
    } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({
      receipt: { receiptId: receipt.receiptId },
      version: undefined,
    })
    await store.inspect('session-test', 'diagnostic', { mode: 'configured_default' })
    await store.propose()
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', error: undefined,
      proposalStatus: 'failed',
      proposalFailure: {
        code: 'client_error',
        message: 'Confirm the exact external model disclosure before proposing',
      },
    })
    expect(calls).not.toContain('candidate/propose')
    const digest = store.getSnapshot().inspection!.disclosure.disclosureDigest
    store.confirmDisclosure(digest, true)
    await store.propose()
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      proposalStatus: 'succeeded',
      confirmedDisclosureDigest: undefined,
      selected: { candidateId: candidate.candidateId },
      receipt: { receiptId: receipt.receiptId },
    })
    expect(calls.slice(-4)).toEqual([
      'candidate/propose', 'receipt/get', 'candidate/get', 'candidate/list',
    ])
    expect(inputs[calls.lastIndexOf('candidate/propose')]).toMatchObject({
      input: {
        proposalDisclosureDigest: digest,
        outputTokenLimit: { mode: 'configured_default' },
        confirmedMaxOutputTokens: 8_192,
      },
    })
  })

  it('keeps output-limit failures structured and visible without changing authoritative readback state', async () => {
    const calls: Array<{ readonly endpoint: string; readonly input: unknown }> = []
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string, input: unknown): Promise<ConnectionRpcResult<unknown>> => {
          calls.push({ endpoint, input })
          if (endpoint === 'proposal-source/inspect') {
            return ok({
              ...inspection(),
              outputTokenLimit: { mode: 'provider_default' },
              disclosure: {
                ...inspection().disclosure,
                outputTokenLimitMode: 'provider_default',
                requestedMaxOutputTokens: null,
                maxOutputTokens: 32_768,
                maxOutputTokensSource: 'provider_default',
                disclosureDigest: 'sha256:provider-default',
              },
            })
          }
          if (endpoint === 'candidate/propose') {
            return {
              ok: false,
              error: {
                code: 'proposal_output_limit',
                message: 'Candidate proposal reached its output-token limit before producing valid Candidate JSON',
                details: {
                  maxOutputTokens: 32_768,
                  inputTokens: 20_712,
                  outputTokens: 32_768,
                  reasoningTokens: 32_768,
                  automaticRetry: false,
                },
              },
            }
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.inspect('session-a', 'diagnostic', { mode: 'provider_default' })
    const digest = store.getSnapshot().inspection!.disclosure.disclosureDigest
    store.confirmDisclosure(digest, true)
    await store.propose()

    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      proposalStatus: 'failed',
      proposalFailure: {
        code: 'proposal_output_limit',
        details: { maxOutputTokens: 32_768, reasoningTokens: 32_768, automaticRetry: false },
      },
      candidates: [],
    })
    expect(calls.find(call => call.endpoint === 'candidate/propose')?.input).toMatchObject({
      input: {
        outputTokenLimit: { mode: 'provider_default' },
        confirmedMaxOutputTokens: 32_768,
      },
    })
  })

  it('clears Session-scoped inspection and consent before reconnect refresh', async () => {
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string): Promise<ConnectionRpcResult<unknown>> => {
          if (endpoint === 'proposal-source/inspect') return ok(inspection())
          if (endpoint === 'status/query') return ok(status(proposalReceipt()))
          if (endpoint === 'suggestions/query') return ok(suggestionProjection())
          if (endpoint === 'retrieval/query') return ok(retrievalProjection())
          if (endpoint === 'candidate/list') return ok([])
          if (endpoint === 'plan/list') return ok([])
          if (endpoint === 'plan/config') return ok(planningConfig())
          if (endpoint === 'automation/config') return ok(automationConfig())
          if (endpoint === 'learning/query') return ok(learningProjection())
          if (endpoint === 'learning/governance') return ok(learningGovernance())
          if (endpoint === 'relation-map/query') return ok(relationMap())
          if (endpoint === 'infrastructure/readiness') return ok(infrastructureReadiness())
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.inspect('session-a', 'diagnostic', { mode: 'configured_default' })
    store.confirmDisclosure(inspection().disclosure.disclosureDigest, true)
    expect(store.getSnapshot().confirmedDisclosureDigest).toBeDefined()
    await store.reset()
    expect(store.getSnapshot().phase).toBe('ready')
    expect(store.getSnapshot().inspection).toBeUndefined()
    expect(store.getSnapshot().confirmedDisclosureDigest).toBeUndefined()
  })

  it('clears a selected Candidate when authoritative refresh no longer lists it', async () => {
    let candidates: CandidateSummaryView[] = [summary(candidateView())]
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string): Promise<ConnectionRpcResult<unknown>> => {
          if (endpoint === 'status/query') return ok(status(proposalReceipt()))
          if (endpoint === 'suggestions/query') return ok(suggestionProjection())
          if (endpoint === 'retrieval/query') return ok(retrievalProjection())
          if (endpoint === 'candidate/list') return ok(candidates)
          if (endpoint === 'candidate/get') return ok(candidateView())
          if (endpoint === 'plan/list') return ok([])
          if (endpoint === 'plan/config') return ok(planningConfig())
          if (endpoint === 'automation/config') return ok(automationConfig())
          if (endpoint === 'learning/query') return ok(learningProjection())
          if (endpoint === 'learning/governance') return ok(learningGovernance())
          if (endpoint === 'relation-map/query') return ok(relationMap())
          if (endpoint === 'infrastructure/readiness') return ok(infrastructureReadiness())
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.refresh()
    await store.select(candidateView().candidateId)
    expect(store.getSnapshot().selected).toBeDefined()
    candidates = []
    await store.refresh()
    expect(store.getSnapshot().selected).toBeUndefined()
  })

  it('refuses proposal when the disclosure count does not match the local record preview', async () => {
    const calls: string[] = []
    const mismatched = inspection()
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string): Promise<ConnectionRpcResult<unknown>> => {
          calls.push(endpoint)
          if (endpoint === 'proposal-source/inspect') {
            return ok({
              ...mismatched,
              disclosure: { ...mismatched.disclosure, evidenceItemCount: 2 },
            })
          }
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.inspect('session-a', 'diagnostic', { mode: 'configured_default' })
    store.confirmDisclosure(store.getSnapshot().inspection!.disclosure.disclosureDigest, true)
    await store.propose()
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      error: undefined,
      proposalStatus: 'failed',
      proposalFailure: {
        code: 'client_error',
        message: 'The disclosed evidence count does not match the locally inspected packet',
      },
    })
    expect(calls).not.toContain('candidate/propose')
  })

  it('dismisses the exact displayed suggestion snapshot and replaces it with Host readback', async () => {
    const group = {
      suggestionGroupId: 'suggestion-group:client',
      revisionDigest: `sha256:${'a'.repeat(64)}`,
      reviewDigest: `sha256:${'b'.repeat(64)}`,
    } as ExperienceSuggestionGroupView
    let projection = suggestionProjection([group])
    let dismissPayload: unknown
    const connection = { rpc: { call: async (_channel: string, endpoint: string, input: unknown) => {
      switch (endpoint) {
        case 'status/query': return ok(status(proposalReceipt()))
        case 'suggestions/query': return ok(projection)
        case 'retrieval/query': return ok(retrievalProjection())
        case 'candidate/list': return ok([])
        case 'plan/list': return ok([])
        case 'plan/config': return ok(planningConfig())
        case 'automation/config': return ok(automationConfig())
        case 'learning/query': return ok(learningProjection())
        case 'learning/governance': return ok(learningGovernance())
        case 'relation-map/query': return ok(relationMap())
        case 'infrastructure/readiness': return ok(infrastructureReadiness())
        case 'suggestions/dismiss':
          dismissPayload = input
          projection = suggestionProjection([])
          return ok(projection)
        default: throw new Error(`unexpected endpoint ${endpoint}`)
      }
    } } } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))

    await store.refresh()
    await store.dismissSuggestion(group, 'not_reusable')

    expect(dismissPayload).toMatchObject({ input: {
      suggestionGroupId: group.suggestionGroupId,
      expectedRevisionDigest: group.revisionDigest,
      reviewDigest: group.reviewDigest,
      reasonCode: 'not_reusable',
    } })
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', suggestions: { groups: [] } })
  })

  it('saves the exact displayed suggestion and reads back its canonical receipt, Version, and inbox', async () => {
    const group = {
      suggestionGroupId: 'suggestion-group:save-client',
      revisionDigest: `sha256:${'a'.repeat(64)}`,
      reviewDigest: `sha256:${'b'.repeat(64)}`,
      sourceDigest: `sha256:${'c'.repeat(64)}`,
      saveReadiness: 'ready',
    } as ExperienceSuggestionGroupView
    const receipt = {
      receiptId: 'receipt:suggestion-save',
      commandId: 'command:suggestion-save',
      action: 'suggestion.save',
      experienceVersionId: 'version:suggestion-save',
    }
    const version = { experienceVersionId: receipt.experienceVersionId, legacyWarnings: [] }
    let projection = suggestionProjection([group])
    let savePayload: unknown
    const connection = { rpc: { call: async (_channel: string, endpoint: string, input: unknown) => {
      switch (endpoint) {
        case 'status/query': return ok(status(proposalReceipt()))
        case 'suggestions/query': return ok(projection)
        case 'retrieval/query': return ok(retrievalProjection())
        case 'candidate/list': return ok([])
        case 'plan/list': return ok([])
        case 'plan/config': return ok(planningConfig())
        case 'automation/config': return ok(automationConfig())
        case 'learning/query': return ok(learningProjection())
        case 'learning/governance': return ok(learningGovernance())
        case 'relation-map/query': return ok(relationMap())
        case 'infrastructure/readiness': return ok(infrastructureReadiness())
        case 'suggestions/save':
          savePayload = input
          projection = suggestionProjection([])
          return ok({ receiptId: receipt.receiptId })
        case 'receipt/get': return ok(receipt)
        case 'version/get': return ok(version)
        default: throw new Error(`unexpected endpoint ${endpoint}`)
      }
    } } } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))

    await store.refresh()
    await store.saveSuggestion(group)

    expect(savePayload).toMatchObject({ input: {
      suggestionGroupId: group.suggestionGroupId,
      expectedRevisionDigest: group.revisionDigest,
      reviewDigest: group.reviewDigest,
      sourceDigest: group.sourceDigest,
    } })
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      suggestions: { groups: [] },
      receipt: { action: 'suggestion.save', receiptId: receipt.receiptId },
      version: { experienceVersionId: receipt.experienceVersionId },
    })
  })
})

describe('M5 Browser controller', () => {
  it('uses the Host receipt key and authoritative Usage readback after a progress command', async () => {
    const calls: Array<{ endpoint: string; input: unknown }> = []
    const planning = { plan: { usageId: 'usage-m5-client' } } as unknown as PlanningResultView
    const context = {} as ContextUsageView
    let execution = usageExecution(1)
    const receipt = m5Receipt()
    const connection = { rpc: { call: async (_channel: string, endpoint: string, input: unknown) => {
      calls.push({ endpoint, input })
      switch (endpoint) {
        case 'status/query': return ok(status(proposalReceipt()))
        case 'suggestions/query': return ok(suggestionProjection())
        case 'retrieval/query': return ok(retrievalProjection())
        case 'candidate/list': return ok([])
        case 'plan/list': return ok([planning])
        case 'plan/config': return ok(planningConfig())
        case 'automation/config': return ok(automationConfig())
        case 'learning/query': return ok(learningProjection())
        case 'learning/governance': return ok(learningGovernance())
        case 'relation-map/query': return ok(relationMap())
        case 'infrastructure/readiness': return ok(infrastructureReadiness())
        case 'context/get': return ok(context)
        case 'usage/get': return ok(execution)
        case 'usage/progress':
          execution = usageExecution(2)
          return ok({ receiptId: receipt.receiptId })
        case 'receipt/get': return ok(receipt)
        default: throw new Error(`unexpected endpoint ${endpoint}`)
      }
    } } } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.refresh()
    await store.progressUsage('advance', 'step verified')
    const write = calls.find(call => call.endpoint === 'usage/progress')
    expect(write?.input).toMatchObject({ input: {
      usageId: 'usage-m5-client', expectedControllerRevision: 1,
      action: 'advance', checkpointRef: 'step-1', reason: 'step verified',
    } })
    expect(calls.slice(-3).map(call => call.endpoint)).toEqual([
      'usage/progress', 'receipt/get', 'usage/get',
    ])
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', running: false,
      receipt: { receiptId: receipt.receiptId },
      selectedExecution: { progress: { controllerRevision: 2 } },
    })
  })

  it('replaces the M5 readback when planning selects a different Usage', async () => {
    const oldPlanning = { plan: { usageId: 'usage-old' } } as unknown as PlanningResultView
    const newPlanning = {
      plan: { usageId: 'usage-new' },
      approvalRequest: {
        requestId: 'request-new', usagePlanId: 'plan-new', planRevision: 1,
      },
    } as unknown as PlanningResultView
    const oldExecution = { ...usageExecution(1), usageId: 'usage-old' } as UsageExecutionView
    const newExecution = { ...usageExecution(1), usageId: 'usage-new' } as UsageExecutionView
    let planningResults = [oldPlanning]
    const usageReads: string[] = []
    const connection = { rpc: { call: async (_channel: string, endpoint: string, input: unknown) => {
      const payload = input as { readonly usageId?: string }
      switch (endpoint) {
        case 'status/query': return ok(status(proposalReceipt()))
        case 'suggestions/query': return ok(suggestionProjection())
        case 'retrieval/query': return ok(retrievalProjection())
        case 'candidate/list': return ok([])
        case 'plan/list': return ok(planningResults)
        case 'plan/config': return ok(planningConfig())
        case 'automation/config': return ok(automationConfig())
        case 'learning/query': return ok(learningProjection())
        case 'learning/governance': return ok(learningGovernance())
        case 'relation-map/query': return ok(relationMap())
        case 'infrastructure/readiness': return ok(infrastructureReadiness())
        case 'context/get': return ok({})
        case 'usage/get': {
          const usageId = payload.usageId!
          usageReads.push(usageId)
          return ok(usageId === 'usage-new' ? newExecution : oldExecution)
        }
        case 'plan/create':
          planningResults = [newPlanning, oldPlanning]
          return ok({ planning: newPlanning })
        case 'plan/decide': return ok({ planning: newPlanning })
        default: throw new Error(`unexpected endpoint ${endpoint}`)
      }
    } } } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))

    await store.refresh()
    expect(store.getSnapshot().selectedExecution?.usageId).toBe('usage-old')
    await store.planTask('session-new', {} as never, false)
    expect(store.getSnapshot().selectedExecution?.usageId).toBe('usage-new')
    await store.decidePlanning('approve', 'reviewed')
    expect(store.getSnapshot().selectedExecution?.usageId).toBe('usage-new')
    expect(usageReads).toEqual(['usage-old', 'usage-new', 'usage-new'])
  })
})

function inspection(): ProposalSourceInspectionView {
  return {
    requestedKind: 'diagnostic',
    outputTokenLimit: { mode: 'configured_default' },
    episode: {
      episodeRef,
      sourceRefs: [sourceRef],
      records: [{ sourceRef, eventType: 'tool/result', excerpt: 'verified' }],
      termination: {
        state: 'terminated',
        reason: 'completed',
        terminalSourceRefId: sourceRef.sourceRefId,
      },
      recordCount: 1,
      omittedRecordCount: 0,
    },
    historicalSourceRefs: [],
    outcomeSourceRefs: [],
    historicalRecords: [],
    outcomeRecords: [],
    outcomeAssessment: {
      outcome: 'success',
      method: 'criterion_manifest',
      policyVersion: 'm0-outcome-v1',
      manifestDigest: 'sha256:m0-outcome-manifest',
      criteria: [{ criterionId: 'readback', mandatory: true, result: 'pass', evidenceRefIds: [sourceRef.sourceRefId] }],
      assessedAt: '2026-08-31T09:00:00.000Z',
    },
    extractionTrigger: {
      triggerKind: 'terminal_success',
      sourceRefIds: [sourceRef.sourceRefId],
      eligibilityStatus: 'eligible',
      eligibilityReasons: ['criterion_outcome_verified'],
      detectedBy: 'criterion_manifest',
      detectorVersion: 'm2-eligibility-v1',
      detectedAt: '2026-08-31T09:00:00.000Z',
    },
    eligibilityDigest: 'sha256:eligible-extraction',
    publicationMode: 'publishable_after_review',
    evidencePacket,
    disclosure: {
      provider: 'test-provider',
      model: 'test-model',
      settingsRevision: 0,
      settingsDigest: 'sha256:test-settings',
      reasoningEffort: 'low',
      outputTokenLimitMode: 'configured_default',
      configuredMaxOutputTokens: 8_192,
      requestedMaxOutputTokens: 8_192,
      maxOutputTokens: 8_192,
      maxOutputTokensSource: 'experience_default',
      promptVersion: proposalMetadata.promptVersion,
      schemaVersion: proposalMetadata.schemaVersion,
      policyVersion: proposalMetadata.policyVersion,
      resultToolName: 'submit_diagnostic_candidate',
      resultSchemaDigest: 'sha256:result-schema',
      sourceInputDigest: proposalMetadata.sourceInputDigest,
      disclosureDigest: 'sha256:route-and-input',
      sourceRecordCount: 1,
      evidenceItemCount: 1,
      omittedEntryCount: 0,
      sentSourceRecordCount: 1,
      fullyOmittedSourceRecordCount: 0,
      removedBlockCount: 0,
      omissionReasonCounts: {},
      packetBytes: evidencePacket.packetBytes,
      modelInputBytes: 4_096,
      estimatedInputTokens: 1_024,
      sourceRefIds: [sourceRef.sourceRefId],
    },
  }
}

function candidateView(): CandidateView {
  return {
    candidateId: 'candidate-1' as CandidateView['candidateId'],
    candidateRevision: 1,
    state: 'proposed',
    target: 'new_experience',
    proposedKind: 'diagnostic',
    title: 'Candidate',
    extractionTrigger: inspection().extractionTrigger,
    outcomeAssessment: inspection().outcomeAssessment,
    eligibilityDigest: inspection().eligibilityDigest,
    triggerReason: 'terminal Episode has a verified successful outcome',
    sourceEpisodeRefs: [episodeRef],
    sourceRefs: [sourceRef],
    proposal: proposalMetadata,
    evidenceGrade: 'observation_supported',
    fields: [],
    excludedSteps: [],
    missingEvidence: [],
    unresolvedFields: [],
    publicationReadiness: { ready: false, blockers: ['field_decisions_incomplete'] },
    createdAt: proposalMetadata.proposedAt,
    publishedVersionId: null,
    dispositionReason: null,
  }
}

function summary(candidate: CandidateView): CandidateSummaryView {
  return {
    candidateId: candidate.candidateId,
    candidateRevision: candidate.candidateRevision,
    state: candidate.state,
    proposedKind: 'diagnostic',
    title: candidate.title,
    triggerReason: candidate.triggerReason,
    eligibilityStatus: candidate.extractionTrigger.eligibilityStatus,
    pendingFieldCount: 0,
    rejectedFieldCount: 0,
    createdAt: candidate.createdAt,
    proposal: candidate.proposal,
  }
}

function proposalReceipt(): DomainReceipt {
  return {
    receiptId: 'receipt-1' as DomainReceipt['receiptId'],
    commandId: 'command-1' as DomainReceipt['commandId'],
    action: 'candidate.propose',
    actor: {
      actorId: 'actor-1' as DomainReceipt['actor']['actorId'],
      principalId: 'principal-1' as DomainReceipt['actor']['principalId'],
      kind: 'browser_local_owner',
      authority: 'owner',
    },
    candidateId: 'candidate-1' as DomainReceipt['candidateId'],
    candidateRevision: 1,
    experienceId: null,
    experienceVersionId: null,
    correlationId: 'client-test',
    causationId: null,
    issuedAt: '2026-08-31T09:00:00.000Z',
    commitSequence: 1,
    createdAt: '2026-08-31T09:00:01.000Z',
  }
}

function status(receipt: DomainReceipt): ExperienceStatusView {
  return {
    actor: receipt.actor,
    principalId: receipt.actor.principalId,
    candidateCount: 1,
    versionCount: 0,
    latestReceipt: receipt,
    latestForgetRequest: null,
    latestVersion: null,
    pendingPlanApprovalCount: 0,
    latestPlanning: null,
  }
}

function ok(value: unknown): ConnectionRpcResult<unknown> {
  return { ok: true, value }
}

function planningConfig(): import('../../src/types.js').PlanningConfigurationView {
  return {
    taskFingerprintProposalMode: 'deterministic',
    provider: null,
    model: null,
    maxOutputTokens: null,
    promptVersion: 'task-fingerprint-v1',
  }
}

function automationConfig(): import('../../src/types.js').AutomationConfigurationView {
  const values = RuntimeSettingsSchema({} as RuntimeSettings)
  return automationConfiguration({ revision: 0, digest: 'sha256:' + 'a'.repeat(64), values })
}

function learningProjection(): import('../../src/types.js').LearningProjectionView {
  return {
    projectionKey: 'experience-learning-v1',
    builderVersion: 'm7-learning-v4',
    generation: 1,
    sourceOffset: 1,
    rows: [],
    counts: { extraction: 0, applicability: 0, revision: 0, merge: 0, causal_promotion: 0, execution: 0 },
    unsupportedCapabilities: [],
  }
}

function suggestionProjection(
  groups: readonly ExperienceSuggestionGroupView[] = [],
): SuggestionProjectionView {
  return {
    projectionKey: 'experience-suggestions-v1',
    schemaVersion: 5,
    projectorVersion: 'test-projector-v2',
    generation: 1,
    sourceWatermarkDigest: `sha256:${'d'.repeat(64)}`,
    state: 'ready',
    degradedReason: null,
    sessions: [],
    seeds: [],
    groups,
    dispositions: [],
    suppressedGroupCount: 0,
    latestReceipt: {
      receiptId: 'projection-receipt:test',
      status: 'activated',
      generation: 1,
      sourceWatermarkDigest: `sha256:${'d'.repeat(64)}`,
      processedSessionCount: 0,
      occurrenceCount: 0,
      startedAt: '2026-09-10T08:00:00.000Z',
      completedAt: '2026-09-10T08:00:01.000Z',
      reason: null,
    },
  }
}

function retrievalProjection(): import('../../src/types.js').ExperienceRetrievalProjectionView {
  return {
    projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
    manifest: {
      schemaVersion: 'experience-retrieval-projection-manifest-v2',
      projectionVersion: 'experience-retrieval-projector-v2', generation: 1,
      state: 'lexical_ready', provider: 'disabled', providerState: 'disabled',
      modelId: null, modelRevision: null, artifactSha256: null, dimension: null,
      dtype: null, pooling: null, queryPrefix: null, passagePrefix: null,
      tokenizerConfigBundleSha256: null, normalization: null, maxInputTokens: null, truncationPolicy: null,
      operationSettingsRevision: null, operationSettingsDigest: `sha256:${'a'.repeat(64)}`,
      sourceWatermarkDigest: `sha256:${'b'.repeat(64)}`, contentDigest: `sha256:${'c'.repeat(64)}`,
      documentCount: 0, vectorCount: 0, failureCode: null, builtAt: '2026-09-10T08:00:00.000Z',
    }, documents: [],
  }
}

function learningGovernance(): import('../../src/types.js').LearningGovernanceView {
  return { contracts: [], evaluations: [], capabilities: [] }
}

function relationMap(): import('../../src/types.js').RelationMapView {
  return {
    projectionKey: 'experience-relation-map-v1', builderVersion: 'experience-relation-map-v1',
    generationDigest: `sha256:${'a'.repeat(64)}`, generatedAt: '2026-09-03T00:00:00.000Z',
    nodes: [], edges: [], textFallback: [],
  }
}

function infrastructureReadiness(): import('../../src/types.js').InfrastructureReadinessView {
  return {
    contract: {
      contractId: 'graph-storage-readiness-v1', capabilityKey: 'graph_projection_or_database',
      currentStore: 'sqlite', requiredQueryClasses: ['adjacency', 'bounded_multi_hop', 'shared_dependency'],
      failureDefinitions: ['sustained_p95_latency_above_threshold',
        'query_not_expressible_without_duplicate_authority', 'canonical_parity_or_rollback_not_proven'],
      metricDefinitions: {}, minimumObservationCoverage: 30, consistencyRequirements: [],
      migrationSafetyRequirements: [], thresholdPolicy: { p95QueryDurationMs: 250, minimumStableMultiHopQueryClasses: 2 },
      requiredSignals: ['measured_query_bottleneck', 'stable_multi_hop_demand', 'rebuild_and_rollback_proven'],
      decisionRule: 'all_required_signals', approverPolicy: 'architecture_review', contractVersion: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
    },
    latestEvaluation: null,
    decision: 'not_ready',
  }
}

function usageExecution(controllerRevision: number): UsageExecutionView {
  return {
    usageId: 'usage-m5-client' as UsageExecutionView['usageId'],
    progress: {
      stepProgressId: 'progress-m5-client' as NonNullable<UsageExecutionView['progress']>['stepProgressId'],
      executionId: 'execution-m5-client' as NonNullable<UsageExecutionView['progress']>['executionId'],
      usageId: 'usage-m5-client' as UsageExecutionView['usageId'],
      usagePlanId: 'plan-m5-client' as NonNullable<UsageExecutionView['progress']>['usagePlanId'],
      planRevision: 1,
      sessionId: 'session-m5-client',
      guardPolicyDigest: 'sha256:policy',
      controllerRevision,
      stepIndex: 0,
      stepRef: 'step-1',
      completedStepRefs: controllerRevision === 1 ? [] : ['step-1'],
      selectedBranchRefs: [],
      checkpointResults: controllerRevision === 1 ? [] : [{
        stepRef: 'step-1', checkpointRef: 'step-1', decision: 'accepted', reason: 'step verified',
      }],
      state: 'running',
      transition: controllerRevision === 1 ? 'start' : 'advance',
      branchRef: null,
      checkpointRef: controllerRevision === 1 ? null : 'step-1',
      reason: null,
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    correlations: [], verification: null, settlement: null, revisionProposals: [], preferenceValidations: [],
  }
}

function m5Receipt(): M5DomainReceipt {
  return {
    receiptId: 'receipt-m5-client' as M5DomainReceipt['receiptId'],
    commandId: 'command-m5-client' as M5DomainReceipt['commandId'],
    action: 'usage.progress',
    actor: proposalReceipt().actor,
    usageId: 'usage-m5-client' as M5DomainReceipt['usageId'],
    controllerRevision: 2,
    revisionProposalId: null,
    objectRevision: 2,
    experienceId: null,
    experienceVersionId: null,
    correlationId: 'correlation-m5-client',
    causationId: null,
    issuedAt: '2026-09-02T00:00:00.000Z',
    commitSequence: 2,
    createdAt: '2026-09-02T00:00:01.000Z',
  }
}
