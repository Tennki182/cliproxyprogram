#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - VPS Deployment Script
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: ./deploy.sh [build|start|stop|restart|logs|update]
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Config
PROJECT_NAME="proxycli"
COMPOSE_FILE="docker-compose.yml"

cd "$(dirname "$0")"

# Helper functions
log_info() { echo -e "${BLUE}[deploy]${NC} $1"; }
log_success() { echo -e "${GREEN}[deploy]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
log_error() { echo -e "${RED}[deploy]${NC} $1"; }

# Check if running on VPS
check_vps() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found! Please install Docker first:"
        log_info "curl -fsSL https://get.docker.com | sh"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "Docker Compose not found! Please install it:"
        log_info "https://docs.docker.com/compose/install/"
        exit 1
    fi
}

# Build the project
build() {
    log_info "Building ${PROJECT_NAME}..."
    
    # Use docker compose or docker-compose
    if docker compose version &> /dev/null; then
        docker compose -f ${COMPOSE_FILE} build --no-cache
    else
        docker-compose -f ${COMPOSE_FILE} build --no-cache
    fi
    
    log_success "Build completed!"
}

# Start the service
start() {
    log_info "Starting ${PROJECT_NAME}..."
    
    # Create data directory if not exists
    mkdir -p data certs
    
    # Copy config if not exists
    if [ ! -f "config.yaml" ]; then
        if [ -f "config.yaml.example" ]; then
            cp config.yaml.example config.yaml
            log_warn "Created config.yaml from example. Please edit it before using!"
        fi
    fi
    
    # Start services
    if docker compose version &> /dev/null; then
        docker compose -f ${COMPOSE_FILE} up -d
    else
        docker-compose -f ${COMPOSE_FILE} up -d
    fi
    
    log_success "${PROJECT_NAME} started!"
    log_info "Access the web UI at: http://$(hostname -I | awk '{print $1}'):8488"
    
    sleep 2
    show_status
}

# Stop the service
stop() {
    log_info "Stopping ${PROJECT_NAME}..."
    
    if docker compose version &> /dev/null; then
        docker compose -f ${COMPOSE_FILE} down
    else
        docker-compose -f ${COMPOSE_FILE} down
    fi
    
    log_success "${PROJECT_NAME} stopped!"
}

# Restart the service
restart() {
    log_info "Restarting ${PROJECT_NAME}..."
    stop
    start
}

# Show logs
logs() {
    if docker compose version &> /dev/null; then
        docker compose -f ${COMPOSE_FILE} logs -f --tail=100
    else
        docker-compose -f ${COMPOSE_FILE} logs -f --tail=100
    fi
}

# Update from git and rebuild
update() {
    log_info "Updating from git..."
    
    # Pull latest code
    git pull origin main
    
    # Rebuild and restart
    build
    restart
    
    log_success "Update completed!"
}

# Show status
show_status() {
    if docker compose version &> /dev/null; then
        docker compose -f ${COMPOSE_FILE} ps
    else
        docker-compose -f ${COMPOSE_FILE} ps
    fi
}

# Show help
usage() {
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  build    - Build the Docker image"
    echo "  start    - Start the service"
    echo "  stop     - Stop the service"
    echo "  restart  - Restart the service"
    echo "  logs     - Show logs"
    echo "  update   - Pull latest code and restart"
    echo "  status   - Show container status"
    echo ""
    echo "Examples:"
    echo "  $0 start     # First time deployment"
    echo "  $0 update    # Update to latest version"
}

# Main
case "${1:-start}" in
    build)
        check_vps
        build
        ;;
    start)
        check_vps
        start
        ;;
    stop)
        stop
        ;;
    restart)
        check_vps
        restart
        ;;
    logs)
        logs
        ;;
    update)
        check_vps
        update
        ;;
    status)
        show_status
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        log_error "Unknown command: $1"
        usage
        exit 1
        ;;
esac
