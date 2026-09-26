import { createHash, randomBytes } from 'node:crypto';
import { PhoneVault } from '@tallie/channels';
import { IdentityError } from './errors';
export function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[ ()-]/g, '');
  const normalized = /^\d{10}$/.test(cleaned) ? `+1${cleaned}` : cleaned;
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(normalized))
    throw new IdentityError('INVALID_PHONE', 'Enter a valid US mobile number.');
  return normalized;
}
export function identityVault(): PhoneVault {
  return new PhoneVault(process.env.IDENTITY_ENCRYPTION_KEY ?? '');
}
export function normalizedPhoneHash(phone: string): string {
  return identityVault().lookup(normalizePhone(phone));
}
export const phoneFingerprint = normalizedPhoneHash;
export function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function recoveryCode(): string {
  return randomBytes(16).toString('hex').match(/.{4}/g)!.join('-').toUpperCase();
}
export function recoveryDigest(value: string): string {
  return digest(`tallie-recovery-v1:${value.replace(/[-\s]/g, '').toLowerCase()}`);
}
