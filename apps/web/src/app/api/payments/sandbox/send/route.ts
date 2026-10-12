import { sandboxSendRoute } from '@/server/payments/send-http';
export const runtime = 'nodejs';
export const GET = sandboxSendRoute('state');
