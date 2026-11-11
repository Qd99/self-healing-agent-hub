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
  | "running"
  | "failed"
  | "completed"
  | "pending"
  | "blocked"
  | "rejected"
  | "queued"
  | "cancelled"
  | "skipped"
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

export interface ConsoleReconciliationResolution {
  outcome: "no-changes" | "changes-recorded";
  note: string;
  actor: string;
  at: string;
}

export interface ConsoleReconciliation {
  status: "required" | "resolved";
  reason: string;
  updatedAt: string;
  resolution?: ConsoleReconciliationResolution;
  history?: ConsoleReconciliationResolution[];
}

/** Approval, trace and diff are UI metadata; they do not add values to TaskStatus. */
export interface ConsoleTask {
  task: SerializedTask;
  status: SerializedTaskStatusInfo;
  title: string;
  engineId: string;
  /** Required for live writes; omitted by legacy and explicit demo snapshots. */
  revision?: number;
  execution?: {
    phase: "diagnose" | "review" | "execute" | "done";
    workerId?: string;
    leaseExpiresAt?: string;
    cancelRequested?: boolean;
    /** Historical source of this interruption; resolving it never resumes this task. */
    blockedByReconciliation?: { taskId: string; reason: string; at: string };
  };
  /** Candidate check evidence; final execution evidence remains in result. */
  evidence?: Partial<SerializedResult["evidence"]>;
  verification?: ConsoleVerification;
  proposal?: {
    version?: 2;
    candidate?: CandidateV2;
    kind?: "action" | "code-change";
    id: string;
    summary: string;
    submittedAt: string;
    contentHash: string;
  };
  reviewState?: ConsoleReviewState;
  approvalFlow?: ConsoleApprovalFlow;
  trace: ConsoleTraceStep[];
  diff: ConsoleFileDiff[];
  result?: SerializedResult;
  reconciliation?: ConsoleReconciliation;
  resultReceipts?: {
    kind: "complete" | "cancelled";
    receivedAt: string;
    result?: SerializedResult;
  }[];
}

export interface ConsoleActivity {
  id: string;
  at: string;
  action: string;
  message: string;
  taskId?: Task["id"];
  ruleId?: string;
  actor?: string;
  level?: "info" | "success" | "warning" | "error";
}

export interface ConsoleCapabilities {
  trigger: boolean;
  cancel: boolean;
  retry: boolean;
  approve: boolean;
  updateRules: boolean;
  updateMonitoring?: boolean;
  reconcile?: boolean;
  importCi?: boolean;
  verifyResult?: boolean;
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

/** Public monitoring input/export; credentials and remote health are excluded. */
export interface MonitoringConfig {
  grafana: {
    baseUrl: string;
    dashboardUid: string;
    /** Defaults to "healing-overview" after validation. */
    dashboardSlug?: string;
    orgId?: number;
    /** Defaults to "namespace"; omit the URL's var- prefix. */
    namespaceVariable?: string;
    /** Defaults to "datasource"; must differ from namespaceVariable. */
    datasourceVariable?: string;
  };
  datasource: {
    /** Defaults to "prometheus". */
    type?: "prometheus";
    uid: string;
    /** Display only; defaults to an empty string and never replaces uid. */
    name?: string;
  };
  /** Explicit watched namespaces; wildcard/all-cluster values are unsupported. */
  namespaces: string[];
}

/** Validated monitoring configuration with model defaults applied. */
export interface MonitoringResolvedConfig {
  grafana: {
    baseUrl: string;
    dashboardUid: string;
    dashboardSlug: string;
    orgId?: number;
    namespaceVariable: string;
    datasourceVariable: string;
  };
  datasource: {
    type: "prometheus";
    uid: string;
    name: string;
  };
  namespaces: string[];
}

export interface MonitoringValidationError {
  field: string;
  /** A fixed explanation; rejected input values are never echoed. */
  message: string;
}

interface MonitoringSnapshotEvidence {
  /** Structural validation never establishes remote connectivity. */
  connectivity: "unverified";
  message: string;
}

/** Invalid known values are redacted to null; optional orgId remains optional. */
type MonitoringRedactedFields<T> = { [Field in keyof T]: T[Field] | null };

export type MonitoringSnapshot =
  | (MonitoringSnapshotEvidence & {
      status: "unconfigured";
      configured: false;
      errors: [];
      grafana: null;
      datasource: null;
      namespaces: [];
    })
  | (MonitoringSnapshotEvidence & {
      status: "invalid";
      configured: false;
      errors: MonitoringValidationError[];
      grafana: MonitoringRedactedFields<
        MonitoringResolvedConfig["grafana"]
      > | null;
      datasource: MonitoringRedactedFields<
        MonitoringResolvedConfig["datasource"]
      > | null;
      namespaces: string[];
    })
  | (MonitoringSnapshotEvidence &
      MonitoringResolvedConfig & {
        /** Ready to construct a link; no connection or metric was verified. */
        status: "ready";
        configured: true;
        errors: [];
      });

export interface ConsoleStorageUsage {
  used: number;
  limit: number;
}

/** Capacity and the last persistence failure; includes no private store fields. */
export interface ConsoleStorage {
  status: "ready" | "read-only";
  reason: "STORE_FULL" | "STORE_WRITE_ERROR" | null;
  message: string;
  usage: Record<
    "bytes" | "tasks" | "activity" | "requests" | "workers",
    ConsoleStorageUsage
  >;
}

/** New clients use the resource version; legacy clients use the global version. */
export type ConsoleConfigRevisionRequest =
  | { expectedConfigRevision: number; expectedRevision?: number }
  | { expectedConfigRevision?: never; expectedRevision: number };

export type ConsoleRuleUpdateRequest = ConsoleConfigRevisionRequest & {
  enabled: boolean;
};

export type ConsoleMonitoringSaveRequest = ConsoleConfigRevisionRequest & {
  monitoring: MonitoringConfig;
};

export interface ConsoleSnapshot {
  apiVersion: 1;
  mode: "live" | "demo";
  generatedAt: string;
  /** Monotonic persisted version; retained for legacy configuration writes. */
  revision?: number;
  /** Independent resource versions, unaffected by Worker activity. */
  configRevisions?: { rules: number; monitoring: number };
  /** Optional for legacy/demo snapshots. Read-only snapshots retain committed facts. */
  storage?: ConsoleStorage;
  /** Session-bound CSRF token, never a management or worker bearer token. */
  csrfToken?: string;
  auth?: { required: boolean; actor: string };
  configSource: "example" | "configured";
  rulesSource: "example" | "configured";
  rulesVersion: string;
  rulesOverridden?: boolean;
  monitoringSource?: "configuration" | "saved";
  project: { id: string; repo: string; defaultBranch: string };
  capabilities: ConsoleCapabilities;
  engines: ConsoleEngine[];
  rules: ConsoleRule[];
  safety: ConsoleSafety;
  triggers: ConsoleTriggers;
  /** Optional for compatibility with existing API v1 snapshots. */
  monitoring?: MonitoringSnapshot;
  integrations?: ConsoleIntegrations;
  tasks: ConsoleTask[];
  activity: ConsoleActivity[];
}

export interface ConsoleApiError {
  error: {
    code: string;
    message: string;
    fieldErrors?: MonitoringValidationError[];
  };
}

export interface ConsoleMutationResponse {
  snapshot: ConsoleSnapshot;
  message: string;
  taskId?: string;
  report?: ConsoleBulkReport;
}

export interface ConsoleBulkReport {
  type: "cancel" | "retry";
  requested: number;
  applied: { id: string; title: string; newId?: string }[];
  skipped: { id: string; title: string; reason: string; code?: string }[];
}

export interface ConsoleTriggerRequest {
  title: string;
  type: Task["type"];
  priority: Priority;
  branch?: string;
  description?: string;
  requestId?: string;
}

export interface ConsoleTaskActionRequest {
  expectedRevision: number;
  requestId?: string;
}

export interface ConsoleBulkRequest {
  type: "cancel" | "retry";
  items: { id: string; revision: number }[];
  requestId?: string;
}

export interface ConsoleApprovalRequest {
  decision: "approve" | "reject" | "resubmit";
  expectedRevision: number;
  nodeId?: ConsoleApprovalGate["id"];
  round: number;
  comment: string;
}

export interface ConsoleMonitoringCheck {
  status: "connected" | "error" | "unconfigured";
  checkedAt: string;
  message: string;
  checks: {
    grafana: "ok" | "error" | "unknown";
    datasource: "ok" | "error" | "unknown";
  };
  datasource?: { uid: string; name: string; type: "prometheus" };
}

/** Exact executable identity; legacy proposals remain readable. */
export interface CandidateV2 {
  version: 2;
  baseCommitSha: string;
  patchSha256: string;
  treeSha: string;
  artifactId: string;
}
export interface ConsoleVerification {
  schemaVersion: 1;
  provider: "github";
  status: "pending" | "passed" | "failed" | "mismatch" | "error" | "stale";
  checkedAt: string;
  message: string;
  target: {
    proposalId: string;
    proposalHash: string;
    repo: string;
    prNumber: number;
    baseCommitSha: string;
    headCommitSha: string;
    expectedTreeSha: string;
    policyHash: string;
  };
  checks: {
    pullRequest: "pass" | "fail" | "unknown";
    commit: "pass" | "fail" | "unknown";
    files: "pass" | "fail" | "unknown";
    ci: "pass" | "fail" | "pending" | "unknown";
  };
  statuses: { context: string; state: string; id: number; updatedAt: string }[];
}
export interface ConsoleIntegrations {
  jenkins: {
    configured: boolean;
    sourceId?: string;
    jobName?: string;
    branch?: string;
    message: string;
  };
  verification: {
    configured: boolean;
    requiredStatusContexts: string[];
    message: string;
  };
}
export interface WorkerClaimRequest {
  engineId: string;
  workerId: string;
  actions?: ("auto-commit" | "create-pr" | "create-issue" | "retry")[];
  sourceKinds?: "jenkins"[];
  candidateVersions?: (1 | 2)[];
  phases?: ("diagnose" | "execute")[];
}
export interface CandidateAcknowledgement {
  taskId: string;
  proposal: {
    id: string;
    version: 2;
    contentHash: string;
    candidate: CandidateV2;
  };
  message: string;
}
export interface JenkinsImportRequest {
  sourceId: string;
  buildNumber: number;
  requestId?: string;
}
export interface ConsoleVerificationRequest {
  expectedRevision: number;
}
