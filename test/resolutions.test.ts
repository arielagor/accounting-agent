import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseResolutionLine,
  parseResolutions,
  type Resolution,
} from "../src/lib/resolutions.js";

// ─── CATEGORIZE ─────────────────────────────────────────────────────────────
test("CATEGORIZE parses txnId + accountCode into payload.accountCode", () => {
  const r = parseResolutionLine("CATEGORIZE txn_42 6160");
  assert.deepEqual(r, {
    verb: "CATEGORIZE",
    sourceTxnId: "txn_42",
    payload: { accountCode: "6160" },
  } satisfies Resolution);
});

test("CATEGORIZE verb is case-insensitive", () => {
  const r = parseResolutionLine("categorize txn_7 4035");
  assert.equal(r?.verb, "CATEGORIZE");
  assert.equal(r?.sourceTxnId, "txn_7");
  assert.deepEqual(r?.payload, { accountCode: "4035" });
});

test("CATEGORIZE missing the account code returns null", () => {
  assert.equal(parseResolutionLine("CATEGORIZE txn_42"), null);
});

// ─── ALLOCATE ───────────────────────────────────────────────────────────────
test("ALLOCATE parses a single proj=pct into splits", () => {
  const r = parseResolutionLine("ALLOCATE txn_9 ai_visibility=100");
  assert.deepEqual(r, {
    verb: "ALLOCATE",
    sourceTxnId: "txn_9",
    payload: { splits: { ai_visibility: 100 } },
  } satisfies Resolution);
});

test("ALLOCATE parses MULTIPLE proj=pct tokens into one splits map", () => {
  const r = parseResolutionLine("allocate txn_9 ai_visibility=40 modelstack=35 aphor=25");
  assert.equal(r?.verb, "ALLOCATE");
  assert.equal(r?.sourceTxnId, "txn_9");
  assert.deepEqual(r?.payload, {
    splits: { ai_visibility: 40, modelstack: 35, aphor: 25 },
  });
});

test("ALLOCATE with no parseable splits returns null", () => {
  assert.equal(parseResolutionLine("ALLOCATE txn_9 nonsense"), null);
});

// ─── SPLIT ──────────────────────────────────────────────────────────────────
test("SPLIT parses acct=pct tokens into splits", () => {
  const r = parseResolutionLine("SPLIT txn_3 6160=70 9500=30");
  assert.deepEqual(r, {
    verb: "SPLIT",
    sourceTxnId: "txn_3",
    payload: { splits: { "6160": 70, "9500": 30 } },
  } satisfies Resolution);
});

// ─── APPROVE / DEFER AJE ──────────────────────────────────────────────────────
test("APPROVE AJE <id> (two-word form) → APPROVE_AJE, null txn, payload.ajeId", () => {
  const r = parseResolutionLine("APPROVE AJE 12");
  assert.deepEqual(r, {
    verb: "APPROVE_AJE",
    sourceTxnId: null,
    payload: { ajeId: "12" },
  } satisfies Resolution);
});

test("APPROVE_AJE <id> (underscore form) parses identically", () => {
  const r = parseResolutionLine("APPROVE_AJE 12");
  assert.deepEqual(r, {
    verb: "APPROVE_AJE",
    sourceTxnId: null,
    payload: { ajeId: "12" },
  } satisfies Resolution);
});

test("DEFER AJE <id> → DEFER_AJE with null txn and payload.ajeId", () => {
  const r = parseResolutionLine("defer aje 7");
  assert.deepEqual(r, {
    verb: "DEFER_AJE",
    sourceTxnId: null,
    payload: { ajeId: "7" },
  } satisfies Resolution);
});

test("DEFER_AJE <id> (underscore form) parses identically", () => {
  const r = parseResolutionLine("DEFER_AJE 7");
  assert.equal(r?.verb, "DEFER_AJE");
  assert.equal(r?.sourceTxnId, null);
  assert.deepEqual(r?.payload, { ajeId: "7" });
});

test("APPROVE without the AJE keyword is noise (null)", () => {
  assert.equal(parseResolutionLine("APPROVE 12"), null);
});

// ─── MATCH ────────────────────────────────────────────────────────────────────
test("MATCH parses two txn ids into payload.a / payload.b", () => {
  const r = parseResolutionLine("MATCH txn_a txn_b");
  assert.deepEqual(r, {
    verb: "MATCH",
    sourceTxnId: "txn_a",
    payload: { a: "txn_a", b: "txn_b" },
  } satisfies Resolution);
});

test("MATCH missing the second id returns null", () => {
  assert.equal(parseResolutionLine("MATCH txn_a"), null);
});

// ─── Non-matching lines ─────────────────────────────────────────────────────
test("blank lines and unknown verbs return null", () => {
  assert.equal(parseResolutionLine(""), null);
  assert.equal(parseResolutionLine("   "), null);
  assert.equal(parseResolutionLine("thanks, looks good!"), null);
  assert.equal(parseResolutionLine("-- Sent from my iPhone"), null);
});

// ─── parseResolutions (multi-line body) ────────────────────────────────────────
test("parseResolutions ignores noise lines and parses 3 valid lines from a body", () => {
  const body = [
    "Hi Hank,",
    "",
    "CATEGORIZE txn_42 6160",
    "noise that should be dropped",
    "ALLOCATE txn_9 ai_visibility=60 modelstack=40",
    "",
    "APPROVE AJE 12",
    "-- Sent from my iPhone",
  ].join("\n");

  const res = parseResolutions(body);
  assert.equal(res.length, 3);
  assert.deepEqual(res[0], {
    verb: "CATEGORIZE",
    sourceTxnId: "txn_42",
    payload: { accountCode: "6160" },
  } satisfies Resolution);
  assert.deepEqual(res[1], {
    verb: "ALLOCATE",
    sourceTxnId: "txn_9",
    payload: { splits: { ai_visibility: 60, modelstack: 40 } },
  } satisfies Resolution);
  assert.deepEqual(res[2], {
    verb: "APPROVE_AJE",
    sourceTxnId: null,
    payload: { ajeId: "12" },
  } satisfies Resolution);
});

test("parseResolutions preserves order and handles CRLF line endings", () => {
  const body = "MATCH txn_a txn_b\r\nDEFER_AJE 5\r\nCATEGORIZE txn_1 1010";
  const res = parseResolutions(body);
  assert.deepEqual(
    res.map((r) => r.verb),
    ["MATCH", "DEFER_AJE", "CATEGORIZE"],
  );
});

test("parseResolutions on an all-noise body returns an empty array", () => {
  const res = parseResolutions("hello\nthere\n\nnothing to see");
  assert.deepEqual(res, []);
});
