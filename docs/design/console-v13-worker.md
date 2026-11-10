# 第二阶段实现与验收

## 交付范围

本次从已合并的第一阶段 main `051b8e3` 恢复，实现受限 Jenkins `ci-failure → create-pr` 闭环。工作台复用原表单、按钮、状态、详情组件，新增 CI 导入、固定来源/候选身份和独立 PR/CI 核验；没有增加侧栏模块。

服务端提供精确构建来源、事件去重、v2 候选与租约归属、冻结 CI policy、只读外部核验和并发结果隔离。独立 Worker 提供模型候选、可信 Git 工作区、Docker 检查、持久 journal、两级审批后的确定性 Draft PR 发布及重启恢复。

## 真实本地端到端联调

`tests/worker-e2e.test.mjs` 运行实际临时 Git 仓库、Hub HTTP 服务、浏览器 API 客户端、Worker journal、模型 HTTP 响应及 Node 检查进程。GitHub HTTP 夹具使用真实 `hash-object`、`write-tree`、`commit-tree`、`update-ref` 构造对象和分支，最终检查真实 parent/tree。

覆盖三个完整场景：

1. 失败构建导入、重复去重、基线失败、候选通过、两级审批、默认禁发布、启用后的执行；模拟提案 ACK、PR ACK、结果 ACK 在服务端接受后丢失，重启仍只调用一次模型、只创建一个 PR；验证 pending → failed → passed 及不可信 CI creator。
2. 批准后基线移动，执行停止，GitHub 零写入，进入人工核对。
3. 模型 HTTP 请求进行中管理者取消，续租察觉取消，中止请求后确认停止，不创建 PR。

检查注入仅用于隔离测试：执行真实 Node 子进程而非 Docker。Jenkins、模型与 GitHub HTTP 响应均来自本地夹具，没有创建真实业务修复 PR、执行 CI dispatch 或部署。生产默认路径仍为 Docker，缺失 Docker 时停止。

## 其他回归范围

| 范围                                                  | 测试证据                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Jenkins provenance/拒绝异常来源                       | `jenkins-source.test.mjs`                                                                   |
| 分页完整性、request/byte/deadline 上限、CI 身份       | `github-verification.test.mjs`                                                              |
| 导入/审批/租约/v2 ACK/迟到回执/核验并发               | `console-ci-integration.test.mjs`、既有 service/live API 测试                               |
| 候选稳定 hash、v1 兼容                                | `candidate-protocol.test.mjs`、既有 service 测试                                            |
| 真 Git patch/tree、保护路径、模型、进程与 Docker 参数 | `worker-workspace.test.mjs`、`worker-model.test.mjs`、`worker-checks.test.mjs`              |
| 发布漂移/冲突/不明确响应、持久重启、取消/心跳/篡改    | `worker-publisher.test.mjs`、`worker-runtime.test.mjs`、`worker-journal.test.mjs`           |
| UI 禁用原因/请求反馈/快照乱序/草稿与选择隔离          | `console-ci-ui.test.mjs`、`console-api-client.test.mjs`、`console-app-concurrency.test.mjs` |

最终执行命令为 `npm test`、`npm run lint`、`npm run build`，另对本次更改执行格式与 diff 检查。每个实现任务及整条分支另经独立代码审查；最终数量与提交见 Draft PR。

## 尚未完成的生产验收

此开发环境没有 Docker 可执行文件，未运行真实容器隔离验收。没有用户部署的 Jenkins/模型/GitHub 运行凭据和目标失败构建，未进行真实业务闭环。发布功能保持配置默认关闭，连接真实部署前按 [运行指南](../healing-worker-guide.md) 验收。

当前仍为单仓库、单稳定 Worker 身份和文件 journal。已有 v1 任务/哈希/回执继续兼容。多分支 Jenkins 合成 merge、多 SCM、Check Runs、多副本调度、自动恢复/回滚不在本阶段范围。

浏览器验收已实际尝试 Playwright + `/usr/bin/chromium`。浏览器启动被环境拒绝，错误为 `process_singleton_posix.cc socket() failed: Operation not permitted`，未进入页面；本次未获得浏览器截图或真实浏览器交互验收。已通过 DOM/控制器/VM 回归验证交互逻辑，视觉验收留待具备浏览器能力的部署环境。
