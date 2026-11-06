import {reddit, redis, settings} from '@devvit/web/server'
import {Listing} from '../../../node_modules/@devvit/reddit/models/Listing.js'
import {RETENTION_MS, type Snapshot} from '../../shared/collection.ts'

export function snapshot(): Snapshot {
  const now = Date.now()
  return {
    schemaVersion: 1,
    sourceId: 't3_abc',
    sourceSubreddit: 'ClaudeAI',
    runId: new Date(now).toISOString().slice(0, 10),
    collectedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RETENTION_MS - 1000).toISOString(),
    post: {
      title: 'Claude API discussion',
      body: 'Original post',
      bodyTruncated: false,
      score: 12,
      commentCount: 3,
      createdAt: new Date(now - 3600_000).toISOString(),
      sticky: false,
    },
    comments: [
      {
        id: 't1_one',
        parentId: 't3_abc',
        body: 'A technical observation',
        bodyTruncated: false,
        score: 2,
        createdAt: new Date(now - 1000).toISOString(),
      },
    ],
    commentSample: {
      sort: 'new',
      depth: 1,
      pages: 1,
      limit: 30,
      inspected: 1,
      limitReached: false,
    },
    selectionReasons: ['technical-title', 'recent'],
  }
}
export function commentListing(comments: unknown[], pageSize = 15) {
  let offset = 0
  return Reflect.construct(Listing, [
    {
      pageSize: 15,
      limit: 30,
      fetch: async () => {
        const children = comments.slice(offset, offset + pageSize)
        offset += pageSize
        return {
          children,
          ...(offset < comments.length ? {after: String(offset)} : {}),
        }
      },
    },
  ]) as ReturnType<typeof reddit.getComments>
}

/** In-memory network/storage boundaries; production collector/sender/handler run unchanged. */
export function installCollectionFakes() {
  const original = {
    get: redis.get,
    set: redis.set,
    del: redis.del,
    watch: redis.watch,
    zAdd: redis.zAdd,
    zRem: redis.zRem,
    zRange: redis.zRange,
    cleanup: redis.zRemRangeByScore,
    expireTime: redis.expireTime,
    setting: settings.get,
    post: reddit.getPostById,
    comments: reddit.getComments,
    fetch: globalThis.fetch,
  }
  const data = new Map<string, string>()
  const expires = new Map<string, number>()
  const sets = new Map<string, Map<string, number>>()
  const config = new Map<string, unknown>([
    ['collector-export-enabled', true],
    ['supabase-project-url', 'https://projectref.supabase.co'],
    [
      'supabase-ingest-token',
      'restricted-test-token-with-at-least-32-characters',
    ],
  ])
  data.set('devsignal:legacy-comments-migration', '62')
  const current = snapshot()
  const source = {
    id: current.sourceId,
    subredditName: current.sourceSubreddit,
    title: current.post.title,
    body: current.post.body,
    score: 12,
    numberOfComments: 3,
    stickied: false,
    removed: false,
    createdAt: new Date(current.post.createdAt),
    authorName: 'not-exported',
  }
  const comments = current.comments.map(c => ({
    ...c,
    createdAt: new Date(c.createdAt),
    authorName: 'not-exported',
  }))
  redis.get = (async key => {
    if ((expires.get(key) ?? Infinity) <= Date.now()) data.delete(key)
    return data.get(key)
  }) as typeof redis.get
  redis.set = (async (key, value, options) => {
    if (options?.nx && (await redis.get(key))) return ''
    data.set(key, value)
    if (options?.expiration) expires.set(key, options.expiration.getTime())
    else expires.delete(key)
    return 'OK'
  }) as typeof redis.set
  redis.del = (async (...keys) => {
    for (const key of keys) {
      data.delete(key)
      expires.delete(key)
    }
  }) as typeof redis.del
  redis.expireTime = (async key =>
    data.has(key)
      ? Math.floor((expires.get(key) ?? -1000) / 1000)
      : -2) as typeof redis.expireTime
  redis.watch = (async () => ({
    multi: async () => {},
    del: redis.del,
    exec: async () => [],
    unwatch: async () => {},
  })) as unknown as typeof redis.watch
  redis.zAdd = (async (key, ...members) => {
    const set = sets.get(key) ?? new Map<string, number>()
    for (const {member, score} of members) set.set(member, score)
    sets.set(key, set)
    return members.length
  }) as typeof redis.zAdd
  redis.zRange = (async (key, start, stop) =>
    [...(sets.get(key) ?? new Map<string, number>())]
      .map(([member, score]) => ({member, score}))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member))
      .slice(Number(start), Number(stop) + 1)) as typeof redis.zRange
  redis.zRem = (async (key, members) => {
    for (const id of members) sets.get(key)?.delete(id)
    return members.length
  }) as typeof redis.zRem
  redis.zRemRangeByScore = (async (key, min, max) => {
    let count = 0
    for (const [id, score] of sets.get(key) ?? [])
      if (score >= min && score <= max) {
        sets.get(key)?.delete(id)
        count++
      }
    return count
  }) as typeof redis.zRemRangeByScore
  settings.get = (async key => config.get(key)) as typeof settings.get
  reddit.getPostById = (async () =>
    source) as unknown as typeof reddit.getPostById
  reddit.getComments = (() =>
    commentListing(comments)) as typeof reddit.getComments
  return {
    data,
    expires,
    sets,
    config,
    source,
    comments,
    restore() {
      redis.get = original.get
      redis.set = original.set
      redis.del = original.del
      redis.watch = original.watch
      redis.zAdd = original.zAdd
      redis.zRem = original.zRem
      redis.zRange = original.zRange
      redis.zRemRangeByScore = original.cleanup
      redis.expireTime = original.expireTime
      settings.get = original.setting
      reddit.getPostById = original.post
      reddit.getComments = original.comments
      globalThis.fetch = original.fetch
    },
  }
}
