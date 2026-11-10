# 第一阶段：管理协议与任务反馈修复

用户已确认推进上一轮审查的第一阶段。本轮沿用现有 Node 服务、原生 JS UI 和单实例文件存储，修复已经复现的问题，并更新现有 Draft PR。

## 范围与行为

- 所有 Worker 路由仅返回协议所需的本任务信息，不返回管理 snapshot。
- 成功回执的产物遵守动作边界：committed 只允许 commit；pr-created 允许 PR 和其 commit；issue-created 只允许 Issue；retry/skipped 不允许外部产物。失败或中断的副作用仍应记录。
- 完成/取消回执可按租约和内容幂等确认；相同租约的不同正常完成内容拒绝覆盖。
- 执行阶段取消、失联和部分失败保留任务事实，进入待核对状态；迟到回执可以补录，但不能恢复执行权限或把取消任务改成成功。
- 待核对任务不能直接重试。管理员可记录核对结论和说明，再决定重试；新到达的副作用证据使既有核对失效。
- 规则和监控配置有独立版本，Worker 心跳和空领取不造成新版 UI 配置保存冲突。保留旧 expectedRevision 的兼容路径。
- 容量不足时保留写入限制，但管理快照仍可读取、导出并显示只读原因；不得静默删除历史。旧数据兼容。
- 任务详情展示最终动作、commit/PR/Issue、安全链接、实际失败原因、待核对状态；打开只读详情时继续更新，同时保留选中标签与滚动位置，不覆盖编辑草稿。
- 修复 ESLint 9 配置，对实际 JS/MJS 源码实施有效静态规则；保留框架 TypeScript 检查。

## 接口约定

- snapshot.configRevisions = { rules: number, monitoring: number }。
- 配置写入新增 expectedConfigRevision；存在时以资源版本校验，缺省时保留 expectedRevision 的全局版本校验。
- task.reconciliation = { status: "required" | "resolved", reason: string, updatedAt: string, resolution?: { outcome: "no-changes" | "changes-recorded", note: string, actor: string, at: string } }。
- POST /api/healing/tasks/:id/reconcile：expectedRevision、requestId、outcome、note；仅管理身份允许，要求终态且待核对，返回管理 snapshot。
- Worker complete/cancelled 保留 result 的现有结构；中断场景下结果保存为证据，任务保持取消或失败，reconciliation 标明需核对。
- Worker 凭据、私有租约和回执指纹不出现在管理 snapshot；终态回执只能由对应租约及认证身份提交。

## 验收边界

首轮仍不启动真实 AI/Git/CI 修复、不改 Jenkins/Actions、不合并 main。覆盖 HTTP 权限、错误/重复/迟到回执、重启、配置并发、容量耗尽与浏览器详情刷新。用现有测试和必要的新行为测试验证；交付时记录精确 SHA、测试结果和仍属下一阶段的能力。
