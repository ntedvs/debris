import { rng } from "../sim/filters"

/** Hash based value noise. Optional period makes it tile. */
function hash(ix: number, iy: number, seed: number) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

export function valueNoise(x: number, y: number, seed = 0, period = 0) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smooth(x - x0)
  const fy = smooth(y - y0)
  const wrap = (v: number) => (period ? ((v % period) + period) % period : v)
  const a = hash(wrap(x0), wrap(y0), seed)
  const b = hash(wrap(x0 + 1), wrap(y0), seed)
  const c = hash(wrap(x0), wrap(y0 + 1), seed)
  const d = hash(wrap(x0 + 1), wrap(y0 + 1), seed)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

/** Fractal noise in 0..1. With period > 0 it tiles over [0, period). */
export function fbm(x: number, y: number, octaves = 4, seed = 0, period = 0) {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 17, period ? period * freq : 0)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

export { rng }
