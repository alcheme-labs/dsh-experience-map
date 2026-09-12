import type { ExperienceRetrievalProjectionView } from '../../src/types.js'

/** Minimal valid lexical-only projection returned by Browser RPC fixtures. */
export function retrievalProjection(): ExperienceRetrievalProjectionView {
  return {
    projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
    manifest: {
      schemaVersion: 'experience-retrieval-projection-manifest-v2',
      projectionVersion: 'experience-retrieval-projector-v2', generation: 1,
      state: 'lexical_ready', provider: 'disabled', providerState: 'disabled',
      modelId: null, modelRevision: null, artifactSha256: null, dimension: null,
      dtype: null, pooling: null, queryPrefix: null, passagePrefix: null,
      tokenizerConfigBundleSha256: null, normalization: null, maxInputTokens: null, truncationPolicy: null,
      operationSettingsRevision: null, operationSettingsDigest: `sha256:${'a'.repeat(64)}`,
      sourceWatermarkDigest: `sha256:${'b'.repeat(64)}`, contentDigest: `sha256:${'c'.repeat(64)}`,
      documentCount: 0, vectorCount: 0, failureCode: null, builtAt: '2026-09-10T08:00:00.000Z',
    }, documents: [],
  }
}
