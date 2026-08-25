// pcproxy - fetch the PC's tunnel endpoints server-side.
//
// WHY THIS EXISTS
//   School / guest networks often block the tunnel subdomains
//   (status.alexdb.xyz, calc.alexdb.xyz, ...) while leaving alexdb.xyz itself
//   reachable. The dashboard then shows the PC as offline even though it is up.
//   This function fetches those URLs from Supabase's network instead, so the
//   only host the client contacts is supabase.co.
//
// NOT AN OPEN PROXY: the target host must end in ALLOWED_SUFFIX, so this can
// only ever be pointed at the user's own tunnel. Anything else is refused.

const ALLOWED_SUFFIX = ".alexdb.xyz";
const DASHBOARD_TOKEN = Deno.env.get("DASHBOARD_TOKEN") ?? "";
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;

function cors(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-dashboard-token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const h = cors(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }),
      { status: 405, headers: { ...h, "Content-Type": "application/json" } });
  }

  // Same shared-secret gate as the chat function.
  if (DASHBOARD_TOKEN && req.headers.get("x-dashboard-token") !== DASHBOARD_TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { ...h, "Content-Type": "application/json" } });
  }

  const target = new URL(req.url).searchParams.get("url") || "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: "bad url" }),
      { status: 400, headers: { ...h, "Content-Type": "application/json" } });
  }
  const hostOk = parsed.hostname === "alexdb.xyz" || parsed.hostname.endsWith(ALLOWED_SUFFIX);
  if (parsed.protocol !== "https:" || !hostOk) {
    return new Response(JSON.stringify({ error: "host not allowed" }),
      { status: 403, headers: { ...h, "Content-Type": "application/json" } });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    clearTimeout(timer);
    const buf = new Uint8Array(await upstream.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      return new Response(JSON.stringify({ error: "response too large" }),
        { status: 413, headers: { ...h, "Content-Type": "application/json" } });
    }
    return new Response(buf, {
      status: upstream.status,
      headers: {
        ...h,
        "Content-Type": upstream.headers.get("Content-Type") || "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    clearTimeout(timer);
    return new Response(JSON.stringify({ error: "upstream unreachable", detail: String(e) }),
      { status: 502, headers: { ...h, "Content-Type": "application/json" } });
  }
});
