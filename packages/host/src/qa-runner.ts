/**
 * The observable QA runner (#38) — served on the APP'S OWN ORIGIN at /__qa/,
 * so the app iframe is same-origin and the DOM runner drives it directly (we
 * host the apps; there is deliberately no cross-origin machinery here).
 *
 * The page is an inert shell: every data call goes through the /.pas/api
 * cookie mediation, so only a signed-in platform user who owns the app can
 * list flows, start runs, or report results. Signed-out / non-owner visitors
 * see the corresponding state, never data.
 */
import { DOM_RUNNER_BUNDLE } from "@proappstore/qa-spec/browser-bundle";
import type { ResolvedRoute } from "./host.js";

export const QA_PREFIX = "/__qa";

export function handleQaRunner(request: Request, route: ResolvedRoute): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== QA_PREFIX && !url.pathname.startsWith(`${QA_PREFIX}/`)) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  if (url.pathname === `${QA_PREFIX}/runner.js`) {
    return new Response(`${DOM_RUNNER_BUNDLE}\n${glueJs(route.slug)}`, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // /__qa and /__qa/ (and anything else under it) → the runner page
  return new Response(runnerHtml(route.slug), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

function runnerHtml(appId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>QA · ${escapeHtml(appId)}</title>
<style>
  :root { color-scheme: light; --line:#e5e5e5; --muted:#666; --ok:#16a34a; --bad:#dc2626; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui, sans-serif; color:#111; display:flex; height:100vh; }
  aside { width:340px; min-width:280px; border-right:1px solid var(--line); display:flex; flex-direction:column; }
  header { padding:12px 14px; border-bottom:1px solid var(--line); }
  header h1 { font-size:15px; margin:0; }
  header p { margin:4px 0 0; color:var(--muted); font-size:12px; }
  #banner { background:#fef3c7; border-bottom:1px solid #f59e0b55; padding:8px 14px; font-size:12px; display:none; }
  #flows { overflow-y:auto; flex:1; }
  .flow { padding:10px 14px; border-bottom:1px solid var(--line); }
  .flow-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .flow-name { font-weight:600; }
  .flow button { border:1px solid var(--line); background:#fff; border-radius:8px; padding:4px 12px; cursor:pointer; font-weight:600; }
  .flow button:disabled { opacity:.5; cursor:default; }
  ol.steps { list-style:none; margin:8px 0 0; padding:0; font-size:12px; color:var(--muted); display:none; }
  .flow.open ol.steps { display:block; }
  ol.steps li { padding:2px 0 2px 20px; position:relative; }
  ol.steps li::before { content:'·'; position:absolute; left:6px; }
  ol.steps li.running::before { content:'▶'; color:var(--accent); }
  ol.steps li.ok::before { content:'✓'; color:var(--ok); }
  ol.steps li.fail::before { content:'✗'; color:var(--bad); }
  ol.steps li.fail { color:var(--bad); }
  .verdict { font-size:12px; font-weight:700; margin-top:6px; }
  .verdict.ok { color:var(--ok); } .verdict.bad { color:var(--bad); }
  main { flex:1; display:flex; }
  iframe { flex:1; border:0; }
  #state { padding:20px; color:var(--muted); }
  #state a { color:var(--accent); }
</style>
</head>
<body>
<aside>
  <header>
    <h1>QA runner — ${escapeHtml(appId)}</h1>
    <p>Watch flows run live in the app. Tests act as real users.</p>
  </header>
  <div id="banner">Heads-up: flows that sign in will replace the app session in this browser tab’s storage. <a href="#" id="restore">Sign the app out</a> to reset.</div>
  <div id="state">Loading…</div>
  <div id="flows"></div>
</aside>
<main><iframe id="app" src="/" title="app under test"></iframe></main>
<script src="${QA_PREFIX}/runner.js"></script>
</body>
</html>`;
}

/** Page logic appended after the dom-runner bundle (globalThis.__pasQaRunner). */
function glueJs(appId: string): string {
  return `(() => {
  const APP_ID = ${JSON.stringify(appId)};
  const $ = (s) => document.querySelector(s);
  const iframe = $('#app');
  const stateEl = $('#state');
  const flowsEl = $('#flows');

  async function api(path, init) {
    const res = await fetch('/.pas/api' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, init));
    if (res.status === 401) throw Object.assign(new Error('signin'), { code: 401 });
    if (res.status === 403) throw Object.assign(new Error('forbidden'), { code: 403 });
    if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
    return res.json();
  }

  $('#restore').addEventListener('click', (e) => {
    e.preventDefault();
    try { iframe.contentWindow.localStorage.clear(); } catch {}
    iframe.src = '/';
  });

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function navigate(path) {
    return new Promise((resolve) => {
      iframe.addEventListener('load', () => setTimeout(resolve, 150), { once: true });
      iframe.src = path;
    });
  }

  async function runOne(flow, ui) {
    ui.button.disabled = true;
    ui.verdict.textContent = '';
    ui.items.forEach((li) => (li.className = ''));
    $('#banner').style.display = 'block';

    let runId = null;
    try {
      const started = await api('/v1/apps/' + APP_ID + '/qa/runs', {
        method: 'POST',
        body: JSON.stringify({ flowId: flow.id, trigger: 'browser' }),
      });
      runId = started.runs[0].runId;
    } catch (e) {
      ui.verdict.className = 'verdict bad';
      ui.verdict.textContent = 'could not start run: ' + e.message;
      ui.button.disabled = false;
      return;
    }

    const result = await __pasQaRunner.runFlow(flow, {
      getDocument: () => iframe.contentDocument,
      navigate,
      onStep: (r) => {
        const li = ui.items[r.index];
        if (li) { li.className = r.ok ? 'ok' : 'fail'; if (r.error) li.title = r.error; }
        const next = ui.items[r.index + 1];
        if (next && r.ok) next.className = 'running';
      },
    });

    ui.verdict.className = 'verdict ' + (result.ok ? 'ok' : 'bad');
    const failed = result.failedStep !== null ? result.results[result.failedStep] : null;
    ui.verdict.textContent = result.ok
      ? 'PASSED (' + result.results.length + ' steps)'
      : 'FAILED at step ' + (result.failedStep + 1) + ' — ' + (failed && failed.error ? failed.error : '');

    try {
      await api('/v1/apps/' + APP_ID + '/qa/runs/' + runId + '/report', {
        method: 'POST',
        body: JSON.stringify({
          status: result.ok ? 'passed' : 'failed',
          stepsTotal: flow.steps.length,
          stepsPassed: result.results.filter((r) => r.ok).length,
          failedStep: result.failedStep,
          error: failed && failed.error ? failed.error : null,
        }),
      });
    } catch {}
    ui.button.disabled = false;
  }

  function describeStep(s) {
    const t = s.target ? (s.target.label || s.target.text || s.target.selector) : '';
    switch (s.op) {
      case 'goto': return 'go to ' + s.path;
      case 'click': return 'click "' + t + '"';
      case 'clickPoint': return 'click at ' + s.xPct + '%, ' + s.yPct + '%';
      case 'fill': return 'type into "' + t + '"';
      case 'press': return 'press ' + s.key;
      case 'expectVisible': return 'expect "' + t + '" visible';
      case 'expectText': return 'expect text "' + s.text + '"';
      case 'waitFor': return s.target ? 'wait for "' + t + '"' : 'wait ' + s.ms + 'ms';
      case 'screenshot': return 'screenshot';
      default: return s.op;
    }
  }

  function render(flows) {
    stateEl.style.display = 'none';
    flowsEl.textContent = '';
    if (flows.length === 0) {
      stateEl.style.display = 'block';
      stateEl.textContent = 'No flows yet. The QA agent (or the API) can add them — nothing lives in the app repo.';
      return;
    }
    for (const row of flows) {
      const flow = row.spec;
      const box = el('div', 'flow');
      const head = el('div', 'flow-head');
      head.append(el('span', 'flow-name', flow.name));
      const btn = el('button', '', 'Run');
      head.append(btn);
      box.append(head);
      const list = el('ol', 'steps');
      const items = flow.steps.map((s) => { const li = el('li', '', describeStep(s)); list.append(li); return li; });
      box.append(list);
      const verdict = el('div', 'verdict');
      box.append(verdict);
      head.addEventListener('click', (e) => { if (e.target !== btn) box.classList.toggle('open'); });
      btn.addEventListener('click', () => { box.classList.add('open'); runOne(flow, { button: btn, items, verdict }); });
      flowsEl.append(box);
    }
    const auto = new URLSearchParams(location.search).get('flow');
    if (auto) {
      const target = flows.find((f) => f.spec.id === auto);
      if (target) flowsEl.querySelectorAll('.flow button')[flows.indexOf(target)].click();
    }
  }

  api('/v1/apps/' + APP_ID + '/qa/flows')
    .then((data) => render(data.flows))
    .catch((e) => {
      if (e.code === 401) {
        stateEl.innerHTML = 'Sign in with your platform account to run tests. <a href="/.pas/auth/start?provider=github&return_to=' +
          encodeURIComponent('/__qa/') + '">Sign in with GitHub</a>';
      } else if (e.code === 403) {
        stateEl.textContent = 'This page is for the app\\u2019s developers — your account doesn\\u2019t own this app.';
      } else {
        stateEl.textContent = 'Could not load flows: ' + e.message;
      }
    });
})();`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
