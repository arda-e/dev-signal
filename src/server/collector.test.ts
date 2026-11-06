import assert from 'node:assert/strict'
import {test} from 'node:test'
import {reddit, redis} from '@devvit/web/server'
import {candidateScore, runCollector, selectCandidates} from './collector.ts'
import {commentListing} from './test/collection.ts'

const item = (id: number, extra = {}) => ({
  id: `t3_${id}` as `t3_${string}`,
  subreddit: 'ClaudeAI',
  title: 'Claude API coding project',
  author: `author${id}`,
  url: 'https://example.com',
  score: 20,
  commentCount: 10,
  createdAt: new Date().toISOString(),
  sticky: false,
  megathread: false,
  repeatedMegathread: false,
  previouslySeen: false,
  sources: ['DISCOVER_NEW'],
  ...extra,
})

test('ranking applies penalties and selects diverse authors', () => {
  const now = Date.now()
  const regular = item(1)
  assert.ok(
    candidateScore(regular, now) >
      candidateScore(item(2, {sticky: true, megathread: true}), now),
  )
  const many = Array.from({length: 18}, (_, i) =>
    item(i, {author: i < 15 ? 'same' : `other${i}`}),
  )
  const chosen = selectCandidates(many, now)
  assert.equal(chosen.length, 15)
  assert.ok(chosen.indexOf('t3_15') < chosen.indexOf('t3_2'))
})

test('chunks resume and deduplicate with bounded comment snapshots and isolated source errors', async () => {
  const original = {
    del: redis.del,
    get: redis.get,
    set: redis.set,
    newPosts: reddit.getNewPosts,
    hotPosts: reddit.getHotPosts,
    topPosts: reddit.getTopPosts,
    comments: reddit.getComments,
    post: reddit.getPostById,
    add: redis.zAdd,
    remove: redis.zRem,
    cleanup: redis.zRemRangeByScore,
    watch: redis.watch,
  }
  const data = new Map<string, string>()
  data.set('devsignal:legacy-comments-migration', '62')
  let maxPageSize = 0
  let commentCalls = 0
  try {
    redis.zAdd = (async () => 1) as typeof redis.zAdd
    redis.zRem = (async () => 1) as typeof redis.zRem
    reddit.getPostById = (async (id: string) => ({
      id,
      subredditName: Number(id.slice(3)) >= 1000 ? 'ChatGPT' : 'ClaudeAI',
      title: 'Claude API project',
      body: 'Source body',
      score: 20,
      numberOfComments: 5,
      stickied: false,
      createdAt: new Date(Date.now() - 1000),
    })) as unknown as typeof reddit.getPostById
    redis.del = (async (...keys: string[]) => {
      for (const key of keys) data.delete(key)
    }) as typeof redis.del
    redis.zRemRangeByScore = (async () => 0) as typeof redis.zRemRangeByScore
    redis.get = (async (key: string) => data.get(key)) as typeof redis.get
    redis.set = (async (key: string, value: string) => {
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
    const listing = (options: {
      subredditName?: string
      after?: string
      limit?: number
      pageSize?: number
    }) => {
      maxPageSize = Math.max(maxPageSize, options.pageSize ?? 0)
      const offset = options.after ? Number(options.after.slice(3)) + 1 : 0
      const start = options.subredditName === 'ChatGPT' ? 1000 : 0
      const adjusted = options.after ? offset : start
      const end = start + 110
      return {
        async *[Symbol.asyncIterator]() {
          for (
            let i = adjusted;
            i < Math.min(end, adjusted + (options.limit ?? 20));
            i++
          ) {
            yield {
              ...item(i),
              createdAt: new Date(),
              numberOfComments: 5,
              stickied: false,
              authorName: `user${i}`,
            }
          }
        },
      }
    }
    reddit.getNewPosts = listing as unknown as typeof reddit.getNewPosts
    reddit.getHotPosts = listing as unknown as typeof reddit.getHotPosts
    reddit.getTopPosts = listing as unknown as typeof reddit.getTopPosts
    reddit.getComments = ((options: {postId: string}) => {
      commentCalls++
      if (commentCalls === 1) throw new Error('simulated rate limit')
      return commentListing([
        {
          id: 't1_one',
          parentId: options.postId,
          authorName: 'commenter',
          body: 'hello',
          score: 3,
          createdAt: new Date(),
        },
        {
          id: 't1_one',
          parentId: options.postId,
          authorName: 'commenter',
          body: 'updated',
          score: 4,
          createdAt: new Date(),
        },
      ])
    }) as typeof reddit.getComments
    for (let i = 0; i < 80; i++) {
      const result = await runCollector()
      if (result.message === 'Daily scan complete.') break
    }
    for (const subreddit of ['ClaudeAI', 'ChatGPT']) {
      const cp = JSON.parse(
        data.get(`devsignal:checkpoints:${subreddit}`) ?? 'null',
      )
      assert.equal(cp.stage, 'COMPLETE')
      assert.equal(cp.processed, 200)
      assert.equal(Object.keys(cp.posts).length, 100)
      assert.equal(cp.candidates.length, 15)
      assert.equal(cp.commentOffset, 15)
    }
    assert.equal(maxPageSize, 20)
    assert.equal(commentCalls, 31)
    const records = [...data.entries()].filter(([key]) =>
      key.startsWith('devsignal:collections:'),
    )
    assert.equal(records.length, 30)
    const saved = JSON.parse(records[0]?.[1] ?? '{}')
    assert.equal(saved.comments.length, 1)
    assert.equal(saved.comments[0].body, 'updated')
    assert.equal(JSON.stringify(saved).includes('commenter'), false)
    assert.equal(
      [...data.keys()].some(key => key.startsWith('devsignal:comments:')),
      false,
    )
  } finally {
    redis.del = original.del
    redis.get = original.get
    redis.set = original.set
    redis.zRemRangeByScore = original.cleanup
    redis.watch = original.watch
    reddit.getNewPosts = original.newPosts
    reddit.getHotPosts = original.hotPosts
    reddit.getTopPosts = original.topPosts
    reddit.getComments = original.comments
    reddit.getPostById = original.post
    redis.zAdd = original.add
    redis.zRem = original.remove
  }
})

test('a held lease prevents concurrent work', async () => {
  const original = redis.set
  try {
    redis.set = (async () => '') as typeof redis.set
    const result = await runCollector()
    assert.equal(result.status, 'busy')
  } finally {
    redis.set = original
  }
})

test('an old worker does not release a newer lease', async () => {
  const original = {set: redis.set, get: redis.get, watch: redis.watch}
  let unwatched = false
  let deleted = false
  try {
    redis.set = (async () => 'OK') as typeof redis.set
    redis.get = (async (key: string) => {
      if (key === 'devsignal:collector-lock') return 'new-owner'
      throw new Error('checkpoint unavailable')
    }) as typeof redis.get
    redis.watch = (async () => ({
      unwatch: async () => {
        unwatched = true
      },
      multi: async () => {},
      del: async () => {
        deleted = true
      },
      exec: async () => [],
    })) as unknown as typeof redis.watch
    await assert.rejects(runCollector(), /checkpoint unavailable/)
    assert.equal(unwatched, true)
    assert.equal(deleted, false)
  } finally {
    redis.set = original.set
    redis.get = original.get
    redis.watch = original.watch
  }
})
