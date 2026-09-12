import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { ExperienceApplicationService } from '../src/application/service.js'
import { ExperiencePlanningService } from '../src/application/planning-service.js'
import { parseRecordEvaluationObservationInput } from '../src/application/input.js'
import type { PlanReviewInteraction } from '../src/adapters/plan-interaction.js'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { digest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import { apply as applyRunner } from '../src/cli/runner.js'
import type {
  ActorView,
  CriterionVerificationView,
  EvaluationExecutionEvidence,
  PlanningTaskInput,
  RecordEvaluationObservationInput,
  VerificationRunView,
} from '../src/types.js'
import { createM5Fixture } from './fixtures/m5-usage.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'

const cleanup: Array<{ directory: string; close(): Promise<void> }> = []

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

describe('OPT-C evaluation observation not_used execution evidence', () => {
  it('records no_match, refused and planned-but-unused through real producers and reads back via a fresh repository', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const noMatch = await planMatchesNothing(fixture, 'case-unused-no-match')
    const refused = await planThenDeny(fixture, 'case-unused-refused')
    const normalNotUsed = await planThenContinueWithoutUse(fixture, 'case-unused-not-used')

    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: notUsedObservation(noMatch.planning, 'no_match', 'failure'),
    }, fixture.owner)
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: notUsedObservation(refused.planning, 'refused', 'unknown'),
    }, fixture.owner)
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: notUsedObservation(normalNotUsed.planning, 'not_used', 'success'),
    }, fixture.owner)

    // Verify each sample was bound to a genuine terminal not-used Admission at record time.
    expect(noMatch.planning.plan.disposition).toBe('no_match')
    expect(noMatch.planning.admissionAttempt.state).toBe('no_answerer_continue')
    expect(refused.planning.admissionAttempt.state).toBe('denied')
    expect(normalNotUsed.planning.admissionAttempt.state).toBe('no_answerer_continue')

    // Read back through a fresh repository (restart) to prove the JSON-payload readback is durable.
    await fixture.database.close()
    cleanup.pop()
    const database = await reopen(fixture.directory)
    cleanup.push({ directory: fixture.directory, close: () => database.close() })
    const repository = new ExperienceRepository(database)
    const principal = await repository.initializePrincipal()
    const owner = ownerActor(principal)
    const report = repository.getEvaluationReport('cohort-unused', owner)
    const arm = report.arms.find(item => item.comparisonArm === 'experience_map')!
    expect(arm.sampleCount).toBe(3)
    expect(arm.successCount).toBe(1)
    expect(arm.failureCount).toBe(1)
    expect(arm.unknownCount).toBe(1)
  })

  it('keeps legacy settled and a settled evidence marker behavior unchanged and never escapes old safety checks', async () => {
    const fixture = await createM5Fixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const settlement = await settleSuccess(fixture)
    const planning = fixture.planning
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...baseObservation('experience_map'),
        taskCaseId: 'case-settled',
        taskFingerprintId: planning.fingerprint.fingerprintId,
        usageId: planning.plan.usageId,
        settlementId: settlement.settlementId,
        outcome: 'success',
        retrievalResult: 'relevant',
        applicabilityDecision: 'use',
        decisionAnchorRefs: ['decision://case-settled'],
      },
    }, fixture.owner)
    // settled evidence marker is the explicit equivalent.
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...baseObservation('experience_map'),
        cohortId: 'cohort-settled-2',
        taskCaseId: 'case-settled-2',
        taskFingerprintId: planning.fingerprint.fingerprintId,
        usageId: planning.plan.usageId,
        settlementId: settlement.settlementId,
        outcome: 'success',
        retrievalResult: 'relevant',
        applicabilityDecision: 'use',
        decisionAnchorRefs: ['decision://case-settled-2'],
        executionEvidence: { kind: 'settled' },
      },
    }, fixture.owner)

    // The not_used path must not be repurposed to bypass the Settlement required-field check:
    // a null settlementId without not_used evidence stays rejected.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...baseObservation('experience_map'),
        cohortId: 'cohort-settled-3',
        taskCaseId: 'case-settled-3',
        taskFingerprintId: planning.fingerprint.fingerprintId,
        usageId: planning.plan.usageId,
        settlementId: null,
        outcome: 'success',
        retrievalResult: 'relevant',
        applicabilityDecision: 'use',
        decisionAnchorRefs: ['decision://case-settled-3'],
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'required_field_missing' })

    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...baseObservation('experience_map'),
        cohortId: 'cohort-settled-retrieval-mismatch',
        taskCaseId: 'case-settled-retrieval-mismatch',
        taskFingerprintId: planning.fingerprint.fingerprintId,
        usageId: planning.plan.usageId,
        settlementId: settlement.settlementId,
        outcome: 'success',
        retrievalResult: 'none',
        applicabilityDecision: 'use',
        decisionAnchorRefs: ['decision://case-settled-retrieval-mismatch'],
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })

  })

  it('rejects a no-match run reported as a relevant retrieval', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planMatchesNothing(fixture, 'case-no-match-claim')
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...notUsedObservation(planning, 'no_match', 'failure'),
        taskCaseId: 'case-no-match-claim',
        retrievalResult: 'relevant',
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('preserves external applicability labels and an irrelevant rejected-candidate retrieval', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const refused = await planThenDeny(fixture, 'case-external-refused')
    const unanswered = await planThenContinueWithoutUse(fixture, 'case-external-unknown')
    const rejected = await planRejectedMatch(fixture, 'case-external-irrelevant')
    expect(rejected.planning.matchSet.noMatch).toBe(true)
    expect(rejected.planning.matchSet.candidates.length).toBeGreaterThan(0)
    expect(rejected.planning.matchSet.candidates.every(candidate =>
      candidate.selectedComponentRevisionIds.length === 0)).toBe(true)

    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...notUsedObservation(refused.planning, 'refused', 'unknown'),
        cohortId: 'cohort-external-labels', taskCaseId: 'case-external-refused',
        applicabilityDecision: 'refuse',
      },
    }, fixture.owner)
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...notUsedObservation(unanswered.planning, 'not_used', 'unknown'),
        cohortId: 'cohort-external-labels', taskCaseId: 'case-external-unknown',
        applicabilityDecision: 'unknown',
      },
    }, fixture.owner)
    await fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...notUsedObservation(rejected.planning, 'no_match', 'failure'),
        cohortId: 'cohort-external-labels', taskCaseId: 'case-external-irrelevant',
        retrievalResult: 'irrelevant', applicabilityDecision: 'refuse',
      },
    }, fixture.owner)

    const report = fixture.repository.getEvaluationReport('cohort-external-labels', fixture.owner)
    expect(report.arms.find(arm => arm.comparisonArm === 'experience_map')?.sampleCount).toBe(3)
  })

  it('rejects Experience execution evidence on no_memory and retrieval_only arms', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    for (const comparisonArm of ['no_memory', 'retrieval_only'] as const) {
      await expect(fixture.repository.recordEvaluationObservation({
        ...envelope(), observation: {
          ...baseObservation(comparisonArm),
          taskFingerprintId: null, usageId: null, settlementId: null,
          retrievalResult: comparisonArm === 'no_memory' ? 'not_applicable' : 'relevant',
          applicabilityDecision: 'not_applicable',
          executionEvidence: { kind: 'not_used', usagePlanId: brandedId('usage-plan', 'usagePlanId'),
            planDigest: 'sha256:' + 'a'.repeat(64), admissionAttemptId: brandedId('admission', 'admissionAttemptId'),
            reason: 'not_used', outcomeSource: 'external_verifier' },
        },
      }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
    }
  })

  it('rejects forged or mismatched not_used identity, reason and Admission state transitions', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenDeny(fixture, 'case-neg')
    const observed = () => notUsedObservation(planning, 'refused', 'success')

    // Wrong usagePlanId.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observed(), executionEvidence: { ...evidence(planning), usagePlanId: brandedId('bad-plan', 'usagePlanId') },
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'source_unresolvable' })
    // Wrong planDigest.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observed(), executionEvidence: { ...evidence(planning), planDigest: 'sha256:' + 'b'.repeat(64) },
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'source_unresolvable' })
    // Wrong task fingerprint.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observed(), taskFingerprintId: brandedId('bad-fingerprint', 'taskFingerprintId'),
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'source_unresolvable' })
    // A foreign Admission that never belonged to this Usage.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observed(), executionEvidence: { ...evidence(planning), admissionAttemptId: brandedId('foreign', 'admissionAttemptId') },
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'source_unresolvable' })
    // Reason inconsistent with the terminal Admission (a denied plan can never be reason no_match).
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observed(), executionEvidence: { ...evidence(planning), reason: 'no_match' },
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
    // Forging a Settlement onto an unused sample.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...observed(), settlementId: brandedId('forged-settlement', 'settlementId'),
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('rejects a Usage that was later delivered, executed or settled even if an old admission looked not-used', async () => {
    const fixture = await createM5Fixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    await settleSuccess(fixture)
    const planning = fixture.planning
    // The cited admission (the original attempt) is the same Usage that later settled; the call must
    // observe the full Usage is not actually unused rather than accepting a stale attempted admission.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: {
        ...notUsedObservation(planning, 'refused', 'success'),
        usageId: planning.plan.usageId,
      },
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('rejects a still-pending Admission as not_used (unknown future state fails closed)', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planWithPendingRequest(fixture, 'case-pending')
    expect(planning.admissionAttempt.state).toBe('pending_external_decision')
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: notUsedObservation(planning, 'not_used', 'success'),
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('is idempotent under repeated commands and stays conflict-free across two connections', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenDeny(fixture, 'case-repeat')
    const input: RecordEvaluationObservationInput = {
      ...envelope(),
      observation: notUsedObservation(planning, 'refused', 'success'),
    }
    const first = await fixture.repository.recordEvaluationObservation(input, fixture.owner)
    const replay = await fixture.repository.recordEvaluationObservation(input, fixture.owner)
    expect(replay.receiptId).toBe(first.receiptId)

    // A concurrent connection submitting a distinct (case,arm) never collides with the first.
    const database2 = await reopen(fixture.directory)
    cleanup.push({ directory: fixture.directory, close: () => database2.close() })
    const repository2 = new ExperienceRepository(database2)
    const principal2 = await repository2.initializePrincipal()
    const owner2 = ownerActor(principal2)
    const second = await repository2.recordEvaluationObservation({
      ...envelope(),
      observation: { ...notUsedObservation(planning, 'refused', 'success'), taskCaseId: 'case-repeat-2' },
    }, owner2)
    expect(second.receiptId).not.toBe(first.receiptId)
  })

  it('fails without a half-written row when an observation is invalid mid-commit', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenDeny(fixture, 'case-halfwrite')
    const input: RecordEvaluationObservationInput = {
      ...envelope(),
      observation: { ...notUsedObservation(planning, 'refused', 'success'), settlementId: brandedId('s', 'settlementId') },
    }
    await expect(fixture.repository.recordEvaluationObservation(input, fixture.owner))
      .rejects.toMatchObject({ code: 'invalid_command' })
    const count = fixture.database.handle.prepare(
      'SELECT count(*) AS n FROM evaluation_observations WHERE cohort_id = ?',
    ).get('cohort-unused') as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('OPT-C evaluation observation parser and management CLI readback', () => {
  it('parses the not_used evidence discriminant and rejects malformed input', () => {
    const parsed = parseRecordEvaluationObservationInput({
      ...envelope(), observation: {
        ...baseObservation('experience_map'),
        taskCaseId: 'case-parse',
        taskFingerprintId: brandedId('fp', 'taskFingerprintId'),
        usageId: brandedId('u', 'usageId'),
        settlementId: null,
        retrievalResult: 'relevant',
        applicabilityDecision: 'use',
        decisionAnchorRefs: ['decision://case-parse'],
        executionEvidence: { kind: 'not_used', usagePlanId: brandedId('p', 'usagePlanId'),
          planDigest: 'sha256:' + 'a'.repeat(64), admissionAttemptId: brandedId('a', 'admissionAttemptId'),
          reason: 'refused', outcomeSource: 'external_verifier' },
      },
    })
    expect(parsed.observation.executionEvidence).toMatchObject({ kind: 'not_used', reason: 'refused' })

    expect(() => parseRecordEvaluationObservationInput({
      ...envelope(), observation: {
        ...baseObservation('experience_map'), executionEvidence: { kind: 'not_used', reason: 'refused' },
      },
    })).toThrow(expect.objectContaining({ code: 'required_field_missing' }))
    expect(() => parseRecordEvaluationObservationInput({
      ...envelope(), observation: {
        ...baseObservation('experience_map'),
        executionEvidence: { kind: 'settled', reason: 'not_used' },
      },
    })).toThrow(expect.objectContaining({ code: 'invalid_command' }))
  })

  it('routes the management CLI record command through the application service and back into the report', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenDeny(fixture, 'case-cli')
    const spec = {
      commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
      correlationId: 'cli-eval', causationId: null, issuedAt: new Date().toISOString(),
      observation: notUsedObservation(planning, 'refused', 'success'),
    }
    const parsed = parseRecordEvaluationObservationInput(spec)
    const resolver = new ActorResolver(fixture.principalId)
    const service = new ExperienceApplicationService(fixture.repository, resolver)
    const receipt = await service.recordEvaluationObservation(parsed, { kind: 'management-cli' })
    expect(receipt.action).toBe('evaluation.observe')
    const report = service.getEvaluationReport(parsed.observation.cohortId, { kind: 'management-cli' })
    expect(report.arms.find(item => item.comparisonArm === 'experience_map')!.sampleCount).toBe(1)
  })
})

describe('OPT-C evaluation observation real cli runner route and in-transaction rollback', () => {
  it('drives evaluation-record from exact JSON through the cli runner into SQLite and reads the report', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenDeny(fixture, 'case-runner')
    const inputPath = join(fixture.directory, 'observation.json')
    const commandId = brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId')
    await writeFile(inputPath, JSON.stringify({
      commandId, correlationId: 'runner-eval', causationId: null, issuedAt: new Date().toISOString(),
      observation: notUsedObservation(planning, 'refused', 'success'),
    }))
    const service = new ExperienceApplicationService(fixture.repository, new ActorResolver(fixture.principalId))
    const stdout: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true })
    cleanup.push({ directory: fixture.directory, close: async () => { spy.mockRestore() } })

    const ctx = new Context()
    ctx.provide('experiences', service as never)
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      readText: async (target: string) => (await import('node:fs/promises')).readFile(target, 'utf8'),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'evaluation-record', inputPath })
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    applyRunner(ctx)
    expect(await exited).toBe(0)
    spy.mockRestore()
    const printed = JSON.parse(stdout.join('')) as { ok: boolean; value: { action: string } }
    expect(printed.ok).toBe(true)
    expect(printed.value.action).toBe('evaluation.observe')
    const report = service.getEvaluationReport('cohort-unused', { kind: 'management-cli' })
    expect(report.arms.find(item => item.comparisonArm === 'experience_map')!.sampleCount).toBe(1)
  })

  it('rolls the observation, receipt and dedup back when the receipt commit fails, then a retry succeeds', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenDeny(fixture, 'case-fault')
    const input: RecordEvaluationObservationInput = {
      ...envelope(), observation: notUsedObservation(planning, 'refused', 'success'),
    }
    // Install a BEFORE INSERT trigger on domain_receipts that aborts the transaction AFTER the
    // observation row was inserted, simulating a mid-commit failure. Because the observation
    // INSERT and the receipt/audit/dedup writes run in the same BEGIN IMMEDIATE transaction, the
    // aborted receipt write rolls the whole transaction back.
    fixture.database.handle.exec(`
      CREATE TRIGGER _test_abort_evaluation_receipt BEFORE INSERT ON domain_receipts
      BEGIN SELECT RAISE(ABORT, 'injected receipt commit failure'); END;
    `)
    await expect(fixture.repository.recordEvaluationObservation(input, fixture.owner))
      .rejects.toThrow(/injected receipt commit failure/)
    // No half-written observation, receipt, or dedup row.
    const evidence = fixture.database.handle.prepare(
      `SELECT
        (SELECT count(*) FROM evaluation_observations WHERE cohort_id = ?) AS obs,
        (SELECT count(*) FROM domain_receipts WHERE command_id = ?) AS rcpt,
        (SELECT count(*) FROM command_deduplication WHERE command_id = ?) AS dedup`,
    ).get(input.observation.cohortId, String(input.commandId), String(input.commandId)) as {
      obs: number; rcpt: number; dedup: number
    }
    expect(evidence).toEqual({ obs: 0, rcpt: 0, dedup: 0 })

    // Remove the injected fault and retry the exact original command; it must commit.
    fixture.database.handle.exec('DROP TRIGGER _test_abort_evaluation_receipt')
    const receipt = await fixture.repository.recordEvaluationObservation(input, fixture.owner)
    expect(receipt.action).toBe('evaluation.observe')
    expect(fixture.repository.getEvaluationReport(input.observation.cohortId, fixture.owner)
      .arms.find(item => item.comparisonArm === 'experience_map')!.sampleCount).toBe(1)
  })

  it('replays an exact committed command as a receipt even after the Admission state changes, but enforces payload and current-state rules', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenContinueWithoutUse(fixture, 'case-replay')
    const input: RecordEvaluationObservationInput = {
      ...envelope(), observation: notUsedObservation(planning, 'not_used', 'unknown'),
    }
    const receipt = await fixture.repository.recordEvaluationObservation(input, fixture.owner)

    // The Admission moves to a state that would be invalid for a NEW not_used write, but an exact
    // replay of the already-committed command must return the stored receipt.
    await fixture.repository.recordPlanInteractionOutcome(String(planning.plan.usageId),
      'pending_external_decision', 'interaction_answerer_unavailable', 'interaction_answerer_unavailable', fixture.owner)
    const replay = await fixture.repository.recordEvaluationObservation(input, fixture.owner)
    expect(replay.receiptId).toBe(receipt.receiptId)

    // The same commandId with a different payload must conflict.
    await expect(fixture.repository.recordEvaluationObservation({
      ...input, observation: { ...input.observation, outcome: 'failure' },
    }, fixture.owner)).rejects.toMatchObject({ code: 'idempotency_conflict' })

    // A NEW commandId (not a replay) still re-checks current data and is rejected because the
    // Admission is no longer terminal-not-used; replay must not weaken new writes.
    await expect(fixture.repository.recordEvaluationObservation({
      ...envelope(), observation: notUsedObservation(planning, 'not_used', 'success'),
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('rolls a duplicate-key write from a second connection into idempotency_conflict with no half-write', async () => {
    const fixture = await emptyFixture()
    cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
    const { planning } = await planThenDeny(fixture, 'case-key')
    const db2 = await reopen(fixture.directory)
    cleanup.push({ directory: fixture.directory, close: () => db2.close() })
    const repository2 = new ExperienceRepository(db2)
    const principal2 = await repository2.initializePrincipal()
    const owner2 = ownerActor(principal2)
    const observation = notUsedObservation(planning, 'refused', 'unknown')
    const results = await Promise.allSettled([
      fixture.repository.recordEvaluationObservation({ ...envelope(), observation }, fixture.owner),
      repository2.recordEvaluationObservation({ ...envelope(), observation }, owner2),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const winner = results.find(result => result.status === 'fulfilled')!
    expect(results.find(result => result.status === 'rejected')!).toMatchObject({
      reason: { code: 'idempotency_conflict' },
    })
    expect(fixture.repository.getEvaluationReport('cohort-unused', fixture.owner)
      .arms.find(item => item.comparisonArm === 'experience_map')!.sampleCount).toBe(1)
    expect((winner as PromiseFulfilledResult<{ receiptId: string }>).value.receiptId).toBeTruthy()
  })
})

async function emptyFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m7-extra-'))
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 1_000, maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const owner = ownerActor(principalId)
  const runtimeActor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>('agent:m7-extra', 'actorId'), principalId,
    kind: 'agent', authority: 'query_only',
  }
  return { directory, database, repository, principalId, owner, runtimeActor }
}

function ownerActor(principalId: string): ActorView {
  return {
    actorId: brandedId<'ExperienceActorId'>(`management:${String(principalId)}`, 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>(principalId, 'principalId'),
    kind: 'management_local_owner', authority: 'owner',
  }
}

async function reopen(directory: string): Promise<ExperienceDatabase> {
  return ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 1_000, maxPendingWrites: 16,
  })
}

function baseObservation(comparisonArm: RecordEvaluationObservationInput['observation']['comparisonArm']):
RecordEvaluationObservationInput['observation'] {
  return {
    cohortId: 'cohort-unused', comparisonArm, taskCaseId: 'case-1', taskFamilyId: 'family-web-start',
    taskFingerprintId: null, usageId: null, settlementId: null, split: 'test',
    taskOccurredAt: '2026-09-03T01:00:00.000Z', trainingWindowEndsAt: '2026-09-02T23:59:59.000Z',
    trainingEpisodeRefs: ['training://episode-1'], modelVersion: 'deepseek-v4-flash',
    toolsetVersion: 'dsh-tools-v1', contextBudget: 32_768, verifierVersion: 'web-verifier-v1',
    taskCorpusVersion: 'm7-corpus-v1', outcome: 'success', acceptanceResultRefs: ['acceptance://case-1'],
    decisionAnchorRefs: [], routeSignature: 'build>launch>readback', elapsedMs: 1_000,
    modelRoundCount: 2, toolCallCount: 3, inputTokens: 100, outputTokens: 20, humanActionCount: 0,
    repeatedExplorationCount: 0, erroneousSideEffectCount: 0, erroneousReuse: false,
    retrievalResult: 'not_applicable', applicabilityDecision: 'not_applicable', pollutionIncident: false,
    explanationCoverage: 1, metricSourceRefs: ['metric://case-1'],
  }
}

function evidence(planning: {
  plan: { usagePlanId: string; contentDigest: string }
  admissionAttempt: { admissionAttemptId: string }
}): Extract<EvaluationExecutionEvidence, { kind: 'not_used' }> {
  return {
    kind: 'not_used',
    usagePlanId: brandedId<'ExperienceUsagePlanId'>(planning.plan.usagePlanId, 'usagePlanId'),
    planDigest: planning.plan.contentDigest,
    admissionAttemptId: brandedId<'ExperienceAdmissionAttemptId'>(
      planning.admissionAttempt.admissionAttemptId, 'admissionAttemptId'),
    reason: 'not_used',
    outcomeSource: 'external_verifier',
  }
}

function notUsedObservation(
  planning: { plan: { usageId: string; contentDigest: string; usagePlanId: string }
    fingerprint: { fingerprintId: string }
    admissionAttempt: { admissionAttemptId: string } },
  reason: 'no_match' | 'refused' | 'not_used',
  outcome: 'success' | 'failure' | 'unknown',
): RecordEvaluationObservationInput['observation'] {
  return {
    ...baseObservation('experience_map'),
    taskCaseId: `case-${reason}`,
    taskFingerprintId: brandedId<'ExperienceTaskFingerprintId'>(planning.fingerprint.fingerprintId, 'taskFingerprintId'),
    usageId: brandedId<'ExperienceUsageId'>(planning.plan.usageId, 'usageId'),
    settlementId: null,
    outcome,
    retrievalResult: reason === 'no_match' ? 'none' : 'relevant',
    applicabilityDecision: reason === 'no_match' ? 'refuse' : 'use',
    decisionAnchorRefs: [`decision://case-${reason}`],
    executionEvidence: { ...evidence(planning), reason },
  }
}

function publishMatchingWorkflow(fixture: Awaited<ReturnType<typeof emptyFixture>>, seed: number): Promise<unknown> {
  return publishReviewedWorkflow(fixture.repository, fixture.owner, seed, workflowDraft({
    title: `Verified DeepSeek Harness Web startup sample ${seed}`,
    intent: `Build and start the verified DeepSeek Harness Web application sample ${seed}.`,
  }))
}

function planningService(fixture: Awaited<ReturnType<typeof emptyFixture>>, interaction: PlanReviewInteraction): ExperiencePlanningService {
  return new ExperiencePlanningService(
    fixture.repository,
    { observe: async () => planningObservations() } as never,
    interaction,
    { retrievalCandidateLimit: 32, observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
    'deterministic',
  )
}

async function planTask(
  fixture: Awaited<ReturnType<typeof emptyFixture>>,
  commandId: string,
  task: PlanningTaskInput,
  interaction: 'defer' | 'ask_current_agent',
): Promise<Awaited<ReturnType<ExperiencePlanningService['plan']>>> {
  const service = planningService(fixture, {
    ask: async () => ({ kind: 'no_provider', reason: 'unused' }),
  } as never)
  return service.plan({
    commandId: brandedId<'ExperienceCommandId'>(commandId, 'commandId'),
    correlationId: commandId, causationId: null, issuedAt: new Date().toISOString(),
    sessionId: 'session-m7-extra', interaction, confirmExternalModelProcessing: false, task,
  }, fixture.owner)
}

const MATCHING_TASK: PlanningTaskInput = {
  text: 'Build and start the verified DeepSeek Harness Web application', workspaceRoot: null,
  targetExposure: 'local', mustUseExperience: true, riskClass: 'standard',
  requiredCapabilities: ['build', 'web'], requestedUseMode: 'guided', overrideDecisionIds: [],
}
const NO_MATCH_TASK: PlanningTaskInput = {
  text: 'translate a poem into Italian and annotate its meter', workspaceRoot: null,
  targetExposure: 'local', mustUseExperience: false, riskClass: 'standard',
  requiredCapabilities: [], requestedUseMode: 'guided', overrideDecisionIds: [],
}

async function planMatchesNothing(fixture: Awaited<ReturnType<typeof emptyFixture>>, commandId: string) {
  return planTask(fixture, commandId, NO_MATCH_TASK, 'defer')
}

async function planRejectedMatch(fixture: Awaited<ReturnType<typeof emptyFixture>>, commandId: string) {
  await publishMatchingWorkflow(fixture, 64)
  return planTask(fixture, commandId, {
    ...MATCHING_TASK,
    mustUseExperience: false,
    requiredCapabilities: ['kubernetes'],
  }, 'defer')
}

async function planThenDeny(fixture: Awaited<ReturnType<typeof emptyFixture>>, commandId: string) {
  await publishMatchingWorkflow(fixture, 61)
  const planned = await planTask(fixture, commandId, MATCHING_TASK, 'defer')
  const request = planned.planning.approvalRequest!
  await fixture.repository.decidePlan({
    commandId: brandedId<'ExperienceCommandId'>(`${commandId}-deny`, 'commandId'),
    requestId: request.requestId, usagePlanId: request.usagePlanId,
    expectedPlanRevision: request.planRevision, decision: 'deny', reason: 'Owner refused the exact plan',
    correlationId: commandId, causationId: planned.receipt.receiptId, issuedAt: new Date().toISOString(),
  }, fixture.owner)
  return { ...planned, planning: fixture.repository.getPlanningResult(String(planned.planning.plan.usageId), fixture.owner) }
}

async function planThenContinueWithoutUse(fixture: Awaited<ReturnType<typeof emptyFixture>>, commandId: string) {
  await publishMatchingWorkflow(fixture, 62)
  const planned = await planTask(fixture, commandId, { ...MATCHING_TASK, mustUseExperience: false },
    'ask_current_agent')
  return planned
}

async function planWithPendingRequest(fixture: Awaited<ReturnType<typeof emptyFixture>>, commandId: string) {
  await publishMatchingWorkflow(fixture, 63)
  return planTask(fixture, commandId, MATCHING_TASK, 'defer')
}

function planningObservations() {
  return ['repository_state', 'build_artifact', 'web_contract', 'process_socket', 'authenticated_http']
    .map((kind, index) => ({
      observationId: randomUUID(), kind,
      providerVersion: 'm7-extra-v1', status: 'observed' as const,
      summary: `${kind} observed`,
      values: kind === 'web_contract' ? { authRequired: true, loopbackOnly: true } : { present: true },
      sourceRefs: [`fixture://m7-extra/${String(index)}`],
      observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 300_000).toISOString(),
      reasonCode: null,
    }))
}

function envelope() {
  return {
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    correlationId: randomUUID(), causationId: null, issuedAt: new Date().toISOString(),
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
    boundedValue: { fixture: true }, sourceRef: `fixture://m7-extra/${criterionId}`, reasonCode: 'fixture_pass',
  }
  return { ...base, integrityDigest: digest(base) }
}
