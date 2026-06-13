import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAllocation } from "../src/core/allocate.js";
import { sumCents } from "../src/core/money.js";

/** Total cents across an allocation result — the invariant every split must hold. */
function totalOf(splits: Array<{ cents: number }>): number {
  return sumCents(splits.map((s) => s.cents));
}

test("even: Netlify $19.00 across 4 sites sums exactly to 1900", () => {
  const splits = computeAllocation(1900, "even", [
    { projectSlug: "agor_agents", weight: 1 },
    { projectSlug: "modelstack", weight: 1 },
    { projectSlug: "scored_tools", weight: 1 },
    { projectSlug: "agor_me", weight: 1 },
  ]);
  assert.equal(splits.length, 4);
  assert.equal(totalOf(splits), 1900);
  // 1900 / 4 = 475 each, no remainder.
  assert.deepEqual(
    splits.map((s) => s.cents),
    [475, 475, 475, 475],
  );
});

test("even ignores any provided weights and still sums exactly", () => {
  // Lopsided weights must NOT skew an even split.
  const splits = computeAllocation(1001, "even", [
    { projectSlug: "a", weight: 99 },
    { projectSlug: "b", weight: 1 },
    { projectSlug: "c", weight: 0 },
  ]);
  assert.equal(totalOf(splits), 1001);
  // Equal base 333 + 333 + 333 = 999; remainder 2 to the earliest targets.
  assert.deepEqual(
    splits.map((s) => s.cents),
    [334, 334, 333],
  );
});

test("usage_weighted: Claude $100.00 split [50,30,15,5] sums exactly to 10000", () => {
  const splits = computeAllocation(10000, "usage_weighted", [
    { projectSlug: "mvat_focus", weight: 50 },
    { projectSlug: "agor_supervisor", weight: 30 },
    { projectSlug: "agor_me", weight: 15 },
    { projectSlug: "modelstack", weight: 5 },
  ]);
  assert.equal(splits.length, 4);
  assert.equal(totalOf(splits), 10000);
  // 50/30/15/5 of 10000 lands on round cents: 5000 / 3000 / 1500 / 500.
  assert.deepEqual(
    splits.map((s) => s.cents),
    [5000, 3000, 1500, 500],
  );
});

test("fixed_percent sums exactly to the total even when percents don't divide evenly", () => {
  // 70/30 of an odd total (333) is 233.1 / 99.9 — largest-remainder keeps it exact.
  const splits = computeAllocation(333, "fixed_percent", [
    { projectSlug: "mvat_focus", weight: 70 },
    { projectSlug: "aphor_me", weight: 30 },
  ]);
  assert.equal(totalOf(splits), 333);
  assert.equal(splits.length, 2);
});

test("revenue_weighted with three uneven weights sums exactly", () => {
  const splits = computeAllocation(99991, "revenue_weighted", [
    { projectSlug: "p1", weight: 12345 },
    { projectSlug: "p2", weight: 6789 },
    { projectSlug: "p3", weight: 222 },
  ]);
  assert.equal(totalOf(splits), 99991);
  assert.equal(splits.length, 3);
});

test("direct: a single target carries 100% of the cost", () => {
  const splits = computeAllocation(4242, "direct", [
    { projectSlug: "agor_me", weight: 1 },
    { projectSlug: "modelstack", weight: 1 },
    { projectSlug: "gifloop", weight: 1 },
  ]);
  assert.equal(totalOf(splits), 4242);
  assert.equal(splits[0]!.projectSlug, "agor_me");
  assert.equal(splits[0]!.cents, 4242);
  assert.equal(splits[1]!.cents, 0);
  assert.equal(splits[2]!.cents, 0);
});

test("single target gets the whole total regardless of method", () => {
  for (const method of ["even", "fixed_percent", "usage_weighted", "revenue_weighted", "direct"] as const) {
    const splits = computeAllocation(777, method, [{ projectSlug: "only", weight: 42 }]);
    assert.equal(totalOf(splits), 777, `method ${method} must keep the total exact`);
    assert.equal(splits[0]!.cents, 777);
  }
});

test("no targets yields an empty allocation (nothing to split)", () => {
  const splits = computeAllocation(5000, "even", []);
  assert.deepEqual(splits, []);
});

test("weighted method with all-zero weights falls back to an even, exact split", () => {
  const splits = computeAllocation(1000, "usage_weighted", [
    { projectSlug: "a", weight: 0 },
    { projectSlug: "b", weight: 0 },
    { projectSlug: "c", weight: 0 },
  ]);
  assert.equal(totalOf(splits), 1000);
  assert.equal(splits.length, 3);
});
