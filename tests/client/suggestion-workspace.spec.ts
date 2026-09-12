import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { suggestionDigest } from '../../src/domain/automatic-suggestion.js'
import { brandedId } from '../../src/ids.js'
import type { ExperienceStore, ViewState } from '../../src/client/store.js'
import type { ExperienceSuggestionGroupView, SuggestionProjectionView } from '../../src/types.js'

const require = createRequire(import.meta.url)
const temp = mkdtempSync(join(tmpdir(), 'suggestion-workspace-'))
let renderSuggestionWorkbench: (props: unknown) => unknown
let zh: Record<string, string>

beforeAll(async () => {
  const source = readFileSync('src/client/workspace.tsx', 'utf8')
  await build({
    stdin: {
      contents: source + '\nexport { SuggestionWorkbench as __suggestionWorkbench, zh as __suggestionZh };',
      resolveDir: join(process.cwd(), 'src/client'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(temp, 'render.cjs'),
    jsx: 'automatic',
    plugins: [{ name: 'test-runtime', setup(plugin) {
      plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }))
      plugin.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({
        path: 'primitives', namespace: 'suggestion-review',
      }))
      plugin.onLoad({ filter: /.*/, namespace: 'suggestion-review' }, () => ({
        contents: 'export const Button=({children,...props})=>({type:"button",props:{...props,children}});export const Pill=Button;export const StateDot=Button;export const IconCheckOutline14=()=>null;export const IconRefreshOutline14=()=>null;export const IconCloseOutline16=()=>null;export const IconPanelLeftOutline16=()=>null;',
        loader: 'js',
      }))
      plugin.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' }))
    } }],
  })
  const module = require(join(temp, 'render.cjs')) as {
    __suggestionWorkbench: (props: unknown) => unknown
    __suggestionZh: Record<string, string>
  }
  renderSuggestionWorkbench = module.__suggestionWorkbench
  zh = module.__suggestionZh
})

afterAll(() => rmSync(temp, { recursive: true, force: true }))

describe('E3 Experience Tab suggestion decision surface', () => {
  it('renders one consolidated card and invokes the single ready-save action', () => {
    const group = suggestionGroup('ready')
    const dismissSuggestion = vi.fn(async () => {})
    const saveSuggestion = vi.fn(async () => {})
    const root = render('recent_suggestions', [group], dismissSuggestion, saveSuggestion, 1)
    const nodes = flatten(root)
    const text = nodes.map(nodeText).join(' ')

    expect(nodes.filter(node => node.props['data-testid'] === 'experience-suggestion-card')).toHaveLength(1)
    expect(text).toContain('跨会话')
    expect(text).toMatch(/出现次数\s*:?\s*2/u)
    expect(text).toContain('已验证路径')
    expect(text).toContain('适用前提')
    expect(text).toContain('失败分支')
    expect(text).toContain('成功验证')
    expect(text).toMatch(/保留期内已处理\s*:?\s*1/u)
    const save = nodes.find(node => node.type === 'button' && nodeText(node).includes('保存为经验'))
    expect(save?.props.disabled).toBe(false)
    expect(save?.props.onClick).toBeTypeOf('function')
    ;(save!.props.onClick as () => void)()
    expect(saveSuggestion).toHaveBeenCalledWith(group)

    const dismiss = nodes.find(node => node.type === 'button' && nodeText(node) === '不保存')
    expect(dismiss?.props.onClick).toBeTypeOf('function')
    ;(dismiss!.props.onClick as () => void)()
    expect(dismissSuggestion).toHaveBeenCalledWith(group, 'not_reusable')
  })

  it('keeps possible duplicates review-only and does not expose raw reason codes in the workbench', () => {
    const group = {
      ...suggestionGroup('needs_review'),
      consolidation: 'possible_duplicate' as const,
      readinessReasons: ['possible_duplicate'],
      reviewDigest: null,
    }
    const nodes = flatten(render('needs_attention', [group], vi.fn(async () => {})))
    const text = nodes.map(nodeText).join(' ')

    expect(text).toContain('需审阅')
    expect(text).toContain('需要先核对边界')
    expect(text).not.toContain('possible_duplicate')
    expect(nodes.some(node => node.type === 'button' && nodeText(node).includes('保存为经验'))).toBe(false)
  })

  it('explains a vector-only duplicate shortlist without claiming semantic identity', () => {
    const group = {
      ...suggestionGroup('needs_review'),
      consolidation: 'possible_duplicate' as const,
      readinessReasons: ['semantic_duplicate_vector_only_unverified'],
      reviewDigest: null,
    }
    const nodes = flatten(render('needs_attention', [group], vi.fn(async () => {})))
    const text = nodes.map(nodeText).join(' ')

    expect(text).toContain('本地语义模型只找到了相似候选，尚未证明是同一条经验')
    expect(text).not.toContain('semantic_duplicate_vector_only_unverified')
    expect(text).not.toContain('语义相同，将合并到已有经验')
    expect(nodes.some(node => node.type === 'button' && nodeText(node).includes('保存为经验'))).toBe(false)
  })

  it('explains that saving a semantic duplicate only attaches Session evidence', () => {
    const group = {
      ...suggestionGroup('ready'),
      consolidation: 'semantic_duplicate' as const,
      canonicalMatch: {
        experienceId: brandedId<'ExperienceId'>('experience:existing', 'experienceId'),
        experienceVersionId: brandedId<'ExperienceVersionId'>('experience-version:existing', 'experienceVersionId'),
        versionContentDigest: suggestionDigest({ existing: true }),
        title: '已有的插件排错经验',
        intent: '稳定完成插件排错',
        similarity: 0.98,
        retrievalGeneration: 2,
        modelId: 'test/e5',
        modelRevision: 'r1',
      },
      relatedExperienceVersionIds: [
        brandedId<'ExperienceVersionId'>('experience-version:existing', 'experienceVersionId'),
      ],
    }
    const nodes = flatten(render('recent_suggestions', [group], vi.fn(async () => {})))
    const text = nodes.map(nodeText).join(' ')

    expect(text).toContain('语义相同，将合并到已有经验')
    expect(text).toContain('不会新建重复经验')
    expect(text).toContain('已有的插件排错经验')
    expect(nodes.some(node => node.type === 'button' && nodeText(node).includes('保存为经验'))).toBe(true)
  })

  it('renders the Host-projected ambiguous ownership choice and submits its exact target', () => {
    const base = suggestionGroup('needs_review')
    const targetExperienceId = brandedId<'ExperienceId'>('experience:existing', 'experienceId')
    const targetExperienceVersionId = brandedId<'ExperienceVersionId'>(
      'experience-version:existing', 'experienceVersionId',
    )
    const group: ExperienceSuggestionGroupView = {
      ...base,
      saveReadiness: 'needs_review',
      readinessReasons: ['semantic_duplicate_ambiguous'],
      reviewDigest: `sha256:${'f'.repeat(64)}`,
      consolidation: 'possible_duplicate',
      canonicalMatch: {
        experienceId: targetExperienceId,
        experienceVersionId: targetExperienceVersionId,
        versionContentDigest: `sha256:${'1'.repeat(64)}`,
        title: '已有经验', intent: '已有经验说明', similarity: 0.98,
        retrievalGeneration: 2, modelId: 'test/e5', modelRevision: 'r1',
      },
      consolidationDetail: {
        algorithmVersion: 'experience-equivalence-v1', decision: 'ambiguous',
        reasonCodes: ['published_shortlist_margin_ambiguous'],
        sourceSuggestionGroupIds: [base.suggestionGroupId],
        sourceGroups: [{
          suggestionGroupId: base.suggestionGroupId, kernelIdentity: base.kernelIdentity,
          revisionDigest: base.revisionDigest,
          occurrenceIds: base.occurrences.map(occurrence => occurrence.occurrenceId),
        }],
        targetExperienceId, targetExperienceVersionId,
        targetVersionContentDigest: `sha256:${'1'.repeat(64)}`,
        retrievalGeneration: 2,
        modelIdentityDigest: `sha256:${'2'.repeat(64)}`,
        operationSettingsDigest: `sha256:${'3'.repeat(64)}`,
        activeComparisonSetDigest: `sha256:${'4'.repeat(64)}`,
        allowedOwnerChoices: ['attach_existing'],
        componentCorrespondence: base.draft.components.map(component => ({
          incomingSuggestionGroupId: base.suggestionGroupId,
          incomingComponentKey: component.componentKey, incomingRole: component.role,
          incomingContentDigest: suggestionDigest(component.content),
          targetComponentKey: component.componentKey,
          targetComponentRevisionId: `revision:${component.componentKey}`,
          targetRole: component.role, targetContentDigest: suggestionDigest(component.content),
          matchBasis: 'exact',
        })),
        materialDifferences: [],
      },
    }
    const saveSuggestion = vi.fn(async () => {})
    const nodes = flatten(render('needs_attention', [group], vi.fn(async () => {}), saveSuggestion))
    const attach = nodes.find(node => node.type === 'button' && nodeText(node) === '归入已有经验')

    expect(attach?.props.onClick).toBeTypeOf('function')
    ;(attach!.props.onClick as () => void)()
    expect(saveSuggestion).toHaveBeenCalledWith(group, {
      choice: 'attach_existing', targetExperienceVersionId, materialDifferences: [],
    })
    expect(nodes.some(node => node.type === 'button' && nodeText(node) === '保存为经验')).toBe(false)
  })

  it('renders all four semantic kinds while withholding save from Strategy and Causal candidates', () => {
    const groups = [
      semanticGroup('preference_policy', 'ready', ['current_user_authority_required']),
      semanticGroup('fact', 'ready', ['freshness_revalidation_required']),
      semanticGroup('strategy', 'needs_review', ['human_decision_required']),
      semanticGroup('causal', 'needs_review', ['causal_promotion_required']),
    ]
    const nodes = flatten(render('recent_suggestions', groups, vi.fn(async () => {})))
    const text = nodes.map(nodeText).join(' ')

    expect(text).toContain('偏好策略')
    expect(text).toContain('事实经验')
    expect(text).toContain('决策策略')
    expect(text).toContain('因果经验')
    expect(text).toContain('事实使用前必须核对新鲜度')
    expect(text).toContain('因果候选不得由模型或单次成功自动晋级')
    expect(nodes.filter(node => node.type === 'button' && nodeText(node).includes('保存为经验'))).toHaveLength(2)
  })
})

function render(
  section: 'recent_suggestions' | 'cross_session' | 'needs_attention',
  groups: readonly ExperienceSuggestionGroupView[],
  dismissSuggestion: ExperienceStore['dismissSuggestion'],
  saveSuggestion: ExperienceStore['saveSuggestion'] = vi.fn(async () => {}),
  suppressedGroupCount = 0,
): unknown {
  const state = {
    phase: 'ready', candidates: [], planningResults: [], proposalStatus: 'idle', running: false,
    suggestions: projection(groups, suppressedGroupCount),
  } satisfies ViewState
  return renderSuggestionWorkbench({
    state,
    store: { dismissSuggestion, saveSuggestion } as ExperienceStore,
    section,
    selectedGroupId: null,
    selectGroup: vi.fn(),
    t: (key: string) => zh[key] ?? key,
  })
}

function suggestionGroup(
  readiness: ExperienceSuggestionGroupView['saveReadiness'],
): ExperienceSuggestionGroupView {
  const components = [
    ['step', '读取配置 → 执行测试'],
    ['entry_condition', '目标、工作区和权限一致时才使用。'],
    ['failure_branch', '失败时停止复用并重新诊断。'],
    ['verifier', '测试返回结构化成功时才完成。'],
  ].map(([role, content], index) => ({
    componentKey: `procedure:${role}:${String(index)}`,
    role: role as ExperienceSuggestionGroupView['draft']['components'][number]['role'],
    content: content!,
    sourceRefs: ['source:a'],
  }))
  const occurrences = ['session-a', 'session-b'].map((sessionId, index) => ({
    occurrenceId: `occurrence:${sessionId}`,
    seedOccurrenceId: `seed-occurrence:${sessionId}`,
    sessionId,
    episodeRef: {
      episodeRefId: `episode:${sessionId}` as never,
      sourceSystem: 'dsh-session' as const,
      sessionOrRunId: sessionId,
      eventStart: 0,
      eventEnd: 9,
      occurredAt: { start: '2026-09-10T08:00:00.000Z', end: '2026-09-10T08:01:00.000Z' },
      contentDigest: `sha256:${String(index + 1).repeat(64)}`,
      redactionState: 'bounded_excerpt' as const,
    },
    sourceRefs: [{
      sourceRefId: `source:${sessionId}` as never,
      sourceSystem: 'dsh-session' as const,
      sourceKind: 'tool_result' as const,
      locator: `dsh-session:${sessionId}#8`,
      ownerScope: `session:${sessionId}`,
      accessScope: 'local_owner' as const,
      occurredAt: '2026-09-10T08:01:00.000Z',
      observedAt: '2026-09-10T08:01:00.000Z',
      contentDigest: `sha256:${String(index + 3).repeat(64)}`,
      redactionState: 'bounded_excerpt' as const,
    }],
    detectedAt: '2026-09-10T08:01:00.000Z',
    expiresAt: '2026-09-24T08:01:00.000Z',
  }))
  return {
    suggestionGroupId: 'suggestion-group:shared',
    kernelIdentity: `sha256:${'a'.repeat(64)}`,
    revisionDigest: `sha256:${'b'.repeat(64)}`,
    sourceDigest: `sha256:${'c'.repeat(64)}`,
    kind: 'procedure',
    title: '可复用流程：构建并验证项目',
    draft: {
      proposedKind: 'procedure', title: '可复用流程', intent: '减少构建与验证中的重复试错。',
      scope: { workspace: '/workspace' }, validity: { source: 'session' },
      authoritySpec: { decision: 'owner_review' }, privacyClass: 'workspace',
      riskAndEffectSpec: { execution: 'not_authorized' }, allowedUseModes: ['reference'],
      components, evidenceGrade: 'observation_supported', fieldSourceRefs: {}, excludedSteps: [],
      missingEvidence: [], unresolvedFields: [],
    },
    saveReadiness: readiness,
    readinessReasons: [],
    missingFields: [],
    riskFlags: ['current_permission_required', 'tool_side_effects_not_authorized'],
    reviewDigest: readiness === 'ready' ? `sha256:${'d'.repeat(64)}` : null,
    consolidation: 'exact',
    relatedGroupIds: [],
    occurrences,
    occurrenceCount: 2,
    sessionIds: ['session-a', 'session-b'],
    crossSession: true,
    detectorVersions: ['detector-v1'],
    segmenterVersions: ['segmenter-v1'],
    materializerVersion: 'materializer-v1',
    expiresAt: '2026-09-24T08:01:00.000Z',
  }
}

function semanticGroup(
  kind: Exclude<ExperienceSuggestionGroupView['kind'], 'procedure' | 'diagnostic'>,
  readiness: ExperienceSuggestionGroupView['saveReadiness'],
  riskFlags: readonly string[],
): ExperienceSuggestionGroupView {
  const base = suggestionGroup(readiness)
  const roles: Record<Exclude<ExperienceSuggestionGroupView['kind'], 'procedure' | 'diagnostic'>, readonly string[]> = {
    preference_policy: ['directive', 'task_or_output_scope', 'override_policy', 'authority_source'],
    fact: ['object_or_value', 'qualifiers', 'contradiction_policy', 'source_evidence'],
    strategy: ['candidate_option', 'hard_constraint', 'stop_exploration_rule', 'outcome_measure'],
    causal: ['cause_or_intervention', 'applicability_condition', 'competing_explanation', 'causal_grade'],
  }
  const components = roles[kind].map((role, index) => ({
    componentKey: `${kind}:${role}:${String(index)}`,
    role: role as ExperienceSuggestionGroupView['draft']['components'][number]['role'],
    content: `${role} content`,
    sourceRefs: ['source:a'],
  }))
  return {
    ...base,
    suggestionGroupId: `suggestion-group:${kind}`,
    kind,
    title: `${kind} suggestion`,
    draft: { ...base.draft, proposedKind: kind, components },
    riskFlags,
    reviewDigest: readiness === 'ready' ? `sha256:${kind.padEnd(64, 'a').slice(0, 64)}` : null,
  }
}

function projection(
  groups: readonly ExperienceSuggestionGroupView[],
  suppressedGroupCount = 0,
): SuggestionProjectionView {
  return {
    projectionKey: 'experience-suggestions-v1', schemaVersion: 5, projectorVersion: 'projector-v2',
    generation: 2, sourceWatermarkDigest: `sha256:${'e'.repeat(64)}`, state: 'ready', degradedReason: null,
    sessions: ['session-a', 'session-b'].map(sessionId => ({
      sessionId, workspaceRoot: '/workspace', sessionCreatedAt: '2026-09-10T08:00:00.000Z',
      lastEventAt: '2026-09-10T08:01:00.000Z', capturedThroughSeq: 9, lastCompletedEndSeq: 9,
      state: 'processed', reason: null, occurrenceIds: [`occurrence:${sessionId}`],
    })),
    seeds: [], groups, dispositions: [], suppressedGroupCount,
    latestReceipt: {
      receiptId: 'receipt:projection', status: 'activated', generation: 2,
      sourceWatermarkDigest: `sha256:${'e'.repeat(64)}`, processedSessionCount: 2,
      occurrenceCount: 2, startedAt: '2026-09-10T08:00:00.000Z',
      completedAt: '2026-09-10T08:01:00.000Z', reason: null,
    },
  }
}

interface TreeNode {
  readonly type: unknown
  readonly props: Readonly<Record<string, unknown>> & { readonly children?: unknown }
}

function flatten(value: unknown): TreeNode[] {
  if (value === null || value === undefined || typeof value === 'boolean'
    || typeof value === 'string' || typeof value === 'number') return []
  if (Array.isArray(value)) return value.flatMap(flatten)
  const node = value as TreeNode
  if (typeof node.type === 'function') return flatten((node.type as (props: unknown) => unknown)(node.props))
  return [node, ...flatten(node.props?.children)]
}

function nodeText(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(nodeText).join(' ')
  const node = value as TreeNode
  if (typeof node.type === 'function') return nodeText((node.type as (props: unknown) => unknown)(node.props))
  return nodeText(node.props?.children)
}
