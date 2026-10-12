import { AccountApp } from '@/components/account-app';
import { messagingConfigured } from '@tallie/messaging';
import { sandboxPaymentsAvailable } from '@/server/payments/configuration';
import { productionConnectionAvailable } from '@/server/payments/production-connection';
import { ownerPilotAvailable } from '@/server/payments/owner-pilot';
export const dynamic = 'force-dynamic';
export default function HomePage() {
  return (
    <AccountApp
      demoAvailable={process.env.APP_MODE === 'demo'}
      messagingAvailable={messagingConfigured()}
      sandboxPaymentsAvailable={sandboxPaymentsAvailable()}
      productionConnectionAvailable={productionConnectionAvailable()}
      ownerPilotAvailable={ownerPilotAvailable()}
    />
  );
}
