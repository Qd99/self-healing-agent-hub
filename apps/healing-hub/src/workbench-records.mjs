/** Bounded append-only workspace ledger; not a trusted execution/authorization gate. */
import { createHash } from "node:crypto";
import { HealingError } from "./console-store.mjs";
const invalid=()=>{throw new HealingError(400,"INVALID_WORKBENCH_RECORD","记录字段无效、过长或缺少证据。");};
const conflict=()=>{throw new HealingError(409,"WORKBENCH_CONFLICT","记录版本已变化，请刷新后重试。");};
const obj=v=>{if(!v||typeof v!=="object"||Array.isArray(v))invalid();return v;};
const fields=(v,keys)=>{obj(v);if(Object.keys(v).some(k=>!keys.includes(k)))invalid();};
const text=(v,max=500,empty=false)=>{
  if(typeof v!=="string"||v.length>max||(!empty&&!v.trim()))invalid();
  // eslint-disable-next-line no-control-regex
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))invalid();
  if(/(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|authorization\s*[:=]\s*bearer\s+|(?:api[_-]?key|password|token|secret)\s*[:=]\s*\S+)/i.test(v))invalid();
  return v.trim();
};
const integer=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)invalid();return v;};
const one=(v,values)=>{if(!values.includes(v))invalid();return v;};
const hex=(v,n)=>{if(typeof v!=="string"||!new RegExp("^[a-f0-9]{"+n+"}$").test(v))invalid();return v;};
const hash=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const array=(v,max,fn)=>{if(!Array.isArray(v)||v.length>max)invalid();return v.map(fn);};
const nullable=(v,fn)=>v==null?null:fn(v);
const iso=v=>{if(typeof v!=="string"||v.length>40||!Number.isFinite(Date.parse(v)))invalid();return new Date(v).toISOString();};
const url=v=>{let u;try{u=new URL(text(v,1500));}catch{invalid();}if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)invalid();return u.href;};
const result=v=>one(v,["pass","fail","skip","error","timeout","cancelled","unknown"]);
export const recordKinds=["review","case-map","test-plan","test-run","knowledge","evaluation","radar"];
const mappedCase=v=>{
  fields(v,["productId","caseId","caseVersion","automatedId"]);
  return {productId:integer(v.productId,1,1e9),caseId:integer(v.caseId,1,1e9),caseVersion:integer(v.caseVersion,1,1e9),automatedId:text(v.automatedId,500)};
};
export function normalizeWorkbenchPayload(kind,input){
  const p=obj(input);
  if(kind==="review"){
    fields(p,["issueNumber","contractHash","baselineSha","role","verdict","note"]);
    return {issueNumber:integer(p.issueNumber,1,1e9),contractHash:hex(p.contractHash,64),baselineSha:hex(p.baselineSha,40),role:one(p.role,["product","development","testing"]),verdict:one(p.verdict,["pass","changes-required","blocked"]),note:text(p.note,4000)};
  }
  if(kind==="case-map"){
    fields(p,["productId","caseId","caseVersion","automatedId","requirementRef","note"]);
    const {requirementRef,note,...mapping}=p;
    return {...mappedCase(mapping),requirementRef:text(requirementRef??"",300,true),note:text(note??"",1000,true)};
  }
  if(kind==="test-plan"){
    fields(p,["name","environment","commitSha","cases","note"]);
    const cases=array(p.cases,200,mappedCase);
    if(!cases.length||new Set(cases.map(v=>JSON.stringify([v.productId,v.caseId,v.caseVersion,v.automatedId]))).size!==cases.length)invalid();
    return {name:text(p.name,200),environment:text(p.environment,100),commitSha:hex(p.commitSha,40),cases,note:text(p.note??"",1000,true)};
  }
  if(kind==="test-run"){
    fields(p,["runId","framework","commitSha","environment","exitCode","dirty","startedAt","finishedAt","results","planRef"]);
    const startedAt=iso(p.startedAt),finishedAt=iso(p.finishedAt);
    if(finishedAt<startedAt||typeof p.dirty!=="boolean")invalid();
    const results=array(p.results,2000,v=>{
      fields(v,["id","name","result","durationMs","attempt","error"]);
      return{id:text(v.id,500),name:text(v.name,500),result:result(v.result),durationMs:nullable(v.durationMs,x=>integer(x,0,86400000)),attempt:integer(v.attempt??1,1,1000),error:text(v.error??"",200,true)};
    });
    if(new Set(results.map(v=>JSON.stringify([v.id,v.attempt]))).size!==results.length)invalid();
    return {runId:text(p.runId,120),framework:one(p.framework,["node:test","junit","pytest","playwright"]),commitSha:hex(p.commitSha,40),environment:text(p.environment,100),exitCode:nullable(p.exitCode,x=>integer(x,0,255)),dirty:p.dirty,startedAt,finishedAt,results,planRef:text(p.planRef??"",200,true)};
  }
  if(kind==="knowledge"){
    fields(p,["title","statement","category","sourceRefs","baselineSha","status","reviewNote"]);
    const status=one(p.status,["candidate","approved","stale","rejected"]),sourceRefs=array(p.sourceRefs,20,v=>text(v,300));
    if(!sourceRefs.length)invalid();
    return {title:text(p.title,200),statement:text(p.statement,6000),category:one(p.category,["fact","decision","pattern","pitfall","suggestion"]),sourceRefs,baselineSha:hex(p.baselineSha,40),status,reviewNote:text(p.reviewNote??"",2000,status==="candidate")};
  }
  if(kind==="evaluation"){
    fields(p,["title","datasetDigest","policyDigest","baselineConfig","candidateConfig","samples","note"]);
    const samples=array(p.samples,500,v=>{
      fields(v,["caseId","trial","baseline","candidate","baselineLatencyMs","candidateLatencyMs"]);
      return{caseId:text(v.caseId,200),trial:integer(v.trial,1,1000),baseline:result(v.baseline),candidate:result(v.candidate),baselineLatencyMs:nullable(v.baselineLatencyMs,x=>integer(x,0,86400000)),candidateLatencyMs:nullable(v.candidateLatencyMs,x=>integer(x,0,86400000))};
    });
    if(!samples.length||new Set(samples.map(v=>JSON.stringify([v.caseId,v.trial]))).size!==samples.length)invalid();
    return {title:text(p.title,200),datasetDigest:hex(p.datasetDigest,64),policyDigest:hex(p.policyDigest,64),baselineConfig:hex(p.baselineConfig,64),candidateConfig:hex(p.candidateConfig,64),samples,note:text(p.note??"",2000,true)};
  }
  if(kind==="radar"){
    fields(p,["title","sourceUrl","sourceVersion","baselineSha","summary","decision","reason","issueNumber"]);
    return {title:text(p.title,300),sourceUrl:url(p.sourceUrl),sourceVersion:text(p.sourceVersion,200),baselineSha:hex(p.baselineSha,40),summary:text(p.summary,5000),decision:one(p.decision,["candidate","adopt","optimize","implemented","in-progress","reject","insufficient"]),reason:text(p.reason,3000),issueNumber:nullable(p.issueNumber,x=>integer(x,1,1e9))};
  }
  invalid();
}
function keyFor(kind,p,key){
  if(kind==="review")return [p.issueNumber,p.contractHash,p.baselineSha,p.role].join(":");
  if(kind==="case-map")return [p.productId,p.caseId,p.caseVersion].join(":");
  if(kind==="test-run")return p.runId;
  if(kind==="radar")return hash([p.sourceUrl,p.sourceVersion]);
  return text(key,120);
}
const projectOf=p=>JSON.stringify([p.id,p.repo]);
const MAX_RECORDS=1000,MAX_BYTES=4*1024*1024;
export function validateWorkbenchRecords(records){
  if(records===undefined)return;
  if(!Array.isArray(records)||records.length>MAX_RECORDS||Buffer.byteLength(JSON.stringify(records))>MAX_BYTES)invalid();
  const versions=new Map();
  for(const r of records){
    fields(r,["kind","project","key","version","payload","digest","actor","at"]);
    one(r.kind,recordKinds);text(r.project,500);text(r.key,300);integer(r.version,1,MAX_RECORDS);text(r.actor,160);iso(r.at);
    const p=normalizeWorkbenchPayload(r.kind,r.payload);
    if(hash(p)!==r.digest||keyFor(r.kind,p,r.key)!==r.key)invalid();
    const id=JSON.stringify([r.project,r.kind,r.key]),previous=versions.get(id)||0;
    if(r.version!==previous+1)invalid();
    versions.set(id,r.version);
  }
}
export function appendWorkbenchRecord(state,project,body,actor,at){
  fields(body,["kind","key","expectedVersion","payload","requestId"]);
  const kind=one(body.kind,recordKinds),payload=normalizeWorkbenchPayload(kind,body.payload),key=keyFor(kind,payload,body.key);
  const scope=projectOf(project),records=state.workbenchRecords??[];
  const previous=records.findLast(r=>r.project===scope&&r.kind===kind&&r.key===key);
  const digest=hash(payload),expected=integer(body.expectedVersion,0,MAX_RECORDS);
  if(previous?.digest===digest)return {changed:false,value:{record:previous,duplicate:true}};
  if(expected!==(previous?.version??0))conflict();
  if(kind==="test-run"&&previous)conflict();
  if(kind==="knowledge"&&payload.status!=="candidate"){
    if(!previous)invalid();
    const prior=previous.payload;
    if(["title","statement","category","baselineSha","sourceRefs"].some(k=>JSON.stringify(prior[k])!==JSON.stringify(payload[k])))invalid();
    if(payload.status==="approved"&&prior.status!=="candidate")invalid();
  }
  const record={kind,project:scope,key,version:(previous?.version??0)+1,payload,digest,actor:text(actor,160),at:iso(at)};
  const next=[...records,record];
  if(next.length>MAX_RECORDS||Buffer.byteLength(JSON.stringify(next))>MAX_BYTES)
    throw new HealingError(503,"WORKBENCH_FULL","工作区记录已达容量上限。");
  state.workbenchRecords=next;
  return {changed:true,value:{record,duplicate:false}};
}
export function listWorkbenchRecords(records,project,{kind,key,page=1,pageSize=20,history=false,issueNumber}={}){
  one(kind,recordKinds);integer(page,1,100000);integer(pageSize,1,50);
  if(issueNumber!==undefined)integer(issueNumber,1,1e9);
  let matching=(records??[]).filter(r=>r.project===projectOf(project)&&r.kind===kind&&(!key||r.key===key)&&(issueNumber===undefined||r.payload.issueNumber===issueNumber));
  if(!history){const latest=new Map();for(const r of matching)latest.set(r.key,r);matching=[...latest.values()];}
  matching.sort((a,b)=>b.at.localeCompare(a.at)||b.version-a.version);
  const total=matching.length,pageCount=Math.max(1,Math.ceil(total/pageSize)),current=Math.min(page,pageCount);
  return {items:matching.slice((current-1)*pageSize,current*pageSize),total,page:current,pageSize,pageCount,history};
}
