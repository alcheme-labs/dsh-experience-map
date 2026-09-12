import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WebUsageVerifier, WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { digest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import type { ExecutionCorrelationView } from '../src/types.js'
import type { ExperienceExecutionService } from '../src/application/execution-service.js'
import { createM5Fixture, envelope } from './fixtures/m5-usage.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

describe('M5 Web authority verification', () => {
  it('reads the exact launcher, owned listener, auth contract, scope, and isolated cleanup', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(async () => {
      await fixture.database.close()
      await rm(fixture.directory, { recursive: true, force: true })
    })
    const { server, target, port } = await authServer()
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const command = 'pnpm dsh web --no-open --host 127.0.0.1 --port 0'
    const launcherArguments = { command, run_in_background: true }
    const callEvent = {
      seq: 11, type: 'tool/call', time: Date.now(),
      data: { callId: 'call-web', name: 'bash', arguments: JSON.stringify(launcherArguments) },
    } as never
    const correlation: ExecutionCorrelationView = {
      executionCorrelationId: brandedId<'ExperienceExecutionCorrelationId'>(randomUUID(), 'executionCorrelationId'),
      usageId: fixture.progress.usageId,
      sessionId: fixture.progress.sessionId,
      callId: 'call-web', rootCallId: 'call-web', toolName: 'bash',
      argumentsDigest: digest(JSON.stringify(launcherArguments)), callEventSeq: 11, resultEventSeq: null,
      resultState: 'pending', externalEffectState: 'possible', effectRef: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    await fixture.repository.recordExecutionCall(correlation)
    await fixture.repository.recordExecutionResult({
      usageId: String(fixture.progress.usageId), callId: correlation.callId, resultEventSeq: 12,
      resultState: 'success', externalEffectState: 'possible',
      effectRef: { kind: 'background_job', jobId: 'job-web', labelDigest: digest(command),
        listenerPid: null, host: null, port: null },
    })
    let running = true
    const effectStates: Array<'none' | 'confirmed'> = []
    const agent = { id: fixture.progress.sessionId, session: { id: fixture.progress.sessionId } }
    const execution = {
      getActive: () => ({
        usageId: String(fixture.progress.usageId), sessionId: fixture.progress.sessionId,
        agent, ownedJobIds: new Set(['job-web']), targetUrlsByJobId: new Map([['job-web', target]]),
        startedAt: new Date().toISOString(),
      }),
      setEffectState: (_usageId: string, state: 'none' | 'confirmed') => { effectStates.push(state) },
    } as unknown as ExperienceExecutionService
    let listenerReadbackFails = false
    const ctx = fakeContext(() => running, port, () => listenerReadbackFails, [callEvent])
    const verifier = new WebUsageVerifier(ctx, fixture.repository, execution, 5_000)
    const firstInput = {
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: fixture.progress.controllerRevision,
    }
    const firstReceipt = await verifier.verify(firstInput,
      fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner), fixture.owner)
    expect(firstReceipt.action).toBe('usage.verify')
    expect(effectStates).toEqual(['confirmed'])
    const first = fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).verification!
    expect(first.criteria.map(item => [item.criterionId, item.result])).toEqual([
      ['WEB-LAUNCH-001', 'pass'], ['WEB-READY-002', 'pass'], ['WEB-AUTH-003', 'pass'],
      ['WEB-SCOPE-004', 'pass'], ['WEB-CLEAN-005', 'not_evaluated'],
    ])
    expect(JSON.stringify(first)).not.toContain('runtime-secret')
    expect(JSON.stringify(first)).not.toContain('dsh_session=fixture-cookie')

    running = false
    const second = await verifier.verify({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: fixture.progress.controllerRevision,
    }, fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner), fixture.owner)
    expect(second.action).toBe('usage.verify')
    const completed = fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).verification!
    expect(completed.phase).toBe('complete')
    expect(completed.criteria.map(item => item.criterionId)).toEqual(WEB_USAGE_CRITERIA)
    expect(completed.criteria.every(item => item.result === 'pass')).toBe(true)
    expect(completed.criteria.at(-1)?.boundedValue).toMatchObject({ unrelatedListenersPreserved: true })
    expect(effectStates).toEqual(['confirmed', 'none'])

    listenerReadbackFails = true
    await verifier.verify({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: fixture.progress.controllerRevision,
    }, fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner), fixture.owner)
    const unreadable = fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).verification!
    expect(unreadable.phase).toBe('unknown')
    expect(unreadable.criteria.at(-1)).toMatchObject({
      criterionId: 'WEB-CLEAN-005', result: 'unknown', reasonCode: 'cleanup_socket_unknown',
    })

    listenerReadbackFails = false
    await fixture.repository.progressUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: fixture.progress.controllerRevision,
      action: 'advance', checkpointRef: fixture.progress.stepRef, reason: 'advance to a new controller revision',
    }, fixture.owner)
    const advanced = fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner)
    await verifier.verify({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: advanced.progress!.controllerRevision,
    }, advanced, fixture.owner)
    const currentRevision = fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).verification!
    expect(currentRevision.controllerRevision).toBe(advanced.progress!.controllerRevision)
    expect(currentRevision.criteria.find(item => item.criterionId === 'WEB-READY-002')?.result).toBe('fail')
    expect(currentRevision.criteria.find(item => item.criterionId === 'WEB-SCOPE-004')?.result).toBe('fail')
  })
})

function fakeContext(
  isRunning: () => boolean,
  port: number,
  listenerReadbackFails: () => boolean,
  sessionEvents: readonly unknown[],
): Context {
  const job = () => ({
    id: 'job-web', kind: 'subprocess', label: 'isolated web',
    status: isRunning() ? 'running' : 'killed', startedAt: Date.now(), reported: false,
  })
  const shell = {
    resolve: (value: unknown) => value,
    run: async (spec: { command: string }) => {
      if (spec.command.includes(`-iTCP:${String(port)}`)) {
        if (listenerReadbackFails()) return output(127, '', 'lsof unavailable')
        return isRunning()
          ? output(0, `p${String(process.pid)}\ncnode\nn127.0.0.1:${String(port)}\n`)
          : output(1, '')
      }
      return output(0, isRunning()
        ? `p900001\ncunrelated\np${String(process.pid)}\ncnode\n`
        : 'p900001\ncunrelated\n')
    },
  }
  return {
    sessionQuery: {
      readSession: async () => ({ events: sessionEvents }),
    },
    get(name: string) {
      if (name === 'jobs') return { get: job }
      if (name === 'shell') return shell
      return undefined
    },
  } as unknown as Context
}

function output(exitCode: number, text: string, error = '') {
  return { exitCode, stdout: { text, truncated: false }, stderr: { text: error, truncated: false } }
}

async function authServer(): Promise<{ server: Server; target: URL; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/?token=runtime-secret') {
      response.writeHead(303, { location: '/', 'set-cookie': 'dsh_session=fixture-cookie; HttpOnly' }).end()
      return
    }
    if (request.url === '/' && request.headers.cookie === 'dsh_session=fixture-cookie') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<script>window.__DSH_BOOT__={}</script>')
      return
    }
    if (request.url === '/api/session/list' && request.method === 'POST'
      && request.headers.cookie === 'dsh_session=fixture-cookie') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { ok: true } }))
      return
    }
    response.writeHead(401).end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP port')
  return { server, port: address.port, target: new URL(`http://127.0.0.1:${String(address.port)}/?token=runtime-secret`) }
}
