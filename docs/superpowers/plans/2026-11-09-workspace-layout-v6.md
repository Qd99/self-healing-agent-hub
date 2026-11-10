# 工作台版式重构 v6 Implementation Plan

> **For agentic workers:** Apply the existing component system and verify rendered interactions. Tasks below track this authorized visual refinement.

**Goal:** 以任务为中心优化工作台、全部任务、监控与操作记录，统一图标、数据展示、层级与交互反馈。

**Architecture:** 延续原生 ESM/CSS 和 snapshot 模型。只重组展示层，首页使用独立 home-* 作用域；共享导航和控件继续从现有文件维护。

**Tech Stack:** 原生 JavaScript、CSS、Lucide SVG、Node.js 构建。

**Spec:** docs/superpowers/specs/2026-11-09-workspace-layout-v6-design.md

## Global Constraints

- 保留真实/演示模式边界和原有审批、任务、监控能力。
- 保留现有 Site ID、私有访问范围和 Draft PR，禁止合并 main。
- 不新增依赖；布局通过浏览器验证，交互时序通过针对性的回归检查验证。

## Review Focus

- 非默认日期范围与空任务列表。
- 审批缺失或已完成的任务不会进入不适用的操作。
- 手机宽度和折叠侧栏下无页面级横向溢出。
- 深色主题与可见焦点。
- 全部任务批量操作和审批阶段原有交互继续可用。

## Tasks

- [x] 重写 dashboard.js、新增 dashboard.css；删除首页重复流程图，保留事件契约。
- [x] 调整共享配色、导航、页头工具排列与响应式比例。
- [x] 增加 `uiMetric`、快照任务结果趋势、统一交互反馈和手动刷新结果；优化任务、监控及操作记录。
- [x] 浏览器复查四模块、深色与手机布局；修复首页键盘交互、手机菜单对齐、任务分页遮挡及每页标签换行。
- [x] 完整 `npm test` 144/144 通过；完成原有控件契约比较及变更审查。
- [x] 更新 v6 设计、使用指南与 README，明确演示数据及 Grafana 未验证边界。
- [x] 将最终浏览器截图归档为 `docs/design/console-v6-{overview,tasks,monitoring,activity,dark}.jpg`。
- [x] 准备原有 GitHub Draft PR 的完整源码、说明与截图，保持 main 未合并。
- [x] 通过既有 Site 源码工作流打包发布演示版本，并确认部署成功。

**状态：**实现、本地验证、截图归档及私有 Site 发布完成。应用源码由原有 Draft PR 交付，最终远端提交由发布记录核对；验收口径见 `docs/design/console-v6.md`。
