import { SessionId } from '@deepseek-ai/dsh-session'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import { PlanReviewInteraction } from '../src/adapters/plan-interaction.js'
import type { PlanningResultView } from '../src/types.js'

describe('M3 standard plan-review adapter', () => {
  it('maps only the declared exact approve label to approval', async () => {
    let request: unknown
    const interaction = new PlanReviewInteraction(fakeContext(async value => {
      request = value
      return { answers: [{ id: 'request-1', selected: ['Approve exact plan'] }] }
    }))
    await expect(interaction.ask(planning(), 'session-1')).resolves.toEqual({
      kind: 'approve', reason: 'approved through standard plan-review interaction',
    })
    expect(request).toMatchObject({
      agent: { id: 'session-1' },
      questions: [{
        id: 'request-1',
        intent: { kind: 'plan-review', approve: 'Approve exact plan' },
        detail: expect.stringContaining('Digest: sha256:plan'),
      }],
    })
  })

  it('maps refusal, adaptation text, no provider, and abort without default approval', async () => {
    const refused = new PlanReviewInteraction(fakeContext(async () => ({
      answers: [{ id: 'request-1', selected: ['Refuse'] }],
    })))
    await expect(refused.ask(planning(), 'session-1')).resolves.toMatchObject({ kind: 'deny' })

    const adapted = new PlanReviewInteraction(fakeContext(async () => ({
      answers: [{ id: 'request-1', selected: [], custom: 'Keep build check, remove startup step' }],
    })))
    await expect(adapted.ask(planning(), 'session-1')).resolves.toEqual({
      kind: 'adapt', reason: 'Keep build check, remove startup step',
    })

    const unavailable = new PlanReviewInteraction(fakeContext(async () => {
      throw new UserQuestionError('none', 'NO_PROVIDER')
    }))
    await expect(unavailable.ask(planning(), 'session-1')).resolves.toMatchObject({ kind: 'no_provider' })

    const foreignUnavailable = new PlanReviewInteraction(fakeContext(async () => {
      throw Object.assign(new Error('none'), { name: 'UserQuestionError', code: 'NO_PROVIDER' })
    }))
    await expect(foreignUnavailable.ask(planning(), 'session-1'))
      .resolves.toEqual({ kind: 'no_provider', reason: 'interaction_answerer_unavailable' })

    const aborted = new PlanReviewInteraction(fakeContext(async () => {
      throw new UserQuestionError('aborted', 'ASK_ABORTED')
    }))
    await expect(aborted.ask(planning(), 'session-1')).resolves.toMatchObject({ kind: 'interrupted' })

    const cancelled = new PlanReviewInteraction(fakeContext(async () => {
      throw new UserQuestionError('cancelled', 'ASK_CANCELLED')
    }))
    await expect(cancelled.ask(planning(), 'session-1')).resolves.toEqual({
      kind: 'interrupted', reason: 'ask_cancelled',
    })
  })
})

function fakeContext(ask: (request: unknown) => Promise<unknown>): import('@deepseek-ai/cordis').Context {
  const agent = { id: SessionId('session-1') }
  return {
    get(name: string) {
      if (name === 'agents') return { get: (id: string) => id === agent.id ? agent : undefined }
      if (name === 'userQuestions') return { ask }
      return undefined
    },
  } as unknown as import('@deepseek-ai/cordis').Context
}

function planning(): PlanningResultView {
  return {
    fingerprint: {
      fingerprintId: 'fingerprint-1' as PlanningResultView['fingerprint']['fingerprintId'],
      schemaVersion: 'task-fingerprint-v1',
      taskInputDigest: 'sha256:task',
      taskText: 'start web',
      actorRef: 'actor-1',
      intent: 'start web',
      taskFamily: 'application_startup',
      entities: [], expectedOutputs: [], artifactKinds: [], capabilities: [], environmentRefs: [],
      hardConstraints: [], acceptanceCriteria: [], riskClass: 'medium', targetExposure: 'local',
      fieldProvenance: {}, createdAt: '2026-09-02T00:00:00.000Z',
    },
    matchSet: {
      matchSetId: 'match-1' as PlanningResultView['matchSet']['matchSetId'],
      fingerprintId: 'fingerprint-1' as PlanningResultView['fingerprint']['fingerprintId'],
      retrievalVersion: 'bounded-structural-lexical-v1', candidateLimit: 32, candidates: [], noMatch: false,
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    preflights: [],
    plan: {
      usagePlanId: 'plan-1' as PlanningResultView['plan']['usagePlanId'],
      usageId: 'usage-1' as PlanningResultView['plan']['usageId'],
      planRevision: 1,
      fingerprintId: 'fingerprint-1' as PlanningResultView['fingerprint']['fingerprintId'],
      matchSetId: 'match-1' as PlanningResultView['matchSet']['matchSetId'],
      preflightIds: [], useMode: 'guided', compositionPolicyVersion: 'typed-relations-v1',
      selectedRelationIds: [], overrideDecisionIds: [], preferenceEnforcements: [],
      selectedContributions: [], discardedContributions: [],
      orderedSteps: [{ stepId: 'step-01', content: 'Build first', componentRevisionId: 'revision-1' }],
      constraints: [], premises: [], hypotheses: [], recovery: [], verification: ['Read authenticated RPC'], blockers: [],
      disposition: 'ready_for_approval', requiresApproval: true, contentDigest: 'sha256:plan',
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    approvalRequest: {
      requestId: 'request-1' as NonNullable<PlanningResultView['approvalRequest']>['requestId'],
      usagePlanId: 'plan-1' as PlanningResultView['plan']['usagePlanId'],
      usageId: 'usage-1' as PlanningResultView['plan']['usageId'],
      planRevision: 1,
      actorId: 'actor-1' as NonNullable<PlanningResultView['approvalRequest']>['actorId'],
      principalId: 'principal-1' as NonNullable<PlanningResultView['approvalRequest']>['principalId'],
      status: 'pending', riskClass: 'medium', scopeDigest: 'sha256:scope',
      createdAt: '2026-09-02T00:00:00.000Z', expiresAt: '2026-09-02T01:00:00.000Z',
      decidedAt: null, decisionId: null, reason: null,
    },
    admissionAttempt: {
      admissionAttemptId: 'attempt-1' as PlanningResultView['admissionAttempt']['admissionAttemptId'],
      usageId: 'usage-1' as PlanningResultView['plan']['usageId'],
      requestId: 'request-1' as NonNullable<PlanningResultView['approvalRequest']>['requestId'],
      sessionId: 'session-1',
      actorId: 'actor-1' as PlanningResultView['admissionAttempt']['actorId'],
      state: 'pending_external_decision', reasonCode: 'pending', createdAt: '2026-09-02T00:00:00.000Z',
    },
    retryBinding: null,
    interactionOutcome: 'not_requested',
  }
}
