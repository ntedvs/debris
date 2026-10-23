import type { QuadSpec } from "../spec"

const ARM = 0.0795 // 225 mm wheelbase X frame: 112.5 mm center to motor, at 45 degrees

/**
 * Typical 5" freestyle quad: 2207 1950KV on 6S, 5x4.3x3 props, 1300 mAh pack.
 * Numbers chosen to land close to bench data: ~1.6 kgf per motor at ~35-45 A,
 * hover around 25-30% throttle, ~10:1 thrust to weight.
 */
export const fiveInchFreestyle: QuadSpec = {
  id: "5in-freestyle",
  name: '5" Freestyle',
  description: "2207 1950KV, 6S 1300 mAh, 5x4.3x3 props, 650 g all-up",
  frame: {
    mass: 0.65,
    inertia: [1.7e-3, 3.0e-3, 1.5e-3],
    // Betaflight Quad X order: rear right, front right, rear left, front left (props in)
    motors: [
      { position: [ARM, 0.012, ARM], spin: "cw" },
      { position: [ARM, 0.012, -ARM], spin: "ccw" },
      { position: [-ARM, 0.012, ARM], spin: "ccw" },
      { position: [-ARM, 0.012, -ARM], spin: "cw" },
    ],
    dragArea: [0.012, 0.02, 0.009],
    angularDrag: [2e-5, 2e-5, 2e-5],
    colliderHalfExtents: [0.135, 0.03, 0.135],
  },
  motor: {
    kv: 1950,
    resistance: 0.06,
    noLoadCurrent: 1.2,
    currentLimit: 100,
    rotorInertia: 6e-6,
  },
  prop: {
    diameter: 0.127,
    pitch: 0.109,
    ct0: 0.16,
    cp0: 0.1,
    zeroThrustJ: 0.9,
    hForce: 3.5e-5,
  },
  battery: { cells: 6, capacityMah: 1300, internalResistance: 0.025 },
  camera: { position: [0, 0.025, -0.05], uptilt: 30, fov: 120 },
  fc: {
    // Betaflight 4.5 defaults
    pids: {
      roll: { p: 45, i: 80, d: 40, f: 120 },
      pitch: { p: 47, i: 84, d: 46, f: 125 },
      yaw: { p: 45, i: 80, d: 0, f: 120 },
    },
    rates: {
      type: "actual",
      roll: { a: 70, b: 670, expo: 0 },
      pitch: { a: 70, b: 670, expo: 0 },
      yaw: { a: 70, b: 670, expo: 0 },
    },
    idle: 0.055,
    airmode: true,
    gyroLpfHz: 250,
    dtermLpfHz: 100,
    rcSmoothingHz: 40,
    tpa: { rate: 0.65, breakpoint: 0.35 },
  },
}
