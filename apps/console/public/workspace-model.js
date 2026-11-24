/** Read-only projections. Trace history is not a live tool event stream. */
export const isV20 = (state) => state?.presentation === "v20";
const phases = { diagnose: "诊断", review: "候选审批", execute: "授权执行", done: "已结束" };
const labels = { pending: "等待领取", running: "运行中", completed: "已完成", failed: "执行失败", cancelled: "已取消", skipped: "已跳过" };
const stepLabels = { completed: "完成", running: "运行中", pending: "等待", failed: "失败" };
const terminalStates = new Set(["completed", "failed", "cancelled", "skipped"]);
const lookup = (map, key, fallback) => Object.hasOwn(map, key) ? map[key] : fallback;
const str = (value) => typeof value === "string" && value.trim() ? value : null;
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function workspaceExecution(entry = {}, state = {}) {
  const execution = entry.execution || {};
  const status = entry.status || {};
  const terminal = terminalStates.has(status.status);
  const reconcile = entry.reconciliation?.status === "required";
  const review = !terminal && entry.reviewState === "pending";
  const cancel = !terminal && execution.cancelRequested === true;
  const stale = Boolean(state.error || state.snapshot?.storage?.status === "read-only");
  const observedAt = date(state.snapshot?.generatedAt) === null ? null : state.snapshot.generatedAt;
  const leaseExpiresAt = date(execution.leaseExpiresAt) === null ? null : execution.leaseExpiresAt;
  const leaseExpired = observedAt !== null && leaseExpiresAt !== null && Date.parse(leaseExpiresAt) <= Date.parse(observedAt);
  const progress = typeof status.progress === "number" && Number.isFinite(status.progress) && status.progress >= 0 && status.progress <= 100 ? status.progress : null;
  const label = reconcile ? "待人工核对" : cancel ? "等待取消确认" : review ? "等待审批" :
    status.status === "pending" && execution.phase === "execute" ? "等待执行器领取" :
    status.status === "running" && execution.phase === "diagnose" ? "诊断中" :
    status.status === "running" && execution.phase === "execute" ? "执行已批准方案" :
    lookup(labels, status.status, "状态未知");
  const steps = Array.isArray(entry.trace) ? entry.trace.filter((step) => step && str(step.title)) : [];
  const last = steps.at(-1);
  return {
    label, terminal, stale, leaseExpired, observedAt, leaseExpiresAt, progress,
    phase: lookup(phases, execution.phase, "未提供"),
    message: (reconcile ? str(entry.reconciliation.reason) : cancel ? "已请求取消，尚未确认停止。" : str(status.message)) || "服务端未提供更详细的执行消息。",
    workerId: str(execution.workerId),
    traceCount: steps.length,
    lastStep: last ? { title: last.title, status: lookup(stepLabels, last.status, "未知") } : null,
    attention: reconcile || cancel || review || status.status === "failed",
    active: status.status === "running" && !reconcile && !cancel && !review && !stale && !leaseExpired,
  };
}

export function workspacePageNumbers(page, count) {
  const total = Number.isInteger(count) && count > 0 ? count : 1;
  const current = Number.isInteger(page) ? Math.min(total, Math.max(1, page)) : 1;
  const ordered = [...new Set([1, total, current - 1, current, current + 1])]
    .filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
  return ordered.flatMap((value, index) => index && value - ordered[index - 1] > 1 ? ["gap", value] : [value]);
}

export function activityPageSize(value) {
  return [10, 15, 20, 50].includes(Number(value)) ? Number(value) : 15;
}
