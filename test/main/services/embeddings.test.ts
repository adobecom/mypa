import { describe, it, expect, vi } from 'vitest'
import { cosineSim, floatToBlob, blobToFloat } from '@main/services/embeddings'

// embeddings.ts imports `app` from electron at the top (used only inside the
// lazily-loaded getPipeline()) and `../db/index` (referenced, never called by
// the functions under test) — the global electron mock in test/setup.ts covers
// the import; no further mocking needed for these pure vector-math helpers.
// (vi.mock calls are hoisted above imports by Vitest's transform.)
vi.mock('@main/db/index', () => ({
  dbSetSignalEmbedding: vi.fn(),
  dbGetSignalsMissingEmbeddings: vi.fn(),
  dbSetMemoryEmbedding: vi.fn(),
  dbGetMemoriesMissingEmbeddings: vi.fn()
}))

describe('cosineSim', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = new Float32Array([1, 0, 0])
    expect(cosineSim(v, v)).toBeCloseTo(1, 5)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    expect(cosineSim(a, b)).toBeCloseTo(0, 5)
  })

  it('returns the dot product for pre-normalized vectors', () => {
    const a = new Float32Array([0.6, 0.8])
    const b = new Float32Array([0.8, 0.6])
    expect(cosineSim(a, b)).toBeCloseTo(0.6 * 0.8 + 0.8 * 0.6, 5)
  })

  it('returns 0 and does not throw on a dimension mismatch', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([1, 2])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(cosineSim(a, b)).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('floatToBlob / blobToFloat round-trip', () => {
  it('preserves values through serialize/deserialize', () => {
    const original = new Float32Array([0.1, -0.5, 3.25, 0, 1e-3])
    const blob = floatToBlob(original)
    const restored = blobToFloat(blob)
    expect(Array.from(restored)).toEqual(Array.from(original))
  })

  it('handles an empty vector', () => {
    const original = new Float32Array([])
    expect(Array.from(blobToFloat(floatToBlob(original)))).toEqual([])
  })
})
