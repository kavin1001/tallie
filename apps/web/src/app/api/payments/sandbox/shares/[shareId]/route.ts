import { sandboxShareRoute } from '@/server/payments/share-http';
export const runtime = 'nodejs';
export const GET = sandboxShareRoute('state');
