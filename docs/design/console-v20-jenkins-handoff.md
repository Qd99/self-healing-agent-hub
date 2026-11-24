# V20 + Jenkins Worker · 环境验收交接

当前交付范围是现有 Hub 控制台迁移及 PR #2 实际代码集成。不自动合并 main，不关闭任何待评审 Issue，不启用生产发布。本轮用户负责真实环境验收。

## 1. 取得精确分支并记录提交

```bash
git fetch origin
git switch --create v20-acceptance --track origin/feat/console-v20-compatible
git rev-parse HEAD
git status --short
node --version
npm --version
npm ci
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

若本地已有 v20-acceptance 分支，先检查工作区，使用对应远端 SHA 建立新的干净工作树，不覆盖未提交内容。Hub 根建议 Node 22 LTS（最低 20.3）；Autoloop 在 apps/agent-autoloop 独立使用 Node 24+ 和自己的依赖锁及测试。二者不是同一个服务，也不将 Autoloop 测试通过当作 Hub 测试通过。

## 2. 隔离环境配置

参照 [Worker 运行指南](../healing-worker-guide.md)、[API 契约](../console-api.md) 和 [Agent 协议](../agent-worker-api.md)。
- 在新测试工作树复制并编辑 healing-config.example.json、healing-rules.worker.example.json（按指南选择）、healing-integrations.example.json、healing-worker.example.json。使用专用测试仓库、普通分支 Jenkins Job 和隔离数据目录。
- 管理令牌 CONSOLE_API_TOKEN 与 HEALING_WORKER_TOKEN 必须不同；Jenkins 读取、GitHub 核验与发布凭据分离，通过环境注入，不提交 Git、不写浏览器。
- 先保持 publish.enabled=false；Jenkins 和 GitHub 集成按需明确启用。核验使用准确 requiredStatusContexts 与 trustedStatusCreators，固定 Docker 镜像 digest。
- 保持原服务/数据目录不变；如果要接入旧数据，在已停止写入且完成备份的副本上进行迁移和回滚验证，不直接在生产状态文件验证。

```bash
export HOST=127.0.0.1
export PORT=8787
export HEALING_DATA_DIR="$(mktemp -d)"
npm start
```

浏览器打开 http://127.0.0.1:8787/ 与 http://127.0.0.1:8787/console-v20.html，两入口同源 API v1，同一会话和任务数据。选择 V20 顶栏旧版链接回退，不会重置任务。生产反向代理路径需核实实际部署是 Hub 还是 Autoloop。

## 3. 验收矩阵

| 编号 | 实际动作 | 通过标准 |
|---|---|---|
| UI-01 | 新旧入口登录、刷新、退出；浅深色与 1280/1440/1920 | 同源接口、错误码、会话、键盘焦点正确，界面不遮挡操作 |
| UI-02 | 创建、搜索、组合筛选、分页、跨页选择、取消/重试 | 真实持久状态一致；无重复创建；批量部分成功如实显示 |
| UI-03 | 打开审批流程、拒绝与重新提交、两级审批 | 未授权不能执行；过期 revision/轮次拒绝 |
| UI-04 | 规则保存、监控配置、连接检查、审计导出 | 旧契约可用；配置与连通性区分；导出覆盖全筛选结果 |
| CI-01 | 配置 Jenkins 来源并导入真实非生产失败构建 | 固定失败提交，重复导入不创建新任务；正常/不支持构建不误入队 |
| CI-02 | Worker 配置检查及一次诊断 | 仅隔离环境；检查固定镜像、候选内容和实际证据；publish=false 不创建 PR |
| CI-03 | 两级审批后由部署者启用专用测试发布器 | 同一批准 patch/tree，基线变化拒绝；只允许授权测试仓库 Draft PR |
| CI-04 | 独立核验实际 PR 和 Jenkins Commit Status | head/父提交/tree/files/可信 context 均匹配才通过；pending/失败/不一致/陈旧不是成功 |
| CI-05 | 取消、失联、重复回执、重启、Docker 清理失败 | 阻止盲目重试/发布；cleanup-pending/candidate-blocked/待核对可追踪 |
| UI-05 | Jenkins 导入记录、图表筛选、搜索分页、任务详情 | 核验分布只统计已导入记录；任务完成不等于 CI 通过；断线保留快照 |
| SAFE-01 | 错误 CSRF、非法来源、Worker/管理员凭据交叉、只读存储 | 拒绝未授权操作；凭据不泄露；保留已有数据 |
| ROLLBACK-01 | 返回旧入口并验证已有任务，重启隔离服务 | 业务与状态一致；真实状态格式兼容在备份副本上验证 |

Worker 先运行：
```bash
npm run worker -- --config configs/healing-worker.json --check-config
npm run worker -- --config configs/healing-worker.json --once
```
真实环境启用发布前必须另行确认授权与测试仓库。配置检查不代表真实远端可达。当前仅支持一个普通分支 Jenkins Git-plugin Job，按构建号读取失败，不会调用 build/dispatch/retry API。不得借本次验收启动生产部署。

## 4. 记录并决定发布

将最终 SHA、Node/环境版本、实际命令退出码、失败日志、浏览器截图及非生产 Jenkins 构建和 PR 证据附到 PR #23。#2 已作为祖先集成到 #23 分支，避免两个 PR 分别重复发布；待最终集成验收完成后由维护者决定合并策略。任何未执行项标记未执行，不把 Draft、任务完成或 PR 创建当作上线/CI 成功。
