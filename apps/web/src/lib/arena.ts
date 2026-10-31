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
import { pactBinds, pactLiveAt, pactShort, pactWords, targetKey } from "@grimore/rules-engine"
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
  /*
    A cost paid with a permanent, waiting for the player to pick which one.

    `cost` says which field the answer fills, because the pool now has two of these and they are
    opposites: a sacrifice puts a creature in a graveyard, and ninjutsu's return puts an unblocked
    attacker back in its owner's hand. One mode rather than two, because the gesture is identical —
    tap one of a lit set of your own permanents — and only the field and the wording differ.

    **Which permanents** is a third question and is deliberately not in this union: an artifact cost
    is still a sacrifice, so it fills the same field, and only the wording changes. The bar reads
    `play.sacrificeKind` for that. Folding it in here would make `cost` mean two things at once —
    what happens to the permanent, and what kind of permanent it may be.
  */
  | { kind: "feeding"; play: LegalPlay; cost: "sacrifice" | "returned" }
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
  /**
   * Aiming a play, and — for a spell that divides a quantity (CR 601.2d) — spending it.
   *
   * `shares` runs alongside `chosen`: one number per target, in the same order. For a dividing
   * spell a tap on a target it already has *adds one more* to that target rather than dropping it,
   * which is how three damage gets split two and one with no second control to learn. Absent on
   * every other play, where there is nothing to divide.
   */
  | {
      kind: "targeting"; play: LegalPlay; chosen: Target[]; sacrifice?: string; returned?: string
      x?: number
      shares?: number[]
    }
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
  /**
   * The answer to a question whose answer is a word: a creature type, a colour, "untap".
   *
   * Its own event rather than another `toggleDecision`, because there is nothing to toggle — one
   * tap is the whole answer, and a half-answered word question is not a state the table can be in.
   */
  | { kind: "pickOption"; option: string }
  | { kind: "pickNumber"; amount: number }
  /**
   * The answer to "you may choose new targets for the copy": where it goes, or nowhere.
   *
   * `target` left out is the answer "leave it where it was", which the card allows and the engine
   * expects as an `auto:decide` with no target at all.
   */
  | { kind: "pickTargetChoice"; target?: Target }
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
  return specsWanted(play.targetSpecs)
}

/** The fewest targets that make the play castable — "up to one" may legally take none. */
export function targetsRequired(play: LegalPlay): number {
  return specsRequired(play.targetSpecs)
}

/*
  The same two questions about a bare spec list, which is what a **trigger** waiting to be aimed
  carries — it has no play to read them off.

  Lifted out rather than written twice because the pair stopped agreeing. The choosing branch below
  had the required count inlined as the wanted count, on a comment that said a trigger's targets are
  never optional; modular made that false and the table went unanswerable. Two readings of one fact
  drifted the moment the fact changed, which is the argument for one function.
*/
export function specsWanted(specs: readonly LegalPlay["targetSpecs"][number][]): number {
  return specs.reduce((n, spec) => n + Math.max(1, spec.count ?? 1), 0)
}

export function specsRequired(specs: readonly LegalPlay["targetSpecs"][number][]): number {
  return specs.reduce((n, spec) => n + (spec.optional ? 0 : Math.max(1, spec.count ?? 1)), 0)
}

/**
 * What a target is, in words, for a prompt or a stack row.
 *
 * Here rather than in either component because both the stack and the division prompt need it and
 * two copies of "what is this target called" would drift. An ability's name is its own description,
 * which is also the only thing a reader could use: "Disallow &rarr; Icy Manipulator: tap target
 * permanent" says which of the permanent's abilities is being countered, where the permanent's
 * name alone would not.
 */
export function targetName(view: GameView, target: Target): string {
  if (target.kind === "player") {
    return target.seat === view.seat ? "you" : (view.seats[target.seat]?.name ?? `seat ${target.seat}`)
  }
  if (target.kind === "ability") {
    return (view.automation?.stack ?? []).find((o) => o.id === target.id)?.description ?? "an ability"
  }
  return view.cards[target.id]?.card?.name ?? "something"
}

/**
 * The quantity this play divides among its targets, or undefined when it divides nothing.
 *
 * Read off the spec the engine sent rather than from a list of card names here: the client's job
 * is to collect the division, not to know which cards have one.
 */
export function dividedAmount(play: LegalPlay): number | undefined {
  return play.targetSpecs.find((spec) => spec.divided !== undefined)?.divided
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

/*
  Re-exported rather than written again.

  This used to be its own one-liner here, which was fine until a `Target` grew a third shape: two
  copies of "what makes two targets the same target" is two places for that answer to drift, and
  the engine's is the one the server checks against.
*/
export { targetKey }

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
  division?: readonly number[], returned?: string,
): TableAction {
  const withTargets = targets.length > 0 ? { targets: [...targets] } : {}
  // The division, for a spell that has one. Sent only when the play's own spec asks for it, so a
  // stale `shares` on another kind of play cannot reach the engine as a division it refuses.
  const withDivision = dividedAmount(play) === undefined || division === undefined
    ? {}
    : { division: [...division] }
  const withSacrifice = sacrifice === undefined ? {} : { sacrifice }
  // Ninjutsu's unblocked attacker, carried the same way and in its own field: a cost that gives the
  // creature back is not a sacrifice, and one field for both would make the engine guess.
  const withReturned = returned === undefined ? {} : { returned }
  /*
    And which half of a two-faced card, for the fifth time and the same reason: a split card and an
    adventurer are each offered as two plays on one card, and a cast with no half is either the
    wrong spell or — on a split card, which has no printed face of its own — refused outright.

    Declared before the land branch below, because a **land** play can carry one too: the back of a
    modal double-faced card is a land you *play* rather than a spell you cast (CR 712).
  */
  const withHalf = play.half === undefined ? {} : { half: play.half }
  if (play.kind === "land") return { type: "auto:playLand", card: play.card, ...withHalf }
  // A modal spell's modes were chosen by choosing *this* play: the engine offers one play per
  // legal combination, so picking a mode and picking a spell are the same gesture.
  const withModes = play.modes === undefined ? {} : { modes: [...play.modes] }
  // X travels with the cast for the same reason: it is announced, not resolved. Sent whenever the
  // cost has an {X} in it, including zero — the engine refuses an x on a cost without one, and a
  // missing x on a cost with one would silently cast it for nothing.
  const withX = play.xMax === undefined ? {} : { x: Math.max(0, Math.min(x ?? 0, play.xMax)) }
  /*
    And replicate's **count**, which is the twelfth cost flag and the only one that is a number.

    It cannot go in the loop below for that reason, and it does not need the X treatment either: the
    count is not picked by the player, it *is* the row they tapped. The engine offers one play per
    affordable number (CR 702.56), so sending the play's own count back is the whole of it.
  */
  const withReplicate = play.replicate === undefined ? {} : { replicate: play.replicate }
  /*
    Every flag that says **which cost this cast is paying**, carried across as one object.

    There are eleven of them and they are one idea: the engine offers a card in hand or in a
    graveyard as two or three separate plays, one per price, and the flag is what tells it which
    row the player tapped. A cast sent without the flag is not a validation error — it is quietly
    the *other* play, and the engine then refuses it for want of mana or because the card is in the
    wrong zone, about a card the table had just drawn a Cast row for.

    Each was found the same way and most of them in a browser suite rather than by reasoning,
    because the engine's own tests build the action by hand:

    - `kicked` — the kicker is part of the cost, paid by choosing this row (CR 702.32).
    - `flashback`, `escape` — a different **zone** as well as a different cost: without the flag
      the engine is told to cast a card in the graveyard as though it were in hand. `escape` sends
      nothing about the payment: `exiles` says what it costs and the engine spends it.
    - `faceDown` — morph's 2/2 for {3}, which is refused for want of mana on exactly the turn the
      player reached for it (CR 702.37a).
    - `foretold` — the card is in **exile**, so the same shape of bug a fourth time.
    - `offered` — not a cheaper cost but a **claim on an offer** the engine is holding the table
      open for: cascade and madness (CR 702.85a, CR 702.35a).
    - `evoked`, `dashed` — the kicker's shape with the trade reversed: cheaper, out of hand.
    - `bestowed` — the one that also points at something, so the flag travels with the targets the
      table collected; without it the engine is handed a creature spell with a target it cannot
      have.
    - `spectacled` — the one that comes and goes, offered only while an opponent has lost life
      this turn.
    - `overloaded` — the one that is dearer, and the one that changes what the spell does.
    - `buyback` — the kicker's twin at a different price: without the flag the card goes to the
      graveyard instead of back to the hand the player paid to keep it in (CR 702.26a).

    One loop rather than eleven conditional spreads, and not only for the length: eleven spreads of
    `{} | { flag: true }` is a union of two thousand object types, which TypeScript refuses to
    represent at all ("union type that is too complex") — overload was the one that tipped it over.
  */
  const COST_FLAGS = [
    "kicked", "buyback", "flashback", "escape", "faceDown", "foretold", "offered",
    "evoked", "dashed", "bestowed", "spectacled", "overloaded",
  ] as const
  const withCostFlags: { [K in (typeof COST_FLAGS)[number]]?: true } = {}
  for (const flag of COST_FLAGS) if (play[flag] === true) withCostFlags[flag] = true
  /*
    Turning a morph face up is a special action, not a cast and not an ability (CR 702.37b), so it
    is its own action with nothing to choose: no targets, no cost to pick, no window for anybody to
    answer in. One tap, and the 2/2 is whatever it was all along.
  */
  if (play.kind === "turnUp") {
    return { type: "auto:turnUp", card: play.card }
  }
  /*
    Foretelling is the other special action, and the opposite of the one above: it hides a card
    where turning a morph up reveals one. Nothing to choose either way — one tap, {2}, and the card
    is face down in exile.
  */
  if (play.kind === "foretell") {
    return { type: "auto:foretell", card: play.card }
  }
  /*
    And suspending, the third special action and foretell's opposite in one respect: everybody can
    see the card and count the turns to it. Nothing to choose here either — one tap, the card's own
    cost, and the counters start coming off next upkeep.
  */
  if (play.kind === "suspend") {
    return { type: "auto:suspend", card: play.card }
  }
  if (play.kind === "cast") {
    // A cast can have a cost of its own to pay now: "sacrifice a creature" is an additional cost,
    // not something the spell asks for on resolution, so it travels with the cast.
    return {
      type: "auto:cast", card: play.card,
      ...withModes, ...withX, ...withReplicate, ...withCostFlags,
      ...withHalf, ...withDivision,
      ...withSacrifice, ...withTargets,
    }
  }
  return {
    type: "auto:activate", card: play.card, abilityIndex: play.abilityIndex ?? 0,
    ...withTargets, ...withSacrifice, ...withReturned,
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
      if (play.sacrificeOptions.length > 0) {
        return { mode: { kind: "feeding", play, cost: "sacrifice" }, action: null }
      }
      // Ninjutsu's cost, asked the same way and for the same reason: it is paid as the ability is
      // activated, so it comes before anything else the play wants.
      if (play.returnOptions !== undefined && play.returnOptions.length > 0) {
        return { mode: { kind: "feeding", play, cost: "returned" }, action: null }
      }
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
      const allowed = mode.cost === "returned"
        ? mode.play.returnOptions ?? []
        : mode.play.sacrificeOptions
      if (!allowed.includes(event.card)) return { mode, action: null }
      if (targetsWanted(mode.play) === 0) {
        return {
          mode: IDLE,
          action: mode.cost === "returned"
            ? playAction(mode.play, [], undefined, undefined, undefined, event.card)
            : playAction(mode.play, [], event.card),
        }
      }
      // Something to aim as well: keep the cost and go on to the targets.
      return mode.cost === "returned"
        ? { mode: { kind: "targeting", play: mode.play, chosen: [], returned: event.card }, action: null }
        : { mode: { kind: "targeting", play: mode.play, chosen: [], sacrifice: event.card }, action: null }
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
        // The **most** it can take, which is when there is nothing left to ask: an optional spec
        // still has a target to offer, so sending at the required count would send a trigger with
        // one target while the player was still choosing a second.
        if (chosen.length >= specsWanted(mode.specs)) {
          return { mode: IDLE, action: { type: "auto:choose", targets: chosen } }
        }
        return { mode: { ...mode, chosen }, action: null }
      }
      if (mode.kind !== "targeting") return { mode, action: null }
      const key = targetKey(event.target)
      /*
        A spell that divides a quantity: one tap spends one point of it (CR 601.2d).

        Tapping a target it already has adds another point to that target rather than dropping it,
        which is the whole interface — three damage split two and one is three taps, and the spell
        goes as soon as the last point is spent. Dropping a target is `undoTarget`, which peels
        one point back off, so a misclick costs one tap to undo instead of the whole aim.
      */
      const amount = dividedAmount(mode.play)
      if (amount !== undefined) {
        const shares = mode.shares ?? []
        if (shares.reduce((n, d) => n + d, 0) >= amount) return { mode, action: null }
        const at = mode.chosen.findIndex((t) => targetKey(t) === key)
        // Never more targets than the card allows, and never more than the amount can pay for:
        // every target has to be assigned at least one.
        const most = Math.min(targetsWanted(mode.play), amount)
        if (at < 0 && mode.chosen.length >= most) return { mode, action: null }
        const picked = at < 0 ? [...mode.chosen, event.target] : mode.chosen
        const spread = at < 0 ? [...shares, 1] : shares.map((d, i) => (i === at ? d + 1 : d))
        if (spread.reduce((n, d) => n + d, 0) >= amount) {
          return {
            mode: IDLE,
            action: playAction(mode.play, picked, mode.sacrifice, mode.x, spread),
          }
        }
        return { mode: { ...mode, chosen: picked, shares: spread }, action: null }
      }
      // Picking something already chosen un-picks it, which is how a misclick is undone.
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
      // For a dividing spell, one step back is one *point* back rather than one target: the last
      // target tapped loses a point, and loses its place only when it has none left.
      if (dividedAmount(mode.play) !== undefined) {
        const shares = mode.shares ?? []
        const last = shares.length - 1
        if (last < 0) return { mode: IDLE, action: null }
        const left = (shares[last] ?? 0) - 1
        return left <= 0
          ? {
            mode: { ...mode, chosen: mode.chosen.slice(0, -1), shares: shares.slice(0, -1) },
            action: null,
          }
          : { mode: { ...mode, shares: shares.map((d, i) => (i === last ? left : d)) }, action: null }
      }
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
        // A dividing spell is sent by its last point rather than by this button, so a press with
        // the amount half spent does nothing: the engine refuses a division that does not add up,
        // and a button that sent one would turn a rule into an error message.
        const amount = dividedAmount(mode.play)
        if (amount !== undefined && (mode.shares ?? []).reduce((n, d) => n + d, 0) !== amount) {
          return { mode, action: null }
        }
        return {
          mode: IDLE,
          action: playAction(mode.play, mode.chosen, mode.sacrifice, mode.x, mode.shares),
        }
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
        /*
          The **required** count, which this used to get wrong on a comment that was true when it
          was written: "a trigger's targets are never optional, it was only put on the stack because
          legal ones existed". Modular is the first trigger here that says "you may", and "up to one
          target artifact creature" is legal with none — so the ability goes on the stack whether or
          not anything can be pointed at, and a table that required a target had no answer to give.
          Found by `LIST=artifact`: a deck with eight Arcbound creatures stopped dead on turn three,
          the prompt open and no card lit, for two thousand moves.
        */
        if (mode.chosen.length < specsRequired(mode.specs)) return { mode, action: null }
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

    case "pickOption": {
      if (mode.kind !== "deciding") return { mode, action: null }
      // Checked against the list the engine offered, exactly as a card pick is: the table does not
      // decide what is answerable, it draws what the engine said.
      if (!(mode.ask.options ?? []).includes(event.option)) return { mode, action: null }
      return { mode: IDLE, action: { type: "auto:decide", cards: [], option: event.option } }
    }

    case "pickNumber": {
      if (mode.kind !== "deciding") return { mode, action: null }
      // Checked against the range the engine offered, for the same reason a word is checked
      // against its list: the table draws what the engine said is answerable and nothing else.
      const range = mode.ask.numbers
      if (range === undefined) return { mode, action: null }
      if (!Number.isInteger(event.amount) || event.amount < range.min || event.amount > range.max) {
        return { mode, action: null }
      }
      return { mode: IDLE, action: { type: "auto:decide", cards: [], amount: event.amount } }
    }

    case "pickTargetChoice": {
      if (mode.kind !== "deciding") return { mode, action: null }
      const choices = mode.ask.targetChoices
      if (choices === undefined) return { mode, action: null }
      // Declining is a real answer, so no target is sent as no target rather than refused here.
      if (event.target === undefined) {
        return { mode: IDLE, action: { type: "auto:decide", cards: [] } }
      }
      // And a target is checked against the list the engine offered, exactly as a word and a
      // number are: the table draws what the engine said is answerable and sends nothing else.
      const wanted = targetKey(event.target)
      if (!choices.some((t) => targetKey(t) === wanted)) return { mode, action: null }
      return { mode: IDLE, action: { type: "auto:decide", cards: [], target: event.target } }
    }

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
  /*
    Something to do with this permanent right now, which the board never said.

    Every other zone a play can come from badges it — hand, graveyard, exile, command — and the
    battlefield did not, so a Contagion Clasp with four mana up, an Equipment that could move and a
    Vehicle that could be crewed all looked exactly like a permanent sitting there doing nothing.
    The plays were on the card's own sheet the whole time; what was missing was the thing that tells
    a player to open it.

    Mana abilities are left out on purpose. Every untapped land has one, so counting them would
    badge half the board every turn and say nothing — and the engine taps lands for a cost by
    itself, so a land's own `{T}: Add {G}` is not a play anybody needs pointing out.
  */
  if (playsForCard(view, card.id).some((play) => !play.isManaAbility)) out.push("playable")
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
    Who it is paired with, for soulbond.

    Named rather than flagged, for the reason the Aura's host is named: the badge is on screen to
    explain a body nothing else on the table accounts for. A Grizzly Bears reading 3/3 is only
    legible if the player can see which creature is lending it the point — and killing either half
    shrinks the other, so the link is the whole decision rather than a decoration.
  */
  if (card.pairedWith !== undefined) {
    const partner = view.cards[card.pairedWith]
    out.push(`paired with ${partner?.card?.name ?? "a creature"}`)
  }
  /*
    And any ability something else is giving it (CR 113.6).

    The one kind of text on this table that is **not** on the card a player can open: a Leonin
    Skyhunter handed "whenever this creature deals damage to a player, draw a card" by an Ophidian
    Eye has nothing in its own box to say so. Written as "has <sentence>" so it reads as an
    addition rather than as a correction to the printed text.
  */
  for (const text of card.granted ?? []) out.push(`has ${text}`)
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
  /*
    And the creature that is going to be tapped again next turn, which the board otherwise shows
    as an ordinary tapped permanent.

    A Wall of Frost's victim looks exactly like a creature that attacked, and the difference is a
    whole turn: a player who cannot see it plans a block with a creature that will not be there to
    make it. "Won't untap" rather than "frozen", because the card says what it does.
  */
  if (card.frozen === true) out.push("won't untap")
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
  // A word question has no count to report: the prompt is the whole label, and the options are
  // the buttons beside it.
  if (ask.options !== undefined) return ask.prompt
  // Nor has a number: the numbers themselves are the buttons.
  if (ask.numbers !== undefined) return ask.prompt
  // Nor has a question about where a copy goes: the targets are the buttons, and so is declining.
  if (ask.targetChoices !== undefined) return ask.prompt
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

/**
 * How much damage another seat has dealt **you** this game, from your own view.
 *
 * The political read a pod had nowhere to show. Life totals are the sum of everybody's work and
 * the log is one event at a time, so "who has been coming at me" was a question a player could
 * only answer from memory — which is exactly the half of a pod's politics the table was missing.
 *
 * Nought when the view has no seat (a watcher), when the pair is you and yourself, and when
 * nothing has landed. The caller draws nothing at nought on purpose: a badge saying "hit you 0" on
 * every strip from turn one is noise, and a strip with no badge is itself the answer to the other
 * half of the question.
 */
export function damageTakenFrom(view: GameView, other: SeatIndex): number {
  const mine = view.seat
  if (mine === null || mine === other) return 0
  const me = view.seats.find((s) => s.index === mine)
  return me?.damageFrom[String(other)] ?? 0
}

/**
 * How much attacking power another seat **could** have aimed at you and sent elsewhere, this game.
 *
 * `damageTakenFrom`'s mirror, and the half of a pod's politics that had no answer anywhere: a
 * player who attacked somebody else instead of you looks exactly like a player who could not
 * attack you at all, and only the engine knows which it was — it is the one that checked the
 * legality when the attack was declared. See `Seat.spared`.
 *
 * In the same unit as the damage beside it, which is what makes the pair readable: "hit you 12,
 * spared you 5" is a seat that has been coming at you and holding something back, and "hit you 0,
 * spared you 20" is a seat that has left you alone all game while it could have done otherwise.
 */
export function sparedYouBy(view: GameView, other: SeatIndex): number {
  const mine = view.seat
  if (mine === null || mine === other) return 0
  const me = view.seats.find((s) => s.index === mine)
  // Optional all the way down, because a view can arrive without the field at all: a table whose
  // server has not restarted since this shipped, or a game stored before it existed. The same
  // reason `autoPassFor` reads its list with a default rather than trusting it to be there.
  return me?.spared?.[String(other)] ?? 0
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
