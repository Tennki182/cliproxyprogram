# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# sql.js uses WASM so no native build tools needed at runtime,
# but TypeScript compilation may pull in packages that do.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Install production node_modules (sql.js is pure WASM, no native tools needed)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional

# Copy built assets
COPY --from=builder /app/dist ./dist/
COPY public/ ./public/

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 app \
    && mkdir -p /app/data \
    && chown -R app:nodejs /app

USER app

EXPOSE 8488

# Use Node's built-in fetch (Node 22) — no wget/curl needed
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:8488/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
