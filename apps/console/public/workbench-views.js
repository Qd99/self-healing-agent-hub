import { uiTabs,uiStatus } from "./ui.js";
import { e,button,note,time,empty } from "./workbench-view-kit.js";
import { initialWorkbench,workbenchTabs,recordTabs,workbenchScope } from "./workbench-model.js";
import { renderRequirements } from "./workbench-requirements.js";
import { renderTrace } from "./workbench-trace.js";
import { renderRecords,renderZentao } from "./workbench-record-views.js";
import { renderMetrics } from "./workbench-metrics.js";
export function renderWorkbenchPage(s){
  const w=s.workbench?.view===s.view&&s.workbench.scope===workbenchScope(s)?s.workbench:initialWorkbench(s.view);
  const observed=w.detail?.observedAt||w.data?.observedAt;
  let content;
  if(s.view==="trace")content=renderTrace(s,w);
  else if(s.view==="requirements")content=renderRequirements(s,w);
  else if(s.view==="metrics")content='<section class="ui-card wb-reading">'+renderMetrics(s,w)+'</section>';
  else if(w.tab==="zentao")content='<section class="ui-card wb-reading">'+renderZentao(s,w)+'</section>';
  else if(recordTabs.has(w.tab))content=renderRecords(s,w);
  else content=empty("未接入");
  const read=uiStatus({label:s.mode==="demo"?"开发模式":w.loading?"正在读取":w.error?"读取失败":s.view==="trace"?"任务快照":w.data?"已读取记录":"待读取",tone:w.error?"warning":"neutral"});
  const tabs=uiTabs({items:workbenchTabs[s.view].map(([id,label])=>({id,label})),value:w.tab,action:"wb-tab",label:"业务工作区"});
  return '<div class="wb-workspace"><div class="wb-top">'+tabs+'<div class="row"><div class="wb-read-status" role="status">'+read+(observed?'<span>读取于 '+time(observed)+'（北京时间）</span>':"")+'</div>'+button("刷新","wb-refresh",'id="wb-refresh"',"default",w.loading)+'</div></div>'+(s.mode==="demo"?note("开发模式不读取外部系统或保存记录。"):w.error?'<div class="wb-error" role="alert">'+e(w.error)+(w.data?" · 保留最近读取记录，不保证新鲜度。":"")+'</div>':"")+content+'</div>';
}
