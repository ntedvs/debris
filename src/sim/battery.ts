import type { BatterySpec } from "./spec"

// LiPo open circuit voltage per cell vs state of charge.
const OCV: [number, number][] = [
  [0, 3.3],
  [0.05, 3.55],
  [0.1, 3.68],
  [0.2, 3.73],
  [0.3, 3.77],
  [0.4, 3.8],
  [0.5, 3.84],
  [0.6, 3.88],
  [0.7, 3.94],
  [0.8, 4.01],
  [0.9, 4.09],
  [1, 4.2],
]

function ocvPerCell(soc: number) {
  const s = Math.min(1, Math.max(0, soc))
  for (let i = 1; i < OCV.length; i++) {
    const [s1, v1] = OCV[i]!
    const [s0, v0] = OCV[i - 1]!
    if (s <= s1) return v0 + ((v1 - v0) * (s - s0)) / (s1 - s0)
  }
  return 4.2
}

/**
 * Battery with ohmic resistance plus one RC polarization branch, so voltage sags
 * instantly on a punch out and then keeps sinking/recovering over a few seconds.
 */
export class Battery {
  usedMah = 0
  current = 0
  voltage: number
  private polarization = 0
  private readonly r0: number
  private readonly r1: number
  private readonly tau = 4

  constructor(readonly spec: BatterySpec) {
    this.r0 = spec.internalResistance * 0.7
    this.r1 = spec.internalResistance * 0.3
    this.voltage = this.openCircuitVoltage()
  }

  get soc() {
    return 1 - this.usedMah / this.spec.capacityMah
  }

  get ohmicResistance() {
    return this.r0
  }

  /** Open circuit voltage minus the slow polarization drop. */
  sourceVoltage() {
    return this.openCircuitVoltage() - this.polarization
  }

  openCircuitVoltage() {
    return ocvPerCell(this.soc) * this.spec.cells
  }

  /** Advance state with the current drawn this step. */
  update(current: number, busVoltage: number, dt: number) {
    this.current = current
    this.voltage = busVoltage
    this.usedMah += (current * dt * 1000) / 3600
    this.polarization += ((current * this.r1 - this.polarization) / this.tau) * dt
  }

  reset() {
    this.usedMah = 0
    this.current = 0
    this.polarization = 0
    this.voltage = this.openCircuitVoltage()
  }
}
