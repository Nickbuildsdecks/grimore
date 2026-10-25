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
import { pactBinds, pactLiveAt, pactShort, pactWords } from "@grimore/rules-engine"
import type {
  GameView, LegalActions, LegalPlay, PactKind, SeatIndex, Target, VisibleCard,
} from "@grimore/rules-engine"
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
  /**
   * Choosing X, before anything else about the spell.
   *
   * X is announced as the spell is cast (CR 601.2b) and *before* its targets (CR 601.2c), which is
   * the order this reducer walks: a player picks how big the Fireball is and then what it points
   * at, because the size is part of casting it and not part of resolving it.
   */
  | { kind: "payingX"; play: LegalPlay; chosen: number }
  | { kind: "targeting"; play: LegalPlay; chosen: Target[]; sacrifice?: string; x?: number }
  /**
   * Declaring attackers. `chosen` carries a defender per attacker, not one for the declaration,
   * because in a pod each creature may attack a different player — and `defender` here is only
   * which player the *next* creature tapped will be sent at.
   */
  | {
      kind: "attackers"
      chosen: Attack[]
      defender: SeatIndex
      planeswalker?: string
      /**
       * The ones with no choice: "attacks each combat if able" (CR 508.1d), as the engine listed
       * them. Pre-selected and un-droppable, so the player cannot build a declaration the engine
       * refuses. Absent, rather than empty, in the ordinary combat where nothing is forced.
       */
      forced?: readonly string[]
      /**
       * Per creature, the players it may legally be sent at — goad, as the engine worked it out.
       *
       * Only the creatures that are restricted appear, so an absent card means "anybody". The
       * reducer never decides this for itself: it is `legalActions`'s answer, carried in so that
       * re-aiming can move a creature somewhere legal instead of somewhere refused.
       */
      aims?: readonly AttackAims[]
    }
  | { kind: "blockers"; chosen: Block[]; holding: string | null }
  /**
   * The attacking player putting each blocked creature's blockers in order (CR 509.2).
   *
   * `owed` is the engine's question, carried whole; `chosen` is the answer being built, keyed by
   * the attacking creature, because one swing can have two creatures that each need an order.
   * Tapping a blocker appends it to its own attacker's list, so there is no wizard to step through
   * and no way to put a blocker in the wrong attacker's order.
   */
  | { kind: "ordering"; owed: readonly OrderAsk[]; chosen: Record<string, string[]> }

export interface Block {
  blocker: string
  attacker: string
}

/** One attacking creature's blockers, waiting to be put in damage order. */
export type OrderAsk = LegalActions["mustOrder"][number]

/** One creature's legal defenders, as `legalActions.attackAims` reports them. */
export type AttackAims = LegalActions["attackAims"][number]

export interface Attack {
  attacker: string
  defender: SeatIndex
  /** A planeswalker that player controls, attacked instead of them (CR 506.2). */
  planeswalker?: string
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
  /** Sets X while it is being chosen. Clamped to what the engine said the player can pay for. */
  | { kind: "setX"; amount: number }
  | { kind: "undoTarget" }
  | { kind: "confirm" }
  | {
      kind: "declareAttackers"
      defender: SeatIndex
      forced?: readonly string[]
      aims?: readonly AttackAims[]
    }
  | { kind: "toggleAttacker"; card: string }
  /** Points the creatures tapped from now on at a different player, or at a planeswalker. */
  | { kind: "aimAttacks"; seat: SeatIndex; planeswalker?: string }
  /** Sends every attack already declared at one player, which is what "all in on them" means. */
  | { kind: "aimAll"; seat: SeatIndex; planeswalker?: string }
  | { kind: "declareBlockers" }
  | { kind: "holdBlocker"; card: string }
  | { kind: "assignBlock"; attacker: string }
  /** The attacking player starting on the damage assignment order the engine asked for. */
  | { kind: "startOrdering"; owed: readonly OrderAsk[] }
  /** Puts one blocker next in its own attacker's order; tapping a chosen one starts that list over. */
  | { kind: "pickOrder"; card: string }

/** The reducer's answer: the new mode, and an action to send if the step is complete. */
export interface ArenaResult {
  mode: ArenaMode
  action: TableAction | null
}

export const IDLE: ArenaMode = { kind: "idle" }

/** Whether every attacker that owes an order has all of its blockers placed. */
export function orderingDone(
  owed: readonly OrderAsk[], chosen: Record<string, readonly string[]>,
): boolean {
  return owed.every((ask) => (chosen[ask.attacker] ?? []).length === ask.blockers.length)
}

/**
 * Where a creature may actually be sent, given where the player is aiming.
 *
 * `want` unless the engine said that seat is not allowed for this creature, in which case the
 * first seat it did allow. Nothing here works out *why* — goad is the only reason today, and the
 * client deciding for itself which aims are legal would be a second, worse copy of the rules.
 */
export function allowedAim(
  aims: readonly AttackAims[] | undefined, card: string, want: SeatIndex,
): SeatIndex {
  const entry = aims?.find((a) => a.card === card)
  if (entry === undefined || entry.defenders.includes(want)) return want
  return entry.defenders[0] ?? want
}

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
function playAction(
  play: LegalPlay, targets: readonly Target[], sacrifice?: string, x?: number,
): TableAction {
  const withTargets = targets.length > 0 ? { targets: [...targets] } : {}
  const withSacrifice = sacrifice === undefined ? {} : { sacrifice }
  if (play.kind === "land") return { type: "auto:playLand", card: play.card }
  // A modal spell's modes were chosen by choosing *this* play: the engine offers one play per
  // legal combination, so picking a mode and picking a spell are the same gesture.
  const withModes = play.modes === undefined ? {} : { modes: [...play.modes] }
  // X travels with the cast for the same reason: it is announced, not resolved. Sent whenever the
  // cost has an {X} in it, including zero — the engine refuses an x on a cost without one, and a
  // missing x on a cost with one would silently cast it for nothing.
  const withX = play.xMax === undefined ? {} : { x: Math.max(0, Math.min(x ?? 0, play.xMax)) }
  // The kicker is part of the cost, and the player paid it by choosing this play rather than the
  // one beside it — the same gesture that chooses a mode.
  const withKicker = play.kicked === true ? { kicked: true } : {}
  /*
    Flashback, for the same reason as the kicker and one more: it is a different *zone* as well as a
    different cost, so without it the engine is told to cast a card in the graveyard as though it
    were in hand — and refuses the play the table had just offered.

    Found by the pod browser suite rather than by reasoning: "the engine never refused anything a
    table offered" failed with "that card is not in your hand" the first time a bot's flashback play
    reached this function. The engine's own tests all passed, because they build the action by hand.
  */
  const withFlashback = play.flashback === true ? { flashback: true } : {}
  /*
    And morph, for the same reason a third time: the face-down cast is a separate play on the same
    card, so a cast sent without the flag is the printed one — which the engine refuses for want of
    mana on exactly the turn the player reached for the 2/2.
  */
  const withFaceDown = play.faceDown === true ? { faceDown: true } : {}
  /*
    Turning a morph face up is a special action, not a cast and not an ability (CR 702.37b), so it
    is its own action with nothing to choose: no targets, no cost to pick, no window for anybody to
    answer in. One tap, and the 2/2 is whatever it was all along.
  */
  if (play.kind === "turnUp") {
    return { type: "auto:turnUp", card: play.card }
  }
  if (play.kind === "cast") {
    // A cast can have a cost of its own to pay now: "sacrifice a creature" is an additional cost,
    // not something the spell asks for on resolution, so it travels with the cast.
    return {
      type: "auto:cast", card: play.card,
      ...withModes, ...withX, ...withKicker, ...withFlashback, ...withFaceDown,
      ...withSacrifice, ...withTargets,
    }
  }
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
      // before the targets rather than after. X is part of the cost in the same way, and the
      // rules put it before the targets too.
      if (play.sacrificeOptions.length > 0) return { mode: { kind: "feeding", play }, action: null }
      if (play.xMax !== undefined) {
        // Opening on the largest X is the choice a player makes nearly every time — a Fireball is
        // cast for everything available — and it is one tap from any smaller number.
        return { mode: { kind: "payingX", play, chosen: play.xMax }, action: null }
      }
      if (targetsWanted(play) === 0) return { mode: IDLE, action: playAction(play, []) }
      return { mode: { kind: "targeting", play, chosen: [] }, action: null }
    }

    case "setX": {
      if (mode.kind !== "payingX") return { mode, action: null }
      const max = mode.play.xMax ?? 0
      return { mode: { ...mode, chosen: Math.max(0, Math.min(event.amount, max)) }, action: null }
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
        return { mode: IDLE, action: playAction(mode.play, chosen, mode.sacrifice, mode.x) }
      }
      return { mode: { ...mode, chosen }, action: null }
    }

    case "undoTarget": {
      if (mode.kind !== "targeting") return { mode, action: null }
      if (mode.chosen.length === 0) return { mode: IDLE, action: null }
      return { mode: { ...mode, chosen: mode.chosen.slice(0, -1) }, action: null }
    }

    case "confirm": {
      if (mode.kind === "payingX") {
        if (targetsWanted(mode.play) === 0) {
          return { mode: IDLE, action: playAction(mode.play, [], undefined, mode.chosen) }
        }
        return { mode: { kind: "targeting", play: mode.play, chosen: [], x: mode.chosen }, action: null }
      }
      if (mode.kind === "targeting") {
        // "Up to" spells are the only ones that can be sent with fewer targets than they want.
        if (mode.chosen.length < targetsRequired(mode.play)) return { mode, action: null }
        return { mode: IDLE, action: playAction(mode.play, mode.chosen, mode.sacrifice, mode.x) }
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
      if (mode.kind === "ordering") {
        // Every owed order, complete. A short list is not an answer the engine takes, so the
        // button does nothing rather than sending one that bounces back.
        if (!orderingDone(mode.owed, mode.chosen)) return { mode, action: null }
        return {
          mode: IDLE,
          action: {
            type: "auto:order",
            orders: mode.owed.map((ask) => ({
              attacker: ask.attacker,
              blockers: [...(mode.chosen[ask.attacker] ?? [])],
            })),
          },
        }
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

    case "declareAttackers": {
      // A creature that attacks each combat if able starts the declaration already attacking.
      // Leaving the player to find it is leaving them to hit confirm on a declaration the engine
      // throws out, with no way to tell which creature was the problem.
      const forced = event.forced ?? []
      const aims = event.aims ?? []
      return {
        mode: {
          kind: "attackers",
          // Aimed where it is allowed to go rather than where the rest of the swing is pointing: a
          // goaded creature pre-selected at the player who goaded it is the illegal declaration
          // this is here to prevent, built by the table itself.
          chosen: forced.map((attacker) => ({
            attacker,
            defender: allowedAim(aims, attacker, event.defender),
          })),
          defender: event.defender,
          ...(forced.length > 0 ? { forced } : {}),
          ...(aims.length > 0 ? { aims } : {}),
        },
        action: null,
      }
    }

    case "toggleAttacker": {
      if (mode.kind !== "attackers") return { mode, action: null }
      const already = mode.chosen.find((a) => a.attacker === event.card)
      // Where this creature would go, which is where the player is aiming unless it may not be
      // aimed there. A planeswalker belongs to the seat it was chosen on, so moving the seat
      // drops it rather than sending the attack at a permanent of somebody else's.
      const defender = allowedAim(mode.aims, event.card, mode.defender)
      const walker = defender === mode.defender ? mode.planeswalker : undefined
      const aim = { defender, ...(walker === undefined ? {} : { planeswalker: walker }) }
      const sameAim = already !== undefined
        && already.defender === defender && already.planeswalker === walker
      // Which player it is sent at is still the attacking player's choice; whether it attacks at
      // all is not. So a second tap on a forced attacker does nothing rather than dropping it.
      if (sameAim && (mode.forced ?? []).includes(event.card)) return { mode, action: null }
      // Tapping a creature that is already attacking somebody *else* re-points it, rather than
      // dropping it: having changed who you are aiming at, a second tap plainly means "this one
      // too", and making the player untap and retap to move one attacker is a trap.
      const chosen = already === undefined
        ? [...mode.chosen, { attacker: event.card, ...aim }]
        : sameAim
          ? mode.chosen.filter((a) => a.attacker !== event.card)
          : mode.chosen.map((a) => (a.attacker === event.card ? { attacker: a.attacker, ...aim } : a))
      return { mode: { ...mode, chosen }, action: null }
    }

    case "aimAttacks": {
      if (mode.kind !== "attackers") return { mode, action: null }
      return {
        mode: { ...mode, defender: event.seat, planeswalker: event.planeswalker },
        action: null,
      }
    }

    /*
      Everything already picked, re-pointed at one player.

      Re-aiming one attacker is a second tap on it (see `toggleAttacker`), which is right for
      moving one creature and wrong for the commonest pod decision there is: four creatures aimed
      around the table, and then somebody's life total drops and all of them should go at them. By
      hand that is four untaps and four retaps with the aim changed in between, which is long
      enough for the moment to pass.
    */
    case "aimAll": {
      if (mode.kind !== "attackers") return { mode, action: null }
      return {
        mode: {
          ...mode,
          defender: event.seat,
          planeswalker: event.planeswalker,
          // "All at them" moves everything it can. A goaded creature that may not go there stays
          // where it is rather than making the whole press refuse.
          chosen: mode.chosen.map((a) => {
            const defender = allowedAim(mode.aims, a.attacker, event.seat)
            if (defender !== event.seat) return a
            return {
              attacker: a.attacker,
              defender,
              ...(event.planeswalker === undefined ? {} : { planeswalker: event.planeswalker }),
            }
          }),
        },
        action: null,
      }
    }

    case "declareBlockers":
      return { mode: { kind: "blockers", chosen: [], holding: null }, action: null }

    case "startOrdering":
      return { mode: { kind: "ordering", owed: event.owed, chosen: {} }, action: null }

    case "pickOrder": {
      if (mode.kind !== "ordering") return { mode, action: null }
      const ask = mode.owed.find((entry) => entry.blockers.includes(event.card))
      if (ask === undefined) return { mode, action: null }
      const taken = mode.chosen[ask.attacker] ?? []
      // Tapping one already in the order clears that attacker's list rather than removing one from
      // the middle: an order with a hole in it is not an answer, and "start that one again" is the
      // only correction a player means by tapping a card they have already placed.
      const next = taken.includes(event.card) ? [] : [...taken, event.card]
      return { mode: { ...mode, chosen: { ...mode.chosen, [ask.attacker]: next } }, action: null }
    }

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

/**
 * Why the engine is not offering this card, in its own words, or null when it is offering it.
 *
 * Read from the engine rather than worked out here. Most of the reasons a table could guess — it
 * knows the step and the pool — but not all of them: a spell with no legal target looks exactly
 * like a spell you cannot afford, and the two want different answers from the player. A second
 * implementation of "can this be cast" is the thing `legalActions` exists to prevent.
 */
export function reasonCannotPlay(view: GameView, cardId: string): string | null {
  return view.automation?.you?.blocked?.find((entry) => entry.card === cardId)?.reason ?? null
}

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
export function attackSummary(
  view: GameView,
): { attacker: string; defender: number; blockers: string[]; planeswalker?: string }[] {
  return (view.automation?.combat.attacks ?? []).map((a) => ({
    attacker: a.attacker,
    defender: a.defender,
    blockers: [...a.blockers],
    ...(a.planeswalker === undefined ? {} : { planeswalker: a.planeswalker }),
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
    /*
      The engine's own answer, rather than anything derived from the card.

      A Vehicle moves between the two rows as it is crewed and as the turn ends, which is right:
      while nobody is driving it, it belongs with the permanents that cannot fight.
    */
    if (card.isCreature === true) creatures.push(card)
    else lands.push(card)
  }
  return { creatures, lands }
}

/**
 * What one seat's board can do: how hard it hits, and how much of it can still block.
 *
 * The number a pod turns on and the one the table never showed. Life, hand size and graveyard are
 * on every seat strip; "how much power is pointed at me, and can they defend if I go at them
 * instead" meant counting creatures across three columns while the clock ran.
 *
 * `power` is the total power of their creatures and `ready` the number of those that are untapped,
 * because those are the two different questions: the first is what can kill you on their turn, the
 * second is what can stop you on yours. Both are read from the same view the board is drawn from,
 * so neither can disagree with what is on screen — and `power` is the *computed* power, so a
 * Grizzly Bears under a Glorious Anthem counts as three.
 *
 * `readyPower` is the one the strip shows beside the total, because both questions a pod asks are
 * about power rather than headcount: three untapped 1/1s and one untapped 7/7 are the same `ready`
 * and nothing like the same turn. `ready` stays, because "can they block at all" is a count.
 */
export interface BoardRead {
  readonly power: number
  readonly creatures: number
  readonly ready: number
  readonly readyPower: number
}

export function boardRead(view: GameView, seat: number): BoardRead {
  let power = 0
  let creatures = 0
  let ready = 0
  let readyPower = 0
  for (const id of view.zones[`${seat}:battlefield`] ?? []) {
    const card = view.cards[id]
    // The view sends `power` only for a creature, which is the engine's own answer to "is this a
    // creature" — the same test `splitBattlefield` uses to decide which row to draw it in.
    if (card?.power === undefined) continue
    creatures += 1
    power += card.power
    if (!card.tapped) {
      ready += 1
      readyPower += card.power
    }
  }
  return { power, creatures, ready, readyPower }
}

/**
 * What an attack aimed at one seat is walking into, and whether it ends them.
 *
 * The pod decision the table could not answer: with three players to choose between, "who do I
 * attack" is a question about their life, what they have left to block with, and whether this is
 * the swing that finishes somebody — and all three were on screen only as cards to count.
 *
 * `lethal` is deliberately the strict claim: the attack is at least their life total **and they
 * have no untapped creature**, so there is nothing to block with and every point connects. An
 * instant can still save them, which is true of every lethal attack ever declared; a seat holding
 * blockers is not marked at all, because whether a block saves them depends on assignment and a
 * table that said "lethal" and was wrong would be worse than a table that said nothing.
 */
export function attackRead(
  view: GameView, seat: number, attackingPower: number,
): { life: number; ready: number; readyPower: number; lethal: boolean } {
  const life = view.seats.find((s) => s.index === seat)?.life ?? 0
  const guard = boardRead(view, seat)
  return {
    life,
    ready: guard.ready,
    readyPower: guard.readyPower,
    lethal: attackingPower > 0 && attackingPower >= life && guard.ready === 0,
  }
}

/**
 * Why a seat is out, in words a player uses.
 *
 * The engine's own reasons are field names — `commanderDamage`, `library` — and the table had been
 * printing them raw, so a seat that decked out said "out (library)" and one that took
 * twenty-one from a commander said "out (commanderDamage)". Three of the five are worth saying
 * properly, and the two that already read as English are left alone.
 */
export function eliminatedLabel(reason: string | null): string {
  if (reason === null) return "out"
  if (reason === "commanderDamage") return "out (commander damage)"
  if (reason === "library") return "out (empty library)"
  return `out (${reason})`
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
  /*
    What this permanent is holding in exile.

    Without it, killing a Journey to Nowhere is a guess: the creature it took is face up in a pile
    on the other side of the board with nothing connecting the two, and the whole decision — is
    destroying this worth giving that back — needs the link on screen.
  */
  const held = Object.values(view.cards)
    .filter((c) => c.exiledBy === card.id && c.zone === "exile")
    .map((c) => c.card?.name)
    .filter((name): name is string => name !== undefined)
  for (const name of held) out.push(`holding ${name}`)
  /*
    Its current body, for anything that currently *is* a creature.

    The third clause used to be `card.card?.power !== undefined` — "the card has power printed on
    it" — and it was wrong in both directions, which the Vehicles made impossible to ignore. An
    animated Mutavault is a 2/2 with no printed power, so the board showed no body for it at all and
    a player had to remember what they had pressed; an uncrewed Vehicle has a printed 7/11 and is not
    a creature, so it would have shown one it did not have. `isCreature` is the question both of
    them were really asking.
  */
  if (card.power !== undefined && card.toughness !== undefined && card.isCreature === true) {
    out.push(`${card.power}/${card.toughness}`)
  }
  if ((card.damage ?? 0) > 0) out.push(`${card.damage} dmg`)
  // A Fog changes nothing a player can see on any card, so without this the board looks exactly
  // like a board about to trade — and the block you make under one is the opposite of the block
  // you would make without it.
  if (card.damagePrevented === true) out.push("damage prevented")
  /*
    And the shield with a quantity, which is more invisible still.

    "Damage prevented" above comes from a Fog, and a Fog is in the log a moment earlier. A shield
    is a number that sits on one permanent for the rest of the turn and is spent a point at a time
    by whatever damage arrives, with nothing on the card to show it — not a counter, not a keyword,
    and the Samite Healer that made it is untapped again next turn. A player who cannot see it
    blocks as though they had never cast it.
  */
  if ((card.shielded ?? 0) > 0) out.push(`prevents ${card.shielded}`)
  /*
    Who this creature is attacking, and who is in its way.

    With one opponent "attacking" says everything there is to say; with three it says almost
    nothing, and the board had no other place that named the defender at all — the engine has
    accepted a defender per attack since combat was written, and the table was not showing it.
  */
  for (const attack of view.automation?.combat.attacks ?? []) {
    if (attack.attacker !== card.id) continue;
    const walker = attack.planeswalker === undefined ? undefined : view.cards[attack.planeswalker]
    const at = view.seats.find((s) => s.index === attack.defender)
    out.push(`attacking ${walker?.card?.name ?? at?.name ?? `seat ${attack.defender}`}`)
    if (attack.blockers.length > 0) out.push(`blocked by ${attack.blockers.length}`)
  }
  if (card.cantAttack === true && card.cantBlock === true) out.push("can't fight")
  else if (card.cantAttack === true) out.push("can't attack")
  else if (card.cantBlock === true) out.push("can't block")
  /*
    A Vehicle that nobody is driving, which is the one permanent on the board whose printed numbers
    mean nothing at all.

    It has a 7/11 on its face and is not a creature: it cannot attack, cannot block, and a sweeper
    cannot touch it. A board that said nothing would leave a player reading a 7/11 and wondering
    why the game will not let them swing with it — and before `isCreature` travelled on the view,
    the table said "not ready", which is the wrong answer to a question nobody asked.
  */
  const isCreature = card.isCreature === true
  if (!isCreature && /vehicle/i.test(card.card?.typeLine ?? "")) out.push("not crewed")
  // Summoning sickness is the question players ask most often, and the view carries what answers
  // it: the engine says it cannot attack by leaving it out of `attackers`.
  const attackers = view.automation?.you?.attackers ?? []
  const mine = card.zoneSeat === view.seat
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
    return {
      label: "Declare attackers",
      event: {
        kind: "declareAttackers",
        defender: firstOpponent(view),
        ...(you.mustAttack.length > 0 ? { forced: you.mustAttack } : {}),
        ...(you.attackAims.length > 0 ? { aims: you.attackAims } : {}),
      },
      action: null,
    }
  }
  if (you.mustDeclare === "blockers") return { label: "Declare blockers", event: { kind: "declareBlockers" }, action: null }
  if (you.mustDeclare === "order") {
    return {
      label: "Assign combat damage",
      event: { kind: "startOrdering", owed: you.mustOrder },
      action: null,
    }
  }
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Deals between players
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The live deal between you and another seat, short enough for a badge, or null.
 *
 * `pactLiveAt` and `pactBinds` come from the engine rather than being rewritten here, which is the
 * whole point: a table that drew a badge from its own idea of when a deal expires would eventually
 * show a truce the engine had already let lapse, and a player would hold back a lethal attack on
 * the strength of it.
 */
export function pactBadge(view: GameView, other: SeatIndex): string | null {
  const mine = view.seat
  if (mine === null) return null
  const live = view.pacts.find((p) => pactLiveAt(view.turn, p) && pactBinds(p, mine, other))
  return live === undefined ? null : pactShort(live.kind)
}

/** Whether this seat has gone back on a deal in this game. The table remembers; that is the point. */
export function brokeADeal(view: GameView, seat: SeatIndex): boolean {
  return view.pacts.some((p) => p.broken === true && p.from === seat)
}

/** A deal waiting on your answer, in the words the log will use, or null. */
export function pactAsked(view: GameView): { readonly id: string; readonly words: string } | null {
  const mine = view.seat
  if (mine === null) return null
  const open = view.pacts.find((p) => p.status === "offered" && p.to === mine)
  if (open === undefined) return null
  const from = view.seats.find((s) => s.index === open.from)?.name ?? `seat ${open.from}`
  const to = view.seats.find((s) => s.index === open.to)?.name ?? `seat ${open.to}`
  return { id: open.id, words: pactWords(open.kind, from, to) }
}

/** The deals you could put to each opponent right now, named. */
export function pactOffers(
  view: GameView,
): readonly { readonly seat: SeatIndex; readonly name: string; readonly kinds: readonly PactKind[] }[] {
  const offer = view.automation?.you?.pacts.offer ?? []
  return offer.map((entry) => ({
    seat: entry.seat,
    name: view.seats.find((s) => s.index === entry.seat)?.name ?? `seat ${entry.seat}`,
    kinds: entry.kinds,
  }))
}
