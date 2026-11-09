# Console v7 Implementation Plan

> **For agentic workers:** Continue the authorized UI refinement using isolated file ownership and a final integrated review.

**Goal:** 收紧工作台信息结构和四模块密度，统一表面、字阶及操作反馈。

**Architecture:** 保留原生 ESM/CSS 与 snapshot 模型。首页布局在 dashboard 文件中，共享样式在 ui/navigation 文件中，任务/操作记录/监控分别维护自身视图与样式。

**Tech Stack:** JavaScript、CSS、Lucide SVG、Node.js。

**Spec:** docs/superpowers/specs/2026-11-09-console-refinement-v7-design.md

## Global Constraints

- 不改变后端契约、权限、两级审批和演示/真实边界。
- 使用既有私有 Site、feat/agent-console-ui 分支和 Draft PR，不合并 main。
- 无新依赖；可逆样式变化用浏览器验收，真实行为缺陷才增加针对性回归。

## Review Focus

- 图表在 1/7/30 天、零任务和缺失耗时时保持真实口径。
- 任务状态/筛选/勾选/批量及菜单互不干扰。
- 窄屏、长中文标题与深色主题不溢出或失去对比。
- 原生点击重绘和键盘焦点保留可感知反馈。
- 监控未知值、例子地址禁用和本机草稿语义不变。

## Tasks

- [x] `dashboard.js/css`：统计带、紧凑六行任务、审批与趋势右栏；删除首页重复记录。
- [x] `ui.css`、`navigation.js/css`：主题层级、导航选中、搜索入口、字阶与真实交互表面反馈。
- [x] `task-views.js/tasks.css`、`administration-views.js/administration.css`：任务工具栏及行距、紧凑操作记录，保留全部 action/ID/ARIA 契约。
- [x] `monitoring-views.js/css`：紧凑统计和未接入状态，保持配置能力。
- [x] 整合审查、148 项测试与构建、桌面/手机/深色浏览器验收及五张截图。
- [x] 更新文档，通过 Sites 源码工作流发布并核对终态；代码沿用原 Draft PR 交付。

## 验收

测试与实际浏览器观察、交互缺陷修复、发布来源见 [v7 验收记录](../../design/console-v7.md)。最后通过带 expected SHA 的非强制 GitHub 分支更新同步本地文件树，保留 Draft PR 与主分支状态。
