import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { parseRecordEvaluationObservationInput } from '../src/application/input.js'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { digest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type {
  CriterionVerificationView,
  RecordEvaluationObservationInput,
  VerificationRunView,
} from '../src/types.js'
import { createM5Fixture, envelope } from './fixtures/m5-usage.js'

const cleanup: Array<{ directory: string; close(): Promise<void> }> = []

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

describe('M7 source-bound three-arm evaluation', () => {
  it('reports matched arms, keeps unknown separate, and reads the cohort after restart', async () => {
    const fixture = await createM5Fixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const settlement = await settleSuccess(fixture)
    const common = observation('no_memory')
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: { ...common, outcome: 'unknown' },
    }, fixture.owner)
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: observation('retrieval_only'),
    }, fixture.owner)
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observation('experience_map'),
        taskFingerprintId: fixture.planning.fingerprint.fingerprintId,
        usageId: fixture.progress.usageId,
        settlementId: settlement.settlementId,
        outcome: 'success',
      },
    }, fixture.owner)

    const report = fixture.repository.getEvaluationReport('cohort-m7', fixture.owner)
    expect(report).toMatchObject({ comparable: true, blockers: [], taskCaseIds: ['case-1'] })
    expect(report.arms.find(item => item.comparisonArm === 'no_memory')).toMatchObject({
      sampleCount: 1, successCount: 0, failureCount: 0, unknownCount: 1,
      successRate: 0, resolvedSuccessRate: null, unknownRate: 1,
      averageInputTokens: 100, averageOutputTokens: 20, erroneousReuseRate: 0,
    })
    expect(report.arms.find(item => item.comparisonArm === 'experience_map')).toMatchObject({
      sampleCount: 1, successCount: 1, failureCount: 0, unknownCount: 0,
      successRate: 1, resolvedSuccessRate: 1, unknownRate: 0,
    })

    await fixture.database.close()
    cleanup.pop()
    const database = await ExperienceDatabase.open({
      databasePath: join(fixture.directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
      busyTimeoutMs: 50, maxPendingWrites: 8,
    })
    cleanup.push({ directory: fixture.directory, close: () => database.close() })
    const repository = new ExperienceRepository(database)
    const principal = await repository.initializePrincipal()
    const actor = new ActorResolver(principal).resolve({ kind: 'management-cli' })
    const restarted = repository.getEvaluationReport('cohort-m7', actor)
    expect({ ...restarted, generatedAt: null }).toEqual({ ...report, generatedAt: null })
  })

  it('rejects identity leakage, training/test overlap, and mismatched canonical outcomes', async () => {
    const fixture = await createM5Fixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const settlement = await settleSuccess(fixture)
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observation('no_memory'),
        taskFingerprintId: fixture.planning.fingerprint.fingerprintId,
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observation('retrieval_only'),
        trainingEpisodeRefs: ['metric://case-1'],
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observation('experience_map'),
        taskFingerprintId: fixture.planning.fingerprint.fingerprintId,
        usageId: fixture.progress.usageId,
        settlementId: settlement.settlementId,
        outcome: 'failure',
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('marks incomplete or differently configured arms non-comparable and parses exact JSON only', async () => {
    const fixture = await createM5Fixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: observation('no_memory'),
    }, fixture.owner)
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: { ...observation('retrieval_only'), modelVersion: 'other-model' },
    }, fixture.owner)
    expect(fixture.repository.getEvaluationReport('cohort-m7', fixture.owner)).toMatchObject({
      comparable: false,
      blockers: expect.arrayContaining(['configuration_mismatch', 'missing_arm:experience_map']),
    })
    const parsed = parseRecordEvaluationObservationInput({
      ...envelope(), observation: observation('no_memory'),
    })
    expect(parsed.observation.erroneousReuse).toBe(false)
    expect(() => parseRecordEvaluationObservationInput({
      ...envelope(), observation: { ...observation('no_memory'), inventedMetric: 1 },
    })).toThrow(expect.objectContaining({ code: 'invalid_command' }))
  })
})

function observation(
  arm: RecordEvaluationObservationInput['observation']['comparisonArm'],
): RecordEvaluationObservationInput['observation'] {
  return {
    cohortId: 'cohort-m7',
    comparisonArm: arm,
    taskCaseId: 'case-1',
    taskFamilyId: 'family-web-start',
    taskFingerprintId: null,
    usageId: null,
    settlementId: null,
    split: 'test',
    taskOccurredAt: '2026-09-03T01:00:00.000Z',
    trainingWindowEndsAt: '2026-09-02T23:59:59.000Z',
    trainingEpisodeRefs: ['training://episode-1'],
    modelVersion: 'deepseek-v4-flash',
    toolsetVersion: 'dsh-tools-v1',
    contextBudget: 32_768,
    verifierVersion: 'web-verifier-v1',
    taskCorpusVersion: 'm7-corpus-v1',
    outcome: 'success',
    acceptanceResultRefs: ['acceptance://case-1'],
    decisionAnchorRefs: arm === 'no_memory' ? [] : ['decision://case-1'],
    routeSignature: 'build>launch>readback',
    elapsedMs: 1_000,
    modelRoundCount: 2,
    toolCallCount: 3,
    inputTokens: 100,
    outputTokens: 20,
    humanActionCount: 0,
    repeatedExplorationCount: 0,
    erroneousSideEffectCount: 0,
    erroneousReuse: false,
    retrievalResult: arm === 'no_memory' ? 'not_applicable' : 'relevant',
    applicabilityDecision: arm === 'experience_map' ? 'use' : 'not_applicable',
    pollutionIncident: false,
    explanationCoverage: 1,
    metricSourceRefs: ['metric://case-1'],
  }
}

async function settleSuccess(fixture: Awaited<ReturnType<typeof createM5Fixture>>) {
  let progress = fixture.progress
  while (progress.state !== 'completed') {
    await fixture.repository.progressUsage({
      ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
      action: 'advance', checkpointRef: progress.stepRef, reason: 'Evaluation fixture completed the planned step.',
    }, fixture.owner)
    progress = fixture.repository.getUsageExecution(String(progress.usageId), fixture.owner).progress!
  }
  const criteria = WEB_USAGE_CRITERIA.map(criterion)
  const verification: VerificationRunView = {
    verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
    usageId: progress.usageId,
    controllerRevision: progress.controllerRevision,
    providerVersion: 'dsh-web-guided-v1',
    criteria,
    phase: 'complete',
    createdAt: new Date().toISOString(),
  }
  await fixture.repository.recordVerification({
    ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
  }, verification, fixture.owner)
  await fixture.repository.settleUsage({
    ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
    verificationRunId: verification.verificationRunId,
  }, fixture.owner)
  return fixture.repository.getUsageExecution(String(progress.usageId), fixture.owner).settlement!
}

function criterion(criterionId: CriterionVerificationView['criterionId']): CriterionVerificationView {
  const base = {
    criterionId, mandatory: true as const, result: 'pass' as const, observedAt: new Date().toISOString(),
    boundedValue: { fixture: true }, sourceRef: `fixture://m7/${criterionId}`, reasonCode: 'fixture_pass',
  }
  return { ...base, integrityDigest: digest(base) }
}
