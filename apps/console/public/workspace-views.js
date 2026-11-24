/** Opt-in V20 components, using existing event handlers and API v1 snapshots. */
import { icon } from "./icons.js";
import { escapeHtml as e } from "./model.js";
import { uiButton, uiEmpty, uiStatus } from "./ui.js";
import { workspaceExecution, workspacePageNumbers } from "./workspace-model.js";

const time = (value) => {
  const date = new Date(value || "");
  return Number.isFinite(+date) ? new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date) : "未提供";
};
const progress = (value, compact = false) => value === null
  ? '<span class="v20-progress-unknown">未回传进度</span>'
  : `<span class="v20-progress ${compact ? "is-compact" : ""}"><progress max="100" value="${e(value)}" aria-label="服务端记录的任务进度"></progress><span>${e(value)}%</span></span>`;
export function renderWorkspaceExecutionInline(entry, state) {
  const v = workspaceExecution(entry, state);
  return `<span class="v20-execution-inline" title="${e(v.message)}">${v.stale ? "快照 · " : ""}${e(v.label)}${v.leaseExpired && !v.terminal ? " · 租约过期" : ""}</span>`;
}
export function renderWorkspaceTaskProgress(entry, state) {
  return `<div class="v20-task-progress">${progress(workspaceExecution(entry,state).progress,true)}</div>`;
}
export function renderWorkspaceExecutionDetail(entry, state) {
  const v = workspaceExecution(entry, state);
  const demo = state.mode === "demo";
  return `<section class="v20-execution-detail" aria-label="当前执行记录">
    <header class="v20-section-head"><h3>执行状态</h3>${uiStatus({label:demo ? "开发样例" : v.stale ? "最近快照 · 非实时" : "服务端快照",tone:v.stale ? "warning" : "neutral"})}</header>
    <div class="v20-current-execution"><span class="v20-current-icon">${icon(v.active ? "Activity" : v.attention ? "CircleAlert" : "Workflow",17)}</span><div><strong>${e(v.label)}</strong><p>${e(v.message)}</p></div></div>
    <div class="v20-execution-progress"><span>服务端进度</span>${progress(v.progress)}</div>
    <dl class="v20-execution-facts"><div><dt>服务端阶段</dt><dd>${e(v.phase)}</dd></div><div><dt>租约 Worker</dt><dd>${e(v.workerId || "未提供")}</dd></div><div><dt>租约到期（北京时间）</dt><dd>${time(v.leaseExpiresAt)}${v.leaseExpired ? " · 已到期" : ""}</dd></div><div><dt>快照时间（北京时间）</dt><dd>${time(v.observedAt)}</dd></div></dl>
    <p class="v20-observation-note">${demo ? "开发样例，不执行真实任务。" : "沿用现有 15 秒后台快照轮询；编辑、确认和断线时不强制刷新。Worker 心跳仅续租，未提供实时工具事件。"} </p>
    ${v.lastStep ? `<div class="v20-last-trace"><span>最后列出的回传步骤 · ${v.traceCount} 项</span><strong>${e(v.lastStep.title)}</strong><span>${e(v.lastStep.status)} · 历史记录，不代表当前操作</span></div>` : '<p class="v20-observation-note">尚无回传步骤。</p>'}
  </section>`;
}

export function renderWorkspacePager(list, prefix) {
  if (!["task", "activity"].includes(prefix)) return "";
  const task = prefix === "task";
  const { page, pageCount, pageSize, start, end, total } = list;
  const sizeId = task ? "task-page-size" : "activity-page-size";
  const action = task ? "task-page" : "activity-page";
  const sizes = task ? [10,20,50] : [10,15,20,50];
  const edge = (prev) => `<button type="button" id="${prefix}-page-${prev ? "prev" : "next"}" class="ui-icon-button tl-icon-button" data-action="${action}" data-page="${prev ? Math.max(1,page-1) : Math.min(pageCount,page+1)}" aria-label="${prev ? "上一页" : "下一页"}" ${(prev ? page<=1 : page>=pageCount) ? "disabled" : ""}>${icon(prev ? "ChevronLeft" : "ChevronRight",15)}</button>`;
  return `<footer class="v20-pager ${task ? "tl-pagination" : "adm-pagination"}"><div role="status" aria-live="polite">显示 ${start}–${end} 条，共 ${total} 条</div><div class="v20-pager-controls"><label class="v20-page-size" for="${sizeId}">每页 <select class="ui-select-input" id="${sizeId}" name="${sizeId}">${sizes.map((size)=>`<option value="${size}" ${size===pageSize ? "selected" : ""}>${size}</option>`).join("")}</select></label><nav aria-label="${task ? "任务" : "操作记录"}分页">${edge(true)}${workspacePageNumbers(page,pageCount).map((number)=>number==="gap" ? '<span aria-hidden="true">…</span>' : `<button type="button" id="${prefix}-page-${number}" class="ui-icon-button tl-page-button ${number===page ? "is-current" : ""}" data-action="${action}" data-page="${number}" aria-label="第 ${number} 页" ${number===page ? 'aria-current="page"' : ""}>${number}</button>`).join("")}${edge(false)}</nav></div></footer>`;
}

export function renderWorkspaceAttention(tasks, state) {
  const urgency = (entry) => entry.reconciliation?.status === "required" ? 0 : entry.execution?.cancelRequested ? 1 : entry.reviewState === "pending" ? 2 : 3;
  const entries = tasks.filter((entry)=>workspaceExecution(entry,state).attention)
    .sort((a,b)=>urgency(a)-urgency(b)||(Date.parse(b.task.metadata?.createdAt)||0)-(Date.parse(a.task.metadata?.createdAt)||0));
  return `<section class="report-card ui-card v20-attention" aria-label="需要处理"><header class="v20-section-head"><h2>需要处理 <span class="v20-small-count">${entries.length}</span></h2>${uiButton({label:"全部任务",icon:"ArrowUpRight",action:"navigate",attrs:'data-view="tasks"',variant:"ghost"})}</header>
    ${entries.length ? entries.slice(0,4).map((entry)=>{
      const v=workspaceExecution(entry,state);
      const review=entry.reviewState==="pending" && entry.reconciliation?.status!=="required" && !entry.execution?.cancelRequested && !v.terminal;
      return `<button type="button" class="v20-attention-row" data-action="${review ? "select-approval" : "open-task"}" data-id="${e(entry.task.id)}"><span class="v20-attention-mark ${entry.status?.status==="failed" ? "is-failed" : ""}"></span><span><strong>${e(entry.title)}</strong><small>${e(v.label)} · ${e(entry.task.id)}</small></span>${icon("ChevronRight",14)}</button>`;
    }).join("") : '<p class="v20-observation-note">当前时间范围内没有上述待处理任务。</p>'}
    ${entries.length>4 ? `<p class="v20-observation-note">还有 ${entries.length-4} 条，可在任务列表查看。</p>` : ""}
  </section>`;
}
export function renderWorkspaceApprovalEvidence(entry,state) {
  const p=entry.proposal;
  const checks=(value)=>Array.isArray(value) ? String(value.length) : "未提供";
  return `<section class="v20-approval-evidence" aria-label="候选与证据"><header class="v20-section-head"><h3>候选与证据</h3>${uiStatus({label:state.mode==="demo" ? "开发样例" : p ? "候选已回传" : "候选未提供"})}</header>
    <dl class="v20-execution-facts"><div><dt>候选标识</dt><dd>${e(p?.id || "未提供")}</dd></div><div><dt>提交时间（北京时间）</dt><dd>${time(p?.submittedAt)}</dd></div><div><dt>通过 / 失败检查记录</dt><dd>${checks(entry.evidence?.checksPass)} / ${checks(entry.evidence?.checksFail)}</dd></div><div><dt>候选哈希</dt><dd class="mono">${e(p?.contentHash || "未提供")}</dd></div></dl>
    <p class="v20-observation-note">候选证据不代表执行授权或最终执行成功。</p><div class="v20-evidence-actions">${uiButton({label:"验证证据",icon:"ShieldCheck",action:"open-task",attrs:`data-id="${e(entry.task.id)}" data-tab="evidence"`,variant:"ghost"})}${uiButton({label:"代码变更",icon:"FileDiff",action:"open-task",attrs:`data-id="${e(entry.task.id)}" data-tab="diff"`,variant:"ghost"})}</div></section>`;
}
export function renderWorkspaceEngines(state, engineName) {
  const s=state.snapshot, groups=new Map();
  for (const entry of s.tasks) {
    if (!groups.has(entry.engineId)) groups.set(entry.engineId,[]);
    groups.get(entry.engineId).push(entry);
  }
  const statusLabels={unavailable:"暂无在线执行器",idle:"可领取任务",running:"运行中",error:"连接异常"};
  return `<section class="v20-engine-workspace" aria-label="执行引擎"><div class="v20-engine-intro"><div><h2>引擎与任务</h2><p>${state.mode==="demo" ? "开发样例" : state.error ? "最近快照 · 连接异常" : "管理服务快照"} · ${time(s.generatedAt)}（北京时间）</p></div>${uiButton({label:"刷新",icon:"RefreshCw",action:"refresh",loading:state.loading||state.refreshing})}</div>
    ${s.engines.length ? s.engines.map((engine)=>{
      const active=(groups.get(engine.id)||[]).filter((entry)=>["running","pending"].includes(entry.status?.status)&&entry.reviewState!=="pending");
      const running=active.filter((entry)=>entry.status.status==="running");
      const label=Object.hasOwn(statusLabels,engine.status)?statusLabels[engine.status]:"状态未知";
      return `<article class="v20-engine-row"><header><div><h3>${e(engineName(engine.id))}</h3><p>${e(engine.type||"未提供类型")} · ${e(engine.model||"未配置模型")}</p></div>${uiStatus({label:state.error?"快照 · "+label:label,tone:state.error?"warning":engine.status==="running"?"info":engine.status==="idle"?"success":engine.status==="error"?"error":"neutral"})}</header>
        <div class="v20-engine-layout"><section><h4>任务分配 <span>${running.length} 运行 · ${active.length-running.length} 排队</span></h4>${active.length ? active.slice(0,5).map((entry)=>{
          const v=workspaceExecution(entry,state);
          return `<button type="button" class="v20-engine-task" data-action="open-task" data-id="${e(entry.task.id)}"><span><strong>${e(entry.title)}</strong><small>${e(v.label)} · ${e(v.workerId||"未提供租约 Worker")}</small></span>${icon("ChevronRight",14)}</button>`;
        }).join(""):'<p class="v20-observation-note">没有已分配的运行或排队任务。</p>'}
        ${active.length>5 ? `<p class="v20-observation-note">另有 ${active.length-5} 条任务。</p>` : ""}${uiButton({label:"查看全部任务",action:"navigate",attrs:'data-view="tasks"',variant:"ghost"})}</section>
        <section class="v20-engine-properties"><h4>连接与配置</h4><dl><div><dt>引擎 ID</dt><dd class="mono">${e(engine.id)}</dd></div><div><dt>最近通信判定</dt><dd>${e(engine.message||"未提供")}</dd></div><div><dt>关联规则</dt><dd>${uiButton({label:`${s.rules.filter((rule)=>rule.processor?.engine===engine.id).length} 条规则`,action:"navigate",attrs:'data-view="rules"',variant:"ghost"})}</dd></div></dl></section></div></article>`;
    }).join(""):uiEmpty({title:"尚无引擎配置",description:"连接管理服务后读取真实配置。"})}
    <p class="v20-observation-note">当前接口提供引擎级在线判定及任务租约，不提供完整 Worker 清单、CPU、内存、并发上限或独立心跳时间；不将配置存在当作在线。</p></section>`;
}
export function renderWorkspaceConnectionContext(state) {
  const s=state.snapshot;
  const label=state.mode==="demo"?"开发预览":state.loading?"读取中":state.error?"最近读取异常":s&&!state.authRequired?"管理配置已读取":"未连接";
  return `<div class="v20-connection-context"><div><strong>工作空间</strong><span>${e(s?.project?.repo||"尚未读取项目")}</span></div><div>${uiStatus({label,tone:state.error?"warning":"neutral"})}<small>${s?.apiVersion===1?"API v1 · ":""}${time(s?.generatedAt)}（北京时间）</small></div></div>`;
}
