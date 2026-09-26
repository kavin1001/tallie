import { z } from 'zod';
import { idempotencyKey, jsonResponse, principalFor, readJson, route } from '@/server/http';
import { phoneProofService, phoneVerificationAvailable } from '@/server/phone-verification/service';

export const runtime = 'nodejs';
const createSchema = z.object({ phone: z.string().trim().max(16) }).strict();

export const GET = route(async (request) => {
  const principal = await principalFor(request);
  return jsonResponse(
    phoneVerificationAvailable()
      ? await phoneProofService().state(principal)
      : { available: false, challenge: null },
  );
});

export const POST = route(async (request) => {
  const principal = await principalFor(request);
  const input = await readJson(request, createSchema);
  return jsonResponse(
    await phoneProofService().create(principal, input.phone, idempotencyKey(request)),
    201,
  );
});
