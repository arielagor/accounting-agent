/**
 * Email the close digest + PDF + spreadsheet (surface 3 of 3). Renders the digest
 * text (no em-dashes), generates the close PDF, attaches the period's .xlsx if
 * present, and sends via the configured Gmail SMTP. --dry writes the PDF locally
 * and prints the digest instead of sending.
 *
 * Usage: node --import tsx bin/send-digest.ts [--period YYYY-MM] [--dry]
 */
import nodemailer from "nodemailer";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { getDashboardData } from "../src/lib/dashboard-data.js";
import { computeVerdict } from "../src/core/verify.js";
import { renderDigest } from "../src/lib/digest.js";
import { buildClosePdf } from "../src/lib/pdf.js";
import { formatUsd } from "../src/core/money.js";
import { log, warn, error } from "../src/lib/log.js";
import type { DigestModel, EscalationItem } from "../src/core/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const tenant = env.TENANT_ID ?? "ariel";
  const period = arg("--period") ?? new Date().toISOString().slice(0, 7);
  const sql = openSql(url);

  try {
    const data = await getDashboardData(sql, tenant, period, new Date().toISOString());
    const verdict = await computeVerdict(sql, tenant, period);

    const needsDecision: EscalationItem[] = data.quarantine.slice(0, 25).map((q) => ({
      priority: "P2",
      title: `Categorize: ${q.merchant}`,
      detail: `${formatUsd(q.amountCents)} on ${q.date ?? "?"} (${q.reason})`,
      replyHint: `CATEGORIZE ${q.sourceTxnId} <accountCode>`,
    }));
    const model: DigestModel = {
      period,
      verdict,
      needsDecision,
      fyi: [],
      reportRefs: ["close.pdf", `books-${period}.xlsx`],
    };
    const { subject, text } = renderDigest(model);

    const pdf = await buildClosePdf(data);
    const xlsxPath = join(root, "exports", `books-${period}.xlsx`);
    const attachments: { filename: string; content?: Buffer; path?: string }[] = [
      { filename: `close-${period}.pdf`, content: pdf },
    ];
    if (existsSync(xlsxPath)) attachments.push({ filename: `books-${period}.xlsx`, path: xlsxPath });

    if (dry) {
      const out = join(root, "exports", `close-${period}.pdf`);
      writeFileSync(out, pdf);
      log(`[dry] subject: ${subject}`);
      log(`[dry] wrote ${out}; would attach: ${attachments.map((a) => a.filename).join(", ")}`);
      log(`[dry] body:\n${text}`);
      return;
    }

    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
      warn("SMTP not configured; cannot send. Run with --dry to preview.");
      return;
    }
    const portNum = Number(env.SMTP_PORT ?? 465);
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: portNum,
      secure: portNum === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    const from = env.SMTP_USER; // authenticated sender (most reliable with Gmail)
    const to = env.DIGEST_TO ?? env.SMTP_USER;
    const info = await transport.sendMail({ from, to, subject, text, attachments });
    log(`digest sent to ${to}: ${info.accepted?.length ? "accepted" : "not accepted"} (id ${info.messageId})`);
  } catch (e) {
    error("send-digest failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  error("send-digest fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
