import { escapeHtml as e } from "../../model.js";
export { escapeHtml as e, formatDuration } from "../../model.js";
export { icon } from "../../icons.js";

export function formatTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
export const status = (label, tone = "neutral") =>
  `<span class="v-status is-${["neutral", "info", "success", "warning", "error"].includes(tone) ? tone : "neutral"}"><i aria-hidden="true"></i>${e(label)}</span>`;
export const empty = (title, detail = "") =>
  `<div class="v-empty"><strong>${e(title)}</strong>${detail ? `<p>${e(detail)}</p>` : ""}</div>`;

export function renderSession(state) {
  const problem = state.error;
  if (state.status === "blocked") {
    const unconfigured = problem?.code === "AUTH_UNCONFIGURED";
    return `<section class="v-session" aria-labelledby="session-title"><h2 id="session-title">${unconfigured ? "尚未配置会话鉴权" : "退出结果未确认"}</h2><p role="alert">${e(problem?.message || "请确认当前浏览器会话后继续。")}</p>${unconfigured ? '<p class="v-muted">请联系服务管理员完成配置，再重新打开工作台。</p>' : '<div class="v-actions"><button class="v-button" data-action="retry-logout">重试上次退出</button><button class="v-button primary" data-action="confirm-logout">确认退出当前浏览器会话</button></div><p class="v-muted">确认前暂停读取工作区；此操作只退出当前浏览器会话。</p>'}</section>`;
  }
  const waiting = ["loading", "logging-out"].includes(state.status);
  if (waiting)
    return `<section class="v-session" role="status"><h2>${state.status === "logging-out" ? "正在退出" : "正在连接管理服务"}</h2><p>正在等待管理服务确认。</p></section>`;
  return `<section class="v-session" aria-labelledby="session-title"><h2 id="session-title">连接管理服务</h2><p>使用管理令牌建立当前浏览器会话。</p><form id="v20-login-form"><label for="v20-management-token">管理令牌</label><input id="v20-management-token" name="token" type="password" autocomplete="off" required spellcheck="false">${problem ? `<p class="v-error" role="alert">${e(problem.message)}</p>` : ""}<button class="v-button primary" type="submit">登录</button></form><p class="v-muted">令牌不会保存到浏览器本地存储。</p></section>`;
}
