/**
 * Autonomous auditor tests. A deterministic mock council drives each verdict path
 * (resolve→post, needs-access→defer, human-gate→escalate, unresolved→quarantine),
 * plus the deterministic guards (sensitive account / large amount force a human even
 * when the council is confident). Pure ClaudeCouncil parsing is covered with a mock
 * runner. DB-backed cases use a dedicated tenant and skip if no DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { auditOne, auditReviewQueue, type AuditorConfig } from "../src/core/auditor.js";
import { ClaudeCouncil } from "../src/lib/llm.js";
import type { CouncilEscalator, CouncilVerdict } from "../src/core/types.js";

// ─── Pure: ClaudeCouncil JSON parsing ────────────────────────────────────────────
const ctx = { chart: [{ code: "6160", name: "Software", type: "expense" as const }], projects: [] };
const txnInput = {
  sourceTxnId: "raw:1",
  merchant: "VENDOR",
  amountCents: -1000,
  memo: "x",
  postedDate: "2026-04-10",
  isOutflow: true,
};

test("ClaudeCouncil parses a confident resolution", async () => {
  const council = new ClaudeCouncil({
    async run() {
      return '{"resolved":true,"accountCode":"6160","projectSlug":null,"businessPct":100,"confidence":0.95,"rationale":"clearly software","humanGate":null,"needsAccess":null}';
    },
  });
  const v = await council.deliberate(txnInput, ctx);
  assert.equal(v.resolved, true);
  assert.equal(v.accountCode, "6160");
  assert.equal(v.confidence, 0.95);
});

test("ClaudeCouncil forces resolved=false when a human-gate is present", async () => {
  const council = new ClaudeCouncil({
    async run() {
      return 'Council says: {"resolved":true,"accountCode":"6300","businessPct":90,"confidence":0.9,"rationale":"home office","humanGate":"aggressive home-office %","needsAccess":null}';
    },
  });
  const v = await council.deliberate(txnInput, ctx);
  assert.equal(v.resolved, false, "human-gate overrides resolved");
  assert.equal(v.humanGate, "aggressive home-office %");
});

test("ClaudeCouncil surfaces a needsAccess request and stays unresolved", async () => {
  const council = new ClaudeCouncil({
    async run() {
      return '{"resolved":false,"accountCode":null,"confidence":0.4,"rationale":"need the receipt","humanGate":null,"needsAccess":{"resource":"apple_receipts","reason":"itemize the Apple bill","howToGrant":"forward the receipt"}}';
    },
  });
  const v = await council.deliberate(txnInput, ctx);
  assert.equal(v.resolved, false);
  assert.equal(v.needsAccess?.resource, "apple_receipts");
});

test("ClaudeCouncil returns unresolved on garbage output (fail-soft)", async () => {
  const council = new ClaudeCouncil({
    async run() {
      return "the model rambled with no json";
    },
  });
  const v = await council.deliberate(txnInput, ctx);
  assert.equal(v.resolved, false);
});

// ─── DB-backed: the auditor acting on verdicts ───────────────────────────────────
const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_auditor";
const CONFIG: AuditorConfig = { confidenceThreshold: 0.85, humanGateAmountCents: 500_000 };

/** A council that returns a fixed verdict, ignoring input. */
function fixedCouncil(v: CouncilVerdict): CouncilEscalator {
  return { async deliberate() { return v; } };
}

let sql: Sql;
let dbUp = false;
const rawIds: Record<string, number> = {};

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_review_queue WHERE source_txn_id IN (
    SELECT 'raw:' || id FROM acct_transactions_raw WHERE tenant_id = ${TENANT})`;
  await sql`DELETE FROM acct_auditor_decisions WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_access_requests WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_audit_log WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_merchant_rules WHERE merchant_key IN ('ambiguous vendor','sensitive vendor','huge vendor')`;
  await sql`DELETE FROM acct_transactions_raw WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_source_accounts WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_connections WHERE tenant_id = ${TENANT}`;
}

async function addTxn(cardId: number, merchant: string, amt: number, ptid: string): Promise<number> {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO acct_transactions_raw
      (source_account_id, tenant_id, provider, provider_txn_id, dedup_key, amount_cents,
       posted_date, pending, description_raw, merchant_name)
    VALUES (${cardId}, ${TENANT}, 'fixture', ${ptid}, ${ptid}, ${amt}, '2026-04-12', false, ${merchant}, ${merchant})
    RETURNING id`;
  await sql`INSERT INTO acct_review_queue (source_txn_id, reason) VALUES (${`raw:${r!.id}`}, 'new_merchant')
            ON CONFLICT (source_txn_id) DO NOTHING`;
  return r!.id;
}

async function seed(): Promise<void> {
  const [conn] = await sql<{ id: number }[]>`
    INSERT INTO acct_connections (tenant_id, provider, institution_name, access_token_enc, status)
    VALUES (${TENANT}, 'fixture', 'Test Bank', 'x', 'active') RETURNING id`;
  const [card] = await sql<{ id: number }[]>`
    INSERT INTO acct_source_accounts (connection_id, tenant_id, provider_account_id, name, type, subtype, ledger_account_code)
    VALUES (${conn!.id}, ${TENANT}, 'card1', 'Card', 'credit', 'credit card', '2010') RETURNING id`;
  rawIds.ambiguous = await addTxn(card!.id, "AMBIGUOUS VENDOR", -4200, "t-amb");
  rawIds.access = await addTxn(card!.id, "APPLE.COM/BILL", -2500, "t-acc");
  rawIds.gate = await addTxn(card!.id, "HOME DEPOT", -8000, "t-gate");
  rawIds.sensitive = await addTxn(card!.id, "SENSITIVE VENDOR", -3000, "t-sens");
  rawIds.huge = await addTxn(card!.id, "HUGE VENDOR", -900_000, "t-huge");
}

before(async () => {
  sql = openSql(url);
  try {
    await sql`SELECT 1`;
    dbUp = true;
    await clean();
    await seed();
  } catch {
    dbUp = false;
  }
});

after(async () => {
  if (dbUp) await clean();
  await sql.end({ timeout: 5 });
});

test("confident council verdict auto-posts and clears the quarantine", async (t) => {
  if (!dbUp) return t.skip("no database");
  const src = `raw:${rawIds.ambiguous}`;
  const d = await auditOne(
    sql,
    TENANT,
    src,
    fixedCouncil({ resolved: true, accountCode: "6160", projectSlug: null, businessPct: 100, confidence: 0.95, rationale: "software" }),
    CONFIG,
  );
  assert.equal(d.verdict, "auto_posted");
  assert.equal(d.basis, "council");

  const posted = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_journal_entries WHERE tenant_id = ${TENANT} AND source_txn_id = ${src} AND status = 'posted'`;
  assert.equal(Number(posted[0]!.n), 1, "auditor posted the entry");
  const open = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_review_queue WHERE source_txn_id = ${src} AND status = 'open'`;
  assert.equal(Number(open[0]!.n), 0, "quarantine cleared");
  const dec = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_auditor_decisions WHERE tenant_id = ${TENANT} AND source_txn_id = ${src} AND verdict = 'auto_posted'`;
  assert.equal(Number(dec[0]!.n), 1, "decision recorded");
});

test("needs-access verdict files an access-request and defers (no post)", async (t) => {
  if (!dbUp) return t.skip("no database");
  const src = `raw:${rawIds.access}`;
  const d = await auditOne(
    sql,
    TENANT,
    src,
    fixedCouncil({
      resolved: false,
      accountCode: null,
      confidence: 0.4,
      rationale: "need the itemized Apple receipt",
      needsAccess: { resource: "apple_receipts_inbox", reason: "split the aggregate Apple bill", howToGrant: "forward receipts to the inbox" },
    }),
    CONFIG,
  );
  assert.equal(d.verdict, "deferred_access");
  assert.equal(d.basis, "research");
  assert.ok(d.accessRequestId);

  const posted = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_journal_entries WHERE tenant_id = ${TENANT} AND source_txn_id = ${src} AND status = 'posted'`;
  assert.equal(Number(posted[0]!.n), 0, "nothing posted");
  const req = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_access_requests WHERE tenant_id = ${TENANT} AND requested_for_txn = ${src} AND status = 'open'`;
  assert.ok(Number(req[0]!.n) >= 1, "access-request filed");
});

test("human-gate verdict escalates and never auto-posts", async (t) => {
  if (!dbUp) return t.skip("no database");
  const src = `raw:${rawIds.gate}`;
  const d = await auditOne(
    sql,
    TENANT,
    src,
    fixedCouncil({ resolved: false, accountCode: "6300", businessPct: 95, confidence: 0.9, rationale: "home office", humanGate: "aggressive home-office %" }),
    CONFIG,
  );
  assert.equal(d.verdict, "escalated");
  const posted = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_journal_entries WHERE tenant_id = ${TENANT} AND source_txn_id = ${src} AND status = 'posted'`;
  assert.equal(Number(posted[0]!.n), 0);
});

test("a sensitive account is escalated even when the council is confident", async (t) => {
  if (!dbUp) return t.skip("no database");
  const src = `raw:${rawIds.sensitive}`;
  const d = await auditOne(
    sql,
    TENANT,
    src,
    fixedCouncil({ resolved: true, accountCode: "6310", businessPct: 100, confidence: 0.99, rationale: "vehicle" }),
    CONFIG,
  );
  assert.equal(d.verdict, "escalated", "sensitive account guard fires regardless of confidence");
});

test("a large charge is escalated even when the council is confident", async (t) => {
  if (!dbUp) return t.skip("no database");
  const src = `raw:${rawIds.huge}`;
  const d = await auditOne(
    sql,
    TENANT,
    src,
    fixedCouncil({ resolved: true, accountCode: "6160", businessPct: 100, confidence: 0.99, rationale: "big software buy" }),
    CONFIG,
  );
  assert.equal(d.verdict, "escalated", "large-amount guard fires");
});

test("auditReviewQueue tallies the remaining open items", async (t) => {
  if (!dbUp) return t.skip("no database");
  // After the above, the access/gate/sensitive/huge items remain open; ambiguous was posted.
  const res = await auditReviewQueue(
    sql,
    TENANT,
    fixedCouncil({ resolved: false, accountCode: null, confidence: 0.2, rationale: "still unsure" }),
    CONFIG,
  );
  assert.ok(res.processed >= 1);
  assert.equal(res.processed, res.autoPosted + res.escalated + res.deferred + res.quarantined);
});
