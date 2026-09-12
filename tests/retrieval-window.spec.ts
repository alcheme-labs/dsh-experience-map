import { describe, expect, it } from 'vitest'
import { fingerprintTask } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type { ActorView, ExperienceVersionView } from '../src/types.js'
import { matchExperiences as frozenB0Match } from '../handoff/oracle-planning.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'
import { seedSupersedingVersion, seedVersion, seedVersions } from './fixtures/store-seed.js'
import {
  DISTRACTOR_KEYWORDS, NOW, PARTIAL_KEYWORDS, RELEVANT_KEYWORDS,
  diagnosticSpec, planInput, preferenceSpec, retrievalFixture, task,
} from './fixtures/retrieval-fixture.js'

// The full-corpus reference set read through the public listPlanningVersions.
const HUGE_LIMIT = 1_000_000
function allLegalVersions(repository: ExperienceRepository, actor: ActorView): ExperienceVersionView[] {
  return repository.listPlanningVersions(actor, HUGE_LIMIT)
}

function mixedCorpus(size: number): ReturnType<typeof diagnosticSpec>[] {
  // 2 relevant + 1 partial + 2 identical-scored (tie) + (size - 5) distractors.
  const distractors = Math.max(0, size - 5)
  return [
    diagnosticSpec('Deploy TLS protected public marketing site', 'Monitor CDN availability after deploy', RELEVANT_KEYWORDS),
    diagnosticSpec('Deploy a second TLS site behind CDN', 'Monitor availability for the second site', RELEVANT_KEYWORDS),
    diagnosticSpec('Deploy halves of the site behind TLS', 'Verify TLS during deployment', PARTIAL_KEYWORDS),
    diagnosticSpec('Identical tie experience alpha', 'Ties on the same keywords alpha', RELEVANT_KEYWORDS),
    diagnosticSpec('Identical tie experience beta', 'Ties on the same keywords beta', RELEVANT_KEYWORDS),
    ...Array.from({ length: distractors }, (_, i) => diagnosticSpec(
      `Unrelated corpus record ${i}`, `No task overlap ${i}`, DISTRACTOR_KEYWORDS)),
  ]
}

describe('OPT-A1 retrieval window (rework)', () => {
  it('R1: a real reviewed publication of an old relevant Experience enters the cap-limited MatchSet and readback', async () => {
    const f = await retrievalFixture(1)
    try {
      const old = await publishReviewedWorkflow(f.repository, f.actor, 501, workflowDraft({
        title: 'quasar neutron calibration', intent: 'quasar neutron alignment',
      }))
      for (let i = 0; i < 2; i++) {
        await publishReviewedWorkflow(f.repository, f.actor, 502 + i, workflowDraft({
          title: `orchard citrus pruning ${i}`, intent: `orchard citrus harvesting ${i}`,
        }))
      }
      const result = await f.service.plan(planInput('r1-real-published', task({
        text: 'quasar neutron calibration', requiredCapabilities: [],
      })), f.actor)
      const readback = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor)
      expect(readback.matchSet.candidates.map(c => c.experienceVersionId)).toContain(old.published.experienceVersionId)
      expect(JSON.stringify(readback.plan)).toContain(old.published.experienceVersionId)
      expect(result.planning.matchSet.candidates.length).toBeLessThanOrEqual(1)
    } finally {
      await f.close()
    }
  }, 60_000)

  it('R2: production candidates equal the frozen B0 oracle and cap at limit across N and scale', async () => {
    for (const size of [33, 129, 1000]) {
      const f = await retrievalFixture(32)
      try {
        await seedVersions(f.database, f.actor, mixedCorpus(size))
        const allVersions = allLegalVersions(f.repository, f.actor)
        expect(allVersions.length).toBeGreaterThanOrEqual(size)
        const fingerprint = fingerprintTask(task(), f.actor, NOW)
        for (const limit of [1, 2, 32]) {
          const oracle = frozenB0Match(fingerprint, allVersions, limit, NOW)
          const { matchSet } = f.repository.matchPlanningVersions(f.actor, fingerprint, limit, NOW)
          expect(matchSet.candidates.map(c => c.experienceVersionId))
            .toEqual(oracle.candidates.map(c => c.experienceVersionId))
          expect(matchSet.candidates.length).toBeLessThanOrEqual(limit)
          expect(matchSet.candidates.length).toBe(Math.min(limit, oracle.candidates.length))
        }
      } finally {
        await f.close()
      }
    }
  // This is a semantic equivalence gate across three corpus sizes, not a wall-clock
  // benchmark. Keep the 1,000-row coverage but allow slower release hosts to finish.
  }, 300_000)

  it('R2: no-match, a rejected local-scope version, and a same-time ID tie are stable against the oracle', async () => {
    const f = await retrievalFixture(32)
    try {
      const tieAlpha = await seedVersion(f.database, f.actor, diagnosticSpec(
        'Identical tie experience omega', 'Identical tie intent omega', RELEVANT_KEYWORDS))
      const tieBeta = await seedVersion(f.database, f.actor, diagnosticSpec(
        'Identical tie experience omega', 'Identical tie intent omega', RELEVANT_KEYWORDS))
      const local = await seedVersion(f.database, f.actor, {
        ...diagnosticSpec('Deploy the marketing site with TLS', 'Run the local calibration', RELEVANT_KEYWORDS),
        scope: { product: 'local-loopback', surface: 'localhost' },
      })

      const noMatchResult = await f.service.plan(planInput('r2-nomatch', task({
        text: 'translate a poem into italian', requiredCapabilities: [],
      })), f.actor)
      expect(noMatchResult.planning.matchSet.candidates).toHaveLength(0)
      expect(noMatchResult.planning.matchSet.noMatch).toBe(true)

      // Public-target task against a local-scope relevant version: matcher marks it rejected
      // (retaining the build check), and production must equal the frozen B0 oracle.
      const publicFp = fingerprintTask(task({ text: 'Deploy the marketing site', targetExposure: 'public', requiredCapabilities: [] }), f.actor, NOW)
      const all = allLegalVersions(f.repository, f.actor)
      const publicOracle = frozenB0Match(publicFp, all, 32, NOW)
      const publicProduced = f.repository.matchPlanningVersions(f.actor, publicFp, 32, NOW).matchSet
      expect(publicProduced.candidates.map(c => c.experienceVersionId))
        .toEqual(publicOracle.candidates.map(c => c.experienceVersionId))
      const localCandidate = publicProduced.candidates.find(c => c.experienceVersionId === local.experienceVersionId)
      if (localCandidate !== undefined) expect(localCandidate.rejected).toBe(true)

      // Same-time (same createdAt) ID tie pair is deterministic and oracle-stable.
      const tieFp = fingerprintTask(task({ text: 'Identical tie intent omega and identical keywords', requiredCapabilities: [] }), f.actor, NOW)
      const tieOracle = frozenB0Match(tieFp, all, 32, NOW)
      const tieProduced = f.repository.matchPlanningVersions(f.actor, tieFp, 32, NOW).matchSet
      expect(tieProduced.candidates.map(c => c.experienceVersionId)).toEqual(tieOracle.candidates.map(c => c.experienceVersionId))
      const tiePairInOracle = tieOracle.candidates.filter(c => c.experienceVersionId === tieAlpha.experienceVersionId
        || c.experienceVersionId === tieBeta.experienceVersionId).map(c => c.experienceVersionId)
      expect(tiePairInOracle).toHaveLength(2)
      expect(tiePairInOracle).toEqual(tiePairInOracle.slice().sort())
    } finally {
      await f.close()
    }
  }, 60_000)

  it('R3: query-only actor rejected; a Forget-retired version is never recalled', async () => {
    const f = await retrievalFixture(32)
    try {
      const relevant = await seedVersion(f.database, f.actor, diagnosticSpec(
        'quasar neutron calibration', 'quasar neutron alignment', RELEVANT_KEYWORDS))
      await seedVersion(f.database, f.actor, diagnosticSpec(
        'Unrelated corpus item', 'No task overlap', DISTRACTOR_KEYWORDS))

      const queryOnly: typeof f.actor = {
        ...f.actor,
        actorId: brandedId<'ExperienceActorId'>('agent-runtime', 'actorId'),
        kind: 'agent',
        authority: 'query_only',
      }
      await expect(f.service.plan(planInput('r3-denied', task({ text: 'quasar neutron calibration', requiredCapabilities: [] })), queryOnly))
        .rejects.toMatchObject({ code: 'principal_unauthorized' })

      const preview = f.repository.previewForget(relevant.experienceId, f.actor)
      await f.repository.forgetExperience({
        commandId: brandedId<'ExperienceCommandId'>('r3-forget', 'commandId'),
        experienceId: relevant.experienceId,
        expectedSeriesRevision: preview.expectedSeriesRevision,
        previewDigest: preview.previewDigest,
        reason: 'Stops recall for the retrieval-window test',
        correlationId: 'r3-forget',
        causationId: null,
        issuedAt: NOW,
      }, f.actor)
      const afterForget = await f.service.plan(planInput('r3-replan', task({ text: 'quasar neutron calibration', requiredCapabilities: [] })), f.actor)
      expect(afterForget.planning.matchSet.candidates.map(c => c.experienceVersionId)).not.toContain(relevant.experienceVersionId)
    } finally {
      await f.close()
    }
  }, 60_000)

  it('R3: a superseded (no longer current) version is not scanned or recalled', async () => {
    const f = await retrievalFixture(32)
    try {
      const old = await seedVersion(f.database, f.actor, diagnosticSpec(
        'quasar neutron calibration', 'quasar neutron alignment', RELEVANT_KEYWORDS))
      const newer = await seedSupersedingVersion(f.database, f.actor, old, diagnosticSpec(
        'quasar neutron calibration v2', 'quasar neutron alignment v2', RELEVANT_KEYWORDS))
      const scanIds = allLegalVersions(f.repository, f.actor).map(v => v.experienceVersionId)
      expect(scanIds).toContain(newer.experienceVersionId)
      expect(scanIds).not.toContain(old.experienceVersionId)
      const result = await f.service.plan(planInput('r3-superseded', task({ text: 'quasar neutron calibration', requiredCapabilities: [] })), f.actor)
      expect(result.planning.matchSet.candidates.map(c => c.experienceVersionId)).not.toContain(old.experienceVersionId)
    } finally {
      await f.close()
    }
  }, 60_000)

  it('R4: a scanned-but-not-selected preference never enforces; a selected preference still applies', async () => {
    const f = await retrievalFixture(32)
    try {
      const selected = await seedVersion(f.database, f.actor, preferenceSpec(
        'Deploy-site authenticated readback preference', 'must', RELEVANT_KEYWORDS))
      const notSelected = await seedVersion(f.database, f.actor, preferenceSpec(
        'Unrelated preference', 'prefer', DISTRACTOR_KEYWORDS))
      await seedVersions(f.database, f.actor, Array.from({ length: 6 }, (_, i) =>
        diagnosticSpec(`Unrelated corpus item ${i}`, `No task overlap ${i}`, DISTRACTOR_KEYWORDS)))

      const scannedIds = allLegalVersions(f.repository, f.actor).map(v => v.experienceVersionId)
      expect(scannedIds).toContain(notSelected.experienceVersionId)
      expect(scannedIds).toContain(selected.experienceVersionId)

      const result = await f.service.plan(planInput('r4-plan', task()), f.actor)
      const candidateIds = result.planning.matchSet.candidates.map(c => c.experienceVersionId)
      expect(candidateIds).toContain(selected.experienceVersionId)
      expect(candidateIds).not.toContain(notSelected.experienceVersionId)
      const enforcements = result.planning.plan.preferenceEnforcements
      expect(enforcements.map(v => v.experienceVersionId)).toContain(selected.experienceVersionId)
      expect(enforcements.map(v => v.experienceVersionId)).not.toContain(notSelected.experienceVersionId)
      expect(enforcements.find(v => v.experienceVersionId === selected.experienceVersionId))
        .toMatchObject({ modality: 'must', classification: 'pre_execution_blocking' })
    } finally {
      await f.close()
    }
  }, 60_000)

  it('R5: an identical command replays idempotently and the plan rereads identically after restart', async () => {
    const f = await retrievalFixture(32)
    try {
      await seedVersion(f.database, f.actor, diagnosticSpec(
        'Deploy TLS protected marketing site', 'Monitor CDN availability', RELEVANT_KEYWORDS))
      const input = planInput('r5-plan', task())
      const first = await f.service.plan(input, f.actor)
      const second = await f.service.plan(input, f.actor)
      expect(second.receipt.receiptId).toBe(first.receipt.receiptId)
      expect(second.planning.plan.usageId).toBe(first.planning.plan.usageId)
      const usageId = first.planning.plan.usageId
      const firstCandidateIds = first.planning.matchSet.candidates.map(c => c.experienceVersionId)
      const firstPlanDigest = first.planning.plan.contentDigest

      const path = f.database.path
      await f.database.close()
      const reopened = await ExperienceDatabase.open({
        databasePath: path, journalMode: 'wal', synchronous: 'normal',
        busyTimeoutMs: 1_000, maxPendingWrites: 16,
      })
      const reopenedRepository = new ExperienceRepository(reopened)
      const principalId = await reopenedRepository.initializePrincipal()
      const actor: typeof f.actor = {
        actorId: brandedId<'ExperienceActorId'>(principalId, 'actorId'),
        principalId, kind: 'management_local_owner', authority: 'owner',
      }
      const readback = reopenedRepository.getPlanningResult(usageId, actor)
      expect(readback.matchSet.candidates.map(c => c.experienceVersionId)).toEqual(firstCandidateIds)
      expect(readback.plan.contentDigest).toBe(firstPlanDigest)
      await reopened.close()
    } finally {
      await f.close()
    }
  }, 60_000)
})
