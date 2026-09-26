import { sandboxRoute } from '@/server/payments/http';
export const runtime = 'nodejs';
export const GET = sandboxRoute('state');
