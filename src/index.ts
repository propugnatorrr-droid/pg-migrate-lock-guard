/** Anything with a node-postgres style `query`. A `pg.Client`, a `pg.Pool`, or a stub in tests. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface GuardOptions {
  /** Actually terminate the holders. Default false: report only (dry run). */
  terminate?: boolean;
  /** Only consider locks whose key is in this list. Strongly recommended: your migration tool's key. */
  lockKeys?: Array<bigint | number>;
  /** Only consider connections idle or unchanged for at least this long. Default 30 seconds. */
  olderThanSeconds?: number;
  /** Only consider connections whose application_name is in this list. */
  applicationNames?: string[];
  /** Refuse to terminate more than this many backends in one run. Default 5. */
  maxTerminate?: number;
  /** Called for each log line. Default: console.log. */
  log?: (line: string) => void;
}

export interface Holder {
  pid: number;
  /** The advisory lock key for single-bigint locks, as a decimal string. Null for two-int locks. */
  key: string | null;
  applicationName: string;
  state: string | null;
  idleSeconds: number;
  lastQuery: string;
}

export interface GuardResult {
  dryRun: boolean;
  found: Holder[];
  terminated: number[];
  /** Set when a safety limit stopped the run. */
  refused?: string;
}

/** SQL that lists other backends holding an advisory lock. Never includes the guard's own connection. */
export const FIND_SQL = `
select l.pid,
       case when l.objsubid = 1 then ((l.classid::bigint << 32) | l.objid::bigint)::text end as key,
       coalesce(a.application_name, '') as application_name,
       a.state,
       coalesce(extract(epoch from (now() - coalesce(a.state_change, a.backend_start)))::int, 0) as idle_seconds,
       left(coalesce(a.query, ''), 120) as last_query
from pg_locks l
join pg_stat_activity a on a.pid = l.pid
where l.locktype = 'advisory'
  and l.granted
  and l.pid <> pg_backend_pid()
order by l.pid`;

export async function findAdvisoryLockHolders(db: Queryable, opts: GuardOptions = {}): Promise<Holder[]> {
  const olderThan = opts.olderThanSeconds ?? 30;
  const keys = opts.lockKeys?.map((k) => String(k));
  const { rows } = await db.query(FIND_SQL);
  const seen = new Set<number>();
  const holders: Holder[] = [];
  for (const r of rows) {
    const h: Holder = {
      pid: Number(r.pid),
      key: r.key ?? null,
      applicationName: r.application_name ?? "",
      state: r.state ?? null,
      idleSeconds: Number(r.idle_seconds ?? 0),
      lastQuery: r.last_query ?? "",
    };
    if (keys && (h.key === null || !keys.includes(h.key))) continue;
    if (opts.applicationNames && !opts.applicationNames.includes(h.applicationName)) continue;
    if (h.idleSeconds < olderThan) continue;
    if (seen.has(h.pid)) continue; // one backend can hold several locks; list it once
    seen.add(h.pid);
    holders.push(h);
  }
  return holders;
}

/**
 * Find stale advisory-lock holders and, only when `terminate` is true, terminate them.
 * Best effort: it never throws. A failure to connect or query is logged and reported as nothing found,
 * so the migration that runs next shows the real error.
 */
export async function clearStaleLocks(db: Queryable, opts: GuardOptions = {}): Promise<GuardResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const dryRun = !opts.terminate;
  const max = opts.maxTerminate ?? 5;
  let found: Holder[] = [];
  try {
    found = await findAdvisoryLockHolders(db, opts);
  } catch (e) {
    log(`pg-migrate-lock-guard: skipped (${e instanceof Error ? e.message : String(e)})`);
    return { dryRun, found: [], terminated: [] };
  }
  for (const h of found) {
    log(`${dryRun ? "would terminate" : "found"} pid ${h.pid}, key ${h.key ?? "(two-int)"}, app "${h.applicationName}", ${h.state ?? "unknown"} for ${h.idleSeconds}s, last query: ${h.lastQuery}`);
  }
  if (dryRun || found.length === 0) return { dryRun, found, terminated: [] };
  if (found.length > max) {
    const refused = `refused: ${found.length} holders found, limit is ${max}. Narrow with lockKeys or applicationNames.`;
    log(`pg-migrate-lock-guard: ${refused}`);
    return { dryRun, found, terminated: [], refused };
  }
  const terminated: number[] = [];
  for (const h of found) {
    try {
      const { rows } = await db.query("select pg_terminate_backend($1) as ok", [h.pid]);
      if (rows[0]?.ok) {
        terminated.push(h.pid);
        log(`terminated pid ${h.pid}`);
      }
    } catch (e) {
      log(`could not terminate pid ${h.pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { dryRun, found, terminated };
}
