import { database } from '@tallie/db';
import { sql } from 'kysely';
import { AppError } from '@/server/errors';
import { jsonResponse, route } from '@/server/http';

export const runtime = 'nodejs';
export const GET = route(async () => {
  const result = await sql<{
    name: string;
  }>`select name from tallie_migrations where name = '002_publish_and_settlement_integrity.sql'`.execute(
    database(),
  );
  if (result.rows.length !== 1)
    throw new AppError('MIGRATION_REQUIRED', 'Database setup is incomplete.', 503);
  return jsonResponse({ status: 'ready', mode: 'demo', realPayments: false });
});
