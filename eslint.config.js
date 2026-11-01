import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/node_modules/', '**/dist/', '**/out/', '**/coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      // Core must stay platform-independent so it can be shared with future mobile clients.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(node:|(electron|react|react-dom|react-native|vite)(/|$))',
              message: '@temivo/core must not depend on platform, UI, or tooling packages.',
            },
            {
              regex: '^(fs|path|os|child_process|crypto|http|https|net|url|util|stream|events|buffer|worker_threads)(/|$)',
              message: '@temivo/core must not depend on Node.js built-in modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.{js,mjs,cjs}',
      'apps/desktop/*.ts',
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(node:|electron(/|$))',
              message: 'The renderer is sandboxed; use the preload API (window.temivo) instead.',
            },
          ],
        },
      ],
    },
  },
]);
