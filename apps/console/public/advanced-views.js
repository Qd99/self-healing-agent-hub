import {e,head,note,empty,section,props,table,button,pager,search,uiSelect,options,time,uiStatus,canWrite} from "./workbench-view-kit.js";
import {matchingText,localPage,evaluationSummary,metricPlot} from "./workbench-model.js";
const esc=e;
const fmt=n=>Number.isFinite(n)?String(Math.round(n*100)/100):"—";
const tag=(v)=>uiStatus({label:({queued:"等待",running:"执行中",completed:"执行结束",failed:"失败",unknown:"待核对",reconciled:"已核对",cancelled:"已取消",firing:"触发",resolved:"已恢复",pass:"通过",deny:"拒绝","submitted-unverified":"已提交待核对",linked:"已关联",recorded:"已登记",created:"已创建"})[v]||v||"未知",tone:["failed","deny","firing"].includes(v)?"error":["queued","unknown","submitted-unverified"].includes(v)?"warning":["pass","resolved"].includes(v)?"success":"neutral"});
const field=(label,id,value="",type="text",required=true)=>'<label class="adv-field" for="'+id+'"><span>'+esc(label)+'</span><input id="'+id+'" name="'+id+'" class="ui-input" type="'+type+'" value="'+esc(value??"")+'" '+(required?"required":"")+'></label>';
const area=(label,id,value="")=>'<label class="adv-field" for="'+id+'"><span>'+esc(label)+'</span><textarea class="ui-textarea" id="'+id+'" name="'+id+'" rows="3" required>'+esc(value??"")+'</textarea></label>';
const confirmText=t=>'<label class="adv-check"><input type="checkbox" name="confirm" required> '+esc(t)+'</label>';
const submit=t=>'<button class="ui-button ui-button-primary" type="submit">'+esc(t)+'</button>';
const form=(id,body)=>'<form class="adv-form wb-form" id="'+id+'">'+body+'</form>';
const rowButton=(text,id)=>button(text,"adv-job",'data-id="'+esc(id)+'"',"ghost");
const stateForm=w=>w.advancedDraft||{};
function listPage(w,rows,headers,render){
  return '<div class="wb-tools">'+search(w)+'</div>'+(rows.length?table(headers,rows.map(render)):empty("没有匹配记录"))+pager(w.data?.page||w.page,(w.data?.page||1)<(w.data?.pageCount||1),"wb-page",w.data?.total??null);
}
function graph(w){
  const g=w.data?.graph;
  if(!g?.nodes?.length)return empty("暂无可绘制的 OTLP Span","Worker 阶段事件与已接收的 Span 分开显示，不推断父子关系。");
  const nodes=g.nodes.slice(-40),all=new Map(g.nodes.map(n=>[n.traceId+":"+n.spanId,n])),visible=new Set(nodes.map(n=>n.traceId+":"+n.spanId));
  const levels=new Map(),parents=new Map(g.parents.map(x=>[x.to,x.from]));
  for(const key of g.order){const p=parents.get(key);levels.set(key,p&&levels.has(p)?levels.get(p)+1:0);}
  const groups=new Map();
  for(const n of nodes){const key=n.traceId+":"+n.spanId,level=Math.min(5,levels.get(key)??0);if(!groups.has(level))groups.set(level,[]);groups.get(level).push(n);}
  const pos=new Map();let maxRows=1;
  for(const [level,list] of groups){maxRows=Math.max(maxRows,list.length);list.forEach((n,i)=>pos.set(n.traceId+":"+n.spanId,[16+level*160,14+i*52]));}
  const maxLevel=Math.max(...groups.keys()),width=Math.max(360,16+(maxLevel+1)*160),height=Math.max(100,20+maxRows*52);
  const edges=[...g.parents,...g.links].filter(x=>visible.has(x.from)&&visible.has(x.to));
  const lines=edges.map(x=>{const a=pos.get(x.from),b=pos.get(x.to);return '<path d="M'+(a[0]+140)+' '+(a[1]+18)+' C'+(a[0]+152)+' '+(a[1]+18)+' '+(b[0]-10)+' '+(b[1]+18)+' '+b[0]+' '+(b[1]+18)+'" fill="none" stroke="currentColor" opacity=".45" '+(x.kind==="link"?'stroke-dasharray="4 3"':"")+'/>';}).join("");
  const rects=nodes.map(n=>{const key=n.traceId+":"+n.spanId,[x,y]=pos.get(key);return '<g><title>'+esc(n.agent+" · "+n.stage+" · "+key)+'</title><rect x="'+x+'" y="'+y+'" width="140" height="36" rx="5" fill="var(--surface)" stroke="'+(n.status===2?"var(--red)":"var(--line)")+'"/><text x="'+(x+8)+'" y="'+(y+14)+'" font-size="10" fill="currentColor">'+esc(n.stage.slice(0,21))+'</text><text x="'+(x+8)+'" y="'+(y+27)+'" font-size="9" fill="currentColor" opacity=".65">'+esc(n.agent.slice(0,20))+'</text></g>';}).join("");
  const min=Math.min(...nodes.map(n=>n.startMs)),max=Math.max(...nodes.map(n=>n.endMs)),span=Math.max(1,max-min);
  const rows=nodes.slice().sort((a,b)=>a.startMs-b.startMs).map(n=>{
    const id=n.traceId+":"+n.spanId,left=(n.startMs-min)*100/span,width=(n.endMs-n.startMs)*100/span;
    return [button(n.stage,"adv-span",'data-id="'+esc(id)+'"'),esc(n.agent),'<div class="adv-waterfall"><span style="left:'+left+'%;width:'+Math.max(.5,width)+'%"></span></div>',esc(fmt(n.endMs-n.startMs)+" ms"),n.status===2?tag("failed"):uiStatus({label:n.status===1?"OTLP OK":"未设置"})];
  });
  const selected=all.get(w.advancedSpan);
  return note("实线为实际 parent，虚线为 span link；缺失引用 "+g.missing.length+"，父边环路 "+(g.cycle?"存在":"无")+"。图最多绘制最近 40 个节点，完整性始终为 partial。")+'<div class="adv-graph"><svg viewBox="0 0 '+width+' '+height+'" width="'+width+'" role="img" aria-label="跨 Agent 因果图">'+lines+rects+'</svg></div>'+section("Trace 瀑布图",table(["Span","Agent","时间位置","耗时","观测状态"],rows))+(selected?section("Span 详情",props([["Trace ID",selected.traceId],["Span ID",selected.spanId],["Parent",selected.parentSpanId],["Agent",selected.agent],["开始",time(selected.startMs)],["结束",time(selected.endMs)],["关联数",selected.links.length]])):"");
}
function trace(w){
  const d=w.data||{},draft=stateForm(w);
  const replay=w.advancedUntil!==null&&w.advancedUntil!==undefined;
  const controls=form("adv-trace-form",field("Workflow ID（留空查看全部事件）","workflow",draft.workflow??w.advancedWorkflow??"","text",false)+submit("查询"));
  const player=d.latest?'<div class="adv-replay"><span>'+esc(replay?"回放游标 "+w.advancedUntil:"跟随最新")+'</span><input type="range" id="adv-replay" min="0" max="'+d.latest+'" value="'+(replay?Math.min(w.advancedUntil,d.latest):d.latest)+'" aria-label="事件回放游标">'+button("跟随最新","adv-live")+'</div>':"";
  const events=(d.items||[]).filter(x=>matchingText([x.workflow,x.agent,x.stage,x.source],w.query));
  const rows=events.map(x=>[esc(x.cursor),button(x.workflow,"adv-workflow-pick",'data-id="'+esc(x.workflow)+'"'),esc(x.agent),esc(x.stage),esc(x.source),esc(x.state??(x.status===2?"error":"span")),time(x.receivedAt),x.bundle?esc("知识 "+x.bundle.items.length+" 项 / "+x.bundle.digest.slice(0,12)):x.usage?esc(JSON.stringify(x.usage)):"—"]);
  return head("持久全链路 · 只读回放")+controls+player+note("使用接收游标回放已持久记录，不会重新执行。没有采集的 Agent、日志和事件保持未知。")+graph(w)+section("事件时间线",search(w)+(rows.length?table(["游标","Workflow","Agent","阶段","来源","状态","接收时间","摘要"],rows):empty("未收到事件"))+'<div class="wb-pager">'+button("返回起点","adv-trace-reset")+button("下一批","adv-trace-next",'data-after="'+esc(d.cursor??0)+'"',"default",!d.hasMore)+'</div>');
}
function runTable(run,w,title){
  if(!run)return "";
  const rows=run.results.filter(x=>matchingText([x.id,x.result],w.advancedCaseQuery||"")&&(w.advancedResult==="all"||!w.advancedResult||x.result===w.advancedResult));
  const p=localPage(rows,w.advancedCasePage||1,15);
  const counts={};for(const x of run.results)counts[x.result]=(counts[x.result]??0)+1;
  return section(title,props([["Commit",run.sha],["Tree",run.tree],["测试指纹",run.testTreeDigest],["完整",run.complete?"是":"否"],["工作区干净",run.clean?"是":"否"],["退出码",run.exitCode],["样本尝试",run.results.length]])+note(Object.entries(counts).map(([k,v])=>k+": "+v).join(" · "))+table(["用例 ID","轮次","结果","断言失败","耗时"],p.items.map(x=>[esc(x.id),esc(x.attempt),tag(x.result),x.assertion?"是":"否",esc(fmt(x.durationMs)+" ms")]))+pager(p.page,p.page<p.pageCount,"adv-case-page",p.total));
}
function evaluation(result,w){
  const stats=evaluationSummary(result.samples);
  const sample=localPage(result.samples,w.advancedCasePage||1,15);
  const aggregate=side=>{const rows=result.samples,values=rows.map(x=>x[side+"Micros"]);return values.some(x=>x==null)?"未知":fmt(values.reduce((a,b)=>a+b,0)/1000000)+" USD（按配置费率估算）";};
  const bars=[["基线",stats.baselinePass],["候选",stats.candidatePass]].map(([k,v])=>'<div class="wb-bar-row"><span>'+k+'</span><progress max="'+Math.max(1,stats.total)+'" value="'+v+'"></progress><span>'+v+'</span></div>').join("");
  return section("独立模型评估",bars+props([["全部样本",stats.total],["可比较",stats.paired],["退化 / 改善",stats.regressions+" / "+stats.improvements],["基线估算费用",aggregate("baseline")],["候选估算费用",aggregate("candidate")],["费率指纹",result.rateDigest],["数据集指纹",result.datasetDigest]])+note("所有样本保留；未知和超预算不会被移除，不触发模型推广。")+table(["样本","轮次","基线","候选","延迟 ms","Token"],sample.items.map(x=>[esc(x.caseId),esc(x.trial),tag(x.baseline),tag(x.candidate),esc(fmt(x.baselineMs)+" / "+fmt(x.candidateMs)),esc(fmt(x.baselineTokens)+" / "+fmt(x.candidateTokens))]))+pager(sample.page,sample.page<sample.pageCount,"adv-case-page",sample.total));
}
function radar(result,w,s){
  const rows=result.candidates||[],draft=stateForm(w);
  let body=table(["来源","外部 SHA / 本仓 SHA","路径证据","已匹配需求"],rows.map((x,i)=>[button(x.repo,"adv-radar-pick",'data-index="'+i+'"'),esc(x.sourceSha.slice(0,12)+" / "+x.baselineSha.slice(0,12)),esc(x.paths.map(p=>p.path+" ["+(p.external?"外部有":"外部无")+"/"+(p.local?"本仓有":"本仓无")+"]").join("；")),esc(x.issueMatches.join(", ")||"未匹配")]));
  const c=rows[w.advancedRadarIndex];
  if(c&&canWrite(s))body+=section("登记待评审需求",note("路径差异仅是候选证据。需人工确认 REQ/AC/TC 和影响范围；服务端再次查重、核对基线和配额。")+form("adv-radar-form",field("候选索引","index",w.advancedRadarIndex,"number")+field("需求标题","title",draft.title)+area("需求 REQ","requirements",draft.requirements)+area("验收 AC","acceptance",draft.acceptance)+area("测试 TC","tests",draft.tests)+area("影响范围","impact",draft.impact)+confirmText("确认登记为待评审 Issue，不授权开发")+submit("登记需求")));
  return section("自动调研证据",note(result.complete?"来源与历史分页已读取；仅为路径级差异。":"来源不完整，禁止登记。")+body);
}
function jobDetails(s,w){
  const j=w.advancedDetail;if(!j)return empty("选择一条执行记录","查看真实执行结果、证据和外部关联。");
  let body=head(j.profile,tag(j.state))+props([["作业 ID",j.id],["执行器",j.worker],["类型",j.kind],["创建",time(j.createdAt)],["完成",time(j.finishedAt)],["策略指纹",j.policy?.policyDigest]]);
  if(j.binding)body+=section("候选绑定",props([["任务",j.binding.taskId],["候选",j.binding.proposalId],["Base",j.binding.baseSha],["Tree",j.binding.treeSha],["审批轮次",j.binding.round]]));
  if(j.result?.verdict)body+=section("红绿差分门禁",tag(j.result.verdict.verdict)+note(j.result.verdict.reason)+note("证据 ID："+j.result.evidenceId));
  if(j.result?.run||j.result?.baseline||j.result?.candidate)body+='<div class="wb-tools"><input type="search" id="adv-case-query" class="ui-input" aria-label="搜索用例" placeholder="搜索用例 ID" value="'+esc(w.advancedCaseQuery||"")+'">'+uiSelect({id:"adv-case-result",label:"结果筛选",value:w.advancedResult||"all",options:options([["all","全部"],["pass","通过"],["fail","失败"],["skip","跳过"],["error","异常"],["timeout","超时"],["cancelled","取消"],["unknown","未知"]])})+'</div>';
  if(j.result?.run)body+=runTable(j.result.run,w,"执行报告");
  if(j.result?.baseline)body+=runTable(j.result.baseline,w,"修复前 · 红");
  if(j.result?.candidate)body+=runTable(j.result.candidate,w,"修复后 · 绿");
  if(j.kind==="evaluation"&&j.result)body+=evaluation(j.result,w);
  if(j.kind==="radar"&&j.result)body+=radar(j.result,w,s);
  if(j.state==="running"&&canWrite(s))body+=section("执行控制",j.cancelRequested?note("已请求取消，等待 Runner 清理确认。"):form("adv-cancel-job-form",confirmText("请求停止此 QA 作业；等待资源清理确认")+submit("请求取消")));
  if(["queued","unknown"].includes(j.state)&&canWrite(s))body+=section("人工处置",form("adv-reconcile-form",field("核对说明","note",stateForm(w).note)+confirmText("确认未执行或已核对资源和外部结果；不会自动重试")+submit(j.state==="queued"?"取消等待作业":"记录人工核对")));
  return body;
}
function jobs(s,w){
  const profiles=w.advancedProfiles?.profiles||[],draft=stateForm(w),viewKinds=w.tab==="advanced-evaluations"?["evaluation"]:w.tab==="advanced-radar"?["radar"]:["test","red-green"],available=profiles.filter(x=>viewKinds.includes(x.kind));
  const rows=(w.data?.items||[]).filter(x=>viewKinds.includes(x.kind)&&matchingText([x.id,x.profile,x.state,x.kind],w.query));
  const selected=draft.profile??available[0]?.id??"",profile=available.find(x=>x.id===selected);
  const choose=uiSelect({id:"adv-profile",label:"执行配置",value:selected,options:available.map(x=>({value:x.id,label:x.id+" · "+x.kind}))});
  const candidates=(s.snapshot?.tasks||[]).filter(t=>t.proposal?.version===2&&t.approvalFlow);
  const task=uiSelect({id:"adv-task",label:"关联 v2 候选",value:draft.taskId??"",options:[{value:"",label:"请选择候选"},...candidates.map(t=>({value:t.task.id,label:t.title}))]});
  const enqueue=canWrite(s)&&available.length?form("adv-enqueue-form",choose+(profile?.kind==="red-green"?task:"")+confirmText("确认按服务端固定执行配置入队；不直接发布")+submit("加入执行队列")):note("暂无可用执行配置；在服务端配置独立 Runner。");
  const list=head("独立执行调度")+enqueue+listPage(w,rows,["执行配置","类型","状态","创建时间","操作"],x=>[esc(x.profile),esc(x.kind),tag(x.state),time(x.createdAt),rowButton("详情",x.id)]);
  return '<div class="adv-job-layout"><section class="ui-card wb-reading">'+list+'</section><section class="ui-card wb-reading">'+jobDetails(s,w)+'</section></div>';
}
function effects(s,w){
  const d=stateForm(w),rows=(w.data?.items||[]).filter(x=>matchingText(x,w.query));
  let formHtml="";
  if(canWrite(s))formHtml=form("adv-effect-form",uiSelect({id:"adv-effect-kind",label:"操作",value:d.effectKind||"zentao-sync",options:options([["zentao-sync","回写测试结果"],["zentao-bug","关联现有 Bug"],["zentao-retest","登记缺陷复验"]])})+field("QA 作业 ID","jobId",d.jobId)+field("禅道用例 ID","caseId",d.caseId,"number")+field("用例版本","caseVersion",d.caseVersion,"number")+(d.effectKind&&d.effectKind!=="zentao-sync"?field("缺陷 ID","bugId",d.bugId,"number"):"")+confirmText("确认对已配置禅道产品执行该操作")+submit("提交"));
  const selected=rows.find(x=>x.id===w.advancedEffectId);
  const reconcile=selected&&canWrite(s)?form("adv-reconcile-effect-form",uiSelect({id:"adv-effect-outcome",label:"实际核对结果",value:d.effectOutcome||"verified",options:options([["verified","已核实生效"],["not-applied","确认未生效"]])})+field("核对说明","note",d.note)+confirmText("已在外部系统核对；不重新发送原请求")+submit("保存核对")):"";
  return head("外部回执与缺陷复验")+reconcile+note("使用独立 QA 作业及版本映射。未知写入结果不自动重试；复验不自动关闭 Bug。")+formHtml+listPage(w,rows,["类型","状态","关联详情","时间","操作"],x=>[esc(x.kind),tag(x.state),esc(JSON.stringify(x.details)),time(x.at),["unknown","submitted-unverified"].includes(x.state)&&canWrite(s)?button("核对","adv-effect-pick",'data-id="'+esc(x.id)+'"'):"—"]);
}
function evidence(w){
  const rows=(w.data?.items||[]).filter(x=>matchingText(x,w.query));
  return head("独立 QA 证据账本")+note("绑定候选哈希、树、审批轮次与策略；只读记录，不直接授权。")+listPage(w,rows,["候选 / 任务","策略","结论","生产者","时间"],x=>[esc(x.taskId)+"<small>"+esc(x.contentHash)+"</small>",esc(x.profile)+"<small>"+esc(x.policyDigest)+"</small>",tag(x.verdict.verdict)+"<small>"+esc(x.verdict.reason)+"</small>",esc(x.producer),time(x.at)]);
}
function monitoring(w){
  const rows=(w.data?.items||[]).filter(x=>matchingText(x,w.query));
  if(w.tab==="advanced-alerts")return head("告警状态历史")+note("只记录已观测到的状态转换；上游不可用不会自动将故障标为恢复。")+listPage(w,rows,["告警规则","状态","时间"],x=>[esc(x.key),tag(x.state),time(x.at)]);
  const series=[...(w.data?.items||[])].reverse(),metric=w.advancedMetric||"p95Ms",points=series.map(x=>[Date.parse(x.at),x.hub?.[metric]??null]);
  const plot=points.length>=2?metricPlot(points,points[0][0],points.at(-1)[0]):null;
  const chart=plot?'<svg viewBox="0 0 740 210" class="wb-metric-chart" role="img" aria-label="服务采样趋势">'+plot.segments.map(seg=>'<polyline transform="translate(20,10)" fill="none" stroke="var(--blue)" stroke-width="2" points="'+seg.map(x=>x.join(",")).join(" ")+'"/>').join("")+'</svg>':empty("采样不足");
  const selected=rows.find(x=>x.at===w.advancedSample)||rows[0];
  return head("服务级性能采样")+uiSelect({id:"adv-metric",label:"Hub 指标",value:metric,options:options([["p95Ms","P95 请求耗时"],["rssBytes","Hub RSS"],["requests","累计请求"],["serverErrors","累计服务端错误"],["cpuMs","CPU 累计毫秒"]])})+chart+note("趋势为当前页已存采样；进程 CPU 为累计时间，非 CPU 百分比。")+listPage(w,rows,["时间","P95 ms","排队 / 运行","Worker 采样","Jenkins"],x=>[button(time(x.at),"adv-sample",'data-id="'+esc(x.at)+'"'),esc(fmt(x.hub.p95Ms)),esc(x.queue.pending+" / "+x.queue.running),esc(x.workers.length),esc(x.jenkins.state+" · "+(x.jenkins.lastCompleted?.result??"—"))])+(selected?section("采样详情",props([["Hub RSS",selected.hub.rssBytes],["Hub CPU ms",selected.hub.cpuMs],["Jenkins 最后构建",selected.jenkins.lastBuild?.number],["Jenkins 排队",selected.jenkins.inQueue==null?"未知":String(selected.jenkins.inQueue)]])+table(["Worker","RSS bytes","CPU ms","观测时间"],selected.workers.map(x=>[esc(x.agent),esc(fmt(x.rssBytes)),esc(fmt(x.cpuMs)),time(x.at)]))):"");
}
export function renderAdvanced(s,w){
  const enabled=w.advancedProfiles?.enabled;
  if(enabled===false)return '<section class="ui-card wb-reading">'+empty("高级能力未启用","按交接文档配置独立凭据与运行策略。")+'</section>';
  if(["advanced-jobs","advanced-evaluations","advanced-radar"].includes(w.tab))return jobs(s,w);
  const body=w.tab==="advanced-trace"?trace(w):w.tab==="advanced-effects"?effects(s,w):w.tab==="advanced-evidence"?evidence(w):monitoring(w);
  return '<section class="ui-card wb-reading">'+body+'</section>';
}
