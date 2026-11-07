# Ardico Reading Inbox

A personal, non-commercial project to improve my engineering skills and share important Reddit discussions through my own perspective on social media.

The app collects selected public posts and a limited sample of comments from r/ClaudeAI and r/ChatGPT into a private inbox. A planned AI-assisted workflow will help compare technical claims, understand different viewpoints, and identify discussions worth learning from.

I will review the findings, form my own views, and manually write any social media posts, linking back to the original discussions.

Devvit handles collection only. The separate AI analysis workflow is not yet connected. The project does not train models or sell data.

Selected source content expires after 48 hours. Dedicated usernames and profile fields are excluded, although the text itself may contain identifying information.

The collector is installed and the private Supabase inbox is configured. External delivery remains disabled while Reddit reviews the Supabase domain request.

## Simple data flow

1. **Find discussions:** Devvit checks r/ClaudeAI and r/ChatGPT and selects relevant posts with a limited comment sample.
2. **Keep a private reading inbox:** When external delivery is enabled and permitted, selected content is sent to private Supabase storage for up to 48 hours.
3. **Understand the discussion — planned:** A separate AI-assisted workflow will help compare claims, viewpoints, and questions worth exploring.
4. **Add my own perspective:** I review the findings and manually write any social media posts, with links to the original Reddit discussions.

Only collection and inbox infrastructure are implemented today. The AI-assisted workflow and social publishing are not connected; publishing will remain a manual step.

## Using the collector

The daily collection starts at 06:00 Istanbul time and targets completion by 09:00, subject to service availability. It runs in small batches.

The moderator menu provides **Run Scan** for one collection step, **Sync Inbox** for one delivery step, and **Resume Morning Run** for a blocked morning run. Sync remains disabled until external delivery is enabled after the required review.

## Fetch Domains

- **hpklrxtvgrimxjcchpdk.supabase.co** — Private storage for selected posts and bounded comment samples, supporting a later personal review workflow. The authenticated ingestion endpoint accepts only validated record updates and deletions. The domain request is awaiting Reddit review.

The Devvit app makes no AI API calls. The intended later AI analysis is described above; no external AI provider is currently connected.

## Documentation and contact

- [Privacy Policy](https://github.com/arda-e/dev-signal/blob/main/docs/privacy.md)
- [Terms of Use](https://github.com/arda-e/dev-signal/blob/main/docs/terms.md)
- [Technical implementation](https://github.com/arda-e/dev-signal/blob/main/docs/collector-architecture.md)
- [Supabase setup](https://github.com/arda-e/dev-signal/blob/main/docs/supabase-setup.md)
- [Review brief](https://github.com/arda-e/dev-signal/blob/main/docs/review-brief.md)

Operator/contact: [u/ardico](https://www.reddit.com/user/ardico/).
