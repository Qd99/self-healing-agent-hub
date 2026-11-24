# V20 高级工作区：部署与验收

## 1. 范围和默认安全状态

本批实现是 PR #23 的增量代码，不是生产验收。旧入口、原任务状态机、审批与 API v1 保留。高级工作区使用独立数据目录 `<Hub dataDir>/advanced`，默认关闭，不迁移或覆盖主任务存储。启用后如达到容量上限会拒绝写入，必须先归档；不得直接删除运行中的账本或锁。

- `HUB_ADVANCED_ENABLED=1`：总开关。
- `HUB_ADVANCED_PROFILES_JSON`：独立 Runner 生成的冻结策略 manifest；不能让业务 Agent 提供任意命令。
- `HUB_QA_RUNNER_TOKEN`、`HUB_OTLP_TOKEN`：分别使用独立随机凭据，至少 24 字符，与管理员及普通 Worker 凭据不同；只配置在相应服务端。
- `HUB_QA_EVIDENCE_HMAC`：Hub 独立签名密钥，至少 32 字符，与以上所有凭据不同；备份和轮换需保留历史证据验证策略。
- `HUB_QA_GATE_REQUIRED=1`、`HUB_QA_POLICY_DIGEST`：显式开启 v2 候选独立 QA 门禁，策略摘要来自实际 manifest。在完整测试前保持关闭。开启后缺证据、签名无效、配置或审批轮次改变均阻断。
- `HUB_METRICS_SAMPLING=1`：60 秒服务采样；`HUB_QUEUE_ALERT_COUNT` 可配置排队阈值。
- `HUB_KNOWLEDGE_INJECTION=1`：仅已审核且精确基线、项目匹配的知识注入。
- 外部写入另需独立开关与权限，不因总开关自动开启。

## 2. 独立执行器

使用隔离 QA 主机，Docker 和 Python 3，Node.js 22+。复制 configs/healing-advanced-runner.example.json 至仓库外的受信目录，配置真实 profile。初始 profiles 为空，不会执行任务。不要填写真实密钥到 JSON 或 Git。镜像需预拉取并固定 SHA256，独立测试 harness 必须由 QA 控制、位于镜像内且不执行候选提供的测试脚本或信任候选 stdout；原检查运行器网络隔离、限制资源并验证清理。候选源码仍是不可信输入，独立 harness 必须有真实反篡改验收。现有容器输出上限可能使大报告进入 incomplete；不得把截断当成功。

示例 profile（占位值不可直接验收）：

```json
{
  "id": "qa-red-green",
  "kind": "red-green",
  "projectRepo": "Qd99/self-healing-agent-hub",
  "repository": "/srv/qa/repository",
  "candidateRef": "refs/heads/qa-candidate",
  "adapter": "junit",
  "image": "registry.example.invalid/qa@sha256:<真实镜像摘要>",
  "argv": ["/opt/qa/run-report"],
  "environment": "qa-isolated",
  "caseIds": ["<实际解析出的稳定用例ID>"],
  "targetCase": "<目标用例ID>",
  "protectedPaths": ["tests", "package.json"],
  "intervalMs": 0,
  "leaseMs": 900000
}
```

普通 test 使用 ref（推荐精确 SHA），不需要 targetCase；可设 intervalMs >=300000。red-green 必须由操作员关联 v2 候选，QA 主机须已拥有候选 Git 对象和基线，候选父提交、tree 必须一致；本批未自动传递候选产物。执行前后校验干净工作区，比较冻结测试路径的 git tree；建议保护所有测试、依赖锁、runner config 与 harness 相关路径。固定独立 harness 输出 pytest/JUnit XML 或 Playwright JSON 到 stdout（仅元数据报告；如使用外部文件转换，由可信 wrapper 执行）。Node reporter 不证明失败是断言，因此不能独自作为红证据。明确区分报告完整性、测试失败、异常、跳过、未知。Python XML parser 不接受 DTD/entity。

```bash
node scripts/advanced-runner.mjs --config /secure/qa-runner.json --print-profiles
# 将上面的 JSON manifest 安全注入 Hub 的 HUB_ADVANCED_PROFILES_JSON
npm run workbench:advanced -- --config /secure/qa-runner.json --once
# 不带 --once 则持续领取；定时作业仅在 Runner 领取时生成当前时间桶
```

取消请求由 Runner 轮询，先证明清理再回执。租约过期或回执不确定进入 unknown，不盲目重跑。Runner 的 outbox 和 active journal 可能保留；停止进程后先核对 Hub 状态与 Docker 资源，再处理 journal。不要直接重放不确定外部动作。

## 3. OTLP、Trace 与回放

HTTP JSON POST `/api/healing/advanced/otlp/v1/traces`，Authorization Bearer = 独立 OTLP Token。当前支持 OTLP JSON resourceSpans / scopeSpans / spans，必须含 span 属性 hub.workflow_id；可含 hub.task_id（必须属于当前项目）、hub.agent_id、hub.stage。traceId 32 位十六进制、spanId/parentSpanId 16 位十六进制，使用实际 span links。仅保存受控元数据，不保存模型隐藏推理、原始提示词、凭据或完整日志。

持久游标去重，按 workflow 或 task 查询，最多每页 200 事件；DAG 父边和跨 Trace link 分开，缺边、环、截断为 partial。回放是游标切片，不执行任何任务。当前不是完整 OTLP Collector：不接 gRPC/protobuf/gzip；Autoloop 原生 SSE 尚未桥接，须由真实 Agent instrumentation/适配器按约定上报，不能将 Worker 的阶段事件推断为跨 Agent span。

## 4. 禅道、评估、技术雷达

禅道 v1：保留已有读取配置，显式设置 HUB_ZENTAO_WRITE_ENABLED=1、HUB_ZENTAO_WRITE_TOKEN、HUB_ZENTAO_TESTTASK_ID、HUB_ZENTAO_WRITE_CASE_IDS（逗号分隔）及正确产品/版本。独立 QA 用例 ID 与禅道映射一致。仅单步骤 case 自动回写；不推断多步骤结果。接口接受后标 submitted-unverified，由实际测试单核对。Bug 关联只针对已存在且属于相同产品的 Bug，复验须同一用例版本且不同修复提交；不自动创建或关闭 Bug。

模型评估 profile kind=evaluation，配置 cases（id/input/expected）、trials、maxCalls、maxOutputTokens、maxObservedTokens、maxObservedMicros、baseline/candidate。每个模型配置 endpoint、model、tokenEnv、inputMicrosPerMillion、outputMicrosPerMillion（USD 的百万分之一/百万 token）。使用受控测试集，精确文本断言，仅保存元数据；费用为估算，observed budget 是观测停止阈值，不保证单次请求绝不超额。不能以此替代独立 rubric 或盲测，未实现任意 Agent/Skill 沙箱评估或自动推广。

技术雷达 profile kind=radar，配置 sources: [{repo, keyword, paths:[{external,local}]}]，可选 HUB_GITHUB_RESEARCH_TOKEN。自动读取固定 GitHub 仓库与代码树、扫描当前项目历史 Issue/PR，产生路径级差异候选；未完成分页不准登记。不是完整语义差异或多站点发现。登记须 HUB_RADAR_REGISTER_ENABLED=1、HUB_GITHUB_ISSUE_WRITE_TOKEN、明确人工确认 REQ/AC/TC/影响，重新核对基线和查重，每 UTC 日最多一次，未知结果不重发。登记只产生待评审需求。

## 5. UI 入口与验收

V20 新增页签：全链路「持久 Trace / DAG」；测试「独立执行 / 质量门禁 / 禅道回写」；监控「服务性能 / 告警历史」；知识「独立评估」；雷达「自动调研」。服务采样显示 Hub 累计请求/CPU/RSS/P95，Worker 有实际任务时的资源，Jenkins 配置 Job 的队列/最近构建；非全 Jenkins 节点监控，历史为 Hub 观察到的转换，并非完整 Alertmanager 历史。

验收顺序：
1. 保持全部开关关闭，运行 npm ci、npm test、npm run typecheck、npm run lint、npm run build；旧接口/登录/审批/任务/PR #2 闭环回归。
2. 单独运行 node --test tests/advanced-workbench.test.mjs，验证持久化、重新打开、跨项目、重复事件、租约、证据、取消与回写预约。
3. 独立 QA 主机运行真实 pytest/JUnit/Playwright 正常、断言失败、skip、异常、重试、超时；检查容器清理与重启，核验 SHA/Tree/测试源指纹。
4. 启用 QA gate，在授权环境验证未通过证据拒绝审批/领取/发布，正确证据放行，换轮次/候选/策略即失效。
5. 非生产禅道验证实际产品、测试单、用例版本、单步骤执行结果与 Bug 关联/复验；制造网络中断，核对 unknown 无重复 POST。
6. 两个 Agent 实际发 OTLP，有明确 parent/link；检查 DAG 缺边、乱序、回放、重启与鉴权；采样 Worker/Jenkins 断线、告警恢复，确认未知不当成功。
7. 实际评估模型样本、成本费率和预算；技术雷达验证真实仓库树、历史需求查重和待评审 Issue 登记；知识注入验证未审批、过期、不同 SHA 或项目均被排除。
8. 浏览器逐页截图/真实数据检查，确认筛选、分页、图表点击、详情、权限、断线和空态；未经上述验收不合并 main。

本轮局部运行记录：从当前远端 advanced-model.mjs 源码隔离执行 15 项纯逻辑断言通过（不使用真实加密、文件存储或网络）；实际 Python 3.13.5 执行 scripts/advanced-junit.py 的 7 组解析检查通过，本地 Git blob 225c0c632d483ef75c764200bc173f162bd9ac06 与远端一致。新增正式 Node 回归文件仍须在实际完整仓库运行。本环境缺少 Docker，不能声称真实外部联调或全量回归通过。
