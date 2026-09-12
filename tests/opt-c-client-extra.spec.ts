import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import {
  parseLearningHistory,
  parseLearningRanking,
} from '../src/client/workspace-model.js'
import { createStore } from '../src/client/store.js'
import { retrievalProjection } from './fixtures/retrieval.js'
import { throughExperienceRpcCarrier } from './fixtures/client-rpc.js'
import { automationConfigurationFixture } from './fixtures/automation.js'
import { zh } from '../src/client/locales.js'
import type {
  LearningProjectionView,
  LearningPredictionView,
  LearningGovernanceView,
  LearningSourceRefView,
} from '../src/types.js'

const require = createRequire(import.meta.url)
const temp = mkdtempSync(join(tmpdir(), 'opt-c-client-extra-'))

/** Minimal real translation: use the shipped zh dictionary and interpolate {name} params. */
function t(key: string, params?: Record<string, unknown>): string {
  let text = (zh as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    text = text.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
  }
  return text
}

type ElementNode = { readonly type: unknown; readonly props: Record<string, unknown> & { readonly children?: unknown } }

let historyComponent: (props: unknown) => unknown
let rankingComponent: (props: unknown) => unknown
let predictionRowComponent: (props: unknown) => unknown
let renderText: (component: (props: unknown) => unknown, props: object) => string

beforeAll(async () => {
  const source = readFileSync('src/client/workspace.tsx', 'utf8')
  await build({
    stdin: {
      contents: source + '\nexport { LearningHistoryBlock as __learningHistoryBlock }; export { LearningRankingBlock as __learningRankingBlock }; export { LearningPredictionRow as __learningPredictionRow };',
      resolveDir: join(process.cwd(), 'src/client'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(temp, 'learning.cjs'),
    jsx: 'automatic',
    plugins: [{ name: 'test-runtime', setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, a => ({ path: require.resolve(a.path), external: true }))
      b.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'review' }))
      b.onLoad({ filter: /.*/, namespace: 'review' }, () => ({ contents: 'export const Button=({children})=>children;export const Pill=Button;export const StateDot=Button;export const IconCheckOutline14=()=>null;export const IconRefreshOutline14=()=>null;export const IconCloseOutline16=()=>null;export const IconPanelLeftOutline16=()=>null;', loader: 'jsx' }))
      b.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' }))
    } }],
  })
  const mod = require(join(temp, 'learning.cjs')) as {
    __learningHistoryBlock: (props: unknown) => unknown
    __learningRankingBlock: (props: unknown) => unknown
    __learningPredictionRow: (props: unknown) => unknown
  }
  historyComponent = mod.__learningHistoryBlock
  rankingComponent = mod.__learningRankingBlock
  predictionRowComponent = mod.__learningPredictionRow
  const text = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join(' ')
    const e = node as ElementNode
    if (typeof e.type === 'function') return text((e.type as (props: unknown) => unknown)(e.props))
    return text(e.props?.children)
  }
  renderText = (component, props) => text(component(props))
})

afterAll(() => rmSync(temp, { recursive: true, force: true }))

function sourceRef(kind: LearningSourceRefView['kind'], id: string, digest: string | null = null): LearningSourceRefView {
  return { kind, id, digest }
}

function historyWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usageId: 'usage-a',
    experienceVersionId: 'version-a',
    taskInputDigest: 'sha256:task',
    environmentKey: 'env',
    componentRevisionIds: ['rev-1', 'rev-2'],
    participation: 'used',
    taskOutcome: 'success',
    attribution: 'task_participation',
    evidenceRefs: [sourceRef('usage', 'usage-a', 'sha256:e1'), sourceRef('episode', 'episode-1')],
    reasonCodes: ['participated'],
    ...overrides,
  }
}

function rankingWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usageId: 'usage-r',
    taskInputDigest: 'sha256:rank',
    environmentKey: 'env',
    baselineVersionIds: ['v-baseline', 'v-old'],
    proposedVersionIds: ['v-first', 'v-second', 'v-third'],
    appliedVersionIds: ['v-applied'],
    mode: 'shadow',
    reasonCodes: ['history_ranked'],
    sampleCount: 5,
    sourceUsageIds: ['usage-1', 'usage-2'],
    governanceDecisionId: null,
    evaluationId: null,
    ...overrides,
  }
}

function predictionRow(capability: LearningPredictionView['capability'], prediction: Record<string, unknown>, predictorVersion = 'm7-applicability'): LearningPredictionView {
  return {
    predictionId: `pred-${capability}-${predictorVersion}` as LearningPredictionView['predictionId'],
    schemaVersion: 'experience-shadow-prediction-v1',
    capability,
    predictor: { kind: 'deterministic_rule', version: predictorVersion },
    scope: {},
    inputRefs: [],
    prediction,
    humanLabels: [],
    observedOutcomes: [],
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

function projection(rows: readonly LearningPredictionView[]): LearningProjectionView {
  return {
    projectionKey: 'experience-learning-v1',
    builderVersion: 'm7-learning-v4',
    generation: 1,
    sourceOffset: 1,
    rows,
    counts: { extraction: 0, applicability: rows.length, revision: 0, merge: 0, causal_promotion: 0, execution: 0 },
    unsupportedCapabilities: [],
  }
}

function governance(): LearningGovernanceView {
  return { contracts: [], evaluations: [], capabilities: [] }
}

describe('C1 history wire parsing, empty state, and honest rendering', () => {
  it('parses a complete Host history object into a task-participation view', () => {
    const parsed = parseLearningHistory(historyWire())
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      usageId: 'usage-a',
      experienceVersionId: 'version-a',
      taskInputDigest: 'sha256:task',
      environmentKey: 'env',
      participation: 'used',
      taskOutcome: 'success',
      attribution: 'task_participation',
      componentRevisionIds: ['rev-1', 'rev-2'],
      reasonCodes: ['participated'],
    })
    expect(parsed!.evidenceRefs).toHaveLength(2)
    expect(parsed!.evidenceRefs[1]).toEqual({ kind: 'episode', id: 'episode-1', digest: null })
  })

  it('rejects missing or malformed fields instead of claiming a successful history', () => {
    expect(parseLearningHistory(undefined)).toBeNull()
    expect(parseLearningHistory({})).toBeNull()
    // Malformed participation
    expect(parseLearningHistory(historyWire({ participation: 'winner' }))).toBeNull()
    // Malformed componentRevisionIds
    expect(parseLearningHistory(historyWire({ componentRevisionIds: 'not-an-array' }))).toBeNull()
    // Malformed evidenceRefs (must carry id/digest)
    expect(parseLearningHistory(historyWire({ evidenceRefs: [{ id: 1 }] }))).toBeNull()
    // Wrong or missing attribution must not render as success
    expect(parseLearningHistory(historyWire({ attribution: 'component_causation' }))).toBeNull()
    expect(parseLearningHistory(historyWire({ attribution: undefined }))).toBeNull()
  })

  it('keeps task outcomes separate and treats unknown/abandoned/null as non-success', () => {
    for (const outcome of ['success', 'failure', 'unknown', 'abandoned'] as const) {
      const parsed = parseLearningHistory(historyWire({ taskOutcome: outcome }))
      expect(parsed).not.toBeNull()
      expect(parsed!.taskOutcome).toBe(outcome)
    }
    const noOutcome = parseLearningHistory(historyWire({ taskOutcome: null }))
    expect(noOutcome).not.toBeNull()
    expect(noOutcome!.taskOutcome).toBeNull()
    // An invalid outcome is not silently downgraded to null
    expect(parseLearningHistory(historyWire({ taskOutcome: 'failed' }))).toBeNull()
  })

  it('rejects a non-string evidence digest instead of coercing it to null (C-R1)', () => {
    // A malformed digest (42), a missing digest, or a non-string must reject the whole
    // history, never be washed to null while the record still claims used/success.
    expect(parseLearningHistory(historyWire({ evidenceRefs: [{ kind: 'usage', id: 'u', digest: 42 }] }))).toBeNull()
    expect(parseLearningHistory(historyWire({ evidenceRefs: [{ kind: 'usage', id: 'u' }] }))).toBeNull()
    expect(parseLearningHistory(historyWire({ evidenceRefs: [{ kind: 'usage', id: 'u', digest: true }] }))).toBeNull()
    expect(parseLearningHistory(historyWire({ evidenceRefs: [{ kind: 'usage', id: 'u', digest: [] }] }))).toBeNull()
  })

  it('accepts an explicit null or string digest and stays compatible with Host ref kinds', () => {
    const nullDigest = parseLearningHistory(historyWire({
      evidenceRefs: [{ kind: 'context_snapshot', id: 'snapshot-1', digest: null }],
    }))
    expect(nullDigest).not.toBeNull()
    expect(nullDigest!.evidenceRefs[0]).toEqual({ kind: 'context_snapshot', id: 'snapshot-1', digest: null })

    const stringDigest = parseLearningHistory(historyWire({
      evidenceRefs: [{ kind: 'context_delivery', id: 'delivery-1', digest: 'sha256:delivery' }],
    }))
    expect(stringDigest).not.toBeNull()
    expect(stringDigest!.evidenceRefs[0]).toEqual({ kind: 'context_delivery', id: 'delivery-1', digest: 'sha256:delivery' })
  })

  it('renders the participated-task semantics and never a component causal rate', () => {
    const html = renderText(historyComponent, {
      history: parseLearningHistory(historyWire())!,
      t,
    })
    expect(html).toContain(t('learning.history.title'))
    expect(html).toContain(t('learning.history.participation.used'))
    expect(html).toContain(t('learning.history.outcome.success'))
    expect(html).toContain(t('learning.history.attribution.task_participation'))
    expect(html).toContain('version-a')
    expect(html).toContain('env')
    expect(html).toContain(t('learning.history.notCausal'))
    // Participation is not presented as a numeric causal success-rate claim.
    expect(html).not.toMatch(/因果成功率\s*[:：]\s*[0-9.]+%/)
  })

  it('renders the honest no-history state for a legacy applicability row', () => {
    const html = renderText(predictionRowComponent, {
      row: predictionRow('applicability', {}), capability: 'applicability', t,
    })
    expect(html).toContain(t('learning.history.noHistory'))
    expect(html).not.toContain(t('learning.history.title'))
  })

  it('renders the honest no-history state when the only history row has an invalid digest', () => {
    // Fix guard must make the invalid record un-parseable so the row shows the honest
    // "no verifiable history" state rather than a fabricated success.
    const html = renderText(predictionRowComponent, {
      row: predictionRow('applicability', {
        history: historyWire({ evidenceRefs: [{ kind: 'usage', id: 'u', digest: 42 }] }),
      }, 'm7-applicability'),
      capability: 'applicability', t,
    })
    expect(html).toContain(t('learning.history.noHistory'))
    expect(html).not.toContain(t('learning.history.title'))
  })

  it('exposes history and ranking source IDs inside the unique inspector', () => {
    const html = renderText(predictionRowComponent, {
      row: predictionRow('applicability', { history: historyWire() }, 'm7-applicability'),
      capability: 'applicability', t,
    })
    expect(html).toContain('usage-a')
    expect(html).toContain('episode-1')
    expect(html).toContain('sha256:e1')
  })
})

describe('C2 ranking mode, order preservation, and governance separation', () => {
  it('parses a complete Host ranking object and preserves the provided ordering', () => {
    const parsed = parseLearningRanking(rankingWire())
    expect(parsed).not.toBeNull()
    expect(parsed!.baselineVersionIds).toEqual(['v-baseline', 'v-old'])
    expect(parsed!.proposedVersionIds).toEqual(['v-first', 'v-second', 'v-third'])
    expect(parsed!.appliedVersionIds).toEqual(['v-applied'])
    expect(parsed!.sampleCount).toBe(5)
    expect(parsed!.sourceUsageIds).toEqual(['usage-1', 'usage-2'])
  })

  it('rejects an unknown mode and missing required arrays', () => {
    expect(parseLearningRanking(rankingWire({ mode: 'promote' }))).toBeNull()
    expect(parseLearningRanking(rankingWire({ baselineVersionIds: undefined }))).toBeNull()
    expect(parseLearningRanking(rankingWire({ appliedVersionIds: 'not-an-array' }))).toBeNull()
    expect(parseLearningRanking(rankingWire({ sourceUsageIds: undefined }))).toBeNull()
    expect(parseLearningRanking(undefined)).toBeNull()
  })

  it('accepts null or concrete governance/evaluation identifiers', () => {
    expect(parseLearningRanking(rankingWire({ governanceDecisionId: null, evaluationId: null }))!.governanceDecisionId).toBeNull()
    const licensed = parseLearningRanking(rankingWire({
      governanceDecisionId: 'gov-1', evaluationId: 'eval-1', mode: 'suggest',
    }))!
    expect(licensed.governanceDecisionId).toBe('gov-1')
    expect(licensed.evaluationId).toBe('eval-1')
    expect(licensed.mode).toBe('suggest')
  })

  it('renders shadow as off-path and does not affect the applied choice', () => {
    const html = renderText(rankingComponent, { ranking: parseLearningRanking(rankingWire())!, t })
    expect(html).toContain(t('learning.ranking.mode.shadow'))
    expect(html).not.toContain(t('learning.ranking.mode.suggest'))
  })

  it('renders suggest only when a concrete governance decision and evaluation are present', () => {
    const licensed = parseLearningRanking(rankingWire({
      mode: 'suggest', governanceDecisionId: 'gov-1', evaluationId: 'eval-1',
    }))!
    const licensedHtml = renderText(rankingComponent, { ranking: licensed, t })
    expect(licensedHtml).toContain(t('learning.ranking.mode.suggest'))
    expect(licensedHtml).toContain('gov-1')
    expect(licensedHtml).toContain('eval-1')

    const missing = parseLearningRanking(rankingWire({ mode: 'suggest' }))!
    const missingHtml = renderText(rankingComponent, { ranking: missing, t })
    expect(missingHtml).toContain(t('learning.ranking.mode.suggestMissing'))
    expect(missingHtml).not.toContain(t('learning.ranking.mode.suggest'))
  })

  it('renders fallback with its reason and the governance separation note', () => {
    const fallback = parseLearningRanking(rankingWire({ mode: 'fallback', reasonCodes: ['no_license'] }))!
    const html = renderText(rankingComponent, { ranking: fallback, t })
    expect(html).toContain(t('learning.ranking.mode.fallback'))
    expect(html).toContain('no_license')
    expect(html).toContain(t('learning.ranking.governanceNote'))
  })

  it('never re-sorts baseline/proposed/applied arrays in the Client', () => {
    const html = renderText(rankingComponent, { ranking: parseLearningRanking(rankingWire())!, t })
    const baseline = ['v-baseline', 'v-old']
    const proposed = ['v-first', 'v-second', 'v-third']
    // Host-provided order is exactly preserved (v-baseline before v-old; v-second before v-third).
    expect(indexOf(html, 'v-baseline')).toBeLessThan(indexOf(html, 'v-old'))
    expect(indexOf(html, 'v-first')).toBeLessThan(indexOf(html, 'v-second'))
    expect(indexOf(html, 'v-second')).toBeLessThan(indexOf(html, 'v-third'))
    expect(indexOf(html, baseline[0]!)).toBeGreaterThan(-1)
    expect(indexOf(html, proposed[2]!)).toBeGreaterThan(-1)
  })

  it('renders the ranking block only on the opt-history-ranking predictor row', () => {
    const rankingHtml = renderText(predictionRowComponent, {
      row: predictionRow('applicability', { ranking: rankingWire() }, 'opt-history-ranking'),
      capability: 'applicability', t,
    })
    expect(rankingHtml).toContain(t('learning.ranking.title'))

    const historyHtml = renderText(predictionRowComponent, {
      row: predictionRow('applicability', { history: historyWire() }, 'm7-applicability'),
      capability: 'applicability', t,
    })
    expect(historyHtml).toContain(t('learning.history.title'))
    expect(historyHtml).not.toContain(t('learning.ranking.title'))

    const otherHtml = renderText(predictionRowComponent, {
      row: predictionRow('extraction', { ranking: rankingWire() }, 'opt-history-ranking'),
      capability: 'extraction', t,
    })
    expect(otherHtml).not.toContain(t('learning.ranking.title'))
  })

  it('keeps the legacy applicability controls distinct from the new ranking license', () => {
    // The old evaluate/promote/demote controls remain and carry an explicit object note.
    const source = readFileSync('src/client/workspace.tsx', 'utf8')
    expect(source).toContain('data-testid="experience-learning-governance-object"')
    expect(source).toContain("t('learning.governance.legacyCapabilityNote')")
    // No promote action is ever wired to the dedicated history-ranking predictor.
    const promoteBlock = functionSource(source, 'function LearningInspectorTechnical', 'function LearningPredictionRow')
    expect(promoteBlock).not.toContain('opt-history-ranking')
  })
})

describe('C3 refresh failure does not become an optimistic success', () => {
  function connectionWithLearning(result: () => ConnectionRpcResult<unknown>): { handle: ConnectionHandle; calls: string[] } {
    const calls: string[] = []
    const handle = {
      rpc: {
        call: async (_channel: string, endpoint: string, _input: unknown): Promise<ConnectionRpcResult<unknown>> => {
          calls.push(endpoint)
          switch (endpoint) {
            case 'status/query':
              return okPlanStatus()
            case 'suggestions/query':
              return ok({ projectionKey: 'experience-suggestions-v1', schemaVersion: 5,
                groups: [], sessions: [], seeds: [], dispositions: [] })
            case 'retrieval/query':
              return ok(retrievalProjection())
            case 'candidate/list':
              return ok([])
            case 'plan/list':
              return ok([])
            case 'plan/config':
              return ok({ taskFingerprintProposalMode: 'deterministic', provider: null, model: null, maxOutputTokens: null, promptVersion: 'task-fingerprint-v1' })
            case 'automation/config':
              return ok(automationConfigurationFixture())
            case 'learning/query':
              return result()
            case 'learning/governance':
              return ok(governance())
            case 'relation-map/query':
              return ok({ edges: [], nodes: [] })
            case 'infrastructure/readiness':
              return ok({ evaluation: null, overview: { state: 'unknown', blockers: [], resolution: null } })
            default:
              throw new Error(`unexpected endpoint ${endpoint}`)
          }
        },
      },
    } as unknown as ConnectionHandle
    return { handle, calls }
  }

  it('propagates the Host history and ranking records through the real store', async () => {
    const rows = [
      predictionRow('applicability', { history: historyWire() }, 'm7-applicability'),
      predictionRow('applicability', { ranking: rankingWire({ mode: 'shadow' }) }, 'opt-history-ranking'),
    ]
    const { handle } = connectionWithLearning(() => ok(projection(rows)))
    const store = createStore(throughExperienceRpcCarrier(handle))
    await store.refresh()
    expect(store.getSnapshot().phase).toBe('ready')
    expect(store.getSnapshot().learning?.rows).toHaveLength(2)
    const history = parseLearningHistory(store.getSnapshot().learning!.rows[0]!.prediction.history)
    const ranking = parseLearningRanking(store.getSnapshot().learning!.rows[1]!.prediction.ranking)
    expect(history).not.toBeNull()
    expect(ranking).not.toBeNull()
    expect(ranking!.mode).toBe('shadow')
  })

  it('leaves phase=error and no fabricated learning data when refresh fails', async () => {
    const { handle, calls } = connectionWithLearning(() => ({
      ok: false,
      error: { code: 'learning_unavailable', message: 'projection unavailable', details: {} },
    }))
    const store = createStore(throughExperienceRpcCarrier(handle))
    await store.refresh()
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.error).toBe('projection unavailable')
    // No optimistic learning data is set on a failed refresh.
    expect(snapshot.learning).toBeUndefined()
    expect(calls).toContain('learning/query')
  })
})

function okPlanStatus(): ConnectionRpcResult<unknown> {
  return ok({
    actor: { actorId: 'actor-1', principalId: 'principal-1', kind: 'browser_local_owner', authority: 'owner' },
    principalId: 'principal-1',
    candidateCount: 0,
    versionCount: 0,
    latestReceipt: null,
    latestForgetRequest: null,
    latestVersion: null,
    pendingPlanApprovalCount: 0,
    latestPlanning: null,
  })
}

function ok(value: unknown): ConnectionRpcResult<unknown> {
  return { ok: true, value }
}

function indexOf(html: string, needle: string): number {
  const index = html.indexOf(needle)
  expect(index).toBeGreaterThan(-1)
  return index
}

function functionSource(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  if (startIndex < 0) throw new Error(`missing source marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  if (endIndex < 0) throw new Error(`missing source marker: ${end}`)
  return source.slice(startIndex, endIndex)
}
