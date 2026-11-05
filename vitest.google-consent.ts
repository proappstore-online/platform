import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['packages/backend/test/**/*.browser.ts'], environment: 'node', testTimeout: 45_000, hookTimeout: 45_000,
  maxWorkers: 1, minWorkers: 1,
  alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-virtual-stub.ts', import.meta.url)), 'cloudflare:workflows': fileURLToPath(new URL('./test/cloudflare-virtual-stub.ts', import.meta.url)) },
} });
