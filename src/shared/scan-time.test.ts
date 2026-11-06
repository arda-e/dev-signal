import assert from 'node:assert/strict'
import {test} from 'node:test'
import {istanbulDay, morningWindow, nextMorning} from './scan-time.ts'

test('scan dates and the morning window use Istanbul rather than the UTC date', () => {
  const now = Date.parse('2026-11-05T22:00:00Z')
  assert.equal(istanbulDay(now), '2026-11-06')
  assert.deepEqual(morningWindow(now), {
    day: '2026-11-06',
    start: Date.parse('2026-11-06T03:00:00Z'),
    deadline: Date.parse('2026-11-06T06:00:00Z'),
  })
})
test('manual checks before 06:00 become due in the upcoming morning, not a day later', () => {
  assert.equal(
    nextMorning(Date.parse('2026-11-06T02:00:00Z')),
    Date.parse('2026-11-06T03:00:00Z'),
  )
  assert.equal(
    nextMorning(Date.parse('2026-11-06T03:00:00Z')),
    Date.parse('2026-11-07T03:00:00Z'),
  )
})
