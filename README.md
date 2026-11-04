# Debris

A browser FPV drone simulator built with Three.js, Rapier physics and React.

## Run

```sh
bun install
bun dev
```

`bun run build` writes to `dist/`, which is deployed as static assets with Cloudflare (`wrangler.json`).

## Controls

Plug in a radio as a USB joystick (EdgeTX, AETR, arm on CH5) and map it in the controller setup.
There's a keyboard fallback for testing (W/S throttle, A/D yaw, Space to arm). It isn't meant for real flying.

## Maps

Maps are declarative JSON files in `maps/`. See [docs/MAP_FORMAT.md](docs/MAP_FORMAT.md).
`bun schema` regenerates `public/map.schema.json` and copies the docs and maps into `public/`.

## Tests

```sh
bun test
```

## Benchmark

```sh
bun x playwright install chromium   # once
bun bench                           # all quality levels
bun bench --quality medium --runs 3 # one level, median of 3 runs
bun bench --save                    # store as bench/baseline.json
```

Builds `bench/` in production mode and runs it in headless Chromium on the real GPU with vsync off. An autopilot (`bench/autopilot.ts`) flies a fixed route (`bench/routes.ts`) with stick inputs through the real flight controller and physics, at a fixed 1/60 s per frame, so every run sees the same frames.

- **sim**: physics and flight controller alone on the map's colliders, as fast as possible. Reports us per 1 kHz step and the realtime factor.
- **render**: the full game loop in FPV at each quality level. Reports wall frame times (p50/p95/p99), main thread ms, draw calls and triangles.

Results are compared to `bench/baseline.json`. A flight fingerprint flags when sim changes alter the path, since timings are then not comparable. Full results and screenshots from the route go to `bench/results/`. Expect about 10% run to run noise on a laptop. Use `--runs 3` before trusting small changes.

To find out where time goes, `bench/profile-run.ts` switches features off one at a time and compares frame times on the same flight (GPU timer queries aren't reliable on ANGLE Metal):

```sh
bun bench/profile-run.ts --quality high --rounds 3 --configs "base;noao;noshadow;noterrain;scale=0.5"
bun bench/profile-run.ts --mode poses --shots 2,8 --configs "base;notaa"  # A/B screenshots
bun bench/profile-run.ts --quality low --configs "pr=0.25" --cpuprofile   # CPU hot spots
bun bench/profile-run.ts --mode smoke                                     # settings changes don't break rendering
```

## Rendering

The scene renders below output resolution with a subpixel jitter, and TAA (`src/render/taa.ts`) accumulates it into a full resolution, antialiased image. Everything after that runs in one pass at output resolution: lens distortion, motion blur, chromatic aberration, bloom, exposure, AgX, grading and sensor noise (`src/render/post.ts`).

Most of the frame is cached or amortized:

- Shadow cascades are centered on the camera and snapped to a grid, so they only re-render after the camera moves a grid step, at most one per frame (`src/render/shadows.ts`). The quad casts an analytic shadow instead.
- The sky renders into a cube map, one face per frame (`src/render/sky.ts`).
- AO is 8 samples at half resolution with no denoise; the pattern rotates every frame and TAA averages it (`src/render/ao.ts`).
- Vegetation is three batched meshes (bark, leaves, needles) with per instance LOD and culling.
- Lighting is diffuse only: one sun, shaded once, one cascade sampled (`src/render/shading.ts`).
