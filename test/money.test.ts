import { test } from "node:test";
import assert from "node:assert/strict";
import { toCents, fromCents, formatUsd, sumCents, allocateCents, evenSplit } from "../src/core/money.js";

test("toCents rounds at the cent without float drift", () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents("19.99"), 1999);
  assert.equal(toCents("$1,234.56"), 123456);
  assert.equal(toCents(0.1 + 0.2), 30); // 0.30000000000000004 -> 30
});

test("fromCents and formatUsd render correctly", () => {
  assert.equal(fromCents(1999), "19.99");
  assert.equal(fromCents(-500), "-5.00");
  assert.equal(formatUsd(123456), "$1,234.56");
  assert.equal(formatUsd(-99), "-$0.99");
});

test("sumCents is exact", () => {
  assert.equal(sumCents([1, 2, 3, 4]), 10);
  assert.equal(sumCents([]), 0);
});

test("allocateCents sums EXACTLY to the total (no lost pennies)", () => {
  const parts = allocateCents(1000, [1, 1, 1]); // 333.33 each
  assert.equal(sumCents(parts), 1000);
  assert.deepEqual([...parts].sort((a, b) => a - b), [333, 333, 334]);
});

test("allocateCents handles uneven weights and sums exact", () => {
  const parts = allocateCents(1900, [50, 30, 15, 5]); // Claude Max split example
  assert.equal(sumCents(parts), 1900);
  assert.equal(parts.length, 4);
});

test("allocateCents with zero total weight falls back to even", () => {
  const parts = allocateCents(1000, [0, 0, 0, 0]);
  assert.equal(sumCents(parts), 1000);
});

test("evenSplit sums exactly with remainder distributed", () => {
  assert.equal(sumCents(evenSplit(1900, 4)), 1900); // Netlify $19 / 4 sites
  assert.deepEqual(evenSplit(1900, 4), [475, 475, 475, 475]);
  assert.equal(sumCents(evenSplit(1001, 3)), 1001);
});
