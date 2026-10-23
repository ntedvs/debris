import type { Rates } from "./spec"

const SETPOINT_RATE_LIMIT = 1998
type Axis = { a: number; b: number; expo: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Stick deflection (-1..1) to rotation rate (deg/s). Ports of Betaflight rc.c rate models. */
export function applyRates(type: Rates["type"], axis: Axis, stick: number): number {
  const x = clamp(stick, -1, 1)
  const ax = Math.abs(x)
  switch (type) {
    case "actual": {
      const expof = ax * (x ** 5 * axis.expo + x * (1 - axis.expo))
      const center = axis.a
      const stickMovement = Math.max(0, axis.b - center)
      return clamp(x * center + stickMovement * expof, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT)
    }
    case "betaflight": {
      let cmd = x
      if (axis.expo) cmd = x * ax ** 3 * axis.expo + x * (1 - axis.expo)
      let rcRate = axis.a
      if (rcRate > 2) rcRate += 14.54 * (rcRate - 2)
      let rate = 200 * rcRate * cmd
      if (axis.b) rate *= 1 / clamp(1 - ax * axis.b, 0.01, 1)
      return clamp(rate, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT)
    }
    case "kiss": {
      const useRates = 1 / clamp(1 - ax * axis.b, 0.01, 1)
      const cmd = (x ** 3 * axis.expo + x * (1 - axis.expo)) * (axis.a / 10)
      return clamp(2000 * useRates * cmd, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT)
    }
    case "quick": {
      const rcRate = axis.a
      const maxDps = Math.max(axis.b, rcRate)
      const superCfg = (maxDps / rcRate - 1) / (maxDps / rcRate)
      const curve = ax ** 3 * axis.expo + ax * (1 - axis.expo)
      const superFactor = 1 / clamp(1 - curve * superCfg, 0.01, 1)
      return clamp(x * rcRate * superFactor, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT)
    }
  }
}
