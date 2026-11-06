import {
  type IngestMessage,
  MAX_PAYLOAD_BYTES,
  parseIngestMessage,
} from '../shared/collection.ts'

export function supabaseOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !['', '/'].includes(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid Supabase project URL')
  return url.origin
}
export async function sendSnapshot(
  message: IngestMessage,
  config: {url: string; token: string},
  request: typeof fetch = fetch,
): Promise<void> {
  const payload = parseIngestMessage(message)
  const body = JSON.stringify(payload)
  if (new TextEncoder().encode(body).length > MAX_PAYLOAD_BYTES)
    throw new Error('Snapshot payload too large')
  const response = await request(
    `${supabaseOrigin(config.url)}/functions/v1/devsignal-ingest`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body,
    },
  )
  // Never include external response bodies, credentials or source payloads in errors.
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`)
}
