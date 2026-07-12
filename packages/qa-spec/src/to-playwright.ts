/**
 * Emit a Playwright .spec.ts from a flow — best-effort parity. Exact for
 * selector/text/label targets and clickPoint (fixed 1280x720 viewport);
 * the DOM runner's fallback heuristics (innermost match) may differ on
 * pathological pages. Reads E2E_BASE_URL at runtime.
 */
import type { Step, Target, TestFlow } from './types.js';

export const PW_VIEWPORT = { width: 1280, height: 720 };

export function toPlaywright(flow: TestFlow): string {
  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `// Generated from platform test flow "${flow.id}" — do not edit by hand.`,
    `test.use({ viewport: { width: ${PW_VIEWPORT.width}, height: ${PW_VIEWPORT.height} } });`,
    ``,
    `test(${js(flow.name)}, async ({ page }) => {`,
    `  const base = process.env.E2E_BASE_URL ?? 'http://localhost:5173';`,
    `  await page.goto(base + ${js(flow.startPath ?? '/')});`,
  ];
  for (const step of flow.steps) lines.push(...stepLines(step).map((l) => `  ${l}`));
  lines.push(`});`, ``);
  return lines.join('\n');
}

function stepLines(step: Step): string[] {
  switch (step.op) {
    case 'goto':
      return [`await page.goto(base + ${js(step.path)});`];
    case 'click':
      return [`await ${locator(step.target)}.first().click();`];
    case 'clickPoint':
      return [
        `await page.mouse.click(${Math.round((PW_VIEWPORT.width * step.xPct) / 100)}, ${Math.round((PW_VIEWPORT.height * step.yPct) / 100)});`,
      ];
    case 'fill':
      return [`await ${locator(step.target)}.first().fill(${js(step.value)});`];
    case 'press':
      return [`await page.keyboard.press(${js(step.key)});`];
    case 'expectVisible':
      return [`await expect(${locator(step.target)}.first()).toBeVisible();`];
    case 'expectText':
      return [`await expect(page.locator('body')).toContainText(${js(step.text)}, { ignoreCase: true });`];
    case 'waitFor':
      if (step.target) return [`await ${locator(step.target)}.first().waitFor();`];
      return [`await page.waitForTimeout(${step.ms ?? 0});`];
    case 'screenshot':
      return [`await page.screenshot({ path: ${js(`${step.name ?? 'step'}.png`)} });`];
  }
}

function locator(target: Target): string {
  if (target.selector) return `page.locator(${js(target.selector)})`;
  if (target.label !== undefined) return `page.getByLabel(${js(target.label)}, { exact: true })`;
  return `page.getByText(${js(target.text ?? '')})`;
}

function js(value: string): string {
  return JSON.stringify(value);
}
