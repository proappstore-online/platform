import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface CreateOptions {
  skipInstall?: boolean;
  skipGit?: boolean;
  skipProvision?: boolean;
  token?: string;
}

const PAS_API = 'https://api.proappstore.online';

const TEMPLATE_FILES: Record<string, string> = {
  'package.json': `{
  "name": "__APP_ID__",
  "private": true,
  "packageManager": "pnpm@10.30.3",
  "engines": { "node": ">=22" },
  "repository": { "type": "git", "url": "git+https://github.com/proappstore-online/__APP_ID__.git" },
  "scripts": {
    "dev": "pnpm --filter @__APP_ID__/web dev",
    "build": "pnpm --filter @__APP_ID__/web build",
    "preview": "pnpm --filter @__APP_ID__/web preview",
    "typecheck": "pnpm --filter @__APP_ID__/web exec tsc -b",
    "test": "pnpm --filter @__APP_ID__/web exec tsc -b"
  }
}`,
  'pnpm-workspace.yaml': `packages:\n  - web`,
  'tsconfig.json': `{ "references": [{ "path": "./web" }], "files": [] }`,
  'LICENSE': `MIT License\n\nCopyright (c) ${new Date().getFullYear()} ProAppStore\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`,
  'CLAUDE.md': `# __APP_ID__\n\n__APP_DESCRIPTION__\n\n- Subdomain: \`__APP_ID__.proappstore.online\`\n- Dev: \`pnpm install && pnpm dev\`\n- Build: \`pnpm build\`\n- Deploy: \`git push origin main\` (auto-deploys via Cloudflare Pages)\n\nFor platform conventions, read\nhttps://proappstore.online/skills.md\nbefore writing or changing anything.`,
  '.gitignore': `node_modules/\ndist/\n.DS_Store\n*.log\n.env\n.env.local`,
  'web/package.json': `{
  "name": "@__APP_ID__/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@proappstore/sdk": "^1.5.0",
    "react": "^19.2.5",
    "react-dom": "^19.2.5"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.2.4",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.1",
    "tailwindcss": "^4.2.4",
    "typescript": "~6.0.2",
    "vite": "^8.0.10"
  }
}`,
  'web/tsconfig.json': `{\n  "files": [],\n  "references": [\n    { "path": "./tsconfig.app.json" },\n    { "path": "./tsconfig.node.json" }\n  ]\n}`,
  'web/tsconfig.app.json': `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "types": ["vite/client"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}`,
  'web/tsconfig.node.json': `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023"],
    "module": "esnext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}`,
  'web/vite.config.ts': `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nimport tailwindcss from '@tailwindcss/vite'\n\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n  server: { host: true },\n})`,
  'web/index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />\n    <meta name="theme-color" content="#7c3aed" />\n    <link rel="preconnect" href="https://fonts.googleapis.com" />\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />\n    <title>__APP_NAME__ — ProAppStore</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>`,
  'web/src/main.tsx': `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport './index.css'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)`,
  'web/src/index.css': `@import "tailwindcss";\n\n@layer base {\n:root {\n  color-scheme: light;\n  --paper: #ffffff;\n  --ink: #111111;\n  --muted: #666666;\n  --accent: #7c3aed;\n  --accent-soft: #f5f3ff;\n  --line: rgba(0,0,0,0.08);\n  --glass: rgba(255,255,255,0.72);\n  --glass-hover: rgba(255,255,255,0.85);\n  --error: #c74f43;\n  --success: #2f8f57;\n}\n\n:root[data-theme='dark'] {\n  color-scheme: dark;\n  --paper: #000000;\n  --ink: #f0f0f0;\n  --muted: #888888;\n  --accent: #a78bfa;\n  --accent-soft: #1e1533;\n  --line: rgba(255,255,255,0.08);\n  --glass: rgba(26,26,26,0.8);\n  --glass-hover: rgba(38,38,38,0.9);\n  --error: #ff7a72;\n  --success: #74d49a;\n}\n\nhtml { min-height: 100%; }\nbody {\n  min-height: 100dvh;\n  background: var(--paper);\n  color: var(--ink);\n  font-family: 'Manrope', -apple-system, sans-serif;\n  -webkit-font-smoothing: antialiased;\n}\n#root { min-height: 100dvh; }\n.display-font { font-family: 'Fraunces', Georgia, serif; letter-spacing: -0.04em; }\n} /* end @layer base */`,
  'web/src/App.tsx': `import { initPro } from '@proappstore/sdk'\nimport { useProGate } from '@proappstore/sdk/hooks'\n\nconst app = initPro({ appId: '__APP_ID__' })\n\nexport default function App() {\n  const { gate, user, signIn, upgrade } = useProGate(app, { allowFree: true })\n\n  if (gate === 'loading') {\n    return (\n      <div className="flex min-h-[100dvh] items-center justify-center">\n        <p className="text-[var(--muted)]">Loading...</p>\n      </div>\n    )\n  }\n\n  if (gate === 'signed-out') {\n    return (\n      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-4">\n        <h1 className="display-font text-3xl font-bold text-[var(--ink)]">__APP_NAME__</h1>\n        <p className="text-[var(--muted)]">Sign in to get started.</p>\n        <button onClick={signIn} className="rounded-2xl bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-white">Sign in with GitHub</button>\n      </div>\n    )\n  }\n\n  return (\n    <div className="mx-auto max-w-2xl px-4 py-8">\n      <h1 className="display-font text-2xl font-bold text-[var(--ink)]">__APP_NAME__</h1>\n      <p className="mt-2 text-[var(--muted)]">Welcome, {user?.login}! Edit web/src/App.tsx to start building.</p>\n    </div>\n  )\n}`,
  // Pre-committed privacy template — served by CF Pages at
  // <app>.proappstore.online/privacy.md. The Console's "Use privacy.md from
  // my app" affordance points to that URL. Fill in {{APP_NAME}}/{{DATE}}/
  // {{CONTACT}} (or just delete this file and point Console at the platform
  // policy if your app doesn't add anything app-specific).
  'web/public/privacy.md': `# Privacy Policy — __APP_NAME__\n\n_Last updated: {{DATE}}_\n\nThis is the privacy policy for **__APP_NAME__**, a Pro app on\n[ProAppStore](https://proappstore.online). It covers what _this app_ does\nwith your data. For platform-wide data handling (sign-in, billing, file\nstorage, usage analytics for creator payouts, account deletion) see the\n[platform privacy policy](https://proappstore.online/privacy).\n\n---\n\n## What __APP_NAME__ stores about you\n\n> _Fill in what your app keeps. Examples below — delete the ones that don't\n> apply, add app-specific ones._\n\n- The data you explicitly enter into the app. Stored in your private\n  per-user KV / database / file storage. No one else has access except you.\n\n## What __APP_NAME__ does NOT store\n\n- No contacts scraping, no background location, no microphone access, no\n  behavioral analytics, no advertising IDs.\n\n## Where data lives\n\nEverything you save in __APP_NAME__ is stored on Cloudflare infrastructure\n(D1, R2, KV) under your ProAppStore account. The app developer does not\nhave access to your personal data — only daily aggregate counts (active\nusers, session-minutes, API calls) used to size their payout share.\n\n## Third-party services\n\n> _List any third-party APIs your app calls on the user's behalf. Delete\n> this section if there are none._\n\n## Cookies\n\n__APP_NAME__ uses the same session cookie as the rest of ProAppStore for\nauthentication. No tracking, advertising, or analytics cookies.\n\n## Data deletion\n\nDelete your account from [dashboard.proappstore.online](https://dashboard.proappstore.online).\nThat removes all data __APP_NAME__ stored for you, alongside the\nplatform-level deletion described in the [platform privacy policy](https://proappstore.online/privacy#data-deletion).\n\n## Contact\n\n{{CONTACT}}\n`,
};

function toTitleCase(id: string): string {
  return id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export async function createApp(appId: string, opts: CreateOptions = {}): Promise<void> {
  // Validate app ID
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    process.stderr.write(`Invalid app ID "${appId}". Use lowercase letters, numbers, hyphens. Max 58 chars.\n`);
    process.exit(1);
  }

  const targetDir = resolve(appId);
  if (existsSync(targetDir)) {
    process.stderr.write(`Directory "${appId}" already exists.\n`);
    process.exit(1);
  }

  const appName = toTitleCase(appId);
  process.stdout.write(`\n  Creating ${appName}...\n\n`);

  // Step 1: Scaffold
  process.stdout.write(`  [1/3] Scaffolding from template...\n`);
  for (const [path, content] of Object.entries(TEMPLATE_FILES)) {
    const fullPath = join(targetDir, path);
    const dir = join(fullPath, '..');
    mkdirSync(dir, { recursive: true });
    const processed = content
      .replace(/__APP_ID__/g, appId)
      .replace(/__APP_NAME__/g, appName)
      .replace(/__APP_DESCRIPTION__/g, `A pro app on ProAppStore.`);
    writeFileSync(fullPath, processed);
  }

  // Step 2: Install
  if (!opts.skipInstall) {
    process.stdout.write(`  [2/3] Installing dependencies...\n`);
    try {
      execSync('pnpm install', { cwd: targetDir, stdio: 'pipe' });
    } catch {
      process.stdout.write(`  [2/3] pnpm install failed. Run it manually.\n`);
    }
  } else {
    process.stdout.write(`  [2/3] Skipping install (--skip-install)\n`);
  }

  // Step 3: Init git
  if (!opts.skipGit) {
    process.stdout.write(`  [3/3] Initializing git...\n`);
    try {
      execSync('git init && git add -A && git commit -m "Initial scaffold from pas create"', {
        cwd: targetDir,
        stdio: 'pipe',
      });
    } catch {
      process.stdout.write(`  [3/3] Git init failed. Run it manually.\n`);
    }
  } else {
    process.stdout.write(`  [3/3] Skipping git init (--skip-git)\n`);
  }

  // Step 4: Provision platform resources (D1 + Data Worker)
  if (!opts.skipProvision) {
    const token = opts.token || process.env.FAS_SESSION_TOKEN;
    if (token) {
      process.stdout.write(`  [4/4] Provisioning platform resources...\n`);
      try {
        const res = await fetch(`${PAS_API}/v1/provision`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId,
            name: appName,
            description: `${appName} — pro app on ProAppStore.`,
          }),
        });
        const data = (await res.json()) as { appId: string; steps: { name: string; status: string; detail: string }[] };
        for (const step of data.steps) {
          const icon = step.status === 'ok' ? '+' : step.status === 'skip' ? '-' : '!';
          process.stdout.write(`    [${icon}] ${step.name}: ${step.detail}\n`);
        }

        // Write the Data Worker URL into the app's config
        const dbStep = data.steps.find(s => s.name === 'create_d1' && s.status === 'ok');
        if (dbStep) {
          const configPath = join(targetDir, '.pas.json');
          writeFileSync(configPath, JSON.stringify({
            appId,
            dataApiBase: `https://pas-data-${appId}.serge-the-dev.workers.dev`,
            d1DatabaseId: dbStep.detail.match(/\(([^)]+)\)/)?.[1] || '',
          }, null, 2));
          process.stdout.write(`    Config written to .pas.json\n`);
        }
      } catch (e) {
        process.stdout.write(`    Provisioning failed: ${e}. You can provision later.\n`);
      }
    } else {
      process.stdout.write(`  [4/4] Skipping provision (no auth token). Set FAS_SESSION_TOKEN or use --token.\n`);
    }
  } else {
    process.stdout.write(`  [4/4] Skipping provision (--skip-provision)\n`);
  }

  process.stdout.write(`
  Done! Your app is ready.

  Next steps:
    cd ${appId}
    pnpm dev

  SDK docs:  https://proappstore.online/skills.md
  Console:   https://console.proappstore.online
  Dashboard: https://dashboard.proappstore.online

`);
}
