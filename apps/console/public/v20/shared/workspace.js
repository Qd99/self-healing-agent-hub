import { e, empty } from "./view.js";

export const text = (value, fallback = "未提供") =>
  e(
    (typeof value === "string" && value.length) || typeof value === "number"
      ? value
      : fallback,
  );

export function panel(title, content, description = "", tools = "") {
  return `<section class="v-plane v-work-panel"><header class="v-section-head"><div><h2>${e(title)}</h2>${description ? `<p>${e(description)}</p>` : ""}</div>${tools}</header><div class="v-panel-body">${content}</div></section>`;
}
export function listTable(headers, rows, noData = "暂无记录") {
  if (!rows.length) return empty(noData);
  return `<div class="v-table-scroll"><table class="v-table"><thead><tr>${headers.map((x) => `<th scope="col">${e(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
export function properties(rows) {
  return `<dl class="v-properties">${rows.map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}
export const notConnected = (what) =>
  `<p class="v-note v-deferred"><b>待接入</b> ${e(what)}</p>`;
export function sourceContent(source, render) {
  if (!source || source.state === "loading")
    return `<p class="v-muted" role="status">正在读取…</p>`;
  if (source.state === "unconfigured")
    return empty(
      "尚未配置",
      "当前管理服务没有启用此连接器或缺少读取权限配置。",
    );
  if (source.state === "forbidden")
    return empty("无权读取", "请核对当前会话在对应服务的权限。");
  if (source.state === "missing")
    return empty(
      "此入口未接入",
      "该服务端点未挂载在当前环境。旧入口不受影响。",
    );
  if (source.state !== "ready")
    return empty("读取失败", "未把连接或格式错误当作空数据，可刷新后重试。");
  return render(source.value);
}
export function field(
  name,
  label,
  value = "",
  { required = false, type = "text", max = 200 } = {},
) {
  return `<label>${e(label)}<input name="${e(name)}" value="${e(value)}" type="${type === "url" ? "url" : type === "number" ? "number" : "text"}" maxlength="${Number(max)}" ${required ? "required" : ""}></label>`;
}
export function choices(name, label, pairs, selected) {
  return `<label>${e(label)}<select name="${e(name)}">${Object.entries(pairs)
    .map(
      ([key, title]) =>
        `<option value="${e(key)}" ${key === selected ? "selected" : ""}>${e(title)}</option>`,
    )
    .join("")}</select></label>`;
}
export const submit = (label, disabled = false) =>
  `<button class="v-button primary" type="submit" ${disabled ? "disabled" : ""}>${e(label)}</button>`;
export const form = (action, body, id = "") =>
  `<form class="v-form" data-command="${e(action)}"${id ? ` data-id="${e(id)}"` : ""}>${body}</form>`;
