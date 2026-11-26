# 故障注入演练层

对应联合评审第 2 轮 CORE2-R2-I01：把「真实服务断线、进程中断、资源清理、未确认发布」变成**可重复执行的演练**与**可查询的证据**，作为真实环境验收（`docs/design/console-v20-jenkins-handoff.md` 的 CI-01..05 / UI-01..05）之前的演练层。

## 1. 定位与边界

演练层是**编排与取证**，不是又一套断言框架。每个场景制造一次真实故障，然后观察生产代码路径（`apps/healing-worker/src/runtime.mjs`、`apps/healing-hub/src/console-service.mjs`、`apps/healing-worker/src/github-publisher.mjs`）是否兑现契约。

真实的部分：Hub HTTP 服务、Worker runtime、真实本地 Git、真实落盘 journal、真实 `fork` 出的 Worker 子进程、真实 `SIGKILL`、真实检查子进程。

受控的部分：Jenkins 与 GitHub 由本地 HTTP 服务应答；Docker CLI 边界使用 `tests/fixtures/worker/docker-transport.mjs`。

**因此演练证据一律标记 `externalTier="controlled"`**，它证明的是本机上的恢复契约，**不能**替代真实 Docker daemon、真实非生产 Jenkins job、真实 GitHub 权限的验收。真实验收矩阵仍以 `console-v20-jenkins-handoff.md` 为准，且仍然 blocked 在缺失的环境上。

演练只在临时目录内操作隔离的 Git 仓库与隔离 `dataDir`，不连接 174，不连接生产 Hub，不产生真实 GitHub 写入。

## 2. 使用

```bash
npm run fault:drill                      # 全部场景
npm run fault:drill -- --scenario <id>  # 单个场景
npm run fault:drill -- --out <dir>      # 指定证据目录
```

退出码 0 表示所选场景全部通过；任一断言失败或场景抛错均为 1。`npm test` 不包含演练（演练 fork 真进程、耗时秒级，属于按需执行的独立入口）。

可用场景 id：

| id                                  | 注入的故障                             | 断言的核心契约                                                                                                                       |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `hub-disconnect-lost-ack`           | Hub 受理提案后 ACK 在传输层丢失        | journal 停在 `proposal-pending`；重启后重放**同一请求体**（同一 `submissionId`），Hub 幂等受理一次；候选不重新生成                   |
| `worker-sigkill-resource-cleanup`   | 检查执行中 `SIGKILL` 真实 Worker 进程  | journal 保留完整容器标识；daemon 不可用时停在 `cleanup-pending`、不领新任务、不发回执；daemon 恢复后先清理再补录**恰好一条**失败回执 |
| `publish-unconfirmed-manual-review` | PR 真的创建了，但 ACK 丢失且列表不可见 | 远端确实写入过一次；回执 `PUBLICATION_UNCERTAIN` 且不可重试；任务失败并进入人工核对；重启后**不重发**发布                            |
| `base-moved-refuse-execute`         | 审批后远端基线前进一个提交             | 不写入远端、不创建 PR；错误码 `BASE_MOVED`；任务失败并进入人工核对                                                                   |

## 3. 证据格式

每次执行产出一个目录（默认写入系统临时目录，`--out` 可指定；产品仓库不收运行产物）：

- `summary.json` —— `runId`、命令、退出码、Node 与平台、**演练代码所在 commit SHA + tree + 工作区 clean/dirty**、每个场景的断言明细与结果摘要。
- `journal-snapshots/<id>.json` —— 场景关键时刻的 worker journal 原文快照（证明 `cleanup-pending` / `proposal-pending` / `known.intent` / `known.uncertain` 确实落盘过）。
- `README.md` —— 一句话说明外部系统为受控响应。

证据绑定 174 工作台的五要素：commit SHA、tree、工作区 clean/dirty、完整命令、退出码。未执行项不写成通过。写盘前对全部 JSON 扫描凭据字面量，命中即拒绝落盘。

## 4. 断言的有效性

断言不是摆设。每条关键断言都用**变异测试**验证过：故意破坏对应契约后，演练必须报红。已验证的变异包括：

| 变异                                             | 被哪条断言抓到                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| 重放提案时更换 `submissionId`                    | 「两次提案使用同一 submissionId」「Hub 对重放返回同一提案受理结果」 |
| 关闭 Hub 的提案幂等分支                          | 「重放后提案被 Hub 接受」「Hub 对重放返回同一提案受理结果」         |
| 关闭 Hub 对 execute 失败回执的核对标记           | 「进入需要人工核对」                                                |
| 恢复失败时不再停在 `cleanup-pending`             | 「daemon 不可用时状态为 cleanup-pending」                           |
| `failureReason` 不再产出 `PUBLICATION_UNCERTAIN` | 「回执错误码为 PUBLICATION_UNCERTAIN」                              |

已知覆盖边界：基线守卫在生产代码里有**三重冗余**（Worker 公共路径、Worker execute 路径、publisher `assertBase`），单独破坏其中一处不会改变演练结论；必须同时破坏三处，演练才会报红。这说明该契约本身是可靠的，但也意味着该场景的断言针对的是**整体行为**（不写入、不建 PR）而非某一处实现。

## 5. 与既有测试的关系

演练**不修改**任何既有测试文件。既有覆盖与演练的对应关系：

| 演练场景                            | 相关既有测试                                                             |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `hub-disconnect-lost-ack`           | `tests/worker-e2e.test.mjs` 丢 ACK 全流程                                |
| `worker-sigkill-resource-cleanup`   | `tests/worker-resource-lifecycle.test.mjs` SIGKILL 与 cleanup-pending 组 |
| `publish-unconfirmed-manual-review` | `tests/worker-e2e.test.mjs` 丢 PR ACK                                    |
| `base-moved-refuse-execute`         | `tests/worker-e2e.test.mjs` moved base                                   |

差异在于：既有测试断言契约，演练**注入真实故障**并把证据落盘成可查询的 JSON，可直接附到 PR 或验收记录。
