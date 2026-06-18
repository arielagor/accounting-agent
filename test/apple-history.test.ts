/**
 * Apple purchase-history parser + classifier tests (pure, no DB). Covers single-item
 * paid orders, multi-item orders, Free items, period/refund metadata, and the
 * business/personal/review classification.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  parseAppleHistory,
  classifyAppleItem,
  looksLikeAppleHistory,
  auditAppleReview,
} from "../src/core/apple-history.js";
import { normalizeMerchant } from "../src/core/categorize.js";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";

const SAMPLE = `Jun 14, 2026
MT8ZLX0SX6
Total $249.99
Claude Max 20x - Monthly
Claude Max 20x - Monthly
Claude by Anthropic
Renews Jul 14, 2026
$249.99

Jun 14, 2026
R24Z1L634J3F4H
Total $0.00
Pioneer ARC
Pioneer ARC
Pioneer Corporation
Free

May 23, 2026
MT8ZJ1B5QT
Total $54.99
Creator Monthly
Creator Monthly
HeyGen: AI Video Generator
Expires: Jun 23, 2026
$29.00
Creator Monthly
Creator Monthly
ElevenLabs: AI Voice Generator
Expires: Jun 23, 2026
$22.00
Five Easy Pieces
Five Easy Pieces
Bob Rafelson
$3.99

Jan 30, 2025
MT8XS20945
Total $19.98
Disney+ Premium
Disney+ Premium
Disney+
Jan 30, 2025 - Feb 28, 2025
$15.99
Hook
Hook
Steven Spielberg
$3.99`;

test("parseAppleHistory parses orders, totals, and items", () => {
  const orders = parseAppleHistory(SAMPLE);
  assert.equal(orders.length, 4);

  const claude = orders[0]!;
  assert.equal(claude.orderId, "MT8ZLX0SX6");
  assert.equal(claude.date, "2026-06-14");
  assert.equal(claude.totalCents, 24999);
  assert.equal(claude.items.length, 1);
  assert.equal(claude.items[0]!.name, "Claude Max 20x - Monthly");
  assert.equal(claude.items[0]!.vendor, "Claude by Anthropic");
  assert.equal(claude.items[0]!.amountCents, 24999);

  const free = orders[1]!;
  assert.equal(free.items[0]!.free, true);
  assert.equal(free.items[0]!.amountCents, 0);

  const multi = orders[2]!;
  assert.equal(multi.items.length, 3, "HeyGen + ElevenLabs + movie");
  assert.equal(multi.items[0]!.amountCents, 2900);
  assert.equal(multi.items[1]!.vendor, "ElevenLabs: AI Voice Generator");
  assert.equal(multi.items[2]!.amountCents, 399);
});

test("classifyAppleItem routes AI/dev tools to business and entertainment to personal", () => {
  assert.equal(classifyAppleItem("claude max 20x - monthly claude by anthropic").bucket, "business");
  assert.equal(classifyAppleItem("creator monthly heygen: ai video generator").bucket, "business");
  assert.equal(classifyAppleItem("creator monthly elevenlabs: ai voice generator").accountCode, "6150");
  assert.equal(classifyAppleItem("disney+ premium disney+").bucket, "personal");
  assert.equal(classifyAppleItem("disney+ premium disney+").accountCode, "9500");
  assert.equal(classifyAppleItem("tinder gold tinder dating app").bucket, "personal");
  assert.equal(classifyAppleItem("apple developer apple").accountCode, "6110");
  // A purchased film is personal entertainment.
  assert.equal(classifyAppleItem("five easy pieces bob rafelson").bucket, "personal");
  // A genuinely uncategorized utility → review (never force-guessed).
  assert.equal(classifyAppleItem("remote mouse 耀 阮").bucket, "review");
});

test("looksLikeAppleHistory detects the bulk export shape", () => {
  assert.equal(looksLikeAppleHistory(SAMPLE), true);
  assert.equal(looksLikeAppleHistory("just a normal receipt for $5.00 at a coffee shop"), false);
});

// ─── DB-backed: the lean-to-business Apple reviewer (Ariel 2026-06-17) ────────────────
const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_apple_lean";
const VENDORS = { ambig: "AmbigCo", game: "GameCo", mystery: "MysteryCo", dev: "DevCo" };

// A mock runner that returns a fixed verdict for the 4 seeded rows (indices 0..3),
// including a `tossup` flag — ignored unless the reviewer runs in lean mode.
const mockRunner = {
  async run() {
    return JSON.stringify({
      items: [
        { i: 0, bucket: "business", accountCode: "6150", tossup: true }, // a leaned toss-up
        { i: 1, bucket: "personal", accountCode: "9500" },
        { i: 2, bucket: "review", accountCode: null }, // truly can't tell → stays
        { i: 3, bucket: "business", accountCode: "6160", tossup: false }, // confident business
      ],
    });
  },
};

let sql: Sql;
let dbUp = false;

async function seedApple(): Promise<void> {
  await sql`DELETE FROM acct_apple_purchases WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_merchant_rules WHERE merchant_key IN (${normalizeMerchant(VENDORS.ambig)}, ${normalizeMerchant(VENDORS.dev)})`;
  const rows: [string, string, string | null][] = [
    [VENDORS.ambig, "Ambiguous Pro Tool", "Renews Jul 1, 2026"],
    [VENDORS.game, "Some Game", null],
    [VENDORS.mystery, "Mystery Thing", null],
    [VENDORS.dev, "Clear Dev SaaS", "Renews Jul 1, 2026"],
  ];
  let ln = 1;
  for (const [vendor, item, period] of rows) {
    await sql`
      INSERT INTO acct_apple_purchases
        (tenant_id, order_id, order_date, line_no, item, vendor, period, amount_cents, order_total_cents, bucket, account_code)
      VALUES (${TENANT}, 'apple-test', '2026-05-01', ${ln}, ${item}, ${vendor}, ${period}, 999, 999, 'review', NULL)`;
    ln += 1;
  }
}

before(async () => {
  sql = openSql(url);
  try {
    await sql`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

after(async () => {
  if (dbUp) {
    await sql`DELETE FROM acct_apple_purchases WHERE tenant_id = ${TENANT}`;
    await sql`DELETE FROM acct_merchant_rules WHERE merchant_key IN (${normalizeMerchant(VENDORS.ambig)}, ${normalizeMerchant(VENDORS.dev)})`;
  }
  await sql.end({ timeout: 5 });
});

test("auditAppleReview LEAN mode books a defensible toss-up as business and flags it", async (t) => {
  if (!dbUp) return t.skip("no database");
  await seedApple();
  const r = await auditAppleReview(sql, TENANT, mockRunner, 25, true);
  assert.equal(r.business, 2, "the toss-up + the confident one both land business");
  assert.equal(r.personal, 1);
  assert.equal(r.stillReview, 1, "the truly-unsure item stays in review");
  assert.equal(r.leanedBusiness, 1, "only the tossup item counts as leaned");

  const got = await sql<{ vendor: string; bucket: string; auto_leaned: boolean }[]>`
    SELECT vendor, bucket, auto_leaned FROM acct_apple_purchases WHERE tenant_id = ${TENANT} ORDER BY line_no`;
  const by = Object.fromEntries(got.map((g) => [g.vendor, g]));
  assert.equal(by[VENDORS.ambig]!.bucket, "business");
  assert.equal(by[VENDORS.ambig]!.auto_leaned, true, "leaned toss-up is flagged for review");
  assert.equal(by[VENDORS.dev]!.bucket, "business");
  assert.equal(by[VENDORS.dev]!.auto_leaned, false, "a confident classification is not a lean");
  assert.equal(by[VENDORS.mystery]!.bucket, "review");

  // A leaned toss-up must NOT harden into a merchant rule; a confident one does.
  const ambigRule = await sql<{ n: string }[]>`SELECT count(*) n FROM acct_merchant_rules WHERE merchant_key = ${normalizeMerchant(VENDORS.ambig)}`;
  assert.equal(Number(ambigRule[0]!.n), 0, "no rule learned for a leaned toss-up until a human confirms");
  const devRule = await sql<{ n: string }[]>`SELECT count(*) n FROM acct_merchant_rules WHERE merchant_key = ${normalizeMerchant(VENDORS.dev)}`;
  assert.equal(Number(devRule[0]!.n), 1, "confident recurring business sub still learns a rule");
});

test("auditAppleReview OFF (default): no lean, no auto_leaned flag, toss-up learns a rule", async (t) => {
  if (!dbUp) return t.skip("no database");
  await seedApple();
  const r = await auditAppleReview(sql, TENANT, mockRunner, 25, false);
  assert.equal(r.leanedBusiness, 0, "nothing is 'leaned' when the flag is off");
  const got = await sql<{ vendor: string; bucket: string; auto_leaned: boolean }[]>`
    SELECT vendor, bucket, auto_leaned FROM acct_apple_purchases WHERE tenant_id = ${TENANT} ORDER BY line_no`;
  const by = Object.fromEntries(got.map((g) => [g.vendor, g]));
  // The mock still returns business for the toss-up, but it is not marked leaned…
  assert.equal(by[VENDORS.ambig]!.auto_leaned, false);
  // …and because it isn't a lean, the recurring sub learns a rule as before.
  const ambigRule = await sql<{ n: string }[]>`SELECT count(*) n FROM acct_merchant_rules WHERE merchant_key = ${normalizeMerchant(VENDORS.ambig)}`;
  assert.equal(Number(ambigRule[0]!.n), 1, "flag off preserves the original learn-on-confident-classify behavior");
});
