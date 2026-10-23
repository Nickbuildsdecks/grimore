/**
 * The vocabulary card scripts are written in.
 *
 * Every function here takes a state and returns a new one, so a script is a composition rather than
 * a sequence of mutations — which is what lets the same effect run during resolution, during a
 * trigger, and inside a test with no setup. They are deliberately small and literal: `dealDamage`
 * marks damage and does not check whether anything died, because dying is a state-based action and
 * belongs to the engine, not to Lightning Bolt.
 *
 * Nothing here chooses anything. A target was chosen when the spell was cast and arrives in the
 * context; an effect that would need a decision *during* resolution (searching a library, "choose
 * one", an opponent's discard) has no way to ask, and such a card is not scriptable yet. That is
 * stated in `scripts/index.ts` rather than faked with an automatic choice, because a tutor that
 * silently picks for you is worse than one you have to resolve by hand.
 */
import { characteristicsOf, type ContinuousEffect, type EffectDuration, type Keyword } from './characteristics.js';
import { defKeyFor, zoneKey, type CardDef } from './cards.js';
import {
  drawFromLibrary, listAt, normaliseDef, relocate, requireInstance, withInstance, withZones,
} from './cardActions.js';
import { actionSeed, clampValue, mulberry32, replaceSeat } from './internal.js';
import type { ManaType } from './mana.js';
import { addMana, EMPTY_POOL } from './mana.js';
import type { Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

/** What an effect is given when it runs. */
export interface EffectContext {
  readonly state: GameState;
  /** The permanent or spell the effect comes from. */
  readonly source: string;
  readonly controller: SeatIndex;
  readonly targets: readonly Target[];
  /** The chosen value of X, 0 when the cost had none. */
  readonly x: number;
}

export type EffectFn = (ctx: EffectContext) => GameState;

// ── Reading the board ────────────────────────────────────────────────────────────────────────────

export const poolOf = (state: GameState, seat: SeatIndex) => state.pools[String(seat)] ?? EMPTY_POOL;

export function setPool(state: GameState, seat: SeatIndex, pool: typeof EMPTY_POOL): GameState {
  return { ...state, pools: { ...state.pools, [String(seat)]: pool } };
}

export function addToPool(state: GameState, seat: SeatIndex, type: ManaType, amount = 1): GameState {
  return setPool(state, seat, addMana(poolOf(state, seat), type, amount));
}

/** Every permanent on the battlefield, optionally filtered. */
export function battlefield(state: GameState, predicate?: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const seat of state.seats) {
    for (const id of listAt(state, zoneKey(seat.index, 'battlefield'))) {
      if (!predicate || predicate(id)) out.push(id);
    }
  }
  return out;
}

export function creaturesControlledBy(state: GameState, seat: SeatIndex): string[] {
  return listAt(state, zoneKey(seat, 'battlefield')).filter((id) => {
    const inst = state.instances[id];
    return inst !== undefined && characteristicsOf(state, inst).isCreature;
  });
}

export const opponentsOf = (state: GameState, seat: SeatIndex): SeatIndex[] =>
  state.seats.filter((s) => s.index !== seat && !s.eliminated).map((s) => s.index);

// ── Damage and life ──────────────────────────────────────────────────────────────────────────────

/**
 * Marks damage on a creature or deals it to a player.
 *
 * Damage to a creature is *marked*, not subtracted from toughness: a creature with 3 damage that is
 * then pumped to 5/5 survives, and that only works if the damage is remembered separately.
 * Deathtouch and lifelink are properties of the source, so they are passed in rather than looked up
 * — the same function serves combat damage, where the source is a creature, and a burn spell, where
 * it is not.
 */
export function dealDamage(
  state: GameState,
  target: Target,
  amount: number,
  opts: { readonly deathtouch?: boolean; readonly lifelink?: boolean; readonly controller?: SeatIndex } = {},
): GameState {
  if (amount <= 0) return state;
  let next = state;
  if (target.kind === 'player') {
    const seat = next.seats[target.seat];
    if (seat === undefined) return next;
    next = replaceSeat(next, target.seat, { life: clampValue(seat.life - amount) });
  } else {
    const inst = next.instances[target.id];
    if (inst === undefined || inst.zone !== 'battlefield') return next;
    next = withInstance(next, inst.id, {
      damage: clampValue(inst.damage + amount),
      // Any damage from a deathtouch source destroys the creature (CR 702.2b). Marking it keeps
      // state-based actions the only place something actually dies.
      ...(opts.deathtouch ? { counters: { ...inst.counters, deathtouched: 1 } } : {}),
    });
  }
  if (opts.lifelink && opts.controller !== undefined) next = gainLife(next, opts.controller, amount);
  return next;
}

export function gainLife(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount <= 0) return state;
  const s = state.seats[seat];
  if (s === undefined) return state;
  return replaceSeat(state, seat, { life: clampValue(s.life + amount) });
}

export function loseLife(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount <= 0) return state;
  const s = state.seats[seat];
  if (s === undefined) return state;
  return replaceSeat(state, seat, { life: clampValue(s.life - amount) });
}

// ── Moving cards ─────────────────────────────────────────────────────────────────────────────────

/** Destroys a permanent: to its owner's graveyard, unless it is indestructible. */
export function destroy(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  if (characteristicsOf(state, inst).keywords.has('indestructible')) return state;
  return relocate(state, inst, 'graveyard', inst.owner, 'bottom');
}

export function exileCard(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'exile', inst.owner, 'bottom');
}

export function bounceToHand(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'hand', inst.owner, 'bottom');
}

export function putOntoBattlefield(state: GameState, id: string, seat: SeatIndex): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'battlefield', seat, 'bottom');
}

/**
 * Counters a spell on the stack: it is removed and put into its owner's graveyard (CR 701.5a).
 *
 * The stack is reached directly rather than through `automation.ts`, which imports this module —
 * a spell waiting to resolve is just two fields on the state, and routing through the engine would
 * only buy a cycle. An ability has no card, so countering one simply removes it.
 */
export function counterSpell(state: GameState, id: string): GameState {
  const object = state.stackObjects[id];
  if (object === undefined) return state;
  const objects = { ...state.stackObjects };
  delete objects[id];
  const next: GameState = {
    ...state,
    stackObjects: objects,
    stackOrder: state.stackOrder.filter((o) => o !== id),
  };
  const inst = next.instances[id];
  if (object.kind !== 'spell' || inst === undefined) return next;
  return relocate(next, inst, 'graveyard', inst.owner, 'bottom');
}

/** Puts the top `count` cards of a library into its owner's graveyard. */
export function mill(state: GameState, seat: SeatIndex, count: number): GameState {
  let next = state;
  for (let i = 0; i < Math.max(0, count); i++) {
    const top = listAt(next, zoneKey(seat, 'library'))[0];
    if (top === undefined) break;
    const inst = next.instances[top];
    if (inst === undefined) break;
    next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
  }
  return next;
}

/**
 * Discards cards at random from a hand.
 *
 * "At random" is the only kind of discard the engine can carry out, because a discard the *player*
 * chooses is a decision during resolution and there is no way to ask for one — see the header of
 * `scripts.ts`. A card that says "discards a card" of their choosing is therefore not scripted
 * rather than quietly made random, which would be a different and worse card.
 *
 * The randomness is the engine's own seeded stream, so a replayed game discards the same cards.
 */
export function discardAtRandom(state: GameState, seat: SeatIndex, count: number): GameState {
  let next = state;
  for (let i = 0; i < Math.max(0, count); i++) {
    const hand = listAt(next, zoneKey(seat, 'hand'));
    if (hand.length === 0) break;
    const seq = next.autoSeq + 1;
    const roll = mulberry32(actionSeed(next.rngSeed, next.stateVersion + seq))();
    const pick = hand[Math.min(hand.length - 1, Math.floor(roll * hand.length))];
    const inst = pick === undefined ? undefined : next.instances[pick];
    if (inst === undefined) break;
    next = relocate({ ...next, autoSeq: seq }, inst, 'graveyard', inst.owner, 'bottom');
  }
  return next;
}

export function draw(state: GameState, seat: SeatIndex, count: number): GameState {
  const result = drawFromLibrary(state, seat, count);
  // A player who could not draw has lost (CR 704.5b) — recorded here, acted on by state-based
  // actions, because losing is not Harmonize's business.
  if (result.drawn < count && !result.state.drewFromEmpty.includes(seat)) {
    return { ...result.state, drewFromEmpty: [...result.state.drewFromEmpty, seat] };
  }
  return result.state;
}

export function tap(state: GameState, id: string, tapped = true): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return withInstance(state, id, { tapped });
}

export function untapAll(state: GameState, seat: SeatIndex): GameState {
  let next = state;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    if (next.instances[id]?.tapped) next = withInstance(next, id, { tapped: false });
  }
  return next;
}

export function addCounters(state: GameState, id: string, key: string, amount: number): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  const value = clampValue((inst.counters[key] ?? 0) + amount);
  const counters = { ...inst.counters };
  if (value === 0) delete counters[key];
  else counters[key] = value;
  return withInstance(state, id, { counters });
}

export function createToken(state: GameState, seat: SeatIndex, card: CardDef, count = 1): GameState {
  const def = normaliseDef(card);
  const key = defKeyFor(def);
  const cardDefs = { ...state.cardDefs, [key]: state.cardDefs[key] ?? def };
  const instances = { ...state.instances };
  let seq = state.instanceSeq;
  const created: string[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    seq += 1;
    const id = `t${seat}_${seq}`;
    instances[id] = {
      id, defKey: key, owner: seat, zoneSeat: seat, zone: 'battlefield',
      tapped: false, faceDown: false, revealed: false, counters: {}, attachedTo: null,
      isToken: true, isCommander: false, damage: 0, enteredTurn: state.turn,
    };
    created.push(id);
  }
  const bf = zoneKey(seat, 'battlefield');
  return withZones({ ...state, cardDefs, instances, instanceSeq: seq }, {
    [bf]: [...listAt(state, bf), ...created],
  });
}

/** Moves a permanent to another player's battlefield, which is what gaining control is. */
export function gainControl(state: GameState, id: string, seat: SeatIndex): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  return relocate(state, inst, 'battlefield', seat, 'bottom');
}

export function attachTo(state: GameState, auraId: string, hostId: string): GameState {
  const aura = state.instances[auraId];
  const host = state.instances[hostId];
  if (aura === undefined || host === undefined || host.zone !== 'battlefield') return state;
  return withInstance(state, auraId, { attachedTo: hostId });
}

// ── Continuous effects ───────────────────────────────────────────────────────────────────────────

export interface PumpOptions {
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  readonly removeKeywords?: readonly Keyword[];
  readonly cantAttack?: boolean;
  readonly cantBlock?: boolean;
  readonly duration?: EffectDuration;
}

function pushEffect(state: GameState, effect: Omit<ContinuousEffect, 'id' | 'createdTurn'>): GameState {
  const seq = state.autoSeq + 1;
  const full: ContinuousEffect = { ...effect, id: `fx${seq}`, createdTurn: state.turn };
  return { ...state, autoSeq: seq, effects: [...state.effects, full] };
}

/** "Target creature gets +3/+3 until end of turn", and everything shaped like it. */
export function pump(
  state: GameState, ids: readonly string[], source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  if (ids.length === 0) return state;
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'cards', ids: [...ids] },
    ...(opts.power === undefined ? {} : { power: opts.power }),
    ...(opts.toughness === undefined ? {} : { toughness: opts.toughness }),
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
    ...(opts.removeKeywords ? { removeKeywords: opts.removeKeywords } : {}),
    ...(opts.cantAttack ? { cantAttack: true } : {}),
    ...(opts.cantBlock ? { cantBlock: true } : {}),
    duration: opts.duration ?? 'end-of-turn',
  });
}

/** "Creatures you control get +3/+3 and gain trample until end of turn." */
export function pumpTeam(
  state: GameState, source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'controller-creatures' },
    ...(opts.power === undefined ? {} : { power: opts.power }),
    ...(opts.toughness === undefined ? {} : { toughness: opts.toughness }),
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
    duration: opts.duration ?? 'end-of-turn',
  });
}

/** A permanent's own static effect, which lasts as long as it is on the battlefield. */
export function staticEffect(
  state: GameState, source: string, controller: SeatIndex,
  scope: ContinuousEffect['scope'], opts: PumpOptions,
): GameState {
  return pushEffect(state, {
    source, controller, scope,
    ...(opts.power === undefined ? {} : { power: opts.power }),
    ...(opts.toughness === undefined ? {} : { toughness: opts.toughness }),
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
    ...(opts.removeKeywords ? { removeKeywords: opts.removeKeywords } : {}),
    ...(opts.cantAttack ? { cantAttack: true } : {}),
    ...(opts.cantBlock ? { cantBlock: true } : {}),
    duration: 'permanent',
  });
}

/** Removes every effect a given permanent is the source of. Used when an aura leaves. */
export function removeEffectsFrom(state: GameState, source: string): GameState {
  const effects = state.effects.filter((e) => e.source !== source);
  return effects.length === state.effects.length ? state : { ...state, effects };
}

// ── Target helpers scripts use constantly ────────────────────────────────────────────────────────

export const firstCardTarget = (ctx: EffectContext): string | null => {
  const t = ctx.targets.find((x) => x.kind === 'card');
  return t && t.kind === 'card' ? t.id : null;
};

export const cardTargets = (ctx: EffectContext): string[] =>
  ctx.targets.filter((t): t is Extract<Target, { kind: 'card' }> => t.kind === 'card').map((t) => t.id);

export const firstPlayerTarget = (ctx: EffectContext): SeatIndex | null => {
  const t = ctx.targets.find((x) => x.kind === 'player');
  return t && t.kind === 'player' ? t.seat : null;
};

/** The instance a spell or ability came from, if it still exists. */
export const sourceOf = (ctx: EffectContext) => ctx.state.instances[ctx.source];

export { requireInstance, listAt, withInstance, relocate };
