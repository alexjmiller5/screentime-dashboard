# screentime-dashboard

Personal dashboard for Apple Screen Time history across devices - app usage
over time, per-device and per-app breakdowns, and trend views for the apps I'm
trying to use less.

Data comes from weekly [screentime-backup](https://github.com/alexjmiller5/screentime-backup)
snapshots (knowledgeC.db + Biome SEGB streams + DeviceActivity plists). A
Bun CLI, `screentime-ingest`, and the dashboard's local folder importer use
the same incremental pipeline. Each compares every available snapshot file
against D1's import ledger (path, SHA-256, parser version). Only missing or
changed files are parsed and uploaded. An old snapshot is eligible even if
newer usage is already present.

- **Refresh** takes a fresh backup on the configured Mac, then imports all
  missing or changed files, including older files newly available from iCloud.
- **Import from this Mac** opens a folder picker. Select the backups folder;
  parsing happens in the browser, using the same ledger and upload protocol.
- **Rebuild** skips the new backup and reprocesses available files, useful
  after parser changes. Unavailable files keep their previously imported data.

Uploads are staged per file and committed only when every chunk is present.
D1 retains each file's parsed events and segments, so overlapping snapshots
are deduplicated before daily/hourly totals are computed. Derived responses
are cached by data version behind Access; imports and label edits invalidate
them. Inactive staged uploads expire after seven days. Failed reads and
interrupted uploads never remove an imported file. Existing aggregate-only
history remains a conservative floor until its originals can be recovered;
reprocessing cannot reduce those preexisting totals without provenance.

The Mac uses outbound long-polling (up to 30 seconds per request, with the
Worker checking D1 every second). No inbound server is needed. The daemon
allows four attempts per request, with retries after 5, 15 and 60 minutes.
Idle polls read no credentials. Each actual attempt reads a credential to
acknowledge the job, and the backup's import hook reads its own credential;
heartbeats reuse these in memory. The backup's post-run hook runs
inside its Full Disk Access context. Grant that backup app Full Disk Access
in macOS System Settings before its first run.

Refresh state lives in one D1 record. The mini acknowledges the request,
confirms the backup process started, and reports import progress with a
heartbeat every 15 seconds. After 60 seconds without an update the page
shows progress as unconfirmed. A run with no heartbeat for 30 minutes becomes
eligible for a bounded retry. Retry times and completion remain visible
across tabs and devices. Repeated Refresh clicks join the current job;
explicit Retry replaces a failed, stale or unacknowledged job.

Closing a tab does not cancel a remote refresh. Reopening or focusing the
page reloads status; visible tabs check active jobs every five seconds and
idle status every 30 seconds. Local folder imports run in the browser and
stop when it closes; completed files stay committed and are skipped next time.

## Stack

SvelteKit (Svelte 5) + Tailwind v4 + shadcn-svelte on a Cloudflare Worker
with static assets. Storage: D1. Auth: Cloudflare Access at the edge (no
auth code in the app; the ingest job gets in with an Access service token).
Installable iOS/Android homescreen app. Scaffolded from the
[cf-site](https://github.com/alexjmiller5/cf-site) template.

```
src/routes/            page + thin API routes (usage, imports, ingest, refresh, devices, markers)
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
services.screentime-backup.skipDumpFlag = config.services.screentime-ingest.skipDumpFlag;
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

## Markers

Use **Markers** to add, edit or delete dated notes. They appear on the chart
and in an accessible list; week/month views retain the original event date.
Marker content lives in D1, never in source control.

## Notes

- No runtime secrets (`.env.tpl` is intentionally empty); CI deploy creds
  resolve from 1Password in the workflow.
- Provisioning is scripted: `scripts/cf-d1.py` (database), `scripts/cf-access.py
--pwa --public-path /api/refresh/pending --service-token "<name>"` (Access +
  the ingest job's service token), `scripts/generate-icons.sh` (homescreen icons).
