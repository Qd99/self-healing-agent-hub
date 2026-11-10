# Self-Healing Agent Hub

用于管理自愈 Agent 的 Web 工作台与持久化控制服务。当前版本已把现有 UI 接入真实 HTTP API：任务、审批、路由规则、监控配置和操作记录由服务端读取、校验与保存。

## 已实现

| 模块         | 当前行为                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| 工作台报表   | 从真实任务快照计算数量、成功率、耗时、趋势与状态分布                     |
| 全部任务     | 创建、筛选、分页、跨页选择、取消、重试、批量操作、摘要导出               |
| 审批中心     | 候选证据、两级顺序审批、拒绝、重新提交、版本冲突检查与持久历史           |
| 路由规则     | 按配置顺序匹配任务类型和重试次数，开关通过 API 持久保存                  |
| 操作记录     | 保存服务端操作者、时间、对象与操作，支持筛选、详情和导出                 |
| 监控配置     | 服务端保存 Grafana、Prometheus UID/name、命名空间和变量映射              |
| Grafana 检查 | 访问允许的 Grafana 服务，检查健康和数据源身份；独立展示结果              |
| Agent 接口   | 领取诊断/执行任务、租约心跳、候选回传、限定范围的结果回传和取消确认      |
| Jenkins 来源 | 从配置的普通分支 job 读取失败构建，绑定准确提交并按来源事件去重          |
| 修复 Worker  | 隔离 Git 工作区、模型生成候选、Docker 检查、审批后创建同仓库 Draft PR    |
| 独立 CI 核验 | 只读核对 PR、提交父节点、候选 tree、文件和指定 Commit Status；保留原回执 |
| 结果与核对   | 展示实际产物与失败原因；保存部分/迟到回执，核对结论和回执幂等持久化      |
| 访问控制     | 本机模式，或管理令牌换取 HttpOnly 会话；Agent 使用独立令牌               |

任务创建后进入持久队列。**没有 Agent 领取或回传时，页面会显示等待状态。** 服务不会为了让报表有数值而生成演示成功记录。

## 启动工作台

需要 Node.js 20.3 或更新版本。生产环境使用仍受支持的 Node.js LTS。

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

代码修改的候选方案必须满足文件上限、保护路径和必需检查。`create-issue` / `retry` 采用无代码变更的操作方案，同样经过两级审批。Hub 负责来源读取、管理和独立验证；代码、模型和检查进程运行在独立 Worker 中。

执行中断或外部结果未知时，任务进入「待核对」。管理者在详情核实实际仓库/CI 状态并保存结论后，才能重试；迟到回执不会把已取消或失联任务改为成功。Worker 回执只返回当前任务的协议确认，不包含管理快照。详情持续更新执行状态，保留正在编辑的核对说明。

完整请求体、取消语义和两阶段适配要求见 [Agent 接入协议](docs/agent-worker-api.md)。原 `WorkflowEngine` 抽象接口与 v1 Worker 协议仍保留。

### 启动第二阶段 Worker

仓库提供 `apps/healing-worker`：支持一个配置仓库、一个 Jenkins 普通分支 Git-plugin job，以及 `ci-failure → create-pr`。先按 [Worker 运行指南](docs/healing-worker-guide.md) 配置来源、可信检查镜像、模型与凭据，再运行：

```bash
cp configs/healing-worker.example.json configs/healing-worker.json
# 编辑配置，并由部署环境注入配置中引用的凭据。
npm run worker -- --config configs/healing-worker.json --check-config
npm run worker -- --config configs/healing-worker.json --once
```

示例 `publish.enabled` 默认为 `false`：Worker 只领取诊断阶段。启用后仍须通过两级审批，执行保存的同一 patch/tree，并确认基线未变化。候选、发布意图与待确认回执持久化；重启恢复期间先核对既有事实，避免重复创建 PR。

检查仅使用预先拉取、固定 digest 的 Docker 镜像。镜像需备齐依赖，检查必须保持工作区不变；缺少 Docker 时停止。`--check-config` 仅检查配置与引用凭据是否存在，远端连通性、镜像及业务闭环需另行验收。

## Grafana

在「监控面板 → 接入配置」保存 Grafana 地址、仪表盘 UID、Prometheus 数据源 UID/name 和命名空间。保存成功表示配置已写入管理服务；“检查连接”进一步验证 Grafana 健康和 Prometheus 数据源身份。

检查不会查询指标或验证 Kubernetes 监听范围。Agent 领取上下文包含已保存的监控配置，实际集群监听由 Agent 实现。仪表盘仍通过外部 Grafana 页面打开，支持导出模板。详见 [监控接入文档](docs/monitoring-integration.md)。

## 验证与构建

```bash
npm test
npm run lint
npm run build
```

`npm run lint` 使用 ESLint 9 检查实际 JS/MJS 运行源码、脚本与测试；`npm run build` 检查框架 TypeScript 类型并生成 `dist/` 静态资源。`npm start` 从源码目录提供同源工作台及 API。仅把 `dist/` 上传至静态托管不会启动管理服务。

[原私人 Site](https://heal-agent-console-qd99.hearty-trail-0210.chatgpt.site) 是静态 UI 发布渠道，不能运行此 Node 服务；实际接口版本请从管理服务地址进入。开发者如需虚构样本，可显式使用 `?demo=1` 或 `npm run build:demo`，演示数据不会进入真实状态文件。

## 当前边界

已实现持久管理 API、审批、拉取协议以及上述受限的 Jenkins 修复 Worker。GitHub webhook、定时巡检、多仓库调度、Jenkins 多分支合并构建、Check Runs 验证、自动回滚与自动熔断仍待实现。当前不会调用 Jenkins/Actions 的 build、dispatch 或 retry API；未来开启修复 PR 发布后，仓库既有 CI 可能按自身规则运行。

本地端到端测试使用真实临时 Git 仓库、Hub HTTP、模型 HTTP 夹具和 Node 检查进程；外部 Jenkins/GitHub 响应由夹具提供。生产验收仍需实际服务凭据、固定 Docker 镜像和真实失败构建。

JSON 存储面向单服务实例，带独占写锁和原子提交。容量上限为 10,000 条任务、50,000 条审计、50,000 条幂等请求、1,000 个 Worker、32 MiB 状态文件；达到上限会明确拒绝写入，不会静默删除记录。只读降级期间仍能查看最后成功保存的数据和导出摘要，页面说明只读原因及未保存的状态变化。规则和监控配置独立版本化，Worker 心跳不会使新版 UI 的配置草稿过期。备份、容量恢复及旧数据兼容见 [存储恢复文档](docs/console-storage-recovery.md)。

## 文档与代码

- [工作台指南](docs/console-guide.md)
- [真实管理 API 与部署](docs/console-api.md)
- [Agent 接入协议](docs/agent-worker-api.md)
- [Worker 运行与故障处理](docs/healing-worker-guide.md)
- [第二阶段联调与边界](docs/design/console-v13-worker.md)
- [Grafana 接入](docs/monitoring-integration.md)
- [配置版本与存储恢复](docs/console-storage-recovery.md)
- [第一阶段修复与验收](docs/design/console-v12-reliability.md)
- [v11 接口接入与验收](docs/design/console-v11-integration.md)
- [v10 连接与操作记录设计](docs/design/console-v10.md)
- [v9 表面与侧栏精修](docs/design/console-v9.md)
- [原架构规划](docs/architecture/system-design.md)

前端位于 `apps/console/public`，HTTP、认证、持久服务位于 `apps/healing-hub/src`，框架与展示类型位于 `packages/framework/src`。

## License

MIT
