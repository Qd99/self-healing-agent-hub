/** Read-only view of the live Autoloop workbench state.
 *
 * The Autoloop dashboard already owns the real run ledger (runs, cards, agents,
 * lines, channels). This connector projects that state for the V20 console
 * instead of duplicating it: the Hub never writes to Autoloop, never invents
 * records, and reports the upstream snapshot time so the UI can label staleness.
 */
import { createHash } from "node:crypto";
import { HealingError } from "./console-store.mjs";

const fail = (status, code, message) => {
  throw new HealingError(status, code, message);
};
const unconfigured = () =>
  fail(422, "WORKBENCH_UNCONFIGURED", "此数据源尚未配置或未启用。");

/** Loopback-only plain HTTP by default; the Autoloop dashboard rejects non-local callers. */
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
function autoloopBase(raw) {
  if (typeof raw !== "string" || !raw.trim()) unconfigured();
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    unconfigured();
  }
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !loopback.has(url.hostname)
  )
    unconfigured();
  return url.origin;
}

const str = (value, max = 400) =>
  typeof value === "string" ? value.slice(0, max) : "";
const num = (value) =>
  Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const bool = (value) => (typeof value === "boolean" ? value : null);
const iso = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bound every list so one upstream snapshot cannot blow up a browser payload. */
const cap = (list, max) => (Array.isArray(list) ? list.slice(0, max) : []);

function usage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input: num(value.input),
    output: num(value.output),
    cost: num(value.cost),
  };
}

function totals(value) {
  if (!value || typeof value !== "object") return null;
  return {
    running: num(value.running),
    queued: num(value.queued),
    retrying: num(value.retrying),
    unknown: num(value.unknown),
    done: num(value.done),
    doneToday: num(value.doneToday),
    nothing: num(value.nothing),
    attention: num(value.attention),
    usage: usage(value.usage),
  };
}

/** A run is an execution record; it is never promoted to a Hub healing task. */
function run(row) {
  return {
    id: num(row.id),
    rule: str(row.rule, 200),
    agent: str(row.agent, 120),
    state: str(row.state, 40),
    attempts: num(row.attempts),
    createdAt: iso(row.createdAt),
    claimedAt: iso(row.claimedAt),
    finishedAt: iso(row.finishedAt),
    summary: str(row.summary, 600),
    error: str(row.error, 600),
    link: str(row.link, 600),
    manual: bool(row.manual),
    stopping: bool(row.stopping),
    events: cap(row.events, 20).map((event) => ({
      source: str(event?.source, 60),
      type: str(event?.type, 120),
      subject: str(event?.subject, 300),
      summary: str(event?.summary, 600),
      link: str(event?.link, 600),
    })),
  };
}

/** A card is a pending decision item for a human, not an approval record. */
function card(row) {
  return {
    id: num(row.id),
    kind: str(row.kind, 60),
    state: str(row.state, 40),
    title: str(row.title, 300),
    text: str(row.text, 1200),
    rule: str(row.rule, 200),
    lane: str(row.lane, 200),
    link: str(row.link, 600),
    options: cap(row.options, 20).map((option) => str(option, 200)),
    createdAt: iso(row.createdAt),
    decidedAt: iso(row.decidedAt),
    closedAt: iso(row.closedAt),
    by: str(row.by, 120),
  };
}

function agent(row) {
  return {
    id: str(row.id, 120),
    name: str(row.name, 200),
    use: str(row.use, 60),
    worker: str(row.worker, 120),
    online: bool(row.online),
    seenAt: iso(row.seenAt),
    totals: totals(row.totals),
  };
}

function line(row) {
  return {
    id: str(row.id, 200),
    name: str(row.name, 200),
    group: str(row.group, 200),
    agent: str(row.agent, 120),
    source: str(row.source, 60),
    types: cap(row.types, 100).map((type) => str(type, 120)),
    every: str(row.every, 120),
    next: iso(row.next),
    paused: row.paused ? { since: iso(row.paused.since), until: iso(row.paused.until) } : null,
    totals: totals(row.totals),
  };
}

function channel(row) {
  return {
    id: str(row.id, 120),
    name: str(row.name, 200),
    online: bool(row.online),
    seenAt: iso(row.seenAt),
    lastFailure:
      row.lastFailure && typeof row.lastFailure === "object"
        ? {
            card: num(row.lastFailure.card),
            tries: num(row.lastFailure.tries),
            givenUp: bool(row.lastFailure.givenUp),
          }
        : null,
  };
}

function pause(row) {
  return {
    name: str(row.name, 200),
    by: str(row.by, 120),
    reason: str(row.reason, 600),
    since: iso(row.since),
    until: iso(row.until),
    skipped: num(row.skipped?.count),
  };
}

/** Counts every card that still needs a human decision. */
function attention(cards) {
  return cards.filter((row) => row.state === "open").length;
}

/**
 * Projects the Autoloop snapshot into the shapes the V20 console renders.
 * Every list is explicitly capped and the upstream snapshot time is returned
 * alongside so the UI can distinguish fresh data from a stale copy.
 */
export function projectAutoloopState(state) {
  if (
    !state ||
    typeof state !== "object" ||
    !Number.isSafeInteger(state.seq) ||
    !Array.isArray(state.agents) ||
    !Array.isArray(state.channels)
  )
    fail(502, "UPSTREAM_FORMAT", "Autoloop 快照格式无效。");

  const runs = cap(state.runs, 120).map(run);
  const cards = cap(state.cards, 200).map(card);
  const agents = cap(state.agents, 60).map(agent);
  const lines = cap(state.lines, 60).map(line);
  const channels = cap(state.channels, 30).map(channel);
  const pauses = cap(state.pauses, 30).map(pause);

  return {
    source: "autoloop",
    observedAt: iso(state.now) ?? new Date(0).toISOString(),
    seq: state.seq,
    timezone: str(state.timezone, 60),
    totals: {
      ...(totals(state.totals) ?? {}),
      attention: num(state.totals?.attention) ?? attention(cards),
    },
    spending: {
      today: usage(state.spending?.today),
      week: usage(state.spending?.week),
    },
    runs,
    cards,
    recentCards: cap(state.recentCards, 40).map(card),
    agents,
    lines,
    channels,
    pauses,
    hasMore: bool(state.hasMore),
  };
}

/**
 * Bounded read of the Autoloop dashboard state. The dashboard is loopback-only
 * and performs its own host/origin checks; the Hub only forwards a GET.
 */
export function createAutoloopConnector({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = env.HUB_AUTOLOOP_STATE_URL?.trim() || "";
  const enabled = env.HUB_AUTOLOOP_READ_ENABLED === "1";
  return {
    enabled,
    async read() {
      if (!enabled) unconfigured();
      const origin = autoloopBase(base);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetchImpl(`${origin}/api/state`, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected)
          fail(502, "UPSTREAM_UNAVAILABLE", "Autoloop 状态读取失败，请检查服务状态。");
        const state = await response.json();
        const projected = projectAutoloopState(state);
        return { ...projected, digest: digest(projected) };
      } catch (error) {
        if (error instanceof HealingError) throw error;
        fail(502, "UPSTREAM_UNAVAILABLE", "Autoloop 状态读取失败，请检查服务状态。");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
