# V20 兼容迁移 · 第一阶段 A（待评审）

基线 main: `0bc418319f6287756bc13e7837dc2d907dac17a0`。关联设计 PR #22（历史 V13），Jenkins Worker PR #2（未合并）。本提交是实际代码中的可选表现层，不是直接部署离线 V20 原型。只调整现有页面的视觉系统及布局；不宣称实现全部 14 个 V20 页面。

## 预览与回滚

- 原入口 `/` 不变；新入口 `/console-v20.html`（同源服务根路径）与原入口共用 `app.js`、控制器、API Client 和服务端存储。
- 在隔离开发/测试环境执行 `npm ci`、`npm start`，打开 `http://127.0.0.1:8787/console-v20.html`。若实际端口不同，以启动日志为准。
- 默认 live，不会自动注入样例。显式 `?demo=1` 仅用于本地视觉检查；真实接口验收必须使用隔离的 live 测试数据。
- 返回旧入口即可回退表现层；不改变任何数据结构、审批记录、会话或 Worker 协议。不要将此路径直接映射到当前线上 Autoloop 的 /console，需先核实部署与反向代理归属。
- 新 CSS 仅由新入口加载且限定在 data-console-ui=v20；保留主题、响应式和现有交互语义。

## 本阶段范围

共享设计 token、导航和页面标题、紧凑指标条（不使用大 KPI 数字）、工作台趋势主区、任务和审计表格的视觉密度、审批摘要、设置/执行引擎与监控界面的基础材质。现有按钮、状态、筛选、分页、审批门禁、异常状态和数据来源保持原样。

- 保留现有真实页面和功能：工作台、任务、审批、监控配置、操作记录、执行引擎、路由规则、安全策略、连接设置。
- 不修改 API Version 1、URL、请求/响应、CSRF、会话、幂等 requestId、expectedRevision、expectedConfigRevision、capabilities、核对及只读状态。
- 不新增模拟数据、不改变任务阶段、无新增网络请求。Grafana 指标、真实 Jenkins 数据、禅道、GitHub 实时讨论、完整 Trace、知识/评估等仍按各 Issue 的实际后端能力另行交付，不能把 V20 设计样例写入生产。

## 合并门禁（未执行的必须标为待验收）

- `node --test tests/console-v20-presentation.test.mjs tests/console-v20-server.test.mjs`：入口等价、同源资产、鉴权、快照读取无副作用。
- `npm test`、`npm run lint`、`npm run typecheck`、`npm run build`、`git diff --check`：以最终提交运行，基线失败须隔离比对。
- Playwright/实际浏览器：两入口同一隔离服务对比；1280/1440/1920、窄屏、深色、键盘焦点和 reduced-motion；登录/退出、任务创建/取消/重试/批量、审批冲突、配置保存/连接检查、审计导出，核对请求方法/路径/参数/结果一致。
- 检查 CSS 是否遮挡操作、长标题/大数据、抽屉、空态/断线/只读、状态标签与图表下钻；禁止通过固定高度、隐藏关键控件或假数据实现视觉效果。
- PR #2 集成时以其实际最终 head 与更新后的 main 重跑全部门禁。本阶段不修改它的公共业务文件、不合并任何 PR、不触发生产部署。
- 下一阶段 B：将 V20 现有页面进一步按真实 ViewModel 迁移为独立工作区，并补充浏览器视觉/操作验收。新增页面/接口单独按 REQ/AC 审批和开发，不以视觉稿直接授权。


## 阶段 B · 实际业务视图迁移（待评审）

- 工作台：趋势及最近任务为主区，待处理侧栏、状态分布与辅助报表；保留现有周期和图表下钻。
- 任务：服务端记录进度、阶段、消息、租约 Worker、快照时间；已回传 Trace 标为历史；原有筛选、排序、跨页批量、详情和核对逻辑不变。心跳只续租，不支持逐工具实时流。
- 审批：候选标识/哈希、提交时间、候选检查记录与详情跳转；仍用原有审批节点、审批表单与版本校验。
- 执行器：引擎状态、真实任务分配及租约、模型配置与路由关联；当前 API 不提供独立 Worker 清单/CPU/内存或心跳时间，明确标注。
- 操作记录：统一搜索、分页组件，V20 增加每页 10/15/20/50；保留所有匹配记录导出与原分页默认 15。筛选、选页、切换条数及刷新均复用现有 controller。
- 设置：连接配置和状态不变，增加项目/API/快照上下文。V20 顶栏提供返回旧入口。
- API Client、服务端、Worker 和存储保持基线；app.js 仅新增 presentation 开关；审计 controller/model 仅调整客户端分页；共用 uiStatus、uiSearch、原详情与批量对话框。

新增 `tests/console-v20-workspaces.test.mjs`：进度边界、历史 Trace、断线、租约过期、待核对、XSS、共享分页及视图选择。实际 Node/HTTP/浏览器门禁仍须在可执行环境按最终 SHA 运行。不能把静态代码检查、V20 离线设计稿或样例渲染作为真实生产验收。


### 阶段 B 源码核查记录

基于实现提交 `cf8a12d332e1a60a7bf492218f4cf60a50a94a65`：直接读取远端实际源码，在受限 V8 执行环境中对 ES module 做静态 import/export 绑定，并为纯 JSON 演示夹具提供 structuredClone 兼容实现；非浏览器、非 Node 完整测试。6 组执行投影/分页/转义检查、15 组真实视图渲染与操作标识检查、4 组审计 controller 和批量确认检查均通过。最初一组渲染因该环境缺少 structuredClone 未执行，补充夹具兼容层后通过。新增正式 Node 测试含 controller/批量回归，但本轮未运行 Node 测试文件。GitHub tarball 与 git clone 在当前环境不可获取。最终合并必须使用实际 Node/HTTP/浏览器和 Jenkins 结果，不得以本记录替代。

与 #2 当前 head `1aa13919634eb7411236b4993ce5c90626973772` 的文件交集为 app.js 与 views.js；其任务详情段不同，需要在集成基线上进行三方合并、检查 CI 相关新增入口/控制器并重跑回归。没有进行该 PR 的合并或部署。


## 阶段 C · PR #2 代码集成与 Jenkins 工作区

用户决定真实环境验收由自己完成，解除开发阶段阻塞，不解除发布门禁。合并提交 `efe9ef2cc746a3e4b96ac29c6c478fde5f8f7ef5` 的双父为 PR #23 `8012ee9871ac1397b757caa6b8e920fe4ef3a0d9` 和 PR #2 `1aa13919634eb7411236b4993ce5c90626973772`；共同祖先 `051b8e3b3377c0867d04c0c896fa33f3ccbd6fa4`。三方合并处理 README、app.js、views.js；保留实际 Worker、Hub 服务、共享候选协议和恢复处理。应用级入口同时保留 V20 与 CI controller、构建来源、候选证据、核验结果、原任务与两级审批。已核对 264 个 Autoloop blob 与 26 个 PR #2 Worker/Hub/框架 blob 均未被覆盖。

- Jenkins 独立工作区在两个 UI 入口可用。已导入失败构建、源 Job、提交、修复任务、核验状态分布、搜索、筛选、分页及详情联动全部来自快照。未读取 Jenkins 全量 Job、Stage、队列或执行器，不能当实时 Jenkins 监控。
- 导入仍只允许配置来源与正整数构建号；核验仍只允许任务 revision。继续用原 mutation guard、CSRF、幂等、候选/租约及权限检查。没有新增外部写接口或自动执行授权。
- 配置状态与实际连通性分离。设置页显示 Jenkins 与 GitHub 核验已配置/未配置；无凭据数据。示例集成及 publish 默认关闭。
- 根 npm workspace 排除内嵌独立 Autoloop，保留其自己的 lockfile、Node 24+ 和 TypeScript 版本；根 ESLint 排除该独立项目，不代表它已通过 lint/test。Hub 根 package-lock 仅同步 workspace 声明。

### 本地可核实证据（非真实环境验收）

- Node v22.16.0 执行 `node --test tests/console-api-client.test.mjs tests/console-v20-runtime-boundaries.test.mjs`：16 通过、0 失败、0 跳过。实际远端源码/测试的 6 个 Git blob SHA 与本地副本逐一一致（含 PR #2 API Client 新增导入和核验契约）。
- 对 `f7a68b7244ac43925de955a1383ce8b120f354bd` 的实际代码进行隔离 V8 验证：Jenkins 投影、分页/图表、只读与转义、CI 核验状态、导入与核验 guard、筛选 reset 共 6 组通过；完整 Jenkins 视图测试文件 4 组通过，其中只绑定实际相关模块，未使用的无关页面导入为抛错占位，非 Node/浏览器测试。URL API 在该执行器缺失，链接正向场景未执行；从真实源码摘取的 safeExternal/commitLink 在 Node URL 上完成 11 项断言，不能代替完整 CI UI 测试。
- 全仓库 `npm ci/test/lint/typecheck/build`、Hub/Worker 集成、浏览器和实际外部环境由用户运行。新加 app 并发/交互测试已提交、未执行。不得把上述局部检查作为合并成功状态。

实际验收见 [V20 + Jenkins 交接清单](console-v20-jenkins-handoff.md)。后续独立需求（GitHub Issue/PR 需求账本、完整 AI 实时 Trace、禅道 TestRunner、Grafana/Prometheus 指标与告警、知识评估、技术雷达等）当前不在本次既有页面与 PR #2 集成的完成范围内，不能将设计样例误当生产实现。
