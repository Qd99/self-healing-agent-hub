# Phase One Reliability Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and review. Track each task below.

**Goal:** 修复第一阶段已复现的管理协议、容量、配置冲突与详情反馈问题。

**Architecture:** 保留 Node HTTP 服务与单实例 JSON 持久化；收紧 Worker 返回值，添加中断回执与人工核对，配置单独版本化。沿用现有统一 UI，补充结果和只读详情更新。

**Tech Stack:** Node.js、ES modules、原生 JS/CSS、node:test、ESLint 9、TypeScript。

**Spec:** `docs/superpowers/specs/2026-11-10-phase-one-reliability.md`

## Global Constraints

- 只实现用户确认的第一阶段；不触发 CI、不合并、不部署真实执行器。
- 保留现有配置和持久数据兼容，不能静默删除审计或任务。
- Worker 响应不含管理 snapshot；管理投影不泄漏私有租约。
- 失败副作用可以记录，成功结果必须符合授权；待核对阻止重试。
- 前端统一组件、中文反馈、紧凑布局；不要增加无关侧栏页面。
- 保持现有依赖，除非质量检查确需且来源可用。

## Review Focus

- 旧状态重启后仍能加载：任务 1/2 的持久化测试。
- 取消与完成竞争、迟到回执重复：任务 1 的协议测试。
- 心跳期间编辑配置与真正配置冲突：任务 2/3 的版本测试。
- 审计/字节容量不足且租约过期：任务 2 的只读降级测试。
- 详情更新时保持标签、滚动、编辑草稿与安全外链：任务 3 的视图/浏览器验证。

## Task 1: Worker responses, results and reconciliation

**Files:** `apps/healing-hub/src/console-service.mjs`, `console-server.mjs`, `packages/framework/src/types/console.ts`, protocol tests and docs.
**Interfaces:** Spec's task.reconciliation and POST tasks/:id/reconcile; no Worker snapshot. Results keep existing fields.

- [x] Add failing tests for all Worker response scopes, per-action artifacts, interrupted and duplicate receipts, restart and retry guard.
- [x] Implement strict response projection and result validation; preserve private receipt identity and public evidence.
- [x] Implement manager reconciliation with revision, idempotency and a recorded conclusion; invalidate conclusion when new evidence arrives.
- [x] Run focused protocol tests and the full suite; review changed state-machine paths.

## Task 2: Configuration versions and capacity fallback

**Files:** `console-service.mjs`, `console-store.mjs`, `packages/framework/src/types/console.ts`, new `tests/console-storage-recovery.test.mjs`, related docs.
**Interfaces:** snapshot.configRevisions; expectedConfigRevision optional with legacy expectedRevision fallback. Expose a small snapshot.storage status/reason/usage structure and document exact shape.

- [x] Write failing tests for heartbeat/empty-claim versus resource config versions, genuine stale config writes, legacy state migration and read availability at capacity.
- [x] Add independent rules/monitoring version checks without weakening true edit conflicts.
- [x] Keep snapshot readable when expiry persistence cannot commit; show read-only state and disable writes. Preserve history and private-field filtering.
- [x] Verify ordinary persistence and existing tests; report API shape to frontend implementer.

## Task 3: Task feedback and frontend integration

**Files:** `apps/console/public/*` as needed, frontend tests. No server edits.
**Interfaces:** configRevisions, expectedConfigRevision, task.reconciliation and reconcile endpoint from spec; storage status from task 2.

- [x] Add failing tests for final result/error/artifact rendering and safe links, read-only task-detail updates, reconciliation and config request versions.
- [x] Add compact result and reconciliation sections in existing detail, with pending/success/failure feedback.
- [x] Continue read-only detail polling while preserving tab/scroll/focus; retain pauses for actual editing/confirmation workflows.
- [x] Show storage warning/read-only reason and respect write capabilities.
- [ ] Verify in an actual browser after integration. Blocked by sandbox Chromium socket permissions and shared-browser access to the isolated service; automatic policy rejected starting an outside-sandbox QA server. VM/DOM and real HTTP regressions pass; this browser gate remains open.

## Task 4: Lint gate and final verification

**Files:** `eslint.config.mjs`, package scripts only if necessary, minimal lint fixes coordinated with other owners.
**Interfaces:** npm run lint must cover actual JS/MJS apps/scripts/tests; npm run build continues framework typecheck and console build.

- [x] Reproduce missing-config failure; add meaningful core JS rules with correct environment globals and generated-output ignores.
- [x] Fix actual lint errors with minimal edits; do not suppress lint broadly or introduce unrelated refactors.
- [x] Verify lint, tests, build and changed-file formatting.
- [x] Independently review integration, update docs with evidence and publish a fast-forward update to the existing PR branch after checking its head.
