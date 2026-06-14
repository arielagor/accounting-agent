/**
 * Minimal Google Sheets v4 client (raw fetch, no SDK). Create a spreadsheet and
 * write tabs (each tab cleared then rewritten) so the same Sheet — stable URL —
 * stays live as the close re-runs.
 */
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export type Cell = string | number;
export interface SheetTab {
  name: string;
  rows: Cell[][];
}

async function call(token: string, url: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Sheets ${method} ${url.replace(API, "")} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** A1 reference quoting for a tab name (single-quote, escape embedded quotes). */
function q(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export async function createSpreadsheet(
  token: string,
  title: string,
): Promise<{ spreadsheetId: string; url: string }> {
  const j = await call(token, API, "POST", { properties: { title } });
  return { spreadsheetId: j.spreadsheetId as string, url: j.spreadsheetUrl as string };
}

export function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/** Create missing tabs, drop the default empty "Sheet1", then clear+write each tab. */
export async function writeTabs(token: string, spreadsheetId: string, tabs: SheetTab[]): Promise<void> {
  const meta = await call(token, `${API}/${spreadsheetId}?fields=sheets.properties`, "GET");
  const existing: { title: string; sheetId: number }[] = (meta.sheets ?? []).map(
    (s: { properties: { title: string; sheetId: number } }) => s.properties,
  );
  const have = new Set(existing.map((e) => e.title));

  const requests: unknown[] = [];
  for (const tab of tabs) {
    if (!have.has(tab.name)) requests.push({ addSheet: { properties: { title: tab.name } } });
  }
  if (requests.length) await call(token, `${API}/${spreadsheetId}:batchUpdate`, "POST", { requests });

  // Drop a leftover default "Sheet1" we are not using (keeps the Sheet tidy).
  const def = existing.find((e) => e.title === "Sheet1");
  if (def && !tabs.some((t) => t.name === "Sheet1")) {
    await call(token, `${API}/${spreadsheetId}:batchUpdate`, "POST", {
      requests: [{ deleteSheet: { sheetId: def.sheetId } }],
    });
  }

  for (const tab of tabs) {
    await call(token, `${API}/${spreadsheetId}/values/${encodeURIComponent(`${q(tab.name)}!A1:Z5000`)}:clear`, "POST", {});
    await call(
      token,
      `${API}/${spreadsheetId}/values/${encodeURIComponent(`${q(tab.name)}!A1`)}?valueInputOption=RAW`,
      "PUT",
      { values: tab.rows },
    );
  }
}
