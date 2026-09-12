import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../src/application/actor-resolver.js'
import {
  assertContextInvariant,
  assertApprovalInvariant,
  assertComponentInvariant,
  assertEvidenceInvariant,
  assertMatchInvariant,
  assertPlanInvariant,
  assertPreflightInvariant,
  assertRevisionInvariant,
  assertSeriesInvariant,
  assertSettlementInvariant,
  assertStepProgressInvariant,
  assertUsageInvariant,
  assertVersionInvariant,
} from '../src/domain/invariants.js'
import { brandedId } from '../src/ids.js'
import { assertExperienceStoreInvariants } from '../src/invariant.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Experience-owned invariants', () => {
  it('accepts a complete canonical publication and rejects missing Version membership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-map-invariant-'))
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
    const actor = new ActorResolver(principal).resolve({ kind: 'management-cli' })
    const { published: receipt } = await publishReviewedWorkflow(repository, actor)
    expect(() => assertExperienceStoreInvariants(database.handle)).not.toThrow()
    database.handle.prepare(
      'DELETE FROM experience_version_components WHERE experience_version_id = ?',
    ).run(receipt.experienceVersionId)
    expect(() => assertExperienceStoreInvariants(database.handle)).toThrow(/membership/i)
    await database.close()
  })

  it('rejects ambiguous runtime and outcome records', () => {
    expect(() => assertMatchInvariant({
      matchSetId: 'match-1',
      candidates: [
        { experienceVersionId: brandedId<'ExperienceVersionId'>('v1', 'version'), eligible: true, reasons: ['scope'] },
        { experienceVersionId: brandedId<'ExperienceVersionId'>('v1', 'version'), eligible: false, reasons: ['privacy'] },
      ],
      createdAt: '2026-08-31T00:00:00.000Z',
    })).toThrow(/unique/i)
    expect(() => assertPreflightInvariant({
      preflightId: 'preflight-1',
      experienceVersionId: brandedId<'ExperienceVersionId'>('v1', 'version'),
      conditions: [{ key: 'build', result: 'true', observationRefs: [] }],
      createdAt: '2026-08-31T00:00:00.000Z',
    })).toThrow(/observations/i)
    expect(() => assertUsageInvariant({
      usageId: 'usage-1', matchSetId: null, activePlanId: null, settlementId: null,
      state: 'success', usageRevision: 1,
    })).toThrow(/Settlement/i)
    expect(() => assertSettlementInvariant({
      settlementId: 'settlement-1', usageId: 'usage-1', outcome: 'success',
      criteria: [{ criterionId: 'required', mandatory: true, result: 'fail', evidenceRefs: ['observation-1'] }],
    })).toThrow(/mandatory/i)
  })

  it('requires traceable Context and component-scoped Revision changes', () => {
    expect(() => assertContextInvariant({
      contextSnapshotId: 'context-1', usageId: 'usage-1', sectionDigests: [],
      sourceRefs: ['version-1'], contentDigest: 'digest',
    })).toThrow(/sections/i)
    const componentId = brandedId<'ExperienceComponentId'>('component-1', 'component')
    expect(() => assertRevisionInvariant({
      revisionProposalId: 'revision-1',
      experienceId: brandedId<'ExperienceId'>('experience-1', 'experience'),
      baseVersionId: brandedId<'ExperienceVersionId'>('version-1', 'version'),
      changes: [
        { componentId, replacementContent: 'a', sourceRefs: ['source-1'] },
        { componentId, replacementContent: 'b', sourceRefs: ['source-2'] },
      ],
      state: 'proposed',
    })).toThrow(/unique/i)
  })

  it('rejects incomplete immutable memory, planning, and cursor records', () => {
    const experienceId = brandedId<'ExperienceId'>('experience-1', 'experience')
    const versionId = brandedId<'ExperienceVersionId'>('version-1', 'version')
    const componentId = brandedId<'ExperienceComponentId'>('component-1', 'component')
    const revisionId = brandedId<'ExperienceComponentRevisionId'>('component-revision-1', 'revision')
    const evidenceId = brandedId<'ExperienceEvidenceId'>('evidence-1', 'evidence')
    expect(() => assertSeriesInvariant({
      experienceId, kind: 'diagnostic', currentVersionId: versionId, seriesRevision: 0,
      createdAt: '2026-08-31T00:00:00.000Z', lifecycleProjection: 'active',
    })).toThrow(/seriesRevision/i)
    expect(() => assertVersionInvariant({
      experienceVersionId: versionId, experienceId, versionNumber: 1, previousVersionId: null,
      title: 'title', intent: 'intent', scope: {}, validity: {}, authoritySpec: {},
      privacyClass: 'public', riskAndEffectSpec: {}, allowedUseModes: ['reference'],
      componentRevisionIds: [revisionId, revisionId],
      initialAssessmentId: brandedId<'ExperienceAssessmentId'>('assessment-1', 'assessment'),
      relationIds: [], contentDigest: 'digest', createdByDecisionId: 'decision-1',
      createdAt: '2026-08-31T00:00:00.000Z',
    })).toThrow(/unique/i)
    expect(() => assertComponentInvariant({
      componentId, experienceId, semanticRole: 'hypothesis',
      currentRevisionId: '' as never,
    })).toThrow(/currentRevisionId/i)
    expect(() => assertEvidenceInvariant({
      evidenceId, componentRevisionId: revisionId, claim: 'claim', sourceRefs: ['source'], direction: 'supports',
    }, {
      assessmentId: brandedId<'ExperienceAssessmentId'>('assessment-1', 'assessment'),
      experienceVersionId: versionId, grade: 'observation_supported', governanceState: 'accepted',
      operationalState: 'active', evidenceIds: [],
      decidedBy: brandedId<'ExperienceActorId'>('actor-1', 'actor'),
      decidedAt: '2026-08-31T00:00:00.000Z',
    })).toThrow(/assessed/i)
    expect(() => assertPlanInvariant({
      usagePlanId: 'plan-1', usageId: 'usage-1', planRevision: 1,
      selectedVersions: [versionId, versionId], orderedStepRefs: [],
      discardedContributions: [], planningBlockers: [],
    })).toThrow(/unique/i)
    expect(() => assertApprovalInvariant({
      requestId: 'approval-1', usagePlanId: 'plan-1', preflightIds: [],
      status: 'pending', validUntil: 'not-a-date',
    })).toThrow(/validUntil/i)
    expect(() => assertStepProgressInvariant({
      stepProgressId: 'progress-1', usageId: 'usage-1', controllerRevision: 0,
      stepRef: 'step-1', state: 'ready',
    })).toThrow(/controllerRevision/i)
  })
})
