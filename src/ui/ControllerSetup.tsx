import { useEffect, useRef, useState } from "react"
import {
  getGamepad,
  readGamepad,
  type AxisBinding,
  type InputMapping,
  type StickName,
  type SwitchBinding,
} from "../input/input"
import { settings, useSettings } from "../settings"

function useGamepadFrame() {
  const [, setTick] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      setTick((t) => t + 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return Array.from(navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g)
}

function Bar({ value, min = -1, max = 1 }: { value: number; min?: number; max?: number }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="relative h-2 w-40 overflow-hidden rounded bg-white/10">
      <div
        className="absolute inset-y-0 left-0 bg-sky-400"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  )
}

const STICKS: { key: StickName; label: string; hint: string }[] = [
  { key: "throttle", label: "Throttle", hint: "Move throttle up" },
  { key: "yaw", label: "Yaw", hint: "Move yaw right" },
  { key: "pitch", label: "Pitch", hint: "Move pitch forward" },
  { key: "roll", label: "Roll", hint: "Move roll right" },
]

type Detecting = {
  target: StickName | "arm" | "reset"
  baseAxes: number[]
  baseButtons: boolean[]
  until: number
} | null

export function ControllerSetup() {
  const s = useSettings()
  const pads = useGamepadFrame()
  const gp = getGamepad(s.gamepadId)
  const m = s.mapping
  const [detecting, setDetecting] = useState<Detecting>(null)
  const [calib, setCalib] = useState<null | { min: number[]; max: number[] }>(null)
  const calibRef = useRef(calib)
  calibRef.current = calib

  const setMapping = (patch: Partial<InputMapping>) =>
    settings.set((st) => ({ mapping: { ...st.mapping, ...patch } }))
  const setAxis = (k: StickName, patch: Partial<AxisBinding>) =>
    setMapping({ [k]: { ...m[k], ...patch } })

  // Detection: pick the axis or button that changed the most
  if (gp && detecting) {
    const axes = Array.from(gp.axes)
    if (performance.now() > detecting.until) {
      queueMicrotask(() => setDetecting(null))
    } else if (detecting.target === "arm" || detecting.target === "reset") {
      const btn = gp.buttons.findIndex((b, i) => b.pressed && !detecting.baseButtons[i])
      const ax = axes.findIndex((v, i) => Math.abs(v - (detecting.baseAxes[i] ?? 0)) > 1)
      if (btn >= 0 || ax >= 0) {
        const binding: SwitchBinding =
          btn >= 0
            ? { kind: "button", index: btn, invert: false }
            : { kind: "axis", index: ax, invert: (axes[ax] ?? 0) < 0 }
        const target = detecting.target
        queueMicrotask(() => {
          setMapping({ [target]: binding })
          setDetecting(null)
        })
      }
    } else {
      let best = -1
      let bestDelta = 0.5
      axes.forEach((v, i) => {
        const d = Math.abs(v - (detecting.baseAxes[i] ?? 0))
        if (d > bestDelta) {
          best = i
          bestDelta = d
        }
      })
      if (best >= 0) {
        const target = detecting.target
        const invert = (axes[best] ?? 0) < (detecting.baseAxes[best] ?? 0)
        queueMicrotask(() => {
          setAxis(target, { index: best, invert })
          setDetecting(null)
        })
      }
    }
  }

  // Calibration: track extremes
  if (gp && calib) {
    let changed = false
    const min = [...calib.min]
    const max = [...calib.max]
    gp.axes.forEach((v, i) => {
      if (v < (min[i] ?? Infinity)) ((min[i] = v), (changed = true))
      if (v > (max[i] ?? -Infinity)) ((max[i] = v), (changed = true))
    })
    if (changed) queueMicrotask(() => setCalib({ min, max }))
  }

  const startDetect = (target: StickName | "arm" | "reset") => {
    if (!gp) return
    setDetecting({
      target,
      baseAxes: Array.from(gp.axes),
      baseButtons: gp.buttons.map((b) => b.pressed),
      until: performance.now() + 5000,
    })
  }

  const finishCalibration = () => {
    if (!gp || !calib) return
    const patch: Partial<InputMapping> = {}
    for (const { key } of STICKS) {
      const b = m[key]
      const min = calib.min[b.index] ?? -1
      const max = calib.max[b.index] ?? 1
      if (max - min < 0.5) continue
      const center = key === "throttle" ? (min + max) / 2 : (gp.axes[b.index] ?? 0)
      patch[key] = { ...b, min, max, center }
    }
    setMapping(patch)
    setCalib(null)
  }

  const live = gp ? readGamepad(gp, m) : null

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="font-semibold">Device</h3>
        {pads.length === 0 ? (
          <p className="text-sm text-white/70">
            No controller detected. On the Pocket: plug in USB, choose <b>USB Joystick (HID)</b>,
            then move a stick or flip a switch so the browser sees it. Turn the internal RF module
            off for the 1000 Hz USB mixer.
          </p>
        ) : (
          <select
            className="rounded bg-white/10 px-2 py-1"
            value={gp?.id ?? ""}
            onChange={(e) => settings.set({ gamepadId: e.target.value })}
          >
            {pads.map((p) => (
              <option key={p.index} value={p.id} className="bg-neutral-900">
                {p.id}
              </option>
            ))}
          </select>
        )}
      </section>

      {gp && (
        <>
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Sticks</h3>
              {calib ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-amber-300">
                    Move every stick to all corners, then center roll, pitch and yaw.
                  </span>
                  <button
                    className="rounded bg-sky-500 px-3 py-1 text-black"
                    onClick={finishCalibration}
                  >
                    Done
                  </button>
                </div>
              ) : (
                <button
                  className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
                  onClick={() => setCalib({ min: [], max: [] })}
                >
                  Calibrate
                </button>
              )}
            </div>
            <table className="w-full text-sm">
              <tbody>
                {STICKS.map(({ key, label, hint }) => (
                  <tr key={key} className="h-9">
                    <td className="w-24">{label}</td>
                    <td>
                      <select
                        className="rounded bg-white/10 px-2 py-0.5"
                        value={m[key].index}
                        onChange={(e) => setAxis(key, { index: Number(e.target.value) })}
                      >
                        {gp.axes.map((_, i) => (
                          <option key={i} value={i} className="bg-neutral-900">
                            Axis {i}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={m[key].invert}
                          onChange={(e) => setAxis(key, { invert: e.target.checked })}
                        />{" "}
                        Invert
                      </label>
                    </td>
                    <td>
                      <Bar value={live?.[key] ?? 0} min={key === "throttle" ? 0 : -1} />
                    </td>
                    <td className="text-right">
                      <button
                        className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
                        onClick={() => startDetect(key)}
                      >
                        {detecting?.target === key ? hint : "Detect"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">Switches</h3>
            {(["arm", "reset"] as const).map((k) => {
              const b = m[k]
              const on = k === "arm" ? live?.arm : live?.reset
              return (
                <div key={k} className="flex h-9 items-center gap-4 text-sm">
                  <span className="w-24">{k === "arm" ? "Arm" : "Reset (optional)"}</span>
                  <span className="w-40 text-white/70">
                    {b
                      ? `${b.kind === "axis" ? "Axis" : "Button"} ${b.index}${b.invert ? " (inverted)" : ""}`
                      : "None"}
                  </span>
                  {b && (
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={b.invert}
                        onChange={(e) => setMapping({ [k]: { ...b, invert: e.target.checked } })}
                      />{" "}
                      Invert
                    </label>
                  )}
                  <span className={`h-3 w-3 rounded-full ${on ? "bg-green-400" : "bg-white/20"}`} />
                  <button
                    className="ml-auto rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
                    onClick={() => startDetect(k)}
                  >
                    {detecting?.target === k ? "Flip the switch" : "Detect"}
                  </button>
                  {k === "reset" && b && (
                    <button
                      className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
                      onClick={() => setMapping({ reset: null })}
                    >
                      Clear
                    </button>
                  )}
                </div>
              )
            })}
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">Raw axes</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              {gp.axes.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-12 text-white/60">Axis {i}</span>
                  <Bar value={v} />
                  <span className="w-12 text-right tabular-nums">{v.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 pt-2">
              {gp.buttons.map((b, i) => (
                <span
                  key={i}
                  className={`rounded px-1.5 text-xs ${b.pressed ? "bg-green-500 text-black" : "bg-white/10"}`}
                >
                  {i}
                </span>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
