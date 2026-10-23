import type { PilotInput } from "../sim/sim-world"

export type AxisBinding = {
  index: number
  invert: boolean
  min: number
  center: number
  max: number
}
export type SwitchBinding = { kind: "axis" | "button"; index: number; invert: boolean }

export type InputMapping = {
  throttle: AxisBinding
  roll: AxisBinding
  pitch: AxisBinding
  yaw: AxisBinding
  arm: SwitchBinding
  reset: SwitchBinding | null
  deadband: number
}

export type StickName = "throttle" | "roll" | "pitch" | "yaw"

const axis = (index: number, invert = false): AxisBinding => ({
  index,
  invert,
  min: -1,
  center: 0,
  max: 1,
})

/** EdgeTX classic USB joystick, AETR channel order: CH1 Ail, CH2 Ele, CH3 Thr, CH4 Rud, CH5 arm. */
export const DEFAULT_MAPPING: InputMapping = {
  roll: axis(0),
  pitch: axis(1),
  throttle: axis(2),
  yaw: axis(3),
  arm: { kind: "axis", index: 4, invert: false },
  reset: null,
  deadband: 0.01,
}

export type FrameInput = PilotInput & { reset: boolean; source: "gamepad" | "keyboard" | "none" }

function normStick(raw: number, b: AxisBinding, deadband: number) {
  let v =
    raw >= b.center
      ? (raw - b.center) / (b.max - b.center || 1)
      : (raw - b.center) / (b.center - b.min || 1)
  v = Math.min(1, Math.max(-1, v))
  if (b.invert) v = -v
  if (Math.abs(v) < deadband) return 0
  return (v - Math.sign(v) * deadband) / (1 - deadband)
}

function normThrottle(raw: number, b: AxisBinding) {
  let v = (raw - b.min) / (b.max - b.min || 1)
  v = Math.min(1, Math.max(0, v))
  return b.invert ? 1 - v : v
}

function readSwitch(gp: Gamepad, s: SwitchBinding) {
  const on = s.kind === "axis" ? (gp.axes[s.index] ?? -1) > 0.25 : !!gp.buttons[s.index]?.pressed
  return s.invert ? !on : on
}

export function getGamepad(preferredId?: string | null): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? []
  let first: Gamepad | null = null
  for (const gp of pads) {
    if (!gp) continue
    if (preferredId && gp.id === preferredId) return gp
    first ??= gp
  }
  return first
}

export function readGamepad(gp: Gamepad, m: InputMapping): FrameInput {
  const a = (b: AxisBinding) => gp.axes[b.index] ?? b.center
  return {
    throttle: normThrottle(a(m.throttle), m.throttle),
    roll: normStick(a(m.roll), m.roll, m.deadband),
    pitch: normStick(a(m.pitch), m.pitch, m.deadband),
    yaw: normStick(a(m.yaw), m.yaw, m.deadband),
    arm: readSwitch(gp, m.arm),
    reset: m.reset ? readSwitch(gp, m.reset) : false,
    source: "gamepad",
  }
}

/**
 * Keyboard fallback for testing without a radio. Not meant for real flying.
 * W/S throttle, A/D yaw, arrows pitch/roll, Space toggles arm.
 */
export class KeyboardInput {
  private keys = new Set<string>()
  private throttle = 0
  private armed = false
  used = false

  constructor() {
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      this.keys.add(e.code)
      if (
        [
          "KeyW",
          "KeyS",
          "KeyA",
          "KeyD",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Space",
        ].includes(e.code)
      ) {
        this.used = true
      }
      if (e.code === "Space") {
        this.armed = !this.armed
        e.preventDefault()
      }
    })
    window.addEventListener("keyup", (e) => this.keys.delete(e.code))
    window.addEventListener("blur", () => this.keys.clear())
  }

  read(dt: number): FrameInput {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0)
    this.throttle = Math.min(1, Math.max(0, this.throttle + (k("KeyW") - k("KeyS")) * dt * 0.8))
    return {
      throttle: this.throttle,
      roll: (k("ArrowRight") - k("ArrowLeft")) * 0.6,
      pitch: (k("ArrowUp") - k("ArrowDown")) * 0.6,
      yaw: (k("KeyD") - k("KeyA")) * 0.6,
      arm: this.armed,
      reset: false,
      source: "keyboard",
    }
  }
}
