#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Installation Script
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: curl -fsSL https://raw.githubusercontent.com/yourusername/proxycli/main/scripts/install.sh | bash
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="${INSTALL_DIR:-$HOME/proxycli}"
VERSION="${VERSION:-latest}"
GITHUB_REPO="Tennki182/cliproxyprogram"

# Logging
log_info() { echo -e "${BLUE}[install]${NC} $1"; }
log_success() { echo -e "${GREEN}[install]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[install]${NC} $1"; }
log_error() { echo -e "${RED}[install]${NC} $1"; }

# Check dependencies
check_dependencies() {
    log_info "Checking dependencies..."
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        log_warn "Docker Compose not found, trying docker compose..."
        if ! docker compose version &> /dev/null; then
            log_error "Docker Compose is not installed."
            exit 1
        fi
    fi
    
    log_success "Dependencies OK"
}

# Download release
download_release() {
    log_info "Downloading ProxyCLI..."
    
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    
    # Download docker-compose.yml
    curl -fsSL "https://raw.githubusercontent.com/$GITHUB_REPO/main/docker-compose.yml" -o docker-compose.yml
    curl -fsSL "https://raw.githubusercontent.com/$GITHUB_REPO/main/.env.example" -o .env.example
    curl -fsSL "https://raw.githubusercontent.com/$GITHUB_REPO/main/docker-entrypoint.sh" -o docker-entrypoint.sh
    chmod +x docker-entrypoint.sh
    
    # Create default config
    if [ ! -f config.yaml ]; then
        curl -fsSL "https://raw.githubusercontent.com/$GITHUB_REPO/main/config.yaml.example" -o config.yaml.example
        log_warn "Please edit config.yaml before starting the service"
    fi
    
    # Create .env from example
    if [ ! -f .env ]; then
        cp .env.example .env
        log_warn "Created .env file, please review and modify as needed"
    fi
    
    log_success "Downloaded to $INSTALL_DIR"
}

# Setup directories
setup_directories() {
    log_info "Setting up directories..."
    
    mkdir -p "$INSTALL_DIR/data"
    mkdir -p "$INSTALL_DIR/certs"
    mkdir -p "$INSTALL_DIR/backups"
    
    log_success "Directories created"
}

# Start service
start_service() {
    log_info "Starting ProxyCLI..."
    
    cd "$INSTALL_DIR"
    
    if [ -f config.yaml ]; then
        docker compose up -d
        log_success "ProxyCLI started!"
        log_info "Access: http://localhost:$(grep PROXYCLI_PORT .env 2>/dev/null | cut -d= -f2 || echo 8488)"
    else
        log_warn "config.yaml not found, skipping start"
        log_info "Please create config.yaml and run: cd $INSTALL_DIR && docker compose up -d"
    fi
}

# Print usage
print_usage() {
    echo ""
    log_success "Installation complete!"
    echo ""
    echo "Quick start:"
    echo "  cd $INSTALL_DIR"
    echo "  # Edit config.yaml"
    echo "  docker compose up -d"
    echo ""
    echo "Management commands:"
    echo "  docker compose logs -f    # View logs"
    echo "  docker compose down       # Stop service"
    echo "  docker compose pull       # Update image"
    echo ""
}

# Main
main() {
    echo -e "${GREEN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                   ProxyCLI Installer                         ║"
    echo "║         Multi-provider AI reverse proxy                      ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    log_info "Install directory: $INSTALL_DIR"
    
    check_dependencies
    download_release
    setup_directories
    start_service
    print_usage
}

main "$@"