# Hooking a friend's PC up to the dashboard

Each person's PC is **their own**, exposed by **their own tunnels**, and pushed
to **their own row** in Supabase. Row-level security means nobody can see or
control anyone else's machine — a friend's login only ever reaches their PC.

## The one rule that keeps it safe
The PC launcher signs in as **that friend's Supabase user** (email + password)
and uses the short-lived **JWT** it gets back. **Never** hand a friend the
Supabase `service_role` key — that key bypasses row-level security and can read
*everyone's* data. Only Alex's own machine may use `service_role`, if at all.

## What the friend installs (once)
Copy these from Alex into `C:\AlexPCStatus\` on the friend's PC:
- `status.py` — hardware/status JSON API (serves `/api/status` on `:8765`).
  **Change `NAME = "AlexPC"` near the top** to their PC's name (it shows on the card).
- `moonlight-web/` — the Moonlight game-stream server (serves `:8080`)
- `caddy.exe` + `caddyfile` — proxy on `:8081` that adds partitioned cookies so
  the stream works inside the dashboard's iframe (the stream tunnel points here)
- `cloudflared.exe` — Cloudflare's tunnel client
- `connect-pc.ps1` — the launcher in this folder
- `login.txt` — **two lines**: their dashboard email, then their password
  (the account Alex created for them in Supabase → Authentication → Users)

They also need Python + a GPU/host set up for Moonlight (same as Alex's rig).
Do **not** copy Alex's `supabase.key` — that's the admin key; friends never need it.

## How a connection actually flows
1. Friend runs `connect-pc.ps1`.
2. It signs into Supabase as **their** user → gets a JWT.
3. It starts `status.py`, `moonlight-web`, and `caddy` locally.
4. It opens two **Cloudflare quick tunnels** (random `*.trycloudflare.com` URLs,
   no domain needed): one for the status API (`:8765`) and one for the stream
   (`caddy :8081` → moonlight-web `:8080`).
5. It **upserts their `tunnel_state` row** with those URLs, using the JWT.
   RLS stamps the row with their `user_id` and blocks writes to any other row.
6. Friend opens `alexdb.xyz`, passes the decoy, and picks their profile.
   The dashboard reads **their** row (RLS returns only theirs) → their PC card
   goes live, and clicking it streams **their** machine.

Quick-tunnel URLs change on every restart — that's fine: the launcher re-pushes
the current URLs each run and every ~50 minutes, so the dashboard stays current.

## Upgrading to fixed URLs (optional, like Alex's setup)
Quick tunnels are the zero-setup path. For stable hostnames a friend can later
run a **named** Cloudflare tunnel on a domain they control and point
`status_url` / `stream_url` at fixed subdomains instead — the dashboard doesn't
care which, it just reads whatever URLs are in their row.

## What's shared vs. isolated
- **Isolated per user:** PC/Mac connection, notes, saved themes, chat history
  (all RLS-scoped to `auth.uid()`).
- **Shared:** the AI-chat Edge Function runs on Alex's Anthropic key, so all
  three profiles draw from the same budget. Tighten later if needed.
