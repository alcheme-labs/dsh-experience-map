import { expect, it } from 'vitest'
import { retrievalFixture, planInput, task } from './fixtures/retrieval-fixture.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'

it('review R1: reviewed publication reaches durable Plan beyond recent cap', async () => {
 const f=await retrievalFixture(1)
 try {
  const old=await publishReviewedWorkflow(f.repository,f.actor,501,workflowDraft({title:'quasar neutron calibration',intent:'quasar neutron alignment'}))
  for(let i=0;i<2;i++) await publishReviewedWorkflow(f.repository,f.actor,502+i,workflowDraft({title:`orchard citrus pruning ${i}`,intent:`orchard citrus harvesting ${i}`}))
  const result=await f.service.plan(planInput('review-published',task({text:'quasar neutron calibration',requiredCapabilities:[]})),f.actor)
  const read=f.repository.getPlanningResult(result.planning.plan.usageId,f.actor)
  expect(read.matchSet.candidates.map(c=>c.experienceVersionId)).toContain(old.published.experienceVersionId)
  expect(JSON.stringify(read.plan)).toContain(old.published.experienceVersionId)
 } finally { await f.close() }
},60000)

it('review invariant: refuse a corrupted component before persisting a new Plan', async () => {
 const f=await retrievalFixture(32)
 try {
  await publishReviewedWorkflow(f.repository,f.actor,510,workflowDraft({title:'quasar neutron calibration',intent:'quasar neutron alignment'}))
  await f.database.write(h=>h.prepare("UPDATE component_revisions SET content_text = 'quasar neutron UNREVIEWED_CHANGED_CONTENT'").run())
  expect(()=>f.repository.listPlanningVersions(f.actor,32)).toThrow()
  const result = await f.service.plan(planInput('review-corruption',task({text:'quasar neutron calibration',requiredCapabilities:[]})),f.actor).then(value=>({accepted:true as const,value}),error=>({accepted:false as const,code:error.code}))
  if(result.accepted) console.log('CORRUPTED_PLAN_READBACK',JSON.stringify(f.repository.getPlanningResult(result.value.planning.plan.usageId,f.actor).plan))
  expect(result.accepted).toBe(false)
 } finally { await f.close() }
},60000)
