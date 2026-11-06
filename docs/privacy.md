# DevSignal Privacy Policy

Review draft, 6 November 2026. Operator/contact: [u/ardico](https://www.reddit.com/user/ardico/). Check against the actual deployment and publish this policy before review.

DevSignal reads public post metadata from r/ClaudeAI and r/ChatGPT to select technical discussions. Metadata/checkpoints have a 48-hour Redis TTL after write; candidate diversity uses a daily salted author hash, which is pseudonymous data. Comment bodies/IDs are transient in memory. Commenter names are not intentionally included in model input or storage. Source text may itself identify people; perfect anonymization is not promised.

Selected post text and a bounded comment sample are sent to OpenAI for summary generation with store:false. The project does not train models. This flag does not guarantee zero provider-side retention; the operator must verify provider settings before activation.

Generated, attributed summaries can be published publicly in r/ardico_signals_dev and optionally retained for 30 days in private Supabase for personal learning and writing. Supabase receives the digest and source/publication references, not original post bodies, raw comment records or author metadata. Drafts expire after one day. Minimal publication/deduplication metadata persists to prevent duplicates. Logs must not contain source payloads or secrets.

Enabled maintenance rechecks due published sources approximately daily. Detected removal/deletion withdraws the app-created post and deletes the external digest. Failures have bounded retries and can require operator intervention; this is not a deletion SLA. Individual comment changes after aggregation are not independently tracked. Supabase expiry requires the retention job. Logs, backups and downstream copies need separate controls.

The project does not sell data or profile users. Contact the operator with source/digest links for correction/removal. Uninstalling stops workers but does not automatically erase Supabase; the operator must follow the removal checklist.
