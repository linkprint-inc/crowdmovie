import { defineConfig } from 'drizzle-kit';

// drizzle-kit config for schema generation and migration bookkeeping.
// The URL is only used by `drizzle-kit push`/`studio`; `generate` diffs the
// schema file offline, and runtime migrations are applied by src/db/migrate.ts.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://localhost:5432/crowdmovie_test',
  },
});
