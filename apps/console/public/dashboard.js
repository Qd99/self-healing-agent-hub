import { icon } from "./icons.js";
import {
  escapeHtml as e,
  filterTasks,
  getMetrics,
  getTrend,
  formatDuration,
} from "./model.js";
import { renderFlowCanvas, renderApprovalTeaser } from "./approval-views.js";
import { getApprovalFlow } from "./approvals.js";
import { uiEmpty, uiStatus } from "./ui.js";

const names = {
  running: "运行中",
  pending: "排队中",
  completed: "已完成",
  failed: "需关注",
  cancelled: "已取消",
  skipped: "已跳过",
};
const typeIcons = {
  "type-error": "Code2",
  "lint-error": "Wrench",
  "unit-test-failure": "FlaskConical",
  "dependency-issue": "Box",
  "ci-failure": "GitPullRequest",
  "doc-outdated": "FileCode2",
};
const engineName = (id) => (id === "fast" ? "Direct AI" : "ZCode Workflow");
const date = (at) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
const empty = (title, text) =>
  uiEmpty({
    icon: "Inbox",
    title,
    description: text,
    className: "studio-empty",
  });

function miniTrend(tasks, days) {
  const trend = getTrend(tasks, { days });
  const max = Math.max(1, ...trend.map((d) => d.completed + d.failed));
  return `<div class="studio-trend" role="img" aria-label="${e(trend.map((d) => `${d.label}：完成${d.completed}，失败${d.failed}`).join("；"))}">${trend.map((d) => `<div class="studio-trend-day" title="${e(d.label)} · 完成 ${d.completed} / 失败 ${d.failed}"><span style="height:${Math.max(2, Math.round((28 * d.completed) / max))}px"></span>${d.failed ? `<i style="height:${Math.max(2, Math.round((28 * d.failed) / max))}px"></i>` : ""}</div>`).join("")}</div>`;
}

function metric(glyph, tone, label, value, detail, decoration = "") {
  return `<div class="studio-metric"><span class="icon-tile ${tone}">${icon(glyph, 20)}</span><div><span class="studio-metric-label">${label}</span><div class="studio-metric-reading"><strong>${value}</strong><span>${detail}</span></div></div>${decoration}</div>`;
}

function taskRow(item) {
  const review = item.reviewState === "pending";
  const status = review ? "review" : item.status.status;
  const glyph = typeIcons[item.task.type] || "ListChecks";
  const canReview = !!item.approvalFlow;
  const badge = uiStatus({
    label: review ? "待审批" : names[status] || "未知",
    tone:
      status === "completed"
        ? "success"
        : status === "failed"
          ? "error"
          : status === "review"
            ? "warning"
            : status === "running"
              ? "info"
              : "neutral",
    icon:
      status === "completed"
        ? "CircleCheck"
        : status === "review"
          ? "UserRoundCheck"
          : status === "running"
            ? "Activity"
            : status === "failed"
              ? "CircleAlert"
              : "Clock3",
    className: `studio-state ${status}`,
  });
  return `<button class="studio-task" data-action="${review && canReview ? "select-approval" : "open-task"}" data-id="${e(item.task.id)}"><span class="task-type-icon ${status === "running" ? "blue" : status === "review" ? "violet" : status === "failed" ? "rose" : "neutral"}">${icon(glyph, 19)}</span><span class="studio-task-main"><strong>${e(item.title)}</strong><span><code>${e(item.task.id)}</code><i></i>${e(engineName(item.engineId))}${item.diff.length ? `<i></i>${item.diff.length} 个文件` : ""}</span></span>${badge}<time>${date(item.task.metadata.createdAt)}</time><span class="task-open-arrow">${icon("ArrowUpRight", 15)}</span></button>`;
}

function enginePanel(s) {
  return `<section class="ui-card glass-panel studio-engines"><div class="panel-heading"><span class="row"><span class="section-icon blue">${icon("Bot", 17)}</span><h2>Agent 引擎</h2></span><button class="ui-button ui-button-ghost text-button" data-action="navigate" data-view="engines">管理 ${icon("ArrowUpRight", 13)}</button></div><div class="studio-engine-list">${s.snapshot.engines
    .map((en, i) => {
      const running = s.snapshot.tasks.filter(
        (t) => t.engineId === en.id && t.status.status === "running",
      ).length;
      return `<button class="studio-engine" data-action="navigate" data-view="engines"><span class="engine-avatar ${i ? "violet" : "blue"}">${icon(i ? "Workflow" : "Zap", 21)}</span><span class="grow"><strong>${e(engineName(en.id))}</strong><small>${i ? "多步骤诊断与修复" : "轻量代码检查与修复"}</small></span><span class="engine-caption">${s.mode === "demo" ? (running ? `<span class="signal-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${running} 个演示任务` : "演示配置") : "未接入"}</span></button>`;
    })
    .join(
      "",
    )}</div><div class="engine-footnote">${icon("Fingerprint", 13)}${s.mode === "demo" ? "演示工作区 · 模型请求未实际发送" : "只读配置 · 等待连接执行器"}</div></section>`;
}

function recentActivity(s) {
  return `<section class="ui-card glass-panel studio-recent"><div class="panel-heading"><span class="row"><span class="section-icon cyan">${icon("Activity", 17)}</span><h2>最近活动</h2></span><button class="ui-button ui-button-ghost text-button" data-action="navigate" data-view="activity">全部 ${icon("ArrowRight", 13)}</button></div><div class="studio-activity-list">${
    s.snapshot.activity.length
      ? s.snapshot.activity
          .slice(0, 3)
          .map(
            (a) =>
              `<div class="studio-activity"><span class="activity-glyph ${a.level === "error" ? "rose" : "blue"}">${icon(a.level === "error" ? "CircleAlert" : a.level === "warning" ? "UserRoundCheck" : "CheckCheck", 13)}</span><div><p>${e(a.message)}</p><span>${e(a.actor || "系统")} · ${date(a.at)}</span></div></div>`,
          )
          .join("")
      : empty("还没有活动", "任务与审批的状态变化会记录在这里。")
  }</div></section>`;
}

export function renderStudioDashboard(s) {
  const all = filterTasks(s.snapshot.tasks, { days: s.days });
  const m = getMetrics(all);
  const reviews = all.filter((t) => t.reviewState === "pending");
  const current =
    reviews.find((t) => t.approvalFlow) || all.find((t) => t.approvalFlow);
  const flow = current ? getApprovalFlow(current) : null;
  const running = all.filter(
    (t) =>
      t.status.status === "running" ||
      (t.status.status === "pending" && t.reviewState !== "pending"),
  );
  let list =
    s.overviewTab === "review"
      ? reviews
      : s.overviewTab === "running"
        ? running
        : all;
  list = list.slice(0, 5);
  return `<div class="studio-overview-tools"><div class="studio-section-label">${icon("Activity", 14)}运行概览<span>${all.length} 项任务</span></div><label class="row muted">${icon("CalendarDays", 13)}<select class="ui-select-input" id="period" aria-label="时间范围">${[
    [1, "今天"],
    [7, "近 7 天"],
    [30, "近 30 天"],
  ]
    .map(
      ([n, label]) =>
        `<option value="${n}" ${s.days === n ? "selected" : ""}>${label}</option>`,
    )
    .join("")}</select></label></div>
    <section class="ui-card glass-panel studio-metrics" aria-label="运行统计">${metric("Activity", "blue", "运行与排队", running.length, "项任务")}${metric("UserRoundCheck", "violet", "等待审批", reviews.length, "项请求")}${metric("CircleCheck", "mint", "修复成功率", m.successRate === null ? "—" : `${m.successRate.toFixed(1)}<small>%</small>`, "", miniTrend(all, s.days))}${metric("Clock3", "peach", "平均修复耗时", formatDuration(m.averageDurationMs), "")}</section>
    <section class="ui-card glass-panel studio-flow-section"><div class="panel-heading"><span class="row"><span class="section-icon violet">${icon("Workflow", 18)}</span><span><h2>自愈流程</h2><span class="panel-subtitle">${current ? e(current.title) : "从诊断到审批，追踪每一步修复"}</span></span></span><div class="row">${uiStatus({ label: flow?.status === "pending" ? "等待人工审批" : flow?.status === "approved" ? "已授权，等待执行" : "流程概览", tone: flow?.status === "pending" ? "warning" : flow?.status === "approved" ? "success" : "neutral", icon: flow?.status === "pending" ? "UserRoundCheck" : "Clock3", className: "studio-state" })}${current ? `<button class="ui-button btn compact glass-action" data-action="select-approval" data-id="${e(current.task.id)}">查看审批流 ${icon("ArrowUpRight", 14)}</button>` : ""}</div></div>${current ? renderFlowCanvas(current, { compact: true, mode: s.mode, selectedNodeId: flow.currentNodeId, zoom: 1 }) : empty("暂无待处理流程", "接入执行器后，任务与审批节点将在这里呈现。")}<div class="studio-flow-footer"><div class="row"><span class="flow-legend completed"></span>已完成<span class="flow-legend current"></span>当前节点<span class="flow-legend blocked"></span>等待前序</div><span>${icon("MousePointer2", 12)}点击节点查看审批详情</span></div></section>
    <div class="studio-lower-grid"><div class="studio-left-stack"><section class="ui-card glass-panel studio-tasks"><div class="panel-heading"><span class="row"><span class="section-icon blue">${icon("ListChecks", 17)}</span><h2>任务动态</h2></span><button class="ui-button ui-button-ghost text-button" data-action="navigate" data-view="tasks">查看全部 ${icon("ArrowUpRight", 13)}</button></div><div class="ui-tabs studio-task-tabs" role="tablist" aria-label="工作台视图">${[
      ["focus", "全部任务", all.length],
      ["review", "待审批", reviews.length],
      ["running", "运行与排队", running.length],
    ]
      .map(
        ([id, label, count]) =>
          `<button class="ui-tab" role="tab" aria-selected="${s.overviewTab === id}" tabindex="${s.overviewTab === id ? 0 : -1}" data-action="overview-tab" data-tab="${id}">${label}<span>${count}</span></button>`,
      )
      .join(
        "",
      )}</div><div class="studio-task-list">${list.length ? list.map(taskRow).join("") : empty("当前没有任务", "其他状态的任务可以在全部任务中查看。")}</div></section>${enginePanel(s)}</div><aside class="studio-right-stack">${current ? renderApprovalTeaser(current, s) : `<section class="ui-card glass-panel">${empty("没有待审批请求", "需要人工确认的方案会显示在这里。")}</section>`}${recentActivity(s)}</aside></div>`;
}
