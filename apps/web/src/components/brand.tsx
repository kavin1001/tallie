export function Flower({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
      <ellipse cx="32" cy="20" rx="10" ry="18" />
      <ellipse cx="32" cy="44" rx="10" ry="18" />
      <ellipse cx="20" cy="32" rx="18" ry="10" />
      <ellipse cx="44" cy="32" rx="18" ry="10" />
      <circle cx="32" cy="32" r="5" fill="var(--flower-center, #f7f7f2)" />
    </svg>
  );
}
export function Wordmark() {
  return (
    <span className="wordmark">
      <Flower />
      tallie
      <span className="wordmark-dot" aria-hidden="true">
        .
      </span>
    </span>
  );
}
export function ReceiptArt() {
  return (
    <div className="receipt-art" aria-hidden="true">
      <div className="art-orbit orbit-one" />
      <div className="art-orbit orbit-two" />
      <span className="art-star">✳</span>
      <span className="art-sparkle">✧</span>
      <div className="paper-receipt">
        <span className="receipt-kicker">THE GOOD COMPANY</span>
        <span className="receipt-restaurant">A table for three.</span>
        <div className="receipt-rule" />
        <span className="paper-line">
          <span>Something delicious</span>
          <b>60.00</b>
        </span>
        <span className="paper-line">
          <span>A little wine</span>
          <b>30.00</b>
        </span>
        <span className="paper-line">
          <span>Tax & a thank-you</span>
          <b>27.00</b>
        </span>
        <div className="receipt-rule" />
        <span className="paper-total">
          <span>Good times</span>
          <b>$117.00</b>
        </span>
        <span className="receipt-bottom">MEMORIES: PRICELESS</span>
      </div>
      <div className="art-payment">
        <span className="art-check">✓</span>
        <span>
          All square.<small>Back to the good stuff.</small>
        </span>
        <Flower />
      </div>
      <div className="art-mini-avatar avatar-one">M</div>
      <div className="art-mini-avatar avatar-two">L</div>
    </div>
  );
}
