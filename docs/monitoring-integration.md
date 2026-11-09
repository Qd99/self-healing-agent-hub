# Grafana 与 Prometheus 监控对接

管理台提供监控配置、命名空间范围选择、Grafana 链接和仪表盘模板导出。当前网关不会请求 Grafana、Prometheus 或 Kubernetes，也不会读取真实指标。`ready` 表示配置结构完整、可生成链接；所有状态的 `connectivity` 都是 `unverified`。打开 Grafana 后，需要在目标环境验证访问权限、数据源和查询结果。

浏览器中的配置修改是当前模式的本地草稿。导出配置不等于保存到服务器；网关仍只读取仓库配置。真实任务触发、取消、重试、审批、规则修改能力继续为 `false`。示例模式使用保留的 `.invalid` 主机和明确的 demo 数据源名称，不表示已经建立监控连接。

## 配置位置与字段

将下面的 `monitoring` 块合并到现有 `configs/healing-config.json`，保留原有项目、引擎、安全和触发配置。示例中的主机、UID、数据源名称和命名空间需要替换为实际环境值。不要用这个片段覆盖整个配置文件。

```json
{
  "monitoring": {
    "grafana": {
      "baseUrl": "https://grafana.example.invalid/observability",
      "dashboardUid": "healing-monitoring",
      "dashboardSlug": "namespace-scrapes",
      "orgId": 1,
      "namespaceVariable": "namespace",
      "datasourceVariable": "datasource"
    },
    "datasource": {
      "type": "prometheus",
      "uid": "replace-with-actual-uid",
      "name": "Prometheus display name"
    },
    "namespaces": ["healing-system", "applications"]
  }
}
```

| 字段                         | 要求与含义                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grafana.baseUrl`            | Grafana 的公开基础地址，可含 `/observability` 一类子路径。要求 HTTPS；仅 `localhost`、`127.0.0.1`、`[::1]` 允许开发用 HTTP。不要填写完整仪表盘 URL、用户名密码、token、查询参数或片段。 |
| `grafana.dashboardUid`       | 目标仪表盘 UID，1–40 位字母、数字、下划线或连字符。名称或标题不能替代 UID。                                                                                                             |
| `grafana.dashboardSlug`      | 可选 URL slug，默认 `healing-overview`；允许 1–120 位字母、数字、下划线或连字符。仪表盘使用 UID 标识。                                                                                  |
| `grafana.orgId`              | 可选正整数。适用于需要显式选择组织的 Grafana 环境；未填写时不添加该 URL 参数。                                                                                                          |
| `grafana.namespaceVariable`  | 仪表盘中的命名空间变量名，默认 `namespace`。填写实际变量名，不带 `var-` 前缀。                                                                                                          |
| `grafana.datasourceVariable` | 仪表盘中的 Prometheus 数据源变量名，默认 `datasource`，必须与命名空间变量不同。                                                                                                         |
| `datasource.uid`             | 必填的 Grafana 数据源 UID，1–40 位字母、数字、下划线或连字符。链接和仪表盘引用均绑定此 UID。                                                                                            |
| `datasource.name`            | 仅供显示，可省略或留空。不会用名称推断、查找或替代 UID。                                                                                                                                |
| `datasource.type`            | 可省略，默认为 `prometheus`；当前只支持 Prometheus。                                                                                                                                    |
| `namespaces`                 | 1–100 个显式 Kubernetes 命名空间名称。每个名称为 1–63 位小写字母、数字或连字符，首尾必须是字母或数字。重复项保留第一次出现的顺序并去重。                                                |

两个变量名仅允许字母、数字、下划线，首字符必须是字母或下划线；不允许使用 Grafana 保留的 `__` 前缀。基础地址中的简单子路径允许字母、数字、`-`、`_`、`.`、`~`；不接受路径穿越和百分号编码路径。

Grafana 官方配置将数据源 `name` 和 `uid` 分开：名称是显示引用，UID 用于其他配置中的稳定引用。数据源变量应使用 **Data source** 类型，并限定 **Prometheus**，其当前值绑定实际 UID。此功能不创建数据源、不修改 Grafana provisioning，也不会请求 Grafana 数据源 API。[Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/) · [Data source variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/add-template-variables/) · [UID 字符限制](https://grafana.com/docs/grafana/latest/upgrade-guide/upgrade-v11/upgrade-v11.2/)

## 命名空间范围与链接

“全部关注的命名空间”表示枚举配置列表中的每个名称，不表示整个集群。空列表、`*`、正则表达式、Grafana 的 `$__all` 以及未列入配置的名称都会阻止生成链接。选择一个或多个命名空间时，只允许配置列表的非空子集。

例如，选择上述两个命名空间后，生成的 URL 具有下面的结构：

```text
https://grafana.example.invalid/observability/d/healing-monitoring/namespace-scrapes?orgId=1&from=now-6h&to=now&var-datasource=replace-with-actual-uid&var-namespace=healing-system&var-namespace=applications
```

链接使用 `URL` 和 `URLSearchParams` 构造。Grafana 以 `var-<变量名>` 读取变量；多值通过重复同一个参数传递。不会把逗号拼接字符串、显示名称或原始查询片段作为命名空间选择传入。支持的时间范围为最近 15 分钟、1 小时、6 小时、24 小时、7 天，默认 6 小时；结束时间固定为 `now`。[Dashboard URL variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/create-dashboard-url-variables/)

已有仪表盘必须定义与配置同名的变量，并在相关面板查询中使用它们。向 URL 添加变量参数不能保证原有仪表盘已经按这些变量过滤。只有同名变量存在、参与查询、允许多值并正确绑定数据源时，链接才会产生预期的范围。

命名空间过滤属于展示范围，不是访问控制。Grafana 和数据源仍需执行其自身的身份验证与授权。同名命名空间可能存在于不同集群；如果一个 Prometheus 数据源汇总多个集群，应在仪表盘中增加实际存在的集群标签过滤，或使用专用于目标集群的数据源。当前配置不会猜测集群标签或集群标识。

## 仪表盘模板的实际含义

`buildGrafanaDashboard` 生成可导入的 **Classic Grafana JSON**，不会自动导入、更新仪表盘或执行查询。模板包含数据源变量、显式命名空间多选变量和三个面板：

| 面板           | PromQL（默认变量名）                                           | 解释                                                               |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| 抓取成功的目标 | `sum by (namespace) (up{namespace=~"${namespace:regex}"})`     | 按命名空间统计最近一次抓取成功的目标数。                           |
| 抓取失败的目标 | `sum by (namespace) (1 - up{namespace=~"${namespace:regex}"})` | 按命名空间统计最近一次抓取失败的目标数。                           |
| 各目标抓取状态 | `up{namespace=~"${namespace:regex}"}`                          | 展示各目标的 1 / 0 抓取状态，图例包含 namespace、job 和 instance。 |

Prometheus 自动生成 `up`，成功抓取为 1，失败为 0。它表示目标抓取状态，不能直接证明 Pod 就绪、应用功能正常或自愈任务成功。模板不包含虚构的 `healing_*` 指标。[Prometheus jobs and instances](https://prometheus.io/docs/concepts/jobs_instances/)

查询要求 `up` 系列携带真实的 `namespace` 标签。Kubernetes 服务发现中的 `__meta_kubernetes_namespace` 是发现元数据，通常需要在目标的 `relabel_configs` 中映射为保留的 `namespace` 标签。仅在指标正文中存在 namespace 标签、或在 `metric_relabel_configs` 中添加它，不足以保证自动生成的 `up` 系列拥有该标签；Prometheus 明确说明指标 relabeling 不作用于 `up`。[Prometheus configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)

不同抓取任务中的 namespace 标签可能代表 exporter 所在命名空间，也可能代表被监控工作负载的命名空间。应先在 Grafana Explore 中检查 `up` 的实际标签含义。没有匹配标签或没有序列时，模板保留“无数据”，不会用 `or vector(0)` 把缺失数据变成健康或零故障。

模板的 namespace 变量是自定义多值变量，值来自显式配置；关闭 Include All 和自定义输入，不会自动查询或发现全集群命名空间。查询使用 `=~` 与 `${variable:regex}`，让 Grafana 对多值执行正则格式化和转义。每个面板和查询目标均以 `{ "type": "prometheus", "uid": "${datasource}" }` 引用配置的数据源变量；修改变量名时会同步修改引用。[Prometheus template variables](https://grafana.com/docs/grafana/latest/datasources/prometheus/template-variables/) · [Variable syntax: regex](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/variable-syntax/)

导入前检查导出的 UID。模板有意保留配置的 `dashboardUid`，以匹配生成链接；如果目标 Grafana 已经有相同 UID 的仪表盘，应先确认目标并选择所需的导入行为，避免误覆盖。模板采用 Classic JSON 的 `schemaVersion: 39` 和常规 stat/timeseries 面板，未在真实 Grafana 实例中进行导入或版本兼容性验证。[Grafana JSON model](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/view-dashboard-json-model/)

## 外部打开与嵌入

当前集成在用户操作后打开 Grafana 外部页面，使用 `noopener noreferrer`，不在后台加载 iframe，也不传递浏览器 API token。Grafana 登录沿用用户在目标站点的正常登录流程。

Grafana 官方文档说明，iframe 面板访问需要有效登录，除非实例允许匿名访问；Grafana Cloud 不支持该文档描述的面板嵌入和匿名访问能力。自托管环境还受实例配置、Cookie 与浏览器框架策略约束。因此本次提供外部打开，不宣称能够直接内嵌任何 Grafana 实例。[Share dashboards and panels](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/)

## 网关快照与模块接口

`GET /api/healing/snapshot` 增加可选配置的安全投影 `monitoring`。不填写 `monitoring` 时，旧配置文件仍然可用。网关每次读取快照时重新读取所选配置文件，配置来源继续由已有 `configSource` 表示。

| `status`       | `configured` | 含义                                                                                      |
| -------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `unconfigured` | `false`      | 未提供监控块；`grafana` 与 `datasource` 为 `null`，命名空间与错误列表为空。               |
| `invalid`      | `false`      | 监控块或已知字段不合法，`errors` 提供字段与说明，链接和导出被禁用。无效值不回显到浏览器。 |
| `ready`        | `true`       | 必填字段和本地格式检查通过，可以构造链接和导出草稿；尚未验证任何远端连接。                |

以上状态的 `connectivity` 一律为 `unverified`。无效的可选监控块会报告 `invalid`，不会影响快照中的项目、任务、规则或安全配置。其他已有必填配置错误仍遵循原 API 的错误处理。

网关与浏览器共享 `apps/console/public/monitoring-model.js`，所有对象通过明确的字段白名单构造。`token`、`headers`、认证信息、Prometheus 服务端 URL 和未知字段不会被投影。监控字段都属于公开显示配置，不应把秘密放进显示名称或地址路径。API token 应保留在 Grafana 或受控服务端的配置中。

| 导出                                                | 返回值                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `normalizeMonitoringConfig(raw)`                    | 规范化的安全配置、状态和字段错误；无网络请求。                                                                     |
| `buildGrafanaUrl(config, { namespaces, from, to })` | 验证后的 URL；配置、选定范围或时间预设无效时返回 `null`。省略 namespaces 表示全部显式关注项。                      |
| `exportMonitoringConfig(config)`                    | `{ monitoring: { grafana, datasource, namespaces } }`；只有实际可保存字段，无派生状态或凭证。无效配置返回 `null`。 |
| `buildGrafanaDashboard(config)`                     | Grafana Classic 仪表盘 JSON 对象；无效配置返回 `null`。                                                            |
| `MONITORING_TIME_RANGES`                            | `{ id, label, from, to }` 预设列表。                                                                               |
| `DEMO_MONITORING_CONFIG`                            | 使用 `.invalid` 主机的只读占位示例；不含真实测量值。                                                               |

URL、配置导出和模板导出都会重新验证输入，包括从浏览器本地存储恢复的数据。对配置字段的修改不能改变网关的写入能力。

## 本地验证

```bash
node --test tests/console-monitoring.test.mjs tests/console-server.test.mjs
```

测试覆盖缺失与非法配置、凭证白名单、未验证状态、UID 与显示名称分离、单/多命名空间和子集约束、危险 URL、变量名冲突、支持的时间范围、模板中的数据源引用、命名空间正则与真实 Prometheus 表达式，以及只读网关的回归行为。这些测试证明本地配置和链接契约，不证明远端 Grafana、Prometheus 或 Kubernetes 的可用性。
