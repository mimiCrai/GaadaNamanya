import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintPluginPrettier,
    {
        ignores: ['dist/', 'node_modules/', 'coverage/'],
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-explicit-any': 'warn',
            // Git (core.autocrlf) may check files out with CRLF on Windows.
            'prettier/prettier': ['error', { endOfLine: 'auto' }],
        },
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { module: 'writable', require: 'readonly' },
        },
    }
);
