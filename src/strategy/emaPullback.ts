import type { Candle, Direction, EmaPullbackCfg, Setup } from '../types.js';
import { DEFAULT_EMA_CFG } from '../types.js';
import { aggregateClosed, atr, ema } from './indicators.js';

export function emaTimeframes(cfg:EmaPullbackCfg) {
  return cfg.timeframePreset==='4H/1H/15m'
    ? {trendMinutes:240,pullbackMinutes:60,confirmationMinutes:15,preset:cfg.timeframePreset}
    : {trendMinutes:60,pullbackMinutes:15,confirmationMinutes:5,preset:cfg.timeframePreset};
}
const tf=(minutes:number)=>minutes%60===0?`${minutes/60}H`:`${minutes}m`;

export function validateEmaConfig(input: Partial<EmaPullbackCfg>): EmaPullbackCfg {
  const cfg={...DEFAULT_EMA_CFG,...input};
  for(const [key,v] of Object.entries(cfg)) {
    if(key==='timeframePreset') {if(!['1H/15m/5m','4H/1H/15m'].includes(v as string))throw Error('Unsupported EMA timeframe preset');continue}
    if(!(key in DEFAULT_EMA_CFG)||typeof v!=='number'||!Number.isFinite(v)) throw Error(`Invalid EMA setting: ${key}`);
  }
  for(const key of ['fastLength','slowLength','pullbackWindowBars','orderExpiry'] as const)
    if(!Number.isInteger(cfg[key])||cfg[key]<1||cfg[key]>100) throw Error(`Invalid ${key}`);
  if(cfg.fastLength>=cfg.slowLength||cfg.entryRatio<=0||cfg.entryRatio>=1||cfg.stopBufferAtr<0||cfg.stopBufferAtr>5||cfg.rrTP1<=0||cfg.rrTP2<=cfg.rrTP1) throw Error('Invalid EMA entry, lengths or targets');
  return cfg;
}
interface Order {
  id:string; direction:Direction; confirmedAt:number; expiresAt:number;
  entry:number; stop:number; tp1:number; tp2:number; top:number; bottom:number; note:string;
}
interface Event { order:Order; status:'TOUCHED'|'EXPIRED'|'INVALIDATED'; time:number }
interface Reaction {direction:Direction;time:number;expiry:number;low:number;high:number;zoneTop:number;zoneBottom:number}

/** Preset-driven trend/pullback/confirmation, using only completed candles. */
export function evaluateEmaPullback(symbol:string, closed:Candle[], forming:Candle|null, trendHistory?:Candle[], cfg=DEFAULT_EMA_CFG, pullbackHistory?:Candle[]):Setup {
  const timeframes=emaTimeframes(cfg);
  const {trendMinutes,pullbackMinutes,confirmationMinutes}=timeframes;
  const trendSeconds=trendMinutes*60,pullbackSeconds=pullbackMinutes*60,confirmationSeconds=confirmationMinutes*60;
  const now=forming?.t??((closed.at(-1)?.t??Math.floor(Date.now()/1000)-60)+60);
  const base:Setup={symbol,stage:'IDLE',direction:null,setupId:null,price:(forming??closed.at(-1))?.c??NaN,
    zone:null,distanceAtr:null,needBreak:null,barsSinceTap:null,entry:null,sl:null,tp1:null,tp2:null,
    orderType:null,orderNote:null,killzone:true,atrHtf:null,atrLtf:null,ts:now,strategyId:'EMA-PULLBACK',ltfMinutes:confirmationMinutes,
    emaTimeframes:timeframes,reason:`Warming up EMA history: need completed ${tf(trendMinutes)} and ${tf(pullbackMinutes)} slow-EMA candles`};
  const end=(closed.at(-1)?.t??-60)+60;
  const h1=(trendHistory??aggregateClosed(closed,trendMinutes)).filter(b=>b.t+trendSeconds<=end);
  const m15=(pullbackHistory??aggregateClosed(closed,pullbackMinutes)).filter(b=>b.t+pullbackSeconds<=end);
  const m5=aggregateClosed(closed,confirmationMinutes);
  const hFast=ema(h1,cfg.fastLength),hSlow=ema(h1,cfg.slowLength);
  const aFast=ema(m15,cfg.fastLength),aSlow=ema(m15,cfg.slowLength),aAtr=atr(m15),eAtr=atr(m5);
  if(h1.length<cfg.slowLength||m15.length<Math.max(cfg.slowLength,14)||m5.length<2)return base;
  const biasAt=(time:number):Direction|null=>{
    let i=h1.length-1;while(i>=0&&h1[i].t+trendSeconds>time)i--;
    if(i<0||!Number.isFinite(hSlow[i]))return null;
    return h1[i].c>hFast[i]&&hFast[i]>hSlow[i]?'LONG':h1[i].c<hFast[i]&&hFast[i]<hSlow[i]?'SHORT':null;
  };
  let pending:Order|null=null, lastEvent:Event|null=null, cursor=0;
  let reaction:Reaction|null=null;
  let alignIndex=0;
  const finish=(status:Event['status'],time:number)=>{if(pending)lastEvent={order:pending,status,time};pending=null};
  const execute=(time:number)=>{
    while(cursor<closed.length&&closed[cursor].t+60<=time){
      const bar=closed[cursor++];if(!pending||bar.t<pending.confirmedAt)continue;
      if(bar.t>=pending.expiresAt){finish('EXPIRED',bar.t);continue}
      if(pending.direction==='LONG'?bar.l<=pending.stop:bar.h>=pending.stop){finish('INVALIDATED',bar.t);continue}
      if(pending.direction==='LONG'?bar.l<=pending.entry:bar.h>=pending.entry)finish('TOUCHED',bar.t+60);
    }
  };
  for(let i=0;i<m5.length;i++){
    const bar=m5[i],time=bar.t+confirmationSeconds;
    execute(time);
    const direction=biasAt(time);
    if(pending&&direction!==pending.direction)finish('INVALIDATED',time);
    const previousReaction=reaction as Reaction|null;
    if(previousReaction&&(direction!==previousReaction.direction||time>=previousReaction.expiry))reaction=null;
    while(alignIndex<m15.length&&m15[alignIndex].t+pullbackSeconds<=time){
      const j=alignIndex++,a=m15[j],top=Math.max(aFast[j],aSlow[j]),bottom=Math.min(aFast[j],aSlow[j]);
      const pullbackBias=biasAt(a.t+pullbackSeconds);
      if(a.t+pullbackSeconds+cfg.pullbackWindowBars*confirmationSeconds<=time)continue;
      if(!pending&&!reaction&&pullbackBias&&Number.isFinite(aSlow[j])&&a.l<=top&&a.h>=bottom){
        reaction={direction:pullbackBias,time:a.t+pullbackSeconds,expiry:a.t+pullbackSeconds+cfg.pullbackWindowBars*confirmationSeconds,
          low:a.l,high:a.h,zoneTop:top,zoneBottom:bottom};
      }
    }
    if(!reaction||pending||!direction||direction!==reaction.direction||bar.t<reaction.time||i===0)continue;
    reaction.low=Math.min(reaction.low,bar.l);reaction.high=Math.max(reaction.high,bar.h);
    const long=direction==='LONG';
    const confirms=long?bar.c>m5[i-1].h:bar.c<m5[i-1].l;
    if(!confirms||!Number.isFinite(eAtr[i]))continue;
    const entry=long?bar.h-(bar.h-bar.l)*cfg.entryRatio:bar.l+(bar.h-bar.l)*cfg.entryRatio;
    if(long?entry>=bar.c:entry<=bar.c)continue; // A resting limit must be on the retracement side of confirmation close.
    const stop=long?reaction.low-eAtr[i]*cfg.stopBufferAtr:reaction.high+eAtr[i]*cfg.stopBufferAtr;
    const risk=long?entry-stop:stop-entry;
    const tp1=entry+(long?1:-1)*risk*cfg.rrTP1,tp2=entry+(long?1:-1)*risk*cfg.rrTP2;
    if(risk<=0||entry<=0||stop<=0||tp1<=0||tp2<=0)continue;
    const note=`${tf(trendMinutes)} EMA ${cfg.fastLength}/${cfg.slowLength} ${long?'bullish':'bearish'} trend → ${tf(pullbackMinutes)} EMA-zone pullback → ${tf(confirmationMinutes)} close ${long?'above previous high':'below previous low'} → ${cfg.entryRatio} (${Number((cfg.entryRatio*100).toFixed(4))}%) confirmation-candle retracement ${long?'buy':'sell'} limit. Candle low: ${bar.l}; high: ${bar.h}. Expiry: ${cfg.orderExpiry} × ${tf(confirmationMinutes)} bars (${cfg.orderExpiry*confirmationMinutes} minutes). TP1 ${cfg.rrTP1}R / TP2 ${cfg.rrTP2}R.`;
    const presetKey=cfg.timeframePreset==='4H/1H/15m'?'4H-1H-15m:':'';
    pending={id:`${symbol}:EMA:${presetKey}${direction}:${bar.t}`,direction,confirmedAt:time,expiresAt:time+cfg.orderExpiry*confirmationSeconds,
      entry,stop,tp1,tp2,top:reaction.zoneTop,bottom:reaction.zoneBottom,note};reaction=null;
  }
  execute(end);
  if(pending&&end>=(pending as Order).expiresAt)finish('EXPIRED',end);
  const liveBias=biasAt(end);
  base.atrHtf=aAtr.at(-1)||null;base.atrLtf=eAtr.at(-1)||null;
  const asSetup=(o:Order):Setup=>({...base,setupId:o.id,direction:o.direction,entry:o.entry,sl:o.stop,tp1:o.tp1,tp2:o.tp2,
    zone:{top:o.top,bottom:o.bottom,startTime:o.confirmedAt},orderType:'LIMIT',expiresAt:o.expiresAt,orderNote:o.note});
  const event=lastEvent as Event|null;
  if(event?.status==='TOUCHED'&&now>=event.time&&now-event.time<confirmationSeconds*3)return {...asSetup(event.order),stage:'ENTRY_READY',orderStatus:'TOUCHED',reason:'EMA limit touched in completed market data; simulated entry'};
  if(pending)return {...asSetup(pending),stage:'ARMED',orderStatus:'PENDING',reason:`${tf(confirmationMinutes)} confirmation complete; waiting for EMA pullback limit retest`};
  if(event&&now-event.time<confirmationSeconds)return {...asSetup(event.order),orderStatus:event.status,reason:event.status==='EXPIRED'?'EMA limit expired without touch':'EMA limit invalidated by trend or stop boundary'};
  const watch=reaction as Reaction|null;
  if(watch)return {...base,stage:'WATCH',direction:watch.direction,setupId:`${symbol}:EMA:${cfg.timeframePreset}:WATCH:${watch.time}`,reason:`${tf(pullbackMinutes)} EMA pullback confirmed; waiting for a subsequent ${tf(confirmationMinutes)} confirmation close`};
  return {...base,direction:liveBias,reason:liveBias?`Waiting for a fresh ${tf(pullbackMinutes)} EMA-zone pullback`:`${tf(trendMinutes)} EMA trend is neutral or misaligned`};
}
