/**
 * Deterministic Apple purchase-history importer (NO LLM — instant, handles the full
 * multi-year export). Apple's export repeats a regular shape:
 *
 *   <Date "Mon DD, YYYY">
 *   <Order id, e.g. R24Z... / MT8Z... / MHK...>
 *   Total $X.XX
 *   <item group>* where each group is:
 *       <item name> [<duplicated name>] <vendor> [<period/status lines>] <price | "Free">
 *
 * We split each order's items on the PRICE line (the reliable delimiter), classify
 * each into business / personal / review by keyword, catalog every line into
 * acct_apple_purchases, and learn merchant rules for the high-confidence ones so the
 * same vendor auto-categorizes when it bills directly. Money is integer cents.
 */
import type { Sql } from "./db.js";
import { toCents } from "./money.js";
import { normalizeMerchant } from "./categorize.js";
import type { ClaudeRunner } from "../lib/llm.js";
import { extractJson } from "../lib/llm.js";

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};
const DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})$/;
const PRICE_RE = /^\$\s?([\d,]+\.\d{2})$/;
const TOTAL_RE = /^Total\s+\$\s?([\d,]+\.\d{2})$/;
/** Lines that are period/status metadata, not item names or vendors. */
const META_RE = /^(Renews\b|Expires:|Refunded\b|Not eligible|Monthly$|Yearly$|Free$|\d+\s*Day\b|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s*-)/;

export interface AppleItem {
  name: string;
  vendor: string;
  period: string | null;
  text: string; // name + vendor joined (for classification)
  amountCents: number;
  free: boolean;
}
export interface AppleOrder {
  date: string; // YYYY-MM-DD
  orderId: string;
  totalCents: number;
  items: AppleItem[];
}

function toIso(m: string, d: string, y: string): string {
  return `${y}-${MONTHS[m]}-${d.padStart(2, "0")}`;
}

/** Parse the pasted Apple history into structured orders. Resilient to blank lines. */
export function parseAppleHistory(text: string): AppleOrder[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const orders: AppleOrder[] = [];
  let i = 0;
  while (i < lines.length) {
    const dm = DATE_RE.exec(lines[i]!);
    if (!dm) { i++; continue; }
    const date = toIso(dm[1]!, dm[2]!, dm[3]!);
    i++;
    // Order id is the next line (no spaces, alphanumeric, len >= 8).
    let orderId = "";
    if (i < lines.length && /^[A-Z0-9]{8,}$/.test(lines[i]!)) { orderId = lines[i]!; i++; }
    // Total line.
    let totalCents = 0;
    if (i < lines.length) {
      const tm = TOTAL_RE.exec(lines[i]!);
      if (tm) { totalCents = toCents(tm[1]!); i++; }
    }
    // Collect item lines until the next date header.
    const buf: string[] = [];
    while (i < lines.length && !DATE_RE.test(lines[i]!)) { buf.push(lines[i]!); i++; }
    orders.push({ date, orderId: orderId || `apple-${date}-${orders.length}`, totalCents, items: itemsFrom(buf) });
  }
  return orders;
}

/** Split a buffer of item lines into items, delimited by the price ("$X.XX" or "Free") line. */
function itemsFrom(buf: string[]): AppleItem[] {
  const items: AppleItem[] = [];
  let cur: string[] = [];
  for (const line of buf) {
    const pm = PRICE_RE.exec(line);
    const isFree = line === "Free";
    if (pm || isFree) {
      const item = buildItem(cur, pm ? toCents(pm[1]!) : 0, isFree);
      if (item) items.push(item);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  return items;
}

function buildItem(buf: string[], amountCents: number, free: boolean): AppleItem | null {
  if (buf.length === 0) return null;
  const name = buf[0]!;
  // Drop an immediate duplicate of the name; collect the rest.
  const rest = buf.slice(1).filter((l, idx) => !(idx === 0 && l === name));
  const period = rest.find((l) => META_RE.test(l)) ?? null;
  // Vendor = first non-meta, non-duplicate line after the name; else the name.
  const vendor = rest.find((l) => l !== name && !META_RE.test(l)) ?? name;
  return { name, vendor, period, text: `${name} ${vendor}`.toLowerCase(), amountCents, free };
}

// ─── Classification ───────────────────────────────────────────────────────────────
export type Bucket = "business" | "personal" | "review" | "free";
export interface Classification {
  bucket: Bucket;
  accountCode: string | null;
  projectSlug: string | null;
  businessPct: number;
}

/** High-confidence BUSINESS (deductible) AI / dev / SaaS — account 6150 unless noted. */
const BUSINESS: Array<[RegExp, string]> = [
  [/claude|anthropic/, "6150"],
  [/openai|chatgpt/, "6150"],
  [/\bgrok\b|x\.?ai|xai/, "6150"],
  [/perplexity|gemini|deepseek|mistral|copilot|hugging\s?face|poe\b/, "6150"],
  [/elevenlabs|eleven\s?labs|heygen|descript|runway|suno|midjourney|ideogram|kling|pika|magnific|topaz|gigapixel/, "6150"],
  [/wispr|superwhisper|otter|fathom|fireflies|notebooklm/, "6150"],
  [/\bnotion\b|airtable|figma|framer|retool|linear\b|zapier|make\.com|\bn8n\b/, "6150"],
  [/github|cursor|replit|expo|jellycuts|juno.*python|python coding/, "6150"],
  [/adobe|canva|capcut|jasper|gamma/, "6150"],
  [/grammarly|1password|dropbox|google one|microsoft 365|wix|substack|beehiiv|amuse|spotify for artists|spotify for creators/, "6150"],
  [/google cloud|\baws\b|amazon web|azure|cloudflare|supabase|render|fly\.io|railway|vercel|netlify|firebase|tailscale/, "6160"],
  [/apple developer|apple podcasters|developer program|app store connect/, "6110"],
  [/linkedin/, "6150"],
  // Productivity / writing / comms tools (he publishes + runs products → business).
  [/medium:|a medium corporation|clean email|burner: second|second phone|ad hoc labs/, "6150"],
  [/genius fax|genius scan|grizzly labs|signeasy|docusign|signnow|adobe (acrobat|fill|sign|scan)|camscanner|scannable/, "6150"],
  [/goodreader|good\.iware|itranslate|tapeacall|mosaic s\.r\.l|network analyzer|techet|onion browser|hotspot shield|nordvpn|vpn express|opera/, "6150"],
  [/quickbooks|intuit|turbotax|expensify|harvest|bill\.com|wave|bench accounting|monarch|ynab|quicken|mint|empower|personal capital/, "6150"],
  // Creative / design / audio-video production tools (content business).
  [/autocad|autodesk|concepts|tophatch|home design 3d|anuman|morpholio|procreate|savage interactive|pixelmator|sketchbook|artstudio|lucky clan|affinity|linearity|bazaart|glitch|ifont|wolfram/, "6150"],
  [/fl studio|image line|native instruments|imaschine|hokusai|wooji|djay|algoriddim|edjing|tayasui|figure - make music|reason studios|alchemy synth/, "6150"],
  [/photoshop|lightroom|illustrator|premiere|after effects|capcut|splice|videon|8mm|mextures|tangent|repix|ultravisual|prisma|typorama|font candy|phonto/, "6150"],
];

/** High-confidence PERSONAL (non-deductible) — entertainment / dating / games / kids / food / fitness. */
const PERSONAL: RegExp[] = [
  /disney|netflix|hulu|hbo|max:|paramount|peacock|amc\+|starz|crunchyroll|showtime|sling|fubo|philo|sundance|mgm\+|apple tv|apple arcade|apple news/,
  /tinder|bumble|hinge|feeld|okcupid|happn|jdate|jcrush|jswipe|the grade|blendr|ashley madison|maple match|dabble/,
  /angry birds|balatro|royal match|warpath|fishdom|squid game|bomber ace|sky warriors|tetris|kahoot|duolingo math|into the breach|farming simulator|command & conquer/,
  /audible|paramount\+|amc\+|sleep cycle|insight timer|calm|headspace|breethe|reveri|happify|woebot|wysa/,
  /bluey|pbs kids|montessori|elmo|sesame|daniel tiger|cat in the hat|khan academy kids|123 learning|kahoot! kids|duolingo abc/,
  /hbo|mubi|tubi|pluto|xumo|vudu|fandango|amazon (prime video|freevee)|peacock|youtube (tv|kids|music)|sirius|pandora/,
  /nordvpn|bumble|the angry birds|five easy pieces|hook\b|snowden|koyaanisqatsi|jim gaffigan|two lovers|people places things|serial experiments lain/,
  /lose it|v shred|muscle booster|centr|natural pilates|glofox|classpass|map my run|interval timer/,
  /panda express|ara'?s shawarma|chick-fil-a|jack in the box|pick up stix|burger|pizza|coffee|cafe|shawarma|doordash|grubhub|uber eats|seamless|caviar|postmates/,
];

export function classifyAppleItem(text: string): Classification {
  for (const [re, acct] of BUSINESS) {
    if (re.test(text)) return { bucket: "business", accountCode: acct, projectSlug: "shared", businessPct: 100 };
  }
  for (const re of PERSONAL) {
    if (re.test(text)) return { bucket: "personal", accountCode: "9500", projectSlug: "personal", businessPct: 0 };
  }
  return { bucket: "review", accountCode: null, projectSlug: null, businessPct: 100 };
}

// ─── Import ─────────────────────────────────────────────────────────────────────────
export interface AppleImportSummary {
  orders: number;
  items: number;
  businessItems: number;
  personalItems: number;
  reviewItems: number;
  freeItems: number;
  businessSpentCents: number;
  personalSpentCents: number;
  totalSpentCents: number;
  rulesLearned: number;
  dateRange: { from: string; to: string } | null;
}

/** Final bucket for a catalog line: $0 downloads are 'free' (not real expenses). */
function bucketFor(amountCents: number, free: boolean, classified: Bucket): Bucket {
  return amountCents === 0 || free ? "free" : classified;
}

/**
 * Parse + catalog the history and learn merchant rules for confidently-classified
 * vendors. Idempotent on (order_id, line_no). Returns a summary for the UI.
 */
export async function importAppleHistory(sql: Sql, tenantId: string, text: string): Promise<AppleImportSummary> {
  const orders = parseAppleHistory(text);
  const validCodes = new Set(
    (await sql<{ code: string }[]>`SELECT code FROM acct_chart WHERE is_active`).map((r) => r.code),
  );
  const learned = new Set<string>();
  const s: AppleImportSummary = {
    orders: orders.length, items: 0, businessItems: 0, personalItems: 0, reviewItems: 0, freeItems: 0,
    businessSpentCents: 0, personalSpentCents: 0, totalSpentCents: 0, rulesLearned: 0, dateRange: null,
  };
  let minD = "9999-99-99", maxD = "0000-00-00";

  for (const o of orders) {
    if (o.date < minD) minD = o.date;
    if (o.date > maxD) maxD = o.date;
    let lineNo = 1;
    for (const it of o.items) {
      s.items += 1;
      s.totalSpentCents += it.amountCents;
      const c = classifyAppleItem(it.text);
      const bucket = bucketFor(it.amountCents, it.free, c.bucket);
      const accountCode = bucket === "free" ? null : c.accountCode;
      if (bucket === "free") s.freeItems += 1;
      else if (bucket === "business") { s.businessItems += 1; s.businessSpentCents += it.amountCents; }
      else if (bucket === "personal") { s.personalItems += 1; s.personalSpentCents += it.amountCents; }
      else s.reviewItems += 1;

      await sql`
        INSERT INTO acct_apple_purchases
          (tenant_id, order_id, order_date, line_no, item, vendor, period, amount_cents, order_total_cents, bucket, account_code)
        VALUES (${tenantId}, ${o.orderId}, ${o.date}, ${lineNo}, ${it.name}, ${it.vendor}, ${it.period},
                ${it.amountCents}, ${o.totalCents}, ${bucket}, ${accountCode})
        ON CONFLICT (tenant_id, order_id, line_no) DO UPDATE SET
          item = EXCLUDED.item, vendor = EXCLUDED.vendor, amount_cents = EXCLUDED.amount_cents,
          bucket = EXCLUDED.bucket, account_code = EXCLUDED.account_code`;
      lineNo += 1;

      // Learn a merchant rule ONLY for confidently-classified RECURRING subscriptions
      // (a period line = Renews/Expires/Monthly/date-range). One-off media (movies,
      // songs, paid apps) have no period and must not pollute the merchant rule set.
      if (c.bucket !== "review" && c.accountCode && validCodes.has(c.accountCode) && it.amountCents > 0 && it.period) {
        const key = normalizeMerchant(it.vendor);
        if (key && !learned.has(key)) {
          learned.add(key);
          await sql`
            INSERT INTO acct_merchant_rules (merchant_key, account_code, project_slug, business_pct, learned_from)
            VALUES (${key}, ${c.accountCode}, ${c.projectSlug}, ${c.businessPct}, 'llm_accepted')
            ON CONFLICT (merchant_key) DO NOTHING`;
        }
      }
    }
  }
  s.rulesLearned = learned.size;
  s.dateRange = orders.length ? { from: minD, to: maxD } : null;
  return s;
}

/**
 * Re-run classification + free-bucketing over the ALREADY-cataloged rows (no re-paste
 * needed). Recomputes bucket/account_code for every row and re-learns merchant rules
 * for confidently-classified recurring subscriptions. Returns the new bucket tally.
 */
export async function reclassifyAppleCatalog(
  sql: Sql,
  tenantId: string,
): Promise<{ updated: number; business: number; personal: number; review: number; free: number; rulesLearned: number }> {
  const rows = await sql<
    { id: number; item: string; vendor: string | null; period: string | null; amount_cents: string }[]
  >`SELECT id, item, vendor, period, amount_cents FROM acct_apple_purchases WHERE tenant_id = ${tenantId}`;
  const validCodes = new Set(
    (await sql<{ code: string }[]>`SELECT code FROM acct_chart WHERE is_active`).map((r) => r.code),
  );
  const learned = new Set<string>();
  const out = { updated: 0, business: 0, personal: 0, review: 0, free: 0, rulesLearned: 0 };
  for (const r of rows) {
    const amount = Number(r.amount_cents);
    const text = `${r.item} ${r.vendor ?? ""}`.toLowerCase();
    const c = classifyAppleItem(text);
    const bucket = bucketFor(amount, amount === 0, c.bucket);
    const accountCode = bucket === "free" ? null : c.accountCode;
    out[bucket] += 1;
    await sql`UPDATE acct_apple_purchases SET bucket = ${bucket}, account_code = ${accountCode} WHERE id = ${r.id}`;
    out.updated += 1;
    if (bucket !== "free" && bucket !== "review" && c.accountCode && validCodes.has(c.accountCode) && amount > 0 && r.period) {
      const key = normalizeMerchant(r.vendor ?? r.item);
      if (key && !learned.has(key)) {
        learned.add(key);
        await sql`
          INSERT INTO acct_merchant_rules (merchant_key, account_code, project_slug, business_pct, learned_from)
          VALUES (${key}, ${c.accountCode}, ${c.projectSlug}, ${c.businessPct}, 'llm_accepted')
          ON CONFLICT (merchant_key) DO NOTHING`;
      }
    }
  }
  out.rulesLearned = learned.size;
  return out;
}

// ─── LLM auditor for the long-tail paid review items ───────────────────────────────
export interface AppleAuditResult {
  processed: number;
  business: number;
  personal: number;
  stillReview: number;
  rulesLearned: number;
  batches: number;
}

interface AuditRow { id: number; item: string; vendor: string | null; period: string | null; amount_cents: string }

/**
 * Classify the remaining PAID 'review' catalog items with the LLM, in small batches
 * (so a huge paste can never time out). Each item is decided business (a chart code) /
 * personal (9500) / leave-in-review, updated in place, and recurring subs learn a
 * merchant rule. Fail-soft per batch: a bad batch is skipped, others still process.
 */
export async function auditAppleReview(
  sql: Sql,
  tenantId: string,
  runner: ClaudeRunner,
  batchSize = 25,
): Promise<AppleAuditResult> {
  const rows = await sql<AuditRow[]>`
    SELECT id, item, vendor, period, amount_cents FROM acct_apple_purchases
    WHERE tenant_id = ${tenantId} AND bucket = 'review' AND amount_cents > 0 ORDER BY id`;
  const chart = await sql<{ code: string; name: string }[]>`
    SELECT code, name FROM acct_chart WHERE is_active AND type IN ('expense','cogs') ORDER BY code`;
  const validCodes = new Set(chart.map((c) => c.code));
  const chartList = chart.map((c) => `  ${c.code}  ${c.name}`).join("\n");
  const learned = new Set<string>();
  const out: AppleAuditResult = { processed: 0, business: 0, personal: 0, stillReview: 0, rulesLearned: 0, batches: 0 };

  for (let off = 0; off < rows.length; off += batchSize) {
    const batch = rows.slice(off, off + batchSize);
    out.batches += 1;
    const listing = batch
      .map((r, i) => `${i}\t${r.item} — ${r.vendor ?? ""}${r.period ? ` (${r.period})` : ""} — $${(Number(r.amount_cents) / 100).toFixed(2)}`)
      .join("\n");
    const prompt = [
      "You are a CPA categorizing App Store purchases. Be terse; output only JSON.",
      "",
      "Classify each Apple App Store purchase below as a BUSINESS deduction or a",
      "PERSONAL (non-deductible) expense for a solo founder who builds software + AI",
      "products and creates content. Business = dev tools, AI/ML, SaaS, productivity,",
      "design/creative production, hosting. Personal = entertainment, streaming, games,",
      "dating, fitness, food, kids, travel guides, one-off movies/songs/books.",
      "If genuinely unsure, set bucket 'review'.",
      "",
      "Business chart codes (pick the best fit):",
      chartList,
      "",
      "Items (index<TAB>name — vendor (period) — price):",
      listing,
      "",
      "Return ONLY JSON: {\"items\":[{\"i\":<index>,\"bucket\":\"business|personal|review\",",
      "\"accountCode\":\"<code from list, or 9500 for personal, or null>\"}]}",
    ].join("\n");

    let parsed: { items?: { i: number; bucket: string; accountCode: string | null }[] };
    try {
      parsed = extractJson(await runner.run(prompt)) as typeof parsed;
    } catch {
      out.stillReview += batch.length;
      continue; // skip this batch; leave its items in review
    }
    const byIndex = new Map<number, { bucket: string; accountCode: string | null }>();
    for (const it of parsed.items ?? []) if (typeof it.i === "number") byIndex.set(it.i, { bucket: it.bucket, accountCode: it.accountCode });

    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]!;
      out.processed += 1;
      const d = byIndex.get(i);
      let bucket: Bucket = "review";
      let accountCode: string | null = null;
      if (d?.bucket === "business" && d.accountCode && validCodes.has(d.accountCode)) { bucket = "business"; accountCode = d.accountCode; }
      else if (d?.bucket === "personal") { bucket = "personal"; accountCode = "9500"; }
      if (bucket === "business") out.business += 1;
      else if (bucket === "personal") out.personal += 1;
      else { out.stillReview += 1; }
      if (bucket !== "review") {
        await sql`UPDATE acct_apple_purchases SET bucket = ${bucket}, account_code = ${accountCode} WHERE id = ${r.id}`;
        // Learn a rule for recurring subs (period present) only.
        if (r.period) {
          const key = normalizeMerchant(r.vendor ?? r.item);
          if (key && !learned.has(key)) {
            learned.add(key);
            await sql`
              INSERT INTO acct_merchant_rules (merchant_key, account_code, project_slug, business_pct, learned_from)
              VALUES (${key}, ${accountCode}, ${bucket === "business" ? "shared" : "personal"}, ${bucket === "business" ? 100 : 0}, 'llm_accepted')
              ON CONFLICT (merchant_key) DO NOTHING`;
          }
        }
      }
    }
  }
  out.rulesLearned = learned.size;
  return out;
}

/**
 * Apply a HUMAN classification to a catalog item and TEACH the system: update the
 * row's bucket/account, and learn an authoritative merchant rule (learned_from
 * 'human') so the same vendor auto-categorizes in the bank feed forever after. This
 * is how a review choice on the Apple catalog compounds — same loop as the
 * Transactions tab's applyManualCategorization.
 */
export async function setAppleClassification(
  sql: Sql,
  tenantId: string,
  id: number,
  bucket: Bucket,
  accountCode: string | null,
): Promise<{ ok: boolean; learnedVendor?: string }> {
  const rows = await sql<{ item: string; vendor: string | null }[]>`
    SELECT item, vendor FROM acct_apple_purchases WHERE id = ${id} AND tenant_id = ${tenantId}`;
  if (rows.length === 0) return { ok: false };
  const code = bucket === "personal" ? "9500" : accountCode;
  await sql`UPDATE acct_apple_purchases SET bucket = ${bucket}, account_code = ${code} WHERE id = ${id} AND tenant_id = ${tenantId}`;

  let learnedVendor: string | undefined;
  if ((bucket === "business" || bucket === "personal") && code) {
    const merchant = rows[0]!.vendor ?? rows[0]!.item;
    const key = normalizeMerchant(merchant);
    if (key) {
      await sql`
        INSERT INTO acct_merchant_rules (merchant_key, account_code, project_slug, business_pct, learned_from)
        VALUES (${key}, ${code}, ${bucket === "business" ? "shared" : "personal"}, ${bucket === "business" ? 100 : 0}, 'human')
        ON CONFLICT (merchant_key) DO UPDATE SET
          account_code = EXCLUDED.account_code, project_slug = EXCLUDED.project_slug,
          business_pct = EXCLUDED.business_pct, learned_from = 'human', last_confirmed_at = now()`;
      learnedVendor = merchant;
    }
  }
  return { ok: true, learnedVendor };
}

/** Heuristic: does this pasted text look like a bulk Apple purchase-history export? */
export function looksLikeAppleHistory(text: string): boolean {
  const totals = (text.match(/^Total\s+\$/gm) ?? []).length;
  const orderIds = (text.match(/^(R\d|MT8|MHK|R89)[A-Z0-9]{6,}$/gm) ?? []).length;
  return totals >= 3 && orderIds >= 3;
}
