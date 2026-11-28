import { e, empty, formatTime } from "../../shared/view.js";
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
const num = (value) =>
  Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 })
    : "未采集";
const metricNames = { cpu: "CPU", memory: "内存", restarts: "重启次数" };

export function renderSeries(series) {
  const points = series.points.filter(
    ([t]) => Number.isFinite(t) && Math.abs(t) <= 8.64e15,
  );
  const valid = points.filter(([, v]) => Number.isFinite(v));
  if (!valid.length)
    return empty(
      "无有效采样",
      "连接已响应，但时间窗内没有有效数据，不按零值绘图。",
    );
  const values = valid.map(([, v]) => v),
    min = Math.min(...values),
    max = Math.max(...values);
  const lo = points[0][0],
    hi = points.at(-1)[0];
  const scale = Math.max(1, Math.abs(min), Math.abs(max));
  const span = max / scale - min / scale;
  const coordinates = ([t, value]) =>
    [
      9 + ((t - lo) / (hi - lo || 1)) * 622,
      span ? 112 - ((value / scale - min / scale) / span) * 100 : 61,
    ].map((v) => v.toFixed(2));
  let connected = false;
  const path = points
    .map((point) => {
      if (point[1] === null) {
        connected = false;
        return "";
      }
      const command = connected ? "L" : "M";
      connected = true;
      return command + coordinates(point).join(",");
    })
    .join(" ");
  const source = text(series.source, "Prometheus"),
    unit = text(series.unit);
  const timestamp = (at) => formatTime(new Date(at).toISOString());
  const title = metricNames[series.metric] ?? "时间序列";
  return `<figure class="v-chart"><figcaption>${e(title)} · ${unit} · 命名空间 ${text(series.namespace)} · ${source}</figcaption><svg viewBox="0 0 640 130" role="img" aria-label="${e(`${title}趋势，${valid.length} 个有效点`)}"><line x1="9" y1="112" x2="631" y2="112" class="v-axis"/><line x1="9" y1="12" x2="631" y2="12" class="v-axis"/><path d="${path}" class="v-series"/>${valid
    .map((point) => {
      const [cx, cy] = coordinates(point);
      return `<circle class="v-chart-point" cx="${cx}" cy="${cy}" r="5"><title>${e(`${timestamp(point[0])} · ${num(point[1])} ${series.unit}`)}</title></circle>`;
    })
    .join(
      "",
    )}</svg><div class="v-chart-labels"><span>${e(timestamp(lo))}</span><span>${e(timestamp(hi))}</span></div><p class="v-note">最小 ${e(num(min))} · 最大 ${e(num(max))} · 有效 ${valid.length}/${points.length}${series.partial ? " · 含数据源警告" : ""}</p><details><summary>查看采样表</summary>${listTable(
    ["北京时间", "观测值"],
    points.map(([t, value]) => [
      e(timestamp(t)),
      e(num(value)) + (value === null ? "" : ` ${unit}`),
    ]),
  )}</details></figure>`;
}
export function renderMonitor(r, selection, namespaces) {
  const controls = `<form class="v-inline" data-local="monitor">${choices("metric", "指标", metricNames, selection.metric)}${choices("range", "时间窗", { "15m": "15 分钟", "1h": "1 小时", "6h": "6 小时" }, selection.range)}${namespaces?.length ? choices("namespace", "命名空间", Object.fromEntries(namespaces.map((name) => [name, name])), selection.namespace) : ""}${submit("读取指标")}</form>`;
  return (
    panel(
      "Prometheus 实测指标",
      controls + sourceContent(r.metrics, renderSeries),
      "已有 CPU、内存和重启计数；缺失样本留空。",
    ) +
    panel(
      "活动告警",
      sourceContent(
        r.alerts,
        (data) =>
          listTable(
            ["告警", "级别", "状态", "开始", "摘要"],
            data.items.map((row) => [
              text(row.name),
              text(row.severity),
              text(row.state),
              when(row.activeAt),
              text(row.summary),
            ]),
            "当前范围没有活动告警",
          ) +
          `<p class="v-note">${text(data.namespace)} · 共 ${text(data.total)} 条${data.truncated ? "（列表已截断）" : ""}。</p>`,
      ),
      "告警属于所选命名空间。",
    ) +
    notConnected(
      "原型中的其它服务视图、历史告警与 Grafana 面板联动需单独补接。",
    )
  );
}

export function renderTrace(r, { record, views = {} }) {
  const filters = `<form class="v-inline" data-local="trace">${field("workflow", "任务或工作流 ID", record?.startsWith("workflow:") ? record.slice(9) : "", { max: 160 })}${submit("查采集事件")}</form>`;
  const jobs = sourceContent(r.jobs, (data) =>
    listTable(
      ["作业", "类型", "状态", "更新时间", "操作"],
      data.items.map((row) => [
        text(row.id),
        text(row.kind),
        text(row.state),
        when(row.updatedAt || row.createdAt),
        typeof row.id === "string"
          ? `<a href="#trace?record=${encodeURIComponent(`job:${row.id}`)}">查看</a>`
          : text(null),
      ]),
      "当前项目没有作业",
    ),
  );
  const detail = !record?.startsWith("job:")
    ? ""
    : panel(
        "作业详情",
        sourceContent(r.job, (data) =>
          properties([
            ["ID", text(data.id)],
            ["类型", text(data.kind)],
            ["状态", text(data.state)],
            ["配置档", text(data.profile)],
            ["创建", when(data.createdAt)],
            ["更新", when(data.updatedAt)],
          ]),
        ),
        "",
        '<a href="#trace">收起详情</a>',
      );
  const events = sourceContent(
    r.trace,
    (data) =>
      listTable(
        ["游标", "任务", "阶段", "来源", "状态", "时间"],
        data.items.map((row) => [
          text(row.cursor),
          text(row.task),
          text(row.stage),
          text(row.source),
          text(row.state),
          when(row.at),
        ]),
        "没有已采集事件",
      ) +
      `<p class="v-note">游标 ${text(data.cursor)} · ${data.hasMore ? "只显示首批事件，还有后续记录" : "已到查询末尾"}。</p>`,
  );
  return (
    panel(
      "作业",
      sourceContent(
        r.profiles,
        (data) =>
          `<p class="v-note">独立执行配置：${data.enabled ? `已启用 · ${data.profiles.length} 项` : "未启用"}。</p>`,
      ) + jobs,
    ) +
    detail +
    panel(
      "已采集的执行事件",
      filters + events,
      "只显示已收到的记录，不推断额外 span。",
    ) +
    panel(
      "Autoloop 已登记的执行事件",
      views.renderAutoloopTrace?.(r.autoloop) ?? "",
      "来自 Autoloop 工作台的事件明细，不是 OTLP span。",
    ) +
    notConnected(
      "完整瀑布、调用详情、跨源回放依赖真实 OTLP 采集，当前不冒充已接通。",
    )
  );
}
