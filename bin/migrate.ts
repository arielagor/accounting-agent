/**
 * Migration runner. Applies sql/*.sql (schema) then sql/seed/*.sql (seeds) in
 * sorted order, each exactly once, tracked in acct_migrations. Idempotent:
 * re-running applies nothing already applied. Each file runs in its own
 * transaction (DDL is transactional in Postgres), so a failure rolls back cleanly.
 *
 * Usage: node --import tsx bin/migrate.ts [--url <conn>] [--reset-seeds]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { log, error } from "../src/lib/log.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sqlFilesIn(dir: string): { name: string; path: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, path: join(dir, f) }));
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = arg("--url") ?? env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set (and no --url). Aborting.");
    process.exit(1);
  }
  const sql = openSql(url);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS acct_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (await sql`SELECT filename FROM acct_migrations`).map((r) => r.filename as string),
  );

  const schema = sqlFilesIn(join(root, "sql")).map((f) => ({ ...f, ns: "schema" }));
  const seeds = sqlFilesIn(join(root, "sql", "seed")).map((f) => ({ ...f, ns: "seed" }));
  const all = [...schema, ...seeds];

  let appliedCount = 0;
  for (const file of all) {
    const key = `${file.ns}/${file.name}`;
    if (applied.has(key)) {
      log(`skip   ${key} (already applied)`);
      continue;
    }
    const text = readFileSync(file.path, "utf8");
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`INSERT INTO acct_migrations (filename) VALUES (${key})`;
      });
      log(`apply  ${key}`);
      appliedCount += 1;
    } catch (e) {
      error(`FAILED ${key}: ${(e as Error).message}`);
      await sql.end({ timeout: 5 });
      process.exit(1);
    }
  }

  log(`done: ${appliedCount} applied, ${all.length - appliedCount} skipped, ${all.length} total`);
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  error(`migrate crashed: ${(e as Error).message}`);
  process.exit(1);
});
