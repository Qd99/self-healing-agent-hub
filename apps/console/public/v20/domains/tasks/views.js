import {
  e,
  empty,
  formatDuration,
  formatTime,
  status,
} from "../../shared/view.js";

const defaultHref = () => "#tasks";
const scopes = [
  ["all", "全部任务", "total"],
  ["running", "运行中", "running"],
  ["attention", "需关注", "attention"],
  ["queued", "排队中", "queued"],
  ["ended", "已结束", "ended"],
];
function summary(counts, selected = "all") {
  return `<div class="v-summary" role="group" aria-label="任务范围">${scopes.map(([key, name, count]) => `<button class="${selected === key ? "selected" : ""}" data-scope="${key}" aria-pressed="${selected === key}">${name} <b>${counts[count]}</b></button>`).join("")}</div>`;
}
function taskName(row, taskHref) {
  return `<a class="v-task-name" href="${e(taskHref(row.id))}">${e(row.title)}</a><div class="v-meta"><span class="v-id">${e(row.id)}</span><span>${e(row.type)}</span></div>`;
}
/** Bars come from real per-day counts; an empty week says so instead of drawing. */
export function renderTrend(trend = []) {
  const total = trend.reduce((sum, day) => sum + day.count, 0);
  if (!total)
    return empty(
      "近 7 天没有新建任务",
      "统计来自任务记录的创建时间；没有记录就不绘制曲线。",
    );
  const W = 640,
    H = 150,
    L = 30,
    R = 8,
    T = 10,
    B = 24;
  const max = Math.max(...trend.map((day) => day.count));
  const width = (W - L - R) / trend.length;
  const bars = trend
    .map((day, index) => {
      const height = (day.count / max) * (H - T - B);
      const x = L + index * width + width * 0.22;
      return `<rect x="${x.toFixed(1)}" y="${(H - B - height).toFixed(1)}" width="${(width * 0.56).toFixed(1)}" height="${height.toFixed(1)}" rx="3" class="v-bar"><title>${e(day.key)} · ${day.count} 项</title></rect><text x="${(x + width * 0.28).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="v-axis-label">${e(day.label)}</text>`;
    })
    .join("");
  return `<figure class="v-chart"><figcaption>近 7 天新建 ${total} 项 · 北京时间</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近 7 天新建任务 ${total} 项"><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="v-axis"/>${bars}</svg></figure>`;
}

export function renderOverview(model, { taskHref = defaultHref } = {}) {
  return `${summary(model.counts)}<div class="v-workgrid"><section class="v-plane"><header class="v-section-head"><div><h2>执行态势</h2><p>按任务创建时间统计</p></div><a href="#monitor">性能监控 →</a></header>${renderTrend(model.trend)}</section><section class="v-plane"><header class="v-section-head"><div><h2>最近执行</h2><p>按最近可核时间排序 · 北京时间</p></div><a href="#tasks">全部任务 →</a></header>${model.recent.length ? `<div class="v-feed"><div class="v-feed-head"><span>任务</span><span>当前动作</span><span>状态 / 执行引擎</span></div>${model.recent.map((row) => `<article class="v-feed-row"><div>${taskName(row, taskHref)}</div><p class="v-current">${e(row.currentAction)}</p><div>${status(row.statusLabel, row.tone)}<small>${e(row.engineName)}</small></div></article>`).join("")}</div>` : empty("还没有任务", "连接成功。此项目的管理快照中暂时没有任务。")}</section><aside class="v-rail"><section class="v-plane"><header class="v-section-head"><h2>需要处理</h2><button class="v-link" data-scope="attention">查看全部 →</button></header>${model.attention.length ? model.attention.map((row) => `<a class="v-attention" href="${e(taskHref(row.id))}">${status(row.statusLabel, row.tone)}<strong>${e(row.title)}</strong><small>${e(row.message || row.phase)}</small></a>`).join("") : empty("暂无待处理任务")}</section><section class="v-plane"><h2>数据来源</h2><dl class="v-properties"><div><dt>管理服务</dt><dd>${status("已读取", "success")}</dd></div><div><dt>持久化</dt><dd>${e(model.storage === "ready" ? "可用" : "只读")}</dd></div><div><dt>快照时间</dt><dd>${e(formatTime(model.generatedAt))}</dd></div></dl><p class="v-note">当前展示管理服务的真实任务快照。执行进度以服务端记录和已采集观测为准。</p></section><section class="v-plane"><header class="v-section-head"><h2>执行引擎</h2><a href="#workers">查看执行器 →</a></header>${model.engines?.length ? `<dl class="v-properties">${model.engines.map((engine) => `<div><dt>${e(engine.name || engine.id)}</dt><dd>${e(engine.status)}</dd></div>`).join("")}</dl>` : empty("未登记执行引擎")}</section></aside></div>`;
}
export function renderTasks(
  model,
  {
    taskHref = defaultHref,
    selected = new Map(),
    canBulkCancel = false,
    canBulkRetry = false,
  } = {},
) {
  const selectable = canBulkCancel || canBulkRetry;
  const selection = selectable
    ? `<form class="v-inline v-bulk" data-command="taskBulk"><span class="v-muted">已选 ${selected.size} 项（最多 100）</span><button class="v-button" type="button" data-action="select-page" ${model.items.length ? "" : "disabled"}>选本页</button><button class="v-button" type="button" data-action="clear-selection" ${selected.size ? "" : "disabled"}>清除选择</button>${canBulkCancel ? `<button class="v-button" type="submit" name="type" value="cancel" ${selected.size ? "" : "disabled"}>批量取消</button>` : ""}${canBulkRetry ? `<button class="v-button" type="submit" name="type" value="retry" ${selected.size ? "" : "disabled"}>批量重试</button>` : ""}</form>`
    : "";
  const rows = model.items
    .map(
      (row) =>
        `<tr>${selectable ? `<td><input class="v-select-task" type="checkbox" data-select-task="${e(row.id)}" aria-label="${e(`选择 ${row.title}`)}" ${selected.has(row.id) ? "checked" : ""} ${selected.size >= 100 && !selected.has(row.id) ? "disabled" : ""}></td>` : ""}<td>${taskName(row, taskHref)}<p class="v-current">${e(row.currentAction)}</p></td><td>${status(row.statusLabel, row.tone)}</td><td><strong>${e(row.phase)}</strong><small>服务端进度 ${e(row.progress)}%</small></td><td>${e(row.engineName)}</td><td>${e(row.priority)}</td><td>${e(formatTime(row.lastKnownAt))}<small>${e(row.timeSource)}</small></td></tr>`,
    )
    .join("");
  return `${summary(model.counts, model.scope)}<section class="v-plane v-list-plane"><div class="v-toolbar"><label class="v-search" for="v20-task-query"><span class="sr-only">搜索当前快照中的任务</span><input type="search" id="v20-task-query" placeholder="搜索任务、ID、执行器…" value="${e(model.query)}" autocomplete="off"></label><span class="v-muted">当前快照 · ${model.total} 项</span></div>${selection}${model.items.length ? `<div class="v-table-scroll"><table class="v-table"><thead><tr>${selectable ? "<th>选择</th>" : ""}<th>任务</th><th>状态</th><th>执行进度</th><th>Agent / 执行引擎</th><th>优先级</th><th>最近可核时间</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty(model.query ? "没有匹配任务" : "没有任务", model.query ? "请调整搜索条件。" : "此项目的当前管理快照中没有任务。")}<footer class="v-pagination"><span>第 ${model.page} / ${model.pageCount} 页 · 共 ${model.total} 项</span><div class="v-actions"><button class="v-button" data-page="${model.page - 1}" ${model.page <= 1 ? "disabled" : ""}>上一页</button><button class="v-button" data-page="${model.page + 1}" ${model.page >= model.pageCount ? "disabled" : ""}>下一页</button></div></footer></section><details class="v-disclosure"><summary>进度与数据口径</summary><p>百分比来自服务端任务记录。最近可核时间标明观测、启动或创建等来源；不代表完整更新时间。尚未采集的工具调用或外部状态不据此推断。</p></details>`;
}
export function renderTaskDetail(item) {
  if (!item)
    return `<header class="v-detail-head"><h2 id="task-detail-title">找不到任务</h2><button class="v-button" data-action="close-detail" aria-label="关闭任务详情">关闭</button></header>${empty("找不到当前任务", "此任务不在当前项目的授权快照中。")}`;
  return `<header class="v-detail-head"><h2 id="task-detail-title">任务详情</h2><button class="v-button" data-action="close-detail" aria-label="关闭任务详情">关闭</button></header><div class="v-detail-body"><div class="v-detail-title"><span class="v-id">${e(item.id)}</span>${status(item.statusLabel, item.tone)}</div><h3 class="v-title">${e(item.title)}</h3><p>${e(item.message)}</p><dl class="v-properties v-detail-properties">${[
    ["阶段", item.phase],
    ["服务端进度", `${item.progress}%`],
    ["执行器", item.workerId || "未分配"],
    ["租约到期", formatTime(item.leaseExpiresAt)],
    ["仓库", item.repo || "未提供"],
    ["分支", item.branch || "未提供"],
  ]
    .map(
      ([name, value]) => `<div><dt>${e(name)}</dt><dd>${e(value)}</dd></div>`,
    )
    .join(
      "",
    )}</dl><section class="v-detail-section"><h3>已采集执行事件</h3>${item.observations.length ? `<ol class="v-events">${item.observations.map((event) => `<li><time>${e(formatTime(event.observedAt))}</time><strong>${e(event.stage)}</strong><span>${e(event.state)}</span></li>`).join("")}</ol>` : empty("未采集执行事件", "服务端尚未收到此任务的执行器观测。")}</section><section class="v-detail-section"><h3>服务端流程记录</h3>${item.trace.length ? `<ol class="v-events">${item.trace.map((row) => `<li><strong>${e(row.title)}</strong><span>${e(row.status)}</span><span>${e(formatDuration(row.durationMs))}</span></li>`).join("")}</ol>` : empty("暂无流程记录")}</section>${item.proposal ? `<section class="v-detail-section"><h3>候选摘要</h3><p>${e(item.proposal)}</p></section>` : ""}${item.result ? `<section class="v-detail-section"><h3>执行回执</h3><p>${e(item.result.action)} · ${item.result.success ? "执行器报告成功" : "执行器报告失败"}</p>${item.result.error ? `<p class="v-error">${e(item.result.error)}</p>` : ""}<p class="v-note">任务回执不代表外部 CI 或部署已核验。</p></section>` : ""}</div>`;
}
