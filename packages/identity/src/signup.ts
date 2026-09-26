import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  PhoneVault,
  type PhoneVerificationProvider,
  type ProviderVerification,
} from '@tallie/channels';
import type { SignupChallenge, AccountPrincipal } from './contracts';
import type { IdentityDatabase } from './database';
import { lockAccount } from './database';
import { digest, normalizePhone, opaqueToken, recoveryCode, recoveryDigest } from './crypto';
import { phoneDemoEnabled } from './config';
import { IdentityError } from './errors';

type SignupRow = Selectable<IdentityDatabase['identity_signup_transactions']>;
const terminalSecrets = { delivery_ciphertext: null, phone_ciphertext: null };
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
export class SignupService {
  constructor(
    private readonly db: Kysely<IdentityDatabase>,
    private readonly provider: PhoneVerificationProvider,
    private readonly vault: PhoneVault,
    private readonly serviceSid: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async current(browserToken: string): Promise<SignupChallenge | null> {
    return this.db.transaction().execute(async (tx) => {
      let row = await tx
        .selectFrom('identity_signup_transactions')
        .selectAll()
        .where('browser_hash', '=', digest(browserToken))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;
      row = await this.expire(tx, row);
      if (row.status === 'complete' && row.purpose === 'signup' && row.result_ciphertext) {
        const result = JSON.parse(this.vault.open(row.result_ciphertext, `${row.id}:result`)) as {
          sessionToken: string;
          mode: string;
        };
        if (!(await this.completionSessionActive(tx, result.sessionToken, result.mode)))
          row = await tx
            .updateTable('identity_signup_transactions')
            .set({
              status: 'expired',
              expires_at: this.now(),
              ...terminalSecrets,
              result_ciphertext: null,
            })
            .where('id', '=', row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
      }
      return this.dto(row);
    });
  }

  async start(
    browserToken: string,
    phoneInput: string,
    key: string,
    channelPrincipal?: AccountPrincipal,
  ): Promise<SignupChallenge> {
    if (!keyPattern.test(key))
      throw new IdentityError('IDEMPOTENCY_KEY_REQUIRED', 'A unique retry key is required.');
    const phone = normalizePhone(phoneInput),
      phoneHash = this.vault.lookup(phone),
      browserHash = digest(browserToken);
    const reservation = await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(726512041)`.execute(tx);
      if (channelPrincipal) {
        await lockAccount(tx, channelPrincipal);
        const binding = await tx
          .selectFrom('identity_phone_bindings')
          .select('phone_hash')
          .where('user_id', '=', channelPrincipal.userId)
          .executeTakeFirstOrThrow();
        if (binding.phone_hash !== phoneHash)
          throw new IdentityError(
            'PHONE_MISMATCH',
            'Verify the phone already attached to this account.',
            403,
          );
        const session = await tx
          .selectFrom('auth_session')
          .select('assurance_at')
          .where('id', '=', channelPrincipal.sessionId)
          .executeTakeFirstOrThrow();
        if (
          !session.assurance_at ||
          this.now().getTime() - session.assurance_at.getTime() > 15 * 60_000
        )
          throw new IdentityError(
            'STEP_UP_REQUIRED',
            'Use your passkey again before connecting Messages.',
            403,
          );
      }
      const previous = await tx
        .selectFrom('identity_signup_transactions')
        .selectAll()
        .where('browser_hash', '=', browserHash)
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (previous) {
        if (
          previous.phone_hash !== phoneHash ||
          previous.purpose !== (channelPrincipal ? 'channel' : 'signup') ||
          (channelPrincipal && previous.session_id !== channelPrincipal.sessionId)
        )
          throw new IdentityError(
            'IDEMPOTENCY_CONFLICT',
            'This retry belongs to a different number.',
            409,
          );
        return { fresh: false, row: await this.expire(tx, previous) };
      }
      const count = await tx
        .selectFrom('identity_signup_transactions')
        .select(sql<string>`count(*)`.as('count'))
        .where('created_at', '>', new Date(this.now().getTime() - 15 * 60_000))
        .where((eb) =>
          eb.or([eb('phone_hash', '=', phoneHash), eb('browser_hash', '=', browserHash)]),
        )
        .executeTakeFirstOrThrow();
      const global = await tx
        .selectFrom('identity_signup_transactions')
        .select(sql<string>`count(*)`.as('count'))
        .where('created_at', '>', new Date(this.now().getTime() - 60 * 60_000))
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= 5 || Number(global.count) >= 100)
        throw new IdentityError('RATE_LIMITED', 'Too many attempts. Please try again later.', 429);
      await tx
        .updateTable('identity_signup_transactions')
        .set({ status: 'expired', ...terminalSecrets, result_ciphertext: null })
        .where('expires_at', '<=', this.now())
        .where('status', 'in', ['creating', 'pending', 'verified', 'complete'])
        .execute();
      await tx
        .updateTable('identity_signup_transactions')
        .set({ status: 'expired', ...terminalSecrets })
        .where('browser_hash', '=', browserHash)
        .where('status', 'in', ['creating', 'pending', 'verified'])
        .execute();
      const id = randomUUID();
      const row = await tx
        .insertInto('identity_signup_transactions')
        .values({
          id,
          browser_hash: browserHash,
          idempotency_key: key,
          phone_hash: phoneHash,
          phone_ciphertext: this.vault.seal(phone, `${id}:phone`),
          masked_phone: `+1 ••• ••• ${phone.slice(-4)}`,
          service_sid: this.serviceSid,
          verification_sid: null,
          delivery_ciphertext: null,
          status: 'creating',
          created_at: this.now(),
          expires_at: new Date(this.now().getTime() + 300_000),
          last_checked_at: null,
          verified_at: null,
          consumed_at: null,
          completed_user_id: null,
          result_ciphertext: null,
          purpose: channelPrincipal ? 'channel' : 'signup',
          account_id: channelPrincipal?.userId ?? null,
          session_id: channelPrincipal?.sessionId ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { fresh: true, row };
    });
    if (!reservation.fresh) return this.dto(reservation.row);
    let result: ProviderVerification | null = null;
    try {
      result = await this.provider.create(this.serviceSid, phone);
    } catch {
      /* Ambiguous dispatch never automatically repeats. */
    }
    return this.db.transaction().execute(async (tx) => {
      let row = await this.expire(tx, await this.locked(tx, browserToken, reservation.row.id));
      if (row.status !== 'creating') return this.dto(row);
      if (
        !result ||
        result.to !== phone ||
        result.service_sid !== row.service_sid ||
        result.status !== 'pending' ||
        !result.delivery_target ||
        new Date(result.expires_at) <= this.now()
      ) {
        row = await tx
          .updateTable('identity_signup_transactions')
          .set({ status: 'failed', ...terminalSecrets })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .updateTable('identity_signup_transactions')
          .set({
            status: 'pending',
            verification_sid: result.sid,
            delivery_ciphertext: this.vault.seal(
              JSON.stringify(result.delivery_target),
              `${row.id}:delivery`,
            ),
            expires_at: new Date(
              Math.min(row.expires_at.getTime(), new Date(result.expires_at).getTime()),
            ),
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return this.dto(row);
    });
  }

  async check(browserToken: string, id: string): Promise<SignupChallenge> {
    const reservation = await this.db.transaction().execute(async (tx) => {
      const row = await this.expire(tx, await this.locked(tx, browserToken, id));
      if (
        row.status !== 'pending' ||
        !row.verification_sid ||
        (row.last_checked_at && this.now().getTime() - row.last_checked_at.getTime() < 3000)
      )
        return { poll: false, row };
      await tx
        .updateTable('identity_signup_transactions')
        .set({ last_checked_at: this.now() })
        .where('id', '=', id)
        .execute();
      return { poll: true, row };
    });
    if (!reservation.poll || !reservation.row.verification_sid) return this.dto(reservation.row);
    let result: ProviderVerification;
    try {
      result = await this.provider.retrieve(
        reservation.row.service_sid,
        reservation.row.verification_sid,
      );
    } catch {
      throw new IdentityError(
        'PROVIDER_UNAVAILABLE',
        'We could not check that message yet. Try again.',
        503,
      );
    }
    return this.db.transaction().execute(async (tx) => {
      let row = await this.expire(tx, await this.locked(tx, browserToken, id));
      if (row.status !== 'pending') return this.dto(row);
      const expected = row.phone_ciphertext
        ? this.vault.open(row.phone_ciphertext, `${id}:phone`)
        : null;
      let status: SignupRow['status'] = 'pending';
      if (
        !expected ||
        result.to !== expected ||
        result.sid !== row.verification_sid ||
        result.service_sid !== row.service_sid
      )
        status = 'needs_retry';
      else if (result.status === 'expired' || new Date(result.expires_at) <= this.now())
        status = 'expired';
      else if (result.status === 'canceled') status = 'failed';
      else if (result.status === 'approved') status = 'verified';
      if (status !== 'pending')
        row = await tx
          .updateTable('identity_signup_transactions')
          .set({
            status,
            delivery_ciphertext: null,
            ...(status === 'verified' ? { verified_at: this.now() } : { phone_ciphertext: null }),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      return this.dto(row);
    });
  }

  /** Persist identity + session + consumed proof atomically; response retries reuse that exact session. */
  async complete(
    browserToken: string,
    id: string,
    input: { name: string } | { recoveryCode: string },
    onboardingSessionId?: string,
  ): Promise<{ userId: string; sessionToken: string }> {
    return this.completeMode(
      browserToken,
      id,
      'name' in input ? 'signup' : 'recovery',
      input,
      onboardingSessionId,
    );
  }

  async completePhoneDemo(
    browserToken: string,
    id: string,
    input: { name?: string },
  ): Promise<{ userId: string; sessionToken: string }> {
    if (!phoneDemoEnabled())
      throw new IdentityError('PHONE_DEMO_UNAVAILABLE', 'Phone sign-in is unavailable.', 403);
    return this.completeMode(browserToken, id, 'phone_demo', input);
  }

  private async completeMode(
    browserToken: string,
    id: string,
    mode: 'signup' | 'recovery' | 'phone_demo',
    input: { name?: string } | { recoveryCode: string },
    onboardingSessionId?: string,
  ): Promise<{ userId: string; sessionToken: string }> {
    const result = await this.db.transaction().execute(async (tx) => {
      let row = await this.expire(tx, await this.locked(tx, browserToken, id));
      if (row.purpose !== 'signup')
        throw new IdentityError(
          'WRONG_PROOF_PURPOSE',
          'This verification cannot create or recover an account.',
          403,
        );
      if (row.status === 'complete' && row.result_ciphertext) {
        const cached = JSON.parse(this.vault.open(row.result_ciphertext, `${id}:result`)) as {
          userId: string;
          sessionToken: string;
          mode: string;
          inputHash: string;
        };
        if (cached.mode !== mode || cached.inputHash !== digest(JSON.stringify(input)))
          throw new IdentityError(
            'IDEMPOTENCY_CONFLICT',
            'This verification was completed with different details.',
            409,
          );
        if (!(await this.completionSessionActive(tx, cached.sessionToken, mode)))
          throw new IdentityError('AUTH_REQUIRED', 'Sign in again to continue.', 401);
        return { userId: cached.userId, sessionToken: cached.sessionToken };
      }
      if (row.status !== 'verified' || !row.phone_ciphertext || row.consumed_at)
        throw new IdentityError(
          'PHONE_PROOF_REQUIRED',
          'Verify your number before continuing.',
          403,
        );
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${row.phone_hash},0))`.execute(tx);
      const existing = await tx
        .selectFrom('identity_phone_bindings')
        .selectAll()
        .where('phone_hash', '=', row.phone_hash)
        .forUpdate()
        .executeTakeFirst();
      let userId: string;
      if (mode !== 'recovery') {
        if ('recoveryCode' in input) throw new IdentityError('INVALID_INPUT', 'Try again.');
        let resumable: Selectable<IdentityDatabase['auth_session']> | undefined;
        if (existing && mode === 'phone_demo') {
          const account = await tx
            .selectFrom('auth_user')
            .select('phone_demo')
            .where('id', '=', existing.user_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const evidence = await sql<{ blocked: boolean }>`SELECT
            EXISTS(SELECT 1 FROM auth_passkey WHERE user_id=${existing.user_id}::uuid)
            OR EXISTS(SELECT 1 FROM auth_account WHERE user_id=${existing.user_id}::uuid)
            OR EXISTS(SELECT 1 FROM identity_recovery_codes WHERE user_id=${existing.user_id}::uuid)
            OR EXISTS(SELECT 1 FROM auth_session WHERE user_id=${existing.user_id}::uuid
              AND assurance_kind IN ('passkey','recovery')) AS blocked`.execute(tx);
          if (!account.phone_demo || evidence.rows[0]?.blocked)
            throw new IdentityError(
              'ACCOUNT_RECOVERY_REQUIRED',
              'This account uses a passkey. Use your passkey or a recovery code.',
              409,
            );
        } else if (existing && onboardingSessionId) {
          resumable = await tx
            .selectFrom('auth_session')
            .selectAll()
            .where('id', '=', onboardingSessionId)
            .where('user_id', '=', existing.user_id)
            .where((eb) =>
              eb.or([
                eb('assurance_kind', '=', 'onboarding'),
                eb.and([
                  eb('assurance_kind', '=', 'phone_demo'),
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom('auth_passkey')
                        .select('id')
                        .where('user_id', '=', existing.user_id),
                    ),
                  ),
                  eb.exists(
                    eb
                      .selectFrom('auth_user')
                      .select('id')
                      .where('id', '=', existing.user_id)
                      .where('phone_demo', '=', true),
                  ),
                ]),
              ]),
            )
            .where('expires_at', '>', this.now())
            .forUpdate()
            .executeTakeFirst();
        }
        if (existing && mode !== 'phone_demo' && !resumable)
          throw new IdentityError(
            'ACCOUNT_RECOVERY_REQUIRED',
            'This number already has a Tallie account. Use your passkey or a recovery code.',
            409,
          );
        const name = input.name?.trim();
        if (!existing && mode === 'phone_demo' && input.name === undefined)
          throw new IdentityError('NAME_REQUIRED', 'What should your friends call you?', 409);
        if (
          !(existing && mode === 'phone_demo') &&
          (!name ||
            name.length > 80 ||
            /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name))
        )
          throw new IdentityError('INVALID_NAME', 'Enter the name your friends know you by.');
        userId =
          existing && mode === 'phone_demo'
            ? existing.user_id
            : (resumable?.user_id ?? randomUUID());
        if (resumable) {
          await tx.deleteFrom('auth_session').where('id', '=', resumable.id).execute();
          await tx
            .updateTable('auth_user')
            .set({ name: name!, updated_at: this.now() })
            .where('id', '=', userId)
            .execute();
        } else if (!existing) {
          await tx
            .insertInto('auth_user')
            .values({
              id: userId,
              name: name!,
              email: `${userId}@identity.tallie.invalid`,
              phone_demo: mode === 'phone_demo',
            })
            .execute();
          const phone = this.vault.open(row.phone_ciphertext, `${id}:phone`);
          await tx
            .insertInto('identity_phone_bindings')
            .values({
              user_id: userId,
              phone_hash: row.phone_hash,
              phone_ciphertext: this.vault.seal(phone, `${userId}:phone`),
              masked_phone: row.masked_phone,
              verified_at: this.now(),
            })
            .execute();
        }
      } else {
        if (!('recoveryCode' in input)) throw new IdentityError('INVALID_INPUT', 'Try again.');
        if (row.recovery_attempts >= 5)
          throw new IdentityError(
            'RECOVERY_LOCKED',
            'Start a new verification before trying another recovery code.',
            429,
          );
        const code = existing
          ? await tx
              .selectFrom('identity_recovery_codes')
              .selectAll()
              .where('user_id', '=', existing.user_id)
              .where('code_hash', '=', recoveryDigest(input.recoveryCode))
              .where('consumed_at', 'is', null)
              .forUpdate()
              .executeTakeFirst()
          : null;
        if (!existing || !code) {
          await tx
            .updateTable('identity_signup_transactions')
            .set({ recovery_attempts: row.recovery_attempts + 1 })
            .where('id', '=', id)
            .execute();
          return { error: true as const };
        }
        userId = existing.user_id;
        await tx
          .selectFrom('auth_user')
          .select('id')
          .where('id', '=', userId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await tx
          .updateTable('identity_recovery_codes')
          .set({ consumed_at: this.now() })
          .where('id', '=', code.id)
          .execute();
        await tx.deleteFrom('auth_session').where('user_id', '=', userId).execute();
      }
      const sessionToken = opaqueToken();
      await tx
        .insertInto('auth_session')
        .values({
          id: randomUUID(),
          user_id: userId,
          token: sessionToken,
          expires_at: new Date(this.now().getTime() + 30 * 24 * 60 * 60_000),
          assurance_kind: mode === 'signup' ? 'onboarding' : mode,
          assurance_at: mode === 'signup' ? null : this.now(),
          phone_verified_at: this.now(),
        })
        .execute();
      row = await tx
        .updateTable('identity_signup_transactions')
        .set({
          status: 'complete',
          consumed_at: this.now(),
          completed_user_id: userId,
          // The provider proof is consumed. Retain only its encrypted response for
          // the anonymous browser-cookie lifetime so a lost HTTP reply is recoverable.
          expires_at: new Date(this.now().getTime() + 30 * 60_000),
          ...terminalSecrets,
          result_ciphertext: this.vault.seal(
            JSON.stringify({
              userId,
              sessionToken,
              mode,
              inputHash: digest(JSON.stringify(input)),
            }),
            `${id}:result`,
          ),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { userId, sessionToken };
    });
    if ('error' in result)
      throw new IdentityError(
        'INVALID_RECOVERY_CODE',
        'That recovery code could not be used.',
        403,
      );
    return result;
  }

  async startChannel(
    principal: AccountPrincipal,
    browserToken: string,
    key: string,
  ): Promise<SignupChallenge> {
    const binding = await this.db
      .selectFrom('identity_phone_bindings')
      .select('phone_ciphertext')
      .where('user_id', '=', principal.userId)
      .executeTakeFirstOrThrow();
    const phone = this.vault.open(binding.phone_ciphertext, `${principal.userId}:phone`);
    return this.start(browserToken, phone, key, principal);
  }

  async completeChannel(
    principal: AccountPrincipal,
    browserToken: string,
    id: string,
  ): Promise<{ verifiedAt: string }> {
    return this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, principal);
      let row = await this.locked(tx, browserToken, id);
      if (
        row.purpose !== 'channel' ||
        row.account_id !== principal.userId ||
        row.session_id !== principal.sessionId ||
        row.phone_hash !== principal.phoneHash
      )
        throw new IdentityError(
          'WRONG_PROOF_PURPOSE',
          'This verification belongs to a different account action.',
          403,
        );
      const session = await tx
        .selectFrom('auth_session')
        .select(['assurance_at', 'phone_verified_at'])
        .where('id', '=', principal.sessionId)
        .executeTakeFirstOrThrow();
      if (
        !session.assurance_at ||
        this.now().getTime() - session.assurance_at.getTime() > 15 * 60_000
      )
        throw new IdentityError(
          'STEP_UP_REQUIRED',
          'Use your passkey again before connecting Messages.',
          403,
        );
      // Provider challenge expiry does not erase the result of a committed proof.
      // Retry returns its original time and never refreshes channel authority.
      if (row.consumed_at) {
        if (
          !session.phone_verified_at ||
          session.phone_verified_at < row.consumed_at ||
          this.now().getTime() - row.consumed_at.getTime() > 15 * 60_000
        )
          throw new IdentityError(
            'FRESH_PHONE_PROOF_REQUIRED',
            'Verify your number again before connecting Messages.',
            403,
          );
        return { verifiedAt: row.consumed_at.toISOString() };
      }
      row = await this.expire(tx, row);
      if (row.status !== 'verified' || row.consumed_at)
        throw new IdentityError(
          'PHONE_PROOF_REQUIRED',
          'Send the prepared message before continuing.',
          403,
        );
      const verifiedAt = this.now();
      await tx
        .updateTable('auth_session')
        .set({ phone_verified_at: verifiedAt })
        .where('id', '=', principal.sessionId)
        .execute();
      await tx
        .updateTable('identity_phone_bindings')
        .set({ verified_at: verifiedAt })
        .where('user_id', '=', principal.userId)
        .where('phone_hash', '=', row.phone_hash)
        .execute();
      await tx
        .updateTable('identity_signup_transactions')
        .set({ status: 'complete', consumed_at: verifiedAt, ...terminalSecrets })
        .where('id', '=', id)
        .execute();
      return { verifiedAt: verifiedAt.toISOString() };
    });
  }

  async rotateRecoveryCodes(principal: AccountPrincipal): Promise<string[]> {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('auth_user')
        .select('id')
        .where('id', '=', principal.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await lockAccount(tx, principal);
      const session = await tx
        .selectFrom('auth_session')
        .select(['assurance_at'])
        .where('id', '=', principal.sessionId)
        .executeTakeFirstOrThrow();
      if (
        !session.assurance_at ||
        this.now().getTime() - session.assurance_at.getTime() > 15 * 60_000
      )
        throw new IdentityError(
          'STEP_UP_REQUIRED',
          'Use your passkey again before changing recovery codes.',
          403,
        );
      const codes = Array.from({ length: 8 }, recoveryCode);
      await tx
        .deleteFrom('identity_recovery_codes')
        .where('user_id', '=', principal.userId)
        .execute();
      await tx
        .insertInto('identity_recovery_codes')
        .values(
          codes.map((code) => ({
            id: randomUUID(),
            user_id: principal.userId,
            code_hash: recoveryDigest(code),
            created_at: this.now(),
            consumed_at: null,
          })),
        )
        .execute();
      return codes;
    });
  }

  private async completionSessionActive(
    tx: Transaction<IdentityDatabase>,
    sessionToken: string,
    mode: string,
  ): Promise<boolean> {
    if (!['signup', 'recovery', 'phone_demo'].includes(mode)) return false;
    const active = await tx
      .selectFrom('auth_session as s')
      .innerJoin('auth_user as u', 'u.id', 's.user_id')
      .select(['s.id', 's.assurance_kind', 'u.phone_demo'])
      .select((eb) =>
        eb
          .exists(eb.selectFrom('auth_passkey').select('id').whereRef('user_id', '=', 'u.id'))
          .as('has_passkey'),
      )
      .where('s.token', '=', sessionToken)
      .where('s.expires_at', '>', this.now())
      .executeTakeFirst();
    return (
      !!active &&
      (mode !== 'phone_demo' ||
        (phoneDemoEnabled() &&
          active.phone_demo &&
          !active.has_passkey &&
          active.assurance_kind === 'phone_demo'))
    );
  }

  private async locked(
    tx: Transaction<IdentityDatabase>,
    token: string,
    id: string,
  ): Promise<SignupRow> {
    const row = await tx
      .selectFrom('identity_signup_transactions')
      .selectAll()
      .where('id', '=', id)
      .where('browser_hash', '=', digest(token))
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new IdentityError('NOT_FOUND', 'This verification could not be found.', 404);
    return row;
  }
  private async expire(db: Kysely<IdentityDatabase>, row: SignupRow): Promise<SignupRow> {
    if (
      row.expires_at <= this.now() &&
      ['creating', 'pending', 'verified', 'complete'].includes(row.status)
    )
      return db
        .updateTable('identity_signup_transactions')
        .set({ status: 'expired', ...terminalSecrets, result_ciphertext: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    return row;
  }
  private dto(row: SignupRow): SignupChallenge {
    let completionMode: SignupChallenge['completionMode'] = null;
    if (row.status === 'complete' && row.purpose === 'signup' && row.result_ciphertext) {
      const result = JSON.parse(this.vault.open(row.result_ciphertext, `${row.id}:result`)) as {
        mode?: unknown;
      };
      if (result.mode === 'signup' || result.mode === 'recovery' || result.mode === 'phone_demo')
        completionMode = result.mode;
    }
    let delivery: SignupChallenge['delivery'] = null;
    if (row.status === 'pending' && row.delivery_ciphertext) {
      const value = JSON.parse(this.vault.open(row.delivery_ciphertext, `${row.id}:delivery`)) as {
        pool_number: string;
        code: string;
      };
      delivery = {
        number: value.pool_number,
        code: value.code,
        smsDeepLink: `sms:${value.pool_number}?body=${encodeURIComponent(value.code)}`,
      };
    }
    return {
      id: row.id,
      purpose: row.purpose,
      completionMode,
      status: row.status,
      maskedPhone: row.masked_phone,
      expiresAt: row.expires_at.toISOString(),
      delivery,
    };
  }
}
