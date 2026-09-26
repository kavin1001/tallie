import { randomBytes, randomUUID } from 'node:crypto';
import { database, SESSION_LIFETIME_MS, tokenHash, type Database } from '@tallie/db';
import type { Kysely, Transaction } from 'kysely';
import { AppError } from './errors';

export const SESSION_COOKIE = 'tallie_demo_session';

export interface Principal {
  sessionId: string;
  workspaceId: string;
  personId: string;
}

export async function resolveSession(
  token: string | null,
  db: Kysely<Database> = database(),
): Promise<Principal> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new AppError('AUTH_REQUIRED', 'Start a private demo to continue.', 401);
  const session = await db
    .selectFrom('demo_sessions')
    .select(['id', 'workspace_id', 'person_id'])
    .where('token_hash', '=', tokenHash(token))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  if (!session)
    throw new AppError(
      'AUTH_REQUIRED',
      'Your demo session has ended. Start a new one to continue.',
      401,
    );
  return { sessionId: session.id, workspaceId: session.workspace_id, personId: session.person_id };
}

/** Lock first in every command so persona rotation cannot race an authorization. */
export async function lockSession(tx: Transaction<Database>, principal: Principal): Promise<void> {
  const session = await tx
    .selectFrom('demo_sessions')
    .select('id')
    .where('id', '=', principal.sessionId)
    .where('workspace_id', '=', principal.workspaceId)
    .where('person_id', '=', principal.personId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .forUpdate()
    .executeTakeFirst();
  if (!session)
    throw new AppError(
      'AUTH_REQUIRED',
      'Your demo identity changed. Refresh before continuing.',
      401,
    );
}

export async function switchDemoPersona(
  principal: Principal,
  personId: string,
  db: Kysely<Database> = database(),
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.transaction().execute(async (tx) => {
    await lockSession(tx, principal);
    const person = await tx
      .selectFrom('people')
      .select('id')
      .where('workspace_id', '=', principal.workspaceId)
      .where('id', '=', personId)
      .executeTakeFirst();
    if (!person) throw new AppError('NOT_FOUND', 'That person is not in this private demo.', 404);
    await tx
      .updateTable('demo_sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', principal.sessionId)
      .execute();
    await tx
      .insertInto('demo_sessions')
      .values({
        id: randomUUID(),
        token_hash: tokenHash(token),
        workspace_id: principal.workspaceId,
        person_id: personId,
        expires_at: new Date(Date.now() + SESSION_LIFETIME_MS),
        revoked_at: null,
      })
      .execute();
  });
  return token;
}

export function tokenFromRequest(request: Request): string | null {
  const raw = request.headers.get('cookie') ?? '';
  const value = raw
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return value?.slice(SESSION_COOKIE.length + 1) ?? null;
}

export function sessionCookie(token: string): string {
  const secure = process.env.APP_ORIGIN?.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1_000)}${secure}`;
}
