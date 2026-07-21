import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useNavigate } from "react-router-dom"
import { Droplets, Grip, Home, RotateCcw, Shield, Skull, Swords, X, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface PlayerState {
  life: number
  poison: number
  energy: number
  tax: number
  commander: Record<number, number>
}

type Orientation = "table" | "screen" | "around" | "custom"
type Resource = "poison" | "energy" | "tax" | "damage"

const ACCENTS = ["#ef4444", "#a855f7", "#eab308", "#38bdf8"]
const START = (life = 40): PlayerState => ({ life, poison: 0, energy: 0, tax: 0, commander: {} })

function savedGame() {
  try {
    const parsed = JSON.parse(localStorage.getItem("grimore.life.game") || "null")
    if (parsed?.players?.length >= 2 && [2, 3, 4].includes(parsed.count)) return parsed as { players: PlayerState[]; count: 2 | 3 | 4; orientation: Orientation; angles: number[] }
  } catch { /* Start a fresh table when saved state is invalid. */ }
  return { players: Array.from({ length: 4 }, () => START()), count: 4 as const, orientation: "around" as const, angles: presetAngles(4, "around") }
}

function presetAngles(count: number, mode: Exclude<Orientation, "custom">) {
  if (mode === "screen") return [0, 0, 0, 0]
  if (mode === "table") return count === 2 ? [180, 0, 0, 0] : [180, 0, 0, 0]
  if (count === 2) return [180, 0, 0, 0]
  if (count === 3) return [180, 90, -90, 0]
  return [180, -90, 90, 0]
}

function CounterPill({
  label,
  icon,
  value,
  expanded,
  onToggle,
  onAdjust,
}: {
  label: string
  icon: React.ReactNode
  value: number
  expanded: boolean
  onToggle: () => void
  onAdjust: (delta: number) => void
}) {
  return (
    <div className={cn("life-resource", value > 0 && "has-value", expanded && "is-expanded")}>
      {expanded && <button type="button" aria-label={`Decrease ${label}`} onClick={() => onAdjust(-1)}>−</button>}
      <button type="button" className="life-resource-main" aria-expanded={expanded} aria-label={`${label}: ${value}`} onClick={onToggle}>
        {icon}<span>{value}</span>
      </button>
      {expanded && <button type="button" aria-label={`Increase ${label}`} onClick={() => onAdjust(1)}>+</button>}
    </div>
  )
}

function PlayerDial({
  index,
  count,
  state,
  rotation,
  onChange,
  onRotate,
}: {
  index: number
  count: number
  state: PlayerState
  rotation: number
  onChange: (next: PlayerState) => void
  onRotate: (angle: number) => void
}) {
  const dialRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Resource | null>(null)
  const commanderValues = Object.values(state.commander)
  const lethal = state.life <= 0 || state.poison >= 10 || commanderValues.some((value) => value >= 21)

  function adjustResource(key: "poison" | "energy" | "tax", delta: number) {
    onChange({ ...state, [key]: Math.max(0, state[key] + delta) })
  }

  function adjustDamage(source: number, delta: number) {
    const previous = state.commander[source] ?? 0
    const next = Math.max(0, previous + delta)
    const applied = next - previous
    onChange({
      ...state,
      life: state.life - applied,
      commander: { ...state.commander, [source]: next },
    })
  }

  function beginRotate(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    const rect = dialRef.current?.getBoundingClientRect()
    if (!rect) return
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const move = (pointer: PointerEvent) => {
      const degrees = Math.atan2(pointer.clientY - centerY, pointer.clientX - centerX) * 180 / Math.PI + 90
      onRotate(Math.round(degrees / 15) * 15)
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop, { once: true })
    window.addEventListener("pointercancel", stop, { once: true })
  }

  const sources = Array.from({ length: count }, (_, source) => source).filter((source) => source !== index)

  return (
    <div
      ref={dialRef}
      className={cn("life-dial", lethal && "is-lethal", expanded && "is-expanded")}
      style={{ "--player-accent": ACCENTS[index], "--dial-rotation": `${rotation}deg` } as React.CSSProperties}
    >
      <button type="button" className="life-rotate-handle" onPointerDown={beginRotate} aria-label={`Rotate player ${index + 1} counter. Current angle ${rotation} degrees`}>
        <Grip /><span>{rotation}°</span>
      </button>

      <button type="button" className="life-tap-zone is-minus" aria-label={`Decrease player ${index + 1} life`} onClick={() => onChange({ ...state, life: state.life - 1 })}><span>−</span></button>
      <button type="button" className="life-tap-zone is-plus" aria-label={`Increase player ${index + 1} life`} onClick={() => onChange({ ...state, life: state.life + 1 })}><span>+</span></button>

      <div className="life-total" role="status" aria-label={`${state.life} life`}>
        {lethal ? <Skull /> : state.life}
      </div>

      <div className="life-resources">
        <CounterPill label="Poison" icon={<Droplets />} value={state.poison} expanded={expanded === "poison"} onToggle={() => setExpanded(expanded === "poison" ? null : "poison")} onAdjust={(delta) => adjustResource("poison", delta)} />
        <CounterPill label="Energy" icon={<Zap />} value={state.energy} expanded={expanded === "energy"} onToggle={() => setExpanded(expanded === "energy" ? null : "energy")} onAdjust={(delta) => adjustResource("energy", delta)} />
        <CounterPill label="Commander tax" icon={<Shield />} value={state.tax} expanded={expanded === "tax"} onToggle={() => setExpanded(expanded === "tax" ? null : "tax")} onAdjust={(delta) => adjustResource("tax", delta)} />
        <button type="button" className={cn("life-damage-trigger", commanderValues.some((value) => value > 0) && "has-value")} aria-expanded={expanded === "damage"} aria-label="Commander damage" onClick={() => setExpanded(expanded === "damage" ? null : "damage")}><Swords /></button>
      </div>

      {expanded === "damage" && (
        <div className="life-damage-tray" aria-label="Commander damage received">
          {sources.map((source) => (
            <div key={source} className="life-damage-source" style={{ "--source-accent": ACCENTS[source] } as React.CSSProperties}>
              <button type="button" aria-label={`Decrease damage from player ${source + 1}`} onClick={() => adjustDamage(source, -1)}>−</button>
              <span>{state.commander[source] ?? 0}</span>
              <button type="button" aria-label={`Increase damage from player ${source + 1}`} onClick={() => adjustDamage(source, 1)}>+</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Life() {
  const navigate = useNavigate()
  const [initial] = useState(savedGame)
  const [players, setPlayers] = useState<PlayerState[]>(initial.players)
  const [count, setCount] = useState<2 | 3 | 4>(initial.count)
  const [orientation, setOrientation] = useState<Orientation>(initial.orientation)
  const [angles, setAngles] = useState(initial.angles)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem("grimore.life.game", JSON.stringify({ players, count, orientation, angles }))
  }, [players, count, orientation, angles])

  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    void navigator.wakeLock?.request("screen").then((sentinel) => { lock = sentinel }).catch(() => undefined)
    return () => { void lock?.release() }
  }, [])

  function updatePlayer(index: number, next: PlayerState) {
    navigator.vibrate?.(8)
    setPlayers((current) => current.map((player, playerIndex) => playerIndex === index ? next : player))
  }

  function reset(life: number) {
    setPlayers(Array.from({ length: 4 }, () => START(life)))
  }

  function setPlayerCount(next: 2 | 3 | 4) {
    setCount(next)
    const mode = orientation === "custom" ? "around" : orientation
    setOrientation(mode)
    setAngles(presetAngles(next, mode))
  }

  function setMode(mode: Exclude<Orientation, "custom">) {
    setOrientation(mode)
    setAngles(presetAngles(count, mode))
  }

  return (
    <div className="life-stage" data-count={count}>
      <div className="life-grid">
        {players.slice(0, count).map((player, index) => (
          <PlayerDial key={index} index={index} count={count} state={player} rotation={angles[index] ?? 0} onChange={(next) => updatePlayer(index, next)} onRotate={(angle) => { setAngles((current) => current.map((value, angleIndex) => angleIndex === index ? angle : value)); setOrientation("custom") }} />
        ))}
      </div>

      <div className="life-center-controls">
        <button type="button" className="life-logo-button" aria-expanded={menuOpen} aria-label="Open game settings" onClick={() => setMenuOpen(true)}>
          <img src="/logo.svg?v=mythic" alt="" />
        </button>
        {menuOpen && (
          <section className="life-menu" role="dialog" aria-label="Game settings">
            <header><div><span>Commander</span><strong>Game setup</strong></div><div><Button variant="secondary" size="icon" aria-label="Back to Discover" onClick={() => navigate("/discover")}><Home /></Button><Button variant="secondary" size="icon" aria-label="Close game settings" onClick={() => setMenuOpen(false)}><X /></Button></div></header>
            <div className="life-menu-row"><span>Players</span><div>{([2, 3, 4] as const).map((value) => <button key={value} type="button" aria-pressed={count === value} onClick={() => setPlayerCount(value)}>{value}</button>)}</div></div>
            <div className="life-menu-stack"><span>Players face</span><div>{(["table", "screen", "around"] as const).map((mode) => <button key={mode} type="button" aria-pressed={orientation === mode} onClick={() => setMode(mode)}>{mode === "table" ? "Across" : mode === "screen" ? "Same side" : "Around"}</button>)}</div></div>
            <div className="life-menu-row"><span>New game</span><div>{[20, 30, 40].map((life) => <button key={life} type="button" onClick={() => reset(life)}>{life}</button>)}</div></div>
            <Button variant="secondary" className="w-full" onClick={() => { reset(40); setMode("around") }}><RotateCcw /> Reset Commander game</Button>
          </section>
        )}
      </div>
    </div>
  )
}
