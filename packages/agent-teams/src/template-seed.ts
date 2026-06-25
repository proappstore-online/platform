/**
 * Template seed files for new agent-built apps. Platform-level infrastructure
 * that every PAS app needs. Seeded into the working tree at project init.
 *
 * Mirrors pas/templates/template-app/ — keep in sync.
 * Covers every VCQA check: structure, docs, PWA, dark mode, design tokens,
 * security headers, testing setup, CI/CD, accessibility meta, and compliance.
 */

// NOTE: No CI/CD workflow is generated here. The platform OWNS CI — at deploy
// time handleAgentDeploy (admin/src/publish.ts) strips any .github/workflows/*
// from the bundle and injects the single canonical deployWorkflowYaml(). The
// workflow that used to live here was both dead (always stripped before it
// reached GitHub) AND wrong (it deployed to Cloudflare Pages — the abandoned
// Path-A model, not Path B R2). Do not re-add workflow seeding here; change the
// one source of truth in admin/src/publish.ts instead.

export function seedFiles(slug: string): Map<string, string> {
  const files = new Map<string, string>();
  const year = new Date().getFullYear();

  // ── Infrastructure ──────────────────────────────────────────

  files.set('.gitignore', [
    'node_modules/', 'dist/', '.cache/', '*.tsbuildinfo',
    '.env', '.env.local', '.env.production',
    '.vite/', '.vibe-check/', '.DS_Store',
  ].join('\n') + '\n');

  files.set('LICENSE', `MIT License\n\nCopyright (c) ${year} ${slug}\n\n` +
    'Permission is hereby granted, free of charge, to any person obtaining a copy\n' +
    'of this software and associated documentation files (the "Software"), to deal\n' +
    'in the Software without restriction, including without limitation the rights\n' +
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n' +
    'copies of the Software, and to permit persons to whom the Software is\n' +
    'furnished to do so, subject to the following conditions:\n\n' +
    'The above copyright notice and this permission notice shall be included in all\n' +
    'copies or substantial portions of the Software.\n\n' +
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n' +
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n' +
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n' +
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n' +
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n' +
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n' +
    'SOFTWARE.\n');

  // ── Docs ────────────────────────────────────────────────────

  files.set('README.md', `# ${slug}\n\nA [ProAppStore](https://proappstore.online) web app.\n\n` +
    '## Development\n\n```bash\npnpm install\npnpm dev        # start dev server\n' +
    'pnpm build      # production build\npnpm test       # run tests\n' +
    'pnpm typecheck  # type-check without emit\n```\n\n' +
    '## Deployment\n\n' +
    `Push to \`main\` → auto-deploys via GitHub Actions to \`${slug}.proappstore.online\`.\n\n` +
    '## Stack\n\n- React 19 + TypeScript + Vite + Tailwind CSS\n' +
    '- [ProAppStore SDK](https://docs.proappstore.online/) (auth, database, storage, rooms, AI)\n' +
    '- Vitest + Testing Library for tests\n');

  files.set('CLAUDE.md', `# ${slug} (Pro)\n\nA Pro app on ProAppStore.\n\n` +
    `- Subdomain: \`${slug}.proappstore.online\`\n` +
    '- Dev: `pnpm install && pnpm dev`\n' +
    '- Build: `pnpm build`\n' +
    '- Deploy: `git push origin main` (auto-deploys via Cloudflare Pages)\n\n' +
    'For platform conventions, read the AI Agent Guide:\n' +
    'https://proappstore.online/skills.md\n');

  // ── Package configs ─────────────────────────────────────────

  files.set('package.json', JSON.stringify({
    name: slug, private: true, type: 'module',
    // Pins pnpm for CI (pnpm/action-setup reads this) — without it the deploy
    // fails with "No pnpm version is specified".
    packageManager: 'pnpm@9.15.0',
    repository: { type: 'git', url: `https://github.com/proappstore-online/${slug}` },
    scripts: {
      dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview',
      test: 'vitest run', typecheck: 'tsc -b',
    },
    dependencies: {
      '@proappstore/sdk': '^1.16.0', 'react': '^19.2.5', 'react-dom': '^19.2.5',
      'lucide-react': '^0.460.0', 'date-fns': '^4.1.0',
      'react-i18next': '^15.4.0', 'i18next': '^24.2.0',
    },
    devDependencies: {
      '@tailwindcss/vite': '^4.2.4', '@testing-library/react': '^16.0.0',
      '@testing-library/jest-dom': '^6.6.0', '@types/react': '^19.2.14',
      '@types/react-dom': '^19.2.3', '@vitejs/plugin-react': '^6.0.1',
      'jsdom': '^26.0.0', 'tailwindcss': '^4.2.4', 'typescript': '~6.0.2',
      'vite': '^8.0.10', 'vite-plugin-pwa': '^0.21.1', 'vitest': '^4.1.0',
    },
  }, null, 2) + '\n');

  files.set('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
      jsx: 'react-jsx', strict: true, esModuleInterop: true, skipLibCheck: true,
      forceConsistentCasingInFileNames: true, resolveJsonModule: true,
      isolatedModules: true, noEmit: true,
    },
    include: ['src'],
  }, null, 2) + '\n');

  files.set('vite.config.ts', `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Real PWA: auto-register + auto-update a service worker (offline + installable).
    // manifest:false keeps the hand-tuned public manifest.json.
    VitePWA({ registerType: 'autoUpdate', manifest: false }),
  ],
})
`);

  files.set('vitest.config.ts', `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
`);

  files.set('tests/setup.ts', `import '@testing-library/jest-dom/vitest'
`);

  // ── HTML + PWA ──────────────────────────────────────────────

  files.set('index.html', `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="theme-color" content="#7c3aed" />
    <meta name="description" content="${slug} on ProAppStore" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${slug}" />
    <meta property="og:description" content="${slug} on ProAppStore" />
    <meta property="og:url" content="https://${slug}.proappstore.online/" />
    <meta property="og:image" content="https://${slug}.proappstore.online/og-image.svg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${slug}" />
    <meta name="twitter:description" content="${slug} on ProAppStore" />
    <meta name="twitter:image" content="https://${slug}.proappstore.online/og-image.svg" />
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon.svg" />
    <title>${slug}</title>
    <!-- Set the theme before first paint (no flash); mirrors useTheme's resolution. -->
    <script>try{var p=localStorage.getItem('stores-theme');if(p==='dark'||((!p||p==='system')&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.theme='dark';}catch(e){}</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`);

  files.set('manifest.json', JSON.stringify({
    name: slug, short_name: slug,
    description: `${slug} on ProAppStore`,
    start_url: '/', display: 'standalone', orientation: 'any',
    background_color: '#ffffff', theme_color: '#7c3aed',
    // SVG icon (the template can't ship binary PNGs); Chrome/Android render it,
    // and an app can swap in its own /icon.svg.
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  }, null, 2) + '\n');

  // A valid default icon so the PWA installs (the old /icon-192.png refs were
  // 404s). Branded purple square + the app's initial; apps can overwrite it.
  files.set('public/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="104" fill="#7c3aed"/><text x="256" y="350" font-family="system-ui, -apple-system, sans-serif" font-size="300" font-weight="800" fill="#fff" text-anchor="middle">${(slug[0] ?? 'A').toUpperCase()}</text></svg>\n`);

  files.set('public/og-image.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${slug} on ProAppStore">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#111827"/>
      <stop offset="1" stop-color="#312e81"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="80" y="80" width="1040" height="470" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
  <rect x="80" y="80" width="12" height="470" fill="#7c3aed"/>
  <text x="600" y="310" text-anchor="middle" fill="#ffffff" font-family="Inter, Manrope, Arial, sans-serif" font-size="76" font-weight="800">${slug}</text>
  <text x="600" y="390" text-anchor="middle" fill="#c4b5fd" font-family="Inter, Manrope, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="8">PROAPPSTORE</text>
</svg>
`);

  // ── Source code ─────────────────────────────────────────────

  files.set('src/main.tsx', `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`);

  files.set('src/App.tsx', `import { initPro } from '@proappstore/sdk'
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
import { Avatar, ThemeToggle, TextSizeToggle, ProProfilePage } from '@proappstore/sdk/ui'
import { useState } from 'react'

export const app = initPro({ appId: '${slug}' })

type View = 'home' | 'profile' | 'settings'

export default function App() {
  const { user, loading, signOut } = useProAuth(app)
  const { theme } = useTheme()
  const [view, setView] = useState<View>('home')

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      {/* Nav bar */}
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between">
          <button onClick={() => setView('home')} className="font-bold text-[var(--ink)] display-font">${slug}</button>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {loading ? null : user ? (
              <>
                <button onClick={() => setView('settings')} className="text-xs text-[var(--muted)] hover:text-[var(--ink)]">Settings</button>
                <button onClick={() => setView('profile')}>
                  <Avatar user={user} size={28} />
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <button onClick={() => app.auth.signIn('github')} className="btn btn-primary text-xs">
                  Sign in with GitHub
                </button>
                <button onClick={() => app.auth.signIn('google')} className="btn btn-secondary text-xs">
                  Sign in with Google
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
        {view === 'profile' && user && (
          <ProProfilePage app={app} user={user} onSignOut={signOut} onBack={() => setView('home')} />
        )}
        {view === 'settings' && (
          <div className="max-w-md space-y-6">
            <h2 className="text-xl font-bold text-[var(--ink)]">Settings</h2>
            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--ink)]">Theme</span>
                <ThemeToggle />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--ink)]">Text size</span>
                <TextSizeToggle />
              </div>
            </div>
            <button onClick={() => setView('home')} className="text-sm text-[var(--accent)] hover:underline">&larr; Back</button>
          </div>
        )}
        {view === 'home' && (
          <div className="space-y-4">
            <h1 className="text-2xl font-bold text-[var(--ink)]">${slug}</h1>
            <p className="text-[var(--muted)]">Your app is ready. Start building!</p>
          </div>
        )}
      </main>
    </div>
  )
}
`);

  // Design tokens + dark mode + common components (matches the platform design system)
  files.set('src/index.css', `@import 'tailwindcss';

/* ── ProAppStore design tokens ────────────────────────────────────
   Override these in the Style tab (console) or directly here.
   The Dev agent should use var(--token), never hardcoded colors. */
:root {
  --paper: #ffffff;
  --paper-deep: #f7f7f7;
  --ink: #1a1a2e;
  --ink-strong: #0f0f1a;
  --muted: #6b7280;
  --accent: #7c3aed;
  --accent-hover: #6d28d9;
  --accent-soft: rgba(124, 58, 237, 0.08);
  --line: #e5e7eb;
  --line-strong: #d1d5db;
  --panel: rgba(255, 255, 255, 0.72);
  --panel-hover: rgba(0, 0, 0, 0.03);
  --error: #dc2626;
  --success: #16a34a;
  --warning: #ca8a04;
  --shadow: 0 1px 3px rgba(0,0,0,0.06);
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.08);
  --radius: 12px;
  --radius-sm: 8px;
  color-scheme: light dark;
}

/* Dark theme: useTheme sets html[data-theme="dark"] (and resolves "system" in JS,
   updating on OS change). NOT mixed with @media — combining a selector with an
   at-rule is invalid CSS and made the toggle a no-op (theme just followed the OS). */
[data-theme="dark"] {
  --paper: #0a0a0a;
  --paper-deep: #050505;
  --ink: #e5e7eb;
  --ink-strong: #f9fafb;
  --muted: #9ca3af;
  --accent: #a78bfa;
  --accent-hover: #8b5cf6;
  --accent-soft: rgba(167, 139, 250, 0.1);
  --line: #2a2a3e;
  --line-strong: #3a3a52;
  --panel: rgba(20, 20, 35, 0.72);
  --panel-hover: rgba(255, 255, 255, 0.04);
  --shadow: 0 1px 3px rgba(0,0,0,0.3);
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
}

/* Text size (set by useTheme hook) */
html[data-text="sm"] { font-size: 14px; }
html[data-text="lg"] { font-size: 18px; }
html[data-text="xl"] { font-size: 20px; }

body {
  background: var(--paper);
  color: var(--ink);
  font-family: 'Manrope', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ── Utility classes ──────────────────────────────────────────── */
.display-font { font-family: 'Fraunces', serif; }
.text-muted { color: var(--muted); }

/* Card component */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.25rem;
  box-shadow: var(--shadow);
}
.card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-lg); }

/* Button variants */
.btn {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 1rem; border-radius: var(--radius-sm);
  font-size: 0.875rem; font-weight: 600; transition: all 0.15s;
  cursor: pointer; border: none;
}
.btn-primary { background: var(--accent); color: white; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-secondary { background: var(--panel); color: var(--ink); border: 1px solid var(--line); }
.btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
.btn-ghost { background: transparent; color: var(--muted); }
.btn-ghost:hover { color: var(--ink); background: var(--panel-hover); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Input */
.input {
  width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong); background: var(--paper);
  color: var(--ink); font-size: 0.875rem;
}
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }

/* Badge */
.badge {
  display: inline-flex; align-items: center; padding: 0.125rem 0.5rem;
  border-radius: 999px; font-size: 0.75rem; font-weight: 600;
}
.badge-accent { background: var(--accent-soft); color: var(--accent); }
.badge-success { background: rgba(22,163,106,0.1); color: var(--success); }
.badge-error { background: rgba(220,38,38,0.1); color: var(--error); }

/* Empty state */
.empty-state {
  text-align: center; padding: 3rem 1rem; color: var(--muted);
}
.empty-state h3 { color: var(--ink); font-weight: 700; margin-bottom: 0.5rem; }
`);

  // ── MCP scaffold ────────────────────────────────────────────

  files.set('mcp.json', JSON.stringify({ tools: [] }, null, 2) + '\n');

  // ── CI/CD ───────────────────────────────────────────────────
  // Intentionally none — the platform injects the canonical deploy workflow at
  // deploy time (see the note at the top of this file). Seeding workflow files
  // here is dead code: handleAgentDeploy strips every .github/workflows/* from
  // the bundle before it reaches GitHub.

  return files;
}
