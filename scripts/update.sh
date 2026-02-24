#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Update Script
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: ./scripts/update.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging
log_info() { echo -e "${BLUE}[update]${NC} $1"; }
log_success() { echo -e "${GREEN}[update]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[update]${NC} $1"; }
log_error() { echo -e "${RED}[update]${NC} $1"; }

# Check if running in correct directory
check_directory() {
    if [ ! -f docker-compose.yml ]; then
        log_error "docker-compose.yml not found!"
        log_info "Please run this script from the ProxyCLI installation directory"
        exit 1
    fi
}

# Backup before update
backup_before_update() {
    log_info "Creating pre-update backup..."
    if [ -f scripts/backup.sh ]; then
        ./scripts/backup.sh
    else
        log_warn "Backup script not found, skipping backup"
    fi
}

# Pull latest images
pull_images() {
    log_info "Pulling latest images..."
    docker compose pull
    log_success "Images updated"
}

# Restart services
restart_services() {
    log_info "Restarting services..."
    docker compose up -d --remove-orphans
    log_success "Services restarted"
}

# Cleanup old images
cleanup_images() {
    log_info "Cleaning up old images..."
    docker image prune -f
    log_success "Cleanup complete"
}

# Check health
check_health() {
    log_info "Checking service health..."
    
    PORT=$(grep PROXYCLI_PORT .env 2>/dev/null | cut -d= -f2 || echo 8488)
    MAX_RETRIES=30
    RETRY_COUNT=0
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if curl -fsSL "http://localhost:$PORT/health" > /dev/null 2>&1; then
            log_success "Service is healthy!"
            return 0
        fi
        
        RETRY_COUNT=$((RETRY_COUNT + 1))
        sleep 1
    done
    
    log_warn "Health check timeout, but service may still be starting"
    log_info "Check logs with: docker compose logs -f"
}

# Main
main() {
    echo -e "${GREEN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                   ProxyCLI Updater                           ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    check_directory
    backup_before_update
    pull_images
    restart_services
    cleanup_images
    check_health
    
    log_success "Update complete!"
    echo ""
    log_info "View logs: docker compose logs -f"
}

main "$@"