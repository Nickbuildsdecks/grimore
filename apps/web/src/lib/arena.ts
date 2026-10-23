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
import type { GameView, LegalActions, LegalPlay, SeatIndex, Target, VisibleCard } from "@grimore/rules-engine"
import type { TableAction } from "@/lib/table"

/** What the player is in the middle of doing. `idle` is the ordinary "pick something" state. */
export type ArenaMode =
  | { kind: "idle" }
  | { kind: "bottoming"; chosen: string[] }
  /**
   * A card has stopped mid-resolution to ask this player to pick cards — a search, a discard of
   * their own choosing, a creature to sacrifice.
   *
   * Unlike `targeting` this one has no `play`: the spell is already resolving, so there is nothing
   * left to send but the answer. `ask` is the engine's own question, carried whole rather than
   * unpacked, so a new kind of decision needs no change here.
   */
  | { kind: "deciding"; ask: Decision; chosen: string[] }
  /** Picking what to feed an ability whose cost is a sacrifice, before it is activated. */
  | { kind: "feeding"; play: LegalPlay }
  /** A triggered ability of yours waiting to be aimed. Shaped like `targeting`, sent differently. */
  | { kind: "choosing"; specs: readonly LegalPlay["targetSpecs"][number][]; candidates: readonly (readonly Target[])[]; description: string; chosen: Target[] }
  | { kind: "targeting"; play: LegalPlay; chosen: Target[]; sacrifice?: string }
  /**
   * Declaring attackers. `chosen` carries a defender per attacker, not one for the declaration,
   * because in a pod each creature may attack a different player — and `defender` here is only
   * which player the *next* creature tapped will be sent at.
   */
  | { kind: "attackers"; chosen: Attack[]; defender: SeatIndex }
  | { kind: "blockers"; chosen: Block[]; holding: string | null }

export interface Block {
  blocker: string
  attacker: string
}

export interface Attack {
  attacker: string
  defender: SeatIndex
}

/** The engine's mid-resolution question, exactly as `legalActions` reports it. */
export type Decision = NonNullable<LegalActions["mustDecide"]>

export type ArenaEvent =
  | { kind: "cancel" }
  | { kind: "startBottoming" }
  | { kind: "startChoosing"; specs: readonly LegalPlay["targetSpecs"][number][]; candidates: readonly (readonly Target[])[]; description: string }
  | { kind: "toggleBottom"; card: string }
  | { kind: "startDeciding"; ask: Decision }
  | { kind: "toggleDecision"; card: string }
  | { kind: "feed"; card: string }
  | { kind: "choosePlay"; play: LegalPlay }
  | { kind: "pickTarget"; target: Target }
  | { kind: "undoTarget" }
  | { kind: "confirm" }
  | { kind: "declareAttackers"; defender: SeatIndex }
  | { kind: "toggleAttacker"; card: string }
  /** Points the creatures tapped from now on at a different player. */
  | { kind: "aimAttacks"; seat: SeatIndex }
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

/** `candidatesAt`, for a triggered ability's specs rather than a play's. */
export function choiceCandidatesAt(
  specs: readonly LegalPlay["targetSpecs"][number][],
  candidates: readonly (readonly Target[])[],
  chosen: readonly Target[],
): readonly Target[] {
  let seen = 0
  for (let i = 0; i < specs.length; i++) {
    const want = Math.max(1, specs[i]!.count ?? 1)
    if (chosen.length < seen + want) {
      const taken = new Set(chosen.map(targetKey))
      return (candidates[i] ?? []).filter((t) => !taken.has(targetKey(t)))
    }
    seen += want
  }
  return []
}

/** The action a completed play turns into. */
function playAction(play: LegalPlay, targets: readonly Target[], sacrifice?: string): TableAction {
  const withTargets = targets.length > 0 ? { targets: [...targets] } : {}
  const withSacrifice = sacrifice === undefined ? {} : { sacrifice }
  if (play.kind === "land") return { type: "auto:playLand", card: play.card }
  // A modal spell's modes were chosen by choosing *this* play: the engine offers one play per
  // legal combination, so picking a mode and picking a spell are the same gesture.
  const withModes = play.modes === undefined ? {} : { modes: [...play.modes] }
  if (play.kind === "cast") return { type: "auto:cast", card: play.card, ...withModes, ...withTargets }
  return {
    type: "auto:activate", card: play.card, abilityIndex: play.abilityIndex ?? 0,
    ...withTargets, ...withSacrifice,
  }
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
      // The cost comes first: a sacrifice is paid as the ability is activated, so it is chosen
      // before the targets rather than after.
      if (play.sacrificeOptions.length > 0) return { mode: { kind: "feeding", play }, action: null }
      if (targetsWanted(play) === 0) return { mode: IDLE, action: playAction(play, []) }
      return { mode: { kind: "targeting", play, chosen: [] }, action: null }
    }

    case "feed": {
      if (mode.kind !== "feeding") return { mode, action: null }
      if (!mode.play.sacrificeOptions.includes(event.card)) return { mode, action: null }
      if (targetsWanted(mode.play) === 0) {
        return { mode: IDLE, action: playAction(mode.play, [], event.card) }
      }
      // Something to aim as well: keep the sacrifice and go on to the targets.
      return { mode: { kind: "targeting", play: mode.play, chosen: [], sacrifice: event.card }, action: null }
    }

    case "startChoosing":
      return {
        mode: {
          kind: "choosing", specs: event.specs, candidates: event.candidates,
          description: event.description, chosen: [],
        },
        action: null,
      }

    case "pickTarget": {
      if (mode.kind === "choosing") {
        const key = targetKey(event.target)
        if (mode.chosen.some((t) => targetKey(t) === key)) {
          return { mode: { ...mode, chosen: mode.chosen.filter((t) => targetKey(t) !== key) }, action: null }
        }
        const chosen = [...mode.chosen, event.target]
        const wanted = mode.specs.reduce((n, spec) => n + Math.max(1, spec.count ?? 1), 0)
        if (chosen.length >= wanted) return { mode: IDLE, action: { type: "auto:choose", targets: chosen } }
        return { mode: { ...mode, chosen }, action: null }
      }
      if (mode.kind !== "targeting") return { mode, action: null }
      // Picking something already chosen un-picks it, which is how a misclick is undone.
      const key = targetKey(event.target)
      if (mode.chosen.some((t) => targetKey(t) === key)) {
        return { mode: { ...mode, chosen: mode.chosen.filter((t) => targetKey(t) !== key) }, action: null }
      }
      const chosen = [...mode.chosen, event.target]
      if (chosen.length >= targetsWanted(mode.play)) {
        return { mode: IDLE, action: playAction(mode.play, chosen, mode.sacrifice) }
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
        return { mode: IDLE, action: playAction(mode.play, mode.chosen, mode.sacrifice) }
      }
      if (mode.kind === "attackers") {
        return {
          mode: IDLE,
          action: { type: "auto:attack", attackers: mode.chosen.map((a) => ({ ...a })) },
        }
      }
      if (mode.kind === "blockers") {
        return { mode: IDLE, action: { type: "auto:block", blocks: mode.chosen.map((b) => ({ ...b })) } }
      }
      if (mode.kind === "bottoming") {
        return { mode: IDLE, action: { type: "auto:keep", bottom: [...mode.chosen] } }
      }
      if (mode.kind === "deciding") {
        // Fewer than the minimum is not an answer the engine accepts, so the button does nothing
        // rather than sending something that bounces back as an error the player cannot read.
        if (mode.chosen.length < mode.ask.min) return { mode, action: null }
        return { mode: IDLE, action: { type: "auto:decide", cards: [...mode.chosen] } }
      }
      if (mode.kind === "choosing") {
        // A trigger's targets are never optional: it was only put on the stack because legal ones
        // existed, so confirming early would send an ability the engine refuses.
        const wanted = mode.specs.reduce((n, spec) => n + Math.max(1, spec.count ?? 1), 0)
        if (mode.chosen.length < wanted) return { mode, action: null }
        return { mode: IDLE, action: { type: "auto:choose", targets: [...mode.chosen] } }
      }
      return { mode, action: null }
    }

    case "declareAttackers":
      return { mode: { kind: "attackers", chosen: [], defender: event.defender }, action: null }

    case "toggleAttacker": {
      if (mode.kind !== "attackers") return { mode, action: null }
      const already = mode.chosen.find((a) => a.attacker === event.card)
      // Tapping a creature that is already attacking somebody *else* re-points it, rather than
      // dropping it: having changed who you are aiming at, a second tap plainly means "this one
      // too", and making the player untap and retap to move one attacker is a trap.
      const chosen = already === undefined
        ? [...mode.chosen, { attacker: event.card, defender: mode.defender }]
        : already.defender === mode.defender
          ? mode.chosen.filter((a) => a.attacker !== event.card)
          : mode.chosen.map((a) => (a.attacker === event.card ? { ...a, defender: mode.defender } : a))
      return { mode: { ...mode, chosen }, action: null }
    }

    case "aimAttacks": {
      if (mode.kind !== "attackers") return { mode, action: null }
      return { mode: { ...mode, defender: event.seat }, action: null }
    }

    case "declareBlockers":
      return { mode: { kind: "blockers", chosen: [], holding: null }, action: null }

    case "startBottoming":
      return { mode: { kind: "bottoming", chosen: [] }, action: null }

    case "startDeciding":
      return { mode: { kind: "deciding", ask: event.ask, chosen: [] }, action: null }

    case "toggleDecision": {
      if (mode.kind !== "deciding") return { mode, action: null }
      if (!mode.ask.candidates.includes(event.card)) return { mode, action: null }
      if (mode.chosen.includes(event.card)) {
        return { mode: { ...mode, chosen: mode.chosen.filter((id) => id !== event.card) }, action: null }
      }
      // At the limit, picking another one is a correction rather than an error: the oldest pick
      // drops out. A player at max who taps a different card means that one instead.
      const chosen = mode.chosen.length >= mode.ask.max
        ? [...mode.chosen.slice(1), event.card]
        : [...mode.chosen, event.card]
      // Sent as soon as it is unambiguous. A question asking for exactly one does not need a
      // confirm button; one with a range does, because stopping early is a legal answer.
      if (mode.ask.min === mode.ask.max && chosen.length === mode.ask.max) {
        return { mode: IDLE, action: { type: "auto:decide", cards: chosen } }
      }
      return { mode: { ...mode, chosen }, action: null }
    }

    case "toggleBottom": {
      if (mode.kind !== "bottoming") return { mode, action: null }
      const chosen = mode.chosen.includes(event.card)
        ? mode.chosen.filter((id) => id !== event.card)
        : [...mode.chosen, event.card]
      return { mode: { kind: "bottoming", chosen }, action: null }
    }

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

/**
 * Splits a battlefield into the rows a player actually reads.
 *
 * Arena-style tables separate the creatures from the mana for a reason: a board of eleven
 * permanents where six are Forests is unreadable as one row, and the question being asked of it is
 * almost always "what can fight". Lands go in their own compact row beneath, and everything else —
 * enchantments, artifacts, tokens that are not creatures — goes with them.
 */
export function splitBattlefield(cards: readonly VisibleCard[]): {
  creatures: VisibleCard[]
  lands: VisibleCard[]
} {
  const creatures: VisibleCard[] = []
  const lands: VisibleCard[] = []
  for (const card of cards) {
    // The view sends power only for a creature, which is the engine's own answer to the question.
    if (card.power !== undefined) creatures.push(card)
    else lands.push(card)
  }
  return { creatures, lands }
}

/** Short badges for a permanent: its current body, marked damage, and why it cannot fight. */
export function cardBadges(view: GameView, card: VisibleCard): string[] {
  const out: string[] = []
  if (card.zone !== "battlefield") return out
  // An Aura is drawn on its controller's side, which is often not the side its host is on, so
  // without naming the host there is nothing on screen that says what a Pacifism is doing.
  if (card.attachedTo !== null) {
    const host = view.cards[card.attachedTo]
    out.push(`on ${host?.card?.name ?? "a creature"}`)
  }
  const attached = Object.values(view.cards)
    .filter((c) => c.attachedTo === card.id && c.zone === "battlefield")
    .map((c) => c.card?.name)
    .filter((name): name is string => name !== undefined)
  for (const name of attached) out.push(name)
  if (card.power !== undefined && card.toughness !== undefined && card.card?.power !== undefined) {
    out.push(`${card.power}/${card.toughness}`)
  }
  if ((card.damage ?? 0) > 0) out.push(`${card.damage} dmg`)
  /*
    Who this creature is attacking, and who is in its way.

    With one opponent "attacking" says everything there is to say; with three it says almost
    nothing, and the board had no other place that named the defender at all — the engine has
    accepted a defender per attack since combat was written, and the table was not showing it.
  */
  for (const attack of view.automation?.combat.attacks ?? []) {
    if (attack.attacker !== card.id) continue;
    const at = view.seats.find((s) => s.index === attack.defender)
    out.push(`attacking ${at?.name ?? `seat ${attack.defender}`}`)
    if (attack.blockers.length > 0) out.push(`blocked by ${attack.blockers.length}`)
  }
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
  // A card that stopped mid-resolution to ask this player something blocks everything else,
  // including the player whose spell it is — so it comes before priority and before declarations.
  if (you.mustDecide !== null) {
    return {
      label: you.mustDecide.prompt,
      event: { kind: "startDeciding", ask: you.mustDecide },
      action: null,
    }
  }
  // A trigger waiting for its targets blocks everything else.
  if (you.mustChoose !== null) {
    return {
      label: `Aim ${you.mustChoose.description}`,
      event: {
        kind: "startChoosing",
        specs: you.mustChoose.specs,
        candidates: you.mustChoose.candidates,
        description: you.mustChoose.description,
      },
      action: null,
    }
  }
  // Opening hands come before anything else, including priority.
  if (you.mustSettleHand) {
    return you.bottomOwed === 0
      ? { label: "Keep", event: null, action: { type: "auto:keep" } }
      : { label: `Keep — put ${you.bottomOwed} back`, event: { kind: "startBottoming" }, action: null }
  }
  if (you.mustDiscard > 0) return { label: `Discard ${you.mustDiscard}`, event: null, action: null }
  if (you.mustDeclare === "attackers") {
    return { label: "Declare attackers", event: { kind: "declareAttackers", defender: firstOpponent(view) }, action: null }
  }
  if (you.mustDeclare === "blockers") return { label: "Declare blockers", event: { kind: "declareBlockers" }, action: null }
  if (!you.hasPriority) return null
  return { label: you.passLabel || "Pass", event: null, action: { type: "auto:pass" } }
}

/** How a decision's progress reads on the confirm button: "Discard two cards (1 of 2)". */
export function decisionLabel(ask: Decision, chosen: readonly string[]): string {
  if (ask.min === ask.max) return `${ask.prompt} (${chosen.length} of ${ask.max})`
  if (ask.min === 0) return chosen.length === 0 ? `${ask.prompt} — or choose nothing` : `${ask.prompt} (${chosen.length})`
  return `${ask.prompt} (${chosen.length}, at least ${ask.min})`
}

/** The nearest live opponent, which in a two-player game is simply the other seat. */
export function firstOpponent(view: GameView): SeatIndex {
  const other = view.seats.find((s) => s.index !== view.seat && !s.eliminated)
  return (other?.index ?? 0) as SeatIndex
}
