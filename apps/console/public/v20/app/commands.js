import {
  existingOperations,
  taskPriorities,
  taskTypes,
} from "../api/contract.generated.js";
import { taskOffers } from "../domains/tasks/index.js";

export function canOperate(state, action, bulkType) {
  if (
    state.status !== "ready" ||
    state.writePending ||
    state.snapshot?.storage.status !== "ready"
  )
    return false;
  if (
    !Object.hasOwn(existingOperations, action) ||
    existingOperations[action].method === "GET"
  )
    return false;
  const capability =
    action === "taskBulk" ? bulkType : existingOperations[action].capability;
  if (action === "taskBulk" && !["cancel", "retry"].includes(capability))
    return false;
  return state.snapshot.capabilities[capability] === true;
}
const integer = (s) =>
  /^\d+$/.test(String(s ?? "")) && Number.isSafeInteger(Number(s))
    ? Number(s)
    : null;
const check = (value, message = "请核对表单和当前快照，再提交。") => {
  if (!value) throw new Error(message);
};
const taskRevision = (entry, value) => {
  check(
    entry && integer(value.revision) === entry.revision,
    "任务已更新，请刷新并重新查看详情后操作。",
  );
  return { expectedRevision: entry.revision };
};
const configRevision = (s, value, kind) => {
  const revision = integer(value.configRevision);
  check(
    revision !== null && revision === s.configRevisions?.[kind],
    "配置版本已变化，请刷新并重新填写后提交。",
  );
  return { expectedConfigRevision: revision };
};

/** Freeze an explicit user action against the exact row/version that was displayed. */
export function commandFor(state, { action, id, values = {}, selected = [] }) {
  check(
    canOperate(state, action, values.type),
    "当前快照不可写，或此接口尚未启用。",
  );
  const s = state.snapshot;
  const item = id ? s.tasks.find((x) => x.task.id === id) : null;
  const can = (op) => canOperate(state, op);
  const offer = taskOffers(item, can);
  let body, confirmation;
  switch (action) {
    case "taskCreate":
      check(
        values.title &&
          values.branch &&
          Object.hasOwn(taskTypes, values.type) &&
          Object.hasOwn(taskPriorities, values.priority),
      );
      body = {
        title: values.title,
        type: values.type,
        priority: values.priority,
        branch: values.branch,
        description: values.description || values.title,
      };
      break;
    case "taskCancel":
    case "taskRetry":
    case "taskVerify": {
      const type = {
        taskCancel: "cancel",
        taskRetry: "retry",
        taskVerify: "verify",
      }[action];
      check(offer[type], "当前任务不可执行此操作。");
      body = taskRevision(item, values);
      confirmation = {
        cancel: "确认请求取消此任务？已领取任务要等执行器确认。",
        retry: "确认创建一个重试任务？原记录会保留。",
        verify: "确认用配置的只读身份重新核验此 PR 与 CI？",
      }[type];
      break;
    }
    case "taskBulk": {
      check(
        selected.length >= 1 && selected.length <= 100,
        "请先选择 1–100 项任务。",
      );
      body = {
        type: values.type,
        items: selected.map(({ id, revision }) => ({ id, revision })),
      };
      confirmation = `确认批量${values.type === "retry" ? "重试" : "取消"}所选 ${selected.length} 项任务？服务端逐项核验，可能只处理部分。`;
      break;
    }
    case "approvalDecide": {
      const decision = values.decision,
        flow = item?.approvalFlow;
      check(
        flow &&
          integer(values.round) === flow.round &&
          (decision === "resubmit"
            ? offer.resubmit
            : ["approve", "reject"].includes(decision) &&
              offer.gate?.id === values.nodeId),
        "此审批轮次或节点已变化，请刷新后重新审阅。",
      );
      check(
        decision === "approve" || values.comment,
        "请填写拒绝或重新发起的说明。",
      );
      body = {
        ...taskRevision(item, values),
        round: flow.round,
        decision,
        comment: values.comment || "",
        ...(decision === "resubmit" ? {} : { nodeId: offer.gate.id }),
      };
      confirmation =
        decision === "resubmit"
          ? "确认将此候选重新送审？"
          : `确认对「${offer.gate.title}」作出${decision === "approve" ? "通过" : "拒绝"}决定？`;
      break;
    }
    case "taskReconcile":
      check(
        offer.reconcile &&
          ["no-changes", "changes-recorded"].includes(values.outcome) &&
          values.note,
        "请根据已核实的外部结果填写核对结论。",
      );
      body = {
        ...taskRevision(item, values),
        outcome: values.outcome,
        note: values.note,
      };
      confirmation = "确认记录已核实的外部结果？本操作不会自动重试或发布。";
      break;
    case "jenkinsImport": {
      const jenkins = s.integrations?.jenkins,
        buildNumber = integer(values.buildNumber);
      check(
        jenkins?.configured &&
          jenkins.sourceId === values.sourceId &&
          buildNumber > 0,
        "Jenkins 来源已变更或构建号无效，请刷新后核对。",
      );
      body = { sourceId: jenkins.sourceId, buildNumber };
      confirmation = `确认导入构建 #${buildNumber}？只读取失败构建，不触发 Jenkins。`;
      break;
    }
    case "ruleUpdate": {
      const rule = s.rules?.find((x) => x.id === id);
      check(
        rule &&
          ["true", "false"].includes(values.enabled) &&
          (values.enabled === "true") !== rule.enabled,
        "此规则已变化，请先刷新。",
      );
      body = {
        ...configRevision(s, values, "rules"),
        enabled: values.enabled === "true",
      };
      confirmation = `确认${body.enabled ? "启用" : "停用"}规则「${rule.name || rule.id}」？`;
      break;
    }
    case "monitoringCheck":
      body = {};
      break;
    case "monitoringUpdate": {
      const orgId = values.orgId ? integer(values.orgId) : undefined;
      check(orgId === undefined || orgId > 0, "组织 ID 必须是正整数。");
      const namespaces = values.namespaces
        ?.split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      check(
        values.baseUrl &&
          values.dashboardUid &&
          values.datasourceUid &&
          values.datasourceName &&
          namespaces?.length,
        "请填写 Grafana、数据源及命名空间。",
      );
      body = {
        ...configRevision(s, values, "monitoring"),
        monitoring: {
          grafana: {
            baseUrl: values.baseUrl,
            dashboardUid: values.dashboardUid,
            dashboardSlug: values.dashboardSlug || "",
            namespaceVariable: values.namespaceVariable,
            datasourceVariable: values.datasourceVariable,
            ...(orgId === undefined ? {} : { orgId }),
          },
          datasource: {
            type: "prometheus",
            uid: values.datasourceUid,
            name: values.datasourceName,
          },
          namespaces,
        },
      };
      confirmation =
        "确认保存这些监控配置？只有之后主动检查才会查询已配置来源。";
      break;
    }
    default:
      throw new Error("不支持的操作。");
  }
  return { action, options: { id, body }, confirmation };
}
