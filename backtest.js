// backtest.js — SEYMUR13 strategiyasının tarixi datada sınağı.
//
// QEYD (VACİB): Bu, server.js-dəki `analyze()` funksiyasının (TƏK bir timeframe üçün) sınağıdır.
// Əsl bot 4 timeframe-in (15m/30m/1H/4H) konfluensiyasına (fullAnalysis) əsaslanır — tam dəqiq
// backtest üçün 5 timeframe-in tarixi datasını sinxron simulyasiya etmək lazımdır, bu isə xeyli
// mürəkkəbdir. Bu skript ilk sanity-check kimidir: "bu indikator kombinasiyası ümumiyyətlə
// təsadüfi tossdan yaxşıdırmı?" sualına tək-timeframe səviyyəsində cavab verir.
//
// İşlətmək üçün: node backtest.js BTC-USDT-SWAP 15m 180
//   (simvol, timeframe, neçə gün geriyə)

const OKX_BASE = 'https://www.okx.com';

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
function ichimoku(c){
  if(c.length<52)return null;
  const mid=n=>{const s=c.slice(-n);return(Math.max(...s.map(x=>x.h))+Math.min(...s.map(x=>x.l)))/2;};
  const tenkan=mid(9),kijun=mid(26),spanA=(tenkan+kijun)/2,spanB=mid(52),price=c.at(-1).c;
  const top=Math.max(spanA,spanB),bot=Math.min(spanA,spanB);
  return{score:price>top?1:(price<bot?-1:0)};
}
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
  return{uptrend};
}
function pivotPoints(c){
  if(c.length<2)return null;
  const p=c[c.length-2];
  return{pp:(p.h+p.l+p.c)/3};
}
function fibLevels(c){
  const n=Math.min(c.length,50),s=c.slice(-n),hi=Math.max(...s.map(x=>x.h)),lo=Math.min(...s.map(x=>x.l)),diff=hi-lo;
  return{r500:hi-diff*0.5};
}
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
function vwap(c,n=50){
  if(c.length<n)return null;
  const s=c.slice(-n);let pv=0,vv=0;
  for(const x of s){pv+=((x.h+x.l+x.c)/3)*x.v;vv+=x.v;}
  return vv===0?null:pv/vv;
}

function analyze(c){
  if(c.length<60)return null;
  const close=c.map(x=>x.c),price=close.at(-1),e9=ema(close,9),e21=ema(close,21),e50=ema(close,50),e200=ema(close,200),rv=rsi(close),mv=macd(close),bb=bollinger(close),st=stochastic(c),av=atr(c),cv=cci(c),mf=mfi(c),ob=obvTrend(c),str=structure(c),ax=adx(c),vw=vwap(c),ich=ichimoku(c),psar=parabolicSar(c),piv=pivotPoints(c),fib=fibLevels(c);
  let score=0;
  if(e9>e21&&e21>e50)score+=1;else if(e9<e21&&e21<e50)score-=1;
  if(e200!=null){if(price>e200)score+=1;else score-=1;}
  if(rv<35)score+=1;else if(rv>65)score-=1;
  if(mv>0)score+=1;else if(mv<0)score-=1;
  if(bb){if(price<=bb.lower)score+=1;else if(price>=bb.upper)score-=1;}
  if(st<20)score+=1;else if(st>80)score-=1;
  if(cv<-100)score+=1;else if(cv>100)score-=1;
  if(mf<25)score+=1;else if(mf>75)score-=1;
  if(ob>0)score+=1;else if(ob<0)score-=1;
  if(str>0)score+=1;else if(str<0)score-=1;
  if(vw!=null){if(price>vw)score+=1;else score-=1;}
  if(ich&&ich.score!==0){if(ich.score>0)score+=1;else score-=1;}
  if(psar){if(psar.uptrend)score+=1;else score-=1;}
  if(piv){if(price>piv.pp)score+=1;else if(price<piv.pp)score-=1;}
  if(fib){if(price>fib.r500)score+=1;else score-=1;}
  let confidence=Math.round(Math.min(100,Math.abs(score)/15*100));
  if(ax!=null){ if(ax>=25)confidence=Math.min(100,confidence+8); else if(ax<15)confidence=Math.max(0,confidence-12); }
  const signal=score>=4?'LONG':score<=-4?'SHORT':'WAIT';
  if(!av)return{signal,confidence,price};
  const swingLow=Math.min(...c.slice(-20).map(x=>x.l)),swingHigh=Math.max(...c.slice(-20).map(x=>x.h));
  let sl=null,tp2=null;
  if(signal==='LONG'){sl=Math.min(swingLow,price-av*1.25);const risk=price-sl;tp2=price+2*risk;}
  else if(signal==='SHORT'){sl=Math.max(swingHigh,price+av*1.25);const risk=sl-price;tp2=price-2*risk;}
  return{signal,confidence,price,sl,tp2};
}

async function fetchHistory(symbol,tf,days){
  let all=[],after='';
  const barMs={'15m':900e3,'30m':1800e3,'1H':3600e3,'4H':14400e3}[tf]||900e3;
  const needed=Math.ceil(days*86400e3/barMs)+300;
  while(all.length<needed){
    const u=new URL(OKX_BASE+'/api/v5/market/history-candles');
    u.searchParams.set('instId',symbol);u.searchParams.set('bar',tf);u.searchParams.set('limit','300');
    if(after)u.searchParams.set('after',after);
    const r=await fetch(u); const j=await r.json();
    if(j.code!=='0'||!j.data?.length)break;
    all=all.concat(j.data); after=j.data.at(-1)?.[0];
    if(j.data.length<300)break;
    await new Promise(res=>setTimeout(res,200)); // OKX rate-limit
  }
  const map=new Map();
  for(const k of all)map.set(+k[0],{t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]});
  return [...map.values()].sort((a,b)=>a.t-b.t);
}

function simulate(candles, minConfidence){
  const trades=[]; let i=200; // ilk 200 şam yalnız indikatorların isinməsi üçün
  while(i<candles.length-1){
    const window=candles.slice(0,i+1);
    const r=analyze(window);
    if(r && r.signal!=='WAIT' && r.confidence>=minConfidence && r.sl){
      // Sonrakı şamlarda SL və ya TP2-yə kim daha tez toxunur, onu tap (max 200 şam irəli baxır)
      let outcome=null, exitIdx=null;
      for(let j=i+1;j<Math.min(candles.length,i+201);j++){
        const bar=candles[j];
        if(r.signal==='LONG'){
          if(bar.l<=r.sl){outcome='LOSS';exitIdx=j;break;}
          if(bar.h>=r.tp2){outcome='WIN';exitIdx=j;break;}
        }else{
          if(bar.h>=r.sl){outcome='LOSS';exitIdx=j;break;}
          if(bar.l<=r.tp2){outcome='WIN';exitIdx=j;break;}
        }
      }
      if(outcome){
        trades.push({time:candles[i].t,signal:r.signal,confidence:r.confidence,outcome,rMultiple: outcome==='WIN'?2:-1});
        i=exitIdx; // eyni pəncərədə üst-üstə düşən trade açmasın (sadələşdirilmiş fərziyyə)
        continue;
      }
    }
    i++;
  }
  return trades;
}

function report(trades){
  const n=trades.length;
  if(!n){ console.log('Heç bir trade siqnalı yaranmadı (dövr çox qısadır və ya confidence həddi çox yüksəkdir).'); return; }
  const wins=trades.filter(t=>t.outcome==='WIN').length;
  const winRate=(wins/n*100);
  const totalR=trades.reduce((s,t)=>s+t.rMultiple,0);
  const expectancy=totalR/n;
  // Max drawdown (R-vahidləri ilə, kumulyativ)
  let cum=0,peak=0,maxDD=0;
  for(const t of trades){ cum+=t.rMultiple; peak=Math.max(peak,cum); maxDD=Math.min(maxDD,cum-peak); }
  console.log(`\n=== BACKTEST NƏTİCƏSİ ===`);
  console.log(`Trade sayı: ${n}`);
  console.log(`Win rate: ${winRate.toFixed(1)}%`);
  console.log(`Cəmi R: ${totalR.toFixed(2)}  |  Expectancy: ${expectancy.toFixed(3)}R / trade`);
  console.log(`Max drawdown: ${maxDD.toFixed(2)}R`);
  console.log(`Qeyd: R:R nisbəti strategiyada sabit 1:2-dir (TP2), ona görə break-even win rate ~33.3%-dir.`);
  console.log(`Bu nəticə TƏK bir timeframe-in (${process.argv[3]||'15m'}) sadələşdirilmiş simulyasiyasıdır,`);
  console.log(`əsl bot 5-timeframe konfluensiya tələb etdiyi üçün real nəticə fərqli ola bilər.`);

  // === ƏSAS SUAL: "Etibar faizi" HƏQİQƏTƏN nəticəyə təsir edirmi, yoxsa sadəcə rəqəmdir? ===
  // Trade-ləri etibar faizi aralığına görə qruplaşdırıb hər qrupun REAL win rate-ni göstəririk.
  // Əgər sistem mənalıdırsa, yüksək etibar faizli qruplarda win rate də yüksək olmalıdır.
  const buckets=[[40,54],[55,64],[65,74],[75,84],[85,100]];
  console.log(`\n=== ETİBAR FAİZİ ↔ REAL WIN RATE (bucket analizi) ===`);
  console.log(`Bucket        Trade   Win rate   Expectancy`);
  for(const[lo,hi] of buckets){
    const bucket=trades.filter(t=>t.confidence>=lo&&t.confidence<=hi);
    if(!bucket.length){ console.log(`${lo}-${hi}%       0       —          —`); continue; }
    const bw=bucket.filter(t=>t.outcome==='WIN').length;
    const bwr=(bw/bucket.length*100).toFixed(1);
    const bexp=(bucket.reduce((s,t)=>s+t.rMultiple,0)/bucket.length).toFixed(3);
    console.log(`${lo}-${hi}%`.padEnd(14)+`${bucket.length}`.padEnd(8)+`${bwr}%`.padEnd(11)+`${bexp}R`);
  }
  console.log(`\nŞərh: aşağıdan yuxarıya bucket-lərdə win rate/expectancy artırsa, "etibar faizi" real`);
  console.log(`mənalıdır — yüksək faiz həqiqətən statistik üstünlük deməkdir. Artmırsa (təsadüfi görünürsə),`);
  console.log(`confidence formulunun kalibrasiyası yenidən nəzərdən keçirilməlidir.`);
}

async function main(){
  const symbol=process.argv[2]||'BTC-USDT-SWAP';
  const tf=process.argv[3]||'15m';
  const days=Number(process.argv[4]||180);
  const minConfidence=Number(process.argv[5]||72);
  console.log(`Tarixi data çəkilir: ${symbol} ${tf}, ~${days} gün...`);
  const candles=await fetchHistory(symbol,tf,days);
  console.log(`${candles.length} şam yükləndi. Simulyasiya işə düşür (min confidence=${minConfidence})...`);
  const trades=simulate(candles,minConfidence);
  report(trades);
}

main().catch(e=>{ console.error('Xəta:', e.message); process.exit(1); });
