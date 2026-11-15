"""The hosted demo on Modal: the Node app in public demo mode, with the sample repo built into the image.

    modal deploy deploy/modal_app.py

Run from the repo root (any folder works: paths are taken from this file). One container at most; it sleeps
after 10 idle minutes, and the next visitor waits for a cold start. PUBLIC_DEMO=1 keeps every visitor's
sign-offs and eval marks in their own browser and rate-limits each visitor (see src/server.mjs).
"""

import subprocess
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[1]
PORT = 8000
NODE_VERSION = "22.23.5"
NODE_SHA256 = "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1"  # nodejs.org SHASUMS256.txt
NODE_TARBALL = f"node-v{NODE_VERSION}-linux-x64.tar.gz"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "curl", "ca-certificates")
    .run_commands(
        f"curl -fsSL -o /tmp/{NODE_TARBALL} https://nodejs.org/dist/v{NODE_VERSION}/{NODE_TARBALL}",
        f"echo '{NODE_SHA256}  /tmp/{NODE_TARBALL}' | sha256sum -c -",
        f"tar -xzf /tmp/{NODE_TARBALL} -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE",
        f"rm /tmp/{NODE_TARBALL}",
    )
    .add_local_dir(ROOT, "/app", copy=True, ignore=["node_modules", "**/node_modules", ".git", ".demo", "**/__pycache__"])
    .workdir("/app")
    # Saved evidence only: --no-review never asks a model, even if a saved review does not match.
    .run_commands("npm ci --omit=dev", "npm run setup -- --no-review")
    .env({"HOST": "0.0.0.0", "PORT": str(PORT), "PUBLIC_DEMO": "1"})
)

app = modal.App("impact", image=image)


@app.function(min_containers=0, max_containers=1, scaledown_window=600)
@modal.concurrent(max_inputs=100)
@modal.web_server(PORT, startup_timeout=60, label="map")
def web():
    subprocess.Popen(["node", "src/server.mjs"], cwd="/app")
