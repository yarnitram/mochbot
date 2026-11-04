'use strict';
const $=id=>document.getElementById(id);
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=x=>typeof x==='number'&&Number.isFinite(x)?x.toLocaleString(undefined,{maximumSignificantDigits:7}):'—';
const usd=(x,digits=2)=>typeof x==='number'&&Number.isFinite(x)?`$${x.toFixed(digits)}`:'—';
const date=x=>x?new Date(x*1000).toLocaleString():'—';
const badge=x=>`<span class="pill ${esc(x)}">${esc(x)}</span>`;
const setupNotes=s=>s.orderNote?`<small class="setup-note"><strong>Setup notes</strong><br>${esc(s.orderNote)}</small>`:'';
const pnl=x=>typeof x==='number'&&Number.isFinite(x)?`<span class="${x>0?'positive':x<0?'negative':''}">${x>0?'+':''}${usd(x)}</span>`:'—';
let state={watchlist:[],limitOrders:[]},strategy={},strategyCatalog=[],activeTab='scanner';
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d}
async function action(fn,b){if(b)b.disabled=true;try{$('error').hidden=true;await fn()}catch(e){$('error').textContent=e.message;$('error').hidden=false}finally{if(b)b.disabled=false}}
function render(){
 const w=state.watchlist||[],p=state.performance||{};
 $('metrics').innerHTML=[['Watching',w.length],['Live feeds',w.filter(x=>x.feed?.status==='LIVE').length],['Pending limits',state.limitOrders.filter(x=>x.status==='PENDING').length],['Active trades',p.openTrades??0],['Realized P&L',`$${num(p.totalPnlUsd??0)}`]].map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('');
 $('mode').textContent=state.mode==='paper'?'PAPER · External alerts off':'External alerts enabled · Simulated trades';$('updated').textContent=`Updated ${new Date().toLocaleTimeString()}`;
 $('strategy-mode').textContent=state.globalStrategy==='BOTH'?'MOD-01E + EMA':state.globalStrategy;
 $('strategy-performance').innerHTML=(state.strategyPerformance||[]).map(s=>`<div class="metric"><span>${esc(s.id)}</span><strong>${pnl(s.totalPnlUsd)}</strong><small>${num(s.wins)}W / ${num(s.losses)}L · ${num(s.winRate)}% wins · ${num(s.totalR)}R · ${num(s.openTrades)} open</small></div>`).join('');
 const q=$('search').value.toLowerCase(),stage=$('stage').value,rank={ENTRY_READY:0,ARMED:1,WATCH:2,IDLE:3};
 const strat=$('strategy-filter').value;
 const rows=w.flatMap(x=>(x.setups?.length?x.setups:[x.state]).map(s=>({...x,state:s}))).filter(x=>(!stage||(x.state?.stage||'IDLE')===stage)&&(!strat||x.state?.strategyId===strat)&&`${x.symbol} ${x.state?.reason||''}`.toLowerCase().includes(q)).sort((a,b)=>rank[a.state?.stage||'IDLE']-rank[b.state?.stage||'IDLE']||a.symbol.localeCompare(b.symbol));
 $('coins').innerHTML=rows.map(x=>{const s=x.state||{},f=x.feed||{};return `<tr><td><a target="_blank" rel="noopener" href="https://www.mexc.com/futures/${encodeURIComponent(x.symbol)}"><strong>${esc(x.symbol)}</strong> ↗</a><small>${badge(s.strategyId||x.strategy||'MOD-01E')}</small><small>${badge(f.status||'CONNECTING')} ${num(f.closedBars)} bars</small><select data-coin-strategy="${esc(x.symbol)}" aria-label="Strategy for ${esc(x.symbol)}">${['MOD-01E','EMA-PULLBACK','BOTH'].map(id=>`<option ${x.strategy===id?'selected':''}>${id}</option>`).join('')}</select></td><td>${num(s.price)}</td><td>${badge(s.orderStatus==='BLOCKED'?'BLOCKED':s.stage||'IDLE')}<small>${esc(s.direction||'')}</small></td><td class="reason">${esc(f.error||s.reason||'Waiting for history')}${setupNotes(s)}<small>Candle ${date(f.candleTime)}</small></td><td>${num(s.entry)}<small>SL ${num(s.sl)}</small></td><td>${date(s.expiresAt)}</td><td><button data-remove="${esc(x.symbol)}" aria-label="Remove ${esc(x.symbol)}">×</button></td></tr>`}).join('')||'<tr><td colspan="7" class="empty">No matching setups. Add coins or change your filters.</td></tr>';
 $('order-rows').innerHTML=state.limitOrders.map(o=>{
   const p=o.payload||{},z=p.sizing;
   const margin=z?`${usd(z.margin,4)}<small>Position ${usd(z.notional)}</small>`:'—';
   const leverage=z?`${num(z.leverage)}×`:'—';
   const risk=z?`${usd(Math.abs(z.slRiskUsd))}<small>Budget ${usd(z.riskPerTrade)}${Math.abs(z.slRiskUsd)+.01<z.riskPerTrade?' · capital limited':''}</small>`:'—';
   return `<tr><td>${esc(o.symbol)}<small>${badge(p.strategyId||'MOD-01E')}</small></td><td>${esc(p.direction)}</td><td>${badge(o.status)}</td><td class="reason">${num(p.entry)}${setupNotes(p)}</td><td>${num(p.sl)}</td><td>${num(p.tp1)} / ${num(p.tp2)}</td><td>${margin}</td><td>${leverage}</td><td>${risk}</td><td>${date(o.updated_at)}</td></tr>`;
 }).join('')||'<tr><td colspan="10" class="empty">No limit plans recorded yet.</td></tr>';
 renderLive();
}
function renderLive(){
 const trades=state.activeTrades||[];
 $('live-count').textContent=`(${trades.length})`;
 const known=trades.filter(t=>typeof t.currentPnlUsd==='number');
 const sum=key=>trades.reduce((n,t)=>n+(typeof t[key]==='number'?t[key]:0),0);
 $('live-metrics').innerHTML=[['Active positions',trades.length],['Net P&L',usd(sum('currentPnlUsd'))],['Unrealized',usd(sum('unrealizedPnlUsd'))],['Secured at TP1',usd(sum('realizedPnlUsd'))],['Entry margin',usd(sum('margin'))]].map(([k,v])=>`<div class="metric"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
 const stale=trades.filter(t=>t.quoteStatus!=='LIVE').length;
 $('live-feed-note').hidden=stale===0;
 $('live-feed-note').textContent=`${stale} position(s) have stale or unavailable market prices. Totals use last available quotes; ${trades.length-known.length} unpriced position(s) are excluded from net P&L. Secured TP1 profit remains listed separately.`;
 $('live-rows').innerHTML=trades.map(t=>{
  const available=typeof t.currentPnlUsd==='number';
  const progress=typeof t.targetProgressPct==='number'?`<progress max="100" value="${t.targetProgressPct}" aria-label="${esc(t.symbol)} progress to ${esc(t.nextTarget)}"></progress><small>${esc(t.nextTarget)} · ${num(t.targetProgressPct)}%</small>`:'Awaiting price';
  return `<tr><td><a href="https://www.mexc.com/futures/${encodeURIComponent(t.symbol)}" target="_blank" rel="noopener"><strong>${esc(t.symbol)}</strong> ↗</a><small>${badge(t.strategy_id)}</small><small>${esc(t.direction)} · ${num(t.remainingPct)}% remaining</small></td><td>${badge(t.status)}<small>${badge(t.quoteStatus)}</small></td><td>${num(t.entry_price)}<small>Now ${num(t.currentPrice)}</small></td><td>${pnl(t.currentPnlUsd)}</td><td>${pnl(t.realizedPnlUsd)}<small>Unrealized ${pnl(t.unrealizedPnlUsd)}</small></td><td>${available?num(t.currentPnlPct)+'%':'—'}<small>${available?num(t.currentR)+'R':'Awaiting price'}</small></td><td>${usd(t.margin,4)}<small>${num(t.leverage)}× · Initial risk ${usd(t.initialRiskUsd)}</small></td><td>${num(t.sl_price)}${t.status==='TP1_HIT'?'<small>Break-even stop</small>':''}</td><td>${num(t.tp1_price)}<small>${num(t.tp2_price)}</small></td><td>${progress}</td><td>${t.chartUrl?`<button data-chart="${esc(t.chartUrl)}">Chart</button> `:''}<button data-close-trade="${t.id}" ${t.quoteStatus==='LIVE'?'':'disabled'} title="Close this simulated position at the latest observed price">Close</button></td></tr>`;
 }).join('')||'<tr><td colspan="11" class="empty">No live simulated trades. A touched limit will appear here automatically.</td></tr>';
}
async function refresh(){state=await api('/api/state');render();if(activeTab==='trades')await loadTrades()}
async function loadTrades(){const d=await api('/api/trades');$('trade-rows').innerHTML=d.history.map(t=>`<tr><td>${esc(t.symbol)}<small>${badge(t.strategy_id)}</small></td><td>${esc(t.direction)}</td><td>${badge(t.status)}</td><td>${num(t.entry_price)}</td><td>${num(t.sl_price)}</td><td>${pnl(t.pnl_usd)} · ${num(t.pnl_r)}R</td><td>${t.chartUrl?`<button data-chart="${esc(t.chartUrl)}">View chart</button>`:'—'}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">Completed simulated trades will appear here.</td></tr>'}
const labels={biasTfMinutes:'Bias timeframe (minutes)',alignTfMinutes:'Alignment timeframe (minutes)',entryTfMinutes:'Entry / expiry timeframe (minutes)',biasPivotLen:'Bias pivot length',alignPivotLen:'Alignment pivot length',entryPivotLen:'CHoCH pivot length',requireAlignment:'Require alignment',breakRule:'Break rule',entryFib:'Entry Fibonacci ratio',zoneNear:'Zone near',zoneFar:'Zone far',orderExpiry:'Limit expiry (entry bars)',cancelBiasFlip:'Cancel on bias disagreement',cancelNewChoch:'Cancel on new CHoCH',useKillzone:'UTC sessions (07–11, 13–17)',stopBufferAtr:'Stop ATR buffer',rrTP1:'TP1 risk multiple',rrTP2:'TP2 risk multiple',watchDistanceAtr:'Watch distance in ATR'};
const choices={biasTfMinutes:[60,240],alignTfMinutes:[5,15,30,60],entryTfMinutes:[1,3,5,15],breakRule:['Body close','Wick']};
Object.assign(labels,{fastLength:'Fast EMA length (1H & 15m)',slowLength:'Slow EMA length (1H & 15m)',pullbackWindowBars:'5m confirmation window (bars)',entryRatio:'Confirmation-candle retracement ratio'});
function field(k,v,label){if(typeof v==='boolean')return `<label class="check"><input name="${k}" type="checkbox" ${v?'checked':''}>${esc(label)}</label>`;return `<label>${esc(label)}${choices[k]?`<select name="${k}">${choices[k].map(x=>`<option ${x===v?'selected':''}>${esc(x)}</option>`).join('')}</select>`:`<input name="${k}" type="number" step="any" value="${esc(v)}" required>`}</label>`}
function renderStrategyEditor(){const selected=strategyCatalog.find(s=>s.id===$('edit-strategy').value);strategy=selected.config;$('strategy-description').textContent=selected.description;$('strategy-fields').innerHTML=Object.entries(strategy).map(([k,v])=>field(k,v,$('edit-strategy').value==='EMA-PULLBACK'&&k==='orderExpiry'?'Limit expiry (5m bars)':labels[k]||k)).join('')}
async function loadSettings(){strategyCatalog=(await api('/api/strategies')).strategies;renderStrategyEditor();$('selection-form').elements.globalStrategy.value=state.globalStrategy;
 const feeds=[['auto_scanner','Top 50 volume','autoScanner'],['meme_scanner','Top 50 memes','memeScanner'],['ai_scanner','Top 35 AI','aiScanner'],['game_scanner','Top 35 gaming','gameScanner'],['gainers_scanner','Top 25 gainers','gainersScanner'],['losers_scanner','Top 25 losers','losersScanner'],['ultra_lev_scanner','High leverage contracts','ultraLevScanner']];
 $('scanner-fields').innerHTML=feeds.map(([k,l,p])=>field(k,!!state[p],l)).join('')+field('max_active_coins',state.maxActiveCoins,'Discovery coin cap')+field('min_leverage',state.minLeverage,'Minimum leverage')+field('min_gainer_volume',state.minGainerVolume,'Minimum gainers/losers volume');
 $('risk-form').elements.account_capital.value=state.performance.accountCapital;$('risk-form').elements.risk_per_trade.value=state.performance.riskPerTrade;$('risk-form').elements.muted.checked=state.muted;
 $('risk-form').elements.max_open_risk.value=state.maxOpenRisk;
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>action(async()=>{activeTab=b.dataset.tab;document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==activeTab);document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('selected',x===b));if(activeTab==='settings')await loadSettings();if(activeTab==='trades')await loadTrades()}));
$('search').oninput=render;$('stage').onchange=render;$('strategy-filter').onchange=render;$('refresh').onclick=()=>action(refresh,$('refresh'));$('edit-strategy').onchange=renderStrategyEditor;
$('resync').onclick=()=>action(async()=>{await api('/api/scanner/resync',{});await refresh()},$('resync'));
$('add').onsubmit=e=>{e.preventDefault();action(async()=>{const r=await api('/api/watchlist',{symbol:e.target.elements.symbol.value});if(!r.ok)throw new Error(r.msg);e.target.reset();await refresh()},e.submitter)};
$('coins').onclick=e=>{const b=e.target.closest('[data-remove]');if(b)action(async()=>{const r=await fetch('/api/watchlist/'+encodeURIComponent(b.dataset.remove),{method:'DELETE'});if(!r.ok)throw new Error((await r.json()).error||'Remove failed');await refresh()},b)};
$('strategy-form').onsubmit=e=>{e.preventDefault();action(async()=>{const cfg=Object.fromEntries(Object.entries(strategy).map(([k,v])=>[k,typeof v==='boolean'?e.target.elements[k].checked:typeof v==='number'?Number(e.target.elements[k].value):e.target.elements[k].value]));await api(`/api/strategies/${encodeURIComponent($('edit-strategy').value)}/settings`,cfg);await refresh();await loadSettings()},e.submitter)};
$('selection-form').onsubmit=e=>{e.preventDefault();action(async()=>{await api('/api/strategies/settings',{globalStrategy:e.target.elements.globalStrategy.value,applyToWatchlist:e.target.elements.applyToWatchlist.checked});await refresh()},e.submitter)};
$('coins').onchange=e=>{const el=e.target.closest('[data-coin-strategy]');if(el)action(async()=>{const r=await fetch(`/api/watchlist/${encodeURIComponent(el.dataset.coinStrategy)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:el.value})});if(!r.ok)throw Error((await r.json()).error||'Strategy update failed');await refresh()},el)};
for(const id of ['scanner-form','risk-form'])$(id).onsubmit=e=>{e.preventDefault();action(async()=>{const body={};for(const el of e.target.elements)if(el.name)body[el.name]=el.type==='checkbox'?el.checked:Number(el.value);await api('/api/settings',body);await refresh()},e.submitter)};
function showChart(e){const b=e.target.closest('[data-chart]');if(b){$('chart-image').src=b.dataset.chart;$('chart-dialog').showModal()}}
$('trade-rows').onclick=showChart;
$('live-rows').onclick=e=>{
 showChart(e);
 const b=e.target.closest('[data-close-trade]');
 if(b&&confirm('Close this simulated trade at the latest observed price?'))action(async()=>{await api(`/api/trades/${encodeURIComponent(b.dataset.closeTrade)}/close`,{});await refresh()},b);
};
$('close-chart').onclick=()=>$('chart-dialog').close();
const stream=new EventSource('/api/events');stream.onopen=()=>{$('connection').textContent='Connected';$('connection').className='LIVE'};stream.onerror=()=>{$('connection').textContent='Reconnecting';$('connection').className='STALE'};
let queued;for(const event of ['state','state_full','alert','milestone','trade_opened'])stream.addEventListener(event,()=>{if(!queued)queued=setTimeout(()=>{queued=null;action(refresh)},1500)});
setInterval(()=>action(refresh),15000);action(refresh);
