# screentime-dashboard

Personal dashboard for Apple Screen Time history across devices - app usage
over time, per-device and per-app breakdowns, and trend views for the apps I'm
trying to use less.

Data comes from weekly [screentime-backup](https://github.com/alexjmiller5/screentime-backup)
snapshots (knowledgeC.db + Biome SEGB streams + DeviceActivity plists). A
Bun CLI, `screentime-ingest`, runs on the Mac that holds the snapshots: it
parses every snapshot (gzip via `DecompressionStream`, SQLite via
`bun:sqlite`, Biome SEGB/protobuf and binary plists via TS parsers) and
pushes the merged per-app/per-device daily series to the Worker's D1. The
dashboard's **Refresh** button asks that Mac for a fresh dump + rebuild: the
Worker records the request, a 60-second launchd poll on the Mac picks it up,
kicks the backup, and the backup's post-run hook pushes the new series.

## Stack

SvelteKit (Svelte 5) + Tailwind v4 + shadcn-svelte on a Cloudflare Worker
with static assets. Storage: D1. Auth: Cloudflare Access at the edge (no
auth code in the app; the ingest job gets in with an Access service token).
Installable iOS/Android homescreen app. Scaffolded from the
[cf-site](https://github.com/alexjmiller5/cf-site) template.

```
src/routes/            page + thin API routes (usage, ingest, refresh, devices)
src/lib/data/          pure parsing/derivation modules (unit-tested)
src/lib/import/        snapshot walker + device-label guessing (pure)
src/lib/server/        D1 SQL builders + refresh state machine (pure)
src/ingest/            the screentime-ingest CLI (Bun) + its API client
migrations/            D1 schema
nix/, flake.nix        screentime-ingest package + nix-darwin module
wrangler.jsonc         the IaC - Worker + D1 binding
scripts/               idempotent provisioners (cf-d1.py, cf-access.py), icons
justfile               dev / test / check / fmt / build / logs / deploy / ingest
```

## Running the ingest on a Mac (nix-darwin)

```nix
# flake input: screentime-dashboard.url = "github:alexjmiller5/screentime-dashboard";
services.screentime-backup.postRun = config.services.screentime-ingest.syncCommand;
services.screentime-ingest = {
  enable = true;
  user = "you";
  url = "https://<your dashboard host>";
  # prints {"clientId": "...", "clientSecret": "..."} - the Access service token
  credentialCommand = "/path/to/your/credential-script";
};
```

Without nix: `SCREENTIME_DASHBOARD_URL=... SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND=...
bun run src/ingest/cli.ts sync` (see the env table at the top of
`src/ingest/cli.ts`).

## Development

```bash
just dev             # local dev server (miniflare fakes the D1 binding)
just migrate-local   # create the local schema
just ingest          # fill it from this Mac's backups (set the env first)
just test            # vitest
just check           # wrangler types + svelte-check + prettier
```

Deploying = push to `main`; the GHA workflow tests, builds, and deploys.

## Notes

- No runtime secrets (`.env.tpl` is intentionally empty); CI deploy creds
  resolve from 1Password in the workflow.
- Provisioning is scripted: `scripts/cf-d1.py` (database), `scripts/cf-access.py
--pwa --public-path /api/refresh/pending --service-token "<name>"` (Access +
  the ingest job's service token), `scripts/generate-icons.sh` (homescreen icons).
