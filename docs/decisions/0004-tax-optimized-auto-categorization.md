# 0004 — Tax-optimized auto-categorization for uncertain transactions

- **Status:** Accepted, implemented
- **Date:** 2026-06-17
- **Decider:** Ariel (request), implemented autonomously

## Context

The auditor's original posture was: when the 3-tier categorizer and the `/council`
could not confidently resolve a transaction, the item was **parked in the review queue
for a human**. Safe, but it leaves money on the table and creates manual work for the
exact cases a competent accountant would just decide.

Ariel's directive (2026-06-17, verbatim):

> if the agent accountant is unsure where to categorize something instead of leaving it
> to a human it should choose the category that will have the most beneficial tax
> consequences for the user within a reasonable account that makes the most sense in
> its opinion.

The operative constraint is in his own words: **"within a reasonable account that makes
the most sense."** Be tax-beneficial, but stay defensible. This squares with the existing
"Hank Calloway, CPA" persona (every legal angle, aggressive positions flagged for
sign-off) and with the standing rule that aggressive deductions are always human-gated.

## Decision

When the auditor is **genuinely unsure** about an **otherwise-safe** transaction, it now
books the **most tax-beneficial defensible account** instead of parking it for a human.

"Unsure but safe" means the council came back unresolved or below the confidence
threshold, and the item is **not** caught by any hard gate. The hard gates are unchanged
and always win:

- **Council human-gate** (aggressive home-office %, 100% vehicle, large §179, entity
  change, money movement) → escalate.
- **Needs-access** (the council needs data it can't see, e.g. an itemized receipt) →
  file a grantable access-request and defer.
- **Audit-sensitive account** as the council's primary read (`6900` vehicle/mileage,
  `6950` home office) → escalate; never auto-optimized.
- **Large amount** (the global `humanGateAmountCents` gate) → escalate.

### How "most beneficial" is decided (`src/core/tax-benefit.ts`, pure)

The candidate accounts come **only from the council**, which now returns a `candidates`
list of every account it vouches as defensible (best-first). The optimizer ranks them by
current-year deduction benefit, derived from each account's existing `tax_treatment`:

| treatment | benefit | meaning |
|---|---|---|
| `ordinary` | 100 | fully deductible this year |
| `meals_50` | 50 | half deductible |
| `capital` | 30 | real, but depreciated over future years |
| `personal` / `nondeductible` | 0 | no deduction |
| `mileage` / `home_office` | (excluded) | audit-sensitive — never auto-picked |

Ties break on higher business-use %, then the council's own ordering (its primary pick
wins a true tie, keeping the choice stable). Only `expense`/`cogs` accounts are eligible;
a balance-sheet code is never auto-booked as an expense for benefit. A non-business
account scores 0 but is still a valid categorization if it's the only reasonable fit.

### Guardrails specific to this path

- **Its own amount cap** (`taxOptimizeMaxCents`, default **$2,500**). Even below the
  global large-amount gate, an uncertain charge at/above this cap stays with a human, so
  a big item is never silently optimized when the global gate is disabled.
- **Behind a flag** (`taxOptimizeUncertain`). Core default **off** (conservative for the
  multi-tenant SKU and tests); Ariel's runtime turns it **on** via `AUDITOR_TAX_OPTIMIZE`
  (default `1`; set `0` to revert). Cap overridable via `AUDITOR_TAX_OPTIMIZE_MAX_CENTS`.
- **Fully reversible + teaches the system.** Every pick is posted with basis
  `tax_optimized` (new), logged to `acct_audit_log` (`tax_optimized_post`) with the
  candidate set, chosen treatment, and benefit, and recorded in
  `acct_auditor_decisions`. Re-categorizing it in the Transactions tab corrects the entry
  AND writes a human-learned merchant rule that supersedes the auto-pick next time.

### Related fix

The auditor's `DEFAULT_SENSITIVE` set referenced **non-existent codes** (`6300`, `6310`)
and mislabeled `6900`. Corrected to the live chart's real audit-sensitive codes
(`6900` vehicle/mileage, `6950` home office). This was safety-critical: the optimizer
excludes sensitive accounts by code, so the set has to match the chart.

## Consequences

- Fewer items wait on a human; uncertain spend is booked to the best defensible category.
- The agent stays within reasonable/defensible positions; aggressive deductions remain a
  human decision. The optimizer cannot pick home office or vehicle.
- No new money-movement capability; the engine still only records and posts ledger
  entries.

## Verification

- `npx tsc --noEmit` clean.
- `npm test` — 211 tests, 0 fail, 0 skipped. New coverage: `test/tax-benefit.test.ts`
  (ranking, sensitive exclusion, eligibility, tie-breaks, null cases) and
  `test/auditor.test.ts` DB-backed cases (unsure → tax-optimized post + ledger entry +
  cleared quarantine + `tax_optimized` basis accepted by migration `015`; flag-off still
  parks; sensitive primary still escalates; over-cap stays human-gated).

## Extension — the Apple catalog reviewer (2026-06-18)

Ariel asked for the same lean on the **Apple purchase-history reviewer** ("Apple reviewer
too"). That reviewer's axis is business-vs-personal (business = deductible) rather than
chart-account selection, so the lean is shaped to fit while keeping the same
defensible-only guardrail:

- `auditAppleReview(..., leanBusiness)` (governed by the **same** `AUDITOR_TAX_OPTIMIZE`
  flag). When on, a **genuine toss-up with a reasonable business use** is classified
  BUSINESS (the deductible outcome) and flagged `auto_leaned`; **clearly-personal items
  still go personal**, and anything the model truly can't place still stays in `review`.
- The items reaching this reviewer are already the ambiguous tail — the deterministic
  keyword lists pulled out the clear business/personal cases first — so the lean only ever
  touches real toss-ups.
- **A leaned toss-up does NOT learn a merchant rule** (unlike a confident classification);
  a hedged call must not harden into an authoritative rule until a human confirms it.
- Leaned items surface in the Apple tab under "Auto-leaned to business — confirm or flip,"
  each one-click confirmable (keep business) or reversible (make personal); a human
  decision clears the `auto_leaned` flag. `sql/016` adds the column. The "Run Apple
  auditor" button (newly wired) reports how many toss-ups were leaned.

## Files

- `sql/015_auditor_tax_optimized.sql` — widen the `basis` CHECK to allow `tax_optimized`.
- `sql/016_apple_auto_leaned.sql` — `auto_leaned` flag on the Apple catalog.
- `src/core/apple-history.ts` — `leanBusiness` mode, `auto_leaned`, leaned-no-learn guard.
- `src/lib/app-data.ts` — `appleCatalog` surfaces the leaned list.
- `bin/dashboard.ts` — `/api/apple/audit` (wired; same flag); `src/lib/dashboard-page.ts`
  — "Run Apple auditor" button + leaned review section.
- `src/core/tax-benefit.ts` — pure ranking + `pickTaxOptimal`.
- `src/core/auditor.ts` — config flags, corrected sensitive set, tax-optimize path, tally.
- `src/core/types.ts` — `AccountCandidate`, `CouncilVerdict.candidates`, `tax_optimized` basis.
- `src/lib/llm.ts` — council prompt asks for `candidates`; parsing.
- `bin/audit.ts`, `bin/dashboard.ts` — wire the flag (default on for Ariel) + cap; summary.
- `src/lib/dashboard-page.ts` — "Run auditor" summary reports the tax-optimized count.
