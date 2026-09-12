import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createM5Fixture, envelope } from './fixtures/m5-usage.js'

const cleanup: Array<{ directory: string; close(): Promise<void> }> = []

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

describe('M5 StepProgress', () => {
  it('starts in the same Usage transaction and advances only from the exact checkpoint', async () => {
    const fixture = await started()
    expect(fixture.progress).toMatchObject({
      executionId: expect.any(String), guardPolicyDigest: expect.stringMatching(/^sha256:/u),
      controllerRevision: 1, state: 'ready', transition: 'start',
    })
    const audit = fixture.database.handle.prepare(
      "SELECT actor_id, action, object_refs_json, source_refs_json FROM audit_events WHERE action = 'usage.start'",
    ).get() as { actor_id: string; action: string; object_refs_json: string; source_refs_json: string }
    expect(audit.actor_id).toBe(fixture.runtimeActor.actorId)
    expect(JSON.parse(audit.object_refs_json)).toContain(fixture.progress.executionId)
    expect(JSON.parse(audit.source_refs_json)).toContain(fixture.progress.usagePlanId)
    const receipt = await fixture.repository.progressUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: 1, action: 'advance', checkpointRef: fixture.progress.stepRef,
      reason: 'approved step completed',
    }, fixture.owner)
    expect(receipt).toMatchObject({ action: 'usage.progress', usageId: fixture.progress.usageId, objectRevision: 2 })
    expect(fixture.repository.getReceipt(receipt.receiptId, fixture.owner)).toEqual(receipt)
    expect(fixture.repository.getUsageExecution(String(fixture.progress.usageId), fixture.owner).progress)
      .toMatchObject({ controllerRevision: 2, transition: 'advance' })
  })

  it('rejects stale revision, a missing checkpoint, and an unselected branch', async () => {
    const fixture = await started()
    await expect(fixture.repository.progressUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: 2, action: 'pause', reason: 'stale',
    }, fixture.owner)).rejects.toMatchObject({ code: 'stale_revision' })
    await expect(fixture.repository.progressUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: 1, action: 'advance', reason: 'missing checkpoint',
    }, fixture.owner)).rejects.toMatchObject({ code: 'required_field_missing' })
    await expect(fixture.repository.progressUsage({
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: 1, action: 'deviate', targetStepRef: fixture.progress.stepRef,
      branchRef: 'not-selected', checkpointRef: fixture.progress.stepRef, reason: 'bad branch',
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })

  it('deduplicates the same command and rejects a changed payload', async () => {
    const fixture = await started()
    const input = {
      ...envelope(), usageId: fixture.progress.usageId,
      expectedControllerRevision: 1, action: 'pause' as const, reason: 'inspect effect',
    }
    const first = await fixture.repository.progressUsage(input, fixture.owner)
    expect(await fixture.repository.progressUsage(input, fixture.owner)).toEqual(first)
    await expect(fixture.repository.progressUsage({ ...input, reason: 'changed' }, fixture.owner))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})

async function started() {
  const fixture = await createM5Fixture()
  cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
  return fixture
}
