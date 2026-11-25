/** Read-only projection of imported Jenkins failures, NOT a live Jenkins build inventory.
 * All writes still go through ci-controller and the existing API v1 mutation guard. */
import { escapeHtml as e } from "./model.js";
import { uiButton, uiEmpty, uiSearch, uiSelect, uiStatus } from "./ui.js";
import { workspaceExecution } from "./workspace-model.js";
import { renderWorkspacePager } from "./workspace-views.js";

const definitions = Object.freeze({
  "no-pr": ["未生成可核验 PR", "neutral"],
  unverified: ["尚未核验", "neutral"],
  pending: ["等待 CI", "warning"],
  passed: ["CI 核验通过", "success"],
  failed: ["CI 检查失败", "error"],
  mismatch: ["证据不一致", "error"],
  stale: ["需要重新核验", "warning"],
  error: ["核验未完成", "warning"],
  unknown: ["状态未知", "neutral"],
});
const sourceOf = (item) => item?.task?.payload?.context?.source;
const str = (v) => (typeof v === "string" ? v : "");
const time = (v) => {
  const date = new Date(v || "");
  return Number.isFinite(+date)
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : "未提供";
};
const hasPr = (item) =>
  item?.proposal?.version === 2 &&
  Number.isSafeInteger(item.result?.changes?.pr) &&
  item.result.changes.pr > 0 &&
  /^[a-f0-9]{40}$/i.test(item.result.changes.commit || "");
export function jenkinsVerificationState(item) {
  if (!hasPr(item)) return "no-pr";
  if (item.verification?.status == null) return "unverified";
  return Object.hasOwn(definitions, item.verification.status) &&
    !["no-pr", "unverified"].includes(item.verification.status)
    ? item.verification.status
    : "unknown";
}
export function jenkinsFilters(state = {}) {
  const raw = state.jenkinsStatus;
  const pageSize = Number(state.jenkinsPageSize);
  return {
    query: str(state.jenkinsQuery).slice(0, 200),
    status: Object.hasOwn(definitions, raw) ? raw : "all",
    page:
      Number.isSafeInteger(state.jenkinsPage) && state.jenkinsPage > 0
        ? state.jenkinsPage
        : 1,
    pageSize: [10, 20, 50].includes(pageSize) ? pageSize : 10,
  };
}
export function getJenkinsPage(tasks = [], state = {}) {
  const filters = jenkinsFilters(state);
  const needle = filters.query.trim().toLowerCase();
  const all = (Array.isArray(tasks) ? tasks : []).filter(
    (item) =>
      typeof item?.task?.id === "string" && sourceOf(item)?.kind === "jenkins",
  );
  const matches = all.filter((item) => {
    const source = sourceOf(item);
    return (
      !needle ||
      [
        item.title,
        item.task.id,
        source.sourceId,
        source.jobName,
        source.buildNumber,
        item.task.payload?.repo,
        item.task.payload?.branch,
        item.task.payload?.context?.commitSha,
        item.result?.changes?.pr,
        item.result?.changes?.commit,
      ]
        .map((v) => String(v ?? ""))
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  });
  const counts = Object.fromEntries(
    Object.keys(definitions).map((key) => [key, 0]),
  );
  for (const item of matches) counts[jenkinsVerificationState(item)] += 1;
  const rows = matches
    .filter(
      (item) =>
        filters.status === "all" ||
        jenkinsVerificationState(item) === filters.status,
    )
    .sort(
      (a, b) =>
        (Date.parse(b.task.metadata?.createdAt) || 0) -
          (Date.parse(a.task.metadata?.createdAt) || 0) ||
        a.task.id.localeCompare(b.task.id),
    );
  const total = rows.length,
    pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, pageCount),
    offset = (page - 1) * filters.pageSize;
  return {
    filters,
    counts,
    imported: all.length,
    matching: matches.length,
    page,
    pageCount,
    pageSize: filters.pageSize,
    total,
    start: total ? offset + 1 : 0,
    end: Math.min(offset + filters.pageSize, total),
    items: rows.slice(offset, offset + filters.pageSize),
  };
}

function row(item, state) {
  const source = sourceOf(item),
    v = workspaceExecution(item, state);
  const [label, tone] = definitions[jenkinsVerificationState(item)];
  const commit = str(item.task.payload?.context?.commitSha);
  const id = e(item.task.id);
  return `<tr><td><button type="button" class="jenkins-record-title" data-action="open-task" data-id="${id}"><strong>${e(source.jobName || "未提供 Job")}${Number.isSafeInteger(source.buildNumber) ? " #" + e(source.buildNumber) : ""}</strong><small>${e(item.title || item.task.id)}</small></button></td>
    <td><code title="${e(commit)}">${e(commit ? commit.slice(0, 12) : "未提供")}</code><small>${e(item.task.payload?.branch || "未提供分支")}</small></td>
    <td>${uiStatus({ label: v.label, tone: v.attention ? "warning" : v.active ? "info" : "neutral" })}</td>
    <td>${uiStatus({ label: state.error ? "历史 · " + label : label, tone: state.error ? "neutral" : tone })}<small>${hasPr(item) ? "PR #" + e(item.result.changes.pr) : "无已回传的可核验 PR"}</small></td>
    <td><time>${time(item.task.metadata?.createdAt)}</time></td>
    <td>${uiButton({ label: "详情", action: "open-task", icon: "ArrowUpRight", variant: "ghost", attrs: `data-id="${id}"` })}</td></tr>`;
}
export function renderJenkinsWorkspace(state) {
  const snapshot = state.snapshot;
  const source = snapshot?.integrations?.jenkins,
    verification = snapshot?.integrations?.verification;
  const page = getJenkinsPage(snapshot?.tasks, state);
  const options = [
    { value: "all", label: "全部核验状态" },
    ...Object.entries(definitions).map(([value, [label]]) => ({
      value,
      label,
    })),
  ];
  const enabled =
    state.mode === "live" &&
    source?.configured &&
    snapshot?.capabilities?.importCi &&
    !state.authRequired &&
    !state.pendingAction;
  const actions = uiButton({
    label: "导入失败构建",
    icon: "Download",
    action: "ci-import-open",
    variant: "primary",
    disabled: !enabled,
    title: !source?.configured
      ? "请先配置 Jenkins 来源"
      : !snapshot?.capabilities?.importCi
        ? "当前服务不允许导入"
        : "",
  });
  return `<section class="jenkins-workspace" aria-label="Jenkins 修复工作区">
    <div class="jenkins-toolbar"><div><h2>失败构建与修复核验</h2><p>${state.mode === "demo" ? "开发预览" : state.error ? "最近一次快照 · 非实时" : "服务端已导入记录"} · ${time(snapshot?.generatedAt)}（北京时间）</p></div><div class="row">${uiButton({ label: "刷新记录", icon: "RefreshCw", action: "refresh", loading: state.refreshing || state.loading })}${actions}</div></div>
    <p class="jenkins-boundary">仅展示已导入的失败构建和后续修复任务，不代表 Jenkins 的完整构建历史、当前执行器状态或队列。创建 PR 不等于 CI 通过；核验结果以对应候选和提交为准。</p>
    <div class="jenkins-layout"><section class="jenkins-records ui-card" aria-label="已导入失败构建">
      <header class="jenkins-subhead"><h3>导入记录 <span>${page.imported}</span></h3><span>非 Jenkins 全量历史</span></header>
      <div class="jenkins-filter">${uiSearch({ id: "jenkins-search", label: "搜索导入记录", value: page.filters.query, placeholder: "Job、构建号、任务 ID、SHA…", className: "jenkins-search" })}${uiSelect({ id: "jenkins-status", label: "CI 核验状态", value: page.filters.status, options })}${uiButton({ label: "重置", action: "jenkins-reset", variant: "ghost", attrs: 'id="jenkins-reset"' })}</div>
      ${page.total ? `<div class="jenkins-table-wrap"><table class="ui-table jenkins-table"><caption class="sr-only">失败构建导入与核验记录</caption><thead><tr><th scope="col">Job / 失败构建</th><th scope="col">失败提交</th><th scope="col">修复状态</th><th scope="col">独立 CI 核验</th><th scope="col">导入时间</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>${page.items.map((item) => row(item, state)).join("")}</tbody></table></div>` : uiEmpty({ icon: "Workflow", title: page.imported ? "没有匹配记录" : "尚无失败构建导入记录", description: page.imported ? "调整搜索与核验状态。" : "配置真实 Jenkins 来源后，可按构建号导入失败构建。", action: page.imported ? uiButton({ label: "清除筛选", action: "jenkins-reset" }) : "" })}
      ${renderWorkspacePager(page, "jenkins")}
    </section><aside class="jenkins-side"><section class="jenkins-summary ui-card"><header class="jenkins-subhead"><h3>核验状态分布</h3><span>${page.matching} 项匹配</span></header><div class="jenkins-distribution">${
      Object.entries(definitions)
        .filter(([key]) => page.counts[key] > 0 || key === page.filters.status)
        .map(
          ([key, [label, tone]]) =>
            `<button type="button" id="jenkins-filter-${key}" class="jenkins-chart-row" data-action="jenkins-status-filter" data-value="${key}" aria-pressed="${page.filters.status === key}"><span>${e(label)}</span><span class="jenkins-count">${page.counts[key]}</span><progress max="${Math.max(1, page.matching)}" value="${page.counts[key]}" class="jenkins-bar-${tone}" aria-label="${e(label)}：${page.counts[key]} 项"></progress></button>`,
        )
        .join("") || '<p class="muted">尚无数据</p>'
    }</div></section>
      <section class="jenkins-summary ui-card"><header class="jenkins-subhead"><h3>连接与证据来源</h3></header><dl><div><dt>Jenkins 来源</dt><dd>${uiStatus({ label: source?.configured ? "已配置 · 未证明在线" : "未配置" })}</dd></div><div><dt>Job</dt><dd>${e(source?.jobName || "未提供")}</dd></div><div><dt>分支</dt><dd>${e(source?.branch || "未提供")}</dd></div><div><dt>GitHub 独立核验</dt><dd>${uiStatus({ label: verification?.configured ? "已配置 · 按任务核验" : "未配置" })}</dd></div><div><dt>必需 Status Context</dt><dd>${(verification?.requiredStatusContexts || []).map((v) => `<code>${e(v)}</code>`).join(" ") || "未提供"}</dd></div></dl>${uiButton({ label: "连接设置", icon: "ArrowUpRight", action: "navigate", attrs: 'data-view="settings"', variant: "ghost" })}</section>
    </aside></div>
  </section>`;
}
