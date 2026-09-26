import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

export async function migrate(
  connectionString: string,
  deadlines: {
    connectionTimeoutMillis?: number;
    statementTimeoutMillis?: number;
    lockTimeoutMillis?: number;
  } = {},
): Promise<void> {
  const pool = new Pool({
    connectionString,
    max: 1,
    ...(deadlines.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: deadlines.connectionTimeoutMillis }),
    ...(deadlines.statementTimeoutMillis === undefined
      ? {}
      : { statement_timeout: deadlines.statementTimeoutMillis }),
    ...(deadlines.lockTimeoutMillis === undefined
      ? {}
      : { lock_timeout: deadlines.lockTimeoutMillis }),
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock(726512031)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS tallie_migrations (name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of (await readdir(directory))
      .filter((entry) => entry.endsWith('.sql'))
      .sort()) {
      const source = await readFile(`${directory}/${name}`, 'utf8');
      const digest = createHash('sha256').update(source).digest('hex');
      const previous = await client.query<{ digest: string }>(
        'SELECT digest FROM tallie_migrations WHERE name = $1',
        [name],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].digest !== digest)
          throw new Error(`Applied migration ${name} has changed. Add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(source);
        await client.query('INSERT INTO tallie_migrations (name, digest) VALUES ($1, $2)', [
          name,
          digest,
        ]);
        await client.query('COMMIT');
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (client) {
      await client.query('SELECT pg_advisory_unlock(726512031)').catch(() => undefined);
      client.release();
    }
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for migrations.');
  await migrate(url);
}
