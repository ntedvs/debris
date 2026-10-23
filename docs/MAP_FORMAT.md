# Debris map format (version 1)

A Debris map is one JSON file. It describes the ground, sky, wind, spawn points and objects.
It's declarative only: no scripts, so a map from anyone is safe to load.

Validate against `map.schema.json`. When a map has errors, Debris lists each one with its exact path
(for example `objects.3.size: Expected tuple`), so you can fix it by hand or paste the errors back to an AI.

## Conventions

- Units are meters and degrees.
- Y is up. -Z is north, +X is east. The default spawn faces north.
- `position` is `[x, y, z]`. For boxes, cylinders, ramps, pipes, frames and prefabs it's the center of the **bottom** face, so `y: 0` sits on the ground. Spheres and rings use their center.
- `rotation` is `[x, y, z]` Euler angles in degrees. A positive Y rotation turns counterclockwise seen from above.
- Object positions are absolute. Only `scatter` snaps objects to the terrain height.
- Keep the area around spawns flat. With hills, the terrain is flat within `flatRadius` of the origin.
- A 5" quad is about 0.27 m across with props. Gaps narrower than about 0.6 m are very hard.

## Top level

```json
{
  "format": "debris-map",
  "version": 1,
  "name": "My Spot",
  "author": "you",
  "description": "One line description",
  "environment": { ... },
  "spawns": [{ "position": [0, 0, 0], "yaw": 0 }],
  "objects": [ ... ]
}
```

## environment

| Field              | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `sky.preset`       | `day`, `golden`, `overcast`, `dusk`                                                     |
| `sky.sunElevation` | Degrees above the horizon (optional)                                                    |
| `sky.sunAzimuth`   | Degrees clockwise from north (optional)                                                 |
| `fog.density`      | Exponential fog, 0.001 (clear) to 0.02 (thick). Optional `fog.color`.                   |
| `ground.size`      | Square ground size in meters, default 400                                               |
| `ground.material`  | Material for the ground, default `grass`                                                |
| `ground.hills`     | `{ height, scale, flatRadius, seed }` rolling hills, optional                           |
| `wind`             | `{ speed (m/s), direction (degrees it blows from, clockwise from north), gust (0..1) }` |

## Materials

Anywhere a `material` is accepted you can use a preset name:
`grass`, `dirt`, `sand`, `concrete`, `asphalt`, `brick`, `metal`, `rust`, `wood`, `plaster`, `painted`, `glass`

or an object: `{ "preset": "painted", "color": "#e04a1f", "roughness": 0.6, "metalness": 0, "tileSize": 2 }`.
`color` tints the preset. `tileSize` is how many meters one texture repeat covers.

## Objects

Every object has `type` and optional `id`, `position`, `rotation`, `material`, `collide` (default true).

| type       | Fields                                                                                     | Notes                                                   |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `box`      | `size: [w, h, d]`                                                                          |                                                         |
| `cylinder` | `radius`, `height`, `radiusTop?`                                                           | `radiusTop: 0` makes a cone                             |
| `sphere`   | `radius`                                                                                   | position is the center                                  |
| `ramp`     | `size: [w, h, length]`                                                                     | rises toward -Z                                         |
| `pipe`     | `radius`, `thickness`, `length`                                                            | hollow tube lying along Z, fly through it               |
| `ring`     | `radius`, `tube`                                                                           | vertical torus facing Z, position is the center         |
| `frame`    | `width`, `height`, `thickness?`, `depth?`                                                  | rectangular gap standing on the ground, opening faces Z |
| `prefab`   | `prefab`, `scale?`, `color?`, `size?`, `seed?`                                             | see below                                               |
| `group`    | `children: [objects]`                                                                      | moves and rotates children together                     |
| `array`    | `count`, `offset: [x,y,z]`, `rotationStep?`, `object`                                      | repeats one object in a line                            |
| `scatter`  | `count`, `center`, `size: [w, d]`, `seed`, `scaleRange?`, `randomYaw?`, `avoid?`, `object` | random placement on the terrain                         |

### Prefabs

| prefab      | Size                                  | Notes                                                |
| ----------- | ------------------------------------- | ---------------------------------------------------- |
| `tree`      | ~5.5 m tall                           | leafy tree, `seed` varies shape                      |
| `pine`      | ~6.5 m tall                           | conifer                                              |
| `bush`      | ~1.2 m                                |                                                      |
| `rock`      | ~1.5 m                                |                                                      |
| `container` | 2.44 x 2.59 x 6.06 m                  | 20 ft shipping container, long side along Z, `color` |
| `pole`      | 9 m                                   | utility pole with crossbar                           |
| `lamppost`  | 6 m                                   | arm points to -Z                                     |
| `barrier`   | 0.6 x 0.85 x 3 m                      | concrete jersey barrier, along Z                     |
| `barrel`    | 0.9 m                                 | `color`                                              |
| `pallet`    | 1.2 x 0.15 x 1.0 m                    |                                                      |
| `tire`      | 0.84 m                                | standing tire, faces Z                               |
| `building`  | `size: [w, h, d]` default 12 x 9 x 10 | windows every 3 m per floor, `color`                 |

`scale` multiplies the prefab's size uniformly. Containers stack at multiples of 2.59 m.

## Tips for building a good freestyle spot

- Give pilots lines: a gap, then a dive, then something to orbit. Space features 15 to 40 m apart.
- Bandos come from boxes: slabs, columns (`array`), walls with gaps left between boxes.
- Use `scatter` for forests around the edge and `avoid` circles to keep flying areas clear.
- Keep total objects reasonable: up to a few thousand parts is fine.

## Example

```json
{
  "format": "debris-map",
  "version": 1,
  "name": "Tiny Yard",
  "spawns": [{ "position": [0, 0, 0], "yaw": 0 }],
  "environment": { "sky": { "preset": "golden" }, "ground": { "size": 300, "material": "dirt" } },
  "objects": [
    { "type": "prefab", "prefab": "container", "position": [0, 0, -20], "color": "#2f6f9f" },
    {
      "type": "prefab",
      "prefab": "container",
      "position": [0, 2.59, -20],
      "rotation": [0, 90, 0],
      "color": "#8e2f24"
    },
    {
      "type": "frame",
      "position": [8, 0, -10],
      "width": 2,
      "height": 1.5,
      "material": { "preset": "painted", "color": "#f0c020" }
    },
    {
      "type": "array",
      "count": 6,
      "position": [-15, 0, -40],
      "offset": [6, 0, 0],
      "object": { "type": "prefab", "prefab": "pine" }
    },
    {
      "type": "scatter",
      "count": 80,
      "size": [280, 280],
      "seed": 3,
      "avoid": [{ "center": [0, 0, -15], "radius": 40 }],
      "object": { "type": "prefab", "prefab": "tree" }
    }
  ]
}
```
