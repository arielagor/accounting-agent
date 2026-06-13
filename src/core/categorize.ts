/**
 * 3-tier transaction categorization. The decision policy is the only place the
 * priority between tiers lives, so it is a PURE function (`decide`) that takes the
 * candidate rules already fetched and the optional LLM proposal, and returns a
 * post-or-quarantine outcome. The thin `categorize` wrapper does the I/O: it reads
 * the rule tables, optionally calls the injected LLM, logs the LLM decision, and
 * writes the review-queue / learned-rule rows. It NEVER posts journal entries —
 * the close orchestrator does that from the returned CategorizationResult.
 *
 * Tier order (highest authority first):
 *   (b) learned merchant rule  — an exact normalized-merchant match we've seen
 *   (a) deterministic regex rule — first match by ascending priority
 *   (c) LLM proposal           — only when no deterministic tier fired
 * A `needs_split` signal at ANY tier short-circuits to quarantine: a mixed-use
 * vendor must not be silently posted at one business fraction. And we NEVER guess
 * into a post below threshold — an under-confident decision is quarantined, never
 * booked, because a wrong auto-post is worse than a human glance.
 */

import type { Sql } from "./db.js";
import type {
  CategorizationInput,
  CategorizationResult,
  CategorizeOutcome,
  LlmCategorizer,
  LlmProposal,
} from "./types.js";
import { log } from "../lib/log.js";

// ─── Confidence floors ──────────────────────────────────────────────────────
/** A learned merchant rule is treated as near-certain — we have booked it before. */
const MERCHANT_RULE_CONFIDENCE = 0.99;
/** A deterministic regex rule auto-posts only at/above this confidence. */
const REGEX_AUTO_POST_MIN = 0.9;
/** The LLM is never trusted below this floor, regardless of a looser config. */
const LLM_MIN_FLOOR = 0.85;

// ─── Row shapes (mirror sql/003_rules.sql; bigints/numerics arrive as numbers) ──
/** A learned override from acct_merchant_rules, keyed by normalized merchant. */
export interface MerchantRuleRow {
  accountCode: string;
  projectSlug: string | null;
  businessPct: number;
  needsSplit: boolean;
}

/** A deterministic rule from acct_categorization_rules, evaluated by priority. */
export interface RegexRuleRow {
  priority: number;
  matchField: "merchant" | "memo" | "source";
  matchRegex: string;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  accountCode: string;
  projectSlug: string | null;
  businessPct: number;
  needsSplit: boolean;
  confidence: number;
}

/** Lowercase US state/territory abbreviations, used to anchor a trailing location. */
const US_STATES = new Set(
  (
    "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo " +
    "mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc"
  ).split(" "),
);

/**
 * Normalize a raw merchant string into a stable key for the learned-rule lookup.
 * Strips the noise that varies per-swipe but not per-merchant: processor prefixes
 * ("SQ *", "TST*", "PP*"), attached domains, store/terminal numbers, a trailing
 * city/state location, punctuation, and runs of whitespace. The result is lowercase
 * and trimmed so "SQ *BLUE BOTTLE #1234 OAKLAND CA" collapses to "blue bottle".
 *
 * The goal is a DETERMINISTIC, idempotent key — same merchant → same key, every
 * time — not a pristine display name. The trailing-location strip is intentionally
 * conservative (it removes the state token and only ONE preceding city word, and
 * never reduces the name below one token) so it can't destroy real merchant words.
 * A two-word city therefore leaves a residual token (e.g. "netlify san"), which is
 * still a perfectly stable key. We prefer leaving a harmless residue over eating a
 * real merchant word, which would split one vendor across two keys.
 */
export function normalizeMerchant(s: string): string {
  let out = (s ?? "").toLowerCase();
  // Strip common payment-processor prefixes (SQ *, TST*, SP *, PAYPAL *, PP*, etc.).
  out = out.replace(/^\s*(sq|tst|sp|pp|paypal|pos|ach|dd|gp|in)\s*\*\s*/i, "");
  // Any leftover "<token> *" processor prefix at the start.
  out = out.replace(/^\s*[a-z0-9]{2,8}\s*\*\s*/i, "");
  // Strip URLs/domains attached to the name (e.g. "amzn mktp us amazon.com").
  out = out.replace(/\b[a-z0-9-]+\.(?:com|net|org|co|io|ai)\b/gi, " ");
  // Drop store/terminal numbers like "#1234", "store 0099", "- 4471".
  out = out.replace(/#\s*\d+/g, " ");
  out = out.replace(/\b(?:store|str|term|terminal|loc|ref|id)\s*#?\s*\d+/gi, " ");
  // Collapse punctuation to spaces and squeeze whitespace before token-level work.
  out = out.replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim();
  // Drop a trailing "<city> <STATE>" location: only when the last token is a real
  // US state AND ≥2 tokens remain before it — remove the state and one city word.
  const toks = out.split(" ").filter(Boolean);
  if (toks.length >= 3 && US_STATES.has(toks[toks.length - 1]!)) {
    toks.pop(); // state token
    toks.pop(); // one city word (kept conservative; leaves >= 1 merchant token)
    out = toks.join(" ");
  }
  return out.trim();
}

/** Build the posting result a learned merchant rule implies (auth: near-certain). */
function resultFromMerchant(rule: MerchantRuleRow): CategorizationResult {
  return {
    accountCode: rule.accountCode,
    projectSlug: rule.projectSlug,
    businessPct: rule.businessPct,
    confidence: MERCHANT_RULE_CONFIDENCE,
    needsSplit: rule.needsSplit,
    source: "merchant_rule",
    rationale: "learned merchant rule",
  };
}

/** Build the posting result a deterministic regex rule implies. */
function resultFromRegex(rule: RegexRuleRow): CategorizationResult {
  return {
    accountCode: rule.accountCode,
    projectSlug: rule.projectSlug,
    businessPct: rule.businessPct,
    confidence: rule.confidence,
    needsSplit: rule.needsSplit,
    source: "regex_rule",
    rationale: `regex rule priority ${rule.priority}`,
  };
}

/** Build the posting result an LLM proposal implies. */
function resultFromLlm(proposal: LlmProposal): CategorizationResult {
  return {
    accountCode: proposal.accountCode,
    projectSlug: proposal.projectSlug,
    businessPct: proposal.businessPct,
    confidence: proposal.confidence,
    needsSplit: proposal.needsSplit,
    source: "llm",
    rationale: proposal.rationale,
  };
}

/** Quarantine outcome helper — no result is booked, only a reason is recorded. */
function quarantine(
  sourceTxnId: string,
  reason: NonNullable<CategorizeOutcome["reason"]>,
): CategorizeOutcome {
  return { sourceTxnId, disposition: "quarantined", reason };
}

/** Post outcome helper — carries the result the orchestrator will book. */
function post(sourceTxnId: string, result: CategorizationResult): CategorizeOutcome {
  return { sourceTxnId, disposition: "posted", result };
}

/**
 * Compile a stored regex into a JS RegExp. The rules are authored in Postgres
 * POSIX style (sql/seed/012_categorization_rules.sql) and frequently lead with the
 * inline case-insensitive flag `(?i)` — which JavaScript's RegExp does NOT support
 * and would throw on. We translate a leading inline-flag group into the equivalent
 * native flags so the SAME pattern matches in JS as it does in Postgres. Returns
 * null on a genuinely malformed pattern (treated as non-matching by the caller).
 */
function compileRule(pattern: string): RegExp | null {
  let src = pattern;
  let flags = "";
  // Pull a leading inline-flag group like "(?i)" or "(?im)" into native flags.
  const m = /^\(\?([a-z]+)\)/i.exec(src);
  if (m) {
    const inline = m[1]!.toLowerCase();
    if (inline.includes("i")) flags += "i";
    if (inline.includes("m")) flags += "m";
    if (inline.includes("s")) flags += "s";
    src = src.slice(m[0].length);
  }
  try {
    return new RegExp(src, flags);
  } catch {
    // A malformed stored regex must never crash the close — treat as non-matching.
    return null;
  }
}

/**
 * Does a regex rule apply to this input? The rule must (1) match its declared
 * field with its regex, and (2) fall within its amount band when one is set.
 * Amounts are compared on the ABSOLUTE cent value so an outflow band like
 * [9800,10200] matches a -$100.00 charge of -10000 cents.
 */
function regexRuleApplies(rule: RegexRuleRow, input: CategorizationInput): boolean {
  const field =
    rule.matchField === "memo"
      ? input.memo
      : rule.matchField === "source"
        ? input.sourceTxnId
        : input.merchant;
  const re = compileRule(rule.matchRegex);
  if (re === null) return false;
  if (!re.test(field ?? "")) return false;
  const abs = Math.abs(input.amountCents);
  if (rule.amountMinCents !== null && abs < rule.amountMinCents) return false;
  if (rule.amountMaxCents !== null && abs > rule.amountMaxCents) return false;
  return true;
}

/**
 * The pure tier-priority decision. Given the candidate rules already fetched and
 * the optional LLM proposal, decide whether to post or quarantine — no I/O.
 *
 * Order of authority:
 *   1. Learned merchant rule wins outright (confidence 0.99). If it carries
 *      needs_split, we quarantine(needs_split) rather than post at one fraction.
 *   2. Else the first regex rule that applies (ascending priority). If it needs a
 *      split → quarantine(needs_split); otherwise post only when confidence ≥ 0.90.
 *   3. Else the LLM proposal, but only when it does NOT need a split and clears
 *      max(0.85, threshold) → post as source "llm".
 *   4. Else quarantine. The reason distinguishes a known-but-shaky read
 *      (low_confidence) from a vendor we've simply never seen (new_merchant).
 * Never guesses into a post below threshold.
 */
export function decide(
  input: CategorizationInput,
  merchantRule: MerchantRuleRow | null,
  regexRules: RegexRuleRow[],
  llmProposal: LlmProposal | null,
  confidenceThreshold: number,
): CategorizeOutcome {
  // Tier (b): learned merchant rule — highest authority.
  if (merchantRule) {
    if (merchantRule.needsSplit) return quarantine(input.sourceTxnId, "needs_split");
    return post(input.sourceTxnId, resultFromMerchant(merchantRule));
  }

  // Tier (a): first applicable regex rule by ascending priority.
  const ordered = [...regexRules].sort((a, b) => a.priority - b.priority);
  const matched = ordered.find((r) => regexRuleApplies(r, input));
  if (matched) {
    if (matched.needsSplit) return quarantine(input.sourceTxnId, "needs_split");
    if (matched.confidence >= REGEX_AUTO_POST_MIN) {
      return post(input.sourceTxnId, resultFromRegex(matched));
    }
    // Matched a rule but it is below the auto-post floor — a human should glance.
    return quarantine(input.sourceTxnId, "low_confidence");
  }

  // Tier (c): LLM proposal, gated on the higher of its floor and the config threshold.
  if (llmProposal) {
    if (llmProposal.needsSplit) return quarantine(input.sourceTxnId, "needs_split");
    const llmMin = Math.max(LLM_MIN_FLOOR, confidenceThreshold);
    if (llmProposal.confidence >= llmMin) {
      return post(input.sourceTxnId, resultFromLlm(llmProposal));
    }
    return quarantine(input.sourceTxnId, "low_confidence");
  }

  // Nothing fired and no proposal: a brand-new, unrecognized merchant.
  return quarantine(input.sourceTxnId, "new_merchant");
}

// ─── Thin DB wrapper ──────────────────────────────────────────────────────────

/**
 * Categorize one staged transaction end to end. Reads the learned merchant rule
 * (by normalized merchant), the enabled deterministic rules (priority order), and
 * — only when neither posts — calls the injected LLM (logging its proposal to
 * acct_llm_decisions). Runs the pure `decide()`, then persists the side effects:
 * a quarantine writes acct_review_queue (idempotent on source_txn_id); an LLM
 * accept upserts a learned merchant rule (learned_from = 'llm_accepted') so the
 * next sighting is deterministic. Does NOT post journal entries.
 */
export async function categorize(
  sql: Sql,
  tenantId: string,
  input: CategorizationInput,
  opts: { confidenceThreshold: number; llm?: LlmCategorizer },
): Promise<CategorizeOutcome> {
  const merchantKey = normalizeMerchant(input.merchant);

  // Tier (b): the learned override, if any.
  const merchantRows = await sql<
    {
      account_code: string;
      project_slug: string | null;
      business_pct: string;
      needs_split: boolean;
    }[]
  >`
    SELECT account_code, project_slug, business_pct, needs_split
    FROM acct_merchant_rules
    WHERE merchant_key = ${merchantKey}
    LIMIT 1
  `;
  const merchantRule: MerchantRuleRow | null =
    merchantRows.length > 0
      ? {
          accountCode: merchantRows[0]!.account_code,
          projectSlug: merchantRows[0]!.project_slug,
          businessPct: Number(merchantRows[0]!.business_pct),
          needsSplit: merchantRows[0]!.needs_split,
        }
      : null;

  // Tier (a): enabled deterministic rules, ascending priority (decide re-sorts too).
  const regexRows = await sql<
    {
      priority: number;
      match_field: "merchant" | "memo" | "source";
      match_regex: string;
      amount_min_cents: string | null;
      amount_max_cents: string | null;
      account_code: string;
      project_slug: string | null;
      business_pct: string;
      needs_split: boolean;
      confidence: string;
    }[]
  >`
    SELECT priority, match_field, match_regex, amount_min_cents, amount_max_cents,
           account_code, project_slug, business_pct, needs_split, confidence
    FROM acct_categorization_rules
    WHERE enabled
    ORDER BY priority ASC
  `;
  const regexRules: RegexRuleRow[] = regexRows.map((r) => ({
    priority: Number(r.priority),
    matchField: r.match_field,
    matchRegex: r.match_regex,
    amountMinCents: r.amount_min_cents === null ? null : Number(r.amount_min_cents),
    amountMaxCents: r.amount_max_cents === null ? null : Number(r.amount_max_cents),
    accountCode: r.account_code,
    projectSlug: r.project_slug,
    businessPct: Number(r.business_pct),
    needsSplit: r.needs_split,
    confidence: Number(r.confidence),
  }));

  // Tier (c): call the LLM only when no deterministic tier will post — a learned
  // rule or an applicable auto-post regex makes the LLM unnecessary (and costly).
  let llmProposal: LlmProposal | null = null;
  const deterministicWillPost =
    (merchantRule !== null && !merchantRule.needsSplit) ||
    [...regexRules]
      .sort((a, b) => a.priority - b.priority)
      .some((r) => regexRuleApplies(r, input) && !r.needsSplit && r.confidence >= REGEX_AUTO_POST_MIN);
  const deterministicNeedsSplit =
    (merchantRule?.needsSplit ?? false) ||
    [...regexRules]
      .sort((a, b) => a.priority - b.priority)
      .some((r) => regexRuleApplies(r, input) && r.needsSplit);

  if (opts.llm && !deterministicWillPost && !deterministicNeedsSplit) {
    llmProposal = await opts.llm.categorize(input, { chart: [], projects: [] });
    // Audit trail: every LLM proposal is logged regardless of whether it posts.
    await sql`
      INSERT INTO acct_llm_decisions
        (source_txn_id, merchant, amount_cents, memo, proposed_account_code,
         proposed_project_slug, proposed_business_pct, confidence, rationale, outcome)
      VALUES (
        ${input.sourceTxnId}, ${input.merchant}, ${input.amountCents}, ${input.memo},
        ${llmProposal.accountCode}, ${llmProposal.projectSlug}, ${llmProposal.businessPct},
        ${llmProposal.confidence}, ${llmProposal.rationale}, 'pending'
      )
    `;
  }

  const outcome = decide(input, merchantRule, regexRules, llmProposal, opts.confidenceThreshold);

  if (outcome.disposition === "quarantined") {
    // Plain JSON snapshot of what we saw, so a human reviewer has full context.
    const proposedJson = {
      merchant: input.merchant,
      merchantKey,
      amountCents: input.amountCents,
      memo: input.memo,
      llm: llmProposal
        ? {
            accountCode: llmProposal.accountCode,
            projectSlug: llmProposal.projectSlug,
            businessPct: llmProposal.businessPct,
            confidence: llmProposal.confidence,
            needsSplit: llmProposal.needsSplit,
            rationale: llmProposal.rationale,
          }
        : null,
    };
    // Surface for human review; idempotent so a re-run never duplicates the row.
    await sql`
      INSERT INTO acct_review_queue (source_txn_id, reason, proposed_json)
      VALUES (
        ${input.sourceTxnId}, ${outcome.reason ?? "low_confidence"},
        ${sql.json(proposedJson)}
      )
      ON CONFLICT (source_txn_id) DO NOTHING
    `;
    log("categorize: quarantined", input.sourceTxnId, outcome.reason);
    return outcome;
  }

  // Posted. If the decision came from the LLM, learn it: upsert a merchant rule so
  // the next sighting is deterministic, and mark the audit row auto-posted.
  if (outcome.result && outcome.result.source === "llm") {
    await sql`
      INSERT INTO acct_merchant_rules
        (merchant_key, account_code, project_slug, business_pct, needs_split, learned_from)
      VALUES (
        ${merchantKey}, ${outcome.result.accountCode}, ${outcome.result.projectSlug},
        ${outcome.result.businessPct}, ${outcome.result.needsSplit}, 'llm_accepted'
      )
      ON CONFLICT (merchant_key) DO UPDATE SET
        account_code = EXCLUDED.account_code,
        project_slug = EXCLUDED.project_slug,
        business_pct = EXCLUDED.business_pct,
        needs_split  = EXCLUDED.needs_split,
        times_seen   = acct_merchant_rules.times_seen + 1,
        last_confirmed_at = now(),
        learned_from = 'llm_accepted'
    `;
    await sql`
      UPDATE acct_llm_decisions
      SET outcome = 'auto_posted'
      WHERE source_txn_id = ${input.sourceTxnId} AND outcome = 'pending'
    `;
    log("categorize: llm_accepted, learned merchant rule", merchantKey, outcome.result.accountCode);
  }

  return outcome;
}
