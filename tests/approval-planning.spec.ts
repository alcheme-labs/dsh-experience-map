import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlanInteractionAnswer, PlanReviewInteraction } from '../src/adapters/plan-interaction.js'
import { PlanningObservationRegistry } from '../src/adapters/observations.js'
import { ExperiencePlanningService } from '../src/application/planning-service.js'
import { admissionTaskDigest, usageScopeDigest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type { ActorView, PlanTaskCommandInput } from '../src/types.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M3 exact plan approval and retry binding', () => {
  it('persists a pending exact plan and atomically creates one active binding on approval', async () => {
    const fixture = await planningFixture()
    try {
      const created = await fixture.service.plan(planInput('plan-create', 'defer'), fixture.actor)
      expect(created.planning).toMatchObject({
        plan: { planRevision: 1, requiresApproval: true, disposition: 'ready_for_approval' },
        approvalRequest: { status: 'pending', planRevision: 1 },
        retryBinding: null,
      })
      const request = created.planning.approvalRequest!
      const approvingActor: ActorView = {
        ...fixture.actor,
        actorId: brandedId<'ExperienceActorId'>('management-local', 'actorId'),
        kind: 'management_local_owner',
      }
      const approved = await fixture.repository.decidePlan({
        commandId: brandedId<'ExperienceCommandId'>('plan-approve', 'commandId'),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: request.planRevision,
        decision: 'approve',
        reason: 'reviewed exact plan and current preflight',
        correlationId: 'approval-test',
        causationId: created.receipt.receiptId,
        issuedAt: '2026-09-02T02:01:00.000Z',
      }, approvingActor)
      expect(approved.planning).toMatchObject({
        approvalRequest: { status: 'approved' },
        admissionAttempt: { state: 'approved' },
        retryBinding: { state: 'active', planRevision: 1 },
        interactionOutcome: 'approved',
      })
      expect(approved.planning.retryBinding?.taskInputDigest)
        .toBe(admissionTaskDigest(approved.planning.fingerprint.taskText))
      expect(approved.planning.retryBinding?.taskInputDigest)
        .not.toBe(approved.planning.fingerprint.taskInputDigest)
      expect(approved.planning.retryBinding?.actorId).toBe(request.actorId)
      const bindingRow = fixture.database.handle.prepare(
        'SELECT actor_id FROM admission_retry_bindings WHERE binding_id = ?',
      ).get(approved.planning.retryBinding!.bindingId) as { actor_id: string }
      expect(bindingRow.actor_id).toBe(request.actorId)
      expect(fixture.repository.getStatus(fixture.actor).pendingPlanApprovalCount).toBe(0)
      expect(fixture.repository.getPlanningResult(approved.planning.plan.usageId, fixture.actor))
        .toEqual(approved.planning)
    } finally {
      await fixture.database.close()
    }
  })

  it('rejects stale revision and prevents two decisions from both committing', async () => {
    const fixture = await planningFixture()
    try {
      const created = await fixture.service.plan(planInput('plan-race', 'defer'), fixture.actor)
      const request = created.planning.approvalRequest!
      await expect(fixture.repository.decidePlan({
        commandId: brandedId<'ExperienceCommandId'>('stale-plan', 'commandId'),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: 2,
        decision: 'approve',
        reason: 'wrong revision',
        correlationId: 'approval-test',
        causationId: null,
        issuedAt: '2026-09-02T02:01:00.000Z',
      }, fixture.actor)).rejects.toMatchObject({ code: 'stale_revision' })
      const decisions = ['approve', 'deny'] as const
      const results = await Promise.allSettled(decisions.map((decision, index) => fixture.repository.decidePlan({
        commandId: brandedId<'ExperienceCommandId'>(`race-${String(index)}`, 'commandId'),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: 1,
        decision,
        reason: `decision ${decision}`,
        correlationId: 'approval-test',
        causationId: null,
        issuedAt: '2026-09-02T02:02:00.000Z',
      }, fixture.actor)))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    } finally {
      await fixture.database.close()
    }
  })

  it('keeps no-answerer approval pending for must-use and continues without context otherwise', async () => {
    const fixture = await planningFixture({ kind: 'no_provider', reason: 'interaction_answerer_unavailable' })
    try {
      const mustUse = await fixture.service.plan(planInput('must-use', 'ask_current_agent', true), fixture.actor)
      expect(mustUse.planning).toMatchObject({
        approvalRequest: { status: 'pending' },
        admissionAttempt: { state: 'pending_external_decision' },
        interactionOutcome: 'interaction_answerer_unavailable',
      })
      const optional = await fixture.service.plan(planInput('optional', 'ask_current_agent', false), fixture.actor)
      expect(optional.planning).toMatchObject({
        approvalRequest: { status: 'pending' },
        admissionAttempt: { state: 'no_answerer_continue' },
        interactionOutcome: 'no_answerer_continue',
      })
      expect(optional.planning.retryBinding).toBeNull()
    } finally {
      await fixture.database.close()
    }
  })

  it('supersedes the old request, creates revision two, and re-asks after Adapt', async () => {
    const fixture = await planningFixture([
      { kind: 'adapt', reason: 'Keep the build check but require authenticated readback' },
      { kind: 'approve', reason: 'adapted exact plan approved' },
    ])
    try {
      const input = planInput('adapt-plan', 'ask_current_agent', true)
      const result = await fixture.service.plan(input, fixture.actor)
      expect(result.planning).toMatchObject({
        plan: { planRevision: 2, constraints: expect.arrayContaining([
          'User-requested adaptation: Keep the build check but require authenticated readback',
        ]) },
        approvalRequest: { status: 'approved', planRevision: 2 },
        retryBinding: { state: 'active', planRevision: 2 },
        interactionOutcome: 'approved',
      })
      expect(result.planning.approvalRequest?.scopeDigest).toBe(usageScopeDigest(input.task))
    } finally {
      await fixture.database.close()
    }
  })

  it('requires explicit task-and-route confirmation before model-assisted fingerprint proposal', async () => {
    const fixture = await planningFixture()
    try {
      const modelService = new ExperiencePlanningService(
        fixture.repository,
        new PlanningObservationRegistry(new Context(), 300_000),
        { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as unknown as PlanReviewInteraction,
        {
          retrievalCandidateLimit: 32,
          observationFreshnessMs: 300_000,
          planApprovalTtlMs: 1_800_000,
          maxPlanningTaskBytes: 32_768,
        },
        'model',
      )
      await expect(modelService.plan(planInput('model-without-consent', 'defer'), fixture.actor))
        .rejects.toMatchObject({ code: 'sensitive_content_unauthorized' })
    } finally {
      await fixture.database.close()
    }
  })

  it('rejects planning through a query-only runtime actor', async () => {
    const fixture = await planningFixture()
    try {
      const queryOnly: ActorView = {
        ...fixture.actor,
        actorId: brandedId<'ExperienceActorId'>('agent-runtime', 'actorId'),
        kind: 'agent',
        authority: 'query_only',
      }
      await expect(fixture.service.plan(planInput('runtime-plan', 'defer'), queryOnly))
        .rejects.toMatchObject({ code: 'principal_unauthorized' })
    } finally {
      await fixture.database.close()
    }
  })
})

async function planningFixture(answer: PlanInteractionAnswer | readonly PlanInteractionAnswer[] = {
  kind: 'no_provider', reason: 'unused',
}) {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m3-'))
  cleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'),
    journalMode: 'wal',
    synchronous: 'normal',
    busyTimeoutMs: 1_000,
    maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const actor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(principalId, 'actorId'),
    principalId,
    kind: 'management_local_owner',
    authority: 'owner',
  }
  await publishReviewedWorkflow(repository, actor)
  let answerIndex = 0
  const interaction = { ask: async () => Array.isArray(answer)
    ? answer[Math.min(answerIndex++, answer.length - 1)]!
    : answer } as unknown as PlanReviewInteraction
  const service = new ExperiencePlanningService(
    repository,
    new PlanningObservationRegistry(new Context(), 300_000),
    interaction,
    {
      retrievalCandidateLimit: 32,
      observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000,
      maxPlanningTaskBytes: 32_768,
    },
    'deterministic',
  )
  return { database, repository, actor, service }
}

function planInput(
  commandId: string,
  interaction: PlanTaskCommandInput['interaction'],
  mustUseExperience = false,
): PlanTaskCommandInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(commandId, 'commandId'),
    correlationId: 'm3-test',
    causationId: null,
    issuedAt: '2026-09-02T02:00:00.000Z',
    sessionId: null,
    interaction,
    confirmExternalModelProcessing: false,
    task: {
      text: 'Build and start the DeepSeek Harness Web application',
      workspaceRoot: null,
      targetExposure: 'local',
      mustUseExperience,
      riskClass: 'standard',
      requiredCapabilities: ['build', 'web'],
      requestedUseMode: 'guided',
      overrideDecisionIds: [],
    },
  }
}
