// Read a recent message from the ariel@agor.me inbox over IMAP (Gmail app password
// from agor.me/.env.local) and pull out a sign-in link or a one-time code.
// Used to re-authenticate SimpleFIN Bridge (email magic link) and the banks behind
// it (e.g. Marcus emails an OTP) on Ariel's behalf.
//
//   node scripts/agorme-mail.mjs link "from:simplefin" [--mins 60]
//   node scripts/agorme-mail.mjs otp  "from:marcus"    [--mins 15]
//
// Prints JSON {subject, date, from, value}. The value is single-use and short-lived.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [mode, query = "", ...rest] = process.argv.slice(2);
const minsIdx = rest.indexOf("--mins");
const mins = minsIdx >= 0 ? Number(rest[minsIdx + 1]) : 60;
if (!["link", "otp", "show"].includes(mode)) {
  console.error('usage: agorme-mail.mjs link|otp|show "<gmail query>" [--mins N]');
  process.exit(1);
}

const envFile = path.join(os.homedir(), ".claude", "projects", "agor.me", ".env.local");
const env = {};
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const client = new ImapFlow({
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  logger: false,
});
client.on("error", (err) => console.error(`imap error (handled): ${String(err).slice(0, 200)}`));
await client.connect();

const lock = await client.getMailboxLock("[Gmail]/All Mail");
let out = null;
try {
  const since = new Date(Date.now() - mins * 60 * 1000);
  const uids = await client.search({ gmraw: `${query} newer_than:1d` }, { uid: true });
  for (const uid of (uids || []).slice().reverse()) {
    const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
    if (!msg || new Date(msg.internalDate) < since) continue;
    const p = await simpleParser(msg.source);
    const text = `${p.subject ?? ""}\n${p.text ?? ""}\n${typeof p.html === "string" ? p.html : ""}`;
    let value = null;
    if (mode === "link") {
      const urls = (p.html && typeof p.html === "string" ? p.html : text).match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
      value =
        urls.map((u) => u.replace(/&amp;/g, "&")).find((u) => /login|sign-?in|verify|auth|token|magic/i.test(u)) ?? null;
    } else if (mode === "otp") {
      const m = (p.text ?? text).match(/(?<![\d#])(\d{6,8})(?!\d)/);
      value = m ? m[1] : null;
    } else {
      value = (p.text ?? "").slice(0, 1500);
    }
    out = { subject: p.subject, date: msg.internalDate, from: p.from?.text, value };
    if (value) break;
  }
} finally {
  lock.release();
  await client.logout();
}
if (!out) {
  console.log(JSON.stringify({ error: `no message matching "${query}" in the last ${mins} min` }));
  process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
