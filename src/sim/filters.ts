/** First order lowpass, same as Betaflight pt1Filter. */
export class Pt1 {
  state = 0
  private k = 1
  constructor(cutoffHz: number, dt: number) {
    this.setCutoff(cutoffHz, dt)
  }
  setCutoff(cutoffHz: number, dt: number) {
    const rc = 1 / (2 * Math.PI * cutoffHz)
    this.k = dt / (rc + dt)
  }
  apply(input: number) {
    this.state += this.k * (input - this.state)
    return this.state
  }
  reset(value = 0) {
    this.state = value
  }
}

/** Third order lowpass (three PT1 stages), cutoff corrected like Betaflight pt3Filter. */
export class Pt3 {
  private stages: [Pt1, Pt1, Pt1]
  constructor(cutoffHz: number, dt: number) {
    const corrected = cutoffHz * 1.961459177
    this.stages = [new Pt1(corrected, dt), new Pt1(corrected, dt), new Pt1(corrected, dt)]
  }
  apply(input: number) {
    return this.stages[2].apply(this.stages[1].apply(this.stages[0].apply(input)))
  }
  reset(value = 0) {
    for (const s of this.stages) s.reset(value)
  }
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Band limited gaussian noise with roughly unit standard deviation. */
export class ColoredNoise {
  private filter: Pt1
  private scale: number
  private rand: () => number
  constructor(cutoffHz: number, dt: number, seed: number) {
    this.filter = new Pt1(cutoffHz, dt)
    const rc = 1 / (2 * Math.PI * cutoffHz)
    const k = dt / (rc + dt)
    this.scale = Math.sqrt((2 - k) / k)
    this.rand = rng(seed)
  }
  next() {
    const u = Math.max(1e-12, this.rand())
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand())
    return this.filter.apply(g) * this.scale
  }
}
