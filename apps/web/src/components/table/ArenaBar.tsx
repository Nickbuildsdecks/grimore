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
  attackRead, decisionLabel, manaPips, orderingDone, primaryMove, specAt, targetsRequired,
  targetsWanted, type ArenaEvent, type ArenaMode,
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
  /**
   * What an attack can be sent at: every player still in the game but you, and each planeswalker
   * they control (CR 506.2).
   *
   * The planeswalkers are read off the board rather than asked for, because "which permanents are
   * planeswalkers" is a fact in the view rather than a rule — and the engine validates the
   * declaration either way, so the worst a wrong one can do is be refused.
   */
  const defendable = view.seats
    .filter((s) => s.index !== view.seat && !s.eliminated)
    .flatMap((s) => [
      { key: `seat-${s.index}`, seat: s.index, name: s.name, planeswalker: undefined as string | undefined },
      ...Object.values(view.cards)
        .filter((c) => c.zone === "battlefield" && c.zoneSeat === s.index
          && /planeswalker/i.test(c.card?.typeLine ?? ""))
        .map((c) => ({
          key: `walker-${c.id}`, seat: s.index, name: c.card?.name ?? "planeswalker", planeswalker: c.id,
        })),
    ])
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

      {/*
        How big is it? X is part of casting the spell (CR 601.2b), so it is asked before the
        targets and shown as the numbers the player can actually pay for — the ceiling comes from
        the engine, which is the only thing that knows what the mana will cover.
      */}
      {mode.kind === "payingX" ? (
        <div data-testid="x-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">{mode.play.name}</span>
          <span className="text-[var(--g-text-muted)]">choose X</span>
          <span className="flex flex-wrap items-center gap-1">
            {Array.from({ length: (mode.play.xMax ?? 0) + 1 }, (_, n) => n).map((n) => (
              <Button
                key={n}
                size="sm"
                variant={mode.chosen === n ? "default" : "ghost"}
                className="h-6 w-7 px-0 text-[10px] tabular-nums"
                data-testid={`pick-x-${n}`}
                onClick={() => dispatch({ kind: "setX", amount: n })}
              >
                {n}
              </Button>
            ))}
          </span>
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" data-testid="confirm-x" onClick={() => dispatch({ kind: "confirm" })}>
              <Check className="size-3.5" /> X = {mode.chosen}
            </Button>
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
            {mode.ask.from === "library" ? "tap a card in your library below"
              : mode.ask.from === "library-top" ? "tap the ones to put on the bottom"
                : `tap a card in your ${mode.ask.from}`}
          </span>
          <span className="ml-auto flex gap-1.5">
            {mode.chosen.length >= mode.ask.min && mode.ask.min !== mode.ask.max ? (
              <Button size="sm" data-testid="confirm-decision" onClick={() => dispatch({ kind: "confirm" })}>
                <Check className="size-3.5" />
                {/* "Choose nothing" is the right words for a sacrifice and the wrong ones for a
                    scry, where choosing nothing is keeping what you were shown. */}
                {mode.ask.from === "library-top"
                  ? mode.chosen.length === 0
                    ? `Keep ${mode.ask.max === 1 ? "it" : "them"} on top`
                    : `Bottom ${mode.chosen.length}`
                  : mode.chosen.length === 0 ? "Choose nothing" : "Confirm"}
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
            Why one of them is already tapped and will not untap. Named rather than counted: the
            player is looking for the creature they cannot take back, and "1 must attack" sends
            them hunting across the board for it.
          */}
          {(mode.forced ?? []).length > 0 ? (
            <span data-testid="attack-forced" className="text-[var(--g-text-muted)]">
              {(mode.forced ?? [])
                .map((id) => view.cards[id]?.card?.name ?? "a creature")
                .join(", ")}
              {" attacks each combat if able"}
            </span>
          ) : null}
          {/*
            And who a goaded creature may not be sent at, named both ways round. Without it the
            player taps a creature expecting it to join the swing and watches its arrow go
            somewhere else — the table moved it because the aim it was given was refused, and a
            reason that is not on screen reads as a bug.
          */}
          {(mode.aims ?? []).map((entry) => {
            const barred = view.seats
              .filter((s) => s.index !== view.seat && !s.eliminated)
              .filter((s) => !entry.defenders.includes(s.index))
            if (barred.length === 0) return null
            return (
              <span
                key={`aim-${entry.card}`}
                data-testid={`attack-goaded-${entry.card}`}
                className="text-[var(--g-text-muted)]"
              >
                {view.cards[entry.card]?.card?.name ?? "a creature"}
                {" was goaded — it cannot attack "}
                {barred.map((s) => s.name).join(" or ")}
              </span>
            )
          })}
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
              {defendable.map((option) => {
                const aimed = mode.chosen.filter(
                  (a) => a.defender === option.seat && a.planeswalker === option.planeswalker,
                ).length
                const current = mode.defender === option.seat && mode.planeswalker === option.planeswalker
                /*
                  What going at this player is walking into, on the button that sends you there.

                  Their life and what they have left to block with are the whole of the pod
                  decision, and they were on screen only as cards to count across three columns.
                  A planeswalker option says nothing: its loyalty is drawn on the card, and the
                  blockers are its controller's — already on their own button beside it.
                */
                const sending = mode.chosen
                  .filter((a) => a.defender === option.seat && a.planeswalker === option.planeswalker)
                  .reduce((n, a) => n + (view.cards[a.attacker]?.power ?? 0), 0)
                const read = option.planeswalker === undefined
                  ? attackRead(view, option.seat, sending)
                  : null
                return (
                  <Button
                    key={option.key}
                    size="sm"
                    variant={current ? "default" : "ghost"}
                    className="h-6 px-2 text-[10px]"
                    data-testid={option.planeswalker === undefined
                      ? `attack-seat-${option.seat}`
                      : `attack-walker-${option.planeswalker}`}
                    onClick={() => dispatch({
                      kind: "aimAttacks", seat: option.seat, planeswalker: option.planeswalker,
                    })}
                  >
                    {option.name}
                    {read === null ? "" : ` ${read.life}`}
                    {read !== null && read.ready > 0 ? ` · ${read.readyPower} up` : ""}
                    {aimed > 0 ? ` · ${aimed}` : ""}
                    {read?.lethal === true ? " · lethal" : ""}
                  </Button>
                )
              })}
              {/*
                All of them at whoever is aimed at now. One press for the decision a pod turn
                actually makes — see `aimAll` — rather than untapping and retapping every creature
                with the aim changed in between.
              */}
              {mode.chosen.length > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  data-testid="aim-all"
                  onClick={() => dispatch({
                    kind: "aimAll", seat: mode.defender, planeswalker: mode.planeswalker,
                  })}
                >
                  All at {defendable.find((o) =>
                    o.seat === mode.defender && o.planeswalker === mode.planeswalker)?.name ?? "them"}
                </Button>
              ) : null}
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
        The damage assignment order (CR 509.2), which is the attacking player's and was the
        defending player's until this was built: the engine spent an attacker's power in the order
        the *blocks* were declared. Measured over 160 four-seat pods, that cost the attacker a kill
        it could have had 32 times.

        Asked per attacking creature, in the order the player taps — so a 5/5 into a 2/2 and a 4/4
        can kill either one, and the choice is on the board rather than decided for them. Only
        attacks where the order can change which blockers die are ever asked about.
      */}
      {mode.kind === "ordering" ? (
        <div data-testid="order-prompt" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-[var(--g-text-high)]">
            <Swords className="mr-1 inline size-3.5" />
            Tap the blockers in the order damage is assigned
          </span>
          {mode.owed.map((ask) => {
            const picked = mode.chosen[ask.attacker] ?? []
            return (
              <span key={`order-${ask.attacker}`} data-testid={`order-${ask.attacker}`} className="text-[var(--g-text-muted)]">
                {view.cards[ask.attacker]?.card?.name ?? "a creature"}
                {": "}
                {picked.length === 0
                  ? `${ask.blockers.length} to order`
                  : picked.map((id) => view.cards[id]?.card?.name ?? "a creature").join(", then ")}
              </span>
            )
          })}
          <span className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              data-testid="confirm-order"
              disabled={!orderingDone(mode.owed, mode.chosen)}
              onClick={() => dispatch({ kind: "confirm" })}
            >
              <Check className="size-3.5" /> Assign damage
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

          Yours and nobody else's, which the wording here always claimed and the engine did not: it
          was one boolean on the game, so pressing this turned stops off for your opponent as well,
          and they were then asked twenty-five times a turn about a setting they never touched.
          `automation.autoPass` is per seat now, so this reads the viewer's own answer.
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
