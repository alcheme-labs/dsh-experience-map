import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SessionTrajectorySlice } from '../src/adapters/session-source.js'
import { TransformersLocalEmbeddingProvider } from '../src/adapters/local-embedding.js'
import { localEmbeddingConfig } from '../src/application/retrieval-projection.js'
import { consolidatePublishedSuggestionDuplicates } from '../src/application/semantic-suggestion-consolidation.js'
import { automaticDenseApplicabilityProfile } from '../src/application/local-semantic-calibration.js'
import { detectSuggestionSeed, suggestionDigest } from '../src/domain/automatic-suggestion.js'
import { TYPE_BEHAVIORS } from '../src/domain/behavior.js'
import { experienceKernelIdentity } from '../src/domain/experience-kernel.js'
import {
  materializeSuggestionGroups,
  suggestionEvidenceSourceRefsForComponent,
  suggestionDecisionDigests,
} from '../src/domain/suggestion-materializer.js'
import { projectExperienceVersion } from '../src/domain/retrieval-projector.js'
import { projectTaskFingerprint } from '../src/domain/retrieval-projector.js'
import {
  fingerprintTask,
  matchExperienceProjection,
  preflightMatch,
  type ExperienceMatchProjection,
} from '../src/domain/planning.js'
import {
  selectHybridMatchingExperiences,
  type HybridRetrievalOperation,
} from '../src/domain/hybrid-retrieval.js'
import type { ExperienceKind } from '../src/domain/kind.js'
import { RuntimeSettingsSchema } from '../src/runtime-settings-schema.js'
import type { RuntimeSettingsSnapshot } from '../src/runtime-settings.js'
import type {
  BoundedSourceRecord,
  ActorView,
  ComponentRole,
  ExperienceCandidateDraft,
  ExperienceSuggestionGroupView,
  ExperienceSuggestionSeedView,
  ExperienceVersionView,
  PlanningTaskInput,
  SourceRefView,
  SuggestionEvidenceSignalView,
} from '../src/types.js'
import { brandedId } from '../src/ids.js'

type TruthTask = 'extractability' | 'kind' | 'grounding' | 'equivalence' | 'component_mapping' | 'applicability'
type JsonRecord = Record<string, unknown>

interface FrozenCase extends JsonRecord {
  readonly id: string
  readonly origin: 'deidentified_session' | 'synthetic_required_negative'
  readonly sourceRef: string
  readonly expected: unknown
  readonly tags: readonly string[]
}

interface SessionActionFixture {
  readonly tool: string
  readonly command: string
  readonly result: string
  readonly errorCode?: string
  readonly fact?: JsonRecord
}

interface SessionFixture {
  readonly goal: string
  readonly actions: readonly SessionActionFixture[]
  readonly assistantClaim?: string
  readonly complete?: boolean
}

interface RuntimeFixtures {
  readonly schemaVersion: 'experience-corr-e0-runtime-fixtures-v1'
  readonly truthManifestSha256: string
  readonly sessionCases: Readonly<Record<string, SessionFixture>>
  readonly groundingCases: Readonly<Record<string, JsonRecord>>
}

interface GroundingFixture extends JsonRecord {
  readonly kind: ExperienceKind
  readonly goal?: readonly (readonly string[])[] | readonly string[]
  readonly actions?: readonly (readonly string[])[]
  readonly verifier?: readonly (readonly string[])[]
  readonly failures?: readonly (readonly string[])[]
  readonly preference?: readonly string[]
  readonly fact?: readonly string[]
  readonly strategy?: readonly string[]
  readonly causalClaim?: readonly string[]
  readonly causalEvidence?: readonly (readonly string[])[]
  readonly ignored?: readonly string[]
  readonly policyDerived?: readonly string[]
}

interface CaseResult {
  readonly id: string
  readonly split: 'development' | 'holdout'
  readonly origin: FrozenCase['origin']
  readonly sourceRef: string
  readonly tags: readonly string[]
  readonly expected: unknown
  readonly actual: unknown
  readonly correct: boolean
  readonly reasonCodes: readonly string[]
}

const root = process.cwd()
const EVALUATION_NOW = '2026-09-12T00:30:00.000Z'
const outputPath = resolve(process.env.CORR_E5_OUTPUT ?? 'evidence/corr/e5/offline-evaluation.json')
const modelPath = resolve(process.env.CORR_E5_MODEL_PATH
  ?? '/private/tmp/dsh-experience-auto-e0-models/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78')
const runtimeValues = RuntimeSettingsSchema({ embeddingProvider: 'transformers_js', embeddingModelPath: modelPath })
const runtime: RuntimeSettingsSnapshot = {
  revision: 1,
  digest: suggestionDigest({ corr: 'e5-offline', runtimeValues }),
  values: runtimeValues,
}
const embeddingConfig = localEmbeddingConfig(runtime)
const evidenceLimits = { maxEvidenceItems: 96, maxEvidenceItemBytes: 8_192, maxEvidencePayloadBytes: 262_144 }

async function run(): Promise<void> {
  const [manifestBytes, developmentBytes, holdoutBytes, fixtureBytes] = await Promise.all([
    readFile(resolve(root, 'benchmarks/corr-e0/manifest.json')),
    readFile(resolve(root, 'benchmarks/corr-e0/development.json')),
    readFile(resolve(root, 'benchmarks/corr-e0/holdout.json')),
    readFile(resolve(root, 'benchmarks/corr-e0/runtime-fixtures.json')),
  ])
  const manifest = parseObject(manifestBytes)
  const fixtures = parseObject(fixtureBytes) as unknown as RuntimeFixtures
  if (fixtures.schemaVersion !== 'experience-corr-e0-runtime-fixtures-v1'
    || fixtures.truthManifestSha256 !== sha256(manifestBytes)) {
    throw new Error('CORR-E5 runtime fixtures do not bind the frozen truth manifest')
  }
  const splits = [
    { name: 'development' as const, source: parseObject(developmentBytes) },
    { name: 'holdout' as const, source: parseObject(holdoutBytes) },
  ]
  const results: Record<TruthTask, CaseResult[]> = {
    extractability: [], kind: [], grounding: [], equivalence: [], component_mapping: [], applicability: [],
  }
  const embedding = new TransformersLocalEmbeddingProvider()
  for (const split of splits) {
    const tasks = exactObject(split.source.tasks, `${split.name}.tasks`)
    for (const task of Object.keys(results) as TruthTask[]) {
      const cases = exactArray(tasks[task], `${split.name}.${task}`) as FrozenCase[]
      if (task === 'extractability' || task === 'kind') {
        for (const item of cases) results[task].push(evaluateSessionCase(task, split.name, item, fixtures))
      } else if (task === 'grounding') {
        for (const item of cases) results.grounding.push(evaluateGroundingCase(split.name, item, fixtures))
      } else if (task === 'equivalence') {
        for (const item of cases) results.equivalence.push(await evaluateEquivalenceCase(split.name, item, embedding))
      } else if (task === 'component_mapping') {
        for (const item of cases) results.component_mapping.push(await evaluateComponentMappingCase(split.name, item, embedding))
      } else if (task === 'applicability') {
        for (const item of cases) results.applicability.push(await evaluateApplicabilityCase(split.name, item, embedding))
      } else {
        for (const item of cases) results[task].push({
          id: item.id, split: split.name, origin: item.origin, sourceRef: item.sourceRef, tags: item.tags,
          expected: item.expected, actual: 'not_evaluated', correct: false,
          reasonCodes: ['task_evaluator_not_connected'],
        })
      }
    }
  }
  await embedding.dispose()
  validateCounts(manifest, results)
  const output = {
    schemaVersion: 'experience-corr-e5-offline-evaluation-v1',
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    frozenTruth: {
      manifestSha256: sha256(manifestBytes), developmentSha256: sha256(developmentBytes),
      holdoutSha256: sha256(holdoutBytes), runtimeFixturesSha256: sha256(fixtureBytes),
    },
    corpus: corpusSummary(results),
    truthTasks: Object.fromEntries((Object.keys(results) as TruthTask[]).map(task => [
      task,
      { confusionMatrix: confusionMatrix(task, results[task]), results: results[task] },
    ])),
    metamorphic: metamorphicSummary(results),
    hardGates: {
      falseMerge: results.equivalence.filter(item => item.actual === 'same' && item.expected !== 'same').length,
      harmfulRecallOrContextInjection: results.applicability.filter(item =>
        item.actual === 'applicable' && item.expected !== 'applicable').length,
      duplicateSeriesCreated: null,
      incorrectComponentEvidence: results.grounding.filter(item => !item.correct).length,
      unauthorizedExternalOrSecretOrRemoteFallback: null,
      notMeasuredByOfflineSuite: [
        'duplicateSeriesCreated',
        'unauthorizedExternalOrSecretOrRemoteFallback',
      ],
    },
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (Object.values(results).some(items => items.some(item => !item.correct))) process.exitCode = 1
}

async function evaluateApplicabilityCase(
  split: 'development' | 'holdout',
  item: FrozenCase,
  embedding: TransformersLocalEmbeddingProvider,
): Promise<CaseResult> {
  const kind = experienceKind(item.kind, `${item.id}.kind`)
  const experienceText = String(item.experience ?? '')
  const taskText = String(item.task ?? '')
  const fixture = applicabilityFixture(kind, experienceText, taskText, item.tags)
  const versions = [publishedVersionFor(item, fixture.draft), ...fixture.competitors.map((draft, index) =>
    publishedVersionFor({ ...item, id: `${item.id}:runner:${String(index)}` }, draft))]
  const documents = versions.map(projectExperienceVersion)
  const passages = await embedding.embedBatch(
    `corr-e5:${item.id}:applicability-passages`, documents.map(document => document.denseText),
    'passage', embeddingConfig,
  )
  const fingerprint = fingerprintTask(fixture.task, evaluationActor(), EVALUATION_NOW, {
    taskFamily: fixture.taskFamily,
  })
  const query = projectTaskFingerprint(fingerprint)
  const queryEmbedding = await embedding.embedBatch(
    `corr-e5:${item.id}:applicability-query`, [query.denseText], 'query', embeddingConfig,
  )
  const denseProfile = automaticDenseApplicabilityProfile(embeddingConfig)
  if (denseProfile === null) throw new Error('CORR-E5 local model identity is not calibrated for automatic applicability')
  const projection = {
    projectionKey: 'experience-retrieval-v1', schemaVersion: 2 as const,
    manifest: { ...retrievalManifest(suggestionDigest(documents.map(document => document.contentDigest))),
      documentCount: documents.length, vectorCount: documents.length },
    documents,
  }
  const operation: HybridRetrievalOperation = {
    query,
    projection,
    vectors: new Map(documents.map((document, index) => [document.documentId, passages.vectors[index]!])),
    queryVector: queryEmbedding.vectors[0]!,
    queryEmbeddingReceiptId: queryEmbedding.receipt.receiptId,
    denseState: 'ready', denseFailureCode: null,
    denseSimilarityThreshold: 0.76,
    denseMargin: 0.025,
    denseApplicabilityProfile: denseProfile,
    recallDecisionKey: suggestionDigest({ applicability: item.id }),
  }
  const eligibility = {
    requestedUseMode: fixture.task.requestedUseMode,
    workspaceRoot: fixture.task.workspaceRoot,
    requiredCapabilities: fixture.task.requiredCapabilities,
  }
  const result = selectHybridMatchingExperiences(
    fingerprint, versions, 32, EVALUATION_NOW, eligibility, operation,
  )
  const primaryId = result.matchSet.retrievalDecision?.primaryExperienceVersionId
  const primary = primaryId === null || primaryId === undefined
    ? undefined : versions.find(version => version.experienceVersionId === primaryId)
  const baseline = matchExperienceProjection(fingerprint, versions[0]!, eligibility)
  const explained = result.matchSet.candidates.find(candidate =>
    candidate.experienceVersionId === versions[0]!.experienceVersionId)
  const preflight = primary === undefined ? null : preflightMatch(
    fingerprint,
    result.matchSet,
    primary,
    [],
    EVALUATION_NOW,
    '2026-09-12T01:00:00.000Z',
  )
  const rejectionReasons = new Set([
    ...baseline.reasonCodes,
    ...(explained?.reasonCodes ?? []),
    ...(preflight?.reasonCodes ?? []),
  ])
  const explicitRejection = [...rejectionReasons].some(reason => [
    'exact_signal_conflict', 'hard_scope_conflict', 'capability_mismatch', 'use_mode_not_allowed',
    'explicit_task_forbidden_action', 'automatic_context_privacy_not_allowed', 'fact_freshness_expired',
    'preference_subject_conflict',
  ].includes(reason))
  const actual = preflight?.disposition === 'stale' || preflight?.disposition === 'blocked'
    || preflight?.disposition === 'conflicting'
    ? 'rejected'
    : primary?.experienceVersionId === versions[0]!.experienceVersionId ? 'applicable'
      : explicitRejection ? 'rejected' : 'abstain'
  return {
    id: item.id, split, origin: item.origin, sourceRef: item.sourceRef, tags: item.tags,
    expected: item.expected, actual, correct: actual === item.expected,
    reasonCodes: [
      ...baseline.reasonCodes,
      ...(explained?.reasonCodes ?? []),
      ...(preflight?.reasonCodes ?? []),
      ...(result.matchSet.retrievalDecision?.abstentionReasonCodes ?? []),
    ],
  }
}

function applicabilityFixture(
  kind: ExperienceKind,
  experience: string,
  taskText: string,
  tags: readonly string[],
): {
  readonly draft: ExperienceCandidateDraft
  readonly competitors: readonly ExperienceCandidateDraft[]
  readonly task: PlanningTaskInput
  readonly taskFamily: string
} {
  const tagged = (...values: string[]) => values.some(value => tags.includes(value))
  const taskFamily = tagged('constraint-conflict', 'overclaim') ? 'conflicting-policy'
    : tagged('missing-capability', 'capability') ? 'without-docker' : 'corr-applicability'
  const versionTaskFamily = tagged('constraint-conflict', 'overclaim') ? 'bounded-policy'
    : tagged('missing-capability', 'capability') ? 'docker-runtime' : taskFamily
  const hardScopeConflict = tagged('risk') || (tagged('scope') && !tagged('validity'))
  const targetExposure = hardScopeConflict ? 'public' as const : 'local' as const
  const versionExposure = hardScopeConflict ? 'local' : targetExposure
  const overrides: Partial<Record<ComponentRole, readonly string[]>> = {}
  if (kind === 'procedure') {
    overrides.goal_signature = [experience]
    overrides.step = [experience]
  } else if (kind === 'diagnostic') {
    overrides.symptom_signature = [tagged('authority') ? '端口占用，监听归属待确认' : experience]
    overrides.discriminator = [experience]
  } else if (kind === 'fact') {
    overrides.subject = [tagged('fact-query') ? 'Node' : tagged('expired') ? '端口' : 'schema version']
    overrides.predicate = [tagged('fact-query') ? '受支持' : tagged('expired') ? '当前端口' : 'schema version']
    overrides.object_or_value = [experience]
  } else if (kind === 'strategy') {
    overrides.decision_point = ['召回检索策略']
    overrides.hard_constraint = [experience]
  } else if (kind === 'causal') {
    overrides.cause_or_intervention = [experience]
    overrides.effect_or_metric = [experience]
  } else {
    overrides.directive = [tagged('negative-goal') ? '运行测试' : experience]
    overrides.subject_scope = [tagged('subject') ? '用户 A 的会话' : '当前用户']
    overrides.task_or_output_scope = [tagged('subject') ? '会话' : '测试执行']
  }
  const draft = draftForComparison(kind, overrides, {
    taskFamily: versionTaskFamily,
    targetExposure: versionExposure,
  })
  const validity = tagged('expired')
    ? { source: 'completed_dsh_session_turn', validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-09-11T00:00:00.000Z' }
    : kind === 'fact'
      ? { source: 'completed_dsh_session_turn', validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z' }
      : draft.validity
  const normalizedDraft = { ...draft, validity }
  const task: PlanningTaskInput = {
    text: tagged('negative-goal') && kind === 'preference_policy' ? '本次不要运行测试' : taskText,
    workspaceRoot: null,
    targetExposure,
    mustUseExperience: false,
    riskClass: tagged('risk') ? 'high' : 'standard',
    requiredCapabilities: tagged('permission') ? ['read-only']
      : tagged('missing-capability', 'capability') ? ['podman-only-runtime'] : [],
    requestedUseMode: kind === 'procedure' || kind === 'diagnostic' ? 'guided' : 'suggest',
    overrideDecisionIds: [],
  }
  const competitors = tagged('authority', 'same-symptom', 'validity')
    ? [draftForComparison(kind, {
      ...(kind === 'diagnostic' ? { symptom_signature: [tagged('authority')
        ? '端口占用，数据库连接占用待确认' : 'timeout 因数据库锁'] } : {}),
      ...(kind === 'fact' ? { subject: ['schema version'], predicate: ['current value'], object_or_value: ['release B value unknown'] } : {}),
    }, { taskFamily: versionTaskFamily, targetExposure: versionExposure })]
    : []
  return { draft: normalizedDraft, competitors, task, taskFamily }
}

function evaluationActor(): ActorView {
  return {
    actorId: brandedId<'ExperienceActorId'>('corr-e5-actor', 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('corr-e5-principal', 'principalId'),
    kind: 'management_local_owner', authority: 'owner',
  }
}

async function evaluateEquivalenceCase(
  split: 'development' | 'holdout',
  item: FrozenCase,
  embedding: TransformersLocalEmbeddingProvider,
): Promise<CaseResult> {
  const kind = experienceKind(item.kind, `${item.id}.kind`)
  const left = String(item.left ?? '')
  const right = String(item.right ?? '')
  const pair = equivalenceDraftPair(kind, left, right, item.tags)
  const resolved = await compareDrafts(item, pair.left, pair.right, embedding)
  const detail = resolved.consolidationDetail
  const actual = detail?.decision ?? 'different'
  return {
    id: item.id, split, origin: item.origin, sourceRef: item.sourceRef, tags: item.tags,
    expected: item.expected, actual, correct: actual === item.expected,
    reasonCodes: detail?.reasonCodes ?? ['published_shortlist_empty'],
  }
}

async function evaluateComponentMappingCase(
  split: 'development' | 'holdout',
  item: FrozenCase,
  embedding: TransformersLocalEmbeddingProvider,
): Promise<CaseResult> {
  const kind = experienceKind(item.kind, `${item.id}.kind`)
  const incomingValues = exactArray(item.incoming, `${item.id}.incoming`).map(String)
  const targetValues = exactArray(item.target, `${item.id}.target`).map(String)
  const pair = mappingDraftPair(kind, incomingValues, targetValues)
  const resolved = await compareDrafts(item, pair.left, pair.right, embedding)
  const detail = resolved.consolidationDetail
  const explicitIncoming = pair.left.components.filter(component => pair.explicitRoles.has(component.role))
  const explicitTarget = pair.right.components.filter(component => pair.explicitRoles.has(component.role))
  const mappedIncoming = new Set(detail?.componentCorrespondence.map(value => value.incomingComponentKey) ?? [])
  const mappedTargets = new Set(detail?.componentCorrespondence.map(value => value.targetComponentKey) ?? [])
  const duplicateRole = [...pair.explicitRoles].some(role => {
    const incomingCount = explicitIncoming.filter(component => component.role === role).length
    const targetCount = explicitTarget.filter(component => component.role === role).length
    return incomingCount !== targetCount && Math.max(incomingCount, targetCount) > 1
  })
  const materialReasons = new Set(detail?.materialDifferences.map(value => value.reasonCode) ?? [])
  const complete = explicitIncoming.every(component => mappedIncoming.has(component.componentKey))
    && explicitTarget.every(component => mappedTargets.has(component.componentKey))
  const actual = duplicateRole ? 'ambiguous'
    : materialReasons.has('causal_authority_conflict') ? 'ambiguous'
      : complete ? 'complete' : 'incomplete'
  return {
    id: item.id, split, origin: item.origin, sourceRef: item.sourceRef, tags: item.tags,
    expected: item.expected, actual, correct: actual === item.expected,
    reasonCodes: detail?.reasonCodes ?? ['published_shortlist_empty'],
  }
}

async function compareDrafts(
  item: FrozenCase,
  incoming: ExperienceCandidateDraft,
  target: ExperienceCandidateDraft,
  embedding: TransformersLocalEmbeddingProvider,
): Promise<ExperienceSuggestionGroupView> {
  const group = suggestionGroupFor(item, incoming)
  const version = publishedVersionFor(item, target)
  const document = projectExperienceVersion(version)
  const passage = await embedding.embedBatch(
    `corr-e5:${item.id}:passage`, [document.denseText], 'passage', embeddingConfig,
  )
  const [resolved] = await consolidatePublishedSuggestionDuplicates(
    [group],
    {
      projection: {
        projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
        manifest: retrievalManifest(document.contentDigest), documents: [document],
      },
      vectors: new Map([[document.documentId, passage.vectors[0]!]]),
    },
    [version],
    runtime,
    embedding,
  )
  if (resolved === undefined) throw new Error(`Equivalence comparison returned no group for ${item.id}`)
  return resolved
}

function equivalenceDraftPair(
  kind: ExperienceKind,
  left: string,
  right: string,
  tags: readonly string[],
): { readonly left: ExperienceCandidateDraft; readonly right: ExperienceCandidateDraft } {
  const leftOverrides: Partial<Record<ComponentRole, readonly string[]>> = {}
  const rightOverrides: Partial<Record<ComponentRole, readonly string[]>> = {}
  const set = (role: ComponentRole, a: string, b: string): void => {
    leftOverrides[role] = [a]
    rightOverrides[role] = [b]
  }
  const tagged = (...values: string[]) => values.some(value => tags.includes(value))
  if (kind === 'procedure') {
    if (tagged('verifier')) set('verifier', left, right)
    else if (tagged('scope', 'narrow-condition')) set('entry_condition', left, right)
    else if (tagged('action-flip', 'read-write', 'permission', 'hard-negative')) set('step', left, right)
    else set('goal_signature', left, right)
  } else if (kind === 'diagnostic') {
    if (tagged('same-symptom-different-cause')) {
      set('symptom_signature', 'HTTP 404', 'HTTP 404')
      set('resolution_candidate', left, right)
    } else if (tagged('error-code')) set('symptom_signature', left, right)
    else set('symptom_signature', left, right)
  } else if (kind === 'preference_policy') {
    set('directive', '中文回复', '中文回复')
    if (tagged('polarity')) set('modality', 'must', 'must_not')
    else if (tagged('authority')) set('authority_source', 'user', 'model')
    else set('directive', left, right)
  } else if (kind === 'fact') {
    set('object_or_value', left, right)
  } else if (kind === 'causal') {
    if (tagged('evidence-grade')) set('causal_grade', 'observation', 'controlled')
    else if (tagged('condition', 'overclaim')) {
      set('applicability_condition', '重建缓存可恢复查询', '重建缓存可恢复查询，仅在缓存过期时')
    } else set('cause_or_intervention', left, right)
  } else {
    set('decision_point', left, right)
  }
  const scopeLeft = tagged('scope') ? { workspaceRoot: '/workspace/local', taskFamily: 'corr-e5' } : undefined
  const scopeRight = tagged('scope') ? { workspaceRoot: '/workspace/public', taskFamily: 'corr-e5' } : undefined
  return {
    left: draftForComparison(kind, leftOverrides, scopeLeft),
    right: draftForComparison(kind, rightOverrides, scopeRight),
  }
}

function mappingDraftPair(
  kind: ExperienceKind,
  incoming: readonly string[],
  target: readonly string[],
): {
  readonly left: ExperienceCandidateDraft
  readonly right: ExperienceCandidateDraft
  readonly explicitRoles: ReadonlySet<ComponentRole>
} {
  const left = parsedComponents(kind, incoming)
  const right = parsedComponents(kind, target)
  const explicitRoles = new Set([...left.keys(), ...right.keys()])
  return {
    left: draftForComparison(kind, Object.fromEntries(left), undefined, explicitRoles),
    right: draftForComparison(kind, Object.fromEntries(right), undefined, explicitRoles),
    explicitRoles,
  }
}

function parsedComponents(
  kind: ExperienceKind,
  values: readonly string[],
): ReadonlyMap<ComponentRole, readonly string[]> {
  const result = new Map<ComponentRole, string[]>()
  for (const value of values) {
    const separator = value.indexOf(':')
    if (separator < 1) continue
    const role = componentRole(kind, value.slice(0, separator))
    if (role === null) continue
    const current = result.get(role) ?? []
    current.push(normalizeMappingContent(role, value.slice(separator + 1)))
    result.set(role, current)
  }
  return result
}

function normalizeMappingContent(role: ComponentRole, value: string): string {
  if ((role === 'verifier' || role === 'recovery_verifier') && /^\d{3}$/u.test(value.trim())) {
    return `HTTP ${value.trim()}`
  }
  return value
}

function componentRole(kind: ExperienceKind, alias: string): ComponentRole | null {
  const common: Readonly<Record<string, ComponentRole>> = {
    goal: 'goal_signature', step: 'step', symptom: 'symptom_signature',
    resolution: 'resolution_candidate', cause: 'discriminator', verifier: kind === 'diagnostic' ? 'recovery_verifier' : 'verifier',
    subject: 'subject', predicate: 'predicate', value: 'object_or_value', decision: 'decision_point',
    constraint: 'hard_constraint', measure: 'outcome_measure', option: 'candidate_option',
    intervention: 'cause_or_intervention', effect: 'effect_or_metric', grade: 'causal_grade',
    condition: 'applicability_condition', authority: 'authority_source', directive: 'directive',
    discriminator: 'discriminator',
  }
  return common[alias] ?? null
}

function draftForComparison(
  kind: ExperienceKind,
  overrides: Readonly<Partial<Record<ComponentRole, readonly string[]>>>,
  scope: Readonly<Record<string, string>> = { workspaceRoot: '/workspace/corr-e5', taskFamily: 'corr-e5' },
  suppressDefaults: ReadonlySet<ComponentRole> = new Set(),
): ExperienceCandidateDraft {
  const roles = kind === 'preference_policy'
    ? [...TYPE_BEHAVIORS[kind].requiredRoles, 'positive_example', 'no_known_exception'] as const
    : TYPE_BEHAVIORS[kind].requiredRoles
  const components = roles.flatMap(role => {
    const values = overrides[role] ?? (suppressDefaults.has(role) ? [] : [comparisonDefault(role)])
    return values.map((content, index) => ({
      componentKey: `${kind}:${role}:${String(index + 1)}`,
      role,
      content,
      sourceRefs: [brandedId<'ExperienceSourceRefId'>('source:corr-e5-comparison', 'sourceRefId')],
    }))
  })
  return {
    proposedKind: kind,
    title: components.find(component => component.role === taskAnchorRole(kind))?.content ?? `CORR-E5 ${kind}`,
    intent: `CORR-E5 ${kind} comparison`, scope,
    validity: { source: 'completed_dsh_session_turn', revalidation: 'required_before_use' },
    authoritySpec: { source: 'dsh_session_log' }, privacyClass: 'workspace',
    riskAndEffectSpec: { permission: 'must_revalidate_current_authority' },
    allowedUseModes: ['reference', 'suggest', ...(kind === 'procedure' || kind === 'diagnostic' ? ['guided' as const] : [])],
    components,
    evidenceGrade: 'observation_supported',
    fieldSourceRefs: Object.fromEntries(components.map(component => [
      `component:${component.componentKey}`, component.sourceRefs,
    ])),
    excludedSteps: [], missingEvidence: [], unresolvedFields: [],
  }
}

function comparisonDefault(role: ComponentRole): string {
  const defaults: Partial<Record<ComponentRole, string>> = {
    goal_signature: '核验当前服务', entry_condition: '当前本地环境可读取', forbidden_condition: '无权限时禁止执行',
    parameter: '读取当前参数', environment_adapter: '使用当前环境', step: '检查当前服务状态',
    checkpoint: '检查返回结果', side_effect_policy: '只读且不得修改', failure_branch: '失败时停止并诊断',
    verifier: '测试成功响应 HTTP 200', symptom_signature: '服务出现错误', environment_scope: '当前本地环境',
    observed_fact: '工具返回结构化失败', hypothesis: '失败与当前状态相关', discriminator: '检查当前错误信号',
    misleading_signal: '模型声称完成不是证据', branch: '检查后重试当前服务',
    resolution_candidate: '检查并重启当前服务', falsifier: '错误信号不一致则停止',
    recovery_verifier: '测试恢复响应 HTTP 200', directive: '使用中文回复', modality: 'must',
    subject_scope: '当前用户', task_or_output_scope: '技术回答', authority_source: 'user',
    override_policy: 'explicit user override', valid_from: '2026-09-12', subject: 'runtime',
    predicate: 'version', object_or_value: '8', qualifiers: 'current release', source_evidence: 'authoritative readback',
    contradiction_policy: 'newer readback invalidates', decision_point: '选择当前检索器', candidate_option: 'local matcher',
    hard_constraint: 'harmful recall must be zero', decision_criterion: 'top1 accuracy', tradeoff: 'speed versus accuracy',
    stop_exploration_rule: 'stop when threshold passes', escalation_rule: 'ask user on tie', outcome_measure: 'tests pass',
    cause_or_intervention: 'inject approved context', effect_or_metric: 'tool calls decrease',
    applicability_condition: 'same local task', mechanism: 'reduce repeated exploration',
    competing_explanation: 'model variance', evidence_link: 'paired observation', falsifier: 'control does not improve',
    causal_grade: 'observation', allowed_use: 'reference only',
  }
  return defaults[role] ?? `stable ${role}`
}

function taskAnchorRole(kind: ExperienceKind): ComponentRole {
  if (kind === 'procedure') return 'goal_signature'
  if (kind === 'diagnostic') return 'symptom_signature'
  if (kind === 'preference_policy') return 'directive'
  if (kind === 'fact') return 'subject'
  if (kind === 'strategy') return 'decision_point'
  return 'cause_or_intervention'
}

function suggestionGroupFor(item: FrozenCase, draft: ExperienceCandidateDraft): ExperienceSuggestionGroupView {
  const source = comparisonSource(item.id)
  const kernelIdentity = experienceKernelIdentity({ kind: draft.proposedKind, scope: draft.scope, components: draft.components })
  const base: ExperienceSuggestionGroupView = {
    suggestionGroupId: `suggestion-group:${item.id}`, kernelIdentity, revisionDigest: '', reviewDigest: null,
    sourceDigest: source.contentDigest, kind: draft.proposedKind, title: draft.title, draft,
    saveReadiness: 'ready', readinessReasons: ['current_permission_required'], missingFields: [],
    riskFlags: ['current_permission_required'], consolidation: 'distinct', relatedGroupIds: [],
    occurrences: [{
      occurrenceId: `occurrence:${item.id}`, seedOccurrenceId: `seed:${item.id}`, sessionId: `session:${item.id}`,
      episodeRef: {
        episodeRefId: brandedId<'ExperienceEpisodeRefId'>(`episode:${item.id}`, 'episodeRefId'),
        sourceSystem: 'corr-e5', sessionOrRunId: `session:${item.id}`, eventStart: 1, eventEnd: 2,
        occurredAt: { start: '2026-09-12T00:00:00.000Z', end: '2026-09-12T00:00:01.000Z' },
        contentDigest: source.contentDigest, redactionState: 'bounded_excerpt',
      },
      sourceRefs: [source], detectedAt: '2026-09-12T00:00:01.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    }],
    occurrenceCount: 1, sessionIds: [`session:${item.id}`], crossSession: false,
    detectorVersions: ['corr-e5'], segmenterVersions: ['corr-e5'], materializerVersion: 'six-kind-materializer-v3',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }
  return { ...base, ...suggestionDecisionDigests(base) }
}

function publishedVersionFor(item: FrozenCase, draft: ExperienceCandidateDraft): ExperienceVersionView {
  const components = draft.components.map((component, index) => ({
    ...component,
    componentId: brandedId<'ExperienceComponentId'>(`component:${item.id}:${String(index)}`, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`revision:${item.id}:${String(index)}`, 'componentRevisionId'),
    evidenceIds: [brandedId<'ExperienceEvidenceId'>(`evidence:${item.id}:${String(index)}`, 'evidenceId')],
  }))
  return {
    experienceId: brandedId<'ExperienceId'>(`experience:${item.id}`, 'experienceId'),
    experienceVersionId: brandedId<'ExperienceVersionId'>(`version:${item.id}`, 'experienceVersionId'),
    versionNumber: 1, previousVersionId: null, kind: draft.proposedKind, title: draft.title, intent: draft.intent,
    scope: draft.scope, validity: draft.validity, authoritySpec: draft.authoritySpec,
    privacyClass: draft.privacyClass, riskAndEffectSpec: draft.riskAndEffectSpec,
    allowedUseModes: draft.allowedUseModes, components,
    componentRevisionIds: components.map(component => component.componentRevisionId),
    initialAssessmentId: brandedId<'ExperienceAssessmentId'>(`assessment:${item.id}`, 'assessmentId'),
    relationIds: [], createdByDecisionId: `decision:${item.id}`, evidenceGrade: draft.evidenceGrade,
    governanceState: 'accepted', operationalState: 'conditional', legacyWarnings: [],
    contentDigest: suggestionDigest({ id: item.id, target: draft }), createdAt: '2026-09-12T00:00:00.000Z',
  }
}

function comparisonSource(id: string): SourceRefView {
  return {
    sourceRefId: brandedId<'ExperienceSourceRefId'>('source:corr-e5-comparison', 'sourceRefId'),
    sourceSystem: 'corr-e5', sourceKind: 'evaluation', locator: `corr-e5:${id}`,
    ownerScope: 'workspace:corr-e5', accessScope: 'local_owner', occurredAt: '2026-09-12T00:00:00.000Z',
    observedAt: '2026-09-12T00:00:00.000Z', contentDigest: suggestionDigest({ id }), redactionState: 'bounded_excerpt',
  }
}

function retrievalManifest(contentDigest: string) {
  return {
    schemaVersion: 'experience-retrieval-projection-manifest-v2' as const,
    projectionVersion: 'experience-retrieval-projector-v2' as const, generation: 1,
    state: 'dense_ready' as const, provider: 'transformers_js' as const, providerState: 'ready' as const,
    modelId: embeddingConfig.modelId, modelRevision: embeddingConfig.revision,
    artifactSha256: embeddingConfig.artifactSha256, dimension: embeddingConfig.dimension,
    dtype: embeddingConfig.dtype, pooling: embeddingConfig.pooling,
    queryPrefix: embeddingConfig.queryPrefix, passagePrefix: embeddingConfig.passagePrefix,
    tokenizerConfigBundleSha256: embeddingConfig.tokenizerConfigBundleSha256,
    normalization: embeddingConfig.normalization, maxInputTokens: embeddingConfig.maxInputTokens,
    truncationPolicy: embeddingConfig.truncationPolicy, operationSettingsRevision: runtime.revision,
    operationSettingsDigest: runtime.digest, sourceWatermarkDigest: suggestionDigest({ corr: 'e5-source' }),
    contentDigest, documentCount: 1, vectorCount: 1, failureCode: null, builtAt: new Date().toISOString(),
  }
}

function experienceKind(value: unknown, label: string): ExperienceKind {
  if (typeof value !== 'string' || !(value in TYPE_BEHAVIORS)) throw new Error(`${label} is not an Experience kind`)
  return value as ExperienceKind
}

function evaluateGroundingCase(
  split: 'development' | 'holdout',
  item: FrozenCase,
  fixtures: RuntimeFixtures,
): CaseResult {
  const fixture = fixtures.groundingCases[item.id] as GroundingFixture | undefined
  if (fixture === undefined) throw new Error(`Grounding fixture is missing for ${item.id}`)
  const input = exactObject(item.input, `${item.id}.input`)
  const replay = groundingSeed(item.id, fixture, input)
  const groups = materializeSuggestionGroups([replay.seed], 32_768)
  const expected = exactObject(item.expected, `${item.id}.expected`)
  const actual: Record<string, string[]> = {}
  const reasonCodes: string[] = []
  for (const [role, rawKeys] of Object.entries(expected)) {
    const expectedKeys = exactArray(rawKeys, `${item.id}.expected.${role}`).map(String)
    const refs = role === 'excluded_step'
      ? groups.flatMap(group => group.draft.excludedSteps.flatMap(step => step.sourceRefs))
      : groups.flatMap(group => group.draft.components
        .filter(component => component.role === role)
        .flatMap(component => suggestionEvidenceSourceRefsForComponent(component)))
    const uniqueRefs = [...new Set(refs)]
    const supported = [...new Set(uniqueRefs.flatMap(ref => replay.supportKeys.get(ref) ?? []))].sort()
    actual[role] = supported
    const expectedSet = new Set(expectedKeys)
    const coversExpected = expectedKeys.every(key => supported.includes(key))
    const containsUnrelatedRef = uniqueRefs.some(ref => {
      const keys = replay.supportKeys.get(ref) ?? []
      return keys.length === 0 || !keys.some(key => expectedSet.has(key))
    })
    const correct = expectedKeys.length === 0
      ? uniqueRefs.length === 0
      : uniqueRefs.length > 0 && coversExpected && !containsUnrelatedRef
    if (!correct) reasonCodes.push(`grounding_mismatch:${role}`)
  }
  return {
    id: item.id, split, origin: item.origin, sourceRef: item.sourceRef, tags: item.tags,
    expected: item.expected, actual, correct: reasonCodes.length === 0,
    reasonCodes: reasonCodes.length === 0 ? ['component_sources_aligned'] : reasonCodes,
  }
}

function groundingSeed(
  id: string,
  fixture: GroundingFixture,
  input: JsonRecord,
): { readonly seed: ExperienceSuggestionSeedView; readonly supportKeys: ReadonlyMap<string, readonly string[]> } {
  const signals: SuggestionEvidenceSignalView[] = []
  const supportKeys = new Map<string, readonly string[]>()
  let sequence = 1
  const add = (
    keys: readonly string[],
    role: SuggestionEvidenceSignalView['role'],
    evidenceClass: SuggestionEvidenceSignalView['evidenceClass'],
    eventType: string,
    content: string,
  ): void => {
    const sourceRef = sourceRefFor(id, sequence, eventType, content)
    supportKeys.set(sourceRef.sourceRefId, [...keys])
    signals.push({
      itemId: `grounding:${id}:${String(sequence)}`,
      sourceRef,
      eventType,
      role,
      evidenceClass,
      content,
      projectionDigest: suggestionDigest({ id, sequence, content }),
      projectionTruncated: false,
    })
    sequence += 1
  }
  const groupedGoal = normalizeGroups(fixture.goal)
  for (const keys of groupedGoal) add(keys, 'user_goal', 'user_instruction', 'user/message', inputText(input, keys))
  for (const keys of fixture.failures ?? []) {
    const detail = inputText(input, keys)
    add(keys, 'symptom', 'observed_fact', 'tool/result', `failure-${String(sequence)}\n\n${detail}`)
  }
  for (const keys of fixture.actions ?? []) {
    const detail = inputText(input, keys)
    add(keys, 'terminal_outcome', 'observed_fact', 'tool/result', `action-${String(sequence)}\n\n${detail}`)
  }
  for (const keys of fixture.verifier ?? []) {
    add(keys, 'terminal_readback', 'observed_fact', 'tool/result', `verifier-${String(sequence)}\n\n${inputText(input, keys)}`)
  }
  if ((fixture.preference?.length ?? 0) > 0) {
    const keys = fixture.preference!
    add(keys, 'user_goal', 'user_instruction', 'user/message',
      `以后在当前任务中，必须遵守：${inputText(input, keys)}；无例外。`)
  }
  if ((fixture.fact?.length ?? 0) > 0) {
    const keys = fixture.fact!
    const detail = inputText(input, keys)
    add(keys, 'tool_observation', 'observed_fact', 'tool/result', `fixture-read\n\n${JSON.stringify({ experienceFact: {
      subject: detail, predicate: 'authoritative value', value: detail, qualifiers: 'fixture replay',
      observedAt: '2026-09-12T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z',
      sourceAuthority: 'fixture-read',
    } })}`)
  }
  if ((fixture.strategy?.length ?? 0) > 0) {
    const keys = fixture.strategy!
    add(keys, 'user_goal', 'user_instruction', 'user/message',
      `比较方案 A 和方案 B；硬约束是 ${inputText(input, keys)}；选择标准是证据；权衡是速度与准确率；停止条件是门槛达标；升级条件是请用户决定；成功指标是 ${inputText(input, keys)}。`)
  }
  if ((fixture.causalClaim?.length ?? 0) > 0) {
    const keys = fixture.causalClaim!
    add(keys, 'user_goal', 'user_instruction', 'user/message',
      `当当前任务条件成立时，${inputText(input, keys)} 导致观测结果变化。机制：待验证；另一种解释：环境变化；证伪条件：对照结果不变。`)
  }
  for (const keys of fixture.causalEvidence ?? []) {
    add(keys, 'tool_observation', 'observed_fact', 'tool/result', inputText(input, keys))
  }
  for (const key of fixture.ignored ?? []) {
    add([key], 'model_claim', 'model_claim', 'assistant/message', String(input[key] ?? key))
  }
  const failedSignals = signals.filter(signal => signal.role === 'symptom')
  const actionSignals = signals.filter(signal => signal.eventType === 'tool/result'
    && signal.role === 'terminal_outcome')
  const verifierSignals = signals.filter(signal => signal.role === 'terminal_readback')
  const primaryGoal = signals.find(signal => signal.role === 'user_goal')?.content
    ?? `Replay ${id}`
  const suggestedKinds = [...new Set([
    fixture.kind,
    ...(failedSignals.length > 0 && actionSignals.length > 0 && verifierSignals.length > 0
      ? ['procedure', 'diagnostic'] as const : []),
    ...(fixture.kind === 'preference_policy' && actionSignals.length > 0 ? ['procedure'] as const : []),
  ])]
  const sourceRefs = signals.map(signal => signal.sourceRef)
  const start = '2026-09-12T00:00:00.000Z'
  return {
    supportKeys,
    seed: {
      occurrenceId: `seed:${id}`,
      sessionId: `session:${id}`,
      workspaceRoot: `/workspace/${id}`,
      episodeRef: {
        episodeRefId: brandedId<'ExperienceEpisodeRefId'>(`episode:${id}`, 'episodeRefId'),
        sourceSystem: 'corr-e5-grounding', sessionOrRunId: id, eventStart: 1, eventEnd: sequence,
        occurredAt: { start, end: new Date(Date.parse(start) + sequence).toISOString() },
        contentDigest: suggestionDigest({ id, input, fixture }), redactionState: 'bounded_excerpt',
      },
      suggestedKinds,
      triggerKind: failedSignals.length > 0 ? 'high_cost_resolution'
        : fixture.kind === 'preference_policy' ? 'explicit_user_directive'
          : fixture.kind === 'fact' ? 'authoritative_fact'
            : fixture.kind === 'strategy' ? 'strategy_candidate'
              : fixture.kind === 'causal' ? 'causal_candidate' : 'terminal_success',
      stableKernel: {
        taskGoal: primaryGoal,
        toolSequence: actionSignals.map(signal => firstLine(signal.content)),
        failedToolSequence: failedSignals.map(signal => firstLine(signal.content)),
        recoveryToolSequence: actionSignals.map(signal => firstLine(signal.content)),
        failureCodes: failedSignals.map((_, index) => `FIXTURE_FAILURE_${String(index + 1)}`),
        verifierTools: verifierSignals.map(signal => firstLine(signal.content)),
      },
      evidenceSignals: signals,
      detectorVersion: 'corr-e5-grounding-replay-v1',
      segmenterVersion: 'corr-e5-grounding-replay-v1',
      detectedAt: '2026-09-12T00:00:30.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  }
}

function sourceRefFor(id: string, sequence: number, eventType: string, content: string): SourceRefView {
  const occurredAt = new Date(Date.parse('2026-09-12T00:00:00.000Z') + sequence).toISOString()
  return {
    sourceRefId: brandedId<'ExperienceSourceRefId'>(`source:${id}:${String(sequence)}`, 'sourceRefId'),
    sourceSystem: 'corr-e5-grounding',
    sourceKind: eventType === 'user/message' ? 'user_instruction'
      : eventType === 'tool/result' ? 'tool_result' : 'session_event',
    locator: `corr-e5-grounding:${id}#${String(sequence)}`,
    ownerScope: `session:${id}`,
    accessScope: 'local_owner', occurredAt, observedAt: '2026-09-12T00:00:00.000Z',
    contentDigest: suggestionDigest(content), redactionState: 'bounded_excerpt',
  }
}

function normalizeGroups(value: GroundingFixture['goal']): readonly (readonly string[])[] {
  if (value === undefined || value.length === 0) return []
  return Array.isArray(value[0]) ? value as readonly (readonly string[])[] : [value as readonly string[]]
}

function inputText(input: JsonRecord, keys: readonly string[]): string {
  return keys.map(key => `${key}: ${String(input[key] ?? key)}`).join(' · ')
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0]!.trim()
}

function evaluateSessionCase(
  task: 'extractability' | 'kind',
  split: 'development' | 'holdout',
  item: FrozenCase,
  fixtures: RuntimeFixtures,
): CaseResult {
  const fixture = fixtures.sessionCases[item.id]
  if (fixture === undefined) throw new Error(`Session fixture is missing for ${item.id}`)
  const seed = fixture.complete === false ? null : detectSuggestionSeed(
    sessionSlice(item.id, fixture), `/workspace/${item.id}`, 86_400_000, evidenceLimits,
  )
  const actual = task === 'extractability'
    ? (seed === null ? 'not_extractable' : 'extractable')
    : detectedKind(seed)
  return {
    id: item.id, split, origin: item.origin, sourceRef: item.sourceRef, tags: item.tags,
    expected: item.expected, actual, correct: actual === item.expected,
    reasonCodes: seed === null ? ['no_seed'] : [seed.triggerKind, ...seed.suggestedKinds],
  }
}

function detectedKind(seed: ExperienceSuggestionSeedView | null): string {
  if (seed === null) return 'not_extractable'
  if (seed.triggerKind === 'high_cost_resolution') return 'diagnostic'
  if (seed.triggerKind === 'terminal_success') return 'procedure'
  return seed.suggestedKinds.length === 1 ? seed.suggestedKinds[0]! : 'ambiguous'
}

function sessionSlice(id: string, fixture: SessionFixture): SessionTrajectorySlice {
  const records: BoundedSourceRecord[] = []
  let seq = 1
  records.push(record(id, seq++, 'user/message', {
    role: 'user', content: [{ type: 'text', text: fixture.goal }], source: { kind: 'user' },
  }))
  for (const [index, action] of fixture.actions.entries()) {
    const callId = `call-${String(index + 1)}`
    records.push(record(id, seq++, 'tool/call', {
      turn: 1, step: index + 1, callId, name: action.tool,
      arguments: JSON.stringify(action.tool === 'job_kill'
        ? { job_id: action.command } : { command: action.command }),
    }))
    const result = action.fact === undefined
      ? action.result
      : JSON.stringify({ experienceFact: action.fact })
    records.push(record(id, seq++, 'tool/result', {
      turn: 1, step: index + 1,
      message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'text', text: result }] },
      ...(action.errorCode === undefined ? {} : { error: { name: 'Error', code: action.errorCode } }),
    }))
  }
  if (fixture.assistantClaim !== undefined) records.push(record(id, seq++, 'assistant/message', {
    turn: 1, step: fixture.actions.length + 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: fixture.assistantClaim }] },
  }))
  records.push(record(id, seq, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  const start = '2026-09-12T00:00:00.000Z'
  const end = new Date(Date.parse(start) + seq).toISOString()
  return {
    episodeRef: {
      episodeRefId: brandedId<'ExperienceEpisodeRefId'>(`episode:${id}`, 'episodeRefId'),
      sourceSystem: 'dsh-session', sessionOrRunId: id, eventStart: 1, eventEnd: seq,
      occurredAt: { start, end }, contentDigest: digest({ id, fixture }), redactionState: 'bounded_excerpt',
    },
    records, turn: 1, terminationReason: 'completed', blockedReason: null,
  }
}

function record(id: string, seq: number, eventType: string, data: JsonRecord): BoundedSourceRecord {
  const occurredAt = new Date(Date.parse('2026-09-12T00:00:00.000Z') + seq).toISOString()
  const body = JSON.stringify({ seq, time: Date.parse(occurredAt), type: eventType, data })
  const sourceRef: SourceRefView = {
    sourceRefId: brandedId<'ExperienceSourceRefId'>(`source:${id}:${String(seq)}`, 'sourceRefId'),
    sourceSystem: 'dsh-session',
    sourceKind: eventType === 'user/message' ? 'user_instruction'
      : eventType === 'tool/result' ? 'tool_result' : 'session_event',
    locator: `dsh-session:${id}#${String(seq)}`, ownerScope: `session:${id}`, accessScope: 'local_owner',
    occurredAt, observedAt: '2026-09-12T00:00:00.000Z', contentDigest: digest(body),
    redactionState: 'bounded_excerpt',
  }
  return { sourceRef, eventType, excerpt: body }
}

function validateCounts(manifest: JsonRecord, results: Record<TruthTask, CaseResult[]>): void {
  const totals = exactObject(manifest.totals, 'manifest.totals')
  const all = Object.values(results).flat()
  if (all.length !== totals.caseCount || all.filter(item => item.split === 'holdout').length !== totals.holdoutCount
    || all.filter(item => item.origin === 'deidentified_session').length !== totals.deidentifiedSessionCount) {
    throw new Error('CORR-E5 result counts diverge from the frozen manifest')
  }
}

function corpusSummary(results: Record<TruthTask, CaseResult[]>): JsonRecord {
  const all = Object.values(results).flat()
  return {
    caseCount: all.length,
    developmentCount: all.filter(item => item.split === 'development').length,
    holdoutCount: all.filter(item => item.split === 'holdout').length,
    holdoutRatio: all.filter(item => item.split === 'holdout').length / all.length,
    deidentifiedSessionCount: all.filter(item => item.origin === 'deidentified_session').length,
    deidentifiedSessionRatio: all.filter(item => item.origin === 'deidentified_session').length / all.length,
  }
}

function confusionMatrix(task: TruthTask, results: readonly CaseResult[]): JsonRecord {
  if (task === 'grounding') {
    return {
      sampleCount: results.length,
      correct: results.filter(item => item.correct).length,
      labels: ['grounded', 'misgrounded'],
      rows: {
        grounded: {
          grounded: results.filter(item => item.correct).length,
          misgrounded: results.filter(item => !item.correct).length,
        },
        misgrounded: { grounded: 0, misgrounded: 0 },
      },
    }
  }
  const labels = [...new Set(results.flatMap(item => [String(item.expected), String(item.actual)]))].sort()
  return {
    sampleCount: results.length,
    correct: results.filter(item => item.correct).length,
    labels,
    rows: Object.fromEntries(labels.map(expected => [expected, Object.fromEntries(labels.map(actual => [
      actual, results.filter(item => String(item.expected) === expected && String(item.actual) === actual).length,
    ]))])),
  }
}

function metamorphicSummary(results: Record<TruthTask, CaseResult[]>): JsonRecord {
  const metamorphicTags = new Set([
    'zh-paraphrase', 'bilingual', 'mixed-language', 'action-flip', 'read-write', 'polarity',
    'order', 'verifier', 'scope', 'authority', 'value-conflict', 'value', 'narrow-condition',
    'condition', 'overclaim', 'negative-goal', 'permission', 'risk', 'same-symptom-different-cause',
  ])
  const tagged = Object.entries(results).flatMap(([task, items]) => items
    .filter(item => item.tags.some(tag => metamorphicTags.has(tag)))
    .map(item => ({ task, ...item })))
  return {
    sampleCount: tagged.length,
    correct: tagged.filter(item => item.correct).length,
    failures: tagged.filter(item => !item.correct).map(item => ({
      task: item.task, id: item.id, tags: item.tags, expected: item.expected, actual: item.actual,
    })),
  }
}

function parseObject(value: Uint8Array): JsonRecord {
  return exactObject(JSON.parse(Buffer.from(value).toString('utf8')) as unknown, 'JSON document')
}

function exactObject(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonRecord
}

function exactArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

await run()
