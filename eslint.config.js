import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/src/generated/**',
      'services/**',
      'tools/**',
      '.snapshots/**',
      '**/*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      // Tenant isolation (ADR-0004): only src/infra may create or use the raw Prisma client.
      // Application code goes through Database.run(), which sets the RLS tenant context.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message: 'Use Database.run() from src/infra/database.ts instead.',
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: ['**/generated/prisma/*', '**/generated/prisma'],
              message: 'Use Database.run() from src/infra/database.ts instead.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/infra/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/api/scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // k6 load-test scripts run in k6's own JavaScript runtime.
    files: ['infra/load/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', console: 'readonly' } },
  },
  prettier,
);
