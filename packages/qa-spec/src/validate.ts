import { MAX_STEPS, MAX_WAIT_MS, type Step, type Target, type TestFlow } from './types.js';

const FLOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPS = new Set(['goto', 'click', 'clickPoint', 'fill', 'press', 'expectVisible', 'expectText', 'waitFor', 'screenshot']);

/** Validate an untrusted flow object. Returns null when valid, else the problem. */
export function validateFlow(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'flow must be an object';
  const flow = raw as Partial<TestFlow>;
  if (typeof flow.id !== 'string' || !FLOW_ID_RE.test(flow.id)) {
    return 'flow.id must be a slug (lowercase letters, digits, hyphens, ≤64 chars)';
  }
  if (typeof flow.name !== 'string' || flow.name.trim().length === 0 || flow.name.length > 120) {
    return 'flow.name must be a non-empty string ≤120 chars';
  }
  if (flow.startPath !== undefined && (typeof flow.startPath !== 'string' || !flow.startPath.startsWith('/'))) {
    return 'flow.startPath must start with "/"';
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) return 'flow.steps must be a non-empty array';
  if (flow.steps.length > MAX_STEPS) return `flow.steps must have at most ${MAX_STEPS} steps`;
  for (let i = 0; i < flow.steps.length; i++) {
    const err = validateStep(flow.steps[i]);
    if (err) return `step ${i + 1}: ${err}`;
  }
  return null;
}

function validateStep(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'must be an object';
  const step = raw as Record<string, unknown>;
  if (typeof step.op !== 'string' || !OPS.has(step.op)) return `unknown op "${String(step.op)}"`;
  switch (step.op as Step['op']) {
    case 'goto':
      if (typeof step.path !== 'string' || !step.path.startsWith('/')) return 'goto.path must start with "/"';
      return null;
    case 'click':
    case 'expectVisible':
      return validateTarget(step.target);
    case 'clickPoint': {
      for (const k of ['xPct', 'yPct'] as const) {
        const v = step[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return `clickPoint.${k} must be 0–100`;
      }
      return null;
    }
    case 'fill': {
      const t = validateTarget(step.target);
      if (t) return t;
      if (typeof step.value !== 'string' || step.value.length > 1000) return 'fill.value must be a string ≤1000 chars';
      return null;
    }
    case 'press':
      if (typeof step.key !== 'string' || step.key.length === 0 || step.key.length > 32) return 'press.key required';
      return null;
    case 'expectText':
      if (typeof step.text !== 'string' || step.text.trim().length === 0 || step.text.length > 500) return 'expectText.text required (≤500 chars)';
      return null;
    case 'waitFor': {
      const hasMs = step.ms !== undefined;
      const hasTarget = step.target !== undefined;
      if (!hasMs && !hasTarget) return 'waitFor needs ms or target';
      if (hasMs && (typeof step.ms !== 'number' || step.ms < 0 || step.ms > MAX_WAIT_MS)) return `waitFor.ms must be 0–${MAX_WAIT_MS}`;
      if (hasTarget) return validateTarget(step.target);
      return null;
    }
    case 'screenshot':
      if (step.name !== undefined && (typeof step.name !== 'string' || step.name.length > 64)) return 'screenshot.name must be ≤64 chars';
      return null;
  }
  return null;
}

function validateTarget(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'target must be an object';
  const t = raw as Target;
  const set = (['label', 'text', 'selector'] as const).filter((k) => t[k] !== undefined);
  const key = set[0];
  if (set.length !== 1 || key === undefined) return 'target must set exactly one of label | text | selector';
  const v = t[key];
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 300) return `target.${key} must be a non-empty string ≤300 chars`;
  return null;
}
