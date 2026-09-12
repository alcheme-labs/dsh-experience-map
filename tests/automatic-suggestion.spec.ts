import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEventRecord,
  SessionLogSnapshot,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshSessionSource } from '../src/adapters/session-source.js'
import {
  DEFAULT_EXPERIENCE_PROJECTION_POLICY,
  ExperienceProjectionWorker,
} from '../src/application/experience-projection-worker.js'
import { detectSuggestionSeed } from '../src/domain/automatic-suggestion.js'
import { materializeSuggestionGroups, suggestionDecisionDigests } from '../src/domain/suggestion-materializer.js'
import {
  ExperienceProjectionStore,
  suggestionProjectionPath,
} from '../src/persistence/projection-store.js'
import type {
  ExperienceSuggestionSeedView,
  ExperienceSuggestionGroupView,
  SessionSuggestionScanView,
  SuggestionSaveDomainReceipt,
} from '../src/types.js'
import { RuntimeSettingsSchema, type RuntimeSettings } from '../src/runtime-settings-schema.js'

const cleanup: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('E1 recent Session segmenter and deterministic detector', () => {
  it('uses public corpus APIs, retains only recent-N completed turns, and produces a stable P/D seed', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const recentA = session('session-a', now.getTime() - 2_000, diagnosticEvents(now.getTime() - 2_000))
    const recentB = session('session-b', now.getTime() - 1_000, procedureEvents(now.getTime() - 1_000))
    const expired = session('session-old', now.getTime() - 20 * 24 * 60 * 60_000,
      procedureEvents(now.getTime() - 20 * 24 * 60 * 60_000))
    const calls = { listSessions: 0, listEvents: 0, readSession: 0, readEvent: 0 }
    const source = new DshSessionSource(query([recentA, recentB, expired], calls), sourceLimits())

    const batch = await source.scanRecentCompletedTurns(1, 14 * 24 * 60 * 60_000, now)

    expect(batch.sourceWatermarkDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(batch.sessions.map(item => item.sessionId)).toEqual(['session-b'])
    expect(batch.sessions[0]?.slices).toHaveLength(1)
    expect(calls).toEqual({ listSessions: 1, listEvents: 3, readSession: 1, readEvent: 1 })
    const diagnosticBatch = await source.scanRecentCompletedTurns(2, 14 * 24 * 60 * 60_000, now)
    const slice = diagnosticBatch.sessions.find(item => item.sessionId === 'session-a')!.slices[0]!
    const first = detectSuggestionSeed(slice, '/workspace/a', 14 * 24 * 60 * 60_000, evidenceLimits())
    const second = detectSuggestionSeed(slice, '/workspace/a', 14 * 24 * 60 * 60_000, evidenceLimits())
    expect(first).toMatchObject({
      sessionId: 'session-a',
      suggestedKinds: ['procedure', 'diagnostic'],
      triggerKind: 'high_cost_resolution',
      stableKernel: {
        taskGoal: '修复 Web 启动失败并验证健康检查。',
        toolSequence: ['read', 'bash'],
        failedToolSequence: ['bash'],
        recoveryToolSequence: ['read', 'bash'],
        failureCodes: ['ENOENT'],
        verifierTools: ['bash'],
      },
    })
    expect(first?.occurrenceId).toBe(second?.occurrenceId)
    expect(first?.evidenceSignals.some(item => item.evidenceClass === 'model_claim')).toBe(true)
    expect(first?.evidenceSignals.some(item => item.role === 'symptom')).toBe(true)

    const renderedShellFailure = diagnosticEvents(now.getTime()).map(event => event.seq === 3
      ? toolResult(3, now.getTime() + 3, 1, 'build-1', 'dist missing\n[exit code: 2]')
      : event)
    const shellSource = new DshSessionSource(query([
      session('session-shell-exit', now.getTime(), renderedShellFailure),
    ]), sourceLimits())
    const shellBatch = await shellSource.scanRecentCompletedTurns(1, 60_000, now)
    expect(detectSuggestionSeed(
      shellBatch.sessions[0]!.slices[0]!, '/workspace/shell', 60_000, evidenceLimits(),
    )).toMatchObject({
      suggestedKinds: ['procedure', 'diagnostic'],
      stableKernel: { failureCodes: ['exit_code_2'] },
    })
  })

  it('does not turn completion, an unfinished turn, or an unverified tool result into a seed', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const noVerifier = session('session-no-verifier', now.getTime(), [
      turnStart(0, now.getTime(), 1),
      user(1, now.getTime() + 1, 1, '看看代码。'),
      toolCall(2, now.getTime() + 2, 1, 'read-1', 'read', '{}'),
      toolResult(3, now.getTime() + 3, 1, 'read-1', 'source body'),
      turnEnd(4, now.getTime() + 4, 1),
      turnStart(5, now.getTime() + 5, 2),
      user(6, now.getTime() + 6, 2, '尚未完成'),
    ])
    const source = new DshSessionSource(query([noVerifier]), sourceLimits())
    const batch = await source.scanRecentCompletedTurns(8, 14 * 24 * 60 * 60_000, now)
    expect(batch.sessions[0]?.slices).toHaveLength(1)
    expect(detectSuggestionSeed(batch.sessions[0]!.slices[0]!, '/workspace/no', 60_000, evidenceLimits()))
      .toBeNull()
  })

  it('does not turn an unowned process termination into a reusable procedure', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const unsafe = session('session-unowned-kill', now.getTime(), [
      turnStart(0, now.getTime(), 1),
      user(1, now.getTime() + 1, 1, '端口占用后直接终止进程并检查端口。'),
      toolCall(2, now.getTime() + 2, 1, 'kill-1', 'bash', '{"command":"kill -9 1234"}'),
      toolResult(3, now.getTime() + 3, 1, 'kill-1', 'process terminated'),
      toolCall(4, now.getTime() + 4, 1, 'check-1', 'bash', '{"command":"curl http://127.0.0.1:3080/health"}'),
      toolResult(5, now.getTime() + 5, 1, 'check-1', 'HTTP 200'),
      turnEnd(6, now.getTime() + 6, 1),
    ])
    const source = new DshSessionSource(query([unsafe]), sourceLimits())
    const batch = await source.scanRecentCompletedTurns(1, 60_000, now)

    expect(detectSuggestionSeed(
      batch.sessions[0]!.slices[0]!, '/workspace/unsafe', 60_000, evidenceLimits(),
    )).toBeNull()
  })

  it('does not mistake a search for the word kill for a process termination', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const search = session('session-search-kill', now.getTime(), [
      turnStart(0, now.getTime(), 1),
      user(1, now.getTime() + 1, 1, '只读查找代码中 kill 的使用位置。'),
      toolCall(2, now.getTime() + 2, 1, 'search-1', 'bash', '{"command":"rg -n kill src && test -f package.json"}'),
      toolResult(3, now.getTime() + 3, 1, 'search-1', 'src/process.ts:12: kill(pid)'),
      turnEnd(4, now.getTime() + 4, 1),
    ])
    const source = new DshSessionSource(query([search]), sourceLimits())
    const batch = await source.scanRecentCompletedTurns(1, 60_000, now)

    expect(detectSuggestionSeed(
      batch.sessions[0]!.slices[0]!, '/workspace/search', 60_000, evidenceLimits(),
    )).toMatchObject({ suggestedKinds: ['procedure'] })
  })

  it('detects explicit Preference and Strategy signals without pretending turn completion is success', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const preference = session('session-preference', now.getTime(), [
      turnStart(0, now.getTime(), 1),
      user(1, now.getTime() + 1, 1, '以后在中文技术回答中，必须优先使用中文，除非我明确要求英文。'),
      turnEnd(2, now.getTime() + 2, 1),
    ])
    const strategy = session('session-strategy', now.getTime() + 10, [
      turnStart(0, now.getTime() + 10, 1),
      user(1, now.getTime() + 11, 1,
        '比较方案 A 和方案 B；硬约束是离线可用，选择标准是准确率；权衡是速度与质量；停止条件是准确率达标；升级条件是两者并列时请用户决定；成功指标是 harmful match 为零。'),
      turnEnd(2, now.getTime() + 12, 1),
    ])
    const source = new DshSessionSource(query([preference, strategy]), sourceLimits())
    const batch = await source.scanRecentCompletedTurns(8, 60_000, now)

    const preferenceSeed = detectSuggestionSeed(
      batch.sessions.find(item => item.sessionId === 'session-preference')!.slices[0]!,
      '/workspace/preference', 60_000, evidenceLimits(),
    )
    const strategySeed = detectSuggestionSeed(
      batch.sessions.find(item => item.sessionId === 'session-strategy')!.slices[0]!,
      '/workspace/strategy', 60_000, evidenceLimits(),
    )
    expect(preferenceSeed).toMatchObject({
      suggestedKinds: ['preference_policy'], triggerKind: 'explicit_user_directive',
    })
    expect(strategySeed).toMatchObject({
      suggestedKinds: ['strategy'], triggerKind: 'strategy_candidate',
    })
  })

  it('requires a typed observed tool envelope for Fact and an observed outcome for Causal', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const factEnvelope = JSON.stringify({ experienceFact: {
      subject: 'workspace runtime', predicate: 'node version', value: 'v22.23.1',
      observedAt: '2026-09-10T08:00:00.000Z', validUntil: '2026-10-10T08:00:00.000Z',
      sourceAuthority: 'node --version',
    } })
    const fact = session('session-fact', now.getTime(), [
      turnStart(0, now.getTime(), 1),
      user(1, now.getTime() + 1, 1, '读取当前工作区 Node 版本。'),
      toolCall(2, now.getTime() + 2, 1, 'fact-1', 'bash', '{"command":"node --version"}'),
      toolResult(3, now.getTime() + 3, 1, 'fact-1', factEnvelope),
      turnEnd(4, now.getTime() + 4, 1),
    ])
    const causalText = '当禁用缓存时，禁用缓存导致延迟下降。机制：避免旧缓存读取；另一种解释：网络波动；证伪条件：禁用缓存后延迟不变。'
    const causalWithoutObservation = session('session-causal-empty', now.getTime() + 10, [
      turnStart(0, now.getTime() + 10, 1), user(1, now.getTime() + 11, 1, causalText),
      turnEnd(2, now.getTime() + 12, 1),
    ])
    const causal = session('session-causal', now.getTime() + 20, [
      turnStart(0, now.getTime() + 20, 1), user(1, now.getTime() + 21, 1, causalText),
      toolCall(2, now.getTime() + 22, 1, 'causal-1', 'bash', '{"command":"node measure.js"}'),
      toolResult(3, now.getTime() + 23, 1, 'causal-1', 'latency decreased by 30%'),
      turnEnd(4, now.getTime() + 24, 1),
    ])
    const source = new DshSessionSource(query([fact, causalWithoutObservation, causal]), sourceLimits())
    const batch = await source.scanRecentCompletedTurns(8, 60_000, now)
    const detect = (sessionId: string) => detectSuggestionSeed(
      batch.sessions.find(item => item.sessionId === sessionId)!.slices[0]!,
      `/workspace/${sessionId}`, 60_000, evidenceLimits(),
    )

    expect(detect('session-fact')).toMatchObject({ suggestedKinds: ['fact'], triggerKind: 'authoritative_fact' })
    expect(detect('session-causal-empty')).toBeNull()
    expect(detect('session-causal')).toMatchObject({ suggestedKinds: ['causal'], triggerKind: 'causal_candidate' })

    const proseFact = fact.events.map(event => event.seq === 3
      ? toolResult(3, now.getTime() + 3, 1, 'fact-1', 'Node version is probably v22.23.1') : event)
    const proseSource = new DshSessionSource(query([
      session('session-prose-fact', now.getTime(), proseFact),
    ]), sourceLimits())
    const proseBatch = await proseSource.scanRecentCompletedTurns(1, 60_000, now)
    expect(detectSuggestionSeed(
      proseBatch.sessions[0]!.slices[0]!, '/workspace/prose', 60_000, evidenceLimits(),
    )).toBeNull()

    const forgedAuthority = fact.events.map(event => event.seq === 2
      ? toolCall(2, now.getTime() + 2, 1, 'fact-1', 'bash', '{"command":"echo untrusted"}') : event)
    const forgedSource = new DshSessionSource(query([
      session('session-forged-fact', now.getTime(), forgedAuthority),
    ]), sourceLimits())
    const forgedBatch = await forgedSource.scanRecentCompletedTurns(1, 60_000, now)
    expect(detectSuggestionSeed(
      forgedBatch.sessions[0]!.slices[0]!, '/workspace/forged', 60_000, evidenceLimits(),
    )).toBeNull()
  })

  it('refuses to activate a partial recent-N scan when any Session metadata read fails', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const value = session('session-failing', now.getTime(), procedureEvents(now.getTime()))
    const failing = query([value])
    failing.listEvents = async () => { throw new Error('backend unavailable') }
    const source = new DshSessionSource(failing, sourceLimits())

    await expect(source.scanRecentCompletedTurns(8, 14 * 24 * 60 * 60_000, now))
      .rejects.toMatchObject({ code: 'source_unresolvable' })
  })

  it('blocks only the sensitive turn while allowing other recent Sessions to project', async () => {
    const now = new Date('2026-09-10T08:00:00.000Z')
    const unsafeEvents = procedureEvents(now.getTime()).map(event => event.seq === 1
      ? user(1, now.getTime() + 1, 1, 'Authorization: Bearer private-session-token')
      : event)
    const source = new DshSessionSource(query([
      session('session-safe', now.getTime() - 1_000, procedureEvents(now.getTime() - 1_000)),
      session('session-sensitive', now.getTime(), unsafeEvents),
    ]), sourceLimits())
    const batch = await source.scanRecentCompletedTurns(8, 14 * 24 * 60 * 60_000, now)
    const sensitive = batch.sessions.find(item => item.sessionId === 'session-sensitive')!
    const safe = batch.sessions.find(item => item.sessionId === 'session-safe')!

    expect(sensitive.slices).toEqual([expect.objectContaining({
      records: [], blockedReason: 'sensitive_content',
    })])
    expect(safe.slices[0]).toMatchObject({ blockedReason: null })
    expect(JSON.stringify(batch)).not.toContain('private-session-token')

    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-sensitive-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const ctx = new Context()
    const worker = new ExperienceProjectionWorker(ctx, {
      scanRecentCompletedTurns: vi.fn(async () => batch),
    } as never, store, {
      ...DEFAULT_EXPERIENCE_PROJECTION_POLICY,
      pollIntervalMs: 60_000,
    })
    const projection = await worker.drain(now)
    expect(projection.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-safe', state: 'processed' }),
      expect.objectContaining({
        sessionId: 'session-sensitive',
        state: 'blocked',
        reason: 'sensitive_content_omitted',
        occurrenceIds: [],
      }),
    ]))
    expect(projection.seeds).toHaveLength(1)
    expect(JSON.stringify(projection)).not.toContain('private-session-token')
    await worker.stop()
    store.close()
  })
})

describe('E1 disposable projection store and worker', () => {
  it('atomically activates, deduplicates unchanged rebuilds, survives restart, and rolls back a failed generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-store-'))
    cleanup.push(directory)
    const canonicalPath = join(directory, 'experience.sqlite')
    const store = await ExperienceProjectionStore.open(canonicalPath)
    const seed = sampleSeed()
    const scan = sampleScan(seed)
    const first = store.rebuild(build('sha256:' + '1'.repeat(64), [scan], [seed]))
    expect(first).toMatchObject({ generation: 1, state: 'ready', seeds: [{ occurrenceId: seed.occurrenceId }] })
    const receiptCount = store.handle.prepare('SELECT count(*) AS count FROM projection_receipts').get()
    const unchanged = store.rebuild(build('sha256:' + '1'.repeat(64), [scan], [seed]))
    expect(unchanged.generation).toBe(1)
    expect(unchanged.latestReceipt.status).toBe('activated')
    expect(store.handle.prepare('SELECT count(*) AS count FROM projection_receipts').get()).toEqual(receiptCount)

    expect(() => store.rebuild(build(
      'sha256:' + '2'.repeat(64),
      [scan, { ...scan }],
      [{ ...seed, stableKernel: { ...seed.stableKernel, taskGoal: 'changed' } }],
    ))).toThrow()
    expect(store.read()).toMatchObject({ generation: 1, sourceWatermarkDigest: 'sha256:' + '1'.repeat(64) })
    store.close()

    const reopened = await ExperienceProjectionStore.open(canonicalPath)
    expect(reopened.read()).toMatchObject({ generation: 1, seeds: [{ occurrenceId: seed.occurrenceId }] })
    reopened.close()
  })

  it('does not rotate generations only because the same source was observed again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-observed-at-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const firstSeed = seedWithObservedAt('2026-09-10T08:00:00.000Z')
    const first = store.rebuild(build(
      'sha256:' + '5'.repeat(64), [sampleScan(firstSeed)], [firstSeed],
    ))
    const rereadSeed = seedWithObservedAt('2026-09-10T09:00:00.000Z')
    const reread = store.rebuild(build(
      'sha256:' + '5'.repeat(64), [sampleScan(rereadSeed)], [rereadSeed],
    ))

    expect(reread.generation).toBe(first.generation)
    expect(reread.seeds[0]?.evidenceSignals[0]?.sourceRef.observedAt)
      .toBe('2026-09-10T08:00:00.000Z')
    store.close()
  })

  it('shares one atomic generation across connections and remains retryable after lock contention', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-connections-'))
    cleanup.push(directory)
    const canonicalPath = join(directory, 'experience.sqlite')
    const [left, right] = await Promise.all([
      ExperienceProjectionStore.open(canonicalPath),
      ExperienceProjectionStore.open(canonicalPath),
    ])
    const seed = sampleSeed()
    left.rebuild(build('sha256:' + '6'.repeat(64), [sampleScan(seed)], [seed]))
    expect(right.read()).toMatchObject({ generation: 1, seeds: [{ occurrenceId: seed.occurrenceId }] })

    right.handle.exec('PRAGMA busy_timeout = 5')
    left.handle.exec('BEGIN IMMEDIATE')
    try {
      expect(() => right.rebuild(build('sha256:' + '7'.repeat(64), [], []))).toThrow()
    } finally {
      left.handle.exec('ROLLBACK')
    }
    expect(right.rebuild(build('sha256:' + '7'.repeat(64), [], []))).toMatchObject({
      generation: 2, sessions: [], seeds: [],
    })
    expect(left.read()).toMatchObject({ generation: 2, sessions: [], seeds: [] })
    left.close()
    right.close()
  })

  it('GCs expired seeds and quarantines corrupt sidecar state without touching the canonical path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-corrupt-'))
    cleanup.push(directory)
    const canonicalPath = join(directory, 'experience.sqlite')
    await writeFile(canonicalPath, 'canonical sentinel')
    await chmod(canonicalPath, 0o600)
    const sidecarPath = suggestionProjectionPath(canonicalPath)
    const first = await ExperienceProjectionStore.open(canonicalPath)
    const expired = { ...sampleSeed(), expiresAt: '2026-09-09T00:00:00.000Z' }
    const view = first.rebuild(build('sha256:' + '3'.repeat(64), [sampleScan(expired)], [expired]))
    expect(view.seeds).toEqual([])
    expect(view.sessions[0]?.occurrenceIds).toEqual([])
    first.close()

    await writeFile(sidecarPath, 'not a sqlite database')
    await chmod(sidecarPath, 0o600)
    const recovered = await ExperienceProjectionStore.open(canonicalPath)
    expect(recovered.read()).toMatchObject({
      generation: 0,
      state: 'degraded',
      degradedReason: 'recovered_from_corruption',
    })
    expect(await readdir(directory)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^experience\.sqlite\.projection\.sqlite\.corrupt-/u),
    ]))
    expect(await import('node:fs/promises').then(fs => fs.readFile(canonicalPath, 'utf8')))
      .toBe('canonical sentinel')
    recovered.close()
  })

  it('persists one exact dismissal across restart and later projection generations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-dismiss-'))
    cleanup.push(directory)
    const canonicalPath = join(directory, 'experience.sqlite')
    const seed = seedWithObservedAt('2026-09-10T08:00:00.000Z')
    const group = materializeSuggestionGroups([seed], 32_768)[0]!
    const store = await ExperienceProjectionStore.open(canonicalPath)
    store.rebuild(build('sha256:' + '8'.repeat(64), [sampleScan(seed)], [seed], [group]))
    const input = {
      commandId: 'dismiss-command-1',
      suggestionGroupId: group.suggestionGroupId,
      expectedRevisionDigest: group.revisionDigest,
      reviewDigest: group.reviewDigest,
      reasonCode: 'not_reusable' as const,
      issuedAt: '2026-09-10T08:02:00.000Z',
    }

    const dismissed = store.dismiss(input, 'actor-local' as never)
    expect(dismissed).toMatchObject({
      groups: [],
      suppressedGroupCount: 1,
      latestReceipt: { status: 'dismissed', reason: 'not_reusable' },
      dispositions: [{
        suggestionGroupId: group.suggestionGroupId,
        actorId: 'actor-local',
        decision: 'dismissed',
      }],
    })
    const receiptId = dismissed.latestReceipt.receiptId
    expect(store.dismiss(input, 'actor-local' as never).latestReceipt.receiptId).toBe(receiptId)
    expect(() => store.dismiss({ ...input, reasonCode: 'one_off_task' }, 'actor-local' as never))
      .toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
    store.close()

    const reopened = await ExperienceProjectionStore.open(canonicalPath)
    expect(reopened.read()).toMatchObject({ groups: [], suppressedGroupCount: 1 })
    const nextSeed = {
      ...seed,
      detectorVersion: 'procedure-diagnostic-detector-v2',
      evidenceSignals: seed.evidenceSignals.map(signal => ({
        ...signal,
        sourceRef: { ...signal.sourceRef, observedAt: '2026-09-10T09:00:00.000Z' },
      })),
    }
    const nextGroup = materializeSuggestionGroups([nextSeed], 32_768)[0]!
    expect(nextGroup.suggestionGroupId).toBe(group.suggestionGroupId)
    const rebuilt = reopened.rebuild(build(
      'sha256:' + '9'.repeat(64), [sampleScan(nextSeed)], [nextSeed], [nextGroup],
    ))
    expect(rebuilt).toMatchObject({ groups: [], suppressedGroupCount: 1 })
    reopened.close()
  })

  it('atomically suppresses a semantic composite and every source group with one command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-semantic-dismiss-'))
    cleanup.push(directory)
    const canonicalPath = join(directory, 'experience.sqlite')
    const seed = readySeedWithObservedAt('2026-09-10T08:00:00.000Z')
    const sourceA = materializeSuggestionGroups([seed], 32_768)[0]!
    const sourceB = withSuggestionDigests({
      ...sourceA,
      suggestionGroupId: `${sourceA.suggestionGroupId}:paraphrase`,
      occurrences: sourceA.occurrences.map(occurrence => ({
        ...occurrence,
        occurrenceId: `${occurrence.occurrenceId}:paraphrase`,
      })),
    })
    const sourceGroups = [sourceA, sourceB].sort((left, right) =>
      left.suggestionGroupId.localeCompare(right.suggestionGroupId))
    const compositeBase: ExperienceSuggestionGroupView = {
      ...sourceGroups[0]!,
      suggestionGroupId: `suggestion-group:semantic:${'a'.repeat(64)}`,
      reviewDigest: null,
      consolidation: 'semantic_consolidated',
      relatedGroupIds: sourceGroups.map(group => group.suggestionGroupId),
      occurrences: sourceGroups.flatMap(group => group.occurrences),
      occurrenceCount: 2,
      consolidationDetail: {
        algorithmVersion: 'experience-equivalence-v1',
        decision: 'same',
        reasonCodes: ['recent_component_correspondence_complete'],
        sourceSuggestionGroupIds: sourceGroups.map(group => group.suggestionGroupId),
        sourceGroups: sourceGroups.map(group => ({
          suggestionGroupId: group.suggestionGroupId,
          kernelIdentity: group.kernelIdentity,
          revisionDigest: group.revisionDigest,
          occurrenceIds: group.occurrences.map(occurrence => occurrence.occurrenceId),
        })),
        targetExperienceId: null,
        targetExperienceVersionId: null,
        targetVersionContentDigest: null,
        retrievalGeneration: 0,
        modelIdentityDigest: `sha256:${'b'.repeat(64)}`,
        operationSettingsDigest: `sha256:${'c'.repeat(64)}`,
        activeComparisonSetDigest: `sha256:${'d'.repeat(64)}`,
        allowedOwnerChoices: [],
        componentCorrespondence: [],
        materialDifferences: [],
      },
    }
    const composite = withSuggestionDigests(compositeBase)
    const store = await ExperienceProjectionStore.open(canonicalPath)
    store.rebuild(build('sha256:' + 'a'.repeat(64), [sampleScan(seed)], [seed], [composite]))
    const input = {
      commandId: 'dismiss-semantic-cluster',
      suggestionGroupId: composite.suggestionGroupId,
      expectedRevisionDigest: composite.revisionDigest,
      reviewDigest: composite.reviewDigest,
      reasonCode: 'not_reusable' as const,
      issuedAt: '2026-09-10T08:02:00.000Z',
    }

    const dismissed = store.dismiss(input, 'actor-local' as never)

    expect(dismissed.groups).toEqual([])
    expect(dismissed.dispositions.map(disposition => disposition.suggestionGroupId)).toEqual([
      composite.suggestionGroupId,
      ...sourceGroups.map(group => group.suggestionGroupId),
    ].sort())
    expect(new Set(dismissed.dispositions.map(disposition => disposition.commandId)))
      .toEqual(new Set([input.commandId]))
    const rebuilt = store.rebuild(build(
      'sha256:' + 'b'.repeat(64), [sampleScan(seed)], [seed], sourceGroups,
    ))
    expect(rebuilt.groups).toEqual([])
    expect(rebuilt.suppressedGroupCount).toBe(2)
    store.close()

    const reopened = await ExperienceProjectionStore.open(canonicalPath)
    expect(reopened.read()).toMatchObject({ groups: [], suppressedGroupCount: 2 })
    reopened.close()

  })

  it('suppresses every source group after saving one semantic composite and idempotently repairs a missing row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-semantic-save-'))
    cleanup.push(directory)
    const canonicalPath = join(directory, 'experience.sqlite')
    const seed = readySeedWithObservedAt('2026-09-10T08:00:00.000Z')
    const sourceA = materializeSuggestionGroups([seed], 32_768)[0]!
    const sourceB = withSuggestionDigests({
      ...sourceA,
      suggestionGroupId: `${sourceA.suggestionGroupId}:paraphrase`,
      occurrences: sourceA.occurrences.map(occurrence => ({
        ...occurrence,
        occurrenceId: `${occurrence.occurrenceId}:paraphrase`,
      })),
    })
    const sourceGroups = [sourceA, sourceB].sort((left, right) =>
      left.suggestionGroupId.localeCompare(right.suggestionGroupId))
    const composite = withSuggestionDigests({
      ...sourceGroups[0]!,
      suggestionGroupId: `suggestion-group:semantic:${'e'.repeat(64)}`,
      reviewDigest: null,
      consolidation: 'semantic_consolidated',
      relatedGroupIds: sourceGroups.map(group => group.suggestionGroupId),
      occurrences: sourceGroups.flatMap(group => group.occurrences),
      occurrenceCount: 2,
      consolidationDetail: {
        algorithmVersion: 'experience-equivalence-v1',
        decision: 'same',
        reasonCodes: ['recent_component_correspondence_complete'],
        sourceSuggestionGroupIds: sourceGroups.map(group => group.suggestionGroupId),
        sourceGroups: sourceGroups.map(group => ({
          suggestionGroupId: group.suggestionGroupId,
          kernelIdentity: group.kernelIdentity,
          revisionDigest: group.revisionDigest,
          occurrenceIds: group.occurrences.map(occurrence => occurrence.occurrenceId),
        })),
        targetExperienceId: null,
        targetExperienceVersionId: null,
        targetVersionContentDigest: null,
        retrievalGeneration: 0,
        modelIdentityDigest: `sha256:${'b'.repeat(64)}`,
        operationSettingsDigest: `sha256:${'c'.repeat(64)}`,
        activeComparisonSetDigest: `sha256:${'d'.repeat(64)}`,
        allowedOwnerChoices: [],
        componentCorrespondence: [],
        materialDifferences: [],
      },
    })
    const input = {
      commandId: 'save-semantic-cluster' as never,
      suggestionGroupId: composite.suggestionGroupId,
      expectedRevisionDigest: composite.revisionDigest,
      reviewDigest: composite.reviewDigest!,
      sourceDigest: composite.sourceDigest,
      correlationId: 'save-semantic-cluster-correlation',
      causationId: null,
      issuedAt: '2026-09-10T08:02:00.000Z',
    }
    const receipt: SuggestionSaveDomainReceipt = {
      receiptId: 'receipt:semantic-save-1' as never,
      commandId: input.commandId,
      action: 'suggestion.save',
      actor: {
        actorId: 'actor-local' as never,
        principalId: 'principal-local' as never,
        kind: 'management_local_owner',
        authority: 'owner',
      },
      suggestionGroupId: composite.suggestionGroupId,
      kernelIdentity: composite.kernelIdentity,
      outcome: 'saved_new_experience',
      experienceId: 'experience:semantic-save-1' as never,
      experienceVersionId: 'version:semantic-save-1' as never,
      evidenceIds: ['evidence:semantic-save-1' as never],
      assessmentId: 'assessment:semantic-save-1' as never,
      reviewDigest: composite.reviewDigest!,
      sourceDigest: composite.sourceDigest,
      suggestionRevisionDigest: composite.revisionDigest,
      inputDigest: '3'.repeat(64),
      scopeDigest: '4'.repeat(64),
      sourceSuggestionGroupIds: sourceGroups.map(group => group.suggestionGroupId),
      occurrenceIds: composite.occurrences.map(occurrence => occurrence.occurrenceId),
      sourceEpisodeRefs: composite.occurrences.map(occurrence => occurrence.episodeRef),
      sourceRefs: composite.occurrences.flatMap(occurrence => occurrence.sourceRefs),
      expiresAt: composite.expiresAt,
      correlationId: input.correlationId,
      causationId: null,
      issuedAt: input.issuedAt,
      commitSequence: 1,
      createdAt: '2026-09-10T08:02:01.000Z',
    }
    const store = await ExperienceProjectionStore.open(canonicalPath)
    store.rebuild(build('sha256:' + 'a'.repeat(64), [sampleScan(seed)], [seed], [composite]))

    expect(store.markSaved(input, composite, receipt).dispositions).toHaveLength(3)
    store.handle.prepare('DELETE FROM suggestion_dispositions WHERE group_id = ?')
      .run(sourceGroups[1]!.suggestionGroupId)
    expect(store.markSaved(input, composite, receipt).dispositions).toHaveLength(3)
    const rebuilt = store.rebuild(build(
      'sha256:' + 'b'.repeat(64), [sampleScan(seed)], [seed], sourceGroups,
    ))
    expect(rebuilt.groups).toEqual([])
    expect(rebuilt.suppressedGroupCount).toBe(2)
    store.close()

    const reopened = await ExperienceProjectionStore.open(canonicalPath)
    expect(reopened.read()).toMatchObject({ groups: [], suppressedGroupCount: 2 })
    reopened.close()

    const crashPath = join(directory, 'semantic-crash.sqlite')
    const crash = await ExperienceProjectionStore.open(crashPath)
    crash.rebuild(build('sha256:' + 'c'.repeat(64), [sampleScan(seed)], [seed], [composite]))
    expect(crash.reconcileSaved([receipt]).dispositions).toHaveLength(3)
    crash.handle.prepare('DELETE FROM suggestion_dispositions WHERE group_id = ?')
      .run(sourceGroups[0]!.suggestionGroupId)
    expect(crash.reconcileSaved([receipt]).dispositions).toHaveLength(3)
    expect(crash.rebuild(build(
      'sha256:' + 'd'.repeat(64), [sampleScan(seed)], [seed], sourceGroups,
    ))).toMatchObject({ groups: [], suppressedGroupCount: 2 })
    crash.close()

    const crashRestart = await ExperienceProjectionStore.open(crashPath)
    expect(crashRestart.read()).toMatchObject({ groups: [], suppressedGroupCount: 2 })
    crashRestart.close()
  })

  it('validates, suppresses, and repairs a canonical suggestion save without another Experience write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-save-'))
    cleanup.push(directory)
    const canonicalPath = join(directory, 'experience.sqlite')
    const seed = readySeedWithObservedAt('2026-09-10T08:00:00.000Z')
    const group = materializeSuggestionGroups([seed], 32_768)[0]!
    const input = {
      commandId: 'save-command-1' as never,
      suggestionGroupId: group.suggestionGroupId,
      expectedRevisionDigest: group.revisionDigest,
      reviewDigest: group.reviewDigest!,
      sourceDigest: group.sourceDigest,
      correlationId: 'save-correlation-1',
      causationId: null,
      issuedAt: '2026-09-10T08:02:00.000Z',
    }
    const receipt: SuggestionSaveDomainReceipt = {
      receiptId: 'receipt:save-1' as never,
      commandId: input.commandId,
      action: 'suggestion.save',
      actor: {
        actorId: 'actor-local' as never,
        principalId: 'principal-local' as never,
        kind: 'management_local_owner',
        authority: 'owner',
      },
      suggestionGroupId: group.suggestionGroupId,
      kernelIdentity: group.kernelIdentity,
      outcome: 'saved_new_experience',
      experienceId: 'experience:save-1' as never,
      experienceVersionId: 'version:save-1' as never,
      evidenceIds: ['evidence:save-1' as never],
      assessmentId: 'assessment:save-1' as never,
      reviewDigest: group.reviewDigest!,
      sourceDigest: group.sourceDigest,
      suggestionRevisionDigest: group.revisionDigest,
      inputDigest: '1'.repeat(64),
      scopeDigest: '2'.repeat(64),
      sourceSuggestionGroupIds: [group.suggestionGroupId],
      occurrenceIds: group.occurrences.map(occurrence => occurrence.occurrenceId),
      sourceEpisodeRefs: group.occurrences.map(occurrence => occurrence.episodeRef),
      sourceRefs: group.occurrences.flatMap(occurrence => occurrence.sourceRefs),
      expiresAt: group.expiresAt,
      correlationId: input.correlationId,
      causationId: null,
      issuedAt: input.issuedAt,
      commitSequence: 1,
      createdAt: '2026-09-10T08:02:01.000Z',
    }
    const store = await ExperienceProjectionStore.open(canonicalPath)
    store.rebuild(build('sha256:' + '6'.repeat(64), [sampleScan(seed)], [seed], [group]))
    expect(store.resolveForSave(input)).toEqual(group)
    expect(() => store.resolveForSave({
      ...input, sourceDigest: 'sha256:' + 'f'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'stale_revision' }))

    const saved = store.markSaved(input, group, receipt)
    expect(saved).toMatchObject({
      groups: [],
      suppressedGroupCount: 1,
      latestReceipt: { status: 'saved', reason: 'saved_new_experience' },
      dispositions: [{
        suggestionGroupId: group.suggestionGroupId,
        decision: 'saved_new_experience',
        targetRef: receipt.experienceVersionId,
        inputDigest: receipt.inputDigest,
      }],
    })
    store.handle.prepare('UPDATE suggestion_dispositions SET target_ref = ? WHERE group_id = ?')
      .run('version:conflicting', group.suggestionGroupId)
    expect(() => store.markSaved(input, group, receipt)).toThrowError(expect.objectContaining({
      code: 'database_schema_invalid',
    }))
    store.close()

    const repairedPath = join(directory, 'repair.sqlite')
    const repaired = await ExperienceProjectionStore.open(repairedPath)
    repaired.rebuild(build('sha256:' + '7'.repeat(64), [sampleScan(seed)], [seed], [group]))
    expect(repaired.reconcileSaved([receipt])).toMatchObject({
      groups: [],
      suppressedGroupCount: 1,
      latestReceipt: { status: 'saved' },
      dispositions: [{ targetRef: receipt.experienceVersionId }],
    })
    const projectionReceiptId = repaired.read().latestReceipt.receiptId
    expect(repaired.reconcileSaved([receipt]).latestReceipt.receiptId).toBe(projectionReceiptId)
    repaired.close()
  })

  it('rejects stale dismissal snapshots and uses Host time for expiry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-dismiss-stale-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const seed = seedWithObservedAt('2026-09-10T08:00:00.000Z')
    const group = materializeSuggestionGroups([seed], 32_768)[0]!
    store.rebuild(build('sha256:' + 'a'.repeat(64), [sampleScan(seed)], [seed], [group]))
    const base = {
      commandId: 'dismiss-stale-1',
      suggestionGroupId: group.suggestionGroupId,
      expectedRevisionDigest: 'sha256:' + 'b'.repeat(64),
      reviewDigest: group.reviewDigest,
      reasonCode: 'incorrect_abstraction' as const,
      issuedAt: '2026-09-10T08:02:00.000Z',
    }
    expect(() => store.dismiss(base, 'actor-local' as never))
      .toThrowError(expect.objectContaining({ code: 'stale_revision' }))

    const expiredSeed = { ...seed, expiresAt: '2025-01-02T00:00:00.000Z' }
    const expiredGroup = materializeSuggestionGroups([expiredSeed], 32_768)[0]!
    store.rebuild({
      ...build('sha256:' + 'c'.repeat(64), [sampleScan(expiredSeed)], [expiredSeed], [expiredGroup]),
      startedAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:00:01.000Z',
    })
    expect(store.read().groups).toEqual([])
    expect(() => store.dismiss({
      ...base,
      commandId: 'dismiss-expired-1',
      suggestionGroupId: expiredGroup.suggestionGroupId,
      expectedRevisionDigest: expiredGroup.revisionDigest,
      reviewDigest: expiredGroup.reviewDigest,
      issuedAt: '2025-01-01T00:00:00.000Z',
    }, 'actor-local' as never)).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
    store.close()
  })

  it('keeps the previous generation on source failure and clears degradation after a missed-wake rebuild', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-worker-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const ctx = new Context()
    const seed = sampleSeed()
    let fail = false
    const source = {
      scanRecentCompletedTurns: vi.fn(async () => {
        if (fail) throw new Error('private backend detail')
        return {
          sourceWatermarkDigest: 'sha256:' + '4'.repeat(64),
          sessions: [{
            sessionId: seed.sessionId,
            workspaceRoot: seed.workspaceRoot,
            sessionCreatedAt: '2026-09-10T07:00:00.000Z',
            lastEventAt: '2026-09-10T08:00:00.000Z',
            capturedThroughSeq: seed.episodeRef.eventEnd,
            lastCompletedEndSeq: seed.episodeRef.eventEnd,
            slices: [],
          }],
        }
      }),
    }
    const worker = new ExperienceProjectionWorker(ctx, source as never, store, {
      ...DEFAULT_EXPERIENCE_PROJECTION_POLICY,
      pollIntervalMs: 60_000,
    })
    await worker.drain(new Date('2026-09-10T08:00:00.000Z'))
    const goodGeneration = store.read().generation
    fail = true
    const degraded = await worker.drain(new Date('2026-09-10T08:01:00.000Z'))
    expect(degraded).toMatchObject({
      generation: goodGeneration,
      state: 'degraded',
      degradedReason: 'source_unavailable',
      latestReceipt: { status: 'failed', reason: 'recent Session source unavailable' },
    })
    expect(JSON.stringify(degraded)).not.toContain('private backend detail')
    fail = false
    const recovered = await worker.drain(new Date('2026-09-10T08:02:00.000Z'))
    expect(recovered).toMatchObject({ generation: goodGeneration, state: 'ready' })
    await worker.stop()
    store.close()
  })

  it('does not misreport a projection/materialization failure as a Session source failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-internal-failure-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const ctx = new Context()
    const worker = new ExperienceProjectionWorker(ctx, {
      scanRecentCompletedTurns: vi.fn(async () => ({
        sourceWatermarkDigest: 'sha256:' + 'd'.repeat(64), sessions: [],
      })),
    } as never, store, { ...DEFAULT_EXPERIENCE_PROJECTION_POLICY, pollIntervalMs: 60_000 })
    vi.spyOn(store, 'rebuild').mockImplementationOnce(() => { throw new Error('projection bug') })

    await expect(worker.drain(new Date('2026-09-10T08:00:00.000Z'))).rejects.toThrow('projection bug')
    expect(store.read()).toMatchObject({ state: 'ready', degradedReason: null })
    await worker.stop()
    store.close()
  })

  it('applies live detection, recent-Session, and TTL settings without a second worker or store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-live-settings-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const existingSeed = sampleSeed()
    store.rebuild(build('sha256:' + '9'.repeat(64), [sampleScan(existingSeed)], [existingSeed]))
    expect(store.read().seeds).toHaveLength(1)
    const ctx = new Context()
    const source = { scanRecentCompletedTurns: vi.fn(async () => ({
      sourceWatermarkDigest: 'sha256:' + '8'.repeat(64), sessions: [],
    })) }
    let values = RuntimeSettingsSchema({ automaticSuggestionDetection: false } as RuntimeSettings)
    const worker = new ExperienceProjectionWorker(
      ctx,
      source as never,
      store,
      { ...DEFAULT_EXPERIENCE_PROJECTION_POLICY, pollIntervalMs: 60_000 },
      () => [],
      async () => undefined,
      () => ({ revision: 1, digest: 'sha256:' + (values.automaticSuggestionDetection ? '2' : '1').repeat(64), values }),
    )

    const disabled = await worker.drain(new Date('2026-09-10T08:00:00.000Z'))
    expect(source.scanRecentCompletedTurns).not.toHaveBeenCalled()
    expect(disabled).toMatchObject({ sessions: [], seeds: [], groups: [] })

    values = RuntimeSettingsSchema({
      automaticSuggestionDetection: true,
      recentSuggestionSessionLimit: 3,
      suggestionTtlMs: 2 * 24 * 60 * 60_000,
    } as RuntimeSettings)
    await worker.drain(new Date('2026-09-10T08:01:00.000Z'))
    expect(source.scanRecentCompletedTurns).toHaveBeenCalledWith(3, 2 * 24 * 60 * 60_000,
      new Date('2026-09-10T08:01:00.000Z'))
    await worker.stop()
    store.close()
  })

  it('uses turn/end only as a wake hint and rebuilds one stable occurrence from Session Query', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-projection-wake-'))
    cleanup.push(directory)
    const now = new Date('2026-09-10T08:00:00.000Z')
    const log = session('session-wake', now.getTime(), procedureEvents(now.getTime()))
    const dshSource = new DshSessionSource(query([log]), sourceLimits())
    const scanned = await dshSource.scanRecentCompletedTurns(8, 14 * 24 * 60 * 60_000, now)
    let visible = false
    const source = {
      scanRecentCompletedTurns: vi.fn(async () => visible ? scanned : {
        sourceWatermarkDigest: 'sha256:' + '0'.repeat(64), sessions: [],
      }),
    }
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const ctx = new Context()
    const worker = new ExperienceProjectionWorker(ctx, source as never, store, {
      ...DEFAULT_EXPERIENCE_PROJECTION_POLICY,
      pollIntervalMs: 60_000,
    })
    worker.install()
    await worker.drain(now)
    expect(store.read().seeds).toEqual([])

    visible = true
    ctx.emit('session/event', {} as never, turnEnd(20, now.getTime() + 20, 2))
    ctx.emit('session/event', {} as never, turnEnd(20, now.getTime() + 20, 2))
    await vi.waitFor(() => expect(store.read().seeds).toHaveLength(1))
    const projected = store.read()
    expect(projected).toMatchObject({
      generation: 2,
      sessions: [{ sessionId: 'session-wake', state: 'processed' }],
      seeds: [{ sessionId: 'session-wake', suggestedKinds: ['procedure'] }],
      groups: [{ kind: 'procedure', saveReadiness: 'ready', occurrenceCount: 1 }],
    })
    expect(new Set(projected.seeds.map(seed => seed.occurrenceId)).size).toBe(1)

    await ctx.fiber.dispose()
    store.close()
  })
})

function session(id: string, createdAt: number, events: readonly SessionEvent[]): SessionLogSnapshot {
  return {
    session: {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt,
      cwd: `/workspace/${id}`,
      isSeeded: false,
    },
    inheritedEventCount: SessionLogOffset(0),
    events: [...events],
  }
}

function query(
  sessions: readonly SessionLogSnapshot[],
  calls: { listSessions: number; listEvents: number; readSession: number; readEvent: number } = {
    listSessions: 0, listEvents: 0, readSession: 0, readEvent: 0,
  },
) {
  const byId = new Map(sessions.map(value => [String(value.session.id), value]))
  return {
    observeSession: async () => { throw new Error('not used') },
    listSessions: async (): Promise<SessionRecord[]> => {
      calls.listSessions++
      return sessions.map(value => ({ header: value.session, live: false, persisted: true }))
    },
    listEvents: async (id: SessionId): Promise<SessionEventRecord[]> => {
      calls.listEvents++
      const value = byId.get(String(id))!
      return value.events.map(event => ({
        sessionId: id, seq: event.seq, type: event.type, time: event.time, surface: 'log-only',
      }))
    },
    readSession: async (id: SessionId): Promise<SessionLogSnapshot> => {
      calls.readSession++
      return byId.get(String(id))!
    },
    readEvent: async (request: { sessionId: SessionId; seq: number }) => {
      calls.readEvent++
      const value = byId.get(String(request.sessionId))!
      const target = value.events.find(event => event.seq === request.seq)!
      return {
        session: value.session,
        target,
        events: [target],
        inheritedEventCount: SessionLogOffset(0),
        startSeq: target.seq,
        endSeq: target.seq,
      }
    },
  }
}

function diagnosticEvents(base: number): SessionEvent[] {
  return [
    turnStart(0, base, 1),
    user(1, base + 1, 1, '修复 Web 启动失败并验证健康检查。'),
    toolCall(2, base + 2, 1, 'build-1', 'bash', '{"command":"pnpm build"}'),
    toolResult(3, base + 3, 1, 'build-1', 'dist missing', { name: 'Error', code: 'ENOENT' }),
    toolCall(4, base + 4, 1, 'read-1', 'read', '{"path":"package.json"}'),
    toolResult(5, base + 5, 1, 'read-1', 'build script found'),
    toolCall(6, base + 6, 1, 'check-1', 'bash', '{"command":"pnpm test"}'),
    toolResult(7, base + 7, 1, 'check-1', '403 tests passed'),
    assistant(8, base + 8, 1, '已修复，自动化测试全部通过。'),
    turnEnd(9, base + 9, 1),
  ]
}

function procedureEvents(base: number): SessionEvent[] {
  return [
    turnStart(0, base, 1),
    user(1, base + 1, 1, '构建并验证项目。'),
    toolCall(2, base + 2, 1, 'check-1', 'bash', '{"command":"pnpm check"}'),
    toolResult(3, base + 3, 1, 'check-1', 'all checks passed'),
    assistant(4, base + 4, 1, '构建验证完成。'),
    turnEnd(5, base + 5, 1),
  ]
}

function turnStart(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/start', seq, time, data: { turn } } as SessionEvent
}

function user(seq: number, time: number, _turn: number, text: string): SessionEvent {
  return {
    type: 'user/message', seq, time,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  } as unknown as SessionEvent
}

function assistant(seq: number, time: number, turn: number, text: string): SessionEvent {
  return {
    type: 'assistant/message', seq, time,
    data: {
      turn, step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text }] },
    },
  } as unknown as SessionEvent
}

function toolCall(
  seq: number,
  time: number,
  turn: number,
  callId: string,
  name: string,
  args: string,
): SessionEvent {
  return { type: 'tool/call', seq, time, data: { turn, step: 1, callId, name, arguments: args } } as SessionEvent
}

function toolResult(
  seq: number,
  time: number,
  turn: number,
  callId: string,
  text: string,
  error?: { name: string; code: string },
): SessionEvent {
  return {
    type: 'tool/result', seq: SessionSeq(seq), time,
    data: {
      turn,
      step: 1,
      message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] },
      ...(error === undefined ? {} : { error }),
    },
  } as unknown as SessionEvent
}

function turnEnd(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/end', seq, time, data: { turn, reason: { kind: 'completed' } } } as SessionEvent
}

function sourceLimits() {
  return { maxRecords: 96, maxRecordBytes: 8_192, maxTotalBytes: 262_144 }
}

function evidenceLimits() {
  return { maxEvidenceItems: 64, maxEvidenceItemBytes: 4_096, maxEvidencePacketBytes: 65_536 }
}

function sampleSeed(): ExperienceSuggestionSeedView {
  return {
    occurrenceId: 'occurrence:test',
    sessionId: 'session-test',
    workspaceRoot: '/workspace/test',
    episodeRef: {
      episodeRefId: 'episode:test' as never,
      sourceSystem: 'dsh-session',
      sessionOrRunId: 'session-test',
      eventStart: 0,
      eventEnd: 5,
      occurredAt: { start: '2026-09-10T07:59:00.000Z', end: '2026-09-10T08:00:00.000Z' },
      contentDigest: 'sha256:' + 'a'.repeat(64),
      redactionState: 'bounded_excerpt',
    },
    suggestedKinds: ['procedure'],
    triggerKind: 'terminal_success',
    stableKernel: {
      taskGoal: 'verify build',
      toolSequence: ['bash'],
      failedToolSequence: [],
      recoveryToolSequence: ['bash'],
      failureCodes: [],
      verifierTools: ['bash'],
    },
    evidenceSignals: [],
    detectorVersion: 'detector-v1',
    segmenterVersion: 'segmenter-v1',
    detectedAt: '2026-09-10T08:00:00.000Z',
    expiresAt: '2026-09-24T08:00:00.000Z',
  }
}

function sampleScan(seed: ExperienceSuggestionSeedView): SessionSuggestionScanView {
  return {
    sessionId: seed.sessionId,
    workspaceRoot: seed.workspaceRoot,
    sessionCreatedAt: '2026-09-10T07:00:00.000Z',
    lastEventAt: seed.detectedAt,
    capturedThroughSeq: seed.episodeRef.eventEnd,
    lastCompletedEndSeq: seed.episodeRef.eventEnd,
    state: 'processed',
    reason: null,
    occurrenceIds: [seed.occurrenceId],
  }
}

function seedWithObservedAt(observedAt: string): ExperienceSuggestionSeedView {
  const seed = sampleSeed()
  return {
    ...seed,
    evidenceSignals: [{
      itemId: 'evidence:test',
      sourceRef: {
        sourceRefId: 'source:test' as never,
        sourceSystem: 'dsh-session',
        sourceKind: 'tool_result',
        locator: 'dsh-session:session-test#4',
        ownerScope: 'session:session-test',
        accessScope: 'local_owner',
        occurredAt: '2026-09-10T08:00:00.000Z',
        observedAt,
        contentDigest: 'sha256:' + 'b'.repeat(64),
        redactionState: 'bounded_excerpt',
      },
      eventType: 'tool/result',
      role: 'terminal_readback',
      evidenceClass: 'observed_fact',
      content: 'checks passed',
      projectionDigest: 'sha256:' + 'c'.repeat(64),
      projectionTruncated: false,
    }],
  }
}

function readySeedWithObservedAt(observedAt: string): ExperienceSuggestionSeedView {
  const seed = seedWithObservedAt(observedAt)
  const result = seed.evidenceSignals[0]!
  return {
    ...seed,
    evidenceSignals: [{
      itemId: 'evidence:user-goal',
      sourceRef: {
        ...result.sourceRef,
        sourceRefId: 'source:user-goal' as never,
        sourceKind: 'user_instruction',
        locator: 'dsh-session:session-test#1',
        contentDigest: 'sha256:' + 'd'.repeat(64),
      },
      eventType: 'user/message',
      role: 'user_goal',
      evidenceClass: 'user_instruction',
      content: 'verify build',
      projectionDigest: 'sha256:' + 'e'.repeat(64),
      projectionTruncated: false,
    }, {
      ...result,
      content: 'bash\n{"command":"pnpm test"}\n\nchecks passed',
    }],
  }
}

function build(
  sourceWatermarkDigest: string,
  sessions: readonly SessionSuggestionScanView[],
  seeds: readonly ExperienceSuggestionSeedView[],
  groups = materializeSuggestionGroups(seeds, 32_768),
) {
  return {
    projectorVersion: 'projector-v1',
    sourceWatermarkDigest,
    sessions,
    seeds,
    groups,
    startedAt: '2026-09-10T08:01:00.000Z',
    completedAt: '2026-09-10T08:01:01.000Z',
  }
}

function withSuggestionDigests(group: ExperienceSuggestionGroupView): ExperienceSuggestionGroupView {
  return { ...group, ...suggestionDecisionDigests(group) }
}
