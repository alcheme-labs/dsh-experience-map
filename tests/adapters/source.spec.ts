import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoricalSource } from '../../src/adapters/historical-source.js'
import { DshSessionSource } from '../../src/adapters/session-source.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M2 bounded source adapters', () => {
  it('binds one complete terminal Session to its canonical event-cut digest and exact event refs', async () => {
    let disposed = false
    const source = new DshSessionSource(
      query(events('completed'), { onDispose: () => { disposed = true } }),
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    const inspected = await source.inspect({ sessionId: 'session-test' })
    expect(inspected).toMatchObject({
      termination: { state: 'terminated', reason: 'completed' },
      recordCount: 3,
      omittedRecordCount: 0,
    })
    expect(inspected.episodeRef).toMatchObject({
      sessionOrRunId: 'session-test',
      eventStart: 0,
      eventEnd: 2,
    })
    expect(inspected.episodeRef.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(disposed).toBe(true)
    expect(inspected.sourceRefs.map(ref => ref.locator)).toEqual([
      'dsh-session:session-test#0', 'dsh-session:session-test#1', 'dsh-session:session-test#2',
    ])
    await expect(source.inspect({
      sessionId: 'session-test', eventStart: 0, eventEnd: 2, contentDigest: 'sha256:changed',
    })).rejects.toMatchObject({ code: 'source_unresolvable' })
    await expect(source.inspect({ sessionId: 'session-test', eventStart: 1, eventEnd: 2 }))
      .rejects.toMatchObject({ code: 'source_unresolvable' })
  })

  it('keeps the terminal Episode identity when Harness appends a resume seed boundary', async () => {
    const terminalEvents = events('completed')
    const original = new DshSessionSource(
      query(terminalEvents, { source: 'live' }),
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    const initial = await original.inspect({ sessionId: 'session-test' })
    const boundary = {
      type: 'session/end-seed', seq: 3, time: 4, data: {},
    } as unknown as SessionEvent
    const source = new DshSessionSource(
      query([...terminalEvents, boundary], { source: 'prepared' }),
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    const inspected = await source.inspect({
      sessionId: 'session-test', eventStart: 0, eventEnd: 2,
      contentDigest: initial.episodeRef.contentDigest,
    })
    expect(inspected.episodeRef).toMatchObject({
      eventEnd: 2,
      contentDigest: initial.episodeRef.contentDigest,
    })
    expect(inspected.recordCount).toBe(3)
  })

  it('preserves abnormal terminal reasons instead of upgrading or rejecting them as task outcomes', async () => {
    const interrupted = new DshSessionSource(
      query(events('aborted')),
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    await expect(interrupted.inspect({ sessionId: 'session-test' }))
      .resolves.toMatchObject({ termination: { state: 'terminated', reason: 'aborted' } })
  })

  it('rejects secret-shaped source records before proposal', async () => {
    const unsafeEvents = events('completed').map((event, index) => index === 1
      ? { ...event, data: { authorization: 'Authorization: Bearer private-token' } } as unknown as SessionEvent
      : event)
    const unsafe = new DshSessionSource(
      query(unsafeEvents),
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    await expect(unsafe.inspect({ sessionId: 'session-test' }))
      .rejects.toMatchObject({ code: 'sensitive_content_unauthorized' })
  })

  it('normalizes an unknown Session as a source-resolution failure', async () => {
    const source = new DshSessionSource(
      { observeSession: async () => { throw new Error('backend not found') } },
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    await expect(source.inspect({ sessionId: 'missing-session' }))
      .rejects.toMatchObject({ code: 'source_unresolvable' })
  })

  it('does not treat a narrative cookie label as a cookie credential', async () => {
    const narrative = events('completed').map((event, index) => index === 1
      ? { ...event, data: { output: 'The current protocol requires a cookie: authenticated requests only.' } } as unknown as SessionEvent
      : event)
    const source = new DshSessionSource(
      query(narrative),
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    await expect(source.inspect({ sessionId: 'session-test' }))
      .resolves.toMatchObject({
        termination: { state: 'terminated', reason: 'completed' },
        recordCount: 3,
      })

    const credential = events('completed').map((event, index) => index === 1
      ? { ...event, data: { output: 'Cookie: session_id=private-cookie-value' } } as unknown as SessionEvent
      : event)
    const unsafe = new DshSessionSource(
      query(credential),
      { maxRecords: 16, maxRecordBytes: 8_192, maxTotalBytes: 32_768 },
    )
    await expect(unsafe.inspect({ sessionId: 'session-test' }))
      .rejects.toMatchObject({ code: 'sensitive_content_unauthorized' })
  })

  it('keeps every bounded multibyte excerpt within the configured UTF-8 byte limit', async () => {
    const unicode = events('completed').map((event, index) => index === 1
      ? { ...event, data: { output: '诊断结果已经验证完成并可以复用' } } as unknown as SessionEvent
      : event)
    const source = new DshSessionSource(
      query(unicode),
      { maxRecords: 16, maxRecordBytes: 24, maxTotalBytes: 32_768 },
    )
    const inspected = await source.inspect({ sessionId: 'session-test' })
    expect(inspected.records.every(record => Buffer.byteLength(record.excerpt) <= 24)).toBe(true)
    expect(inspected.records.some(record => record.excerpt.endsWith('…'))).toBe(true)
    expect(inspected.records.every(record => !record.excerpt.includes('\uFFFD'))).toBe(true)
  })

  it('re-reads only the exact M0-selected historical lines and fails when either changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-history-'))
    cleanup.push(directory)
    const path = join(directory, 'rollout.jsonl')
    const first = '{"timestamp":"2026-08-14T01:00:00.000Z","message":"diagnosis"}\n'
    const ignored = '{"timestamp":"2026-08-14T01:01:00.000Z","message":"ignored"}\n'
    const third = '{"timestamp":"2026-08-14T01:02:00.000Z","message":"verified"}\n'
    await writeFile(path, `${first}${ignored}${third}`, 'utf8')
    const source = new HistoricalSource({
      path,
      runId: 'run-test',
      aggregateDigest: `sha256:${sha256(`${first}${third}`)}`,
      records: [
        { line: 1, digest: `sha256:${sha256(first)}`, bytes: Buffer.byteLength(first) },
        { line: 3, digest: `sha256:${sha256(third)}`, bytes: Buffer.byteLength(third) },
      ],
    }, { maxRecords: 8, maxRecordBytes: 8_192, maxTotalBytes: 32_768 })
    const records = await source.inspect()
    expect(records.map(record => record.sourceRef.locator)).toEqual([
      'codex-rollout:run-test#L1', 'codex-rollout:run-test#L3',
    ])
    await writeFile(path, `${first}${ignored}${third.replace('verified', 'changed')}`, 'utf8')
    await expect(source.inspect()).rejects.toMatchObject({ code: 'source_unresolvable' })
    const missing = new HistoricalSource({
      path: join(directory, 'missing.jsonl'),
      runId: 'run-test',
      aggregateDigest: `sha256:${sha256(first)}`,
      records: [{ line: 1, digest: `sha256:${sha256(first)}`, bytes: Buffer.byteLength(first) }],
    }, { maxRecords: 8, maxRecordBytes: 8_192, maxTotalBytes: 32_768 })
    await expect(missing.inspect()).rejects.toMatchObject({ code: 'source_unresolvable' })
  })
})

function events(reason: 'completed' | 'aborted'): SessionEvent[] {
  return [
    {
      type: 'user/message', seq: 0, time: 1,
      data: { content: [{ type: 'text', text: 'start web' }], source: { kind: 'user' } },
    },
    { type: 'tool/result', seq: 1, time: 2, data: { toolCallId: 'call-1', output: 'verified result' } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: reason } } },
  ] as SessionEvent[]
}

function query(
  sessionEvents: readonly SessionEvent[],
  options: {
    readonly source?: SessionObservation['source']
    readonly onDispose?: () => void
  } = {},
): Pick<SessionQueryEngine, 'observeSession'> {
  return {
    observeSession: async (_sessionId, exec) => {
      exec?.signal?.throwIfAborted()
      let disposed = false
      const observation = (): SessionObservation => ({
        source: options.source ?? 'prepared',
        header: { id: 'session-test' } as SessionObservation['header'],
        events: sessionEvents,
        inheritedEventCount: SessionLogOffset(0),
        cursor: sessionEvents.at(-1)?.seq ?? -1,
        retain: () => {
          if (disposed) throw new Error('observation is disposed')
          return observation()
        },
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          options.onDispose?.()
        },
      })
      return observation()
    },
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
