FROM node:22-slim AS base

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libc-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-slim AS production

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 app

# Copy built files
COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json
COPY --from=base /app/config.yaml ./

# Create data directory
RUN mkdir -p /app/data

# Change ownership
RUN chown -R app:nodejs /app

USER app

EXPOSE 3000

CMD ["node", "dist/index.js"]
