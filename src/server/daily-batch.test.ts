import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'node:test'
import {redis, scheduler} from '@devvit/web/server'
import {runDailyBatch} from './daily-batch.ts'

const original = {
  range: redis.zRange,
  get: redis.get,
  set: redis.set,
  watch: redis.watch,
  run: scheduler.runJob,
  cancel: scheduler.cancelJob,
}
let data: Map<string, string>
let expirations: Map<string, number>
let jobs: {name: string; data?: {day: string; sequence: number}; runAt: Date}[]
let cancelled: string[]
let now: number
let scans: number
let deliveries: number
let scanDone: boolean
let deliveryStatus: string
let failScan: boolean
let pendingAt: number | undefined
const deps = {
  now: () => now,
  collect: async () => {
    scans++
    if (failScan) throw new Error('temporary upstream error')
    return scanDone
      ? {status: 'ok', message: 'Daily scan complete.'}
      : {status: 'ok', stage: 'DISCOVER_NEW'}
  },
  sync: async () => {
    deliveries++
    return {status: deliveryStatus, message: 'delivery result'}
  },
}
const key = 'devsignal:collector-batches:2026-11-06'
beforeEach(() => {
  data = new Map()
  expirations = new Map()
  pendingAt = undefined
  redis.zRange = (async () =>
    pendingAt === undefined
      ? []
      : [{member: 't3_abc', score: pendingAt}]) as typeof redis.zRange
  jobs = []
  cancelled = []
  now = Date.parse('2026-11-06T04:00:00Z')
  scans = 0
  deliveries = 0
  scanDone = false
  deliveryStatus = 'idle'
  failScan = false
  redis.get = (async key => data.get(key)) as typeof redis.get
  redis.set = (async (key, value, options) => {
    if ((expirations.get(key) ?? Infinity) <= now) data.delete(key)
    if (options?.nx && data.has(key)) return ''
    data.set(key, value)
    if (options?.expiration) expirations.set(key, options.expiration.getTime())
    return 'OK'
  }) as typeof redis.set
  redis.watch = (async () => ({
    multi: async () => {},
    del: async (key: string) => {
      data.delete(key)
      expirations.delete(key)
    },
    exec: async () => [],
    unwatch: async () => {},
  })) as unknown as typeof redis.watch
  scheduler.runJob = (async job => {
    jobs.push(job as (typeof jobs)[number])
    return `job${jobs.length}`
  }) as typeof scheduler.runJob
  scheduler.cancelJob = async id => {
    cancelled.push(id)
  }
})
afterEach(() => {
  redis.zRange = original.range
  redis.get = original.get
  redis.set = original.set
  redis.watch = original.watch
  scheduler.runJob = original.run
  scheduler.cancelJob = original.cancel
})

test('one morning batch resumes in bounded steps and stops after scan and deliveries', async () => {
  assert.equal((await runDailyBatch({}, deps)).status, 'RUNNING')
  assert.equal(scans, 1)
  assert.equal(deliveries, 0)
  assert.equal(jobs[0]?.name, 'devsignal-continue-batch')
  assert.equal(jobs[0]?.runAt.toISOString(), '2026-11-06T04:01:00.000Z')
  now += 60_000
  scanDone = true
  await runDailyBatch({continuation: jobs[0]?.data}, deps)
  assert.equal(JSON.parse(data.get(key) ?? '{}').phase, 'SYNC')
  now += 60_000
  assert.equal(
    (await runDailyBatch({continuation: jobs[1]?.data}, deps)).status,
    'COMPLETE',
  )
  assert.equal(scans, 2)
  assert.equal(deliveries, 1)
  assert.equal(cancelled.length, 1)
  assert.equal(
    JSON.parse(data.get(key) ?? '{}').finishedAt,
    new Date(now).toISOString(),
  )
  const count = jobs.length
  await runDailyBatch({}, deps)
  await runDailyBatch({continuation: jobs[2]?.data}, deps)
  assert.equal(jobs.length, count)
  assert.equal(scans, 2)
})
test('duplicate and stale deliveries cannot start another scan', async () => {
  await runDailyBatch({}, deps)
  const delivery = jobs[0]?.data
  now += 60_000
  await runDailyBatch({continuation: delivery}, deps)
  await runDailyBatch({continuation: delivery}, deps)
  assert.equal(scans, 2)
  assert.equal(
    (
      await runDailyBatch(
        {continuation: {day: '2026-11-05', sequence: 100}},
        deps,
      )
    ).status,
    'stale',
  )
  assert.equal(scans, 2)
})
test('09:00 Istanbul stops unfinished work and records a missed deadline', async () => {
  await runDailyBatch({}, deps)
  now = Date.parse('2026-11-06T06:00:00Z')
  assert.equal(
    (await runDailyBatch({continuation: jobs[0]?.data}, deps)).status,
    'DEADLINE_MISSED',
  )
  assert.equal(scans, 1)
  assert.equal(JSON.parse(data.get(key) ?? '{}').status, 'DEADLINE_MISSED')
  assert.equal(jobs.length, 1)
})
test('a continuation is scheduled before fallible work and exceptions remain resumable', async () => {
  failScan = true
  await runDailyBatch({}, deps)
  assert.equal(jobs.length, 1)
  assert.equal(JSON.parse(data.get(key) ?? '{}').errors.length, 1)
  now += 60_000
  failScan = false
  await runDailyBatch({continuation: jobs[0]?.data}, deps)
  assert.equal(scans, 2)
})
test('disabled export is blocked rather than reported as complete, and can be resumed manually', async () => {
  scanDone = true
  await runDailyBatch({}, deps)
  now += 60_000
  deliveryStatus = 'disabled'
  assert.equal(
    (await runDailyBatch({continuation: jobs[0]?.data}, deps)).status,
    'BLOCKED',
  )
  now += 60_000
  deliveryStatus = 'idle'
  assert.equal((await runDailyBatch({resume: true}, deps)).status, 'COMPLETE')
  assert.equal(JSON.parse(data.get(key) ?? '{}').reason, undefined)
})
test('outside the morning window and missing checkpoints do not launch background work', async () => {
  now = Date.parse('2026-11-06T02:00:00Z')
  assert.equal((await runDailyBatch({}, deps)).status, 'outside_window')
  now = Date.parse('2026-11-06T04:00:00Z')
  assert.equal(
    (
      await runDailyBatch(
        {continuation: {day: '2026-11-06', sequence: 1}},
        deps,
      )
    ).status,
    'stale',
  )
  assert.equal(scans, 0)
  assert.equal(jobs.length, 0)
})

test('completion after the deadline is not reported as on time', async () => {
  scanDone = true
  await runDailyBatch({}, deps)
  now = Date.parse('2026-11-06T05:59:00Z')
  const late = {
    ...deps,
    sync: async () => {
      now += 90_000
      return {status: 'idle'}
    },
  }
  assert.equal(
    (await runDailyBatch({continuation: jobs[0]?.data}, late)).status,
    'DEADLINE_MISSED',
  )
})
test('pending retries due before 09:00 keep the chain active', async () => {
  scanDone = true
  await runDailyBatch({}, deps)
  now += 60_000
  pendingAt = now + 5 * 60_000
  assert.equal(
    (await runDailyBatch({continuation: jobs[0]?.data}, deps)).status,
    'RUNNING',
  )
  now += 60_000
  pendingAt = Date.parse('2026-11-07T04:00:00Z')
  assert.equal(
    (await runDailyBatch({continuation: jobs[1]?.data}, deps)).status,
    'COMPLETE',
  )
})

test('a busy lease reschedules a continuation without performing API work', async () => {
  await runDailyBatch({}, deps)
  now += 60_000
  data.set('devsignal:daily-batch-lock', 'other-owner')
  assert.equal(
    (await runDailyBatch({continuation: jobs[0]?.data}, deps)).status,
    'busy',
  )
  assert.equal(scans, 1)
  assert.deepEqual(jobs[1]?.data, jobs[0]?.data)
  data.delete('devsignal:daily-batch-lock')
  now += 60_000
  assert.equal(
    (await runDailyBatch({continuation: jobs[1]?.data}, deps)).status,
    'RUNNING',
  )
  assert.equal(scans, 2)
})

test('the 09:00 continuation retries finalization after an interrupted 08:59:20 lease expires', async () => {
  now = Date.parse('2026-11-06T05:59:20Z')
  await runDailyBatch({}, deps)
  assert.equal(jobs[0]?.runAt.toISOString(), '2026-11-06T06:00:00.000Z')
  // A crashed worker leaves its persisted progress, pre-armed job, and 45-second lease.
  await redis.set('devsignal:daily-batch-lock', 'interrupted-worker', {
    expiration: new Date(now + 45_000),
  })
  const apiCounts = {scans, deliveries}
  now = Date.parse('2026-11-06T06:00:00Z')
  assert.equal(
    (await runDailyBatch({continuation: jobs[0]?.data}, deps)).status,
    'busy',
  )
  assert.equal(jobs[1]?.runAt.toISOString(), '2026-11-06T06:01:00.000Z')
  assert.deepEqual({scans, deliveries}, apiCounts)
  now = Date.parse('2026-11-06T06:01:00Z')
  assert.equal(
    (await runDailyBatch({continuation: jobs[1]?.data}, deps)).status,
    'DEADLINE_MISSED',
  )
  assert.equal(JSON.parse(data.get(key) ?? '{}').status, 'DEADLINE_MISSED')
  assert.deepEqual({scans, deliveries}, apiCounts)
  assert.equal(jobs.length, 2)
})

test('finalization retries stop at the finite recovery window', async () => {
  await runDailyBatch({}, deps)
  data.set('devsignal:daily-batch-lock', 'other-owner')
  now = Date.parse('2026-11-06T06:02:00Z')
  await runDailyBatch({continuation: jobs[0]?.data}, deps)
  assert.equal(jobs[1]?.runAt.toISOString(), '2026-11-06T06:03:00.000Z')
  now = Date.parse('2026-11-06T06:03:00Z')
  await runDailyBatch({continuation: jobs[1]?.data}, deps)
  assert.equal(jobs.length, 2)
  assert.equal(scans, 1)
  assert.equal(deliveries, 0)
})

test('exhausted inbox delivery failures leave a partial batch', async () => {
  scanDone = true
  await runDailyBatch({}, deps)
  now += 60_000
  deliveryStatus = 'failed'
  assert.equal(
    (await runDailyBatch({continuation: jobs[0]?.data}, deps)).status,
    'RUNNING',
  )
  now += 60_000
  deliveryStatus = 'idle'
  assert.equal(
    (await runDailyBatch({continuation: jobs[1]?.data}, deps)).status,
    'PARTIAL',
  )
  assert.deepEqual(JSON.parse(data.get(key) ?? '{}').errors, ['SYNC:failed'])
})

test('the safety step budget is partial rather than a falsely reported clock deadline', async () => {
  await runDailyBatch({}, deps)
  const batch = JSON.parse(data.get(key) ?? '{}')
  batch.lastSequence = 180
  data.set(key, JSON.stringify(batch))
  const result = await runDailyBatch({resume: true}, deps)
  assert.equal(result.status, 'PARTIAL')
  assert.equal(scans, 1)
})

test('failed scheduling saves progress without running an unprotected chunk', async () => {
  const schedule = scheduler.runJob
  scheduler.runJob = async () => {
    throw new Error('scheduler unavailable')
  }
  await assert.rejects(runDailyBatch({}, deps), /scheduler unavailable/)
  assert.equal(scans, 0)
  assert.equal(JSON.parse(data.get(key) ?? '{}').lastSequence, -1)
  scheduler.runJob = schedule
  now += 60_000
  assert.equal((await runDailyBatch({resume: true}, deps)).status, 'RUNNING')
  assert.equal(scans, 1)
})
