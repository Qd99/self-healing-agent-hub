import { e, empty, formatTime } from "../../shared/view.js";
import {
  listTable,
  notConnected,
  panel,
  properties,
  sourceContent,
  text,
} from "../../shared/workspace.js";

/** Autoloop runs are execution records from the live workbench, not Hub tasks. */
const stateLabels = {
  done: "已完成",
  running: "运行中",
  queued: "排队中",
  retrying: "重试中",
  failed: "失败",
  unknown: "状态未知",
  blocked: "阻塞",
  stopped: "已停止",
  pending: "等待中",
};
const stateTone = {
  done: "success",
  running: "info",
  queued: "neutral",
  retrying: "warning",
  failed: "error",
  blocked: "error",
};
const cardStateLabels = {
  open: "待处理",
  closed: "已处理",
  decided: "已决策",
};
const when = (at) => e(formatTime(at));
const label = (state) => stateLabels[state] ?? "状态未知";
const tone = (state) => stateTone[state] ?? "neutral";
const status = (textValue, toneValue) =>
  `<span class="v-status v-status-${e(toneValue)}">${e(textValue)}</span>`;

/** Picks the most recent run time the ledger actually recorded. */
function runTime(run) {
  return run.finishedAt || run.claimedAt || run.createdAt || null;
}

/**
 * Recent Autoloop executions. The list is the live workbench ledger, so the
 * column headings say so instead of implying these are Hub healing tasks.
 */
export function renderAutoloopRuns(source) {
  return sourceContent(source, (data) => {
    const rows = data.runs ?? [];
    if (!rows.length)
      return empty(
        "还没有运行记录",
        "Autoloop 快照已读取，但当前没有已登记的执行记录。",
      );
    const table = listTable(
      ["规则", "执行器", "状态", "最近可核时间", "结果"],
      rows.map((run) => [
        text(run.rule),
        text(run.agent),
        status(label(run.state), tone(run.state)),
        when(runTime(run)),
        run.error
          ? `<span class="v-error">${e(run.error)}</span>`
          : text(run.summary),
      ]),
      "还没有运行记录",
    );
    return `${table}<p class="v-note">来源 Autoloop 工作台 · 快照 ${when(data.observedAt)} · 序号 ${e(data.seq)}${data.hasMore ? " · 列表已截断，还有更多记录" : ""}。</p>`;
  });
}

/** Cards awaiting a human decision. These are not approvals and grant nothing. */
export function renderAutoloopCards(source, { limit = 20 } = {}) {
  return sourceContent(source, (data) => {
    const open = (data.cards ?? []).filter((card) => card.state === "open");
    const rows = (open.length ? open : (data.cards ?? [])).slice(0, limit);
    if (!rows.length)
      return empty(
        "没有待处理卡片",
        "Autoloop 当前没有等待人工决策的卡片。",
      );
    const table = listTable(
      ["卡片", "来源规则", "状态", "创建时间", "详情"],
      rows.map((card) => [
        `<strong>${e(card.title)}</strong>`,
        text(card.rule),
        status(cardStateLabels[card.state] ?? card.state, card.state === "open" ? "warning" : "success"),
        when(card.createdAt),
        card.text
          ? `<details><summary>展开</summary><p>${e(card.text)}</p>${card.link ? `<p class="v-note">${e(card.link)}</p>` : ""}</details>`
          : text(null),
      ]),
      "没有待处理卡片",
    );
    return `${table}<p class="v-note">待处理 ${e(open.length)} 项。卡片是 Autoloop 的人工决策项，不等于 Hub 审批，也不授予执行权限。</p>`;
  });
}

/** Agent roster with live heartbeat. Online is an observation, not a capability. */
export function renderAutoloopAgents(source) {
  return sourceContent(source, (data) => {
    const agents = data.agents ?? [];
    if (!agents.length)
      return empty("没有登记的执行器", "Autoloop 快照中没有执行器记录。");
    const table = listTable(
      ["执行器", "用途", "承载机器", "心跳", "最近状态"],
      agents.map((agent) => [
        `<strong>${e(agent.name || agent.id)}</strong>`,
        text(agent.use),
        text(agent.worker),
        status(
          agent.online ? "在线" : "未观测到心跳",
          agent.online ? "success" : "neutral",
        ),
        when(agent.seenAt),
      ]),
    );
    return `${table}<p class="v-note">快照 ${when(data.observedAt)}。在线表示最近有心跳，不表示已具备角色权限；角色就绪状态见「执行器」页。</p>`;
  });
}

/** Scheduled rules and notification channels. */
export function renderAutoloopChannels(source) {
  return sourceContent(source, (data) => {
    const channels = data.channels ?? [];
    const lines = data.lines ?? [];
    const channelTable = listTable(
      ["通道", "状态", "最近活动"],
      channels.map((channel) => [
        text(channel.name || channel.id),
        status(
          channel.online ? "在线" : "未观测到",
          channel.online ? "success" : "neutral",
        ),
        when(channel.seenAt),
      ]),
      "没有登记通道",
    );
    const lineTable = listTable(
      ["规则线", "执行器", "触发", "下次", "累计完成"],
      lines.map((line) => [
        text(line.name || line.id),
        text(line.agent),
        text(line.every),
        when(line.next),
        text(line.totals?.done),
      ]),
      "没有登记规则线",
    );
    return (
      panel("通知通道", channelTable) +
      panel("巡检规则线", lineTable)
    );
  });
}

/**
 * Workbench summary of the live Autoloop ledger: real counts, the executions
 * that just happened, and what is waiting for a human.
 */
export function renderAutoloopOverview(source) {
  return sourceContent(source, (data) => {
    const totals = data.totals ?? {};
    const summary = `<dl class="v-properties v-summary"><div><dt>已完成</dt><dd>${e(totals.done ?? "未采集")}</dd></div><div><dt>今日完成</dt><dd>${e(totals.doneToday ?? "未采集")}</dd></div><div><dt>运行中</dt><dd>${e(totals.running ?? "未采集")}</dd></div><div><dt>排队中</dt><dd>${e(totals.queued ?? "未采集")}</dd></div><div><dt>待处理</dt><dd>${e(totals.attention ?? "未采集")}</dd></div></dl>`;
    const recent = (data.runs ?? []).slice(0, 7);
    const feed = recent.length
      ? `<div class="v-feed"><div class="v-feed-head"><span>规则</span><span>状态 / 执行器</span><span>最近可核时间</span></div>${recent
          .map(
            (run) =>
              `<article class="v-feed-row"><div><strong>${e(run.rule)}</strong><p class="v-current">${e(run.summary || "无摘要")}</p></div><div>${status(label(run.state), tone(run.state))}<small>${e(run.agent)}</small></div><div><small>${when(runTime(run))}</small></div></article>`,
          )
          .join("")}</div>`
      : empty("还没有运行记录", "Autoloop 快照已读取，但当前没有已登记的执行记录。");
    const attention = (data.cards ?? []).filter((card) => card.state === "open");
    const attentionList = attention.length
      ? attention
          .slice(0, 5)
          .map(
            (card) =>
              `<div class="v-attention">${status("待处理", "warning")}<strong>${e(card.title)}</strong><small>${e(card.rule)}</small></div>`,
          )
          .join("")
      : empty("暂无待处理卡片", "Autoloop 当前没有等待人工决策的卡片。");
    return (
      panel(
        "Autoloop 工作台实测",
        summary,
        "来自 Autoloop 工作台的实时计数，不是 Hub 任务快照。",
      ) +
      panel("最近执行", feed, "按工作台记录的可核时间排序。") +
      panel("需要处理", attentionList, "人工决策项；不代表审批通过。")
    );
  });
}

/**
 * Trace page supplement: Autoloop runs already carry per-event detail, so the
 * page can show them next to the Hub event stream instead of a blank waterfall.
 */
export function renderAutoloopTrace(source) {
  return sourceContent(source, (data) => {
    const runs = (data.runs ?? [])
      .filter((run) => (run.events ?? []).length)
      .slice(0, 30);
    if (!runs.length)
      return empty(
        "没有已采集的执行事件",
        "Autoloop 快照中还没有带事件明细的运行记录。",
      );
    const rows = runs.flatMap((run) =>
      (run.events ?? []).map((event) => [
        text(run.rule),
        text(event.source),
        text(event.type),
        text(event.subject),
        text(event.summary),
        when(run.finishedAt || run.claimedAt || run.createdAt),
      ]),
    );
    return `${listTable(
      ["规则", "来源", "事件类型", "对象", "摘要", "时间"],
      rows,
      "没有已采集的执行事件",
    )}<p class="v-note">这些是 Autoloop 已登记的事件，不是 OTLP span；不推断父子关系，也不补不存在的调用。</p>`;
  });
}

export function renderAutoloopNotConnected(what) {
  return notConnected(what);
}

export { properties };
