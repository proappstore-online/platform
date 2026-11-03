#!/usr/bin/env node
/** Real-browser SDK acceptance. No mocks for IndexedDB, workers, SW or offline networking. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test/fixtures/offline-reference');
const artifacts = join(root, 'artifacts/offline-browser');
const temporary = await mkdtemp(join(tmpdir(), 'pas-offline-'));
await mkdir(artifacts, { recursive: true });
const bytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 251));
const digest = createHash('sha256').update(bytes).digest('hex');
let revision = '1';
const requests = [];
await build({ entryPoints: [join(fixture, 'app.tsx')], outfile: join(temporary, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', nodePaths: [join(root, 'packages/sdk/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/.pas/')) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('{"error":"offline-reference-no-auth"}'); return; }
    if (path === '/asset.bin' || path === '/corrupt.bin') {
      const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
      requests.push({ path, start, ifRange: req.headers['if-range'] });
      const content = path === '/corrupt.bin' ? Buffer.alloc(bytes.length, 0) : bytes;
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length - start, 'ETag': '"fixture-v1"', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (start) headers['Content-Range'] = `bytes ${start}-${content.length - 1}/${content.length}`;
      res.writeHead(start ? 206 : 200, headers);
      let offset = start;
      const timer = setInterval(() => { if (offset >= content.length) { clearInterval(timer); res.end(); } else { res.write(content.subarray(offset, offset + 16384)); offset += 16384; } }, 12);
      res.on('close', () => clearInterval(timer)); return;
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/worker.js': ['worker.js', 'text/javascript'], '/sw.js': ['sw.js', 'text/javascript'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'] };
    const spec = files[path];
    if (!spec) { res.writeHead(404); res.end(); return; }
    let data = await readFile(join(path === '/app.js' ? temporary : fixture, spec[0]));
    if (path === '/sw.js') data = Buffer.from(data.toString().replace('__REVISION__', revision));
    res.writeHead(200, { 'Content-Type': spec[1], 'Cache-Control': 'no-store' }); res.end(data);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const manifest = { id: 'fixture-model', version: '1', url: `${origin}/asset.bin`, sha256: digest, bytes: bytes.length };
const results = [];
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    revision = '1'; requests.length = 0;
    const profile = join(temporary, `${name}-profile`);
    let context = await engine.launchPersistentContext(profile, { viewport: { width: 390, height: 844 } });
    const result = { engine: name, checks: [], scope: 'Browser engines with synthetic worker; no physical-device or speech-quality claim' };
    try {
      let page = await context.newPage();
      const open = async () => { await page.goto(origin); await page.getByRole('heading', { name: 'Offline reference' }).waitFor(); await page.evaluate(() => window.offlineReference.ready.then(() => undefined)); };
      await open();
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await page.evaluate(() => window.offlineReference.save());
      assert.equal(await page.evaluate(() => window.offlineReference.store.getBlob('lesson').then(b => b.text())), 'persisted audio fixture');
      result.checks.push('local shell renders without authenticated response; transactional text and blob persisted');

      const interrupted = await page.evaluate(async m => {
        const ref = window.offlineReference;
        const abort = new AbortController();
        try { await ref.downloads.download(m, { signal: abort.signal, onProgress: p => { if (p.loaded >= 32768) abort.abort(); } }); } catch (e) { if (e.name !== 'AbortError') throw e; }
        return ref.downloads.status(m);
      }, manifest);
      assert.equal(interrupted.state, 'partial'); assert.ok(interrupted.loaded > 0 && interrupted.loaded < bytes.length);
      assert.equal(await page.evaluate(async m => (await window.offlineReference.downloads.download(m)).size, manifest), bytes.length);
      assert.ok(requests.some(r => r.start > 0 && r.ifRange === '"fixture-v1"'));
      const corrupted = await page.evaluate(async m => {
        const bad = { ...m, id: 'bad-model', url: `${location.origin}/corrupt.bin` };
        let code;
        try { await window.offlineReference.downloads.download(bad); } catch (error) { code = error.code; }
        return { code, status: await window.offlineReference.downloads.status(bad), value: await window.offlineReference.downloads.get(bad) };
      }, manifest);
      assert.deepEqual(corrupted, { code: 'integrity', status: null, value: null });
      result.checks.push('interrupted download resumes validated HTTP range; corrupt artifact rejected and removed');

      assert.deepEqual(await page.evaluate(async () => {
        const create = window.offlineReference.createOfflineStore;
        let owner = 'alice';
        const alice = create({ appId: 'offline-reference', scope: { kind: 'account', ownerId: 'alice' }, canAccess: () => owner === 'alice' });
        await alice.put({ id: 'secret', value: 'alice only' });
        owner = 'bob';
        const bob = create({ appId: 'offline-reference', scope: { kind: 'account', ownerId: 'bob' }, canAccess: () => owner === 'bob' });
        let denied = false;
        try { await alice.get('secret'); } catch { denied = true; }
        const other = await bob.get('secret');
        alice.close(); bob.close(); return { denied, other };
      }), { denied: true, other: null });
      result.checks.push('account namespaces isolated; retained handle denied after explicit local owner change');
      const peer = await context.newPage();
      await peer.goto(origin);
      await peer.getByRole('heading', { name: 'Offline reference' }).waitFor();
      for (const accountPage of [page, peer]) {
        await accountPage.evaluate(() => {
          const ref = window.offlineReference;
          const account = ref.createOfflineStore({ appId: 'offline-reference', scope: { kind: 'account', ownerId: 'bound-owner' }, canAccess: () => true });
          // Explicitly exercise auth lifecycle callbacks; this is not a cached authenticated user.
          const dispose = ref.bindOfflineAccount(account, { onChange: listener => { window.emitAccountChange = listener; return () => {}; } });
          Object.assign(window, { boundAccount: account, disposeAccountBinding: dispose });
        });
      }
      await page.evaluate(() => window.boundAccount.put({ id: 'bound-record', value: 'private' }));
      assert.equal(await peer.evaluate(async () => (await window.boundAccount.get('bound-record')).value), 'private');
      await page.evaluate(() => window.emitAccountChange(null));
      await expect.poll(() => peer.evaluate(async () => { try { await window.boundAccount.get('bound-record'); return false; } catch (error) { return error.code === 'closed' || error.code === 'locked'; } })).toBe(true);
      await page.evaluate(() => window.disposeAccountBinding());
      await peer.evaluate(() => window.disposeAccountBinding());
      await peer.close();
      result.checks.push('sign-out lifecycle in one page revokes another page bound to the same account');

      const exportAndQueue = await page.evaluate(async () => {
        const ref = window.offlineReference;
        const exported = JSON.parse(await (await ref.store.exportRecord('lesson')).text());
        await ref.store.put({ id: 'remove-me', value: 'temporary', blob: new Blob(['remove']) });
        await ref.store.delete('remove-me');
        await ref.queue.enqueue({ id: 'save-position', kind: 'position', payload: { position: 2 }, idempotent: true });
        const pending = await ref.queue.get('save-position');
        const deliveries = [];
        const handlers = { position: async (payload, { operationId }) => { deliveries.push({ payload, operationId }); } };
        await ref.queue.flush(handlers);
        await ref.queue.flush(handlers);
        return { exported, removed: await ref.store.get('remove-me'), removedBlob: await ref.store.getBlob('remove-me'), pending: pending.status, deliveries };
      });
      assert.equal(exportAndQueue.exported.record.value.text, '你好，世界');
      assert.equal(Buffer.from(exportAndQueue.exported.base64, 'base64').toString(), 'persisted audio fixture');
      assert.equal(exportAndQueue.removed, null); assert.equal(exportAndQueue.removedBlob, null);
      assert.equal(exportAndQueue.pending, 'pending'); assert.deepEqual(exportAndQueue.deliveries, [{ payload: { position: 2 }, operationId: 'save-position' }]);
      result.checks.push('explicit export includes blob; deletion removes blob and metadata; queue waits for explicit flush and passes stable operation ID');

      const lockLifecycle = await page.evaluate(async manifest => {
        const ref = window.offlineReference;
        const isolated = ref.createOfflineStore({ appId: 'offline-lock-reference', scope: { kind: 'device' } });
        const jobs = ref.createLocalJobs(isolated);
        const downloads = ref.createDownloadManager(isolated);
        await jobs.create({ id: 'nested', kind: 'nested-download', input: null });
        let signalStarted, release;
        const started = new Promise(resolve => { signalStarted = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const running = jobs.run('nested', async () => {
          signalStarted(); await gate;
          return (await downloads.download(manifest)).size;
        });
        await started;
        let clearCode;
        try { await isolated.clear(); } catch (error) { clearCode = error.code; }
        release();
        const completed = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('Nested job/download lock timed out')), 10000))]);
        await isolated.clear();
        const job = await jobs.get('nested');
        const artifact = await downloads.get(manifest);
        isolated.close();
        return { clearCode, completed: completed.status, size: completed.result, job, artifact };
      }, manifest);
      assert.deepEqual(lockLifecycle, { clearCode: 'busy', completed: 'completed', size: bytes.length, job: null, artifact: null });
      result.checks.push('clear fails busy during active job; nested download remains live; clear removes finished work and artifact');

      await page.evaluate(async () => {
        await window.offlineReference.jobs.create({ id: 'work', kind: 'checksum', input: { text: '你好，世界' } });
        void window.offlineReference.runJob('work', 2);
      });
      await expect.poll(() => page.evaluate(async () => (await window.offlineReference.jobs.get('work'))?.checkpoint?.step)).toBe(2);
      assert.equal((await page.evaluate(() => window.offlineReference.jobs.get('work'))).checkpoint?.step, 2, 'checkpoint committed before process shutdown');
      await context.setOffline(true);
      await context.close();
      context = await engine.launchPersistentContext(profile, { offline: true, viewport: { width: 390, height: 844 } });
      page = await context.newPage(); await open();
      const restarted = await page.evaluate(async m => {
        const ref = window.offlineReference;
        const count = await ref.jobs.recover();
        const interruptedJob = await ref.jobs.get('work');
        const completed = await ref.runJob('work');
        return { count, interruptedJob, completed, lesson: await ref.store.get('lesson'), audio: await (await ref.store.getBlob('lesson')).text(), modelBytes: (await ref.downloads.get(m)).size };
      }, manifest);
      assert.equal(restarted.count, 1); assert.equal(restarted.interruptedJob.status, 'interrupted'); assert.equal(restarted.interruptedJob.checkpoint.step, 2);
      assert.equal(restarted.completed.result, Array.from('你好，世界').reduce((sum, character) => sum + character.codePointAt(0), 0) * 15);
      assert.equal(restarted.completed.status, 'completed'); assert.equal(restarted.completed.checkpoint.step, 5);
      assert.equal(restarted.lesson.value.text, '你好，世界'); assert.equal(restarted.audio, 'persisted audio fixture'); assert.equal(restarted.modelBytes, bytes.length);
      result.checks.push('cold browser-process restart offline loads shell, text/blob/model; killed worker job recovers committed checkpoint and completes');
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} horizontal overflow at ${width}px`);
        await page.screenshot({ path: join(artifacts, `${name}-${width}.png`), fullPage: true });
      }
      result.checks.push('local shell fits 320px and 390px viewports');

      await context.setOffline(false);
      await page.evaluate(() => window.offlineReference.jobs.create({ id: 'update-job', kind: 'checksum', input: { text: '你好' } }));
      revision = '2';
      await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
      await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
      await page.evaluate(() => new Promise((resolve, reject) => { navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }); window.offlineReference.activateUpdate().catch(reject); }));
      await page.reload(); await page.getByRole('heading', { name: 'Offline reference' }).waitFor();
      assert.equal(await page.evaluate(async () => (await window.offlineReference.jobs.get('update-job')).checkpoint.step), 3);
      assert.equal(await page.evaluate(async () => (await window.offlineReference.store.get('lesson')).value.position), 2);
      const cachesState = await page.evaluate(async () => ({ names: await caches.keys(), urls: (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(req => req.url)))).flat() }));
      assert.deepEqual(cachesState.names, ['pas-offline-reference-2']);
      assert.ok(cachesState.urls.every(url => !new URL(url).pathname.startsWith('/.pas/')));
      result.checks.push('waiting service worker activates after durable checkpoint; content survives; auth responses absent from caches');
      result.passed = true;
      console.log(`${name}: ${result.checks.length} offline acceptance checks passed`);
    } catch (error) { result.passed = false; result.error = error.stack ?? String(error); throw error; }
    finally { results.push(result); await context.close(); await writeFile(join(artifacts, 'results.json'), `${JSON.stringify(results, null, 2)}\n`); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
