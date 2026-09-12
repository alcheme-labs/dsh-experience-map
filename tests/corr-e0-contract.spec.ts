import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const taskNames = [
  'extractability',
  'kind',
  'grounding',
  'equivalence',
  'component_mapping',
  'applicability',
] as const

type TaskName = typeof taskNames[number]
type TruthCase = Readonly<{
  id: string
  origin: 'deidentified_session' | 'synthetic_required_negative'
  sourceRef: string
  expected: unknown
  tags: readonly string[]
}>
type TruthSet = Readonly<{
  schemaVersion: string
  split: 'development' | 'holdout'
  baseCommit: string
  tasks: Readonly<Record<TaskName, readonly TruthCase[]>>
}>

const developmentPath = 'benchmarks/corr-e0/development.json'
const holdoutPath = 'benchmarks/corr-e0/holdout.json'
const manifestPath = 'benchmarks/corr-e0/manifest.json'
const development = readJson<TruthSet>(developmentPath)
const holdout = readJson<TruthSet>(holdoutPath)
const manifest = readJson<{
  baseCommit: string
  tasks: readonly string[]
  splits: Readonly<Record<'development' | 'holdout', {
    path: string
    sha256: string
    caseCount: number
    casesPerTask: number
    deidentifiedSessionCount: number
  }>>
  totals: {
    caseCount: number
    holdoutCount: number
    holdoutRatio: number
    deidentifiedSessionCount: number
    deidentifiedSessionRatio: number
  }
}>(manifestPath)

describe('CORR-E0 frozen truth-set contract', () => {
  it('freezes six independent tasks with an isolated holdout above the plan minimum', () => {
    expect(Object.keys(development.tasks)).toEqual(taskNames)
    expect(Object.keys(holdout.tasks)).toEqual(taskNames)
    expect(manifest.tasks).toEqual(taskNames)

    const developmentCases = casesOf(development)
    const holdoutCases = casesOf(holdout)
    const allCases = [...developmentCases, ...holdoutCases]
    expect(developmentCases).toHaveLength(84)
    expect(holdoutCases).toHaveLength(24)
    expect(allCases).toHaveLength(108)
    expect(new Set(allCases.map(item => item.id)).size).toBe(108)
    expect(holdoutCases.length / allCases.length).toBeGreaterThanOrEqual(0.2)
    expect(allCases.filter(item => item.origin === 'deidentified_session')).toHaveLength(54)
    expect(allCases.filter(item => item.origin === 'deidentified_session').length / allCases.length)
      .toBeGreaterThanOrEqual(0.5)

    for (const task of taskNames) {
      expect(development.tasks[task]).toHaveLength(14)
      expect(holdout.tasks[task]).toHaveLength(4)
      expect(development.tasks[task].filter(item => item.origin === 'deidentified_session')).toHaveLength(7)
      expect(holdout.tasks[task].filter(item => item.origin === 'deidentified_session')).toHaveLength(2)
    }
  })

  it('covers every decision label and the required semantic-flip negatives', () => {
    expect(labels('extractability')).toEqual(new Set(['extractable', 'not_extractable']))
    expect(labels('kind')).toEqual(new Set([
      'causal', 'diagnostic', 'fact', 'not_extractable', 'preference_policy', 'procedure', 'strategy',
    ]))
    expect(labels('equivalence')).toEqual(new Set(['ambiguous', 'different', 'same', 'specialization']))
    expect(labels('component_mapping')).toEqual(new Set(['ambiguous', 'complete', 'incomplete']))
    expect(labels('applicability')).toEqual(new Set(['abstain', 'applicable', 'rejected']))

    const tags = new Set(casesOf(development).concat(casesOf(holdout)).flatMap(item => item.tags))
    for (const required of [
      'action-flip', 'polarity', 'authority', 'value', 'scope', 'verifier',
      'permission', 'capability', 'risk', 'expired', 'negative-goal',
    ]) expect(tags).toContain(required)
  })

  it('pins exact split bytes, base commit, counts, and safe source provenance', () => {
    expect(development.baseCommit).toBe(manifest.baseCommit)
    expect(holdout.baseCommit).toBe(manifest.baseCommit)
    expect(manifest.baseCommit).toMatch(/^[0-9a-f]{40}$/u)
    expect(manifest.splits.development).toMatchObject({
      path: developmentPath, sha256: sha256(developmentPath), caseCount: 84,
      casesPerTask: 14, deidentifiedSessionCount: 42,
    })
    expect(manifest.splits.holdout).toMatchObject({
      path: holdoutPath, sha256: sha256(holdoutPath), caseCount: 24,
      casesPerTask: 4, deidentifiedSessionCount: 12,
    })
    expect(manifest.totals).toEqual({
      caseCount: 108, holdoutCount: 24, holdoutRatio: 24 / 108,
      deidentifiedSessionCount: 54, deidentifiedSessionRatio: 0.5,
    })

    const serialized = JSON.stringify([development, holdout])
    expect(serialized).not.toMatch(/(?:sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/u)
    for (const item of casesOf(development).concat(casesOf(holdout))) {
      expect(item.sourceRef).toMatch(/^(?:evidence\/|benchmarks\/|package\.json$|synthetic:)/u)
      expect(item.sourceRef).not.toMatch(/^\//u)
      expect(item.id).toMatch(/^(?:ext|kind|ground|eq|map|app)-(?:dev|hold)-\d{2}$/u)
    }
  })
})

function casesOf(set: TruthSet): TruthCase[] {
  return taskNames.flatMap(task => [...set.tasks[task]])
}

function labels(task: Exclude<TaskName, 'grounding'>): Set<unknown> {
  return new Set([...development.tasks[task], ...holdout.tasks[task]].map(item => item.expected))
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
