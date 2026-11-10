# 真实管理 API 与部署

v11 把工作台接入同源持久管理服务。`apiVersion` 保持 `1`，增加版本号、身份及运行阶段字段；原任务、状态与结果类型保留。生产模式的任务、审批、规则修改、监控配置和审计均由服务端确认，不再调用浏览器演示 reducer。

## 启动与部署

```bash
npm start
```

默认 `http://127.0.0.1:8787/`，同时提供 UI 与 `/api/healing/*`。入口按自身位置查找仓库配置，不依赖启动目录。`HOST`、`PORT`、`HEALING_DATA_DIR` 可覆盖默认值。

非回环监听要求 `CONSOLE_API_TOKEN`。管理令牌与 `HEALING_WORKER_TOKEN` 必须不同。远程部署通过 HTTPS 反向代理保持 UI 与 API 同源，设置 `CONSOLE_SECURE_COOKIE=true`。代理必须保留原始 Host，不能将静态工作台与管理 API 放在不同的 browser origin。

例如 Nginx 的 HTTPS server 块中可使用：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
}
```

TLS 证书与 server_name 由你的部署配置提供。服务不信任客户端传入的身份头，也不依靠 `X-Forwarded-For` 放行本机模式。无令牌仅接受真实回环 socket 和回环 Host。

嵌入 Node 服务：

```js
import { createConsoleServer } from "./apps/healing-hub/src/console-server.mjs";

const server = createConsoleServer({
  rootDir: "/srv/self-healing-agent-hub",
  dataDir: "/var/lib/healing-hub",
  consoleToken: process.env.CONSOLE_API_TOKEN,
  workerToken: process.env.HEALING_WORKER_TOKEN,
  secureCookies: true,
  grafanaAllowedOrigins: ["https://grafana.example.com"],
  grafanaToken: process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN,
});
server.listen(8787, "127.0.0.1");
// 退出前 await server.shutdown()，等待请求完成并释放状态写锁。
```

未指定的 `publicDir` 默认为 rootDir 下 `apps/console/public`。指定自定义静态目录时仍需把持久数据目录放在其外；符号链接的真实路径和未创建目录的已有父路径也会检查。

## 认证、请求与错误

浏览器发送 `POST /api/healing/session`，请求头为 `Authorization: Bearer <管理令牌>`。响应为 `{ snapshot, message }`，并设置 HttpOnly、SameSite=Strict 会话 Cookie。会话默认 8 小时有效，服务重启后需要重新登录。启用 `CONSOLE_SECURE_COOKIE` 时添加 Secure。令牌不返回给客户端、不保存在 localStorage。

所有浏览器写请求携带 `X-Heal-CSRF: <snapshot.csrfToken>` 和同源 Cookie。服务校验 Origin / Fetch Metadata，并校验 CSRF。`DELETE /session` 注销当前会话。管理 API 也接受独立脚本直接使用管理 Bearer；显式 Bearer 不依赖 Cookie，免除 CSRF nonce，但仍检查提供的 Origin。

Worker 路由只接受 `HEALING_WORKER_TOKEN`，管理令牌不能领取任务，Worker 令牌不能调用管理快照或批准方案。

除登录/注销外，写请求要求 `Content-Type: application/json` 和 JSON 对象，最大 1 MiB。超大、畸形、慢请求及错误方法返回结构化错误；未知 API 不回退到 HTML。

```json
{
  "error": {
    "code": "STATE_CONFLICT",
    "message": "任务状态已变化，请刷新后重试。"
  }
}
```

常用 HTTP 状态：`400` 参数非法，`401` 未认证，`403` CSRF/来源/能力拒绝，`404` 对象或接口不存在，`409` 版本/租约/幂等冲突，`413` 请求过大，`415` 非 JSON，`422` 路由/证据/保护路径不满足，`429` 登录尝试过多，`500/503` 配置、存储或服务不可用。异常响应不包含堆栈、原始配置或上游凭据。

## 公共快照

`GET /api/healing/snapshot` 返回：

- `apiVersion: 1`、`mode: "live"`、`generatedAt`、全局 `revision`。
- `project`、`rules`、`rulesVersion`、`safety`、`triggers`、`monitoring`。
- `configSource`、`rulesSource`：分别为 `configured` 或 `example`。
- `rulesOverridden`、`monitoringSource`：持久覆盖来源。
- `capabilities`：`trigger/cancel/retry/approve/updateRules/updateMonitoring`。
- `auth: { required, actor }` 与当前会话 `csrfToken`。
- `tasks`、`activity` 与基于最近 Worker 通信的 `engines`。

`trigger` 表示管理服务可以接收并持久化任务，不保证执行器在线。配置存在而没有活跃 Worker 时，引擎仍显示不可用。一次领取或心跳证明 Worker 最近联系过服务，不代表模型、仓库和集群都健康。

任务包装沿用 `task/status/title/engineId/trace/diff/result`，增加：

```ts
{
  revision: number;
  execution: {
    phase: "diagnose" | "review" | "execute" | "done";
    cancelRequested: boolean;
    workerId?: string;
    leaseExpiresAt?: string;
  };
  proposal?: { id: string; kind: "code-change" | "action"; summary: string; submittedAt: string; contentHash: string };
  evidence?: object; // 提案证据，与最后的 result.evidence 区分
  reviewState?: "pending" | "approved" | "rejected";
  approvalFlow?: object;
}
```

浏览器快照不包含私有 lease ID、Worker 凭据或配置秘密。图表和本地筛选直接消费此快照；服务端时间戳来自实际创建、领取和结果事件。

## 管理写接口

成功响应统一为 `{ snapshot, message, taskId?, report? }`。前端使用响应快照更新界面，不能把点击或请求发出当作保存成功。

| 方法与路径（前缀 `/api/healing`） | 请求体                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| POST `/trigger`                   | `{ title, type, priority, description?, branch?, requestId? }`          |
| POST `/tasks/:id/cancel`          | `{ expectedRevision, requestId? }`                                      |
| POST `/tasks/:id/retry`           | `{ expectedRevision, requestId? }`                                      |
| POST `/tasks/bulk`                | `{ type: "cancel"                                                       | "retry", items: [{ id, revision }], requestId? }` |
| POST `/approvals/:id/decision`    | `{ decision: "approve"                                                  | "reject"                                          | "resubmit", nodeId?, round, comment, expectedRevision }` |
| PATCH `/rules/:id`                | `{ enabled: boolean, expectedRevision }`                                |
| PUT `/monitoring`                 | `{ monitoring: { grafana, datasource, namespaces }, expectedRevision }` |
| POST `/monitoring/check`          | `{}`；返回 `{ check, monitoring, revision }`，无保存副作用              |

### 任务与批量操作

创建接口返回 `201`。`title` 最多 200 字符；`type` 使用框架中的任务类型；`priority` 必须为 `urgent/high/medium/low`。仓库始终取服务端项目配置，不接受表单覆盖。分支经过 Git ref 格式检查，不作为 shell 命令执行。

路由按配置顺序选择首个启用且匹配的规则，包括 `context.retryCount` 数值条件。不匹配返回 `NO_MATCHING_RULE`，不偷偷换到其他引擎。原任务保存当时选定的路由和安全策略，重试重新进行路由选择。

取消等待中的任务直接结束；运行中的任务记录 `cancelRequested`，等待 Worker 确认。界面必须保持“请求取消”的语义，不能宣称远程进程已经停止。只有失败或取消任务可以重试；重试建立新 ID、递增 retryCount 并保存 retryOf，原结果保留。

`expectedRevision` 使用对应任务的 `revision`。批量最多 100 个唯一任务，逐项校验版本/状态，结果为：

```json
{
  "type": "cancel",
  "requested": 2,
  "applied": [{ "id": "task-id", "title": "任务名称" }],
  "skipped": [
    {
      "id": "stale-task-id",
      "title": "状态已变化",
      "reason": "请刷新后重试。",
      "code": "STATE_CONFLICT"
    }
  ]
}
```

重试成功项另带 `newId`。畸形批次直接拒绝；合法但过期/不可执行的项进入 skipped。

创建、任务动作和批量操作支持 `requestId`，最多 128 字符。相同管理身份使用相同 key 与相同命令/参数会得到原 taskId/report 和最新快照；不同参数复用 key 返回 `IDEMPOTENCY_CONFLICT`。UI 在网络结果不明确时保留该 ID，不自动重发写请求。

### 两级审批

只有服务端验证的提案才生成 `source: "server"` 的审批流。`code-review` 通过后才开放 `execution-auth`；第二关通过使执行阶段可领取，尚不代表执行成功。

每次决定校验任务版本、轮次和当前节点。拒绝及重新提交需要 1–500 字符说明；通过时意见可为空。拒绝会阻止执行。重新提交沿用原候选与证据、增加轮次，保留所有历史。

代码方案验证必需检查、文件数、保护路径；无代码操作方案保留实际诊断证据。候选哈希绑定 diff 与证据，执行结果不能带出未授权的文件或动作。具体 Worker 状态约束见 [Agent 协议](agent-worker-api.md)。

### 规则与监控

规则修改是显式设置 enabled，不是无条件翻转。配置写入使用全局 `snapshot.revision`，过期返回 409。规则开关和监控配置保存在状态文档，并被后续快照及任务路由实际读取；不改写原配置文件中的凭据。

服务每次仍读取 `configs/healing-config.json` / `healing-rules.json`；不存在才使用对应 example。真实文件损坏不能回退示例。逐层白名单过滤 API key、GitHub 私钥、Webhook secret 和未知嵌套字段。

监控配置保存后 `connectivity` 仍为 `unverified`。连接检查独立访问部署环境允许的 Grafana origin，校验 `/api/health` 和 `/api/datasources/uid/:uid`。检查结果包含 `status/checkedAt/message/checks`，成功时带安全数据源身份字段；不持久化“永远在线”状态。响应同时返回开始检查时捕获的安全配置 `monitoring` 和快照 `revision`；前端只能把结果附加到完全匹配的配置，不能把旧检查结果显示在另一份已编辑或已保存的配置上。详见 [Grafana 接入](monitoring-integration.md)。

## 状态持久化与运维

单个进程持有 `console-state.lock`，每次事务同时提交任务/配置与审计：临时文件写入并 sync，再原子 rename。写入失败保留原状态，损坏的状态文件明确报错。状态、临时文件和锁权限限制为服务用户可用；不把数据目录放在公开资源内。

正常退出使用 `SIGTERM`，服务等待请求并释放写锁。异常终止可能留下锁：先确认旧服务已经退出，备份状态，再移除该目录的 `console-state.lock`。不要在运行中的另一实例持锁时删除它。该版本不支持多个进程共用一个数据目录。

容量限制为 10,000 任务、50,000 审计记录、50,000 幂等记录、1,000 Worker、32 MiB 状态文件；不会自动清理历史。上线前安排持久卷和备份，长期大规模历史应迁移数据库。

租约默认 60 秒。失联任务标记失败并保留未知执行结果说明，不自动重复执行，避免一次外部写入被再次触发。服务没有事务性控制远程 Git/CI，因此 Worker 也必须对外部动作做幂等，并在重试前核对已经产生的外部结果。

## 验证范围

`npm test` 覆盖真实 HTTP 会话、CSRF、创建/持久重启、批量部分成功、规则/监控保存、独立 Worker 身份、诊断/两级审批/执行、租约失效、取消确认、幂等、原子写失败、候选文件边界和静态目录隔离。`npm run build` 覆盖类型与静态构建。

这些测试使用隔离的本地 Agent/HTTP 夹具，不代表已经连接用户的生产 AI、GitHub、Grafana 或 Kubernetes。静态 Site 不能运行本 Node 服务；实际部署需要把此服务放在可访问的运行环境中。
