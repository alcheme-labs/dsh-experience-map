/** Settings that may change without restarting the Experience Map Host plugin. */
export interface RuntimeSettings {
  readonly automaticSuggestionDetection: boolean
  readonly recentSuggestionSessionLimit: number
  readonly suggestionTtlMs: number
  readonly enrichmentMode: 'disabled' | 'on_ambiguity' | 'always'
  readonly generationRoute: 'configured_dsh_provider' | 'current_agent_model'
  readonly automaticRecall: boolean
  readonly automaticContextInjection: 'never' | 'after_current_plan_approval' | 'eligible_high_confidence'
  readonly automaticToolExecution: 'disabled' | 'when_eligible'
  readonly defaultTargetExposure: 'local' | 'public'
  readonly defaultRiskClass: 'standard' | 'medium' | 'high'
  readonly defaultMustUseExperience: boolean
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: 'off' | 'low' | 'high' | 'max'
  readonly maxTokens: number
  readonly maxModelInputBytes: number
  readonly maxRecords: number
  readonly maxRecordBytes: number
  readonly maxTotalBytes: number
  readonly maxEvidenceItems: number
  readonly maxEvidenceItemBytes: number
  readonly maxEvidencePacketBytes: number
  readonly maxInlineFieldBytes: number
  readonly maxMarkdownProjectionBytes: number
  readonly retrievalCandidateLimit: number
  readonly observationFreshnessMs: number
  readonly planApprovalTtlMs: number
  readonly planningHistoryLimit: number
  readonly taskFingerprintMaxTokens: number
  readonly maxPlanningTaskBytes: number
  readonly admissionClaimLeaseMs: number
  readonly verificationTimeoutMs: number
  readonly learningClaimLeaseMs: number
  readonly learningRetryDelayMs: number
  readonly learningBatchSize: number
  readonly embeddingProvider: 'disabled' | 'transformers_js'
  readonly embeddingModelPath: string
  readonly embeddingModelId: string
  readonly embeddingModelRevision: string
  readonly embeddingArtifactPath: string
  readonly embeddingArtifactSha256: string
  readonly embeddingArtifactBytes: number
  readonly embeddingTokenizerConfigBundleSha256: string
  readonly embeddingNormalization: 'l2'
  readonly embeddingMaxInputTokens: number
  readonly embeddingTruncationPolicy: 'truncate_end'
  readonly embeddingDimension: number
  readonly embeddingDtype: 'q8' | 'fp32' | 'fp16'
  readonly embeddingPooling: 'mean' | 'cls'
  readonly embeddingQueryPrefix: string
  readonly embeddingPassagePrefix: string
  readonly embeddingTimeoutMs: number
  /** Calibrated per configured embedding model; score alone never bypasses hard filters. */
  readonly embeddingSimilarityThreshold: number
  readonly embeddingMargin: number
  /** Candidate-only threshold for Experience equivalence; never authorizes same by itself. */
  readonly equivalenceSimilarityThreshold: number
  readonly equivalenceMargin: number
}

/** Exact public settings vocabulary used by parity tests and the Client settings card. */
export const RUNTIME_SETTINGS_KEYS = [
  'automaticSuggestionDetection',
  'recentSuggestionSessionLimit',
  'suggestionTtlMs',
  'enrichmentMode',
  'generationRoute',
  'automaticRecall',
  'automaticContextInjection',
  'automaticToolExecution',
  'defaultTargetExposure',
  'defaultRiskClass',
  'defaultMustUseExperience',
  'provider',
  'model',
  'reasoningEffort',
  'maxTokens',
  'maxModelInputBytes',
  'maxRecords',
  'maxRecordBytes',
  'maxTotalBytes',
  'maxEvidenceItems',
  'maxEvidenceItemBytes',
  'maxEvidencePacketBytes',
  'maxInlineFieldBytes',
  'maxMarkdownProjectionBytes',
  'retrievalCandidateLimit',
  'observationFreshnessMs',
  'planApprovalTtlMs',
  'planningHistoryLimit',
  'taskFingerprintMaxTokens',
  'maxPlanningTaskBytes',
  'admissionClaimLeaseMs',
  'verificationTimeoutMs',
  'learningClaimLeaseMs',
  'learningRetryDelayMs',
  'learningBatchSize',
  'embeddingProvider',
  'embeddingModelPath',
  'embeddingModelId',
  'embeddingModelRevision',
  'embeddingArtifactPath',
  'embeddingArtifactSha256',
  'embeddingArtifactBytes',
  'embeddingTokenizerConfigBundleSha256',
  'embeddingNormalization',
  'embeddingMaxInputTokens',
  'embeddingTruncationPolicy',
  'embeddingDimension',
  'embeddingDtype',
  'embeddingPooling',
  'embeddingQueryPrefix',
  'embeddingPassagePrefix',
  'embeddingTimeoutMs',
  'embeddingSimilarityThreshold',
  'embeddingMargin',
  'equivalenceSimilarityThreshold',
  'equivalenceMargin',
] as const satisfies readonly (keyof RuntimeSettings)[]

/** Reject combinations that pass field-level validation but violate total budgets. */
export function validateRuntimeSettings(value: RuntimeSettings): void {
  if (value.maxRecordBytes > value.maxTotalBytes) {
    throw new TypeError('maxRecordBytes must not exceed maxTotalBytes')
  }
  if (value.maxEvidenceItemBytes > value.maxEvidencePacketBytes) {
    throw new TypeError('maxEvidenceItemBytes must not exceed maxEvidencePacketBytes')
  }
  if (value.embeddingProvider === 'transformers_js') {
    const artifactSegments = value.embeddingArtifactPath.replaceAll('\\', '/').split('/')
    if (!(value.embeddingModelPath.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value.embeddingModelPath))) {
      throw new TypeError('embeddingModelPath must be an absolute local directory when semantic matching is enabled')
    }
    if (value.embeddingModelId.trim() === '' || value.embeddingModelRevision.trim() === '') {
      throw new TypeError('embedding model id and revision must not be empty')
    }
    if (value.embeddingArtifactPath.trim() === '' || value.embeddingArtifactPath.startsWith('/')
      || /^[A-Za-z]:[\\/]/u.test(value.embeddingArtifactPath)
      || artifactSegments.includes('..')) {
      throw new TypeError('embeddingArtifactPath must be a relative path inside the model directory')
    }
    if (!/^[a-f0-9]{64}$/u.test(value.embeddingArtifactSha256)) {
      throw new TypeError('embeddingArtifactSha256 must be a lowercase SHA-256 digest')
    }
    if (!/^[a-f0-9]{64}$/u.test(value.embeddingTokenizerConfigBundleSha256)) {
      throw new TypeError('embeddingTokenizerConfigBundleSha256 must be a lowercase SHA-256 digest')
    }
  }
}
