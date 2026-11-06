import assert from 'node:assert/strict'
import {test} from 'node:test'
import {sendSnapshot, supabaseOrigin} from './supabase.ts'

test('Supabase URLs cannot redirect secrets to arbitrary hosts or paths', () => {
  assert.equal(
    supabaseOrigin('https://projectref.supabase.co/'),
    'https://projectref.supabase.co',
  )
  for (const url of [
    'http://projectref.supabase.co',
    'https://evil.example',
    'https://projectref.supabase.co.evil.example',
    'https://secret@projectref.supabase.co',
    'https://projectref.supabase.co/path',
  ]) {
    assert.throws(() => supabaseOrigin(url))
  }
})

test('external delivery uses only the restricted collector endpoint and refuses redirects', async () => {
  const request = (async (url, init) => {
    assert.equal(
      String(url),
      'https://projectref.supabase.co/functions/v1/devsignal-ingest',
    )
    assert.equal(init?.redirect, 'error')
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer test-token',
    )
    const body = JSON.parse(String(init?.body))
    assert.equal(body.action, 'delete')
    assert.equal(body.sourceId, 't3_abc')
    return new Response(null, {status: 204})
  }) as typeof fetch
  await sendSnapshot(
    {action: 'delete', sourceId: 't3_abc'},
    {url: 'https://projectref.supabase.co', token: 'test-token'},
    request,
  )
  await assert.rejects(
    sendSnapshot(
      {action: 'delete', sourceId: 't3_abc'},
      {url: 'https://projectref.supabase.co', token: 'test-token'},
      (async () =>
        new Response('private error payload', {status: 429})) as typeof fetch,
    ),
    /^Error: Supabase HTTP 429$/,
  )
})
