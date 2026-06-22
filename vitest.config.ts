import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Stub the workerd-only virtual modules so Node tests can import Worker
// entrypoints that re-export a WorkflowEntrypoint subclass. The durable step
// logic is tested directly (not through these); see test/cloudflare-virtual-stub.ts.
const workerdStub = fileURLToPath(new URL('./test/cloudflare-virtual-stub.ts', import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    alias: {
      'cloudflare:workers': workerdStub,
      'cloudflare:workflows': workerdStub,
    },
  },
});
