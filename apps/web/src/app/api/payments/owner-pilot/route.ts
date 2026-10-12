import { ownerPilotRoute } from '@/server/payments/owner-pilot-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = ownerPilotRoute('state');
