import * as THREE from "three"
import type { MapFile, Material } from "../map/schema"
import { presetDef, presetTextures } from "./materials"
import { noiseTexture } from "./noise-texture"
import { DECL, patchMaterial } from "./shading"

/** Ground-level object footprint, used to keep grass out and wear dirt in. */
export type Footprint = {
  /** World to part-local transform. */
  inv: THREE.Matrix4
  /** Local bounding box of the part geometry. */
  box: THREE.Box3
  /** World-space XZ bounds. */
  min: THREE.Vector2
  max: THREE.Vector2
  /** World Y of the footprint plane. */
  y: number
  round: boolean
  /** How much this object wears the ground around it, 0..1. */
  wear: number
}

export type GroundData = {
  size: number
  /** R: covered by an object, G: worn ground. */
  mask: THREE.DataTexture
  height: THREE.DataTexture
  heightRes: number
  preset: string
  tint: THREE.Color
  tile: number
}

// ---------- CPU masks ----------

function boxBlur(src: Float32Array, n: number, r: number) {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const w = 2 * r + 1
  for (let y = 0; y < n; y++) {
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[y * n + Math.min(n - 1, Math.max(0, x))]!
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = acc / w
      acc += src[y * n + Math.min(n - 1, x + r + 1)]! - src[y * n + Math.max(0, x - r)]!
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(n - 1, Math.max(0, y)) * n + x]!
    for (let y = 0; y < n; y++) {
      out[y * n + x] = acc / w
      acc += tmp[Math.min(n - 1, y + r + 1) * n + x]! - tmp[Math.max(0, y - r) * n + x]!
    }
  }
  return out
}

export function buildGroundData(
  map: MapFile,
  groundHeight: (x: number, z: number) => number,
  footprints: Footprint[],
  spawns: THREE.Vector3[],
): GroundData {
  const g = map.environment.ground
  const size = g.size
  const half = size / 2
  const n = Math.min(1024, Math.ceil(size / 0.5))
  const texel = size / n
  const cover = new Float32Array(n * n)
  const wearSrc = new Float32Array(n * n)
  const p = new THREE.Vector3()

  for (const f of footprints) {
    const i0 = Math.max(0, Math.floor((f.min.x + half) / texel))
    const i1 = Math.min(n - 1, Math.ceil((f.max.x + half) / texel))
    const j0 = Math.max(0, Math.floor((f.min.y + half) / texel))
    const j1 = Math.min(n - 1, Math.ceil((f.max.y + half) / texel))
    const b = f.box
    const cx = (b.min.x + b.max.x) / 2
    const cz = (b.min.z + b.max.z) / 2
    const rx = (b.max.x - b.min.x) / 2 + texel * 0.3
    const rz = (b.max.z - b.min.z) / 2 + texel * 0.3
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        p.set((i + 0.5) * texel - half, f.y, (j + 0.5) * texel - half).applyMatrix4(f.inv)
        const dx = (p.x - cx) / rx
        const dz = (p.z - cz) / rz
        const inside = f.round ? dx * dx + dz * dz <= 1 : Math.abs(dx) <= 1 && Math.abs(dz) <= 1
        if (!inside) continue
        const k = j * n + i
        cover[k] = 1
        wearSrc[k] = Math.max(wearSrc[k]!, f.wear)
      }
    }
  }

  // Wear spreads around footprints, plus trampled circles at spawns
  const r = Math.max(1, Math.round(1.2 / texel))
  const wear = boxBlur(boxBlur(wearSrc, n, r), n, r)
  for (const s of spawns) {
    const R = 4
    const i0 = Math.max(0, Math.floor((s.x - R + half) / texel))
    const i1 = Math.min(n - 1, Math.ceil((s.x + R + half) / texel))
    const j0 = Math.max(0, Math.floor((s.z - R + half) / texel))
    const j1 = Math.min(n - 1, Math.ceil((s.z + R + half) / texel))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot((i + 0.5) * texel - half - s.x, (j + 0.5) * texel - half - s.z)
        const t = Math.min(1, Math.max(0, (R - d) / (R - 1.5)))
        const k = j * n + i
        wear[k] = Math.max(wear[k]!, t * t * (3 - 2 * t) * 0.85)
      }
    }
  }

  const maskData = new Uint8Array(n * n * 2)
  for (let k = 0; k < n * n; k++) {
    maskData[k * 2] = cover[k]! * 255
    maskData[k * 2 + 1] = Math.min(1, wear[k]! * 1.6) * 255
  }
  const mask = new THREE.DataTexture(maskData, n, n, THREE.RGFormat, THREE.UnsignedByteType)
  mask.magFilter = mask.minFilter = THREE.LinearFilter
  mask.unpackAlignment = 1
  mask.needsUpdate = true

  const hn = Math.min(512, Math.ceil(size / 1.2))
  const hData = new Uint16Array(hn * hn)
  const ht = size / hn
  for (let j = 0; j < hn; j++)
    for (let i = 0; i < hn; i++)
      hData[j * hn + i] = THREE.DataUtils.toHalfFloat(
        groundHeight((i + 0.5) * ht - half, (j + 0.5) * ht - half),
      )
  const height = new THREE.DataTexture(hData, hn, hn, THREE.RedFormat, THREE.HalfFloatType)
  height.magFilter = height.minFilter = THREE.LinearFilter
  height.unpackAlignment = 1
  height.needsUpdate = true

  const desc: Exclude<Material, string> =
    typeof g.material === "string" ? { preset: g.material } : g.material
  const preset = desc.preset ?? "grass"
  return {
    size,
    mask,
    height,
    heightRes: hn,
    preset,
    tint: new THREE.Color(desc.color ?? "#ffffff"),
    tile: desc.tileSize ?? presetDef(preset).tileSize,
  }
}

// ---------- shared GLSL ----------

/**
 * Ground cover weights. Used by both terrain and grass so blades grow exactly
 * where the terrain shows grass. `fd` is dirt, `fr` is rock.
 */
const COVER = /* glsl */ `
void tCover(vec2 p, vec2 msk, float slope, out float fd, out float fr, out vec4 nz) {
  nz = texture(dNoise, p / 173.0);
  vec4 nz2 = texture(dNoise, p / 41.0);
  float dirt = msk.g * (0.7 + 0.6 * nz2.b) + smoothstep(0.74, 0.9, nz.b) * 0.9;
  fd = clamp(dirt, 0.0, 1.0);
  fr = smoothstep(0.26, 0.48, slope + (nz2.r - 0.5) * 0.18);
}
`

// ---------- terrain material ----------

export function terrainMaterial(data: GroundData) {
  const splat = data.preset === "grass"
  const layers = [data.preset, splat ? "dirt" : data.preset, "rock"]
  const tex = layers.map(presetTextures)
  const defs = layers.map(presetDef)
  const uniforms = {
    tMap0: { value: tex[0]!.map },
    tMap1: { value: tex[1]!.map },
    tMap2: { value: tex[2]!.map },
    tH0: { value: tex[0]!.bump },
    tH1: { value: tex[1]!.bump },
    tH2: { value: tex[2]!.bump },
    tMask: { value: data.mask },
    tTile: {
      value: new THREE.Vector3(1 / data.tile, 1 / defs[1]!.tileSize, 1 / defs[2]!.tileSize),
    },
    tRough: {
      value: new THREE.Vector3(defs[0]!.roughness, defs[1]!.roughness, defs[2]!.roughness),
    },
    tBump: { value: new THREE.Vector3(defs[0]!.bump, defs[1]!.bump, defs[2]!.bump) },
    tTint: { value: data.tint },
    tGround: { value: new THREE.Vector2(data.size / 2, 1 / data.size) },
  }
  noiseTexture()
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 })
  if (splat) mat.defines = { TERRAIN_SPLAT: "" }
  return patchMaterial(
    mat,
    (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;",
        )
        .replace(
          "#include <worldpos_vertex>",
          `#include <worldpos_vertex>
vTWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vTNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          /* glsl */ `#include <common>
uniform sampler2D tMap0, tMap1, tMap2, tH0, tH1, tH2, tMask;
uniform vec3 tTile, tRough, tBump, tTint;
uniform vec2 tGround;
varying vec3 vTWorld;
varying vec3 vTNormal;
float tHeight, tRoughness, tBumpScale;
// Two rotated samples at different scales, blended by noise, hide tiling.
vec3 tLayer(sampler2D cm, sampler2D hm, vec2 p, float tile, float b, out float h) {
  vec2 uvA = p * tile;
  vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * p * tile * 0.37 + 0.31;
  h = mix(texture(hm, uvA).r, texture(hm, uvB).r, b);
  return mix(texture(cm, uvA).rgb, texture(cm, uvB).rgb, b);
}
vec3 tPerturb(vec3 pos, vec3 n, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(pos));
  vec3 sy = normalize(dFdy(pos));
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * n - grad);
}`,
        )
        .replace("#include <lights_pars_begin>", "#include <lights_pars_begin>\n" + COVER)
        .replace(
          "#include <map_fragment>",
          /* glsl */ `{
  vec2 tp = vTWorld.xz;
  vec2 msk = texture(tMask, tp * tGround.y + 0.5).rg;
  float slope = 1.0 - clamp(normalize(vTNormal).y, 0.0, 1.0);
  float fd, fr; vec4 nz;
  tCover(tp, msk, slope, fd, fr, nz);
  float tb = smoothstep(0.3, 0.7, texture(dNoise, tp / 29.0).g);
  float h0, h1, h2;
  vec3 c0 = tLayer(tMap0, tH0, tp, tTile.x, tb, h0);
  vec3 c2 = tLayer(tMap2, tH2, tp, tTile.z, tb, h2);
  float macro = 0.84 + 0.32 * nz.a;
  #ifdef TERRAIN_SPLAT
    vec3 c1 = tLayer(tMap1, tH1, tp, tTile.y, tb, h1);
    float dry = smoothstep(0.35, 0.85, nz.r);
    c0 *= mix(vec3(0.86, 1.04, 0.84), vec3(1.22, 1.08, 0.72), dry);
    // Height-aware blend so dirt shows between grass tufts first
    fd = smoothstep(0.4, 0.6, fd + (h1 - h0) * 0.35);
    vec3 col = mix(c0, c1, fd);
    float hh = mix(h0, h1, fd);
  #else
    fd = 0.0;
    vec3 col = c0;
    float hh = h0;
  #endif
  fr = smoothstep(0.4, 0.6, fr + (h2 - hh) * 0.3);
  col = mix(col * macro, c2 * (0.9 + 0.2 * nz.g), fr);
  tHeight = mix(hh, h2, fr);
  tRoughness = mix(mix(tRough.x, tRough.y, fd), tRough.z, fr);
  tBumpScale = mix(mix(tBump.x, tBump.y, fd), tBump.z, fr);
  diffuseColor.rgb *= col * tTint;
}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "float roughnessFactor = roughness * tRoughness;",
        )
        .replace(
          "#include <normal_fragment_maps>",
          "normal = tPerturb( -vViewPosition, normal, vec2( dFdx( tHeight ), dFdy( tHeight ) ) * tBumpScale, faceDirection );",
        )
    },
    `terrain:${splat}`,
  )
}

// ---------- grass ----------

export type GrassQuality = {
  near: { spacing: number; radius: number }
  far: { spacing: number; radius: number }
} | null

function bladeGeometry() {
  const levels = 4
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i < levels; i++) {
    const t = i / levels
    pos.push(-1, t, 0, 1, t, 0)
  }
  pos.push(0, 1, 0)
  for (let i = 0; i < levels - 1; i++) {
    const a = i * 2
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const top = (levels - 1) * 2
  idx.push(top, top + 1, levels * 2)
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(pos.length), 3))
  g.setIndex(idx)
  return g
}

const GRASS_VERT = /* glsl */ `
uniform sampler2D gHeight, gMask;
uniform vec3 gGround; // size, 1/size, height texel in uv
uniform vec2 gOrigin;
uniform float gSpacing, gCount, gInner, gOuter, gWidth, gBladeH;
uniform vec3 gWind;   // xy direction the wind blows toward, z strength
uniform vec4 gDrone;  // xyz position, w downwash strength
uniform vec3 gCamFwd;
uniform vec3 gBase;
varying vec3 vGColor;
uvec2 gHash(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v;
}
`

const GRASS_MAIN = /* glsl */ `
vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );
vec3 gPos;
{
  int N = int( gCount );
  ivec2 cell = ivec2( floor( gOrigin / gSpacing ) ) + ivec2( gl_InstanceID % N, gl_InstanceID / N ) - N / 2;
  uvec2 hs = gHash( uvec2( cell + 32768 ) );
  vec4 r = vec4( hs.x & 0xffffu, hs.x >> 16u, hs.y & 0xffffu, hs.y >> 16u ) / 65535.0;
  vec2 p = ( vec2( cell ) + r.xy ) * gSpacing;
  float dist = distance( p, cameraPosition.xz );
  float fade = ( gInner > 0.0 ? smoothstep( gInner * 0.8, gInner, dist ) : 1.0 ) * ( 1.0 - smoothstep( gOuter * 0.7, gOuter, dist ) );

  vec2 tuv = p * gGround.y + 0.5;
  vec2 msk = texture( gMask, tuv ).rg;
  float e = gGround.z;
  float hC = texture( gHeight, tuv ).r;
  float hx = texture( gHeight, tuv + vec2( e, 0.0 ) ).r - texture( gHeight, tuv - vec2( e, 0.0 ) ).r;
  float hz = texture( gHeight, tuv + vec2( 0.0, e ) ).r - texture( gHeight, tuv - vec2( 0.0, e ) ).r;
  vec3 gNorm = normalize( vec3( -hx, 2.0 * e * gGround.x, -hz ) );
  float fd, fr; vec4 nz;
  tCover( p, msk, 1.0 - gNorm.y, fd, fr, nz );
  float clump = texture( dNoise, p / 6.0 ).g;
  float keep = ( 1.0 - smoothstep( 0.25, 0.6, fd ) ) * ( 1.0 - fr ) * ( 1.0 - msk.r ) * fade * ( 0.35 + 0.65 * smoothstep( 0.2, 0.55, clump ) );
  float s = clamp( ( keep - r.z ) * 5.0, 0.0, 1.0 );

  vec3 root = vec3( p.x, hC, p.y );
  vec3 toB = root - cameraPosition;
  if ( s <= 0.0 || ( dot( toB, gCamFwd ) < -2.0 ) ) {
    gPos = vec3( 0.0, -1e4, 0.0 );
    vGColor = vec3( 0.0 );
  } else {
    float rh = fract( r.x * 7.31 + r.w * 3.17 );
    float h = gBladeH * ( 0.55 + 0.9 * rh ) * ( 0.6 + 0.7 * clump ) * s;
    float w = gWidth * ( 0.75 + 0.5 * r.x );
    float yaw = r.w * 6.2831853;
    vec3 right = vec3( cos( yaw ), 0.0, sin( yaw ) );
    vec3 face = vec3( -right.z, 0.0, right.x );

    // Bend: random lean, wind sway with travelling gusts, downwash from the quad
    vec2 B = face.xz * ( r.y - 0.5 ) * 0.7;
    float gust = texture( dNoise, p / 37.0 - gWind.xy * dTime * 0.12 ).r;
    float sway = sin( dTime * ( 1.7 + r.y ) + dot( p, gWind.xy ) * 0.35 + r.x * 6.28 ) * 0.5 + 0.5;
    B += gWind.xy * gWind.z * ( 0.2 + 0.9 * gust ) * ( 0.65 + 0.35 * sway );
    vec2 dd = p - gDrone.xz;
    float dl = length( dd );
    float above = gDrone.y - hC;
    float wash = gDrone.w * ( 1.0 - smoothstep( 0.0, 3.5, dl ) ) * ( 1.0 - smoothstep( 0.2, 4.0, above ) );
    B += dd / max( dl, 0.05 ) * wash * ( 1.3 + 0.5 * sin( dTime * 37.0 + r.x * 40.0 ) );
    float bl = length( B );
    if ( bl > 1.4 ) B *= 1.4 / bl;
    float b2 = dot( B, B );

    float side = position.x;
    float t = position.y;
    gPos = root + right * side * w * ( 1.0 - t ) * 0.5;
    gPos.y += h * t * ( 1.0 - 0.3 * b2 * t );
    gPos.xz += B * h * t * t * 0.9;

    vec3 rounded = normalize( face + right * side * 0.7 + vec3( B.x, 0.0, B.y ) * 0.4 );
    objectNormal = normalize( mix( rounded, gNorm, 0.6 ) );

    float dry = smoothstep( 0.35, 0.85, nz.r );
    vec3 c = gBase * mix( vec3( 0.86, 1.04, 0.84 ), vec3( 1.22, 1.08, 0.72 ), dry ) * ( 0.84 + 0.32 * nz.a );
    c *= 0.85 + 0.3 * r.z;
    vec3 tip = c * vec3( 1.15, 1.1, 0.75 );
    vGColor = mix( c * 0.4, tip, t ) * mix( 1.0, 1.25, t * t );
  }
}
`

export class GrassField {
  readonly group = new THREE.Group()
  private meshes: THREE.Mesh[] = []
  private uniforms = {
    gHeight: { value: null as THREE.Texture | null },
    gMask: { value: null as THREE.Texture | null },
    gGround: { value: new THREE.Vector3() },
    gWind: { value: new THREE.Vector3() },
    gDrone: { value: new THREE.Vector4() },
    gCamFwd: { value: new THREE.Vector3() },
    gBase: { value: new THREE.Color() },
  }
  private quality: GrassQuality = null
  private tmp = new THREE.Vector3()
  private enabled: boolean

  constructor(private data: GroundData) {
    this.enabled = data.preset === "grass"
    this.uniforms.gHeight.value = data.height
    this.uniforms.gMask.value = data.mask
    this.uniforms.gGround.value.set(data.size, 1 / data.size, 1 / data.heightRes)
    // Average color of the grass texture, so blades match the ground
    this.uniforms.gBase.value.setRGB(0.062, 0.105, 0.016).multiply(data.tint)
    this.group.name = "grass"
  }

  setQuality(q: GrassQuality) {
    for (const m of this.meshes) {
      this.group.remove(m)
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
    this.meshes = []
    this.quality = q
    if (!q || !this.enabled) return
    const blade = bladeGeometry()
    const rings = [
      { ...q.near, inner: 0, width: 0.05, height: 0.26 },
      {
        ...q.far,
        inner: q.near.radius,
        width: 0.05 * (q.far.spacing / q.near.spacing),
        height: 0.28,
      },
    ]
    for (const ring of rings) {
      const count = Math.ceil((ring.radius * 2) / ring.spacing)
      const local = {
        gOrigin: { value: new THREE.Vector2() },
        gSpacing: { value: ring.spacing },
        gCount: { value: count },
        gInner: { value: ring.inner },
        gOuter: { value: ring.radius },
        gWidth: { value: ring.width },
        gBladeH: { value: ring.height },
      }
      const geo = blade.clone()
      geo.instanceCount = count * count
      const mat = new THREE.MeshStandardMaterial({
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0,
      })
      patchMaterial(
        mat,
        (shader) => {
          Object.assign(shader.uniforms, this.uniforms, local)
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", `#include <common>\n${DECL}\n${GRASS_VERT}\n${COVER}`)
            .replace("#include <beginnormal_vertex>", GRASS_MAIN)
            .replace("#include <begin_vertex>", "vec3 transformed = gPos;")
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vGColor;")
            .replace("#include <color_fragment>", "diffuseColor.rgb *= vGColor;")
            .replace(
              "#include <normal_fragment_begin>",
              "#include <normal_fragment_begin>\nnormal = normalize( vNormal );",
            )
        },
        "grass",
      )
      const mesh = new THREE.Mesh(geo, mat)
      mesh.frustumCulled = false
      mesh.receiveShadow = true
      mesh.castShadow = false
      mesh.userData.origin = local.gOrigin.value
      mesh.userData.radius = ring.radius
      this.meshes.push(mesh)
      this.group.add(mesh)
    }
    blade.dispose()
  }

  update(
    cam: THREE.Camera,
    groundHeight: (x: number, z: number) => number,
    wind: THREE.Vector2,
    drone: THREE.Vector3,
    wash: number,
  ) {
    if (!this.quality) return
    const cp = cam.getWorldPosition(this.tmp)
    const above = cp.y - groundHeight(cp.x, cp.z)
    cam.getWorldDirection(this.uniforms.gCamFwd.value)
    const ws = wind.length()
    if (ws > 1e-3) this.uniforms.gWind.value.set(wind.x / ws, wind.y / ws, Math.min(1, ws / 9))
    else this.uniforms.gWind.value.set(1, 0, 0)
    this.uniforms.gDrone.value.set(drone.x, drone.y, drone.z, wash)
    for (const m of this.meshes) {
      ;(m.userData.origin as THREE.Vector2).set(cp.x, cp.z)
      m.visible = above < (m.userData.radius as number) * 0.8
    }
  }

  dispose() {
    this.setQuality(null)
  }
}
