import { randomUUID } from 'node:crypto';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { passkey } from '@better-auth/passkey';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { SendblueVerify } from '@tallie/channels';
import { identityDatabase, type IdentityDatabase } from './database';
import { identityVault } from './crypto';
import { IdentityError } from './errors';
import { SignupService } from './signup';
import type { AccountPrincipal, IdentityAccount } from './contracts';
import { cookieNames, phoneDemoEnabled } from './config';

export const SIGNUP_COOKIE = 'tallie_signup';
const onboardingEnrollmentWindowMs = 10 * 60_000;
export function browserTokenFromHeaders(
  headers: Headers,
  origin = process.env.APP_ORIGIN,
): string | null {
  const name = cookieNames(origin).signup;
  const cookie = headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie) ? cookie : null;
}
export function identityAvailable(): boolean {
  return (
    !!process.env.DATABASE_URL &&
    (process.env.BETTER_AUTH_SECRET?.length ?? 0) >= 32 &&
    /^[a-fA-F0-9]{64}$/.test(process.env.IDENTITY_ENCRYPTION_KEY ?? '') &&
    !!process.env.SENDBLUE_API_KEY_ID &&
    !!process.env.SENDBLUE_API_SECRET_KEY &&
    /^SV[A-Za-z0-9]{20,64}$/.test(process.env.SENDBLUE_VERIFY_SERVICE_SID ?? '') &&
    !!process.env.APP_ORIGIN
  );
}
export function signupService(): SignupService {
  if (!identityAvailable())
    throw new IdentityError('IDENTITY_UNAVAILABLE', 'Account setup is not configured yet.', 503);
  return new SignupService(
    identityDatabase(),
    new SendblueVerify({
      keyId: process.env.SENDBLUE_API_KEY_ID!,
      secret: process.env.SENDBLUE_API_SECRET_KEY!,
    }),
    identityVault(),
    process.env.SENDBLUE_VERIFY_SERVICE_SID!,
  );
}
export async function accountForSession(
  db: Kysely<IdentityDatabase>,
  sessionId: string,
): Promise<IdentityAccount | null> {
  const row = await db
    .selectFrom('auth_session as s')
    .innerJoin('auth_user as u', 'u.id', 's.user_id')
    .innerJoin('identity_phone_bindings as p', 'p.user_id', 'u.id')
    .select([
      'u.id',
      'u.name',
      'u.phone_demo',
      'p.masked_phone',
      's.assurance_kind',
      's.created_at',
    ])
    .where('s.id', '=', sessionId)
    .where('s.expires_at', '>', new Date())
    .executeTakeFirst();
  if (!row) return null;
  const [passkeys, codes] = await Promise.all([
    db.selectFrom('auth_passkey').select('id').where('user_id', '=', row.id).execute(),
    db
      .selectFrom('identity_recovery_codes')
      .select('id')
      .where('user_id', '=', row.id)
      .where('consumed_at', 'is', null)
      .execute(),
  ]);
  return {
    id: row.id,
    name: row.name,
    maskedPhone: row.masked_phone,
    passkeyCount: passkeys.length,
    recoveryCodesRemaining: codes.length,
    assurance: row.assurance_kind,
    enrollmentExpiresAt:
      row.assurance_kind === 'onboarding'
        ? new Date(row.created_at.getTime() + onboardingEnrollmentWindowMs).toISOString()
        : null,
    ready:
      row.assurance_kind === 'passkey' ||
      row.assurance_kind === 'recovery' ||
      (row.assurance_kind === 'phone_demo' &&
        row.phone_demo &&
        passkeys.length === 0 &&
        phoneDemoEnabled()),
  };
}
export function createIdentityAuth(config: {
  db: Kysely<IdentityDatabase>;
  origin: string;
  secret: string;
  signup: SignupService;
}) {
  const origin = new URL(config.origin);
  if (
    origin.origin !== config.origin ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === 'https:' ||
      (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))
    )
  )
    throw new Error('Identity origin must be a fixed HTTPS origin (or local development).');
  const cookies = cookieNames(config.origin);
  const verifiedRegistrations = new WeakSet<object>();
  const bridge = {
    id: 'tallie-reverse-otp',
    endpoints: {
      completePhone: createAuthEndpoint(
        '/complete-phone',
        {
          method: 'POST',
          body: z.discriminatedUnion('mode', [
            z
              .object({
                mode: z.literal('phone_demo'),
                challengeId: z.uuid(),
                name: z.string().trim().min(1).max(80).optional(),
              })
              .strict(),
            z
              .object({
                mode: z.literal('signup'),
                challengeId: z.uuid(),
                name: z.string().trim().min(1).max(80),
              })
              .strict(),
            z
              .object({
                mode: z.literal('recovery'),
                challengeId: z.uuid(),
                recoveryCode: z.string().min(1).max(80),
              })
              .strict(),
          ]),
        },
        async (ctx) => {
          const token = ctx.headers ? browserTokenFromHeaders(ctx.headers, config.origin) : null;
          if (!token)
            throw new APIError('UNAUTHORIZED', {
              code: 'SIGNUP_SESSION_REQUIRED',
              message: 'Start verification from this browser.',
            });
          try {
            const existing = await getSessionFromCtx(ctx);
            const expectedAccount = ctx.headers?.get('x-tallie-account');
            if (expectedAccount && existing?.user.id !== expectedAccount)
              throw new APIError('CONFLICT', {
                code: 'ACCOUNT_CHANGED',
                message: 'Your account changed. Refresh Tallie before continuing.',
              });
            const completed =
              ctx.body.mode === 'phone_demo'
                ? await config.signup.completePhoneDemo(
                    token,
                    ctx.body.challengeId,
                    ctx.body.name === undefined ? {} : { name: ctx.body.name },
                  )
                : await config.signup.complete(
                    token,
                    ctx.body.challengeId,
                    ctx.body.mode === 'signup'
                      ? { name: ctx.body.name }
                      : { recoveryCode: ctx.body.recoveryCode },
                    existing?.session.id,
                  );
            const session = await ctx.context.internalAdapter.findSession(completed.sessionToken);
            if (!session)
              throw new APIError('UNAUTHORIZED', { message: 'Sign in again to continue.' });
            await setSessionCookie(ctx, session);
            return ctx.json({
              data: { account: await accountForSession(config.db, session.session.id) },
            });
          } catch (error) {
            if (error instanceof IdentityError)
              throw new APIError(
                error.status === 409
                  ? 'CONFLICT'
                  : error.status === 429
                    ? 'TOO_MANY_REQUESTS'
                    : error.status === 403
                      ? 'FORBIDDEN'
                      : error.status === 401
                        ? 'UNAUTHORIZED'
                        : 'BAD_REQUEST',
                { code: error.code, message: error.message },
              );
            throw error;
          }
        },
      ),
    },
  } satisfies BetterAuthPlugin;
  return betterAuth({
    appName: 'Tallie',
    baseURL: config.origin,
    basePath: '/api/identity/auth',
    secret: config.secret,
    database: { db: config.db, type: 'postgres' },
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    account: {
      modelName: 'auth_account',
      accountLinking: { enabled: false },
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    user: {
      modelName: 'auth_user',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
      deleteUser: { enabled: false },
    },
    session: {
      modelName: 'auth_session',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
      expiresIn: 30 * 24 * 60 * 60,
      freshAge: 15 * 60,
      cookieCache: { enabled: false },
      additionalFields: {
        assuranceKind: {
          type: 'string',
          fieldName: 'assurance_kind',
          defaultValue: 'onboarding',
          input: false,
        },
        assuranceAt: { type: 'date', fieldName: 'assurance_at', required: false, input: false },
      },
    },
    verification: {
      modelName: 'auth_verification',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    advanced: {
      cookiePrefix: cookies.prefix,
      database: { generateId: () => randomUUID() },
      useSecureCookies: origin.protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: [] },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'identity_rate_limits',
      fields: { lastRequest: 'last_request' },
      window: 60,
      max: 60,
    },
    logger: { disabled: true },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => ({
            data: {
              ...session,
              assuranceKind:
                ctx?.path === '/passkey/verify-authentication' ? 'passkey' : 'onboarding',
              assuranceAt: ctx?.path === '/passkey/verify-authentication' ? new Date() : null,
            },
          }),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/passkey/delete-passkey')
          throw new APIError('FORBIDDEN', {
            code: 'PASSKEY_REMOVAL_UNAVAILABLE',
            message: 'Passkey removal is not available yet. You can add another passkey.',
          });
        if (
          [
            '/passkey/generate-register-options',
            '/passkey/verify-registration',
            '/passkey/update-passkey',
          ].includes(ctx.path)
        ) {
          const current = await getSessionFromCtx(ctx);
          if (!current)
            throw new APIError('UNAUTHORIZED', { message: 'Sign in before adding a passkey.' });
          const expectedAccount = ctx.headers?.get('x-tallie-account');
          if (expectedAccount && expectedAccount !== current.user.id)
            throw new APIError('CONFLICT', {
              code: 'ACCOUNT_CHANGED',
              message: 'Your account changed. Refresh Tallie before continuing.',
            });
          const row = await config.db
            .selectFrom('auth_session as s')
            .selectAll('s')
            .where('s.id', '=', current.session.id)
            .executeTakeFirst();
          const fresh =
            row &&
            (row.assurance_kind === 'onboarding'
              ? Date.now() - row.created_at.getTime() < onboardingEnrollmentWindowMs
              : row.assurance_kind === 'phone_demo'
                ? false
                : row.assurance_at && Date.now() - row.assurance_at.getTime() < 15 * 60_000);
          if (!fresh)
            throw new APIError('FORBIDDEN', {
              code: 'STEP_UP_REQUIRED',
              message: 'Use your passkey again before changing account security.',
            });
          // Keep registration attached to this session; a client cannot mint an unassured replacement.
          if (ctx.path === '/passkey/verify-registration' && ctx.body?.createSession)
            throw new APIError('BAD_REQUEST', {
              message: 'Register this passkey in your current session.',
            });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === '/passkey/verify-registration' &&
          verifiedRegistrations.has(ctx.context) &&
          ctx.context.returned &&
          !(ctx.context.returned instanceof APIError)
        ) {
          verifiedRegistrations.delete(ctx.context);
          const current = await getSessionFromCtx(ctx);
          if (!current) return;
          const credential = await config.db
            .selectFrom('auth_passkey')
            .select('id')
            .where('user_id', '=', current.user.id)
            .where('credential_id', '=', ctx.body.response.id as string)
            .executeTakeFirst();
          if (credential)
            await config.db.transaction().execute(async (tx) => {
              await tx
                .updateTable('auth_user')
                .set({ phone_demo: false })
                .where('id', '=', current.user.id)
                .execute();
              await tx
                .updateTable('auth_session')
                .set({ assurance_kind: 'passkey', assurance_at: new Date() })
                .where('id', '=', current.session.id)
                .execute();
            });
        }
      }),
    },
    plugins: [
      bridge,
      passkey({
        rpID: origin.hostname,
        rpName: 'Tallie',
        origin: config.origin,
        advanced: { webAuthnChallengeCookie: cookies.passkeyChallenge },
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: {
          requireSession: true,
          afterVerification: async ({ ctx, verification }) => {
            if (!verification.registrationInfo?.userVerified)
              throw new APIError('FORBIDDEN', {
                message: 'Confirm with your device PIN or biometrics.',
              });
            verifiedRegistrations.add(ctx.context);
          },
        },
        authentication: {
          afterVerification: async ({ ctx, verification, clientData }) => {
            if (!verification.authenticationInfo.userVerified)
              throw new APIError('FORBIDDEN', {
                message: 'Confirm with your device PIN or biometrics.',
              });
            const expectedAccount = ctx.headers?.get('x-tallie-account');
            if (expectedAccount) {
              const credential = await config.db
                .selectFrom('auth_passkey')
                .select('user_id')
                .where('credential_id', '=', clientData.id)
                .executeTakeFirst();
              if (credential?.user_id !== expectedAccount)
                throw new APIError('CONFLICT', {
                  code: 'ACCOUNT_CHANGED',
                  message: 'Use the passkey for your current Tallie account.',
                });
            }
          },
        },
        schema: {
          passkey: {
            modelName: 'auth_passkey',
            fields: {
              userId: 'user_id',
              publicKey: 'public_key',
              credentialID: 'credential_id',
              deviceType: 'device_type',
              backedUp: 'backed_up',
              createdAt: 'created_at',
            },
          },
        },
      }),
    ],
  });
}
const singleton = globalThis as typeof globalThis & {
  __tallieAuth?: ReturnType<typeof createIdentityAuth>;
};
export function identityAuth(): ReturnType<typeof createIdentityAuth> {
  if (!identityAvailable())
    throw new IdentityError('IDENTITY_UNAVAILABLE', 'Account setup is not configured yet.', 503);
  return (singleton.__tallieAuth ??= createIdentityAuth({
    db: identityDatabase(),
    origin: process.env.APP_ORIGIN!,
    secret: process.env.BETTER_AUTH_SECRET!,
    signup: signupService(),
  }));
}
export async function requireAccount(
  request: Request,
  db: Kysely<IdentityDatabase> = identityDatabase(),
  auth: ReturnType<typeof createIdentityAuth> = identityAuth(),
): Promise<AccountPrincipal> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new IdentityError('AUTH_REQUIRED', 'Sign in to continue.', 401);
  const row = await db
    .selectFrom('auth_session as s')
    .innerJoin('identity_phone_bindings as p', 'p.user_id', 's.user_id')
    .innerJoin('auth_user as u', 'u.id', 's.user_id')
    .select(['s.id', 's.user_id', 's.assurance_kind', 'p.phone_hash', 'u.name', 'u.phone_demo'])
    .select((eb) =>
      eb
        .exists(eb.selectFrom('auth_passkey').select('id').whereRef('user_id', '=', 'u.id'))
        .as('has_passkey'),
    )
    .where('s.id', '=', session.session.id)
    .where('s.expires_at', '>', new Date())
    .executeTakeFirst();
  if (!row) throw new IdentityError('AUTH_REQUIRED', 'Sign in to continue.', 401);
  const expectedAccount = request.headers.get('x-tallie-account');
  if (expectedAccount && expectedAccount !== row.user_id)
    throw new IdentityError(
      'ACCOUNT_CHANGED',
      'Your account changed. Refresh Tallie before continuing.',
      409,
    );
  if (
    row.assurance_kind === 'onboarding' ||
    (row.assurance_kind === 'phone_demo' &&
      (!phoneDemoEnabled() || !row.phone_demo || row.has_passkey))
  )
    throw new IdentityError(
      'PASSKEY_REQUIRED',
      'Add a passkey to finish setting up your account.',
      403,
    );
  return {
    userId: row.user_id,
    sessionId: row.id,
    phoneHash: row.phone_hash,
    displayName: row.name,
  };
}
export async function requireRecentAccount(
  request: Request,
  db: Kysely<IdentityDatabase> = identityDatabase(),
  auth: ReturnType<typeof createIdentityAuth> = identityAuth(),
): Promise<AccountPrincipal> {
  const principal = await requireAccount(request, db, auth);
  const session = await db
    .selectFrom('auth_session')
    .select(['assurance_at', 'assurance_kind'])
    .where('id', '=', principal.sessionId)
    .executeTakeFirst();
  if (
    !session?.assurance_at ||
    !['passkey', 'recovery'].includes(session.assurance_kind) ||
    Date.now() - session.assurance_at.getTime() > 15 * 60_000
  )
    throw new IdentityError('STEP_UP_REQUIRED', 'Use your passkey again to continue.', 403);
  return principal;
}
export async function verifiedPhoneFor(userId: string): Promise<string> {
  const binding = await identityDatabase()
    .selectFrom('identity_phone_bindings')
    .select('phone_ciphertext')
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return identityVault().open(binding.phone_ciphertext, `${userId}:phone`);
}
