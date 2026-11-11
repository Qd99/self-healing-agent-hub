# 系统架构设计

## 概览

Self-Healing Agent Hub 是一个事件驱动、可插拔引擎的自动化修复框架。

### 核心设计原则

1. **事件驱动** - 所有操作由事件触发，支持 webhook、定时任务和手动触发
2. **可插拔引擎** - 编排引擎完全解耦，支持 ZCode、Codex 或自定义实现
3. **分级处理** - 简单问题快速通道，复杂问题 Multi-Agent 协作
4. **安全第一** - 四层防护机制确保自动修复不会破坏代码库
5. **通用框架** - 配置化应用到任何项目

---

## 系统架构

```
┌────────────────────────────────────────────────────────────────┐
│                      触发层 (Trigger Layer)                     │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐       │
│  │   GitHub     │   │  定期巡检     │   │   手动触发    │       │
│  │  Webhooks    │   │   (Cron)     │   │  (API/CLI)   │       │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘       │
│         │                  │                   │                │
└─────────┼──────────────────┼───────────────────┼────────────────┘
          │                  │                   │
          └──────────────────┼───────────────────┘
                             ↓
┌────────────────────────────────────────────────────────────────┐
│              EventHub & Router (核心调度层)                      │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐             │
│  │ Event      │→ │ Rule Engine  │→ │ Task Queue │             │
│  │ Normalizer │  │ (rules.json) │  │ (Redis)    │             │
│  └────────────┘  └──────────────┘  └────────────┘             │
│                                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐             │
│  │ Circuit    │  │ Audit Logger │  │ Metrics    │             │
│  │ Breaker    │  │ (audit.jsonl)│  │ Collector  │             │
│  └────────────┘  └──────────────┘  └────────────┘             │
│                                                                  │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│               处理层 (Processing Layer)                          │
├─────────────────────────┬──────────────────────────────────────┤
│                         │                                        │
│  快速通道 (Fast Track)  │  复杂工作流 (Complex Workflow)         │
│  ┌─────────────────┐   │  ┌──────────────────────────────┐     │
│  │ Direct AI Call  │   │  │  WorkflowEngine Interface    │     │
│  │ - Lint 错误      │   │  └──────────┬───────────────────┘     │
│  │ - 格式问题       │   │             │                         │
│  │ - 简单类型错误   │   │  ┌──────────┴───────────┐             │
│  │ - 文档同步       │   │  │                      │             │
│  └─────────────────┘   │  ┼  ZCodeEngine        ┼             │
│                         │  ┼  (初期)             ┼             │
│  单次修复 → 直接提交     │  │                      │             │
│                         │  ├──────────────────────┤             │
│                         │  │  CodexEngine         │             │
│                         │  │  (后期切换)           │             │
│                         │  ├──────────────────────┤             │
│                         │  │  CustomEngine        │             │
│                         │  │  (自定义)             │             │
│                         │  └──────────────────────┘             │
│                         │                                        │
│                         │  多Agent协作 → PR或直接提交              │
└─────────────────────────┴──────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│                  执行层 (Execution Layer)                        │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                   │
│  │ Safety Checker   │  │ Git Operations   │                   │
│  │ L1: 修复前检查    │  │ via GitHub App   │                   │
│  └──────────────────┘  └──────────────────┘                   │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                   │
│  │ CI Trigger       │  │ Auto Rollback    │                   │
│  │ L2: 修复后验证    │  │ L3: 失败回滚      │                   │
│  └──────────────────┘  └──────────────────┘                   │
│                                                                  │
└────────────────────────────────────────────────────────────────┘
```

---

## 核心组件

### 1. EventHub (核心调度层)

**职责：**

- 接收所有事件（webhook、cron、手动触发）
- 标准化事件为统一的 Task 对象
- 基于 rules.json 路由到对应处理器
- 管理任务队列和执行状态
- 记录审计日志
- 提供监控指标

**技术选型：**

- Node.js + Express
- Redis (任务队列)
- MySQL (可选，审计日志持久化)

### 2. WorkflowEngine (可插拔引擎层)

**接口定义：**

```typescript
abstract class WorkflowEngine {
  abstract execute(task: Task, context: Context): Promise<Result>;
  abstract healthCheck(): Promise<HealthStatus>;
  abstract cancel(taskId: string): Promise<void>;
  abstract getStatus(taskId: string): Promise<TaskStatus>;
}
```

**支持的引擎：**

- **Direct AI Engine**: 快速通道，单次 AI 调用
- **ZCode Engine**: ZCode Dynamic Workflow
- **Codex Engine**: 接入 Codex 编排系统
- **Custom Engine**: 你自己的实现

### 3. Safety Layer (四层防护)

**L1: 修复前检查**

- 运行项目门禁（typecheck, lint, test）
- 检查敏感文件黑名单
- 验证修改范围（默认最多 5 个文件）
- 检查 commit message 格式

**L2: 修复后验证**

- 自动触发 CI 全量检查
- 监听 CI 结果

**L3: 自动回滚**

- CI 失败自动 revert commit
- 通知相关人员
- 记录回滚原因

**L4: 熔断降级**

- 监控失败率（默认 60 分钟窗口，失败 ≥3 次）
- 触发熔断：暂停自动修复
- 降级为只创建 issue 模式
- 人工介入后可重置

### 4. GitHub App 集成

**权限要求：**

- Contents: Read and write
- Issues: Read and write
- Pull requests: Read and write
- Checks: Read-only
- Actions: Read-only (可选)

**操作：**

- 通过 GitHub App 身份执行所有 Git 操作
- commit message 自动标注 `[auto-fix]` 前缀
- 清晰的审计追踪

---

## 数据流

### 事件处理流程

```
事件触发
    ↓
Event Normalizer (标准化)
    ↓
Rule Engine (规则匹配)
    ↓
Circuit Breaker (熔断检查)
    ↓
Task Queue (任务入队)
    ↓
Processor (处理器)
    ├→ Fast Track (快速通道)
    │   ├→ Direct AI Call
    │   ├→ L1 Safety Check
    │   ├→ Git Commit
    │   ├→ L2 CI Trigger
    │   └→ L3 Auto Rollback (if CI fails)
    │
    └→ Complex Workflow (复杂工作流)
        ├→ WorkflowEngine.execute()
        ├→ Multi-Agent Collaboration
        ├→ L1 Safety Check
        └→ Git Commit / Create PR / Create Issue
```

---

## 扩展点

### 1. 自定义处理器 (Processor)

在 `apps/healing-hub/src/processors/` 添加新的处理器：

```typescript
export class MyCustomProcessor {
  async process(task: Task): Promise<Result> {
    // 你的处理逻辑
  }
}
```

### 2. 自定义引擎 (Engine)

实现 `WorkflowEngine` 接口：

```typescript
import { WorkflowEngine } from "@healing/framework";

export class MyEngine extends WorkflowEngine {
  name = "my-engine";
  version = "1.0.0";

  async execute(task: Task, context: Context): Promise<Result> {
    // 调用你的编排工具
  }
}

// 注册引擎
registerEngine("my-engine", (config) => new MyEngine(config));
```

### 3. 自定义规则

在 `healing-rules.json` 添加新规则：

```json
{
  "id": "my-custom-rule",
  "match": { "taskType": "my-custom-type" },
  "processor": {
    "engine": "my-engine",
    "action": "auto-commit"
  }
}
```

---

## 部署架构

```
GitHub
  ↓ (webhook)
Nginx (SSL + 反向代理)
  ↓
EventHub Service (Node.js)
  ├→ Redis (任务队列)
  ├→ MySQL (审计日志)
  └→ ZCode CLI (workflow 执行)
```

**systemd 服务：**

- `healing-hub.service` - EventHub 主服务
- 由 systemd 管理，自动重启
- 日志输出到 `/var/log/healing-hub/`

---

## 安全考虑

1. **GitHub Token 安全**
   - 使用 GitHub App，不使用 PAT
   - Private Key 存储在环境变量或密钥管理器
   - 定期轮换凭据

2. **Webhook 验证**
   - 验证 GitHub webhook 签名
   - 使用 webhook secret

3. **代码修改限制**
   - 敏感文件黑名单
   - 修改范围限制
   - 必须通过门禁

4. **审计追踪**
   - 所有操作记录到 audit.jsonl
   - 包含完整上下文
   - 保留 30 天

---

## 监控指标

- 任务统计（总数、成功、失败、按类型）
- 性能指标（平均执行时间、P95）
- 安全指标（L1-L4 各层失败次数）
- 质量指标（自动提交成功率、PR 数、issue 数）

---

## 下一步

1. 实现 EventHub 核心
2. 实现 Direct AI Engine (快速通道)
3. 集成 GitHub App
4. 实现 L1-L4 安全防护
5. 实现 ZCode Engine
6. 添加定期巡检
7. 提取通用框架为 npm 包
