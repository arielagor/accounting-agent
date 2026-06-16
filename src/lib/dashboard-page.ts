/**
 * The PWA shell + client SPA, plus the service worker, manifest, and icon, as string
 * constants served by bin/dashboard.ts. Dependency-free (no build step, no framework):
 * a tabbed Mint-class UI rendered with vanilla JS. Kept out of the HTTP file so the
 * server logic stays readable. Charts are hand-drawn inline SVG (works offline in the
 * installed PWA). The token rides the x-dash-token header, never the URL.
 */

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0f1115"/><rect x="40" y="104" width="22" height="48" rx="4" fill="#7c9cff"/><rect x="85" y="74" width="22" height="78" rx="4" fill="#4ade80"/><rect x="130" y="44" width="22" height="108" rx="4" fill="#fbbf24"/><circle cx="51" cy="56" r="10" fill="#e8eaed"/></svg>`;

export const MANIFEST = JSON.stringify({
  name: "Accounting",
  short_name: "Books",
  description: "Budgeting, accounting, and a financial advisor — agent-run.",
  start_url: "/",
  display: "standalone",
  background_color: "#0f1115",
  theme_color: "#0f1115",
  icons: [
    { src: "/icon.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
    { src: "/icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
  ],
});

export const SW_JS = `
const CACHE='acct-v1';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/icon.svg','/manifest.webmanifest'])))});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.pathname.startsWith('/api/'))return; // never cache API
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('/'))));
});
self.addEventListener('push',e=>{let d={title:'Accounting',body:'Update'};try{d=e.data.json()}catch(_){}
  e.waitUntil(self.registration.showNotification(d.title||'Accounting',{body:d.body||'',icon:'/icon.svg',badge:'/icon.svg',tag:d.tag,data:{url:d.url||'/'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const url=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil(self.clients.matchAll({type:'window'}).then(cs=>{for(const c of cs){if('focus'in c){c.navigate(url);return c.focus()}}return self.clients.openWindow(url)}))});
`;

export const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115"><title>Accounting</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon.svg"><link rel="icon" href="/icon.svg">
<style>
:root{--bg:#0f1115;--card:#181b22;--ink:#e8eaed;--mut:#9aa0aa;--line:#262b35;--pos:#4ade80;--neg:#f87171;--accent:#7c9cff;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:10}
h1{font-size:16px;margin:0;font-weight:600}h1 .dot{color:var(--accent)}
select,button,input{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:#0b0e14;border-color:var(--accent);font-weight:600}
nav{display:flex;gap:4px;overflow-x:auto;padding:8px 20px;border-bottom:1px solid var(--line);position:sticky;top:55px;background:var(--bg);z-index:9}
nav button{border:0;background:transparent;color:var(--mut);padding:8px 12px;border-radius:8px;white-space:nowrap}
nav button.active{background:var(--card);color:var(--ink)}
.wrap{padding:20px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-width:1500px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:0 0 12px}
.kpi{font-size:26px;font-weight:700}.sub{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--mut);font-weight:500}.r{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--pos)}.neg{color:var(--neg)}.warnc{color:var(--warn)}.full{grid-column:1/-1}.muted{color:var(--mut)}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#1f3d2a;color:var(--pos)}
.badge.warn{background:#3d3320;color:var(--warn)}.badge.bad{background:#3d2020;color:var(--neg)}.badge.mut{background:#222732;color:var(--mut)}
.bar{height:8px;border-radius:99px;background:#222732;overflow:hidden;margin-top:6px}.bar>span{display:block;height:100%;background:var(--accent)}
.bar.over>span{background:var(--neg)}.bar.warn>span{background:var(--warn)}
.row2{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ok{color:var(--pos);font-size:12px}.err{color:var(--neg);font-size:12px}
textarea{width:100%;min-height:120px;background:#0b0e14;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px;font:13px/1.5 ui-monospace,monospace}
@media (max-width:640px){.wrap{grid-template-columns:1fr;padding:12px;gap:12px}header{padding:10px 12px}nav{padding:6px 12px;top:49px}select,button,input{padding:9px 12px;font-size:15px}td,th{padding:8px 4px}}
body.mobile .wrap{grid-template-columns:1fr}#mtoggle.on{border-color:var(--accent);color:var(--accent)}
</style></head><body>
<header><h1>Books<span class="dot">.</span></h1><select id="period"></select><span id="verdict"></span>
<span class="sub" id="gen"></span><span style="flex:1"></span>
<button id="pushbtn" onclick="enablePush()" title="Enable phone alerts">Alerts</button>
<button id="mtoggle" onclick="toggleMobile()" title="Mobile layout">Mobile</button></header>
<nav id="tabs"></nav>
<div class="wrap" id="wrap"></div>
<script>
const $=s=>document.querySelector(s);
let TK='';(function(){const h=new URLSearchParams((location.hash||'').replace(/^#/,'')).get('token');
 if(h){TK=h;try{sessionStorage.setItem('acct_tk',h)}catch(e){}history.replaceState(null,'',location.pathname);}
 else{try{TK=sessionStorage.getItem('acct_tk')||''}catch(e){}}
 if(!TK){TK=(prompt('Dashboard access token (blank if localhost):')||'').trim();try{sessionStorage.setItem('acct_tk',TK)}catch(e){}}})();
const H=(extra)=>Object.assign({'x-dash-token':TK},extra||{});
const jget=async p=>(await fetch(p,{headers:H()})).json();
const jpost=async(p,b)=>(await fetch(p,{method:'POST',headers:H({'content-type':'application/json'}),body:JSON.stringify(b||{})})).json();
const usd=c=>{const n=(c||0)/100;return (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
const usd0=c=>{const n=(c||0)/100;return (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{maximumFractionDigits:0})};
const esc=s=>(s||'').toString().replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function applyMobile(on){document.body.classList.toggle('mobile',on);const b=$('#mtoggle');if(b)b.classList.toggle('on',on);try{localStorage.setItem('acct_mobile',on?'1':'0')}catch(e){}}
function toggleMobile(){applyMobile(!document.body.classList.contains('mobile'))}
let PERIOD='',CHART=[],CONFIG={};
const TABS=[['overview','Overview'],['txns','Transactions'],['budgets','Budgets'],['advisor','Advisor'],['receipts','Receipts'],['smb','Business'],['review','Review']];
let TAB='overview';
function renderTabs(){$('#tabs').innerHTML=TABS.map(([k,l])=>'<button class="'+(k===TAB?'active':'')+'" onclick="go(\\''+k+'\\')">'+l+'</button>').join('')}
function go(t){TAB=t;renderTabs();draw()}
function chartOpts(){return CHART.map(c=>'<option value="'+c.code+'">'+c.code+' '+esc(c.name)+'</option>').join('')}

// ── Net-worth sparkline (inline SVG) ─────────────────────────────────────────
function sparkline(points){if(!points||!points.length)return '';const w=560,h=120,pad=8;
 const vals=points.map(p=>p.netWorthCents);const min=Math.min(0,...vals),max=Math.max(1,...vals);const rng=(max-min)||1;
 const x=i=>pad+i*((w-2*pad)/Math.max(1,points.length-1));const y=v=>h-pad-((v-min)/rng)*(h-2*pad);
 const d=points.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(p.netWorthCents).toFixed(1)).join(' ');
 return '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="120" preserveAspectRatio="none"><path d="'+d+'" fill="none" stroke="#7c9cff" stroke-width="2"/></svg>';}

async function draw(){const w=$('#wrap');w.innerHTML='<div class="card"><span class="muted">Loading…</span></div>';
 try{
  if(TAB==='overview')await drawOverview();
  else if(TAB==='txns')await drawTxns();
  else if(TAB==='budgets')await drawBudgets();
  else if(TAB==='advisor')await drawAdvisor();
  else if(TAB==='receipts')await drawReceipts();
  else if(TAB==='smb')await drawSmb();
  else if(TAB==='review')await drawReview();
 }catch(e){w.innerHTML='<div class="card err">Error: '+esc(e.message||e)+'</div>'}}

async function drawOverview(){const d=await jget('/api/overview?period='+PERIOD);CHART=d.chart;
 const v=d.closePackage,p=v.portfolio;
 const ver=v.tieOut===false?'<span class="badge bad">TIE-OUT?</span>':'<span class="badge">'+(d.closeStatus||'DRAFT')+(d.locked?' · LOCKED':'')+'</span>';
 $('#verdict').innerHTML=ver;$('#gen').textContent='as of '+new Date(d.generatedAt).toLocaleString();
 const nw=d.netWorth||[];const last=nw.length?nw[nw.length-1]:null;
 let h='';
 h+='<div class="card full"><h2>Net worth — '+PERIOD.slice(0,4)+'</h2>'+(last?'<div class="kpi '+(last.netWorthCents>=0?'pos':'neg')+'">'+usd(last.netWorthCents)+'</div><div class="sub">assets '+usd(last.assetsCents)+' · liabilities '+usd(last.liabilitiesCents)+'</div>':'<div class="muted">no data</div>')+sparkline(nw)+'</div>';
 h+='<div class="card"><h2>Portfolio P&amp;L — '+d.period+'</h2><div class="kpi '+(p.netCents>=0?'pos':'neg')+'">'+usd(p.netCents)+' net</div>'
   +'<table><tr><td>Revenue</td><td class="r">'+usd(p.revenueCents)+'</td></tr><tr><td>COGS</td><td class="r">'+usd(-p.cogsCents)+'</td></tr><tr><td>Operating expense</td><td class="r">'+usd(-p.expenseCents)+'</td></tr></table>'
   +'<div class="sub" style="margin-top:8px">Est. quarterly tax set-aside: '+usd(v.estimatedTaxCents)+'</div></div>';
 h+='<div class="card"><h2>Cash position</h2><table>'+v.cash.byAccount.map(a=>'<tr><td>'+a.code+' '+esc(a.name)+'</td><td class="r">'+usd(a.balanceCents)+'</td></tr>').join('')+'<tr><td><b>Total cash</b></td><td class="r"><b>'+usd(v.cash.totalCents)+'</b></td></tr></table></div>';
 h+='<div class="card"><h2>Per-project P&amp;L</h2><table><tr><th>Project</th><th class="r">Net</th></tr>'+v.perProject.map(x=>'<tr><td>'+esc(x.projectSlug)+'</td><td class="r '+(x.netCents>=0?'pos':'neg')+'">'+usd(x.netCents)+'</td></tr>').join('')+'</table></div>';
 $('#wrap').innerHTML=h;}

async function drawTxns(){const d=await jget('/api/transactions?period='+PERIOD);if(!CHART.length){CHART=(await jget('/api/overview?period='+PERIOD)).chart}
 const opts=chartOpts();
 let h='<div class="card full"><h2>Transactions — '+d.period+' ('+d.transactions.length+')</h2><table><tr><th>Date</th><th>Merchant</th><th class="r">Amount</th><th>Status</th><th>Category</th><th></th></tr>';
 h+=d.transactions.map(t=>{const sel='<select data-code>'+opts.replace('value="'+(t.account||'')+'"','value="'+(t.account||'')+'" selected')+'</select>';
   const badge=t.status==='posted'?'<span class="badge">posted</span>':t.status==='review'?'<span class="badge warn">review</span>':'<span class="badge mut">unposted</span>';
   return '<tr class="txn" data-id="'+t.sourceTxnId+'"><td class="muted">'+(t.date||'')+'</td><td>'+esc(t.merchant)+'</td><td class="r '+(t.amountCents<0?'':'pos')+'">'+usd(t.amountCents)+'</td><td>'+badge+'</td><td>'+sel+'</td><td><button onclick="saveTxn(this,\\''+t.status+'\\')">Save</button> <span class="ok"></span></td></tr>'}).join('');
 h+='</table><div class="sub" style="margin-top:8px">Editing a posted transaction re-categorizes it (voids + re-posts) and re-learns the merchant.</div></div>';
 $('#wrap').innerHTML=h;}
async function saveTxn(btn,status){const tr=btn.closest('tr');const id=tr.dataset.id;const code=tr.querySelector('[data-code]').value;btn.disabled=true;
 const ep=status==='posted'?'/api/recategorize':'/api/resolve';const r=await jpost(ep,{sourceTxnId:id,accountCode:code});
 const sp=tr.querySelector('.ok');if(r.ok){sp.className='ok';sp.textContent='✓ saved'}else{sp.className='err';sp.textContent='✗ '+(r.reason||r.error||'failed')}btn.disabled=false;}

async function drawBudgets(){const d=await jget('/api/budgets');if(!CHART.length){CHART=(await jget('/api/overview?period='+PERIOD)).chart}
 let h='<div class="card full"><h2>Budgets</h2>';
 if(!d.budgets.length)h+='<div class="muted">No budgets yet — add one below.</div>';
 h+='<table><tr><th>Budget</th><th>Scope</th><th class="r">Spent</th><th class="r">Limit</th><th>Status</th></tr>';
 h+=d.budgets.map(b=>{const cls=b.status==='over'?'over':(b.status==='warn'||b.status==='projected_over')?'warn':'';const pct=Math.min(100,b.pct);
   const st=b.status==='over'?'<span class="badge bad">over</span>':b.status==='projected_over'?'<span class="badge warn">on pace over</span>':b.status==='warn'?'<span class="badge warn">'+b.pct.toFixed(0)+'%</span>':'<span class="badge">'+b.pct.toFixed(0)+'%</span>';
   return '<tr><td>'+esc(b.name)+'<div class="bar '+cls+'"><span style="width:'+pct+'%"></span></div></td><td class="muted">'+b.scope+'</td><td class="r">'+usd(b.spentCents)+'</td><td class="r">'+usd(b.limitCents)+'</td><td>'+st+'</td></tr>'}).join('')+'</table></div>';
 h+='<div class="card full"><h2>Add / update a budget</h2><div class="row2">'
   +'<input id="bname" placeholder="Name" style="width:160px">'
   +'<select id="bscope"><option value="category">Category</option><option value="project">Project</option><option value="overall">Overall</option></select>'
   +'<select id="bcode">'+chartOpts()+'</select>'
   +'<select id="bkind"><option value="month">Monthly</option><option value="quarter">Quarterly</option><option value="year">Yearly</option></select>'
   +'<input id="blimit" placeholder="Limit $" style="width:110px" inputmode="decimal">'
   +'<button class="primary" onclick="saveBudget()">Save</button><span id="bmsg" class="ok"></span></div></div>';
 $('#wrap').innerHTML=h;}
async function saveBudget(){const scope=$('#bscope').value;const limit=Math.round(parseFloat($('#blimit').value||'0')*100);
 const body={name:$('#bname').value||'Budget',scope,periodKind:$('#bkind').value,limitCents:limit};
 if(scope==='category')body.accountCode=$('#bcode').value;
 const r=await jpost('/api/budgets',body);const m=$('#bmsg');if(r.ok){m.className='ok';m.textContent='✓ saved';draw()}else{m.className='err';m.textContent='✗ failed'}}

async function drawAdvisor(){const d=await jget('/api/advisor');
 let h='<div class="card full"><div class="row2" style="justify-content:space-between"><h2 style="margin:0">Recommendations</h2><button class="primary" onclick="genAdvisor(this)">Refresh advice</button></div>';
 if(!d.recommendations.length)h+='<div class="muted" style="margin-top:10px">No recommendations yet — tap “Refresh advice”.</div>';
 h+='</div>';
 h+=d.recommendations.map(r=>'<div class="card"><div class="row2" style="justify-content:space-between"><b>'+esc(r.title)+'</b><span class="badge mut">'+r.kind+'</span></div>'
   +'<div class="sub" style="margin:6px 0">'+esc(r.body)+'</div>'
   +(r.estImpactCents?'<div class="'+(r.kind==='savings'||r.kind==='subscription'?'pos':'')+'">~'+usd0(r.estImpactCents)+(r.kind==='tax'?' set aside':r.kind==='runway'?'':'/yr impact')+'</div>':'')
   +'<div class="row2" style="margin-top:8px"><button onclick="reco('+r.id+',\\'done\\',this)">Done</button><button onclick="reco('+r.id+',\\'ack\\',this)">Ack</button><button onclick="reco('+r.id+',\\'dismissed\\',this)">Dismiss</button> <span class="ok"></span></div></div>').join('');
 $('#wrap').innerHTML=h;}
async function genAdvisor(btn){btn.disabled=true;btn.textContent='Thinking…';await jpost('/api/advisor/generate',{period:PERIOD});draw()}
async function reco(id,status,btn){const sp=btn.parentElement.querySelector('.ok');const r=await jpost('/api/reco/status',{id,status});if(r.ok){sp.textContent='✓';setTimeout(draw,400)}else sp.className='err',sp.textContent='✗'}

async function drawReceipts(){const d=await jget('/api/receipts');
 let h='<div class="card full"><h2>Upload a receipt / statement</h2><div class="sub" style="margin-bottom:8px">Paste receipt text or CSV; the agent extracts line items and splits the matching charge (e.g. an Apple.com/Bill aggregate) to the cent.</div>'
   +'<textarea id="rtext" placeholder="Paste receipt text here…"></textarea><div class="row2" style="margin-top:8px"><label class="sub"><input type="checkbox" id="rcsv"> CSV</label><button class="primary" onclick="upRcpt(this)">Process</button> <span id="rmsg" class="ok"></span></div></div>';
 h+='<div class="card full"><h2>Documents ('+d.documents.length+')</h2><table><tr><th>Date</th><th>Vendor</th><th class="r">Total</th><th>Lines</th><th>Status</th></tr>'
   +d.documents.map(x=>'<tr><td class="muted">'+(x.docDate||x.createdAt)+'</td><td>'+esc(x.vendorGuess||x.sourceKind)+'</td><td class="r">'+(x.totalCents!=null?usd(x.totalCents):'—')+'</td><td>'+x.lines+'</td><td>'+statusBadge(x.status)+'</td></tr>').join('')+'</table></div>';
 $('#wrap').innerHTML=h;}
function statusBadge(s){const m={split:'badge',matched:'badge',extracted:'badge mut',pending:'badge mut',unmatched:'badge warn',error:'badge bad',filed:'badge'};return '<span class="'+(m[s]||'badge mut')+'">'+s+'</span>'}
async function upRcpt(btn){const t=$('#rtext').value;if(!t.trim())return;btn.disabled=true;btn.textContent='Processing…';
 const r=await jpost('/api/receipts',{text:t,csv:$('#rcsv').checked});const m=$('#rmsg');
 if(r.ok&&r.mode==='apple_history'){const s=r.summary;m.className='ok';
   m.innerHTML='✓ Imported '+s.orders+' Apple orders, '+s.items+' items '+(s.dateRange?'('+s.dateRange.from+'→'+s.dateRange.to+')':'')+'. '
   +'<b>'+s.businessItems+'</b> business ('+usd0(s.businessSpentCents)+'), '+s.personalItems+' personal, '+s.reviewItems+' to review · '+s.rulesLearned+' rules learned.';
   $('#rtext').value='';btn.disabled=false;btn.textContent='Process';return}
 if(r.ok){m.className='ok';m.textContent='✓ '+(r.stage==='split'&&r.result&&r.result.posted?'split posted':r.stage)+' (doc '+r.documentId+')';setTimeout(draw,700)}else{m.className='err';m.textContent='✗ '+(r.error||'failed');btn.disabled=false;btn.textContent='Process'}}

async function drawSmb(){const d=await jget('/api/smb');
 const ag=(t,a)=>'<div class="card"><h2>'+t+' aging</h2><table><tr><td>Current</td><td class="r">'+usd(a.current)+'</td></tr><tr><td>1–30</td><td class="r">'+usd(a.d1_30)+'</td></tr><tr><td>31–60</td><td class="r">'+usd(a.d31_60)+'</td></tr><tr><td>61–90</td><td class="r '+(a.d61_90?'warnc':'')+'">'+usd(a.d61_90)+'</td></tr><tr><td>90+</td><td class="r '+(a.d90plus?'neg':'')+'">'+usd(a.d90plus)+'</td></tr></table></div>';
 let h=ag('Receivables (AR)',d.arAging)+ag('Payables (AP)',d.apAging);
 h+='<div class="card"><h2>1099 contractors</h2>'+(d.contractors1099.length?'<table><tr><th>Vendor</th><th class="r">YTD paid</th><th>W-9</th></tr>'+d.contractors1099.map(c=>'<tr><td>'+esc(c.name)+'</td><td class="r">'+usd(c.ytdPaidCents)+'</td><td>'+(c.w9OnFile?'<span class="badge">on file</span>':'<span class="badge bad">missing</span>')+'</td></tr>').join('')+'</table>':'<div class="muted">No contractors over the $600 1099 bar.</div>')+'</div>';
 h+='<div class="card"><h2>Sales tax</h2>'+(d.salesTax.length?'<table><tr><th>Jurisdiction</th><th>Period</th><th class="r">Collected</th><th>Status</th></tr>'+d.salesTax.map(s=>'<tr><td>'+esc(s.jurisdiction)+'</td><td>'+s.period+'</td><td class="r">'+usd(s.collectedCents)+'</td><td>'+statusBadge(s.status)+'</td></tr>').join('')+'</table>':'<div class="muted">No sales tax collected.</div>')+'</div>';
 $('#wrap').innerHTML=h;}

async function drawReview(){const d=await jget('/api/review?period='+PERIOD);CHART=d.chart;const opts=chartOpts();
 let h='<div class="card full"><div class="row2" style="justify-content:space-between"><h2 style="margin:0">To review — '+d.quarantine.length+' need a call</h2><button class="primary" onclick="runAudit(this)" title="Let the auditor + council resolve what it can">Run auditor</button></div>'
   +'<table><tr><th>Date</th><th>Merchant</th><th class="r">Amount</th><th>Reason</th><th>Categorize as</th><th></th></tr>'
   +d.quarantine.map(q=>'<tr class="qrow" data-id="'+q.sourceTxnId+'"><td class="muted">'+(q.date||'')+'</td><td>'+esc(q.merchant)+'</td><td class="r">'+usd(q.amountCents)+'</td><td class="muted">'+esc(q.reason)+'</td><td><select>'+opts+'</select></td><td><button onclick="resolveQ(this)">Save</button> <span class="ok"></span></td></tr>').join('')+'</table></div>';
 if(d.accessRequests.length){h+='<div class="card full"><h2>Access requests — the agent needs your OK</h2>'
   +d.accessRequests.map(a=>'<div class="row2" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0"><div><b>'+esc(a.resource)+'</b><div class="sub">'+esc(a.reason)+'</div><div class="sub muted">'+esc(a.howToGrant)+'</div></div><div class="row2"><button class="primary" onclick="grant('+a.id+',\\'granted\\',this)">Grant</button><button onclick="grant('+a.id+',\\'denied\\',this)">Deny</button> <span class="ok"></span></div></div>').join('')+'</div>';}
 $('#wrap').innerHTML=h;}
async function resolveQ(btn){const tr=btn.closest('tr');const r=await jpost('/api/resolve',{sourceTxnId:tr.dataset.id,accountCode:tr.querySelector('select').value});
 const sp=tr.querySelector('.ok');if(r.ok){sp.textContent='✓ posted';setTimeout(()=>tr.remove(),500)}else{sp.className='err';sp.textContent='✗ '+(r.reason||r.error)}}
async function runAudit(btn){btn.disabled=true;btn.textContent='Auditing…';const r=await jpost('/api/audit/run',{});if(r.ok){alert('Auditor: '+r.summary.autoPosted+' auto-posted, '+r.summary.escalated+' escalated, '+r.summary.deferred+' awaiting access, '+r.summary.quarantined+' still need you.')}draw()}
async function grant(id,decision,btn){const r=await jpost('/api/access',{id,decision});const sp=btn.parentElement.querySelector('.ok');if(r.ok){sp.textContent='✓';setTimeout(draw,400)}else{sp.className='err';sp.textContent='✗'}}

// ── Push ─────────────────────────────────────────────────────────────────────
function b64ToU8(b){const pad='='.repeat((4-b.length%4)%4);const s=(b+pad).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(s);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}
async function enablePush(){try{
 if(!CONFIG.pushEnabled||!CONFIG.vapidPublicKey){alert('Push not configured on the server yet (run npm run vapid-keys).');return}
 if(!('serviceWorker'in navigator)||!('PushManager'in window)){alert('This browser does not support push.');return}
 const reg=await navigator.serviceWorker.ready;const perm=await Notification.requestPermission();if(perm!=='granted'){alert('Notifications not granted.');return}
 const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToU8(CONFIG.vapidPublicKey)});
 const r=await jpost('/api/push/subscribe',{subscription:sub.toJSON()});
 if(r.ok){await jpost('/api/push/test',{});$('#pushbtn').classList.add('on');alert('Alerts on — you should get a test notification.')}
}catch(e){alert('Push failed: '+(e.message||e))}}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot(){
 const sv=localStorage.getItem('acct_mobile');applyMobile(sv!==null?sv==='1':(window.innerWidth<=640));
 try{CONFIG=await jget('/api/config')}catch(e){}
 const pr=await jget('/api/periods');const sel=$('#period');sel.innerHTML='';(pr.periods||[]).forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;sel.appendChild(o)});
 PERIOD=(pr.periods&&pr.periods[0])||new Date().toISOString().slice(0,7);sel.value=PERIOD;sel.onchange=()=>{PERIOD=sel.value;draw()};
 renderTabs();draw();
 if('serviceWorker'in navigator){try{await navigator.serviceWorker.register('/sw.js')}catch(e){}}
}
boot();
</script></body></html>`;
