# Convenience wrappers around docker compose. `make help` lists targets.
.DEFAULT_GOAL := help
.PHONY: help build verify test watch cov shell clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Build the Docker image
	docker compose build

verify: ## Verify the env: typecheck + always-green harness/metrics tests (exit 0)
	docker compose run --rm verify

test: ## Typecheck + run the full suite once (specs red until implemented)
	docker compose run --rm test

watch: ## Vitest watch loop (live TDD)
	docker compose up watch

cov: ## Coverage report (writes ./coverage on host)
	docker compose run --rm cov

shell: ## Interactive shell inside the container
	docker compose run --rm shell

clean: ## Remove containers and the coverage dir
	docker compose down --remove-orphans
	rm -rf coverage
