import { embeddingInferenceOptions, type EmbeddingWorkerRequest, type LocalEmbeddingConfig } from './local-embedding.js'

interface FeatureExtractor {
  (texts: readonly string[], options: ReturnType<typeof embeddingInferenceOptions>): Promise<{
    tolist(): number[][]
  }>
  dispose?(): Promise<void> | void
}

let extractor: FeatureExtractor | undefined
let loadedIdentity: string | undefined

process.on('message', value => {
  void handle(value).catch(error => {
    const requestId = requestIdentity(value)
    if (requestId === null || process.send === undefined) return
    process.send({
      type: 'error', requestId,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    })
  })
})

process.on('disconnect', () => {
  void dispose().finally(() => process.exit(0))
})

async function handle(value: unknown): Promise<void> {
  if (isDisposeRequest(value)) {
    await dispose()
    process.disconnect()
    return
  }
  if (!isEmbedRequest(value)) throw new Error('Embedding worker received an invalid request')
  const current = await load(value.config)
  const output = await current(value.texts, embeddingInferenceOptions(value.config))
  process.send?.({ type: 'result', requestId: value.requestId, vectors: output.tolist() })
}

async function load(config: LocalEmbeddingConfig): Promise<FeatureExtractor> {
  const expected = JSON.stringify({
    modelPath: config.modelPath,
    modelId: config.modelId,
    revision: config.revision,
    artifactSha256: config.artifactSha256,
    artifactBytes: config.artifactBytes,
    dimension: config.dimension,
    dtype: config.dtype,
    pooling: config.pooling,
    tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
    normalization: config.normalization,
    maxInputTokens: config.maxInputTokens,
    truncationPolicy: config.truncationPolicy,
  })
  if (extractor !== undefined && loadedIdentity === expected) return extractor
  await dispose()
  let runtime: typeof import('@huggingface/transformers')
  try {
    runtime = await import('@huggingface/transformers')
  } catch (error) {
    throw Object.assign(new Error('Optional Transformers.js runtime is not installed'), {
      code: 'embedding_provider_unavailable', cause: error,
    })
  }
  runtime.env.allowRemoteModels = false
  runtime.env.allowLocalModels = true
  const options = {
    dtype: config.dtype,
    local_files_only: true,
    session_options: {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
  } as const
  const [tokenizer, model] = await Promise.all([
    runtime.AutoTokenizer.from_pretrained(config.modelPath, options),
    runtime.AutoModel.from_pretrained(config.modelPath, options),
  ])
  extractor = new runtime.FeatureExtractionPipeline({
    task: 'feature-extraction', model, tokenizer,
  }) as unknown as FeatureExtractor
  loadedIdentity = expected
  return extractor
}

async function dispose(): Promise<void> {
  const current = extractor
  extractor = undefined
  loadedIdentity = undefined
  await current?.dispose?.()
}

function isEmbedRequest(value: unknown): value is EmbeddingWorkerRequest & { readonly type: 'embed' } {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return input.type === 'embed' && typeof input.requestId === 'string'
    && Array.isArray(input.texts) && input.texts.every(text => typeof text === 'string')
    && typeof input.config === 'object' && input.config !== null
}

function isDisposeRequest(value: unknown): value is { readonly type: 'dispose' } {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).type === 'dispose'
}

function requestIdentity(value: unknown): string | null {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).requestId === 'string'
    ? (value as Record<string, unknown>).requestId as string : null
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'embedding_provider_unavailable'
}
