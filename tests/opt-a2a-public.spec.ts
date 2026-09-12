import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fingerprintTask, matchExperiences } from '../src/domain/planning.js'
import { matchExperiences as baselineMatch } from '../handoff/oracle-planning.js'
import { retrievalFixture, task, planInput, NOW } from './fixtures/retrieval-fixture.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'

// Synthetic source-bound diagnostic, published through the reviewed repository path.
async function withPublished(title: string, intent: string, check: (f: Awaited<ReturnType<typeof retrievalFixture>>, id: string) => Promise<void>) {
  const f = await retrievalFixture(32)
  try {
    const published = await publishReviewedWorkflow(f.repository, f.actor, 801, workflowDraft({title, intent}))
    expect(published.published.experienceVersionId).not.toBeNull()
    await check(f, published.published.experienceVersionId!)
  } finally { await f.close() }
}

describe('OPT-A2a frozen public contract', () => {
  it('finds startup intent in an unspaced Chinese task without altering direct input', async () => {
    const f = await retrievalFixture(32)
    try {
      const input = task({text:'帮我修复启动失败的问题'})
      const actual = fingerprintTask(input, f.actor, NOW)
      expect(actual.taskText).toBe(input.text)
      expect(actual.taskFamily).toBe('application_startup')
      expect(actual.capabilities).toContain('启动')
    } finally { await f.close() }
  })

  it.each([
    ['证书 过期', '证书 过期', '请检查证书过期的问题'],
    ['CERT_EXPIRED TLS', 'CERT_EXPIRED TLS', 'ＣＥＲＴ＿ＥＸＰＩＲＥＤ ＴＬＳ'],
    ['ＣＥＲＴ＿ＥＸＰＩＲＥＤ ＴＬＳ', 'ＣＥＲＴ＿ＥＸＰＩＲＥＤ ＴＬＳ', 'cert_expired tls'],
  ])('recalls reviewed %s into durable Plan from %s / %s', async (title, intent, text) => {
    await withPublished(title, intent, async (f, id) => {
      const result = await f.service.plan(planInput(randomUUID(), task({text})), f.actor)
      expect(result.planning.matchSet.candidates.map(c => c.experienceVersionId)).toContain(id)
      expect(result.planning.plan.selectedContributions.some(c => c.experienceVersionId === id)).toBe(true)
      const readback = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor)
      expect(readback.plan.selectedContributions.some(c => c.experienceVersionId === id)).toBe(true)
      expect(readback.fingerprint.taskText).toBe(text)
      expect(readback.matchSet.candidates.find(c => c.experienceVersionId === id)?.title).toBe(title)
    })
  })

  it('does not match unrelated Chinese text', async () => {
    await withPublished('证书 过期', '证书 过期', async (f) => {
      const result = await f.service.plan(planInput(randomUUID(), task({text:'调整花园植物的浇水周期'})), f.actor)
      expect(result.planning.matchSet.noMatch).toBe(true)
      expect(result.planning.plan.selectedContributions).toEqual([])
    })
  })

  it('keeps exact identifiers whole; a shared socket word cannot match a different code', async () => {
    await withPublished('EADDRINUSE socket', 'EADDRINUSE socket', async (f, id) => {
      const versions = f.repository.listPlanningVersions(f.actor,32)
      const exact = matchExperiences(fingerprintTask(task({text:'eaddrinuse socket'}),f.actor,NOW),versions,32,NOW)
      const different = matchExperiences(fingerprintTask(task({text:'EADDRNOTAVAIL socket'}),f.actor,NOW),versions,32,NOW)
      expect(exact.candidates.map(c=>c.experienceVersionId)).toContain(id)
      expect(different.noMatch).toBe(true)
    })
  })

  it('preserves ASCII baseline matching and deterministic ordering', async () => {
    await withPublished('TLS certificate expired', 'TLS certificate diagnosis', async f => {
      const versions = f.repository.listPlanningVersions(f.actor,32)
      for (const text of ['TLS certificate expired','write poetry','TLS','tls certificate']) {
        const fp = fingerprintTask(task({text}),f.actor,NOW)
        const actual = matchExperiences(fp,versions,32,NOW)
        expect(actual.candidates).toEqual(baselineMatch(fp,versions,32,NOW).candidates)
        expect(matchExperiences(fp,[...versions].reverse(),32,NOW).candidates).toEqual(actual.candidates)
      }
    })
  })
})
