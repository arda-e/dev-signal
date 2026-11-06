# DevSignal collector review brief

Owner/contact: u/ardico. Personal, non-commercial reading and learning project. No revenue, resale, model training or user profiling. This version replaces the previous proposed public-digest design with a collector-only architecture.

## Proposed behaviour

A Devvit collector reads bounded public listings from r/ClaudeAI and r/ChatGPT, ranks candidates using metadata and selects up to 15 per source/day. It reads one selected post and at most 30 newest top-level comments, with at most two SDK pages of 15 and no recursive reply traversal. Post/comment bodies are capped and coverage limitations are stored.

The app optionally delivers raw selected post text and bounded comment records to private Supabase through an authenticated fixed-table upsert/delete function. Dedicated author/account/profile fields and internal diversity hashes are excluded, but raw text can contain identifying information. This is not a derived-digest-only transfer or a claim of anonymization.

The owner prefers a separate future scheduled AI workflow to analyze the inbox for personal learning, exploration and manually written personal LinkedIn posts. That downstream use is part of the proposed data flow. No external AI processor, ChatGPT reader connection, Notion writer or LinkedIn publisher is implemented. This version does not call an LLM or publish generated Reddit topics. Public digest publication is not being presented as a benefit that the collector actually provides.

## Limits and lifecycle

The only recurring schedule starts at 06:00 Istanbul; one-off bounded continuations target completion by 09:00 and stop on completion/deadline. New/Hot/Top-day targets are 100/50/50 listing entries/source before deduplication, not guaranteed unique counts. Collection/sync process one selected source per chunk.

Raw snapshots expire in at most 48 hours per collection. Maintenance refreshes comment samples without extending expiry. Detected unavailable posts cause local-content pruning and external deletion. Short-lived metadata checkpoints expire after write; known deletion cleanup preserves their existing expiry. Errors are isolated, retried with bounds, then surfaced for operator intervention. Daily checks, external outages and disabled/uninstalled workers mean deletion propagation has no guaranteed SLA. Supabase physical retention requires a separately installed Cron job.

The SQL inbox has private claims, revision fencing and processing states for the future reader. The ingest token can only upsert/delete validated content in the fixed table; the service key stays inside Supabase. Private-reader access is not created automatically.

## Questions for Reddit

Is this limited personal reading/analysis use eligible under Devvit, including raw selected text/comment transfer and the intended later AI analysis? Does the private versioned processing inbox qualify for a Supabase fetch-domain exception, or is another approved access route required? Which lifecycle/deletion controls are required before activation?

## Implementation and deployment status

Devvit 0.15.2 Web template, resumable collector and manual scan are preserved. OpenAI settings/domain, AI implementation and generated-topic publisher are removed. The new collector-export-enabled switch defaults off, HTTP defaults disabled until an exact Supabase host is configured, and legacy publisher endpoints are inert.

No project/domain is configured and this version has not been uploaded/installed. Local tests cover the pipeline with emulated network boundaries and SQL behaviour using PGlite PostgreSQL. That does not validate live Reddit/Supabase, PostgREST hosting or pg_cron. Code review/CI are not Reddit approval.

## Operational validation after setup

Owner: u/ardico. Verify wrong/missing tokens fail before storage access, extra/identity fields are rejected, and one synthetic row can be inserted, updated and deleted privately. Verify identical retries preserve completed processing state, changed content creates a new revision, and old claims cannot finish it. Confirm the 15-minute expiry job.

Then explicitly enable delivery and run one manual scan/sync cycle. Inspect counts, sample coverage, redacted errors and request durations without logging bodies. In the first morning cycle, check SCAN/SYNC progress and final COMPLETE/PARTIAL/BLOCKED/DEADLINE_MISSED status. Unintended source writes, unexpected outbound hosts, identity-field export, loss of authentication, stale content after deletion or duplicate processing require disabling export and investigating; retain the cleanup job until external content is removed. Ordinary bounded sampling/truncation is expected behaviour, not a regression.
