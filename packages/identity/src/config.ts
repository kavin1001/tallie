/** Temporary preview capability; no single environment flag can weaken normal auth. */
export function phoneDemoEnabled(): boolean {
  return (
    process.env.IDENTITY_PHONE_DEMO_ENABLED === 'true' &&
    process.env.APP_PREVIEW_MODE === 'true' &&
    process.env.APP_MODE === 'beta'
  );
}
