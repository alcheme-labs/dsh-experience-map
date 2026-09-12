import type { LocalEmbeddingConfig } from '../adapters/local-embedding.js'
import { suggestionDigest } from '../domain/automatic-suggestion.js'
import {
  AUTOMATIC_DENSE_APPLICABLE_KINDS,
  type DenseApplicabilityProfile,
} from '../domain/hybrid-retrieval.js'
import type { ExperienceKind } from '../domain/kind.js'

export const EQUIVALENCE_EVIDENCE_MANIFEST_SHA256 = 'ddcefc51350e4bd05f62339b457905c951f904fa1a94e45cf3e882a00cbc12e4'
export const DENSE_APPLICABILITY_EVIDENCE_SHA256 = '2ee140cf177a796f841a867a366825a2b19515ac864d84a71125913c3464dddd'
export const DENSE_APPLICABILITY_PROFILE_VERSION = 'experience-dense-applicability-profile-v1' as const
export const EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION = 'experience-equivalence-v1' as const

const CALIBRATED_MODEL_IDENTITY_DIGEST = suggestionDigest({
  provider: 'transformers_js',
  modelId: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  artifactSha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
  artifactBytes: 118_308_185,
  tokenizerConfigBundleSha256: '4fbcddc3ad44860d65318f8f0c7b8f9d49632554f41b735749fe9075f04bb133',
  normalization: 'l2',
  maxInputTokens: 512,
  truncationPolicy: 'truncate_end',
  dimension: 384,
  dtype: 'q8',
  pooling: 'mean',
  queryPrefix: 'query: ',
  passagePrefix: 'passage: ',
})

const CALIBRATED_EQUIVALENCE_PROFILES = new Set([
  `${EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION}:procedure:${CALIBRATED_MODEL_IDENTITY_DIGEST}`,
  `${EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION}:diagnostic:${CALIBRATED_MODEL_IDENTITY_DIGEST}`,
])

const CALIBRATED_APPLICABILITY_PROFILES = new Set([
  `${DENSE_APPLICABILITY_PROFILE_VERSION}:procedure:${CALIBRATED_MODEL_IDENTITY_DIGEST}`,
  `${DENSE_APPLICABILITY_PROFILE_VERSION}:diagnostic:${CALIBRATED_MODEL_IDENTITY_DIGEST}`,
])

/** Stable full model identity; local paths and timeouts do not change vector semantics. */
export function localEmbeddingModelIdentityDigest(config: LocalEmbeddingConfig): string {
  const { modelPath: _modelPath, artifactPath: _artifactPath, timeoutMs: _timeoutMs, ...identity } = config
  return suggestionDigest(identity)
}

/** Equivalence and recall have distinct per-kind calibration decisions over one model identity. */
export function semanticEquivalenceCalibrated(config: LocalEmbeddingConfig, kind: ExperienceKind): boolean {
  return CALIBRATED_EQUIVALENCE_PROFILES.has(
    `${EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION}:${kind}:${localEmbeddingModelIdentityDigest(config)}`,
  )
}

/** Return the immutable automatic-recall allow record, or null for an uncalibrated model. */
export function automaticDenseApplicabilityProfile(
  config: LocalEmbeddingConfig,
): DenseApplicabilityProfile | null {
  const modelIdentityDigest = localEmbeddingModelIdentityDigest(config)
  const allowedKinds = AUTOMATIC_DENSE_APPLICABLE_KINDS.filter(kind =>
    CALIBRATED_APPLICABILITY_PROFILES.has(
      `${DENSE_APPLICABILITY_PROFILE_VERSION}:${kind}:${modelIdentityDigest}`,
    ))
  if (allowedKinds.length === 0) return null
  return {
    profileDigest: suggestionDigest({
      profileVersion: DENSE_APPLICABILITY_PROFILE_VERSION,
      evidenceSha256: DENSE_APPLICABILITY_EVIDENCE_SHA256,
      modelIdentityDigest,
      allowedKinds,
    }),
    allowedKinds,
  }
}
