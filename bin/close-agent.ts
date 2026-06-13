/**
 * The month-end close runtime. Node-locked, .env-gated (CLOSE_MODE off/draft/live).
 * Wires the entity profile, an optional read-only Stripe reader, and the claude -p
 * categorizer into runClose(), then emails the digest. The verdict is the one from
 * verify.ts (re-queried ground truth) — success is never assumed from exit code.
 *
 * Tasks: \Accounting\CloseIncremental (daily) and \Accounting\MonthEndClose (monthly).
 * Usage: node --import tsx bin/close-agent.ts [--mode=incremental|close] [--period YYYY-MM]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql, type Sql } from "../src/core/db.js";
import { acquireLock } from "../src/lib/lock.js";
import { configureLogDir, log, warn, error } from "../src/lib/log.js";
import { runClose } from "../src/core/close.js";
import { createStripeReader } from "../src/lib/stripe.js";
import { spawnClaudeRunner, ClaudeCategorizer } from "../src/lib/llm.js";
import { buildNodemailerTransport, sendDigest } from "../src/lib/digest.js";
import type {
  CloseConfig,
  CloseRunMode,
  EntityProfile,
  EntityType,
  FilingStatus,
  LlmCategorizer,
} from "../src/core/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag: string): string | undefined {
  const hit = process.argv.find((a) => a === flag || a.startsWith(flag + "="));
  if (!hit) return undefined;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const i = process.argv.indexOf(flag);
  return process.argv[i + 1];
}

function num(env: Record<string, string>, key: string, dflt: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) ? v : dflt;
}

function priorMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function thisMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function loadProfile(
  sql: Sql,
  tenant: string,
  taxYear: number,
  env: Record<string, string>,
): Promise<EntityProfile> {
  const rows = await sql<
    {
      entity_type: string;
      filing_status: string;
      state: string;
      home_office_sqft: number | null;
      home_total_sqft: number | null;
      reasonable_salary_cents: string | null;
    }[]
  >`SELECT entity_type, filing_status, state, home_office_sqft, home_total_sqft, reasonable_salary_cents
    FROM acct_entity_profile WHERE tenant_id = ${tenant} AND tax_year = ${taxYear}`;
  if (rows.length > 0) {
    const r = rows[0]!;
    return {
      taxYear,
      entityType: r.entity_type as EntityType,
      filingStatus: r.filing_status as FilingStatus,
      state: r.state,
      homeOfficeSqft: r.home_office_sqft,
      homeTotalSqft: r.home_total_sqft,
      reasonableSalaryCents: r.reasonable_salary_cents != null ? Number(r.reasonable_salary_cents) : null,
    };
  }
  // Seed from env (the modular entity toggle's default).
  const entityType = (env.ENTITY_TYPE ?? "sole_prop") as EntityType;
  const filingStatus = (env.ENTITY_FILING_STATUS ?? "single") as FilingStatus;
  const state = env.ENTITY_STATE ?? "CA";
  await sql`
    INSERT INTO acct_entity_profile (tenant_id, tax_year, entity_type, filing_status, state)
    VALUES (${tenant}, ${taxYear}, ${entityType}, ${filingStatus}, ${state})
    ON CONFLICT (tenant_id, tax_year) DO NOTHING`;
  return {
    taxYear,
    entityType,
    filingStatus,
    state,
    homeOfficeSqft: null,
    homeTotalSqft: null,
    reasonableSalaryCents: null,
  };
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  configureLogDir(join(root, "logs"));
  const url = arg("--url") ?? env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const lock = acquireLock(join(root, "logs", "close.lock"), 60 * 60 * 1000);
  if (!lock.acquired) {
    log("another close holds the lock; exiting");
    return;
  }

  const mode: CloseRunMode = arg("--mode") === "close" ? "close" : "incremental";
  const now = new Date();
  const period = arg("--period") ?? (mode === "close" ? priorMonth(now) : thisMonth(now));
  const tenant = env.TENANT_ID ?? "ariel";

  const config: CloseConfig = {
    mode: (env.CLOSE_MODE ?? "off").toLowerCase() as CloseConfig["mode"],
    ajeAutoThresholdCents: Math.round(num(env, "AJE_AUTO_THRESHOLD", 250) * 100),
    largeTxnReviewCents: Math.round(num(env, "LARGE_TXN_REVIEW", 1000) * 100),
    confidenceThreshold: num(env, "CONFIDENCE_THRESHOLD", 0.85),
    reconToleranceCents: num(env, "RECON_TOLERANCE_CENTS", 0),
    reconEscalateDeltaCents: num(env, "RECON_ESCALATE_DELTA", 5000),
  };

  const sql = openSql(url);
  try {
    const taxYear = Number(period.slice(0, 4));
    const profile = await loadProfile(sql, tenant, taxYear, env);

    const llm: LlmCategorizer | undefined =
      config.mode === "off" ? undefined : new ClaudeCategorizer(spawnClaudeRunner());
    const stripe = env.STRIPE_SECRET_KEY ? createStripeReader(env.STRIPE_SECRET_KEY) : undefined;

    log(`close-agent: mode=${mode} period=${period} rung=${config.mode} tenant=${tenant}`);
    const result = await runClose(sql, tenant, period, config, mode, {
      profile,
      ...(stripe ? { stripe } : {}),
      ...(llm ? { llm } : {}),
    });

    log(
      `verdict=${result.verdict.status} balanced=${result.verdict.balanced} ` +
        `debits=${result.verdict.debitsCents} credits=${result.verdict.creditsCents} ` +
        `posted=${result.verdict.postedCount} quarantined=${result.verdict.quarantineCount} locked=${result.locked}`,
    );

    // Notify (SECONDARY: a send failure never flips the verdict).
    if (config.mode !== "off" && !result.noop) {
      if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
        const transport = buildNodemailerTransport({
          SMTP_HOST: env.SMTP_HOST,
          SMTP_PORT: env.SMTP_PORT ?? "465",
          SMTP_USER: env.SMTP_USER,
          SMTP_PASS: env.SMTP_PASS,
        });
        const sent = await sendDigest(
          transport,
          env.DIGEST_FROM ?? env.SMTP_USER,
          env.DIGEST_TO ?? env.SMTP_USER,
          result.digest,
        );
        log(sent ? "digest sent" : "digest send returned false");
      } else {
        warn("SMTP not configured; digest not sent (verdict stands).");
      }
    }
  } catch (e) {
    error("close-agent crashed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
    lock.release();
  }
}

main().catch((e) => {
  error("close-agent fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
