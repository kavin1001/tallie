import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: [
    '@tallie/domain',
    '@tallie/db',
    '@tallie/receipts',
    '@tallie/channels',
    '@tallie/identity',
    '@tallie/social',
    '@tallie/messaging',
    '@tallie/app-services',
    '@tallie/natural',
    '@tallie/payments',
  ],
  poweredByHeader: false,
  devIndicators: false,
  // Runtime secrets and uploaded photos are never build/deployment assets.
  outputFileTracingExcludes: { '/*': ['.env*', '../../.env*', '../../.tallie/**/*'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
