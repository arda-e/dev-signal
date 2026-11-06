export const TOPIC_FIELDS = [
  'title',
  'summary',
  'whyNow',
  'perspectives',
  'angle',
  'uncertainty',
] as const
export type Topic = Record<(typeof TOPIC_FIELDS)[number], string> & {
  suitable: boolean
}
export const SOURCE_SUBREDDITS = ['ClaudeAI', 'ChatGPT'] as const
export const DIGEST_RETENTION_MS = 30 * 86400_000
export type Digest = {
  sourceId: string
  sourceSubreddit: string
  runId: string
  publishedPostId: string
  createdAt: string
  expiresAt: string
  topic: Topic
}
export type IngestMessage =
  | {action: 'upsert'; digest: Digest}
  | {action: 'delete'; sourceId: string}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object')
  return value as Record<string, unknown>
}
function exactKeys(obj: Record<string, unknown>, allowed: readonly string[]) {
  if (
    Object.keys(obj).length !== allowed.length ||
    Object.keys(obj).some(key => !allowed.includes(key))
  )
    throw new Error('Unexpected fields')
}
export function parseTopic(value: unknown): Topic {
  const obj = object(value)
  exactKeys(obj, ['suitable', ...TOPIC_FIELDS])
  if (typeof obj.suitable !== 'boolean') throw new Error('Missing suitability')
  for (const field of TOPIC_FIELDS) {
    const text = obj[field]
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > (field === 'title' ? 180 : 1800)
    )
      throw new Error(`Invalid topic field: ${field}`)
    if (/https?:|www\.|reddit\.com|(?:^|\s)[ur]\//i.test(text))
      throw new Error('Unexpected link or mention in model output')
  }
  // Construct an allowlisted value; never forward arbitrary model/source properties.
  return {
    suitable: obj.suitable,
    ...Object.fromEntries(TOPIC_FIELDS.map(field => [field, obj[field]])),
  } as Topic
}
export function parseIngestMessage(
  value: unknown,
  now = Date.now(),
): IngestMessage {
  const obj = object(value)
  if (obj.action === 'delete') {
    exactKeys(obj, ['action', 'sourceId'])
    if (
      typeof obj.sourceId !== 'string' ||
      !/^t3_[a-z0-9]+$/.test(obj.sourceId)
    )
      throw new Error('Invalid source ID')
    return {action: 'delete', sourceId: obj.sourceId}
  }
  exactKeys(obj, ['action', 'digest'])
  if (obj.action !== 'upsert') throw new Error('Invalid action')
  const d = object(obj.digest)
  exactKeys(d, [
    'sourceId',
    'sourceSubreddit',
    'runId',
    'publishedPostId',
    'createdAt',
    'expiresAt',
    'topic',
  ])
  for (const field of [
    'sourceId',
    'sourceSubreddit',
    'runId',
    'publishedPostId',
    'createdAt',
    'expiresAt',
  ]) {
    if (typeof d[field] !== 'string') throw new Error('Invalid digest metadata')
  }
  const meta = d as Omit<Digest, 'topic'> & {topic: unknown}
  if (
    !/^t3_[a-z0-9]+$/.test(meta.sourceId) ||
    !/^t3_[a-z0-9]+$/.test(meta.publishedPostId) ||
    !SOURCE_SUBREDDITS.some(sub => sub === meta.sourceSubreddit) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(meta.runId)
  )
    throw new Error('Invalid digest source')
  const created = Date.parse(meta.createdAt)
  const expires = Date.parse(meta.expiresAt)
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    created > now + 60_000 ||
    expires <= now ||
    expires <= created ||
    expires - created > DIGEST_RETENTION_MS
  )
    throw new Error('Invalid digest retention')
  const topic = parseTopic(d.topic)
  if (!topic.suitable) throw new Error('Unsuitable digest')
  return {action: 'upsert', digest: {...meta, topic}}
}
