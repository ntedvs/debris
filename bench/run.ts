/**
 * Headless performance benchmark. Builds the bench page in production mode,
 * opens it in headless Chromium on the real GPU with vsync off, flies a fixed
 * route on a map and reports sim and frame timings.
 *
 *   bun bench                      all quality levels, compared to bench/baseline.json
 *   bun bench --quality medium     one level
 *   bun bench --save               store this run as the baseline
 *   bun bench --runs 3             median of 3 runs, less noise
 *   bun bench --headed             watch it
 */
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "playwright"
import { build } from "vite"

const { values: args } = parseArgs({
  options: {
    quality: { type: "string", default: "low,medium,high" },
    map: { type: "string", default: "field" },
    size: { type: "string", default: "1920x1080" },
    dpr: { type: "string", default: "2" },
    baseline: { type: "string", default: "bench/baseline.json" },
    save: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    "no-sim": { type: "boolean", default: false },
    "no-render": { type: "boolean", default: false },
    threshold: { type: "string", default: "10" },
    runs: { type: "string", default: "1" },
  },
})

const root = resolve(import.meta.dir, "..")
const outDir = join(root, "node_modules/.cache/debris-bench")
const resultsDir = join(root, "bench/results")

console.log("building...")
await build({
  root,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 10_000,
    rollupOptions: { input: join(root, "bench/index.html") },
  },
})

// Cross origin isolation gives performance.now() microsecond resolution
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    let path = new URL(req.url).pathname
    if (path.endsWith("/")) path += "index.html"
    const file = Bun.file(join(outDir, path))
    if (!(await file.exists())) return new Response("not found", { status: 404 })
    return new Response(file, {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    })
  },
})

const [width, height] = args.size.split("x").map(Number) as [number, number]
const browser = await chromium.launch({
  headless: !args.headed,
  // Full Chromium in new headless mode, which uses the real GPU
  channel: "chromium",
  args: [
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--enable-precise-memory-info",
    ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
  ],
})

type Stats = { mean: number; p50: number; p95: number; p99: number; max: number }
type RenderResult = {
  quality: string
  resolution: [number, number]
  initMs: number
  firstFrameMs: number
  frames: number
  fps: number
  frameMs: Stats
  over16ms: number
  over33ms: number
  cpuSimMs: Stats
  cpuRenderMs: Stats
  drawCalls: Stats
  triangles: Stats
  programs: number
  jsHeapMB: number | null
  fingerprint: string
  images?: string[]
}
type SimResult = {
  mapBuildMs: number
  colliders: number
  routeSeconds: number
  routeCompleted: boolean
  impacts: number
  fingerprint: string
  deterministic: boolean
  frameMs: Stats
  usPerStep: number
  realtimeFactor: number
}
type Result = {
  date: string
  runs?: number
  env: { renderer: string; vendor: string; userAgent: string; crossOriginIsolated: boolean }
  sim: SimResult | null
  render: RenderResult[]
}

/** Element-wise median of numeric fields across runs. Everything else comes from the first run. */
function median<T>(xs: T[]): T {
  const first = xs[0]
  if (typeof first === "number") {
    const s = (xs as number[]).toSorted((a, b) => a - b)
    return s[Math.floor(s.length / 2)] as T
  }
  if (Array.isArray(first))
    return first.map((_, i) => median(xs.map((x) => (x as unknown[])[i]))) as T
  if (first && typeof first === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(first))
      out[k] = median(xs.map((x) => (x as Record<string, unknown>)[k]))
    return out as T
  }
  return first as T
}

async function runOnce(label: string): Promise<Result> {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: Number(args.dpr),
  })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`[page ${m.type()}] ${m.text()}`)
  })
  page.on("pageerror", (e) => console.log(`[page error] ${e.message}`))
  const q = new URLSearchParams({ map: args.map, quality: args.quality })
  if (args["no-sim"]) q.set("nosim", "")
  if (args["no-render"]) q.set("norender", "")
  await page.goto(`http://localhost:${server.port}/bench/?${q}`)

  let last = ""
  const deadline = Date.now() + 20 * 60_000
  for (;;) {
    const s = await page.evaluate(() => {
      const b = (
        window as unknown as { __bench?: { done: boolean; progress: string; error?: string } }
      ).__bench
      return b ? { done: b.done, progress: b.progress, error: b.error } : null
    })
    if (s?.error) throw new Error(s.error)
    if (s?.done) break
    if (s && s.progress !== last) {
      last = s.progress
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${label}${last}`)
    }
    if (Date.now() > deadline) throw new Error("bench timed out")
    await Bun.sleep(500)
  }
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K")
  const r = await page.evaluate(
    () => (window as unknown as { __bench: { result: Result } }).__bench.result,
  )
  await page.close()
  return r
}

let result: Result
try {
  const runs = Math.max(1, Number(args.runs))
  const all: Result[] = []
  for (let i = 0; i < runs; i++) all.push(await runOnce(runs > 1 ? `run ${i + 1}/${runs}: ` : ""))
  result = median(all)
  result.runs = runs
} finally {
  await browser.close()
  server.stop()
}

// Screenshots out of the JSON
await mkdir(resultsDir, { recursive: true })
for (const r of result.render) {
  for (const [i, img] of (r.images ?? []).entries()) {
    await Bun.write(
      join(resultsDir, `${r.quality}-${i + 1}.jpg`),
      Buffer.from(img.split(",")[1]!, "base64"),
    )
  }
  delete r.images
}
await Bun.write(join(resultsDir, "latest.json"), JSON.stringify(result, null, 2))

// ---------- report ----------

const baselineFile = Bun.file(join(root, args.baseline))
const baseline: Result | null = (await baselineFile.exists()) ? await baselineFile.json() : null
const threshold = Number(args.threshold) / 100
const tty = process.stdout.isTTY
const color = (c: number, s: string) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s)

/** Value with change vs baseline. `lower` = lower is better. */
function cell(v: number, base: number | undefined, digits = 1, lower = true, unit = "") {
  const s = v.toFixed(digits) + unit
  if (base === undefined || !base) return s
  const d = (v - base) / base
  const tag = `${d >= 0 ? "+" : ""}${(d * 100).toFixed(0)}%`
  if (Math.abs(d) < threshold) return `${s} ${color(2, tag)}`
  return `${s} ${color(d < 0 === lower ? 32 : 31, tag)}`
}

function table(rows: string[][]) {
  // Strip ANSI for width
  const len = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => len(r[i] ?? ""))))
  for (const r of rows)
    console.log("  " + r.map((c, i) => c + " ".repeat(widths[i]! - len(c))).join("   "))
}

console.log(
  `GPU: ${result.env.renderer}${result.runs && result.runs > 1 ? `, median of ${result.runs} runs` : ""}`,
)
if (/swiftshader|llvmpipe|software/i.test(result.env.renderer))
  console.log(color(33, "warning: software rendering, render numbers are not representative"))
if (!result.env.crossOriginIsolated)
  console.log(color(33, "warning: coarse timers (not cross origin isolated)"))
if (baseline)
  console.log(
    `baseline: ${args.baseline} (${baseline.date}), changes under ${args.threshold}% are dimmed`,
  )
if (baseline && baseline.env.renderer !== result.env.renderer)
  console.log(color(33, `warning: baseline was on a different GPU (${baseline.env.renderer})`))

const s = result.sim
if (s) {
  const b = baseline?.sim ?? undefined
  console.log("\nsim (physics + flight controller, 1 kHz, real map colliders)")
  table([
    ["map build", cell(s.mapBuildMs, b?.mapBuildMs, 0, true, " ms"), `${s.colliders} colliders`],
    [
      "route",
      `${s.routeSeconds.toFixed(1)} s flight`,
      `${s.routeCompleted ? "completed" : color(31, "NOT COMPLETED")}, ${s.impacts} impacts, ${s.deterministic ? "deterministic" : color(31, "NOT DETERMINISTIC")}`,
    ],
    [
      "per step",
      cell(s.usPerStep, b?.usPerStep, 1, true, " us"),
      cell(s.realtimeFactor, b?.realtimeFactor, 0, false, "x realtime"),
    ],
    [
      "per frame",
      `p50 ${cell(s.frameMs.p50, b?.frameMs.p50, 2, true, " ms")}`,
      `p99 ${cell(s.frameMs.p99, b?.frameMs.p99, 2, true, " ms")}   max ${s.frameMs.max.toFixed(2)} ms`,
    ],
  ])
  if (b && b.fingerprint !== s.fingerprint)
    console.log(color(33, "  flight path differs from baseline, sim behavior changed"))
}

if (result.render.length) {
  console.log(
    `\nrender (FPV, ${width}x${height} @${args.dpr}x, vsync off, ms are wall frame times)`,
  )
  const rows = [
    [
      "quality",
      "res",
      "fps",
      "p50",
      "p95",
      "p99",
      ">16.7",
      "sim",
      "render call",
      "calls",
      "tris",
      "1st frame",
    ],
  ]
  for (const r of result.render) {
    const b = baseline?.render.find((x) => x.quality === r.quality)
    rows.push([
      r.quality,
      r.resolution.join("x"),
      cell(r.fps, b?.fps, 0, false),
      cell(r.frameMs.p50, b?.frameMs.p50),
      cell(r.frameMs.p95, b?.frameMs.p95),
      cell(r.frameMs.p99, b?.frameMs.p99),
      `${(r.over16ms * 100).toFixed(1)}%`,
      cell(r.cpuSimMs.mean, b?.cpuSimMs.mean, 2),
      cell(r.cpuRenderMs.mean, b?.cpuRenderMs.mean, 2),
      cell(r.drawCalls.mean, b?.drawCalls.mean, 0),
      `${(r.triangles.mean / 1e6).toFixed(2)}M`,
      cell(r.firstFrameMs, b?.firstFrameMs, 0, true, " ms"),
    ])
    if (s && r.fingerprint !== s.fingerprint)
      console.log(
        color(33, `  ${r.quality}: flight path differs from sim phase (${r.fingerprint})`),
      )
  }
  table(rows)
  console.log(
    color(
      2,
      "  sim and render call are main thread ms per frame. Render call includes GPU backpressure, so when it is close to p50 the frame is GPU bound.",
    ),
  )
}

console.log(`\nfull results: bench/results/latest.json, screenshots: bench/results/*.jpg`)
if (args.save) {
  await Bun.write(baselineFile, JSON.stringify(result, null, 2))
  console.log(`saved baseline to ${args.baseline}`)
}
