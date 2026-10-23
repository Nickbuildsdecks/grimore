/**
 * Where the turn is, and who is holding it up.
 *
 * The single most common question at an automated table is "why can't I do anything", and the
 * answer is almost always the step or who has priority. Both are drawn, always, rather than
 * inferred from a button being disabled.
 *
 * The thirteen steps are grouped into the five phases players actually talk about, because a
 * thirteen-segment track is unreadable on a phone and nobody thinks of the untap step as a place
 * they are. The current step's own name is spelled out next to the track.
 */
import { cn } from "@/lib/utils"
import type { GameView } from "@grimore/rules-engine"

/** The phases, and which steps belong to each. Order matches the engine's `STEPS`. */
const PHASES: { id: string; label: string; short: string; steps: readonly string[] }[] = [
  { id: "beginning", label: "Beginning", short: "Begin", steps: ["untap", "upkeep", "draw"] },
  { id: "main1", label: "Main phase 1", short: "Main 1", steps: ["precombat-main"] },
  {
    id: "combat",
    label: "Combat",
    short: "Combat",
    steps: ["begin-combat", "declare-attackers", "declare-blockers", "first-strike-damage", "combat-damage", "end-combat"],
  },
  { id: "main2", label: "Main phase 2", short: "Main 2", steps: ["postcombat-main"] },
  { id: "ending", label: "Ending", short: "End", steps: ["end", "cleanup"] },
]

export function PhaseBar({ view }: { view: GameView }) {
  const auto = view.automation
  if (!auto) return null
  const activeName = view.seats[view.activeSeat]?.name ?? "opponent"
  const isMyTurn = view.activeSeat === view.seat
  const current = PHASES.find((p) => p.steps.includes(auto.step))

  // Who the game is actually waiting for, which is not always the player whose turn it is — and
  // is nobody once the game is over, where a priority badge would be telling the loser to move.
  const waitingSeat = view.finished ? null : (auto.awaiting?.seats[0] ?? auto.priority)
  const waitingName = waitingSeat === null || waitingSeat === undefined
    ? null
    : waitingSeat === view.seat
      ? "you"
      : (view.seats[waitingSeat]?.name ?? "opponent")

  return (
    <div data-testid="phase-bar" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="flex overflow-hidden rounded-md border border-white/10">
        {PHASES.map((phase) => (
          <span
            key={phase.id}
            data-testid={`phase-${phase.id}`}
            data-current={current?.id === phase.id ? "true" : "false"}
            title={phase.label}
            className={cn(
              "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              current?.id === phase.id
                ? "bg-[var(--g-gold-400)] text-black"
                : "bg-white/5 text-[var(--g-text-muted)]",
            )}
          >
            {phase.short}
          </span>
        ))}
      </span>
      <span data-testid="step-label" className="font-semibold text-[var(--g-text-high)]">
        {auto.stepLabel}
      </span>
      <span data-testid="turn-owner" className="text-[var(--g-text-muted)]">
        {isMyTurn ? "your turn" : `${activeName}'s turn`}
      </span>
      {waitingName !== null ? (
        <span
          data-testid="waiting-on"
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            waitingSeat === view.seat
              ? "bg-[var(--g-status-info)] text-black"
              : "bg-white/10 text-[var(--g-text-muted)]",
          )}
        >
          {auto.awaiting === null
            ? `${waitingName === "you" ? "you have" : `${waitingName} has`} priority`
            : `waiting on ${waitingName} — ${auto.awaiting.kind}`}
        </span>
      ) : null}
    </div>
  )
}
