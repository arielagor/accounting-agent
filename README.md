# Accounting Agent

An autonomous accounting agent for a solo founder's portfolio. It links to bank/card
accounts **read-only**, keeps a proper double-entry ledger, categorizes spending for taxes,
allocates shared costs per-project, and runs an **unsupervised month-end close that always
completes** — and it ships as a multi-tenant SKU on the Agor Agents platform (`app.agor.me`).

> **"Always completes" has a precise meaning:** every transaction reaches a terminal
> disposition — *posted-with-confidence* or *quarantined-for-review* — and the trial balance
> balances to the cent. The agent never invents data to fake 100% automation. A close that
> quarantines 3 ambiguous items and escalates them is a **successful** close.

## The accountant

The agent reasons as **Hank Calloway, CPA** — a creative, fiscally-conservative, relentlessly
pro-taxpayer accountant. Creed: *"Pay every dollar you owe and not one dollar more."* He works
every **legal** angle for the client's benefit (entity election, QBI, §179, home office, Augusta
rule, accountable plans, retirement deferral, income timing), is aggressive on deductions and
conservative on documentation, and never crosses a red line (no fabricated expenses, no
unreported income, substance over form, every position audit-defensible). Genuinely aggressive
positions are surfaced **with their risk** and routed to a human CPA for sign-off — never silently
taken. See `src/core/persona.ts`.

## Money posture (non-negotiable)

The agent is **structurally incapable of moving money.** The aggregation provider interface has
no transfer/pay/move verb; SimpleFIN is read-only by construction; the only outward actions are
sending email and writing to its own database. It does bookkeeping, estimation, and an organized
CPA hand-off — it does **not** file returns, auto-pay the IRS/FTB, or give licensed tax advice.

## Architecture

```
SimpleFIN (read-only) ─┐
Stripe (read-only)    ─┴▶ ingest → reconcile → categorize → allocate → ledger → tax
                                   (rules → learned → LLM, escalate on doubt)
                          │
                          ▼ unsupervised month-end close (off → draft → live)
                  precheck → sync-cutoff → ingest → categorize → allocate → reconcile →
                  accrue-adjust → trial-balance → anomaly-scan → reports → archive-lock → notify
```

- **Money:** always integer cents (`src/core/money.ts`). No floats in the ledger, ever.
- **Store:** a separate `accounting` database on the existing `gbrain-pg` Postgres (localhost:5433).
- **LLM:** Claude Max via `claude -p` ($0; `ANTHROPIC_API_KEY` stripped from the spawn env). Used
  for categorization fallback and advisory narrative only — never to compute a number that posts.
- **Autonomy ladder** (`.env` `CLOSE_MODE`): `off` (inert) → `draft` (compute + email for approval,
  no posting) → `live` (post + lock; ambiguous items still escalate, never guessed).

## Setup

```bash
npm install
cp .env.example .env          # fill INTEGRATION_ENC_KEY (openssl rand -hex 32), SMTP_*, etc.
# Create the database (once):
docker exec gbrain-pg psql -U postgres -c "CREATE DATABASE accounting;"
npm run migrate               # apply schema + seeds (idempotent)
npm run typecheck             # tsc --noEmit
npm test                      # unit + close eval-scenario tests
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run migrate` | Apply schema + seeds (idempotent, tracked in `acct_migrations`). |
| `npm run link` | One-time interactive SimpleFIN link; `--reconnect <id>` to re-auth. |
| `npm run sync` | Nightly read-only transaction sync + reconciliation (node-locked). |
| `npm run close -- --mode=incremental` | Daily pre-close (categorize/allocate/reconcile, surface exceptions). |
| `npm run close -- --mode=close` | Month-end close (the full ladder, verdict, lock, digest). |

## What's queued for a human (one-way doors)

1. **Linking real accounts** — SimpleFIN needs your credentials at the bridge; run `npm run link`.
2. **Flipping `CLOSE_MODE=live`** on real books — first real close runs in `draft` for review.
3. **Merging the Agor Agents PR / deploying** the multi-tenant SKU — draft PR, your call.
4. **Any spend beyond ~$15/yr SimpleFIN.**

## Layout

- `src/core/` — the portable engine: `money`, `types`, `persona`, `ledger`, `categorize`,
  `allocate`, `reconcile`, `close`, `verify`, and `tax/` (the modular entity strategies).
- `src/providers/` — `provider` interface (no money-movement verb) + `simplefin`, `plaid`.
- `src/lib/` — `env`, `db` (re-exported), `token-store`, `lock`, `log`, `digest`, `resolutions`, `llm`.
- `bin/` — `migrate`, `link`, `sync`, `close-agent`.
- `sql/` — schema (`001`–`006`) + `seed/` (chart, projects, rules, allocation, tax rates).

This is bookkeeping software, not licensed tax advice. Every tax output is reviewed by a CPA before filing.
