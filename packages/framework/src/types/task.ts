/**
 * 标准任务接口
 * 所有事件被标准化为 Task 对象
 */

export type TaskType =
  | "lint-error"
  | "format-error"
  | "type-error"
  | "unit-test-failure"
  | "e2e-test-failure"
  | "architecture-violation"
  | "security-issue"
  | "ci-failure"
  | "doc-outdated"
  | "dependency-issue"
  | "performance-regression";

export type Priority = "urgent" | "high" | "medium" | "low";

export type TriggerSource = "webhook" | "cron" | "manual";

export interface Task {
  /** 唯一任务 ID */
  id: string;

  /** 任务类型 */
  type: TaskType;

  /** 优先级 */
  priority: Priority;

  /** 任务负载 */
  payload: TaskPayload;

  /** 元数据 */
  metadata: TaskMetadata;
}

export interface TaskPayload {
  /** 仓库全名 (owner/repo) */
  repo: string;

  /** 分支名 */
  branch: string;

  /** 相关文件列表 */
  files: string[];

  /** 错误详情（格式根据任务类型而异） */
  errorDetails: unknown;

  /** 上下文信息 */
  context: TaskContext;
}

export interface JenkinsSource {
  kind: "jenkins";
  sourceId: string;
  eventId: string;
  generation: string;
  jobName: string;
  buildNumber: number;
  buildUrl: string;
  repo: string;
  branch: string;
  commitSha: string;
  result: "FAILURE";
  observedAt: string;
}

export interface TaskContext {
  source?: JenkinsSource;
  /** Commit SHA */
  commitSha?: string;

  /** PR 编号 */
  prNumber?: number;

  /** Issue 编号 */
  issueNumber?: number;

  /** CI Job URL */
  ciJobUrl?: string;

  /** 重试次数 */
  retryCount?: number;

  /** 其他上下文 */
  [key: string]: unknown;
}

export interface TaskMetadata {
  /** 触发来源 */
  triggeredBy: TriggerSource;

  /** 触发时间 */
  triggeredAt: Date;

  /** 事件来源详情 */
  source: string;

  /** 创建时间 */
  createdAt: Date;
}

/**
 * 任务状态
 */
export type TaskStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

/**
 * 任务状态信息
 */
export interface TaskStatusInfo {
  taskId: string;
  status: TaskStatus;
  progress?: number;
  message?: string;
  startedAt?: Date;
  completedAt?: Date;
}
