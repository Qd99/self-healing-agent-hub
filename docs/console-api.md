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
  trace: ConsoleTraceStep[];
  diff: ConsoleFileDiff[];
  result?: Serialized<Result>;
}
```

`reviewState` 属于 UI 扩展元数据，不给原有 `TaskStatus` 增加“待审批”等状态。Trace、diff、活动记录也有单独的展示契约。真实执行器接入时，需要把事件、状态和结果转换到此结构，并在 capability 中只开放已经可用的操作。浏览器内存中的演示数据使用 `mode: "demo"`；真实服务连接失败必须显示错误，不能自动替换成演示成功。

## 验证

```bash
node --test tests/console-server.test.mjs
```

HTTP 集成测试覆盖示例与实际配置的选择、逐层敏感字段过滤、读取刷新、坏配置及缺失配置的明确错误、失效符号链接、写操作拒绝、静态媒体类型、路径与符号链接隔离、URL 解码错误，以及入口的 localhost 默认监听和与工作目录无关的配置定位。
