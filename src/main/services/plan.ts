import { broadcast } from '../windows'
import {
  dbCreatePlanItem,
  dbUpdatePlanItemStatus,
  dbDeletePlanItem,
  dbAddPlanMessage,
  dbGetPlanThread,
  dbGetBadgeCount,
  dbUpsertNode,
  dbBumpNodeWeight
} from '../db/index'
import { generatePlanDraft, streamChat } from './claude'
import type { PlanDraft, PlanItem, PlanItemStatus } from '@shared/types'

export async function createPlanDraft(intent: string): Promise<PlanDraft> {
  return generatePlanDraft(intent)
}

export function confirmPlanDraft(draft: PlanDraft): PlanItem {
  const item = dbCreatePlanItem(draft)
  // Mirror the plan item into the knowledge graph so it appears alongside the
  // work items it relates to and the routines that produced it.
  try {
    const planNode = dbUpsertNode('plan_item', `plan_item:${item.id}`, item.title.slice(0, 120), {
      status: item.status,
      timing: item.timing,
      source: item.source
    })
    dbBumpNodeWeight(planNode.id, 2.0)
  } catch (e) {
    console.error('[plan] graph node error:', e)
  }
  return item
}

export function updatePlanItemStatus(id: string, status: PlanItemStatus): void {
  dbUpdatePlanItemStatus(id, status)
}

export function deletePlanItem(id: string): void {
  dbDeletePlanItem(id)
}

export async function handlePlanMessage(
  itemId: string,
  userMessage: string
): Promise<void> {
  const userMsg = dbAddPlanMessage(itemId, 'user', userMessage)
  broadcast('plan:user-message', { itemId, message: userMsg })

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
        broadcast('plan:item-message', { itemId, chunk, done: false })
      },
      (full) => {
        fullResponse = full
      },
      undefined,
      itemId,
      'plan_chat'
    )
    const toSave = segments.filter((s) => s.trim())
    for (const seg of toSave.length > 0 ? toSave : [fullResponse]) {
      if (seg.trim()) dbAddPlanMessage(itemId, 'assistant', seg)
    }
    broadcast('plan:item-message', { itemId, chunk: '', done: true })
    broadcast('badge:updated', dbGetBadgeCount())
  } catch (err: any) {
    broadcast('plan:item-message', {
      itemId,
      chunk: '',
      done: true,
      error: err?.message ?? 'Claude failed to respond'
    })
  }
}
