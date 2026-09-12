import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { TransformersLocalEmbeddingProvider } from '../src/adapters/local-embedding.js'
import { localEmbeddingConfig } from '../src/application/retrieval-projection.js'
import { consolidatePublishedSuggestionDuplicates } from '../src/application/semantic-suggestion-consolidation.js'
import { suggestionDigest } from '../src/domain/automatic-suggestion.js'
import { TYPE_BEHAVIORS } from '../src/domain/behavior.js'
import { experienceKernelIdentity } from '../src/domain/experience-kernel.js'
import { suggestionDecisionDigests } from '../src/domain/suggestion-materializer.js'
import { projectExperienceVersion } from '../src/domain/retrieval-projector.js'
import type { ExperienceKind } from '../src/domain/kind.js'
import { brandedId } from '../src/ids.js'
import { RuntimeSettingsSchema } from '../src/runtime-settings-schema.js'
import type { RuntimeSettingsSnapshot } from '../src/runtime-settings.js'
import type {
  ComponentRole,
  ExperienceCandidateDraft,
  ExperienceSuggestionGroupView,
  ExperienceVersionView,
} from '../src/types.js'

type OpenKind = Extract<ExperienceKind, 'procedure' | 'diagnostic'>
type Expected = 'same' | 'different'
interface StructuredCase {
  readonly id: string
  readonly split: 'development' | 'holdout'
  readonly truthRef: string
  readonly kind: OpenKind
  readonly expected: Expected
  readonly left: Readonly<Partial<Record<ComponentRole, string>>>
  readonly right: Readonly<Partial<Record<ComponentRole, string>>>
}

const root = process.cwd()
const modelPath = resolve(process.env.CORR_E2_MODEL_PATH
  ?? '/private/tmp/dsh-experience-auto-e0-models/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78')
const outputPath = resolve(process.env.CORR_E2_OUTPUT ?? 'evidence/corr/e2/evaluation.json')
const values = RuntimeSettingsSchema({ embeddingProvider: 'transformers_js', embeddingModelPath: modelPath })
const runtime: RuntimeSettingsSnapshot = { revision: 1, digest: suggestionDigest({ corr: 'e2' }), values }
const config = localEmbeddingConfig(runtime)

async function run(): Promise<void> {
  const provider = new TransformersLocalEmbeddingProvider()
  const results: Record<string, unknown>[] = []

for (const item of CASES) {
  const group = suggestionGroup(item, 'left')
  const version = publishedVersion(item)
  const document = projectExperienceVersion(version)
  const passage = await provider.embedBatch(`corr-e2:${item.id}:passage`, [document.denseText], 'passage', config)
  const [resolved] = await consolidatePublishedSuggestionDuplicates(
    [group],
    {
      projection: {
        projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
        manifest: retrievalManifest(runtime, document.contentDigest), documents: [document],
      },
      vectors: new Map([[document.documentId, passage.vectors[0]!]]),
    },
    [version],
    runtime,
    provider,
  )
  const actual: Expected = resolved?.consolidation === 'semantic_duplicate' ? 'same' : 'different'
  results.push({
    id: item.id,
    split: item.split,
    truthRef: item.truthRef,
    kind: item.kind,
    expected: item.expected,
    actual,
    correct: actual === item.expected,
    consolidation: resolved?.consolidation ?? null,
    decision: resolved?.consolidationDetail?.decision ?? null,
    reasonCodes: resolved?.consolidationDetail?.reasonCodes ?? [],
    shortlistSimilarity: resolved?.canonicalMatch?.similarity ?? null,
    mappedComponents: resolved?.consolidationDetail?.componentCorrespondence.length ?? 0,
    requiredComponents: group.draft.components.length,
  })
}
await provider.dispose()

const incorrect = results.filter(result => result.correct !== true)
const harmful = results.filter(result => result.expected === 'different' && result.actual === 'same')
const byKind = Object.fromEntries(['procedure', 'diagnostic'].map(kind => {
  const items = results.filter(result => result.kind === kind)
  return [kind, {
    total: items.length,
    correct: items.filter(result => result.correct === true).length,
    harmful: items.filter(result => result.expected === 'different' && result.actual === 'same').length,
  }]
}))
const benchmarkBytes = await Promise.all([
  readFile(resolve(root, 'benchmarks/corr-e0/manifest.json')),
  readFile(resolve(root, 'benchmarks/corr-e0/development.json')),
  readFile(resolve(root, 'benchmarks/corr-e0/holdout.json')),
])
const output = {
  schemaVersion: 'experience-corr-e2-equivalence-evaluation-v1',
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  frozenTruth: {
    manifestSha256: sha256(benchmarkBytes[0]!),
    developmentSha256: sha256(benchmarkBytes[1]!),
    holdoutSha256: sha256(benchmarkBytes[2]!),
  },
  modelIdentity: {
    modelId: config.modelId, revision: config.revision, artifactSha256: config.artifactSha256,
    tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
    normalization: config.normalization, maxInputTokens: config.maxInputTokens,
    truncationPolicy: config.truncationPolicy,
  },
  policy: {
    algorithmVersion: 'experience-equivalence-v1',
    shortlistThreshold: values.equivalenceSimilarityThreshold,
    margin: values.equivalenceMargin,
    openedKinds: ['procedure', 'diagnostic'],
    unopenedKinds: ['preference_policy', 'fact', 'strategy', 'causal'],
  },
  quality: { total: results.length, correct: results.length - incorrect.length, harmful: harmful.length, byKind },
  results,
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (incorrect.length > 0 || harmful.length > 0) process.exitCode = 1
}

const COMMON_PROCEDURE = {
  goal_signature: '只读核验本地 DSH 插件宿主状态',
  entry_condition: '仅在本地工作区且具有只读权限时执行',
  forbidden_condition: '无权或目标不一致时禁止执行',
  parameter: '重新读取当前参数',
  environment_adapter: '使用当前工作区工具和路径',
  step: '读取 git 状态并报告',
  checkpoint: '核对命令退出状态',
  side_effect_policy: '不得修改代码或配置',
  failure_branch: '任一步骤失败时停止并重新诊断',
  verifier: '命令退出码 0 才算成功',
} as const satisfies Readonly<Partial<Record<ComponentRole, string>>>
const COMMON_DIAGNOSTIC = {
  symptom_signature: 'EADDRINUSE 端口占用',
  environment_scope: '本地 DSH 工作区',
  observed_fact: '服务启动失败后确认已有监听',
  hypothesis: '现有监听与启动失败相关',
  discriminator: '检查当前端口监听归属',
  misleading_signal: '会话完成不能替代工具结果',
  branch: '归属当前任务时停止旧进程并重试',
  resolution_candidate: '检查监听后停止所属进程并重启',
  falsifier: '错误码变化或监听归属不明时重新诊断',
  recovery_verifier: '核对 socket 端口监听恢复',
} as const satisfies Readonly<Partial<Record<ComponentRole, string>>>

const CASES: readonly StructuredCase[] = [
  {
    id: 'procedure-paraphrase', split: 'development', truthRef: 'eq-dev-01', kind: 'procedure', expected: 'same',
    left: {}, right: {
      goal_signature: '在不改代码的前提下检查本地 DSH 插件运行状态',
      entry_condition: '当前目录为本地工作区并且已授予读取权限时才检查',
    },
  },
  {
    id: 'procedure-action-flip', split: 'development', truthRef: 'eq-dev-08', kind: 'procedure', expected: 'different',
    left: { goal_signature: '检查插件配置', step: '读取插件配置文件并报告' },
    right: { goal_signature: '检查插件配置', step: '写入插件配置文件并保存' },
  },
  {
    id: 'procedure-scope-polarity', split: 'development', truthRef: 'eq-dev-04', kind: 'procedure', expected: 'different',
    left: { entry_condition: '只检查 git 状态' }, right: { entry_condition: '不只检查 git 状态' },
  },
  {
    id: 'procedure-verifier-change', split: 'development', truthRef: 'eq-dev-12', kind: 'procedure', expected: 'different',
    left: { verifier: 'authenticated RPC 返回 HTTP 200 才算成功' },
    right: { verifier: '只要端口正在监听就算成功' },
  },
  {
    id: 'diagnostic-port-paraphrase', split: 'development', truthRef: 'eq-dev-02', kind: 'diagnostic', expected: 'same',
    left: {}, right: {
      symptom_signature: '端口被占用导致服务无法启动',
      discriminator: '核对监听进程是否属于当前任务',
      branch: '确认属于当前任务后终止旧进程并重新启动',
      resolution_candidate: '核对监听后终止所属进程并重新启动',
      recovery_verifier: '验证 socket 端口已经恢复监听',
    },
  },
  {
    id: 'diagnostic-status-conflict', split: 'development', truthRef: 'eq-dev-05', kind: 'diagnostic', expected: 'different',
    left: { symptom_signature: '接口返回 HTTP 401' }, right: { symptom_signature: '页面返回 HTTP 404' },
  },
  {
    id: 'diagnostic-cause-conflict', split: 'development', truthRef: 'eq-dev-03', kind: 'diagnostic', expected: 'different',
    left: { symptom_signature: 'HTTP 404', resolution_candidate: '构建缺失的前端产物' },
    right: { symptom_signature: 'HTTP 404', resolution_candidate: '修改缺失的代理路由' },
  },
  {
    id: 'diagnostic-auth-paraphrase', split: 'holdout', truthRef: 'eq-hold-01', kind: 'diagnostic', expected: 'same',
    left: {
      symptom_signature: 'RPC 401 因缺少 profile 凭据',
      resolution_candidate: '更新认证头并重试请求',
      recovery_verifier: '认证接口返回 HTTP 200',
    },
    right: {
      symptom_signature: '认证信息未附带导致接口拒绝',
      resolution_candidate: '更新为当前 profile token 并重试请求',
      recovery_verifier: '接口认证后返回 HTTP 200',
    },
  },
  {
    id: 'procedure-read-write-holdout', split: 'holdout', truthRef: 'eq-hold-02', kind: 'procedure', expected: 'different',
    left: { goal_signature: '检查 Session 状态', step: '读取当前 Session 状态' },
    right: { goal_signature: '检查 Session 状态', step: '修改配置后重新启动并检查 Session' },
  },
  {
    id: 'procedure-permission-holdout', split: 'holdout', truthRef: 'eq-hold-03', kind: 'procedure', expected: 'different',
    left: { entry_condition: '使用管理员权限', step: '迁移数据库' },
    right: { entry_condition: '只有只读权限', step: '读取数据库版本' },
  },
]

function suggestionGroup(item: StructuredCase, side: 'left' | 'right'): ExperienceSuggestionGroupView {
  const draft = draftFor(item, side)
  const source = {
    sourceRefId: brandedId<'ExperienceSourceRefId'>(`source:${item.id}`, 'sourceRefId'),
    sourceSystem: 'corr-e2', sourceKind: 'evaluation', locator: item.truthRef,
    ownerScope: 'workspace:evaluation', accessScope: 'local_owner',
    occurredAt: '2026-09-12T00:00:00.000Z', observedAt: '2026-09-12T00:00:00.000Z',
    contentDigest: suggestionDigest({ case: item.id }), redactionState: 'bounded_excerpt' as const,
  }
  const kernelIdentity = experienceKernelIdentity({ kind: item.kind, scope: draft.scope, components: draft.components })
  const base: ExperienceSuggestionGroupView = {
    suggestionGroupId: `suggestion-group:${item.id}`,
    kernelIdentity, revisionDigest: '', reviewDigest: null, sourceDigest: source.contentDigest,
    kind: item.kind, title: draft.title, draft, saveReadiness: 'ready',
    readinessReasons: ['current_permission_required'], missingFields: [], riskFlags: ['current_permission_required'],
    consolidation: 'distinct', relatedGroupIds: [], occurrences: [{
      occurrenceId: `occurrence:${item.id}`, seedOccurrenceId: `seed:${item.id}`,
      sessionId: `session:${item.id}`, episodeRef: {
        episodeRefId: brandedId<'ExperienceEpisodeRefId'>(`episode:${item.id}`, 'episodeRefId'),
        sourceSystem: 'corr-e2', sessionOrRunId: `session:${item.id}`, eventStart: 1, eventEnd: 2,
        occurredAt: { start: '2026-09-12T00:00:00.000Z', end: '2026-09-12T00:00:01.000Z' },
        contentDigest: source.contentDigest, redactionState: 'bounded_excerpt',
      }, sourceRefs: [source], detectedAt: '2026-09-12T00:00:01.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    }],
    occurrenceCount: 1, sessionIds: [`session:${item.id}`], crossSession: false,
    detectorVersions: ['corr-e2'], segmenterVersions: ['corr-e2'], materializerVersion: 'six-kind-materializer-v3',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }
  return { ...base, ...suggestionDecisionDigests(base) }
}

function publishedVersion(item: StructuredCase): ExperienceVersionView {
  const draft = draftFor(item, 'right')
  const components = draft.components.map((component, index) => ({
    ...component,
    componentId: brandedId<'ExperienceComponentId'>(`component:${item.id}:${String(index)}`, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`revision:${item.id}:${String(index)}`, 'componentRevisionId'),
    evidenceIds: [brandedId<'ExperienceEvidenceId'>(`evidence:${item.id}:${String(index)}`, 'evidenceId')],
  }))
  return {
    experienceId: brandedId<'ExperienceId'>(`experience:${item.id}`, 'experienceId'),
    experienceVersionId: brandedId<'ExperienceVersionId'>(`version:${item.id}`, 'experienceVersionId'),
    versionNumber: 1, previousVersionId: null, kind: item.kind, title: draft.title, intent: draft.intent,
    scope: draft.scope, validity: draft.validity, authoritySpec: draft.authoritySpec,
    privacyClass: draft.privacyClass, riskAndEffectSpec: draft.riskAndEffectSpec,
    allowedUseModes: draft.allowedUseModes, components,
    componentRevisionIds: components.map(component => component.componentRevisionId),
    initialAssessmentId: brandedId<'ExperienceAssessmentId'>(`assessment:${item.id}`, 'assessmentId'),
    relationIds: [], createdByDecisionId: `decision:${item.id}`, evidenceGrade: draft.evidenceGrade,
    governanceState: 'accepted', operationalState: 'conditional', legacyWarnings: [],
    contentDigest: suggestionDigest({ case: item.id, side: 'right' }), createdAt: '2026-09-12T00:00:00.000Z',
  }
}

function draftFor(item: StructuredCase, side: 'left' | 'right'): ExperienceCandidateDraft {
  const base = item.kind === 'procedure' ? COMMON_PROCEDURE : COMMON_DIAGNOSTIC
  const values = { ...base, ...item[side] }
  const sourceRefId = brandedId<'ExperienceSourceRefId'>(`source:${item.id}`, 'sourceRefId')
  const components = TYPE_BEHAVIORS[item.kind].requiredRoles.map((role, index) => ({
    componentKey: `${item.kind}:${role}:${String(index + 1)}`, role,
    content: requiredRoleValue(values, role), sourceRefs: [sourceRefId],
  }))
  const anchorRole = item.kind === 'procedure' ? 'goal_signature' : 'symptom_signature'
  const anchor = requiredRoleValue(values, anchorRole)
  return {
    proposedKind: item.kind, title: anchor, intent: anchor,
    scope: { workspaceRoot: '/workspace/corr-e2', taskFamily: item.kind === 'procedure' ? 'host_validation' : 'host_diagnosis' },
    validity: { revalidation: 'required_before_use' }, authoritySpec: { source: 'dsh_session_log' },
    privacyClass: 'workspace', riskAndEffectSpec: { permission: 'must_revalidate_current_authority' },
    allowedUseModes: ['reference', 'suggest', 'guided'], components, evidenceGrade: 'observation_supported',
    fieldSourceRefs: Object.fromEntries(components.map(component => [`component:${component.componentKey}`, component.sourceRefs])),
    excludedSteps: [], missingEvidence: [], unresolvedFields: [],
  }
}

function requiredRoleValue(values: Readonly<Partial<Record<ComponentRole, string>>>, role: ComponentRole): string {
  const value = values[role]
  if (value === undefined || value.trim() === '') throw new Error(`CORR-E2 fixture is missing ${role}`)
  return value
}

function retrievalManifest(runtimeSnapshot: RuntimeSettingsSnapshot, contentDigest: string) {
  return {
    schemaVersion: 'experience-retrieval-projection-manifest-v2' as const,
    projectionVersion: 'experience-retrieval-projector-v2' as const, generation: 1,
    state: 'dense_ready' as const, provider: 'transformers_js' as const, providerState: 'ready' as const,
    modelId: config.modelId, modelRevision: config.revision, artifactSha256: config.artifactSha256,
    dimension: config.dimension, dtype: config.dtype, pooling: config.pooling,
    queryPrefix: config.queryPrefix, passagePrefix: config.passagePrefix,
    tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
    normalization: config.normalization, maxInputTokens: config.maxInputTokens,
    truncationPolicy: config.truncationPolicy, operationSettingsRevision: runtimeSnapshot.revision,
    operationSettingsDigest: runtimeSnapshot.digest, sourceWatermarkDigest: suggestionDigest({ corr: 'e2-source' }),
    contentDigest, documentCount: 1, vectorCount: 1, failureCode: null, builtAt: new Date().toISOString(),
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

await run()
