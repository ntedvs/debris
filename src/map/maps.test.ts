import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { parseMap } from "./schema"

test("bundled maps are valid", async () => {
  for (const f of readdirSync("maps").filter((f) => f.endsWith(".json"))) {
    const r = parseMap(await Bun.file(`maps/${f}`).json())
    if (!r.ok) console.error(f, r.errors)
    expect(r.ok).toBe(true)
  }
})

test("errors point at the exact path", () => {
  const r = parseMap({
    format: "debris-map",
    version: 1,
    name: "x",
    spawns: [{ position: [0, 0, 0] }],
    objects: [{ type: "box", size: [1, 2] }],
  })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.errors.some((e) => e.startsWith("objects.0.size"))).toBe(true)
})
