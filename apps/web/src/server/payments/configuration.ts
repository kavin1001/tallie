import {
  readAgentConfig,
  readProvisioningConfig,
  type NaturalAgentConfig,
  type NaturalEnvironment,
  type NaturalPermission,
  type NaturalProvisioningConfig,
} from '@tallie/natural';
import { AppError } from '../errors';

// The original account remains deliberately read-only. Sending creates a separate
// synthetic customer with its own explicit, payment-capable delegation.
export const SANDBOX_PERMISSIONS = [
  'party.read',
  'wallets.read',
  'wallets.balance',
] as const satisfies readonly NaturalPermission[];
export const SANDBOX_SEND_PERMISSIONS = [
  'party.read',
  'wallets.read',
  'wallets.balance',
  'payments.read',
  'payments.create',
] as const satisfies readonly NaturalPermission[];
export interface SandboxPaymentsConfiguration {
  provisioning: NaturalProvisioningConfig;
  agent: NaturalAgentConfig;
}

/** Pure parsing. Configuration never triggers provider calls or customer creation. */
export function readSandboxPaymentsConfiguration(
  env: NaturalEnvironment = process.env,
): SandboxPaymentsConfiguration | null {
  if (env.NATURAL_SANDBOX_ENABLED !== 'true') return null;
  try {
    if (!['beta', 'demo'].includes(env.APP_MODE ?? '') || env.NATURAL_ENVIRONMENT !== 'sandbox')
      throw new Error('Unsupported environment.');
    return { provisioning: readProvisioningConfig(env), agent: readAgentConfig(env) };
  } catch {
    throw new AppError('SANDBOX_UNAVAILABLE', 'Test accounts are not configured yet.', 503);
  }
}

export function sandboxPaymentsAvailable(env: NaturalEnvironment = process.env): boolean {
  try {
    return readSandboxPaymentsConfiguration(env) !== null;
  } catch {
    return false;
  }
}
