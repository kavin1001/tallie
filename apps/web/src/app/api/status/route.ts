import { sql } from 'kysely';
import { identityDatabase } from '@tallie/identity';
import { ownerPilotAvailable } from '@/server/payments/owner-pilot';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await sql`SELECT 1 FROM auth_user LIMIT 0`.execute(identityDatabase());
    const ownerPilot = ownerPilotAvailable();
    return Response.json(
      {
        status: 'ready',
        paymentsEnabled: ownerPilot,
        ...(ownerPilot ? { paymentsScope: 'local-owner-pilot' } : {}),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
