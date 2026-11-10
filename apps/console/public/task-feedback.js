import { escapeHtml as e } from "./model.js";
import { uiButton, uiStatus } from "./ui.js";

const actionNames = {
  committed: "已提交修复",
  "pr-created": "已创建 Pull Request",
  "issue-created": "已创建 Issue",
  retry: "已请求重试",
  skipped: "已跳过",
  failed: "执行失败",
};
const outcomeNames = {
  "no-changes": "确认未产生外部变更",
  "changes-recorded": "已核实并记录外部变更",
};

function artifacts(result, repo) {
  const changes = result.changes || {};
  // Construct every destination locally. Worker-provided URLs are never used.
  const validRepo =
    typeof repo === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repo) &&
    ![".", ".."].includes(repo.split("/")[1]);
  const base = validRepo ? `https://github.com/${repo}` : "";
  const link = (label, value, path, valid) =>
    value == null
      ? ""
      : `<div class="task-artifact"><span>${label}</span>${base && valid ? `<a href="${base}/${path}" target="_blank" rel="noopener noreferrer">${e(value)}</a>` : `<code>${e(value)}</code>`}</div>`;
  return `${link("Commit", changes.commit, `commit/${changes.commit}`, typeof changes.commit === "string" && /^[a-fA-F0-9]{7,40}$/.test(changes.commit))}${link("Pull Request", changes.pr, `pull/${changes.pr}`, Number.isSafeInteger(changes.pr) && changes.pr > 0)}${link("Issue", changes.issue, `issues/${changes.issue}`, Number.isSafeInteger(changes.issue) && changes.issue > 0)}${Array.isArray(changes.files) && changes.files.length ? `<div class="task-result-files"><span>记录的文件</span>${changes.files.map((file) => `<code>${e(file)}</code>`).join("")}</div>` : ""}`;
}

function resultBody(result, repo) {
  const error = result.error;
  return `<div class="task-result-heading">${uiStatus({ label: actionNames[result.action] || result.action || "已收到执行回执", tone: result.success === false ? "error" : "neutral" })}${typeof result.success === "boolean" ? `<span class="muted">${result.success ? "Agent 报告成功" : "Agent 报告失败"}</span>` : ""}</div>${error ? `<div class="detail-callout task-final-error"><strong>实际失败原因${error.code ? ` · ${e(error.code)}` : ""}</strong><p>${e(error.message || "执行器未提供具体原因")}</p>${error.suggestedAction ? `<p>建议：${e(error.suggestedAction)}</p>` : ""}</div>` : ""}${artifacts(result, repo)}`;
}

export function renderTaskFeedback(item) {
  const repo = item.task.payload.repo;
  const result = item.result;
  const receipts = item.resultReceipts || [];
  const stoppedBy = item.execution?.blockedByReconciliation;
  const stoppedHistory = stoppedBy
    ? `<section class="task-reconciliation" aria-label="原任务核对停止记录"><h3>因原任务核对而${item.status.status === "running" && item.execution.cancelRequested ? "请求停止" : "停止"}</h3><p>${e(stoppedBy.reason)}</p><p class="muted">历史停止记录 · <time>${e(stoppedBy.at)}</time>。后续操作以任务当前状态和核对结论为准。</p>${uiButton({ label: "查看原任务", action: "open-task", variant: "ghost", attrs: `data-id="${e(stoppedBy.taskId)}"` })}</section>`
    : "";
  const terminal = ["completed", "failed", "cancelled", "skipped"].includes(
    item.status.status,
  );
  const summary =
    result || terminal
      ? `<section class="task-result" aria-label="最终结果"><h3>最终结果</h3>${result ? resultBody(result, repo) : '<p class="muted">尚未收到最终执行回执。</p>'}${item.status.message ? `<p class="task-result-message">任务状态：${e(item.status.message)}</p>` : ""}</section>`
      : "";
  const history = receipts.length
    ? `<details class="task-receipts"><summary id="task-receipts-summary">回执记录（${receipts.length}）</summary><p class="muted">回执保留执行证据；任务状态以详情顶部为准。</p>${receipts.map((receipt) => `<section class="task-receipt"><p>${receipt.kind === "cancelled" ? "取消回执" : "完成回执"} · <time>${e(receipt.receivedAt)}</time></p>${receipt.result ? resultBody(receipt.result, repo) : '<p class="muted">未附执行结果</p>'}</section>`).join("")}</details>`
    : "";
  return stoppedHistory + summary + history;
}

export function renderReconciliation(item, state) {
  const reconciliation = item.reconciliation;
  if (!reconciliation) return "";
  const required = reconciliation.status === "required";
  const resolution = reconciliation.resolution;
  const pending = state.pendingAction === `reconcile:${item.task.id}`;
  const canWrite =
    required &&
    ["completed", "failed", "cancelled", "skipped"].includes(
      item.status.status,
    ) &&
    state.mode === "live" &&
    state.snapshot?.capabilities?.reconcile === true &&
    !state.authRequired;
  const draft =
    state.reconciliationDraft?.taskId === item.task.id
      ? state.reconciliationDraft
      : {};
  const disabled = pending || Boolean(state.pendingAction);
  return `<section class="task-reconciliation" aria-label="任务核对"><h3>${uiStatus({ label: required ? "待核对" : "已核对", tone: required ? "warning" : "success" })}</h3><p>${e(reconciliation.reason)}</p>${required ? '<p class="muted">请先核对仓库中的实际变更并记录结论，完成后才能重试。</p>' : ""}${resolution ? `<div class="detail-callout"><strong>${e(outcomeNames[resolution.outcome] || resolution.outcome)}</strong><p>${e(resolution.note)}</p><small>${e(resolution.actor)} · ${e(resolution.at)}</small></div>` : ""}${state.reconciliationError ? `<p class="task-feedback-error" role="alert">${e(state.reconciliationError)}</p>` : ""}${!required && state.reconciliationSuccess ? `<p class="task-feedback-success" role="status">${e(state.reconciliationSuccess)}</p>` : ""}${
    canWrite
      ? `<form id="reconciliation-form" data-task-id="${e(item.task.id)}" class="task-reconciliation-form"><label for="reconciliation-outcome">核对结论<select id="reconciliation-outcome" class="ui-select-input" name="outcome" required ${disabled ? "disabled" : ""}><option value="">请选择结论</option>${Object.entries(
          outcomeNames,
        )
          .map(
            ([value, label]) =>
              `<option value="${value}" ${draft.outcome === value ? "selected" : ""}>${label}</option>`,
          )
          .join(
            "",
          )}</select></label><label for="reconciliation-note">核对说明<textarea id="reconciliation-note" class="ui-textarea" name="note" required maxlength="1000" rows="2" ${disabled ? "disabled" : ""} placeholder="记录检查范围、实际变更和相关依据">${e(draft.note || "")}</textarea></label><div><button type="submit" data-action="reconciliation-submit" class="ui-button" ${disabled ? "disabled" : ""}>${pending ? "保存中…" : "保存核对结论"}</button></div></form>`
      : required
        ? '<p class="muted">当前会话仅可查看核对状态。</p>'
        : ""
  }</section>`;
}
