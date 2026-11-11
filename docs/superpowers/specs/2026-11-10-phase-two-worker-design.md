# 第二阶段：Jenkins 失败到修复 PR 与独立 CI 核验

## 目标与实施决定

用户已授权第二阶段：一个真实 Jenkins 失败来源、准确失败提交、一个可启动 Worker、独立工作区、候选审批、修复 PR、查询 CI。第一阶段已合并；基线 main `051b8e3b3377c0867d04c0c896fa33f3ccbd6fa4`，tree `11653d8568476e6b10f4eae03de3667c976a149e`。2026-11-10 开发环境中断并恢复到更早快照，上一轮第二阶段本地改动未恢复；依据保留的契约重建，所有验收重新执行。

继续采用 Node ESM、原生 UI、文件存储与现有租约协议，不把仓库执行放进 Hub。独立 Worker 使用 OpenAI 兼容 Chat Completions HTTP 返回结构化文件替换；模型无 shell/GitHub 工具。部署方配置可信 Docker 镜像 digest 和 argv 注册表。首版支持单配置仓库、单 Jenkins 普通分支 Git-plugin job，仅 `ci-failure → create-pr`。不扩展通用编排、调度或多模型平台。

## 全局约束

- 保留 v1 任务、原哈希、客户端、审批、历史及回执；不要把原有 retry 路由改成代码授权。
- 发布默认关闭；启用后仍需同一批准候选及有效 execute 租约。无 merge、force push、部署、回滚、CI 配置或 status/check 写入。
- 不调用 Jenkins/Actions build、dispatch、retry API；未来分支/PR 发布可能运行仓库既有 CI，不能承诺绝不运行 CI。本次开发仅操作测试夹具，不创建真实业务修复 PR。
- 所有远端 I/O 在 Hub 存储事务外；短事务进行原子导入去重和核验 CAS。秘密、原始响应、私有 lease 不投影到管理快照。
- 固定失败 base SHA、完整 Git patch SHA256、tree SHA；base 漂移、产物缺失/篡改时停止，不重新生成或 rebase。
- 不新增 npm 依赖。生产检查仅 Docker，不存在时明确失败，不自动回退宿主执行。测试可注入受控本地检查，须明确不等于真实 Docker 验收。
- UI 沿用统一组件、中文反馈；PR 创建与 CI 独立核验是不同事实。无新侧栏模块。
- 需要真实 Jenkins/模型/GitHub 运行凭据、Docker 镜像及目标失败构建才可做生产验收；开发完成不等于生产闭环已验收。

## A. Hub 来源、候选和核验

### Jenkins 来源

可选配置 `configs/healing-integrations.json`，缺少则禁用，秘密仅 env 引用。

```js
{
 jenkins: {enabled,sourceId,generation,baseUrl,jobSegments,repo,branch,scmBranch,scmRemoteUrls,usernameEnv,tokenEnv,allowHttp?},
 githubVerification: {enabled,tokenEnv,requiredStatusContexts,trustedStatusCreators}
}
```

HTTPS 默认，私有 HTTP 显式 allowHttp。无 userinfo、跳转、任务输入 URL；jobSegments 为普通 job 路径。管理 POST `/api/healing/integrations/jenkins/builds` `{sourceId,buildNumber,requestId?}`，管理身份+CSRF，Worker 拒绝。返回 `{snapshot,taskId?,outcome:"created"|"duplicate"|"ignored",message}`。sourceId 不匹配先拒绝，不调用远端。

仅接受 number 匹配、building:false、result:FAILURE。运行中409，已完成非失败 ignored；来源不支持422 SCM_PROVENANCE_UNSUPPORTED。要求唯一 hudson.plugins.git.util.BuildData、remoteUrls 与配置别名一致、buildsByBranchName[scmBranch].buildNumber 等于本次 buildNumber、revision.SHA1 为40hex；revision/marked/lastBuiltRevision 的 SHA 和单一 branch 均一致。拒绝历史条目、多 SCM、合成 merge、缺失/歧义。不能用 changeSet/当前tip猜失败提交，不采集原始 console 日志。

任务 `task.payload.context` 保存 commitSha、ciJobUrl、retryCount/retryOf，以及白名单来源：

```js
source: {kind:"jenkins",sourceId,eventId,generation,jobName,buildNumber,buildUrl,repo,branch,commitSha,result:"FAILURE",observedAt}
```

eventId = SHA256 配置 baseUrl/jobSegments/generation/buildNumber。来源与项目 repo/branch 一致；创建、公开投影、claim、retry、restart/validation 保留。重试复制原仓库/分支/来源及冻结 CI policy，不能因项目配置变化重定向。内部 trustedSource 不能被 manual trigger 请求伪造。去重原子，跨身份与重启；只匹配原始非 retry 任务，同事件 immutable repo/branch/SHA 变化冲突。沿用 MAX_TASKS10000，不新增无界事件表。

快照：`integrations.jenkins:{configured,sourceId?,jobName?,branch?,message}`、`integrations.verification:{configured,requiredStatusContexts,message}`；capabilities.importCi/verifyResult，只读时false。configured只表示配置，不表示已连接。

工厂注入接口：createHealingService / createConsoleServer 的 `{integrationsConfig,integrationsFetch,integrationsEnv}`。前者为上述原始配置，fetch 为标准 fetch(url,init)->Response，env 为映射；不传 config 时读可选文件。

### v2 候选与租约协议

共享 `packages/framework/src/candidate.mjs` 由 A 尽早独立提交：

```js
hashCandidateV2({ task, action, summary, candidate, diff, evidence });
repairBranchFor(taskId); // "heal/" + validated UUID
```

task 为 claim.task.task 的原始 HealingTask，repo/branch 在 payload，source/commitSha 在 payload.context。稳定 canonical JSON 对象键排序、数组顺序保留，SHA256绑定 task.id/repo/branch/source/commitSha、不可变路由action、summary、candidate、完整diff、规范化evidence（beforeState/afterState 缺省null，testsRun/checksPass/checksFail 缺省[]）。v1 原 `SHA256(JSON.stringify({diff,evidence}))` 不变。

proposal新增 submissionId 与 `{version:2,baseCommitSha,patchSha256,treeSha,artifactId}`，base为来源40hex，patch64hex，tree40hex，artifactId等于patch。仅固定Jenkins来源create-pr可用。公开 proposal `{id,version:2,contentHash,candidate,...}`。ACK `{taskId,proposal:{id,version,contentHash,candidate},message}`，无管理snapshot。相同真实actor/lease/submissionId/内容可在释放lease后重放，冲突拒绝。私有提交fingerprint、worker/actor不公开；归属从实际lease取，不信body遗漏/伪造的workerId。

claim 可选 actions/sourceKinds/candidateVersions/phases。新Worker固定 create-pr/jenkins/[2]；发布关闭phases:[diagnose]。Jenkins diagnose、v2 execute只给声明v2的Worker；execute与候选workerId和actorId绑定。v2 complete和带result的cancelled顶层proposalId/contentHash必须匹配批准项。成功pr-created必须commit+pr及精确文件清单。原v1回执保持兼容。

### 独立核验

管理 POST `/api/healing/tasks/:id/verification` body仅 `{expectedRevision}`，Worker拒绝。从 accepted receipt 和冻结proposal取目标，不接受客户端URL/SHA/成功标志。返回 `{snapshot,verification?,message}`。

冻结策略：至少一个无重复非空 requiredStatusContexts，至少一个精确 GitHub creator login（bot包含[bot]）trustedStatusCreators；排序并计算policyHash，import时保存，retry继承完整策略及hash；空/不完整策略永远不能passed。只支持显式 Commit Status context，不以任意 CheckRun 代替。独立只读安装token，固定api.github.com，API version2026-03-10。

逐项验证 PR exact repo/base/head/ref、open且未merged，commit唯一parent=base且tree=approved tree，完整PR files=批准diff，精确repair SHA上每个required context的最新状态且creator可信；最后再读PR防head/base移动。缺CI pending，失败failed，身份不一致mismatch，网络/权限error，失效stale，全部证明才passed。分页必须完整、顺序有界；missing-next与last未到不能当完整，不跟跨域链接或循环页。

```js
verification: {schemaVersion:1,provider:"github",status:"pending"|"passed"|"failed"|"mismatch"|"error"|"stale",checkedAt,message,
 target:{proposalId,proposalHash,repo,prNumber,baseCommitSha,headCommitSha,expectedTreeSha,policyHash},
 checks:{pullRequest:"pass"|"fail"|"unknown",commit:...,files:...,ci:"pass"|"fail"|"pending"|"unknown"},
 statuses:[{context,state,id,updatedAt}]}
```

短事务保留私有attemptId/target fingerprint；网络锁外；提交比较最新attempt/target/policy，乱序结果不能覆盖。新回执让已保存/在途核验stale；不修改原result、不替代人工reconciliation。每任务仅最近核验。请求总deadline10秒，每JSON256KiB、累计1MiB、最多8请求，错误脱敏/拒跳转/不泄露原始响应。

## B. Workspace、模型与可信检查

仅拥有 `apps/healing-worker/src/{workspace,model-client,check-runner,process-runner}.mjs` 及相应测试。

```js
createWorkspaceEngine(config, ({ generate, runCheck, runCommand } = {}));
engine.diagnose(claim, { signal, assertActive });
// {summary,diff,evidence,trace?,candidate,artifact:{patch,files,summary,diff,evidence,candidate}}
engine.prepareExecution(claim, artifact, { signal, assertActive });
// {candidate,files:[{path,mode,content:string|null}],evidence,cleanup:async()=>{}}
// generate({task,failures,context},{signal})
// runCheck({cwd,id,argv,image,timeoutMs},{signal})
// runCommand(command,args,{cwd,env,signal,timeoutMs,maxOutputBytes})
```

C 提供解析后的绝对dataDir/localPath、私有 hub.token/model.token/github.token。claim.task.task.payload.{repo,branch,context:{commitSha,source}}，type=ci-failure；claim.context.rule/safety。不要扁平化错误或增加虚假的兼容fallback。

仓库为部署者同步的可信local Git repo/mirror，精确SHA存在才运行；禁止从任务URLfetch或用HEAD代替。独立init/fetch副本无hardlinks、不继承源repo配置。Git禁hooks/fsmonitor/external diff/textconv/credential helpers/宿主global/system配置/交互提示；argv shell:false。检查前后确认Git元数据未变，检查不得写.git，Docker内隐藏或只读挂载真实.git；有修改则宿主不得再读取受污染Git配置。Docker与注入检查都验证此边界。

模型endpoint是完整聊天URL。严格 `{summary,changes:[{path,content:string|null}]}`（null删除），不能提供命令/checksPass。上下文显式contextPaths<=20、普通UTF8合计128KiB，不发env/凭据/protected/.git/symlink。JSON<=256KiB，patch<=512KiB，同时服从Hub1MiB和文件/行数上限。只允许UTF8普通文件添加/修改/删除；拒路径逃逸、symlink/submodule、二进制、rename、模式变化、重复或超限。保留已有executable位、BOM和无末尾换行，不截断候选。

先跑真实基线checks，无法复现明确失败且不问模型；再跑候选全部safety.requiredChecks，精确映射可信argv registry，无任务/模型shell。Docker digest固定/pullnever/networknone/dropALL/no-new-privileges/readonlyrootfs/CPU-memory-PID/tmpfs限额，只挂候选checkout（.git只读），不挂Worker数据/秘密。abort/timeout/output有界，清理整个进程组/容器，缺Docker不回退。首版拒绝检查修改任何checkout文件（包括生成报告/依赖），指南明确镜像应备齐依赖且检查只读。快照有文件数量和字节边界。

diff/tree/patch/files从同一个实际checkout派生；检查后重算，不允许隐藏变更。artifact完全JSON化，无外部路径或秘密。prepareExecution新checkout应用保存patch、核对manifest和files/diff、重跑checks，绝不二次调用模型。cleanup只删自身工作区。

## C. Runtime、journal、配置、publisher、CLI

仅拥有 `apps/healing-worker/src/{config,hub-client,journal,github-publisher,runtime,index}.mjs`、worker配置示例及测试；root负责package/lint/gitignore/完整文档。

```js
{
 version:1,hub:{url,tokenEnv:"HEALING_WORKER_TOKEN"},workerId,engineId:"fast",dataDir,
 repository:{fullName,branch:"main",localPath},
 model:{endpoint,model,tokenEnv:"HEALING_MODEL_TOKEN",contextPaths,timeoutMs:120000},
 checks:{image,commands:{"npm run test":["npm","run","test"]},timeoutMs:120000},
 github:{tokenEnv:"HEALING_GITHUB_WRITE_TOKEN"},publish:{enabled:false},pollIntervalMs:5000,heartbeatIntervalMs:15000
}
```

配置严格字段、URL与路径验证；环境秘密仅解析到私有token字段，不dump/journal。hub.url为origin，client拼 `/api/healing`。HTTPS生产，loopback HTTP可用于本地。CLI `npm run worker -- --config PATH [--once]`；`--check-config`只配置校验，不宣称Docker/远端已就绪。root将Node最低版本设20.3，实际测试版本单独记录。

```js
createWorkerRuntime(config, { client, engine, publisher, journal, now, sleep }); //runOnce({signal}?),run({signal}),close()
createHubClient(config, { fetchImpl, timeoutMs });
openJournal(dataDir); //get/list/put/close
createGitHubPublisher(config, { fetchImpl });
publisher.readBase({ repo, branch, signal }); //SHA
publisher.publish({
  claim,
  prepared,
  summary,
  onProgress,
  assertActive,
  signal,
}); //{commit,pr,files}
publisher.recover({ claim, known, signal }); //readonly facts
```

C负责诊断前与发布前GitHub base读，与source SHA一致；publisher首次写前再查；发布关闭仍需read credential，失败不得跳过。B只负责local，不访问GitHub。validate repo/branch/action/source/phase。

每dataDir单进程，目录0700/file0600，锁防并发、原子fsync持久化。保存稳定Worker身份、claim、candidate、submissionId、ACK、publishintent、真实facts、冻结outbox；无令牌。先保存再proposal/外部写；丢ACK重放完全同请求而不再生成/发布。重启中断execute只读recover并failed/cancelled回传，不恢复过期lease写。未知副作用必须failed/retriable:false，触发Hub人工核对；不能丢不确定事实。

心跳15秒、lease deadline，cancel/409/续租失败立即abort model/check且阻止新写；等检查/容器停止后cancelled ACK。每外部mutation前assertActive，await onProgress保存再下次write。shutdown/once mode signal都可取消并等待cleanup。支持待发送outbox重试而不领取新任务。固定安全错误分类（base moved、不可复现、Docker缺失、checks失败、candidate损坏、metadata修改、lease停止、publication uncertain），不能把所有情况吞成泛化成功，也不泄露rawremote/token。

GitHub固定api.github.com/2026-03-10。Git Data API exact批准tree、唯一parentbase、确定性heal/UUID分支、same-repo Draft PR及task/proposal/hash标记。现有branch/PR须核实际base/tree/head/marker才能复用；冲突停。POST不确定只读查证，不盲目重POST；无法证明停并核对。不能force/update无关branch/merge/status/check/dispatch。CI不在executelease里等待。

## D. Root UI、联调、验收和发布

任务列表复用现有dialog加「导入CI」，只填配置来源构建号；详情来源/SHA/候选标识/PR/独立CI，明确pending/failed/passed/mismatch/error/stale。统一uiButton/uiField/uiStatus；未配置/只读/demo明确反馈，pending防重发，失败保留草稿，不覆盖其他task/project/新版本/人工核对草稿；保留details展开与focus。无需新sidebar。

实际本地Git+HubHTTP+模型HTTP+Jenkins/GitHub受控HTTP+真实Node check串行联调；模型响应与远端为夹具，不等于生产验收。覆盖both approvals、publishdisabled、candidate replay/restart、lostproposal/PR/completeACK只创建一次、base drift、cancel、pending/failed/passed和不可信CI。完整npm test/lint/build/format，独立分任务+最终review，实际浏览器尝试（遵守环境访问限制，不绕过先前拒绝），如不可用精确说明。

更新README/API/运行恢复指南、配置例子、docs/design/console-v13-worker.md。生产条件缺失明确，不拿fixture替代。最终以最新main为父、已验证文件树创建新的DraftPR；不合并/部署。

## 官方接口参考

- https://www.jenkins.io/doc/book/using/remote-access-api/
- https://javadoc.jenkins.io/plugin/git/hudson/plugins/git/util/BuildData.html
- https://javadoc.jenkins.io/plugin/git/hudson/plugins/git/util/Build.html
- https://docs.github.com/en/rest/pulls/pulls
- https://docs.github.com/en/rest/commits/statuses
- https://docs.docker.com/reference/cli/docker/container/run/
- https://nodejs.org/api/globals.html#static-method-abortsignalanysignals
