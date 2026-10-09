"""Synthetic provisioning checks; no provider or vault calls."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import provision


class ArchiveToken(unittest.TestCase):
    def test_hub_token_is_enrolled_never_minted(self):
        # The archive credential comes from an owner-approved Soma profile
        # enrollment, so bootstrap must not mint one with operator access.
        self.assertNotIn("SOMA_HUB_TOKEN", provision.FIELDS)
        self.assertNotIn("SOMA_HUB_TOKEN", provision.MINTERS)
        self.assertIn("SOMA_ARCHIVE_PREFIX", provision.FIELDS)


class SecretDelivery(unittest.TestCase):
    def test_only_resolved_project_values_reach_deployment_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = Path(directory)
            (tools / "op").write_text('#!/bin/sh\nshift 3\nexec "$@"\n')
            (tools / "bunx").write_text(
                '#!/usr/bin/env python3\nimport os,json,sys,stat\nassert stat.S_ISFIFO(os.fstat(0).st_mode), "stdin must be a real pipe for Wrangler file reads"\nvalue=os.environ["SOMA_HUB_TOKEN"]\nassert value not in " ".join(sys.argv)\nbody=json.load(sys.stdin)\nassert body=={k:os.environ[k] for k in ["SOMA_HUB_TOKEN","SOMA_HUB_URL","SOMA_ARCHIVE_PREFIX"]}\nprint("verified")\n'
            )
            for path in tools.iterdir():
                path.chmod(0o700)
            env = {
                **os.environ,
                "PATH": directory + ":" + os.environ["PATH"],
                "SOMA_HUB_TOKEN": "fixture-only",
                "SOMA_HUB_URL": "https://hub.example",
                "SOMA_ARCHIVE_PREFIX": "raw/example/",
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
            for key in ["SOMA_HUB_TOKEN", "SOMA_HUB_URL", "SOMA_ARCHIVE_PREFIX"]:
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
