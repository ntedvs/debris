import { Game } from "../src/game"
import type { FrameInput } from "../src/input/input"
import { buildMap } from "../src/map/builder"
import { BUILTIN_MAPS } from "../src/map/maps"
import type { GraphicsQuality } from "../src/render/scene"
import { getQuad } from "../src/sim/quads"
import { initPhysics, RAPIER, SimWorld } from "../src/sim/sim-world"
import { settings } from "../src/settings"
import { Autopilot } from "./autopilot"
import { ROUTES } from "./routes"

/** Fixed frame step, so every run flies exactly the same path regardless of fps. */
const DT = 1 / 60
/** Hard stop if a route never completes. */
const MAX_FRAMES = 60 * 180
const IMPACT = 14

type Stats = { mean: number; p50: number; p95: number; p99: number; max: number }
function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1)
  return { mean, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] ?? 0 }
}

type Bench = {
  done: boolean
  progress: string
  error?: string
  result?: unknown
}
const bench: Bench = { done: false, progress: "starting" }
;(window as unknown as { __bench: Bench }).__bench = bench

const params = new URLSearchParams(location.search)
const mapId = params.get("map") ?? "field"
const qualities = (params.get("quality") ?? "low,medium,high").split(",") as GraphicsQuality[]
const skipSim = params.has("nosim")
const skipRender = params.has("norender")

const entry = BUILTIN_MAPS.find((m) => m.id === mapId)
if (!entry) throw new Error(`No map ${mapId}`)
const maybeRoute = ROUTES[mapId]
if (!maybeRoute) throw new Error(`No bench route for map ${mapId}`)
const route = maybeRoute
const map = entry.map

settings.set({
  view: "fpv",
  cameraEffects: true,
  shadows: true,
  noCrash: true,
  physicsRate: 1000,
})

const raf = () => new Promise<number>((r) => requestAnimationFrame(r))

/** Flight fingerprint. If it changes, the sim behaves differently and timings aren't comparable. */
function fingerprint(sim: SimWorld, frames: number) {
  const p = sim.state.position
  return `${frames}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`
}

function glInfo() {
  const gl = document.createElement("canvas").getContext("webgl2")
  if (!gl) return { renderer: "none", vendor: "none" }
  const ext = gl.getExtension("WEBGL_debug_renderer_info")
  return {
    renderer: String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    ),
    vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
  }
}

/** Physics + flight controller alone, on the real map colliders, as fast as it goes. */
async function simPhase() {
  const spec = getQuad(settings.get().quadId)
  const runs: {
    wallMs: number
    frameMs: number[]
    fingerprint: string
    impacts: number
    done: boolean
  }[] = []
  let buildMs = 0
  let colliders = 0
  // First run warms up the JIT, second is reported
  for (let run = 0; run < 2; run++) {
    const sim = new SimWorld(spec, { rate: 1000, crashThreshold: 0 })
    const t0 = performance.now()
    const built = buildMap(map, RAPIER, sim.world)
    buildMs = performance.now() - t0
    colliders = built.stats.colliders
    const wind = map.environment.wind
    if (wind) sim.wind = { speed: wind.speed, direction: wind.direction, gust: wind.gust }
    sim.setSpawn(built.spawns[0]!)
    sim.reset()
    const ap = new Autopilot(sim, route)
    const frameMs: number[] = []
    let acc = 0
    let impacts = 0
    let f = 0
    const start = performance.now()
    for (; f < MAX_FRAMES && !ap.done; f++) {
      const input = ap.next(DT)
      const a = performance.now()
      acc += DT
      while (acc >= sim.dt) {
        sim.step(input)
        acc -= sim.dt
        if (sim.lastImpact > IMPACT) impacts++
      }
      frameMs.push(performance.now() - a)
    }
    runs.push({
      wallMs: performance.now() - start,
      frameMs,
      fingerprint: fingerprint(sim, f),
      impacts,
      done: ap.done,
    })
    sim.world.free()
    await raf()
  }
  const r = runs[1]!
  const simSeconds = r.frameMs.length * DT
  return {
    mapBuildMs: buildMs,
    colliders,
    routeSeconds: simSeconds,
    routeCompleted: r.done,
    impacts: r.impacts,
    fingerprint: r.fingerprint,
    deterministic: runs[0]!.fingerprint === r.fingerprint,
    /** Sim cost per 16.7 ms frame of flight time. */
    frameMs: stats(r.frameMs),
    usPerStep: (r.wallMs * 1000) / (simSeconds * 1000),
    realtimeFactor: simSeconds / (r.wallMs / 1000),
  }
}

/** The full game loop at one quality level, flying the route in FPV. */
async function renderPhase(quality: GraphicsQuality, shots: number[]) {
  settings.set({ graphics: quality })
  const canvas = document.createElement("canvas")
  canvas.style.cssText = "display:block;width:100vw;height:100vh"
  document.body.replaceChildren(canvas)
  const game = new Game(canvas)
  const t0 = performance.now()
  await game.init(map, { loop: false })
  const initMs = performance.now() - t0
  const gl = game.renderer.renderer
  gl.info.autoReset = false

  const idle: FrameInput = {
    throttle: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    arm: false,
    reset: false,
    source: "none",
  }
  // Warm up shaders and buffers at the spawn without stepping the sim
  game.paused = true
  let a = performance.now()
  game.tick(DT, idle)
  await raf()
  const firstFrameMs = performance.now() - a
  for (let i = 0; i < 90; i++) {
    game.tick(DT, idle)
    await raf()
  }
  game.paused = false

  const ap = new Autopilot(game.sim, route)
  const frame: number[] = []
  const simMs: number[] = []
  const renderMs: number[] = []
  const calls: number[] = []
  const triangles: number[] = []
  const images: string[] = []
  const heap0 = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  let f = 0
  let prev = await raf()
  const start = prev
  for (; f < MAX_FRAMES && !ap.done; f++) {
    gl.info.reset()
    game.tick(DT, ap.next(DT))
    const shot = shots.includes(f)
    if (shot) images.push(canvas.toDataURL("image/jpeg", 0.8))
    simMs.push(game.timings.sim)
    renderMs.push(game.timings.render)
    calls.push(gl.info.render.calls)
    triangles.push(gl.info.render.triangles)
    const now = await raf()
    if (!shot) frame.push(now - prev)
    prev = now
    if (f % 60 === 0)
      bench.progress = `${quality}: ${(f * DT).toFixed(0)}s, waypoint ${ap.index + 1}/${route.length}`
  }
  const wallS = (prev - start) / 1000
  const result = {
    quality,
    resolution: [gl.domElement.width, gl.domElement.height],
    initMs,
    firstFrameMs,
    frames: frame.length,
    fps: frame.length / wallS,
    frameMs: stats(frame),
    over16ms: frame.filter((x) => x > 1000 / 60 + 1).length / frame.length,
    over33ms: frame.filter((x) => x > 1000 / 30 + 1).length / frame.length,
    cpuSimMs: stats(simMs),
    cpuRenderMs: stats(renderMs),
    drawCalls: stats(calls),
    triangles: stats(triangles),
    programs: gl.info.programs?.length ?? 0,
    textures: gl.info.memory.textures,
    geometries: gl.info.memory.geometries,
    jsHeapMB: heap0 ? heap0.usedJSHeapSize / 2 ** 20 : null,
    fingerprint: fingerprint(game.sim, f),
    images,
  }
  game.dispose()
  gl.forceContextLoss()
  canvas.remove()
  await raf()
  return result
}

async function run() {
  await initPhysics()
  const env = {
    ...glInfo(),
    userAgent: navigator.userAgent,
    viewport: [innerWidth, innerHeight],
    devicePixelRatio,
    crossOriginIsolated,
    map: mapId,
  }
  bench.progress = "sim"
  const sim = skipSim ? null : await simPhase()
  const routeFrames = sim ? Number(sim.fingerprint.split(":")[0]) : 1800
  const shots = [0.08, 0.45, 0.75].map((t) => Math.floor(t * routeFrames))
  const render = []
  if (!skipRender) for (const q of qualities) render.push(await renderPhase(q, shots))
  bench.result = { date: new Date().toISOString(), env, sim, render }
  bench.done = true
}

run().catch((e) => {
  bench.error = String(e?.stack ?? e)
  bench.done = true
})
