import { AccountApp } from '@/components/account-app';
export const dynamic = 'force-dynamic';
export default function HomePage() {
  return <AccountApp demoAvailable={process.env.APP_MODE === 'demo'} />;
}
