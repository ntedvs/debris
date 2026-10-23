import { applyRates } from "../sim/rates"
import { getQuad } from "../sim/quads"
import type { Rates } from "../sim/spec"
import { settings, useSettings } from "../settings"

type RateType = Rates["type"]
const LABELS: Record<RateType, [string, string, string]> = {
  actual: ["Center sensitivity", "Max rate", "Expo"],
  betaflight: ["RC rate", "Super rate", "RC expo"],
  kiss: ["RC rate", "Rate", "RC curve"],
  quick: ["RC rate (deg/s)", "Max rate", "Expo"],
}
const DEFAULTS: Record<RateType, { a: number; b: number; expo: number }> = {
  actual: { a: 70, b: 670, expo: 0 },
  betaflight: { a: 1, b: 0.7, expo: 0 },
  kiss: { a: 1, b: 0.7, expo: 0 },
  quick: { a: 200, b: 670, expo: 0 },
}
const AXES = ["roll", "pitch", "yaw"] as const
const COLORS = { roll: "#38bdf8", pitch: "#f472b6", yaw: "#facc15" }

function Curve({ rates }: { rates: Rates }) {
  const W = 260
  const H = 160
  const maxRate = Math.max(...AXES.map((a) => applyRates(rates.type, rates[a], 1)), 100)
  return (
    <svg width={W} height={H} className="rounded bg-white/5">
      {AXES.map((a) => {
        const pts = Array.from({ length: 51 }, (_, i) => {
          const x = i / 50
          const y = applyRates(rates.type, rates[a], x)
          return `${x * W},${H - (y / maxRate) * (H - 10)}`
        })
        return (
          <polyline key={a} points={pts.join(" ")} fill="none" stroke={COLORS[a]} strokeWidth={2} />
        )
      })}
    </svg>
  )
}

export function RatesEditor() {
  const s = useSettings()
  const quad = getQuad(s.quadId)
  const rates = s.rates ?? quad.fc.rates
  const labels = LABELS[rates.type]

  const update = (r: Rates) => settings.set({ rates: r })
  const setType = (type: RateType) =>
    update({
      type,
      roll: { ...DEFAULTS[type] },
      pitch: { ...DEFAULTS[type] },
      yaw: { ...DEFAULTS[type] },
    } as Rates)

  return (
    <div className="space-y-5">
      <p className="text-sm text-white/70">
        Same math as Betaflight, so you can copy the numbers from your quad's Rates tab.
      </p>
      <div className="flex items-center gap-3">
        <span className="text-sm">Rates type</span>
        <select
          className="rounded bg-white/10 px-2 py-1"
          value={rates.type}
          onChange={(e) => setType(e.target.value as RateType)}
        >
          {(Object.keys(LABELS) as RateType[]).map((t) => (
            <option key={t} value={t} className="bg-neutral-900">
              {t[0]!.toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
        <button
          className="ml-auto rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
          onClick={() => settings.set({ rates: null })}
        >
          Reset to default
        </button>
      </div>
      <table className="text-sm">
        <thead>
          <tr className="text-left text-white/60">
            <th className="w-20" />
            {labels.map((l) => (
              <th key={l} className="pr-4 font-normal">
                {l}
              </th>
            ))}
            <th className="font-normal">Max deg/s</th>
          </tr>
        </thead>
        <tbody>
          {AXES.map((axis) => (
            <tr key={axis} className="h-9">
              <td style={{ color: COLORS[axis] }} className="capitalize">
                {axis}
              </td>
              {(["a", "b", "expo"] as const).map((k) => (
                <td key={k} className="pr-4">
                  <input
                    type="number"
                    step={
                      k === "expo" || rates.type === "betaflight" || rates.type === "kiss"
                        ? 0.01
                        : 10
                    }
                    className="w-24 rounded bg-white/10 px-2 py-0.5"
                    value={rates[axis][k]}
                    onChange={(e) =>
                      update({
                        ...rates,
                        [axis]: { ...rates[axis], [k]: Number(e.target.value) },
                      } as Rates)
                    }
                  />
                </td>
              ))}
              <td className="tabular-nums">{Math.round(applyRates(rates.type, rates[axis], 1))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Curve rates={rates} />
    </div>
  )
}
