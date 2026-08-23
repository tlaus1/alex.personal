-- ============================================================================
-- alexdb dashboard - username/password user system
-- ----------------------------------------------------------------------------
-- Ported from the alex.fun schema (proven in production there). No email
-- addresses: users type a username and password. Passwords are bcrypt-hashed
-- with pgcrypto; the browser holds only a random 64-char session token.
--
-- WHY NOT SUPABASE AUTH: Supabase Auth is email-based. This gives real
-- usernames, and every data call goes through a SECURITY DEFINER function that
-- resolves the token -> user, so a caller can only ever touch their own rows.
--
-- Idempotent. Run in Supabase -> SQL Editor.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- accounts ----------
create table if not exists public.dash_users (
  id           uuid primary key default extensions.gen_random_uuid(),
  username     text not null unique,
  password_hash text not null,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists public.dash_sessions (
  token      text primary key,
  user_id    uuid not null references public.dash_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
create index if not exists dash_sessions_user_idx on public.dash_sessions(user_id);

-- Tables are reached ONLY through the functions below, never directly.
alter table public.dash_users    enable row level security;
alter table public.dash_sessions enable row level security;

-- ---------- helpers ----------
create or replace function public.dash_norm_username(p_username text)
returns text language sql immutable as $$
  select lower(regexp_replace(trim(coalesce(p_username, '')), '[^A-Za-z0-9_-]', '', 'g'));
$$;

-- Resolve a session token to its owner, or raise. Every data function calls this.
create or replace function public.dash_user_from_token(p_token text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_user_id uuid;
begin
  select user_id into v_user_id
  from public.dash_sessions
  where token = p_token and expires_at > now();

  if v_user_id is null then
    raise exception 'Invalid or expired session';
  end if;
  return v_user_id;
end;
$$;

-- ---------- register / login / logout ----------
create or replace function public.dash_register(p_username text, p_password text)
returns table(session_token text, user_id uuid, username text)
language plpgsql security definer set search_path = public
as $$
declare
  v_username text := public.dash_norm_username(p_username);
  v_id uuid;
  v_token text;
begin
  if length(v_username) < 3 then
    raise exception 'Username must be at least 3 letters or numbers';
  end if;
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'Password must be at least 8 characters';
  end if;

  insert into public.dash_users(username, password_hash)
  values (v_username, extensions.crypt(p_password, extensions.gen_salt('bf')))
  returning id into v_id;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.dash_sessions(token, user_id) values (v_token, v_id);

  return query select v_token, v_id, v_username;
exception
  when unique_violation then
    raise exception 'That username is taken';
end;
$$;

create or replace function public.dash_login(p_username text, p_password text)
returns table(session_token text, user_id uuid, username text)
language plpgsql security definer set search_path = public
as $$
declare
  v_username text := public.dash_norm_username(p_username);
  v_user record;
  v_token text;
begin
  select u.id, u.username, u.password_hash into v_user
  from public.dash_users u
  where u.username = v_username;

  -- Same message for both cases so usernames can't be enumerated.
  if v_user.id is null
     or v_user.password_hash <> extensions.crypt(p_password, v_user.password_hash) then
    raise exception 'Wrong username or password';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.dash_sessions(token, user_id) values (v_token, v_user.id);

  return query select v_token, v_user.id, v_user.username;
end;
$$;

create or replace function public.dash_logout(p_token text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.dash_sessions where token = p_token;
end;
$$;

create or replace function public.dash_change_password(p_token text, p_old text, p_new text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := public.dash_user_from_token(p_token);
  v_hash text;
begin
  if length(coalesce(p_new, '')) < 8 then
    raise exception 'New password must be at least 8 characters';
  end if;
  select password_hash into v_hash from public.dash_users where id = v_id;
  if v_hash <> extensions.crypt(p_old, v_hash) then
    raise exception 'Current password is wrong';
  end if;
  update public.dash_users
    set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf'))
    where id = v_id;
  -- Force other devices to sign in again.
  delete from public.dash_sessions where user_id = v_id and token <> p_token;
end;
$$;

-- ---------- per-user dashboard data ----------
create table if not exists public.dash_state (
  user_id        uuid primary key references public.dash_users(id) on delete cascade,
  status_url     text,
  stream_url     text,
  mac_stream_url text,
  notepad        text default '',
  prefs          jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);
alter table public.dash_state enable row level security;

create or replace function public.dash_get_state(p_token text)
returns table(status_url text, stream_url text, mac_stream_url text, notepad text, prefs jsonb)
language plpgsql security definer set search_path = public
as $$
declare v_id uuid := public.dash_user_from_token(p_token);
begin
  insert into public.dash_state(user_id) values (v_id) on conflict (user_id) do nothing;
  return query
    select s.status_url, s.stream_url, s.mac_stream_url, s.notepad, s.prefs
    from public.dash_state s where s.user_id = v_id;
end;
$$;

-- Only the supplied fields are written; nulls leave the existing value alone.
create or replace function public.dash_save_state(
  p_token text,
  p_status_url text default null,
  p_stream_url text default null,
  p_mac_stream_url text default null,
  p_notepad text default null,
  p_prefs jsonb default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare v_id uuid := public.dash_user_from_token(p_token);
begin
  insert into public.dash_state(user_id) values (v_id) on conflict (user_id) do nothing;
  update public.dash_state set
    status_url     = coalesce(p_status_url, status_url),
    stream_url     = coalesce(p_stream_url, stream_url),
    mac_stream_url = coalesce(p_mac_stream_url, mac_stream_url),
    notepad        = coalesce(p_notepad, notepad),
    prefs          = coalesce(p_prefs, prefs),
    updated_at     = now()
  where user_id = v_id;
end;
$$;

-- ---------- who am i ----------
create or replace function public.dash_me(p_token text)
returns table(user_id uuid, username text, is_admin boolean)
language plpgsql security definer set search_path = public
as $$
declare v_id uuid := public.dash_user_from_token(p_token);
begin
  return query select u.id, u.username, u.is_admin from public.dash_users u where u.id = v_id;
end;
$$;

-- ---------- grants ----------
-- Only these functions are callable. The tables themselves stay unreachable.
grant execute on function public.dash_register(text, text)            to anon, authenticated;
grant execute on function public.dash_login(text, text)               to anon, authenticated;
grant execute on function public.dash_logout(text)                    to anon, authenticated;
grant execute on function public.dash_change_password(text,text,text) to anon, authenticated;
grant execute on function public.dash_get_state(text)                 to anon, authenticated;
grant execute on function public.dash_save_state(text,text,text,text,text,jsonb) to anon, authenticated;
grant execute on function public.dash_me(text)                        to anon, authenticated;

-- Housekeeping: drop expired sessions.
delete from public.dash_sessions where expires_at < now();
