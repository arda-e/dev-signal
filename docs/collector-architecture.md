# Ardico Reading Inbox — technical reference

Implementation details for maintainers. See the [public overview](https://github.com/arda-e/dev-signal#readme) for the purpose and simple data flow.

## Data flow and scope

1. Discover public post metadata in pages of at most 20, with checkpoints in Redis.
2. Select up to 15 candidates per source using technical relevance, freshness, engagement and author diversity, with sticky/megathread/previously-seen penalties. No model or Editorial Energy score is used.
3. One candidate per enrichment chunk: fetch its current source post and inspect at most 30 newest **top-level** comments, using at most two SDK pages of 15 and depth=1. Do not traverse reply trees. Empty and short pages may yield fewer comments.
4. Save a bounded snapshot to Redis for at most 48 hours and enqueue its ID. The post body is capped at 6,000 UTF-16 code units; each comment body at 700. Truncation and sample coverage are explicit fields.
5. One delivery/maintenance item per sync chunk: refresh the source and replace the comment sample, then upsert/delete through the authenticated Supabase Edge Function. Repeated source IDs update one inbox row. No Reddit publication is required.
6. A separate future private processor claims pending inbox rows and performs analysis. The repository provides SQL claim/completion contracts, not a running AI job or a ChatGPT connection.

Supabase receives source ID/subreddit/run date, a canonical source link, current post title/body/score/comment count/date/sticky flag, bounded comment IDs/parent IDs/bodies/scores/dates, selection reasons, sample limits, and collection/expiry times. Author names/IDs/profile fields and the internal daily author hash are not included. **Raw text can itself contain identifying information; this is not an anonymized dataset.** No bulk archive, media download, model training, voting, messaging, source-community writes or automatic LinkedIn publishing is implemented.

## Scheduling and chunk sizes

| Work                        | Bound per invocation                                                |
| --------------------------- | ------------------------------------------------------------------- |
| Discovery                   | One listing page, up to 20 posts                                    |
| Deduplicate / prefilter     | One stage; at most 200 listing entries/source before dedupe         |
| Comment enrichment          | One selected post, two comment pages, at most 30 inspected comments |
| Supabase sync / maintenance | One source, at most two comment pages plus one upsert/delete        |

Each source targets New=100, Hot=50 and Top/day=50 listing entries before deduplication: 5+3+3 discovery chunks, one DEDUPLICATE, one PREFILTER, and up to 15 FETCH_COMMENTS chunks. That is up to 28 healthy scan chunks/source, 56 across both sources, then a completion check. With 30 selected posts, first-day delivery needs up to 30 sync chunks plus an idle check. Short/repeated cursors report shortfalls; COMPLETE does not promise Reddit supplied every target.

The only recurring trigger is **03:00 UTC / 06:00 Istanbul**. One-off continuations run approximately one minute apart while the morning batch is active, targeting completion by **09:00 Istanbul**. A continuation is pre-armed before API work; stale/duplicate deliveries exit, and completion cancels the next job. Near 09:00 new API work stops. A status-only interrupted-lease recovery may run until 09:03. There is no all-day polling cron. Healthy counts are capacity estimates, not measured live execution times or a deadline guarantee; retained sources and retries add steps.

Redis state `devsignal:collector-batches:YYYY-MM-DD` retains phase SCAN/SYNC, sequence, timestamps, deadline and errors for seven days. Outcomes are COMPLETE, PARTIAL, BLOCKED or DEADLINE_MISSED. A new Istanbul day starts a new scan rather than silently completing yesterday's unfinished target. Legacy digest batches, cron publication endpoints and the old Publish Next Topic menu cannot publish anything.

## Storage, refresh and deletion

- Discovery metadata, checkpoints, run snapshots and candidate IDs: 48-hour TTL after write. Author diversity uses a daily salted hash internally; this is pseudonymous metadata and is not exported.
- Selected raw-content snapshots: `devsignal:collections:*`, expiring 48 hours after collection. Re-selection on a later day replaces the snapshot and establishes a new collection deadline. Routine maintenance does not extend retention.
- Delivery index: `devsignal:export-queue`, one entry/source; successful sources are due at the next morning kickoff or their expiry, whichever is earlier. Index entries are removed after successful deletion.
- A refresh replaces the whole comment sample; it does not merge stale comments back in. Removed/deleted comments observed in the sample are excluded, and comments outside the new sample are dropped. This is a bounded top-level sample, not a complete discussion or a guarantee to observe every edit immediately.
- A detected removed/deleted post removes the local raw snapshot, known source metadata and its external inbox row. Unknown/unindexed legacy keys cannot be enumerated; the existing bounded legacy-comment cleanup is retained. Legacy generated digest tables/posts are not automatically migrated or withdrawn; inspect any real prior deployment separately.
- Collection failures are isolated per candidate, with up to three failures before advancing. Export failures use 1/2/4/8-minute backoff, then move to a metadata-only failure index after five failures. Failure records expire after seven days; expired failure-index entries are pruned. Rate-limit/timeout categories are stored without raw exception text or payloads.
- Collector and sync share an owner-token three-minute lease. Supabase requests have an eight-second timeout. Reddit SDK calls rely on the Devvit execution deadline; checkpointing and pre-armed continuations support interrupted work.
- Supabase rows have an expiry of at most 48 hours. The configured 15-minute Supabase Cron cleanup removes expired rows; claims exclude expired rows even before physical deletion. This is not a deletion SLA. Uninstalling/disabling export stops propagation; logs, backups and downstream copies require their own deletion controls.

## Inbox processing contract

`devsignal_inbox` has pending/processing/completed/failed status, revision, attempts, lease token and expiry. Only content columns can be written through the ingest endpoint. Repeated identical upserts preserve processing state; changed content or a new run creates a new pending revision. Older snapshots are ignored.

`claim_devsignal_inbox` atomically claims at most five unexpired rows with a ten-minute lease and at most three processing attempts. `finish_devsignal_inbox` requires the exact source ID, revision and lease token, preventing an old analysis from completing a newer version. Expired claims can be reclaimed. This does not make an external Notion side effect exactly-once: the future single writer must use its own stable source/revision key and reconciliation.

RLS is enabled with no public/anonymous/authenticated table access. The RPCs are restricted to service_role pending a dedicated server-side processor connection. Never expose a Supabase service key to a browser, chat, prompt or Devvit setting. No ChatGPT scheduled job has been connected or created.

## Validate locally

Node 24+, pinned Devvit 0.15.2:

```sh
npm ci
npm test
```

The suite covers resumable discovery, bounded actual SDK listing traversal, snapshots, per-source failures, real sender-to-ingest projection with emulated network/storage, and the SQL migrations/leases/revisions/RLS in a local PGlite PostgreSQL engine. PGlite does not validate live Supabase/PostgREST/Cron or live Reddit scheduler behaviour. The build includes the bundled Edge Function.

## Configure and test

Follow [Supabase setup](https://github.com/arda-e/dev-signal/blob/main/docs/supabase-setup.md). Then use the moderator menu:

- **Run Scan:** one collector chunk; never the entire dataset in one request.
- **Sync Inbox:** one due source refresh and delivery/deletion.
- **Resume Morning Run:** resume a blocked morning batch before 09:00 Istanbul.

Delivery requires the new explicit `collector-export-enabled` switch; old digest switches and the OpenAI key setting are removed. Existing source checkpoints without the new schema version restart safely. Do not log source bodies or credentials.

## Fetch Domains

The configured exact domain is `hpklrxtvgrimxjcchpdk.supabase.co`. Export remains disabled pending Reddit review. `npm run configure:supabase -- https://PROJECT_REF.supabase.co` enables HTTP and adds only the exact project hostname and public URL default. `api.openai.com` is no longer requested.

The only outbound app endpoint is `/functions/v1/devsignal-ingest`, which accepts authenticated allowlisted snapshot upsert/delete operations and cannot read/query arbitrary tables. The proposed private SQL inbox supports versioned claims for later personal analysis. Whether the complete data flow qualifies for a fetch-domain exception is for Reddit to assess; the downstream AI purpose is not hidden.

The application settings link to the public [Terms](https://github.com/arda-e/dev-signal/blob/main/docs/terms.md) and [Privacy Policy](https://github.com/arda-e/dev-signal/blob/main/docs/privacy.md). See [review brief](https://github.com/arda-e/dev-signal/blob/main/docs/review-brief.md).

References: [HTTP Fetch](https://developers.reddit.com/docs/capabilities/http-fetch), [Fetch Policy](https://developers.reddit.com/docs/capabilities/server/http-fetch-policy), [Devvit Rules](https://developers.reddit.com/docs/devvit_rules).
