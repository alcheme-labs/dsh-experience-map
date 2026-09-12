import type {
  EmbeddingBatchResult,
  LocalEmbeddingConfig,
} from '../adapters/local-embedding.js'
import { suggestionDigest } from '../domain/automatic-suggestion.js'
import {
  EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
  projectExperienceVersion,
} from '../domain/retrieval-projector.js'
import { ExperienceError, type ExperienceErrorCode } from '../errors.js'
import type { ActorView } from '../types.js'
import type { ExperienceProjectionStore } from '../persistence/projection-store.js'
import type { ExperienceRepository } from '../persistence/repository.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'

export interface EmbeddingProviderPort {
  embedBatch(
    requestId: string,
    texts: readonly string[],
    role: 'query' | 'passage',
    config: LocalEmbeddingConfig,
    signal?: AbortSignal,
  ): Promise<EmbeddingBatchResult>
  dispose(): Promise<void>
}

const EMBEDDING_FAILURES = new Set<ExperienceErrorCode>([
  'embedding_provider_unavailable',
  'embedding_artifact_missing',
  'embedding_artifact_digest_mismatch',
  'embedding_model_drift',
  'embedding_timeout',
  'embedding_cancelled',
  'embedding_wrong_dimension',
  'embedding_non_finite_vector',
])

/** Rebuild active Version documents into the existing single sidecar generation owner. */
export class ExperienceRetrievalProjection {
  constructor(
    private readonly repository: Pick<ExperienceRepository, 'listActiveVersionsForProjection'>,
    private readonly store: Pick<ExperienceProjectionStore, 'rebuildRetrieval' | 'readRetrieval'>,
    private readonly actor: ActorView,
    private readonly settings: () => RuntimeSettingsSnapshot,
    private readonly embedding: EmbeddingProviderPort,
  ) {}

  /** Capture one immutable settings snapshot and publish dense or explicit lexical fallback atomically. */
  async rebuild(signal?: AbortSignal): Promise<ReturnType<ExperienceProjectionStore['readRetrieval']>> {
    const operation = this.settings()
    const versions = this.repository.listActiveVersionsForProjection(this.actor)
    const documents = versions.map(projectExperienceVersion)
      .sort((left, right) => left.documentId.localeCompare(right.documentId))
    const sourceWatermarkDigest = suggestionDigest(documents.map(document => ({
      experienceVersionId: document.experienceVersionId,
      versionContentDigest: document.versionContentDigest,
      projectionContentDigest: document.contentDigest,
    })))
    const embeddingSettingsDigest = suggestionDigest(embeddingSettings(operation))
    const builtAt = new Date().toISOString()
    if (operation.values.embeddingProvider === 'disabled') {
      return this.store.rebuildRetrieval({
        projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
        sourceWatermarkDigest,
        operationSettingsRevision: operation.revision,
        operationSettingsDigest: embeddingSettingsDigest,
        provider: 'disabled',
        providerState: 'disabled',
        model: null,
        documents,
        vectors: null,
        failureCode: null,
        builtAt,
      })
    }
    const config = localEmbeddingConfig(operation)
    if (documents.length === 0) {
      return this.store.rebuildRetrieval({
        projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
        sourceWatermarkDigest,
        operationSettingsRevision: operation.revision,
        operationSettingsDigest: embeddingSettingsDigest,
        provider: 'transformers_js',
        providerState: 'configured',
        model: manifestModel(config),
        documents,
        vectors: null,
        failureCode: null,
        builtAt,
      })
    }
    try {
      const vectors: Float32Array[] = []
      for (let offset = 0; offset < documents.length; offset += 32) {
        const batch = documents.slice(offset, offset + 32)
        const result = await this.embedding.embedBatch(
          `retrieval:${sourceWatermarkDigest}:${String(offset)}`,
          batch.map(document => document.denseText),
          'passage',
          config,
          signal,
        )
        if (!sameModel(result, config, 'passage')) {
          throw new ExperienceError('embedding_model_drift', 'Embedding receipt differs from the captured model settings')
        }
        vectors.push(...result.vectors)
      }
      return this.store.rebuildRetrieval({
        projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
        sourceWatermarkDigest,
        operationSettingsRevision: operation.revision,
        operationSettingsDigest: embeddingSettingsDigest,
        provider: 'transformers_js',
        providerState: 'ready',
        model: manifestModel(config),
        documents,
        vectors,
        failureCode: null,
        builtAt,
      })
    } catch (error) {
      const failureCode = embeddingFailureCode(error)
      return this.store.rebuildRetrieval({
        projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
        sourceWatermarkDigest,
        operationSettingsRevision: operation.revision,
        operationSettingsDigest: embeddingSettingsDigest,
        provider: 'transformers_js',
        providerState: 'unavailable',
        model: manifestModel(config),
        documents,
        vectors: null,
        failureCode,
        builtAt,
      })
    }
  }

  async dispose(): Promise<void> {
    await this.embedding.dispose()
  }
}

export function embeddingSettings(snapshot: RuntimeSettingsSnapshot): unknown {
  const value = snapshot.values
  return {
    provider: value.embeddingProvider,
    modelPath: value.embeddingModelPath,
    modelId: value.embeddingModelId,
    revision: value.embeddingModelRevision,
    artifactPath: value.embeddingArtifactPath,
    artifactSha256: value.embeddingArtifactSha256,
    artifactBytes: value.embeddingArtifactBytes,
    tokenizerConfigBundleSha256: value.embeddingTokenizerConfigBundleSha256,
    normalization: value.embeddingNormalization,
    maxInputTokens: value.embeddingMaxInputTokens,
    truncationPolicy: value.embeddingTruncationPolicy,
    dimension: value.embeddingDimension,
    dtype: value.embeddingDtype,
    pooling: value.embeddingPooling,
    queryPrefix: value.embeddingQueryPrefix,
    passagePrefix: value.embeddingPassagePrefix,
    timeoutMs: value.embeddingTimeoutMs,
  }
}

export function localEmbeddingConfig(snapshot: RuntimeSettingsSnapshot): LocalEmbeddingConfig {
  const value = snapshot.values
  return {
    provider: 'transformers_js',
    modelPath: value.embeddingModelPath,
    modelId: value.embeddingModelId,
    revision: value.embeddingModelRevision,
    artifactPath: value.embeddingArtifactPath,
    artifactSha256: value.embeddingArtifactSha256,
    artifactBytes: value.embeddingArtifactBytes,
    tokenizerConfigBundleSha256: value.embeddingTokenizerConfigBundleSha256,
    normalization: value.embeddingNormalization,
    maxInputTokens: value.embeddingMaxInputTokens,
    truncationPolicy: value.embeddingTruncationPolicy,
    dimension: value.embeddingDimension,
    dtype: value.embeddingDtype,
    pooling: value.embeddingPooling,
    queryPrefix: value.embeddingQueryPrefix,
    passagePrefix: value.embeddingPassagePrefix,
    timeoutMs: value.embeddingTimeoutMs,
  }
}

function manifestModel(config: LocalEmbeddingConfig) {
  return {
    modelId: config.modelId,
    modelRevision: config.revision,
    artifactSha256: config.artifactSha256,
    dimension: config.dimension,
    dtype: config.dtype,
    pooling: config.pooling,
    queryPrefix: config.queryPrefix,
    passagePrefix: config.passagePrefix,
    tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
    normalization: config.normalization,
    maxInputTokens: config.maxInputTokens,
    truncationPolicy: config.truncationPolicy,
  }
}

export function sameModel(
  result: EmbeddingBatchResult,
  config: LocalEmbeddingConfig,
  role: 'query' | 'passage',
): boolean {
  const model = result.receipt.modelIdentity
  return model.provider === config.provider && model.modelId === config.modelId
    && model.revision === config.revision && model.artifactSha256 === config.artifactSha256
    && model.artifactBytes === config.artifactBytes && model.dimension === config.dimension
    && model.dtype === config.dtype && model.pooling === config.pooling
    && model.queryPrefix === config.queryPrefix && model.passagePrefix === config.passagePrefix
    && model.tokenizerConfigBundleSha256 === config.tokenizerConfigBundleSha256
    && model.normalization === config.normalization && model.maxInputTokens === config.maxInputTokens
    && model.truncationPolicy === config.truncationPolicy
    && result.receipt.dimension === config.dimension && result.receipt.role === role
}

function embeddingFailureCode(error: unknown): NonNullable<ReturnType<ExperienceProjectionStore['readRetrieval']>['manifest']['failureCode']> {
  if (error instanceof ExperienceError && EMBEDDING_FAILURES.has(error.code)) {
    return error.code as NonNullable<ReturnType<ExperienceProjectionStore['readRetrieval']>['manifest']['failureCode']>
  }
  return 'embedding_provider_unavailable'
}
