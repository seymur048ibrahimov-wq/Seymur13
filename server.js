import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const OKX_BASE = 'https://www.okx.com';
const OKX_WS = 'wss://ws.okx.com:8443/ws/v5/business';
const DEMO = String(process.env.OKX_DEMO).toLowerCase() === 'true';
const API_KEY = process.env.OKX_API_KEY || '';
const API_SECRET = process.env.OKX_API_SECRET || '';
const PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const TRADING_ENABLED = String(process.env.TRADING_ENABLED).toLowerCase() === 'true';
const AUTO_TRADE = String(process.env.AUTO_TRADE).toLowerCase() === 'true';
const DEFAULT_LEVERAGE = Number(process.env.DEFAULT_LEVERAGE || 5); // heç bir tier/override uyğun gəlməyəndə son fallback
// === Dinamik leverage: (1) etibar faizi + volatiliyə görə, (2) simvola görə ===
// Etibar+ATR tier-ləri (yüksək etibar/aşağı volatilite -> daha yüksək leverage icazəsi).
// Hər tier-i .env-də ayrıca override edə bilərsən, məsələn: LEVERAGE_TIER1=8
const LEVERAGE_TIERS = [
  { minConf: Number(process.env.LEVERAGE_TIER1_CONF || 85), maxAtrPct: Number(process.env.LEVERAGE_TIER1_ATR || 1.5), lev: Number(process.env.LEVERAGE_TIER1 || 10) },
  { minConf: Number(process.env.LEVERAGE_TIER2_CONF || 72), maxAtrPct: Number(process.env.LEVERAGE_TIER2_ATR || 2.5), lev: Number(process.env.LEVERAGE_TIER2 || 5) },
  { minConf: Number(process.env.LEVERAGE_TIER3_CONF || 50), maxAtrPct: Infinity, lev: Number(process.env.LEVERAGE_TIER3 || 3) },
];
function confidenceLeverage(confidence, atrPct){
  if(atrPct==null) return DEFAULT_LEVERAGE;
  for(const t of LEVERAGE_TIERS){ if(confidence>=t.minConf && atrPct<t.maxAtrPct) return t.lev; }
  return Number(process.env.LEVERAGE_LOW_CONF || 1); // 50%-dən aşağı etibar -> minimal leverage
}
// Simvola görə leverage TAVANI (istifadəçi tier-in verdiyi dəyəri keçə bilməz, yalnız aşağı sala bilər).
// Format: "BTC-USDT-SWAP:10,ETH-USDT-SWAP:8,DOGE-USDT-SWAP:3"
const SYMBOL_LEVERAGE_CAP = new Map(
  (process.env.SYMBOL_LEVERAGE || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(pair => { const [sym, lev] = pair.split(':'); return [String(sym||'').trim().toUpperCase(), Number(lev)]; })
    .filter(([sym, lev]) => sym && !isNaN(lev) && lev > 0)
);
function resolveLeverage(symbol, confidence, atrPct){
  let lev = confidenceLeverage(confidence, atrPct);
  const cap = SYMBOL_LEVERAGE_CAP.get(symbol);
  if(cap != null) lev = Math.min(lev, cap); // simvol tavanı həmişə üstünlük təşkil edir (risk aşağı salına bilər, artırıla bilməz)
  return Math.max(1, Math.round(lev));
}
const RISK_PER_TRADE = Number(process.env.RISK_PER_TRADE || 0.01);
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS || 3);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 72);
const SIGNAL_COOLDOWN_MIN = Number(process.env.SIGNAL_COOLDOWN_MIN || 30);
const CONFIDENCE_STEP = Number(process.env.CONFIDENCE_STEP || 15);
const MAX_SLIPPAGE_PCT = Number(process.env.MAX_SLIPPAGE_PCT || 0.4); // siqnal qiyməti ilə icra anındakı bazar qiyməti arasında icazə verilən max fərq (%)
// Minimum Risk:Reward — bundan aşağı olan siqnal confidence yüksək olsa belə AVTOMATIK icra edilmir.
// Səbəb: yüksək "etibar faizi" ilə pis R:R kombinasiyası uzun müddətdə itki gətirir, çünki bir neçə
// uğursuz əməliyyat bir uğurlunun qazancını asanlıqla silə bilər.
const MIN_RR = Number(process.env.MIN_RR || 1.5);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// === Təhlükəsizlik / risk parametrləri ===
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || ''; // boşdursa trade/close/scanner endpoint-ləri qıfıllı qalır (heç kim çağıra bilməz)
const MAX_DAILY_LOSS_PCT = Number(process.env.MAX_DAILY_LOSS_PCT || 5); // gündəlik equity-nin bu faizindən çox itki -> auto-trade avtomatik dayanır
const STATE_FILE = process.env.STATE_FILE || '/tmp/siqnal-pro-state.json'; // restart-dan sonra bərpa üçün
// SCAN_SYMBOLS nümunəsi (Railway Variables-da təyin edilir), YA DA boş saxla/`AUTO_TOP30` yaz —
// bu halda bot OKX-dan REAL 24saatlıq həcmə görə ən likvid 30 SWAP coini özü tapır.
// === BTC-USDT-SWAP həmişə skan siyahısında olmalıdır (əsas fokus) ===
const BTC_SYMBOL = 'BTC-USDT-SWAP';
// İstifadəçinin prioritet sırası — bunlar siyahıda həmişə ƏN ÖNDƏ göstərilir (varsa)
const PRIORITY_SYMBOLS = ['BTC-USDT-SWAP','ETH-USDT-SWAP','SOL-USDT-SWAP','AVAX-USDT-SWAP','BNB-USDT-SWAP','BCH-USDT-SWAP','XRP-USDT-SWAP','DOGE-USDT-SWAP'];
// Fallback (AUTO_TOP30 uğursuz olsa və ya SCAN_SYMBOLS yazılmasa istifadə olunan ~30 simvollu default siyahı)
const DEFAULT_SYMBOLS = [
  ...PRIORITY_SYMBOLS,
  'ADA-USDT-SWAP','LINK-USDT-SWAP','DOT-USDT-SWAP','LTC-USDT-SWAP','TRX-USDT-SWAP',
  'TON-USDT-SWAP','NEAR-USDT-SWAP','SUI-USDT-SWAP','APT-USDT-SWAP','ARB-USDT-SWAP',
  'OP-USDT-SWAP','INJ-USDT-SWAP','FIL-USDT-SWAP','ATOM-USDT-SWAP','ETC-USDT-SWAP',
  'ICP-USDT-SWAP','HBAR-USDT-SWAP','UNI-USDT-SWAP','AAVE-USDT-SWAP','SHIB-USDT-SWAP',
  'TAO-USDT-SWAP','CRO-USDT-SWAP'
];
function reorderPriority(list){
  const set=new Set(list);
  const head=PRIORITY_SYMBOLS.filter(p=>set.has(p));
  const tail=list.filter(s=>!PRIORITY_SYMBOLS.includes(s));
  return [...new Set([...head,...tail])];
}
const rawScanEnv=(process.env.SCAN_SYMBOLS||'').trim().toUpperCase();
const AUTO_TOP30 = !rawScanEnv || rawScanEnv==='AUTO_TOP30';
let symbols = AUTO_TOP30
  ? DEFAULT_SYMBOLS.slice()
  : rawScanEnv.split(',').map(x=>x.trim()).filter(Boolean);
symbols = reorderPriority(symbols);
if(!symbols.includes(BTC_SYMBOL)) symbols.unshift(BTC_SYMBOL);
let activeSymbols = symbols;
// OKX simvolunu ("AVAX-USDT-SWAP") istifadəçiyə göstərilən təmiz formaya çevirir ("AVAX/USDT")
function prettySymbol(instId){ return String(instId).replace('-USDT-SWAP','/USDT').replace(/-SWAP$/,''); }
// Real 24s həcmə görə OKX-dakı ən likvid SWAP coinlərini tapır (AUTO_TOP30 aktiv olanda çağırılır)
async function discoverTop30(){
  try{
    const d = await okxPublic('/api/v5/market/tickers',{instType:'SWAP'});
    const usdt = d.filter(t=>t.instId && t.instId.endsWith('-USDT-SWAP'));
    usdt.sort((a,b)=>Number(b.volCcy24h||0)-Number(a.volCcy24h||0));
    const top = usdt.slice(0,30).map(t=>t.instId);
    if(!top.length) throw new Error('boş nəticə');
    return reorderPriority(top);
  }catch(e){
    console.error('AUTO_TOP30 uğursuz oldu, default siyahı istifadə olunur:', e.message);
    return DEFAULT_SYMBOLS.slice();
  }
}
const TIMEFRAMES = ['1m','5m','15m','1H','4H'];
// Konfluensiya hesablamasına DAXIL EDILMIR — yalnız əlavə kontekst (makro trend + gözlənilən aralıq) üçün
const MACRO_TF = '1D';
const HISTORY_LIMIT = 300;
// BTC üçün siqnal cooldown-u qalan simvollardan qısa saxlanılır ki, dəyişiklik daha tez bildirilsin
const BTC_COOLDOWN_MIN = Number(process.env.BTC_COOLDOWN_MIN || Math.max(5, Math.round(SIGNAL_COOLDOWN_MIN/2)));

const state = {
  startedAt: Date.now(), online: true, scannerEnabled: true,
  lastMarketUpdate: 0, lastSignalAt: new Map(), signals: [], positions: [],
  candles: new Map(), instruments: new Map(), clients: new Set(),
  telegramOffset: 0, telegramRunning: false, lastError: null,
  lastAnalysis: new Map(), wsConnected:false, lastReportedConfidence: new Map(),
  fundingRate: new Map(), openInterest: new Map(), oiHistory: new Map(),
  // Risk / kill-switch
  dayStartEquity: null, dayStartAt: 0, tradingHalted: false, haltReason: null
};

// === State persistence: signals + risk vəziyyəti restart-dan sonra bərpa olunur ===
// DATABASE_URL env dəyişəni verilibsə Postgres istifadə olunur (Railway-də Postgres add-on asan qoşulur).
// Verilməyibsə /tmp faylına yazılır — bu, konteyner restart/redeploy-da silinə bilər, ona görə
// real production üçün DATABASE_URL təyin etmək tövsiyə olunur. package.json-a "pg" asılılığı əlavə et:
//   npm install pg
let pgPool=null;
async function initDb(){
  if(!process.env.DATABASE_URL) return;
  try{
    const { Pool } = await import('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
    await pgPool.query(`CREATE TABLE IF NOT EXISTS siqnal_state (id INT PRIMARY KEY DEFAULT 1, data JSONB, updated_at TIMESTAMPTZ DEFAULT now())`);
    console.log('Postgres bağlantısı quruldu — state DB-də saxlanılacaq.');
  }catch(e){
    console.warn('Postgres qoşula bilmədi ("pg" paketi quraşdırılıbmı?), fayl-based persistence-ə keçilir:', e.message);
    pgPool=null;
  }
}
function saveState(){
  const dump = {
    signals: state.signals, dayStartEquity: state.dayStartEquity,
    dayStartAt: state.dayStartAt, tradingHalted: state.tradingHalted,
    haltReason: state.haltReason, lastSignalAt: [...state.lastSignalAt.entries()],
    lastReportedConfidence: [...state.lastReportedConfidence.entries()]
  };
  if(pgPool){
    pgPool.query(`INSERT INTO siqnal_state(id,data,updated_at) VALUES(1,$1,now()) ON CONFLICT(id) DO UPDATE SET data=$1, updated_at=now()`,[dump]).catch(()=>{});
    return;
  }
  try{ fs.writeFileSync(STATE_FILE, JSON.stringify(dump)); }catch(e){ /* best-effort */ }
}
async function loadState(){
  let d=null;
  if(pgPool){
    try{ const res=await pgPool.query('SELECT data FROM siqnal_state WHERE id=1'); d=res.rows?.[0]?.data||null; }catch(e){}
  }
  if(!d){
    try{ if(fs.existsSync(STATE_FILE)) d=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); }catch(e){}
  }
  if(!d) return;
  if(Array.isArray(d.signals)) state.signals = d.signals;
  if(d.dayStartEquity!=null) state.dayStartEquity = d.dayStartEquity;
  if(d.dayStartAt) state.dayStartAt = d.dayStartAt;
  if(d.tradingHalted) { state.tradingHalted = true; state.haltReason = d.haltReason; }
  if(Array.isArray(d.lastSignalAt)) state.lastSignalAt = new Map(d.lastSignalAt);
  if(Array.isArray(d.lastReportedConfidence)) state.lastReportedConfidence = new Map(d.lastReportedConfidence);
}

function key(symbol, tf){ return `${symbol}|${tf}`; }
function b64(buf){ return Buffer.from(buf).toString('base64'); }
function sign(ts, method, path, body=''){
  return b64(crypto.createHmac('sha256', API_SECRET).update(ts + method + path + body).digest());
}
function authHeaders(method, path, body=''){
  const ts = new Date().toISOString();
  return {
    'OK-ACCESS-KEY': API_KEY,
    'OK-ACCESS-SIGN': sign(ts, method, path, body),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': PASSPHRASE,
    'Content-Type':'application/json',
    ...(DEMO ? {'x-simulated-trading':'1'} : {})
  };
}

async function okxPublic(path, params={}){
  const u = new URL(OKX_BASE + path);
  for(const [k,v] of Object.entries(params)) u.searchParams.set(k,String(v));
  const r = await fetch(u);
  const j = await r.json();
  if(!r.ok || j.code !== '0') throw new Error(j.msg || `OKX ${r.status}`);
  return j.data;
}
async function okxPrivate(method, path, body=null, params={}){
  if(!API_KEY || !API_SECRET || !PASSPHRASE) throw new Error('OKX private API credentials are not configured');
  let url = OKX_BASE + path;
  if(method === 'GET'){
    const u = new URL(url);
    for(const [k,v] of Object.entries(params)) u.searchParams.set(k,String(v));
    url=u.toString(); path=u.pathname+u.search;
  }
  const bodyStr = body ? JSON.stringify(body) : '';
  const r = await fetch(url,{method,headers:authHeaders(method,path,bodyStr),body:method==='GET'?undefined:bodyStr});
  const j = await r.json();
  if(!r.ok || j.code !== '0') throw new Error(j.msg || `OKX ${r.status}`);
  return j.data;
}

function ema(a,p){ if(a.length<p) return null; const k=2/(p+1); let e=a.slice(0,p).reduce((x,y)=>x+y,0)/p; for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k); return e; }
function sma(a,p){ if(a.length<p) return null; return a.slice(-p).reduce((x,y)=>x+y,0)/p; }
function rsi(a,p=14){ if(a.length<p+1)return null; let g=0,l=0; for(let i=1;i<=p;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}let ag=g/p,al=l/p;for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;}return al===0?100:100-100/(1+ag/al); }
function atr(c,p=14){ if(c.length<p+1)return null; const tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));return ema(tr,p); }
function bollinger(a,p=20,m=2){if(a.length<p)return null;const mid=sma(a,p),s=a.slice(-p).reduce((z,x)=>z+(x-mid)**2,0)/p,sd=Math.sqrt(s);return{mid,upper:mid+m*sd,lower:mid-m*sd};}
function macd(a){if(a.length<35)return null;const fast=ema(a.slice(-80),12),slow=ema(a.slice(-80),26);return fast==null||slow==null?null:fast-slow;}
function stochastic(c,p=14){if(c.length<p)return null;const x=c.slice(-p),hh=Math.max(...x.map(z=>z.h)),ll=Math.min(...x.map(z=>z.l));return hh===ll?50:((x.at(-1).c-ll)/(hh-ll))*100;}
function cci(c,p=20){if(c.length<p)return null;const t=c.slice(-p).map(x=>(x.h+x.l+x.c)/3),m=t.reduce((a,b)=>a+b,0)/p,d=t.reduce((a,b)=>a+Math.abs(b-m),0)/p;return d===0?0:(t.at(-1)-m)/(0.015*d);}
function mfi(c,p=14){if(c.length<p+1)return null;let pos=0,neg=0;for(let i=c.length-p;i<c.length;i++){const a=(c[i-1].h+c[i-1].l+c[i-1].c)/3,b=(c[i].h+c[i].l+c[i].c)/3,m=b*c[i].v;if(b>a)pos+=m;else if(b<a)neg+=m;}if(neg===0)return 100;const r=pos/neg;return 100-100/(1+r);}
function obvTrend(c,n=10){if(c.length<n+1)return 0;let s=0;for(let i=c.length-n;i<c.length;i++){if(c[i].c>c[i-1].c)s+=c[i].v;else if(c[i].c<c[i-1].c)s-=c[i].v;}return s;}
function structure(c){if(c.length<20)return 0;const n=10,a=c.slice(-n),b=c.slice(-2*n,-n),ah=Math.max(...a.map(x=>x.h)),al=Math.min(...a.map(x=>x.l)),bh=Math.max(...b.map(x=>x.h)),bl=Math.min(...b.map(x=>x.l));return ah>bh&&al>bl?1:ah<bh&&al<bl?-1:0;}
// === Makro trend (1D) + gözlənilən aralıq ===
// DİQQƏT: bunlar PROQNOZ deyil — heç bir sistem (peşəkar treyder daxil) qiymətin harada olacağını
// dəqiq bilmir. Bunlar SADƏCƏ statistik kontekstdir: (1) gündəlik EMA50/EMA200 münasibətinə görə
// bazarın hansı tərəfə "əyildiyi", (2) son real volatilitəyə (ATR) əsaslanan, qiymətin adətən
// hansı aralıqda hərəkət etdiyi. Bazar istənilən an bu aralığın kənarına çıxa bilər.
function macroTrend(c){
  if(!c||c.length<210)return null;
  const close=c.map(x=>x.c),e50=ema(close,50),e200=ema(close,200);
  if(e50==null||e200==null)return null;
  return e50>e200?1:(e50<e200?-1:0);
}
// ATR √t miqyaslanması — maliyyədə tanınan, təxmini volatilite proyeksiyası (Brownian motion approksimasiyası)
function expectedRange(candles1H,price,hours){
  const av=atr(candles1H);
  if(!av||!price)return null;
  const move=av*Math.sqrt(hours);
  return{low:price-move,high:price+move};
}
// ADX (trend gücü) — istiqamət vermir, ancaq trendin nə qədər real olduğunu ölçür
function adx(c,p=14){
  if(c.length<p*2+1)return null;
  const plusDM=[],minusDM=[],tr=[];
  for(let i=1;i<c.length;i++){
    const up=c[i].h-c[i-1].h, down=c[i-1].l-c[i].l;
    plusDM.push(up>down&&up>0?up:0);
    minusDM.push(down>up&&down>0?down:0);
    tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));
  }
  const atrS=ema(tr,p);if(!atrS)return null;
  const plusDI=100*(ema(plusDM,p)||0)/atrS, minusDI=100*(ema(minusDM,p)||0)/atrS;
  const sum=plusDI+minusDI;
  return sum===0?0:100*Math.abs(plusDI-minusDI)/sum;
}
// VWAP (son N şamda həcm-çəkili orta qiymət) — qiymət VWAP-dan yuxarı/aşağı olması alıcı/satıcı üstünlüyünü göstərir
function vwap(c,n=50){
  if(c.length<n)return null;
  const s=c.slice(-n);let pv=0,vv=0;
  for(const x of s){pv+=((x.h+x.l+x.c)/3)*x.v;vv+=x.v;}
  return vv===0?null:pv/vv;
}
// === Peşəkar treyderlərin əlavə istifadə etdiyi 4 indikator ===
// Ichimoku Cloud — Tenkan/Kijun-a əsaslanan bulud; qiymət buludun üstündə=bullish, altında=bearish
function ichimoku(c){
  if(c.length<52)return null;
  const mid=n=>{const s=c.slice(-n);return(Math.max(...s.map(x=>x.h))+Math.min(...s.map(x=>x.l)))/2;};
  const tenkan=mid(9),kijun=mid(26),spanA=(tenkan+kijun)/2,spanB=mid(52),price=c.at(-1).c;
  const top=Math.max(spanA,spanB),bot=Math.min(spanA,spanB);
  const score=price>top?1:(price<bot?-1:0);
  return{tenkan,kijun,spanA,spanB,score};
}
// Parabolic SAR — trend istiqaməti + dönüş nöqtəsi (sadələşdirilmiş iterativ versiya)
function parabolicSar(c){
  if(c.length<10)return null;
  let af=0.02,maxAf=0.2,sar=c[0].l,ep=c[0].h,uptrend=true;
  for(let i=1;i<c.length;i++){
    sar=sar+af*(ep-sar);
    if(uptrend){
      if(c[i].l<sar){uptrend=false;sar=ep;af=0.02;ep=c[i].l;}
      else if(c[i].h>ep){ep=c[i].h;af=Math.min(af+0.02,maxAf);}
    }else{
      if(c[i].h>sar){uptrend=true;sar=ep;af=0.02;ep=c[i].h;}
      else if(c[i].l<ep){ep=c[i].l;af=Math.min(af+0.02,maxAf);}
    }
  }
  return{sar,uptrend};
}
// Pivot Points (klassik) — əvvəlki tam şamın H/L/C-ə əsaslanan dəstək/müqavimət
function pivotPoints(c){
  if(c.length<2)return null;
  const p=c[c.length-2],pp=(p.h+p.l+p.c)/3;
  return{pp,r1:2*pp-p.l,s1:2*pp-p.h,r2:pp+(p.h-p.l),s2:pp-(p.h-p.l)};
}
// Fibonacci Retracement — son 50 şamın diapazonuna görə 38.2/50/61.8% səviyyələri
function fibLevels(c){
  const n=Math.min(c.length,50),s=c.slice(-n),hi=Math.max(...s.map(x=>x.h)),lo=Math.min(...s.map(x=>x.l)),diff=hi-lo;
  return{hi,lo,r382:hi-diff*0.382,r500:hi-diff*0.5,r618:hi-diff*0.618};
}

function analyze(c){
  if(c.length<60)return null;
  const close=c.map(x=>x.c),price=close.at(-1),e9=ema(close,9),e21=ema(close,21),e50=ema(close,50),e200=ema(close,200),rv=rsi(close),mv=macd(close),bb=bollinger(close),st=stochastic(c),av=atr(c),cv=cci(c),mf=mfi(c),ob=obvTrend(c),str=structure(c),ax=adx(c),vw=vwap(c),ich=ichimoku(c),psar=parabolicSar(c),piv=pivotPoints(c),fib=fibLevels(c);
  let score=0,reasons=[];
  if(e9>e21&&e21>e50){score+=1;reasons.push('EMA trend +');}else if(e9<e21&&e21<e50){score-=1;reasons.push('EMA trend -');}
  if(e200!=null){if(price>e200){score+=1;reasons.push('above EMA200');}else{score-=1;reasons.push('below EMA200');}}
  if(mv>0){score+=1;reasons.push('MACD +');}else if(mv<0){score-=1;reasons.push('MACD -');}
  if(bb){if(price<=bb.lower){score+=1;reasons.push('BB lower');}else if(price>=bb.upper){score-=1;reasons.push('BB upper');}}
  // === Momentum konsensusu (RSI+Stoch+CCI+MFI) ===
  // Bu 4 indikator riyazi olaraq bir-biri ilə güclü korrelyasiyalıdır (hamısı overbought/oversold ölçür).
  // Əvvəllər hərəsi ayrıca ±1 verirdi (max ±4) — bu, YALANÇI konfluensiya yaradırdı: "4 indikator razılaşdı"
  // görünsə də, əslində 1 siqnalın 4 fərqli riyazi ifadəsi idi. İndi TƏK səs kimi sayılır (max ±1),
  // və ən azı 2/4-nin razılaşmasını tələb edir (təkindikator küyünə qarşı filtr).
  const momVotes=[rv<35?1:rv>65?-1:0, st<20?1:st>80?-1:0, cv<-100?1:cv>100?-1:0, mf<25?1:mf>75?-1:0];
  const momSum=momVotes.reduce((a,b)=>a+b,0);
  if(momSum>=2){score+=1;reasons.push(`momentum oversold (${momSum}/4 indikator)`);}
  else if(momSum<=-2){score-=1;reasons.push(`momentum overbought (${-momSum}/4 indikator)`);}
  if(ob>0){score+=1;reasons.push('OBV rising');}else if(ob<0){score-=1;reasons.push('OBV falling');}
  if(str>0){score+=1;reasons.push('higher highs/lows');}else if(str<0){score-=1;reasons.push('lower highs/lows');}
  if(vw!=null){if(price>vw){score+=1;reasons.push('above VWAP');}else{score-=1;reasons.push('below VWAP');}}
  if(ich&&ich.score!==0){if(ich.score>0){score+=1;reasons.push('Ichimoku bulud üzərində');}else{score-=1;reasons.push('Ichimoku bulud altında');}}
  if(psar){if(psar.uptrend){score+=1;reasons.push('Parabolic SAR yüksəliş');}else{score-=1;reasons.push('Parabolic SAR düşüş');}}
  if(piv){if(price>piv.pp){score+=1;reasons.push('Pivot üzərində');}else if(price<piv.pp){score-=1;reasons.push('Pivot altında');}}
  if(fib){if(price>fib.r500){score+=1;reasons.push('Fib 50% üzərində');}else{score-=1;reasons.push('Fib 50% altında');}}
  // Momentum konsolidasiyasından sonra max mümkün score 15-dən 12-yə düşür (12 müstəqil komponent)
  let confidence=Math.round(Math.min(100,Math.abs(score)/12*100));
  // ADX trendin real/saxta olduğunu göstərir: güclü trenddə confidence yüksəlir, "chop" bazarda aşağı düşür
  if(ax!=null){
    if(ax>=25){confidence=Math.min(100,confidence+8);reasons.push(`ADX güclü trend (${ax.toFixed(0)})`);}
    else if(ax<15){confidence=Math.max(0,confidence-12);reasons.push(`ADX zəif/yan bazar (${ax.toFixed(0)})`);}
  }
  let signal=score>=4?'LONG':score<=-4?'SHORT':'WAIT';
  // === Chop filtri: ADX çox zəifdirsə (yan bazar), indikatorlar nə qədər "razılaşsa" belə etibar etmə ===
  // Bu, mübadilə indikatorlarının ən çox yanıldığı şərait — trend yoxdur, hər siqnal təsadüfi sayıla bilər.
  const MIN_ADX=Number(process.env.MIN_ADX||15);
  if(signal!=='WAIT' && ax!=null && ax<MIN_ADX){
    reasons.push(`Chop filtri: ADX (${ax.toFixed(0)}) < ${MIN_ADX} — siqnal WAIT-a endirildi`);
    signal='WAIT';
  }
  if(!av)return{signal,confidence,score,price,adx:ax,vwap:vw,reasons};
  const swingLow=Math.min(...c.slice(-20).map(x=>x.l)),swingHigh=Math.max(...c.slice(-20).map(x=>x.h));
  let sl=null,tp1=null,tp2=null,tp3=null,rr=0;
  if(signal==='LONG'){sl=Math.min(swingLow,price-av*1.25);const risk=price-sl;tp1=price+risk;tp2=price+2*risk;tp3=price+3*risk;rr=Math.abs(tp2-price)/Math.abs(price-sl);}
  else if(signal==='SHORT'){sl=Math.max(swingHigh,price+av*1.25);const risk=sl-price;tp1=price-risk;tp2=price-2*risk;tp3=price-3*risk;rr=Math.abs(tp2-price)/Math.abs(price-sl);}
  return{signal,confidence,score,price,sl,tp1,tp2,tp3,rr,atr:av,rsi:rv,adx:ax,vwap:vw,ema9:e9,ema21:e21,ema50:e50,ema200:e200,ichimoku:ich,psar,pivot:piv,fib,reasons};
}

// Manual (etibar faizindən asılı olmayan) giriş üçün SL/TP hesablayır — istifadəçi 72%-i gözləmədən
// özü LONG/SHORT seçəndə belə, stop-loss/take-profit yenə ATR + son 20 şamın structure-una görə,
// TƏSADÜFİ deyil, məntiqli yerə qoyulur.
function directionalLevels(c,side){
  if(c.length<60)return null;
  const close=c.map(x=>x.c),price=close.at(-1),av=atr(c);
  if(!av)return{price};
  const swingLow=Math.min(...c.slice(-20).map(x=>x.l)),swingHigh=Math.max(...c.slice(-20).map(x=>x.h));
  let sl,tp1,tp2,tp3,rr;
  if(side==='LONG'){sl=Math.min(swingLow,price-av*1.25);const risk=price-sl;tp1=price+risk;tp2=price+2*risk;tp3=price+3*risk;rr=Math.abs(tp2-price)/Math.abs(price-sl);}
  else{sl=Math.max(swingHigh,price+av*1.25);const risk=sl-price;tp1=price-risk;tp2=price-2*risk;tp3=price-3*risk;rr=Math.abs(tp2-price)/Math.abs(price-sl);}
  return{price,sl,tp1,tp2,tp3,rr,atr:av};
}

async function fetchCandleHistory(symbol,tf){
  let all=[],after='';
  for(let page=0;page<4;page++){
    const params={instId:symbol,bar:tf,limit:'300'};
    if(after)params.after=after;
    // OKX-un sürət limitini aşmamaq üçün səhifələr arası kiçik fasilə (əvvəllər yox idi — 30 coin × 6 TF
    // ilə birləşəndə sürət limitini aşırdı, nəticədə şam datası yüklənmirdi və heç bir Telegram bildirişi getmirdi)
    if(page>0)await new Promise(r=>setTimeout(r,120));
    let d;
    try{ d=await okxPublic('/api/v5/market/candles',params); }
    catch(e){
      // 429/rate-limit görsə bir dəfə 800ms gözləyib təkrar sına, sonra tam bu simvolu ötür
      await new Promise(r=>setTimeout(r,800));
      try{ d=await okxPublic('/api/v5/market/candles',params); }catch(e2){ console.error(`fetchCandleHistory retry failed ${symbol} ${tf}:`,e2.message); break; }
    }
    if(!d.length)break;
    all=all.concat(d);after=d.at(-1)?.[0];if(d.length<300)break;
  }
  const map=new Map();
  for(const k of all){map.set(+k[0],{t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],confirm:+k[8]});}
  state.candles.set(key(symbol,tf),[...map.values()].sort((a,b)=>a.t-b.t).slice(-1000));
}
function getCandles(symbol,tf){return state.candles.get(key(symbol,tf))||[];}
// === TF konfluensiya / trigger məntiqi ===
// Əsas qayda (istifadəçinin istədiyi kimi): sürətli timeframe (1m) ilə yuxarı timeframe (1H)
// EYNİ istiqaməti göstərəndə bu, erkən "giriş triqqeri" sayılır — hətta əsas siqnal hələ WAIT-da
// olsa belə (4/5 TF hədəfi tam ötməyib), 1m+1H uyğunluğu bazarın hansı tərəfə meyilləndiyini göstərir.
// Bunu əsas LONG/SHORT siqnalı ilə QARIŞDIRMAMAQ üçün ayrıca "trigger" sahəsi kimi qaytarılır.
function computeConfluence(tfMap){
  const order=['1m','5m','15m','1H','4H'];
  const sig=tf=>tfMap[tf]?.signal||null;
  const longs=order.filter(tf=>sig(tf)==='LONG').length;
  const shorts=order.filter(tf=>sig(tf)==='SHORT').length;
  const waits=order.length-longs-shorts;
  // Trigger: sürətli TF (1m) həm 5m, həm də 1H (trend filtri) ilə eyni istiqamətdədirsə -> güclü erkən işarə
  const fast=sig('1m'), midf=sig('5m'), trendf=sig('1H');
  let trigger=null;
  if(fast && fast!=='WAIT' && fast===trendf){
    trigger={dir:fast, tfs: fast===midf?['1m','5m','1H']:['1m','1H'], strong: fast===midf};
  }
  return{longs,shorts,waits,total:order.length,trigger};
}
async function fullAnalysis(symbol){
  const frames=TIMEFRAMES,a={};for(const tf of frames)a[tf]=analyze(getCandles(symbol,tf));
  const valid=frames.map(x=>a[x]).filter(Boolean);if(valid.length<5)return null;
  const longs=valid.filter(x=>x.signal==='LONG').length,shorts=valid.filter(x=>x.signal==='SHORT').length;
  let final='WAIT';if(longs>=4)final='LONG';else if(shorts>=4)final='SHORT';
  // === HTF (1H/4H) veto ===
  // Aşağı timeframe-lər (1m/5m/15m) tez-tez qısamüddətli küy yaradır. Əgər 4/5 TF "razılaşsa" belə,
  // əsas trend timeframe-ləri (1H, 4H) əks istiqamətdə göstərirsə, bu, real yanlış siqnal riskidir —
  // əvvəllər HTF-in fikri nəzərə alınmırdı. İndi 1H və ya 4H açıq şəkildə əksinə deyirsə, WAIT-a düşür.
  const htf1h=a['1H']?.signal, htf4h=a['4H']?.signal;
  if(final==='LONG' && (htf1h==='SHORT' || htf4h==='SHORT')) final='WAIT';
  if(final==='SHORT' && (htf1h==='LONG' || htf4h==='LONG')) final='WAIT';
  const base=a['15m'];if(!base)return null;
  let conf=Math.round(valid.reduce((s,x)=>s+x.confidence,0)/valid.length);
  const fundingRate=state.fundingRate.get(symbol)??null;
  const openInterest=state.openInterest.get(symbol)??null;
  const oiDir=oiTrend(symbol);
  // Funding + OI konteksti ilə confidence-i düzəlt (əsasən BTC üçün dəqiqləşir, çünki BTC ən likvid perpetual-dır)
  if(final==='LONG'&&fundingRate!=null){if(fundingRate<0){conf=Math.min(100,conf+6);}else if(fundingRate>0.0005){conf=Math.max(0,conf-6);}}
  if(final==='SHORT'&&fundingRate!=null){if(fundingRate>0){conf=Math.min(100,conf+6);}else if(fundingRate<-0.0005){conf=Math.max(0,conf-6);}}
  if(final==='LONG'&&oiDir>0)conf=Math.min(100,conf+4);
  if(final==='SHORT'&&oiDir>0)conf=Math.min(100,conf+4);
  const confluence=computeConfluence(a);
  const macro=macroTrend(getCandles(symbol,MACRO_TF));
  const range4h=expectedRange(getCandles(symbol,'1H'),base.price,4);
  const range24h=expectedRange(getCandles(symbol,'1H'),base.price,24);
  return{...base,signal:final,confidence:conf,timeframes:a,symbol,fundingRate,openInterest,oiTrend:oiDir,confluence,macroTrend:macro,range4h,range24h};
}
async function loadInstruments(){const d=await okxPublic('/api/v5/public/instruments',{instType:'SWAP'});for(const x of d)if(symbols.includes(x.instId))state.instruments.set(x.instId,x);}

// Funding rate + open interest — BTC (və digər perpetual SWAP) siqnalını gücləndirmək üçün əlavə kontekst.
// Mənfi funding rate = short-lar long-lara ödəyir (bazar həddindən artıq satılmış/oversold ola bilər -> LONG üçün dəstək)
// Müsbət funding rate = long-lar short-lara ödəyir (bazar həddindən artıq alınmış -> SHORT üçün dəstək)
async function fetchFundingAndOI(symbol){
  try{
    const fr=await okxPublic('/api/v5/public/funding-rate',{instId:symbol});
    if(fr?.[0]) state.fundingRate.set(symbol,Number(fr[0].fundingRate));
  }catch(e){}
  try{
    const oi=await okxPublic('/api/v5/public/open-interest',{instId:symbol,instType:'SWAP'});
    if(oi?.[0]){
      const val=Number(oi[0].oi);
      const hist=state.oiHistory.get(symbol)||[];
      hist.push({t:Date.now(),v:val});
      state.oiHistory.set(symbol,hist.slice(-50));
      state.openInterest.set(symbol,val);
    }
  }catch(e){}
}
function oiTrend(symbol){
  const hist=state.oiHistory.get(symbol)||[];
  if(hist.length<5) return 0;
  const first=hist[0].v, last=hist.at(-1).v;
  if(first===0) return 0;
  const pct=(last-first)/first;
  return pct>0.005?1:pct<-0.005?-1:0;
}

async function telegram(method,body){
  if(!TELEGRAM_TOKEN){console.error(`[telegram] ${method} çağırıla bilmədi: TELEGRAM_BOT_TOKEN boşdur`);return null;}
  let r,j;
  try{
    r=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    j=await r.json();
  }catch(e){console.error(`[telegram] ${method} şəbəkə xətası:`,e.message);return null;}
  if(j && j.ok===false){
    // Telegram API özü xəta qaytarıb (səhv token, səhv chat_id, webhook conflict və s.) — bunu HƏMİŞƏ görünən et.
    console.error(`[telegram] ${method} rədd edildi — code:${j.error_code} desc:${j.description}`);
  }
  return j;
}
async function sendTelegram(text,extra={}){
  if(!TELEGRAM_TOKEN){console.error('[telegram] Mesaj göndərilmədi: TELEGRAM_BOT_TOKEN boşdur (Railway Variables-a bax)');return;}
  if(!TELEGRAM_CHAT_ID){console.error('[telegram] Mesaj göndərilmədi: TELEGRAM_CHAT_ID boşdur (Railway Variables-a bax)');return;}
  const j=await telegram('sendMessage',{chat_id:TELEGRAM_CHAT_ID,text,parse_mode:'HTML',...extra});
  if(j && j.ok===false && j.error_code===400 && /chat not found/i.test(j.description||'')){
    console.error('[telegram] TELEGRAM_CHAT_ID YANLIŞDIR — bu chat_id ilə söhbət tapılmadı. Bota /start yazıb getUpdates ilə düzgün chat.id-ni tap.');
  }
}
function fmt(x){return x==null?'--':Number(x).toLocaleString('en-US',{maximumFractionDigits:8});}
function confBar(pct){
  const filled=Math.round((pct||0)/10);
  return '█'.repeat(filled)+'░'.repeat(10-filled);
}
// Etibar faizi + volatiliyə (ATR%) görə TÖVSİYƏ EDİLƏN leverage aralığı — bu maliyyə məsləhəti deyil,
// sadəcə riyazi heuristikdir: yüksək etibar + aşağı volatilite -> daha geniş leverage aralığına icazə,
// aşağı etibar/yüksək volatilite -> ehtiyatlı, aşağı leverage. Son qərar həmişə istifadəçinindir.
function suggestLeverage(confidence,atrPct){
  if(atrPct==null)return '2x–3x (ehtiyatlı)';
  if(confidence>=85&&atrPct<1.5)return '5x–10x';
  if(confidence>=72&&atrPct<2.5)return '3x–5x';
  if(confidence>=50)return '2x–3x';
  return '1x–2x (yüksək risk)';
}
function signalMessage(r){
  const sym=prettySymbol(r.symbol);
  const atrPct=(r.atr!=null&&r.price)?(r.atr/r.price*100):null;
  const macroLine=r.macroTrend!=null?`📅 Makro (1D): ${r.macroTrend===1?'🟢 yuxarı':r.macroTrend===-1?'🔴 aşağı':'⚪ neytral'}`:null;
  const rangeLines=[];
  if(r.range4h)rangeLines.push(`📊 4H aralıq: <code>${fmt(r.range4h.low)} – ${fmt(r.range4h.high)}</code>`);
  if(r.range24h)rangeLines.push(`📊 24H aralıq: <code>${fmt(r.range24h.low)} – ${fmt(r.range24h.high)}</code>`);
  if(r.signal==='WAIT'){
    const lines=[
      `⚪ <b>${sym}</b> — GÖZLƏ`,
      `Etibar: <b>${r.confidence}%</b> ${confBar(r.confidence)}`
    ];
    if(r.confluence){
      lines.push(`Uyğunluq: 🟢${r.confluence.longs}/5 🔴${r.confluence.shorts}/5 ⚪${r.confluence.waits}/5 (min. 4/5)`);
      const t=r.confluence.trigger;
      if(t&&t.dir!==r.signal)lines.push(`🎯 Erkən (${t.tfs.join('+')}): ${t.dir==='LONG'?'AL':'SAT'} formalaşır`);
    }
    if(macroLine)lines.push(macroLine);
    lines.push(...rangeLines);
    return lines.join('\n');
  }
  const dirWord=r.signal==='LONG'?'🟢 LONG (AL)':'🔴 SHORT (SAT)';
  const lines=[
    `💎 <b>${sym}</b>`,
    `${dirWord}   Etibar: <b>${r.confidence}%</b> ${confBar(r.confidence)}`,
    `📍 Giriş: <code>${fmt(r.price)}</code>`,
    `🎯 Çıxış: <code>${fmt(r.tp2)}</code>  <i>(TP1 ${fmt(r.tp1)} · TP3 ${fmt(r.tp3)})</i>`,
    `🛑 Stop Loss: <code>${fmt(r.sl)}</code>`,
    `⚙️ Leverage: <b>${suggestLeverage(r.confidence,atrPct)}</b>   R:R 1:${r.rr.toFixed(2)}`
  ];
  if(macroLine)lines.push(macroLine);
  lines.push(...rangeLines);
  return lines.join('\n');
}

async function getBalance(){const d=await okxPrivate('GET','/api/v5/account/balance');return d?.[0]||null;}
async function getTickerPrice(symbol){const d=await okxPublic('/api/v5/market/ticker',{instId:symbol});return d?.[0]?Number(d[0].last):null;}
async function getOpenPositions(){const d=await okxPrivate('GET','/api/v5/account/positions',{instType:'SWAP'});state.positions=d||[];return state.positions.filter(p=>Number(p.pos||0)!==0);}
async function setLeverage(instId,lever=DEFAULT_LEVERAGE){return okxPrivate('POST','/api/v5/account/set-leverage',{instId,mgnMode:'cross',lever:String(lever)});}
async function closePosition(symbol){
  if(!TRADING_ENABLED)throw new Error('TRADING_ENABLED=false');
  const positions=await getOpenPositions();
  const p=positions.find(x=>x.instId===symbol && Number(x.pos)!==0);
  if(!p)throw new Error(`Açıq mövqe yoxdur: ${symbol}`);
  const size=Math.abs(Number(p.pos));
  const side=Number(p.pos)>0?'sell':'buy';
  const body={instId:symbol,tdMode:'cross',side,ordType:'market',sz:String(size),posSide:'net',reduceOnly:true};
  const res=await okxPrivate('POST','/api/v5/trade/order',body);
  await sendTelegram(`<b>🛑 POSITION CLOSE</b>\n${symbol}\nSize: ${size}\nOrder ID: <code>${res?.[0]?.ordId||'--'}</code>`);
  return res;
}

// Gündəlik equity-i izləyir; itki həddi aşılarsa auto-trade-i dayandırır (kill-switch).
// Hər gün (UTC) ilk çağırışda "günün başlanğıc equity"-si qeyd olunur, sonra hər yoxlamada faiz düşüş hesablanır.
async function checkDailyLossLimit(){
  if(MAX_DAILY_LOSS_PCT<=0) return; // limit deaktiv edilib
  try{
    const bal=await getBalance();
    const eq=Number(bal?.totalEq||0);
    if(!eq) return;
    const now=Date.now(), dayMs=24*60*60*1000;
    if(!state.dayStartEquity || now-state.dayStartAt>dayMs){
      state.dayStartEquity=eq; state.dayStartAt=now; state.tradingHalted=false; state.haltReason=null;
      saveState();
      return;
    }
    const dropPct=((state.dayStartEquity-eq)/state.dayStartEquity)*100;
    if(dropPct>=MAX_DAILY_LOSS_PCT && !state.tradingHalted){
      state.tradingHalted=true;
      state.haltReason=`Gündəlik zərər limiti aşıldı: -${dropPct.toFixed(2)}% (limit ${MAX_DAILY_LOSS_PCT}%)`;
      saveState();
      await sendTelegram(`<b>🛑 KILL-SWITCH AKTİVLƏŞDİ</b>\n${state.haltReason}\nAuto-trade dayandırıldı. Manual olaraq /resume ilə skaneri işə sala bilərsən, amma auto-trade yalnız növbəti gün equity sıfırlanandan sonra bərpa olunur.`);
    }
  }catch(e){ state.lastError='dailyLossCheck: '+e.message; }
}

async function executeTrade(symbol,r){
  if(!TRADING_ENABLED)throw new Error('TRADING_ENABLED=false');
  if(state.tradingHalted)throw new Error(`Trading halted: ${state.haltReason||'kill-switch active'}`);
  await checkDailyLossLimit();
  if(state.tradingHalted)throw new Error(`Trading halted: ${state.haltReason||'kill-switch active'}`);
  // Eyni simvolda artıq açıq mövqe varsa, üstünə əlavə order göndərmə (double-up qarşısı)
  const openPositions=await getOpenPositions();
  if(openPositions.some(p=>p.instId===symbol && Number(p.pos||0)!==0)){
    throw new Error(`${symbol} üçün artıq açıq mövqe var — yeni order göndərilmədi`);
  }
  // Slippage qoruması: siqnal analiz olunandan icra anına qədər qiymət çox dəyişibsə, order göndərmə
  // (bazar sürətlə hərəkət edəndə köhnə SL/TP hesablamalarına əsasən market order açmaq riskli olur)
  try{
    const live=await getTickerPrice(symbol);
    if(live){
      const movePct=Math.abs(live-r.price)/r.price*100;
      if(movePct>MAX_SLIPPAGE_PCT){
        throw new Error(`Slippage limiti aşıldı: siqnal ${fmt(r.price)}, cari ${fmt(live)} (${movePct.toFixed(2)}% > ${MAX_SLIPPAGE_PCT}%)`);
      }
    }
  }catch(e){ if(String(e.message).includes('Slippage')) throw e; /* ticker sorğusu uğursuz olsa, sükutla davam et */ }
  const bal=await getBalance();const avail=Number(bal?.details?.find(x=>x.ccy==='USDT')?.availEq||0);if(avail<=0)throw new Error('No available USDT');
  const inst=state.instruments.get(symbol);if(!inst)throw new Error(`Instrument metadata missing: ${symbol}`);
  const riskUSDT=avail*RISK_PER_TRADE,stopDist=Math.abs(r.price-r.sl);if(!stopDist)throw new Error('Invalid stop distance');
  const ctVal=Number(inst.ctVal||0);if(!ctVal)throw new Error(`Missing ctVal for ${symbol}`);
  const lot=Number(inst.lotSz||1),min=Number(inst.minSz||lot);let contracts=riskUSDT/(stopDist*ctVal);contracts=Math.floor(contracts/lot)*lot;contracts=Math.max(min,contracts);
  const atrPct=(r.atr!=null&&r.price)?(r.atr/r.price*100):null;
  const leverage=resolveLeverage(symbol,r.confidence,atrPct);
  await setLeverage(symbol,leverage);
  const side=r.signal==='LONG'?'buy':'sell';
  const body={instId:symbol,tdMode:'cross',side,ordType:'market',sz:String(contracts),posSide:'net',attachAlgoOrds:[{tpTriggerPx:String(r.tp2),tpOrdPx:'-1',tpTriggerPxType:'mark',slTriggerPx:String(r.sl),slOrdPx:'-1',slTriggerPxType:'mark'}]};
  const res=await okxPrivate('POST','/api/v5/trade/order',body);
  const ordId=res?.[0]?.ordId;
  if(res?.[0]?.sCode && res[0].sCode!=='0'){
    // OKX order-i qəbul etmədi (rədd etdi) — bunu sükutla keçmə, aydın xəbərdarlıq göndər
    await sendTelegram(`<b>⚠️ ORDER REJECTED</b>\n${symbol} ${r.signal}\nCode: ${res[0].sCode}\nMsg: ${res[0].sMsg||'--'}`);
    throw new Error(`OKX rejected order: ${res[0].sMsg||res[0].sCode}`);
  }
  await sendTelegram(`<b>🚀 ORDER SENT</b>\n${symbol}\n${r.signal}\nSize: ${contracts}\nLeverage: ${leverage}x\nEntry ref: ${fmt(r.price)}\nSL: ${fmt(r.sl)}\nTP2: ${fmt(r.tp2)}\nOrder ID: <code>${ordId||'--'}</code>`);
  return res;
}

async function scan(){
  if(!state.scannerEnabled)return;
  if(TRADING_ENABLED) await checkDailyLossLimit();
  for(const symbol of activeSymbols){
    try{
      if(symbol===BTC_SYMBOL) await fetchFundingAndOI(symbol);
      const r=await fullAnalysis(symbol);if(!r)continue;state.lastAnalysis.set(symbol,r);
      const now=Date.now(),prev=state.signals.find(x=>x.symbol===symbol),lastAt=state.lastSignalAt.get(symbol)||0;
      const prevConf=state.lastReportedConfidence.get(symbol);
      const signalChanged=!prev||prev.signal!==r.signal;
      const confChanged=prevConf==null||Math.abs(r.confidence-prevConf)>=CONFIDENCE_STEP;
      const cooldownMin=symbol===BTC_SYMBOL?BTC_COOLDOWN_MIN:SIGNAL_COOLDOWN_MIN;
      const cooldownPassed=now-lastAt>cooldownMin*60000;
      // Yalnız real dəyişiklik olanda (siqnal dəyişib / etibar faizi CONFIDENCE_STEP qədər dəyişib / cooldown ötüb)
      // bildiriş göndərilir — BTC da daxil olmaqla. Bu, Telegram-ın hər 15 saniyədə eyni WAIT mesajı ilə
      // dolmasının qarşısını alır (əvvəlki versiyada BTC üçün "forceNotify" var idi, silindi).
      if(signalChanged||confChanged||cooldownPassed){
        const item={...r,time:now};state.signals.unshift(item);state.signals=state.signals.slice(0,200);
        state.lastSignalAt.set(symbol,now);state.lastReportedConfidence.set(symbol,r.confidence);
        await sendTelegram(signalMessage(r));
        if(r.signal!=='WAIT'&&r.confidence>=MIN_CONFIDENCE&&r.rr>=MIN_RR&&AUTO_TRADE&&TRADING_ENABLED){
          const open=await getOpenPositions();if(open.length<MAX_OPEN_POSITIONS)await executeTrade(symbol,r);
        }
      }
    }catch(e){state.lastError=e.message;}
  }
  broadcast({type:'scanner',signals:state.signals.slice(0,20),positions:state.positions,server:publicState()});
}

function publicState(){return{online:state.online,scannerEnabled:state.scannerEnabled,uptime:Date.now()-state.startedAt,lastMarketUpdate:state.lastMarketUpdate,lastError:state.lastError,signals:state.signals.slice(0,20),positions:state.positions,symbols:activeSymbols,liveTrading:TRADING_ENABLED,autoTrade:AUTO_TRADE,demo:DEMO,wsConnected:state.wsConnected,tradingHalted:state.tradingHalted,haltReason:state.haltReason};}
function broadcast(data){const s=JSON.stringify(data);for(const ws of state.clients){if(ws.readyState===WebSocket.OPEN)ws.send(s);}}

let wsEverConnected=false;
function connectMarketWS(){
  const ws=new WebSocket(OKX_WS);
  ws.on('open',async()=>{
    const wasReconnect=wsEverConnected;
    state.wsConnected=true;wsEverConnected=true;
    ws.send(JSON.stringify({op:'subscribe',args:activeSymbols.flatMap(instId=>[...TIMEFRAMES,MACRO_TF].map(channel=>({channel:`candle${channel}`,instId})))}));
    broadcast({type:'state',...publicState()});
    if(wasReconnect){
      // Qırılma müddətində yaranan şam boşluğunu doldur (əks halda analiz köhnə/natamam data üzərində qalır)
      for(const s of activeSymbols)for(const tf of TIMEFRAMES){
        try{await fetchCandleHistory(s,tf);}catch(e){}
        await new Promise(r=>setTimeout(r,150));
      }
    }
  });
  ws.on('message',raw=>{try{const j=JSON.parse(raw);if(!j.data||!j.arg?.instId)return;const symbol=j.arg.instId;const channel=j.arg.channel.replace('candle','');for(const k of j.data){const x={t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],confirm:+k[8]};let a=state.candles.get(key(symbol,channel))||[];const i=a.findIndex(z=>z.t===x.t);if(i>=0)a[i]=x;else a.push(x);state.candles.set(key(symbol,channel),a.sort((p,q)=>p.t-q.t).slice(-1000));state.lastMarketUpdate=Date.now();} }catch(e){state.lastError=e.message;}});
  ws.on('close',()=>{state.wsConnected=false;broadcast({type:'state',...publicState()});setTimeout(connectMarketWS,3000);});
  ws.on('error',()=>ws.close());
}

async function telegramLoop(){
  if(!TELEGRAM_TOKEN){console.error('[telegram] Polling başlamadı: TELEGRAM_BOT_TOKEN boşdur');return;}
  if(state.telegramRunning)return;
  state.telegramRunning=true;
  console.log('[telegram] Uzun-polling (getUpdates) başladı — mesajlar gözlənilir...');
  while(state.telegramRunning){
    try{
      const j=await telegram('getUpdates',{offset:state.telegramOffset+1,timeout:30,allowed_updates:['message']});
      if(!j || j.ok===false){
        // telegram() artıq xətanı loglayıb — burda sadəcə həddindən artıq sürətli təkrarlanmasının qarşısını alırıq
        await new Promise(r=>setTimeout(r,3000));
        continue;
      }
      for(const u of j.result||[]){
        state.telegramOffset=u.update_id;
        const msg=u.message;
        if(!msg?.text)continue;
        console.log(`[telegram] Mesaj alındı: chat.id=${msg.chat.id} text="${msg.text}"`);
        if(TELEGRAM_CHAT_ID && String(msg.chat.id)!==String(TELEGRAM_CHAT_ID)){
          console.warn(`[telegram] Mesaj İGNOR edildi — gələn chat.id (${msg.chat.id}) TELEGRAM_CHAT_ID (${TELEGRAM_CHAT_ID}) ilə uyğun gəlmir`);
          continue;
        }
        await handleTelegram(msg.text.trim());
      }
    }catch(e){
      console.error('[telegram] Polling istisna:',e.message);
      state.lastError=e.message;
      await new Promise(r=>setTimeout(r,3000));
    }
  }
}

// Server başlayanda bir dəfə çağrılır: token/chat_id-nin doğru olduğunu TƏSDİQLƏYİR və
// köhnə/unudulmuş webhook varsa avtomatik silir (webhook aktiv olsa getUpdates işləməz).
async function verifyTelegramSetup(){
  if(!TELEGRAM_TOKEN){console.error('[telegram] ❌ TELEGRAM_BOT_TOKEN təyin edilməyib — bot komandaları tamamilə işləməyəcək.');return false;}
  const me=await telegram('getMe',{});
  if(!me || me.ok===false){console.error('[telegram] ❌ TELEGRAM_BOT_TOKEN yanlışdır — Telegram bu tokeni tanımadı.');return false;}
  console.log(`[telegram] ✅ Bot tapıldı: @${me.result.username}`);

  const wh=await telegram('getWebhookInfo',{});
  if(wh?.ok && wh.result?.url){
    console.warn(`[telegram] ⚠️ Aktiv webhook tapıldı (${wh.result.url}) — getUpdates ilə eyni vaxtda işləmir, avtomatik silinir...`);
    await telegram('deleteWebhook',{});
  }

  if(!TELEGRAM_CHAT_ID){console.error('[telegram] ❌ TELEGRAM_CHAT_ID təyin edilməyib — bot heç kimə mesaj göndərə bilməyəcək.');return false;}
  const test=await telegram('sendMessage',{chat_id:TELEGRAM_CHAT_ID,text:'🔧 Telegram bağlantısı yoxlanılır...'});
  if(!test || test.ok===false){
    console.error(`[telegram] ❌ TELEGRAM_CHAT_ID (${TELEGRAM_CHAT_ID}) ilə test mesajı göndərilmədi — code:${test?.error_code} desc:${test?.description}`);
    console.error('[telegram] Düzəliş: bota Telegram-da bir mesaj yaz, sonra https://api.telegram.org/bot<TOKEN>/getUpdates linkindən doğru chat.id-ni tap və Railway Variables-a yaz.');
    return false;
  }
  console.log('[telegram] ✅ Test mesajı uğurla göndərildi — token və chat_id doğrudur.');
  return true;
}
async function handleTelegram(cmd){
  const [c,...args]=cmd.split(/\s+/),name=c.toLowerCase();
  if(name==='/start'||name==='/status')return sendTelegram(`<b>SIQNAL PRO ONLINE</b>\nScanner: ${state.scannerEnabled?'🟢':'🔴'}\nTrading: ${TRADING_ENABLED?'🟢':'🔴'}\nAuto trade: ${AUTO_TRADE?'🟢':'🔴'} (min. etibar: ${MIN_CONFIDENCE}%, min. R:R: 1:${MIN_RR}, min. ADX: ${process.env.MIN_ADX||15})\nKill-switch: ${state.tradingHalted?`🛑 ${state.haltReason}`:'🟢 aktiv deyil'}\nWS: ${state.wsConnected?'🟢':'🔴'}\nUptime: ${Math.floor((Date.now()-state.startedAt)/3600000)}h\n\nManual giriş üçün: /open SYMBOL LONG|SHORT CONFIRM`);
  if(name==='/stop'){state.scannerEnabled=false;return sendTelegram('🛑 Scanner dayandırıldı.');}
  if(name==='/resume'||name==='/startscan'){state.scannerEnabled=true;return sendTelegram('🟢 Scanner aktivdir.');}
  if(name==='/signals')return sendTelegram(state.signals.slice(0,5).map(x=>signalMessage(x)).join('\n\n')||'Siqnal yoxdur.');
  if(name==='/positions'){try{const p=await getOpenPositions();return sendTelegram(p.map(x=>`${x.instId} ${x.posSide||'net'} size=${x.pos} avg=${x.avgPx} upl=${x.upl}`).join('\n')||'Açıq mövqe yoxdur.');}catch(e){return sendTelegram('OKX: '+e.message);}}
  if(name==='/balance'){try{const b=await getBalance();return sendTelegram(`USDT equity: ${b?.totalEq||'--'}\nAvailable: ${b?.details?.find(x=>x.ccy==='USDT')?.availEq||'--'}`);}catch(e){return sendTelegram('OKX: '+e.message);}}
  if(name==='/analyse'||name==='/analyze'){const s=args[0]||activeSymbols[0];const r=await fullAnalysis(s);return sendTelegram(r?signalMessage(r):'Analiz üçün kifayət qədər data yoxdur.');}
  if(name==='/close'){const s=args[0];if(!s)return sendTelegram('İstifadə: /close BTC-USDT-SWAP');try{await closePosition(s);return;}catch(e){return sendTelegram('Close xətası: '+e.message);}}
  // === Manual giriş: 72% (MIN_CONFIDENCE) həddini gözləmədən İSTƏNİLƏN VAXT özün AL/SAT aça bilərsən ===
  // Botun avtomatik ticarəti (AUTO_TRADE) hələ də yalnız MIN_CONFIDENCE-dən yuxarı siqnallarda işə düşür —
  // bu komanda YALNIZ sənin əl ilə, şüurlu şəkildə açdığın mövqelər üçündür. Səhvən basmamaq üçün
  // sonuna mütləq "CONFIRM" yazmalısan.
  if(name==='/open'){
    const s=(args[0]||'').toUpperCase(), side=(args[1]||'').toUpperCase(), confirm=(args[2]||'').toUpperCase();
    if(!s||!['LONG','SHORT'].includes(side))return sendTelegram('İstifadə: /open BTC-USDT-SWAP LONG CONFIRM  (və ya SHORT)\nBu, etibar faizindən (72%) asılı olmadan DƏRHAL manual sifariş göndərir.');
    if(!activeSymbols.includes(s))return sendTelegram(`Naməlum simvol: ${s}\nAktiv simvollar: ${activeSymbols.join(', ')}`);
    if(!TRADING_ENABLED)return sendTelegram('TRADING_ENABLED=false — real ticarət server tərəfdə deaktivdir, açıla bilməz.');
    if(confirm!=='CONFIRM')return sendTelegram(`⚠️ Bu, real pulla ${side} mövqeyi açacaq (${s}).\nƏmin olduğunu təsdiqləmək üçün sonuna "CONFIRM" əlavə edib yenidən göndər:\n/open ${s} ${side} CONFIRM`);
    try{
      const r=await fullAnalysis(s);
      if(!r)return sendTelegram('Kifayət qədər data yoxdur, bir az sonra yenidən yoxla.');
      const lv=directionalLevels(getCandles(s,'15m'),side);
      if(!lv||lv.sl==null)return sendTelegram('SL/TP hesablamaq üçün kifayət qədər şam datası yoxdur (15m).');
      const manual={...r,signal:side,price:lv.price,sl:lv.sl,tp1:lv.tp1,tp2:lv.tp2,tp3:lv.tp3,rr:lv.rr};
      if(r.confidence<MIN_CONFIDENCE){
        await sendTelegram(`⚠️ DİQQƏT: Hazırkı etibar faizi ${r.confidence}% — tövsiyə olunan minimumdan (${MIN_CONFIDENCE}%) aşağıdır.\nBu, botun özünün seçdiyi güclü siqnal deyil, sənin manual qərarındır. Risk sənin üzərindədir — davam edilir...`);
      }
      if(manual.rr<MIN_RR){
        await sendTelegram(`⚠️ DİQQƏT: R:R nisbəti (1:${manual.rr.toFixed(2)}) minimumdan (1:${MIN_RR}) aşağıdır — risk mükafata nisbətən yüksəkdir. Davam edilir...`);
      }
      await executeTrade(s,manual);
    }catch(e){return sendTelegram('Manual open xətası: '+e.message);}
    return;
  }
  return sendTelegram('Komandalar: /status /signals /positions /balance /analyse BTC-USDT-SWAP /open BTC-USDT-SWAP LONG CONFIRM /close BTC-USDT-SWAP /stop /resume');
}

const app=express();app.use(express.json());app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin',process.env.CORS_ORIGIN||'*');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-API-Key');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(204);next();});

// === Auth: pul/mövqe ilə bağlı (state-dəyişdirən) endpoint-lər ADMIN_API_KEY tələb edir ===
// CORS_ORIGIN "*"-a açıq olsa belə, açar olmadan heç kim trade/close/scanner sorğusu göndərə bilməz.
// ADMIN_API_KEY təyin edilməyibsə, bu endpoint-lər tamamilə bağlıdır (fail-safe: default qapalı).
function requireAdmin(req,res,next){
  if(!ADMIN_API_KEY) return res.status(503).json({error:'ADMIN_API_KEY server-də təyin edilməyib — bu endpoint deaktivdir'});
  const key=req.get('X-API-Key')||'';
  const a=Buffer.from(key), b=Buffer.from(ADMIN_API_KEY);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({error:'unauthorized'});
  next();
}

app.get('/api/health',(req,res)=>res.json(publicState()));
app.post('/api/notify',requireAdmin,async(req,res)=>{try{const text=String(req.body?.text||'').slice(0,3900);if(!text)return res.status(400).json({error:'text is required'});await sendTelegram(text);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/state',(req,res)=>res.json(publicState()));
app.get('/api/analyze/:symbol',async(req,res)=>{try{const r=await fullAnalysis(req.params.symbol.toUpperCase());res.json(r||{error:'not enough data'});}catch(e){res.status(500).json({error:e.message});}});
// Dərin BTC paneli: multi-timeframe siqnal + funding rate + open interest bir sorğuda
app.get('/api/btc',async(req,res)=>{
  try{
    if(!state.fundingRate.has(BTC_SYMBOL)) await fetchFundingAndOI(BTC_SYMBOL);
    const r=await fullAnalysis(BTC_SYMBOL);
    res.json(r||{error:'not enough data'});
  }catch(e){res.status(500).json({error:e.message});}
});
// Qrafik üçün OKX-dan gəlmiş, serverdə saxlanılan şam datası (client birbaşa OKX-a getməsin)
app.get('/api/candles/:symbol/:tf',(req,res)=>{
  const symbol=req.params.symbol.toUpperCase(), tf=req.params.tf;
  res.json(getCandles(symbol,tf));
});
app.post('/api/scanner',requireAdmin,(req,res)=>{state.scannerEnabled=!!req.body.enabled;res.json(publicState());});
app.post('/api/trade',requireAdmin,async(req,res)=>{try{const{symbol,side}=req.body;if(!symbol||!['LONG','SHORT'].includes(side))return res.status(400).json({error:'symbol and side (LONG|SHORT) required'});if(!activeSymbols.includes(symbol))return res.status(400).json({error:'unknown symbol'});const r=await fullAnalysis(symbol);if(!r||r.signal!==side)return res.status(400).json({error:'Signal does not confirm requested side'});if(r.rr<MIN_RR)return res.status(400).json({error:`R:R (${r.rr.toFixed(2)}) is below minimum (${MIN_RR})`});if(!TRADING_ENABLED)return res.status(403).json({error:'TRADING_ENABLED=false'});const out=await executeTrade(symbol,r);res.json({ok:true,out});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/balance',requireAdmin,async(req,res)=>{try{res.json(await getBalance());}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/positions',requireAdmin,async(req,res)=>{try{res.json(await getOpenPositions());}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/close',requireAdmin,async(req,res)=>{try{if(!TRADING_ENABLED)return res.status(403).json({error:'TRADING_ENABLED=false'});const out=await closePosition(String(req.body.symbol||'').toUpperCase());res.json({ok:true,out});}catch(e){res.status(400).json({error:e.message});}});

const server=app.listen(PORT,async()=>{console.log(`SIQNAL PRO server on :${PORT}`);await initDb();await loadState();if(!ADMIN_API_KEY)console.warn('XƏBƏRDARLIQ: ADMIN_API_KEY təyin edilməyib — /api/trade, /api/close, /api/scanner, /api/balance, /api/positions, /api/notify deaktiv olacaq.');try{if(AUTO_TOP30){symbols=await discoverTop30();if(!symbols.includes(BTC_SYMBOL))symbols.unshift(BTC_SYMBOL);console.log('AUTO_TOP30: OKX-da real həcmə görə seçilən simvollar:',symbols.join(', '));}await loadInstruments();activeSymbols=symbols.filter(s=>state.instruments.has(s));const skipped=symbols.filter(s=>!state.instruments.has(s));if(skipped.length)console.warn('OKX SWAP-da tapılmadı, ötürüldü:',skipped.join(', '));for(const s of activeSymbols)for(const tf of [...TIMEFRAMES,MACRO_TF]){try{await fetchCandleHistory(s,tf);}catch(e){console.error(`Candle load failed ${s} ${tf}:`,e.message);}await new Promise(r=>setTimeout(r,250));}
    // Başlanğıc təsdiqi — server sükutla "işə düşüb amma heç nə göstərmir" vəziyyətinə düşəndə bunu görmək üçün
    const loadedOk=activeSymbols.filter(s=>getCandles(s,'15m').length>=60);
    const telegramOk=await verifyTelegramSetup();
    if(telegramOk)await sendTelegram(`✅ <b>SIQNAL PRO başladı</b>\nİzlənilən: ${activeSymbols.length} simvol\nData yükləndi: ${loadedOk.length}/${activeSymbols.length}\n${loadedOk.length<activeSymbols.length?'⚠️ Bəziləri yüklənmədi — Railway loglarına bax.':''}`);
    connectMarketWS();setInterval(scan,15000);setInterval(async()=>{try{await getOpenPositions();broadcast({type:'positions',positions:state.positions});}catch(e){state.lastError=e.message;}},10000);telegramLoop();fetchFundingAndOI(BTC_SYMBOL);setInterval(()=>fetchFundingAndOI(BTC_SYMBOL),60000);setInterval(saveState,20000);}catch(e){state.lastError=e.message;console.error(e);}});
const wss=new WebSocketServer({server,path:'/ws'});wss.on('connection',ws=>{state.clients.add(ws);ws.send(JSON.stringify({type:'state',...publicState()}));ws.on('close',()=>state.clients.delete(ws));});
process.on('SIGTERM',()=>{state.telegramRunning=false;saveState();server.close();});
