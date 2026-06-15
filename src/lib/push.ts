/**
 * Web Push (VAPID) — the realtime delivery channel for the budget assistant and
 * auditor escalations. The VAPID keypair lives in env (VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY / VAPID_SUBJECT), generated once via `npm run vapid-keys`; the
 * keys never touch the DB. WebPushNotifier implements the BudgetNotifier seam so
 * budgets.checkAlerts() can dispatch to every subscribed device. Free + self-hosted
 * (no paid push service) per the cost rule. A dead subscription (404/410) is pruned.
 */
import webpush from "web-push";
import type { Sql } from "../core/db.js";
import type { BudgetNotifier, BudgetAlertPayload } from "../core/budgets.js";
import { log, warn } from "./log.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string; // a mailto: or https: URL identifying the sender
}

/** Read VAPID config from env; returns null if not configured (push then no-ops). */
export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT ?? "mailto:ariel@agor.me" };
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

/** Persist a browser push subscription (idempotent on endpoint). */
export async function saveSubscription(
  sql: Sql,
  tenantId: string,
  sub: PushSubscriptionInput,
): Promise<void> {
  await sql`
    INSERT INTO acct_push_subscriptions (tenant_id, endpoint, p256dh, auth, user_agent)
    VALUES (${tenantId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth}, ${sub.userAgent ?? null})
    ON CONFLICT (tenant_id, endpoint) DO UPDATE SET
      p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`;
}

interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** Send one push message to every subscription for a tenant; prune dead endpoints. */
export async function sendToTenant(
  sql: Sql,
  tenantId: string,
  vapid: VapidConfig,
  msg: PushMessage,
): Promise<{ sent: number; pruned: number }> {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const subs = await sql<{ id: number; endpoint: string; p256dh: string; auth: string }[]>`
    SELECT id, endpoint, p256dh, auth FROM acct_push_subscriptions WHERE tenant_id = ${tenantId}`;
  const payload = JSON.stringify(msg);
  let sent = 0;
  let pruned = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      await sql`UPDATE acct_push_subscriptions SET last_ok_at = now() WHERE id = ${s.id}`;
      sent += 1;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await sql`DELETE FROM acct_push_subscriptions WHERE id = ${s.id}`;
        pruned += 1;
      } else {
        warn("push send failed:", e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { sent, pruned };
}

/** A BudgetNotifier backed by Web Push — wire into budgets.checkAlerts(). */
export class WebPushNotifier implements BudgetNotifier {
  constructor(
    private readonly sql: Sql,
    private readonly vapid: VapidConfig,
  ) {}

  async notify(tenantId: string, alert: BudgetAlertPayload): Promise<void> {
    const r = await sendToTenant(this.sql, tenantId, this.vapid, {
      title: alert.reason === "threshold" ? "Budget alert" : "On pace to overspend",
      body: alert.message,
      tag: `budget-${alert.budgetId}-${alert.period}`,
      url: "/#budgets",
    });
    log(`push: budget alert -> sent ${r.sent}, pruned ${r.pruned}`);
  }
}
