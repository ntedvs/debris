import RAPIER from "@dimforge/rapier3d-compat"
import { Euler, Quaternion, Vector3 } from "three"
import { ColoredNoise } from "./filters"
import { FlightController, type RcCommand } from "./flight-controller"
import { QuadDynamics, type BodyState, type Environment } from "./quad-dynamics"
import type { QuadSpec } from "./spec"

export { RAPIER }

let rapierReady: Promise<void> | null = null
export function initPhysics() {
  rapierReady ??= RAPIER.init()
  return rapierReady
}

export type PilotInput = RcCommand & { arm: boolean }

export type Spawn = { position: Vector3; yaw: number }

export type WindSettings = { speed: number; direction: number; gust: number }

export type SimOptions = {
  /** Physics and flight controller rate, Hz. */
  rate: number
  /** Impact velocity change that counts as a crash, m/s. 0 disables. */
  crashThreshold: number
}

export type Telemetry = {
  armed: boolean
  armBlocked: string | null
  crashed: boolean
  voltage: number
  cellVoltage: number
  current: number
  mahUsed: number
  throttle: number
  speed: number
  altitude: number
  flightTime: number
  rpm: number[]
  propwash: number
}

const GRAVITY = 9.81

export class SimWorld {
  readonly world: RAPIER.World
  readonly body: RAPIER.RigidBody
  readonly dt: number
  dynamics: QuadDynamics
  fc: FlightController
  spec: QuadSpec
  options: SimOptions
  wind: WindSettings = { speed: 0, direction: 0, gust: 0 }
  airDensity = 1.225

  armed = false
  crashed = false
  armBlocked: string | null = null
  flightTime = 0
  lastImpact = 0

  readonly state: BodyState = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
  }

  private spawn: Spawn = { position: new Vector3(0, 0.1, 0), yaw: 0 }
  private prevArmSwitch = false
  private lastThrottle = 0
  private gustNoise: ColoredNoise[]
  private env: Environment
  private windVec = new Vector3()
  private gyroBody = new Vector3()
  private qInv = new Quaternion()
  private vPrev = new Vector3()
  private predicted = new Vector3()
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })

  constructor(spec: QuadSpec, options: SimOptions) {
    this.spec = spec
    this.options = options
    this.dt = 1 / options.rate
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 })
    this.world.timestep = this.dt

    const [ix, iy, iz] = spec.frame.inertia
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setAdditionalMassProperties(
        spec.frame.mass,
        { x: 0, y: 0, z: 0 },
        { x: ix, y: iy, z: iz },
        { x: 0, y: 0, z: 0, w: 1 },
      )
    this.body = this.world.createRigidBody(desc)
    const [hx, hy, hz] = spec.frame.colliderHalfExtents
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setDensity(0).setFriction(0.6).setRestitution(0.15),
      this.body,
    )

    this.dynamics = new QuadDynamics(spec, this.dt)
    this.fc = new FlightController(spec.fc, spec.frame.motors, this.dt)
    this.gustNoise = [0, 1, 2].map((i) => new ColoredNoise(0.4, this.dt, 1000 + i))

    this.env = {
      airDensity: this.airDensity,
      wind: this.windVec,
      raycast: (origin, dir, maxDistance) => {
        this.ray.origin = origin
        this.ray.dir = dir
        const hit = this.world.castRay(
          this.ray,
          maxDistance,
          true,
          undefined,
          undefined,
          undefined,
          this.body,
        )
        return hit ? hit.timeOfImpact : null
      },
    }
  }

  setSpawn(spawn: Spawn) {
    this.spawn = spawn
  }

  /** Put the quad back on the spawn point, recharge the battery, disarm. */
  reset() {
    const p = this.spawn.position
    const q = new Quaternion().setFromEuler(new Euler(0, this.spawn.yaw, 0))
    this.body.setTranslation(
      { x: p.x, y: p.y + this.spec.frame.colliderHalfExtents[1] + 0.01, z: p.z },
      true,
    )
    this.body.setRotation(q, true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.dynamics.reset()
    this.fc.reset()
    this.armed = false
    this.crashed = false
    this.armBlocked = null
    this.flightTime = 0
    this.readState()
  }

  private readState() {
    const t = this.body.translation()
    const r = this.body.rotation()
    const v = this.body.linvel()
    const w = this.body.angvel()
    this.state.position.set(t.x, t.y, t.z)
    this.state.quaternion.set(r.x, r.y, r.z, r.w)
    this.state.velocity.set(v.x, v.y, v.z)
    this.state.angularVelocity.set(w.x, w.y, w.z)
  }

  private updateArming(input: PilotInput) {
    const rising = input.arm && !this.prevArmSwitch
    this.prevArmSwitch = input.arm
    if (!input.arm) {
      this.armed = false
      this.armBlocked = null
      if (this.crashed) this.crashed = false
      return
    }
    if (rising) {
      if (this.crashed) this.armBlocked = "CRASHED"
      else if (input.throttle > 0.05) this.armBlocked = "THROTTLE"
      else {
        this.armed = true
        this.armBlocked = null
      }
    }
  }

  private updateWind() {
    const { speed, direction, gust } = this.wind
    // direction: where the wind comes from, degrees, 0 = from -Z (north), 90 = from +X (east)
    const a = (direction * Math.PI) / 180
    const gx = this.gustNoise[0]!.next()
    const gy = this.gustNoise[1]!.next()
    const gz = this.gustNoise[2]!.next()
    const g = speed * gust
    this.windVec.set(-Math.sin(a) * speed + gx * g, gy * g * 0.3, Math.cos(a) * speed + gz * g)
  }

  step(input: PilotInput) {
    this.updateArming(input)
    this.readState()
    this.updateWind()
    this.env.airDensity = this.airDensity

    this.qInv.copy(this.state.quaternion).invert()
    this.gyroBody.copy(this.state.angularVelocity).applyQuaternion(this.qInv)
    const duty = this.fc.update(input, this.gyroBody, this.armed)
    const { force, torque } = this.dynamics.step(duty, this.armed, this.state, this.env, this.dt)

    this.body.resetForces(false)
    this.body.resetTorques(false)
    this.body.addForce(force, true)
    this.body.addTorque(torque, true)

    this.vPrev.copy(this.state.velocity)
    this.predicted
      .copy(force)
      .multiplyScalar(this.dt / this.spec.frame.mass)
      .add(this.vPrev)
    this.predicted.y -= GRAVITY * this.dt

    this.world.step()

    const v = this.body.linvel()
    const impact = Math.hypot(
      v.x - this.predicted.x,
      v.y - this.predicted.y,
      v.z - this.predicted.z,
    )
    this.lastImpact = impact
    if (this.armed && this.options.crashThreshold > 0 && impact > this.options.crashThreshold) {
      this.crashed = true
      this.armed = false
    }
    if (this.armed) this.flightTime += this.dt
    this.lastThrottle = input.throttle
  }

  telemetry(): Telemetry {
    const b = this.dynamics.battery
    return {
      armed: this.armed,
      armBlocked: this.armBlocked,
      crashed: this.crashed,
      voltage: b.voltage,
      cellVoltage: b.voltage / b.spec.cells,
      current: b.current,
      mahUsed: b.usedMah,
      throttle: this.lastThrottle,
      speed: this.state.velocity.length(),
      altitude: this.state.position.y,
      flightTime: this.flightTime,
      rpm: this.dynamics.rotors.map((r) => r.rpm),
      propwash: Math.max(...this.dynamics.rotors.map((r) => r.propwash)),
    }
  }
}
