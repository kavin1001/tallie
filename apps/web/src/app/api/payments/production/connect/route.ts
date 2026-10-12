import { productionConnectionRoute } from '@/server/payments/production-connection-http';
export const runtime = 'nodejs';
export const GET = productionConnectionRoute('state');
