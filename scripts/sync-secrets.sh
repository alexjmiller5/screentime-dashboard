#!/usr/bin/env bash
# Resolve this project's values in memory, then deploy code and secrets together.
set -euo pipefail
op run --env-file=.env.tpl -- bun -e '
const keys = ["LIFE_HUB_URL", "LIFE_HUB_TOKEN", "LIFE_ARCHIVE_PREFIX"];
const values = Object.fromEntries(keys.map(key => {
  const value = process.env[key];
  if (!value || value === "CHANGEME" || value.startsWith("op://") || value.includes("\n"))
    throw new Error(`A resolved ${key} is required`);
  return [key, value];
}));
const child = Bun.spawn(["bunx", "wrangler", "deploy", "--secrets-file", "/dev/stdin"], {stdin:"pipe", stdout:"inherit", stderr:"inherit"});
child.stdin.write(JSON.stringify(values)); child.stdin.end(); process.exit(await child.exited);
'
