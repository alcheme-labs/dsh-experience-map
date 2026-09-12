import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import MiniSearch from 'minisearch'
import { AutoModel, AutoTokenizer, env, FeatureExtractionPipeline } from '@huggingface/transformers'
import { fingerprintTask, matchExperiences } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'

type ClassificationId = 'procedure' | 'diagnostic' | 'not_extractable'

interface Replay {
  readonly schemaVersion: string
  readonly baseCommit: string
  readonly qualityGates: {
    readonly extractionPrecision: number
    readonly extractionRecall: number
    readonly kindAccuracy: number
    readonly identityFalseMerges: number
    readonly identityRecall: number
    readonly recallHarmfulMatches: number
    readonly recallTop1Accuracy: number
    readonly warmP95Ms: number
    readonly rssDeltaMiB: number
  }
  readonly classificationPrototypes: readonly { readonly id: ClassificationId; readonly text: string }[]
  readonly sessionCases: readonly {
    readonly id: string
    readonly transcript: string
    readonly shouldExtract: boolean
    readonly kind: 'procedure' | 'diagnostic' | null
  }[]
  readonly identityCases: readonly {
    readonly id: string
    readonly left: KernelText
    readonly right: KernelText
    readonly sameExperience: boolean
  }[]
  readonly experiences: readonly ExperienceDocument[]
  readonly recallCases: readonly RecallCase[]
}

interface KernelText {
  readonly kind: 'procedure' | 'diagnostic'
  readonly scope: string
  readonly taskFamily: string
  readonly text: string
}

interface ExperienceDocument {
  readonly id: string
  readonly kind: 'procedure' | 'diagnostic'
  readonly taskFamily: string
  readonly targetExposure: 'local' | 'public'
  readonly errorCodes: readonly string[]
  readonly title: string
  readonly text: string
}

interface RecallCase {
  readonly id: string
  readonly query: string
  readonly taskFamily: string
  readonly targetExposure: 'local' | 'public'
  readonly errorCodes: readonly string[]
  readonly expectedTop1: string | null
  readonly forbiddenIds: readonly string[]
  readonly requiredNegative: boolean
}

interface Predictions {
  readonly classification: Readonly<Record<string, ClassificationId | null>>
  readonly identity: Readonly<Record<string, boolean>>
  readonly recall: Readonly<Record<string, string | null>>
}

interface QualityMetrics {
  readonly extractionPrecision: number
  readonly extractionRecall: number
  readonly kindAccuracy: number
  readonly identityFalseMerges: number
  readonly identityRecall: number
  readonly recallHarmfulMatches: number
  readonly recallTop1Accuracy: number
  readonly details: {
    readonly classificationErrors: readonly string[]
    readonly identityErrors: readonly string[]
    readonly recallErrors: readonly string[]
    readonly harmfulMatches: readonly string[]
  }
}

interface ModelDefinition {
  readonly key: 'bge-small-zh-v1.5' | 'multilingual-e5-small'
  readonly modelId: string
  readonly revision: string
  readonly baseLicense: 'MIT'
  readonly dtype: 'q8'
  readonly dimension: number
  readonly artifactSha256: string
  readonly artifactBytes: number
  readonly artifactFile: 'onnx/model_quantized.onnx'
  readonly pooling: 'cls' | 'mean'
  readonly queryPrefix: string
  readonly passagePrefix: string
  readonly similarityThreshold: number
  readonly identityThreshold: number
  readonly margin: number
}

const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    key: 'bge-small-zh-v1.5',
    modelId: 'Xenova/bge-small-zh-v1.5',
    revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    baseLicense: 'MIT',
    dtype: 'q8',
    dimension: 512,
    artifactSha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
    artifactBytes: 24_010_842,
    artifactFile: 'onnx/model_quantized.onnx',
    pooling: 'cls',
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    passagePrefix: '',
    similarityThreshold: 0.8,
    identityThreshold: 0.86,
    margin: 0.025,
  },
  {
    key: 'multilingual-e5-small',
    modelId: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    baseLicense: 'MIT',
    dtype: 'q8',
    dimension: 384,
    artifactSha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    artifactBytes: 118_308_185,
    artifactFile: 'onnx/model_quantized.onnx',
    pooling: 'mean',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    similarityThreshold: 0.76,
    identityThreshold: 0.86,
    margin: 0.025,
  },
]

const hanSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
const hanRun = /[\p{Script=Han}]+/gu
const identifierToken = /[\p{L}\p{N}_-]{2,}/gu
const aliases = new Map([['证书', 'certificate'], ['过期', 'expired'], ['超时', 'timeout']])

const repositoryRoot = process.cwd()
const replayPath = resolve(repositoryRoot, 'benchmarks/auto-e0/replay.json')
const outputPath = resolve(repositoryRoot, process.env.AUTO_E0_OUTPUT ?? 'evidence/auto/e0/benchmark-result.json')
const cacheDirectory = resolve(process.env.AUTO_E0_CACHE ?? '/private/tmp/dsh-experience-auto-e0-models')
const replay = JSON.parse(await readFile(replayPath, 'utf8')) as Replay
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
  readonly devDependencies: Readonly<Record<string, string>>
}

env.cacheDir = cacheDirectory
env.allowLocalModels = true
env.allowRemoteModels = process.env.AUTO_E0_OFFLINE !== '1'
if (process.env.AUTO_E0_REMOTE_HOST !== undefined) env.remoteHost = process.env.AUTO_E0_REMOTE_HOST

const miniSearchStart = performance.now()
const miniSearchPredictions = predictWithMiniSearch(replay)
const miniSearchResult = {
  id: 'minisearch',
  version: packageJson.devDependencies.minisearch,
  status: 'ok',
  quality: scorePredictions(replay, miniSearchPredictions),
  elapsedMs: round(performance.now() - miniSearchStart),
}

const b0Start = performance.now()
const b0Predictions = predictWithB0(replay)
const b0Result = {
  id: 'bounded-structural-lexical-v1',
  baseCommit: replay.baseCommit,
  status: 'ok',
  quality: scorePredictions(replay, b0Predictions),
  elapsedMs: round(performance.now() - b0Start),
  scope: 'recall uses the real current matcher; extraction, kind and identity use the frozen conservative lexical oracle',
}

const requestedModels = new Set((process.env.AUTO_E0_MODELS ?? MODEL_DEFINITIONS.map(item => item.key).join(','))
  .split(',').map(value => value.trim()).filter(Boolean))
const modelResults: Record<string, unknown>[] = []
for (const definition of MODEL_DEFINITIONS) {
  if (!requestedModels.has(definition.key)) continue
  try {
    modelResults.push(await benchmarkModel(replay, definition))
  } catch (error) {
    modelResults.push({
      id: definition.key,
      modelId: definition.modelId,
      revision: definition.revision,
      status: 'unavailable',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
  }
}

const eligibleModels = modelResults.filter((item): item is Record<string, unknown> & {
  id: string
  status: 'ok'
  passesDenseRecallGate: boolean
  qualityScore: number
  resource: { artifactBytes: number }
} => item.status === 'ok' && item.passesDenseRecallGate === true)
eligibleModels.sort((left, right) => right.qualityScore - left.qualityScore
  || left.resource.artifactBytes - right.resource.artifactBytes
  || left.id.localeCompare(right.id))

const selectedModel = eligibleModels[0] ?? null
const result = {
  schemaVersion: 'experience-auto-e0-benchmark-result-v1',
  generatedAt: new Date().toISOString(),
  replay: {
    schemaVersion: replay.schemaVersion,
    sha256: sha256(await readFile(replayPath)),
    sessionCases: replay.sessionCases.length,
    identityCases: replay.identityCases.length,
    recallCases: replay.recallCases.length,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    transformersJs: packageJson.devDependencies['@huggingface/transformers'],
    modelCacheDirectory: cacheDirectory,
    remoteHost: env.remoteHost,
    remoteAccessEnabledForThisRun: env.allowRemoteModels,
  },
  precommittedQualityGates: replay.qualityGates,
  baselines: { b0: b0Result, miniSearch: miniSearchResult },
  models: modelResults,
  decision: selectedModel === null
    ? {
      embeddingDefault: 'disabled',
      lexicalDefault: 'minisearch',
      reason: 'No measured local embedding candidate passed the precommitted dense-recall harmful-match, top-1 and resource gates.',
    }
    : {
      embeddingDefault: selectedModel.id,
      lexicalDefault: 'minisearch',
      exactIdentityOwner: 'type-specific deterministic kernel identity; embeddings may only surface possible duplicates',
      extractionAndKindOwner: 'local evidence detectors and deterministic materialization gates',
      reason: 'Selected only among candidates that passed dense-recall gates; ties prefer recall quality, then smaller artifact.',
    },
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function benchmarkModel(replayInput: Replay, definition: ModelDefinition): Promise<Record<string, unknown>> {
  const rssBefore = process.memoryUsage().rss
  const loadStart = performance.now()
  const offline = process.env.AUTO_E0_OFFLINE === '1'
  const verifiedRevisionDirectory = resolve(cacheDirectory, definition.modelId, definition.revision)
  const artifactPath = resolve(verifiedRevisionDirectory, definition.artifactFile)
  // Transformers.js 4.2.0's registry does not forward a pinned revision while
  // discovering tokenizer files offline. Loading the verified revision directory
  // explicitly avoids that remote-metadata dependency and proves a real cold
  // process can use only local artifacts.
  const pretrainedLocation = offline
    ? verifiedRevisionDirectory
    : definition.modelId
  const pretrainedOptions = {
    ...(offline ? {} : { revision: definition.revision }),
    dtype: definition.dtype,
    local_files_only: offline,
    // The projection worker is single-consumer and bounded. Avoid ONNX's
    // process-wide thread pools and CPU arena retaining hundreds of MiB that
    // provide no useful throughput for this serial background workload.
    session_options: {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
  } as const
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(pretrainedLocation, pretrainedOptions),
    AutoModel.from_pretrained(pretrainedLocation, pretrainedOptions),
  ])
  const extractor = new FeatureExtractionPipeline({ task: 'feature-extraction', model, tokenizer })
  const firstLoadMs = performance.now() - loadStart
  const artifact = await readFile(artifactPath)
  const actualArtifactSha256 = createHash('sha256').update(artifact).digest('hex')
  if (actualArtifactSha256 !== definition.artifactSha256 || artifact.byteLength !== definition.artifactBytes) {
    await extractor.dispose()
    throw new Error(`pinned artifact digest or size mismatch for ${definition.modelId}`)
  }
  const embed = async (texts: readonly string[], role: 'query' | 'passage' | 'plain'): Promise<number[][]> => {
    const prefix = role === 'query' ? definition.queryPrefix : role === 'passage' ? definition.passagePrefix : ''
    const output = await extractor(texts.map(text => `${prefix}${text}`), {
      pooling: definition.pooling,
      normalize: true,
    })
    const values = output.tolist() as number[][]
    if (values.some(row => row.length !== definition.dimension || row.some(value => !Number.isFinite(value)))) {
      throw new Error(`embedding dimension or finite-value check failed for ${definition.modelId}`)
    }
    return values
  }

  // Classification and exact-identity comparison are symmetric similarity tasks;
  // retrieval-only prefixes would bias one side and invalidate the comparison.
  const prototypeVectors = await embed(replayInput.classificationPrototypes.map(item => item.text), 'plain')
  const sessionVectors = await embed(replayInput.sessionCases.map(item => item.transcript), 'plain')
  const classification: Record<string, ClassificationId> = {}
  replayInput.sessionCases.forEach((item, index) => {
    const ranked = replayInput.classificationPrototypes.map((prototype, prototypeIndex) => ({
      id: prototype.id,
      score: dot(sessionVectors[index]!, prototypeVectors[prototypeIndex]!),
    })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    classification[item.id] = ranked[0]!.id
  })

  const identityLeft = await embed(replayInput.identityCases.map(item => item.left.text), 'plain')
  const identityRight = await embed(replayInput.identityCases.map(item => item.right.text), 'plain')
  const identity: Record<string, boolean> = {}
  replayInput.identityCases.forEach((item, index) => {
    identity[item.id] = sameKernelFields(item.left, item.right)
      && dot(identityLeft[index]!, identityRight[index]!) >= definition.identityThreshold
  })

  const documentVectors = await embed(replayInput.experiences.map(item => `${item.title}. ${item.text}`), 'passage')
  const queryVectors = await embed(replayInput.recallCases.map(item => item.query), 'query')
  const recall: Record<string, string | null> = {}
  replayInput.recallCases.forEach((item, index) => {
    const ranked = replayInput.experiences.map((document, documentIndex) => ({ document, documentIndex }))
      .filter(({ document }) => hardEligible(item, document))
      .map(({ document, documentIndex }) => ({
        id: document.id,
        score: dot(queryVectors[index]!, documentVectors[documentIndex]!),
      })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    const first = ranked[0]
    const second = ranked[1]
    recall[item.id] = first !== undefined
      && first.score >= definition.similarityThreshold
      && (second === undefined || first.score - second.score >= definition.margin || exactErrorMatch(item, first.id, replayInput.experiences))
      ? first.id : null
  })

  const warmSamples: number[] = []
  for (const item of replayInput.recallCases) {
    const start = performance.now()
    await embed([item.query], 'query')
    warmSamples.push(performance.now() - start)
  }
  const quality = scorePredictions(replayInput, { classification, identity, recall })
  const resource = {
    firstLoadMs: round(firstLoadMs),
    warmP50Ms: round(percentile(warmSamples, 0.5)),
    warmP95Ms: round(percentile(warmSamples, 0.95)),
    rssDeltaMiB: round((process.memoryUsage().rss - rssBefore) / 1_048_576),
    rssMeasurement: 'sequential_process_delta',
    cacheBytes: await directorySize(resolve(cacheDirectory, definition.modelId)),
    artifactBytes: definition.artifactBytes,
  }
  await extractor.dispose?.()
  const passesDenseRecallGate = passesDenseRecallGates(quality, resource, replayInput.qualityGates)
  return {
    id: definition.key,
    modelId: definition.modelId,
    revision: definition.revision,
    baseLicense: definition.baseLicense,
    dtype: definition.dtype,
    dimension: definition.dimension,
    pooling: definition.pooling,
    queryPrefix: definition.queryPrefix,
    passagePrefix: definition.passagePrefix,
    artifactFile: definition.artifactFile,
    artifactSha256: definition.artifactSha256,
    artifactVerified: true,
    status: 'ok',
    loader: offline ? 'verified_local_revision_directory' : 'pinned_remote_revision',
    runtimeProfile: 'single-consumer-sequential-no-cpu-arena',
    quality,
    resource,
    roleDecision: {
      extraction: 'not_authorized',
      kindClassification: 'not_authorized',
      exactIdentityMerge: 'not_authorized',
      possibleDuplicateDiscovery: 'advisory_only',
      recallRanking: 'eligible_after_hard_filters_and_abstain',
    },
    passesDenseRecallGate,
    experimentalClassificationGate: quality.extractionPrecision >= replayInput.qualityGates.extractionPrecision
      && quality.extractionRecall >= replayInput.qualityGates.extractionRecall
      && quality.kindAccuracy >= replayInput.qualityGates.kindAccuracy,
    experimentalExactIdentityGate: quality.identityFalseMerges <= replayInput.qualityGates.identityFalseMerges
      && quality.identityRecall >= replayInput.qualityGates.identityRecall,
    qualityScore: round(quality.recallTop1Accuracy - quality.recallHarmfulMatches),
  }
}

function predictWithMiniSearch(replayInput: Replay): Predictions {
  const classifier = new MiniSearch({
    fields: ['text'], storeFields: ['id'], tokenize: tokenizeLanguage,
    searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false },
  })
  classifier.addAll(replayInput.classificationPrototypes)
  const classification: Record<string, ClassificationId | null> = {}
  for (const item of replayInput.sessionCases) {
    classification[item.id] = (classifier.search(item.transcript)[0]?.id as ClassificationId | undefined) ?? null
  }
  const identity: Record<string, boolean> = {}
  for (const item of replayInput.identityCases) {
    identity[item.id] = sameKernelFields(item.left, item.right)
      && jaccard(tokenizeLanguage(item.left.text), tokenizeLanguage(item.right.text)) >= 0.3
  }
  const index = new MiniSearch({
    fields: ['title', 'text'], storeFields: ['id'], tokenize: tokenizeLanguage,
    searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false, boost: { title: 2 } },
  })
  index.addAll(replayInput.experiences)
  const recall: Record<string, string | null> = {}
  for (const item of replayInput.recallCases) {
    const eligibleIds = new Set(replayInput.experiences.filter(document => hardEligible(item, document)).map(document => document.id))
    const ranked = index.search(item.query, { filter: result => eligibleIds.has(String(result.id)) })
    const first = ranked[0]
    if (first === undefined) {
      recall[item.id] = null
      continue
    }
    const document = replayInput.experiences.find(candidate => candidate.id === String(first.id))!
    const overlap = intersectCount(tokenizeLanguage(item.query), tokenizeLanguage(`${document.title} ${document.text}`))
    recall[item.id] = overlap >= 2 || exactErrorMatch(item, document.id, replayInput.experiences) ? document.id : null
  }
  return { classification, identity, recall }
}

function predictWithB0(replayInput: Replay): Predictions {
  const conservative = predictWithMiniSearch(replayInput)
  const actor = {
    actorId: brandedId<'ExperienceActorId'>('auto-e0-actor', 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('auto-e0-principal', 'principalId'),
    kind: 'management_local_owner',
    authority: 'owner',
  } as const
  const versions = replayInput.experiences.map((document, index) => {
    const componentRevisionId = `auto-e0-revision-${String(index)}`
    return {
      experienceVersionId: `auto-e0-version-${String(index)}`,
      experienceId: document.id,
      versionNumber: 1,
      previousVersionId: null,
      kind: document.kind,
      title: document.title,
      intent: document.text,
      scope: { taskFamily: document.taskFamily, targetExposure: document.targetExposure },
      validity: {}, authoritySpec: {}, privacyClass: 'workspace', riskAndEffectSpec: {},
      allowedUseModes: ['reference', 'suggest', 'guided'],
      components: [{
        componentId: `auto-e0-component-${String(index)}`,
        componentRevisionId,
        componentKey: `auto-e0-component-${String(index)}`,
        role: 'symptom_signature',
        content: `${document.errorCodes.join(' ')} ${document.text}`,
        sourceRefs: [], evidenceIds: [],
      }],
      componentRevisionIds: [componentRevisionId], initialAssessmentId: `auto-e0-assessment-${String(index)}`,
      relationIds: [], createdByDecisionId: 'auto-e0', evidenceGrade: 'observation_supported',
      governanceState: 'accepted', operationalState: 'active', legacyWarnings: [], contentDigest: `sha256:${String(index).padStart(64, '0')}`,
      createdAt: '2026-09-10T00:00:00.000Z',
    }
  })
  const byVersionId = new Map(versions.map(version => [version.experienceVersionId, version.experienceId]))
  const recall: Record<string, string | null> = {}
  for (const item of replayInput.recallCases) {
    const fingerprint = fingerprintTask({
      text: item.query, workspaceRoot: null, targetExposure: item.targetExposure, mustUseExperience: false,
      riskClass: 'standard', requiredCapabilities: [], requestedUseMode: 'guided', overrideDecisionIds: [],
    }, actor, '2026-09-10T00:00:00.000Z', { taskFamily: item.taskFamily })
    const match = matchExperiences(fingerprint, versions as never, versions.length, '2026-09-10T00:00:00.000Z')
    const first = match.candidates.find(candidate => !candidate.rejected && candidate.selectedComponentRevisionIds.length > 0)
    recall[item.id] = first === undefined ? null : byVersionId.get(String(first.experienceVersionId)) ?? null
  }
  return { classification: conservative.classification, identity: conservative.identity, recall }
}

function scorePredictions(replayInput: Replay, predictions: Predictions): QualityMetrics {
  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  let correctKind = 0
  let kindCount = 0
  const classificationErrors: string[] = []
  for (const item of replayInput.sessionCases) {
    const predicted = predictions.classification[item.id] ?? null
    const extracted = predicted === 'procedure' || predicted === 'diagnostic'
    if (item.shouldExtract && extracted) truePositive++
    if (!item.shouldExtract && extracted) falsePositive++
    if (item.shouldExtract && !extracted) falseNegative++
    if (item.shouldExtract) {
      kindCount++
      if (predicted === item.kind) correctKind++
    }
    if ((item.shouldExtract ? item.kind : 'not_extractable') !== predicted) classificationErrors.push(item.id)
  }
  let identityTruePositive = 0
  let identityFalseMerges = 0
  let identityPositiveCount = 0
  const identityErrors: string[] = []
  for (const item of replayInput.identityCases) {
    const predicted = predictions.identity[item.id] ?? false
    if (item.sameExperience) identityPositiveCount++
    if (item.sameExperience && predicted) identityTruePositive++
    if (!item.sameExperience && predicted) identityFalseMerges++
    if (item.sameExperience !== predicted) identityErrors.push(item.id)
  }
  let recallCorrect = 0
  let recallHarmfulMatches = 0
  const recallErrors: string[] = []
  const harmfulMatches: string[] = []
  for (const item of replayInput.recallCases) {
    const predicted = predictions.recall[item.id] ?? null
    if (predicted === item.expectedTop1) recallCorrect++
    else recallErrors.push(item.id)
    if (item.forbiddenIds.includes(predicted ?? '')) {
      recallHarmfulMatches++
      harmfulMatches.push(`${item.id}:${String(predicted)}`)
    }
  }
  return {
    extractionPrecision: ratio(truePositive, truePositive + falsePositive),
    extractionRecall: ratio(truePositive, truePositive + falseNegative),
    kindAccuracy: ratio(correctKind, kindCount),
    identityFalseMerges,
    identityRecall: ratio(identityTruePositive, identityPositiveCount),
    recallHarmfulMatches,
    recallTop1Accuracy: ratio(recallCorrect, replayInput.recallCases.length),
    details: { classificationErrors, identityErrors, recallErrors, harmfulMatches },
  }
}

function passesDenseRecallGates(quality: QualityMetrics, resource: { warmP95Ms: number; rssDeltaMiB: number }, gates: Replay['qualityGates']): boolean {
  return quality.recallHarmfulMatches <= gates.recallHarmfulMatches
    && quality.recallTop1Accuracy >= gates.recallTop1Accuracy
    && resource.warmP95Ms <= gates.warmP95Ms
    && resource.rssDeltaMiB <= gates.rssDeltaMiB
}

function hardEligible(query: RecallCase, document: ExperienceDocument): boolean {
  if (query.targetExposure !== document.targetExposure) return false
  if (query.taskFamily !== document.taskFamily) return false
  if (query.errorCodes.length > 0 && document.errorCodes.length > 0
    && !query.errorCodes.some(code => document.errorCodes.includes(code))) return false
  return true
}

function exactErrorMatch(query: RecallCase, documentId: string, documents: readonly ExperienceDocument[]): boolean {
  const document = documents.find(item => item.id === documentId)
  return document !== undefined && query.errorCodes.some(code => document.errorCodes.includes(code))
}

function sameKernelFields(left: KernelText, right: KernelText): boolean {
  return left.kind === right.kind && left.scope === right.scope && left.taskFamily === right.taskFamily
}

function tokenizeLanguage(value: string): string[] {
  let normalized = value.normalize('NFKC').toLowerCase()
  for (const [han, canonical] of aliases) normalized = normalized.split(han).join(` ${canonical} `)
  const tokens: string[] = []
  let cursor = 0
  for (const match of normalized.matchAll(hanRun)) {
    const index = match.index ?? 0
    if (index > cursor) appendIdentifiers(tokens, normalized.slice(cursor, index))
    for (const segment of hanSegmenter.segment(match[0])) {
      if (segment.isWordLike && [...segment.segment].length >= 2) tokens.push(segment.segment)
    }
    cursor = index + match[0].length
  }
  if (cursor < normalized.length) appendIdentifiers(tokens, normalized.slice(cursor))
  return [...new Set(tokens)]
}

function appendIdentifiers(tokens: string[], text: string): void {
  for (const match of text.matchAll(identifierToken)) tokens.push(match[0].trim())
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  const intersection = [...leftSet].filter(value => rightSet.has(value)).length
  return ratio(intersection, new Set([...leftSet, ...rightSet]).size)
}

function intersectCount(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right)
  return new Set(left.filter(value => rightSet.has(value))).size
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : round(numerator / denominator)
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function directorySize(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      const child = join(path, entry.name)
      total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size
    }
    return total
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}
