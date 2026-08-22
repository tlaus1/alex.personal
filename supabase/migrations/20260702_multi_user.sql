-- ============================================================================
-- alex.personal — multi-user migration
-- ----------------------------------------------------------------------------
-- Turns the single-tenant dashboard into isolated per-user accounts
-- (zlawg, chillboi, tlaus1). After this runs, every table is scoped by
-- row-level security so a signed-in user can ONLY see/write their own rows —
-- nobody can read or control anyone else's PC, notes, chats, or themes.
--
-- Idempotent: safe to run more than once. Run in Supabase → SQL Editor.
--
-- PREREQUISITE: create the 3 users first (Authentication → Users → Add user),
-- one of them with email 'alexye2625@gmail.com' (that's tlaus1 = you, and it
-- inherits all of today's existing data via the backfills below). If your
-- admin email differs, change ADMIN_EMAIL in the two spots marked below.
-- ============================================================================

-- Helper: new rows are auto-stamped with the caller's user id from their JWT,
-- so neither the dashboard nor the PC launcher ever has to send user_id.

-- ─── 1) tunnel_state : one row per user (PC/Mac URLs, notepad, prefs) ────────
alter table public.tunnel_state
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Give `id` a working default so new users' rows can be inserted without one
-- (harmless if it already has a default / is an identity column).
do $$
begin
  if not exists (
    select 1 from pg_attrdef d
    join pg_class c on c.oid = d.adrelid
    join pg_attribute a on a.attrelid = c.oid and a.attnum = d.adnum
    where c.relname = 'tunnel_state' and a.attname = 'id'
  ) then
    create sequence if not exists tunnel_state_id_seq owned by public.tunnel_state.id;
    perform setval('tunnel_state_id_seq',
                   coalesce((select max(id) from public.tunnel_state), 0) + 1, false);
    alter table public.tunnel_state alter column id set default nextval('tunnel_state_id_seq');
  end if;
end $$;

-- Backfill the existing (id=1) row to tlaus1  ── change ADMIN_EMAIL if needed
update public.tunnel_state
  set user_id = (select id from auth.users where email = 'alexye2625@gmail.com')
  where user_id is null;

-- Exactly one tunnel_state row per user (this is also the upsert conflict target)
create unique index if not exists tunnel_state_user_id_key
  on public.tunnel_state(user_id);

alter table public.tunnel_state alter column user_id set default auth.uid();

alter table public.tunnel_state enable row level security;
drop policy if exists tunnel_state_owner on public.tunnel_state;
create policy tunnel_state_owner on public.tunnel_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─── 2) chats : per-user AI conversations ───────────────────────────────────
alter table public.chats
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
update public.chats
  set user_id = (select id from auth.users where email = 'alexye2625@gmail.com')
  where user_id is null;                                   -- change ADMIN_EMAIL if needed
alter table public.chats alter column user_id set default auth.uid();
create index if not exists chats_user_id_idx on public.chats(user_id);

alter table public.chats enable row level security;
drop policy if exists chats_owner on public.chats;
create policy chats_owner on public.chats
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─── 3) custom_themes : per-user saved themes ───────────────────────────────
alter table public.custom_themes
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
update public.custom_themes
  set user_id = (select id from auth.users where email = 'alexye2625@gmail.com')
  where user_id is null;                                   -- change ADMIN_EMAIL if needed
alter table public.custom_themes alter column user_id set default auth.uid();
create index if not exists custom_themes_user_id_idx on public.custom_themes(user_id);

alter table public.custom_themes enable row level security;
drop policy if exists custom_themes_owner on public.custom_themes;
create policy custom_themes_owner on public.custom_themes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─── Sanity check (optional) ────────────────────────────────────────────────
-- After running, confirm every row now has an owner and RLS is on:
--   select 'tunnel_state' t, count(*) total, count(user_id) owned from public.tunnel_state
--   union all select 'chats', count(*), count(user_id) from public.chats
--   union all select 'custom_themes', count(*), count(user_id) from public.custom_themes;
-- `total` should equal `owned` for each table (no orphan rows).
