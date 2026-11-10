# Grafana 与 Prometheus 监控对接

v11 管理台支持服务端保存监控配置，并通过独立检查请求验证允许来源的 Grafana 健康及 Prometheus 数据源身份。命名空间范围选择、Grafana 外部链接和仪表盘模板导出继续保留。当前不查询指标、不调用 Kubernetes，也不验证命名空间或 Agent 的实际监听状态。

`ready` 表示配置结构完整、可生成链接；快照配置的 `connectivity` 仍为 `unverified`。独立的连接检查结果记录特定时间、特定已保存配置的检查情况，不能把保存成功、配置有效或曾经检查通过理解为持续在线。实际图表与指标仍在目标 Grafana 中验证。

真实模式以服务端配置为准，表单通过同源认证 API 保存，历史浏览器 live 草稿不再覆盖它。只有显式演示模式将配置保存为本机／会话草稿；演示草稿和 `.invalid` 占位地址不进入真实配置，也不执行连接检查。任务、审批、规则和审计的真实能力见 [管理 API](console-api.md)。

## 配置位置与字段

推荐在「监控面板 → 接入配置」填写字段并点击「保存配置」。服务将规范化后的公开配置保存到持久状态，后续快照和 Worker 领取上下文使用该配置；不改写原项目配置中的凭据。

也可将下面的 `monitoring` 块合并到 `configs/healing-config.json` 作为基础配置，保留原有项目、引擎、安全和触发字段。已有服务端保存覆盖时，以覆盖为准，可通过页面再次保存更新；`monitoringSource` 标明来源。示例中的主机、UID、名称和命名空间必须替换，不要用片段覆盖整个配置文件。

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
| `datasource.name`            | 可省略或留空，不能替代 UID。填写后，连接检查会核对 Grafana 返回的名称是否完全一致。                                                                                                     |
| `datasource.type`            | 可省略，默认为 `prometheus`；当前只支持 Prometheus。                                                                                                                                    |
| `namespaces`                 | 1–100 个显式 Kubernetes 命名空间名称。每个名称为 1–63 位小写字母、数字或连字符，首尾必须是字母或数字。重复项保留第一次出现的顺序并去重。                                                |

两个变量名仅允许字母、数字、下划线，首字符必须是字母或下划线；不允许使用 Grafana 保留的 `__` 前缀。基础地址中的简单子路径允许字母、数字、`-`、`_`、`.`、`~`；不接受路径穿越和百分号编码路径。

Grafana 官方配置将数据源 `name` 和 `uid` 分开：名称是显示引用，UID 用于其他配置中的稳定引用。数据源变量应使用 **Data source** 类型，并限定 **Prometheus**，其当前值绑定实际 UID。本功能不创建数据源或修改 Grafana provisioning。只有显式连接检查会读取 Grafana 数据源 API，按已保存 UID 定位并校验类型；填写了显示名称时还会核对名称。[Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/) · [Data source variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/add-template-variables/) · [UID 字符限制](https://grafana.com/docs/grafana/latest/upgrade-guide/upgrade-v11/upgrade-v11.2/)

## 保存与检查连接

### 1. 在部署环境配置允许来源和凭据

| 服务端环境变量                  | 作用                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GRAFANA_ALLOWED_ORIGINS`       | 允许检查的精确 origin，逗号分隔，例如 `https://grafana.example.com`；不带路径、通配符、查询参数或凭据 |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | 可选 Grafana 服务账户令牌，仅由管理服务发送到允许的目标；需要认证的实例应提供检查端点所需的读取权限   |

例如基础地址是 `https://grafana.example.com/observability`，允许来源应为 `https://grafana.example.com`，基础路径仍保留在实际请求中。空允许列表会拒绝远端检查，不自动放行用户在表单中填写的地址。部署者需确保该来源是允许访问的 Grafana 服务，并由运行环境提供网络及 TLS 访问。

凭据通过部署环境注入，不填写在浏览器表单、配置显示名称、URL 或请求体中，也不写入仓库。当前启动入口不自动加载 `.env`。管理身份和 Worker 身份另用 `CONSOLE_API_TOKEN` 与 `HEALING_WORKER_TOKEN`；不要复用这些令牌。完整环境变量和 HTTPS 同源部署方法见 [管理 API](console-api.md#启动与部署)。

### 2. 保存公开配置

真实模式的浏览器写入使用管理会话、同源检查及 CSRF。表单提交的请求是：

```http
PUT /api/healing/monitoring
Content-Type: application/json
X-Heal-CSRF: <当前会话的 csrfToken>
```

```js
{
  monitoring: { grafana, datasource, namespaces },
  expectedRevision: snapshot.revision
}
```

服务校验字段和全局版本，成功后返回 `{ snapshot, message }`，同时保存公开配置及操作记录。版本过期返回 409；保存失败保留原服务端值，界面保留正在编辑的草稿。字段正常化会去掉未知项和凭据，保存成功不表示远端已经连接。

「恢复来源配置」仅丢弃当前未保存的表单编辑，恢复最新服务端值，不删除持久覆盖。配置导出只是下载公开片段；真正的保存依据服务器成功响应。演示模式的「保存到本机」不会调用该接口，不能替代真实保存。

### 3. 检查实际已保存的目标

保存完成后点击「检查连接」；有未保存修改时先保存。浏览器发送：

```http
POST /api/healing/monitoring/check
Content-Type: application/json
X-Heal-CSRF: <当前会话的 csrfToken>
```

请求体为 `{}`。服务自行读取已保存配置，不接受请求体提供的替代 URL 或凭据，依次读取：

1. `<grafana.baseUrl>/api/health`，核对 Grafana 健康响应。
2. `<grafana.baseUrl>/api/datasources/uid/<datasource.uid>`，核对返回 UID、`prometheus` 类型和数据源名称。配置了非空名称时必须完全匹配；未填写名称时返回实际名称供查看。

检查保留基础子路径，可按配置发送组织 ID。上游重定向被拒绝；两次请求和响应读取共用超时限制，并限制响应大小。原始上游响应、令牌和底层异常不直接回显给浏览器。

响应为 `{ check, monitoring, revision }`：

| 字段               | 含义                                                          |
| ------------------ | ------------------------------------------------------------- |
| `check.status`     | `connected`、`error` 或 `unconfigured`，描述本次检查结果      |
| `check.checkedAt`  | 本次检查时间                                                  |
| `check.message`    | 可公开显示的结果或失败原因                                    |
| `check.checks`     | 分别记录 Grafana 和数据源阶段的 `ok`／`error`／`unknown` 状态 |
| `check.datasource` | 成功时返回经过安全投影的 UID、名称和类型                      |
| `monitoring`       | 本次实际检查的完整规范化公开配置，作为结果的目标身份          |
| `revision`         | 读取该配置时的全局快照版本；不是远端健康版本                  |

页面把结果绑定到响应中的具体配置。检查期间若有人保存了另一套地址、UID、命名空间或其他配置，旧结果不能表示新配置已经连接，应对当前配置重新检查。普通刷新若仍是同一份规范化配置，不会把结果重新解释为其他目标的验证。由于全局版本也会随任务等操作变化，判断目标一致性不能仅凭全局版本数字，必须对应完整的规范化配置。

连接结果不持久化为“始终在线”，也不会修改原配置。成功只证明本次 Grafana 健康及其 Prometheus 数据源身份检查通过；不证明 Prometheus 查询可用、任何指标有数据、命名空间存在、集群健康、Agent 已监听，或用户可以打开特定仪表盘。服务端检查凭据和用户在 Grafana 的登录会话是两套访问上下文。

### 常见结果与下一步

| 结果                   | 需要核对的内容                                                         |
| ---------------------- | ---------------------------------------------------------------------- |
| 未配置／配置无效       | 先保存完整合法的基础地址、仪表盘 UID、数据源 UID 和命名空间            |
| 来源未允许             | 由部署者核对 `GRAFANA_ALLOWED_ORIGINS`，页面不能自行扩大允许列表       |
| 认证失败               | 核对服务端 Grafana 令牌及读取权限，不要把令牌粘贴到公开配置            |
| UID／类型／名称不匹配  | 核对 Grafana 中实际数据源的 UID、类型及名称；不要用名称替代 UID        |
| 重定向／超时／TLS 错误 | 配置最终基础地址，并核对管理服务到目标 Grafana 的网络与 TLS            |
| 检查通过但面板无数据   | 在 Grafana 验证仪表盘变量、Prometheus 查询和真实标签；本检查未读取指标 |

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

本版本不提供 iframe 嵌入。嵌入能力还取决于目标 Grafana 的认证、实例配置、Cookie 和浏览器框架策略；需要嵌入时另行核对目标环境的官方说明。[Share dashboards and panels](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/)

## 网关快照与模块接口

`GET /api/healing/snapshot` 返回可选配置的安全投影 `monitoring`，并通过 `monitoringSource: "configuration" | "saved"` 区分基础配置与持久覆盖。没有任何监控配置时，旧项目文件仍然可用。服务每次读取基础配置，再叠加已保存覆盖；`configSource` 继续表示所选项目文件来自 `configured` 还是 `example`。

| `status`       | `configured` | 含义                                                                                      |
| -------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `unconfigured` | `false`      | 未提供监控块；`grafana` 与 `datasource` 为 `null`，命名空间与错误列表为空。               |
| `invalid`      | `false`      | 监控块或已知字段不合法，`errors` 提供字段与说明，链接和导出被禁用。无效值不回显到浏览器。 |
| `ready`        | `true`       | 必填字段和格式校验通过，可以构造链接和导出配置；该状态本身不包含远端验证结论。            |

以上配置状态的 `connectivity` 一律为 `unverified`，独立检查不会将它改写为永久在线。无效的可选基础监控块报告 `invalid`，不会影响其他合法项目、任务、规则或安全配置；通过保存 API 提交的无效监控配置会被拒绝，不覆盖原值。其他必填配置错误遵循 [API 错误契约](console-api.md#认证请求与错误)。

网关与浏览器共享 `apps/console/public/monitoring-model.js`，所有对象通过明确的字段白名单构造。`token`、`headers`、认证信息、Prometheus 服务端 URL 和未知字段不会被投影。监控字段都属于公开显示配置，不应把秘密放进显示名称或地址路径。API token 应保留在 Grafana 或受控服务端的配置中。

| 导出                                                | 返回值                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `normalizeMonitoringConfig(raw)`                    | 规范化的安全配置、状态和字段错误；无网络请求。                                                                     |
| `buildGrafanaUrl(config, { namespaces, from, to })` | 验证后的 URL；配置、选定范围或时间预设无效时返回 `null`。省略 namespaces 表示全部显式关注项。                      |
| `exportMonitoringConfig(config)`                    | `{ monitoring: { grafana, datasource, namespaces } }`；只有实际可保存字段，无派生状态或凭证。无效配置返回 `null`。 |
| `buildGrafanaDashboard(config)`                     | Grafana Classic 仪表盘 JSON 对象；无效配置返回 `null`。                                                            |
| `MONITORING_TIME_RANGES`                            | `{ id, label, from, to }` 预设列表。                                                                               |
| `DEMO_MONITORING_CONFIG`                            | 使用 `.invalid` 主机的只读占位示例；不含真实测量值。                                                               |

这些共享模型函数仍是纯本地校验／导出函数，不自行保存或发起远端请求。URL、配置和模板导出都会重新校验输入，包括显式演示模式恢复的本机草稿。真实保存由 `PUT /api/healing/monitoring` 完成，远端检查由 `POST /api/healing/monitoring/check` 完成；表单不能通过伪造状态字段开启权限或改变允许来源。

## 本地验证与交付边界

```bash
node --test tests/console-monitoring.test.mjs tests/console-monitoring-controller.test.mjs tests/grafana-connection.test.mjs tests/console-live-api.test.mjs
```

这些测试覆盖配置校验与秘密过滤、服务端保存和冲突、演示草稿隔离、检查目标绑定、精确允许来源、UID／名称匹配、超时、重定向、响应大小，以及链接变量、命名空间范围和模板 PromQL。具体结果以 [v11 验收记录](design/console-v11-integration.md) 为准。

隔离测试和示例响应不表示已经访问用户的生产 Grafana、Prometheus 或 Kubernetes。当前没有实时指标代理、集群发现或预装生产 Agent；实际图表仍需在目标 Grafana 验证。本轮也没有把 Node 服务部署到静态 Site，仅发布静态资源不能提供保存或检查 API。
