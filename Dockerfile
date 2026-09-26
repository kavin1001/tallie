# syntax=docker/dockerfile:1
# Node 24 / Debian bookworm, resolved September 26, 2026. Update by reviewed digest.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Keep dependency installation cached independently of application source.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/messaging-worker/package.json ./apps/messaging-worker/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/channels/package.json ./packages/channels/package.json
COPY packages/receipts/package.json ./packages/receipts/package.json
COPY packages/identity/package.json ./packages/identity/package.json
COPY packages/social/package.json ./packages/social/package.json
COPY packages/messaging/package.json ./packages/messaging/package.json
COPY packages/app-services/package.json ./packages/app-services/package.json
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
# Provider credentials, a database, and private receipts are not build inputs.
RUN npm run build

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP_HOST=0.0.0.0
# Workers and the migration runner execute TypeScript with tsx. Retain the locked
# tooling dependencies until workers have their own compiled deployment bundles.
COPY --chown=node:node --from=build /app /app
USER node
EXPOSE 3000
CMD ["node", "scripts/run-service.mjs", "web-start"]
