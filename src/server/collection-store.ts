import {randomUUID} from 'node:crypto'
import {reddit, redis, settings} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'
import {
  type IngestMessage,
  POST_BODY_LIMIT,
  parseIngestMessage,
  RETENTION_MS,
  type Snapshot,
  SOURCE_SUBREDDITS,
  type SourceSubreddit,
  truncateText,
} from '../shared/collection.ts'
import {istanbulDay, nextMorning} from '../shared/scan-time.ts'
import {readComments} from './discussion.ts'
import {COLLECTOR_LOCK, COLLECTOR_LOCK_MS, releaseLease} from './lease.ts'
import {sendSnapshot, supabaseOrigin} from './supabase.ts'

export const EXPORT_QUEUE = 'devsignal:export-queue'
const FAILED_INDEX = 'devsignal:export-failures'
const ERROR_TTL = 7 * 86400_000
export const snapshotKey = (id: string) => `devsignal:collections:${id}`

/** Numeric codes only: never retain SDK exception text or source bodies in logs. */
export function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate_limited'
  if (/timeout|timed out|deadline/i.test(message)) return 'timeout'
  return 'upstream_failure'
}

export async function readSnapshot(
  sourceId: T3,
  subreddit: SourceSubreddit,
  runId: string,
  reasons: Snapshot['selectionReasons'],
  expiresAt?: string,
): Promise<Snapshot | undefined> {
  const source = await reddit.getPostById(sourceId)
  if (source.removed || ['[deleted]', '[removed]'].includes(source.body ?? ''))
    return undefined
  if (
    source.id !== sourceId ||
    source.subredditName.toLowerCase() !== subreddit.toLowerCase()
  )
    throw new Error('Source mismatch')
  const {comments, sample} = await readComments(sourceId)
  const collected = Date.now()
  const body = source.body ?? ''
  const snapshot: Snapshot = {
    schemaVersion: 1,
    sourceId,
    sourceSubreddit: subreddit,
    runId,
    collectedAt: new Date(collected).toISOString(),
    expiresAt: expiresAt ?? new Date(collected + RETENTION_MS).toISOString(),
    post: {
      title: truncateText(source.title, 300),
      body: truncateText(body, POST_BODY_LIMIT),
      bodyTruncated: body.length > POST_BODY_LIMIT,
      score: source.score,
      commentCount: source.numberOfComments,
      createdAt: source.createdAt.toISOString(),
      sticky: source.stickied,
    },
    comments,
    commentSample: sample,
    selectionReasons: reasons,
  }
  parseIngestMessage({action: 'upsert', snapshot})
  return snapshot
}

export async function storeSnapshot(snapshot: Snapshot) {
  parseIngestMessage({action: 'upsert', snapshot})
  // Queue first: a crash must not leave an unindexed source-content record.
  await redis.zAdd(EXPORT_QUEUE, {member: snapshot.sourceId, score: Date.now()})
  await redis.set(snapshotKey(snapshot.sourceId), JSON.stringify(snapshot), {
    expiration: new Date(snapshot.expiresAt),
  })
  await redis.del(
    `devsignal:export-attempts:${snapshot.sourceId}`,
    `devsignal:export-errors:${snapshot.sourceId}`,
  )
  await redis.zRem(FAILED_INDEX, [snapshot.sourceId])
}

/** Remove content from the known short-lived metadata snapshots as well as the inbox. */
async function pruneMetadata(id: string) {
  await redis.del(`devsignal:posts:${id}`, `devsignal:comments:${id}`)
  for (const sub of SOURCE_SUBREDDITS) {
    const keys = [`devsignal:checkpoints:${sub}`]
    for (let age = 0; age < 3; age++)
      keys.push(
        `devsignal:scan-runs:${sub}:${istanbulDay(Date.now() - age * 86400_000)}`,
      )
    for (const key of keys) {
      const raw = await redis.get(key)
      if (!raw) continue
      const cp = JSON.parse(raw) as {posts?: Record<string, unknown>}
      if (cp.posts?.[id]) {
        delete cp.posts[id]
        const expiry = await redis.expireTime(key)
        if (expiry * 1000 > Date.now())
          await redis.set(key, JSON.stringify(cp), {
            expiration: new Date(expiry * 1000),
          })
        else await redis.del(key)
      }
    }
  }
}
export async function queueDeletion(id: string) {
  await redis.zAdd(EXPORT_QUEUE, {member: id, score: Date.now()})
  await redis.del(snapshotKey(id))
  await pruneMetadata(id)
}

/** One source per call; source refresh, replacement sample and delivery share the scan lease. */
export async function processExportQueue() {
  if ((await settings.get<boolean>('collector-export-enabled')) !== true)
    return {status: 'disabled', message: 'Collector export is disabled.'}
  const url = await settings.get<string>('supabase-project-url')
  const token = await settings.get<string>('supabase-ingest-token')
  if (!url || !token || token.length < 32)
    return {
      status: 'needs_configuration',
      message: 'Configure Supabase URL and restricted ingest token.',
    }
  try {
    supabaseOrigin(url)
  } catch {
    return {
      status: 'needs_configuration',
      message: 'Configure an exact HTTPS Supabase project origin.',
    }
  }
  const lease = randomUUID()
  if (
    !(await redis.set(COLLECTOR_LOCK, lease, {
      nx: true,
      expiration: new Date(Date.now() + COLLECTOR_LOCK_MS),
    }))
  )
    return {status: 'busy', message: 'Collector or export is already running.'}
  try {
    await redis.zRemRangeByScore(FAILED_INDEX, 0, Date.now())
    const item = (await redis.zRange(EXPORT_QUEUE, 0, 0))[0]
    if (!item || item.score > Date.now())
      return {status: 'idle', message: 'No due inbox deliveries.'}
    const id = item.member as T3
    const attemptKey = `devsignal:export-attempts:${id}`
    try {
      const raw = await redis.get(snapshotKey(id))
      let snapshot = raw ? (JSON.parse(raw) as Snapshot) : undefined
      if (snapshot && Date.parse(snapshot.expiresAt) > Date.now()) {
        snapshot = await readSnapshot(
          id,
          snapshot.sourceSubreddit,
          snapshot.runId,
          snapshot.selectionReasons,
          snapshot.expiresAt,
        )
      } else snapshot = undefined
      let outgoing: IngestMessage
      if (snapshot) {
        // Persist the exact retry payload before sending. Retention is not extended by maintenance.
        await redis.set(snapshotKey(id), JSON.stringify(snapshot), {
          expiration: new Date(snapshot.expiresAt),
        })
        outgoing = {action: 'upsert', snapshot}
      } else {
        await redis.del(snapshotKey(id))
        await pruneMetadata(id)
        outgoing = {action: 'delete', sourceId: id}
      }
      await sendSnapshot(outgoing, {url, token})
      await redis.del(attemptKey, `devsignal:export-errors:${id}`)
      if (snapshot)
        await redis.zAdd(EXPORT_QUEUE, {
          member: id,
          score: Math.min(
            nextMorning(Date.now()),
            Date.parse(snapshot.expiresAt),
          ),
        })
      else await redis.zRem(EXPORT_QUEUE, [id])
      return {
        status: snapshot ? 'synced' : 'deleted',
        sourceId: id,
        message: 'Processed one inbox delivery.',
      }
    } catch (error) {
      const count = Number((await redis.get(attemptKey)) ?? '0') + 1
      const expiration = new Date(Date.now() + ERROR_TTL)
      await redis.set(attemptKey, String(count), {expiration})
      const code = failureCode(error)
      await redis.set(
        `devsignal:export-errors:${id}`,
        JSON.stringify({
          code,
          attempts: count,
          lastRun: new Date().toISOString(),
        }),
        {expiration},
      )
      if (count >= 5) {
        await redis.zAdd(FAILED_INDEX, {
          member: id,
          score: expiration.getTime(),
        })
        await redis.zRem(EXPORT_QUEUE, [id])
        return {
          status: 'failed',
          sourceId: id,
          code,
          message:
            'Five delivery attempts failed; inspect the failure index before requeuing.',
        }
      }
      await redis.zAdd(EXPORT_QUEUE, {
        member: id,
        score: Date.now() + 60_000 * 2 ** (count - 1),
      })
      return {
        status: 'retry',
        sourceId: id,
        code,
        message: 'Inbox delivery will retry with backoff.',
      }
    }
  } finally {
    await releaseLease(COLLECTOR_LOCK, lease, () =>
      console.error(
        'Collector/export lease release failed; waiting for expiry.',
      ),
    )
  }
}
