import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  handleInstallHandoff,
  INSTALL_SCRIPT,
  INSTALL_SCRIPT_PATH,
  INSTALL_SCRIPT_TAG,
  wantsInstallHandoff,
} from "./install-handoff.js";

// #628 part A: the companion's "Open {app}" lands on `?install=1`, and the page
// offers Chrome's deferred install prompt. The HTML injection and the private-app
// gate run in workerd (runtime-tests/test/host/install-handoff.test.ts), since
// HTMLRewriter does not exist in Node.

const ORIGIN = "https://run.proappstore.online";

describe("/.pas/install.js (#628)", () => {
  it("serves the static script as text/javascript, cacheable for an hour", async () => {
    const res = handleInstallHandoff(new Request(`${ORIGIN}${INSTALL_SCRIPT_PATH}`))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await res.text()).toBe(INSTALL_SCRIPT);
  });

  it("answers HEAD without a body, refuses other methods, and ignores other paths", async () => {
    const head = handleInstallHandoff(
      new Request(`${ORIGIN}${INSTALL_SCRIPT_PATH}`, { method: "HEAD" }),
    )!;
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(await head.text()).toBe("");
    expect(
      handleInstallHandoff(
        new Request(`${ORIGIN}${INSTALL_SCRIPT_PATH}`, { method: "POST", body: "x" }),
      )!.status,
    ).toBe(405);
    expect(handleInstallHandoff(new Request(`${ORIGIN}/.pas/install.json`))).toBeNull();
    expect(handleInstallHandoff(new Request(`${ORIGIN}/install.js`))).toBeNull();
  });

  it("is asked for by exactly install=1", () => {
    expect(wantsInstallHandoff(new URL(`${ORIGIN}/?install=1`))).toBe(true);
    expect(wantsInstallHandoff(new URL(`${ORIGIN}/trip?a=b&install=1`))).toBe(true);
    for (const q of ["", "?install", "?install=true", "?install=0", "?Install=1"])
      expect(wantsInstallHandoff(new URL(`${ORIGIN}/${q}`))).toBe(false);
  });

  it("injects a same-origin deferred tag", () => {
    expect(INSTALL_SCRIPT_TAG).toBe('<script src="/.pas/install.js" defer></script>');
  });
});

/** Runs the script against a minimal browser stand-in and returns its handles. */
function page(
  opts: { href?: string; standalone?: boolean; promptApi?: boolean; manifest?: unknown } = {},
) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const buttons: Record<string, { textContent: string; click: () => void }> = {};
  const hosts: { removed: boolean }[] = [];
  const replaceState = vi.fn();
  const fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith("/manifest.webmanifest") ? (opts.manifest ?? {}) : {}),
  }));
  const window: Record<string, unknown> = {
    location: { href: opts.href ?? `${ORIGIN}/?install=1`, origin: ORIGIN },
    history: { state: { s: 1 }, replaceState },
    matchMedia: () => ({ matches: Boolean(opts.standalone) }),
    navigator: {},
    URL,
    Promise,
    fetch,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    document: {
      querySelector: (selector: string) =>
        selector === 'link[rel="manifest"]' && opts.manifest
          ? { href: `${ORIGIN}/manifest.webmanifest` }
          : null,
      createElement: () => {
        const host = {
          removed: false,
          remove() {
            host.removed = true;
          },
          attachShadow: () => ({
            set innerHTML(_html: string) {},
            querySelector: (selector: string) => {
              const key = selector.slice(1);
              if (!buttons[key]) {
                let click = () => {};
                buttons[key] = {
                  textContent: "",
                  click: () => click(),
                  addEventListener: (_type: string, fn: () => void) => {
                    click = fn;
                  },
                } as unknown as (typeof buttons)[string];
              }
              return buttons[key];
            },
          }),
        };
        hosts.push(host);
        return host;
      },
      body: { appendChild: vi.fn() },
    },
  };
  if (opts.promptApi !== false) window.onbeforeinstallprompt = null;
  window.window = window;
  runInNewContext(INSTALL_SCRIPT, window);
  return { listeners, buttons, hosts, replaceState, fetch };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("install.js behaviour (#628)", () => {
  it("removes install=1 from the address, keeping the rest of the URL and the history state", () => {
    const { replaceState } = page({ href: `${ORIGIN}/trip?a=b&install=1#map` });
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, "", `${ORIGIN}/trip?a=b#map`);
  });

  it("shows Install <short_name>; Install prompts once and the bar goes whatever the choice", async () => {
    const { listeners, buttons, hosts } = page({
      manifest: { short_name: "Run", name: "Run tracker" },
    });
    const prompt = vi.fn();
    const preventDefault = vi.fn();
    listeners.beforeinstallprompt!({
      preventDefault,
      prompt,
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    await flush();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(buttons.install!.textContent).toBe("Install Run");
    buttons.install!.click();
    expect(prompt).toHaveBeenCalledOnce();
    await flush();
    expect(hosts[0]!.removed).toBe(true);
  });

  it("falls back to Install app without a manifest; Not now removes the bar without prompting", async () => {
    const { listeners, buttons, hosts, fetch } = page();
    const prompt = vi.fn();
    listeners.beforeinstallprompt!({
      preventDefault: () => {},
      prompt,
      userChoice: Promise.resolve({}),
    });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(buttons.install!.textContent).toBe("Install app");
    buttons.later!.click();
    expect(hosts[0]!.removed).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does nothing when already installed or without the prompt API (Safari, Firefox), and never times out into a bar", () => {
    const installed = page({ standalone: true });
    expect(installed.listeners.beforeinstallprompt).toBeUndefined();
    expect(installed.replaceState).toHaveBeenCalled();
    const safari = page({ promptApi: false });
    expect(safari.listeners.beforeinstallprompt).toBeUndefined();
    expect(safari.replaceState).toHaveBeenCalled();
    expect(safari.hosts).toHaveLength(0);
  });

  it("removes the bar when the app is installed some other way", async () => {
    const { listeners, hosts } = page();
    listeners.beforeinstallprompt!({
      preventDefault: () => {},
      prompt: () => {},
      userChoice: Promise.resolve({}),
    });
    await flush();
    listeners.appinstalled!({});
    expect(hosts[0]!.removed).toBe(true);
  });
});
