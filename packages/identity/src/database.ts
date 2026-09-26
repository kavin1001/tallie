import { Kysely, PostgresDialect, sql, type Generated, type QueryExecutorProvider } from 'kysely';
import { Pool } from 'pg';
import type { AccountPrincipal } from './contracts';
import { IdentityError } from './errors';

export interface IdentityDatabase {
  auth_user: {
    id: string;
    name: string;
    email: string;
    email_verified: Generated<boolean>;
    image: Generated<string | null>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  auth_session: {
    id: string;
    user_id: string;
    token: string;
    expires_at: Date;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    ip_address: Generated<string | null>;
    user_agent: Generated<string | null>;
    assurance_kind: Generated<'onboarding' | 'passkey' | 'recovery'>;
    assurance_at: Generated<Date | null>;
    phone_verified_at: Generated<Date | null>;
  };
  auth_passkey: {
    id: string;
    user_id: string;
    name: string | null;
    public_key: string;
    credential_id: string;
    counter: number;
    device_type: string;
    backed_up: boolean;
    transports: string | null;
    created_at: Date | null;
    aaguid: string | null;
  };
  identity_phone_bindings: {
    user_id: string;
    phone_hash: string;
    phone_ciphertext: string;
    masked_phone: string;
    verified_at: Date;
  };
  identity_signup_transactions: {
    id: string;
    browser_hash: string;
    idempotency_key: string;
    phone_hash: string;
    phone_ciphertext: string | null;
    masked_phone: string;
    service_sid: string;
    verification_sid: string | null;
    delivery_ciphertext: string | null;
    status: 'creating' | 'pending' | 'verified' | 'expired' | 'failed' | 'needs_retry' | 'complete';
    created_at: Date;
    expires_at: Date;
    last_checked_at: Date | null;
    verified_at: Date | null;
    consumed_at: Date | null;
    completed_user_id: string | null;
    result_ciphertext: string | null;
    recovery_attempts: Generated<number>;
    purpose: Generated<'signup' | 'channel'>;
    account_id: Generated<string | null>;
    session_id: Generated<string | null>;
  };
  identity_recovery_codes: {
    id: string;
    user_id: string;
    code_hash: string;
    created_at: Date;
    consumed_at: Date | null;
  };
}
const state = globalThis as typeof globalThis & {
  __tallieIdentityDatabase?: Kysely<IdentityDatabase>;
};
export function createIdentityDatabase(connectionString: string): Kysely<IdentityDatabase> {
  return new Kysely<IdentityDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 6,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        statement_timeout: 10000,
        application_name: 'tallie-identity',
      }),
    }),
  });
}
export function identityDatabase(): Kysely<IdentityDatabase> {
  if (!process.env.DATABASE_URL)
    throw new IdentityError('IDENTITY_UNAVAILABLE', 'Account setup is not configured yet.', 503);
  return (state.__tallieIdentityDatabase ??= createIdentityDatabase(process.env.DATABASE_URL));
}
/** Hold this lock through the command transaction; logout/recovery deletes the session. */
export async function lockAccount(
  db: QueryExecutorProvider,
  principal: AccountPrincipal,
): Promise<void> {
  const result = await sql<{
    id: string;
  }>`SELECT id FROM auth_session WHERE id=${principal.sessionId}::uuid AND user_id=${principal.userId}::uuid AND expires_at>now() AND assurance_kind IN ('passkey','recovery') FOR SHARE`.execute(
    db,
  );
  if (!result.rows.length) throw new IdentityError('AUTH_REQUIRED', 'Sign in to continue.', 401);
}
