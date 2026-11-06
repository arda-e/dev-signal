import assert from 'node:assert/strict'
import {test} from 'node:test'
import {reddit} from '@devvit/web/server'
import {readComments} from './discussion.ts'
import {commentListing} from './test/collection.ts'

test('comment sampling is bounded, deduplicated and preserves thread context without author fields', async () => {
  const original = reddit.getComments
  let yielded = 0
  try {
    const rows = Array.from({length: 100}, (_, i) => ({
      id: `t1_${Math.floor(i / 2)}`,
      parentId: 't3_abc',
      createdAt: new Date('2026-11-06T03:00:00Z'),
      body: i === 0 ? '[deleted]' : 'x'.repeat(1000),
      authorName: 'never-persist-this-user',
      score: 5,
    }))
    const listing = commentListing(rows)
    const iterator = listing[Symbol.asyncIterator].bind(listing)
    listing[Symbol.asyncIterator] = () => {
      const inner = iterator()
      return {
        next: async () => {
          const value = await inner.next()
          if (!value.done) yielded++
          return value
        },
      }
    }
    reddit.getComments = (() => listing) as typeof reddit.getComments
    const comments = await readComments('t3_abc')
    assert.equal(yielded, 30)
    assert.equal(comments.comments.length, 15)
    assert.equal(comments.comments[0]?.body.length, 700)
    assert.equal(comments.comments[0]?.parentId, 't3_abc')
    assert.equal(comments.comments[0]?.createdAt, '2026-11-06T03:00:00.000Z')
    assert.equal(comments.comments[0]?.bodyTruncated, true)
    assert.equal(
      JSON.stringify(comments).includes('never-persist-this-user'),
      false,
    )
    assert.deepEqual(comments.sample, {
      sort: 'new',
      depth: 1,
      pages: 2,
      limit: 30,
      inspected: 30,
      limitReached: true,
    })
  } finally {
    reddit.getComments = original
  }
})

test('short SDK pages stop after two actual fetches, and never traverse replies', async () => {
  const original = reddit.getComments
  let requested = 0
  try {
    reddit.getComments = (options => {
      assert.equal(options.depth, 1)
      assert.equal(options.pageSize, 15)
      assert.equal(options.limit, 30)
      requested++
      return commentListing(
        Array.from({length: 100}, (_, i) => ({
          id: `t1_${i}`,
          parentId: 't3_abc',
          createdAt: new Date('2026-11-06T03:00:00Z'),
          body: 'Short page',
          score: 1,
          replies: {
            get() {
              throw new Error('must not traverse replies')
            },
          },
        })),
        1,
      )
    }) as typeof reddit.getComments
    const result = await readComments('t3_abc')
    assert.equal(requested, 1)
    assert.equal(result.comments.length, 2)
    assert.equal(result.sample.pages, 2)
    assert.equal(result.sample.limitReached, true)
  } finally {
    reddit.getComments = original
  }
})

test('empty listings stop, and a repeated deleted comment removes its earlier copy', async () => {
  const original = reddit.getComments
  try {
    reddit.getComments = (() => commentListing([])) as typeof reddit.getComments
    assert.deepEqual((await readComments('t3_abc')).comments, [])
    reddit.getComments = (() =>
      commentListing([
        {
          id: 't1_one',
          parentId: 't3_abc',
          body: 'Old text',
          score: 1,
          createdAt: new Date(),
        },
        {
          id: 't1_one',
          parentId: 't3_abc',
          body: '[deleted]',
          score: 1,
          createdAt: new Date(),
        },
      ])) as typeof reddit.getComments
    assert.deepEqual((await readComments('t3_abc')).comments, [])
  } finally {
    reddit.getComments = original
  }
})
