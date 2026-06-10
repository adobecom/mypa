import { join } from 'path'
import { app } from 'electron'
import { dbSetSignalEmbedding, dbGetSignalsMissingEmbeddings } from '../db/index'
import type { Signal } from '@shared/types'

// ─── Model constants ──────────────────────────────────────────────────────────

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'
const EMBEDDING_DIM = 384

// ─── Lazy pipeline singleton ──────────────────────────────────────────────────

type EmbeddingPipeline = (text: string, options: Record<string, unknown>) => Promise<{ data: Float32Array }>

let _pipeline: EmbeddingPipeline | null = null
let _pipelineLoading = false
let _pipelineLastFailureAt = 0
const PIPELINE_RETRY_COOLDOWN_MS = 60_000

async function getPipeline(): Promise<EmbeddingPipeline | null> {
  if (_pipeline) return _pipeline
  if (_pipelineLoading) return null
  if (Date.now() - _pipelineLastFailureAt < PIPELINE_RETRY_COOLDOWN_MS) return null

  _pipelineLoading = true
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = join(app.getPath('home'), '.mypa', 'models')
    env.allowLocalModels = true

    _pipeline = await pipeline('feature-extraction', MODEL_NAME, { dtype: 'q8' }) as unknown as EmbeddingPipeline
    console.log('[embeddings] pipeline ready')
    return _pipeline
  } catch (e) {
    console.warn('[embeddings] pipeline init failed (retry in 60s):', e)
    _pipelineLoading = false
    _pipelineLastFailureAt = Date.now()
    return null
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed a string with all-MiniLM-L6-v2 (384-dim, normalized).
 * Returns null if the model isn't loaded yet or errors — callers degrade gracefully.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  const pipe = await getPipeline()
  if (!pipe) return null
  try {
    const result = await pipe(text, { pooling: 'mean', normalize: true })
    return result.data as Float32Array
  } catch (e) {
    console.warn('[embeddings] embedText failed:', e)
    return null
  }
}

/**
 * Cosine similarity between two pre-normalized unit vectors (= dot product).
 * Returns 0 (and logs) on dimension mismatch rather than producing silent NaN.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    console.warn(`[embeddings] cosineSim: dimension mismatch ${a.length} vs ${b.length}`)
    return 0
  }
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** Serialize a Float32Array to a Buffer for SQLite BLOB storage. */
export function floatToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

/** Deserialize a Buffer from SQLite BLOB back to Float32Array. */
export function blobToFloat(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

// ─── Async embedding queue ────────────────────────────────────────────────────
// Serialized promise chain — never run two ONNX inferences concurrently.

let embeddingQueue: Promise<void> = Promise.resolve()

/**
 * Fire-and-forget: enqueue signals for background embedding.
 * Never call this from the synchronous poll path.
 */
export function enqueueEmbeddings(signals: Signal[]): void {
  if (signals.length === 0) return
  embeddingQueue = embeddingQueue
    .then(() => embedBatch(signals))
    .catch((e) => console.error('[embeddings] queue error:', e))
}

/**
 * One-time backfill: embed all signals that have no embedding yet.
 * Drains in batches of 100 until none remain.
 * Call from startAmbient (fire-and-forget) after ingestion starts.
 */
export function enqueueBackfill(): void {
  embeddingQueue = embeddingQueue
    .then(async () => {
      let batch: Signal[]
      do {
        batch = dbGetSignalsMissingEmbeddings(100)
        if (batch.length > 0) {
          console.log(`[embeddings] backfilling ${batch.length} signals`)
          await embedBatch(batch)
        }
      } while (batch.length === 100) // if exactly 100 returned, there may be more
    })
    .catch((e) => console.error('[embeddings] backfill error:', e))
}

async function embedBatch(signals: Signal[]): Promise<void> {
  for (const signal of signals) {
    try {
      const text = `${signal.title}\n${signal.body}`.trim()
      const vec = await embedText(text)
      if (!vec) continue // model not ready yet
      dbSetSignalEmbedding(signal.id, floatToBlob(vec), MODEL_NAME)
    } catch (e) {
      console.warn(`[embeddings] failed to embed signal ${signal.id}:`, e)
    }
  }
}
