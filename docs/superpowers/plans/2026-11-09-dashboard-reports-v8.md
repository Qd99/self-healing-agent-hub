# Dashboard Reports v8 Implementation Plan

> **For agentic workers:** Continue the authorized dashboard redesign with isolated file ownership, targeted behavioral tests and one integrated final review.

**Goal:** 让首页以四类报表为主，缩小最近任务并增强数据图标与分类钻取。

**Architecture:** 新增纯 analytics 聚合；dashboard.js 负责渲染、dashboard.css 负责布局。task-controller 提供精确报表筛选入口，由 app.js 调用。

**Tech Stack:** 原生 JavaScript、CSS、SVG、Lucide、Node.js；无新依赖。

**Spec:** docs/superpowers/specs/2026-11-09-dashboard-reports-v8-design.md

## Global Constraints

- 保留既有 API、审批、安全与演示能力边界。
- 使用原私有 Site、feat/agent-console-ui 和 Draft PR，不合并 main。
- 数据来自当前快照；没有数据的指标显示未知／空态。

## Review Focus

- 北京时间与首页范围一致，状态占比不重复计算审批。
- 未知类型／引擎／状态不丢失任务，字符串始终转义。
- 钻取的列表条件与报表完全对应，不遗留搜索、旧勾选或批量结果。
- 空数据、单日和 30 天图表可读；图表有键盘读数与可见焦点。
- 390px、1024px、桌面和深色布局不溢出，不依赖动画表达结果。

## Tasks

- [x] 新建 analytics-model.js 与 console-analytics-model.test.mjs；先验证新测试失败，再实现并核对统计守恒、边界和不可变性。
- [x] 重写 dashboard.js：首页四指标、主趋势、状态环、问题排行、引擎表现和四条紧凑任务；保留业务 action。
- [x] 重写 dashboard.css，使用既有主题与 UI token，完整响应式及减少动画适配。
- [x] task-controller.js 新增报表钻取入口，app.js 分发 dashboard-filter；针对范围、旧条件与非法维度增加行为测试。
- [x] 整合审查、完整测试、构建、浏览器检查与实际截图。
- [x] 更新使用文档及 v8 验收记录，发布原 Site，按 exact tree 同步原 Draft PR。

最终验证、截图及 Site 来源见 [v8 验收记录](../../design/console-v8-review.md)；GitHub 最终提交和文件树核对结果记录在原 Draft PR 描述中。
