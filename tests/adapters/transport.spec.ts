import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute, ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import { createExperienceRpcHandler, registerExperienceTransport } from '../../src/adapters/transport.js'
import { brandedId } from '../../src/ids.js'
import type { DomainReceipt, ForgetDomainReceipt } from '../../src/types.js'
import { automationConfigurationFixture } from '../fixtures/automation.js'
import { proposeInput } from '../fixtures/workflow.js'

describe('M2 authenticated Browser transport', () => {
  it('registers one exact shared API route and preserves the Connection RPC envelope', async () => {
    const ctx = new Context()
    let route: ConnectionFetchRoute | undefined
    ctx.provide('connection', {
      fetch: {
        register(value: ConnectionFetchRoute) {
          route = value
          return async () => {}
        },
      },
    } as unknown as HostConnectionHandle)
    ctx.provide('experiences', {
      getAutomationConfiguration: () => automationConfigurationFixture(),
    } as never)
    registerExperienceTransport(ctx)
    expect(route).toMatchObject({ path: '/api/experience-map', methods: ['POST'], requestBody: 'buffered' })

    const response = await route!.fetch(new Request('http://dsh.internal/api/experience-map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'experience-transport-test',
        method: 'experience-map',
        payload: { endpoint: 'automation/config', payload: {} },
      }),
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: 'server-response',
      rpcId: 'experience-transport-test',
      result: { ok: true, value: { schemaVersion: 'experience-automation-configuration-v1' } },
    })
    await ctx.fiber.dispose()
  })

  it('reads recent suggestions without accepting forged query fields', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: { handle(_channel: string, registered: ConnectionRpcHandler) { handler = registered; return async () => {} } },
    } as HostConnectionHandle)
    const getSuggestionProjection = vi.fn(() => ({
      projectionKey: 'experience-suggestions-v1', generation: 1, sessions: [], seeds: [],
    }))
    const dismissSuggestion = vi.fn(() => ({
      projectionKey: 'experience-suggestions-v1', generation: 1, sessions: [], seeds: [], groups: [],
    }))
    const saveExperienceSuggestion = vi.fn(async () => ({ receiptId: 'receipt:suggestion-save' }))
    const getRetrievalProjection = vi.fn(() => ({
      projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
      manifest: { generation: 3, state: 'lexical_ready' }, documents: [],
    }))
    ctx.provide('experiences', {
      getSuggestionProjection, getRetrievalProjection, dismissSuggestion, saveExperienceSuggestion,
    } as never)
    handler = createExperienceRpcHandler(ctx)
    const signal = new AbortController().signal

    expect(await handler!('suggestions/query', {}, signal)).toMatchObject({
      ok: true, value: { projectionKey: 'experience-suggestions-v1', generation: 1 },
    })
    expect(getSuggestionProjection).toHaveBeenCalledWith({ kind: 'authenticated-browser' })
    expect(await handler!('suggestions/query', { actorId: 'forged-owner' }, signal)).toMatchObject({
      ok: false, error: { code: 'invalid_command' },
    })
    expect(await handler!('retrieval/query', {}, signal)).toMatchObject({
      ok: true, value: { projectionKey: 'experience-retrieval-v1', manifest: { generation: 3 } },
    })
    expect(getRetrievalProjection).toHaveBeenCalledWith({ kind: 'authenticated-browser' })
    expect(await handler!('retrieval/query', { actorId: 'forged-owner' }, signal))
      .toMatchObject({ ok: false, error: { code: 'invalid_command' } })
    const dismissInput = {
      commandId: 'dismiss-1',
      suggestionGroupId: 'suggestion-group:one',
      expectedRevisionDigest: `sha256:${'a'.repeat(64)}`,
      reviewDigest: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'not_reusable',
      issuedAt: '2026-09-10T08:00:00.000Z',
    }
    expect(await handler!('suggestions/dismiss', { input: dismissInput }, signal)).toMatchObject({
      ok: true, value: { projectionKey: 'experience-suggestions-v1', groups: [] },
    })
    expect(dismissSuggestion).toHaveBeenCalledWith(dismissInput, { kind: 'authenticated-browser' })
    expect(await handler!('suggestions/dismiss', {
      input: { ...dismissInput, actorId: 'forged-owner' },
    }, signal)).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
    expect(await handler!('suggestions/dismiss', {
      input: { ...dismissInput, reasonCode: 'silently_delete_forever' },
    }, signal)).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
    const saveInput = {
      commandId: 'save-1',
      suggestionGroupId: 'suggestion-group:one',
      expectedRevisionDigest: `sha256:${'a'.repeat(64)}`,
      reviewDigest: `sha256:${'b'.repeat(64)}`,
      sourceDigest: `sha256:${'c'.repeat(64)}`,
      correlationId: 'save-correlation',
      causationId: null,
      issuedAt: '2026-09-10T08:00:00.000Z',
    }
    expect(await handler!('suggestions/save', { input: saveInput }, signal)).toEqual({
      ok: true, value: { receiptId: 'receipt:suggestion-save' },
    })
    expect(saveExperienceSuggestion).toHaveBeenCalledWith(saveInput, { kind: 'authenticated-browser' })
    expect(await handler!('suggestions/save', {
      input: { ...saveInput, actorId: 'forged-owner' },
    }, signal)).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
  })

  it('reads automation configuration only from the authenticated owner boundary', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: { handle(_channel: string, registered: ConnectionRpcHandler) { handler = registered; return async () => {} } },
    } as HostConnectionHandle)
    const getAutomationConfiguration = vi.fn(() => automationConfigurationFixture())
    ctx.provide('experiences', { getAutomationConfiguration } as never)
    handler = createExperienceRpcHandler(ctx)
    const signal = new AbortController().signal

    expect(await handler!('automation/config', {}, signal)).toMatchObject({
      ok: true,
      value: { schemaVersion: 'experience-automation-configuration-v1' },
    })
    expect(getAutomationConfiguration).toHaveBeenCalledWith({ kind: 'authenticated-browser' })
    expect(await handler!('automation/config', { actorId: 'forged-owner' }, signal)).toMatchObject({
      ok: false, error: { code: 'invalid_command' },
    })
    expect(getAutomationConfiguration).toHaveBeenCalledTimes(1)
  })

  it('allows planning history to inherit Host settings or use a bounded explicit limit', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: { handle(_channel: string, registered: ConnectionRpcHandler) { handler = registered; return async () => {} } },
    } as HostConnectionHandle)
    const listPlanningResults = vi.fn(() => [])
    ctx.provide('experiences', { listPlanningResults } as never)
    handler = createExperienceRpcHandler(ctx)
    const signal = new AbortController().signal

    expect(await handler!('plan/list', {}, signal)).toEqual({ ok: true, value: [] })
    expect(listPlanningResults).toHaveBeenLastCalledWith({ kind: 'authenticated-browser' }, undefined)
    expect(await handler!('plan/list', { limit: 12 }, signal)).toEqual({ ok: true, value: [] })
    expect(listPlanningResults).toHaveBeenLastCalledWith({ kind: 'authenticated-browser' }, 12)

    for (const payload of [null, [], { limit: null }, { limit: 0 }, { limit: 101 }, { limit: 1.5 },
      { limit: '12' }, { actorId: 'forged-owner' }, { limit: 12, actorId: 'forged-owner' }]) {
      expect(await handler!('plan/list', payload, signal)).toMatchObject({
        ok: false, error: { code: 'invalid_command' },
      })
    }
    expect(listPlanningResults).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('keeps Forget preview, commit, and readback behind authenticated owner endpoints', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: { handle(_channel: string, registered: ConnectionRpcHandler) { handler = registered; return async () => {} } },
    } as HostConnectionHandle)
    const previewForget = vi.fn(() => ({ previewDigest: `sha256:${'a'.repeat(64)}` }))
    const forgetExperience = vi.fn(async () => forgetReceipt())
    const getForgetRequest = vi.fn(() => ({ forgetRequestId: 'forget-1', state: 'completed' }))
    ctx.provide('experiences', { previewForget, forgetExperience, getForgetRequest } as never)
    handler = createExperienceRpcHandler(ctx)

    expect(await handler!('forget/preview', { experienceId: 'experience-1' }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { previewDigest: expect.stringMatching(/^sha256:/) } })
    expect(await handler!('forget/commit', { input: forgetCommand() }, new AbortController().signal))
      .toEqual({ ok: true, value: { receiptId: 'receipt-forget-1' } })
    expect(await handler!('forget/get', { forgetRequestId: 'forget-1' }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { state: 'completed' } })
    expect(forgetExperience).toHaveBeenCalledWith(expect.objectContaining({
      experienceId: 'experience-1', expectedSeriesRevision: 2,
    }), { kind: 'authenticated-browser' })
    const forged = await handler!('forget/commit', {
      input: { ...forgetCommand(), actorId: 'forged-owner' },
    }, new AbortController().signal)
    expect(forged).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
  })

  it('reads the reconciled M6 learning projection through the existing authenticated channel', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: { handle(_channel: string, registered: ConnectionRpcHandler) { handler = registered; return async () => {} } },
    } as HostConnectionHandle)
    const getLearningProjection = vi.fn(async () => ({
      projectionKey: 'experience-learning-v1', builderVersion: 'm6-learning-v2',
      generation: 2, sourceOffset: 17, rows: [],
      counts: { extraction: 0, applicability: 0, revision: 0, execution: 0 },
      unsupportedCapabilities: ['merge', 'causal_promotion'],
    }))
    ctx.provide('experiences', { getLearningProjection } as never)
    handler = createExperienceRpcHandler(ctx)

    const result = await handler!('learning/query', {}, new AbortController().signal)

    expect(result).toMatchObject({ ok: true, value: { generation: 2, sourceOffset: 17 } })
    expect(getLearningProjection).toHaveBeenCalledWith({ kind: 'authenticated-browser' })
  })

  it('exposes M7 projections, evaluation, and write receipts through the authenticated channel', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: { handle(_channel: string, registered: ConnectionRpcHandler) { handler = registered; return async () => {} } },
    } as HostConnectionHandle)
    const exportMarkdown = vi.fn(async () => ({ receipt: { markdownProjectionReceiptId: 'projection-1' }, markdown: '# projection' }))
    const proposeMarkdownRevision = vi.fn(async () => ({ receiptId: 'receipt-markdown-1' }))
    const evaluateInfrastructureReadiness = vi.fn(async () => ({ receiptId: 'receipt-readiness-1' }))
    const recordEvaluationObservation = vi.fn(async () => ({ receiptId: 'receipt-evaluation-1' }))
    ctx.provide('experiences', {
      getAuditDossier: () => ({ subject: { kind: 'experience', id: 'experience-1' }, timeline: [] }),
      exportMarkdown,
      getMarkdownProjection: () => ({ receipt: { markdownProjectionReceiptId: 'projection-1' }, markdown: '# projection' }),
      proposeMarkdownRevision,
      getRelationMap: () => ({ projectionKey: 'experience-relation-map-v1', nodes: [], edges: [] }),
      getInfrastructureReadiness: () => ({ decision: 'not_ready' }),
      evaluateInfrastructureReadiness,
      recordEvaluationObservation,
      getEvaluationReport: () => ({ cohortId: 'cohort-1', comparable: false, arms: [] }),
    } as never)
    handler = createExperienceRpcHandler(ctx)

    const signal = new AbortController().signal
    expect(await handler!('audit/query', { input: {
      subject: { kind: 'experience', id: 'experience-1' }, asOfRecordedAt: null, cursor: null, limit: 20,
    } }, signal)).toMatchObject({ ok: true, value: { timeline: [] } })
    expect(await handler!('markdown/export', { input: {
      ...commandEnvelope('transport-markdown-export'), experienceVersionId: 'version-1',
    } }, signal)).toMatchObject({ ok: true, value: { markdown: '# projection' } })
    expect(await handler!('markdown/propose-revision', { input: {
      ...commandEnvelope('transport-markdown-import'), markdownProjectionReceiptId: 'projection-1',
      editedMarkdown: '# changed', editedMarkdownDigest: `sha256:${'b'.repeat(64)}`,
    } }, signal)).toEqual({ ok: true, value: { receiptId: 'receipt-markdown-1' } })
    expect(await handler!('relation-map/query', {}, signal)).toMatchObject({
      ok: true, value: { projectionKey: 'experience-relation-map-v1' },
    })
    expect(await handler!('infrastructure/evaluate', {
      input: commandEnvelope('transport-readiness'),
    }, signal)).toEqual({ ok: true, value: { receiptId: 'receipt-readiness-1' } })
    expect(await handler!('evaluation/observe', { input: {
      ...commandEnvelope('transport-evaluation'), observation: evaluationObservation(),
    } }, signal)).toEqual({ ok: true, value: { receiptId: 'receipt-evaluation-1' } })
    expect(await handler!('evaluation/report', { cohortId: 'cohort-1' }, signal)).toMatchObject({
      ok: true, value: { cohortId: 'cohort-1' },
    })
    expect(exportMarkdown).toHaveBeenCalledWith(expect.objectContaining({ experienceVersionId: 'version-1' }),
      { kind: 'authenticated-browser' })
    expect(proposeMarkdownRevision).toHaveBeenCalledWith(expect.objectContaining({
      markdownProjectionReceiptId: 'projection-1',
    }), { kind: 'authenticated-browser' })
    expect(evaluateInfrastructureReadiness).toHaveBeenCalledWith(
      expect.not.objectContaining({ measuredQueryBottleneck: expect.anything() }),
      { kind: 'authenticated-browser' },
    )
    expect(recordEvaluationObservation).toHaveBeenCalledWith(expect.objectContaining({
      observation: expect.objectContaining({ comparisonArm: 'no_memory', erroneousReuse: false }),
    }), { kind: 'authenticated-browser' })
  })

  it('parses Candidate commands, derives Browser origin, and returns only a Receipt key', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: {
        handle(channel: string, registered: ConnectionRpcHandler) {
          expect(channel).toBe('/experience-map')
          handler = registered
          return async () => {}
        },
      },
    } as HostConnectionHandle)
    const submit = vi.fn(async () => receipt())
    ctx.provide('experiences', { submitCandidate: submit } as never)
    handler = createExperienceRpcHandler(ctx)
    expect(handler).toBeDefined()
    const result = await handler!('candidate/submit', { input: command() }, new AbortController().signal)
    expect(result).toEqual({ ok: true, value: { receiptId: 'receipt-1' } })
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: 'candidate-1', expectedRevision: 1,
    }), { kind: 'authenticated-browser' })

    const actorInjection = await handler!('candidate/submit', {
      input: { ...command(), actorId: 'forged-owner' },
    }, new AbortController().signal)
    expect(actorInjection).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
  })

  it('propagates the authenticated request cancellation to proposal work', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: {
        handle(_channel: string, registered: ConnectionRpcHandler) {
          handler = registered
          return async () => {}
        },
      },
    } as HostConnectionHandle)
    const inspect = vi.fn(async () => ({ inspected: true }))
    ctx.provide('experiences', { inspectProposalSource: inspect } as never)
    handler = createExperienceRpcHandler(ctx)
    const controller = new AbortController()
    await handler!('proposal-source/inspect', {
      episode: { sessionId: 'session-1' },
      requestedKind: 'diagnostic',
      outputTokenLimit: { mode: 'configured_default' },
      requestedTriggerKind: 'terminal_success',
    }, controller.signal)
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ episode: { sessionId: 'session-1' } }),
      { kind: 'authenticated-browser' },
      controller.signal,
    )
  })

  it('rejects a Client-injected trigger kind before proposal work starts', async () => {
    const ctx = new Context()
    let handler: ConnectionRpcHandler | undefined
    ctx.provide('connection', {
      rpc: {
        handle(_channel: string, registered: ConnectionRpcHandler) {
          handler = registered
          return async () => {}
        },
      },
    } as HostConnectionHandle)
    const propose = vi.fn(async () => receipt())
    ctx.provide('experiences', { proposeCandidate: propose } as never)
    handler = createExperienceRpcHandler(ctx)

    const result = await handler!('candidate/propose', {
      input: { ...proposeInput(), triggerKind: 'terminal_success' },
    }, new AbortController().signal)

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
    expect(propose).not.toHaveBeenCalled()
  })
})

function command() {
  return {
    commandId: '30000000-0000-4000-8000-000000000001',
    candidateId: 'candidate-1',
    expectedRevision: 1,
    correlationId: 'transport-test',
    causationId: null,
    issuedAt: '2026-08-31T09:00:00.000Z',
  }
}

function receipt(): DomainReceipt {
  return {
    receiptId: brandedId<'ExperienceReceiptId'>('receipt-1', 'receiptId'),
    commandId: brandedId<'ExperienceCommandId'>('30000000-0000-4000-8000-000000000001', 'commandId'),
    action: 'candidate.submit',
    actor: {
      actorId: brandedId<'ExperienceActorId'>('actor-browser', 'actorId'),
      principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('principal-1', 'principalId'),
      kind: 'browser_local_owner',
      authority: 'owner',
    },
    candidateId: brandedId<'ExperienceCandidateId'>('candidate-1', 'candidateId'),
    candidateRevision: 2,
    experienceId: null,
    experienceVersionId: null,
    correlationId: 'transport-test',
    causationId: null,
    issuedAt: '2026-08-31T09:00:00.000Z',
    commitSequence: 1,
    createdAt: '2026-08-31T09:00:01.000Z',
  }
}

function forgetCommand() {
  return {
    commandId: '70000000-0000-4000-8000-000000000001',
    experienceId: 'experience-1',
    expectedSeriesRevision: 2,
    previewDigest: `sha256:${'a'.repeat(64)}`,
    reason: 'Owner confirmed obsolete guidance',
    correlationId: 'transport-forget-test',
    causationId: null,
    issuedAt: '2026-09-02T09:00:00.000Z',
  }
}

function forgetReceipt(): ForgetDomainReceipt {
  return {
    receiptId: brandedId<'ExperienceReceiptId'>('receipt-forget-1', 'receiptId'),
    commandId: brandedId<'ExperienceCommandId'>('70000000-0000-4000-8000-000000000001', 'commandId'),
    action: 'experience.forget',
    actor: {
      actorId: brandedId<'ExperienceActorId'>('actor-browser', 'actorId'),
      principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('principal-1', 'principalId'),
      kind: 'browser_local_owner', authority: 'owner',
    },
    forgetRequestId: brandedId<'ExperienceForgetRequestId'>('forget-1', 'forgetRequestId'),
    experienceId: brandedId<'ExperienceId'>('experience-1', 'experienceId'),
    seriesRevision: 3,
    correlationId: 'transport-forget-test', causationId: null,
    issuedAt: '2026-09-02T09:00:00.000Z', commitSequence: 2,
    createdAt: '2026-09-02T09:00:01.000Z',
  }
}

function commandEnvelope(commandId: string) {
  return {
    commandId,
    correlationId: 'transport-m7',
    causationId: null,
    issuedAt: '2026-09-03T09:00:00.000Z',
  }
}

function evaluationObservation() {
  return {
    cohortId: 'cohort-1', comparisonArm: 'no_memory', taskCaseId: 'case-1', taskFamilyId: 'family-1',
    taskFingerprintId: null, usageId: null, settlementId: null, split: 'test',
    taskOccurredAt: '2026-09-03T09:00:00.000Z', trainingWindowEndsAt: '2026-09-02T09:00:00.000Z',
    trainingEpisodeRefs: ['training://one'], modelVersion: 'model-1', toolsetVersion: 'tools-1',
    contextBudget: 8_192, verifierVersion: 'verifier-1', taskCorpusVersion: 'corpus-1', outcome: 'unknown',
    acceptanceResultRefs: ['acceptance://one'], decisionAnchorRefs: [], routeSignature: 'route-1', elapsedMs: 1,
    modelRoundCount: 1, toolCallCount: 0, inputTokens: 1, outputTokens: 1, humanActionCount: 0,
    repeatedExplorationCount: 0, erroneousSideEffectCount: 0, erroneousReuse: false,
    retrievalResult: 'not_applicable', applicabilityDecision: 'not_applicable', pollutionIncident: false,
    explanationCoverage: 0, metricSourceRefs: ['metric://one'],
  }
}
