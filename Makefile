# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Makefile
# ═══════════════════════════════════════════════════════════════════════════════
# Usage:
#   make build      - Build production image
#   make dev        - Start development environment with hot reload
#   make up         - Start production environment
#   make down       - Stop all containers
#   make logs       - View logs
#   make clean      - Clean up containers and volumes
#   make release    - Build and tag release image
# ═══════════════════════════════════════════════════════════════════════════════

# Configuration
COMPOSE_FILE := docker-compose.yml
COMPOSE_OVERRIDE := docker-compose.override.yml
IMAGE_NAME := proxycli
IMAGE_TAG ?= latest
REGISTRY ?= 

# Colors
BLUE := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RED := \033[31m
NC := \033[0m # No Color

# Default target
.DEFAULT_GOAL := help

.PHONY: help build dev up down logs clean release push shell test lint

## help: Show this help message
help:
	@echo "$(BLUE)ProxyCLI Makefile$(NC)"
	@echo ""
	@echo "Available targets:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  $(GREEN)%-15s$(NC) %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## build: Build production Docker image
build:
	@echo "$(BLUE)Building production image...$(NC)"
	docker build --target production -t $(IMAGE_NAME):$(IMAGE_TAG) .
	@echo "$(GREEN)✓ Build complete: $(IMAGE_NAME):$(IMAGE_TAG)$(NC)"

## dev: Start development environment with hot reload
dev:
	@echo "$(BLUE)Starting development environment...$(NC)"
	@if [ ! -f .env ]; then \
		echo "$(YELLOW)⚠ .env not found, copying from .env.example$(NC)"; \
		cp .env.example .env; \
	fi
	@if [ ! -f config.yaml ]; then \
		echo "$(RED)✗ config.yaml not found! Please create one.$(NC)"; \
		exit 1; \
	fi
	docker compose -f $(COMPOSE_FILE) -f $(COMPOSE_OVERRIDE) up --build

## up: Start production environment
up:
	@echo "$(BLUE)Starting production environment...$(NC)"
	@if [ ! -f .env ]; then \
		echo "$(YELLOW)⚠ .env not found, copying from .env.example$(NC)"; \
		cp .env.example .env; \
	fi
	@if [ ! -f config.yaml ]; then \
		echo "$(RED)✗ config.yaml not found! Please create one.$(NC)"; \
		exit 1; \
	fi
	docker compose -f $(COMPOSE_FILE) up -d
	@echo "$(GREEN)✓ ProxyCLI is running at http://localhost:$(shell grep PROXYCLI_PORT .env 2>/dev/null | cut -d= -f2 || echo 8488)$(NC)"

## down: Stop all containers
down:
	@echo "$(BLUE)Stopping containers...$(NC)"
	docker compose -f $(COMPOSE_FILE) -f $(COMPOSE_OVERRIDE) down
	@echo "$(GREEN)✓ Containers stopped$(NC)"

## logs: View container logs
logs:
	docker compose -f $(COMPOSE_FILE) logs -f --tail=100

## shell: Open shell in running container
shell:
	docker compose -f $(COMPOSE_FILE) exec proxycli sh

## clean: Remove containers, volumes, and images
clean:
	@echo "$(YELLOW)Cleaning up...$(NC)"
	docker compose -f $(COMPOSE_FILE) -f $(COMPOSE_OVERRIDE) down -v --rmi local
	docker system prune -f
	@echo "$(GREEN)✓ Cleanup complete$(NC)"

## release: Build and tag release image
release: build
	@echo "$(BLUE)Tagging release...$(NC)"
	@VERSION=$$(cat package.json | grep '"version"' | head -1 | awk -F: '{ print $$2 }' | sed 's/[",]//g' | tr -d '[[:space:]]'); \
	docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(IMAGE_NAME):v$$VERSION; \
	echo "$(GREEN)✓ Tagged: $(IMAGE_NAME):v$$VERSION$(NC)"

## push: Push image to registry
push: release
	@echo "$(BLUE)Pushing to registry...$(NC)"
	@VERSION=$$(cat package.json | grep '"version"' | head -1 | awk -F: '{ print $$2 }' | sed 's/[",]//g' | tr -d '[[:space:]]'); \
	if [ -n "$(REGISTRY)" ]; then \
		docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG); \
		docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):v$$VERSION; \
		docker push $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG); \
		docker push $(REGISTRY)/$(IMAGE_NAME):v$$VERSION; \
		echo "$(GREEN)✓ Pushed to $(REGISTRY)/$(IMAGE_NAME)$(NC)"; \
	else \
		echo "$(YELLOW)⚠ REGISTRY not set, skipping push$(NC)"; \
	fi

## test: Run tests
test:
	@echo "$(BLUE)Running tests...$(NC)"
	npm run test

## lint: Run linter
lint:
	@echo "$(BLUE)Running linter...$(NC)"
	npm run typecheck

## update: Update dependencies and rebuild
update:
	@echo "$(BLUE)Updating dependencies...$(NC)"
	npm update
	@echo "$(GREEN)✓ Dependencies updated, run 'make build' to rebuild$(NC)"

## backup: Backup data directory
backup:
	@echo "$(BLUE)Creating backup...$(NC)"
	@mkdir -p backups
	@BACKUP_NAME="backup_$$(date +%Y%m%d_%H%M%S).tar.gz"; \
	tar -czf backups/$$BACKUP_NAME data/; \
	echo "$(GREEN)✓ Backup created: backups/$$BACKUP_NAME$(NC)"

## stats: Show container stats
stats:
	docker stats $(IMAGE_NAME) --no-stream
