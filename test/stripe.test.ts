import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizePayout } from "../src/lib/stripe.js";

test("summarizePayout rolls charges into gross/fee and reads metadata.app", () => {
  const payout = { id: "po_1", amount: 29003, arrival_date: 1746835200, metadata: { app: "ai-visibility" } };
  const txns = [
    { amount: 29900, fee: 897, net: 29003, type: "charge" },
    { amount: -29003, fee: 0, net: -29003, type: "payout" }, // the payout leg itself
  ];
  const s = summarizePayout(payout, txns);
  assert.equal(s.grossCents, 29900);
  assert.equal(s.feeCents, 897);
  assert.equal(s.netCents, 29003);
  assert.equal(s.metadataApp, "ai-visibility");
  assert.equal(s.grossCents - s.feeCents, s.netCents);
});

test("summarizePayout: no metadata.app -> null (close escalates, never guesses)", () => {
  const payout = { id: "po_2", amount: 5000, arrival_date: 1746835200 };
  const txns = [{ amount: 5150, fee: 150, net: 5000, type: "charge" }];
  const s = summarizePayout(payout, txns);
  assert.equal(s.metadataApp, null);
  assert.equal(s.grossCents, 5150);
});

test("summarizePayout: falls back to net+fee when no charge rows", () => {
  const payout = { id: "po_3", amount: 10000, arrival_date: 1746835200, metadata: { app: "agor-agents" } };
  const s = summarizePayout(payout, []);
  assert.equal(s.grossCents, 10000);
  assert.equal(s.feeCents, 0);
});
