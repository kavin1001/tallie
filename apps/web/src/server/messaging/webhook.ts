import {
  MessagingError,
  normalizeMessage,
  readBoundedBody,
  verifyMessageWebhook,
} from '@tallie/messaging';
import { messagingIngress } from './configuration';

export function messageWebhook(kind: 'inbound' | 'status') {
  return async (request: Request): Promise<Response> => {
    try {
      const secret = process.env.SENDBLUE_MESSAGE_WEBHOOK_SECRET ?? '';
      if (secret.length < 32) throw new MessagingError('MESSAGING_WEBHOOK_NOT_CONFIGURED', 503);
      if (!verifyMessageWebhook(request.headers.get('sb-signing-secret'), secret))
        throw new MessagingError('WEBHOOK_AUTHENTICATION_FAILED', 401);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
        throw new MessagingError('INVALID_CONTENT_TYPE', 415);
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readBoundedBody(request)).toString('utf8'));
      } catch (error) {
        if (error instanceof MessagingError) throw error;
        throw new MessagingError('INVALID_MESSAGE_JSON');
      }
      const message = normalizeMessage(parsed, process.env.SENDBLUE_FROM_NUMBER ?? '');
      if (message.outbound !== (kind === 'status'))
        throw new MessagingError('WRONG_MESSAGE_DIRECTION');
      const result = await messagingIngress().ingest(message);
      return Response.json(
        { received: true, duplicate: result.duplicate },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      // Never log webhook payloads, provider errors, phone numbers, media URLs,
      // or authentication headers. The durable inbox contains encrypted payloads.
      return Response.json(
        { error: error instanceof MessagingError ? error.code : 'WEBHOOK_STORAGE_UNAVAILABLE' },
        {
          status: error instanceof MessagingError ? error.status : 503,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
  };
}
