import { icon } from "./icons.js";
import { escapeHtml as e, formatDuration } from "./model.js";
import { getDashboardAnalytics } from "./analytics-model.js";
import { administrationEngineName } from "./administration-model.js";
import { uiButton, uiEmpty, uiMetric, uiStatus, uiTabs } from "./ui.js";

const statusNames = {
  running: "运行中",
  pending: "排队中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
  review: "待审批",
  unknown: "未知状态",
};
const statusColors = {
  completed: "var(--green)",
  failed: "var(--red)",
  running: "var(--blue)",
  review: "var(--amber)",
  pending: "var(--muted)",
  cancelled: "var(--faint)",
  skipped: "var(--line)",
  unknown: "var(--faint)",
};
const typeNames = {
  "type-error": "类型错误",
  "lint-error": "Lint 错误",
  "format-error": "代码格式",
  "unit-test-failure": "单元测试",
  "e2e-test-failure": "端到端测试",
  "dependency-issue": "依赖问题",
  "ci-failure": "CI 失败",
  "doc-outdated": "文档过期",
  "security-issue": "安全问题",
  "architecture-violation": "架构违规",
  "performance-regression": "性能回归",
  unknown: "未知类型",
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
const lookup = (map, key, fallback) =>
  Object.hasOwn(map, key) ? map[key] : fallback;
const percent = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
const percentLabel = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${Number(value.toFixed(1))}%`
    : "—";
const timestamp = (at) => {
  const value = Date.parse(at || "");
  return Number.isFinite(value) ? value : -Infinity;
};
const shortDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const fullDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const filterAttrs = (dimension, value = "") =>
  `data-action="dashboard-filter" data-dimension="${e(dimension)}" data-value="${e(value)}"`;

function reportHeader(id, title, glyph, extra = "") {
  return `<div class="report-header"><h2 id="${e(id)}"><span class="report-glyph" aria-hidden="true">${icon(glyph, 17)}</span>${e(title)}</h2>${extra}</div>`;
}
function legend(label, count, color) {
  return `<span class="report-legend-item"><i class="report-swatch" style="--report-color:${color}" aria-hidden="true"></i>${e(label)}<strong>${count}</strong></span>`;
}
function timeLabel(at) {
  const value = timestamp(at);
  if (!Number.isFinite(value)) return '<span title="时间未提供">—</span>';
  const date = new Date(value);
  return `<time datetime="${e(date.toISOString())}" title="${e(fullDate.format(date))} · 北京时间">${e(shortDate.format(date))}</time>`;
}
function taskStatus(item) {
  const status =
    item.reviewState === "pending" ? "review" : item.status?.status;
  return uiStatus({
    label: lookup(statusNames, status, "未知状态"),
    tone: lookup(
      {
        completed: "success",
        failed: "error",
        review: "warning",
        running: "info",
      },
      status,
      "neutral",
    ),
    icon: lookup(
      {
        completed: "CircleCheck",
        failed: "CircleAlert",
        review: "UserRoundCheck",
        running: "Activity",
        pending: "Clock3",
        cancelled: "Square",
        skipped: "ArrowRight",
      },
      status,
      "Circle",
    ),
    className: "home-task-status",
  });
}
function taskRow(item) {
  const review = item.reviewState === "pending" && item.approvalFlow;
  return `<button type="button" class="home-task-row" data-action="${review ? "select-approval" : "open-task"}" data-id="${e(item.task.id)}" title="${e(item.title)} · ${e(administrationEngineName(item.engineId))}">
    <span class="home-task-glyph" aria-hidden="true">${icon(lookup(typeIcons, item.task.type, "ListChecks"), 16)}</span>
    <span class="home-task-copy"><strong>${e(item.title)}</strong><span class="home-task-meta"><code>${e(item.task.id)}</code>${timeLabel(item.task.metadata?.createdAt)}</span></span>
    ${taskStatus(item)}<span class="home-task-arrow" aria-hidden="true">${icon("ChevronRight", 12)}</span>
  </button>`;
}

function volumeChart(analytics) {
  const { daily, metrics, days } = analytics;
  const maximum = Math.max(0, ...daily.map((day) => day.total));
  const scaleMaximum = maximum ? Math.ceil(maximum / 2) * 2 : 0;
  const period = days === 1 ? "今天" : `近 ${days} 天`;
  const tickCount = daily.length <= 7 ? daily.length : 5;
  const ticks = new Set(
    Array.from({ length: tickCount }, (_, index) =>
      tickCount === 1
        ? 0
        : Math.round((index * (daily.length - 1)) / (tickCount - 1)),
    ),
  );
  const height = (count) =>
    scaleMaximum ? percent((count / scaleMaximum) * 100) : 0;
  const other = metrics.total - metrics.completed - metrics.failed;
  return `<figure class="report-card report-trend ui-card" aria-labelledby="home-volume-title" aria-describedby="home-volume-basis">
    ${reportHeader("home-volume-title", "任务趋势", "ChartNoAxesCombined", `<span class="report-header-note">${e(period)}</span>`)}
    <div class="report-legend">${legend("已完成", metrics.completed, "var(--green)")}${legend("失败", metrics.failed, "var(--red)")}${legend("其他", other, "var(--blue)")}</div>
    <div class="home-trend" role="group" aria-label="${e(period)}创建的 ${metrics.total} 项任务：已完成 ${metrics.completed} 项，失败 ${metrics.failed} 项，其他 ${other} 项">
      <div class="home-trend-axis" aria-hidden="true"><span>${scaleMaximum || "—"}</span><span>${scaleMaximum ? scaleMaximum / 2 : ""}</span><span>0</span></div>
      <div class="home-trend-plot ${daily.length > 14 ? "is-dense" : ""} ${daily.length === 1 ? "is-single" : ""}" style="--home-trend-columns:${Math.max(1, daily.length)}">
        <span class="home-trend-gridline is-top" aria-hidden="true"></span><span class="home-trend-gridline is-middle" aria-hidden="true"></span><span class="home-trend-gridline is-bottom" aria-hidden="true"></span>
        ${daily
          .map(
            (
              day,
              index,
            ) => `<div class="home-trend-day ${daily.length > 1 && index < daily.length / 3 ? "is-start" : daily.length > 1 && index >= (daily.length * 2) / 3 ? "is-end" : ""}" tabindex="0" role="img" aria-label="${e(day.date)}：总计 ${day.total} 项，已完成 ${day.completed} 项，失败 ${day.failed} 项，其他 ${day.other} 项">
          <span class="home-trend-stack" aria-hidden="true"><span class="home-trend-completed" style="height:${height(day.completed)}%"></span><span class="home-trend-failed" style="height:${height(day.failed)}%"></span><span class="home-trend-other" style="height:${height(day.other)}%"></span></span>
          <span class="home-trend-tooltip" aria-hidden="true"><strong>${e(day.label)} · ${day.total} 项</strong><span>完成 ${day.completed} · 失败 ${day.failed} · 其他 ${day.other}</span></span>
          ${ticks.has(index) ? `<span class="home-trend-date" aria-hidden="true">${e(day.label)}</span>` : ""}
        </div>`,
          )
          .join("")}
        ${maximum ? "" : '<span class="home-trend-empty">当前范围内没有任务</span>'}
      </div>
    </div>
    <figcaption class="report-caption" id="home-volume-basis">按创建日期统计当前结果 · 北京时间</figcaption>
  </figure>`;
}

function statusChart(analytics) {
  const items = analytics.statuses.filter((item) => item.count > 0);
  const total = analytics.metrics.total;
  let offset = 0;
  const segments = items
    .map((item) => {
      const share = percent(item.percent);
      const segment = `<circle class="report-donut-segment" cx="66" cy="66" r="54" pathLength="100" fill="none" stroke="${lookup(statusColors, item.id, "var(--faint)")}" stroke-width="12" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-offset}" transform="rotate(-90 66 66)"></circle>`;
      offset += share;
      return segment;
    })
    .join("");
  const summary = items
    .map(
      (item) => `${lookup(statusNames, item.id, "未知状态")} ${item.count} 项`,
    )
    .join("，");
  const rows = items
    .map((item) => {
      const name = lookup(statusNames, item.id, "未知状态");
      const clickable = item.id !== "unknown";
      const tag = clickable ? "button" : "div";
      return `<${tag} ${clickable ? `type="button" ${filterAttrs("status", item.id)}` : ""} class="report-state-row" aria-label="${e(name)} ${item.count} 项，占 ${percentLabel(item.percent)}">
      <span class="report-state-name"><i class="report-swatch" style="--report-color:${lookup(statusColors, item.id, "var(--faint)")}" aria-hidden="true"></i>${e(name)}</span><strong class="report-state-count">${item.count}</strong><span class="report-state-percent">${percentLabel(item.percent)}</span>
    </${tag}>`;
    })
    .join("");
  return `<section class="report-card report-status ui-card" aria-labelledby="home-status-title">
    ${reportHeader("home-status-title", "任务状态", "CircleDashed", `<span class="report-header-note">当前结果</span>`)}
    <div class="report-state-body"><div class="report-donut" role="img" aria-label="${total} 项任务${summary ? `：${e(summary)}` : "，暂无状态分布"}"><svg viewBox="0 0 132 132" width="132" height="132" aria-hidden="true"><circle class="report-donut-track" cx="66" cy="66" r="54" fill="none" stroke="var(--line)" stroke-width="12"></circle>${segments}</svg><div class="report-donut-value"><strong>${total}</strong><span>任务总量</span></div></div><div class="report-state-list">${rows || '<p class="report-no-data">暂无状态数据</p>'}</div></div>
    <div class="report-footer"><span>占当前范围全部任务</span>${uiButton({ label: "查看任务", icon: "ArrowUpRight", action: "dashboard-filter", attrs: 'data-dimension="all" data-value=""', variant: "ghost", className: "report-link" })}</div>
  </section>`;
}

function typeRow(item, maximum) {
  const name = lookup(typeNames, item.id, item.id);
  const clickable = !["unknown", "all"].includes(item.id);
  const tag = clickable ? "button" : "div";
  return `<${tag} ${clickable ? `type="button" ${filterAttrs("type", item.id)}` : ""} class="report-rank-row" aria-label="${e(name)} ${item.count} 项，占 ${percentLabel(item.percent)}">
    <span class="report-rank-fill" style="--rank-width:${maximum ? percent((item.count / maximum) * 100) : 0}%" aria-hidden="true"></span><span class="report-rank-name">${icon(lookup(typeIcons, item.id, "ListChecks"), 15)}<span>${e(name)}</span></span><span class="report-rank-value"><strong>${item.count}</strong><small>${percentLabel(item.percent)}</small></span>
  </${tag}>`;
}
function typesChart(analytics) {
  const items = analytics.types;
  const maximum = Math.max(0, ...items.map((item) => item.count));
  const rest = items.slice(5);
  return `<section class="report-card report-types ui-card" aria-labelledby="home-types-title">
    ${reportHeader("home-types-title", "问题类型", "ListChecks", `<span class="report-header-note">${items.length} 类</span>`)}
    ${
      items.length
        ? `<div class="report-rank-list">${items
            .slice(0, 5)
            .map((item) => typeRow(item, maximum))
            .join(
              "",
            )}</div>${rest.length ? `<details class="report-more"><summary>另外 ${rest.length} 类 · ${rest.reduce((sum, item) => sum + item.count, 0)} 项 ${icon("ChevronDown", 12)}</summary><div class="report-rank-list">${rest.map((item) => typeRow(item, maximum)).join("")}</div></details>` : '<p class="report-caption">按任务量排序 · 占比以总任务为分母</p>'}`
        : uiEmpty({
            icon: "ListChecks",
            title: "暂无问题类型数据",
            className: "report-empty",
          })
    }
  </section>`;
}
function engineRow(item, mode = "demo") {
  const name =
    item.id === "unknown" ? "未知引擎" : administrationEngineName(item.id);
  const clickable = !["unknown", "all"].includes(item.id);
  const tag = clickable ? "button" : "div";
  const other = item.count - item.completed - item.failed;
  const share = (count) =>
    item.count ? percent((count / item.count) * 100) : 0;
  return `<${tag} ${clickable ? `type="button" ${filterAttrs("engine", item.id)}` : ""} class="report-engine" aria-label="${e(name)}：${item.count} 项任务，已结束任务成功率 ${percentLabel(item.successRate)}，平均耗时 ${e(formatDuration(item.averageDurationMs))}">
    <span class="report-engine-heading"><span class="report-engine-icon" aria-hidden="true">${icon(item.id === "fast" ? "Zap" : "Bot", 16)}</span><strong>${e(name)}</strong><span class="report-engine-count"><b>${item.count}</b> 项</span></span>
    <span class="report-engine-metrics"><span><strong>${percentLabel(item.successRate)}</strong><small>${mode === "demo" ? "修复成功率" : "任务成功率"}</small></span><span><strong>${e(formatDuration(item.averageDurationMs))}</strong><small>平均耗时</small></span><span><strong>${item.failed}</strong><small>失败</small></span></span>
    <span class="report-engine-track" aria-hidden="true"><i class="is-completed" style="width:${share(item.completed)}%"></i><i class="is-failed" style="width:${share(item.failed)}%"></i><i class="is-other" style="width:${share(other)}%"></i></span>
    <span class="report-engine-legend">完成 ${item.completed} · 失败 ${item.failed} · 其他 ${other}</span>
  </${tag}>`;
}
function enginesChart(analytics, mode) {
  const items = analytics.engines;
  const rest = items.slice(2);
  return `<section class="report-card report-engines ui-card" aria-labelledby="home-engines-title">
    ${reportHeader("home-engines-title", "引擎表现", "Bot", `<span class="report-header-note">${items.length} 个引擎</span>`)}
    ${
      items.length
        ? `<div class="report-engine-list">${items
            .slice(0, 2)
            .map((item) => engineRow(item, mode))
            .join(
              "",
            )}</div>${rest.length ? `<details class="report-more"><summary>另外 ${rest.length} 个引擎 ${icon("ChevronDown", 12)}</summary><div class="report-engine-list">${rest.map((item) => engineRow(item, mode)).join("")}</div></details>` : ""}`
        : uiEmpty({
            icon: "Bot",
            title: "暂无引擎任务数据",
            className: "report-empty",
          })
    }
    <div class="report-footer"><span title="成功率仅计算已完成与失败的任务；平均耗时仅纳入有效测量。不同引擎的任务类型可能不同。">按分配任务统计</span>${uiButton({ label: "引擎设置", icon: "ArrowUpRight", action: "navigate", attrs: 'data-view="engines"', variant: "ghost", className: "report-link" })}</div>
  </section>`;
}
function recentTasks(analytics, state) {
  const all = [...analytics.tasks].sort(
    (a, b) =>
      timestamp(b.task.metadata?.createdAt) -
      timestamp(a.task.metadata?.createdAt),
  );
  const reviews = all.filter((item) => item.reviewState === "pending");
  const running = all.filter(
    (item) =>
      item.reviewState !== "pending" &&
      ["running", "pending"].includes(item.status?.status),
  );
  const list = (
    state.overviewTab === "review"
      ? reviews
      : state.overviewTab === "running"
        ? running
        : all
  ).slice(0, 4);
  return `<section class="report-card home-tasks ui-card" aria-labelledby="home-tasks-title">
    <div class="home-tasks-toolbar"><h2 id="home-tasks-title"><span class="report-glyph" aria-hidden="true">${icon("History", 17)}</span>最近任务</h2>${uiButton({ label: "查看全部", icon: "ArrowUpRight", action: "dashboard-filter", attrs: 'data-dimension="all" data-value=""', variant: "ghost", className: "home-heading-link" })}</div>
    ${uiTabs({
      items: [
        { id: "focus", label: "全部", count: all.length },
        { id: "running", label: "运行/排队", count: running.length },
        { id: "review", label: "待审批", count: reviews.length },
      ],
      value: state.overviewTab,
      action: "overview-tab",
      label: "工作台任务视图",
      className: "home-task-tabs",
    })}
    ${list.length ? `<div class="home-task-list">${list.map(taskRow).join("")}</div>` : uiEmpty({ icon: "Inbox", title: state.overviewTab === "review" ? "没有待审批任务" : state.overviewTab === "running" ? "没有运行或排队任务" : "当前范围没有任务", description: "可切换状态或调整时间范围。", className: "home-empty" })}
  </section>`;
}

export function renderStudioDashboard(state) {
  const analytics = getDashboardAnalytics(state.snapshot.tasks, {
    days: state.days,
    now: Date.now(),
  });
  const { metrics, statuses } = analytics;
  const statusCount = (id) =>
    statuses.find((item) => item.id === id)?.count || 0;
  return `<div class="home-dashboard">
    <section class="home-metrics" aria-label="当前时间范围的运行统计">
      <div class="home-stat">${uiMetric({ label: "任务总量", value: metrics.total, unit: "项", icon: "Layers", tone: "info", detail: `${statusCount("running")} 运行 · ${statusCount("pending")} 排队`, className: "home-metric" })}</div>
      <div class="home-stat">${uiMetric({ label: state.mode === "demo" ? "修复成功率" : "任务成功率", value: metrics.successRate === null ? "—" : metrics.successRate.toFixed(1), unit: metrics.successRate === null ? "" : "%", icon: "CircleCheck", tone: "success", detail: `${metrics.completed} 完成 · ${metrics.failed} 失败`, className: "home-metric" })}</div>
      <div class="home-stat">${uiMetric({ label: state.mode === "demo" ? "平均修复耗时" : "平均任务耗时", value: formatDuration(metrics.averageDurationMs), icon: "Clock3", detail: metrics.averageDurationMs === null ? "暂无有效耗时" : "已结束任务的有效均值", className: "home-metric" })}</div>
      <div class="home-stat">${uiMetric({ label: "待审批", value: statusCount("review"), unit: "项", icon: "GitPullRequestArrow", tone: "warning", detail: statusCount("review") ? "等待人工确认" : "无需处理", className: "home-metric" })}${uiButton({ label: "去审批", icon: "ArrowUpRight", action: "navigate", attrs: 'data-view="approvals"', variant: "ghost", className: "home-stat-action" })}</div>
    </section>
    <div class="home-report-main">${volumeChart(analytics)}${statusChart(analytics)}</div>
    <div class="home-report-bottom">${typesChart(analytics)}${enginesChart(analytics, state.mode)}${recentTasks(analytics, state)}</div>
  </div>`;
}
