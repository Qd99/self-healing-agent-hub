import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOtlp,graphFor,normalizeRun,compareRedGreen,normalizeProfiles,approvedKnowledge,projectScope } from "../apps/healing-hub/src/advanced-model.mjs";
import { createAdvancedStore } from "../apps/healing-hub/src/advanced-store.mjs";
import { parsePlaywright,parseNode,parseNormalized,validateActualRun } from "../scripts/advanced-report-adapters.mjs";

const project={id:"p",repo:"owner/repo"},other={id:"p2",repo:"owner/other"};
const d="c".repeat(64),sha="a".repeat(40),tree="b".repeat(40),ts="2026-01-01T00:00:00Z";
const binding={baseSha:sha,treeSha:tree,suiteDigest:d,environmentDigest:d,harnessDigest:d,caseIds:["target","other"],targetCase:"target"};
const input={sha,tree,suiteDigest:d,environmentDigest:d,harnessDigest:d,testTreeDigest:d,startedAt:ts,finishedAt:ts,clean:true,complete:true,exitCode:1,results:[{id:"target",result:"fail",assertion:true,attempt:1},{id:"other",result:"pass",attempt:1}]};
const red=normalizeRun(input),green=normalizeRun({...input,exitCode:0,results:input.results.map(x=>({...x,result:"pass",assertion:false}))});
const trace="a".repeat(32),trace2="b".repeat(32),a="1".repeat(16),b="2".repeat(16),c="3".repeat(16);
const attr=(key,stringValue)=>({key,value:{stringValue}});
const span=(traceId,spanId,parentSpanId,links=[])=>({traceId,spanId,parentSpanId,links,startTimeUnixNano:"1000000000",endTimeUnixNano:"2000000000",attributes:[attr("hub.workflow_id","workflow"),attr("hub.task_id","task-1"),attr("hub.agent_id","qa"),attr("prompt","private sentinel")]});
const otlp=spans=>({resourceSpans:[{scopeSpans:[{spans}]}]});
const known=new Set(["task-1"]);
const decode=spans=>decodeOtlp(otlp(spans),project,known);

test("OTLP graph uses actual parents and cross-trace links, never raw prompts",()=>{
  const rows=decode([span(trace,a),span(trace,b,a),span(trace2,c,undefined,[{traceId:trace,spanId:b}])]);
  const g=graphFor(rows);assert.equal(g.parents.length,1);assert.equal(g.links.length,1);
  assert.equal(g.cycle,false);assert.equal(g.order.length,3);
  assert.ok(!JSON.stringify(rows).includes("private sentinel"));
  assert.equal(graphFor(decode([span(trace,b,a)])).missing.length,1);
  assert.equal(graphFor(decode([span(trace,a,b),span(trace,b,a)])).cycle,true);
  assert.throws(()=>decodeOtlp(otlp([span(trace,a)]),project,new Set()));
  assert.throws(()=>decode([{...span(trace,a),endTimeUnixNano:"0"}]));
});
test("red-green rejects tampering, missing/changed tests, flakes and nonassertion red",()=>{
  assert.equal(compareRedGreen(red,green,binding).verdict,"pass");
  assert.equal(compareRedGreen({...red,results:red.results.map(x=>({...x,assertion:false}))},green,binding).verdict,"deny");
  assert.equal(compareRedGreen(red,{...green,testTreeDigest:"d".repeat(64)},binding).verdict,"deny");
  assert.deepEqual(compareRedGreen(red,{...green,results:[green.results[0],{...green.results[1],result:"fail"}]},binding).added,["other"]);
  assert.equal(compareRedGreen(red,{...green,results:[green.results[0],{...green.results[1],result:"skip"}]},binding).verdict,"unknown");
  assert.equal(compareRedGreen(red,{...green,complete:false},binding).verdict,"unknown");
  assert.equal(compareRedGreen(red,{...green,results:[green.results[0]]},binding).verdict,"deny");
  assert.equal(compareRedGreen(red,{...green,results:[...green.results,{...green.results[0],attempt:2}]},binding).verdict,"unknown");
  assert.throws(()=>normalizeRun({...input,results:[...input.results,input.results[0]]}));
  assert.throws(()=>normalizeProfiles([{id:"qa",kind:"red-green",policyDigest:d,intervalMs:300000}]));
});
const profile={id:"qa",kind:"red-green",policyDigest:d,intervalMs:0,leaseMs:10000,suiteDigest:d,environmentDigest:d,harnessDigest:d,caseIds:["target","other"],targetCase:"target",protectedPaths:["tests"]};
const env={HUB_ADVANCED_ENABLED:"1",HUB_ADVANCED_PROFILES_JSON:JSON.stringify([profile]),HUB_QA_EVIDENCE_HMAC:"test-only-independent-hmac-secret-123456",HUB_QA_GATE_REQUIRED:"1",HUB_QA_POLICY_DIGEST:d};
const candidateBinding={taskId:"task-1",proposalId:"proposal",contentHash:d,baseSha:sha,treeSha:tree,round:1};
const entry={task:{id:"task-1"},proposal:{id:"proposal",version:2,contentHash:d,candidate:{baseCommitSha:sha,treeSha:tree}},approvalFlow:{round:1}};
async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),"hub-advanced-test-"));let now=Date.parse(ts);
  const opened=[];
  const open=()=>{const store=createAdvancedStore({dataDir,env,clock:()=>now});opened.push(store);return store;};
  t.after(async()=>{for(const s of opened)await s.close();await rm(dataDir,{recursive:true,force:true});});
  return {open,advance:ms=>now+=ms};
}
test("durable trace persists across close/reopen, dedupes and preserves scope/replay",async t=>{
  const {open}=await fixture(t);let s=open();
  assert.equal((await s.ingest(project,otlp([span(trace,a),span(trace,b,a)]),known)).accepted,2);
  assert.equal((await s.ingest(project,otlp([span(trace,a)]),known)).accepted,0);
  await assert.rejects(s.ingest(project,otlp([{...span(trace,a),endTimeUnixNano:"3000000000"}]),known));
  const replay=await s.trace(project,{workflow:"task-1",until:1});
  assert.equal(replay.items.length,1);assert.equal(replay.latest,2);assert.equal(replay.graph.nodes.length,1);
  await s.close();s=open();
  assert.equal((await s.trace(project,{workflow:"workflow",after:1})).items.length,1);
  assert.equal((await s.trace(other,{})).items.length,0);
});
test("independent QA claims atomically and signs evidence bound to candidate and round",async t=>{
  const {open}=await fixture(t);const s=open();
  const queued=await s.enqueue(project,"qa",candidateBinding,"req-1");
  assert.equal((await s.enqueue(project,"qa",candidateBinding,"req-1")).id,queued.id);
  assert.equal((await s.claim(other,{worker:"other",profiles:["qa"]})).job,null);
  const claimed=await Promise.all([s.claim(project,{worker:"qa1",profiles:["qa"]}),s.claim(project,{worker:"qa2",profiles:["qa"]})]);
  const jobs=claimed.map(x=>x.job).filter(Boolean);assert.equal(jobs.length,1);
  const j=jobs[0],body={worker:j.worker,lease:j.lease,result:{baseline:red,candidate:green}};
  await assert.rejects(s.complete(project,j.id,{...body,lease:"bad"}));
  assert.equal((await s.complete(project,j.id,body)).state,"completed");
  assert.equal((await s.complete(project,j.id,body)).state,"completed");
  assert.equal((await s.list(project,"evidence")).total,1);
  assert.equal((await s.gate(project,entry)).verdict,"pass");
  assert.equal((await s.gate(project,{...entry,approvalFlow:{round:2}})).verdict,"unknown");
  assert.equal((await s.gate(other,entry)).verdict,"unknown");
});
test("cancel request is fenced; expired jobs become unknown, not retried",async t=>{
  const {open,advance}=await fixture(t);const s=open();
  await s.enqueue(project,"qa",candidateBinding,"req-cancel");
  const {job}=await s.claim(project,{worker:"qa1",profiles:["qa"]});
  await s.cancelJob(project,job.id,{confirm:true});
  assert.equal((await s.runnerStatus(project,job.id,"qa1",job.lease)).cancelRequested,true);
  await assert.rejects(s.complete(project,job.id,{worker:"qa1",lease:job.lease,result:{baseline:red,candidate:green}}));
  assert.equal((await s.abort(project,job.id,"qa1",job.lease)).state,"cancelled");
  await s.enqueue(project,"qa",candidateBinding,"req-expire");
  const {job:expired}=await s.claim(project,{worker:"qa1",profiles:["qa"]});
  advance(10001);
  assert.equal((await s.claim(project,{worker:"qa1",profiles:["qa"]})).job,null);
  assert.equal((await s.job(project,expired.id)).state,"unknown");
  await assert.rejects(s.complete(project,expired.id,{worker:"qa1",lease:expired.lease,result:{baseline:red,candidate:green}}));
  assert.equal((await s.reconcileJob(project,expired.id,{confirm:true,note:"Checked workspace"})).state,"reconciled");
});
test("external writes are reserved once and unknown outcomes require reconciliation",async t=>{
  const {open}=await fixture(t);const s=open();
  const one=await s.reserveEffect(project,"zentao-result","key",{caseId:1});
  const two=await s.reserveEffect(project,"zentao-result","key",{caseId:1});
  assert.equal(one.created,true);assert.equal(two.created,false);assert.equal(two.effect.state,"unknown");
  await s.finishEffect(project,one.effect.id,{state:"submitted-unverified"});
  assert.equal((await s.reconcileEffect(project,one.effect.id,{confirm:true,outcome:"verified",note:"Checked actual execution"})).state,"verified");
  const three=await s.reserveEffect(project,"zentao-result","key",{caseId:1});
  assert.equal(three.created,false);assert.equal(three.effect.state,"verified");
});
test("knowledge is latest, approved, exact-project and exact-base only",()=>{
  const item=(key,status,baselineSha=sha,p=project)=>({kind:"knowledge",project:projectScope(p),key,version:1,digest:d,payload:{status,baselineSha,title:"runner test",statement:"Use approved runner",sourceRefs:["ADR-1"]}});
  const result=approvedKnowledge([item("a","approved"),item("b","candidate"),item("c","approved",tree),item("d","approved",sha,other),item("e","approved"),item("e","stale")],project,sha,"runner");
  assert.deepEqual(result.items.map(x=>x.key),["a"]);
  assert.equal(approvedKnowledge([item("a","approved")],project,sha,"runner",1).items.length,0);
});
test("report adapters keep retries, unknown cases and assertion boundaries",()=>{
  const x=parsePlaywright(JSON.stringify({stats:{},suites:[{specs:[{file:"a.spec.ts",title:"test",line:1,tests:[{projectName:"chromium",results:[{status:"failed",errors:[{matcherResult:{}}],duration:1},{status:"passed",duration:2}]}]}]}]}));
  assert.equal(x.length,2);assert.equal(x[0].assertion,true);assert.equal(x[1].attempt,2);assert.equal(x[0].id,x[1].id);
  assert.throws(()=>parsePlaywright(JSON.stringify({stats:{},suites:[],errors:[{}]})));
  assert.equal(parseNode('{"type":"result","id":"t","result":"fail"}\n{"type":"summary","success":false}')[0].assertion,false);
  assert.throws(()=>parseNode('{"type":"result","id":"t","result":"pass"}'));
  assert.throws(()=>parseNormalized('{"schemaVersion":1,"complete":false,"results":[]}'));
  assert.equal(validateActualRun(input,[input.results[0]],binding).complete,false);
});
