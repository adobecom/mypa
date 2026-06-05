export type Frequency = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'twice-daily'

export const WEEKDAYS = [
  { label: 'Monday', value: 1 },
  { label: 'Tuesday', value: 2 },
  { label: 'Wednesday', value: 3 },
  { label: 'Thursday', value: 4 },
  { label: 'Friday', value: 5 },
  { label: 'Saturday', value: 6 },
  { label: 'Sunday', value: 0 },
]

export const HOURS = Array.from({ length: 18 }, (_, i) => i + 5) // 5 AM – 10 PM

export function formatHour(h: number): string {
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

export function buildCron(freq: Frequency, hour: number, weekday: number): string {
  switch (freq) {
    case 'hourly': return '0 * * * *'
    case 'daily': return `0 ${hour} * * *`
    case 'weekdays': return `0 ${hour} * * 1-5`
    case 'weekly': return `0 ${hour} * * ${weekday}`
    case 'twice-daily': return '0 9,17 * * *'
  }
}

export function parseCron(cron: string): { freq: Frequency; hour: number; weekday: number } | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hr, , , dow] = parts
  if (min !== '0') return null

  if (hr === '*' && dow === '*') return { freq: 'hourly', hour: 9, weekday: 1 }
  if (hr === '9,17' && dow === '*') return { freq: 'twice-daily', hour: 9, weekday: 1 }

  const hourNum = parseInt(hr, 10)
  if (isNaN(hourNum) || String(hourNum) !== hr) return null

  if (dow === '*') return { freq: 'daily', hour: hourNum, weekday: 1 }
  if (dow === '1-5') return { freq: 'weekdays', hour: hourNum, weekday: 1 }

  const dowNum = parseInt(dow, 10)
  if (!isNaN(dowNum) && String(dowNum) === dow) return { freq: 'weekly', hour: hourNum, weekday: dowNum }

  return null
}

export function describeCron(cron: string): string {
  const p = parseCron(cron)
  if (!p) return cron
  const time = formatHour(p.hour)
  const day = WEEKDAYS.find((d) => d.value === p.weekday)?.label ?? 'Monday'
  switch (p.freq) {
    case 'hourly': return 'Every hour'
    case 'daily': return `Every day at ${time}`
    case 'weekdays': return `Every weekday at ${time}`
    case 'weekly': return `Every ${day} at ${time}`
    case 'twice-daily': return 'Twice daily (9 AM & 5 PM)'
  }
}
