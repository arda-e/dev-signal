import assert from 'node:assert/strict'
import {test} from 'node:test'
import {reddit} from '@devvit/web/server'
import {readComments} from './discussion.ts'

test('comment sampling is bounded, deduplicated and excludes identities and deleted text', async () => {
  const original = reddit.getComments
  let yielded = 0
  try {
    reddit.getComments = (() => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 100; i++) {
          yielded++
          yield {
            id: `t1_${Math.floor(i / 2)}`,
            body: i === 0 ? '[deleted]' : 'x'.repeat(1000),
            authorName: 'never-persist-this-user',
            score: 5,
          }
        }
      },
    })) as unknown as typeof reddit.getComments
    const comments = await readComments('t3_abc')
    assert.equal(yielded, 30)
    assert.equal(comments.length, 15)
    assert.equal(comments[0]?.body.length, 700)
    assert.deepEqual(Object.keys(comments[0] ?? {}).sort(), ['body', 'score'])
  } finally {
    reddit.getComments = original
  }
})
