import { BrowserWindow, Notification } from 'electron'
import {
  dbCreateRun,
  dbUpdateRun,
  dbAddRunMessage,
  dbGetRunThread,
  dbGetRun,
  dbGetBadgeCount,
  dbUpsertNode,
  dbBumpNodeWeight
} from '../db/index'
import { callTool } from './mcp'
import { generateRoutineDigest, streamChat } from './claude'
import { broadcast } from '../windows'
import type { Routine, RunStatus } from '@shared/types'

export async function executeRoutine(routine: Routine, widgetWin: BrowserWindow | null): Promise<void> {
  // Upsert the routine as a graph node (idempotent — same key on every run)
  try {
    const routineNode = dbUpsertNode('routine', `routine:${routine.id}`, routine.name, {
      cron: routine.cron,
      enabled: routine.enabled
    })
    dbBumpNodeWeight(routineNode.id, 0.5)
  } catch (e) {
    console.error('[routines] graph node error:', e)
  }

  const run = dbCreateRun(routine.id, routine.name)

  // Notify both windows: run started (widget shows inline run card; main window shows toast)
  broadcast('routine:run-started', run)

  try {
    // Step 1: execute MCP actions
    const results: string[] = []
    for (const action of routine.actions) {
      try {
        const output = await callTool(action.server, action.tool, action.params)
        results.push(`[${action.server}.${action.tool}]\n${output}`)
      } catch (err: any) {
        results.push(`[${action.server}.${action.tool}] ERROR: ${err?.message ?? String(err)}`)
      }
    }

    const rawOutput = results.join('\n\n---\n\n')

    // Step 2: Claude digest
    // generateRoutineDigest never throws — returns a default digest on parse failure
    const digestResult = await generateRoutineDigest(routine.name, routine.prompt, rawOutput)
    const digest = JSON.stringify(digestResult)
    const summary = digestResult.summary
    dbAddRunMessage(run.id, 'assistant', buildDigestMessage(digestResult))

    // Update run record
    dbUpdateRun(run.id, {
      completed_at: new Date().toISOString(),
      raw_output: rawOutput,
      digest,
      status: 'pending_response'
    })

    // Step 3: OS notification
    const notification = new Notification({
      title: `mypa: ${routine.name}`,
      body: summary,
      silent: false
    })
    notification.show()
    notification.on('click', () => widgetWin?.show())

    // Step 4: push to both windows (widget: inline card update; main: toast)
    const updatedRun = dbGetRun(run.id)
    broadcast('routine:run-completed', updatedRun)
    widgetWin?.webContents.send('badge:updated', dbGetBadgeCount())
  } catch (err: any) {
    dbUpdateRun(run.id, {
      completed_at: new Date().toISOString(),
      status: 'error',
      error: err?.message ?? String(err)
    })
    broadcast('routine:run-completed', dbGetRun(run.id))
  }
}

function buildDigestMessage(digest: {
  summary: string
  items: string[]
  proposed_actions: string[]
}): string {
  const parts = [`**${digest.summary}**`]

  if (digest.items.length > 0) {
    parts.push('\n**Needs attention:**')
    digest.items.forEach((item) => parts.push(`• ${item}`))
  }

  if (digest.proposed_actions.length > 0) {
    parts.push('\n**I can help with:**')
    digest.proposed_actions.forEach((action) => parts.push(`• ${action}`))
  }

  return parts.join('\n')
}

export async function handleRunMessage(
  runId: string,
  userMessage: string,
  widgetWin: BrowserWindow | null
): Promise<void> {
  const run = dbGetRun(runId)
  if (!run) throw new Error(`Run ${runId} not found`)

  // Save user message
  dbAddRunMessage(runId, 'user', userMessage)

  // Update status to in_progress
  dbUpdateRun(runId, { status: 'in_progress' })

  const history = dbGetRunThread(runId).slice(0, -1) // exclude the message we just added

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
        widgetWin?.webContents.send('routine:run-message', { runId, chunk, done: false })
      },
      (full) => {
        fullResponse = full
      },
      run.raw_output ?? undefined,
      runId,
      'routine_chat'
    )
    const toSave = segments.filter((s) => s.trim())
    for (const seg of toSave.length > 0 ? toSave : [fullResponse]) {
      if (seg.trim()) dbAddRunMessage(runId, 'assistant', seg)
    }
    widgetWin?.webContents.send('routine:run-message', { runId, chunk: '', done: true })
  } catch (err: any) {
    widgetWin?.webContents.send('routine:run-message', {
      runId,
      chunk: '',
      done: true,
      error: err?.message ?? 'Claude failed to respond'
    })
  }
}

export async function dismissRun(runId: string, status: RunStatus): Promise<void> {
  dbUpdateRun(runId, { status })
}
