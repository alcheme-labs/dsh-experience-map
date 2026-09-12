import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fingerprintTask, matchExperiences, registeredFailureSignatures } from '../src/domain/planning.js'
import { retrievalFixture, task, planInput, NOW } from './fixtures/retrieval-fixture.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'
import type { ComponentRole } from '../src/types.js'

// Synthetic diagnostic source; genuine reviewed publication and SQLite Plan readback.
async function checkCase(title: string, text: string, selected: boolean, signal?: string, signalRole: ComponentRole = 'symptom_signature') {
  const f = await retrievalFixture(32)
  try {
    const draft = workflowDraft({title, intent:title})
    const components = draft.components.map(c => c.role === signalRole && signal !== undefined ? {...c,content:signal} : c)
    const published = await publishReviewedWorkflow(f.repository,f.actor,901,{...draft,components})
    const id = published.published.experienceVersionId!
    const input = task({text,requiredCapabilities:[]})
    const result = await f.service.plan(planInput(randomUUID(),input),f.actor)
    const readback = f.repository.getPlanningResult(result.planning.plan.usageId,f.actor)
    expect(readback.plan.selectedContributions.some(c=>c.experienceVersionId===id)).toBe(selected)
    expect(readback.fingerprint.taskText).toBe(text)
    expect(readback.matchSet.retrievalVersion).toBe('bounded-structural-lexical-v1')
    const versions = f.repository.listPlanningVersions(f.actor,32)
    const fp = fingerprintTask(input,f.actor,NOW)
    expect(matchExperiences(fp,versions,32,NOW).candidates).toEqual(readback.matchSet.candidates)
    expect(matchExperiences(fp,[...versions].reverse(),32,NOW).candidates).toEqual(readback.matchSet.candidates)
    const candidate=readback.matchSet.candidates.find(c=>c.experienceVersionId===id)
    if (candidate) expect(candidate.title).toBe(title)
    return {candidate,preflights:readback.preflights}
  } finally {await f.close()}
}

describe('OPT-A2b finite lexical aliases and explicit symptom-code guard',()=>{
  it.each([
    ['certificate expired','证书过期'],
    ['证书过期','certificate expired'],
    ['certificate timeout','证书超时'],
    ['证书超时','ＣＥＲＴＩＦＩＣＡＴＥ ＴＩＭＥＯＵＴ'],
  ])('recalls %s from %s into durable Plan',async(title,text)=>{await checkCase(title,text,true)})

  it('does not double count one alias group to satisfy two-token overlap',async()=>{
    await checkCase('certificate 证书','certificate 证书',false)
  })
  it('does not conflate authentication and authorization',async()=>{
    await checkCase('authentication certificate','authorization 证书',false)
  })
  it('matches one exact symptom code without needing another generic word',async()=>{
    await checkCase('network diagnostic','EADDRINUSE',true,'EADDRINUSE')
  })
  it('blocks different explicit symptom codes despite shared words',async()=>{
    const r=await checkCase('socket service failure','EADDRNOTAVAIL socket service failure',false,'EADDRINUSE socket service failure')
    expect(r.candidate?.rejected).toBe(true)
    expect(r.candidate?.selectedComponentRevisionIds).toEqual([])
    expect(r.candidate?.reasonCodes).toContain('exact_signal_conflict')
    expect(r.preflights.some(p=>p.disposition==='blocked' && p.blockers.includes('exact_signal_conflict'))).toBe(true)
  })
  it('keeps matching exact code with the same generic symptom',async()=>{
    await checkCase('socket service failure','EADDRINUSE socket service failure',true,'EADDRINUSE socket service failure')
  })
  it('does not use a misleading signal as a positive symptom-code constraint',async()=>{
    await checkCase('socket service failure','EADDRNOTAVAIL socket service failure',true,'EADDRINUSE','misleading_signal')
  })
  it('does not substring-match a code inside a longer identifier',async()=>{
    await checkCase('network diagnostic','MY_EADDRINUSE_WRAPPER',false,'EADDRINUSE')
  })
  it('recognizes only registered whole failure signatures for runtime re-recall',()=>{
    expect(registeredFailureSignatures('listen EADDRINUSE and HTTP 404')).toEqual(['eaddrinuse', '404'])
    expect(registeredFailureSignatures('exit_code_1 generic tool failure')).toEqual([])
    expect(registeredFailureSignatures('MY_EADDRINUSE_WRAPPER')).toEqual([])
  })
  it('keeps generic no-code matching unchanged',async()=>{
    await checkCase('socket service failure','socket service failure',true)
  })
})
