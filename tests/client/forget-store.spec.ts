import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it } from 'vitest'
import { createStore } from '../../src/client/store.js'
import { retrievalProjection } from '../fixtures/retrieval.js'
import { automationConfigurationFixture } from '../fixtures/automation.js'
import { throughExperienceRpcCarrier } from '../fixtures/client-rpc.js'
import type {
  ExperienceStatusView,
  ExperienceVersionView,
  ForgetDomainReceipt,
  ForgetImpactPreviewView,
  ForgetRequestView,
  LearningProjectionView,
} from '../../src/types.js'

describe('M7 Browser Forget controller', () => {
  it('binds commit to the displayed impact and reads each owner result from Host', async () => {
    const calls: Array<{ readonly endpoint: string; readonly payload: unknown }> = []
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> => {
          calls.push({ endpoint, payload })
          if (endpoint === 'status/query') return ok(status())
          if (endpoint === 'suggestions/query') return ok({
            projectionKey: 'experience-suggestions-v1', schemaVersion: 5,
            groups: [], sessions: [], seeds: [], dispositions: [],
          })
          if (endpoint === 'retrieval/query') return ok(retrievalProjection())
          if (endpoint === 'candidate/list' || endpoint === 'plan/list') return ok([])
          if (endpoint === 'plan/config') return ok({
            taskFingerprintProposalMode: 'deterministic', provider: null, model: null,
            maxOutputTokens: null, promptVersion: 'task-fingerprint-v1',
          })
          if (endpoint === 'automation/config') return ok(automationConfigurationFixture())
          if (endpoint === 'learning/query') return ok(learning())
          if (endpoint === 'learning/governance') return ok({ contracts: [], evaluations: [], capabilities: [] })
          if (endpoint === 'relation-map/query') return ok(relationMap())
          if (endpoint === 'infrastructure/readiness') return ok(readiness())
          if (endpoint === 'forget/preview') return ok(preview())
          if (endpoint === 'forget/commit') return ok({ receiptId: 'receipt-forget-1' })
          if (endpoint === 'receipt/get') return ok(receipt())
          if (endpoint === 'forget/get') return ok(request())
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.refresh()

    await store.previewForget()
    expect(store.getSnapshot().forgetPreview).toEqual(preview())
    await store.forgetExperience('Owner confirmed obsolete guidance')

    expect(calls.find(call => call.endpoint === 'forget/commit')?.payload).toMatchObject({
      input: {
        experienceId: 'experience-1',
        expectedSeriesRevision: 3,
        previewDigest: `sha256:${'a'.repeat(64)}`,
        reason: 'Owner confirmed obsolete guidance',
      },
    })
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      receipt: { action: 'experience.forget', forgetRequestId: 'forget-1' },
      forgetRequest: { state: 'completed', experienceId: 'experience-1' },
      forgetPreview: undefined,
    })
  })
})

function actor(): ExperienceStatusView['actor'] {
  return {
    actorId: 'browser:principal-1', principalId: 'principal-1',
    kind: 'browser_local_owner', authority: 'owner',
  } as ExperienceStatusView['actor']
}

function status(): ExperienceStatusView {
  return {
    actor: actor(), principalId: actor().principalId, candidateCount: 0, versionCount: 1,
    latestReceipt: null, latestVersion: version(), pendingPlanApprovalCount: 0, latestPlanning: null,
    latestForgetRequest: null,
  }
}

function version(): ExperienceVersionView {
  return {
    experienceVersionId: 'version-1', experienceId: 'experience-1', versionNumber: 3,
    legacyWarnings: [],
  } as unknown as ExperienceVersionView
}

function preview(): ForgetImpactPreviewView {
  return {
    experienceId: 'experience-1', currentVersionId: 'version-1', expectedSeriesRevision: 3,
    versionCount: 3, activeContextTargets: [], futureRecall: 'will_stop_immediately',
    immutableHistory: ['versions', 'receipts', 'audit', 'session_events', 'provider_copies'],
    vaultContent: 'not_applicable', vaultReasonCode: 'governed_content_vault_not_enabled',
    previewDigest: `sha256:${'a'.repeat(64)}`, generatedAt: '2026-09-02T00:00:00.000Z',
  } as unknown as ForgetImpactPreviewView
}

function receipt(): ForgetDomainReceipt {
  return {
    receiptId: 'receipt-forget-1', commandId: 'command-forget-1', action: 'experience.forget',
    actor: actor(), forgetRequestId: 'forget-1', experienceId: 'experience-1', seriesRevision: 4,
    correlationId: 'correlation-1', causationId: null, issuedAt: '2026-09-02T00:00:00.000Z',
    commitSequence: 9, createdAt: '2026-09-02T00:00:00.000Z',
  } as ForgetDomainReceipt
}

function request(): ForgetRequestView {
  return {
    forgetRequestId: 'forget-1', experienceId: 'experience-1', currentVersionId: 'version-1',
    state: 'completed', reason: 'Owner confirmed obsolete guidance', requestedBy: actor().actorId,
    previewDigest: preview().previewDigest, canonicalRecallStoppedAt: '2026-09-02T00:00:00.000Z',
    irreversibleHistory: preview().immutableHistory, steps: [], contextTargets: [],
    requestedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:01.000Z',
  } as unknown as ForgetRequestView
}

function learning(): LearningProjectionView {
  return {
    projectionKey: 'experience-learning-v1', builderVersion: 'm7-learning-v4', generation: 2,
    sourceOffset: 10, rows: [],
    counts: { extraction: 0, applicability: 0, revision: 0, merge: 0, causal_promotion: 0, execution: 0 },
    unsupportedCapabilities: [],
  }
}

function relationMap(): import('../../src/types.js').RelationMapView {
  return {
    projectionKey: 'experience-relation-map-v1', builderVersion: 'experience-relation-map-v1',
    generationDigest: `sha256:${'b'.repeat(64)}`, generatedAt: '2026-09-03T00:00:00.000Z',
    nodes: [], edges: [], textFallback: [],
  }
}

function readiness(): import('../../src/types.js').InfrastructureReadinessView {
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

function ok(value: unknown): ConnectionRpcResult<unknown> {
  return { ok: true, value }
}
