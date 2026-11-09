# Self-Healing Agent Hub · Web 管理台设计

## 目标与基线

用户需要高级、简约的 Web UI 设计图与可对接现有代码的实现。基线为 `Qd99/self-healing-agent-hub` 的 `main@0aee4ec4964bd9a8de455d166a5adafdf4531444`。基线只有三个 TypeScript 框架文件、两份配置模板、README 和架构说明；不存在运行中的 EventHub、具体引擎或 API。README 的路线图不是已实现能力证据。

## 方案选择

1. **浅色运维工作台（本次采用，由实现者选择）**：BoardUI 式清晰信息密度，AffectUI 式 Agent 执行步骤，少量 Solid Glass 式半透明工具栏。适合日常审阅任务与变更。
2. 深色观测大屏：适合持续监控，但在配置表单、长 diff 和审计阅读上密度与对比更难平衡；保留为同一界面的深色主题。
3. 手绘纸张/黏液风格：可用于介绍页；不作为长期运维后台的主材质。

## 界面与行为

- 用户否定第一版：指标卡、绿色渐变大图、层层圆角框造成明显模板感。此反馈覆盖上方初始材质方案。
- 第二版以 AffectUI Clean 的任务列表模式为主要参考，暖白画布、石墨文字、中性主按钮；状态仅用小面积鼠尾草绿/琥珀/红色。无大面积渐变、无KPI卡阵列、无玻璃主面板、无宣传口号。
- 桌面侧栏 202px；主标题 26px、正文 13–14px、辅助文字 11–12px。内容边距 48px，主要使用细分隔线和留白；只有需要交互分组的控件使用 6–8px 圆角。
- 工作台以「需要你处理」「正在运行」「最近完成」的平面任务列表为主。右侧窄栏呈现从当前任务计算的摘要、微型趋势与配置状态。完整图表不占据中心。
- 任务中心支持搜索与状态筛选；详情含状态、Trace、diff、测试证据与日志。审批作为独立的扩展状态，不能混入原有 TaskStatus。
- Agent 引擎直接映射 fast/complex 配置；未实现的引擎不能显示为健康在线。
- 路由规则映射原有 match/processor；安全页映射 protectedPaths、maxFilesPerFix、requiredChecks、circuitBreaker、autoRollback。
- 审计页根据当前数据源显示记录；连接页显示配置来源和后端能力。
- 所有导航、筛选、主题切换、详情、模拟创建/取消/重试必须有可观察结果。
- 对话框管理焦点、支持 Escape、标签明确；reduced-motion 优先；窄屏布局可操作，不依靠 hover。

## 对接边界

- `apps/console/public/` 为零依赖浏览器 ES modules，避免为目前的小型框架强加 React 运行时与打包链。
- `apps/healing-hub/src/index.mjs` 启动同源静态管理台与只读管理 API；默认监听 127.0.0.1。
- `GET /api/healing/snapshot` 读取实际配置，未配置时读取 example 并明确标识。响应只投影安全字段，不泄露 API key、GitHub private key、webhook secret。
- 任务与结果的数据契约复用现有 `Task`、`TaskStatusInfo`、`Result`、`WorkflowEngine` 类型。日期在 JSON 中为 ISO 字符串。
- `POST /api/healing/trigger` 与任务写操作在未接入执行器时返回 501，UI 禁用对应动作并解释原因。不会执行 shell、写仓库、改 CI 或调用真实 AI。
- 静态预览显式标记为「演示数据」，使用浏览器内存隔离，不向真实端点发送模拟操作。切换到真实服务失败时保留错误，不回退伪造数据。
- 引擎、队列、登录/RBAC、持久化、真实审批/回滚不是本次前端交付实现，文档明确列出。

## 验收

1. UI 在桌面和 390px 窄屏可读、导航可用；浅色与深色均可看。
2. 搜索、筛选、任务详情、模拟动作、规则查看、连接错误有真实交互反馈。
3. HTTP 集成测试验证配置投影、秘密不泄漏、缓存控制、路径隔离、未实现写操作 501。
4. 正常/失败/未知数据状态不显示虚构的在线或成功指标。
5. 提供设计图、私有可点击预览、GitHub 功能分支与 Draft PR；不合并 main。

## 参考

- https://boardui.com/
- https://affectui.com/
- https://github.com/deeplethe/solid-glass
- https://kevintngo.github.io/looseleaf/

以上参考用于布局、信息结构与材质原则，组件为独立实现，不复制付费源码。
