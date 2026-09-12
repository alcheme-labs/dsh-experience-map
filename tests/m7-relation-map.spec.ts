import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type { ActorView, DeclareExperienceRelationInput } from '../src/types.js'
import { envelope } from './fixtures/m5-usage.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M7 rebuildable relation map and storage readiness', () => {
  it('projects canonical relations with explicit causal status and rebuilds identically after restart', async () => {
    const state = await open()
    const left = await publishReviewedWorkflow(state.repository, state.actor, 1_400, workflowDraft({
      title: 'Upstream condition diagnostic', intent: 'Establish the upstream condition.',
    }))
    const right = await publishReviewedWorkflow(state.repository, state.actor, 1_401, workflowDraft({
      title: 'Downstream effect diagnostic', intent: 'Verify the downstream effect.',
    }))
    const leftVersion = state.repository.getVersion(left.published.experienceVersionId!, state.actor)
    const rightVersion = state.repository.getVersion(right.published.experienceVersionId!, state.actor)
    const leftComponent = leftVersion.components[0]!
    const rightComponent = rightVersion.components[0]!
    const receipt = await state.repository.declareRelation({
      ...envelope(),
      relationType: 'causal_candidate',
      sourceObjectRef: { kind: 'component', id: leftComponent.componentId },
      targetObjectRef: { kind: 'component', id: rightComponent.componentId },
      scope: { workspace: 'deepseek-harness' },
      qualifiers: {
        mechanism: 'The first Version may change the conditions used by the second.',
        applicabilityCondition: 'Both Versions are selected for the same task.',
        competingExplanation: 'The observed ordering may be incidental.',
        causalGrade: 'observation_supported',
      },
      validFrom: '2026-09-03T00:00:00.000Z',
      validTo: null,
      evidenceIds: leftComponent.evidenceIds,
    } satisfies DeclareExperienceRelationInput, state.actor)
    const map = state.repository.getRelationMap(state.actor)
    expect(map.edges).toEqual([expect.objectContaining({
      relationId: receipt.relationId,
      relationType: 'causal_candidate',
      causalStatus: 'candidate',
      causalGrade: 'observation_supported',
    })])
    expect(map.nodes).toHaveLength(2)
    expect(map.textFallback[0]).toContain('causal_candidate/active')

    await state.database.close()
    const database = await ExperienceDatabase.open({
      databasePath: join(state.directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
      busyTimeoutMs: 50, maxPendingWrites: 8,
    })
    const repository = new ExperienceRepository(database)
    const principal = await repository.initializePrincipal()
    const actor = new ActorResolver(principal).resolve({ kind: 'management-cli' })
    const rebuilt = repository.getRelationMap(actor)
    expect(rebuilt.generationDigest).toBe(map.generationDigest)
    expect(rebuilt.nodes).toEqual(map.nodes)
    expect(rebuilt.edges).toEqual(map.edges)
    await database.close()
  })

  it('records current evidence honestly and cannot turn one local query into graph migration readiness', async () => {
    const state = await open()
    expect(state.repository.getInfrastructureReadiness(state.actor)).toMatchObject({
      contract: {
        currentStore: 'sqlite', minimumObservationCoverage: 30,
        approverPolicy: 'architecture_review',
      },
      latestEvaluation: null,
      decision: 'not_ready',
    })
    const input = {
      ...envelope(),
      commandId: brandedId<'ExperienceCommandId'>('m7-readiness-one-query', 'commandId'),
    }
    const receipt = await state.repository.evaluateInfrastructureReadiness(input, state.actor)
    expect(state.repository.getReceipt(receipt.receiptId, state.actor)).toEqual(receipt)
    expect(state.repository.getInfrastructureReadiness(state.actor)).toMatchObject({
      decision: 'not_ready',
      latestEvaluation: {
        latencyAndScaleMetrics: { sampleCount: 1 },
        queryObservationRefs: [],
        currentStoreFailureRefs: [],
        consistencyAssessment: 'not_evaluated',
        rollbackEvidenceRefs: [],
        signals: {
          measured_query_bottleneck: false,
          stable_multi_hop_demand: false,
          rebuild_and_rollback_proven: false,
        },
        blockers: ['measured_query_bottleneck', 'stable_multi_hop_demand', 'rebuild_and_rollback_proven'],
      },
    })
    const replay = await state.repository.evaluateInfrastructureReadiness(input, state.actor)
    expect(replay).toEqual(receipt)
    await state.database.close()
  })
})

async function open(): Promise<{
  directory: string
  database: ExperienceDatabase
  repository: ExperienceRepository
  actor: ActorView
}> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m7-relation-map-'))
  cleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 50, maxPendingWrites: 8,
  })
  const repository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  return { directory, database, repository,
    actor: new ActorResolver(principal).resolve({ kind: 'management-cli' }) }
}
