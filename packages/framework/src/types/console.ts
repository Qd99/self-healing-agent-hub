/** Public management-console contract. Keep execution models unchanged. */
import type { Task, TaskStatusInfo, Priority } from "./task.js";
import type { Result } from "./result.js";
import type { WorkflowEngine } from "../engines/base.js";

/** Dates cross the JSON boundary as ISO 8601 strings; unknown payloads stay unknown. */
export type Serialized<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Serialized<Item>[]
    : T extends object
      ? { [Key in keyof T]: Serialized<T[Key]> }
      : T;

export type SerializedTask = Serialized<Task>;
export type SerializedTaskStatusInfo = Serialized<TaskStatusInfo>;
export type SerializedResult = Serialized<Result>;
export type ConsoleReviewState = "pending" | "approved" | "rejected";

export type ConsoleApprovalNodeStatus =
  | "completed"
  | "pending"
  | "blocked"
  | "rejected"
  | "queued"
  | "cancelled"
  | "unknown";

export interface ConsoleApprovalGate {
  id: "code-review" | "execution-auth";
  title: string;
  role: string;
  detail: string;
  actor: string;
  status: "pending" | "blocked" | "approved" | "rejected";
  decidedAt?: string;
  comment?: string;
}

export interface ConsoleApprovalDecision {
  id: string;
  round: number;
  nodeId: string;
  decision: "submitted" | "approved" | "rejected" | "resubmitted" | "cancelled";
  actor: string;
  at: string;
  comment: string;
}

/** Explicit evidence, never a conclusion inferred from an enabled configuration. */
export interface ConsoleApprovalFlow {
  schemaVersion: 1;
  source: "demo-fixture" | "server";
  round: number;
  status: ConsoleReviewState | "cancelled";
  checks: Partial<
    Record<
      "plan" | "quality" | "safety",
      {
        status: ConsoleApprovalNodeStatus;
        detail: string;
        at?: string;
      }
    >
  >;
  gates: ConsoleApprovalGate[];
  history: ConsoleApprovalDecision[];
}

export interface ConsoleTraceStep {
  id: string;
  parentId?: string;
  title: string;
  kind: "agent" | "tool" | "check";
  status: "completed" | "running" | "pending" | "failed";
  durationMs?: number;
  detail?: string;
}

export interface ConsoleFileDiff {
  path: string;
  additions: number;
  deletions: number;
  lines: { type: "context" | "add" | "remove"; content: string }[];
}

/** Approval, trace and diff are UI metadata; they do not add values to TaskStatus. */
export interface ConsoleTask {
  task: SerializedTask;
  status: SerializedTaskStatusInfo;
  title: string;
  engineId: string;
  reviewState?: ConsoleReviewState;
  approvalFlow?: ConsoleApprovalFlow;
  trace: ConsoleTraceStep[];
  diff: ConsoleFileDiff[];
  result?: SerializedResult;
}

export interface ConsoleActivity {
  id: string;
  at: string;
  action: string;
  message: string;
  taskId?: Task["id"];
  actor?: string;
  level?: "info" | "success" | "warning" | "error";
}

export interface ConsoleCapabilities {
  trigger: boolean;
  cancel: boolean;
  retry: boolean;
  approve: boolean;
  updateRules: boolean;
}

export interface ConsoleEngine {
  id: string;
  name: ReturnType<WorkflowEngine["getInfo"]>["name"];
  type: string;
  provider?: string;
  model?: string;
  configured: boolean;
  implemented: boolean;
  status: "unavailable" | "idle" | "running" | "error";
  message: string;
}

export interface ConsoleRule {
  id: string;
  name: string;
  enabled: boolean;
  match: {
    taskType?: Task["type"];
    "context.retryCount"?: Partial<
      Record<"$lt" | "$lte" | "$gt" | "$gte" | "$eq", number>
    >;
  };
  processor: {
    engine: string;
    action: string;
    priority: Priority;
    workflow?: string;
  };
}

export interface ConsoleSafety {
  maxFilesPerFix?: number;
  protectedPaths?: string[];
  requiredChecks?: string[];
  circuitBreaker?: {
    enabled?: boolean;
    failureThreshold?: number;
    windowMinutes?: number;
    cooldownMinutes?: number;
  };
  autoRollback?: { enabled?: boolean; ciTimeout?: number; notifyOn?: string[] };
}

export interface ConsoleTriggers {
  webhooks?: { enabled?: boolean; events?: string[] };
  cron?: Partial<
    Record<
      "healthCheck" | "qualityScan" | "dependencyAudit",
      { enabled?: boolean; schedule?: string }
    >
  >;
  manual?: { enabled?: boolean; requireAuth?: boolean };
}

export interface ConsoleSnapshot {
  apiVersion: 1;
  mode: "live" | "demo";
  generatedAt: string;
  configSource: "example" | "configured";
  rulesSource: "example" | "configured";
  rulesVersion: string;
  project: { id: string; repo: string; defaultBranch: string };
  capabilities: ConsoleCapabilities;
  engines: ConsoleEngine[];
  rules: ConsoleRule[];
  safety: ConsoleSafety;
  triggers: ConsoleTriggers;
  tasks: ConsoleTask[];
  activity: ConsoleActivity[];
}

export interface ConsoleApiError {
  error: { code: string; message: string };
}
