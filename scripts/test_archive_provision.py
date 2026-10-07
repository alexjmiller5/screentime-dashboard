"""Synthetic provisioning checks; no provider or vault calls."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import provision


class ArchiveToken(unittest.TestCase):
    def test_scopes_are_only_the_configured_retained_file_prefix(self):
        scopes = "files:read:raw/example/,files:write:raw/example/"
        with (
            patch.dict(os.environ, {"LIFE_ARCHIVE_PREFIX": "raw/example/"}),
            patch.object(provision.subprocess, "run") as run,
        ):
            run.side_effect = [
                subprocess.CompletedProcess([], 0, "[]", ""),
                subprocess.CompletedProcess(
                    [], 0, json.dumps({"token": "fixture", "scopes": scopes}), ""
                ),
            ]
            self.assertEqual(provision.mint_hub_token(), "fixture")
            self.assertEqual(
                run.call_args.args[0],
                [
                    "life",
                    "token",
                    "create",
                    "screentime-dashboard-archive",
                    "--scopes",
                    scopes,
                ],
            )

    def test_never_replaces_an_existing_consumer_token(self):
        with (
            patch.dict(os.environ, {"LIFE_ARCHIVE_PREFIX": "raw/example/"}),
            patch.object(provision.subprocess, "run") as run,
        ):
            run.return_value = subprocess.CompletedProcess(
                [], 0, '[{"name":"screentime-dashboard-archive","revoked_at":null}]', ""
            )
            with self.assertRaises(RuntimeError):
                provision.mint_hub_token()
            self.assertEqual(run.call_count, 1)

    def test_malformed_or_broadened_scope_is_rejected(self):
        for prefix in ["", "raw/example", "raw/example/,full", "../"]:
            with (
                patch.dict(os.environ, {"LIFE_ARCHIVE_PREFIX": prefix}),
                patch.object(provision.subprocess, "run") as run,
            ):
                with self.assertRaises(RuntimeError):
                    provision.mint_hub_token()
                run.assert_not_called()


class SecretDelivery(unittest.TestCase):
    def test_only_resolved_project_values_reach_deployment_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = Path(directory)
            (tools / "op").write_text('#!/bin/sh\nshift 3\nexec "$@"\n')
            (tools / "bunx").write_text(
                '#!/usr/bin/env python3\nimport os,json,sys\nvalue=os.environ["LIFE_HUB_TOKEN"]\nassert value not in " ".join(sys.argv)\nbody=json.load(sys.stdin)\nassert body=={k:os.environ[k] for k in ["LIFE_HUB_TOKEN","LIFE_HUB_URL","LIFE_ARCHIVE_PREFIX"]}\nprint("verified")\n'
            )
            for path in tools.iterdir():
                path.chmod(0o700)
            env = {
                **os.environ,
                "PATH": directory + ":" + os.environ["PATH"],
                "LIFE_HUB_TOKEN": "fixture-only",
                "LIFE_HUB_URL": "https://hub.example",
                "LIFE_ARCHIVE_PREFIX": "raw/example/",
            }
            script = Path(__file__).with_name("sync-secrets.sh")
            good = subprocess.run(
                ["bash", str(script)],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertEqual(good.stdout.strip(), "verified")
            for key in ["LIFE_HUB_TOKEN", "LIFE_HUB_URL", "LIFE_ARCHIVE_PREFIX"]:
                for bad in ["", "CHANGEME", "op://unresolved/value", "invalid\nvalue"]:
                    result = subprocess.run(
                        ["bash", str(script)],
                        env={**env, key: bad},
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
