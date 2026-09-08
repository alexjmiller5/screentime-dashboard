set shell := ["bash", "-cu"]

default:
    @just --list

# Dev server (secrets injected if .env.tpl has any)
dev:
    op run --env-file=.env.tpl -- bun run dev

test:
    bun run test

# All static analysis: wrangler types + svelte-check + prettier (read-only)
check:
    bun run check && bun run lint

fmt:
    bun run format

build:
    bun run build

# Stream logs from the deployed Worker
logs:
    bunx wrangler tail

deploy: test build
    bunx wrangler deploy

# --- project-specific recipes below (one-offs live in scripts/, run directly) ---

# Apply D1 migrations to the local wrangler-dev database
migrate-local:
    bunx wrangler d1 migrations apply screentime-dashboard --local

# Apply D1 migrations to production (CI does this on every deploy)
migrate:
    bunx wrangler d1 migrations apply screentime-dashboard --remote

# Rebuild + push the series from this Mac's backups folder (needs the env in src/ingest/cli.ts)
ingest:
    bun run src/ingest/cli.ts sync
