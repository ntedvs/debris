import * as THREE from "three"

/**
 * Cached cascaded shadows for a static sun.
 *
 * Each cascade is a square in light space centered on the camera (not fitted
 * to the view frustum), snapped to a coarse grid. Camera rotation never
 * invalidates a cascade, and translation only does once the camera crosses a
 * grid step, so most frames render no shadow map at all. At most one cascade
 * re-renders per frame, nearest first.
 *
 * Only cascade 0's light is used for direct lighting; the shader (see
 * shading.ts) picks one cascade per fragment for the shadow term.
 */
export class CascadedShadows {
  readonly lights: THREE.DirectionalLight[] = []
  private centers: THREE.Vector3[] = []
  private steps: number[] = []
  private dirty: boolean[] = []
  private orient = new THREE.Matrix4()
  private orientInv = new THREE.Matrix4()
  private tmp = new THREE.Vector3()
  private snap = new THREE.Vector3()
  private sunDir = new THREE.Vector3(0, 1, 0)
  /** Distance the light sits up-sun from the cascade center, meters. Covers tall occluders. */
  private lift = 300

  constructor(
    private parent: THREE.Object3D,
    /** Coverage radius of each cascade around the camera, meters. */
    readonly radii: number[],
    readonly mapSize: number,
  ) {
    for (const r of radii) {
      const light = new THREE.DirectionalLight(0xffffff, 0)
      light.castShadow = true
      light.shadow.mapSize.set(mapSize, mapSize)
      light.shadow.autoUpdate = false
      light.shadow.bias = -0.00015
      // Grid step: a camera move of this much re-renders the cascade. A whole
      // number of texels, so re-rendered maps line up and edges don't swim.
      const n = Math.round(mapSize / 12)
      const texel = (2 * r) / (mapSize - 2 * n)
      const step = n * texel
      const half = (mapSize / 2) * texel
      const cam = light.shadow.camera
      cam.left = cam.bottom = -half
      cam.right = cam.top = half
      cam.near = 1
      cam.far = this.lift + r * 2 + 50
      cam.updateProjectionMatrix()
      // Normal offset scaled to texel size kills acne without peter panning
      light.shadow.normalBias = ((2 * half) / mapSize) * 1.5
      parent.add(light, light.target)
      this.lights.push(light)
      this.centers.push(new THREE.Vector3(Infinity, 0, 0))
      this.steps.push(step)
      this.dirty.push(true)
    }
  }

  setSun(dir: THREE.Vector3, color: THREE.Color, intensity: number) {
    this.sunDir.copy(dir).normalize()
    this.orient.lookAt(new THREE.Vector3(), this.sunDir, new THREE.Vector3(0, 1, 0))
    this.orientInv.copy(this.orient).invert()
    this.lights.forEach((l, i) => {
      l.color.copy(color)
      // Only the first light shades; the rest just carry shadow maps
      l.intensity = i === 0 ? intensity : 0
    })
    this.invalidate()
  }

  /** Re-render every cascade, e.g. after the scene changed. */
  invalidate() {
    this.dirty.fill(true)
  }

  /** Pick at most one cascade to re-render this frame and place its light. */
  update(camera: THREE.Vector3) {
    // Camera in light space: x, y across the sun, z along it
    const ls = this.tmp.copy(camera).applyMatrix4(this.orientInv)
    // Invalidated cascades all render now (their maps may not exist yet);
    // otherwise only the nearest one that moved
    const all = this.dirty.some((d) => d)
    let moved = false
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i]!
      l.shadow.needsUpdate = false
      const s = this.steps[i]!
      const c = this.snap.set(
        Math.round(ls.x / s) * s,
        Math.round(ls.y / s) * s,
        Math.round(ls.z / s) * s,
      )
      const go = all ? this.dirty[i] : !moved && !c.equals(this.centers[i]!)
      if (!go) continue
      moved = true
      this.centers[i]!.copy(c)
      this.dirty[i] = false
      // Light space -> world; the light sits up-sun of the center
      const center = c.applyMatrix4(this.orient)
      l.target.position.copy(center)
      l.position.copy(center).addScaledVector(this.sunDir, this.lift)
      l.updateMatrixWorld()
      l.target.updateMatrixWorld()
      l.shadow.needsUpdate = true
    }
  }

  dispose() {
    for (const l of this.lights) {
      this.parent.remove(l, l.target)
      l.shadow.map?.dispose()
      l.dispose()
    }
  }
}
