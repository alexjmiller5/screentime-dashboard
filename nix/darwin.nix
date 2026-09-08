# nix-darwin module: keep a Screentime Dashboard fed from this Mac.
#
# Two pieces, both launchd user agents:
#   - the POLL agent asks the dashboard every `pollInterval` seconds whether a
#     refresh was requested (a public, credential-free flag) and, if so,
#     kickstarts the screentime-backup agent - whose post-run hook must run
#     `config.services.screentime-ingest.syncCommand` (wire it via
#     services.screentime-backup.postRun). Without a backup agent the poll
#     runs the sync itself.
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
  # The CLI with this machine's wiring baked in (env is the CLI's config seam).
  wrapper = pkgs.writeShellScriptBin "screentime-ingest" ''
    export SCREENTIME_DASHBOARD_URL=${lib.escapeShellArg cfg.url}
    export SCREENTIME_DASHBOARD_CREDENTIAL_COMMAND=${lib.escapeShellArg cfg.credentialCommand}
    export SCREENTIME_BACKUPS_DIR=${lib.escapeShellArg cfg.backupsDir}
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
        sync actually happens, never by the poll.
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

    pollInterval = lib.mkOption {
      type = lib.types.int;
      default = 60;
      description = "Seconds between refresh-flag polls.";
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

    launchd.user.agents.screentime-ingest-poll = {
      serviceConfig = {
        Label = "com.alexmiller.screentime-dashboard.poll";
        ProgramArguments = [
          "${wrapper}/bin/screentime-ingest"
          "poll"
        ];
        StartInterval = cfg.pollInterval;
        RunAtLoad = true;
        ProcessType = "Background";
        StandardOutPath = logFile;
        StandardErrorPath = logFile;
      };
    };
  };
}
