// mail-core shim (from ~/.claude/docs/mail-core-shim.ts). Every local send in this repo goes through
// send() here instead of building its own nodemailer transport, so each digest and escalation lands
// in the shared contact ledger (~/.claude/state/mail/contact-ledger.jsonl) next to every other system.
// mail-core lives outside the repo, in ~/.claude/scripts/lib/mail-core.mjs, so it is loaded by
// absolute path at runtime (a dynamic import keeps tsc from trying to resolve it).
//
// Mode: MAIL_CORE_MODE=shadow (default) logs would-hold decisions and sends anyway; enforce holds.
// MAIL_CORE_DRYRUN=1 records the row and sends nothing. The repo's own gates (SMTP configured,
// close mode off, --dry) stay in the callers and are checked before send(), exactly as before.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Address = string | { name: string; address: string };

export interface MailCoreSendOptions {
  /** Ledger name of the calling system, e.g. 'accounting-agent:close-digest'. Required. */
  system: string;
  /** reply | order-question | transactional | invoice | receipt | correction | nudge | winback | followup | cold | outreach | internal */
  kind?: string;
  lane?: "cold" | "reply" | "monitor";
  orderId?: string;
  /** Required with kind 'correction' inside the cool-down. */
  reason?: string;
  dryRun?: boolean;
  identity?: string;
  thread?: { messageId?: string; references?: string | string[]; key?: string };
  // nodemailer message fields, passed through unchanged:
  from: Address;
  to: Address | Address[];
  cc?: Address | Address[];
  bcc?: Address | Address[];
  replyTo?: Address;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string | string[];
  headers?: Record<string, string>;
  attachments?: unknown[];
  messageId?: string;
}

export interface MailCoreResult {
  ok: boolean;
  sent: boolean;
  decision: string;
  reason: string | null;
  holds: { rule: string; reason: string }[];
  messageId: string | null;
  info: { accepted?: unknown[]; messageId?: string; response?: string } | null;
  row: Record<string, unknown>;
}

interface MailCore {
  send(opts: MailCoreSendOptions, ctx?: Record<string, unknown>): Promise<MailCoreResult>;
  readLedger(filter?: Record<string, unknown>, ctx?: Record<string, unknown>): Record<string, unknown>[];
  closeAll(): void;
}

export const MAIL_CORE_PATH =
  process.env.MAIL_CORE_PATH || path.join(os.homedir(), ".claude", "scripts", "lib", "mail-core.mjs");

let core: Promise<MailCore> | null = null;
export function mailCore(): Promise<MailCore> {
  core ??= import(pathToFileURL(MAIL_CORE_PATH).href) as Promise<MailCore>;
  return core;
}

/** MAIL_CORE_DRYRUN=1 (or true/yes): record the decision, send nothing. */
export function envDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(String(env.MAIL_CORE_DRYRUN ?? "").trim());
}

export async function send(opts: MailCoreSendOptions, ctx?: Record<string, unknown>): Promise<MailCoreResult> {
  return (await mailCore()).send(opts, ctx);
}
