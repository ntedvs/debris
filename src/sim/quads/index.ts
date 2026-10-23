import type { QuadSpec } from "../spec"
import { fiveInchFreestyle } from "./five-inch"

/** Add new vehicle specs here. */
export const QUADS: QuadSpec[] = [fiveInchFreestyle]

export function getQuad(id: string): QuadSpec {
  return QUADS.find((q) => q.id === id) ?? QUADS[0]!
}
