// Needs a real Postgres: set TEST_DATABASE_URL (CI does this with a service container).
// It opens real second connections, takes a real advisory lock, and checks what the guard does to it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { clearStaleLocks } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
const opts = { skip: url ? false : "TEST_DATABASE_URL not set" };
const clients: pg.Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.end().catch(() => {})));
});

async function connect(app: string) {
  const c = new pg.Client({ connectionString: url, application_name: app });
  c.on("error", () => {}); // a terminated backend emits an error, which is what we want to observe
  await c.connect();
  clients.push(c);
  return c;
}
const alive = async (c: pg.Client) => {
  try {
    await c.query("select 1");
    return true;
  } catch {
    return false;
  }
};

test("dry run leaves a stale lock holder connected", opts, async () => {
  const holder = await connect("integration-holder");
  await holder.query("select pg_advisory_lock(4242)");
  const guard = await connect("guard");
  const r = await clearStaleLocks(guard, { lockKeys: [4242n], olderThanSeconds: 0, log: () => {} });
  assert.equal(r.dryRun, true);
  assert.equal(r.found.length, 1);
  assert.equal(await alive(holder), true);
});

test("terminate:true kills the holder and frees the lock", opts, async () => {
  const holder = await connect("integration-holder-2");
  await holder.query("select pg_advisory_lock(4343)");
  const guard = await connect("guard-2");
  const r = await clearStaleLocks(guard, { terminate: true, lockKeys: [4343n], olderThanSeconds: 0, log: () => {} });
  assert.equal(r.terminated.length, 1);
  assert.equal(await alive(holder), false);
  const { rows } = await guard.query("select pg_try_advisory_lock(4343) as got");
  assert.equal(rows[0].got, true);
  await guard.query("select pg_advisory_unlock(4343)"); // the probe above took the lock; release it so later tests start clean
});

test("a lock with a different key is not touched", opts, async () => {
  const other = await connect("integration-other");
  await other.query("select pg_advisory_lock(9999)");
  const guard = await connect("guard-3");
  const r = await clearStaleLocks(guard, { terminate: true, lockKeys: [4343n], olderThanSeconds: 0, log: () => {} });
  assert.deepEqual(r.found, []);
  assert.equal(await alive(other), true);
});

test("the guard never terminates itself even if it holds a matching lock", opts, async () => {
  const guard = await connect("guard-4");
  await guard.query("select pg_advisory_lock(4444)");
  const r = await clearStaleLocks(guard, { terminate: true, lockKeys: [4444n], olderThanSeconds: 0, log: () => {} });
  assert.deepEqual(r.found, []);
  assert.equal(await alive(guard), true);
});
