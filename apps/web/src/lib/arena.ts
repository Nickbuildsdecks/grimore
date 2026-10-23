/**
 * The interaction layer for a table the rules engine is running.
 *
 * Everything here is a pure function over the view the server sent, which is deliberate twice over.
 *
 * First, **no rules live here.** The client never decides whether a play is legal, whether a
 * creature may attack, or which targets a spell can have — it reads `view.automation.you`, which
 * the engine computed. A UI that worked any of that out for itself would be a second, worse copy of
 * the rules, and the two would disagree the moment either changed. What is left for the client is
 * only the part that is genuinely about interaction: which of several steps the player is halfway
 * through, and what they have picked so far.
 *
 * Second, **that halfway state is a reducer**, not a pile of `useState`. Choosing two targets for a
 * spell, selecting four attackers, or pairing three blockers with three attackers are small state
 * machines with real edge cases — picking the same blocker twice, changing your mind, a legal
 * target disappearing while you choose — and a reducer is the only version of them that can be
 * tested without a browser.
 */
import type { GameView, LegalPlay, SeatIndex, Target, VisibleCard } from "@grimore/rules-engine"
import type { TableAction } from "@/lib/table"

/** What the player is in the middle of doing. `idle` is the ordinary "pick something" state. */
export type ArenaMode =
  | { kind: "idle" }
  | { kind: "targeting"; play: LegalPlay; chosen: Target[] }
  | { kind: "attackers"; chosen: string[]; defender: SeatIndex }
  | { kind: "blockers"; chosen: Block[]; holding: string | null }

export interface Block {
  blocker: string
  attacker: string
}

export type ArenaEvent =
  | { kind: "cancel" }
  | { kind: "choosePlay"; play: LegalPlay }
  | { kind: "pickTarget"; target: Target }
  | { kind: "undoTarget" }
  | { kind: "confirm" }
  | { kind: "declareAttackers"; defender: SeatIndex }
  | { kind: "toggleAttacker"; card: string }
  | { kind: "declareBlockers" }
  | { kind: "holdBlocker"; card: string }
  | { kind: "assignBlock"; attacker: string }

/** The reducer's answer: the new mode, and an action to send if the step is complete. */
export interface ArenaResult {
  mode: ArenaMode
  action: TableAction | null
}

export const IDLE: ArenaMode = { kind: "idle" }

/** Total targets a play wants, counting a `count: 2` spec twice. */
export function targetsWanted(play: LegalPlay): number {
  return play.targetSpecs.reduce((n, spec) => n + Math.max(1, spec.count ?? 1), 0)
}

/** The fewest targets that make the play castable — "up to one" may legally take none. */
export function targetsRequired(play: LegalPlay): number {
  return play.targetSpecs.reduce((n, spec) => n + (spec.optional ? 0 : Math.max(1, spec.count ?? 1)), 0)
}

/** Which spec the next pick is for, so the prompt can name it. */
export function specAt(play: LegalPlay, index: number): LegalPlay["targetSpecs"][number] | undefined {
  let seen = 0
  for (const spec of play.targetSpecs) {
    const want = Math.max(1, spec.count ?? 1)
    if (index < seen + want) return spec
    seen += want
  }
  return undefined
}

/** Candidates still choosable for the pick at `index`, minus anything already taken. */
export function candidatesAt(play: LegalPlay, index: number, chosen: readonly Target[]): readonly Target[] {
  let seen = 0
  for (let i = 0; i < play.targetSpecs.length; i++) {
    const want = Math.max(1, play.targetSpecs[i]!.count ?? 1)
    if (index < seen + want) {
      const taken = new Set(chosen.map(targetKey))
      return (play.candidates[i] ?? []).filter((t) => !taken.has(targetKey(t)))
    }
    seen += want
  }
  return []
}

export const targetKey = (t: Target): string => (t.kind === "card" ? `card:${t.id}` : `player:${t.seat}`)

/** The action a completed play turns into. */
function playAction(play: LegalPlay, targets: readonly Target[]): TableAction {
  const withTargets = targets.length > 0 ? { targets: [...targets] } : {}
  if (play.kind === "land") return { type: "auto:playLand", card: play.card }
  if (play.kind === "cast") return { type: "auto:cast", card: play.card, ...withTargets }
  return { type: "auto:activate", card: play.card, abilityIndex: play.abilityIndex ?? 0, ...withTargets }
}

/**
 * Advances the interaction one event.
 *
 * Never returns an action it is not sure about: a play with targets left to choose stays in
 * `targeting` until they are all in, so a half-chosen spell is never sent and refused.
 */
export function arenaReducer(mode: ArenaMode, event: ArenaEvent): ArenaResult {
  switch (event.kind) {
    case "cancel":
      return { mode: IDLE, action: null }

    case "choosePlay": {
      const play = event.play
      if (targetsWanted(play) === 0) return { mode: IDLE, action: playAction(play, []) }
      return { mode: { kind: "targeting", play, chosen: [] }, action: null }
    }

    case "pickTarget": {
      if (mode.kind !== "targeting") return { mode, action: null }
      // Picking something already chosen un-picks it, which is how a misclick is undone.
      const key = targetKey(event.target)
      if (mode.chosen.some((t) => targetKey(t) === key)) {
        return { mode: { ...mode, chosen: mode.chosen.filter((t) => targetKey(t) !== key) }, action: null }
      }
      const chosen = [...mode.chosen, event.target]
      if (chosen.length >= targetsWanted(mode.play)) {
        return { mode: IDLE, action: playAction(mode.play, chosen) }
      }
      return { mode: { ...mode, chosen }, action: null }
    }

    case "undoTarget": {
      if (mode.kind !== "targeting") return { mode, action: null }
      if (mode.chosen.length === 0) return { mode: IDLE, action: null }
      return { mode: { ...mode, chosen: mode.chosen.slice(0, -1) }, action: null }
    }

    case "confirm": {
      if (mode.kind === "targeting") {
        // "Up to" spells are the only ones that can be sent with fewer targets than they want.
        if (mode.chosen.length < targetsRequired(mode.play)) return { mode, action: null }
        return { mode: IDLE, action: playAction(mode.play, mode.chosen) }
      }
      if (mode.kind === "attackers") {
        return {
          mode: IDLE,
          action: {
            type: "auto:attack",
            attackers: mode.chosen.map((attacker) => ({ attacker, defender: mode.defender })),
          },
        }
      }
      if (mode.kind === "blockers") {
        return { mode: IDLE, action: { type: "auto:block", blocks: mode.chosen.map((b) => ({ ...b })) } }
      }
      return { mode, action: null }
    }

    case "declareAttackers":
      return { mode: { kind: "attackers", chosen: [], defender: event.defender }, action: null }

    case "toggleAttacker": {
      if (mode.kind !== "attackers") return { mode, action: null }
      const chosen = mode.chosen.includes(event.card)
        ? mode.chosen.filter((id) => id !== event.card)
        : [...mode.chosen, event.card]
      return { mode: { ...mode, chosen }, action: null }
    }

    case "declareBlockers":
      return { mode: { kind: "blockers", chosen: [], holding: null }, action: null }

    case "holdBlocker": {
      if (mode.kind !== "blockers") return { mode, action: null }
      // Tapping a creature that is already blocking takes it out of the block.
      if (mode.chosen.some((b) => b.blocker === event.card)) {
        return {
          mode: { ...mode, chosen: mode.chosen.filter((b) => b.blocker !== event.card), holding: null },
          action: null,
        }
      }
      // Tapping the held creature again puts it down.
      return { mode: { ...mode, holding: mode.holding === event.card ? null : event.card }, action: null }
    }

    case "assignBlock": {
      if (mode.kind !== "blockers" || mode.holding === null) return { mode, action: null }
      const chosen = [
        ...mode.chosen.filter((b) => b.blocker !== mode.holding),
        { blocker: mode.holding, attacker: event.attacker },
      ]
      return { mode: { ...mode, chosen, holding: null }, action: null }
    }

    default: {
      const exhaustive: never = event
      return { mode, action: (exhaustive as { never?: never }).never ?? null }
    }
  }
}

// ── Reading the view ─────────────────────────────────────────────────────────────────────────────

/** The plays on offer for one card, which is what tapping it should show. */
export function playsForCard(view: GameView, cardId: string): LegalPlay[] {
  return [...(view.automation?.you?.plays ?? [])].filter((p) => p.card === cardId)
}

/** Whether tapping this card would do anything in automated mode. */
export const hasPlays = (view: GameView, cardId: string): boolean => playsForCard(view, cardId).length > 0

/** Mana in a pool, in WUBRG then colourless order, skipping what is not there. */
export function manaPips(pool: Record<string, number> | undefined): { type: string; count: number }[] {
  const order = ["W", "U", "B", "R", "G", "C"]
  return order
    .map((type) => ({ type, count: pool?.[type] ?? 0 }))
    .filter((pip) => pip.count > 0)
}

/** Blockers assigned to each attacker, for drawing the pairing. */
export function blockersOf(view: GameView, attacker: string): string[] {
  return [...(view.automation?.combat.attacks.find((a) => a.attacker === attacker)?.blockers ?? [])]
}

/** Who is attacking, with who they are attacking, for the combat banner. */
export function attackSummary(view: GameView): { attacker: string; defender: number; blockers: string[] }[] {
  return (view.automation?.combat.attacks ?? []).map((a) => ({
    attacker: a.attacker,
    defender: a.defender,
    blockers: [...a.blockers],
  }))
}

/** Short badges for a permanent: its current body, marked damage, and why it cannot fight. */
export function cardBadges(view: GameView, card: VisibleCard): string[] {
  const out: string[] = []
  if (card.zone !== "battlefield") return out
  if (card.power !== undefined && card.toughness !== undefined && card.card?.power !== undefined) {
    out.push(`${card.power}/${card.toughness}`)
  }
  if ((card.damage ?? 0) > 0) out.push(`${card.damage} dmg`)
  if (card.cantAttack === true && card.cantBlock === true) out.push("can't fight")
  else if (card.cantAttack === true) out.push("can't attack")
  else if (card.cantBlock === true) out.push("can't block")
  // Summoning sickness is the question players ask most often, and the view carries what answers
  // it: the engine says it cannot attack by leaving it out of `attackers`.
  const attackers = view.automation?.you?.attackers ?? []
  const mine = card.zoneSeat === view.seat
  const isCreature = card.keywords !== undefined && card.card?.power !== undefined
  if (
    mine && isCreature && view.automation?.awaiting?.kind === "attackers" &&
    !attackers.includes(card.id) && card.tapped === false && card.cantAttack !== true
  ) {
    out.push("not ready")
  }
  return out
}

/** The one thing the priority button should say and do, or null when it is not this seat's move. */
export function primaryMove(view: GameView): { label: string; event: ArenaEvent | null; action: TableAction | null } | null {
  const auto = view.automation
  const you = auto?.you
  if (!auto || !you || view.finished) return null
  if (you.mustDiscard > 0) return { label: `Discard ${you.mustDiscard}`, event: null, action: null }
  if (you.mustDeclare === "attackers") {
    return { label: "Declare attackers", event: { kind: "declareAttackers", defender: firstOpponent(view) }, action: null }
  }
  if (you.mustDeclare === "blockers") return { label: "Declare blockers", event: { kind: "declareBlockers" }, action: null }
  if (!you.hasPriority) return null
  return { label: you.passLabel || "Pass", event: null, action: { type: "auto:pass" } }
}

/** The nearest live opponent, which in a two-player game is simply the other seat. */
export function firstOpponent(view: GameView): SeatIndex {
  const other = view.seats.find((s) => s.index !== view.seat && !s.eliminated)
  return (other?.index ?? 0) as SeatIndex
}
