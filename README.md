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
