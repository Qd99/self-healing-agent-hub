# v3 Agent Console Implementation Plan

**Goal:** 根据用户反馈重做材质、图标和动效，并提供可交互的串行审批流。

**Architecture:** 保留现有原生 ESM 前端和只读网关，新增审批模型和渲染模块。root负责应用状态、首页、全局视觉和交付；两个独立任务分别实现审批模型与审批视图，最后做集成审查。

**Tech Stack:** 浏览器 ESM / CSS / SVG、原生 Node 测试、既有 TypeScript 契约。

**Spec:** ../specs/2026-11-09-agent-console-v3-design.md

## Constraints

- 同一 feat/agent-console-ui 分支和 PR #1，不合并主分支，不修改CI。
- 演示审批不得触发真实修复；真实模式的配置读取与写保护保持不变。
- 仅使用有许可证的图标和独立编写的视图，不复制收费组件。

## Tasks

- [x] 审批模型：approvals.js / data.js / console.ts，按nodeId和round校验串行决策；测试两关、拒绝、重发、旧按钮、取消、live隔离。
- [x] 审批视图：approval-views.js / approval.css，节点图、当前审批详情、diff、历史、原因表单与窄屏滚动。
- [x] 工作台与应用：dashboard.js / studio.css / views.js / app.js，首页流程、彩色图标、导航、状态与表单衔接。
- [x] 验证：npm test、npm run build、实际浏览器交互与视觉检查、独立代码审查。
- [x] 交付：实际截图、设计与接入文档、原私有Site更新、原Draft PR更新。
