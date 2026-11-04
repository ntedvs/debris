import { Matrix4, Quaternion, Vector3 } from "three"
import type { FrameInput } from "../src/input/input"
import { applyRates } from "../src/sim/rates"
import type { SimWorld } from "../src/sim/sim-world"

export type Waypoint = { position: [number, number, number]; speed: number }

const G = 9.81
const MAX_TILT = (40 * Math.PI) / 180
const UP = new Vector3(0, 1, 0)

/**
 * Deterministic pilot for benchmarks: flies the quad through waypoints using
 * the same stick inputs a human would (acro rates, throttle), so the real
 * flight controller and physics run every step.
 */
export class Autopilot {
  index = 0
  done = false
  private t = 0
  private altI = 0
  private hover = 0.25
  private v = new Vector3()
  private p = new Vector3()
  private target = new Vector3()
  private aDes = new Vector3()
  private vDes = new Vector3()
  private fwd = new Vector3()
  private qDes = new Quaternion()
  private qErr = new Quaternion()
  private qInv = new Quaternion()
  private basis = new Matrix4()

  constructor(
    private sim: SimWorld,
    readonly route: Waypoint[],
  ) {}

  /** Inverse of the quad's rate curve: deg/s to stick deflection. */
  private stick(axis: "roll" | "pitch" | "yaw", dps: number) {
    const r = this.sim.fc.spec.rates
    let lo = -1
    let hi = 1
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (applyRates(r.type, r[axis], mid) < dps) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  next(dt: number): FrameInput {
    this.t += dt
    const input: FrameInput = {
      throttle: 0,
      roll: 0,
      pitch: 0,
      yaw: 0,
      arm: this.t > 0.1,
      reset: false,
      source: "none",
    }
    if (this.t < 0.3 || this.done) return input

    const st = this.sim.state
    this.p.copy(st.position)
    this.v.copy(st.velocity)
    const wp = this.route[this.index]!
    this.target.fromArray(wp.position)
    if (this.p.distanceTo(this.target) < 4) {
      this.index++
      if (this.index >= this.route.length) {
        this.done = true
        return input
      }
      return this.next(0)
    }

    // Velocity toward the waypoint, then the acceleration to get there
    this.vDes.subVectors(this.target, this.p)
    const dy = this.vDes.y
    this.vDes.y = 0
    const horiz = this.vDes.length()
    this.vDes.setLength(Math.min(wp.speed, horiz * 0.8))
    this.vDes.y = Math.max(-4, Math.min(6, dy * 1.2))
    this.aDes.subVectors(this.vDes, this.v).multiplyScalar(2)
    this.aDes.y = this.aDes.y + G
    this.altI = Math.max(-0.1, Math.min(0.1, this.altI + (this.vDes.y - this.v.y) * 0.02 * dt))
    // Clamp tilt
    const h = Math.hypot(this.aDes.x, this.aDes.z)
    const maxH = Math.max(0.5, this.aDes.y) * Math.tan(MAX_TILT)
    if (h > maxH) {
      this.aDes.x *= maxH / h
      this.aDes.z *= maxH / h
    }
    this.aDes.y = Math.max(2, this.aDes.y)
    const thrust = this.aDes.length()

    // Desired attitude: body up along thrust, nose toward the waypoint
    const up = this.aDes.clone().normalize()
    this.fwd.subVectors(this.target, this.p)
    this.fwd.y = 0
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1)
    this.fwd.normalize()
    const right = new Vector3().crossVectors(this.fwd, up).normalize()
    const fwd = new Vector3().crossVectors(up, right)
    // Body axes: +X right, +Y up, -Z forward
    this.qDes.setFromRotationMatrix(this.basis.makeBasis(right, up, fwd.negate()))

    this.qInv.copy(st.quaternion).invert()
    this.qErr.multiplyQuaternions(this.qInv, this.qDes)
    if (this.qErr.w < 0) this.qErr.set(-this.qErr.x, -this.qErr.y, -this.qErr.z, -this.qErr.w)
    // Small angle: rotation vector ~ 2 * xyz. Body rates, rad/s
    const k = 2 * 8
    const wx = this.qErr.x * k
    const wy = this.qErr.y * k * 0.6
    const wz = this.qErr.z * k
    const deg = 180 / Math.PI
    input.roll = this.stick("roll", -wz * deg)
    input.pitch = -this.stick("pitch", wx * deg)
    input.yaw = this.stick("yaw", -wy * deg)

    // Thrust along the current body up only counts by its vertical share
    const bodyUp = UP.clone().applyQuaternion(st.quaternion)
    const align = Math.max(0.3, bodyUp.dot(up))
    input.throttle = Math.min(
      1,
      Math.max(0.06, this.hover * Math.sqrt(thrust / G / align) + this.altI),
    )
    return input
  }
}
