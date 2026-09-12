import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { digest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import type { CriterionVerificationView, VerificationRunView } from '../src/types.js'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { createM5Fixture, envelope } from './fixtures/m5-usage.js'

const cleanup: Array<{ directory: string; close(): Promise<void> }> = []

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

describe('M5 criterion-backed Settlement', () => {
  it('settles success only after the Plan completed and all five mandatory criteria passed', async () => {
    const fixture = await started()
    const completed = await completePlan(fixture)
    const verification = verificationRun(String(fixture.progress.usageId), completed.controllerRevision)
    await fixture.repository.recordVerification({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
    }, verification, fixture.owner)
    const input = {
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
      verificationRunId: verification.verificationRunId,
    }
    const receipt = await fixture.repository.settleUsage(input, fixture.owner)
    expect(receipt).toMatchObject({ action: 'usage.settle', usageId: fixture.progress.usageId })
    expect(fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).settlement)
      .toMatchObject({ outcome: 'success', criteria: expect.arrayContaining([
        expect.objectContaining({ criterionId: 'WEB-CLEAN-005', result: 'pass' }),
      ]) })
    expect(fixture.database.handle.prepare(
      "SELECT topic FROM outbox_entries WHERE topic = 'experience.usage.settled'",
    ).get()).toEqual({ topic: 'experience.usage.settled' })
    expect(await fixture.repository.settleUsage(input, fixture.owner)).toEqual(receipt)
  })

  it('does not call four passing criteria success and does not silently reuse another command', async () => {
    const fixture = await started()
    const completed = await completePlan(fixture)
    const verification = verificationRun(String(fixture.progress.usageId), completed.controllerRevision, 'WEB-AUTH-003')
    await fixture.repository.recordVerification({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
    }, verification, fixture.owner)
    await fixture.repository.settleUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
      verificationRunId: verification.verificationRunId,
    }, fixture.owner)
    expect(fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).settlement?.outcome)
      .toBe('failure')
    await expect(fixture.repository.settleUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
      verificationRunId: verification.verificationRunId,
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('does not settle success before StepProgress reaches completed', async () => {
    const fixture = await started()
    const verification = verificationRun(String(fixture.progress.usageId), fixture.progress.controllerRevision)
    await fixture.repository.recordVerification({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: fixture.progress.controllerRevision,
    }, verification, fixture.owner)
    await fixture.repository.settleUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: fixture.progress.controllerRevision,
      verificationRunId: verification.verificationRunId,
    }, fixture.owner)
    expect(fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).settlement?.outcome)
      .toBe('partial')
  })

  it('rejects an older VerificationRun even when its controller revision still matches', async () => {
    const fixture = await started()
    const completed = await completePlan(fixture)
    const older = verificationRun(String(fixture.progress.usageId), completed.controllerRevision)
    const latest = verificationRun(String(fixture.progress.usageId), completed.controllerRevision, 'WEB-AUTH-003')
    await fixture.repository.recordVerification({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
    }, older, fixture.owner)
    await fixture.repository.recordVerification({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
    }, latest, fixture.owner)

    await expect(fixture.repository.settleUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: completed.controllerRevision,
      verificationRunId: older.verificationRunId,
    }, fixture.owner)).rejects.toMatchObject({ code: 'stale_revision' })
  })
})

async function started() {
  const fixture = await createM5Fixture()
  cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
  return fixture
}

async function completePlan(fixture: Awaited<ReturnType<typeof createM5Fixture>>) {
  let progress = fixture.progress
  while (progress.state !== 'completed') {
    await fixture.repository.progressUsage({
      ...envelope(), usageId: progress.usageId,
      expectedControllerRevision: progress.controllerRevision,
      action: 'advance', checkpointRef: progress.stepRef, reason: 'criterion-backed step completed',
    }, fixture.owner)
    progress = fixture.repository.getUsageExecution(String(progress.usageId), fixture.owner).progress!
  }
  return progress
}

function verificationRun(usageId: string, controllerRevision: number, failed?: CriterionVerificationView['criterionId']): VerificationRunView {
  const criteria = WEB_USAGE_CRITERIA.map(criterionId => criterion(criterionId, criterionId === failed ? 'fail' : 'pass'))
  return {
    verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
    usageId: brandedId<'ExperienceUsageId'>(usageId, 'usageId'),
    controllerRevision,
    providerVersion: 'dsh-web-guided-v1',
    criteria,
    phase: failed === undefined ? 'complete' : 'pre_cleanup',
    createdAt: new Date().toISOString(),
  }
}

function criterion(
  criterionId: CriterionVerificationView['criterionId'],
  result: CriterionVerificationView['result'],
): CriterionVerificationView {
  const base = {
    criterionId, mandatory: true as const, result, observedAt: new Date().toISOString(),
    boundedValue: { fixture: true }, sourceRef: `fixture://m5/${criterionId}`,
    reasonCode: result === 'pass' ? 'fixture_pass' : 'fixture_fail',
  }
  return { ...base, integrityDigest: digest(base) }
}
