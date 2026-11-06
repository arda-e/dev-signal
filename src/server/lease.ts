import {redis} from '@devvit/web/server'

export const COLLECTOR_LOCK = 'devsignal:collector-lock'
export const COLLECTOR_LOCK_MS = 180_000

/** An expired worker must never release a newer worker's lock. */
export async function releaseLease(
  key: string,
  token: string,
  onError: (error: unknown) => void,
) {
  try {
    const tx = await redis.watch(key)
    if ((await redis.get(key)) === token) {
      await tx.multi()
      await tx.del(key)
      await tx.exec()
    } else await tx.unwatch()
  } catch (error) {
    onError(error)
  }
}
