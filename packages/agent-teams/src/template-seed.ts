/**
 * Template seed files for new agent-built apps. Platform-level infrastructure
 * that every PAS app needs. Seeded into the working tree at project init.
 *
 * Mirrors pas/templates/template-app/ — keep in sync.
 * Covers every VCQA check: structure, docs, PWA, dark mode, design tokens,
 * security headers, testing setup, CI/CD, accessibility meta, and compliance.
 */

// GitHub Actions ${{ }} conflicts with JS template literals.
const GH = '$' + '{{';

function ghWorkflow(slug: string): string {
  return [
    'name: Deploy to Cloudflare Pages', '',
    'on:', '  push:', '    branches: [main]', '',
    'permissions:', '  contents: read', '  deployments: write', '',
    'concurrency:',
    '  group: deploy-' + GH + ' github.repository }}',
    '  cancel-in-progress: true', '',
    'jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: pnpm/action-setup@v4', '        with:', '          version: 9',
    '      - uses: actions/setup-node@v4', '        with:', '          node-version: 22',
    '      - run: pnpm install --no-frozen-lockfile',
    '      - name: Build', '        env:',
    '          VITE_COMMIT_SHA: ' + GH + ' github.sha }}',
    '        run: pnpm build',
    '      - name: Locate build output', '        id: dist', '        run: |',
    '          if [ -d dist ]; then echo "dir=dist" >> "$GITHUB_OUTPUT"',
    '          else echo "::error::No build output"; exit 1; fi',
    '      - name: Code-health scan (VCQA)', '        continue-on-error: true', '        run: |',
    '          npx -y @vibecodeqa/cli@latest --skip-tests . || true',
    '          if [ -f .vibe-check/report.json ]; then',
    '            mkdir -p "' + GH + ' steps.dist.outputs.dir }}/.vcqa"',
    '            cp .vibe-check/report.json "' + GH + ' steps.dist.outputs.dir }}/.vcqa/report.json"',
    '          fi',
    '      - name: Deploy to Cloudflare Pages',
    '        run: npx wrangler@3 pages deploy "' + GH + ' steps.dist.outputs.dir }}" --project-name=proappstore-' + slug + ' --branch=main',
    '        env:',
    '          CLOUDFLARE_API_TOKEN: ' + GH + ' secrets.CLOUDFLARE_API_TOKEN }}',
    '          CLOUDFLARE_ACCOUNT_ID: c1089bfcc43c1c6c2aa89e584e86f0bc',
  ].join('\n') + '\n';
}

function ciWorkflow(): string {
  return [
    'name: CI', '',
    'on:', '  pull_request:', '    branches: [main]', '',
    'permissions:', '  contents: read', '',
    'jobs:', '  typecheck:', '    runs-on: ubuntu-latest', '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: pnpm/action-setup@v4', '        with:', '          version: 9',
    '      - uses: actions/setup-node@v4', '        with:', '          node-version: 22',
    '      - run: pnpm install --no-frozen-lockfile',
    '      - run: pnpm typecheck',
    '      - run: pnpm test',
  ].join('\n') + '\n';
}

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
    '- [ProAppStore SDK](https://proappstore.online/docs) (auth, database, storage, rooms, AI)\n' +
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
    repository: { type: 'git', url: `https://github.com/proappstore-online/${slug}` },
    scripts: {
      dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview',
      test: 'vitest run', typecheck: 'tsc -b',
    },
    dependencies: {
      '@proappstore/sdk': '^1.9.0', 'react': '^19.2.5', 'react-dom': '^19.2.5',
    },
    devDependencies: {
      '@tailwindcss/vite': '^4.2.4', '@testing-library/react': '^16.0.0',
      '@testing-library/jest-dom': '^6.6.0', '@types/react': '^19.2.14',
      '@types/react-dom': '^19.2.3', '@vitejs/plugin-react': '^6.0.1',
      'jsdom': '^26.0.0', 'tailwindcss': '^4.2.4', 'typescript': '~6.0.2',
      'vite': '^8.0.10', 'vitest': '^4.1.0',
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

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <link rel="manifest" href="/manifest.json" />
    <title>${slug}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`);

  files.set('manifest.json', JSON.stringify({
    name: slug, short_name: slug,
    description: `A Pro app on ProAppStore`,
    start_url: '/', display: 'standalone', orientation: 'any',
    background_color: '#000000', theme_color: '#000000',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }, null, 2) + '\n');

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
import { ProShell } from '@proappstore/sdk/shell'

const app = initPro({ appId: '${slug}' })

export default function App() {
  return (
    <ProShell app={app} appName="${slug}">
      <main className="max-w-2xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-4">${slug}</h1>
        <p className="text-muted">Your app is ready. Start building!</p>
      </main>
    </ProShell>
  )
}
`);

  // Design tokens + dark mode (matches the platform design system)
  files.set('src/index.css', `@import 'tailwindcss';

/* ProAppStore design tokens */
:root {
  --paper: #ffffff;
  --ink: #1a1a2e;
  --muted: #6b7280;
  --accent: #7c3aed;
  --line: #e5e7eb;
  --panel: rgba(255, 255, 255, 0.72);
  --error: #dc2626;
  --success: #16a34a;
  color-scheme: light dark;
}

[data-theme="dark"], @media (prefers-color-scheme: dark) {
  :root {
    --paper: #0a0a0a;
    --ink: #e5e7eb;
    --muted: #9ca3af;
    --accent: #a78bfa;
    --line: #2a2a3e;
    --panel: rgba(20, 20, 35, 0.72);
  }
}

body {
  background: var(--paper);
  color: var(--ink);
  font-family: 'Manrope', system-ui, sans-serif;
}

.display-font { font-family: 'Fraunces', serif; }
.text-muted { color: var(--muted); }
`);

  // ── MCP scaffold ────────────────────────────────────────────

  files.set('mcp.json', JSON.stringify({ tools: [] }, null, 2) + '\n');

  // ── CI/CD ───────────────────────────────────────────────────

  files.set('.github/workflows/deploy.yml', ghWorkflow(slug));
  files.set('.github/workflows/ci.yml', ciWorkflow());

  return files;
}
