/**
 * The one bar at the bottom that holds whatever the player is actually being asked for.
 *
 * On an automated table the only control that is always correct is "do the thing the engine is
 * waiting for", and what that is changes constantly: pass, resolve, declare attackers, confirm a
 * block, discard to hand size, pick a second target. So instead of a row of buttons that are mostly
 * disabled, this draws exactly one primary action, labelled with what it will do, plus whatever the
 * current step adds: the mana floating, the targets left to choose, the attackers picked so far.
 *
 * It holds no rules. The label comes from `legalActions.passLabel`, the legal attackers come from
 * `legalActions.attackers`, and the mana comes from the pool the server sent.
 */
import { useState } from "react"
import { Check, FastForward, Hand, Skull, Swords, X } from "lucide-react"
import type { GameView } from "@grimore/rules-engine"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  decisionLabel, manaPips, primaryMove, specAt, targetsRequired, targetsWanted,
  type ArenaEvent, type ArenaMode,
} from "@/lib/arena"

const MANA_BG: Record<string, string> = {
  W: "var(--g-mana-w)",
  U: "var(--g-mana-u)",
  B: "var(--g-mana-b)",
  R: "var(--g-mana-r)",
  G: "var(--g-mana-g)",
  C: "var(--g-mana-c)",
}

export interface ArenaBarProps {
  view: GameView
  mode: ArenaMode
  /** Sends an interaction event into the reducer. */
  dispatch: (event: ArenaEvent) => void
  /** Sends a table action straight to the server. */
  onAct: (action: Record<string, unknown> & { type: string }) => void
}

export function ArenaBar({ view, mode, dispatch, onAct }: ArenaBarProps) {
  /**
   * Whether the concede button is armed.
   *
   * Two taps, which the tabletop's own concede button does not ask for — and should, but there a
   * misclick costs a game two people can simply carry on playing by hand. Here it ends your game
   * inside the engine, and in a pod it ends it while three other people keep playing.
   */
  const [arming, setArming] = useState(false)
  const auto = view.automation
  const you = auto?.you
  if (!auto || !you) return null
  const move = primaryMove(view)
  /** The players an attack can be sent at: everybody still in the game but you. */
  const defendable = view.seats.filter((s) => s.index !== view.seat && !s.eliminated)
  /** Who the game is waiting on, when it is exactly one person and not you. */
  const waitingSeats = (auto.awaiting?.seats ?? []).filter((s) => s !== view.seat)
  const waitingFor = waitingSeats.length === 1
    ? view.seats.find((s) => s.index === waitingSeats[0])?.name ?? null
    : null
  const pool = manaPips(auto.pools[String(view.seat)] as Record<string, number> | undefined)
  const potential = manaPips(you.potential as unknown as Record<string, number>)

  return (
    <div
      data-testid="arena-bar"
      className="sticky bottom-0 -mx-2 flex flex-col gap-1.5 border-t border-white/10 bg-[var(--g-surface-base)]/95 px-2 py-2 backdrop-blur sm:-mx-4 sm:px-4"
    >
      {/* What the player is halfway through, if anything. */}
      {mode.kind === "targeting" ? (
        <div data-testid="target-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">{mode.play.name}</span>
          <span className="text-[var(--g-text-muted)]">
            choose {specAt(mode.play, mode.chosen.length)?.description ?? "a target"}
            {targetsWanted(mode.play) > 1 ? ` (${mode.chosen.length + 1} of ${targetsWanted(mode.play)})` : ""}
          </span>
          <span className="ml-auto flex gap-1.5">
            {mode.chosen.length >= targetsRequired(mode.play) ? (
              <Button size="sm" data-testid="confirm-targets" onClick={() => dispatch({ kind: "confirm" })}>
                <Check className="size-3.5" /> Cast
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" data-testid="cancel-mode" onClick={() => dispatch({ kind: "cancel" })}>
              <X className="size-3.5" /> Cancel
            </Button>
          </span>
        </div>
      ) : null}

      {mode.kind === "feeding" ? (
        <div data-testid="feed-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">{mode.play.description}</span>
          <span className="text-[var(--g-text-muted)]">tap a creature to sacrifice</span>
          <Button size="sm" variant="ghost" className="ml-auto" data-testid="cancel-mode" onClick={() => dispatch({ kind: "cancel" })}>
            <X className="size-3.5" /> Cancel
          </Button>
        </div>
      ) : null}

      {mode.kind === "choosing" ? (
        <div data-testid="choose-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">{mode.description}</span>
          <span className="text-[var(--g-text-muted)]">choose a target</span>
          <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--g-text-muted)]">
            the ability is already on the stack
          </span>
        </div>
      ) : null}

      {/*
        A question a card asked while it was resolving. Different from targeting in the one way
        that matters on screen: the spell is already resolving, so there is nothing to cancel —
        the game is stopped until it is answered. A library search draws the library beside the
        prompt, which is the only time that zone is on screen at all.
      */}
      {mode.kind === "deciding" ? (
        <div data-testid="decide-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">
            {decisionLabel(mode.ask, mode.chosen)}
          </span>
          <span className="text-[var(--g-text-muted)]">
            {mode.ask.from === "library" ? "tap a card in your library below" : `tap a card in your ${mode.ask.from}`}
          </span>
          <span className="ml-auto flex gap-1.5">
            {mode.chosen.length >= mode.ask.min && mode.ask.min !== mode.ask.max ? (
              <Button size="sm" data-testid="confirm-decision" onClick={() => dispatch({ kind: "confirm" })}>
                <Check className="size-3.5" /> {mode.chosen.length === 0 ? "Choose nothing" : "Confirm"}
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}

      {mode.kind === "attackers" ? (
        <div data-testid="attack-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">
            <Swords className="mr-1 inline size-3.5" />
            {mode.chosen.length === 0 ? "Tap the creatures that attack" : `${mode.chosen.length} attacking`}
          </span>
          <span className="text-[var(--g-text-muted)]">
            {you.attackers.length} can attack
          </span>
          {/*
            Who you are attacking, when there is more than one answer. With two players there is
            nothing to choose and the row would be a button that does nothing; in a pod it is the
            whole decision, and without it every attack went at the lowest-numbered opponent.
            Each creature keeps the player it was tapped for, so one attack can go left and the
            next right — which is what the engine has always accepted.
          */}
          {defendable.length > 1 ? (
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-[var(--g-text-muted)]">attacking</span>
              {defendable.map((s) => {
                const aimed = mode.chosen.filter((a) => a.defender === s.index).length
                return (
                  <Button
                    key={s.index}
                    size="sm"
                    variant={mode.defender === s.index ? "default" : "ghost"}
                    className="h-6 px-2 text-[10px]"
                    data-testid={`attack-seat-${s.index}`}
                    onClick={() => dispatch({ kind: "aimAttacks", seat: s.index })}
                  >
                    {s.name}
                    {aimed > 0 ? ` ${aimed}` : ""}
                  </Button>
                )
              })}
            </span>
          ) : null}
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" data-testid="confirm-attackers" onClick={() => dispatch({ kind: "confirm" })}>
              <Check className="size-3.5" /> {mode.chosen.length === 0 ? "Attack with nothing" : "Attack"}
            </Button>
          </span>
        </div>
      ) : null}

      {mode.kind === "blockers" ? (
        <div data-testid="block-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">
            {mode.holding === null
              ? mode.chosen.length === 0
                ? "Tap a creature to block with"
                : `${mode.chosen.length} blocking — tap another, or confirm`
              : "Now tap the attacker it blocks"}
          </span>
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" data-testid="confirm-blockers" onClick={() => dispatch({ kind: "confirm" })}>
              <Check className="size-3.5" /> {mode.chosen.length === 0 ? "No blocks" : "Block"}
            </Button>
          </span>
        </div>
      ) : null}

      {/*
        Opening hands. The decision sits on the board rather than on a screen of its own, because
        what it is about is the seven cards already laid out in front of you.
      */}
      {you.mustSettleHand && mode.kind !== "bottoming" ? (
        <div data-testid="mulligan-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">
            {you.bottomOwed === 0 ? "Keep this hand, or mulligan?" : `Keep, putting ${you.bottomOwed} back`}
          </span>
          <Button
            size="sm"
            data-testid="primary-move"
            onClick={() => {
              if (move?.event != null) dispatch(move.event)
              else if (move?.action != null) onAct(move.action)
            }}
          >
            {move?.label ?? "Keep"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid="mulligan"
            onClick={() => onAct({ type: "mulligan", seat: view.seat ?? 0 })}
          >
            Mulligan
          </Button>
        </div>
      ) : null}

      {mode.kind === "bottoming" ? (
        <div data-testid="bottom-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">
            Tap {you.bottomOwed} card{you.bottomOwed === 1 ? "" : "s"} to put on the bottom
          </span>
          <span className="text-[var(--g-text-muted)]">{mode.chosen.length} chosen</span>
          <span className="ml-auto flex gap-1.5">
            {mode.chosen.length === you.bottomOwed ? (
              <Button size="sm" data-testid="confirm-bottom" onClick={() => dispatch({ kind: "confirm" })}>
                <Check className="size-3.5" /> Keep
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" data-testid="cancel-mode" onClick={() => dispatch({ kind: "cancel" })}>
              <X className="size-3.5" /> Cancel
            </Button>
          </span>
        </div>
      ) : null}

      {you.mustDiscard > 0 ? (
        <div data-testid="discard-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <Hand className="size-3.5 text-[var(--g-gold-400)]" />
          <span className="font-semibold text-[var(--g-text-high)]">
            Over hand size — tap {you.mustDiscard} card{you.mustDiscard === 1 ? "" : "s"} in hand to discard.
          </span>
        </div>
      ) : null}

      {/* Mana, and the primary action. */}
      <div className="flex items-center gap-2">
        <span data-testid="mana-pool" className="flex items-center gap-1">
          {pool.length === 0 ? (
            <span className="text-[10px] uppercase tracking-wide text-[var(--g-text-muted)]">no mana</span>
          ) : (
            pool.map((pip) => (
              <span
                key={pip.type}
                data-testid={`pool-${pip.type}`}
                className="flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-black"
                style={{ background: MANA_BG[pip.type] }}
              >
                {pip.count}
              </span>
            ))
          )}
          {/*
            What is still untapped, shown dimmer. `legalActions` judges what a player can afford
            against this rather than against the floating pool, so showing only the pool would make
            a castable spell look unaffordable.
          */}
          {potential.length > 0 ? (
            <span data-testid="mana-potential" className="ml-1 flex items-center gap-1 opacity-50">
              {potential.map((pip) => (
                <span
                  key={pip.type}
                  className="flex size-4 items-center justify-center rounded-full text-[9px] font-bold text-black"
                  style={{ background: MANA_BG[pip.type] }}
                >
                  {pip.count}
                </span>
              ))}
            </span>
          ) : null}
        </span>

        {mode.kind === "idle" && move !== null && you.mustDiscard === 0 && !you.mustSettleHand ? (
          <Button
            size="sm"
            data-testid="primary-move"
            className={cn("ml-auto min-w-28", you.hasPriority || you.mustDeclare !== null ? "" : "opacity-60")}
            onClick={() => {
              if (move.event !== null) dispatch(move.event)
              else if (move.action !== null) onAct(move.action)
            }}
          >
            {move.label}
          </Button>
        ) : null}
        {mode.kind === "idle" && move === null && you.mustDiscard === 0 && !view.finished ? (
          <span data-testid="not-your-move" className="ml-auto text-xs text-[var(--g-text-muted)]">
            {/* Named, because "your opponent" is three people at a pod and one of them is holding it up. */}
            {waitingFor === null ? "waiting for the other players" : `waiting for ${waitingFor}`}
          </span>
        ) : null}
        {view.finished ? (
          <span data-testid="game-finished" className="ml-auto text-xs text-[var(--g-text-muted)]">
            the game is over
          </span>
        ) : null}

        {/*
          The stops toggle. On, the engine passes for you whenever passing is your only legal move,
          which is most of a game — off, you are offered every priority in every step, which is
          what a player wants when they are bluffing or learning the turn structure.
        */}
        <Button
          size="sm"
          variant="ghost"
          data-testid="toggle-stops"
          aria-pressed={auto.autoPass}
          title={auto.autoPass
            ? "Skipping priority when you have nothing to do. Tap to be asked every time."
            : "Being asked at every step. Tap to skip the ones you cannot act in."}
          className={cn("h-7 px-2 text-[10px]", mode.kind === "idle" && move !== null ? "" : "ml-auto")}
          onClick={() => onAct({ type: "auto:stops", autoPass: !auto.autoPass })}
        >
          <FastForward className={cn("size-3.5", auto.autoPass ? "" : "opacity-40")} />
          {auto.autoPass ? "skipping" : "every step"}
        </Button>

        {/*
          Leaving the game. The manual bar has always had this and the engine's bar had not, so a
          player in an automated game had no way out of one — in a duel that is a stuck table, and
          in a pod it is three people waiting on somebody who has walked away. Conceding is a real
          rule (CR 104.3a) and the engine has always accepted it; nothing was offering it.
        */}
        {view.finished ? null : (
          <Button
            size="sm"
            variant="ghost"
            data-testid="concede"
            className="h-7 px-2 text-[10px]"
            onClick={() => {
              if (!arming) {
                setArming(true)
                return
              }
              setArming(false)
              onAct({ type: "concede" })
            }}
            onBlur={() => setArming(false)}
          >
            <Skull className="size-3.5" /> {arming ? "really?" : "Concede"}
          </Button>
        )}
      </div>
    </div>
  )
}
