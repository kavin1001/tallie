import { randomUUID } from 'node:crypto';
import {
  PhoneVault,
  SendblueVerify,
  type PhoneVerificationProvider,
  type ProviderVerification,
} from '@tallie/channels';
import type { PhoneChallenge, PhoneVerificationState } from '@tallie/channels/contracts';
import { database, type Database } from '@tallie/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { AppError, notFound } from '../errors';
import { lockSession, type Principal } from '../session';

type ChallengeRow = Selectable<Database['phone_verification_challenges']>;
type Connection = Kysely<Database> | Transaction<Database>;
const terminalSecrets = { phone_ciphertext: null, delivery_ciphertext: null };
const activeStatuses = ['creating', 'pending'] as const;

/** This service records a demo-only phone proof; it never creates an authenticated account. */
export class PhoneProofService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly provider: PhoneVerificationProvider,
    private readonly vault: PhoneVault,
    private readonly serviceSid: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async state(principal: Principal): Promise<PhoneVerificationState> {
    return this.db.transaction().execute(async (tx) => {
      await lockSession(tx, principal);
      const latest = await this.owned(tx, principal)
        .selectAll()
        .orderBy('ordinal', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      return {
        available: true,
        challenge: latest ? this.dto(await this.expire(tx, latest)) : null,
      };
    });
  }

  async create(principal: Principal, phone: string, key: string): Promise<PhoneChallenge> {
    if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone))
      throw new AppError('INVALID_PHONE', 'Enter a US phone number, including +1.');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      throw new AppError('INVALID_RETRY_KEY', 'This action needs a unique retry key.');
    const phoneHash = this.vault.lookup(phone);
    const reservation = await this.db.transaction().execute(async (tx) => {
      await lockSession(tx, principal);
      const existing = await this.owned(tx, principal)
        .selectAll()
        .where('idempotency_key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        if (existing.phone_hash !== phoneHash)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'This retry belongs to a different phone number.',
            409,
          );
        return { fresh: false, row: await this.expire(tx, existing) };
      }
      // A short global lock makes cross-session phone/budget limits atomic. Never hold it across HTTP.
      await sql`select pg_advisory_xact_lock(726512039)`.execute(tx);
      const since = new Date(this.now().getTime() - 15 * 60_000);
      const rate = await tx
        .selectFrom('phone_verification_challenges')
        .select(sql<string>`count(*)`.as('count'))
        .where('created_at', '>', since)
        .where((eb) =>
          eb.or([eb('session_id', '=', principal.sessionId), eb('phone_hash', '=', phoneHash)]),
        )
        .executeTakeFirstOrThrow();
      const globalRate = await tx
        .selectFrom('phone_verification_challenges')
        .select(sql<string>`count(*)`.as('count'))
        .where('created_at', '>', new Date(this.now().getTime() - 60 * 60_000))
        .executeTakeFirstOrThrow();
      if (Number(rate.count) >= 5 || Number(globalRate.count) >= 100)
        throw new AppError(
          'VERIFICATION_RATE_LIMIT',
          'Too many verification attempts. Please try again later.',
          429,
        );
      await tx
        .updateTable('phone_verification_challenges')
        .set({ status: 'canceled', ...terminalSecrets })
        .where('session_id', '=', principal.sessionId)
        .where('status', 'in', activeStatuses)
        .execute();
      // Opportunistically erase expired codes/phone ciphertext, including abandoned sessions.
      await tx
        .updateTable('phone_verification_challenges')
        .set({ status: 'expired', ...terminalSecrets })
        .where('expires_at', '<=', this.now())
        .where('status', 'in', activeStatuses)
        .execute();
      const id = randomUUID();
      const row = await tx
        .insertInto('phone_verification_challenges')
        .values({
          id,
          workspace_id: principal.workspaceId,
          session_id: principal.sessionId,
          person_id: principal.personId,
          idempotency_key: key,
          phone_hash: phoneHash,
          masked_phone: `+1 ••• ••• ${phone.slice(-4)}`,
          phone_ciphertext: this.vault.seal(phone, `${id}:phone`),
          delivery_ciphertext: null,
          service_sid: this.serviceSid,
          verification_sid: null,
          status: 'creating',
          created_at: this.now(),
          expires_at: new Date(this.now().getTime() + 300_000),
          last_checked_at: null,
          verified_at: null,
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
      /* Ambiguous dispatch is never retried automatically. */
    }
    return this.db.transaction().execute(async (tx) => {
      await lockSession(tx, principal);
      let row = await this.locked(tx, principal, reservation.row.id);
      row = await this.expire(tx, row);
      if (row.status !== 'creating') return this.dto(row);
      const valid =
        result &&
        result.service_sid === row.service_sid &&
        result.to === phone &&
        result.status === 'pending' &&
        result.delivery_target &&
        new Date(result.expires_at).getTime() > this.now().getTime();
      if (!valid || !result?.delivery_target) {
        row = await tx
          .updateTable('phone_verification_challenges')
          .set({ status: 'failed', ...terminalSecrets })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .updateTable('phone_verification_challenges')
          .set({
            status: 'pending',
            verification_sid: result.sid,
            expires_at: new Date(
              Math.min(row.expires_at.getTime(), new Date(result.expires_at).getTime()),
            ),
            delivery_ciphertext: this.vault.seal(
              JSON.stringify(result.delivery_target),
              `${row.id}:delivery`,
            ),
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return this.dto(row);
    });
  }

  async check(principal: Principal, id: string): Promise<PhoneChallenge> {
    const reservation = await this.db.transaction().execute(async (tx) => {
      await lockSession(tx, principal);
      const row = await this.expire(tx, await this.locked(tx, principal, id));
      if (
        row.status !== 'pending' ||
        !row.verification_sid ||
        (row.last_checked_at && this.now().getTime() - row.last_checked_at.getTime() < 3_000)
      )
        return { poll: false, row };
      await tx
        .updateTable('phone_verification_challenges')
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
      throw new AppError(
        'VERIFICATION_UNAVAILABLE',
        'We could not check that message yet. Please try again.',
        503,
      );
    }

    return this.db.transaction().execute(async (tx) => {
      await lockSession(tx, principal);
      let row = await this.expire(tx, await this.locked(tx, principal, id));
      if (row.status !== 'pending') return this.dto(row);
      // Terminal lookups can omit `to`. Without the documented authenticated webhook, fail closed.
      const expected = row.phone_ciphertext
        ? this.vault.open(row.phone_ciphertext, `${row.id}:phone`)
        : null;
      const matches =
        expected !== null &&
        result.sid === row.verification_sid &&
        result.service_sid === row.service_sid &&
        result.to === expected;
      const upstreamExpired = new Date(result.expires_at).getTime() <= this.now().getTime();
      let status: ChallengeRow['status'] = 'pending';
      if (!matches) status = 'needs_retry';
      else if (upstreamExpired || result.status === 'expired') status = 'expired';
      else if (result.status === 'canceled') status = 'canceled';
      else if (result.status === 'approved') status = 'verified';
      if (status !== 'pending') {
        if (status === 'verified') {
          await tx
            .insertInto('phone_proof_claims')
            .values({
              challenge_id: row.id,
              workspace_id: row.workspace_id,
              session_id: row.session_id,
              person_id: row.person_id,
              created_at: this.now(),
            })
            .execute();
        }
        row = await tx
          .updateTable('phone_verification_challenges')
          .set({
            status,
            ...terminalSecrets,
            verified_at: status === 'verified' ? this.now() : null,
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return this.dto(row);
    });
  }

  async cancel(principal: Principal, id: string): Promise<PhoneChallenge> {
    return this.db.transaction().execute(async (tx) => {
      await lockSession(tx, principal);
      let row = await this.expire(tx, await this.locked(tx, principal, id));
      if (row.status === 'creating' || row.status === 'pending')
        row = await tx
          .updateTable('phone_verification_challenges')
          .set({ status: 'canceled', ...terminalSecrets })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      return this.dto(row);
    });
  }

  private owned(db: Connection, principal: Principal) {
    return db
      .selectFrom('phone_verification_challenges')
      .where('workspace_id', '=', principal.workspaceId)
      .where('person_id', '=', principal.personId)
      .where('session_id', '=', principal.sessionId);
  }

  private async locked(
    tx: Transaction<Database>,
    principal: Principal,
    id: string,
  ): Promise<ChallengeRow> {
    const row = await this.owned(tx, principal)
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) notFound();
    return row;
  }

  private async expire(tx: Transaction<Database>, row: ChallengeRow): Promise<ChallengeRow> {
    if ((row.status === 'creating' || row.status === 'pending') && row.expires_at <= this.now())
      return tx
        .updateTable('phone_verification_challenges')
        .set({ status: 'expired', ...terminalSecrets })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    return row;
  }

  private dto(row: ChallengeRow): PhoneChallenge {
    let delivery: PhoneChallenge['delivery'] = null;
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
      purpose: 'connect_test',
      status: row.status,
      maskedPhone: row.masked_phone,
      expiresAt: row.expires_at.toISOString(),
      verifiedAt: row.verified_at?.toISOString() ?? null,
      delivery,
    };
  }
}

export function phoneVerificationAvailable(): boolean {
  return (
    process.env.APP_MODE === 'demo' &&
    !!process.env.SENDBLUE_API_KEY_ID &&
    !!process.env.SENDBLUE_API_SECRET_KEY &&
    /^SV[A-Za-z0-9]{20,64}$/.test(process.env.SENDBLUE_VERIFY_SERVICE_SID ?? '') &&
    /^[a-fA-F0-9]{64}$/.test(process.env.SENDBLUE_PHONE_ENCRYPTION_KEY ?? '')
  );
}

export function phoneProofService(): PhoneProofService {
  if (!phoneVerificationAvailable())
    throw new AppError(
      'VERIFICATION_NOT_CONFIGURED',
      'Phone verification is not connected yet.',
      503,
    );
  return new PhoneProofService(
    database(),
    new SendblueVerify({
      keyId: process.env.SENDBLUE_API_KEY_ID!,
      secret: process.env.SENDBLUE_API_SECRET_KEY!,
    }),
    new PhoneVault(process.env.SENDBLUE_PHONE_ENCRYPTION_KEY!),
    process.env.SENDBLUE_VERIFY_SERVICE_SID!,
  );
}
