begin;
create table if not exists public.devsignal_digests (
  source_id text primary key check (source_id ~ '^t3_[a-z0-9]+$'),
  source_subreddit text not null check (source_subreddit in ('ClaudeAI', 'ChatGPT')),
  run_id date not null,
  published_post_id text not null check (published_post_id ~ '^t3_[a-z0-9]+$'),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  topic jsonb not null check (jsonb_typeof(topic) = 'object'),
  source_url text generated always as ('https://www.reddit.com/r/' || source_subreddit || '/comments/' || substr(source_id, 4) || '/') stored,
  published_url text generated always as ('https://www.reddit.com/r/ardico_signals_dev/comments/' || substr(published_post_id, 4) || '/') stored
);
alter table public.devsignal_digests enable row level security;
revoke all on public.devsignal_digests from anon, authenticated;
grant all on public.devsignal_digests to service_role;
create index if not exists devsignal_digests_expiration on public.devsignal_digests(expires_at);
commit;

-- Run the following separately after enabling Supabase Cron (pg_cron).
-- No public SELECT policy is created. Configure any private readers separately.
-- select cron.schedule('devsignal-retention', '15 * * * *',
--   $$delete from public.devsignal_digests where expires_at <= now()$$);
