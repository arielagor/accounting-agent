/**
 * Claude -p LLM wrapper + the Tier-c LLM categorizer.
 *
 * Cost rule (CLAUDE.md, hard): every Claude call here runs on the Max plan via
 * `claude -p` (a $0 subprocess), NEVER the paid API. The single most important
 * line in this file is the `delete env.ANTHROPIC_API_KEY` — leaving that key in
 * the spawn env silently routes the call to API billing. See
 * ~/.claude/projects/C--Users-ariel/memory/feedback_claude_p_use_max_plan_unset_api_key.md.
 *
 * Output handling is drift-tolerant: an unpinned `claude -p` periodically prepends
 * a conversational preamble (and/or ```json fences) before the JSON we asked for.
 * A strict JSON.parse on the raw stdout silently discards a perfectly good answer
 * (the output-drift lesson, agor.me fix f8c403b). `extractJson` therefore scans for
 * the first balanced {...} object rather than trusting line 1.
 *
 * The categorizer NEVER throws into the close: any parse/spawn failure degrades to
 * a 0-confidence, no-split proposal so the caller quarantines the txn for review.
 */
import { spawn } from "node:child_process";
import type {
  CategorizationInput,
  LlmCategorizeContext,
  LlmCategorizer,
  LlmProposal,
} from "../core/types.js";
import { personaPreamble } from "../core/persona.js";

// ─── Runner ─────────────────────────────────────────────────────────────────
/** A thin, injectable boundary to the LLM so the categorizer is testable with a mock. */
export interface ClaudeRunner {
  run(prompt: string): Promise<string>;
}

/** Hard cap on a single claude -p call so a hung subprocess can't stall the close. */
const RUN_TIMEOUT_MS = 60_000;

/**
 * A ClaudeRunner backed by the `claude -p` CLI on the Max plan ($0).
 *   - env is a COPY of process.env with ANTHROPIC_API_KEY DELETED (mandatory cost rule).
 *   - args are passed as an array with shell:false on win32 (no shell interpolation,
 *     no orphaned cmd.exe shim — the proven pattern for killing claude -p cleanly).
 *   - stdout is collected and resolved as a string; bounded by RUN_TIMEOUT_MS.
 */
export function spawnClaudeRunner(): ClaudeRunner {
  return {
    run(prompt: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        // Copy the environment, then strip the paid-API key so the call rides the
        // Max plan. Without this delete, claude -p silently bills the API.
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;

        const child = spawn("claude", ["-p", prompt, "--output-format", "text"], {
          env,
          shell: false,
          windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        // Bounded run: kill the subprocess tree after the timeout. On win32 a plain
        // child.kill() can leave the claude.exe orphaned, so prefer SIGKILL.
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // Best-effort kill; if it fails the reject below still settles the promise.
          }
          reject(new Error(`claude -p timed out after ${RUN_TIMEOUT_MS}ms`));
        }, RUN_TIMEOUT_MS);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(`claude -p exited ${code}: ${stderr.trim() || "no stderr"}`));
          }
        });
      });
    },
  };
}

// ─── Drift-tolerant JSON extraction ───────────────────────────────────────────
/**
 * Pull the first balanced JSON object out of arbitrary LLM text and parse it.
 * Tolerant of: a conversational preamble before the JSON, ```json / ``` code
 * fences, and trailing prose after the object. The scan is string- and
 * escape-aware so a `{` or `}` inside a JSON string value does not skew brace
 * depth. Returns the parsed value; THROWS if no balanced object parses (the
 * caller turns that throw into a quarantine, never a crash).
 */
export function extractJson(text: string): any {
  if (text == null) throw new Error("extractJson: no text");
  // Strip code fences so a fenced object is scanned as plain text.
  const s = String(text).replace(/```(?:json|jsonc|js)?/gi, "").replace(/```/g, "");

  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    // Found a candidate opening brace; walk forward tracking depth, respecting strings.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = s.slice(i, j + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // This balanced region wasn't valid JSON (e.g. a `{like this}` aside in
            // the preamble). Resume scanning from the next char for the real payload.
            break;
          }
        }
      }
    }
  }
  throw new Error("extractJson: no balanced JSON object found");
}

// ─── Categorizer (Tier c) ──────────────────────────────────────────────────────
/** A defensive low-confidence proposal: the caller quarantines instead of posting. */
function quarantineProposal(rationale: string): LlmProposal {
  return {
    accountCode: "",
    projectSlug: null,
    businessPct: 0,
    confidence: 0,
    needsSplit: false,
    rationale,
  };
}

/** Clamp to an integer 0..100; non-finite/out-of-range collapses to a safe value. */
function clampPct(p: unknown): number {
  const n = typeof p === "number" ? p : Number(p);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Clamp a confidence to 0..1; non-finite collapses to 0 (treated as low-confidence). */
function clampConfidence(c: unknown): number {
  const n = typeof c === "number" ? c : Number(c);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * The LLM categorizer. Builds a persona-grounded prompt listing the chart of
 * accounts, the projects, and the one transaction, and asks the model to return
 * ONLY a JSON object. The runner is injected so this class is unit-testable with
 * a mock that returns canned text (no subprocess, no network).
 */
export class ClaudeCategorizer implements LlmCategorizer {
  constructor(private readonly runner: ClaudeRunner) {}

  /** Construct the full prompt. Exposed-shape is stable so tests can assert on it. */
  buildPrompt(input: CategorizationInput, context: LlmCategorizeContext): string {
    const chartLines = context.chart
      .map((a) => `  ${a.code}  ${a.name} (${a.type})`)
      .join("\n");
    const projectLines = context.projects.length
      ? context.projects.map((p) => `  ${p.slug}  ${p.name}`).join("\n")
      : "  (none)";
    const direction = input.isOutflow ? "outflow (expense candidate)" : "inflow (revenue candidate)";

    return [
      personaPreamble(),
      "",
      "Categorize ONE bank/card transaction into exactly one chart-of-accounts code,",
      "optionally tagging the project it belongs to and the business-use fraction.",
      "",
      "Chart of accounts (code  name  type):",
      chartLines,
      "",
      "Projects (slug  name):",
      projectLines,
      "",
      "Transaction:",
      `  merchant: ${input.merchant}`,
      `  amount (cents): ${input.amountCents}`,
      `  direction: ${direction}`,
      `  memo: ${input.memo}`,
      `  posted: ${input.postedDate ?? "unknown"}`,
      "",
      "Return ONLY a JSON object (no prose, no code fences) with exactly these keys:",
      '  accountCode  (string, MUST be one of the codes above)',
      "  projectSlug  (string slug from above, or null)",
      "  businessPct  (integer 0..100; the business-use fraction)",
      "  confidence   (number 0..1; how sure you are)",
      "  needsSplit   (boolean; true if this should be split across projects/accounts)",
      "  rationale    (one short sentence; note the business purpose that defends it)",
    ].join("\n");
  }

  /**
   * Categorize one transaction. On ANY failure (spawn error, timeout, missing/
   * malformed JSON) returns a 0-confidence, needsSplit=false proposal so the
   * caller quarantines the txn. This method must NEVER throw into the close.
   */
  async categorize(
    input: CategorizationInput,
    context: LlmCategorizeContext,
  ): Promise<LlmProposal> {
    let raw: string;
    try {
      raw = await this.runner.run(this.buildPrompt(input, context));
    } catch (err) {
      // Fail-soft: a runner failure must quarantine, not crash the close.
      return quarantineProposal(`llm runner failed: ${errMsg(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = extractJson(raw);
    } catch {
      // Fail-soft: unparseable output quarantines for human review.
      return quarantineProposal("llm output did not contain parseable JSON");
    }

    if (typeof parsed !== "object" || parsed === null) {
      return quarantineProposal("llm output JSON was not an object");
    }

    const obj = parsed as Record<string, unknown>;
    const accountCode = typeof obj.accountCode === "string" ? obj.accountCode.trim() : "";
    if (!accountCode) {
      // No usable account code is not a confident decision — quarantine.
      return quarantineProposal("llm output had no accountCode");
    }

    const projectSlug =
      typeof obj.projectSlug === "string" && obj.projectSlug.trim() ? obj.projectSlug.trim() : null;
    const rationale = typeof obj.rationale === "string" ? obj.rationale : "";

    return {
      accountCode,
      projectSlug,
      businessPct: clampPct(obj.businessPct),
      confidence: clampConfidence(obj.confidence),
      needsSplit: obj.needsSplit === true,
      rationale,
    };
  }
}

/** Render an unknown thrown value as a short string for the rationale. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
