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
  DocumentExtractor,
  DocumentExtractInput,
  ExtractedDocument,
  ExtractedLine,
  CouncilEscalator,
  CouncilVerdict,
  AccountCandidate,
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
export interface RunnerOpts {
  /**
   * Tools the headless `claude -p` call may use WITHOUT an interactive prompt. Setting
   * this both ENABLES those tools and RESTRICTS to exactly them — everything else
   * (Write/Edit/Bash/...) is denied. Used to give the council read-only internet research
   * (e.g. ["WebSearch","WebFetch"]) while keeping it incapable of mutating anything. When
   * omitted, no tools are allowlisted (text-only; the safe default for categorize/extract).
   */
  allowedTools?: string[];
}

export function spawnClaudeRunner(timeoutMs: number = RUN_TIMEOUT_MS, opts: RunnerOpts = {}): ClaudeRunner {
  return {
    run(prompt: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        // Copy the environment, then strip the paid-API key so the call rides the
        // Max plan. Without this delete, claude -p silently bills the API.
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;

        // Pin an explicit model: claude -p defaults to the session's configured model
        // (the SOTA Fable 5), which can be "currently unavailable" and then exits 1 on
        // every call. Fallback ladder per Ariel: Fable 5 -> Opus 4.8 (NOT Sonnet/Haiku).
        // Override with LLM_MODEL. All ride the Max plan ($0) since the API key is stripped.
        const model = process.env.LLM_MODEL || "claude-opus-4-8";

        const args = ["-p", prompt, "--output-format", "text", "--model", model];
        // Allowlist ONLY the named tools (e.g. web research) — headless mode auto-approves
        // these and denies all others, so the runner can read the internet but never write.
        if (opts.allowedTools && opts.allowedTools.length > 0) {
          args.push("--allowedTools", opts.allowedTools.join(" "));
        }

        // stdin MUST be ignored: `claude -p` otherwise waits for piped stdin, warns
        // "no stdin data received in 3s", and exits 1 — failing every call. Ignoring
        // stdin makes it use the -p prompt argument immediately. (stdout/stderr piped.)
        const child = spawn("claude", args, {
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
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
          reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
        }, timeoutMs);

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

// ─── Document extractor (receipts) ─────────────────────────────────────────────
/** Coerce a money value the model might emit as dollars or cents into integer cents. */
function toCents(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  // The prompt asks for integer cents; round defensively in case it emits a float.
  return Math.round(Math.abs(n));
}

/**
 * The Claude-backed document extractor (the receipt analogue of ClaudeCategorizer).
 * Parses a receipt/invoice/statement's text or CSV into structured line items, asking
 * the model to map each to a chart code where it can. Fail-soft: any spawn/parse
 * failure throws, and receipts.ts turns that into a document 'error' status (never a
 * crash, never a fabricated split). Rides the Max plan ($0) like every call here.
 */
export class ClaudeDocumentExtractor implements DocumentExtractor {
  constructor(private readonly runner: ClaudeRunner) {}

  buildPrompt(input: DocumentExtractInput, context: LlmCategorizeContext): string {
    const chartLines = context.chart.map((a) => `  ${a.code}  ${a.name} (${a.type})`).join("\n");
    const projectLines = context.projects.length
      ? context.projects.map((p) => `  ${p.slug}  ${p.name}`).join("\n")
      : "  (none)";
    const body = input.ocrText ?? input.csv ?? "";
    return [
      personaPreamble(),
      "",
      "Extract the line items from this receipt / invoice / statement so an aggregate",
      "card charge can be split into its components. Map each line to a chart code when",
      "you can; use null when unsure (do NOT guess a code).",
      "",
      "Chart of accounts (code  name  type):",
      chartLines,
      "",
      "Projects (slug  name):",
      projectLines,
      "",
      `Document (${input.contentType ?? "text"}${input.filename ? `, ${input.filename}` : ""}):`,
      body.slice(0, 12000),
      "",
      "Return ONLY a JSON object (no prose, no code fences) with exactly these keys:",
      "  vendorGuess (string or null; the merchant that issued it)",
      "  docDate     (string 'YYYY-MM-DD' or null)",
      "  totalCents  (integer cents of the grand total, or null)",
      "  currency    (lowercase ISO, default 'usd')",
      "  lines       (array; each: { description (string), amountCents (integer cents),",
      "               qty (number, default 1), candidateAccountCode (string code above or null),",
      "               candidateProjectSlug (slug above or null), businessPct (integer 0..100) })",
    ].join("\n");
  }

  async extract(input: DocumentExtractInput, context: LlmCategorizeContext): Promise<ExtractedDocument> {
    const raw = await this.runner.run(this.buildPrompt(input, context));
    const parsed = extractJson(raw); // throws on no JSON; receipts.ts catches → 'error'
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("extractor output JSON was not an object");
    }
    const obj = parsed as Record<string, unknown>;
    const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
    const lines: ExtractedLine[] = rawLines
      .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
      .map((l) => ({
        description: typeof l.description === "string" ? l.description : "item",
        amountCents: toCents(l.amountCents),
        qty: Number.isFinite(Number(l.qty)) ? Number(l.qty) : 1,
        candidateAccountCode:
          typeof l.candidateAccountCode === "string" && l.candidateAccountCode.trim()
            ? l.candidateAccountCode.trim()
            : null,
        candidateProjectSlug:
          typeof l.candidateProjectSlug === "string" && l.candidateProjectSlug.trim()
            ? l.candidateProjectSlug.trim()
            : null,
        businessPct: clampPct(l.businessPct),
      }))
      .filter((l) => l.amountCents > 0);
    return {
      vendorGuess: typeof obj.vendorGuess === "string" && obj.vendorGuess.trim() ? obj.vendorGuess.trim() : null,
      docDate: typeof obj.docDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.docDate) ? obj.docDate : null,
      totalCents: obj.totalCents == null ? null : toCents(obj.totalCents),
      currency: typeof obj.currency === "string" && obj.currency.trim() ? obj.currency.trim().toLowerCase() : "usd",
      lines,
    };
  }
}

// ─── Council (auditor escalation) ───────────────────────────────────────────────
/** An unresolved verdict the auditor turns into a (still-quarantined) human review. */
function unresolvedVerdict(rationale: string): CouncilVerdict {
  return { resolved: false, accountCode: null, confidence: 0, rationale };
}

/**
 * A Claude-backed council escalator. One $0 `claude -p` deliberation framed as three
 * voices (operator / skeptic / strategist) that argue to a single verdict on an
 * ambiguous transaction. It may RESOLVE (a confident account), flag a HUMAN-GATE
 * (aggressive deduction / entity change / money movement — never auto-acted), or ask
 * for ACCESS to data it needs (a research-agent request). Fail-soft: any spawn/parse
 * failure returns an unresolved verdict so the auditor leaves the item for a human.
 * The heavier multi-pass /council + adversarial-Gemini loop can be swapped in behind
 * this same CouncilEscalator interface without touching the auditor.
 */
export class ClaudeCouncil implements CouncilEscalator {
  constructor(private readonly runner: ClaudeRunner) {}

  buildPrompt(input: CategorizationInput, context: LlmCategorizeContext): string {
    const chartLines = context.chart.map((a) => `  ${a.code}  ${a.name} (${a.type})`).join("\n");
    const projectLines = context.projects.length
      ? context.projects.map((p) => `  ${p.slug}  ${p.name}`).join("\n")
      : "  (none)";
    const direction = input.isOutflow ? "outflow (expense candidate)" : "inflow (revenue candidate)";
    return [
      personaPreamble(),
      "",
      "A transaction could not be categorized automatically. Convene a three-voice",
      "council and argue to ONE verdict, then SETTLE IT with your best professional judgement:",
      "  - operator: what is the most defensible business categorization?",
      "  - skeptic: what would an auditor challenge? is this aggressive or mixed-use?",
      "  - strategist: is there missing context that would change the answer?",
      "",
      "You may use INTERNET RESEARCH (the WebSearch / WebFetch tools) when it would change",
      "your answer — most often to identify an unfamiliar merchant or vendor (what do they",
      "sell? is it a SaaS/dev tool, a game, a restaurant, a streaming service?). A quick",
      "search usually resolves an ambiguous name. Do NOT research what you already know.",
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
      "SETTLE ordinary ambiguity yourself: research the merchant if needed, weigh the three",
      "voices, and RESOLVE with the most defensible category at an honest confidence — do not",
      "punt a routine call to a human. Set confidence to reflect your certainty AFTER any",
      "research. Reserve escalation for genuinely hard cases only:",
      "  - aggressive deduction (large home-office %, 100% vehicle, large §179, entity change,",
      "    any money movement) -> set humanGate, do NOT resolve.",
      "  - a position that needs substantiation you cannot infer (e.g. an itemized receipt or",
      "    business-purpose record for a meal) -> set needsAccess, do NOT resolve.",
      "",
      "Always give your best single accountCode AND a short `candidates` list of every",
      "DEFENSIBLE account this could reasonably be (best first). List only categories a",
      "reasonable accountant would actually stand behind — never an aggressive or implausible",
      "one. These candidates may be auto-selected, so do not pad the list.",
      "",
      "Return ONLY a JSON object (no prose, no code fences) with exactly these keys:",
      "  resolved    (boolean; true only for a confident, safe categorization)",
      "  accountCode (string code above, or null) — your best single pick",
      "  projectSlug (slug above, or null)",
      "  businessPct (integer 0..100)",
      "  confidence  (number 0..1)",
      "  rationale   (one short sentence summarizing the council's reasoning)",
      "  humanGate   (string reason if a human must decide, else null)",
      "  needsAccess (object {resource, reason, howToGrant} if data is needed, else null)",
      "  candidates  (array of { accountCode (string code above), businessPct (integer",
      "               0..100), rationale (short string) } — every DEFENSIBLE option, best",
      "               first; [] only if truly none applies)",
    ].join("\n");
  }

  async deliberate(input: CategorizationInput, context: LlmCategorizeContext): Promise<CouncilVerdict> {
    let raw: string;
    try {
      raw = await this.runner.run(this.buildPrompt(input, context));
    } catch (e) {
      return unresolvedVerdict(`council runner failed: ${errMsg(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = extractJson(raw);
    } catch {
      return unresolvedVerdict("council output had no parseable JSON");
    }
    if (typeof parsed !== "object" || parsed === null) {
      return unresolvedVerdict("council output JSON was not an object");
    }
    const obj = parsed as Record<string, unknown>;
    const accountCode =
      typeof obj.accountCode === "string" && obj.accountCode.trim() ? obj.accountCode.trim() : null;
    const projectSlug =
      typeof obj.projectSlug === "string" && obj.projectSlug.trim() ? obj.projectSlug.trim() : null;
    const humanGate = typeof obj.humanGate === "string" && obj.humanGate.trim() ? obj.humanGate.trim() : null;
    let needsAccess: CouncilVerdict["needsAccess"] = null;
    if (obj.needsAccess && typeof obj.needsAccess === "object") {
      const na = obj.needsAccess as Record<string, unknown>;
      if (typeof na.resource === "string" && na.resource.trim()) {
        needsAccess = {
          resource: na.resource.trim(),
          reason: typeof na.reason === "string" ? na.reason : "data needed to categorize",
          howToGrant: typeof na.howToGrant === "string" ? na.howToGrant : "grant access in the Review screen",
        };
      }
    }
    const candidates = parseCandidates(obj.candidates);
    return {
      resolved: obj.resolved === true && accountCode !== null && !humanGate && !needsAccess,
      accountCode,
      projectSlug,
      businessPct: clampPct(obj.businessPct),
      confidence: clampConfidence(obj.confidence),
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
      humanGate,
      needsAccess,
      candidates,
    };
  }
}

/**
 * Parse the council's optional `candidates` array into clean AccountCandidate records,
 * dropping any malformed entry. Fail-soft: a bad value yields [] rather than throwing.
 */
function parseCandidates(value: unknown): AccountCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: AccountCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const code = typeof o.accountCode === "string" ? o.accountCode.trim() : "";
    if (!code) continue;
    const cand: AccountCandidate = { accountCode: code };
    if (typeof o.businessPct === "number" && Number.isFinite(o.businessPct)) {
      cand.businessPct = clampPct(o.businessPct);
    }
    if (typeof o.rationale === "string" && o.rationale.trim()) cand.rationale = o.rationale.trim();
    out.push(cand);
  }
  return out;
}

/** Render an unknown thrown value as a short string for the rationale. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
