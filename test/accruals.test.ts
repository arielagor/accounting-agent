import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAccrualSchedule, type AccrualPolicy } from "../src/core/accruals.js";
import { sumCents } from "../src/core/money.js";

const annualAudit: AccrualPolicy = {
  name: "Audit fee",
  expenseAccountCode: "6060",
  creditAccountCode: "2250",
  basisCents: 1_200_000, // $12,000/yr
  basisDays: 365,
  autoReverse: false,
  supportReference: "engagement letter",
};

test("accrual: period portion is basis prorated by days, draft balances", () => {
  const schedule = buildAccrualSchedule("2026-05", [annualAudit]); // May = 31 days
  assert.equal(schedule.length, 1);
  const e = schedule[0]!;
  // ~ 12000 * 31/365 = ~1019.18 -> within a dollar
  assert.ok(e.thisPeriodCents > 100_000 && e.thisPeriodCents < 105_000);
  const debits = sumCents(e.draft.lines.map((l) => l.debitCents));
  const credits = sumCents(e.draft.lines.map((l) => l.creditCents));
  assert.equal(debits, credits); // draft balances
  assert.equal(e.draft.status, "draft"); // never auto-posted
});

test("accrual: already-booked reduces this-period accrual", () => {
  const schedule = buildAccrualSchedule("2026-05", [annualAudit], { "Audit fee": 100_000 });
  const e = schedule[0]!;
  assert.ok(e.thisPeriodCents < 5_000); // most already booked
  assert.equal(e.alreadyBookedCents, 100_000);
});

test("accrual: fully-booked item produces no entry", () => {
  const schedule = buildAccrualSchedule("2026-05", [annualAudit], { "Audit fee": 999_999_999 });
  assert.equal(schedule.length, 0);
});

test("accrual: idempotency key is stable per name+period", () => {
  const a = buildAccrualSchedule("2026-05", [annualAudit])[0]!;
  const b = buildAccrualSchedule("2026-05", [annualAudit])[0]!;
  assert.equal(a.draft.idempotencyKey, b.draft.idempotencyKey);
  assert.equal(a.draft.idempotencyKey, "accrual:Audit fee:2026-05");
});
