/**
 * The vocabulary card scripts are written in.
 *
 * Every function here takes a state and returns a new one, so a script is a composition rather than
 * a sequence of mutations — which is what lets the same effect run during resolution, during a
 * trigger, and inside a test with no setup. They are deliberately small and literal: `dealDamage`
 * marks damage and does not check whether anything died, because dying is a state-based action and
 * belongs to the engine, not to Lightning Bolt.
 *
 * Nothing here chooses anything, and that is the rule rather than a limitation. A target was
 * chosen when the spell was cast; a decision made *during* resolution — searching a library, an
 * opponent's own-choice discard — was asked for by the engine and answered by a player before the
 * effect ran, and arrives in `ctx.decisions` the same way. An effect that picked for itself would
 * be a tutor that chooses your card for you, which is worse than one you resolve by hand.
 */
import {
  characteristicsOf, hasType, protectedFrom, type ContinuousEffect, type EffectDuration,
  type Keyword,
} from './characteristics.js';
import { defKeyFor, zoneKey, type CardDef } from './cards.js';
import {
  drawFromLibrary, listAt, normaliseDef, relocate, requireInstance, withInstance, withZones,
} from './cardActions.js';
import { actionSeed, clampValue, mulberry32, replaceSeat } from './internal.js';
import type { Color, ManaType } from './mana.js';
import { addMana, EMPTY_POOL } from './mana.js';
import type { AttackedTarget, DecisionAnswer, Target } from './turnTypes.js';
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
  /**
   * Answers to the questions this spell or ability asked while resolving, in the order its
   * `decisions` asked them. Empty for everything that asks nothing — which is almost everything.
   */
  readonly decisions: readonly DecisionAnswer[];
  /** Whether this spell's kicker was paid (CR 702.32a). False for everything without one. */
  readonly kicked: boolean;
  /**
   * What the attack that caused this trigger was aimed at, for an attack trigger that has to say
   * "the player or planeswalker it's attacking". Undefined for everything else.
   */
  readonly attacked?: AttackedTarget;
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
  opts: {
    readonly deathtouch?: boolean;
    readonly lifelink?: boolean;
    readonly controller?: SeatIndex;
    /**
     * The attacking creature, when this is **combat** damage. Only combat damage from a commander
     * counts towards the twenty-one that eliminates a player (CR 903.10), so this is passed by
     * `dealCombatDamage` and by nothing else — a burn spell cast by a commander is not it, and a
     * single `source` option would have been quietly wrong for exactly that case.
     */
    readonly combatFrom?: string;
    /**
     * What is dealing the damage: a permanent, or a spell on the stack whose id is its own card.
     *
     * **Required, and required on purpose.** Protection from a colour (CR 702.16) is a fact about
     * the *source*, so the only way to apply it is to know what dealt the damage — and the only
     * way to be sure twenty-one call sites all say is to make the compiler ask. `null` is the
     * honest answer for damage with no source a colour can be read from, and the rules agree with
     * it: protection is from colours, so a colourless source gets through.
     */
    readonly source: string | null;
  },
): GameState {
  if (amount <= 0) return state;
  let next = state;
  // Protection from the source's colour prevents the damage entirely (CR 702.16b). Asked before
  // anything is marked, because prevention is not something that can be undone afterwards.
  if (target.kind === 'card' && protectedFrom(next, target.id, opts.source)) return next;
  if (target.kind === 'player') {
    const seat = next.seats[target.seat];
    if (seat === undefined) return next;
    const from = opts.combatFrom === undefined ? undefined : next.instances[opts.combatFrom];
    /**
     * Keyed by the **seat whose commander it is**, not by the commander's instance id.
     *
     * The id would be closer to the rule, which is per commander object. The seat is right
     * anyway, and it is right for a reason worth stating: `commanderDamage:adjust` — the tabletop
     * action a player uses to record damage by hand — has always keyed by seat, and `viewFor`
     * ships the record straight to the client. Two key spaces in one record would mean ten damage
     * recorded by hand and eleven dealt by the engine never add up to the twenty-one that
     * eliminates, which is exactly the table a mixed game produces.
     *
     * Owner rather than controller, so a stolen commander still deals *its own* damage. The one
     * case this is wrong for is a deck with two commanders, where the rule counts each separately
     * and this would sum them; nothing in the pool has partner.
     */
    const key = from?.isCommander === true ? String(from.owner) : null;
    const tally = key === null
      ? {}
      : { commanderDamage: { ...seat.commanderDamage, [key]: (seat.commanderDamage[key] ?? 0) + amount } };
    next = replaceSeat(next, target.seat, { life: clampValue(seat.life - amount), ...tally });
  } else {
    const inst = next.instances[target.id];
    if (inst === undefined || inst.zone !== 'battlefield') return next;
    /*
      Damage to a planeswalker removes that many loyalty counters (CR 120.3c) rather than being
      marked on it. Not a detail: marked damage wears off at end of turn, and a planeswalker that
      healed every turn would be unkillable by anything but a removal spell.
    */
    if (hasType(characteristicsOf(next, inst).typeLine, 'planeswalker')) {
      const loyalty = inst.counters['loyalty'] ?? 0;
      const counters = { ...inst.counters, loyalty: Math.max(0, loyalty - amount) };
      next = withInstance(next, inst.id, { counters });
      if (opts.lifelink && opts.controller !== undefined) next = gainLife(next, opts.controller, amount);
      return next;
    }
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
/** The counter a regeneration shield is kept as, so it travels with the permanent and the state. */
export const REGENERATION = 'regeneration';

/**
 * "The next time this creature would be destroyed this turn, instead..." (CR 701.15).
 *
 * A shield, not a trigger: it sits on the permanent and is spent the next time something would
 * destroy it. Kept as a counter because that is already a per-permanent, serialised, visible
 * number — a player can see how many shields a creature has, which is exactly right.
 */
export function regenerate(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  return addCounters(state, id, REGENERATION, 1);
}

/**
 * Spends a regeneration shield, if there is one, instead of letting the creature be destroyed.
 *
 * The replacement is specific and all three parts matter: it is **tapped**, its damage is
 * **removed**, and it is **taken out of combat** — so a regenerated attacker deals no more damage
 * this turn, which is most of what makes regeneration a cost rather than a free save. Returns
 * `null` when there was no shield, so each caller can carry on with the destruction it meant.
 */
export function spendRegeneration(state: GameState, id: string): GameState | null {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return null;
  const shields = inst.counters[REGENERATION] ?? 0;
  if (shields <= 0) return null;
  const counters = { ...inst.counters };
  if (shields > 1) counters[REGENERATION] = shields - 1;
  else delete counters[REGENERATION];
  // Any lethal damage marked on it goes too, or the state-based actions would simply kill it again
  // on the next pass and the shield would have bought nothing.
  const next = withInstance(state, id, { tapped: true, damage: 0, counters });
  return removeFromCombat(next, id);
}

/**
 * Takes one creature out of combat: it stops attacking, and stops blocking whatever it blocked.
 *
 * An attack with no attacker left is dropped entirely; a blocker is lifted off every attack it
 * was assigned to. Nothing else in combat changes, which is the point — the other attackers are
 * still attacking and the other blockers are still blocking.
 */
export function removeFromCombat(state: GameState, id: string): GameState {
  const attacks = state.combat.attacks
    .filter((attack) => attack.attacker !== id)
    .map((attack) => (attack.blockers.includes(id)
      ? { ...attack, blockers: attack.blockers.filter((b) => b !== id) }
      : attack));
  const same = attacks.length === state.combat.attacks.length
    && attacks.every((attack, i) => attack === state.combat.attacks[i]);
  return same ? state : { ...state, combat: { ...state.combat, attacks } };
}

export function destroy(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  if (characteristicsOf(state, inst).keywords.has('indestructible')) return state;
  // Regeneration replaces the destruction rather than following it, so it is checked here — the
  // one place a card is destroyed on purpose — and again where lethal damage is noticed.
  const saved = spendRegeneration(state, id);
  if (saved !== null) return saved;
  return relocate(state, inst, 'graveyard', inst.owner, 'bottom');
}

export function exileCard(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'exile', inst.owner, 'bottom');
}

/**
 * Exiles a card and records which permanent did it, so that permanent can give it back.
 *
 * "Exile until ~ leaves the battlefield" is one effect with two halves (CR 400.7e), and the link
 * between them is the only reason the card is fair. Kept on the exiled card — see
 * `CardInstance.exiledBy` — and read by `returnExiledBy` when the exiler leaves.
 */
export function exileUntilLeaves(state: GameState, id: string, exiledBy: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  const next = relocate(state, inst, 'exile', inst.owner, 'bottom');
  // After the move, because `relocate` rebuilds the instance and would drop a field set before it.
  return next.instances[id] === undefined ? next : withInstance(next, id, { exiledBy });
}

/**
 * Returns everything a permanent exiled, to the battlefield, under its **owner's** control.
 *
 * Its owner and not the exiler's: a Banisher Priest that dies gives the creature back to the
 * player it took it from, and getting that wrong would make the card a Mind Control with extra
 * steps. A card that has since left exile — exiled again by something else, or shuffled away — is
 * skipped rather than dragged back from wherever it is now.
 */
export function returnExiledBy(state: GameState, exiledBy: string): GameState {
  let next = state;
  for (const [id, inst] of Object.entries(state.instances)) {
    if (inst.exiledBy !== exiledBy) continue;
    if (inst.zone !== 'exile') continue;
    next = withInstance(next, id, { exiledBy: undefined });
    const current = next.instances[id];
    if (current === undefined) continue;
    next = relocate(next, current, 'battlefield', current.owner, 'bottom');
  }
  return next;
}

export function bounceToHand(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'hand', inst.owner, 'bottom');
}

export function putOntoBattlefield(
  state: GameState, id: string, seat: SeatIndex, opts: { readonly tapped?: boolean } = {},
): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  const next = relocate(state, inst, 'battlefield', seat, 'bottom');
  return opts.tapped === true ? withInstance(next, id, { tapped: true }) : next;
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
  // A token enters the battlefield like anything else, and its entry is recorded for `settle` to
  // announce. Without this a token triggered nothing at all — not its own ability, and not an
  // Impact Tremors watching for it. `createToken` writes the zone directly rather than going
  // through `relocate`, which is why it has to say so here.
  const entered = state.automated ? [...state.entered, ...created] : state.entered;
  return withZones({ ...state, cardDefs, instances, instanceSeq: seq, entered }, {
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

/**
 * Equip: move an Equipment onto a creature its controller controls, bonus and all.
 *
 * Different from an Aura in the two ways that matter. It *moves* — equipping again takes it off
 * the creature it was on, so the old bonus has to go with it, which is what `removeEffectsFrom`
 * is doing here. And it **stays on the battlefield** when that creature dies; only the attachment
 * ends (CR 301.5c), which is handled by the state-based actions rather than here.
 */
export function equipTo(
  state: GameState, equipId: string, hostId: string, controller: SeatIndex, bonus: PumpOptions,
): GameState {
  const equipment = state.instances[equipId];
  const host = state.instances[hostId];
  if (equipment === undefined || host === undefined || host.zone !== 'battlefield') return state;
  if (host.zoneSeat !== controller) return state;
  // Protection from a colour stops an Equipment of that colour attaching (CR 702.16e). Almost
  // every Equipment is colourless and gets straight past it, which is the point of checking rather
  // than assuming: the one that is not would otherwise attach and nobody would notice.
  if (protectedFrom(state, hostId, equipId)) return state;
  const moved = withInstance(removeEffectsFrom(state, equipId), equipId, { attachedTo: hostId });
  return staticEffect(moved, equipId, controller, { kind: 'cards', ids: [hostId] }, bonus);
}

// ── Continuous effects ───────────────────────────────────────────────────────────────────────────

export interface PumpOptions {
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  readonly removeKeywords?: readonly Keyword[];
  readonly cantAttack?: boolean;
  readonly cantBlock?: boolean;
  /** See `ContinuousEffect.preventsCombatDamage`. A Fog Bank is this, printed on a 0/2. */
  readonly preventsCombatDamage?: boolean;
  /** See `ContinuousEffect.mustAttack` — "attacks each combat if able" (CR 508.1d). */
  readonly mustAttack?: boolean;
  /** See `ContinuousEffect.cantBeBlockedByWalls`. */
  readonly cantBeBlockedByWalls?: boolean;
  /** See `ContinuousEffect.mustAttackAnotherPlayer` — goad's second half (CR 701.38a). */
  readonly mustAttackAnotherPlayer?: boolean;
  /** See `ContinuousEffect.protectionFrom` — protection from a colour (CR 702.16). */
  readonly protectionFrom?: readonly Color[];
  readonly duration?: EffectDuration;
}

/**
 * One translation from "what a card says" to "what an effect carries", for every builder there is.
 *
 * Each of them used to copy the subset of `PumpOptions` it happened to know about — five
 * near-identical lists that quietly disagreed. `pump` dropped `mustAttack`; `staticEffect` dropped
 * that *and* `preventsCombatDamage`, which is the path an Equipment's bonus takes; `pumpTeam` and
 * `pumpAll` carried only a body and keywords; the aura builder dropped four; and the statics
 * builder dropped `cantAttack` and `cantBlock`, so a card whose printed static was "this creature
 * can't attack" would have done nothing at all. A flag therefore worked or vanished depending on
 * which builder a script happened to reach for, with nothing anywhere to say so.
 *
 * One list, read by everything, is the only version of this that stays true — and it is the same
 * move as `manaSources` serving both `legalActions` and payment: one answer to one question.
 *
 * `duration` is not here on purpose: each builder decides its own, and a static effect that
 * accepted one would be a static effect that is not static.
 */
export function modsFrom(opts: PumpOptions): Omit<ContinuousEffect, 'id' | 'createdTurn' | 'source' | 'controller' | 'scope' | 'duration'> {
  return {
    ...(opts.power === undefined ? {} : { power: opts.power }),
    ...(opts.toughness === undefined ? {} : { toughness: opts.toughness }),
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
    ...(opts.removeKeywords ? { removeKeywords: opts.removeKeywords } : {}),
    ...(opts.cantAttack ? { cantAttack: true } : {}),
    ...(opts.cantBlock ? { cantBlock: true } : {}),
    ...(opts.preventsCombatDamage ? { preventsCombatDamage: true } : {}),
    ...(opts.mustAttack ? { mustAttack: true } : {}),
    ...(opts.cantBeBlockedByWalls ? { cantBeBlockedByWalls: true } : {}),
    ...(opts.mustAttackAnotherPlayer ? { mustAttackAnotherPlayer: true } : {}),
    ...(opts.protectionFrom ? { protectionFrom: opts.protectionFrom } : {}),
  };
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
    ...modsFrom(opts),
    duration: opts.duration ?? 'end-of-turn',
  });
}

/**
 * Goad: "until your next turn, that creature attacks each combat if able and attacks a player
 * other than you if able" (CR 701.38).
 *
 * Both halves and the duration, because all three are the card — a goad that wore off at end of
 * turn, or that forced an attack without sending it elsewhere, would be a different and much worse
 * card. `controller` is the goading player, and every part of the effect is read relative to them.
 */
export function goad(
  state: GameState, ids: readonly string[], source: string, controller: SeatIndex,
): GameState {
  return pump(state, ids, source, controller, {
    mustAttack: true,
    mustAttackAnotherPlayer: true,
    duration: 'until-controllers-next-turn',
  });
}

/**
 * "Prevent all combat damage that would be dealt this turn" — a Fog, and the one-creature version.
 *
 * `ids` names the creatures whose combat damage is prevented; leaving it out covers every creature
 * on the table, which is what a Fog does and is symmetrical on purpose: it stops the swing coming
 * back as well as the swing going out.
 */
export function preventCombatDamage(
  state: GameState, source: string, controller: SeatIndex, ids?: readonly string[],
): GameState {
  return pushEffect(state, {
    source,
    controller,
    scope: ids === undefined ? { kind: 'all-creatures' } : { kind: 'cards', ids: [...ids] },
    preventsCombatDamage: true,
    duration: 'end-of-turn',
  });
}

/** "Creatures you control get +3/+3 and gain trample until end of turn." */
export function pumpTeam(
  state: GameState, source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'controller-creatures' },
    ...modsFrom(opts),
    duration: opts.duration ?? 'end-of-turn',
  });
}

/**
 * "All creatures get -1/-1 until end of turn", and anything else that hits the whole board.
 *
 * Symmetrical on purpose: the scope is every creature, including the caster's own, which is what
 * makes a card like this a decision rather than a removal spell.
 */
export function pumpAll(
  state: GameState, source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'all-creatures' },
    ...modsFrom(opts),
    duration: opts.duration ?? 'end-of-turn',
  });
}

/** A permanent's own static effect, which lasts as long as it is on the battlefield. */
export function staticEffect(
  state: GameState, source: string, controller: SeatIndex,
  scope: ContinuousEffect['scope'], opts: PumpOptions,
): GameState {
  return pushEffect(state, { source, controller, scope, ...modsFrom(opts), duration: 'permanent' });
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

/** The cards chosen in answer to one of the questions this spell asked, by index. */
export const chosenCards = (ctx: EffectContext, index = 0): readonly string[] =>
  ctx.decisions[index]?.ids ?? [];

/** The one card chosen in answer to a question, or null — a search that found nothing is legal. */
export const chosenCard = (ctx: EffectContext, index = 0): string | null =>
  ctx.decisions[index]?.ids[0] ?? null;

/** Puts chosen cards into a hand, which is what a tutor does. */
export function moveToHand(state: GameState, ids: readonly string[]): GameState {
  let next = state;
  for (const id of ids) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    next = relocate(next, inst, 'hand', inst.owner, 'bottom');
  }
  return next;
}

/** Puts chosen cards into their owner's graveyard: a discard, or a sacrifice. */
export function moveToGraveyard(state: GameState, ids: readonly string[]): GameState {
  let next = state;
  for (const id of ids) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
  }
  return next;
}

/** The instance a spell or ability came from, if it still exists. */
export const sourceOf = (ctx: EffectContext) => ctx.state.instances[ctx.source];

export { requireInstance, listAt, withInstance, relocate };
