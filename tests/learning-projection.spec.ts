import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { digest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import type { CriterionVerificationView, VerificationRunView } from '../src/types.js'
import type { ExperienceRepository } from '../src/persistence/repository.js'
import { createM5Fixture, envelope } from './fixtures/m5-usage.js'

const cleanup: Array<{ directory: string; close(): Promise<void> }> = []

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

describe('M6 outbox-driven learning projection', () => {
  it('rebuilds stable extraction, applicability and execution rows from real canonical records', async () => {
    const fixture = await trackedFixture({ approvalSurface: 'management' })
    const beforeOutcome = await drain(fixture.repository)
    // applicability now rolls up the per-preflight rows plus one opt-history-ranking
    // counterfactual row (one used version in this fixture). The ranker has no labels by design.
    expect(beforeOutcome.counts).toMatchObject({ extraction: 1, applicability: 2, revision: 0, execution: 1 })
    expect(beforeOutcome.rows.find(row => row.capability === 'extraction')?.humanLabels.length).toBeGreaterThan(0)
    // The default predictability row (not the opt-history-ranking counterfactual) is the one that
    // carries the owner approval label.
    expect(beforeOutcome.rows.find(row => row.capability === 'applicability'
      && row.predictor.version !== 'opt-history-ranking')?.humanLabels)
      .toEqual([expect.objectContaining({
        decision: 'approved',
        actorId: fixture.approvalActor.actorId,
        sourceRefs: expect.arrayContaining([expect.objectContaining({ kind: 'governance_decision' })]),
      })])
    expect(beforeOutcome.rows.find(row => row.capability === 'execution')?.humanLabels)
      .toEqual([expect.objectContaining({ actorId: fixture.approvalActor.actorId })])
    expect(beforeOutcome.rows.every(row => row.observedOutcomes.length === 0)).toBe(true)
    expect(beforeOutcome.rows.some(row => row.capability === ('merge' as never))).toBe(false)

    await settle(fixture, 'pass')
    const afterOutcome = await drain(fixture.repository)
    // The opt-history-ranking counterfactual row carries no observed outcome (it is not a use);
    // only real participation rows are attributed a settlement result.
    expect(afterOutcome.rows.filter(row => row.capability !== 'revision'
      && row.predictor.version !== 'opt-history-ranking')
      .every(row => row.observedOutcomes.some(outcome => outcome.outcome === 'success'))).toBe(true)
    const stableIds = afterOutcome.rows.map(row => row.predictionId)

    fixture.database.handle.exec(`
      DELETE FROM human_labels;
      DELETE FROM observed_outcome_labels;
      DELETE FROM shadow_predictions;
    `)
    fixture.database.handle.prepare(
      `INSERT INTO outbox_entries
        (outbox_id, topic, payload_json, state, attempts, next_attempt_at, lease_until, created_at)
       VALUES (?, 'experience.learning.reconcile', '{}', 'pending', 0, ?, NULL, ?)`,
    ).run(randomUUID(), new Date().toISOString(), new Date().toISOString())
    const rebuilt = await drain(fixture.repository)
    expect(rebuilt.rows.map(row => row.predictionId)).toEqual(stableIds)
    expect(new Set(rebuilt.rows.map(row => row.predictionId)).size).toBe(rebuilt.rows.length)
    expect(rebuilt.generation).toBeGreaterThan(afterOutcome.generation)
  })

  it('keeps unknown outcomes explicit without counting them as valid evaluation samples', async () => {
    const fixture = await trackedFixture()
    await settle(fixture, 'unknown')
    const projection = await drain(fixture.repository)
    expect(projection.rows.filter(row => (row.capability === 'applicability' || row.capability === 'execution')
      && row.predictor.version !== 'opt-history-ranking')
      .every(row => row.observedOutcomes.some(outcome => outcome.outcome === 'unknown'))).toBe(true)

    const receipt = await fixture.repository.evaluateUnlockContract({
      ...envelope(), capability: 'execution',
    }, fixture.owner)
    const evaluation = fixture.repository.getLearningGovernance(fixture.owner).evaluations
      .find(item => item.unlockContractEvaluationId === receipt.evaluationId)
    expect(evaluation).toMatchObject({
      outcome: 'inconclusive',
      sampleCoverage: 0,
      metricResults: {
        totalPredictions: 1,
        outcomeLabeledPredictions: 1,
        outcomeSuccessRate: 0,
        unknownRate: 1,
      },
      hardInvariantResults: { no_unknown_as_success: 'pass' },
    })
  })

  it('records a reviewed revision prediction without inventing a later Version outcome', async () => {
    const fixture = await trackedFixture({ stale: true })
    await settle(fixture, 'pass')
    const proposed = await fixture.repository.proposeRevision({
      ...envelope(), usageId: fixture.progress.usageId, baseVersionId: fixture.baseVersion.experienceVersionId,
    }, fixture.owner)
    const proposal = fixture.repository.getRevisionProposal(String(proposed.revisionProposalId), fixture.owner)
    await fixture.repository.decideRevisionChange({
      ...envelope(), revisionProposalId: proposal.revisionProposalId, expectedRevision: proposal.revision,
      revisionChangeId: proposal.changes[0]!.revisionChangeId, decision: 'accept', reason: 'verified M6 revision label',
    }, fixture.owner)

    const projection = await drain(fixture.repository)
    const revision = projection.rows.find(row => row.capability === 'revision')
    expect(revision).toMatchObject({
      predictor: { kind: 'deterministic_rule', version: 'm5-minimal-revision-v1' },
      observedOutcomes: [],
    })
    expect(revision?.humanLabels).toEqual([
      expect.objectContaining({ decision: expect.stringContaining(':accepted'), reason: 'verified M6 revision label' }),
    ])
  })

  it('fails owner readback closed and recovers an expired claim without duplicates', async () => {
    const fixture = await trackedFixture()
    expect(() => fixture.repository.getLearningProjection(fixture.runtimeActor))
      .toThrow(/cannot read Experience learning data/u)
    const now = Date.now()
    const first = await fixture.repository.claimLearningOutbox(
      new Date(now).toISOString(), new Date(now + 1).toISOString(), 1,
    )
    expect(first).toHaveLength(1)
    const recovered = await fixture.repository.claimLearningOutbox(
      new Date(now + 2).toISOString(), new Date(now + 60_000).toISOString(), 64,
    )
    expect(recovered.some(item => item.outboxId === first[0]!.outboxId)).toBe(true)
    await expect(fixture.repository.commitLearningProjection(first))
      .rejects.toThrow(/no longer owned by this projection run/u)
    await fixture.repository.releaseLearningOutbox(first, new Date(now + 120_000).toISOString())
    await fixture.repository.commitLearningProjection(recovered)
    const projection = fixture.repository.getLearningProjection(fixture.owner)
    expect(new Set(projection.rows.map(row => row.predictionId)).size).toBe(projection.rows.length)
  })

  it('rejects a durable learning label whose schema version no longer matches its table', async () => {
    const fixture = await trackedFixture()
    await drain(fixture.repository)
    const row = fixture.database.handle.prepare(
      'SELECT label_id, payload_json FROM human_labels ORDER BY label_id LIMIT 1',
    ).get() as { label_id: string; payload_json: string }
    fixture.database.handle.prepare('UPDATE human_labels SET payload_json = ? WHERE label_id = ?').run(
      JSON.stringify({ ...JSON.parse(row.payload_json), schemaVersion: 'unsupported-learning-label' }),
      row.label_id,
    )
    expect(() => fixture.repository.readLearningProjection()).toThrow(/durable JSON is incomplete/u)
  })

  it('queues and applies a rebuild when the deterministic builder version changes', async () => {
    const fixture = await trackedFixture()
    const current = await drain(fixture.repository)
    fixture.database.handle.prepare(
      "UPDATE projection_checkpoints SET builder_version = 'm6-learning-v1' WHERE projection_key = ?",
    ).run(current.projectionKey)

    await fixture.repository.ensureLearningProjectionBuilder()
    const rebuilt = await drain(fixture.repository)

    expect(rebuilt.builderVersion).toBe('m7-learning-v4')
    expect(rebuilt.generation).toBe(current.generation + 1)
  })
})

async function trackedFixture(options: {
  readonly stale?: boolean
  readonly approvalSurface?: 'browser' | 'management'
} = {}) {
  const fixture = await createM5Fixture(options)
  cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
  return fixture
}

async function drain(repository: ExperienceRepository) {
  let projection: ReturnType<ExperienceRepository['readLearningProjection']> | undefined
  while (true) {
    const now = new Date()
    const claimed = await repository.claimLearningOutbox(
      now.toISOString(), new Date(now.getTime() + 30_000).toISOString(), 64,
    )
    if (claimed.length === 0) return projection ?? repository.readLearningProjection()
    projection = await repository.commitLearningProjection(claimed)
  }
}

async function settle(
  fixture: Awaited<ReturnType<typeof createM5Fixture>>,
  result: 'pass' | 'unknown',
): Promise<void> {
  // Drive the prepared delivery through the real request-inclusion entry points so the
  // fixture Version is a genuinely *used* sample (a prepared-only delivery is NOT use).
  const ctx = fixture.repository.getContextUsage(String(fixture.planning.plan.usageId), fixture.owner)
  const delivery = ctx.delivery!
  const now = new Date().toISOString()
  await fixture.repository.recordContextAppended({
    contextDeliveryId: delivery.contextDeliveryId,
    sessionId: delivery.sessionId,
    messageId: delivery.messageId,
    contentDigest: delivery.contentDigest,
    sessionEventSeq: 1,
    appendedAt: now,
  })
  await fixture.repository.recordContextIncluded({
    contextDeliveryId: delivery.contextDeliveryId,
    requestBoundaryRef: `m6-request-${fixture.planning.plan.usageId}`,
    deliveredAt: now,
  })
  let progress = fixture.progress
  while (progress.state !== 'completed') {
    await fixture.repository.progressUsage({
      ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
      action: 'advance', checkpointRef: progress.stepRef, reason: 'M6 fixture completed the approved step',
    }, fixture.owner)
    progress = fixture.repository.getUsageExecution(String(progress.usageId), fixture.owner).progress!
  }
  const verification = verificationRun(String(progress.usageId), progress.controllerRevision, result)
  await fixture.repository.recordVerification({
    ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
  }, verification, fixture.owner)
  await fixture.repository.settleUsage({
    ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
    verificationRunId: verification.verificationRunId,
  }, fixture.owner)
}

function verificationRun(
  usageId: string,
  controllerRevision: number,
  result: 'pass' | 'unknown',
): VerificationRunView {
  const criteria = WEB_USAGE_CRITERIA.map(criterionId => criterion(criterionId, result))
  return {
    verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
    usageId: brandedId<'ExperienceUsageId'>(usageId, 'usageId'),
    controllerRevision,
    providerVersion: 'dsh-web-guided-v1',
    criteria,
    phase: result === 'pass' ? 'complete' : 'unknown',
    createdAt: new Date().toISOString(),
  }
}

function criterion(
  criterionId: CriterionVerificationView['criterionId'],
  result: 'pass' | 'unknown',
): CriterionVerificationView {
  const base = {
    criterionId, mandatory: true as const, result, observedAt: new Date().toISOString(),
    boundedValue: { fixture: true }, sourceRef: result === 'unknown' ? null : `fixture://m6/${criterionId}`,
    reasonCode: result === 'pass' ? 'fixture_pass' : 'fixture_unknown',
  }
  return { ...base, integrityDigest: digest(base) }
}
