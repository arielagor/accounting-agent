/**
 * Financial advisor report (informational). Runway, burn, top movers, SaaS-waste
 * (zombie subscriptions), per-project ROI, and the persona's applicable LEGAL
 * tax-planning strategies. Prescriptive financial moves carry a "not financial
 * advice" disclaimer — this describes and quantifies the past, it does not direct
 * future financial action.
 *
 * Usage: node --import tsx bin/advisor.ts [--period YYYY-MM]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { log, error } from "../src/lib/log.js";
import { buildAdvisorReport } from "../src/core/advisor.js";
import { buildPortfolioPnl } from "../src/core/reports.js";
import { formatUsd } from "../src/core/money.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = arg("--url") ?? env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const tenant = env.TENANT_ID ?? "ariel";
  const now = new Date();
  const period = arg("--period") ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const sql = openSql(url);
  try {
    const net = (await buildPortfolioPnl(sql, tenant, period)).netCents;
    const r = await buildAdvisorReport(sql, tenant, period, net);

    log(`ADVISOR REPORT — ${r.period}`);
    log(`  Runway: ${r.runwayMonths === Infinity ? "infinite (no burn)" : r.runwayMonths.toFixed(1) + " months"}`);
    log(`  Monthly burn: ${formatUsd(r.monthlyBurnCents)}`);
    if (r.topMovers.length) {
      log("  Top movers:");
      for (const m of r.topMovers.slice(0, 5)) log(`    ${m.account}: ${formatUsd(m.deltaCents)}`);
    }
    if (r.zombieSubs.length) {
      log("  SaaS waste candidates (no revenue + no usage on the charged project):");
      for (const z of r.zombieSubs) log(`    ${z.merchant}: ${formatUsd(z.monthlyCents)}/mo`);
    }
    if (r.perProjectRoi.length) {
      log("  Per-project ROI:");
      for (const p of r.perProjectRoi)
        log(`    ${p.projectSlug}: revenue ${formatUsd(p.revenueCents)} - cost ${formatUsd(p.allocatedCostCents)} = ${formatUsd(p.net)}`);
    }
    if (r.strategies.length) {
      log("  Legal tax-planning strategies in play (Hank Calloway's playbook):");
      for (const s of r.strategies) log(`    - ${s.name}${s.aggressive ? " [aggressive — CPA sign-off]" : ""}: ${s.benefit}`);
    }
    for (const d of r.disclaimers) log(`  NOTE: ${d}`);
  } catch (e) {
    error("advisor failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  error("advisor fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
