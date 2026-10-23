import type { PropSpec } from "./spec"

/**
 * Static coefficients with a linear falloff in advance ratio J = V / (n D).
 * Written in a form that stays finite as n goes to zero.
 */
export function propAero(prop: PropSpec, rho: number, omega: number, vAxial: number) {
  const n = Math.max(omega, 0) / (2 * Math.PI)
  const D = prop.diameter
  const j0 = prop.zeroThrustJ ?? (prop.pitch / D) * 1.05
  const nd = Math.max(n * D, 1e-6)
  // Positive vAxial: air coming from above (climbing), reduces thrust.
  const J = Math.min(Math.max(vAxial / nd, -j0), 1.5 * j0)
  const jr = J / j0
  // Descending into clean air gives a small gain, past zero-thrust J the prop windmills.
  const ctScale = jr < 0 ? 1 - 0.15 * jr : Math.max(1 - jr, -0.1)
  const cpScale = Math.max(1 - 0.6 * jr * jr, 0.25)
  const thrust = prop.ct0 * ctScale * rho * n * n * D ** 4
  const power = prop.cp0 * cpScale * rho * n * n * n * D ** 5
  const torque = n > 1e-3 ? power / (2 * Math.PI * n) : 0
  return { thrust, torque }
}

/** Hover induced velocity for a given thrust (momentum theory). */
export function inducedVelocity(prop: PropSpec, rho: number, thrust: number) {
  const area = Math.PI * (prop.diameter / 2) ** 2
  return Math.sqrt(Math.max(thrust, 0) / (2 * rho * area))
}
