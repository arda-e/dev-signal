import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {after, before, beforeEach, test} from 'node:test'
import {PGlite} from '@electric-sql/pglite'
import {snapshot} from '../server/test/collection.ts'
import type {Snapshot} from '../shared/collection.ts'

let db: PGlite
type Row = {
  source_id: string
  revision: number
  status: string
  lease_token: string
  attempts: number
  post: {body: string}
}
before(async () => {
  db = new PGlite()
  await db.exec(
    'create role anon; create role authenticated; create role service_role bypassrls;',
  )
  for (const name of [
    '202611060001_devsignal_digests.sql',
    '202611070001_devsignal_inbox.sql',
  ])
    await db.exec(
      await readFile(
        new URL(`../../supabase/migrations/${name}`, import.meta.url),
        'utf8',
      ),
    )
})
void after(async () => {
  await db?.close()
})
beforeEach(async () => {
  await db.exec('truncate public.devsignal_inbox')
})

async function upsert(s: Snapshot) {
  return db.query<Row>(
    `insert into public.devsignal_inbox
    (source_id,source_subreddit,run_id,fetched_at,expires_at,post,comments,comment_sample,selection_reasons)
    values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)
    on conflict (source_id) do update set source_subreddit=excluded.source_subreddit,
      run_id=excluded.run_id,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,
      post=excluded.post,comments=excluded.comments,comment_sample=excluded.comment_sample,
      selection_reasons=excluded.selection_reasons returning *`,
    [
      s.sourceId,
      s.sourceSubreddit,
      s.runId,
      s.collectedAt,
      s.expiresAt,
      JSON.stringify(s.post),
      JSON.stringify(s.comments),
      JSON.stringify(s.commentSample),
      JSON.stringify(s.selectionReasons),
    ],
  )
}
async function claim(limit = 5) {
  return (
    await db.query<Row>('select * from public.claim_devsignal_inbox($1)', [
      limit,
    ])
  ).rows
}
async function finish(row: Row, succeeded = true) {
  return (
    await db.query<{ok: boolean}>(
      'select public.finish_devsignal_inbox($1,$2,$3,$4,$5) as ok',
      [
        row.source_id,
        row.revision,
        row.lease_token,
        succeeded,
        succeeded ? null : 'redacted_error',
      ],
    )
  ).rows[0]?.ok
}
test('SQL migrations create a private inbox and anonymous callers cannot read or claim it', async () => {
  await upsert(snapshot())
  await db.exec('set role anon')
  try {
    await assert.rejects(
      db.query('select * from public.devsignal_inbox'),
      /permission denied/,
    )
    await assert.rejects(claim(), /permission denied/)
  } finally {
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  try {
    assert.equal((await claim()).length, 1)
  } finally {
    await db.exec('reset role')
  }
})
test('bounded claims skip active leases and repeated ingest preserves completed processing state', async () => {
  const s = snapshot()
  await upsert(s)
  const row = (await claim())[0]
  assert.ok(row)
  assert.equal((await claim()).length, 0)
  await upsert(s)
  assert.equal((await claim()).length, 0)
  assert.equal(await finish(row), true)
  await upsert(s)
  const saved = (await db.query<Row>('select * from public.devsignal_inbox'))
    .rows[0]
  assert.equal(saved?.status, 'completed')
  assert.equal(Number(saved?.revision), 1)
  assert.equal((await claim()).length, 0)
})
test('changed source content creates a new revision and fences out stale completion', async () => {
  const s = snapshot()
  await upsert(s)
  const old = (await claim())[0]
  assert.ok(old)
  await upsert({...s, post: {...s.post, body: 'Changed discussion'}})
  assert.equal(await finish(old), false)
  const current = (await claim())[0]
  assert.ok(current)
  assert.equal(Number(current.revision), 2)
  assert.equal(current.attempts, 1)
  assert.equal(await finish(current), true)
})
test('older delivery cannot overwrite a newer snapshot or reset analysis state', async () => {
  const s = snapshot()
  await upsert(s)
  const result = await upsert({
    ...s,
    collectedAt: new Date(Date.parse(s.collectedAt) - 60_000).toISOString(),
    expiresAt: new Date(Date.parse(s.expiresAt) - 60_000).toISOString(),
    post: {...s.post, body: 'Stale content'},
  })
  assert.equal(result.rows.length, 0)
  const row = (await claim())[0]
  assert.equal(row?.post.body, s.post.body)
  assert.equal(Number(row?.revision), 1)
})
test('an expired worker lease can be reclaimed but its old token cannot finish the replacement', async () => {
  await upsert(snapshot())
  const old = (await claim())[0]
  assert.ok(old)
  await db.exec(
    "update public.devsignal_inbox set locked_until = now() - interval '1 minute'",
  )
  const current = (await claim())[0]
  assert.ok(current)
  assert.notEqual(current.lease_token, old.lease_token)
  assert.equal(await finish(old), false)
  assert.equal(await finish(current), true)
})
test('claims cap at five records and stop after three failed attempts until content changes', async () => {
  for (let i = 0; i < 8; i++) await upsert({...snapshot(), sourceId: `t3_${i}`})
  assert.equal((await claim(999)).length, 5)
  assert.equal((await claim(999)).length, 3)
  assert.equal((await claim()).length, 0)
  await db.exec('truncate public.devsignal_inbox')
  const s = snapshot()
  await upsert(s)
  for (let i = 0; i < 3; i++) {
    const row = (await claim())[0]
    assert.ok(row)
    assert.equal(await finish(row, false), true)
  }
  assert.equal((await claim()).length, 0)
  await upsert({...s, post: {...s.post, body: 'New content'}})
  assert.equal((await claim()).length, 1)
})
test('expired content is never claimed and retention cleanup removes it', async () => {
  await upsert({
    ...snapshot(),
    collectedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    expiresAt: new Date(Date.now() - 86400_000).toISOString(),
  })
  assert.equal((await claim()).length, 0)
  await db.exec('delete from public.devsignal_inbox where expires_at <= now()')
  assert.equal(
    (await db.query('select * from public.devsignal_inbox')).rows.length,
    0,
  )
})
