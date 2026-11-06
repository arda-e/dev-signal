import {randomUUID} from 'node:crypto'
import {redis, scheduler} from '@devvit/web/server'
import {morningWindow} from '../shared/scan-time.ts'
import {EXPORT_QUEUE, processExportQueue} from './collection-store.ts'
import {runCollector} from './collector.ts'
import {releaseLease} from './lease.ts'

const MINUTE = 60_000
const FINALIZATION_WINDOW = 3 * MINUTE
const LOCK = 'devsignal:daily-batch-lock'
type Continuation = {day: string; sequence: number}
type StepResult = {status: string; message?: string}
type Dependencies = {
  now: () => number
  collect: () => Promise<StepResult>
  sync: () => Promise<StepResult>
}
type Batch = {
  day: string
  phase: 'SCAN' | 'SYNC'
  status: 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'DEADLINE_MISSED'
  startedAt: string
  deadlineAt: string
  lastRun: string
  lastSequence: number
  nextJobId?: string
  finishedAt?: string
  reason?: string
  errors: string[]
}
const defaults: Dependencies = {
  now: Date.now,
  collect: runCollector,
  sync: processExportQueue,
}

/** One daily kickoff; continuations exist only while this morning's batch is active. */
export async function runDailyBatch(
  options: {continuation?: Continuation; resume?: boolean} = {},
  deps: Dependencies = defaults,
) {
  const now = deps.now()
  const {day, start, deadline} = morningWindow(now)
  const continuation = options.continuation
  if (
    continuation &&
    (continuation.day !== day ||
      !Number.isSafeInteger(continuation.sequence) ||
      continuation.sequence < 0)
  )
    return {status: 'stale', day}
  if (now < start) return {status: 'outside_window', day}
  const token = randomUUID()
  if (
    !(await redis.set(LOCK, token, {
      nx: true,
      expiration: new Date(now + 45_000),
    }))
  ) {
    // A timed-out invocation can leave a lease across the deadline. Briefly retry
    // terminal bookkeeping; the deadline guard below prevents further API work.
    if (continuation && now + MINUTE <= deadline + FINALIZATION_WINDOW)
      await scheduler.runJob({
        name: 'devsignal-continue-batch',
        runAt: new Date(now + MINUTE),
        data: continuation,
      })
    return {status: 'busy', day}
  }
  const key = `devsignal:collector-batches:${day}`
  const save = (batch: Batch) =>
    redis.set(key, JSON.stringify(batch), {
      expiration: new Date(deadline + 7 * 86400_000),
    })
  const stop = async (batch: Batch) => {
    batch.finishedAt = new Date(deps.now()).toISOString()
    await save(batch)
    if (batch.nextJobId) {
      try {
        await scheduler.cancelJob(batch.nextJobId)
      } catch {
        console.error(
          'Morning batch finished; a redundant continuation may still wake and exit.',
        )
      }
    }
    return {
      status: batch.status,
      day,
      phase: batch.phase,
      reason: batch.reason ?? '',
      errors: batch.errors,
    }
  }
  try {
    const raw = await redis.get(key)
    if (!raw && continuation) return {status: 'stale', day}
    const batch: Batch = raw
      ? JSON.parse(raw)
      : {
          day,
          phase: 'SCAN',
          status: 'RUNNING',
          startedAt: new Date(now).toISOString(),
          deadlineAt: new Date(deadline).toISOString(),
          lastRun: '',
          lastSequence: -1,
          errors: [],
        }
    if (options.resume && batch.status === 'BLOCKED') {
      batch.status = 'RUNNING'
      batch.reason = undefined
      batch.finishedAt = undefined
    }
    if (batch.status !== 'RUNNING')
      return {status: batch.status, day, phase: batch.phase}
    if (now + 30_000 >= deadline) {
      batch.status = 'DEADLINE_MISSED'
      batch.reason =
        '09:00 Istanbul deadline reached before all phases completed.'
      return await stop(batch)
    }
    if (batch.lastSequence >= 180) {
      batch.status = 'PARTIAL'
      batch.reason = 'Morning batch safety step budget exhausted.'
      return await stop(batch)
    }
    if (continuation && continuation.sequence <= batch.lastSequence)
      return {status: 'stale', day}
    const sequence = continuation?.sequence ?? batch.lastSequence + 1
    // Persist a bootstrap before scheduling, then pre-arm recovery before fallible API work.
    // Sequence gaps are allowed so a crash between scheduling and saving cannot lose the chain.
    await save(batch)
    batch.nextJobId = await scheduler.runJob({
      name: 'devsignal-continue-batch',
      runAt: new Date(Math.min(now + MINUTE, deadline)),
      data: {day, sequence: sequence + 1},
    })
    batch.lastSequence = sequence
    batch.lastRun = new Date(now).toISOString()
    await save(batch)
    try {
      const result =
        batch.phase === 'SCAN' ? await deps.collect() : await deps.sync()
      if (['partial', 'error', 'retry', 'failed'].includes(result.status))
        batch.errors.push(`${batch.phase}:${result.status}`)
      if (batch.phase === 'SCAN' && result.message === 'Daily scan complete.')
        batch.phase = 'SYNC'
      else if (batch.phase === 'SYNC') {
        if (result.status === 'idle') {
          const pending = (await redis.zRange(EXPORT_QUEUE, 0, 0))[0]
          // A backed-off retry due this morning is still unfinished work.
          if (!pending || pending.score >= deadline)
            batch.status = batch.errors.length ? 'PARTIAL' : 'COMPLETE'
        } else if (
          ['disabled', 'needs_configuration'].includes(result.status)
        ) {
          batch.status = 'BLOCKED'
          batch.reason = result.message ?? result.status
        }
      }
    } catch {
      batch.errors.push(`${batch.phase}:temporary_failure`)
    }
    batch.errors = [...new Set(batch.errors)].slice(-10)
    if (deps.now() >= deadline) {
      batch.status = 'DEADLINE_MISSED'
      batch.reason =
        '09:00 Istanbul deadline reached before all phases completed.'
    }
    if (batch.status !== 'RUNNING') return await stop(batch)
    await save(batch)
    return {
      status: batch.status,
      day,
      phase: batch.phase,
      nextRunAt: new Date(Math.min(now + MINUTE, deadline)).toISOString(),
    }
  } finally {
    await releaseLease(LOCK, token, () =>
      console.error('Morning batch lock release failed; waiting for expiry.'),
    )
  }
}
