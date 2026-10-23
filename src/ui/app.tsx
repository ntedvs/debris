import { useEffect, useRef, useState } from "react"
import { Game, type GameStatus } from "../game"
import { BUILTIN_MAPS } from "../map/maps"
import { parseMap, type MapFile } from "../map/schema"
import { QUADS } from "../sim/quads"
import { settings, useSettings, type ViewMode } from "../settings"
import type { GraphicsQuality } from "../render/scene"
import { ControllerSetup } from "./controller-setup"
import { Osd } from "./osd"
import { RatesEditor } from "./rates-editor"

const CUSTOM_KEY = "debris.customMap"

function loadCustom(): MapFile | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    if (!raw) return null
    const r = parseMap(JSON.parse(raw))
    return r.ok ? r.map : null
  } catch {
    return null
  }
}

function resolveMap(id: string, custom: MapFile | null): MapFile {
  if (id === "custom" && custom) return custom
  return (BUILTIN_MAPS.find((m) => m.id === id) ?? BUILTIN_MAPS[0]!).map
}

type Tab = "fly" | "controller" | "rates" | "settings" | "maps"

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [status, setStatus] = useState<GameStatus | null>(null)
  const [menu, setMenu] = useState(true)
  const [tab, setTab] = useState<Tab>("fly")
  const [custom, setCustom] = useState<MapFile | null>(loadCustom)
  const [mapErrors, setMapErrors] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(true)
  const s = useSettings()

  useEffect(() => {
    const game = new Game(canvasRef.current!)
    gameRef.current = game
    game.onStatus = setStatus
    game.init(resolveMap(settings.get().mapId, loadCustom())).then(() => setLoading(false))
    const unsub = settings.subscribe(() => game.applySettings(settings.get()))
    return () => {
      unsub()
      game.dispose()
    }
  }, [])

  useEffect(() => {
    if (gameRef.current) gameRef.current.paused = menu
  }, [menu])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") setMenu((m) => !m)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const selectMap = (id: string, map: MapFile) => {
    settings.set({ mapId: id })
    gameRef.current?.loadMap(map)
  }

  const loadFile = async (file: File) => {
    setMapErrors(null)
    let json: unknown
    try {
      json = JSON.parse(await file.text())
    } catch (e) {
      setMapErrors([`Not valid JSON: ${(e as Error).message}`])
      return
    }
    const r = parseMap(json)
    if (!r.ok) {
      setMapErrors(r.errors)
      return
    }
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(json))
    setCustom(r.map)
    selectMap("custom", r.map)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) {
      setMenu(true)
      setTab("fly")
      loadFile(file)
    }
  }

  return (
    <div className="relative h-full w-full" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <canvas ref={canvasRef} className="block h-full w-full" />
      <Osd status={status} />
      {loading && (
        <div className="absolute inset-0 grid place-items-center bg-black text-white/70">
          Loading...
        </div>
      )}
      {menu && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="flex h-[80vh] w-[860px] max-w-[95vw] overflow-hidden rounded-xl border border-white/10 bg-neutral-900/95 text-white shadow-2xl">
            <nav className="flex w-44 flex-col gap-1 border-r border-white/10 p-3">
              <div className="px-2 pb-3 text-lg font-bold">Debris</div>
              {(
                [
                  ["fly", "Fly"],
                  ["controller", "Controller"],
                  ["rates", "Rates"],
                  ["settings", "Settings"],
                  ["maps", "Make maps"],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`rounded px-2 py-1.5 text-left text-sm ${tab === id ? "bg-white/15" : "hover:bg-white/5"}`}
                >
                  {label}
                </button>
              ))}
              <button
                className="mt-auto rounded bg-sky-500 px-3 py-2 font-semibold text-black hover:bg-sky-400"
                onClick={() => setMenu(false)}
              >
                Fly (Esc)
              </button>
            </nav>
            <div className="flex-1 overflow-y-auto p-6">
              {tab === "fly" && (
                <FlyTab
                  mapId={s.mapId}
                  custom={custom}
                  errors={mapErrors}
                  onSelect={selectMap}
                  onFile={loadFile}
                  onReset={() => {
                    gameRef.current?.reset()
                    setMenu(false)
                  }}
                />
              )}
              {tab === "controller" && <ControllerSetup />}
              {tab === "rates" && <RatesEditor />}
              {tab === "settings" && <SettingsTab />}
              {tab === "maps" && <MapsTab />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FlyTab(props: {
  mapId: string
  custom: MapFile | null
  errors: string[] | null
  onSelect: (id: string, map: MapFile) => void
  onFile: (f: File) => void
  onReset: () => void
}) {
  const s = useSettings()
  const fileRef = useRef<HTMLInputElement>(null)
  const entries = [...BUILTIN_MAPS, ...(props.custom ? [{ id: "custom", map: props.custom }] : [])]
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="font-semibold">Map</h3>
        <div className="grid grid-cols-2 gap-2">
          {entries.map((e) => (
            <button
              key={e.id}
              onClick={() => props.onSelect(e.id, e.map)}
              className={`rounded-lg border p-3 text-left ${props.mapId === e.id ? "border-sky-400 bg-sky-400/10" : "border-white/10 hover:bg-white/5"}`}
            >
              <div className="font-medium">
                {e.map.name}
                {e.id === "custom" && <span className="ml-2 text-xs text-white/50">custom</span>}
              </div>
              {e.map.description && (
                <div className="mt-1 text-xs text-white/60">{e.map.description}</div>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            onClick={() => fileRef.current?.click()}
          >
            Load map file
          </button>
          <span className="text-xs text-white/50">or drop a .json file anywhere</span>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && props.onFile(e.target.files[0])}
          />
        </div>
        {props.errors && (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs">
            <div className="mb-1 font-semibold text-red-300">Map has errors</div>
            <ul className="space-y-0.5 font-mono">
              {props.errors.slice(0, 30).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">Quad</h3>
        <div className="flex gap-2">
          {QUADS.map((q) => (
            <button
              key={q.id}
              onClick={() => settings.set({ quadId: q.id })}
              className={`rounded-lg border p-3 text-left ${s.quadId === q.id ? "border-sky-400 bg-sky-400/10" : "border-white/10 hover:bg-white/5"}`}
            >
              <div className="font-medium">{q.name}</div>
              <div className="mt-1 text-xs text-white/60">{q.description}</div>
            </button>
          ))}
        </div>
      </section>
      <section className="flex gap-2">
        <button
          className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          onClick={props.onReset}
        >
          Reset quad (R)
        </button>
      </section>
      <section className="text-sm text-white/60">
        <p>Esc menu, R reset, V cycle view (FPV, chase, line of sight), N next spawn point.</p>
      </section>
    </div>
  )
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-40">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-56"
      />
      <span className="w-20 tabular-nums">
        {props.value}
        {props.unit}
      </span>
    </label>
  )
}

function SettingsTab() {
  const s = useSettings()
  const quad = QUADS.find((q) => q.id === s.quadId) ?? QUADS[0]!
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="font-semibold">Camera</h3>
        <Slider
          label="Uptilt"
          value={s.camera.uptilt ?? quad.camera.uptilt}
          min={0}
          max={60}
          unit="°"
          onChange={(v) => settings.set({ camera: { ...s.camera, uptilt: v } })}
        />
        <Slider
          label="Horizontal FOV"
          value={s.camera.fov ?? quad.camera.fov}
          min={80}
          max={150}
          unit="°"
          onChange={(v) => settings.set({ camera: { ...s.camera, fov: v } })}
        />
        <label className="flex items-center gap-3 text-sm">
          <span className="w-40">View</span>
          <select
            className="rounded bg-white/10 px-2 py-1"
            value={s.view}
            onChange={(e) => settings.set({ view: e.target.value as ViewMode })}
          >
            <option value="fpv" className="bg-neutral-900">
              FPV
            </option>
            <option value="chase" className="bg-neutral-900">
              Chase
            </option>
            <option value="los" className="bg-neutral-900">
              Line of sight
            </option>
          </select>
        </label>
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">Simulation</h3>
        <label className="flex items-center gap-3 text-sm">
          <span className="w-40">No-crash mode</span>
          <input
            type="checkbox"
            checked={s.noCrash}
            onChange={(e) => settings.set({ noCrash: e.target.checked })}
          />
          <span className="text-xs text-white/50">hits still bounce, but never disarm</span>
        </label>
        {!s.noCrash && (
          <Slider
            label="Crash threshold"
            value={s.crashThreshold}
            min={4}
            max={30}
            unit=" m/s"
            onChange={(v) => settings.set({ crashThreshold: v })}
          />
        )}
        <label className="flex items-center gap-3 text-sm">
          <span className="w-40">Physics rate</span>
          <select
            className="rounded bg-white/10 px-2 py-1"
            value={s.physicsRate}
            onChange={(e) => settings.set({ physicsRate: Number(e.target.value) })}
          >
            {[500, 1000, 2000].map((r) => (
              <option key={r} value={r} className="bg-neutral-900">
                {r} Hz
              </option>
            ))}
          </select>
          <span className="text-xs text-white/50">applies on map load</span>
        </label>
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">Graphics</h3>
        <label className="flex items-center gap-3 text-sm">
          <span className="w-40">Quality</span>
          <select
            className="rounded bg-white/10 px-2 py-1"
            value={s.graphics}
            onChange={(e) => settings.set({ graphics: e.target.value as GraphicsQuality })}
          >
            {(
              [
                ["low", "Low"],
                ["medium", "Medium"],
                ["high", "High"],
              ] as const
            ).map(([v, l]) => (
              <option key={v} value={v} className="bg-neutral-900">
                {l}
              </option>
            ))}
          </select>
          <span className="text-xs text-white/50">shadows, ambient occlusion, grass density</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={s.shadows}
            onChange={(e) => settings.set({ shadows: e.target.checked })}
          />{" "}
          Shadows
        </label>
      </section>
      <button
        className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
        onClick={() => settings.reset()}
      >
        Reset all settings
      </button>
    </div>
  )
}

function MapsTab() {
  const [copied, setCopied] = useState(false)
  const copyPrompt = async () => {
    const [doc, schema, example] = await Promise.all([
      fetch("/map-format.md").then((r) => r.text()),
      fetch("/map.schema.json").then((r) => r.text()),
      fetch("/maps/field.json").then((r) => r.text()),
    ])
    const prompt = `${doc}\n\n## JSON Schema\n\n\`\`\`json\n${schema}\n\`\`\`\n\n## Example map\n\n\`\`\`json\n${example}\n\`\`\`\n\nNow make me a map: `
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="space-y-4 text-sm">
      <p>
        Maps are plain JSON files. The format is open and documented, so you can write one by hand
        or ask any AI to build one for you. Load it from the Fly tab or drop the file on the window.
        If something is wrong you get an exact list of errors, which you can paste back to the AI.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-white/80">
        <li>Copy the AI prompt below. It contains the format guide, the schema and an example.</li>
        <li>Paste it into your AI of choice and describe the spot you want.</li>
        <li>Save the reply as a .json file and drop it here.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded bg-sky-500 px-3 py-1.5 font-semibold text-black hover:bg-sky-400"
          onClick={copyPrompt}
        >
          {copied ? "Copied" : "Copy AI prompt"}
        </button>
        <a
          className="rounded bg-white/10 px-3 py-1.5 hover:bg-white/20"
          href="/map-format.md"
          target="_blank"
        >
          Format guide
        </a>
        <a
          className="rounded bg-white/10 px-3 py-1.5 hover:bg-white/20"
          href="/map.schema.json"
          target="_blank"
        >
          JSON Schema
        </a>
        <a
          className="rounded bg-white/10 px-3 py-1.5 hover:bg-white/20"
          href="/maps/field.json"
          target="_blank"
        >
          Example map
        </a>
      </div>
    </div>
  )
}
