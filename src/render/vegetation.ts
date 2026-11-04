import * as THREE from "three"
import { rng } from "../map/noise"
import { presetTextures } from "./materials"
import { DECL, patchMaterial, shared } from "./shading"

/**
 * Procedural vegetation: branching bark tubes plus alpha-tested leaf cards
 * with canopy-shaped normals, so crowns shade like soft volumes instead of
 * faceted blobs. Each species has a few variants and two LODs.
 */

export type Species = "tree" | "pine" | "bush"
export const VARIANTS: Record<Species, number> = { tree: 3, pine: 3, bush: 2 }
/** Beyond this distance (meters, scaled by object size) the far LOD is drawn. */
export const LOD_DISTANCE = 70

export type VegGeometry = { bark: THREE.BufferGeometry | null; leaves: THREE.BufferGeometry }
/** Simple collision volumes in local space. */
export type VegInfo = {
  trunk: { radius: number; height: number } | null
  crowns: { center: THREE.Vector3; radius: number }[]
}

// ---------- geometry helpers ----------

type Buf = { pos: number[]; nrm: number[]; uv: number[]; col: number[]; idx: number[] }
const newBuf = (): Buf => ({ pos: [], nrm: [], uv: [], col: [], idx: [] })

function toGeometry(b: Buf) {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2))
  g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3))
  g.setIndex(b.idx)
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

const UP = new THREE.Vector3(0, 1, 0)
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _n = new THREE.Vector3()

/** Tapered open tube from a to b. UVs in meters so bark texel density is constant. */
function tube(
  b: Buf,
  a: THREE.Vector3,
  c: THREE.Vector3,
  r0: number,
  r1: number,
  seg: number,
  ao0: number,
  ao1: number,
) {
  const dir = _v.subVectors(c, a)
  const len = dir.length()
  _q.setFromUnitVectors(UP, dir.normalize())
  const base = b.pos.length / 3
  for (let ring = 0; ring < 2; ring++) {
    const r = ring ? r1 : r0
    const y = ring ? len : 0
    const ao = ring ? ao1 : ao0
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2
      _n.set(Math.cos(t), 0, Math.sin(t)).applyQuaternion(_q)
      const p = new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r).applyQuaternion(_q).add(a)
      b.pos.push(p.x, p.y, p.z)
      b.nrm.push(_n.x, _n.y, _n.z)
      b.uv.push((i / seg) * Math.max(0.15, 2 * Math.PI * r0), y)
      b.col.push(ao, ao, ao)
    }
  }
  const row = seg + 1
  for (let i = 0; i < seg; i++) {
    const p0 = base + i
    b.idx.push(p0, p0 + row, p0 + 1, p0 + 1, p0 + row, p0 + row + 1)
  }
}

/**
 * Leaf card. `u` and `v` span the quad (v is the texture's up), `n` is the
 * shading normal, bent toward the canopy surface.
 */
function card(
  b: Buf,
  c: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  n: THREE.Vector3,
  w: number,
  h: number,
  ao: number,
  /** 0: card centered on c, 1: card base at c (sprigs growing out of a branch) */
  anchor = 0,
) {
  const base = b.pos.length / 3
  const v0 = -h * (0.5 - anchor * 0.5)
  for (const [su, sv] of [
    [-0.5, 0],
    [0.5, 0],
    [-0.5, 1],
    [0.5, 1],
  ] as const) {
    const p = c
      .clone()
      .addScaledVector(u, su * w)
      .addScaledVector(v, v0 + sv * h)
    b.pos.push(p.x, p.y, p.z)
    b.nrm.push(n.x, n.y, n.z)
    b.uv.push(su + 0.5, sv)
    // Slightly darker toward the card base, which sits deeper in the crown
    const k = ao * (0.85 + 0.15 * sv)
    b.col.push(k, k, k)
  }
  b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
}

function randomUnit(r: () => number) {
  const z = r() * 2 - 1
  const t = r() * Math.PI * 2
  const s = Math.sqrt(1 - z * z)
  return new THREE.Vector3(s * Math.cos(t), z, s * Math.sin(t))
}

/** Orthonormal card axes around a facing direction, with a random roll. */
function cardAxes(face: THREE.Vector3, r: () => number) {
  const ref = Math.abs(face.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP
  const u = new THREE.Vector3().crossVectors(ref, face).normalize()
  const v = new THREE.Vector3().crossVectors(face, u).normalize()
  const roll = (r() - 0.5) * 1.6
  const cu = u.clone().multiplyScalar(Math.cos(roll)).addScaledVector(v, Math.sin(roll))
  const cv = v.clone().multiplyScalar(Math.cos(roll)).addScaledVector(u, -Math.sin(roll))
  return { u: cu, v: cv }
}

// ---------- species ----------

type Built = { bark: Buf | null; leaves: Buf; info: VegInfo }

function broadleaf(variant: number, lod: number): Built {
  const r = rng(1000 + variant * 17)
  const bark = newBuf()
  const leaves = newBuf()
  const trunkH = 2.1 + r() * 0.6
  const crownC = new THREE.Vector3((r() - 0.5) * 0.4, trunkH + 1.7 + r() * 0.3, (r() - 0.5) * 0.4)
  const R = new THREE.Vector3(2 + r() * 0.5, 1.7 + r() * 0.35, 2 + r() * 0.5)
  const seg = lod ? 5 : 8

  const top = new THREE.Vector3(0, trunkH, 0)
  tube(bark, new THREE.Vector3(0, -0.1, 0), top, 0.21, 0.15, seg, 0.75, 0.9)
  // Leader and main limbs, each with a couple of side branches
  const limbs = 4 + Math.floor(r() * 2)
  const tips: THREE.Vector3[] = []
  for (let i = 0; i <= limbs; i++) {
    const leader = i === limbs
    const a = (i / limbs) * Math.PI * 2 + r() * 0.8
    const out = leader ? 0.15 : 0.55 + r() * 0.3
    const d = new THREE.Vector3(Math.cos(a) * out, 1, Math.sin(a) * out).normalize()
    const len = leader ? 2.4 : 1.6 + r() * 0.6
    const start = top.clone().addScaledVector(UP, -r() * 0.3)
    const end = start.clone().addScaledVector(d, len)
    tube(bark, start, end, 0.12, 0.05, lod ? 4 : 6, 0.85, 0.7)
    if (lod) {
      tips.push(end)
      continue
    }
    for (let k = 0; k < 3; k++) {
      const s = start.clone().lerp(end, 0.45 + k * 0.22)
      const sa = a + (r() - 0.5) * 2.2
      const sd = new THREE.Vector3(Math.cos(sa), 0.6 + r() * 0.6, Math.sin(sa)).normalize()
      const e = s.clone().addScaledVector(sd, 0.7 + r() * 0.6)
      tube(bark, s, e, 0.045, 0.015, 4, 0.7, 0.6)
      tips.push(e)
    }
  }

  // Leaf cards fill the crown, biased to the shell, clustered near branch tips
  const count = lod ? 46 : 210
  const size = lod ? 2.1 : 1.05
  for (let i = 0; i < count; i++) {
    let p: THREE.Vector3
    if (r() < 0.45 && tips.length) {
      p = tips[Math.floor(r() * tips.length)]!.clone().add(randomUnit(r).multiplyScalar(0.7 * r()))
    } else {
      const d = randomUnit(r)
      const s = 0.5 + 0.5 * Math.sqrt(r())
      p = crownC.clone().add(new THREE.Vector3(d.x * R.x, d.y * R.y, d.z * R.z).multiplyScalar(s))
    }
    if (p.y < trunkH - 0.2) p.y = trunkH - 0.2 + r() * 0.4
    const rel = new THREE.Vector3(
      (p.x - crownC.x) / R.x,
      (p.y - crownC.y) / R.y,
      (p.z - crownC.z) / R.z,
    )
    const depth = Math.min(1, rel.length())
    const outward = rel.clone().normalize()
    const face = outward.clone().add(randomUnit(r).multiplyScalar(0.9)).normalize()
    const { u, v } = cardAxes(face, r)
    // Normals mostly follow the crown surface: soft, volumetric shading
    const n = outward.clone().multiplyScalar(0.8).add(face.multiplyScalar(0.2)).normalize()
    const ao = (0.35 + 0.65 * depth) * (0.75 + 0.25 * (outward.y * 0.5 + 0.5))
    const sz = size * (0.75 + r() * 0.5)
    card(leaves, p, u, v, n, sz, sz, ao)
  }
  return {
    bark,
    leaves,
    info: {
      trunk: { radius: 0.2, height: trunkH + 0.6 },
      crowns: [{ center: crownC, radius: Math.min(R.x, R.y, R.z) * 0.95 }],
    },
  }
}

function conifer(variant: number, lod: number): Built {
  const r = rng(2000 + variant * 23)
  const bark = newBuf()
  const leaves = newBuf()
  const H = 6.2 + r() * 1
  const first = 0.9 + r() * 0.3
  tube(
    bark,
    new THREE.Vector3(0, -0.1, 0),
    new THREE.Vector3(0, H, 0),
    0.17,
    0.02,
    lod ? 5 : 7,
    0.6,
    0.9,
  )

  const step = lod ? 0.75 : 0.36
  const maxLen = 2.1 + r() * 0.3
  for (let y = first; y < H - 0.15; y += step * (0.85 + r() * 0.3)) {
    const t = (y - first) / (H - first)
    const len = maxLen * Math.pow(1 - t, 0.95) + 0.22
    const n = lod ? 4 : 5 + Math.floor(r() * 3)
    const yaw0 = r() * Math.PI * 2
    for (let i = 0; i < n; i++) {
      const a = yaw0 + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.5
      const droop = -0.12 - r() * 0.25 + t * 0.35
      const dir = new THREE.Vector3(Math.cos(a), droop, Math.sin(a)).normalize()
      const start = new THREE.Vector3(0, y, 0)
      const end = start.clone().addScaledVector(dir, len)
      if (!lod) tube(bark, start, end, 0.03, 0.008, 3, 0.5, 0.7)
      // Sprays: flat cards along the branch, needle texture growing outward
      const side = new THREE.Vector3().crossVectors(UP, dir).normalize()
      const sprays = lod ? 1 : 2
      const outward = new THREE.Vector3(dir.x, 0.6, dir.z).normalize()
      for (let k = 0; k < sprays; k++) {
        const along = lod ? 0.05 : 0.02 + k * 0.4
        const c = start.clone().addScaledVector(dir, len * along)
        const ao = 0.45 + 0.55 * (0.35 + 0.65 * t) * (0.7 + 0.3 * k)
        const w = (lod ? 1.6 : 1.1) * (0.6 + len * 0.35)
        const h = len * (lod ? 1.05 : 0.75)
        // Two crossed cards so the spray reads from the side and from above
        for (const tilt of [0.35 + (r() - 0.5) * 0.4, 1.25 + (r() - 0.5) * 0.4]) {
          const u = side.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(UP, Math.sin(tilt))
          card(leaves, c, u, dir, outward, w, h, ao, 1)
          if (lod) break
        }
      }
    }
  }
  // Tip
  const tipN = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < 2; i++) {
    const a = (i * Math.PI) / 2
    const u = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
    card(leaves, new THREE.Vector3(0, H - 0.9, 0), u, UP.clone(), tipN, 0.6, 1.1, 0.95, 1)
  }
  return {
    bark,
    leaves,
    info: {
      trunk: { radius: 0.17, height: H },
      crowns: [
        { center: new THREE.Vector3(0, first + 1.1, 0), radius: maxLen * 0.8 },
        { center: new THREE.Vector3(0, first + 2.8, 0), radius: maxLen * 0.55 },
        { center: new THREE.Vector3(0, H - 1.2, 0), radius: 0.6 },
      ],
    },
  }
}

function shrub(variant: number, lod: number): Built {
  const r = rng(3000 + variant * 29)
  const leaves = newBuf()
  const blobs = [
    { c: new THREE.Vector3(0, 0.5, 0), R: new THREE.Vector3(0.85, 0.55, 0.85) },
    { c: new THREE.Vector3(0.6, 0.38, 0.2 + variant * 0.2), R: new THREE.Vector3(0.6, 0.42, 0.6) },
  ]
  const count = lod ? 16 : 70
  for (let i = 0; i < count; i++) {
    const b = blobs[i % 2]!
    const d = randomUnit(r)
    if (d.y < -0.3) d.y = -d.y * 0.5
    const s = 0.45 + 0.55 * Math.sqrt(r())
    const p = b.c
      .clone()
      .add(new THREE.Vector3(d.x * b.R.x, d.y * b.R.y, d.z * b.R.z).multiplyScalar(s))
    const outward = d.clone().normalize()
    const face = outward.clone().add(randomUnit(r).multiplyScalar(0.8)).normalize()
    const { u, v } = cardAxes(face, r)
    const n = outward.clone().multiplyScalar(0.8).add(face.multiplyScalar(0.2)).normalize()
    const ao = (0.35 + 0.65 * s) * (0.7 + 0.3 * (outward.y * 0.5 + 0.5))
    const sz = (lod ? 0.9 : 0.5) * (0.8 + r() * 0.4)
    card(leaves, p, u, v, n, sz, sz, ao)
  }
  return {
    bark: null,
    leaves,
    info: { trunk: null, crowns: blobs.map((b) => ({ center: b.c, radius: b.R.y * 1.1 })) },
  }
}

const builtCache = new Map<string, Built>()
function built(species: Species, variant: number, lod: number) {
  const key = `${species}:${variant}:${lod}`
  let b = builtCache.get(key)
  if (!b) {
    const v = variant % VARIANTS[species]
    b =
      species === "tree" ? broadleaf(v, lod) : species === "pine" ? conifer(v, lod) : shrub(v, lod)
    builtCache.set(key, b)
  }
  return b
}

const geoCache = new Map<string, VegGeometry>()
export function vegetationGeometry(species: Species, variant: number, lod: number): VegGeometry {
  const key = `${species}:${variant}:${lod}`
  let g = geoCache.get(key)
  if (!g) {
    const b = built(species, variant, lod)
    g = { bark: b.bark ? toGeometry(b.bark) : null, leaves: toGeometry(b.leaves) }
    geoCache.set(key, g)
  }
  return g
}

export const vegetationInfo = (species: Species, variant: number) => built(species, variant, 0).info

// ---------- textures ----------

function leafCanvas(kind: "broad" | "needle") {
  const S = 512
  const c = document.createElement("canvas")
  c.width = c.height = S
  const ctx = c.getContext("2d")!
  const r = rng(kind === "broad" ? 71 : 73)
  ctx.lineCap = "round"
  const shade = (base: number, spread: number) => {
    const l = base + (r() - 0.5) * spread
    const h = 0.9 + (r() - 0.5) * 0.2
    return `rgb(${Math.round(l * 255 * (1.02 + (h - 0.9)))},${Math.round(l * 255)},${Math.round(l * 255 * 0.72)})`
  }
  if (kind === "broad") {
    // A leafy cluster: twigs from the center, leaves layered on top
    ctx.strokeStyle = "rgb(70,55,40)"
    for (let i = 0; i < 7; i++) {
      const a = r() * Math.PI * 2
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(S / 2, S / 2)
      ctx.lineTo(S / 2 + Math.cos(a) * S * 0.36, S / 2 + Math.sin(a) * S * 0.36)
      ctx.stroke()
    }
    for (let i = 0; i < 230; i++) {
      const rad = Math.pow(r(), 0.7) * S * 0.42
      const a = r() * Math.PI * 2
      const x = S / 2 + Math.cos(a) * rad
      const y = S / 2 + Math.sin(a) * rad
      const len = 22 + r() * 18
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(a + (r() - 0.5) * 1.6)
      ctx.fillStyle = shade(0.62 + (1 - rad / (S * 0.42)) * -0.12, 0.35)
      ctx.beginPath()
      ctx.ellipse(len / 2, 0, len / 2, len * (0.22 + r() * 0.1), 0, 0, Math.PI * 2)
      ctx.fill()
      // Midrib
      ctx.strokeStyle = "rgba(255,255,220,0.18)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(2, 0)
      ctx.lineTo(len - 3, 0)
      ctx.stroke()
      ctx.restore()
    }
  } else {
    // A spruce spray growing up from the bottom center
    const stem = (x0: number, y0: number, a: number, len: number, w: number, depth: number) => {
      const x1 = x0 + Math.sin(a) * len
      const y1 = y0 - Math.cos(a) * len
      ctx.strokeStyle = "rgb(80,62,44)"
      ctx.lineWidth = w
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
      const n = Math.floor(len / 2.2)
      for (let i = 1; i < n; i++) {
        const t = i / n
        const px = x0 + (x1 - x0) * t
        const py = y0 + (y1 - y0) * t
        const nl = (16 + r() * 10) * (1 - t * 0.45) * (depth ? 0.8 : 1)
        for (const s of [-1, 1]) {
          const na = a + s * (0.75 + r() * 0.35)
          ctx.strokeStyle = shade(0.5 + t * 0.12, 0.3)
          ctx.lineWidth = 3.4
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(px + Math.sin(na) * nl, py - Math.cos(na) * nl)
          ctx.stroke()
        }
      }
      if (depth < 1) {
        for (let k = 0; k < 6; k++) {
          const t = 0.12 + k * 0.13
          const s = k % 2 ? 1 : -1
          stem(
            x0 + (x1 - x0) * t,
            y0 + (y1 - y0) * t,
            a + s * (0.55 + r() * 0.3),
            len * (0.5 - k * 0.05),
            w * 0.6,
            depth + 1,
          )
        }
      }
    }
    stem(S / 2, S - 4, 0, S * 0.95, 4, 0)
  }
  return c
}

const texCache = new Map<string, THREE.Texture>()
function leafTexture(kind: "broad" | "needle") {
  let t = texCache.get(kind)
  if (!t) {
    t = new THREE.CanvasTexture(leafCanvas(kind))
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    texCache.set(kind, t)
  }
  return t
}

// ---------- materials ----------

// Gentle sway that grows with height above the base; leaves also flutter
const SWAY = /* glsl */ `
#include <begin_vertex>
{
  #if defined( USE_INSTANCING )
  vec3 vegRoot = instanceMatrix[3].xyz;
  #elif defined( USE_BATCHING )
  vec3 vegRoot = batchingMatrix[3].xyz;
  #else
  vec3 vegRoot = vec3( 0.0 );
  #endif
  float ph = dot( vegRoot.xz, vec2( 0.131, 0.173 ) );
  float hgt = max( 0.0, transformed.y - 0.6 );
  vec2 sway = vec2( sin( dTime * 0.9 + ph ), sin( dTime * 0.77 + ph * 1.3 ) ) * 0.008 * hgt * hgt;
  transformed.xz += sway;
  #ifdef VEG_LEAF
  transformed += normal * sin( dTime * 4.3 + dot( transformed, vec3( 2.1, 1.7, 2.9 ) ) + ph ) * 0.025;
  #endif
}`

// Alpha-tested foliage thins out in the mips; scale coverage back up with mip level
const ALPHA_FIX = /* glsl */ `
{
  vec2 dx = dFdx( vMapUv * 512.0 ), dy = dFdy( vMapUv * 512.0 );
  float mip = max( 0.0, 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) );
  diffuseColor.a *= 1.0 + mip * 0.28;
}
#include <alphatest_fragment>`

function vegHook(leaf: boolean) {
  return (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${DECL}${leaf ? "\n#define VEG_LEAF" : ""}`)
      .replace("#include <begin_vertex>", SWAY)
    if (leaf) {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <alphatest_fragment>", ALPHA_FIX)
        // Canopy normals are authored, don't flip them on back faces
        .replace(
          "#include <aomap_fragment>",
          `#include <aomap_fragment>
#ifdef USE_FOG
{
  // Light through the leaves: strongest looking toward the sun
  float back = pow( max( dot( normalize( vFogRay ), dSunDir ), 0.0 ), 3.0 );
  reflectedLight.indirectDiffuse += diffuseColor.rgb * dSunColor * ( 14.0 * back + 4.5 );
}
#endif`,
        )
        .replace(
          "#include <normal_fragment_begin>",
          "#include <normal_fragment_begin>\nnormal = normalize( vNormal );",
        )
    }
  }
}

function depthMaterial(map: THREE.Texture | null) {
  const m = new THREE.MeshDepthMaterial({ map, alphaTest: map ? 0.5 : 0, side: THREE.DoubleSide })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.dTime = shared.dTime
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nuniform float dTime;${map ? "\n#define VEG_LEAF" : ""}`,
      )
      .replace("#include <begin_vertex>", SWAY.replace(/#ifdef VEG_LEAF[\s\S]*?#endif/, ""))
    if (map)
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <alphatest_fragment>",
        ALPHA_FIX,
      )
  }
  return m
}

const matCache = new Map<string, THREE.MeshStandardMaterial>()

export function leafMaterial(species: Species, color: string) {
  const key = `leaf:${species}:${color}`
  let m = matCache.get(key)
  if (m) return m
  const map = leafTexture(species === "pine" ? "needle" : "broad")
  m = new THREE.MeshStandardMaterial({
    map,
    color,
    // Binary cutout; TAA resolves the edges. (Alpha to coverage needs MSAA,
    // which the pipeline doesn't use.)
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    roughness: 0.78,
    metalness: 0,
    vertexColors: true,
  })
  m.userData.depthMaterial = depthMaterial(map)
  patchMaterial(m, vegHook(true), "leaf")
  matCache.set(key, m)
  return m
}

export function barkMaterial() {
  const key = "bark"
  let m = matCache.get(key)
  if (m) return m
  const t = presetTextures("bark")
  const map = t.map.clone()
  const bump = t.bump.clone()
  map.repeat.set(1 / 1.2, 1 / 1.2)
  bump.repeat.copy(map.repeat)
  m = new THREE.MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 2,
    color: "#a89a8a",
    roughness: 0.95,
    vertexColors: true,
  })
  m.userData.depthMaterial = depthMaterial(null)
  patchMaterial(m, vegHook(false), "bark")
  matCache.set(key, m)
  return m
}
