# 管理台 v5：监控、操作记录与统一界面

## 本次调整

根据本轮反馈，继续采用 v4 的浅色背景、细分隔线、单一蓝色重点和按需展开的详情。主要解决模块命名不直观、操作事件与日志混淆、路由规则只有配置表、基础组件各自实现的问题，并加入后续 Grafana 接入所需的界面和数据契约。

导航为：工作台、全部任务、审批中心、监控面板、操作记录、执行引擎、路由规则、安全策略、连接设置。展开宽度 196px，保留 64px 折叠模式和手机抽屉。

## 监控面板

同一入口内分为「面板预览」和「接入配置」。预览顶部统一放置命名空间、时间范围和「打开 Grafana」，下面展示数据源名称、UID、抓取状态面板及监控范围。没有真实指标时显示破折号与明确的布局预览状态。

表单分为 Grafana、Prometheus 数据源、监控命名空间三组。服务地址、仪表盘 UID、数据源 UID、命名空间为必填。显示名称用于识别；仪表盘路径名称、变量映射和组织 ID 可配置。高级变量默认收起。

- 数据源必须按 UID 绑定，名称不能代替 UID。
- 命名空间为显式集合；「全部已配置」只包含该集合，选择单项只能缩小范围。
- 聚合选项使用 `__configured__`，不会与真实命名空间 `all` 冲突。
- 打开链接携带数据源 UID、每一个选定命名空间及时间范围；支持 Grafana 子路径。
- 保存仅创建本机草稿，按模式和项目隔离；存储失败时明确降级为当前会话。不会修改服务端配置或 Agent 的实际监听范围。
- 支持下载配置片段和三面板 Grafana JSON 模板。配置需合并到 `configs/healing-config.json` 后由管理服务读取。
- 配置格式校验不会变成连通性验证。未实际查询 Grafana、Prometheus 或 Kubernetes；不加载第三方 iframe，也不把 API token 放到浏览器。

模板使用带 namespace 标签的 `up` 指标，展示抓取成功目标、抓取失败目标与目标抓取历史。它需要正确的抓取标签，不能推断 Agent 健康、任务成功或工作负载就绪。详见 [Grafana 接入说明](../monitoring-integration.md)。

## 操作记录与执行日志

操作记录按北京时间日期分组，展示实际事件提供的操作者、动作、说明和关联任务。支持关键词、操作类别与时间范围组合筛选，导出只包含当前筛选记录的允许字段。没有操作者信息时明确显示缺失，不从自由文本推测。

执行日志仍在任务详情的独立标签中；事件行提供直接进入该任务执行日志的入口。任务创建、审批、取消、重试与规则变更记录进入操作记录。

## 路由规则

桌面表格突出「规则 → 满足条件 → 引擎及动作 → 配置状态」，支持关键词、状态和引擎筛选。CI 规则的重试次数等附加条件完整展示；任务优先级不被误写为规则匹配顺序。

详情复用原生侧边详情对话框，分为条件与处理配置，并默认折叠 JSON。演示开关同时检查页面模式、快照模式与 `updateRules` 能力。真实配置只读，启用状态不代表执行器在线。

手机端使用纵向规则行，保留名称、条件、引擎、动作、状态与详情入口，避免宽表格使操作按钮移出屏幕。

## 组件与代码组织

`ui.js` 提供 `uiButton`、`uiSearch`、`uiSelect`、`uiField`、`uiStatus`、`uiTabs` 与 `uiEmpty`。`ui.css` 统一颜色、字体、圆角、按钮尺寸、焦点、表格与深色主题，并成为唯一颜色 token 来源。

任务、审批、工作台、监控、操作记录、路由、执行引擎、安全策略和连接设置共用这些基础组件。审批流程节点等业务组件保留专用布局，使用同一套颜色和表面样式。旧任务/审批 action、输入 ID、表单值与模型契约保持兼容。

## 验证记录

2026-11-09，本轮最终源代码验证：

- `npm test`：140 项通过，0 项失败。
- `npm run build`：TypeScript 检查与同源生产构建通过。
- `git diff --check` 与变更文件 Prettier 检查通过。
- 12 个任务、审批与概览渲染场景的控件契约与上一版本比较无差异。

实际浏览器检查：

- 数据源 UID 留空后显示字段错误并定位；有效字段保存为本机草稿，刷新后保留。
- 使用测试命名空间 `all, healing-system` 选择单独 `all`，外链只携带一个 `var-namespace=all`；聚合选择分别传递两项。
- 选择最近一小时，链接包含 `from=now-1h`、数据源 UID 和保留的 Grafana 子路径。
- 实际下载并解析配置 JSON、三面板 Grafana 模板，以及筛选后的一条操作记录 JSON。
- 操作分类和中文连续搜索有效；执行日志入口打开对应任务标签。
- CI 规则的「重试次数小于 3」在列表与详情均可见；停用操作刷新规则状态并产生操作记录。
- 任务筛选、当前页选择、混合资格的批量确认仍有效；第一关审批通过后进入执行授权，未跳过第二关。
- 执行引擎、安全策略、连接设置和工作台均可正常切换。
- 真实模式 API 不可用时明确显示连接异常，不回退演示数据。
- 浅色和深色主题可切换；390px 手机视口（375px 内容区）监控配置、任务和规则页无页面横向溢出，导航抽屉及完整名称可用。

## 本轮截图

以下均由实际运行页面截图，未使用生成图片替代界面。

| 页面             | 截图                                                 |
| ---------------- | ---------------------------------------------------- |
| 监控面板         | [monitoring-v5.jpg](monitoring-v5.jpg)               |
| Grafana 接入配置 | [monitoring-config-v5.jpg](monitoring-config-v5.jpg) |
| 操作记录         | [operations-v5.jpg](operations-v5.jpg)               |
| 路由规则         | [rules-v5.jpg](rules-v5.jpg)                         |
| 规则详情         | [rule-detail-v5.jpg](rule-detail-v5.jpg)             |
| 深色主题         | [monitoring-dark-v5.jpg](monitoring-dark-v5.jpg)     |
| 手机规则页       | [rules-mobile-v5.jpg](rules-mobile-v5.jpg)           |

## 参考

- [BoardUI Data Table](https://www.boardui.com/components/data-table)：表格基础组件、选择和筛选。
- [BoardUI Sidebar](https://www.boardui.com/components/sidebar)：图标导航与语义主题 token；本实现根据简约要求进一步减少附加信息。
- [Grafana URL variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/create-dashboard-url-variables/)：变量与多值参数。
- [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)：数据源 UID 和名称。
- [Grafana sharing](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/)：外部打开与嵌入条件。
- [Prometheus jobs and instances](https://prometheus.io/docs/concepts/jobs_instances/)：`up` 的抓取状态语义。

继续使用原有 feature 分支、Draft PR 与私人预览，不合并主分支。发布记录以 PR 和 Sites 的实际版本信息为准。
