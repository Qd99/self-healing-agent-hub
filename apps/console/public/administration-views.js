import { icon } from "./icons.js";
import { escapeHtml as e } from "./model.js";
import { uiButton, uiSearch, uiSelect, uiStatus, uiEmpty } from "./ui.js";
import {
  ACTIVITY_CATEGORIES,
  DEFAULT_ACTIVITY_FILTERS,
  DEFAULT_RULE_FILTERS,
  activityDateKey,
  administrationEngineName,
  canUpdateRules,
  describeActivity,
  describeRuleConditions,
  describeRuleProcessor,
  filterActivities,
  filterRules,
  groupActivities,
} from "./administration-model.js";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});
const timeOf = (at) =>
  Number.isFinite(Date.parse(at || ""))
    ? timeFormatter.format(new Date(at))
    : "时间未提供";
const sourceOf = (s) =>
  s.mode === "demo"
    ? "演示模板"
    : s.snapshot?.rulesSource === "configured"
      ? "healing-rules.json"
      : s.snapshot?.rulesSource === "example"
        ? "healing-rules.example.json"
        : "管理服务";
const taskButton = (id, label, tab = "trace") =>
  uiButton({
    label,
    action: "open-task",
    variant: "ghost",
    className: "adm-task-link",
    attrs: `data-id="${e(id)}" data-tab="${e(tab)}"`,
  });
const resetButton = (action) =>
  uiButton({ label: "重置筛选", action, variant: "ghost" });

function renderOperation(entry, tasks) {
  const description = describeActivity(entry);
  const relatedTask =
    entry.taskId && tasks.find((item) => item.task.id === entry.taskId);
  return `<li class="adm-operation">
    <span class="adm-operation-icon" aria-hidden="true">${icon(description.icon, 15)}</span>
    <div class="adm-operation-body">
      <div class="adm-operation-heading"><p><span>${e(description.actor)}</span><span class="adm-operation-separator" aria-hidden="true">·</span><strong>${e(description.label)}</strong></p><time datetime="${e(entry.at || "")}" title="${e(entry.at || "时间未提供")}">${e(timeOf(entry.at))}</time></div>
      ${description.message ? `<p class="adm-operation-message">${e(description.message)}</p>` : ""}
      ${entry.taskId ? `<div class="adm-operation-target">${relatedTask ? `${taskButton(entry.taskId, entry.taskId)}${taskButton(entry.taskId, "执行日志", "logs")}` : `<span class="adm-operation-task-id">${e(entry.taskId)}</span><span>关联任务未提供</span>`}</div>` : ""}
    </div>
  </li>`;
}

export function renderActivityPage(s) {
  const filters = { ...DEFAULT_ACTIVITY_FILTERS, ...s.activityFilters };
  const all = s.snapshot?.activity || [];
  const filtered = filterActivities(all, filters);
  const active = Boolean(
    filters.query.trim() ||
    filters.category !== "all" ||
    Number(filters.days) > 0,
  );
  const today = activityDateKey(new Date().toISOString());
  const groups = groupActivities(filtered);
  return `<section class="adm-workspace adm-activity" aria-label="操作记录">
    <p class="adm-caption">记录谁在何时做了什么；执行日志在任务详情中查看。</p>
    <div class="ui-toolbar adm-toolbar">
      ${uiSearch({ id: "activity-search", value: filters.query, label: "搜索操作记录", placeholder: "搜索操作、操作者或任务…", className: "adm-search" })}
      ${uiSelect({ id: "activity-category", value: filters.category, options: ACTIVITY_CATEGORIES, label: "操作类型" })}
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
    <div class="adm-list-summary"><span role="status" aria-live="polite">${active ? `筛选出 ${filtered.length} 条，共 ${all.length} 条` : `${all.length} 条操作记录`}</span><span>北京时间</span></div>
    ${
      !all.length
        ? uiEmpty({
            icon: "History",
            title: "还没有操作记录",
            description: "任务操作、审批与规则变更的记录会显示在这里。",
          })
        : !filtered.length
          ? uiEmpty({
              icon: "Search",
              title: "没有匹配的操作记录",
              description: "试试其他关键词或扩大时间范围。",
              action: resetButton("activity-reset"),
            })
          : `<div class="adm-operation-groups">${groups
              .map((group) => {
                const date =
                  group.date === "unknown"
                    ? "时间未提供"
                    : dateFormatter.format(
                        new Date(`${group.date}T12:00:00+08:00`),
                      );
                return `<section class="adm-operation-group"><h2>${group.date === today ? `<span>今天</span><span class="adm-date-label">${e(date)}</span>` : e(date)}<span class="adm-date-count">${group.items.length}</span></h2><ol>${group.items.map((entry) => renderOperation(entry, s.snapshot?.tasks || [])).join("")}</ol></section>`;
              })
              .join("")}</div>`
    }
  </section>`;
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
      ? `${rule.enabled ? "停用" : "启用"}此规则（仅本次演示）`
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
  const writable = canUpdateRules(s);
  return `<section class="adm-workspace adm-rules" aria-label="路由规则">
    <div class="adm-caption-row"><p class="adm-caption">定义什么任务交给哪个引擎，以及采用的处理动作。</p>${uiStatus({ label: writable ? "演示配置" : "配置只读", icon: writable ? "FlaskConical" : "LockKeyhole", tone: "neutral" })}</div>
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
    <div class="adm-list-summary"><span role="status" aria-live="polite">${active ? `筛选出 ${filtered.length} 条，共 ${all.length} 条` : `${all.length} 条规则 · ${all.filter((rule) => rule.enabled).length} 条已启用`}</span><span>${writable ? "开关仅影响本次演示" : `来源：${e(sourceOf(s))}`}</span></div>
    ${!all.length ? uiEmpty({ icon: "Workflow", title: "还没有路由规则", description: "管理服务提供规则配置后，可在这里查看分流条件与处理动作。" }) : !filtered.length ? uiEmpty({ icon: "Search", title: "没有匹配的规则", description: "试试其他关键词或调整规则状态。", action: resetButton("rules-reset") }) : `<div class="ui-card adm-rules-table"><table class="ui-table"><thead><tr><th scope="col">规则</th><th scope="col">当满足以下条件</th><th scope="col">交给引擎处理</th><th scope="col">配置状态</th><th scope="col"><span class="sr-only">详情</span></th></tr></thead><tbody>${filtered.map((rule) => renderRuleRow(rule, s)).join("")}</tbody></table></div>`}
  </section>`;
}

export function renderRoutingDetail(rule, s = {}) {
  const conditions = describeRuleConditions(rule);
  const processor = describeRuleProcessor(rule);
  const writable = canUpdateRules(s);
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
      <p class="adm-rule-boundary">${writable ? "开关仅修改本次演示；真实执行器尚未接入。" : "当前为只读配置，实际执行器尚未接入。"}</p>
      <details class="adm-rule-raw"><summary>${icon("Code2", 14)}查看配置 JSON${icon("ChevronDown", 14)}</summary><pre><code>${e(JSON.stringify(rule, null, 2))}</code></pre></details>
    </div>
    <div class="detail-bottom"><small>来源：${e(sourceOf(s))}</small><div class="adm-detail-actions">${writable ? uiButton({ label: rule.enabled ? "停用此规则" : "启用此规则", action: "toggle-rule", attrs: `data-id="${e(rule.id)}"` }) : uiStatus({ label: "配置只读", tone: "neutral", icon: "LockKeyhole" })}${uiButton({ label: "关闭", action: "close-detail", variant: "default" })}</div></div>`;
}
