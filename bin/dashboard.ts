/**
 * Local web dashboard. Serves a self-contained page (no build step, no deps) that
 * renders the close package — business deductions, per-project + portfolio P&L,
 * cash, Schedule-C, estimated tax — and an INTERACTIVE quarantine queue where one
 * click categorizes a transaction (posts it + learns the merchant). Read-only money:
 * the only writes are ledger postings to the agent's own DB.
 *
 * Usage: node --import tsx bin/dashboard.ts   (then open http://127.0.0.1:4242)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { getDashboardData } from "../src/lib/dashboard-data.js";
import { applyManualCategorization } from "../src/core/resolve.js";
import { log, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv(join(root, ".env"));
const url = env.ACCT_DB_URL;
if (!url) {
  error("ACCT_DB_URL not set");
  process.exit(1);
}
const tenant = env.TENANT_ID ?? "ariel";
const port = Number(env.DASHBOARD_PORT ?? 4242);
// Bind to 127.0.0.1 by default. Set DASHBOARD_HOST=0.0.0.0 to reach it from a phone
// over Tailscale/LAN — in which case DASHBOARD_TOKEN gates every request (the books
// are financial + the queue is writable, so do NOT expose it unauthenticated).
const host = env.DASHBOARD_HOST ?? "127.0.0.1";
const token = env.DASHBOARD_TOKEN ?? "";
const sql = openSql(url);

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function latestPeriod(): Promise<string> {
  const rows = await sql<{ period: string }[]>`
    SELECT period FROM acct_close_run WHERE tenant_id = ${tenant}
    UNION SELECT period FROM acct_close WHERE tenant_id = ${tenant}
    ORDER BY period DESC LIMIT 1`;
  return rows[0]?.period ?? new Date().toISOString().slice(0, 7);
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", `http://localhost:${port}`);
    // Token gate (only when DASHBOARD_TOKEN is set, i.e. when exposed beyond localhost).
    if (token && u.searchParams.get("token") !== token && req.headers["x-dash-token"] !== token) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized — append ?token=… to the URL");
      return;
    }
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/periods") {
      const rows = await sql<{ period: string }[]>`
        SELECT DISTINCT period FROM (
          SELECT period FROM acct_close_run WHERE tenant_id = ${tenant}
          UNION SELECT period FROM acct_close WHERE tenant_id = ${tenant}
        ) p ORDER BY period DESC`;
      json(res, 200, { periods: rows.map((r) => r.period) });
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/data") {
      const period = u.searchParams.get("period") || (await latestPeriod());
      const data = await getDashboardData(sql, tenant, period, new Date().toISOString());
      json(res, 200, data);
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/resolve") {
      const body = (await readBody(req)) as { sourceTxnId?: string; accountCode?: string; businessPct?: number };
      if (!body.sourceTxnId || !body.accountCode) {
        json(res, 400, { ok: false, error: "sourceTxnId and accountCode required" });
        return;
      }
      const result = await applyManualCategorization(
        sql, tenant, body.sourceTxnId, body.accountCode, body.businessPct ?? 100,
      );
      json(res, 200, { ok: result.posted || result.alreadyPosted, ...result });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    error("dashboard request failed:", e instanceof Error ? e.message : String(e));
    json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(port, host, () => {
  log(`Accounting dashboard -> http://${host}:${port}  (tenant=${tenant}${token ? ", token required" : ""})`);
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Accounting</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--ink:#e8eaed;--mut:#9aa0aa;--line:#262b35;--pos:#4ade80;--neg:#f87171;--accent:#7c9cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:600}select,button{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--accent)}
.wrap{padding:24px;display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-width:1400px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:0 0 12px}
.kpi{font-size:26px;font-weight:700}.sub{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--mut);font-weight:500}.r{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--pos)}.neg{color:var(--neg)}.full{grid-column:1/-1}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#1f3d2a;color:var(--pos)}
.badge.warn{background:#3d3320;color:#fbbf24}.muted{color:var(--mut)}
.qrow select{max-width:280px}.ok{color:var(--pos);font-size:12px}
/* Mobile: auto on narrow screens, or forced by body.mobile (the toggle). Single
   column, bigger touch targets, horizontally-scrollable tables. */
@media (max-width:640px){
  .wrap{grid-template-columns:1fr;padding:14px;gap:14px}
  header{padding:12px 14px;gap:10px}
  .card{overflow-x:auto}.kpi{font-size:22px}
  select,button{padding:9px 12px;font-size:15px}
  td,th{padding:8px 4px}
}
body.mobile .wrap{grid-template-columns:1fr;padding:14px;gap:14px}
body.mobile .card{overflow-x:auto}
body.mobile select,body.mobile button{padding:10px 14px;font-size:15px}
body.mobile td,body.mobile th{padding:9px 4px;font-size:14px}
body.mobile .qrow select{max-width:60vw}
#mtoggle.on{border-color:var(--accent);color:var(--accent)}
</style></head><body>
<header><h1>Accounting</h1><select id="period"></select><span id="verdict"></span><span class="sub" id="gen"></span><button id="mtoggle" onclick="toggleMobile()" title="Mobile-friendly layout">Mobile</button></header>
<div class="wrap" id="wrap"></div>
<script>
const $=s=>document.querySelector(s);
const TK=new URLSearchParams(location.search).get('token')||'';
const api=p=>p+(TK?(p.includes('?')?'&':'?')+'token='+encodeURIComponent(TK):'');
function applyMobile(on){document.body.classList.toggle('mobile',on);const b=$('#mtoggle');if(b)b.classList.toggle('on',on);try{localStorage.setItem('acct_mobile',on?'1':'0')}catch(e){}}
function toggleMobile(){applyMobile(!document.body.classList.contains('mobile'))}
const usd=c=>{const n=(c||0)/100;return (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
let DATA=null;
async function loadPeriods(){const r=await (await fetch(api('/api/periods'))).json();const sel=$('#period');sel.innerHTML='';(r.periods||[]).forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;sel.appendChild(o)});sel.onchange=()=>load(sel.value);return r.periods&&r.periods[0]}
async function load(period){const d=await (await fetch(api('/api/data?period='+(period||''))) ).json();DATA=d;render(d)}
function row(label,val,cls){return '<tr><td>'+label+'</td><td class="r '+(cls||'')+'">'+val+'</td></tr>'}
function render(d){
 const v=d.closePackage; const ver=v.tieOut===false?'<span class="badge warn">TIE-OUT?</span>':'<span class="badge">'+(d.closeStatus||'DRAFT')+(d.locked?' · LOCKED':'')+'</span>';
 $('#verdict').innerHTML=ver; $('#gen').textContent='generated '+new Date(d.generatedAt).toLocaleString();
 const p=v.portfolio;
 let h='';
 h+='<div class="card"><h2>Portfolio P&amp;L — '+d.period+'</h2><div class="kpi '+(p.netCents>=0?'pos':'neg')+'">'+usd(p.netCents)+' net</div>'
   +'<table>'+row('Revenue',usd(p.revenueCents))+row('COGS',usd(-p.cogsCents))+row('Operating expense',usd(-p.expenseCents))+'</table>'
   +'<div class="sub" style="margin-top:8px">Est. quarterly tax set-aside: '+usd(v.estimatedTaxCents)+'</div></div>';
 // Business deductions by account
 const exp=v.perProject; // not used here
 h+='<div class="card"><h2>Cash position</h2><table>'+v.cash.byAccount.map(a=>row(a.code+' '+a.name,usd(a.balanceCents))).join('')
   +row('<b>Total cash</b>','<b>'+usd(v.cash.totalCents)+'</b>')+'</table></div>';
 h+='<div class="card"><h2>Per-project P&amp;L</h2><table><tr><th>Project</th><th class="r">Revenue</th><th class="r">Expense</th><th class="r">Net</th></tr>'
   +v.perProject.map(x=>'<tr><td>'+x.projectSlug+'</td><td class="r">'+usd(x.revenueCents)+'</td><td class="r">'+usd(x.expenseCents)+'</td><td class="r '+(x.netCents>=0?'pos':'neg')+'">'+usd(x.netCents)+'</td></tr>').join('')+'</table></div>';
 h+='<div class="card"><h2>Schedule-C rollup (YTD)</h2><table>'+(v.scheduleC.length?v.scheduleC.map(s=>row('Line '+s.scheduleLine+' · '+s.accountName,usd(s.amountCents))).join(''):'<tr><td class="muted">none yet</td></tr>')+'</table></div>';
 // Quarantine queue
 const opts=d.chart.map(c=>'<option value="'+c.code+'">'+c.code+' '+c.name+'</option>').join('');
 h+='<div class="card full"><h2>To review — '+d.quarantine.length+' transactions need your call</h2>'
   +'<table><tr><th>Date</th><th>Merchant</th><th class="r">Amount</th><th>Reason</th><th>Categorize as</th><th></th></tr>'
   +d.quarantine.map(q=>'<tr class="qrow" data-id="'+q.sourceTxnId+'"><td class="muted">'+(q.date||'')+'</td><td>'+esc(q.merchant)+'</td><td class="r">'+usd(q.amountCents)+'</td><td class="muted">'+q.reason+'</td>'
     +'<td><select>'+opts+'</select></td><td><button onclick="resolve(this)">Save</button> <span class="ok"></span></td></tr>').join('')
   +'</table></div>';
 $('#wrap').innerHTML=h;
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function resolve(btn){const tr=btn.closest('tr');const id=tr.dataset.id;const code=tr.querySelector('select').value;
 btn.disabled=true;const r=await (await fetch(api('/api/resolve'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceTxnId:id,accountCode:code})})).json();
 if(r.ok){tr.querySelector('.ok').textContent='✓ posted';setTimeout(()=>tr.remove(),600)}else{btn.disabled=false;tr.querySelector('.ok').textContent='✗ '+(r.reason||r.error||'failed')}}
(async()=>{const sv=localStorage.getItem('acct_mobile');applyMobile(sv!==null?sv==='1':(window.innerWidth<=640));const first=await loadPeriods();await load(first)})();
</script></body></html>`;
