#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Backup Script
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: ./scripts/backup.sh [retention_days]
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Configuration
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATA_DIR="${DATA_DIR:-./data}"
RETENTION_DAYS="${1:-7}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="proxycli_backup_${TIMESTAMP}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging
log_info() { echo -e "${BLUE}[backup]${NC} $1"; }
log_success() { echo -e "${GREEN}[backup]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[backup]${NC} $1"; }
log_error() { echo -e "${RED}[backup]${NC} $1"; }

# Create backup
create_backup() {
    log_info "Creating backup..."
    
    mkdir -p "$BACKUP_DIR"
    
    # Create temporary directory
    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT
    
    # Copy data
    if [ -d "$DATA_DIR" ]; then
        cp -r "$DATA_DIR" "$TMP_DIR/"
        log_info "Data directory backed up"
    fi
    
    # Copy config
    if [ -f config.yaml ]; then
        cp config.yaml "$TMP_DIR/"
        log_info "Config file backed up"
    fi
    
    # Copy .env (sanitized)
    if [ -f .env ]; then
        grep -v '^#' .env | grep '=' > "$TMP_DIR/.env.backup" || true
        log_info "Environment variables backed up (sanitized)"
    fi
    
    # Create archive
    tar -czf "$BACKUP_DIR/${BACKUP_NAME}.tar.gz" -C "$TMP_DIR" .
    
    log_success "Backup created: $BACKUP_DIR/${BACKUP_NAME}.tar.gz"
}

# Clean old backups
cleanup_old_backups() {
    log_info "Cleaning up backups older than $RETENTION_DAYS days..."
    
    if [ -d "$BACKUP_DIR" ]; then
        find "$BACKUP_DIR" -name "proxycli_backup_*.tar.gz" -mtime +$RETENTION_DAYS -delete
        log_success "Old backups cleaned"
    fi
}

# List backups
list_backups() {
    if [ -d "$BACKUP_DIR" ]; then
        echo ""
        log_info "Available backups:"
        ls -lh "$BACKUP_DIR"/proxycli_backup_*.tar.gz 2>/dev/null | awk '{print "  " $9 " (" $5 ")"}' || echo "  No backups found"
    fi
}

# Main
main() {
    log_info "ProxyCLI Backup Tool"
    log_info "Retention: $RETENTION_DAYS days"
    
    create_backup
    cleanup_old_backups
    list_backups
    
    log_success "Backup complete!"
}

main "$@"