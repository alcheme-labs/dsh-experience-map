import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const temp = mkdtempSync(join(tmpdir(), 'opt-client-extra-'))
let render: (stage: string, planning: unknown, locale?: 'zh' | 'en') => string
beforeAll(async () => {
  const source = readFileSync('src/client/workspace.tsx', 'utf8')
  await build({
    stdin: {
      contents: source + '\nexport { PlanningReadback as __reviewReadback }; export { zh as __reviewZh }; export { en as __reviewEn };',
      resolveDir: join(process.cwd(), 'src/client'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(temp, 'render.cjs'),
    jsx: 'automatic',
    plugins: [{ name: 'test-runtime', setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, a => ({ path: require.resolve(a.path), external: true }))
      b.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'review' }))
      b.onLoad({ filter: /.*/, namespace: 'review' }, () => ({ contents: 'export const Button=({children})=>children;export const Pill=Button;export const StateDot=Button;export const IconCheckOutline14=()=>null;export const IconRefreshOutline14=()=>null;export const IconCloseOutline16=()=>null;export const IconPanelLeftOutline16=()=>null;', loader: 'jsx' }))
      b.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' }))
    } }],
  })
  const mod = require(join(temp, 'render.cjs')) as {
    __reviewReadback: (p: unknown) => unknown
    __reviewZh: Record<string, string>
    __reviewEn: Record<string, string>
  }
  const text = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join(' ')
    const e = node as { type: unknown; props: { children?: unknown } }
    if (typeof e.type === 'function') return text((e.type as (p: unknown) => unknown)(e.props))
    return text(e.props?.children)
  }
  render = (stage, planning, locale = 'zh') => text(mod.__reviewReadback({
    stage,
    planning,
    context: null,
    execution: null,
    t: (k: string) => (locale === 'en' ? mod.__reviewEn[k] : mod.__reviewZh[k]) ?? k,
    store: {},
    running: false,
  }))
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function makePlanning(o: {
  candidates?: unknown[]
  preflights?: unknown[]
  noMatch?: boolean
  approvalStatus?: 'pending' | 'approved' | null
}): unknown {
  return {
    fingerprint: { hardConstraints: [] },
    matchSet: { noMatch: o.noMatch ?? false, candidates: o.candidates ?? [] },
    preflights: o.preflights ?? [],
    plan: { disposition: 'ready_for_approval', selectedContributions: [], orderedSteps: [] },
    approvalRequest: o.approvalStatus === null ? null : { status: o.approvalStatus ?? 'pending' },
  }
}

function candidate(experienceVersionId: string, title: string, reasonCodes: string[]): unknown {
  return { experienceVersionId, title, reasonCodes, rejected: false, selectedComponentRevisionIds: ['c1'] }
}

function preflight(experienceVersionId: string, disposition: string, summary: string, status = 'unknown'): {
  experienceVersionId: string
  disposition: string
  reasonCodes: string[]
  blockers: string[]
  observations: Array<{ observationId: string; kind: string; status: string; summary: string; reasonCode: string | null }>
} {
  return {
    experienceVersionId,
    disposition,
    reasonCodes: [],
    blockers: [],
    observations: [{ observationId: `${experienceVersionId}-${status}`, kind: 'repository_state', status, summary, reasonCode: 'r1' }],
  }
}

describe('OPT Client PlanningReadback extra boundary coverage', () => {
  it('associates each version with its own preflight facts and reason without crossing over', () => {
    const html = render('match', makePlanning({
      candidates: [
        candidate('v1', '证书经验', ['lexical_match_only']),
        candidate('v2', '超时经验', ['exact_signal_match']),
      ],
      preflights: [
        preflight('v1', 'adaptable', 'v1 独有环境'),
        preflight('v2', 'blocked', 'v2 独有环境', 'observed'),
      ],
    }))
    expect(html).toContain('v1 独有环境')
    expect(html).toContain('v2 独有环境')
    expect(html).toContain('任务词项相符')
    expect(html).toContain('命中相同明确错误码')
    expect(html).not.toContain('lexical_match_only')
    expect(html).not.toContain('exact_signal_match')
  })

  it('keeps later candidate observations distinct in the preflight stage', () => {
    const html = render('preflight', makePlanning({
      candidates: [
        candidate('v1', '证书经验', ['lexical_match_only']),
        candidate('v2', '第二经验', ['lexical_match_only']),
      ],
      preflights: [
        preflight('v1', 'adaptable', '第一环境'),
        preflight('v2', 'adaptable', '第二经验独有环境信息'),
      ],
    }))
    expect(html).toContain('第一环境')
    expect(html).toContain('第二经验独有环境信息')
  })

  it('maps blocked/adaptable pending review and suggestion to their next actions', () => {
    const blocked = render('match', makePlanning({
      candidates: [candidate('v1', 'x', ['hard_scope_conflict'])],
      preflights: [{ experienceVersionId: 'v1', disposition: 'blocked', reasonCodes: [], blockers: [], observations: [] }],
    }))
    expect(blocked).toContain('不使用此经验')
    const adaptable = render('match', makePlanning({
      candidates: [candidate('v1', 'x', ['lexical_match_only'])],
      preflights: [{ experienceVersionId: 'v1', disposition: 'adaptable', reasonCodes: [], blockers: [], observations: [] }],
    }))
    expect(adaptable).toContain('核对当前条件后适配并重新提交')
    const pending = render('match', makePlanning({
      candidates: [candidate('v1', 'x', ['lexical_and_structural_match'])],
      preflights: [{ experienceVersionId: 'v1', disposition: 'applicable', reasonCodes: [], blockers: [], observations: [] }],
      approvalStatus: 'pending',
    }))
    expect(pending).toContain('审阅本次精确计划并批准')
    const suggested = render('match', makePlanning({
      candidates: [candidate('v1', 'x', ['lexical_and_structural_match'])],
      preflights: [{ experienceVersionId: 'v1', disposition: 'applicable', reasonCodes: [], blockers: [], observations: [] }],
      approvalStatus: null,
    }))
    expect(suggested).toContain('阅读该经验作参考')
  })

  it('does not guess an unknown reason code, showing conditions need checking instead', () => {
    const html = render('match', makePlanning({
      candidates: [candidate('v1', 'x', ['future_reason_unknown'])],
      preflights: [{ experienceVersionId: 'v1', disposition: 'adaptable', reasonCodes: [], blockers: [], observations: [] }],
    }))
    expect(html).toContain('还有待核对条件')
    expect(html).not.toContain('future_reason_unknown')
  })

  it('no match keeps the ordinary task available', () => {
    const html = render('match', makePlanning({ noMatch: true, candidates: [], preflights: [] }))
    expect(html).toContain('无匹配')
    expect(html).toContain('可继续普通任务')
    expect(html).not.toContain('证书经验')
  })

  it('renders the English locale correspondingly', () => {
    const html = render('match', makePlanning({
      candidates: [candidate('v1', 'Cert', ['lexical_match_only'])],
      preflights: [preflight('v1', 'adaptable', 'repo unverified')],
    }), 'en')
    expect(html).toContain('Task terms match')
    expect(html).toContain('Verify current conditions, adapt, and resubmit')
    expect(html).toContain('Not yet verified')
  })
})

describe('Coordinator Client rework C1-C3', () => {
  it('C1: merges the same-version preflight confirmed auth mismatch into the readable reason', () => {
    const pf = {
      ...preflight('v1', 'adaptable', '当前 Web 已启用鉴权', 'observed'),
      reasonCodes: ['condition_invalidated_by_current_auth_contract'],
    }
    const html = render('match', makePlanning({
      candidates: [candidate('v1', '匿名校验经验', ['lexical_match_only'])],
      preflights: [pf],
    }))
    expect(html).toContain('旧鉴权条件已变化，需要适配')
    expect(html).toContain('任务词项相符')
    expect(html).not.toContain('condition_invalidated_by_current_auth_contract')
  })

  it('C2: an optional unknown observation does not suppress the pending-approval next action', () => {
    const pf = preflight('v1', 'applicable', 'repository checked', 'observed')
    pf.observations.push({
      observationId: 'optional', kind: 'process_socket', status: 'unknown',
      summary: 'No Experience-owned process reference exists before M5 execution', reasonCode: 'owned_process_absent',
    })
    const html = render('match', makePlanning({
      candidates: [candidate('v1', '经验', ['lexical_match_only'])],
      preflights: [pf],
      approvalStatus: 'pending',
    }))
    expect(html).toContain('审阅本次精确计划并批准')
    expect(html).not.toContain('补充检查当前环境条件')
    expect(html).toContain('尚未验证')  // the unknown is still surfaced as a fact
  })

  it('C3: must-use no-match does not suggest ordinary-task continuation', () => {
    const planning = makePlanning({ noMatch: true, approvalStatus: null }) as { fingerprint: { hardConstraints: string[] }; plan: { disposition: string }; matchSet: { noMatch: boolean; candidates: unknown[] } }
    planning.fingerprint.hardConstraints = ['must_use_experience:true']
    planning.plan.disposition = 'no_match'
    const html = render('match', planning as unknown)
    expect(html).not.toContain('可继续普通任务')
    expect(html).toContain('必须使用经验')
  })

  it('C3: non-must-use no-match keeps the ordinary-task continuation path', () => {
    const html = render('match', makePlanning({ noMatch: true, approvalStatus: null }))
    expect(html).toContain('可继续普通任务')
    expect(html).not.toContain('必须使用经验')
  })
})

