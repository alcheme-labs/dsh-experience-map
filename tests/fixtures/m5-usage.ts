import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExperienceContextMessage } from '../../src/adapters/context-message.js'
import { ExperiencePlanningService } from '../../src/application/planning-service.js'
import { contextSections, materializeContextSnapshot, renderContext } from '../../src/domain/context.js'
import { admissionTaskDigest, digest, usageScopeDigest } from '../../src/domain/planning.js'
import { brandedId } from '../../src/ids.js'
import { ExperienceDatabase } from '../../src/persistence/database.js'
import { ExperienceRepository } from '../../src/persistence/repository.js'
import type {
  ActorView,
  ContextDeliveryView,
  DiagnosticCandidateDraft,
  ExperienceCandidateDraft,
  PlanningObservationView,
  PlanningTaskInput,
} from '../../src/types.js'
import { publishReviewedWorkflow } from './published-workflow.js'
import { workflowDraft } from './workflow.js'

/** Create one approved, consumed, started Usage over an authenticated Web contract. */
export async function createM5Fixture(options: {
  readonly stale?: boolean
  readonly approvalSurface?: 'browser' | 'management'
  readonly additionalDrafts?: readonly ExperienceCandidateDraft[]
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m5-'))
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'),
    journalMode: 'wal',
    synchronous: 'normal',
    busyTimeoutMs: 1_000,
    maxPendingWrites: 16,
  })
  const repository = new ExperienceRepository(database)
  const principalId = await repository.initializePrincipal()
  const owner: ActorView = {
    actorId: brandedId<'ExperienceActorId'>(`browser:${String(principalId)}`, 'actorId'),
    principalId,
    kind: 'browser_local_owner',
    authority: 'owner',
  }
  const runtimeActor: ActorView = {
    actorId: brandedId<'ExperienceActorId'>('agent:m5-runtime', 'actorId'),
    principalId,
    kind: 'agent',
    authority: 'query_only',
  }
  const approvalActor: ActorView = options.approvalSurface === 'management'
    ? {
        actorId: brandedId<'ExperienceActorId'>(`management:${String(principalId)}`, 'actorId'),
        principalId,
        kind: 'management_local_owner',
        authority: 'owner',
      }
    : owner
  const draft = m5Draft(options.stale === true)
  const published = await publishReviewedWorkflow(repository, owner, 51, draft)
  for (const [index, additionalDraft] of (options.additionalDrafts ?? []).entries()) {
    await publishReviewedWorkflow(repository, owner, 52 + index, additionalDraft)
  }
  const task: PlanningTaskInput = {
    text: 'Build and start the verified DeepSeek Harness Web application',
    workspaceRoot: null,
    targetExposure: 'local',
    mustUseExperience: true,
    riskClass: 'standard',
    requiredCapabilities: ['build', 'web'],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
  }
  const current = observations()
  const planningService = new ExperiencePlanningService(
    repository,
    { observe: async () => current } as never,
    { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
    { retrievalCandidateLimit: 32, observationFreshnessMs: 300_000,
      planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
    'deterministic',
  )
  const planning = await planningService.plan({
    ...envelope(),
    sessionId: null,
    interaction: 'defer',
    confirmExternalModelProcessing: false,
    task,
  }, owner)
  const request = planning.planning.approvalRequest
  if (request === null) throw new Error('M5 fixture did not create an approval request')
  await repository.decidePlan({
    ...envelope(),
    requestId: request.requestId,
    usagePlanId: request.usagePlanId,
    expectedPlanRevision: request.planRevision,
    decision: 'approve',
    reason: 'M5 fixture approval',
  }, approvalActor)
  const claimed = await repository.claimAdmissionRetryBinding({
    taskInputDigest: admissionTaskDigest(task.text),
    sessionId: 'session-m5',
    scopeDigest: usageScopeDigest(task),
    workspaceRoot: task.workspaceRoot,
    runtimeActor,
    leaseMs: 30_000,
  })
  if (claimed === null) throw new Error('M5 fixture could not claim its retry binding')
  const content = renderContext(contextSections(claimed.planning))
  const contextSnapshotId = brandedId<'ExperienceContextSnapshotId'>(randomUUID(), 'contextSnapshotId')
  const contextDeliveryId = brandedId<'ExperienceContextDeliveryId'>(randomUUID(), 'contextDeliveryId')
  const message = createExperienceContextMessage(content, {
    usageId: claimed.planning.plan.usageId,
    contextSnapshotId,
    contentDigest: digest(content),
    sections: contextSections(claimed.planning),
  }, contextDeliveryId)
  const createdAt = new Date().toISOString()
  const snapshot = materializeContextSnapshot(
    claimed.planning,
    contextSections(claimed.planning),
    contextSnapshotId,
    String(message.id),
    createdAt,
  )
  const delivery: ContextDeliveryView = {
    contextDeliveryId,
    contextSnapshotId,
    usageId: claimed.planning.plan.usageId,
    sessionId: 'session-m5-fixture',
    messageId: String(message.id),
    contentDigest: snapshot.contentDigest,
    deliveryStatus: 'prepared',
    sessionEventSeq: null,
    requestBoundaryRef: null,
    appendedAt: null,
    deliveredAt: null,
    createdAt,
  }
  await repository.consumeClaimAndPrepareContext({ claimed, currentObservations: current, snapshot, delivery })
  const progress = await repository.startUsage(String(claimed.planning.plan.usageId), delivery.sessionId, runtimeActor)
  return { directory, database, repository, owner, approvalActor, runtimeActor, task,
    planning: repository.getPlanningResult(String(progress.usageId), owner), progress,
    baseVersion: repository.getVersion(published.published.experienceVersionId!, owner) }
}

/** Create a fresh command envelope for one M5 write. */
export function envelope() {
  return {
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    correlationId: randomUUID(),
    causationId: null,
    issuedAt: new Date().toISOString(),
  }
}

function m5Draft(stale: boolean): DiagnosticCandidateDraft {
  const base = workflowDraft()
  return {
    ...base,
    title: 'Verified DeepSeek Harness Web startup',
    intent: 'Build and start the verified DeepSeek Harness Web application.',
    components: base.components.map(component => {
      if (component.role === 'resolution_candidate') return { ...component, content: 'Run the approved Web launcher and retain its owned background job.' }
      if (component.role === 'environment_scope') return { ...component,
        content: stale ? 'Expect an anonymous HTTP 200 root response.' : 'Require token exchange and an authenticated root response.' }
      if (component.role === 'recovery_verifier') return { ...component,
        content: stale ? 'Verify unauthenticated HTTP 200 readiness.' : 'Verify token exchange, cookie, boot manifest, and authenticated RPC.' }
      return component
    }),
  }
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
