const { chromium } = require('playwright-core');
const BASE='http://127.0.0.1:9999';
(async()=>{
  const r=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'88888888'})});
  const ck=r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const [n,v]=ck.split('=');
  const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const c=await b.newContext({viewport:{width:1600,height:1000}});
  await c.addCookies([{name:n,value:v,domain:'127.0.0.1',path:'/'}]);
  const p=await c.newPage();
  await p.goto(`${BASE}/feedback-learning`,{waitUntil:'domcontentloaded'});
  await p.waitForSelector('[data-testid="flm-page"]',{timeout:30000});
  await p.click('[data-testid="flm-tab-strategies"]');
  await p.waitForTimeout(3000);
  const info = await p.evaluate(()=>{
    const all=[...document.querySelectorAll('[data-testid^="flm-canary-10-"]')].map(e=>e.getAttribute('data-testid').replace('flm-canary-10-',''));
    const target='strat_6bcdd48e-5901-4069-9aeb-4e4d97d2534f';
    const el=document.querySelector(`[data-testid="flm-canary-10-${target}"]`);
    let vis=null;
    if(el){const rc=el.getBoundingClientRect(); vis={w:rc.width,h:rc.height,top:rc.top,display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility};}
    return {canary10Count:all.length, hasTarget:!!el, targetBox:vis, first5:all.slice(0,5), containerRows:document.querySelectorAll('[data-testid="flm-strategies"] > div').length};
  });
  console.log(JSON.stringify(info,null,2));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
