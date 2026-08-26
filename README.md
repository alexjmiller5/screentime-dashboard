# screentime-dashboard

Personal dashboard for Apple Screen Time history across devices - app usage
over time, per-device and per-app breakdowns, and trend views for the apps I'm
trying to use less.

Data comes from weekly [screentime-backup](https://github.com/alexjmiller5/screentime-backup)
snapshots (knowledgeC.db + Biome SEGB streams). There is no server-side
ingestion job: the **Import** button opens a browser directory picker on the
local backups folder, parses everything client-side (gzip via
`DecompressionStream`, SQLite via sql.js, Biome SEGB/protobuf via a TS
parser), and uploads the merged per-app/per-device daily series to R2. The
Worker just serves the cached series back.

## Stack

SvelteKit (Svelte 5) + Tailwind v4 + shadcn-svelte on a Cloudflare Worker
with static assets. Storage: one R2 object. Auth: Cloudflare Access at the
edge (no auth code in the app). Scaffolded from the
[cf-site](https://github.com/alexjmiller5/cf-site) template.

```
src/routes/            page + thin API routes (R2 read/write)
src/lib/data/          pure parsing/derivation modules (unit-tested)
src/routes/layout.css  Tailwind + @theme design tokens
wrangler.jsonc         the IaC - Worker + R2 binding
scripts/               idempotent provisioners (cf-r2.py, cf-access.py)
justfile               dev / test / check / fmt / build / logs / deploy
```

## Development

```bash
just dev     # local dev server (miniflare fakes the R2 binding)
just test    # vitest
just check   # wrangler types + svelte-check + prettier
```

Deploying = push to `main`; the GHA workflow tests, builds, and deploys.

## Notes

- The import flow needs a Chromium browser (`showDirectoryPicker`).
- No runtime secrets (`.env.tpl` is intentionally empty); CI deploy creds
  resolve from 1Password in the workflow.
