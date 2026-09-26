import type { z } from 'zod';
import { NATURAL_SANDBOX_ORIGIN } from './config';
import { NaturalProviderError } from './errors';
import type { NaturalOperation } from './contracts';

export interface NaturalClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Internal transport. No arbitrary-request escape hatch is exported by the package. */
export class SandboxTransport {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #maxBytes: number;

  constructor(key: string, options: NaturalClientOptions) {
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
      const response = await this.#fetch(`${NATURAL_SANDBOX_ORIGIN}${path}`, {
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
