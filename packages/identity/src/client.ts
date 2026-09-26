import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';

export const identityClient = createAuthClient({
  basePath: '/api/identity/auth',
  plugins: [passkeyClient()],
});
