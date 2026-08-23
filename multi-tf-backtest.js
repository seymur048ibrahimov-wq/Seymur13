// multi-tf-backtest.js — "Bot LONG/SHORT desə, 24 saat sonra doğrudan qazanc olurmu?"
//
// Bu skript server.js-dəki fullAnalysis() məntiqini (4 TF-in 3/4 konfluensiyası) TAM olaraq
// tarixi datada təkrarlayır — amma sınaq üçün SL/TP-ə "toxunub-toxunmadığına" deyil, məhz
// istifadəçinin istədiyi suala cavab verir: "əgər bu siqnal anında girsəydim, DƏQİQ 24 saat
// sonra qiymət haradaydı, itki/qazanc neçə faiz idi, seçdiyim leverage ilə likvid olardımmı?"
//
// Sinxronluq üçün YALNIZ 1 dəqiqəlik (1m) tarixi data çəkilir, digər bütün timeframe-lər
// (15m/30m/1H/4H) həmin 1m datadan resample olunur — bu, 4 ayrı API sorğusu ilə yaranan
// vaxt fərqi/uyğunsuzluq riskini aradan qaldırır və server.js-in gördüyünə 1:1 bənzəyir.
//
// İşlətmək üçün:  node multi-tf-backtest.js BTC-USDT-SWAP 14 10
//                 (simvol, neçə gün geriyə, leverage)
//
// QEYD: funding rate / open interest tarixi burada YOXDUR (server.js confidence-ə +/-6-10
// əlavə edir bunlardan) — ona görə bu backtest-in confidence-i real botdan bir az fərqli ola
// bilər. Bu, DƏQİQ zəmanət deyil — keçmiş performans gələcəyi təmin etmir. Məqsəd: "bu
// strategiya təsadüfdən yaxşıdırmı, hansı confidence həddi real etibarlıdır" sualına RƏQƏMLƏ
// cavab vermək, "sabah mütləq qazanacaqsan" demək deyil.

const OKX_BASE = 'https://www.okx.com';

// ---- server.js-dəki eyni indikator funksiyaları (1:1 köçürülüb ki, nəticə eyni məntiqlə üst-üstə düşsün) ----
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
function ichimoku(c){
  if(c.length<52)return null;
  const mid=n=>{const s=c.slice(-n);return(Math.max(...s.map(x=>x.h))+Math.min(...s.map(x=>x.l)))/2;};
  const tenkan=mid(9),kijun=mid(26),spanA=(tenkan+kijun)/2,spanB=mid(52),price=c.at(-1).c;
  const top=Math.max(spanA,spanB),bot=Math.min(spanA,spanB);
  const score=price>top?1:(price<bot?-1:0);
  return{score};
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
  const p=c[c.length-2],pp=(p.h+p.l+p.c)/3;
  return{pp};
}
function fibLevels(c){
  const n=Math.min(c.length,50),s=c.slice(-n),hi=Math.max(...s.map(x=>x.h)),lo=Math.min(...s.map(x=>x.l)),diff=hi-lo;
  return{r500:hi-diff*0.5};
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
  if(ich&&ich.score!==0)score+=ich.score;
  if(psar)score+=psar.uptrend?1:-1;
  if(piv){if(price>piv.pp)score+=1;else if(price<piv.pp)score-=1;}
  if(fib){if(price>fib.r500)score+=1;else score-=1;}
  let confidence=Math.round(Math.min(100,Math.abs(score)/15*100));
  if(ax!=null){ if(ax>=25)confidence=Math.min(100,confidence+8); else if(ax<15)confidence=Math.max(0,confidence-12); }
  const signal=score>=4?'LONG':score<=-4?'SHORT':'WAIT';
  return{signal,confidence,price};
}

// ---- 1m tarixi datanı çəkib digər TF-ləri ondan resample edir ----
async function fetch1m(symbol,days){
  let all=[],after='';
  const needed=Math.ceil(days*1440)+300;
  console.log(`1m tarixi data çəkilir (~${needed} şam)...`);
  while(all.length<needed){
    const u=new URL(OKX_BASE+'/api/v5/market/history-candles');
    u.searchParams.set('instId',symbol);u.searchParams.set('bar','1m');u.searchParams.set('limit','300');
    if(after)u.searchParams.set('after',after);
    const r=await fetch(u); const j=await r.json();
    if(j.code!=='0'||!j.data?.length)break;
    all=all.concat(j.data); after=j.data.at(-1)?.[0];
    if(j.data.length<300)break;
    if(all.length%3000<300) process.stdout.write(`  ${all.length} şam...\r`);
    await new Promise(res=>setTimeout(res,150));
  }
  const map=new Map();
  for(const k of all)map.set(+k[0],{t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]});
  console.log(`\n${map.size} 1m şam yükləndi.`);
  return [...map.values()].sort((a,b)=>a.t-b.t);
}
function resample(c1m, minutes){
  const bucketMs=minutes*60000, out=[];
  let cur=null;
  for(const x of c1m){
    const bt=Math.floor(x.t/bucketMs)*bucketMs;
    if(!cur||cur.t!==bt){ if(cur)out.push(cur); cur={t:bt,o:x.o,h:x.h,l:x.l,c:x.c,v:x.v}; }
    else { cur.h=Math.max(cur.h,x.h); cur.l=Math.min(cur.l,x.l); cur.c=x.c; cur.v+=x.v; }
  }
  if(cur)out.push(cur);
  return out;
}

function simulate(c1m, minConfidence, leverage){
  const series={ '15m':resample(c1m,15), '30m':resample(c1m,30), '1H':resample(c1m,60), '4H':resample(c1m,240) };
  const order=['15m','30m','1H','4H'];
  // hər TF üçün pointer: hansı indexə qədər "indiyədək bağlanmış şamlar"
  const ptr={ '15m':0,'30m':0,'1H':0,'4H':0 };
  const results=[];
  const HORIZON_MS=24*3600*1000;
  const step15=series['15m'];
  let j1m=0; // 1m pointer üçün 24h sonrakı qiyməti tapmaq
  for(let i=250;i<step15.length;i++){
    const t=step15[i].t;
    // hər TF-in "bu anda görünən" pəncərəsini qur (t-dən sonrakı şamları görməsin — look-ahead bias olmasın)
    const tfMap={};
    let ok=true;
    for(const tf of order){
      const arr=series[tf];
      let p=ptr[tf];
      while(p<arr.length && arr[p].t<=t) p++;
      ptr[tf]=p;
      const window=arr.slice(0,p);
      if(window.length<60){ ok=false; break; }
      tfMap[tf]=analyze(window.slice(-400));
    }
    if(!ok) continue;
    const valid=order.map(tf=>tfMap[tf]).filter(Boolean);
    if(valid.length<4) continue;
    const longs=valid.filter(x=>x.signal==='LONG').length, shorts=valid.filter(x=>x.signal==='SHORT').length;
    // 4 TF-dən min. 3-ü (75%) eyni istiqamətdə olmalıdır (əvvəlki 4/5 ≈ 80%-ə ekvivalent)
    let final='WAIT'; if(longs>=3)final='LONG'; else if(shorts>=3)final='SHORT';
    if(final==='WAIT') continue;
    const conf=Math.round(valid.reduce((s,x)=>s+x.confidence,0)/valid.length);
    if(conf<minConfidence) continue;
    const entry=step15[i].c;
    // 24 saat sonrakı qiyməti 1m datadan tap
    const targetT=t+HORIZON_MS;
    while(j1m<c1m.length-1 && c1m[j1m].t<targetT) j1m++;
    if(c1m[j1m].t<targetT) continue; // hələ 24 saat keçməyib (dövrün sonuna yaxınıq)
    const exit=c1m[j1m].c;
    const dir=final==='LONG'?1:-1;
    const retPct=((exit-entry)/entry)*dir*100;
    // 24 saat ərzində maksimum əleyhinə hərəkəti tap (likvidasiya riski üçün)
    let worstAdverse=0;
    for(let k=j1m; k>=0 && c1m[k].t>=t; k--){
      const px=dir>0?c1m[k].l:c1m[k].h;
      const adv=((px-entry)/entry)*dir*100;
      if(adv<worstAdverse) worstAdverse=adv;
    }
    const liquidated = worstAdverse <= -(100/leverage)*0.9; // maintenance margin üçün ~10% pay saxlanır
    results.push({t,signal:final,confidence:conf,retPct,leveragedRetPct:retPct*leverage,worstAdverse,liquidated});
  }
  return results;
}

function report(results, leverage){
  if(!results.length){ console.log('Heç bir siqnal (3/4 TF konfluensiya) tapılmadı bu dövrdə.'); return; }
  const buckets=[[0,60],[60,70],[70,80],[80,90],[90,101]];
  console.log(`\n=== 24-SAATLIQ NƏTİCƏ (${results.length} siqnal, ${leverage}x leverage fərz olunub) ===\n`);
  console.log('Confidence  | Siqnal sayı | Win rate | Orta gətiri (spot) | Orta gətiri (leverajlı) | Likvidasiya faizi');
  for(const [lo,hi] of buckets){
    const b=results.filter(r=>r.confidence>=lo&&r.confidence<hi);
    if(!b.length) continue;
    const wins=b.filter(r=>r.retPct>0).length;
    const avgRet=b.reduce((s,r)=>s+r.retPct,0)/b.length;
    const avgLevRet=b.reduce((s,r)=>s+r.leveragedRetPct,0)/b.length;
    const liq=b.filter(r=>r.liquidated).length;
    console.log(`${lo}-${hi-1}%      | ${String(b.length).padEnd(11)} | ${(wins/b.length*100).toFixed(1)}%    | ${avgRet.toFixed(2)}%              | ${avgLevRet.toFixed(2)}%                  | ${(liq/b.length*100).toFixed(1)}%`);
  }
  const all=results;
  const winsAll=all.filter(r=>r.retPct>0).length;
  const liqAll=all.filter(r=>r.liquidated).length;
  console.log(`\nÜMUMİ: win rate ${(winsAll/all.length*100).toFixed(1)}%, orta spot gətiri ${(all.reduce((s,r)=>s+r.retPct,0)/all.length).toFixed(2)}%, ${leverage}x ilə likvidasiya faizi ${(liqAll/all.length*100).toFixed(1)}%`);
  console.log(`\nQEYD: Bu tarixi nəticədir, gələcək zəmanəti deyil. Siqnallar üst-üstə düşən pəncərələrdə ola bilər`);
  console.log(`(hərəsi müstəqil "yeni pul" fərz edir) — real ardıcıl trade nəticəsi fərqli ola bilər.`);
  console.log(`Likvidasiya faizi = worst-case, SL qoymadan saf "24 saat gözlə" ssenarisidir; real botda SL var, bu riski azaldır.`);
}

async function main(){
  const symbol=process.argv[2]||'BTC-USDT-SWAP';
  const days=Number(process.argv[3]||14);
  const leverage=Number(process.argv[4]||10);
  const minConfidence=Number(process.argv[5]||60);
  console.log(`Simvol: ${symbol} | Dövr: ${days} gün | Leverage: ${leverage}x | Min confidence: ${minConfidence}%`);
  const c1m=await fetch1m(symbol,days);
  if(c1m.length<2000){ console.log('Kifayət qədər data yoxdur, günü artır.'); return; }
  console.log('Multi-timeframe konfluensiya simulyasiyası işə düşür...');
  const results=simulate(c1m,minConfidence,leverage);
  report(results,leverage);
}

main().catch(e=>{ console.error('Xəta:', e.message); process.exit(1); });
