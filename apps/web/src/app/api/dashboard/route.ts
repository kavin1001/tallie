import { jsonResponse, principalFor, route } from '@/server/http';
import { getDashboard } from '@/server/queries';

export const runtime = 'nodejs';
export const GET = route(async (request) =>
  jsonResponse(await getDashboard(await principalFor(request))),
);
