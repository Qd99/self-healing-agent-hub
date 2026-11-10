# Agent 接入协议

工作台管理服务提供真实的拉取式 Worker 协议。任何语言的 Agent 都可以通过 HTTP 领取任务、提交候选和回传结果。仓库的 `WorkflowEngine` 是抽象接口；当前没有预装的 AI 执行器。接入时把已有 Agent 的诊断与写入动作拆成下面两个阶段，不能在诊断阶段直接提交仓库或创建 PR。

## 凭据和请求

服务端设置 `HEALING_WORKER_TOKEN`，Worker 以 `Authorization: Bearer <Worker 令牌>` 访问 `/api/healing/worker/*`。管理者使用另外的 `CONSOLE_API_TOKEN`；Worker 不能调用审批接口。

所有请求为 JSON 对象，最大 1 MiB；使用 HTTPS 访问远程服务。以下例子用 `HUB_URL`、`HEALING_WORKER_TOKEN` 代表由运行环境注入的值，勿把真实凭据写入代码仓库。

## 1. 领取诊断任务

```http
POST /api/healing/worker/claim
Content-Type: application/json
Authorization: Bearer <Worker 令牌>
```

```json
{ "engineId": "fast", "workerId": "agent-host-01" }
```

engineId 必须是服务端已配置引擎，目前配置投影支持 `fast` 和 `complex`。无可执行任务返回 `{ "task": null }`，Worker 可稍后再领。成功领取返回：

```js
{
  task: { task: { id, type, payload, metadata }, title, status, revision, ... },
  lease: { id: "私有租约ID", phase: "diagnose", expiresAt: "ISO时间" },
  context: { safety, rule, monitoring }
}
```

领取原子执行，两个 Worker 不会同时获得同一任务的同一个有效阶段。任务的 repo/branch 来自管理服务；把这些字段当作数据，不要直接拼接为 shell 命令。

诊断阶段允许在隔离工作区生成候选并运行检查，不得进行尚未授权的远端写入。安全策略随任务保存；配置变更用于后续新任务，原任务与候选保留其创建时的策略快照。

## 2. 维持续租与取消

默认租约 60 秒；建议每 15–20 秒发送：

```http
POST /api/healing/worker/tasks/:id/heartbeat
```

```json
{ "leaseId": "领取得到的私有ID" }
```

响应包含新的租约到期时间和 `cancelRequested`。收到取消请求，停止启动后续动作，在确认停止后调用：

```http
POST /api/healing/worker/tasks/:id/cancelled
```

```json
{ "leaseId": "当前私有ID" }
```

收到 409 或租约过期必须停止使用该租约。服务将超时任务置为失败，说明外部结果未知，不自动重新执行。Worker 需要核对可能已发生的 Git、PR、CI 等外部副作用。

## 3. 提交候选方案

```http
POST /api/healing/worker/tasks/:id/proposal
```

代码修改方案示例：

```json
{
  "leaseId": "诊断租约ID",
  "summary": "移除未使用导入，保持运行行为不变",
  "diff": [
    {
      "path": "src/app.js",
      "additions": 0,
      "deletions": 1,
      "lines": [{ "type": "remove", "content": "import unused from 'unused';" }]
    }
  ],
  "evidence": {
    "beforeState": { "commitSha": "原始提交SHA", "summary": "lint 检查失败" },
    "afterState": { "summary": "候选工作区检查通过" },
    "testsRun": ["npm run typecheck", "npm run lint", "npm run test"],
    "checksPass": ["npm run typecheck", "npm run lint", "npm run test"],
    "checksFail": []
  }
}
```

只有真实执行过的检查才写入 testsRun 和结果。代码方案必须提供非空 diff，增加/删除数量与行记录一致；文件路径不得逃逸、触碰 `.git` 或保护范围，文件总数不超过策略。必需检查全部通过后才进入审批。

`trace` 可选，为最多 200 项的 `{ id,parentId?,title,kind,status,durationMs?,detail? }`。kind 为 `agent/tool/check`，status 为 `pending/running/completed/failed`。beforeState/afterState 只接受短文本，或 `commitSha/branch/summary/status` 安全对象，不支持任意嵌套环境或秘密。

### 不修改代码的动作

路由 `create-issue` 或 `retry` 使用空 diff，summary 描述将创建的 Issue 或重试动作，evidence 提供实际诊断检查记录。诊断结果可以失败，例如 CI 当前失败正是发起重试的原因；不能谎报为通过。

服务端根据路由生成 `proposal.kind: "action"`；代码方案为 `"code-change"`。无代码动作不能夹带文件变更，两类都需要同样的两级人工批准。Worker 不能通过自行指定 kind 降低校验。

提案成功后释放诊断租约，任务等待审批。不要继续向旧租约回传执行成功。

## 4. 等待审批并领取执行阶段

两级审批分别是 `code-review` 与 `execution-auth`。Worker 继续调用 claim；已批准的任务会以 `lease.phase: "execute"` 返回，并携带批准的 proposal、diff 和 evidence。

适配器必须核对 proposal.id/contentHash 及原始提交状态，执行获批的候选。代码重生成、基础提交变化或计划范围扩大都应停止本次执行并报告失败；不能把审批用于不同候选。

原 `WorkflowEngine.execute(task, context)` 不能直接在 diagnose 领取时调用并产生写入。应先提供独立的“生成候选/验证”方法，在 execute 阶段才调用应用候选或外部动作。

## 5. 回传最终结果

```http
POST /api/healing/worker/tasks/:id/complete
```

```js
{
  leaseId,
  result: {
    success: true,
    action: "committed",
    changes: { files: ["src/app.js"], commit: "实际40或64位提交SHA" },
    logs: ["实际执行日志；发送前去除凭据"],
    evidence: { beforeState, afterState, testsRun, checksPass, checksFail: [] }
  }
}
```

结果必须匹配原路由：

| 规则 action    | 成功结果 action | 必需结果证据                                         |
| -------------- | --------------- | ---------------------------------------------------- |
| `auto-commit`  | `committed`     | commit、与获批候选完全一致且无重复的 files、质量检查 |
| `create-pr`    | `pr-created`    | pr、与获批候选完全一致且无重复的 files、质量检查     |
| `create-issue` | `issue-created` | issue，无代码修改或额外 commit/PR                    |
| `retry`        | `retry`         | 实际重试结果，无代码修改或额外 commit/PR/Issue       |

最终 timings 由服务端真实领取和完成时间生成，不信任 Worker 提交的耗时。成功后工作台、报表、审批执行节点和操作记录更新。

失败可在诊断或执行阶段发送 `success:false, action:"failed"`，error 使用 `{ code,message,retriable }`。成功跳过可发送 `success:true, action:"skipped"`，但不能携带 commit、PR、Issue 或文件变更。已请求取消时，complete 会拒绝，必须走取消确认；取消不意味着撤销已经发生的远程操作。

管理队列、审批和审计都持久化，远端 Git/CI 不与该文件构成分布式事务。为外部动作实现幂等键，并以 task ID、proposal ID 记录执行结果，避免进程中断后重复提交。禁止在结果中包含模型密钥、GitHub token、私钥、环境变量转储或带凭据的链接。

## 本地联调证据

`tests/console-live-api.test.mjs` 使用真实 Node HTTP 请求完成管理认证、创建、诊断提案、两级审批、执行结果和重启持久化。`tests/console-service.test.mjs` 覆盖并发领取、迟到回调、租约失效、取消、错误证据与结果边界。

测试 Worker 的结果是隔离联调数据，不能当作生产代码已经修复的证据。生产接入还需要部署运行中的 Agent 适配器及其自己的仓库/模型/CI 权限。
