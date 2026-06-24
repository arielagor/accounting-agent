# HANDOFF — Mint-class budgeting/accounting/advisory app

**Goal (approved plan):** evolve the working single-tenant accounting engine into a commercial-grade
retail budgeting + accounting + financial-advisory app (Mint-class, agent-augmented) for personal AND
small business, deployable multi-tenant at app.agor.me with Ariel's books as cloud tenant #1.
Plan file: `~/.claude/plans/system-reminder-message-sent-at-sat-enchanted-dragonfly.md`.
(Phase 1 — the single-tenant month-end-close engine, built 2026-06-13 — is COMPLETE & TESTED and is
the foundation this builds on; its details live in git history + the GBrain project page.)

## Locked decisions
1. Both tenancies in parallel (Ariel's instance + multi-tenant SKU)
2. Web app + mobile PWA (Next.js/React, installable, Web Push)
3. SimpleFIN now, Plaid later
4. Auditor auto-acts, escalates to /council on doubt + research agents that file access-requests
5. Hybrid (envelope/zero-based) + per-project budgets
6. Universal receipt ingest + auto-split (PDF/CSV/email/photo + forwarding inbox)
7. Full SMB (AR/AP, payroll, 1099, sales tax)
8. Netlify + Supabase; migrate Ariel's books in as encrypted tenant #1; local Postgres = dev mirror

## Milestones — ALL BUILT, TESTED, COMMITTED (2026-06-15)
- **M7** Web app — **DONE** Multi-tab Mint-class PWA + Web Push (`bin/dashboard.ts`, `src/lib/dashboard-page.ts`, `app-data.ts`, `push.ts`). Verified live in-browser.
- **M8** Universal receipt ingest + auto-split — **DONE** (`src/core/receipts.ts`, `audit.ts`, `buildSplitChargeEntry`, `ClaudeDocumentExtractor`)
- **M9** Autonomous auditor + council + access-requests — **DONE** (`src/core/auditor.ts`, `ClaudeCouncil`)
- **M10** Budgets + realtime guidance + advisory + push — **DONE** (`budgets.ts`, `guidance.ts`, `recommendations.ts`, `push.ts`)
- **M11** Full SMB (AR/AP, payroll, 1099, sales tax) — **DONE** (`src/core/smb.ts`, posting builders, `018_smb_accounts` seed)
- **M12** Cloud multi-tenant — **Supabase PROVISIONED + books migrated as tenant #1 (2026-06-15).** agor-agents Supabase project (ref in `.env`), schema+seeds+RLS applied, data mirrored via `scripts/migrate-to-supabase.sh` (50 tables/2,223 rows/0 mismatches, cloud ledger balances). `ACCT_CLOUD_DB_URL` in `.env`. Netlify deploy + cloud-LLM spend still queued. LOCAL stays the live operational DB (crons + SimpleFIN write there); repoint-to-cloud is the deliberate next step.
- **SimpleFIN LIVE (confirmed 2026-06-15):** 13 real accounts linked + mapped, syncing clean (last sync added 8/modified 313, 0 errors). The original Phase-1 bank-link blocker is RESOLVED — the engine runs on real data.

## State (2026-06-17) — build complete + data importers + tax-optimize
- Repo `arielagor/accounting-agent`, branch `master`, HEAD **`71fd656`**. **211 tests green, tsc --noEmit clean.**
- Local DB: gbrain-pg:5433 db `accounting`, **~50 acct_ tables**. Migrations 007–015 + seeds 018–019 applied (idempotent).
- New deps: `web-push` (free VAPID push). New scripts: `vapid-keys`, `audit`, `advise`, `import-statement`.
- **Since 2026-06-15:**
  - **Apple purchase-history import** (`src/core/apple-history.ts`, migrations 013/014): deterministic parser
    (no LLM — the LLM path 60s-timed-out on 14 years), business/personal/**free** buckets, an LLM auditor that
    sorted the 98 paid review items (27 business / 54 personal / 17 review), and a catalog review UI that
    **teaches the system** (manual choice → learned merchant rule, checked first at 0.99).
  - **Bank-statement importer** (`src/core/statements.ts`, CLI `npm run import-statement`): deterministic
    OFX/QFX + CSV, two-layer dedup against the SimpleFIN feed — the path to deep history because **SimpleFIN
    caps at ~90 days** (start-date does NOT defeat it). File picker + drag-drop wired in the Receipts tab.
  - **Fixed the SimpleFIN 1970-date bug** (`bestTxnSeconds()` transacted_at fallback for `posted=0`).
  - **Tax-optimize uncertain categorizations (2026-06-17, migration 015, `docs/decisions/0004`):** when the
    auditor is genuinely unsure about an otherwise-safe txn it books the most tax-beneficial DEFENSIBLE account
    (`ordinary` > `meals_50` > `capital` > `personal`) among the council's candidates instead of parking it for
    a human. Audit-sensitive accounts (6900 vehicle, 6950 home office) are never auto-picked; the hard gates
    (aggressive deduction, needs-access, large amount, own $2,500 cap) still escalate. Reversible + re-learns
    from any override. Flag `AUDITOR_TAX_OPTIMIZE` (default on; `0` reverts); cap `AUDITOR_TAX_OPTIMIZE_MAX_CENTS`.
    Also fixed `DEFAULT_SENSITIVE` which had referenced non-existent codes (6300/6310).
  - **Apple reviewer lean (2026-06-18, migration 016):** the SAME flag now also makes the Apple catalog
    reviewer (`auditAppleReview`) lean genuine toss-ups to BUSINESS (deductible) instead of parking them
    in 'review' — clearly-personal stays personal; leaned items are flagged `auto_leaned`, surfaced under
    "Auto-leaned to business — confirm or flip" in the Apple tab, and DON'T learn a merchant rule until a
    human confirms. `auditAppleReview` is now wired to a "Run Apple auditor" button via
    `POST /api/apple/audit` (previously ad-hoc only).
  - **Rebase on the two socratic answers (2026-06-23/24, migration 017, docs/decisions/0005):**
    (1) **Type-I aversion** — `pickTaxOptimal.beatNonDeductible` + `AUDITOR_TAX_LEAN_FLOOR` (default 0.6):
    a low-confidence deduction that beat a personal option is LEFT for a human, not auto-claimed (tax errors
    are asymmetric). Lean stays free for business-vs-business or when conf >= floor. Tally
    `taxDeferredConservative`. (2) **Aggregate sign-off** — `agentPositions()` + `GET /api/positions` +
    confirm/flip; the "Needs you" tab lists every tax-optimized post + Apple leaned item with deductible
    impact so the owner approves the PORTFOLIO before filing; `confirmed_at` drops a confirmed item.
    (3) **Owner translation layer** — Overview leads with Cash on hand (+runway) / Profit / Taxes-to-set-aside
    + a "Synced from N accounts" trust line; relabeled all engine jargon (P&L->Profit, COGS->Cost of goods,
    AR/AP aging->Money owed to you / Bills you owe, posted->done, tie-out->"books need a check", chart codes
    dropped from the surface); tabs renamed (Apple purchases / Invoices & bills / Needs you). Verified live
    in-browser, no console errors. Deferred: a deep IA restructure (Money/Spending/Get-paid/To-do).
- **Verified live:** web app renders + tab-switches in-browser; tax-optimize proven by DB-backed tests that post
  to the real ledger + exercise every guard; `npm run advise` generated 13 grounded recommendations on real books.

## What Ariel can do right now
- `npm run dashboard` → open the web app (token in URL #fragment when bound to 0.0.0.0). 7 tabs: Overview,
  Transactions (inline edit/recategorize), Budgets, Advisor, Receipts, Business, Review (auditor + grant-access).
- `npm run vapid-keys` → paste the 3 lines into `.env`, restart → tap "Alerts" in the app to get phone push.
- `npm run advise` (schedulable) → budget alerts + fresh recommendations. `npm run audit` (CLOSE_MODE≥draft) →
  auditor pass; with `AUDITOR_TAX_OPTIMIZE=1` (default) it tax-optimizes unsure items instead of parking them.
  The "Run auditor" button in the Review tab does the same and reports the tax-optimized count.
- `npm run import-statement -- --file <ofx|qfx|csv> --account <id|ledgerCode|mask|name> [--flip] [--map ...]`
  → load years of history per account (deduped against SimpleFIN). Or use the Receipts tab's Import panel.
- Install the PWA on the phone (Add to Home Screen) for the realtime budget assistant.

## Conventions (match these)
- TS ESM NodeNext: import sibling `.ts` as `.js`. Money = integer cents (BIGINT). `tenant_id` on every table.
- All postings go through `ledger.postEntry()` (balanced trigger + idempotency). Direction lives ONLY in `posting.ts`.
- `postEntry` opens its own tx → DON'T nest it inside `sql.begin` (porsager `tx` has no `.begin`); sequence
  idempotent steps instead (see `resolve.ts` / `receipts.ts splitCharge`).
- LLM via `spawnClaudeRunner` (ANTHROPIC_API_KEY stripped = $0 Max plan; `--model claude-opus-4-8` fallback;
  `extractJson` first-balanced-object). Cloud serverless is the ONLY sanctioned `ANTHROPIC_API_KEY` path (flagged).
- DB-backed tests: dedicated tenant, skip if no DB, clean before+after. Run `npx tsc --noEmit` before every commit.

## One-way doors queued for Ariel (do NOT do unsupervised)
- Linking real bank/card accounts; flipping CLOSE_MODE to live on real books; creating the Supabase project;
  enabling the cloud ANTHROPIC_API_KEY spend; any deploy to app.agor.me; merging the agor-agents SKU PR;
  granting access-requests; approving aggressive deductions; entity-type changes; any real money movement.

## Next step (when cloud is authorized)
The single-tenant product is complete. The remaining work is the cloud path, all gated on the one-way doors
above. First task when provisioning is authorized: **tenant-scope the 7 reference tables**
(chart/projects/categorization_rules/merchant_rules/allocation_rules/allocation_targets/tax_rates) — add
`tenant_id`, backfill 'ariel', seed-per-tenant at onboarding, and filter the engine reads that join them
(`ledger.accountIdByCode`/`projectIdBySlug`, `categorize`, `allocate`, `tax/rates`, `reports`). Keep the
187 single-tenant tests green throughout. Then create Supabase, apply `sql/` + `supabase/migrations/0001_rls.sql`,
migrate Ariel's rows in as encrypted tenant #1, deploy the Netlify scheduled functions, and ship. Full detail in
`docs/decisions/0003-cloud-multitenancy.md`.
