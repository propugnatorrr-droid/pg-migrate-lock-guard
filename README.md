# pg-migrate-lock-guard

Find, and only when you ask, clear stale Postgres advisory locks that block your next migration.

Dry run by default. Scoped by lock key, connection age and application name. It never kills its own connection, refuses to terminate more than a few backends at once, and never fails your build.

## Why this exists

A deploy failed with `Error: P1002 ... timed out trying to acquire a postgres advisory lock`. It looked like contention. It was not.

Migration tools take a **session-scoped advisory lock** before applying migrations. Behind a transaction-pooled endpoint (a Neon `-pooler` host, a Supabase pooler, PgBouncer in transaction mode), the pooler can hand the backend that holds the lock to a later, unrelated request before the unlock runs. The lock stays held by a connection that has moved on to ordinary queries, and nothing will ever release it.

I proved it by joining `pg_locks` to `pg_stat_activity`: the lock holder's last query was a plain `SELECT` from the running app, not a migration. Terminating that backend cleared the lock at once.

Permanent fix: give migrations their own **direct** (unpooled) connection string. This tool is the safety net for the times a lock leaks anyway.

## Use

Look first. This only reports:

```bash
npm install
DIRECT_URL=postgres://... node src/cli.ts
```

```
would terminate pid 4821, key 72707369, app "", idle for 640s, last query: SELECT id FROM users WHERE ...
```

Then act, narrowed to the key you saw:

```bash
node src/cli.ts --terminate --key 72707369 --older-than 60
```

In a build script, before the migration step:

```json
"build": "node src/cli.ts --terminate --key <your-key> && prisma migrate deploy && next build"
```

Find your migration tool's key with the dry run while a lock is stuck. Do not guess it.

### Options

| Flag | Meaning |
| --- | --- |
| `--terminate` | Actually terminate. Without it, nothing is touched. |
| `--key N` | Only locks with this key. Repeatable. **Use it.** |
| `--older-than S` | Only connections unchanged for at least `S` seconds. Default 30. Protects a migration that is running right now. |
| `--app NAME` | Only connections with this `application_name`. Repeatable. |
| `--max N` | Refuse to terminate more than `N` backends. Default 5. |

Connection string: `DIRECT_URL`, else `DATABASE_URL`. The CLI always exits 0.

## As a library

```ts
import { clearStaleLocks } from "./src/index.ts";

const result = await clearStaleLocks(client, { terminate: true, lockKeys: [72707369n], olderThanSeconds: 60 });
// { dryRun: false, found: [...], terminated: [4821] }
```

`client` is anything with a node-postgres style `query(sql, params)`.

## Safety, by design

- **Dry run is the default.** You opt in to termination.
- **Scoped.** Key, age and application filters narrow what is touched.
- **Never itself.** The query excludes `pg_backend_pid()`.
- **Capped.** More holders than `--max` and it refuses and tells you to narrow.
- **Best effort.** A connection or query failure is logged, not thrown, so your migration shows the real error.
- Terminating a backend that is mid-write rolls back its transaction. Only run this where an advisory lock holder being idle for a minute means "stuck".

## Tests

- **Unit tests** (stub client): dry run default, termination, key filter, age filter, app filter, one entry per backend, cap, never throws, partial failure.
- **Integration tests** (real Postgres 16 in CI): a second connection takes a real advisory lock; a dry run leaves it alive; `--terminate` kills it and frees the lock; a different key is untouched; the guard never kills itself.

```bash
npm install
npm test          # integration tests are skipped unless TEST_DATABASE_URL is set
npm run typecheck
```

## Licence

MIT
