import * as THREE from "three"
import type { QuadSpec } from "../sim/spec"
import { solidMaterial } from "./materials"

/** Visual model generated from the spec, so new quad types get a model for free. */
export class QuadModel {
  readonly root = new THREE.Group()
  private props: { blades: THREE.Group; disc: THREE.Mesh; angle: number; spin: number }[] = []

  constructor(spec: QuadSpec) {
    const carbon = solidMaterial("#1a1a1c", 0.45, 0.2)
    const alu = solidMaterial("#8b1e2b", 0.35, 0.8)
    const motorMat = solidMaterial("#26262a", 0.35, 0.7)
    const propMat = new THREE.MeshStandardMaterial({
      color: "#d9472b",
      roughness: 0.5,
      transparent: true,
      opacity: 0.95,
    })
    const discMat = new THREE.MeshBasicMaterial({
      color: "#d9472b",
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    const add = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      pos: THREE.Vector3Like,
      parent: THREE.Object3D = this.root,
    ) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.copy(pos)
      m.castShadow = true
      parent.add(m)
      return m
    }

    const radius = spec.prop.diameter / 2
    for (const mount of spec.frame.motors) {
      const [x, y, z] = mount.position
      const len = Math.hypot(x, z)
      const arm = add(new THREE.BoxGeometry(0.02, 0.005, len + 0.02), carbon, {
        x: x / 2,
        y: -0.008,
        z: z / 2,
      })
      arm.rotation.y = Math.atan2(x, z)
      add(new THREE.CylinderGeometry(0.014, 0.014, 0.018, 20), motorMat, { x, y: y - 0.004, z })

      const hub = new THREE.Group()
      hub.position.set(x, y + 0.008, z)
      this.root.add(hub)
      const blades = new THREE.Group()
      hub.add(blades)
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.002, radius * 0.95), propMat)
        blade.position.z = radius * 0.48
        const holder = new THREE.Group()
        holder.rotation.y = (b * 2 * Math.PI) / 3
        blade.rotation.z = mount.spin === "cw" ? 0.25 : -0.25
        holder.add(blade)
        blades.add(holder)
      }
      const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), discMat)
      disc.rotation.x = -Math.PI / 2
      hub.add(disc)
      this.props.push({
        blades,
        disc,
        angle: Math.random() * 6,
        spin: mount.spin === "cw" ? -1 : 1,
      })
    }

    // Body: plates, stack, battery, camera
    add(new THREE.BoxGeometry(0.04, 0.003, 0.11), carbon, { x: 0, y: -0.004, z: 0 })
    add(new THREE.BoxGeometry(0.036, 0.003, 0.09), carbon, { x: 0, y: 0.026, z: 0 })
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      add(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 8), alu, {
        x: sx * 0.016,
        y: 0.011,
        z: sz * 0.04,
      })
    }
    add(new THREE.BoxGeometry(0.032, 0.012, 0.035), solidMaterial("#1f5f2f", 0.6), {
      x: 0,
      y: 0.008,
      z: 0.01,
    })
    const battery = add(new THREE.BoxGeometry(0.036, 0.034, 0.075), solidMaterial("#202022", 0.7), {
      x: 0,
      y: 0.045,
      z: 0.005,
    })
    add(
      new THREE.BoxGeometry(0.037, 0.012, 0.05),
      solidMaterial("#e0b318", 0.6),
      { x: 0, y: 0, z: 0 },
      battery,
    )
    add(
      new THREE.BoxGeometry(0.04, 0.036, 0.008),
      solidMaterial("#111111", 0.4),
      { x: 0, y: 0.005, z: 0.0 },
      battery,
    )
    const cam = add(new THREE.BoxGeometry(0.02, 0.02, 0.02), solidMaterial("#333336", 0.5), {
      x: 0,
      y: 0.012,
      z: -0.045,
    })
    cam.rotation.x = THREE.MathUtils.degToRad(spec.camera.uptilt)
    add(
      new THREE.CylinderGeometry(0.007, 0.007, 0.008, 16),
      solidMaterial("#0a0a12", 0.1, 0.5),
      { x: 0, y: 0, z: -0.012 },
      cam,
    ).rotation.x = Math.PI / 2
  }

  /** Rotate props, swap to blur discs at speed. */
  update(rpm: number[], dt: number) {
    this.props.forEach((p, i) => {
      const w = ((rpm[i] ?? 0) * 2 * Math.PI) / 60
      const fast = w > 250
      p.blades.visible = !fast
      p.disc.visible = w > 120
      ;(p.disc.material as THREE.MeshBasicMaterial).opacity = Math.min(0.28, 0.08 + w / 15000)
      p.angle += p.spin * Math.min(w, 60) * dt
      p.blades.rotation.y = p.angle
    })
  }
}
