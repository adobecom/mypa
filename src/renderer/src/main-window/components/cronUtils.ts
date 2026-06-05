export type Frequency = 'hourly' | 'daily' | 'weekdays' | 'weekly'

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

export function buildCron(freq: Frequency, hours: number[], weekday: number): string {
  const hourPart = hours.join(',')
  switch (freq) {
    case 'hourly':   return '0 * * * *'
    case 'daily':    return `0 ${hourPart} * * *`
    case 'weekdays': return `0 ${hourPart} * * 1-5`
    case 'weekly':   return `0 ${hourPart} * * ${weekday}`
  }
}

export function parseCron(cron: string): { freq: Frequency; hours: number[]; weekday: number } | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hr, dom, month, dow] = parts
  if (min !== '0' || dom !== '*' || month !== '*') return null

  if (hr === '*' && dow === '*') return { freq: 'hourly', hours: [9], weekday: 1 }

  const hourNums = hr.split(',').map((s) => parseInt(s, 10))
  if (hourNums.some(isNaN) || hourNums.join(',') !== hr) return null

  if (dow === '*')   return { freq: 'daily',    hours: hourNums, weekday: 1 }
  if (dow === '1-5') return { freq: 'weekdays', hours: hourNums, weekday: 1 }

  const dowNum = parseInt(dow, 10)
  if (!isNaN(dowNum) && String(dowNum) === dow) return { freq: 'weekly', hours: hourNums, weekday: dowNum }

  return null
}

export function describeCron(cron: string): string {
  const p = parseCron(cron)
  if (!p) return cron
  const timeList = p.hours.map(formatHour).join(' & ')
  const day = WEEKDAYS.find((d) => d.value === p.weekday)?.label ?? 'Monday'
  switch (p.freq) {
    case 'hourly':   return 'Every hour'
    case 'daily':    return `Every day at ${timeList}`
    case 'weekdays': return `Every weekday at ${timeList}`
    case 'weekly':   return `Every ${day} at ${timeList}`
  }
}
