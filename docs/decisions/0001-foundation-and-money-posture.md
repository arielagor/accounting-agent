# 0001 — Foundation, money posture, and the storage decision

Date: 2026-06-13
Status: accepted

## Context

Building an autonomous accounting agent for Ariel's portfolio, decided (via the
clarifying questions on 2026-06-13) to: use **SimpleFIN** (read-only, ~$15/yr) for
bank/card aggregation, build **both** the single-tenant Phase 1 and the multi-tenant
Phase 2 SKU, make the tax entity **fully modular**, and target **full-auto live** close
(with an `off→draft→live` ladder built underneath for safe bring-up).

## Decisions

1. **Money is integer cents (BIGINT) everywhere.** No floats in the ledger. Float
   arithmetic silently loses pennies, and a double-entry system that does not balance to
   the cent is worthless. `src/core/money.ts` owns the conversions and the exact
   `allocateCents` (largest-remainder) split so allocations sum to the cent.

2. **A separate `accounting` database on the existing `gbrain-pg` instance** (localhost:5433),
   not a prefix inside the `gbrain` knowledge DB and not a new Docker container. Reuses the
   instance (cost rule) while isolating financial data from the knowledge graph for clean
   backup and blast-radius.

3. **Balanced-entry integrity is enforced at the database layer** — a DEFERRABLE INITIALLY
   DEFERRED constraint trigger (`acct_assert_entry_balanced`) checks `SUM(debit)=SUM(credit)`
   per entry at COMMIT. Verified 2026-06-13: a balanced entry passes, an unbalanced one is
   rejected (`journal entry N is unbalanced: debits=1000 credits=999`).

4. **One portable TypeScript core** (`src/core/`) is the shared brain. Phase 1 runs it via a
   local CLI under Windows Task Scheduler; Phase 2 ports a copy into `agor-agents` (per that
   repo's copy-not-cross-import isolation rule).

5. **The accountant persona** (`src/core/persona.ts`) — Hank Calloway, CPA: creative,
   low-tax-philosophy, relentlessly pro-taxpayer, but rule-bound and audit-defensible.
   Aggressive positions are flagged for CPA sign-off, never auto-applied. (Ariel, 2026-06-13.)

6. **Read-only money posture is structural**, not configured: the `AggregationProvider`
   interface has no money-movement method. There is no code path, even a buggy one, that can
   move money.

## Verification

`npm run migrate` applies 11 files; `npm run typecheck` clean; seed counts confirmed
(61 chart / 11 projects / 14 cat rules / 4 alloc rules / 12 targets / 12 tax-rate sets / 28 tables);
balanced-entry trigger accepts balanced and rejects unbalanced.
