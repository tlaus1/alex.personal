// xtrack - the server half of the dashboard's X Tracker panel.
//
// The twitterapi.io key lives only here (secret TWITTERAPI_KEY). The browser
// calls this with its normal Supabase login; we work out who it is, talk to
// twitterapi.io, and write rows with the service role. RLS lets the browser
// read and delete its own rows but never insert them.
//
//   POST /functions/v1/xtrack   Authorization: Bearer <user access token>
//   { "action": "add",  "handle": "elonmusk" }   validate + track + seed recent posts
//   { "action": "poll" }                         fetch anything new (throttled)
//
// TWO MODES
//   Free (no TWITTERAPI_KEY set): reads X's public embedded-timeline feed
//   (syndication.twitter.com, what "embed this profile" widgets use). No key,
//   no login, no cost. X allows roughly 30 of these requests per 15 minutes
//   per IP, and Supabase's IPs are shared, so each poll checks ONE account
//   (least recently checked first) and backs off when X says to. Replies are
//   not included, and a few giant accounts get a "top posts" feed instead of
//   their latest, so this is best-effort. X can change or close it anytime.
//   Paid (TWITTERAPI_KEY set): twitterapi.io search, below.
//
// COST (twitterapi.io, 100,000 credits = $1): every search call costs at least
// 15 credits, then 15 per tweet. One poll covers all tracked accounts in one
// query, so polling every 30s while the dashboard is open is roughly $0.015/hr.
// The server-side throttle means several open tabs/devices share one poll.

const API_KEY = Deno.env.get("TWITTERAPI_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MIN_GAP_S = Math.max(10, Number(Deno.env.get("XTRACK_MIN_GAP_S") ?? 15));
const MAX_ACCOUNTS = 30;
const MAX_PAGES = 3;              // per query chunk per poll
const KEEP_DAYS = 7;
const TAPI = "https://api.twitterapi.io";
const FREE = !API_KEY;
const FREE_MIN_GAP_S = 20;
const SYND = "https://syndication.twitter.com/srv/timeline-profile/screen-name/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const REST = `${SUPABASE_URL}/rest/v1`;
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, max);
const https = (v: unknown) => (typeof v === "string" && /^https:\/\/[^\s"'<>]+$/i.test(v) ? v.slice(0, 500) : null);

class TapiError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

// One twitterapi.io GET. Free (never topped up) keys are limited to one
// request per 5 seconds, so a 429 waits that out once before giving up.
async function tapi(path: string, params: Record<string, string>): Promise<any> {
  const url = `${TAPI}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { "x-api-key": API_KEY } });
    if (r.status === 429 || r.status >= 500) { await sleep(5500); continue; }
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    if (r.status === 402) throw new TapiError(402, "twitterapi.io is out of credits - top up at twitterapi.io/dashboard");
    if (r.status === 401 || r.status === 403) throw new TapiError(r.status, "twitterapi.io rejected the API key (TWITTERAPI_KEY)");
    if (!r.ok) throw new TapiError(r.status, clean(body?.detail || body?.message || text, 200) || `HTTP ${r.status}`);
    return body;
  }
  throw new TapiError(429, "twitterapi.io is rate limiting; try again shortly");
}

// Who is calling? Ask Supabase Auth to vouch for the bearer token.
async function callerId(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return typeof u?.id === "string" ? u.id : null;
}

// Swap t.co links for where they actually go, so the feed shows real URLs.
function expandText(t: any): string {
  let text = String(t?.text ?? "");
  for (const u of t?.entities?.urls ?? []) {
    if (u?.url && u?.expanded_url) text = text.split(u.url).join(u.expanded_url);
  }
  return clean(text, 30000);
}

function firstMedia(t: any): string | null {
  const m = t?.extendedEntities?.media?.[0] ?? t?.extended_entities?.media?.[0] ?? t?.entities?.media?.[0];
  const u = m?.media_url_https;
  return typeof u === "string" && u.startsWith("https://pbs.twimg.com/") ? u.slice(0, 500) : null;
}

function toRow(userId: string, t: any) {
  const id = String(t?.id ?? "");
  if (!/^[0-9]{1,25}$/.test(id)) return null;
  const a = t?.author ?? {};
  const handle = String(a.userName ?? "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return null;
  const rt = t?.retweeted_tweet, qt = t?.quoted_tweet;
  const kind = rt ? "retweet" : qt ? "quote" : t?.isReply ? "reply" : "tweet";
  const inner = rt || qt;
  const created = new Date(t?.createdAt ?? Date.now());
  return {
    user_id: userId,
    tweet_id: id,
    handle,
    author_name: clean(a.name, 100) || null,
    avatar: https(a.profilePicture),
    kind,
    text: rt ? "" : expandText(t),
    reply_to: t?.isReply && t?.inReplyToUsername ? clean(t.inReplyToUsername, 15) : null,
    quoted: inner ? {
      handle: clean(inner?.author?.userName, 15),
      name: clean(inner?.author?.name, 100),
      text: expandText(inner).slice(0, 4000),
    } : null,
    media: firstMedia(t) ?? (inner ? firstMedia(inner) : null),
    url: https(t?.url) ?? `https://x.com/${handle}/status/${id}`,
    created_at: isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
  };
}

async function storePosts(rows: any[]): Promise<number> {
  if (!rows.length) return 0;
  const r = await fetch(`${REST}/x_posts?on_conflict=user_id,tweet_id`, {
    method: "POST",
    headers: { ...svc, Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`could not store posts: ${await r.text()}`);
  return (await r.json()).length;
}

async function addCredits(userId: string, credits: number, extra: Record<string, unknown> = {}) {
  // Read-modify-write is fine here: polls for one user are already serialised
  // by the throttle, and this number is an estimate for the UI.
  const cur = await fetch(`${REST}/x_poll_state?user_id=eq.${userId}&select=credits`, { headers: svc }).then((r) => r.json()).catch(() => []);
  const total = Number(cur?.[0]?.credits ?? 0) + credits;
  await fetch(`${REST}/x_poll_state?user_id=eq.${userId}`, {
    method: "PATCH", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify({ credits: total, ...extra }),
  });
}

async function ensureState(userId: string) {
  await fetch(`${REST}/x_poll_state?on_conflict=user_id`, {
    method: "POST",
    headers: { ...svc, Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId }),
  });
}

// ---------- free mode: X's public embed feed ----------
const unescapeHtml = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// v1.1-style tweet text: expand t.co links, drop the t.co that just points at attached media.
function v1Text(t: any): string {
  let text = String(t?.full_text ?? t?.text ?? "");
  for (const u of t?.entities?.urls ?? []) if (u?.url && u?.expanded_url) text = text.split(u.url).join(u.expanded_url);
  for (const m of t?.extended_entities?.media ?? t?.entities?.media ?? []) if (m?.url) text = text.split(m.url).join("");
  return clean(unescapeHtml(text).trim(), 30000);
}
const v1Media = (t: any) => {
  const u = (t?.extended_entities?.media ?? t?.entities?.media ?? [])[0]?.media_url_https;
  return typeof u === "string" && u.startsWith("https://pbs.twimg.com/") ? u.slice(0, 500) : null;
};

function v1Row(userId: string, t: any) {
  const id = String(t?.id_str ?? "");
  if (!/^[0-9]{1,25}$/.test(id)) return null;
  const handle = String(t?.user?.screen_name ?? "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return null;
  const rt = t?.retweeted_status, qt = t?.quoted_status;
  const inner = rt || qt;
  const created = new Date(t?.created_at ?? "");
  if (isNaN(created.getTime())) return null;
  return {
    user_id: userId,
    tweet_id: id,
    handle,
    author_name: clean(t.user.name, 100) || null,
    avatar: https(String(t.user.profile_image_url_https ?? "").replace("_normal.", "_bigger.")),
    kind: rt ? "retweet" : qt ? "quote" : t?.in_reply_to_screen_name ? "reply" : "tweet",
    text: rt ? "" : v1Text(t),
    reply_to: t?.in_reply_to_screen_name ? clean(t.in_reply_to_screen_name, 15) : null,
    quoted: inner ? { handle: clean(inner?.user?.screen_name, 15), name: clean(inner?.user?.name, 100), text: v1Text(inner).slice(0, 4000) } : null,
    media: v1Media(t) ?? (inner ? v1Media(inner) : null),
    url: `https://x.com/${handle}/status/${id}`,
    created_at: created.toISOString(),
  };
}

class RateLimited extends Error { constructor(public until: Date) { super("X rate limit"); } }

// Fetch one account's embed timeline. Throws RateLimited when X says stop.
async function syndication(handle: string): Promise<{ tweets: any[]; remaining: number; reset: Date | null }> {
  const r = await fetch(SYND + encodeURIComponent(handle), { headers: { "User-Agent": UA, "Accept": "text/html" } });
  const remaining = Number(r.headers.get("x-rate-limit-remaining") ?? 99);
  const resetS = Number(r.headers.get("x-rate-limit-reset") ?? 0);
  const reset = resetS ? new Date(resetS * 1000) : null;
  if (r.status === 429) throw new RateLimited(reset && reset.getTime() > Date.now() ? reset : new Date(Date.now() + 5 * 60_000));
  if (!r.ok) throw new Error(`X embed feed returned HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error("X embed feed changed shape (no data block)");
  const entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries ?? [];
  const tweets = entries.map((e: any) => e?.content?.tweet).filter(Boolean);
  return { tweets, remaining, reset };
}

function freshRows(userId: string, tweets: any[]) {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;          // skips old pinned / "top" posts
  return tweets.map((t) => v1Row(userId, t)).filter((r): r is NonNullable<typeof r> => !!r && new Date(r.created_at).getTime() > cutoff);
}

async function setBackoff(userId: string, until: Date | null, error: string | null) {
  await fetch(`${REST}/x_poll_state?user_id=eq.${userId}`, {
    method: "PATCH", headers: { ...svc, Prefer: "return=minimal" },
    body: JSON.stringify({ backoff_until: until ? until.toISOString() : null, last_error: error }),
  });
}

async function freeProfile(handle: string) {
  // fxtwitter is a public, keyless mirror of profile info (name, avatar, followers).
  const r = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, { headers: { "User-Agent": "alexdb-xtrack" } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.user?.screen_name) return null;
  const u = j.user;
  return { userName: u.screen_name, id: u.id, name: u.name, profilePicture: u.avatar_url, followers: u.followers, protected: !!u.protected };
}

async function freePoll(userId: string, state: any) {
  if (state.backoff_until && new Date(state.backoff_until).getTime() > Date.now()) {
    return { status: 200, body: { ok: true, mode: "free", skipped: true, backoff_until: state.backoff_until } };
  }
  const accts = await fetch(`${REST}/x_accounts?user_id=eq.${userId}&select=handle,checked_at&order=checked_at.asc.nullsfirst&limit=1`, { headers: svc }).then((r) => r.json());
  if (!accts.length) return { status: 200, body: { ok: true, mode: "free", inserted: 0 } };
  const handle = accts[0].handle;
  await fetch(`${REST}/x_accounts?user_id=eq.${userId}&handle=eq.${handle}`, {
    method: "PATCH", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify({ checked_at: new Date().toISOString() }),
  });
  try {
    const { tweets, remaining, reset } = await syndication(handle);
    const inserted = await storePosts(freshRows(userId, tweets));
    // Leave headroom: the IP is shared, so stop before X has to tell us to.
    const backoff = remaining <= 2 && reset && reset.getTime() > Date.now() ? reset : null;
    await setBackoff(userId, backoff, null);
    return { status: 200, body: { ok: true, mode: "free", checked: handle, inserted, backoff_until: backoff?.toISOString() ?? null } };
  } catch (e) {
    if (e instanceof RateLimited) {
      await setBackoff(userId, e.until, "X rate limit");
      return { status: 200, body: { ok: true, mode: "free", skipped: true, backoff_until: e.until.toISOString() } };
    }
    const msg = e instanceof Error ? e.message : String(e);
    await setBackoff(userId, null, msg);
    return { status: 502, body: { error: msg, mode: "free" } };
  }
}

// ---------- add ----------
async function addAccount(userId: string, rawHandle: unknown) {
  const handle = String(rawHandle ?? "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0].toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return { status: 400, body: { error: "That is not a valid X handle" } };

  const existing = await fetch(`${REST}/x_accounts?user_id=eq.${userId}&select=handle`, { headers: svc }).then((r) => r.json());
  if (existing.some((a: any) => a.handle === handle)) return { status: 409, body: { error: `@${handle} is already tracked` } };
  if (existing.length >= MAX_ACCOUNTS) return { status: 400, body: { error: `You can track up to ${MAX_ACCOUNTS} accounts` } };

  await ensureState(userId);
  let u: any;
  if (FREE) {
    u = await freeProfile(handle);
    if (!u) return { status: 404, body: { error: `@${handle} was not found on X` } };
  } else {
    const info = await tapi("/twitter/user/info", { userName: handle });
    u = info?.data;
    if (info?.status === "error" || !u?.userName) return { status: 404, body: { error: `@${handle} was not found on X` } };
  }
  if (u.unavailable) return { status: 404, body: { error: `@${handle} is unavailable (${clean(u.unavailableReason || "suspended?", 40)})` } };
  if (u.protected) return { status: 400, body: { error: `@${handle} is a private account; its posts cannot be tracked` } };

  const account = {
    user_id: userId,
    handle: String(u.userName).toLowerCase(),
    x_user_id: clean(u.id, 30) || null,
    name: clean(u.name, 100) || null,
    avatar: https(u.profilePicture),
    followers: Number.isFinite(u.followers) ? u.followers : null,
  };
  const ins = await fetch(`${REST}/x_accounts`, { method: "POST", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify(account) });
  if (!ins.ok) throw new Error(`could not save account: ${await ins.text()}`);

  // Seed the feed with their latest page so the panel is not empty. This does
  // not move the poll cursor, so nobody else's posts get skipped.
  if (FREE) {
    let seeded = 0, note: string | null = null;
    try {
      const { tweets } = await syndication(account.handle);
      seeded = await storePosts(freshRows(userId, tweets));
      await fetch(`${REST}/x_accounts?user_id=eq.${userId}&handle=eq.${account.handle}`, {
        method: "PATCH", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify({ checked_at: new Date().toISOString() }),
      });
    } catch (e) {
      note = e instanceof RateLimited ? "X is rate limiting right now; posts will load shortly" : null;
    }
    return { status: 201, body: { ok: true, mode: "free", account: { ...account, user_id: undefined }, seeded, note } };
  }

  let seeded = 0, credits = 18;
  try {
    await sleep(5200);      // free keys: 1 request per 5s
    const last = await tapi("/twitter/user/last_tweets", { userName: account.handle, includeReplies: "false" });
    const tweets = last?.data?.tweets ?? last?.tweets ?? [];
    credits += Math.max(1, tweets.length) * 15;
    seeded = await storePosts(tweets.slice(0, 20).map((t: any) => toRow(userId, t)).filter(Boolean));
  } catch (_) { /* tracked anyway; the next poll picks up new posts */ }
  await addCredits(userId, credits);
  return { status: 201, body: { ok: true, account: { ...account, user_id: undefined }, seeded } };
}

// ---------- poll ----------
function chunkQueries(handles: string[], sinceClause: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const build = (hs: string[]) => `(${hs.map((h) => `from:${h}`).join(" OR ")}) include:nativeretweets ${sinceClause}`;
  for (const h of handles) {
    if (cur.length && build([...cur, h]).length > 450) { out.push(build(cur)); cur = []; }
    cur.push(h);
  }
  if (cur.length) out.push(build(cur));
  return out;
}

async function poll(userId: string) {
  await ensureState(userId);
  // Atomic throttle: only one caller per gap wins the PATCH.
  const cutoff = new Date(Date.now() - (FREE ? FREE_MIN_GAP_S : MIN_GAP_S) * 1000).toISOString();
  const claim = await fetch(`${REST}/x_poll_state?user_id=eq.${userId}&last_poll_at=lt.${encodeURIComponent(cutoff)}`, {
    method: "PATCH", headers: { ...svc, Prefer: "return=representation" },
    body: JSON.stringify({ last_poll_at: new Date().toISOString() }),
  }).then((r) => r.json());
  if (!Array.isArray(claim) || !claim.length) return { status: 200, body: { ok: true, mode: FREE ? "free" : "paid", skipped: true } };
  const state = claim[0];
  if (FREE) return await freePoll(userId, state);

  const accounts = await fetch(`${REST}/x_accounts?user_id=eq.${userId}&select=handle`, { headers: svc }).then((r) => r.json());
  const handles: string[] = accounts.map((a: any) => a.handle);
  if (!handles.length) return { status: 200, body: { ok: true, inserted: 0, credits: Number(state.credits) } };

  // First ever poll: look back an hour. After that, only tweets newer than the
  // newest one a poll has seen.
  const sinceClause = state.since_id
    ? `since_id:${state.since_id}`
    : `since_time:${Math.floor(Date.now() / 1000) - 3600}`;

  let credits = 0, inserted = 0, newest = state.since_id ? BigInt(state.since_id) : 0n, calls = 0;
  let error: string | null = null;
  try {
    for (const query of chunkQueries(handles, sinceClause)) {
      let cursor = "", q = query;
      for (let page = 0; page < MAX_PAGES; page++) {
        if (calls++) await sleep(5200);
        let res: any;
        try {
          res = await tapi("/twitter/tweet/advanced_search", { query: q, queryType: "Latest", cursor });
        } catch (e) {
          // If X ever stops accepting include:nativeretweets, fall back without it.
          if (e instanceof TapiError && e.status === 400 && q.includes("include:nativeretweets")) {
            q = q.replace(" include:nativeretweets", ""); page--; continue;
          }
          throw e;
        }
        const tweets = res?.tweets ?? [];
        credits += Math.max(1, tweets.length) * 15;
        const rows = tweets.map((t: any) => toRow(userId, t)).filter(Boolean)
          .filter((r: any) => handles.includes(r.handle));        // search can return stragglers
        inserted += await storePosts(rows);
        for (const r of rows) { const id = BigInt(r.tweet_id); if (id > newest) newest = id; }
        if (!res?.has_next_page || !res?.next_cursor) break;
        cursor = res.next_cursor;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Trim old posts so the table stays small.
  const old = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString();
  await fetch(`${REST}/x_posts?user_id=eq.${userId}&created_at=lt.${encodeURIComponent(old)}`, { method: "DELETE", headers: svc });

  const extra: Record<string, unknown> = { last_error: error };
  // Without a since_id yet, anchor on the newest post we stored so the next
  // poll does not keep re-reading the last hour.
  if (newest > 0n) extra.since_id = newest.toString();
  await addCredits(userId, credits, extra);

  if (error) return { status: error.includes("out of credits") ? 402 : 502, body: { error, inserted } };
  return { status: 200, body: { ok: true, mode: "paid", inserted, credits: Number(state.credits) + credits } };
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("Origin")), "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  if (!SERVICE_KEY) return reply(503, { error: "xtrack is missing its service key" });

  const userId = await callerId(req);
  if (!userId) return reply(401, { error: "Sign in to the dashboard first" });

  let body: any;
  try { body = JSON.parse((await req.text()).slice(0, 2000)); } catch { return reply(400, { error: "body must be JSON" }); }

  try {
    const out = body?.action === "add" ? await addAccount(userId, body.handle)
      : body?.action === "poll" ? await poll(userId)
      : { status: 400, body: { error: "unknown action" } };
    return reply(out.status, out.body);
  } catch (e) {
    const status = e instanceof TapiError ? (e.status === 402 ? 402 : 502) : 500;
    return reply(status, { error: e instanceof Error ? e.message : String(e) });
  }
});
