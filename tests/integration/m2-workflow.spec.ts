import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../../src/application/actor-resolver.js'
import { brandedId } from '../../src/ids.js'
import { assertExperienceStoreInvariants } from '../../src/invariant.js'
import { ExperienceDatabase, type DatabaseConfig } from '../../src/persistence/database.js'
import { ExperienceRepository } from '../../src/persistence/repository.js'
import type { ActorView, CandidateCommandInput } from '../../src/types.js'
import {
  prepareAcceptedWorkflow,
  publishReviewedWorkflow,
  workflowCommand,
} from '../fixtures/published-workflow.js'
import { eligibleExtraction, episodeRef, proposalMetadata, proposeInput, sourceRef, workflowDraft } from '../fixtures/workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M2 source-bound Candidate publication vertical', () => {
  it('persists proposal, field decisions, publication, audit, and restart readback', async () => {
    const path = await temporaryPath()
    const first = await open(path)
    const proposal = await first.repository.proposeCandidate(
      proposeInput(), workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, first.actor, 16_384,
    )
    expect(proposal).toMatchObject({ action: 'candidate.propose', candidateRevision: 1 })
    expect(first.repository.findCommandReceipt(
      proposeInput().commandId,
      first.payloadDigest,
      first.actor,
    )).toEqual(proposal)
    let candidate = first.repository.getCandidate(proposal.candidateId, first.actor)
    expect(candidate).toMatchObject({ state: 'proposed', candidateRevision: 1 })
    let receipt = await first.repository.submitCandidate(command(candidate, 2), first.actor)
    candidate = first.repository.getCandidate(receipt.candidateId, first.actor)
    for (const field of candidate.fields) {
      receipt = await first.repository.decideCandidateField({
        ...command(candidate, 100 + candidate.candidateRevision),
        field: field.field,
        decision: 'accept',
        reason: 'owner_checked_source',
      }, first.actor, 16_384)
      candidate = first.repository.getCandidate(receipt.candidateId, first.actor)
    }
    receipt = await first.repository.acceptCandidate(command(candidate, 900), first.actor, 16_384)
    candidate = first.repository.getCandidate(receipt.candidateId, first.actor)
    expect(candidate.state).toBe('accepted')
    const published = await first.repository.publishCandidate(command(candidate, 901), first.actor, 16_384)
    expect(published.action).toBe('candidate.publish')
    expect(published.experienceVersionId).not.toBeNull()
    const versionId = published.experienceVersionId!
    const version = first.repository.getVersion(versionId, first.actor)
    expect(version).toMatchObject({
      contentDigestSchema: 'v2-source-bound',
      sourceEpisodeRefs: [episodeRef],
      sourceRefs: [sourceRef],
      governanceState: 'accepted',
      operationalState: 'conditional',
    })
    expect(first.repository.getCandidate(published.candidateId, first.actor)).toMatchObject({
      state: 'published', publishedVersionId: versionId,
    })
    expect(first.database.handle.prepare(
      'SELECT COUNT(*) AS count FROM candidate_field_decisions WHERE candidate_id = ?',
    ).get(published.candidateId)).toEqual({ count: candidate.fields.length })
    expect(first.database.handle.prepare(
      'SELECT source_refs_json FROM audit_events WHERE command_id = ?',
    ).get(proposeInput().commandId)).toEqual({
      source_refs_json: JSON.stringify([episodeRef.episodeRefId, sourceRef.sourceRefId]),
    })
    assertExperienceStoreInvariants(first.database.handle)
    await first.database.close()

    const second = await open(path)
    expect(second.repository.getReceipt(published.receiptId, second.actor)).toEqual(published)
    expect(second.repository.getVersion(versionId, second.actor).contentDigest).toBe(version.contentDigest)
    expect(second.repository.getCandidate(published.candidateId, second.actor).state).toBe('published')
    await second.database.close()
  })

  it('projects an edited field as resolved after the owner reselects effective sources', async () => {
    const state = await open(await temporaryPath())
    const draft = workflowDraft({
      fieldSourceRefs: { ...workflowDraft().fieldSourceRefs, title: [] },
      unresolvedFields: ['title'],
    })
    const proposal = await state.repository.proposeCandidate(
      proposeInput('10000000-0000-4000-8000-000000000091'),
      draft,
      [episodeRef],
      [sourceRef],
      proposalMetadata,
      eligibleExtraction,
      state.actor,
      16_384,
    )
    let candidate = state.repository.getCandidate(proposal.candidateId, state.actor)
    await state.repository.submitCandidate(command(candidate, 91), state.actor)
    candidate = state.repository.getCandidate(proposal.candidateId, state.actor)
    for (const field of candidate.fields) {
      await state.repository.decideCandidateField({
        ...command(candidate, 92 + candidate.candidateRevision),
        field: field.field,
        ...(field.field === 'title'
          ? {
            decision: 'edit' as const,
            value: 'Source-backed title',
            effectiveSourceRefs: [sourceRef.sourceRefId],
            reason: 'the selected runtime source supports the corrected title',
          }
          : { decision: 'accept' as const, reason: 'checked against the bound source' }),
      }, state.actor, 16_384)
      candidate = state.repository.getCandidate(proposal.candidateId, state.actor)
    }
    expect(candidate).toMatchObject({
      title: 'Source-backed title',
      unresolvedFields: [],
      publicationReadiness: { ready: true, blockers: [] },
    })
    await state.database.close()
  })

  it('rejects unauthorized writes, stale revisions, idempotency drift, and rolls back failed publication', async () => {
    const state = await open(await temporaryPath())
    const restricted = new ActorResolver(state.actor.principalId).resolve({
      kind: 'restricted-runtime', runtimeKind: 'agent', runtimeId: 'agent-1',
    })
    await expect(state.repository.proposeCandidate(
      proposeInput(), workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, restricted, 16_384,
    )).rejects.toMatchObject({ code: 'principal_unauthorized' })
    const proposed = await state.repository.proposeCandidate(
      proposeInput(), workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, state.actor, 16_384,
    )
    await expect(state.repository.proposeCandidate(
      { ...proposeInput(), eligibilityDigest: 'sha256:different-eligibility' },
      workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const candidate = state.repository.getCandidate(proposed.candidateId, state.actor)
    await expect(state.repository.submitCandidate(
      { ...command(candidate, 3), expectedRevision: 2 }, state.actor,
    )).rejects.toMatchObject({ code: 'stale_revision' })
    const submitted = await state.repository.submitCandidate(command(candidate, 4), state.actor)
    let reviewing = state.repository.getCandidate(submitted.candidateId, state.actor)
    for (const field of reviewing.fields) {
      const decided = await state.repository.decideCandidateField({
        ...command(reviewing, 200 + reviewing.candidateRevision),
        field: field.field,
        decision: 'accept',
        reason: 'checked',
      }, state.actor, 16_384)
      reviewing = state.repository.getCandidate(decided.candidateId, state.actor)
    }
    const accepted = await state.repository.acceptCandidate(command(reviewing, 990), state.actor, 16_384)
    const ready = state.repository.getCandidate(accepted.candidateId, state.actor)
    state.database.handle.exec(`
      CREATE TRIGGER fail_m2_outbox BEFORE INSERT ON outbox_entries
      BEGIN SELECT RAISE(ABORT, 'forced m2 outbox failure'); END
    `)
    await expect(state.repository.publishCandidate(command(ready, 991), state.actor, 16_384))
      .rejects.toThrow(/forced m2 outbox failure/)
    expect(state.repository.getCandidate(ready.candidateId, state.actor)).toMatchObject({
      state: 'accepted', candidateRevision: ready.candidateRevision,
    })
    expect(state.repository.getStatus(state.actor).versionCount).toBe(0)
    await state.database.close()
  })

  it('persists rejection and withdrawal as terminal Candidate outcomes without a Version', async () => {
    const state = await open(await temporaryPath())
    const withdrawnProposal = await state.repository.proposeCandidate(
      proposeInput('10000000-0000-4000-8000-000000000011'),
      workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, state.actor, 16_384,
    )
    const withdrawnCandidate = state.repository.getCandidate(withdrawnProposal.candidateId, state.actor)
    const withdrawn = await state.repository.withdrawCandidate({
      ...command(withdrawnCandidate, 1_100), reasonCode: 'user_withdrawn',
    }, state.actor)
    expect(state.repository.getCandidate(withdrawn.candidateId, state.actor)).toMatchObject({
      state: 'withdrawn', dispositionReason: 'user_withdrawn', publishedVersionId: null,
    })

    const rejectedProposal = await state.repository.proposeCandidate(
      proposeInput('10000000-0000-4000-8000-000000000012'),
      workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, state.actor, 16_384,
    )
    const proposed = state.repository.getCandidate(rejectedProposal.candidateId, state.actor)
    const submitted = await state.repository.submitCandidate(command(proposed, 1_101), state.actor)
    const reviewing = state.repository.getCandidate(submitted.candidateId, state.actor)
    const rejected = await state.repository.rejectCandidate({
      ...command(reviewing, 1_102), reasonCode: 'non_actionable_abstraction',
    }, state.actor)
    expect(state.repository.getCandidate(rejected.candidateId, state.actor)).toMatchObject({
      state: 'rejected', dispositionReason: 'non_actionable_abstraction', publishedVersionId: null,
    })
    expect(state.repository.getStatus(state.actor).versionCount).toBe(0)
    await state.database.close()
  })

  it('rejects a corrupted nested Candidate payload at the durable read boundary', async () => {
    const state = await open(await temporaryPath())
    const proposed = await state.repository.proposeCandidate(
      proposeInput(), workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, state.actor, 16_384,
    )
    const row = state.database.handle.prepare(
      'SELECT payload_json FROM candidates WHERE candidate_id = ?',
    ).get(proposed.candidateId) as { payload_json: string }
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    payload.proposal = { generator: 'model' }
    state.database.handle.prepare(
      'UPDATE candidates SET payload_json = ? WHERE candidate_id = ?',
    ).run(JSON.stringify(payload), proposed.candidateId)
    expect(() => state.repository.getCandidate(proposed.candidateId, state.actor))
      .toThrow(expect.objectContaining({ code: 'database_schema_invalid' }))
    await state.database.close()
  })

  it('deduplicates concurrent publication retries and rejects command payload drift', async () => {
    const state = await open(await temporaryPath())
    const prepared = await prepareAcceptedWorkflow(state.repository, state.actor, 21)
    const publish = workflowCommand(prepared.candidate, 5, 21)
    const [left, right] = await Promise.all([
      state.repository.publishCandidate(publish, state.actor, 16_384),
      state.repository.publishCandidate(publish, state.actor, 16_384),
    ])
    expect(right).toEqual(left)
    await expect(state.repository.publishCandidate(
      { ...publish, expectedRevision: publish.expectedRevision + 1 },
      state.actor,
      16_384,
    )).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(state.repository.getStatus(state.actor)).toMatchObject({ candidateCount: 1, versionCount: 1 })
    await state.database.close()
  })

  it.each(['domain_receipts', 'audit_events', 'outbox_entries'])(
    'rolls back the complete Candidate publication when %s rejects its insert',
    async (failureTable) => {
      const state = await open(await temporaryPath())
      const prepared = await prepareAcceptedWorkflow(state.repository, state.actor, 22)
      const trackedTables = [
        'candidates', 'experience_series', 'experience_versions', 'domain_receipts',
        'audit_events', 'outbox_entries', 'command_deduplication',
      ]
      const before = Object.fromEntries(trackedTables.map(table => [table, rowCount(state.database, table)]))
      const sequence = state.database.handle.prepare(
        'SELECT next_value FROM commit_sequence WHERE singleton = 1',
      ).get()
      state.database.handle.exec(`
        CREATE TRIGGER forced_publication_failure BEFORE INSERT ON ${failureTable}
        BEGIN SELECT RAISE(ABORT, 'forced transaction failure'); END
      `)
      await expect(state.repository.publishCandidate(
        workflowCommand(prepared.candidate, 5, 22),
        state.actor,
        16_384,
      )).rejects.toThrow(/forced transaction failure/u)
      expect(Object.fromEntries(trackedTables.map(table => [table, rowCount(state.database, table)]))).toEqual(before)
      expect(state.database.handle.prepare(
        'SELECT next_value FROM commit_sequence WHERE singleton = 1',
      ).get()).toEqual(sequence)
      expect(state.repository.getCandidate(prepared.candidate.candidateId, state.actor)).toMatchObject({
        state: 'accepted', candidateRevision: prepared.candidate.candidateRevision,
      })
      await state.database.close()
    },
  )

  it('applies actor and privacy policy to the Candidate workflow publication', async () => {
    const state = await open(await temporaryPath())
    const runtime = new ActorResolver(state.actor.principalId).resolve({
      kind: 'restricted-runtime', runtimeKind: 'agent', runtimeId: 'agent-1',
    })
    await expect(state.repository.proposeCandidate(
      proposeInput('10000000-0000-4000-8000-000000000023'),
      workflowDraft(), [episodeRef], [sourceRef], proposalMetadata, eligibleExtraction, runtime, 16_384,
    )).rejects.toMatchObject({ code: 'principal_unauthorized' })
    const restricted = await publishReviewedWorkflow(
      state.repository,
      state.actor,
      23,
      workflowDraft({ privacyClass: 'restricted' }),
    )
    expect(() => state.repository.getVersion(restricted.published.experienceVersionId!, runtime))
      .toThrow(/cannot read/u)
    const publicVersion = await publishReviewedWorkflow(
      state.repository,
      state.actor,
      24,
      workflowDraft({
        privacyClass: 'public',
        scope: { ...workflowDraft().scope, visibility: 'public-fixture' },
      }),
    )
    expect(state.repository.getVersion(publicVersion.published.experienceVersionId!, runtime).privacyClass)
      .toBe('public')
    await state.database.close()
  })

  it.each([
    {
      name: 'structurally invalid durable JSON',
      mutate: (state: Awaited<ReturnType<typeof open>>, versionId: string) => {
        state.database.handle.prepare(
          'UPDATE experience_versions SET payload_json = ? WHERE experience_version_id = ?',
        ).run('{}', versionId)
      },
      message: /durable JSON is invalid/u,
    },
    {
      name: 'normalized component divergence',
      mutate: (state: Awaited<ReturnType<typeof open>>, versionId: string) => {
        state.database.handle.prepare(`
          UPDATE component_revisions SET content_text = 'divergent content'
           WHERE component_revision_id = (
             SELECT component_revision_id FROM experience_version_components
              WHERE experience_version_id = ? ORDER BY ordinal LIMIT 1
           )
        `).run(versionId)
      },
      message: /diverges from canonical records/u,
    },
    {
      name: 'content without a matching digest',
      mutate: (state: Awaited<ReturnType<typeof open>>, versionId: string) => {
        state.database.handle.prepare(`
          UPDATE experience_versions
             SET payload_json = json_set(payload_json, '$.validity.node', 'changed')
           WHERE experience_version_id = ?
        `).run(versionId)
      },
      message: /content digest is inconsistent/u,
    },
  ])('fails closed on $name', async ({ mutate, message }) => {
    const state = await open(await temporaryPath())
    const result = await publishReviewedWorkflow(state.repository, state.actor, 25)
    const versionId = result.published.experienceVersionId!
    mutate(state, versionId)
    expect(() => state.repository.getVersion(versionId, state.actor)).toThrow(message)
    await state.database.close()
  })
})

function rowCount(database: ExperienceDatabase, table: string): number {
  return (database.handle.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

async function open(path: string): Promise<{
  database: ExperienceDatabase
  repository: ExperienceRepository
  actor: ActorView
  payloadDigest: string
}> {
  const database = await ExperienceDatabase.open(config(path))
  const repository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  const actor = new ActorResolver(principal).resolve({ kind: 'management-cli' })
  const { workflowPayloadDigest } = await import('../../src/persistence/repository.js')
  return {
    database,
    repository,
    actor,
    payloadDigest: workflowPayloadDigest('candidate.propose', actor, proposeInput()),
  }
}

function command(
  candidate: { readonly candidateId: CandidateCommandInput['candidateId']; readonly candidateRevision: number },
  sequence: number,
): CandidateCommandInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(
      `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      'commandId',
    ),
    candidateId: candidate.candidateId,
    expectedRevision: candidate.candidateRevision,
    correlationId: 'm2-workflow',
    causationId: null,
    issuedAt: '2026-08-31T09:10:00.000Z',
  }
}

function config(path: string): DatabaseConfig {
  return { databasePath: path, journalMode: 'wal', synchronous: 'normal', busyTimeoutMs: 50, maxPendingWrites: 8 }
}

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m2-'))
  cleanup.push(directory)
  return join(directory, 'experience.sqlite')
}
