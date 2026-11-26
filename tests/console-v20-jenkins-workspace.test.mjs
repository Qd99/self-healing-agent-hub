import test from "node:test";
import assert from "node:assert/strict";
import { getJenkinsPage, jenkinsVerificationState, renderJenkinsWorkspace } from "../apps/console/public/jenkins-workspace.js";
import { renderShell, renderTaskDetail, renderCreate } from "../apps/console/public/views.js";
import { createDemoSnapshot } from "../apps/console/public/data.js";

const at = "2026-11-24T09:00:00Z";
const sha = "a".repeat(40);
function item(i, status) {
  return { title: "Repair " + i, task: { id: "task-" + i, type: "ci-failure", priority: "high", metadata: {createdAt:at}, payload: {repo:"owner/repo",branch:"main",errorDetails:{message:"failed"},context:{commitSha:sha,source:{kind:"jenkins",sourceId:"source",jobName:"app/main",buildNumber:i,buildUrl:"https://ci.example/job/app/"+i+"/"}}} }, status:{status:"completed",progress:100}, trace:[],diff:[],execution:{phase:"done"},proposal:{id:"proposal",version:2,contentHash:"c".repeat(64),candidate:{patchSha256:"d".repeat(64),treeSha:sha}},result:{success:true,action:"pr-created",changes:{pr:i,commit:sha}},verification:status?{status}:undefined };
}
function state(tasks) {
  return {presentation:"v20",view:"jenkins",mode:"live",snapshot:{apiVersion:1,mode:"live",generatedAt:at,project:{id:"p",repo:"owner/repo"},tasks,capabilities:{importCi:true,verifyResult:true},integrations:{jenkins:{configured:true,sourceId:"source",jobName:"app/main",branch:"main"},verification:{configured:true,requiredStatusContexts:["jenkins/test"]}}}};
}
test("Jenkins view lists imported records only; PR creation is not CI pass",()=>{
  const manual=item(99,"passed");delete manual.task.payload.context.source;
  const pending=item(1,"pending"), passed=item(2,"passed"), none=item(3);delete none.result;
  const s=state([manual,pending,passed,none,item(4)]);
  const page=getJenkinsPage(s.snapshot.tasks,s);
  assert.equal(page.imported,4);
  assert.equal(page.counts.passed,1);
  assert.equal(page.counts.unverified,1);
  assert.equal(jenkinsVerificationState(none),"no-pr");
  assert.equal(jenkinsVerificationState(item(5,"toString")),"unknown");
  const html=renderJenkinsWorkspace(s);
  assert.match(html,/不代表 Jenkins 的完整构建历史/);
  assert.match(html,/等待 CI/);
  assert.match(html,/尚未核验/);
  assert.match(html,/CI 核验通过/);
  assert.doesNotMatch(html,/Repair 99/);
});
test("Jenkins filters, chart counts and pager remain consistent",()=>{
  const items=Array.from({length:53},(_,i)=>item(i+1,i%2?"pending":"passed"));
  const p=getJenkinsPage(items,{jenkinsPage:99,jenkinsPageSize:20,jenkinsStatus:"passed"});
  assert.equal(p.total,27);assert.equal(p.matching,53);assert.equal(p.page,2);assert.equal(p.items.length,7);
  const s={...state(items),jenkinsQuery:"task-53",jenkinsStatus:"passed"};
  const html=renderJenkinsWorkspace(s);
  assert.match(html,/Repair 53/);assert.doesNotMatch(html,/Repair 52/);
  assert.match(html,/data-action="jenkins-page"/);assert.match(html,/id="jenkins-page-size"/);
  assert.match(html,/data-action="jenkins-status-filter"/);
});
test("read-only and unconfigured states cannot import; remote text is escaped",()=>{
  const e=item(1,"mismatch");e.title="<script>bad</script>";e.task.payload.context.source.jobName="<img src=x>";
  const s=state([e]);s.snapshot.capabilities.importCi=false;
  const html=renderJenkinsWorkspace(s);
  assert.doesNotMatch(html,/<script>|<img src/);
  assert.match(html,/&lt;img/);
  assert.match(html,/data-action="ci-import-open"[^>]*disabled/);
  const stale=renderJenkinsWorkspace({...s,error:"offline"});
  assert.match(stale,/最近一次快照 · 非实时/);
  assert.match(stale,/历史 · 证据不一致/);
});
test("both entries expose Jenkins; integrated detail preserves V20 and CI evidence",()=>{
  const snapshot=createDemoSnapshot(Date.parse(at));
  const e=item(23,"pending");snapshot.tasks=[e];snapshot.integrations=state([e]).snapshot.integrations;
  snapshot.capabilities.importCi=true;snapshot.capabilities.verifyResult=true;
  const s={...state([e]),mode:"demo",snapshot,days:7,overviewTab:"focus",detailTab:"trace"};
  for(const presentation of ["v20","legacy"]){
    const html=renderShell({...s,presentation});
    assert.match(html,/data-nav="jenkins"/);
    assert.match(html,/Jenkins 修复工作区/);
  }
  const detail=renderTaskDetail(e,s);
  assert.match(detail,/v20-execution-detail/);
  assert.match(detail,/task-ci-source/);
  assert.match(detail,/task-ci-verification/);
  assert.match(detail,/data-action="ci-verify"/);
  assert.doesNotMatch(renderTaskDetail(e,{...s,presentation:"legacy"}),/v20-execution-detail/);
  assert.match(renderCreate({...s,createMode:"ci"}),/ci-import-form/);
});
