import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderDigest,
  sendDigest,
  type MailTransport,
} from "../src/lib/digest.js";
import type { DigestModel } from "../src/core/types.js";
import { formatUsd } from "../src/core/money.js";

/** A representative model: balanced-with-exceptions, mixed-priority items. */
function sampleModel(): DigestModel {
  return {
    period: "2026-05",
    verdict: {
      period: "2026-05",
      status: "CLEAN_WITH_EXCEPTIONS",
      balanced: true,
      debitsCents: 1234567,
      creditsCents: 1234567,
      postedCount: 42,
      quarantineCount: 3,
      quarantineValueCents: 98765,
      warnings: ["3 transactions quarantined"],
    },
    needsDecision: [
      {
        priority: "P2",
        title: "Confirm Adobe split is 80 percent business",
        detail: "Recurring charge, mixed personal use last month.",
        replyHint: "Y to confirm 80, or send a percent.",
      },
      {
        priority: "P0",
        title: "Bank connection needs re-login",
        detail: "Chase login_required, sync halted at cutoff.",
      },
    ],
    fyi: [
      {
        priority: "P3",
        title: "Stripe payout reconciled automatically",
        detail: "Net of fees, no action needed.",
      },
    ],
    reportRefs: ["reports/2026-05/pnl.csv", "reports/2026-05/schedule-c.csv"],
  };
}

test("renderDigest contains NO em-dash character", () => {
  const { subject, text } = renderDigest(sampleModel());
  assert.equal(text.includes("—"), false, "body must not contain an em-dash");
  assert.equal(text.includes("—"), false, "body must not contain an em-dash");
  assert.equal(subject.includes("—"), false, "subject must not contain an em-dash");
});

test("renderDigest scrubs em-dashes smuggled in via item fields", () => {
  const model = sampleModel();
  model.needsDecision[0]!.title = "Confirm — the — split";
  model.narrative = "All good — closing now.";
  const { text } = renderDigest(model);
  assert.equal(text.includes("—"), false, "smuggled em-dashes must be normalized out");
});

test("renderDigest shows the verdict status and balanced totals", () => {
  const model = sampleModel();
  const { text } = renderDigest(model);
  assert.match(text, /CLEAN_WITH_EXCEPTIONS/);
  assert.match(text, /Books balanced: YES/);
  // The exact formatUsd totals appear on the balance line.
  assert.ok(text.includes(formatUsd(model.verdict.debitsCents)));
  assert.ok(text.includes(formatUsd(model.verdict.creditsCents)));
});

test("renderDigest lists a P2 item title under NEEDS YOUR DECISION", () => {
  const { text } = renderDigest(sampleModel());
  assert.ok(text.includes("NEEDS YOUR DECISION"));
  assert.ok(text.includes("[P2] Confirm Adobe split is 80 percent business"));
});

test("renderDigest orders needs-decision items P0 before P2", () => {
  const { text } = renderDigest(sampleModel());
  const p0 = text.indexOf("[P0]");
  const p2 = text.indexOf("[P2]");
  assert.ok(p0 >= 0 && p2 >= 0);
  assert.ok(p0 < p2, "P0 must be rendered before P2");
});

test("renderDigest shows posted/quarantined counts with quarantine value", () => {
  const model = sampleModel();
  const { text } = renderDigest(model);
  assert.ok(text.includes("Posted: 42"));
  assert.ok(text.includes("Quarantined: 3"));
  assert.ok(text.includes(formatUsd(model.verdict.quarantineValueCents)));
});

test("renderDigest lists report references", () => {
  const { text } = renderDigest(sampleModel());
  assert.ok(text.includes("reports/2026-05/pnl.csv"));
  assert.ok(text.includes("reports/2026-05/schedule-c.csv"));
});

test("renderDigest surfaces a failure reason when the close FAILED", () => {
  const model = sampleModel();
  model.verdict.status = "FAILED";
  model.verdict.balanced = false;
  model.verdict.failureReason = "Trial balance off by 12 cents";
  const { text } = renderDigest(model);
  assert.match(text, /FAILED/);
  assert.match(text, /Books balanced: NO/);
  assert.ok(text.includes("Failure reason: Trial balance off by 12 cents"));
});

test("sendDigest returns true and the mock receives subject + text", async () => {
  let captured: { from: string; to: string; subject: string; text: string } | null = null;
  const mock: MailTransport = {
    async sendMail(opts) {
      captured = opts;
      return { accepted: [opts.to] };
    },
  };
  const ok = await sendDigest(mock, "engine@books.local", "ariel@example.com", sampleModel());
  assert.equal(ok, true);
  assert.ok(captured !== null, "mock should have been called");
  const sent = captured as { from: string; to: string; subject: string; text: string };
  assert.equal(sent.from, "engine@books.local");
  assert.equal(sent.to, "ariel@example.com");
  assert.ok(sent.subject.includes("CLEAN_WITH_EXCEPTIONS"));
  assert.ok(sent.text.includes("NEEDS YOUR DECISION"));
});

test("sendDigest returns false when accepted is empty", async () => {
  const mock: MailTransport = {
    async sendMail() {
      return { accepted: [] };
    },
  };
  const ok = await sendDigest(mock, "engine@books.local", "ariel@example.com", sampleModel());
  assert.equal(ok, false);
});

test("sendDigest returns false (never throws) when the transport throws", async () => {
  const mock: MailTransport = {
    async sendMail() {
      throw new Error("SMTP connection refused");
    },
  };
  const ok = await sendDigest(mock, "engine@books.local", "ariel@example.com", sampleModel());
  assert.equal(ok, false);
});
