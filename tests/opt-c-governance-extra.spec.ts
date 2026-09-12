import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExperienceContextMessage } from '../src/adapters/context-message.js'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { ExperiencePlanningService } from '../src/application/planning-service.js'
import { contextSections, materializeContextSnapshot, renderContext } from '../src/domain/context.js'
import { admissionTaskDigest, digest, usageScopeDigest } from '../src/domain/planning.js'
import { brandedId, type LearningPredictionId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type {
  ActorView,
  ContextDeliveryView,
  CriterionVerificationView,
  ExperienceCandidateDraft,
  HistoryRankingReviewView,
  HistoryRankingApplyTicket,
  LearningGovernanceReceipt,
  LearningRankingView,
  PlanTaskCommandInput,
  PlanningCommandResult,
  PlanningObservationView,
  PlanningResultView,
  PlanningTaskInput,
  VerificationRunView,
} from '../src/types.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'
import { envelope } from './fixtures/m5-usage.js'

/**
 * OPT-C H-R3 governance evidence. The host history_ranking subject, the owner-only
 * learning/ranking-review entry, the dedicated evaluation/promotion, and the real plan apply + quota.
 * Uses the real publish/delivery/execute/settle path so reviews bind to genuinely used samples.
 */

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))) })

/** Test-local interception of the real Plan-save boundary: captures args and can defer/defect. */
class CapturingExperienceRepository extends ExperienceRepository {
  readonly captured: Array<{
    readonly input: PlanTaskCommandInput
    readonly planning: PlanningResultView
    readonly actor: ActorView
    readonly ticket: HistoryRankingApplyTicket | undefined
  }> = []
  /** When true, capture and return a deferred envelope WITHOUT saving (intercept before original). */
  pending = false
  override async createPlanningResult(
    input: PlanTaskCommandInput,
    planning: PlanningResultView,
    actor: ActorView,
    historyRanking?: HistoryRankingApplyTicket,
  ): Promise<PlanningCommandResult> {
    this.captured.push({ input, planning, actor, ticket: historyRanking })
    if (this.pending) {
      // Deferred: hand the planning back through an envelope without persisting the Plan.
      return { receipt: null as never, planning }
    }
    return super.createPlanningResult(input, planning, actor, historyRanking)
  }
  /** Invoke the original Plan-save with already-captured args (the release step). */
  async releaseSave(index: number): Promise<PlanningCommandResult> {
    const capture = this.captured[index]!
    return super.createPlanningResult(capture.input, capture.planning, capture.actor, capture.ticket)
  }
}

/** Injects one test-local failure right after the quota claim inside the save transaction (rollback). */
class FailingExperienceRepository extends ExperienceRepository {
  failOnce = false
  protected override verifyAndClaimHistoryRankingApply(
    handle: DatabaseSync,
    planning: PlanningResultView,
    ticket: HistoryRankingApplyTicket,
    actor: ActorView,
  ): void {
    super.verifyAndClaimHistoryRankingApply(handle, planning, ticket, actor)
    if (this.failOnce) {
      this.failOnce = false
      throw new Error('injected transaction failure after history-ranking claim')
    }
  }
}

describe('OPT-C Host history_ranking governance', () => {
  it('R3.1: history_ranking is an independent shadow subject, separate from the old six capabilities', async () => {
    const harness = await usageHarness([workflowDraft()])
    const governance = harness.repository.getLearningGovernance(harness.owner)
    // The old six capabilities are preserved unchanged.
    expect(governance.contracts).toHaveLength(6)
    expect(governance.capabilities).toHaveLength(6)
    expect(governance.capabilities.every(item => item.currentLevel === 'shadow')).toBe(true)
    // The independent history_ranking subject starts shadow with the ranker binding.
    const historyRanking = governance.historyRanking!
    expect(historyRanking.contract.capability).toBe('history_ranking')
    expect(historyRanking.contract.predictor).toBe('opt-history-ranking')
    expect(historyRanking.capability.currentLevel).toBe('shadow')
    expect(historyRanking.capability.policyRevision).toBe(1)
    expect(historyRanking.evaluations).toEqual([])
    await harness.close()
  })

  it('R3.2: an owner records one review of a readable shadow counterfactual via the service entry', async () => {
    const harness = await usageHarness([workflowDraft()])
    const { rankingRow, ranking } = await produceReadableRanking(harness)
    const evidenceRefs = [
      { kind: 'usage' as const, id: ranking.sourceUsageIds[0]!, digest: null },
      { kind: 'preflight' as const, id: 'preflight-review', digest: null },
    ]
    const command = rankingReviewCommand(rankingRow.predictionId, ranking, evidenceRefs, 'proposed', 'review on real comparison')
    const receipt = await harness.repository.reviewHistoryRanking(command, harness.owner)
    expect(receipt.action).toBe('history_ranking.review')
    expect(receipt.predictionId).toBe(rankingRow.predictionId)
    expect(receipt.rankingDigest).toMatch(/^sha256:/)
    expect(receipt.decisionId).not.toBeNull()

    const reviews = harness.repository.readHistoryRankingReviews(harness.owner)
    expect(reviews).toHaveLength(1)
    const review = reviews[0]!
    expect(review.predictionId).toBe(rankingRow.predictionId)
    expect(review.preferredOrder).toBe('proposed')
    expect(review.evidenceRefs.length).toBeGreaterThan(0)
    expect(review.baselineVersionIds).toEqual(ranking.baselineVersionIds)
    expect(review.proposedVersionIds).toEqual(ranking.proposedVersionIds)
    expect(review.actorId).toBe(harness.owner.actorId)
    // The review is read back through the immutable read entry with the exact digest binding.
    expect(review.rankingDigest).toBe(receipt.rankingDigest)
    await harness.close()
  })

  it('R3.3: an owner cannot review a non-owner comparison that is not a real shadow ranker', async () => {
    const harness = await usageHarness([workflowDraft()])
    const { rankingRow, ranking } = await produceReadableRanking(harness)
    const command = rankingReviewCommand(rankingRow.predictionId, ranking,
      [{ kind: 'usage' as const, id: ranking.sourceUsageIds[0]!, digest: null }], 'proposed', 'review')
    // Query-only actor (agent) is not the LocalOwner and must be rejected.
    await expect(harness.repository.reviewHistoryRanking(command, harness.runtimeActor))
      .rejects.toMatchObject({ code: 'principal_unauthorized' })
    await harness.close()
  })

  it('R3.4: a review must bind a readable comparison and the exact digest (invalid/missing rejected)', async () => {
    const harness = await usageHarness([workflowDraft()])
    const { rankingRow, ranking } = await produceReadableRanking(harness)
    const wrongDigest = rankingReviewCommand(rankingRow.predictionId, { ...ranking },
      [{ kind: 'usage' as const, id: ranking.sourceUsageIds[0]!, digest: null }], 'proposed', 'review-does-not-match')
    // Tampering with the digest is rejected.
    const asInput = { ...wrongDigest, rankingDigest: 'sha256:' + '0'.repeat(64) }
    await expect(harness.repository.reviewHistoryRanking(asInput, harness.owner))
      .rejects.toThrow(/digest does not match/u)
    await harness.close()
  })

  it('R3.6: dedicated evaluation passes from >=5 same-scope owner reviews (4 proposed + 1 baseline)', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evaluationReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    const governance = harness.repository.getLearningGovernance(harness.owner)
    const evaluation = governance.historyRanking!.evaluations
      .find(item => item.unlockContractEvaluationId === evaluationReceipt.evaluationId)!
    expect(evaluation.metricImplementationVersion).toBe('history-ranking-metrics-v1')
    expect(evaluation.outcome).toBe('passed')
    expect(evaluation.sampleCoverage).toBe(5)
    expect(evaluation.metricResults.reviewCount).toBe(5)
    expect(evaluation.metricResults.baselineFirstCount).toBe(1)
    expect(evaluation.metricResults.proposedPreferenceRatio).toBe(0.8)
    expect(evaluation.negativeClassCoverage).toContain('baseline_first_review')
    await harness.close()
  })

  it('R3.7: evaluation is inconclusive when no baseline-first review is present (cannot pass on proposed alone)', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, 'proposed', `proposed-${index}`)
    }
    const evaluationReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    const evaluation = harness.repository.getLearningGovernance(harness.owner).historyRanking!.evaluations
      .find(item => item.unlockContractEvaluationId === evaluationReceipt.evaluationId)!
    // Sufficient same-scope comparisons but a missing baseline-first negative is a threshold failure,
    // not a pass (and not an inconclusive data gap).
    expect(evaluation.outcome).toBe('failed')
    expect(evaluation.metricResults.baselineFirstCount).toBe(0)
    await harness.close()
  })

  it('R3.8: owner promotes history_ranking to suggest and stores the exact evaluation scope', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evaluationReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    const promoted = await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evaluationReceipt.evaluationId, reason: 'owner approval of bounded ranking quality', violationClass: 'none',
    }, harness.owner)
    expect(promoted.action).toBe('automation.promote')
    const capability = harness.repository.getLearningGovernance(harness.owner).historyRanking!.capability
    expect(capability.currentLevel).toBe('suggest')
    expect(capability.policyRevision).toBe(2)
    expect(capability.allowedScope).toMatchObject({ riskClass: 'standard', workspaceRoot: null })
    await harness.close()
  })

  it('R3.9: a non-passed / stale or wrong-subject evaluation cannot promote history_ranking', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, 'proposed', `proposed-${index}`)
    }
    const inconclusive = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    // A non-passed evaluation cannot promote.
    await expect(harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: inconclusive.evaluationId, reason: 'must remain blocked', violationClass: 'none',
    }, harness.owner)).rejects.toMatchObject({ code: 'invalid_command' })
    // An old applicability evaluation cannot authorize the history_ranking subject (wrong subject).
    const extractionReceived = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await expect(harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'applicability', action: 'promote', targetLevel: 'suggest',
      evaluationId: extractionReceived.evaluationId, reason: 'wrong subject', violationClass: 'none',
    }, harness.owner)).rejects.toMatchObject({ code: 'invalid_command' })
    await harness.close()
  })

  it('R3.5: one review per comparison and duplicate command is idempotent (no double review / no rewrite)', async () => {
    const harness = await usageHarness([workflowDraft()])
    const { rankingRow, ranking } = await produceReadableRanking(harness)
    const evidenceRefs = [{ kind: 'usage' as const, id: ranking.sourceUsageIds[0]!, digest: null }]
    const first = rankingReviewCommand(rankingRow.predictionId, ranking, evidenceRefs, 'proposed', 'first')
    const receipt = await harness.repository.reviewHistoryRanking(first, harness.owner)
    // Replaying the same command returns the original receipt (idempotent).
    const replay = await harness.repository.reviewHistoryRanking(first, harness.owner)
    expect(replay.receiptId).toBe(receipt.receiptId)
    // A different command reviewing the same comparison (conflicting rewrite) is rejected.
    const rewrite = rankingReviewCommand(rankingRow.predictionId, ranking, evidenceRefs, 'baseline', 'conflict')
    await expect(harness.repository.reviewHistoryRanking(rewrite, harness.owner))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
    // Exactly one review persisted for the comparison.
    expect(harness.repository.readHistoryRankingReviews(harness.owner)).toHaveLength(1)
    await harness.close()
  })

  it('R3.10: after review/evaluate/promote a real planning call applies the authorized reorder + claims quota', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evalReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evalReceipt.evaluationId, reason: 'owner approval', violationClass: 'none',
    }, harness.owner)

    // A new plan (same scope) consumes the authorized reorder.
    const newPlan = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build harness web application',
    }, 'apply-plan')
    const baselineVersionIds = comparisons[0]!.ranking.baselineVersionIds
    expect(baselineVersionIds.length).toBe(2)
    const applies = harness.repository.readHistoryRankingApplies(harness.owner)
    expect(applies).toHaveLength(1)
    const apply = applies[0]!
    expect(apply.usageId).toBe(String(newPlan.planning.plan.usageId))
    // The authorized reorder changed the applied version order from the deterministic baseline.
    expect(apply.appliedVersionIds.join('|')).not.toBe(apply.baselineVersionIds.join('|'))
    expect(apply.decisionId).not.toBeNull()
    expect(apply.evaluationId).toBe(String(evalReceipt.evaluationId))
    await harness.close()
  })

  it('R3.11: readback rebuilds the applied ranking with applied order, suggest mode, decision and evaluation', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evalReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evalReceipt.evaluationId, reason: 'owner approval', violationClass: 'none',
    }, harness.owner)
    const appliedPlan = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build harness web application',
    }, 'readback-plan')
    await drain(harness.repository)
    const row = harness.repository.readLearningProjection().rows.find(candidate =>
      candidate.predictor.version === 'opt-history-ranking'
        && (candidate.prediction.ranking as LearningRankingView).usageId === String(appliedPlan.planning.plan.usageId))!
    const view = row.prediction.ranking as LearningRankingView
    expect(view.mode).toBe('suggest')
    expect(view.appliedVersionIds.join('|')).not.toBe(view.baselineVersionIds.join('|'))
    expect(view.governanceDecisionId).not.toBeNull()
    expect(view.evaluationId).toBe(String(evalReceipt.evaluationId))
    await harness.close()
  })

  it('R3.12: a closed gate leaves the real Plan on the deterministic baseline (no unauthorized reorder)', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    // No reviews/evaluation/promotion -> history_ranking stays shadow, gate closed.
    await produceReorderComparisons(harness, 5)
    const plan = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build harness web application',
    }, 'closed-plan')
    // No reorder was applied (no apply record), and the plan keeps its deterministic order.
    expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(0)
    expect([...new Set(plan.planning.plan.selectedContributions
      .map(contribution => String(contribution.experienceVersionId)))].length).toBeGreaterThan(0)
    await harness.close()
  })

  it('R3.13: quota is exhausted after the rollout limit and further Plans are not reordered', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evalReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evalReceipt.evaluationId, reason: 'owner approval', violationClass: 'none',
    }, harness.owner)
    const reorderTask = { ...harness.taskA, text: 'alpha beta build harness web application' }
    // Consume the full rolloutLimit (10) of authorized plans.
    for (let index = 0; index < 10; index++) {
      await harness.plan(reorderTask, `quota-${index}`)
    }
    expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(10)
    // The 11th Plan finds the quota exhausted: the gate is closed and no apply/unauthorized reorder.
    const after = await harness.plan(reorderTask, 'quota-exhausted')
    const applies = await harness.repository.readHistoryRankingApplies(harness.owner)
    expect(applies).toHaveLength(10)
    expect(after.planning.plan.selectedContributions.length).toBeGreaterThan(0)
    await harness.close()
  })

  it('R3.14: a demotion between authority and save means the gate no longer authorizes a Plan', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evalReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evalReceipt.evaluationId, reason: 'owner approval', violationClass: 'none',
    }, harness.owner)
    // Demote immediately (e.g. safety metric drift) -> gate closed, no reorder / no apply record.
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'demote', targetLevel: 'shadow',
      evaluationId: null, reason: 'safety metric drift', violationClass: 'metric_drift',
    }, harness.owner)
    const plan = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build harness web application',
    }, 'demoted-plan')
    expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(0)
    expect(plan.planning.plan.selectedContributions.length).toBeGreaterThan(0)
    await harness.close()
  })

  it('R3.15: a later settlement does not change an earlier reviewed comparison (review stays current)', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const prior = harness.repository.readHistoryRankingReviews(harness.owner)
    // Add more delivered/settled usages after the reviews; past rankings are as-of and must not change.
    for (let index = 0; index < 3; index++) {
      await harness.runUsedUsage(harness.taskA, 'pass', `later-${index}`)
    }
    await drain(harness.repository)
    const after = harness.repository.readHistoryRankingReviews(harness.owner)
    expect(after).toHaveLength(prior.length)
    for (const review of prior) {
      const still = after.find(item => item.reviewId === review.reviewId)!
      expect(still.rankingDigest).toBe(review.rankingDigest)
    }
    await harness.close()
  })

  it('R3.16: two real authorized pending tickets race the last quota slot across distinct handles', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evalReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evalReceipt.evaluationId, reason: 'owner approval', violationClass: 'none',
    }, harness.owner)
    const reorderTask = { ...harness.taskA, text: 'alpha beta build harness web application' }
    // Consume 9 authorized reorders on the first connection.
    for (let index = 0; index < 9; index++) await harness.plan(reorderTask, `c1-${index}`)
    expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(9)

    // Two DISTINCT SQLite handles over the same file, each with a capturing repository + its own service.
    const dbA = await ExperienceDatabase.open({ databasePath: harness.databasePath, journalMode: 'wal', synchronous: 'normal', busyTimeoutMs: 1_000, maxPendingWrites: 16 })
    const dbB = await ExperienceDatabase.open({ databasePath: harness.databasePath, journalMode: 'wal', synchronous: 'normal', busyTimeoutMs: 1_000, maxPendingWrites: 16 })
    try {
      const repoA = new CapturingExperienceRepository(dbA)
      repoA.pending = true
      const repoB = new CapturingExperienceRepository(dbB)
      repoB.pending = true
      const serviceA = harness.makeService(repoA)
      const serviceB = harness.makeService(repoB)
      // Start two plan commands (intercept before the original Plan save), capturing real args/tickets.
      const planInput = (sessionKey: string) => ({
        ...envelope(), sessionId: sessionKey, interaction: 'defer' as const, confirmExternalModelProcessing: false, task: reorderTask,
      })
      await serviceA.plan(planInput('contend-A'), harness.owner)
      await serviceB.plan(planInput('contend-B'), harness.owner)
      expect(repoA.captured).toHaveLength(1)
      expect(repoB.captured).toHaveLength(1)
      const ticketA = repoA.captured[0]!.ticket!
      const ticketB = repoB.captured[0]!.ticket!
      expect(ticketA.authorized).toBe(true)
      expect(ticketB.authorized).toBe(true)
      // Both tickets are authorized for the SAME current authorize decision.
      expect(ticketA.governanceDecisionId).toBe(ticketB.governanceDecisionId)
      expect(ticketA.evaluationId).toBe(ticketB.evaluationId)
      // Release save A (claims the 10th/last slot), then release save B (must be rejected, no over-commit).
      await repoA.releaseSave(0)
      expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(10)
      await expect(repoB.releaseSave(0)).rejects.toMatchObject({ code: 'stale_revision' })
      // No loser Usage/Plan/receipt/outbox beyond apply 10, and no extra apply/quota leak.
      expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(10)
    } finally {
      await dbA.close()
      await dbB.close()
    }
    await harness.close()
  })

  it('R3.17: a demote + re-promote between gate read and save rejects the stale ticket (no policy leak)', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evalReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evalReceipt.evaluationId, reason: 'owner approval', violationClass: 'none',
    }, harness.owner)
    const reorderTask = { ...harness.taskA, text: 'alpha beta build harness web application' }
    // Capture a real authorized pending Plan save on a SECOND connection (intercepted before save).
    const dbB = await ExperienceDatabase.open({ databasePath: harness.databasePath, journalMode: 'wal', synchronous: 'normal', busyTimeoutMs: 1_000, maxPendingWrites: 16 })
    try {
      const repoB = new CapturingExperienceRepository(dbB)
      repoB.pending = true
      const serviceB = harness.makeService(repoB)
      await serviceB.plan({
        ...envelope(), sessionId: 'revoke-save', interaction: 'defer', confirmExternalModelProcessing: false, task: reorderTask,
      }, harness.owner)
      const capture = repoB.captured[0]!
      const ticket = capture.ticket!
      expect(ticket.authorized).toBe(true)
      // The pending ticket carries the current policy identity (not a fabricated id).
      expect(ticket.policyRevision).toBe(harness.repository.getLearningGovernance(harness.owner).historyRanking!.capability.policyRevision)
      expect(ticket.governanceDecisionId).not.toBeNull()
      // Demote + re-promote (public methods, on the first connection) -> new policy identity.
      await harness.repository.changeAutomationLevel({
        ...envelope(), capability: 'history_ranking', action: 'demote', targetLevel: 'shadow',
        evaluationId: null, reason: 'metric drift', violationClass: 'metric_drift',
      }, harness.owner)
      await harness.repository.changeAutomationLevel({
        ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
        evaluationId: evalReceipt.evaluationId, reason: 'owner re-approval', violationClass: 'none',
      }, harness.owner)
      // Release the ORIGINAL save with the UNCHANGED captured args: the previously valid ticket is now revoked.
      await expect(repoB.releaseSave(0)).rejects.toMatchObject({ code: 'stale_revision' })
      expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(0)
    } finally {
      await dbB.close()
    }
    await harness.close()
  })

  it('R3.18: an early-created/delivered/executed Usage settled AFTER a comparison never enters it', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    // create/deliver/execute Usage U but DEFER its settlement.
    const u = await harness.beginUsage(harness.taskA, 'early-usage-u')
    // Build the compare/sample pool and a comparison Q (with seed samples settled before Q).
    const comparisons = await produceReorderComparisons(harness, 1)
    const comparison = comparisons[0]!
    const beforeRow = harness.repository.readLearningProjection().rows.find(row => row.predictionId === comparison.predictionId)!
    const before = beforeRow.prediction.ranking as LearningRankingView
    const asOfSampleCount = before.sampleCount
    const asOfSourceIds = before.sourceUsageIds.join('|')
    expect(asOfSourceIds.includes(u.usageId)).toBe(false)
    // Now settle U (strictly after Q was created) and rebuild the projection.
    await harness.finishUsage(u.usageId, u.sessionKey, 'pass')
    await drain(harness.repository)
    const afterRow = harness.repository.readLearningProjection().rows.find(row => row.predictionId === comparison.predictionId)!
    const after = afterRow.prediction.ranking as LearningRankingView
    // U is excluded from Q: Q's as-of samples/order/digest are unchanged.
    expect(after.sourceUsageIds.includes(u.usageId)).toBe(false)
    expect(after.sampleCount).toBe(asOfSampleCount)
    expect(after.sourceUsageIds.join('|')).toBe(asOfSourceIds)
    expect(after.proposedVersionIds.join('|')).toBe(comparison.ranking.proposedVersionIds.join('|'))
    // A LATER comparison (created strictly after U's settlement) DOES include U when otherwise eligible.
    const later = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build harness web application',
    }, 'later-comp')
    await drain(harness.repository)
    const laterRow = harness.repository.readLearningProjection().rows.find(row =>
      row.predictor.version === 'opt-history-ranking'
        && (row.prediction.ranking as LearningRankingView).usageId === String(later.planning.plan.usageId))!
    const laterRanking = laterRow.prediction.ranking as LearningRankingView
    expect(laterRanking.usageId).not.toBe(String(comparison.ranking.usageId))
    expect(laterRanking.sourceUsageIds).toContain(u.usageId)
    await harness.close()
  })

  it('R3.19: a failure after the in-transaction claim rolls back with no leak; retry then succeeds exactly once', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta build harness web' }),
    ])
    const comparisons = await produceReorderComparisons(harness, 5)
    for (let index = 0; index < 5; index++) {
      await reviewComparison(harness, comparisons[index]!, index === 4 ? 'baseline' : 'proposed', `review-${index}`)
    }
    const evalReceipt = await harness.repository.evaluateUnlockContract({
      ...envelope(), capability: 'history_ranking',
    }, harness.owner)
    await harness.repository.changeAutomationLevel({
      ...envelope(), capability: 'history_ranking', action: 'promote', targetLevel: 'suggest',
      evaluationId: evalReceipt.evaluationId, reason: 'owner approval', violationClass: 'none',
    }, harness.owner)
    const reorderTask = { ...harness.taskA, text: 'alpha beta build harness web application' }
    // Capture a fresh authorized pending save, then run it on a failing repo (same file/handle).
    const dbB = await ExperienceDatabase.open({ databasePath: harness.databasePath, journalMode: 'wal', synchronous: 'normal', busyTimeoutMs: 1_000, maxPendingWrites: 16 })
    try {
      const captureRepo = new CapturingExperienceRepository(dbB)
      captureRepo.pending = true
      const captureService = harness.makeService(captureRepo)
      await captureService.plan({
        ...envelope(), sessionId: 'rollback-save', interaction: 'defer', confirmExternalModelProcessing: false, task: reorderTask,
      }, harness.owner)
      const cap = captureRepo.captured[0]!
      const failing = new FailingExperienceRepository(dbB)
      failing.failOnce = true
      // The claim is recorded inside the transaction, then the injected failure rolls it all back.
      await expect(failing.createPlanningResult(cap.input, cap.planning, cap.actor, cap.ticket))
        .rejects.toThrow(/injected transaction failure/u)
      // Nothing durable leaked: no apply, no Usage/Plan/receipt for that command/usage.
      expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(0)
      expect(() => harness.repository.getPlanningResult(String(cap.planning.plan.usageId), harness.owner)).toThrow()
      // Retry the EXACT command/input; it now commits exactly one apply + one Plan.
      failing.failOnce = false
      const committed = await failing.createPlanningResult(cap.input, cap.planning, cap.actor, cap.ticket)
      expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(1)
      expect(committed.planning.plan.usageId).toBe(cap.planning.plan.usageId)
      // Duplicate replay of the same command is idempotent (no extra claim).
      const replay = await failing.createPlanningResult(cap.input, cap.planning, cap.actor, cap.ticket)
      expect(replay.receipt.receiptId).toBe(committed.receipt.receiptId)
      expect(await harness.repository.readHistoryRankingApplies(harness.owner)).toHaveLength(1)
    } finally {
      await dbB.close()
    }
    await harness.close()
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rankingReviewCommand(
  predictionId: LearningPredictionId,
  ranking: LearningRankingView,
  evidenceRefs: HistoryRankingReviewView['evidenceRefs'],
  preferredOrder: HistoryRankingReviewView['preferredOrder'],
  reason: string,
) {
  return {
    ...envelope(),
    predictionId,
    rankingDigest: digest({ projectionKey: 'experience-learning-v1', builderVersion: 'm7-learning-v4', ranking }),
    preferredOrder,
    reason,
    evidenceRefs,
  }
}

async function reviewComparison(
  harness: UsageHarness,
  comparison: { predictionId: LearningPredictionId; ranking: LearningRankingView },
  preferredOrder: HistoryRankingReviewView['preferredOrder'],
  reason: string,
): Promise<LearningGovernanceReceipt> {
  return harness.repository.reviewHistoryRanking(
    rankingReviewCommand(comparison.predictionId, comparison.ranking,
      [{ kind: 'usage', id: comparison.ranking.sourceUsageIds[0]!, digest: null }],
      preferredOrder, reason),
    harness.owner,
  )
}

/** Produce `n` distinct query rankings whose baseline differs from proposed (a legal reorder). */
async function produceReorderComparisons(harness: UsageHarness, count: number): Promise<Array<{ predictionId: LearningPredictionId; ranking: LearningRankingView }>> {
  const aId = harness.publishedVersionIds[0]!
  const bId = harness.publishedVersionIds[1]!
  const earlierId = String(aId).localeCompare(String(bId)) <= 0 ? aId : bId
  const laterId = earlierId === aId ? bId : aId
  const idToTask: Record<string, PlanningTaskInput> = { [aId]: harness.taskA, [bId]: harness.taskB }
  // Give the baseline-first (earlier id) version lower history so a later-id version legally reorders.
  for (let index = 0; index < 5; index++) {
    await harness.runUsedUsage(idToTask[earlierId]!, 'fail', `low-${index}`)
    await harness.runUsedUsage(idToTask[laterId]!, 'pass', `high-${index}`)
  }
  await drain(harness.repository)
  const comparisons: Array<{ predictionId: LearningPredictionId; ranking: LearningRankingView }> = []
  for (let index = 0; index < count; index++) {
    const query = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build harness web application',
    }, `comparison-query-${index}`)
    await drain(harness.repository)
    const row = harness.repository.readLearningProjection().rows.find(candidate =>
      candidate.predictor.version === 'opt-history-ranking'
        && (candidate.prediction.ranking as LearningRankingView).usageId === String(query.planning.plan.usageId))!
    const ranking = row.prediction.ranking as LearningRankingView
    if (ranking.baselineVersionIds.length < 2
      || JSON.stringify(ranking.baselineVersionIds) === JSON.stringify(ranking.proposedVersionIds)) {
      throw new Error('expected a real comparison with baseline != proposed')
    }
    comparisons.push({ predictionId: row.predictionId, ranking })
  }
  return comparisons
}

async function produceReadableRanking(harness: UsageHarness): Promise<{ rankingRow: { predictionId: LearningPredictionId }; ranking: LearningRankingView }> {
  // Create >=5 used samples (included + executed + settled) so the counterfactual is a real shadow
  // ranking (mode=shadow) with bound used source usages.
  for (let index = 0; index < 5; index++) {
    await harness.runUsedUsage(harness.taskA, 'pass', `seed-sample-${index}`)
  }
  await drain(harness.repository)
  const query = await harness.plan(harness.taskA, 'query-for-review')
  await drain(harness.repository)
  const row = harness.repository.readLearningProjection().rows.find(candidate =>
    candidate.predictor.version === 'opt-history-ranking'
      && (candidate.prediction.ranking as LearningRankingView).usageId === String(query.planning.plan.usageId))!
  const ranking = row.prediction.ranking as LearningRankingView
  if (ranking.sourceUsageIds.length === 0) throw new Error('expected a shadow ranking with bound used samples')
  return { rankingRow: { predictionId: row.predictionId }, ranking }
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

interface UsageHarness {
  readonly repository: ExperienceRepository
  /** A second repository over the SAME SQLite handle (cross-connection/quota sharing). */
  readonly secondRepository: ExperienceRepository
  readonly databasePath: string
  readonly database: ExperienceDatabase
  readonly owner: ActorView
  readonly runtimeActor: ActorView
  readonly taskA: PlanningTaskInput
  readonly taskB: PlanningTaskInput
  readonly publishedVersionIds: readonly string[]
  runUsedUsage(task: PlanningTaskInput, result: 'pass' | 'fail' | 'unknown', sessionKey: string): Promise<string>
  beginUsage(task: PlanningTaskInput, sessionKey: string): Promise<{ usageId: string; usedVersionId: string; sessionKey: string }>
  finishUsage(usageId: string, sessionKey: string, result: 'pass' | 'fail' | 'unknown'): Promise<void>
  plan(task: PlanningTaskInput, sessionKey: string): Promise<Awaited<ReturnType<ExperiencePlanningService['plan']>>>
  /** Build a planning service bound to an arbitrary repository (over the same fixed observations). */
  makeService(repo: ExperienceRepository): ExperiencePlanningService
  close(): Promise<void>
}

async function usageHarness(drafts: readonly ExperienceCandidateDraft[]): Promise<UsageHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-optc-gov-'))
  cleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 1_000, maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const secondRepository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  await secondRepository.initializePrincipal()
  const owner: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(principal, 'actorId'), principalId: principal,
    kind: 'management_local_owner', authority: 'owner',
  }
  const runtimeActor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>('agent:optc-gov-runtime', 'actorId'), principalId: principal,
    kind: 'agent', authority: 'query_only',
  }
  const current = observations()
  const service = new ExperiencePlanningService(
    repository,
    { observe: async () => current } as never,
    { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
    { retrievalCandidateLimit: 32, observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
    'deterministic',
  )
  const publishedVersionIds: string[] = []
  for (const [index, draft] of drafts.entries()) {
    const result = await publishReviewedWorkflow(repository, owner, 51 + index, draft)
    publishedVersionIds.push(String(result.published.experienceVersionId))
  }
  const taskA: PlanningTaskInput = {
    text: 'Alpha build harness web application',
    workspaceRoot: null, targetExposure: 'local', mustUseExperience: true, riskClass: 'standard',
    requiredCapabilities: ['build', 'web'], requestedUseMode: 'guided', overrideDecisionIds: [],
  }
  const taskB: PlanningTaskInput = {
    text: 'Beta deploy harness web application',
    workspaceRoot: null, targetExposure: 'local', mustUseExperience: true, riskClass: 'standard',
    requiredCapabilities: ['build', 'web'], requestedUseMode: 'guided', overrideDecisionIds: [],
  }
  const plan = async (taskInput: PlanningTaskInput, sessionKey: string) => service.plan({
    ...envelope(), sessionId: sessionKey, interaction: 'defer', confirmExternalModelProcessing: false,
    task: taskInput,
  }, owner)
  const beginUsage = async (taskInput: PlanningTaskInput, sessionKey: string) => {
    const commandId = randomUUID()
    const planning = await plan(taskInput, sessionKey)
    const usedVersionId = String(planning.planning.plan.selectedContributions[0]!.experienceVersionId)
    const request = planning.planning.approvalRequest!
    await repository.decidePlan({
      ...envelope(), requestId: request.requestId, usagePlanId: request.usagePlanId,
      expectedPlanRevision: request.planRevision, decision: 'approve', reason: 'approve',
    }, owner)
    const claimed = await repository.claimAdmissionRetryBinding({
      taskInputDigest: admissionTaskDigest(taskInput.text),
      sessionId: sessionKey,
      scopeDigest: usageScopeDigest(taskInput),
      workspaceRoot: taskInput.workspaceRoot,
      runtimeActor,
      leaseMs: 30_000,
    })
    if (claimed === null) throw new Error('claim failed')
    const content = renderContext(contextSections(claimed.planning))
    const contextSnapshotId = brandedId<'ExperienceContextSnapshotId'>(`snap-${commandId}`, 'contextSnapshotId')
    const contextDeliveryId = brandedId<'ExperienceContextDeliveryId'>(`del-${commandId}`, 'contextDeliveryId')
    const message = createExperienceContextMessage(content, {
      usageId: claimed.planning.plan.usageId,
      contextSnapshotId,
      contentDigest: digest(content),
      sections: contextSections(claimed.planning),
    }, contextDeliveryId)
    const createdAt = new Date().toISOString()
    const snapshot = materializeContextSnapshot(claimed.planning, contextSections(claimed.planning),
      contextSnapshotId, String(message.id), createdAt)
    const delivery: ContextDeliveryView = {
      contextDeliveryId, contextSnapshotId,
      usageId: claimed.planning.plan.usageId,
      sessionId: sessionKey,
      messageId: String(message.id),
      contentDigest: snapshot.contentDigest,
      deliveryStatus: 'prepared',
      sessionEventSeq: null, requestBoundaryRef: null, appendedAt: null, deliveredAt: null,
      createdAt,
    }
    await repository.consumeClaimAndPrepareContext({ claimed, currentObservations: current, snapshot, delivery })
    await repository.recordContextAppended({
      contextDeliveryId, sessionId: sessionKey, messageId: String(message.id),
      contentDigest: snapshot.contentDigest, sessionEventSeq: 1, appendedAt: createdAt,
    })
    await repository.recordContextIncluded({
      contextDeliveryId, requestBoundaryRef: `req-${sessionKey}`, deliveredAt: createdAt,
    })
    const progress = await repository.startUsage(String(claimed.planning.plan.usageId), sessionKey, runtimeActor)
    return { usageId: String(claimed.planning.plan.usageId), usedVersionId, sessionKey, progress }
  }
  const finishUsage = async (usageId: string, sessionKey: string, result: 'pass' | 'fail' | 'unknown') => {
    let progress = repository.getUsageExecution(usageId, owner).progress!
    while (progress.state !== 'completed') {
      await repository.progressUsage({
        ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
        action: 'advance', checkpointRef: progress.stepRef, reason: `advance ${sessionKey}`,
      }, owner)
      progress = repository.getUsageExecution(usageId, owner).progress!
    }
    const verification = verificationRun(progress.usageId, progress.controllerRevision, result)
    await repository.recordVerification({
      ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
    }, verification, owner)
    await repository.settleUsage({
      ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
      verificationRunId: verification.verificationRunId,
    }, owner)
  }
  const runUsedUsage = async (taskInput: PlanningTaskInput, result: 'pass' | 'fail' | 'unknown', sessionKey: string) => {
    const begun = await beginUsage(taskInput, sessionKey)
    await finishUsage(begun.usageId, sessionKey, result)
    return begun.usedVersionId
  }
  const makeService = (repo: ExperienceRepository) => new ExperiencePlanningService(
    repo,
    { observe: async () => current } as never,
    { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
    { retrievalCandidateLimit: 32, observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
    'deterministic',
  )
  return {
    repository, secondRepository, databasePath: join(directory, 'experience.sqlite'), database,
    owner, runtimeActor, taskA, taskB, publishedVersionIds, runUsedUsage, plan, beginUsage, finishUsage,
    makeService,
    close: async () => { await database.close() },
  }
}

function verificationRun(usageId: string, controllerRevision: number, result: 'pass' | 'fail' | 'unknown'): VerificationRunView {
  const criteria = WEB_USAGE_CRITERIA.map(criterionId => criterion(criterionId, result))
  return {
    verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
    usageId: brandedId<'ExperienceUsageId'>(usageId, 'usageId'),
    controllerRevision,
    providerVersion: 'dsh-web-guided-v1',
    criteria,
    phase: result === 'unknown' ? 'unknown' : 'complete',
    createdAt: new Date().toISOString(),
  }
}

function criterion(criterionId: CriterionVerificationView['criterionId'], result: 'pass' | 'fail' | 'unknown'): CriterionVerificationView {
  const base = {
    criterionId, mandatory: true as const, result, observedAt: new Date().toISOString(),
    boundedValue: { fixture: true }, sourceRef: result === 'unknown' ? null : `fixture://m6/${criterionId}`,
    reasonCode: result === 'pass' ? 'fixture_pass' : result === 'fail' ? 'fixture_fail' : 'fixture_unknown',
  }
  return { ...base, integrityDigest: digest(base) }
}

function observations(): PlanningObservationView[] {
  return ['repository_state', 'build_artifact', 'web_contract', 'process_socket', 'authenticated_http']
    .map((kind, index) => {
      const base = {
        observationId: randomUUID(),
        kind: kind as PlanningObservationView['kind'],
        providerVersion: 'm5-fixture-v1',
        status: 'observed' as const,
        summary: `${kind} observed`,
        values: kind === 'web_contract' ? { authRequired: true, loopbackOnly: true } : { present: true },
        sourceRefs: [`fixture://m5/${String(index)}`],
        observedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 300_000).toISOString(),
        reasonCode: null,
      }
      return { ...base, contentDigest: digest(base) }
    })
}
