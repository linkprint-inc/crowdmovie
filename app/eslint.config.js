import tseslint from 'typescript-eslint';

// Flat config shared by the workspaces. Kept intentionally minimal for the
// T1.1 scaffold: TypeScript recommended rules, no type-aware linting yet.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  tseslint.configs.recommended,
);
