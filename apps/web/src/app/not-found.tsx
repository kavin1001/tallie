import Link from 'next/link';
import { Flower, Wordmark } from '@/components/brand';
export default function NotFound() {
  return (
    <main className="loading-screen">
      <Wordmark />
      <div className="empty-state">
        <Flower />
        <h1>A little off the beaten path.</h1>
        <p>This page isn’t here. Your people are just a moment away.</p>
      </div>
      <Link className="ui-button ui-button--primary" href="/">
        Back to Tallie
      </Link>
    </main>
  );
}
