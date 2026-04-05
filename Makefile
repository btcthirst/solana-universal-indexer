# Load .env if it exists
ifneq (,$(wildcard .env))
  include .env
  export
endif
# ─── Config ───────────────────────────────────────────────────────────────────
.DEFAULT_GOAL := help
SHELL         := /bin/bash

# Colours
CYAN  := \033[0;36m
RESET := \033[0m

.PHONY: help \
        install \
        dev build clean \
        lint format typecheck \
        test test-watch test-coverage test-coverage-ui test-coverage-check \
        db-up db-down db-reset db-shell \
        docker-build docker-up docker-down docker-logs docker-restart \
        env-check

# ─── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  $(CYAN)solana-universal-indexer$(RESET)"
	@echo ""
	@echo "  $(CYAN)install$(RESET)          npm ci"
	@echo ""
	@echo "  $(CYAN)dev$(RESET)              run indexer locally (ts-node / tsx)"
	@echo "  $(CYAN)build$(RESET)            compile TypeScript → dist/"
	@echo "  $(CYAN)clean$(RESET)            remove dist/"
	@echo ""
	@echo "  $(CYAN)lint$(RESET)             eslint src/"
	@echo "  $(CYAN)format$(RESET)           prettier --write src/"
	@echo "  $(CYAN)typecheck$(RESET)        tsc --noEmit"
	@echo ""
	@echo "  $(CYAN)test$(RESET)             run all tests"
	@echo "  $(CYAN)test-watch$(RESET)       run tests in watch mode"
	@echo ""
	@echo "  $(CYAN)db-up$(RESET)            start only postgres container"
	@echo "  $(CYAN)db-down$(RESET)          stop postgres container"
	@echo "  $(CYAN)db-reset$(RESET)         drop volume + restart postgres (fresh DB)"
	@echo "  $(CYAN)db-shell$(RESET)         open psql inside postgres container"
	@echo ""
	@echo "  $(CYAN)docker-build$(RESET)     build indexer image"
	@echo "  $(CYAN)docker-up$(RESET)        docker compose up (all services)"
	@echo "  $(CYAN)docker-down$(RESET)      docker compose down"
	@echo "  $(CYAN)docker-logs$(RESET)      follow indexer logs"
	@echo "  $(CYAN)docker-restart$(RESET)   rebuild + restart indexer only"
	@echo ""
	@echo "  $(CYAN)env-check$(RESET)        validate .env has all required keys"
	@echo ""

# ─── Install ──────────────────────────────────────────────────────────────────
install:
	npm ci

# ─── Dev / Build ──────────────────────────────────────────────────────────────
dev:
	NODE_ENV=development npx tsx src/index.ts

build:
	npx tsc

clean:
	rm -rf dist/

# ─── Code quality ─────────────────────────────────────────────────────────────
lint:
	npx eslint src/

format:
	npx prettier --write src/

typecheck:
	npx tsc --noEmit

# ─── Tests ────────────────────────────────────────────────────────────────────
test:
	npx vitest run

test-coverage:
	npx vitest run --coverage

test-coverage-ui:
	npx vitest run --coverage --reporter=html && open coverage/index.html

test-coverage-check:
	npx vitest run --coverage --coverage.thresholds.autoUpdate=false

test-watch:
	npx vitest

# ─── Database (local dev — only postgres, no indexer) ─────────────────────────
db-up:
	docker compose up postgres -d
	@echo "Waiting for postgres to be healthy..."
	@until docker compose exec postgres pg_isready -U $${POSTGRES_USER:-indexer} -d $${POSTGRES_DB:-indexer} > /dev/null 2>&1; do sleep 1; done
	@echo "Postgres is ready."

db-down:
	docker compose stop postgres

db-reset:
	docker compose down -v postgres
	$(MAKE) db-up

db-shell:
	docker compose exec postgres psql -U $${POSTGRES_USER:-indexer} -d $${POSTGRES_DB:-indexer}

# ─── Docker (full stack) ──────────────────────────────────────────────────────
docker-build:
	docker compose build indexer

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f indexer

docker-restart:
	docker compose up -d --build indexer

# ─── Env check ────────────────────────────────────────────────────────────────
env-check:
	@REQUIRED="PROGRAM_ID MODE SOLANA_NETWORK DATABASE_URL"; \
	MISSING=""; \
	for key in $$REQUIRED; do \
		grep -q "^$$key=" .env 2>/dev/null || MISSING="$$MISSING $$key"; \
	done; \
	if [ -n "$$MISSING" ]; then \
		echo "Missing required .env keys:$$MISSING"; exit 1; \
	else \
		echo "All required .env keys present."; \
	fi