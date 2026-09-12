import { createHash, randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { ExperienceError } from '../errors.js'

export const EMBEDDING_PROVIDER_SCHEMA_VERSION = 'experience-embedding-provider-v2' as const

const TOKENIZER_CONFIG_BUNDLE_PATHS = ['config.json', 'tokenizer.json', 'tokenizer_config.json'] as const

export interface LocalEmbeddingModelIdentity {
  readonly provider: 'transformers_js'
  readonly modelId: string
  readonly revision: string
  readonly artifactSha256: string
  readonly artifactBytes: number
  readonly dimension: number
  readonly dtype: 'q8' | 'fp32' | 'fp16'
  readonly pooling: 'mean' | 'cls'
  readonly queryPrefix: string
  readonly passagePrefix: string
  readonly tokenizerConfigBundleSha256: string
  readonly normalization: 'l2'
  readonly maxInputTokens: number
  readonly truncationPolicy: 'truncate_end'
}

export interface LocalEmbeddingConfig extends LocalEmbeddingModelIdentity {
  readonly modelPath: string
  readonly artifactPath: string
  readonly timeoutMs: number
}

export interface EmbeddingBatchReceipt {
  readonly receiptId: string
  readonly requestId: string
  readonly providerSchemaVersion: typeof EMBEDDING_PROVIDER_SCHEMA_VERSION
  readonly modelIdentity: LocalEmbeddingModelIdentity
  readonly role: 'query' | 'passage'
  readonly inputCount: number
  readonly dimension: number
  readonly createdAt: string
}

export interface EmbeddingBatchResult {
  readonly vectors: readonly Float32Array[]
  readonly receipt: EmbeddingBatchReceipt
}

export interface EmbeddingWorkerRequest {
  readonly requestId: string
  readonly texts: readonly string[]
  readonly config: LocalEmbeddingConfig
}

export interface EmbeddingWorkerPort {
  embed(request: EmbeddingWorkerRequest, signal: AbortSignal): Promise<readonly (readonly number[])[]>
  dispose(): Promise<void>
}

export interface EmbeddingInferenceOptions {
  readonly pooling: 'mean' | 'cls'
  readonly normalize: true
  readonly truncation: true
  readonly max_length: number
}

/** Exact tokenizer options bound into the configured model identity and worker receipt. */
export function embeddingInferenceOptions(config: LocalEmbeddingConfig): EmbeddingInferenceOptions {
  return {
    pooling: config.pooling,
    normalize: true,
    truncation: true,
    max_length: config.maxInputTokens,
  }
}

/** Offline-only adapter whose native Transformers runtime is isolated from the DSH Host process. */
export class TransformersLocalEmbeddingProvider {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly worker: EmbeddingWorkerPort = new ChildProcessEmbeddingWorker()) {}

  /** Embed a bounded batch without allowing Transformers.js to contact a remote registry. */
  async embedBatch(
    requestId: string,
    texts: readonly string[],
    role: 'query' | 'passage',
    config: LocalEmbeddingConfig,
    signal?: AbortSignal,
  ): Promise<EmbeddingBatchResult> {
    validateRequest(requestId, texts, config)
    if (signal?.aborted === true) throw embeddingFailure('embedding_cancelled', 'Embedding request was cancelled')
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const operationSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const previous = this.operationTail
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    this.operationTail = previous.then(() => gate)
    try {
      // One loaded pipeline is shared by background indexing and foreground query embedding.
      // Serialize the complete inference call because ONNX pipeline calls are not a declared
      // concurrent API; queue wait is included in the same bounded operation timeout.
      await withAbort(previous, operationSignal)
      const modelPath = await withAbort(verifiedModelDirectory(config), operationSignal)
      const prefix = role === 'query' ? config.queryPrefix : config.passagePrefix
      const values = await withAbort(this.worker.embed({
        requestId,
        texts: texts.map(text => `${prefix}${text}`),
        config: { ...config, modelPath },
      }, operationSignal), operationSignal)
      const vectors = values.map(row => validateVector(row, config.dimension))
      if (vectors.length !== texts.length) {
        throw embeddingFailure('embedding_wrong_dimension', 'Embedding provider returned the wrong batch size')
      }
      return {
        vectors,
        receipt: {
          receiptId: `embedding-receipt:${randomUUID()}`,
          requestId,
          providerSchemaVersion: EMBEDDING_PROVIDER_SCHEMA_VERSION,
          modelIdentity: identity(config),
          role,
          inputCount: texts.length,
          dimension: config.dimension,
          createdAt: new Date().toISOString(),
        },
      }
    } catch (error) {
      if (error instanceof ExperienceError) throw error
      if (operationSignal.aborted) {
        const cancelledByCaller = signal !== undefined && signal.reason !== undefined
        throw embeddingFailure(
          cancelledByCaller ? 'embedding_cancelled' : 'embedding_timeout',
          cancelledByCaller ? 'Embedding request was cancelled' : 'Embedding request timed out',
        )
      }
      throw embeddingFailure('embedding_provider_unavailable', 'Local embedding provider is unavailable', error)
    } finally {
      release()
    }
  }

  /** Release the currently loaded local model. */
  async dispose(): Promise<void> {
    await this.operationTail
    await this.worker.dispose()
  }
}

interface WorkerResultMessage {
  readonly type: 'result'
  readonly requestId: string
  readonly vectors: readonly (readonly number[])[]
}

interface WorkerErrorMessage {
  readonly type: 'error'
  readonly requestId: string
  readonly code?: string
  readonly message: string
}

type WorkerResponseMessage = WorkerResultMessage | WorkerErrorMessage

class ChildProcessEmbeddingWorker implements EmbeddingWorkerPort {
  private child: ChildProcess | undefined
  private pending: {
    readonly requestId: string
    readonly resolve: (vectors: readonly (readonly number[])[]) => void
    readonly reject: (error: unknown) => void
  } | undefined
  private stderr = ''

  embed(request: EmbeddingWorkerRequest, signal: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (this.pending !== undefined) {
      return Promise.reject(new ExperienceError('internal', 'Embedding worker received concurrent requests'))
    }
    const child = this.child ?? this.start()
    return new Promise((resolveRequest, rejectRequest) => {
      const abort = (): void => {
        this.pending = undefined
        this.stop()
        rejectRequest(embeddingFailure('embedding_cancelled', 'Embedding request was cancelled'))
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending = {
        requestId: request.requestId,
        resolve: vectors => {
          signal.removeEventListener('abort', abort)
          resolveRequest(vectors)
        },
        reject: error => {
          signal.removeEventListener('abort', abort)
          rejectRequest(error)
        },
      }
      child.send({ type: 'embed', ...request }, error => {
        if (error === null) return
        const pending = this.pending
        this.pending = undefined
        pending?.reject(embeddingFailure('embedding_provider_unavailable', 'Embedding worker IPC failed', error))
      })
    })
  }

  async dispose(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
    child.send({ type: 'dispose' }, error => {
      if (error !== null) child.kill('SIGTERM')
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      exited,
      new Promise<void>(resolveTimeout => {
        timeout = setTimeout(() => {
          child.kill('SIGTERM')
          resolveTimeout()
        }, 2_000)
        timeout.unref()
      }),
    ])
    if (timeout !== undefined) clearTimeout(timeout)
  }

  private start(): ChildProcess {
    this.stderr = ''
    const child = fork(new URL('./embedding-worker.js', import.meta.url), [], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_192)
    })
    child.on('message', value => this.receive(value))
    child.on('error', error => this.fail(error))
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (this.pending === undefined) return
      this.fail(embeddingFailure(
        'embedding_provider_unavailable',
        `Embedding worker exited (${String(code ?? signal ?? 'unknown')})${this.stderr === '' ? '' : `: ${this.stderr.trim()}`}`,
      ))
    })
    this.child = child
    return child
  }

  private receive(value: unknown): void {
    if (!isWorkerResponse(value) || this.pending?.requestId !== value.requestId) return
    const pending = this.pending
    this.pending = undefined
    if (value.type === 'result') pending.resolve(value.vectors)
    else pending.reject(embeddingFailure(workerErrorCode(value.code), value.message))
  }

  private fail(error: unknown): void {
    const pending = this.pending
    this.pending = undefined
    pending?.reject(error)
  }

  private stop(): void {
    const child = this.child
    this.child = undefined
    child?.kill('SIGTERM')
  }
}

function validateRequest(requestId: string, texts: readonly string[], config: LocalEmbeddingConfig): void {
  if (requestId.trim() === '' || texts.length === 0 || texts.some(text => text.trim() === '')) {
    throw new ExperienceError('invalid_command', 'Embedding request requires non-empty identity and text')
  }
  if (!isAbsolute(config.modelPath) || config.artifactPath.trim() === '' || isAbsolute(config.artifactPath)
    || config.modelId.trim() === '' || config.revision.trim() === ''
    || !/^[a-f0-9]{64}$/u.test(config.artifactSha256)
    || !/^[a-f0-9]{64}$/u.test(config.tokenizerConfigBundleSha256)
    || !Number.isSafeInteger(config.artifactBytes) || config.artifactBytes < 1
    || !Number.isSafeInteger(config.dimension) || config.dimension < 1
    || config.normalization !== 'l2'
    || !Number.isSafeInteger(config.maxInputTokens) || config.maxInputTokens < 32
    || config.truncationPolicy !== 'truncate_end'
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1_000) {
    throw new ExperienceError('invalid_command', 'Local embedding configuration is invalid')
  }
}

async function verifiedModelDirectory(config: LocalEmbeddingConfig): Promise<string> {
  let modelDirectory: string
  let artifact: string
  try {
    modelDirectory = await realpath(config.modelPath)
    artifact = await realpath(resolve(modelDirectory, config.artifactPath))
  } catch (error) {
    throw embeddingFailure('embedding_artifact_missing', 'Configured local embedding artifact is missing', error)
  }
  const escaped = relative(modelDirectory, artifact)
  if (escaped === '..' || escaped.startsWith('../') || isAbsolute(escaped)) {
    throw new ExperienceError('invalid_command', 'Embedding artifact must stay inside the configured model directory')
  }
  const metadata = await stat(artifact)
  if (!metadata.isFile() || metadata.size !== config.artifactBytes) {
    throw embeddingFailure('embedding_artifact_digest_mismatch', 'Local embedding artifact size does not match settings')
  }
  const actual = await fileSha256(artifact)
  if (actual !== config.artifactSha256) {
    throw embeddingFailure('embedding_artifact_digest_mismatch', 'Local embedding artifact digest does not match settings')
  }
  let bundle: Array<{ readonly path: string; readonly sha256: string }>
  let modelConfig: unknown
  let tokenizerConfig: unknown
  try {
    const contents = await Promise.all(TOKENIZER_CONFIG_BUNDLE_PATHS.map(async path => {
      const candidate = await realpath(resolve(modelDirectory, path))
      ensureInside(modelDirectory, candidate, 'Embedding tokenizer/config file must stay inside the model directory')
      return { path, bytes: await readFile(candidate) }
    }))
    bundle = contents.map(({ path, bytes }) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }))
    modelConfig = JSON.parse(contents.find(value => value.path === 'config.json')!.bytes.toString('utf8'))
    tokenizerConfig = JSON.parse(contents.find(value => value.path === 'tokenizer_config.json')!.bytes.toString('utf8'))
  } catch (error) {
    throw embeddingFailure('embedding_model_drift', 'Local tokenizer/config bundle is missing or invalid', error)
  }
  const bundleDigest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
  if (bundleDigest !== config.tokenizerConfigBundleSha256) {
    throw embeddingFailure('embedding_model_drift', 'Local tokenizer/config bundle digest does not match settings')
  }
  const modelLimit = declaredPositiveInteger(modelConfig, 'max_position_embeddings')
  const tokenizerLimit = declaredPositiveInteger(tokenizerConfig, 'model_max_length')
  if (modelLimit === null || tokenizerLimit === null
    || config.maxInputTokens > modelLimit || config.maxInputTokens > tokenizerLimit) {
    throw embeddingFailure('embedding_model_drift', 'Configured embedding token limit exceeds or lacks model declarations')
  }
  return modelDirectory
}

function ensureInside(directory: string, candidate: string, message: string): void {
  const escaped = relative(directory, candidate)
  if (escaped === '..' || escaped.startsWith('../') || isAbsolute(escaped)) {
    throw new ExperienceError('invalid_command', message)
  }
}

function declaredPositiveInteger(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as Record<string, unknown>)[key]
  return Number.isSafeInteger(candidate) && (candidate as number) > 0 ? candidate as number : null
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function validateVector(values: readonly number[], expectedDimension: number): Float32Array {
  if (values.length !== expectedDimension) {
    throw embeddingFailure('embedding_wrong_dimension', 'Embedding provider returned the wrong vector dimension')
  }
  if (values.some(value => !Number.isFinite(value))) {
    throw embeddingFailure('embedding_non_finite_vector', 'Embedding provider returned a non-finite vector')
  }
  const vector = Float32Array.from(values)
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(norm) || norm < 0.999 || norm > 1.001) {
    throw embeddingFailure('embedding_model_drift', 'Embedding provider did not return normalized vectors')
  }
  return vector
}

function identity(config: LocalEmbeddingConfig): LocalEmbeddingModelIdentity {
  return {
    provider: config.provider,
    modelId: config.modelId,
    revision: config.revision,
    artifactSha256: config.artifactSha256,
    artifactBytes: config.artifactBytes,
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

function embeddingFailure(
  code: Extract<ExperienceError['code'],
    | 'embedding_provider_unavailable'
    | 'embedding_artifact_missing'
    | 'embedding_artifact_digest_mismatch'
    | 'embedding_model_drift'
    | 'embedding_timeout'
    | 'embedding_cancelled'
    | 'embedding_wrong_dimension'
    | 'embedding_non_finite_vector'>,
  message: string,
  cause?: unknown,
): ExperienceError {
  return new ExperienceError(code, message, {}, cause === undefined ? undefined : { cause })
}

function isWorkerResponse(value: unknown): value is WorkerResponseMessage {
  if (typeof value !== 'object' || value === null) return false
  const response = value as Record<string, unknown>
  if (response.type === 'result') {
    return typeof response.requestId === 'string' && Array.isArray(response.vectors)
  }
  return response.type === 'error' && typeof response.requestId === 'string'
    && typeof response.message === 'string'
}

function workerErrorCode(code: string | undefined): Extract<ExperienceError['code'],
  | 'embedding_provider_unavailable'
  | 'embedding_artifact_missing'
  | 'embedding_artifact_digest_mismatch'
  | 'embedding_model_drift'
  | 'embedding_timeout'
  | 'embedding_cancelled'
  | 'embedding_wrong_dimension'
  | 'embedding_non_finite_vector'> {
  if (code === 'embedding_artifact_missing' || code === 'embedding_artifact_digest_mismatch'
    || code === 'embedding_model_drift' || code === 'embedding_timeout'
    || code === 'embedding_cancelled' || code === 'embedding_wrong_dimension'
    || code === 'embedding_non_finite_vector') return code
  return 'embedding_provider_unavailable'
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const abort = (): void => rejectOperation(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolveOperation(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        rejectOperation(error)
      },
    )
  })
}
