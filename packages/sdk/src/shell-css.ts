/**
 * ProShell's resilience and feedback layer styles (#236): skip link, offline
 * banner, toast region, error and loading fallbacks, PageHeader. Same model as
 * navbar-css.ts: canonical tokens only (PAS-UI-001), injected by ProShell at
 * render so an app needs no configuration, and appended to dist/shell.css.
 */
export const SHELL_CSS = `.pas-skip-link:not(:focus){position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.pas-skip-link:focus{position:fixed;top:.5rem;left:.5rem;z-index:1200;padding:.7rem 1rem;border:2px solid var(--accent);border-radius:10px;background:var(--paper);color:var(--ink);font-weight:600;text-decoration:none;outline:2px solid var(--accent);outline-offset:2px}
.pas-main:focus{outline:none}
.pas-offline{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.25rem .5rem .25rem 1rem;background:var(--panel);color:var(--ink);border-bottom:1px solid var(--line);border-left:3px solid var(--warning);font-size:.875rem}
.pas-toast-region{position:fixed;bottom:1.25rem;left:50%;z-index:1100;display:flex;flex-direction:column;align-items:center;gap:.5rem;max-width:calc(100vw - 2rem);transform:translateX(-50%);pointer-events:none}
.pas-toast{display:flex;align-items:center;gap:.75rem;padding:.25rem .25rem .25rem 1rem;background:var(--ink);color:var(--paper);border-left:3px solid var(--accent);border-radius:var(--radius,.75rem);box-shadow:0 8px 24px rgba(0,0,0,.3);font-size:.875rem;pointer-events:auto}
.pas-toast[data-variant="success"]{border-left-color:var(--success)}
.pas-toast[data-variant="error"]{border-left-color:var(--danger)}
.pas-dismiss{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:1.1rem;line-height:1;cursor:pointer;opacity:.75}
.pas-dismiss:hover{opacity:1}
.pas-shell-loading{display:flex;flex:1;align-items:center;justify-content:center;padding:3rem 1rem}
.pas-shell-error{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;padding:3rem 1rem;text-align:center;color:var(--ink)}
.pas-shell-error h1{margin:0;font-size:1.25rem}
.pas-shell-error p{margin:0;max-width:32rem;color:var(--muted);font-size:.9rem}
.pas-shell-error__retry{min-height:44px;padding:0 1.25rem;border:0;border-radius:10px;background:var(--accent);color:var(--paper);font:inherit;font-weight:600;cursor:pointer}
.pas-page-header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:.75rem;margin:0 0 1.25rem}
.pas-page-header__title{margin:0;color:var(--ink);font-size:1.5rem;font-weight:700;line-height:1.2}
.pas-page-header__title:focus{outline:none}
.pas-page-header__description{margin:.25rem 0 0;color:var(--muted);font-size:.9rem}
.pas-dismiss:focus-visible,.pas-shell-error__retry:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;
