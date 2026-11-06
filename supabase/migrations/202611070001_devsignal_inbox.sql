begin;

create table public.devsignal_inbox (
  source_id text primary key check (source_id ~ '^t3_[a-z0-9]+$'),
  source_subreddit text not null check (source_subreddit in ('ClaudeAI', 'ChatGPT')),
  run_id date not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > fetched_at and expires_at <= fetched_at + interval '48 hours'),
  post jsonb not null check (jsonb_typeof(post) = 'object'),
  comments jsonb not null check (jsonb_typeof(comments) = 'array' and jsonb_array_length(comments) <= 30),
  comment_sample jsonb not null check (jsonb_typeof(comment_sample) = 'object'),
  selection_reasons jsonb not null check (jsonb_typeof(selection_reasons) = 'array'),
  source_url text generated always as ('https://www.reddit.com/r/' || source_subreddit || '/comments/' || substr(source_id, 4) || '/') stored,
  revision bigint not null default 1,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_token uuid,
  locked_until timestamptz,
  processed_at timestamptz,
  last_error text
);
alter table public.devsignal_inbox enable row level security;
revoke all on public.devsignal_inbox from public, anon, authenticated;
grant all on public.devsignal_inbox to service_role;
create index devsignal_inbox_expiration on public.devsignal_inbox(expires_at);
create index devsignal_inbox_pending on public.devsignal_inbox(status, fetched_at);

-- Ingest owns content columns; a processor owns status/lease columns. Repeated
-- delivery of the same snapshot must not undo a completed or claimed analysis.
create function public.devsignal_inbox_revision() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.fetched_at < old.fetched_at then return null; end if;
  if new.run_id is distinct from old.run_id
    or new.post is distinct from old.post
    or new.comments is distinct from old.comments
    or new.comment_sample is distinct from old.comment_sample
    or new.selection_reasons is distinct from old.selection_reasons then
    new.revision := old.revision + 1;
    new.status := 'pending';
    new.attempts := 0;
    new.lease_token := null;
    new.locked_until := null;
    new.processed_at := null;
    new.last_error := null;
  end if;
  return new;
end;
$$;
revoke all on function public.devsignal_inbox_revision() from public, anon, authenticated;
create trigger devsignal_inbox_revision before update of
  run_id, fetched_at, post, comments, comment_sample, selection_reasons
  on public.devsignal_inbox for each row execute function public.devsignal_inbox_revision();

-- Contract for a future private scheduled processor. These RPCs perform no AI
-- calls or Notion writes. A claim expires in ten minutes; at most five rows/call.
create function public.claim_devsignal_inbox(batch_size integer default 5)
returns setof public.devsignal_inbox language sql
set search_path = pg_catalog, public as $$
  with ready as (
    select source_id from public.devsignal_inbox
    where expires_at > now() and attempts < 3
      and (status in ('pending', 'failed') or (status = 'processing' and locked_until <= now()))
    order by fetched_at, source_id
    limit greatest(1, least(coalesce(batch_size, 5), 5))
    for update skip locked
  )
  update public.devsignal_inbox i
    set status = 'processing', attempts = i.attempts + 1,
        lease_token = gen_random_uuid(), locked_until = now() + interval '10 minutes',
        last_error = null
  from ready where i.source_id = ready.source_id
  returning i.*;
$$;
revoke all on function public.claim_devsignal_inbox(integer) from public, anon, authenticated;
grant execute on function public.claim_devsignal_inbox(integer) to service_role;

create function public.finish_devsignal_inbox(
  p_source_id text, p_revision bigint, p_lease_token uuid,
  p_succeeded boolean, p_error text default null
) returns boolean language sql set search_path = pg_catalog, public as $$
  with finished as (
    update public.devsignal_inbox
      set status = case when p_succeeded then 'completed' else 'failed' end,
          processed_at = case when p_succeeded then now() else null end,
          last_error = case when p_succeeded then null else left(p_error, 300) end,
          lease_token = null, locked_until = null
    where source_id = p_source_id and revision = p_revision
      and lease_token = p_lease_token and status = 'processing'
      and locked_until > now() and expires_at > now()
    returning source_id
  ) select exists(select 1 from finished);
$$;
revoke all on function public.finish_devsignal_inbox(text, bigint, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.finish_devsignal_inbox(text, bigint, uuid, boolean, text) to service_role;
commit;

-- Enable pg_cron, then schedule separately and verify the job. Expired rows are
-- excluded by claim_devsignal_inbox even before physical cleanup runs.
-- select cron.schedule('devsignal-inbox-retention', '*/15 * * * *',
--   $$delete from public.devsignal_inbox where expires_at <= now()$$);
