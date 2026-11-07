// alert - lets an outside agent (Tomo AI, a script, anything that can POST)
// push a notification into the dashboard.
//
// WRITE-ONLY by design. The sender proves itself with ALERT_INGEST_TOKEN, a
// secret separate from everything else. That token can add alerts and nothing
// more: reading alerts needs the dashboard login (RLS on public.alerts), so a
// leaked token cannot be used to read your mail summaries back out.
//
//   POST /functions/v1/alert
//   Authorization: Bearer <ALERT_INGEST_TOKEN>
//   { "title": "...", "body": "...", "level": "info|warn|urgent",
//     "source": "tomo", "url": "https://..." }

const INGEST_TOKEN = Deno.env.get("ALERT_INGEST_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_PER_MINUTE = 20;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// Constant-time comparison so the token cannot be recovered by timing guesses.
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Strip control characters and cap length; the text is shown verbatim.
function clean(v: unknown, max: number): string {
  return String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!INGEST_TOKEN || !SERVICE_KEY) return json({ error: "alert ingest is not configured" }, 503);

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);

  const raw = await req.text();
  if (raw.length > 8192) return json({ error: "payload too large" }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return json({ error: "body must be JSON" }, 400); }

  const title = clean(body.title, 140);
  if (!title) return json({ error: "title is required" }, 400);
  const level = ["info", "warn", "urgent"].includes(String(body.level)) ? String(body.level) : "info";
  const url = clean(body.url, 500);
  const row = {
    title,
    body: clean(body.body, 2000) || null,
    level,
    source: clean(body.source, 40) || "tomo",
    // Only https links survive; everything else is dropped rather than rejected.
    url: /^https:\/\/[^\s]+$/i.test(url) ? url : null,
  };

  const rest = `${SUPABASE_URL}/rest/v1/alerts`;
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

  // Cheap flood guard: a runaway agent cannot bury the dashboard.
  const since = new Date(Date.now() - 60_000).toISOString();
  const recent = await fetch(`${rest}?select=id&created_at=gte.${encodeURIComponent(since)}`, {
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
  });
  const total = Number((recent.headers.get("content-range") ?? "").split("/")[1] ?? 0);
  if (total >= MAX_PER_MINUTE) return json({ error: "rate limited" }, 429);

  // PGRST303 "JWT issued at future" means Supabase's token signer is briefly
  // ahead of its own API clock; the request is fine, it is just early.
  let ins: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    ins = await fetch(rest, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (ins.ok) break;
    const text = await ins.clone().text();
    if (!/PGRST303|issued at future/i.test(text)) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (!ins || !ins.ok) return json({ error: "could not store alert", detail: ins ? await ins.text() : "no response" }, 500);
  const [saved] = await ins.json();
  return json({ ok: true, id: saved?.id }, 201);
});
