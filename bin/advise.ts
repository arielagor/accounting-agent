/**
 * The advisory + budget-watch runtime (local analogue of the cloud `advise` /
 * `budget-watch` scheduled functions). Refreshes budget actuals, fires any newly
 * crossed budget alerts (pushing to the phone if VAPID is configured), and generates
 * grounded recommendations for the latest period. Read-only money — it only reads the
 * ledger and writes advisory rows + push notifications.
 *
 * Usage: npm run advise [--period YYYY-MM]   (schedulable daily)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { refreshActuals, checkAlerts } from "../src/core/budgets.js";
import { generateRecommendations } from "../src/core/recommendations.js";
import { getDashboardData } from "../src/lib/dashboard-data.js";
import { vapidFromEnv, WebPushNotifier } from "../src/lib/push.js";
import { log, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  if (!env.ACCT_DB_URL) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const tenant = env.TENANT_ID ?? "ariel";
  const sql = openSql(env.ACCT_DB_URL);
  const todayISO = new Date().toISOString().slice(0, 10);
  try {
    const period = arg("--period") ?? (await latestPeriod(sql, tenant));
    const vapid = vapidFromEnv(process.env);

    await refreshActuals(sql, tenant, todayISO);
    const notifier = vapid ? new WebPushNotifier(sql, vapid) : undefined;
    const fired = await checkAlerts(sql, tenant, todayISO, notifier);
    log(`advise: ${fired.length} budget alert(s) fired${vapid ? " (pushed)" : " (push off)"}`);

    const data = await getDashboardData(sql, tenant, period, new Date().toISOString());
    const netProfit = data.closePackage.portfolio.netCents;
    const r = await generateRecommendations(sql, tenant, period, netProfit, todayISO);
    log(`advise: generated ${r.generated} recommendation(s) for ${period}`);
  } catch (e) {
    error("advise failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function latestPeriod(sql: ReturnType<typeof openSql>, tenant: string): Promise<string> {
  const rows = await sql<{ period: string }[]>`
    SELECT to_char(posted_date,'YYYY-MM') period FROM acct_transactions_raw
    WHERE tenant_id = ${tenant} AND posted_date IS NOT NULL ORDER BY posted_date DESC LIMIT 1`;
  return rows[0]?.period ?? new Date().toISOString().slice(0, 7);
}

main().catch((e) => {
  error("advise fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
