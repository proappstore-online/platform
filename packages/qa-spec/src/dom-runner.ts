/**
 * The in-page flow executor — the SINGLE implementation of step semantics.
 * The observable runner page calls it against the app iframe's document; the
 * headless qa-worker injects this same code (browser bundle) via
 * page.evaluate. There must never be a second resolver implementation.
 *
 * Environment: a real (or happy-dom) DOM. No imports beyond ./types.
 */
import { DEFAULT_TIMEOUT_MS, type FlowResult, type Step, type StepResult, type Target, type TestFlow } from './types.js';

export interface RunnerHost {
  /** Current document under test (re-read after navigations). */
  getDocument(): Document;
  /** Perform a same-app navigation to a path and resolve when loaded. */
  navigate(path: string): Promise<void>;
  /** Optional screenshot hook (runner page / qa-worker implement it). */
  screenshot?(name: string): Promise<void>;
  /** Live progress callback. */
  onStep?(result: StepResult): void;
  /** Per-expect timeout override (tests use a short one). */
  timeoutMs?: number;
}

export async function runFlow(flow: TestFlow, host: RunnerHost): Promise<FlowResult> {
  const results: StepResult[] = [];
  if (flow.startPath) await host.navigate(flow.startPath);

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i]!;
    const started = now();
    let error: string | undefined;
    try {
      await runStep(step, host);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const result: StepResult = {
      index: i,
      op: step.op,
      ok: !error,
      ms: Math.round(now() - started),
      ...(error !== undefined ? { error } : {}),
    };
    results.push(result);
    host.onStep?.(result);
    if (error) return { ok: false, results, failedStep: i };
  }
  return { ok: true, results, failedStep: null };
}

async function runStep(step: Step, host: RunnerHost): Promise<void> {
  const timeout = host.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (step.op) {
    case 'goto':
      await host.navigate(step.path);
      return;
    case 'click': {
      const el = await waitForTarget(host, step.target, timeout);
      clickElement(el);
      return;
    }
    case 'clickPoint': {
      clickAtPoint(host.getDocument(), step.xPct, step.yPct);
      return;
    }
    case 'fill': {
      const el = await waitForTarget(host, step.target, timeout);
      fillElement(el, step.value);
      return;
    }
    case 'press': {
      pressKey(host.getDocument(), step.key);
      return;
    }
    case 'expectVisible':
      await waitForTarget(host, step.target, timeout);
      return;
    case 'expectText':
      await poll(timeout, () => bodyContains(host.getDocument(), step.text), `text "${step.text}" not found`);
      return;
    case 'waitFor':
      if (step.target) await waitForTarget(host, step.target, Math.max(timeout, step.ms ?? 0));
      else await sleep(step.ms ?? 0);
      return;
    case 'screenshot':
      await host.screenshot?.(step.name ?? `step`);
      return;
  }
}

// ── target resolution ────────────────────────────────────────────────────────

/** Find the target element, or null. Priority: selector > label > text. */
export function resolveTarget(doc: Document, target: Target): Element | null {
  if (target.selector) {
    try {
      return firstVisible(doc.querySelectorAll(target.selector));
    } catch {
      return null; // invalid selector behaves as not-found
    }
  }
  if (target.label !== undefined) {
    const want = target.label.trim();
    return firstVisible(doc.querySelectorAll('[aria-label]'), (el) => (el.getAttribute('aria-label') ?? '').trim() === want);
  }
  if (target.text !== undefined) {
    const want = normText(target.text);
    const candidates = doc.querySelectorAll(
      'button, a, [role="button"], [role="link"], [role="tab"], input[type="submit"], input[type="button"], label, summary, [onclick]',
    );
    // Exact match first, then containment — innermost match wins on ties.
    const exact = allVisible(candidates).filter((el) => normText(el.textContent ?? '') === want);
    if (exact.length > 0) return innermost(exact);
    const partial = allVisible(candidates).filter((el) => normText(el.textContent ?? '').includes(want));
    return partial.length > 0 ? innermost(partial) : null;
  }
  return null;
}

async function waitForTarget(host: RunnerHost, target: Target, timeoutMs: number): Promise<Element> {
  let el: Element | null = null;
  await poll(timeoutMs, () => {
    el = resolveTarget(host.getDocument(), target);
    return el !== null;
  }, `target ${describeTarget(target)} not found`);
  return el!;
}

function describeTarget(t: Target): string {
  if (t.selector) return `selector "${t.selector}"`;
  if (t.label) return `label "${t.label}"`;
  return `text "${t.text}"`;
}

function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (typeof html.getBoundingClientRect !== 'function') return true;
  // happy-dom returns 0-rects for everything; treat "no layout engine" as visible.
  const rect = html.getBoundingClientRect();
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle ? view.getComputedStyle(html) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  if (rect.width === 0 && rect.height === 0) {
    // Could be an unlaid-out test DOM — only treat as hidden when siblings have size.
    return !el.ownerDocument.body || el.ownerDocument.body.getBoundingClientRect().width === 0
      ? true
      : style === null;
  }
  return true;
}

function allVisible(list: NodeListOf<Element>): Element[] {
  return [...list].filter(isVisible);
}

function firstVisible(list: NodeListOf<Element>, extra?: (el: Element) => boolean): Element | null {
  for (const el of list) {
    if (!isVisible(el)) continue;
    if (extra && !extra(el)) continue;
    return el;
  }
  return null;
}

/** Of several matches, prefer the one not containing any other match (innermost). */
function innermost(els: Element[]): Element {
  return els.find((a) => !els.some((b) => b !== a && a.contains(b))) ?? els[0]!;
}

// ── event dispatch ───────────────────────────────────────────────────────────

function mouseInit(doc: Document, x?: number, y?: number): MouseEventInit {
  return { bubbles: true, cancelable: true, view: doc.defaultView, clientX: x ?? 0, clientY: y ?? 0 };
}

/**
 * Pointer-shaped init. `buttons` is 1 while the primary button is held
 * (pointerdown) and 0 once released (pointerup) — Chessground reads these.
 */
function pointerInit(doc: Document, x: number, y: number, buttons: 0 | 1): PointerEventInit {
  return {
    ...mouseInit(doc, x, y),
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons,
  };
}

/**
 * Dispatch a real `PointerEvent` when the environment provides one (browsers,
 * happy-dom). Chessground's select/move handlers read pointer fields
 * (`pointerId`, `isPrimary`, `button`) that a `MouseEvent` typed 'pointerdown'
 * never carries. Fall back to a pointer-shaped `MouseEvent` where the
 * constructor is missing so older runtimes still fire the listener.
 */
function dispatchPointer(target: EventTarget, type: string, doc: Document, x: number, y: number, buttons: 0 | 1): void {
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const PE = view?.PointerEvent ?? (typeof PointerEvent !== 'undefined' ? PointerEvent : undefined);
  const init = pointerInit(doc, x, y, buttons);
  target.dispatchEvent(PE ? new PE(type, init) : new MouseEvent(type, init));
}

export function clickElement(el: Element): void {
  const doc = el.ownerDocument;
  const rect = (el as HTMLElement).getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : 0;
  const y = rect ? rect.top + rect.height / 2 : 0;
  dispatchPointer(el, 'pointerdown', doc, x, y, 1);
  el.dispatchEvent(new MouseEvent('mousedown', mouseInit(doc, x, y)));
  dispatchPointer(el, 'pointerup', doc, x, y, 0);
  el.dispatchEvent(new MouseEvent('mouseup', mouseInit(doc, x, y)));
  (el as HTMLElement).click?.();
}

/** Click at a viewport-relative point — for coordinate UIs (board squares). */
export function clickAtPoint(doc: Document, xPct: number, yPct: number): void {
  const view = doc.defaultView;
  const w = view?.innerWidth ?? doc.documentElement.clientWidth;
  const h = view?.innerHeight ?? doc.documentElement.clientHeight;
  const x = (w * xPct) / 100;
  const y = (h * yPct) / 100;
  const el = doc.elementFromPoint(x, y) ?? doc.body;
  // Full pointer+mouse tap sequence. Chessground selects on pointerdown and
  // finalizes the click-move on pointerup; without a real pointerup the pointer
  // stays "down" and a second clickPoint never registers as a fresh tap.
  dispatchPointer(el, 'pointerdown', doc, x, y, 1);
  el.dispatchEvent(new MouseEvent('mousedown', mouseInit(doc, x, y)));
  dispatchPointer(el, 'pointerup', doc, x, y, 0);
  // Libraries like Chessground bind pointerup/mouseup on document to finalize.
  dispatchPointer(doc, 'pointerup', doc, x, y, 0);
  doc.dispatchEvent(new MouseEvent('mouseup', mouseInit(doc, x, y)));
  el.dispatchEvent(new MouseEvent('click', mouseInit(doc, x, y)));
}

/**
 * React ignores direct `el.value = x` (its value tracker sees no change), so
 * set via the native prototype setter, then dispatch input/change.
 */
export function fillElement(el: Element, value: string): void {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const view = el.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  const proto = input.tagName === 'TEXTAREA'
    ? (view?.HTMLTextAreaElement ?? HTMLTextAreaElement).prototype
    : (view?.HTMLInputElement ?? HTMLInputElement).prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  input.focus?.();
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function pressKey(doc: Document, key: string): void {
  const el = doc.activeElement ?? doc.body;
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

function bodyContains(doc: Document, text: string): boolean {
  return normText(doc.body?.textContent ?? '').includes(normText(text));
}

// ── timing ───────────────────────────────────────────────────────────────────

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function poll(timeoutMs: number, check: () => boolean, failMsg: string): Promise<void> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (now() >= deadline) throw new Error(failMsg);
    await sleep(100);
  }
}
