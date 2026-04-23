// ESLint 9 flat config — dev-only; the app itself has no build step.
// Run: npm run lint
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'data/**',
      'node_modules/**',
      'middleware.js',
      '.vercel/**',
      'dist/**',
      'build/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['js/**/*.js', 'viewer.js'],
    ignores: ['js/volume-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      // Keep noise low; tighten incrementally (see contributor notes in README).
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Intentional silent catches for localStorage / plugin hooks
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['js/volume-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.worker,
        ...globals.es2021,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // importScripts + UMD eval pattern for fzstd in worker
      'no-eval': 'off',
    },
  },
];
