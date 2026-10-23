import * as THREE from "three"
import { fbm, rng } from "../map/noise"
import type { Material } from "../map/schema"

type Rgb = [number, number, number]
type PresetDef = {
  tileSize: number
  roughness: number
  metalness: number
  bump: number
  paint: (x: number, y: number, size: number, r: () => number) => [Rgb, number]
  overlay?: (ctx: CanvasRenderingContext2D, size: number, r: () => number) => void
  transparent?: boolean
}

const SIZE = 512
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// Noise sampled over a tiling period so textures repeat seamlessly.
const n = (x: number, y: number, scale: number, oct = 4, seed = 0) =>
  fbm((x / SIZE) * scale, (y / SIZE) * scale, oct, seed, scale)

const PRESETS: Record<string, PresetDef> = {
  grass: {
    tileSize: 3,
    roughness: 0.95,
    metalness: 0,
    bump: 0.6,
    paint: (x, y) => {
      const big = n(x, y, 4, 4, 1)
      const fine = n(x, y, 64, 2, 2)
      const c = mix([52, 74, 28], [92, 112, 44], big)
      const k = 0.75 + fine * 0.5
      return [[c[0] * k, c[1] * k, c[2] * k], fine]
    },
  },
  dirt: {
    tileSize: 3,
    roughness: 1,
    metalness: 0,
    bump: 1,
    paint: (x, y) => {
      const big = n(x, y, 4, 4, 3)
      const fine = n(x, y, 48, 3, 4)
      const c = mix([92, 70, 48], [134, 108, 78], big)
      const k = 0.7 + fine * 0.6
      return [[c[0] * k, c[1] * k, c[2] * k], fine]
    },
  },
  sand: {
    tileSize: 3,
    roughness: 1,
    metalness: 0,
    bump: 0.4,
    paint: (x, y) => {
      const big = n(x, y, 4, 3, 5)
      const fine = n(x, y, 96, 2, 6)
      const c = mix([190, 170, 130], [214, 196, 156], big)
      const k = 0.9 + fine * 0.2
      return [[c[0] * k, c[1] * k, c[2] * k], fine]
    },
  },
  concrete: {
    tileSize: 4,
    roughness: 0.9,
    metalness: 0,
    bump: 0.5,
    paint: (x, y) => {
      const stain = n(x, y, 3, 5, 7)
      const fine = n(x, y, 64, 3, 8)
      const c = mix([120, 120, 116], [168, 166, 160], stain)
      const k = 0.88 + fine * 0.24
      return [[c[0] * k, c[1] * k, c[2] * k], fine]
    },
  },
  asphalt: {
    tileSize: 3,
    roughness: 0.9,
    metalness: 0,
    bump: 0.8,
    paint: (x, y, _s, r) => {
      const big = n(x, y, 4, 3, 9)
      const speck = r() > 0.94 ? 1 : 0
      const v = 48 + big * 22 + speck * 40
      return [[v, v, v * 1.03], speck * 0.5 + big * 0.5]
    },
  },
  brick: {
    tileSize: 2,
    roughness: 0.92,
    metalness: 0,
    bump: 1.5,
    paint: (x, y) => {
      const rows = 16
      const h = SIZE / rows
      const row = Math.floor(y / h)
      const w = h * 2.1
      const off = row % 2 ? w / 2 : 0
      const bx = Math.floor((x + off) / w)
      const lx = (x + off) % w
      const ly = y % h
      const mortar = lx < 3 || ly < 3
      if (mortar) return [[150, 145, 135], 0]
      const tone = fbm(bx * 0.37, row * 0.71, 1, 11)
      const fine = n(x, y, 64, 2, 12)
      const c = mix([120, 52, 38], [166, 84, 60], tone)
      const k = 0.85 + fine * 0.3
      return [[c[0] * k, c[1] * k, c[2] * k], 0.6 + fine * 0.4]
    },
  },
  metal: {
    tileSize: 1.2,
    roughness: 0.45,
    metalness: 0.7,
    bump: 1.2,
    paint: (x, y) => {
      const ridge = 0.5 + 0.5 * Math.sin((x / SIZE) * Math.PI * 2 * 8)
      const dirt = n(x, y, 4, 4, 13)
      const v = 150 + ridge * 40 - dirt * 30
      return [[v, v, v], ridge]
    },
  },
  rust: {
    tileSize: 2,
    roughness: 0.85,
    metalness: 0.3,
    bump: 0.8,
    paint: (x, y) => {
      const blot = n(x, y, 6, 5, 14)
      const fine = n(x, y, 64, 2, 15)
      const c = mix([96, 44, 22], [160, 86, 40], blot)
      const k = 0.8 + fine * 0.4
      return [[c[0] * k, c[1] * k, c[2] * k], blot]
    },
  },
  wood: {
    tileSize: 1.5,
    roughness: 0.8,
    metalness: 0,
    bump: 0.7,
    paint: (x, y) => {
      const plank = Math.floor((y / SIZE) * 6)
      const ly = (y / SIZE) * 6 - plank
      const grain = fbm((x / SIZE) * 2, (y / SIZE) * 60 + plank * 3, 3, 16, 0)
      const tone = fbm(plank * 1.3, 0.5, 1, 17)
      const c = mix([110, 76, 46], [160, 118, 76], tone * 0.6 + grain * 0.4)
      const gap = ly < 0.02 ? 0.5 : 1
      return [[c[0] * gap, c[1] * gap, c[2] * gap], grain * gap]
    },
  },
  plaster: {
    tileSize: 3,
    roughness: 0.9,
    metalness: 0,
    bump: 0.3,
    paint: (x, y) => {
      const v = 205 + n(x, y, 8, 4, 18) * 30
      return [[v, v * 0.98, v * 0.94], n(x, y, 64, 2, 19)]
    },
  },
  painted: {
    tileSize: 2,
    roughness: 0.6,
    metalness: 0,
    bump: 0.15,
    paint: (x, y) => {
      const v = 225 + n(x, y, 6, 3, 20) * 30
      return [[v, v, v], n(x, y, 48, 2, 21)]
    },
  },
  glass: {
    tileSize: 2,
    roughness: 0.05,
    metalness: 0.9,
    bump: 0,
    paint: () => [[40, 56, 72], 0],
  },
  // Terrain only, not exposed in the map format
  rock: {
    tileSize: 5,
    roughness: 0.9,
    metalness: 0,
    bump: 1.4,
    paint: (x, y) => {
      const big = n(x, y, 3, 5, 22)
      const ridge = 1 - Math.abs(n(x, y, 6, 4, 23) * 2 - 1)
      const crack = Math.pow(ridge, 6)
      const fine = n(x, y, 64, 3, 24)
      const c = mix([96, 90, 82], [140, 134, 124], big)
      const k = (0.8 + fine * 0.35) * (1 - crack * 0.55)
      return [
        [c[0] * k, c[1] * k * 0.99, c[2] * k * 0.97],
        big * 0.5 + fine * 0.3 - crack * 0.6 + 0.4,
      ]
    },
  },
}

const textureCache = new Map<string, { map: THREE.CanvasTexture; bump: THREE.CanvasTexture }>()

export function presetTextures(name: string) {
  let t = textureCache.get(name)
  if (t) return t
  const def = PRESETS[name]!
  const color = document.createElement("canvas")
  const height = document.createElement("canvas")
  color.width = color.height = height.width = height.height = SIZE
  const cctx = color.getContext("2d")!
  const hctx = height.getContext("2d")!
  const cimg = cctx.createImageData(SIZE, SIZE)
  const himg = hctx.createImageData(SIZE, SIZE)
  const r = rng(name.length * 31 + 7)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [c, h] = def.paint(x, y, SIZE, r)
      const i = (y * SIZE + x) * 4
      cimg.data[i] = clamp01(c[0] / 255) * 255
      cimg.data[i + 1] = clamp01(c[1] / 255) * 255
      cimg.data[i + 2] = clamp01(c[2] / 255) * 255
      cimg.data[i + 3] = 255
      const hv = clamp01(h) * 255
      himg.data[i] = himg.data[i + 1] = himg.data[i + 2] = hv
      himg.data[i + 3] = 255
    }
  }
  cctx.putImageData(cimg, 0, 0)
  hctx.putImageData(himg, 0, 0)
  const map = new THREE.CanvasTexture(color)
  map.colorSpace = THREE.SRGBColorSpace
  const bump = new THREE.CanvasTexture(height)
  for (const tex of [map, bump]) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.anisotropy = 8
  }
  t = { map, bump }
  textureCache.set(name, t)
  return t
}

export const presetDef = (name: string) => PRESETS[name]!

const materialCache = new Map<string, THREE.MeshStandardMaterial>()

/** Resolve a map material description to a shared Three.js material. */
export function getMaterial(
  m: Material | undefined,
  fallback: Material = "painted",
): THREE.MeshStandardMaterial {
  const src = m ?? fallback
  const desc: Exclude<Material, string> = typeof src === "string" ? { preset: src } : src
  const preset = desc.preset ?? "painted"
  const key = JSON.stringify([preset, desc.color, desc.roughness, desc.metalness, desc.tileSize])
  const cached = materialCache.get(key)
  if (cached) return cached
  const def = PRESETS[preset]!
  const tex = presetTextures(preset)
  const tile = desc.tileSize ?? def.tileSize
  const map = tex.map.clone()
  const bump = tex.bump.clone()
  map.repeat.set(1 / tile, 1 / tile)
  bump.repeat.set(1 / tile, 1 / tile)
  const mat = new THREE.MeshStandardMaterial({
    map,
    bumpMap: def.bump > 0 ? bump : null,
    bumpScale: def.bump,
    roughness: desc.roughness ?? def.roughness,
    metalness: desc.metalness ?? def.metalness,
    color: desc.color ? new THREE.Color(desc.color) : new THREE.Color(0xffffff),
  })
  materialCache.set(key, mat)
  return mat
}

/** Plain colored material for vehicle parts and foliage. */
export function solidMaterial(
  color: string | number,
  roughness = 0.8,
  metalness = 0,
  flat = false,
) {
  const key = `solid:${color}:${roughness}:${metalness}:${flat}`
  const cached = materialCache.get(key)
  if (cached) return cached
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: flat })
  materialCache.set(key, mat)
  return mat
}
