/**
 * Ablation profiler page, driven by bench/profile-run.ts.
 *
 * GPU timer queries aren't usable on ANGLE Metal (they report several times
 * the real frame time), so costs are measured by switching features off and
 * comparing wall frame times. Two modes:
 *
 * - fly (default): the autopilot flies the bench route through the real sim,
 *   like `bun bench`. This is the one to trust for timings: motion blur,
 *   shadow cascade updates and LOD swaps only happen in motion.
 * - poses: renders fixed poses from the route a few times each. Use it for
 *   A/B screenshots (`shots` are pose indices there, frame indices in fly).
 */
import * as THREE from "three"
import { Sky } from "three/examples/jsm/objects/Sky.js"
import { Game } from "../src/game"
import type { FrameInput } from "../src/input/input"
import { buildMap } from "../src/map/builder"
import { BUILTIN_MAPS } from "../src/map/maps"
import type { GraphicsQuality } from "../src/render/scene"
import { getQuad } from "../src/sim/quads"
import { initPhysics, RAPIER, SimWorld } from "../src/sim/sim-world"
import { settings, type ViewMode } from "../src/settings"
import { Autopilot } from "./autopilot"
import { ROUTES } from "./routes"

const DT = 1 / 60
type Bench = { done: boolean; progress: string; error?: string; result?: unknown }
const bench: Bench = { done: false, progress: "starting" }
;(window as unknown as { __bench: Bench }).__bench = bench

const params = new URLSearchParams(location.search)
const mapId = params.get("map") ?? "field"
const quality = (params.get("quality") ?? "medium") as GraphicsQuality
const configs = (params.get("configs") ?? "base").split(";")
const mode = params.get("mode") ?? "fly"
const stride = Number(params.get("stride") ?? 90)
const reps = Number(params.get("reps") ?? 8)
const shots = (params.get("shots") ?? "").split(",").filter(Boolean).map(Number)

const map = BUILTIN_MAPS.find((m) => m.id === mapId)!.map
const route = ROUTES[mapId]!
settings.set({
  view: (params.get("view") ?? "fpv") as ViewMode,
  cameraEffects: true,
  shadows: true,
  noCrash: true,
  physicsRate: 1000,
})
const raf = () => new Promise<number>((r) => requestAnimationFrame(r))
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)

type Pose = { p: THREE.Vector3; q: THREE.Quaternion }
function recordPoses(): Pose[] {
  const sim = new SimWorld(getQuad(settings.get().quadId), { rate: 1000, crashThreshold: 0 })
  const built = buildMap(map, RAPIER, sim.world)
  const wind = map.environment.wind
  if (wind) sim.wind = { speed: wind.speed, direction: wind.direction, gust: wind.gust }
  sim.setSpawn(built.spawns[0]!)
  sim.reset()
  const ap = new Autopilot(sim, route)
  const poses: Pose[] = []
  let acc = 0
  for (let f = 0; f < 60 * 180 && !ap.done; f++) {
    const input = ap.next(DT)
    acc += DT
    while (acc >= sim.dt) {
      sim.step(input)
      acc -= sim.dt
    }
    if (f % stride === 0)
      poses.push({ p: sim.state.position.clone(), q: sim.state.quaternion.clone() })
  }
  sim.world.free()
  return poses
}

/** Feature switches. Configs are comma lists of these, "base" is none. */
function applyToggles(game: Game, toggles: string[]) {
  const r = game.renderer as any
  const built = (game as any).built
  const hide = (test: (key: string, o: any) => boolean) =>
    built.group.traverse((o: any) => {
      if (o.material && test(o.material.customProgramCacheKey?.() ?? "", o)) o.visible = false
    })
  for (const t of toggles) {
    const [k, v] = t.split("=")
    if (k === "noao") {
      r.ao.enabled = false
      r.taa.setAO(null)
    } else if (k === "noshadow") r.setShadows(false)
    else if (k === "nograss") r.grass && (r.grass.group.visible = false)
    else if (k === "nosky") {
      r.sky.mesh.visible = false
      r.sky.update = () => {}
    } else if (k === "directsky") {
      // The real sky shader every frame instead of the cube map cache
      const sky = new Sky()
      sky.scale.setScalar(45000)
      ;(sky.material as THREE.ShaderMaterial).uniforms = {
        ...r.sky.uniforms,
        showSunDisc: { value: 1 },
      }
      r.scene.add(sky)
      r.sky.mesh.visible = false
    } else if (k === "noveg") hide((key) => key === "debris:leaf" || key === "debris:bark")
    else if (k === "noleaves") hide((key) => key === "debris:leaf")
    else if (k === "noterrain") hide((key) => key.startsWith("debris:terrain"))
    else if (k === "noobjects") hide((key, o) => o.isMesh && key === "debris:")
    else if (k === "nofog") r.scene.fog = null
    else if (k === "noenv") r.scene.environment = null
    else if (k === "notaa") r.taa.blend = 1
    else if (k === "taabilinear") {
      const m = r.taa.mat
      m.defines = { ...m.defines, HISTORY_BILINEAR: "" }
      m.needsUpdate = true
    } else if (k === "nobloom") {
      const fx = r.cameraFx
      fx.uniforms.get("bloomIntensity").value = 0
      fx.luminance.render = () => {}
      fx.blur.render = () => {}
    } else if (k === "pr") {
      r.renderer.setPixelRatio(Number(v))
      r.applySize()
    } else if (k === "scale") {
      r.quality = { ...r.quality, renderScale: Number(v) }
      r.applySize()
    } else if (k === "shadowsize") {
      r.quality = { ...r.quality, shadowSize: Number(v) }
      r.buildShadows()
    } else if (k === "census") {
      const counts: Record<string, number> = {}
      built.group.traverse((o: any) => {
        if (!o.isMesh) return
        const key = `${o.material?.customProgramCacheKey?.() ?? "?"}:${o.type}`
        counts[key] = (counts[key] ?? 0) + 1
      })
      console.warn("census " + JSON.stringify(counts))
    } else if (k !== "") throw new Error(`unknown toggle ${k}`)
  }
}

const idle: FrameInput = {
  throttle: 0.3,
  roll: 0,
  pitch: 0,
  yaw: 0,
  arm: false,
  reset: false,
  source: "none",
}

async function fly(game: Game, canvas: HTMLCanvasElement) {
  game.paused = false
  game.sim.reset()
  const ap = new Autopilot(game.sim, route)
  const wall: number[] = []
  const cpu: number[] = []
  const images: string[] = []
  let prev = await raf()
  for (let f = 0; f < 60 * 180 && !ap.done; f++) {
    const a = performance.now()
    game.tick(DT, ap.next(DT))
    cpu.push(performance.now() - a)
    if (shots.includes(f)) images.push(canvas.toDataURL("image/jpeg", 0.85))
    const now = await raf()
    wall.push(now - prev)
    prev = now
    if (f % 60 === 0) bench.progress = `fly ${f}`
  }
  return { wall, cpu, images }
}

async function holdPoses(game: Game, canvas: HTMLCanvasElement, poses: Pose[]) {
  const st = game.sim.state
  const wall: number[] = []
  const cpu: number[] = []
  const images: string[] = []
  for (const [pi, pose] of poses.entries()) {
    st.position.copy(pose.p)
    st.quaternion.copy(pose.q)
    bench.progress = `pose ${pi + 1}/${poses.length}`
    let prev = await raf()
    for (let k = 0; k <= reps; k++) {
      const a = performance.now()
      game.tick(DT, idle)
      if (k > 0) cpu.push(performance.now() - a)
      if (k === reps && shots.includes(pi)) images.push(canvas.toDataURL("image/jpeg", 0.85))
      const now = await raf()
      if (k > 0) wall.push(now - prev)
      prev = now
    }
  }
  return { wall, cpu, images }
}

/** Exercise setting changes and report anything that breaks or renders black. */
async function smoke(game: Game, canvas: HTMLCanvasElement) {
  const errors: string[] = []
  const check = async (label: string) => {
    for (let i = 0; i < 8; i++) {
      game.tick(DT, idle)
      await raf()
    }
    game.tick(DT, idle)
    const c = document.createElement("canvas")
    c.width = 64
    c.height = 36
    const ctx = c.getContext("2d")!
    ctx.drawImage(canvas, 0, 0, 64, 36)
    const d = ctx.getImageData(0, 0, 64, 36).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!
    const avg = sum / (d.length / 4) / 3
    if (avg < 10 || avg > 245) errors.push(`${label}: mean brightness ${avg.toFixed(0)}`)
    const gl = game.renderer.renderer.getContext()
    const e = gl.getError()
    if (e) errors.push(`${label}: GL error ${e}`)
    bench.progress = `smoke ${label}`
  }
  await check("start")
  for (const view of ["chase", "los", "fpv"] as const) {
    settings.set({ view })
    await check(`view ${view}`)
  }
  for (const graphics of ["low", "high", "medium"] as const) {
    settings.set({ graphics })
    game.applySettings(settings.get())
    await check(`graphics ${graphics}`)
  }
  for (const [k, v] of [
    ["cameraEffects", false],
    ["shadows", false],
    ["shadows", true],
    ["cameraEffects", true],
  ] as const) {
    settings.set({ [k]: v })
    game.applySettings(settings.get())
    await check(`${k} ${v}`)
  }
  game.loadMap(map)
  await check("reload map")
  game.nextSpawn()
  await check("next spawn")
  return errors
}

async function runConfig(cfg: string, poses: Pose[]) {
  const toggles = cfg === "base" ? [] : cfg.split(",")
  settings.set({ graphics: quality })
  const canvas = document.createElement("canvas")
  canvas.style.cssText = "display:block;width:100vw;height:100vh"
  document.body.replaceChildren(canvas)
  const game = new Game(canvas)
  await game.init(map, { loop: false })
  applyToggles(game, toggles)
  const gl = game.renderer.renderer
  game.paused = true
  const t0 = performance.now()
  game.tick(DT, idle)
  await raf()
  const firstMs = performance.now() - t0
  // Warm up every pose once so shader compiles and LOD swaps don't land in timings
  for (const pose of poses) {
    game.sim.state.position.copy(pose.p)
    game.sim.state.quaternion.copy(pose.q)
    game.tick(DT, idle)
    await raf()
  }
  if (mode === "smoke") {
    const errors = await smoke(game, canvas)
    game.dispose()
    return {
      config: cfg,
      resolution: [0, 0],
      frames: 0,
      wallMean: 0,
      cpuMean: 0,
      firstMs,
      images: [],
      errors,
    }
  }
  const r = mode === "fly" ? await fly(game, canvas) : await holdPoses(game, canvas, poses)
  const res = {
    config: cfg,
    resolution: [gl.domElement.width, gl.domElement.height],
    frames: r.wall.length,
    wallMean: mean(r.wall),
    cpuMean: mean(r.cpu),
    firstMs,
    images: r.images,
  }
  game.dispose()
  gl.forceContextLoss()
  canvas.remove()
  await raf()
  return res
}

async function run() {
  await initPhysics()
  bench.progress = "poses"
  const poses = recordPoses()
  const out = []
  for (const c of configs) out.push(await runConfig(c, poses))
  bench.result = { quality, poses: poses.length, configs: out }
  bench.done = true
}

run().catch((e) => {
  bench.error = String(e?.stack ?? e)
  bench.done = true
})
