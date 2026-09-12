import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { createExperienceContextMessage } from '../src/adapters/context-message.js'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { ContextRetirementCoordinator } from '../src/application/context-retirement.js'
import { ExperienceForgetService } from '../src/application/forget-service.js'
import { ExperienceLearningProjector } from '../src/application/learning-projector.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type { ForgetExperienceInput } from '../src/types.js'
import { renderContext } from '../src/domain/context.js'
import { createM5Fixture } from './fixtures/m5-usage.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M7 Forget capability vertical', () => {
  it('stops recall atomically, removes learning projections, preserves history, and survives restart', async () => {
    const fixture = await forgetFixture()
    const versionId = fixture.published.published.experienceVersionId!
    const experienceId = fixture.published.published.experienceId!
    const candidateId = fixture.published.candidate.candidateId
    await fixture.repository.ensureLearningProjectionBuilder()
    expect((await fixture.learning.drain()).rows.some(row => row.inputRefs.some(ref => ref.id === candidateId))).toBe(true)

    const preview = fixture.service.preview(experienceId, { kind: 'management-cli' })
    expect(preview).toMatchObject({
      experienceId,
      currentVersionId: versionId,
      futureRecall: 'will_stop_immediately',
      immutableHistory: ['versions', 'receipts', 'audit', 'session_events', 'provider_copies'],
      vaultContent: 'not_applicable',
      activeContextTargets: [],
    })
    const input = forgetInput(preview)
    const receipt = await fixture.service.forget(input, { kind: 'management-cli' })
    expect(fixture.repository.listPlanningVersions(fixture.owner, 32)).toEqual([])
    expect(fixture.repository.getReceipt(receipt.receiptId, fixture.owner)).toEqual(receipt)
    expect(fixture.repository.getVersion(versionId, fixture.owner).experienceVersionId).toBe(versionId)
    expect(fixture.repository.getLearningProjection(fixture.owner).rows
      .some(row => row.inputRefs.some(ref => ref.id === candidateId))).toBe(false)
    expect(fixture.service.get(String(receipt.forgetRequestId), { kind: 'management-cli' })).toMatchObject({
      state: 'completed',
      experienceId,
      contextTargets: [],
      steps: [
        { phase: 'recall_stop', status: 'completed' },
        { phase: 'context_retirement', status: 'not_applicable' },
        { phase: 'vault_content', status: 'not_applicable' },
        { phase: 'projection_invalidation', status: 'completed' },
        { phase: 'tombstone', status: 'completed' },
      ],
    })
    expect(await fixture.service.forget(input, { kind: 'management-cli' })).toEqual(receipt)

    await fixture.database.close()
    const reopened = await ExperienceDatabase.open(databaseConfig(fixture.path))
    try {
      const repository = new ExperienceRepository(reopened)
      expect(repository.listPlanningVersions(fixture.owner, 32)).toEqual([])
      expect(repository.getVersion(versionId, fixture.owner).experienceVersionId).toBe(versionId)
      expect(repository.getForgetRequest(String(receipt.forgetRequestId), fixture.owner).state).toBe('completed')
    } finally {
      await reopened.close()
    }
  })

  it('rejects an unconfirmed impact digest and query-only runtime authority', async () => {
    const fixture = await forgetFixture()
    try {
      const experienceId = fixture.published.published.experienceId!
      const preview = fixture.service.preview(experienceId, { kind: 'authenticated-browser' })
      await expect(fixture.service.forget({
        ...forgetInput(preview),
        previewDigest: `sha256:${'0'.repeat(64)}`,
      }, { kind: 'authenticated-browser' })).rejects.toMatchObject({ code: 'stale_revision' })
      expect(fixture.repository.listPlanningVersions(fixture.owner, 32)).toHaveLength(1)
      expect(() => fixture.service.preview(experienceId, {
        kind: 'restricted-runtime', runtimeKind: 'agent', runtimeId: 'runtime-1',
      })).toThrow(expect.objectContaining({ code: 'principal_unauthorized' }))
    } finally {
      await fixture.database.close()
    }
  })

  it('replaces a live Session Context before reporting Context retirement complete', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(fixture.directory)
    const context = fixture.repository.getContextUsage(String(fixture.planning.plan.usageId), fixture.owner)
    if (context.snapshot === null || context.delivery === null) throw new Error('expected prepared Context')
    const session = Session.create(context.delivery.sessionId as never)
    const message = createExperienceContextMessage(
      renderContext(context.snapshot.sections),
      context.snapshot,
      String(context.delivery.contextDeliveryId),
    )
    const appended = session.append('user/message', { ...message, id: context.delivery.messageId as never }, {
      surfaceOp: 'append',
    })
    await fixture.repository.recordContextAppended({
      contextDeliveryId: context.delivery.contextDeliveryId,
      sessionId: context.delivery.sessionId,
      messageId: context.delivery.messageId,
      contentDigest: context.delivery.contentDigest,
      sessionEventSeq: appended.seq,
      appendedAt: new Date().toISOString(),
    })
    const ctx = new Context()
    ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
    ctx.provide('sessionQuery', { traceEvent: async () => ({ replacementChain: [] }) } as never)
    const actors = new ActorResolver(fixture.owner.principalId)
    const learning = new ExperienceLearningProjector(ctx, fixture.repository, {
      learningPollIntervalMs: 60_000,
      learningClaimLeaseMs: 30_000,
      learningRetryDelayMs: 1_000,
      learningBatchSize: 32,
    })
    const service = new ExperienceForgetService(
      ctx,
      fixture.repository,
      actors,
      new ContextRetirementCoordinator(ctx, fixture.repository),
      learning,
    )
    const preview = service.preview(fixture.baseVersion.experienceId, { kind: 'authenticated-browser' })
    expect(preview.activeContextTargets).toEqual([expect.objectContaining({
      contextDeliveryId: context.delivery.contextDeliveryId,
      sessionId: session.id,
    })])

    const receipt = await service.forget(forgetInput(preview), { kind: 'authenticated-browser' })

    const result = service.get(String(receipt.forgetRequestId), { kind: 'authenticated-browser' })
    expect(result).toMatchObject({
      state: 'completed',
      contextTargets: [{ status: 'retired', reasonCode: 'session_surface_replaced' }],
    })
    expect(result.steps.find(step => step.phase === 'context_retirement'))
      .toMatchObject({ status: 'completed', reasonCode: 'all_active_contexts_retired' })
    expect(session.surface.nodes).not.toContain(appended.seq)
    expect(session.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'user/message',
      sourceEventSeqs: [appended.seq],
      data: expect.objectContaining({ source: expect.objectContaining({ kind: 'experience', lifecycle: 'inactive' }) }),
    }))
    await fixture.database.close()
  })

  it('reports an offline Session Context as partial without restoring future recall', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(fixture.directory)
    const context = fixture.repository.getContextUsage(String(fixture.planning.plan.usageId), fixture.owner)
    if (context.snapshot === null || context.delivery === null) throw new Error('expected prepared Context')
    const session = Session.create(context.delivery.sessionId as never)
    const message = createExperienceContextMessage(
      renderContext(context.snapshot.sections),
      context.snapshot,
      String(context.delivery.contextDeliveryId),
    )
    const appended = session.append('user/message', { ...message, id: context.delivery.messageId as never }, {
      surfaceOp: 'append',
    })
    await fixture.repository.recordContextAppended({
      contextDeliveryId: context.delivery.contextDeliveryId,
      sessionId: context.delivery.sessionId,
      messageId: context.delivery.messageId,
      contentDigest: context.delivery.contentDigest,
      sessionEventSeq: appended.seq,
      appendedAt: new Date().toISOString(),
    })
    const ctx = new Context()
    let liveSession: Session | undefined
    ctx.provide('sessions', { get: (id: string) => id === liveSession?.id ? liveSession : undefined } as never)
    ctx.provide('sessionQuery', { traceEvent: async () => ({ replacementChain: [] }) } as never)
    const actors = new ActorResolver(fixture.owner.principalId)
    const learning = new ExperienceLearningProjector(ctx, fixture.repository, {
      learningPollIntervalMs: 60_000,
      learningClaimLeaseMs: 30_000,
      learningRetryDelayMs: 1_000,
      learningBatchSize: 32,
    })
    const service = new ExperienceForgetService(
      ctx,
      fixture.repository,
      actors,
      new ContextRetirementCoordinator(ctx, fixture.repository),
      learning,
    )
    const preview = service.preview(fixture.baseVersion.experienceId, { kind: 'management-cli' })

    const input = forgetInput(preview)
    const receipt = await service.forget(input, { kind: 'management-cli' })
    const result = service.get(String(receipt.forgetRequestId), { kind: 'management-cli' })

    expect(fixture.repository.listPlanningVersions(fixture.owner, 32)).toEqual([])
    expect(result).toMatchObject({
      state: 'partial',
      contextTargets: [{ status: 'unknown', reasonCode: 'session_not_live_retirement_deferred' }],
    })
    expect(result.steps.find(step => step.phase === 'context_retirement'))
      .toMatchObject({ status: 'unknown', reasonCode: 'session_not_live_retirement_deferred' })

    liveSession = session
    expect(await service.forget(input, { kind: 'management-cli' })).toEqual(receipt)
    const recovered = service.get(String(receipt.forgetRequestId), { kind: 'management-cli' })
    expect(recovered).toMatchObject({
      state: 'completed',
      contextTargets: [{ status: 'retired', reasonCode: 'session_surface_replaced' }],
    })
    expect(session.surface.nodes).not.toContain(appended.seq)
    await fixture.database.close()
  })
})

async function forgetFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-forget-'))
  cleanup.push(directory)
  const path = join(directory, 'experience.db')
  const database = await ExperienceDatabase.open(databaseConfig(path))
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const actors = new ActorResolver(principalId)
  const owner = actors.resolve({ kind: 'management-cli' })
  const published = await publishReviewedWorkflow(repository, owner)
  const ctx = new Context()
  const learning = new ExperienceLearningProjector(ctx, repository, {
    learningPollIntervalMs: 60_000,
    learningClaimLeaseMs: 30_000,
    learningRetryDelayMs: 1_000,
    learningBatchSize: 32,
  })
  const service = new ExperienceForgetService(
    ctx,
    repository,
    actors,
    new ContextRetirementCoordinator(ctx, repository),
    learning,
  )
  return { path, database, repository, owner, published, learning, service }
}

function forgetInput(preview: ReturnType<ExperienceForgetService['preview']>): ForgetExperienceInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    experienceId: preview.experienceId,
    expectedSeriesRevision: preview.expectedSeriesRevision,
    previewDigest: preview.previewDigest,
    reason: 'The owner confirmed that this Experience must no longer be recalled',
    correlationId: randomUUID(),
    causationId: null,
    issuedAt: new Date().toISOString(),
  }
}

function databaseConfig(path: string) {
  return {
    databasePath: path,
    journalMode: 'wal' as const,
    synchronous: 'normal' as const,
    busyTimeoutMs: 5_000,
    maxPendingWrites: 128,
  }
}
