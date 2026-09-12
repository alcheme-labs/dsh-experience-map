import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type { ActorView } from '../src/types.js'
import { prepareAcceptedWorkflow, publishReviewedWorkflow, workflowCommand } from './fixtures/published-workflow.js'
import {
  eligibleExtraction,
  episodeRef,
  proposalMetadata,
  proposeInput,
  sourceRef,
  typedWorkflowDraft,
  workflowDraft,
} from './fixtures/workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M7 learning governance', () => {
  it('starts every capability in shadow and keeps an empty evaluation inconclusive', async () => {
    const state = await open()
    const governance = state.repository.getLearningGovernance(state.actor)
    expect(governance.contracts).toHaveLength(6)
    expect(governance.capabilities.every(item => item.currentLevel === 'shadow')).toBe(true)

    const receipt = await state.repository.evaluateUnlockContract({
      ...envelope('empty-evaluation'), capability: 'merge',
    }, state.actor)
    expect(state.repository.getReceipt(receipt.receiptId, state.actor)).toEqual(receipt)
    const evaluated = state.repository.getLearningGovernance(state.actor)
    expect(evaluated.evaluations.at(-1)).toMatchObject({
      capability: 'merge', outcome: 'inconclusive', sampleCoverage: 0,
      shadowPredictionIds: [], humanLabelIds: [], outcomeLabelIds: [],
    })
    await expect(state.repository.changeAutomationLevel({
      ...envelope('empty-promotion'), capability: 'merge', action: 'promote', targetLevel: 'suggest',
      evaluationId: receipt.evaluationId, reason: 'must remain blocked', violationClass: 'none',
    }, state.actor)).rejects.toMatchObject({ code: 'invalid_command' })
    await state.database.close()
  })

  it('requires a frozen passed evaluation for suggest and demotes immediately on a safety violation', async () => {
    const state = await open()
    for (let seed = 0; seed < 4; seed++) {
      await prepareAcceptedWorkflow(state.repository, state.actor, 800 + seed)
    }
    await createRejectedExtraction(state.repository, state.actor, 900)
    await drain(state.repository)

    const evaluationReceipt = await state.repository.evaluateUnlockContract({
      ...envelope('passing-evaluation'), capability: 'extraction',
    }, state.actor)
    const evaluation = state.repository.getLearningGovernance(state.actor).evaluations.at(-1)!
    expect(evaluation).toMatchObject({
      outcome: 'passed', sampleCoverage: 5,
      metricResults: { humanAgreementRate: 0.8, outcomeSuccessRate: null },
      negativeClassCoverage: ['human_rejection_or_failed_outcome'],
    })
    const promoted = await state.repository.changeAutomationLevel({
      ...envelope('promote-suggest'), capability: 'extraction', action: 'promote', targetLevel: 'suggest',
      evaluationId: evaluationReceipt.evaluationId, reason: 'bounded evaluation passed', violationClass: 'none',
    }, state.actor)
    expect(promoted.action).toBe('automation.promote')
    expect(state.repository.getLearningGovernance(state.actor).capabilities
      .find(item => item.capability === 'extraction')).toMatchObject({ currentLevel: 'suggest', policyRevision: 2 })

    const demoted = await state.repository.changeAutomationLevel({
      ...envelope('demote-safety'), capability: 'extraction', action: 'demote', targetLevel: 'shadow',
      evaluationId: null, reason: 'safety invariant violated', violationClass: 'safety',
    }, state.actor)
    expect(demoted.action).toBe('automation.demote')
    expect(state.repository.getLearningGovernance(state.actor).capabilities
      .find(item => item.capability === 'extraction')).toMatchObject({ currentLevel: 'shadow', policyRevision: 3 })
    await state.database.close()
  })

  it('rejects a previously passed evaluation after the exact learning sample changes', async () => {
    const state = await open()
    for (let seed = 0; seed < 4; seed++) await prepareAcceptedWorkflow(state.repository, state.actor, 1_000 + seed)
    await createRejectedExtraction(state.repository, state.actor, 1_100)
    await drain(state.repository)
    const receipt = await state.repository.evaluateUnlockContract({
      ...envelope('stale-evaluation'), capability: 'extraction',
    }, state.actor)
    await prepareAcceptedWorkflow(state.repository, state.actor, 1_200)
    await drain(state.repository)
    await expect(state.repository.changeAutomationLevel({
      ...envelope('stale-promotion'), capability: 'extraction', action: 'promote', targetLevel: 'suggest',
      evaluationId: receipt.evaluationId, reason: 'sample changed', violationClass: 'none',
    }, state.actor)).rejects.toMatchObject({ code: 'invalid_command' })
    await state.database.close()
  })

  it('records a reviewed retained causal candidate as a negative promotion label', async () => {
    const state = await open()
    const published = await publishReviewedWorkflow(
      state.repository, state.actor, 1_300, typedWorkflowDraft('causal'),
    )
    const version = state.repository.getVersion(published.published.experienceVersionId!, state.actor)
    const source = version.components[0]!
    const target = version.components[1]!
    await state.repository.declareRelation({
      ...envelope('causal-candidate'),
      relationType: 'causal_candidate',
      sourceObjectRef: { kind: 'component', id: source.componentId },
      targetObjectRef: { kind: 'component', id: target.componentId },
      scope: { workspace: 'deepseek-harness' },
      qualifiers: {
        mechanism: 'The observed setup changes the state read by the later check.',
        applicabilityCondition: 'The same workspace and configuration are used.',
        competingExplanation: 'Configuration drift may explain the result.',
        causalGrade: 'observation_supported',
      },
      validFrom: '2026-09-03T00:00:00.000Z',
      validTo: null,
      evidenceIds: source.evidenceIds,
    }, state.actor)
    await drain(state.repository)

    const row = state.repository.getLearningProjection(state.actor).rows
      .find(item => item.capability === 'causal_promotion')!
    expect(row.prediction).toMatchObject({ eligibleForPromotion: false })
    expect(row.humanLabels).toEqual([
      expect.objectContaining({ decision: 'retained_candidate' }),
    ])
    expect(row.observedOutcomes).toEqual([])
    await state.database.close()
  })
})

async function createRejectedExtraction(
  repository: ExperienceRepository,
  actor: ActorView,
  seed: number,
): Promise<void> {
  const proposed = await repository.proposeCandidate(
    proposeInput(`negative-${String(seed)}`), workflowDraft(), [episodeRef], [sourceRef], proposalMetadata,
    eligibleExtraction, actor, 16_384,
  )
  let candidate = repository.getCandidate(proposed.candidateId, actor)
  const submitted = await repository.submitCandidate(workflowCommand(candidate, 20, seed), actor)
  candidate = repository.getCandidate(submitted.candidateId, actor)
  for (const [index, field] of candidate.fields.entries()) {
    const decided = await repository.decideCandidateField({
      ...workflowCommand(candidate, 21 + index, seed),
      field: field.field,
      decision: index === 0 ? 'reject' : 'accept',
      reason: index === 0 ? 'wrong experience kind' : 'source checked',
    }, actor, 16_384)
    candidate = repository.getCandidate(decided.candidateId, actor)
  }
}

async function drain(repository: ExperienceRepository): Promise<void> {
  while (true) {
    const now = new Date()
    const claimed = await repository.claimLearningOutbox(
      now.toISOString(), new Date(now.getTime() + 30_000).toISOString(), 64)
    if (claimed.length === 0) return
    await repository.commitLearningProjection(claimed)
  }
}

function envelope(seed: string) {
  return {
    commandId: brandedId<'ExperienceCommandId'>(seed, 'commandId'),
    correlationId: `m7-learning-${seed}`,
    causationId: null,
    issuedAt: '2026-09-03T00:00:00.000Z',
  }
}

async function open(): Promise<{
  database: ExperienceDatabase
  repository: ExperienceRepository
  actor: ActorView
}> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m7-learning-'))
  cleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 50, maxPendingWrites: 8,
  })
  const repository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  return { database, repository, actor: new ActorResolver(principal).resolve({ kind: 'management-cli' }) }
}
