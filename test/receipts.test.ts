/**
 * Receipt ingest + auto-split tests. The pure split-builder cases run anywhere; the
 * pipeline cases run against the real `accounting` DB on a dedicated tenant and skip
 * if no DB is reachable. The headline proof: a forwarded Apple receipt splits the
 * aggregate APPLE.COM/BILL charge into components that tie to the cent, voids nothing
 * it shouldn't, and resolves the aggregate's quarantine.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { buildSplitChargeEntry } from "../src/core/posting.js";
import { assertBalanced } from "../src/core/ledger.js";
import {
  ingestDocument,
  extractDocument,
  matchDocument,
  splitCharge,
} from "../src/core/receipts.js";
import type { DocumentExtractor, ExtractedDocument } from "../src/core/types.js";

// ─── Pure: the split-charge builder ────────────────────────────────────────────
test("buildSplitChargeEntry balances and ties components + residual to the charge", () => {
  const entry = buildSplitChargeEntry({
    entryDate: "2026-04-15",
    idempotencyKey: "raw:1:split",
    chargeCents: 2500,
    paidFromAccountCode: "2010",
    lines: [
      { expenseAccountCode: "6160", amountCents: 1500, memo: "iCloud+" },
      { expenseAccountCode: "6160", amountCents: 800, memo: "an app" },
    ],
  });
  assertBalanced(entry);
  const debits = entry.lines.reduce((a, l) => a + l.debitCents, 0);
  const credits = entry.lines.reduce((a, l) => a + l.creditCents, 0);
  assert.equal(debits, 2500);
  assert.equal(credits, 2500);
  // The $2.00 residual (2500 - 2300) lands in 9000 suspense, flagged not fabricated.
  const suspense = entry.lines.find((l) => l.accountCode === "9000");
  assert.ok(suspense && suspense.debitCents === 200, "residual to suspense");
});

test("buildSplitChargeEntry splits a mixed-use component into business + personal", () => {
  const entry = buildSplitChargeEntry({
    entryDate: "2026-04-15",
    idempotencyKey: "raw:2:split",
    chargeCents: 1000,
    paidFromAccountCode: "2010",
    lines: [{ expenseAccountCode: "6160", amountCents: 1000, businessPct: 60 }],
  });
  assertBalanced(entry);
  const biz = entry.lines.find((l) => l.accountCode === "6160");
  const personal = entry.lines.find((l) => l.accountCode === "9500");
  assert.equal(biz?.debitCents, 600);
  assert.equal(personal?.debitCents, 400);
});

test("buildSplitChargeEntry throws when components exceed the charge", () => {
  assert.throws(() =>
    buildSplitChargeEntry({
      entryDate: "2026-04-15",
      idempotencyKey: "raw:3:split",
      chargeCents: 1000,
      paidFromAccountCode: "2010",
      lines: [{ expenseAccountCode: "6160", amountCents: 1500 }],
    }),
  );
});

// ─── Pipeline (DB-backed) ───────────────────────────────────────────────────────
const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_receipts";

/** A deterministic extractor returning a canned Apple receipt — no subprocess/network. */
const appleExtractor: DocumentExtractor = {
  async extract(): Promise<ExtractedDocument> {
    return {
      vendorGuess: "APPLE.COM/BILL",
      docDate: "2026-04-15",
      totalCents: 2500,
      currency: "usd",
      lines: [
        { description: "iCloud+ 200GB", amountCents: 1500, candidateAccountCode: "6160", businessPct: 100 },
        { description: "Some App subscription", amountCents: 1000, candidateAccountCode: "6160", businessPct: 100 },
      ],
    };
  },
};

let sql: Sql;
let dbUp = false;
let rawId = 0;

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_review_queue WHERE source_txn_id IN (
    SELECT 'raw:' || id FROM acct_transactions_raw WHERE tenant_id = ${TENANT})`;
  await sql`DELETE FROM acct_document_matches WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_document_lines WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_documents WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_access_requests WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_audit_log WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_transactions_raw WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_source_accounts WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_connections WHERE tenant_id = ${TENANT}`;
}

async function seed(): Promise<void> {
  const [conn] = await sql<{ id: number }[]>`
    INSERT INTO acct_connections (tenant_id, provider, institution_name, access_token_enc, status)
    VALUES (${TENANT}, 'fixture', 'Test Bank', 'x', 'active') RETURNING id`;
  const [card] = await sql<{ id: number }[]>`
    INSERT INTO acct_source_accounts (connection_id, tenant_id, provider_account_id, name, type, subtype, ledger_account_code)
    VALUES (${conn!.id}, ${TENANT}, 'card1', 'Card', 'credit', 'credit card', '2010') RETURNING id`;
  const [raw] = await sql<{ id: number }[]>`
    INSERT INTO acct_transactions_raw
      (source_account_id, tenant_id, provider, provider_txn_id, dedup_key, amount_cents,
       posted_date, pending, description_raw, merchant_name)
    VALUES (${card!.id}, ${TENANT}, 'fixture', 't-apple', 't-apple', -2500,
            '2026-04-15', false, 'APPLE.COM/BILL', 'APPLE.COM/BILL') RETURNING id`;
  rawId = raw!.id;
  // Simulate the aggregate sitting quarantined as needs_split (what the close does).
  await sql`INSERT INTO acct_review_queue (source_txn_id, reason) VALUES (${`raw:${rawId}`}, 'needs_split')
            ON CONFLICT (source_txn_id) DO NOTHING`;
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

test("ingest is idempotent on content sha256", async (t) => {
  if (!dbUp) return t.skip("no database");
  const a = await ingestDocument(sql, TENANT, { sourceKind: "email", bytesOrText: "APPLE RECEIPT BODY" });
  const b = await ingestDocument(sql, TENANT, { sourceKind: "email", bytesOrText: "APPLE RECEIPT BODY" });
  assert.equal(a.alreadyExisted, false);
  assert.equal(b.alreadyExisted, true);
  assert.equal(a.id, b.id);
});

test("extract → match → split posts a balanced split that ties to the charge and clears the quarantine", async (t) => {
  if (!dbUp) return t.skip("no database");
  const { id } = await ingestDocument(sql, TENANT, {
    sourceKind: "email",
    bytesOrText: "APPLE RECEIPT — iCloud+ + an app — total $25.00",
  });
  const extracted = await extractDocument(sql, TENANT, id, appleExtractor, { ocrText: "..." });
  assert.ok(extracted && extracted.lines.length === 2);

  const match = await matchDocument(sql, TENANT, id);
  assert.equal(match.matched, true);
  assert.equal(match.rawTxnId, rawId);
  assert.equal(match.deltaCents, 0);

  const split = await splitCharge(sql, TENANT, id);
  assert.equal(split.posted, true, split.reason);

  // The posted split must balance and credit the card for exactly the charge.
  const sums = await sql<{ d: string; c: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents),0) d, COALESCE(SUM(l.credit_cents),0) c
    FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id
    WHERE e.id = ${split.entryId!}`;
  assert.equal(Number(sums[0]!.d), 2500);
  assert.equal(Number(sums[0]!.c), 2500);

  // The aggregate's quarantine is resolved.
  const open = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_review_queue WHERE source_txn_id = ${`raw:${rawId}`} AND status = 'open'`;
  assert.equal(Number(open[0]!.n), 0, "quarantine resolved");

  // Document advanced to 'split'.
  const doc = await sql<{ status: string }[]>`SELECT status FROM acct_documents WHERE id = ${id}`;
  assert.equal(doc[0]!.status, "split");
});

test("an unmatchable receipt goes to 'unmatched' and files an access-request (never guesses)", async (t) => {
  if (!dbUp) return t.skip("no database");
  const { id } = await ingestDocument(sql, TENANT, {
    sourceKind: "email",
    bytesOrText: "MYSTERY VENDOR receipt for $987.65 on 2030-01-01",
  });
  const noMatchExtractor: DocumentExtractor = {
    async extract(): Promise<ExtractedDocument> {
      return {
        vendorGuess: "MYSTERY VENDOR",
        docDate: "2030-01-01",
        totalCents: 98765,
        currency: "usd",
        lines: [{ description: "thing", amountCents: 98765 }],
      };
    },
  };
  await extractDocument(sql, TENANT, id, noMatchExtractor, { ocrText: "..." });
  const match = await matchDocument(sql, TENANT, id);
  assert.equal(match.matched, false);

  const doc = await sql<{ status: string }[]>`SELECT status FROM acct_documents WHERE id = ${id}`;
  assert.equal(doc[0]!.status, "unmatched");

  const reqs = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_access_requests
    WHERE tenant_id = ${TENANT} AND requested_for_txn = ${`doc:${id}`} AND status = 'open'`;
  assert.ok(Number(reqs[0]!.n) >= 1, "access-request filed for the unmatched receipt");
});
