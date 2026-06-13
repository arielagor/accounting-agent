# 0002 — Finance plugin methodology harvested into the close pipeline

Date: 2026-06-13
Status: accepted

## Context

Ariel asked to "reactivate the finance skills and plugins." The
`claude-for-financial-services` marketplace is installed (month-end-closer,
gl-reconciler, statement-auditor, financial-analysis, model-builder,
wealth-management, and more). Investigation found:

- The finance plugins are installed; their **skills/agents** carry professional
  methodology we can use directly.
- Their bundled **external data-provider MCP servers** (aiera, daloopa, factset,
  lseg, moody's, morningstar, S&P Global, ...) are listed in the project's
  `disabledMcpServers` (11 entries). These require **paid third-party
  subscriptions** Ariel does not hold. Enabling them would violate the cost rule
  and fail without credentials, so they stay disabled.

## Decision

"Reactivate the finance skills" = **harvest and bake the methodology into the
build**, not enable paid data feeds. The following professional patterns were
read from the plugins and folded into the close pipeline:

| Source skill | Folded into |
| --- | --- |
| `month-end-closer` agent | The close package definition (accruals + roll-forwards + variance commentary + sign-off staging) and the rule **"drafts JEs; no posting without approval"** → our accruals/adjustments stay draft-for-approval even in live mode. |
| `accrual-schedule` | The `accrue-adjust` stage: per-accrual basis × period-portion − already-booked = this-period accrual; draft `Dr expense / Cr accrued liability`; auto-reversing memo. **Drafts, escalated for sign-off — never auto-posted.** |
| `roll-forward` | A roll-forward report per balance-sheet account: beginning + activity − reversals ± reclass = ending; **it must foot** — an unexplained gap is surfaced, never plugged. |
| `variance-commentary` | The `anomaly-scan` stage + the LLM narrative: flux every P&L/BS line over a materiality threshold (default 5% or a floor), always-comment list (revenue, cash); the driver explains *why*, and if unclear we write **"driver unclear — flag for controller"** rather than invent one (matches our adversarial narrative audit). |
| `gl-recon` | Reconciliation break buckets (matched / amount / quantity / timing / GL-only / subledger-only), a likely-cause hypothesis per break, and a **matched %** in the recon report. |

## Consequence

The close is a **controller-grade close package**, and the most judgment-laden
entries (accruals/adjustments) are always draft-for-approval — which both
satisfies the professional standard and aligns with our "escalate on doubt"
posture even though Ariel set the routine close to full-auto live.

The disabled paid finance MCP feeds remain disabled; if Ariel later subscribes to
one (e.g. for market data in the advisor), it can be enabled per-project then.
