import * as THREE from "three"
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import type RAPIER from "@dimforge/rapier3d-compat"
import { getMaterial, solidMaterial } from "../render/materials"
import { patchTree } from "../render/shading"
import {
  buildGroundData,
  terrainMaterial,
  type Footprint,
  type GroundData,
} from "../render/terrain"
import { fbm, rng } from "./noise"
import type { MapFile, MapObject } from "./schema"

type R = typeof RAPIER

type GeoDesc =
  | { kind: "box"; size: [number, number, number]; worldUv: boolean }
  | { kind: "cylinder"; r: number; rt: number; h: number; seg: number; worldUv: boolean }
  | { kind: "sphere"; r: number }
  | { kind: "blob"; r: number; detail: number; seed: number; squash: number }
  | { kind: "ramp"; size: [number, number, number] }
  | { kind: "pipe"; r: number; t: number; len: number }
  | { kind: "ring"; r: number; tube: number }

type Part = {
  geo: GeoDesc
  material: THREE.Material
  matrix: THREE.Matrix4
  collide: boolean
  /** Use a simpler collider than the visual shape (e.g. foliage as ball). */
  collider?: "ball" | "hull"
}

export type BuiltMap = {
  group: THREE.Group
  spawns: { position: THREE.Vector3; yaw: number }[]
  groundHeight: (x: number, z: number) => number
  map: MapFile
  ground: GroundData
  stats: { parts: number; drawCalls: number; colliders: number }
}

const DEG = Math.PI / 180

function transform(position: number[], rotation: number[], scale = 1) {
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      (rotation[0] ?? 0) * DEG,
      (rotation[1] ?? 0) * DEG,
      (rotation[2] ?? 0) * DEG,
      "YXZ",
    ),
  )
  m.compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    q,
    new THREE.Vector3(scale, scale, scale),
  )
  return m
}

// ---------- geometry ----------

function scaleBoxUvs(g: THREE.BufferGeometry, [x, y, z]: [number, number, number]) {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z, 4 vertices each
  const dims: [number, number][] = [
    [z, y],
    [z, y],
    [x, z],
    [x, z],
    [x, y],
    [x, y],
  ]
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v
      uv.setXY(i, uv.getX(i) * dims[f]![0], uv.getY(i) * dims[f]![1])
    }
  }
}

function scaleUvs(g: THREE.BufferGeometry, su: number, sv: number) {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
}

function buildGeometry(d: GeoDesc): THREE.BufferGeometry {
  switch (d.kind) {
    case "box": {
      const g = new THREE.BoxGeometry(...d.size)
      if (d.worldUv) scaleBoxUvs(g, d.size)
      g.translate(0, d.size[1] / 2, 0)
      return g
    }
    case "cylinder": {
      const g = new THREE.CylinderGeometry(d.rt, d.r, d.h, d.seg)
      if (d.worldUv) scaleUvs(g, 2 * Math.PI * d.r, d.h)
      g.translate(0, d.h / 2, 0)
      return g
    }
    case "sphere": {
      const g = new THREE.SphereGeometry(d.r, 24, 16)
      scaleUvs(g, 2 * Math.PI * d.r, Math.PI * d.r)
      return g
    }
    case "blob": {
      let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(d.r, d.detail)
      g.deleteAttribute("normal")
      g.deleteAttribute("uv")
      g = mergeVertices(g)
      const pos = g.getAttribute("position") as THREE.BufferAttribute
      const r = rng(d.seed)
      const jitter = Array.from({ length: pos.count }, () => 0.82 + r() * 0.3)
      for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(
          i,
          pos.getX(i) * jitter[i]!,
          pos.getY(i) * jitter[i]! * d.squash,
          pos.getZ(i) * jitter[i]!,
        )
      }
      g = g.toNonIndexed()
      g.computeVertexNormals()
      return g
    }
    case "ramp": {
      const [w, h, l] = d.size
      const shape = new THREE.Shape()
      // Profile in the (z, y) plane, extruded along x. Rises toward -Z.
      shape.moveTo(l / 2, 0)
      shape.lineTo(-l / 2, 0)
      shape.lineTo(-l / 2, h)
      shape.closePath()
      const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false })
      g.rotateY(-Math.PI / 2)
      g.translate(w / 2, 0, 0)
      g.computeVertexNormals()
      return g
    }
    case "pipe": {
      const shape = new THREE.Shape()
      shape.absarc(0, 0, d.r, 0, Math.PI * 2, false)
      const hole = new THREE.Path()
      hole.absarc(0, 0, d.r - d.t, 0, Math.PI * 2, true)
      shape.holes.push(hole)
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: d.len,
        bevelEnabled: false,
        curveSegments: 32,
      })
      g.translate(0, d.r, -d.len / 2)
      return g
    }
    case "ring": {
      const g = new THREE.TorusGeometry(d.r, d.tube, 16, 48)
      scaleUvs(g, 2 * Math.PI * d.r, 2 * Math.PI * d.tube)
      return g
    }
  }
}

// ---------- emitting parts ----------

type Ctx = {
  parts: Part[]
  groundHeight: (x: number, z: number) => number
}

const BARK = () => solidMaterial("#4b3a2a", 0.95)
const LEAVES = ["#3f5a26", "#4a6a2c", "#365022", "#56702f"]
const PINE = ["#2b4424", "#31502a", "#28401f"]

function prefabParts(obj: Extract<MapObject, { type: "prefab" }>, m: THREE.Matrix4, ctx: Ctx) {
  const seed = obj.seed ?? Math.floor(Math.abs(m.elements[12]! * 13.1 + m.elements[14]! * 7.7))
  const r = rng(seed + 1)
  const variant = seed % 4
  const add = (
    geo: GeoDesc,
    material: THREE.Material,
    local: THREE.Matrix4,
    collider?: "ball" | "hull",
    collide = obj.collide,
  ) => ctx.parts.push({ geo, material, matrix: m.clone().multiply(local), collide, collider })
  const at = (x: number, y: number, z: number, ry = 0) => transform([x, y, z], [0, ry, 0])

  switch (obj.prefab) {
    case "tree": {
      add(
        { kind: "cylinder", r: 0.2, rt: 0.12, h: 3.2, seg: 8, worldUv: false },
        BARK(),
        at(0, 0, 0),
      )
      const leaf = solidMaterial(obj.color ?? LEAVES[variant]!, 0.9, 0, true)
      const blobs: [number, number, number, number][] = [
        [0, 3.8, 0, 1.9],
        [0.9, 3.2, 0.3, 1.3],
        [-0.7, 3.4, -0.6, 1.4],
        [0.2, 4.8, -0.2, 1.3],
      ]
      blobs.forEach(([x, y, z, rad], i) =>
        add(
          { kind: "blob", r: rad, detail: 1, seed: variant * 10 + i, squash: 0.85 },
          leaf,
          at(x, y, z),
          "ball",
        ),
      )
      break
    }
    case "pine": {
      add(
        { kind: "cylinder", r: 0.16, rt: 0.1, h: 2.4, seg: 8, worldUv: false },
        BARK(),
        at(0, 0, 0),
      )
      const mat = solidMaterial(obj.color ?? PINE[variant % 3]!, 0.9, 0, true)
      const tiers: [number, number, number][] = [
        [1.0, 2.0, 2.6],
        [2.4, 1.55, 2.3],
        [3.7, 1.1, 2.1],
        [4.9, 0.7, 1.8],
      ]
      tiers.forEach(([y, rad, h]) =>
        add(
          { kind: "cylinder", r: rad, rt: 0, h, seg: 9, worldUv: false },
          mat,
          at(0, y, 0, r() * 360),
          "hull",
        ),
      )
      break
    }
    case "bush": {
      const mat = solidMaterial(obj.color ?? LEAVES[(variant + 1) % 4]!, 0.9, 0, true)
      add(
        { kind: "blob", r: 0.8, detail: 1, seed: variant, squash: 0.7 },
        mat,
        at(0, 0.45, 0),
        "ball",
      )
      add(
        { kind: "blob", r: 0.6, detail: 1, seed: variant + 5, squash: 0.7 },
        mat,
        at(0.6, 0.35, 0.2),
        "ball",
      )
      break
    }
    case "rock": {
      const mat = getMaterial({
        preset: "concrete",
        color: obj.color ?? "#8a8780",
        roughness: 0.95,
      })
      add(
        { kind: "blob", r: 1, detail: 0, seed: variant + 40, squash: 0.65 },
        mat,
        at(0, 0.3, 0),
        "hull",
      )
      break
    }
    case "container": {
      const mat = getMaterial({
        preset: "metal",
        color: obj.color ?? "#2f6f9f",
        metalness: 0.5,
        roughness: 0.55,
        tileSize: 1.2,
      })
      add({ kind: "box", size: [2.44, 2.59, 6.06], worldUv: true }, mat, at(0, 0, 0))
      break
    }
    case "pole": {
      add(
        { kind: "cylinder", r: 0.14, rt: 0.1, h: 9, seg: 12, worldUv: true },
        getMaterial("concrete"),
        at(0, 0, 0),
      )
      add(
        { kind: "box", size: [2.2, 0.12, 0.12], worldUv: false },
        solidMaterial("#555555", 0.6, 0.6),
        at(0, 8.3, 0),
      )
      break
    }
    case "lamppost": {
      const metal = solidMaterial(obj.color ?? "#3a3d40", 0.5, 0.7)
      add(
        { kind: "cylinder", r: 0.09, rt: 0.06, h: 6, seg: 10, worldUv: false },
        metal,
        at(0, 0, 0),
      )
      add({ kind: "box", size: [0.08, 0.08, 1.4], worldUv: false }, metal, at(0, 5.9, -0.65))
      add(
        { kind: "box", size: [0.3, 0.12, 0.5], worldUv: false },
        solidMaterial("#dddddd", 0.3, 0.2),
        at(0, 5.78, -1.3),
      )
      break
    }
    case "barrier": {
      const mat = getMaterial("concrete")
      add({ kind: "box", size: [0.6, 0.35, 3], worldUv: true }, mat, at(0, 0, 0))
      add({ kind: "box", size: [0.25, 0.5, 3], worldUv: true }, mat, at(0, 0.35, 0))
      break
    }
    case "barrel": {
      const mat = getMaterial({
        preset: "metal",
        color: obj.color ?? "#9b2a1f",
        roughness: 0.5,
        metalness: 0.5,
        tileSize: 0.4,
      })
      add(
        { kind: "cylinder", r: 0.29, rt: 0.29, h: 0.88, seg: 20, worldUv: true },
        mat,
        at(0, 0, 0),
      )
      break
    }
    case "pallet": {
      const wood = getMaterial({ preset: "wood", color: "#c8a878" })
      add({ kind: "box", size: [1.2, 0.03, 1.0], worldUv: true }, wood, at(0, 0.12, 0))
      for (const x of [-0.55, 0, 0.55])
        add({ kind: "box", size: [0.1, 0.12, 1.0], worldUv: true }, wood, at(x, 0, 0))
      break
    }
    case "tire": {
      add({ kind: "ring", r: 0.3, tube: 0.12 }, solidMaterial("#1c1c1c", 0.9), at(0, 0.42, 0))
      break
    }
    case "building": {
      const [w, h, d] = obj.size ?? [12, 9, 10]
      const wall = getMaterial({ preset: "plaster", color: obj.color ?? "#d8d2c4" })
      add({ kind: "box", size: [w, h, d], worldUv: true }, wall, at(0, 0, 0))
      add(
        { kind: "box", size: [w + 0.3, 0.5, d + 0.3], worldUv: true },
        getMaterial("concrete"),
        at(0, h, 0),
      )
      const glass = getMaterial("glass")
      const floors = Math.max(1, Math.floor(h / 3))
      const winW = 1.4
      const winH = 1.5
      for (let f = 0; f < floors; f++) {
        const y = f * 3 + 1
        if (y + winH > h - 0.3) break
        for (const [len, face] of [
          [w, 0],
          [d, 1],
        ] as const) {
          const n = Math.max(1, Math.floor((len - 1) / 3))
          for (let k = 0; k < n; k++) {
            const o = -len / 2 + (len / n) * (k + 0.5)
            for (const side of [-1, 1]) {
              const local =
                face === 0 ? at(o, y, side * (d / 2 + 0.02)) : at(side * (w / 2 + 0.02), y, o, 90)
              add(
                { kind: "box", size: [winW, winH, 0.06], worldUv: false },
                glass,
                local,
                undefined,
                false,
              )
            }
          }
        }
      }
      break
    }
  }
}

function emit(obj: MapObject, parent: THREE.Matrix4, ctx: Ctx) {
  switch (obj.type) {
    case "group": {
      const m = parent.clone().multiply(transform(obj.position, obj.rotation))
      for (const c of obj.children) emit(c, m, ctx)
      return
    }
    case "array": {
      for (let k = 0; k < obj.count; k++) {
        const p = obj.position.map((v, i) => v + obj.offset[i]! * k)
        const r = obj.rotation.map((v, i) => v + obj.rotationStep[i]! * k)
        emit(obj.object, parent.clone().multiply(transform(p, r)), ctx)
      }
      return
    }
    case "scatter": {
      const r = rng(obj.seed)
      for (let k = 0; k < obj.count; k++) {
        let x = 0
        let z = 0
        let ok = false
        for (let tries = 0; tries < 12 && !ok; tries++) {
          x = obj.center[0] + (r() - 0.5) * obj.size[0]
          z = obj.center[2] + (r() - 0.5) * obj.size[1]
          ok = obj.avoid.every((a) => Math.hypot(x - a.center[0], z - a.center[2]) > a.radius)
        }
        if (!ok) continue
        const y = obj.center[1] + ctx.groundHeight(x, z)
        const yaw = obj.randomYaw ? r() * 360 : 0
        const s = obj.scaleRange[0] + r() * (obj.scaleRange[1] - obj.scaleRange[0])
        emit(obj.object, parent.clone().multiply(transform([x, y, z], [0, yaw, 0], s)), ctx)
      }
      return
    }
  }

  const m = parent.clone().multiply(transform(obj.position, obj.rotation))
  const mat = () => getMaterial(obj.material, "concrete")
  const push = (geo: GeoDesc, material = mat()) =>
    ctx.parts.push({ geo, material, matrix: m, collide: obj.collide })

  switch (obj.type) {
    case "box":
      return push({ kind: "box", size: obj.size, worldUv: true })
    case "cylinder":
      return push({
        kind: "cylinder",
        r: obj.radius,
        rt: obj.radiusTop ?? obj.radius,
        h: obj.height,
        seg: 32,
        worldUv: true,
      })
    case "sphere":
      return push({ kind: "sphere", r: obj.radius })
    case "ramp":
      return push({ kind: "ramp", size: obj.size })
    case "pipe":
      return push({ kind: "pipe", r: obj.radius, t: obj.thickness, len: obj.length })
    case "ring":
      return push({ kind: "ring", r: obj.radius, tube: obj.tube })
    case "frame": {
      const { width: w, height: h, thickness: t, depth: d } = obj
      const material = getMaterial(obj.material, "painted")
      const bars: [number, number, number, number, number, number][] = [
        [-(w / 2 + t / 2), 0, 0, t, h + t, d],
        [w / 2 + t / 2, 0, 0, t, h + t, d],
        [0, h, 0, w + 2 * t, t, d],
      ]
      for (const [x, y, z, sx, sy, sz] of bars) {
        ctx.parts.push({
          geo: { kind: "box", size: [sx, sy, sz], worldUv: true },
          material,
          matrix: m.clone().multiply(transform([x, y, z], [0, 0, 0])),
          collide: obj.collide,
        })
      }
      return
    }
    case "prefab": {
      const s = new THREE.Matrix4().makeScale(obj.scale, obj.scale, obj.scale)
      return prefabParts(obj, m.clone().multiply(s), ctx)
    }
  }
}

const decalCache = new Map<THREE.Material, THREE.Material>()
function decalMaterial(m: THREE.Material) {
  let d = decalCache.get(m)
  if (!d) {
    d = m.clone()
    d.polygonOffset = true
    d.polygonOffsetFactor = -2
    d.polygonOffsetUnits = -4
    decalCache.set(m, d)
  }
  return d
}

// ---------- terrain ----------

function makeGroundHeight(map: MapFile) {
  const g = map.environment.ground
  const hills = g.hills
  if (!hills || hills.height === 0) return () => 0
  const half = g.size / 2
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  return (x: number, z: number) => {
    const d = Math.hypot(x, z)
    const inner = ss(hills.flatRadius, hills.flatRadius * 1.6 + 10, d)
    const edge = 1 - ss(half * 0.8, half * 0.98, Math.max(Math.abs(x), Math.abs(z)))
    const n = fbm(x / hills.scale + 100, z / hills.scale + 100, 4, hills.seed)
    return hills.height * Math.max(0, n * 1.6 - 0.45) * inner * edge
  }
}

// ---------- build ----------

export function buildMap(map: MapFile, rapier: R, world: RAPIER.World): BuiltMap {
  const group = new THREE.Group()
  group.name = `map:${map.name}`
  const groundHeight = makeGroundHeight(map)
  const ctx: Ctx = { parts: [], groundHeight }
  const identity = new THREE.Matrix4()
  for (const obj of map.objects) emit(obj, identity, ctx)

  let colliders = 0
  const addCollider = (desc: RAPIER.ColliderDesc) => {
    world.createCollider(desc.setFriction(0.7).setRestitution(0.1))
    colliders++
  }

  // Ground. Its material needs object footprints, so it's assigned after parts are built.
  const g = map.environment.ground
  const hasHills = !!g.hills && g.hills.height > 0
  const seg = hasHills ? Math.min(400, Math.ceil(g.size / 2)) : 1
  const groundGeo = new THREE.PlaneGeometry(g.size, g.size, seg, seg)
  groundGeo.rotateX(-Math.PI / 2)
  scaleUvs(groundGeo, g.size, g.size)
  if (hasHills) {
    const pos = groundGeo.getAttribute("position") as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) pos.setY(i, groundHeight(pos.getX(i), pos.getZ(i)))
    groundGeo.computeVertexNormals()
    const verts = new Float32Array(pos.array as ArrayLike<number>)
    addCollider(rapier.ColliderDesc.trimesh(verts, new Uint32Array(groundGeo.getIndex()!.array)))
  }
  const ground = new THREE.Mesh(groundGeo)
  ground.receiveShadow = true
  ground.castShadow = hasHills
  group.add(ground)
  // Endless outer ground so there's no edge of the world. A ring around the
  // map ground (whose edge is at height 0) so the two never overlap.
  const outerSize = 20000
  const O = outerSize / 2
  const H = g.size / 2
  const strip = (x0: number, x1: number, z0: number, z1: number) => {
    const p = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
    p.rotateX(-Math.PI / 2)
    p.translate((x0 + x1) / 2, 0, (z0 + z1) / 2)
    return p
  }
  const outerGeo = mergeGeometries([
    strip(-O, O, -O, -H),
    strip(-O, O, H, O),
    strip(-O, -H, -H, H),
    strip(H, O, -H, H),
  ])!
  const outer = new THREE.Mesh(outerGeo)
  outer.receiveShadow = true
  group.add(outer)
  addCollider(rapier.ColliderDesc.cuboid(outerSize / 2, 1, outerSize / 2).setTranslation(0, -1, 0))

  const CELL = 25
  const cells = new Map<
    string,
    { shapes: RAPIER.Shape[]; positions: RAPIER.Vector[]; rotations: RAPIER.Rotation[] }
  >()
  const addShape = (shape: RAPIER.Shape, p: THREE.Vector3, r: RAPIER.Rotation) => {
    const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { shapes: [], positions: [], rotations: [] }
      cells.set(key, cell)
    }
    cell.shapes.push(shape)
    cell.positions.push({ x: p.x, y: p.y, z: p.z })
    cell.rotations.push(r)
  }

  // Batch parts by geometry + material into instanced meshes
  const geoCache = new Map<string, THREE.BufferGeometry>()
  const batches = new Map<
    string,
    { geo: THREE.BufferGeometry; mat: THREE.Material; matrices: THREE.Matrix4[] }
  >()
  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpScale = new THREE.Vector3()
  const tmpBox = new THREE.Box3()
  const footprints: Footprint[] = []

  for (const part of ctx.parts) {
    const gk = JSON.stringify(part.geo)
    let geo = geoCache.get(gk)
    if (!geo) {
      geo = buildGeometry(part.geo)
      geo.computeBoundingBox()
      geoCache.set(gk, geo)
    }

    // Objects resting on the ground keep grass out and wear the dirt around them
    const bb = geo.boundingBox!
    tmpBox.copy(bb).applyMatrix4(part.matrix)
    const gy = groundHeight((tmpBox.min.x + tmpBox.max.x) / 2, (tmpBox.min.z + tmpBox.max.z) / 2)
    if (tmpBox.min.y < gy + 0.4 && tmpBox.max.y > gy - 0.5) {
      footprints.push({
        inv: part.matrix.clone().invert(),
        box: bb,
        min: new THREE.Vector2(tmpBox.min.x, tmpBox.min.z),
        max: new THREE.Vector2(tmpBox.max.x, tmpBox.max.z),
        y: Math.max(tmpBox.min.y, gy) + 0.02,
        round: ["cylinder", "sphere", "blob", "ring"].includes(part.geo.kind),
        wear: 0.7,
      })
      // Thin slabs on the ground (paths, pads) get a depth offset so they never z-fight it
      if (part.geo.kind === "box" && tmpBox.max.y - tmpBox.min.y < 0.15)
        part.material = decalMaterial(part.material)
    }

    const bk = `${gk}|${part.material.uuid}`
    let batch = batches.get(bk)
    if (!batch) {
      batch = { geo, mat: part.material, matrices: [] }
      batches.set(bk, batch)
    }
    batch.matrices.push(part.matrix)

    if (!part.collide) continue
    part.matrix.decompose(tmpPos, tmpQuat, tmpScale)
    const rot = { x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w }
    const d = part.geo
    const placeAt = (shape: RAPIER.Shape, localY: number) => {
      const c = new THREE.Vector3(0, localY, 0).applyMatrix4(part.matrix)
      addShape(shape, c, rot)
    }
    const baked = () => {
      const p = (geo!.getAttribute("position") as THREE.BufferAttribute)
        .clone()
        .applyMatrix4(part.matrix)
      return new Float32Array(p.array as ArrayLike<number>)
    }
    if (part.collider === "ball" || d.kind === "sphere") {
      const r =
        (d.kind === "blob" || d.kind === "sphere" ? d.r : 1) *
        Math.max(tmpScale.x, tmpScale.y, tmpScale.z)
      placeAt(new rapier.Ball(r * 0.9), 0)
    } else if (d.kind === "box") {
      const [x, y, z] = d.size
      placeAt(
        new rapier.Cuboid((x / 2) * tmpScale.x, (y / 2) * tmpScale.y, (z / 2) * tmpScale.z),
        y / 2,
      )
    } else if (d.kind === "cylinder" && d.rt === d.r && part.collider !== "hull") {
      placeAt(new rapier.Cylinder((d.h / 2) * tmpScale.y, d.r * tmpScale.x), d.h / 2)
    } else if (d.kind === "pipe" || d.kind === "ring") {
      const idx = geo.getIndex()
      const verts = baked()
      const indices = idx
        ? new Uint32Array(idx.array)
        : new Uint32Array(Array.from({ length: verts.length / 3 }, (_, i) => i))
      addCollider(rapier.ColliderDesc.trimesh(verts, indices))
    } else {
      const verts = baked()
      const c = new THREE.Vector3()
      for (let i = 0; i < verts.length; i += 3)
        ((c.x += verts[i]!), (c.y += verts[i + 1]!), (c.z += verts[i + 2]!))
      c.divideScalar(verts.length / 3)
      for (let i = 0; i < verts.length; i += 3)
        ((verts[i]! -= c.x), (verts[i + 1]! -= c.y), (verts[i + 2]! -= c.z))
      addShape(new rapier.ConvexPolyhedron(verts, null), c, { x: 0, y: 0, z: 0, w: 1 })
    }
  }

  // Static shapes are merged into one compound collider per grid cell. Rapier's
  // per-step cost grows with collider count, so this keeps 1 kHz physics cheap.
  for (const cell of cells.values()) {
    addCollider(rapier.ColliderDesc.compound(cell.shapes, cell.positions, cell.rotations))
  }

  // Big batches are split into spatial chunks so the camera and each shadow
  // cascade can frustum cull them instead of drawing the whole map.
  const CHUNK = 80
  const drawBatches: { geo: THREE.BufferGeometry; mat: THREE.Material; matrices: THREE.Matrix4[] }[] =
    []
  for (const b of batches.values()) {
    if (b.matrices.length <= 24) {
      drawBatches.push(b)
      continue
    }
    const chunks = new Map<string, THREE.Matrix4[]>()
    for (const m of b.matrices) {
      const k = `${Math.floor(m.elements[12]! / CHUNK)},${Math.floor(m.elements[14]! / CHUNK)}`
      let list = chunks.get(k)
      if (!list) chunks.set(k, (list = []))
      list.push(m)
    }
    for (const matrices of chunks.values()) drawBatches.push({ geo: b.geo, mat: b.mat, matrices })
  }

  let drawCalls = 0
  for (const b of drawBatches) {
    let mesh: THREE.Mesh
    if (b.matrices.length === 1) {
      mesh = new THREE.Mesh(b.geo, b.mat)
      mesh.applyMatrix4(b.matrices[0]!)
    } else {
      const inst = new THREE.InstancedMesh(b.geo, b.mat, b.matrices.length)
      b.matrices.forEach((mm, i) => inst.setMatrixAt(i, mm))
      inst.instanceMatrix.needsUpdate = true
      inst.computeBoundingSphere()
      mesh = inst
    }
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    drawCalls++
  }

  const spawns = map.spawns.map((s) => ({
    position: new THREE.Vector3(...s.position),
    yaw: s.yaw * DEG,
  }))

  const groundData = buildGroundData(
    map,
    groundHeight,
    footprints,
    spawns.map((s) => s.position),
  )
  const groundMat = terrainMaterial(groundData)
  ground.material = groundMat
  outer.material = groundMat
  patchTree(group)

  return {
    group,
    spawns,
    groundHeight,
    map,
    ground: groundData,
    stats: { parts: ctx.parts.length, drawCalls, colliders },
  }
}
