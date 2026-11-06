import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'node:test'
import {reddit, redis, settings} from '@devvit/web/server'
import {nextMorning} from '../shared/scan-time.ts'
import {DIGEST_QUEUE, digestKey, processDigestQueue} from './digest-store.ts'

const original = {
  now: Date.now,
  get: redis.get,
  set: redis.set,
  del: redis.del,
  range: redis.zRange,
  add: redis.zAdd,
  rem: redis.zRem,
  settings: settings.get,
  post: reddit.getPostById,
}
let data: Map<string, string>
let queue: Map<string, number>
let calls: number
let failId: string | undefined
beforeEach(() => {
  Date.now = () => Date.parse('2026-11-06T04:00:00Z')
  data = new Map()
  queue = new Map()
  calls = 0
  failId = undefined
  for (let i = 0; i < 9; i++) {
    const id = `t3_${i}`
    queue.set(id, Date.now() - 1000)
    data.set(
      digestKey(id),
      JSON.stringify({
        sourceId: id,
        publishedPostId: `t3_out${i}`,
        expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
      }),
    )
  }
  redis.get = (async key => data.get(key)) as typeof redis.get
  redis.set = (async (key, value) => {
    data.set(key, value)
    return 'OK'
  }) as typeof redis.set
  redis.del = async (...keys) => {
    for (const key of keys) data.delete(key)
  }
  redis.zRange = (async (key, start, stop) => {
    assert.equal(key, DIGEST_QUEUE)
    return [...queue]
      .sort((a, b) => a[1] - b[1])
      .slice(Number(start), Number(stop) + 1)
      .map(([member, score]) => ({member, score}))
  }) as typeof redis.zRange
  redis.zAdd = (async (_key, ...items) => {
    for (const item of items) queue.set(item.member, item.score)
    return items.length
  }) as typeof redis.zAdd
  redis.zRem = async (_key, ids) => {
    for (const id of ids) queue.delete(id)
    return ids.length
  }
  settings.get = (async () => false) as typeof settings.get
  reddit.getPostById = (async (id: string) => {
    calls++
    if (id === failId) throw new Error('temporary Reddit failure')
    return {
      removed: false,
      body: 'Still available',
      authorName: 'source-author',
    }
  }) as unknown as typeof reddit.getPostById
})
afterEach(() => {
  Date.now = original.now
  redis.get = original.get
  redis.set = original.set
  redis.del = original.del
  redis.zRange = original.range
  redis.zAdd = original.add
  redis.zRem = original.rem
  settings.get = original.settings
  reddit.getPostById = original.post
})

test('historical maintenance handles at most five due sources per step, capped at expiry', async () => {
  const expires = new Date(Date.now() + 1000).toISOString()
  data.set(
    digestKey('t3_0'),
    JSON.stringify({
      sourceId: 't3_0',
      publishedPostId: 't3_out0',
      expiresAt: expires,
    }),
  )
  const result = await processDigestQueue()
  assert.equal(result?.processed, 5)
  assert.equal(calls, 5)
  assert.equal(queue.get('t3_0'), Date.parse(expires))
  assert.equal(queue.get('t3_1'), nextMorning(Date.now()))
  assert.equal((await processDigestQueue())?.processed, 4)
  assert.equal(await processDigestQueue(), undefined)
  assert.equal(calls, 9)
})

test('one failed source does not prevent the other maintenance items advancing', async () => {
  failId = 't3_1'
  const result = await processDigestQueue()
  assert.equal(result?.processed, 5)
  assert.equal(result?.status, 'retry')
  assert.equal(calls, 5)
  assert.equal(data.get('devsignal:digest-attempts:t3_1'), '1')
  assert.ok((queue.get('t3_1') ?? 0) < (queue.get('t3_2') ?? 0))
  assert.equal(queue.get('t3_2'), nextMorning(Date.now()))
})

test('a 30-day backlog of 180 digests drains in 36 bounded maintenance chunks', async () => {
  data.clear()
  queue.clear()
  for (let i = 0; i < 180; i++) {
    const id = `t3_${i}`
    queue.set(id, Date.now() - 1000)
    data.set(
      digestKey(id),
      JSON.stringify({
        sourceId: id,
        publishedPostId: `t3_out${i}`,
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      }),
    )
  }
  let chunks = 0
  for (;;) {
    const result = await processDigestQueue()
    if (!result) break
    chunks++
    assert.ok(result.processed <= 5)
    assert.ok(chunks <= 36)
  }
  assert.equal(chunks, 36)
  assert.equal(calls, 180)
})
