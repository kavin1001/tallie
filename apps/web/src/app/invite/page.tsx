import { AccountApp } from '@/components/account-app';
import { messagingConfigured } from '@tallie/messaging';
export const dynamic = 'force-dynamic';
export default function InvitationPage() {
  return <AccountApp invitationEntry messagingAvailable={messagingConfigured()} />;
}
