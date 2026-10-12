import { identityDatabase } from '@tallie/identity';
import {
  NaturalWebhookError,
  NaturalWebhookInboxService,
  readNaturalWebhookBody,
  validateNaturalWebhookSecret,
  verifyNaturalEvent,
  type NaturalWebhookEnvironment,
  type NaturalWebhookInboxOptions,
  type PaymentDatabase,
} from '@tallie/payments';
import type { Kysely } from 'kysely';

type Environment = Readonly<Record<string, string | undefined>>;
export function naturalWebhookConfiguration(
  environment: string,
  env: Environment = process.env,
): { options: NaturalWebhookInboxOptions; secrets: string[] } {
  if (!['sandbox', 'production'].includes(environment))
    throw new NaturalWebhookError('NOT_FOUND', 404);
  const prefix =
    environment === 'sandbox' ? 'NATURAL_SANDBOX_WEBHOOK_' : 'NATURAL_PRODUCTION_WEBHOOK_';
  if (env[`${prefix}ENABLED`] !== 'true')
    throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
  const secret = env[`${prefix}SECRET`] ?? '';
  const previous = env[`${prefix}PREVIOUS_SECRET`];
  const secrets = previous ? [secret, previous] : [secret];
  secrets.forEach(validateNaturalWebhookSecret);
  const otherPrefix =
    environment === 'sandbox' ? 'NATURAL_PRODUCTION_WEBHOOK_' : 'NATURAL_SANDBOX_WEBHOOK_';
  const otherSecrets = [env[`${otherPrefix}SECRET`], env[`${otherPrefix}PREVIOUS_SECRET`]];
  if (secrets.some((value) => otherSecrets.includes(value)))
    throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
  // Environment-bound identities/secrets cannot fall back to generic credentials.
  // Provisioning this receiver does not enable live payment commands.
  if (environment === 'sandbox' && env.NATURAL_ENVIRONMENT !== 'sandbox')
    throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
  const identityPrefix = environment === 'sandbox' ? 'NATURAL_' : 'NATURAL_PRODUCTION_';
  const options: NaturalWebhookInboxOptions = {
    environment: environment as NaturalWebhookEnvironment,
    platformPartyId: env[`${identityPrefix}PLATFORM_PARTY_ID`] ?? '',
    agentId: env[`${identityPrefix}AGENT_ID`] ?? '',
    encryptionKey: env.IDENTITY_ENCRYPTION_KEY ?? '',
  };
  if (
    !/^pty_[a-f0-9]{32}$/.test(options.platformPartyId) ||
    !/^agt_[a-f0-9]{32}$/.test(options.agentId) ||
    !/^[a-f0-9]{64}$/i.test(options.encryptionKey ?? '')
  )
    throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
  return { options, secrets };
}

export async function naturalWebhook(
  request: Request,
  context: { params: Promise<{ environment: string }> },
): Promise<Response> {
  try {
    const { environment } = await context.params;
    const config = naturalWebhookConfiguration(environment);
    if (
      request.headers.get('content-encoding') &&
      request.headers.get('content-encoding') !== 'identity'
    )
      throw new NaturalWebhookError('INVALID_WEBHOOK_ENCODING', 415);
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new NaturalWebhookError('INVALID_CONTENT_TYPE', 415);
    const verified = verifyNaturalEvent(
      await readNaturalWebhookBody(request),
      request.headers,
      config.secrets,
    );
    const inbox = new NaturalWebhookInboxService(
      identityDatabase() as unknown as Kysely<PaymentDatabase>,
      config.options,
    );
    await inbox.ingest(verified);
    // Await the committed insert/deduplication/quarantine before acknowledging.
    return Response.json({ received: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json(
      { error: error instanceof NaturalWebhookError ? error.code : 'WEBHOOK_STORAGE_UNAVAILABLE' },
      {
        status: error instanceof NaturalWebhookError ? error.status : 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
