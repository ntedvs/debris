import { Quaternion, Vector3 } from "three"
import { Battery } from "./battery"
import { ColoredNoise } from "./filters"
import { inducedVelocity, propAero } from "./prop"
import type { QuadSpec } from "./spec"

export type BodyState = {
  position: Vector3
  quaternion: Quaternion
  /** World frame linear velocity, m/s. */
  velocity: Vector3
  /** World frame angular velocity, rad/s. */
  angularVelocity: Vector3
}

export type Environment = {
  airDensity: number
  /** World frame wind velocity at the quad, m/s. */
  wind: Vector3
  /** Distance from origin along dir to the nearest surface, or null. Used for ground effect. */
  raycast: (origin: Vector3, dir: Vector3, maxDistance: number) => number | null
}

export type RotorTelemetry = { rpm: number; thrust: number; current: number; propwash: number }

const UP = new Vector3(0, 1, 0)

/**
 * Forces and torques of a multirotor: brushless motors on a sagging battery,
 * props with dynamic thrust, rotor drag, propwash / vortex ring state, ground
 * effect, body drag and gyroscopic coupling. Gravity and contacts are handled
 * by the rigid body engine.
 */
export class QuadDynamics {
  readonly battery: Battery
  readonly omega: Float64Array
  readonly rotors: RotorTelemetry[]
  readonly totalForce = new Vector3()
  readonly totalTorque = new Vector3()
  /** Disable to compare against a simplified model. */
  propwashEnabled = true
  groundEffectEnabled = true

  private readonly kt: number
  private readonly kvRad: number
  private readonly noise: ColoredNoise[]
  private readonly inertia: Vector3
  private readonly mounts: { pos: Vector3; spin: number }[]
  private readonly lastCurrent: Float64Array

  // scratch
  private qInv = new Quaternion()
  private vB = new Vector3()
  private wB = new Vector3()
  private tmp = new Vector3()
  private tmp2 = new Vector3()
  private fB = new Vector3()
  private tB = new Vector3()
  private rotorWorld = new Vector3()
  private downWorld = new Vector3()

  constructor(
    readonly spec: QuadSpec,
    dt: number,
    seed = 1,
  ) {
    const n = spec.frame.motors.length
    this.battery = new Battery(spec.battery)
    this.omega = new Float64Array(n)
    this.lastCurrent = new Float64Array(n)
    this.rotors = Array.from({ length: n }, () => ({ rpm: 0, thrust: 0, current: 0, propwash: 0 }))
    this.kvRad = (spec.motor.kv * 2 * Math.PI) / 60
    this.kt = 1 / this.kvRad
    this.noise = Array.from(
      { length: n },
      (_, i) => new ColoredNoise(14, dt, seed * 97 + i * 13 + 1),
    )
    this.inertia = new Vector3(...spec.frame.inertia)
    this.mounts = spec.frame.motors.map((m) => ({
      pos: new Vector3(...m.position),
      spin: m.spin === "ccw" ? 1 : -1,
    }))
  }

  reset() {
    this.omega.fill(0)
    this.lastCurrent.fill(0)
    this.battery.reset()
  }

  /**
   * Advance motor state by dt and compute the resulting world frame force and
   * torque about the center of mass (excluding gravity).
   * @param duty per-motor ESC duty 0..1
   * @param escActive false when disarmed: motors freewheel
   */
  step(
    duty: ArrayLike<number>,
    escActive: boolean,
    state: BodyState,
    env: Environment,
    dt: number,
  ) {
    const { spec, battery } = this
    const { motor, prop, frame } = spec
    const rho = env.airDensity
    const R = motor.resistance
    const radius = prop.diameter / 2

    this.qInv.copy(state.quaternion).invert()
    this.wB.copy(state.angularVelocity).applyQuaternion(this.qInv)
    this.fB.set(0, 0, 0)
    this.tB.set(0, 0, 0)

    // Bus voltage: solve V = Vs - R0 * sum(d * (d V - e) / R) for V, using the
    // previous step's clamped currents only where clamping applies.
    const vs = battery.sourceVoltage()
    const r0 = battery.ohmicResistance
    let a = 1
    let b = vs
    for (let i = 0; i < this.omega.length; i++) {
      if (!escActive) continue
      const d = duty[i] ?? 0
      const e = this.omega[i]! / this.kvRad
      const prev = this.lastCurrent[i]!
      if (Math.abs(prev) >= motor.currentLimit) {
        b -= r0 * d * prev
      } else {
        a += (r0 * d * d) / R
        b += (r0 * d * e) / R
      }
    }
    const vBus = Math.max(0, b / a)

    let batteryCurrent = 0
    let gyroH = 0 // total rotor angular momentum along body +Y

    for (let i = 0; i < this.omega.length; i++) {
      const m = this.mounts[i]!
      const w = this.omega[i]!

      // --- motor electrical + mechanical ---
      let current = 0
      if (escActive) {
        const d = Math.min(1, Math.max(0, duty[i] ?? 0))
        current = (d * vBus - w / this.kvRad) / R
        // Active braking (damped light) allows regen, limited by the ESC
        current = Math.min(motor.currentLimit, Math.max(-motor.currentLimit, current))
        batteryCurrent += d * current
      }
      this.lastCurrent[i] = current
      const friction = this.kt * motor.noLoadCurrent * Math.min(1, w / 50)
      const motorTorque = this.kt * current - friction

      // --- air velocity at the rotor, body frame ---
      this.rotorWorld.copy(m.pos).applyQuaternion(state.quaternion)
      this.tmp.copy(state.angularVelocity).cross(this.rotorWorld) // omega x r
      this.vB.copy(state.velocity).add(this.tmp).sub(env.wind).applyQuaternion(this.qInv)
      const vAxial = this.vB.y
      const vPlaneX = this.vB.x
      const vPlaneZ = this.vB.z
      const vPlane = Math.hypot(vPlaneX, vPlaneZ)

      let { thrust, torque } = propAero(prop, rho, w, vAxial)

      // --- propwash / vortex ring state ---
      let wash = 0
      if (this.propwashEnabled && thrust > 0) {
        const vh = inducedVelocity(prop, rho, thrust)
        if (vh > 0.5) {
          const descent = -vAxial / vh
          const mu = vPlane / vh
          if (descent > 0)
            wash = Math.exp(-(((descent - 1) / 0.55) ** 2)) * Math.exp(-((mu / 0.8) ** 2))
        }
      }
      const n = this.noise[i]!.next()
      if (wash > 0.001) {
        thrust *= (1 - 0.3 * wash) * (1 + 0.45 * wash * n)
        torque *= 1 + 0.3 * wash * n
      }

      // --- ground effect (Cheeseman-Bennett) ---
      if (this.groundEffectEnabled && thrust > 0) {
        this.downWorld.copy(UP).applyQuaternion(state.quaternion).negate()
        this.tmp2.copy(state.position).add(this.rotorWorld)
        const dist = env.raycast(this.tmp2, this.downWorld, radius * 4)
        if (dist !== null) {
          const z = Math.max(dist, radius * 0.6)
          thrust *= 1 / (1 - (radius / (4 * z)) ** 2)
        }
      }

      // --- integrate rotor speed ---
      const omegaNext = w + ((motorTorque - torque) / motor.rotorInertia) * dt
      this.omega[i] = Math.max(0, omegaNext)

      // --- forces on the body at the rotor hub ---
      const hx = -prop.hForce * w * vPlaneX
      const hz = -prop.hForce * w * vPlaneZ
      this.tmp.set(hx, thrust, hz)
      this.fB.add(this.tmp)
      this.tmp2.copy(m.pos).cross(this.tmp)
      this.tB.add(this.tmp2)
      // Reaction to the torque the motor applies to the rotor
      this.tB.y -= m.spin * motorTorque
      gyroH += m.spin * motor.rotorInertia * w

      const tel = this.rotors[i]!
      tel.rpm = (w * 60) / (2 * Math.PI)
      tel.thrust = thrust
      tel.current = current
      tel.propwash = wash
    }

    // Gyroscopic torque from spinning rotors: -omega x h
    this.tmp.set(0, gyroH, 0)
    this.tmp2.copy(this.wB).cross(this.tmp)
    this.tB.sub(this.tmp2)

    // Rigid body gyroscopic term -omega x (I omega). Rapier does not integrate it.
    this.tmp.copy(this.wB).multiply(this.inertia)
    this.tmp2.copy(this.wB).cross(this.tmp)
    this.tB.sub(this.tmp2)

    // Body drag, anisotropic quadratic
    this.vB.copy(state.velocity).sub(env.wind).applyQuaternion(this.qInv)
    const speed = this.vB.length()
    const [cx, cy, cz] = frame.dragArea
    this.fB.x -= 0.5 * rho * speed * cx * this.vB.x
    this.fB.y -= 0.5 * rho * speed * cy * this.vB.y
    this.fB.z -= 0.5 * rho * speed * cz * this.vB.z

    // Rotational damping
    const [ax, ay, az] = frame.angularDrag
    this.tB.x -= ax * this.wB.x * Math.abs(this.wB.x)
    this.tB.y -= ay * this.wB.y * Math.abs(this.wB.y)
    this.tB.z -= az * this.wB.z * Math.abs(this.wB.z)

    battery.update(batteryCurrent, vBus, dt)

    this.totalForce.copy(this.fB).applyQuaternion(state.quaternion)
    this.totalTorque.copy(this.tB).applyQuaternion(state.quaternion)
    return { force: this.totalForce, torque: this.totalTorque }
  }
}
