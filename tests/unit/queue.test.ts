import { describe, expect, it, vi } from 'vitest'
import type { PoolLike, Slot } from '~/workers/pool'
import { JobQueue } from '~/workers/queue'
import { createToolApi } from '~/workers/expose'
import { JobCancelledError, type ProgressFn } from '~/workers/types'

type Behaviour = (input: number, signal: AbortSignal, progress: ProgressFn) => Promise<number>

/** In-memory pool whose slots run `behaviour` directly through the real worker-side API. */
function fakePool(size: number, behaviour: Behaviour) {
  let nextId = 1
  const slots: (Slot<number, number> & { busy: boolean })[] = []
  const killed: number[] = []
  const pool: PoolLike<number, number> = {
    acquire() {
      let s = slots.find(x => !x.busy)
      if (!s && slots.length < size) {
        const api = createToolApi<number, number>((input, ctx) => behaviour(input, ctx.signal, ctx.progress))
        s = { id: nextId++, busy: false, run: api.run, cancel: api.cancel }
        slots.push(s)
      }
      if (!s) return null
      s.busy = true
      return s
    },
    release(slot) {
      const s = slots.find(x => x.id === slot.id)
      if (s) s.busy = false
    },
    kill(slot) {
      killed.push(slot.id)
      slots.splice(slots.findIndex(x => x.id === slot.id), 1)
    },
  }
  return { pool, killed, slots }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('JobQueue', () => {
  it('runs jobs and limits concurrency to the pool size', async () => {
    let concurrent = 0
    let peak = 0
    const { pool } = fakePool(2, async (n) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await sleep(10)
      concurrent--
      return n * 2
    })
    const q = new JobQueue(pool)
    const results = await Promise.all([1, 2, 3, 4, 5].map(n => q.submit(n)))
    expect(results).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBe(2)
  })

  it('starts interactive jobs before queued batch jobs', async () => {
    const order: number[] = []
    const { pool } = fakePool(1, async (n) => {
      order.push(n)
      await sleep(5)
      return n
    })
    const q = new JobQueue(pool)
    const all = [q.submit(1), q.submit(2), q.submit(3), q.submit(99, { priority: 'interactive' })]
    await Promise.all(all)
    // Job 1 was already running; 99 jumps ahead of 2 and 3.
    expect(order).toEqual([1, 99, 2, 3])
  })

  it('reports progress and always ends at 1', async () => {
    const { pool } = fakePool(1, async (n, _s, progress) => {
      progress({ ratio: 0.5, phase: 'half' })
      return n
    })
    const seen: number[] = []
    await new JobQueue(pool).submit(1, { onProgress: p => seen.push(p.ratio) })
    expect(seen[0]).toBe(0.5)
    expect(seen.at(-1)).toBe(1)
  })

  it('removes a queued job when aborted', async () => {
    const run = vi.fn(async (n: number) => {
      await sleep(20)
      return n
    })
    const { pool } = fakePool(1, run)
    const q = new JobQueue(pool)
    const first = q.submit(1)
    const ac = new AbortController()
    const second = q.submit(2, { signal: ac.signal })
    ac.abort()
    await expect(second).rejects.toBeInstanceOf(JobCancelledError)
    await expect(first).resolves.toBe(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('cancels a cooperative running job without killing the worker', async () => {
    const { pool, killed } = fakePool(1, (_n, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const q = new JobQueue(pool, 200)
    const ac = new AbortController()
    const p = q.submit(1, { signal: ac.signal })
    await sleep(5)
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(JobCancelledError)
    expect(killed).toEqual([])
    // The slot is reusable afterwards.
    expect(q.runningCount).toBe(0)
  })

  it('kills the worker when a running job ignores cancellation', async () => {
    const { pool, killed } = fakePool(1, () => new Promise(() => {})) // never settles (busy WASM)
    const q = new JobQueue(pool, 30)
    const ac = new AbortController()
    const p = q.submit(1, { signal: ac.signal })
    await sleep(5)
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(JobCancelledError)
    expect(killed).toEqual([1])
    expect(q.runningCount).toBe(0)
  })

  it('keeps going after a job fails', async () => {
    const { pool } = fakePool(1, async (n) => {
      if (n === 2) throw new RangeError('out of memory')
      return n
    })
    const q = new JobQueue(pool)
    const results = await Promise.allSettled([q.submit(1), q.submit(2), q.submit(3)])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })

  it('replaces a crashed worker and continues the batch', async () => {
    const { pool, killed } = fakePool(1, async (n) => {
      if (n === 2) {
        const e = new Error('worker died')
        e.name = 'WorkerCrashedError'
        throw e
      }
      return n
    })
    const q = new JobQueue(pool)
    const results = await Promise.allSettled([q.submit(1), q.submit(2), q.submit(3)])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(killed).toEqual([1])
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const { pool } = fakePool(1, async n => n)
    const ac = new AbortController()
    ac.abort()
    await expect(new JobQueue(pool).submit(1, { signal: ac.signal })).rejects.toBeInstanceOf(JobCancelledError)
  })
})
