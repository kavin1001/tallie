import { identityDatabase } from '@tallie/identity';
import {
  SandboxSendConnectionService,
  SandboxSendService,
  type PaymentDatabase,
} from '@tallie/payments';
import type { Kysely } from 'kysely';
import { AppError } from '../errors';
import { readSandboxPaymentsConfiguration, SANDBOX_SEND_PERMISSIONS } from './configuration';
import { createSandboxGateway } from './gateway';
import { createSandboxSendGateway } from './send-gateway';

function configured() {
  const config = readSandboxPaymentsConfiguration();
  if (!config) throw new AppError('SANDBOX_UNAVAILABLE', 'Test payments are unavailable.', 503);
  return config;
}

export function sandboxSendConnectionService() {
  const config = configured();
  return new SandboxSendConnectionService(
    identityDatabase() as unknown as Kysely<PaymentDatabase>,
    createSandboxGateway(config, undefined, 'send'),
    {
      enabled: true,
      environment: 'sandbox',
      platformPartyId: config.agent.platformPartyId,
      agentId: config.agent.agentId,
      permissions: SANDBOX_SEND_PERMISSIONS,
    },
  );
}

export function sandboxSendService() {
  const config = configured();
  return new SandboxSendService(
    identityDatabase() as unknown as Kysely<PaymentDatabase>,
    createSandboxSendGateway(config),
    config.agent.agentId,
    config.agent.platformPartyId,
  );
}
