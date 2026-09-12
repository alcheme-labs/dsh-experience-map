import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExperienceContextMessage } from '../src/adapters/context-message.js'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { ExperiencePlanningService } from '../src/application/planning-service.js'
import { contextSections, materializeContextSnapshot, renderContext } from '../src/domain/context.js'
import { admissionTaskDigest, digest, usageScopeDigest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type {
  ActorView,
  ContextDeliveryView,
  CriterionVerificationView,
  ExperienceCandidateDraft,
  LearningRankingView,
  LearningUsageHistoryView,
  PlanningObservationView,
  PlanningTaskInput,
  VerificationRunView,
} from '../src/types.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'
import {
  RELEVANT_KEYWORDS,
  diagnosticSpec,
  planInput,
  retrievalFixture,
  task,
} from './fixtures/retrieval-fixture.js'
import { seedVersions } from './fixtures/store-seed.js'
import { createM5Fixture, envelope } from './fixtures/m5-usage.js'

/**
 * OPT-C Host rework evidence. The positives now use the *real* request-inclusion entry points
 * (recordContextAppended + recordContextIncluded), so a prepared-only/prepared-scored fixture can
 * never be reported as actual use. The dedicated suggest-apply path remains conservatively closed.
 */

const cleanup: Array<{ directory: string; close(): Promise<void> }> = []
const harnessCleanup: string[] = []

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
  await Promise.all(harnessCleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('OPT-C Host usage attribution, eligibility-bounded shadow ranking and dedicated gate', () => {
  it('R1: a prepared-only settled Usage must not earn actual-use success', async () => {
    const fixture = await trackedFixture()
    await settle(fixture, 'pass')
    const ctx = fixture.repository.getContextUsage(String(fixture.planning.plan.usageId), fixture.owner)
    expect(ctx.delivery?.deliveryStatus).toBe('prepared')
    const projection = await drain(fixture.repository)
    const history = projection.rows.find(row => row.capability === 'applicability'
      && row.predictor.version !== 'opt-history-ranking')!.prediction.history as LearningUsageHistoryView
    expect(history.participation).not.toBe('used')
    expect(history.taskOutcome).toBeNull()
    expect(history.reasonCodes.some(code => code.startsWith('context_delivery_'))).toBe(true)
  })

  it('H1: a version whose Context genuinely entered the request and was executed/settled is used', async () => {
    const fixture = await trackedFixture()
    await enterRequest(fixture)
    await settle(fixture, 'pass')
    const projection = await drain(fixture.repository)
    const row = projection.rows.find(item => item.capability === 'applicability'
      && item.predictor.version !== 'opt-history-ranking')!
    const history = row.prediction.history as LearningUsageHistoryView

    expect(history.usageId).toBe(String(fixture.planning.plan.usageId))
    expect(history.experienceVersionId).toBe(String(fixture.baseVersion.experienceVersionId))
    expect(history.taskInputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(history.environmentKey).toBe('local')
    expect(history.componentRevisionIds.length).toBeGreaterThan(0)
    expect(history.participation).toBe('used')
    expect(history.taskOutcome).toBe('success')
    expect(history.attribution).toBe('task_participation')
    expect(history.reasonCodes).toContain('context_included_in_request')
    expect(history.reasonCodes).toContain('usage_executed_and_settled')
    expect(history.evidenceRefs.map(ref => ref.kind)).toEqual(expect.arrayContaining([
      'usage', 'preflight', 'version', 'context_snapshot', 'context_delivery', 'settlement', 'verification',
    ]))
    expect(row.observedOutcomes.map(outcome => outcome.outcome)).toEqual(['success'])
    expect(row.observedOutcomes.length).toBe(1)
  })

  it('H1/H2: a preflighted but not-selected version carries no score and no task outcome', async () => {
    const f = await retrievalFixture(32)
    try {
      const versions = await seedVersions(f.database, f.actor, [
        diagnosticSpec('TLS marketing deploy A', 'Monitor CDN availability', RELEVANT_KEYWORDS),
        diagnosticSpec('TLS marketing deploy A duplicate', 'Monitor CDN availability', RELEVANT_KEYWORDS),
      ])
      expect(versions.length).toBe(2)
      const result = await f.service.plan(planInput('candidate-not-selected', task()), f.actor)
      await drain(f.repository)
      const projection = f.repository.readLearningProjection()
      const selected = new Set(result.planning.plan.selectedContributions.map(item => String(item.experienceVersionId)))
      const preflightVersions = result.planning.preflights.map(item => String(item.experienceVersionId))
      expect(preflightVersions.length).toBe(2)
      expect(selected.size).toBeLessThan(preflightVersions.length)

      const notSelectedRow = projection.rows
        .filter(item => item.capability === 'applicability' && item.predictor.version !== 'opt-history-ranking')
        .find(item => !selected.has(String(item.inputRefs.find(ref => ref.kind === 'version')!.id)))
      expect(notSelectedRow).toBeDefined()
      const history = notSelectedRow!.prediction.history as LearningUsageHistoryView
      expect(history.participation).toBe('not_selected')
      expect(history.taskOutcome).toBeNull()
      expect(history.reasonCodes).toContain('not_in_selected_contributions')
      expect(notSelectedRow!.observedOutcomes).toEqual([])
      expect(notSelectedRow!.humanLabels).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('H2: participating versions share one common task result, each counted once', async () => {
    const fixture = await trackedFixture({ additionalDrafts: [workflowDraft()] })
    await enterRequest(fixture)
    await settle(fixture, 'pass')
    const projection = await drain(fixture.repository)
    const usedRows = projection.rows.filter(item => item.capability === 'applicability'
      && item.predictor.version !== 'opt-history-ranking'
      && (item.prediction.history as LearningUsageHistoryView).participation === 'used')
    expect(usedRows.length).toBe(2)
    const usageIds = new Set(usedRows.map(row => (row.prediction.history as LearningUsageHistoryView).usageId))
    expect(usageIds.size).toBe(1)
    for (const row of usedRows) {
      expect((row.prediction.history as LearningUsageHistoryView).taskOutcome).toBe('success')
      expect(row.observedOutcomes.length).toBe(1)
      expect(row.observedOutcomes[0]!.outcome).toBe('success')
    }
  })

  it('H2/H4: unknown stays separate from failure on a genuinely included usage', async () => {
    const fixture = await trackedFixture()
    await enterRequest(fixture)
    await settle(fixture, 'unknown')
    const projection = await drain(fixture.repository)
    const usedRow = projection.rows.find(item => item.capability === 'applicability'
      && item.predictor.version !== 'opt-history-ranking')!
    const history = usedRow.prediction.history as LearningUsageHistoryView
    expect(history.participation).toBe('used')
    expect(history.taskOutcome).toBe('unknown')
    expect(usedRow.observedOutcomes.map(outcome => outcome.outcome)).toEqual(['unknown'])
    expect(usedRow.observedOutcomes[0]!.outcome).not.toBe('success')
  })

  it('H3: outbox rebuild is idempotent and preserves the attribution history', async () => {
    const fixture = await trackedFixture()
    await enterRequest(fixture)
    await settle(fixture, 'pass')
    const before = await drain(fixture.repository)
    const snapshot = before.rows.map(row => ({ id: row.predictionId, history: row.prediction.history }))

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

    expect(rebuilt.rows.map(row => row.predictionId)).toEqual(snapshot.map(item => item.id))
    expect(rebuilt.rows.map(row => row.prediction.history)).toEqual(snapshot.map(item => item.history))
    expect(new Set(rebuilt.rows.map(row => row.predictionId)).size).toBe(rebuilt.rows.length)
  })

  it('H4: >=5 same-environment formally-used samples turn shadow ranking on; sample order is bounded', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta deploy harness web' }),
    ])
    for (let index = 0; index < 5; index++) {
      await harness.runUsedUsage(harness.taskA, 'pass', `sample-${index}`)
    }
    await drain(harness.repository)

    // Query on task A (same environment) after 5 used samples of version A.
    const queryA = await harness.plan(harness.taskA, 'query-a')
    const projection = await drain(harness.repository)
    const rankingA = projection.rows.find(row => row.predictor.version === 'opt-history-ranking'
      && (row.prediction.ranking as LearningRankingView).usageId === String(queryA.planning.plan.usageId))
    const viewA = rankingA!.prediction.ranking as LearningRankingView
    expect(viewA.mode).toBe('shadow')
    expect(viewA.sampleCount).toBe(5)
    expect(viewA.sourceUsageIds.length).toBe(5)
    // Applied stays the deterministic baseline (shadow has zero effect on selection).
    expect(viewA.appliedVersionIds).toEqual(viewA.baselineVersionIds)
  })

  it('H4: exactly-equally relevant candidates can be reordered by history (real reorder)', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha build', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta build', intent: 'beta build harness web' }),
    ])
    const alphaId = harness.publishedVersionIds[0]!
    const betaId = harness.publishedVersionIds[1]!
    // Equal-score candidates tie on the deterministic baseline by version id. To show a REAL
    // reorder (proposed !== baseline), give the higher history to the version that sorts LATER in
    // the baseline (so history pulls it up), and the low history to the version that sorts first.
    const laterFirst = String(alphaId).localeCompare(String(betaId)) > 0
    const highHistoryId = laterFirst ? alphaId : betaId
    const lowHistoryId = laterFirst ? betaId : alphaId
    const idToTask: Record<string, PlanningTaskInput> = { [alphaId]: harness.taskA, [betaId]: harness.taskB }
    for (let index = 0; index < 5; index++) {
      await harness.runUsedUsage(idToTask[highHistoryId]!, 'pass', `hr-${index}`)
      await harness.runUsedUsage(idToTask[lowHistoryId]!, 'fail', `lr-${index}`)
    }
    await drain(harness.repository)

    const query = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build harness web application',
    }, 'query-equal')
    const matchSet = query.planning.matchSet.candidates
    const alphaMatch = matchSet.find(c => String(c.experienceVersionId) === alphaId)!
    const betaMatch = matchSet.find(c => String(c.experienceVersionId) === betaId)!
    // The two candidates are genuinely equally relevant (identical structural + lexical score).
    expect(alphaMatch.structuralScore).toBe(betaMatch.structuralScore)
    expect(alphaMatch.lexicalScore).toBe(betaMatch.lexicalScore)
    expect(alphaMatch.rejected).toBe(false)
    expect(betaMatch.rejected).toBe(false)

    const projection = await drain(harness.repository)
    const ranking = projection.rows.find(row => row.predictor.version === 'opt-history-ranking'
      && (row.prediction.ranking as LearningRankingView).usageId === String(query.planning.plan.usageId))!
    const view = ranking.prediction.ranking as LearningRankingView
    expect(view.mode).toBe('shadow')
    expect(view.sampleCount).toBe(10)
    // Deterministic baseline = [lowHistoryId, highHistoryId] (equal scores, id order).
    expect(view.baselineVersionIds).toEqual([lowHistoryId, highHistoryId])
    // History really reorders the equally relevant pair, best-first.
    expect(view.proposedVersionIds).toEqual([highHistoryId, lowHistoryId])
    expect(view.proposedVersionIds).not.toEqual(view.baselineVersionIds)
    // Shadow never changes the actual selection.
    expect(view.appliedVersionIds).toEqual(view.baselineVersionIds)
  })

  it('H4: no-sample and different-version/different-environment queries are fallback (no inheritance)', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Harness Web alpha', intent: 'alpha build harness web' }),
      workflowDraft({ title: 'Harness Web beta', intent: 'beta deploy harness web' }),
    ])
    // 5 used samples of version A (success) and 5 used samples of version B (failure), same env.
    let alphaVersion = ''
    let betaVersion = ''
    for (let index = 0; index < 5; index++) {
      alphaVersion = await harness.runUsedUsage(harness.taskA, 'pass', `iso-a-${index}`)
      betaVersion = await harness.runUsedUsage(harness.taskB, 'fail', `iso-b-${index}`)
    }
    expect(alphaVersion).not.toBe(betaVersion)
    await drain(harness.repository)

    // A query that matches both versions sees each scored independently from its own samples.
    const queryBoth = await harness.plan({
      ...harness.taskA,
      text: 'alpha beta build deploy harness web application',
    }, 'query-both')
    const projection = await drain(harness.repository)
    const ranking = projection.rows.find(row => row.predictor.version === 'opt-history-ranking'
      && (row.prediction.ranking as LearningRankingView).usageId === String(queryBoth.planning.plan.usageId))
    const view = ranking!.prediction.ranking as LearningRankingView
    expect(view.mode).toBe('shadow')
    expect(view.sampleCount).toBe(10)
    expect(view.sourceUsageIds.length).toBe(10)
    expect(view.baselineVersionIds.length).toBe(2)
    // Independent per-version scoring is not inherited: the success-scored version A (score 6/7)
    // precedes the failure-scored version B (score 1/7). A's wins never cancel B's losses.
    expect(view.proposedVersionIds[0]).toBe(alphaVersion)
    expect(view.proposedVersionIds[1]).toBe(betaVersion)
    // Shadow never changes the actual selection.
    expect(view.appliedVersionIds).toEqual(view.baselineVersionIds)

    // Query on version A but a different environment: A's local samples must not be inherited.
    const queryOtherEnv = await harness.plan({ ...harness.taskA, workspaceRoot: '/var/other-workspace' },
      'query-other-env')
    const projectionEnv = await drain(harness.repository)
    const rankingEnv = projectionEnv.rows.find(row => row.predictor.version === 'opt-history-ranking'
      && (row.prediction.ranking as LearningRankingView).usageId === String(queryOtherEnv.planning.plan.usageId))
    const viewEnv = rankingEnv!.prediction.ranking as LearningRankingView
    expect(viewEnv.environmentKey).not.toBe('local')
    expect(viewEnv.mode).toBe('fallback')
    expect(viewEnv.sampleCount).toBe(0)
  })

  it('H4: a same-version, different-environment used sample never changes that Version score', async () => {
    const harness = await usageHarness([
      workflowDraft({ title: 'Verified DeepSeek Harness Web startup A', intent: 'Build web A' }),
    ])
    // 5 used samples of A in environment '/var/local-a'.
    for (let index = 0; index < 5; index++) {
      await harness.runUsedUsage({ ...harness.taskA, workspaceRoot: '/var/local-a' }, 'pass', `env-${index}`)
    }
    // A query in the default 'local' environment sees none of those samples.
    await drain(harness.repository)
    const queryLocal = await harness.plan(harness.taskA, 'query-local')
    const projection = await drain(harness.repository)
    const ranking = projection.rows.find(row => row.predictor.version === 'opt-history-ranking'
      && (row.prediction.ranking as LearningRankingView).usageId === String(queryLocal.planning.plan.usageId))
    const view = ranking!.prediction.ranking as LearningRankingView
    expect(view.environmentKey).toBe('local')
    expect(view.mode).toBe('fallback')
    expect(view.sampleCount).toBe(0)
  })

  it('H5: the default applicability contract never authorizes the history-rank predictor', async () => {
    const f = await retrievalFixture(1)
    try {
      const gate = f.repository.readHistoryRankingGate({
        workspaceRoot: null,
        targetExposure: 'local',
        riskClass: 'standard',
        environmentKey: 'local',
        taskInputDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        candidates: [],
      }, f.actor)
      expect(gate.authorized).toBe(false)
      expect(gate.mode).toBe('fallback')
      expect(gate.reasonCodes).toContain('history_ranking_current_level_is_not_suggest')
      expect(gate.governanceDecisionId).toBeNull()
      expect(gate.evaluationId).toBeNull()
      // The old applicability contract still never binds the ranker predictor.
      const contract = f.repository.getLearningGovernance(f.actor).contracts
        .find(item => item.capability === 'applicability')!
      expect(contract.metricDefinitions['predictor:opt-history-ranking']).toBeUndefined()
    } finally {
      await f.close()
    }
  })

  it('H5: a high-quality included-sample still does not unlock the rank predictor', async () => {
    const fixture = await trackedFixture()
    await enterRequest(fixture)
    await settle(fixture, 'pass')
    await drain(fixture.repository)
    const applicabilityRow = fixture.repository.readLearningProjection().rows
      .find(item => item.capability === 'applicability' && item.predictor.version !== 'opt-history-ranking')!
    expect(applicabilityRow.humanLabels.length).toBeGreaterThan(0)
    expect(applicabilityRow.observedOutcomes.some(item => item.outcome === 'success')).toBe(true)
    const gate = fixture.repository.readHistoryRankingGate({
      workspaceRoot: null,
      targetExposure: 'local',
      riskClass: 'standard',
      environmentKey: 'local',
      taskInputDigest: (applicabilityRow.prediction.history as LearningUsageHistoryView).taskInputDigest,
      candidates: [],
    }, fixture.owner)
    expect(gate.authorized).toBe(false)
    expect(gate.mode).toBe('fallback')
    expect(gate.reasonCodes).toContain('history_ranking_current_level_is_not_suggest')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function trackedFixture(options: NonNullable<Parameters<typeof createM5Fixture>[0]> = {}) {
  const fixture = await createM5Fixture(options)
  cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
  return fixture
}

/** Drive a prepared delivery to the real 'included_in_request' state via the production entry points. */
async function enterRequest(fixture: Awaited<ReturnType<typeof createM5Fixture>>) {
  const usageId = String(fixture.planning.plan.usageId)
  const ctx = fixture.repository.getContextUsage(usageId, fixture.owner)
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
    requestBoundaryRef: `request-${usageId}`,
    deliveredAt: now,
  })
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
  let progress = fixture.progress
  while (progress.state !== 'completed') {
    await fixture.repository.progressUsage({
      ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
      action: 'advance', checkpointRef: progress.stepRef, reason: 'OPT-C fixture completed the approved step',
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

function criterion(
  criterionId: CriterionVerificationView['criterionId'],
  result: 'pass' | 'fail' | 'unknown',
): CriterionVerificationView {
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

interface UsageHarness {
  readonly repository: ExperienceRepository
  readonly database: ExperienceDatabase
  readonly service: ExperiencePlanningService
  readonly owner: ActorView
  readonly runtimeActor: ActorView
  readonly taskA: PlanningTaskInput
  readonly taskB: PlanningTaskInput
  readonly publishedVersionIds: readonly string[]
  runUsedUsage(task: PlanningTaskInput, result: 'pass' | 'fail' | 'unknown', sessionKey: string): Promise<string>
  plan(task: PlanningTaskInput, sessionKey: string): Promise<Awaited<ReturnType<ExperiencePlanningService['plan']>>>
}

/**
 * Build one real SQLite store with two published versions and a planning service whose observations
 * are fixed, then drive fully *included + executed + settled* usages (via the production delivery
 * entry points) so attribution and the ranking sample pool are genuinely used.
 */
async function usageHarness(drafts: readonly ExperienceCandidateDraft[]): Promise<UsageHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-optc-harness-'))
  harnessCleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 1_000, maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  const owner: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(principal, 'actorId'), principalId: principal,
    kind: 'management_local_owner', authority: 'owner',
  }
  const runtimeActor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>('agent:optc-runtime', 'actorId'), principalId: principal,
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
  const published: string[] = []
  for (const [index, draft] of drafts.entries()) {
    const result = await publishReviewedWorkflow(repository, owner, 51 + index, draft)
    published.push(String(result.published.experienceVersionId))
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

  const runUsedUsage = async (taskInput: PlanningTaskInput, result: 'pass' | 'fail' | 'unknown', sessionKey: string) => {
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
    let progress = await repository.startUsage(String(claimed.planning.plan.usageId), sessionKey, runtimeActor)
    while (progress.state !== 'completed') {
      await repository.progressUsage({
        ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
        action: 'advance', checkpointRef: progress.stepRef, reason: `advance ${sessionKey}`,
      }, owner)
      progress = repository.getUsageExecution(String(progress.usageId), owner).progress!
    }
    const verification = verificationRun(String(progress.usageId), progress.controllerRevision, result)
    await repository.recordVerification({
      ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
    }, verification, owner)
    await repository.settleUsage({
      ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
      verificationRunId: verification.verificationRunId,
    }, owner)
    return usedVersionId
  }

  return { repository, database, service, owner, runtimeActor, taskA, taskB, publishedVersionIds: published, runUsedUsage, plan }
}
