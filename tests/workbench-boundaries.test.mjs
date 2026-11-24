import test from "node:test";
import assert from "node:assert/strict";
import { appendWorkbenchRecord, listWorkbenchRecords, validateWorkbenchRecords, normalizeWorkbenchPayload } from "../apps/healing-hub/src/workbench-records.mjs";
import { createObservationBuffer, normalizeObservation } from "../apps/healing-hub/src/workbench-observation.mjs";
import { createWorkbenchConnectors } from "../apps/healing-hub/src/workbench-connectors.mjs";
import { reportSummary, evaluationSummary, metricPlot, workbenchScope } from "../apps/console/public/workbench-model.js";
const p={id:"a",repo:"owner/repo"}, at="2026-11-24T00:00:00.000Z", sha="a".repeat(40), hash="b".repeat(64);
const review={issueNumber:5,contractHash:hash,baselineSha:sha,role:"testing",verdict:"pass",note:"Fixture review"};
const add=(s,kind,payload,expectedVersion=0,key="record")=>appendWorkbenchRecord(s,p,{kind,key,payload,expectedVersion},"tester",at);
test("review ledger idempotence, CAS, history, project and baseline isolation",()=>{
  const s={};const one=add(s,"review",review);
  assert.equal(one.value.record.version,1);
  assert.equal(add(s,"review",review).changed,false);
  assert.throws(()=>add(s,"review",{...review,note:"changed"}),/版本/);
  assert.equal(add(s,"review",{...review,note:"changed"},1).value.record.version,2);
  assert.equal(listWorkbenchRecords(s.workbenchRecords,p,{kind:"review",history:true}).total,2);
  assert.equal(listWorkbenchRecords(s.workbenchRecords,p,{kind:"review",baselineSha:"c".repeat(40)}).total,0);
  assert.equal(listWorkbenchRecords(s.workbenchRecords,{...p,repo:"owner/other"},{kind:"review"}).total,0);
  validateWorkbenchRecords(s.workbenchRecords);
  assert.throws(()=>validateWorkbenchRecords([{...s.workbenchRecords[0],digest:hash}]));
});
test("test-run identity is immutable and unknown fields rejected",()=>{
  const s={},run={runId:"fixture",framework:"node:test",commitSha:sha,environment:"test",exitCode:0,dirty:false,startedAt:at,finishedAt:at,results:[{id:"case",name:"Case",result:"pass",durationMs:1,attempt:1,error:""}],planRef:""};
  add(s,"test-run",run);
  assert.equal(add(s,"test-run",run).changed,false);
  assert.throws(()=>add(s,"test-run",{...run,exitCode:1},1));
  assert.throws(()=>normalizeWorkbenchPayload("test-run",{...run,results:[run.results[0],run.results[0]]}));
  assert.throws(()=>normalizeWorkbenchPayload("review",{...review,token:"never"}));
});
test("knowledge approval cannot replace the reviewed content",()=>{
  const s={},candidate={title:"Knowledge",statement:"Facts",category:"fact",sourceRefs:["file:fixture"],baselineSha:sha,status:"candidate",reviewNote:""};
  assert.throws(()=>add(s,"knowledge",{...candidate,status:"approved",reviewNote:"approved"}));
  add(s,"knowledge",candidate);
  assert.throws(()=>add(s,"knowledge",{...candidate,statement:"other",status:"approved",reviewNote:"approved"},1));
  add(s,"knowledge",{...candidate,status:"approved",reviewNote:"approved"},1);
  validateWorkbenchRecords(s.workbenchRecords);
});
test("observations accept only bounded metadata; duplicate and eviction are explicit",()=>{
  const b=createObservationBuffer({maxTasks:1,maxEvents:2}), lease={id:"private-lease",phase:"execute",workerId:"worker"};
  const event={sequence:1,stage:"model-usage",state:"observed",usage:{input:2,output:3}};
  assert.equal(b.add("task",lease,event,at),true);
  assert.equal(b.add("task",lease,event,at),false);
  assert.throws(()=>normalizeObservation({...event,prompt:"raw"}));
  b.add("task",lease,{...event,sequence:2},at);b.add("task",lease,{...event,sequence:3},at);
  assert.equal(b.read("task").dropped,1);assert.equal(b.read("task").durable,false);
  assert.doesNotMatch(JSON.stringify(b.read("task")),/private-lease/);
  b.add("other",lease,event,at);assert.equal(b.read("task").events.length,0);
});
test("report counts, paired comparisons and missing metrics are not fake successes",()=>{
  assert.equal(reportSummary([{id:"a",result:"fail"},{id:"a",result:"pass"},{id:"b",result:"unknown"}]).flaky,1);
  assert.deepEqual(evaluationSummary([{baseline:"pass",candidate:"fail"},{baseline:"fail",candidate:"pass"},{baseline:"unknown",candidate:"pass"}]),{total:3,baselinePass:1,candidatePass:2,regressions:1,improvements:1,unknown:1,paired:2});
  assert.equal(metricPlot([[0,null]],0,3),null);
  assert.equal(metricPlot([[0,1],[1,null],[2,3]],0,3).segments.length,2);
  assert.notEqual(workbenchScope({mode:"live",view:"metrics",snapshot:{project:p,monitoring:{namespace:"a"}}}),workbenchScope({mode:"live",view:"metrics",snapshot:{project:p,monitoring:{namespace:"b"}}}));
});
test("GitHub source is project-bound and PRs excluded from Issue list",async()=>{
  const urls=[],c=createWorkbenchConnectors({env:{HUB_GITHUB_READ_ENABLED:"1"},fetchImpl:async (url,init)=>{
    urls.push(String(url));assert.equal(init.method??"GET","GET");
    return new Response(JSON.stringify([{number:1,title:"Issue",state:"open"},{number:2,title:"PR",state:"open",pull_request:{}}]),{headers:{"Content-Type":"application/json"}});
  }});
  const result=await c.read("github-issues",{project:{...p,defaultBranch:"main"}},new URLSearchParams("page=1&repo=other/repo"));
  assert.equal(result.items.length,1);assert.match(urls[0],/^https:\/\/api\.github\.com\/repos\/owner\/repo\/issues\?/);
  await assert.rejects(()=>c.read("github-issues",{project:{repo:"owner/.."}}));
});
test("ZenTao uses only configured product and rejects disabled integration",async()=>{
  const env={HUB_ZENTAO_ENABLED:"1",HUB_ZENTAO_TOKEN:"fixture-token",HUB_ZENTAO_BASE_URL:"https://zentao.example.invalid",HUB_ZENTAO_PRODUCT_ID:"4"};
  const c=createWorkbenchConnectors({env,fetchImpl:async(url)=>{
    assert.match(String(url),/\/api\.php\/v1\/products\/4\/testcases\?/);
    return new Response(JSON.stringify({page:1,total:1,testcases:[{id:2,title:"fixture",version:3,story:5}]}),{headers:{"Content-Type":"application/json"}});
  }});
  assert.equal((await c.read("zentao",{},new URLSearchParams("product=9"))).items[0].version,3);
  await assert.rejects(()=>createWorkbenchConnectors({env:{}}).read("zentao",{}));
});
