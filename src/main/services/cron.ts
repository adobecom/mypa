import cron from 'node-cron'
import { BrowserWindow } from 'electron'
import { dbGetRoutines } from '../db/index'
import { executeRoutine } from './routines'
import type { Routine } from '@shared/types'

const scheduledTasks = new Map<string, cron.ScheduledTask>()

export function startScheduler(getWidgetWin: () => BrowserWindow | null): void {
  refreshSchedules(getWidgetWin)
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
}
