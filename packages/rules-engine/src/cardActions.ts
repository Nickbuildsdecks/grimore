/**
 * The card half of the reducer: physical moves at the table.
 *
 * Every case here asks only whether a move is *physically coherent* — the card exists, the zone
 * exists, the seat is allowed to touch it — never whether it is legal by the rules of Magic. That is
 * the deliberate choice explained in `cards.ts`: it is what lets two people play an entire game with
 * any deck, instead of only with the cards somebody has written code for.
 *
 * It returns the same `Outcome` as the tracker reducer, so `applyAction` keeps doing the version
 * bump, the state-based-action pass and the logging for both halves in one place.
 */
import {
  defKeyFor,
  zoneKey,
  isZoneId,
  type CardDef,
  type CardInstance,
  type DeckSpec,
  type ZoneId,
} from './cards.js';
import { FORMATS } from './formats.js';
import {
  MAX_CARD_NAME_LENGTH,
  MAX_CARD_TEXT_LENGTH,
  MAX_DRAW_COUNT,
  MAX_INSTANCES,
  MAX_TOKEN_COUNT,
  actionSeed,
  assertCounterKey,
  assertDelta,
  assertIntegerInRange,
  assertMayActFor,
  assertSeatIndex,
  clampValue,
  mulberry32,
  replaceSeat,
  seatName,
  shuffled,
} from './internal.js';
import { STARTER_DECKS } from './starterDecks.js';
import {
  EngineError,
  type Action,
  type CardAction,
  type ActionContext,
  type GameState,
  type Outcome,
  type SeatIndex,
} from './types.js';

/** A full grip. The London mulligan always draws seven and bottoms afterwards. */
export const OPENING_HAND_SIZE = 7;

// ---------------------------------------------------------------------------
// Zone and instance helpers (all return new objects)
// ---------------------------------------------------------------------------

export const listAt = (state: GameState, key: string): readonly string[] => state.zones[key] ?? [];

export function withZones(state: GameState, patch: Record<string, readonly string[]>): GameState {
  return { ...state, zones: { ...state.zones, ...patch } };
}

export function requireInstance(state: GameState, id: unknown): CardInstance {
  if (typeof id !== 'string' || id.length === 0) {
    throw new EngineError('INVALID_CARD', 'card must be an instance id');
  }
  const inst = state.instances[id];
  if (inst === undefined) throw new EngineError('INVALID_CARD', `no card with id ${id} at this table`);
  return inst;
}

export function withInstance(state: GameState, id: string, patch: Partial<CardInstance>): GameState {
  const inst = requireInstance(state, id);
  return { ...state, instances: { ...state.instances, [id]: { ...inst, ...patch } } };
}

function cardName(state: GameState, inst: CardInstance): string {
  return state.cardDefs[inst.defKey]?.name ?? 'a card';
}

/**
 * A seat may touch a card when it is on that seat's side of the table, or when the seat is the
 * host. The owner of a stolen creature deliberately may *not* move it: it is on the thief's
 * battlefield, and reaching across the table is exactly what this prevents.
 */
function assertMayTouch(state: GameState, action: Action, inst: CardInstance, ctx: ActionContext): void {
  if (action.by === inst.zoneSeat || ctx.isHost === true) return;
  throw new EngineError('FORBIDDEN', `seat ${action.by} may not move a card in seat ${inst.zoneSeat}'s ${inst.zone}`);
}

/**
 * Moves one card, detaching anything attached to it and detaching it from whatever it was on.
 * Leaving the battlefield with an aura still attached is the kind of stale pointer that shows up
 * three turns later as a card that cannot be picked up.
 */
export function relocate(
  state: GameState,
  inst: CardInstance,
  toZone: ZoneId,
  toSeat: SeatIndex,
  position: 'top' | 'bottom',
): GameState {
  /**
   * A commander on its way to a graveyard or to exile goes to the command zone instead (CR 903.9).
   *
   * Done here because this is the one place a card changes zone, and because it is a rule of the
   * *format* rather than of a card — the same kind of thing as a token ceasing to exist below. Two
   * consequences are deliberate and worth naming: a commander redirected this way never reaches a
   * graveyard, so it has not **died** and a death trigger does not see it (which is correct), and
   * it becomes castable again with its tax raised.
   *
   * The real rule says its owner *may* do this. Taking it automatically is the simplification,
   * because the alternative is a prompt on every commander death and the engine has no phase to
   * ask in outside a resolution. It is wrong only for a deck that wants its commander in the
   * graveyard, and losing a commander to a forgotten prompt is the worse failure. Only on an
   * automated table: a tabletop move means what the player said.
   */
  if (
    state.automated && inst.isCommander && inst.zone === 'battlefield'
    && (toZone === 'graveyard' || toZone === 'exile')
  ) {
    toZone = 'command';
    toSeat = inst.owner;
  }
  const fromKey = zoneKey(inst.zoneSeat, inst.zone);
  const toKey = zoneKey(toSeat, toZone);
  const from = listAt(state, fromKey).filter((id) => id !== inst.id);
  const to = position === 'top'
    ? [inst.id, ...listAt(state, toKey).filter((id) => id !== inst.id)]
    : [...listAt(state, toKey).filter((id) => id !== inst.id), inst.id];

  let next = withZones(state, fromKey === toKey ? { [toKey]: to } : { [fromKey]: from, [toKey]: to });

  /**
   * A permanent moving from the battlefield to a graveyard has **died** (CR 700.4), whatever did
   * it — lethal damage, a destroy spell, a sacrifice paid as a cost.
   *
   * Recorded here rather than announced by whatever caused it, because this is the one place a
   * card changes zone: `settle` drains the list and raises the event. Only on an automated table,
   * since nothing drains it on a tabletop and it would grow for the whole game. A token is
   * recorded too and then ceases to exist below — its last state is kept in `vanished` so that its
   * own trigger can still fire, which is what the rules say happens (CR 603.6d).
   */
  if (state.automated && inst.zone === 'battlefield' && toZone === 'graveyard') {
    next = { ...next, died: [...next.died, inst.id] };
  }
  /*
    And *leaving* the battlefield at all is its own event (CR 603.6c), wider than dying.

    A Banisher Priest gives its creature back whether it was destroyed, exiled, bounced or
    sacrificed, and every one of those is a different caller. Recorded here for exactly the reason
    `dies` is: this is the one place a card changes zone, so there is no path that can forget.
    Changing controller is not leaving — it moves between two battlefields.
  */
  if (state.automated && inst.zone === 'battlefield' && toZone !== 'battlefield') {
    next = { ...next, left: [...next.left, inst.id] };
  }
  // And arriving from anywhere else is *entering* the battlefield. Changing controller is not —
  // it moves between two battlefields, and a creature that changed hands has not entered.
  if (state.automated && inst.zone !== 'battlefield' && toZone === 'battlefield') {
    next = { ...next, entered: [...next.entered, inst.id] };
  }
  /*
    And a card arriving in a graveyard **from anywhere**, which is wider than dying and is its own
    printed wording (CR 400.7 and every card that says it).

    `died` above is the battlefield half and was never the whole of it: a card milled off a library,
    a card discarded out of a hand and a spell that has finished resolving are all cards put into a
    graveyard, and none of them is a death. Recorded here for the reason the three above it are —
    this is the one place a card changes zone, so there is no path that can forget — and recorded
    *as well as* `died` rather than instead of it, because a creature destroyed in combat really is
    both things at once.

    Moving within a graveyard is not arriving in one.
  */
  if (state.automated && inst.zone !== 'graveyard' && toZone === 'graveyard') {
    next = { ...next, toGraveyard: [...next.toGraveyard, inst.id] };
  }
  /*
    And the narrowest of them: a card going from a **hand** to a graveyard, which is a discard.

    Its own list rather than a filter on `toGraveyard`, because by the time anything reads that
    list the card has moved and the zone it came from is gone — and the difference matters more
    here than anywhere else in this function. Madness is a replacement on *discarding* the card
    (CR 702.35a): a Fiery Temper milled off the top, or put into the graveyard after resolving as a
    spell, must not offer its madness cost, and a list that could not tell those apart would offer
    it twice for every one it should.

    Recorded here for the reason every other list in this function is: this is the one place a card
    changes zone, so there is no path that can forget. Drained by `settle`.
  */
  if (state.automated && inst.zone === 'hand' && toZone === 'graveyard') {
    next = { ...next, discarded: [...next.discarded, inst.id] };
  }

  /*
    A token that leaves the battlefield ceases to exist, as it does on a real table.

    Gone from its zone and detached at once, because nothing should ever see a token sitting in a
    graveyard — but its last state is kept in `vanished`, because a leave-the-battlefield ability
    triggers from the game state as it was before the event (CR 603.6d). Without that a Pest with
    "when this creature dies, you gain 1 life" would pay nothing, which is the limitation this used
    to carry and the one the first token with an ability of its own made real. `settle` clears the
    map once it has raised the events.
  */
  if (inst.isToken && toZone !== 'battlefield') {
    const instances = { ...next.instances };
    delete instances[inst.id];
    next = {
      ...next,
      instances,
      vanished: { ...next.vanished, [inst.id]: { ...inst, zone: toZone, zoneSeat: toSeat } },
      zones: { ...next.zones, [toKey]: listAt(next, toKey).filter((id) => id !== inst.id) },
    };
    return detachAllFrom(next, inst.id);
  }

  /*
    And a permanent that is not a token, leaving the battlefield, is snapshotted for the same reason.

    The counters are wiped below, which is the rule — a card in a graveyard has none — and that is
    exactly what a death trigger reading them needs to have seen. A Hangarback Walker makes a
    Thopter for each counter it *had*, so its last state is kept here for `raise` to read and
    `settle` clears the map once the triggers are on the stack, the same lifetime a token's has.
    Last known information, CR 608.2h.

    Only on an automated table, which is what keeps the map transient: `settle` is the thing that
    empties it and only the engine runs it, so on a tabletop this would be a snapshot of every
    permanent that ever died with nobody to read it or clear it — the state goes to Redis, and a map
    that only grows is a payload that only grows. The `entered` list above is gated for the same
    reason.
  */
  if (state.automated && !inst.isToken && inst.zone === 'battlefield' && toZone !== 'battlefield') {
    next = { ...next, vanished: { ...next.vanished, [inst.id]: inst } };
  }

  const arriving = toZone === 'battlefield' && (inst.zone !== 'battlefield' || inst.zoneSeat !== toSeat);
  /*
    A planeswalker enters with its printed loyalty (CR 306.5b).

    Here rather than in `settle`, for the reason `dies` and `etb` are here: this is the one place
    a card arrives, so there is no path that can forget. The first version put it in the engine's
    arrival drain and a planeswalker placed on a *manual* table had none — which the engine then
    read as zero loyalty and swept into the graveyard the moment it took over. Found by a test
    whose board kept coming up empty.

    From the card rather than from a script, because the number is printed on the card.
  */
  const printedLoyalty = Number.parseInt(next.cardDefs[inst.defKey]?.loyalty ?? '', 10);
  const entersWithLoyalty = toZone === 'battlefield' && inst.zone !== 'battlefield'
    && Number.isFinite(printedLoyalty);
  next = withInstance(next, inst.id, {
    zone: toZone,
    zoneSeat: toSeat,
    // A card that changes zones becomes a new object (CR 400.7). See `CardInstance.objectSeq`:
    // changing controller is not a zone change, and neither is a card that goes nowhere.
    ...(inst.zone === toZone ? {} : { objectSeq: (inst.objectSeq ?? 0) + 1 }),
    // Entering the battlefield, or changing control, restarts summoning sickness and wipes damage.
    ...(arriving ? { enteredTurn: state.turn, damage: 0 } : {}),
    ...(toZone === 'battlefield' ? {} : { damage: 0 }),
    // Only the battlefield has an orientation, and only a permanent can carry counters that
    // belong to a physical object. Everything resets on the way out.
    tapped: toZone === 'battlefield' ? inst.tapped : false,
    // And frozen-ness clears on the way out, for the reason `tapped` does: a new object owes the
    // old effect nothing (CR 400.7), so a Wall of Frost's victim that is bounced and recast comes
    // back free. Changing controller is not leaving, and the effect is keyed to the permanent —
    // "its controller's next untap step" reads the controller when the step comes round.
    ...(toZone === 'battlefield' ? {} : { frozen: false }),
    counters: toZone !== 'battlefield'
      ? {}
      : entersWithLoyalty ? { ...inst.counters, loyalty: printedLoyalty } : inst.counters,
    attachedTo: toZone === 'battlefield' ? inst.attachedTo : null,
    /*
      Three zones keep an orientation, and the stack is the one that is not obvious.

      A morph is cast face down and stays face down through the stack and onto the battlefield, so
      the stack has to carry the bit; without it the spell turned itself face up on the way to the
      stack and the opponent read the card. Everywhere else it clears, which is also the rule: a
      face-down spell that is countered goes to the graveyard face up, and so does a face-down
      creature that dies.
    */
    faceDown: toZone === 'battlefield' || toZone === 'exile' || toZone === 'stack'
      ? inst.faceDown
      : false,
    /*
      And bestow, which is the same bit one card type along: a card cast as an Aura is one on the
      stack and one on the battlefield, and an ordinary creature card anywhere else (CR 702.103e).

      The clearing half is the one that matters. A bestowed Boon Satyr that is countered, or that
      goes to the graveyard when its host is answered in response, is a **creature card** there —
      which is what a reanimation spell brings back and what a graveyard-counting cost reads.
    */
    ...(toZone === 'battlefield' || toZone === 'stack' ? {} : { bestowed: undefined }),
    revealed: false,
    /*
      A copy stops being a copy when the permanent leaves the battlefield.

      `defKey` is where a copy effect lives (see `CardInstance.printedDefKey`), so this is where it
      has to end — in the one place a card changes zone, like `died` and `entered`. A Clone that
      copied a Shivan Dragon is a Clone again in the graveyard, and a Clone is what Zombify brings
      back: layer 1 applies to the permanent, and the permanent is gone.
    */
    ...(toZone !== 'battlefield' && inst.printedDefKey !== undefined
      ? { defKey: inst.printedDefKey, printedDefKey: undefined }
      : {}),
    /*
      And a split card stops being one half of itself as it leaves the stack (CR 708.4).

      The mirror of the line above, for the same reason and in the same place: a Fire // Ice cast
      as Fire is a *four*-mana card again in the graveyard, which is what a Chalice of the Void and
      a graveyard-cost filter both have to read. Set only while on the stack, so this clears it
      everywhere else — including on the way to exile, which is where an adventure goes.
    */
    ...(toZone === 'stack' ? {} : { castAs: undefined }),
  });
  return detachAllFrom(next, inst.id);
}

/** Clears `attachedTo` on anything pointing at `id`, so nothing is left attached to a gone card. */
function detachAllFrom(state: GameState, id: string): GameState {
  let instances: Record<string, CardInstance> | null = null;
  for (const [key, inst] of Object.entries(state.instances)) {
    if (inst.attachedTo !== id) continue;
    instances ??= { ...state.instances };
    instances[key] = { ...inst, attachedTo: null };
  }
  return instances === null ? state : { ...state, instances };
}

/** Default destination seat: the battlefield and the stack are where you put them, the rest go home. */
function defaultSeatFor(inst: CardInstance, toZone: ZoneId, by: SeatIndex): SeatIndex {
  if (toZone === 'battlefield' || toZone === 'stack') return by;
  return inst.owner;
}

export function drawFromLibrary(
  state: GameState, seat: SeatIndex, count: number,
): { state: GameState; drawn: number; cards: readonly string[] } {
  let next = state;
  /*
    Which cards, in the order they were drawn, and not only how many.

    Miracle is why (D204): "you may cast this for its miracle cost when you draw it, **if it's the
    first card you drew this turn**" is a question about a particular card and about its position in
    the turn, and a count cannot answer either. `drawn` stays beside it because every other caller
    only wants the number, and `cards.length` being the same thing is cheaper to read than to
    explain at each call site.
  */
  const cards: string[] = [];
  for (let i = 0; i < count; i++) {
    const top = listAt(next, zoneKey(seat, 'library'))[0];
    if (top === undefined) break;
    next = relocate(next, requireInstance(next, top), 'hand', seat, 'bottom');
    cards.push(top);
  }
  return { state: next, drawn: cards.length, cards };
}

// ---------------------------------------------------------------------------
// Deck materialisation
// ---------------------------------------------------------------------------

function assertCardDef(card: unknown): asserts card is CardDef {
  if (typeof card !== 'object' || card === null) throw new EngineError('INVALID_CARD', 'card must be an object');
  const c = card as Record<string, unknown>;
  if (typeof c['name'] !== 'string' || c['name'].trim().length === 0 || c['name'].length > MAX_CARD_NAME_LENGTH) {
    throw new EngineError('INVALID_CARD', `card name must be 1-${MAX_CARD_NAME_LENGTH} characters`);
  }
  if (typeof c['typeLine'] !== 'string' || c['typeLine'].length > MAX_CARD_NAME_LENGTH) {
    throw new EngineError('INVALID_CARD', 'card typeLine must be a string');
  }
  if (c['oracleText'] !== undefined && (typeof c['oracleText'] !== 'string' || c['oracleText'].length > MAX_CARD_TEXT_LENGTH)) {
    throw new EngineError('INVALID_CARD', `card oracleText must be at most ${MAX_CARD_TEXT_LENGTH} characters`);
  }
  /*
    And the other castable faces, checked the same way the card itself is — and capped at two.

    The cap is not a rules limit, it is a payload one: a caller-supplied deck reaches this function,
    each face is a definition the view inlines, and a card claiming forty faces is a state that does
    not fit down the socket. No printed card has more than two.
  */
  if (c['faces'] !== undefined) {
    const faces = c['faces'] as Record<string, unknown>;
    if (typeof faces !== 'object' || faces === null
      || (faces['kind'] !== 'split' && faces['kind'] !== 'adventure' && faces['kind'] !== 'modal')
      || !Array.isArray(faces['cards']) || faces['cards'].length === 0 || faces['cards'].length > 2) {
      throw new EngineError('INVALID_CARD',
        'card faces must be one or two faces, split, adventure or modal');
    }
    for (const face of faces['cards']) assertCardDef(face);
  }
}

export function normaliseDef(card: CardDef): CardDef {
  return {
    name: card.name.trim(),
    typeLine: card.typeLine ?? '',
    manaCost: card.manaCost ?? '',
    cmc: Number.isFinite(card.cmc) ? card.cmc : 0,
    oracleText: card.oracleText ?? '',
    colors: Array.isArray(card.colors) ? [...card.colors] : [],
    ...(card.power === undefined ? {} : { power: card.power }),
    ...(card.toughness === undefined ? {} : { toughness: card.toughness }),
    // Printed loyalty, which is to a planeswalker what toughness is to a creature — and was
    // dropped here at first, so every planeswalker entered the battlefield with no loyalty and
    // was swept straight into the graveyard by the state-based actions.
    ...(card.loyalty === undefined ? {} : { loyalty: card.loyalty }),
    ...(card.imageUri === undefined ? {} : { imageUri: card.imageUri }),
    ...(card.scryfallId === undefined ? {} : { scryfallId: card.scryfallId }),
    /*
      The other castable faces, normalised one level deep and no further.

      One level is the whole of it: no printed card has a face with a face, and recursing would let
      a caller-supplied deck hand the engine a cycle. Each face is also registered under its own
      key by `place` below, so these nested copies are what the *table* reads — the card in a hand
      is drawn with both halves on it — while the engine reads the registered ones.
    */
    ...(card.faces === undefined ? {} : {
      faces: {
        kind: card.faces.kind,
        cards: card.faces.cards.map((face) => {
          const { faces: _nested, ...flat } = normaliseDef(face);
          return flat;
        }),
      },
    }),
  };
}

function resolveDeck(deckId: unknown, ctx: ActionContext): DeckSpec {
  if (typeof deckId !== 'string' || deckId.length === 0) {
    throw new EngineError('INVALID_DECK', 'deckId must be a non-empty string');
  }
  const deck = ctx.decks?.[deckId] ?? STARTER_DECKS[deckId];
  if (deck === undefined) throw new EngineError('INVALID_DECK', `no deck with id ${deckId}`);
  return deck;
}

/** Removes every card belonging to a seat, so loading a second deck replaces rather than stacks. */
function clearSeatCards(state: GameState, seat: SeatIndex): GameState {
  const instances: Record<string, CardInstance> = {};
  for (const [id, inst] of Object.entries(state.instances)) {
    if (inst.owner !== seat) instances[id] = inst;
  }
  const kept = new Set(Object.keys(instances));
  const zones: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(state.zones)) {
    zones[key] = ids.filter((id) => kept.has(id));
  }
  return { ...state, instances, zones };
}

// ---------------------------------------------------------------------------
// Opening hands
// ---------------------------------------------------------------------------

/**
 * Draws a grip for every seat holding a library. Seats without one are untouched, which is what
 * keeps a table used purely as a life tracker behaving exactly as it did before cards existed.
 */
export function dealOpeningHands(state: GameState): { state: GameState; dealt: number } {
  let next = state;
  let dealt = 0;
  for (const seat of state.seats) {
    if (listAt(next, zoneKey(seat.index, 'library')).length === 0) continue;
    const result = drawFromLibrary(next, seat.index, OPENING_HAND_SIZE);
    next = result.state;
    if (result.drawn > 0) dealt++;
  }
  return { state: next, dealt };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Takes a `CardAction` rather than the whole union, so the switch below keeps a real exhaustiveness
 * check: adding a card action without handling it is a type error. The dispatch in `engine.ts`
 * does the narrowing, since it is the only caller and it has to choose between the reducers anyway.
 */
export function reduceCardAction(state: GameState, action: CardAction, ctx: ActionContext): Outcome {
  switch (action.type) {
    case 'deck:load': {
      if (state.started) throw new EngineError('ALREADY_STARTED', 'decks are loaded before the game starts');
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      const deck = resolveDeck(action.deckId, ctx);

      let next = clearSeatCards(state, action.seat);
      const cardDefs = { ...next.cardDefs };
      const instances = { ...next.instances };
      const libraryIds: string[] = [];
      const commandIds: string[] = [];
      let seq = next.instanceSeq;

      const place = (card: CardDef, isCommander: boolean): void => {
        assertCardDef(card);
        const def = normaliseDef(card);
        const key = defKeyFor(def);
        cardDefs[key] ??= def;
        /*
          And each castable face under its own key, which is what lets everything downstream stay
          as it is: a spell cast as one half points `castAs` at that half's key, and every existing
          lookup — characteristics, the script, the stack description, the type line a counterspell
          reads — finds it by the same `cardDefs[...]` it already does.
        */
        for (const face of def.faces?.cards ?? []) cardDefs[defKeyFor(face)] ??= face;
        seq += 1;
        const id = `c${action.seat}_${seq}`;
        const zone: ZoneId = isCommander ? 'command' : 'library';
        instances[id] = {
          id,
          defKey: key,
          owner: action.seat,
          zoneSeat: action.seat,
          zone,
          tapped: false,
          faceDown: false,
          revealed: false,
          counters: {},
          attachedTo: null,
          isToken: false,
          isCommander,
          damage: 0,
          enteredTurn: 0,
        };
        (isCommander ? commandIds : libraryIds).push(id);
      };

      // A commander only goes to the command zone in a format that has one; in Modern it is just
      // another card in the deck, which is also how the physical card works.
      const usesCommandZone = FORMATS[state.format].commanderDamageRule;
      for (const entry of deck.cards) {
        assertIntegerInRange(entry.count, 1, 200, 'count');
        for (let i = 0; i < entry.count; i++) place(entry.card, false);
      }
      if (deck.commander !== undefined) place(deck.commander, usesCommandZone);

      if (Object.keys(instances).length > MAX_INSTANCES) {
        throw new EngineError('INVALID_DECK', `a table may hold at most ${MAX_INSTANCES} cards`);
      }

      const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion));
      next = {
        ...next,
        cardDefs,
        instances,
        instanceSeq: seq,
        zones: {
          ...next.zones,
          [zoneKey(action.seat, 'library')]: shuffled(libraryIds, rng),
          [zoneKey(action.seat, 'hand')]: [],
          [zoneKey(action.seat, 'battlefield')]: [],
          [zoneKey(action.seat, 'graveyard')]: [],
          [zoneKey(action.seat, 'exile')]: [],
          [zoneKey(action.seat, 'command')]: commandIds,
        },
      };
      next = replaceSeat(next, action.seat, { deckId: deck.id, mulligans: 0, searching: false });
      return {
        state: next,
        message: `${seatName(state, action.seat)} loaded ${deck.name} (${libraryIds.length} cards)`,
        data: { seat: action.seat, deckId: deck.id, library: libraryIds.length, commanders: commandIds.length },
      };
    }

    case 'zone:draw': {
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      assertIntegerInRange(action.count, 1, MAX_DRAW_COUNT, 'count');
      const result = drawFromLibrary(state, action.seat, action.count);
      if (result.drawn === 0) {
        throw new EngineError('EMPTY_LIBRARY', `${seatName(state, action.seat)} has no cards left to draw`);
      }
      return {
        state: result.state,
        message: `${seatName(state, action.seat)} drew ${result.drawn} card(s)`,
        data: { seat: action.seat, drawn: result.drawn, requested: action.count },
      };
    }

    case 'zone:shuffle': {
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      if (!isZoneId(action.zone)) throw new EngineError('INVALID_ZONE', `unknown zone: ${String(action.zone)}`);
      const key = zoneKey(action.seat, action.zone);
      const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion));
      // Shuffling closes a search, which is the same rule as at a table: once it is shuffled you no
      // longer know the order, so the view must stop showing it.
      const next = replaceSeat(withZones(state, { [key]: shuffled(listAt(state, key), rng) }), action.seat, {
        searching: false,
      });
      return {
        state: next,
        message: `${seatName(state, action.seat)} shuffled their ${action.zone}`,
        data: { seat: action.seat, zone: action.zone, size: listAt(state, key).length },
      };
    }

    case 'zone:search': {
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      const searching = action.searching !== false;
      return {
        state: replaceSeat(state, action.seat, { searching }),
        message: `${seatName(state, action.seat)} ${searching ? 'is searching their library' : 'closed their library'}`,
        data: { seat: action.seat, searching },
      };
    }

    case 'card:move': {
      const inst = requireInstance(state, action.card);
      assertMayTouch(state, action, inst, ctx);
      if (!isZoneId(action.toZone)) throw new EngineError('INVALID_ZONE', `unknown zone: ${String(action.toZone)}`);
      const toSeat = action.toSeat === undefined ? defaultSeatFor(inst, action.toZone, action.by) : action.toSeat;
      assertSeatIndex(state, toSeat, 'toSeat');
      // Moving a card onto someone else's side of the table is giving it away, which is a thing you
      // may do; taking one from their side is not, and assertMayTouch already refused that.
      const position = action.position === 'top' ? 'top' : 'bottom';
      const name = inst.isToken || !inst.faceDown ? cardName(state, inst) : 'a face-down card';
      return {
        state: relocate(state, inst, action.toZone, toSeat, position),
        message: `${seatName(state, action.by)} moved ${name} to ${seatName(state, toSeat)}'s ${action.toZone}`
          + (action.toZone === 'library' ? ` (${position})` : ''),
        data: { card: inst.id, from: inst.zone, to: action.toZone, toSeat, position },
      };
    }

    case 'card:control': {
      const inst = requireInstance(state, action.card);
      assertMayTouch(state, action, inst, ctx);
      assertSeatIndex(state, action.toSeat, 'toSeat');
      return {
        state: relocate(state, inst, 'battlefield', action.toSeat, 'bottom'),
        message: `${seatName(state, action.toSeat)} gains control of ${cardName(state, inst)}`,
        data: { card: inst.id, toSeat: action.toSeat },
      };
    }

    case 'card:tap': {
      const inst = requireInstance(state, action.card);
      assertMayTouch(state, action, inst, ctx);
      const tapped = action.tapped === undefined ? !inst.tapped : action.tapped === true;
      return {
        state: withInstance(state, inst.id, { tapped }),
        message: `${cardName(state, inst)} ${tapped ? 'tapped' : 'untapped'}`,
        data: { card: inst.id, tapped },
      };
    }

    case 'card:faceDown': {
      const inst = requireInstance(state, action.card);
      assertMayTouch(state, action, inst, ctx);
      const faceDown = action.faceDown === undefined ? !inst.faceDown : action.faceDown === true;
      return {
        state: withInstance(state, inst.id, { faceDown }),
        // Deliberately does not name the card: the log is public, and a face-down card is hidden.
        message: `${seatName(state, inst.zoneSeat)} turned a card ${faceDown ? 'face down' : 'face up'}`,
        data: { card: inst.id, faceDown },
      };
    }

    case 'card:reveal': {
      const inst = requireInstance(state, action.card);
      assertMayTouch(state, action, inst, ctx);
      const revealed = action.revealed === undefined ? !inst.revealed : action.revealed === true;
      return {
        state: withInstance(state, inst.id, { revealed }),
        message: revealed
          ? `${seatName(state, inst.zoneSeat)} revealed ${cardName(state, inst)}`
          : `${seatName(state, inst.zoneSeat)} stopped revealing a card`,
        data: { card: inst.id, revealed },
      };
    }

    case 'card:counter': {
      const inst = requireInstance(state, action.card);
      assertMayTouch(state, action, inst, ctx);
      assertCounterKey(action.key);
      assertDelta(action.delta);
      const current = inst.counters[action.key] ?? 0;
      const value = clampValue(current + action.delta);
      const counters = { ...inst.counters };
      if (value === 0) delete counters[action.key];
      else counters[action.key] = value;
      return {
        state: withInstance(state, inst.id, { counters }),
        message: `${cardName(state, inst)} ${action.key} ${current} -> ${value}`,
        data: { card: inst.id, key: action.key, value },
      };
    }

    case 'card:attach': {
      const inst = requireInstance(state, action.card);
      assertMayTouch(state, action, inst, ctx);
      if (action.to === null) {
        return {
          state: withInstance(state, inst.id, { attachedTo: null }),
          message: `${cardName(state, inst)} detached`,
          data: { card: inst.id, to: null },
        };
      }
      const host = requireInstance(state, action.to);
      if (host.id === inst.id) throw new EngineError('INVALID_CARD', 'a card cannot be attached to itself');
      if (host.zone !== 'battlefield' || inst.zone !== 'battlefield') {
        throw new EngineError('RULE_NOT_APPLICABLE', 'both cards must be on the battlefield to attach');
      }
      // One level only: attaching to something already attached is how you build a loop.
      if (host.attachedTo !== null) {
        throw new EngineError('RULE_NOT_APPLICABLE', 'cannot attach to a card that is itself attached');
      }
      return {
        state: withInstance(state, inst.id, { attachedTo: host.id }),
        message: `${cardName(state, inst)} attached to ${cardName(state, host)}`,
        data: { card: inst.id, to: host.id },
      };
    }

    case 'turn:untapAll': {
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      const ids = listAt(state, zoneKey(action.seat, 'battlefield'));
      const instances = { ...state.instances };
      let count = 0;
      for (const id of ids) {
        const inst = instances[id];
        if (inst === undefined || !inst.tapped) continue;
        instances[id] = { ...inst, tapped: false };
        count++;
      }
      return {
        state: { ...state, instances },
        message: `${seatName(state, action.seat)} untapped ${count} permanent(s)`,
        data: { seat: action.seat, untapped: count },
      };
    }

    case 'token:create': {
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      const count = action.count === undefined ? 1 : action.count;
      assertIntegerInRange(count, 1, MAX_TOKEN_COUNT, 'count');
      assertCardDef(action.card);
      const def = normaliseDef(action.card);
      const key = defKeyFor(def);
      const cardDefs = { ...state.cardDefs };
      cardDefs[key] ??= def;
      const instances = { ...state.instances };
      let seq = state.instanceSeq;
      const created: string[] = [];
      for (let i = 0; i < count; i++) {
        seq += 1;
        const id = `t${action.seat}_${seq}`;
        instances[id] = {
          id,
          defKey: key,
          owner: action.seat,
          zoneSeat: action.seat,
          zone: 'battlefield',
          tapped: false,
          faceDown: false,
          revealed: false,
          counters: {},
          attachedTo: null,
          isToken: true,
          isCommander: false,
          damage: 0,
          enteredTurn: state.turn,
        };
        created.push(id);
      }
      if (Object.keys(instances).length > MAX_INSTANCES) {
        throw new EngineError('INVALID_ACTION', `a table may hold at most ${MAX_INSTANCES} cards`);
      }
      const bf = zoneKey(action.seat, 'battlefield');
      // A token made by hand enters the battlefield like any other, and on an automated table its
      // arrival is recorded for `settle` to announce. See `AutomationState.entered`.
      const entered = state.automated ? [...state.entered, ...created] : state.entered;
      return {
        state: withZones({ ...state, cardDefs, instances, instanceSeq: seq, entered }, {
          [bf]: [...listAt(state, bf), ...created],
        }),
        message: `${seatName(state, action.seat)} created ${count} ${def.name} token(s)`,
        data: { seat: action.seat, token: def.name, count },
      };
    }

    case 'mulligan': {
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      const handKey = zoneKey(action.seat, 'hand');
      const libKey = zoneKey(action.seat, 'library');
      const hand = listAt(state, handKey);
      if (listAt(state, libKey).length === 0 && hand.length === 0) {
        throw new EngineError('RULE_NOT_APPLICABLE', 'this seat has no deck loaded');
      }
      // London mulligan: the whole hand goes back, you draw a full seven, and you then put as many
      // on the bottom as you have mulliganed. Bottoming is ordinary card moves, which is why the
      // count is tracked rather than enforced here.
      let next = state;
      for (const id of hand) {
        next = relocate(next, requireInstance(next, id), 'library', action.seat, 'bottom');
      }
      const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion));
      next = withZones(next, { [libKey]: shuffled(listAt(next, libKey), rng) });
      const drawn = drawFromLibrary(next, action.seat, OPENING_HAND_SIZE);
      const mulligans = (state.seats[action.seat]?.mulligans ?? 0) + 1;
      next = replaceSeat(drawn.state, action.seat, { mulligans, searching: false });
      // Drawing a fresh hand un-keeps it: the seat now owes one more card to the bottom.
      next = { ...next, kept: next.kept.filter((seat) => seat !== action.seat) };
      return {
        state: next,
        message: `${seatName(state, action.seat)} mulliganed to ${Math.max(0, OPENING_HAND_SIZE - mulligans)}`
          + ` (drew ${drawn.drawn}, bottom ${mulligans})`,
        data: { seat: action.seat, mulligans, drawn: drawn.drawn, bottom: mulligans },
      };
    }

    default: {
      const exhaustive: never = action;
      throw new EngineError(
        'INVALID_ACTION',
        `unknown action type: ${String((exhaustive as { type?: unknown }).type)}`,
      );
    }
  }
}
