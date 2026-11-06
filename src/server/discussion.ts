import {reddit} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'

/** Source text lives only in this invocation; never write it to Redis or logs. */
export async function readComments(postId: T3) {
  const unique = new Map<string, {body: string; score: number}>()
  let inspected = 0
  for await (const comment of reddit.getComments({
    postId,
    sort: 'new',
    limit: 30,
    pageSize: 15,
  })) {
    if (comment.body && !['[deleted]', '[removed]'].includes(comment.body)) {
      unique.set(comment.id, {
        body: comment.body.slice(0, 700),
        score: comment.score,
      })
    }
    if (++inspected >= 30) break
  }
  return [...unique.values()]
}
