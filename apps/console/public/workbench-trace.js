import { e,uiStatus,note,empty,head,section,props,table,search,pick,pager,split,status,time,label,button } from "./workbench-view-kit.js";
import { localPage,matchingText } from "./workbench-model.js";
import { workspaceExecution } from "./workspace-model.js";
import { formatDuration } from "./model.js";
const stages={worker:"Worker","base-check":"基线核对",checkout:"检出工作区","baseline-checks":"基线检查",model:"模型调用","model-usage":"模型用量",apply:"应用候选","candidate-checks":"候选检查",proposal:"提交候选",prepare:"准备授权执行",publish:"发布修复 PR",cleanup:"资源清理",receipt:"完成回执"};
export function renderTrace(s,w){
  const all=(s.snapshot?.tasks||[]).filter(t=>matchingText([t.title,t.task.id,t.engineId],w.query));
  const page=localPage(all,w.page,12),item=page.items.find(t=>t.task.id===w.selected)||page.items[0];
  const list=head("任务链路")+search(w)+'<div class="wb-list-items">'+(page.items.map(t=>pick(t.title,t.task.id,item?.task.id===t.task.id,workspaceExecution(t,s).label+" · "+(t.engineId||""))).join("")||empty("暂无任务"))+'</div>'+pager(page.page,page.page<page.pageCount,"wb-page",page.total);
  if(!item)return split(list,empty("暂无链路"));
  const view=workspaceExecution(item,s),events=item.observation?.events||[],history=item.trace||[],audit=(s.snapshot.activity||[]).filter(x=>x.taskId===item.task.id).slice(0,100);
  const rows=[...events].sort((a,b)=>String(a.observedAt).localeCompare(String(b.observedAt))||a.sequence-b.sequence).map(x=>[time(x.observedAt),e(stages[x.stage]||x.stage),e(label(x.state)),e(x.workerId)+"<small>"+e(x.attempt)+" / "+e(x.sequence)+"</small>",x.durationMs==null?"—":e(formatDuration(x.durationMs)),x.usage?e(Object.entries(x.usage).map(([k,v])=>k+": "+v).join(" · ")):"—"]);
  let body='<header class="wb-reading-title"><div class="row">'+uiStatus({label:view.label})+uiStatus({label:"部分观测 · 非门禁证据"})+'</div><h2>'+e(item.title)+'</h2>'+props([["任务 ID",item.task.id],["阶段",view.phase],["租约 Worker",view.workerId],["快照时间",time(view.observedAt)]])+button("打开任务详情","open-task",'data-id="'+e(item.task.id)+'"')+button("持久链路","adv-open-workflow",'data-id="'+e(item.task.id)+'"')+'</header>';
  body+=section("Worker 阶段与模型用量",note("15 秒快照轮询；内存缓冲、网络丢失或重启可能缺失事件。返回事件不等于检查成功。当前缓冲 "+events.length+" 条，淘汰 "+(item.observation?.dropped||0)+" 条。")+(rows.length?table(["观测时间","步骤","事件","执行器 / 尝试","耗时","Token"],rows):empty("尚无 Worker 观测事件")));
  body+=section("已回传 Trace",history.length?table(["步骤","状态","耗时"],history.map(x=>[e(x.title),status(x.status),e(formatDuration(x.durationMs))])):note("暂无回传步骤。"));
  body+=section("持久业务审计",audit.length?table(["时间","动作","记录"],audit.map(x=>[time(x.at),e(x.action),e(x.message)])):note("暂无关联审计。"));
  return split(list,body);
}
