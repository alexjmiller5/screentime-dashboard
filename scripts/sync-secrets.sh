#!/usr/bin/env bash
# A shell pipe is reopenable at /dev/stdin on Linux; Bun spawn uses a socket.
# Resolve values inside op run, so only deployment logs reach its output filter.
set -euo pipefail
op run --env-file=.env.tpl -- bash -c 'set -euo pipefail
bun -e '"'"'const keys = ["LIFE_HUB_URL", "LIFE_HUB_TOKEN", "LIFE_ARCHIVE_PREFIX"];
const values = Object.fromEntries(keys.map(key => {
  const value = process.env[key];
  if (!value || value === "CHANGEME" || value.startsWith("op://") || value.includes("\n"))
    throw new Error(`A resolved ${key} is required`);
  return [key, value];
}));
process.stdout.write(JSON.stringify(values));'"'"' | bunx wrangler deploy --secrets-file /dev/stdin'
