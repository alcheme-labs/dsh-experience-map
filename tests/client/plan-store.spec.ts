import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it } from 'vitest'
import { createStore } from '../../src/client/store.js'
import { retrievalProjection } from '../fixtures/retrieval.js'
import { automationConfigurationFixture } from '../fixtures/automation.js'
import { throughExperienceRpcCarrier } from '../fixtures/client-rpc.js'
import type {
  ContextUsageView,
  ExperienceStatusView,
  PlanningCommandResult,
  PlanningResultView,
  UsageExecutionView,
} from '../../src/types.js'

describe('M3 Browser planning controller', () => {
  it('submits explicit task facts, reads the exact plan, and never invents Browser authority state', async () => {
    const calls: Array<{ readonly endpoint: string; readonly input: unknown }> = []
    let current: PlanningResultView[] = []
    const created = planning('pending')
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string, input: unknown): Promise<ConnectionRpcResult<unknown>> => {
          calls.push({ endpoint, input })
          if (endpoint === 'status/query') return ok(status())
          if (endpoint === 'suggestions/query') return ok({
            projectionKey: 'experience-suggestions-v1', schemaVersion: 5,
            groups: [], sessions: [], seeds: [], dispositions: [],
          })
          if (endpoint === 'retrieval/query') return ok(retrievalProjection())
          if (endpoint === 'candidate/list') return ok([])
          if (endpoint === 'plan/list') return ok(current)
          if (endpoint === 'plan/config') return ok({
            taskFingerprintProposalMode: 'deterministic',
            provider: null,
            model: null,
            maxOutputTokens: null,
            promptVersion: 'task-fingerprint-v1',
          })
          if (endpoint === 'automation/config') return ok(automationConfigurationFixture())
          if (endpoint === 'plan/create') {
            current = [created]
            return ok({ receipt: receipt(), planning: created } satisfies PlanningCommandResult)
          }
          if (endpoint === 'plan/get') return ok(current[0])
          if (endpoint === 'context/get') return ok(context(current[0] ?? created))
          if (endpoint === 'usage/get') return ok(execution(current[0] ?? created))
          throw new Error(`unexpected endpoint ${endpoint}`)
        },
      },
    } as unknown as ConnectionHandle
    const store = createStore(throughExperienceRpcCarrier(connection))
    await store.refresh()
    await store.planTask('session-1', {
      text: 'Build and start Web',
      workspaceRoot: '/workspace',
      targetExposure: 'local',
      mustUseExperience: true,
      riskClass: 'medium',
      requiredCapabilities: ['build', 'web'],
      requestedUseMode: 'guided',
      overrideDecisionIds: [],
    }, false)
    expect(store.getSnapshot().selectedPlanning).toEqual(created)
    expect(calls.find(call => call.endpoint === 'plan/create')?.input).toMatchObject({
      input: {
        sessionId: 'session-1',
        interaction: 'ask_current_agent',
        confirmExternalModelProcessing: false,
        task: {
          text: 'Build and start Web',
          workspaceRoot: '/workspace',
          targetExposure: 'local',
          mustUseExperience: true,
          riskClass: 'medium',
          requiredCapabilities: ['build', 'web'],
        },
      },
    })
    expect(store.getSnapshot().selectedPlanning?.approvalRequest?.status).toBe('pending')
    expect(store.getSnapshot().selectedPlanning?.retryBinding).toBeNull()
    expect(store.getSnapshot().selectedContext).toEqual(context(created))
    expect(store.getSnapshot().selectedExecution).toEqual(execution(created))
  })
})

function planning(status: 'pending' | 'approved'): PlanningResultView {
  const plan = {
    usagePlanId: 'plan-1', usageId: 'usage-1', planRevision: 1, fingerprintId: 'fingerprint-1',
    matchSetId: 'match-1', preflightIds: [], selectedContributions: [], discardedContributions: [],
    orderedSteps: [], constraints: [], premises: [], hypotheses: [], recovery: [], verification: [], blockers: [],
    disposition: 'ready_for_approval', requiresApproval: true, contentDigest: 'sha256:plan',
    createdAt: '2026-09-02T00:00:00.000Z',
  } as unknown as PlanningResultView['plan']
  return {
    fingerprint: {
      fingerprintId: 'fingerprint-1', schemaVersion: 'task-fingerprint-v1', taskInputDigest: 'sha256:task',
      taskText: 'Build and start Web', actorRef: 'actor-1', intent: 'Build and start Web', taskFamily: 'startup',
      entities: [], expectedOutputs: [], artifactKinds: [], capabilities: ['build', 'web'], environmentRefs: ['/workspace'],
      hardConstraints: ['target_exposure:local'], acceptanceCriteria: [], riskClass: 'medium', targetExposure: 'local',
      fieldProvenance: {}, createdAt: '2026-09-02T00:00:00.000Z',
    } as unknown as PlanningResultView['fingerprint'],
    matchSet: {
      matchSetId: 'match-1', fingerprintId: 'fingerprint-1', retrievalVersion: 'bounded-structural-lexical-v1',
      candidateLimit: 32, candidates: [], noMatch: false, createdAt: '2026-09-02T00:00:00.000Z',
    } as unknown as PlanningResultView['matchSet'],
    preflights: [], plan,
    approvalRequest: {
      requestId: 'request-1', usagePlanId: plan.usagePlanId, usageId: plan.usageId, planRevision: 1,
      actorId: 'actor-1', status, riskClass: 'medium', scopeDigest: 'sha256:scope',
      createdAt: '2026-09-02T00:00:00.000Z', expiresAt: '2026-09-02T01:00:00.000Z',
      decidedAt: status === 'approved' ? '2026-09-02T00:01:00.000Z' : null,
      decisionId: status === 'approved' ? 'decision-1' : null, reason: null,
    } as unknown as NonNullable<PlanningResultView['approvalRequest']>,
    admissionAttempt: {
      admissionAttemptId: 'attempt-1', usageId: plan.usageId, requestId: 'request-1', actorId: 'actor-1',
      state: status === 'approved' ? 'approved' : 'pending_external_decision', reasonCode: 'test',
      createdAt: '2026-09-02T00:00:00.000Z',
    } as unknown as PlanningResultView['admissionAttempt'],
    retryBinding: null,
    interactionOutcome: status === 'approved' ? 'approved' : 'not_requested',
  }
}

function context(planning: PlanningResultView): ContextUsageView {
  return { planning, admissionAttempts: [planning.admissionAttempt], snapshot: null, delivery: null, retirements: [] }
}

function execution(planning: PlanningResultView): UsageExecutionView {
  return {
    usageId: planning.plan.usageId,
    progress: null,
    correlations: [],
    verification: null,
    settlement: null,
    revisionProposals: [],
    preferenceValidations: [],
  }
}

function receipt(): PlanningCommandResult['receipt'] {
  return {
    receiptId: 'receipt-1', commandId: 'command-1', action: 'usage.plan', actor: status().actor,
    usageId: 'usage-1', usagePlanId: 'plan-1', planRevision: 1, requestId: 'request-1', retryBindingId: null,
    correlationId: 'test', causationId: null, issuedAt: '2026-09-02T00:00:00.000Z',
    commitSequence: 1, createdAt: '2026-09-02T00:00:00.000Z',
  } as PlanningCommandResult['receipt']
}

function status(): ExperienceStatusView {
  const actor = {
    actorId: 'actor-1', principalId: 'principal-1', kind: 'browser_local_owner', authority: 'owner',
  } as ExperienceStatusView['actor']
  return {
    actor, principalId: actor.principalId, candidateCount: 0, versionCount: 1,
    latestReceipt: null, latestVersion: null, pendingPlanApprovalCount: 0, latestPlanning: null,
    latestForgetRequest: null,
  }
}

function ok(value: unknown): ConnectionRpcResult<unknown> {
  return { ok: true, value }
}
