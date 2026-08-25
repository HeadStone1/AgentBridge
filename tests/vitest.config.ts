import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const testsDir = dirname(fileURLToPath(import.meta.url));
const packageSource = (name: string) => resolve(testsDir, '..', 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@agentbridge/protocol': packageSource('protocol'),
      '@agentbridge/config': packageSource('config'),
      '@agentbridge/storage': packageSource('storage'),
      '@agentbridge/audit': packageSource('audit'),
      '@agentbridge/connectors': packageSource('connectors'),
      '@agentbridge/collaboration': packageSource('collaboration'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 20_000,
  },
});
