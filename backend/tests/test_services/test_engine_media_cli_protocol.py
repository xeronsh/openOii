"""The media worker's stdout carries one JSON reply per request and nothing else (#145)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]

# Stand-in for a library that prints while loading (InsightFace prints one line
# per ONNX model), from Python and from native code.
WORKER = """
import os
from app.services import engine_media_cli as cli

async def handle(request):
    print("find model: det_10g.onnx")
    os.write(1, b"native loader chatter\\n")
    return {"ok": request["n"]}

cli.handle = handle
cli.main()
"""


def test_library_chatter_stays_off_the_protocol_stream():
    env = {**os.environ, "PYTHONPATH": str(BACKEND_DIR)}
    done = subprocess.run(
        [sys.executable, "-c", WORKER],
        input='{"n": 1}\n{"n": 2}\n',
        capture_output=True,
        text=True,
        cwd=BACKEND_DIR,
        env=env,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    replies = [json.loads(line) for line in done.stdout.splitlines()]
    assert replies == [{"ok": 1}, {"ok": 2}]
    assert "find model: det_10g.onnx" in done.stderr
    assert "native loader chatter" in done.stderr
