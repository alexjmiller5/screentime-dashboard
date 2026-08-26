# Canonical secrets manifest — 1Password secret references only, SAFE to commit.
# Most sites have zero-to-few secrets; Worker bindings (D1, R2, KV) are NOT
# secrets — they go in wrangler.jsonc.
# Local dev:      op run --env-file=.env.tpl -- bun run dev
# Push to CF:     just sync-secrets
#
# This app has NO runtime secrets: data is imported client-side from local
# backups, storage is an R2 binding (wrangler.jsonc), and auth is Cloudflare
# Access at the edge. CI deploy creds live in .github/workflows/deploy.yml
# per the infra convention (CI-only creds never go here).
