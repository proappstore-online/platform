import { describe, expect, it } from 'vitest';
import { toPlaywright } from './to-playwright.js';

describe('toPlaywright', () => {
  it('emits a runnable spec with all step mappings', () => {
    const spec = toPlaywright({
      id: 'login',
      name: 'Student can sign in',
      startPath: '/',
      steps: [
        { op: 'click', target: { text: "Sign in with your teacher's login" } },
        { op: 'fill', target: { label: 'Login' }, value: 'qa-kid' },
        { op: 'press', key: 'Enter' },
        { op: 'clickPoint', xPct: 50, yPct: 50 },
        { op: 'expectVisible', target: { selector: '.board' } },
        { op: 'expectText', text: 'Home' },
        { op: 'waitFor', ms: 250 },
        { op: 'screenshot', name: 'done' },
      ],
    });
    expect(spec).toContain(`test("Student can sign in"`);
    expect(spec).toContain(`page.getByText("Sign in with your teacher's login")`);
    expect(spec).toContain(`page.getByLabel("Login", { exact: true })`);
    expect(spec).toContain(`page.keyboard.press("Enter")`);
    expect(spec).toContain(`page.mouse.click(640, 360)`);
    expect(spec).toContain(`page.locator(".board")`);
    expect(spec).toContain(`toContainText("Home"`);
    expect(spec).toContain(`waitForTimeout(250)`);
    expect(spec).toContain(`screenshot({ path: "done.png" })`);
    // no stray unescaped values
    expect(spec).not.toContain('undefined');
  });
});
