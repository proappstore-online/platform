/**
 * Platform test-flow spec — the single test definition executed by:
 *  - the observable runner page (same-origin iframe, watch it live)
 *  - the headless qa-worker (Cloudflare Browser Rendering)
 *  - Playwright (via the transpiler, best-effort parity)
 *
 * Deliberately a SUBSET of what Playwright can express. Targets are
 * aria-label / visible text / CSS selector — no full role+accessible-name
 * engine (that is a spec-sized project). Coordinate UIs (e.g. chess board
 * squares) use `clickPoint`, which has no semantic alternative.
 */

/** How a step finds its element. Exactly one field should be set. */
export interface Target {
  /** Exact match on aria-label. */
  label?: string;
  /** Visible text of a clickable/labelled element (exact, then contains). */
  text?: string;
  /** CSS selector (escape hatch — brittle across app changes). */
  selector?: string;
}

export type Step =
  /** Navigate the app (path relative to the app origin, e.g. "/puzzles"). */
  | { op: 'goto'; path: string }
  | { op: 'click'; target: Target }
  /** Click at a viewport-relative point (percentages 0–100). For coordinate
   *  UIs like board squares that have no semantic identity. */
  | { op: 'clickPoint'; xPct: number; yPct: number }
  | { op: 'fill'; target: Target; value: string }
  /** Key press (e.g. "Enter") on the focused element. */
  | { op: 'press'; key: string }
  | { op: 'expectVisible'; target: Target }
  /** Expect the page body to contain this text (poll until timeout). */
  | { op: 'expectText'; text: string }
  /** Wait a fixed time (ms, capped) or for a target to appear. */
  | { op: 'waitFor'; ms?: number; target?: Target }
  /** Capture a screenshot (host-implemented; no-op where unsupported). */
  | { op: 'screenshot'; name?: string };

export interface TestFlow {
  /** Stable id (slug-like). */
  id: string;
  name: string;
  /** Optional starting path (defaults to "/"). */
  startPath?: string;
  steps: Step[];
}

export interface StepResult {
  index: number;
  op: Step['op'];
  ok: boolean;
  error?: string;
  ms: number;
}

export interface FlowResult {
  ok: boolean;
  results: StepResult[];
  failedStep: number | null;
}

export const MAX_STEPS = 100;
export const MAX_FLOWS_PER_APP = 20;
export const MAX_WAIT_MS = 15_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
