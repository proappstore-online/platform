/**
 * Template seed files for new agent-built apps. These are the platform-level
 * infrastructure files that every PAS app needs but agents shouldn't create
 * from scratch. Seeded into the working tree at project init.
 *
 * Matches the template at pas/templates/template-app/ — keep in sync.
 * APPNAME placeholders are replaced with the actual app slug at seed time.
 */

export function seedFiles(slug: string): Map<string, string> {
  const files = new Map<string, string>();
  const year = new Date().getFullYear();

  files.set('.gitignore', `node_modules/
dist/
.cache/
*.tsbuildinfo
.env
.env.local
.env.production
.vite/
.vibe-check/
`);

  files.set('LICENSE', `MIT License

Copyright (c) ${year} ${slug}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);

  files.set('package.json', JSON.stringify({
    name: slug,
    private: true,
    type: 'module',
    repository: { type: 'git', url: `https://github.com/proappstore-online/${slug}` },
    scripts: {
      dev: 'vite',
      build: 'tsc -b && vite build',
      preview: 'vite preview',
      test: 'vitest run',
      typecheck: 'tsc -b',
    },
    dependencies: {
      '@proappstore/sdk': '^1.9.0',
      'react': '^19.2.5',
      'react-dom': '^19.2.5',
    },
    devDependencies: {
      '@tailwindcss/vite': '^4.2.4',
      '@testing-library/react': '^16.0.0',
      '@testing-library/jest-dom': '^6.6.0',
      '@types/react': '^19.2.14',
      '@types/react-dom': '^19.2.3',
      '@vitejs/plugin-react': '^6.0.1',
      'jsdom': '^26.0.0',
      'tailwindcss': '^4.2.4',
      'typescript': '~6.0.2',
      'vite': '^8.0.10',
      'vitest': '^4.1.0',
    },
  }, null, 2) + '\n');

  files.set('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
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

  files.set('index.html', `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${slug}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`);

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
        <p className="text-gray-600">Your app is ready. Start building!</p>
      </main>
    </ProShell>
  )
}
`);

  files.set('src/index.css', `@import 'tailwindcss';
`);

  files.set('vitest.config.ts', `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
`);

  files.set('README.md', `# ${slug}

A [ProAppStore](https://proappstore.online) web app.

## Development

\`\`\`bash
pnpm install
pnpm dev        # start dev server
pnpm build      # production build
pnpm test       # run tests
pnpm typecheck  # type-check without emit
\`\`\`

## Deployment

Push to \`main\` → auto-deploys via GitHub Actions to \`${slug}.proappstore.online\`.

## Stack

- React 19 + TypeScript + Vite + Tailwind CSS
- [ProAppStore SDK](https://proappstore.online/docs) (auth, database, storage, rooms, AI)
- Vitest for unit/integration tests
`);

  // Deploy workflow — uses string concatenation to avoid template literal
  // conflicts with GitHub Actions ${{ }} expressions.
  const GH = '$' + '{{';  // workaround for template literal parsing
  files.set('.github/workflows/deploy.yml',
    'name: Deploy to Cloudflare Pages\n\n' +
    'on:\n  push:\n    branches: [main]\n\n' +
    'permissions:\n  contents: read\n  deployments: write\n\n' +
    'concurrency:\n  group: deploy-' + GH + ' github.repository }}\n  cancel-in-progress: true\n\n' +
    'jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n' +
    '      - uses: actions/checkout@v4\n' +
    '      - uses: pnpm/action-setup@v4\n        with:\n          version: 9\n' +
    '      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n' +
    '      - run: pnpm install --no-frozen-lockfile\n' +
    '      - name: Build\n        env:\n          VITE_COMMIT_SHA: ' + GH + ' github.sha }}\n        run: pnpm build\n' +
    '      - name: Locate build output\n        id: dist\n        run: |\n' +
    '          if [ -d dist ]; then echo "dir=dist" >> "$GITHUB_OUTPUT"\n' +
    '          else echo "::error::No build output"; exit 1; fi\n' +
    '      - name: Code-health scan\n        continue-on-error: true\n        run: |\n' +
    '          npx -y @vibecodeqa/cli@latest --skip-tests . || true\n' +
    '          if [ -f .vibe-check/report.json ]; then\n' +
    '            mkdir -p "' + GH + ' steps.dist.outputs.dir }}/.vcqa"\n' +
    '            cp .vibe-check/report.json "' + GH + ' steps.dist.outputs.dir }}/.vcqa/report.json"\n' +
    '          fi\n' +
    '      - name: Deploy to Cloudflare Pages\n' +
    '        run: npx wrangler@3 pages deploy "' + GH + ' steps.dist.outputs.dir }}" --project-name=proappstore-' + slug + ' --branch=main\n' +
    '        env:\n          CLOUDFLARE_API_TOKEN: ' + GH + ' secrets.CLOUDFLARE_API_TOKEN }}\n' +
    '          CLOUDFLARE_ACCOUNT_ID: c1089bfcc43c1c6c2aa89e584e86f0bc\n'
  );

  return files;
}
