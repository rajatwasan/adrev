import { defineConfig } from 'vitest/config';

// Relative base so the build works at a domain root or under a sub path (GitHub Pages).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'] },
});
