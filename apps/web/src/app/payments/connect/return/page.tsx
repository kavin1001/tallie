import type { Metadata } from 'next';
import { AccountApp } from '@/components/account-app';
import { productionConnectionAvailable } from '@/server/payments/production-connection';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Your payment setup · Tallie',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

/** The state is navigation context, never provider evidence or an authorization grant. */
export default async function PaymentReturn({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const { state } = await searchParams;
  const valid = typeof state === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(state);
  return (
    <AccountApp
      productionConnectionAvailable={productionConnectionAvailable()}
      {...(valid ? { paymentReturnState: state } : {})}
    />
  );
}
