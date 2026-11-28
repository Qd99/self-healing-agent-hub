const names = {
  pending: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
  review: "待审批",
  reconciliation: "待核对",
};
const phases = {
  diagnose: "诊断",
  review: "方案审阅",
  execute: "执行",
  done: "已结束",
};
const priorities = { urgent: "紧急", high: "高", medium: "中", low: "低" };
const tones = {
  running: "info",
  completed: "success",
  failed: "error",
  review: "warning",
  reconciliation: "warning",
};
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const matchesScope = (row, scope) =>
  scope === "running"
    ? row.state === "running"
    : scope === "attention"
      ? row.attention
      : scope === "queued"
        ? row.queued
        : scope === "ended"
          ? row.ended
          : true;

export function taskRows(snapshot) {
  return (snapshot?.tasks ?? [])
    .map((item) => {
      const observations = item.observation?.events ?? [];
      const recent = observations
        .filter((x) => timestamp(x.observedAt))
        .slice()
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
      const known = [
        [recent?.observedAt, "执行器观测"],
        [item.status.completedAt, "任务结束"],
        [item.status.startedAt, "任务启动"],
        [item.task.metadata?.createdAt, "任务创建"],
      ]
        .filter(([at]) => timestamp(at))
        .sort((a, b) => Date.parse(b[0]) - Date.parse(a[0]));
      const state =
        item.reconciliation?.status === "required"
          ? "reconciliation"
          : item.reviewState === "pending"
            ? "review"
            : item.status.status;
      return {
        id: item.task.id,
        title: item.title,
        revision: item.revision,
        type: item.task.type,
        state,
        statusLabel: names[state] ?? "状态未知",
        tone: tones[state] ?? "neutral",
        phase: phases[item.execution.phase] ?? "未提供",
        progress: item.status.progress,
        currentAction: recent
          ? `${recent.stage} · ${recent.state}`
          : item.status.message || "未采集",
        message: item.status.message,
        engineId: item.engineId,
        engineName:
          snapshot.engines?.find((x) => x.id === item.engineId)?.name ??
          item.engineId ??
          "未分配",
        priority:
          priorities[item.task.priority] ?? item.task.priority ?? "未提供",
        lastKnownAt: known[0]?.[0] ?? null,
        timeSource: known[0]?.[1] ?? "未知",
        attention: ["failed", "review", "reconciliation"].includes(state),
        queued: state === "pending",
        ended: ["completed", "cancelled", "skipped"].includes(state),
        source:
          item.task.payload?.context?.source?.kind ??
          item.task.metadata?.source ??
          "未提供",
      };
    })
    .sort(
      (a, b) =>
        (Date.parse(b.lastKnownAt) || 0) - (Date.parse(a.lastKnownAt) || 0) ||
        a.id.localeCompare(b.id),
    );
}

export function overviewModel(snapshot) {
  const rows = taskRows(snapshot);
  return {
    counts: {
      total: rows.length,
      running: rows.filter((x) => x.state === "running").length,
      attention: rows.filter((x) => x.attention).length,
      queued: rows.filter((x) => x.queued).length,
      ended: rows.filter((x) => x.ended).length,
    },
    recent: rows.slice(0, 7),
    attention: rows.filter((x) => x.attention).slice(0, 5),
    generatedAt: snapshot?.generatedAt ?? null,
    project: snapshot?.project,
    storage: snapshot?.storage?.status,
    engines: (snapshot?.engines ?? []).map(({ id, name, status }) => ({
      id,
      name,
      status,
    })),
  };
}

export function taskListModel(
  snapshot,
  { query = "", scope = "all", page = 1, pageSize = 20 } = {},
) {
  const rows = taskRows(snapshot),
    q = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(
    (row) =>
      matchesScope(row, scope) &&
      (!q ||
        [row.title, row.id, row.engineName, row.type]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q)),
  );
  const size =
    Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 100
      ? pageSize
      : 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(pageCount, Math.max(1, Number(page) || 1));
  return {
    items: filtered.slice((current - 1) * size, current * size),
    total: filtered.length,
    page: current,
    pageCount,
    pageSize: size,
    query,
    scope,
    counts: overviewModel(snapshot).counts,
  };
}

export function taskDetail(snapshot, id) {
  const item = snapshot?.tasks?.find((x) => x.task.id === id);
  if (!item) return null;
  return {
    ...taskRows(snapshot).find((x) => x.id === id),
    repo: item.task.payload?.repo ?? null,
    branch: item.task.payload?.branch ?? null,
    workerId: item.execution.workerId ?? null,
    leaseExpiresAt: item.execution.leaseExpiresAt ?? null,
    observations: (item.observation?.events ?? []).map((x) => ({
      stage: x.stage,
      state: x.state,
      observedAt: x.observedAt,
    })),
    trace: (item.trace ?? []).map((x) => ({
      title: x.title,
      status: x.status,
      durationMs: x.durationMs,
    })),
    proposal: item.proposal?.summary ?? null,
    result: item.result
      ? {
          success: item.result.success,
          action: item.result.action,
          error: item.result.error?.message ?? null,
        }
      : null,
  };
}
