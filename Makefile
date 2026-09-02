# HPath workflow makefile (macOS/Linux, GNU make)
# Run `make` or `make help` to list targets.

PORT ?= 50051
LOG  ?= /tmp/hpath-server.log

.DEFAULT_GOAL := help
.PHONY: help install proto build mock real dev smoke test restart stop clean verify

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies (pnpm)
	pnpm install

proto: ## Regenerate TS types + descriptor set from proto
	./scripts/gen-proto.sh

build: ## Build all workspace packages
	pnpm build

mock: ## Start mock server in background (log: $(LOG)), wait until healthy
	@$(MAKE) stop
	@nohup node packages/server/dist/index.js --mock --port $(PORT) > $(LOG) 2>&1 & \
	 echo "mock server starting on 127.0.0.1:$(PORT) (pid $$!, log $(LOG))"
	@sleep 1.5
	@grpcurl -plaintext 127.0.0.1:$(PORT) list hpath.v1.Hpath > /dev/null 2>&1 \
		&& echo "healthy: reflection OK" \
		|| (echo "FAILED to start, log tail:"; tail -5 $(LOG); exit 1)

real: ## Start real-mode skeleton in background (all RPCs UNIMPLEMENTED)
	@$(MAKE) stop
	@nohup node packages/server/dist/index.js --real --port $(PORT) > $(LOG) 2>&1 & \
	 echo "real skeleton starting on 127.0.0.1:$(PORT) (log $(LOG))"
	@sleep 1.5
	@tail -2 $(LOG)

dev: ## Run mock server in foreground with watch (tsx)
	cd packages/server && npx tsx watch src/index.ts --mock --port $(PORT)

smoke: ## Run the smoke client against a running server (default $(PORT))
	pnpm --filter @hpath/server smoke

test: build mock ## Full local verification: build, start mock, run smoke, stop
	@sleep 0.5
	@pnpm --filter @hpath/server smoke; status=$$?; \
	 $(MAKE) stop; exit $$status

restart: ## Restart the background mock server
	@$(MAKE) mock

stop: ## Stop any running hpath server on $(PORT)
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -n "$$pids" ]; then kill $$pids 2>/dev/null; echo "stopped: $$pids"; else echo "no server on $(PORT)"; fi

verify: build smoke ## Build + smoke against an already-running server

clean: ## Remove build outputs (keeps node_modules)
	rm -rf packages/server/dist packages/desktop/dist
	find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete 2>/dev/null || true
