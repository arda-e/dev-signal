import {reddit} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'
import {
  COMMENT_BODY_LIMIT,
  COMMENT_LIMIT,
  COMMENT_MAX_PAGES,
  COMMENT_PAGE_SIZE,
  type CollectedComment,
  truncateText,
} from '../shared/collection.ts'

/** Replace the bounded sample on refresh; never merge deleted/old comments back in. */
export async function readComments(postId: T3) {
  const unique = new Map<string, CollectedComment>()
  let inspected = 0
  let pages = 0
  const listing = reddit.getComments({
    postId,
    sort: 'new',
    depth: 1,
    limit: COMMENT_LIMIT,
    pageSize: COMMENT_PAGE_SIZE,
  })
  const iterator = listing[Symbol.asyncIterator]()
  while (inspected < COMMENT_LIMIT) {
    // Listing.children is public in 0.15.2. Limit actual fetches too: short
    // MoreChildren pages must not turn a 30-item cap into dozens of API calls.
    if (inspected === listing.children.length) {
      if (pages > 0 && !listing.hasMore) break
      if (pages === COMMENT_MAX_PAGES) break
      pages++
    }
    const next = await iterator.next()
    if (next.done) break
    const comment = next.value
    if (
      comment.removed ||
      !comment.body ||
      ['[deleted]', '[removed]'].includes(comment.body)
    ) {
      unique.delete(comment.id)
    } else {
      unique.set(comment.id, {
        id: comment.id,
        parentId: comment.parentId,
        body: truncateText(comment.body, COMMENT_BODY_LIMIT),
        bodyTruncated: comment.body.length > COMMENT_BODY_LIMIT,
        score: comment.score,
        createdAt: comment.createdAt.toISOString(),
      })
    }
    inspected++
  }
  return {
    comments: [...unique.values()],
    sample: {
      sort: 'new' as const,
      depth: 1 as const,
      pages,
      limit: COMMENT_LIMIT,
      inspected,
      limitReached:
        inspected === COMMENT_LIMIT ||
        (pages === COMMENT_MAX_PAGES && listing.hasMore),
    },
  }
}
