import { e, formatTime, status } from "../../shared/view.js";
import {
  choices,
  field,
  form,
  listTable,
  panel,
  properties,
  submit,
  text,
} from "../../shared/workspace.js";

const positive = (value) => Number.isSafeInteger(value) && value > 0;
export function taskOffers(item, can) {
  if (!item) return {};
  const state = item.status.status,
    flow = item.approvalFlow;
  const gate =
    flow?.status === "pending" &&
    item.reviewState === "pending" &&
    item.execution.phase === "review"
      ? flow.gates?.find((x) => x.status === "pending")
      : null;
  return {
    cancel:
      can("taskCancel") &&
      ["pending", "running"].includes(state) &&
      !item.execution.cancelRequested,
    retry:
      can("taskRetry") &&
      ["failed", "cancelled"].includes(state) &&
      item.reconciliation?.status !== "required" &&
      !item.execution.blockedByReconciliation,
    gate: can("approvalDecide") ? gate : null,
    resubmit:
      can("approvalDecide") &&
      flow?.status === "rejected" &&
      state === "cancelled",
    verify:
      can("taskVerify") &&
      item.proposal?.version === 2 &&
      positive(item.result?.changes?.pr) &&
      /^[a-f0-9]{40}$/i.test(item.result?.changes?.commit || ""),
    reconcile:
      can("taskReconcile") &&
      ["failed", "cancelled"].includes(state) &&
      item.reconciliation?.status === "required",
  };
}
const hidden = (name, value) =>
  `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
export function renderCreateTask(snapshot, types, priorities, draft, disabled) {
  return `<header class="v-detail-head"><h2 id="task-detail-title">新建任务</h2><button class="v-button" data-action="close-detail">关闭</button></header><div class="v-detail-body"><p class="v-muted">此操作会将任务加入 ${text(snapshot.project.repo)} 的诊断队列，不授予发布权限。</p>${form("taskCreate", field("title", "标题", draft.title, { required: true }) + choices("type", "任务类型", types, draft.type || "format-error") + choices("priority", "优先级", priorities, draft.priority || "medium") + field("branch", "目标分支", draft.branch ?? snapshot.project.defaultBranch, { required: true }) + `<label>问题说明<textarea name="description" maxlength="10000" rows="4">${e(draft.description || "")}</textarea></label><div class="v-actions">${submit("创建任务", disabled)}</div>`)}</div>`;
}
export function renderTaskOperations(item, offers, draft = {}) {
  if (!item) return "";
  const id = item.task.id,
    flow = item.approvalFlow;
  const source = item.task.payload?.context?.source;
  const revision = hidden("revision", item.revision);
  const simple = (action, name) => form(action, revision + submit(name), id);
  const evidence = item.evidence;
  const summary = (entry) =>
    typeof entry === "string" ? entry : (entry?.summary ?? entry?.status);
  const evidenceRows = evidence
    ? properties([
        ["变更前", text(summary(evidence.beforeState))],
        ["变更后", text(summary(evidence.afterState))],
        ["运行检查", text(evidence.testsRun?.join("，"))],
        ["检查通过", text(evidence.checksPass?.join("，"))],
        ["检查失败", text(evidence.checksFail?.join("，"), "未报告失败")],
        ["候选摘要", text(item.proposal?.contentHash)],
      ])
    : "";
  const approval = flow
    ? panel(
        "任务审批",
        properties([
          ["轮次", text(flow.round)],
          ["状态", text(flow.status)],
        ]) +
          listTable(
            ["关卡", "状态", "审批人"],
            (flow.gates ?? []).map((x) => [
              text(x.title),
              text(x.status),
              text(x.actor),
            ]),
          ) +
          `<details><summary>审批记录</summary>${listTable(
            ["时间", "节点", "决定", "备注"],
            (flow.history ?? []).map((x) => [
              e(formatTime(x.at)),
              text(x.nodeId),
              text(x.decision),
              text(x.comment),
            ]),
          )}</details>` +
          (item.diff?.length
            ? `<div class="v-diffs"><h3>候选改动</h3>${item.diff.map((file, i) => `<details ${i === 0 ? "open" : ""}><summary>${text(file.path)} · +${text(file.additions)} / −${text(file.deletions)}</summary><pre>${(file.lines ?? []).map((line) => e(`${{ add: "+", remove: "-" }[line.type] ?? " "}${line.content}`)).join("\n")}</pre></details>`).join("")}</div>`
            : "") +
          evidenceRows +
          (offers.gate || offers.resubmit
            ? form(
                "approvalDecide",
                revision +
                  hidden("round", flow.round) +
                  hidden("nodeId", offers.gate?.id || "") +
                  choices(
                    "decision",
                    "本轮决定",
                    offers.resubmit
                      ? { resubmit: "重新发起审批" }
                      : { approve: "通过当前关卡", reject: "拒绝候选" },
                    draft.decision,
                  ) +
                  field(
                    "comment",
                    "审批说明（拒绝和重新发起时必填）",
                    draft.comment,
                    { max: 500 },
                  ) +
                  submit("提交审批决定"),
                id,
              )
            : ""),
        "只处理现有任务关卡，不替代 GitHub 需求授权或独立评审。",
      )
    : "";
  const verification = item.verification;
  const reconciliation = item.reconciliation;
  return `<div class="v-work-stack">${
    source
      ? panel(
          "任务来源",
          properties([
            ["来源", text(source.kind)],
            ["构建号", text(source.buildNumber)],
            ["失败提交", text(source.commitSha)],
            ["分支", text(source.branch)],
          ]),
        )
      : ""
  }${approval}${
    verification || offers.verify
      ? panel(
          "独立核验",
          (verification
            ? properties([
                ["状态", text(verification.status)],
                ["说明", text(verification.message)],
              ])
            : "") +
            (offers.verify ? simple("taskVerify", "重新核验 PR 与 CI") : ""),
          "执行回执与 PR／CI 结果分别核验。",
        )
      : ""
  }${
    reconciliation || offers.reconcile
      ? panel(
          "外部结果核对",
          properties([
            ["状态", text(reconciliation?.status)],
            ["结论", text(reconciliation?.resolution?.note)],
          ]) +
            (offers.reconcile
              ? form(
                  "taskReconcile",
                  revision +
                    choices(
                      "outcome",
                      "核对结论",
                      {
                        "no-changes": "已确认未产生外部变更",
                        "changes-recorded": "已记录实际外部变更",
                      },
                      draft.outcome,
                    ) +
                    field("note", "核对说明", draft.note, {
                      required: true,
                      max: 1000,
                    }) +
                    submit("保存核对结论"),
                  id,
                )
              : ""),
        )
      : ""
  }${
    item.resultReceipts?.length
      ? panel(
          "历次执行回执",
          listTable(
            ["收到时间", "种类", "结果"],
            item.resultReceipts.map((row) => [
              e(formatTime(row.receivedAt)),
              text(row.kind),
              row.result
                ? status(
                    row.result.success ? "报告成功" : "报告失败",
                    row.result.success ? "success" : "error",
                  )
                : text(null, "未提供"),
            ]),
          ),
        )
      : ""
  }${offers.cancel || offers.retry ? `<div class="v-actions">${offers.cancel ? simple("taskCancel", "取消任务") : ""}${offers.retry ? simple("taskRetry", "创建重试任务") : ""}</div>` : ""}</div>`;
}
