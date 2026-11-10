# Agent 接入协议

工作台管理服务提供真实的拉取式 Worker 协议。任何语言的 Agent 都可以通过 HTTP 领取任务、提交候选和回传结果。仓库保留 `WorkflowEngine` 抽象接口，并提供受限的 Jenkins `create-pr` Worker，见 [运行指南](healing-worker-guide.md)。接入时把诊断与写入动作拆成下面两个阶段，不能在诊断阶段直接提交仓库或创建 PR。

## 凭据和请求

服务端设置 `HEALING_WORKER_TOKEN`，Worker 以 `Authorization: Bearer <Worker 令牌>` 访问 `/api/healing/worker/*`。管理者使用另外的 `CONSOLE_API_TOKEN`；Worker 不能调用审批接口。

所有请求为 JSON 对象，最大 1 MiB；使用 HTTPS 访问远程服务。以下例子用 `HUB_URL`、`HEALING_WORKER_TOKEN` 代表由运行环境注入的值，勿把真实凭据写入代码仓库。

Worker 路由只返回当前协议所需字段，所有响应都不含管理 `snapshot`。管理者通过经过认证的 `/snapshot` 查看任务、审批与操作记录。

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

收到 409 或租约过期必须停止执行及续租。服务将超时任务置为失败，不自动重新执行。执行阶段取消或失联会进入 `reconciliation.status: "required"`；重试在核对完成前被阻止。旧租约仍可用于补录执行事实，不能用于恢复执行权限。旧状态中的失败/取消任务若已记录外部产物、租约过期或执行取消结果未知，升级后会要求核对；原记录和版本不变，也不会补造租约。

取消确认可以同时携带 `result`，结构与 complete 相同；部分完成时保留已经发生的提交、PR、Issue、日志和错误。执行阶段仅发送取消确认而没有 result，仍需要管理者核对外部状态。

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

| 规则 action    | 成功结果 action | 必需结果证据                                                                          |
| -------------- | --------------- | ------------------------------------------------------------------------------------- |
| `auto-commit`  | `committed`     | commit、与获批候选完全一致且无重复的 files、质量检查；不接受额外 PR/Issue             |
| `create-pr`    | `pr-created`    | pr、与获批候选完全一致且无重复的 files、质量检查；可同时记录对应 commit，不接受 Issue |
| `create-issue` | `issue-created` | issue，无代码修改或额外 commit/PR                                                     |
| `retry`        | `retry`         | 实际重试结果，无代码修改或额外 commit/PR/Issue                                        |

最终 timings 由服务端真实领取和完成时间生成，不信任 Worker 提交的耗时。成功后工作台、报表、审批执行节点和操作记录更新。

失败可在诊断或执行阶段发送 `success:false, action:"failed"`，error 使用 `{ code,message,retriable }`。成功跳过可发送 `success:true, action:"skipped"`，但不能携带 commit、PR、Issue 或文件变更。

已请求取消时仍可提交 complete 记录事实：活动任务终止为 cancelled，结果保存；租约过期后补录的回执保留 failed 终态。迟到报告即使含 success:true，也不会把任务改为完成。执行阶段失败、取消、失联，或任何失败/中断中报告了外部副作用，都需要核对。取消不代表撤销远程操作。

complete/cancelled 的相同租约、相同内容可以在正常重启后幂等重发，返回原确认且不重复记录；同一正常完成的终态（包括失败）不接受另一份结果覆盖；只有明确记录取消或租约中断的尝试可以补录新结果。中断任务可补录新的事实，每个任务最多保留 10 份不同回执。已核对后，仅补发不含结果的取消确认不会使结论失效；新结果证据仍会要求重新核对。回执始终校验对应租约与认证身份。管理快照仅提供 `resultReceipts` 的种类、接收时间与结果，不暴露租约或指纹。

## 6. 核对中断的外部操作

管理者在任务详情核查仓库和 CI，再调用管理接口：

```http
POST /api/healing/tasks/:id/reconcile
```

```json
{
  "requestId": "一次核对操作的唯一标识",
  "expectedRevision": 7,
  "outcome": "changes-recorded",
  "note": "已确认 PR #42 存在，并核对了对应提交；后续重试将使用新的任务。"
}
```

此接口需要管理身份和 CSRF，Worker 无权调用。outcome 为 `no-changes` 或 `changes-recorded`，note 必填。已有回执列出外部变更时，不能选择 no-changes。核对结论和历史持久保留；新回执到达会重新要求核对，相同回执重发不会使已完成核对失效。核对只记录人的结论，不触发 Git/CI 动作，也不声明服务端已经独立验证远端结果。

管理队列、审批和审计都持久化，远端 Git/CI 不与该文件构成分布式事务。为外部动作实现幂等键，并以 task ID、proposal ID 记录执行结果，避免进程中断后重复提交。禁止在结果中包含模型密钥、GitHub token、私钥、环境变量转储或带凭据的链接。

## 本地联调证据

`tests/console-live-api.test.mjs` 使用真实 Node HTTP 请求完成管理认证、创建、诊断提案、两级审批、执行结果和重启持久化。`tests/console-service.test.mjs` 覆盖并发领取、迟到回调、租约失效、取消、错误证据与结果边界。

测试 Worker 的结果是隔离联调数据，不能当作生产代码已经修复的证据。生产接入还需要部署运行中的 Worker、可信检查镜像及对应仓库/模型/CI 权限。

迟到证据使来源任务重新进入待核对时，服务沿完整 `retryOf` 链阻止后续重试和领取。已经创建但未执行的后代任务被取消；持有租约的后代任务收到取消请求，随后提交成功结果也只作为中断证据保存。审批决定与原有结果保留，不会在来源任务核对后自动恢复。管理员必须核对所有仍待核对的祖先及当前任务，再手动创建新的重试。

这些后代任务公开 `execution.blockedByReconciliation = { taskId, reason, at }`，记录导致停止的来源任务、原因和时间。这是历史停止原因，来源任务核对后仍保留；实际重试权限以完整祖先链当前的核对状态为准。租约中断标记及回执指纹保持私有。

## 7. 第二阶段 v2 固定候选协议

v1 请求与原 `SHA256(JSON.stringify({diff,evidence}))` 哈希保持兼容。v2 仅用于经 Hub Jenkins 导入、固定来源 SHA 的 `create-pr` 任务。普通手工 trigger 不能伪造可信来源。

新 Worker 领取时声明能力和阶段：

```json
{
  "engineId": "fast",
  "workerId": "jenkins-worker-1",
  "actions": ["create-pr"],
  "sourceKinds": ["jenkins"],
  "candidateVersions": [2],
  "phases": ["diagnose"]
}
```

发布开启才加入 `execute`。不声明 v2 的旧 Worker 不会领到 Jenkins 诊断或 v2 执行任务。原始任务在 `claim.task.task`，repo/branch 在 `payload`，commitSha/source 在 `payload.context`。执行租约只会交给生成候选的同一 workerId 和认证身份。

v2 proposal 在原字段上增加稳定 `submissionId` 和 manifest：

```js
const proposalBody = {
  leaseId,
  workerId,
  submissionId, // 首次 POST 前生成并持久化；重放保持完全相同
  summary,
  diff,
  evidence,
  candidate: {
    version: 2,
    baseCommitSha, // 40 位十六进制，等于可信来源 SHA
    patchSha256, // 完整 Git patch 字节 SHA256，64 位十六进制
    treeSha, // 40 位 Git tree SHA
    artifactId, // 等于 patchSha256
  },
};
```

Hub 返回 `{taskId, proposal:{id,version:2,contentHash,candidate}, message}`。ACK 不含管理快照。Worker 应校验并持久化 ACK；响应丢失时可使用相同认证身份、租约、submissionId 和内容重放，即使该诊断租约已被成功提交释放。内容冲突会拒绝。

`packages/framework/src/candidate.mjs` 的 `hashCandidateV2()` 使用稳定对象键排序、保留数组顺序的 canonical JSON，绑定任务 ID、repo/branch/完整可信来源/失败 SHA、路由 action、summary、candidate、完整展示 diff 和规范化 evidence。缺省 states 为 null、检查列表为 []。审批、执行和回执必须保持同一身份。

v2 execute 的 complete 及携带 result 的 cancelled 请求在顶层加入 `proposalId` 和 `contentHash`。成功 `pr-created` 必须包含实际 40 位 commit、PR 编号和与批准 diff 精确一致的 files。已批准内容只能从保存的 patch 重放，不能重新调用模型或换基线。

```js
const body = { leaseId, workerId, proposalId, contentHash, result };
```

独立核验由管理接口 `POST /tasks/:id/verification` 发起，请求体只允许 `{expectedRevision}`。Hub 从已接受结果和批准候选构造目标，Worker 不能提交“验证通过”，调用者不能指定 URL/SHA。核验检查 PR/base/head/ref、唯一父节点、tree、完整文件分页以及冻结的可信 Commit Status policy；状态为 pending/passed/failed/mismatch/error/stale。它保留原 result，并与人工 reconciliation 分开。
