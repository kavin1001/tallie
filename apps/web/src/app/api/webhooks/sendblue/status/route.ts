import { messageWebhook } from '@/server/messaging/webhook';

export const runtime = 'nodejs';
export const POST = messageWebhook('status');
