import assert from 'node:assert/strict';
// Real service worker/offline checks use only public assets, without credentials or API fixtures.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/rubika-tools/node_modules/playwright/index.mjs');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:4173/rubika_bot/');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use the local development server for PWA checks.');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
 const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base.href);await page.locator('#pageTitle').waitFor();
 const worker=await page.evaluate(async()=>{const registration=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Service worker readiness timed out')),15000))]);if(registration.active.state!=='activated')await new Promise((resolve,reject)=>{const worker=registration.active;const timer=setTimeout(()=>reject(new Error('Worker activation timed out')),15000);worker.addEventListener('statechange',()=>{if(worker.state==='activated'){clearTimeout(timer);resolve();}});});return{scope:registration.scope,state:registration.active.state};});
 assert.equal(worker.state,'activated');assert.equal(worker.scope,base.href);
 const manifest=await page.evaluate(async()=>{const link=document.querySelector('link[rel=manifest]');return (await fetch(link.href)).json();});assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');assert.deepEqual(manifest.icons.map(icon=>icon.sizes),['192x192','512x512']);
 const cache=await page.evaluate(async()=>{const result={};for(const key of await caches.keys()){result[key]=(await(await caches.open(key)).keys()).map(req=>({url:req.url,method:req.method}));}return result;});
 const entries=Object.values(cache).flat();assert.equal(entries.length,11);assert.ok(entries.every(entry=>entry.method==='GET'&&entry.url.startsWith(worker.scope)));assert.ok(entries.every(entry=>!entry.url.includes('/functions/')&&!entry.url.includes('/server/')&&!entry.url.includes('token=')));
 await context.setOffline(true);await page.reload();await page.locator('#pageTitle').filter({hasText:'داشبورد مدیریت'}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'fa');assert.equal(errors.length,0,errors.join('\n'));
 console.log(JSON.stringify({passed:true,serviceWorker:worker,publicCachedAssets:entries.length,offlineShell:true,apiCache:false,browserErrors:errors.length},null,2));
} finally {await browser.close();}
