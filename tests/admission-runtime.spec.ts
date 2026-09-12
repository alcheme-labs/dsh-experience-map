import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createExperienceContextMessage,
  createExperienceRetirementMessage,
} from '../src/adapters/context-message.js'
import { PlanningObservationRegistry } from '../src/adapters/observations.js'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { ExperiencePlanningService, type RecallPreparationPort } from '../src/application/planning-service.js'
import { SessionAdmission } from '../src/application/session-admission.js'
import { contextSections, materializeContextSnapshot, renderContext } from '../src/domain/context.js'
import { admissionTaskDigest, digest, recallDecisionKey, usageScopeDigest } from '../src/domain/planning.js'
import { projectExperienceVersion, projectTaskFingerprint } from '../src/domain/retrieval-projector.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import { RuntimeSettingsSchema, type RuntimeSettings } from '../src/runtime-settings-schema.js'
import type {
  ActorView,
  CriterionVerificationView,
  ContextDeliveryView,
  ExperienceRetrievalProjectionView,
  PlanTaskCommandInput,
  PlanningObservationView,
  TaskFingerprintView,
  VerificationRunView,
} from '../src/types.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { diagnosticSpec } from './fixtures/retrieval-fixture.js'
import { seedVersion } from './fixtures/store-seed.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M4 public Harness admission seams', () => {
  it('keeps automatic recall and Context injection as independent live controls', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-independent-automation-controls' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    let values = RuntimeSettingsSchema({
      automaticRecall: false,
      automaticContextInjection: 'never',
      automaticToolExecution: 'when_eligible',
      defaultMustUseExperience: true,
    } as RuntimeSettings)
    const admission = new SessionAdmission(
      ctx,
      fixture.repository,
      new ActorResolver(fixture.principalId),
      fixture.observations,
      fixture.planning,
      executionStub(fixture.repository, fixture.principalId),
      {
        claimLeaseMs: 30_000,
        automaticRecall: true,
        defaultTargetExposure: 'local',
        defaultRiskClass: 'standard',
        defaultMustUseExperience: true,
      },
      undefined,
      () => ({ revision: 1, digest: `sha256:${'1'.repeat(64)}`, values }),
    )
    admission.install()
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const agent = { id: session.id, session, options: {}, ctx, status: 'running' } as never

    expect(await runPreStep(ctx, agent, user, 1)).toEqual({ kind: 'enter', messages: [user] })
    expect(fixture.repository.listActiveContextDeliveries(String(session.id))).toEqual([])
    expect(fixture.repository.getPlanningResult(
      String(fixture.approved.planning.plan.usageId), fixture.owner,
    ).retryBinding).toMatchObject({ state: 'active' })

    values = RuntimeSettingsSchema({
      automaticRecall: false,
      automaticContextInjection: 'after_current_plan_approval',
      automaticToolExecution: 'when_eligible',
      defaultMustUseExperience: true,
    } as RuntimeSettings)
    const admitted = await runPreStep(ctx, agent, user, 1)
    expect(admitted.kind).toBe('enter')
    if (admitted.kind !== 'enter') throw new Error('expected approved Context admission')
    expect(admitted.messages[0]?.source).toMatchObject({ kind: 'experience', lifecycle: 'active' })
    await fixture.database.close()
  })

  it('adds one plugin message through pre-step and records the exact LLM request', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-runtime' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const admission = new SessionAdmission(
      ctx,
      fixture.repository,
      new ActorResolver(fixture.principalId),
      fixture.observations,
      fixture.planning,
      executionStub(fixture.repository, fixture.principalId),
      {
        claimLeaseMs: 30_000,
        automaticRecall: false,
        defaultTargetExposure: 'local',
        defaultRiskClass: 'standard',
        defaultMustUseExperience: true,
      },
    )
    admission.install()
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const agent = {
      id: session.id,
      session,
      options: {},
      ctx,
      status: 'running',
    } as never
    const decision: PreStepDecision = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent,
      messages: [user],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [user] }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected enter decision')
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]?.source).toMatchObject({ kind: 'experience', lifecycle: 'active' })
    expect(decision.messages[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('禁止把以下误导信号当作事实或成功依据'),
      }),
    ]))
    expect(decision.messages[1]).toBe(user)
    session.append('step/start', { turn: 1, step: 1 })
    for (const message of decision.messages) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    let terminalCalls = 0
    const terminal = (): AsyncIterable<never> => {
      terminalCalls++
      return (async function* () {})()
    }
    const missingSessionStream = ctx.waterfall(ctx as never, 'llm/stream', {
      provider: 'test',
      model: 'test',
      messages: decision.messages,
      sessionId: 'missing-session' as never,
    }, terminal)
    expect(terminalCalls).toBe(0)
    await expect((async () => {
      for await (const _chunk of missingSessionStream) void _chunk
    })()).rejects.toThrow('non-live Session')
    expect(terminalCalls).toBe(0)
    const stream = ctx.waterfall(ctx as never, 'llm/stream', {
      provider: 'test',
      model: 'test',
      messages: session.deriveMessages(),
      sessionId: session.id,
    }, terminal)
    expect(terminalCalls).toBe(0)
    for await (const _chunk of stream) void _chunk
    expect(terminalCalls).toBe(1)
    const context = fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    )
    expect(context.delivery).toMatchObject({
      deliveryStatus: 'included_in_request',
      sessionId: session.id,
      sessionEventSeq: 1,
    })
    expect(session.snapshotEvents()[1]).toMatchObject({
      type: 'user/message',
      data: { source: { kind: 'experience', lifecycle: 'active' } },
    })
    const nextUser = createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: `sha256:${'a'.repeat(64)}`,
          mediaType: 'image/png',
          bytes: 3,
          width: 1,
          height: 1,
        } as never,
      }],
      source: { kind: 'user' },
    })
    const second = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent,
      messages: [nextUser],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [nextUser] }))
    expect(second).toEqual({ kind: 'enter', messages: [nextUser] })
    expect(session.snapshotEvents()[3]).toMatchObject({
      type: 'user/message',
      sourceEventSeqs: [1],
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
      data: { source: { kind: 'experience', lifecycle: 'inactive' } },
    })
    expect(fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    ).retirements).toEqual([expect.objectContaining({
      status: 'replaced_on_surface',
      replacedSessionEventSeq: 1,
      replacementSessionEventSeq: 3,
    })])
    expect(fixture.repository.getUsageExecution(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    )).toMatchObject({
      verification: {
        providerVersion: 'experience-recall-trigger-v1',
        criteria: [{ criterionId: 'RECALL-TRIGGER-001', result: 'pass', reasonCode: 'next_user_turn' }],
      },
      settlement: { outcome: 'unknown' },
    })
    await fixture.database.close()
  })

  it('does not claim a text approval for a task batch that also contains non-text input', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-multimodal' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const admission = installedAdmission(ctx, session, fixture, false, true)
    const user = createUserMessage({
      content: [
        { type: 'text', text: fixture.task.text },
        {
          type: 'image',
          attachment: {
            attachmentId: `sha256:${'b'.repeat(64)}`,
            mediaType: 'image/png',
            bytes: 3,
            width: 1,
            height: 1,
          } as never,
        },
      ],
      source: { kind: 'user' },
    })
    expect(await runPreStep(ctx, admission.agent, user, 1))
      .toEqual({ kind: 'enter', messages: [user] })
    expect(fixture.repository.getPlanningResult(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    ).retryBinding).toMatchObject({ state: 'active' })
    await fixture.database.close()
  })

  it('retires a settled Context from the Session surface without rewriting its outcome', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-settled-context-retirement' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const installed = installedAdmission(ctx, session, fixture, false, true)
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const first = await runPreStep(ctx, installed.agent, user, 1)
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('expected initial admitted context')
    session.append('step/start', { turn: 1, step: 1 })
    for (const message of first.messages) session.append('user/message', message, { surfaceOp: 'append' })
    for await (const _chunk of ctx.waterfall(ctx as never, 'llm/stream', {
      provider: 'test',
      model: 'test',
      messages: session.deriveMessages(),
      sessionId: session.id,
    }, (): AsyncIterable<never> => (async function* () {})())) void _chunk
    await completeAndSettleUsage(
      fixture,
      String(fixture.approved.planning.plan.usageId),
    )
    expect(fixture.repository.listActiveContextDeliveries(String(session.id))).toHaveLength(1)

    const image = createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: `sha256:${'c'.repeat(64)}`,
          mediaType: 'image/png',
          bytes: 3,
          width: 1,
          height: 1,
        } as never,
      }],
      source: { kind: 'user' },
    })
    expect(await runPreStep(ctx, installed.agent, image, 2))
      .toEqual({ kind: 'enter', messages: [image] })
    expect(fixture.repository.listActiveContextDeliveries(String(session.id))).toEqual([])
    expect(fixture.repository.getUsageExecution(
      String(fixture.approved.planning.plan.usageId), fixture.owner,
    )).toMatchObject({ settlement: { outcome: 'success' } })
    await fixture.database.close()
  })

  it('rejects a conflicting active Session Usage before persisting Context', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-conflicting-usage' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const execution = {
      assertCanActivate: () => { throw new Error('another guided Experience Usage is active in this Session') },
      activate: () => { throw new Error('unreachable activation') },
    }
    const admission = new SessionAdmission(
      ctx,
      fixture.repository,
      new ActorResolver(fixture.principalId),
      fixture.observations,
      fixture.planning,
      execution as never,
      {
        claimLeaseMs: 30_000,
        automaticRecall: false,
        defaultTargetExposure: 'local',
        defaultRiskClass: 'standard',
        defaultMustUseExperience: true,
      },
    )
    admission.install()
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const agent = { id: session.id, session, options: {}, ctx, status: 'running' } as never

    expect(await runPreStep(ctx, agent, user, 1)).toEqual({ kind: 'reject' })
    expect(fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    )).toMatchObject({ snapshot: null, delivery: null })
    expect(fixture.repository.getPlanningResult(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    ).retryBinding).toMatchObject({ state: 'claimed' })
    await fixture.database.close()
  })

  it('reconciles a prepared delivery that never reached the Session without duplicating it', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-prepared-crash' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const admission = installedAdmission(ctx, session, fixture, false, true)
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const first = await runPreStep(ctx, admission.agent, user, 1)
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('expected prepared context')
    expect(first.messages[0]?.source).toMatchObject({ kind: 'experience', lifecycle: 'active' })

    const nextUser = createUserMessage({
      content: [{ type: 'text', text: 'Continue after the interrupted admission' }],
      source: { kind: 'user' },
    })
    const second = await runPreStep(ctx, admission.agent, nextUser, 2)
    expect(second).toEqual({ kind: 'enter', messages: [nextUser] })
    expect(fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    ).delivery).toMatchObject({
      deliveryStatus: 'failed_before_send',
      sessionEventSeq: null,
    })
    expect(session.snapshotEvents()).toEqual([])
    await fixture.database.close()
  })

  it('reconciles Session append before the delivery write and retires without duplicating context', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-append-before-write' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const runtimeActor = new ActorResolver(fixture.principalId).resolve({
      kind: 'restricted-runtime',
      runtimeKind: 'agent',
      runtimeId: String(session.id),
    })
    const claimed = await fixture.repository.claimAdmissionRetryBinding({
      taskInputDigest: admissionTaskDigest(fixture.task.text),
      sessionId: String(session.id),
      scopeDigest: usageScopeDigest(fixture.task),
      workspaceRoot: fixture.task.workspaceRoot,
      runtimeActor,
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()
    const prepared = prepareContext(claimed!.planning, String(session.id))
    await fixture.repository.consumeClaimAndPrepareContext({
      claimed: claimed!,
      currentObservations: await fixture.observations.observe(fixture.task),
      snapshot: prepared.snapshot,
      delivery: prepared.delivery,
    })
    session.append('step/start', { turn: 1, step: 1 })
    const appended = session.append('user/message', prepared.message, { surfaceOp: 'append' })

    const admission = installedAdmission(ctx, session, fixture, false, true)
    const nextUser = createUserMessage({
      content: [{ type: 'text', text: 'Continue after the append-before-write crash' }],
      source: { kind: 'user' },
    })
    expect(await runPreStep(ctx, admission.agent, nextUser, 2))
      .toEqual({ kind: 'enter', messages: [nextUser] })
    const events = session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(events.filter(event => event.data.id === prepared.message.id)).toHaveLength(1)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        seq: appended.seq,
        data: expect.objectContaining({ source: expect.objectContaining({ lifecycle: 'active' }) }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({ source: expect.objectContaining({ lifecycle: 'inactive' }) }),
      }),
    ]))
    expect(fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    )).toMatchObject({
      delivery: { deliveryStatus: 'appended_to_session', sessionEventSeq: appended.seq },
      retirements: [{ status: 'replaced_on_surface', replacedSessionEventSeq: appended.seq }],
    })
    await fixture.database.close()
  })

  it('reconciles a Session replacement appended before the retirement write', async () => {
    const fixture = await approvedFixture()
    const ctx = new Context()
    const session = Session.create('session-retirement-before-write' as never)
    let replacementSeq: number | null = null
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session, {
      traceEvent: async () => ({ replacementChain: replacementSeq === null ? [] : [replacementSeq] }),
    }))
    const admission = installedAdmission(ctx, session, fixture, false, true)
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const first = await runPreStep(ctx, admission.agent, user, 1)
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('expected admitted context')
    session.append('step/start', { turn: 1, step: 1 })
    for (const message of first.messages) session.append('user/message', message, { surfaceOp: 'append' })
    const terminal = (): AsyncIterable<never> => (async function* () {})()
    for await (const _chunk of ctx.waterfall(ctx as never, 'llm/stream', {
      provider: 'test',
      model: 'test',
      messages: session.deriveMessages(),
      sessionId: session.id,
    }, terminal)) void _chunk
    const usage = fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    )
    if (usage.delivery === null) throw new Error('expected included Context delivery')
    const pending = await fixture.repository.requestContextRetirement(usage.delivery, 'next_usage')
    const marker = createExperienceRetirementMessage({
      usageId: String(usage.delivery.usageId),
      contextSnapshotId: String(usage.delivery.contextSnapshotId),
      contextDeliveryId: String(usage.delivery.contextDeliveryId),
    }, String(pending.contextRetirementId))
    const replacement = session.append('user/message', marker, {
      surfaceOp: {
        op: 'replace',
        startSeq: SessionSeq(pending.replacedSessionEventSeq),
        endSeq: SessionSeq(pending.replacedSessionEventSeq),
      },
      sourceEventSeqs: [SessionSeq(pending.replacedSessionEventSeq)],
    })
    replacementSeq = replacement.seq

    const nextUser = createUserMessage({
      content: [{ type: 'text', text: 'Continue after the retirement-before-write crash' }],
      source: { kind: 'user' },
    })
    expect(await runPreStep(ctx, admission.agent, nextUser, 2))
      .toEqual({ kind: 'enter', messages: [nextUser] })
    expect(session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'experience'
      && event.data.source.lifecycle === 'inactive')).toHaveLength(1)
    expect(fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId),
      fixture.owner,
    ).retirements).toEqual([expect.objectContaining({
      contextRetirementId: pending.contextRetirementId,
      status: 'replaced_on_surface',
      replacementSessionEventSeq: replacement.seq,
    })])
    await fixture.database.close()
  })

  it('re-recalls after one registered failure, settles the old Usage, and does not repeat the generation', async () => {
    const fixture = await approvedFixture()
    const diagnostic = await seedVersion(fixture.database, fixture.owner, {
      ...diagnosticSpec(
        'Port already in use recovery',
        'Diagnose EADDRINUSE before retrying the local Web process',
        'eaddrinuse port already in use inspect listener choose free port verify health',
      ),
      scope: { taskFamily: 'application_startup', targetExposure: 'local' },
    })
    const ctx = new Context()
    const session = Session.create('session-failure-rerecall' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const runtime = {
      revision: null,
      digest: `sha256:${'e'.repeat(64)}`,
      values: RuntimeSettingsSchema({
        automaticRecall: true,
        defaultMustUseExperience: true,
      } as RuntimeSettings),
    }
    const recall = lexicalRecall(fixture.repository, fixture.owner)
    const planning = new ExperiencePlanningService(
      fixture.repository,
      fixture.observations,
      { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
      {
        retrievalCandidateLimit: 32,
        observationFreshnessMs: 300_000,
        planApprovalTtlMs: 1_800_000,
        maxPlanningTaskBytes: 32_768,
      },
      'deterministic',
      undefined,
      recall,
    )
    const admission = new SessionAdmission(
      ctx,
      fixture.repository,
      new ActorResolver(fixture.principalId),
      fixture.observations,
      planning,
      executionStub(fixture.repository, fixture.principalId),
      {
        claimLeaseMs: 30_000,
        automaticRecall: true,
        defaultTargetExposure: 'local',
        defaultRiskClass: 'standard',
        defaultMustUseExperience: true,
      },
      undefined,
      () => runtime,
    )
    admission.install()
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const agent = { id: session.id, session, options: {}, ctx, status: 'running' } as never
    const first = await runPreStep(ctx, agent, user, 1)
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('expected initial admitted context')
    session.append('step/start', { turn: 1, step: 1 })
    for (const message of first.messages) session.append('user/message', message, { surfaceOp: 'append' })
    const firstContext = first.messages[0]!
    const terminal = (): AsyncIterable<never> => (async function* () {})()
    for await (const _chunk of ctx.waterfall(ctx as never, 'llm/stream', {
      provider: 'test', model: 'test', messages: session.deriveMessages(), sessionId: session.id,
    }, terminal)) void _chunk

    const callId = 'call-eaddrinuse' as never
    const assistant = createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"dsh web"}' }],
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"dsh web"}',
    })
    const failureMessage = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'listen EADDRINUSE: address already in use\n[exit code: 1]' }],
      isError: false,
    })
    const failure = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: failureMessage,
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const triggeredTask = {
      ...fixture.task,
      text: `${fixture.task.text}\n\nObserved registered tool failure: eaddrinuse`,
    }
    const decisionKey = recallDecisionKey({
      sessionId: String(session.id),
      actorRef: String(fixture.principalId),
      task: triggeredTask,
      triggerKind: 'registered_tool_failure',
      triggerGeneration: `failure:${String(failure.seq)}:eaddrinuse`,
    })
    const created = await planning.plan({
      commandId: brandedId<'ExperienceCommandId'>('failure-rerecall-plan', 'commandId'),
      correlationId: 'failure-rerecall',
      causationId: null,
      issuedAt: new Date().toISOString(),
      sessionId: null,
      interaction: 'defer',
      confirmExternalModelProcessing: false,
      task: triggeredTask,
    }, fixture.owner, undefined, runtime, decisionKey)
    expect(created.planning.matchSet).toMatchObject({
      retrievalVersion: 'conservative-hybrid-v1',
      retrievalDecision: { primaryExperienceVersionId: diagnostic.experienceVersionId },
    })
    const request = created.planning.approvalRequest!
    await fixture.repository.decidePlan({
      commandId: brandedId<'ExperienceCommandId'>('failure-rerecall-approve', 'commandId'),
      requestId: request.requestId,
      usagePlanId: request.usagePlanId,
      expectedPlanRevision: request.planRevision,
      decision: 'approve',
      reason: 'approve deterministic failure re-recall test',
      correlationId: 'failure-rerecall',
      causationId: created.receipt.receiptId,
      issuedAt: new Date().toISOString(),
    }, fixture.owner)

    const second = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent,
      messages: [],
      turn: 1,
      step: 2,
      signal: new AbortController().signal,
    }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(second.kind).toBe('enter')
    if (second.kind !== 'enter') throw new Error('expected failure-triggered admitted context')
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]).not.toBe(firstContext)
    expect(fixture.repository.getContextUsage(
      String(fixture.approved.planning.plan.usageId), fixture.owner,
    )).toMatchObject({ retirements: [{ reason: 'plan_superseded', status: 'replaced_on_surface' }] })
    expect(fixture.repository.getUsageExecution(
      String(fixture.approved.planning.plan.usageId), fixture.owner,
    )).toMatchObject({
      verification: {
        providerVersion: 'experience-recall-trigger-v1',
        criteria: [{
          criterionId: 'RECALL-TRIGGER-001',
          result: 'fail',
          reasonCode: 'registered_tool_failure',
          sourceRef: `dsh-session:${String(session.id)}#${String(failure.seq)}`,
          boundedValue: {
            evidenceDigest: expect.stringMatching(/^sha256:/u),
            evidenceSummary: expect.stringContaining('registered_tool_failure:eaddrinuse'),
          },
        }],
      },
      settlement: { outcome: 'failure' },
    })
    expect(fixture.repository.listUnsettledSessionContextDeliveries(
      String(session.id), fixture.owner,
    )).toEqual([expect.objectContaining({ usageId: created.planning.plan.usageId })])

    session.append('step/start', { turn: 1, step: 2 })
    session.append('user/message', second.messages[0]!, { surfaceOp: 'append' })
    const genericCallId = 'call-generic-failure' as never
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      stream: [],
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: genericCallId, name: 'bash', arguments: '{"command":"false"}' }],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1, step: 2, callId: genericCallId, name: 'bash', arguments: '{"command":"false"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId: genericCallId,
        content: [{ type: 'text', text: 'command exited with generic exit_code_1' }],
        isError: true,
      }),
      error: { name: 'Error', code: 'exit_code_1' },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    const countBeforeReplay = fixture.repository.listPlanningResults(fixture.owner, 20).length
    const third = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent,
      messages: [],
      turn: 1,
      step: 3,
      signal: new AbortController().signal,
    }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(third).toEqual({ kind: 'enter', messages: [] })
    expect(fixture.repository.listPlanningResults(fixture.owner, 20)).toHaveLength(countBeforeReplay)
    expect(fixture.repository.listActiveContextDeliveries(String(session.id))).toHaveLength(1)
    await fixture.database.close()
  })

  it('re-recalls once after a verified environment generation change', async () => {
    const fixture = await approvedFixture()
    const environmentExperience = await seedVersion(fixture.database, fixture.owner, {
      ...diagnosticSpec(
        'Repository generation changed before Web startup',
        'Recheck the repository revision and build state before continuing startup',
        'repository_state observed revision next build start web recheck environment generation',
      ),
      scope: { taskFamily: 'application_startup', targetExposure: 'local' },
    })
    const baseline = await fixture.observations.observe(fixture.task)
    const changed = baseline.map(observation => observation.kind === 'repository_state'
      ? changedRepositoryObservation(observation)
      : observation)
    let current = baseline
    let observationCalls = 0
    const observations = { observe: async () => {
      observationCalls += 1
      return current
    } } as never
    const ctx = new Context()
    const session = Session.create('session-environment-rerecall' as never)
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', sessionQueryFor(session))
    const runtime = {
      revision: null,
      digest: `sha256:${'d'.repeat(64)}`,
      values: RuntimeSettingsSchema({
        automaticRecall: true,
        defaultMustUseExperience: true,
      } as RuntimeSettings),
    }
    const planning = new ExperiencePlanningService(
      fixture.repository,
      observations,
      { ask: async () => ({ kind: 'approve', reason: 'approve deterministic environment re-recall test' }) } as never,
      {
        retrievalCandidateLimit: 32,
        observationFreshnessMs: 300_000,
        planApprovalTtlMs: 1_800_000,
        maxPlanningTaskBytes: 32_768,
      },
      'deterministic',
      undefined,
      lexicalRecall(fixture.repository, fixture.owner),
    )
    const admission = new SessionAdmission(
      ctx,
      fixture.repository,
      new ActorResolver(fixture.principalId),
      observations,
      planning,
      executionStub(fixture.repository, fixture.principalId),
      {
        claimLeaseMs: 30_000,
        automaticRecall: true,
        defaultTargetExposure: 'local',
        defaultRiskClass: 'standard',
        defaultMustUseExperience: true,
      },
      undefined,
      () => runtime,
    )
    admission.install()
    const user = createUserMessage({
      content: [{ type: 'text', text: fixture.task.text }],
      source: { kind: 'user' },
    })
    const agent = { id: 'agent-not-session-id', session, options: {}, ctx, status: 'running' } as never
    const first = await runPreStep(ctx, agent, user, 1)
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('expected initial admitted context')
    session.append('step/start', { turn: 1, step: 1 })
    for (const message of first.messages) session.append('user/message', message, { surfaceOp: 'append' })
    const terminal = (): AsyncIterable<never> => (async function* () {})()
    for await (const _chunk of ctx.waterfall(ctx as never, 'llm/stream', {
      provider: 'test', model: 'test', messages: session.deriveMessages(), sessionId: session.id,
    }, terminal)) void _chunk
    const environmentCallId = 'call-update-repository' as never
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{
          type: 'tool-call',
          id: environmentCallId,
          name: 'bash',
          arguments: '{"command":"update repository"}',
        }],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: environmentCallId,
      name: 'bash',
      arguments: '{"command":"update repository"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: environmentCallId,
        content: [{ type: 'text', text: 'repository update completed' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    current = changed
    const before = fixture.repository.listPlanningResults(fixture.owner, 20).length
    const second = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent,
      messages: [],
      turn: 1,
      step: 2,
      signal: new AbortController().signal,
    }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(second.kind).toBe('enter')
    if (second.kind !== 'enter') throw new Error('expected environment-triggered admitted context')
    expect(second.messages).toHaveLength(1)
    const replanned = fixture.repository.listPlanningResults(fixture.owner, 20)
      .find(result => result.plan.usageId !== fixture.approved.planning.plan.usageId)!
    expect(fixture.repository.listPlanningResults(fixture.owner, 20)).toHaveLength(before + 1)
    expect(replanned.admissionAttempt.sessionId).toBe(String(session.id))
    expect(replanned.matchSet.retrievalDecision?.primaryExperienceVersionId)
      .toBe(environmentExperience.experienceVersionId)
    expect(fixture.repository.getUsageExecution(
      String(fixture.approved.planning.plan.usageId), fixture.owner,
    )).toMatchObject({
      verification: {
        providerVersion: 'experience-recall-trigger-v1',
        criteria: [{
          criterionId: 'RECALL-TRIGGER-001',
          result: 'pass',
          reasonCode: 'environment_generation_changed',
          sourceRef: expect.stringMatching(/^experience-usage:.+#environment-generation:sha256:/u),
          boundedValue: {
            evidenceDigest: expect.stringMatching(/^sha256:/u),
            evidenceSummary: expect.stringContaining('repository_state:observed'),
          },
        }],
      },
      settlement: { outcome: 'unknown' },
    })
    expect(fixture.repository.listUnsettledSessionContextDeliveries(String(session.id), fixture.owner))
      .toEqual([expect.objectContaining({ usageId: replanned.plan.usageId })])

    session.append('step/start', { turn: 1, step: 2 })
    session.append('user/message', second.messages[0]!, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      stream: [],
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'continuing after the environment recheck' }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    const countBeforeReplay = fixture.repository.listPlanningResults(fixture.owner, 20).length
    const observationCallsBeforeReplay = observationCalls
    const third = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent,
      messages: [],
      turn: 1,
      step: 3,
      signal: new AbortController().signal,
    }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(third).toEqual({ kind: 'enter', messages: [] })
    expect(fixture.repository.listPlanningResults(fixture.owner, 20)).toHaveLength(countBeforeReplay)
    expect(observationCalls).toBe(observationCallsBeforeReplay)
    expect(fixture.repository.listActiveContextDeliveries(String(session.id))).toHaveLength(1)
    await fixture.database.close()
  })

  it('records no-answerer policy without injecting or auto-approving', async () => {
    const continuing = await approvedFixture()
    const continuingContext = new Context()
    const continuingSession = Session.create('session-no-answerer-continue' as never)
    continuingContext.provide('sessions', {
      get: (id: string) => id === continuingSession.id ? continuingSession : undefined,
    } as never)
    continuingContext.provide('sessionQuery', sessionQueryFor(continuingSession))
    const continuingAdmission = installedAdmission(
      continuingContext,
      continuingSession,
      continuing,
      true,
      false,
    )
    const unrelated = createUserMessage({
      content: [{ type: 'text', text: 'Summarize this unrelated local note' }],
      source: { kind: 'user' },
    })
    expect(await runPreStep(continuingContext, continuingAdmission.agent, unrelated, 1))
      .toEqual({ kind: 'enter', messages: [unrelated] })
    const continued = continuing.repository.listPlanningResults(continuing.owner, 1)[0]
    expect(continued).toMatchObject({
      interactionOutcome: 'no_answerer_continue',
      retryBinding: null,
      admissionAttempt: { state: 'no_answerer_continue' },
    })
    const countBeforeReplay = continuing.repository.listPlanningResults(continuing.owner, 20).length
    expect(await runPreStep(continuingContext, continuingAdmission.agent, unrelated, 2))
      .toEqual({ kind: 'enter', messages: [unrelated] })
    expect(continuing.repository.listPlanningResults(continuing.owner, 20)).toHaveLength(countBeforeReplay)
    const freshTurn = createUserMessage({
      content: [{ type: 'text', text: 'Summarize this unrelated local note' }],
      source: { kind: 'user' },
    })
    expect(await runPreStep(continuingContext, continuingAdmission.agent, freshTurn, 3))
      .toEqual({ kind: 'enter', messages: [freshTurn] })
    expect(continuing.repository.listPlanningResults(continuing.owner, 20)).toHaveLength(countBeforeReplay + 1)
    expect(continuingSession.snapshotEvents()).toEqual([])
    await continuing.database.close()

    const blocking = await approvedFixture()
    const blockingContext = new Context()
    const blockingSession = Session.create('session-no-answerer-block' as never)
    blockingContext.provide('sessions', {
      get: (id: string) => id === blockingSession.id ? blockingSession : undefined,
    } as never)
    blockingContext.provide('sessionQuery', sessionQueryFor(blockingSession))
    const blockingAdmission = installedAdmission(blockingContext, blockingSession, blocking, true, true)
    const required = createUserMessage({
      content: [{ type: 'text', text: 'Build and start the DeepSeek Harness Web application safely' }],
      source: { kind: 'user' },
    })
    expect(await runPreStep(blockingContext, blockingAdmission.agent, required, 1))
      .toEqual({ kind: 'reject' })
    const pending = blocking.repository.listPlanningResults(blocking.owner, 1)[0]
    expect(pending).toMatchObject({
      interactionOutcome: 'interaction_answerer_unavailable',
      retryBinding: null,
      approvalRequest: { status: 'pending' },
      admissionAttempt: { state: 'pending_external_decision' },
    })
    expect(blockingSession.snapshotEvents()).toEqual([])

    const request = pending!.approvalRequest!
    const approved = await blocking.repository.decidePlan({
      commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
      requestId: request.requestId,
      usagePlanId: request.usagePlanId,
      expectedPlanRevision: request.planRevision,
      decision: 'approve',
      reason: 'approve the exact connectionless retry',
      correlationId: 'headless-cross-process-retry',
      causationId: null,
      issuedAt: new Date().toISOString(),
    }, blocking.owner)
    expect(approved.planning.retryBinding).toMatchObject({ state: 'active', sessionId: null })

    const retryContext = new Context()
    const retrySession = Session.create('session-no-answerer-retry' as never)
    retryContext.provide('sessions', {
      get: (id: string) => id === retrySession.id ? retrySession : undefined,
    } as never)
    retryContext.provide('sessionQuery', sessionQueryFor(retrySession))
    const retryAdmission = installedAdmission(retryContext, retrySession, blocking, true, true)
    const retry = await runPreStep(retryContext, retryAdmission.agent, required, 1)
    expect(retry.kind).toBe('enter')
    if (retry.kind !== 'enter') throw new Error('expected the exact connectionless retry to enter')
    expect(retry.messages[0]?.source).toMatchObject({ kind: 'experience', lifecycle: 'active' })
    expect(blocking.repository.getContextUsage(String(approved.planning.plan.usageId), blocking.owner))
      .toMatchObject({ planning: { retryBinding: { state: 'consumed' } } })
    await blocking.database.close()
  })
})

function installedAdmission(
  ctx: Context,
  session: Session,
  fixture: Awaited<ReturnType<typeof approvedFixture>>,
  automaticRecall: boolean,
  defaultMustUseExperience: boolean,
) {
  const admission = new SessionAdmission(
    ctx,
    fixture.repository,
    new ActorResolver(fixture.principalId),
    fixture.observations,
    fixture.planning,
    executionStub(fixture.repository, fixture.principalId),
    {
      claimLeaseMs: 30_000,
      automaticRecall,
      defaultTargetExposure: 'local',
      defaultRiskClass: 'standard',
      defaultMustUseExperience,
    },
  )
  admission.install()
  return {
    admission,
    agent: {
      id: session.id,
      session,
      options: {},
      ctx,
      status: 'running',
    } as never,
  }
}

function sessionQueryFor(session: Session, overrides: Record<string, unknown> = {}) {
  return {
    readSession: async () => ({
      session: session.header,
      inheritedEventCount: session.inheritedEventCount,
      events: [...session.snapshotEvents()],
    }),
    ...overrides,
  } as never
}

function executionStub(repository: ExperienceRepository, principalId: ActorView['principalId']) {
  return {
    assertCanActivate: () => {},
    activate: (planning: Awaited<ReturnType<ExperiencePlanningService['plan']>>['planning'], agent: { session: Session }) =>
      repository.startUsage(String(planning.plan.usageId), String(agent.session.id), {
        actorId: brandedId<'ExperienceActorId'>(`agent:${String(agent.session.id)}`, 'actorId'),
        principalId,
        kind: 'agent',
        authority: 'query_only',
      }),
    flush: async () => {},
    finish: () => {},
  } as never
}

function lexicalRecall(
  repository: ExperienceRepository,
  actor: ActorView,
): RecallPreparationPort {
  return {
    prepare: async (fingerprint: TaskFingerprintView, runtime, recallDecisionKey) => {
      const documents = repository.listPlanningVersions(actor, runtime.values.retrievalCandidateLimit)
        .map(projectExperienceVersion)
      const projection: ExperienceRetrievalProjectionView = {
        projectionKey: 'experience-retrieval-v1',
        schemaVersion: 2,
        manifest: {
          schemaVersion: 'experience-retrieval-projection-manifest-v2',
          projectionVersion: 'experience-retrieval-projector-v2',
          generation: 1,
          state: 'lexical_ready',
          provider: 'disabled',
          providerState: 'disabled',
          modelId: null,
          modelRevision: null,
          artifactSha256: null,
          dimension: null,
          dtype: null,
          pooling: null,
          queryPrefix: null,
          passagePrefix: null,
          tokenizerConfigBundleSha256: null,
          normalization: null,
          maxInputTokens: null,
          truncationPolicy: null,
          operationSettingsRevision: runtime.revision,
          operationSettingsDigest: runtime.digest,
          sourceWatermarkDigest: digest(documents.map(document => document.versionContentDigest)),
          contentDigest: digest(documents),
          documentCount: documents.length,
          vectorCount: 0,
          failureCode: null,
          builtAt: new Date().toISOString(),
        },
        documents,
      }
      return {
        query: projectTaskFingerprint(fingerprint),
        projection,
        vectors: new Map(),
        queryVector: null,
        queryEmbeddingReceiptId: null,
        denseState: 'disabled',
        denseFailureCode: null,
        denseSimilarityThreshold: runtime.values.embeddingSimilarityThreshold,
        denseMargin: runtime.values.embeddingMargin,
        denseApplicabilityProfile: null,
        recallDecisionKey,
      }
    },
  }
}

function changedRepositoryObservation(observation: PlanningObservationView): PlanningObservationView {
  const { contentDigest: _contentDigest, ...rest } = observation
  const changed = {
    ...rest,
    observationId: randomUUID(),
    status: 'observed' as const,
    summary: 'Repository revision changed through the test capability adapter',
    values: {
      packageManifestPresent: true,
      packageManager: 'pnpm@10',
      nodeEngine: '>=22.19.0',
      revision: 'next',
      dirty: true,
    },
    sourceRefs: ['/workspace/package.json'],
    reasonCode: null,
  }
  return { ...changed, contentDigest: digest(changed) }
}

async function completeAndSettleUsage(
  fixture: Awaited<ReturnType<typeof approvedFixture>>,
  usageId: string,
): Promise<void> {
  let progress = fixture.repository.getUsageExecution(usageId, fixture.owner).progress!
  while (progress.state !== 'completed') {
    await fixture.repository.progressUsage({
      commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
      usageId: progress.usageId,
      expectedControllerRevision: progress.controllerRevision,
      action: 'advance',
      checkpointRef: progress.stepRef,
      reason: 'complete settled-context retirement fixture',
      correlationId: 'settled-context-retirement',
      causationId: null,
      issuedAt: new Date().toISOString(),
    }, fixture.owner)
    progress = fixture.repository.getUsageExecution(usageId, fixture.owner).progress!
  }
  const observedAt = new Date().toISOString()
  const criteria: CriterionVerificationView[] = WEB_USAGE_CRITERIA.map(criterionId => {
    const base = {
      criterionId,
      mandatory: true as const,
      result: 'pass' as const,
      observedAt,
      boundedValue: { verified: true },
      sourceRef: `test-authority:${criterionId}`,
      reasonCode: 'test_authority_pass',
    }
    return { ...base, integrityDigest: digest(base) }
  })
  const verification: VerificationRunView = {
    verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
    usageId: progress.usageId,
    controllerRevision: progress.controllerRevision,
    providerVersion: 'dsh-web-guided-v1',
    criteria,
    phase: 'complete',
    createdAt: observedAt,
  }
  await fixture.repository.recordVerification({
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    usageId: progress.usageId,
    expectedControllerRevision: progress.controllerRevision,
    correlationId: 'settled-context-retirement',
    causationId: null,
    issuedAt: observedAt,
  }, verification, fixture.owner)
  await fixture.repository.settleUsage({
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    usageId: progress.usageId,
    expectedControllerRevision: progress.controllerRevision,
    verificationRunId: verification.verificationRunId,
    correlationId: 'settled-context-retirement',
    causationId: null,
    issuedAt: observedAt,
  }, fixture.owner)
}

async function runPreStep(
  ctx: Context,
  agent: never,
  user: ReturnType<typeof createUserMessage>,
  turn: number,
): Promise<PreStepDecision> {
  return ctx.waterfall(ctx as never, 'agent/pre-step', {
    agent,
    messages: [user],
    turn,
    step: 1,
    signal: new AbortController().signal,
  }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [user] }))
}

async function approvedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m4-runtime-'))
  cleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'),
    journalMode: 'wal',
    synchronous: 'normal',
    busyTimeoutMs: 1_000,
    maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const owner: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(`browser:${String(principalId)}`, 'actorId'),
    principalId,
    kind: 'browser_local_owner',
    authority: 'owner',
  }
  await publishReviewedWorkflow(repository, owner)
  const observations = new PlanningObservationRegistry(new Context(), 300_000)
  const planning = new ExperiencePlanningService(
    repository,
    observations,
    { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
    {
      retrievalCandidateLimit: 32,
      observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000,
      maxPlanningTaskBytes: 32_768,
    },
    'deterministic',
  )
  const task: PlanTaskCommandInput['task'] = {
    text: 'Build and start the DeepSeek Harness Web application',
    workspaceRoot: null,
    targetExposure: 'local',
    mustUseExperience: true,
    riskClass: 'standard',
    requiredCapabilities: [],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
  }
  const created = await planning.plan({
    commandId: brandedId<'ExperienceCommandId'>('runtime-plan', 'commandId'),
    correlationId: 'runtime-test',
    causationId: null,
    issuedAt: new Date().toISOString(),
    sessionId: null,
    interaction: 'defer',
    confirmExternalModelProcessing: false,
    task,
  }, owner)
  const request = created.planning.approvalRequest!
  const approved = await repository.decidePlan({
    commandId: brandedId<'ExperienceCommandId'>('runtime-approve', 'commandId'),
    requestId: request.requestId,
    usagePlanId: request.usagePlanId,
    expectedPlanRevision: request.planRevision,
    decision: 'approve',
    reason: 'approved for runtime seam test',
    correlationId: 'runtime-test',
    causationId: created.receipt.receiptId,
    issuedAt: new Date().toISOString(),
  }, owner)
  return { database, repository, principalId, owner, observations, planning, approved, task }
}

function prepareContext(
  planning: Awaited<ReturnType<ExperiencePlanningService['plan']>>['planning'],
  sessionId: string,
) {
  const sections = contextSections(planning)
  const content = renderContext(sections)
  const contextSnapshotId = brandedId<'ExperienceContextSnapshotId'>(randomUUID(), 'contextSnapshotId')
  const contextDeliveryId = brandedId<'ExperienceContextDeliveryId'>(randomUUID(), 'contextDeliveryId')
  const message = createExperienceContextMessage(content, {
    usageId: planning.plan.usageId,
    contextSnapshotId,
    contentDigest: digest(content),
    sections,
  }, contextDeliveryId)
  const createdAt = new Date().toISOString()
  const snapshot = materializeContextSnapshot(
    planning,
    sections,
    contextSnapshotId,
    String(message.id),
    createdAt,
  )
  const delivery: ContextDeliveryView = {
    contextDeliveryId,
    contextSnapshotId,
    usageId: planning.plan.usageId,
    sessionId,
    messageId: String(message.id),
    contentDigest: snapshot.contentDigest,
    deliveryStatus: 'prepared',
    sessionEventSeq: null,
    requestBoundaryRef: null,
    appendedAt: null,
    deliveredAt: null,
    createdAt,
  }
  return { snapshot, delivery, message }
}
