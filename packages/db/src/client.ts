import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema';

const globalConnection = globalThis as typeof globalThis & { __tallieDatabase?: Kysely<Database> };

export function createDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 8,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        application_name: 'tallie-demo',
      }),
    }),
  });
}

export function database(): Kysely<Database> {
  if (process.env.APP_MODE !== 'demo')
    throw new Error('This implementation requires APP_MODE=demo. Live payments are unavailable.');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  globalConnection.__tallieDatabase ??= createDatabase(url);
  return globalConnection.__tallieDatabase;
}
