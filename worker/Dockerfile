# ============================================================
# worker/Dockerfile — build context: REPO ROOT
# COPY paths are relative to the repo root.
# ============================================================

# ── Builder stage ────────────────────────────────────────────
FROM node:22-slim AS builder

# Install OpenSSL for Prisma client generation
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install dependency layers before copying application source.
COPY database/package.json database/package-lock.json ./database/
RUN npm --prefix database ci
COPY database/index.js database/index.d.ts ./database/
COPY worker/package.json worker/package-lock.json ./worker/
RUN npm --prefix worker ci

# Generate Prisma and compile the worker after dependency caches are established.
COPY database/prisma ./database/prisma/
COPY database/prisma.config.ts database/tsconfig.json ./database/
RUN DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy npm --prefix database run generate

COPY database/src ./database/src/
COPY worker/src ./worker/src/
COPY worker/cli ./worker/cli/
COPY worker/tsconfig.json worker/tsconfig.build.json ./worker/
RUN npm --prefix worker exec tsc -- --project worker/tsconfig.build.json
RUN npm --prefix worker prune --omit=dev && npm --prefix database prune --omit=dev


# ── Runtime stage ────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --shell /bin/sh --create-home appuser

WORKDIR /app
ENV NODE_ENV=production \
    MIGRATION_RETRY_WINDOW_SECONDS=1800 \
    MIGRATION_RETRY_BASE_SECONDS=2 \
    MIGRATION_RETRY_MAX_SECONDS=30 \
    WORKER_READINESS_PATH=/tmp/systemvitals-worker-ready \
    WORKER_READINESS_HEARTBEAT_INTERVAL_MS=5000 \
    WORKER_READINESS_MAX_AGE_SECONDS=30

# Runtime artifacts stay root-owned and read-only to appuser.
COPY --from=builder /build/worker/dist ./worker/dist/
COPY --from=builder /build/worker/package.json ./worker/package.json
COPY --from=builder /build/worker/node_modules ./worker/node_modules/

# Keep the generated client and Prisma CLI required by startup migrations.
COPY --from=builder /build/database/index.js /build/database/index.d.ts ./database/
COPY --from=builder /build/database/prisma ./database/prisma/
COPY --from=builder /build/database/package.json ./database/package.json
COPY --from=builder /build/database/node_modules ./database/node_modules/

COPY --chmod=555 worker/docker-entrypoint.sh /app/worker/docker-entrypoint.sh
USER appuser

HEALTHCHECK --interval=10s --timeout=5s --start-period=31m --retries=3 \
  CMD node -e "const e=process.env,p=e.WORKER_READINESS_PATH||'/tmp/systemvitals-worker-ready',m=Number(e.WORKER_READINESS_MAX_AGE_SECONDS||30),a=Date.now()-require('node:fs').statSync(p).mtimeMs;process.exit(Number.isFinite(m)&&m>0&&a>=0&&a<=m*1000?0:1)"

ENTRYPOINT ["/app/worker/docker-entrypoint.sh"]
CMD ["node", "/app/worker/dist/cli/worker.js"]
