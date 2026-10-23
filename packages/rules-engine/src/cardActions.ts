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
  const fromKey = zoneKey(inst.zoneSeat, inst.zone);
  const toKey = zoneKey(toSeat, toZone);
  const from = listAt(state, fromKey).filter((id) => id !== inst.id);
  const to = position === 'top'
    ? [inst.id, ...listAt(state, toKey).filter((id) => id !== inst.id)]
    : [...listAt(state, toKey).filter((id) => id !== inst.id), inst.id];

  let next = withZones(state, fromKey === toKey ? { [toKey]: to } : { [fromKey]: from, [toKey]: to });

  // A token that leaves the battlefield ceases to exist, as it does on a real table.
  if (inst.isToken && toZone !== 'battlefield') {
    const instances = { ...next.instances };
    delete instances[inst.id];
    next = {
      ...next,
      instances,
      zones: { ...next.zones, [toKey]: listAt(next, toKey).filter((id) => id !== inst.id) },
    };
    return detachAllFrom(next, inst.id);
  }

  const arriving = toZone === 'battlefield' && (inst.zone !== 'battlefield' || inst.zoneSeat !== toSeat);
  next = withInstance(next, inst.id, {
    zone: toZone,
    zoneSeat: toSeat,
    // Entering the battlefield, or changing control, restarts summoning sickness and wipes damage.
    ...(arriving ? { enteredTurn: state.turn, damage: 0 } : {}),
    ...(toZone === 'battlefield' ? {} : { damage: 0 }),
    // Only the battlefield has an orientation, and only a permanent can carry counters that
    // belong to a physical object. Everything resets on the way out.
    tapped: toZone === 'battlefield' ? inst.tapped : false,
    counters: toZone === 'battlefield' ? inst.counters : {},
    attachedTo: toZone === 'battlefield' ? inst.attachedTo : null,
    faceDown: toZone === 'battlefield' || toZone === 'exile' ? inst.faceDown : false,
    revealed: false,
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

export function drawFromLibrary(state: GameState, seat: SeatIndex, count: number): { state: GameState; drawn: number } {
  let next = state;
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const top = listAt(next, zoneKey(seat, 'library'))[0];
    if (top === undefined) break;
    next = relocate(next, requireInstance(next, top), 'hand', seat, 'bottom');
    drawn++;
  }
  return { state: next, drawn };
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
    ...(card.imageUri === undefined ? {} : { imageUri: card.imageUri }),
    ...(card.scryfallId === undefined ? {} : { scryfallId: card.scryfallId }),
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
      return {
        state: withZones({ ...state, cardDefs, instances, instanceSeq: seq }, {
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
