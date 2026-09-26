import { reviewSend } from '@/server/commands';
import { jsonResponse, principalFor, readJson, route } from '@/server/http';
import { sendReviewSchema } from '@/server/validation';

export const runtime = 'nodejs';
export const POST = route(async (request) => {
  const principal = await principalFor(request);
  const input = await readJson(request, sendReviewSchema);
  return jsonResponse(await reviewSend(principal, input), 201);
});
