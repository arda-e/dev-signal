# DevSignal review brief

Owner/contact: u/ardico. Personal, non-commercial learning and writing project with a public Reddit digest component. No revenue, data resale or model training.

## Proposed behaviour

A Devvit collector reads bounded public listings from r/ClaudeAI and r/ChatGPT, selects relevant technical discussions and temporarily reads their comments. OpenAI produces original attributed briefs. At most six topic posts per scan day are published in the owner's public r/ardico_signals_dev community, with automation disclosure; there are no writes to source communities.

Published digests and source references can also be stored in private Supabase through a restricted authenticated ingest function. The owner's private tools may read those summaries for learning, exploration and manually written personal LinkedIn posts. Raw comment archives, original post bodies and author metadata are not sent to Supabase. The repository implements no Notion writer or LinkedIn publisher.

## Implementation status

The Devvit 0.15.2 Web template, bounded collector/checkpoints and moderator menus are retained. Generation, publication, external ingestion, backoff and maintenance code is present. All three generation/publication/external switches default off.

No Supabase project/exact hostname is configured. No live external write or Reddit text-post submission was performed in this implementation session. Local tests and review limitations are reported separately. Neither an app listing nor this document is a claim of Reddit approval.

## Questions for Reddit

Is this use eligible, including public source reading, attributed destination-community digests, and private storage/reading for the stated personal use? Does the Supabase requirement qualify for a fetch-domain exception? Which deletion/data-lifecycle changes are required before approval?

## Operational validation

Owner: u/ardico. First run generation with publication off; inspect only the derived draft. Then explicitly enable one manual publication and verify the destination, attribution and disclosure. Enable external delivery after endpoint/domain setup and inspect one row with no source body/author fields. Verify repeated delivery produces one row and one Reddit post.

During the first daily cycle, inspect scan counts/errors/shortfalls, request durations, sending receipts, retry and maintenance_failed results. Unexpected raw source storage/logging, duplicate publication, failed withdrawal, repeated throttling or stalled runs require disabling the affected setting and investigation. Test the hourly retention job and a synthetic source-removal flow before unattended operation.

## Review limits

No usable Git base/HEAD exists in this checkout; all files were untracked before this work. The formal branch-diff review stopped at scope resolution. Formal branch-diff review was unavailable because there was no resolvable Git base. A manual code scan and three read-only code reuse/quality/efficiency reviews were performed instead. Live services, Deno hosting and the SQL migration remain unverified.
