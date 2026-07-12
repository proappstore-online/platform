// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fillElement, resolveTarget, runFlow, type RunnerHost } from './dom-runner.js';
import type { TestFlow } from './types.js';

function docWith(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function host(overrides: Partial<RunnerHost> = {}): RunnerHost {
  return {
    getDocument: () => document,
    navigate: async () => {},
    timeoutMs: 300,
    ...overrides,
  };
}

describe('resolveTarget', () => {
  it('finds by exact aria-label', () => {
    const doc = docWith('<button aria-label="Sign in">go</button><button aria-label="Sign in with GitHub">gh</button>');
    const el = resolveTarget(doc, { label: 'Sign in' });
    expect(el?.textContent).toBe('go');
  });

  it('finds by visible text, exact before contains, innermost on ties', () => {
    const doc = docWith(`
      <button>Sign in with Google</button>
      <a href="#"><span>Sign in</span></a>
      <button>Sign in</button>
    `);
    const el = resolveTarget(doc, { text: 'sign in' });
    expect(['A', 'BUTTON']).toContain(el?.tagName);
    expect(el?.textContent?.trim()).toBe('Sign in');
  });

  it('finds by selector and returns null for invalid selectors', () => {
    const doc = docWith('<div id="x">hi</div>');
    expect(resolveTarget(doc, { selector: '#x' })?.textContent).toBe('hi');
    expect(resolveTarget(doc, { selector: ':::' })).toBeNull();
  });
});

describe('fillElement (React controlled inputs)', () => {
  it('sets value via native setter and fires input + change', () => {
    const doc = docWith('<input aria-label="Login" />');
    const input = doc.querySelector('input')!;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    fillElement(input, 'rabbit-bear-wolf');
    expect(input.value).toBe('rabbit-bear-wolf');
    expect(events).toEqual(['input', 'change']);
  });
});

describe('runFlow', () => {
  const flow: TestFlow = {
    id: 'login',
    name: 'login',
    steps: [
      { op: 'click', target: { text: 'student' } },
      { op: 'fill', target: { label: 'Login' }, value: 'qa-kid' },
      { op: 'expectText', text: 'welcome' },
    ],
  };

  it('runs steps in order, reports per-step results, stops on failure', async () => {
    docWith('<button id="s">student?</button><input aria-label="Login" />');
    document.getElementById('s')!.addEventListener('click', () => {
      const p = document.createElement('p');
      p.textContent = 'Welcome!';
      document.body.append(p);
    });

    const seen: string[] = [];
    const res = await runFlow(flow, host({ onStep: (r) => seen.push(`${r.op}:${r.ok}`) }));
    expect(res.ok).toBe(true);
    expect(res.failedStep).toBeNull();
    expect(seen).toEqual(['click:true', 'fill:true', 'expectText:true']);
  });

  it('fails with the step index and a useful error when a target never appears', async () => {
    docWith('<p>nothing here</p>');
    const res = await runFlow(flow, host());
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe(0);
    expect(res.results[0].error).toContain('text "student"');
  });

  it('honors startPath and goto via the host navigate hook', async () => {
    docWith('<p>ok</p>');
    const visited: string[] = [];
    const res = await runFlow(
      { id: 'nav', name: 'nav', startPath: '/a', steps: [{ op: 'goto', path: '/b' }, { op: 'expectText', text: 'ok' }] },
      host({ navigate: async (p) => { visited.push(p); } }),
    );
    expect(res.ok).toBe(true);
    expect(visited).toEqual(['/a', '/b']);
  });
});
