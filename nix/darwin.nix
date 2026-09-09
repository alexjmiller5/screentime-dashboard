# nix-darwin module: keep a Screentime Dashboard fed from this Mac.
#
# Two pieces:
#   - the WATCH daemon (launchd, kept alive) long-polls the dashboard's public,
#     credential-free "refresh requested?" flag and acts on each request with
#     bounded retries: it kickstarts the screentime-backup agent - whose
#     post-run hook must run `config.services.screentime-ingest.syncCommand`
#     (wire services.screentime-backup.postRun) - and for a "rebuild" request
#     first sets the skip-dump flag (wire services.screentime-backup.skipDumpFlag
#     = config.services.screentime-ingest.skipDumpFlag) so the agent only
#     runs the hook. Without a backup agent the daemon runs the sync itself.
#   - `sync` (the exported syncCommand) parses every snapshot in backupsDir
#     and pushes the series to the dashboard through Cloudflare Access with a
#     service token, read at run time from `credentialCommand`.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.screentime-ingest;
  pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
  logFile = "/Users/${cfg.user}/Library/Logs/screentime-ingest.log";
  stateDir = "/Users/${cfg.user}/Library/Application Support/screentime-ingest";
  # The CLI with this machine's wiring baked in (env is the CLI's config seam).
  wrapper = pkgs.writeShellScriptBin "screentime-ingest" ''
    export SCREENTIME_DASHBOARD_URL=${lib.escapeShellArg cfg.url}
    export SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND=${lib.escapeShellArg cfg.credentialCommand}
    export SCREENTIME_BACKUPS_DIR=${lib.escapeShellArg cfg.backupsDir}
    export SCREENTIME_STATE_DIR=${lib.escapeShellArg stateDir}
    export SCREENTIME_HOLD_SECONDS=${toString cfg.holdSeconds}
    ${lib.optionalString (cfg.backupLabel != "") "export SCREENTIME_BACKUP_LABEL=${lib.escapeShellArg cfg.backupLabel}"}
    ${lib.optionalString (cfg.timeZone != null) "export SCREENTIME_TIME_ZONE=${lib.escapeShellArg cfg.timeZone}"}
    exec ${pkg}/bin/screentime-ingest "$@" >> ${lib.escapeShellArg logFile} 2>&1
  '';
in
{
  options.services.screentime-ingest = {
    enable = lib.mkEnableOption "feeding a Screentime Dashboard from this Mac's screentime-backup snapshots";

    user = lib.mkOption {
      type = lib.types.str;
      description = "Login user whose backups folder is read and whose launchd domain runs the agents.";
      example = "alexmiller";
    };

    url = lib.mkOption {
      type = lib.types.str;
      description = "Base URL of the deployed dashboard.";
      example = "https://screentime-dashboard.example.workers.dev";
    };

    credentialCommand = lib.mkOption {
      type = lib.types.str;
      description = ''
        Shell command printing {"clientId": ..., "clientSecret": ...} - the
        Cloudflare Access service token the dashboard admits. Run only when a
        refresh attempt or sync actually happens, never during idle polling.
        Heartbeats reuse the credential in memory.
      '';
    };

    backupsDir = lib.mkOption {
      type = lib.types.str;
      default = "/Users/${cfg.user}/Documents/screen-time-backups";
      defaultText = lib.literalExpression ''"/Users/''${user}/Documents/screen-time-backups"'';
      description = "screentime-backup's output folder (one dated subfolder per snapshot).";
    };

    backupLabel = lib.mkOption {
      type = lib.types.str;
      default = "com.alexmiller.screentime-backup";
      description = ''
        launchd label of the screentime-backup agent the poll kickstarts on a
        refresh request. Its postRun must be this module's syncCommand. Empty
        string = no backup agent here; the poll syncs the folder as-is.
      '';
    };

    holdSeconds = lib.mkOption {
      type = lib.types.int;
      default = 30;
      description = "How long each long-poll of the refresh flag is held (0-30). Pickup latency is ~0 either way; this only sets the request rate.";
    };

    skipDumpFlag = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${stateDir}/skip-dump";
      description = "The flag file a rebuild request sets - hand it to services.screentime-backup.skipDumpFlag.";
    };

    timeZone = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "IANA time zone the daily series are bucketed in (default: the system zone).";
    };

    syncCommand = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${wrapper}/bin/screentime-ingest sync";
      description = "The sync entry point with this machine's config baked in - hand it to services.screentime-backup.postRun.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ wrapper ];

    launchd.user.agents.screentime-ingest-watch = {
      serviceConfig = {
        Label = "com.alexmiller.screentime-dashboard.watch";
        ProgramArguments = [
          "${wrapper}/bin/screentime-ingest"
          "watch"
        ];
        KeepAlive = true;
        RunAtLoad = true;
        # A crashing daemon must not become a hot loop (it never reads a
        # credential, but it does hit the Worker).
        ThrottleInterval = 30;
        ProcessType = "Background";
        StandardOutPath = logFile;
        StandardErrorPath = logFile;
      };
    };
  };
}
