import { icon } from "./icons.js";
import {
  escapeHtml as e,
  filterTasks,
  getMetrics,
  getTrend,
  formatDuration,
} from "./model.js";
import { getApprovalFlow } from "./approvals.js";
import {
  administrationEngineName,
  describeActivity,
} from "./administration-model.js";
import { uiButton, uiEmpty, uiMetric, uiStatus, uiTabs } from "./ui.js";

const statusNames = {
  running: "运行中",
  pending: "排队中",
  completed: "已完成",
  failed: "需关注",
  cancelled: "已取消",
  skipped: "已跳过",
  review: "待审批",
};
const typeIcons = {
  "type-error": "Code2",
  "lint-error": "Wrench",
  "format-error": "FileCode2",
  "unit-test-failure": "FlaskConical",
  "e2e-test-failure": "FlaskConical",
  "dependency-issue": "Box",
  "ci-failure": "GitPullRequest",
  "doc-outdated": "FileCode2",
  "security-issue": "ShieldCheck",
  "architecture-violation": "Workflow",
  "performance-regression": "Activity",
};
const dateOptions = {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};
const shortDate = new Intl.DateTimeFormat("zh-CN", dateOptions);
const fullDate = new Intl.DateTimeFormat("zh-CN", {
  ...dateOptions,
  year: "numeric",
});
const timestamp = (at) => {
  const value = Date.parse(at || "");
  return Number.isFinite(value) ? value : -Infinity;
};

function timeLabel(at, className = "") {
  const value = timestamp(at);
  if (!Number.isFinite(value))
    return `<span class="${e(className)}" title="时间未提供">—</span>`;
  const date = new Date(value);
  return `<time class="${e(className)}" datetime="${e(date.toISOString())}" title="${e(fullDate.format(date))} · 北京时间">${e(shortDate.format(date))}</time>`;
}

function taskStatus(item) {
  const status = item.reviewState === "pending" ? "review" : item.status.status;
  const tones = {
    completed: "success",
    failed: "error",
    review: "warning",
    running: "info",
  };
  const icons = {
    completed: "CircleCheck",
    failed: "CircleAlert",
    review: "UserRoundCheck",
    running: "Activity",
    pending: "Clock3",
    cancelled: "Square",
    skipped: "ArrowRight",
  };
  return uiStatus({
    label: statusNames[status] || "未知状态",
    tone: tones[status] || "neutral",
    icon: icons[status] || "Circle",
    className: "home-task-status",
  });
}

function taskRow(item) {
  const review = item.reviewState === "pending" && item.approvalFlow;
  const files = item.diff?.length || 0;
  return `<button type="button" class="home-task-row" data-action="${review ? "select-approval" : "open-task"}" data-id="${e(item.task.id)}">
    <span class="home-task-glyph" aria-hidden="true">${icon(typeIcons[item.task.type] || "ListChecks", 18)}</span>
    <span class="home-task-copy"><strong title="${e(item.title)}">${e(item.title)}</strong><span class="home-task-meta"><code>${e(item.task.id)}</code><span>${e(administrationEngineName(item.engineId))}</span>${files ? `<span>${files} 个文件</span>` : ""}</span></span>
    ${taskStatus(item)}
    ${timeLabel(item.task.metadata.createdAt, "home-task-time")}
    <span class="home-task-arrow" aria-hidden="true">${icon("ChevronRight", 14)}</span>
  </button>`;
}

function approvalRequest(item) {
  const flow = getApprovalFlow(item);
  const gates = flow.nodes.filter((node) => node.kind === "human");
  const stageNames = {
    completed: "已通过",
    pending: "待处理",
    blocked: "等待前序",
    rejected: "已拒绝",
    cancelled: "已取消",
    unknown: "状态未提供",
  };
  const stages =
    flow.status === "unavailable"
      ? '<span class="home-review-unavailable">审批证据未提供</span>'
      : `<span class="home-review-stages" aria-label="${e(gates.map((gate) => `${gate.title}：${stageNames[gate.status] || "状态未提供"}`).join("；"))}">${gates
          .map((gate, index) => {
            const current = flow.currentGate?.id === gate.id;
            return `<span class="home-review-stage ${current ? "is-current" : gate.status === "completed" ? "is-complete" : ""}" ${current ? 'aria-current="step"' : ""}><span class="home-stage-number" aria-hidden="true">${gate.status === "completed" ? icon("Check", 10) : index + 1}</span><span>${e(gate.title)}</span></span>`;
          })
          .join("")}</span>`;
  return `<button type="button" class="home-review" data-action="${item.approvalFlow ? "select-approval" : "open-task"}" data-id="${e(item.task.id)}">
    <span class="home-review-title">${e(item.title)}${icon("ArrowUpRight", 13)}</span>
    <span class="home-review-meta"><code>${e(item.task.id)}</code>${flow.currentGate ? `<span>等待${e(flow.currentGate.title)}</span>` : ""}</span>
    ${stages}
  </button>`;
}

function approvalsPanel(reviews) {
  return `<section class="home-rail-section home-approvals" aria-labelledby="home-approvals-title">
    <div class="home-rail-heading"><h2 id="home-approvals-title">${icon("GitPullRequestArrow", 16)}待审批</h2><span class="home-rail-count">${reviews.length}</span></div>
    ${reviews.length ? `<div class="home-review-list">${reviews.slice(0, 2).map(approvalRequest).join("")}</div>` : '<p class="home-rail-empty">当前范围没有待审批请求</p>'}
    ${uiButton({ label: "审批中心", icon: "ArrowUpRight", action: "navigate", attrs: 'data-view="approvals"', variant: "ghost", className: "home-rail-link" })}
  </section>`;
}

function recentActivity(s) {
  const entries = [...s.snapshot.activity]
    .sort((a, b) => timestamp(b.at) - timestamp(a.at))
    .slice(0, 3);
  return `<section class="home-rail-section home-records" aria-labelledby="home-records-title">
    <div class="home-rail-heading"><h2 id="home-records-title">${icon("History", 16)}最近记录</h2>${uiButton({ label: "全部", action: "navigate", attrs: 'data-view="activity"', variant: "ghost", className: "home-heading-link" })}</div>
    ${
      entries.length
        ? `<div class="home-record-list">${entries
            .map((entry) => {
              const description = describeActivity(entry);
              const relatedTask = s.snapshot.tasks.find(
                (item) => item.task.id === entry.taskId,
              );
              return `<button type="button" class="home-record" data-action="${relatedTask ? "open-task" : "navigate"}" ${relatedTask ? `data-id="${e(entry.taskId)}"` : 'data-view="activity"'}>
                <span class="home-record-dot" aria-hidden="true"></span>
                <span class="home-record-body"><span class="home-record-top"><strong>${e(description.label)}</strong>${timeLabel(entry.at)}</span>${description.message ? `<span class="home-record-message" title="${e(description.message)}">${e(description.message)}</span>` : ""}<span class="home-record-actor">${e(description.actor)}</span></span>
              </button>`;
            })
            .join("")}</div>`
        : '<p class="home-rail-empty">还没有操作记录</p>'
    }
  </section>`;
}

function enginePanel(s) {
  return `<section class="home-rail-section home-engines" aria-labelledby="home-engines-title">
    <div class="home-rail-heading"><h2 id="home-engines-title">${icon("Bot", 16)}执行引擎</h2>${uiButton({ label: "管理", action: "navigate", attrs: 'data-view="engines"', variant: "ghost", className: "home-heading-link" })}</div>
    ${
      s.snapshot.engines.length
        ? `<div class="home-engine-list">${s.snapshot.engines
            .map(
              (engine) =>
                `<button type="button" class="home-engine" data-action="navigate" data-view="engines"><span class="home-engine-name">${icon(engine.id === "fast" ? "Zap" : "Workflow", 15)}<span>${e(administrationEngineName(engine.id))}</span></span><span class="home-engine-state">${s.mode === "demo" ? "演示配置" : "只读配置"}</span></button>`,
            )
            .join("")}</div>`
        : '<p class="home-rail-empty">暂无引擎配置</p>'
    }
  </section>`;
}

function outcomeChart(tasks, days, now) {
  const trend = getTrend(tasks, { days, now });
  const completed = trend.reduce((sum, day) => sum + day.completed, 0);
  const failed = trend.reduce((sum, day) => sum + day.failed, 0);
  const maximum = Math.max(
    0,
    ...trend.map((day) => day.completed + day.failed),
  );
  const period = trend.length === 1 ? "今天" : `近 ${trend.length} 天`;
  const ticks = new Set(
    trend.length <= 7
      ? trend.map((_, index) => index)
      : Array.from({ length: 5 }, (_, index) =>
          Math.round((index * (trend.length - 1)) / 4),
        ),
  );
  const height = (count) => (maximum ? (count / maximum) * 100 : 0);
  return `<figure class="home-outcomes" aria-labelledby="home-outcomes-title" aria-describedby="home-outcomes-basis">
    <div class="home-outcomes-heading"><h2 id="home-outcomes-title">${icon("ChartNoAxesCombined", 16)}任务结果</h2><span class="home-outcomes-period">${period}</span></div>
    <div class="home-outcomes-legend"><span><i class="is-completed" aria-hidden="true"></i>已完成 <strong>${completed}</strong></span><span><i class="is-failed" aria-hidden="true"></i>失败 <strong>${failed}</strong></span></div>
    <div class="home-trend" role="group" aria-label="${e(period)}任务结果：已完成 ${completed} 项，失败 ${failed} 项">
      <div class="home-trend-axis" aria-hidden="true"><span>${maximum || "—"}</span><span>0</span></div>
      <div class="home-trend-plot ${trend.length > 14 ? "is-dense" : ""}" style="--home-trend-columns:${Math.max(1, trend.length)}">
        <span class="home-trend-gridline is-top" aria-hidden="true"></span><span class="home-trend-gridline is-middle" aria-hidden="true"></span><span class="home-trend-gridline is-bottom" aria-hidden="true"></span>
        ${trend
          .map(
            (
              day,
              index,
            ) => `<div class="home-trend-day ${trend.length > 1 && index < trend.length / 3 ? "is-start" : trend.length > 1 && index >= (trend.length * 2) / 3 ? "is-end" : ""}" tabindex="0" role="img" aria-label="${e(day.date)}：已完成 ${day.completed} 项，失败 ${day.failed} 项">
              <span class="home-trend-stack" aria-hidden="true"><span class="home-trend-completed" style="height:${height(day.completed)}%"></span><span class="home-trend-failed" style="height:${height(day.failed)}%"></span></span>
              <span class="home-trend-tooltip" aria-hidden="true">${e(day.label)} · 完成 ${day.completed} · 失败 ${day.failed}</span>
              ${ticks.has(index) ? `<span class="home-trend-date" aria-hidden="true">${e(day.label)}</span>` : ""}
            </div>`,
          )
          .join("")}
        ${maximum ? "" : '<span class="home-trend-empty">当前范围内没有已完成或失败的任务</span>'}
      </div>
    </div>
    <figcaption id="home-outcomes-basis">按任务创建日期统计当前结果 · 北京时间</figcaption>
  </figure>`;
}

export function renderStudioDashboard(s) {
  const now = Date.now();
  const all = filterTasks(s.snapshot.tasks, { days: s.days, now }).sort(
    (a, b) =>
      timestamp(b.task.metadata.createdAt) -
      timestamp(a.task.metadata.createdAt),
  );
  const metrics = getMetrics(all);
  const reviews = all.filter((item) => item.reviewState === "pending");
  const running = all.filter(
    (item) =>
      item.status.status === "running" ||
      (item.status.status === "pending" && item.reviewState !== "pending"),
  );
  const activeCount = running.filter(
    (item) => item.status.status === "running",
  ).length;
  const list = (
    s.overviewTab === "review"
      ? reviews
      : s.overviewTab === "running"
        ? running
        : all
  ).slice(0, 6);
  return `<div class="home-dashboard">
    <section class="home-metrics" aria-label="当前时间范围的运行统计">
      ${uiMetric({ label: "运行与排队", value: running.length, unit: "项", icon: "Activity", tone: "info", detail: `${activeCount} 运行 · ${running.length - activeCount} 排队`, className: "home-metric" })}
      ${uiMetric({ label: "待审批", value: reviews.length, unit: "项", icon: "UserRoundCheck", tone: "warning", detail: reviews.length ? "候选方案等待人工确认" : "当前范围没有待审批请求", className: "home-metric" })}
      ${uiMetric({ label: "修复成功率", value: metrics.successRate === null ? "—" : metrics.successRate.toFixed(1), unit: metrics.successRate === null ? "" : "%", icon: "CircleCheck", tone: "success", detail: `${metrics.completed} 完成 · ${metrics.failed} 失败`, className: "home-metric" })}
      ${uiMetric({ label: "平均修复耗时", value: formatDuration(metrics.averageDurationMs), icon: "Clock3", detail: metrics.averageDurationMs === null ? "暂无已结束任务的耗时" : "已结束任务的可用耗时均值", className: "home-metric" })}
    </section>
    <div class="home-layout">
      <section class="home-tasks" aria-labelledby="home-tasks-title">
        <div class="home-tasks-heading"><h2 id="home-tasks-title">最近任务</h2>${uiButton({ label: "查看全部", icon: "ArrowUpRight", action: "navigate", attrs: 'data-view="tasks"', variant: "ghost", className: "home-heading-link" })}</div>
        ${uiTabs({
          items: [
            { id: "focus", label: "全部", count: all.length },
            { id: "running", label: "运行与排队", count: running.length },
            { id: "review", label: "待审批", count: reviews.length },
          ],
          value: s.overviewTab,
          action: "overview-tab",
          label: "工作台任务视图",
          className: "home-task-tabs",
        })}
        ${list.length ? `<div class="home-task-columns" aria-hidden="true"><span>任务</span><span>状态</span><span>创建时间</span></div><div class="home-task-list">${list.map(taskRow).join("")}</div>` : uiEmpty({ icon: "Inbox", title: s.overviewTab === "review" ? "没有待审批任务" : s.overviewTab === "running" ? "没有运行或排队任务" : "当前范围没有任务", description: "可切换任务状态或调整时间范围。", className: "home-empty" })}
        ${outcomeChart(all, s.days, now)}
      </section>
      <aside class="home-rail" aria-label="工作台辅助信息">${approvalsPanel(reviews)}${recentActivity(s)}${enginePanel(s)}</aside>
    </div>
  </div>`;
}
