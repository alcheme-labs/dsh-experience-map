import { expect,it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { retrievalFixture,diagnosticSpec,planInput,task } from './fixtures/retrieval-fixture.js'
import { seedVersions } from './fixtures/store-seed.js'

it('review R3: another connection retiring a scanned row must not skip untouched oldest candidate',async()=>{
 const f=await retrievalFixture(1)
 let writer:DatabaseSync|undefined
 try {
  const versions=await seedVersions(f.database,f.actor,Array.from({length:129},(_,i)=>({...diagnosticSpec(i===0?'quasar neutron calibration':'orchard citrus pruning','independent scope',i===0?'quasar neutron calibration':'orchard citrus pruning'),createdAt:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString()})))
  writer=new DatabaseSync(f.database.path)
  const original=f.repository.listMatchingVersions.bind(f.repository)
  // Deterministic interleaving of an external connection write after page 1 is read.
  f.repository.listMatchingVersions=function*(actor){
   let first=true
   for(const v of original(actor)){
    if(first){first=false;writer!.prepare("UPDATE experience_series SET lifecycle_projection='retired' WHERE experience_id=?").run(v.experienceId)}
    yield v
   }
  }
  const result=await f.service.plan(planInput('page-concurrency',task({text:'quasar neutron calibration',requiredCapabilities:[]})),f.actor)
  console.log('PAGE_READBACK',JSON.stringify({expected:versions[0]!.experienceVersionId,actual:result.planning.matchSet.candidates.map(c=>c.experienceVersionId)}))
  expect(result.planning.matchSet.candidates.map(c=>c.experienceVersionId)).toContain(versions[0]!.experienceVersionId)
 }finally{writer?.close();await f.close()}
})
