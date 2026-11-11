import { escapeHtml as e } from "./model.js";
import { icon } from "./icons.js";
import { uiButton, uiField, uiStatus } from "./ui.js";
function safeExternal(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : "";
  } catch {
    return "";
  }
}
function commitLink(repo, sha) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(
    repo || "",
  ) &&
    ![".", ".."].includes(repo.split("/")[1]) &&
    /^[a-f0-9]{40}$/i.test(sha || "")
    ? `https://github.com/${repo}/commit/${sha}`
    : "";
}
const link = (url, label) =>
  url
    ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)}${icon("ArrowUpRight", 12)}</a>`
    : `<span>${e(label)}</span>`;
export function renderCiImport(s) {
  const source = s.snapshot?.integrations?.jenkins,
    pending = s.pendingAction === "ci-import";
  const allowed =
    s.mode === "live" &&
    source?.configured &&
    s.snapshot?.capabilities?.importCi &&
    !s.authRequired &&
    !s.pendingAction;
  const unavailable =
    s.mode === "demo"
      ? "演示模式不读取真实 CI，请切换到已连接的管理服务。"
      : !source?.configured
        ? source?.message ||
          "管理服务尚未配置 Jenkins 来源。完成服务端接入后即可导入。"
        : !s.snapshot?.capabilities?.importCi
          ? "当前会话仅可查看，暂时无法导入构建。"
          : "";
  const result = s.ciImportResult,
    names = {
      created: "已加入诊断队列",
      duplicate: "该构建已导入",
      ignored: "无需创建任务",
    };
  return `<div class="spread"><h2 id="create-title">导入 CI 构建</h2>${uiButton({ icon: "X", action: "close-create", variant: "ghost", attrs: 'aria-label="关闭构建导入"' })}</div><p class="intro">读取失败构建，固定本次提交后加入诊断队列。</p><div class="ci-source-summary">${icon("Workflow", 18)}<div><strong>${e(source?.jobName || "Jenkins")}</strong><span>${e(source?.branch || "尚未配置来源")}${source?.sourceId ? ` · ${e(source.sourceId)}` : ""}</span></div>${uiStatus({ label: source?.configured ? "已配置" : "未配置" })}</div>${unavailable ? `<p class="ui-section-note" role="status">${e(unavailable)}</p>` : ""}<form id="ci-import-form">${uiField({ id: "ci-build-number", name: "buildNumber", label: "构建号", value: s.ciImportDraft?.buildNumber || "", placeholder: "例如 128", hint: "使用该 Jenkins 任务中的构建编号。", required: true, disabled: !allowed, attrs: 'inputmode="numeric" pattern="[0-9]+" maxlength="16" autocomplete="off"' })}<p id="ci-import-error" class="form-error" role="alert">${e(s.ciImportError || "")}</p>${result ? `<div class="ci-import-result" role="status">${uiStatus({ label: names[result.outcome] || "已收到导入结果", tone: result.outcome === "created" ? "success" : "neutral" })}<p>${e(result.message || "")}</p>${result.taskId ? uiButton({ label: "查看任务", icon: "ArrowUpRight", action: "ci-open-task", variant: "ghost", attrs: `data-id="${e(result.taskId)}"` }) : ""}</div>` : ""}<div class="form-actions">${uiButton({ label: "关闭", action: "close-create" })}${uiButton({ label: pending ? "读取构建中…" : "导入构建", type: "submit", icon: "Download", variant: "primary", disabled: !allowed, loading: pending })}</div></form>`;
}
export function renderTaskSource(item) {
  const context = item.task?.payload?.context,
    source = context?.source,
    p = item.proposal;
  if (source?.kind !== "jenkins") return "";
  const identity =
    p?.version === 2
      ? `<details class="ci-candidate"><summary id="ci-candidate-summary">候选标识</summary><dl>${[
          ["审批摘要", p.contentHash],
          ["补丁 SHA-256", p.candidate?.patchSha256],
          ["Git tree", p.candidate?.treeSha],
        ]
          .map(
            ([label, value]) =>
              `<div><dt>${label}</dt><dd><code>${e(value || "—")}</code></dd></div>`,
          )
          .join("")}</dl></details>`
      : "";
  return `<section class="task-ci-source" aria-label="失败构建来源"><div class="ci-source-title">${icon("Workflow", 15)}<strong>${e(source.jobName)}</strong>${link(safeExternal(source.buildUrl), `构建 #${source.buildNumber}`)}</div><div class="ci-source-commit"><span>失败提交</span>${link(commitLink(item.task.payload.repo, context.commitSha), context.commitSha || "未提供")}</div>${identity}</section>`;
}
const labels = {
  pending: ["等待 CI", "warning"],
  passed: ["CI 核验通过", "success"],
  failed: ["CI 检查失败", "error"],
  mismatch: ["证据不一致", "error"],
  error: ["核验未完成", "warning"],
  stale: ["需要重新核验", "warning"],
};
const checks = {
  pass: "通过",
  fail: "不一致",
  pending: "等待",
  unknown: "未确认",
};
export function renderTaskVerification(item, s) {
  if (item.proposal?.version !== 2) return "";
  const v = item.verification,
    config = s.snapshot?.integrations?.verification;
  const hasPr =
    Number.isSafeInteger(item.result?.changes?.pr) &&
    item.result.changes.pr > 0 &&
    /^[a-f0-9]{40}$/i.test(item.result.changes.commit || "");
  const [label, tone] = labels[v?.status] || [
    hasPr ? "尚未核验" : "待创建修复 PR",
    "neutral",
  ];
  const pending = s.pendingAction === `verify:${item.task.id}`;
  const allowed =
    hasPr &&
    s.mode === "live" &&
    config?.configured &&
    s.snapshot?.capabilities?.verifyResult &&
    !s.authRequired &&
    !s.pendingAction;
  const unavailable = !config?.configured
    ? config?.message || "管理服务尚未配置独立 CI 核验。"
    : !s.snapshot?.capabilities?.verifyResult
      ? "当前会话仅可查看核验记录。"
      : "";
  const feedback =
    s.ciVerificationFeedback?.taskId === item.task.id
      ? s.ciVerificationFeedback
      : null;
  const proof = v?.checks
    ? `<div class="ci-check-grid">${[
        ["pullRequest", "PR 来源"],
        ["commit", "提交"],
        ["files", "文件"],
        ["ci", "CI 状态"],
      ]
        .map(
          ([key, name]) =>
            `<div><span>${name}</span>${uiStatus({ label: checks[v.checks[key]] || "未确认", tone: v.checks[key] === "pass" ? "success" : v.checks[key] === "fail" ? "error" : "neutral" })}</div>`,
        )
        .join("")}</div>`
    : "";
  const contexts = v?.statuses?.length
    ? `<details class="ci-contexts"><summary id="ci-contexts-summary">CI 检查项 · ${v.statuses.length}</summary>${v.statuses.map((entry) => `<div><code>${e(entry.context)}</code><span>${e({ success: "通过", pending: "等待", failure: "失败", error: "错误" }[entry.state] || "未确认")}</span></div>`).join("")}</details>`
    : "";
  return `<section class="task-ci-verification" aria-label="PR 与 CI 核验"><header><h3>${icon("ShieldCheck", 15)}PR 与 CI</h3>${uiStatus({ label, tone })}${uiButton({ label: pending ? "核验中…" : "核验 PR 与 CI", action: "ci-verify", icon: "RefreshCw", attrs: `data-id="${e(item.task.id)}"`, disabled: !allowed, loading: pending, title: !hasPr ? "收到修复 PR 回执后可核验" : unavailable })}</header>${v?.message ? `<p>${e(v.message)}</p>` : hasPr ? '<p class="muted">PR 已创建，CI 结果尚未由管理服务独立核验。</p>' : '<p class="muted">候选审批并执行后，在这里核对修复 PR 和 CI 结果。</p>'}${proof}${contexts}${v?.checkedAt ? `<p class="ci-checked-at">最近查询 <time>${e(v.checkedAt)}</time></p>` : ""}${unavailable ? `<p class="muted">${e(unavailable)}</p>` : ""}${feedback?.error ? `<p class="task-feedback-error" role="alert">${e(feedback.error)}</p>` : feedback?.message ? `<p class="muted" role="status">${e(feedback.message)}</p>` : ""}</section>`;
}
