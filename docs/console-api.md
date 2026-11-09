# 管理台 API 与框架对接

本次管理台通过同源 HTTP 网关读取项目现有的配置文件。网关基于 Node.js 18+ 内置模块，不需要新增依赖；它没有实例化 `WorkflowEngine`，也不会执行 shell、修改 Git 仓库、调用 AI 或触发 CI。

## 启动与嵌入

```bash
node apps/healing-hub/src/index.mjs
```

默认地址为 `http://127.0.0.1:8787`。`HOST` 可以显式覆盖监听地址，`PORT` 可以覆盖端口；`PORT=0` 让操作系统分配空闲端口。入口根据自身位置定位仓库，因此不依赖启动命令所在的目录。当前没有登录或 RBAC；若需要跨机器访问，应先完成部署环境中的访问控制。

也可以嵌入已有的 Node 服务启动流程：

```js
import { createConsoleServer } from './apps/healing-hub/src/console-server.mjs';

const server = createConsoleServer({
  rootDir: '/absolute/path/to/self-healing-agent-hub',
  publicDir: '/absolute/path/to/self-healing-agent-hub/apps/console/public',
});

server.listen(8787, '127.0.0.1');
```

`createConsoleServer` 返回尚未监听的 `http.Server`。省略 `rootDir` 时使用仓库根目录；省略 `publicDir` 时使用 `<rootDir>/apps/console/public`。

## 路由

| 方法 | 路径 | 当前行为 |
| --- | --- | --- |
| `GET` | `/api/healing/snapshot` | 读取配置，返回管理台快照 |
| `POST` | `/api/healing/trigger` | `501 NOT_IMPLEMENTED` |
| `POST` | `/api/healing/tasks/:id/cancel` | `501 NOT_IMPLEMENTED` |
| `POST` | `/api/healing/tasks/:id/retry` | `501 NOT_IMPLEMENTED` |
| `POST` | `/api/healing/approvals/:id/decision` | `501 NOT_IMPLEMENTED` |
| `GET` | 未知 `/api/...` 路径 | `404` JSON 错误 |
| `GET` / `HEAD` | `/` 和允许的静态资源 | 仅从 `publicDir` 读取文件 |

所有 API 响应均使用 `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。静态资源有明确的媒体类型与 `nosniff`，使用 `Cache-Control: no-cache`。静态目录不列出内容，也不自动查找目录中的 `index.html`；只有 `/` 映射到根 `index.html`。隐藏文件、路径穿越、越出公开目录的符号链接和不在资源扩展名白名单中的文件均返回 `404`。

## 配置来源与错误

每次读取快照时，分别选择配置和路由规则文件：

| 内容 | 优先读取 | 仅在优先文件不存在时读取 |
| --- | --- | --- |
| 项目配置 | `configs/healing-config.json` | `configs/healing-config.example.json` |
| 路由规则 | `configs/healing-rules.json` | `configs/healing-rules.example.json` |

`configSource` 和 `rulesSource` 分别报告 `configured` 或 `example`。实际文件存在但 JSON 无效、已知字段类型错误、不可读或是失效的符号链接时返回错误，不会退回示例。网关不缓存配置，所以保存文件后下一次快照请求会重新读取。

| HTTP 状态 | 错误代码 | 含义 |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | 请求路径无法正确解码或含空字符 |
| `404` | `NOT_FOUND` | API 或公开资源不存在，或资源访问被拒绝 |
| `405` | `METHOD_NOT_ALLOWED` | 快照或静态资源使用了不支持的方法 |
| `500` | `CONFIG_INVALID` / `RULES_INVALID` | 已选文件的 JSON 或已知字段类型错误 |
| `500` | `CONFIG_READ_ERROR` / `RULES_READ_ERROR` | 已选文件无法读取 |
| `500` | `INTERNAL_ERROR` | 其他未预期的请求错误 |
| `501` | `NOT_IMPLEMENTED` | 尚未对接真实执行器的写操作 |
| `503` | `CONFIG_MISSING` / `RULES_MISSING` | 实际文件与示例文件均不存在 |

错误结构保持一致；不回显配置内容、请求体、底层堆栈或服务器绝对路径：

```json
{
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "No execution engine is connected. The management API is read-only."
  }
}
```

## 快照协议 v1

以下是字段结构的精简示例；仓库提供的规则模板实际包含十条规则。日期字符串使用 ISO 8601 格式。

```json
{
  "apiVersion": 1,
  "mode": "live",
  "generatedAt": "2026-11-09T12:00:00.000Z",
  "configSource": "example",
  "rulesSource": "example",
  "rulesVersion": "1.0.0",
  "project": {
    "id": "your-project-id",
    "repo": "owner/repo-name",
    "defaultBranch": "main"
  },
  "capabilities": {
    "trigger": false,
    "cancel": false,
    "retry": false,
    "approve": false,
    "updateRules": false
  },
  "engines": [
    {
      "id": "fast",
      "name": "Fast Engine",
      "type": "direct-ai",
      "provider": "anthropic",
      "model": "claude-sonnet-4",
      "configured": true,
      "implemented": false,
      "status": "unavailable",
      "message": "Configuration is present; no execution engine is connected."
    }
  ],
  "rules": [
    {
      "id": "ci-retry",
      "name": "CI失败重试",
      "enabled": true,
      "match": {
        "taskType": "ci-failure",
        "context.retryCount": { "$lt": 3 }
      },
      "processor": { "engine": "fast", "action": "retry", "priority": "high" }
    }
  ],
  "safety": {
    "maxFilesPerFix": 5,
    "protectedPaths": ["deploy/", "*.env"],
    "requiredChecks": ["npm run test"],
    "circuitBreaker": {
      "enabled": true,
      "failureThreshold": 3,
      "windowMinutes": 60,
      "cooldownMinutes": 30
    },
    "autoRollback": { "enabled": true, "ciTimeout": 600000, "notifyOn": ["slack", "github-issue"] }
  },
  "triggers": {
    "webhooks": { "enabled": true, "events": ["push", "workflow_run"] },
    "cron": { "healthCheck": { "enabled": true, "schedule": "*/30 * * * *" } },
    "manual": { "enabled": true, "requireAuth": true }
  },
  "tasks": [],
  "activity": []
}
```

`mode: "live"` 表示来自当前网关。它不表示执行器在线，也不表示已开始处理任务。当前 `tasks` 与 `activity` 始终为空，所有 capability 均为 `false`。引擎的 `configured: true` 仅表示找到配置，实际状态仍为 `implemented: false`、`status: "unavailable"`。`safety` 与 `triggers` 是配置视图，不能作为安全检查已经运行或 Webhook 已启用的证据。可选配置缺失时相应字段省略，不虚构启用状态。

### 公开字段白名单

网关逐层重新构造响应对象，不会先复制整个配置再删除几个敏感键。只允许以下配置字段进入响应：

| 区域 | 允许的字段 |
| --- | --- |
| `project` | `id`、`repo`、`defaultBranch` |
| `engines.fast` / `engines.complex` | `type`、`provider`、`model`；也可从 `config.model` 读取模型名 |
| `rules[]` | `id`、`name`、`enabled`、下列 `match` 和 `processor` 字段 |
| `rules[].match` | `taskType`、`context.retryCount` 的数值比较 `$lt` / `$lte` / `$gt` / `$gte` / `$eq` |
| `rules[].processor` | `engine`、`action`、`priority`、`workflow` |
| `safety` | `maxFilesPerFix`、`protectedPaths`、`requiredChecks` |
| `safety.circuitBreaker` | `enabled`、`failureThreshold`、`windowMinutes`、`cooldownMinutes` |
| `safety.autoRollback` | `enabled`、`ciTimeout`、`notifyOn` |
| `triggers.webhooks` | `enabled`、`events` |
| `triggers.cron` | `healthCheck` / `qualityScan` / `dependencyAudit` 下的 `enabled`、`schedule` |
| `triggers.manual` | `enabled`、`requireAuth` |

API key、private key、Webhook secret、引擎 endpoint、手动 API endpoint、GitHub 配置、审计文件路径及未知配置键均不输出。规则的未知匹配字段也不输出；管理台是白名单投影，不能用于完整导出、编辑或重新执行原始规则。

## 与框架类型对接

`packages/framework/src/types/console.ts` 复用原来的 `Task`、`TaskStatusInfo`、`Result` 与 `WorkflowEngine` 类型。`Serialized<T>` 将其中的 `Date` 转为 ISO 字符串，原有框架接口不变。JSON 中开放的 `unknown` 数据仍保持 `unknown`，后续接入实际任务时必须先按用途校验和删去敏感内容。

管理台使用以下任务包装结构：

```ts
interface ConsoleTask {
  task: Serialized<Task>;
  status: Serialized<TaskStatusInfo>;
  title: string;
  engineId: string;
  reviewState?: 'pending' | 'approved' | 'rejected';
  approvalFlow?: ConsoleApprovalFlow;
  trace: ConsoleTraceStep[];
  diff: ConsoleFileDiff[];
  result?: Serialized<Result>;
}
```

`reviewState` 与 `approvalFlow` 属于 UI 扩展元数据，不给原有 `TaskStatus` 增加“待审批”等状态。Trace、diff、活动记录也有单独的展示契约。真实执行器接入时，需要把事件、状态和结果转换到此结构，并在 capability 中只开放已经可用的操作。浏览器内存中的演示数据使用 `mode: "demo"`；真实服务连接失败必须显示错误，不能自动替换成演示成功。

## v3 审批展示与内存演示协议

独立审批中心消费 `ConsoleTask.approvalFlow`，并通过 `apps/console/public/approvals.js` 的 `getApprovalFlow(entry)` 投影为节点图。该扩展没有新增可执行 HTTP 写接口：上表中的 `POST /api/healing/approvals/:id/decision` 仍返回 `501 NOT_IMPLEMENTED`，真实快照仍是空任务与关闭的 capability。

### 审批记录与节点投影

`ConsoleApprovalFlow` 在 `packages/framework/src/types/console.ts` 中定义。它包含：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 当前审批元数据版本 `1` |
| `source` | `demo-fixture` 或未来服务端的 `server`；当前演示写操作只接受前者 |
| `round` | 审批轮次，重新发起后递增 |
| `status` | `pending`、`approved`、`rejected` 或 `cancelled` |
| `checks` | `plan`、`quality`、`safety` 的显式状态、说明及证据时间；缺失内容不能推断为通过 |
| `gates` | 顺序固定的 `code-review`、`execution-auth` 人工关卡，包含标题、角色、负责人、状态、处理时间与意见 |
| `history` | 跨轮次历史；每项包含 `id`、`round`、`nodeId`、`decision`、`actor`、`at` 和 `comment` |

历史中的 `decision` 使用 `submitted`、`approved`、`rejected`、`resubmitted` 或 `cancelled`。演示负责人 Qd99 只是展示字段，不构成身份认证或真实岗位授权。

`getApprovalFlow(entry)` 返回 `{ taskId, round, status, currentNodeId, nodes, edges, history, currentGate }`。六个节点为：

| ID | 展示含义 |
| --- | --- |
| `plan` | Agent 诊断与候选方案 |
| `quality` | 质量验证，与安全检查并行呈现 |
| `safety` | 变更范围与保护路径检查 |
| `code-review` | 第一个人工关卡：代码审阅 |
| `execution-auth` | 第二个人工关卡：执行授权 |
| `execute` | 执行与归档，当前只可能等待执行器或被阻塞、取消 |

连接关系为 `plan` 分别指向 `quality` 和 `safety`，两者汇入 `code-review`，再依次进入 `execution-auth` 与 `execute`。只有显式自动检查均完成、此前人工关卡已通过时，才提供可操作的 `currentGate`。无审批元数据时 `status` 为 `unavailable`，节点为 `unknown`；不能由配置存在、规则启用或笼统的任务成功字段生成检查通过结论。

### 浏览器内存命令

以下是 `applyDemoAction` 的本地 JavaScript 命令，**不是已经接通的 HTTP API**。函数拒绝 `mode !== "demo"` 的快照；审批状态机还要求目标任务为显式演示任务。

```js
import { applyDemoAction } from './apps/console/public/data.js';
import { getApprovalFlow } from './apps/console/public/approvals.js';

const flow = getApprovalFlow(taskEntry);
const updated = applyDemoAction(snapshot, {
  type: 'approve-gate',
  id: taskEntry.task.id,
  payload: {
    nodeId: flow.currentNodeId,
    round: flow.round,
    comment: '已查看候选变更和验证证据',
  },
});
```

| 命令 | 必要上下文 | 状态变化 |
| --- | --- | --- |
| `approve-gate` | 当前 `nodeId`；表单同时发送 `round`；意见可选且最多 500 字 | 第一关通过只解锁执行授权；第二关通过才将 `reviewState` 改为 `approved` |
| `reject-gate` | 当前 `nodeId`、表单轮次、1–500 字非空原因 | 当前关卡拒绝，后续关卡阻塞；审批状态为 `rejected`，任务为 `cancelled` |
| `resubmit-approval` | 已拒绝且已取消的任务、表单轮次、1–500 字非空说明 | `round` 递增并重开两个人工关卡，保留全部历史、原候选变更及原检查证据 |
| `cancel` | 可取消的 `pending` / `running` 任务 | 任务和审批流停止；保留已完成检查、已决定关卡与取消记录，执行节点显示取消 |

旧 `approve` / `reject` 别名也必须传入当前 `nodeId`，不能绕过两级审批。模型拒绝不匹配、已处理、尚未解锁或不存在的节点；传入 `round` 时会校验整数值和当前轮次。当前 UI 始终发送节点与轮次，防止旧表单继续决定新的关卡。将来实现真实写接口时，还需要在服务端持久化并校验版本、身份、权限及并发条件，不能把当前浏览器检查视为服务端授权。

两关通过后，任务仍为 `pending`，执行节点为 `queued`，界面显示等待执行器；候选 diff 不会被应用，也不会生成新提交。重新发起审批只重开决定流程，不修改候选方案或重新运行检查。拒绝、取消和重新提交均保留历史，取消后的记录仍可在审批中心查看。每次操作使用新快照并追加演示活动记录，不写入配置文件、Git、数据库或真实审计存储。

## 验证

```bash
npm test
npm run typecheck
```

HTTP 集成测试覆盖示例与实际配置的选择、逐层敏感字段过滤、读取刷新、坏配置及缺失配置的明确错误、失效符号链接、写操作拒绝、静态媒体类型、路径与符号链接隔离、URL 解码错误，以及入口的 localhost 默认监听和与工作目录无关的配置定位。

截至 v3 更新，完整测试集为 53 项通过，TypeScript 契约检查通过。审批回归覆盖顺序推进、重复与过期决定、拒绝必填、后续阻塞、重新发起与历史保留、取消保留证据、缺失自动检查证据及真实模式拒写。浏览器也已验证两级审批、拒绝必填与阻断、重新提交及历史查看；完整交付验收见 [验收记录](design/validation.md)。
