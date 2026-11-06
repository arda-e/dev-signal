import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'node:test'
import {reddit, redis} from '@devvit/web/server'
import {handleIngest} from '../ingest/handler.ts'
import {RETENTION_MS} from '../shared/collection.ts'
import {istanbulDay} from '../shared/scan-time.ts'
import {
  EXPORT_QUEUE,
  processExportQueue,
  snapshotKey,
  storeSnapshot,
} from './collection-store.ts'
import {installCollectionFakes, snapshot} from './test/collection.ts'

let env: ReturnType<typeof installCollectionFakes>
let now: number
const realNow = Date.now
beforeEach(() => {
  now = realNow()
  Date.now = () => now
  env = installCollectionFakes()
})
afterEach(() => {
  env.restore()
  Date.now = realNow
})

function bridge() {
  const rows = new Map<string, Record<string, unknown>>()
  const requests: string[] = []
  const backend = (async (url, init) => {
    assert.match(String(url), /\/rest\/v1\/devsignal_inbox\?/)
    assert.equal(new Headers(init?.headers).get('apikey'), 'backend-only-key')
    if (init?.method === 'DELETE')
      rows.delete(
        new URL(String(url)).searchParams.get('source_id')?.slice(3) ?? '',
      )
    else {
      const row = JSON.parse(String(init?.body))
      rows.set(row.source_id, row)
    }
    return new Response(null, {status: 204})
  }) as typeof fetch
  globalThis.fetch = (async (url, init) => {
    requests.push(String(init?.body))
    assert.equal(new Headers(init?.headers).get('apikey'), null)
    return handleIngest(
      new Request(url, init),
      {
        token: String(env.config.get('supabase-ingest-token')),
        projectUrl: String(env.config.get('supabase-project-url')),
        serviceKey: 'backend-only-key',
      },
      backend,
    )
  }) as typeof fetch
  return {rows, requests}
}

test('selected snapshots flow through the real sender and ingest handler without a publication or AI step', async () => {
  const {rows, requests} = bridge()
  const record = snapshot()
  await storeSnapshot(record)
  assert.equal((await processExportQueue()).status, 'synced')
  assert.equal(rows.size, 1)
  assert.equal(rows.get(record.sourceId)?.post instanceof Object, true)
  assert.equal(
    JSON.stringify(rows.get(record.sourceId)).includes('not-exported'),
    false,
  )
  assert.equal(requests.length, 1)
  assert.equal(
    env.expires.get(snapshotKey(record.sourceId)),
    Date.parse(record.expiresAt),
  )
  assert.ok((env.sets.get(EXPORT_QUEUE)?.get(record.sourceId) ?? 0) > now)
  assert.equal((await processExportQueue()).status, 'idle')
})
test('refresh replaces the comment sample and preserves the original retention deadline', async () => {
  const {rows} = bridge()
  const record = snapshot()
  await storeSnapshot(record)
  await processExportQueue()
  const first = env.comments[0]
  assert.ok(first)
  env.comments.splice(0, 1, {...first, id: 't1_two', body: 'New perspective'})
  env.source.body = 'Edited source'
  now += 60_000
  await redis.zAdd(EXPORT_QUEUE, {member: record.sourceId, score: now})
  await processExportQueue()
  const row = rows.get(record.sourceId)
  assert.ok(row)
  assert.deepEqual(
    (row.comments as {id: string}[]).map(c => c.id),
    ['t1_two'],
  )
  assert.equal(row?.expires_at, record.expiresAt)
  assert.equal((row.post as {body: string}).body, 'Edited source')
})
test('a removed source deletes external content and prunes known metadata snapshots', async () => {
  const {rows} = bridge()
  const record = snapshot()
  await storeSnapshot(record)
  await processExportQueue()
  const cp = {
    posts: {[record.sourceId]: {title: 'Must be removed'}},
    candidates: [record.sourceId],
  }
  env.data.set('devsignal:checkpoints:ClaudeAI', JSON.stringify(cp))
  env.expires.set('devsignal:checkpoints:ClaudeAI', now + RETENTION_MS)
  env.data.set(
    `devsignal:scan-runs:ClaudeAI:${istanbulDay(now)}`,
    JSON.stringify(cp),
  )
  env.expires.set(
    `devsignal:scan-runs:ClaudeAI:${istanbulDay(now)}`,
    now + RETENTION_MS,
  )
  env.data.set(
    `devsignal:posts:${record.sourceId}`,
    JSON.stringify(cp.posts[record.sourceId]),
  )
  env.source.removed = true
  await redis.zAdd(EXPORT_QUEUE, {member: record.sourceId, score: now})
  assert.equal((await processExportQueue()).status, 'deleted')
  assert.equal(rows.size, 0)
  assert.equal(env.data.has(snapshotKey(record.sourceId)), false)
  assert.equal(env.data.has(`devsignal:posts:${record.sourceId}`), false)
  assert.deepEqual(
    JSON.parse(env.data.get('devsignal:checkpoints:ClaudeAI') ?? '{}').posts,
    {},
  )
  assert.equal(env.sets.get(EXPORT_QUEUE)?.size, 0)
})
test('expired snapshots produce idempotent deletions without reading Reddit', async () => {
  const {rows, requests} = bridge()
  const record = snapshot()
  await storeSnapshot(record)
  await processExportQueue()
  now += RETENTION_MS
  reddit.getPostById = async () => {
    throw new Error('must not read expired source')
  }
  assert.equal((await processExportQueue()).status, 'deleted')
  assert.equal(rows.size, 0)
  assert.deepEqual(JSON.parse(requests[1] ?? '{}'), {
    action: 'delete',
    sourceId: record.sourceId,
  })
})
test('rate limits back off per source and quarantine after five failures with redacted errors', async () => {
  await storeSnapshot(snapshot())
  reddit.getPostById = async () => {
    throw new Error('429 private source body and secret must not be stored')
  }
  for (let i = 0; i < 5; i++) {
    const result = await processExportQueue()
    assert.equal(result.status, i === 4 ? 'failed' : 'retry')
    if (i < 4) {
      assert.equal(
        env.sets.get(EXPORT_QUEUE)?.get('t3_abc'),
        now + 60_000 * 2 ** i,
      )
      now += 60_000 * 2 ** i
    }
  }
  assert.equal(env.sets.get(EXPORT_QUEUE)?.size, 0)
  assert.equal(env.sets.get('devsignal:export-failures')?.size, 1)
  const failure = env.data.get('devsignal:export-errors:t3_abc') ?? ''
  assert.equal(failure.includes('private'), false)
  assert.equal(JSON.parse(failure).code, 'rate_limited')
})
test('disabled, missing and invalid export configuration cannot send content', async () => {
  await storeSnapshot(snapshot())
  globalThis.fetch = async () => {
    throw new Error('must not send')
  }
  env.config.set('collector-export-enabled', false)
  assert.equal((await processExportQueue()).status, 'disabled')
  env.config.set('collector-export-enabled', true)
  env.config.set('supabase-project-url', 'https://evil.example')
  assert.equal((await processExportQueue()).status, 'needs_configuration')
  env.config.delete('supabase-project-url')
  assert.equal((await processExportQueue()).status, 'needs_configuration')
})
test('collector and export share a lease and only one source is delivered per chunk', async () => {
  const {requests} = bridge()
  await storeSnapshot(snapshot())
  await storeSnapshot({...snapshot(), sourceId: 't3_def'})
  env.data.set('devsignal:collector-lock', 'other-owner')
  assert.equal((await processExportQueue()).status, 'busy')
  assert.equal(requests.length, 0)
  env.data.delete('devsignal:collector-lock')
  assert.equal((await processExportQueue()).status, 'synced')
  assert.equal(requests.length, 1)
})
test('a crash during snapshot persistence leaves a cleanup index instead of orphaned content', async () => {
  const set = redis.set
  redis.set = (async (key, ...args) => {
    if (key.startsWith('devsignal:collections:'))
      throw new Error('interrupted write')
    return set(key, ...args)
  }) as typeof redis.set
  await assert.rejects(storeSnapshot(snapshot()), /interrupted write/)
  assert.equal(env.sets.get(EXPORT_QUEUE)?.has('t3_abc'), true)
  assert.equal(env.data.has(snapshotKey('t3_abc')), false)
})
