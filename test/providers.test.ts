import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureProvider } from "../src/providers/fixture.js";
import { parseSimpleFinAccounts, SimpleFinProvider } from "../src/providers/simplefin.js";
import { mapPlaidSync, mapPlaidAccounts } from "../src/providers/plaid.js";
import { getProvider } from "../src/providers/index.js";
import type { ProviderAccount, ProviderTransaction } from "../src/core/types.js";

// ─── FixtureProvider ──────────────────────────────────────────────────────────

const FIX_ACCOUNTS: ProviderAccount[] = [
  { providerAccountId: "acc_1", name: "Checking", currency: "usd" },
];
const FIX_TXNS: ProviderTransaction[] = [
  {
    providerTxnId: "t1",
    amountCents: -1999,
    currency: "usd",
    postedDate: "2026-05-10",
    authorizedDate: null,
    pending: false,
    description: "Coffee",
    merchantName: "Blue Bottle",
    categoryProvider: null,
    raw: {},
    providerAccountId: "acc_1",
  },
  {
    providerTxnId: "t2",
    amountCents: 50000,
    currency: "usd",
    postedDate: "2026-05-11",
    authorizedDate: null,
    pending: false,
    description: "Client payment",
    merchantName: null,
    categoryProvider: null,
    raw: {},
    providerAccountId: "acc_1",
  },
];

test("FixtureProvider returns its accounts unchanged", async () => {
  const p = new FixtureProvider(FIX_ACCOUNTS, FIX_TXNS);
  const accts = await p.listAccounts("ignored");
  assert.equal(p.name, "fixture");
  assert.deepEqual(accts, FIX_ACCOUNTS);
});

test("FixtureProvider first sync (cursor null) returns all txns as added, done", async () => {
  const p = new FixtureProvider(FIX_ACCOUNTS, FIX_TXNS);
  const page = await p.syncTransactions("ignored", null);
  assert.equal(page.added.length, 2);
  assert.deepEqual(page.added.map((t) => t.providerTxnId), ["t1", "t2"]);
  assert.deepEqual(page.modified, []);
  assert.deepEqual(page.removed, []);
  assert.equal(page.nextCursor, "done");
  assert.equal(page.hasMore, false);
});

test("FixtureProvider second sync (cursor non-null) returns empty added", async () => {
  const p = new FixtureProvider(FIX_ACCOUNTS, FIX_TXNS);
  const first = await p.syncTransactions("ignored", null);
  const second = await p.syncTransactions("ignored", first.nextCursor);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.modified, []);
  assert.deepEqual(second.removed, []);
  assert.equal(second.hasMore, false);
});

test("FixtureProvider replay is immune to caller mutating the source arrays", async () => {
  const accounts = [...FIX_ACCOUNTS];
  const txns = [...FIX_TXNS];
  const p = new FixtureProvider(accounts, txns);
  txns.length = 0; // mutate after construction
  const page = await p.syncTransactions("ignored", null);
  assert.equal(page.added.length, 2); // still deterministic
});

// ─── SimpleFIN parsing ────────────────────────────────────────────────────────

// A representative SimpleFIN /accounts payload (decimal-dollar string amounts,
// unix-seconds `posted`, a pending flag, and an org name).
const SIMPLEFIN_JSON = {
  errors: [],
  accounts: [
    {
      id: "sf_checking",
      name: "Everyday Checking",
      currency: "USD",
      balance: "4210.55",
      org: { name: "Acme Bank", domain: "acme.example" },
      transactions: [
        {
          id: "sf_t1",
          posted: 1746835200, // 2025-05-10 00:00:00 UTC
          amount: "-19.99",
          description: "Blue Bottle Coffee",
          pending: false,
          payee: "Blue Bottle",
          category: "Food & Drink",
        },
        {
          id: "sf_t2",
          posted: 1746921600, // 2025-05-11 00:00:00 UTC
          amount: "500.00",
          description: "Client deposit",
          pending: true,
        },
      ],
    },
  ],
};

test("parseSimpleFinAccounts maps account fields + currency lowercased", () => {
  const { accounts } = parseSimpleFinAccounts(SIMPLEFIN_JSON);
  assert.equal(accounts.length, 1);
  const a = accounts[0]!;
  assert.equal(a.providerAccountId, "sf_checking");
  assert.equal(a.name, "Everyday Checking");
  assert.equal(a.currency, "usd");
  assert.equal(a.type, "Acme Bank");
});

test("parseSimpleFinAccounts maps amount (signed cents), date (UTC YYYY-MM-DD), pending", () => {
  const { transactions } = parseSimpleFinAccounts(SIMPLEFIN_JSON);
  assert.equal(transactions.length, 2);

  const t1 = transactions[0]!;
  assert.equal(t1.providerTxnId, "sf_t1");
  assert.equal(t1.amountCents, -1999); // outflow stays negative
  assert.equal(t1.postedDate, "2025-05-10");
  assert.equal(t1.pending, false);
  assert.equal(t1.merchantName, "Blue Bottle");
  assert.equal(t1.categoryProvider, "Food & Drink");
  assert.equal(t1.providerAccountId, "sf_checking");
  assert.equal(t1.authorizedDate, null);
  assert.equal(t1.currency, "usd");

  const t2 = transactions[1]!;
  assert.equal(t2.amountCents, 50000); // inflow positive
  assert.equal(t2.postedDate, "2025-05-11");
  assert.equal(t2.pending, true);
  assert.equal(t2.merchantName, null);
});

test("parseSimpleFinAccounts is null/shape-safe (empty object, missing accounts)", () => {
  assert.deepEqual(parseSimpleFinAccounts({}), { accounts: [], transactions: [], warnings: [] });
  assert.deepEqual(parseSimpleFinAccounts(null), { accounts: [], transactions: [], warnings: [] });
  const { transactions } = parseSimpleFinAccounts({
    accounts: [{ id: "x", name: "X" }],
  });
  assert.deepEqual(transactions, []); // account with no transactions array
});

test("SimpleFinProvider advertises its name", () => {
  const p = new SimpleFinProvider();
  assert.equal(p.name, "simplefin");
});

// ─── Plaid mapping ───────────────────────────────────────────────────────────

// A representative /transactions/sync payload. Plaid amount is POSITIVE for an
// outflow; our convention flips it (outflow → negative).
const PLAID_SYNC_JSON = {
  added: [
    {
      transaction_id: "pl_t1",
      account_id: "pl_acc_1",
      amount: 19.99, // outflow in Plaid's convention
      iso_currency_code: "USD",
      date: "2026-05-10",
      authorized_date: "2026-05-09",
      pending: false,
      name: "Blue Bottle Coffee",
      merchant_name: "Blue Bottle",
      personal_finance_category: { primary: "FOOD_AND_DRINK" },
    },
  ],
  modified: [
    {
      transaction_id: "pl_t2",
      account_id: "pl_acc_1",
      amount: -500.0, // inflow in Plaid's convention
      iso_currency_code: "USD",
      date: "2026-05-11",
      authorized_date: null,
      pending: false,
      name: "Client deposit",
      merchant_name: null,
      category: ["Transfer", "Deposit"],
    },
  ],
  removed: [{ transaction_id: "pl_gone" }],
  next_cursor: "CURSOR_ABC",
  has_more: true,
};

test("mapPlaidSync flips signs: Plaid positive outflow becomes our negative", () => {
  const page = mapPlaidSync(PLAID_SYNC_JSON);
  assert.equal(page.added.length, 1);
  const t1 = page.added[0]!;
  assert.equal(t1.amountCents, -1999); // 19.99 outflow → -1999
  assert.equal(t1.providerTxnId, "pl_t1");
  assert.equal(t1.providerAccountId, "pl_acc_1");
  assert.equal(t1.postedDate, "2026-05-10");
  assert.equal(t1.authorizedDate, "2026-05-09");
  assert.equal(t1.merchantName, "Blue Bottle");
  assert.equal(t1.categoryProvider, "FOOD_AND_DRINK");
  assert.equal(t1.currency, "usd");
});

test("mapPlaidSync flips an inflow (Plaid negative) to our positive", () => {
  const page = mapPlaidSync(PLAID_SYNC_JSON);
  assert.equal(page.modified.length, 1);
  const t2 = page.modified[0]!;
  assert.equal(t2.amountCents, 50000); // -500.00 inflow → +50000
  assert.equal(t2.categoryProvider, "Transfer"); // fallback to category[0]
});

test("mapPlaidSync passes through removed ids, cursor, and has_more", () => {
  const page = mapPlaidSync(PLAID_SYNC_JSON);
  assert.deepEqual(page.removed, ["pl_gone"]);
  assert.equal(page.nextCursor, "CURSOR_ABC");
  assert.equal(page.hasMore, true);
});

test("mapPlaidSync is shape-safe on an empty/partial response", () => {
  const page = mapPlaidSync({});
  assert.deepEqual(page.added, []);
  assert.deepEqual(page.modified, []);
  assert.deepEqual(page.removed, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.hasMore, false);
});

test("mapPlaidAccounts maps id/name/mask/type/subtype/currency", () => {
  const accounts = mapPlaidAccounts({
    accounts: [
      {
        account_id: "pl_acc_1",
        name: "Plaid Checking",
        mask: "0000",
        type: "depository",
        subtype: "checking",
        balances: { iso_currency_code: "USD" },
      },
    ],
  });
  assert.equal(accounts.length, 1);
  const a = accounts[0]!;
  assert.equal(a.providerAccountId, "pl_acc_1");
  assert.equal(a.name, "Plaid Checking");
  assert.equal(a.mask, "0000");
  assert.equal(a.type, "depository");
  assert.equal(a.subtype, "checking");
  assert.equal(a.currency, "usd");
});

// ─── getProvider factory ───────────────────────────────────────────────────────

test("getProvider returns the right concrete provider by name", () => {
  assert.equal(getProvider("fixture").name, "fixture");
  assert.equal(getProvider("simplefin").name, "simplefin");
  assert.equal(
    getProvider("plaid", { clientId: "c", secret: "s", baseUrl: "https://sandbox.plaid.com" }).name,
    "plaid",
  );
});

test("getProvider('fixture', config) wires through accounts + transactions", async () => {
  const p = getProvider("fixture", { accounts: FIX_ACCOUNTS, transactions: FIX_TXNS });
  const accts = await p.listAccounts("ignored");
  const page = await p.syncTransactions("ignored", null);
  assert.equal(accts.length, 1);
  assert.equal(page.added.length, 2);
});

test("getProvider('plaid') without config throws (needs credentials)", () => {
  assert.throws(() => getProvider("plaid"), /plaid provider needs/);
});
