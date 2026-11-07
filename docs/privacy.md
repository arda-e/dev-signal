# DevSignal Privacy Policy

Last updated: 7 November 2026. Operator/contact: [u/ardico](https://www.reddit.com/user/ardico/).

DevSignal reads public post metadata from r/ClaudeAI and r/ChatGPT to select technical discussions for personal, non-commercial reading and learning. Metadata/checkpoints have a 48-hour Redis TTL after write. Candidate diversity uses a daily salted author hash internally; that is pseudonymous data and is not exported.

Selected records include source title/body, engagement counts, timestamps and a bounded sample of up to 30 newest top-level comments from at most two pages. Comment IDs, parent IDs, bodies, scores and timestamps are retained; post bodies are capped at 6,000 UTF-16 code units and comments at 700. Dedicated author names, account IDs and profile fields are excluded from snapshots. Raw text can identify people: no complete anonymization is promised.

Snapshots are temporarily buffered in Redis and, when explicitly enabled, sent to a private Supabase inbox. Snapshots become expired no later than 48 hours after each collection; the Supabase cleanup task removes expired rows every 15 minutes, so physical removal can occur after that expiry time. Daily re-selection can replace a record with newly collected content; ordinary maintenance does not extend its original deadline. The Devvit app makes no AI calls and publishes no generated summaries. The operator intends a separate future scheduled AI workflow to read the inbox for personal analysis; that workflow/connection is not implemented. Its providers and handling must be disclosed before activation.

When export is enabled, morning maintenance refreshes bounded samples and removes comments no longer present in the refreshed sample. Detected post removal/deletion deletes the raw snapshot, known metadata and external row. This is best effort with bounded retries, not immediate or exhaustive deletion detection. Persistent failures require operator investigation. The configured Supabase cleanup job runs every 15 minutes; private processing claims exclude expired rows. Logs must exclude content and secrets; logs/backups/downstream copies require separate retention controls.

Processing status, revisions and leases support later idempotent work. Redacted export-failure metadata expires after seven days. The project does not sell data, train models or profile users. Contact the operator with a source link for correction/removal. Disabling export/uninstalling stops propagation and does not automatically erase external storage; follow the removal checklist.

## Current deployment

The private Supabase inbox and authenticated ingestion function are configured. Real Reddit-content export remains disabled while the project domain exception is Pending in Reddit Developer Settings. Only synthetic setup records have been delivered and removed. No external AI provider or scheduled analysis connection is currently enabled. Enabling a future provider requires an updated disclosure of its identity, purpose and data handling.
