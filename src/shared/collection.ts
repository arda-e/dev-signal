export const SOURCE_SUBREDDITS = ['ClaudeAI', 'ChatGPT'] as const
export const RETENTION_MS = 48 * 60 * 60 * 1000
export const POST_BODY_LIMIT = 6000
export const COMMENT_BODY_LIMIT = 700
export const COMMENT_LIMIT = 30
export const COMMENT_PAGE_SIZE = 15
export const COMMENT_MAX_PAGES = 2
export const MAX_PAYLOAD_BYTES = 160_000
export const SELECTION_REASONS = [
  'technical-title',
  'recent',
  'active-discussion',
  'multiple-listings',
  'sticky-penalty',
  'megathread-penalty',
  'previously-seen-penalty',
] as const
export type SourceSubreddit = (typeof SOURCE_SUBREDDITS)[number]
export type CollectedComment = {
  id: string
  parentId: string
  body: string
  bodyTruncated: boolean
  score: number
  createdAt: string
}
export type CommentSample = {
  sort: 'new'
  depth: 1
  pages: number
  limit: number
  inspected: number
  limitReached: boolean
}
export type Snapshot = {
  schemaVersion: 1
  sourceId: string
  sourceSubreddit: SourceSubreddit
  runId: string
  collectedAt: string
  expiresAt: string
  post: {
    title: string
    body: string
    bodyTruncated: boolean
    score: number
    commentCount: number
    createdAt: string
    sticky: boolean
  }
  comments: CollectedComment[]
  commentSample: CommentSample
  selectionReasons: (typeof SELECTION_REASONS)[number][]
}
export type IngestMessage =
  | {action: 'upsert'; snapshot: Snapshot}
  | {action: 'delete'; sourceId: string}

/** PostgreSQL jsonb rejects unmatched surrogates; never split an emoji at a cap. */
export function truncateText(value: string, limit: number): string {
  let end = Math.min(limit, value.length)
  const last = value.charCodeAt(end - 1)
  if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--
  return value.slice(0, end)
}

function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object')
  const obj = value as Record<string, unknown>
  if (
    Object.keys(obj).length !== keys.length ||
    Object.keys(obj).some(key => !keys.includes(key))
  )
    throw new Error('Unexpected fields')
  return obj
}
function text(value: unknown, limit: number, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    /[\uD800-\uDFFF]/u.test(value) ||
    (!empty && !value.trim())
  )
    throw new Error('Invalid text')
}
function integer(value: unknown, minimum = -Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error('Invalid integer')
}
function boolean(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Invalid boolean')
}
function timestamp(value: unknown, now: number) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) > now + 60_000
  )
    throw new Error('Invalid timestamp')
}
export function validSourceId(value: unknown): value is string {
  return typeof value === 'string' && /^t3_[a-z0-9]+$/.test(value)
}

/** Shared allowlist: ingestion cannot accept authors, model output or arbitrary fields. */
export function parseIngestMessage(
  value: unknown,
  now = Date.now(),
): IngestMessage {
  const action = (value as {action?: unknown} | null)?.action
  if (action === 'delete') {
    const obj = object(value, ['action', 'sourceId'])
    if (!validSourceId(obj.sourceId)) throw new Error('Invalid source ID')
    return {action, sourceId: obj.sourceId}
  }
  const obj = object(value, ['action', 'snapshot'])
  if (action !== 'upsert') throw new Error('Invalid action')
  const s = object(obj.snapshot, [
    'schemaVersion',
    'sourceId',
    'sourceSubreddit',
    'runId',
    'collectedAt',
    'expiresAt',
    'post',
    'comments',
    'commentSample',
    'selectionReasons',
  ])
  if (
    s.schemaVersion !== 1 ||
    !validSourceId(s.sourceId) ||
    !SOURCE_SUBREDDITS.some(sub => sub === s.sourceSubreddit) ||
    typeof s.runId !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(s.runId) ||
    !Number.isFinite(Date.parse(s.runId)) ||
    new Date(s.runId).toISOString().slice(0, 10) !== s.runId
  )
    throw new Error('Invalid source metadata')
  timestamp(s.collectedAt, now)
  const collected = Date.parse(s.collectedAt as string)
  const expires =
    typeof s.expiresAt === 'string' ? Date.parse(s.expiresAt) : NaN
  if (
    !Number.isFinite(expires) ||
    expires <= now ||
    expires <= collected ||
    expires - collected > RETENTION_MS
  )
    throw new Error('Invalid retention')
  const p = object(s.post, [
    'title',
    'body',
    'bodyTruncated',
    'score',
    'commentCount',
    'createdAt',
    'sticky',
  ])
  text(p.title, 300)
  text(p.body, POST_BODY_LIMIT, true)
  boolean(p.bodyTruncated)
  integer(p.score)
  integer(p.commentCount, 0)
  timestamp(p.createdAt, now)
  boolean(p.sticky)
  if (['[removed]', '[deleted]'].includes(p.body as string))
    throw new Error('Unavailable post')
  if (!Array.isArray(s.comments) || s.comments.length > COMMENT_LIMIT)
    throw new Error('Invalid comment count')
  const ids = new Set<string>()
  for (const value of s.comments) {
    const c = object(value, [
      'id',
      'parentId',
      'body',
      'bodyTruncated',
      'score',
      'createdAt',
    ])
    if (
      typeof c.id !== 'string' ||
      !/^t1_[a-z0-9]+$/.test(c.id) ||
      ids.has(c.id) ||
      typeof c.parentId !== 'string' ||
      !/^t[13]_[a-z0-9]+$/.test(c.parentId)
    )
      throw new Error('Invalid comment ID')
    ids.add(c.id)
    text(c.body, COMMENT_BODY_LIMIT)
    if (['[removed]', '[deleted]'].includes(c.body as string))
      throw new Error('Unavailable comment')
    boolean(c.bodyTruncated)
    integer(c.score)
    timestamp(c.createdAt, now)
  }
  const sample = object(s.commentSample, [
    'sort',
    'depth',
    'pages',
    'limit',
    'inspected',
    'limitReached',
  ])
  integer(sample.inspected, 0)
  integer(sample.pages, 0)
  if (
    sample.sort !== 'new' ||
    sample.depth !== 1 ||
    (sample.pages as number) > COMMENT_MAX_PAGES ||
    sample.limit !== COMMENT_LIMIT ||
    (sample.inspected as number) > COMMENT_LIMIT ||
    (sample.inspected as number) < s.comments.length ||
    typeof sample.limitReached !== 'boolean' ||
    (sample.inspected === COMMENT_LIMIT && !sample.limitReached) ||
    (sample.limitReached &&
      sample.inspected !== COMMENT_LIMIT &&
      sample.pages !== COMMENT_MAX_PAGES)
  )
    throw new Error('Invalid sample')
  if (
    !Array.isArray(s.selectionReasons) ||
    s.selectionReasons.length > SELECTION_REASONS.length ||
    new Set(s.selectionReasons).size !== s.selectionReasons.length ||
    s.selectionReasons.some(value => !SELECTION_REASONS.includes(value))
  )
    throw new Error('Invalid selection reasons')
  return {action, snapshot: s as unknown as Snapshot}
}
