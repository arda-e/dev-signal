# DevSignal — Reddit discussion digests

A personal, non-commercial Devvit app for catching up on technical discussions in r/ClaudeAI and r/ChatGPT. Original Turkish briefs are intended for the public **r/ardico_signals_dev** community, with an optional private Supabase copy for personal learning and manually written LinkedIn posts.

**Status:** locally implemented review prototype; no approval or live deployment is claimed. Supabase has not been created/configured. Generation, publication and external delivery default to **off**. The original Web splash/game template and its separate install/New Post behaviour remain intact.

## Data flow

1. Discover public post metadata in small pages, save checkpoints and select up to 15 candidates per source using lightweight metadata ranking.
2. Read one source and at most 30 newest comments in pages of 15. Deduplicate comment IDs in memory, omit commenter names, cap bodies at 700 characters each. Do not write raw comments to Redis or Supabase.
3. OpenAI produces a short original brief: topic, findings, viewpoints, uncertainty and a possible writing angle. Source input is untrusted; structured output is validated. No Editorial Energy scoring or model training.
4. A later invocation publishes one ordinary text post in the destination, with source attribution and automation disclosure.
5. A later invocation sends only the published digest and source/publication references to a restricted Supabase ingest function, if enabled.

The app does not vote, message, write in source communities, publish to LinkedIn or sync to Notion. Private Supabase readers are configured separately; this repository creates no public read endpoint.

## Execution limits

| Worker        | Schedule                                             | Per invocation                                                   |
| ------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Collector     | Every minute; daily 06:00 UTC task retained          | One stage/chunk for one source; at most 20 listing entries       |
| Digest worker | Every five minutes; same moderator command available | One generation, one submission, or one due maintenance/sync item |

Each source targets 100 New, 50 Hot and 50 Top/day listing entries before ID deduplication: 5 + 3 + 3 discovery chunks. DEDUPLICATE and PREFILTER use one each. The legacy FETCH_COMMENTS stage drains three candidate IDs per chunk and clears old caches; fresh comments are now fetched only during generation. With 15 candidates, there are 18 collector chunks/source, about 36 one-minute ticks across both sources. The additional daily trigger may advance another chunk. Short/repeated cursors record a shortfall: COMPLETE can include unmet targets.

Scan days begin at 06:00 UTC / 09:00 Europe/Istanbul. Unfinished runs resume before a new daily run. First installation can start immediately. Manual scan runs only one chunk.

At most three submission attempts/source/run, six total, are reserved before submit. Ambiguous outcomes consume a slot and remain in sending state; no blind resubmission. Source lookup and generation failures are capped at three per source/run. Collector and publisher use separate three-minute owner-token leases. OpenAI timeout: 18 seconds; Supabase: 8 seconds. Live execution times/rate limits still require measurement; bounded counts do not guarantee a full execution deadline.

## Storage and deletion

- Post metadata, checkpoints, scan runs and candidates: 48-hour Redis TTL after write. Includes title, scores, dates and a daily salted author hash for diversity. This is pseudonymous metadata.
- New raw comment storage is disabled. Upgrade cleanup processes one of 62 historical subreddit/day snapshots per collector invocation and deletes known old comment-cache keys. Unindexed old keys cannot be enumerated; verify legacy deployment data before claiming a complete purge.
- Draft summaries: one day. Published digest copies: 30 days. Permanent metadata-only publication receipts and quota reservations prevent duplicates.
- A queue maintains one entry/published source. Approximately daily, one due source is checked; a removed/deleted source causes the app-created post to be replaced with a withdrawal notice and its external digest to be deleted. Expired digest queue entries are removed.
- Maintenance failures back off 1, 2, 4 and 8 minutes, rounded to worker ticks. After five failures, the item is removed from the active queue with a failure status/counter for operator investigation. Deletion detection is best effort, not a guaranteed SLA; individual comment edits/deletions after aggregation are not independently tracked.
- Supabase requires the hourly retention job in the setup guide. Disabling digests-enabled stops maintenance too. Uninstalling stops workers and does not itself clear external storage.

## Validate locally

Node 24+, pinned Devvit 0.15.2:

```sh
npm ci
npm test
```

Tests cover resumable discovery, no comment persistence, switches, bounded retries, duplicate prevention, source withdrawal, strict endpoint authentication/projection, and the real sender-to-handler chain with emulated storage. They do not establish live Reddit/OpenAI/Supabase behaviour. The build also bundles the Edge Function, so deployment needs no imports outside its directory.

## Configure and playtest

```sh
npx devvit settings set openai-api-key
npx devvit settings set digests-enabled
npx devvit settings set publish-to-reddit
npm run playtest
```

Keep booleans false until ready for their side effects. Generation enabled/publication disabled creates one draft and reports ready. Inspect derived drafts using developer tooling; do not log source bodies. The source is checked again before publication. The publisher only runs in r/ardico_signals_dev.

Follow [Supabase setup](docs/supabase-setup.md) before enabling external delivery. Never place credentials in source, chat or logs.

## Fetch Domains

- api.openai.com: original attributed discussion briefs for Reddit readers, from bounded source input via Responses structured output and store:false. This flag is not a blanket claim of zero provider retention.
- Supabase project hostname: **not configured yet**. Run `npm run configure:supabase -- https://PROJECT_REF.supabase.co` to add the actual exact host and public URL default to devvit.json. Its only app endpoint is /functions/v1/devsignal-ingest: validated digest upsert/delete, no database reads. The private relational store supports topic history and personal review. Whether this qualifies for a fetch-domain exception is for Reddit to assess.

Playtest/upload submits configured domains for review; configuration is not approval. Publish and register real URLs for the owner's [Terms](docs/terms.md) and [Privacy Policy](docs/privacy.md) after checking them against the deployment. See [review brief](docs/review-brief.md).

References: [HTTP Fetch](https://developers.reddit.com/docs/capabilities/http-fetch), [Fetch Policy](https://developers.reddit.com/docs/capabilities/server/http-fetch-policy), [Devvit Rules](https://developers.reddit.com/docs/devvit_rules).
