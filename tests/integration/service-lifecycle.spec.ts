import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it } from 'vitest'
import Experiences from '../../src/index.js'

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
  it('waits for required Host services, loads without Browser services, and closes on disposal', async () => {
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
    const fiber = ctx.plugin(Experiences, {
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
    })
    expect(ctx.get('experiences')).toBeUndefined()
    ctx.provide('sessions', {} as never)
    expect(ctx.get('experiences')).toBeUndefined()
    ctx.provide('sessionQuery', emptySessionQuery() as never)
    await fiber.await()
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
    const restarted = second.plugin(Experiences, {
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
    })
    await restarted.await()
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
