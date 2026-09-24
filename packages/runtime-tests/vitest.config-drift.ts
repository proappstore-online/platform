// Plain Node: wrangler.toml declares what the code binds, and the migrations
// sequence is well-formed. Nothing here needs workerd.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'config', include: ['test/config/**/*.test.ts'], environment: 'node' },
});
