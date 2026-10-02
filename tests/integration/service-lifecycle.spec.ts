import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brandedId } from '../../src/ids.js'
import { suggestionDigest } from '../../src/domain/automatic-suggestion.js'
import { suggestionDecisionDigests } from '../../src/domain/suggestion-materializer.js'
import { experienceKernelIdentity } from '../../src/domain/experience-kernel.js'
import { ExperienceProjectionStore } from '../../src/persistence/projection-store.js'
import type { ExperienceSuggestionGroupView, ExperienceSuggestionSeedView } from '../../src/types.js'
import { episodeRef, sourceRef, workflowDraft } from '../fixtures/workflow.js'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it } from 'vitest'
import Experiences, { type Config } from '../../src/index.js'

const cleanup: string[] = []
const localEmbeddingDisabled = {
  embeddingProvider: 'disabled' as const,
  embeddingModelPath: '',
  embeddingModelId: 'Xenova/multilingual-e5-small',
  embeddingModelRevision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  embeddingArtifactPath: 'onnx/model_quantized.onnx',
  embeddingArtifactSha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
  embeddingArtifactBytes: 118_308_185,
  embeddingTokenizerConfigBundleSha256: '4fbcddc3ad44860d65318f8f0c7b8f9d49632554f41b735749fe9075f04bb133',
  embeddingNormalization: 'l2' as const,
  embeddingMaxInputTokens: 512,
  embeddingTruncationPolicy: 'truncate_end' as const,
  embeddingDimension: 384,
  embeddingDtype: 'q8' as const,
  embeddingPooling: 'mean' as const,
  embeddingQueryPrefix: 'query: ',
  embeddingPassagePrefix: 'passage: ',
  embeddingTimeoutMs: 60_000,
  embeddingSimilarityThreshold: 0.76,
  embeddingMargin: 0.025,
  equivalenceSimilarityThreshold: 0.88,
  equivalenceMargin: 0.03,
}
const automationDefaults = {
  automaticSuggestionDetection: true,
  recentSuggestionSessionLimit: 8,
  suggestionTtlMs: 14 * 24 * 60 * 60_000,
  enrichmentMode: 'disabled' as const,
  generationRoute: 'configured_dsh_provider' as const,
  automaticRecall: true,
  automaticContextInjection: 'after_current_plan_approval' as const,
  automaticToolExecution: 'disabled' as const,
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Cordis Experience service lifecycle', () => {
  it.each([false, true])('waits for Host services but not history scans, and closes on disposal (slow=%s)', async slow => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-map-service-'))
    cleanup.push(directory)
    const path = join(directory, 'experience.sqlite')
    const ctx = new Context()
    let registeredRoute: ConnectionFetchRoute | undefined
    let transportDisposed = false
    ctx.provide('connection', {
      fetch: {
        register(route: ConnectionFetchRoute) {
          registeredRoute = route
          return async () => { transportDisposed = true }
        },
      },
    } as unknown as HostConnectionHandle)
    const fiber = ctx.plugin(Experiences, serviceConfig(path))
    expect(ctx.get('experiences')).toBeUndefined()
    ctx.provide('sessions', {} as never)
    expect(ctx.get('experiences')).toBeUndefined()
    const history = Promise.withResolvers<void>()
    const query = emptySessionQuery()
    if (slow) query.listSessions = async () => { await history.promise; return [] }
    ctx.provide('sessionQuery', query as never)
    try {
      const activated = await Promise.race([
        fiber.await().then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
      ])
      expect(activated).toBe(true)
    } catch (error) {
      history.resolve()
      await fiber.await()
      await fiber.dispose()
      throw error
    }
    history.resolve()
    await expect.poll(() => ctx.experiences.getSuggestionProjection({ kind: 'management-cli' }).state).toBe('ready')
    expect(registeredRoute).toMatchObject({
      path: '/api/experience-map', methods: ['POST'], requestBody: 'buffered',
    })
    expect(ctx.experiences.getStatus({ kind: 'management-cli' }))
      .toMatchObject({ candidateCount: 0, versionCount: 0 })
    expect('publishDiagnostic' in ctx.experiences).toBe(false)
    expect(ctx.experiences.getSuggestionProjection({ kind: 'management-cli' })).toMatchObject({
      projectionKey: 'experience-suggestions-v1', schemaVersion: 5, state: 'ready',
      sessions: [], seeds: [], groups: [], dispositions: [],
    })
    expect(ctx.experiences.getRetrievalProjection({ kind: 'management-cli' })).toMatchObject({
      projectionKey: 'experience-retrieval-v1',
      manifest: {
        state: 'lexical_ready', provider: 'disabled', providerState: 'disabled',
        documentCount: 0, vectorCount: 0,
      },
      documents: [],
    })
    expect(ctx.experiences.getAutomationConfiguration({ kind: 'management-cli' })).toMatchObject({
      suggestionDetection: { configured: true, effective: true },
      recentSuggestionSessionLimit: 8,
      suggestionTtlMs: 14 * 24 * 60 * 60_000,
      recall: { configured: true, effective: true },
      contextInjection: {
        configured: 'after_current_plan_approval', effective: 'after_current_plan_approval',
      },
      toolExecution: { configured: 'disabled', effective: 'disabled' },
    })
    expect(() => ctx.experiences.getSuggestionProjection({
      kind: 'restricted-runtime', runtimeKind: 'agent', runtimeId: 'agent-test',
    })).toThrow(expect.objectContaining({ code: 'principal_unauthorized' }))
    expect(() => ctx.experiences.getRetrievalProjection({
      kind: 'restricted-runtime', runtimeKind: 'agent', runtimeId: 'agent-test',
    })).toThrow(expect.objectContaining({ code: 'principal_unauthorized' }))
    expect(() => ctx.experiences.dismissSuggestion({
      commandId: 'dismiss-restricted', suggestionGroupId: 'suggestion-group:none',
      expectedRevisionDigest: `sha256:${'a'.repeat(64)}`, reviewDigest: null,
      reasonCode: 'not_reusable', issuedAt: '2026-09-10T08:00:00.000Z',
    }, {
      kind: 'restricted-runtime', runtimeKind: 'agent', runtimeId: 'agent-test',
    })).toThrow(expect.objectContaining({ code: 'principal_unauthorized' }))
    await expect(ctx.experiences.inspectProposalSource(
      {
        episode: { sessionId: 'session-test' },
        requestedKind: 'diagnostic',
        outputTokenLimit: { mode: 'configured_default' },
        requestedTriggerKind: 'terminal_success',
      },
      { kind: 'restricted-runtime', runtimeKind: 'agent', runtimeId: 'agent-test' },
    )).rejects.toMatchObject({ code: 'principal_unauthorized' })
    await fiber.dispose()
    expect(transportDisposed).toBe(true)
    const canonical = new DatabaseSync(path)
    expect(canonical.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    expect(canonical.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'suggestion_%'",
    ).all()).toEqual([])
    canonical.close()

    const second = new Context()
    second.provide('sessions', {} as never)
    second.provide('sessionQuery', emptySessionQuery() as never)
    const restarted = second.plugin(Experiences, serviceConfig(path))
    await restarted.await()
    await expect.poll(() => second.experiences.getSuggestionProjection({ kind: 'management-cli' }).state).toBe('ready')
    expect(second.experiences.getStatus({ kind: 'management-cli' })).toMatchObject({
      candidateCount: 0,
      versionCount: 0,
    })
    expect(second.experiences.getSuggestionProjection({ kind: 'management-cli' })).toMatchObject({
      generation: 1, state: 'ready', sessions: [], seeds: [],
      latestReceipt: { status: 'activated' },
    })
    expect(second.experiences.getRetrievalProjection({ kind: 'management-cli' })).toMatchObject({
      manifest: { generation: 1, state: 'lexical_ready', provider: 'disabled' }, documents: [],
    })
    await restarted.dispose()
  })
  it('returns a durable save receipt while a notified task read is stalled, then reconciles retrieval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-save-during-scan-'))
    cleanup.push(directory)
    const path = join(directory, 'experience.sqlite')
    const store = await ExperienceProjectionStore.open(path)
    const group = suggestionGroup('save-during-history')
    const seed: ExperienceSuggestionSeedView = {
      occurrenceId: 'seed:save-during-history', sessionId: 'session:save-during-history',
      workspaceRoot: null, episodeRef: group.occurrences[0]!.episodeRef,
      suggestedKinds: ['diagnostic'], triggerKind: 'high_cost_resolution',
      stableKernel: { taskGoal: group.title, toolSequence: [], failedToolSequence: [],
        recoveryToolSequence: [], failureCodes: [], verifierTools: [] },
      evidenceSignals: [], detectorVersion: 'detector-v1', segmenterVersion: 'segmenter-v1',
      detectedAt: '2026-10-02T00:00:00.000Z', expiresAt: group.expiresAt,
    }
    store.rebuild({
      projectorVersion: 'existing-generation', sourceWatermarkDigest: 'sha256:' + 'a'.repeat(64),
      sessions: [{ sessionId: seed.sessionId, workspaceRoot: null,
        sessionCreatedAt: seed.detectedAt, lastEventAt: seed.detectedAt,
        capturedThroughSeq: 2, lastCompletedEndSeq: 2, state: 'processed', reason: null,
        occurrenceIds: [seed.occurrenceId] }], seeds: [seed], groups: [group],
      startedAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T00:00:01.000Z',
    })
    store.close()
    const ctx = new Context()
    const history = Promise.withResolvers<void>()
    const scanStarted = Promise.withResolvers<void>()
    const query = emptySessionQuery()
    query.listSessions = async () => { throw new Error('history enumeration must not run') }
    query.observeSession = async () => { scanStarted.resolve(); await history.promise; throw new Error('observed task unavailable') }
    ctx.provide('sessions', {} as never)
    ctx.provide('sessionQuery', query as never)
    const fiber = ctx.plugin(Experiences, serviceConfig(path))
    await fiber.await()
    ctx.emit('session/event', {id:'notified-task'} as never, {type:'turn/end',seq:2,time:Date.now(),data:{turn:1,reason:{kind:'completed'}}} as never)
    await scanStarted.promise
    const owner = { kind: 'management-cli' as const }
    const input = {
      commandId: brandedId<'ExperienceCommandId'>('save-while-history-stalled', 'commandId'), suggestionGroupId: group.suggestionGroupId,
      expectedRevisionDigest: group.revisionDigest, reviewDigest: group.reviewDigest!,
      sourceDigest: group.sourceDigest, correlationId: 'save-history-integration', causationId: null,
      issuedAt: '2026-10-02T00:00:02.000Z',
    }
    try {
      const saved = ctx.experiences.saveExperienceSuggestion(input, owner)
      const result = await Promise.race([
        saved.then(receipt => ({ receipt })),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
      ])
      expect(result).not.toBeNull()
      const receipt = result!.receipt
      expect(ctx.experiences.getStatus(owner)).toMatchObject({ candidateCount: 0, versionCount: 1 })
      expect(ctx.experiences.getReceipt(receipt.receiptId, owner)).toEqual(receipt)
      expect(ctx.experiences.getSuggestionProjection(owner).groups).toEqual([])
      history.resolve()
      await expect.poll(() => ctx.experiences.getRetrievalProjection(owner).documents.length).toBe(1)
      await fiber.dispose()
      const db = new DatabaseSync(path)
      expect(db.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM experience_versions').get()).toEqual({ n: 1 })
      db.close()
    } finally {
      history.resolve()
      await fiber.dispose()
    }
  })

})

function emptySessionQuery() {
  return {
    observeSession: async () => { throw new Error('session not found') },
    listSessions: async () => [],
    listEvents: async () => [],
    readSession: async () => { throw new Error('session not found') },
    readEvent: async () => { throw new Error('event not found') },
  }
}

function serviceConfig(path: string): Config {
  return {
      databasePath: path,
      journalMode: 'wal',
      synchronous: 'normal',
      busyTimeoutMs: 50,
      maxPendingWrites: 8,
      ...localEmbeddingDisabled,
      maxRecords: 96,
      maxRecordBytes: 8_192,
      maxTotalBytes: 262_144,
      maxEvidenceItems: 64,
      maxEvidenceItemBytes: 4_096,
      maxEvidencePacketBytes: 65_536,
      maxInlineFieldBytes: 16_384,
      maxMarkdownProjectionBytes: 262_144,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
      maxTokens: 8_192,
      maxModelInputBytes: 98_304,
      historicalSourceRecords: [],
      retrievalCandidateLimit: 32,
      observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000,
      planningHistoryLimit: 20,
      taskFingerprintProposalMode: 'deterministic',
      taskFingerprintMaxTokens: 1_024,
      maxPlanningTaskBytes: 32_768,
      admissionClaimLeaseMs: 30_000,
      ...automationDefaults,
      defaultTargetExposure: 'local',
      defaultRiskClass: 'standard',
      defaultMustUseExperience: false,
      verificationTimeoutMs: 15_000,
      learningPollIntervalMs: 1_000,
      learningClaimLeaseMs: 30_000,
      learningRetryDelayMs: 5_000,
      learningBatchSize: 32,
    } as unknown as Config
}

function suggestionGroup(label: string, exactSource = sourceRef): ExperienceSuggestionGroupView {
  const draft = workflowDraft({
    components: workflowDraft().components.map(component => ({
      ...component,
      sourceRefs: [exactSource.sourceRefId],
    })),
    fieldSourceRefs: Object.fromEntries(Object.entries(workflowDraft().fieldSourceRefs)
      .map(([field]) => [field, [exactSource.sourceRefId]])),
    excludedSteps: workflowDraft().excludedSteps.map(step => ({
      ...step,
      sourceRefs: [exactSource.sourceRefId],
    })),
  })
  const kernelIdentity = experienceKernelIdentity({
    kind: draft.proposedKind,
    scope: draft.scope,
    components: draft.components,
  })
  const sourceDigest = suggestionDigest([exactSource.contentDigest])
  const base: ExperienceSuggestionGroupView = {
    suggestionGroupId: `suggestion-group:${kernelIdentity.slice('sha256:'.length)}`,
    kernelIdentity,
    revisionDigest: '',
    sourceDigest,
    kind: 'diagnostic',
    title: draft.title,
    draft,
    saveReadiness: 'ready',
    readinessReasons: [],
    missingFields: [],
    riskFlags: ['current_permission_required', 'tool_side_effects_not_authorized'],
    reviewDigest: null,
    consolidation: 'distinct',
    relatedGroupIds: [],
    occurrences: [{
      occurrenceId: `occurrence:${label}`,
      seedOccurrenceId: `seed:${label}`,
      sessionId: `session:${label}`,
      episodeRef: { ...episodeRef, episodeRefId: `episode:${label}` as never, sessionOrRunId: `session:${label}` },
      sourceRefs: [exactSource],
      detectedAt: '2099-01-01T00:00:00.000Z',
      expiresAt: '2099-01-15T00:00:00.000Z',
    }],
    occurrenceCount: 1,
    sessionIds: [`session:${label}`],
    crossSession: false,
    detectorVersions: ['detector-v1'],
    segmenterVersions: ['segmenter-v1'],
    materializerVersion: 'materializer-v1',
    expiresAt: '2099-01-15T00:00:00.000Z',
  }
  return { ...base, ...suggestionDecisionDigests(base) }
}
