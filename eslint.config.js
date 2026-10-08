import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Untrusted text (place names, instructions) must never reach innerHTML.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent or the el() helper instead.' },
        { property: 'outerHTML', message: 'Use textContent or the el() helper instead.' },
      ],
    },
  },
);
