# screentime-dashboard

Personal dashboard for Apple Screen Time history across devices - app usage
over time, per-device and per-app breakdowns, and trend views for the apps I'm
trying to use less.

The chart selector offers **Totals**, **Timeline**, and **By hour**. Timeline
places focus-derived sessions on a 24-hour clock, with individual day slots
inside weekly and monthly buckets. By hour sums the selected dates into 24
app-stacked bars. Date, device and app filters persist across views and
reloads. Timing views cover focus-derived history; daily-only totals and
websites cannot supply session timing. Totals include capped or inferred
intervals, marked estimated in Timeline. Session times include UTC offsets to distinguish
repeated daylight-saving hours. Use Table to inspect values and intervals.

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
with static assets. Storage: D1. Browser auth: Cloudflare Access at the edge.
Upload devices use app-issued, revocable credentials stored in the OS credential store.
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
};
```

After activating the module, run `screentime-ingest login` in a terminal on
the Mac's desktop session. Open its browser
link, match the approval code, and approve the uploader. On a headless Mac,
use `screentime-ingest login --no-browser` and open the printed link on your
other device. The credential stays in the uploader's macOS Keychain; the
watcher and backup hook must run as that same desktop user with its login
Keychain unlocked. Native Keychain prompts belong on that user's desktop.
An SSH session can fail with `User interaction is not allowed`; use Screen
Sharing to run enrollment in the desktop terminal, even with `--no-browser`.

Use **Upload devices** in the dashboard to revoke a lost or replaced uploader.
`screentime-ingest logout` revokes the current credential before removing it
locally. A replacement machine enrolls again; copying machine bootstrap or
deployment credentials is unnecessary. Verify setup with a real Refresh,
including the import stage.

For one-off use without a service, run the packaged CLI:
`SCREENTIME_DASHBOARD_URL=https://<dashboard-host> nix run github:alexjmiller5/screentime-dashboard -- login`.
Use `sync` with the same URL to import. Optional `SCREENTIME_DASHBOARD_TOKEN`,
`SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND` (JSON `{"token":"..."}`), and
`SCREENTIME_DASHBOARD_HEADERS` (JSON object) support external credential and
proxy setups. Legacy Access credential inputs remain supported.

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
--domain '<worker>.<account>.workers.dev' --domain '*-<worker>.<account>.workers.dev'
--pwa --public-path /api/refresh/pending --public-path '/api/device/*'` (Access),
  `scripts/generate-icons.sh` (homescreen icons). Deploy the authenticated device
  API and migration before adding the device path bypass. `/connect` and all
  other dashboard routes must remain Access-protected, including preview hosts.
