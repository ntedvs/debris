import { expect, test } from "bun:test"
import { Vector3 } from "three"
import { applyRates } from "./rates"
import { fiveInchFreestyle as spec } from "./quads/five-inch"
import { QUADS } from "./quads"
import { QuadSpec } from "./spec"
import { initPhysics, RAPIER, SimWorld, type PilotInput } from "./sim-world"

await initPhysics()

function makeSim() {
  const s = new SimWorld(spec, { rate: 1000, crashThreshold: 0 })
  s.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0))
  s.setSpawn({ position: new Vector3(0, 0, 0), yaw: 0 })
  s.reset()
  return s
}

function arm(s: SimWorld): PilotInput {
  const input: PilotInput = { throttle: 0, roll: 0, pitch: 0, yaw: 0, arm: false }
  s.step(input)
  input.arm = true
  s.step(input)
  expect(s.armed).toBe(true)
  return input
}

test("quad specs are valid", () => {
  for (const q of QUADS) QuadSpec.parse(q)
})

test("rates match Betaflight", () => {
  const a = { a: 70, b: 670, expo: 0 }
  expect(applyRates("actual", a, 1)).toBeCloseTo(670)
  expect(applyRates("actual", a, 0)).toBe(0)
  expect(applyRates("betaflight", { a: 1, b: 0.7, expo: 0 }, 1)).toBeCloseTo(666.67, 1)
  expect(applyRates("betaflight", { a: 1, b: 0, expo: 0 }, 0.5)).toBeCloseTo(100)
})

test("static thrust, current and spin-up are in the 5 inch ballpark", () => {
  const s = makeSim()
  s.body.setBodyType(RAPIER.RigidBodyType.Fixed, true)
  s.body.setTranslation({ x: 0, y: 20, z: 0 }, true)
  const input = arm(s)
  input.throttle = 1
  let t63 = 0
  for (let i = 0; i < 1500; i++) {
    s.step(input)
    if (!t63 && s.dynamics.rotors[0]!.rpm > 0.63 * 33000) t63 = i
  }
  const grams = (s.dynamics.rotors[0]!.thrust / 9.81) * 1000
  expect(grams).toBeGreaterThan(1400)
  expect(grams).toBeLessThan(2100)
  expect(s.telemetry().current).toBeGreaterThan(100)
  expect(s.telemetry().voltage).toBeLessThan(23)
  expect(t63).toBeGreaterThan(10)
  expect(t63).toBeLessThan(45)
})

test("roll step response is fast and well damped", () => {
  const s = makeSim()
  const input = arm(s)
  input.throttle = 0.35
  for (let i = 0; i < 300; i++) s.step(input)
  input.roll = 1
  let peak = 0
  for (let i = 0; i < 400; i++) {
    s.step(input)
    peak = Math.max(peak, s.fc.debug().gyro[0]!)
  }
  const final = s.fc.debug().gyro[0]!
  expect(Math.abs(final - 670)).toBeLessThan(20)
  expect(peak).toBeLessThan(670 * 1.1)
})

test("hover throttle is realistic", () => {
  const s = makeSim()
  s.body.setBodyType(RAPIER.RigidBodyType.Fixed, true)
  s.body.setTranslation({ x: 0, y: 20, z: 0 }, true)
  const input = arm(s)
  let lo = 0
  let hi = 1
  for (let k = 0; k < 14; k++) {
    input.throttle = (lo + hi) / 2
    for (let i = 0; i < 300; i++) s.step(input)
    const thrust = s.dynamics.rotors.reduce((a, r) => a + r.thrust, 0)
    if (thrust > spec.frame.mass * 9.81) hi = input.throttle
    else lo = input.throttle
  }
  expect(input.throttle).toBeGreaterThan(0.12)
  expect(input.throttle).toBeLessThan(0.35)
})
