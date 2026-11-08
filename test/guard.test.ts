import { test } from "node:test";
import assert from "node:assert/strict";
import { clearStaleLocks, findAdvisoryLockHolders, FIND_SQL, type Queryable } from "../src/index.ts";

type Row = { pid: number; key: string | null; application_name: string; state: string | null; idle_seconds: number; last_query: string };
const row = (over: Partial<Row> = {}): Row => ({ pid: 101, key: "72707369", application_name: "prisma", state: "idle", idle_seconds: 600, last_query: "SELECT 1", ...over });

function fake(rows: Row[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: Queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("pg_terminate_backend")) return { rows: [{ ok: true }] };
      return { rows };
    },
  };
  return { db, calls, terminations: () => calls.filter((c) => c.sql.includes("pg_terminate_backend")).map((c) => c.params![0]) };
}
const quiet = { log: () => {} };

test("the default is a dry run: holders are reported and nothing is terminated", async () => {
  const f = fake([row()]);
  const r = await clearStaleLocks(f.db, quiet);
  assert.equal(r.dryRun, true);
  assert.equal(r.found.length, 1);
  assert.deepEqual(r.terminated, []);
  assert.deepEqual(f.terminations(), []);
});

test("terminate:true terminates each stale holder", async () => {
  const f = fake([row({ pid: 101 }), row({ pid: 202 })]);
  const r = await clearStaleLocks(f.db, { ...quiet, terminate: true });
  assert.deepEqual(r.terminated, [101, 202]);
  assert.deepEqual(f.terminations(), [101, 202]);
});

test("the query never targets the guard's own connection", () => {
  assert.match(FIND_SQL, /l\.pid <> pg_backend_pid\(\)/);
  assert.match(FIND_SQL, /l\.granted/);
});

test("lockKeys keeps only matching keys and drops two-int locks", async () => {
  const f = fake([row({ pid: 1, key: "72707369" }), row({ pid: 2, key: "5" }), row({ pid: 3, key: null })]);
  const found = await findAdvisoryLockHolders(f.db, { lockKeys: [72707369n] });
  assert.deepEqual(found.map((h) => h.pid), [1]);
});

test("recent holders are left alone: olderThanSeconds protects a migration that is running right now", async () => {
  const f = fake([row({ pid: 1, idle_seconds: 5 }), row({ pid: 2, idle_seconds: 120 })]);
  const found = await findAdvisoryLockHolders(f.db, { olderThanSeconds: 30 });
  assert.deepEqual(found.map((h) => h.pid), [2]);
});

test("applicationNames narrows the holders", async () => {
  const f = fake([row({ pid: 1, application_name: "prisma" }), row({ pid: 2, application_name: "billing-worker" })]);
  const found = await findAdvisoryLockHolders(f.db, { applicationNames: ["prisma"] });
  assert.deepEqual(found.map((h) => h.pid), [1]);
});

test("a backend holding several locks is listed once", async () => {
  const f = fake([row({ pid: 7, key: "1" }), row({ pid: 7, key: "2" })]);
  assert.equal((await findAdvisoryLockHolders(f.db)).length, 1);
});

test("maxTerminate refuses a run that would terminate too many backends", async () => {
  const f = fake(Array.from({ length: 6 }, (_, i) => row({ pid: 100 + i })));
  const r = await clearStaleLocks(f.db, { ...quiet, terminate: true, maxTerminate: 5 });
  assert.deepEqual(r.terminated, []);
  assert.match(r.refused ?? "", /limit is 5/);
  assert.deepEqual(f.terminations(), []);
});

test("it never throws: a query failure is reported as nothing found", async () => {
  const db: Queryable = { query: async () => Promise.reject(new Error("connection refused")) };
  const lines: string[] = [];
  const r = await clearStaleLocks(db, { terminate: true, log: (l) => lines.push(l) });
  assert.deepEqual(r.found, []);
  assert.match(lines[0], /skipped \(connection refused\)/);
});

test("a failed terminate is logged and the rest still run", async () => {
  const calls: number[] = [];
  const db: Queryable = {
    async query(sql, params) {
      if (sql.includes("pg_terminate_backend")) {
        calls.push(Number(params![0]));
        if (params![0] === 1) throw new Error("permission denied");
        return { rows: [{ ok: true }] };
      }
      return { rows: [row({ pid: 1 }), row({ pid: 2 })] };
    },
  };
  const r = await clearStaleLocks(db, { ...quiet, terminate: true });
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(r.terminated, [2]);
});
