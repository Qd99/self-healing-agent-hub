# Jenkins 修复 Worker 运行指南

第二阶段提供一个可启动的独立 Worker：读取 Hub 中经过验证的 Jenkins 失败来源，在隔离 Git 工作区复现、生成并检查候选，经过两级审批后发布同仓库 Draft PR。Hub 通过独立读取凭据核验 PR 和 CI。支持范围是单仓库、单普通分支 Jenkins Git-plugin job、`ci-failure → create-pr`。

## 1. 准备运行条件

- Linux、Node.js 20.3+、Git、Docker，以及预先拉取的可信检查镜像。镜像使用完整 `name@sha256:...`；示例中的全零 digest 必须替换。
- 一个由部署者同步的本地可信 Git 仓库或 mirror，包含失败构建的精确提交。Worker 从该路径建立独立 checkout，不从任务携带的 URL 获取代码。
- 一个 OpenAI 兼容 Chat Completions HTTP 服务，支持 `response_format: {type: "json_object"}`。配置 endpoint 为完整聊天路径。
- Jenkins 构建读取凭据、Worker 访问 Hub 的独立令牌、GitHub 发布凭据和 Hub 独立核验的读取凭据。通过环境注入，配置文件只记录环境变量名。

Worker Git/检查进程使用受限环境，外部 Git 和 Docker 可执行文件需位于 `/usr/local/bin:/usr/bin:/bin`。凭据只用于相应 HTTP 客户端；检查容器不挂载 Worker 数据目录或凭据。

## 2. 配置 Hub 来源与路由

复制 `configs/healing-integrations.example.json` 为 `configs/healing-integrations.json`，编辑两个配置块。此文件缺失时集成禁用；配置完成只证明可用配置已加载，连通性以实际请求为准。

| 字段                          | 要求                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| `jenkins.enabled`             | 配置确认后显式设为 `true`                                                   |
| `sourceId` / `generation`     | 来源身份和配置代次；来源重建或构建编号语义改变时使用新代次                  |
| `baseUrl`                     | 固定 Jenkins 根地址；默认 HTTPS，私网 HTTP 需显式 `allowHttp:true`          |
| `jobSegments`                 | job 路径分段，例如 `["team","main-tests"]` 对应 `/job/team/job/main-tests/` |
| `repo` / `branch`             | 必须与 `healing-config.json` 的项目一致，也与 Worker 配置一致               |
| `scmBranch`                   | Git plugin 的精确分支键，例如 `origin/main`                                 |
| `scmRemoteUrls`               | SCM remote URL 别名白名单，必须与实际 BuildData 相符                        |
| `usernameEnv` / `tokenEnv`    | Jenkins 读取凭据的环境变量名；需要认证时成对配置                            |
| `githubVerification.enabled`  | 显式启用独立读取核验                                                        |
| `githubVerification.tokenEnv` | Hub 独立只读 GitHub 凭据的环境变量名                                        |
| `requiredStatusContexts`      | 至少一个精确 Commit Status context，例如 `ci/jenkins/tests`                 |
| `trustedStatusCreators`       | 可信状态发布者的精确 login，GitHub App bot 包含 `[bot]` 后缀                |

Jenkins 构建必须已经结束且失败。适配器要求唯一 Git BuildData、当前 buildNumber、单一指定分支，以及一致的 revision/marked/lastBuiltRevision SHA。多 SCM、历史分支条目、合成 merge、缺少精确来源的 job 会被拒绝；不会猜测当前分支 tip。当前不采集 console 日志。

在 `healing-rules.json` 中添加 `configs/healing-rules.worker.example.json` 中的专用 `ci-failure → create-pr` 规则，并放在会匹配同一任务的普通 retry 规则之前。保留现有其他规则，核对工作台当前启用的规则；不要把原 retry 动作直接视为代码写入授权。

`healing-config.json` 的 `safety.requiredChecks` 必须与 Worker `checks.commands` 的键完全对应。保护路径应包含 CI 定义、测试断言及任何不允许模型修改的文件。每个来源任务冻结其安全规则和 CI policy；已有任务的重试继承来源仓库、分支和核验 policy。更改 policy 后需导入新的来源任务。

## 3. 配置 Worker 与检查镜像

复制 `configs/healing-worker.example.json` 为 `configs/healing-worker.json`。关键关系如下：

| 字段                             | 用途                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| `hub.url`                        | Hub origin，例如 `http://127.0.0.1:8787`；客户端自行追加 `/api/healing`   |
| `workerId` / `engineId`          | 稳定 Worker 身份与 Hub 路由引擎，默认引擎 `fast`                          |
| `dataDir`                        | 私有持久目录，保存候选、ACK、发布意图和回执 outbox                        |
| `repository.fullName` / `branch` | 必须与 Hub 来源和任务完全一致                                             |
| `repository.localPath`           | 含精确失败 SHA 的可信本地仓库/mirror                                      |
| `model.endpoint` / `model`       | 完整 Chat Completions URL 与部署模型名                                    |
| `model.contextPaths`             | 显式上下文文件，最多 20 个，总计不超过 128 KiB                            |
| `checks.image`                   | 已准备的可信镜像 digest，Worker 不自动拉取                                |
| `checks.commands`                | 可信检查名到 argv 数组的映射，例如 `"npm run test": ["npm","run","test"]` |
| `publish.enabled`                | 默认 `false`，只诊断；设为 `true` 才领取已批准执行阶段                    |

配置中的相对路径以配置文件所在目录解析。Hub 和 Worker 示例端口默认为 `8787`，部署到其他端口时同步调整 `hub.url`。同一 `dataDir` 仅允许一个 Worker 进程；重启保持相同 workerId、engineId、repo、branch，以及 Hub Worker 凭据身份。数据目录权限 `0700`，journal 文件 `0600`。

检查命令来自部署者的 argv 注册表，模型只能返回结构化文件替换，不能提供 shell 命令、工具调用或检查通过声明。Docker 使用无网络、只读根文件系统、降权能力、CPU/内存/PID 限额和临时目录；`.git` 只读。检查前后比较 Git 元数据与全部 checkout 文件，**任何修改都拒绝，包括依赖安装、覆盖率文件和测试报告**。应在镜像内准备依赖，将缓存/临时输出安排在容器 `/tmp`，使 checkout 保持只读行为。

工作区快照上限为 50,000 个条目、256 MiB，候选 patch 不超过 512 KiB，并继续服从 Hub 的文件、行数和 1 MiB 请求限制。首版支持 UTF-8 普通文件，不支持 symlink、submodule、二进制修改、rename 或模式改变。

上下文和候选修改共用不可关闭的敏感路径拦截，按路径分段、不区分大小写匹配：`.env`/`.env.*`/`*.env`/`*.env.*`；`credential(s)`、`secret(s)` 及其带扩展名形式；`.aws/.ssh/.azure/.kube/.gnupg/.docker`、`.config/gcloud`；`.npmrc/.pypirc/.netrc/_netrc/.git-credentials/.boto`；常用 `id_rsa/id_dsa/id_ecdsa/id_ed25519` 前缀；`.pem/.key/.p12/.pfx/.jks/.keystore/.kdbx` 后缀；`service-account` 或 `service_account` JSON。示例/模板文件和公钥若匹配也会拒绝。该策略按路径识别，并非通用内容密钥扫描；部署者仍应在 `safety.protectedPaths` 中补齐项目专属敏感路径。

候选还校验待发布文件的原始字节与暂存 Git blob 完全一致。若仓库的 CRLF、`working-tree-encoding` 等属性造成被检查的字节与批准的 tree 不同，会明确拒绝该候选；不会静默转换发布内容。普通 UTF-8 BOM、无末尾换行和既有 executable 位会保留。

## 4. 启动与操作

在环境中提供配置引用的令牌后执行：

```bash
npm run worker -- --config configs/healing-worker.json --check-config
npm run worker -- --config configs/healing-worker.json --once
# 持续轮询：
npm run worker -- --config configs/healing-worker.json
```

`--check-config` 返回经过白名单处理的配置状态，明确 `remoteConnectivityChecked:false`；它不会检查 Docker 镜像、真实仓库 SHA 或远端权限。`--once` 执行一次领取/恢复周期；连续模式默认每 5 秒轮询，每 15 秒续租。

操作顺序：

1. 在「全部任务 → 导入 CI」输入构建编号。来源由服务配置提供，界面不能任意输入 URL。重复导入返回已有原始任务；已完成的非失败构建显示忽略原因。
2. Worker 读取远端基线，按失败 SHA 建立隔离 checkout，先运行基线检查。未复现失败就停止。复现后请求模型，运行候选全部必需检查，提交 v2 候选。
3. 在任务详情查看来源、diff、检查证据和候选 hash。依次通过「代码审阅」「执行授权」。审批前不会发布；`publish.enabled:false` 时审批后也不会领取执行阶段。
4. 部署者确认发布配置后启用 `publish.enabled:true` 并重启 Worker。Worker 重放保存的 patch、重跑检查、核对候选 hash/tree 和当前基线。候选损坏或基线移动即停止，不重新生成/rebase。
5. 发布到确定性 `heal/<task UUID>` 分支，创建带任务/候选身份的同仓库 Draft PR，记录实际 commit/PR/files。没有自动 merge、force push 或部署。
6. 点击详情「核验 PR / CI」。Hub 独立读取 PR 身份、修复 commit 唯一父节点与 tree、完整文件分页、所需 Commit Status 的最新状态及可信 creator，最后再读 PR 检查漂移。

「PR 已创建」与「CI 核验通过」分别展示。CI 尚未产生是 pending，失败是 failed，目标/身份不符是 mismatch，读取异常是 error，后续回执使证据失效是 stale。核验不会改写 Worker 结果，也不会自动解除「待核对」。第一版只读 Commit Status API，不将任意 Check Run 当作所需 context。

## 5. 中断恢复与故障处理

| 情形                         | 行为与处理                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| 提案/结果响应丢失            | journal 保留完全相同的请求，重启先幂等重放；不会重新生成候选                    |
| 提案在取消期间返回明确拒绝   | 保存取消回执并确认停止；响应不明确时保留原请求，重放确认后再决定终态            |
| PR 创建响应不明确            | 根据确定性分支、任务标记、parent/tree/head 查询已有事实；不盲目再次 POST        |
| 执行中进程中断               | 重启只读恢复既有发布事实，补录失败/中断回执，进入人工核对；旧租约不授权继续写入 |
| 取消或续租失败               | 中止模型/检查，等待清理后回传停止事实；已经发生的外部产物仍保留                 |
| 基线移动                     | `BASE_MOVED`，停止发布，导入新失败来源或核对后按业务决定重试                    |
| 检查不可启动/失败/改写工作区 | 停止并报告失败；确认 Docker、镜像、注册命令和只读检查行为                       |
| 保存候选缺失或被改动         | 停止发布，恢复正确私有数据或人工处理；不会生成另一候选套用旧审批                |
| 外部结果不确定               | `PUBLICATION_UNCERTAIN`，禁止自动重试，由管理者核对实际分支/PR/CI               |
| journal/身份/锁异常          | 进程停止；先确认没有另一个存活 Worker，保留数据并人工检查，再恢复               |

不要删除 journal 来跳过候选、审批或外部结果核对。远端 GitHub 与本地文件不构成分布式事务；提案被明确拒绝时会转为失败或取消回执；仍无法确认的提案请求、无法获得确认的终态回执会阻塞后续领取，需要保留记录人工排查。单进程文件存储适用于当前首版；高可用、多副本、队列归档仍属后续工作。

## 验收范围

开发联调详见 [第二阶段验收记录](design/console-v13-worker.md)。生产首次运行还需对真实 Jenkins BuildData、精确失败 SHA、可信镜像、模型响应格式、两个审批节点、PR 写权限和 CI context/creator 做一次受控闭环。开发测试夹具不能代替这次验收。
