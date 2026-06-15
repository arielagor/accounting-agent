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

## Milestones
- **M7** Continuous ledger + web dashboard manual edits — _pending (web app)_
- **M8** Universal receipt ingest + auto-split — **DONE** (engine + tests)
- **M9** Autonomous auditor + council + access-requests — _next (engine)_
- **M10** Budgets + realtime advisory + push — _pending_
- **M11** Full SMB — _pending_
- **M12** Cloud multi-tenant (Supabase RLS + migrate + Netlify functions) — _pending (one-way doors queued)_

## State (2026-06-15)
- Repo `arielagor/accounting-agent`, branch `master`. Baseline pre-build: 149 tests. Now **155 tests, tsc clean**.
- Local DB: gbrain-pg:5433 db `accounting`, 28→33 acct_ tables, 323 raw txns, 152 journal entries, 175 open review.
- **Migrations added & applied:** `sql/007_documents.sql`, `008_budgets.sql`, `009_advisory.sql`,
  `010_smb.sql`, `011_auditor.sql` (all additive; `npm run migrate` is idempotent).
- **M8 engine built:** `src/core/receipts.ts` (ingest→extract→match→split), `src/core/audit.ts`
  (logAudit + requestAccess + hasAccess), `buildSplitChargeEntry` in `src/core/posting.ts`,
  `ClaudeDocumentExtractor` in `src/lib/llm.ts`, document types in `src/core/types.ts`.
  Proven: a forwarded Apple receipt splits the aggregate APPLE.COM/BILL charge into components that
  tie to the cent and clears the quarantine; an unmatchable receipt → 'unmatched' + access-request.

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

## Next step
Build M9 auditor engine (`src/core/auditor.ts`) wrapping `categorize.ts`: confident → auto-post; doubtful →
council escalation; missing data → research agent files an access-request. Write `acct_auditor_decisions` +
`acct_audit_log` on every decision. Then M10 budgets/advisory, M11 SMB, then the web app (M7) + cloud (M12).
