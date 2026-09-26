import { z } from 'zod';

const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
const serviceSid = z.string().regex(/^SV[A-Za-z0-9]{20,64}$/);
const verificationSid = z.string().regex(/^VR[A-Za-z0-9]{20,64}$/);
const verificationSchema = z.object({
  sid: verificationSid,
  service_sid: serviceSid,
  to: phone.nullable(),
  status: z.enum(['pending', 'approved', 'expired', 'canceled']),
  expires_at: z.iso.datetime({ offset: true }),
  delivery_target: z
    .object({
      pool_number: phone,
      code: z.string().regex(/^[A-Z0-9]{4,8}$/),
    })
    .optional(),
});

export type ProviderVerification = z.infer<typeof verificationSchema>;

export interface PhoneVerificationProvider {
  create(service: string, phone: string): Promise<ProviderVerification>;
  retrieve(service: string, verification: string): Promise<ProviderVerification>;
}

/** Never includes provider bodies, URLs with tokens, phone numbers, or credentials. */
export class ChannelProviderError extends Error {
  constructor(public readonly reason: 'unavailable' | 'invalid_response') {
    super('Phone verification is temporarily unavailable.');
    this.name = 'ChannelProviderError';
  }
}

export class SendblueVerify implements PhoneVerificationProvider {
  constructor(
    private readonly credentials: { keyId: string; secret: string },
    private readonly transport: typeof fetch = fetch,
  ) {}

  async create(service: string, expectedPhone: string): Promise<ProviderVerification> {
    serviceSid.parse(service);
    phone.parse(expectedPhone);
    return this.request(`/services/${service}/verifications`, { to: expectedPhone });
  }

  async retrieve(service: string, verification: string): Promise<ProviderVerification> {
    serviceSid.parse(service);
    verificationSid.parse(verification);
    return this.request(`/services/${service}/verifications/${verification}`);
  }

  private async request(path: string, body?: { to: string }): Promise<ProviderVerification> {
    try {
      const response = await this.transport(`https://api.sendblue.com/api/v2/verify${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          'sb-api-key-id': this.credentials.keyId,
          'sb-api-secret-key': this.credentials.secret,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new ChannelProviderError('unavailable');
      // Bound even a malformed upstream response before parsing it.
      const reader = response.body?.getReader();
      if (!reader) throw new ChannelProviderError('invalid_response');
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 32_768) {
          await reader.cancel();
          throw new ChannelProviderError('invalid_response');
        }
        chunks.push(value);
      }
      const parsed = verificationSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!parsed.success) throw new ChannelProviderError('invalid_response');
      return parsed.data;
    } catch (error) {
      if (error instanceof ChannelProviderError) throw error;
      throw new ChannelProviderError('unavailable');
    }
  }
}
