# Worker 候选与资源恢复修复记录

日期：2026-11-11。分支：`feat/phase-two-jenkins-worker`。[PR #2](https://github.com/Qd99/self-healing-agent-hub/pull/2)。

## 范围与恢复基线

本轮针对 PR 最终复核的 I1（候选规范化）、I2（取消时错误确认容器停止）、I3（崩溃后缺少资源身份）修复。恢复提交 `3aeb4f3f96cd2592093c3dc195bcec0d4b920820`，tree `beaeed9623d5afb30dfc19ebf524b7891a2c5d28`。恢复后重新运行原基线，434/434 测试通过；原通过结果没有覆盖这三类缺陷。

既有两级审批、默认禁发布、固定基线、原始发布字节、完整 patch/tree、丢 ACK 重放和分页边界继续保留。未修改 UI、依赖或生产配置。

## 修复后的行为

| 问题或边界                            | 实现与验证                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 摘要首尾空白导致 Hub/Worker hash 不同 | 共享 v2 表示在 artifact 与首次请求保存前规范化；实际 Hub 接受后 Worker 正确保存 ACK                  |
| 历史 raw-summary 请求已经被接受       | 校验 body/artifact 的规范身份，原 body/submissionId 不变；只规范保存的 artifact 元数据，严格校验 ACK |
| 文件路径被 trim 成其他文件            | 新提案和模型输入拒绝首尾空白及非法路径；内部空格、Unicode、组合字符保持精确身份                      |
| 历史 Hub 路径规则较宽                 | 保存的旧哈希继续按原始路径核验；新输入仍严格拒绝，修改过的历史 hash 仍不能加载                       |
| 历史 Worker 候选无法安全对应          | `candidate-blocked` 保留记录，不发送提案、不重新生成、不领取下一任务                                 |
| `docker rm` 非零、抛错、超时或假成功  | 后续独立查询决定是否已不存在；不能证明时保留 `cleanup-pending`，不发送停止回执                       |
| 容器已经被删除                        | 成功、完整的全状态查询返回空才证明不存在；不以 inspect exit 1 猜测不存在                             |
| Worker 在启动检查时被杀死             | 创建意图、完整 ID 和工作区已写入 journal；新进程先恢复清理，旧租约不再执行                           |
| 恢复时 daemon 不可用                  | 多次重启仍保留资源与挂载目录，阻止新 claim；daemon 恢复后清理再提交原中断事实                        |
| 归属/资源字段不完整                   | 拒绝清理其他目录或容器，不把缺字段当成已空闲；旧版本缺少身份须人工核对                               |
| 已保存 outbox 同时残留资源            | 先确认资源清理，再按原 body 重放回执                                                                 |

## 生命周期决策

检查采用 `docker create`、保存完整不可变 ID、`docker start --attach` 的顺序。容器 ID 删除后，延迟的旧 start 请求无法再启动该容器；仅查询停止状态不足以提供这个保证。

新容器不使用 `--rm`，并明确 `--restart=no`。保留最终元数据是为了区分真实检查退出与 Docker 客户端/API 错误：后者同样可能返回 1，不能当成已复现的仓库失败。实际退出状态验证完毕后再显式删除。已被其他途径移除的自有容器仍可通过查询被确认为安全。

清理使用经验证的完整 ID，先核对随机运行标识、精确名字和所有者 label。查询与删除分别有时间/输出上限，不继承已取消租约的 AbortSignal。资源清除的 journal 更新也必须成功；持久更新失败会保留待恢复身份。

唯一无需查询旧资源的情况，是首次 create 可执行进程本身以 ENOENT/EACCES 启动失败，能证明没有发出创建请求。已有资源恢复、其他 Docker 错误和 journal 文件错误不适用此判断。

## 回归证据

所有测试使用本轮恢复的代码重新执行，运行时为 Node.js v24.22.1；项目最低要求仍为 20.3。

| 检查                        | 本轮结果                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| 恢复基线 `npm test`         | 434/434 通过                                                             |
| 新增生命周期首轮回归        | 原实现 0/7，复现错误 ACK、丢失身份、错误恢复顺序及持久失败后仍执行       |
| Docker runner 首轮回归      | 观察到 11 个失败，修复后针对性 runner 15/15 通过                         |
| 真实子进程 crash / 取消集成 | 原 PR 基线 0/3；修复后 3/3，通过 SIGKILL、journal 重开及 Docker 传输恢复 |
| 资源字段缺失回归            | 修复前两个分支失败；修复后阻塞回执与领取并保留目录                       |
| 当前整合树 `npm test`       | 482/482 通过，0 失败、取消、跳过                                         |
| `npm run lint`              | 通过                                                                     |
| `npm run build`             | TypeScript 与同源 API 工作台构建通过                                     |
| `npm run format:check`      | 通过                                                                     |
| `git diff --check`          | 通过                                                                     |

实际 Hub/Git/journal 回归在 `tests/worker-candidate-normalization.test.mjs`。资源状态与真实 Worker 进程 SIGKILL 在 `tests/worker-resource-lifecycle.test.mjs`，只替换 Docker CLI 传输层；生产 runtime、workspace、check-runner、文件 journal 和 Git 操作均参与。`tests/worker-e2e.test.mjs` 原有真实 Hub HTTP、认证/CSRF、Git 对象与 Node 检查进程场景仍包含在全量门禁中。

## 独立复核

由未参与实现的独立 reviewer 对本轮完整修复 diff、全部改动生产模块，以及周边 Hub 幂等/存储校验、journal、process-runner、publisher 做了只读复核。结果为 **0 Critical / 0 Important / 0 Minor；Ready to merge（代码修复层面）：Yes**。没有遗留的本轮代码发现。

reviewer 独立执行 `node --test tests/worker-candidate-normalization.test.mjs tests/worker-resource-lifecycle.test.mjs`，**33/33 通过**，0 失败、取消、跳过；另核对全量门禁日志和恢复文档。该签字针对 I1–I3 修复，不表示生产环境闭环已验收。

## 验收边界

当前执行环境对本地 Docker daemon 的显式探测返回 `docker: No such file or directory`。因此本轮证明的是实际 Worker 进程、Git、Hub 和持久 journal 的行为，以及受控 Docker 命令传输下的生命周期逻辑；尚未证明真实 Docker daemon 的隔离、清理、崩溃恢复。

没有使用部署方 Jenkins、模型、GitHub 写入凭据或真实失败构建进行业务修复。生产闭环仍需部署环境验收，Worker 发布保持默认关闭。本轮不合并 main、不部署、不执行真实修复发布或 CI dispatch。

完整启动和手动核对说明见 [Worker 运行指南](../healing-worker-guide.md)。

## 官方行为依据

- [Docker create](https://docs.docker.com/reference/cli/docker/container/create/)：创建容器不启动进程，可先保存容器身份再启动。
- [Docker 全状态容器查询](https://docs.docker.com/reference/cli/docker/container/ls/)：使用 `--all` 覆盖停止和运行状态，`--no-trunc` 保留完整 ID。
- [Docker CLI attached start 实现](https://github.com/docker/cli/blob/master/cli/command/container/start.go)：退出结果仍需结合容器执行元数据验证，不能将普通客户端失败作为基线检查失败。
