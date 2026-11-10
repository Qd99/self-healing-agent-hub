import { icon } from "./icons.js";
import { escapeHtml as e } from "./model.js";
import { uiButton, uiSearch, uiSelect, uiStatus, uiEmpty } from "./ui.js";
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_LEVELS,
  DEFAULT_ACTIVITY_FILTERS,
  DEFAULT_RULE_FILTERS,
  administrationEngineName,
  canUpdateRules,
  describeActivity,
  describeRuleConditions,
  describeRuleProcessor,
  filterActivities,
  filterRules,
  getActivityPage,
} from "./administration-model.js";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const timeOf = (at, full = false) =>
  typeof at === "string" && Number.isFinite(Date.parse(at))
    ? (full ? dateFormatter : timeFormatter).format(new Date(at))
    : typeof at === "string" && at.trim()
      ? "时间无效"
      : "时间未提供";
const sourceOf = (s) =>
  s.mode === "demo"
    ? "演示模板"
    : s.snapshot?.rulesOverridden
      ? "管理服务保存的规则"
      : s.snapshot?.rulesSource === "configured"
        ? "healing-rules.json"
        : s.snapshot?.rulesSource === "example"
          ? "healing-rules.example.json"
          : "管理服务";
const taskButton = (id, label, tab = "trace") =>
  uiButton({
    label,
    icon: tab === "logs" ? "Terminal" : "ArrowUpRight",
    action: "open-task",
    variant: "ghost",
    className: "adm-task-link",
    attrs: `data-id="${e(id)}" data-tab="${e(tab)}"`,
  });
const resetButton = (action) =>
  uiButton({ label: "重置筛选", action, variant: "ghost" });

function renderOperation(entry) {
  const description = describeActivity(entry);
  const id = typeof entry.id === "string" ? entry.id : "";
  const target =
    typeof entry.taskId === "string" && entry.taskId.trim()
      ? entry.taskId
      : typeof entry.ruleId === "string" && entry.ruleId.trim()
        ? entry.ruleId
        : "—";
  const timestamp = typeof entry.at === "string" ? entry.at : "";
  const actionLabel = `查看${description.label}；${target === "—" ? "未关联对象" : target}；${description.actor}；${timeOf(timestamp)}；${description.level.label}`;
  return `<tr class="adm-activity-row" ${id ? `data-action="activity-detail" data-id="${e(id)}"` : ""}>
    <td class="adm-activity-action-cell">${uiButton({ label: description.label, icon: description.icon, action: id ? "activity-detail" : undefined, variant: "ghost", className: "adm-activity-action", disabled: !id, title: description.label, attrs: `data-id="${e(id)}" aria-label="${e(actionLabel)}"` })}${!id && description.message ? `<span class="sr-only">${e(description.message)}</span>` : ""}</td>
    <td class="adm-activity-object"><span title="${e(target)}">${e(target)}</span></td>
    <td class="adm-activity-actor"><span title="${e(description.actor)}">${e(description.actor)}</span></td>
    <td class="adm-activity-time">${Number.isFinite(Date.parse(timestamp)) ? `<time datetime="${e(timestamp)}" title="${e(timestamp)}">${e(timeOf(timestamp))}</time>` : `<span title="${e(timestamp)}">${e(timeOf(timestamp))}</span>`}</td>
    <td class="adm-activity-level">${uiStatus({ label: description.level.label, tone: description.level.tone, title: description.level.raw })}</td>
  </tr>`;
}

export function renderActivityPage(s) {
  if (!s.snapshot)
    return `<section class="ui-card adm-workspace adm-activity" aria-label="操作记录">${uiEmpty({ icon: "History", title: "尚未读取操作记录", description: "管理服务连接后，任务操作、审批与规则变更的记录会显示在这里。", action: uiButton({ label: "连接设置", icon: "Plug", action: "navigate", attrs: 'data-view="settings"' }) })}</section>`;
  const filters = { ...DEFAULT_ACTIVITY_FILTERS, ...s.activityFilters };
  const all = filterActivities(s.snapshot.activity);
  const page = getActivityPage(all, { filters, page: s.activityPage });
  const active = Boolean(
    String(filters.query || "").trim() ||
    filters.category !== "all" ||
    filters.level !== "all" ||
    Number(filters.days) > 0,
  );
  return `<section class="ui-card adm-workspace adm-activity" aria-label="操作记录">
    <div class="ui-toolbar adm-toolbar">
      ${uiSearch({ id: "activity-search", value: filters.query, label: "搜索操作记录", placeholder: "搜索操作、对象或操作者…", className: "adm-search" })}
      ${uiSelect({ id: "activity-category", value: filters.category, options: ACTIVITY_CATEGORIES, label: "操作类型" })}
      ${uiSelect({ id: "activity-level", value: filters.level, options: ACTIVITY_LEVELS, label: "记录级别" })}
      ${uiSelect({
        id: "activity-days",
        value: String(filters.days),
        options: [
          { value: "0", label: "全部时间" },
          { value: "1", label: "今天" },
          { value: "7", label: "近 7 天" },
          { value: "30", label: "近 30 天" },
          { value: "90", label: "近 90 天" },
        ],
        label: "操作时间",
      })}
      ${active ? resetButton("activity-reset") : ""}
    </div>
    <div class="adm-list-summary"><span role="status" aria-live="polite">${active ? `筛选出 ${page.total} 条，共 ${all.length} 条` : `${all.length} 条操作记录`}</span><span>北京时间</span></div>
    ${
      !all.length
        ? uiEmpty({
            icon: "History",
            title: "还没有操作记录",
            description: "任务操作、审批与规则变更的记录会显示在这里。",
          })
        : !page.total
          ? uiEmpty({
              icon: "Search",
              title: "没有匹配的操作记录",
              description: "试试其他关键词或扩大时间范围。",
              action: resetButton("activity-reset"),
            })
          : `<div class="adm-activity-table-wrap"><table class="ui-table adm-activity-table"><caption class="sr-only">操作记录，最新记录在前</caption><thead><tr><th scope="col">操作</th><th scope="col">关联对象</th><th scope="col">操作者</th><th scope="col">时间</th><th scope="col">记录级别</th></tr></thead><tbody>${page.items.map(renderOperation).join("")}</tbody></table></div>
          <div class="adm-pagination"><span>显示 ${page.start}–${page.end} 条，共 ${page.total} 条</span><nav aria-label="操作记录分页">${uiButton({ label: "上一页", icon: "ChevronLeft", action: "activity-page", variant: "ghost", disabled: page.page <= 1, attrs: `id="activity-page-prev" data-page="${page.page - 1}"` })}<span aria-live="polite">${page.page} / ${page.pageCount}</span>${uiButton({ label: "下一页", icon: "ChevronRight", action: "activity-page", variant: "ghost", disabled: page.page >= page.pageCount, attrs: `id="activity-page-next" data-page="${page.page + 1}"` })}</nav></div>`
    }
  </section>`;
}

export function renderActivityDetail(entry = {}, s = {}) {
  const record = entry && typeof entry === "object" ? entry : {};
  const description = describeActivity(record);
  const taskId = typeof record.taskId === "string" ? record.taskId : "";
  const ruleId = typeof record.ruleId === "string" ? record.ruleId : "";
  const tasks = Array.isArray(s.snapshot?.tasks) ? s.snapshot.tasks : [];
  const rules = Array.isArray(s.snapshot?.rules) ? s.snapshot.rules : [];
  const relatedTask = taskId && tasks.some((item) => item?.task?.id === taskId);
  const relatedRule = ruleId && rules.some((rule) => rule?.id === ruleId);
  const timestamp = typeof record.at === "string" ? record.at : "";
  const validTime = Number.isFinite(Date.parse(timestamp));
  const category = ACTIVITY_CATEGORIES.find(
    (item) => item.value === description.category,
  )?.label;
  return `<div class="detail-top adm-activity-detail-top"><span title="${e(typeof record.id === "string" ? record.id : "")}">操作记录 / <span class="mono">${e(typeof record.id === "string" && record.id ? record.id : "标识未提供")}</span></span>${uiButton({ label: "", icon: "X", action: "close-detail", variant: "ghost", className: "ui-icon-button", attrs: 'aria-label="关闭操作详情"' })}</div>
    <div class="detail-heading adm-activity-detail-heading"><span>${icon(description.icon, 15)}${e(category)}</span><h2 id="detail-title">${e(description.label)}</h2></div>
    <div class="detail-content adm-activity-detail">
      <dl class="adm-activity-properties">
        <div><dt>操作者</dt><dd>${e(description.actor)}</dd></div>
        <div><dt>发生时间</dt><dd>${validTime ? `<time datetime="${e(timestamp)}">${e(timeOf(timestamp, true))}</time><small>北京时间</small>` : e(timeOf(timestamp))}${timestamp ? `<code>${e(timestamp)}</code>` : ""}</dd></div>
        <div><dt>记录级别</dt><dd>${uiStatus({ label: description.level.label, tone: description.level.tone })}${description.level.raw ? `<code>${e(description.level.raw)}</code>` : ""}</dd></div>
        ${taskId ? `<div><dt>关联任务</dt><dd>${e(taskId)}${!relatedTask ? "<small>当前记录中未提供该任务</small>" : ""}</dd></div>` : ""}
        ${ruleId ? `<div><dt>关联规则</dt><dd>${e(ruleId)}${!relatedRule ? "<small>当前记录中未提供该规则</small>" : ""}</dd></div>` : ""}
      </dl>
      <section class="adm-activity-message"><h3>记录内容</h3><p>${e(description.message || "未提供消息")}</p></section>
    </div>
    <div class="detail-bottom adm-activity-detail-bottom"><div class="adm-detail-actions">${relatedTask ? `${taskButton(taskId, "查看任务")}${taskButton(taskId, "执行日志", "logs")}` : ""}${relatedRule ? uiButton({ label: "查看规则", icon: "Workflow", action: "rule-detail", variant: "ghost", attrs: `data-id="${e(ruleId)}"` }) : ""}</div>${uiButton({ label: "关闭", action: "close-detail" })}</div>`;
}

function ruleToggle(rule, s) {
  return uiButton({
    label: rule.enabled ? "已启用" : "已停用",
    icon: rule.enabled ? "Check" : "Square",
    action: "toggle-rule",
    variant: "ghost",
    className: "adm-rule-toggle",
    disabled: !canUpdateRules(s),
    title: canUpdateRules(s)
      ? `${rule.enabled ? "停用" : "启用"}此规则${s.mode === "demo" ? "（仅本次演示）" : ""}`
      : s.pendingAction && canUpdateRules({ ...s, pendingAction: "" })
        ? "正在保存，请稍候。"
        : "配置只读，请在服务端配置中修改。",
    attrs: `data-id="${e(rule.id)}" role="switch" aria-checked="${rule.enabled === true}" aria-label="${e(rule.name)}：${rule.enabled ? "已启用" : "已停用"}"`,
  });
}

function renderRuleRow(rule, s) {
  const conditions = describeRuleConditions(rule);
  const processor = describeRuleProcessor(rule);
  return `<tr class="adm-rule-row">
    <td class="adm-rule-name">${uiButton({ label: rule.name || rule.id, action: "rule-detail", variant: "ghost", className: "adm-rule-name-button", attrs: `data-id="${e(rule.id)}"` })}<span class="adm-rule-id">${e(rule.id)}</span></td>
    <td class="adm-rule-conditions"><ul>${conditions.map((condition, index) => `<li>${index ? '<span class="adm-conjunction">且</span>' : ""}${e(condition)}</li>`).join("")}</ul></td>
    <td class="adm-rule-processor"><span>${e(processor.engine)}</span><small>${e(processor.action)}</small></td>
    <td class="adm-rule-state">${ruleToggle(rule, s)}</td>
    <td class="adm-rule-open">${uiButton({ label: "", icon: "ChevronRight", action: "rule-detail", variant: "ghost", className: "ui-icon-button", title: `查看${rule.name || rule.id}`, attrs: `data-id="${e(rule.id)}" aria-label="查看${e(rule.name || rule.id)}"` })}</td>
  </tr>`;
}

export function renderRulesPage(s) {
  const all = s.snapshot?.rules || [];
  const filters = { ...DEFAULT_RULE_FILTERS, ...s.ruleFilters };
  const filtered = filterRules(all, filters);
  const active = Boolean(
    filters.query.trim() ||
    filters.status !== "all" ||
    filters.engine !== "all",
  );
  const engines = [
    ...new Set(all.map((rule) => rule.processor?.engine).filter(Boolean)),
  ];
  const writable = canUpdateRules({ ...s, pendingAction: "" });
  return `<section class="ui-card adm-workspace adm-rules" aria-label="路由规则">
    <div class="adm-caption-row"><p class="adm-caption">定义什么任务交给哪个引擎，以及采用的处理动作。</p>${uiStatus({ label: writable ? (s.mode === "demo" ? "演示配置" : "服务端配置") : "配置只读", icon: writable ? (s.mode === "demo" ? "FlaskConical" : "Database") : "LockKeyhole", tone: "neutral" })}</div>
    <div class="ui-toolbar adm-toolbar">
      ${uiSearch({ id: "rules-search", value: filters.query, label: "搜索路由规则", placeholder: "搜索规则名称、条件或动作…", className: "adm-search" })}
      ${uiSelect({
        id: "rules-status",
        value: filters.status,
        options: [
          { value: "all", label: "全部状态" },
          { value: "enabled", label: "已启用" },
          { value: "disabled", label: "已停用" },
        ],
        label: "规则状态",
      })}
      ${uiSelect({ id: "rules-engine", value: filters.engine, options: [{ value: "all", label: "全部引擎" }, ...engines.map((value) => ({ value, label: administrationEngineName(value) }))], label: "执行引擎" })}
      ${active ? resetButton("rules-reset") : ""}
    </div>
    <div class="adm-list-summary"><span role="status" aria-live="polite">${active ? `筛选出 ${filtered.length} 条，共 ${all.length} 条` : `${all.length} 条规则 · ${all.filter((rule) => rule.enabled).length} 条已启用`}</span><span>${writable ? (s.mode === "demo" ? "开关仅影响本次演示" : "开关影响新任务的路由") : `来源：${e(sourceOf(s))}`}</span></div>
    ${!all.length ? uiEmpty({ icon: "Workflow", title: "还没有路由规则", description: "管理服务提供规则配置后，可在这里查看分流条件与处理动作。" }) : !filtered.length ? uiEmpty({ icon: "Search", title: "没有匹配的规则", description: "试试其他关键词或调整规则状态。", action: resetButton("rules-reset") }) : `<div class="adm-rules-table"><table class="ui-table"><thead><tr><th scope="col">规则</th><th scope="col">当满足以下条件</th><th scope="col">交给引擎处理</th><th scope="col">配置状态</th><th scope="col"><span class="sr-only">详情</span></th></tr></thead><tbody>${filtered.map((rule) => renderRuleRow(rule, s)).join("")}</tbody></table></div>`}
  </section>`;
}

export function renderRoutingDetail(rule, s = {}) {
  const conditions = describeRuleConditions(rule);
  const processor = describeRuleProcessor(rule);
  const writable = canUpdateRules({ ...s, pendingAction: "" });
  return `<div class="detail-top"><span>路由规则 / <span class="mono">${e(rule.id)}</span></span>${uiButton({ label: "", icon: "X", action: "close-detail", variant: "ghost", className: "ui-icon-button", attrs: 'aria-label="关闭规则详情"' })}</div>
    <div class="detail-heading adm-rule-detail-heading"><h2 id="detail-title">${e(rule.name || rule.id)}</h2>${uiStatus({ label: rule.enabled ? "配置已启用" : "配置已停用", tone: rule.enabled ? "success" : "neutral" })}</div>
    <div class="detail-content adm-rule-detail">
      <div class="adm-routing-flow">
        <section class="adm-routing-section"><h3><span>当</span>满足以下条件</h3><ul class="adm-condition-list">${conditions.map((condition, index) => `<li>${icon(index ? "Plus" : "ListChecks", 14)}<span>${e(condition)}</span></li>`).join("")}</ul></section>
        <div class="adm-routing-arrow" aria-hidden="true">${icon("ArrowRight", 18)}</div>
        <section class="adm-routing-section"><h3><span>则</span>使用以下处理配置</h3><dl class="adm-processor-properties">
          <div><dt>执行引擎</dt><dd>${e(processor.engine)}<code>${e(rule.processor?.engine || "—")}</code></dd></div>
          <div><dt>处理动作</dt><dd>${e(processor.action)}<code>${e(rule.processor?.action || "—")}</code></dd></div>
          <div><dt>任务优先级</dt><dd>${e(processor.priority)}</dd></div>
          <div><dt>工作流</dt><dd>${e(processor.workflow)}${rule.processor?.workflow ? `<code>${e(rule.processor.workflow)}</code>` : ""}</dd></div>
        </dl></section>
      </div>
      <p class="adm-rule-boundary">${writable ? (s.mode === "demo" ? "开关仅修改本次演示；真实执行器尚未接入。" : "保存后，新创建的任务按当前启用规则路由；已有任务记录保留。") : "当前会话仅可查看规则配置。"}</p>
      <details class="adm-rule-raw"><summary>${icon("Code2", 14)}查看配置 JSON${icon("ChevronDown", 14)}</summary><pre><code>${e(JSON.stringify(rule, null, 2))}</code></pre></details>
    </div>
    <div class="detail-bottom"><small>来源：${e(sourceOf(s))}</small><div class="adm-detail-actions">${writable ? uiButton({ label: s.pendingAction === `rule:${rule.id}` ? "保存中…" : rule.enabled ? "停用此规则" : "启用此规则", action: "toggle-rule", disabled: Boolean(s.pendingAction), attrs: `data-id="${e(rule.id)}"` }) : uiStatus({ label: "配置只读", tone: "neutral", icon: "LockKeyhole" })}${uiButton({ label: "关闭", action: "close-detail", variant: "default" })}</div></div>`;
}
