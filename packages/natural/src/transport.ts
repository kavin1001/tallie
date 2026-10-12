import { z } from 'zod';
import { NATURAL_SANDBOX_ORIGIN } from './config';
import { NaturalProviderError } from './errors';
import { operationSchema, walletIdSchema, type NaturalOperation } from './contracts';

export interface NaturalClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Internal transport. No arbitrary-request escape hatch is exported by the package. */
class NaturalTransport {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #maxBytes: number;

  constructor(
    private readonly origin: 'https://api.sandbox.natural.com' | 'https://api.natural.com',
    key: string,
    options: NaturalClientOptions,
  ) {
    this.#key = key;
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#maxBytes = options.maxResponseBytes ?? 524_288;
    if (
      !Number.isInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 30_000 ||
      !Number.isInteger(this.#maxBytes) ||
      this.#maxBytes < 128 ||
      this.#maxBytes > 2_097_152
    ) {
      throw new NaturalProviderError('configuration', 'not_submitted');
    }
  }

  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    command?: { attributes: unknown; operation: NaturalOperation },
  ): Promise<T> {
    const controller = new AbortController();
    const uncertain = command ? 'unknown' : 'not_submitted';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new NaturalProviderError('timeout', uncertain));
      }, this.#timeout);
    });
    const execute = async () => {
      const response = await this.#fetch(`${this.origin}${path}`, {
        method: command ? 'POST' : 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#key}`,
          Accept: 'application/json',
          ...(command
            ? {
                'Content-Type': 'application/json',
                'Idempotency-Key': command.operation.idempotencyKey,
                'X-Instance-ID': command.operation.instanceId,
              }
            : {}),
        },
        ...(command ? { body: JSON.stringify({ data: { attributes: command.attributes } }) } : {}),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        throw new NaturalProviderError('invalid_response', uncertain, response.status);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const definitive = [400, 401, 403, 404, 405, 422].includes(response.status);
        throw new NaturalProviderError(
          'http',
          command ? (definitive ? 'rejected' : 'unknown') : 'not_submitted',
          response.status,
        );
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw new NaturalProviderError('invalid_response', uncertain);
      }
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength !== null &&
        /^\d+$/.test(declaredLength) &&
        Number(declaredLength) > this.#maxBytes
      ) {
        void response.body?.cancel().catch(() => {});
        throw new NaturalProviderError('invalid_response', uncertain);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new NaturalProviderError('invalid_response', uncertain);
      const cancelRead = () => {
        void reader.cancel().catch(() => {});
      };
      controller.signal.addEventListener('abort', cancelRead, { once: true });
      if (controller.signal.aborted) cancelRead();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.#maxBytes) {
            void reader.cancel().catch(() => {});
            throw new NaturalProviderError('invalid_response', uncertain);
          }
          chunks.push(value);
        }
      } finally {
        controller.signal.removeEventListener('abort', cancelRead);
        reader.releaseLock();
      }
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        throw new NaturalProviderError('invalid_response', uncertain);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new NaturalProviderError('invalid_response', uncertain);
      return parsed.data;
    };
    try {
      // One attempt only. Retry policy and durable uncertainty belong to the operation service.
      return await Promise.race([execute(), deadline]);
    } catch (error) {
      if (error instanceof NaturalProviderError) throw error;
      throw new NaturalProviderError(timedOut ? 'timeout' : 'transport', uncertain);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Existing synthetic clients remain pinned to sandbox regardless of configuration. */
export class SandboxTransport extends NaturalTransport {
  constructor(key: string, options: NaturalClientOptions) {
    super(NATURAL_SANDBOX_ORIGIN, key, options);
  }
}

/** Production access is restricted to Connect setup and canonical connection reads.
 * This internal transport cannot reach payment, transfer or simulation endpoints.
 */
export class ProductionConnectTransport extends NaturalTransport {
  constructor(key: string, options: NaturalClientOptions) {
    super('https://api.natural.com', key, options);
  }

  override request<T>(
    path: string,
    schema: z.ZodType<T>,
    command?: { attributes: unknown; operation: NaturalOperation },
  ): Promise<T> {
    const allowed = command
      ? path === '/customers/invitations'
      : path === '/parties/me' ||
        /^\/(?:agents\/agt_|customers\/pty_|events\/evt_)[0-9a-f]{32}$/.test(path);
    if (!allowed) throw new NaturalProviderError('invalid_input', 'not_submitted');
    return super.request(path, schema, command);
  }
}

/** A separate agent credential can only read the customer's granted wallets. */
export class ProductionWalletTransport extends NaturalTransport {
  constructor(key: string, options: NaturalClientOptions) {
    super('https://api.natural.com', key, options);
  }

  override request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, 'https://api.natural.com');
    const walletPath = /^\/wallets(?:\/wal_[0-9a-f]{32})?$/.test(url.pathname);
    const parameters = [...url.searchParams.keys()];
    if (
      url.origin !== 'https://api.natural.com' ||
      url.hash ||
      (path !== '/parties/me' &&
        (!walletPath ||
          !/^pty_[0-9a-f]{32}$/.test(url.searchParams.get('customerPartyId') ?? '') ||
          new Set(parameters).size !== parameters.length ||
          parameters.some((name) => name !== 'customerPartyId')))
    )
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    return super.request(path, schema);
  }
}

/** Linked-bank discovery is read-only and always names the connected customer. */
export class ProductionBankTransport extends NaturalTransport {
  constructor(key: string, options: NaturalClientOptions) {
    super('https://api.natural.com', key, options);
  }

  override request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (path === '/parties/me') return super.request(path, schema);
    if (!/^\/external-accounts(?:\/eac_[0-9a-f]{32})?\?/.test(path))
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const url = new URL(path, 'https://api.natural.com');
    const list = url.pathname === '/external-accounts';
    const parameters = [...url.searchParams.keys()];
    const cursor = url.searchParams.get('cursor');
    const limit = url.searchParams.get('limit');
    if (
      url.origin !== 'https://api.natural.com' ||
      url.hash ||
      !/^pty_[0-9a-f]{32}$/.test(url.searchParams.get('customerPartyId') ?? '') ||
      new Set(parameters).size !== parameters.length ||
      parameters.some(
        (name) => name !== 'customerPartyId' && (!list || !['cursor', 'limit'].includes(name)),
      ) ||
      (cursor !== null && (cursor.length < 1 || cursor.length > 1024)) ||
      (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit))
    )
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    return super.request(path, schema);
  }
}

const ownerPilotAttributes = z.strictObject({
  walletId: walletIdSchema,
  amount: z.number().int().min(1).max(100),
  currency: z.literal('USD'),
  counterparty: z.strictObject({
    type: z.literal('handle'),
    value: z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/),
  }),
  description: z.literal('Tallie personal payment test'),
  tags: z.strictObject({
    app_operation_id: operationSchema.shape.instanceId,
    tallie_owner_pilot: z.literal('v1'),
    recipient_handle: z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/),
  }),
});

/** Isolated owner pilot. No customer, funding, withdrawal, cancellation or setup paths. */
export class OwnerPilotTransport extends NaturalTransport {
  constructor(
    key: string,
    private readonly walletId: string,
    options: NaturalClientOptions,
  ) {
    super('https://api.natural.com', key, options);
    if (!walletIdSchema.safeParse(walletId).success)
      throw new NaturalProviderError('configuration', 'not_submitted');
  }

  override request<T>(
    path: string,
    schema: z.ZodType<T>,
    command?: { attributes: unknown; operation: NaturalOperation },
  ): Promise<T> {
    if (command) {
      const body = ownerPilotAttributes.safeParse(command.attributes);
      const operation = operationSchema.safeParse(command.operation);
      if (
        path !== '/payments' ||
        !body.success ||
        !operation.success ||
        body.data.walletId !== this.walletId ||
        body.data.tags.app_operation_id !== operation.data.instanceId ||
        body.data.tags.recipient_handle !== body.data.counterparty.value
      )
        throw new NaturalProviderError('invalid_input', 'not_submitted');
      return super.request(path, schema, {
        attributes: body.data,
        operation: operation.data,
      });
    }
    if (
      path === '/parties/me' ||
      path === `/wallets/${this.walletId}` ||
      /^\/payments\/pay_[0-9a-f]{32}$/.test(path)
    )
      return super.request(path, schema);
    if (!/^\/payments\?/.test(path))
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const url = new URL(path, 'https://api.natural.com');
    const names = [...url.searchParams.keys()];
    const cursor = url.searchParams.get('cursor');
    if (
      url.origin !== 'https://api.natural.com' ||
      url.pathname !== '/payments' ||
      url.hash ||
      url.searchParams.get('limit') !== '100' ||
      names.some((name) => !['limit', 'cursor'].includes(name)) ||
      names.length !== new Set(names).size ||
      (cursor !== null && (cursor.length < 1 || cursor.length > 1024))
    )
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    return super.request(path, schema);
  }
}
