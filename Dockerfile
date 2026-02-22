# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Multi-stage Docker Build
# ═══════════════════════════════════════════════════════════════════════════════

# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (use cache mount for faster rebuilds)
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ── Stage 2: Builder ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install build tools (needed for some native deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY package.json tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ── Stage 3: Production ───────────────────────────────────────────────────────
FROM node:22-slim AS production

# Metadata
LABEL org.opencontainers.image.title="ProxyCLI"
LABEL org.opencontainers.image.description="Multi-provider AI reverse proxy with OpenAI-compatible API"
LABEL org.opencontainers.image.source="https://github.com/yourusername/proxycli"

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 app \
    && adduser app nodejs

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --chown=app:nodejs public/ ./public/

# Copy entrypoint
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/

# Create data directory with correct permissions
RUN mkdir -p /app/data \
    && chown -R app:nodejs /app/data \
    && chmod 755 /app/data

# Switch to non-root user
USER app

# Expose port
EXPOSE 8488

# Health check using Node's built-in fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8488/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]

# ── Stage 4: Development (optional) ───────────────────────────────────────────
FROM builder AS development

WORKDIR /app

# Copy public files
COPY public/ ./public/

EXPOSE 8488

CMD ["npm", "run", "dev"]
