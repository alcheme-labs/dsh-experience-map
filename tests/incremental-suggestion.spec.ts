import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshSessionSource } from '../src/adapters/session-source.js'
import { DEFAULT_EXPERIENCE_PROJECTION_POLICY, ExperienceProjectionWorker } from '../src/application/experience-projection-worker.js'
import { ExperienceProjectionStore, type SuggestionSessionAnalysis } from '../src/persistence/projection-store.js'
import { suggestionDigest } from '../src/domain/automatic-suggestion.js'

const directories: string[] = []
const workers: ExperienceProjectionWorker[] = []
const stores: ExperienceProjectionStore[] = []
beforeEach(() => { vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-10-02T08:00:00Z')) })
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker=>worker.stop()))
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks(); vi.useRealTimers()
  await Promise.all(directories.splice(0).map(dir=>rm(dir,{recursive:true,force:true})))
})
async function database() {
  const dir = await mkdtemp(join(tmpdir(),'experience-incremental-')); directories.push(dir)
  const path = join(dir,'experience.sqlite')
  const store = await ExperienceProjectionStore.open(path); stores.push(store)
  return {store,path}
}
function log(id:string, age=0, end=1) {
  return {header:{version:SESSION_FORMAT_VERSION as typeof SESSION_FORMAT_VERSION,id:SessionId(id),createdAt:Date.now()-age,cwd:'/workspace',isSeeded:false},
    events:[{type:'turn/start',seq:0,time:Date.now(),data:{turn:1}},
      {type:'turn/end',seq:end,time:Date.now()+1,data:{turn:1,reason:{kind:'completed'}}}] as SessionEvent[], revision:'same'}
}
function sourceFixture(logs:ReturnType<typeof log>[]) {
  let identity = Symbol('provider')
  const readIds:string[]=[]
  const q = {
    listSessions: async ():Promise<SessionRecord[]> => logs.map(row=>({header:row.header,live:false,persisted:true})),
    observeSession: async (id:SessionId, options?:{signal?:AbortSignal}):Promise<SessionObservation> => {
      options?.signal?.throwIfAborted(); readIds.push(String(id))
      const row=logs.find(row=>row.header.id===id)!
      return {source:'prepared',header:row.header,events:row.events,cursor:row.events.at(-1)!.seq,
        inheritedEventCount:SessionLogOffset(0),revision:SessionPersistenceRevision(row.revision),
        retain:()=>{throw new Error('unused')},[Symbol.dispose]:()=>undefined}
    },
  }
  const persistence = {get identity(){return identity},
    list: async ()=>logs.map(row=>({header:row.header,revision:SessionPersistenceRevision(row.revision)}))} as unknown as SessionPersistence
  const make = () => new DshSessionSource(q,{maxRecords:64,maxRecordBytes:4096,maxTotalBytes:65536},()=>persistence)
  return {q,make,readIds,replaceProvider:()=>{identity=Symbol('replacement')}}
}
function worker(ctx:Context, source:DshSessionSource, store:ExperienceProjectionStore) {
  const result=new ExperienceProjectionWorker(ctx,source,store,DEFAULT_EXPERIENCE_PROJECTION_POLICY)
  workers.push(result); return result
}
async function abortable(signal:AbortSignal|undefined, started:()=>void) {
  signal?.throwIfAborted(); started()
  await new Promise<void>((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}))
}

describe('incremental Session learning through public source and SQLite owner',()=>{
  it('never enumerates or reads unobserved historical Sessions on startup, periodic maintenance or restart',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-02T08:00:00Z'))
    const {store,path}=await database();const fixture=sourceFixture(Array.from({length:100},(_,i)=>log(`history-${i}`,i)))
    const listed=vi.spyOn(fixture.q,'listSessions')
    const ctx=new Context();const first=worker(ctx,fixture.make(),store);first.install();await first.drain()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(listed).not.toHaveBeenCalled();expect(fixture.readIds).toEqual([])
    expect(store.read().history).toEqual({state:'complete',total:0,remaining:0})
    await first.stop();await ctx.fiber.dispose();store.close();stores.splice(stores.indexOf(store),1)
    const reopened=await ExperienceProjectionStore.open(path);stores.push(reopened)
    await worker(new Context(),fixture.make(),reopened).drain()
    expect(listed).not.toHaveBeenCalled();expect(fixture.readIds).toEqual([])
  })

  it('retains failed observed work for bounded retry without discovering other Sessions',async()=>{
    const {store}=await database();const fixture=sourceFixture([log('gone'),log('unobserved')])
    const listed=vi.spyOn(fixture.q,'listSessions')
    fixture.q.observeSession=async()=>{throw new Error('private source removed')}
    store.requestSession('gone',1);const w=worker(new Context(),fixture.make(),store)
    await w.drain();expect(store.nextSessionJob(Date.now())).toBeUndefined()
    expect(store.nextSessionJob(Date.now()+30_000)).toMatchObject({sessionId:'gone',completedEndSeqs:[1]})
    expect(listed).not.toHaveBeenCalled();expect(JSON.stringify(store.read())).not.toContain('private source removed')
  })

  it('resumes only persisted observed tasks after shutdown while excluding unobserved history',async()=>{
    const {store,path}=await database();const fixture=sourceFixture([log('history'),log('active')])
    const original=fixture.q.observeSession;const started=Promise.withResolvers<void>()
    fixture.q.observeSession=async(id,options)=>{await abortable(options?.signal,()=>started.resolve());return original(id,options)}
    const ctx=new Context();const first=worker(ctx,fixture.make(),store);first.install()
    ctx.emit('session/event',{id:SessionId('active')} as never,log('active').events[1]!)
    await started.promise;await first.stop();await ctx.fiber.dispose()
    expect(store.nextSessionJob(Date.now())).toMatchObject({sessionId:'active',completedEndSeqs:[1]})
    store.close();stores.splice(stores.indexOf(store),1)
    fixture.q.observeSession=original
    const reopened=await ExperienceProjectionStore.open(path);stores.push(reopened)
    await worker(new Context(),fixture.make(),reopened).drain()
    expect(fixture.readIds).toEqual(['active'])
    expect(reopened.nextSessionJob(Date.now())).toBeUndefined()
    expect(reopened.read().sessions.map(row=>row.sessionId)).toEqual(['active'])
  })

  it('acknowledges the exact request version, keeping a newer notification during a read pending',async()=>{
    const {store}=await database(); const fixture=sourceFixture([log('active')])
    const original=fixture.q.observeSession;const captured=Promise.withResolvers<void>();const release=Promise.withResolvers<void>()
    let first=true
    fixture.q.observeSession=async(id,options)=>{
      const snapshot=await original(id,options)
      if(first){first=false;captured.resolve();await release.promise}
      return snapshot
    }
    store.requestSession('active',1)
    const running=worker(new Context(),fixture.make(),store).drain()
    await captured.promise
    store.requestSession('active',3)
    release.resolve();await running
    expect(store.nextSessionJob(Date.now(),true)).toBeUndefined()
    expect(store.nextSessionJob(Date.now()+60_000)).toMatchObject({sessionId:'active',requestSeq:3,requestVersion:2})
    expect(store.read().history?.remaining).toBe(1)
    expect(store.read().sessions[0]?.capturedThroughSeq).toBe(1)
  })

  it('a failed observed task backs off without blocking a separate new task or exposing backend errors',async()=>{
    const {store}=await database();const fixture=sourceFixture([log('bad'),log('good'),log('history')])
    const original=fixture.q.observeSession
    fixture.q.observeSession=async(id,options)=>{if(String(id)==='bad')throw new Error('private backend secret');return original(id,options)}
    const ctx=new Context();const w=worker(ctx,fixture.make(),store);w.install()
    ctx.emit('session/event',{id:SessionId('bad')} as never,log('bad').events[1]!)
    await vi.waitFor(()=>expect(store.read().state).toBe('degraded'))
    ctx.emit('session/event',{id:SessionId('good')} as never,log('good').events[1]!)
    await vi.waitFor(()=>expect(store.read().sessions.map(row=>row.sessionId)).toEqual(['good']))
    expect(store.nextSessionJob(Date.now()+60_000)).toMatchObject({sessionId:'bad'})
    expect(fixture.readIds).toEqual(['good'])
    expect(JSON.stringify(store.read())).not.toContain('private backend secret')
    await ctx.fiber.dispose()
  })

  it('learns only notified turns in a reused old Session, retaining prior results across subsequent tasks',async()=>{
    const {store}=await database();const old=log('old',100*24*60*60_000)
    old.events.push({type:'turn/start',seq:SessionSeq(2),time:Date.now()+2,data:{turn:2}},
      {type:'turn/end',seq:3,time:Date.now()+3,data:{turn:2,reason:{kind:'completed'}}} as SessionEvent)
    const fixture=sourceFixture([old]);const ctx=new Context();const w=worker(ctx,fixture.make(),store);w.install()
    ctx.emit('session/event',{id:SessionId('old')} as never,old.events[3]!)
    await vi.waitFor(()=>expect(store.readSessionAnalyses()).toHaveLength(1))
    const first=store.readSessionAnalyses()[0]!
    expect(first.turnDigests).toHaveLength(1)
    old.events.push({type:'turn/start',seq:SessionSeq(4),time:Date.now()+4,data:{turn:3}},
      {type:'turn/end',seq:5,time:Date.now()+5,data:{turn:3,reason:{kind:'completed'}}} as SessionEvent)
    ctx.emit('session/event',{id:SessionId('old')} as never,old.events[5]!)
    await vi.waitFor(()=>expect(store.readSessionAnalyses()[0]?.turnDigests).toHaveLength(2))
    expect(fixture.readIds).toEqual(['old','old'])
    expect(store.readSessionAnalyses()[0]?.turnDigests).toContain(first.turnDigests[0])
    await ctx.fiber.dispose()
  })

  it('selects the recent eight only from observed Sessions and leaves other history unread',async()=>{
    const {store}=await database();const logs=Array.from({length:12},(_,i)=>log(`observed-${i}`))
    for(let i=0;i<logs.length;i++)logs[i]!.events[1]!.time=Date.now()+i
    const fixture=sourceFixture([...logs,log('unobserved')]);const listed=vi.spyOn(fixture.q,'listSessions')
    for(const row of logs)store.requestSession(String(row.header.id),1)
    await worker(new Context(),fixture.make(),store).drain()
    expect(store.read().sessions.map(row=>row.sessionId).sort()).toEqual(logs.slice(4).map(row=>String(row.header.id)).sort())
    expect(listed).not.toHaveBeenCalled();expect(fixture.readIds).toHaveLength(12)
    expect(fixture.readIds).not.toContain('unobserved')
  })

  it('rolls back progress acknowledgement with a failed generation and migrates v5 without losing published state or enqueuing history',async()=>{
    const {store,path}=await database()
    store.requestSession('active',1); const job=store.nextSessionJob(Date.now())!
    const analysis:SuggestionSessionAnalysis={scan:{sessionId:'active',workspaceRoot:null,sessionCreatedAt:new Date().toISOString(),
      lastEventAt:new Date().toISOString(),capturedThroughSeq:1,lastCompletedEndSeq:1,state:'no_suggestion',reason:null,occurrenceIds:[]},seeds:[],turnDigests:[]}
    const input={projectorVersion:'test',sourceWatermarkDigest:suggestionDigest(['active']),sessions:[analysis.scan],seeds:[],groups:[],
      startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),sessionCommit:{job,analysis,buildKey:'test',sourceKey:'token'}}
    const before=store.read()
    store.handle.exec("CREATE TRIGGER reject_generation BEFORE INSERT ON projection_generations BEGIN SELECT RAISE(ABORT,'generation blocked'); END")
    expect(()=>store.rebuild(input)).toThrow('generation blocked')
    expect(store.read()).toEqual(before)
    expect(store.nextSessionJob(Date.now())).toEqual(job)
    store.handle.exec('DROP TRIGGER reject_generation');store.rebuild(input)
    const published=store.read(); const retrieval=store.readRetrievalInternal()
    store.handle.exec('DROP TABLE suggestion_history; DROP TABLE suggestion_session_progress; PRAGMA user_version=5')
    store.close();stores.splice(stores.indexOf(store),1)
    const reopened=await ExperienceProjectionStore.open(path);stores.push(reopened)
    expect(reopened.handle.prepare('PRAGMA user_version').get()).toEqual({user_version:7})
    expect(reopened.read()).toEqual({...published,history:{state:'discovering',total:1,remaining:0}})
    expect(reopened.readSessionAnalyses()).toEqual([analysis])
    expect(reopened.readRetrievalInternal()).toEqual(retrieval)
    expect(reopened.handle.prepare('PRAGMA quick_check').get()).toEqual({quick_check:'ok'})
  })
})

// v6 was installed locally during diagnosis; its data must survive the additive notification migration.
describe('notification migration compatibility',()=>{
  it('preserves v6 derived results and retires only historical queue scheduling',async()=>{
    const {store,path}=await database()
    store.requestSession('observed',1)
    store.handle.prepare("INSERT INTO suggestion_session_progress(session_id,pending,urgent,request_seq,request_version,retry_at) VALUES('history',1,0,-1,0,0)").run()
    const before=store.read();const retrieval=store.readRetrievalInternal()
    store.handle.exec('ALTER TABLE suggestion_session_progress DROP COLUMN completed_end_seqs_json; PRAGMA user_version=6')
    store.close();stores.splice(stores.indexOf(store),1)
    const reopened=await ExperienceProjectionStore.open(path);stores.push(reopened)
    expect(reopened.read()).toEqual({...before,history:{...before.history,remaining:1}})
    expect(reopened.readRetrievalInternal()).toEqual(retrieval)
    expect(reopened.handle.prepare('PRAGMA user_version').get()).toEqual({user_version:7})
    worker(new Context(),sourceFixture([log('observed')]).make(),reopened)
    expect(reopened.nextSessionJob(Date.now())).toMatchObject({sessionId:'observed',completedEndSeqs:[1]})
    expect(reopened.handle.prepare("SELECT pending FROM suggestion_session_progress WHERE session_id='history'").get()).toEqual({pending:0})
    expect(reopened.handle.prepare('PRAGMA quick_check').get()).toEqual({quick_check:'ok'})
  })
})
