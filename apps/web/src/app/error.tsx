'use client';
import { Flower, Wordmark } from '@/components/brand';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="loading-screen">
      <Wordmark />
      <div className="empty-state">
        <Flower />
        <h1>A little hiccup.</h1>
        <p>
          Tallie couldn’t finish loading. Your approved payments keep their status; retrying this
          page won’t approve another payment.
        </p>
      </div>
      <button className="ui-button ui-button--primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
