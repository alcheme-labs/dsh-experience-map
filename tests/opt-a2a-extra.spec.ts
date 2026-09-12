import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fingerprintTask, matchExperiences } from '../src/domain/planning.js'
import { retrievalFixture, task, planInput, NOW } from './fixtures/retrieval-fixture.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { sourceRef, workflowDraft } from './fixtures/workflow.js'

// Publish through the sole reviewed production path, then run against a real
// repository-backed planning service so these are production-entry checks and
// not direct assertions on the private tokenizer.
async function withPublished(
  title: string,
  intent: string,
  check: (f: Awaited<ReturnType<typeof retrievalFixture>>, id: string) => Promise<void>,
) {
  const f = await retrievalFixture(32)
  try {
    const published = await publishReviewedWorkflow(f.repository, f.actor, 801, workflowDraft({ title, intent }))
    expect(published.published.experienceVersionId).not.toBeNull()
    await check(f, published.published.experienceVersionId!)
  } finally {
    await f.close()
  }
}

describe('OPT-A2a extra normalization boundary', () => {
  it('keeps an adjacent ASCII error code whole next to Han text (a different code stays distinct)', async () => {
    await withPublished('EADDRINUSE 端口占用', 'EADDRINUSE 端口占用', async (f, id) => {
      const versions = f.repository.listPlanningVersions(f.actor, 32)
      const exact = matchExperiences(
        fingerprintTask(task({ text: '端口占用EADDRINUSE' }), f.actor, NOW),
        versions, 32, NOW,
      )
      expect(exact.candidates.map(c => c.experienceVersionId)).toContain(id)
      const different = matchExperiences(
        fingerprintTask(task({ text: '端口占用EADDRNOTAVAIL' }), f.actor, NOW),
        versions, 32, NOW,
      )
      expect(different.noMatch).toBe(true)
    })
  })

  it('normalization is idempotent: a full-width task and its NFKC/lower form reach the same match set', async () => {
    await withPublished('CERT_EXPIRED TLS', 'CERT_EXPIRED TLS', async (f, id) => {
      const versions = f.repository.listPlanningVersions(f.actor, 32)
      const full = matchExperiences(
        fingerprintTask(task({ text: 'ＣＥＲＴ＿ＥＸＰＩＲＥＤ ＴＬＳ' }), f.actor, NOW),
        versions, 32, NOW,
      )
      expect(full.candidates.map(c => c.experienceVersionId)).toContain(id)
      const normalized = matchExperiences(
        fingerprintTask(task({ text: 'cert_expired tls' }), f.actor, NOW),
        versions, 32, NOW,
      )
      expect(normalized.candidates.map(c => c.experienceVersionId)).toEqual(
        full.candidates.map(c => c.experienceVersionId),
      )
    })
  })

  it('does not rewrite the original task text, full-width title, or component content at the Plan read-back', async () => {
    const title = 'ＣＥＲＴ＿ＥＸＰＩＲＥＤ ＴＬＳ'
    const content = '证书过期 请检查证书'
    const draft = workflowDraft({
      title,
      intent: 'ＣＥＲＴ＿ＥＸＰＩＲＥＤ ＴＬＳ',
      components: ['symptom_signature', 'environment_scope', 'observed_fact', 'hypothesis',
        'discriminator', 'misleading_signal', 'branch', 'resolution_candidate', 'falsifier',
        'recovery_verifier'].map((role, index) => ({
        componentKey: `${role}-${String(index + 1)}`,
        role: role as import('../src/types.js').ComponentRole,
        content: role === 'symptom_signature' ? content : `${role} evidence-bound content`,
        sourceRefs: [sourceRef.sourceRefId],
      })),
    })
    const f = await retrievalFixture(32)
    try {
      const published = await publishReviewedWorkflow(f.repository, f.actor, 801, draft)
      const id = published.published.experienceVersionId!
      const text = 'cert_expired tls'
      const result = await f.service.plan(planInput(randomUUID(), task({ text })), f.actor)
      expect(result.planning.matchSet.candidates.map(c => c.experienceVersionId)).toContain(id)
      const readback = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor)
      expect(readback.fingerprint.taskText).toBe(text)
      expect(readback.matchSet.candidates.find(c => c.experienceVersionId === id)?.title).toBe(title)
      const preserved = readback.plan.selectedContributions.find(c => c.content === content)
      expect(preserved).toBeDefined()
      expect(preserved!.experienceVersionId).toBe(id)
    } finally {
      await f.close()
    }
  })
})
