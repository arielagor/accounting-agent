/**
 * Advisor unit tests — PURE only (no DB, no network). The DB shell in advisor.ts
 * is a thin wrapper around these functions, which hold all the arithmetic, so
 * testing them here covers the logic that matters and runs anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRunwayMonths,
  detectZombieSubs,
  topMovers,
  perProjectRoi,
  type SubCharge,
} from "../src/core/advisor.js";

test("computeRunwayMonths: 12 months from 120k liquid / 10k burn", () => {
  // $1,200 liquid, $100/mo burn => 12 months. (Values are in cents.)
  assert.equal(computeRunwayMonths(120_000, 10_000), 12);
});

test("computeRunwayMonths: Infinity when burn is zero", () => {
  assert.equal(computeRunwayMonths(120_000, 0), Infinity);
});

test("computeRunwayMonths: Infinity when burn is negative (cash-positive)", () => {
  // A negative burn means the business generated cash; no depletion horizon.
  assert.equal(computeRunwayMonths(50_000, -5_000), Infinity);
});

test("detectZombieSubs: flags a no-revenue no-usage sub, keeps a revenue-bearing one", () => {
  const subs: SubCharge[] = [
    { merchant: "DeadTool", monthlyCents: 2999, projectSlug: "aphor_me", lastSeenMonth: "2026-05" },
    { merchant: "LiveTool", monthlyCents: 1999, projectSlug: "agor_me", lastSeenMonth: "2026-05" },
  ];
  const revenueByProject = { agor_me: 500_00, aphor_me: 0 };
  const usageByProject = { agor_me: 0, aphor_me: 0 };

  const zombies = detectZombieSubs(subs, revenueByProject, usageByProject);
  assert.equal(zombies.length, 1);
  assert.equal(zombies[0]!.merchant, "DeadTool");
  // The revenue-bearing project's sub is NOT flagged.
  assert.ok(!zombies.some((z) => z.merchant === "LiveTool"));
});

test("detectZombieSubs: a sub kept alive by USAGE alone is not flagged", () => {
  const subs: SubCharge[] = [
    { merchant: "UsedTool", monthlyCents: 999, projectSlug: "gifloop", lastSeenMonth: "2026-05" },
  ];
  // Zero revenue but non-zero usage — still pulling weight, so keep it.
  const zombies = detectZombieSubs(subs, { gifloop: 0 }, { gifloop: 1234 });
  assert.equal(zombies.length, 0);
});

test("detectZombieSubs: an unattributed sub (null project) is never auto-flagged", () => {
  const subs: SubCharge[] = [
    { merchant: "SharedTool", monthlyCents: 4999, projectSlug: null, lastSeenMonth: "2026-05" },
  ];
  // No project to prove dead => not a zombie candidate here.
  const zombies = detectZombieSubs(subs, {}, {});
  assert.equal(zombies.length, 0);
});

test("topMovers: ranks accounts by absolute MoM delta, largest first", () => {
  const current = [
    { accountCode: "6160", netCents: 50_000 },
    { accountCode: "6150", netCents: 10_000 },
    { accountCode: "4010", netCents: -300_000 }, // revenue net (credit-normal) shows negative debit-net
  ];
  const prior = [
    { accountCode: "6160", netCents: 20_000 }, // +30k swing
    { accountCode: "6150", netCents: 10_000 }, // no change -> dropped
    { accountCode: "4010", netCents: -100_000 }, // -200k swing (abs 200k)
  ];
  const movers = topMovers(current, prior);
  assert.equal(movers[0]!.account, "4010");
  assert.equal(movers[0]!.deltaCents, -200_000);
  assert.equal(movers[1]!.account, "6160");
  assert.equal(movers[1]!.deltaCents, 30_000);
  // 6150 had a zero delta and is excluded.
  assert.ok(!movers.some((m) => m.account === "6150"));
});

test("topMovers: includes accounts present in only one month", () => {
  const current = [{ accountCode: "6200", netCents: 12_500 }];
  const prior: { accountCode: string; netCents: number }[] = [];
  const movers = topMovers(current, prior);
  assert.equal(movers.length, 1);
  assert.equal(movers[0]!.account, "6200");
  assert.equal(movers[0]!.deltaCents, 12_500);
});

test("perProjectRoi: net = revenue - cost, joined on the union of slugs", () => {
  const revenue = { agor_me: 500_000, mvat_focus: 0 };
  const cost = { agor_me: 120_000, mvat_focus: 40_000 };
  const roi = perProjectRoi(revenue, cost);
  const agor = roi.find((r) => r.projectSlug === "agor_me")!;
  const mvat = roi.find((r) => r.projectSlug === "mvat_focus")!;
  assert.equal(agor.net, 380_000);
  assert.equal(mvat.net, -40_000); // cost-only project surfaces with a negative net
  // Most profitable first.
  assert.equal(roi[0]!.projectSlug, "agor_me");
});
