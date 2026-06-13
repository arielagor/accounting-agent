import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, ClaudeCategorizer } from "../src/lib/llm.js";
import type {
  ClaudeRunner,
} from "../src/lib/llm.js";
import type {
  CategorizationInput,
  LlmCategorizeContext,
} from "../src/core/types.js";
import { PERSONA } from "../src/core/persona.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────
const INPUT: CategorizationInput = {
  sourceTxnId: "txn_1",
  merchant: "Adobe",
  amountCents: 5999,
  memo: "Creative Cloud subscription",
  postedDate: "2026-05-12",
  isOutflow: true,
};

const CONTEXT: LlmCategorizeContext = {
  chart: [
    { code: "6160", name: "Software & Subscriptions", type: "expense" },
    { code: "4035", name: "Product Revenue", type: "revenue" },
  ],
  projects: [{ slug: "ai_visibility", name: "AI Visibility" }],
};

/** A ClaudeRunner that returns a fixed string and records the prompt it was given. */
function mockRunner(canned: string): { runner: ClaudeRunner; prompts: string[] } {
  const prompts: string[] = [];
  const runner: ClaudeRunner = {
    run(prompt: string): Promise<string> {
      prompts.push(prompt);
      return Promise.resolve(canned);
    },
  };
  return { runner, prompts };
}

// ─── extractJson ───────────────────────────────────────────────────────────────
test("extractJson parses a bare JSON object", () => {
  const v = extractJson('{"accountCode":"6160","confidence":0.9}');
  assert.equal(v.accountCode, "6160");
  assert.equal(v.confidence, 0.9);
});

test("extractJson parses JSON after a conversational preamble (output drift)", () => {
  const text =
    "Sure, here is the categorization you asked for:\n\n" +
    '{"accountCode":"6160","businessPct":100,"confidence":0.88}';
  const v = extractJson(text);
  assert.equal(v.accountCode, "6160");
  assert.equal(v.businessPct, 100);
});

test("extractJson parses JSON inside ```json code fences", () => {
  const text = "```json\n{ \"accountCode\": \"4035\", \"needsSplit\": false }\n```";
  const v = extractJson(text);
  assert.equal(v.accountCode, "4035");
  assert.equal(v.needsSplit, false);
});

test("extractJson parses a multiline JSON object with trailing prose", () => {
  const text =
    "Here you go:\n" +
    "{\n" +
    '  "accountCode": "6160",\n' +
    '  "projectSlug": "ai_visibility",\n' +
    '  "rationale": "Design tooling used for the product."\n' +
    "}\n" +
    "Let me know if you need a split.";
  const v = extractJson(text);
  assert.equal(v.accountCode, "6160");
  assert.equal(v.projectSlug, "ai_visibility");
});

test("extractJson skips a decoy brace-aside and finds the real payload", () => {
  // A `{like this}` aside in prose isn't valid JSON; the scanner must move on.
  const text = 'I considered options {like this} but settled on: {"accountCode":"6160"}';
  const v = extractJson(text);
  assert.equal(v.accountCode, "6160");
});

test("extractJson ignores braces inside string values (depth is string-aware)", () => {
  const text = '{"rationale":"contains a } brace and a { brace","accountCode":"6160"}';
  const v = extractJson(text);
  assert.equal(v.accountCode, "6160");
  assert.ok(v.rationale.includes("}"));
});

test("extractJson throws when there is no JSON object", () => {
  assert.throws(() => extractJson("no json here at all"), /no balanced JSON/);
});

// ─── ClaudeCategorizer ──────────────────────────────────────────────────────────
test("categorize yields a parsed LlmProposal from canned runner output", async () => {
  const canned =
    '{"accountCode":"6160","projectSlug":"ai_visibility","businessPct":100,' +
    '"confidence":0.91,"needsSplit":false,"rationale":"Design tooling for the product."}';
  const { runner } = mockRunner(canned);
  const cat = new ClaudeCategorizer(runner);
  const out = await cat.categorize(INPUT, CONTEXT);
  assert.equal(out.accountCode, "6160");
  assert.equal(out.projectSlug, "ai_visibility");
  assert.equal(out.businessPct, 100);
  assert.equal(out.confidence, 0.91);
  assert.equal(out.needsSplit, false);
  assert.equal(out.rationale, "Design tooling for the product.");
});

test("the prompt passed to the runner contains the persona name", async () => {
  const { runner, prompts } = mockRunner('{"accountCode":"6160","confidence":0.5}');
  const cat = new ClaudeCategorizer(runner);
  await cat.categorize(INPUT, CONTEXT);
  assert.equal(prompts.length, 1);
  assert.ok(
    prompts[0]!.includes(PERSONA.name),
    `prompt should mention the persona "${PERSONA.name}"`,
  );
  // It should also surface the chart codes and the transaction merchant.
  assert.ok(prompts[0]!.includes("6160"));
  assert.ok(prompts[0]!.includes("Adobe"));
});

test("a runner returning garbage yields a 0-confidence quarantine proposal", async () => {
  const { runner } = mockRunner("I cannot help with that. There is no JSON here.");
  const cat = new ClaudeCategorizer(runner);
  const out = await cat.categorize(INPUT, CONTEXT);
  assert.equal(out.confidence, 0);
  assert.equal(out.needsSplit, false);
  assert.equal(out.accountCode, "");
});

test("a runner that rejects yields a 0-confidence quarantine proposal (never throws)", async () => {
  const runner: ClaudeRunner = {
    run: () => Promise.reject(new Error("claude -p timed out after 60000ms")),
  };
  const cat = new ClaudeCategorizer(runner);
  const out = await cat.categorize(INPUT, CONTEXT);
  assert.equal(out.confidence, 0);
  assert.equal(out.needsSplit, false);
  assert.ok(out.rationale.includes("runner failed"));
});

test("categorize clamps out-of-range businessPct and confidence", async () => {
  const canned =
    '{"accountCode":"6160","businessPct":150,"confidence":2.5,"needsSplit":true}';
  const { runner } = mockRunner(canned);
  const cat = new ClaudeCategorizer(runner);
  const out = await cat.categorize(INPUT, CONTEXT);
  assert.equal(out.businessPct, 100); // clamped from 150
  assert.equal(out.confidence, 1); // clamped from 2.5
  assert.equal(out.needsSplit, true);
});

test("categorize quarantines when JSON parses but has no accountCode", async () => {
  const { runner } = mockRunner('{"confidence":0.99,"businessPct":100}');
  const cat = new ClaudeCategorizer(runner);
  const out = await cat.categorize(INPUT, CONTEXT);
  assert.equal(out.confidence, 0);
  assert.equal(out.accountCode, "");
});
