import * as THREE from "three"
import { getGamepad, KeyboardInput, readGamepad, type FrameInput } from "./input/input"
import { buildMap, type BuiltMap } from "./map/builder"
import type { MapFile } from "./map/schema"
import { QuadModel } from "./render/quad-model"
import { SceneRenderer } from "./render/scene"
import { getQuad } from "./sim/quads"
import { initPhysics, RAPIER, SimWorld, type Telemetry } from "./sim/sim-world"
import type { QuadSpec } from "./sim/spec"
import { settings, type Settings, type ViewMode } from "./settings"

export type GameStatus = Telemetry & {
  input: FrameInput
  view: ViewMode
  noCrash: boolean
  fps: number
  mapName: string
}

const VIEWS: ViewMode[] = ["fpv", "chase", "los"]

export class Game {
  private renderer!: SceneRenderer
  private sim!: SimWorld
  private spec!: QuadSpec
  private model!: QuadModel
  private built: BuiltMap | null = null
  private fpvCam = new THREE.PerspectiveCamera(90, 1, 0.05, 4000)
  private camMount = new THREE.Group()
  private extCam = new THREE.PerspectiveCamera(60, 1, 0.05, 4000)
  private keyboard = new KeyboardInput()
  private spawnIndex = 0
  private acc = 0
  private last = 0
  private prevReset = false
  private statusTimer = 0
  private frames = 0
  private fpsTimer = 0
  private fps = 0
  private lastInput: FrameInput = {
    throttle: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    arm: false,
    reset: false,
    source: "none",
  }
  private raf = 0
  private chasePos = new THREE.Vector3()
  private graphics: Settings["graphics"] | null = null
  paused = false
  onStatus: ((s: GameStatus) => void) | null = null

  constructor(private canvas: HTMLCanvasElement) {}

  async init(map: MapFile) {
    await initPhysics()
    this.renderer = new SceneRenderer(this.canvas)
    this.graphics = settings.get().graphics
    this.renderer.setQuality(this.graphics)
    this.camMount.add(this.fpvCam)
    this.setQuad(getQuad(settings.get().quadId))
    this.loadMap(map)
    window.addEventListener("resize", this.resize)
    window.addEventListener("keydown", this.onKey)
    this.resize()
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    window.removeEventListener("resize", this.resize)
    window.removeEventListener("keydown", this.onKey)
    this.renderer.renderer.dispose()
  }

  private setQuad(spec: QuadSpec) {
    this.spec = spec
    if (this.model) this.renderer.scene.remove(this.model.root)
    this.model = new QuadModel(spec)
    this.model.root.add(this.camMount)
    this.camMount.position.set(...spec.camera.position)
    this.renderer.scene.add(this.model.root)
    this.renderer.track(this.model.root)
  }

  loadMap(map: MapFile) {
    const s = settings.get()
    if (this.built) {
      this.renderer.scene.remove(this.built.group)
      this.built.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose()
      })
      this.built.ground.mask.dispose()
      this.built.ground.height.dispose()
    }
    this.sim = new SimWorld(this.spec, {
      rate: s.physicsRate,
      crashThreshold: s.noCrash ? 0 : s.crashThreshold,
    })
    this.built = buildMap(map, RAPIER, this.sim.world)
    this.renderer.scene.add(this.built.group)
    this.renderer.setMap(this.built)
    this.renderer.applyEnvironment(map.environment)
    const wind = map.environment.wind
    if (wind) this.sim.wind = { speed: wind.speed, direction: wind.direction, gust: wind.gust }
    this.spawnIndex = 0
    this.applySettings(s)
    this.reset()
  }

  applySettings(s: Settings) {
    if (!this.sim) return
    if (s.quadId !== this.spec.id && this.built) {
      this.setQuad(getQuad(s.quadId))
      this.loadMap(this.built.map)
      return
    }
    this.sim.fc.setSpec({ ...this.spec.fc, rates: s.rates ?? this.spec.fc.rates })
    this.sim.options.crashThreshold = s.noCrash ? 0 : s.crashThreshold
    this.camMount.rotation.x = THREE.MathUtils.degToRad(s.camera.uptilt ?? this.spec.camera.uptilt)
    this.renderer.setShadows(s.shadows)
    if (s.graphics !== this.graphics) {
      this.graphics = s.graphics
      this.renderer.setQuality(s.graphics)
    }
    this.resize()
  }

  reset() {
    const spawns = this.built?.spawns ?? []
    const spawn = spawns[this.spawnIndex % Math.max(1, spawns.length)]
    if (spawn) this.sim.setSpawn(spawn)
    this.sim.reset()
    this.chasePos.set(0, 0, 0)
  }

  nextSpawn() {
    this.spawnIndex++
    this.reset()
  }

  cycleView() {
    const v = settings.get().view
    settings.set({ view: VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length]! })
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    if (e.code === "KeyR") this.reset()
    if (e.code === "KeyV") this.cycleView()
    if (e.code === "KeyN") this.nextSpawn()
  }

  private resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.resize(w, h)
    const aspect = w / h
    const hfov = THREE.MathUtils.degToRad(settings.get().camera.fov ?? this.spec.camera.fov)
    this.fpvCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect))
    this.fpvCam.aspect = aspect
    this.fpvCam.updateProjectionMatrix()
    this.extCam.aspect = aspect
    this.extCam.updateProjectionMatrix()
  }

  private readInput(dt: number): FrameInput {
    const s = settings.get()
    const gp = getGamepad(s.gamepadId)
    if (gp) return readGamepad(gp, s.mapping)
    return this.keyboard.read(dt)
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now

    const input = this.readInput(dt)
    this.lastInput = input
    if (input.reset && !this.prevReset) this.reset()
    this.prevReset = input.reset

    if (!this.paused) {
      this.acc += dt
      const step = this.sim.dt
      let n = 0
      while (this.acc >= step && n < 100) {
        this.sim.step(input)
        this.acc -= step
        n++
      }
      if (n === 100) this.acc = 0
    }

    const st = this.sim.state
    this.model.root.position.copy(st.position)
    this.model.root.quaternion.copy(st.quaternion)
    this.model.update(
      this.sim.dynamics.rotors.map((r) => r.rpm),
      dt,
    )

    const view = settings.get().view
    this.model.root.visible = view !== "fpv"
    let cam: THREE.PerspectiveCamera = this.fpvCam
    if (view === "chase") {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(st.quaternion)
      fwd.y = 0
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1)
      fwd.normalize()
      const desired = st.position
        .clone()
        .addScaledVector(fwd, -2.2)
        .add(new THREE.Vector3(0, 0.7, 0))
      if (this.chasePos.lengthSq() === 0) this.chasePos.copy(desired)
      this.chasePos.lerp(desired, 1 - Math.exp(-dt * 6))
      this.extCam.position.copy(this.chasePos)
      this.extCam.lookAt(st.position)
      cam = this.extCam
    } else if (view === "los") {
      const spawn = this.built?.spawns[this.spawnIndex % this.built.spawns.length]
      const p = spawn?.position ?? new THREE.Vector3()
      this.extCam.position.set(p.x + 2, p.y + 1.7, p.z + 3)
      this.extCam.lookAt(st.position)
      cam = this.extCam
    }
    // Downwash on the grass: total thrust relative to hover, only near the ground
    let thrust = 0
    for (const r of this.sim.dynamics.rotors) thrust += r.thrust
    const wash = Math.min(1.5, Math.max(0, thrust / (this.spec.frame.mass * 9.81)))
    this.renderer.update(dt, cam, st.position, wash)
    this.renderer.render(cam, dt)

    this.frames++
    this.fpsTimer += dt
    if (this.fpsTimer >= 0.5) {
      this.fps = this.frames / this.fpsTimer
      this.frames = 0
      this.fpsTimer = 0
    }
    this.statusTimer += dt
    if (this.statusTimer > 1 / 15 && this.onStatus) {
      this.statusTimer = 0
      this.onStatus({
        ...this.sim.telemetry(),
        input: this.lastInput,
        view,
        noCrash: settings.get().noCrash,
        fps: this.fps,
        mapName: this.built?.map.name ?? "",
      })
    }
  }
}
