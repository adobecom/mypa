import { BrowserWindow } from 'electron'
import {
  dbCreatePlanItem,
  dbUpdatePlanItemStatus,
  dbDeletePlanItem,
  dbAddPlanMessage,
  dbGetPlanThread,
  dbGetBadgeCount
} from '../db/index'
import { generatePlanDraft, streamChat } from './claude'
import type { PlanDraft, PlanItem, PlanItemStatus } from '@shared/types'

export async function createPlanDraft(intent: string): Promise<PlanDraft> {
  return generatePlanDraft(intent)
}

export function confirmPlanDraft(draft: PlanDraft): PlanItem {
  return dbCreatePlanItem(draft)
}

export function updatePlanItemStatus(id: string, status: PlanItemStatus): void {
  dbUpdatePlanItemStatus(id, status)
}

export function deletePlanItem(id: string): void {
  dbDeletePlanItem(id)
}

export async function handlePlanMessage(
  itemId: string,
  userMessage: string,
  widgetWin: BrowserWindow | null
): Promise<void> {
  dbAddPlanMessage(itemId, 'user', userMessage)

  const history = dbGetPlanThread(itemId).slice(0, -1)

  const segments: string[] = ['']
  let fullResponse = ''
  try {
    await streamChat(
      history,
      userMessage,
      (chunk) => {
        if (chunk === '\x00SPLIT\x00') {
          segments.push('')
        } else {
          segments[segments.length - 1] += chunk
        }
        widgetWin?.webContents.send('plan:item-message', { itemId, chunk, done: false })
      },
      (full) => {
        fullResponse = full
      }
    )
    const toSave = segments.filter((s) => s.trim())
    for (const seg of toSave.length > 0 ? toSave : [fullResponse]) {
      if (seg.trim()) dbAddPlanMessage(itemId, 'assistant', seg)
    }
    widgetWin?.webContents.send('plan:item-message', { itemId, chunk: '', done: true })
    widgetWin?.webContents.send('badge:updated', dbGetBadgeCount())
  } catch (err: any) {
    widgetWin?.webContents.send('plan:item-message', {
      itemId,
      chunk: '',
      done: true,
      error: err?.message ?? 'Claude failed to respond'
    })
  }
}
