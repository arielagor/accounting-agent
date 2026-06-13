# HANDOFF — Accounting Agent

Built 2026-06-13 in one autonomous overnight session (boil-the-ocean + fan-out). This is
where things stand and exactly what you (Ariel) need to do next.

## What got built (Phase 1 — your portfolio, single-tenant) — COMPLETE & TESTED

A working, tested autonomous accounting agent in `C:\Users\ariel\.claude\projects\accounting-agent`.
**141 tests green, `tsc --noEmit` clean.** Private repo (local; not yet pushed to GitHub — see next steps).

- **Storage:** a separate `accounting` database on your existing `gbrain-pg` Postgres
  (localhost:5433). 28 `acct_*` tables. Money is integer cents everywhere; a DEFERRED
  trigger rejects any unbalanced journal entry (verified).
- **Ingestion (read-only):** `bin/sync.ts` — SimpleFIN provider, idempotent upsert, node-locked,
  escalates expired links by email without blocking other accounts. **No code path can move money**
  (the provider interface has no transfer/pay verb).
- **Ledger + posting:** double-entry, idempotent, centralized debit/credit direction (`posting.ts`).
- **Categorization:** 3-tier — learned merchant rule → regex rule → `claude -p` ($0, API key stripped)
  → escalate. Never guesses below the confidence threshold; quarantines instead.
- **Allocation:** shared costs split per project (even/fixed/usage/revenue/direct); nets to zero
  (fixed a double-allocation bug the close test caught).
- **Tax engine (modular toggle):** sole-prop / single-LLC / multi-LLC / S-corp / C-corp / organize-only,
  year-scoped rates (no literals in code). Tests prove S-corp lowers the SE burden vs sole-prop.
- **Persona:** Hank Calloway, CPA — creative, pro-taxpayer, works every LEGAL angle, flags aggressive
  positions for CPA sign-off, never crosses a red line (`src/core/persona.ts`).
- **Month-end close:** `bin/close-agent.ts` → `src/core/close.ts`. Named-stage pipeline, off→draft→live
  gating, idempotent period-lock, trial-balance hard stop, controller-grade close package (P&L,
  cash, Schedule-C rollup, roll-forward that foots, variance commentary, exceptions), tie-out check,
  and a verdict re-queried from Postgres (never an exit code). Accruals are DRAFT-for-approval.
  Emails a ranked digest with one-line reply verbs.
- **Finance-plugin methodology** (month-end-closer, gl-recon, roll-forward, variance, accrual) harvested
  into the design (`docs/decisions/0002`).

## What got built (Phase 2 — productized SKU at app.agor.me) — CONTRACT ONLY, on a DRAFT PR

`agor-agents` PR **#13** (DRAFT, DO NOT MERGE): the Accounting SKU manifest + registration +
integration types + multi-tenant RLS migration + eval gate (minScore 0.95) + 7 contract tests.
**230 agor-agents tests green, tsc clean.** The live multi-tenant worker is deferred (see below).

## YOUR NEXT STEPS (one-way doors I deliberately did NOT take while you slept)

1. **Push the Phase-1 repo to GitHub (private).** I built it locally; create the repo when ready:
   `cd accounting-agent && gh repo create accounting-agent --private --source=. --push` (or via the gh-repo-creator agent).
2. **Set a real encryption key:** in `.env`, `INTEGRATION_ENC_KEY=$(openssl rand -hex 32)` (currently a dev key).
3. **Link your accounts (needs YOUR SimpleFIN credentials — I can't):**
   - Approve the ~$15/yr SimpleFIN spend, create a bridge connection at https://bridge.simplefin.org.
   - `npm run link -- --setup-token <token> --institution "Chase"`
   - `npm run link -- --map <providerAccountId>=1010` (checking), `=2010` (a card), etc.
   - Verify coverage; if a key bank isn't supported, we add Plaid for that account.
4. **Run a dry close and review it:** keep `CLOSE_MODE=off` → set to `draft` in `.env`, then
   `npm run sync` and `npm run close -- --mode=close --period <YYYY-MM>`. Read the emailed digest + reports.
5. **Go live when you trust it:** set `CLOSE_MODE=live` in `.env`, then `powershell -File scripts/register-tasks.ps1`
   to schedule NightlySync / CloseIncremental / MonthEndClose. (Inert until both are done.)
6. **Productization follow-up (supervised):** the live multi-tenant worker — port the engine into
   `agor-agents/src/lib/accounting/`, add the `postgres` dep + Supabase RLS store, per-tenant `runClose`
   under an advisory lock, a `backend-worker` deliverable emitter + Netlify scheduled fan-out. Then the
   SKU's 0.95 eval gate runs live and the SKU becomes provisionable. Review PR #13 first.

## Operate it
`npm run migrate` (idempotent) · `npm run link` · `npm run sync` · `npm run close -- --mode=close`
· `npm test` · `npm run typecheck`. The `.env` ladder (`CLOSE_MODE=off|draft|live`) is the master switch.

## Decisions / verdicts this session
First `/council` on overnight scope returned null (quota/parse) and was superseded by your direct
"take it all the way" + "use workflows and fan out" + "creative republican accountant" + "reactivate
finance skills" directives. Finance plugins are installed; their methodology is baked in; their paid
external data-feeds stay disabled (cost rule). Decision docs: `docs/decisions/0001` (foundation),
`0002` (finance methodology); agor-agents `docs/decisions/0025` (SKU).
