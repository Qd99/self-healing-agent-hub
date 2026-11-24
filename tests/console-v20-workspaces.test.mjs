import test from "node:test";
import assert from "node:assert/strict";
import { createDemoSnapshot } from "../apps/console/public/data.js";
import { workspaceExecution, workspacePageNumbers, activityPageSize } from "../apps/console/public/workspace-model.js";
import { renderWorkspaceExecutionDetail, renderWorkspacePager } from "../apps/console/public/workspace-views.js";
import { getActivityPage, filterActivities } from "../apps/console/public/administration-model.js";
import { createAdministrationController } from "../apps/console/public/administration-controller.js";
import { planBulkAction } from "../apps/console/public/task-model.js";
import { renderBulkDialog } from "../apps/console/public/task-views.js";
import { renderShell, renderTaskDetail } from "../apps/console/public/views.js";
import { renderTaskPage } from "../apps/console/public/task-views.js";
import { renderStudioDashboard } from "../apps/console/public/dashboard.js";

const at = "2026-11-24T09:00:00Z";
const context = { presentation:"v20", mode:"live", snapshot:{generatedAt:at} };
const task = (overrides={}) => ({status:{status:"running",progress:42,message:"执行中"},execution:{phase:"execute",workerId:"worker-01",leaseExpiresAt:"2026-11-24T09:02:00Z"},trace:[{title:"旧诊断步骤",status:"running"}],...overrides});

test("execution never invents progress or promotes historical trace to live activity", () => {
  const v = workspaceExecution(task(), context);
  assert.equal(v.progress,42);
  assert.equal(v.label,"执行已批准方案");
  assert.equal(v.lastStep.title,"旧诊断步骤");
  assert.equal(workspaceExecution(task({status:{status:"running",progress:null}}),context).progress,null);
  assert.equal(workspaceExecution(task({status:{status:"running",progress:"42"}}),context).progress,null);
  assert.equal(workspaceExecution(task({status:{status:"running",progress:101}}),context).progress,null);
  const stale=workspaceExecution(task(),{...context,error:"offline"});
  assert.equal(stale.stale,true);
  assert.equal(stale.active,false);
  const expired=workspaceExecution(task({execution:{phase:"execute",leaseExpiresAt:at}}),context);
  assert.equal(expired.active,false);
  assert.match(expired.label,/租约到期/);
  const blocked=workspaceExecution(task({reconciliation:{status:"required",reason:"需核对"}}),context);
  assert.equal(blocked.label,"待人工核对");
  assert.equal(blocked.active,false);
  const cancelled=workspaceExecution(task({status:{status:"cancelled",progress:100},execution:{cancelRequested:true},reviewState:"pending"}),context);
  assert.equal(cancelled.label,"已取消");
  assert.equal(cancelled.active,false);
});

test("V20 execution details escape remote messages and explain observation boundaries", () => {
  const unsafe='<img src=x onerror=alert(1)>';
  const html=renderWorkspaceExecutionDetail(task({status:{status:"running",message:unsafe},trace:[{title:unsafe,status:"running"}]}),context);
  assert.doesNotMatch(html,/<img/);
  assert.match(html,/&lt;img/);
  assert.match(html,/未回传进度/);
  assert.match(html,/历史记录，不代表当前操作/);
  assert.match(html,/15 秒后台快照轮询/);
});

test("shared pager keeps legacy event contracts and bounds large result sets", () => {
  assert.deepEqual(workspacePageNumbers(5,20),[1,"gap",4,5,6,"gap",20]);
  assert.deepEqual(workspacePageNumbers(1,1),[1]);
  assert.equal(activityPageSize(50),50);
  assert.equal(activityPageSize(999),15);
  const entries=Array.from({length:36},(_,i)=>({id:String(i),at,action:"trigger",message:"record",actor:"operator",level:"info"}));
  const page=getActivityPage(entries,{page:9,pageSize:20});
  assert.equal(page.page,2);
  assert.equal(page.pageSize,20);
  assert.equal(page.total,36);
  assert.equal(page.items.length,16);
  assert.equal(getActivityPage(entries).pageSize,15);
  const html=renderWorkspacePager(page,"activity");
  assert.match(html,/id="activity-page-size"/);
  assert.match(html,/data-action="activity-page"/);
  assert.match(html,/id="activity-page-2".*aria-current="page"/);
  assert.match(renderWorkspacePager({...page,pageSize:20},"task"),/id="task-page-size"/);
});

test("V20 uses real view data and opt-in layouts while the legacy shell remains available", (t) => {
  const now=Date.parse(at);
  t.mock.method(Date,"now",()=>now);
  const snapshot=createDemoSnapshot(now);
  const state={mode:"demo",presentation:"v20",snapshot,view:"overview",days:7,overviewTab:"focus",detailTab:"trace",taskPage:1,taskPageSize:10,approvalFilter:"all",approvalTab:"flow"};
  const overview=renderStudioDashboard(state);
  assert.match(overview,/v20-overview-grid/);
  assert.match(overview,/需要处理/);
  assert.match(overview,/data-action="dashboard-filter"/);
  assert.doesNotMatch(renderStudioDashboard({...state,presentation:"legacy"}),/v20-overview-grid/);
  const tasks=renderTaskPage(state);
  for (const marker of ["task-search","task-page-size","task-filter-toggle","task-select-page","task-display-toggle","v20-task-progress"]) assert.ok(tasks.includes(marker),marker);
  const entry=snapshot.tasks[0];
  const detail=renderTaskDetail(entry,state);
  assert.match(detail,/v20-execution-detail/);
  assert.match(detail,/data-action="detail-tab"/);
  assert.doesNotMatch(renderTaskDetail(entry,{...state,presentation:"legacy"}),/v20-execution-detail/);
  for (const [view,marker] of [["approvals","v20-approval-evidence"],["engines","v20-engine-workspace"],["activity","activity-page-size"],["settings","v20-connection-context"]]) {
    const html=renderShell({...state,view,activityPageSize:15});
    assert.ok(html.includes(marker),view);
    assert.match(html,/旧版界面/);
  }
});


test("audit page-size and filter changes use existing controller and preserve legacy behavior", () => {
  const entries=Array.from({length:61},(_,i)=>({id:String(i),at,action:"trigger",message:"record",actor:"operator",level:"info"}));
  const setup=(presentation)=>{
    const state={presentation,snapshot:{activity:entries,rules:[]},activityPage:3};
    let renders=0;
    const controller=createAdministrationController({state,render:()=>renders++,toast:()=>{}});
    return {state,controller,renders:()=>renders};
  };
  const {state,controller,renders}=setup("v20");
  assert.equal(state.activityPageSize,15);
  assert.equal(state.activityPage,3);
  assert.equal(controller.handleChange({target:{id:"activity-page-size",value:"20"}}),true);
  assert.equal(state.activityPageSize,20);
  assert.equal(state.activityPage,1);
  assert.equal(renders(),1);
  controller.handleClick({}, {dataset:{action:"activity-page",page:"3"}});
  assert.equal(state.activityPage,3);
  controller.handleChange({target:{id:"activity-page-size",value:"50"}});
  controller.handleClick({}, {dataset:{action:"activity-page",page:"9"}});
  assert.equal(state.activityPage,2);
  assert.equal(filterActivities(entries).length,61);
  controller.handleInput({target:{id:"activity-search",value:"no match"}});
  assert.equal(state.activityPage,1);
  assert.equal(getActivityPage(entries,{filters:state.activityFilters,pageSize:50}).total,0);
  controller.reset();
  assert.equal(state.activityPageSize,15);
  const legacy=setup("legacy");
  assert.equal(legacy.controller.handleChange({target:{id:"activity-page-size",value:"50"}}),false);
  assert.equal(legacy.state.activityPageSize,15);
});

test("V20 cross-page selection retains the existing bulk eligibility and confirmation", () => {
  const snapshot=createDemoSnapshot(Date.parse(at));
  const candidate=snapshot.tasks.find((entry)=>["failed","cancelled"].includes(entry.status.status)&&entry.reviewState!=="pending");
  assert.ok(candidate);
  const plan=planBulkAction(snapshot,{type:"retry",ids:[candidate.task.id]});
  assert.equal(plan.canExecute,true);
  const state={presentation:"v20",mode:"demo",snapshot,taskPage:1,taskPageSize:10,selectedTaskIds:[candidate.task.id]};
  const page=renderTaskPage(state);
  for (const marker of ['data-action="bulk-open"','data-action="task-select"',"task-select-page","task-page-size"]) assert.ok(page.includes(marker),marker);
  assert.match(renderBulkDialog({...state,bulkPlan:plan,bulkType:"retry"}),/data-action="bulk-confirm"/);
});
