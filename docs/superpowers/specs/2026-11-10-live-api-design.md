# 工作台真实 API 接入

## 目标与现状

用户要求将已完成的工作台接入项目实际接口。基线为 `486ed92`，现有 180 项测试通过。当前只有 `GET /api/healing/snapshot`，任务及操作记录为空，写操作返回 501；仓库没有具体执行器实现。

本轮沿用 Node.js 18+、原生 HTTP、原有静态 UI 和现有任务契约。提供可运行、可持久化的管理服务和 Agent 接入协议。前端从服务端确认结果后更新状态，生产模式不回退到演示数据。

## 设计决定

- 保留当前 UI 视觉和组件；启用已存在的任务、批量操作、审批、规则和监控配置入口。
- 服务与 UI 同源运行。浏览器使用可选管理令牌换取 HttpOnly 会话；写请求校验来源与 CSRF。无令牌仅允许本机访问，非回环监听必须配置管理令牌。Agent 使用独立 Bearer 令牌。
- 持久状态保存到 `.healing/console-state.json`，事务串行执行、原子替换、单进程写锁。坏状态文件必须报错，不能默默重置。配置和规则原文件仍经白名单投影；规则开关和监控配置作为持久覆盖，由路由和快照实际读取。
- 使用全局 `revision` 和任务 `revision` 检测过期修改；审批还必须提供轮次及当前节点。审计操作者由认证上下文决定，不接受表单伪造。
- 任务创建进入持久队列。Agent 领取诊断任务，回传候选 diff、质量证据；服务端验证保护路径、文件数和必需检查。两级人工审批通过后，Agent 才能领取执行阶段。成功只来自经过校验的 Agent 执行结果。
- 运行中取消记录取消请求，由 Agent 确认；超时或失联记失败并保留证据，不自动重复执行。重试建立新任务、保留原记录。
- Grafana 配置真实保存；连接检查仅访问部署者允许的 Grafana origin，凭据留在服务端。检查健康与 Prometheus UID/name，不将字段合法或保存成功等同于监控在线。
- 检查响应绑定开始检查时的安全配置和版本；页面丢弃与当前配置不匹配的迟到结果。保存响应也必须遵守快照版本顺序并保留提交后的新编辑。
- `create-issue` 与 `retry` 使用无代码动作方案：空 diff、真实诊断证据，允许检查失败但不能伪装质量通过；仍经过两级授权。成功结果必须与规则动作对应，跳过不得携带外部变更。
- 现有静态 Site 仍是 UI 载体，无法运行 Node。交付完整同源启动方式和反向代理示例，不声称已连接用户未提供的生产 Agent、Grafana 或集群。

## 模块与接口

`console-config.mjs`：`loadConsoleConfiguration(rootDir)` 返回现有安全配置字段、`rules`、`rulesVersion`、`configSource`、`rulesSource`。

`console-service.mjs`：`createHealingService({ rootDir, dataDir, clock })` 返回异步 `snapshot()`、`trigger(body, actor)`、`taskAction(id, action, body, actor)`、`bulk(body, actor)`、`decide(id, body, actor)`、`toggleRule(id, body, actor)`、`saveMonitoring(body, actor)`、`claim(body, actor)`、`heartbeat(id, body, actor)`、`proposal(id, body, actor)`、`complete(id, body, actor)`、`acknowledgeCancellation(id, body, actor)`、`close()`。错误带 `status`、`code` 和固定/安全 `message`。

管理写入响应统一为 `{ snapshot, message, taskId?, report? }`，快照保留 `apiVersion: 1`，新增 `revision`、任务 `revision`、`capabilities.updateMonitoring`。HTTP 层补充会话 `csrfToken`。服务端不依赖演示写状态机。

| HTTP 接口                                      | 请求摘要                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| GET `/api/healing/snapshot`                    | 最新持久快照                                                              |
| POST `/api/healing/session`                    | 管理 Bearer 换取会话                                                      |
| DELETE `/api/healing/session`                  | 注销当前会话                                                              |
| POST `/api/healing/trigger`                    | `title,type,priority,description,branch?`                                 |
| POST `/api/healing/tasks/:id/cancel`、`retry`  | `expectedRevision`                                                        |
| POST `/api/healing/tasks/bulk`                 | `type`, `items:[{id,revision}]`，最多 100 项                              |
| POST `/api/healing/approvals/:id/decision`     | `decision: approve/reject/resubmit,nodeId,round,comment,expectedRevision` |
| PATCH `/api/healing/rules/:id`                 | `enabled,expectedRevision`（快照版本）                                    |
| PUT `/api/healing/monitoring`                  | `monitoring,expectedRevision`（快照版本）                                 |
| POST `/api/healing/monitoring/check`           | 检查服务端已保存配置                                                      |
| POST `/api/healing/worker/claim`               | `engineId,workerId`                                                       |
| POST `/api/healing/worker/tasks/:id/heartbeat` | `leaseId`                                                                 |
| POST `/api/healing/worker/tasks/:id/proposal`  | `leaseId,summary,diff,trace?,evidence`                                    |
| POST `/api/healing/worker/tasks/:id/complete`  | `leaseId,result`                                                          |
| POST `/api/healing/worker/tasks/:id/cancelled` | `leaseId`                                                                 |

领取响应 `{ task, lease, context }`；无任务时 `task:null`。租约含 `id,phase:diagnose/execute,expiresAt`；上下文含安全策略、匹配路由和监控配置。租约秘密不进入浏览器快照。提案 `evidence` 包含 `testsRun,checksPass,checksFail,beforeState?,afterState?`；缺失必需证据不能通过审批。前端展示提案证据与最终结果时区分二者。

## 验收

真实 HTTP 链路覆盖认证、CSRF、任务创建、持久重启、并发冲突、规则路由、批量部分成功、两级审批、Worker 租约/执行/取消和审计；非法请求不可写入状态。浏览器检查提交加载、结果反馈、刷新后数据、审批节点、批量结果、监控保存与失败回显。完整原有测试、类型检查、构建及独立代码审查后同步原 Draft PR。
