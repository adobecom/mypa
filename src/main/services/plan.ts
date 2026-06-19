import { broadcast, updateBadgeCount } from '../windows'
import {
  dbCreatePlanItem,
  dbUpdatePlanItemStatus,
  dbDeletePlanItem,
  dbAddPlanMessage,
  dbGetPlanThread,
  dbUpsertNode,
  dbBumpNodeWeight
} from '../db/index'
import { generatePlanDraft, streamChat } from './claude'
import {
  stageChatActionsFromSegment,
  approvePlanAction,
  dismissPlanAction,
  isAffirmative,
  isDismissal,
  findLatestPendingAction
} from './ambient'
import type { PlanDraft, PlanItem, PlanItemStatus } from '@shared/types'

export { approvePlanAction, dismissPlanAction }

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

  // Load the full thread (includes the just-added user message at the end)
  const fullThread = dbGetPlanThread(itemId)
  // History for streaming = everything except the last message (the user turn we just added)
  const rawHistory = fullThread.slice(0, -1)

  // Typed approval / dismissal — only if the LAST message is a pending action
  const lastMsg = rawHistory.length > 0 ? rawHistory[rawHistory.length - 1] : null
  const pendingMsg = lastMsg?.action?.status === 'pending' ? lastMsg : null
  if (pendingMsg && isAffirmative(userMessage)) {
    try {
      const result = await approvePlanAction(itemId, pendingMsg.id)
      const note = result.status === 'executed'
        ? `Done — ${result.surface}:${result.verb} executed. ${result.resultText ? result.resultText.slice(0, 300) : ''}`.trim()
        : `Action ${result.status}${result.resultText ? ': ' + result.resultText.slice(0, 300) : ''}.`
      dbAddPlanMessage(itemId, 'assistant', note)
    } catch (err: any) {
      dbAddPlanMessage(itemId, 'assistant', `Failed to execute action: ${err?.message ?? String(err)}`)
    }
    broadcast('plan:user-message', { itemId, message: userMsg })
    broadcast('plan:item-message', { itemId, chunk: '', done: true })
    return
  }
  if (pendingMsg && isDismissal(userMessage)) {
    dismissPlanAction(itemId, pendingMsg.id)
    dbAddPlanMessage(itemId, 'assistant', 'Action dismissed — nothing was posted.')
    broadcast('plan:user-message', { itemId, message: userMsg })
    broadcast('plan:item-message', { itemId, chunk: '', done: true })
    return
  }

  // Normal streamed path: broadcast user message to start the streaming indicator
  broadcast('plan:user-message', { itemId, message: userMsg })

  // Render action-bearing history messages so the model sees their status
  const history = rawHistory.map((m) => {
    const action = m.action
    if (!action) return m
    const statusDesc: Record<string, string> = {
      pending:   'queued — awaiting the user\'s Approve/Dismiss (NOT yet executed)',
      executed:  'executed successfully',
      failed:    'failed to execute',
      dismissed: 'dismissed by the user',
    }
    const desc = statusDesc[action.status] ?? action.status
    const resultNote = action.resultText ? ` (${action.resultText.slice(0, 150)})` : ''
    return {
      ...m,
      content: `[proposed ${action.surface}:${action.verb} on "${action.target}" — status: ${desc}${resultNote}]`
    }
  })

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
      'plan_chat',
      true  // enableMcp — live read-only tools + write-action protocol
    )
    // Parse and stage <action> blocks; save clean text; surface Approve/Dismiss chips
    const toSave = segments.filter((s) => s.trim())
    const segsToProcess = toSave.length > 0 ? toSave : [fullResponse]
    for (const seg of segsToProcess) {
      if (!seg.trim()) continue
      await stageChatActionsFromSegment(
        seg,
        {},  // no parent intent routing — model supplies owner/repo/etc. in payload
        (content, metadata) => dbAddPlanMessage(itemId, 'assistant', content, metadata),
        `plan:${itemId}`
      )
    }
    broadcast('plan:item-message', { itemId, chunk: '', done: true })
    updateBadgeCount()
  } catch (err: any) {
    broadcast('plan:item-message', {
      itemId,
      chunk: '',
      done: true,
      error: err?.message ?? 'Claude failed to respond'
    })
  }
}
