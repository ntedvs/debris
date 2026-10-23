import { Vector3 } from "three"
import { Pt1, Pt3 } from "./filters"
import { applyRates } from "./rates"
import type { FlightControllerSpec, MotorMount } from "./spec"

/** Pilot command. Sticks are -1..1, throttle 0..1. */
export type RcCommand = {
  throttle: number
  /** +1 = roll right */
  roll: number
  /** +1 = stick forward (nose down) */
  pitch: number
  /** +1 = yaw right */
  yaw: number
}

// Betaflight PID scaling so the familiar numbers mean roughly the same thing.
const PTERM_SCALE = 0.032029
const ITERM_SCALE = 0.244381
const DTERM_SCALE = 0.000529
const FEEDFORWARD_SCALE = 0.013754
const PID_MIXER_SCALING = 1000
const PIDSUM_LIMIT = 500
const PIDSUM_LIMIT_YAW = 400
const ITERM_LIMIT = 400
const AIRMODE_START_THROTTLE = 0.25
const ITERM_RELAX_SETPOINT_THRESHOLD = 30
const ITERM_RELAX_CUTOFF = 15

type AxisName = "roll" | "pitch" | "yaw"
const AXES: AxisName[] = ["roll", "pitch", "yaw"]

class AxisState {
  iterm = 0
  prevGyro = 0
  prevSetpoint = 0
  gyroLpf: Pt1
  dLpf: Pt1
  rcSmooth: Pt3
  ffLpf: Pt1
  relaxLpf: Pt1
  setpoint = 0
  gyro = 0
  constructor(spec: FlightControllerSpec, dt: number) {
    this.gyroLpf = new Pt1(spec.gyroLpfHz, dt)
    this.dLpf = new Pt1(spec.dtermLpfHz, dt)
    this.rcSmooth = new Pt3(spec.rcSmoothingHz, dt)
    this.ffLpf = new Pt1(spec.rcSmoothingHz, dt)
    this.relaxLpf = new Pt1(ITERM_RELAX_CUTOFF, dt)
  }
  reset() {
    this.iterm = 0
    this.prevGyro = 0
    this.prevSetpoint = 0
    this.gyroLpf.reset()
    this.dLpf.reset()
    this.rcSmooth.reset()
    this.ffLpf.reset()
    this.relaxLpf.reset()
  }
}

/**
 * Betaflight style acro flight controller: rates, rate PID with feedforward,
 * TPA on D, airmode mixer. Mixer factors come from motor geometry so any
 * motor layout works.
 */
export class FlightController {
  spec: FlightControllerSpec
  readonly duty: Float64Array
  airmodeActive = false
  private axes: Record<AxisName, AxisState>
  private mix: { roll: number; pitch: number; yaw: number }[]
  private motorOut: Float64Array

  constructor(
    spec: FlightControllerSpec,
    motors: MotorMount[],
    private dt: number,
  ) {
    this.spec = spec
    this.axes = {
      roll: new AxisState(spec, dt),
      pitch: new AxisState(spec, dt),
      yaw: new AxisState(spec, dt),
    }
    this.duty = new Float64Array(motors.length)
    this.motorOut = new Float64Array(motors.length)
    this.mix = FlightController.buildMixer(motors)
  }

  /** Mixer factors per motor from geometry (body frame +X right, +Y up, -Z forward). */
  static buildMixer(motors: MotorMount[]) {
    const raw = motors.map((m) => ({
      roll: -m.position[0],
      pitch: -m.position[2],
      yaw: m.spin === "ccw" ? 1 : -1,
    }))
    const norm = (k: "roll" | "pitch" | "yaw") => Math.max(...raw.map((r) => Math.abs(r[k]))) || 1
    const nr = norm("roll")
    const np = norm("pitch")
    const ny = norm("yaw")
    return raw.map((r) => ({ roll: r.roll / nr, pitch: r.pitch / np, yaw: r.yaw / ny }))
  }

  setSpec(spec: FlightControllerSpec) {
    this.spec = spec
    for (const axis of AXES) {
      const s = this.axes[axis]
      s.gyroLpf.setCutoff(spec.gyroLpfHz, this.dt)
      s.dLpf.setCutoff(spec.dtermLpfHz, this.dt)
    }
  }

  reset() {
    this.airmodeActive = false
    for (const axis of AXES) this.axes[axis].reset()
    this.duty.fill(0)
  }

  /** Current setpoints and filtered gyro, deg/s, for OSD / blackbox style debugging. */
  debug() {
    return {
      setpoint: AXES.map((a) => this.axes[a].setpoint),
      gyro: AXES.map((a) => this.axes[a].gyro),
    }
  }

  /**
   * @param gyroBody body frame angular velocity, rad/s
   * @returns per-motor duty including idle. All zero when disarmed.
   */
  update(rc: RcCommand, gyroBody: Vector3, armed: boolean) {
    const { spec, dt } = this
    if (!armed) {
      this.reset()
      return this.duty
    }
    const throttle = Math.min(1, Math.max(0, rc.throttle))
    if (throttle > AIRMODE_START_THROTTLE) this.airmodeActive = true
    const airmode = spec.airmode && this.airmodeActive

    const toDeg = 180 / Math.PI
    const gyro = {
      roll: -gyroBody.z * toDeg,
      pitch: gyroBody.x * toDeg,
      yaw: -gyroBody.y * toDeg,
    }
    const stick = { roll: rc.roll, pitch: -rc.pitch, yaw: rc.yaw }
    const tpaRange = 1 - spec.tpa.breakpoint
    const tpa =
      1 -
      spec.tpa.rate * Math.min(1, Math.max(0, (throttle - spec.tpa.breakpoint) / (tpaRange || 1)))

    const out = { roll: 0, pitch: 0, yaw: 0 }
    for (const axis of AXES) {
      const s = this.axes[axis]
      const pid = spec.pids[axis]
      const target = applyRates(spec.rates.type, spec.rates[axis], stick[axis])
      const setpoint = s.rcSmooth.apply(target)
      const g = s.gyroLpf.apply(gyro[axis])
      s.setpoint = setpoint
      s.gyro = g

      const error = setpoint - g
      const p = pid.p * PTERM_SCALE * error

      // I-term relax (roll/pitch): don't wind up while the setpoint is moving fast
      const setpointHpf = Math.abs(setpoint - s.relaxLpf.apply(setpoint))
      const relax =
        axis === "yaw" ? 1 : Math.max(0, 1 - setpointHpf / ITERM_RELAX_SETPOINT_THRESHOLD)
      if (airmode || throttle > 0.05) {
        s.iterm += pid.i * ITERM_SCALE * error * relax * dt
        s.iterm = Math.min(ITERM_LIMIT, Math.max(-ITERM_LIMIT, s.iterm))
      } else {
        s.iterm = 0
      }

      const dGyro = s.dLpf.apply((g - s.prevGyro) / dt)
      s.prevGyro = g
      const d = -pid.d * DTERM_SCALE * dGyro * tpa

      const ff = s.ffLpf.apply(
        ((pid.f / 100) * FEEDFORWARD_SCALE * (setpoint - s.prevSetpoint)) / dt,
      )
      s.prevSetpoint = setpoint

      const limit = axis === "yaw" ? PIDSUM_LIMIT_YAW : PIDSUM_LIMIT
      const sum = Math.min(limit, Math.max(-limit, p + s.iterm + d + ff))
      out[axis] = sum / PID_MIXER_SCALING
    }

    // Mixer
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < this.mix.length; i++) {
      const f = this.mix[i]!
      const v = out.roll * f.roll + out.pitch * f.pitch + out.yaw * f.yaw
      this.motorOut[i] = v
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    const range = max - min
    const scale = range > 1 ? 1 / range : 1
    let thr = throttle
    if (airmode) {
      // Keep the full correction by shifting throttle within the available headroom
      thr = Math.min(1 - max * scale, Math.max(-min * scale, throttle))
    }
    const idle = spec.idle
    for (let i = 0; i < this.motorOut.length; i++) {
      const m = Math.min(1, Math.max(0, thr + this.motorOut[i]! * scale))
      this.duty[i] = idle + (1 - idle) * m
    }
    return this.duty
  }
}
