# V20 D–G 工作区：开发交接与验收（第一批）

本批在 PR #23 的 A/B/C 集成基础上增量开发。不改变现有 API v1 的任务、审批、租约、核验与发布授权语义。不将读取结果、人工账本、观测事件或测试报告直接作为可信执行门禁。现有入口和 V20 入口复用同源管理认证。生产环境不得直接试运行修复或发布任务。

## 页面与配置

| 页面 hash | 功能 | 数据源 |
|---|---|---|
| #requirements | Issue/PR 正文及评论、按正文与默认分支 SHA 绑定三角色评审 | GitHub GET + 本地版本账本 |
| #trace | 任务、Worker 阶段、模型 usage、既有日志与审计 | 真实快照、内存观测缓冲 |
| #tests | 禅道用例、版本映射、测试计划、报告 | 禅道 GET + 本地版本账本 |
| #metrics | CPU / 内存 / 累计重启数、活动告警 | Grafana Prometheus datasource proxy |
| #knowledge | 知识候选及人工审核、成对评估样本 | 本地版本账本 |
| #radar | 来源、基线、适配决定、关联 Issue | 本地版本账本 |

基于隔离测试 worktree，Node 22 LTS：

    npm ci
    npm test
    npm run lint
    npm run typecheck
    npm run build
    export HOST=127.0.0.1
    export PORT=8787
    export HEALING_DATA_DIR="$(mktemp -d)"
    npm start

打开 http://127.0.0.1:8787/console-v20.html#requirements 等入口。外部集成默认不启用。凭据只由服务器运行环境注入，不写入 Git、前端、日志或导入 JSON。GitHub 只读 Token 使用 Issues、Pull requests、Contents 的 Read 权限；对公开仓库也可无 Token 查询，受限于上游速率。

| 环境变量 | 说明 |
|---|---|
| HUB_GITHUB_READ_ENABLED=1 | 启用当前项目仓库只读查询 |
| HUB_GITHUB_READ_TOKEN | 可选 GitHub 只读凭据 |
| HUB_ZENTAO_ENABLED=1 | 启用禅道只读查询 |
| HUB_ZENTAO_BASE_URL | 实际 HTTPS 禅道根 URL；仅回环支持 HTTP |
| HUB_ZENTAO_PRODUCT_ID | 固定产品正整数 ID |
| HUB_ZENTAO_TOKEN | 禅道 Token（不是用户名密码） |
| HUB_ZENTAO_API_VERSION | v1（默认）或 v2；按实际禅道版本验收 |
| GRAFANA_ALLOWED_ORIGINS | 复用现有 Grafana 允许来源配置 |
| GRAFANA_SERVICE_ACCOUNT_TOKEN | 复用现有 Grafana Token 配置 |

Grafana 的 URL、数据源 UID、名称、orgId、namespace 沿用现有监控配置；只查询已配置命名空间，预设时间窗 15m、1h、6h，拒绝任意 PromQL 和任意上游地址。告警是 Prometheus 当前活动告警，不推断告警已恢复。未采集、查询失败、无数据均不等于零。GitHub/禅道分页以实际接口响应为准，搜索限定当前已载入页；GitHub issue 页过滤 PR 后可能为空，不伪造全量总数。评论轮询约30秒；不是 webhook 推送。

上游接口参考：
- https://docs.github.com/en/rest/issues
- https://docs.github.com/en/rest/pulls/pulls
- https://prometheus.io/docs/prometheus/latest/querying/api/
- https://grafana.com/docs/grafana/latest/developers/http_api/data_source/
- 禅道具体版本以实际安装版 API 文档为准。

## TestRunner

只允许操作员在受信任、隔离且无生产凭据的 Git checkout 中执行。报告目标文件应在 checkout 外，且不存在。此脚本不是恶意代码沙箱，不执行浏览器传入的命令；套件 console / worker / all 选择 tests 下已有的 .test.mjs 文件。使用 Node 22。进程组超时或中断回收为尽力而为；不依赖它替代容器隔离或网络限制。

    npm run workbench:test -- --suite console --environment local-isolated --timeout 300 --out /tmp/hub-console-report.json

非零退出码也要保留报告。测试结果包含实际 Git HEAD、dirty 标志、环境、开始结束、退出码、用例元数据、耗时、状态和尝试序号。报告容量超过限制时显式记录 incomplete/error，不判通过。没有断言值、stdout、stderr、stack、模型上下文等原始内容；用例名称应由受信任代码提供，不得写入密钥。报告中用户可控信息不是可信签名。

测试中心 → 执行报告 → 新增记录 → 导入 JSON / 粘贴 JSON。test-run 使用 runId 自然键，不能覆盖已入账的执行结果；重复的相同内容幂等。pytest、JUnit、Playwright 可人工转换成同一 JSON 契约，但本批未交付这些框架的运行适配器和自动解析器。测试计划不自动调度，尚不支持禅道回写。

## 记录契约

GET /api/healing/workbench/records?kind=...&page=1&pageSize=20
可选 key、history=1，review 可选 issueNumber、contractHash、baselineSha。POST 同一地址，使用现有 manager 会话和 CSRF，body:

    {"kind":"knowledge","key":"example-key","expectedVersion":0,"payload":{...}}

以下是 schema 字段说明，不是已执行证据。具体严格枚举、大小及类型检查见 apps/healing-hub/src/workbench-records.mjs。SHA 为 40 小写十六进制，摘要为 64 小写十六进制；调用者须从真实基线/证据取得值，禁止随意编造。

| kind | 自然键 / 字段 |
|---|---|
| review | issueNumber + contractHash + baselineSha + role；verdict, note。保存前重新读取上游原文、开放状态及默认分支 SHA。截断或脱敏禁止提交当前评审 |
| case-map | productId + caseId + caseVersion；automatedId, requirementRef, note |
| test-plan | 操作者 key；name, environment, commitSha, cases [{productId,caseId,caseVersion,automatedId}], note |
| test-run | runId；framework, commitSha, environment, exitCode, dirty, startedAt, finishedAt, results [{id,name,result,durationMs,attempt,error}], planRef |
| knowledge | 操作者 key；title, statement, category, sourceRefs, baselineSha, status, reviewNote。先 candidate 后审核，禁止更改审核中的正文/来源/基线 |
| evaluation | 操作者 key；title, datasetDigest, policyDigest, baselineConfig, candidateConfig, samples [{caseId,trial,baseline,candidate,baselineLatencyMs,candidateLatencyMs}], note |
| radar | sourceUrl + sourceVersion；title, baselineSha, summary, decision, reason, issueNumber |

test-run 允许 node:test / junit / pytest / playwright；结果枚举 pass / fail / skip / error / timeout / cancelled / unknown。evaluation 导入成对结果，不执行模型实验、不自动晋升；知识审核不自动注入 Agent；雷达不自动创建或修改 Issue。记录的项目隔离为 project.id + repo，人工角色并不证明三位独立审查人。单管理身份沿用既有权限。旧版状态无 workbenchRecords 时可读取，新字段通过既有原子存储保存；先备份后验收，旧版写回新状态的兼容性须单独测试。限 1000 条历史记录、4 MiB，且保留任务存储容量；达到上限拒绝写入。

## 观测契约

Worker POST /api/healing/worker/tasks/:id/observe，沿用 Worker Token、有效租约、任务归属，事件仅接受 sequence, stage, state, durationMs, usage（model-usage 的 input/output/cached/total）。发送端尽力而为且不阻塞执行，服务器缓冲最多128个任务、每任务48条，按租约尝试+序号在窗口内去重。公开 attempt 为租约摘要，不返回原租约 ID。返回事件不是成功证据。缓冲重启清空，不是持久 OTel span store。完整 DAG、跨 Agent 链路、事件补偿与回放仍待开发。

## 真实环境验收

- 两个入口登录、原有任务/审批/CI 核验/设置/退出回归，V20 深浅色、不同宽度、无大字号 KPI。
- GitHub 正文/评论、分页、403/429/超时、跨仓库拒绝、正文与 SHA 变化后的评审冲突、历史记录、角色版本。
- 真实禅道 v1/v2 用例字段/分页/无权限；映射必须保留准确版本；报告导入、重复 runId、非零退出、dirty、超时、项目隔离。
- Worker 真实任务阶段及 usage、失联/重启/租约过期/乱序/重复、缓冲溢出、旧 Worker 不受影响；不存在的观测不得推导成功。
- Grafana 数据源 UID/类型/名称、namespace、实际采样、NaN、断连、允许来源、活动告警过滤；切换监控配置后拒绝旧响应。
- 知识候选审核、版本冲突、评估样本不完整、雷达来源去重；验证没有任何自动发布、Issue 写回、可信放行副作用。

本轮局部验证：临时 Git 仓库执行 TestRunner，通过/失败/跳过及超时场景，退出码 1/0/1 符合预期；报告未包含断言中的测试用敏感哨兵；两个脚本 Git blob 与提交一致。当前远端 workbench-model 纯函数七项定向断言通过。新增 tests/workbench-boundaries.test.mjs 七组回归已提交，尚未执行完整仓库测试；实际环境由用户验收。未部署、未合并 main、未关闭原需求。

## 后续完整性

D：独立身份评审、需求版本/审批/PR/评论同步、完整 OTel 与 DAG。
E：独立受控执行调度、pytest/JUnit/Playwright adapter、禅道结果回写、红绿差分门禁。
F：服务级性能、Worker/Jenkins 指标、持续采集、历史告警/静默/通知。
G：证据审核后的上下文注入、独立评估实验执行、成本/延迟/推广门禁、技术雷达自动调研与需求审批。
