import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      // Server-side modules carry the `server-only` marker, which throws unless
      // resolved under the `react-server` condition. Alias just that package
      // rather than setting the condition globally — `react` and `react-dom`
      // declare it too, and resolving React's server build in a component test
      // would fail in ways that point nowhere near the cause.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
