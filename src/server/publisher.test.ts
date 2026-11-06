import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'node:test'
import {
  type Context,
  reddit,
  redis,
  runWithContext,
  settings,
} from '@devvit/web/server'
import {
  generateTopic,
  parseTopic,
  publishNextTopic,
  renderTopic,
} from './publisher.ts'

const topic = {
  suitable: true,
  title: 'Agent araçlarında bağlam yönetimi',
  summary: 'Örneklemde bağlam kaybı tartışılıyor.',
  whyNow: 'Bugünkü örneklemde görünür; büyüme ölçülmedi.',
  perspectives:
    'Bazıları araç tasarımını, bazıları model sınırlarını vurguluyor.',
  angle: 'Hatanın hangi katmanda oluştuğunu incelemek.',
  uncertainty: 'Sınırlı örneklem; doğrulanmış bir trend değil.',
}
const original = {
  del: redis.del,
  range: redis.zRange,
  add: redis.zAdd,
  rem: redis.zRem,
  comments: reddit.getComments,
  get: redis.get,
  set: redis.set,
  watch: redis.watch,
  settings: settings.get,
  source: reddit.getPostById,
  submit: reddit.submitPost,
  fetch: globalThis.fetch,
}
let data: Map<string, string>
let queue: Map<string, number>
let enabled: boolean
let posting: boolean
let supabase: boolean
let edits: number
let submissions: number
let calls: number
let configured: boolean
let unavailable: boolean
let rejectSubmit: boolean
let apiStatus: number
const run = () =>
  runWithContext(
    {subredditName: 'ardico_signals_dev'} as unknown as Context,
    publishNextTopic,
  )

beforeEach(() => {
  data = new Map()
  queue = new Map()
  enabled = true
  posting = true
  supabase = false
  edits = 0
  submissions = 0
  calls = 0
  configured = true
  unavailable = false
  rejectSubmit = false
  apiStatus = 200
  data.set(
    'devsignal:checkpoints:ClaudeAI',
    JSON.stringify({
      runId: '2026-11-06',
      stage: 'COMPLETE',
      candidates: ['t3_abc'],
      errors: [],
    }),
  )
  redis.del = (async (...keys: string[]) => {
    for (const key of keys) data.delete(key)
  }) as typeof redis.del
  redis.zRange = (async () =>
    [...queue.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 1)
      .map(([member, score]) => ({member, score}))) as typeof redis.zRange
  redis.zAdd = (async (
    _key: string,
    ...members: {member: string; score: number}[]
  ) => {
    for (const item of members) queue.set(item.member, item.score)
    return members.length
  }) as typeof redis.zAdd
  redis.zRem = (async (_key: string, members: string[]) => {
    for (const id of members) queue.delete(id)
    return members.length
  }) as typeof redis.zRem
  reddit.getComments = (() => ({
    async *[Symbol.asyncIterator]() {
      yield {
        id: 't1_one',
        body: 'A technical finding',
        authorName: 'private-name',
        score: 4,
      }
    },
  })) as unknown as typeof reddit.getComments
  redis.get = (async (key: string) => data.get(key)) as typeof redis.get
  redis.set = (async (key: string, value: string, options?: {nx?: boolean}) => {
    if (options?.nx && data.has(key)) return ''
    data.set(key, value)
    return 'OK'
  }) as typeof redis.set
  redis.watch = (async () => ({
    multi: async () => {},
    del: async (key: string) => {
      data.delete(key)
    },
    exec: async () => [],
    unwatch: async () => {},
  })) as unknown as typeof redis.watch
  settings.get = (async (name: string) => {
    if (name === 'digests-enabled') return enabled
    if (name === 'publish-to-reddit') return posting
    if (name === 'supabase-enabled') return supabase
    if (name === 'supabase-project-url') return 'https://projectref.supabase.co'
    if (name === 'supabase-ingest-token') return 'test-only-token'
    return configured ? 'test-only-key' : undefined
  }) as typeof settings.get
  reddit.getPostById = (async (id: string) => ({
    id: 't3_abc',
    title: 'Technical discussion',
    body: unavailable && id !== 't3_published' ? '[deleted]' : 'An example.',
    authorName: 'author',
    removed: false,
    createdAt: new Date(),
    score: 5,
    numberOfComments: 6,
    edit: async () => {
      edits++
    },
  })) as unknown as typeof reddit.getPostById
  reddit.submitPost = (async (
    options: Parameters<typeof reddit.submitPost>[0],
  ) => {
    submissions++
    assert.equal(options.subredditName, 'ardico_signals_dev')
    assert.equal('text' in options && typeof options.text, 'string')
    assert.equal('entry' in options, false)
    if (rejectSubmit) throw new Error('connection lost')
    return {
      id: 't3_published',
      url: 'https://www.reddit.com/r/ardico_signals_dev/comments/published/',
    }
  }) as unknown as typeof reddit.submitPost
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('supabase.co'))
      return new Response(null, {status: apiStatus === 200 ? 204 : apiStatus})
    calls++
    const body = JSON.parse(String(init?.body))
    assert.equal(body.store, false)
    assert.equal(body.text.format.type, 'json_schema')
    assert.equal(body.tools, undefined)
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{type: 'output_text', text: JSON.stringify(topic)}],
          },
        ],
      }),
      {status: apiStatus},
    )
  }) as typeof fetch
})
afterEach(() => {
  redis.del = original.del
  redis.zRange = original.range
  redis.zAdd = original.add
  redis.zRem = original.rem
  reddit.getComments = original.comments
  redis.get = original.get
  redis.set = original.set
  redis.watch = original.watch
  settings.get = original.settings
  reddit.getPostById = original.source
  reddit.submitPost = original.submit
  globalThis.fetch = original.fetch
})

test('one topic is drafted, then published as a text post, without duplicate submission', async () => {
  assert.equal((await run()).status, 'drafted')
  assert.equal(submissions, 0)
  assert.equal((await run()).status, 'published')
  assert.equal((await run()).status, 'checked')
  assert.equal((await run()).status, 'idle')
  assert.equal(submissions, 1)
  assert.equal(calls, 1)
})
test('missing key prevents generation and publishing', async () => {
  configured = false
  assert.equal((await run()).status, 'needs_configuration')
  assert.equal(submissions, 0)
  assert.equal(calls, 0)
})
test('deleted source is skipped before calling OpenAI', async () => {
  unavailable = true
  assert.equal((await run()).status, 'skipped')
  assert.equal(calls, 0)
})
test('ambiguous submission is not automatically retried', async () => {
  await run()
  rejectSubmit = true
  assert.equal((await run()).status, 'uncertain')
  assert.equal((await run()).status, 'idle')
  assert.equal(submissions, 1)
})
test('generation failures are bounded and do not publish', async () => {
  apiStatus = 429
  for (let i = 0; i < 4; i++) await run()
  assert.equal(calls, 3)
  assert.equal(submissions, 0)
})
test('incomplete scans and other destinations do not publish', async () => {
  data.set(
    'devsignal:checkpoints:ClaudeAI',
    JSON.stringify({
      stage: 'FETCH_COMMENTS',
      candidates: ['t3_abc'],
      errors: [],
    }),
  )
  assert.equal((await run()).status, 'idle')
  const rsp = await runWithContext(
    {subredditName: 'other'} as unknown as Context,
    publishNextTopic,
  )
  assert.equal(rsp.status, 'disabled')
  assert.equal(calls, 0)
})
test('rendered topic is readable markdown with deterministic source attribution', () => {
  const rendered = renderTopic(topic, 'ClaudeAI', 't3_abc', '2026-11-06')
  assert.match(
    rendered.text,
    /https:\/\/www.reddit.com\/r\/ClaudeAI\/comments\/abc\//,
  )
  assert.match(rendered.text, /OpenAI/)
  assert.match(rendered.text, /### Olası yazı açısı/)
  assert.throws(() => renderTopic(topic, 'unknown', 't3_abc', 'today'))
})
test('malformed, link-injected and refused responses cannot become posts', async () => {
  assert.throws(() => parseTopic({title: 'missing fields'}))
  assert.throws(() =>
    parseTopic({...topic, summary: 'https://malicious.example'}),
  )
  const refusal = (async () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          {type: 'message', content: [{type: 'refusal', refusal: 'no'}]},
        ],
      }),
    )) as typeof fetch
  await assert.rejects(generateTopic({}, 'test', refusal), /no text/)
})

test('generation and Reddit posting require separate explicit switches', async () => {
  enabled = false
  assert.equal((await run()).status, 'disabled')
  assert.equal(calls, 0)
  enabled = true
  posting = false
  assert.equal((await run()).status, 'drafted')
  assert.equal((await run()).status, 'ready')
  assert.equal(submissions, 0)
  assert.equal(
    [...data.keys()].some(key => key.startsWith('devsignal:comments:')),
    false,
  )
  assert.equal(
    JSON.stringify([...data.values()]).includes('A technical finding'),
    false,
  )
  assert.equal(
    JSON.stringify([...data.values()]).includes('private-name'),
    false,
  )
})
test('a deleted source withdraws its published digest and external copy', async () => {
  await run()
  await run()
  supabase = true
  unavailable = true
  assert.equal((await run()).status, 'withdrawn')
  assert.equal(edits, 1)
  assert.equal(data.has('devsignal:digests:t3_abc'), false)
  assert.equal(queue.size, 0)
  assert.equal(submissions, 1)
})
test('Supabase failure does not submit another Reddit post and backs off', async () => {
  await run()
  await run()
  supabase = true
  apiStatus = 429
  assert.equal((await run()).status, 'retry')
  assert.equal((await run()).status, 'idle')
  assert.equal(submissions, 1)
  assert.ok((queue.get('t3_abc') ?? 0) > Date.now())
})

test('a repeatedly failing source cannot starve later candidates', async () => {
  const cp = JSON.parse(data.get('devsignal:checkpoints:ClaudeAI') ?? '{}')
  cp.candidates.push('t3_def')
  data.set('devsignal:checkpoints:ClaudeAI', JSON.stringify(cp))
  const source = reddit.getPostById
  let failures = 0
  reddit.getPostById = (async id => {
    if (id === 't3_abc') {
      failures++
      throw new Error('Reddit rate limit')
    }
    return source(id)
  }) as typeof reddit.getPostById
  for (let i = 0; i < 3; i++) assert.equal((await run()).status, 'retry')
  assert.equal((await run()).status, 'drafted')
  assert.equal((await run()).status, 'published')
  assert.equal(failures, 3)
  assert.equal(submissions, 1)
})

test('ambiguous submissions reserve daily quota and retain no summary in permanent intent', async () => {
  const cp = JSON.parse(data.get('devsignal:checkpoints:ClaudeAI') ?? '{}')
  cp.candidates = ['t3_abc', 't3_def', 't3_ghi', 't3_jkl']
  data.set('devsignal:checkpoints:ClaudeAI', JSON.stringify(cp))
  rejectSubmit = true
  for (let i = 0; i < 3; i++) {
    assert.equal((await run()).status, 'drafted')
    assert.equal((await run()).status, 'uncertain')
  }
  assert.equal((await run()).status, 'idle')
  assert.equal(submissions, 3)
  const intent = JSON.parse(data.get('devsignal:publications:t3_abc') ?? '{}')
  assert.equal(intent.state, 'sending')
  assert.equal(intent.topic, undefined)
})

test('maintenance retries are capped and expired queue records are pruned', async () => {
  await run()
  await run()
  supabase = true
  apiStatus = 503
  for (let i = 0; i < 5; i++) {
    queue.set('t3_abc', Date.now() - 1)
    assert.equal((await run()).status, i === 4 ? 'maintenance_failed' : 'retry')
  }
  assert.equal(queue.size, 0)
  assert.equal(submissions, 1)
  const digest = JSON.parse(data.get('devsignal:digests:t3_abc') ?? '{}')
  digest.expiresAt = new Date(Date.now() - 1).toISOString()
  data.set('devsignal:digests:t3_abc', JSON.stringify(digest))
  queue.set('t3_abc', Date.now() - 1)
  apiStatus = 200
  assert.equal((await run()).status, 'expired')
  assert.equal(queue.size, 0)
  assert.equal(data.has('devsignal:digests:t3_abc'), false)
})
