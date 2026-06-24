/**
 * The autonomous-auditor runtime (local analogue of a cloud auditor pass). Convenes
 * the /council on every open review-queue item and auto-posts what it can confidently
 * resolve, escalates hard human-gates, and files access-requests where it needs data —
 * recording the trail to acct_auditor_decisions + acct_audit_log. Gated by CLOSE_MODE:
 * 'off' refuses (inert bring-up), 'draft'/'live' run. The same path backs the
 * dashboard's "Run auditor" button.
 *
 * Usage: npm run audit   (schedulable; or invoked from the Review tab)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { auditReviewQueue } from "../src/core/auditor.js";
import { spawnClaudeRunner, ClaudeCouncil } from "../src/lib/llm.js";
import { log, warn, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  if (!env.ACCT_DB_URL) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const mode = (env.CLOSE_MODE ?? "off").toLowerCase();
  if (mode === "off") {
    warn("CLOSE_MODE=off — auditor is inert. Set draft/live to let it act.");
    return;
  }
  const tenant = env.TENANT_ID ?? "ariel";
  const confidenceThreshold = Number(env.CONFIDENCE_THRESHOLD ?? 0.85);
  // Tax-optimize uncertain items by default (Ariel 2026-06-17): when the auditor is unsure
  // it books the most tax-beneficial defensible account instead of parking it for a human.
  // Set AUDITOR_TAX_OPTIMIZE=0 to revert; AUDITOR_TAX_OPTIMIZE_MAX_CENTS caps the amount.
  const taxOptimizeUncertain = (env.AUDITOR_TAX_OPTIMIZE ?? "1") !== "0";
  const taxOptimizeMaxCents = env.AUDITOR_TAX_OPTIMIZE_MAX_CENTS
    ? Number(env.AUDITOR_TAX_OPTIMIZE_MAX_CENTS)
    : undefined;
  // Type-I (over-claim) aversion floor: a low-confidence deduction below this is left for a
  // human rather than auto-deducted. AUDITOR_TAX_LEAN_FLOOR=0 disables it.
  const taxLeanConfidenceFloor =
    env.AUDITOR_TAX_LEAN_FLOOR !== undefined ? Number(env.AUDITOR_TAX_LEAN_FLOOR) : undefined;
  // The council settles ambiguity with best judgement and may use read-only internet
  // research (WebSearch/WebFetch) to identify unfamiliar merchants. AUDITOR_RESEARCH=0
  // disables research (text-only council). Research adds web latency → a longer timeout.
  const research = (env.AUDITOR_RESEARCH ?? "1") !== "0";
  const councilRunner = research
    ? spawnClaudeRunner(180_000, { allowedTools: ["WebSearch", "WebFetch"] })
    : spawnClaudeRunner();
  const sql = openSql(env.ACCT_DB_URL);
  try {
    const council = new ClaudeCouncil(councilRunner);
    const r = await auditReviewQueue(sql, tenant, council, {
      confidenceThreshold,
      taxOptimizeUncertain,
      taxOptimizeMaxCents,
      taxLeanConfidenceFloor,
    });
    log(
      `audit: processed=${r.processed} auto-posted=${r.autoPosted} (tax-optimized=${r.taxOptimized}) ` +
        `tax-deferred=${r.taxDeferredConservative} escalated=${r.escalated} ` +
        `awaiting-access=${r.deferred} still-quarantined=${r.quarantined}`,
    );
  } catch (e) {
    error("audit failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  error("audit fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
