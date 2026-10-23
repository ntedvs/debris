import { parseMap, type MapFile } from "./schema"

const files = import.meta.glob("/maps/*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>

export type MapEntry = { id: string; map: MapFile }

/** Built-in maps from /maps. Drop a new JSON file there to add one. */
export const BUILTIN_MAPS: MapEntry[] = Object.entries(files).flatMap(([path, json]) => {
  const id = path
    .split("/")
    .pop()!
    .replace(/\.json$/, "")
  const r = parseMap(json)
  if (!r.ok) {
    console.error(`Map ${id} is invalid`, r.errors)
    return []
  }
  return [{ id, map: r.map }]
})
