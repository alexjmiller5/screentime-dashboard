# AGENTS.md

Personal Screen Time dashboard on a Cloudflare Worker: Svelte 5 frontend +
thin co-located API. Visualizes Apple Screen Time history across devices from
weekly [screentime-backup](https://github.com/alexjmiller5/screentime-backup)
snapshots. Private site - Alex only, via Cloudflare Access.

## Architecture

- **Incremental imports run on the Mac or in the browser.**
  `src/lib/import/incremental.ts` is shared by the Bun CLI and local folder
  picker. Every supported file in every dated snapshot is checked against D1's
  ledger by path, content hash and parser version. Only missing or changed
  files are parsed/uploaded; Rebuild forces available files.
  The native CLI saves content hashes in `file-hashes.json` under
  `SCREENTIME_STATE_DIR` (default `~/Library/Application Support/screentime-ingest`).
  An unchanged device/inode/size/mtime/ctime fingerprint can reuse a hash only
  when the server ledger also matches the current parser. Identity checks use
  bigint nanosecond timestamps; missing or coarse change timestamps fall back
  to reading/hashing. Fingerprints must match before and after a read before
  it can be memoized. Browser imports, cold caches, parser changes and force
  rebuilds read/hash files. With the source archive enabled, ordinary refresh lists snapshot directory names
  but opens only the newest local snapshot and dates absent from the archive.
  Retained history comes from the archive manifest; `sync --scan-local` explicitly
  checks old local corrections and partial snapshots. Rebuild reads retained
  originals without consulting local backups. The atomic local
  cache is disposable; deleting or corrupting it only costs a fresh hash pass.
- **Files commit atomically.** `/api/imports` stages bounded parsed chunks,
  checks completeness, then switches the file's active contribution. Failed
  reads/uploads retain the prior contribution. Overlapping focus events and
  sessions deduplicate before aggregation; newer DeviceActivity segments win.
  `readUsageCache` derives from committed contributions, but never on a page
  load: `readDerived` serves the `/api/usage` summary and sessions documents
  from the `derived` table (BLOB chunks under D1's 2 MB cap, keyed by data
  version), rebuilding and storing both only on a miss. The ingest's `final`
  marker warms it so the first visit after a sync is instant; the CLI allows
  that one POST ten minutes. The usage route still layers the per-colo Cache
  API on top, keyed by data version. Inactive staged uploads expire after
  seven days. Aggregate-only rows
  are retained as a conservative floor because they lack file provenance.
  Never globally sweep history based on the files available in one scan.
- **Refresh from the site = a flag, long-poll, backup, incremental import.**
  Refresh (`dump`) takes a new snapshot; Rebuild skips the dump via the backup
  module's `skipDumpFlag`. Both run the sync in the FDA-holding backup process.
  The `watch` daemon holds `/api/refresh/pending?wait=30` requests while the
  Worker checks D1 every second. It persists attempts before launch, permits
  four attempts with 5/15/60-minute retry gaps, and never reads credentials
  during idle polling. Each attempt reads a credential for acknowledgement,
  and its import hook reads separately; 15-second heartbeats reuse them.
  Scheduled retries and exhausted failures are visible to every device. The weekly backup uses the same hook.
- **Confirmed refresh status** lives in `meta.refresh_job`, updated with
  compare-and-swap through the Access-protected `/api/refresh/job`. Updates
  carry request and attempt IDs; late attempts cannot overwrite newer work.
  Stages are queued, acknowledged, backup process running, importing,
  complete, retry scheduled and failed. Import heartbeats come from the
  importer, not its watcher. After 60 seconds without one progress is
  unconfirmed; after 30 minutes the normal bounded retry can reclaim it.
  Repeated clicks join the active job. Explicit Retry can replace failed,
  stale or unacknowledged jobs. Pages resume observation on load/focus,
  poll active jobs every five seconds and idle status every 30 seconds.
  Closing a tab never cancels a remote job; local imports stop safely.
- **Local import** uses a folder picker and bundled SQL.js for knowledgeC;
  the CLI uses Bun SQLite. Both use the same parsers and ledger, so a file
  imported from either machine is skipped by the other. Show imported,
  skipped and unavailable file counts; partial success must remain visible.
- **Upload devices enroll through `/connect`**, protected by the dashboard's
  Cloudflare Access policy. `screentime-ingest login` generates a random bearer,
  sends only its SHA-256 fingerprint to browser approval, and stores the approved
  credential with Bun's native secret storage. `upload_devices` stores hashes
  and revocation state. The device API authenticates each request and allows
  only file import, retained-source access, ingest status, refresh reads/progress, and self-revocation.
  It cannot create refresh jobs or reach dashboard administration endpoints.
  `/connect` must never be bypassed: its assertion-header presence check is a
  fail-closed guard, not JWT verification. Revoked hashes cannot be reapproved.
- **Originals: Life Data retained-file API.** The Worker uses its own dedicated
  credential restricted to `LIFE_ARCHIVE_PREFIX`, through `LIFE_HUB_URL`.
  `LIFE_HUB_TOKEN` stays server-side; upload devices use their existing dashboard
  enrollment. Immutable source bytes and versioned manifests are verified by
  SHA-256. The project-owned D1 `meta.archive_head` holds the current manifest
  reference, advanced with compare-and-swap only after successful retention.
  Concurrent additions retry without dropping files; stale replacements reject.
  Original retention precedes derived imports. A parser failure retains prior
  derived contributions and the immutable earlier source manifest. Partial
  configuration fails closed. Unconfigured installations explicitly use local
  sources. Seed and verify a complete manifest before enabling archive rebuilds;
  local backup retirement requires a verified archive-backed rebuild.
- **Storage: D1** (`DB` binding, database `screentime-dashboard`, schema in
  `migrations/`): `usage` (source, device, date, bundle_id → seconds),
  `hourly`, file ledger/staged parsed contributions, `markers`, `devices` (uuid → label, edited in the Devices dialog; the
  ingest only INSERTs guesses for unknown uuids), `meta` (imported_at,
  time_zone, data_updated_at, refresh_* markers). `GET /api/usage` assembles the whole
  dataset (a few thousand rows) into the `UsageCache` shape the client
  consumes; all filtering/grouping stays client-side over pure selectors.
- **API routes are thin** (`src/routes/api/*/+server.ts`): SQL builders and
  the refresh state machine live in `src/lib/server/store.ts` (pure,
  unit-tested); parsing/derivation in `src/lib/data/` + `src/lib/import/`
  (no DOM, no platform APIs, also what the CLI runs).
- SSR is off (`export const ssr = false`) - the page is client-driven.
- `wrangler.jsonc` is the IaC (Worker + D1 binding). `scripts/cf-d1.py`
  creates a declared database that doesn't exist yet; CI applies migrations
  before every deploy; `bun run gen` regenerates binding types. Local dev:
  `just migrate-local`, then `SCREENTIME_DASHBOARD_URL=http://localhost:5173
SCREENTIME_DASHBOARD_CLIENT_ID=x SCREENTIME_DASHBOARD_CLIENT_SECRET=y just
ingest` fills miniflare's D1 from this Mac's backups folder.
- **Auth: Cloudflare Access at the edge** (Alex only), provisioned by
  `scripts/cf-access.py --domain '<worker>.<account>.workers.dev'
--domain '*-<worker>.<account>.workers.dev' --pwa --public-path /api/refresh/pending
--public-path '/api/device/*'`. Deploy the authenticated device API and its
  migration before enabling that public path. Protect all production and
  preview hostnames, including `/connect`; only the narrow device API bypasses
  browser login. Runtime archive secrets are resolved from this project's ENV item
  through `.env.tpl`; deployment streams them to Wrangler through stdin.
  CI deploy credentials remain separate (the CI Cloudflare token carries
  Workers Scripts + D1 Write, minted by `scripts/provision.py`).
- **The mini's ingest is a nix-config flake pin, the Worker is CI-deployed** -
  they version-skew independently. Any change to parsing or the refresh protocol
  (`/api/refresh/job` stages, the pending flag's lifecycle) is only half
  shipped until `nix flake update screentime-dashboard` + a mini rebuild:
  an old ingest syncs fine but never confirms, so the site sits on
  "waiting for the mini to confirm" and the request retries every 5 min.
- **Installed on the mini via nix** (`flake.nix`: `packages.default` =
  screentime-ingest, `darwinModules.default` = the watch agent + the
  `syncCommand` handed to `services.screentime-backup.postRun`). Config is
  env vars (`SCREENTIME_DASHBOARD_URL`, `SCREENTIME_BACKUPS_DIR`,
  `SCREENTIME_BACKUP_LABEL`, `SCREENTIME_TIME_ZONE`). Native enrollment is the
  default; optional token/command and proxy headers are generic seams.
  The watcher and backup hook run as the same desktop user with access to
  that user's Keychain. Run enrollment in a desktop terminal: SSH can reject
  Keychain writes with `User interaction is not allowed`, even with `--no-browser`.
  Replacement machines enroll anew; logout revokes
  first and only removes local auth after success. Gotchas: `bun:sqlite`'s `deserialize`
  rejects some larger knowledgeC images, so the CLI opens a temp file; a
  bad file only loses that file, never the snapshot (errors are per file).
  launchd runs agents with dataless-file materialization OFF, so reading an
  iCloud-evicted snapshot (the other Mac's, under Optimize Mac Storage) fails
  with `EDEADLK` instead of downloading; the CLI opts itself in at startup via
  `setiopolicy_np` (bun:ffi). A shell has it ON, so the bug only shows under
  launchd.

## Data model (what the parsers produce)

Source snapshots are `~/Documents/screen-time-backups/<YYYY-MM-DD>/` with
`knowledgeC.db.gz` + `biome-streams.tar.gz` (+ legacy `rmadmin-*.db.gz`
through 2026-07-12). Key facts (verified 2026-08-25, spike in the Notion
project note):

- **Biome `App.InFocus/remote/<device-uuid>/` SEGB segments** are the primary
  source: app-focus events. Payload field 3 is an explicit focus gained(1)/
  lost(0) flag, field 4 the precise event timestamp (double of Cocoa seconds),
  field 6 the bundle id. Paired events provide durations; inferred refocus
  endings and four-hour truncations are marked estimated. `tombstone/` subdirs hold deletion-bookkeeping records (no
  usage data; the extractor's field-type checks reject them) - skip them.
  Device UUIDs are machine-specific and never hardcoded: labels live in the
  `devices` table, edited in the dashboard's Devices dialog.
- **DeviceActivity `Cloud/<user>/<device>/{Daily,Hourly}/ActivitySegments/*.plist`**
  (inside `device-activity.tar.gz`, capturable only on macOS ≤26.2 Macs -
  currently the MacBook): Apple's own cross-device Screen Time aggregates as
  binary plists - per-app durations AND per-web-domain durations (WebKit
  reports every iOS browser, so this is where iPhone per-site time lives).
  Parsed by `bplist.ts` + `deviceactivity.ts` into `source: 'screentime'`
  daily rows; web domains get `web:<domain>` bundle ids. Hourly segments carry
  real one-hour windows with per-site totals, exposed as `websiteHours` separately
  from focus sessions. They do not contain exact website start/stop times.
  Browser residuals exclude website time using the device label to join the
  two identity namespaces. Local/ and AppleDouble companion files are skipped;
  later snapshots overwrite the same device/window/granularity, including
  empty replacements. Ledger segment headers use value null for daily and
  3600 for hourly, so midnight daily/hourly records cannot overwrite each other. Two
  segments can land on one local date (non-midnight boundary, time-zone
  change) - `buildUsageCache` sums them into the one row per
  (source, device, date, bundle) that D1 keys on.
- **knowledgeC `/app/usage`** rows give absolute Mac durations 2026-05-06 →
  2026-07-11 (laptop-era snapshots only; mini-era knowledgeC is empty).
  Mac Absolute Time epoch offset: `+ 978307200`.
- Snapshots overlap (rolling ~30-45-day windows) - the merge must dedup by
  (device, timestamp) before aggregating.
- The TS SEGB parser is cross-checked against ccl-segb (Python reference)
  via a committed fixture; regenerate with `scripts/make-segb-fixture.py`.

## Stack

Bun (never npm) · SvelteKit + Svelte 5 runes · Tailwind v4 ·
shadcn-svelte (+ bits-ui) · vitest · prettier. No `svelte.config.js` -
adapter and compiler options live in `vite.config.ts` inside the
`sveltekit()` plugin.

## UI conventions

- **Date navigation** uses a separate 90-calendar-day viewport, anchored to the
  selected end. Earlier/Later pans the viewport without changing selection;
  dragging at an edge keeps panning through history. Handles and the filled
  span support arrow keys, Shift for weeks, Page keys and Home/End. Calendar
  math is UTC-based; viewport work is bounded independently of archive size.
  Relative rules and validated Custom dates stay in per-device preferences.
  `scripts/test-date-viewport.mjs` runs the browser regression using a supplied
  owned CDP target and localhost dev URL with synthetic API responses.

- **Chart views** share the date window, devices and app selection, saved with
  the selected view and table state in `screentime:prefs`. Totals uses elected
  daily measurements; the "Measured by" lens (`measuredBy`, Totals only,
  disabled in the other views) pins one source with no fallback, so a day that
  source never measured is empty and a flip between sources is visible; By hour combines focus-derived app history with recorded
  website hour totals into 24 bars and disables bucketing. Timeline loads
  focus sessions on demand from committed
  originals, split at local hour boundaries, on a midnight-to-midnight axis.
  Tooltips and table times include UTC offsets; capped or inferred intervals
  are flagged as estimated. The interval table pages 100 rows at a time.
  Weekly and monthly buckets reserve all calendar days, including unselected
  edge days; overlapping sessions use separate lanes. Recorded website hours
  appear as hatched hour cells keyed by the window's local start hour, with
  duration independent of cell height. Browser portions within those windows
  become residual hour totals too: their exact remaining placement is unknown.
  By hour normally uses cached focus-hour totals. When recorded website windows
  cross local clock-hour boundaries, it loads sessions and subtracts actual overlap
  before bucketing. Aggregate-only remainders are preserved and explicitly labeled
  when their website overlap is unknowable. Both timing views exclude daily-only
  measurements. Timeline points retain raw
  bundle IDs separately from display keys, so domains are never normalized twice.
  The app/site picker retains daily totals for entries without timing, labels
  their measurement and offers Show daily totals; unavailable timing is never
  presented as zero usage. Loading/error states are identified separately.
- `UsageCache.sessions` is optional for compatibility with aggregate-only
  history. Derive it from committed focus events without changing stored
  originals or the import protocol. When the derived response shape changes,
  change the usage route's cache namespaces so old cached responses expire
  independently of the last import timestamp. `GET /api/usage?sessions=1&start=YYYY-MM-DD&end=YYYY-MM-DD`
  returns only session candidates for that date window (with UTC-offset padding);
  ordinary usage responses omit sessions.

- **Saved apps** is a browser-local preset: selected app/site display keys, all devices, daily buckets; date range stays unchanged. Save from the app picker. Existing picked apps initialize the preset; `?saveApps=<JSON string array>` installs a preset and removes itself from the URL. Personal selections belong in preferences, never source code.

- **Components: shadcn-svelte** in `src/lib/components/ui/` - that code is
  OURS: edit freely. Add more with `bunx shadcn-svelte@latest add <component>`.
- **Theme: always dark with a true black page background.** `src/app.html`
  applies `.dark` before the first render, independent of system appearance.
  Browser and PWA colors match the black background; cards, menus and charts
  use the dark shadcn palette. ALL tokens live in the `@theme` / `:root` /
  `.dark` blocks in `src/routes/layout.css`; components consume tokens,
  never raw values.
- Icons: Tabler ONLY via `@tabler/icons-svelte` for UI chrome - never emojis.
  shadcn's internal Lucide usage stays. DATA icons (app/site identity) are a
  separate system: `src/lib/viz/icons.svelte.ts` resolves a display key to
  the static brand map in `format.ts` (selfhst/Tabler via Iconify URLs),
  site favicons for domains, then the iTunes lookup API (real App Store
  artwork by bundle id, batched in 50s, cached in localStorage - misses
  cached as '').
- Chart/bar colors are each app's BRAND color (`appColor` in
  `src/lib/viz/format.ts`, keyed by normalized display name; never emit
  pure #000 - black brands get a dark-safe gray); unknown apps hash to a
  stable `--chart-N` token slot (`paletteIndex`), so color follows the
  entity, never its rank.
- Charts follow the `dashboards` skill; read it before touching chart code.
  Chart.js PERF GOTCHA: cost scales with DATASET count, not data volume -
  past ~30 series StackedChart switches to rank-level floating bars (every
  app keeps its own segment; datasets = deepest day). Never use `skipNull`
  on stacked bars (turns stacking quadratic; 451 series took 159s).

## Site basics

- Every route renders `<Seo title description>`.
- Favicon (`src/lib/assets/favicon.svg`) is purpose-driven for THIS site: a
  full-bleed blue tile carrying a phone with usage bars, so the tab icon and
  the homescreen icon are one piece of artwork. Regenerate the PNG set with
  `scripts/generate-icons.sh '#2a78d6' 1` (tile color + full-bleed scale;
  the defaults inset a bare glyph on white). Keep the favicon's colors
  unconditional - qlmanage rasterizes in dark appearance, so a
  `prefers-color-scheme` flip renders invisible ink
  (`static/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`);
  `static/manifest.webmanifest` + the iOS metas in `src/app.html` make it an
  installable homescreen app (Access bypass for those paths via `--pwa`).
  theme-color metas match the background tokens.
- Mobile-first layout per the `dashboards` skill: the control row wraps,
  the chart keeps a fixed height, the table scrolls in its own container -
  verify at 390px wide.
- `src/hooks.server.ts`: http→https 301 + baseline security headers.
- `+error.svelte` renders 404/500 with the theme.

## Commands

| Command                   | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `just dev`                | Dev server                                          |
| `just test`               | vitest                                              |
| `just check` / `just fmt` | wrangler types + svelte-check + prettier / auto-fix |
| `just build`              | Production build                                    |
| `just logs`               | `wrangler tail` on the deployed Worker              |
| `just deploy`             | test + build + `wrangler deploy` - CI's job (below) |
| `just migrate-local`      | apply D1 migrations to miniflare's local DB         |
| `just migrate`            | apply D1 migrations to production (CI does this)    |
| `just ingest`             | run the ingest CLI from this Mac (env in cli.ts)    |

**Deploying = commit + push to `main`.** The GHA workflow tests, builds, and
deploys - never `just deploy` locally without a stated reason. After pushing,
watch the run: `gh run watch <id> --exit-status`.

## TDD

Test first (`*.spec.ts` next to the code). All of `src/lib/data/` is pure and
unit-tested; parser correctness is anchored by the ccl-segb fixture.

## Offline startup

- The production service worker caches the home document and bundled assets per
  build. Updates activate after existing clients close; activation prunes only old
  shell caches. Never intercept API mutations or Cloudflare Access routes.
- `readDashboard` stores successful JSON GETs in device-local CacheStorage. Offline
  reads use the saved snapshot immediately; weak connections get 750 ms before
  fallback, with an 8-second request bound. Explicit refreshes require fresh data.
  Saved snapshots show their save time. Errors, redirects, and login HTML cannot
  replace a successful snapshot. Clearing website data removes offline data.
- Reconnect uses a full `/?online=1` navigation, bypassing the cached document so
  Cloudflare Access can authenticate. The flag is removed after startup. An online
  visit must finish loading once before offline reopening is possible.
- Run the offline helper and service-worker regression tests with the normal test
  suite; verify the production build with browser networking disabled, not Vite dev
  (SvelteKit only registers the service worker in production).
- Session reads include the summary data version in their cache key and carry
  the view effect’s abort signal; never label older sessions as a newer summary.
