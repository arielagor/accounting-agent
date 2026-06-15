/**
 * The trust spine. Two append-only primitives shared by the auditor, the receipt
 * pipeline, and the manual-edit path:
 *   - logAudit():     write an immutable acct_audit_log row (who/what/when).
 *   - requestAccess(): file a structured, human-grantable access-request when a
 *                      research agent lacks data it needs — instead of guessing or
 *                      silently stalling. The agent NEVER self-grants.
 * Both are deliberately tiny and side-effect-only so every module can call them
 * without pulling in posting/categorization logic.
 */
import type { Sql } from "./db.js";

export type AuditActor = "auditor" | "human" | "engine" | "council" | "research" | "receipts";

/** Append one audit-log row. Never throws into the caller's critical path on a soft failure. */
export async function logAudit(
  sql: Sql,
  tenantId: string,
  actor: AuditActor,
  action: string,
  subject: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  await sql`
    INSERT INTO acct_audit_log (tenant_id, actor, action, subject, detail_json)
    VALUES (${tenantId}, ${actor}, ${action}, ${subject},
            ${detail ? sql.json(detail as Parameters<typeof sql.json>[0]) : null})
  `;
}

export interface AccessRequest {
  resource: string;
  reason: string;
  howToGrant: string;
  requestedForTxn?: string | null;
}

export interface AccessRequestResult {
  id: number;
  alreadyOpen: boolean;
}

/**
 * File (or find the existing open) access-request. Idempotent on
 * (tenant, resource, txn): a re-run never spams duplicates. Returns the row id and
 * whether it already existed. Also drops an audit-log breadcrumb on first creation.
 */
export async function requestAccess(
  sql: Sql,
  tenantId: string,
  req: AccessRequest,
  actor: AuditActor = "research",
): Promise<AccessRequestResult> {
  const txn = req.requestedForTxn ?? null;
  const existing = await sql<{ id: number; status: string }[]>`
    SELECT id, status FROM acct_access_requests
    WHERE tenant_id = ${tenantId} AND resource = ${req.resource}
      AND requested_for_txn IS NOT DISTINCT FROM ${txn}
  `;
  if (existing.length > 0) {
    return { id: existing[0]!.id, alreadyOpen: existing[0]!.status === "open" };
  }
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO acct_access_requests (tenant_id, resource, reason, how_to_grant, requested_for_txn)
    VALUES (${tenantId}, ${req.resource}, ${req.reason}, ${req.howToGrant}, ${txn})
    RETURNING id
  `;
  await logAudit(sql, tenantId, actor, "request_access", txn, {
    resource: req.resource,
    reason: req.reason,
  });
  return { id: row!.id, alreadyOpen: true };
}

/** Grant (or deny) an access-request — a human action from the Review screen. */
export async function resolveAccessRequest(
  sql: Sql,
  tenantId: string,
  id: number,
  decision: "granted" | "denied",
  grantedBy = "human",
): Promise<boolean> {
  const rows = await sql<{ id: number; resource: string }[]>`
    UPDATE acct_access_requests
    SET status = ${decision}, granted_at = now(), granted_by = ${grantedBy}
    WHERE id = ${id} AND tenant_id = ${tenantId} AND status = 'open'
    RETURNING id, resource`;
  if (rows.length === 0) return false;
  await logAudit(sql, tenantId, "human", `access_${decision}`, rows[0]!.resource, { accessRequestId: id });
  return true;
}

/** Has the user granted this resource? Used to gate a research agent before it asks again. */
export async function hasAccess(sql: Sql, tenantId: string, resource: string): Promise<boolean> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) n FROM acct_access_requests
    WHERE tenant_id = ${tenantId} AND resource = ${resource} AND status = 'granted'
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}
