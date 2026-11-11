/**
 * 标准结果接口
 * 所有处理器返回统一的 Result 对象
 */

export type ActionType =
  | "committed" // 直接提交到仓库
  | "pr-created" // 创建 Pull Request
  | "issue-created" // 创建 Issue
  | "retry" // 重试（用于 CI 失败等）
  | "failed" // 执行失败
  | "skipped"; // 跳过（熔断等）

export interface Result {
  /** 任务 ID */
  taskId: string;

  /** 是否成功 */
  success: boolean;

  /** 执行的操作类型 */
  action: ActionType;

  /** 修改信息 */
  changes?: ResultChanges;

  /** 执行日志 */
  logs: string[];

  /** 证据链 */
  evidence: ResultEvidence;

  /** 性能指标 */
  timings: ResultTimings;

  /** 错误信息（如果失败） */
  error?: ResultError;
}

export interface ResultChanges {
  /** 修改的文件列表 */
  files: string[];

  /** Commit SHA（如果有提交） */
  commit?: string;

  /** PR 编号（如果创建了 PR） */
  pr?: number;

  /** Issue 编号（如果创建了 Issue） */
  issue?: number;

  /** 其他变更 */
  [key: string]: unknown;
}

export interface ResultEvidence {
  /** 修复前状态 */
  beforeState: unknown;

  /** 修复后状态 */
  afterState: unknown;

  /** 运行的测试 */
  testsRun?: string[];

  /** 通过的检查 */
  checksPass?: string[];

  /** 失败的检查 */
  checksFail?: string[];

  /** 截图或其他证据 */
  artifacts?: string[];
}

export interface ResultTimings {
  /** 开始时间 */
  startedAt: Date;

  /** 完成时间 */
  completedAt: Date;

  /** 持续时间（毫秒） */
  durationMs: number;

  /** 各阶段耗时 */
  stages?: Record<string, number>;
}

export interface ResultError {
  /** 错误代码 */
  code: string;

  /** 错误消息 */
  message: string;

  /** 错误堆栈 */
  stack?: string;

  /** 是否可重试 */
  retriable: boolean;

  /** 建议的操作 */
  suggestedAction?: string;
}

/**
 * 健康状态
 */
export interface HealthStatus {
  /** 是否健康 */
  healthy: boolean;

  /** 状态消息 */
  message?: string;

  /** 详细信息 */
  details?: Record<string, unknown>;

  /** 检查时间 */
  checkedAt: Date;
}
