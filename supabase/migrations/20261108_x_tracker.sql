-- X Tracker: watch specific X (Twitter) accounts and show their posts on the
-- dashboard, J7Tracker-style.
--
-- Rows are written ONLY by the `xtrack` edge function (service role), which
-- holds the twitterapi.io key. The browser can read its own rows and delete
-- them (untrack an account, clear the feed), but cannot insert: that keeps a
-- signed-in tab from stuffing arbitrary "tweets" into the feed.

create table if not exists public.x_accounts (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  handle      text        not null check (handle ~ '^[a-z0-9_]{1,15}$'),   -- lowercase
  x_user_id   text,
  name        text                 check (char_length(name) <= 100),
  avatar      text                 check (avatar is null or avatar like 'https://%'),
  followers   integer,
  added_at    timestamptz not null default now(),
  primary key (user_id, handle)
);

create table if not exists public.x_posts (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  tweet_id    text        not null check (tweet_id ~ '^[0-9]{1,25}$'),
  handle      text        not null,                       -- lowercase, matches x_accounts
  author_name text,
  avatar      text                 check (avatar is null or avatar like 'https://%'),
  kind        text        not null default 'tweet' check (kind in ('tweet','reply','quote','retweet')),
  text        text                 check (char_length(text) <= 30000),
  reply_to    text,                                       -- @handle being replied to
  quoted      jsonb,                                      -- {handle, name, text} for quotes / retweets
  media       text                 check (media is null or media like 'https://pbs.twimg.com/%'),
  url         text                 check (url is null or url like 'https://%'),
  created_at  timestamptz not null,
  fetched_at  timestamptz not null default now(),
  primary key (user_id, tweet_id)
);

create index if not exists x_posts_feed_idx on public.x_posts (user_id, created_at desc);

-- Per-user poll bookkeeping: throttle, where the last poll got up to, and a
-- running estimate of twitterapi.io credits spent (100,000 credits = $1).
create table if not exists public.x_poll_state (
  user_id      uuid        primary key references auth.users (id) on delete cascade,
  last_poll_at timestamptz not null default 'epoch',
  since_id     text,
  credits      bigint      not null default 0,
  last_error   text
);

alter table public.x_accounts   enable row level security;
alter table public.x_posts      enable row level security;
alter table public.x_poll_state enable row level security;

drop policy if exists x_accounts_read   on public.x_accounts;
drop policy if exists x_accounts_delete on public.x_accounts;
drop policy if exists x_posts_read      on public.x_posts;
drop policy if exists x_posts_delete    on public.x_posts;
drop policy if exists x_state_read      on public.x_poll_state;

create policy x_accounts_read   on public.x_accounts   for select to authenticated using (user_id = auth.uid());
create policy x_accounts_delete on public.x_accounts   for delete to authenticated using (user_id = auth.uid());
create policy x_posts_read      on public.x_posts      for select to authenticated using (user_id = auth.uid());
create policy x_posts_delete    on public.x_posts      for delete to authenticated using (user_id = auth.uid());
create policy x_state_read      on public.x_poll_state for select to authenticated using (user_id = auth.uid());

revoke all on public.x_accounts, public.x_posts, public.x_poll_state from anon, authenticated;
grant select, delete on public.x_accounts, public.x_posts to authenticated;
grant select on public.x_poll_state to authenticated;

-- Make the API notice the new tables immediately (avoids PGRST205).
notify pgrst, 'reload schema';
