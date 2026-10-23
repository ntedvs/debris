import { z } from "zod"

/**
 * Debris map format, version 1.
 *
 * Units: meters and degrees. Y is up. -Z is north, +X is east.
 * Rotations are [x, y, z] Euler angles in degrees (applied Y, then X, then Z).
 * A positive Y rotation turns counterclockwise when seen from above.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()])
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #aabbcc")

export const MATERIAL_PRESETS = [
  "grass",
  "dirt",
  "sand",
  "concrete",
  "asphalt",
  "brick",
  "metal",
  "rust",
  "wood",
  "plaster",
  "painted",
  "glass",
] as const

export const Material = z.union([
  z.enum(MATERIAL_PRESETS).describe("Built-in material preset"),
  z
    .object({
      preset: z.enum(MATERIAL_PRESETS).optional().describe("Base preset. Defaults to 'painted'."),
      color: color.optional().describe("Tint color multiplied with the preset texture."),
      roughness: z.number().min(0).max(1).optional(),
      metalness: z.number().min(0).max(1).optional(),
      tileSize: z.number().positive().optional().describe("Texture repeat size in meters."),
    })
    .strict(),
])
export type Material = z.infer<typeof Material>

export const PREFABS = [
  "tree",
  "pine",
  "bush",
  "rock",
  "container",
  "pole",
  "lamppost",
  "barrier",
  "barrel",
  "pallet",
  "tire",
  "building",
] as const

const base = {
  id: z.string().optional().describe("Optional name, used in error messages."),
  position: vec3
    .default([0, 0, 0])
    .describe("Position in meters. For most shapes this is the center of the bottom face."),
  rotation: vec3.default([0, 0, 0]).describe("Euler rotation in degrees."),
  material: Material.optional(),
  collide: z.boolean().default(true).describe("Whether the quad can hit it."),
}

const Box = z
  .object({
    type: z.literal("box"),
    ...base,
    size: vec3.describe("Width (x), height (y), depth (z)."),
  })
  .strict()
const Cylinder = z
  .object({
    type: z.literal("cylinder"),
    ...base,
    radius: z.number().positive(),
    radiusTop: z
      .number()
      .nonnegative()
      .optional()
      .describe("Defaults to radius. Use 0 for a cone."),
    height: z.number().positive(),
  })
  .strict()
const Sphere = z
  .object({ type: z.literal("sphere"), ...base, radius: z.number().positive() })
  .strict()
  .describe("Position is the sphere center.")
const Ramp = z
  .object({
    type: z.literal("ramp"),
    ...base,
    size: vec3.describe("Width (x), height (y), length (z). Rises toward -Z."),
  })
  .strict()
const Pipe = z
  .object({
    type: z.literal("pipe"),
    ...base,
    radius: z.number().positive().describe("Outer radius."),
    thickness: z.number().positive(),
    length: z.number().positive(),
  })
  .strict()
  .describe("Hollow tube lying along Z, resting on the ground at position. Fly through it.")
const Ring = z
  .object({
    type: z.literal("ring"),
    ...base,
    radius: z.number().positive().describe("Radius to the center of the tube."),
    tube: z.number().positive().describe("Tube radius."),
  })
  .strict()
  .describe("Vertical torus facing Z. Position is the ring center.")
const Frame = z
  .object({
    type: z.literal("frame"),
    ...base,
    width: z.number().positive().describe("Inner opening width."),
    height: z.number().positive().describe("Inner opening height."),
    thickness: z.number().positive().default(0.1).describe("Bar thickness."),
    depth: z.number().positive().default(0.1),
  })
  .strict()
  .describe("Rectangular gap standing on the ground, opening faces Z.")
const Prefab = z
  .object({
    type: z.literal("prefab"),
    ...base,
    prefab: z.enum(PREFABS),
    scale: z.number().positive().default(1),
    color: color.optional().describe("Main color, where it applies (container, building, barrel)."),
    size: vec3.optional().describe("Only for 'building': width, height, depth."),
    seed: z.number().int().optional().describe("Variation seed for trees, rocks and bushes."),
  })
  .strict()

export type MapObject =
  | z.infer<typeof Box>
  | z.infer<typeof Cylinder>
  | z.infer<typeof Sphere>
  | z.infer<typeof Ramp>
  | z.infer<typeof Pipe>
  | z.infer<typeof Ring>
  | z.infer<typeof Frame>
  | z.infer<typeof Prefab>
  | Group
  | ArrayObj
  | Scatter

type Group = {
  type: "group"
  id?: string
  position: [number, number, number]
  rotation: [number, number, number]
  children: MapObject[]
}
type ArrayObj = {
  type: "array"
  id?: string
  count: number
  offset: [number, number, number]
  rotationStep: [number, number, number]
  position: [number, number, number]
  rotation: [number, number, number]
  object: MapObject
}
type Scatter = {
  type: "scatter"
  id?: string
  count: number
  center: [number, number, number]
  size: [number, number]
  seed: number
  randomYaw: boolean
  scaleRange: [number, number]
  avoid: { center: [number, number, number]; radius: number }[]
  object: MapObject
}

export const MapObject: z.ZodType<MapObject, any> = z.lazy(() =>
  z.discriminatedUnion("type", [
    Box,
    Cylinder,
    Sphere,
    Ramp,
    Pipe,
    Ring,
    Frame,
    Prefab,
    GroupSchema,
    ArraySchema,
    ScatterSchema,
  ]),
)

const GroupSchema = z
  .object({
    type: z.literal("group"),
    id: z.string().optional(),
    position: vec3.default([0, 0, 0]),
    rotation: vec3.default([0, 0, 0]),
    children: z.array(MapObject),
  })
  .strict()
  .describe("Transforms its children together.")

const ArraySchema = z
  .object({
    type: z.literal("array"),
    id: z.string().optional(),
    count: z.number().int().positive().max(500),
    offset: vec3.describe("Added to the position for each copy."),
    rotationStep: vec3.default([0, 0, 0]).describe("Added to the rotation for each copy."),
    position: vec3.default([0, 0, 0]),
    rotation: vec3.default([0, 0, 0]),
    object: MapObject,
  })
  .strict()
  .describe("Repeats one object in a line, for fences, rows of trees, stairs.")

const ScatterSchema = z
  .object({
    type: z.literal("scatter"),
    id: z.string().optional(),
    count: z.number().int().positive().max(2000),
    center: vec3.default([0, 0, 0]),
    size: z
      .tuple([z.number().positive(), z.number().positive()])
      .describe("Area width (x) and depth (z)."),
    seed: z.number().int().default(1),
    randomYaw: z.boolean().default(true),
    scaleRange: z.tuple([z.number().positive(), z.number().positive()]).default([1, 1]),
    avoid: z
      .array(z.object({ center: vec3, radius: z.number().positive() }).strict())
      .default([])
      .describe("Circles (on the ground plane) kept clear."),
    object: MapObject,
  })
  .strict()
  .describe(
    "Randomly places copies of an object on the ground in an area. Good for forests and rocks.",
  )

export const SkyPreset = z.enum(["day", "golden", "overcast", "dusk"])

export const MapFile = z
  .object({
    format: z.literal("debris-map"),
    version: z.literal(1),
    name: z.string(),
    author: z.string().optional(),
    description: z.string().optional(),
    environment: z
      .object({
        sky: z
          .object({
            preset: SkyPreset.default("day"),
            sunElevation: z.number().min(-10).max(90).optional().describe("Degrees above horizon."),
            sunAzimuth: z.number().optional().describe("Degrees clockwise from north."),
          })
          .strict()
          .default({ preset: "day" }),
        fog: z
          .object({ color: color.optional(), density: z.number().min(0).max(0.1) })
          .strict()
          .optional(),
        ground: z
          .object({
            size: z
              .number()
              .positive()
              .max(4000)
              .default(400)
              .describe("Square ground, meters per side."),
            material: Material.default("grass"),
            hills: z
              .object({
                height: z.number().nonnegative().describe("Max hill height, meters."),
                scale: z.number().positive().default(60).describe("Typical hill width, meters."),
                flatRadius: z
                  .number()
                  .nonnegative()
                  .default(40)
                  .describe("Flat area around the origin."),
                seed: z.number().int().default(1),
              })
              .strict()
              .optional(),
          })
          .strict()
          .default({ size: 400, material: "grass" }),
        wind: z
          .object({
            speed: z.number().nonnegative().default(0).describe("m/s"),
            direction: z
              .number()
              .default(0)
              .describe("Degrees the wind blows from, clockwise from north."),
            gust: z
              .number()
              .min(0)
              .max(1)
              .default(0.3)
              .describe("Gust strength relative to speed."),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ sky: { preset: "day" }, ground: { size: 400, material: "grass" } }),
    spawns: z
      .array(
        z
          .object({
            position: vec3,
            yaw: z
              .number()
              .default(0)
              .describe(
                "Degrees, positive turns left (counterclockwise from above). 0 faces north (-Z).",
              ),
          })
          .strict(),
      )
      .min(1),
    objects: z.array(MapObject).default([]),
  })
  .strict()

export type MapFile = z.infer<typeof MapFile>

/** Parse and validate a map. Errors name the exact path so an AI (or a person) can fix them. */
export function parseMap(
  json: unknown,
): { ok: true; map: MapFile } | { ok: false; errors: string[] } {
  const result = MapFile.safeParse(json)
  if (result.success) return { ok: true, map: result.data }
  return {
    ok: false,
    errors: result.error.issues.map(
      (i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`,
    ),
  }
}
