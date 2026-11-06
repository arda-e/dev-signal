# DevSignal Privacy Policy

Review draft, 7 November 2026. Operator/contact: [u/ardico](https://www.reddit.com/user/ardico/). Check against the actual deployment and publish before review.

DevSignal reads public post metadata from r/ClaudeAI and r/ChatGPT to select technical discussions for personal, non-commercial reading and learning. Metadata/checkpoints have a 48-hour Redis TTL after write. Candidate diversity uses a daily salted author hash internally; that is pseudonymous data and is not exported.

Selected records include source title/body, engagement counts, timestamps and a bounded sample of up to 30 newest top-level comments from at most two pages. Comment IDs, parent IDs, bodies, scores and timestamps are retained; post bodies are capped at 6,000 UTF-16 code units and comments at 700. Dedicated author names, account IDs and profile fields are excluded from snapshots. Raw text can identify people: no complete anonymization is promised.

Snapshots are temporarily buffered in Redis and, when explicitly enabled, sent to a private Supabase inbox. They expire no later than 48 hours after each collection. Daily re-selection can replace a record with newly collected content; ordinary maintenance does not extend its original deadline. The Devvit app makes no AI calls and publishes no generated summaries. The operator intends a separate future scheduled AI workflow to read the inbox for personal analysis; that workflow/connection is not implemented. Its providers and handling must be disclosed before activation.

Morning maintenance refreshes bounded samples and removes comments no longer present in the refreshed sample. Detected post removal/deletion deletes the raw snapshot, known metadata and external row. This is best effort with bounded retries, not immediate or exhaustive deletion detection. Persistent failures require operator investigation. Supabase physical expiry requires a separately configured 15-minute cleanup job; private claims exclude expired rows. Logs must exclude content and secrets; logs/backups/downstream copies require separate retention controls.

Processing status, revisions and leases support later idempotent work. Redacted export-failure metadata expires after seven days. The project does not sell data, train models or profile users. Contact the operator with a source link for correction/removal. Disabling export/uninstalling stops propagation and does not automatically erase external storage; follow the removal checklist.
