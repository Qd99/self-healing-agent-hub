/** Pure contracts for advanced workbench. No outbound actions or task authorization. */
import { createHash } from "node:crypto";
import { HealingError } from "./console-store.mjs";
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const bad = (message="高级工作区参数无效。") => { throw new HealingError(400,"ADVANCED_INVALID",message); };
export const conflict = (message="记录状态已变化，请刷新。") => { throw new HealingError(409,"ADVANCED_CONFLICT",message); };
export const obj = v => { if (!v || typeof v !== "object" || Array.isArray(v)) bad(); return v; };
export const integer = (v,min,max) => { if (!Number.isSafeInteger(v)||v<min||v>max) bad(); return v; };
export const text = (v,max=160) => {
  if(typeof v!=="string"||!v.trim()||v.length>max||/[\r\n]/.test(v)||/(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+\S+|(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+)/i.test(v))bad();
  return v;
};
export const identifier = (v,max=120) => { if(typeof v!=="string"||v.length>max||!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v)||/gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}/i.test(v))bad();return v; };
export const hex = (v,n) => { if(typeof v!=="string"||v.length!==n||!/^[a-f0-9]+$/.test(v)||/^0+$/.test(v))bad();return v; };
export const one = (v,values) => { if(!values.includes(v))bad();return v; };
export const array = (v,max) => { if(!Array.isArray(v)||v.length>max)bad();return v; };
export const projectScope = project => JSON.stringify([project.id,project.repo]);
export const scopeText = (v,max=160) => { if(typeof v!=="string"||v.length>max)bad();return v; };
const stamp = v => { if(typeof v!=="string"||!Number.isFinite(Date.parse(v)))bad();return new Date(v).toISOString(); };
const optional = (v,fn) => v==null?null:fn(v);
const attrs = list => {
  const out=new Map();
  for(const a of array(list??[],100)){
    if(typeof a?.key!=="string")bad();
    // Only controlled IDs, not arbitrary span names, messages, prompts or attributes.
    if(["hub.workflow_id","hub.task_id","hub.agent_id","hub.stage","service.name"].includes(a.key)){
      if(out.has(a.key))bad();
      out.set(a.key,identifier(a.value?.stringValue,120));
    }
  }
  return out;
};
const nanos = v => {
  if(typeof v!=="string"||!/^[0-9]{1,20}$/.test(v))bad();
  const n=BigInt(v);
  if(n>BigInt(8640000000000000)*1000000n)bad();
  return n;
};
export function decodeOtlp(body, project, knownTasks=new Set()){
  obj(body);
  const result=[];
  for(const resource of array(body.resourceSpans,64)){
    const resourceAttrs=attrs(resource.resource?.attributes);
    for(const group of array(resource.scopeSpans,64)){
      for(const span of array(group.spans,128)){
        if(result.length>=128)bad("每批最多 128 条 span。");
        const a=attrs(span.attributes);
        const workflow=identifier(a.get("hub.workflow_id"));
        const task=a.get("hub.task_id")??null;
        if(task!==null&&!knownTasks.has(task))bad("任务不属于当前项目。");
        const traceId=hex(String(span.traceId??"").toLowerCase(),32),spanId=hex(String(span.spanId??"").toLowerCase(),16);
        const parent=span.parentSpanId?hex(String(span.parentSpanId).toLowerCase(),16):null;
        if(parent===spanId)bad();
        const start=nanos(span.startTimeUnixNano),end=nanos(span.endTimeUnixNano);
        if(end<start||end-start>86400000000000n)bad("span 时间无效。");
        const links=array(span.links??[],32).map(l=>({traceId:hex(String(l.traceId??"").toLowerCase(),32),spanId:hex(String(l.spanId??"").toLowerCase(),16)}));
        const stage=a.get("hub.stage")??"span";
        result.push({id:"otel:"+traceId+":"+spanId,project:projectScope(project),workflow,task,source:"otlp",agent:a.get("hub.agent_id")??resourceAttrs.get("service.name")??"unknown",stage,traceId,spanId,parentSpanId:parent,links,startMs:Number(start/1000000n),endMs:Number(end/1000000n),status:one(span.status?.code??0,[0,1,2]),partial:true});
      }
    }
  }
  if(!result.length)bad("没有可接收的 span。");
  return result;
}
export function workerEvent(project,task,lease,event,at){
  const attempt=digest(lease.id).slice(0,24);
  return {id:"worker:"+task+":"+attempt+":"+event.sequence,project:projectScope(project),workflow:task,task,source:"worker",agent:identifier(lease.workerId),stage:event.stage,attempt,sequence:event.sequence,phase:lease.phase,state:event.state,observedAt:at,...(event.durationMs===undefined?{}:{durationMs:event.durationMs}),...(event.usage?{usage:event.usage}:{}),...(event.resource?{resource:event.resource}:{})};
}
/** Explicit parent edges only. Links are separate causal edges, never inferred from time. */
export function graphFor(rows){
  const spans=rows.filter(x=>x.source==="otlp");
  const index=new Map(spans.map(x=>[x.traceId+":"+x.spanId,x]));
  const parents=[],links=[],missing=[];
  for(const x of spans){
    const to=x.traceId+":"+x.spanId;
    if(x.parentSpanId){const from=x.traceId+":"+x.parentSpanId;(index.has(from)?parents:missing).push({from,to,kind:"parent"});}
    for(const l of x.links){const from=l.traceId+":"+l.spanId;(index.has(from)?links:missing).push({from,to,kind:"link"});}
  }
  const incoming=new Map([...index.keys()].map(k=>[k,0])), children=new Map();
  for(const {from,to} of parents){incoming.set(to,incoming.get(to)+1);if(!children.has(from))children.set(from,[]);children.get(from).push(to);}
  const queue=[...incoming].filter(([,n])=>n===0).map(([k])=>k),ordered=[];
  while(queue.length){const k=queue.shift();ordered.push(k);for(const child of children.get(k)??[]){incoming.set(child,incoming.get(child)-1);if(!incoming.get(child))queue.push(child);}}
  return {nodes:spans,parents,links,missing,cycle:ordered.length!==index.size,order:ordered,completeness:"partial"};
}
export const resultStates=["pass","fail","skip","error","timeout","cancelled","unknown"];
export function normalizeRun(input){
  const v=obj(input);
  const results=array(v.results,2000).map(row=>{
    obj(row);
    return {id:identifier(row.id,160),result:one(row.result,resultStates),assertion:row.assertion===true,attempt:integer(row.attempt??1,1,100),durationMs:optional(row.durationMs,n=>integer(n,0,86400000))};
  });
  if(new Set(results.map(x=>x.id+":"+x.attempt)).size!==results.length)bad("重复用例尝试。");
  const start=stamp(v.startedAt),end=stamp(v.finishedAt);
  if(end<start||typeof v.clean!=="boolean"||typeof v.complete!=="boolean")bad();
  return {sha:hex(v.sha,40),tree:hex(v.tree,40),suiteDigest:hex(v.suiteDigest,64),environmentDigest:hex(v.environmentDigest,64),harnessDigest:hex(v.harnessDigest,64),testTreeDigest:optional(v.testTreeDigest,x=>hex(x,64)),startedAt:start,finishedAt:end,exitCode:optional(v.exitCode,n=>integer(n,0,255)),clean:v.clean,complete:v.complete,results};
}
export function compareRedGreen(base,candidate,binding){
  const unknown=reason=>({verdict:"unknown",reason}),deny=reason=>({verdict:"deny",reason});
  if(!base||!candidate||!binding)return unknown("缺少独立测试或候选绑定。");
  if(base.sha!==binding.baseSha||candidate.tree!==binding.treeSha||base.suiteDigest!==binding.suiteDigest||candidate.suiteDigest!==binding.suiteDigest||base.environmentDigest!==binding.environmentDigest||candidate.environmentDigest!==binding.environmentDigest||base.harnessDigest!==binding.harnessDigest||candidate.harnessDigest!==binding.harnessDigest)return deny("提交、候选树、套件、环境或测试工具指纹不一致。");
  if(!base.testTreeDigest||base.testTreeDigest!==candidate.testTreeDigest)return deny("冻结测试源文件发生变化或未提供指纹。");
  if(!base.clean||!candidate.clean||!base.complete||!candidate.complete||!base.results.length||!candidate.results.length)return unknown("执行不完整或工作区存在改动。");
  const group=run=>{const m=new Map();for(const row of run.results){if(!m.has(row.id))m.set(row.id,[]);m.get(row.id).push(row);}return m;};
  const a=group(base),b=group(candidate);
  if(a.size!==b.size||[...a.keys()].some(k=>!b.has(k)))return deny("测试集合变化。");
  if(!Array.isArray(binding.caseIds)||binding.caseIds.length!==a.size||binding.caseIds.some(k=>!a.has(k)))return deny("未覆盖冻结的完整用例集合。");
  if([...a].some(([k,rows])=>rows.length!==b.get(k).length||rows.map(x=>x.attempt).sort((x,y)=>x-y).join(",")!==b.get(k).map(x=>x.attempt).sort((x,y)=>x-y).join(",")))return unknown("基线与候选尝试集合不同。");
  for(const rows of [...a.values(),...b.values()])if(rows.some(x=>!["pass","fail"].includes(x.result))||new Set(rows.map(x=>x.result)).size!==1)return unknown("存在跳过、异常、未知或不稳定结果。");
  const red=a.get(binding.targetCase),green=b.get(binding.targetCase);
  if(!red?.every(x=>x.result==="fail"&&x.assertion)||!green?.every(x=>x.result==="pass"))return deny("未证明同一目标断言先红后绿。");
  const added=[...b].filter(([k,v])=>v.some(x=>x.result==="fail")&&a.get(k).every(x=>x.result==="pass")).map(([k])=>k);
  if(added.length)return {verdict:"deny",reason:"新增回归失败。",added};
  // Conservative: remaining historical failures also block independent release.
  if(candidate.exitCode!==0||base.exitCode!==1||[...b.values()].some(rows=>rows.some(x=>x.result!=="pass")))return deny("候选仍有失败或退出状态不一致。");
  return {verdict:"pass",reason:"冻结测试集合完整、目标断言先红后绿且候选全部通过。",added:[]};
}
export function normalizeProfiles(raw){
  const list=array(raw,30),ids=new Set();
  return list.map(p=>{
    const id=identifier(p.id);
    if(ids.has(id))bad();ids.add(id);
    const kind=one(p.kind,["test","red-green","evaluation","radar"]);
    const intervalMs=integer(p.intervalMs??0,0,86400000);
    if(intervalMs&&intervalMs<300000)bad("定时间隔最少 5 分钟。");
    if(kind==="red-green"&&intervalMs)bad("候选验证必须显式关联任务。");
    const profile={id,kind,policyDigest:hex(p.policyDigest,64),intervalMs,leaseMs:integer(p.leaseMs??900000,10000,1800000)};
    if(["test","red-green"].includes(kind)){
      Object.assign(profile,{suiteDigest:hex(p.suiteDigest,64),environmentDigest:hex(p.environmentDigest,64),harnessDigest:hex(p.harnessDigest,64),caseIds:array(p.caseIds,2000).map(x=>identifier(x,160))});
      if(!profile.caseIds.length||new Set(profile.caseIds).size!==profile.caseIds.length)bad();
      if(kind==="red-green"){profile.targetCase=identifier(p.targetCase,160);if(!profile.caseIds.includes(profile.targetCase))bad();profile.protectedPaths=array(p.protectedPaths,100).map(v=>{if(typeof v!=="string"||!v||v.length>250||!/^[-A-Za-z0-9_./]+$/.test(v)||v.startsWith("/")||v.split("/").some(x=>!x||x==="."||x===".."||x===".git"))bad();return v;});if(!profile.protectedPaths.length)bad();}
    }
    return profile;
  });
}
export function approvedKnowledge(records,project,sha,keywords,budget=6000){
  if(!sha||!Array.isArray(records))return {items:[],digest:digest([]),omitted:0};
  const latest=new Map();
  for(const r of records)if(r.kind==="knowledge"&&r.project===projectScope(project))latest.set(r.key,r);
  const terms=[...new Set(String(keywords??"").toLowerCase().split(/[\s/_.-]+/).filter(x=>x.length>=3))].slice(0,30);
  const candidates=[...latest.values()].filter(r=>r.payload.status==="approved"&&r.payload.baselineSha===sha&&r.payload.sourceRefs.length).map(r=>({r,score:terms.filter(t=>(r.payload.title+" "+r.payload.statement).toLowerCase().includes(t)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.r.key.localeCompare(b.r.key));
  const items=[];let used=0;
  for(const {r} of candidates){const x={key:r.key,version:r.version,title:r.payload.title,statement:r.payload.statement,sourceRefs:r.payload.sourceRefs,contentDigest:r.digest};const n=Buffer.byteLength(JSON.stringify(x));if(used+n>budget||items.length>=8)continue;items.push(x);used+=n;}
  return {items,digest:digest(items),omitted:candidates.length-items.length,bytes:used};
}
