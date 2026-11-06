# Supabase setup — not deployed

No Supabase project has been created. These are owner setup steps; never paste keys into chat or commit them.

1. Create a Supabase project and record https://PROJECT_REF.supabase.co. Keep the data private.
2. Run `npm run configure:supabase -- https://PROJECT_REF.supabase.co`. This writes only the public hostname/URL into devvit.json; Reddit domain approval is still required.
3. Apply supabase/migrations/202611060001_devsignal_digests.sql in the SQL editor (or link the CLI project and use supabase db push). The table has RLS enabled, no anon/authenticated grants and no public SELECT policy. Verify anonymous reads cannot return data.
4. Enable Supabase Cron (pg_cron), then run the commented cron.schedule command at the bottom of the migration. Verify the named hourly retention job and a synthetic expiration. Without that job, database retention is not automatically enforced.
5. Generate a random ingest token of at least 32 characters (for example with a password manager or openssl rand -hex 32). Set it as DEVSIGNAL_INGEST_TOKEN in Supabase Function secrets and as supabase-ingest-token using Devvit's settings prompt.
6. Run npm run build, then deploy supabase/functions/devsignal-ingest/index.ts using the Supabase CLI. The build bundles shared code into this file. supabase/config.toml disables gateway JWT verification **only for this function**, because the handler requires its own bearer token on every request. Missing/short configuration fails closed. Do not replace it with an unauthenticated handler.
7. Supabase supplies SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the function. This broad database key stays within Supabase; Devvit only receives the restricted ingest token. The endpoint has no read/query operation and only upserts/deletes validated digest records in one fixed table.
8. Test missing/wrong token => 401; extra/raw fields => 400; valid synthetic digest => 204; repeated ID => one row; deletion => no row. These live deployment/database checks have not been run in this implementation session.
9. Supply public Terms/Privacy links and the exact Fetch Domains rationale in Devvit, upload/playtest and inspect Developer Settings for domain approval.
10. Configure supabase-project-url if needed, then set supabase-enabled through `npx devvit settings set supabase-enabled`. Keep generation/publication switches off until ready. Only published digests enter the external queue.

## Private readers, removal and failures

Readers need their own least-privilege access, configured separately. No ChatGPT connector or Notion integration is created here.

Before uninstalling, stop publication, inspect pending/failed queue items and remove external records that must be deleted. Stopping workers cannot propagate future deletions. Keep the retention job running until all rows expire or have been removed. Token revocation prevents calls; it does not erase rows.

The morning batch starts at 06:00 Istanbul and stops by the 09:00 target or when finished. Successful source checks are due next morning. retry schedules another attempt; maintenance_failed after five attempts requires investigation. Requeue a verified source in devsignal:digest-queue after fixing access errors. Never blindly reset a Reddit sending receipt after an ambiguous submission.

Provider logs/backups and downstream copies have separate retention controls. The table's expiry is not a guarantee covering every copy.

References: [Function configuration](https://supabase.com/docs/guides/functions/function-configuration), [Secrets](https://supabase.com/docs/guides/functions/secrets), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Cron](https://supabase.com/docs/guides/cron).
