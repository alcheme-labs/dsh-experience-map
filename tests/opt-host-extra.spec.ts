import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExperienceContextMessage } from '../src/adapters/context-message.js'
import { PlanningObservationRegistry } from '../src/adapters/observations.js'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { ContextRetirementCoordinator } from '../src/application/context-retirement.js'
import { ExperienceForgetService } from '../src/application/forget-service.js'
import { ExperienceLearningProjector } from '../src/application/learning-projector.js'
import { ExperiencePlanningService } from '../src/application/planning-service.js'
import { contextSections, materializeContextSnapshot, renderContext } from '../src/domain/context.js'
import { admissionTaskDigest, digest, usageScopeDigest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type {
  ActorView,
  ContextDeliveryView,
  PlanTaskCommandInput,
  PlanningResultView,
} from '../src/types.js'
import { task, planInput } from './fixtures/retrieval-fixture.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'
import { createM5Fixture } from './fixtures/m5-usage.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface HostFixture {
  readonly path: string
  readonly database: ExperienceDatabase
  readonly repository: ExperienceRepository
  readonly actor: ActorView
  readonly service: ExperiencePlanningService
  readonly close: () => Promise<void>
}

async function hostFixture(candidateLimit: number): Promise<HostFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-host-'))
  cleanup.push(directory)
  const path = join(directory, 'experience.sqlite')
  const database = await ExperienceDatabase.open({
    databasePath: path, journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 1_000, maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const actor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(principalId, 'actorId'),
    principalId, kind: 'management_local_owner', authority: 'owner',
  }
  const service = new ExperiencePlanningService(
    repository,
    new PlanningObservationRegistry(new Context(), 300_000),
    { ask: async () => ({ kind: 'defer' }) } as never,
    { retrievalCandidateLimit: candidateLimit, observationFreshnessMs: 300_000, planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
    'deterministic',
  )
  return {
    path, database, repository, actor, service,
    close: async () => { await database.close(); await rm(directory, { recursive: true, force: true }) },
  }
}

async function planSelected(
  f: HostFixture,
  id: string,
  text: string,
  taskOverrides: Partial<PlanTaskCommandInput['task']> = {},
) {
  const result = await f.service.plan(planInput(randomUUID(), task({ text, ...taskOverrides })), f.actor)
  const back = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor)
  return {
    selected: back.plan.selectedContributions.some(contribution => contribution.experienceVersionId === id),
    candidate: back.matchSet.candidates.find(candidate => candidate.experienceVersionId === id),
    preflights: back.preflights,
    usageId: back.plan.usageId,
    matchSet: back.matchSet,
  }
}

describe('OPT-Host extra: A3 hard eligibility before Plan', () => {
  it('rejects a disallowed use mode and allows the matching use mode', async () => {
    const f = await hostFixture(32)
    try {
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 901, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired', allowedUseModes: ['suggest'],
      }))).published.experienceVersionId!
      const guided = await planSelected(f, id, 'certificate expired', { requestedUseMode: 'guided' })
      expect(guided.selected).toBe(false)
      expect(guided.candidate?.reasonCodes).toContain('use_mode_not_allowed')
      expect(guided.preflights.some(preflight => preflight.disposition === 'blocked'
        && preflight.blockers.includes('use_mode_not_allowed'))).toBe(true)
      const suggest = await planSelected(f, id, 'certificate expired', { requestedUseMode: 'suggest' })
      expect(suggest.selected).toBe(true)
      expect(suggest.candidate?.reasonCodes).not.toContain('use_mode_not_allowed')
    } finally {
      await f.close()
    }
  })

  it('a disallowed-mode candidate does not crowd out a legal candidate at the limit', async () => {
    const f = await hostFixture(1)
    try {
      const legal = (await publishReviewedWorkflow(f.repository, f.actor, 902, workflowDraft({
        title: 'TLS certificate expired', intent: 'TLS certificate expired',
      }))).published.experienceVersionId!
      const disallowed = (await publishReviewedWorkflow(f.repository, f.actor, 903, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired', allowedUseModes: ['suggest'],
      }))).published.experienceVersionId!
      const result = await planSelected(f, legal, 'certificate expired TLS')
      expect(result.selected).toBe(true)
      expect(result.matchSet.candidates.some(candidate => candidate.experienceVersionId === disallowed)).toBe(false)
    } finally {
      await f.close()
    }
  })

  it('rejects an explicitly mismatched scope.taskFamily, a matching scope passes', async () => {
    const f = await hostFixture(32)
    try {
      const mismatch = (await publishReviewedWorkflow(f.repository, f.actor, 904, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired', scope: { taskFamily: 'build' },
      }))).published.experienceVersionId!
      const result = await planSelected(f, mismatch, 'certificate expired')
      expect(result.selected).toBe(false)
      expect(result.candidate?.reasonCodes).toContain('hard_scope_conflict')
      const matches = (await publishReviewedWorkflow(f.repository, f.actor, 905, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired', scope: { taskFamily: 'deployment' },
      }))).published.experienceVersionId!
      const ok = await planSelected(f, matches, 'deploy certificate expired')
      expect(ok.selected).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('rejects an explicitly mismatched scope.workspaceRoot', async () => {
    const f = await hostFixture(32)
    try {
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 906, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired', scope: { workspaceRoot: '/workspace/a' },
      }))).published.experienceVersionId!
      const result = await planSelected(f, id, 'certificate expired', { workspaceRoot: '/workspace/b' })
      expect(result.selected).toBe(false)
      expect(result.candidate?.reasonCodes).toContain('hard_scope_conflict')
    } finally {
      await f.close()
    }
  })

  it('rejects zero capability coverage and reuses a partial capability', async () => {
    const f = await hostFixture(32)
    try {
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 907, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired',
      }))).published.experienceVersionId!
      const mismatch = await planSelected(f, id, 'certificate expired', { requiredCapabilities: ['kubernetes'] })
      expect(mismatch.selected).toBe(false)
      expect(mismatch.candidate?.reasonCodes).toContain('capability_mismatch')
      const partial = await planSelected(f, id, 'certificate expired', { requiredCapabilities: ['certificate', 'kubernetes'] })
      expect(partial.selected).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('restricted is readable by a LocalOwner and denied to a query-only actor', async () => {
    const f = await hostFixture(32)
    try {
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 908, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired', privacyClass: 'restricted',
      }))).published.experienceVersionId!
      const owner = await planSelected(f, id, 'certificate expired')
      expect(owner.selected).toBe(true)
      const queryOnly: ActorView = { ...f.actor, kind: 'agent', authority: 'query_only' }
      await expect(f.service.plan(planInput(randomUUID(), task({ text: 'certificate expired' })), queryOnly))
        .rejects.toMatchObject({ code: 'principal_unauthorized' })
    } finally {
      await f.close()
    }
  })

  it('an ineligible matching neighbour must not turn a legal plan from ready_for_approval to blocked', async () => {
    const f = await hostFixture(32)
    try {
      await publishReviewedWorkflow(f.repository, f.actor, 1801, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired',
      }))
      const before = (await f.service.plan(planInput(randomUUID(), task({ text: 'certificate expired' })), f.actor)).planning
      expect(before.plan.disposition).toBe('ready_for_approval')
      await publishReviewedWorkflow(f.repository, f.actor, 1802, workflowDraft({
        title: 'certificate expired neighbour', intent: 'certificate expired neighbour', allowedUseModes: ['suggest'],
      }))
      const after = (await f.service.plan(planInput(randomUUID(), task({ text: 'certificate expired' })), f.actor)).planning
      expect(after.plan.disposition).toBe(before.plan.disposition)
      // The rejected sibling is still surfaced for the inspector with its reason.
      expect(after.matchSet.candidates.some(candidate => candidate.rejected
        && candidate.reasonCodes.includes('use_mode_not_allowed'))).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('a retained public/local independent-build component still preserves the required observation blocker', async () => {
    const f = await hostFixture(32)
    try {
      const draft = workflowDraft({
        title: 'deploy build artifact', intent: 'deploy build artifact', scope: { surface: 'local' },
      })
      await publishReviewedWorkflow(f.repository, f.actor, 1901, {
        ...draft,
        components: draft.components.map(component => ({ ...component, content: `build artifact ${component.content}` })),
      })
      const p = (await f.service.plan(planInput(randomUUID(), task({
        text: 'deploy build artifact', targetExposure: 'public', riskClass: 'medium',
      })), f.actor)).planning
      expect(p.matchSet.candidates[0]!.selectedComponentRevisionIds.length).toBeGreaterThan(0)
      expect(p.preflights[0]!.blockers).toContain('required_observation_unknown')
      expect(p.plan.disposition).toBe('blocked')
    } finally {
      await f.close()
    }
  })
})

describe('OPT-Host extra: A2b reason codes and guards', () => {
  it('emits alias_match only on a real cross-lingual alias hit and it survives readback', async () => {
    const f = await hostFixture(32)
    try {
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 911, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired',
      }))).published.experienceVersionId!
      const result = await planSelected(f, id, '证书过期')
      expect(result.selected).toBe(true)
      expect(result.candidate?.reasonCodes).toContain('alias_match')
      const persisted = f.repository.getPlanningResult(result.usageId, f.actor)
      expect(persisted.matchSet.candidates.find(c => c.experienceVersionId === id)?.reasonCodes).toContain('alias_match')
    } finally {
      await f.close()
    }
  })

  it('does not emit alias_match for a pure English lexical match', async () => {
    const f = await hostFixture(32)
    try {
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 912, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired',
      }))).published.experienceVersionId!
      const result = await planSelected(f, id, 'certificate expired')
      expect(result.selected).toBe(true)
      expect(result.candidate?.reasonCodes).toContain('lexical_match_only')
      expect(result.candidate?.reasonCodes).not.toContain('alias_match')
    } finally {
      await f.close()
    }
  })

  it('emits exact_signal_match for a symptom_signature code, not for a misleading_signal', async () => {
    const f = await hostFixture(32)
    try {
      const draft = workflowDraft({ title: 'socket service failure', intent: 'socket service failure' })
      const sigComponents = draft.components.map(component =>
        component.role === 'symptom_signature' ? { ...component, content: 'EADDRINUSE socket service failure' } : component)
      const sig = (await publishReviewedWorkflow(f.repository, f.actor, 913, { ...draft, components: sigComponents })).published.experienceVersionId!
      const sigResult = await planSelected(f, sig, 'EADDRINUSE socket service failure')
      expect(sigResult.selected).toBe(true)
      expect(sigResult.candidate?.reasonCodes).toContain('exact_signal_match')
      const misComponents = draft.components.map(component =>
        component.role === 'misleading_signal' ? { ...component, content: 'EADDRINUSE socket service failure' } : component)
      const mis = (await publishReviewedWorkflow(f.repository, f.actor, 914, { ...draft, components: misComponents })).published.experienceVersionId!
      const misResult = await planSelected(f, mis, 'socket service failure')
      expect(misResult.selected).toBe(true)
      expect(misResult.candidate?.reasonCodes).not.toContain('exact_signal_match')
    } finally {
      await f.close()
    }
  })

  it('an unlisted identifier gets no special symptom handling', async () => {
    const f = await hostFixture(32)
    try {
      const draft = workflowDraft({ title: 'network diagnostic', intent: 'network diagnostic' })
      const components = draft.components.map(component =>
        component.role === 'symptom_signature' ? { ...component, content: 'EADDRINUSE' } : component)
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 915, { ...draft, components })).published.experienceVersionId!
      const result = await planSelected(f, id, 'MY_EADDRINUSE_WRAPPER')
      expect(result.selected).toBe(false)
      expect(result.candidate?.reasonCodes ?? []).not.toContain('exact_signal_conflict')
      expect(result.candidate?.reasonCodes ?? []).not.toContain('exact_signal_match')
    } finally {
      await f.close()
    }
  })

  it('exact_signal_conflict overrides the public/local independent-build exception', async () => {
    const f = await hostFixture(32)
    try {
      const draft = workflowDraft({ title: 'socket service failure', intent: 'socket service failure', scope: { surface: 'local' } })
      const components = draft.components.map(component => {
        if (component.role === 'symptom_signature') return { ...component, content: 'EADDRINUSE socket service failure' }
        if (component.role === 'resolution_candidate') return { ...component, content: 'build artifact bundle' }
        return component
      })
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 916, { ...draft, components })).published.experienceVersionId!
      const result = await planSelected(f, id, 'EADDRNOTAVAIL socket service failure', { targetExposure: 'public' })
      expect(result.selected).toBe(false)
      expect(result.candidate?.rejected).toBe(true)
      expect(result.candidate?.reasonCodes).toContain('exact_signal_conflict')
      expect(result.candidate?.selectedComponentRevisionIds).toEqual([])
      expect(result.preflights.some(preflight => preflight.disposition === 'blocked'
        && preflight.blockers.includes('exact_signal_conflict'))).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('pure-Chinese same-word overlap is not a cross-language alias contribution', async () => {
    const f = await hostFixture(8)
    try {
      const id = (await publishReviewedWorkflow(f.repository, f.actor, 1702, workflowDraft({
        title: '证书过期', intent: '证书过期',
      }))).published.experienceVersionId!
      const result = await planSelected(f, id, '证书过期')
      expect(result.selected).toBe(true)
      expect(result.candidate?.reasonCodes).toContain('lexical_match_only')
      expect(result.candidate?.reasonCodes).not.toContain('alias_match')
    } finally {
      await f.close()
    }
  })
})

describe('OPT-Host extra: A3 admission version currency', () => {
  it('never first-delivers an approved plan whose Experience was Forgot on another connection; supersede survives restart', async () => {
    const fixture = await currencyFixture()
    try {
      const claimed = (await fixture.repository.claimAdmissionRetryBinding({
        taskInputDigest: admissionTaskDigest(fixture.task.text),
        sessionId: 'session-currency',
        scopeDigest: usageScopeDigest(fixture.task),
        workspaceRoot: fixture.task.workspaceRoot,
        runtimeActor: fixture.runtimeActor,
        leaseMs: 30_000,
      }))!
      expect(claimed).not.toBeNull()
      await forgetOnOtherConnection(fixture.path, fixture.experienceId, fixture.owner)
      expect(fixture.repository.listPlanningVersions(fixture.owner, 32)).toEqual([])
      const prepared = await prepareContext(claimed.planning, 'session-currency')
      await expect(fixture.repository.consumeClaimAndPrepareContext({
        claimed,
        currentObservations: await fixture.observations.observe(fixture.task),
        snapshot: prepared.snapshot,
        delivery: prepared.delivery,
      })).rejects.toMatchObject({ code: 'stale_revision' })
      expect(fixture.repository.getPlanningResult(String(claimed.planning.plan.usageId), fixture.owner))
        .toMatchObject({
          approvalRequest: { status: 'superseded', reason: 'version_not_current' },
          retryBinding: { state: 'superseded', stateReasonCode: 'version_not_current' },
        })
      await fixture.database.close()
      const reopened = await ExperienceDatabase.open({
        databasePath: fixture.path, journalMode: 'wal', synchronous: 'normal',
        busyTimeoutMs: 1_000, maxPendingWrites: 16,
      })
      try {
        const repository = new ExperienceRepository(reopened)
        expect(repository.getPlanningResult(String(claimed.planning.plan.usageId), fixture.owner))
          .toMatchObject({
            approvalRequest: { status: 'superseded', reason: 'version_not_current' },
            retryBinding: { state: 'superseded', stateReasonCode: 'version_not_current' },
          })
      } finally {
        await reopened.close()
      }
    } finally {
      await fixture.database.close().catch(() => undefined)
    }
  })

  it('rejects a new Plan when another connection Forgets the selected Experience between scan and persist', async () => {
    const f = await hostFixture(8)
    let second: ExperienceDatabase | undefined
    try {
      const published = await publishReviewedWorkflow(f.repository, f.actor, 1803, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired',
      }))
      const id = published.published.experienceVersionId!
      second = await ExperienceDatabase.open({
        databasePath: f.path, journalMode: 'wal', synchronous: 'normal',
        busyTimeoutMs: 1_000, maxPendingWrites: 16,
      })
      const other = new ExperienceRepository(second)
      const original = f.repository.createPlanningResult.bind(f.repository)
      vi.spyOn(f.repository, 'createPlanningResult').mockImplementationOnce(async (...args) => {
        const preview = other.previewForget(published.published.experienceId!, f.actor)
        await other.forgetExperience({
          commandId: randomUUID() as never,
          experienceId: preview.experienceId,
          expectedSeriesRevision: preview.expectedSeriesRevision,
          previewDigest: preview.previewDigest,
          reason: 'owner confirmed forget',
          correlationId: randomUUID(),
          causationId: null,
          issuedAt: new Date().toISOString(),
        }, f.actor)
        return original(...args)
      })
      let result
      try {
        result = await f.service.plan(planInput(randomUUID(), task({ text: 'certificate expired' })), f.actor)
      } catch (error) {
        expect((error as { code?: string }).code).toBe('stale_revision')
        return
      }
      const back = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor)
      expect(back.plan.selectedContributions.some(contribution => contribution.experienceVersionId === id)).toBe(false)
    } finally {
      await second?.close()
      await f.close()
    }
  })

  it('does not rewrite an already-started Usage history when the Experience is later Forgot on another connection', async () => {
    const fixture = await createM5Fixture()
    cleanup.push(fixture.directory)
    const usageId = String(fixture.planning.plan.usageId)
    const versionId = fixture.baseVersion.experienceVersionId
    const before = fixture.repository.getContextUsage(usageId, fixture.owner)
    expect(before.snapshot).not.toBeNull()
    expect(before.admissionAttempts.some(attempt => attempt.state === 'entered')).toBe(true)
    await forgetOnOtherConnection(join(fixture.directory, 'experience.sqlite'), fixture.baseVersion.experienceId, fixture.owner)
    const after = fixture.repository.getContextUsage(usageId, fixture.owner)
    expect(after.snapshot?.contentDigest).toBe(before.snapshot?.contentDigest)
    expect(after.delivery?.contextDeliveryId).toBe(before.delivery?.contextDeliveryId)
    expect(after.admissionAttempts.map(attempt => attempt.state)).toEqual(before.admissionAttempts.map(attempt => attempt.state))
    expect(after.planning.plan.selectedContributions
      .some(contribution => contribution.experienceVersionId === versionId)).toBe(true)
    expect(fixture.repository.getVersion(versionId, fixture.owner).experienceVersionId).toBe(versionId)
  })

  it('cannot approve a selected Experience after a canonical Forget', async () => {
    const f = await hostFixture(8)
    try {
      const published = await publishReviewedWorkflow(f.repository, f.actor, 1902, workflowDraft({
        title: 'certificate expired', intent: 'certificate expired',
      }))
      const p = (await f.service.plan(planInput(randomUUID(), task({ text: 'certificate expired' })), f.actor)).planning
      const preview = f.repository.previewForget(published.published.experienceId!, f.actor)
      await f.repository.forgetExperience({
        commandId: randomUUID() as never,
        experienceId: preview.experienceId,
        expectedSeriesRevision: preview.expectedSeriesRevision,
        previewDigest: preview.previewDigest,
        reason: 'owner forget',
        correlationId: 'r2-review',
        causationId: null,
        issuedAt: new Date().toISOString(),
      }, f.actor)
      const request = p.approvalRequest!
      let result
      try {
        result = await f.repository.decidePlan({
          commandId: randomUUID() as never,
          requestId: request.requestId,
          usagePlanId: request.usagePlanId,
          expectedPlanRevision: request.planRevision,
          decision: 'approve',
          reason: 'review',
          correlationId: 'r2-review',
          causationId: null,
          issuedAt: new Date().toISOString(),
        }, f.actor)
      } catch (error) {
        expect((error as { code?: string }).code).toBe('stale_revision')
        return
      }
      expect(result.planning.approvalRequest?.status).not.toBe('approved')
    } finally {
      await f.close()
    }
  })
})

interface CurrencyFixture {
  readonly path: string
  readonly database: ExperienceDatabase
  readonly repository: ExperienceRepository
  readonly owner: ActorView
  readonly runtimeActor: ActorView
  readonly task: PlanTaskCommandInput['task']
  readonly observations: PlanningObservationRegistry
  readonly forgetService: ExperienceForgetService
  readonly forgetInput: Parameters<ExperienceForgetService['forget']>[0]
  readonly experienceId: import('../src/ids.js').ExperienceId
}

async function currencyFixture(): Promise<CurrencyFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-currency-'))
  cleanup.push(directory)
  const path = join(directory, 'experience.sqlite')
  const database = await ExperienceDatabase.open({
    databasePath: path, journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 1_000, maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const owner: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(`owner:${principalId}`, 'actorId'),
    principalId, kind: 'management_local_owner', authority: 'owner',
  }
  const runtimeActor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(`runtime:${principalId}`, 'actorId'),
    principalId, kind: 'agent', authority: 'query_only',
  }
  const published = await publishReviewedWorkflow(repository, owner)
  const observations = new PlanningObservationRegistry(new Context(), 300_000)
  const planning = new ExperiencePlanningService(
    repository, observations,
    { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
    { retrievalCandidateLimit: 32, observationFreshnessMs: 300_000, planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
    'deterministic',
  )
  const task: PlanTaskCommandInput['task'] = {
    text: 'Build and start the DeepSeek Harness Web application',
    workspaceRoot: null, targetExposure: 'local', mustUseExperience: true,
    riskClass: 'standard', requiredCapabilities: ['build', 'web'],
    requestedUseMode: 'guided', overrideDecisionIds: [],
  }
  const planned = await planning.plan({
    commandId: brandedId<'ExperienceCommandId'>('currency-plan', 'commandId'),
    correlationId: 'currency', causationId: null,
    issuedAt: new Date().toISOString(), sessionId: null, interaction: 'defer',
    confirmExternalModelProcessing: false, task,
  }, owner)
  const request = planned.planning.approvalRequest!
  await repository.decidePlan({
    commandId: brandedId<'ExperienceCommandId'>('currency-approve', 'commandId'),
    requestId: request.requestId, usagePlanId: request.usagePlanId,
    expectedPlanRevision: request.planRevision, decision: 'approve',
    reason: 'approved for currency test', correlationId: 'currency',
    causationId: planned.receipt.receiptId, issuedAt: new Date().toISOString(),
  }, owner)
  const actors = new ActorResolver(principalId)
  const ctx = new Context()
  const learning = new ExperienceLearningProjector(ctx, repository, {
    learningPollIntervalMs: 60_000, learningClaimLeaseMs: 30_000,
    learningRetryDelayMs: 1_000, learningBatchSize: 32,
  })
  const forgetService = new ExperienceForgetService(
    ctx, repository, actors, new ContextRetirementCoordinator(ctx, repository), learning,
  )
  const preview = forgetService.preview(published.published.experienceId!, { kind: 'management-cli' })
  const forgetInput = {
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    experienceId: preview.experienceId,
    expectedSeriesRevision: preview.expectedSeriesRevision,
    previewDigest: preview.previewDigest,
    reason: 'The owner confirmed this Experience must no longer be recalled',
    correlationId: randomUUID(), causationId: null, issuedAt: new Date().toISOString(),
  }
  return {
    path, database, repository, owner, runtimeActor, task, observations, forgetService, forgetInput,
    experienceId: published.published.experienceId!,
  }
}

/** Complete a canonical Forget through a separate SQLite connection on the same database file. */
async function forgetOnOtherConnection(
  path: string,
  experienceId: import('../src/ids.js').ExperienceId,
  owner: ActorView,
): Promise<void> {
  const second = await ExperienceDatabase.open({
    databasePath: path, journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 1_000, maxPendingWrites: 16,
  })
  try {
    const other = new ExperienceRepository(second)
    const preview = other.previewForget(experienceId, owner)
    await other.forgetExperience({
      commandId: randomUUID() as never,
      experienceId: preview.experienceId,
      expectedSeriesRevision: preview.expectedSeriesRevision,
      previewDigest: preview.previewDigest,
      reason: 'The owner confirmed this Experience must no longer be recalled',
      correlationId: randomUUID(),
      causationId: null,
      issuedAt: new Date().toISOString(),
    }, owner)
  } finally {
    await second.close()
  }
}

async function prepareContext(planning: PlanningResultView, sessionId: string) {
  const sections = contextSections(planning)
  const content = renderContext(sections)
  const contextSnapshotId = brandedId<'ExperienceContextSnapshotId'>(randomUUID(), 'contextSnapshotId')
  const contextDeliveryId = brandedId<'ExperienceContextDeliveryId'>(randomUUID(), 'contextDeliveryId')
  const message = createExperienceContextMessage(content, {
    usageId: planning.plan.usageId, contextSnapshotId, contentDigest: digest(content), sections,
  }, contextDeliveryId)
  const createdAt = new Date().toISOString()
  const snapshot = materializeContextSnapshot(planning, sections, contextSnapshotId, String(message.id), createdAt)
  const delivery: ContextDeliveryView = {
    contextDeliveryId, contextSnapshotId, usageId: planning.plan.usageId, sessionId,
    messageId: String(message.id), contentDigest: snapshot.contentDigest,
    deliveryStatus: 'prepared', sessionEventSeq: null, requestBoundaryRef: null,
    appendedAt: null, deliveredAt: null, createdAt,
  }
  return { snapshot, delivery }
}
