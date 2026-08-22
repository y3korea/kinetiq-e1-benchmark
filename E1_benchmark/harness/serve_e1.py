#!/usr/bin/env python3
"""
serve_e1.py — static server for the E1 harness, plus a PUT sink for corpus files.

The Tier 2 run produces tens of megabytes of landmarks per recording. Pulling that
back through the browser bridge is impractical, so the page PUTs each recording to
disk as soon as it finishes. Writing per recording (rather than once at the end)
means an interrupted run keeps everything already completed.

Writes are confined to CORPUS_DIR and the name is stripped to a bare filename, so a
path in the request cannot escape that directory.
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(ROOT)
CORPUS_DIR = os.path.expanduser("~/KinetiQ_datasets/REHAB24-6/tier2_corpus")
os.makedirs(CORPUS_DIR, exist_ok=True)

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=BASE, **kw)

    def do_PUT(self):
        if not self.path.startswith("/corpus/"):
            self.send_error(404)
            return
        name = os.path.basename(self.path[len("/corpus/"):])
        if not SAFE.match(name) or not name.endswith(".json"):
            self.send_error(400, "bad name")
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(411)
            return
        dest = os.path.join(CORPUS_DIR, name)
        remaining, written = n, 0
        with open(dest, "wb") as fh:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                written += len(chunk)
                remaining -= len(chunk)
        sys.stderr.write(f"[corpus] {name}: {written/1e6:.1f} MB\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(f'{{"written":{written},"path":"{dest}"}}'.encode())

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *a):
        pass  # keep the console readable; PUTs are logged above


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    print(f"serving {BASE} on :{port}   corpus -> {CORPUS_DIR}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
