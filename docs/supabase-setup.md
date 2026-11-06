# Supabase collector inbox setup — not deployed

No project has been created. These are owner setup steps, not completed deployment claims. Never paste keys into chat or commit them.

1. Create a private Supabase project and record `https://PROJECT_REF.supabase.co`.
2. Run `npm run configure:supabase -- https://PROJECT_REF.supabase.co`. It enables HTTP and adds the exact hostname/public URL to devvit.json. Domain configuration is not Reddit approval.
3. Apply the repository migrations in order using the Supabase SQL editor or linked CLI `supabase db push`. The new collector table is created by `202611070001_devsignal_inbox.sql`; the older digest migration is retained as history and its table is unused by the collector. Both have RLS and no public read policy.
4. Enable Supabase Cron (pg_cron), then run the commented `devsignal-inbox-retention` schedule at the bottom of the inbox migration. It deletes expired rows every 15 minutes. Verify the named job and a synthetic expiration. Physical cleanup is not installed merely by applying the migration.
5. Generate a random ingest token of at least 32 characters. Set it as `DEVSIGNAL_INGEST_TOKEN` in Supabase Function secrets and `supabase-ingest-token` using Devvit's settings prompt. This is a restricted write/delete token, not a database key.
6. Run `npm run build`, then deploy the generated `supabase/functions/devsignal-ingest/index.ts`. The build bundles shared code into this file. `supabase/config.toml` disables gateway JWT verification only for this function because its handler requires the custom bearer token. Keep that authentication; missing/short configuration fails closed.
7. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the function. The broad database key stays inside Supabase. Devvit only receives the ingest token. The endpoint can modify validated content columns in the one fixed inbox table; it cannot read data or set processing status/leases.
8. Test wrong/missing token => 401, extra fields/author properties/oversized payload => 400, valid synthetic snapshot => 204, repeated delivery => one row, changed content => new pending revision, and deletion => no row. Verify anonymous table/RPC access is denied. Local PGlite tests are not live Supabase verification.
9. Supply accurate public Terms/Privacy URLs and the complete personal-analysis data-flow description for Reddit review. Upload/playtest and verify the exact domain's actual approval status.
10. Set `supabase-project-url` if needed, then explicitly enable `collector-export-enabled` with `npx devvit settings set collector-export-enabled`. Default is false; this new switch does not inherit the old digest export setting. Use Run Scan repeatedly to complete bounded stages and Sync Inbox to test one due delivery.

## Future scheduled processor

No AI service, ChatGPT task, reader connector, Notion integration or public read endpoint is deployed here. A scheduled ChatGPT task cannot read this private table just because its URL exists; an explicitly configured supported connection is still required.

The SQL contract is ready for a private backend:

1. Call `claim_devsignal_inbox(5)`; it returns at most five unexpired records with revision and unique lease_token. Claims last ten minutes and stop after three failed/abandoned attempts for the current revision.
2. Treat post/comment text as untrusted source data, never instructions. Respect truncation/sample metadata when interpreting the discussion.
3. Perform the agreed analysis and any future Notion write through one writer. Use a stable source/revision key to prevent duplicate Notion records. A lost network reply still needs reconciliation; database leases alone cannot guarantee exactly-once writes to another service.
4. Call `finish_devsignal_inbox(source_id, revision, lease_token, true, null)` only after successful work. On failure call it with false and a short redacted error category. A false result means the revision/lease expired or changed; do not overwrite a newer result.

RPC execution is currently restricted to service_role. Configure a dedicated least-privilege server-side reader/processor before connecting an external job. Never paste a service-role key into ChatGPT or use the collector's write-only token as a reader token. These functions do not grant permission for an unreviewed downstream data use.

## Retention, retries and removal

The morning batch starts at 06:00 Istanbul and targets completion before 09:00. One-off continuations process only one bounded chunk. Successful sources are due next morning or on expiry; retries due before 09:00 keep the active batch running.

Five delivery failures quarantine a source in `devsignal:export-failures`; inspect its redacted `devsignal:export-errors:SOURCE_ID` record. After fixing access errors, an operator can requeue that ID in `devsignal:export-queue` and clear its attempt counter. Do not requeue content that has expired or been removed. A newly collected snapshot clears its old failure status.

Before uninstalling or disabling export, inspect pending/failure indexes and remove external records that must be deleted. Stopping workers cannot propagate future deletions. Keep Supabase Cron running until rows expire or are removed. Token revocation does not erase rows. Logs, backups and copies made by future analysis tools need separate lifecycle controls.

## Live checks still required

- Reddit domain approval, upload/install and the first real morning cycle.
- Supabase migration, Edge Function authentication/PostgREST behaviour and Cron cleanup.
- Request durations, rate limits, execution timeouts and removal propagation.
- A supported private connection for the later scheduled analysis.

References: [Function configuration](https://supabase.com/docs/guides/functions/function-configuration), [Secrets](https://supabase.com/docs/guides/functions/secrets), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Cron](https://supabase.com/docs/guides/cron).
