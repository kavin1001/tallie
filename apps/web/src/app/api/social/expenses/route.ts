import { expenseInput } from '@tallie/social';
import { requireAccount } from '@/server/identity';
import { idempotencyKey, jsonResponse, readJson } from '@/server/http';
import { socialRoute } from '@/server/social/http';
import { socialService } from '@/server/social/service';
export const runtime = 'nodejs';
export const POST = socialRoute(async (request) =>
  jsonResponse(
    await socialService().createExpense(
      await requireAccount(request),
      await readJson(request, expenseInput),
      idempotencyKey(request),
    ),
    201,
  ),
);
