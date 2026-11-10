# Self-Healing Agent Hub

> 通用项目自愈 Agent 系统：事件驱动、可插拔编排引擎、安全执行层

## Web 工作台

当前已实现 Web 工作台和只读配置 API。v10 默认读取同源管理服务，启动时不填充虚构任务或操作记录；未连接服务时保留明确的未连接状态。顶部保留项目与页面导航，任务搜索留在任务页。连接设置以管理服务、Grafana 和 Prometheus 三项列表集中呈现状态，详细信息按需展开；操作记录改为紧凑表格，支持详情、组合筛选、每页 15 条和全部匹配记录导出。首页报表、任务筛选与分页、审批流程展示及监控配置继续保留，具体变更与验证状态见 v10 记录。

在仓库根目录运行，要求 Node.js 18 或更新版本：

```bash
npm run dev
```

- [打开本地工作台](http://127.0.0.1:8787/)：读取配置，当前管理接口只读。
- [工作台使用与设计说明](docs/console-guide.md) · [API 与框架对接](docs/console-api.md)
- [v10 连接设置与操作记录](docs/design/console-v10.md)
- [v9 表面与侧栏精修](docs/design/console-v9.md) · [v8 报表首页与验收](docs/design/console-v8-review.md)
- [v7 界面细化与交付记录](docs/design/console-v7.md)
- [v6 界面与交互验收](docs/design/console-v6.md) · [v5 功能记录](docs/design/console-v5.md)
- [Grafana 接入说明](docs/monitoring-integration.md)
- [v4 任务工作区与验收](docs/design/task-workspace-v4.md) · [v3 审批验收](docs/design/validation.md) · [在线工作台](https://heal-agent-console-qd99.hearty-trail-0210.chatgpt.site)

工作台本身不需要 Redis、MySQL 或 GitHub App 凭据。未创建实际配置时，管理服务读取仓库中的示例配置，并明确显示来源；这不会生成任务、审批或操作记录。标准构建使用 `npm run build`，产物默认请求同源 `GET /api/healing/snapshot`。静态托管本身不提供该 API，未接入时显示未连接状态，不自动载入测试数据。

监控接入配置可保存为按模式、项目隔离的本机草稿，导出后由用户合并到服务端配置；本机保存不会修改 Agent 的监听范围，也不代表 Grafana 或 Prometheus 的连接已验证。开发者如需检查有数据的列表与模拟交互，可显式使用 `?demo=1` 或 `npm run build:demo` 启用虚构测试样本；这不是默认用户入口，模拟操作仅保存在当前页面内存。

**当前边界：**Grafana 当前提供配置、外部打开与仪表盘模板，尚未验证远程连接、嵌入面板或查询真实指标。具体 Agent 执行器、EventHub/任务队列、Webhook 与定时任务调度、GitHub 写入、真实审批及回滚尚未接入。真实任务写接口返回 `501`；配置中的模型、检查命令或安全开关不代表相关能力已经运行。下方原有架构、功能清单及路线图保留为设计背景，当前交付状态以本节和工作台指南为准。

---

一个可扩展的自动化修复框架，能够监听项目事件（GitHub webhooks、定期巡检），自动诊断并修复问题（lint 错误、测试失败、架构违规等），支持多种 Agent 编排引擎（ZCode、Codex、自定义），并提供四层安全防护机制。

---

## 核心特性

- ✅ **事件驱动架构** - 混合触发模式（webhook + 定期巡检 + 手动触发）
- ✅ **可插拔引擎** - 支持多种 Agent 编排工具（ZCode Workflow、Codex、自定义）
- ✅ **分级处理** - 简单问题快速通道，复杂问题 Multi-Agent 协作
- ✅ **四层防护** - 修复前检查、CI 验证、自动回滚、熔断降级
- ✅ **GitHub App 集成** - 清晰的审计追踪和权限控制
- ✅ **通用框架** - 配置化应用到任何项目

---

## 系统架构

```
┌──────────────────────────────────────────────────┐
│          触发层 (Trigger Layer)                   │
│  GitHub Webhooks | 定期巡检 | 手动触发            │
└────────────────────┬─────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────┐
│      EventHub & Router (核心调度层)               │
│  事件标准化 | 规则引擎 | 任务队列 | 熔断器         │
└────────────────────┬─────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────┐
│           处理层 (Processing Layer)               │
│                                                   │
│  快速通道          |     复杂工作流                │
│  (Direct AI)      |  (WorkflowEngine 接口)        │
│  - Lint           |  - ZCodeEngine               │
│  - Format         |  - CodexEngine               │
│  - Doc Sync       |  - CustomEngine              │
└────────────────────┬─────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────┐
│          执行层 (Execution Layer)                 │
│  L1: 修复前检查 | L2: CI验证 | L3: 回滚 | L4: 熔断│
└──────────────────────────────────────────────────┘
```

---

## 快速开始

### 前置要求

- Node.js >= 18
- Redis (任务队列)
- MySQL (可选，用于审计日志持久化)
- GitHub App (用于仓库操作)

### 安装

```bash
# 克隆仓库
git clone https://github.com/Qd99/self-healing-agent-hub.git
cd self-healing-agent-hub

# 安装依赖
npm install

# 复制配置模板
cp configs/healing-config.example.json configs/healing-config.json
cp configs/healing-rules.example.json configs/healing-rules.json
cp .env.example .env

# 编辑配置文件，填入你的项目信息和 GitHub App 凭据
```

### 配置 GitHub App

详细步骤见 [docs/guides/github-app-setup.md](docs/guides/github-app-setup.md)

简要步骤：

1. 在 GitHub 创建新的 GitHub App
2. 设置权限：Contents (write), Issues (write), Pull requests (write), Checks (read)
3. 配置 Webhook URL: `https://your-domain.com/webhook/github`
4. 获取 App ID、Private Key 和 Installation ID
5. 填入 `configs/healing-config.json`

### 启动服务

```bash
# 开发模式
npm run dev

# 生产模式
npm run build
npm start
```

---

## 项目结构

```
self-healing-agent-hub/
├── packages/
│   └── framework/              # 通用框架核心（可发布为 npm 包）
│       ├── src/
│       │   ├── types/          # 标准接口定义（Task, Result）
│       │   ├── engines/        # WorkflowEngine 基类
│       │   ├── core/           # 核心组件（EventHub, Router）
│       │   └── utils/          # 工具函数
│       └── package.json
├── apps/
│   └── healing-hub/            # EventHub 服务实现
│       ├── src/
│       │   ├── processors/     # 具体处理器（lint, test, doc）
│       │   ├── safety/         # 四层安全防护
│       │   └── github/         # GitHub App 集成
│       └── package.json
├── engines/
│   ├── direct-ai/              # 快速通道：直接 AI 调用
│   ├── zcode/                  # ZCode Workflow 引擎
│   └── codex/                  # Codex 引擎（待实现）
├── configs/
│   ├── healing-config.example.json   # 配置模板
│   └── healing-rules.example.json    # 规则模板
├── docs/
│   ├── architecture/           # 架构设计文档
│   ├── guides/                 # 使用指南
│   └── api/                    # API 参考
├── examples/                   # 示例项目配置
└── tests/                      # 测试
```

---

## 核心概念

### 1. 标准任务格式 (Task)

所有事件被标准化为统一的 Task 对象：

```typescript
interface Task {
  id: string;
  type: 'lint-error' | 'test-failure' | 'architecture-violation' | ...;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  payload: {
    repo: string;
    branch: string;
    files: string[];
    errorDetails: any;
    context: any;
  };
  metadata: {
    triggeredBy: 'webhook' | 'cron' | 'manual';
    createdAt: Date;
  };
}
```

### 2. 可插拔引擎 (WorkflowEngine)

所有编排引擎实现统一接口：

```typescript
abstract class WorkflowEngine {
  abstract execute(task: Task, context: Context): Promise<Result>;
  abstract healthCheck(): Promise<HealthStatus>;
  abstract cancel(taskId: string): Promise<void>;
}
```

支持的引擎：

- **Direct AI**: 快速通道，单次 AI 调用
- **ZCode Workflow**: 复杂的 Multi-Agent 协作
- **Codex**: 接入 Codex 编排系统（可扩展）
- **Custom**: 你自己的编排工具

### 3. 规则引擎 (Rule Engine)

通过 `healing-rules.json` 配置事件路由：

```json
{
  "rules": [
    {
      "match": { "taskType": "lint-error" },
      "processor": {
        "engine": "fast",
        "action": "auto-commit"
      }
    },
    {
      "match": { "taskType": "test-failure" },
      "processor": {
        "engine": "complex",
        "action": "auto-commit",
        "workflow": "diagnose-and-fix"
      }
    }
  ]
}
```

### 4. 四层安全防护

- **L1: 修复前检查** - 门禁验证、敏感文件保护、范围限制
- **L2: 修复后验证** - 触发 CI 全量检查
- **L3: 自动回滚** - CI 失败自动 revert
- **L4: 熔断降级** - 失败率监控、自动暂停/降级

---

## 使用场景

### 场景 1: 应用到 smallphone 项目

初始目标：为 [smallphone](https://github.com/Qd99/smallphone) 项目提供自动修复能力。

```json
// configs/healing-config.json
{
  "project": {
    "id": "smallphone",
    "repo": "Qd99/smallphone",
    "defaultBranch": "main"
  },
  "triggers": {
    "webhooks": { "enabled": true },
    "cron": {
      "healthCheck": { "schedule": "*/30 * * * *" }
    }
  }
}
```

### 场景 2: 作为通用框架

应用到任何项目：

```bash
# 安装框架包
npm install @smallphone/healing-agent-framework

# 复制配置
cp node_modules/@smallphone/healing-agent-framework/configs/*.example.json ./

# 编辑配置
vim healing-config.json  # 填入你的项目信息

# 启动服务
npx healing-hub start
```

---

## 扩展自定义引擎

接入你自己的 Agent 编排工具：

```typescript
import { WorkflowEngine } from '@smallphone/healing-agent-framework';

class MyCustomEngine extends WorkflowEngine {
  name = 'my-engine';

  async execute(task: Task, context: Context): Promise<Result> {
    // 你的编排逻辑
    // 可以调用 Codex、LangGraph 等任何工具
    return {
      success: true,
      action: 'committed',
      changes: { ... },
      logs: [ ... ]
    };
  }
}

// 注册引擎
import { registerEngine } from '@smallphone/healing-agent-framework';
registerEngine('my-engine', MyCustomEngine);
```

在配置中使用：

```json
{
  "engines": {
    "complex": {
      "type": "my-engine",
      "config": { ... }
    }
  }
}
```

---

## 文档

- [架构设计](docs/architecture/system-design.md)
- [GitHub App 配置指南](docs/guides/github-app-setup.md)
- [引擎集成指南](docs/guides/engine-integration.md)
- [API 参考](docs/api/README.md)
- [部署指南](docs/guides/deployment.md)

---

## 开发路线图

### Phase 1: 基础框架 ✅ (进行中)

- [x] EventHub 核心
- [x] 快速通道处理器
- [ ] GitHub App 集成
- [ ] L1 安全检查

### Phase 2: 安全防护

- [ ] L2: CI 验证
- [ ] L3: 自动回滚
- [ ] L4: 熔断器

### Phase 3: 复杂工作流

- [ ] ZCode Engine
- [ ] Multi-Agent 协作

### Phase 4: 定期巡检

- [ ] Cron 调度器
- [ ] 健康检查任务

### Phase 5: 通用化

- [ ] 提取 npm 包
- [ ] 多项目支持

---

## 贡献

欢迎贡献！特别是：

- 新的处理器（processor）
- 新的引擎实现（engine）
- 文档改进
- Bug 修复

---

## License

MIT

---

## 参考

本项目设计参考了：

- [文章：一年实践的 Agent 自动化系统](https://x.com/khazix0918/status/2117054043868860521)
- DS 的 Super Agent 架构
- ZCode Dynamic Workflow
- GitHub Actions 自动化实践
