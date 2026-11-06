import assert from 'node:assert/strict'
import {test} from 'node:test'
import {sendSnapshot} from '../server/supabase.ts'
import {snapshot} from '../server/test/collection.ts'
import {MAX_PAYLOAD_BYTES} from '../shared/collection.ts'
import {handleIngest} from './handler.ts'

const token = 'a-long-test-token-with-at-least-32-characters'
const config = {
  token,
  projectUrl: 'https://projectref.supabase.co',
  serviceKey: 'server-only-key',
}
function request(payload: unknown, authorization = `Bearer ${token}`) {
  return new Request(
    'https://projectref.supabase.co/functions/v1/devsignal-ingest',
    {method: 'POST', headers: {authorization}, body: JSON.stringify(payload)},
  )
}
test('ingest authenticates before accessing storage and rejects raw or oversized fields', async () => {
  let calls = 0
  const backend = (async () => {
    calls++
    return new Response(null, {status: 204})
  }) as typeof fetch
  assert.equal(
    (
      await handleIngest(
        request({action: 'upsert', snapshot: snapshot()}, 'Bearer wrong'),
        config,
        backend,
      )
    ).status,
    401,
  )
  assert.equal(
    (
      await handleIngest(
        request({
          action: 'upsert',
          snapshot: {...snapshot(), unexpected: ['raw text']},
        }),
        config,
        backend,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await handleIngest(
        request({
          action: 'upsert',
          snapshot: {...snapshot(), post: {...snapshot().post, author: 'user'}},
        }),
        config,
        backend,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await handleIngest(
        request({
          action: 'upsert',
          snapshot: {
            ...snapshot(),
            expiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
          },
        }),
        config,
        backend,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await handleIngest(
        request({padding: 'x'.repeat(MAX_PAYLOAD_BYTES + 1)}),
        config,
        backend,
      )
    ).status,
    400,
  )
  assert.equal(calls, 0)
})
test('Devvit sender to ingest handler to storage preserves only the validated snapshot and is idempotent', async () => {
  const rows = new Map<string, unknown>()
  const backend = (async (url, init) => {
    assert.equal(new Headers(init?.headers).get('apikey'), 'server-only-key')
    assert.match(
      String(url),
      /^https:\/\/projectref.supabase.co\/rest\/v1\/devsignal_inbox\?/,
    )
    if (init?.method === 'DELETE') rows.delete('t3_abc')
    else {
      const row = JSON.parse(String(init?.body))
      assert.deepEqual(Object.keys(row).sort(), [
        'comment_sample',
        'comments',
        'expires_at',
        'fetched_at',
        'post',
        'run_id',
        'selection_reasons',
        'source_id',
        'source_subreddit',
      ])
      rows.set(row.source_id, row)
    }
    return new Response(null, {status: 204})
  }) as typeof fetch
  const transport = (async (url, init) => {
    assert.equal(new Headers(init?.headers).get('apikey'), null)
    return handleIngest(new Request(url, init), config, backend)
  }) as typeof fetch
  const payload = {action: 'upsert' as const, snapshot: snapshot()}
  await sendSnapshot(payload, {url: config.projectUrl, token}, transport)
  await sendSnapshot(payload, {url: config.projectUrl, token}, transport)
  assert.equal(rows.size, 1)
  await sendSnapshot(
    {action: 'delete', sourceId: 't3_abc'},
    {url: config.projectUrl, token},
    transport,
  )
  assert.equal(rows.size, 0)
})
test('ingest fails closed on configuration, methods and storage failures without exposing details', async () => {
  assert.equal(
    (await handleIngest(request({}), {...config, token: ''})).status,
    503,
  )
  assert.equal(
    (await handleIngest(new Request('https://projectref.supabase.co'), config))
      .status,
    405,
  )
  const response = await handleIngest(
    request({action: 'delete', sourceId: 't3_abc'}),
    config,
    (async () =>
      new Response('database credential details', {
        status: 500,
      })) as typeof fetch,
  )
  assert.equal(response.status, 502)
  assert.equal(await response.text(), 'Storage unavailable')
})
