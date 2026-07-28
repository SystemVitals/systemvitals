# ============================================================
# api/Dockerfile — build context: REPO ROOT
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
COPY api/package.json api/package-lock.json ./api/
RUN npm --prefix api ci

# Generate Prisma and build only after dependency caches are established.
COPY database/prisma ./database/prisma/
COPY database/prisma.config.ts database/tsconfig.json ./database/
RUN DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy npm --prefix database run generate

COPY database/src ./database/src/
COPY api/src ./api/src/
COPY api/tsconfig.json api/tsconfig.build.json api/nest-cli.json ./api/
RUN npm --prefix api run build
RUN npm --prefix api prune --omit=dev && npm --prefix database prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --shell /bin/sh --create-home appuser

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8888 \
    MIGRATION_RETRY_WINDOW_SECONDS=1800 \
    MIGRATION_RETRY_BASE_SECONDS=2 \
    MIGRATION_RETRY_MAX_SECONDS=30

# Runtime artifacts stay root-owned and read-only to appuser.
COPY --from=builder /build/api/dist ./api/dist/
COPY --from=builder /build/api/package.json ./api/package.json
COPY --from=builder /build/api/node_modules ./api/node_modules/

# Keep the generated client and Prisma CLI required by startup migrations.
COPY --from=builder /build/database/index.js /build/database/index.d.ts ./database/
COPY --from=builder /build/database/prisma ./database/prisma/
COPY --from=builder /build/database/package.json ./database/package.json
COPY --from=builder /build/database/node_modules ./database/node_modules/

COPY --chmod=555 api/docker-entrypoint.sh /app/api/docker-entrypoint.sh
USER appuser

EXPOSE 8888

HEALTHCHECK --interval=10s --timeout=5s --start-period=31m --retries=3 \
  CMD node -e "const p=Number(process.env.PORT||8888);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1);fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/api/docker-entrypoint.sh"]
CMD ["node", "api/dist/main.js"]
