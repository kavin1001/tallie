import { createExpense } from '@/server/commands';
import { idempotencyKey, jsonResponse, principalFor, readJson, route } from '@/server/http';
import { createExpenseSchema } from '@/server/validation';

export const runtime = 'nodejs';
export const POST = route(async (request) => {
  const principal = await principalFor(request);
  const input = await readJson(request, createExpenseSchema);
  return jsonResponse(await createExpense(principal, input, idempotencyKey(request)), 201);
});
