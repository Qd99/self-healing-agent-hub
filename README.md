# Self-Healing Agent Hub

用于管理自愈 Agent 的 Web 工作台与持久化控制服务。当前版本已把现有 UI 接入真实 HTTP API：任务、审批、路由规则、监控配置和操作记录由服务端读取、校验与保存。

## 已实现

| 模块         | 当前行为                                                       |
| ------------ | -------------------------------------------------------------- |
| 工作台报表   | 从真实任务快照计算数量、成功率、耗时、趋势与状态分布           |
| 全部任务     | 创建、筛选、分页、跨页选择、取消、重试、批量操作、摘要导出     |
| 审批中心     | 候选证据、两级顺序审批、拒绝、重新提交、版本冲突检查与持久历史 |
| 路由规则     | 按配置顺序匹配任务类型和重试次数，开关通过 API 持久保存        |
| 操作记录     | 保存服务端操作者、时间、对象与操作，支持筛选、详情和导出       |
| 监控配置     | 服务端保存 Grafana、Prometheus UID/name、命名空间和变量映射    |
| Grafana 检查 | 访问允许的 Grafana 服务，检查健康和数据源身份；独立展示结果    |
| Agent 接口   | 领取诊断/执行任务、租约心跳、候选回传、结果回传和取消确认      |
| 访问控制     | 本机模式，或管理令牌换取 HttpOnly 会话；Agent 使用独立令牌     |

任务创建后进入持久队列。**没有 Agent 领取或回传时，页面会显示等待状态。** 服务不会为了让报表有数值而生成演示成功记录。

## 启动工作台

需要 Node.js 18 或更新版本。生产环境建议使用仍受支持的 Node.js LTS。

```bash
npm install
cp configs/healing-config.example.json configs/healing-config.json
cp configs/healing-rules.example.json configs/healing-rules.json
```

编辑 `configs/healing-config.json` 的 `project.id`、`project.repo` 和 `project.defaultBranch`，然后运行：

```bash
npm start
```

打开 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。UI 和 API 由同一个服务提供，不需要单独启动前端。默认监听回环地址，本机操作仍进行 CSRF 校验。若未复制配置，服务会明确标示正在读取示例配置。

数据默认写入 `.healing/console-state.json`，刷新页面和正常重启不会丢失。运行管理服务使用 Node 内置模块，不要求 Redis、MySQL、模型或 GitHub App 凭据。

### 远程部署与 Agent 凭据

通过部署环境或受保护的环境文件注入下列变量。`CONSOLE_API_TOKEN` 与 `HEALING_WORKER_TOKEN` 必须分别生成，不能使用同一值。

| 环境变量                        | 用途 / 默认值                                         |
| ------------------------------- | ----------------------------------------------------- |
| `HOST`                          | 监听地址，默认 `127.0.0.1`；跨机器部署显式设置        |
| `PORT`                          | 端口，默认 `8787`                                     |
| `HEALING_DATA_DIR`              | 持久数据目录，默认仓库 `.healing`；必须在静态目录之外 |
| `CONSOLE_API_TOKEN`             | 管理令牌；非回环监听时必需                            |
| `CONSOLE_OPERATOR_NAME`         | 该管理身份的审计名称，默认“管理员”                    |
| `CONSOLE_SECURE_COOKIE`         | HTTPS 反向代理部署设为 `true`                         |
| `HEALING_WORKER_TOKEN`          | 独立 Agent Bearer 令牌                                |
| `GRAFANA_ALLOWED_ORIGINS`       | 可检查的 Grafana origin，逗号分隔，无路径、通配符     |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | Grafana 服务账户令牌，仅服务端使用                    |

当前不自动加载 `.env`，也不展开配置文件中的 `{{...}}`。由进程管理器注入环境变量，或在启动 shell 中显式加载。远程部署应通过 HTTPS 反向代理提供同源 UI/API；见 [部署与接口文档](docs/console-api.md)。

在工作台登录表单输入管理令牌后，服务建立 8 小时 HttpOnly 会话。令牌不会写入浏览器本地存储。该版本是单管理身份控制台，不包含多用户 RBAC。

## 连接实际 Agent

Agent 使用独立凭据连接以下接口：

1. `POST /api/healing/worker/claim` 领取诊断任务。
2. 周期发送 `heartbeat`，保持续租并检查取消请求。
3. 发送 `proposal`，提交候选方案和实际检查证据。
4. 管理者在 UI 完成代码/方案审阅和执行授权。
5. Agent 再次领取到 `execute` 租约，执行已授权方案并发送 `complete`。

代码修改的候选方案必须满足文件上限、保护路径和必需检查。`create-issue` / `retry` 采用无代码变更的操作方案，同样经过两级审批。服务端只记录经过协议校验的 Agent 回传结果，不会自行调用 AI、GitHub 或 shell。

完整请求体、取消语义和两阶段适配要求见 [Agent 接入协议](docs/agent-worker-api.md)。原 `WorkflowEngine` 抽象接口仍保留；仓库尚无可直接启动的具体 AI 执行器。接入你已有的 Agent 时，需要由适配器实现该协议的诊断和执行阶段。

## Grafana

在「监控面板 → 接入配置」保存 Grafana 地址、仪表盘 UID、Prometheus 数据源 UID/name 和命名空间。保存成功表示配置已写入管理服务；“检查连接”进一步验证 Grafana 健康和 Prometheus 数据源身份。

检查不会查询指标或验证 Kubernetes 监听范围。Agent 领取上下文包含已保存的监控配置，实际集群监听由 Agent 实现。仪表盘仍通过外部 Grafana 页面打开，支持导出模板。详见 [监控接入文档](docs/monitoring-integration.md)。

## 验证与构建

```bash
npm test
npm run build
```

`npm run build` 进行类型检查并生成 `dist/` 静态资源。`npm start` 从源码目录提供同源工作台及 API。仅把 `dist/` 上传至静态托管不会启动管理服务。

[原私人 Site](https://heal-agent-console-qd99.hearty-trail-0210.chatgpt.site) 是静态 UI 发布渠道，不能运行此 Node 服务；实际接口版本请从管理服务地址进入。开发者如需虚构样本，可显式使用 `?demo=1` 或 `npm run build:demo`，演示数据不会进入真实状态文件。

## 当前边界

已实现持久管理 API、队列/租约、规则路由、审批和 Agent 协议。具体 AI 引擎、GitHub webhook、定时巡检、仓库写入、CI 执行、自动回滚与自动熔断仍由后续执行器/集成负责。配置文件中存在这些字段不代表对应运行组件已经实现。

JSON 存储面向单服务实例，带独占写锁和原子提交。容量上限为 10,000 条任务、50,000 条审计、50,000 条幂等请求、1,000 个 Worker、32 MiB 状态文件；达到上限会明确拒绝写入，不会静默删除记录。备份及异常退出锁处理见 API 文档。

## 文档与代码

- [工作台指南](docs/console-guide.md)
- [真实管理 API 与部署](docs/console-api.md)
- [Agent 接入协议](docs/agent-worker-api.md)
- [Grafana 接入](docs/monitoring-integration.md)
- [v11 接口接入与验收](docs/design/console-v11-integration.md)
- [v10 连接与操作记录设计](docs/design/console-v10.md)
- [v9 表面与侧栏精修](docs/design/console-v9.md)
- [原架构规划](docs/architecture/system-design.md)

前端位于 `apps/console/public`，HTTP、认证、持久服务位于 `apps/healing-hub/src`，框架与展示类型位于 `packages/framework/src`。

## License

MIT
