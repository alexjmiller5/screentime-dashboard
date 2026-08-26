# AGENTS.md

Personal Screen Time dashboard on a Cloudflare Worker: Svelte 5 frontend +
thin co-located API. Visualizes Apple Screen Time history across devices from
weekly [screentime-backup](https://github.com/alexjmiller5/screentime-backup)
snapshots. Private site - Alex only, via Cloudflare Access.

## Architecture

- **No server-side ingestion.** The Import button uses `showDirectoryPicker()`
  (Chromium-only, fine for a personal tool) on the local
  `~/Documents/screen-time-backups/` folder and parses everything
  client-side: gzip via `DecompressionStream`, knowledgeC.db via sql.js
  (wasm), Biome SEGB segments + protobuf payloads via the TS parser in
  `src/lib/data/`. The merged per-app/per-device daily-seconds series is
  `PUT` to R2; the dashboard reads it back with one `GET`.
- **Store parsed, not raw** (lesson from notion-task-burndown-chart): the
  R2 `CACHE` binding holds one JSON object of derived daily series - tiny -
  never the ~100MB of raw snapshots. The Worker stays under the free-tier
  CPU cap because it never parses anything.
- **API routes are thin** (`src/routes/api/*/+server.ts`, 10-30 lines):
  stream R2 in/out, no business logic. All parsing/derivation lives in
  **pure modules under `src/lib/data/`** - no DOM, no platform APIs, fully
  unit-tested. Server-only code (R2 access) stays in `src/lib/server/`.
- SSR is off (`export const ssr = false`) - the page is client-driven.
- Bindings live in `wrangler.jsonc` (the IaC): the Worker + the `CACHE` R2
  bucket (`screentime-dashboard-cache`). `scripts/cf-r2.py` creates declared
  buckets idempotently; `bun run gen` regenerates binding types. Local dev
  needs no provisioning - miniflare fakes R2 in `.wrangler/state/`.
- **Auth: Cloudflare Access at the edge** (Alex only), provisioned by
  `scripts/cf-access.py` - the app contains zero auth code. No runtime
  secrets: `.env.tpl` is intentionally empty; CI deploy creds are op:// refs
  in `.github/workflows/deploy.yml` only.

## Data model (what the parsers produce)

Source snapshots are `~/Documents/screen-time-backups/<YYYY-MM-DD>/` with
`knowledgeC.db.gz` + `biome-streams.tar.gz` (+ legacy `rmadmin-*.db.gz`
through 2026-07-12). Key facts (verified 2026-08-25, spike in the Notion
project note):

- **Biome `App.InFocus/remote/<device-uuid>/` SEGB segments** are the primary
  source: app-focus transition events (bundle id in the protobuf payload,
  timestamp in the SEGB record envelope). Usage duration = interval between
  consecutive events per device; SpringBoard/lock/loginwindow events mark
  screen-off. Tombstoned segments are still readable and extend coverage -
  parse `tombstone/` too. Device UUIDs: `1B05C365-…` = iPhone, `83CABE81-…` =
  MacBook (label map in `src/lib/data/devices.ts`).
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

- **Components: shadcn-svelte** in `src/lib/components/ui/` - that code is
  OURS: edit freely. Add more with `bunx shadcn-svelte@latest add <component>`.
- **Theme: the cf-site template default palette** (stock oklch light+dark
  shadcn tokens in `src/routes/layout.css`) - deliberately kept, this project
  is a test of the template's defaults. ALL tokens live in the `@theme` /
  `:root` / `.dark` blocks there; components consume tokens, never raw values.
- Icons: Tabler ONLY via `@tabler/icons-svelte` - never emojis. shadcn's
  internal Lucide usage stays.
- Charts follow the `dataviz` skill; read it before touching chart code.

## Site basics

- Every route renders `<Seo title description>`.
- Favicon (`src/lib/assets/favicon.svg`) + `static/apple-touch-icon.png` are
  purpose-driven for THIS site; theme-color metas in `src/app.html` match the
  background tokens.
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

**Deploying = commit + push to `main`.** The GHA workflow tests, builds, and
deploys - never `just deploy` locally without a stated reason. After pushing,
watch the run: `gh run watch <id> --exit-status`.

## TDD

Test first (`*.spec.ts` next to the code). All of `src/lib/data/` is pure and
unit-tested; parser correctness is anchored by the ccl-segb fixture.
