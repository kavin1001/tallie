import { AccountApp } from '@/components/account-app';
import { messagingConfigured } from '@tallie/messaging';
export const dynamic = 'force-dynamic';
export default function HomePage() {
  return (
    <AccountApp
      demoAvailable={process.env.APP_MODE === 'demo'}
      messagingAvailable={messagingConfigured()}
    />
  );
}
