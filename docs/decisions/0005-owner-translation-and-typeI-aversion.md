# 0005 — Owner translation layer + Type-I-averse tax tie-break + aggregate sign-off

- **Status:** Accepted, implemented
- **Date:** 2026-06-23
- **Decider:** Ariel ("plan the rebase and do it, based on the last two socratic answers")

## Context

Two Socratic interrogations produced concrete conclusions that this change implements.

**1. The tax-optimize objective was subtly wrong.** Auto-picking "the best defensible
deduction when unsure" implicitly assumes symmetric error cost. Tax is brutally asymmetric:
booking personal as business (back tax + interest + ~20% penalty + audit exposure across the
whole return) costs far more than the reverse (a recoverable missed deduction). A return where
every ambiguous call broke the taxpayer's way is also itself a pattern. And a category is not a
substantiated deduction. The owner signs under penalty of perjury, so positions taken on their
behalf should be owned in aggregate.

**2. The dashboard spoke the accounting engine's language.** Correct numbers, but framed for
someone who already thinks in ledgers (Portfolio P&L, COGS, AR/AP aging, tie-out, posted/
unposted, raw chart codes). A non-accountant owner needs the same true numbers re-expressed as
their questions, decisions, and words.

## Decision

### A. Type-I (over-claim) aversion in the tax tie-break

`pickTaxOptimal` now reports `beatNonDeductible`: true when a deductible winner beat an eligible
non-deductible (personal) alternative — the high-asymmetry "is it even a business expense" axis.
The auditor applies a lean-confidence floor (`AUDITOR_TAX_LEAN_FLOOR`, default **0.6**): when the
optimizer would grab a deduction over a non-deductible option but council confidence is a
coin-flip below the floor, the item is **left for a human** instead of auto-deducted. Leaning is
still free when (a) it's only choosing between business categories (low asymmetry, deductible
either way), or (b) confidence is at/above the floor (real business-purpose signal). New tally
`taxDeferredConservative`; audit action `tax_defer_conservative`. Set the floor to 0 to revert to
pure max-deduction.

### B. Aggregate sign-off surface ("what the agent did for you")

Migration `017` adds `acct_auditor_decisions.confirmed_at`. `agentPositions()` returns every
**unconfirmed** tax-optimized transaction post + Apple leaned item, each with its deductible
impact and a running total. Surfaced in the "Needs you" tab: the owner reviews the **portfolio**
of positions the return rests on and Keeps or Makes-personal each (flip books it to 9500). This
is the screen you sign off before filing, and it doubles as the dashboard's tax-number honesty
(the "set aside for taxes" total embeds these calls). `GET /api/positions`,
`POST /api/positions/confirm|flip`. The section hides when there's nothing to confirm.

### C. Owner translation layer (UI)

- **Overview leads with three answers:** Cash on hand (+ weeks of runway, guarded for negative
  cash), Profit this period, Taxes to set aside. A trust line ("Synced from N accounts, data
  through <date>"). Net worth + P&L breakdown demoted to detail cards.
- **Relabel the engine's words:** Portfolio P&L -> Profit; COGS -> Cost of goods; Operating
  expense -> Expenses; AR/AP aging -> Money owed to you / Bills you owe (buckets reframed as
  "N days late"); posted/unposted/review -> done/new/needs review; document pipeline states ->
  read/working/itemized/needs-a-match; tie-out -> "books need a check"; "voids + re-posts" ->
  "teaches the agent"; raw chart codes dropped from category dropdowns and cash-by-account.
- **Tabs in owner language:** Apple -> Apple purchases, Business -> Invoices & bills, Review ->
  Needs you.

**Consciously deferred:** a deep IA restructure (Money / Spending / Get-paid / To-do). The
relabel + Overview rebase + aggregate review capture the bulk of the value without a risky
full navigation rewrite.

## Consequences

- Low-confidence deductions on the risky axis go to a human instead of being auto-claimed; the
  agent's automation still removes the manual work for the clear cases.
- The owner owns the portfolio of positions they sign, in their language.
- No engine numbers changed by the relabel; the same double-entry truth is just re-expressed.
- The first live auditor run should still be observed / in draft (the optimizer trusts the
  council to return only defensible candidates — an LLM-behavior assumption).

## Verification

- `npx tsc --noEmit` clean; `npm test` — 218 tests, 0 fail, 0 skipped. New: `tax-benefit`
  `beatNonDeductible` cases; DB-backed auditor Type-I defer (coin-flip business-vs-personal →
  left for human) and post-with-signal (>= floor → deducted).
- Live in-browser: Overview three-answer lead + provenance + friendly status render; the "Needs
  you" tab renders (positions section hides when empty); no console errors; runway guards
  negative cash.

## Files

- `sql/017_auditor_confirmed.sql`; `src/core/tax-benefit.ts` (`beatNonDeductible`);
  `src/core/auditor.ts` (lean floor, deferral, tally); `src/lib/app-data.ts` (`agentPositions`,
  provenance); `bin/audit.ts`, `bin/dashboard.ts` (floor wiring, `/api/positions`, provenance);
  `src/lib/dashboard-page.ts` (Overview rebase, relabel, tab labels, positions UI).
