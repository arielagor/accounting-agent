/**
 * The mail-core call site: every digest and escalation goes through the shared
 * send path, lands in the contact ledger under this repo's system name, and
 * reaches SMTP with exactly the fields the old nodemailer transport sent.
 * No SMTP: mail-core's ctx.transportFor seam captures the message, and the
 * ledger and locks live in a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMailCoreTransport, MAIL_SYSTEMS, sendDigest } from "../src/lib/digest.js";
import { envDryRun } from "../src/lib/mailCore.js";
import type { DigestModel } from "../src/core/types.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "acct-mailcore-"));
  const ledger = join(dir, "contact-ledger.jsonl");
  const sent: Record<string, unknown>[] = [];
  const ctx = {
    env: { MAIL_CORE_LEDGER: ledger, MAIL_CORE_LOCK_DIR: join(dir, "locks"), MAIL_CORE_MODE: "shadow" },
    halt: { present: false },
    transportFor: () => ({
      async sendMail(msg: Record<string, unknown>) {
        sent.push(msg);
        return { accepted: [String(msg.to)], messageId: "<test-1@agor.me>", response: "250 OK" };
      },
    }),
  };
  const rows = () =>
    existsSync(ledger)
      ? readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { ctx, sent, rows };
}

const model: DigestModel = {
  period: "2026-10",
  verdict: {
    status: "CLEAN",
    balanced: true,
    debitsCents: 100,
    creditsCents: 100,
    postedCount: 1,
    quarantineCount: 0,
    quarantineValueCents: 0,
  } as DigestModel["verdict"],
  needsDecision: [],
  fyi: [],
  reportRefs: [],
};

test("close digest goes through mail-core with the old fields only and a ledger row", async () => {
  const h = harness();
  const t = buildMailCoreTransport(MAIL_SYSTEMS.closeDigest, { dryRun: false, ctx: h.ctx });
  const ok = await sendDigest(t, "claude@mvat.ai", "seed@example.com", model);
  assert.equal(ok, true);
  assert.equal(h.sent.length, 1);
  const msg = h.sent[0]!;
  assert.deepEqual(Object.keys(msg).sort(), ["from", "subject", "text", "to"]);
  assert.equal(msg.from, "claude@mvat.ai");
  assert.equal(msg.to, "seed@example.com");
  assert.equal(msg.subject, "Month-end close 2026-10: CLEAN");
  const [row] = h.rows();
  assert.equal(row?.system, "accounting-agent:close-digest");
  assert.equal(row?.identity, "agorme");
  assert.equal(row?.kind, "internal");
  assert.equal(row?.lane, "monitor");
  assert.equal(row?.sent, true);
  assert.equal(row?.messageId, "<test-1@agor.me>");
});

test("send-digest attachments pass through unchanged", async () => {
  const h = harness();
  const t = buildMailCoreTransport(MAIL_SYSTEMS.sendDigest, { dryRun: false, ctx: h.ctx });
  const attachments = [{ filename: "close-2026-10.pdf", content: Buffer.from("%PDF") }];
  const r = await t.sendMail({ from: "ariel@agor.me", to: "seed@example.com", subject: "s", text: "b", attachments });
  assert.deepEqual(r.accepted, ["seed@example.com"]);
  assert.equal(h.sent[0]?.attachments, attachments);
  assert.equal(h.rows()[0]?.system, "accounting-agent:send-digest");
});

test("dry run records the row and sends nothing", async () => {
  const h = harness();
  const t = buildMailCoreTransport(MAIL_SYSTEMS.syncEscalation, { dryRun: true, ctx: h.ctx });
  const r = await t.sendMail({ from: "claude@mvat.ai", to: "seed@example.com", subject: "s", text: "b" });
  assert.deepEqual(r.accepted, []);
  assert.equal(h.sent.length, 0);
  const [row] = h.rows();
  assert.equal(row?.system, "accounting-agent:sync-escalation");
  assert.equal(row?.sent, false);
  assert.equal(row?.dryRun, true);
});

test("MAIL_CORE_DRYRUN env parsing", () => {
  assert.equal(envDryRun({ MAIL_CORE_DRYRUN: "1" }), true);
  assert.equal(envDryRun({ MAIL_CORE_DRYRUN: "true" }), true);
  assert.equal(envDryRun({}), false);
  assert.equal(envDryRun({ MAIL_CORE_DRYRUN: "0" }), false);
});
