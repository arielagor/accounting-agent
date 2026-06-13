import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExpenseEntry,
  buildRevenueEntry,
  buildTransferEntry,
  buildStripePayoutEntry,
} from "../src/core/posting.js";
import { sumCents } from "../src/core/money.js";

function debits(e: { lines: { debitCents: number }[] }): number {
  return sumCents(e.lines.map((l) => l.debitCents));
}
function credits(e: { lines: { creditCents: number }[] }): number {
  return sumCents(e.lines.map((l) => l.creditCents));
}

test("expense entry balances and puts debit on expense, credit on the card", () => {
  const e = buildExpenseEntry({
    entryDate: "2026-05-10",
    idempotencyKey: "k1",
    amountCents: 1999,
    expenseAccountCode: "6160",
    paidFromAccountCode: "2010",
  });
  assert.equal(debits(e), credits(e));
  const exp = e.lines.find((l) => l.accountCode === "6160")!;
  const card = e.lines.find((l) => l.accountCode === "2010")!;
  assert.equal(exp.debitCents, 1999);
  assert.equal(card.creditCents, 1999);
});

test("mixed-use expense splits exactly business/personal and still balances", () => {
  const e = buildExpenseEntry({
    entryDate: "2026-05-10",
    idempotencyKey: "k2",
    amountCents: 1000,
    expenseAccountCode: "6100",
    paidFromAccountCode: "1010",
    businessPct: 60,
  });
  assert.equal(debits(e), credits(e));
  const biz = e.lines.find((l) => l.accountCode === "6100")!;
  const personal = e.lines.find((l) => l.accountCode === "9500")!;
  assert.equal(biz.debitCents, 600);
  assert.equal(personal.debitCents, 400);
  assert.equal(biz.debitCents + personal.debitCents, 1000);
});

test("100% business expense has no personal line", () => {
  const e = buildExpenseEntry({
    entryDate: "2026-05-10",
    idempotencyKey: "k3",
    amountCents: 500,
    expenseAccountCode: "6150",
    paidFromAccountCode: "2010",
    businessPct: 100,
  });
  assert.equal(e.lines.filter((l) => l.accountCode === "9500").length, 0);
  assert.equal(debits(e), credits(e));
});

test("revenue entry debits the asset, credits revenue", () => {
  const e = buildRevenueEntry({
    entryDate: "2026-05-10",
    idempotencyKey: "k4",
    amountCents: 29900,
    revenueAccountCode: "4035",
    depositedToAccountCode: "1010",
  });
  assert.equal(debits(e), credits(e));
  assert.equal(e.lines.find((l) => l.accountCode === "1010")!.debitCents, 29900);
  assert.equal(e.lines.find((l) => l.accountCode === "4035")!.creditCents, 29900);
});

test("transfer (card payment) nets to zero, no expense account touched", () => {
  const e = buildTransferEntry({
    entryDate: "2026-05-10",
    idempotencyKey: "k5",
    amountCents: 5000,
    fromAccountCode: "1010", // checking
    toAccountCode: "2010", // card liability
  });
  assert.equal(debits(e), credits(e));
  assert.equal(e.lines.find((l) => l.accountCode === "2010")!.debitCents, 5000);
  assert.equal(e.lines.find((l) => l.accountCode === "1010")!.creditCents, 5000);
});

test("stripe payout: net + fee = gross, and it balances", () => {
  const e = buildStripePayoutEntry({
    entryDate: "2026-05-10",
    idempotencyKey: "k6",
    grossCents: 29900,
    feeCents: 897,
    depositedToAccountCode: "1010",
    revenueAccountCode: "4035",
    projectSlug: "ai_visibility",
  });
  assert.equal(debits(e), credits(e));
  const net = e.lines.find((l) => l.accountCode === "1010")!.debitCents;
  const fee = e.lines.find((l) => l.accountCode === "5010")!.debitCents;
  const gross = e.lines.find((l) => l.accountCode === "4035")!.creditCents;
  assert.equal(net, 29900 - 897);
  assert.equal(fee, 897);
  assert.equal(net + fee, gross);
});
