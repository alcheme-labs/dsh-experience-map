import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PlanReviewInteraction } from '../../src/adapters/plan-interaction.js'
import { PlanningObservationRegistry } from '../../src/adapters/observations.js'
import { ExperiencePlanningService, type RecallPreparationPort } from '../../src/application/planning-service.js'
import { TYPE_BEHAVIORS } from '../../src/domain/behavior.js'
import { brandedId } from '../../src/ids.js'
import { ExperienceDatabase } from '../../src/persistence/database.js'
import { ExperienceRepository } from '../../src/persistence/repository.js'
import type { ActorView, PlanTaskCommandInput, PlanningTaskInput } from '../../src/types.js'
import type { SeedVersionSpec } from './store-seed.js'

export const NOW = '2026-09-02T01:00:00.000Z'

export const TASK_TEXT = 'Deploy the public marketing site behind TLS with CDN caching and monitor availability'
export const RELEVANT_KEYWORDS = 'Deploy the marketing site behind TLS with CDN and monitor availability after rollout'
export const PARTIAL_KEYWORDS = 'Deploy requires TLS verification'
export const DISTRACTOR_KEYWORDS = 'render molecular dynamics trajectory from simulation snapshot for research manuscript fitting'

export async function retrievalFixture(
  retrievalCandidateLimit: number,
): Promise<{
  readonly database: ExperienceDatabase
  readonly repository: ExperienceRepository
  readonly actor: ActorView
  readonly service: ExperiencePlanningService
  readonly close: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-retrieval-'))
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
  const interaction = { ask: async () => ({ kind: 'defer' }) } as unknown as PlanReviewInteraction
  const service = makePlanningService(repository, retrievalCandidateLimit, interaction)
  return {
    database, repository, actor, service,
    close: async () => { await database.close(); await rm(directory, { recursive: true, force: true }) },
  }
}

/** Build a planning service over any repository with a fixed candidate limit. */
export function makePlanningService(
  repository: ExperienceRepository,
  retrievalCandidateLimit: number,
  interaction: PlanReviewInteraction = { ask: async () => ({ kind: 'defer' }) } as unknown as PlanReviewInteraction,
  recall?: RecallPreparationPort,
): ExperiencePlanningService {
  return new ExperiencePlanningService(
    repository,
    new PlanningObservationRegistry(new Context(), 300_000),
    interaction,
    { retrievalCandidateLimit, observationFreshnessMs: 300_000, planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
    'deterministic',
    undefined,
    recall,
  )
}

/** Build a readVersion-valid diagnostic Version spec with keyword-bearing content. */
export function diagnosticSpec(
  title: string,
  intent: string,
  keywords: string,
): SeedVersionSpec {
  const roles = TYPE_BEHAVIORS.diagnostic.requiredRoles
  const components = roles.map(role => ({
    role,
    content: role === 'symptom_signature' || role === 'resolution_candidate' || role === 'recovery_verifier'
      ? `${keywords} ${role}`
      : `${role} evidence-bound content`,
  }))
  return { kind: 'diagnostic', title, intent, components }
}

/** Build a readVersion-valid preference_policy Version spec. `keywords` control matching. */
export function preferenceSpec(
  title: string,
  modality: 'must' | 'must_not' | 'prefer' | 'avoid',
  keywords: string,
): SeedVersionSpec {
  const content: Record<string, string> = {
    directive: 'Confirm before running',
    modality,
    subject_scope: 'local process',
    task_or_output_scope: 'current result',
    authority_source: 'explicit user instruction',
    override_policy: 'owner review only',
    valid_from: NOW,
    positive_example: 'marked endpoint',
    no_known_exception: 'none recorded',
  }
  const roles: Array<import('../../src/types.js').ComponentRole> = [
    'directive', 'modality', 'subject_scope', 'task_or_output_scope', 'authority_source',
    'override_policy', 'valid_from', 'positive_example', 'no_known_exception',
  ]
  const components = roles.map(role => ({
    role,
    content: role === 'positive_example' || role === 'no_known_exception'
      ? `${content[role]} ${keywords}`
      : content[role] ?? `${role} evidence-bound content`,
  }))
  return { kind: 'preference_policy', title, intent: `${title} preference`, components }
}

export function planInput(commandId: string, task: PlanningTaskInput): PlanTaskCommandInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(commandId, 'commandId'),
    correlationId: 'retrieval-test',
    causationId: null,
    issuedAt: NOW,
    sessionId: null,
    interaction: 'defer',
    confirmExternalModelProcessing: false,
    task,
  }
}

export function task(overrides: Partial<PlanningTaskInput> = {}): PlanningTaskInput {
  return {
    text: TASK_TEXT,
    workspaceRoot: null,
    targetExposure: 'local',
    mustUseExperience: false,
    riskClass: 'standard',
    requiredCapabilities: [],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
    ...overrides,
  }
}
