// Programmatic migration runner. Applies the SQL migrations in ../../drizzle
// (0000 schema, 0001 prod-role grants) using the node-postgres driver. Used by
// the constraint tests and runnable as a script:
//   DATABASE_URL=postgresql://localhost:5432/crowdmovie node dist/db/migrate.js
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/**
 * Apply all pending migrations to the database at `connectionString`.
 * Opens a short-lived pool and always closes it before returning.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

// Run directly (`node migrate.js`) — apply to DATABASE_URL and exit.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required to run migrations');
    process.exit(1);
  }
  await runMigrations(url);
  console.log('Migrations applied.');
}
