import {
  normalizeMonitoringConfig,
  DEMO_MONITORING_CONFIG,
} from "./monitoring-model.js";

/**
 * Fictional fixtures for the in-memory console demo.
 * No network, executor, shell, repository, or persistent configuration is used.
 * The nested Task, TaskStatusInfo, and Result records follow packages/framework.
 */

import {
  createDemoApprovalFlow,
  applyApprovalAction,
  cancelApprovalFlow,
} from "./approvals.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DEMO_SOURCE = "console-demo · 全部数据为虚构演示";
const PROJECT = {
  id: "self-healing-agent-hub-demo",
  repo: "Qd99/self-healing-agent-hub",
  defaultBranch: "main",
};
const CHECKS = ["npm run typecheck", "npm run lint", "npm run test"];
const TASK_TYPES = new Set([
  "lint-error",
  "format-error",
  "type-error",
  "unit-test-failure",
  "e2e-test-failure",
  "architecture-violation",
  "security-issue",
  "ci-failure",
  "doc-outdated",
  "dependency-issue",
  "performance-regression",
]);
const PRIORITIES = new Set(["urgent", "high", "medium", "low"]);

// Match and processor are the same plain JSON rule shapes as the repository.
const RULES = [
  {
    id: "lint-auto-fix",
    name: "Lint错误自动修复",
    enabled: true,
    match: { taskType: "lint-error" },
    processor: { engine: "fast", action: "auto-commit", priority: "high" },
  },
  {
    id: "format-auto-fix",
    name: "格式问题自动修复",
    enabled: true,
    match: { taskType: "format-error" },
    processor: { engine: "fast", action: "auto-commit", priority: "high" },
  },
  {
    id: "type-error-fix",
    name: "类型错误修复",
    enabled: true,
    match: { taskType: "type-error" },
    processor: { engine: "fast", action: "auto-commit", priority: "high" },
  },
  {
    id: "unit-test-fix",
    name: "单元测试失败修复",
    enabled: true,
    match: { taskType: "unit-test-failure" },
    processor: {
      engine: "complex",
      action: "auto-commit",
      priority: "high",
      workflow: "diagnose-and-fix",
    },
  },
  {
    id: "e2e-test-fix",
    name: "E2E测试失败修复",
    enabled: true,
    match: { taskType: "e2e-test-failure" },
    processor: {
      engine: "complex",
      action: "auto-commit",
      priority: "urgent",
      workflow: "diagnose-and-fix",
    },
  },
  {
    id: "architecture-violation",
    name: "架构违规检测",
    enabled: true,
    match: { taskType: "architecture-violation" },
    processor: {
      engine: "complex",
      action: "create-issue",
      priority: "medium",
      workflow: "analyze-and-suggest",
    },
  },
  {
    id: "security-issue",
    name: "安全问题检测",
    enabled: true,
    match: { taskType: "security-issue" },
    processor: {
      engine: "complex",
      action: "create-issue",
      priority: "urgent",
      workflow: "security-audit",
    },
  },
  {
    id: "doc-sync",
    name: "文档同步",
    enabled: true,
    match: { taskType: "doc-outdated" },
    processor: { engine: "fast", action: "auto-commit", priority: "low" },
  },
  {
    id: "ci-retry",
    name: "CI失败重试",
    enabled: true,
    match: { taskType: "ci-failure", "context.retryCount": { $lt: 3 } },
    processor: { engine: "fast", action: "retry", priority: "high" },
  },
  {
    id: "dependency-update",
    name: "依赖更新检查",
    enabled: false,
    match: { taskType: "dependency-issue" },
    processor: {
      engine: "complex",
      action: "create-pr",
      priority: "low",
      workflow: "dependency-audit",
    },
  },
];

const SAFETY = {
  maxFilesPerFix: 5,
  protectedPaths: [
    "deploy/",
    ".github/workflows/",
    "*.env",
    "*.key",
    "*.pem",
    "server/healing-hub.mjs",
  ],
  requiredChecks: CHECKS,
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    windowMinutes: 60,
    cooldownMinutes: 30,
  },
  autoRollback: {
    enabled: true,
    ciTimeout: 600000,
    notifyOn: ["slack", "github-issue"],
  },
};

const TRIGGERS = {
  webhooks: {
    enabled: true,
    events: ["push", "issues", "pull_request", "workflow_run"],
  },
  cron: {
    healthCheck: { schedule: "*/30 * * * *", enabled: true },
    qualityScan: { schedule: "0 2 * * *", enabled: true },
    dependencyAudit: { schedule: "0 9 * * 1", enabled: false },
  },
  manual: {
    enabled: true,
    apiEndpoint: "/api/healing/trigger",
    requireAuth: true,
  },
};

function diff(path, before, after, context = []) {
  return {
    path,
    additions: after.length,
    deletions: before.length,
    lines: [
      ...context.map((content) => ({ type: "context", content })),
      ...before.map((content) => ({ type: "remove", content })),
      ...after.map((content) => ({ type: "add", content })),
    ],
  };
}

const SCENARIOS = [
  {
    title: "修复导航组件未使用导入",
    type: "lint-error",
    engineId: "fast",
    priority: "low",
    code: "no-unused-vars",
    problem: "导航组件存在 2 处未使用导入",
    repair: "移除无效导入，保留原组件行为",
    check: "npm run lint",
    tests: ["npm run lint", "npm run typecheck"],
    diff: [
      diff(
        "apps/web/src/components/Navigation.tsx",
        ["import { useMemo, useState } from 'react';"],
        ["import { useState } from 'react';"],
        ["import { Link } from './Link';"],
      ),
    ],
  },
  {
    title: "消除用户资料空值类型错误",
    type: "type-error",
    engineId: "fast",
    priority: "high",
    code: "TS18048",
    problem: "user.profile 可能为 undefined",
    repair: "为缺失头像添加安全默认值",
    check: "npm run typecheck",
    tests: ["npm run typecheck", "npm run test -- profile"],
    diff: [
      diff(
        "apps/web/src/features/profile/Avatar.tsx",
        ["const avatar = user.profile.avatarUrl;"],
        ["const avatar = user.profile?.avatarUrl ?? '/default-avatar.svg';"],
        ["export function Avatar({ user }: Props) {"],
      ),
    ],
  },
  {
    title: "修复缓存过期边界条件",
    type: "unit-test-failure",
    engineId: "complex",
    priority: "high",
    code: "ASSERTION_FAILED",
    problem: "过期时间恰好等于当前时间时仍返回缓存",
    repair: "统一到期边界为 expiresAt <= now",
    check: "npm run test -- cache",
    tests: ["npm run test -- cache", "npm run typecheck"],
    diff: [
      diff(
        "packages/core/src/cache.ts",
        ["if (entry.expiresAt < now) return undefined;"],
        ["if (entry.expiresAt <= now) return undefined;"],
        [
          "const entry = this.entries.get(key);",
          "if (!entry) return undefined;",
        ],
      ),
    ],
  },
  {
    title: "同步任务触发接口文档",
    type: "doc-outdated",
    engineId: "fast",
    priority: "low",
    code: "DOC_SCHEMA_MISMATCH",
    problem: "文档中 priority 的默认值与接口契约不一致",
    repair: "补全手动触发参数及优先级示例",
    check: "npm run docs:check",
    tests: ["npm run docs:check", "npm run lint"],
    diff: [
      diff(
        "docs/api/manual-trigger.md",
        ["| priority | string | high |"],
        ["| priority | urgent / high / medium / low | medium |"],
        ["## POST /api/healing/trigger"],
      ),
    ],
  },
  {
    title: "修复按钮组件格式偏差",
    type: "format-error",
    engineId: "fast",
    priority: "low",
    code: "PRETTIER_CHECK",
    problem: "按钮组件未遵循项目格式规范",
    repair: "统一对象空格与分号，保持行为不变",
    check: "npm run format:check",
    tests: ["npm run format:check", "npm run lint"],
    diff: [
      diff(
        "apps/web/src/components/Button.tsx",
        ["const sizes={small:24,medium:32,large:40}"],
        ["const sizes = { small: 24, medium: 32, large: 40 };"],
      ),
    ],
  },
  {
    title: "修复分页切换后的空列表",
    type: "unit-test-failure",
    engineId: "complex",
    priority: "medium",
    code: "ASSERTION_FAILED",
    problem: "筛选条件变化时页码没有回到第一页",
    repair: "在筛选更新时重置游标并新增回归覆盖",
    check: "npm run test -- pagination",
    tests: ["npm run test -- pagination", "npm run typecheck"],
    diff: [
      diff(
        "apps/web/src/hooks/usePagination.ts",
        ["setFilter(nextFilter);"],
        ["setFilter(nextFilter);", "setPage(1);"],
        ["function updateFilter(nextFilter: Filter) {"],
      ),
    ],
  },
  {
    title: "完善消息事件负载类型",
    type: "type-error",
    engineId: "fast",
    priority: "high",
    code: "TS2339",
    problem: "联合类型缺少事件分支收窄",
    repair: "依据事件 type 收窄 message 的访问范围",
    check: "npm run typecheck",
    tests: ["npm run typecheck", "npm run test -- events"],
    diff: [
      diff(
        "packages/core/src/events/handler.ts",
        ["appendMessage(event.message);"],
        [
          "if (event.type === 'message') {",
          "  appendMessage(event.message);",
          "}",
        ],
        ["export function handleEvent(event: ChatEvent) {"],
      ),
    ],
  },
  {
    title: "修正搜索输入框 Hook 依赖",
    type: "lint-error",
    engineId: "fast",
    priority: "medium",
    code: "react-hooks/exhaustive-deps",
    problem: "搜索回调捕获了过期的 query",
    repair: "补全 effect 依赖并保持请求取消逻辑",
    check: "npm run lint",
    tests: ["npm run lint", "npm run test -- search"],
    diff: [
      diff(
        "apps/web/src/features/search/SearchInput.tsx",
        ["}, [enabled]);"],
        ["}, [enabled, query, search]);"],
        ["useEffect(() => {", "  if (enabled) search(query);"],
      ),
    ],
  },
  {
    title: "更新重试配置说明",
    type: "doc-outdated",
    engineId: "fast",
    priority: "low",
    code: "DOC_SCHEMA_MISMATCH",
    problem: "配置说明遗漏重试次数约束",
    repair: "记录 context.retryCount 与路由条件示例",
    check: "npm run docs:check",
    tests: ["npm run docs:check"],
    diff: [
      diff(
        "docs/configuration.md",
        ["CI 失败将自动重试。"],
        [
          "CI 失败在 context.retryCount < 3 时匹配重试规则。",
          "超过上限的任务交由人工检查。",
        ],
        ["### CI 重试"],
      ),
    ],
  },
  {
    title: "修复依赖锁文件漂移",
    type: "dependency-issue",
    engineId: "complex",
    priority: "medium",
    code: "LOCKFILE_OUTDATED",
    problem: "依赖声明与锁文件版本不一致",
    repair: "在演示工作区重新生成一致的依赖锁定记录",
    check: "npm ci --ignore-scripts",
    tests: ["npm ci --ignore-scripts", "npm run test"],
    diff: [
      diff(
        "package-lock.json",
        ['"version": "1.4.1",'],
        ['"version": "1.4.2",'],
        ['"node_modules/demo-parser": {'],
      ),
    ],
  },
  {
    title: "修复流式输出结束状态",
    type: "unit-test-failure",
    engineId: "complex",
    priority: "high",
    code: "ASSERTION_FAILED",
    problem: "流结束后 loading 状态未归零",
    repair: "在 finally 中重置状态并释放读取器",
    check: "npm run test -- stream",
    tests: ["npm run test -- stream", "npm run typecheck"],
    diff: [
      diff(
        "apps/web/src/features/chat/stream.ts",
        ["await consume(reader);"],
        [
          "try {",
          "  await consume(reader);",
          "} finally {",
          "  reader.releaseLock();",
          "  setLoading(false);",
          "}",
        ],
      ),
    ],
  },
  {
    title: "完善任务取消响应类型",
    type: "type-error",
    engineId: "fast",
    priority: "medium",
    code: "TS2322",
    problem: "取消响应遗漏 cancelled 状态",
    repair: "使用原有 TaskStatus 联合类型约束响应",
    check: "npm run typecheck",
    tests: ["npm run typecheck", "npm run lint"],
    diff: [
      diff(
        "packages/client/src/tasks.ts",
        ["status: 'pending' | 'running' | 'completed';"],
        ["status: TaskStatus;"],
        ["export interface CancelResponse {"],
      ),
    ],
  },
  {
    title: "规范审计日志字段命名",
    type: "lint-error",
    engineId: "fast",
    priority: "low",
    code: "naming-convention",
    problem: "审计字段未使用约定的 camelCase",
    repair: "统一内部字段命名并维持序列化契约",
    check: "npm run lint",
    tests: ["npm run lint", "npm run test -- audit"],
    diff: [
      diff(
        "packages/core/src/audit/format.ts",
        [
          "const task_id = event.taskId;",
          "return { taskId: task_id, action };",
        ],
        ["const taskId = event.taskId;", "return { taskId, action };"],
      ),
    ],
  },
  {
    title: "补全安装与启动说明",
    type: "doc-outdated",
    engineId: "fast",
    priority: "low",
    code: "DOC_COMMAND_OUTDATED",
    problem: "README 的命令示例遗漏配置准备步骤",
    repair: "说明示例配置路径与本地启动方式",
    check: "npm run docs:check",
    tests: ["npm run docs:check"],
    diff: [
      diff(
        "README.md",
        ["npm start"],
        [
          "cp configs/healing-config.example.json configs/healing-config.json",
          "npm run dev",
        ],
        ["## 本地开发"],
      ),
    ],
  },
];

const CHAT_SCENARIO = {
  title: "聊天模块消息列表类型错误",
  type: "type-error",
  engineId: "fast",
  priority: "high",
  code: "TS2322",
  problem: "MessageList.tsx:42 — string | undefined 无法赋值给 string",
  repair: "为消息内容提供空值回退，保留流式占位行为",
  check: "npm run typecheck",
  tests: ["npm run typecheck", "npm run test -- MessageList"],
  diff: [
    diff(
      "apps/web/src/features/chat/MessageList.tsx",
      ["  content={message.content}"],
      ["  content={message.content ?? ''}"],
      ["return (", "  <MessageBubble", "    key={message.id}"],
    ),
  ],
};

const REVIEW_SCENARIOS = [
  {
    title: "日志解析依赖升级方案待审阅",
    type: "dependency-issue",
    engineId: "complex",
    priority: "medium",
    code: "DEMO_DEPENDENCY_AUDIT",
    problem: "演示审计提示解析器版本需要升级；无真实漏洞声明",
    repair: "升级虚构 demo-log-parser 依赖并验证兼容性",
    check: "npm run test -- parser",
    tests: ["npm run typecheck", "npm run test -- parser", "npm run lint"],
    diff: [
      diff(
        "package.json",
        ['    "demo-log-parser": "2.3.0"'],
        ['    "demo-log-parser": "2.3.1"'],
        ['  "dependencies": {'],
      ),
      diff(
        "packages/core/src/logs/parser.ts",
        ["return parser.parse(line);"],
        ["return parser.parse(line, { strict: true });"],
      ),
    ],
  },
  {
    title: "会话恢复逻辑修复方案待审阅",
    type: "unit-test-failure",
    engineId: "complex",
    priority: "high",
    code: "ASSERTION_FAILED",
    problem: "会话过期后仍尝试恢复本地历史",
    repair: "恢复会话前检查过期时间并清理失效缓存",
    check: "npm run test -- session",
    tests: ["npm run test -- session", "npm run typecheck", "npm run lint"],
    diff: [
      diff(
        "apps/web/src/features/session/restore.ts",
        ["return restore(cachedSession);"],
        [
          "if (cachedSession.expiresAt <= Date.now()) {",
          "  storage.removeItem(SESSION_KEY);",
          "  return null;",
          "}",
          "return restore(cachedSession);",
        ],
      ),
      diff(
        "apps/web/src/features/session/restore.test.ts",
        [],
        [
          "it('ignores an expired session', () => {",
          "  expect(restoreSession(expiredSession)).toBeNull();",
          "});",
        ],
      ),
    ],
  },
];

const FAILURE_SCENARIOS = [
  {
    title: "CI 修复触及受保护工作流",
    type: "ci-failure",
    engineId: "complex",
    priority: "high",
    code: "PROTECTED_PATH",
    problem: "修复建议涉及 .github/workflows/ci.yml，安全策略阻止应用",
    repair: "候选方案保留供人工检查，未修改任何文件",
    check: "protected-paths",
    tests: ["protected-paths"],
    errorAction: "请维护者检查 CI 配置；不要扩大自动修复权限。",
    diff: [
      diff(
        ".github/workflows/ci.yml",
        ["      - run: npm test"],
        ["      - run: npm run test -- --run"],
        ["    steps:", "      - uses: actions/checkout@v4"],
      ),
    ],
  },
  {
    title: "支付回调幂等回归验证失败",
    type: "unit-test-failure",
    engineId: "complex",
    priority: "urgent",
    code: "REGRESSION_FAILED",
    problem: "重复回调测试仍有 1 项失败，候选修复未提交",
    repair: "第一轮仅覆盖顺序请求，尚未处理并发写入冲突",
    check: "npm run test -- payments",
    tests: ["npm run typecheck", "npm run lint", "npm run test -- payments"],
    errorAction: "检查数据库唯一约束与并发事务，再生成新的修复尝试。",
    diff: [
      diff(
        "packages/payments/src/webhook.ts",
        ["await createPayment(event);"],
        [
          "if (await findPayment(event.id)) return;",
          "await createPayment(event);",
        ],
        ["export async function onPayment(event: PaymentEvent) {"],
      ),
    ],
  },
  {
    title: "依赖升级兼容性验证失败",
    type: "dependency-issue",
    engineId: "complex",
    priority: "medium",
    code: "COMPATIBILITY_CHECK_FAILED",
    problem: "虚构序列化依赖的新版本改变日期输出格式",
    repair: "候选升级没有通过兼容性检查，保持原版本",
    check: "npm run test -- serializer",
    tests: ["npm run typecheck", "npm run test -- serializer"],
    errorAction: "补充日期序列化适配后重新运行兼容性测试。",
    diff: [
      diff(
        "package.json",
        ['    "demo-serializer": "3.1.0"'],
        ['    "demo-serializer": "4.0.0"'],
        ['  "dependencies": {'],
      ),
    ],
  },
];

const clone = (value) => structuredClone(value);
const iso = (timestamp) => new Date(timestamp).toISOString();

function makeTrace(id, scenario, status, durationMs, reviewing) {
  const root = `${id}-diagnose`;
  const failed = status === "failed";
  const running = status === "running";
  return [
    {
      id: root,
      title: "分析任务与选择修复策略",
      kind: "agent",
      status: "completed",
      durationMs: Math.round(durationMs * 0.2),
      detail: `${scenario.engineId} · ${scenario.problem}（模拟）`,
    },
    {
      id: `${id}-read`,
      parentId: root,
      title: "读取相关文件与错误上下文",
      kind: "tool",
      status: "completed",
      durationMs: Math.round(durationMs * 0.12),
      detail: scenario.diff.map((file) => file.path).join("、"),
    },
    {
      id: `${id}-patch`,
      parentId: root,
      title: "生成最小范围修复",
      kind: "agent",
      status: "completed",
      durationMs: Math.round(durationMs * 0.28),
      detail: scenario.repair,
    },
    {
      id: `${id}-safety`,
      title: "检查修改范围与保护路径",
      kind: "check",
      status:
        failed && scenario.code === "PROTECTED_PATH" ? "failed" : "completed",
      durationMs: 480,
      detail:
        failed && scenario.code === "PROTECTED_PATH"
          ? "阻止修改受保护路径；候选 diff 仅供审阅"
          : `${scenario.diff.length} 个文件，未超过单次 5 文件限制（模拟）`,
    },
    {
      id: `${id}-validate`,
      title: "执行类型与回归检查",
      kind: "check",
      status: running ? "running" : failed ? "failed" : "completed",
      ...(running
        ? {}
        : { durationMs: Math.max(0, Math.round(durationMs * 0.4) - 480) }),
      detail: running
        ? "正在模拟类型检查，尚无真实执行器"
        : failed
          ? `${scenario.check} 未通过（模拟）`
          : `${scenario.tests.join(" · ")} 通过（模拟）`,
    },
    {
      id: `${id}-finish`,
      title: reviewing ? "等待人工审阅" : "整理修复结果与证据",
      kind: "agent",
      status:
        running || reviewing ? "pending" : failed ? "pending" : "completed",
      detail: reviewing
        ? "候选变更尚未提交；批准后进入模拟队列"
        : failed
          ? "检查未通过，未提交候选变更"
          : "全部记录为演示数据，不代表真实仓库变更",
    },
  ];
}

function makeTask({
  id,
  scenario,
  createdAt,
  status = "completed",
  durationMs = 92000,
  reviewing = false,
  index = 0,
}) {
  const startedAt = createdAt + 2000;
  const completedAt = startedAt + durationMs;
  const failed = status === "failed";
  const running = status === "running";
  const task = {
    id,
    type: scenario.type,
    priority: scenario.priority,
    payload: {
      repo: PROJECT.repo,
      branch: status === "completed" ? "main" : `fix/demo-${id.toLowerCase()}`,
      files: scenario.diff.map((file) => file.path),
      errorDetails: {
        code: scenario.code,
        message: scenario.problem,
        check: scenario.check,
        simulated: true,
      },
      context: {
        demo: true,
        retryCount: 0,
        commitSha: `demo-${String(index + 1).padStart(7, "0")}`,
      },
    },
    metadata: {
      triggeredBy:
        scenario.type === "doc-outdated" || scenario.type === "dependency-issue"
          ? "cron"
          : "webhook",
      triggeredAt: iso(createdAt),
      source: DEMO_SOURCE,
      createdAt: iso(createdAt),
    },
  };
  const entry = {
    task,
    status: {
      taskId: id,
      status,
      progress: reviewing ? 80 : running ? 68 : 100,
      message: reviewing
        ? "候选变更等待人工审阅（演示）"
        : running
          ? "正在模拟类型与回归检查"
          : failed
            ? scenario.problem
            : "修复及检查已完成（演示）",
      ...(status === "pending" ? {} : { startedAt: iso(startedAt) }),
      ...(status === "completed" || failed
        ? { completedAt: iso(completedAt) }
        : {}),
    },
    title: scenario.title,
    engineId: scenario.engineId,
    ...(reviewing ? { reviewState: "pending" } : {}),
    trace: makeTrace(id, scenario, status, durationMs, reviewing),
    diff: clone(scenario.diff),
  };
  if (!running) {
    const afterSummary = failed
      ? scenario.problem
      : reviewing
        ? `${scenario.repair}；检查通过，等待人工批准`
        : scenario.repair;
    const checksPass = failed
      ? scenario.tests.filter((check) => check !== scenario.check)
      : scenario.tests;
    entry.result = {
      taskId: id,
      success: !failed,
      action: failed ? "failed" : reviewing ? "skipped" : "committed",
      changes: {
        files: scenario.diff.map((file) => file.path),
        simulated: true,
        ...(!failed && !reviewing
          ? { commit: `demo-${String(index + 1).padStart(7, "0")}` }
          : { applied: false }),
      },
      logs: [
        `[${iso(startedAt)}] [DEMO] 全部过程为虚构演示，未运行真实命令。`,
        `[${iso(startedAt + 8000)}] [DEMO] ${scenario.problem}`,
        `[${iso(startedAt + Math.round(durationMs * 0.6))}] [DEMO] ${scenario.repair}`,
        `[${iso(completedAt)}] [DEMO] ${failed ? "校验失败，保留候选变更供检查。" : reviewing ? "校验通过，等待人工审阅，尚未提交。" : "模拟修复完成，生成检查证据。"}`,
      ],
      evidence: {
        beforeState: {
          summary: scenario.problem,
          check: scenario.check,
          exitCode: 1,
          simulated: true,
        },
        afterState: {
          summary: afterSummary,
          check: scenario.check,
          exitCode: failed ? 1 : 0,
          applied: !failed && !reviewing,
          simulated: true,
        },
        testsRun: clone(scenario.tests),
        checksPass: clone(checksPass),
        checksFail: failed ? [scenario.check] : [],
        artifacts: ["演示检查记录 · 仅用于界面展示"],
      },
      timings: {
        startedAt: iso(startedAt),
        completedAt: iso(completedAt),
        durationMs,
        stages: {
          context: Math.round(durationMs * 0.12),
          diagnosis: Math.round(durationMs * 0.2),
          patch: Math.round(durationMs * 0.28),
          validation: Math.round(durationMs * 0.4),
        },
      },
      ...(failed
        ? {
            error: {
              code: scenario.code,
              message: scenario.problem,
              retriable: scenario.code !== "PROTECTED_PATH",
              suggestedAction: scenario.errorAction,
            },
          }
        : {}),
    };
  }
  if (reviewing)
    entry.approvalFlow = createDemoApprovalFlow(entry, iso(completedAt));
  return entry;
}

/** Returns an isolated, wholly fictional fixture anchored to the supplied time. */
export function createDemoSnapshot(now = Date.now()) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError("演示快照需要有效时间");
  const todayStart =
    Math.floor((timestamp + 8 * 3600000) / DAY_MS) * DAY_MS - 8 * 3600000;
  const span = timestamp - (todayStart - 6 * DAY_MS + 3600000) - 18 * MINUTE_MS;
  const tasks = Array.from({ length: 42 }, (_, index) =>
    makeTask({
      id: `AGT-${2045 - index}`,
      scenario: SCENARIOS[index % SCENARIOS.length],
      index,
      createdAt: timestamp - 18 * MINUTE_MS - Math.round((index * span) / 41),
      durationMs: 62000 + ((index * 19300) % 174000),
    }),
  );
  tasks.push(
    makeTask({
      id: "AGT-2048",
      scenario: CHAT_SCENARIO,
      status: "running",
      createdAt: timestamp - 4 * MINUTE_MS,
      durationMs: 238000,
      index: 48,
    }),
  );
  REVIEW_SCENARIOS.forEach((scenario, index) =>
    tasks.push(
      makeTask({
        id: `AGT-${2047 - index}`,
        scenario,
        status: "pending",
        reviewing: true,
        createdAt: timestamp - (index === 0 ? 12 : 35) * MINUTE_MS,
        durationMs: 141000 + index * 39000,
        index: 46 + index,
      }),
    ),
  );
  FAILURE_SCENARIOS.forEach((scenario, index) =>
    tasks.push(
      makeTask({
        id: `AGT-${2003 - index}`,
        scenario,
        status: "failed",
        createdAt:
          timestamp -
          [48 * MINUTE_MS, DAY_MS + 3600000, 3 * DAY_MS + 7200000][index],
        durationMs: [230400, 186200, 348900][index],
        index: 43 + index,
      }),
    ),
  );
  tasks.sort(
    (left, right) =>
      Date.parse(right.task.metadata.createdAt) -
      Date.parse(left.task.metadata.createdAt),
  );
  const activity = tasks
    .slice(0, 12)
    .map((entry, index) => ({
      id: `demo-activity-${index + 1}`,
      at: entry.status.completedAt ?? entry.task.metadata.createdAt,
      action:
        entry.reviewState === "pending"
          ? "review-requested"
          : entry.status.status,
      message: `${entry.title} · ${entry.status.message}`,
      taskId: entry.task.id,
      actor:
        entry.engineId === "fast"
          ? "Fast Agent（模拟）"
          : "Complex Agent（模拟）",
      level:
        entry.status.status === "failed"
          ? "error"
          : entry.reviewState === "pending"
            ? "warning"
            : "info",
    }))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return {
    apiVersion: 1,
    mode: "demo",
    generatedAt: iso(timestamp),
    configSource: "example",
    rulesSource: "example",
    rulesVersion: "1.0.0",
    notice: "演示快照 · 全部任务与执行结果均为虚构数据",
    monitoring: normalizeMonitoringConfig(DEMO_MONITORING_CONFIG),
    project: clone(PROJECT),
    capabilities: {
      trigger: true,
      cancel: true,
      retry: true,
      approve: true,
      updateRules: true,
    },
    engines: [
      {
        id: "fast",
        name: "Fast Agent",
        type: "direct-ai",
        provider: "anthropic",
        model: "claude-sonnet-4",
        configured: false,
        implemented: false,
        status: "unavailable",
        message: "演示路由；仓库尚无具体执行引擎，未连接模型服务",
      },
      {
        id: "complex",
        name: "Complex Agent",
        type: "zcode-workflow",
        model: "claude-sonnet-4.5",
        configured: false,
        implemented: false,
        status: "unavailable",
        message: "演示路由；工作流执行器尚未实现，未连接模型服务",
      },
    ],
    rules: clone(RULES),
    safety: clone(SAFETY),
    triggers: clone(TRIGGERS),
    tasks,
    activity,
  };
}

function nextTaskId(tasks) {
  const highest = tasks.reduce((maximum, entry) => {
    const match = /^AGT-(\d+)$/.exec(entry.task.id);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  return `AGT-${highest + 1}`;
}

function queuedEntry(task, title, engineId) {
  return {
    task,
    title,
    engineId,
    status: {
      taskId: task.id,
      status: "pending",
      progress: 0,
      message: "已加入模拟队列；未调用真实执行器",
    },
    trace: [
      {
        id: `${task.id}-received`,
        title: "接收手动任务",
        kind: "agent",
        status: "completed",
        detail: "仅写入当前浏览器内存中的演示快照",
      },
      {
        id: `${task.id}-queued`,
        title: "等待执行",
        kind: "agent",
        status: "pending",
        detail: "演示队列不会启动真实命令或模型请求",
      },
    ],
    diff: [],
  };
}

function validateTrigger(payload) {
  if (!payload || typeof payload.title !== "string" || !payload.title.trim())
    throw new Error("请输入任务标题");
  if (!TASK_TYPES.has(payload.type)) throw new Error("任务类型不受支持");
  if (!PRIORITIES.has(payload.priority)) throw new Error("任务优先级不受支持");
  if (typeof payload.branch !== "string" || !payload.branch.trim())
    throw new Error("请输入目标分支");
}

/**
 * Applies one explicit local simulation without mutating the supplied snapshot.
 * An approved draft remains pending; this function never fabricates execution.
 */
export function applyDemoAction(
  snapshot,
  { type, id, payload } = {},
  now = Date.now(),
) {
  if (snapshot?.mode !== "demo")
    throw new Error("模拟操作仅适用于演示模式（demo）");
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError("操作需要有效时间");
  if (
    ![
      "trigger",
      "cancel",
      "retry",
      "approve",
      "reject",
      "approve-gate",
      "reject-gate",
      "resubmit-approval",
      "toggle-rule",
    ].includes(type)
  )
    throw new Error("不支持的演示操作");

  let target;
  if (type === "trigger") {
    validateTrigger(payload);
  } else if (type === "toggle-rule") {
    target = snapshot.rules.find((rule) => rule.id === id);
    if (!target) throw new Error("找不到指定路由规则");
  } else {
    target = snapshot.tasks.find((entry) => entry.task.id === id);
    if (!target) throw new Error("找不到指定任务");
    if (
      type === "cancel" &&
      !["pending", "running"].includes(target.status.status)
    )
      throw new Error("只有等待中或执行中的任务可以取消");
    if (
      type === "retry" &&
      !["failed", "cancelled"].includes(target.status.status)
    )
      throw new Error("只有失败或已取消的任务可以重试");
    if (
      (type === "approve" || type === "reject") &&
      target.reviewState !== "pending"
    )
      throw new Error("只有待审阅的方案可以批准或拒绝");
  }

  const next = clone(snapshot);
  const at = iso(timestamp);
  let taskId = type === "toggle-rule" ? undefined : id;
  let message;

  if (type === "toggle-rule") {
    const rule = next.rules.find((entry) => entry.id === id);
    rule.enabled = !rule.enabled;
    message = `${rule.enabled ? "启用" : "停用"}路由规则「${rule.name}」（仅演示）`;
  } else if (type === "trigger") {
    taskId = nextTaskId(next.tasks);
    const task = {
      id: taskId,
      type: payload.type,
      priority: payload.priority,
      payload: {
        repo: next.project.repo,
        branch: payload.branch.trim(),
        files: [],
        errorDetails: { message: payload.title.trim(), simulated: true },
        context: { demo: true, retryCount: 0 },
      },
      metadata: {
        triggeredBy: "manual",
        triggeredAt: at,
        createdAt: at,
        source: DEMO_SOURCE,
      },
    };
    const rule = next.rules.find(
      (entry) => entry.enabled && entry.match.taskType === payload.type,
    );
    const complexTypes = [
      "unit-test-failure",
      "e2e-test-failure",
      "architecture-violation",
      "security-issue",
      "dependency-issue",
      "performance-regression",
    ];
    const engineId =
      rule?.processor.engine ??
      (complexTypes.includes(payload.type) ? "complex" : "fast");
    next.tasks.unshift(queuedEntry(task, payload.title.trim(), engineId));
    message = `已创建模拟任务「${payload.title.trim()}」，等待执行`;
  } else if (type === "retry") {
    taskId = nextTaskId(next.tasks);
    const task = clone(target.task);
    const previousCount = task.payload.context.retryCount;
    const retryCount =
      (Number.isInteger(previousCount) && previousCount >= 0
        ? previousCount
        : 0) + 1;
    task.id = taskId;
    task.payload.context = {
      ...task.payload.context,
      demo: true,
      retryCount,
      retryOf: id,
    };
    task.metadata = {
      triggeredBy: "manual",
      triggeredAt: at,
      createdAt: at,
      source: DEMO_SOURCE,
    };
    next.tasks.unshift(
      queuedEntry(
        task,
        `${target.title} · 重试 ${retryCount}`,
        target.engineId,
      ),
    );
    message = `已为 ${id} 创建第 ${retryCount} 次模拟重试，原记录保留`;
  } else if (
    [
      "approve",
      "approve-gate",
      "reject",
      "reject-gate",
      "resubmit-approval",
    ].includes(type)
  ) {
    const index = next.tasks.findIndex((item) => item.task.id === id);
    const result = applyApprovalAction(
      next.tasks[index],
      { type, payload },
      at,
    );
    next.tasks[index] = result.entry;
    message = result.message;
  } else {
    const entry = next.tasks.find((item) => item.task.id === id);
    if (entry.approvalFlow) entry.approvalFlow = cancelApprovalFlow(entry, at);
    entry.status = {
      ...entry.status,
      status: "cancelled",
      completedAt: at,
      message: "任务已手动取消（演示）",
    };
    if (entry.reviewState === "pending") delete entry.reviewState;
    entry.trace = entry.trace.map((step) =>
      step.status === "running"
        ? { ...step, status: "pending", detail: "任务已取消，该步骤未完成" }
        : step,
    );
    message = `已取消任务「${entry.title}」（仅演示）`;
    if (entry.result) entry.result.logs.push(`[${at}] [DEMO] ${message}`);
  }

  next.generatedAt = at;
  next.activity.unshift({
    id: `demo-action-${timestamp}-${next.activity.length + 1}`,
    at,
    action: type,
    message,
    ...(taskId ? { taskId } : {}),
    actor: "你（演示）",
    level: ["reject", "reject-gate", "cancel"].includes(type)
      ? "warning"
      : "info",
  });
  return next;
}
