// @ts-check

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Integration tests are opt-in and may require external services.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',

    // Keep test behavior independent of the invoking shell.
    env: { NODE_ENV: 'test' },

    globals: false,
    passWithNoTests: false,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/vitest-junit.xml' },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
      exclude: ['**/*.d.ts', 'src/app/**', 'tests/**', '_docs/**'],
    },

    // Integration suites share PostgreSQL state and must not run concurrently.
    pool: 'forks',
    fileParallelism: false,

    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});