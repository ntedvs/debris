import { useSyncExternalStore } from "react"
import { DEFAULT_MAPPING, type InputMapping } from "./input/input"
import type { GraphicsQuality } from "./render/scene"
import type { Rates } from "./sim/spec"

export type ViewMode = "fpv" | "chase" | "los"

export type Settings = {
  quadId: string
  mapId: string
  gamepadId: string | null
  mapping: InputMapping
  /** null uses the quad's default rates */
  rates: Rates | null
  camera: { uptilt: number | null; fov: number | null }
  view: ViewMode
  crashThreshold: number
  /** Impacts never disarm the quad. */
  noCrash: boolean
  shadows: boolean
  graphics: GraphicsQuality
  physicsRate: number
}

const KEY = "debris.settings.v1"

const DEFAULTS: Settings = {
  quadId: "5in-freestyle",
  mapId: "field",
  gamepadId: null,
  mapping: DEFAULT_MAPPING,
  rates: null,
  camera: { uptilt: null, fov: null },
  view: "fpv",
  crashThreshold: 14,
  noCrash: false,
  shadows: true,
  graphics: "medium",
  physicsRate: 1000,
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return structuredClone(DEFAULTS)
    const parsed = JSON.parse(raw)
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      mapping: { ...DEFAULTS.mapping, ...parsed.mapping },
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

let state = load()
const listeners = new Set<() => void>()

export const settings = {
  get: () => state,
  set(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
    const p = typeof patch === "function" ? patch(state) : patch
    state = { ...state, ...p }
    localStorage.setItem(KEY, JSON.stringify(state))
    for (const l of listeners) l()
  },
  reset() {
    state = structuredClone(DEFAULTS)
    localStorage.removeItem(KEY)
    for (const l of listeners) l()
  },
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

export function useSettings() {
  return useSyncExternalStore(settings.subscribe, settings.get)
}
