import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  test: {
    // Logic suites run in node; component suites opt into jsdom per-file via
    // `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
