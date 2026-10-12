export {
  identityAuth,
  createIdentityAuth,
  identityAvailable,
  signupService,
  requireAccount,
  requireRecentAccount,
  verifiedPhoneFor,
  accountForSession,
  browserTokenFromHeaders,
  SIGNUP_COOKIE,
} from './auth';
export { identityDatabase, createIdentityDatabase, lockAccount } from './database';
export type { IdentityDatabase } from './database';
export {
  normalizePhone,
  normalizedPhoneHash,
  phoneFingerprint,
  identityVault,
  opaqueToken,
  digest,
  recoveryDigest,
} from './crypto';
export { SignupService } from './signup';
export { cookieNames, phoneDemoEnabled } from './config';
export { IdentityError } from './errors';
export type {
  AccountPrincipal,
  IdentityAccount,
  IdentityState,
  SignupChallenge,
} from './contracts';
export {
  listAccountPasskeys,
  removeAccountPasskey,
  cleanupExpiredIdentityProofs,
} from './security';
export type { PasskeySummary } from './security';
