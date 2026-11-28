import { e, formatTime } from "../../shared/view.js";
import {
  choices,
  field,
  listTable,
  notConnected,
  panel,
  properties,
  sourceContent,
  submit,
  text,
} from "../../shared/workspace.js";

const when = (at) => e(formatTime(at));
function records(source, title, noData) {
  return panel(
    title,
    sourceContent(
      source,
      (data) =>
        listTable(
          ["键", "版本", "操作者", "时间"],
          data.items.map((row) => [
            text(row.key),
            text(row.version),
            text(row.actor),
            when(row.at),
          ]),
          noData,
        ) +
        `<p class="v-note">第 ${text(data.page)} 页 / ${text(data.pageCount)} · 共 ${text(data.total)} 项。</p>`,
    ),
    "来源：Hub 项目账本 · 当前只读。",
  );
}
export const requirementRecord = ({
  mode,
  state,
  page,
  number,
  commentsPage,
}) =>
  `${mode}:${state}:${page}${number ? `:${number}:${commentsPage ?? 1}` : ""}`;
export function renderRequirements(r, selected, s, taskHref) {
  const { mode, state, page, number, commentsPage } = selected;
  const href = (updated) =>
    `#requirements?record=${encodeURIComponent(requirementRecord({ ...selected, ...updated }))}`;
  const controls = `<form class="v-inline" data-local="requirements">${choices("mode", "类型", { issues: "Issues", prs: "Pull requests" }, mode)}${choices("state", "状态", { open: "开放", closed: "已关闭", all: "全部" }, state)}${field("page", "页码", page, { type: "number", required: true })}${submit("查看")}</form>`;
  const list = sourceContent(
    r.items,
    (data) =>
      listTable(
        ["编号", "标题", "状态", "作者", "更新"],
        data.items.map((row) => [
          `<a href="${e(href({ number: row.number, commentsPage: 1 }))}">#${text(row.number)}</a>`,
          text(row.title),
          text(row.draft ? "草稿" : row.state),
          text(row.author),
          when(row.updatedAt),
        ]),
        "此页没有结果",
      ) +
      `<footer class="v-pagination"><span>第 ${text(data.page, page)} 页 · 仅当前页，不推断全仓总数</span><div class="v-actions">${page > 1 ? `<a class="v-button" href="${e(href({ page: page - 1, number: null }))}">上一页</a>` : ""}${data.hasMore && page < 100 ? `<a class="v-button" href="${e(href({ page: page + 1, number: null }))}">下一页</a>` : ""}</div></footer>`,
  );
  const detail = number
    ? panel(
        `#${number} 详情`,
        sourceContent(
          r.detail,
          (data) =>
            `<h3>${text(data.item.title)}</h3>${properties([
              ["状态", text(data.item.state)],
              ["作者", text(data.item.author)],
              [
                "基线或 PR Head",
                text(data.item.baselineSha || data.item.headSha),
              ],
              ["契约摘要", text(data.item.contractHash)],
            ])}<pre class="v-code">${e(data.item.body)}</pre>${data.item.bodyTruncated || data.item.bodyRedacted ? '<p class="v-note">正文存在截断或脱敏，不可当作完整评审原文。</p>' : ""}<h4>评论 · 第 ${text(data.page, 1)} 页</h4>${listTable(
              ["作者", "时间", "内容"],
              data.comments.map((row) => [
                text(row.author),
                when(row.at),
                text(row.body),
              ]),
              "此页没有评论",
            )}<div class="v-actions">${commentsPage > 1 ? `<a class="v-button" href="${e(href({ commentsPage: commentsPage - 1 }))}">上一页评论</a>` : ""}${data.hasMore && commentsPage < 100 ? `<a class="v-button" href="${e(href({ commentsPage: commentsPage + 1 }))}">下一页评论</a>` : ""}</div>`,
        ),
        "来源：GitHub 项目读取连接器。",
        `<a href="${e(href({ number: null }))}">收起详情</a>`,
      )
    : "";
  const approvals = s.tasks.filter((entry) => entry.approvalFlow);
  return (
    panel(
      "任务审批",
      listTable(
        ["任务", "轮次", "审批状态"],
        approvals.map((entry) => [
          `<a href="${e(taskHref(entry.task.id))}">${text(entry.title)}</a>`,
          text(entry.approvalFlow.round),
          text(entry.approvalFlow.status),
        ]),
        "没有已登记的任务审批",
      ),
      "点击任务查看代码审阅与执行授权。与需求评审独立。",
    ) +
    panel(
      "GitHub 需求与 Pull Requests",
      controls + list,
      "现有 GitHub 项目范围 · 只读。",
    ) +
    detail +
    notConnected(
      "三方独立需求评审与授权、Reviews／Checks、REQ–AC–TC 关联尚无完整接口。本页不替 GitHub 写入。",
    )
  );
}
const jobs = (data) =>
  listTable(
    ["作业", "类型", "状态", "创建", "详情"],
    data.items.map((row) => [
      text(row.id),
      text(row.kind),
      text(row.state),
      when(row.createdAt),
      typeof row.id === "string"
        ? `<a href="#trace?record=${encodeURIComponent(`job:${row.id}`)}">查看</a>`
        : text(null),
    ]),
    "当前项目没有 QA 作业",
  );

export function renderTests(r, page) {
  const selectPage = `<form class="v-inline" data-local="advanced-page">${field("page", "回执页码", page, { required: true, type: "number" })}${submit("查看")}</form>`;
  return (
    panel(
      "独立 QA 作业",
      selectPage +
        sourceContent(
          r.jobs,
          (data) =>
            jobs(data) +
            `<p class="v-note">第 ${text(data.page)} 页 · 只读，不触发作业。</p>`,
        ),
    ) +
    panel(
      "证据与副作用",
      sourceContent(r.evidence, (data) =>
        listTable(
          ["证据", "任务", "作业", "结果"],
          data.items.map((row) => [
            text(row.id || row.digest),
            text(row.taskId),
            text(row.jobId),
            text(row.verdict ?? row.status),
          ]),
          "没有独立证据",
        ),
      ) +
        sourceContent(r.effects, (data) =>
          listTable(
            ["副作用", "类型", "状态", "时间"],
            data.items.map((row) => [
              text(row.id),
              text(row.kind),
              text(row.state),
              when(row.at),
            ]),
            "没有副作用记录",
          ),
        ),
    ) +
    records(r.reports, "测试报告", "没有报告记录") +
    panel(
      "禅道用例",
      sourceContent(r.cases, (data) =>
        listTable(
          ["编号", "标题", "版本", "状态", "优先级"],
          data.items.map((row) => [
            text(row.id),
            text(row.title),
            text(row.version),
            text(row.status),
            text(row.priority),
          ]),
          "此页没有用例",
        ),
      ),
    ) +
    notConnected(
      "用例详情、计划与授权、禅道回写和报告附件待对接。只读取现有报告、作业和用例，未启用独立作业执行。",
    )
  );
}

export function renderKnowledge(r) {
  return (
    records(r.knowledge, "知识记录", "没有已登记知识") +
    records(r.evaluation, "评估记录", "没有评估记录") +
    notConnected(
      "尚不提供知识正文编辑、审核与注入记录、评估样本对比和推广门禁。",
    )
  );
}
export function renderRadar(r) {
  return (
    records(r.radar, "技术雷达记录", "没有雷达记录") +
    notConnected(
      "可读现有账本；缺少雷达图和决策归档的完整数据，登记写入保持在旧版流程内。",
    )
  );
}
