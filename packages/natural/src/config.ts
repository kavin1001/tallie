import { NaturalProviderError } from './errors';

export const NATURAL_SANDBOX_ORIGIN = 'https://api.sandbox.natural.com';
export type NaturalEnvironment = Readonly<Record<string, string | undefined>>;
export interface NaturalProvisioningConfig {
  readonly environment: 'sandbox';
  readonly apiKey: string;
}
export interface NaturalAgentConfig {
  readonly environment: 'sandbox';
  readonly apiKey: string;
  readonly agentId: string;
  readonly platformPartyId: string;
}

function reject(): never {
  throw new NaturalProviderError('configuration', 'not_submitted');
}

export function validateSandboxKey(key: string, role: 'provisioning' | 'agent'): void {
  const prefix = role === 'provisioning' ? 'sk_ntl_sandbox_' : 'ak_ntl_sandbox_';
  if (
    typeof key !== 'string' ||
    !key.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(key.slice(prefix.length))
  )
    reject();
}

function validateEnvironment(env: NaturalEnvironment): void {
  if (env.NATURAL_ENVIRONMENT && env.NATURAL_ENVIRONMENT !== 'sandbox') reject();
  if (env.NATURAL_API_BASE_URL && env.NATURAL_API_BASE_URL !== NATURAL_SANDBOX_ORIGIN) reject();
}

/** Pure configuration parsing; never authenticates, creates resources, or reads process.env. */
export function readProvisioningConfig(env: NaturalEnvironment): NaturalProvisioningConfig {
  validateEnvironment(env);
  if (
    env.NATURAL_PROVISIONING_API_KEY &&
    env.NATURAL_API_KEY &&
    env.NATURAL_PROVISIONING_API_KEY !== env.NATURAL_API_KEY
  )
    reject();
  const apiKey = env.NATURAL_PROVISIONING_API_KEY || env.NATURAL_API_KEY || '';
  validateSandboxKey(apiKey, 'provisioning');
  return { environment: 'sandbox', apiKey };
}

export function readAgentConfig(env: NaturalEnvironment): NaturalAgentConfig {
  validateEnvironment(env);
  const apiKey = env.NATURAL_AGENT_KEY || '';
  validateSandboxKey(apiKey, 'agent');
  const agentId = env.NATURAL_AGENT_ID || '';
  const platformPartyId = env.NATURAL_PLATFORM_PARTY_ID || '';
  if (!/^agt_[0-9a-f]{32}$/.test(agentId) || !/^pty_[0-9a-f]{32}$/.test(platformPartyId)) reject();
  return { environment: 'sandbox', apiKey, agentId, platformPartyId };
}
