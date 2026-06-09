import cron from 'node-cron'
import { BrowserWindow, Notification } from 'electron'
import { dbGetRoutines } from '../db/index'
import { executeRoutine } from './routines'
import { readConfig } from './config'
import type { Routine } from '@shared/types'

const scheduledTasks = new Map<string, cron.ScheduledTask>()
let checkinTask: cron.ScheduledTask | null = null

export function startScheduler(getWidgetWin: () => BrowserWindow | null): void {
  refreshSchedules(getWidgetWin)
  refreshCheckinSchedule(getWidgetWin)
}

export function refreshSchedules(getWidgetWin: () => BrowserWindow | null): void {
  // Cancel all existing tasks
  for (const [, task] of scheduledTasks) {
    task.stop()
  }
  scheduledTasks.clear()

  const routines = dbGetRoutines()
  for (const routine of routines) {
    if (!routine.enabled) continue
    scheduleRoutine(routine, getWidgetWin)
  }

  console.log(`[cron] scheduled ${scheduledTasks.size} routines`)
}

export function scheduleRoutine(routine: Routine, getWidgetWin: () => BrowserWindow | null): void {
  if (!cron.validate(routine.cron)) {
    console.warn(`[cron] invalid cron expression for routine ${routine.name}: ${routine.cron}`)
    return
  }

  const task = cron.schedule(routine.cron, async () => {
    console.log(`[cron] firing routine: ${routine.name}`)
    const win = getWidgetWin()
    await executeRoutine(routine, win)
  })

  scheduledTasks.set(routine.id, task)
}

export function unscheduleRoutine(routineId: string): void {
  const task = scheduledTasks.get(routineId)
  if (task) {
    task.stop()
    scheduledTasks.delete(routineId)
  }
}

export function stopScheduler(): void {
  for (const [, task] of scheduledTasks) {
    task.stop()
  }
  scheduledTasks.clear()
  checkinTask?.stop()
  checkinTask = null
}

export function refreshCheckinSchedule(getWidgetWin: () => BrowserWindow | null): void {
  checkinTask?.stop()
  checkinTask = null

  const cfg = readConfig()
  const ccfg = cfg.checkin
  if (!ccfg?.scheduleEnabled || !ccfg.schedule) return
  if (!cron.validate(ccfg.schedule)) {
    console.warn('[cron] invalid checkin cron:', ccfg.schedule)
    return
  }

  checkinTask = cron.schedule(ccfg.schedule, async () => {
    console.log('[cron] firing scheduled check-in')
    const notification = new Notification({
      title: 'mypa: Time for your check-in',
      body: 'Your PA is ready to brief you.',
      silent: false
    })
    notification.show()
    notification.on('click', () => {
      getWidgetWin()?.webContents.send('checkin:open-in-main-window')
    })
    const { startCheckIn } = await import('./checkin')
    await startCheckIn('scheduled', getWidgetWin())
  })

  console.log('[cron] check-in scheduled:', ccfg.schedule)
}
