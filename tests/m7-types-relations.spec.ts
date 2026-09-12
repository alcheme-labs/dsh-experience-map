import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { ExperiencePlanningService } from '../src/application/planning-service.js'
import { EXPERIENCE_KINDS } from '../src/domain/kind.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type {
  ActorView,
  DeclareExperienceRelationInput,
  ExperienceRelationObjectRef,
  ExperienceRelationType,
} from '../src/types.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { typedWorkflowDraft } from './fixtures/workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M7 typed Experience publication and canonical relations', () => {
  it('publishes all six source-bound kinds through the single Candidate and Version owner', async () => {
    const state = await open()
    for (const [index, kind] of EXPERIENCE_KINDS.entries()) {
      const result = await publishReviewedWorkflow(state.repository, state.actor, 700 + index, typedWorkflowDraft(kind))
      expect(state.repository.getVersion(result.published.experienceVersionId!, state.actor)).toMatchObject({
        kind,
        contentDigestSchema: 'v2-source-bound',
        governanceState: 'accepted',
      })
    }
    expect(state.repository.getStatus(state.actor).versionCount).toBe(6)
    await state.database.close()
  })

  it('persists queryable relations, derives Version relation ids, and keeps overrides scoped', async () => {
    const state = await open()
    const left = await publishReviewedWorkflow(state.repository, state.actor, 710, typedWorkflowDraft('procedure'))
    const right = await publishReviewedWorkflow(state.repository, state.actor, 711, typedWorkflowDraft('strategy'))
    const leftVersion = state.repository.getVersion(left.published.experienceVersionId!, state.actor)
    const rightVersion = state.repository.getVersion(right.published.experienceVersionId!, state.actor)
    const conflict = await state.repository.declareRelation(relationInput(
      1,
      'conflicts_with',
      { kind: 'version', id: leftVersion.experienceVersionId },
      { kind: 'version', id: rightVersion.experienceVersionId },
    ), state.actor)
    expect(state.repository.getRelation(conflict.relationId, state.actor)).toMatchObject({
      relationType: 'conflicts_with', status: 'active',
    })
    expect(state.repository.getVersion(leftVersion.experienceVersionId, state.actor).relationIds)
      .toContain(conflict.relationId)
    expect(state.repository.listRelations(
      { kind: 'version', id: rightVersion.experienceVersionId }, state.actor,
    ).map(item => item.relationId)).toContain(conflict.relationId)

    const override = await state.repository.createOverride({
      commandId: brandedId<'ExperienceCommandId'>('m7-override-1', 'commandId'),
      targetRelationId: conflict.relationId,
      replacementInstruction: 'Use the strategy only for the current local read-only analysis.',
      exactScope: { usageId: 'usage-m7-1' },
      validUntil: '2099-09-03T00:00:00.000Z',
      reason: 'The owner selected the narrower read-only branch.',
      correlationId: 'm7-relations',
      causationId: conflict.receiptId,
      issuedAt: '2026-09-03T00:00:00.000Z',
    }, state.actor)
    expect(state.repository.getOverride(override.overrideDecisionId!, state.actor)).toMatchObject({
      targetRelationId: conflict.relationId,
      exactScope: { usageId: 'usage-m7-1' },
      nonOverridableChecks: ['safety', 'permission', 'privacy', 'legal', 'task_requirement', 'unknown_side_effect'],
    })
    await state.database.close()
  })

  it('rejects cyclic ordering, relation contradictions, and ungrounded causal promotion', async () => {
    const state = await open()
    const published = await publishReviewedWorkflow(state.repository, state.actor, 720, typedWorkflowDraft('causal'))
    const version = state.repository.getVersion(published.published.experienceVersionId!, state.actor)
    const first = version.components[0]!
    const second = version.components[1]!
    await state.repository.declareRelation(relationInput(
      2,
      'precedes',
      { kind: 'component', id: first.componentId },
      { kind: 'component', id: second.componentId },
    ), state.actor)
    await expect(state.repository.declareRelation(relationInput(
      3,
      'precedes',
      { kind: 'component', id: second.componentId },
      { kind: 'component', id: first.componentId },
    ), state.actor)).rejects.toMatchObject({ code: 'composition_cycle' })

    await state.repository.declareRelation(relationInput(
      4,
      'conflicts_with',
      { kind: 'component', id: first.componentId },
      { kind: 'component', id: second.componentId },
    ), state.actor)
    await expect(state.repository.declareRelation(relationInput(
      5,
      'composes_with',
      { kind: 'component', id: second.componentId },
      { kind: 'component', id: first.componentId },
    ), state.actor)).rejects.toMatchObject({ code: 'invalid_command' })

    await expect(state.repository.declareRelation({
      ...relationInput(
        6,
        'causally_influences',
        { kind: 'component', id: first.componentId },
        { kind: 'component', id: second.componentId },
      ),
      qualifiers: {
        causalExperienceVersionId: version.experienceVersionId,
        assessmentId: version.initialAssessmentId,
      },
      evidenceIds: first.evidenceIds,
    }, state.actor)).rejects.toMatchObject({ code: 'invalid_command' })
    await state.database.close()
  })

  it('uses canonical precedence in a multi-Experience suggestion without requesting execution approval', async () => {
    const state = await open()
    const procedure = await publishReviewedWorkflow(state.repository, state.actor, 730, typedWorkflowDraft('procedure'))
    const strategy = await publishReviewedWorkflow(state.repository, state.actor, 731, typedWorkflowDraft('strategy'))
    const procedureVersion = state.repository.getVersion(procedure.published.experienceVersionId!, state.actor)
    const strategyVersion = state.repository.getVersion(strategy.published.experienceVersionId!, state.actor)
    const procedureStep = procedureVersion.components.find(component => component.role === 'step')!
    const strategyOption = strategyVersion.components.find(component => component.role === 'candidate_option')!
    const relation = await state.repository.declareRelation(relationInput(
      7,
      'precedes',
      { kind: 'component', id: procedureStep.componentId },
      { kind: 'component', id: strategyOption.componentId },
    ), state.actor)
    const planning = new ExperiencePlanningService(
      state.repository,
      { observe: async () => [] } as never,
      { ask: async () => ({ kind: 'no_provider', reason: 'unused' }) } as never,
      { retrievalCandidateLimit: 32, observationFreshnessMs: 300_000,
        planApprovalTtlMs: 1_800_000, maxPlanningTaskBytes: 32_768 },
      'deterministic',
    )
    const result = await planning.plan({
      commandId: brandedId<'ExperienceCommandId'>('m7-suggest-plan', 'commandId'),
      correlationId: 'm7-suggest', causationId: null, issuedAt: '2026-09-03T00:00:00.000Z',
      sessionId: null, interaction: 'defer', confirmExternalModelProcessing: false,
      task: {
        text: 'Use the procedure and strategy source-bound Experience for this task',
        workspaceRoot: null,
        targetExposure: 'local',
        mustUseExperience: true,
        riskClass: 'standard',
        requiredCapabilities: [],
        requestedUseMode: 'suggest',
        overrideDecisionIds: [],
      },
    }, state.actor)
    expect(result.planning.plan).toMatchObject({
      useMode: 'suggest',
      disposition: 'suggested',
      requiresApproval: false,
      selectedRelationIds: [relation.relationId],
    })
    const stepIds = result.planning.plan.orderedSteps.map(step => step.componentRevisionId)
    expect(stepIds.indexOf(procedureStep.componentRevisionId))
      .toBeLessThan(stepIds.indexOf(strategyOption.componentRevisionId))
    expect(result.planning.approvalRequest).toBeNull()
    await state.database.close()
  })
})

function relationInput(
  seed: number,
  relationType: ExperienceRelationType,
  sourceObjectRef: ExperienceRelationObjectRef,
  targetObjectRef: ExperienceRelationObjectRef,
): DeclareExperienceRelationInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(`m7-relation-${String(seed)}`, 'commandId'),
    relationType,
    sourceObjectRef,
    targetObjectRef,
    scope: { workspace: 'deepseek-harness' },
    qualifiers: relationType === 'causal_candidate'
      ? {
        mechanism: 'source-bound mechanism',
        applicabilityCondition: 'same workspace state',
        competingExplanation: 'unobserved configuration drift',
        causalGrade: 'observation_supported',
      }
      : {},
    validFrom: '2026-09-03T00:00:00.000Z',
    validTo: null,
    evidenceIds: [],
    correlationId: 'm7-relations',
    causationId: null,
    issuedAt: '2026-09-03T00:00:00.000Z',
  }
}

async function open(): Promise<{
  database: ExperienceDatabase
  repository: ExperienceRepository
  actor: ActorView
}> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m7-relations-'))
  cleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'),
    journalMode: 'wal',
    synchronous: 'normal',
    busyTimeoutMs: 50,
    maxPendingWrites: 8,
  })
  const repository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  return {
    database,
    repository,
    actor: new ActorResolver(principal).resolve({ kind: 'management-cli' }),
  }
}
