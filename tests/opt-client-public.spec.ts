import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {build} from 'esbuild'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'

const require=createRequire(import.meta.url)
const temp=mkdtempSync(join(tmpdir(),'opt-client-render-'))
let render:(stage:string,planning:unknown)=>string
beforeAll(async()=>{
  const source=readFileSync('src/client/workspace.tsx','utf8')
  await build({stdin:{contents:source+'\nexport { PlanningReadback as __reviewReadback }; export {zh as __reviewZh};',resolveDir:join(process.cwd(),'src/client'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',outfile:join(temp,'render.cjs'),jsx:'automatic',plugins:[{name:'test-runtime',setup(b){
    b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}))
    b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'review'}))
    b.onLoad({filter:/.*/,namespace:'review'},()=>({contents:'export const Button=({children})=>children;export const Pill=Button;export const StateDot=Button;export const IconCheckOutline14=()=>null;export const IconRefreshOutline14=()=>null;export const IconCloseOutline16=()=>null;export const IconPanelLeftOutline16=()=>null;',loader:'jsx'}))
    b.onLoad({filter:/\.css$/},()=>({contents:'export default {}',loader:'js'}))
  }}]})
  const mod=require(join(temp,'render.cjs')) as {__reviewReadback:(p:unknown)=>unknown;__reviewZh:Record<string,string>}
  const text=(node:unknown):string=>{
    if(node===null||node===undefined||typeof node==='boolean')return ''
    if(typeof node==='string'||typeof node==='number')return String(node)
    if(Array.isArray(node))return node.map(text).join(' ')
    const e=node as {type:unknown;props:{children?:unknown}}
    if(typeof e.type==='function')return text((e.type as (p:unknown)=>unknown)(e.props))
    return text(e.props?.children)
  }
  render=(stage,planning)=>text(mod.__reviewReadback({stage,planning,context:null,execution:null,t:(k:string)=>mod.__reviewZh[k]??k,store:{},running:false}))
})
afterAll(()=>rmSync(temp,{recursive:true,force:true}))
function sample(){return {fingerprint:{hardConstraints:[]},matchSet:{noMatch:false,candidates:[{experienceVersionId:'v1',title:'证书经验',reasonCodes:['lexical_match_only'],rejected:false,selectedComponentRevisionIds:['c1']}]},preflights:[{experienceVersionId:'v1',disposition:'adaptable',reasonCodes:[],blockers:[],observations:[{observationId:'o1',kind:'repository_state',status:'unknown',summary:'当前仓库尚未验证',reasonCode:'fs_provider_unavailable'}]}],plan:{disposition:'ready_for_approval',selectedContributions:[],orderedSteps:[]},approvalRequest:{status:'pending'}}}
describe('OPT Client real PlanningReadback output, no Browser claim',()=>{
  it('shows understandable recommendation reason instead of raw code',()=>{const html=render('match',sample());expect(html).not.toContain('lexical_match_only');expect(html).toMatch(/词项|关键词/);})
  it('shows next action and uncertainty with recommendation',()=>{const html=render('match',sample());expect(html).toMatch(/核对|适配|检查/);expect(html).toMatch(/尚未|未知|未验证/);})
  it('does not lose later candidates observations by using only preflights[0]',()=>{const p=sample();p.preflights.push({...p.preflights[0]!,experienceVersionId:'v2',observations:[{...p.preflights[0]!.observations[0]!,observationId:'o2',summary:'第二经验独有环境信息'}]});p.matchSet.candidates.push({...p.matchSet.candidates[0]!,experienceVersionId:'v2',title:'第二经验'});expect(render('preflight',p)).toContain('第二经验独有环境信息')})
  it('unknown reason code is not printed as if it explained applicability',()=>{const p=sample();p.matchSet.candidates[0]!.reasonCodes=['future_reason_unknown'];const html=render('match',p);expect(html).not.toContain('future_reason_unknown');expect(html).toMatch(/核对|未知|检查/)})
})
