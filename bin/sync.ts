/**
 * Nightly read-only transaction sync. Acquires a node lock, loads .env, and for
 * each active connection: lists accounts (upsert), pulls transactions incrementally
 * and UPSERTs them (idempotent by dedup_key — re-runs never double-ingest). An
 * auth-class failure (expired link) pauses that ONE connection and escalates by
 * email with zero retry; other connections still sync. Reconciliation runs in the
 * close (period-scoped), not here.
 *
 * Task: \Accounting\NightlySync   Usage: node --import tsx bin/sync.ts [--url <conn>]
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadEnv } from "../src/lib/env.js";
import { openSql, type Sql } from "../src/core/db.js";
import { acquireLock } from "../src/lib/lock.js";
import { configureLogDir, log, warn, error } from "../src/lib/log.js";
import { decryptSecret } from "../src/lib/token-store.js";
import { getProvider, type ProviderName } from "../src/providers/index.js";
import { buildNodemailerTransport } from "../src/lib/digest.js";
import type { ProviderTransaction } from "../src/core/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(401|403)\b|auth|forbidden|unauthor|login.required/i.test(msg);
}

interface ConnRow {
  id: number;
  tenant_id: string;
  provider: string;
  institution_name: string | null;
  access_token_enc: string;
  sync_cursor: string | null;
}

async function escalate(env: Record<string, string>, subject: string, body: string): Promise<void> {
  try {
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
      warn("escalation not sent (SMTP not configured):", subject);
      return;
    }
    const transport = buildNodemailerTransport({
      SMTP_HOST: env.SMTP_HOST,
      SMTP_PORT: env.SMTP_PORT ?? "465",
      SMTP_USER: env.SMTP_USER,
      SMTP_PASS: env.SMTP_PASS,
    });
    await transport.sendMail({
      from: env.DIGEST_FROM ?? env.SMTP_USER,
      to: env.DIGEST_TO ?? env.SMTP_USER,
      subject,
      text: body,
    });
  } catch (e) {
    warn("escalation email failed:", e instanceof Error ? e.message : String(e));
  }
}

async function upsertAccounts(sql: Sql, conn: ConnRow, accessToken: string): Promise<Map<string, number>> {
  const provider = getProvider(conn.provider as ProviderName);
  const accounts = await provider.listAccounts(accessToken);
  const map = new Map<string, number>();
  for (const a of accounts) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO acct_source_accounts
        (connection_id, tenant_id, provider_account_id, name, mask, type, subtype, currency)
      VALUES (${conn.id}, ${conn.tenant_id}, ${a.providerAccountId}, ${a.name}, ${a.mask ?? null},
              ${a.type ?? null}, ${a.subtype ?? null}, ${a.currency})
      ON CONFLICT (connection_id, provider_account_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`;
    map.set(a.providerAccountId, row!.id);
  }
  return map;
}

async function upsertTxn(
  sql: Sql,
  conn: ConnRow,
  accountId: number,
  t: ProviderTransaction,
): Promise<"added" | "modified"> {
  const dedupKey = t.providerTxnId;
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM acct_transactions_raw
    WHERE tenant_id = ${conn.tenant_id} AND provider = ${conn.provider} AND dedup_key = ${dedupKey}`;
  if (existing.length > 0) {
    await sql`
      UPDATE acct_transactions_raw SET
        amount_cents = ${t.amountCents}, pending = ${t.pending}, posted_date = ${t.postedDate},
        description_raw = ${t.description}, merchant_name = ${t.merchantName},
        category_provider = ${t.categoryProvider}, raw_json = ${sql.json(t.raw as Parameters<typeof sql.json>[0])}
      WHERE id = ${existing[0]!.id}`;
    return "modified";
  }
  await sql`
    INSERT INTO acct_transactions_raw
      (source_account_id, tenant_id, provider, provider_txn_id, dedup_key, amount_cents,
       currency, posted_date, authorized_date, pending, description_raw, merchant_name, category_provider, raw_json)
    VALUES (${accountId}, ${conn.tenant_id}, ${conn.provider}, ${t.providerTxnId}, ${dedupKey}, ${t.amountCents},
            ${t.currency}, ${t.postedDate}, ${t.authorizedDate}, ${t.pending}, ${t.description},
            ${t.merchantName}, ${t.categoryProvider}, ${sql.json(t.raw as Parameters<typeof sql.json>[0])})`;
  return "added";
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  configureLogDir(join(root, "logs"));
  const url = arg("--url") ?? env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const lock = acquireLock(join(root, "logs", "sync.lock"), 30 * 60 * 1000);
  if (!lock.acquired) {
    log("another sync holds the lock; exiting");
    return;
  }
  const sql = openSql(url);
  const [run] = await sql<{ id: number }[]>`INSERT INTO acct_sync_runs DEFAULT VALUES RETURNING id`;
  let added = 0;
  let modified = 0;
  let escalations = 0;

  try {
    const conns = await sql<ConnRow[]>`
      SELECT id, tenant_id, provider, institution_name, access_token_enc, sync_cursor
      FROM acct_connections WHERE status = 'active'`;
    for (const conn of conns) {
      let accessToken: string;
      try {
        accessToken = decryptSecret(conn.access_token_enc);
      } catch (e) {
        error(`connection ${conn.id}: decrypt failed (wrong INTEGRATION_ENC_KEY?)`, e instanceof Error ? e.message : "");
        await escalate(env, `[ACCOUNTING] Decrypt failed for connection ${conn.id}`, "Cannot decrypt the stored access token. Has INTEGRATION_ENC_KEY changed?");
        escalations += 1;
        continue;
      }
      try {
        const acctMap = await upsertAccounts(sql, conn, accessToken);
        const provider = getProvider(conn.provider as ProviderName);
        let cursor = conn.sync_cursor;
        for (;;) {
          const page = await provider.syncTransactions(accessToken, cursor);
          for (const t of [...page.added, ...page.modified]) {
            const accountId = acctMap.get(t.providerAccountId);
            if (!accountId) continue; // txn for an account we couldn't map; skip safely
            const r = await upsertTxn(sql, conn, accountId, t);
            if (r === "added") added += 1;
            else modified += 1;
          }
          for (const removedId of page.removed) {
            await sql`UPDATE acct_transactions_raw SET superseded_at = now()
              WHERE tenant_id = ${conn.tenant_id} AND provider = ${conn.provider} AND provider_txn_id = ${removedId}`;
          }
          cursor = page.nextCursor;
          if (!page.hasMore) break;
        }
        await sql`UPDATE acct_connections SET sync_cursor = ${cursor}, last_synced_at = now(),
          status = 'active', consecutive_failures = 0 WHERE id = ${conn.id}`;
        log(`connection ${conn.id} (${conn.institution_name ?? conn.provider}) synced`);
      } catch (e) {
        if (isAuthError(e)) {
          await sql`UPDATE acct_connections SET status = 'login_required',
            consecutive_failures = consecutive_failures + 1 WHERE id = ${conn.id}`;
          await escalate(
            env,
            `[ACCOUNTING] Re-link required: ${conn.institution_name ?? "connection " + conn.id}`,
            `The connection expired. Re-link with:\n  npm run link -- --reconnect ${conn.id}\nNo data was lost; the next sync resumes from the last cursor.`,
          );
          escalations += 1;
          warn(`connection ${conn.id}: auth failure -> paused, escalated`);
        } else {
          await sql`UPDATE acct_connections SET status = 'error',
            consecutive_failures = consecutive_failures + 1 WHERE id = ${conn.id}`;
          error(`connection ${conn.id}: sync error`, e instanceof Error ? e.message : String(e));
        }
      }
    }
    await sql`UPDATE acct_sync_runs SET finished_at = now(), added = ${added}, modified = ${modified}, escalations = ${escalations} WHERE id = ${run!.id}`;
    log(`sync done: +${added} added, ${modified} modified, ${escalations} escalations`);
  } catch (e) {
    await sql`UPDATE acct_sync_runs SET finished_at = now(), error = ${e instanceof Error ? e.message : String(e)} WHERE id = ${run!.id}`;
    error("sync crashed:", e instanceof Error ? e.message : String(e));
  } finally {
    await sql.end({ timeout: 5 });
    lock.release();
  }
}

main().catch((e) => {
  error("sync fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
