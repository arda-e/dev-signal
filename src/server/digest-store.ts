import {reddit, redis, settings} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'
import {
  DIGEST_RETENTION_MS,
  type Digest,
  type IngestMessage,
} from '../shared/digest.ts'
import {sendDigest} from './supabase.ts'

const QUEUE = 'devsignal:digest-queue'
const DAY = 86400_000
export const digestKey = (id: string) => `devsignal:digests:${id}`
export function sourceUnavailable(source: {
  removed?: boolean
  body?: string
  authorName?: string
}) {
  return (
    source.removed ||
    source.body === '[deleted]' ||
    source.body === '[removed]' ||
    source.authorName === '[deleted]'
  )
}
export async function storeDigest(digest: Digest) {
  await redis.set(digestKey(digest.sourceId), JSON.stringify(digest), {
    expiration: new Date(digest.expiresAt),
  })
  await redis.zAdd(QUEUE, {member: digest.sourceId, score: Date.now()})
}

/** One due item: initial sync, then a daily source-deletion check. */
export async function processDigestQueue() {
  const next = (await redis.zRange(QUEUE, 0, 0))[0]
  if (!next || next.score > Date.now()) return undefined
  const id = next.member as T3
  const attemptKey = `devsignal:digest-attempts:${id}`
  const enabled = (await settings.get<boolean>('supabase-enabled')) === true
  const url = enabled ? await settings.get<string>('supabase-project-url') : ''
  const token = enabled
    ? await settings.get<string>('supabase-ingest-token')
    : ''
  if (enabled && (!url || !token))
    return {
      status: 'needs_configuration',
      message: 'Configure Supabase URL and ingest token.',
    }
  const attempts = Number((await redis.get(attemptKey)) ?? '0')
  try {
    const raw = await redis.get(digestKey(id))
    const digest = raw ? (JSON.parse(raw) as Digest) : undefined
    let outgoing: IngestMessage = {action: 'delete', sourceId: id}
    let nextCheck: number | undefined
    let status = 'expired'
    if (digest && Date.parse(digest.expiresAt) > Date.now()) {
      const removed = sourceUnavailable(await reddit.getPostById(id))
      if (removed) {
        const ownPost = await reddit.getPostById(digest.publishedPostId as T3)
        // Edit only the exact app-created post recorded at submission, never a source post.
        if (!sourceUnavailable(ownPost))
          await ownPost.edit({
            text: 'Bu özet, kaynak tartışma artık mevcut olmadığı için geri çekilmiştir.',
          })
        status = 'withdrawn'
      } else {
        outgoing = {action: 'upsert', digest}
        nextCheck = Math.min(Date.now() + DAY, Date.parse(digest.expiresAt))
        status = enabled ? 'synced' : 'checked'
      }
    }
    if (enabled && url && token) await sendDigest(outgoing, {url, token})
    await redis.del(attemptKey)
    if (nextCheck === undefined) {
      await redis.del(digestKey(id))
      await redis.zRem(QUEUE, [id])
    } else await redis.zAdd(QUEUE, {member: id, score: nextCheck})
    return {
      status,
      message: 'Processed one digest maintenance item.',
      sourceId: id,
    }
  } catch {
    const count = attempts + 1
    await redis.set(attemptKey, String(count), {
      expiration: new Date(Date.now() + DIGEST_RETENTION_MS),
    })
    if (count >= 5) {
      await redis.zRem(QUEUE, [id])
      return {
        status: 'maintenance_failed',
        message:
          'Five maintenance attempts failed; inspect this source before requeuing.',
        sourceId: id,
      }
    }
    await redis.zAdd(QUEUE, {
      member: id,
      score: Date.now() + 60_000 * 2 ** attempts,
    })
    return {
      status: 'retry',
      message: 'Digest maintenance failed; retry scheduled with backoff.',
      sourceId: id,
    }
  }
}
