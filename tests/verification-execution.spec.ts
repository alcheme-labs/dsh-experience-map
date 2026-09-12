import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'
import { ExperienceExecutionService } from '../src/application/execution-service.js'
import { createM5Fixture } from './fixtures/m5-usage.js'
import { typedWorkflowDraft } from './fixtures/workflow.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

describe('M5 Session execution correlation', () => {
  it('validates only complete final assistant outputs against the selected Preference policy', async () => {
    const base = typedWorkflowDraft('preference_policy')
    const preference = {
      ...base,
      title: 'Build and start Web response preference',
      intent: 'Prefer a concise verified result when reporting the Web build and startup.',
      components: base.components.map(component => {
        if (component.role === 'task_or_output_scope') return { ...component, content: 'final Web startup response output' }
        if (component.role === 'positive_example') return { ...component, content: 'Web startup verified' }
        return component
      }),
    }
    const fixture = await createM5Fixture({ additionalDrafts: [preference] })
    cleanup.push(async () => {
      await fixture.database.close()
      await rm(fixture.directory, { recursive: true, force: true })
    })
    expect(fixture.planning.plan.preferenceEnforcements).toHaveLength(1)
    const harness = contextHarness()
    const service = new ExperienceExecutionService(harness.ctx, fixture.repository)
    service.install()
    const agent = {
      id: 'agent-preference-validation',
      session: { id: fixture.progress.sessionId, events: [] },
      ctx: { tools: { guard: () => () => {} } },
    }
    await service.activate(fixture.planning, agent as never, fixture.runtimeActor)

    harness.emit('session/event', agent.session, {
      seq: 60, type: 'assistant/message', time: Date.now(),
      data: { interrupted: true, message: { id: 'partial-output', content: [{ type: 'text', text: 'Web startup verified' }] } },
    })
    harness.emit('session/event', agent.session, {
      seq: 61, type: 'assistant/message', time: Date.now(),
      data: { interrupted: false, message: { id: 'tool-output', content: [
        { type: 'text', text: 'Web startup verified' },
        { type: 'tool-call', id: 'call-output', name: 'bash', arguments: '{}' },
      ] } },
    })
    harness.emit('session/event', agent.session, {
      seq: 62, type: 'assistant/message', time: Date.now(),
      data: { interrupted: false, message: { id: 'final-output', content: [{ type: 'text', text: 'Web startup verified.' }] } },
    })
    await service.flush(String(fixture.progress.usageId))

    const execution = fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner)
    expect(execution.preferenceValidations).toHaveLength(1)
    expect(execution.preferenceValidations[0]).toMatchObject({
      sessionId: fixture.progress.sessionId,
      messageId: 'final-output',
      finalOutput: true,
      results: [{ result: 'passed', reasonCode: 'preference_positive_example_observed' }],
    })
    service.finish(String(fixture.progress.usageId))
    harness.dispose()
  })

  it('correlates exact tool events, captures only opaque effect refs, and disposes its guard', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(async () => {
      await fixture.database.close()
      await rm(fixture.directory, { recursive: true, force: true })
    })
    const harness = contextHarness()
    const service = new ExperienceExecutionService(harness.ctx, fixture.repository)
    service.install()
    let guard: ToolGuard | null = null
    let guardDisposals = 0
    const agent = {
      id: 'agent-m5-distinct-from-session',
      session: { id: fixture.progress.sessionId, events: [] },
      ctx: { tools: { guard: (value: ToolGuard) => {
        guard = value
        return () => { guardDisposals += 1 }
      } } },
    }
    await service.activate(fixture.planning, agent as never, fixture.runtimeActor)
    const runtimeToken = 'A'.repeat(43)
    const command = 'pnpm dsh web --no-open --host 127.0.0.1 --port 0'
    const launcherArguments = { command, run_in_background: true }
    harness.emit('session/event', agent.session, {
      seq: 41, type: 'tool/call', time: Date.now(),
      data: { callId: 'call-m5', name: 'bash', arguments: JSON.stringify(launcherArguments) },
    })
    harness.emit('tools/result', {
      name: 'bash', callId: 'call-m5', arguments: launcherArguments, agent,
    }, {
      isError: false,
      value: { kind: 'background', jobId: 'job-m5' },
    })
    harness.emit('session/event', agent.session, {
      seq: 42, type: 'tool/result', time: Date.now(),
      data: { message: { source: { callId: 'call-m5' }, content: [{ isError: false }] } },
    })
    harness.emit('session/event', agent.session, {
      seq: 43, type: 'tool/call', time: Date.now(),
      data: { callId: 'call-output', name: 'job_output', arguments: JSON.stringify({ job_id: 'job-m5' }) },
    })
    harness.emit('tools/result', {
      name: 'job_output', callId: 'call-output', arguments: { job_id: 'job-m5' }, agent,
    }, { isError: false, value: `http://127.0.0.1:49152/?token=${runtimeToken}\u001b[0m` })
    harness.emit('session/event', agent.session, {
      seq: 44, type: 'tool/result', time: Date.now(),
      data: { message: { source: { callId: 'call-output' }, content: [{ isError: false }] } },
    })
    harness.emit('session/event', agent.session, {
      seq: 45, type: 'tool/call', time: Date.now(),
      data: { callId: 'call-other', name: 'bash', arguments: JSON.stringify({
        command: 'printf unrelated', run_in_background: true,
      }) },
    })
    harness.emit('tools/result', {
      name: 'bash', callId: 'call-other', arguments: { command: 'printf unrelated', run_in_background: true }, agent,
    }, { isError: false, value: { kind: 'background', jobId: 'job-other' } })
    harness.emit('session/event', agent.session, {
      seq: 46, type: 'tool/result', time: Date.now(),
      data: { message: { source: { callId: 'call-other' }, content: [{ isError: false }] } },
    })
    harness.emit('session/event', agent.session, {
      seq: 47, type: 'tool/call', time: Date.now(),
      data: { callId: 'call-other-output', name: 'job_output', arguments: JSON.stringify({ job_id: 'job-other' }) },
    })
    harness.emit('tools/result', {
      name: 'job_output', callId: 'call-other-output', arguments: { job_id: 'job-other' }, agent,
    }, { isError: false, value: `http://127.0.0.1:49153/?token=${'B'.repeat(43)}` })
    harness.emit('session/event', agent.session, {
      seq: 48, type: 'tool/result', time: Date.now(),
      data: { message: { source: { callId: 'call-other-output' }, content: [{ isError: false }] } },
    })
    await service.flush(String(fixture.progress.usageId))
    const correlation = fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner)
      .correlations.find(item => item.callId === 'call-m5')!
    expect(correlation).toMatchObject({
      callId: 'call-m5', callEventSeq: 41, resultEventSeq: 42, resultState: 'success',
      externalEffectState: 'possible', effectRef: { kind: 'background_job', jobId: 'job-m5',
        listenerPid: null, host: null, port: null },
    })
    expect(JSON.stringify(correlation)).not.toContain(runtimeToken)
    expect(service.getActive(String(fixture.progress.usageId))?.targetUrlsByJobId
      .get('job-m5')?.searchParams.get('token'))
      .toBe(runtimeToken)
    expect(service.getActive(String(fixture.progress.usageId))?.ownedJobIds.has('job-other')).toBe(false)
    expect(service.getActive(String(fixture.progress.usageId))?.targetUrlsByJobId.has('job-other')).toBe(false)
    expect(guard).not.toBeNull()
    expect(guard!({ name: 'bash', arguments: launcherArguments } as never)).toContain('unresolved prior Web effect')
    expect(guard!({ name: 'job_kill', arguments: { job_id: 'job-other' } } as never)).toContain('exact owned')
    harness.emit('session/event', agent.session, {
      seq: 49, type: 'turn/end', time: Date.now(),
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(guardDisposals).toBe(1)
    expect(service.getActive(String(fixture.progress.usageId))).not.toBeNull()
    service.finish(String(fixture.progress.usageId))
    expect(guardDisposals).toBe(1)
    harness.dispose()
    expect(guardDisposals).toBe(1)
  })

  it('keeps an invoked launcher failure unknown and binds readiness URLs to their exact owned job', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(async () => {
      await fixture.database.close()
      await rm(fixture.directory, { recursive: true, force: true })
    })
    const harness = contextHarness()
    const service = new ExperienceExecutionService(harness.ctx, fixture.repository)
    service.install()
    let guard: ToolGuard | null = null
    const agent = {
      id: 'agent-m5-failure',
      session: { id: fixture.progress.sessionId, events: [] },
      ctx: { tools: { guard: (value: ToolGuard) => { guard = value; return () => {} } } },
    }
    await service.activate(fixture.planning, agent as never, fixture.runtimeActor)
    const command = 'pnpm dsh web --no-open --host 127.0.0.1 --port 0'
    const launcherArguments = { command, run_in_background: true }
    harness.emit('session/event', agent.session, {
      seq: 51, type: 'tool/call', time: Date.now(),
      data: { callId: 'call-failed-launch', name: 'bash', arguments: JSON.stringify(launcherArguments) },
    })
    harness.emit('tools/result', {
      name: 'bash', callId: 'call-failed-launch', arguments: launcherArguments, agent,
    }, { isError: true, error: { message: 'provider outcome lost' } })
    harness.emit('session/event', agent.session, {
      seq: 52, type: 'tool/result', time: Date.now(),
      data: { message: { source: { callId: 'call-failed-launch' }, content: [{ isError: true }] } },
    })
    await service.flush(String(fixture.progress.usageId))
    expect(fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner)
      .correlations.find(item => item.callId === 'call-failed-launch')).toMatchObject({
      resultState: 'failure', externalEffectState: 'unknown', effectRef: null,
    })
    expect(guard!( { name: 'bash', arguments: launcherArguments } as never))
      .toContain('unresolved prior Web effect')
    service.finish(String(fixture.progress.usageId))
    harness.dispose()
  })

  it('releases the Session-scoped guard when an independently identified Agent is disposed', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(async () => {
      await fixture.database.close()
      await rm(fixture.directory, { recursive: true, force: true })
    })
    const harness = contextHarness()
    const service = new ExperienceExecutionService(harness.ctx, fixture.repository)
    service.install()
    let guardDisposals = 0
    const agent = {
      id: 'agent-id-that-is-not-the-session-id',
      session: { id: fixture.progress.sessionId, events: [] },
      ctx: { tools: { guard: () => () => { guardDisposals += 1 } } },
    }

    await service.activate(fixture.planning, agent as never, fixture.runtimeActor)
    harness.emit('agent/disposed', { agent })

    expect(guardDisposals).toBe(1)
    await expect(service.activate(fixture.planning, agent as never, fixture.runtimeActor))
      .rejects.toThrow('guided Experience execution ended')
    harness.dispose()
    expect(guardDisposals).toBe(1)
  })
})

function contextHarness() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let unload = () => {}
  const ctx = {
    on(name: string, listener: (...args: unknown[]) => void) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    effect(setup: () => () => void) { unload = setup() },
    logger() { return { warn() {} } },
  } as unknown as Context
  return {
    ctx,
    emit(name: string, ...args: unknown[]) { listeners.get(name)?.(...args) },
    dispose() { unload() },
  }
}
