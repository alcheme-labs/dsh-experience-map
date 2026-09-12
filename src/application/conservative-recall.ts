import { randomUUID } from 'node:crypto'
import type { EmbeddingProviderPort } from './retrieval-projection.js'
import {
  embeddingSettings,
  localEmbeddingConfig,
  sameModel,
} from './retrieval-projection.js'
import { suggestionDigest } from '../domain/automatic-suggestion.js'
import { projectTaskFingerprint } from '../domain/retrieval-projector.js'
import type { HybridRetrievalOperation } from '../domain/hybrid-retrieval.js'
import { ExperienceError } from '../errors.js'
import type { ExperienceProjectionStore } from '../persistence/projection-store.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'
import type { TaskFingerprintView } from '../types.js'
import { automaticDenseApplicabilityProfile } from './local-semantic-calibration.js'

/** Query-side half of hybrid recall. It owns no state and captures one immutable generation. */
export class ConservativeRecall {
  private rebuildInFlight: Promise<unknown> | null = null

  constructor(
    private readonly store: Pick<ExperienceProjectionStore, 'readRetrievalInternal'>,
    private readonly embedding: EmbeddingProviderPort,
    private readonly rebuild?: () => Promise<unknown>,
  ) {}

  async prepare(
    fingerprint: TaskFingerprintView,
    runtime: RuntimeSettingsSnapshot,
    recallDecisionKey: string | null,
    signal?: AbortSignal,
  ): Promise<HybridRetrievalOperation> {
    const query = projectTaskFingerprint(fingerprint)
    let snapshot: ReturnType<ExperienceProjectionStore['readRetrievalInternal']> | null = null
    try {
      snapshot = this.store.readRetrievalInternal()
    } catch {
      // The sidecar is disposable. Canonical MiniSearch is still built inside the repository
      // snapshot, while this operation records that dense projection data was unavailable.
    }
    const embeddingConfig = runtime.values.embeddingProvider === 'transformers_js'
      ? localEmbeddingConfig(runtime) : null
    const denseApplicabilityProfile = recallDecisionKey !== null && embeddingConfig !== null
      ? automaticDenseApplicabilityProfile(embeddingConfig) : null
    const base = {
      query,
      projection: snapshot?.projection ?? null,
      vectors: snapshot?.vectors ?? new Map<string, Float32Array>(),
      denseSimilarityThreshold: runtime.values.embeddingSimilarityThreshold,
      denseMargin: runtime.values.embeddingMargin,
      denseApplicabilityProfile,
      recallDecisionKey,
    } as const
    const currentSettingsDigest = suggestionDigest(embeddingSettings(runtime))
    if (runtime.values.embeddingProvider === 'disabled') {
      if (snapshot === null || snapshot.projection.manifest.operationSettingsDigest !== currentSettingsDigest
        || snapshot.projection.manifest.provider !== 'disabled') this.scheduleRebuild()
      return {
        ...base,
        vectors: new Map<string, Float32Array>(),
        queryVector: null,
        queryEmbeddingReceiptId: null,
        denseState: 'disabled',
        denseFailureCode: null,
      }
    }
    if (snapshot === null) {
      this.scheduleRebuild()
      return unavailable(base, 'embedding_provider_unavailable')
    }
    const manifest = snapshot.projection.manifest
    if (manifest.operationSettingsDigest !== currentSettingsDigest
      || manifest.provider !== 'transformers_js'
      || manifest.modelId !== runtime.values.embeddingModelId
      || manifest.modelRevision !== runtime.values.embeddingModelRevision
      || manifest.artifactSha256 !== runtime.values.embeddingArtifactSha256
      || manifest.dimension !== runtime.values.embeddingDimension
      || manifest.dtype !== runtime.values.embeddingDtype
      || manifest.pooling !== runtime.values.embeddingPooling
      || manifest.queryPrefix !== runtime.values.embeddingQueryPrefix
      || manifest.passagePrefix !== runtime.values.embeddingPassagePrefix
      || manifest.tokenizerConfigBundleSha256 !== runtime.values.embeddingTokenizerConfigBundleSha256
      || manifest.normalization !== runtime.values.embeddingNormalization
      || manifest.maxInputTokens !== runtime.values.embeddingMaxInputTokens
      || manifest.truncationPolicy !== runtime.values.embeddingTruncationPolicy) {
      this.scheduleRebuild()
      return {
        ...base,
        vectors: new Map<string, Float32Array>(),
        queryVector: null,
        queryEmbeddingReceiptId: null,
        denseState: 'stale_generation',
        denseFailureCode: 'embedding_model_drift',
      }
    }
    if (manifest.state !== 'dense_ready' || manifest.providerState !== 'ready') {
      return unavailable(base, manifest.failureCode ?? 'embedding_provider_unavailable')
    }
    if (recallDecisionKey !== null && denseApplicabilityProfile === null) {
      return unavailable(base, 'embedding_applicability_not_calibrated')
    }
    try {
      const config = embeddingConfig!
      const result = await this.embedding.embedBatch(
        `recall:${query.contentDigest}:${randomUUID()}`,
        [query.denseText],
        'query',
        config,
        signal,
      )
      if (!sameModel(result, config, 'query') || result.vectors.length !== 1) {
        throw new ExperienceError('embedding_model_drift', 'Recall embedding receipt differs from its generation')
      }
      return {
        ...base,
        queryVector: result.vectors[0]!,
        queryEmbeddingReceiptId: result.receipt.receiptId,
        denseState: 'ready',
        denseFailureCode: null,
      }
    } catch (error) {
      return unavailable(base, error instanceof ExperienceError ? error.code : 'embedding_provider_unavailable')
    }
  }

  private scheduleRebuild(): void {
    if (this.rebuild === undefined || this.rebuildInFlight !== null) return
    const operation = this.rebuild()
    this.rebuildInFlight = operation
    void operation.finally(() => {
      if (this.rebuildInFlight === operation) this.rebuildInFlight = null
    }).catch(() => undefined)
  }
}

function unavailable(
  base: Pick<HybridRetrievalOperation,
    | 'query' | 'projection' | 'vectors' | 'denseSimilarityThreshold' | 'denseMargin'
    | 'denseApplicabilityProfile' | 'recallDecisionKey'>,
  failureCode: string,
): HybridRetrievalOperation {
  return {
    ...base,
    vectors: new Map<string, Float32Array>(),
    queryVector: null,
    queryEmbeddingReceiptId: null,
    denseState: 'unavailable',
    denseFailureCode: failureCode,
  }
}
