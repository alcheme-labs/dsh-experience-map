import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { createExperienceContextMessage } from '../src/adapters/context-message.js'
import { PlanningObservationRegistry } from '../src/adapters/observations.js'
import { ExperiencePlanningService } from '../src/application/planning-service.js'
import {
  contextSections,
  materializeContextSnapshot,
  observationFactDigests,
  renderContext,
} from '../src/domain/context.js'
import { admissionTaskDigest, digest, usageScopeDigest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type {
  ActorView,
  ContextDeliveryView,
  PlanTaskCommandInput,
  PlanningObservationView,
} from '../src/types.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M4 admission binding and Context delivery', () => {
  it('compares current facts as a set when multiple Preflights cite the same observations', async () => {
    const fixture = await approvedFixture()
    try {
      const current = await fixture.observations.observe(fixture.task)
      expect(observationFactDigests([...current, ...current]))
        .toEqual(observationFactDigests(current))
      const changed = current.map((item, index) => index === 0
        ? { ...item, summary: `${item.summary} changed` }
        : item)
      expect(observationFactDigests([...current, ...current]))
        .not.toEqual(observationFactDigests(changed))
    } finally {
      await fixture.database.close()
    }
  })

  it('claims, rechecks, consumes, and reads back one exact prepared delivery', async () => {
    const fixture = await approvedFixture()
    try {
      const claimed = await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-m4',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      })
      expect(claimed).not.toBeNull()
      expect(claimed!.binding).toMatchObject({ state: 'claimed', claimRevision: 1 })
      const prepared = prepareContext(claimed!.planning, 'session-m4')
      const current = await fixture.observations.observe(fixture.task)
      const context = await fixture.repository.consumeClaimAndPrepareContext({
        claimed: claimed!,
        currentObservations: current,
        snapshot: prepared.snapshot,
        delivery: prepared.delivery,
      })
      expect(context).toMatchObject({
        planning: { retryBinding: { state: 'consumed' } },
        delivery: { deliveryStatus: 'prepared', sessionEventSeq: null },
      })
      await fixture.repository.recordContextAppended({
        contextDeliveryId: prepared.delivery.contextDeliveryId,
        sessionId: 'session-m4',
        messageId: prepared.delivery.messageId,
        contentDigest: prepared.delivery.contentDigest,
        sessionEventSeq: 7,
        appendedAt: '2026-09-02T10:00:00.000Z',
      })
      const firstIncluded = await fixture.repository.recordContextIncluded({
        contextDeliveryId: prepared.delivery.contextDeliveryId,
        requestBoundaryRef: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        deliveredAt: '2026-09-02T10:00:01.000Z',
      })
      const laterToolLoopStep = await fixture.repository.recordContextIncluded({
        contextDeliveryId: prepared.delivery.contextDeliveryId,
        requestBoundaryRef: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        deliveredAt: '2026-09-02T10:00:02.000Z',
      })
      expect(laterToolLoopStep).toEqual(firstIncluded)
      expect(laterToolLoopStep.requestBoundaryRef)
        .toBe('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      expect(fixture.repository.getContextUsage(String(context.planning.plan.usageId), fixture.owner))
        .toMatchObject({
          admissionAttempts: [
            { state: 'approved' },
            { state: 'entered', reasonCode: 'context_prepared_for_agent_loop' },
          ],
          snapshot: {
            deliveryMessageId: prepared.delivery.messageId,
            instructionScope: 'current_usage',
            assemblerVersion: 'experience-context-v1',
          },
          delivery: {
            deliveryStatus: 'included_in_request',
            sessionEventSeq: 7,
          },
        })
      expect(await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-m4',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      })).toBeNull()
    } finally {
      await fixture.database.close()
    }
  })

  it('allows only one concurrent claim and does not match different exact input', async () => {
    const fixture = await approvedFixture()
    try {
      expect(await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest('same words with a changed exact task'),
        sessionId: 'session-m4',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      })).toBeNull()
      expect(await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-m4',
        scopeDigest: usageScopeDigest({ ...fixture.task, targetExposure: 'public' }),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      })).toBeNull()
      const claims = await Promise.all([
        fixture.repository.claimAdmissionRetryBinding({
          taskInputDigest: admissionTaskDigest(fixture.task.text),
          sessionId: 'session-m4',
          scopeDigest: usageScopeDigest(fixture.task),
          workspaceRoot: fixture.task.workspaceRoot,
          runtimeActor: fixture.runtimeActor,
          leaseMs: 30_000,
        }),
        fixture.repository.claimAdmissionRetryBinding({
          taskInputDigest: admissionTaskDigest(fixture.task.text),
          sessionId: 'session-m4',
          scopeDigest: usageScopeDigest(fixture.task),
          workspaceRoot: fixture.task.workspaceRoot,
          runtimeActor: fixture.runtimeActor,
          leaseMs: 30_000,
        }),
      ])
      expect(claims.filter(Boolean)).toHaveLength(1)
    } finally {
      await fixture.database.close()
    }
  })

  it('binds Browser approval to its Session without reconstructing unobservable plan choices', async () => {
    const fixture = await approvedFixture('session-m4-bound')
    try {
      expect(await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'different-session',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      })).toBeNull()
      const claimed = await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-m4-bound',
        scopeDigest: usageScopeDigest({ ...fixture.task, targetExposure: 'public', riskClass: 'high' }),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      })
      expect(claimed?.binding).toMatchObject({
        sessionId: 'session-m4-bound',
        scopeDigest: usageScopeDigest(fixture.task),
        state: 'claimed',
      })
    } finally {
      await fixture.database.close()
    }
  })

  it('rejects a second approval for the same active actor, scope, and task input', async () => {
    const fixture = await approvedFixture()
    try {
      const second = await fixture.planning.plan({
        commandId: brandedId<'ExperienceCommandId'>('m4-plan-duplicate', 'commandId'),
        correlationId: 'm4-duplicate',
        causationId: null,
        issuedAt: new Date().toISOString(),
        sessionId: null,
        interaction: 'defer',
        confirmExternalModelProcessing: false,
        task: fixture.task,
      }, fixture.owner)
      const request = second.planning.approvalRequest!
      await expect(fixture.repository.decidePlan({
        commandId: brandedId<'ExperienceCommandId'>('m4-approve-duplicate', 'commandId'),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: request.planRevision,
        decision: 'approve',
        reason: 'must conflict with the existing exact authorization',
        correlationId: 'm4-duplicate',
        causationId: second.receipt.receiptId,
        issuedAt: new Date().toISOString(),
      }, fixture.owner)).rejects.toMatchObject({ code: 'idempotency_conflict' })
      expect(fixture.repository.getPlanningResult(String(second.planning.plan.usageId), fixture.owner))
        .toMatchObject({ approvalRequest: { status: 'pending' }, retryBinding: null })
    } finally {
      await fixture.database.close()
    }
  })

  it('reclaims an expired claim lease without creating a second binding', async () => {
    const fixture = await approvedFixture()
    try {
      const input = {
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-m4',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 1,
      }
      const first = await fixture.repository.claimAdmissionRetryBinding(input)
      expect(first?.binding).toMatchObject({ state: 'claimed', claimRevision: 1 })
      await new Promise(resolve => setTimeout(resolve, 5))
      const reclaimed = await fixture.repository.claimAdmissionRetryBinding({ ...input, leaseMs: 30_000 })
      expect(reclaimed?.binding).toMatchObject({
        bindingId: first!.binding.bindingId,
        state: 'claimed',
        claimRevision: 2,
      })
      expect(fixture.repository.getContextUsage(
        String(fixture.approved.planning.plan.usageId),
        fixture.owner,
      ).admissionAttempts).toEqual([
        expect.objectContaining({ state: 'approved' }),
        expect.objectContaining({ state: 'interrupted', reasonCode: 'claim_lease_expired' }),
        expect.objectContaining({ state: 'ready_to_enter' }),
      ])
    } finally {
      await fixture.database.close()
    }
  })

  it('persists superseded when a current observation changes before consume', async () => {
    const fixture = await approvedFixture()
    try {
      const claimed = (await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-m4',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      }))!
      const prepared = prepareContext(claimed.planning, 'session-stale')
      const current = await fixture.observations.observe(fixture.task)
      const changed: PlanningObservationView[] = current.map((item, index) => index === 0
        ? { ...item, summary: `${item.summary} changed` }
        : item)
      await expect(fixture.repository.consumeClaimAndPrepareContext({
        claimed,
        currentObservations: changed,
        snapshot: prepared.snapshot,
        delivery: prepared.delivery,
      })).rejects.toMatchObject({ code: 'stale_revision' })
      expect(fixture.repository.getPlanningResult(String(claimed.planning.plan.usageId), fixture.owner)
      ).toMatchObject({
        approvalRequest: { status: 'superseded', reason: 'current_observation_changed' },
        retryBinding: { state: 'superseded', stateReasonCode: 'current_observation_changed' },
      })
      expect(fixture.repository.getContextUsage(
        String(claimed.planning.plan.usageId),
        fixture.owner,
      ).admissionAttempts.at(-1)).toMatchObject({
        state: 'rejected',
        reasonCode: 'current_observation_changed',
      })
    } finally {
      await fixture.database.close()
    }
  })

  it('records an exact pending retirement and completes it idempotently', async () => {
    const fixture = await approvedFixture()
    try {
      const claimed = (await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-m4',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      }))!
      const prepared = prepareContext(claimed.planning, 'session-retire')
      await fixture.repository.consumeClaimAndPrepareContext({
        claimed,
        currentObservations: await fixture.observations.observe(fixture.task),
        snapshot: prepared.snapshot,
        delivery: prepared.delivery,
      })
      const appended = await fixture.repository.recordContextAppended({
        contextDeliveryId: prepared.delivery.contextDeliveryId,
        sessionId: 'session-retire',
        messageId: prepared.delivery.messageId,
        contentDigest: prepared.delivery.contentDigest,
        sessionEventSeq: 11,
        appendedAt: '2026-09-02T10:00:00.000Z',
      })
      const pending = await fixture.repository.requestContextRetirement(appended, 'next_usage')
      expect(pending).toMatchObject({ status: 'pending', replacedSessionEventSeq: 11 })
      const completed = await fixture.repository.finishContextRetirement(String(pending.contextRetirementId), {
        replacementSessionEventSeq: 15,
      })
      expect(completed).toMatchObject({ status: 'replaced_on_surface', replacementSessionEventSeq: 15 })
      expect(await fixture.repository.finishContextRetirement(String(pending.contextRetirementId), {
        replacementSessionEventSeq: 15,
      })).toEqual(completed)
      expect(fixture.repository.listActiveContextDeliveries('session-retire')).toEqual([])
    } finally {
      await fixture.database.close()
    }
  })

  it('rejects schema-v3 pre-release approvals instead of widening old retry authorization', async () => {
    const fixture = await approvedFixture()
    const usageId = String(fixture.approved.planning.plan.usageId)
    const bindingId = String(fixture.approved.planning.retryBinding!.bindingId)
    const requestId = String(fixture.approved.planning.approvalRequest!.requestId)
    await fixture.database.close()
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(fixture.path)
    const request = JSON.parse((legacy.prepare(
      'SELECT payload_json FROM plan_approval_requests WHERE request_id = ?',
    ).get(requestId) as { payload_json: string }).payload_json) as Record<string, unknown>
    delete request.principalId
    legacy.prepare('UPDATE plan_approval_requests SET payload_json = ? WHERE request_id = ?')
      .run(JSON.stringify(request), requestId)
    const binding = JSON.parse((legacy.prepare(
      'SELECT payload_json FROM admission_retry_bindings WHERE binding_id = ?',
    ).get(bindingId) as { payload_json: string }).payload_json) as Record<string, unknown>
    for (const field of ['principalId', 'claimRevision', 'claimedByAdmissionAttemptId', 'claimLeaseUntil', 'stateReasonCode', 'updatedAt']) {
      delete binding[field]
    }
    legacy.prepare(
      "UPDATE admission_retry_bindings SET state = 'active', payload_json = ?, lease_until = NULL WHERE binding_id = ?",
    ).run(JSON.stringify({ ...binding, state: 'active' }), bindingId)
    const usage = JSON.parse((legacy.prepare(
      'SELECT payload_json FROM experience_usages WHERE usage_id = ?',
    ).get(usageId) as { payload_json: string }).payload_json) as Record<string, unknown>
    usage.approvalRequest = request
    usage.retryBinding = { ...binding, state: 'active' }
    legacy.prepare(
      "UPDATE experience_usages SET state = 'approved_not_started', payload_json = ? WHERE usage_id = ?",
    ).run(JSON.stringify(usage), usageId)
    legacy.exec(`
      DROP TABLE forget_context_targets;
      DROP TABLE forget_step_results;
      DROP TABLE forget_tombstones;
      DROP TABLE forget_requests;
      PRAGMA user_version = 3;
    `)
    legacy.close()
    await expect(ExperienceDatabase.open(databaseConfig(fixture.path)))
      .rejects.toMatchObject({ code: 'database_schema_invalid' })
  })
})

async function approvedFixture(sessionId: string | null = null) {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m4-'))
  cleanup.push(directory)
  const path = join(directory, 'experience.sqlite')
  const database = await ExperienceDatabase.open(databaseConfig(path))
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const owner: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(`browser:${String(principalId)}`, 'actorId'),
    principalId,
    kind: 'browser_local_owner',
    authority: 'owner',
  }
  const runtimeActor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>('agent:runtime-m4', 'actorId'),
    principalId,
    kind: 'agent',
    authority: 'query_only',
  }
  await publishReviewedWorkflow(repository, owner)
  const observations = new PlanningObservationRegistry(new Context(), 300_000)
  const planning = new ExperiencePlanningService(
    repository,
    observations,
    { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
    {
      retrievalCandidateLimit: 32,
      observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000,
      maxPlanningTaskBytes: 32_768,
    },
    'deterministic',
  )
  const task: PlanTaskCommandInput['task'] = {
    text: 'Build and start the DeepSeek Harness Web application',
    workspaceRoot: null,
    targetExposure: 'local',
    mustUseExperience: true,
    riskClass: 'standard',
    requiredCapabilities: ['build', 'web'],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
  }
  const planned = await planning.plan({
    commandId: brandedId<'ExperienceCommandId'>('m4-plan', 'commandId'),
    correlationId: 'm4-test',
    causationId: null,
    issuedAt: new Date().toISOString(),
    sessionId,
    interaction: 'defer',
    confirmExternalModelProcessing: false,
    task,
  }, owner)
  const request = planned.planning.approvalRequest!
  const approved = await repository.decidePlan({
    commandId: brandedId<'ExperienceCommandId'>('m4-approve', 'commandId'),
    requestId: request.requestId,
    usagePlanId: request.usagePlanId,
    expectedPlanRevision: request.planRevision,
    decision: 'approve',
    reason: 'approved for M4 admission test',
    correlationId: 'm4-test',
    causationId: planned.receipt.receiptId,
    issuedAt: new Date().toISOString(),
  }, owner)
  return { database, path, repository, observations, planning, owner, runtimeActor, task, approved }
}

function databaseConfig(databasePath: string) {
  return {
    databasePath,
    journalMode: 'wal' as const,
    synchronous: 'normal' as const,
    busyTimeoutMs: 1_000,
    maxPendingWrites: 16,
  }
}

function prepareContext(
  planning: Awaited<ReturnType<ExperiencePlanningService['plan']>>['planning'],
  sessionId: string,
) {
  const sections = contextSections(planning)
  const content = renderContext(sections)
  const contextSnapshotId = brandedId<'ExperienceContextSnapshotId'>(randomUUID(), 'contextSnapshotId')
  const contextDeliveryId = brandedId<'ExperienceContextDeliveryId'>(randomUUID(), 'contextDeliveryId')
  const message = createExperienceContextMessage(content, {
    usageId: planning.plan.usageId,
    contextSnapshotId,
    contentDigest: digest(content),
    sections,
  }, contextDeliveryId)
  const createdAt = new Date().toISOString()
  const snapshot = materializeContextSnapshot(
    planning,
    sections,
    contextSnapshotId,
    String(message.id),
    createdAt,
  )
  const delivery: ContextDeliveryView = {
    contextDeliveryId,
    contextSnapshotId,
    usageId: planning.plan.usageId,
    sessionId,
    messageId: String(message.id),
    contentDigest: snapshot.contentDigest,
    deliveryStatus: 'prepared',
    sessionEventSeq: null,
    requestBoundaryRef: null,
    appendedAt: null,
    deliveredAt: null,
    createdAt,
  }
  return { snapshot, delivery, message }
}
