import assert from 'node:assert/strict'
import {test} from 'node:test'
import {snapshot} from '../server/test/collection.ts'
import {parseIngestMessage, RETENTION_MS, truncateText} from './collection.ts'

test('collector payload rejects identity fields, excess content, duplicates and processing-state injection', () => {
  const s = snapshot()
  assert.deepEqual(parseIngestMessage({action: 'upsert', snapshot: s}), {
    action: 'upsert',
    snapshot: s,
  })
  for (const invalid of [
    {...s, author: 'user'},
    {...s, post: {...s.post, authorName: 'user'}},
    {...s, comments: [{...s.comments[0], author: 'user'}]},
    {...s, comments: [...s.comments, ...s.comments]},
    {
      ...s,
      comments: Array.from({length: 31}, (_, i) => ({
        ...s.comments[0],
        id: `t1_${i}`,
      })),
    },
    {...s, post: {...s.post, body: 'x'.repeat(6001)}},
    {...s, comments: [{...s.comments[0], body: 'x'.repeat(701)}]},
    {...s, sourceSubreddit: 'other'},
    {...s, sourceId: 't3_abc?status=completed'},
    {...s, status: 'completed'},
    {...s, expiresAt: new Date(Date.now() + RETENTION_MS + 1000).toISOString()},
    {...s, runId: '2026-02-30'},
    {...s, commentSample: {...s.commentSample, pages: 3}},
    {...s, comments: [{...s.comments[0], body: '[deleted]'}]},
  ])
    assert.throws(() =>
      parseIngestMessage({action: 'upsert', snapshot: invalid}),
    )
})

test('text caps preserve whole Unicode characters accepted by PostgreSQL jsonb', () => {
  assert.equal(truncateText(`${'x'.repeat(699)}😀`, 700), 'x'.repeat(699))
  assert.equal(truncateText('😀', 2), '😀')
  const s = snapshot()
  assert.throws(() =>
    parseIngestMessage({
      action: 'upsert',
      snapshot: {...s, post: {...s.post, body: '\ud83d'}},
    }),
  )
})
