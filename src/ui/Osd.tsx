import type { GameStatus } from "../game"

const fmtTime = (t: number) => {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/** Betaflight style OSD overlay. */
export function Osd({ status }: { status: GameStatus | null }) {
  if (!status) return null
  const s = status
  const lowBat = s.cellVoltage < 3.5
  const center = s.crashed
    ? "CRASH"
    : !s.armed
      ? s.armBlocked
        ? `ARM BLOCKED: ${s.armBlocked}`
        : "DISARMED"
      : null
  return (
    <div
      className="pointer-events-none absolute inset-0 select-none font-mono text-[15px] font-bold text-white"
      style={{ textShadow: "0 0 2px #000, 0 0 2px #000, 1px 1px 0 #000" }}
    >
      <div className="absolute left-6 top-5">
        <span className={lowBat ? "text-red-400" : ""}>{s.voltage.toFixed(1)}V</span>
        <span className="ml-3 opacity-80">{s.cellVoltage.toFixed(2)}v/c</span>
      </div>
      <div className="absolute right-6 top-5">{fmtTime(s.flightTime)}</div>
      <div className="absolute bottom-5 left-6">
        {s.current.toFixed(1)}A <span className="ml-3">{Math.round(s.mahUsed)}mAh</span>
      </div>
      <div className="absolute bottom-5 right-6 text-right">
        {Math.round(s.speed * 3.6)}km/h <span className="ml-3">{s.altitude.toFixed(0)}m</span>
      </div>
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2">
        THR {Math.round(s.throttle * 100)}%
      </div>
      {s.view === "fpv" && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-70">
          -+-
        </div>
      )}
      {center && (
        <div className="absolute left-1/2 top-[38%] -translate-x-1/2 text-xl">{center}</div>
      )}
      {!s.armed && (
        <div className="absolute left-1/2 top-[44%] -translate-x-1/2 text-center text-xs font-normal opacity-80">
          {s.input.source === "gamepad"
            ? "Flip your arm switch to arm (throttle low)"
            : s.input.source === "keyboard"
              ? "No radio found. Keyboard: Space arm, W/S throttle, arrows, A/D yaw"
              : ""}
          <br />
          Esc menu, R reset, V view, N next spawn
        </div>
      )}
      <div className="absolute right-6 top-12 text-[10px] font-normal opacity-50">
        {Math.round(s.fps)} fps {s.view.toUpperCase()}
        {s.noCrash && " NO-CRASH"}
      </div>
    </div>
  )
}
