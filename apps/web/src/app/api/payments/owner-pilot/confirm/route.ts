import { ownerPilotRoute } from '@/server/payments/owner-pilot-http';
export const runtime = 'nodejs';
export const POST = ownerPilotRoute('confirm');
