import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { TransformersLocalEmbeddingProvider, type LocalEmbeddingConfig } from '../src/adapters/local-embedding.js'
import { automaticDenseApplicabilityProfile } from '../src/application/local-semantic-calibration.js'
import { TYPE_BEHAVIORS } from '../src/domain/behavior.js'
import {
  selectHybridMatchingExperiences,
  type HybridRetrievalOperation,
} from '../src/domain/hybrid-retrieval.js'
import { fingerprintTask, type ExperienceMatchProjection } from '../src/domain/planning.js'
import { projectExperienceVersion, projectTaskFingerprint } from '../src/domain/retrieval-projector.js'
import { brandedId } from '../src/ids.js'
import type { ActorView, ExperienceRetrievalProjectionView } from '../src/types.js'

interface ReplayExperience {
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
  readonly expectedTop1: string | null
  readonly forbiddenIds: readonly string[]
}
interface Replay {
  readonly schemaVersion: string
  readonly experiences: readonly ReplayExperience[]
  readonly recallCases: readonly RecallCase[]
}

const root = process.cwd()
const replayPath = resolve(root, 'benchmarks/auto-e0/replay.json')
const replayBytes = await readFile(replayPath)
const replay = JSON.parse(replayBytes.toString('utf8')) as Replay
const outputPath = resolve(root, process.env.AUTO_E4_OUTPUT ?? 'evidence/auto/e4a/replay.json')
const modelPath = resolve(process.env.AUTO_E4_MODEL_PATH
  ?? '/private/tmp/dsh-experience-auto-e0-models/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78')
const model: LocalEmbeddingConfig = {
  provider: 'transformers_js',
  modelPath,
  modelId: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  artifactPath: 'onnx/model_quantized.onnx',
  artifactSha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
  artifactBytes: 118_308_185,
  dimension: 384,
  dtype: 'q8',
  pooling: 'mean',
  queryPrefix: 'query: ',
  passagePrefix: 'passage: ',
  tokenizerConfigBundleSha256: '4fbcddc3ad44860d65318f8f0c7b8f9d49632554f41b735749fe9075f04bb133',
  normalization: 'l2',
  maxInputTokens: 512,
  truncationPolicy: 'truncate_end',
  timeoutMs: 60_000,
}
const denseApplicabilityProfile = automaticDenseApplicabilityProfile(model)
if (denseApplicabilityProfile === null) throw new Error('Frozen E4 model identity is not calibrated for automatic recall')
const versions = replay.experiences.map(projectReplayExperience)
const documents = versions.map(projectExperienceVersion)
const tokenizerRuntime = await import('@huggingface/transformers')
tokenizerRuntime.env.allowRemoteModels = false
tokenizerRuntime.env.allowLocalModels = true
const tokenizer = await tokenizerRuntime.AutoTokenizer.from_pretrained(modelPath, { local_files_only: true })
const passageTokenCounts = documents.map(document => tokenLength(tokenizer, `${model.passagePrefix}${document.denseText}`))
const queryTokenCounts: number[] = []
const embedding = new TransformersLocalEmbeddingProvider()
const passage = await embedding.embedBatch(
  `auto-e4:passages:${sha256(replayBytes)}`,
  documents.map(document => document.denseText),
  'passage',
  model,
)
const vectorByDocument = new Map(documents.map((document, index) => [document.documentId, passage.vectors[index]!]))
const projection = retrievalProjection(documents)
const idByVersion = new Map(versions.map((version, index) => [
  String(version.experienceVersionId), replay.experiences[index]!.id,
]))
const results: Record<string, unknown>[] = []
let correct = 0
const harmful: string[] = []
for (const item of replay.recallCases) {
  const task = {
    text: item.query,
    workspaceRoot: null,
    targetExposure: item.targetExposure,
    mustUseExperience: false,
    riskClass: 'standard' as const,
    requiredCapabilities: [],
    requestedUseMode: 'guided' as const,
    overrideDecisionIds: [],
  }
  const fingerprint = fingerprintTask(task, actor(), '2026-09-10T12:00:00.000Z', {
    taskFamily: item.taskFamily,
  })
  const query = projectTaskFingerprint(fingerprint)
  queryTokenCounts.push(tokenLength(tokenizer, `${model.queryPrefix}${query.denseText}`))
  const queryEmbedding = await embedding.embedBatch(`auto-e4:query:${item.id}`, [query.denseText], 'query', model)
  const operation: HybridRetrievalOperation = {
    query,
    projection,
    vectors: vectorByDocument,
    queryVector: queryEmbedding.vectors[0]!,
    queryEmbeddingReceiptId: queryEmbedding.receipt.receiptId,
    denseState: 'ready',
    denseFailureCode: null,
    denseSimilarityThreshold: 0.76,
    denseMargin: 0.025,
    denseApplicabilityProfile,
    recallDecisionKey: sha256(new TextEncoder().encode(`auto-e4:${item.id}`)),
  }
  const match = selectHybridMatchingExperiences(
    fingerprint,
    versions,
    32,
    '2026-09-10T12:00:00.000Z',
    { requestedUseMode: 'guided', workspaceRoot: null, requiredCapabilities: [] },
    operation,
  ).matchSet
  const primaryVersion = match.retrievalDecision?.primaryExperienceVersionId
  const actual = primaryVersion === null || primaryVersion === undefined
    ? null : idByVersion.get(String(primaryVersion)) ?? null
  if (actual === item.expectedTop1) correct += 1
  if (actual !== null && item.forbiddenIds.includes(actual)) harmful.push(`${item.id}:${actual}`)
  const primary = match.candidates.find(candidate => candidate.experienceVersionId === primaryVersion)
  results.push({
    id: item.id,
    expectedTop1: item.expectedTop1,
    actualTop1: actual,
    correct: actual === item.expectedTop1,
    lexicalBm25Score: primary?.lexicalBm25Score ?? null,
    semanticScore: primary?.semanticScore ?? null,
    fusedScore: primary?.fusedScore ?? null,
    abstentionReasonCodes: match.retrievalDecision?.abstentionReasonCodes ?? [],
    topCandidates: match.candidates.slice(0, 3).map(candidate => ({
      id: idByVersion.get(String(candidate.experienceVersionId)) ?? String(candidate.experienceVersionId),
      lexicalBm25Score: candidate.lexicalBm25Score,
      semanticScore: candidate.semanticScore,
      fusedScore: candidate.fusedScore,
      lexicalRank: candidate.lexicalRank,
      semanticRank: candidate.semanticRank,
    })),
  })
}
await embedding.dispose()
const output = {
  schemaVersion: 'experience-auto-e4a-replay-v1',
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  replay: { schemaVersion: replay.schemaVersion, sha256: sha256(replayBytes), cases: replay.recallCases.length },
  retrieval: {
    version: 'conservative-hybrid-v1',
    policy: 'conservative-hybrid-policy-v2',
    lexical: 'minisearch-7.2.0',
    denseModel: model.modelId,
    denseRevision: model.revision,
    denseArtifactSha256: model.artifactSha256,
    denseApplicabilityProfileDigest: denseApplicabilityProfile.profileDigest,
    denseApplicabilityAllowedKinds: denseApplicabilityProfile.allowedKinds,
    tokenizerConfigBundleSha256: model.tokenizerConfigBundleSha256,
    normalization: model.normalization,
    maxInputTokens: model.maxInputTokens,
    truncationPolicy: model.truncationPolicy,
    maxObservedDenseInputTokens: Math.max(...passageTokenCounts, ...queryTokenCounts),
    similarityThreshold: 0.76,
    lexicalRelativeMargin: 0.1,
    margin: 0.025,
    rrfK: 60,
  },
  quality: {
    correct,
    total: replay.recallCases.length,
    top1Accuracy: correct / replay.recallCases.length,
    harmfulMatches: harmful.length,
    harmful,
  },
  results,
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
if (correct !== replay.recallCases.length || harmful.length !== 0
  || Math.max(...passageTokenCounts, ...queryTokenCounts) > model.maxInputTokens) process.exitCode = 1

function tokenLength(tokenizer: Awaited<ReturnType<typeof tokenizerRuntime.AutoTokenizer.from_pretrained>>, text: string): number {
  return tokenizer(text, { truncation: false }).input_ids.tolist()[0]!.length
}

function projectReplayExperience(item: ReplayExperience, index: number): ExperienceMatchProjection {
  const components = TYPE_BEHAVIORS[item.kind].requiredRoles.map((role, roleIndex) => ({
    componentId: brandedId<'ExperienceComponentId'>(`${item.id}:component:${roleIndex}`, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`${item.id}:revision:${roleIndex}`, 'componentRevisionId'),
    role,
    content: role === 'symptom_signature'
      ? `${item.errorCodes.join(' ')} ${item.text}`
      : `${role}: ${item.text}`,
  }))
  return {
    experienceVersionId: brandedId<'ExperienceVersionId'>(`${item.id}:version`, 'experienceVersionId'),
    experienceId: brandedId<'ExperienceId'>(item.id, 'experienceId'),
    kind: item.kind,
    title: item.title,
    intent: item.text,
    scope: { taskFamily: item.taskFamily, targetExposure: item.targetExposure },
    validity: {},
    riskAndEffectSpec: {},
    privacyClass: 'workspace',
    allowedUseModes: ['reference', 'suggest', 'guided'],
    evidenceGrade: 'observation_supported',
    contentDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
    componentRevisionIds: components.map(component => component.componentRevisionId),
    components,
  }
}

function retrievalProjection(documents: ReturnType<typeof projectExperienceVersion>[]): ExperienceRetrievalProjectionView {
  return {
    projectionKey: 'experience-retrieval-v1',
    schemaVersion: 2,
    manifest: {
      schemaVersion: 'experience-retrieval-projection-manifest-v2',
      projectionVersion: 'experience-retrieval-projector-v2',
      generation: 1,
      state: 'dense_ready',
      provider: 'transformers_js',
      providerState: 'ready',
      modelId: model.modelId,
      modelRevision: model.revision,
      artifactSha256: model.artifactSha256,
      dimension: model.dimension,
      dtype: model.dtype,
      pooling: model.pooling,
      queryPrefix: model.queryPrefix,
      passagePrefix: model.passagePrefix,
      tokenizerConfigBundleSha256: model.tokenizerConfigBundleSha256,
      normalization: model.normalization,
      maxInputTokens: model.maxInputTokens,
      truncationPolicy: model.truncationPolicy,
      operationSettingsRevision: null,
      operationSettingsDigest: `sha256:${'1'.repeat(64)}`,
      sourceWatermarkDigest: `sha256:${'2'.repeat(64)}`,
      contentDigest: `sha256:${'3'.repeat(64)}`,
      documentCount: documents.length,
      vectorCount: documents.length,
      failureCode: null,
      builtAt: new Date().toISOString(),
    },
    documents,
  }
}

function actor(): ActorView {
  return {
    actorId: brandedId<'ExperienceActorId'>('auto-e4-actor', 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('auto-e4-principal', 'principalId'),
    kind: 'management_local_owner',
    authority: 'owner',
  }
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
