import {reddit, redis, settings} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'
import {
  DIGEST_RETENTION_MS,
  type Digest,
  type IngestMessage,
} from '../shared/digest.ts'
import {nextMorning} from '../shared/scan-time.ts'
import {sendDigest} from './supabase.ts'

export const DIGEST_QUEUE = 'devsignal:digest-queue'
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
  await redis.zAdd(DIGEST_QUEUE, {member: digest.sourceId, score: Date.now()})
}

/** A bounded parallel chunk keeps 30 days of source checks within the morning window. */
export async function processDigestQueue() {
  const due = (await redis.zRange(DIGEST_QUEUE, 0, 4)).filter(
    item => item.score <= Date.now(),
  )
  if (!due.length) return undefined
  const enabled = (await settings.get<boolean>('supabase-enabled')) === true
  const url = enabled ? await settings.get<string>('supabase-project-url') : ''
  const token = enabled
    ? await settings.get<string>('supabase-ingest-token')
    : ''
  if (enabled && (!url || !token))
    return {
      status: 'needs_configuration',
      message: 'Configure Supabase URL and ingest token.',
      processed: 0,
    }
  const results = await Promise.all(
    due.map(item =>
      processDigestItem(item.member as T3, {enabled, url, token}),
    ),
  )
  const priority = [
    'maintenance_failed',
    'retry',
    'withdrawn',
    'expired',
    'synced',
    'checked',
  ]
  const primary = results.reduce((a, b) =>
    priority.indexOf(a.status) <= priority.indexOf(b.status) ? a : b,
  )
  return {
    ...primary,
    message: `Processed ${results.length} digest maintenance items.`,
    processed: results.length,
  }
}

async function processDigestItem(
  id: T3,
  config: {
    enabled: boolean
    url: string | undefined
    token: string | undefined
  },
) {
  const {enabled, url, token} = config
  const attemptKey = `devsignal:digest-attempts:${id}`
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
        nextCheck = Math.min(
          nextMorning(Date.now()),
          Date.parse(digest.expiresAt),
        )
        status = enabled ? 'synced' : 'checked'
      }
    }
    if (enabled && url && token) await sendDigest(outgoing, {url, token})
    await redis.del(attemptKey)
    if (nextCheck === undefined) {
      await redis.del(digestKey(id))
      await redis.zRem(DIGEST_QUEUE, [id])
    } else await redis.zAdd(DIGEST_QUEUE, {member: id, score: nextCheck})
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
      await redis.zRem(DIGEST_QUEUE, [id])
      return {
        status: 'maintenance_failed',
        message:
          'Five maintenance attempts failed; inspect this source before requeuing.',
        sourceId: id,
      }
    }
    await redis.zAdd(DIGEST_QUEUE, {
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
