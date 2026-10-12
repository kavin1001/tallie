/** Cookies are shared across localhost ports, so the isolated money pilot needs its own names. */
export function cookieNames(origin: string | undefined) {
  const ownerPilot = origin === 'http://localhost:3004';
  const prefix = ownerPilot ? 'tallie_owner_pilot_identity' : 'tallie_identity';
  return {
    signup: ownerPilot ? 'tallie_owner_pilot_signup' : 'tallie_signup',
    prefix,
    passkeyChallenge: `${prefix}.passkey_challenge`,
  };
}

/** Temporary preview capability; no single environment flag can weaken normal auth. */
export function phoneDemoEnabled(): boolean {
  return (
    process.env.IDENTITY_PHONE_DEMO_ENABLED === 'true' &&
    process.env.APP_PREVIEW_MODE === 'true' &&
    process.env.APP_MODE === 'beta'
  );
}
