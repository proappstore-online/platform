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
      '@types/react': '^19.2.14',
      '@types/react-dom': '^19.2.3',
      '@vitejs/plugin-react': '^6.0.1',
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

  return files;
}
