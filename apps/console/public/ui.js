/** Shared console primitives. Labels and values are escaped; attrs/action slots are internal markup. */
import { icon as glyph } from "./icons.js";
import { escapeHtml as e } from "./model.js";

export function uiButton({
  label = "",
  icon,
  action,
  attrs = "",
  variant = "default",
  className = "",
  disabled = false,
  loading = false,
  title = "",
  type = "button",
} = {}) {
  const style = ["default", "primary", "ghost", "danger"].includes(variant)
    ? variant
    : "default";
  return `<button type="${e(type)}" class="ui-button ui-button-${style} ${e(className)}" ${action ? `data-action="${e(action)}"` : ""} ${disabled || loading ? "disabled" : ""} ${loading ? 'aria-busy="true"' : ""} ${title ? `title="${e(title)}"` : ""} ${attrs}>${loading ? `<span class="ui-spinner">${glyph("LoaderCircle", 15)}</span>` : icon ? glyph(icon, 15) : ""}${label ? `<span>${e(label)}</span>` : ""}</button>`;
}

export function uiSearch({
  id,
  value = "",
  placeholder = "",
  label = "搜索",
  className = "",
} = {}) {
  return `<label class="ui-search ${e(className)}" for="${e(id)}">${glyph("Search", 16)}<span class="sr-only">${e(label)}</span><input type="search" id="${e(id)}" value="${e(value)}" placeholder="${e(placeholder)}" autocomplete="off" spellcheck="false"></label>`;
}

export function uiSelect({
  id,
  value,
  options = [],
  label = "",
  className = "",
  disabled = false,
  attrs = "",
} = {}) {
  return `<label class="ui-select ${e(className)}" for="${e(id)}"><span class="sr-only">${e(label)}</span><select class="ui-select-input" id="${e(id)}" aria-label="${e(label)}" ${disabled ? "disabled" : ""} ${attrs}>${options.map((option) => `<option value="${e(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${e(option.label)}</option>`).join("")}</select></label>`;
}

export function uiStatus({
  label,
  tone = "neutral",
  icon,
  className = "",
  title = "",
} = {}) {
  const style = [
    "neutral",
    "success",
    "warning",
    "error",
    "info",
    "running",
  ].includes(tone)
    ? tone
    : "neutral";
  return `<span class="ui-status ui-status-${style} ${e(className)}" ${title ? `title="${e(title)}"` : ""}>${icon ? glyph(icon, 14) : '<i aria-hidden="true"></i>'}<span>${e(label)}</span></span>`;
}

export function uiMetric({
  label,
  value,
  unit = "",
  icon,
  tone = "neutral",
  detail = "",
  className = "",
} = {}) {
  const style = ["neutral", "info", "success", "warning", "error"].includes(
    tone,
  )
    ? tone
    : "neutral";
  return `<div class="ui-metric ${e(className)}"><div class="ui-metric-heading">${icon ? `<span class="ui-metric-icon ui-metric-icon-${style}">${glyph(icon, 16)}</span>` : ""}<span>${e(label)}</span></div><div class="ui-metric-value"><strong>${e(value)}</strong>${unit ? `<span>${e(unit)}</span>` : ""}</div>${detail ? `<p class="ui-metric-detail">${e(detail)}</p>` : ""}</div>`;
}

export function uiEmpty({
  icon = "Inbox",
  title,
  description = "",
  action = "",
  className = "",
} = {}) {
  return `<div class="ui-empty ${e(className)}"><span class="ui-empty-icon">${glyph(icon, 24)}</span><h3>${e(title)}</h3>${description ? `<p>${e(description)}</p>` : ""}${action ? `<div class="ui-empty-actions">${action}</div>` : ""}</div>`;
}

export function uiTabs({
  items = [],
  value,
  action,
  label = "视图",
  className = "",
} = {}) {
  return `<div class="ui-tabs ${e(className)}" role="group" aria-label="${e(label)}">${items.map((item) => `<button type="button" class="ui-tab ${value === item.id ? "is-active" : ""}" data-action="${e(action)}" data-value="${e(item.id)}" data-tab="${e(item.id)}" aria-pressed="${value === item.id}">${e(item.label)}${item.count != null ? `<span class="ui-tab-count">${e(item.count)}</span>` : ""}</button>`).join("")}</div>`;
}

export function uiField({
  id,
  name = id,
  label,
  value = "",
  placeholder = "",
  hint = "",
  error = "",
  type = "text",
  required = false,
  disabled = false,
  attrs = "",
  className = "",
} = {}) {
  return `<label class="ui-field ${e(className)}" for="${e(id)}"><span class="ui-field-label">${e(label)}${required ? '<span class="ui-required" aria-hidden="true">*</span>' : ""}</span><input class="ui-input" id="${e(id)}" name="${e(name)}" type="${e(type)}" value="${e(value)}" placeholder="${e(placeholder)}" ${required ? "required" : ""} ${disabled ? "disabled" : ""} ${error ? 'aria-invalid="true"' : ""} ${hint || error ? `aria-describedby="${e(id)}-hint"` : ""} ${attrs}>${hint || error ? `<span class="ui-field-hint ${error ? "is-error" : ""}" id="${e(id)}-hint">${e(error || hint)}</span>` : ""}</label>`;
}

export function downloadJSON(value, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
