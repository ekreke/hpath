# HPath workflow makefile (macOS/Linux, GNU make)
# Run `make` or `make help` to list targets.

PORT ?= 50051
LOG  ?= /tmp/hpath-server.log
COMPOSE_FILE ?= docker/compose.yaml
# `make up PROFILE=s3` additionally starts the optional SeaweedFS service.
PROFILE ?=

.DEFAULT_GOAL := help
.PHONY: help install proto build dist mock real dev run smoke test test-unit restart stop clean verify up down logs docker-clean cloc

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies (pnpm)
	pnpm install

proto: ## Regenerate TS types + descriptor set from proto
	./scripts/gen-proto.sh

build: ## Build all workspace packages
	pnpm build

dist: ## Build the macOS desktop bundle (.app/.dmg under packages/desktop/src-tauri/target/release/bundle)
	pnpm --filter @hpath/contract build
	pnpm --filter @hpath/desktop tauri build

mock: ## Start mock server in background (log: $(LOG)), wait until healthy
	@$(MAKE) stop
	@nohup node packages/server/dist/index.js --mock --port $(PORT) > $(LOG) 2>&1 & \
	 echo "mock server starting on 127.0.0.1:$(PORT) (pid $$!, log $(LOG))"
	@ok=0; for i in $$(seq 1 15); do \
	  grpcurl -plaintext 127.0.0.1:$(PORT) list hpath.v1.Hpath > /dev/null 2>&1 && { ok=1; break; }; \
	  sleep 1; \
	done; \
	[ $$ok -eq 1 ] && echo "healthy: reflection OK" \
	  || (echo "FAILED to start, log tail:"; tail -5 $(LOG); exit 1)

real: ## Start real-mode server in background (SQLite reads from T3; rest UNIMPLEMENTED until T8)
	@$(MAKE) stop
	@nohup node packages/server/dist/index.js --real --port $(PORT) > $(LOG) 2>&1 & \
	 echo "real skeleton starting on 127.0.0.1:$(PORT) (log $(LOG))"
	@sleep 1.5
	@tail -2 $(LOG)

dev: ## Run mock server in foreground with watch (tsx)
	pnpm --filter @hpath/contract build
	cd packages/server && npx tsx watch src/index.ts --mock --port $(PORT)

run: ## Start mock server (bg) + Tauri desktop dev together (Ctrl+C stops both)
	@if [ ! -f packages/contract/dist/index.js ] || [ ! -f packages/server/dist/index.js ]; then \
		echo "building contract + server..."; \
		pnpm --filter @hpath/contract build && pnpm --filter @hpath/server build; \
	fi
	@$(MAKE) mock
	@trap '$(MAKE) -C $(CURDIR) stop' EXIT; cd packages/desktop && pnpm tauri dev

smoke: ## Run the smoke client against a running server (default $(PORT))
	pnpm --filter @hpath/server smoke

test: build mock ## Full local verification: build, start mock, unit tests + smoke, stop
	@$(MAKE) test-unit || { $(MAKE) stop; exit 1; }
	@sleep 0.5
	@pnpm --filter @hpath/server smoke; status=$$?; \
	 $(MAKE) stop; exit $$status

test-unit: ## Run @hpath/server unit tests (agent kernel, db layer, registries, schema)
	pnpm --filter @hpath/server test

restart: ## Restart the background mock server
	@$(MAKE) mock

stop: ## Stop any running hpath server on $(PORT)
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -n "$$pids" ]; then kill $$pids 2>/dev/null; echo "stopped: $$pids"; else echo "no server on $(PORT)"; fi

verify: build smoke ## Build + smoke against an already-running server

up: ## Build & start the docker compose stack (add PROFILE=s3 for SeaweedFS)
	docker compose -f $(COMPOSE_FILE) $(if $(PROFILE),--profile $(PROFILE),) up -d --build

down: ## Stop and remove the docker compose stack
	docker compose -f $(COMPOSE_FILE) down

logs: ## Tail docker compose logs
	docker compose -f $(COMPOSE_FILE) logs -f --tail=100

docker-clean: ## Reclaim docker disk: dangling images + build cache unused for 7d, then show usage
	docker image prune -f
	docker builder prune -f --filter until=168h
	docker system df

clean: ## Remove build outputs (keeps node_modules)
	rm -rf packages/server/dist packages/desktop/dist
	find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete 2>/dev/null || true

cloc: ## Count lines of business code (excludes generated content)
	cloc . --exclude-dir=node_modules,dist,gen,target,generated-images \
		--fullpath --not-match-d 'pnpm-lock\.yaml'
