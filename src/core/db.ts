/**
 * Postgres connection factory. Uses the `postgres` (porsager) package, same as
 * the GBrain collectors. The accounting data lives in a SEPARATE `accounting`
 * database on the existing gbrain-pg instance (localhost:5433) — reuses the
 * Docker instance (cost rule) while isolating financial data from the brain.
 */
import postgres from "postgres";

export type Sql = postgres.Sql<{}>;

let shared: Sql | null = null;

export interface DbOptions {
  url?: string;
  max?: number;
}

/** Open (or reuse) a connection. Prefers explicit url, else ACCT_DB_URL. */
export function getSql(opts: DbOptions = {}): Sql {
  if (shared) return shared;
  const url = opts.url ?? process.env.ACCT_DB_URL;
  if (!url) throw new Error("ACCT_DB_URL not set (and no url passed)");
  shared = postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 20,
    // Money is BIGINT cents; map to JS number (safe to ~$90 trillion < 2^53).
    types: {},
    onnotice: () => {
      /* suppress NOTICE noise; errors still throw */
    },
  });
  return shared;
}

/** Open a fresh, non-shared connection (for one-off scripts that must close). */
export function openSql(url: string, max = 2): Sql {
  return postgres(url, { max, idle_timeout: 10, onnotice: () => {} });
}

/** Close the shared connection (call at the end of a script). */
export async function closeSql(): Promise<void> {
  if (shared) {
    await shared.end({ timeout: 5 });
    shared = null;
  }
}
