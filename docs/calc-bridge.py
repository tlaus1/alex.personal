"""
calc-bridge.py — serve a TI calculator file library from AlexPC to the dashboard.

Companion to status.py. Same shape: ThreadingHTTPServer + CORS + JSON, so it
drops into the existing launcher and rides the same Cloudflare tunnel setup.

WHY THIS EXISTS
    The calculator's USB cable plugs into the *Chromebook*, not the PC. So the
    PC can't push files to it directly. Instead the PC serves the library over
    HTTPS, the dashboard (alexdb.xyz) lists and downloads a file, and the
    browser hands it to the calculator over WebUSB.

ENDPOINTS
    GET /api/calc/list            -> {"files":[{name,size,type,modified}, ...]}
    GET /api/calc/get?name=FILE   -> raw bytes of that file
    GET /api/calc/health          -> {"ok":true,"count":N}

SETUP
    1. Put your .8xp / .8xg game files in  C:\\AlexPCStatus\\calc-library\\
    2. Run:  python calc-bridge.py
    3. Tunnel it:  cloudflared tunnel --url http://localhost:8770

SECURITY
    This gets exposed to the public internet through the tunnel, so:
      * only files directly inside LIBRARY_DIR are served (no traversal, no
        symlink escapes -- every path is realpath'd and re-checked)
      * only known TI calculator extensions are served
      * files above MAX_FILE_BYTES are refused
      * set ACCESS_TOKEN to require ?token=... on every request
    It is read-only by design: there is no upload/delete/execute path.
"""

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import os
import traceback

# === Edit these ===
LIBRARY_DIR = r"C:\AlexPCStatus\calc-library"
PORT = 8770
CORS_ORIGIN = "*"          # the dashboard is served from alexdb.xyz
ACCESS_TOKEN = ""          # optional: require ?token=<this> on every request
MAX_FILE_BYTES = 4 * 1024 * 1024
# ==================

# TI-8x file types the CE can actually receive.
ALLOWED_EXT = {
    ".8xp": "program",
    ".8xg": "group",
    ".8xv": "appvar",
    ".8xl": "list",
    ".8xm": "matrix",
    ".8xs": "string",
    ".8xn": "number",
    ".8xy": "y-var",
    ".8ci": "image",
    ".8ca": "image",
    ".8xk": "app",
    ".8ek": "app",
    ".8xd": "gdb",
}


def library_root():
    """Absolute, symlink-resolved library path — the trust boundary."""
    return os.path.realpath(LIBRARY_DIR)


def safe_resolve(name):
    """
    Resolve `name` to a real file *directly inside* the library, or None.

    Rejects: subdirectories, traversal (..), absolute paths, symlinks pointing
    out of the library, unknown extensions, oversized files. We compare against
    the realpath of the parent so a symlinked file can't escape.
    """
    if not name or len(name) > 255:
        return None
    # Reject anything with path structure — we serve a flat library only.
    if os.path.basename(name) != name or name in (".", ".."):
        return None
    if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
        return None

    root = library_root()
    full = os.path.realpath(os.path.join(root, name))

    # The resolved file must sit directly in the library directory.
    if os.path.dirname(full) != root:
        return None
    if not os.path.isfile(full):
        return None
    if os.path.getsize(full) > MAX_FILE_BYTES:
        return None
    return full


def list_files():
    root = library_root()
    out = []
    try:
        entries = os.listdir(root)
    except OSError:
        return out
    for name in sorted(entries):
        ext = os.path.splitext(name)[1].lower()
        if ext not in ALLOWED_EXT:
            continue
        full = safe_resolve(name)
        if not full:
            continue
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append({
            "name": name,
            "size": st.st_size,
            "type": ALLOWED_EXT[ext],
            "modified": int(st.st_mtime),
        })
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "calc-bridge/1.0"

    # ---- helpers ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _authorized(self, qs):
        if not ACCESS_TOKEN:
            return True
        return (qs.get("token", [""])[0] == ACCESS_TOKEN)

    # ---- routes ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)

        if not self._authorized(qs):
            return self._send(401, {"error": "unauthorized"})

        if path == "/api/calc/health":
            return self._send(200, {"ok": True, "count": len(list_files())})

        if path == "/api/calc/list":
            return self._send(200, {"files": list_files()})

        if path == "/api/calc/get":
            name = qs.get("name", [""])[0]
            full = safe_resolve(name)
            if not full:
                return self._send(404, {"error": "not found"})
            try:
                with open(full, "rb") as fh:
                    data = fh.read()
            except OSError:
                return self._send(500, {"error": "read failed"})
            return self._send(
                200, data, "application/octet-stream",
                {"Content-Disposition": f'attachment; filename="{os.path.basename(full)}"'},
            )

        return self._send(404, {"error": "unknown endpoint"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    try:
        root = library_root()
        if not os.path.isdir(root):
            os.makedirs(root, exist_ok=True)
            print(f"Created library folder: {root}")
        files = list_files()
        print(f"Calculator library: {root}")
        print(f"  {len(files)} file(s) ready")
        for f in files[:10]:
            print(f"   - {f['name']}  ({f['type']}, {f['size']} bytes)")
        if len(files) > 10:
            print(f"   ... and {len(files) - 10} more")
        print(f"\ncalc-bridge running on http://0.0.0.0:{PORT}/api/calc/list")
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    except Exception:
        print("\n!!! ERROR !!!\n")
        traceback.print_exc()
    finally:
        input("\nPress Enter to close...")
