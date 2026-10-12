import { sandboxSendRoute } from '@/server/payments/send-http';
export const runtime = 'nodejs';
export const POST = sandboxSendRoute('fund');
