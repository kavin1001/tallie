import { identityDatabase } from '@tallie/identity';
import { SandboxOnboardingService, type PaymentDatabase } from '@tallie/payments';
import type { Kysely } from 'kysely';
import { AppError } from '../errors';
import { readSandboxPaymentsConfiguration, SANDBOX_PERMISSIONS } from './configuration';
import { createSandboxGateway } from './gateway';

export function sandboxPaymentsService(): SandboxOnboardingService {
  const config = readSandboxPaymentsConfiguration();
  if (!config) throw new AppError('SANDBOX_UNAVAILABLE', 'Test accounts are unavailable.', 503);
  return new SandboxOnboardingService(
    identityDatabase() as unknown as Kysely<PaymentDatabase>,
    createSandboxGateway(config),
    {
      enabled: true,
      environment: 'sandbox',
      platformPartyId: config.agent.platformPartyId,
      agentId: config.agent.agentId,
      permissions: SANDBOX_PERMISSIONS,
    },
  );
}
