import { describe, expect, it } from 'vitest'
import { detectSyncCapabilities, memoryBudgetBytes, poolSize } from '~/lib/capabilities'

const MB = 1024 * 1024

describe('capabilities', () => {
  it('probes without throwing and recognises WASM SIMD in Node', () => {
    const caps = detectSyncCapabilities()
    expect(caps.hardwareConcurrency).toBeGreaterThan(0)
    expect(caps.wasmSimd).toBe(true)
  })

  it('sizes the pool from cores and memory', () => {
    expect(poolSize({ hardwareConcurrency: 16, deviceMemory: 8, isIOS: false })).toBe(4)
    expect(poolSize({ hardwareConcurrency: 2, deviceMemory: 8, isIOS: false })).toBe(1)
    expect(poolSize({ hardwareConcurrency: 8, deviceMemory: 4, isIOS: false })).toBe(2)
    expect(poolSize({ hardwareConcurrency: 6, deviceMemory: 4, isIOS: true })).toBe(2)
    expect(poolSize({ hardwareConcurrency: 16, deviceMemory: 8, isIOS: false }, true)).toBe(1)
  })

  it('caps the memory budget on iOS and on large machines', () => {
    expect(memoryBudgetBytes({ deviceMemory: 8, isIOS: true })).toBe(256 * MB)
    expect(memoryBudgetBytes({ deviceMemory: 2, isIOS: false })).toBe(256 * MB)
    expect(memoryBudgetBytes({ deviceMemory: 32, isIOS: false })).toBe(1024 * MB)
  })
})
