import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  embeddingInferenceOptions,
  TransformersLocalEmbeddingProvider,
  type LocalEmbeddingConfig,
} from '../src/adapters/local-embedding.js'
import {
  embeddingSettings,
  ExperienceRetrievalProjection,
  localEmbeddingConfig,
  sameModel,
  type EmbeddingProviderPort,
} from '../src/application/retrieval-projection.js'
import { projectExperienceVersion, projectTaskFingerprint } from '../src/domain/retrieval-projector.js'
import { suggestionDigest } from '../src/domain/automatic-suggestion.js'
import { ExperienceError } from '../src/errors.js'
import { brandedId } from '../src/ids.js'
import { ExperienceProjectionStore } from '../src/persistence/projection-store.js'
import { RuntimeSettingsSchema } from '../src/runtime-settings-schema.js'
import type { RuntimeSettingsSnapshot } from '../src/runtime-settings.js'
import type { RuntimeSettings } from '../src/runtime-settings-schema.js'
import type { ActorView, ExperienceVersionView, PublishedComponentView, TaskFingerprintView } from '../src/types.js'

const cleanup: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('E3 symmetric retrieval projection', () => {
  it('maps published Versions and task fingerprints through one field vocabulary', () => {
    const document = projectExperienceVersion(version())
    const query = projectTaskFingerprint(fingerprint())

    expect(document.projectionVersion).toBe(query.projectionVersion)
    expect(document.fields.taskFamily).toContain('application_startup')
    expect(query.fields.taskFamily).toEqual(['application_startup'])
    expect(document.fields.capabilitiesOrTools.join(' ')).toContain('pnpm build')
    expect(query.fields.capabilitiesOrTools).toContain('shell')
    expect(document.lexicalText).not.toBe(document.denseText)
    expect(query.lexicalText).not.toBe(query.denseText)
    expect(document.lexicalText).toContain('typeSpecific: verifier: 读取 authenticated RPC')
    expect(document.denseText).toContain('goalOrIntent: 启动本地 Web')
    expect(query.denseText).toContain('goalOrIntent: 启动本地 Web 并验证 RPC')
    expect(document.denseText.indexOf('goalOrIntent:')).toBeLessThan(document.denseText.indexOf('taskFamily:'))
    expect(document.denseText).toContain('verifier: 读取 authenticated RPC')
  })

  it('deduplicates and bounds dense input while preserving anchor, action, failure, and verifier facets', () => {
    const long = version()
    const document = projectExperienceVersion({
      ...long,
      components: [
        ...long.components,
        ...Array.from({ length: 80 }, (_, index) => component(
          `tail-${String(index)}`, 'positive_example', `重复低优先级说明 ${'很长'.repeat(80)}`,
        )),
        component('failure', 'failure_branch', '遇到 ENOENT 必须停止'),
      ],
    })

    expect(document.lexicalText.length).toBeGreaterThan(document.denseText.length)
    expect(document.denseText.length).toBeLessThanOrEqual(2_048)
    expect(document.denseText).toContain('启动本地 Web')
    expect(document.denseText).toContain('pnpm build')
    expect(document.denseText).toContain('ENOENT')
    expect(document.denseText).toContain('authenticated RPC')
    expect(document.denseText.match(/重复低优先级说明/gu)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('publishes complete dense generations atomically, hides vectors, and never mixes dimensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-retrieval-store-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const document = projectExperienceVersion(version())
    const first = store.rebuildRetrieval(build(document, new Float32Array([0.6, 0.8])))

    expect(first).toMatchObject({
      projectionKey: 'experience-retrieval-v1',
      manifest: { generation: 1, state: 'dense_ready', documentCount: 1, vectorCount: 1, dimension: 2 },
      documents: [{ documentId: document.documentId }],
    })
    expect(JSON.stringify(first)).not.toContain('[0.6000000238418579,0.800000011920929]')
    expect(store.readRetrievalInternal().vectors.get(document.documentId)).toEqual(new Float32Array([0.6, 0.8]))

    expect(() => store.rebuildRetrieval(build(document, new Float32Array([1]))))
      .toThrowError(expect.objectContaining({ code: 'embedding_wrong_dimension' }))
    expect(store.readRetrieval().manifest.generation).toBe(1)
    expect(() => store.rebuildRetrieval({
      ...build(document, null),
      provider: 'invalid-runtime-provider',
    } as never)).toThrowError(expect.objectContaining({ code: 'invalid_command' }))
    expect(() => store.rebuildRetrieval({
      ...build(document, null),
      documents: [{ ...document, contentDigest: 'sha256:' + '0'.repeat(64) }],
    })).toThrowError(expect.objectContaining({ code: 'invalid_command' }))
    expect(store.readRetrieval().manifest.generation).toBe(1)
    const second = store.rebuildRetrieval({
      ...build(document, null),
      providerState: 'unavailable',
      failureCode: 'embedding_timeout',
      builtAt: '2026-09-10T08:01:00.000Z',
    })
    expect(second.manifest).toMatchObject({ generation: 2, state: 'lexical_ready', vectorCount: 0 })
    expect(store.handle.prepare('SELECT count(*) AS count FROM retrieval_generations').get()).toEqual({ count: 2 })
    store.close()
  })

  it('migrates the sidecar to schema 5 and keeps owner decisions while retiring a valid retrieval v1 snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-retrieval-upgrade-'))
    cleanup.push(directory)
    const path = join(directory, 'experience.sqlite')
    const store = await ExperienceProjectionStore.open(path)
    const sidecarPath = store.path
    const legacyComposite = {
      suggestionGroupId: 'suggestion-group:legacy',
      kernelIdentity: 'sha256:' + '1'.repeat(64),
      occurrences: [{ occurrenceId: 'occurrence:composite' }],
      consolidationDetail: {
        sourceGroups: [
          {
            suggestionGroupId: 'suggestion-group:source-a',
            kernelIdentity: 'sha256:' + '4'.repeat(64),
            revisionDigest: 'sha256:' + '5'.repeat(64),
            occurrenceIds: ['occurrence:a'],
          },
          {
            suggestionGroupId: 'suggestion-group:source-b',
            kernelIdentity: 'sha256:' + '6'.repeat(64),
            revisionDigest: 'sha256:' + '7'.repeat(64),
            occurrenceIds: ['occurrence:b'],
          },
        ],
      },
    }
    store.handle.prepare(
      `INSERT INTO suggestion_groups (generation, group_id, kernel_identity, expires_at, payload_json)
       VALUES (0, ?, ?, ?, ?)`,
    ).run(
      legacyComposite.suggestionGroupId,
      legacyComposite.kernelIdentity,
      '2099-09-10T08:00:00.000Z',
      JSON.stringify(legacyComposite),
    )
    store.handle.prepare(
      `INSERT INTO suggestion_dispositions
        (group_id, kernel_identity, decision, command_id, actor_id, scope_digest,
         occurrence_ids_json, input_digest, decided_at, expires_at, projection_receipt_id, target_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'suggestion-group:legacy', 'sha256:' + '1'.repeat(64), 'dismissed', 'command:legacy', 'actor:legacy',
      'sha256:' + '2'.repeat(64), '[]', 'sha256:' + '3'.repeat(64),
      '2026-09-10T08:00:00.000Z', '2099-09-10T08:00:00.000Z', 'receipt:legacy', null,
    )
    store.close()
    const legacyStable = {
      schemaVersion: 'experience-retrieval-projection-manifest-v1',
      projectionVersion: 'experience-retrieval-projector-v1',
      state: 'lexical_ready', provider: 'disabled', providerState: 'disabled',
      modelId: null, modelRevision: null, artifactSha256: null, dimension: null,
      dtype: null, pooling: null, queryPrefix: null, passagePrefix: null,
      operationSettingsRevision: null, operationSettingsDigest: suggestionDigest({ provider: 'disabled' }),
      sourceWatermarkDigest: suggestionDigest([]), documentCount: 0, vectorCount: 0, failureCode: null,
    }
    const legacy = {
      ...legacyStable, generation: 0,
      contentDigest: suggestionDigest({ manifest: legacyStable, documents: [] }),
      builtAt: '2026-09-10T08:00:00.000Z',
    }
    const handle = new DatabaseSync(sidecarPath)
    handle.prepare('UPDATE retrieval_generations SET content_digest = ?, payload_json = ? WHERE generation = 0')
      .run(legacy.contentDigest, JSON.stringify(legacy))
    handle.exec(`
      ALTER TABLE suggestion_dispositions RENAME TO suggestion_dispositions_v5;
      CREATE TABLE suggestion_dispositions (
        group_id TEXT PRIMARY KEY,
        kernel_identity TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('dismissed','saved_new_experience','attached_as_evidence')),
        command_id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        occurrence_ids_json TEXT NOT NULL CHECK (json_valid(occurrence_ids_json)),
        input_digest TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        projection_receipt_id TEXT NOT NULL,
        target_ref TEXT
      ) STRICT;
      INSERT INTO suggestion_dispositions SELECT * FROM suggestion_dispositions_v5;
      DROP TABLE suggestion_dispositions_v5;
      PRAGMA user_version = 4;
    `)
    handle.close()

    const reopened = await ExperienceProjectionStore.open(path)
    expect(reopened.handle.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
    expect(reopened.handle.prepare(
      "SELECT COUNT(*) AS count FROM pragma_index_list('suggestion_dispositions') WHERE [unique] = 1 AND origin = 'u'",
    ).get()).toEqual({ count: 0 })
    const projection = reopened.read()
    expect(projection.schemaVersion).toBe(5)
    expect(projection.groups).toEqual([])
    expect(projection.dispositions.map(disposition => ({
      suggestionGroupId: disposition.suggestionGroupId,
      commandId: disposition.commandId,
      occurrenceIds: disposition.occurrenceIds,
    }))).toEqual([
      {
        suggestionGroupId: 'suggestion-group:legacy',
        commandId: 'command:legacy',
        occurrenceIds: [],
      },
      {
        suggestionGroupId: 'suggestion-group:source-a',
        commandId: 'command:legacy',
        occurrenceIds: ['occurrence:a'],
      },
      {
        suggestionGroupId: 'suggestion-group:source-b',
        commandId: 'command:legacy',
        occurrenceIds: ['occurrence:b'],
      },
    ])
    expect(reopened.readRetrieval()).toMatchObject({
      schemaVersion: 2,
      manifest: {
        schemaVersion: 'experience-retrieval-projection-manifest-v2',
        projectionVersion: 'experience-retrieval-projector-v2',
        state: 'lexical_ready', provider: 'disabled', documentCount: 0,
      },
      documents: [],
    })
    reopened.close()
  })

  it('uses one immutable settings snapshot and degrades model failures to an explicit lexical generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-retrieval-coordinator-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    let current = settings('transformers_js', 2)
    const provider = fakeProvider(new Float32Array([0.6, 0.8]))
    const projection = new ExperienceRetrievalProjection(
      { listActiveVersionsForProjection: () => [version()] },
      store,
      actor(),
      () => current,
      provider,
    )

    const dense = await projection.rebuild()
    expect(provider.embedBatch).toHaveBeenCalledTimes(1)
    expect(dense.manifest).toMatchObject({
      state: 'dense_ready', providerState: 'ready', modelId: 'test/e5-small', dimension: 2,
    })
    current = settings('transformers_js', 3)
    provider.embedBatch.mockRejectedValueOnce(
      new ExperienceError('embedding_wrong_dimension', 'wrong test dimension'),
    )
    const fallback = await projection.rebuild()
    expect(fallback.manifest).toMatchObject({
      generation: dense.manifest.generation + 1,
      state: 'lexical_ready',
      providerState: 'unavailable',
      dimension: 3,
      failureCode: 'embedding_wrong_dimension',
    })
    expect(store.readRetrievalInternal().vectors.size).toBe(0)
    await projection.dispose()
    expect(provider.dispose).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('keeps the default installation lexical-only without invoking a model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-retrieval-disabled-'))
    cleanup.push(directory)
    const store = await ExperienceProjectionStore.open(join(directory, 'experience.sqlite'))
    const provider = fakeProvider(new Float32Array([1, 0]))
    const projection = new ExperienceRetrievalProjection(
      { listActiveVersionsForProjection: () => [version()] }, store, actor(),
      () => settings('disabled', 2), provider,
    )
    const result = await projection.rebuild()
    expect(provider.embedBatch).not.toHaveBeenCalled()
    expect(result.manifest).toMatchObject({
      state: 'lexical_ready', provider: 'disabled', providerState: 'disabled', failureCode: null,
    })
    expect(result.documents).toHaveLength(1)
    store.close()
  })

  it('fails locally with a typed missing-artifact error before loading any model runtime', async () => {
    const provider = new TransformersLocalEmbeddingProvider()
    const config: LocalEmbeddingConfig = {
      provider: 'transformers_js', modelPath: '/path/that/does/not/exist',
      modelId: 'test/e5-small', revision: 'revision-1', artifactPath: 'onnx/model_quantized.onnx',
      artifactSha256: 'a'.repeat(64), artifactBytes: 10, dimension: 2,
      dtype: 'q8', pooling: 'mean', queryPrefix: 'query: ', passagePrefix: 'passage: ', timeoutMs: 1_000,
      tokenizerConfigBundleSha256: 'b'.repeat(64), normalization: 'l2', maxInputTokens: 512,
      truncationPolicy: 'truncate_end',
    }
    await expect(provider.embedBatch('request-1', ['中文 mixed ENOENT'], 'query', config))
      .rejects.toMatchObject({ code: 'embedding_artifact_missing' })
  })

  it('delegates text inference to an isolated worker instead of loading native image dependencies in the Host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-embedding-worker-'))
    cleanup.push(directory)
    await writeModelFixture(directory)
    const worker = {
      embed: vi.fn(async () => [[1, 0]]),
      dispose: vi.fn(async () => undefined),
    }
    const provider = new TransformersLocalEmbeddingProvider(worker)
    const config: LocalEmbeddingConfig = {
      provider: 'transformers_js', modelPath: directory, modelId: 'test/e5', revision: 'r1',
      artifactPath: 'onnx/model.onnx',
      artifactSha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      artifactBytes: 1, dimension: 2, dtype: 'q8', pooling: 'mean',
      queryPrefix: 'query: ', passagePrefix: 'passage: ', timeoutMs: 5_000,
      tokenizerConfigBundleSha256: MODEL_BUNDLE_SHA256, normalization: 'l2', maxInputTokens: 512,
      truncationPolicy: 'truncate_end',
    }

    const result = await provider.embedBatch('isolated-1', ['中文文本'], 'query', config)

    expect(worker.embed).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'isolated-1', texts: ['query: 中文文本'] }),
      expect.any(AbortSignal),
    )
    expect(result.vectors).toEqual([new Float32Array([1, 0])])
    await provider.dispose()
    expect(worker.dispose).toHaveBeenCalledOnce()
  })

  it('serializes shared background and foreground inference through one local pipeline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-embedding-serialized-'))
    cleanup.push(directory)
    await writeModelFixture(directory)
    let active = 0
    let maximumActive = 0
    const worker = {
      embed: vi.fn(async (request: { readonly texts: readonly string[] }) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>(resolve => { setImmediate(resolve) })
      active -= 1
        return request.texts.map(() => [1, 0])
      }),
      dispose: vi.fn(async () => undefined),
    }
    const provider = new TransformersLocalEmbeddingProvider(worker)
    const config: LocalEmbeddingConfig = {
      provider: 'transformers_js', modelPath: directory, modelId: 'test/e5', revision: 'r1',
      artifactPath: 'onnx/model.onnx',
      artifactSha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      artifactBytes: 1,
      dimension: 2, dtype: 'q8', pooling: 'mean', queryPrefix: 'query: ', passagePrefix: 'passage: ',
      timeoutMs: 5_000, tokenizerConfigBundleSha256: MODEL_BUNDLE_SHA256,
      normalization: 'l2', maxInputTokens: 512, truncationPolicy: 'truncate_end',
    }
    const [passage, query] = await Promise.all([
      provider.embedBatch('background-index', ['passage'], 'passage', config),
      provider.embedBatch('foreground-query', ['query'], 'query', config),
    ])
    expect(maximumActive).toBe(1)
    expect(passage.receipt.role).toBe('passage')
    expect(query.receipt.role).toBe('query')
  })

  it('fails closed before inference when tokenizer/config identity drifts or configured max exceeds declarations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-embedding-bundle-'))
    cleanup.push(directory)
    await writeModelFixture(directory)
    const worker = { embed: vi.fn(async () => [[1, 0]]), dispose: vi.fn(async () => undefined) }
    const provider = new TransformersLocalEmbeddingProvider(worker)
    const base = localConfig(directory)

    await expect(provider.embedBatch('bundle-drift', ['text'], 'query', {
      ...base, tokenizerConfigBundleSha256: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'embedding_model_drift' })
    await expect(provider.embedBatch('max-drift', ['text'], 'query', {
      ...base, maxInputTokens: 513,
    })).rejects.toMatchObject({ code: 'embedding_model_drift' })
    expect(worker.embed).not.toHaveBeenCalled()
  })

  it('binds normalization and truncation to the embedding receipt and worker options', () => {
    const options = embeddingInferenceOptions({
      ...localConfig('/tmp/model'), maxInputTokens: 384,
    })
    expect(options).toEqual({ pooling: 'mean', normalize: true, truncation: true, max_length: 384 })
  })

  it('moves settings and receipt identity for every normalization/tokenization boundary', async () => {
    const snapshot = settings('transformers_js', 2)
    const config = localEmbeddingConfig(snapshot)
    const result = await fakeProvider(new Float32Array([1, 0])).embedBatch('identity', ['text'], 'query', config)
    const variants: LocalEmbeddingConfig[] = [
      { ...config, tokenizerConfigBundleSha256: 'c'.repeat(64) },
      { ...config, maxInputTokens: 384 },
      { ...config, truncationPolicy: 'truncate_end', passagePrefix: 'passage-v2: ' },
      { ...config, normalization: 'none' } as never,
      { ...config, truncationPolicy: 'truncate_start' } as never,
    ]

    expect(sameModel(result, config, 'query')).toBe(true)
    for (const variant of variants) {
      expect(sameModel(result, variant, 'query')).toBe(false)
      expect(suggestionDigest(embeddingSettings({ ...snapshot, values: {
        ...snapshot.values,
        embeddingTokenizerConfigBundleSha256: variant.tokenizerConfigBundleSha256,
        embeddingMaxInputTokens: variant.maxInputTokens,
        embeddingPassagePrefix: variant.passagePrefix,
        embeddingNormalization: variant.normalization,
        embeddingTruncationPolicy: variant.truncationPolicy,
      } }))).not.toBe(suggestionDigest(embeddingSettings(snapshot)))
    }
  })
})

function build(document: ReturnType<typeof projectExperienceVersion>, vector: Float32Array | null) {
  return {
    projectionVersion: 'experience-retrieval-projector-v2' as const,
    sourceWatermarkDigest: 'sha256:' + '1'.repeat(64),
    operationSettingsRevision: 1,
    operationSettingsDigest: 'sha256:' + '2'.repeat(64),
    provider: 'transformers_js' as const,
    providerState: vector === null ? 'unavailable' as const : 'ready' as const,
    model: {
      modelId: 'test/e5-small', modelRevision: 'revision-1', artifactSha256: 'a'.repeat(64),
      dimension: 2, dtype: 'q8' as const, pooling: 'mean' as const,
      queryPrefix: 'query: ', passagePrefix: 'passage: ',
      tokenizerConfigBundleSha256: 'b'.repeat(64), normalization: 'l2' as const,
      maxInputTokens: 512, truncationPolicy: 'truncate_end' as const,
    },
    documents: [document],
    vectors: vector === null ? null : [vector],
    failureCode: vector === null ? 'embedding_provider_unavailable' as const : null,
    builtAt: '2026-09-10T08:00:00.000Z',
  }
}

function settings(provider: 'disabled' | 'transformers_js', dimension: number): RuntimeSettingsSnapshot {
  const defaults = RuntimeSettingsSchema({} as RuntimeSettings)
  const values = RuntimeSettingsSchema({
    ...defaults,
    embeddingProvider: provider,
    embeddingModelPath: '/tmp/test-e5-small',
    embeddingModelId: 'test/e5-small',
    embeddingModelRevision: 'revision-1',
    embeddingArtifactPath: 'onnx/model_quantized.onnx',
    embeddingArtifactSha256: 'a'.repeat(64),
    embeddingArtifactBytes: 10,
    embeddingDimension: dimension,
    embeddingTokenizerConfigBundleSha256: 'b'.repeat(64),
    embeddingNormalization: 'l2',
    embeddingMaxInputTokens: 512,
    embeddingTruncationPolicy: 'truncate_end',
  })
  return { revision: dimension, digest: 'sha256:' + String(dimension).repeat(64), values }
}

function fakeProvider(vector: Float32Array) {
  const embedBatch = vi.fn<EmbeddingProviderPort['embedBatch']>(async (requestId, texts, role, config) => ({
    vectors: texts.map(() => vector),
    receipt: {
      receiptId: 'embedding-receipt:test', requestId,
      providerSchemaVersion: 'experience-embedding-provider-v2',
      modelIdentity: {
        provider: 'transformers_js', modelId: config.modelId, revision: config.revision,
        artifactSha256: config.artifactSha256, artifactBytes: config.artifactBytes,
        dimension: config.dimension, dtype: config.dtype, pooling: config.pooling,
        queryPrefix: config.queryPrefix, passagePrefix: config.passagePrefix,
        tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
        normalization: config.normalization, maxInputTokens: config.maxInputTokens,
        truncationPolicy: config.truncationPolicy,
      },
      role, inputCount: texts.length, dimension: config.dimension,
      createdAt: '2026-09-10T08:00:00.000Z',
    },
  }))
  return { embedBatch, dispose: vi.fn(async () => undefined) }
}

const MODEL_CONFIG = '{"max_position_embeddings":512}'
const MODEL_TOKENIZER = '{"test":"tokenizer"}'
const MODEL_TOKENIZER_CONFIG = '{"model_max_length":512}'
const MODEL_BUNDLE_SHA256 = 'cf67744d3fd37513d94bb977625c0da5e4dd0cef4fae78b0e7eb406182bdc6ac'

async function writeModelFixture(directory: string): Promise<void> {
  await mkdir(join(directory, 'onnx'))
  await writeFile(join(directory, 'onnx/model.onnx'), 'a')
  await writeFile(join(directory, 'config.json'), MODEL_CONFIG)
  await writeFile(join(directory, 'tokenizer.json'), MODEL_TOKENIZER)
  await writeFile(join(directory, 'tokenizer_config.json'), MODEL_TOKENIZER_CONFIG)
}

function localConfig(modelPath: string): LocalEmbeddingConfig {
  return {
    provider: 'transformers_js', modelPath, modelId: 'test/e5', revision: 'r1',
    artifactPath: 'onnx/model.onnx',
    artifactSha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    artifactBytes: 1, dimension: 2, dtype: 'q8', pooling: 'mean',
    queryPrefix: 'query: ', passagePrefix: 'passage: ', timeoutMs: 5_000,
    tokenizerConfigBundleSha256: MODEL_BUNDLE_SHA256, normalization: 'l2', maxInputTokens: 512,
    truncationPolicy: 'truncate_end',
  }
}

function actor(): ActorView {
  return {
    actorId: brandedId<'ExperienceActorId'>('actor-owner', 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('principal-owner', 'principalId'),
    kind: 'management_local_owner', authority: 'owner',
  }
}

function fingerprint(): TaskFingerprintView {
  return {
    fingerprintId: brandedId<'ExperienceTaskFingerprintId'>('fingerprint-1', 'fingerprintId'),
    schemaVersion: 'task-fingerprint-v1', taskInputDigest: 'sha256:fingerprint',
    taskText: '启动本地 Web 并验证 RPC', actorRef: actor().actorId,
    intent: '启动本地 Web 并验证 RPC', taskFamily: 'application_startup', entities: ['Web'],
    expectedOutputs: ['authenticated RPC readback'], artifactKinds: ['frontend dist'],
    capabilities: ['shell'], environmentRefs: ['local-loopback'], hardConstraints: [],
    acceptanceCriteria: ['RPC is readable'], riskClass: 'standard', targetExposure: 'local',
    fieldProvenance: {}, createdAt: '2026-09-10T08:00:00.000Z',
  }
}

function version(): ExperienceVersionView {
  const components: PublishedComponentView[] = [
    component('goal', 'goal_signature', '启动本地 Web'),
    component('entry', 'entry_condition', 'frontend dist 不存在时先构建'),
    component('step', 'step', '运行 pnpm build 后启动 Web'),
    component('verifier', 'verifier', '读取 authenticated RPC'),
  ]
  return {
    experienceVersionId: brandedId<'ExperienceVersionId'>('version-1', 'versionId'),
    experienceId: brandedId<'ExperienceId'>('experience-1', 'experienceId'),
    versionNumber: 1, previousVersionId: null, kind: 'procedure', title: '启动本地 Web',
    intent: '启动本地 Web 并验证 RPC', scope: { taskFamily: 'application_startup', exposure: 'local-loopback' },
    validity: { node: '>=22' }, authoritySpec: { owner: 'local-user' }, privacyClass: 'workspace',
    riskAndEffectSpec: { risk: 'local-process' }, allowedUseModes: ['reference', 'suggest', 'guided'],
    components, componentRevisionIds: components.map(item => item.componentRevisionId),
    initialAssessmentId: brandedId<'ExperienceAssessmentId'>('assessment-1', 'assessmentId'),
    relationIds: [], createdByDecisionId: 'decision-1', evidenceGrade: 'observation_supported',
    governanceState: 'accepted', operationalState: 'conditional', legacyWarnings: [],
    contentDigest: 'sha256:version-1', createdAt: '2026-09-10T08:00:00.000Z',
  }
}

function component(key: string, role: PublishedComponentView['role'], content: string): PublishedComponentView {
  return {
    componentKey: key,
    componentId: brandedId<'ExperienceComponentId'>(`component-${key}`, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`revision-${key}`, 'componentRevisionId'),
    evidenceIds: [brandedId<'ExperienceEvidenceId'>(`evidence-${key}`, 'evidenceId')],
    role, content, sourceRefs: ['source-1'],
  }
}
