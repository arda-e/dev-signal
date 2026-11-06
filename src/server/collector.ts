import {createHash, randomUUID} from 'node:crypto'
import {reddit, redis} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'
import {SOURCE_SUBREDDITS} from '../shared/digest.ts'
import {istanbulDay} from '../shared/scan-time.ts'
import {releaseLease} from './lease.ts'

const SUBREDDITS = SOURCE_SUBREDDITS
const TTL = 48 * 60 * 60 * 1000
const PAGE_SIZE = 20
const POSTS_PER_CHUNK = 3
const MAX_CANDIDATES = 15
const LOCK_MS = 180_000

type Stage =
  | 'DISCOVER_NEW'
  | 'DISCOVER_HOT'
  | 'DISCOVER_TOP'
  | 'DEDUPLICATE'
  | 'PREFILTER'
  | 'FETCH_COMMENTS'
  | 'COMPLETE'
type PostRecord = {
  id: T3
  subreddit: string
  title: string
  author: string
  url: string
  score: number
  commentCount: number
  createdAt: string
  sticky: boolean
  megathread: boolean
  repeatedMegathread: boolean
  previouslySeen: boolean
  sources: string[]
}
type Checkpoint = {
  subreddit: string
  runId: string
  stage: Stage
  cursor: string | null
  processed: number
  stageCount: number
  commentOffset: number
  lastRun: string
  errors: string[]
  posts: Record<string, PostRecord>
  candidates: T3[]
}

function expiration(now = Date.now()): Date {
  return new Date(now + TTL)
}
async function put(key: string, value: unknown): Promise<void> {
  await redis.set(key, JSON.stringify(value), {expiration: expiration()})
}
function runDay(now: Date): string {
  return istanbulDay(now.getTime())
}
function initial(subreddit: string, runId: string): Checkpoint {
  return {
    subreddit,
    runId,
    stage: 'DISCOVER_NEW',
    cursor: null,
    processed: 0,
    stageCount: 0,
    commentOffset: 0,
    lastRun: '',
    errors: [],
    posts: {},
    candidates: [],
  }
}
const nextStage: Record<string, Stage> = {
  DISCOVER_NEW: 'DISCOVER_HOT',
  DISCOVER_HOT: 'DISCOVER_TOP',
  DISCOVER_TOP: 'DEDUPLICATE',
}
const targets: Record<string, number> = {
  DISCOVER_NEW: 100,
  DISCOVER_HOT: 50,
  DISCOVER_TOP: 50,
}

/** Lightweight metadata ranking; this is not editorial or model-based scoring. */
export function candidateScore(
  post: PostRecord,
  now: number,
  authorCount = 0,
): number {
  const technical =
    /\b(api|code|coding|developer|development|software|model|llm|ai|agent|claude|gpt|prompt|tool|build|project|open.source|python|javascript|typescript|release|research)\b/i.test(
      post.title,
    )
  const ageHours = Math.max(0, (now - Date.parse(post.createdAt)) / 3_600_000)
  return (
    (technical ? 5 : 0) +
    Math.max(0, 4 - ageHours / 12) +
    Math.min(4, Math.log2(post.commentCount + 1) / 2) +
    Math.min(2, Math.log2(Math.max(0, post.score) + 1) / 5) -
    (post.sticky ? 4 : 0) -
    (post.megathread ? 2 : 0) -
    (post.repeatedMegathread ? 2 : 0) -
    (post.previouslySeen ? 2 : 0) -
    authorCount * 2
  )
}
export function selectCandidates(posts: PostRecord[], now: number): T3[] {
  const remaining = posts.filter(post => post.commentCount > 0)
  const selected: T3[] = []
  const authors = new Map<string, number>()
  while (remaining.length && selected.length < MAX_CANDIDATES) {
    remaining.sort(
      (a, b) =>
        candidateScore(b, now, authors.get(b.author) ?? 0) -
          candidateScore(a, now, authors.get(a.author) ?? 0) ||
        a.id.localeCompare(b.id),
    )
    const post = remaining.shift()
    if (!post) break
    selected.push(post.id)
    authors.set(post.author, (authors.get(post.author) ?? 0) + 1)
  }
  return selected
}

async function discover(cp: Checkpoint): Promise<void> {
  const stage = cp.stage
  const target = targets[stage]
  const next = nextStage[stage]
  if (target === undefined || next === undefined)
    throw new Error(`Invalid discovery stage: ${stage}`)
  const size = Math.min(PAGE_SIZE, target - cp.stageCount)
  const options = {
    subredditName: cp.subreddit,
    limit: size,
    pageSize: size,
    ...(cp.cursor ? {after: cp.cursor} : {}),
  }
  const listing =
    stage === 'DISCOVER_NEW'
      ? reddit.getNewPosts(options)
      : stage === 'DISCOVER_HOT'
        ? reddit.getHotPosts(options)
        : reddit.getTopPosts({...options, timeframe: 'day'})
  const posts = []
  // The SDK's async iterator stops when a page is empty; .all() can loop on empty pages.
  for await (const post of listing) {
    posts.push(post)
    if (posts.length === size) break
  }
  for (const post of posts) {
    const old = cp.posts[post.id]
    const saved = old
      ? undefined
      : await redis.get(`devsignal:posts:${post.id}`)
    const prior = saved ? (JSON.parse(saved) as {runId?: string}) : undefined
    const megathread =
      /\b(mega\s*thread|daily thread|weekly thread|monthly thread)\b/i.test(
        post.title,
      )
    const signature = (title: string) =>
      title
        .toLowerCase()
        .replace(/\d+/g, '')
        .replace(/[^a-z]+/g, ' ')
        .trim()
    const previouslySeen =
      old?.previouslySeen ?? Boolean(prior && prior.runId !== cp.runId)
    const repeatedMegathread =
      megathread &&
      (previouslySeen ||
        Object.values(cp.posts).some(
          item =>
            item.id !== post.id &&
            item.megathread &&
            signature(item.title) === signature(post.title),
        ))
    const record: PostRecord = {
      id: post.id,
      subreddit: cp.subreddit,
      title: post.title,
      author: createHash('sha256')
        .update(`${cp.runId}:${post.authorName}`)
        .digest('hex'),
      url: post.url,
      score: post.score,
      commentCount: post.numberOfComments,
      createdAt: post.createdAt.toISOString(),
      sticky: post.stickied,
      megathread,
      repeatedMegathread: old?.repeatedMegathread || repeatedMegathread,
      previouslySeen,
      sources: [...new Set([...(old?.sources ?? []), stage])],
    }
    cp.posts[post.id] = record
    await put(`devsignal:posts:${post.id}`, {...record, runId: cp.runId})
  }
  cp.stageCount += posts.length
  cp.processed += posts.length
  const cursor = posts.at(-1)?.id ?? null
  if (
    !cursor ||
    cursor === cp.cursor ||
    posts.length < size ||
    cp.stageCount >= target
  ) {
    if (cp.stageCount < target)
      cp.errors.push(
        `${stage}: listing exhausted after ${cp.stageCount}/${target} posts`,
      )
    cp.stage = next
    cp.cursor = null
    cp.stageCount = 0
  } else cp.cursor = cursor
}

async function enrich(cp: Checkpoint): Promise<void> {
  const ids = cp.candidates.slice(
    cp.commentOffset,
    cp.commentOffset + POSTS_PER_CHUNK,
  )
  for (const postId of ids) {
    // Retain this checkpoint stage for compatibility with in-progress runs.
    // Comments are now fetched fresh by the digest worker and never persisted.
    await redis.del(`devsignal:comments:${postId}`)
    cp.commentOffset++
  }
  cp.cursor = String(cp.commentOffset)
  if (cp.commentOffset >= cp.candidates.length) {
    cp.stage = 'COMPLETE'
    cp.cursor = null
  }
}

async function save(cp: Checkpoint): Promise<void> {
  cp.lastRun = new Date().toISOString()
  cp.errors = cp.errors.slice(-50)
  await put(`devsignal:scan-runs:${cp.subreddit}:${cp.runId}`, cp)
  await put(`devsignal:checkpoints:${cp.subreddit}`, cp)
}

export async function runCollector() {
  const token = randomUUID()
  const lease = await redis.set('devsignal:collector-lock', token, {
    nx: true,
    expiration: new Date(Date.now() + LOCK_MS),
  })
  if (!lease)
    return {
      status: 'busy',
      message: 'Another scan is running or its lease has not expired.',
    }
  try {
    await purgeLegacyComments()
    return await runChunk()
  } finally {
    await releaseLease('devsignal:collector-lock', token, error =>
      console.error('Could not release collector lock:', error),
    )
  }
}

async function purgeLegacyComments() {
  const key = 'devsignal:legacy-comments-migration'
  const index = Number((await redis.get(key)) ?? '0')
  if (index >= 62) return
  const subreddit = SUBREDDITS[index % 2]
  const day = runDay(new Date(Date.now() - Math.floor(index / 2) * 86400_000))
  const snapshots = await Promise.all([
    redis.get(`devsignal:scan-runs:${subreddit}:${day}`),
    redis.get(`devsignal:checkpoints:${subreddit}`),
  ])
  const ids = new Set<string>()
  for (const snapshot of snapshots) {
    if (!snapshot) continue
    const cp = JSON.parse(snapshot) as Checkpoint
    for (const id of [...Object.keys(cp.posts ?? {}), ...(cp.candidates ?? [])])
      if (/^t3_[a-z0-9]+$/i.test(id)) ids.add(id)
  }
  if (ids.size)
    await redis.del(
      ...[...ids].slice(0, 400).map(id => `devsignal:comments:${id}`),
    )
  await redis.set(key, String(index + 1))
}

async function runChunk() {
  const today = runDay(new Date())
  const checkpoints: Checkpoint[] = []
  for (const subreddit of SUBREDDITS) {
    const raw = await redis.get(`devsignal:checkpoints:${subreddit}`)
    let cp = raw ? (JSON.parse(raw) as Checkpoint) : initial(subreddit, today)
    if (cp.stage === 'COMPLETE' && cp.runId < today)
      cp = initial(subreddit, today)
    for (const post of Object.values(cp.posts ?? {})) {
      if (!/^[a-f0-9]{64}$/.test(post.author))
        post.author = createHash('sha256')
          .update(`${cp.runId}:${post.author}`)
          .digest('hex')
    }
    checkpoints.push(cp)
  }
  const cp = checkpoints
    .filter(value => value.stage !== 'COMPLETE')
    .sort((a, b) => a.lastRun.localeCompare(b.lastRun))[0]
  if (!cp) return {status: 'ok', message: 'Daily scan complete.'}
  const errorCount = cp.errors.length
  try {
    if (cp.stage.startsWith('DISCOVER_')) await discover(cp)
    else if (cp.stage === 'DEDUPLICATE')
      cp.stage = 'PREFILTER' // IDs are deduplicated during discovery.
    else if (cp.stage === 'PREFILTER') {
      cp.candidates = selectCandidates(Object.values(cp.posts), Date.now())
      await put(
        `devsignal:candidates:${cp.subreddit}:${cp.runId}`,
        cp.candidates,
      )
      cp.stage = cp.candidates.length ? 'FETCH_COMMENTS' : 'COMPLETE'
    } else if (cp.stage === 'FETCH_COMMENTS') await enrich(cp)
    const hasNewErrors = cp.errors.length > errorCount
    await save(cp)
    await redis.zRemRangeByScore('devsignal:post-index', 0, Date.now() - TTL)
    return {
      status: hasNewErrors ? 'partial' : 'ok',
      subreddit: cp.subreddit,
      stage: cp.stage,
      processed: cp.processed,
      candidates: cp.candidates.length,
      commentOffset: cp.commentOffset,
      errors: cp.errors,
    }
  } catch (error) {
    cp.errors.push(`${cp.stage}: ${String(error).slice(0, 300)}`)
    await save(cp)
    return {
      status: 'partial',
      subreddit: cp.subreddit,
      stage: cp.stage,
      errors: cp.errors,
    }
  }
}
