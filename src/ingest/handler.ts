import {MAX_PAYLOAD_BYTES, parseIngestMessage} from '../shared/collection.ts'

export type IngestConfig = {
  token: string
  projectUrl: string
  serviceKey: string
}
async function tokenMatches(given: string, expected: string) {
  const hash = (value: string) =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  const [a, b] = await Promise.all([hash(given), hash(expected)])
  const aa = new Uint8Array(a)
  const bb = new Uint8Array(b)
  let difference = 0
  for (let i = 0; i < aa.length; i++) difference |= (aa[i] ?? 0) ^ (bb[i] ?? 0)
  return difference === 0
}
async function boundedJson(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing body')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_PAYLOAD_BYTES) {
      await reader.cancel()
      throw new Error('Payload too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
/** This endpoint never returns database contents and cannot query arbitrary tables. */
export async function handleIngest(
  request: Request,
  config: IngestConfig,
  backend: typeof fetch = fetch,
): Promise<Response> {
  if (!config.token || config.token.length < 32 || !config.serviceKey)
    return new Response('Not configured', {status: 503})
  if (request.method !== 'POST')
    return new Response('Method not allowed', {status: 405})
  if (
    !(await tokenMatches(
      request.headers.get('authorization') ?? '',
      `Bearer ${config.token}`,
    ))
  )
    return new Response('Unauthorized', {status: 401})
  let message
  try {
    message = parseIngestMessage(await boundedJson(request))
  } catch {
    return new Response('Invalid collector payload', {status: 400})
  }
  const root = `${config.projectUrl.replace(/\/$/, '')}/rest/v1/devsignal_inbox`
  const headers = {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  }
  try {
    const response =
      message.action === 'delete'
        ? await backend(`${root}?source_id=eq.${message.sourceId}`, {
            method: 'DELETE',
            headers,
            signal: AbortSignal.timeout(8_000),
            redirect: 'error',
          })
        : await backend(`${root}?on_conflict=source_id`, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(8_000),
            redirect: 'error',
            body: JSON.stringify({
              source_id: message.snapshot.sourceId,
              source_subreddit: message.snapshot.sourceSubreddit,
              run_id: message.snapshot.runId,
              fetched_at: message.snapshot.collectedAt,
              expires_at: message.snapshot.expiresAt,
              post: message.snapshot.post,
              comments: message.snapshot.comments,
              comment_sample: message.snapshot.commentSample,
              selection_reasons: message.snapshot.selectionReasons,
            }),
          })
    return response.ok
      ? new Response(null, {status: 204})
      : new Response('Storage unavailable', {status: 502})
  } catch {
    return new Response('Storage unavailable', {status: 502})
  }
}
