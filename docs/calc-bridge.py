"""
calc-bridge.py - serve a TI calculator file library from AlexPC to the dashboard.

Companion to status.py. Same shape: ThreadingHTTPServer + CORS + JSON, so it
drops into the existing launcher and rides the same Cloudflare tunnel setup.

WHY THIS EXISTS
    The calculator's USB cable plugs into the *Chromebook*, not the PC. So the
    PC can't push files to it directly. Instead the PC serves the library over
    HTTPS, the dashboard (alexdb.xyz) lists and downloads a file, and the
    browser hands it to the calculator over WebUSB.

ENDPOINTS
    GET  /api/calc/list           -> {"files":[{name,size,type,modified}, ...]}
    GET  /api/calc/get?name=FILE  -> raw bytes of that file
    GET  /api/calc/health         -> {"ok":true,"count":N}

    GET  /api/files/list          -> shared folder listing (any file type)
    GET  /api/files/get?name=FILE -> download a shared file to this device
    POST /api/files/upload?name=F -> upload FROM a device TO the PC (raw body)
    DELETE /api/files/delete?name=F -> remove a shared file

    The /api/files/* half is a general PC <-> device transfer drop. WRITES
    (upload/delete) are DISABLED unless ACCESS_TOKEN is set -- see SECURITY.

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
    The calculator half is strictly read-only. The file-share half can accept
    uploads, so it is locked down harder:
      * uploads/deletes are REFUSED ENTIRELY unless ACCESS_TOKEN is set
      * uploaded names are sanitised (basename only, safe charset, length cap,
        Windows reserved names rejected) and never overwrite -- collisions get
        " (1)", " (2)" appended
      * nothing is ever executed; files are only written to SHARE_DIR
"""

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import os
import re
import traceback

# === Edit these ===
LIBRARY_DIR = r"C:\AlexPCStatus\calc-library"   # calculator files (read-only)
SHARE_DIR   = r"C:\AlexPCStatus\shared"         # PC <-> device transfer drop
PORT = 8770
CORS_ORIGIN = "*"          # the dashboard is served from alexdb.xyz
ACCESS_TOKEN = ""          # set this to enable uploads/deletes (and gate reads)
MAX_FILE_BYTES = 4 * 1024 * 1024          # calculator files
MAX_SHARE_BYTES = 256 * 1024 * 1024       # shared files (upload + download cap)
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
    ".8xd": "gdb",
}
# NOTE: Flash applications (.8xk / .8ek) are deliberately NOT listed. They use
# the "**TIFL**" container, not the "**TI83F*" variable format the WebUSB link
# library understands, and TI-signed flash apps need a different transfer path.
# Listing them would show files in the dashboard that always fail on send.


def library_root():
    """Absolute, symlink-resolved library path - the trust boundary."""
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
    # Reject anything with path structure - we serve a flat library only.
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


# ---------------- shared folder (PC <-> device transfer) ----------------
# Windows device names that must never become filenames.
_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}


def share_root():
    """Absolute, symlink-resolved share path - the trust boundary for uploads."""
    return os.path.realpath(SHARE_DIR)


def sanitize_name(name):
    """
    Turn a client-supplied filename into something safe to write.

    Basename only (kills ../ and absolute paths), restricted charset, length
    capped, no leading/trailing dots or spaces, no Windows reserved names.
    Returns None if nothing usable survives.
    """
    name = os.path.basename(name or "").replace("\\", "/")
    name = os.path.basename(name)
    name = re.sub(r"[^A-Za-z0-9._ ()\-]", "_", name)
    name = name.strip(". ")
    if not name or len(name) > 120:
        name = name[:120].strip(". ")
    if not name:
        return None
    if os.path.splitext(name)[0].upper() in _RESERVED:
        return None
    return name


def share_resolve(name):
    """Resolve `name` to a real file directly inside the share dir, or None."""
    if not name or len(name) > 255:
        return None
    if os.path.basename(name) != name or name in (".", ".."):
        return None
    root = share_root()
    full = os.path.realpath(os.path.join(root, name))
    if os.path.dirname(full) != root or not os.path.isfile(full):
        return None
    return full


def unique_path(root, name):
    """Never overwrite: foo.txt -> 'foo (1).txt' -> 'foo (2).txt' ..."""
    stem, ext = os.path.splitext(name)
    candidate = os.path.join(root, name)
    n = 1
    while os.path.exists(candidate):
        candidate = os.path.join(root, f"{stem} ({n}){ext}")
        n += 1
        if n > 999:
            return None
    return candidate


def list_shared():
    root = share_root()
    out = []
    try:
        entries = os.listdir(root)
    except OSError:
        return out
    for name in sorted(entries):
        full = share_resolve(name)
        if not full:
            continue
        try:
            st = os.stat(full)
        except OSError:
            continue
        if st.st_size > MAX_SHARE_BYTES:
            continue
        out.append({
            "name": name,
            "size": st.st_size,
            "ext": os.path.splitext(name)[1].lower().lstrip("."),
            "modified": int(st.st_mtime),
        })
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "calc-bridge/1.0"

    # ---- helpers ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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

    def _may_write(self, qs):
        """Writes require a configured token AND a matching one. No token set
        means the share is read-only - a safe default for a public tunnel."""
        return bool(ACCESS_TOKEN) and qs.get("token", [""])[0] == ACCESS_TOKEN

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

        if path == "/api/files/health":
            return self._send(200, {"ok": True, "count": len(list_shared()),
                                    "uploads": bool(ACCESS_TOKEN)})

        if path == "/api/files/list":
            return self._send(200, {"files": list_shared(), "uploads": bool(ACCESS_TOKEN)})

        if path == "/api/files/get":
            full = share_resolve(qs.get("name", [""])[0])
            if not full:
                return self._send(404, {"error": "not found"})
            try:
                if os.path.getsize(full) > MAX_SHARE_BYTES:
                    return self._send(413, {"error": "file too large"})
                with open(full, "rb") as fh:
                    data = fh.read()
            except OSError:
                return self._send(500, {"error": "read failed"})
            return self._send(
                200, data, "application/octet-stream",
                {"Content-Disposition": f'attachment; filename="{os.path.basename(full)}"'},
            )

        return self._send(404, {"error": "unknown endpoint"})

    def do_POST(self):
        """Upload a file FROM a device TO the PC. Raw body, name in the query."""
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path.rstrip("/") != "/api/files/upload":
            return self._send(404, {"error": "unknown endpoint"})
        if not self._may_write(qs):
            return self._send(403, {"error": "uploads disabled - set ACCESS_TOKEN on the PC"})

        name = sanitize_name(qs.get("name", [""])[0])
        if not name:
            return self._send(400, {"error": "bad filename"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send(400, {"error": "bad length"})
        if length <= 0:
            return self._send(400, {"error": "empty body"})
        if length > MAX_SHARE_BYTES:
            return self._send(413, {"error": "file too large"})

        root = share_root()
        os.makedirs(root, exist_ok=True)
        target = unique_path(root, name)
        if not target:
            return self._send(409, {"error": "too many name collisions"})

        # Stream to disk so a big upload doesn't sit in memory.
        remaining = length
        try:
            with open(target, "wb") as fh:
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
        except OSError:
            try:
                os.remove(target)
            except OSError:
                pass
            return self._send(500, {"error": "write failed"})

        if remaining > 0:                      # client hung up mid-upload
            try:
                os.remove(target)
            except OSError:
                pass
            return self._send(400, {"error": "incomplete upload"})

        return self._send(200, {"ok": True, "name": os.path.basename(target),
                                "size": length})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path.rstrip("/") != "/api/files/delete":
            return self._send(404, {"error": "unknown endpoint"})
        if not self._may_write(qs):
            return self._send(403, {"error": "deletes disabled - set ACCESS_TOKEN on the PC"})
        full = share_resolve(qs.get("name", [""])[0])
        if not full:
            return self._send(404, {"error": "not found"})
        try:
            os.remove(full)
        except OSError:
            return self._send(500, {"error": "delete failed"})
        return self._send(200, {"ok": True})

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
        sroot = share_root()
        os.makedirs(sroot, exist_ok=True)
        shared = list_shared()
        print(f"\nShared folder:      {sroot}")
        print(f"  {len(shared)} file(s) - uploads {'ENABLED' if ACCESS_TOKEN else 'DISABLED (set ACCESS_TOKEN to enable)'}")
        print(f"\ncalc-bridge running on http://0.0.0.0:{PORT}")
        print(f"  calculator: /api/calc/list")
        print(f"  files:      /api/files/list")
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    except Exception:
        print("\n!!! ERROR !!!\n")
        traceback.print_exc()
    finally:
        input("\nPress Enter to close...")
