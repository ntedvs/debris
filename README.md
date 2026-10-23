# Debris

Browser FPV drone simulator built as a trainer. Three.js rendering, Rapier collisions, custom flight physics at 1 kHz.

```sh
bun install
bun run dev     # http://localhost:5173
bun test        # physics + map checks
```

## Controller (RadioMaster Pocket / EdgeTX)

1. Plug in USB, pick **USB Joystick (HID)**. Turn the internal RF module off so the mixer runs at 1000 Hz.
2. Move a stick so the browser sees the device.
3. Menu (Esc) > Controller: detect each stick and the arm switch, then Calibrate.

Default mapping is EdgeTX classic AETR: axis 0 roll, 1 pitch, 2 throttle, 3 yaw, 4 arm (CH5).

## Physics

All in `src/sim`, no rendering code:

- `quad-dynamics.ts`: brushless motor model (KV, resistance, back EMF, current limit, active braking), battery with sag and polarization, prop thrust/torque with advance ratio falloff, rotor drag, propwash / vortex ring state, ground effect, anisotropic body drag, rotor and body gyroscopic terms.
- `flight-controller.ts`: Betaflight style rate PID (same P/I/D/FF scaling), I-term relax, TPA on D, RC smoothing, airmode mixer built from motor geometry.
- `rates.ts`: Actual, Betaflight, KISS and Quick rates.
- `sim-world.ts`: Rapier rigid body, arming, crash detection, wind and gusts.

## Rendering

All in `src/render`. Everything is procedural, no texture or model assets.

- `scene.ts`: half float HDR pipeline (postprocessing): N8AO ambient occlusion, ACES tone mapping, SMAA. Cascaded shadows fitted to the active camera, Preetham sky with clouds, sky-based image lighting. Low / Medium / High quality presets.
- `shading.ts`: shader chunk overrides shared by every lit material: CSM light loop, cloud shadows, and height fog colored from the prefiltered sky so the horizon always matches.
- `terrain.ts`: ground shader that blends grass, dirt and rock by slope, noise and a wear mask baked from object footprints and spawns, with anti-tiling. GPU grass in two rings around the camera, placed entirely in the vertex shader, with wind gusts and propwash from the quad.

## Adding a quad type

Copy `src/sim/quads/five-inch.ts`, change the numbers (frame, motor, prop, battery, camera, FC defaults), and add it to `src/sim/quads/index.ts`. The physics, mixer and 3D model are all generated from the spec, and any motor count or layout works.

## Maps

Maps are JSON files in `maps/`. The format is documented in `docs/MAP_FORMAT.md`, with a generated JSON Schema at `/map.schema.json` (`bun run schema`). Players can load their own map file or drop it on the window. The Make maps tab copies a ready-made AI prompt.
