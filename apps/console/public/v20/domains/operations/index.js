import { e, formatTime, status } from "../../shared/view.js";
import {
  field,
  form,
  listTable,
  notConnected,
  panel,
  properties,
  sourceContent,
  submit,
  text,
} from "../../shared/workspace.js";

const when = (value) => e(formatTime(value));
const taskLink = (entry, taskHref) =>
  `<a href="${e(taskHref(entry.task.id))}">${text(entry.title)}</a>`;
const settings = (name, value) => [name, text(value)];
const synced = (flag) =>
  flag ? status("已配置 · 未必已连通", "info") : status("未配置", "warning");

export function renderJenkins(s, { taskHref, can, draft }) {
  const source = s.integrations?.jenkins;
  const rows = s.tasks.filter(
    (x) => x.task.payload?.context?.source?.kind === "jenkins",
  );
  return (
    panel(
      "Jenkins 失败构建导入",
      properties([
        ["连接", synced(source?.configured)],
        settings("Job", source?.jobName),
        settings("分支", source?.branch),
      ]) +
        (can("jenkinsImport") && source?.configured && source.sourceId
          ? form(
              "jenkinsImport",
              `<input type="hidden" name="sourceId" value="${e(source.sourceId)}">` +
                field("buildNumber", "失败构建号", draft.buildNumber, {
                  required: true,
                  max: 12,
                }) +
                submit("导入失败构建"),
            )
          : `<p class="v-note">${e(source?.message || "当前项目尚未启用 Jenkins 导入。")}</p>`),
      "只导入已结束的失败构建，不触发 Jenkins job。",
    ) +
    panel(
      "已导入的任务",
      listTable(
        ["任务", "构建号", "失败提交", "核验"],
        rows.map((item) => {
          const build = item.task.payload.context.source;
          return [
            taskLink(item, taskHref),
            text(build.buildNumber),
            text(build.commitSha),
            text(item.verification?.status, "未核验"),
          ];
        }),
        "当前项目没有已导入构建",
      ) + notConnected("现有 API 不提供全量构建、阶段日志、排队与节点列表。"),
    )
  );
}

function runner(source) {
  return sourceContent(source, (value) =>
    properties([
      ["就绪状态", text(value.state)],
      ["阻塞原因", text(value.reason, "无已报告阻塞")],
      ...Object.entries(value.agents || {}).map(([id, state]) => [
        id,
        text(state),
      ]),
    ]),
  );
}
export function renderWorkers(s, r, views = {}) {
  return (
    panel(
      "Hub 执行引擎",
      listTable(
        ["引擎", "提供方", "模型", "状态"],
        s.engines.map((engine) => [
          text(engine.name || engine.id),
          text(engine.provider),
          text(engine.model),
          text(engine.status),
        ]),
        "此项目未登记执行引擎",
      ),
      "状态来自 Hub 真实连接，按引擎聚合，不是逐 Worker 名册。",
    ) +
    panel(
      "Autoloop 接单执行器",
      runner(r.runner),
      "来源：同域旧工作台的只读就绪接口。",
    ) +
    panel(
      "Autoloop 执行器名册与心跳",
      views.renderAutoloopAgents?.(r.autoloop),
      "来自 Autoloop 工作台实测快照；在线只表示最近有心跳。",
    ) +
    panel(
      "Autoloop 巡检规则线与通知通道",
      views.renderAutoloopChannels?.(r.autoloop),
      "",
    ) +
    panel(
      "已采集样本",
      sourceContent(r.samples, (data) =>
        listTable(
          ["采样时间", "来源", "指标", "值"],
          data.items.map((row) => [
            when(row.at || row.observedAt),
            text(row.source),
            text(row.name || row.metric),
            text(row.value),
          ]),
          "尚无执行器采集样本",
        ),
      ) +
        notConnected(
          "独立 Worker 名册、连接历史和资源槽未有现役完整读取契约。",
        ),
    )
  );
}
export function renderAudit(s, { taskHref, auditQuery = "", autoloop, views = {} } = {}) {
  const q = auditQuery.trim().toLocaleLowerCase();
  const filtered = s.activity.filter(
    (row) =>
      !q ||
      [row.action, row.message, row.actor].some((v) =>
        String(v ?? "")
          .toLocaleLowerCase()
          .includes(q),
      ),
  );
  const filter = `<form class="v-inline" data-local="audit">${field("query", "搜索当前快照", auditQuery)}${submit("筛选")}</form>`;
  return (
    panel(
      "Hub 操作记录",
      filter +
        listTable(
          ["时间", "类型", "操作者", "记录", "任务"],
          filtered
            .slice(0, 100)
            .map((row) => [
              when(row.at),
              text(row.action),
              text(row.actor),
              text(row.message),
              row.taskId
                ? `<a href="${e(taskHref(row.taskId))}">查看任务</a>`
                : text(null),
            ]),
          "当前快照无匹配操作",
        ) +
        `<p class="v-note">显示前 ${Math.min(filtered.length, 100)} 项／当前快照匹配 ${filtered.length} 项。不是跨服务审计全量。</p>`,
    ) +
    panel(
      "Autoloop 执行记录",
      views.renderAutoloopRuns?.(autoloop),
      "来自 Autoloop 工作台的真实执行记录。",
    )
  );
}
export function renderDelivery(s, { taskHref }) {
  const rows = s.tasks.filter((x) => x.result?.changes?.pr || x.verification);
  return panel(
    "PR 与 CI 核验记录",
    listTable(
      ["任务", "PR 编号", "提交", "CI 核验"],
      rows.map((x) => [
        taskLink(x, taskHref),
        text(x.result?.changes?.pr),
        text(x.result?.changes?.commit),
        text(x.verification?.status, "未核验"),
      ]),
      "当前项目没有可查的 PR／CI 核验",
    ) +
      notConnected(
        "未接可信部署回执、实际版本或制品，PR／CI 通过不代表部署完成。",
      ),
  );
}
export function renderHealing(s, { taskHref, autoloop, views = {} } = {}) {
  const rows = s.tasks;
  return (
    panel(
      "已登记的修复任务",
      listTable(
        ["任务", "类型", "当前状态", "外部结果"],
        rows
          .slice(0, 100)
          .map((x) => [
            taskLink(x, taskHref),
            text(x.task.type),
            text(x.status.status),
            text(x.reconciliation?.status, "无核对记录"),
          ]),
        "当前项目没有修复任务",
      ),
    ) +
    panel(
      "Autoloop 待处理事项",
      views.renderAutoloopCards?.(autoloop),
      "人工决策项；不等于 Hub 审批，也不代表已恢复。",
    ) +
    notConnected(
      "故障指纹、故障合并、恢复历史及独立复诊没有对应的现役读取接口。任务完成不等于已恢复。",
    )
  );
}

function monitorFields(m, draft) {
  const get = (key, value) => draft[key] ?? value;
  return (
    field("baseUrl", "Grafana 根地址", get("baseUrl", m?.grafana?.baseUrl), {
      required: true,
      type: "url",
      max: 500,
    }) +
    field(
      "dashboardUid",
      "Dashboard UID",
      get("dashboardUid", m?.grafana?.dashboardUid),
      { required: true },
    ) +
    field(
      "dashboardSlug",
      "Dashboard Slug",
      get("dashboardSlug", m?.grafana?.dashboardSlug),
    ) +
    field("orgId", "组织 ID（可选）", get("orgId", m?.grafana?.orgId), {
      type: "number",
    }) +
    field(
      "namespaceVariable",
      "命名空间变量",
      get("namespaceVariable", m?.grafana?.namespaceVariable || "namespace"),
      { required: true },
    ) +
    field(
      "datasourceVariable",
      "数据源变量",
      get("datasourceVariable", m?.grafana?.datasourceVariable || "datasource"),
      { required: true },
    ) +
    field(
      "datasourceUid",
      "Prometheus 数据源 UID",
      get("datasourceUid", m?.datasource?.uid),
      { required: true },
    ) +
    field(
      "datasourceName",
      "Prometheus 数据源名称",
      get("datasourceName", m?.datasource?.name),
      { required: true },
    ) +
    field(
      "namespaces",
      "允许的命名空间（逗号分隔）",
      get("namespaces", m?.namespaces?.join(", ")),
      { required: true, max: 1000 },
    )
  );
}
export function renderSettings(s, r, { can, draft, monitoringCheck }) {
  const m = s.monitoring;
  const monitoring = panel(
    "监控连接",
    properties([
      ["配置", synced(m?.configured)],
      settings("地址", m?.grafana?.baseUrl),
      settings("数据源", m?.datasource?.uid),
    ]) +
      (can("monitoringUpdate")
        ? `<details${draft.baseUrl !== undefined ? " open" : ""}><summary>编辑监控配置</summary>${form("monitoringUpdate", `<input type="hidden" name="configRevision" value="${e(draft.configRevision ?? s.configRevisions?.monitoring ?? "")}">` + monitorFields(m, draft) + submit("保存监控配置"))}${draft.baseUrl !== undefined ? '<button type="button" class="v-button" data-action="discard-monitor-draft">放弃草稿并读取当前配置</button>' : ""}</details>`
        : "") +
      (can("monitoringCheck")
        ? form("monitoringCheck", submit("检查已保存的连接"))
        : "") +
      (monitoringCheck
        ? `<p class="v-note">${text(monitoringCheck.status)} · ${text(monitoringCheck.message)} · ${when(monitoringCheck.checkedAt)}</p>`
        : ""),
    "只读连接检查区分已配置与已连通；凭据由服务端管理。",
  );
  const rules = panel(
    "规则与安全",
    listTable(
      ["规则", "状态", "操作"],
      (s.rules ?? []).map((rule) => [
        text(rule.name || rule.id),
        rule.enabled === true ? status("启用", "success") : status("停用"),
        can("ruleUpdate") && typeof rule.enabled === "boolean"
          ? form(
              "ruleUpdate",
              `<input type="hidden" name="enabled" value="${!rule.enabled}"><input type="hidden" name="configRevision" value="${e(s.configRevisions?.rules ?? "")}">` +
                submit(rule.enabled ? "停用" : "启用"),
              rule.id,
            )
          : text(null, "只读"),
      ]),
      "暂无路由规则",
    ) +
      properties([
        ["最大修复文件数", text(s.safety?.maxFilesPerFix)],
        ["必需检查", text(s.safety?.requiredChecks?.join("，"))],
        ["保护路径", text(s.safety?.protectedPaths?.join("，"))],
      ]),
  );
  return (
    panel(
      "现有服务入口",
      `<div class="v-actions"><a class="v-button" href="/models">模型配置</a><a class="v-button" href="/console">Autoloop 工作台</a><a class="v-button" href="/settings/feishu">旧版飞书授权</a></div><p class="v-note">保留独立服务和原鉴权；V20 不转发模型或飞书管理凭据。</p>`,
    ) +
    panel(
      "飞书与 Autoloop",
      sourceContent(r.feishu, (value) =>
        properties([
          [
            "通道",
            value.online
              ? status("在线", "success")
              : status("未在线", "warning"),
          ],
          ["机器人身份", text(value.bot)],
          ["用户身份", text(value.user)],
        ]),
      ) + runner(r.runner),
    ) +
    monitoring +
    rules
  );
}
