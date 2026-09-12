import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type { AuditQueryInput } from '../src/types.js'
import { createM5Fixture } from './fixtures/m5-usage.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M7 exact-subject audit dossier', () => {
  it('reconstructs connected canonical records and paginates append-only events across restart', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(fixture.directory)
    const input: AuditQueryInput = {
      subject: { kind: 'usage', id: String(fixture.progress.usageId) },
      asOfRecordedAt: null,
      cursor: null,
      limit: 2,
    }
    const first = fixture.repository.getAuditDossier(input, fixture.owner)
    expect(first.objects.map(item => item.objectKind)).toEqual(expect.arrayContaining([
      'usage', 'usage_plan', 'approval_request', 'context_snapshot', 'context_delivery', 'step_progress', 'version',
    ]))
    expect(first.sources).toContainEqual(expect.objectContaining({
      availability: 'metadata_only', reasonCode: 'source_body_owned_by_external_system',
    }))
    expect(first.timeline).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = fixture.repository.getAuditDossier({ ...input, cursor: first.nextCursor }, fixture.owner)
    expect(new Set([...first.timeline, ...second.timeline].map(item => item.auditId)).size)
      .toBe(first.timeline.length + second.timeline.length)

    const expectedObjectIds = first.objects.map(item => item.objectId)
    await fixture.database.close()
    const reopened = await ExperienceDatabase.open({
      databasePath: join(fixture.directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
      busyTimeoutMs: 50, maxPendingWrites: 8,
    })
    const repository = new ExperienceRepository(reopened)
    const principal = await repository.initializePrincipal()
    const owner = new ActorResolver(principal).resolve({ kind: 'management-cli' })
    expect(repository.getAuditDossier({ ...input, limit: 100 }, owner).objects.map(item => item.objectId))
      .toEqual(expectedObjectIds)
    await reopened.close()
  })

  it('rejects cross-actor reads, invalid cursors, and unknown subjects', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(fixture.directory)
    const input: AuditQueryInput = {
      subject: { kind: 'usage', id: String(fixture.progress.usageId) },
      asOfRecordedAt: null, cursor: null, limit: 20,
    }
    expect(() => fixture.repository.getAuditDossier(input, fixture.runtimeActor))
      .toThrow(expect.objectContaining({ code: 'principal_unauthorized' }))
    expect(() => fixture.repository.getAuditDossier({ ...input, cursor: 'not-a-cursor' }, fixture.owner))
      .toThrow(expect.objectContaining({ code: 'invalid_command' }))
    expect(() => fixture.repository.getAuditDossier({
      ...input, subject: { kind: 'experience', id: 'missing-experience' },
    }, fixture.owner)).toThrow(expect.objectContaining({ code: 'not_found' }))
    await fixture.database.close()
  })

  it('binds cursors to one query and does not expose current mutable snapshots as historical state', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(fixture.directory)
    const input: AuditQueryInput = {
      subject: { kind: 'usage', id: String(fixture.progress.usageId) },
      asOfRecordedAt: '2099-09-03T00:00:00.000Z', cursor: null, limit: 1,
    }
    const dossier = fixture.repository.getAuditDossier(input, fixture.owner)
    expect(dossier.nextCursor).not.toBeNull()
    expect(dossier.objects.find(item => item.objectKind === 'usage')).toMatchObject({
      availability: 'metadata_only',
      reasonCode: 'historical_snapshot_not_recorded',
      payload: { objectId: String(fixture.progress.usageId), asOfRecordedAt: input.asOfRecordedAt },
    })
    expect(() => fixture.repository.getAuditDossier({
      subject: { kind: 'experience', id: String(fixture.baseVersion.experienceId) },
      asOfRecordedAt: input.asOfRecordedAt, cursor: dossier.nextCursor, limit: 1,
    }, fixture.owner)).toThrow(expect.objectContaining({ code: 'invalid_command' }))
    await fixture.database.close()
  })
})
