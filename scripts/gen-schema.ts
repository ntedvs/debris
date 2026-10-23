// Publishes the map format: JSON Schema, guide and example maps into public/.
import { mkdir, readdir, copyFile } from "node:fs/promises"
import { z } from "zod"
import { MapFile } from "../src/map/schema"

await mkdir("public/maps", { recursive: true })
const schema = z.toJSONSchema(MapFile, { io: "input", unrepresentable: "any" })
await Bun.write(
  "public/map.schema.json",
  JSON.stringify({ title: "Debris map", ...schema }, null, 2),
)
await copyFile("docs/MAP_FORMAT.md", "public/map-format.md")
for (const f of await readdir("maps"))
  if (f.endsWith(".json")) await copyFile(`maps/${f}`, `public/maps/${f}`)
console.log("wrote public/map.schema.json, public/map-format.md, public/maps/")
