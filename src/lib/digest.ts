/**
 * Escalation digest: render the month-end close into a plain-text email, then
 * send it. This is the single human-facing surface of the close engine, so the
 * RENDER half is a pure function (testable with zero IO) and the SEND half is a
 * thin transport wrapper around the shared mail-core send path.
 *
 * HARD STYLE RULE (Ariel): the rendered email text must contain ZERO em-dash
 * characters. Em-dashes read as machine-written in his outbound mail, so every
 * separator here is a colon, a hyphen, a period, or parentheses. The unit test
 * asserts the rendered text never includes the em-dash code point.
 */

import { send as mailCoreSend, envDryRun } from "./mailCore.js";
import type {
  DigestModel,
  EscalationItem,
  EscalationPriority,
} from "../core/types.js";
import { formatUsd } from "../core/money.js";
import { warn } from "./log.js";

/** Priority order for the "needs your decision" list: most urgent first. */
const PRIORITY_ORDER: EscalationPriority[] = ["P0", "P1", "P2", "P3"];

/**
 * Render a digest model into an email subject + plain-text body. PURE: no IO,
 * deterministic for a given model. The body is built as a list of lines and
 * joined, so the structure stays easy to read and easy to assert in tests.
 *
 * Sections, in order:
 *   1. Header line: "MONTH-END CLOSE: <period> - <verdict status>"
 *   2. Books-balanced line with debit = credit totals (formatUsd).
 *   3. Posted / quarantined counts (with quarantine value in formatUsd).
 *   4. NEEDS YOUR DECISION: needsDecision items, ordered P0..P3.
 *   5. FYI: lower-stakes items.
 *   6. REPORTS: the report references produced this run.
 */
export function renderDigest(model: DigestModel): { subject: string; text: string } {
  const v = model.verdict;
  // Subject leads with the verdict status so an inbox scan answers "did it
  // close clean?" without opening. Hyphen separators only, never em-dashes.
  const subject = `Month-end close ${model.period}: ${v.status}`;

  const lines: string[] = [];

  // 1. Header. The label uses a colon, not an em-dash (Ariel rule).
  lines.push(`MONTH-END CLOSE: ${model.period} - ${v.status}`);
  lines.push("");

  // 2. Balance proof: the debits = credits identity is the core integrity claim.
  const balancedWord = v.balanced ? "YES" : "NO";
  lines.push(
    `Books balanced: ${balancedWord}  Debits ${formatUsd(v.debitsCents)} = Credits ${formatUsd(
      v.creditsCents,
    )}`,
  );

  // 3. Throughput: how much posted cleanly vs landed in the quarantine.
  lines.push(
    `Posted: ${v.postedCount}  Quarantined: ${v.quarantineCount} (${formatUsd(
      v.quarantineValueCents,
    )})`,
  );

  // A failed close carries a reason; surface it right under the headline numbers.
  if (v.failureReason) {
    lines.push(`Failure reason: ${v.failureReason}`);
  }

  // 4. NEEDS YOUR DECISION: the items that block or want a human reply. Sorted
  // by priority (P0 first) so the most urgent ask is read first.
  lines.push("");
  lines.push("NEEDS YOUR DECISION");
  if (model.needsDecision.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of sortByPriority(model.needsDecision)) {
      appendItem(lines, item);
    }
  }

  // 5. FYI: context that does not need a reply. Same priority ordering.
  lines.push("");
  lines.push("FYI");
  if (model.fyi.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of sortByPriority(model.fyi)) {
      appendItem(lines, item);
    }
  }

  // 6. REPORTS: the artifact references (file paths / ids) produced this close.
  lines.push("");
  lines.push("REPORTS");
  if (model.reportRefs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const ref of model.reportRefs) {
      lines.push(`  - ${ref}`);
    }
  }

  // Optional free-text narrative closes the email when present.
  if (model.narrative && model.narrative.trim().length > 0) {
    lines.push("");
    lines.push(model.narrative.trim());
  }

  // Defensive scrub: even if a caller-supplied title/detail/narrative smuggled
  // in an em-dash, normalize it to a hyphen so the no-em-dash invariant holds
  // for the WHOLE body, not just the parts this module wrote.
  const text = stripEmDashes(lines.join("\n"));
  return { subject: stripEmDashes(subject), text };
}

/** Stable priority sort: P0..P3, preserving input order within a priority. */
function sortByPriority(items: EscalationItem[]): EscalationItem[] {
  const rank = (p: EscalationPriority): number => {
    const i = PRIORITY_ORDER.indexOf(p);
    return i < 0 ? PRIORITY_ORDER.length : i;
  };
  // Decorate-sort-undecorate keeps the sort stable across V8 versions.
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.priority) - rank(b.item.priority) || a.i - b.i)
    .map((x) => x.item);
}

/** Append one escalation item as a titled block with detail and reply hint. */
function appendItem(lines: string[], item: EscalationItem): void {
  lines.push(`  [${item.priority}] ${item.title}`);
  if (item.detail) {
    lines.push(`      ${item.detail}`);
  }
  if (item.replyHint) {
    lines.push(`      Reply: ${item.replyHint}`);
  }
}

/** Replace every em-dash with a hyphen. The body must never contain one. */
function stripEmDashes(s: string): string {
  return s.replace(/—/g, "-");
}

/**
 * The narrow mail port the digest depends on. Defined here (not nodemailer's
 * wide Transporter type) so sendDigest can be unit-tested against a tiny mock
 * with no SMTP, and so callers see exactly the contract that matters.
 */
export interface MailTransport {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    text: string;
    attachments?: { filename: string; content?: Buffer; path?: string }[];
  }): Promise<{ accepted: string[]; messageId?: string | null; decision?: string }>;
}

/** The ledger names this repo sends under (stable: the contact ledger is keyed by them). */
export const MAIL_SYSTEMS = {
  closeDigest: "accounting-agent:close-digest",
  sendDigest: "accounting-agent:send-digest",
  syncEscalation: "accounting-agent:sync-escalation",
} as const;

/**
 * A MailTransport over the shared mail-core send path (one pooled transport per
 * SMTP identity, preSendCheck, contact ledger). Every message this repo sends is
 * internal mail to Ariel himself, so kind 'internal' and lane 'monitor'. The
 * SMTP login is ariel@agor.me (mail-core identity 'agorme'); the From may be an
 * address mail-core does not know as an alias (DIGEST_FROM), so the identity is
 * named explicitly rather than inferred from From. Fields are passed through
 * unchanged, so the mail is byte-identical to the old nodemailer transport.
 * dryRun (or MAIL_CORE_DRYRUN=1) records the ledger row and sends nothing; the
 * result then has no accepted recipients. `ctx` is mail-core's test seam.
 */
export function buildMailCoreTransport(
  system: string,
  opts: { dryRun?: boolean; ctx?: Record<string, unknown> } = {},
): MailTransport {
  const dryRun = opts.dryRun ?? envDryRun();
  return {
    async sendMail(msg) {
      const r = await mailCoreSend(
        {
          system,
          kind: "internal",
          lane: "monitor",
          identity: "agorme",
          dryRun,
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          ...(msg.attachments ? { attachments: msg.attachments } : {}),
        },
        opts.ctx,
      );
      if (!r.sent) {
        if (!dryRun) warn(`mail-core did not send (${r.decision}${r.reason ? `: ${r.reason}` : ""})`);
        return { accepted: [], messageId: null, decision: r.decision };
      }
      const accepted = Array.isArray(r.info?.accepted)
        ? r.info.accepted.map((a) => (typeof a === "object" && a && "address" in a ? String((a as { address: unknown }).address) : String(a)))
        : [];
      return { accepted, messageId: r.messageId, decision: r.decision };
    },
  };
}

/**
 * Render the model and send it. Returns true when the transport accepted at
 * least one recipient. SECONDARY GUARANTEE: this never throws. A send failure
 * (SMTP down, auth rejected, network) is logged via warn() and reported as a
 * false return, because a broken email must not crash the close run itself.
 */
export async function sendDigest(
  transport: MailTransport,
  from: string,
  to: string,
  model: DigestModel,
): Promise<boolean> {
  const { subject, text } = renderDigest(model);
  try {
    const result = await transport.sendMail({ from, to, subject, text });
    return result.accepted.length > 0;
  } catch (err) {
    // Fail-soft: the digest is a notification, not a ledger write. Log and move on.
    warn("sendDigest failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
