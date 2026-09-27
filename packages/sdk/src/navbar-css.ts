/**
 * NavBar styles (#235) — the single source for both delivery paths:
 * NavBar injects this into <head> at render (so an app needs no configuration),
 * and the build writes it to dist/shell.css (`@proappstore/sdk/shell.css`) for
 * apps that prefer to import it.
 *
 * Built on the canonical tokens only (PAS-UI-001), so it follows the app's
 * light/dark theme. The Tailwind classes on NavBar's elements mirror these
 * rules; Tailwind v4 emits utilities inside a cascade layer, so these unlayered
 * rules win wherever the two meet and they cannot disagree.
 */
export const NAVBAR_CSS = `.pas-nav{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0;margin:0 .5rem}
.pas-nav__toggle{display:none;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:inherit;cursor:pointer}
.pas-nav__list{display:flex;align-items:center;gap:.25rem;margin:0;padding:0;list-style:none;overflow-x:auto}
.pas-nav__link{display:inline-flex;align-items:center;gap:.4rem;min-height:44px;padding:0 .75rem;border-radius:10px;color:var(--muted);font-size:.9rem;font-weight:600;text-decoration:none;white-space:nowrap}
.pas-nav__link:hover{color:var(--ink);background:var(--line)}
.pas-nav__link[aria-current="page"]{color:var(--accent);background:var(--line)}
.pas-nav__toggle:focus-visible,.pas-nav__link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:639px){.pas-nav{flex:0 0 auto;margin:0}.pas-nav__toggle{display:inline-flex}.pas-nav__list{display:none;position:absolute;top:calc(100% + .5rem);left:0;z-index:60;flex-direction:column;align-items:stretch;min-width:12rem;padding:.5rem;overflow:visible;background:var(--paper);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12)}.pas-nav[data-open="true"] .pas-nav__list{display:flex}}
`;
