import { expect, it } from 'vitest'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'
import { planInput, retrievalFixture, task } from './fixtures/retrieval-fixture.js'

it('rework source inconsistency: a source-ref change in storage never reaches a new Plan', async () => {
  const f = await retrievalFixture(32)
  try {
    await publishReviewedWorkflow(f.repository, f.actor, 620, workflowDraft({
      title: 'quasar neutron calibration', intent: 'quasar neutron alignment',
    }))
    // Change the persisted component source refs without updating the immutable payload/digest.
    await f.database.write(h => h.prepare("UPDATE component_revisions SET source_refs_json = '[]'").run())
    expect(() => f.repository.listPlanningVersions(f.actor, 32)).toThrow()
    const result = await f.service.plan(planInput('source-inconsistency', task({
      text: 'quasar neutron calibration', requiredCapabilities: [],
    })), f.actor).then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, code: error.code }))
    expect(result.accepted).toBe(false)
  } finally {
    await f.close()
  }
}, 60_000)
