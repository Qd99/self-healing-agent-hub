# Surface and Navigation v9 Implementation Plan

> **For agentic workers:** Use inline execution for this authorized, bounded CSS refinement, with one independent final review.

**Goal:** 去除重复装饰边框，让侧栏和报表表面简洁、连贯。

**Architecture:** `ui.css` 定义共享表面和分隔变量；`navigation.css` 处理侧栏及顶栏；`dashboard.css` 去除首页内嵌小框；`settings.css` 调整来源选择样式。保留 DOM、事件和数据模型。

**Tech Stack:** 原有 CSS、原生 ESM、Lucide；无新依赖。

**Spec:** docs/superpowers/specs/2026-11-09-surface-navigation-v9-design.md

## Global Constraints

- 在现有 `feat/agent-console-ui` 工作区修改；保留原私有 Site 与 Draft PR。
- 不改变 API、任务和审批行为，不移除表单、表格、流程图与可见焦点的必要边界。
- 这是可逆的纯样式改动，不为 CSS 声明编写镜像单测；实际浏览器检查视觉与焦点。

## Review Focus

- 旧样式的高优先级或媒体查询不能重新引入侧栏边框。
- 深色表面、选中态、悬停和焦点必须有可辨识层次。
- 收起侧栏 tooltip、手机抽屉和遮罩保持可用。
- 共享卡片调整不误删审批节点、表格行和输入校验边界。
- 首页两行指标和各模块窄屏布局不产生横向溢出。

## Tasks

- [x] 按规格修改四个 CSS 文件，运行格式检查并构建显式演示。
- [x] 核对真实浏览器布局与交互，完成独立 CSS 审查；运行现有测试与生产构建。
- [x] 保存实际截图与 v9 记录，发布原 Site，按相同文件树同步原 Draft PR。

最终验证和 Site 来源见 [v9 记录](../../design/console-v9.md)；原 Draft PR 描述记录最终 GitHub 提交与文件树。浏览器发现的深色来源旧描边和窄屏审批按钮名称均已复现并修复。
