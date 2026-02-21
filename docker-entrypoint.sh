#!/bin/sh
# Docker Entrypoint Script
# Fixes permissions for mounted volumes before starting the app

set -e

# Fix permissions for data directory
if [ -d "/app/data" ]; then
    echo "[entrypoint] Fixing /app/data permissions..."
    chown -R app:nodejs /app/data
    chmod 755 /app/data
fi

# Fix permissions for config file
if [ -f "/app/config.yaml" ]; then
    echo "[entrypoint] Fixing /app/config.yaml permissions..."
    chown app:nodejs /app/config.yaml
    chmod 644 /app/config.yaml
fi

# Fix permissions for public directory
if [ -d "/app/public" ]; then
    echo "[entrypoint] Fixing /app/public permissions..."
    chown -R app:nodejs /app/public
fi

# Switch to app user and execute the main command
exec su-exec app "$@"
