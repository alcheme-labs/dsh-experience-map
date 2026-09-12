import {randomUUID} from 'node:crypto'
import {describe,it,expect} from 'vitest'
import {retrievalFixture,task,planInput} from './fixtures/retrieval-fixture.js'
import {publishReviewedWorkflow} from './fixtures/published-workflow.js'
import {workflowDraft} from './fixtures/workflow.js'

describe('OPT Host hard eligibility before Plan',()=>{
  it.each([
    ['mode', {allowedUseModes:['suggest']}, {requestedUseMode:'guided'}, false],
    ['mode allowed', {allowedUseModes:['suggest']}, {requestedUseMode:'suggest'}, true],
    ['workspace mismatch', {scope:{workspaceRoot:'/workspace/a'}}, {workspaceRoot:'/workspace/b'}, false],
    ['capability mismatch', {}, {requiredCapabilities:['kubernetes']}, false],
    ['partial capability', {}, {requiredCapabilities:['certificate','kubernetes']}, true],
    ['restricted local owner', {privacyClass:'restricted'}, {}, true],
  ] as const)('%s',async(_label,overrides,taskOverrides,selected)=>{
    const f=await retrievalFixture(5)
    try {
      const draft=workflowDraft({...overrides,allowedUseModes:'allowedUseModes' in overrides?[...overrides.allowedUseModes]:['reference','suggest','guided'],title:'certificate expired',intent:'certificate expired'})
      const pub=await publishReviewedWorkflow(f.repository,f.actor,902,draft)
      const input=task({text:'certificate expired',...taskOverrides,requiredCapabilities:'requiredCapabilities' in taskOverrides?[...taskOverrides.requiredCapabilities]:[]})
      const result=await f.service.plan(planInput(randomUUID(),input),f.actor)
      const back=f.repository.getPlanningResult(result.planning.plan.usageId,f.actor)
      expect(back.plan.selectedContributions.some(c=>c.experienceVersionId===pub.published.experienceVersionId)).toBe(selected)
    } finally {await f.close()}
  })
})
