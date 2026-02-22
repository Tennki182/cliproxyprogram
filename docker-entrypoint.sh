#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Docker Entrypoint Script
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors for output (only if terminal supports it)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# Logging functions
log_info() { echo "${BLUE}[entrypoint]${NC} $1"; }
log_success() { echo "${GREEN}[entrypoint]${NC} $1"; }
log_warn() { echo "${YELLOW}[entrypoint]${NC} WARNING: $1"; }
log_error() { echo "${RED}[entrypoint]${NC} ERROR: $1"; }

# ═══════════════════════════════════════════════════════════════════════════════
# Initialization
# ═══════════════════════════════════════════════════════════════════════════════

log_info "Initializing ProxyCLI container..."

# Check if running as root (needed for permission fixes)
if [ "$(id -u)" -ne 0 ]; then
    log_warn "Not running as root, skipping permission fixes"
    exec "$@"
fi

# ── Fix permissions for data directory ────────────────────────────────────────
if [ -d "/app/data" ]; then
    log_info "Setting up /app/data permissions..."
    chown -R app:nodejs /app/data
    chmod 755 /app/data
    log_success "/app/data ready"
else
    log_info "Creating /app/data directory..."
    mkdir -p /app/data
    chown -R app:nodejs /app/data
    chmod 755 /app/data
    log_success "/app/data created"
fi

# ── Fix permissions for config file ───────────────────────────────────────────
if [ -f "/app/config.yaml" ]; then
    log_info "Checking /app/config.yaml..."
    # Config should be readable by app user
    if [ -r "/app/config.yaml" ]; then
        log_success "/app/config.yaml is readable"
    else
        log_warn "/app/config.yaml is not readable, fixing permissions..."
        chmod 644 /app/config.yaml
    fi
else
    log_warn "/app/config.yaml not found! Application may fail to start."
    log_info "Please create a config.yaml file and mount it to /app/config.yaml"
fi

# ── Fix permissions for public directory ──────────────────────────────────────
if [ -d "/app/public" ]; then
    log_info "Setting up /app/public permissions..."
    chown -R app:nodejs /app/public
    log_success "/app/public ready"
fi

# ── Check SSL certificates if TLS is enabled ──────────────────────────────────
if [ -f "/app/config.yaml" ]; then
    if grep -q "tls:" "/app/config.yaml" 2>/dev/null && grep -q "enabled: true" "/app/config.yaml" 2>/dev/null; then
        log_info "TLS appears to be enabled in config"
        
        # Try to extract cert and key paths from config
        CERT_PATH=$(grep -A 5 "tls:" "/app/config.yaml" | grep "cert:" | sed 's/.*cert: *//' | tr -d ' "')
        KEY_PATH=$(grep -A 5 "tls:" "/app/config.yaml" | grep "key:" | grep -v "secret" | sed 's/.*key: *//' | tr -d ' "')
        
        if [ -n "$CERT_PATH" ] && [ -n "$KEY_PATH" ]; then
            if [ -f "$CERT_PATH" ] && [ -f "$KEY_PATH" ]; then
                log_success "SSL certificates found"
                # Make sure app user can read them
                chmod 644 "$CERT_PATH"
                chmod 600 "$KEY_PATH"
            else
                log_warn "SSL certificate files not found at:"
                log_warn "  Cert: $CERT_PATH"
                log_warn "  Key: $KEY_PATH"
            fi
        fi
    fi
fi

# ── Print runtime info ────────────────────────────────────────────────────────
log_info "Runtime information:"
log_info "  Node version: $(node --version)"
log_info "  NPM version: $(npm --version)"
log_info "  User: $(id app)"

# ── Check health endpoint is accessible ───────────────────────────────────────
log_info "Starting application..."

# ═══════════════════════════════════════════════════════════════════════════════
# Execute main command
# ═══════════════════════════════════════════════════════════════════════════════

# Switch to app user and execute
exec gosu app "$@"
