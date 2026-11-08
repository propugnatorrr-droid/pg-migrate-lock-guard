#!/usr/bin/env node
// Usage: node src/cli.ts [--terminate] [--key N]... [--older-than SECONDS] [--app NAME]... [--max N]
// Connection string: DIRECT_URL, else DATABASE_URL. Always exits 0 (best effort) so it never blocks a build.
import pg from "pg";
import { clearStaleLocks, type GuardOptions } from "./index.ts";

const args = process.argv.slice(2);
const opts: GuardOptions = { terminate: args.includes("--terminate"), lockKeys: [], applicationNames: [] };
for (let i = 0; i < args.length; i++) {
  const next = args[i + 1];
  if (args[i] === "--key" && next) opts.lockKeys!.push(BigInt(next));
  if (args[i] === "--app" && next) opts.applicationNames!.push(next);
  if (args[i] === "--older-than" && next) opts.olderThanSeconds = Number(next);
  if (args[i] === "--max" && next) opts.maxTerminate = Number(next);
}
if (!opts.lockKeys!.length) delete opts.lockKeys;
if (!opts.applicationNames!.length) delete opts.applicationNames;

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.log("pg-migrate-lock-guard: no DIRECT_URL or DATABASE_URL, nothing to do");
} else {
  const client = new pg.Client({ connectionString: url, application_name: "pg-migrate-lock-guard" });
  try {
    await client.connect();
    await clearStaleLocks(client, opts);
  } catch (e) {
    console.log(`pg-migrate-lock-guard: skipped (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    await client.end().catch(() => {});
  }
}
