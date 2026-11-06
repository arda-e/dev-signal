export function istanbulDay(now: number) {
  return new Date(now + 3 * 3600_000).toISOString().slice(0, 10)
}

export function morningWindow(now: number) {
  const day = istanbulDay(now)
  return {
    day,
    start: Date.parse(`${day}T03:00:00Z`),
    deadline: Date.parse(`${day}T06:00:00Z`),
  }
}

export function nextMorning(now: number) {
  const today = morningWindow(now).start
  return now < today ? today : morningWindow(now + 86400_000).start
}
