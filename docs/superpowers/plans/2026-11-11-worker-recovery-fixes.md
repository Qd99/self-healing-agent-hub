# 第二阶段 Worker 阻塞修复计划

> **For agentic workers:** Use the existing debugging, TDD and independent review workflow. Execute the authorized repair without another approval pause. Track completion below.

**Goal:** 关闭 PR #2 的 I1–I3：统一 v2 候选身份，并把活动取消和异常重启纳入同一套可持久恢复的检查生命周期。

**Architecture:** Hub 与 Worker 使用共享的候选表示；已经发送的请求保持原始提交身份。检查启动前记录工作区和自有容器意图，只有可信 Docker 查询确认容器停止或不存在才释放工作区、发送终止回执或领取新任务。未知状态保留在 journal，重启执行清理恢复而不续跑旧租约。

**Tech Stack:** Node.js ESM / node:test，现有原子文件 journal，Git，Docker CLI；无新增依赖。

**Spec:** [第二阶段既有契约](../specs/2026-11-10-phase-two-worker-design.md) 与 [PR #2 的 I1–I3](https://github.com/Qd99/self-healing-agent-hub/pull/2)。恢复基线 `3aeb4f3f96cd2592093c3dc195bcec0d4b920820`，tree `beaeed9623d5afb30dfc19ebf524b7891a2c5d28`。

## Global Constraints

- 保留 v1、两级审批、固定 base/patch/tree、原始发布字节、丢 ACK 重放和分页防截断约束。
- 不放松 ACK hash/manifest 校验；不静默重命名文件，不改写已发出的 proposalBody/submissionId。
- 生产检查仅 Docker；没有 Docker 时不回退到宿主运行检查。
- 只清理本 Worker 已持久记录且归属可验证的资源；不按宽泛容器名前缀批量删除。
- 清理未知时不发送 complete/cancelled、不删除仍被挂载的工作区、不领取新任务。
- 不恢复旧租约执行、不重新生成候选；保留旧记录中无法证明安全的状态并给出恢复指导。
- 更新原分支和 Draft PR；不合并、部署或执行业务修复发布。

## Review Focus

1. 已获 Hub 接受但 Worker 未识别的历史 raw summary 提案：保留请求指纹、严格比对候选后解除 pending。
2. 文件名首尾空白、内部空格、Unicode 与路径限制：拒绝非规范输入，合法路径保持精确字节。
3. docker rm 非零、抛错、超时及 --rm 已移除：后续可信查询区分安全状态与未知，不能只按 rm 结果判断。
4. 启动意图持久化与真正启动之间崩溃、运行检查时崩溃、清理完成但 journal 更新失败：恢复幂等且保守。
5. daemon 不可用、错误资源身份及历史缺少资源记录：阻止回执/新 claim；不可误删其他容器或数据。

## Task 1: 候选规范化与历史提案

**Files:** `packages/framework/src/candidate.mjs`、Worker `model-client.mjs` / `workspace.mjs` / `runtime.mjs`、Hub `console-service.mjs`、候选/模型/真实 Hub 回归。

**Interfaces:** 共享 summary/path/v2 表示校验；`hashCandidateV2` 对同一规范表示计算身份。Runtime 校验保存的 body 与 artifact 一致，历史 body 原样重放。

- [x] 加入真实 Hub 的带首尾换行 summary、丢 ACK 重启、合法及非法路径回归，记录基线失败。
- [x] 在 artifact/proposal 保存前统一规范表示；v2 路径拒绝非规范形式，v1 不变。
- [x] 已有 pending 的 summary 按共享语义校验；无法安全重放的路径/产物保留阻塞记录。
- [x] 运行候选、模型、工作区、runtime、Hub 协议针对性检查。

## Task 2: 持久容器清理与重启恢复

**Files:** Worker `check-runner.mjs`、`workspace.mjs`、`runtime.mjs`；必要的 journal 生命周期字段；`tests/worker-checks.test.mjs` 与独立生命周期集成测试。

**Interfaces:** 检查 runner 通过 await 的生命周期回调先保存启动身份再运行 Docker，并暴露可信恢复清理。Workspace 通过 `onResources` 持久报告自身资源，提供 `recoverResources`；runtime 管理 journal 的资源状态和终止回执顺序。

- [x] 以实际 runner/runtime、受控 Docker 命令传输复现 rm 失败仍 ACK、无资源身份重启直接结束的问题。
- [x] 启动前保存独占工作区和唯一容器归属信息；清理用有界全状态查询和精确身份确认。
- [x] 未确认清理保留 `cleanup-pending`；恢复先清理，再冻结回执，最后才允许下一任务。
- [x] 覆盖正常清理、已不存在、失败/抛错/超时、已启动检查崩溃、daemon 不可用、持久化失败及旧记录。
- [x] 运行检查 runner、工作区、journal、runtime 及本地 E2E 回归。

## Task 3: 全量验证、独立复核与 PR 更新

**Files:** Worker 指南、协议说明、修复验收记录及本计划。

- [x] 恢复正确远端树并确认干净工作区；重新运行基线 `npm test`：434/434 通过。
- [x] 更新恢复与运维说明，准确区分真实 Git/Hub/进程联调、Docker transport 夹具和真实 Docker 验收。
- [x] 运行 `npm test`、`npm run lint`、`npm run build`、`npm run format:check`、`git diff --check`。
- [x] 由未参与实现的 reviewer 独立复核变更与关键既有边界，修复有证据的阻塞并重跑必要检查。

同步原 `feat/phase-two-jenkins-worker` 分支及 PR #2 的实际提交、远端树核对结果，以 PR 更新记录为准；不合并或部署。

## 进度与决策

- 2026-11-11：已恢复与 GitHub 完全一致的分支，既有 UI 工作区不变；基线 434/434 通过，当前 Node v24.22.1。
- I2/I3 合并处理：停止证明与恢复清理共享同一资源身份，避免只修活动取消却保留崩溃漏洞。
- 既有已发送提案保留原始请求：Hub 幂等指纹绑定原 body，不能为修复 summary 重写请求。
- 检查启动拆为 create / 持久化完整 ID / start；新容器保留退出元数据再显式清理，避免把 Docker 客户端 exit 1 当成检查失败。
- 历史 Hub 快照按原路径字母表核验 hash，新提交和 Worker 恢复按严格路径准入；兼容测试证明旧状态可加载且被篡改的 hash 仍拒绝。
- 资源身份/字段缺失保留阻塞，无法自动证明旧资源归属时由部署者核对，不做破坏性迁移。
- 最终整合测试 482/482，lint/build/format/diff 全部通过；独立复核 0 Critical / 0 Important / 0 Minor，独立重点回归 33/33。
