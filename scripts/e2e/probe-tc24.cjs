// 复现 TC-24 的点击时序：goFlmTab('strategies') 后立刻点 canary-10 按钮。
const { chromium } = require('playwright-core');
const BASE='http://127.0.0.1:9999';
const TARGET='strat_6bcdd48e-5901-4069-9aeb-4e4d97d2534f';
(async()=>{
  const r=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'88888888'})});
  const ck=r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const [n,v]=ck.split('=');
  const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const c=await b.newContext({viewport:{width:1600,height:1000}});
  await c.addCookies([{name:n,value:v,domain:'127.0.0.1',path:'/'}]);
  const p=await c.newPage();

  // 与 goFlmTab 完全同构
  const t0=Date.now();
  await p.goto(`${BASE}/feedback-learning`,{waitUntil:'domcontentloaded'});
  await p.waitForSelector('[data-testid="flm-page"]',{timeout:30000});
  await p.click('[data-testid="flm-tab-strategies"]');
  await p.waitForTimeout(1200);
  console.log(`goFlmTab 返回 @+${((Date.now()-t0)/1000).toFixed(1)}s`);

  const sel=`[data-testid="flm-canary-10-${TARGET}"]`;
  // 记录按钮在你等待期间的位置变化，看看它是不是一直在动
  const track=[];
  const timer=setInterval(async()=>{
    try{
      const info=await p.evaluate((s)=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {top:Math.round(r.top),h:Math.round(r.height)};},sel);
      track.push(`+${((Date.now()-t0)/1000).toFixed(1)}s ${JSON.stringify(info)}`);
    }catch{}
  },1000);

  try{
    await p.click(sel,{timeout:20000});
    clearInterval(timer);
    console.log(`✅ 点击成功，耗时 ${((Date.now()-t0)/1000).toFixed(1)}s（自 goto 起）`);
  }catch(e){
    clearInterval(timer);
    console.log(`❌ 点击失败：${e.message.split('\n')[0]}`);
    const exists=await p.locator(sel).count();
    console.log(`   此刻 DOM 内该按钮数量=${exists}`);
  }
  console.log('位置轨迹（每 1s）：');
  track.forEach(t=>console.log('   '+t));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
