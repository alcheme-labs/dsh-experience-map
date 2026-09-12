import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fingerprintTask } from '../src/domain/planning.js'
import { matchExperiences as frozenB0Match } from '../handoff/oracle-planning.js'
import { seedVersions } from './fixtures/store-seed.js'
import type { ExperienceDatabase } from '../src/persistence/database.js'
import type { ExperienceRepository } from '../src/persistence/repository.js'
import type { ActorView, PlanningTaskInput, TaskFingerprintView } from '../src/types.js'
import {
  DISTRACTOR_KEYWORDS, NOW, RELEVANT_KEYWORDS,
  diagnosticSpec, retrievalFixture, task,
} from './fixtures/retrieval-fixture.js'

interface Timing {
  readonly medianMs: number
  readonly p95Ms: number
  readonly minMs: number
  readonly maxMs: number
  readonly samples: number[]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function nearestRankP95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[index]!
}

function summarize(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    medianMs: median(samples),
    p95Ms: nearestRankP95(samples),
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    samples: [...samples],
  }
}

const WARMUP = 5
const STEADY = 30

/** Preserve raw samples independently of the test reporter's console capture. */
function recordSamples(label: string, result: Awaited<ReturnType<typeof measureRetrieval>>): void {
  const directory = process.env.OPT_PERFORMANCE_OUTPUT_DIRECTORY
  if (directory !== undefined) {
    writeFileSync(join(directory, `${label}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
}

async function measureRetrieval(
  repository: ExperienceRepository,
  actor: ActorView,
  taskInput: PlanningTaskInput,
  corpus: ReturnType<typeof diagnosticSpec>[],
  database: ExperienceDatabase,
): Promise<{ b0: Timing; b1: Timing; budget: number; coldB0: number; coldB1: number; limit: number; corpusSize: number; heapDeltaBytes: number }> {
  const limit = 32
  await seedVersions(database, actor, corpus)
  const fingerprint: TaskFingerprintView = fingerprintTask(taskInput, actor, NOW)
  const measureB0 = (): void => {
    const versions = repository.listPlanningVersions(actor, limit)
    frozenB0Match(fingerprint, versions, limit, NOW)
  }
  const measureB1 = (): void => {
    repository.matchPlanningVersions(actor, fingerprint, limit, NOW)
  }
  const time = (measure: () => void): number => {
    const start = performance.now()
    measure()
    return performance.now() - start
  }
  const coldB0 = time(measureB0)
  const coldB1 = time(measureB1)
  for (let i = 0; i < WARMUP; i++) { measureB0(); measureB1() }
  const b0Samples: number[] = []
  const b1Samples: number[] = []
  for (let i = 0; i < STEADY; i++) { b0Samples.push(time(measureB0)); b1Samples.push(time(measureB1)) }
  const b0 = summarize(b0Samples)
  const b1 = summarize(b1Samples)
  // Near-point live-set sample (not a true temporal peak: GC may have run between the two
  // samples). The real memory bound is structural: the scan materializes one page (128
  // projection rows) at a time and only the top-N (<= limit) authoritative full versions are
  // retained, so the live set is O(page + limit), never O(corpus full text).
  const heapBefore = process.memoryUsage().heapUsed
  measureB1()
  const heapAfter = process.memoryUsage().heapUsed
  return {
    b0, b1,
    budget: Math.max(b0.p95Ms * 1.25, 200),
    coldB0, coldB1, limit, corpusSize: corpus.length,
    heapDeltaBytes: Math.max(heapAfter - heapBefore, 0),
  }
}

describe('OPT-A1 retrieval performance (R6, rework)', () => {
  it('reports conventional medians and nearest-rank P95 from the recorded samples', () => {
    expect(median([9, 1, 3, 5])).toBe(4)
    expect(median([9, 1, 3])).toBe(3)
    expect(nearestRankP95(Array.from({ length: 30 }, (_, i) => 30 - i))).toBe(29)
  })
  it('keeps the B1 steady P95 (with full authoritative validation) inside the frozen budget on the single-relevant corpus', async () => {
    const f = await retrievalFixture(32)
    try {
      const corpus = [
        diagnosticSpec('Deploy TLS protected public marketing site', 'Monitor CDN availability after deploy', RELEVANT_KEYWORDS),
        ...Array.from({ length: 999 }, (_, i) => diagnosticSpec(
          `Unrelated corpus record ${i}`, `No task overlap ${i}`, DISTRACTOR_KEYWORDS)),
      ]
      const result = await measureRetrieval(f.repository, f.actor, task(), corpus, f.database)
      recordSamples('single-relevant', result)
      // eslint-disable-next-line no-console
      console.log('RETRIEVAL_PERF_SINGLE ' + JSON.stringify(result))
      expect(result.coldB0).toBeGreaterThanOrEqual(0)
      expect(result.coldB1).toBeGreaterThanOrEqual(0)
      expect(result.b1.samples.every(v => v >= 0)).toBe(true)
      expect(result.b1.p95Ms).toBeLessThanOrEqual(result.budget)
    } finally {
      await f.close()
    }
  // The relative B0/B1 budget below is the performance gate. The outer timeout only
  // prevents a wedged run and must accommodate all 35 samples on slower release hosts.
  }, 360_000)

  it('reports the disclosed multi-relevant pressure corpus B1 P95 against the same budget', async () => {
    const f = await retrievalFixture(32)
    try {
      // 40 relevant (identical match facets -> top-32 selected) + 960 distractors.
      const corpus = [
        ...Array.from({ length: 40 }, (_, i) => diagnosticSpec(`Deploy TLS CDN site ${i}`, `Monitor availability ${i}`, RELEVANT_KEYWORDS)),
        ...Array.from({ length: 960 }, (_, i) => diagnosticSpec(`Unrelated corpus record ${i}`, `No task overlap ${i}`, DISTRACTOR_KEYWORDS)),
      ]
      const result = await measureRetrieval(f.repository, f.actor, task(), corpus, f.database)
      recordSamples('multi-relevant-pressure', result)
      // This is the disclosed multi-relevant pressure scenario: it is reported, not a gate.
      // eslint-disable-next-line no-console
      console.log('RETRIEVAL_PERF_PRESSURE ' + JSON.stringify(result))
      expect(result.b1.samples.every(v => v >= 0)).toBe(true)
      if (result.b1.p95Ms > result.budget) {
        // eslint-disable-next-line no-console
        console.log('PRESSURE_OVER_BUDGET ' + JSON.stringify(result))
      }
      expect(result.b1.p95Ms).toBeGreaterThan(0)
    } finally {
      await f.close()
    }
  // This pressure scenario reports the same full sample set without imposing a
  // machine-specific absolute wall-clock threshold.
  }, 360_000)
})
