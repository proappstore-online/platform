/** Platform lifecycle fixture, not a speech model or a production language app. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { initPro, AppShell } from '../../../packages/sdk/src/index';
import { createOfflineStore, createDownloadManager, createLocalJobs, createSyncQueue, bindOfflineAccount } from '../../../packages/sdk/src/offline';

const app = initPro({ appId: 'offline-reference', authMode: 'platform-cookie', proApiBase: location.origin, usage: { auto: false }, monitoring: { auto: false } });
const store = createOfflineStore({ appId: 'offline-reference', scope: { kind: 'device' } });
const jobs = createLocalJobs(store);
const downloads = createDownloadManager(store, { checkpointBytes: 16384, maxBytes: 1024 * 1024 });
const queue = createSyncQueue(store);
const workerStep = (state: {step:number;sum:number}, text: string) => new Promise<{step:number;sum:number}>((resolve, reject) => {
  const worker = new Worker('/worker.js');
  worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
  worker.onerror = (error) => { worker.terminate(); reject(error); };
  worker.postMessage({ ...state, text });
});
const runJob = (id: string, stopAfter?: number) => jobs.run<{text:string}, {step:number;sum:number}, number>(id, async (input, context) => {
  let state = context.savedCheckpoint ?? { step: 0, sum: 0 };
  while (state.step < 5) {
    state = await workerStep(state, input.text);
    await context.checkpoint(state);
    // Simulate a process that will be killed by closing its browser page.
    if (state.step === stopAfter) await new Promise(() => {});
  }
  return state.sum;
});
const ready = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
const reference = {
  store, jobs, downloads, queue, ready, runJob, createOfflineStore, bindOfflineAccount, createLocalJobs, createDownloadManager,
  async save() { await store.put({ id: 'lesson', value: { text: '你好，世界', position: 2 }, blob: new Blob(['persisted audio fixture'], { type: 'audio/wav' }) }); },
  async activateUpdate() {
    await jobs.checkpoint('update-job', { step: 3, sum: 42 });
    await jobs.setStatus('update-job', 'paused');
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.waiting) throw new Error('No waiting update');
    registration.waiting.postMessage('ACTIVATE_AFTER_CHECKPOINT');
  },
};
Object.assign(window, { offlineReference: reference });
function Content() {
  const [status, setStatus] = React.useState('Ready for local work');
  return <section className="reference"><h1>Offline reference</h1><p>Deterministic lifecycle fixture. No speech model is loaded.</p><label htmlFor="text">Practice text</label><textarea id="text" defaultValue="你好，世界"/><button onClick={() => reference.save().then(() => setStatus('Saved locally'))}>Save locally</button><p role="status">{status}</p></section>;
}
createRoot(document.getElementById('root')!).render(<AppShell app={app} appName="Offline reference" branding="app" access="local"><Content/></AppShell>);
