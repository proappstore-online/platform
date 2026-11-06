#!/usr/bin/env node
/** Isolated acceptance of exact app/Console/Storefront build bytes. No production writes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRequire = createRequire(join(root, 'packages/runtime-tests/package.json'));
const { Miniflare } = runtimeRequire('miniflare');
const { readD1Migrations } = runtimeRequire('@cloudflare/vitest-pool-workers/config');
const appId = process.env.PAS_REFERRAL_APP || 'dating';
assert.match(appId, /^[a-z0-9-]+$/);
assert.ok(process.env.PAS_REFERRAL_DIST, 'PAS_REFERRAL_DIST must identify the exact uploaded build');
const dist = resolve(process.env.PAS_REFERRAL_DIST);
const consoleDist = process.env.PAS_CONSOLE_DIST && resolve(process.env.PAS_CONSOLE_DIST);
const storeDist = process.env.PAS_STOREFRONT_DIST && resolve(process.env.PAS_STOREFRONT_DIST);
assert.equal(Boolean(consoleDist), Boolean(storeDist), 'provide both client builds for joint acceptance');
const temporary = await mkdtemp(join(tmpdir(), 'pas-referral-'));
const artifacts = resolve(process.env.PAS_REFERRAL_ARTIFACTS || join(root, 'artifacts/referral-browser'));
await mkdir(artifacts, { recursive: true });
const report = { appId, appFiles: {}, engines: [], mode: consoleDist ? 'joint-browser' : 'app-build-browser', externalNetwork: 'denied; synthetic provider boundary only' };
async function hashes(dir, prefix = '') {
  const out = {};
  for (const ent of (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const key = join(prefix, ent.name);
    if (ent.isDirectory()) Object.assign(out, await hashes(dir,key));
    else out[key] = createHash('sha256').update(await readFile(join(dir,key))).digest('hex');
  }
  return out;
}
report.appFiles = await hashes(dist);
if (consoleDist) { report.consoleFiles = await hashes(consoleDist); report.storefrontFiles = await hashes(storeDist); }
const bundle = async (entry, outfile, extra = {}) => build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', external: ['cloudflare:*', 'node:*'], banner: {js: "import { createRequire } from 'node:module'; const nodeRequire = createRequire('/worker.js'); const require = id => { const mod = nodeRequire(id); return mod.default ?? {...mod}; };"}, ...extra });
await bundle(join(root,'packages/backend/src/index.ts'),join(temporary,'backend.mjs'));
// This worker exists only in the isolated harness. It has no deployment config.
const fixture = `import { handleAuthRoute } from '${root}/packages/host/src/auth-handler.ts';
import { handlePlatformMediation } from '${root}/packages/host/src/platform-mediation.ts';
import { credentialContext, mintSession } from '${root}/packages/build-core/src/index.ts';
import { seedReferralReady } from '${root}/packages/backend/src/promoter-test-helpers.ts';
export default { async fetch(request, env, ctx) {
 const u = new URL(request.url);
 if(u.pathname === '/__fixture/ready') { await seedReferralReady(env.DB, '${appId}'); return Response.json({ok:true}); }
 if(u.pathname === '/__fixture/provider') {
  const {uid, app, returnTo} = await request.json();
  const claims = {uid, roles:['user'], auth_method:'google', auth_time:Math.floor(Date.now()/1000), cred:credentialContext(app === 'console' ? 'first_party_session' : 'app_bound', app === 'console' ? undefined : app)};
  if(app === 'console') return Response.json({url:returnTo + '#pas_session=' + encodeURIComponent(await mintSession(claims, env.SESSION_SIGNING_KEY))});
  const code = crypto.randomUUID();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
  const hash = btoa(String.fromCharCode(...bytes)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  await env.DB.prepare('INSERT INTO auth_exchange_codes (code_hash,claims,expires_at,created_at) VALUES (?,?,?,?)').bind(hash, JSON.stringify(claims), Date.now()+60000, Date.now()).run();
  const callback = new URL(returnTo); callback.searchParams.set('code',code); return Response.json({url:callback.href});
 }
 const route = {slug:'${appId}',zone:'proappstore.online',r2_prefix:'apps/${appId}/',store:'pas'};
 return await handleAuthRoute(request,env,route) || await handlePlatformMediation(request,env,route,ctx) || new Response('not found',{status:404});
}};`;
await writeFile(join(temporary,'fixture.ts'),fixture);
await bundle(join(temporary,'fixture.ts'),join(temporary,'fixture.mjs'));
let mf; const servers = [];
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temporary,'key.pem'),'-out',join(temporary,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
const tls={key:await readFile(join(temporary,'key.pem')),cert:await readFile(join(temporary,'cert.pem'))};
try {
 mf = new Miniflare({ workers: [
  {name:'fixture',modules:true,modulesRoot:temporary,scriptPath:join(temporary,'fixture.mjs'),compatibilityDate:'2025-09-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'ledger'},bindings:{SESSION_SIGNING_KEY:'isolated-referral-test'},serviceBindings:{API:{name:'backend',entrypoint:'HostApi'}},outboundService:()=>new Response('External network denied',{status:502})},
  {name:'backend',modules:true,modulesRoot:temporary,scriptPath:join(temporary,'backend.mjs'),compatibilityDate:'2025-09-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'ledger'},r2Buckets:['STORAGE','APPS'],durableObjects:{ROOM:'Room'},ratelimits:{PUBLIC_LOG_RATE_LIMIT:{simple:{limit:100,period:60}},PUBLIC_LOG_ERROR_COUNT_LIMIT:{simple:{limit:100,period:60}},PUBLIC_ACTION_RATE_LIMIT:{simple:{limit:100,period:60}}},serviceBindings:{SELF:'backend'},bindings:{SESSION_SIGNING_KEY:'isolated-referral-test',APP_BASE:'https://api.proappstore.online',INTERNAL_TOKEN:'isolated',DATA_WORKER_HOST:'test.invalid'},outboundService:()=>new Response('External network denied',{status:502})}
 ]});
 console.log('Starting isolated D1');
 const db = await mf.getD1Database('DB');
 console.log('Applying migrations');
 for (const m of await readD1Migrations(join(root,'migrations'))) { await db.batch(m.queries.map(q=>db.prepare(q))); }
 console.log('Migrations complete');
 const api = await mf.getWorker('backend');
 const origin = `https://${appId}.proappstore.online`;
 const API = 'https://api.proappstore.online';
 const CONSOLE = 'https://console.proappstore.online';
 const STORE = 'https://proappstore.online';
 const provider = async (uid, app, returnTo) => (await (await mf.dispatchFetch('https://fixture/__fixture/provider',{method:'POST',body:JSON.stringify({uid,app,returnTo})})).json()).url;
 const tokenFor = async uid => decodeURIComponent(new URL(await provider(uid,'console',CONSOLE+'/')).hash.slice('#pas_session='.length));
 const person = async (uid,path,method='GET',body) => api.fetch(API+'/v1'+path,{method,headers:{Authorization:'Bearer '+await tokenFor(uid),'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
 const virtual = {app:origin,api:API,console:CONSOLE,store:STORE};
 const local = {};
 const remap = value => { const url=new URL(value); for(const key of Object.keys(virtual)) if(url.origin===virtual[key]) return local[key]+url.pathname+url.search+url.hash; return value; };
 const toVirtual = value => { for(const key of Object.keys(local)) if(value.startsWith(local[key])) return virtual[key]+value.slice(local[key].length); return value; };
 async function serve(surface, url, init, uid) {
  const path=new URL(url).pathname;
  let response;
  const headers=new Headers(init.headers);
  if(headers.has('origin')) headers.set('origin',toVirtual(headers.get('origin')));
  headers.delete('host'); headers.delete('content-length'); headers.delete('x-fixture-user');
  init={...init,headers,redirect:'manual'};
  if(surface==='api' && /^\/v1\/auth\/(google|github)\/start$/.test(path)) {
   const query=new URL(url).searchParams;
   const target=await provider(uid,query.get('app_id'),query.get('return_to'));
   return new Response(null,{status:302,headers:{location:remap(target)}});
  }
  if(surface==='api') response=await api.fetch(url,init);
  else if(surface==='app' && path.startsWith('/.pas/')) response=await mf.dispatchFetch(url,init);
  else {
   const base=surface==='app'?dist:surface==='console'?consoleDist:storeDist;
   if(!base) return new Response('Unavailable',{status:404});
   let filename=decodeURIComponent(path).replace(/^\/+/, '') || 'index.html';
   if(filename.includes('..')) return new Response('Denied',{status:403});
   if(!extname(filename)) filename=filename.replace(/\/$/,'')+'.html';
   let bytes;
   try {bytes=await readFile(join(base,filename));} catch {
    try {bytes=await readFile(join(base,filename.replace(/\.html$/,'/index.html')));} catch {
     if(surface==='store') return new Response('Not found',{status:404});
     bytes=await readFile(join(base,'index.html')); filename='index.html';
    }
   }
   return new Response(bytes,{headers:{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'})[extname(filename)]||'application/octet-stream'}});
  }
  return response;
 }
 for(const surface of Object.keys(virtual)) {
  const server=createServer(tls,async(req,res)=>{
   try {
    const chunks=[];for await(const part of req) chunks.push(part);
    const response=await serve(surface,virtual[surface]+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})},req.headers['x-fixture-user']);
    const headers=Object.fromEntries(response.headers);
    delete headers['content-length'];delete headers['transfer-encoding'];delete headers['content-encoding'];
    if(headers.location) headers.location=remap(headers.location);
    if(response.headers.getSetCookie().length) headers['set-cookie']=response.headers.getSetCookie();
    if(headers['access-control-allow-origin']) headers['access-control-allow-origin']=remap(headers['access-control-allow-origin']);
    res.writeHead(response.status,headers);
    res.end(response.status>=300&&response.status<400 ? '' : Buffer.from(await response.arrayBuffer()));
   } catch(e) {if(e.code!=='ECONNRESET') console.error(e); if(!res.headersSent) res.writeHead(500);res.end('Fixture failure');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
  local[surface]='https://127.0.0.1:'+server.address().port;
 }
 for (const [engine,browserType] of Object.entries({chromium,webkit})) {
  for (const t of ['auth_exchange_codes','app_team_public_profiles','app_referral_events','app_referral_attributions','app_user_activations','app_promoter_events','app_promoters','app_referral_readiness','deploy_audit','app_visibility','kv','team_members','apps','users']) await db.prepare(`DELETE FROM ${t}`).run();
  for(const uid of ['gh:owner','gh:promoter','gh:referee','gh:organic','gh:private']) await db.prepare("INSERT INTO users (id,provider,provider_id,login,date_of_birth,created_at,last_login_at) VALUES (?,'github',?,?,'1990-01-01',1,1)").bind(uid,uid,uid.slice(3)).run();
  await db.prepare("INSERT INTO apps (id,creator_id,created_at) VALUES (?,'gh:owner',1)").bind(appId).run();
  await mf.dispatchFetch('https://fixture/__fixture/ready');
  const result={engine,checks:[],blocked:[]}; report.engines.push(result);
  const browser=await browserType.launch();
  const contexts=[];
  const counts = async () => (await (await person('gh:promoter',`/apps/${appId}/promoters/me/contributions`)).json()).contributions.promotion.counts;
  const context = async uid => {
   const c=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',ignoreHTTPSErrors:true,extraHTTPHeaders:{'x-fixture-user':uid}}); contexts.push(c); c.on('requestfailed',r=>console.log('Request failed',new URL(r.url()).pathname,r.failure()?.errorText));
   await c.route('**/*',async route=>{
    const request=route.request(), url=new URL(request.url());
    if(Object.values(local).includes(url.origin)) return route.continue();
    const surface=Object.keys(virtual).find(key=>virtual[key]===url.origin);
    if(!surface) {result.blocked.push(url.origin);return route.abort('blockedbyclient');}
    if(request.isNavigationRequest()) return route.continue({url:remap(url.href)});
    const response=await serve(surface,url.href,{method:request.method(),headers:await request.allHeaders(),...(request.postDataBuffer()?{body:request.postDataBuffer()}: {})},uid);
    const headers=Object.fromEntries(response.headers);
    delete headers['content-length'];delete headers['transfer-encoding'];delete headers['content-encoding'];
    if(headers['access-control-allow-origin']) headers['access-control-allow-origin']=request.headers().origin||'*';
    if(headers['access-control-allow-headers']) headers['access-control-allow-headers']+=', x-fixture-user';
    if(headers.location) headers.location=remap(headers.location);
    await route.fulfill({status:response.status,headers,body:response.status>=300&&response.status<400?'':Buffer.from(await response.arrayBuffer())});
   });
   await c.routeWebSocket('**/*',ws=>ws.close());
   return c;
  };
  try {
   let promoter, promoterPage;
   if(consoleDist) {
    promoterPage=await (await context('gh:promoter')).newPage();
    await promoterPage.goto(local.store+'/promoters?app='+appId);
    const available = await (await api.fetch(API+'/v1/storefront/promoters/apps')).json();
    assert.deepEqual(await promoterPage.locator('#promoApps button[data-app-id]').evaluateAll(buttons=>buttons.map(b=>b.dataset.appId)),available.apps.map(a=>a.appId));
    await promoterPage.getByRole('link',{name:'Promoter sign in',exact:true}).first().focus();
    await promoterPage.keyboard.press('Enter');
    await promoterPage.getByRole('button',{name:/Google/}).click();
    await promoterPage.getByLabel(/agree|consent/i).check();
    await promoterPage.getByRole('button',{name:'Enroll',exact:true}).click();
    await expect(promoterPage.getByRole('heading',{name:'Your link and code'})).toBeVisible();
    await expect(promoterPage.getByAltText('QR code for your personal app link')).toBeVisible();
    promoter=(await (await person('gh:promoter',`/apps/${appId}/promoters/me`)).json()).promoter;
    result.checks.push('actual storefront to Console signup; real enrollment, link and QR');
   } else {
    const r=await person('gh:promoter',`/apps/${appId}/promoters/enroll`,'POST',{consent:true}); assert.equal(r.status,201); promoter=(await r.json()).promoter;
   }
   assert.equal((await counts()).confirmed,0);
   const referred=await (await context('gh:referee')).newPage();
   await referred.goto(local.app+'/?ref='+promoter.code);
   await expect(referred.getByRole('button',{name:'Continue with Google'})).toBeVisible();
   assert.equal(await referred.evaluate(()=>JSON.parse(localStorage.getItem('pas_referral')).code),promoter.code);
   await referred.reload();
   assert.equal((await counts()).confirmed,0);
   await referred.getByRole('button',{name:'Continue with Google'}).click();
   await expect.poll(async()=> (await counts()).confirmed).toBe(1);
   for(let i=0;i<2;i++) {await referred.reload(); await expect.poll(async()=> (await counts()).confirmed).toBe(1);}
   assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM app_referral_attributions').first()).n,1);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM app_referral_events WHERE to_status='confirmed'").first()).n,1);
   result.checks.push('exact app build captures referral, survives reload and real cookie callback, confirms once through real HostApi/D1');
   await expect.poll(()=>referred.evaluate(()=>localStorage.getItem('pas_referral'))).toBeNull();
   if(promoterPage) {
    await promoterPage.reload();
    await promoterPage.getByLabel('Display name',{exact:true}).fill('Synthetic promoter');
    await promoterPage.getByLabel('Show my public name',{exact:true}).check();
    await promoterPage.getByLabel('Show my promotion contribution publicly',{exact:true}).check();
    await promoterPage.getByRole('button',{name:'Save public choices'}).click();
    await expect.poll(async()=> (await (await api.fetch(API+`/v1/storefront/apps/${appId}/contributors`)).json()).contributors.length).toBe(1);
    await promoterPage.reload();
    await expect(promoterPage.getByLabel('Show my promotion contribution publicly',{exact:true})).toBeChecked();
    const visitor=await (await context('gh:organic')).newPage();
    await visitor.goto(local.store+'/apps/'+appId+'/#contributors');
    await expect(visitor.getByText('Synthetic promoter',{exact:true})).toBeVisible();
    await promoterPage.getByRole('button',{name:'Hide public profile'}).click();
    await expect.poll(async()=> (await (await api.fetch(API+`/v1/storefront/apps/${appId}/contributors`)).json()).contributors.length).toBe(0);
    await visitor.reload(); await expect(visitor.getByText('Synthetic promoter',{exact:true})).toHaveCount(0);
    for(const page of [promoterPage,visitor]) for(const width of [320,390]) {await page.setViewportSize({width,height:844}); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');}
    result.checks.push('saved consent reload and visible contributor card opt-in/withdrawal; mobile layouts');
   }
   const legacy = await person('gh:organic',`/apps/${appId}/referrals/claim`,'POST',{code:promoter.code});
   assert.equal((await legacy.json()).state,'unverified_origin');
   await db.prepare("INSERT INTO app_visibility (app_id,mode,roles,created_at) VALUES (?,'private','[]',1)").bind(appId).run();
   const privatePage=await (await context('gh:private')).newPage();
   await privatePage.goto(local.app+'/?ref='+promoter.code);
   await privatePage.getByRole('button',{name:'Continue with Google'}).click();
   await expect.poll(async()=>privatePage.evaluate(()=>localStorage.getItem('pas_referral'))).toBeNull();
   assert.equal((await counts()).confirmed,1);
   assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM app_referral_attributions').first()).n,1);
   result.checks.push('legacy direct claim and private app create no credit');
   await referred.screenshot({path:join(artifacts,engine+'.png'),fullPage:true});
   result.passed=true;
   console.log(engine+': '+result.checks.join('; '));
  } catch(e) {result.pages=[]; for(const c of contexts) for(const p of c.pages()) result.pages.push({url:p.url(),text:await p.locator('body').innerText().catch(()=>'' )}); result.error=String(e.stack||e);throw e;}
  finally {await browser.close();await writeFile(join(artifacts,'results.json'),JSON.stringify(report,null,2));}
 }
 assert.deepEqual(await hashes(dist),report.appFiles,'tested build changed');
} finally {for(const server of servers) {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));} if(mf) await mf.dispose();await rm(temporary,{recursive:true,force:true});}
