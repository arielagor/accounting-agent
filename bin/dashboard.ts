/**
 * The web app — a self-contained, dependency-free PWA (node:http + inline SPA) that
 * surfaces the whole engine: Overview/net-worth, the transaction register with inline
 * edit + split, hybrid budgets, the advisor's recommendations, receipt ingest, the
 * SMB view (AR/AP aging, 1099, sales tax), and the auditor review queue with one-tap
 * grant-access. Installable + Web-Push capable so it's a realtime budget assistant on
 * the phone. Read-only money: the only writes are ledger postings to the agent's own DB.
 *
 * Bind 127.0.0.1 by default; DASHBOARD_HOST=0.0.0.0 reaches it over Tailscale/LAN, in
 * which case DASHBOARD_TOKEN gates every /api/* call (header-only, fail-closed).
 *
 * Usage: node --import tsx bin/dashboard.ts   (then open http://127.0.0.1:4242)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { getDashboardData } from "../src/lib/dashboard-data.js";
import { applyManualCategorization, recategorizeTransaction } from "../src/core/resolve.js";
import {
  netWorthSeries,
  transactions,
  budgetsWithActuals,
  recommendations,
  documents,
  accessRequests,
  smbSummary,
  appleCatalog,
} from "../src/lib/app-data.js";
import { setAppleClassification, type Bucket } from "../src/core/apple-history.js";
import { parseOfx, parseCsv, importStatement, looksLikeOfx } from "../src/core/statements.js";
import { upsertBudget, type PeriodKind, type BudgetScope } from "../src/core/budgets.js";
import { generateRecommendations, setRecommendationStatus } from "../src/core/recommendations.js";
import { resolveAccessRequest } from "../src/core/audit.js";
import { auditReviewQueue } from "../src/core/auditor.js";
import { ingestDocument, processDocument } from "../src/core/receipts.js";
import { importAppleHistory, looksLikeAppleHistory } from "../src/core/apple-history.js";
import { spawnClaudeRunner, ClaudeCouncil, ClaudeDocumentExtractor } from "../src/lib/llm.js";
import { vapidFromEnv, saveSubscription, sendToTenant } from "../src/lib/push.js";
import { PAGE, SW_JS, MANIFEST, ICON_SVG } from "../src/lib/dashboard-page.js";
import { log, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv(join(root, ".env"));
const url = env.ACCT_DB_URL;
if (!url) {
  error("ACCT_DB_URL not set");
  process.exit(1);
}
const tenant = env.TENANT_ID ?? "ariel";
const port = Number(env.DASHBOARD_PORT ?? 4242);
const host = env.DASHBOARD_HOST ?? "127.0.0.1";
const token = env.DASHBOARD_TOKEN ?? "";
const vapid = vapidFromEnv(process.env);
const confidenceThreshold = Number(env.CONFIDENCE_THRESHOLD ?? 0.85);

if (host !== "127.0.0.1" && host !== "localhost" && !token) {
  error(`refusing to bind ${host} without DASHBOARD_TOKEN — set a token or bind 127.0.0.1`);
  process.exit(1);
}

function tokenOk(provided: string | string[] | undefined): boolean {
  if (!token) return true;
  const got = Array.isArray(provided) ? provided[0] : provided;
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sql = openSql(url);
const todayISO = (): string => new Date().toISOString().slice(0, 10);

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
async function latestPeriod(): Promise<string> {
  const rows = await sql<{ period: string }[]>`
    SELECT period FROM acct_close_run WHERE tenant_id = ${tenant}
    UNION SELECT period FROM acct_close WHERE tenant_id = ${tenant}
    UNION SELECT to_char(posted_date,'YYYY-MM') FROM acct_transactions_raw WHERE tenant_id = ${tenant}
    ORDER BY period DESC LIMIT 1`;
  return rows[0]?.period ?? new Date().toISOString().slice(0, 7);
}
async function netProfitFor(period: string): Promise<number> {
  const data = await getDashboardData(sql, tenant, period, new Date().toISOString());
  return data.closePackage.portfolio.netCents;
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = u.pathname;

    // Ungated static shell + PWA assets (no data; the shell bootstraps the token).
    if (req.method === "GET" && path === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
    if (req.method === "GET" && path === "/sw.js") return send(res, 200, "application/javascript", SW_JS);
    if (req.method === "GET" && path === "/manifest.webmanifest") return send(res, 200, "application/manifest+json", MANIFEST);
    if (req.method === "GET" && path === "/icon.svg") return send(res, 200, "image/svg+xml", ICON_SVG);

    // Everything else is /api/* and header-gated.
    if (path.startsWith("/api/") && !tokenOk(req.headers["x-dash-token"])) {
      return send(res, 401, "text/plain", "unauthorized");
    }

    if (req.method === "GET" && path === "/api/config") {
      return json(res, 200, { vapidPublicKey: vapid?.publicKey ?? null, pushEnabled: !!vapid, tenant });
    }
    if (req.method === "GET" && path === "/api/periods") {
      const rows = await sql<{ period: string }[]>`
        SELECT DISTINCT period FROM (
          SELECT period FROM acct_close_run WHERE tenant_id = ${tenant}
          UNION SELECT period FROM acct_close WHERE tenant_id = ${tenant}
          UNION SELECT to_char(posted_date,'YYYY-MM') period FROM acct_transactions_raw WHERE tenant_id = ${tenant} AND posted_date IS NOT NULL
        ) p ORDER BY period DESC`;
      return json(res, 200, { periods: rows.map((r) => r.period) });
    }
    if (req.method === "GET" && path === "/api/overview") {
      const period = u.searchParams.get("period") || (await latestPeriod());
      const data = await getDashboardData(sql, tenant, period, new Date().toISOString());
      const netWorth = await netWorthSeries(sql, tenant, period.slice(0, 4));
      return json(res, 200, { ...data, netWorth });
    }
    if (req.method === "GET" && path === "/api/transactions") {
      const period = u.searchParams.get("period") || (await latestPeriod());
      return json(res, 200, { period, transactions: await transactions(sql, tenant, period) });
    }
    if (req.method === "POST" && path === "/api/resolve") {
      const b = await readBody(req);
      if (!b.sourceTxnId || !b.accountCode) return json(res, 400, { ok: false, error: "sourceTxnId and accountCode required" });
      const r = await applyManualCategorization(sql, tenant, String(b.sourceTxnId), String(b.accountCode), Number(b.businessPct ?? 100));
      return json(res, 200, { ok: r.posted || r.alreadyPosted, ...r });
    }
    if (req.method === "POST" && path === "/api/recategorize") {
      const b = await readBody(req);
      if (!b.sourceTxnId || !b.accountCode) return json(res, 400, { ok: false, error: "sourceTxnId and accountCode required" });
      const r = await recategorizeTransaction(sql, tenant, String(b.sourceTxnId), String(b.accountCode), Number(b.businessPct ?? 100));
      return json(res, 200, { ok: r.posted || r.alreadyPosted, ...r });
    }
    if (req.method === "GET" && path === "/api/budgets") {
      return json(res, 200, { budgets: await budgetsWithActuals(sql, tenant, todayISO()) });
    }
    if (req.method === "POST" && path === "/api/budgets") {
      const b = await readBody(req);
      const id = await upsertBudget(sql, tenant, {
        name: String(b.name ?? "Budget"),
        periodKind: (String(b.periodKind ?? "month") as PeriodKind),
        scope: (String(b.scope ?? "category") as BudgetScope),
        accountCode: b.accountCode ? String(b.accountCode) : null,
        projectSlug: b.projectSlug ? String(b.projectSlug) : null,
        limitCents: Math.round(Number(b.limitCents ?? 0)),
        method: b.method ? (String(b.method) as "envelope" | "zero_based" | "fixed") : "envelope",
        alertThresholdPct: b.alertThresholdPct !== undefined ? Number(b.alertThresholdPct) : 80,
      });
      return json(res, 200, { ok: true, id });
    }
    if (req.method === "GET" && path === "/api/advisor") {
      return json(res, 200, { recommendations: await recommendations(sql, tenant) });
    }
    if (req.method === "POST" && path === "/api/advisor/generate") {
      const period = String((await readBody(req)).period ?? "") || (await latestPeriod());
      const r = await generateRecommendations(sql, tenant, period, await netProfitFor(period), todayISO());
      return json(res, 200, { ok: true, generated: r.generated });
    }
    if (req.method === "POST" && path === "/api/reco/status") {
      const b = await readBody(req);
      const ok = await setRecommendationStatus(sql, tenant, Number(b.id), String(b.status) as "ack" | "dismissed" | "done" | "snoozed" | "new");
      return json(res, 200, { ok });
    }
    if (req.method === "GET" && path === "/api/receipts") {
      return json(res, 200, { documents: await documents(sql, tenant) });
    }
    if (req.method === "POST" && path === "/api/receipts") {
      const b = await readBody(req);
      const textBody = String(b.text ?? "");
      if (!textBody.trim()) return json(res, 400, { ok: false, error: "receipt text required" });
      // Bulk Apple purchase-history export → deterministic parser (no LLM, instant).
      if (looksLikeAppleHistory(textBody)) {
        const summary = await importAppleHistory(sql, tenant, textBody);
        return json(res, 200, { ok: true, mode: "apple_history", summary });
      }
      const sourceKind = b.csv ? "csv" : "email";
      const ing = await ingestDocument(sql, tenant, { sourceKind, bytesOrText: textBody, origin: String(b.origin ?? "manual upload") });
      const extractor = new ClaudeDocumentExtractor(spawnClaudeRunner());
      const r = await processDocument(sql, tenant, ing.id, extractor, b.csv ? { csv: textBody } : { ocrText: textBody });
      return json(res, 200, { ok: true, documentId: ing.id, ...r });
    }
    if (req.method === "GET" && path === "/api/review") {
      const period = u.searchParams.get("period") || (await latestPeriod());
      const data = await getDashboardData(sql, tenant, period, new Date().toISOString());
      return json(res, 200, { quarantine: data.quarantine, chart: data.chart, accessRequests: await accessRequests(sql, tenant) });
    }
    if (req.method === "POST" && path === "/api/audit/run") {
      const council = new ClaudeCouncil(spawnClaudeRunner());
      const r = await auditReviewQueue(sql, tenant, council, { confidenceThreshold });
      return json(res, 200, { ok: true, ...r, decisions: undefined, summary: { processed: r.processed, autoPosted: r.autoPosted, escalated: r.escalated, deferred: r.deferred, quarantined: r.quarantined } });
    }
    if (req.method === "POST" && path === "/api/access") {
      const b = await readBody(req);
      const ok = await resolveAccessRequest(sql, tenant, Number(b.id), String(b.decision) === "granted" ? "granted" : "denied");
      return json(res, 200, { ok });
    }
    if (req.method === "GET" && path === "/api/smb") {
      return json(res, 200, await smbSummary(sql, tenant, todayISO()));
    }
    if (req.method === "GET" && path === "/api/apple") {
      const data = await appleCatalog(sql, tenant);
      const chart = await sql<{ code: string; name: string }[]>`
        SELECT code, name FROM acct_chart WHERE is_active AND type IN ('expense','cogs') ORDER BY code`;
      return json(res, 200, { ...data, chart });
    }
    if (req.method === "GET" && path === "/api/accounts") {
      const rows = await sql<{ id: number; name: string | null; mask: string | null; ledger_account_code: string | null }[]>`
        SELECT id, name, mask, ledger_account_code FROM acct_source_accounts WHERE tenant_id = ${tenant} ORDER BY id`;
      return json(res, 200, { accounts: rows });
    }
    if (req.method === "POST" && path === "/api/statement") {
      const b = await readBody(req);
      const accountId = Number(b.accountId);
      const textBody = String(b.text ?? "");
      if (!accountId || !textBody.trim()) return json(res, 400, { ok: false, error: "accountId and statement text required" });
      const txns = looksLikeOfx(textBody) ? parseOfx(textBody) : parseCsv(textBody, { flip: b.flip === true });
      if (txns.length === 0) return json(res, 200, { ok: false, error: "parsed 0 transactions (CSV needs Date + Amount/Debit/Credit columns)" });
      const r = await importStatement(sql, tenant, accountId, txns);
      return json(res, 200, { ok: true, ...r });
    }
    if (req.method === "POST" && path === "/api/apple/classify") {
      const b = await readBody(req);
      const r = await setAppleClassification(
        sql, tenant, Number(b.id), String(b.bucket) as Bucket,
        b.accountCode ? String(b.accountCode) : null,
      );
      return json(res, 200, r);
    }
    if (req.method === "POST" && path === "/api/push/subscribe") {
      const b = await readBody(req);
      const subObj = b.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
      if (!subObj?.endpoint || !subObj.keys?.p256dh || !subObj.keys?.auth) return json(res, 400, { ok: false, error: "bad subscription" });
      await saveSubscription(sql, tenant, { endpoint: subObj.endpoint, keys: { p256dh: subObj.keys.p256dh, auth: subObj.keys.auth }, userAgent: String(req.headers["user-agent"] ?? "") });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/push/test") {
      if (!vapid) return json(res, 400, { ok: false, error: "push not configured (run npm run vapid-keys)" });
      const r = await sendToTenant(sql, tenant, vapid, { title: "Accounting", body: "Push is working — your budget assistant can reach this device.", url: "/" });
      return json(res, 200, { ok: true, ...r });
    }
    return send(res, 404, "text/plain", "not found");
  } catch (e) {
    error("dashboard request failed:", e instanceof Error ? e.message : String(e));
    json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(port, host, () => {
  log(`Accounting web app -> http://${host}:${port}  (tenant=${tenant}${token ? ", token required" : ""}${vapid ? ", push on" : ""})`);
});
