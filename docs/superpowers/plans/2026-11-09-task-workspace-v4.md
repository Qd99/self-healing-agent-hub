# Task Workspace v4 Implementation Plan

**Goal:** 修复全部任务布局并补齐组合筛选、批量处理、分页和侧栏交互。

**Architecture:** 新增纯任务模型与任务视图模块；root 将它们集成到既有 app.js，并调整全局导航。沿用 Node 网关和 Task/Result 契约。

**Tech Stack:** Native browser ESM / CSS / SVG / Node tests.

**Spec:** ../specs/2026-11-09-task-workspace-v4-design.md

## Constraints

同一功能分支、同一 Draft PR 与私有预览。批量写操作仅 demo，实时重新校验 capability，不批量批准审批。

## Review Focus

- 选择范围：分页保留，筛选/来源变化清空，不误操作隐藏选择。
- 混合状态批量：显式跳过和反馈，不改变原记录；重复与缺失 ID 安全处理。
- 日期与状态：全部任务独立时间范围，待审批不计为排队。
- 无障碍：复选框半选、菜单键盘、弹窗焦点、手机导航可退出、中文输入不丢字符。
- 导出：可见字段白名单、CSV 引号和公式前缀。

## Tasks

- [x] task-model.js + console-task-list.test.mjs：筛选、排序、分页、批量计划/执行、导出；先验证失败再实现并跑测试。
- [x] task-views.js + tasks.css：状态视图、筛选/条件 chip、表格/分页、批量反馈及确认弹窗；检查动态转义和窄屏布局。
- [x] app.js + views.js + navigation.css + index.html：状态事件、选择/菜单/焦点、简约可折叠侧栏、模式清理、导出下载。
- [x] 实际浏览器与独立审查：桌面/窄屏/深色、组合筛选、跨页选择、批量跳过、导出、键盘与审批回归。
- [x] 文档、实际截图与最终简约版回归。

交付位置沿用原有私有预览与 Draft PR #1。
