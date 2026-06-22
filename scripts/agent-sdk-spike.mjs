/**
 * Phase 0 spike — validates the Claude Agent SDK works in this environment.
 * Run with:  node scripts/agent-sdk-spike.mjs
 *
 * Tests:
 * 1. One-shot query() with NO ANTHROPIC_API_KEY set (uses Claude Code login)
 * 2. Reports auth method, model, token usage from SDKResultMessage
 * 3. Confirms canUseTool callback fires
 * 4. Tests tool() + createSdkMcpServer() in-process tool registration
 */

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// Ensure no API key is accidentally present from env
const env = { ...process.env }
delete env.ANTHROPIC_API_KEY

console.log('=== Phase 0: Claude Agent SDK Spike ===\n')

// ── Test 1: auth without API key ─────────────────────────────────────────────
console.log('TEST 1: One-shot query with no ANTHROPIC_API_KEY')
console.log('  (if this succeeds, auth via Claude Code login is confirmed)\n')

let usageInfo = null
let resultText = ''

try {
  for await (const msg of query({
    prompt: 'Reply with exactly the text: SDK_AUTH_OK',
    options: {
      env,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    }
  })) {
    if (msg.type === 'assistant') {
      for (const block of (msg.message?.content ?? [])) {
        if (block.type === 'text') resultText += block.text
      }
    }
    if (msg.type === 'result') {
      usageInfo = msg
    }
  }
  console.log('  Auth result: PASS')
  console.log('  Response text:', resultText.trim())
  if (usageInfo) {
    const stats = usageInfo.subagent_stop_reason ?? usageInfo.stop_reason
    console.log('  Stop reason:', stats)
    console.log('  Usage:', JSON.stringify(usageInfo.usage ?? usageInfo.total_cost_usd ?? '(none)'))
  }
} catch (err) {
  console.error('  Auth result: FAIL —', err.message)
  console.error('  This means the SDK requires an explicit ANTHROPIC_API_KEY.')
  console.error('  Full error:', err)
  process.exit(1)
}

// ── Test 2: canUseTool callback ───────────────────────────────────────────────
console.log('\nTEST 2: canUseTool callback fires before tool execution')

let toolCallObserved = false

try {
  for await (const msg of query({
    prompt: 'Run: echo hello',
    options: {
      env,
      maxTurns: 2,
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        console.log(`  canUseTool fired: tool="${toolName}" input=${JSON.stringify(input)}`)
        toolCallObserved = true
        return { behavior: 'deny', message: 'Spike test — denying all tools' }
      }
    }
  })) {
    // just drain
  }
  console.log('  canUseTool observed:', toolCallObserved ? 'YES (PASS)' : 'NO (tool may not have been called)')
} catch (err) {
  console.log('  canUseTool test error (non-fatal):', err.message)
}

// ── Test 3: in-process tool() + createSdkMcpServer ───────────────────────────
console.log('\nTEST 3: in-process tool() + createSdkMcpServer')

let inProcessToolCalled = false
const spikeTool = tool(
  'spike_echo',
  'Echo back the input string',
  { message: z.string() },
  async ({ message }) => {
    inProcessToolCalled = true
    console.log(`  spike_echo tool handler called with: ${message}`)
    return { content: [{ type: 'text', text: `ECHO: ${message}` }] }
  },
  { annotations: { readOnlyHint: true } }
)

const sdkServer = createSdkMcpServer({ name: 'spike-server', tools: [spikeTool] })

try {
  let toolResultText = ''
  for await (const msg of query({
    prompt: 'Use the spike_echo tool with message "hello_from_spike" and return its output.',
    options: {
      env,
      maxTurns: 3,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers: { 'spike-server': sdkServer }
    }
  })) {
    if (msg.type === 'assistant') {
      for (const block of (msg.message?.content ?? [])) {
        if (block.type === 'text') toolResultText += block.text
      }
    }
  }
  console.log('  In-process tool called:', inProcessToolCalled ? 'YES (PASS)' : 'NO (FAIL — model may not have called it)')
  console.log('  Assistant response:', toolResultText.trim().slice(0, 200))
} catch (err) {
  console.error('  In-process tool test error:', err.message)
}

// ── Test 4: message type inventory ───────────────────────────────────────────
console.log('\nTEST 4: Observe message types from query() stream')
const seenTypes = new Set()
try {
  for await (const msg of query({
    prompt: 'Say: hello',
    options: {
      env,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    }
  })) {
    seenTypes.add(msg.type)
  }
  console.log('  Message types observed:', [...seenTypes].join(', '))
} catch (err) {
  console.log('  Message type test error (non-fatal):', err.message)
}

console.log('\n=== Spike complete ===')
