import { notFound } from 'next/navigation';
import { TallieApp } from '@/components/tallie-app';
export const dynamic = 'force-dynamic';
export default function DemoPage() {
  if (process.env.APP_MODE !== 'demo') notFound();
  return <TallieApp />;
}
