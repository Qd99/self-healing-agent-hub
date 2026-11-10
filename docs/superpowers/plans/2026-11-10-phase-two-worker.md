# 第二阶段执行计划

Spec: docs/superpowers/specs/2026-11-10-phase-two-worker-design.md

本轮恢复丢失工作区，按已授权契约完成。独立 A/B/C worktree 并行重建，root 串行集成、分任务与最终独立审查，创建 Draft PR。旧测试数字不能作为恢复后验收。

## Global Constraints

保留 v1；单来源/仓库/create-pr；发布关闭默认；无真实repair发布、merge、forcepush、deploy、CI dispatch或status写入；Hub网络锁外；SHA/patch/tree绑定；Docker-only生产check；凭据不进入快照/产物；统一UI及真实反馈。

## Task A: Hub

恢复共享candidate helper、Jenkins来源、v2协议、独立核验、service/server/type接入与配置示例。先提交helper给C。完成分页missing-next/last/sequence/budget回归、manualtrustedSource防伪造、leaseWorker归属、重启ACK、verificationlate-receipt fencing。重新跑focused与full测试/lint/typecheck，提交并写报告，独立审查。

## Task B: Engine

恢复4个模块workspace/model/check/process以及对应测试。真实rawpayload；精确checkout，隔离metadata、受控Git/env、Docker argv/清理、strict model/paths、BOM与无末换行/executable保留、savedpatch重放。重新focused/full/lint，提交和独立审查。不得提供宿主check默认回退。

## Task C: Runtime

恢复config/Hubclient/journal/publisher/runtime/CLI。两次base读取，精确hash/ACK与两审批，持久proposal/outbox，heartbeat/deadline/cancel，原子journal、单worker锁，GitHub确定性branch/PR与uncertain只读恢复。补未知副作用、artifact篡改、conflictingbranch、ambiguousref测试。重新focused/full/lint，提交和独立审查。

## Task D: Root

恢复UI（导入共享dialog、source、独立核验、并发反馈/草稿保护），Node/package/lint/gitignore；集成A/B/C；实际Git/HubHTTP/Nodecheck联调；更新运行/API/验收文档；完整tests/lint/build/format与可行浏览器检查；最终独立review、修复后重新验证；最新main父提交+文件树核对，创建新DraftPR，不merge/deploy。
