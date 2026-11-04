/**
 * Ablation profiler. Builds bench/profile.html, runs it in headless Chromium
 * on the real GPU and compares configs (comma lists of feature switches, see
 * applyToggles in profile.ts) against the first one.
 *
 *   bun bench/profile-run.ts --quality high --rounds 3 --configs "base;noao;noshadow;scale=0.5"
 *   bun bench/profile-run.ts --mode poses --shots 2,8 --configs "base;notaa"  # A/B screenshots
 *   bun bench/profile-run.ts --quality low --configs "pr=0.25" --cpuprofile   # CPU hot spots
 *
 * Rounds interleave configs (A B C A B C) and report the median, since the
 * GPU's clocks drift between runs. Screenshots go to bench/results/profile/.
 */
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "playwright"
import { build } from "vite"

const { values: args } = parseArgs({
  options: {
    quality: { type: "string", default: "medium" },
    configs: { type: "string", default: "base" },
    mode: { type: "string", default: "fly" },
    rounds: { type: "string", default: "1" },
    stride: { type: "string", default: "90" },
    reps: { type: "string", default: "8" },
    shots: { type: "string", default: "" },
    view: { type: "string", default: "fpv" },
    size: { type: "string", default: "1920x1080" },
    dpr: { type: "string", default: "2" },
    cpuprofile: { type: "boolean", default: false },
  },
})

const root = resolve(import.meta.dir, "..")
const outDir = join(root, "node_modules/.cache/debris-profile")
await build({
  root,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 10_000,
    rollupOptions: { input: join(root, "bench/profile.html") },
    // Readable names in CPU profiles
    minify: false,
  },
})
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
  headless: true,
  channel: "chromium",
  args: [
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
  ],
})

type CpuProfile = {
  nodes: {
    id: number
    children?: number[]
    callFrame: { functionName: string; url: string; lineNumber: number }
  }[]
  samples: number[]
  timeDeltas: number[]
}

/** Top functions by inclusive and self time. */
function printProfile(profile: CpuProfile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map<number, number>()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const name = (id: number) => {
    const f = byId.get(id)!.callFrame
    return `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`
  }
  const self = new Map<string, number>()
  const incl = new Map<string, number>()
  let total = 0
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] ?? 0
    total += dt
    self.set(name(id), (self.get(name(id)) ?? 0) + dt)
    const seen = new Set<string>()
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const k = name(cur)
      if (seen.has(k)) continue
      seen.add(k)
      incl.set(k, (incl.get(k) ?? 0) + dt)
    }
  })
  for (const [title, m, n] of [
    ["inclusive", incl, 40],
    ["self", self, 25],
  ] as const) {
    console.log(`cpu ${title}:`)
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, n))
      console.log(`  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
  }
}

type ConfigResult = {
  config: string
  resolution: number[]
  wallMean: number
  cpuMean: number
  firstMs: number
  images: string[]
}

try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: Number(args.dpr),
  })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`[page ${m.type()}] ${m.text()}`)
  })
  page.on("pageerror", (e) => console.log(`[page error] ${e.message}`))
  const rounds = Math.max(1, Number(args.rounds))
  const q = new URLSearchParams({
    quality: args.quality,
    configs: Array(rounds).fill(args.configs).join(";"),
    mode: args.mode,
    stride: args.stride,
    reps: args.reps,
    shots: args.shots,
    view: args.view,
  })
  const cdp = args.cpuprofile ? await page.context().newCDPSession(page) : null
  if (cdp) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 })
    await cdp.send("Profiler.start")
  }
  await page.goto(`http://localhost:${server.port}/bench/profile.html?${q}`)
  for (;;) {
    const s = await page.evaluate(() => {
      const b = (window as any).__bench
      return b && { done: b.done, progress: b.progress, error: b.error }
    })
    if (s?.error) throw new Error(s.error)
    if (s?.done) break
    if (s && process.stdout.isTTY) process.stdout.write(`\r\x1b[K${s.progress}`)
    await Bun.sleep(300)
  }
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K")
  if (cdp) printProfile(((await cdp.send("Profiler.stop")) as { profile: CpuProfile }).profile)

  const r = (await page.evaluate(() => (window as any).__bench.result)) as {
    poses: number
    configs: ConfigResult[]
  }
  const shotDir = join(root, "bench/results/profile")
  const shotIds = args.shots.split(",")
  for (const c of r.configs.slice(0, r.configs.length / rounds))
    for (const [i, img] of c.images.entries()) {
      const file = `${c.config.replace(/[^a-z0-9=.]+/gi, "_")}-${shotIds[i]}.jpg`
      await Bun.write(join(shotDir, file), Buffer.from(img.split(",")[1]!, "base64"))
    }

  if (args.mode === "smoke") {
    const errors = r.configs.flatMap((c) => (c as unknown as { errors: string[] }).errors)
    console.log(errors.length ? errors.join("\n") : "smoke: ok")
    process.exitCode = errors.length ? 1 : 0
  }
  const byName = new Map<string, ConfigResult[]>()
  for (const c of r.configs) byName.set(c.config, [...(byName.get(c.config) ?? []), c])
  const med = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const rows = [...byName.values()].map((cs) => ({
    ...cs[0]!,
    wall: med(cs.map((c) => c.wallMean)),
    cpu: med(cs.map((c) => c.cpuMean)),
    spread: cs.map((c) => c.wallMean.toFixed(2)).join(" "),
  }))
  const base = rows[0]!
  const rel = (v: number, b: number) => `${v >= b ? "+" : ""}${(((v - b) / b) * 100).toFixed(0)}%`
  console.log(`${args.quality}, ${args.mode}${args.mode === "poses" ? ` (${r.poses})` : ""}`)
  for (const c of rows)
    console.log(
      `[${c.config}] ${c.resolution.join("x")}  frame ${c.wall.toFixed(2)} ms${c === base ? "" : ` (${rel(c.wall, base.wall)})`}  cpu ${c.cpu.toFixed(2)} ms  [${c.spread}]  first frame ${c.firstMs.toFixed(0)} ms`,
    )
} finally {
  await browser.close()
  server.stop()
}
