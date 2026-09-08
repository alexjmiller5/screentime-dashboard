# screentime-ingest: Bun runs the TypeScript sources straight from the store.
# The ingest path (src/lib/data, src/lib/import, src/ingest) has no npm
# dependencies - SQLite is bun:sqlite, gzip is DecompressionStream - so no
# node_modules is needed.
{ lib, bun, writeShellScriptBin }:
let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.intersection (lib.fileset.fileFilter (f: !lib.hasSuffix ".spec.ts" f.name) ../.) (
      lib.fileset.unions [
        ../src/lib/data
        ../src/lib/import
        ../src/lib/server/store.ts
        ../src/ingest
      ]
    );
  };
in
(writeShellScriptBin "screentime-ingest" ''
  exec ${bun}/bin/bun run ${src}/src/ingest/cli.ts "$@"
'').overrideAttrs
  (_: {
    meta = {
      description = "Rebuild Screentime Dashboard series from screentime-backup snapshots and push them to the dashboard";
      mainProgram = "screentime-ingest";
      platforms = lib.platforms.all;
    };
  })
