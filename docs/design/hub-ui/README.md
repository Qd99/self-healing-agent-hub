# Heal Engineering Console V13 · 待评审 UI 设计

- 规则：hub-ui/2026-11-24.v1；北京时间 2026-11-24；基线 main @ `0bc418319f6287756bc13e7837dc2d907dac17a0`。
- 线上只读事实：用户授权的 Autoloop 浏览器会话展示 Smallphone 工作台（任务看板、执行器、飞书审批、测试分诊、Jenkins、每日早报）。它与当前仓库 Hub 管理台并非已验证同一运行版本；不得跨项目混入线上任务数据。本原型无生产数据、无网络调用、无登录凭据。
- 本目录仅设计资料，不修改运行源码、不改变需求审批状态、不授权开发、不发布或合并。

## 查看设计

[下载并在本地浏览器打开交互原型](console-v13.html)。GitHub blob 可能显示源码，需要下载原始文件；可从侧栏切换 14 个页面、主题、搜索、详情、异常状态。当前为初稿，部分二级页签与操作只是布局/状态预览，尚未具备完整交互与真实接口。样本数据均标为示例。实际测试/发布未执行。

### 设计语言

中性灰白 `#F7F8FA` / `#FFFFFF`，细边框 `#E4E7EB`，墨色 `#181B20`，低饱和绿灰强调 `#426B63`；暗色背景 `#111315`、内容 `#191C20`、边框 `#2C3036`、文字 `#E6E8EC`。Geist / Inter / PingFang SC，Mono 12px，正文13–14px，页标题20–24px，Lucide 风格图标16–18px，圆角6–10px，侧栏可折叠；120–200ms 交互反馈、reduced-motion、焦点可见。参考 [Linear](https://linear.app/now/behind-the-latest-design-refresh)、[Geist](https://vercel.com/geist/introduction)、[GitHub Actions](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph)、[Grafana](https://grafana.com/docs/grafana-cloud/learn-and-build/telemetry-signals/get-started/quick-start/)。

### 信息架构

工作空间：工作台、全部任务、需求与审批；研发交付：全链路观测、测试中心、交付中心；运维治理：自愈中心、监控面板、操作记录；Agent 能力：执行器与规则、知识与评估、技术雷达；管理：安全与环境、连接设置。二级页签/抽屉共享，不为每个 issue 新建一套页面。已有路由与 controller、服务端分页及幂等操作保留，开发评审前不批准具体 API 变更。

### 首轮判定

19 条未关闭需求（#3–#21）；PR #2 不计需求。UI-NEW 9；UI-UPDATE 10；UI-REUSE 0；BACKEND-ONLY 0；BLOCKED 0（设计分类，不是开发就绪）。全部需求正文包含可见界面契约，因此本次没有纯后端需求；后端范围本身不出图。#3/#4/#12 等局部状态和字段复用已有页面。已读有评论的 #3/#4/#5/#6/#8/#12，评审指出的契约缺口保留待决，不以设计替代审批。

## Issue 映射与接口边界

### Issue 3

- [#3 [需求·待评审][HUB-CORE-001] Hub 与 Agent Autoloop 执行层统一集成](https://github.com/Qd99/self-healing-agent-hub/issues/3) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:6ba6f7fd`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[workers 原型（下载后打开对应 hash）](console-v13.html#workers)。执行器与连接设置：真实连接、版本、最后同步、未知状态。
- 现有实现与缺口：复用 navigation.js、connection-views.js、administration-views.js；统一引擎状态投影待 #3 契约确认。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 4

- [#4 [需求·待评审][HUB-CORE-002] 完成 PR #2 与最新 main 集成及真实 Jenkins 自愈验收](https://github.com/Qd99/self-healing-agent-hub/issues/4) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:6afac5b8`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[delivery 原型（下载后打开对应 hash）](console-v13.html#delivery)。任务详情、候选版本、真实 CI/PR 证据及核对。
- 现有实现与缺口：复用 task-views.js、approval-views.js；PR #2 尚未合并，不将分支能力当作 main。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 5

- [#5 [需求·待评审][HUB-GOV-001] GitHub 需求生命周期、标签同步与三方评审账本](https://github.com/Qd99/self-healing-agent-hub/issues/5) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:f97a6e7e`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[requirements 原型（下载后打开对应 hash）](console-v13.html#requirements)。需求与审批：三方结果、版本差异、授权、历史及同步冲突。
- 现有实现与缺口：复用 approvals.js 与 approval-views.js；独立评审账本及权限角色待确认。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 6

- [#6 [需求·待评审][HUB-PIPE-001] 版本化研发、测试和自愈流水线与阶段级断点续跑](https://github.com/Qd99/self-healing-agent-hub/issues/6) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:bd5773ac`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[trace 原型（下载后打开对应 hash）](console-v13.html#trace)。流水线阶段、分支、attempt、断点及失败解释。
- 现有实现与缺口：复用 task-views.js、console-service.mjs；版本化模板、合法恢复状态待确认。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 7

- [#7 [需求·待评审][HUB-AGENT-001] 多 Agent 研发任务 DAG、原子认领与隔离工作区](https://github.com/Qd99/self-healing-agent-hub/issues/7) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:85787a08`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[trace 原型（下载后打开对应 hash）](console-v13.html#trace)。Agent DAG/泳道、依赖、角色、分支、工作区、交接证据。
- 现有实现与缺口：复用任务详情；多 Agent 原子认领及工作区接口待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 8

- [#8 [需求·待评审][HUB-EVID-001] 可信证据账本与程序化质量门禁](https://github.com/Qd99/self-healing-agent-hub/issues/8) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:0a895d64`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[trace 原型（下载后打开对应 hash）](console-v13.html#trace)。证据和门禁抽屉：来源、SHA、失效、未知、可信报告。
- 现有实现与缺口：复用 approval-views.js 与现有 evidence；证据生命周期及独立门禁投影待评审。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 9

- [#9 [需求·待评审][HUB-TEST-001] 统一自动化 TestRunner、用例计划与测试中心](https://github.com/Qd99/self-healing-agent-hub/issues/9) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:8bc09dbf`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[tests 原型（下载后打开对应 hash）](console-v13.html#tests)。测试中心：计划、用例、执行、报告、用例级结果与筛选。
- 现有实现与缺口：现有可信执行器和测试报告可作为数据来源；TestRunner、计划及用例查询待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 10

- [#10 [需求·待评审][HUB-TEST-002] Bug 先红后绿、差分回归与测试防篡改门禁](https://github.com/Qd99/self-healing-agent-hub/issues/10) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:58623f36`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[tests 原型（下载后打开对应 hash）](console-v13.html#tests)。红绿差分、候选对比、新增失败、门禁拒绝。
- 现有实现与缺口：复用测试中心与证据抽屉；需固定测试用例、环境、候选 SHA。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 11

- [#11 [需求·待评审][HUB-DELIVERY-001] PR、Jenkins CI、测试环境部署及生产版本核验闭环](https://github.com/Qd99/self-healing-agent-hub/issues/11) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:53c3e3b6`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[delivery 原型（下载后打开对应 hash）](console-v13.html#delivery)。交付中心：PR、CI、部署、实际版本与核验时间线。
- 现有实现与缺口：复用候选和回执、PR #2 集成；交付关联与环境核验接口待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 12

- [#12 [需求·待评审][HUB-OBS-001] 统一工作流身份、事件采集与全链路 Trace 关联](https://github.com/Qd99/self-healing-agent-hub/issues/12) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:7eed759d`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[trace 原型（下载后打开对应 hash）](console-v13.html#trace)。统一链路 ID、事件来源、更新时间、完整性和缺口提示。
- 现有实现与缺口：复用 console-service.mjs readTrace；统一事件、跨系统关联待评审。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 13

- [#13 [需求·待评审][HUB-OBS-002] 全链路可视化中心：DAG、流水线、瀑布图、日志及回放](https://github.com/Qd99/self-healing-agent-hub/issues/13) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:7d3f53a8`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[trace 原型（下载后打开对应 hash）](console-v13.html#trace)。全链路 DAG、瀑布、日志、测试、PR/CI、证据、只读回放。
- 现有实现与缺口：复用 task-views.js、现有 Trace；真实事件查询、游标分页、回放接口待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 14

- [#14 [需求·待评审][HUB-OBS-003] 标准可观测基础设施、模型用量、研发效能与异常告警](https://github.com/Qd99/self-healing-agent-hub/issues/14) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:644b72ef`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[monitor 原型（下载后打开对应 hash）](console-v13.html#monitor)。监控：吞吐、排队、错误、延迟、成本、告警、覆盖率。
- 现有实现与缺口：复用 monitoring-views.js、monitoring-controller.js；目前 Grafana 仅验证连接/数据源身份。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 15

- [#15 [需求·待评审][HUB-REC-001] 统一失败分类、死因指纹、有限修复循环与模型升级](https://github.com/Qd99/self-healing-agent-hub/issues/15) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:3b57a614`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[healing 原型（下载后打开对应 hash）](console-v13.html#healing)。失败分类、指纹、有限重试、冷却、模型升级及转人工。
- 现有实现与缺口：复用 task-feedback.js 和重试核对；预算、升级与复诊策略待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 16

- [#16 [需求·待评审][HUB-SEC-001] 统一 Agent 沙箱、网络凭据隔离与可信外部动作执行器](https://github.com/Qd99/self-healing-agent-hub/issues/16) · UI-UPDATE · 需求 v1 · 指纹 `fnv1a32-unicode:866ec85e`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[security 原型（下载后打开对应 hash）](console-v13.html#security)。安全策略与 Worker：隔离、网络、资源、拒绝审计。
- 现有实现与缺口：复用 administration-views.js、现有保护路径/检查配置；沙箱与可信动作层待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 17

- [#17 [需求·待评审][HUB-DISC-001] 统一缺陷发现台账、主动巡检与故障复诊](https://github.com/Qd99/self-healing-agent-hub/issues/17) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:34127091`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[healing 原型（下载后打开对应 hash）](console-v13.html#healing)。缺陷发现台账、复诊队列、复发及修复 PR。
- 现有实现与缺口：复用任务、审计和监控；缺陷指纹台账与复诊计划 API 待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 18

- [#18 [需求·待评审][HUB-ENV-001] 多项目、测试环境资源锁、测试数据及 RBAC 治理](https://github.com/Qd99/self-healing-agent-hub/issues/18) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:2a6dd539`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[security 原型（下载后打开对应 hash）](console-v13.html#security)。环境及资源锁、测试数据、项目范围、角色权限。
- 现有实现与缺口：复用 settings 和 security；当前单管理身份，RBAC、跨项目权限及锁待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 19

- [#19 [需求·待评审][HUB-RESEARCH-001] 平台原生技术雷达、差异评估与需求自动登记中心](https://github.com/Qd99/self-healing-agent-hub/issues/19) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:269ea333`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[radar 原型（下载后打开对应 hash）](console-v13.html#radar)。技术雷达：发现、候选对比、未采纳、已登记。
- 现有实现与缺口：复用需求中心/GitHub 关联；内部调研调度及候选账本待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 20

- [#20 [需求·待评审][HUB-KNOW-001] 跨 Agent 工程知识库、按需上下文注入与会话恢复](https://github.com/Qd99/self-healing-agent-hub/issues/20) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:b8c7fb70`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[knowledge 原型（下载后打开对应 hash）](console-v13.html#knowledge)。工程知识库、项目范围、知识版本、批准与注入引用。
- 现有实现与缺口：复用任务证据；知识存储、检索及版本化注入待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

### Issue 21

- [#21 [需求·待评审][HUB-EVAL-001] Agent、模型与 Skills 的独立能力评估、A/B 对比及版本回归](https://github.com/Qd99/self-healing-agent-hub/issues/21) · UI-NEW · 需求 v1 · 指纹 `fnv1a32-unicode:3bcae67c`（变化筛查标识，不是安全或审批凭证）。
- 设计入口：[knowledge 原型（下载后打开对应 hash）](console-v13.html#knowledge)。Agent/模型/Skills 评估：基线候选、结果、成本与推广审批。
- 现有实现与缺口：复用测试中心和证据；eval-set、样本指标、A/B 与盲评待实现。关联该需求 REQ/AC，后端契约未确认时只展示拟议字段/状态，不产生真实能力承诺。

## 跨页面必须保留的交互及状态

- 搜索、筛选、服务端分页、批量选择/确认、失败部分结果；切换筛选或项目时清除跨范围选择，真实刷新保留用户详情、滚动和编辑草稿。
- 任务身份：project/environment/workflow/run/attempt、candidate SHA、event source、最后更新时间、Trace 覆盖率和未知状态；不把日志当授权事实；不暴露隐藏推理、凭据或敏感数据。
- 独立测试：未执行、跳过、框架异常、断言失败、flaky 与通过区分；目标红绿相同断言和环境，新增失败阻塞；证据只读、旧 SHA 不放行。
- 交付：PR 已合并不等于上线，Jenkins 必须绑定 SHA；生产探测、实际版本、部署回执分别展示；丢失回执先核对、不得盲目重试。
- 需求/执行/飞书/发布授权各自有可信身份与版本；UI 不根据标签自动推导权限；危险动作明确范围/结果并需要确认。
- 失败、未知、数据陈旧、断连、空态、加载、无权、只读降级区分。无指标/无连接不显示虚假图表或成功。历史回放只读。

## 待评审与后续完善

首轮是整体高保真方向及页面骨架，尚需逐需求补齐二级详情、真实批量操作、DAG 缩放/布局及键盘节点操作、独立评估盲测、跨端与权限流程；以确认的 REQ/AC 和真实 API 作为下一版依据。不能把 14 个原型页面当成 19 项需求全部设计验收通过。已在本地 Chromium 使用页面内容渲染测试 14 个页面、主题切换、Trace 页签、任务搜索、详情抽屉、断连状态，未捕获 JS 运行错误；没有连接生产或执行真实业务测试。后续自动任务以 manifest 与有效人工决定去重，不为纯后端需求新出图。

## 代码依据

[控制台源码](https://github.com/Qd99/self-healing-agent-hub/tree/0bc418319f6287756bc13e7837dc2d907dac17a0/apps/console/public) · [现有 UI 指南](https://github.com/Qd99/self-healing-agent-hub/blob/0bc418319f6287756bc13e7837dc2d907dac17a0/docs/console-guide.md) · [管理 API](https://github.com/Qd99/self-healing-agent-hub/blob/0bc418319f6287756bc13e7837dc2d907dac17a0/docs/console-api.md) · [可靠性设计 V12](https://github.com/Qd99/self-healing-agent-hub/blob/0bc418319f6287756bc13e7837dc2d907dac17a0/docs/design/console-v12-reliability.md) · [Autoloop](https://github.com/Qd99/self-healing-agent-hub/tree/0bc418319f6287756bc13e7837dc2d907dac17a0/apps/agent-autoloop) · [PR #2](https://github.com/Qd99/self-healing-agent-hub/pull/2)
