#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Docker Build Script
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
IMAGE_NAME="${IMAGE_NAME:-proxycli}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
TARGET="${TARGET:-production}"

# Helper functions
log_info() { echo -e "${BLUE}[build]${NC} $1"; }
log_success() { echo -e "${GREEN}[build]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[build]${NC} $1"; }
log_error() { echo -e "${RED}[build]${NC} $1"; }

# Show usage
usage() {
    cat << EOF
Usage: $0 [OPTIONS] [COMMAND]

Commands:
    build       Build the Docker image (default)
    push        Push the Docker image to registry
    clean       Remove build cache and dangling images
    compose-up  Start with docker compose
    compose-down Stop with docker compose

Options:
    -t, --tag TAG       Set image tag (default: latest)
    -n, --name NAME     Set image name (default: proxycli)
    --target TARGET     Set build target: production|development (default: production)
    --no-cache          Build without cache
    -h, --help          Show this help

Examples:
    $0 build                    # Build production image
    $0 build --target development   # Build development image
    $0 build -t v1.0.0          # Build with specific tag
    $0 compose-up               # Start with docker compose
EOF
}

# Build function
do_build() {
    local cache_arg=""
    if [ "$NO_CACHE" = "true" ]; then
        cache_arg="--no-cache"
        log_warn "Building without cache"
    fi

    log_info "Building ${IMAGE_NAME}:${IMAGE_TAG} (target: ${TARGET})..."
    
    docker build \
        --target "${TARGET}" \
        --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
        --tag "${IMAGE_NAME}:latest" \
        ${cache_arg} \
        --build-arg BUILDKIT_INLINE_CACHE=1 \
        --progress=plain \
        .

    log_success "Build completed: ${IMAGE_NAME}:${IMAGE_TAG}"
    
    # Show image size
    local size=$(docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}")
    log_info "Image size: ${size}"
}

# Push function
do_push() {
    log_info "Pushing ${IMAGE_NAME}:${IMAGE_TAG}..."
    docker push "${IMAGE_NAME}:${IMAGE_TAG}"
    log_success "Push completed"
}

# Clean function
do_clean() {
    log_info "Cleaning up..."
    docker system prune -f --volumes
    docker rmi "${IMAGE_NAME}:${IMAGE_TAG}" 2>/dev/null || true
    log_success "Cleanup completed"
}

# Compose up
do_compose_up() {
    log_info "Starting with docker compose..."
    if [ -f ".env" ]; then
        docker compose --env-file .env up -d
    else
        log_warn ".env file not found, using default values"
        docker compose up -d
    fi
    log_success "Services started"
    
    # Show status
    sleep 2
    docker compose ps
}

# Compose down
do_compose_down() {
    log_info "Stopping with docker compose..."
    docker compose down
    log_success "Services stopped"
}

# Parse arguments
COMMAND="build"
NO_CACHE="false"

while [[ $# -gt 0 ]]; do
    case $1 in
        build|push|clean|compose-up|compose-down)
            COMMAND="$1"
            shift
            ;;
        -t|--tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        -n|--name)
            IMAGE_NAME="$2"
            shift 2
            ;;
        --target)
            TARGET="$2"
            shift 2
            ;;
        --no-cache)
            NO_CACHE="true"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Execute command
case $COMMAND in
    build)
        do_build
        ;;
    push)
        do_push
        ;;
    clean)
        do_clean
        ;;
    compose-up)
        do_compose_up
        ;;
    compose-down)
        do_compose_down
        ;;
    *)
        log_error "Unknown command: $COMMAND"
        usage
        exit 1
        ;;
esac
