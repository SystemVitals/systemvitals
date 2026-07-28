# ============================================================
# frontend/Dockerfile — build context: frontend/ directory
# ============================================================

# ── Builder stage ────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build

# Install dependencies first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build (produces .next/standalone via output: 'standalone')
COPY . .

# Bake NEXT_PUBLIC_* vars into the bundle at build time.
# Next.js inlines these at `next build`; setting them only in compose
# environment: has no effect on the pre-built bundle.
# Every NEXT_PUBLIC_* value passed under a compose `build.args` MUST also be
# declared here. Docker silently discards build args the consuming stage does
# not declare with ARG — it only warns "one or more build-args were not
# consumed" — so a missing line here inlines `undefined` into the bundle with
# no error anywhere.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_GOOGLE_AUTH_ENABLED
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=$NEXT_PUBLIC_GOOGLE_AUTH_ENABLED

RUN npm run build


# ── Runtime stage ────────────────────────────────────────────
FROM node:22-slim AS runtime

# Create non-root user
RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --shell /bin/sh --create-home appuser

WORKDIR /app

# Runtime artifacts stay root-owned and read-only to appuser.
COPY --from=builder /build/.next/standalone ./
COPY --from=builder /build/.next/static ./.next/static
COPY --from=builder /build/public ./public

# Next's incremental/data cache is the only app-owned runtime write location.
RUN install -d -o appuser -g appgroup -m 700 /app/.next/cache

USER appuser

EXPOSE 9999

ENV PORT=9999
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const p=Number(process.env.PORT||9999);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1);fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
