import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { openJournal } from "../apps/healing-worker/src/journal.mjs";
test("journal enforces one owner, private permissions, atomic persistence and secret rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-journal-"));
  try {
    let j = await openJournal(dir);
    await assert.rejects(openJournal(dir), /locked/);
    await j.put("task", {
      phase: "execute",
      outbox: { body: { success: false } },
    });
    assert.equal((await stat(join(dir, "journal.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await assert.rejects(j.put("bad", { token: "secret" }), /secret/);
    await j.close();
    j = await openJournal(dir);
    assert.equal(j.get("task").phase, "execute");
    assert.deepEqual(
      j.list().map((x) => x.id),
      ["task"],
    );
    await j.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("simultaneous stale-lock recovery admits at most one owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-lock-"));
  let journals = [];
  try {
    await writeFile(
      join(dir, "worker.lock"),
      JSON.stringify({
        pid: 2147483647,
        host: hostname(),
        id: "00000000-0000-4000-8000-000000000099",
      }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => openJournal(dir)),
    );
    journals = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    assert.equal(journals.length, 1);
    await journals[0].put("task", { state: "claimed" });
  } finally {
    for (const j of journals) await j.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
