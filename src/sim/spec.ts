import { z } from "zod"

/**
 * Vehicle description. Everything the physics needs lives here, so adding a new
 * quad type is just adding a new spec file in `src/sim/quads/`.
 *
 * Body frame (same as Three.js): +X right, +Y up (thrust direction), +Z back.
 * The nose points along -Z.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()])

export const MotorSpec = z.object({
  /** Motor velocity constant, rpm per volt. */
  kv: z.number().positive(),
  /** Winding resistance, ohms (phase to phase). */
  resistance: z.number().positive(),
  /** No-load current, amps. Models bearing and iron losses as a friction torque. */
  noLoadCurrent: z.number().nonnegative(),
  /** ESC / motor current limit, amps. */
  currentLimit: z.number().positive(),
  /** Inertia of the spinning parts (bell + prop), kg m^2. */
  rotorInertia: z.number().positive(),
})

export const PropSpec = z.object({
  /** Prop diameter, meters. */
  diameter: z.number().positive(),
  /** Prop pitch, meters. */
  pitch: z.number().positive(),
  /** Static thrust coefficient: T = ct * rho * n^2 * D^4 (n in rev/s). */
  ct0: z.number().positive(),
  /** Static power coefficient: P = cp * rho * n^3 * D^5. */
  cp0: z.number().positive(),
  /** Advance ratio J = V / (n D) where thrust reaches zero. Defaults to ~pitch / diameter. */
  zeroThrustJ: z.number().positive().optional(),
  /** Rotor in-plane drag (H-force + blade flapping), N per (m/s) per (rad/s). */
  hForce: z.number().nonnegative(),
})

export const BatterySpec = z.object({
  cells: z.number().int().positive(),
  capacityMah: z.number().positive(),
  /** Whole-pack internal resistance including leads, ohms. */
  internalResistance: z.number().nonnegative(),
})

export const MotorMount = z.object({
  /** Prop hub position in body frame, meters, relative to center of mass. */
  position: vec3,
  /** Spin direction seen from above. */
  spin: z.enum(["cw", "ccw"]),
})

export const FrameSpec = z.object({
  /** All-up weight including battery, kg. */
  mass: z.number().positive(),
  /** Principal moments of inertia about body X (pitch), Y (yaw), Z (roll), kg m^2. */
  inertia: vec3,
  motors: z.array(MotorMount).min(3),
  /** Drag area Cd*A seen along body X (side), Y (top), Z (front), m^2. */
  dragArea: vec3,
  /** Rotational air damping per axis, N m per (rad/s)^2. */
  angularDrag: vec3,
  /** Collision box half extents, meters. */
  colliderHalfExtents: vec3,
})

export const CameraSpec = z.object({
  /** Camera position in body frame, meters. */
  position: vec3,
  /** Default uptilt, degrees. */
  uptilt: z.number(),
  /** Default horizontal field of view, degrees. */
  fov: z.number(),
})

export const PidAxis = z.object({ p: z.number(), i: z.number(), d: z.number(), f: z.number() })

export const RatesAxis = z.object({ a: z.number(), b: z.number(), expo: z.number() })

export const Rates = z.discriminatedUnion("type", [
  /** Actual: a = center sensitivity deg/s, b = max rate deg/s, expo 0..1. */
  z.object({ type: z.literal("actual"), roll: RatesAxis, pitch: RatesAxis, yaw: RatesAxis }),
  /** Betaflight: a = RC rate, b = super rate, expo 0..1. */
  z.object({ type: z.literal("betaflight"), roll: RatesAxis, pitch: RatesAxis, yaw: RatesAxis }),
  /** KISS: a = RC rate, b = rate, expo = RC curve. */
  z.object({ type: z.literal("kiss"), roll: RatesAxis, pitch: RatesAxis, yaw: RatesAxis }),
  /** Quick: a = center sensitivity deg/s, b = max rate deg/s, expo 0..1. */
  z.object({ type: z.literal("quick"), roll: RatesAxis, pitch: RatesAxis, yaw: RatesAxis }),
])
export type Rates = z.infer<typeof Rates>

export const FlightControllerSpec = z.object({
  pids: z.object({ roll: PidAxis, pitch: PidAxis, yaw: PidAxis }),
  rates: Rates,
  /** Motor idle as a fraction of full throttle (Betaflight dshot_idle_value / 100). */
  idle: z.number().min(0).max(0.2),
  airmode: z.boolean(),
  /** Gyro lowpass cutoff, Hz. */
  gyroLpfHz: z.number().positive(),
  /** D-term lowpass cutoff, Hz. */
  dtermLpfHz: z.number().positive(),
  /** RC smoothing cutoff for setpoints, Hz. */
  rcSmoothingHz: z.number().positive(),
  /** Throttle PID attenuation: fraction of PID reduction at full throttle, starting at breakpoint. */
  tpa: z.object({ rate: z.number().min(0).max(1), breakpoint: z.number().min(0).max(1) }),
})
export type FlightControllerSpec = z.infer<typeof FlightControllerSpec>

export const QuadSpec = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  frame: FrameSpec,
  motor: MotorSpec,
  prop: PropSpec,
  battery: BatterySpec,
  camera: CameraSpec,
  fc: FlightControllerSpec,
})
export type QuadSpec = z.infer<typeof QuadSpec>

export type MotorSpec = z.infer<typeof MotorSpec>
export type PropSpec = z.infer<typeof PropSpec>
export type BatterySpec = z.infer<typeof BatterySpec>
export type MotorMount = z.infer<typeof MotorMount>
export type FrameSpec = z.infer<typeof FrameSpec>
