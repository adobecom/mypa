import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/types'
import type { ContextPacket } from '@main/services/memory-graph'
import type { TriggerHit } from '@main/services/triggers'

// inferIntent's only real dependencies (once a ContextPacket is passed in directly,
// skipping assembleContextPacket) are runClaude and the owner/directives clause
// builders — both from './config' and './claude'. Mocking those two modules keeps
// this hermetic and also shields parseIntentObject/sanitizeRationale from the rest
// of inference.ts's heavier transitive imports (mcp.ts, repos.ts, memory-graph.ts).
vi.mock('@main/services/config', () => ({
  readConfig: vi.fn(() => DEFAULT_CONFIG),
  buildOwnerClause: vi.fn(() => ''),
  buildDirectivesClause: vi.fn(() => ''),
  getOwnerHandles: vi.fn(() => [])
}))
vi.mock('@main/services/claude', () => ({
  runClaude: vi.fn(),
  runClaudeWithMcp: vi.fn()
}))

const { parseIntentObject, sanitizeRationale, inferIntent } = await import('@main/services/inference')
const claude = await import('@main/services/claude')

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── sanitizeRationale ─────────────────────────────────────────────────────────

describe('sanitizeRationale', () => {
  it('collapses internal whitespace', () => {
    expect(sanitizeRationale('found  a\n\nthing.')).toBe('found a thing.')
  })

  it('cuts to the first sentence boundary', () => {
    expect(sanitizeRationale('The PR is ready to merge. It has two approvals.')).toBe('The PR is ready to merge.')
  })

  it('returns empty string for planning-preamble text', () => {
    expect(sanitizeRationale('Let me check the PR details first.')).toBe('')
    expect(sanitizeRationale('I need to read the full thread before responding.')).toBe('')
    expect(sanitizeRationale('First, I will look at the issue.')).toBe('')
  })

  it('clamps to 300 characters', () => {
    const long = 'a'.repeat(500) + '.'
    expect(sanitizeRationale(long).length).toBe(300)
  })

  it('returns empty string for blank input', () => {
    expect(sanitizeRationale('   ')).toBe('')
  })

  it('passes through an ordinary conclusion sentence unchanged', () => {
    expect(sanitizeRationale('Bob is waiting on your review.')).toBe('Bob is waiting on your review.')
  })
})

// ─── parseIntentObject ──────────────────────────────────────────────────────────

const VALID_ACTION_JSON = JSON.stringify({
  type: 'action',
  confidence: 0.9,
  urgency: 0.8,
  proposed_action: {
    surface: 'github',
    verb: 'comment',
    target: 'PR #1',
    payload: { body: 'looks good' }
  },
  rationale: 'The PR is ready to merge.',
  reversibility: 'reversible',
  required_approval: true,
  cta_label: 'Post comment'
})

describe('parseIntentObject', () => {
  it('parses a well-formed response', () => {
    const obj = parseIntentObject(VALID_ACTION_JSON)
    expect(obj).not.toBeNull()
    expect(obj!.type).toBe('action')
    expect(obj!.confidence).toBe(0.9)
    expect(obj!.proposed_action.verb).toBe('comment')
    expect(obj!.cta_label).toBe('Post comment')
  })

  it('extracts JSON embedded in surrounding prose', () => {
    const obj = parseIntentObject(`Here is my answer:\n${VALID_ACTION_JSON}\nThanks.`)
    expect(obj).not.toBeNull()
  })

  it('returns null when no JSON object is present', () => {
    expect(parseIntentObject('no json here')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseIntentObject('{ this is not valid json ')).toBeNull()
  })

  it('returns null for an unknown type', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.type = 'not-a-real-type'
    expect(parseIntentObject(JSON.stringify(obj))).toBeNull()
  })

  it('clamps out-of-range confidence and urgency to [0, 1]', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.confidence = 5
    obj.urgency = -3
    const parsed = parseIntentObject(JSON.stringify(obj))
    expect(parsed!.confidence).toBe(1)
    expect(parsed!.urgency).toBe(0)
  })

  it('defaults missing confidence/urgency to 0', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    delete obj.confidence
    delete obj.urgency
    const parsed = parseIntentObject(JSON.stringify(obj))
    expect(parsed!.confidence).toBe(0)
    expect(parsed!.urgency).toBe(0)
  })

  it('clamps an unknown verb for the surface to "none"', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.proposed_action.verb = 'delete_everything'
    const parsed = parseIntentObject(JSON.stringify(obj))
    expect(parsed!.proposed_action.verb).toBe('none')
  })

  it('defaults an unrecognized surface to github for digest/flag types', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.type = 'flag'
    obj.proposed_action.verb = 'none'
    obj.proposed_action.surface = 'not-a-surface'
    const parsed = parseIntentObject(JSON.stringify(obj))
    expect(parsed!.proposed_action.surface).toBe('github')
  })

  it('rejects an unrecognized surface for an action type', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.proposed_action.surface = 'not-a-surface'
    expect(parseIntentObject(JSON.stringify(obj))).toBeNull()
  })

  it('coerces reversibility — anything but "irreversible" becomes "reversible"', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.reversibility = 'whatever'
    expect(parseIntentObject(JSON.stringify(obj))!.reversibility).toBe('reversible')
  })

  it('defaults required_approval to true unless explicitly false', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    delete obj.required_approval
    expect(parseIntentObject(JSON.stringify(obj))!.required_approval).toBe(true)

    obj.required_approval = false
    expect(parseIntentObject(JSON.stringify(obj))!.required_approval).toBe(false)
  })

  it('drops a blank cta_label to null', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.cta_label = '   '
    expect(parseIntentObject(JSON.stringify(obj))!.cta_label).toBeNull()
  })

  it('sanitizes the rationale through sanitizeRationale', () => {
    const obj = JSON.parse(VALID_ACTION_JSON)
    obj.rationale = 'Let me check first. Then I will decide.'
    expect(parseIntentObject(JSON.stringify(obj))!.rationale).toBe('')
  })
})

// ─── inferIntent drop-reason decisions ──────────────────────────────────────────

const hit: TriggerHit = { kind: 'spike', focusNodeIds: [], reason: 'test trigger' }
const packet: ContextPacket = {
  triggerKind: 'spike',
  focusNodes: [],
  relatedEdges: [],
  recentSignals: [],
  topByWeight: [],
  semanticSignals: [],
  memories: []
}

function respondWith(obj: Record<string, unknown>): void {
  vi.mocked(claude.runClaude).mockResolvedValue(JSON.stringify(obj))
}

const BASE_RESPONSE = {
  type: 'action',
  confidence: 0.9,
  urgency: 0.9,
  proposed_action: { surface: 'github', verb: 'comment', target: 'PR #1', payload: { body: 'x' } },
  rationale: 'Something worth surfacing.',
  reversibility: 'reversible',
  required_approval: true
}

describe('inferIntent', () => {
  it('returns the parsed object when it clears every floor', async () => {
    respondWith(BASE_RESPONSE)
    const result = await inferIntent(hit, packet)
    expect(result.obj).not.toBeNull()
    expect(result.dropReason).toBeUndefined()
  })

  it('drops the "nothing actionable" sentinel even with inflated confidence', async () => {
    respondWith({
      type: 'flag',
      confidence: 0.99,
      urgency: 0.99,
      proposed_action: { surface: 'github', verb: 'none', target: 'nothing', payload: {} },
      rationale: 'nothing actionable',
      reversibility: 'reversible',
      required_approval: false
    })
    const result = await inferIntent(hit, packet)
    expect(result.obj).toBeNull()
    expect(result.dropReason).toBe('empty-sentinel')
  })

  it('drops responses below the confidence floor', async () => {
    respondWith({ ...BASE_RESPONSE, confidence: 0.1 })
    const result = await inferIntent(hit, packet)
    expect(result.dropReason).toBe('below-confidence')
  })

  it('drops responses below the default urgency floor for a non-waiting kind', async () => {
    respondWith({ ...BASE_RESPONSE, urgency: 0.3 }) // below default 0.5 floor
    const result = await inferIntent({ ...hit, kind: 'spike' }, packet)
    expect(result.dropReason).toBe('below-urgency')
  })

  it('applies the lenient waiting-urgency floor for a "waiting" kind hit', async () => {
    respondWith({ ...BASE_RESPONSE, urgency: 0.3 }) // above the 0.25 waiting floor, below the 0.5 default
    const result = await inferIntent({ ...hit, kind: 'waiting' }, packet)
    expect(result.obj).not.toBeNull()
  })

  it('drops an action-type response with verb "none"', async () => {
    respondWith({ ...BASE_RESPONSE, proposed_action: { ...BASE_RESPONSE.proposed_action, verb: 'none' } })
    const result = await inferIntent(hit, packet)
    expect(result.dropReason).toBe('verb-none')
  })

  it('keeps a flag-type response with verb "none" (informational intents are valid)', async () => {
    respondWith({
      ...BASE_RESPONSE,
      type: 'flag',
      proposed_action: { ...BASE_RESPONSE.proposed_action, verb: 'none' }
    })
    const result = await inferIntent(hit, packet)
    expect(result.obj).not.toBeNull()
  })

  it('returns a parse-fail result when the response has no parseable JSON', async () => {
    vi.mocked(claude.runClaude).mockResolvedValue('not json at all')
    const result = await inferIntent(hit, packet)
    expect(result.dropReason).toBe('parse-fail')
  })

  it('returns an error result when runClaude throws', async () => {
    vi.mocked(claude.runClaude).mockRejectedValue(new Error('cli failed'))
    const result = await inferIntent(hit, packet)
    expect(result.dropReason).toBe('error')
  })
})
