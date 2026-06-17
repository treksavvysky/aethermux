// ESLint flat config — see https://eslint.org/docs/latest/use/configure/
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // console/ is a separate package with its own TypeScript toolchain (tsc +
    // vitest + vite); it is not linted by the orchestrator's ESLint.
    ignores: ['dist/**', 'node_modules/**', 'console/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    // TypeScript resolves identifiers itself; core no-undef would false-positive
    // on Node globals (process, console, setInterval, …) in source files.
    rules: {
      'no-undef': 'off',
      // Allow intentionally-unused args prefixed with _ (e.g. Express error
      // handlers, which must declare 4 params to be recognised).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Test files use the built-in node:test runner and plain JS.
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        queueMicrotask: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },
);
