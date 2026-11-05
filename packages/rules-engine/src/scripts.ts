/**
 * Card scripts: the registry of what each card actually does.
 *
 * Every card in both starter decks is here. Adding another is a few lines, and anything not here
 * still functions as cardboard — castable, a permanent if it is one, with its printed keywords read
 * from its text — it simply has no automated effect, and the log says so.
 *
 * A card may ask a question while it resolves — search a library, discard a card of your choice,
 * sacrifice a creature — by declaring `decisions`. The engine stops, asks, and hands the answers to
 * the effect. See `DecisionSpec`, and note that this is a different thing from a target in every
 * respect: asked later, sometimes of somebody else, sometimes about a hidden zone, and never
 * answerable by an opponent.
 *
 * What is still **not** scriptable with this vocabulary, stated so nobody discovers it by surprise:
 * modal spells ("choose one"), copy effects, characteristic-setting effects, and replacement
 * effects. A modal spell is the near miss — the mode is a decision, but the mode decides what the
 * spell *targets*, and targets are chosen before any of this runs. A card like that should be left
 * unscripted and resolved by hand rather than approximated.
 */
import {
  characteristicsOf, hasSubtype, hasType, isKeyword, isLegendary, parseTypeLine, printedKeywords,
  printedLandwalk, type TypeLine,
} from './characteristics.js';
import { zoneKey, type CardDef } from './cards.js';
import { listAt } from './cardActions.js';
import {
  addCounters, addToPool, battlefield, bounceToHand, cardTargets, chosenCard, chosenCards, counterSpell, createToken,
  dealDamage, destroy, discardAtRandom, draw, drawLater, exileCard, firstCardTarget,
  firstPlayerTarget,
  chosenOption, firstAbilityTarget, dividedAmong, copyAbilityOnStack, copySpellOnStack,
  allowExtraLand, echoSettled, proliferate,
  gainControl, gainLife, goad, loseLife, mill, moveToGraveyard, moveToHand, opponentsOf, pump,
  pumpTeam,
  putOntoBattlefield, tap, equipTo, creaturesControlledBy, pumpAll, regenerate,
  exileUntilLeaves, returnExiledBy, preventCombatDamage, preventDamage, preventDamageToSide,
  copyAsToken,
  becomeMonarch, freezeNextUntap, removeFromCombat, scheduleDelayed, EVOKED, UNEARTHED, RENOWNED,
  becomeCopyOf, wardAsks, staticEffect, manaValueOnStack, cascadeFrom,
  addEnergy, energyOf, spendEnergy, bottomPile, reboundOffer, FADE, TIME, enterAttacking,
  transformPermanent, recordExpiry, pairCreatures,
  type EffectContext, type PumpOptions,
} from './effects.js';
import type {
  AbilityCost, AbilityDef, CardScript, CardsDecisionSpec, ChoiceDecisionSpec,
  CountersDecisionSpec, DecisionSpecOf, ModalDef, ModeDef, NumberDecisionSpec, TargetDecisionSpec,
  TargetSpec, TriggerDef,
} from './scriptTypes.js';
// The compiler's shared `ReadEffect` stores an effect under one name for both the trigger path and
// the spell path, so it needs the function type both fields have.
import type { EffectFn } from './effects.js';
/*
  One reader of `Morph {2}`, `Megamorph {4}{G}` and `Echo {1}{R}`, shared with the whole-card path
  rather than written twice. `keywordScriptFor`'s docblock used to list those three as deliberately
  absent *because* `fromCardData` already read them and two readers of one line is two places for
  them to disagree. Importing the reader is the third option: one parse, two call sites.

  No cycle: `fromCardData.ts` imports `cards`, `characteristics`, `effects`, `mana` and the script
  types, and none of them is this file.
*/
import { keywordWithCost } from './fromCardData.js';
import { parseManaCost, timesCost } from './mana.js';
import type { Color, ManaType } from './mana.js';
import type { Keyword } from './characteristics.js';
import type { GameState, SeatIndex } from './types.js';
import { legalTargets, retarget } from './targeting.js';
import { targetKey, type StackObject, type Target } from './turnTypes.js';

/**
 * The biggest toughness on the battlefield, which is where a sweeper's useful range stops.
 *
 * Used by Toxic Deluge to decide how many numbers are worth offering: a -X/-X bigger than anything
 * on the table kills exactly what the one below it did and costs more life.
 */
function biggestToughness(state: GameState): number {
  let biggest = 0;
  for (const id of battlefield(state)) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (ch.isCreature && ch.toughness > biggest) biggest = ch.toughness;
  }
  return biggest;
}

// ── Target specs used by more than one card ──────────────────────────────────────────────────────

/** The five colours, for a card that offers one of each. */
const COLOURS = ['W', 'U', 'B', 'R', 'G'] as const;

const ANY_TARGET: TargetSpec = { kind: 'any', description: 'any target' };
/**
 * "Target player or planeswalker": `any target` with the creatures taken out.
 *
 * The two burn spells that print it carried `TARGET_PLAYER` until now, which could not be pointed
 * at a planeswalker at all — and the pool has four. See `TargetSpec.kind` for why the difference is
 * a kind rather than a filter.
 */
const TARGET_PLAYER_OR_PLANESWALKER: TargetSpec = {
  kind: 'player-or-planeswalker', description: 'target player or planeswalker',
};
/** The same spec on a card that *helps* what it points at. See `TargetSpec.friendly`. */
const ANY_TARGET_HELPED: TargetSpec = { kind: 'any', description: 'any target', friendly: true };
const TARGET_CREATURE: TargetSpec = { kind: 'creature', description: 'target creature' };
/**
 * The same spec on a card that **helps** what it points at. See `TargetSpec.friendly`.
 *
 * Eight spells and three Auras use it, and before D252 none of them did: the bot's default is "the
 * enemy and the enemy's creatures", which is right for the removal and the burn that are most of
 * what targets anything in this pool and exactly backwards for a pump. The hint had existed since
 * the prevention shields and was carried by seven specs; the pump spells were named as the gap in
 * `chooseTargets`' own docblock and left, and `granted-abilities` found what that cost: an Ophidian
 * Eye enchanting the *opponent's* creature, so the opponent drew the cards.
 */
const TARGET_CREATURE_HELPED: TargetSpec = {
  kind: 'creature', description: 'target creature', friendly: true,
};

/**
 * And the same spec for a bonus that is only paid off by an **attack**: see
 * `TargetSpec.helpsInCombat`.
 *
 * Three spells rather than all eight, and the line between them is what the card is for. A Giant
 * Growth pumps a blocker to win a fight as often as it pumps an attacker, and a Wall is sometimes
 * exactly the right answer; "can't be blocked", infect damage and haste are worth nothing at all on
 * a creature that is never going to attack.
 */
const TARGET_ATTACKER_HELPED: TargetSpec = {
  ...TARGET_CREATURE_HELPED, helpsInCombat: true,
};
/**
 * A permanent of one of these types, read **live** (CR 613).
 *
 * Defined up here rather than beside `targetSpecFrom` because the cards need it too: a module-level
 * card builds its `targets` array as this file is evaluated, so a filter it calls has to exist by
 * then. Golgari Charm's enchantment mode was the one that moved it — see its own comment.
 *
 * `characteristicsOf` and not the printed type line, which is the whole of D385: a permanent that
 * *is* an artifact because a continuous effect made it one is a legal target for a Disenchant, and
 * five hand-written filters used to disagree.
 */
const permanentOfTypes = (
  ...types: readonly string[]
): NonNullable<TargetSpec['filter']> => (state, candidate) => {
  if (candidate.kind !== 'card') return false;
  const inst = state.instances[candidate.id];
  if (inst === undefined) return false;
  const line = characteristicsOf(state, inst).typeLine;
  return types.some((type) => hasType(line, type));
};

/**
 * A creature that is attacking or blocking right now — Divine Verdict's phrase, and the only filter
 * in this file that reads the combat rather than the board.
 *
 * Shared with `targetSpecFrom` for the reason `isCreatureSpell` is: one function, so the compiled
 * card and the hand-written one point at the same object instead of two readings of one sentence.
 */
const attackingOrBlocking: NonNullable<TargetSpec['filter']> = (state, candidate) => {
  if (candidate.kind !== 'card') return false;
  return state.combat.attacks.some(
    (a) => a.attacker === candidate.id || a.blockers.includes(candidate.id),
  );
};

const TARGET_PLAYER: TargetSpec = { kind: 'player', description: 'target player' };

const creatureYouControl = (state: GameState, candidate: Target, controller: SeatIndex): boolean =>
  candidate.kind === 'card' && state.instances[candidate.id]?.zoneSeat === controller;

const creatureYouDontControl = (state: GameState, candidate: Target, controller: SeatIndex): boolean =>
  candidate.kind === 'card' && state.instances[candidate.id]?.zoneSeat !== controller;

// ── Tokens ───────────────────────────────────────────────────────────────────────────────────────

export const GOBLIN_TOKEN: CardDef = {
  name: 'Goblin', typeLine: 'Token Creature — Goblin', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: '', colors: ['R'],
};

// ── Lands ────────────────────────────────────────────────────────────────────────────────────────

const basicLand = (name: string, type: 'W' | 'U' | 'B' | 'R' | 'G'): CardScript => ({
  name,
  abilities: [{ cost: { tap: true }, description: `{T}: Add {${type}}.`, produces: [type] }],
});

/**
 * A Guildgate: one mana of either colour, and it comes in tapped.
 *
 * Two abilities rather than one producing both, because tapping it pays once — `manaSources`
 * collapses several free tap-for-mana abilities on one permanent into a single source that makes
 * *one of* its colours, which is the difference between a dual land and a Sol Ring. A single
 * ability listing both would be two mana off one land, and the engine would offer two-drops that
 * cannot be cast.
 */
/**
 * A cycling land: taps for one colour, comes in tapped, and can be thrown away for a card.
 *
 * The first ability in the pool that is used from the **hand** — `discardSelf` in the cost says so,
 * and `legalActions` offers it only while the card is there, the way `{T}: Add {B}` is offered only
 * while it is on the battlefield. Which is the whole card: a land that is never a dead draw,
 * because the late-game version of it is a cantrip.
 */
const cyclingLand = (name: string, type: 'W' | 'U' | 'B' | 'R' | 'G'): CardScript => ({
  name,
  entersTapped: true,
  abilities: [
    { cost: { tap: true }, description: `{T}: Add {${type}}.`, produces: [type] },
    {
      cost: { mana: '{2}', discardSelf: true },
      description: 'Cycling {2} ({2}, Discard this card: Draw a card.)',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
  ],
});

const guildgate = (name: string, a: 'W' | 'U' | 'B' | 'R' | 'G', b: 'W' | 'U' | 'B' | 'R' | 'G'): CardScript => ({
  name,
  entersTapped: true,
  abilities: [
    { cost: { tap: true }, description: `{T}: Add {${a}}.`, produces: [a] },
    { cost: { tap: true }, description: `{T}: Add {${b}}.`, produces: [b] },
  ],
});

// ── Mono-red ─────────────────────────────────────────────────────────────────────────────────────

const MONASTERY_SWIFTSPEAR: CardScript = {
  name: 'Monastery Swiftspear',
  keywords: ['haste', 'prowess'],
  triggers: [
    {
      // Prowess. The trigger fires on cast, not on resolution, which is why it pumps even when the
      // spell is countered.
      on: { kind: 'spell-cast', by: 'you', spell: 'noncreature' },
      description: 'Prowess — +1/+1 until end of turn',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 1, toughness: 1 }),
    },
  ],
};

const RAGING_GOBLIN: CardScript = { name: 'Raging Goblin', keywords: ['haste'] };

const FIREBRAND_ARCHER: CardScript = {
  name: 'Firebrand Archer',
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'noncreature' },
      description: 'deals 1 damage to each opponent',
      effect: (c) =>
        opponentsOf(c.state, c.controller).reduce(
          (state, seat) => dealDamage(state, { kind: 'player', seat }, 1, { controller: c.controller, source: c.source }),
          c.state,
        ),
    },
  ],
};

const SHIVAN_DRAGON: CardScript = {
  name: 'Shivan Dragon',
  keywords: ['flying'],
  abilities: [
    {
      cost: { mana: '{R}' },
      description: '{R}: Shivan Dragon gets +1/+0 until end of turn.',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 1 }),
    },
  ],
};

const LIGHTNING_BOLT: CardScript = {
  name: 'Lightning Bolt',
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 3),
};

const SHOCK: CardScript = {
  name: 'Shock',
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 2),
};

/**
 * Lava Spike: three to the face, and the card that is only playable because it cannot do more.
 *
 * `damageFirstTarget` rather than a player-only resolution, because the target may now be a
 * planeswalker and damage to one removes that many loyalty counters (CR 120.3c) — which
 * `dealDamage` already does, and a seat-shaped resolution could never reach.
 */
const LAVA_SPIKE: CardScript = {
  name: 'Lava Spike',
  targets: [TARGET_PLAYER_OR_PLANESWALKER],
  onResolve: (c) => damageFirstTarget(c, 3),
};

/**
 * The first card with {X} in its cost, and the simplest shape it comes in.
 *
 * X is chosen as the spell is cast (CR 601.2b) and paid for then, so by the time this runs the
 * number is settled and `c.x` is just a number. Nothing here knows how it was paid for, which is
 * the point: the mana layer took the decision and the card reads like the card.
 */
const FIREBALL: CardScript = {
  name: 'Fireball',
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, c.x),
};

/**
 * Scry, as a question whose answer is "these go to the bottom".
 *
 * The cards kept stay on top in the order they were already in. Real scry also lets you reorder
 * the ones you keep; that needs a question whose answer is a sequence rather than a set, and no
 * card in this pool turns on it. Where the engine stops is written down rather than papered over.
 */
/**
 * An Equipment: one activated ability that moves it onto a creature you control.
 *
 * Equip is sorcery-speed (CR 702.6b) and targets a creature **its controller controls** — not any
 * creature, which is the difference from an Aura and the reason you cannot hand your Warhammer to
 * somebody else's Serra Angel. Written as an ordinary ability rather than as a new kind of card
 * because that is all it is: the engine already has sorcery-speed abilities, targets and
 * continuous effects, and `equipTo` is the one new verb.
 */
/**
 * The equip half of an Equipment, as the fragment of a script it is.
 *
 * Split out of `equipment` below so the oracle-text compiler can build the same ability from
 * printed text rather than a second implementation of it — the same reason `keywordScriptFor` is a
 * table of calls into the builders above it, and the thing that keeps the compiled Bonesplitter and
 * the hand-written one the same card. See `attachmentScriptFor`.
 */
export const equipFragment = (
  cost: string, bonus: PumpOptions, text: string,
): Partial<CardScript> => ({
  // Written down rather than closed over, because Balan needs to read it: a card that moves every
  // Equipment you control onto itself has to know what each of them does, and a bonus that only
  // exists inside its own effect function cannot be asked.
  equipBonus: bonus,
  abilities: [
    {
      cost: { mana: cost },
      sorcerySpeed: true,
      description: `Equip ${cost} — ${text}`,
      targets: [{
        kind: 'creature',
        description: 'creature you control',
        // Not the creature it is already on. Equipping it again is legal and does nothing, and a
        // play that does nothing is a trap for a person and a waste of mana for the bot — which
        // spent three quarters of its equips re-equipping the same creature before this line.
        filter: (state, candidate, controller, source) =>
          creatureYouControl(state, candidate, controller)
          && !(candidate.kind === 'card' && source !== undefined
            && state.instances[source]?.attachedTo === candidate.id),
      }],
      effect: (c) => {
        const host = firstCardTarget(c);
        return host === null ? c.state : equipTo(c.state, c.source, host, c.controller, bonus);
      },
    },
  ],
});

const equipment = (name: string, cost: string, bonus: PumpOptions, text: string): CardScript => ({
  name, ...equipFragment(cost, bonus, text),
});

/**
 * Armory of Iroas: `{2}`, "Whenever equipped creature attacks, put a +1/+1 counter on it." /
 * "Equip {2}".
 *
 * The pool's first card whose trigger watches **the creature it is attached to**, which is the
 * whole reason it is here (D433). An Equipment does not attack and this is not about any other
 * creature, so neither `who: 'self'` nor `who: 'another'` can say it; `who: 'attached'` is the
 * fourth value, and this card is its ground truth. 47 corpus cards print this prologue of an
 * Equipment and 18 of an Aura, and before the value existed every one of them was an unread line.
 *
 * Chosen off the corpus rather than from memory, and its cost and text are the printed ones: D259
 * applies to a hand-written card as much as to a reader, and a card whose equip cost I guessed
 * would be a card that is confidently wrong. Two printed lines and the engine does both.
 *
 * `{}` as the bonus because the card has none — the equip ability moves it and grants nothing,
 * which `equipFragment` already allows and nothing in the pool had yet asked for.
 */
const ARMORY_OF_IROAS: CardScript = {
  name: 'Armory of Iroas',
  ...equipFragment('{2}', {}, 'attach it to a creature you control'),
  triggers: [{
    on: { kind: 'attacks', who: 'attached' },
    description: 'Put a +1/+1 counter on equipped creature',
    /*
      `c.subject` and not `c.source`: the source is the Equipment, and the counter goes on the
      creature. The `attacks` event carries its subject, so this needs no search for what the
      Equipment is on — and reading `attachedTo` here instead would be a second answer to a
      question the event has already answered.
    */
    effect: (c) => (c.subject === undefined ? c.state : addCounters(c.state, c.subject, '+1/+1', 1)),
  }],
};

const scry = (count: number): CardsDecisionSpec => ({
  who: 'controller',
  from: 'library-top',
  look: count,
  prompt: `Scry ${count} — put any of these on the bottom`,
  min: 0,
  max: count,
});

/**
 * Surveil N (CR 701.42): scry's question with the graveyard as the destination (D452).
 *
 * The two keywords are the same decision — look at the top N, pick any number of them — and differ
 * only in where the picked cards go, which is why this is `scry`'s shape plus
 * `CardsDecisionSpec.chosenGoTo` rather than a second mechanism. `min: 0` is what makes "keep them
 * all" a legal answer, and it matters more here than for scry: surveilling into your own graveyard
 * is a cost on some boards and a benefit on others.
 *
 * It is the largest single clause left in the corpus that needed no new machinery: **227 unread
 * legal lines mention surveil and 120 of them are a card's only unread line**, hanging off
 * prologues this compiler already reads — an enters trigger, an attack, a step, an activated
 * ability, or a spell's own resolution.
 */
const surveil = (count: number): CardsDecisionSpec => ({
  who: 'controller',
  from: 'library-top',
  look: count,
  chosenGoTo: 'graveyard',
  prompt: `Surveil ${count} — put any of these into your graveyard`,
  min: 0,
  max: count,
});

/**
 * "Deals 2 damage to any target. Scry 2."
 *
 * The damage is in `beforeDecisions` because the card does it first: by the time the player is
 * looking at the top of their library the creature is already dead, which is the order printed on
 * the card and occasionally the order that matters — what is drawn next is a different decision
 * once the board has changed.
 */
const MAGMA_JET: CardScript = {
  name: 'Magma Jet',
  targets: [ANY_TARGET],
  beforeDecisions: (c) => damageFirstTarget(c, 2),
  decisions: [scry(2)],
};

const FLAME_SLASH: CardScript = {
  name: 'Flame Slash',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : dealDamage(c.state, { kind: 'card', id }, 4, { controller: c.controller, source: c.source });
  },
};

const ACT_OF_TREASON: CardScript = {
  name: 'Act of Treason',
  targets: [{ ...TARGET_CREATURE, filter: creatureYouDontControl }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    if (id === null) return c.state;
    const original = c.state.instances[id]?.zoneSeat;
    if (original === undefined) return c.state;
    let next = gainControl(c.state, id, c.controller);
    next = tap(next, id, false);
    // Haste matters: the whole point is attacking with it this turn, and it has just changed
    // control, so without this it would be summoning sick.
    next = pump(next, [id], c.source, c.controller, { keywords: ['haste'], duration: 'end-of-turn' });
    // The control change itself is temporary; the turn logic reads `controlRevertTo` on expiry.
    const seq = next.autoSeq + 1;
    return {
      ...next,
      autoSeq: seq,
      effects: [...next.effects, {
        id: `fx${seq}`, source: c.source, controller: c.controller,
        scope: { kind: 'cards', ids: [id] }, duration: 'end-of-turn',
        createdTurn: next.turn, controlRevertTo: original,
      }],
    };
  },
};

const FLAMETONGUE_KAVU: CardScript = {
  name: 'Flametongue Kavu',
  triggers: [
    {
      on: { kind: 'etb' },
      // There is always a legal target — itself — which is the card's famous drawback rather than
      // an oversight: played with no other creature out, it kills itself.
      targets: [TARGET_CREATURE],
      description: 'deals 4 damage to target creature',
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : dealDamage(c.state, { kind: 'card', id }, 4, { controller: c.controller, source: c.source });
      },
    },
  ],
};

const MAN_O_WAR: CardScript = {
  name: "Man-o'-War",
  triggers: [
    {
      on: { kind: 'etb' },
      targets: [TARGET_CREATURE],
      description: "return target creature to its owner's hand",
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : bounceToHand(c.state, id);
      },
    },
  ],
};

const KRENKO: CardScript = {
  name: 'Krenko, Mob Boss',
  abilities: [
    {
      cost: { tap: true },
      description: '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.',
      effect: (c) => {
        const goblins = creaturesOfSubtype(c.state, c.controller, 'goblin');
        return goblins === 0 ? c.state : createToken(c.state, c.controller, GOBLIN_TOKEN, goblins);
      },
    },
  ],
};

// ── Green-white ──────────────────────────────────────────────────────────────────────────────────

const LLANOWAR_ELVES: CardScript = {
  name: 'Llanowar Elves',
  abilities: [{ cost: { tap: true }, description: '{T}: Add {G}.', produces: ['G'] }],
};

const AJANIS_PRIDEMATE: CardScript = {
  name: "Ajani's Pridemate",
  triggers: [
    {
      on: { kind: 'life-gained', by: 'you' },
      description: 'put a +1/+1 counter on it',
      effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
    },
  ],
};

const SERRA_ANGEL: CardScript = { name: 'Serra Angel', keywords: ['flying', 'vigilance'] };

const GIANT_GROWTH: CardScript = {
  name: 'Giant Growth',
  // Wears off at end of turn, so it is held for the combat. See `expiresAtEndOfTurn`.
  expiresAtEndOfTurn: true,
  targets: [TARGET_CREATURE_HELPED],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : pump(c.state, [id], c.source, c.controller, { power: 3, toughness: 3 });
  },
};

const PACIFISM: CardScript = {
  name: 'Pacifism',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  aura: {
    target: { kind: 'creature', description: 'enchant creature' },
    effect: { cantAttack: true, cantBlock: true },
  },
};

const SECURE_THE_WASTES: CardScript = {
  name: 'Secure the Wastes',
  // X tokens, at instant speed, which is why it is the one X card worth holding up: the mana is
  // spent at the end of somebody else's turn rather than on your own.
  onResolve: (c) => (c.x === 0 ? c.state : createToken(c.state, c.controller, WARRIOR_TOKEN, c.x)),
};

const SWORDS_TO_PLOWSHARES: CardScript = {
  name: 'Swords to Plowshares',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    if (id === null) return c.state;
    const inst = c.state.instances[id];
    if (inst === undefined) return c.state;
    // Power is read before the creature leaves, because after exiling there is nothing to read.
    const power = Math.max(0, characteristicsOf(c.state, inst).power);
    const owner = inst.zoneSeat;
    return gainLife(exileCard(c.state, id), owner, power);
  },
};

const HARMONIZE: CardScript = {
  name: 'Harmonize',
  onResolve: (c) => drawLater(c.state, c.controller, 3),
};

const OVERRUN: CardScript = {
  name: 'Overrun',
  // Wears off at end of turn, so it is held for the combat. See `expiresAtEndOfTurn`.
  expiresAtEndOfTurn: true,
  onResolve: (c) => pumpTeam(c.state, c.source, c.controller, { power: 3, toughness: 3, keywords: ['trample'] }),
};

const SIGARDA: CardScript = {
  name: 'Sigarda, Host of Herons',
  keywords: ['flying', 'hexproof'],
};

// ── Blue-black control ───────────────────────────────────────────────────────────────────────────

/** A spell on the stack, which is what "counter target spell" points at. */
const TARGET_SPELL: TargetSpec = { kind: 'spell', description: 'target spell' };

const isNoncreatureSpell = (state: GameState, candidate: Target): boolean => {
  if (candidate.kind !== 'card') return false;
  const inst = state.instances[candidate.id];
  if (inst === undefined) return false;
  return !characteristicsOf(state, inst).isCreature;
};

/**
 * The other half of the pair, named rather than inline because the compiler needs the same
 * function.
 *
 * It was written inline on Essence Scatter until the compiler learnt to read "counter target
 * creature spell", and a second copy would have been two filters that could drift apart — one of
 * them reading the live type line and the other the printed one is exactly the class of bug D385
 * found five of. So the card and the compiler now point at one function, which also makes the
 * ground-truth test on the target spec an identity rather than a resemblance.
 */
const isCreatureSpell = (state: GameState, candidate: Target): boolean => {
  if (candidate.kind !== 'card') return false;
  const inst = state.instances[candidate.id];
  return inst !== undefined && characteristicsOf(state, inst).isCreature;
};

const COUNTERSPELL: CardScript = {
  name: 'Counterspell',
  targets: [TARGET_SPELL],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : counterSpell(c.state, id);
  },
};

const NEGATE: CardScript = {
  name: 'Negate',
  targets: [{ ...TARGET_SPELL, description: 'target noncreature spell', filter: isNoncreatureSpell }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : counterSpell(c.state, id);
  },
};

const DOOM_BLADE: CardScript = {
  name: 'Doom Blade',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
};

const DIVINATION: CardScript = {
  name: 'Divination',
  onResolve: (c) => drawLater(c.state, c.controller, 2),
};

const SIGN_IN_BLOOD: CardScript = {
  name: 'Sign in Blood',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    if (seat === null) return c.state;
    // Drawing first matters: a player taken to 0 by the life loss still drew the cards, and a
    // player who had no cards left to draw has already lost either way.
    return loseLife(draw(c.state, seat, 2), seat, 2);
  },
};

const MIND_SPRING: CardScript = {
  name: 'Mind Spring',
  onResolve: (c) => drawLater(c.state, c.controller, c.x),
};

/**
 * Drain, once per opponent — which is a different card at a pod than at a duel.
 *
 * At two players it is X life; at four it is 3X gained against X lost each, and that asymmetry is
 * the card rather than a bug in it. The life gained is the life actually lost, so an opponent
 * already dead or at less than X does not pay what they do not have.
 */
const EXSANGUINATE: CardScript = {
  name: 'Exsanguinate',
  onResolve: (c) => {
    if (c.x === 0) return c.state;
    let state = c.state;
    let drained = 0;
    for (const seat of opponentsOf(state, c.controller)) {
      const before = state.seats[seat]?.life ?? 0;
      state = loseLife(state, seat, c.x);
      drained += before - (state.seats[seat]?.life ?? 0);
    }
    return drained === 0 ? state : gainLife(state, c.controller, drained);
  },
};

const PREORDAIN: CardScript = {
  name: 'Preordain',
  // Scry *then* draw, which is the whole card: the draw sees the library the scry left behind.
  decisions: [scry(1)],
  onResolve: (c) => drawLater(c.state, c.controller, 1),
};

const OMENSPEAKER: CardScript = {
  name: 'Omenspeaker',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'scry 2',
      decisions: [scry(2)],
      effect: (c) => c.state,
    },
  ],
};

const TOME_SCOUR: CardScript = {
  name: 'Tome Scour',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return seat === null ? c.state : mill(c.state, seat, 5);
  },
};

const RAVENOUS_RATS: CardScript = {
  name: 'Ravenous Rats',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'each opponent discards a card at random',
      effect: (c) =>
        opponentsOf(c.state, c.controller).reduce((state, seat) => discardAtRandom(state, seat, 1), c.state),
    },
  ],
};

const CHILD_OF_NIGHT: CardScript = { name: 'Child of Night', keywords: ['lifelink'] };
const WIND_DRAKE: CardScript = { name: 'Wind Drake', keywords: ['flying'] };
const VAMPIRE_NIGHTHAWK: CardScript = {
  name: 'Vampire Nighthawk',
  keywords: ['flying', 'deathtouch', 'lifelink'],
};
const AIR_ELEMENTAL: CardScript = { name: 'Air Elemental', keywords: ['flying'] };

export const DRAKE_TOKEN: CardDef = {
  name: 'Drake', typeLine: 'Token Creature — Drake', manaCost: '', cmc: 0,
  power: '2', toughness: '2', oracleText: 'Flying', colors: ['U'],
};

const TALRAND: CardScript = {
  name: 'Talrand, Sky Summoner',
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
      description: 'create a 2/2 blue Drake creature token with flying',
      effect: (c) => createToken(c.state, c.controller, DRAKE_TOKEN, 1),
    },
  ],
};

// ── Green-black graveyard ────────────────────────────────────────────────────────────────────────

/** A creature card sitting in your own graveyard, which is a different object from a creature. */
const yourGraveyardCreature: TargetSpec = {
  kind: 'graveyard-creature',
  description: 'target creature card in your graveyard',
  filter: (state, candidate, controller) =>
    candidate.kind === 'card' && state.instances[candidate.id]?.zoneSeat === controller,
};

/**
 * The same object one type over: a land card in your own graveyard.
 *
 * Written inline on Grim Discovery until the compiler learnt to read "return target land card from
 * your graveyard to your hand", and shared for the reason `isCreatureSpell` is shared — one filter
 * rather than two that can drift, and a ground-truth test that compares the real function instead of
 * a lookalike.
 */
const yourGraveyardLand: TargetSpec = {
  kind: 'graveyard-land',
  description: 'target land card in your graveyard',
  filter: (state, candidate, controller) =>
    candidate.kind === 'card' && state.instances[candidate.id]?.zoneSeat === controller,
};

const GRAVEDIGGER: CardScript = {
  name: 'Gravedigger',
  triggers: [
    {
      on: { kind: 'etb' },
      targets: [yourGraveyardCreature],
      description: 'return target creature card from your graveyard to your hand',
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : bounceToHand(c.state, id);
      },
    },
  ],
};

const RAISE_DEAD: CardScript = {
  name: 'Raise Dead',
  targets: [yourGraveyardCreature],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : bounceToHand(c.state, id);
  },
};

const ZOMBIFY: CardScript = {
  name: 'Zombify',
  targets: [yourGraveyardCreature],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    // Onto *your* battlefield, which is the whole point: it comes back under your control.
    return id === null ? c.state : putOntoBattlefield(c.state, id, c.controller);
  },
};

const THORNWEALD_ARCHER: CardScript = { name: 'Thornweald Archer', keywords: ['reach', 'deathtouch'] };

const WALL_OF_BLOSSOMS: CardScript = {
  name: 'Wall of Blossoms',
  keywords: ['defender'],
  triggers: [{ on: { kind: 'etb' }, description: 'draw a card', effect: (c) => draw(c.state, c.controller, 1) }],
};

/**
 * The one X spell that hits its own caster, which is what makes it a card rather than a bigger
 * Fireball: a deck of ground creatures pays nothing for it and a table of fliers pays everything.
 *
 * Every player, not every opponent — including the one casting it, who can kill themselves with
 * it. The creatures are read at resolution, so a flier that arrived while this was on the stack
 * is hit and one that left is not.
 */
const HURRICANE: CardScript = {
  name: 'Hurricane',
  onResolve: (c) => {
    if (c.x === 0) return c.state;
    let state = c.state;
    for (const id of battlefield(state, (cardId) => {
      const inst = state.instances[cardId];
      if (inst === undefined) return false;
      const ch = characteristicsOf(state, inst);
      return ch.isCreature && ch.keywords.has('flying');
    })) {
      state = dealDamage(state, { kind: 'card', id }, c.x, { controller: c.controller, source: c.source });
    }
    for (const seat of state.seats) {
      if (seat.eliminated) continue;
      state = dealDamage(state, { kind: 'player', seat: seat.index }, c.x, { controller: c.controller, source: c.source });
    }
    return state;
  },
};

// ── Planeswalkers ────────────────────────────────────────────────────────────────────────────────

/**
 * The last card type, and the one that needed rules rather than vocabulary.
 *
 * A loyalty cost carries three restrictions with it — sorcery speed, once per turn per
 * planeswalker, and a minus you can pay for — so a script writes `+2` or `-1` and gets them. The
 * printed loyalty is read off the card when it arrives, and zero loyalty puts it in the graveyard
 * (CR 704.5i), neither of which a script has to say.
 */
const JACE_BELEREN: CardScript = {
  name: 'Jace Beleren',
  abilities: [
    {
      cost: { loyalty: 2 },
      description: '+2: Each player draws a card.',
      // Symmetrical, including the opponent — which is the card, and the reason it is not simply
      // a better Divination.
      effect: (c) => c.state.seats.reduce(
        (state, seat) => (seat.eliminated ? state : draw(state, seat.index, 1)),
        c.state,
      ),
    },
    {
      cost: { loyalty: -1 },
      description: '−1: You draw a card.',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
    {
      cost: { loyalty: -10 },
      description: '−10: Target player mills twenty cards.',
      targets: [TARGET_PLAYER],
      effect: (c) => {
        const seat = firstPlayerTarget(c);
        return seat === null ? c.state : mill(c.state, seat, 20);
      },
    },
  ],
};

const GARRUK_WILDSPEAKER: CardScript = {
  name: 'Garruk Wildspeaker',
  abilities: [
    {
      cost: { loyalty: 1 },
      description: '+1: Untap two target lands.',
      /*
        The live type line, not the printed one — the seventh site of #319's class, found the same
        way as the sixth: by giving this line a compiler reading and needing the two specs to match.
        A Mutavault animated into a creature is still a land and is still a legal target here
        (CR 613), which `parseTypeLine` on the card definition could not see.
      */
      targets: [{
        kind: 'permanent',
        description: 'target land',
        count: 2,
        /*
          `friendly`, which here is **not** redundant and is a correction (D419). The card says
          "target lands" with no "you control", so the filter admits an opponent's — and untapping
          an opponent's land is a card thrown away. The flag is the bot's ordering hint, so without
          it the default aim is the enemy's board, which is the wrong half of this ability.

          Found by `compiled-vs-written.test.ts`: the compiled reading carried it and this did not.
        */
        friendly: true,
        filter: permanentOfTypes('land'),
      }],
      effect: (c) => cardTargets(c).reduce((state, id) => tap(state, id, false), c.state),
    },
    {
      cost: { loyalty: -1 },
      description: '−1: Create a 3/3 green Beast creature token.',
      effect: (c) => createToken(c.state, c.controller, BEAST_TOKEN, 1),
    },
    {
      cost: { loyalty: -4 },
      description: '−4: Creatures you control get +3/+3 and gain trample until end of turn.',
      effect: (c) => pumpTeam(c.state, c.source, c.controller, {
        power: 3, toughness: 3, keywords: ['trample'],
      }),
    },
  ],
};

// ── Red-white equipment ──────────────────────────────────────────────────────────────────────────

const LEONIN_SKYHUNTER: CardScript = { name: 'Leonin Skyhunter', keywords: ['flying'] };

const RAISE_THE_ALARM: CardScript = {
  name: 'Raise the Alarm',
  onResolve: (c) => createToken(c.state, c.controller, SOLDIER_TOKEN, 2),
};

/**
 * An Aura that does two things, which is why it is here rather than beside Pacifism: the flying
 * is the aura's continuous effect and the card is the trigger on it entering.
 */
const ANGELIC_GIFT: CardScript = {
  name: 'Angelic Gift',
  aura: {
    // A bonus, so the bot aims it at its own side. See `TargetSpec.friendly`.
    target: { kind: 'creature', description: 'enchant creature', friendly: true },
    effect: { keywords: ['flying'] },
  },
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'draw a card',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
  ],
};

const INSPIRED_CHARGE: CardScript = {
  name: 'Inspired Charge',
  // Wears off at end of turn, so it is held for the combat. See `expiresAtEndOfTurn`.
  expiresAtEndOfTurn: true,
  onResolve: (c) => pumpTeam(c.state, c.source, c.controller, { power: 2, toughness: 1 }),
};

/**
 * The commander that reads other cards.
 *
 * "Attach all Equipment you control to Balan" is one activation and an arbitrary number of
 * attachments, each with a bonus that belongs to the Equipment rather than to this card — so this
 * is the first script that looks another script up and uses what it finds. Equipment already on
 * Balan is left where it is, which `equipTo` would do anyway.
 */
const BALAN: CardScript = {
  name: 'Balan, Wandering Knight',
  keywords: ['double strike'],
  abilities: [
    {
      cost: { mana: '{1}{W}' },
      description: '{1}{W}: Attach all Equipment you control to Balan.',
      effect: (c) => {
        let state = c.state;
        for (const id of battlefield(state, (cardId) => state.instances[cardId]?.zoneSeat === c.controller)) {
          const def = state.cardDefs[state.instances[id]?.defKey ?? ''];
          if (!hasSubtype(parseTypeLine(def?.typeLine), 'equipment')) continue;
          const bonus = scriptFor(def?.name)?.equipBonus;
          if (bonus === undefined) continue;
          state = equipTo(state, id, c.source, c.controller, bonus);
        }
        return state;
      },
    },
  ],
};

const DRUDGE_SKELETONS: CardScript = {
  name: 'Drudge Skeletons',
  abilities: [
    {
      cost: { mana: '{B}' },
      description: '{B}: Regenerate Drudge Skeletons.',
      effect: (c) => regenerate(c.state, c.source),
    },
  ],
};

/**
 * The card that was not scriptable, and the reason this engine now has replacement effects.
 *
 * Both checkpoints named Golgari Charm as the honest limit: a modal card with one unscriptable
 * mode is an unscriptable card, and the mode was "regenerate each creature you control". With a
 * regeneration shield it is three ordinary modes, and the first is still the interesting one — it
 * hits *all* creatures, the caster's included, which is what makes it a decision.
 */
const GOLGARI_CHARM: CardScript = {
  modal: {
    modes: [
      {
        description: 'All creatures get -1/-1 until end of turn',
        effect: (c) => pumpAll(c.state, c.source, c.controller, { power: -1, toughness: -1 }),
      },
      {
        description: 'Destroy target enchantment',
        /*
          The live type line, not the printed one — the sixth site of #319's class, found while
          giving this mode a compiler reading. A permanent that *is* an enchantment because
          something made it one is a legal target for this mode, and `parseTypeLine` on the card
          definition could not see that. `permanentOfTypes` is the shared filter the other
          enchantment phrases already use, which is also what makes the ground-truth test an
          identity.
        */
        targets: [{
          kind: 'permanent',
          description: 'target enchantment',
          filter: permanentOfTypes('enchantment'),
        }],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : destroy(c.state, id);
        },
      },
      {
        description: 'Regenerate each creature you control',
        effect: (c) => creaturesControlledBy(c.state, c.controller)
          .reduce((state, id) => regenerate(state, id), c.state),
      },
    ],
  },
  name: 'Golgari Charm',
};

/**
 * A creature that is as big as the mana poured into it.
 *
 * The counters are a replacement effect on the way in (CR 614.1c), not a trigger, which is why it
 * is a 0/0 that never dies: it is already a 4/4 by the time anything looks at it. Reanimate one
 * and it enters with no counters at all and goes straight back to the graveyard, which is the
 * rule working rather than the engine failing.
 */
const ENDLESS_ONE: CardScript = {
  name: 'Endless One',
  entersWith: { counter: '+1/+1', amount: 'x' },
};

const LOTLETH_GIANT: CardScript = {
  name: 'Lotleth Giant',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'each opponent loses 1 life for each creature card in your graveyard',
      effect: (c) => {
        const bodies = creatureCardsInGraveyard(c.state, c.controller);
        return opponentsOf(c.state, c.controller).reduce((state, seat) => loseLife(state, seat, bodies), c.state);
      },
    },
  ],
};

/**
 * The sacrifice outlets. The cost is paid as the ability is activated, so the creature is already
 * in the graveyard by the time anybody could respond — which is the whole reason it is a cost and
 * not a target.
 */
const VAMPIRE_ARISTOCRAT: CardScript = {
  name: 'Vampire Aristocrat',
  abilities: [
    {
      cost: { sacrifice: 'creature' },
      description: 'Sacrifice a creature: +2/+2 until end of turn.',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 2, toughness: 2 }),
    },
  ],
};

const BLOODTHRONE_VAMPIRE: CardScript = {
  name: 'Bloodthrone Vampire',
  abilities: [
    {
      // "Another" creature: it cannot eat itself, which is the difference from the Aristocrat.
      cost: { sacrifice: 'another-creature' },
      description: 'Sacrifice another creature: +2/+2 until end of turn.',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 2, toughness: 2 }),
    },
  ],
};

export const SPIRIT_TOKEN: CardDef = {
  name: 'Spirit', typeLine: 'Token Creature — Spirit', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: 'Flying', colors: ['W'],
};

export const ZOMBIE_TOKEN: CardDef = {
  name: 'Zombie', typeLine: 'Token Creature — Zombie', manaCost: '', cmc: 0,
  power: '2', toughness: '2', oracleText: '', colors: ['B'],
};

/** Hangarback Walker's parting gift: a 1/1 flier per counter it had. */
/*
  Chasm Skulker's Squid, declared up here with the other tokens rather than beside its own script.

  `TOKEN_DEFS` is built a few hundred lines below this and a `const` is only in scope after its own
  line, so a token defined beside the card that makes it is a token the list cannot name — which is
  an error at import rather than a test failure. The script that gives it islandwalk stays with
  Chasm Skulker, because that is where the reason for it is written down.
*/
export const SQUID_TOKEN: CardDef = {
  name: 'Squid', typeLine: 'Token Creature — Squid', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: 'Islandwalk', colors: ['U'],
};

export const GOAT_TOKEN: CardDef = {
  name: 'Goat', typeLine: 'Token Creature — Goat', manaCost: '', cmc: 0,
  power: '0', toughness: '1', oracleText: '', colors: ['W'],
};

export const THOPTER_TOKEN: CardDef = {
  name: 'Thopter', typeLine: 'Token Artifact Creature — Thopter', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: 'Flying', colors: [],
};

/*
  Treasure and Clue, the two tokens in this pool that are **resources rather than bodies**.

  Every other token here is a creature: it attacks, blocks, dies. These are artifacts whose whole
  text is an ability that eats them, and between them they cover the two halves of that shape —
  one spends itself for mana, the other spends itself for a card.

  **The Clue needed nothing.** `{2}, Sacrifice this artifact: Draw a card` is Mind Stone's second
  row with a different cost, and `AbilityCost.sacrificeSelf` has been paid at activation since
  that card was written. It is in here as the control: if the Clue works and the Treasure does not,
  the fault is in the mana path and nowhere else.

  **The Treasure needed a rule.** `manaSources` refused any mana ability that sacrificed its own
  permanent, so before this a Treasure was a token the engine could create and never spend: the
  auto-tapper would not count it, `canAfford` would say no, and the spell it was made for would sit
  in hand beside it with nothing in the log to say why. See `ManaSource.sacrifices`.

  Five abilities and one sacrifice, which is Birds of Paradise's shape (`manaSources` collapses
  them into one source that makes one of five colours) with the tap replaced by the card itself.
*/
export const TREASURE_TOKEN: CardDef = {
  name: 'Treasure', typeLine: 'Token Artifact — Treasure', manaCost: '', cmc: 0,
  oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.', colors: [],
};

export const CLUE_TOKEN: CardDef = {
  name: 'Clue', typeLine: 'Token Artifact — Clue', manaCost: '', cmc: 0,
  oracleText: '{2}, Sacrifice this artifact: Draw a card.', colors: [],
};

export const KNIGHT_TOKEN: CardDef = {
  name: 'Knight', typeLine: 'Token Creature — Knight', manaCost: '', cmc: 0,
  power: '2', toughness: '2', oracleText: 'Vigilance', colors: ['W'],
};

/** The Birth of Meletis' first chapter, and the pool's first 0/4. */
export const WALL_TOKEN: CardDef = {
  name: 'Wall', typeLine: 'Token Creature — Wall', manaCost: '', cmc: 0,
  power: '0', toughness: '4', oracleText: 'Defender', colors: ['W'],
};

export const BEAST_TOKEN: CardDef = {
  name: 'Beast', typeLine: 'Token Creature — Beast', manaCost: '', cmc: 0,
  power: '3', toughness: '3', oracleText: '', colors: ['G'],
};

/** Battery's half of the split card, and the only 3/3 in the pool that is not a Beast. */
export const ELEPHANT_TOKEN: CardDef = {
  name: 'Elephant', typeLine: 'Token Creature — Elephant', manaCost: '', cmc: 0,
  power: '3', toughness: '3', oracleText: '', colors: ['G'],
};

export const SOLDIER_TOKEN: CardDef = {
  name: 'Soldier', typeLine: 'Token Creature — Soldier', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: '', colors: ['W'],
};

export const WARRIOR_TOKEN: CardDef = {
  name: 'Warrior', typeLine: 'Token Creature — Warrior', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: '', colors: ['W'],
};

export const INSECT_TOKEN: CardDef = {
  name: 'Insect', typeLine: 'Token Creature — Insect', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: '', colors: ['B', 'G'],
};

const IZONI: CardScript = {
  name: 'Izoni, Thousand-Eyed',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'create an Insect for each creature card in your graveyard',
      effect: (c) => {
        const bodies = creatureCardsInGraveyard(c.state, c.controller);
        return bodies === 0 ? c.state : createToken(c.state, c.controller, INSECT_TOKEN, bodies);
      },
    },
  ],
  abilities: [
    {
      // The ability this deck was built around, and the one it shipped without: paying a cost by
      // sacrificing a creature the player chooses now exists, so it is scripted rather than
      // printed in prose with "Move by hand" underneath it.
      cost: { mana: '{B}{G}', sacrifice: 'another-creature' },
      description: '{B}{G}, Sacrifice another creature: You gain 1 life and draw a card.',
      effect: (c) => draw(gainLife(c.state, c.controller, 1), c.controller, 1),
    },
  ],
};

// ── Watching the board rather than itself ────────────────────────────────────────────────────────

/**
 * "Whenever ~ or another creature dies", and the three cards shaped like it.
 *
 * These were the family the engine could not express: `dies` and `etb` only ever reached the
 * permanent the event happened to, so a card that watches the *board* had nothing to watch with.
 * `who` says which — `self` (the default, and what every other script means), `another`, or `any`
 * for the "~ or another" templating — and `of` narrows it to a controller.
 *
 * They are also the cards that make a sacrifice deck a deck rather than a pile: Fleshbag Marauder
 * with a Blood Artist out is a drain, and Doomed Dissenter dying twice over is two.
 */
const BLOOD_ARTIST: CardScript = {
  name: 'Blood Artist',
  triggers: [
    {
      on: { kind: 'dies', who: 'any', what: 'creature' },
      targets: [TARGET_PLAYER],
      description: 'target player loses 1 life and you gain 1 life',
      effect: (c) => {
        const seat = firstPlayerTarget(c);
        if (seat === null) return c.state;
        return gainLife(loseLife(c.state, seat, 1), c.controller, 1);
      },
    },
  ],
};

const ZULAPORT_CUTTHROAT: CardScript = {
  name: 'Zulaport Cutthroat',
  triggers: [
    {
      // Only its controller's creatures, which is the difference from Blood Artist — and the
      // reason it needs no target: "each opponent" is not a choice.
      on: { kind: 'dies', who: 'any', of: 'you', what: 'creature' },
      description: 'each opponent loses 1 life and you gain 1 life',
      effect: (c) => gainLife(
        opponentsOf(c.state, c.controller).reduce((state, seat) => loseLife(state, seat, 1), c.state),
        c.controller,
        1,
      ),
    },
  ],
};

const SOUL_WARDEN: CardScript = {
  name: 'Soul Warden',
  triggers: [
    {
      // "Another" and not "any": a Soul Warden does not gain you life for itself.
      on: { kind: 'etb', who: 'another', of: 'any', what: 'creature' },
      description: 'you gain 1 life',
      effect: (c) => gainLife(c.state, c.controller, 1),
    },
  ],
};

const IMPACT_TREMORS: CardScript = {
  name: 'Impact Tremors',
  triggers: [
    {
      on: { kind: 'etb', who: 'any', of: 'you', what: 'creature' },
      description: 'deals 1 damage to each opponent',
      effect: (c) => opponentsOf(c.state, c.controller).reduce(
        (state, seat) => dealDamage(state, { kind: 'player', seat }, 1, { controller: c.controller, source: c.source }),
        c.state,
      ),
    },
  ],
};

// ── Dying, upkeep, and a static effect: the engine paths no card reached ─────────────────────────

/**
 * A `dies` trigger fires from the graveyard, for the creature that died.
 *
 * These three are the self-only shape, which is most of them and the default: a trigger that says
 * nothing about `who` watches its own permanent and nothing else. See `BLOOD_ARTIST` above for the
 * shape that watches the board.
 */
const DOOMED_TRAVELER: CardScript = {
  name: 'Doomed Traveler',
  triggers: [
    {
      on: { kind: 'dies' },
      description: 'create a 1/1 white Spirit creature token with flying',
      effect: (c) => createToken(c.state, c.controller, SPIRIT_TOKEN, 1),
    },
  ],
};

const DOOMED_DISSENTER: CardScript = {
  name: 'Doomed Dissenter',
  triggers: [
    {
      on: { kind: 'dies' },
      description: 'create a 2/2 black Zombie creature token',
      effect: (c) => createToken(c.state, c.controller, ZOMBIE_TOKEN, 1),
    },
  ],
};

/**
 * A `dies` trigger that has to be aimed, which is the two mechanisms together.
 *
 * The creature is already in the graveyard when its trigger goes on the stack, and the trigger
 * still asks its controller where to point — or takes the only answer, or never goes on the stack
 * at all when there is none (CR 603.3c). Blocking it with a 1/1 and dying to it is the whole card.
 */
const GOBLIN_ARSONIST: CardScript = {
  name: 'Goblin Arsonist',
  triggers: [
    {
      on: { kind: 'dies' },
      targets: [ANY_TARGET],
      description: 'deals 1 damage to any target',
      effect: (c) => damageFirstTarget(c, 1),
    },
  ],
};

/**
 * "At the beginning of your upkeep", which is the step trigger nothing used.
 *
 * `of: 'you'` is the difference between a card that helps its controller and one that helps
 * everybody: the engine raises the step event for every upkeep, and the trigger decides whose it
 * cares about.
 */
const PHYREXIAN_ARENA: CardScript = {
  name: 'Phyrexian Arena',
  triggers: [
    {
      on: { kind: 'step', step: 'upkeep', of: 'you' },
      description: 'you draw a card and you lose 1 life',
      effect: (c) => loseLife(draw(c.state, c.controller, 1), c.controller, 1),
    },
  ],
};

/**
 * An anthem: the first card to use a static effect at all.
 *
 * `statics` is applied when the permanent arrives and removed with it, and the +1/+1 is read every
 * time a creature's characteristics are computed rather than written onto anything — which is what
 * makes it stack with a pump, wear off correctly when the enchantment is destroyed, and save a
 * creature that already has damage marked on it.
 */
const GLORIOUS_ANTHEM: CardScript = {
  name: 'Glorious Anthem',
  statics: [{ scope: 'controller-creatures', effect: { power: 1, toughness: 1 } }],
};

/**
 * Untapping, and a tap ability that reaches every opponent.
 *
 * The two halves are the card: it taps for damage, and casting an instant or sorcery untaps it, so
 * it can be used again in the same turn. Nothing else in the pool untaps anything.
 */
const THERMO_ALCHEMIST: CardScript = {
  name: 'Thermo-Alchemist',
  keywords: ['defender'],
  abilities: [
    {
      cost: { tap: true },
      description: '{T}: deals 1 damage to each opponent.',
      effect: (c) => opponentsOf(c.state, c.controller).reduce(
        (state, seat) => dealDamage(state, { kind: 'player', seat }, 1, { controller: c.controller, source: c.source }),
        c.state,
      ),
    },
  ],
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
      description: 'untap Thermo-Alchemist',
      effect: (c) => tap(c.state, c.source, false),
    },
  ],
};

/*
  ── Transform: the two cards that turn over ───────────────────────────────────────────────────────

  Both faces of both cards live here, and the arrangement **is** the implementation: a transform
  moves the permanent's `defKey` to the other face, so `scriptFor` then finds the back face's script
  by name and the front one stops applying. Defender is on Thing in the Ice and not on Awoken
  Horror, so a 0/4 that cannot attack becomes a 7/8 that can, and nothing had to be removed.

  Insectile Aberration has no script at all, which is the same point from the other side: its whole
  back face is "Flying", `printedKeywords` reads a keyword-only line straight off the oracle text,
  and a card that needs nothing run needs nothing written.
*/

/*
  The counter Thing in the Ice carries, named `ICE_COUNTER` because `ICE` is already the back
  half of the Fire // Ice split card. A local constant rather than one of `effects.ts`'s exported
  counter keys, because nothing but this card reads it: `FADE` and `TIME` live there because the
  engine's own upkeep pass counts them down, and an ice counter is only ever removed by the card
  that put it on.
*/
const ICE_COUNTER = 'ice';

/** Whether the card in this instance is an instant or a sorcery, read off its own type line. */
const isInstantOrSorcery = (state: GameState, id: string): boolean => {
  const def = state.cardDefs[state.instances[id]?.defKey ?? ''];
  const line = parseTypeLine(def?.typeLine);
  return hasType(line, 'instant') || hasType(line, 'sorcery');
};

/**
 * Delver of Secrets: the upkeep look, the optional reveal, and the flip.
 *
 * The reveal is **asked**, because it is printed as a choice and there is somewhere to ask it —
 * unlike myriad's "may", which happens inside a declaration (D229). It is asked as a `library-top`
 * question for one specific reason: that channel already sends the card to the seat being asked and
 * to nobody else (see `canIdentify`), so "look at the top card of your library" works without
 * leaking it to the table. A `ChoiceDecisionSpec` would have had to put the card's name in a prompt,
 * and a prompt goes to every seat.
 *
 * The question is put **every** upkeep, whatever is on top, and that is deliberate rather than
 * lazy: a question asked only when the answer mattered would tell the opponent what the top card is
 * by the mere fact of being asked. So there is no `filter`, the choice is always available, and the
 * effect reads the type of whatever came back.
 *
 * `pick` is what stops the bot getting it exactly backwards. The standing answer for `library-top`
 * is scry's — "choose a land once you have five, so it goes to the bottom" — and here choosing a
 * card *reveals* it. Without the hint a bot would hide every instant and bottom nothing.
 *
 * The revealed card is not marked `revealed` on its instance, which is a deliberate small
 * deviation: that flag is sticky, so a card shown here would still be public after it was drawn
 * into a hand three turns later. What the table actually needs to know — that the creature turned
 * over — it gets from the transform itself.
 */
const DELVER_OF_SECRETS: CardScript = {
  name: 'Delver of Secrets',
  triggers: [
    {
      on: { kind: 'step', step: 'upkeep', of: 'you' },
      description: 'look at the top card of your library; you may reveal it, and if it is an instant or sorcery, transform this',
      decisions: [{
        who: 'controller',
        from: 'library-top',
        look: 1,
        prompt: 'Reveal the top card of your library?',
        min: 0,
        max: 1,
        pick: (state, _chooser, candidates) => candidates.filter((id) => isInstantOrSorcery(state, id)),
      }],
      effect: (c) => ((c.decisions[0]?.ids ?? []).some((id) => isInstantOrSorcery(c.state, id))
        ? transformPermanent(c.state, c.source)
        : c.state),
    },
  ],
};

/**
 * Thing in the Ice: four counters, one off per spell, and the flip when the last one goes.
 *
 * One trigger does both halves, because the card prints them as one sentence — "remove an ice
 * counter. **Then** if it has no ice counters on it, transform it" — and two triggers would be two
 * objects on the stack that an opponent could answer between.
 *
 * `entersWith` is printed data rather than script behaviour, the same as a leveler's bands, so the
 * counters arrive through the replacement effect that puts them on rather than through an entry
 * trigger that would go on the stack after the 0/4 had already sat there with nothing on it.
 *
 * The guard on a counter already being gone is not paranoia: the flip leaves the permanent on the
 * battlefield with the same id, so a second instant cast after it has turned over would reach this
 * trigger again if the front face's script were still the active one. It is not — `defKey` has
 * moved — but the guard says so where the reader is, and costs nothing.
 */
const THING_IN_THE_ICE: CardScript = {
  name: 'Thing in the Ice',
  keywords: ['defender'],
  entersWith: { counter: ICE_COUNTER, amount: 4 },
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
      description: 'remove an ice counter from Thing in the Ice, then transform it if it has none',
      effect: (c) => {
        if ((c.state.instances[c.source]?.counters[ICE_COUNTER] ?? 0) <= 0) return c.state;
        const next = addCounters(c.state, c.source, ICE_COUNTER, -1);
        if ((next.instances[c.source]?.counters[ICE_COUNTER] ?? 0) > 0) return next;
        // Recorded for consistency rather than from need: this is the one clock whose expiry leaves
        // the permanent where it was, so an instrument *could* see it from the board. Recording all
        // four keeps `expired` meaning "a clock ran out" rather than "the ones you could not
        // otherwise see", which is a contract nobody would remember.
        return transformPermanent(recordExpiry(next, c.source, ICE_COUNTER), c.source);
      },
    },
  ],
};

/**
 * Awoken Horror: the pool's first `transformed` trigger, and a bounce that spares its own kind.
 *
 * "When this creature transforms into Awoken Horror" is written **here**, on the back face, and
 * that is the whole of how the engine knows which face it became: the flip moves `defKey` before
 * `settle` raises the event, so the script that receives it is the face the permanent now is.
 *
 * Non-Horror, so it spares itself — it is a Kraken Horror — and spares nothing else in this pool.
 * Returning rather than destroying is what makes it a reset instead of a sweeper: nothing dies, so
 * nothing that watches a death sees anything, and every creature on the table is a card to be cast
 * again.
 */
const AWOKEN_HORROR: CardScript = {
  name: 'Awoken Horror',
  triggers: [
    {
      on: { kind: 'transformed' },
      description: "return all non-Horror creatures to their owners' hands",
      effect: (c) => battlefield(c.state, (id) => {
        const inst = c.state.instances[id];
        if (inst === undefined) return false;
        const ch = characteristicsOf(c.state, inst);
        if (!ch.isCreature) return false;
        /*
          The **live** subtype, as the line above already reads the live `isCreature`. One expression
          asking `characteristicsOf` for one half of its question and the printed line for the other
          is the shape that made this wrong: a creature that has been *made* a Horror is one the
          Thing does not bounce, and the print cannot know that.
        */
        return !hasSubtype(characteristicsOf(c.state, inst).typeLine, 'Horror');
      }).reduce((state, id) => bounceToHand(state, id), c.state),
    },
  ],
};

// ── Modal spells: "Choose one —" ─────────────────────────────────────────────────────────────────

const SELESNYA_CHARM: CardScript = {
  name: 'Selesnya Charm',
  modal: {
    modes: [
      {
        description: 'Target creature gets +2/+2 and gains trample until end of turn',
        // Only this mode of the three wears off; the other two exile and make a token.
        expiresAtEndOfTurn: true,
        targets: [TARGET_CREATURE_HELPED],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null
            ? c.state
            : pump(c.state, [id], c.source, c.controller, { power: 2, toughness: 2, keywords: ['trample'] });
        },
      },
      {
        description: 'Exile target creature with power 5 or greater',
        targets: [{
          kind: 'creature', description: 'target creature with power 5 or greater',
          // Current power, not printed: a 2/2 pumped past five is a legal target and a 6/6 shrunk
          // below it is not, which is the whole reason characteristics are computed on demand.
          filter: (state, candidate) => candidate.kind === 'card'
            && (state.instances[candidate.id] !== undefined)
            && characteristicsOf(state, state.instances[candidate.id]!).power >= 5,
        }],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : exileCard(c.state, id);
        },
      },
      {
        description: 'Create a 2/2 white Knight creature token with vigilance',
        effect: (c) => createToken(c.state, c.controller, KNIGHT_TOKEN, 1),
      },
    ],
  },
};

/**
 * "Choose one or both", which is a modal spell with a range rather than a count.
 *
 * Both halves are worth having separately — countering a creature spell, and buying a creature
 * back — and the card lets you take both when you can pay for both targets. `legalActions` offers
 * three plays: each half alone, and the pair.
 */
const SOUL_MANIPULATION: CardScript = {
  name: 'Soul Manipulation',
  modal: {
    min: 1,
    max: 2,
    modes: [
      {
        description: 'Counter target creature spell',
        // `isCreatureSpell`, not a third copy of it: this was the second inline one, and Essence
        // Scatter's was the first.
        targets: [{ ...TARGET_SPELL, description: 'target creature spell', filter: isCreatureSpell }],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : counterSpell(c.state, id);
        },
      },
      {
        description: 'Return target creature card from your graveyard to your hand',
        targets: [yourGraveyardCreature],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : bounceToHand(c.state, id);
        },
      },
    ],
  },
};

const GRIM_DISCOVERY: CardScript = {
  name: 'Grim Discovery',
  modal: {
    min: 1,
    max: 2,
    modes: [
      {
        description: 'Return target creature card from your graveyard to your hand',
        targets: [yourGraveyardCreature],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : bounceToHand(c.state, id);
        },
      },
      {
        description: 'Return target land card from your graveyard to your hand',
        targets: [yourGraveyardLand],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : bounceToHand(c.state, id);
        },
      },
    ],
  },
};

// ── Cards that stop and ask while they resolve ───────────────────────────────────────────────────

/**
 * A search of your own library, as a decision rather than a target.
 *
 * `min: 0` because failing to find is legal (CR 701.19c), and occasionally right — a player who
 * does not want to shuffle, or who would rather not show that they have nothing. The engine will
 * not make that call for them, which means the prompt always has a "choose nothing" answer.
 */
const searchYourLibrary = (
  prompt: string, filter?: CardsDecisionSpec['filter'], max = 1,
): CardsDecisionSpec => ({
  who: 'controller', from: 'library', prompt, min: 0, max,
  ...(filter === undefined ? {} : { filter }),
});

/**
 * The `max` for a search that prints "any number of".
 *
 * `CardsDecisionSpec.max` is clamped to what the zone actually holds, so this only has to be larger
 * than any library can be — the clamp is what makes it right, and a tuned bound would be a second
 * rule to keep true. A hundred-card Commander deck is the largest legal one; this is an order of
 * magnitude above it.
 */
const ANY_NUMBER = 1000;

/**
 * A printed library search, as a `searchYourLibrary` question and one thing done with what it
 * found (D449).
 *
 * This replaced two exact-string readers — Diabolic Tutor's and Rampant Growth's — which between
 * them covered two of the **173 distinct shapes** this clause takes in the corpus. The shapes are
 * not 173 different mechanics: they are one mechanic crossed with a filter, an optional reveal, two
 * spellings of "the card you found", and three destinations. So it is read as that product.
 *
 * Measured over the unread legal lines containing a library search (439 of them):
 *
 * | printed filter | lines | cards it alone is blocking |
 * | --- | --- | --- |
 * | `a basic land card` | 58 | 35 |
 * | `a card` | 10 | 6 |
 * | `a card named <this card>` | 9 | 6 |
 * | `a Forest card` and the other four basic land types | 8 | 7 |
 * | `a creature card` / `a Dragon card` / `an Aura card` / `a planeswalker card` … | 8 | 7 |
 *
 * and the destinations: `put it into your hand` (114 lines), `onto the battlefield tapped` (24 as
 * "it" plus 14 as "that card"), `onto the battlefield` (18 plus 11).
 *
 * ## The reveal is read as nothing, and that is a stated deviation
 *
 * 78 of those lines print ", reveal it," between the search and the destination, which is the
 * single biggest row — so refusing it would cost more than any other decision here. It is read as
 * a no-op, and the engine already has that position on record: `CardScript.miracle`'s docblock says
 * in as many words that it "deliberately does not model the **reveal** … a hidden-information
 * difference in the player's favour … small — but it is a difference, and a card that punished an
 * opponent for the reveal would need the reveal to be real."
 *
 * The same holds here and for the same reason. A printed reveal on a search exists so the other
 * players can check that the card taken matched the filter; here the **filter is enforced by the
 * engine**, so the verification the reveal exists to provide is already done. What is lost is that
 * opponents do not learn which card was taken. No card in the pool punishes a reveal, and when one
 * is added this reader is where the honesty has to be repaid.
 *
 * ## What is refused, after D455 widened it
 *
 * **416 legal cards were one unread line from finished and that line was a library search** — the
 * largest family in the corpus by a distance — and the refusals this docblock used to list were the
 * reason: a count, a destination applied to a set, and a filter of more than one word. The corpus
 * says those are not exotic, they are the normal way Magic prints the clause, so D455 reads them:
 * three quantities (`a`, `up to N`, `any number of`), four destinations plus exile, both plural
 * pronouns, the reveal in all its spellings, and a filter that is alternatives of conjunctions with
 * a leading `basic` distributing over them.
 *
 * What is still refused, and each is a shape rather than an oversight: a count this reader cannot
 * name (`up to X`, `up to that many`); a condition on a characteristic ("with mana value 3 or
 * less"); a category that is not a type (`permanent`, which D449's own guard caught); two zones
 * ("search your library **and/or graveyard**"); two filters rather than two words of one ("a basic
 * land card **or a Desert card**"); a split destination (Cultivate's one-here-one-there); and the
 * top of the library, which `searchYourLibrary`'s own shuffle would undo. Each stays unread (D362).
 */
/**
 * How many cards a printed search asks for, and whether it says so in the plural.
 *
 * Three printed quantities and no others: `a`/`an`, `up to <number>`, and `any number of`. **The
 * minimum is always nought**, which is not a simplification — a player may always fail to find
 * (CR 701.19c), and that is what makes a search a decision rather than a lookup.
 *
 * The count comes back with the **singular** of the phrase, because that is what `libraryFilter`
 * reads: "up to two basic land cards" is two of the thing "a basic land card" names. Only the noun
 * is singularised (`cards` → `card`); a subtype inside the phrase keeps its own number, which is
 * why "up to three cards named Howling Wolf" works and nothing has to know that Wolf is singular.
 */
function searchQuantity(
  phrase: string,
): { readonly max: number; readonly singular: string } | null {
  const singularise = (rest: string): string => `a ${rest.trim().replace(/\bcards\b/i, 'card')}`;
  const one = /^an? (.+)$/i.exec(phrase);
  if (one !== null) return { max: 1, singular: `a ${one[1]!.trim()}` };
  const counted = /^up to (\w+) (.+)$/i.exec(phrase);
  if (counted !== null) {
    const max = countFrom(counted[1]!);
    // "Up to X" and "up to that many" are counts this reader cannot name: X is chosen at cast time
    // and "that many" points back at a number in an earlier clause.
    return max === null || max < 1 ? null : { max, singular: singularise(counted[2]!) };
  }
  const any = /^any number of (.+)$/i.exec(phrase);
  if (any !== null) return { max: ANY_NUMBER, singular: singularise(any[1]!) };
  return null;
}

function searchClause(text: string, name: string): ReadEffect | null {
  const parsed =
    /^search your library for (.+?)(?:, reveal (?:it|that card|them|those cards))?, (?:and )?(put (?:it|that card|them|those cards) (?:into your hand|onto the battlefield tapped|onto the battlefield|into your graveyard)|exile (?:it|that card|them|those cards))$/i
      .exec(text.trim());
  if (parsed === null) return null;
  const printed = parsed[1]!.trim();
  const quantity = searchQuantity(printed);
  if (quantity === null) return null;
  const filter = libraryFilter(quantity.singular, name);
  if (filter === null) return null;

  const action = parsed[2]!.toLowerCase();
  const pronoun = /\b(it|that card|them|those cards)\b/.exec(action)![1]!;
  const destination = action.startsWith('exile')
    ? 'exile' : action.replace(/^put (?:it|that card|them|those cards) /, '');
  /*
    **The pronoun has to agree with the count**, and the check is a guard on this reader rather than
    a rule about Magic: a printed card never says "up to two cards … put it into your hand". So a
    disagreement means the quantity was parsed wrong — the phrase said something this reader read as
    a count and was not one — and the honest answer is to leave the line unread rather than apply a
    singular destination to a set, or a set's to one card.
  */
  if ((pronoun === 'them' || pronoun === 'those cards') !== (quantity.max > 1)) return null;

  return {
    decisions: [searchYourLibrary(
      // The prompt is the **printed** phrase, plural and all, because it is what a player reads.
      `Search your library for ${printed}`,
      filter.filter === null ? undefined : filter.filter,
      quantity.max,
    )],
    effect: (c) => {
      const found = chosenCards(c);
      if (found.length === 0) return c.state;
      if (destination === 'into your hand') return moveToHand(c.state, found);
      if (destination === 'into your graveyard') return moveToGraveyard(c.state, found);
      if (destination === 'exile') {
        return found.reduce((state, id) => exileCard(state, id), c.state);
      }
      return found.reduce(
        (state, id) => putOntoBattlefield(state, id, c.controller, {
          tapped: destination === 'onto the battlefield tapped',
        }),
        c.state,
      );
    },
  };
}

/** The card types a printed search phrase can name, as `hasType` reads them (CR 205.2a). */
const SEARCHABLE_TYPES: readonly string[] = [
  'artifact', 'battle', 'creature', 'enchantment', 'instant', 'land', 'planeswalker', 'sorcery',
];

/** The supertypes (CR 205.4a). "Search your library for a legendary card" is Captain Sisay. */
const SUPERTYPES: readonly string[] = ['basic', 'legendary', 'snow', 'world'];

/**
 * A printed search filter, as a `CardsDecisionSpec.filter` and the words to show the player.
 *
 * `filter: null` means "any card", which is not the same as no reader: Diabolic Tutor's search has
 * no filter and still has to be told apart from a phrase this module cannot build.
 *
 * Every filter reads `state.cardDefs[...].typeLine` — the **printed** line — and that is correct
 * here where #319 says it would be wrong elsewhere: a card in a library has no live
 * characteristics, because nothing on the battlefield is modifying it. The distinction is worth the
 * sentence because the identical-looking read on a *battlefield* permanent is the defect #319 was
 * opened for.
 */
function libraryFilter(
  phrase: string, name: string,
): { readonly phrase: string; readonly filter: CardsDecisionSpec['filter'] | null } | null {
  const lower = phrase.toLowerCase();
  const lineOf = (state: GameState, id: string): TypeLine => {
    const inst = state.instances[id];
    return parseTypeLine(inst === undefined ? '' : state.cardDefs[inst.defKey]?.typeLine);
  };
  if (lower === 'a card') return { phrase: 'a card', filter: null };
  if (lower === 'a basic land card') return { phrase, filter: isBasicLand };
  // "a card named <this card's own name>", which is the only name a printed line can give this
  // reader without a card database to look the name up in.
  const named = /^an? card named (.+)$/i.exec(phrase);
  if (named !== null) {
    if (plain(named[1]!).toLowerCase() !== plain(name).toLowerCase()) return null;
    return {
      phrase,
      filter: (state, id) => {
        const inst = state.instances[id];
        return inst !== undefined && state.cardDefs[inst.defKey]?.name === name;
      },
    };
  }
  const typed = /^an? (.+) cards?$/i.exec(phrase);
  if (typed === null) return null;
  /*
    **The type words, as alternatives of conjunctions**, which is the grammar Magic prints: "a
    basic Forest, Plains, or Island card" is one of three, "an artifact creature card" is both at
    once, and a leading `basic` distributes over the whole list rather than attaching to the first
    word of it (a Panorama finds a basic Island, not an Island and a basic anything).

    So the list is split on `, or `, `,` and ` or `, each alternative's words are AND-ed, and the
    alternatives are OR-ed. One `basic` in front of the list is peeled off and applied to all of
    them.
  */
  let list = typed[1]!.trim();
  let basicOnly = false;
  if (/^basic\s+/i.test(list)) {
    basicOnly = true;
    list = list.replace(/^basic\s+/i, '').trim();
  }
  const alternatives = list.split(/\s*,\s*or\s+|\s*,\s*|\s+or\s+/i)
    .map((part) => part.trim()).filter((part) => part !== '');
  if (alternatives.length > 1 || alternatives.some((part) => part.includes(' ')) || basicOnly) {
    const built = alternatives.map((part) => {
      const words = part.split(/\s+/).map(cardWordMatch);
      return words.some((word) => word === null)
        ? null
        : (line: TypeLine) => words.every((word) => word!(line));
    });
    if (built.some((match) => match === null)) return null;
    const isBasic = (line: TypeLine) => line.supertypes.some((t) => t.toLowerCase() === 'basic');
    return {
      phrase,
      filter: (state, id) => {
        const line = lineOf(state, id);
        if (basicOnly && !isBasic(line)) return false;
        return built.some((match) => match!(line));
      },
    };
  }
  const word = alternatives[0]!.toLowerCase();
  /*
    **Magic's own capitalisation tells a type from a subtype**, and that is what makes this safe to
    read at all.

    Card types and supertypes are printed lowercase — "a creature card", "a planeswalker card", "a
    legendary card" — and subtypes are capitalised: "a Dragon card", "a Forest card", "an Arcane
    card", "a Mercenary card". So a lowercase word has to be on one of the two lists above, and a
    capitalised word is a subtype.

    **The lowercase allow-list is the whole guard, and the first draft of this function did not have
    it.** Without it "a **permanent** card" (Mystic Sanctuary's shape) compiled to a filter asking
    for a card whose type line contains the type "permanent" — which no card has, because permanent
    is not a type (CR 205.2a). The search would have offered **nothing**, every time, on a card that
    otherwise worked: the exact failure D362 is about, and worse than leaving the line unread
    because nothing at the table would flag it. "A legendary card" had the same shape from the other
    side: it is a **supertype**, so matching subtypes would have found nothing either.

    Subtypes are matched with `hasSubtype` against the **parsed** line rather than by searching the
    string, which is what keeps "a Forest card" matching Snow-Covered Forest and the typed duals
    while not matching a card merely *named* for a forest.
  */
  const match = cardWordMatch(alternatives[0]!);
  if (match === null) return null;
  return { phrase, filter: (state, id) => match(lineOf(state, id)) };
}

/**
 * One word of a printed card filter, as a test on a **printed** type line.
 *
 * The capitalisation rule is the one `libraryFilter`'s docblock argues for and `permanentWordMatch`
 * uses on the battlefield side (D453): Magic prints card types and supertypes lowercase and
 * subtypes capitalised, so a lowercase word has to be on one of the two lists and a capitalised one
 * is a subtype. The lowercase allow-list is the guard, and the reason is written out below.
 *
 * The word must also **be** a word — letters, apostrophes and hyphens — so a comma or a slash that
 * survived the split refuses the filter instead of becoming a subtype no card has. That is D453's
 * guard for D453's reason: a filter matching nothing is worse than an unread line, because nothing
 * at the table flags it.
 */
function cardWordMatch(word: string): ((line: TypeLine) => boolean) | null {
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) return null;
  const lower = word.toLowerCase();
  if (/^[A-Z]/.test(word)) return (line) => hasSubtype(line, lower);
  if (SEARCHABLE_TYPES.includes(lower)) return (line) => hasType(line, lower);
  if (SUPERTYPES.includes(lower)) {
    return (line) => line.supertypes.some((t) => t.toLowerCase() === lower);
  }
  // A lowercase word that is neither: not a type this reader can name, so the line stays unread.
  return null;
}

const isBasicLand = (state: GameState, id: string): boolean => {
  const inst = state.instances[id];
  const line = inst === undefined ? '' : (state.cardDefs[inst.defKey]?.typeLine ?? '');
  return /basic/i.test(line) && /land/i.test(line);
};

const RAMPANT_GROWTH: CardScript = {
  name: 'Rampant Growth',
  decisions: [searchYourLibrary('Search your library for a basic land card', isBasicLand)],
  onResolve: (c) => {
    const found = chosenCard(c);
    // Tapped, which is the cost of the card and the reason it is not simply a better land drop.
    return found === null ? c.state : putOntoBattlefield(c.state, found, c.controller, { tapped: true });
  },
};

const DIABOLIC_TUTOR: CardScript = {
  name: 'Diabolic Tutor',
  decisions: [searchYourLibrary('Search your library for a card')],
  onResolve: (c) => moveToHand(c.state, chosenCards(c)),
};

/**
 * "Target player discards two cards."
 *
 * The player discarding chooses, not the caster — which is the whole difference between this and
 * `discardAtRandom`, and the reason Ravenous Rats is scripted as random and this is not. Two is
 * clamped to the hand: a player with one card discards one, and one with none is never asked.
 */
const MIND_ROT: CardScript = {
  name: 'Mind Rot',
  targets: [TARGET_PLAYER],
  decisions: [{
    who: 'target-player', from: 'hand', prompt: 'Discard two cards', min: 2, max: 2,
  }],
  onResolve: (c) => moveToGraveyard(c.state, chosenCards(c)),
};

/**
 * "Draw two cards, then discard two cards."
 *
 * The card that needs `beforeDecisions`: the cards it offers to discard are the ones it has not
 * drawn yet, so the draw has to happen before the question can be asked. Asking first and drawing
 * afterwards would be a different and much worse card.
 */
const FAITHLESS_LOOTING: CardScript = {
  name: 'Faithless Looting',
  beforeDecisions: (c) => draw(c.state, c.controller, 2),
  decisions: [{ who: 'controller', from: 'hand', prompt: 'Discard two cards', min: 2, max: 2 }],
  onResolve: (c) => moveToGraveyard(c.state, chosenCards(c)),
};

/**
 * "When this enters the battlefield, each player sacrifices a creature."
 *
 * Including you, and including this one — a Marauder played with no other creature eats itself,
 * which is the card working correctly rather than a bug. The questions are asked in turn order
 * from the active player (CR 101.4), so the second player to answer has seen the first give
 * something up.
 */
const FLESHBAG_MARAUDER: CardScript = {
  name: 'Fleshbag Marauder',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'each player sacrifices a creature',
      decisions: [{
        who: 'each-player', from: 'battlefield', prompt: 'Sacrifice a creature', min: 1, max: 1,
        filter: (state, id) => {
          const inst = state.instances[id];
          return inst !== undefined && characteristicsOf(state, inst).isCreature;
        },
      }],
      effect: (c) => c.decisions.reduce((state, answer) => moveToGraveyard(state, answer.ids), c.state),
    },
  ],
};

// ── The two cards that needed layers ─────────────────────────────────────────────────────────────

/*
  Everything else in this pool adds to what a creature is. These two replace it.

  A +3/+3 and a -1/-1 can be summed in any order; "becomes 1/1" cannot be summed with anything,
  because it replaces the base that the pumps then apply to — which is layer 7b against layer 7c
  (CR 613.4c), and the reason `characteristicsOf` now runs the layers in order rather than making
  one pass. A copy is layer 1, and the engine makes one by pointing the new permanent at the copied
  card's *printed* definition, which is what a copy is.
*/

/**
 * Clone: a 0/0 that enters as whatever is best on the table.
 *
 * The first card in the pool that asks a question about the **whole board** rather than about one
 * of the chooser's own zones, which is why `DecisionZone` grew `any-battlefield` for it. The copy
 * itself needs no new rules: `becomeCopyOf` points the instance at the copied card, and because
 * `completeResolution` runs a spell's script *before* it moves the permanent, what arrives is
 * already the copy — so the arrivals pass installs the copied card's statics and raises the copied
 * card's own entry trigger, which is exactly what the printed card does.
 *
 * `min: 0` is the printed "you may": declining is legal, and a Clone that copies nothing is a 0/0
 * that dies as it arrives. That is the card rather than a trap — it is the reason the real Clone
 * says "may" — and the engine will not be asked when there is nothing on the board to copy.
 */
const CLONE: CardScript = {
  name: 'Clone',
  // Declared for the bot, like `preventsDamage` and `makesMana`: see `CardScript.copiesACreature`.
  copiesACreature: true,
  decisions: [{
    who: 'controller',
    from: 'any-battlefield',
    prompt: 'Choose a creature to enter as a copy of',
    min: 0,
    max: 1,
    filter: (state, id) => {
      const inst = state.instances[id];
      return inst !== undefined && characteristicsOf(state, inst).isCreature;
    },
  }],
  onResolve: (c) => {
    const chosen = c.decisions[0]?.ids[0];
    return chosen === undefined ? c.state : becomeCopyOf(c.state, c.source, chosen);
  },
};

/**
 * Turn to Frog: removal that leaves the body behind.
 *
 * Two mana at instant speed turns a 6/6 flying trampler into a 1/1 with nothing — and the *order*
 * is the rule worth testing: a Giant Growth already on it still applies, because modifying is 7c
 * and happens after setting whatever the timestamps say, so the Frog is a 4/4. A trample granted
 * *after* it survives too, for the same reason read the other way: layer 6 takes away what was
 * there when it resolved and nothing later.
 */
const TURN_TO_FROG: CardScript = {
  name: 'Turn to Frog',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  targets: [TARGET_CREATURE],
  // It wears off, so the bot should hold it for a combat rather than spend it on its own turn.
  expiresAtEndOfTurn: true,
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : pump(c.state, [id], c.source, c.controller, {
      setPower: 1,
      setToughness: 1,
      losesAllAbilities: true,
    });
  },
};

/**
 * Cackling Counterpart: a second copy of your own best creature.
 *
 * Printed values only (CR 707.2), which is the whole of what a copy is and also what makes the card
 * honest: copying a Grizzly Bears under two Giant Growths gives a 2/2, and copying a Fog Bank gives
 * something that prevents damage because the token's abilities come from the copied card's name.
 *
 * Both halves now. The note that used to be here said the printed flashback was out of reach
 * because "casting a spell from a graveyard is a whole mechanism rather than a cost" — which was
 * true, and the mechanism is in: see `CardScript.flashback`.
 */
const CACKLING_COUNTERPART: CardScript = {
  name: 'Cackling Counterpart',
  flashback: { cost: '{5}{U}{U}' },
  targets: [{ ...TARGET_CREATURE, description: 'target creature you control', filter: creatureYouControl }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : copyAsToken(c.state, c.controller, id);
  },
};

/*
  The two cards flashback was built for, beside the Counterpart.

  Each is the same card twice for two different prices, which is the whole mechanic: Think Twice is
  a cantrip you cast now and a cantrip you cast later out of the graveyard, and Firebolt kills two
  creatures over the course of a game for five mana. What makes them fair rather than engines is the
  end of it — the card is exiled as it leaves the stack the second time, and there is no third.
*/
const THINK_TWICE: CardScript = {
  name: 'Think Twice',
  flashback: { cost: '{2}{U}' },
  onResolve: (c) => drawLater(c.state, c.controller, 1),
};

const FIREBOLT: CardScript = {
  name: 'Firebolt',
  flashback: { cost: '{4}{R}' },
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 2),
};

/*
  ── A cost paid out of the graveyard ───────────────────────────────────────────────────────────

  Flashback above casts a card *from* the graveyard; these three pay *with* it, which is a
  different thing and the engine's first cost taken out of a zone. Everything else that pays for
  something spends mana, taps a permanent, sacrifices one, or pays life — the graveyard was
  somewhere cards went and nothing more.

  **Escape and delve are the same idea at opposite ends.** The Phoenix's price is printed and
  fixed: {2}{R}{R} and three other cards, as many times as the graveyard can stand it, which is
  what makes a 2/2 flier worth a slot and a 4/4 unprintable. The Angler and the Cruise choose
  their price as they are cast — `delvePlan` works out the fewest cards that make the spell
  payable, so the same card is seven mana on turn four and one mana on turn eight.

  The reason the plan takes the *fewest* and not the most is these three cards together: a
  graveyard emptied to cast an Angler is a Phoenix that cannot escape and a Think Twice that
  cannot be flashed back, and the mana saved by delving one card further is mana that was going to
  go unspent anyway.
*/
const PHOENIX_OF_ASH: CardScript = {
  name: 'Phoenix of Ash',
  keywords: ['flying', 'haste'],
  escape: { cost: '{2}{R}{R}', exile: 3 },
  abilities: [
    {
      cost: { mana: '{1}' },
      description: '{1}: Phoenix of Ash gets +1/+0 until end of turn.',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 1 }),
    },
  ],
};

/*
  A 5/5 with no text at all beyond its own price, which is the honest way to show delve off: there
  is nothing else going on, so a game where the Angler arrives on turn four is a game delve
  decided.
*/
const GURMAG_ANGLER: CardScript = {
  name: 'Gurmag Angler',
  delve: true,
};

/*
  Escape's second card, and the one that shows why the mechanic is more than a discount.

  A Phoenix of Ash escapes because it is a threat that will not stay dead. Woe Strider escapes
  because it is an **engine**: a {0} sacrifice outlet is what Ashen Rite's eight death payoffs are
  all waiting for, and a sacrifice outlet that comes back for {4}{B} and three cards is one the
  opponent cannot answer by killing it. The Goat it arrives with is the first thing it eats, which
  is the card's own joke and also the reason the 3/2 body is not the point.

  Three pieces of vocabulary that were all already here: a token on an entry trigger, an activated
  ability whose cost is **sacrificing another creature** (`AbilityCost.sacrifice`, which the
  engine has had since D24 and no card had ever asked for on an *ability*), and a scry as the
  ability's decision. The only new line in the engine for this card is the Goat.
*/
const WOE_STRIDER: CardScript = {
  name: 'Woe Strider',
  escape: { cost: '{4}{B}', exile: 3 },
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'create a 0/1 white Goat creature token',
      effect: (c) => createToken(c.state, c.controller, GOAT_TOKEN, 1),
    },
  ],
  abilities: [
    {
      /*
        **"Another"**, which is the difference between a sacrifice outlet and a way to lose your
        own engine: a Woe Strider that could eat itself would be a card the bot feeds to its own
        ability on an empty board. `sacrificeOptions` already enforces it — the same clause Bone
        Splinters uses — so the cost says it rather than the effect checking it.

        `{0}` is the whole cost. A free, repeatable sacrifice is the thing eight Blood Artists,
        Aristocrats and a Judith have been short of since the deck was built: every one of them
        reads a creature dying and none of them could make one die.
      */
      cost: { sacrifice: 'another-creature' },
      description: 'Sacrifice another creature: Scry 1.',
      decisions: [scry(1)],
      /*
        **No `effect`, and the pool's text was wrong (D471).**

        The deck list printed this ability as `{0}: Sacrifice another creature. Scry 1.`, which is
        not what the card says: the real printing is `Sacrifice another creature: Scry 1.`, with the
        sacrifice **before** the colon as the cost — exactly how Bloodthrone Vampire and Izoni are
        written two hundred lines away. The script was always right (`cost.sacrifice`) and the text
        beside it was a paraphrase.

        It mattered the moment the compiler learned to read a chosen sacrifice as an effect: the
        paraphrase then compiled into a **free, repeatable** `{0}` ability that scries whether or not
        there is a creature to eat, which is a different and much better card. Found by
        `compiled-vs-written.test.ts`, which is the third defect that standing check has caught in a
        text nobody was looking at.

        With the text corrected the two readings agree except for this field: an identity `effect`
        the compiled reading does not emit, because a scry's work is done by applying its own answer
        (D467). Deleted rather than listed in `DISAGREE`, which is what D419 and D420 did with the
        same shape of difference.
      */
    },
  ],
};

/*
  ── And the two answers to a graveyard ─────────────────────────────────────────────────────────

  The pool spent a year making the graveyard worth having — flashback, Raise Dead, Zombify, a
  Gravedigger, a Lhurgoyf whose power *is* the graveyard, and now escape and delve — with exactly
  one card able to interfere with one: a Tormod's Crypt, once. That is a dimension with no answer
  in it, which in a thirteen-deck field is a balance hole rather than a flavour choice.

  **Planar Void is the card the new event exists for** and the reason it is a trigger rather than a
  replacement: it is printed as a trigger. "Whenever another card is put into a graveyard from
  anywhere, exile that card" means the card really does reach the graveyard and really is exiled
  afterwards, so a Blood Artist still sees the death and a flashback card is gone before anybody
  could cast it. Implementing it as a replacement would be implementing a different, stronger card.

  **Scavenging Ooze needed nothing new at all**, which is the other half of why this pair is worth
  shipping together: a `graveyard-card` target and an activated ability with a mana cost have been
  in the engine for months, so the second answer to the graveyard is twelve lines and no engine
  change. One card asks for a new event and the other proves the vocabulary was already there.
*/
/*
  Four keywords that read the **attack** rather than the creature, and the one thing the trigger
  vocabulary was missing.

  The engine's seventeen keywords are all facts about a permanent — flying, deathtouch, defender —
  and its combat triggers have always been able to say "whenever this attacks". What none of them
  could say is anything about the *shape* of the declaration: how many creatures were in it, how
  their power compares, or whether this one has connected before. Three of these four needed
  nothing but a script; battalion needed one field (`withAtLeast`, D188).

  They also share a reason for existing: every one of them pays the player for attacking with more
  than one creature, which is the decision the bot's combat search is actually about.
*/

/** Battalion: whenever this and at least two other creatures attack (CR 702.102a). */
const FIREMANE_AVENGER: CardScript = {
  name: 'Firemane Avenger',
  keywords: ['flying'],
  triggers: [{
    on: { kind: 'attacks', withAtLeast: 3 },
    description: 'it deals 3 damage to any target and you gain 3 life',
    targets: [ANY_TARGET],
    effect: (c) => gainLife(damageFirstTarget(c, 3), c.controller, 3),
  }],
};

/**
 * Mentor: whenever this attacks, put a +1/+1 counter on target attacking creature with less power
 * (CR 702.133a).
 *
 * The target filter is the card: *attacking*, and *less power than this*. Both are read off the
 * board as the trigger goes on the stack — `state.combat.attacks` is the declaration, and the
 * source's own power is what "lesser" is measured against — and the counter is permanent, which is
 * what makes a one-mana 2/1 worth a slot in a deck that attacks with four creatures.
 */
const SUNHOME_STALWART: CardScript = {
  name: 'Sunhome Stalwart',
  keywords: ['first strike'],
  triggers: [{
    on: { kind: 'attacks' },
    description: 'put a +1/+1 counter on target attacking creature with lesser power',
    targets: [{
      kind: 'creature',
      description: 'target attacking creature with lesser power',
      friendly: true,
      filter: (state, candidate, controller, source) => {
        if (candidate.kind !== 'card' || source === undefined) return false;
        if (candidate.id === source) return false;
        if (!state.combat.attacks.some((attack) => attack.attacker === candidate.id)) return false;
        const mine = state.instances[source];
        const theirs = state.instances[candidate.id];
        if (mine === undefined || theirs === undefined) return false;
        return characteristicsOf(state, theirs).power < characteristicsOf(state, mine).power;
      },
    }],
    effect: (c) => {
      const target = c.targets?.[0];
      return target?.kind === 'card' ? addCounters(c.state, target.id, '+1/+1', 1) : c.state;
    },
  }],
};

/**
 * Renown 1: the first time it connects with a player, it keeps a +1/+1 counter (CR 702.112a).
 *
 * "If it isn't renowned" is an intervening-if about a state the creature carries, so the engine's
 * answer to renowned is a counter — the same shape monstrous and unearth use. A creature that
 * leaves and comes back is a new object with no counters, and renown is correctly available again,
 * which is what the rules say about any such marker.
 */
const TOPAN_FREEBLADE: CardScript = {
  name: 'Topan Freeblade',
  keywords: ['vigilance'],
  triggers: [{
    /*
      No `to: 'player'` needed, which is worth knowing rather than guessing at: the engine raises
      `combat-damage` **only** for damage that actually took a player's life total down (see
      `dealCombatDamageTo`), so blocked damage and a swing stopped by a Fog raise nothing at all.
      Renown wants exactly that reading.
    */
    on: { kind: 'combat-damage' },
    description: 'it becomes renowned and gets a +1/+1 counter',
    condition: (c) => (c.state.instances[c.source]?.counters[RENOWNED] ?? 0) === 0,
    effect: (c) => addCounters(addCounters(c.state, c.source, '+1/+1', 1), c.source, RENOWNED, 1),
  }],
};

/**
 * Battle cry: whenever this attacks, **each other** attacking creature gets +1/+0 (CR 702.91a).
 *
 * The one of the four whose effect reads the declaration rather than its condition: the pump goes
 * on every other creature in `state.combat.attacks`, which is the list as it stands when the
 * trigger resolves. A creature that has already been removed from combat is not pumped, and that is
 * the printed card rather than a simplification.
 */
/**
 * Battle cry, written out as the triggered ability the keyword abbreviates (CR 702.91a).
 *
 * "Whenever this creature attacks, each other attacking creature gets +1/+0 until end of turn."
 * The word **other** is the whole of what has to be got right: a Goblin Wardriver attacking alone
 * pumps nothing, and one attacking beside two others pumps exactly those two. `on: { kind:
 * 'attacks' }` with no `who` is this creature attacking, which is the default `automation.ts`
 * applies and which the printed card means.
 *
 * A factory for the reason `exaltedTrigger` is one: the declaration is the ability, so the compiled
 * reading and the hand-written card must be the same ability rather than two spellings of it.
 */
const battleCryTrigger = (): TriggerDef => ({
  on: { kind: 'attacks' },
  description: 'each other attacking creature gets +1/+0 until end of turn',
  effect: (c) => {
    const others = c.state.combat.attacks
      .map((attack) => attack.attacker)
      .filter((id) => id !== c.source);
    return pump(c.state, others, c.source, c.controller, { power: 1 });
  },
});

const GOBLIN_WARDRIVER: CardScript = {
  name: 'Goblin Wardriver',
  triggers: [battleCryTrigger()],
};

/**
 * Cascade, written out as the triggered ability the keyword abbreviates (CR 702.85a).
 *
 * "Cascade" means "When you cast this spell, exile cards from the top of your library until you
 * exile a nonland card that costs less. You may cast it without paying its mana cost. Put the
 * exiled cards on the bottom of your library in a random order" — and writing it as a trigger is
 * what lets it use the machinery that is already here, the way `ward` does. What it needed that
 * nothing else did is the **zone**: this is an ability of a card on the *stack*, so the trigger
 * says `self` and `raise` offers a cast to the card being cast. See the `self` field on the
 * `spell-cast` trigger, and `cascadeFrom` for the half that is not casting anything.
 *
 * A function rather than a constant because the family is bigger than this one card — storm,
 * replicate and conspire are all "when you cast this spell" — and because the day a card has
 * cascade *and* text of its own, its script wants this in a list beside the rest.
 */
function cascade(): TriggerDef {
  return {
    on: { kind: 'spell-cast', self: true },
    description: 'Cascade',
    effect: (c) => cascadeFrom(c),
  };
}

/**
 * Bloodbraid Elf: a 3/2 with haste that casts a second spell for nothing.
 *
 * The pool's first cascade card, and the one every player who knows the keyword expects to see.
 * Four mana for a hasty 3/2 is a fair rate on its own; the cascade is the reason the card has been
 * printed in six formats, because a deck of cheap cards turns it into two spells for one card and
 * one of them is free.
 *
 * It wants a curve rather than a theory, which is why this deck is where it goes: Kindle Grove runs
 * eleven nonland cards at three mana or less — two Lightning Bolts, two Lightning Strikes, two
 * Rancors, two Prey Upons, a Flame Slash, a Giant Growth and a Rampant Growth — so the hit is
 * usually a real card rather than the first land off the top. Which is also the honest limit of
 * the keyword in a sixty-card deck: twenty-three of those cards are lands, and a cascade that
 * walks past four of them before finding a Bolt has given its owner a worse library as well as a
 * free spell.
 */
const BLOODBRAID_ELF: CardScript = {
  name: 'Bloodbraid Elf',
  keywords: ['haste'],
  triggers: [cascade()],
};

/**
 * Storm, written out as the triggered ability the keyword abbreviates (CR 702.40a).
 *
 * The second card down the path cascade built, and it needed one thing cascade did not: a count of
 * **how many spells have been cast this turn**. Nothing else in this engine was a fact about a
 * turn rather than about a permanent, a seat or the stack — a Lightning Bolt cast and resolved two
 * spells ago leaves no trace in a graveyard that a Lightning Bolt cast last turn does not — so
 * `GameState.spellsCastThisTurn` is a running total and `StackObject.castNumber` is each spell's
 * snapshot of it.
 *
 * The snapshot is the half worth being careful about. The count this spell cares about is the one
 * taken **as it was cast**, not as its trigger resolves: an opponent answering a storm spell casts
 * a spell of their own in between, and that one was not cast "before it". Reading the live total
 * would quietly make every answer to a storm spell a copy for its caster.
 *
 * Copies rather than a bigger effect, through the same `copySpellOnStack` that Twincast uses — so
 * a copy is not cast (CR 707.10), rings no cast trigger, and is not itself a spell for the next
 * storm count. They go on above the original and resolve first, which is the order a player sees:
 * the copies, then the spell.
 */
function storm(): TriggerDef {
  return {
    on: { kind: 'spell-cast', self: true },
    description: 'Storm — copy this spell for each spell cast before it this turn',
    effect: (c) => {
      const id = c.answering;
      if (id === undefined) return c.state;
      const copies = c.state.stackObjects[id]?.castNumber ?? 0;
      let next = c.state;
      for (let i = 0; i < copies; i += 1) next = copySpellOnStack(next, id, c.controller);
      return next;
    },
  };
}

/**
 * Grapeshot: one damage, and one more for every spell this turn.
 *
 * The pool's first storm card, and the one that makes the keyword legible: a {R} sorcery for one
 * damage is unplayable on its own, and the fourth spell of a turn is four damage spread wherever
 * you like. It is in Arc Tempest because that deck is the only one in the pool that casts three
 * cheap spells in a turn as a matter of course — the storm count is the deck's own plan, written
 * on a card.
 *
 * Each copy keeps the original's target, which is what the rules do (CR 707.10) and not a
 * simplification of "choose new targets for each copy": the copies may be re-aimed and the engine
 * does not offer it, so a Grapeshot pointed at a player is four damage to that player rather than
 * one each to four creatures. The narrower reading, and the one that cannot be wrong in the
 * player's favour.
 */
const GRAPESHOT: CardScript = {
  name: 'Grapeshot',
  targets: [ANY_TARGET],
  triggers: [storm()],
  onResolve: (c) => damageFirstTarget(c, 1),
};

/**
 * Fiery Temper: three damage for three mana, or for one if you were throwing it away anyway.
 *
 * The pool's first madness card, and it is in Ashen Rite for the card already in that list:
 * **Faithless Looting**, which discards two and is cast in 23 games of 96 — the busiest discard
 * outlet in the pool. That is the whole of what madness is for. A Temper discarded to the Looting
 * is a Lightning Bolt for {R} and a card that would otherwise have been a cost.
 *
 * Two declarative lines and nothing else new, which is the point of the field: the engine installs
 * the replacement (see `replaceZoneChange`) and reads the cost from the same place `legalActions`
 * prices the play from.
 *
 * The printed card is a sorcery, and the madness cast is not bound by that: the offer is made the
 * moment the discard happens, which can be in anybody's turn with anything on the stack
 * (CR 702.35a). That is the keyword rather than a liberty — it is why the card is played in decks
 * that discard at instant speed — and the engine gets it for nothing, because an offered cast
 * ignores the timing the way cascade's does.
 */
const FIERY_TEMPER: CardScript = {
  name: 'Fiery Temper',
  targets: [ANY_TARGET],
  madness: { cost: '{R}' },
  onResolve: (c) => damageFirstTarget(c, 3),
};

/**
 * Evoke's second half, written out as the triggered ability the keyword abbreviates (CR 702.74a).
 *
 * "Evoke {2}{U}" means two things: an alternative cost, which is `CardScript.evoke` and is the
 * engine's half, and "when this permanent enters, if its evoke cost was paid, sacrifice it" —
 * which is an ordinary triggered ability with an intervening-if clause, and so is this. Writing it
 * out rather than building a mechanism for it is the same decision `cascade()` and `storm()` were:
 * the engine already asks an intervening-if twice (CR 603.4), already sacrifices permanents, and
 * already knows how to put two of a card's triggers on the stack at once.
 *
 * The condition reads a **counter**, because by the time the ability triggers the stack object is
 * gone and a Mulldrifter on the battlefield is a Mulldrifter however it was paid for. See `EVOKED`
 * for why the fact is kept on the permanent, and `completeResolution` for where it is written.
 *
 * **Listed first in a card's triggers, and that ordering is the card.** Triggers of one controller
 * go on the stack in the order their card lists them, so the first listed is at the bottom and
 * resolves last (CR 603.3b gives the controller that choice, and this is the choice every player
 * makes). A Mulldrifter whose sacrifice resolved before its draw would be three mana for nothing
 * at all.
 */
const evokeSacrifice = (): TriggerDef => ({
  on: { kind: 'etb' },
  description: 'sacrifice it, because its evoke cost was paid',
  condition: (c) => (c.state.instances[c.source]?.counters[EVOKED] ?? 0) > 0,
  // Through `sacrificeSelf`, which is a no-op for a permanent that is no longer on the
  // battlefield: an evoked creature killed in response to its own entry trigger is already gone,
  // and a sacrifice is something you do to a permanent you control. Called rather than passed,
  // because it is declared further down this file than the card that wants it.
  effect: (c) => sacrificeSelf(c),
});

/**
 * Mulldrifter: a 2/2 flier that draws two cards, or three mana that draws two cards.
 *
 * The card evoke was printed for, and the reason the keyword is worth an engine path at all. Five
 * mana for a 2/2 flier and two cards is a fair card; {2}{U} for two cards is a Divination; and the
 * whole of what the player buys is **getting to choose which of the two a turn is for**. No other
 * card in this pool is two different cards depending on how much mana is untapped.
 *
 * It is in Tidal Mind because that deck's documented problem is the one this card is two answers
 * to. `killed-by.mjs` said the deck loses to combat damage having answered four or five things and
 * killed nobody (D139), and the six-slot rebuild that followed was all clock: what it still does
 * on a turn with three mana and nothing to answer is draw a card and pass. A Mulldrifter is the
 * Divination on that turn and the flier on the turn the game has gone long — the same slot, twice.
 *
 * It takes the **Think Twice**, which is the deck's other "draw a card and pass" and the one card
 * here whose script Arc Tempest also runs two copies of, so flashback keeps a home either way.
 */
const MULLDRIFTER: CardScript = {
  name: 'Mulldrifter',
  keywords: ['flying'],
  evoke: { cost: '{2}{U}' },
  triggers: [
    evokeSacrifice(),
    { on: { kind: 'etb' }, description: 'draw two cards', effect: (c) => draw(c.state, c.controller, 2) },
  ],
};

/**
 * Dash's second half, written out as the delayed ability the keyword abbreviates (CR 702.109a).
 *
 * The return the engine schedules as a dashed creature arrives. It is a card's trigger rather than
 * something the engine invents for the same reason unearth's exile is one: a delayed ability is put
 * on the stack by index into its source's own triggers, so it gets a resolution path, a description
 * and a place anybody can respond to without a second mechanism being built for it.
 *
 * `step: 'end'` with `of: 'any'`, which is what "the next end step" means — a creature dashed on
 * somebody else's turn goes home at the end of that one. And the bounce is guarded the way
 * `sacrificeSelf` is: a dashed creature that was killed, exiled or bounced before the end step
 * leaves this ability behind, and an ability whose creature has gone does as much as it can, which
 * is nothing (CR 608.2).
 */
const dashReturn = (): TriggerDef => ({
  on: { kind: 'step', step: 'end', of: 'any' },
  delayed: true,
  description: 'return it to its owner\'s hand',
  effect: (c) => {
    const id = c.subject;
    if (id === undefined || c.state.instances[id]?.zone !== 'battlefield') return c.state;
    return bounceToHand(c.state, id);
  },
});

/**
 * Ninjutsu, written out as the activated ability the keyword abbreviates (CR 702.49a).
 *
 * A factory rather than text on the one card that prints it, because two readings need the same
 * ability: the hand-written Ninja of the Deep Hours below, and `keywordScriptFor`, which reads the
 * printed `Ninjutsu {1}{U}` line off any card that declares it. The `ninjutsu` field is audit-only
 * — nothing in the engine offers a play from it — so a reading that set the field and stopped would
 * be a card whose keyword does nothing at all. D364's rule: the declaration and the ability it
 * declares are one unit of compilation.
 *
 * `returnsUnblockedAttacker` is the half of the cost that is not mana, and it is what
 * `collectLegalActions` reads to decide this ability is used from the **hand** and does not spend
 * the card. The effect reads `c.enteringAttack` rather than the combat because the attacker whose
 * place this is taking is in a hand by the time it resolves — see `StackObject.enteringAttack`.
 */
const ninjutsuAbility = (mana: string): AbilityDef => ({
  cost: { mana, returnsUnblockedAttacker: true },
  description: `Ninjutsu ${mana} (return an unblocked attacker you control to hand)`,
  effect: (c) => (c.enteringAttack === undefined
    ? c.state
    : enterAttacking(c.state, c.source, c.controller, c.enteringAttack)),
});

/**
 * Mardu Scout: a 3/1 for two, or three damage for one mana and the card back.
 *
 * Evoke's mirror, in the deck that wants the other half of the trade. A Mulldrifter cast cheaply
 * gives up the body for the spell; a Mardu Scout cast cheaply **is** the body, for one turn — {R},
 * haste, three damage, and the card is in your hand again at the end step to do it all over.
 *
 * That makes it a different kind of card from the Hellspark Elemental already in this list, which
 * is the comparison worth having. The Hellspark is three damage for two mana that then goes to the
 * graveyard, and buying it back costs another {1}{R} and the unearth. The Scout costs **one** mana
 * a turn and keeps costing it, for ever, because nothing it does puts it anywhere but your hand —
 * and the price of that is it can never block, never stay, and never be the board you win with.
 * The printed body is the other choice: two mana for a 3/1 that stays, which is what you cast it as
 * when the game has gone long enough that a 3/1 blocker matters more than three damage now.
 */
const MARDU_SCOUT: CardScript = {
  name: 'Mardu Scout',
  dash: { cost: '{R}' },
  triggers: [dashReturn()],
};

/**
 * Boon Satyr: a 4/2 with flash, or an Aura that gives +4/+2 and then stands up as a 4/2.
 *
 * The pool's first bestow card, and the one the keyword was printed around. Three mana for a 4/2
 * at instant speed is a fair card on its own; five mana to make somebody else +4/+2 is a *bad*
 * card on its own — and the two together are neither, because the player chooses which one the
 * turn needs and never loses the card to the choice.
 *
 * The thing worth saying about it in this engine is what it is **not**. While it is bestowed it is
 * not a creature: a Day of Judgment leaves it alone, "counter target creature spell" cannot touch
 * it on the stack, and it does not attack or block. And the moment the creature it enchants dies
 * it stops being an Aura and becomes the 4/2 — which is the one rule here that changes a
 * permanent's type where it stands. Both halves are the engine's rather than the card's: see
 * `CardScript.bestow`, `CardInstance.bestowed` and the state-based action in `automation.ts`.
 *
 * Flash is the printed keyword and it applies to **both** castings, which is the rules rather
 * than a convenience: a bestowed Satyr at the end of an opponent's turn is +4/+2 on a blocker they
 * have already declared, and that is what the card is for.
 */
const BOON_SATYR: CardScript = {
  name: 'Boon Satyr',
  keywords: ['flash'],
  bestow: { cost: '{3}{G}{G}', effect: { power: 4, toughness: 2 } },
};

/**
 * Skewer the Critics: three damage for three mana, or for one once somebody has been hit.
 *
 * The pool's first spectacle card, and the keyword's whole shape in one line: it is a Lightning
 * Bolt on any turn the board has already done something, and a bad Lava Spike on a turn it has
 * not. That makes it the first card here whose *price* depends on the turn's history rather than on
 * the card, the zone or the board — see `GameState.lifeLostThisTurn`.
 *
 * It is in Ashen Rite because that deck earns the condition without trying. Two Blood Artists, a
 * Zulaport Cutthroat, a Fate Unraveler and an Impact Tremors all take life off the other seat
 * whenever anything happens, and five burn spells do it on purpose — so by the time three mana is
 * available the one-mana price usually is too.
 *
 * Two declarative lines and nothing else: the spell does exactly what it does for either cost, and
 * what the keyword changes is the price. That is the difference from evoke, dash and bestow, each
 * of which had a consequence to build.
 */
const SKEWER_THE_CRITICS: CardScript = {
  name: 'Skewer the Critics',
  targets: [ANY_TARGET],
  spectacle: { cost: '{R}' },
  onResolve: (c) => damageFirstTarget(c, 3),
};

/**
 * Mizzium Mortars: four damage to one of theirs, or to all of them.
 *
 * The pool's first overload card, and the shape of the keyword in one script: two `onResolve`
 * functions on one name. The printed one reads `c.targets`; the overload one reads the board and
 * never looks at a target, because an overloaded spell has none (CR 702.96a).
 *
 * Writing it as two functions rather than one that branches on a flag is the honest shape — the
 * two halves are two different spells — and it is also the only shape that works: the printed half
 * would have to guard every line against an empty target list, and the overloaded half would have
 * to ignore a target it was never given.
 *
 * "You don't control" rather than "an opponent controls", as printed. The two are the same thing in
 * a duel and not in a pod, where the difference is somebody else's token: `zoneSeat !== controller`
 * is what both halves ask, so the one-target cast and the sweep agree about whose creatures they
 * are allowed to hit.
 */
/*
  ── Energy ─────────────────────────────────────────────────────────────────────────────────────

  Four cards for the resource that is not mana (CR 122). Energy counters live on the **player**,
  they are never emptied, and no card in this pool had ever used `Seat.counters` — so these four
  are the whole of the mechanic: two that give it, two that spend it, and one that does both.

  What makes them worth more than four scripts is the shape they add. Every other resource here is
  spent on the turn you get it (mana), is a number you are trying to keep (life), or only ever
  grows (the graveyard). Energy is the first that a deck **saves up**, which is also the first
  thing in this pool the bot can get wrong by doing nothing.
*/

/**
 * Aether Hub: a land that pays for one spell of any colour, once.
 *
 * The card that makes energy a *mana* resource as well as a counter, and the only land in the pool
 * whose second ability has a cost besides tapping. Both abilities are mana abilities — they
 * resolve without the stack (CR 605.3a) — so paying the energy happens where every other cost is
 * paid, as the ability is activated.
 */
const AETHER_HUB: CardScript = {
  name: 'Aether Hub',
  triggers: [{
    on: { kind: 'etb' },
    description: 'When Aether Hub enters the battlefield, you get {E}.',
    effect: (c) => addEnergy(c.state, c.controller, 1),
  }],
  abilities: [
    { cost: { tap: true }, description: '{T}: Add {C}.', produces: ['C'] },
    ...COLOURS.map((colour) => ({
      cost: { tap: true, energy: 1 },
      description: `{T}, Pay {E}: Add {${colour}}.`,
      produces: [colour],
    })),
  ],
};

/**
 * Longtusk Cub: the creature that pays for itself, if it connects.
 *
 * The other half of the mechanic — a card that *makes* energy rather than spending it — and the
 * engine's second user of the `combat-damage` trigger, which fires only when this creature's own
 * damage reaches a player. Two energy a hit, two energy a counter, so the Cub that gets through
 * once grows once and the one that is blocked all game is a 2/2 for two.
 */
const LONGTUSK_CUB: CardScript = {
  name: 'Longtusk Cub',
  triggers: [{
    on: { kind: 'combat-damage' },
    description: 'Whenever Longtusk Cub deals combat damage to a player, you get {E}{E}.',
    effect: (c) => addEnergy(c.state, c.controller, 2),
  }],
  abilities: [{
    cost: { energy: 2 },
    description: 'Pay {E}{E}: Put a +1/+1 counter on Longtusk Cub.',
    effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
  }],
};

/**
 * Bristling Hydra: three energy on arrival, and the one card here that spends energy to *survive*.
 *
 * Hexproof until end of turn is the rule that makes a four-mana 4/3 a real threat: the removal
 * spell on the stack fizzles, which is a use for a resource that nothing else in this pool has —
 * every other saved-up thing here is spent on offence.
 */
const BRISTLING_HYDRA: CardScript = {
  name: 'Bristling Hydra',
  triggers: [{
    on: { kind: 'etb' },
    description: 'When Bristling Hydra enters the battlefield, you get {E}{E}{E}.',
    effect: (c) => addEnergy(c.state, c.controller, 3),
  }],
  abilities: [{
    cost: { energy: 3 },
    description: 'Pay {E}{E}{E}: Put a +1/+1 counter on Bristling Hydra. It gains hexproof until end of turn.',
    effect: (c) => pump(
      addCounters(c.state, c.source, '+1/+1', 1),
      [c.source],
      c.source,
      c.controller,
      { keywords: ['hexproof'], duration: 'end-of-turn' },
    ),
  }],
};

/**
 * Harnessed Lightning: the first spell whose effect asks **how much of a resource to spend**.
 *
 * Three energy, then any amount of it as damage, which is a question the engine already had the
 * shape for — `NumberDecisionSpec`, built for Toxic Deluge's life payment (D130) — pointed at a
 * different pot. The energy arrives in `beforeDecisions` because the card gives it to you *first*
 * and the number you may choose depends on what you now have: a Harnessed Lightning with no
 * energy saved can still deal three.
 *
 * `best` is what the bot does with it, and it is deliberately not "spend everything": the smallest
 * amount that kills the creature, or nothing at all when nothing it has will. Energy saved is a
 * Bristling Hydra protected later, and this is the one card in the pool that can throw a resource
 * away by overpaying.
 */
const HARNESSED_LIGHTNING: CardScript = {
  name: 'Harnessed Lightning',
  removesACreature: true,
  targets: [TARGET_CREATURE],
  beforeDecisions: (c) => addEnergy(c.state, c.controller, 3),
  decisions: [{
    who: 'controller',
    prompt: 'Pay how much energy?',
    range: (state, chooser) => ({ min: 0, max: energyOf(state, chooser) }),
    best: (state, chooser) => {
      /*
        The cheapest kill, or nothing.

        `state` here is the board after the three energy have arrived, so the maximum is what the
        card actually offers. What it is looking for is the target's toughness less the damage
        already marked on it — the same arithmetic a player does — and anything above that is
        energy burned for no extra effect, because this damage does not carry over.
      */
      const max = energyOf(state, chooser);
      for (const id of battlefield(state)) {
        const inst = state.instances[id];
        if (inst === undefined || inst.zoneSeat === chooser) continue;
        const ch = characteristicsOf(state, inst);
        if (!ch.isCreature) continue;
        const needed = ch.toughness - (inst.damage ?? 0);
        if (needed > 0 && needed <= max) return needed;
      }
      return 0;
    },
  }],
  onResolve: (c) => {
    const paid = Math.min(c.decisions[0]?.amount ?? 0, energyOf(c.state, c.controller));
    if (paid <= 0) return c.state;
    // Spent first, because it is the cost of the damage rather than part of it — and because a
    // target that has left since the spell was cast should still cost the energy announced.
    return damageFirstTarget({ ...c, state: spendEnergy(c.state, c.controller, paid) }, paid);
  },
};

const MIZZIUM_MORTARS: CardScript = {
  name: 'Mizzium Mortars',
  targets: [{ ...TARGET_CREATURE, description: "target creature you don't control", filter: creatureYouDontControl }],
  onResolve: (c) => damageFirstTarget(c, 4),
  overload: {
    cost: '{3}{R}{R}{R}',
    onResolve: (c) => {
      let state = c.state;
      for (const id of battlefield(state, (cardId) => {
        const inst = state.instances[cardId];
        if (inst === undefined || inst.zoneSeat === c.controller) return false;
        return characteristicsOf(state, inst).isCreature;
      })) {
        state = dealDamage(state, { kind: 'card', id }, 4, { controller: c.controller, source: c.source });
      }
      return state;
    },
  },
};

const PLANAR_VOID: CardScript = {
  name: 'Planar Void',
  triggers: [
    {
      on: { kind: 'to-graveyard' },
      description: 'exile that card',
      /*
        No target: "that card" is the one the event was about, which arrives through
        `EffectContext.subject` the way exalted's creature does. A targeted version would be a
        different card — it would be answerable by moving the card, and it would stop at one
        choice per trigger rather than exiling everything.
      */
      effect: (c) => (c.subject === undefined ? c.state : exileCard(c.state, c.subject)),
    },
  ],
};

/**
 * Rest in Peace: the graveyard stops being a zone, for everybody.
 *
 * The first card written against the engine's **widest** replacement wording, and the card that
 * asked for it. Planar Void (D153) is the same idea printed as a *trigger* — "whenever another
 * card is put into a graveyard, exile that card" — so the card really does reach the graveyard and
 * is exiled afterwards, which is why a Blood Artist still sees the death. Rest in Peace says
 * **instead**: nothing ever arrives, so a death is not a card in a graveyard, a flashback card is
 * gone before its own controller could look at it, and a Gravedigger has nothing to read.
 *
 * Two halves and both are the card. The arrival empties every graveyard that already exists,
 * because otherwise the replacement would only apply to the rest of the game; the replacement is
 * what keeps them empty.
 *
 * **Unconditional, itself included.** A destroyed Rest in Peace exiles itself — the printed card
 * replaces the move of "a card", not "another card", and its ability still applies to the event
 * that is taking it away. The engine asks the moving card's own effects first (D183), so this
 * works without the enchantment having to still be on the battlefield.
 *
 * It is in **Skyward Writ**, none of whose sixty cards reads a graveyard: no flashback, no escape,
 * no Gravedigger, nothing that buys back a card it has already spent. A symmetrical card in a deck
 * that pays nothing for it is a one-sided card, and that is the whole reason this slot is there
 * rather than in Dawn Tithe, which runs Bone Splinters and a Blood Artist. The exception is a
 * **pod**: Skyward Writ's commander is Hanna, Ship's Navigator, who returns an artifact or
 * enchantment from her controller's graveyard, so in Commander the two cards fight.
 */
const REST_IN_PEACE: CardScript = {
  name: 'Rest in Peace',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'exile all cards from all graveyards',
      effect: (c) => {
        let state = c.state;
        for (const seat of state.seats) {
          // A copy of the list first: exiling walks the same zone this is iterating.
          for (const id of [...listAt(state, zoneKey(seat.index, 'graveyard'))]) {
            state = exileCard(state, id);
          }
        }
        return state;
      },
    },
  ],
  replaces: [
    {
      on: 'to-graveyard',
      description: 'exile it instead',
      applies: () => true,
      instead: (c) => exileCard(c.state, c.subject),
    },
  ],
};

const anyGraveyardCard: TargetSpec = {
  kind: 'graveyard-card',
  // Any graveyard, which is what the card says: no filter, because "a graveyard" is not "your
  // graveyard" and the Ooze is at its best eating somebody else's.
  description: 'target card in a graveyard',
};

const SCAVENGING_OOZE: CardScript = {
  name: 'Scavenging Ooze',
  abilities: [
    {
      cost: { mana: '{G}' },
      targets: [anyGraveyardCard],
      description: '{G}: Exile target card from a graveyard. If it was a creature card, put a '
        + '+1/+1 counter on Scavenging Ooze and you gain 1 life.',
      effect: (c) => {
        const id = firstCardTarget(c);
        if (id === null) return c.state;
        /*
          Asked **before** the exile, because "if it was a creature card" is a question about the
          card that was there and a card in exile is no easier to read than one in a graveyard —
          but the order is what makes the sentence true rather than a coincidence, and the next
          effect written this way might move the card somewhere that forgets.

          The printed type line rather than `characteristicsOf`: a card in a graveyard has no
          continuous effects applied to it, so what it is is what is printed on it.
        */
        const inst = c.state.instances[id];
        const wasCreature = inst !== undefined
          && hasType(parseTypeLine(c.state.cardDefs[inst.defKey]?.typeLine), 'creature');
        const next = exileCard(c.state, id);
        if (!wasCreature) return next;
        return gainLife(addCounters(next, c.source, '+1/+1', 1), c.controller, 1);
      },
    },
  ],
};

const TREASURE_CRUISE: CardScript = {
  name: 'Treasure Cruise',
  delve: true,
  onResolve: (c) => drawLater(c.state, c.controller, 3),
};

// ── The library as the thing you attack ──────────────────────────────────────────────────────────

/*
  Hollow Tide's cards, and the first win condition in this pool that is not damage.

  The engine has been able to end a game this way since state-based actions were written — a player
  who cannot draw has lost (CR 704.5b) — and nothing had ever tried to do it on purpose. `mill` has
  existed for as long, for Jace Beleren's ultimate and a Tome Scour nobody built a deck around.

  Two of these carry the trigger that came with them: **"whenever this deals combat damage to a
  player"**, which is the most-printed trigger in Magic and which this pool simply did not have. It
  is recorded in `dealCombatDamage` and announced by `settle`, like a death or an arrival, and it
  fires only when the damage actually landed — so a Magpie stopped by a Fog draws nothing.
*/

/**
 * Mirko Vosk: a 2/4 flier that eats a library four lands at a time.
 *
 * "Mills until they reveal four land cards" is a loop rather than a number, and the number it comes
 * to is a fact about their deck: against a 22-land sixty it averages something like eleven cards a
 * hit, and against a graveyard-light deck that has drawn its lands it can be twenty. The loop is
 * written out rather than approximated with a count, because the printed card is the loop and the
 * variance *is* the card.
 *
 * Guarded on the library emptying, which is the case the card exists to produce: when the fourth
 * land never turns up the library simply ends, and losing for it is the draw step's business
 * (CR 704.5b) rather than this trigger's.
 */
const MIRKO_VOSK: CardScript = {
  name: 'Mirko Vosk, Mind Drinker',
  keywords: ['flying'],
  triggers: [
    {
      on: { kind: 'combat-damage' },
      description: 'that player mills until they reveal four land cards',
      effect: (c) => {
        if (c.attacked === undefined) return c.state;
        const seat = c.attacked.defender;
        let state = c.state;
        let lands = 0;
        // A bounded loop over a library that only ever shrinks: sixty is the deck, and a guard
        // that cannot be reached is still cheaper than a loop that cannot be proved to end.
        for (let i = 0; i < 200 && lands < 4; i += 1) {
          const top = listAt(state, zoneKey(seat, 'library'))[0];
          if (top === undefined) break;
          const isLand = hasType(parseTypeLine(state.cardDefs[state.instances[top]?.defKey ?? '']?.typeLine), 'land');
          state = mill(state, seat, 1);
          if (isLand) lands += 1;
        }
        return state;
      },
    },
  ],
};

/** The same trigger on a one-card-a-hit flier, which is what the shape is usually printed on. */
const THIEVING_MAGPIE: CardScript = {
  name: 'Thieving Magpie',
  keywords: ['flying'],
  triggers: [
    {
      on: { kind: 'combat-damage' },
      description: 'draw a card',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
  ],
};

const MIND_SCULPT: CardScript = {
  name: 'Mind Sculpt',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return seat === null ? c.state : mill(c.state, seat, 7);
  },
};

/** Two off the top and one into your hand: the mill card that is never a dead draw. */
const THOUGHT_SCOUR: CardScript = {
  name: 'Thought Scour',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return draw(seat === null ? c.state : mill(c.state, seat, 2), c.controller, 1);
  },
};

/**
 * Three off the top, or a card when three is not what the game needs.
 *
 * Cycling on a mill spell is the deck's own answer to its worst problem: a hand of mill against a
 * board that is killing you. The ability is the one already written for the cycling lands —
 * `discardSelf`, which carries its own "from the hand" restriction.
 */
/**
 * Cycling, written out as the activated ability the keyword abbreviates (CR 702.29a).
 *
 * "Cycling {2}" means "{2}, Discard this card: Draw a card" — the whole of it, printed nowhere else
 * on the card. So the declaration *is* the ability, which is what makes it safe for
 * `keywordScriptFor` to build (D364), and it is the third-largest keyword bucket in the corpus at
 * 192 cards (D426).
 *
 * `discardSelf` is the half that is not mana, and it is what tells `collectLegalActions` the ability
 * is used **from the hand** and spends the card. `drawLater` rather than `draw` for the reason that
 * primitive exists: a draw the controller is owed is taken as a move they make, so a player drawing
 * their last card can be asked what to do before it resolves.
 *
 * A factory so the hand-written card and the compiled reading are one ability rather than two
 * spellings of it — `ninjutsuAbility`'s arrangement (D421).
 */
const cyclingAbility = (mana: string): AbilityDef => ({
  cost: { mana, discardSelf: true },
  description: `${mana}, Discard this card: Draw a card.`,
  effect: (c) => drawLater(c.state, c.controller, 1),
});

const COMPELLING_ARGUMENT: CardScript = {
  name: 'Compelling Argument',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return seat === null ? c.state : mill(c.state, seat, 3);
  },
  abilities: [cyclingAbility('{U}')],
};

/** A 2/4 body that mills four on the way in: the blocker this deck needs, attached to its plan. */
const RETURNED_CENTAUR: CardScript = {
  name: 'Returned Centaur',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'target player mills four cards',
      targets: [TARGET_PLAYER],
      effect: (c) => {
        const seat = firstPlayerTarget(c);
        return seat === null ? c.state : mill(c.state, seat, 4);
      },
    },
  ],
};

/**
 * Nemesis of Reason: ten cards a swing, and a 3/7 that survives swinging.
 *
 * The attack trigger rather than the damage trigger, which is the printed card and a better one:
 * it does not care whether the attack is blocked, so a chump blocker buys a life total and nothing
 * else. `c.attacked.defender` is the player this attack was declared against, which in a pod is
 * not "the opponent".
 */
const NEMESIS_OF_REASON: CardScript = {
  name: 'Nemesis of Reason',
  triggers: [
    {
      on: { kind: 'attacks' },
      description: 'defending player mills ten cards',
      effect: (c) => (c.attacked === undefined ? c.state : mill(c.state, c.attacked.defender, 10)),
    },
  ],
};

/**
 * Psychic Strike: a Counterspell that also takes two cards off the top.
 *
 * The two cards come off the *spell's controller*, read from the stack object rather than from
 * "the opponent" — which matters at a four-player table, where the spell being countered may
 * belong to any of three players, and which is free because the stack already knows.
 */
const PSYCHIC_STRIKE: CardScript = {
  name: 'Psychic Strike',
  targets: [TARGET_SPELL],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    if (id === null) return c.state;
    const owner = c.state.stackObjects[id]?.controller;
    const countered = counterSpell(c.state, id);
    return owner === undefined ? countered : mill(countered, owner, 2);
  },
};

/**
 * Jace, Memory Adept: ten cards a turn, for as long as it is left alone.
 *
 * The second planeswalker in the pool and the first whose *plus* ability is the win condition
 * rather than value — which is what a mill deck wants from four mana: a threat an opponent has to
 * attack rather than a spell they can answer. The zero keeps it useful when milling ten is not what
 * the turn needs, and gives the search something to compare it against.
 */
const JACE_MEMORY_ADEPT: CardScript = {
  name: 'Jace, Memory Adept',
  abilities: [
    {
      cost: { loyalty: 1 },
      description: '+1: Target player mills ten cards.',
      targets: [TARGET_PLAYER],
      effect: (c) => {
        const seat = firstPlayerTarget(c);
        return seat === null ? c.state : mill(c.state, seat, 10);
      },
    },
    {
      cost: { loyalty: 0 },
      description: '0: Draw a card.',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
  ],
};

// ── Helpers the scripts above share ──────────────────────────────────────────────────────────────

/** "deals N damage to any target" — the target may be a creature or a player. */
function damageFirstTarget(c: EffectContext, amount: number): GameState {
  const target = c.targets[0];
  if (target === undefined) return c.state;
  return dealDamage(c.state, target, amount, { controller: c.controller, source: c.source });
}

/**
 * The same amount to **every** target, which is what "to each of up to two target creatures" says.
 *
 * `damageFirstTarget` above is the reader for a spec whose `count` is one, and it is still the
 * right one for the hand-written cards that call it. The compiler's two open-phrase damage readers
 * are not: `each of up to two` is a quantifier `parsedTargetPhrase` accepts, so Dual Shot and Fire
 * Shrine Keeper compiled a spec asking for two creatures and dealt their damage to one. Same defect
 * as D470's five, found in the same pass by asking which other reader takes a phrase rather than a
 * fixed sentence.
 *
 * Not the same thing as `dividedAmong`, which is the other multi-target damage shape and splits one
 * budget between the targets (CR 601.2d). This repeats the whole amount on each, which is what the
 * printed "to each of" says and the reason the two cannot share an effect.
 *
 * Folding over `c.targets` rather than `cardTargets` because a damage spec can be `any target`: a
 * player is a legal one and `dealDamage` takes either.
 */
function damageEveryTarget(c: EffectContext, amount: number): GameState {
  return c.targets.reduce(
    (state, target) => dealDamage(state, target, amount, { controller: c.controller, source: c.source }),
    c.state,
  );
}

/** "Prevent the next N damage that would be dealt to any target" — a creature or a player. */
function shieldFirstTarget(c: EffectContext, amount: number): GameState {
  const target = c.targets[0];
  if (target === undefined) return c.state;
  return preventDamage(c.state, c.source, c.controller, target, amount);
}

/**
 * "Prevent the next N damage that would be dealt to you and/or permanents you control this turn,
 * and deal that much to the target instead" — redirection (CR 615.9).
 *
 * The shape both redirection cards in the pool share, so the two differ by their cost and by where
 * N comes from and by nothing else. The target is where the points *go*, not what is protected:
 * the protected side is always the caster's, which is what the printed cards say and why neither of
 * them targets it.
 */
function redirectToFirstTarget(c: EffectContext, amount: number): GameState {
  const target = c.targets[0];
  if (target === undefined || amount <= 0) return c.state;
  return preventDamageToSide(c.state, c.source, c.controller, c.controller, amount, target);
}

/** Creature cards in a seat's own graveyard, which several cards in Rot Harvest count. */
function creatureCardsInGraveyard(state: GameState, seat: SeatIndex): number {
  let n = 0;
  for (const id of state.zones[`${seat}:graveyard`] ?? []) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    if (hasType(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), 'creature')) n += 1;
  }
  return n;
}

/**
 * Creatures of one subtype that a seat controls, read **live** (CR 613).
 *
 * This was `goblinCount` until the compiler needed the same count for Krenko's printed phrase: one
 * function, so the compiled ability and the hand-written one count the same creatures rather than
 * being two readings of "the number of Goblins you control".
 */
function creaturesOfSubtype(state: GameState, seat: SeatIndex, subtype: string): number {
  let n = 0;
  for (const id of state.zones[`${seat}:battlefield`] ?? []) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (ch.isCreature && hasSubtype(ch.typeLine, subtype.toLowerCase())) n += 1;
  }
  return n;
}

/** Lands a seat controls, live — an animated land is still a land. */
function landsControlled(state: GameState, seat: SeatIndex): number {
  let n = 0;
  for (const id of state.zones[`${seat}:battlefield`] ?? []) {
    const inst = state.instances[id];
    if (inst !== undefined && characteristicsOf(state, inst).isLand) n += 1;
  }
  return n;
}

// ── Eight that needed nothing new ────────────────────────────────────────────────────────────────

/**
 * Day of Judgment: the first card in the pool that answers a board rather than a creature.
 *
 * Every deck here could kill one thing and nothing could kill six, which made a board that got
 * ahead unanswerable — and a wrath is also the sharpest test of the bot's search there is, since
 * casting it is right when it is behind and catastrophic when it is ahead, and the search has to
 * see which by playing it out.
 */
const DAY_OF_JUDGMENT: CardScript = {
  name: 'Day of Judgment',
  onResolve: (c) => {
    let state = c.state;
    for (const id of battlefield(state, (cardId) => {
      const inst = state.instances[cardId];
      return inst !== undefined && characteristicsOf(state, inst).isCreature;
    })) {
      state = destroy(state, id);
    }
    return state;
  },
};

/** Essence Scatter: a Counterspell that only answers creatures, and costs one less for it. */
const ESSENCE_SCATTER: CardScript = {
  name: 'Essence Scatter',
  targets: [{ ...TARGET_SPELL, description: 'target creature spell', filter: isCreatureSpell }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : counterSpell(c.state, id);
  },
};

/** Unsummon: not removal, time — the creature comes back, and so does the mana it cost. */
/**
 * Capsize: the pool's first **buyback** card, and the plainest statement of the keyword.
 *
 * Three mana returns a permanent to its owner's hand, which is a fair instant. Three more returns
 * the *card* to yours (CR 702.26a) — and that is the whole mechanic: the extra mana does not make
 * the spell better, it makes the spell permanent. A deck that reaches six mana holding this has an
 * answer it cannot run out of, which is why the card is famous and why it is priced where it is.
 *
 * Any permanent rather than any creature, which is the other half of what the slot costs Tidal Mind
 * — the Unsummon it replaces could only bounce a creature.
 */
const CAPSIZE: CardScript = {
  name: 'Capsize',
  buyback: { cost: '{3}', description: 'Buyback {3}' },
  /*
    No filter, which is a deletion (D420). It carried one requiring `zone === 'battlefield'`, and
    `compiled-vs-written.test.ts` flagged it because the compiled spec has none.

    The engine already requires it **twice**, in both places that can ever be asked. `legalTargets`
    enumerates candidates for a non-graveyard, non-player, non-stack spec out of the battlefield
    zone and nowhere else; and `isLegalTarget`, which validates a target somebody submitted rather
    than one the engine offered, reaches `if (inst.zone !== 'battlefield') return false` before any
    type check. So the filter could not refuse anything the engine would have allowed — a guard
    that cannot fail, which this file deletes rather than keeps, and the test that goes with it asks
    `legalTargets` for a board with a creature in a graveyard and gets only the battlefield one.
  */
  targets: [{ kind: 'permanent', description: 'target permanent' }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : bounceToHand(c.state, id);
  },
};

/**
 * Whispers of the Muse: the other thing buyback is for, which is somewhere to put the eighth land.
 *
 * One mana to draw a card is filler; six to draw a card **every turn** is a mana sink, and a deck
 * that wins slowly wants one more than it wants a two-for-one. Where Capsize asks whether an answer
 * is worth keeping, this asks what a long game is spent on.
 *
 * Its draw is `drawLater`, like every terminal draw in the pool, so a Hollow Tide holding a dredge
 * card would be asked about it on the bought-back cantrip as well as in the draw step. Nothing in
 * this deck has dredge today; the line is there because the rule at `drawLater` is about the shape
 * of the card and not about the pool.
 */
const WHISPERS_OF_THE_MUSE: CardScript = {
  name: 'Whispers of the Muse',
  buyback: { cost: '{5}', description: 'Buyback {5}' },
  onResolve: (c) => drawLater(c.state, c.controller, 1),
};

const UNSUMMON: CardScript = {
  name: 'Unsummon',
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : bounceToHand(c.state, id);
  },
};

/**
 * Icy Manipulator: the first card to point at any permanent and do something other than exile it.
 *
 * A tapper is removal that gives the thing back every turn, and it reads a different part of the
 * engine from everything else here: `tapped` is a fact about a permanent that the attack rules,
 * the block rules and `manaSources` all already respect, so one line of effect turns off a
 * creature, a land or an Equipment without any of them being told about it.
 */
const ICY_MANIPULATOR: CardScript = {
  name: 'Icy Manipulator',
  abilities: [{
    cost: { mana: '{1}', tap: true },
    description: '{1}, {T}: Tap target artifact, creature, or land.',
    targets: [{
      kind: 'permanent',
      description: 'target artifact, creature, or land',
      filter: (state, candidate, _controller, source) => {
        if (candidate.kind !== 'card') return false;
        if (candidate.id === source) return false;
        const inst = state.instances[candidate.id];
        if (inst === undefined || inst.tapped) return false;
        const ch = characteristicsOf(state, inst);
        return ch.isCreature || ch.isLand || hasType(ch.typeLine, 'artifact');
      },
    }],
    effect: (c) => {
      const id = firstCardTarget(c);
      return id === null ? c.state : tap(c.state, id);
    },
  }],
};

/**
 * Tormod's Crypt: the first card to touch a whole zone.
 *
 * Every graveyard card in the pool reads one card out of one graveyard; this reads all of them, and
 * it is the only answer any deck has to a Gravedigger loop. Free, because the card costs nothing
 * and its whole price is the slot.
 */
const TORMODS_CRYPT: CardScript = {
  name: "Tormod's Crypt",
  abilities: [{
    cost: { tap: true, sacrificeSelf: true },
    description: "{T}, Sacrifice Tormod's Crypt: Exile target player's graveyard.",
    targets: [TARGET_PLAYER],
    effect: (c) => {
      const seat = firstPlayerTarget(c);
      if (seat === null) return c.state;
      let state = c.state;
      // A copy of the list first: exiling walks the same zone this is iterating.
      for (const id of [...listAt(state, zoneKey(seat, 'graveyard'))]) state = exileCard(state, id);
      return state;
    },
  }],
};

/** Ambush Viper: a blocker that arrives after the attack is declared, and kills whatever it blocks. */
const AMBUSH_VIPER: CardScript = {
  name: 'Ambush Viper',
  keywords: ['flash', 'deathtouch'],
};

/** Elvish Visionary: a body that replaces itself, which is the cheapest card advantage there is. */
const ELVISH_VISIONARY: CardScript = {
  name: 'Elvish Visionary',
  triggers: [{
    on: { kind: 'etb' },
    description: 'draw a card',
    effect: (c) => drawLater(c.state, c.controller, 1),
  }],
};

/**
 * Lotus Petal: the Treasure as a printed card, and the pool's first spell that costs nothing.
 *
 * Same five rows and the same sacrifice, which is the point of having it: before this the engine's
 * consumed-mana-source path (D259) was held up by a token in one deck, and a path with one carrier
 * is a path that stops being exercised the day that card is cut.
 *
 * Into Forge Alliance, where it is three other things as well. That deck counts its artifacts for
 * the Frogmite's affinity, for the Etched Champion's metalcraft and for the Ravager's sacrifice
 * cost, and a Petal is all three for no mana — which is also why the slot it took is the second
 * Loxodon Warhammer rather than a creature: one artifact out, one artifact in, every count level.
 */
const LOTUS_PETAL: CardScript = {
  name: 'Lotus Petal',
  abilities: COLOURS.map((colour) => ({
    cost: { tap: true, sacrificeSelf: true },
    description: `{T}, Sacrifice Lotus Petal: Add {${colour}}.`,
    produces: [colour],
  })),
};

/**
 * Thraben Inspector: a 1/2 for {W} that comes with a card attached to it.
 *
 * "Investigate" is one word for "create a Clue token" (CR 701.33), and it is written out as the
 * token rather than as a keyword for the reason myriad is a keyword and this is not: a keyword
 * earns its place when the rules have to *consult* it, and nothing in this game ever asks whether
 * an effect was an investigation. One card's trigger is one card's trigger.
 *
 * Into Skyward Writ, which is the deck in this pool that plays the most one-ofs and the fewest
 * cards that replace themselves: a 1/2 blocker on turn one that becomes a card on turn four is two
 * of that deck's jobs in a slot, and it is the second body that deck has for its own Tandem
 * Lookout to pair with.
 */
const THRABEN_INSPECTOR: CardScript = {
  name: 'Thraben Inspector',
  triggers: [{
    on: { kind: 'etb' },
    description: 'investigate',
    effect: (c) => createToken(c.state, c.controller, CLUE_TOKEN),
  }],
};

/**
 * Pirate's Prize: two cards and a Treasure, which is the first card here that makes mana out of a
 * spell rather than out of a permanent.
 *
 * Into Tidal Mind, and the slot is the argument. That deck has been the pool's weakest since D139
 * and its diagnosis has never moved: it answers things, kills nobody, and its late turns have mana
 * and nothing to spend it on — which is the one deck a Treasure is *not* ramp for. What the Treasure
 * buys there is the turn this card is cast: four mana for two cards leaves one mana behind, so the
 * Prize and a Cancel fit under five lands, where the Prize alone would end the turn.
 *
 * The second Lonely Sandbar is the slot, which keeps the card in the pool at Skyward Writ and the
 * cycling land in the deck.
 */
const PIRATES_PRIZE: CardScript = {
  name: "Pirate's Prize",
  onResolve: (c) => createToken(draw(c.state, c.controller, 2), c.controller, TREASURE_TOKEN),
};

/** Read the Bones: two cards and a look at two more, paid for in life. */
const READ_THE_BONES: CardScript = {
  name: 'Read the Bones',
  decisions: [scry(2)],
  onResolve: (c) => loseLife(draw(c.state, c.controller, 2), c.controller, 2),
};

// ── Mana that is not a land ──────────────────────────────────────────────────────────────────────

/**
 * Sol Ring: one tap, two mana, and the first card in the pool to do it.
 *
 * `produces: ['C', 'C']` has been the documented difference between a dual land and a Sol Ring
 * since the mana solver was written — a Guildgate's two abilities are a *choice* of one mana, and
 * this is a *sum* of two — and until now nothing in the pool exercised the second half of that
 * sentence. A live code path with no card behind it is the same risk as an untested one.
 */
const SOL_RING: CardScript = {
  name: 'Sol Ring',
  abilities: [{ cost: { tap: true }, description: '{T}: Add {C}{C}.', produces: ['C', 'C'] }],
};

/** Mind Stone: a rock early, a card late — and the late half is an ability that eats itself. */
const MIND_STONE: CardScript = {
  name: 'Mind Stone',
  abilities: [
    { cost: { tap: true }, description: '{T}: Add {C}.', produces: ['C'] },
    {
      cost: { mana: '{1}', tap: true, sacrificeSelf: true },
      description: '{1}, {T}, Sacrifice Mind Stone: Draw a card.',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
  ],
};

/**
 * Birds of Paradise: any colour, which is five abilities and one tap.
 *
 * The Guildgate shape taken as far as it goes — `manaSources` collapses several free tap-for-mana
 * abilities on one permanent into a single source that makes *one of* their colours, so a bird is
 * a five-colour dual land with a 0/1 body. It is also a creature, which means it cannot be tapped
 * the turn it arrives (CR 302.6), and the engine already knew that about creatures.
 */
const BIRDS_OF_PARADISE: CardScript = {
  name: 'Birds of Paradise',
  keywords: ['flying'],
  abilities: COLOURS.map((colour) => ({
    cost: { tap: true },
    description: `{T}: Add {${colour}}.`,
    produces: [colour],
  })),
};

/**
 * Treasure: the Birds' five abilities, paid for with the permanent instead of with a tap.
 *
 * The token a dozen cards in print make and the first mana source in this engine that is **spent**.
 * `manaSources` collapses the five rows into one source that makes one of five colours, exactly as
 * it does for the bird, and then `tapSources` sacrifices it rather than leaving it tapped — so it
 * makes one mana, once, and the next untap step finds nothing to untap.
 *
 * The ordering that matters is not in here. A Treasure makes every colour, and the solver reaches
 * for the *least* flexible source that can pay a coloured pip, so a Swamp is always spent before a
 * Treasure that could also have made black. For a generic pip the two tie and the list order
 * decides, which is why `manaSources` queues the consumed sources behind the free ones.
 */
const TREASURE: CardScript = {
  name: 'Treasure',
  abilities: COLOURS.map((colour) => ({
    cost: { tap: true, sacrificeSelf: true },
    description: `{T}, Sacrifice this artifact: Add {${colour}}.`,
    produces: [colour],
  })),
};

/**
 * Clue: the same shape with a card at the end of it, and the control for the Treasure.
 *
 * Mind Stone's second row with no tap and a different payoff, which is the point — this needed no
 * engine change at all, because a sacrifice has been a payable activation cost since that card. A
 * run where the Clue is cashed and the Treasure is not is a mana-path fault and nothing else.
 */
const CLUE: CardScript = {
  name: 'Clue',
  abilities: [{
    cost: { mana: '{2}', sacrificeSelf: true },
    description: '{2}, Sacrifice this artifact: Draw a card.',
    effect: (c) => drawLater(c.state, c.controller, 1),
  }],
};

// ── Exile until this leaves the battlefield ──────────────────────────────────────────────────────

/**
 * "Exile it until ~ leaves the battlefield", which is two triggers and one link.
 *
 * The commonest removal in Magic and the fairest: the creature is not dead, it is held, and
 * killing the thing holding it gives it back. Written once here because the three cards that use
 * it differ only in what they may point at — and because a card that exiled without the return
 * half would be strictly better than its printed self, which is the kind of bug a player would
 * never report as one.
 */
const exileUntilItLeaves = (name: string, target: TargetSpec): Pick<CardScript, 'name' | 'triggers'> => ({
  name,
  triggers: [
    {
      on: { kind: 'etb' },
      targets: [target],
      description: `exile ${target.description} until ${name} leaves the battlefield`,
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : exileUntilLeaves(c.state, id, c.source);
      },
    },
    {
      on: { kind: 'leaves' },
      description: 'return the exiled card to the battlefield under its owner\u2019s control',
      effect: (c) => returnExiledBy(c.state, c.source),
    },
  ],
});

/** Banisher Priest: a 2/2 holding a creature hostage, and the creature comes back when it dies. */
const BANISHER_PRIEST: CardScript = exileUntilItLeaves('Banisher Priest', {
  kind: 'creature',
  description: 'target creature an opponent controls',
  filter: creatureYouDontControl,
});

/**
 * Destroy target artifact or enchantment.
 *
 * The first answer in this pool for the half of the board nothing could touch. Fourteen permanents
 * in it are artifacts or enchantments — a Pacifism, a Journey to Nowhere, a Loxodon Warhammer, an
 * Icy Manipulator, a Night of Souls' Betrayal that shrinks everybody's creatures — and until now a
 * Pacifism on your commander was permanent, for the rest of the game.
 *
 * `kind: 'permanent'` with a filter, which the targeting layer has expressed since Banishing Light,
 * and the type line is read from `characteristicsOf` rather than from the printed line — so a
 * creature that is *also* an artifact is a legal target, and a **bestowed** creature, which is an
 * Aura enchantment while it is attached (CR 702.103b), is one too.
 *
 * This docblock said that before the code did it. The filter read `cardDefs[...].typeLine`, the
 * printed line, which agrees for every artifact creature in the pool and disagrees on exactly the
 * card the engine went to the trouble of modelling: a Boon Satyr cast for its bestow cost is printed
 * `Creature — Satyr` and is live an `Enchantment Creature — Aura Satyr`, so a Disenchant could not
 * touch it. Four other filters read it the same way; see #319.
 *
 * The interaction worth knowing as a player: destroying a Journey to Nowhere gives the creature
 * back. That is not special-cased anywhere — the Journey's own `leaves` trigger returns what it
 * exiled, and `destroy` is just one more way for it to leave.
 */
const destroyAnArtifactOrEnchantment = (name: string): CardScript => ({
  name,
  targets: [{
    kind: 'permanent',
    description: 'target artifact or enchantment',
    filter: (state, candidate) => {
      if (candidate.kind !== 'card') return false;
      const inst = state.instances[candidate.id];
      if (inst === undefined) return false;
      const types = characteristicsOf(state, inst).typeLine;
      return hasType(types, 'artifact') || hasType(types, 'enchantment');
    },
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
});

const NATURALIZE: CardScript = destroyAnArtifactOrEnchantment('Naturalize');
const DISENCHANT: CardScript = destroyAnArtifactOrEnchantment('Disenchant');

/**
 * The response to removal, which this pool had none of.
 *
 * Every answer in it pointed one way — destroy, exile, bounce, pacify — and nothing answered back.
 * Holding one mana to save the creature somebody is pointing a Doom Blade at is one of the oldest
 * shapes in the game, and the only card that granted untargetability was Robe of Mirrors, an aura
 * cast at sorcery speed on a creature nobody was threatening yet.
 *
 * Hexproof rather than shroud, because the point is that *you* can still target it — and because
 * the engine already draws that line: `targeting.ts` refuses a hexproof permanent to opponents and
 * a shroud permanent to everybody, which is why Robe of Mirrors was written with the harsher of
 * the two.
 *
 * What makes it a card rather than a trick is the timing: cast in response, the removal spell is
 * still on the stack and its target has become illegal, so it is countered on resolution for
 * having no legal targets (CR 608.2b). Cloudshift proves the same rule from the other side — a
 * creature that left and came back is a new object — and this proves it without the card moving.
 */
const protectFromRemoval = (name: string, power: number, toughness: number): CardScript => ({
  name,
  // For the bot: a card whose whole effect expires at end of turn has done nothing unless
  // something was threatening the creature. See `protectsACreature`.
  protectsACreature: true,
  targets: [{
    kind: 'creature',
    description: 'target creature you control',
    /*
      `friendly` beside the filter, which is belt-and-braces and said so deliberately (D419).

      The filter already restricts every candidate to your own side, so the flag changes nothing
      here — it is the **ordering** hint, and `targetSpecFrom`'s own comment says it is moot where
      the phrase names a side. It is written anyway because `targetSpecFrom` threads it through for
      exactly this phrase, and a spec that differs from the compiled one by a field neither reading
      uses is a difference `compiled-vs-written.test.ts` has to carry for ever. One rule, one
      source.
    */
    friendly: true,
    filter: creatureYouControl,
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    /*
      `sizeBonus` rather than `{ power, toughness }` written out, because Dive Down's power bonus is
      **zero** and a stored `power: 0` is a continuous effect that behaves identically to one
      without the field and compares unequal to it. One source for that rule, shared with the
      compiler, which is where the disagreement showed up: the two readings of this very card
      resolved to boards that differed by nothing but `power: 0`.
    */
    const bonus = sizeBonus(power, toughness);
    return id === null || bonus === null
      ? c.state
      : pump(c.state, [id], c.source, c.controller, { ...bonus, keywords: ['hexproof'] });
  },
});

const BLOSSOMING_DEFENSE: CardScript = protectFromRemoval('Blossoming Defense', 2, 2);
const DIVE_DOWN: CardScript = protectFromRemoval('Dive Down', 0, 3);

/**
 * Journey to Nowhere: the same deal for one less mana, with no body attached.
 *
 * And `removesACreature` where a Banisher Priest does not carry it: the Priest is a 2/2 worth
 * casting for the body alone, while this is two mana for an enchantment that sits there doing
 * nothing if its entry trigger finds nothing to point at.
 */
const JOURNEY_TO_NOWHERE: CardScript = {
  ...exileUntilItLeaves('Journey to Nowhere', TARGET_CREATURE),
  removesACreature: true,
};

/**
 * Banishing Light: anything that is not a land, and not itself.
 *
 * The first card in the pool to point at a *permanent* rather than at a creature — an Equipment, an
 * enchantment, a planeswalker — which the targeting layer could already express and nothing had
 * asked for.
 *
 * **Banishing Light rather than Oblivion Ring, and the word "another" is why.** Oblivion Ring was
 * written first, and it says "exile target nonland permanent" — which, with an empty board, means
 * itself. It exiles itself, leaving the battlefield fires its own return trigger, the trigger
 * brings it back, and entering exiles it again: a real loop, printed on a real card, and the
 * engine reproduced it faithfully. Fifty iterations and a game over on turn five, in two of thirty
 * unsteered games. The fix is not a house rule in the engine — it is to print the card that says
 * "another", which is what Wizards did themselves ten years later.
 */
const BANISHING_LIGHT: CardScript = exileUntilItLeaves('Banishing Light', {
  kind: 'permanent',
  description: 'another target nonland permanent',
  filter: (state, candidate, _controller, source) => {
    if (candidate.kind !== 'card') return false;
    if (candidate.id === source) return false;
    const inst = state.instances[candidate.id];
    if (inst === undefined) return false;
    return !characteristicsOf(state, inst).isLand;
  },
});

/*
  Convoke (CR 702.51), and the two cards that carry it.

  A flag rather than a cost: convoke does not change what a spell costs, it changes what may pay
  for it, and `convokePlan` in `legalActions.ts` is where that lives. Both of these are Selesnya
  cards in the Selesnya deck, which is where the mechanic is printed and the only place it is worth
  anything — convoke needs a board of creatures to be a discount at all.

  Siege Wurm is the shape that shows the mechanic plainly: seven mana printed, a 5/5 trample, and
  castable off four lands and three creatures. Conclave Tribunal is the one that shows what the
  discount is *for* — five mana of removal is unplayable in a creature deck's curve, and three mana
  of it is not.
*/
const SIEGE_WURM: CardScript = {
  name: 'Siege Wurm',
  keywords: ['trample'],
  convoke: true,
};

/*
  The first three morphs (CR 702.37). One field each, because both halves of the mechanic are
  already built: the engine knows a face-down permanent is a 2/2 with no abilities, so a script's whole job
  here is to say what turning it up costs.

  Which is the point worth noticing about this entry. Nothing below mentions the {3} — that is in
  the rule, not on the card — and nothing below says "and then it has first strike", because the
  keywords are the card's own and apply the moment it is no longer face down. A mechanic that is
  five lines of script across three cards is a mechanic the engine was already shaped for.
*/
const ZOETIC_CAVERN: CardScript = {
  name: 'Zoetic Cavern',
  abilities: [{ cost: { tap: true }, description: '{T}: Add {C}.', produces: ['C'] }],
  morph: { cost: { mana: '{2}' } },
};

const DIRGUR_NEMESIS: CardScript = {
  name: 'Dirgur Nemesis',
  keywords: ['defender'],
  morph: { cost: { mana: '{5}{U}' } },
};

const BATTERING_CRAGHORN: CardScript = {
  name: 'Battering Craghorn',
  keywords: ['first strike'],
  morph: { cost: { mana: '{4}{R}' } },
};

/*
  The two morphs whose back has text on it, and the whole reason `turned-face-up` exists.

  Neither could be written with an entry trigger. A morph enters the battlefield **face down**, with
  no abilities at all, so an `etb` has already come and gone by the time the card is itself — and
  turning it up is not a new object, so it will not come round again (CR 702.37d). That is the gap
  this event fills, and it is also what makes the cards good: the trigger happens at a moment the
  controller chooses, with no window for an opponent to act before it goes on the stack.

  Only the trigger's resolution can be responded to, which is the right half to be able to answer.
*/
const AINOK_SURVIVALIST: CardScript = {
  name: 'Ainok Survivalist',
  morph: { cost: { mana: '{1}{G}' } },
  triggers: [{
    on: { kind: 'turned-face-up' },
    description: 'destroy target artifact or enchantment an opponent controls',
    /*
      An opponent's, which the printed card says and which matters here more than it does on a
      Naturalize: this trigger is **mandatory**, so without the clause a morph turned up on a board
      with nothing else on it would have to destroy its controller's own Sol Ring.

      A trigger with no legal target never reaches the stack, which is what makes turning it up for
      the body alone a legal and sometimes correct play.
    */
    targets: [{
      kind: 'permanent',
      description: "target artifact or enchantment an opponent controls",
      filter: (state, candidate, chooser) => {
        if (candidate.kind !== 'card') return false;
        const inst = state.instances[candidate.id];
        if (inst === undefined || inst.zoneSeat === chooser) return false;
        const types = characteristicsOf(state, inst).typeLine;
        return hasType(types, 'artifact') || hasType(types, 'enchantment');
      },
    }],
    effect: (c) => {
      const id = firstCardTarget(c);
      return id === null ? c.state : destroy(c.state, id);
    },
  }],
};

const MASTER_OF_PEARLS: CardScript = {
  name: 'Master of Pearls',
  morph: { cost: { mana: '{2}{W}{W}' } },
  triggers: [{
    on: { kind: 'turned-face-up' },
    description: 'creatures you control get +2/+2 until end of turn',
    effect: (c) => pumpTeam(c.state, c.source, c.controller, { power: 2, toughness: 2 }),
  }],
};

/*
  The two halves of morph the first pass left out: a cost that is not mana, and megamorph.

  Both are the same observation from different ends. CR 702.37a lets a card print whatever cost it
  likes for turning itself up, and the first five morphs all printed mana, so the engine held the
  cost as a mana string — which is the sort of shortcut that reads as a design until the sixth card
  arrives. The cost is an `AbilityCost` now, the same vocabulary an activated ability uses, and it
  brought the life clause's own rule with it: a player on three life is not *offered* a Zombie
  Cutthroat's turn-up, because a cost you cannot pay is not a cost you may choose to pay.

  Megamorph (CR 702.37c) is one flag, and the reason it is a flag rather than a `turned-face-up`
  trigger on each card is the one rule that makes morph worth playing: turning a permanent face up
  cannot be responded to. A counter that arrived from a trigger would go on the stack, and an
  opponent would get a window between "it is face up" and "it is bigger" — which is a window to
  kill a creature in response to its own +1/+1 counter. Both halves happen inside `turnUp`, before
  anybody has priority again.
*/
const ZOMBIE_CUTTHROAT: CardScript = {
  name: 'Zombie Cutthroat',
  // No mana at all, which is the case the string could not express: `{ life: 3 }` and nothing else.
  morph: { cost: { life: 3 } },
};

/**
 * Hidden Dragonslayer: megamorph, and the removal spell you were holding as a 2/2.
 *
 * The one card in the pool that is three things at once — a {1}{W} 2/1 with lifelink if you need a
 * body, a {3} 2/2 if you need a blocker, and a {2}{W} "destroy their best creature" if you need
 * that — and all three are the same card in the same hand. Which is the argument for morph as a
 * mechanic rather than for this card: the decision is made late and the opponent cannot see which
 * of the three it is.
 *
 * The power filter is why the trigger is worth having over a plain Swords to Plowshares: it is
 * mandatory, and a trigger with no legal target never reaches the stack, so turning this up on a
 * board of 1/1s is a 3/2 lifelinker and nothing more. "Power 4 or greater" also names what the
 * white decks actually lose to.
 */
const HIDDEN_DRAGONSLAYER: CardScript = {
  name: 'Hidden Dragonslayer',
  keywords: ['lifelink'],
  morph: { cost: { mana: '{2}{W}' }, mega: true },
  triggers: [{
    on: { kind: 'turned-face-up' },
    description: "destroy target creature an opponent controls with power 4 or greater",
    targets: [{
      kind: 'creature',
      description: 'target creature an opponent controls with power 4 or greater',
      filter: (state, candidate, chooser) => {
        if (candidate.kind !== 'card') return false;
        const inst = state.instances[candidate.id];
        if (inst === undefined || inst.zoneSeat === chooser) return false;
        return characteristicsOf(state, inst).power >= 4;
      },
    }],
    effect: (c) => {
      const id = firstCardTarget(c);
      return id === null ? c.state : destroy(c.state, id);
    },
  }],
};

/*
  The three Vehicles, and what the engine already had for them.

  Almost all of this card type is the type line. A Vehicle is an artifact, so `characteristicsOf`
  reports `isCreature` false and every rule that asks — `canAttack`, `canBlock`, a sweeper's "destroy
  all creatures", a Doom Blade's target filter — says no without being told about Vehicles. The
  printed power and toughness sit on the card and are simply not a creature's yet.

  Crewing is then layer 4, which D93 built for a land that becomes a creature: `addTypes: ['Creature']`
  until end of turn, with no `setPower`, because the body is already printed on the card. What that
  buys for free is worth listing. A crewed Vehicle is summoning-sick if it arrived this turn, because
  `canAttack` compares `enteredTurn` and does not care what the permanent was when it arrived. It
  stops being a creature at end of turn and stays on the battlefield. And a crewed Vehicle that dies
  is an artifact in the graveyard again.

  `animates: true` on each of them is the bot rule the Mutavault needed: do not press this unless
  there is an attack or a block to make with it. Without it the search would crew whenever it had
  spare creatures, because a Vehicle that is a creature scores no better than one that is not.
*/
const SKY_SKIFF: CardScript = {
  name: 'Sky Skiff',
  keywords: ['flying'],
  abilities: [{
    cost: { crew: 1 },
    description: 'Crew 1',
    animates: true,
    effect: (c) => pump(c.state, [c.source], c.source, c.controller, { addTypes: ['Creature'] }),
  }],
};

const RENEGADE_FREIGHTER: CardScript = {
  name: 'Renegade Freighter',
  abilities: [{
    cost: { crew: 2 },
    description: 'Crew 2',
    animates: true,
    effect: (c) => pump(c.state, [c.source], c.source, c.controller, { addTypes: ['Creature'] }),
  }],
  triggers: [{
    on: { kind: 'attacks' },
    description: 'it gets +1/+1 and gains trample until end of turn',
    effect: (c) => pump(c.state, [c.source], c.source, c.controller, {
      power: 1, toughness: 1, keywords: ['trample'],
    }),
  }],
};

const CONSULATE_DREADNOUGHT: CardScript = {
  name: 'Consulate Dreadnought',
  abilities: [{
    cost: { crew: 4 },
    description: 'Crew 4',
    animates: true,
    effect: (c) => pump(c.state, [c.source], c.source, c.controller, { addTypes: ['Creature'] }),
  }],
};

/*
  The two Sagas, and the first permanents in this pool with a life of their own.

  A Saga is one card that says three different things on three different turns and then is gone. The
  shape is unlike anything else here: an entry trigger fires once at a moment, an activated ability
  fires when a player presses it, and a static ability is simply true — a Saga is a permanent that
  *keeps a count*, and what each number means is printed on it.

  Which is why `saga: true` is the only new field. The chapters are ordinary triggered abilities
  keyed to the counter reaching a number, so they get the stack, targets and mid-resolution
  questions for free, and the number of chapters is read off them rather than declared beside them.
  The sacrifice is a state-based action in `stateBasedActions`, not a fourth chapter.

  The Birth of Meletis is the defensive one: a wall, two life, and a land, which is three turns of
  exactly what a deck that wants to survive to its fliers is short of. The Eldest Reborn is the
  grinding one, and it is in the mill deck on purpose — it makes every opponent sacrifice, then
  discard, and then reanimates a creature out of **any** graveyard, which is a deck that spends the
  whole game filling its opponents' graveyards finally getting to use one.
*/
const THE_BIRTH_OF_MELETIS: CardScript = {
  name: 'The Birth of Meletis',
  saga: true,
  triggers: [
    {
      on: { kind: 'chapter', n: 1 },
      description: 'create a 0/4 white Wall creature token with defender',
      effect: (c) => createToken(c.state, c.controller, WALL_TOKEN, 1),
    },
    {
      on: { kind: 'chapter', n: 2 },
      description: 'you gain 2 life',
      effect: (c) => gainLife(c.state, c.controller, 2),
    },
    {
      on: { kind: 'chapter', n: 3 },
      description: 'search your library for a Plains card and put it onto the battlefield tapped',
      decisions: [searchYourLibrary('Search your library for a Plains', (state, id) => {
        const inst = state.instances[id];
        return inst !== undefined && state.cardDefs[inst.defKey]?.name === 'Plains';
      })],
      // Tapped, like a Rampant Growth: the land is the chapter's payoff and not a free land drop.
      effect: (c) => {
        const found = chosenCard(c);
        return found === null ? c.state : putOntoBattlefield(c.state, found, c.controller, { tapped: true });
      },
    },
  ],
};

const THE_ELDEST_REBORN: CardScript = {
  name: 'The Eldest Reborn',
  saga: true,
  triggers: [
    {
      on: { kind: 'chapter', n: 1 },
      description: 'each opponent sacrifices a creature',
      decisions: [{
        who: 'each-opponent', from: 'battlefield', prompt: 'Sacrifice a creature', min: 1, max: 1,
        filter: (state, id) => {
          const inst = state.instances[id];
          return inst !== undefined && characteristicsOf(state, inst).isCreature;
        },
      }],
      effect: (c) => c.decisions.reduce((state, answer) => moveToGraveyard(state, answer.ids), c.state),
    },
    {
      on: { kind: 'chapter', n: 2 },
      description: 'each opponent discards a card',
      decisions: [{
        who: 'each-opponent', from: 'hand', prompt: 'Discard a card', min: 1, max: 1,
      }],
      effect: (c) => c.decisions.reduce((state, answer) => moveToGraveyard(state, answer.ids), c.state),
    },
    {
      on: { kind: 'chapter', n: 3 },
      /*
        **Any** graveyard, which is the clause that makes this card belong in a mill deck.

        Every other reanimation in the pool reads "your graveyard" — Zombify, Gravedigger, Raise
        Dead — and this one is the first that can take a creature out of the pile it spent the game
        filling. No filter on the spec, because `graveyard-creature` already means every creature
        card in every graveyard and narrowing it is what the others do.
      */
      targets: [{ kind: 'graveyard-creature', description: 'target creature card in a graveyard' }],
      description: "return target creature card from a graveyard to the battlefield under your control",
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : putOntoBattlefield(c.state, id, c.controller);
      },
    },
  ],
};

/*
  The two foretell cards, and the mechanic that is about the thing this bot cannot do.

  Holding two mana up for a counterspell is Tidal Mind's whole plan and the search has never been
  able to price it — three separate measurements say so (D108, D110, D119). Foretell turns that one
  unanswerable question into two answerable ones: spend {2} on a turn where the mana was going
  spare, and cast the spell later for less than it says. Whether that actually helps is a
  measurement and not an argument, and it is in D127.

  Both are in Tidal Mind, so one measurement covers the mechanic.
*/
const BEHOLD_THE_MULTIVERSE: CardScript = {
  name: 'Behold the Multiverse',
  foretell: { cost: '{1}{U}' },
  // Scry *then* draw, like Preordain: the draw sees the library the scry left behind.
  decisions: [scry(2)],
  onResolve: (c) => drawLater(c.state, c.controller, 2),
};

const SAW_IT_COMING: CardScript = {
  name: 'Saw It Coming',
  foretell: { cost: '{U}{U}' },
  targets: [TARGET_SPELL],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : counterSpell(c.state, id);
  },
};

const CONCLAVE_TRIBUNAL: CardScript = {
  ...exileUntilItLeaves('Conclave Tribunal', {
    kind: 'permanent',
    description: 'target nonland permanent an opponent controls',
    filter: (state, candidate, controller) => {
      if (candidate.kind !== 'card') return false;
      const inst = state.instances[candidate.id];
      if (inst === undefined || inst.zoneSeat === controller) return false;
      return !characteristicsOf(state, inst).isLand;
    },
  }),
  convoke: true,
};

// ── Kicker, and costs paid with a creature ───────────────────────────────────────────────────────

/**
 * Burst Lightning: two damage, or four if you paid the kicker.
 *
 * The simplest shape a kicker comes in, and the reason `kicked` is a flag on the context rather
 * than a second effect function: the card is one spell whose number changes.
 */
const BURST_LIGHTNING: CardScript = {
  name: 'Burst Lightning',
  kicker: { cost: '{4}', description: 'Kicker {4}' },
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, c.kicked ? 4 : 2),
};

/**
 * Breath of Darigaaz: a sweeper that spares fliers, and spares nobody when it is kicked.
 *
 * No targets at all, which makes it the clean test that a kicker is not a targeting feature: the
 * only thing the extra mana changes is a number read on resolution.
 */
const BREATH_OF_DARIGAAZ: CardScript = {
  name: 'Breath of Darigaaz',
  kicker: { cost: '{3}', description: 'Kicker {3}' },
  onResolve: (c) => {
    const amount = c.kicked ? 4 : 1;
    let state = c.state;
    for (const id of battlefield(state, (cardId) => {
      const inst = state.instances[cardId];
      if (inst === undefined) return false;
      const ch = characteristicsOf(state, inst);
      return ch.isCreature && !ch.keywords.has('flying');
    })) {
      state = dealDamage(state, { kind: 'card', id }, amount, { controller: c.controller, source: c.source });
    }
    for (const seat of state.seats) {
      if (seat.eliminated) continue;
      state = dealDamage(state, { kind: 'player', seat: seat.index }, amount, { controller: c.controller, source: c.source });
    }
    return state;
  },
};

/**
 * Agonizing Demise: removal, and the corpse thrown at its controller if you paid the kicker.
 *
 * The kicked half reads the creature it killed, which it can still do — the damage is dealt in the
 * same resolution, before the creature has gone anywhere.
 */
const AGONIZING_DEMISE: CardScript = {
  name: 'Agonizing Demise',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  kicker: { cost: '{1}{R}', description: 'Kicker {1}{R}' },
  targets: [{
    kind: 'creature',
    description: 'target nonblack creature',
    filter: (state, candidate) => {
      if (candidate.kind !== 'card') return false;
      const inst = state.instances[candidate.id];
      if (inst === undefined) return false;
      return !(state.cardDefs[inst.defKey]?.colors ?? []).includes('B');
    },
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    if (id === null) return c.state;
    const inst = c.state.instances[id];
    if (inst === undefined) return c.state;
    // "Damage equal to its power" is read from the creature as it stood, which is why both are
    // taken before it is destroyed rather than after.
    const power = characteristicsOf(c.state, inst).power;
    const owner = inst.zoneSeat;
    let state = destroy(c.state, id);
    if (c.kicked && power > 0 && owner !== null) {
      state = dealDamage(state, { kind: 'player', seat: owner }, power, { controller: c.controller, source: c.source });
    }
    return state;
  },
};

/**
 * Bone Splinters: removal that costs a creature.
 *
 * The additional cost is paid as the spell is cast, so by the time anybody may respond the
 * creature is already in the graveyard — which is the card: it is removal you cannot be punished
 * for in response, and a sacrifice outlet that an opponent cannot deny by killing the creature.
 */
const BONE_SPLINTERS: CardScript = {
  name: 'Bone Splinters',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  additionalCost: { sacrifice: 'creature' },
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
};

/** Village Rites: a creature about to die anyway, turned into two cards. */
const VILLAGE_RITES: CardScript = {
  name: 'Village Rites',
  additionalCost: { sacrifice: 'creature' },
  onResolve: (c) => drawLater(c.state, c.controller, 2),
};

/**
 * Judith, the Scourge Diva: the team is bigger, and every death is a Shock.
 *
 * Two clauses, and the engine could express neither until this card: "*other* creatures you
 * control" is a static that has to skip its own source, and "a **nontoken** creature you control
 * dies" is the clause that keeps a deck of tokens from draining the table by accident. She
 * triggers on her own death too, which is the card — she was a nontoken creature you controlled.
 */
const JUDITH: CardScript = {
  name: 'Judith, the Scourge Diva',
  statics: [{ scope: 'other-controller-creatures', effect: { power: 1 } }],
  triggers: [
    {
      on: { kind: 'dies', who: 'any', of: 'you', what: 'creature', nontoken: true },
      targets: [ANY_TARGET],
      description: 'Judith deals 1 damage to any target',
      effect: (c) => damageFirstTarget(c, 1),
    },
  ],
};

/**
 * Hellrider: the first card that watches the board attack.
 *
 * "Whenever a creature you control attacks" is not a trigger about Hellrider — it is a trigger
 * about every other creature too, which is why the `attacks` event had to be offered to the whole
 * battlefield rather than only the attacker (see `raise`). `who: 'any'` includes Hellrider's own
 * attack, because it is a creature you control and the card means it.
 *
 * The damage goes to `c.attacked` — what *that* attack was declared against — and not to "the
 * opponent": in a pod three creatures can attack three different players and this card has to hit
 * each of them once. It is carried on the stack object because by the time the trigger resolves
 * the attacker may be dead and combat may no longer say what it was aimed at. A planeswalker that
 * was attacked takes the damage instead of its controller, which is the printed card and also the
 * reason the whole attack travels rather than only the seat.
 */
const HELLRIDER: CardScript = {
  name: 'Hellrider',
  triggers: [
    {
      on: { kind: 'attacks', who: 'any', of: 'you' },
      description: "Hellrider deals 1 damage to the player or planeswalker it's attacking",
      effect: (c) => {
        if (c.attacked === undefined) return c.state;
        const hit: Target = c.attacked.planeswalker === undefined
          ? { kind: 'player', seat: c.attacked.defender }
          : { kind: 'card', id: c.attacked.planeswalker };
        return dealDamage(c.state, hit, 1, { controller: c.controller, source: c.source });
      },
    },
  ],
};

/**
 * Ball Lightning: six damage, once, and then it is gone.
 *
 * The sacrifice is the whole card and it needs no new vocabulary — `step: 'end'` with `of: 'any'`
 * because the printed trigger is "at the beginning of the end step", not "your end step": a Ball
 * Lightning somehow still around on an opponent's turn dies there too. It goes through
 * `moveToGraveyard` rather than `destroy`, because a sacrifice is not a destruction: indestructible
 * does not save it and regeneration cannot replace it.
 */
/**
 * "Sacrifice this" — which does nothing at all if it is no longer on the battlefield (CR 701.17a).
 *
 * Found by unearth rather than by a test: a Hellspark Elemental carries two end-step abilities, its
 * own sacrifice and the exile unearth schedules, and the exile resolved first — so the sacrifice
 * then moved the card **out of exile and into the graveyard**, where it could be unearthed again.
 * Twice the card the printed one is, and the same latent bug sat on Ball Lightning for twenty
 * entries with nothing in the pool able to exile it first.
 *
 * A sacrifice is a thing you do to a permanent you control; a card in exile is not one.
 */
const sacrificeSelf = (c: EffectContext): GameState => (
  c.state.instances[c.source]?.zone === 'battlefield'
    ? moveToGraveyard(c.state, [c.source])
    : c.state
);

const BALL_LIGHTNING: CardScript = {
  name: 'Ball Lightning',
  // See `CardScript.leavesAtEndOfTurn`: the trigger below is what happens, and the flag is how the
  // bot knows it is coming. Without it the evaluation holds the creature back to protect it.
  leavesAtEndOfTurn: true,
  triggers: [
    {
      on: { kind: 'step', step: 'end', of: 'any' },
      description: 'sacrifice Ball Lightning',
      effect: sacrificeSelf,
    },
  ],
};

/*
  Affinity, which is a whole card's worth of text and one line of script (CR 702.41a).

  Nothing here does anything: the keyword is a *cost* reduction, and the one place a cost is
  computed for a seat already knows how to read it — see `costChangeFor`, where affinity sits
  beside the permanents that change what other spells cost. So this is a declaration and the
  engine does the rest, which is the shape every keyword in this file aims for and about half of
  them reach.
*/
const FROGMITE: CardScript = { name: 'Frogmite', affinity: 'artifacts' };

/**
 * Soulherder: the first card in the pool that watches a move into **exile** (CR 400.7).
 *
 * The event is new (`to-exile`) and everything else here already existed, which is the shape this
 * engine's card work usually takes. The blink is Cloudshift's two `relocate` calls; the optional
 * target is modular's "up to one"; the counter is `addCounters`. What was missing was the whole
 * reason a blink deck wants a payoff: the pool has exiled creatures since Journey to Nowhere, and
 * no card could tell.
 *
 * **Two abilities that feed each other**, as printed, and that is what makes it a card rather than
 * a watcher waiting on another one. The end step blinks a creature, which is a creature of yours
 * reaching exile, which is a counter. So one Soulherder and one other creature is a 2/2 next turn
 * and a 3/3 after that, with every Flickerwisp and Cloudshift in the deck a free counter on top.
 *
 * **"Another" is the printed word and it is load-bearing twice over.** It keeps the blink off
 * itself, which would otherwise be a legal target that exiles the permanent the ability belongs to
 * — and the trigger above would then try to put a counter on an object that no longer exists
 * (CR 400.7). The event's own `who`-lessness is the other half of that; see the `to-exile`
 * declaration.
 *
 * What it does **not** do is pick well. The blink is a real choice — it re-triggers an arrival, it
 * drops an opponent's Pacifism, and it can just as easily throw away a +1/+1 counter or a token
 * that ceases to exist — and the bot's `friendly` hint only says "point it at your own side". What
 * it picks is a measurement, not an assumption; see the usage instrument.
 */
const SOULHERDER: CardScript = {
  name: 'Soulherder',
  triggers: [
    {
      on: { kind: 'to-exile', from: 'battlefield', what: 'creature', whose: 'you' },
      description: 'put a +1/+1 counter on Soulherder',
      effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
    },
    {
      on: { kind: 'step', step: 'end', of: 'you' },
      description: 'blink another target creature you control',
      targets: [{
        kind: 'creature',
        description: 'another target creature you control',
        // "You **may**", which this engine spells as "up to one target" — the same shape modular
        // uses, and the same reason: the effect already does nothing with no target, and a prompt
        // with a way to decline is the honest version of a printed "may".
        optional: true,
        // Its own side, which is the whole card: the default aim is the enemy's board, and a
        // Soulherder that blinked an opponent's creature would be re-triggering their arrival and
        // growing nothing. See `TargetSpec.friendly`.
        friendly: true,
        // And what the blink costs whatever it lands on, which `friendly` cannot say: a token of
        // yours blinked is a creature destroyed. See `TargetSpec.blinks`.
        blinks: true,
        filter: (state, candidate, controller, source) => candidate.kind === 'card'
          && candidate.id !== source && creatureYouControl(state, candidate, controller),
      }],
      effect: (c) => {
        const id = firstCardTarget(c);
        if (id === null) return c.state;
        /*
          "Under its **owner's** control", which is the printed wording and not the same as this
          ability's controller. Nothing in the pool can make the two differ — no card here takes
          control of a creature — and writing the controller in would be the kind of shortcut that
          is invisible until the day one does.
        */
        const owner = c.state.instances[id]?.owner;
        if (owner === undefined) return c.state;
        return putOntoBattlefield(exileCard(c.state, id), id, owner);
      },
    },
  ],
};

/**
 * Cloudshift: a creature blinked out and straight back.
 *
 * Nothing here is new engine work and that is the point of including it: the exile and the return
 * are two `relocate` calls, and the arrival raises `etb` through `settle` exactly as a cast
 * creature's would — so Cloudshift re-triggers an enter-the-battlefield ability, saves a creature
 * from a targeted kill, and unblocks an attacker, without a single line about any of those.
 *
 * The returned permanent is a **new object** (CR 400.7): it arrives untapped, with no damage, no
 * counters and no auras, it is not what a spell on the stack targeted, and it is not the creature
 * that was declared as an attacker or a blocker (CR 506.4). The last two are the plays people
 * actually cast this for, and neither of them was true until this card was written.
 */
const CLOUDSHIFT: CardScript = {
  name: 'Cloudshift',
  targets: [{
    kind: 'creature',
    description: 'target creature you control',
    /*
      `friendly` beside the filter: redundant as a restriction and written anyway (D419), for the
      reason in `protectFromRemoval` — `targetSpecFrom` threads it through for this phrase, and a
      field that differs between the two readings without either using it is a disagreement the
      standing check would carry for ever.

      *Which* of your creatures still matters, for the same reason it does on Soulherder: a token
      blinked does not come back.
    */
    friendly: true,
    blinks: true,
    filter: (state, candidate, controller) => creatureYouControl(state, candidate, controller),
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    if (id === null) return c.state;
    return putOntoBattlefield(exileCard(c.state, id), id, c.controller);
  },
};

/*
  The keywords the engine enforced for nobody.

  First strike, menace, indestructible and shroud were all written, all checked in the rules —
  `dealsInStep`, `menaceSatisfied`, `destroy` and the lethal-damage state-based action,
  `isLegalTarget` — and no card in the pool had any of them. A live path with no card behind it is
  the same risk as an untested one, which is why the mana rocks got written; these five are the
  same increment for combat and targeting.
*/

/** Youthful Knight: the first creature in the pool that hits before it is hit. */
const YOUTHFUL_KNIGHT: CardScript = { name: 'Youthful Knight', keywords: ['first strike'] };

/**
 * Boggart Brute: a 3/2 that one creature cannot stop.
 *
 * Menace has been enforced since combat was written — a declaration that blocks it with one
 * creature is refused, and the table only lights the blocks the engine would accept — and this is
 * the first card that makes the rule do anything.
 */
const BOGGART_BRUTE: CardScript = { name: 'Boggart Brute', keywords: ['menace'] };

/**
 * Robe of Mirrors: the creature nobody can touch, including you.
 *
 * Shroud rather than hexproof on purpose: hexproof is the keyword players expect and shroud is the
 * one that tests the rule, because it stops the *controller* targeting it too. A creature wearing
 * this cannot be given a Giant Growth, equipped by a targeted equip, or saved by a Cloudshift —
 * which is the trade the card asks you to make, and the engine makes it without the card saying so.
 */
const ROBE_OF_MIRRORS: CardScript = {
  name: 'Robe of Mirrors',
  aura: {
    // A bonus, so the bot aims it at its own side. See `TargetSpec.friendly`.
    target: { kind: 'creature', description: 'enchant creature', friendly: true },
    effect: { keywords: ['shroud'] },
  },
};

/**
 * Night of Souls' Betrayal: the first static that is about *every* creature.
 *
 * `all-creatures` existed as a scope and nothing used it, so the one thing it does differently
 * from an anthem — reaching across the table rather than down one side — had never run in a game.
 * It is also the hardest thing in the pool for the state-based actions: every 1/1 on the table
 * dies at once when it arrives, and every 1/1 token afterwards arrives dead (CR 704.5f), which is
 * a loop `stateBasedActions` has to settle before anybody gets priority back.
 *
 * One copy in one deck, which also sidesteps the legend rule on a non-creature permanent.
 */
const NIGHT_OF_SOULS_BETRAYAL: CardScript = {
  name: "Night of Souls' Betrayal",
  statics: [{ scope: 'all-creatures', effect: { power: -1, toughness: -1 } }],
};

/*
  White-blue: the seventh deck's own cards.

  Two cards: a keyword and a body, and a commander. The deck is otherwise built out of what the pool
  already had, which is the point — and a third card, a 3/2 flier for five, was written, played
  sixty games in two versions of the deck, and cut, because it never earned the slot. The measuring
  is the part worth keeping.
*/

/** Wall of Air: the first card in the pool with `defender` and flying at once. */
const WALL_OF_AIR: CardScript = { name: 'Wall of Air', keywords: ['defender', 'flying'] };

/**
 * Hanna, Ship's Navigator: an artifact or enchantment, bought back once a turn.
 *
 * The first commander in the pool whose text is an activated ability pointing into a graveyard, and
 * it needed no new vocabulary: `graveyard-card` has always taken any card with a filter, and the
 * filter is the card's printed type line — which is the right test, because a card in a graveyard
 * has no continuous effects applied to it and its printed type is what it is.
 *
 * Her own graveyard only, which is what the card says and also what keeps her honest: she is a
 * 1/3 for three that rebuys *your* Pacifism, not a way into somebody else's.
 */
const HANNA: CardScript = {
  name: "Hanna, Ship's Navigator",
  abilities: [
    {
      cost: { mana: '{1}{W}{U}', tap: true },
      description: "{1}{W}{U}, {T}: Return target artifact or enchantment card from your graveyard to your hand",
      targets: [{
        kind: 'graveyard-card',
        description: 'target artifact or enchantment card in your graveyard',
        filter: (state, candidate, controller) => {
          if (candidate.kind !== 'card') return false;
          const inst = state.instances[candidate.id];
          if (inst === undefined || inst.zoneSeat !== controller) return false;
          const line = parseTypeLine(state.cardDefs[inst.defKey]?.typeLine);
          return hasType(line, 'artifact') || hasType(line, 'enchantment');
        },
      }],
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : moveToHand(c.state, [id]);
      },
    },
  ],
};

/*
  Ten more, which is the increment that has never failed to pay.

  Seven of them are the vocabulary doing what it already does — burn, a counter, removal, a body, a
  pump, a one-drop, a mana spell. Three reach somewhere nothing else does: a pump on its own attack,
  two targets that interact with each other, and the first target filter that reads combat.
*/

const LIGHTNING_STRIKE: CardScript = {
  name: 'Lightning Strike',
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 3),
};

const CANCEL: CardScript = {
  name: 'Cancel',
  targets: [TARGET_SPELL],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : counterSpell(c.state, id);
  },
};

const MURDER: CardScript = {
  name: 'Murder',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
};

/** Giant Spider: the first card whose reach is the only thing it has. */
const GIANT_SPIDER: CardScript = { name: 'Giant Spider', keywords: ['reach'] };

const TITANIC_GROWTH: CardScript = {
  name: 'Titanic Growth',
  // Wears off at end of turn, so it is held for the combat. See `expiresAtEndOfTurn`.
  expiresAtEndOfTurn: true,
  targets: [TARGET_CREATURE_HELPED],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : pump(c.state, [id], c.source, c.controller, { power: 4, toughness: 4 });
  },
};

const HEALERS_HAWK: CardScript = { name: "Healer's Hawk", keywords: ['flying', 'lifelink'] };

const LAVA_AXE: CardScript = {
  name: 'Lava Axe',
  targets: [TARGET_PLAYER_OR_PLANESWALKER],
  onResolve: (c) => damageFirstTarget(c, 5),
};

/**
 * Dark Ritual: the first spell in the pool that *makes* mana.
 *
 * The solver has only ever been handed mana by a permanent tapping. A spell that adds to the pool
 * on resolution is the same thing from the other direction, and it works without the solver knowing
 * anything new: the mana is in the pool when the next play asks what it can afford. What it cannot
 * do is help pay for *itself* or for anything already on the stack, which is the card.
 */
const DARK_RITUAL: CardScript = {
  name: 'Dark Ritual',
  // Nothing in the engine reads this; the bot does. See `makesMana` in `scriptTypes.ts`.
  makesMana: true,
  onResolve: (c) => addToPool(c.state, c.controller, 'B', 3),
};

/**
 * Borderland Marauder: bigger only while it is attacking.
 *
 * The first card to use the widened `attacks` trigger on itself for a pump rather than for damage,
 * and the cheapest proof that the widening did not change what `self` means: it says nothing about
 * `who`, so it watches only its own attack, exactly as it did before the event learned to watch
 * the board.
 */
const BORDERLAND_MARAUDER: CardScript = {
  name: 'Borderland Marauder',
  triggers: [
    {
      on: { kind: 'attacks' },
      description: 'Borderland Marauder gets +2/+0 until end of turn',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 2 }),
    },
  ],
};

/**
 * Prey Upon: the first card whose two targets are pointed at each other.
 *
 * Every other multi-target card in the pool aims each target independently. This one is a *fight*:
 * each creature deals its power to the other, which needs both powers read before either is dealt,
 * because a creature that dies to the first half still deals its damage (CR 701.12a).
 */
/**
 * Two creatures each dealing their power to the other (CR 701.12a).
 *
 * One function for the two cards that fight, because both halves have to be read **before** either
 * is dealt: a creature that dies to the first half still deals its damage. Prey Upon fights two
 * chosen creatures; Gruul Ragebeast fights whichever creature just arrived against a chosen one.
 * Written out twice, the second one would have got the simultaneity wrong eventually.
 */
function fight(state: GameState, mine: string, theirs: string, controller: SeatIndex): GameState {
  const mineInst = state.instances[mine];
  const theirsInst = state.instances[theirs];
  if (mineInst === undefined || theirsInst === undefined) return state;
  const minePower = characteristicsOf(state, mineInst).power;
  const theirsPower = characteristicsOf(state, theirsInst).power;
  let next = state;
  if (minePower > 0) {
    next = dealDamage(next, { kind: 'card', id: theirs }, minePower, { controller, source: mine });
  }
  if (theirsPower > 0) {
    next = dealDamage(next, { kind: 'card', id: mine }, theirsPower, {
      controller: theirsInst.zoneSeat, source: theirs,
    });
  }
  return next;
}

const PREY_UPON: CardScript = {
  name: 'Prey Upon',
  targets: [
    {
      kind: 'creature',
      description: 'target creature you control',
      filter: (state, candidate, controller) => creatureYouControl(state, candidate, controller),
    },
    {
      kind: 'creature',
      description: "target creature you don't control",
      filter: (state, candidate, controller) => creatureYouDontControl(state, candidate, controller),
    },
  ],
  onResolve: (c) => {
    const [mine, theirs] = cardTargets(c);
    if (mine === undefined || theirs === undefined) return c.state;
    return fight(c.state, mine, theirs, c.controller);
  },
};

/**
 * Divine Verdict: the first target filter that reads combat.
 *
 * Every filter until now has asked what a permanent *is* — a creature, a land, black, yours. This
 * one asks what it is *doing*, which means reading `state.combat` rather than the battlefield: an
 * attacking creature is one named in an attack, a blocking one is named in somebody's blockers.
 *
 * The consequence is the card: outside combat it has no legal target, so the engine will not let it
 * be cast at all and the table does not offer it (CR 601.2c). Four mana that is dead on your own
 * main phase is exactly what the printed card is.
 */
const DIVINE_VERDICT: CardScript = {
  name: 'Divine Verdict',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at.
  removesACreature: true,
  targets: [{
    kind: 'creature',
    description: 'target attacking or blocking creature',
    filter: attackingOrBlocking,
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
};

// ── Damage that does not happen ──────────────────────────────────────────────────────────────────

/*
  The first cards in the pool that prevent damage rather than deal, absorb or redirect it.

  Nothing here is new vocabulary so much as a new *kind* of answer. Every other way this pool stops
  an attack removes something — kill the creature, exile it, bounce it, stop it attacking at all —
  and all of them are permanent and all of them cost a card for a card. A Fog costs a card and
  changes nothing about the board, which is why it is the cheapest card in the game that beats an
  alpha strike and the worst one to draw on an empty table.
*/

const FOG: CardScript = {
  name: 'Fog',
  // Nothing in the engine reads this; the bot does. See `preventsDamage` in `scriptTypes.ts`.
  preventsDamage: true,
  onResolve: (c) => preventCombatDamage(c.state, c.source, c.controller),
};

/** The same card in white, which is also the only way the white-blue deck survives a wide board. */
const HOLY_DAY: CardScript = {
  name: 'Holy Day',
  preventsDamage: true,
  onResolve: (c) => preventCombatDamage(c.state, c.source, c.controller),
};

/*
  And the other shape of prevention: a shield with a quantity.

  A Fog is all-or-nothing and lasts a turn; these two hand out an *amount* that the damage spends.
  Three differences follow, and all three are why `preventsCombatDamage` refused to be stretched
  into them: the effect is rewritten as it absorbs rather than only read, it covers a burn spell as
  well as a combat, and it can sit on a player. `preventDamage` is the primitive; `dealDamage` is
  the only thing that reads it.

  Both cards are "any target", which is the first time a continuous effect in this engine has
  needed to point at a player.
*/

/**
 * Samite Healer: one damage a turn, for ever, for the price of not blocking with it.
 *
 * The repeatable version, and the one whose cost is easy to miss — the ability taps it, and a
 * tapped 1/1 is not a blocker. On a board where one damage decides a fight that is a real
 * decision, which is what makes a vanilla-looking common worth scripting.
 *
 * `preventsDamage` on the ability rather than the card, for the same reason Selesnya Charm carries
 * `expiresAtEndOfTurn` per mode: the flag is advice to the bot about *this* way of spending the
 * card, and a creature's body is not spent on nothing just because its ability would be.
 */
const SAMITE_HEALER: CardScript = {
  name: 'Samite Healer',
  abilities: [{
    cost: { tap: true },
    description: '{T}: Prevent the next 1 damage that would be dealt to any target this turn.',
    preventsDamage: true,
    targets: [ANY_TARGET_HELPED],
    effect: (c) => shieldFirstTarget(c, 1),
  }],
};

/**
 * Healing Salve: three life, or three damage that never happens.
 *
 * The one-mana white instant that is two cards, and the pair is the point: gaining three life and
 * preventing three damage are the same three points in most positions and completely different in
 * two — life does nothing for a creature in a fight, and prevention does nothing against a loss
 * the damage already caused. Which half is right is a judgement about the board, which is exactly
 * the kind of choice a modal spell exists to put in front of a player.
 */
const HEALING_SALVE: CardScript = {
  name: 'Healing Salve',
  modal: {
    modes: [
      {
        description: 'Target player gains 3 life',
        targets: [TARGET_PLAYER],
        effect: (c) => {
          const seat = firstPlayerTarget(c);
          return seat === null ? c.state : gainLife(c.state, seat, 3);
        },
      },
      {
        description: 'Prevent the next 3 damage that would be dealt to any target this turn',
        // Only this mode is spent on nothing when no damage is coming; the life is never wasted in
        // the same way, because it stays until something takes it.
        preventsDamage: true,
        targets: [ANY_TARGET_HELPED],
        effect: (c) => shieldFirstTarget(c, 3),
      },
    ],
  },
};

/**
 * Maze of Ith: a land that answers one attacker a turn, for ever, and never taps for mana.
 *
 * The printed card is exactly what the engine now does — "prevent all combat damage that would be
 * dealt to and dealt by that creature this turn" — which it could not express at all until the
 * prevention flag existed. The untap is not decoration either: an attacking creature stays tapped
 * through its own turn, so untapping it is what lets a Maze of Ith attack *and* block in the same
 * round of a Commander game.
 *
 * It does not remove the creature from combat, and that is the printed card rather than an
 * approximation: a blocked attacker whose damage is prevented is still blocked, and a Maze aimed
 * at a creature with trample still stops every point of it.
 */
const MAZE_OF_ITH: CardScript = {
  name: 'Maze of Ith',
  abilities: [{
    cost: { tap: true },
    description: '{T}: Untap target attacking creature. Prevent all combat damage it would deal or be dealt this turn.',
    targets: [{
      kind: 'creature',
      description: 'target attacking creature',
      filter: (state, candidate) => candidate.kind === 'card'
        && state.combat.attacks.some((a) => a.attacker === candidate.id),
    }],
    effect: (c) => {
      const id = firstCardTarget(c);
      if (id === null) return c.state;
      return preventCombatDamage(tap(c.state, id, false), c.source, c.controller, [id]);
    },
  }],
};

/*
  The two cards layers 4 and 5 are for, which were the last of CR 613 this engine had named and
  not built (bar characteristic-defining abilities).

  They are here together because neither is interesting without the layer and the layer is not
  worth having for one card. What makes them worth the layer is that both are *honest* cases: a
  land that becomes a creature has to be a creature everywhere the engine asks — it can attack, it
  is summoning-sick the turn it arrives, an anthem pumps it, a Doom Blade kills it and a sweeper
  takes it with the rest — and a creature that changes colour has to change what protection from
  that colour does about it.
*/

/**
 * Lhurgoyf: the card layer 7a is for, and the last layer of CR 613 this engine had named.
 *
 * One static and no effect function, which is what a characteristic-defining ability is: the size
 * is not set by anything that resolves, it is a count of the board read fresh every time anybody
 * asks. Something dies anywhere at the table and the Lhurgoyf is bigger; a Tormod's Crypt exiles
 * a graveyard and it is smaller, with no trigger, no event and nothing to recompute.
 *
 * The number is declared rather than computed here — `definesSize` names a count the engine knows
 * how to perform — because `GameState` is written to Redis and sent down a socket, and an effect
 * carrying a closure is an effect that cannot be saved.
 */
const LHURGOYF: CardScript = {
  name: 'Lhurgoyf',
  statics: [{
    scope: 'self',
    effect: { definesSize: { count: 'creature-cards-in-graveyards', toughnessPlus: 1 } },
  }],
};

/**
 * Mutavault: a land that becomes a creature, which is the whole of layer 4 in one card.
 *
 * The printed card says "with all creature types", and that clause is not here: changeling matters
 * to tribal cards and there are none in this pool, so adding every subtype in Magic would be a
 * list nothing reads. Everything else is the card.
 *
 * Note what the engine gets for free once the type line is right. Tapping it for mana taps the
 * *creature*, so a Mutavault that paid for a spell cannot also attack. It is summoning-sick on the
 * turn it is played, because `canAttack` compares `enteredTurn` with the current turn and does not
 * care what the permanent was when it arrived (CR 302.6 via 613.1c). And a 2/2 land dies to
 * everything a 2/2 dies to, which is the trade the card is for.
 */
const MUTAVAULT: CardScript = {
  name: 'Mutavault',
  abilities: [
    { cost: { tap: true }, description: '{T}: Add {C}.', produces: ['C'] },
    {
      cost: { mana: '{1}' },
      description: '{1}: Mutavault becomes a 2/2 creature until end of turn. It\u2019s still a land.',
      // See `AbilityDef.animates`: the bot does not press this unless there is an attack or a
      // block to make with it.
      animates: true,
      /*
        `addTypes` and not `setTypes`: "it's still a land" is the clause that makes the card, and
        adding a type rather than replacing the line is also what the rules do (CR 613.1c adds).
        The body comes from layer 7b, which this engine already had — a 2/2 base, not +2/+2, so an
        anthem lands on top of it rather than under it.
      */
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, {
        addTypes: ['Creature'], setPower: 2, setToughness: 2,
      }),
    },
  ],
};

/**
 * Crimson Wisps: haste, a card, and the colour change that layer 5 exists for.
 *
 * Worth being straight about what the colour clause is worth in this pool: almost nothing. Two
 * cards read colour at all — Paladin en-Vec's protection from red and black — so most of the time
 * this card is "give something haste and draw a card" and the layer is doing bookkeeping nobody
 * sees. What it is not is *approximated*: a creature this made red is red for protection, for a
 * red source's damage and for anything else that asks, and `scripts.test.ts` asserts the
 * interaction rather than the field.
 */
const CRIMSON_WISPS: CardScript = {
  name: 'Crimson Wisps',
  targets: [TARGET_ATTACKER_HELPED],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    /*
      Haste first so the draw happens whatever the target did, then the card: "draw a card" is not
      conditional on the creature still being there.

      `drawLater` rather than `draw`, which is a correction (D412). `drawLater`'s own docblock says
      it is the better primitive — only a deferred draw can be replaced by a dredge (CR 702.52a) —
      and bounds itself to "a draw that is the last thing the card does". This draw is exactly that,
      and the compiled reading of the same two sentences picks the deferred form by position. One
      rule with one source beats two readings of one card that differ by a field.
    */
    const hasted = id === null ? c.state : pump(c.state, [id], c.source, c.controller, {
      keywords: ['haste'], setColors: ['R'],
    });
    return drawLater(hasted, c.controller, 1);
  },
};

// ── The two painlands, which are the same card said two different ways ───────────────────────────

/*
  A pair worth having together, because the difference between them is a rule rather than a number.

  City of Brass **triggers**: it taps, and then it deals you a damage. The damage uses the stack,
  it can be responded to, and nothing stops a player on one life tapping it — they simply die.

  Mana Confluence **costs**: the life is paid as the ability is activated, so there is nothing to
  respond to and a player on one life is not offered the mana at all, because a cost you cannot pay
  is not a cost you may choose to pay (CR 118.4).

  Between them they are also the two halves of this increment: the trigger kind the engine matched
  and nothing ever raised, and a cost that is not mana.
*/

const CITY_OF_BRASS: CardScript = {
  name: 'City of Brass',
  abilities: COLOURS.map((colour) => ({
    cost: { tap: true },
    description: `{T}: Add {${colour}}.`,
    produces: [colour],
  })),
  triggers: [{
    on: { kind: 'becomes-tapped' },
    description: 'City of Brass deals 1 damage to you',
    effect: (c) => dealDamage(c.state, { kind: 'player', seat: c.controller }, 1, { source: c.source }),
  }],
};

const MANA_CONFLUENCE: CardScript = {
  name: 'Mana Confluence',
  abilities: COLOURS.map((colour) => ({
    cost: { tap: true, life: 1 },
    description: `{T}, Pay 1 life: Add {${colour}}.`,
    produces: [colour],
  })),
};

/**
 * Dark Confidant: the card that reads what it just drew.
 *
 * Every other upkeep trigger in the pool does a fixed thing. This one has to look at the card it
 * put in the hand and charge for *that* — which is the whole card, and the reason a deck with it
 * stops playing seven-drops.
 */
const DARK_CONFIDANT: CardScript = {
  name: 'Dark Confidant',
  triggers: [{
    on: { kind: 'step', step: 'upkeep', of: 'you' },
    description: 'Reveal the top card of your library and put it into your hand. You lose life equal to its mana value',
    effect: (c) => {
      const before = listAt(c.state, zoneKey(c.controller, 'hand'));
      const next = draw(c.state, c.controller, 1);
      const after = listAt(next, zoneKey(c.controller, 'hand'));
      const drawn = after.find((id) => !before.includes(id));
      if (drawn === undefined) return next;
      const cost = next.cardDefs[next.instances[drawn]!.defKey]?.cmc ?? 0;
      return cost === 0 ? next : loseLife(next, c.controller, cost);
    },
  }],
};

/**
 * Fog Bank: the prevention printed on a permanent rather than cast from hand.
 *
 * A 0/2 that blocks anything in the pool for ever and survives it, which is the one thing a control
 * deck full of answers could not do before — every other blocker here trades, and trading is what a
 * deck with no creatures cannot afford.
 *
 * It is also the only card that reaches one branch of combat: a blocker whose damage is prevented
 * while the attacker's is not. A Ball Lightning blocked by a Fog Bank still has to *assign* lethal
 * damage to it before it may trample past (CR 702.19b), so four of its six get through rather than
 * six. A Fog, which covers the whole table, never produces that case — the attacker is prevented
 * too, and the question never gets as far as the blocker.
 */
/**
 * The creature that does not get a choice.
 *
 * Two statics on itself, and both are rules the engine had no vocabulary for until it arrived.
 * "Attacks each combat if able" is a *requirement* — checked against the whole declaration rather
 * than against one card, because the illegal thing is leaving it at home. "Can't be blocked by
 * Walls" is evasion that reads a creature *type*: Wall is what a Wall of Air is, not something it
 * does, so it cannot be expressed as a keyword comparison the way flying and reach are.
 *
 * Written as statics rather than as script flags so that everything downstream reads them the way
 * it reads a Pacifism — one place in `characteristicsOf`, one in `canBlock` — and so an effect
 * that grants either to somebody else has somewhere to live when one is printed.
 */
const JUGGERNAUT: CardScript = {
  name: 'Juggernaut',
  statics: [{ scope: 'self', effect: { mustAttack: true, cantBeBlockedByWalls: true } }],
};

/**
 * First strike is printed and needs no script; protection from black and from red is the static.
 *
 * The one card in the pool with protection (CR 702.16), which is four rules under one keyword —
 * cannot be damaged, enchanted or equipped, blocked, or targeted by anything of those colours. The
 * engine applies all four, each in the one place that already answers that question.
 */
/**
 * Paladin en-Vec: a card with **no script at all**, and that is the result rather than an omission.
 *
 * Everything it prints is read off the card definition now. "First strike" has always come from
 * `printedKeywords`; "Protection from black and from red" comes from `printedProtection` (D424),
 * which was added for the card that arrives from printed data and has no script to fall back on.
 * The static that used to be here restated the second line, which is a second source for one fact
 * — the call D419 made on Basilica Guards' printed `defender` and D424 made on River Boa's
 * islandwalk.
 *
 * Worth keeping the name in the registry's list? There is nothing to keep: a script with no fields
 * is not a script, so this one is gone and `scriptFor('Paladin en-Vec')` returns nothing. What
 * proves the card still works is the protection suite below — four rules, damage, equipping,
 * blocking and targeting (CR 702.16) — which now exercises the printed reading rather than a
 * hand-written static, at no cost to what it asserts.
 */

const FOG_BANK: CardScript = {
  name: 'Fog Bank',
  statics: [{ scope: 'self', effect: { preventsCombatDamage: true } }],
};

/**
 * "If a nontoken creature an opponent controls would die, instead exile that card and create a 2/2
 * black Zombie creature token."
 *
 * The first card in the pool with a `replaces`: an effect that belongs to this permanent and
 * changes what happens to a *different* one (CR 614). Lifelink is printed and needs no script.
 *
 * `applies` reads the dying permanent for what it was, not where it is — by the time a replacement
 * is asked, the engine has already detected the death, which is explained at `replaceDeaths`. The
 * creature question is asked of its characteristics because a Bear that was animated is still a
 * creature for this; "an opponent controls" is read off the graveyard it went to, which is the
 * same approximation the death event itself makes.
 */
/**
 * Undying and persist (CR 702.92, 702.79), which look like replacement effects and are not.
 *
 * "When this creature dies, if it had no +1/+1 counter on it, return it to the battlefield under
 * its owner's control with a +1/+1 counter on it" — and persist is the same sentence with
 * −1/−1 in both halves. The obvious implementation is a `replaces` on `dies`, and it is wrong:
 * both keywords are **triggered** abilities, so the creature really does die, a Blood Artist really
 * does drain for it, and a sacrifice outlet really does get its value before the body comes back.
 * Writing it as a replacement would have made it a creature that cannot be sacrificed for profit,
 * which is the opposite of what the cards are played for.
 *
 * So it is a `dies` trigger with `who: 'self'` and an **intervening-if**, and the if is the whole
 * mechanic: it is checked against the counters the creature had *as it died* (CR 603.4), which is
 * why a 1/1 that has already come back once stays in the graveyard the second time. Those counters
 * are gone from the card by the time anything can look — `relocate` takes them off on the way to
 * the graveyard, as the rules require — so both asks read `subjectCounters`, the snapshot the event
 * carries. The first ask did not have it until this card needed it (D181).
 *
 * The return is guarded the way Rancor's is: a card that has left the graveyard in between (a
 * Planar Void, a Scavenging Ooze) stays where it is, because an ability does as much as it can and
 * no more (CR 608.2).
 */
const comesBackWithACounter = (kind: 'undying' | 'persist'): readonly TriggerDef[] => {
  const counter = kind === 'undying' ? '+1/+1' : '-1/-1';
  return [{
    on: { kind: 'dies', who: 'self' },
    description: `return it to the battlefield with a ${counter} counter on it`,
    condition: (c) => (c.subjectCounters?.[counter] ?? 0) === 0,
    effect: (c) => {
      const inst = c.state.instances[c.source];
      if (inst === undefined || inst.zone !== 'graveyard') return c.state;
      return addCounters(putOntoBattlefield(c.state, c.source, inst.owner), c.source, counter, 1);
    },
  }];
};

/** Young Wolf: a one-mana body that arrives twice, and the cheapest undying there is. */
const YOUNG_WOLF: CardScript = {
  name: 'Young Wolf',
  triggers: comesBackWithACounter('undying'),
};

/** Butcher Ghoul: the same card in black, in the deck whose creatures last a turn and a half. */
const BUTCHER_GHOUL: CardScript = {
  name: 'Butcher Ghoul',
  triggers: comesBackWithACounter('undying'),
};

/**
 * Murderous Redcap: persist, and the half of the family that has text of its own.
 *
 * "When this enters, it deals damage equal to its power to any target" plus persist is two cards in
 * one: two damage now, one damage later, and the 1/1 that comes back is a 0/0 with a −1/−1 counter
 * on it — which the layer system kills on arrival unless something is adding to it. That is the
 * printed card and the reason persist creatures are 3/2s and 1/1s rather than 1/1s alone: a
 * Redcap's second body is a *trigger*, not a creature, and the engine's state-based actions put the
 * 0/0 back in the graveyard the moment the trigger has resolved.
 */
const MURDEROUS_REDCAP: CardScript = {
  name: 'Murderous Redcap',
  triggers: [
    {
      on: { kind: 'etb', who: 'self' },
      description: 'it deals damage equal to its power to any target',
      targets: [ANY_TARGET],
      effect: (c) => {
        // Its power as the trigger resolves, which for the body that persist brings back is zero:
        // a 1/1 with a −1/−1 counter on it deals nothing, and the state-based actions put it in
        // the graveyard again the moment this has resolved. That is the printed card.
        const inst = c.state.instances[c.source];
        const power = inst === undefined ? 0 : characteristicsOf(c.state, inst).power;
        return power <= 0 ? c.state : damageFirstTarget(c, power);
      },
    },
    ...comesBackWithACounter('persist'),
  ],
};

/**
 * Kitchen Finks: persist's second card, and the first hybrid cost the engine can pay.
 *
 * Two declarative lines and nothing new. `{1}{G/W}{G/W}` is the mana layer's business (D190), the
 * life is `gainLife`, and persist has been `comesBackWithACounter` since D181 — which is the point
 * of adding it: a mechanic with one card behind it has one card's worth of coverage, and the Redcap
 * is a 1/1 whose second body is a 0/0 that dies again immediately. The Finks is a 3/2, so the body
 * that comes back is a **2/1 that lives**, which is the half of persist the pool could not show.
 */
const KITCHEN_FINKS: CardScript = {
  name: 'Kitchen Finks',
  triggers: [
    {
      on: { kind: 'etb', who: 'self' },
      description: 'you gain 2 life',
      effect: (c) => gainLife(c.state, c.controller, 2),
    },
    ...comesBackWithACounter('persist'),
  ],
};

const KALITAS: CardScript = {
  name: 'Kalitas, Traitor of Ghet',
  replaces: [
    {
      on: 'dies',
      description: 'exile it instead and create a 2/2 black Zombie creature token',
      applies: (c) => {
        const dying = c.state.instances[c.subject];
        if (dying === undefined || dying.isToken === true) return false;
        if (dying.zoneSeat === c.controller) return false;
        return characteristicsOf(c.state, dying).isCreature;
      },
      instead: (c) => createToken(exileCard(c.state, c.subject), c.controller, ZOMBIE_TOKEN, 1),
    },
  ],
};

/**
 * Goad all creatures you don't control (CR 701.38).
 *
 * The only card in the pool whose worth depends on how many people are playing, and the first one
 * to need a duration anchored to a seat: goad lasts *until your next turn*, so it has to outlive
 * the turn it was cast in and every turn in between. See `EffectDuration`.
 *
 * `goadsOpponents` is what stops the bot casting it in a duel, where the second half of the card
 * can never be satisfied and goading is paying four mana to be attacked.
 */
const DISRUPT_DECORUM: CardScript = {
  name: 'Disrupt Decorum',
  goadsOpponents: true,
  onResolve: (c) => {
    // Resolved against the board as it is now, which is what "all creatures you don't control"
    // means: a creature that arrives afterwards was not there to be goaded.
    const theirs = opponentsOf(c.state, c.controller)
      .flatMap((seat) => creaturesControlledBy(c.state, seat));
    return goad(c.state, theirs, c.source, c.controller);
  },
};

// ── Red-blue: the deck whose creatures are paid for by its spells ───────────────────────────────

/*
  Six cards for Arc Tempest, and the thing they have in common is the thing the pool was missing.

  Eight decks, and every one of them won with creatures or with a library. Nothing in the pool had
  ever been built so that *casting a spell* was itself the thing that advanced the board, which
  meant the `spell-cast` trigger — among the oldest in the engine, and the one Talrand, prowess,
  Firebrand Archer and the two magecraft cards all use — had never had a deck that was about it.
  So: five creatures that each convert a cast into something, and a Drake whose size is a fact
  about the deck's own graveyard.

  Only one of the six needed anything new, and it is the Drake. The other five are assembled out of
  parts that already shipped, which is the useful fact here: a trigger kind with four readers had
  the vocabulary for a whole archetype and nobody had asked it for one.
*/

export const ELEMENTAL_TOKEN: CardDef = {
  name: 'Elemental', typeLine: 'Token Creature — Elemental', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: '', colors: ['R'],
};

/**
 * Adeliz, the Cinder Wind: the commander, and the one card here that reads a creature *type*.
 *
 * Every other pump in the pool hits one named permanent, the caster's whole team, or the whole
 * board. "Each Wizard you control" is narrower than any of those, and it does not need a new scope
 * to be: `pump` takes a list of ids, so the filtering is the card's own business and the engine's
 * `controller-creatures` scope stays a scope about control rather than about subtypes. A static
 * effect reading "Wizards you control get +1/+1" could not be written this way at all — that is
 * `ContinuousEffect`'s subtype scope, a different problem, and it is the one the tribal lords
 * further down this file went on to build.
 *
 * She is a Wizard herself, which is why she is a clock on an empty board: two spells in a turn and
 * the 2/2 flier that cost {1}{U}{R} is swinging for four.
 */
const ADELIZ: CardScript = {
  name: 'Adeliz, the Cinder Wind',
  keywords: ['flying', 'haste'],
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
      description: 'each Wizard you control gets +1/+1 until end of turn',
      effect: (c) => {
        const wizards = creaturesControlledBy(c.state, c.controller).filter((id) => {
          const inst = c.state.instances[id];
          return inst !== undefined
            && hasSubtype(characteristicsOf(c.state, inst).typeLine, 'wizard');
        });
        return pump(c.state, wizards, c.source, c.controller, { power: 1, toughness: 1 });
      },
    },
  ],
};

/** Prowess on a flier with haste, which is the whole card. */
const STORMCHASER_MAGE: CardScript = {
  name: 'Stormchaser Mage',
  keywords: ['flying', 'haste', 'prowess'],
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'noncreature' },
      description: 'Prowess — +1/+1 until end of turn',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 1, toughness: 1 }),
    },
  ],
};

/** Talrand's shape at a third of the cost, for a token a third of the size. */
const YOUNG_PYROMANCER: CardScript = {
  name: 'Young Pyromancer',
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
      description: 'create a 1/1 red Elemental creature token',
      effect: (c) => createToken(c.state, c.controller, ELEMENTAL_TOKEN, 1),
    },
  ],
};

/** Firebrand Archer's shape at twice the damage, which is a clock rather than a tax. */
const GUTTERSNIPE: CardScript = {
  name: 'Guttersnipe',
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
      description: 'deals 2 damage to each opponent',
      effect: (c) => opponentsOf(c.state, c.controller).reduce(
        (state, seat) => dealDamage(state, { kind: 'player', seat }, 2, { controller: c.controller, source: c.source }),
        c.state,
      ),
    },
  ],
};

/**
 * Gelectrode: Thermo-Alchemist's text with a target, and a Wizard to go under Adeliz.
 *
 * The difference from the Alchemist is not the mana cost. The Alchemist hits each opponent and
 * cannot be aimed, so it is a clock and nothing else; Gelectrode's damage chooses, which makes the
 * same ability also the deck's answer to an X/1. Both untap on a spell, so both are "once per spell
 * you cast" rather than once per turn — the reason a deck holding twenty-five instants and
 * sorceries wants either of them at all.
 */
const GELECTRODE: CardScript = {
  name: 'Gelectrode',
  abilities: [
    {
      cost: { tap: true },
      targets: [ANY_TARGET],
      description: '{T}: Gelectrode deals 1 damage to any target.',
      effect: (c) => {
        const target = c.targets[0];
        return target === undefined
          ? c.state
          : dealDamage(c.state, target, 1, { controller: c.controller, source: c.source });
      },
    },
  ],
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
      description: 'untap Gelectrode',
      effect: (c) => tap(c.state, c.source, false),
    },
  ],
};

/**
 * Enigma Drake: the second characteristic-defining ability in the pool, and the first that is a
 * fact about one player's deck rather than about the table.
 *
 * Lhurgoyf counts creature cards in *all* graveyards and sets both halves of its size from the
 * count. This one counts instants and sorceries in *your* graveyard and sets only its power — the
 * toughness is printed, which is what `applies: 'power'` is for. Both of those were additions to
 * `definesSize`, and both were additions rather than a second mechanism because the hard part of a
 * CDA is already solved: the number is read fresh on every characteristic lookup, so a Drake gets
 * bigger as the deck does its own thing and smaller if somebody exiles the graveyard, with no
 * trigger, no event and nothing to invalidate.
 *
 * It is also the one creature in Arc Tempest that is a threat without the rest of the deck having
 * resolved first. A 1/4 flier on turn three is a blocker; the same card on turn eight is a six-
 * power flier, and nothing was spent getting it there that the deck was not spending anyway.
 */
const ENIGMA_DRAKE: CardScript = {
  name: 'Enigma Drake',
  keywords: ['flying'],
  statics: [{
    scope: 'self',
    effect: { definesSize: { count: 'instant-and-sorcery-cards-in-your-graveyard', applies: 'power' } },
  }],
};

// ── Tribal lords: the scope that reads a creature type ──────────────────────────────────────────

/*
  Three cards for one scope, and the reason there are three is that one would not have proved it.

  Until now `ContinuousEffect` could say "this card", "creatures you control", "other creatures you
  control" or "all creatures", and nothing narrower. Adeliz got round that because a *one-shot*
  pump takes a list of ids and may filter however the card likes; a static cannot, because a static
  is a declarative object that goes to Redis and down a socket, so the filter has to be something
  the engine can perform from what was stored. Hence `controller-subtype`, with the `other` clause
  every printed lord carries.

  Three because the three halves worth checking are separate: that the scope carries a **size**
  (all three), that it carries **keywords** (first strike, indestructible), and that it follows the
  board rather than a list — a lord that makes its own tribe pumps the tokens it made, and a second
  copy pumps the first. The cards are in three different decks and three different colours for the
  same reason the Vehicles ended up split: a card goes where its ratio works.

  **The lord this pool most obviously wanted is deliberately not here.** Goblin Chieftain in Ember
  Rush, with Krenko making Goblin tokens to pump, is the strongest version of this card in the whole
  pool — and Ember Rush already wins 82% of its games. A scope is worth proving; handing the best
  deck a free upgrade is not, and the three decks below sit between 36% and 45%.
*/

export const ELF_WARRIOR_TOKEN: CardDef = {
  name: 'Elf Warrior', typeLine: 'Token Creature — Elf Warrior', manaCost: '', cmc: 0,
  power: '1', toughness: '1', oracleText: '', colors: ['G'],
};

/**
 * Stromkirk Captain: the first lord, and the one that hands out a combat keyword.
 *
 * First strike across a board of Blood Artists turns a deck of 0/1s into a deck of 1/2s that kill
 * a 1/1 blocker without being hit back, which is a different card from +1/+1 — and it is the half
 * that would have been impossible to write as anything but a static, since combat reads keywords
 * off the creature at the moment blockers are declared.
 */
const STROMKIRK_CAPTAIN: CardScript = {
  name: 'Stromkirk Captain',
  keywords: ['first strike'],
  statics: [{
    scope: { subtype: 'Vampire', other: true },
    effect: { power: 1, toughness: 1, keywords: ['first strike'] },
  }],
};

/**
 * Knight Exemplar, which grants the keyword that is hardest to answer.
 *
 * Indestructible on somebody else's creature is the sharpest test of the scope's *duration*: the
 * Knights stop being indestructible the moment the Exemplar leaves, and a sweeper that kills the
 * Exemplar kills the Knights with it, because the effect is gone before state-based actions look at
 * lethal damage. That falls out of `duration: 'permanent'` meaning "while the source is on the
 * battlefield" and needed nothing of its own — which is the point of the note at `expire`.
 */
const KNIGHT_EXEMPLAR: CardScript = {
  name: 'Knight Exemplar',
  statics: [{
    scope: { subtype: 'Knight', other: true },
    effect: { power: 1, toughness: 1, keywords: ['indestructible'] },
  }],
};

/**
 * Imperious Perfect: a lord that makes its own tribe.
 *
 * The one that shows the scope reads the board rather than a list. Every token it makes is an Elf,
 * so every token it makes is pumped by it — and by any other copy — with nothing recomputed and no
 * event saying a new Elf exists. `other: true` keeps it off itself, so two copies are a pair of
 * 3/3s rather than two 2/2s that each think they are bigger.
 */
const IMPERIOUS_PERFECT: CardScript = {
  name: 'Imperious Perfect',
  statics: [{
    scope: { subtype: 'Elf', other: true },
    effect: { power: 1, toughness: 1 },
  }],
  abilities: [
    {
      cost: { mana: '{1}{G}', tap: true },
      description: '{1}{G}, {T}: Create a 1/1 green Elf Warrior creature token.',
      effect: (c) => createToken(c.state, c.controller, ELF_WARRIOR_TOKEN, 1),
    },
  ],
};

// ── The creature the event was about ────────────────────────────────────────────────────────────

/*
  Two keywords that cannot be written without knowing *which* creature the event happened to.

  Every board-watching trigger before these two could only talk about itself. A Blood Artist sees a
  creature die and drains a player; an Impact Tremors sees a creature enter and deals 1 damage —
  neither of them ever has to point at the creature in question. Exalted and evolve both do, and
  they are the shape the engine was missing rather than two more cards: "**that** creature gets
  +1/+1" and "if **that** creature is bigger than this one" (CR 603.3d). So the three events that
  are about one permanent now carry which permanent, and `EffectContext.subject` is where a script
  reads it.

  Evolve brings the other half with it, and it is a rule rather than a convenience: the
  intervening-if clause (CR 603.4). "If that creature has greater power or toughness" is checked
  **twice** — when the trigger would go on the stack, and again as it resolves — and a condition
  that is false either time means the ability does nothing at all. Both halves matter at a real
  table. The first is why a Cloudfin Raptor that is already a 3/4 does not put a trigger on the
  stack for a 1/1 Pest arriving, so nobody has to watch an ability resolve into nothing. The second
  is why bouncing the creature that caused the trigger is an *answer* to it, instead of a tempo
  loss that still leaves the counter behind.
*/

/**
 * Exalted, the keyword that pays you for not attacking with everything (CR 702.90).
 *
 * The condition it checks is unusual and is the reason the event carries `alone`: "attacks alone"
 * is a fact about the *declaration*, not about the creature. By the time this ability resolves a
 * second attacker could have been removed from combat, and the board would read the same either
 * way — so the engine writes it on the event, where it is still true.
 *
 * On a 2/3 defender on purpose. A card that can never attack itself is the honest home for a
 * trigger that only pays when one creature attacks: the Guardians hold the ground this deck keeps
 * losing on, and the Serra Angel that swings into an empty sky swings as a 5/5.
 */
/**
 * Exalted, written out as the triggered ability the keyword abbreviates (CR 702.90a).
 *
 * "Whenever a creature you control attacks alone, that creature gets +1/+1 until end of turn" —
 * the whole of it, with nothing printed anywhere else on the card. So this is a keyword whose
 * declaration *is* its ability, which is what makes it safe for `keywordScriptFor` to build: there
 * is no second line to miss and no number to invent (D259).
 *
 * `alone: true` is the half that is the rule rather than the effect, and `attacks` with
 * `who: 'any', of: 'you'` is the other: exalted watches **any** creature its controller attacks
 * with, not itself, which is why a Guardians of Akrasa that stays home still pumps the attacker.
 * A factory rather than text on the one card, so the hand-written card and the compiled reading
 * share one implementation — `ninjutsuAbility`'s arrangement (D421).
 */
const exaltedTrigger = (): TriggerDef => ({
  on: { kind: 'attacks', who: 'any', of: 'you', alone: true },
  description: 'Exalted: the attacking creature gets +1/+1 until end of turn.',
  effect: (c) => (c.subject === undefined
    ? c.state
    : pump(c.state, [c.subject], c.source, c.controller, { power: 1, toughness: 1 })),
});

const GUARDIANS_OF_AKRASA: CardScript = {
  name: 'Guardians of Akrasa',
  triggers: [exaltedTrigger()],
};

/**
 * Evolve's question, asked of the board twice: is what just arrived bigger than this (CR 702.100a)?
 *
 * **Power or toughness**, not both and not the pair — a 1/5 Wall evolves a 2/2 and so does a 5/1
 * burn-proof attacker, which is what makes the keyword work in a deck full of blockers. Read
 * through `characteristicsOf` rather than off the printed card, so a creature that entered under an
 * anthem counts at the size it actually is.
 *
 * Returns false for a subject that has already gone, which is the second ask doing its job: a
 * creature bounced or killed in response is not on the battlefield to be measured, and an ability
 * whose condition cannot be met does nothing.
 */
function evolvesInto(state: GameState, source: string, subject: string | undefined): boolean {
  if (subject === undefined) return false;
  const self = state.instances[source];
  const other = state.instances[subject];
  if (self === undefined || other === undefined) return false;
  if (self.zone !== 'battlefield' || other.zone !== 'battlefield') return false;
  const mine = characteristicsOf(state, self);
  const theirs = characteristicsOf(state, other);
  return theirs.power > mine.power || theirs.toughness > mine.toughness;
}

/**
 * Cloudfin Raptor: a one-mana 0/1 that is a 3/4 flier by turn four, or dead to nothing at all.
 *
 * The card evolve was printed on, and the clearest possible test of the clause. It grows off
 * creatures it has nothing else to do with — a Wall of Air, a Fog Bank, a Returned Centaur — which
 * is why it belongs in the deck whose early game is made of blockers rather than in one that wants
 * its one-drop to attack.
 *
 * Note what it does **not** do: `who: 'another'` keeps it from evolving off its own arrival, and
 * the condition keeps it from triggering at all once it is the biggest thing on the board. Both are
 * the printed card, and both are checks the engine makes rather than text this script carries.
 */
/**
 * Evolve, written out as the triggered ability the keyword abbreviates (CR 702.100a).
 *
 * "Whenever a creature enters the battlefield under your control, if that creature has greater
 * power or toughness than this creature, put a +1/+1 counter on this creature." The `condition` is
 * the printed intervening-if and it is not decoration: it is asked again on resolution, which is
 * what `evolvesInto` above is for and why a creature killed in response evolves nothing.
 *
 * `who: 'another'` is the word "a creature" meaning any but itself, and `of: 'you'` is "under your
 * control". A factory for the reason `exaltedTrigger` is one.
 */
const evolveTrigger = (name: string): TriggerDef => ({
  on: { kind: 'etb', who: 'another', of: 'you', what: 'creature' },
  description: `Evolve: put a +1/+1 counter on ${name}.`,
  condition: (c) => evolvesInto(c.state, c.source, c.subject),
  effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
});

const CLOUDFIN_RAPTOR: CardScript = {
  name: 'Cloudfin Raptor',
  triggers: [evolveTrigger('Cloudfin Raptor')],
};

// ── Changing what a spell is pointed at ─────────────────────────────────────────────────────────

/*
  The first effect here that reaches into an object already on the stack.

  Everything else in this file reads the board and changes the board. These two read somebody
  else's *spell* and change a choice its controller made, which needs three things the engine did
  not have: a way to say "a spell with a single target" in a `TargetSpec`, a way to replace a stack
  object's target, and the rule that decides when the change is allowed (CR 114.6). The second of
  those lives in `targeting.ts` beside the legality rules rather than in `effects.ts` with the
  things that deal damage, because that is what it is about.

  **Spells and abilities both, now.** This comment used to say "spells, and not abilities", because
  a `Target` was a card or a player and an ability on the stack is neither — so Willbender's printed
  "or ability" half needed a third `Target` shape threaded through every reader of that union. That
  shape now exists (`{ kind: 'ability', id }`), the day the old comment warned about has arrived,
  and Willbender does what it says on the card. What the work actually cost is worth recording,
  because it was a tenth of the estimate: `targetKey` and five dedup keys in the bot, because
  `tsc` found every ternary that reached for `.seat` — and four honest refusals, since an ability
  cannot be damaged, shielded, warded or be *a different object* than the one that was chosen.

  Both cards also ask for *two* targets, which nothing in the pool had done before — the spell, and
  where it is going. The second is declared `any`, which is wider than the spell's own spec, and
  that is deliberate: CR 115.7b says a change that cannot be made legally simply is not made, so
  `retarget` is the thing that judges it and a target it refuses leaves the spell exactly as it was.
*/

/**
 * The specs an ability on the stack wants targets for — printed on its permanent, or granted to it.
 *
 * One function because there were three copies of this lookup and they now have to agree about one
 * more thing: a granted ability is defined on the granting card, not on the permanent that has it
 * (CR 113.6), so the holder's own `triggers` is the wrong array to index. The copies were in the
 * prompt that asks for a trigger's targets, in the legal-actions snapshot the table renders that
 * prompt from, and in the redirect check — three places that have to offer the same list, because
 * a target the table draws and the engine then refuses is the failure mode this engine treats as a
 * bug rather than a message.
 */
export function abilityTargetSpecs(
  state: GameState, object: StackObject,
): readonly TargetSpec[] {
  if (object.abilityIndex === undefined) return [];
  if (object.grantedBy !== undefined) {
    return scriptFor(object.grantedBy.card)?.grantedTriggers?.[object.grantedBy.index]?.targets
      ?? [];
  }
  const script = scriptFor(state.cardDefs[object.cardKey]?.name);
  return (object.kind === 'activated'
    ? script?.abilities?.[object.abilityIndex]?.targets
    : script?.triggers?.[object.abilityIndex]?.targets) ?? [];
}

/**
 * The single target spec an object on the stack has, when it unambiguously has one.
 *
 * `null` for everything that cannot be redirected *soundly*: an object with no targets or several,
 * a modal spell whose targets belong to the mode it was cast with rather than to the card, and
 * anything whose script cannot be found. An object this returns `null` for is not offered as a
 * target at all, rather than being offered and then quietly failing — which is the "one planner
 * for the offer and the payment" rule this engine uses for convoke, crew and morph.
 *
 * A spell and an ability reach their spec by different routes and that is the whole of the
 * difference: a spell's targets are on the card, and an ability's are on the ability, which the
 * stack object names by index.
 */
export function soleTargetSpecOf(state: GameState, id: string): TargetSpec | null {
  const object = state.stackObjects[id];
  if (object === undefined || object.targets.length !== 1) return null;
  if (object.kind === 'spell') {
    const inst = state.instances[id];
    const script = scriptFor(state.cardDefs[inst?.defKey ?? '']?.name);
    if (script === undefined || script.modal !== undefined) return null;
    const specs = script.targets ?? [];
    return specs.length === 1 ? specs[0] ?? null : null;
  }
  // An activated or triggered ability. Its source is a permanent — or a token that has ceased to
  // exist, in which case there is no script to read and the ability is simply not redirectable.
  const specs = abilityTargetSpecs(state, object);
  return specs.length === 1 ? specs[0] ?? null : null;
}

/**
 * "Target spell or ability with a single target", with the clause that makes it worth casting.
 *
 * An object is only offered when there is **somewhere else to send it**: `legalTargets` is asked
 * for its own spec, with its own controller as the chooser, and at least one answer has to be
 * something other than the target it already has. Without that the card is castable into a board
 * where the only legal target is the current one, which is a card thrown away — the same judgement
 * the bot's "spent on nothing" rules make, made here instead because it is a fact about legality
 * rather than a preference.
 *
 * `also` is only ever passed with `kind: 'spell'` (it reads a printed type line, which an ability
 * does not have), so it never sees an ability's id.
 */
const redirectable = (
  kind: 'spell' | 'spell-or-ability',
  description: string,
  also?: (state: GameState, id: string) => boolean,
): TargetSpec => ({
  kind,
  description,
  filter: (state, candidate) => {
    if (candidate.kind === 'player') return false;
    if (also !== undefined && !also(state, candidate.id)) return false;
    const spec = soleTargetSpecOf(state, candidate.id);
    if (spec === null) return false;
    const object = state.stackObjects[candidate.id];
    const current = object?.targets[0];
    if (object === undefined || current === undefined) return false;
    return legalTargets(state, spec, object.controller, candidate.id)
      .some((t) => targetKey(t) !== targetKey(current));
  },
});

/** The second choice both cards ask for: where the spell is going instead. */
const NEW_TARGET: TargetSpec = { kind: 'any', description: 'the new target' };

/** The shared body: `targets[0]` is the spell or ability, `targets[1]` is where it goes. */
const redirect = (c: EffectContext): GameState => {
  const object = c.targets[0];
  const next = c.targets[1];
  if (object === undefined || object.kind === 'player' || next === undefined) return c.state;
  const spec = soleTargetSpecOf(c.state, object.id);
  if (spec === null) return c.state;
  return retarget(c.state, object.id, next, spec) ?? c.state;
};

/*
  Read off the **stack object** rather than off a card instance, which matters for one case.

  A copy of a spell is a spell with the original's characteristics and no card at all (CR 707.10),
  so `instances[id]` is empty for it — and the earlier version of this, which went through the
  instance, quietly answered "not an instant" for a copied Lightning Bolt. Going through `cardKey`
  answers the same for every spell that was cast and correctly for the copies, and a copy of a
  copy is a legal Twincast target exactly as the rules say.
*/
const isInstantOrSorcerySpell = (state: GameState, id: string): boolean => {
  const object = state.stackObjects[id];
  if (object?.kind !== 'spell') return false;
  const line = parseTypeLine(state.cardDefs[object.cardKey]?.typeLine);
  return hasType(line, 'instant') || hasType(line, 'sorcery');
};

const WILLBENDER: CardScript = {
  name: 'Willbender',
  morph: { cost: { mana: '{1}{U}' } },
  triggers: [{
    on: { kind: 'turned-face-up' },
    description: 'change the target of target spell or ability with a single target',
    targets: [
      redirectable('spell-or-ability', 'target spell or ability with a single target'),
      NEW_TARGET,
    ],
    effect: redirect,
  }],
};

const SWERVE: CardScript = {
  name: 'Swerve',
  targets: [
    redirectable('spell', 'target instant or sorcery spell with a single target', isInstantOrSorcerySpell),
    NEW_TARGET,
  ],
  onResolve: redirect,
};

// ── Countering the thing a permanent is doing ───────────────────────────────────────────────────

/*
  Two counterspells that are not about spells, and the family the pool had no answer to at all.

  Everything that answers a permanent in this pool answers the *permanent*: a Doom Blade kills the
  Icy Manipulator, but not the tap it already activated; a Murder kills the Jace, but not the loyalty
  ability on the stack above it. An ability, once it is on the stack, has always been unanswerable
  here — and that is a whole half of interaction missing rather than a missing card, because the
  rules make an ability an object you may point at (CR 115.4) and this engine could not say so.

  So these two are the shape rather than two more cards:

  - **Squelch** is "counter target activated ability", which is the narrow one: its spec filters the
    ability's own kind, and a `filter` on an ability candidate is a thing that had nowhere to live
    before. It also draws a card, which is why it is in a deck at all — a narrow answer that
    replaces itself is never a card thrown away.
  - **Disallow** is "counter target spell, activated ability, or triggered ability", which is the
    wide one, and the reason `spell-or-ability` is a kind: a card that takes either should say so
    rather than hoping that whatever it is handed has an `id`.

  Both resolve through the same `counterSpell` the Cancel uses, and have since long before this —
  "an ability has no card, so countering one simply removes it" was written there the day the stack
  was built. Nothing could reach it.
*/

const isActivatedAbility = (state: GameState, candidate: Target): boolean =>
  candidate.kind === 'ability' && state.stackObjects[candidate.id]?.kind === 'activated';

const SQUELCH: CardScript = {
  name: 'Squelch',
  targets: [{
    kind: 'ability',
    description: 'target activated ability',
    filter: isActivatedAbility,
  }],
  onResolve: (c) => {
    const id = firstAbilityTarget(c);
    /*
      The draw is part of the effect, which means it does *not* happen if the ability is gone.

      Worth saying because the opposite is the tempting reading: a Squelch whose only target has
      left the stack is countered on resolution and does nothing at all, draw included
      (CR 608.2b). That is also why the card is never a dead *draw*: it cannot be cast with nothing
      to point at, and the only object that could get above it on the stack is something answering
      the Squelch itself.
    */
    if (id === null) return c.state;
    return draw(counterSpell(c.state, id), c.controller, 1);
  },
};

const DISALLOW: CardScript = {
  name: 'Disallow',
  targets: [{ kind: 'spell-or-ability', description: 'target spell or ability' }],
  onResolve: (c) => {
    const object = c.targets[0];
    // One id, two kinds of object, one function: `counterSpell` buries a spell's card and simply
    // removes an ability, which is the difference the rules draw and the only one there is.
    return object === undefined || object.kind === 'player'
      ? c.state
      : counterSpell(c.state, object.id);
  },
};

// ── The questions whose answers are words ───────────────────────────────────────────────────────

/*
  Two cards that ask something no card here could ask before: a question whose answer is not a card.

  Every mid-resolution question in this file until now has been "choose some cards from a zone" — a
  search, a discard, a scry, a sacrifice. "Choose a creature type" and "choose a colour" name no
  object at all, and the shape for them is `ChoiceDecisionSpec`.

  **Both of them choose as they enter, and that is the rules point.** A `decisions` list is asked
  during the spell's own resolution, which is *before* the permanent is put onto the battlefield —
  so the choice is made with the card still on the stack, which is exactly what "as ~ enters the
  battlefield" means (CR 614.12). An entry *trigger* would be a different card: it would go on the
  stack after the permanent arrived, both players would get priority, and killing the Obelisk in
  that window would leave a creature type chosen and nothing pumping it. There is no such window
  here, and that is not an accident of where the code went.

  The other half is that each card installs its own continuous effect from its own `onResolve`,
  rather than declaring a `statics` entry. A declared static is a fixed thing the engine installs on
  arrival; these two are not fixed until somebody answers, so the effect is built with the answer in
  it. `duration: 'permanent'` means "while the source is on the battlefield", so pushing it a moment
  before the permanent gets there is fine — state-based actions, which are what purge an effect
  whose source has gone, do not run in the middle of a resolution.
*/

/**
 * The creature types worth choosing between: every one with eight or more copies in the pool.
 *
 * A derived list rather than a judged one, and the honest deviation from the printed card is in
 * the same sentence — Obelisk of Urd says "choose a creature type", meaning any of several hundred.
 * A table cannot draw several hundred buttons, and a list of the types this pool actually contains
 * is the version that makes the same choices for the same reasons. The order is the order they are
 * offered in, which is also the tie-break: commonest first.
 */
const CHOOSABLE_TYPES: readonly string[] = [
  'Human', 'Vampire', 'Shaman', 'Monk', 'Wizard', 'Soldier', 'Warrior', 'Knight', 'Goblin', 'Elf',
  'Cat', 'Wall', 'Zombie',
];

/** The type this seat controls the most of, for the bot. Ties go to the earlier type in the list. */
function commonestTypeOf(state: GameState, seat: SeatIndex): string | undefined {
  const counts = new Map<string, number>();
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (!ch.isCreature) continue;
    for (const type of CHOOSABLE_TYPES) {
      if (hasSubtype(ch.typeLine, type)) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let most = 0;
  for (const type of CHOOSABLE_TYPES) {
    const n = counts.get(type) ?? 0;
    if (n > most) { most = n; best = type; }
  }
  return best;
}

/**
 * Obelisk of Urd: convoke, choose a creature type, and that type gets +2/+2.
 *
 * Three things the engine already had and one it did not. Convoke pays for a five-mana artifact on
 * turn three with a board of creatures (D101); the `controller-subtype` scope performs the filter
 * from a stored string rather than a list, so the Elf token made four turns later is pumped with
 * nothing recomputed (D129); `duration: 'permanent'` ends the effect the moment the Obelisk leaves.
 * The choice is the new part, and it is the whole card: the same artifact is a +2/+2 anthem for
 * nine creatures in one deck and for three in another.
 */
const OBELISK_OF_URD: CardScript = {
  name: 'Obelisk of Urd',
  convoke: true,
  decisions: [{
    who: 'controller',
    prompt: 'Choose a creature type',
    options: CHOOSABLE_TYPES,
    best: commonestTypeOf,
  }],
  onResolve: (c) => {
    const type = chosenOption(c);
    if (type === null) return c.state;
    return staticEffect(
      c.state, c.source, c.controller,
      { kind: 'controller-subtype', subtype: type },
      { power: 2, toughness: 2 },
    );
  },
};

/** The five colours as words, because a button saying "W" is a button nobody can read. */
const COLOUR_WORDS: Readonly<Record<string, Color>> = {
  white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G',
};
const COLOUR_OPTIONS: readonly string[] = ['black', 'red', 'white', 'blue', 'green'];

/**
 * The colour this seat has most to fear, read off what it can actually see.
 *
 * Opponents' battlefields and graveyards only — both public. A bot that read their hands would be
 * answering a question no player can answer, which is the line this project keeps drawing: the
 * search is allowed to be bad, not to be clairvoyant. The graveyard is the better half of the read
 * anyway, because a removal spell that has already been cast is in it.
 *
 * Ties go to black and then red, which is the order `COLOUR_OPTIONS` is in: those are the two
 * colours that hold this pool's removal, so an empty board gets the answer a player would give.
 */
function colourToFear(state: GameState, seat: SeatIndex): string | undefined {
  const counts = new Map<string, number>();
  for (const other of state.seats) {
    if (other.index === seat || other.eliminated) continue;
    const seen = [
      ...listAt(state, zoneKey(other.index, 'battlefield')),
      ...listAt(state, zoneKey(other.index, 'graveyard')),
    ];
    for (const id of seen) {
      const def = state.cardDefs[state.instances[id]?.defKey ?? ''];
      for (const word of COLOUR_OPTIONS) {
        if ((def?.colors ?? []).includes(COLOUR_WORDS[word]!)) {
          counts.set(word, (counts.get(word) ?? 0) + 1);
        }
      }
    }
  }
  let best: string | undefined;
  let most = 0;
  for (const word of COLOUR_OPTIONS) {
    const n = counts.get(word) ?? 0;
    if (n > most) { most = n; best = word; }
  }
  return best;
}

/**
 * Voice of All: a 2/2 flier with protection from a colour nobody declared in advance.
 *
 * The closed-set half of the same primitive — five options, so there is no approximation to admit
 * to — and the card that makes protection's four rules (D83) worth having had: a creature nothing
 * in one deck can target, kill in combat, block or damage, chosen after seeing which deck it is
 * facing. Against the two colours holding this pool's removal it simply cannot be answered.
 */
const VOICE_OF_ALL: CardScript = {
  name: 'Voice of All',
  decisions: [{
    who: 'controller',
    prompt: 'Choose a colour',
    options: COLOUR_OPTIONS,
    best: colourToFear,
  }],
  onResolve: (c) => {
    const word = chosenOption(c);
    const colour = word === null ? undefined : COLOUR_WORDS[word];
    if (colour === undefined) return c.state;
    return staticEffect(
      c.state, c.source, c.controller, { kind: 'cards', ids: [c.source] },
      { protectionFrom: [colour] },
    );
  },
};

// ── White-black: the life total that goes up ────────────────────────────────────────────────────

/*
  The tenth deck's own cards, and the engine path that had exactly one reader.

  `life-gained` has been a trigger event since the triggers were written, and until this deck the
  only card that read it was an Ajani's Pridemate sitting in a red-white deck that gains life by
  accident. Nine decks measured the game in damage or in cards; none of them went *up* on purpose.

  What makes it an archetype rather than a theme is that the gain is an input. Two cards turn life
  into a creature that grows, two turn a death into both totals moving, and the removal spell gains
  life while it removes — so the same two mana that answers a threat also puts a counter on a
  flier. Kambal is the half a deck list cannot be: an opponent's noncreature spell costs them two
  and buys you two, which is the first card in the pool to say "**that** player" and mean one of
  them.
*/

const IMPASSIONED_ORATOR: CardScript = {
  name: 'Impassioned Orator',
  triggers: [
    {
      // A Soul Warden with a body, and the same "another": it does not pay for its own arrival.
      on: { kind: 'etb', who: 'another', of: 'any', what: 'creature' },
      description: 'you gain 1 life',
      effect: (c) => gainLife(c.state, c.controller, 1),
    },
  ],
};

/**
 * Bloodthirsty Aerialist: the second card in the pool to read `life-gained`, and the one that makes
 * it a clock.
 *
 * A Pridemate grows on the ground where a 1/1 Hawk can stop it. This one flies, which is what turns
 * "gain one life a turn" from a cushion into the thing that ends the game — and it is why the
 * removal spell in this deck gains two life rather than three mana's worth of nothing.
 */
const BLOODTHIRSTY_AERIALIST: CardScript = {
  name: 'Bloodthirsty Aerialist',
  triggers: [
    {
      on: { kind: 'life-gained', by: 'you' },
      description: 'put a +1/+1 counter on it',
      effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
    },
  ],
};

/**
 * Cruel Celebrant: a Blood Artist that needs no target and only reads your own side.
 *
 * Two differences from the Artist and both are printed: `of: 'you'` rather than any creature
 * dying, and no target at all — "each opponent" is every one of them rather than one chosen, which
 * in a pod is three life a death instead of one. The pair of them in one deck is the point: the
 * Artist aims at whoever is closest to dying, and the Celebrant does not have to.
 */
const CRUEL_CELEBRANT: CardScript = {
  name: 'Cruel Celebrant',
  triggers: [
    {
      on: { kind: 'dies', who: 'another', of: 'you', what: 'creature' },
      description: 'each opponent loses 1 life and you gain 1 life',
      effect: (c) => {
        let next = c.state;
        for (const seat of opponentsOf(c.state, c.controller)) next = loseLife(next, seat, 1);
        return gainLife(next, c.controller, 1);
      },
    },
  ],
};

const REVITALIZE: CardScript = {
  name: 'Revitalize',
  // Three life *and* a card, which is what stops a lifegain deck being a worse draw-go: the gain
  // is an input here, so a one-mana instant that replaces itself is a trigger plus a card.
  onResolve: (c) => draw(gainLife(c.state, c.controller, 3), c.controller, 1),
};

/**
 * Vraska's Contempt: removal that advances the plan it is protecting.
 *
 * Exile rather than destroy, which answers the two things this pool has that come back — a
 * commander and a regenerator — and two life on the way, which in this deck is a +1/+1 counter on
 * an Aerialist and another on a Pridemate. `removesACreature` applies cleanly: a planeswalker is
 * the only other thing it can point at, there are two in the pool, and holding it on a board with
 * nothing but a planeswalker is a far smaller mistake than casting it at your own creature.
 */
const VRASKAS_CONTEMPT: CardScript = {
  name: "Vraska's Contempt",
  removesACreature: true,
  targets: [{
    kind: 'any',
    description: 'target creature or planeswalker',
    filter: (state, candidate) => {
      if (candidate.kind !== 'card') return false;
      const inst = state.instances[candidate.id];
      if (inst === undefined) return false;
      const ch = characteristicsOf(state, inst);
      return ch.isCreature || hasType(ch.typeLine, 'planeswalker');
    },
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    if (id === null) return c.state;
    // Exiled first and the life gained second, which is the printed order and also the one that
    // matters: a creature whose death would have drained somebody is not dying here.
    return gainLife(exileCard(c.state, id), c.controller, 2);
  },
};

/**
 * Kambal, Consul of Allocation: the first card here that has to say "**that** player".
 *
 * Every other trigger in this file talks about its own controller, about a permanent, or about
 * every opponent. "Whenever an opponent casts a noncreature spell, **that player** loses 2 life"
 * is about one of them, and in a two-player game the wrong reading is indistinguishable from the
 * right one — which is the kind of bug a four-player pod finds a year later. `EffectContext.actor`
 * is who did it, set from the event the same way `subject` is.
 *
 * `spell: 'noncreature'` is the filter prowess already used and nothing else in the pool had: it
 * includes an artifact and an enchantment, which is what makes this card an answer to the decks
 * whose plan is spells rather than creatures.
 */
const KAMBAL: CardScript = {
  name: 'Kambal, Consul of Allocation',
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'opponent', spell: 'noncreature' },
      description: 'that player loses 2 life and you gain 2 life',
      effect: (c) => {
        const who = c.actor;
        if (who === undefined || who === c.controller) return c.state;
        return gainLife(loseLife(c.state, who, 2), c.controller, 2);
      },
    },
  ],
};

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

/**
 * Ward (CR 702.21), as a triggered ability — because that is exactly what the keyword is.
 *
 * "Ward [cost]" means "whenever this permanent becomes the target of a spell or ability an
 * opponent controls, counter it unless that player pays [cost]", and writing it out as the trigger
 * it abbreviates is what lets it use the machinery already here: the event comes from
 * `raiseTargeted`, the ability goes on the stack above the spell and resolves first, and the question
 * it asks is `wardAsks`. Nothing about ward is a static ability and nothing about it is a
 * replacement effect, which is the mistake worth not making — a warded creature can be targeted
 * all day, and the spell is answered on the stack rather than prevented from being aimed.
 *
 * The `name` is passed in rather than read from the source because the message a player reads
 * should say which creature did this, and by the time the ward resolves the only thing that knows
 * is the ability itself.
 */
function ward(name: string, cost: string): TriggerDef {
  return {
    on: { kind: 'targeted', by: 'opponent' },
    description: `Ward ${cost}`,
    effect: (c) => wardAsks(c, cost, name),
  };
}

/**
 * A 1/1 Pest that pays its controller a life when it dies — Sedgemoor Witch's token.
 *
 * The first token in the pool with an ability of its own, which needs nothing new: `scriptFor`
 * finds a script by name and a token has a name, so the script below is found for the token the
 * same way a printed card's is, and `settle`'s arrivals pass installs it like any other
 * permanent's. See the note at `applyStatics` about every way onto the battlefield.
 */
export const PEST_TOKEN: CardDef = {
  name: 'Pest', typeLine: 'Token Creature — Pest', manaCost: '', cmc: 0,
  power: '1', toughness: '1',
  oracleText: 'When this creature dies, you gain 1 life.', colors: ['B'],
};

const PEST: CardScript = {
  name: 'Pest',
  triggers: [
    {
      on: { kind: 'dies', who: 'self' },
      description: 'you gain 1 life',
      effect: (c) => gainLife(c.state, c.controller, 1),
    },
  ],
};

/*
  The two ward cards, and the clause that was wrong here for eight entries.

  Both are printed "Magecraft — Whenever you cast **or copy** an instant or sorcery spell", and the
  copy half used to be missing. The comment that stood here said why: "nothing in this pool copies
  an instant or a sorcery, so a `spell-cast` trigger is the whole of what these cards do at this
  table" — and it ended with the right instinct, that the day something did copy one this would be
  the line that was wrong.

  **Twincast arrived (D131) and nothing noticed.** A copy of a spell is not cast (CR 707.12), so the
  cast event could not see it and these two silently did half of what they read. Found by
  `card-promises.mjs`, which is an audit of exactly this — whether a script carries everything its
  card's text promises — and found through this comment rather than through the heuristic, which is
  worth knowing about how that instrument actually pays off.

  Both now ask for `how: 'any'`, which is the printed reading, and `settle` raises the copy. See
  D231.
*/
const DRAGONSGUARD_ELITE: CardScript = {
  name: 'Dragonsguard Elite',
  triggers: [
    ward('Dragonsguard Elite', '{1}'),
    {
      // Magecraft: a cast **or** a copy, which is the whole of what `how` exists for.
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery', how: 'any' },
      description: 'put two +1/+1 counters on Dragonsguard Elite',
      effect: (c) => addCounters(c.state, c.source, '+1/+1', 2),
    },
  ],
};

const SEDGEMOOR_WITCH: CardScript = {
  name: 'Sedgemoor Witch',
  keywords: ['menace'],
  triggers: [
    ward('Sedgemoor Witch', '{3}'),
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery', how: 'any' },
      description: 'create a 1/1 black Pest creature token',
      effect: (c) => createToken(c.state, c.controller, PEST_TOKEN, 1),
    },
  ],
};

/*
  The first card in the pool that announces *numbers* with its targets (CR 601.2d).

  Everything else that points at more than one thing does the same thing to each: Garruk untaps two
  lands, Breath of Darigaaz hits everything for one. Arc Lightning hands the caster a budget and
  lets them spend it, which is a shape printed on dozens of cards — Chandra's Pyrohelix, Forked
  Bolt, Fiery Confluence — and was not expressible here at all.

  The spec says it in three fields and the rules do the rest: `count: 3` is the most targets it may
  have, `optional: true` lets it be cast with fewer, and `divided: 3` is the budget. "One, two, or
  three targets" is then a consequence rather than a fourth field, because every target must be
  assigned at least one and the whole three must be assigned — zero targets cannot spend it and
  four cannot be paid.
*/
const ARC_LIGHTNING: CardScript = {
  name: 'Arc Lightning',
  targets: [{ kind: 'any', description: 'any target', count: 3, optional: true, divided: 3 }],
  // One `dealDamage` per target with its own share, rather than a loop over a single amount. Each
  // is a separate dealing of damage from the same source, which is what the card says and what
  // protection, prevention and deathtouch each have to be asked about separately.
  onResolve: (c) => dividedAmong(c).reduce(
    (state, { target, amount }) => dealDamage(state, target, amount, {
      controller: c.controller, source: c.source,
    }),
    c.state,
  ),
};

/*
  Two more planeswalkers, which doubles how many this pool has.

  Ten decks shared two of them — a Jace Beleren and a Garruk Wildspeaker — and a planeswalker is
  the one card type that plays differently from everything else here: it arrives, it survives, and
  it does something every turn without being tapped or sacrificed. Both of these are three
  abilities that the existing vocabulary already covers, which is the test of whether that claim is
  true: a counter, a pump, a token, a token, counters on a team, and a pair of numbers read off the
  board.

  The ultimates are the half worth naming. Neither is an **emblem** — the engine has no way to give
  a player a permanent ability with no permanent behind it — so both of these were chosen from the
  walkers whose last ability is a thing that happens once: five Cats, and a gain-and-draw as big as
  your lands. That is a real constraint on which planeswalkers this pool can carry, and it is why
  these two rather than a Liliana of the Dark Realms.
*/

export const CAT_TOKEN: CardDef = {
  name: 'Cat', typeLine: 'Token Creature — Cat', manaCost: '', cmc: 0,
  power: '2', toughness: '2', oracleText: '', colors: ['W'],
};

export const PLANT_TOKEN: CardDef = {
  name: 'Plant', typeLine: 'Token Creature — Plant', manaCost: '', cmc: 0,
  power: '0', toughness: '1', oracleText: '', colors: ['G'],
};

const AJANI_CALLER_OF_THE_PRIDE: CardScript = {
  name: 'Ajani, Caller of the Pride',
  abilities: [
    {
      cost: { loyalty: 1 },
      description: '+1: Put a +1/+1 counter on target creature.',
      targets: [TARGET_CREATURE_HELPED],
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : addCounters(c.state, id, '+1/+1', 1);
      },
    },
    {
      cost: { loyalty: -3 },
      description: '−3: Target creature gains flying and double strike until end of turn.',
      targets: [TARGET_CREATURE_HELPED],
      // The card this deck is built to point it at is a Serra Angel or a Leonin Skyhunter: double
      // strike on something that already gets through is the fastest clock in the pool.
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : pump(c.state, [id], c.source, c.controller, {
          keywords: ['flying', 'double strike'],
        });
      },
    },
    {
      cost: { loyalty: -8 },
      description: '−8: Create five 2/2 white Cat creature tokens.',
      effect: (c) => createToken(c.state, c.controller, CAT_TOKEN, 5),
    },
  ],
};

const NISSA_VOICE_OF_ZENDIKAR: CardScript = {
  name: 'Nissa, Voice of Zendikar',
  abilities: [
    {
      cost: { loyalty: 1 },
      description: '+1: Create a 0/1 green Plant creature token.',
      effect: (c) => createToken(c.state, c.controller, PLANT_TOKEN, 1),
    },
    {
      cost: { loyalty: -2 },
      description: '−2: Put a +1/+1 counter on each creature you control.',
      // Counters rather than a pump, which is the difference between this and an Overrun: they
      // stay, they stack with the next activation, and a sweeper that kills everything else leaves
      // the survivor bigger.
      effect: (c) => creaturesControlledBy(c.state, c.controller).reduce(
        (state, id) => addCounters(state, id, '+1/+1', 1),
        c.state,
      ),
    },
    {
      cost: { loyalty: -7 },
      description: '−7: You gain X life and draw X cards, where X is the number of lands you control.',
      effect: (c) => {
        const lands = listAt(c.state, zoneKey(c.controller, 'battlefield')).filter((id) => {
          const inst = c.state.instances[id];
          return inst !== undefined && characteristicsOf(c.state, inst).isLand;
        }).length;
        return draw(gainLife(c.state, c.controller, lands), c.controller, lands);
      },
    },
  ],
};

/*
  Copying an ability on the stack, which is the last item this project's own Next list had on it.

  "Counter target ability" (D134) and "copy target ability" sound like neighbours and are not: one
  removes an object and the other builds a second one, with the first one's targets, the first one's
  `subject`, and the first one's division if it had one. All of that travels in `copyAbilityOnStack`;
  what the card adds here is the one filter the engine had no card for — an ability on the stack
  that is *triggered* and is *yours*.

  Rot Harvest is where it goes, because it is the deck built out of triggers: a Blood Artist and a
  Zulaport Cutthroat on every death, a Doomed Dissenter that leaves a Zombie, a Wall of Blossoms and
  a Gravedigger and a Fleshbag Marauder and a Lotleth Giant as they arrive. Copying any of those is
  a real second card, and the Resonator sits on the battlefield doing it every turn there is a
  trigger worth copying.

  **The printed "you may choose new targets for the copy" is offered**, which it was not when this
  card arrived: it needed a question whose answer is a target, asked while the ability resolves, and
  the engine had no such shape. It has one now (`TargetDecisionSpec`), and the case the clause
  exists to fix is the one this card used to demonstrate — a copied Gravedigger trigger left
  pointing at the card the original already returned is countered for having no legal target, and
  re-aiming it at a second creature in the graveyard is the whole point of the copy.

  Declining is always an answer, and the engine does not ask at all when there is nothing to move
  to: no targets, several, or one legal target and it is the one already chosen.
*/

/**
 * "You may choose new targets for the copy", which every copy effect ends with.
 *
 * Shared by the two cards that copy something, because it is the same question with the same
 * answer: where the thing being copied is pointed, chosen while the copy effect resolves and from
 * the board at that moment. `targets[0]` is what both cards are aimed at — the ability for the
 * Resonator, the spell for Twincast — and the engine does the rest: it works out the legal targets
 * from the copied object's own spec, declines on the player's behalf when there is nowhere else to
 * go, and never asks about an object with several targets or a divided quantity (CR 706.10c). See
 * `TargetDecisionSpec`.
 */
const NEW_TARGETS_FOR_THE_COPY: TargetDecisionSpec = {
  who: 'controller',
  prompt: 'Point the copy somewhere else?',
  retargets: (_state, object) => object.targets[0]?.id,
  optional: true,
};

const yourTriggeredAbility = (state: GameState, candidate: Target, controller: SeatIndex): boolean => {
  if (candidate.kind !== 'ability') return false;
  const object = state.stackObjects[candidate.id];
  return object?.kind === 'triggered' && object.controller === controller;
};

const STRIONIC_RESONATOR: CardScript = {
  name: 'Strionic Resonator',
  abilities: [
    {
      cost: { mana: '{1}', tap: true },
      description: '{1}, {T}: Copy target triggered ability you control.',
      targets: [{
        kind: 'ability',
        description: 'target triggered ability you control',
        filter: yourTriggeredAbility,
      }],
      decisions: [NEW_TARGETS_FOR_THE_COPY],
      effect: (c) => {
        const id = firstAbilityTarget(c);
        return id === null
          ? c.state
          : copyAbilityOnStack(c.state, id, c.controller, c.decisions[0]?.target);
      },
    },
  ],
};

/*
  Evasion the pool never had, in both of its printed shapes.

  Until now a creature got past a blocker by flying, by menace, by protection or by being
  unblockable-by-Walls. Two whole families were missing and both are everywhere in real Magic:

  - **"Can't be blocked"**, full stop, which nothing on the blocker's side can answer. Tormented
    Soul is the cleanest version printed — a {B} 1/1 that cannot block either, so the evasion is
    paid for — and in Ashen Rite it is also a body to feed three Blood Artists.
  - **Landwalk** (CR 702.14), which is the only evasion in this engine whose answer lives on the
    *defending player's* battlefield. River Boa is islandwalk and regeneration on a {1}{G} 2/1:
    unblockable against the decks with Islands, an ordinary two-drop against the rest, and the same
    creature changes from one combat to the next as lands arrive.

  Both are declared the way "can't be blocked by Walls" already was — a static scoped to the card
  itself — so `canBlock` reads them off the attacker and the table explains the refusal in the
  card's own words.
*/
const TORMENTED_SOUL: CardScript = {
  name: 'Tormented Soul',
  statics: [{ scope: 'self', effect: { cantBlock: true, cantBeBlocked: true } }],
};

/**
 * River Boa: islandwalk off its own printed line, and a regeneration that is not.
 *
 * It used to carry `statics: [{ scope: 'self', effect: { landwalk: ['Island'] } }]`, restating the
 * `Islandwalk` its own text prints. `printedLandwalk` reads that line (#324), so the static was a
 * second source for one fact — and the standing compiled-vs-written check said so the moment the
 * compiler started counting the line as read (D424): the compiled card had no static and the
 * hand-written one did.
 *
 * Deleted rather than kept, which is the Basilica Guards precedent (D419) — that card restated its
 * own printed `defender` the same way. #324 left this one in place because the reading had been
 * added the same day; it has since shipped with a test and a compiled twin, so the reason has
 * expired. The regeneration stays, because nothing reads an activated ability off printed text.
 */
const RIVER_BOA: CardScript = {
  name: 'River Boa',
  abilities: [{
    cost: { mana: '{G}' },
    description: '{G}: Regenerate River Boa.',
    effect: (c) => regenerate(c.state, c.source),
  }],
};

/*
  The cost family: two permanents that change what other spells cost, in both directions.

  This is one of the most common static effects in Magic and the engine had no way to say it. A
  cost could be *replaced* (flashback, foretell, morph) or *taxed* by the command zone, but nothing
  on the battlefield could reach a spell in somebody's hand and make it cheaper or dearer — so the
  whole "costs {1} less" family, from Goblin Electromancer to Sphere of Resistance, was unwritable.

  Both halves are one declaration (`CardScript.costModifiers`) and one function with two callers:
  `legalActions` asks it what a cast costs and whether it is affordable, and `castSpell` asks it
  what to charge. The rule that matters here is that they can never answer differently, which is the
  same rule convoke, crew and morph are built on.

  **Only generic mana moves** (CR 601.2f). A reduction never touches a coloured requirement, so an
  Electromancer leaves Counterspell at {U}{U} and makes Arc Lightning {1}{R} instead of {2}{R} —
  which is the card, and is also why its own deck is the one it is worth the most in.

  Thalia is the other direction and the more interesting card, because she taxes **everyone**,
  her own controller included. That is the printed card and it is what makes her a *cost* rather
  than an advantage: Skyward Writ runs sixteen noncreature spells of its own.
*/
const GOBLIN_ELECTROMANCER: CardScript = {
  name: 'Goblin Electromancer',
  costModifiers: [{
    whose: 'controller',
    applies: (_state, _caster, card) => {
      const line = parseTypeLine(card.typeLine);
      return hasType(line, 'instant') || hasType(line, 'sorcery');
    },
    generic: -1,
    description: 'Goblin Electromancer — instant and sorcery spells cost {1} less',
  }],
};

const THALIA_GUARDIAN_OF_THRABEN: CardScript = {
  name: 'Thalia, Guardian of Thraben',
  keywords: ['first strike'],
  costModifiers: [{
    whose: 'everyone',
    applies: (_state, _caster, card) => !hasType(parseTypeLine(card.typeLine), 'creature'),
    generic: 1,
    description: 'Thalia, Guardian of Thraben — noncreature spells cost {1} more',
  }],
};

/*
  Copying a **spell**, which is the other half of the family and the card the engine could not have.

  The Resonator copies an ability; Twincast copies a spell, and a spell is a *card*, which is the
  whole of the difference. The copy is not a card — it has a stack id of its own, no instance, and
  it ceases to exist as it resolves instead of going to a graveyard it was never in. Two things
  follow that a person would notice if they were wrong, and both are asserted rather than commented:
  the copy is **not cast**, so Guttersnipe and Young Pyromancer and Gelectrode do not see it (CR
  707.10), and the copy is **above** the original on the stack, so it resolves while the original is
  still there to be answered.

  **It went into Arc Tempest first and the measurement moved it**, which is worth reading before
  deciding where the next card like it goes. Izzet is where this card is printed and that deck is
  made of spells; against the field it cost about nine games in 240 whatever it replaced (−8 and −10
  in the Lava Spike's slot on two seed sets, −9 against a second Faithless Looting). In Tidal Mind
  it is −4 of 240, inside the floor, and that is where it ships. See `TIDAL_MIND` for the slot.

  The instrument says why, and it is not about the card. **The bot is better with it than the guess
  was** — "copying needs mana held through somebody else's turn" is the limitation four other
  measurements have found, and it does not apply, because a seat's lands are already untapped on an
  opponent's turn and the engine taps for a cost as it pays it. In Arc Tempest it drew the card in
  71 of 120 duels and cast it 23 times: seven copies of its own Lightning Bolt, and **seven copies
  of a cantrip** (five Think Twice, two Faithless Looting), which is four mana for one card in a
  deck whose clock starts on turn three. In Tidal Mind it casts it 7 times in 120 — and all seven
  copy the **opponent's** spell, with three of four new-target questions moving the copy. The same
  card, the same bot, and a use that changes in kind with the deck around it.
*/
const TWINCAST: CardScript = {
  name: 'Twincast',
  targets: [{
    kind: 'spell',
    description: 'target instant or sorcery spell',
    filter: (state, candidate) => candidate.kind === 'card'
      && isInstantOrSorcerySpell(state, candidate.id),
  }],
  decisions: [NEW_TARGETS_FOR_THE_COPY],
  onResolve: (c) => {
    // A spell on the stack is targeted as the card it is, which is why this reads `card` rather
    // than `spell`: the kinds on a `TargetSpec` and the kinds on a `Target` are different lists.
    const spell = c.targets[0];
    if (spell === undefined || spell.kind !== 'card') return c.state;
    return copySpellOnStack(c.state, spell.id, c.controller, c.decisions[0]?.target);
  },
};

/*
  The eleventh deck's own cards, and the two things the engine had never been asked for.

  Delta Bloom is green-blue and its plan is its *mana*: ramp into something enormous, and read the
  lands as they arrive. Two engine additions came with it and both are one line each at the point
  of use — an `etb` trigger that can watch a **land** (landfall; a land entering has always raised
  that event and nothing could hear it), and a per-turn **extra land drop** (CR 505.5b), which is
  the first permission in this engine that changes what a *player* may do rather than what a
  permanent is.
*/

const EXPLORE: CardScript = {
  name: 'Explore',
  // The order does not matter, which is the whole reason the allowance is a count: an Explore cast
  // before the turn's land and one cast after it both leave you able to play two.
  onResolve: (c) => draw(allowExtraLand(c.state, c.controller), c.controller, 1),
};

const TATYOVA: CardScript = {
  name: 'Tatyova, Benthic Druid',
  triggers: [
    {
      /*
        "Whenever a land you control enters" — `who: 'any'` with `of: 'you'`, which is the same
        reading the table gives "a creature you control", and the same one `keywordScriptFor`'s
        landfall prologue builds.

        It used to say `who: 'another'`, arguing that "she is not a land and her own arrival is not
        one". True of her and not of the phrase: the standing compiled-vs-written check flagged the
        difference the moment the compiler learnt to read the line (D429), and the general reading is
        the right one to keep — the corpus prints exactly one **land** with this trigger on it
        (Chocobo Camp), and for that card `another` would miss its own arrival, which the printed
        text includes. For Tatyova the two are behaviourally identical, so this is a change of
        wording rather than of what she does.
      */
      on: { kind: 'etb', who: 'any', of: 'you', what: 'land' },
      description: 'draw a card and you gain 1 life',
      effect: (c) => draw(gainLife(c.state, c.controller, 1), c.controller, 1),
    },
  ],
};

/**
 * The permanent that answers a spell by what it cost (CR 603.4, CR 202.3b).
 *
 * Two things in the engine were missing for this one card and both are small. A `spell-cast` event
 * used to say what *kind* of spell was cast — creature, noncreature, instant-or-sorcery — which is
 * everything prowess and Talrand need and nothing this needs: it has to read the spell's mana
 * value and then counter **that** spell. So the event carries the object now, and it reaches here
 * as `c.answering`, the same channel a ward uses for the spell that targeted its creature.
 *
 * The condition is the second half, and it is an **intervening-if clause** rather than a filter on
 * the event. The difference is visible at the table: a trigger with a false condition never goes
 * on the stack at all, so an opponent casting a two-mana spell into a Chalice set to one sees
 * nothing happen, instead of seeing a trigger they could respond to for a spell that was never
 * going to be countered. It is asked twice, once before the ability is put on the stack and again
 * as it resolves, so removing the counters in between makes the Chalice miss — which is the rule.
 *
 * `{X}{X}` is the cost, which is one number paid twice, and the counters are X rather than the
 * mana value: a Chalice cast for two costs four mana and stops Divinations, not Air Elementals.
 * See `ManaCost.xCount` for the parsing and `manaValueOnStack` for the comparison.
 *
 * It counters its controller's spells too. That is the card, and it is the whole reason it lives in
 * Tidal Mind rather than anywhere else: the deck has four one-mana spells, and the field it is
 * measured against has twenty-two in Ember Rush alone.
 *
 * **What it is worth in this bot's hands is nearly nothing, and the reason is the deck rather than
 * the search.** Over 120 paired games the Chalice reached hand in 25 and was cast in 21 of those,
 * every time on turn fourteen or later — which is simply when one copy of a sixty-card deck
 * arrives. By then the one-drops it was going to answer have been cast, and the per-opponent split
 * says so: nought games moved against Ember Rush, Verdant Guard or Forge Alliance, the three decks
 * it is in the deck for. The slot measures −4 of 240, inside the noise floor. A rule that cast it
 * before the search saw anything else — the land-drop shape — was tried and reverted: it moved the
 * turn it was cast by nothing at all, because the bot was never the thing making it late. In a
 * person's hands, or in a pasted list that runs four copies, it is the card it is printed as.
 */
const CHALICE_OF_THE_VOID: CardScript = {
  name: 'Chalice of the Void',
  entersWith: { counter: 'charge', amount: 'x' },
  // The one card in the pool where a bigger X is a worse card: see `xIsANumberToMatch`.
  xIsANumberToMatch: true,
  triggers: [
    {
      on: { kind: 'spell-cast', by: 'any', spell: 'any' },
      description: 'counter that spell',
      condition: (c) => {
        const spell = c.answering;
        if (spell === undefined || c.state.stackObjects[spell] === undefined) return false;
        const charges = c.state.instances[c.source]?.counters['charge'] ?? 0;
        return manaValueOnStack(c.state, spell) === charges;
      },
      effect: (c) => (c.answering === undefined ? c.state : counterSpell(c.state, c.answering)),
    },
  ],
};

/**
 * The mana sink that is also removal, and the first ability in the pool paid for with a counter.
 *
 * Three of its four lines were already expressible: `{X}{X}` for the counters it enters with (the
 * cost shape Chalice of the Void brought), `{1}: put one on` as an ordinary ability, and damage to
 * any target as the commonest effect here. The fourth is the cost — "remove a +1/+1 counter from
 * this permanent" — which is a *cost* and not an effect, and the distinction is the card.
 *
 * Because the counter comes off as the ability is activated, a Ballista on one counter that fires
 * is a 0/0 before the damage resolves: the state-based actions kill it, and the damage is dealt
 * anyway, because an ability on the stack has nothing further to do with its source (CR 608.2).
 * That is not an edge case, it is how the card is played — and it is the same shape as a
 * planeswalker's last loyalty, which this engine already got right.
 */
const WALKING_BALLISTA: CardScript = {
  name: 'Walking Ballista',
  entersWith: { counter: '+1/+1', amount: 'x' },
  abilities: [
    {
      cost: { mana: '{1}' },
      description: '{1}: Put a +1/+1 counter on Walking Ballista.',
      effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
    },
    {
      cost: { removeCounter: { counter: '+1/+1', amount: 1 } },
      description: 'Remove a +1/+1 counter: 1 damage to any target.',
      targets: [{ kind: 'any', description: 'any target' }],
      effect: (c) => {
        const target = c.targets[0];
        if (target === undefined) return c.state;
        return dealDamage(c.state, target, 1, { source: c.source });
      },
    },
  ],
};

/**
 * The creature that grows, and then leaves its counters behind as a flock.
 *
 * The same `{X}{X}` arrival as the Ballista and the same {1} to grow, with a tap in the cost — so
 * it cannot both grow and attack in a turn, which is the card's whole tension. What it adds is the
 * death trigger reading its own counters: "create that many 1/1 Thopters" has to count what was on
 * it, and a dying permanent's last state is exactly what `dies` is handed (CR 603.6d), so the
 * count is read off `c.subject` rather than off a battlefield it has already left.
 */
const HANGARBACK_WALKER: CardScript = {
  name: 'Hangarback Walker',
  entersWith: { counter: '+1/+1', amount: 'x' },
  abilities: [
    {
      cost: { mana: '{1}', tap: true },
      description: '{1}, {T}: Put a +1/+1 counter on Hangarback Walker.',
      effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
    },
  ],
  triggers: [
    {
      on: { kind: 'dies' },
      description: 'create a 1/1 Thopter with flying for each +1/+1 counter on it',
      effect: (c) => {
        // What it had on it when it died, which is the only place that answer still exists: the
        // card is in a graveyard by now and `relocate` took its counters off on the way, as the
        // rules say it must. See `EffectContext.subjectCounters`.
        const counters = c.subjectCounters?.['+1/+1'] ?? 0;
        return counters === 0 ? c.state : createToken(c.state, c.controller, THOPTER_TOKEN, counters);
      },
    },
  ],
};

/**
 * The sweeper whose size you choose, and the pool's first question answered with a number.
 *
 * "Pay X life. All creatures get -X/-X until end of turn." Everything about this card is the
 * number, and the number is chosen **as it resolves** rather than as it is cast — which is the
 * distinction that made it unscriptable until now. An X in a cost is announced on the stack, is
 * part of what gets countered, and lets an opponent decide whether to respond knowing how big it
 * is. This is chosen after all of that, from the board as it actually ended up, which is precisely
 * why a player would rather have it this way round (see `NumberDecisionSpec`).
 *
 * **The range is the card's own.** Nought up to the smaller of the life its caster can survive
 * paying and the biggest toughness on the board: -9/-9 and -4/-4 kill exactly the same creatures
 * when nothing has five toughness, so offering forty answers where four matter would be a worse
 * question rather than a more honest one. It reads the board when the question is asked.
 *
 * It hits **all** creatures, the caster's own included, which is the card and is also why the bot
 * needs an opinion rather than a maximum: the number that kills the most of somebody else's board
 * is often the number that kills its own. `best` answers the way a player does — the smallest
 * number that kills more of theirs than of mine, and nought when no number does.
 */
const TOXIC_DELUGE: CardScript = {
  name: 'Toxic Deluge',
  removesACreature: true,
  decisions: [{
    who: 'controller',
    prompt: 'Pay how much life?',
    range: (state, chooser) => ({
      min: 0,
      // One less than the life total: a cost that kills you is not a cost you may choose to pay
      // (CR 118.4), and the same rule is why a Mana Confluence stops at one life.
      max: Math.max(0, Math.min(
        (state.seats[chooser]?.life ?? 1) - 1,
        biggestToughness(state),
      )),
    }),
    best: (state, chooser) => {
      // The smallest number that is worth more to this seat than it costs, which is what a person
      // works out by looking: how many of theirs dies, how many of mine, and is the trade good.
      const cap = Math.min((state.seats[chooser]?.life ?? 1) - 1, biggestToughness(state));
      let best = 0;
      let bestGain = 0;
      for (let x = 1; x <= cap; x += 1) {
        let theirs = 0;
        let mine = 0;
        for (const id of battlefield(state)) {
          const inst = state.instances[id];
          if (inst === undefined) continue;
          const ch = characteristicsOf(state, inst);
          if (!ch.isCreature || ch.toughness > x) continue;
          if (inst.zoneSeat === chooser) mine += 1;
          else theirs += 1;
        }
        // Life is a resource and this is the one card here that spends it, so a number that trades
        // three life for one creature apiece is not an improvement on doing nothing.
        const gain = theirs - mine;
        if (gain > bestGain) {
          bestGain = gain;
          best = x;
        }
      }
      return best;
    },
  }],
  onResolve: (c) => {
    const paid = c.decisions[0]?.amount ?? 0;
    if (paid <= 0) return c.state;
    // The life first, because it is the cost of the effect rather than part of it: a Deluge for
    // four takes the life whether or not anything on the board has four toughness.
    const spent = loseLife(c.state, c.controller, paid);
    return pumpAll(spent, c.source, c.controller, { power: -paid, toughness: -paid });
  },
};

const KIORAS_FOLLOWER: CardScript = {
  name: "Kiora's Follower",
  abilities: [
    {
      cost: { tap: true },
      description: '{T}: Untap another target permanent.',
      // The whole of what it does, which is what makes it the only card in the pool that can put
      // the board back where it found it. See `AbilityDef.untapsOnly`.
      untapsOnly: true,
      targets: [{
        kind: 'permanent',
        description: 'another target permanent',
        // Marked as helping what it points at, which is the hint the bot needs: untapping an
        // opponent's land is a card thrown away, and the default aim is the enemy's board.
        friendly: true,
        filter: (state, candidate, _controller, source) =>
          candidate.kind === 'card' && candidate.id !== source,
      }],
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : tap(c.state, id, false);
      },
    },
  ],
};

const PELAKKA_WURM: CardScript = {
  name: 'Pelakka Wurm',
  keywords: ['trample'],
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'you gain 7 life',
      effect: (c) => gainLife(c.state, c.controller, 7),
    },
    {
      // The half that makes it a fine card to have killed: seven life on the way in and a card on
      // the way out, so the removal spell aimed at it was still a card for a card.
      on: { kind: 'dies' },
      description: 'draw a card',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
  ],
};

/**
 * Every token this pool can put onto the battlefield.
 *
 * Here so the deck-coverage test can tell a token script from an orphan. "A script registered
 * under a name no deck contains can never fire" is the rule that test enforces, and it was right
 * until a token had a script of its own: a Pest is never in anybody's deck and its death trigger
 * fires every game Sedgemoor Witch connects with an instant. Listing the tokens makes the test
 * sharper rather than weaker — it now also catches a token script with no token to go with it.
 */
export const TOKEN_DEFS: readonly CardDef[] = [
  GOBLIN_TOKEN, DRAKE_TOKEN, SPIRIT_TOKEN, ZOMBIE_TOKEN, KNIGHT_TOKEN, BEAST_TOKEN, ELEPHANT_TOKEN,
  SOLDIER_TOKEN, WARRIOR_TOKEN, INSECT_TOKEN, PEST_TOKEN, WALL_TOKEN, ELEMENTAL_TOKEN,
  ELF_WARRIOR_TOKEN, CAT_TOKEN, PLANT_TOKEN, THOPTER_TOKEN, SQUID_TOKEN, GOAT_TOKEN,
  // The two that are resources rather than bodies, and the first tokens here whose whole text is
  // an ability that eats them.
  TREASURE_TOKEN, CLUE_TOKEN,
];

/*
  The two combat triggers the engine never raised, and the cards that need them.

  Combat raised exactly one event: an attack was declared. Everything that happens *after* that —
  a creature blocking, an attacker getting through unblocked — was invisible to every script in the
  pool, which rules out a whole shelf of printed cards and both of the ones here.

  - **"Whenever ~ blocks a creature"** fires as blockers are declared (CR 509.1a), once per block,
    and the attacker it was against travels on the event because nothing on the board says which
    one it was by the time the ability resolves. Wall of Frost is the card that makes the event
    worth having: a 0/7 that blocks anything and then holds it down for a turn, which is a tempo
    card rather than a wall.
  - **"Whenever ~ attacks and isn't blocked"** cannot be a filter on the attack event, because
    when attackers are declared nobody has blocked yet. It is raised at the end of the
    declare-blockers step, once every defender has spoken, which is the first moment at which the
    answer is a fact. Ophidian is the printed card and it asks a real question: a card, or one
    point of damage.

  Wall of Frost also needed a mechanism the engine had never had — "doesn't untap during its
  controller's next untap step" — which is a flag on the permanent rather than a continuous effect,
  because nothing about the creature is different while it is set. See `CardInstance.frozen`.
*/
const WALL_OF_FROST: CardScript = {
  name: 'Wall of Frost',
  keywords: ['defender'],
  triggers: [
    {
      on: { kind: 'blocks' },
      description: "the blocked creature doesn't untap during its controller's next untap step",
      // `c.blocked` rather than `c.subject`: the subject of a block is the creature that blocked,
      // which here is the Wall itself. See the `blocks` event.
      effect: (c) => (c.blocked === undefined ? c.state : freezeNextUntap(c.state, c.blocked)),
    },
  ],
};

/**
 * Which Ophidian would rather have: the card, or the damage.
 *
 * A fact about the board rather than a weight, like every other answer the bot gives to a card's
 * own question (D116). Two boards say "attack": one where this unblocked point of damage is lethal,
 * and one where the library is empty and drawing would lose the game instead of winning it
 * (CR 704.5b). Everywhere else a card beats one damage, which is why the card is played.
 */
function ophidianWouldDraw(state: GameState, chooser: SeatIndex): string | undefined {
  if (listAt(state, zoneKey(chooser, 'library')).length === 0) return 'Attack';
  const lethal = state.combat.attacks.some((attack) => {
    const inst = state.instances[attack.attacker];
    if (inst === undefined || inst.zoneSeat !== chooser || attack.blockers.length > 0) return false;
    if (attack.planeswalker !== undefined) return false;
    const seat = state.seats[attack.defender];
    return seat !== undefined && seat.life <= characteristicsOf(state, inst).power;
  });
  return lethal ? 'Attack' : 'Draw';
}

const OPHIDIAN: CardScript = {
  name: 'Ophidian',
  triggers: [
    {
      on: { kind: 'attacks-unblocked' },
      description: 'you may draw a card; if you do, remove Ophidian from combat',
      /*
        "You may" as two words rather than as a flag on the trigger (D116).

        The engine has no optional-trigger mechanism and does not need one: a "may" is a choice
        between two words, the table already draws a row of buttons for one, and the decision is
        genuinely a decision — a card is worth more than one damage until the turn the one damage
        wins the game.
      */
      decisions: [{
        who: 'controller',
        prompt: 'Draw a card, and remove Ophidian from combat?',
        options: ['Draw', 'Attack'],
        best: ophidianWouldDraw,
      }],
      effect: (c) => {
        if (chosenOption(c) !== 'Draw') return c.state;
        // Removed from combat *because* a card was drawn, in that order and only then: the card
        // says "if you do", and an Ophidian that declined is still an attacking creature.
        return removeFromCombat(draw(c.state, c.controller, 1), c.source);
      },
    },
  ],
};

/*
  The family of printed text that happens **later**: a delayed trigger (CR 603.7).

  Every trigger in this engine fires the moment its event happens, and a whole shelf of cards says
  otherwise — "destroy that creature **at end of combat**", "return it to the battlefield **at the
  beginning of the next end step**". None of it was expressible, and it cannot be faked with a step
  trigger: a step trigger fires every turn for as long as its permanent is on the battlefield, and
  this fires once whether or not the permanent is still there.

  So a delayed ability is an ordinary entry in the card's own `triggers`, marked `delayed` so the
  event path never fires it, and something else schedules it. By the time it goes on the stack it is
  an ordinary triggered ability and nothing downstream knows it waited.

  **Thicket Basilisk** is the combat half and the card that makes `becomes-blocked` worth raising:
  it kills whatever blocks it *and* whatever it blocks, and the death is at end of combat rather
  than at once — so the creature it marked still deals its combat damage, and a player who saw
  "destroy" and expected a Doom Blade will be surprised in the right way.

  **Flickerwisp** is the other half, and shows why the schedule lives on the state rather than on
  the permanent: the Wisp can be killed before the end step and the exiled card still comes back,
  because the delayed ability stopped belonging to it the moment it was created (CR 603.7d).
*/

/** The index of a card's delayed ability, so no effect has to hard-code a position. */
const delayedIndexOf = (script: CardScript): number =>
  (script.triggers ?? []).findIndex((trigger) => trigger.delayed === true);

const nameOfCard = (state: GameState, id: string | undefined): string => {
  const inst = id === undefined ? undefined : state.instances[id];
  return inst === undefined ? 'it' : state.cardDefs[inst.defKey]?.name ?? 'it';
};

/**
 * Unearth (CR 702.84): the third thing this engine can pay for out of a graveyard, and the only one
 * that is not a cast.
 *
 * Escape and delve (D171) are *casts* — the card goes on the stack, an opponent may counter it, and
 * "whenever a player casts a spell" sees it. Unearth is an **activated ability** that puts the
 * creature straight onto the battlefield: nothing is cast, nothing can be countered, and the body
 * is one attack rather than a permanent, because it is exiled at the beginning of the next end
 * step. So it is an ability whose cost is "from your graveyard" (`AbilityCost.fromGraveyard`),
 * which is cycling's `discardSelf` one zone along.
 *
 * Three pieces, all of which existed: the graveyard is the third zone `activatablePlays` walks, the
 * haste is an ordinary end-of-turn grant, and the exile is a **delayed trigger** (D135) scheduled
 * for the next end step of anybody's turn. "Or if it would leave the battlefield" is the one clause
 * not here: it needs a replacement effect a permanent applies to its own departure, which D181
 * decided against adding for undying and which this card would be the first real user of. The
 * practical difference is small and worth saying rather than hiding — an unearthed creature that
 * dies this turn goes to the graveyard and can be unearthed again next turn, where the printed card
 * exiles it.
 */
const unearth = (cost: string, script: () => CardScript): AbilityDef => ({
  cost: { mana: cost, fromGraveyard: true },
  // Sorcery speed, which the keyword says in its own words: "activate only as a sorcery".
  sorcerySpeed: true,
  description: `Unearth ${cost} (${cost}: Return this card from your graveyard to the battlefield. `
    + 'It gains haste. Exile it at the beginning of the next end step.)',
  effect: (c) => {
    let next = putOntoBattlefield(c.state, c.source, c.controller);
    next = pump(next, [c.source], c.source, c.controller, { keywords: ['haste'] });
    // The marker the exile half reads: this body was unearthed, so leaving the battlefield means
    // exile rather than a graveyard it could be unearthed from again. See `UNEARTHED`.
    next = addCounters(next, c.source, UNEARTHED, 1);
    return scheduleDelayed(next, {
      source: c.source,
      controller: c.controller,
      abilityIndex: delayedIndexOf(script()),
      step: 'end',
      // `any` rather than `you`: unearth is a sorcery-speed ability, so the next end step is this
      // turn's — but a card that somehow reached the battlefield on somebody else's turn should
      // still go at the end of *that* one, which is what the printed card says.
      of: 'any',
      subject: c.source,
      description: `exile ${nameOfCard(next, c.source)}`,
    });
  },
});

/**
 * "… or if it would leave the battlefield", as a replacement on the unearthed body itself.
 *
 * The clause that stops the same creature being bought twice, and the measurement that made it
 * necessary rather than optional: without it, `cast-counts` read **18 casts and 42 unearths** of a
 * Hellspark Elemental across 22 games — the card sacrifices itself at end of turn, reached the
 * graveyard before the delayed exile could find it on the battlefield, and was bought again the
 * next turn. Twice the card the printed one is.
 *
 * It is a replacement rather than a trigger because the printed word is "instead" in effect: the
 * creature never reaches the graveyard, so nothing that watches for a death sees it either, which
 * is also the rule (CR 614.6). And it applies to **this body only**, read off the `UNEARTHED`
 * counter in the `vanished` snapshot — a Hellspark that was cast and died is in a graveyard it can
 * be unearthed from, which is the whole point of the card.
 *
 * **It covers the bounce as well as the death now, and the gap that closes was reachable.** D183
 * shipped this as `on: 'dies'` and wrote down that "would leave the battlefield" also means a
 * bounce or an exile, with the excuse that nothing in the pool bounces its own creature — which
 * missed that the *opponent's* Unsummon and Man-o'-War bounce it just as well. An unearthed
 * Dregscape Zombie Unsummoned in response went to its owner's **hand**, a two-mana 2/1 to cast
 * again or to discard and unearth again, where the printed card exiles it. The engine's widest
 * replacement wording is exactly this clause, so the fix is the field (D185).
 */
const unearthExileOnLeaving = (): NonNullable<CardScript['replaces']>[number] => ({
  on: 'leaves-battlefield',
  description: 'exile it instead, because it was unearthed',
  applies: (c) => {
    if (c.subject !== c.source) return false;
    const was = c.state.vanished[c.subject] ?? c.state.instances[c.subject];
    return (was?.counters[UNEARTHED] ?? 0) > 0;
  },
  instead: (c) => exileCard(c.state, c.subject),
});

/** The exile half of unearth, as the delayed trigger every unearth card carries. */
const unearthExile = (): TriggerDef => ({
  on: { kind: 'step', step: 'end', of: 'any' },
  delayed: true,
  description: 'exile it',
  // No guard beyond the one `exileCard` already is: a creature that has left the battlefield in the
  // meantime is not there to exile, and the ability does as much as it can (CR 608.2).
  effect: (c) => (c.subject === undefined ? c.state : exileCard(c.state, c.subject)),
});

/**
 * Dregscape Zombie: a 2/1 for two that can be bought back for one, once.
 *
 * In the deck with the sacrifice outlets, which is where unearth is an engine rather than a body:
 * a Vampire Aristocrat eats it, a Blood Artist drains for it, and {B} on a later turn buys the same
 * creature again to be eaten again. That is the same combination the Young Wolf measured +36 for
 * (D181) with the recursion on the other side of the card.
 */
const DREGSCAPE_ZOMBIE: CardScript = {
  name: 'Dregscape Zombie',
  abilities: [unearth('{B}', () => DREGSCAPE_ZOMBIE)],
  triggers: [unearthExile()],
  replaces: [unearthExileOnLeaving()],
};

/**
 * Hellspark Elemental: three trampling damage now, and three more for {1}{R} later.
 *
 * The card sacrifices itself at the beginning of the end step whether it was cast or unearthed,
 * which is printed on it and not part of the keyword — so it carries two end-step triggers: its
 * own sacrifice, and the delayed exile unearth schedules. Both are correct and the order does not
 * matter: whichever resolves first, the card is gone, and the second does nothing because
 * `moveToGraveyard` and `exileCard` both read an instance that is no longer on the battlefield.
 */
const HELLSPARK_ELEMENTAL: CardScript = {
  name: 'Hellspark Elemental',
  keywords: ['trample', 'haste'],
  // As on Ball Lightning: the end-step sacrifice below is the rule, this is the bot's warning.
  leavesAtEndOfTurn: true,
  abilities: [unearth('{1}{R}', () => HELLSPARK_ELEMENTAL)],
  triggers: [
    {
      on: { kind: 'step', step: 'end', of: 'any' },
      description: 'sacrifice Hellspark Elemental',
      // Guarded, because unearth's exile may already have taken it: see `sacrificeSelf`.
      effect: sacrificeSelf,
    },
    unearthExile(),
  ],
  replaces: [unearthExileOnLeaving()],
};

/*
  Embalm (CR 702.89) and eternalize (CR 702.100): the fourth and fifth things this engine can pay
  for out of a graveyard, and the first two that give you something which is **not the card**.

  Everything else that spends a graveyard gives the card back. Flashback and escape cast it, delve
  feeds another spell with it, unearth puts the creature itself onto the battlefield for a turn.
  These two exile the card for good and hand you a *token copy of it* instead — "except it's a white
  Zombie with no mana cost", or a black Zombie with base power and toughness 4/4.

  That exception clause is the one thing the engine did not have. `copyAsToken` already made a token
  from the copied card's own definition, which is what a copy is (CR 707.2) — but a copy with
  different characteristics needs a *different definition*, and a definition is keyed by the card's
  lowercased name, so the altered one would have overwritten the printed card. `TokenCopyProfile`
  is that: a short list of printed fields to replace, registered under the card's key plus a suffix,
  with the token's `name` left alone so `scriptFor` still finds the copied card's abilities. Which
  is the whole reason these keywords are worth printing: the Angel of Sanctions token exiles another
  permanent when it arrives, exactly as the card does.

  Both are activated from the graveyard like unearth (`fromGraveyard`), at sorcery speed, and both
  pay by exiling the card — which is `exileSelf`, and the new half of the cost that matters: paid at
  activation, so the same Sacred Cat cannot be embalmed twice by activating it again while the first
  ability is still on the stack.

  The two differ in exactly two ways — the colour and whether the body's size is replaced — so they
  are one helper each over the same call rather than one helper with a flag, because the printed
  reminder text is what a player reads off the table and the two are not the same sentence.
*/

const embalm = (cost: string, typeLine: string): AbilityDef => ({
  cost: { mana: cost, fromGraveyard: true, exileSelf: true },
  sorcerySpeed: true,
  description: `Embalm ${cost} (${cost}, Exile this card from your graveyard: Create a token `
    + 'that\u2019s a copy of it, except it\u2019s a white Zombie with no mana cost. '
    + 'Embalm only as a sorcery.)',
  effect: (c) => copyAsToken(c.state, c.controller, c.source, 1, {
    as: 'embalmed', typeLine, manaCost: '', cmc: 0, colors: ['W'],
  }),
});

const eternalize = (cost: string, typeLine: string): AbilityDef => ({
  cost: { mana: cost, fromGraveyard: true, exileSelf: true },
  sorcerySpeed: true,
  description: `Eternalize ${cost} (${cost}, Exile this card from your graveyard: Create a token `
    + 'that\u2019s a copy of it, except it\u2019s a black Zombie with base power and toughness 4/4 '
    + 'and no mana cost. Eternalize only as a sorcery.)',
  effect: (c) => copyAsToken(c.state, c.controller, c.source, 1, {
    as: 'eternalized', typeLine, manaCost: '', cmc: 0, colors: ['B'], power: '4', toughness: '4',
  }),
});

/**
 * Sacred Cat: a {W} 1/1 with lifelink, and {W} later to have it again.
 *
 * The cheapest embalm printed and the clearest statement of what the keyword is: a one-drop that
 * blocks, gains a life, dies, and then is a one-drop again. In Dawn Tithe because that deck reads
 * its own life total — a lifelinking blocker is two of its cards at once, and having it twice for
 * two mana in total is the shape its curve has never had out of a zone the list does not otherwise
 * use at all.
 */
const SACRED_CAT: CardScript = {
  name: 'Sacred Cat',
  keywords: ['lifelink'],
  abilities: [embalm('{W}', 'Token Creature \u2014 Zombie Cat')],
};

/**
 * Angel of Sanctions: the card that makes embalm worth more than a body.
 *
 * A 3/4 flier that exiles a nonland permanent until it leaves, and then — for the same five mana
 * out of the graveyard — a Zombie Angel that does it **again**. The token is a copy, so it has the
 * entry trigger and the leaves trigger both, which means killing the token still gives the first
 * permanent back. That is the printed card and it is also the thing that would have been easy to
 * get wrong: a token built as a plain 3/4 flier would have been a strictly worse card with no
 * error anywhere to find it.
 *
 * `exileUntilItLeaves` is the same helper the Banisher Priest and Banishing Light use, with
 * Banishing Light's target: another nonland permanent, which is how the Angel answers an
 * enchantment or an artifact as readily as a creature.
 */
const ANGEL_OF_SANCTIONS: CardScript = {
  ...exileUntilItLeaves('Angel of Sanctions', {
    kind: 'permanent',
    description: 'another target nonland permanent an opponent controls',
    filter: (state, candidate, controller, source) => {
      if (candidate.kind !== 'card') return false;
      if (candidate.id === source) return false;
      const inst = state.instances[candidate.id];
      if (inst === undefined || inst.zoneSeat === controller) return false;
      return !characteristicsOf(state, inst).isLand;
    },
  }),
  keywords: ['flying'],
  abilities: [embalm('{3}{W}{W}', 'Token Creature \u2014 Zombie Angel')],
};

/**
 * Adorned Pouncer: a 1/1 double striker for two, and a 4/4 double striker for six.
 *
 * Eternalize's size clause is the whole card: a 1/1 with double strike is two damage, a 4/4 with
 * double strike is eight, and the keyword is what turns the one into the other. Which also makes
 * it the card that would catch a `power`/`toughness` override that did not reach layer 7 — the
 * token is read as a 4/4 because its *definition* says 4/4, the way a printed card does, rather
 * than as a 1/1 under a continuous effect that a Humble or a copy would then undo.
 */
const ADORNED_POUNCER: CardScript = {
  name: 'Adorned Pouncer',
  keywords: ['double strike'],
  abilities: [eternalize('{4}{W}{W}', 'Token Creature \u2014 Zombie Cat')],
};

/**
 * Sunscourge Champion: two life now, two life again later, and a 4/4 the second time.
 *
 * The card that makes eternalize an *input* rather than a finisher. Dawn Tithe's whole plan is that
 * gaining life is a thing other cards read — a counter on Ajani's Pridemate, a counter on the
 * Bloodthirsty Aerialist — so a body whose arrival gains two life is worth having twice, and the
 * second time it arrives as a 4/4.
 *
 * It is also the simplest possible check that the token really is a copy: the token has the entry
 * trigger because `scriptFor` finds this script by **name**, and the name is the one field
 * `TokenCopyProfile` leaves alone.
 */
const SUNSCOURGE_CHAMPION: CardScript = {
  name: 'Sunscourge Champion',
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'you gain 2 life',
      effect: (c) => gainLife(c.state, c.controller, 2),
    },
  ],
  abilities: [eternalize('{5}{W}{W}', 'Token Creature \u2014 Zombie Human Cleric')],
};

/*
  Miracle (CR 702.94), and the two cards that carry it.

  The first cost in this engine conditioned on **when in the turn** a card arrived: "you may cast
  this for its miracle cost when you draw it, if it's the first card you drew this turn". So it is
  not an alternative cost on a card in your hand like evoke or spectacle, and not a cast out of
  another zone like flashback — it is an **offer**, made by the engine at the moment of the draw,
  with the card still in the hand it has just arrived in.

  Which is why the field is a cost and nothing else: `settle` raises the offer as it drains the
  draws (the only place the engine knows a card was *drawn* rather than put into a hand), the card
  stays put if you decline, and the same `pendingOfferedCast` machinery cascade and madness already
  use carries the question to the table. See `CardScript.miracle` and `GameState.drew`.

  Both cards are deliberately spells whose printed cost the deck will almost never pay. That is
  what the keyword is for: a Thunderous Wrath is six mana for five damage, which is a bad card, and
  {R} for five damage, which is one of the best burn spells ever printed — and the only difference
  is whether you drew it off the top this turn or had it in your opening hand.
*/

/**
 * Thunderous Wrath: five damage for {R}, or six mana for five damage.
 *
 * The clearest statement of the keyword in print. In Arc Tempest, which is the deck whose plan is
 * spells and whose curve stops at four — so the printed cost is a card it would never cast, and
 * the miracle is a Lightning Bolt and two thirds.
 */
const THUNDEROUS_WRATH: CardScript = {
  name: 'Thunderous Wrath',
  miracle: { cost: '{R}' },
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 5),
};

/**
 * Terminus: every creature on the bottom of its owner's library, for {W}.
 *
 * The other half of what miracle is: a sweeper that answers a board no removal spell can, and the
 * reason it is printed at five mana is that for {W} it would be unfair. It is also the cleanest
 * sweeper this pool has — nothing dies, so nothing that watches a death sees anything, and nothing
 * can be bought back out of a graveyard afterwards because the creatures are not in one.
 *
 * `bottomPile` is the whole effect and it already does the right thing: each card goes to the
 * bottom of **its owner's** library, which is what the card says, and in a random order, which the
 * card leaves unspecified. It is the same function cascade uses for its leftovers.
 *
 * Its own creatures too. Skyward Writ holds the ground with Walls and wins in the air, so a
 * Terminus is a card it casts when it is losing on board rather than one it builds around — which
 * is the decision the card is for.
 */
const TERMINUS: CardScript = {
  name: 'Terminus',
  miracle: { cost: '{W}' },
  onResolve: (c) => bottomPile(c.state, battlefield(c.state, (id) => {
    const inst = c.state.instances[id];
    return inst !== undefined && characteristicsOf(c.state, inst).isCreature;
  })),
};

/**
 * The delayed trigger every rebound card carries (CR 702.88a).
 *
 * `dashReturn()` one step of the turn earlier, and for the same reason: the ability is a delayed
 * trigger, so it wants a place on the stack, a description and a resolution path — and a card's
 * `triggers` list is where this engine keeps those. The engine schedules it as the spell resolves
 * (see `completeResolution`) and finds it by index; a card declaring `rebound` carries exactly one,
 * which a test holds.
 *
 * The zone check is not a formality. A rebound card can be gone by the time its upkeep arrives —
 * a Tormod's Crypt, a Rest in Peace, another card exiling the exile — and a delayed trigger fires
 * from wherever its source has got to (CR 603.7d). If the card is not in exile any more there is
 * nothing to offer, and the trigger resolving into nothing is the right answer rather than a bug.
 */
const reboundCast = (): TriggerDef => ({
  on: { kind: 'step', step: 'upkeep', of: 'you' },
  delayed: true,
  description: 'cast it from exile without paying its mana cost',
  effect: (c) => {
    const id = c.subject;
    if (id === undefined || c.state.instances[id]?.zone !== 'exile') return c.state;
    return reboundOffer(c.state, id);
  },
});

/**
 * Staggershock: two damage now and two more next turn, for two mana.
 *
 * The pool's first **rebound** card, and the one the keyword reads best on. Two damage for {1}{R}
 * is a fair card; four damage over two turns for {1}{R} is a much better one, and the price is
 * exactly the thing a burn deck is short of — patience. The second half cannot be countered by
 * answering the first, cannot be stopped by killing anything, and cannot be hurried.
 *
 * In Arc Tempest it is also two *spells*, which is the half the deck is built to notice: a
 * Guttersnipe, a Thermo-Alchemist and three Monastery Swiftspears all read "whenever you cast", and
 * a card that casts itself twice triggers them on two different turns. That is the reason it goes
 * here rather than in Ember Rush, where it would be four damage and nothing else.
 */
const STAGGERSHOCK: CardScript = {
  name: 'Staggershock',
  rebound: true,
  targets: [ANY_TARGET],
  triggers: [reboundCast()],
  onResolve: (c) => damageFirstTarget(c, 2),
};

/**
 * Distortion Strike: one damage more, unblockable, twice.
 *
 * Rebound's other half, on the keyword's quieter card. +1/+0 and "can't be blocked this turn" is
 * barely a card on its own; the same spell on two consecutive turns, for one mana, is a way to make
 * a creature that is *about* connecting connect twice — which in Tidal Mind means a **Thieving
 * Magpie** drawing two cards it would not have drawn, and a **Bloodthirsty Aerialist** growing
 * twice. The deck's problem has always been closing, and this is a closer that costs one mana and
 * stays cast.
 *
 * It is also the first sorcery in the pool that gets cast in an **upkeep**, which is worth saying
 * out loud: rebound's offer ignores the timing restriction on the card, because the ability that
 * makes the offer is what permits the cast (CR 702.88a). The engine gets this right for free —
 * every offered cast goes through the same path, and cascade has been casting sorceries on other
 * players' turns since D168.
 */
const DISTORTION_STRIKE: CardScript = {
  name: 'Distortion Strike',
  rebound: true,
  // Wears off at end of turn, so the bot holds it for a combat. See `expiresAtEndOfTurn`.
  expiresAtEndOfTurn: true,
  targets: [TARGET_ATTACKER_HELPED],
  triggers: [reboundCast()],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null
      ? c.state
      : pump(c.state, [id], c.source, c.controller, { power: 1, cantBeBlocked: true });
  },
};

/**
 * The self spell-cast trigger every replicate card carries (CR 702.56).
 *
 * `storm()` with the count read from a different place: storm asks the turn how many spells came
 * before this one, replicate asks the *casting* how many times its cost was paid. Both make their
 * copies with `copySpellOnStack`, and both keep the original's targets — the printed card offers
 * new targets for the copies and this engine does not, which is the narrower reading and the one
 * that cannot be wrong in the player's favour (CR 707.10).
 */
function replicate(): TriggerDef {
  return {
    on: { kind: 'spell-cast', self: true },
    description: 'Replicate — copy this spell for each time its replicate cost was paid',
    effect: (c) => {
      const id = c.answering;
      if (id === undefined) return c.state;
      const copies = c.state.stackObjects[id]?.replicated ?? 0;
      let next = c.state;
      for (let i = 0; i < copies; i += 1) next = copySpellOnStack(next, id, c.controller);
      return next;
    },
  };
}

/**
 * Pyromatics: one damage, divided, for as many mana as you have.
 *
 * The pool's first **replicate** card, and the keyword's best argument: {1}{R} for one damage is
 * the worst burn spell ever printed, and {1}{R} plus two more copies is three damage spread
 * wherever you like for six mana at instant speed. What the keyword really sells is *lateness* — a
 * card that is unplayable on turn two and a sweeper for small creatures on turn eight, out of one
 * slot in the deck.
 *
 * In Arc Tempest for the reason Grapeshot is: that deck casts cheap spells and counts them, so a
 * replicated Pyromatics is three cast triggers for its Guttersnipes and Thermo-Alchemists as well
 * as three damage. The two cards are the same shape from opposite ends — storm pays for copies with
 * the turn's history, replicate pays for them with mana.
 *
 * The division is the half worth noticing in this engine: each copy keeps the original's
 * **division** as well as its targets, which `copySpellOnStack` already carried for Twincast
 * (D131). So a Pyromatics aimed one damage each at two creatures, replicated twice, is two damage
 * each — and a player who wanted three on one thing had to say so when they cast it.
 */
const PYROMATICS: CardScript = {
  name: 'Pyromatics',
  replicate: { cost: '{1}{R}' },
  targets: [{ kind: 'any', description: 'any target', count: 2, optional: true, divided: 1 }],
  triggers: [replicate()],
  onResolve: (c) => dividedAmong(c).reduce(
    (state, { target, amount }) => dealDamage(state, target, amount, {
      controller: c.controller, source: c.source,
    }),
    c.state,
  ),
};

/**
 * Train of Thought: a card, or as many cards as the turn can pay for.
 *
 * Replicate's other half, on the keyword's quieter card and in the deck that needs the quiet half.
 * {2}{U} to draw one card is a bad rate; {2}{U} four times over to draw four is the same rate and a
 * **refill**, which is the thing a control deck runs out of. Hollow Tide holds the pool's only
 * Treasure Cruise and its Gurmag Angler, so it is already the deck whose late turns have mana and
 * nothing to spend it on.
 */
const TRAIN_OF_THOUGHT: CardScript = {
  name: 'Train of Thought',
  replicate: { cost: '{2}{U}' },
  triggers: [replicate()],
  onResolve: (c) => drawLater(c.state, c.controller, 1),
};

/**
 * Extort: pay {W/B} when you cast a spell, and everybody else loses a life (CR 702.100).
 *
 * The first **optional mana cost paid while an ability resolves** in this engine, which is what the
 * keyword needed and what nothing else had. A kicker and a replicate cost are paid as a spell is
 * cast; a ward is paid by an opponent to a question the engine raises. This is the card asking its
 * own controller for mana in the middle of its own resolution, and the card cannot do it itself —
 * paying means tapping lands, and the only thing that taps lands is the engine. So the question
 * carries a price: see `ChoiceDecisionSpec.payIfChosen`.
 *
 * `Decline` is first in the list because the first option is what a bot falls back on and what the
 * engine answers with when there is no real question to ask — and "do not spend mana" is the safe
 * one of the two. The option with the price on it is only offered at all when the mana is up, so a
 * player with three tapped lands is not asked a question they cannot answer.
 *
 * What `best` does **not** do is hold the mana back for a second spell. Extort fires after the
 * first spell is already cast and paid for, so the mana it is spending is mana the turn did not
 * use — and "keep one land untapped in case I draw something" is the two-step plan this bot has
 * never been able to price (D108, D110). Pay, and the measurement says whether that is right.
 */
function extort(): TriggerDef {
  return {
    on: { kind: 'spell-cast', by: 'you' },
    description: 'Extort — you may pay {W/B}: each opponent loses 1 life and you gain that much',
    decisions: [{
      who: 'controller',
      prompt: 'Extort: pay {W/B} so each opponent loses 1 life and you gain that much?',
      options: ['Decline', 'Pay {W/B}'],
      payIfChosen: { option: 'Pay {W/B}', cost: '{W/B}' },
      best: () => 'Pay {W/B}',
    }],
    effect: (c) => {
      if (chosenOption(c) !== 'Pay {W/B}') return c.state;
      const foes = opponentsOf(c.state, c.controller);
      let next = c.state;
      for (const foe of foes) next = loseLife(next, foe, 1);
      // "You gain that much": one life per opponent who lost one, which is the difference between
      // a duel and a pod and the reason this counts rather than adding one.
      return foes.length === 0 ? next : gainLife(next, c.controller, foes.length);
    },
  };
}

/**
 * Basilica Screecher: a 1/2 flier that charges a toll on every spell you cast.
 *
 * The pool's first extort card, and in Hollow Tide because that deck's problem has always been
 * *closing*: it answers everything, mills and blocks, and then needs the game to end. Extort is a
 * clock that costs no cards at all — one life a spell, for a mana it was not spending — and a
 * control deck that casts two spells a turn for ten turns is twenty life.
 *
 * The body is almost incidental and that is the point of the slot: a 1/2 flier blocks the Healer's
 * Hawks and Faerie Miscreants this pool is full of, and the card is bought for its text.
 */
const BASILICA_SCREECHER: CardScript = {
  name: 'Basilica Screecher',
  keywords: ['flying'],
  triggers: [extort()],
};

/**
 * Basilica Guards: a wall that drains, in the deck that was already trying to survive.
 *
 * Extort's other card, and the one that makes the keyword legible as a *defensive* clock: a 0/4 for
 * two mana stops nearly every one- and two-drop in this pool dead, and every spell cast behind it
 * is a life. Skyward Writ holds the Fog Banks, the Wall of Air and the Healers; what it has never
 * had is a reason for the game going long to be *good* for it.
 */
/**
 * Basilica Guards: a 0/4 wall with extort, and one line fewer than it had.
 *
 * It carried `statics: [{ scope: 'self', effect: { cantAttack: true } }]` — a hand-written spelling
 * of defender — until D419. `defender` is a printed keyword, `KEYWORDS` has it, and
 * `characteristicsOf` sets `cantAttack` from it unconditionally (the line is
 * `if (hasType(typeLine, 'creature') && keywords.has('defender')) cantAttack = true`). So the static
 * restated what the card's own text already says, and the compiled reading of this card — which
 * has no static — refuses the attack just as firmly.
 *
 * Found by `compiled-vs-written.test.ts`, deleted rather than mirrored into the compiler, and
 * asserted either way: the test that goes with this change declares an attack with the Guards and
 * checks it is refused.
 */
const BASILICA_GUARDS: CardScript = {
  name: 'Basilica Guards',
  triggers: [extort()],
};

/**
 * Rift Bolt: three damage for one mana, a turn late.
 *
 * The pool's first **suspend** card, and the cleanest possible demonstration of what the keyword
 * sells: {2}{R} for three damage is a fair card, and {R} on turn one for three damage on turn two
 * is the same card bought with a turn instead of two mana. Which is also the whole risk — the
 * opponent gets a turn knowing it is coming, and in a pod they get three.
 *
 * It replaces Kindle Grove's Lightning Strike, which is the fair comparison: three damage for
 * {1}{R} now against three damage for {R} and a wait.
 */
const RIFT_BOLT: CardScript = {
  name: 'Rift Bolt',
  suspend: { cost: '{R}', counters: 1 },
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 3),
};

/**
 * Proliferate's question, which is the same two lines on every card that has the keyword.
 *
 * "Any number", so nought to everything — declining is a real answer and the commonest one early,
 * when nothing on the table is carrying a counter yet. The candidate list is computed by the
 * engine rather than filtered here, because what qualifies is a rule rather than a card's
 * preference: everything already carrying a counter, on either side, plus the players.
 */
const PROLIFERATE: CountersDecisionSpec = {
  who: 'controller',
  counters: true,
  prompt: 'Proliferate — choose any number of permanents and players with counters',
};

/**
 * Contagion Clasp: the pool's first **proliferate** card, and the one that does it every turn.
 *
 * Two mana for a -1/-1 counter is a fair trade on its own; four mana and a tap to proliferate every
 * turn afterwards is the engine. In Blight Vector that compounds two ways at once — the -1/-1 it
 * puts on a blocker grows, and so does every poison counter the deck has already dealt.
 *
 * The artifact rather than the sorcery because what this piece is about is the *question*, and a
 * repeatable question is asked twenty times in a game instead of once.
 */
const CONTAGION_CLASP: CardScript = {
  name: 'Contagion Clasp',
  triggers: [{
    on: { kind: 'etb' },
    description: 'Put a -1/-1 counter on target creature',
    targets: [TARGET_CREATURE],
    effect: (c) => {
      const id = firstCardTarget(c);
      return id === null ? c.state : addCounters(c.state, id, '-1/-1', 1);
    },
  }],
  abilities: [{
    cost: { mana: '{4}', tap: true },
    description: '{4}, {T}: Proliferate.',
    decisions: [PROLIFERATE],
    effect: (c) => proliferate(c.state, chosenCards(c)),
  }],
};

/**
 * Steady Progress: proliferate at instant speed, and a card to go with it.
 *
 * The other half of what the keyword is for. The Clasp asks the question every turn and costs four
 * mana a time; this asks it once for three and replaces itself, which is what a deck plays when it
 * wants the counters to grow *now* — on an opponent's end step, after the blocks are in.
 */
const STEADY_PROGRESS: CardScript = {
  name: 'Steady Progress',
  decisions: [PROLIFERATE],
  onResolve: (c) => drawLater(proliferate(c.state, chosenCards(c)), c.controller, 1),
};

/**
 * Echo: the question the game asks, in the one upkeep it is asked (CR 702.29).
 *
 * The same two lines on every card with the keyword, and the first question in this engine whose
 * **no** destroys the permanent that asked it. Everything else that can be declined leaves the
 * table where it was: a ward unpaid counters a spell that was already on the stack, an extort
 * declined spends nothing, an offered cast declined leaves the card where it was. Decline this and
 * the creature you spent three mana on last turn goes to your graveyard.
 *
 * Three pieces, all of them already in the engine:
 *
 *  - **When.** `{ kind: 'step', step: 'upkeep' }` defaults to `of: 'you'`, so it is asked in the
 *    controller's own upkeep and nobody else's — which is the whole of echo's timing except for
 *    "the first one", below.
 *  - **Once.** `condition` reads `echoDue`, the flag set wherever the permanent came under its
 *    controller's control. A condition is asked twice, before the trigger goes on the stack and
 *    again as it resolves (CR 603.4), and must not change anything — so the flag is cleared by the
 *    `effect`, which is the half that runs.
 *  - **The price.** `payIfChosen` is extort's shape: a question with a cost on one of its answers,
 *    paid by the engine before the effect runs. It carries the rule nobody has to write — a cost
 *    the seat cannot afford is **not offered**, so a player tapped out in their own upkeep is not
 *    shown a question with one button; the permanent goes, and the engine says so.
 *
 * `Sacrifice it` is first because the first option is what the engine falls back on when there is
 * no real question to ask, and that fallback has to be the outcome the rules impose. `best` is the
 * bot's rule and it is deliberately plain: pay. A creature already on the battlefield is worth more
 * than the mana in an upkeep nobody else is using — see D214 for the measurement.
 */
function echoTrigger(cost: string): TriggerDef {
  const pay = `Pay ${cost}`;
  return {
    on: { kind: 'step', step: 'upkeep' },
    description: `Echo ${cost} — pay it or sacrifice this permanent`,
    condition: (c) => c.state.instances[c.source]?.echoDue === true,
    decisions: [{
      who: 'controller',
      prompt: `Echo ${cost}: pay it, or sacrifice this permanent?`,
      options: ['Sacrifice it', pay],
      payIfChosen: { option: pay, cost },
      best: () => pay,
    }],
    effect: (c) => {
      // Cleared whichever way the question went: echo is asked once, and a permanent that paid is
      // not asked again next turn (CR 702.29b).
      const settled = echoSettled(c.state, c.source);
      return chosenOption(c) === pay ? settled : moveToGraveyard(settled, [c.source]);
    },
  };
}

/**
 * Modular N: the counters it entered with move on when it dies (CR 702.43b).
 *
 * The first ability here that **moves** counters off a dying permanent rather than counting them,
 * and the number has to come from `c.subjectCounters` because a card leaving the battlefield loses
 * its counters on the way out — by the time this resolves, the creature is in a graveyard with
 * nothing on it. That field was built two keywords ago for the other shape of the same problem, and
 * it needed nothing added for this one.
 *
 * `count` is the printed number and is **not** what moves. What moves is what the creature actually
 * had: an Arcbound Worker that ate a +1/+1 from somewhere else passes two on, and one whose counter
 * was cancelled by a −1/−1 passes nothing — which is why the trigger reads the board rather than
 * the card.
 *
 * Targeted, as printed, so it is a real trigger that can fizzle: kill the only other artifact
 * creature in response and the counters go nowhere. And "another" is the printed word, which the
 * filter honours — a dying Ravager cannot give its counters back to itself.
 */
function modularTrigger(count: number): TriggerDef {
  return {
    on: { kind: 'dies', who: 'self' },
    description: `Modular ${count} — move its +1/+1 counters to another artifact creature`,
    /*
      Not asked when there is nothing to move, which is a kindness rather than a rule: the printed
      trigger fires either way and then moves zero counters, but a table that stops to ask which
      creature should receive **nothing** is a table asking a question whose every answer is
      identical. The same principle echo's unaffordable cost gets — a question with one outcome is
      not a question — and the case is real: a modular creature that reached the battlefield without
      entering has no counters at all and dies to the state-based actions immediately.
    */
    condition: (c) => (c.subjectCounters?.['+1/+1'] ?? 0) > 0,
    targets: [{
      kind: 'permanent',
      description: 'another target artifact creature',
      /*
        "You **may** put its counters" — so up to one target, and the printed optionality matters
        more here than it looks. The legal targets are *any* artifact creature, the opponent's
        included, which is what the card says; forced, a dying Worker whose only companion is an
        enemy Juggernaut would have to grow it. `optional: true` is the engine's "up to", and the
        effect already does nothing with no target.
      */
      optional: true,
      /*
        And the bot is told this is a **help**, because its default is "the enemy and the enemy's
        creatures" — sensible for the removal that is most of what targets anything, and exactly
        backwards for counters it is giving away. See `TargetSpec.friendly`.
      */
      friendly: true,
      filter: (state, candidate, _controller, source) => {
        if (candidate.kind !== 'card' || candidate.id === source) return false;
        const inst = state.instances[candidate.id];
        if (inst === undefined || inst.zone !== 'battlefield') return false;
        const ch = characteristicsOf(state, inst);
        return ch.isCreature && hasType(ch.typeLine, 'artifact');
      },
    }],
    effect: (c) => {
      const moving = c.subjectCounters?.['+1/+1'] ?? 0;
      const onto = firstCardTarget(c);
      return onto === null || moving <= 0 ? c.state : addCounters(c.state, onto, '+1/+1', moving);
    },
  };
}

/**
 * Arcbound Worker: a one-mana 0/0 that is alive only because of its own counter.
 *
 * The pool's first printed **0/0** and its first **modular** card, and the two facts are the same
 * fact: without the counter it would die the moment it arrived. Which makes it the cheapest possible
 * demonstration of the keyword — a 1/1 for one that hands its counter to something bigger when it
 * goes, so trading it off is never quite a trade.
 *
 * In Forge Alliance, the artifact deck, where "another artifact creature" is a sentence with
 * somewhere to point.
 */
const ARCBOUND_WORKER: CardScript = {
  name: 'Arcbound Worker',
  modular: { count: 1 },
  entersWith: { counter: '+1/+1', amount: 1 },
  triggers: [modularTrigger(1)],
};

/**
 * Arcbound Ravager: the card the artifact deck has been missing an outlet for.
 *
 * Modular 1 on a two-mana 0/0, and an ability that eats **an artifact** to grow — the pool's first
 * cost that spends an artifact, after twenty-odd of them with nothing able to pay with one. See
 * `AbilityCost.sacrifice`.
 *
 * What it is in this deck is a mana sink that turns spent Equipment into power, and a threat that
 * does not stay dead: eat two Bonesplitters, attack as a 3/3, and when it finally dies the three
 * counters land on an Etched Champion that nothing in the pool can target.
 */
/**
 * Ichor Wellspring: the pool's first artifact whose whole text is about **leaving**.
 *
 * D222 is the reason it exists. The Ravager's artifact cost had nothing in the pool worth paying it
 * with — audited card by card, every non-creature artifact here is Equipment, a Vehicle, a mana
 * source, a standing answer or an anthem — so a bot taught to feed the cost ate two Loxodon
 * Warhammers and measured 6 to 7 games of 288 against its own deck. The missing card was not a
 * better rule; it was a card that wants to go.
 *
 * Two triggers, one sentence, and the printed card really is one sentence: "enters **or** is put into
 * a graveyard from the battlefield". The engine has no "or" for two different events, and does not
 * need one — two triggers with the same body is what that templating means, and reading them as two
 * is how the rules read them too (CR 603.2 raises each separately). They are deliberately in printed
 * order, so a log reads the way the card does.
 *
 * `drawLater` rather than `draw` for both, because the draw is the last thing the card does and that
 * is the rule `drawLater`'s own docblock lays down — which also means a **dredge** can replace
 * either of them. Not the first artifact that can be dredged off, since a Mind Stone sacrificed for
 * its card already could, but the first whose draw happens without anybody choosing to: the
 * Wellspring's two are events rather than activations, so a Rot Harvest player gets the offer for
 * free twice.
 */
const ICHOR_WELLSPRING: CardScript = {
  name: 'Ichor Wellspring',
  triggers: [
    {
      on: { kind: 'etb', who: 'self' },
      description: 'draw a card',
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
    {
      on: { kind: 'to-graveyard', who: 'self' },
      description: 'draw a card',
      /*
        **No guard**, which is a correction (D409). This read
        `instances[c.source]?.zone === 'graveyard' ? draw : nothing`, copied from Rancor — and the
        two cards are not the same shape. Rancor **returns itself** from the graveyard, so a card
        that was moved on before the trigger resolved is a card there is nothing to return; the
        guard is the rule there.

        "Draw a card" asks nothing about the source. A triggered ability on the stack exists
        independently of the permanent that made it (CR 603.2, CR 608.2), so an Ichor Wellspring
        exiled from the graveyard before this resolved still draws — and the guarded version
        silently did less than the card says, which is the one failure shape this engine cannot
        afford.
      */
      effect: (c) => drawLater(c.state, c.controller, 1),
    },
  ],
};

const ARCBOUND_RAVAGER: CardScript = {
  name: 'Arcbound Ravager',
  modular: { count: 1 },
  entersWith: { counter: '+1/+1', amount: 1 },
  abilities: [{
    cost: { sacrifice: 'artifact' },
    description: 'Sacrifice an artifact: Put a +1/+1 counter on Arcbound Ravager',
    effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
  }],
  triggers: [modularTrigger(1)],
};

/**
 * Ninja of the Deep Hours: a creature that arrives **already attacking** (CR 702.49).
 *
 * The pool's first **ninjutsu** card, and two things the engine had never done. A cost paid with a
 * permanent that is **not** destroyed — the unblocked attacker goes back to its owner's hand, which
 * is a very different trade from a sacrifice, because the creature that got through is the one you
 * keep. And a creature put onto the battlefield in the middle of a combat, tapped and attacking the
 * player the returned attacker was aimed at.
 *
 * What the ability buys in play is the swap: a 1/1 that got through becomes a 2/2 that draws a card,
 * on the same attack, after the defender has already decided not to block. It is the only play in
 * this pool that happens *after* blockers and still changes what damage lands.
 *
 * The effect reads `c.enteringAttack` rather than the combat, because the attacker whose place it is
 * taking is in a hand by the time this resolves. See `StackObject.enteringAttack`.
 */
const NINJA_OF_THE_DEEP_HOURS: CardScript = {
  name: 'Ninja of the Deep Hours',
  ninjutsu: { cost: '{1}{U}' },
  abilities: [ninjutsuAbility('{1}{U}')],
  triggers: [{
    on: { kind: 'combat-damage' },
    description: 'Whenever Ninja of the Deep Hours deals combat damage to a player, draw a card.',
    effect: (c) => draw(c.state, c.controller, 1),
  }],
};

/**
 * Sudden Shock: two damage nobody gets to answer (CR 702.19).
 *
 * The pool's first **split second** card, and a mana dearer than the Shock it sits beside for
 * exactly one thing: while it is on the stack nothing can be cast. In a pool whose every answer to
 * a spell is a cast counterspell, that is the difference between killing a creature and having the
 * removal countered — and it is a difference the player has to decide is worth a mana.
 *
 * Worth being clear about what it does not buy. The spell is not uncounterable: a Chalice of the
 * Void set to one counters it on cast and could not care less about the keyword, and so would
 * anything already on the stack. See `CardScript.splitSecond`.
 */
const SUDDEN_SHOCK: CardScript = {
  name: 'Sudden Shock',
  splitSecond: true,
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 2),
};

/**
 * Krosan Grip: the artifact answer that cannot be played around.
 *
 * The same script as Naturalize and Disenchant — one factory, three cards — with the keyword and a
 * mana on top. What the extra mana buys is the half of the board this pool answers least well: an
 * Equipment that is about to be moved, a Chalice that is about to be grown, a Journey to Nowhere
 * somebody is about to sacrifice in response. Against each of those, a Naturalize is a card the
 * opponent gets to answer and this is not.
 */
const KROSAN_GRIP: CardScript = {
  ...destroyAnArtifactOrEnchantment('Krosan Grip'),
  splitSecond: true,
};

/**
 * Vanishing N: a counter off each of your upkeeps, and gone when the last one goes (CR 702.63b).
 *
 * Two printed abilities folded into one trigger: "remove a time counter from it" and "when the last
 * time counter is removed from this permanent, sacrifice it". Separate on the card, and separate on
 * the stack in a tournament — but nothing in this pool can respond between the two, because the
 * window to do it is the window inside a single resolution, which no player ever has. One trigger
 * says the same thing and keeps the sacrifice where a reader can see what caused it.
 *
 * The `condition` is the printed intervening-if, and it is not decoration: it is what a vanishing
 * permanent **with no time counters** relies on. Entering the battlefield any way at all gives it
 * its four, a token copy included — "enters with four time counters" is one of its own abilities, so
 * a copy brings it along. What does not is a permanent that reached the battlefield without
 * entering, which at this table is a card put there by hand in tabletop mode, or one that *became* a
 * copy of a vanishing creature while already on the battlefield. Either has the ability and no
 * clock, and without the condition the next upkeep would sacrifice it for a counter it never had.
 *
 * `moveToGraveyard` rather than `destroy`, because a sacrifice is not a destruction: indestructible
 * does not save it and regeneration does not either.
 */
function vanishingTrigger(count: number): TriggerDef {
  return {
    on: { kind: 'step', step: 'upkeep' },
    description: `Vanishing ${count} — a time counter comes off, and the last one takes it with it`,
    condition: (c) => (c.state.instances[c.source]?.counters[TIME] ?? 0) > 0,
    effect: (c) => {
      const next = addCounters(c.state, c.source, TIME, -1);
      if ((next.instances[c.source]?.counters[TIME] ?? 0) > 0) return next;
      // The sacrifice wipes the counters on the way to the graveyard, so without this the log — and
      // every instrument reading it — cannot tell this from a removal spell. See `GameState.expired`.
      return moveToGraveyard(recordExpiry(next, c.source, TIME), [c.source]);
    },
  };
}

/**
 * Fading N: the same counter off the same upkeep, sacrificed when there is **none to remove**
 * (CR 702.32b).
 *
 * The whole difference from vanishing is the order of those two clauses, and it is worth a turn. A
 * fading 3 creature removes its third counter on your third upkeep and is still on the battlefield
 * with none; it goes on the **fourth**, when the removal is the thing that cannot happen. So fading
 * N and vanishing N+1 hand a player the same number of turns, which is why the keyword was reprinted
 * under the other name — see `CardScript.fading`.
 *
 * No `condition`, and that asymmetry *is* the keyword: vanishing asks whether there is a counter and
 * does nothing when there is not, fading asks the same question and sacrifices. So the two cards
 * part company exactly where a permanent has none — a Blastoderm put on the battlefield by hand goes
 * on the next upkeep, and a Calciderm put there the same way stays forever.
 */
function fadingTrigger(count: number): TriggerDef {
  return {
    on: { kind: 'step', step: 'upkeep' },
    description: `Fading ${count} — a fade counter comes off, or this is sacrificed`,
    effect: (c) => ((c.state.instances[c.source]?.counters[FADE] ?? 0) > 0
      ? addCounters(c.state, c.source, FADE, -1)
      // Fading's expiry is the upkeep where there is *nothing to remove*, so the counters are
      // already gone by the time this fires — which is exactly why it has to be said rather than
      // inferred from them. See `GameState.expired`.
      : moveToGraveyard(recordExpiry(c.state, c.source, FADE), [c.source])),
  };
}

/**
 * Calciderm: a 5/5 for four that nothing can answer and nobody keeps.
 *
 * The pool's first **vanishing** card (CR 702.63), and the trade the keyword exists to sell: five
 * power for four mana with shroud on top, in exchange for a clock the opponent can read off the
 * card. Every removal spell in this pool is a targeted one, so shroud means the only way through it
 * is a blocker or a sweeper — and the three turns it gets are the three turns the opponent has to
 * find one.
 *
 * In Dawn Tithe, the deck that already wants to attack with white creatures and has never had a
 * body this size.
 */
const CALCIDERM: CardScript = {
  name: 'Calciderm',
  vanishing: { count: 4 },
  entersWith: { counter: TIME, amount: 4 },
  triggers: [vanishingTrigger(4)],
};

/**
 * Blastoderm: the same creature in green, a mana cheaper, with the number printed one lower.
 *
 * Fading 3 against Calciderm's vanishing 4, and the pair is the point: both give their controller
 * **three** turns of a 5/5 with shroud, and only one of them says so on the card. That is the whole
 * argument for the second keyword, and it is a test rather than a comment — see `fadingTrigger`.
 *
 * In Kindle Grove, which ramps, so the body lands a turn earlier than the white one does.
 */
const BLASTODERM: CardScript = {
  name: 'Blastoderm',
  fading: { count: 3 },
  entersWith: { counter: FADE, amount: 3 },
  triggers: [fadingTrigger(3)],
};

/**
 * Level up: the one ability every leveler has (CR 702.87b).
 *
 * Sorcery speed, repeatable, uncapped — a mana sink that turns spare turns into a bigger creature.
 * What the creature *becomes* is not here: the bands are printed data on the definition and are read
 * by the layer system, because a level band is what the card **is** rather than something done to
 * it. See `CardDef.levelBands`.
 *
 * `sorcerySpeed` is the whole restriction and it matters more than it looks: levelling at the end of
 * an opponent's turn, after blockers, would make every leveler a combat trick. The printed cards say
 * "Activate only as a sorcery" for that reason, and the engine already had the flag.
 */
function levelUpAbility(cost: string): AbilityDef {
  return {
    cost: { mana: cost },
    sorcerySpeed: true,
    description: `Level up ${cost} (sorcery speed)`,
    effect: (c) => addCounters(c.state, c.source, 'level', 1),
  };
}

/**
 * Student of Warfare: a {W} one-drop that is a 4/4 double striker if the game goes long.
 *
 * The pool's first **level up** card (CR 702.87), and the cleanest demonstration of what the
 * keyword sells: a 1/1 for one mana is a bad card and a 3/3 first striker for four mana spread over
 * three turns is a good one, and it is the same card — the deck decides which it is with mana it
 * had nothing else to do with.
 *
 * In Dawn Tithe, which is the deck most often holding mana up and doing nothing with it.
 */
const STUDENT_OF_WARFARE: CardScript = {
  name: 'Student of Warfare',
  levelUp: { cost: '{W}' },
  abilities: [levelUpAbility('{W}')],
};

/**
 * Beastbreaker of Bala Ged: the same bargain in green, where the mana is already there.
 *
 * A 2/2 for two that becomes a 4/4 and then a 6/6 trampler. The green half of the pair on purpose:
 * Kindle Grove ramps, so it reaches the second band a turn or two before a white deck would, which
 * is the thing a slot probe can actually see.
 */
const BEASTBREAKER_OF_BALA_GED: CardScript = {
  name: 'Beastbreaker of Bala Ged',
  levelUp: { cost: '{1}{G}' },
  abilities: [levelUpAbility('{1}{G}')],
};

/**
 * Cumulative upkeep: an age counter first, then its cost for each one (CR 702.24).
 *
 * Echo's shape with the one thing echo did not have: a **price that climbs**. The counter goes on as
 * the ability resolves and the cost is read off the counters, so the first upkeep asks for one lot,
 * the second for two, the third for three — and a card that is worth {1} a turn stops being worth it
 * somewhere around the fourth.
 *
 * That is why `DecisionSpecOf` exists. The words on the buttons, the prompt and the price are all
 * facts about *this* resolution rather than about the card, and a static spec cannot hold any of
 * them — so the question is a function, resolved when it is asked. Two orderings make it correct:
 * the counter is added in `beforeDecisions`, which runs before any question is planned, and the
 * function reads the counters rather than remembering a number, so the three places the engine
 * resolves it (planning, asking, paying) all agree.
 *
 * Unlike echo there is **no flag and no once**: cumulative upkeep is asked every upkeep for as long
 * as the permanent is there, which is the whole of what the keyword is.
 */
function cumulativeUpkeepTrigger(cost: string): TriggerDef {
  return {
    on: { kind: 'step', step: 'upkeep' },
    description: `Cumulative upkeep ${cost} — an age counter, then pay for each or sacrifice this`,
    // The counter is part of the ability, not a turn-based action: it goes on as this resolves.
    beforeDecisions: (c) => addCounters(c.state, c.source, 'age', 1),
    decisions: [(state, source) => {
      const age = Math.max(1, state.instances[source]?.counters['age'] ?? 1);
      const price = timesCost(cost, age);
      const pay = `Pay ${price}`;
      return {
        who: 'controller',
        prompt: `Cumulative upkeep: pay ${price} for ${age} age counter${age === 1 ? '' : 's'}, or sacrifice this?`,
        options: ['Sacrifice it', pay],
        payIfChosen: { option: pay, cost: price },
        best: () => pay,
      };
    }],
    effect: (c) => (chosenOption(c)?.startsWith('Pay ') === true
      ? c.state
      : moveToGraveyard(c.state, [c.source])),
  };
}

/**
 * Mystic Remora: two cards every time they do anything, for as long as you keep paying.
 *
 * The pool's first **cumulative upkeep** card (CR 702.24), and the one that makes the climb a real
 * decision rather than an accounting exercise: one mana for two cards is the best rate in the pool,
 * two mana for two cards is still good, and by the fourth or fifth upkeep the Remora is asking for
 * more than the deck can spare — so it is a card you play, milk and then let go.
 *
 * It only reads an **opponent's** noncreature spells, which is why it goes in a deck that is happy
 * to sit behind counterspells: the turns it draws nothing are the turns nobody is doing anything.
 */
const MYSTIC_REMORA: CardScript = {
  name: 'Mystic Remora',
  cumulativeUpkeep: { cost: '{1}' },
  triggers: [
    cumulativeUpkeepTrigger('{1}'),
    {
      on: { kind: 'spell-cast', by: 'opponent', spell: 'noncreature' },
      description: 'you may draw two cards',
      /*
        The words and their order are the compiled reading's (D447), and the `best` this used to
        carry is gone with them.

        It read `options: ['Decline', 'Draw two']` with `best: () => 'Draw two'` — which is a bot
        hint written to undo the option order rather than to say anything about the board.
        `ChoiceDecisionSpec.options` documents the **first** option as the answer a bot falls back
        on, so putting the answer nobody would choose first and then overriding it is two levers
        where one does. Yes first, no `best`, and the bot draws because the question's own default
        says to. This is also what the compiler emits for every "you may" it reads, so the two
        readings of this card agree rather than being listed as a disagreement.
      */
      decisions: [{
        who: 'controller',
        prompt: 'Draw two cards?',
        options: ['Yes', 'No'],
      }],
      effect: (c) => (chosenOption(c) === 'Yes' ? drawLater(c.state, c.controller, 2) : c.state),
    },
  ],
};

/**
 * Mogg War Marshal: two mana, two goblins, and a question next upkeep.
 *
 * The pool's first **echo** card (CR 702.29), and the one that shows why the keyword is a question
 * rather than a tax: the Marshal makes a Goblin when it arrives and another when it dies, so
 * declining the echo costs the body and keeps the board. A player with two mana to spare pays and
 * has three goblins; a player who needs the mana lets it go and still has two.
 */
const MOGG_WAR_MARSHAL: CardScript = {
  name: 'Mogg War Marshal',
  echo: { cost: '{1}{R}' },
  triggers: [
    echoTrigger('{1}{R}'),
    {
      on: { kind: 'etb' },
      description: 'create a 1/1 red Goblin creature token',
      effect: (c) => createToken(c.state, c.controller, GOBLIN_TOKEN, 1),
    },
    {
      on: { kind: 'dies' },
      description: 'create a 1/1 red Goblin creature token',
      effect: (c) => createToken(c.state, c.controller, GOBLIN_TOKEN, 1),
    },
  ],
};

/**
 * Yavimaya Granger: the land is yours whatever you answer.
 *
 * The other half of what echo asks. The Granger's work — a basic land onto the battlefield tapped —
 * is done the moment it resolves, so by the next upkeep the three mana are spent and the only
 * question left is whether a 2/2 is worth {2}{G}. In Kindle Grove, which ramps, it usually is.
 *
 * It takes the last Rampant Growth's slot, which is the fair comparison: same land, same tapped,
 * one mana dearer, with a body and a question attached.
 */
const YAVIMAYA_GRANGER: CardScript = {
  name: 'Yavimaya Granger',
  echo: { cost: '{2}{G}' },
  triggers: [
    echoTrigger('{2}{G}'),
    {
      on: { kind: 'etb' },
      description: 'search your library for a basic land card and put it onto the battlefield tapped',
      decisions: [searchYourLibrary('Search your library for a basic land card', isBasicLand)],
      effect: (c) => {
        const found = chosenCard(c);
        return found === null ? c.state : putOntoBattlefield(c.state, found, c.controller, { tapped: true });
      },
    },
  ],
};

/**
 * Dredge on a body you were going to spend anyway, in the deck that spends bodies.
 *
 * One of the pool's two **dredge** cards (CR 702.52a), and a creature rather than the land the slot
 * was first written as — because a dredge card does nothing until it is in a graveyard, and the
 * instrument found a dredge land offered three times in 96 games: nothing in this pool destroys a
 * land. A 2/2 that sacrifices itself puts itself in the graveyard on the turn it is useful, which
 * is the whole arrangement.
 *
 * In Rot Harvest, which already has a Blood Artist and a Zulaport Cutthroat watching for deaths, so
 * the sacrifice is a play rather than a concession. After that every draw step offers it back for
 * three cards off the top — in the one deck that wanted a full graveyard anyway.
 */
const SHAMBLING_SHELL: CardScript = {
  name: 'Shambling Shell',
  dredge: { mill: 3 },
  abilities: [
    {
      cost: { sacrificeSelf: true },
      description: 'Sacrifice Shambling Shell: Put a +1/+1 counter on target creature.',
      /*
        `_HELPED`, which the hand-written card lacked until D446 made the compiler able to read it
        and `compiled-vs-written.test.ts` put the two side by side. Without `friendly` the bot is
        free to aim a +1/+1 counter at an opponent's creature — the same defect D419 found on
        Garruk, and settled the same way: the hint goes on the hand-written card rather than into a
        row of excuses.
      */
      targets: [TARGET_CREATURE_HELPED],
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : addCounters(c.state, id, '+1/+1', 1);
      },
    },
  ],
};

/**
 * Darkblast: one mana for -1/-1, every turn, for as long as the library lasts.
 *
 * Dredge's other card and the other half of what the keyword does. The Shambling Shell asks what a
 * body you were spending anyway is worth; this asks what **repetition** is worth, which is the
 * thing dredge actually sells:
 * -1/-1 for {B} is a card nobody plays, and -1/-1 for {B} once a turn forever is a card that beats
 * a board of Glistener Elves on its own.
 *
 * In Blight Vector for the second Doom Blade, which is removal for removal — a one-shot kill
 * anything against a recurring kill almost nothing. If the keyword is worth a slot at all it is
 * worth it there, and if the probe says no then that is the number this pool has.
 */
const DARKBLAST: CardScript = {
  name: 'Darkblast',
  // Wears off at end of turn like any other pump, which for a shrink is what kills the creature
  // before it can wear off. See `expiresAtEndOfTurn`.
  expiresAtEndOfTurn: true,
  dredge: { mill: 3 },
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null
      ? c.state
      : pump(c.state, [id], c.source, c.controller, { power: -1, toughness: -1 });
  },
};

/**
 * Search for Tomorrow: a land on turn three, for one mana on turn one.
 *
 * Suspend's other card and the other half of the bargain: two time counters rather than one, and
 * what it buys is not damage but **a turn of mana**. A Rampant Growth for {1}{G} puts a land in
 * tapped; this one, suspended for {G} on turn one, puts one in **untapped** on turn three — so a
 * deck that spends its first turn on it is a deck with four mana on turn three.
 *
 * In Kindle Grove for the second Rampant Growth, which is the same comparison Rift Bolt makes: the
 * card it replaces does nearly the same thing at nearly the same price, so what the measurement is
 * reading is the keyword rather than the card.
 */
const SEARCH_FOR_TOMORROW: CardScript = {
  name: 'Search for Tomorrow',
  suspend: { cost: '{G}', counters: 2 },
  decisions: [searchYourLibrary('Search your library for a basic land card', isBasicLand)],
  onResolve: (c) => {
    const found = chosenCard(c);
    // Untapped, which is the difference from the Rampant Growth it replaces and half of why the
    // card is worth the wait.
    return found === null ? c.state : putOntoBattlefield(c.state, found, c.controller);
  },
};

const THICKET_BASILISK: CardScript = {
  name: 'Thicket Basilisk',
  triggers: [
    {
      on: { kind: 'blocks' },
      description: 'destroy the creature it blocked at end of combat',
      effect: (c) => markForEndOfCombat(c),
    },
    {
      // The same clause from the other side, and a separate trigger because the two events are
      // about different creatures. Both read `c.blocked`, which is the other creature either way.
      on: { kind: 'becomes-blocked' },
      description: 'destroy the creature blocking it at end of combat',
      effect: (c) => markForEndOfCombat(c),
    },
    {
      on: { kind: 'step', step: 'end-combat', of: 'any' },
      delayed: true,
      description: 'destroy the creature it fought',
      // No `destroy` of a creature that has left: `destroy` reads the instance and does nothing
      // for a card that is not on the battlefield, which is the rule rather than a guard.
      effect: (c) => (c.subject === undefined ? c.state : destroy(c.state, c.subject)),
    },
  ],
};

function markForEndOfCombat(c: EffectContext): GameState {
  if (c.blocked === undefined) return c.state;
  return scheduleDelayed(c.state, {
    source: c.source,
    controller: c.controller,
    abilityIndex: delayedIndexOf(THICKET_BASILISK),
    step: 'end-combat',
    // `any`, not `you`: the combat this was scheduled in is as often as not somebody else's turn,
    // and "at end of combat" means *this* combat.
    of: 'any',
    subject: c.blocked,
    description: `destroy ${nameOfCard(c.state, c.blocked)}`,
  });
}

const FLICKERWISP: CardScript = {
  name: 'Flickerwisp',
  keywords: ['flying'],
  triggers: [
    {
      on: { kind: 'etb' },
      description: 'exile another target permanent, and give it back at the next end step',
      targets: [{
        kind: 'permanent',
        description: 'another target permanent',
        // And the hostile reading of a blink: what this exiles is usually an opponent's, where
        // everything the permanent loses on the way out is a gain. See `TargetSpec.blinks`.
        blinks: true,
        // "Another": its own arrival cannot be aimed at itself, which is printed on the card and
        // is also the difference between a blink and a sacrifice.
        filter: (_state, candidate, _controller, source) =>
          candidate.kind === 'card' && candidate.id !== source,
      }],
      effect: (c) => {
        const id = firstCardTarget(c);
        if (id === null) return c.state;
        const name = nameOfCard(c.state, id);
        /*
          Exiled **first**, and then the return is scheduled about the card in exile.

          This used to be the other way round, with a comment saying the order was only about how
          the log reads. That stopped being true when a delayed ability started pinning which
          *object* its subject is (CR 400.7, #285): a zone change makes a new object, so scheduling
          first pinned the permanent on the battlefield and the card that arrived in exile no
          longer matched it — the Flickerwisp's own tests caught that within a minute, which is the
          best argument for the order being written down rather than inferred.

          The name is read before the move for the log line, because `nameOfCard` wants an instance
          and the one in exile is a different object. The *owner* the return needs is read when the
          delayed ability resolves, off whatever is in exile then.
        */
        const exiled = exileCard(c.state, id);
        return scheduleDelayed(exiled, {
          source: c.source,
          controller: c.controller,
          abilityIndex: delayedIndexOf(FLICKERWISP),
          step: 'end',
          of: 'any',
          subject: id,
          description: `return ${name} to the battlefield`,
        });
      },
    },
    {
      on: { kind: 'step', step: 'end', of: 'any' },
      delayed: true,
      description: 'return the exiled card to the battlefield',
      effect: (c) => {
        const id = c.subject;
        const inst = id === undefined ? undefined : c.state.instances[id];
        // Under its **owner's** control, which is the clause that makes this a political card in a
        // pod: a permanent stolen by somebody else goes home, not to whoever blinked it.
        if (inst === undefined || inst.zone !== 'exile') return c.state;
        return putOntoBattlefield(c.state, id!, inst.owner);
      },
    },
  ],
};

/*
  The crown: a designation the engine has had a field for since the tabletop was written, and no
  rules for at all (CR 720).

  Everything about the monarch except "you become the monarch" is a rule of the *game* rather than
  text on a card — the extra card at the beginning of your own end step, and the crown going to
  whoever deals you combat damage — so both of those live in the engine beside the other turn-based
  actions, and a card's whole contribution is one line.

  Which makes these two cards the cheapest interesting thing in the pool. A 2/3 for four that draws
  you an extra card every turn is a fair rate; a 2/3 for four that draws your *opponent* an extra
  card every turn is a disaster, and the difference is whether anything can get through to you. In a
  duel it is a race. In a pod it is the most political object on the table: three players who each
  want the crown have a reason to attack whoever has it, and none of it is enforced by the engine.
*/
const PALACE_SENTINELS: CardScript = {
  name: 'Palace Sentinels',
  triggers: [{
    on: { kind: 'etb' },
    description: 'you become the monarch',
    effect: (c) => becomeMonarch(c.state, c.controller),
  }],
};

const THORN_OF_THE_BLACK_ROSE: CardScript = {
  name: 'Thorn of the Black Rose',
  keywords: ['deathtouch'],
  triggers: [{
    on: { kind: 'etb' },
    description: 'you become the monarch',
    effect: (c) => becomeMonarch(c.state, c.controller),
  }],
};

/*
  Infect: the win condition this engine has always had and never been able to reach (CR 702.90).

  Poison counters, the ten-poison elimination and `-1/-1` counters were all written into the engine
  before any card used them, and nothing in the pool produced a single point of poison — so the
  second way to lose a game of Magic was unreachable by construction.

  The keyword is a fact about the **source** and changes what its damage *becomes* rather than
  whether it lands: a player takes poison instead of life, and a creature takes `-1/-1` counters
  instead of marked damage. The second half is the one players under-rate — marked damage is wiped
  in the cleanup step and a counter is not, so a 1/1 with infect trading blows with a 3/3 leaves a
  1/1 behind for the rest of the game.

  Three cards, in three colours, and all three are 1/1s: that is what infect costs. **Ichorclaw
  Myr** is the one with text of its own, and it is the first card in the pool to use the
  `becomes-blocked` event (D154) — blocking it is how you get poisoned, which is exactly the kind of
  card that makes an unreachable win condition start to look reachable.
*/
const GLISTENER_ELF: CardScript = { name: 'Glistener Elf', keywords: ['infect'] };

const BLIGHT_MAMBA: CardScript = {
  name: 'Blight Mamba',
  keywords: ['infect'],
  abilities: [{
    cost: { mana: '{G}' },
    description: '{G}: Regenerate Blight Mamba.',
    effect: (c) => regenerate(c.state, c.source),
  }],
};

const CYSTBEARER: CardScript = { name: 'Cystbearer', keywords: ['infect'] };

/**
 * Phyrexian Crusader: the card that makes infect an archetype rather than a curiosity.
 *
 * Two keywords and two protections, and every one of the four does something this pool already
 * understands. **First strike** plus infect means it kills a blocker with `-1/-1` counters before
 * the blocker deals its damage back. **Protection from red and from white** (D83) is not flavour:
 * those are the two colours holding almost all of this pool's cheap removal and nearly every
 * first-strike blocker, so the deck's one three-drop simply cannot be answered by five of the
 * eleven decks.
 */
/*
  Phyrexian Crusader is the pool's other card with no script at all, for the same reason as Paladin
  en-Vec above: its one printed line, "First strike, protection from red, protection from white,
  infect", is a mixed list that `printedPart` now reads whole — two keywords and two protections.
  The `keywords` field and the protection static that used to be here restated it.

  It is the card that made the classifier necessary. `printedKeywords` refused the line because two
  parts were not keywords and `printedLandwalk` refused it because none were landwalks, so an
  unscripted creature printing exactly this had neither its first strike, its infect, nor its
  protection.
*/

/**
 * Tainted Strike: one mana that turns anybody's creature into a clock on a different axis.
 *
 * The card infect needed to stop being a creature type. It grants the keyword rather than having
 * it, which works without a line of new code — `dealDamage` reads infect off whatever is dealing
 * the damage through `characteristicsOf`, so a granted keyword and a printed one are the same
 * thing by the time the damage happens. The nastiest use is the one the card is famous for: a big
 * trampling creature is suddenly ten poison rather than ten life.
 */
const TAINTED_STRIKE: CardScript = {
  name: 'Tainted Strike',
  targets: [TARGET_ATTACKER_HELPED],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null
      ? c.state
      : pump(c.state, [id], c.source, c.controller, { power: 1, keywords: ['infect'] });
  },
};

const SKITHIRYX: CardScript = {
  name: 'Skithiryx, the Blight Dragon',
  keywords: ['flying', 'infect'],
  abilities: [
    {
      cost: { mana: '{B}' },
      description: '{B}: Skithiryx gains haste until end of turn.',
      effect: (c) => pump(c.state, [c.source], c.source, c.controller, { keywords: ['haste'] }),
    },
    {
      cost: { mana: '{B}{B}' },
      description: '{B}{B}: Regenerate Skithiryx.',
      effect: (c) => regenerate(c.state, c.source),
    },
  ],
};

const PLAGUE_STINGER: CardScript = { name: 'Plague Stinger', keywords: ['flying', 'infect'] };

const ICHORCLAW_MYR: CardScript = {
  name: 'Ichorclaw Myr',
  keywords: ['infect'],
  triggers: [{
    on: { kind: 'becomes-blocked' },
    description: 'it gets +2/+2 until end of turn',
    // Its own +2/+2 rather than the blocker's, which is what the card says and the opposite of a
    // basilisk: the Myr is not punishing the blocker, it is getting through it.
    effect: (c) => pump(c.state, [c.source], c.source, c.controller, { power: 2, toughness: 2 }),
  }],
};

/*
  The halves of the pool's two-faced cards (CR 708).

  Each half is an ordinary script under its own name, which is the whole trick: a split card and an
  adventurer are two definitions on one piece of cardboard, the engine registers both and points
  `castAs` at whichever one is being cast, and from there a half is a spell like any other. Nothing
  in this file knows that these names are halves rather than cards — which is also why they are
  written here rather than nested inside their parents.

  The *parents* mostly need no script at all. "Fire // Ice" is never cast as itself, and the two
  adventurers are plain bodies; the only thing a parent would ever need a script for is text that
  applies to the creature half, which neither of these two has.
*/

const FIRE: CardScript = {
  name: 'Fire',
  // The same shape as Arc Lightning, with a budget of two rather than three: one target takes both,
  // or two targets take one each. See `divided`.
  targets: [{ kind: 'any', description: 'any target', count: 2, optional: true, divided: 2 }],
  onResolve: (c) => dividedAmong(c).reduce(
    (state, { target, amount }) => dealDamage(state, target, amount, {
      controller: c.controller, source: c.source,
    }),
    c.state,
  ),
};

const ICE: CardScript = {
  name: 'Ice',
  targets: [{
    kind: 'permanent',
    description: 'target permanent',
    // Any permanent at all, which is wider than the Icy Manipulator's artifact-creature-or-land and
    // is what the card says. An already-tapped permanent is still a legal target — the draw is half
    // the card, and a player who wants it may always have it.
    filter: (_state, candidate) => candidate.kind === 'card',
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    // The draw happens whether or not there was still something to tap, because the card does them
    // in that order and the tap is not a condition of the draw.
    return draw(id === null ? c.state : tap(c.state, id), c.controller, 1);
  },
};

const WAX: CardScript = {
  name: 'Wax',
  expiresAtEndOfTurn: true,
  targets: [TARGET_CREATURE_HELPED],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : pump(c.state, [id], c.source, c.controller, { power: 2, toughness: 2 });
  },
};

/**
 * "Destroy target enchantment." — the narrow half of a split card, and deliberately left narrow.
 *
 * Not folded into `destroyAnArtifactOrEnchantment`: this half destroys *only* an enchantment, so a
 * deck holding it cannot answer a Sol Ring with it, and a pool with four enchantments in it is a
 * pool where this half is often uncastable. That is what the card is, and the instrument that
 * measures how often each half gets cast is the right place for the complaint — not a script that
 * quietly makes the card better than it is printed.
 */
const WANE: CardScript = {
  name: 'Wane',
  targets: [{
    kind: 'permanent',
    description: 'target enchantment',
    filter: (state, candidate) => {
      if (candidate.kind !== 'card') return false;
      const inst = state.instances[candidate.id];
      if (inst === undefined) return false;
      return hasType(characteristicsOf(state, inst).typeLine, 'enchantment');
    },
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
};

const VENTURE_DEEPER: CardScript = {
  name: 'Venture Deeper',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return seat === null ? c.state : mill(c.state, seat, 4);
  },
};

const SHIELDS_MIGHT: CardScript = {
  name: "Shield's Might",
  expiresAtEndOfTurn: true,
  targets: [TARGET_CREATURE_HELPED],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : pump(c.state, [id], c.source, c.controller, { power: 3, toughness: 3 });
  },
};

/*
  A land on the **back** of a spell: a modal double-faced card (CR 712).

  Four scripts for two cards, and the two land scripts are the point: a modal card's back face is a
  land that is *played*, so it needs a definition with a mana ability like any other land, and
  nothing about it is special beyond being on the back of something else. `tapLand` is the shape the
  whole printed cycle shares — one colour, and it comes in tapped, which is the price of the
  flexibility.
*/

/** One colour, and it enters tapped: the back half of every modal card in this pool. */
const tapLand = (name: string, type: 'W' | 'U' | 'B' | 'R' | 'G'): CardScript => ({
  name,
  entersTapped: true,
  abilities: [{ cost: { tap: true }, description: `{T}: Add {${type}}.`, produces: [type] }],
});

const HAGRA_MAULING: CardScript = {
  name: 'Hagra Mauling',
  // See `CardScript.removesACreature`: not cast with nothing of theirs to point at — which for this
  // card is the whole decision, because the alternative is a land.
  removesACreature: true,
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
};

const VASTWOOD_FORTIFICATION: CardScript = {
  name: 'Vastwood Fortification',
  targets: [TARGET_CREATURE],
  // A **counter**, not a pump: it does not wear off at end of turn, which is the difference between
  // this and a Giant Growth and the reason it is worth a card in a deck whose creatures have infect.
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : addCounters(c.state, id, '+1/+1', 1);
  },
};

/*
  Metalcraft: an ability that is on while the board says so, and off when it does not.

  Three cards, and only two of them need the machinery. A **conditional static** is a shape the
  engine had no way to say: every other continuous effect is created, applies for a duration and
  expires, while "as long as you control three or more artifacts" has no moment at which it turns on
  — the board changes and the creature is a 4/4, something dies and it is a 2/2 again, with nothing
  to announce and no trigger to watch. `ContinuousEffect.while` is asked every time the effect is
  read, which is the same answer `definesSize` already gives for a size that is a count.

  Galvanic Blast needs none of it, and is the useful contrast: its condition is read **once**, as
  the spell resolves, so it is an ordinary `onResolve` that counts the board. A condition only needs
  to live in the effect when the thing it controls persists.
*/

/**
 * How many artifacts a seat controls — **live**, not printed. Galvanic Blast's count.
 *
 * Metalcraft asks what you control *now* (CR 702.105a), so a permanent a continuous effect has made
 * an artifact counts. Safe to read live here because this runs while a **spell resolves**: nothing
 * is asking what any permanent's characteristics are in order to answer it.
 *
 * `conditionMet` in `characteristics.ts` is the *other* metalcraft count — the one that turns Chrome
 * Steed's and Etched Champion's conditional statics on — and it reads the **printed** line
 * deliberately, because it is called from inside `characteristicsOf` and asking the live line there
 * would be `characteristicsOf` recursing through every other conditional effect on the board. That
 * is a real difference in behaviour between the two counts, written down rather than papered over:
 * a permanent made an artifact adds to Galvanic Blast's count and not to metalcraft's. Nothing in
 * this pool can produce one, so neither reading is observable today.
 *
 * This docblock replaces "off the printed type line (see `conditionMet`)", which was true about the
 * reading and pointed at a function that does not decide it.
 */
const artifactsControlled = (state: GameState, seat: SeatIndex): number => {
  let count = 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    if (hasType(characteristicsOf(state, inst).typeLine, 'artifact')) count += 1;
  }
  return count;
};

/**
 * Monstrosity and adapt (CR 701.32, 701.37): a creature that grows **once** and stays grown.
 *
 * Every other pump in this pool wears off tonight — the whole eleventh member of the
 * drop-this-option family is about that (D73) — and these two do not: the growth is +1/+1
 * counters, which are permanent, and the ability cannot be pressed a second time. The difference
 * between the two keywords is only where the "once" is written. Monstrosity says *activate only if
 * this creature isn't monstrous*, which is a restriction on the ability; adapt says *if it has no
 * +1/+1 counters on it, put N on it*, which is a condition inside the effect — so a creature that
 * has been given a counter by something else cannot adapt at all, and one that has lost its
 * counters can adapt again.
 *
 * Both are written here against the same two counters, because the engine's answer to "is it
 * monstrous" is the counter it is carrying. That is a simplification with one visible edge: a real
 * Fleecemane Lion stays monstrous after a Toxic Deluge takes its counters off and this one does
 * not. The alternative is a flag on the instance for one card, which is the trade D57's rule is
 * about — and the edge is written down rather than hidden.
 */
const monstrosity = (n: number, cost: string): AbilityDef => ({
  cost: { mana: cost },
  description: `Monstrosity ${n} (${cost}: Put ${n} +1/+1 counters on this and it becomes monstrous. `
    + `Activate only if it isn't monstrous.)`,
  // The clause that makes it one-shot, where the ability is offered rather than where it resolves.
  activateOnlyIf: (state, source) => (state.instances[source]?.counters['+1/+1'] ?? 0) === 0,
  effect: (c) => addCounters(c.state, c.source, '+1/+1', n),
});

const adapt = (n: number, cost: string): AbilityDef => ({
  cost: { mana: cost },
  description: `Adapt ${n} (${cost}: If this creature has no +1/+1 counters on it, put ${n} on it.)`,
  /*
    Adapt's "if" is inside the ability rather than on it, which is the printed difference from
    monstrosity and an observable one: the ability is still **offered** with counters already on
    the creature — a player may pay for it and get nothing, exactly as the card allows — so this
    is a condition on the effect and not on the offer.
  */
  effect: (c) => ((c.state.instances[c.source]?.counters['+1/+1'] ?? 0) > 0
    ? c.state
    : addCounters(c.state, c.source, '+1/+1', n)),
  // And the same question again for the bot, which is the only reader of this one: the play is
  // legal and buys nothing, so the table keeps offering it and the search stops taking it. See
  // `AbilityDef.buysNothingIf`.
  buysNothingIf: (state, source) => (state.instances[source]?.counters['+1/+1'] ?? 0) > 0,
});

/**
 * Fleecemane Lion: a 3/3 for two that becomes a 4/4 nothing in this pool can answer.
 *
 * The monstrosity is the cheap half; the static is why the card is famous. *Hexproof and
 * indestructible as long as it is monstrous* is a condition about the permanent's **own** counters,
 * which is `while: { kind: 'source-has-counter' }` — the second kind that field has ever had, and
 * the first that asks about one permanent rather than a player's board. Five mana late in a game is
 * a creature no Doom Blade, no Day of Judgment and no Prey Upon deals with.
 */
const FLEECEMANE_LION: CardScript = {
  name: 'Fleecemane Lion',
  abilities: [monstrosity(1, '{2}{G}{W}')],
  statics: [{
    scope: 'self',
    effect: {
      keywords: ['hexproof', 'indestructible'],
      while: { kind: 'source-has-counter', counter: '+1/+1', atLeast: 1 },
    },
  }],
};

/**
 * Aeromunculus: adapt's half of the family, and a 2/3 flier that is a 5/6 when there is mana spare.
 *
 * {1}{G}{U} for a 2/3 with flying, and {2}{G}{U} to make it a 5/6 — once. Adapt's "if" sits
 * **inside** the ability rather than on it, which is the printed difference from monstrosity and an
 * observable one: a creature that already has a +1/+1 counter on it may still be paid for, and gets
 * nothing. So the ability stays offered and the effect declines, which is the opposite way round
 * from the Fleecemane Lion's.
 *
 * Pteramander was the obvious card for this and is not here: its adapt costs {7}{U} *reduced by one
 * for each instant and sorcery card in your graveyard*, which is a cost modification on an
 * **ability** read off the board, and `costModifiers` applies to spells with a fixed number. A card
 * the engine can only approximate is a card better left unwritten (D57), and Aeromunculus needs
 * nothing new at all.
 */
const AEROMUNCULUS: CardScript = {
  name: 'Aeromunculus',
  abilities: [adapt(3, '{2}{G}{U}')],
};

/** "Metalcraft — ... as long as you control three or more artifacts." */
const METALCRAFT = { kind: 'controller-artifacts', atLeast: 3 } as const;

const CHROME_STEED: CardScript = {
  name: 'Chrome Steed',
  statics: [{ scope: 'self', effect: { power: 2, toughness: 2, while: METALCRAFT } }],
};

/**
 * Protection from **all** colours while the condition holds, which is the other half of the same
 * machinery: a conditional static that grants rather than one that adds to a size.
 *
 * All five colours rather than a special case, because protection is already a list (D83) — so
 * "protection from all colors" is the list with everything in it, and every one of the four rules
 * protection has (cannot be blocked by, targeted by, dealt damage by, enchanted by) applies without
 * anything new. A 1/1 that no coloured removal in this pool can touch while three artifacts are out.
 */
const ETCHED_CHAMPION: CardScript = {
  name: 'Etched Champion',
  statics: [{
    scope: 'self',
    effect: { protectionFrom: ['W', 'U', 'B', 'R', 'G'], while: METALCRAFT },
  }],
};

const GALVANIC_BLAST: CardScript = {
  name: 'Galvanic Blast',
  targets: [ANY_TARGET],
  // Four damage or one, decided as it resolves rather than as it is cast — which is what the card
  // says, and it matters: an artifact that dies to a removal spell in between turns the Blast back
  // into a Shock, and the player who answered it that way earned that.
  onResolve: (c) => damageFirstTarget(c, artifactsControlled(c.state, c.controller) >= 3 ? 4 : 1),
};

/*
  The thirteenth deck's cards: red-green, the colour pair twelve decks had missed.

  Nothing here needs the engine to learn anything, which is the point worth making. A commander
  that taxes noncreature spells is a `spell-cast` trigger with a filter and an `actor`; a creature
  that makes everything fight is the `etb` trigger plus the same `fight` Prey Upon has; an Aura that
  comes back is a `dies` trigger on a permanent that is not a creature; a sweeper with {X} in it is
  the X that has been in the engine since the fifth deck. Eight cards, and the diff in this file is
  almost entirely deck list rather than machinery — which is what "adding a card is a few
  declarative lines" is supposed to mean.
*/

const RURIC_THAR: CardScript = {
  name: 'Ruric Thar, the Unbowed',
  keywords: ['vigilance', 'reach'],
  /*
    "All creatures must attack each combat if able", which is the hardest clause here and needed
    nothing new: `mustAttack` on an `all-creatures` scope. A requirement rather than a restriction,
    so it is checked against the whole declaration — a creature that could have attacked and did
    not makes the attack illegal, and "could have" already accounts for being tapped, summoning
    sick, Pacified or having nobody legal to attack (see `ContinuousEffect.mustAttack`).

    It is symmetric, which is what makes it a commander rather than a beating: the six-mana 6/6 is
    on a board where every creature of yours has to come at somebody too.
  */
  statics: [{ scope: 'all-creatures', effect: { mustAttack: true } }],
  triggers: [{
    on: { kind: 'spell-cast', by: 'any', spell: 'noncreature' },
    description: 'Ruric Thar deals 6 damage to that spell’s controller',
    /*
      "That player" — the one who cast it, which is what `actor` is for. Including its own
      controller: the card is a tax on the table and not a reward for playing it, and that half is
      most of why it is a *commander* rather than a creature.

      `?? c.controller` is not a fallback for a missing value, it **is** the value: `raise` leaves
      `actor` off the stack object when the actor is the trigger source's own controller (see the
      line that builds it), because every card before this one asked only about an opponent. So an
      absent actor means "me", and reading it as nobody is how this card first dealt no damage at
      all to its own side.
    */
    effect: (c) => dealDamage(
      c.state, { kind: 'player', seat: c.actor ?? c.controller }, 6,
      { controller: c.controller, source: c.source },
    ),
  }],
};

const ASSAULT: CardScript = {
  name: 'Assault',
  targets: [ANY_TARGET],
  onResolve: (c) => damageFirstTarget(c, 2),
};

const BATTERY: CardScript = {
  name: 'Battery',
  onResolve: (c) => createToken(c.state, c.controller, ELEPHANT_TOKEN, 1),
};

const BURNING_TREE_EMISSARY: CardScript = {
  name: 'Burning-Tree Emissary',
  /*
    **No `makesMana`**, and that is the field's own rule rather than an omission: it is for a spell
    whose *whole* effect is mana, where the search cannot see what the card did. A creature's body
    is priced by the evaluation already, so declaring it here would hold the Emissary back until
    there was a second spell to cast with the mana — and a 2/2 for two is worth casting on its own.
    Measured both ways on the same 192 games: with the flag `cast-counts` read **46%**, without it
    **101%** — which is both copies cast in every game one of them was drawn.
  */
  triggers: [{
    on: { kind: 'etb', who: 'self' },
    description: 'add {R}{G}',
    effect: (c) => addToPool(addToPool(c.state, c.controller, 'R', 1), c.controller, 'G', 1),
  }],
};

const GRUUL_RAGEBEAST: CardScript = {
  name: 'Gruul Ragebeast',
  triggers: [{
    on: { kind: 'etb', who: 'any', of: 'you', what: 'creature' },
    targets: [{
      kind: 'creature',
      description: "target creature you don't control",
      filter: (state, candidate, controller) => creatureYouDontControl(state, candidate, controller),
    }],
    description: 'that creature fights target creature you don’t control',
    /*
      The creature that *entered* fights, not this one — which is what `subject` on the event is
      for, and the reason the Ragebeast is in the pool at all: it is the only card here whose
      trigger does something to the permanent the event was about rather than to its own source.
      Its own arrival is included (`who: 'any'` with itself in scope), which is the card: a 6/5
      that fights something the turn it lands.
    */
    effect: (c) => {
      const theirs = firstCardTarget(c);
      const mine = c.subject;
      if (theirs === null || mine === undefined) return c.state;
      return fight(c.state, mine, theirs, c.controller);
    },
  }],
};

const SAVAGE_TWISTER: CardScript = {
  name: 'Savage Twister',
  onResolve: (c) => {
    const amount = c.x ?? 0;
    if (amount <= 0) return c.state;
    let state = c.state;
    for (const id of battlefield(state, (cardId) => {
      const inst = state.instances[cardId];
      return inst !== undefined && characteristicsOf(state, inst).isCreature;
    })) {
      state = dealDamage(state, { kind: 'card', id }, amount, {
        controller: c.controller, source: c.source,
      });
    }
    return state;
  },
};

/**
 * Rancor: the Aura that comes back, and the card that reads a graveyard it is in itself.
 *
 * What makes the card is the interaction — answering the creature does not answer the Aura, so a
 * removal spell trades one card for nothing — and what makes the *trigger* interesting is one
 * word of its printed text. It was written here as a `dies` trigger (`what: 'permanent'`, because
 * an Aura is not a creature), which is the old printing: "put into a graveyard **from the
 * battlefield**". The card has read **"from anywhere"** for years, and the three other anywheres
 * were invisible to that event: a Rancor discarded out of a hand, milled off a library, or put
 * into a graveyard by anything that is not a death came back in the old version and does now.
 *
 * So it is a `to-graveyard` trigger with `who: 'self'` — the option that event grew for this card,
 * since it was written for a Planar Void whose printed word is "another" (D172, D179). Two things
 * travel with it. The watcher fires from the graveyard it has just reached, which `raise` now
 * allows for a `to-graveyard` subject the way it always has for a death. And the effect is
 * **guarded**: by the time the ability resolves the card may have been exiled — by the Planar Void
 * whose own trigger was on the stack beside it, or by a Scavenging Ooze in between — and an
 * unguarded return would pull it back out of exile. An ability does as much as it can and no more
 * (CR 608.2), so a Rancor that is no longer in a graveyard stays where it is.
 */
const RANCOR: CardScript = {
  name: 'Rancor',
  aura: {
    target: { kind: 'creature', description: 'enchant creature', friendly: true },
    effect: { power: 2, keywords: ['trample'] },
  },
  triggers: [{
    on: { kind: 'to-graveyard', who: 'self' },
    description: 'return Rancor to its owner’s hand',
    effect: (c) => (c.state.instances[c.source]?.zone === 'graveyard'
      ? moveToHand(c.state, [c.source])
      : c.state),
  }],
};

const THRAGTUSK: CardScript = {
  name: 'Thragtusk',
  triggers: [
    {
      on: { kind: 'etb', who: 'self' },
      description: 'you gain 5 life',
      effect: (c) => gainLife(c.state, c.controller, 5),
    },
    {
      /*
        `leaves` rather than `dies`, which is the whole of why the card is famous: exiling it, or
        bouncing it, or a sacrifice, all still leave a 3/3 behind. The engine records leaving the
        battlefield separately from dying for exactly this shape (CR 603.6c).
      */
      on: { kind: 'leaves' },
      description: 'create a 3/3 green Beast creature token',
      effect: (c) => createToken(c.state, c.controller, BEAST_TOKEN, 1),
    },
  ],
};

/*
  ── The three cards that read a draw ───────────────────────────────────────────────────────────

  `draws` is the fifth event in the detect-rather-than-announce family and the first one added for
  cards rather than for a rule. `draw` in `effects.ts` is the only place a card is actually drawn —
  the draw step, the crown, and two dozen card effects all come through it — and until now it
  raised nothing, so "whenever you draw a card" was unwritable. See `GameState.drew` for why a draw
  has to be *recorded* rather than noticed: a Diabolic Tutor and a Gravedigger both put a card in a
  hand without anybody drawing one, and a hand-size comparison cannot tell those from a draw.

  Two cards, one for each half of the event, because an option with no card behind it is worse than
  no option: Chasm Skulker watches its own controller and Fate Unraveler watches the others. `any`
  is deliberately not offered — nothing is printed in this pool that wants it.
*/
/*
  Islandwalk on a token, declared as a script rather than left to its oracle text.

  Flying on the Thopter token is read straight off `oracleText` by `printedKeywords`; landwalk could
  not be, because it is a land *type* plus a rule rather than a keyword string, so it is declared the
  way River Boa declares it — a static scoped to the card itself, which `canBlock` reads off the
  attacker. The token finds this script the same way the Pest does, by its name.

  `printedLandwalk` reads it off the token's own `Islandwalk` line instead (#324), so the static
  that used to be here was a second source for one fact and is **deleted** (D424) — the same call
  D419 made on Basilica Guards' printed `defender`, and the same one River Boa's docblock records.
  The test that pins this token's islandwalk now pins it through the printed reading, which is the
  thing a token arriving from printed data will actually rely on.

  The script is kept, empty of statics, because `SQUID_TOKEN`'s own docblock points here for where
  its islandwalk is explained.
*/
const SQUID: CardScript = {
  name: 'Squid',
};

/*
  Chasm Skulker: the card the `draws` event was built for.

  A 1/1 for three that is worth whatever the deck draws, and in Hollow Tide that is two Thought
  Scours, a Preordain, a Divination, two Thieving Magpies and a Jace, Memory Adept on top of the
  draw step. Both halves of it are a test of something: the first is the only `draws` trigger in
  the pool that watches its own controller, and the second reads **counters the permanent no longer
  has** — it is in a graveyard by the time the ability resolves and `relocate` took its counters
  off on the way, as the rules require, so the number travels with the event through
  `EffectContext.subjectCounters`. Hangarback Walker found that path first; this is the second card
  on it, and the first where the counters were put there by a trigger rather than paid for.
*/
const CHASM_SKULKER: CardScript = {
  name: 'Chasm Skulker',
  triggers: [
    {
      on: { kind: 'draws' },
      description: 'put a +1/+1 counter on Chasm Skulker',
      effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
    },
    {
      on: { kind: 'dies' },
      description: 'create a 1/1 Squid with islandwalk for each +1/+1 counter on it',
      effect: (c) => {
        const counters = c.subjectCounters?.['+1/+1'] ?? 0;
        return counters === 0 ? c.state : createToken(c.state, c.controller, SQUID_TOKEN, counters);
      },
    },
  ],
};

/*
  Fate Unraveler, for the other half of the event.

  "Whenever an opponent draws a card, that player loses 1 life" — a 2/4 body with a drain stapled
  to the one thing every deck does every turn, in the deck whose plan is already a life total going
  down a point at a time beside three Blood Artists and two Zulaport Cutthroats.

  The card the pool's black decks would rather have is Underworld Dreams, and it is not here for a
  reason worth writing down: {B}{B}{B} in a deck with eleven black sources and seven Mountains is a
  card that sits in hand, which is the failure `cast-counts` keeps finding. Four mana for the same
  trigger on a body that blocks is the version this pool can actually cast.

  `by: 'opponent'` has to be said out loud, because the default on this event is `you` — the same
  default every other trigger here takes. A pod is what makes the distinction real: "whenever an
  opponent draws" is three players' draw steps, not the table's.
*/
const FATE_UNRAVELER: CardScript = {
  name: 'Fate Unraveler',
  triggers: [
    {
      on: { kind: 'draws', by: 'opponent' },
      description: 'deals 1 damage to that player',
      /*
        **Damage**, not life loss, which is what the card prints — and the two are different at the
        table: a prevention shield stops damage and does nothing to a loss of life (CR 120.3, CR
        615), damage can be redirected, and "whenever a source deals damage" sees one and not the
        other. This script said `loseLife` until D407 and nothing caught it, because the only test
        on the card read the life total, which both readings move by the same amount.

        The guard replaces an `?? c.controller` fallback that was worse than nothing: an event with
        no actor would have drained **the controller**, which is the opposite of what the card says.
        `by: 'opponent'` means that cannot happen today; a card whose wrong case is its own
        controller is one bad event away from a very confusing game.
      */
      effect: (c) => {
        const who = c.actor;
        if (who === undefined || who === c.controller) return c.state;
        return dealDamage(c.state, { kind: 'player', seat: who }, 1, {
          controller: c.controller, source: c.source,
        });
      },
    },
  ],
};

/**
 * Soulbond's pairing ability, written out as the two triggers the keyword abbreviates (CR 702.95a).
 *
 * "You may pair this creature with another unpaired creature you control when either enters the
 * battlefield" is one printed line and **two questions**, which is why it is two triggers rather
 * than one with a branch in it:
 *
 *  - this creature arriving finds a board that may hold several unpaired creatures, so the question
 *    is *which one* — a target, declinable, the way every printed "you may" in this engine is;
 *  - somebody else arriving leaves only one candidate, the newcomer, so the question is *whether* —
 *    a word, and `ChoiceDecisionSpec` is the shape for that.
 *
 * One trigger would have had to ask the harder question in both cases, and a prompt offering a
 * choice of one is noise the engine already refuses to generate elsewhere.
 *
 * A card declaring `soulbond` must carry both, which a test holds — the same arrangement `dash` has
 * with `dashReturn()`. Nothing here is the engine's: `pairCreatures` writes the pair, and the bonus
 * is a `scope: 'pair'` static that `applyStatics` adds as the creature enters.
 */
const PAIR_THEM = 'Pair them';

const unpairedFriends = (
  state: GameState, source: string, controller: SeatIndex,
): readonly string[] => creaturesControlledBy(state, controller)
  .filter((id) => id !== source && state.instances[id]?.pairedWith === undefined);

const soulbondTriggers = (): readonly TriggerDef[] => [
  {
    on: { kind: 'etb' },
    description: 'pair it with another unpaired creature you control',
    // Asked only when there is something to ask about. An unpaired creature arriving next to a
    // board of already-paired creatures has no legal pairing, and a prompt with nothing in it is
    // worse than no prompt.
    condition: (c) => c.state.instances[c.source]?.pairedWith === undefined
      && unpairedFriends(c.state, c.source, c.controller).length > 0,
    targets: [{
      kind: 'creature',
      description: 'another unpaired creature you control',
      optional: true,
      // Its own side, and the pairing is a gift: without this the bot's default aim is the enemy
      // board, where `pairCreatures` would refuse every candidate. See `TargetSpec.friendly`.
      friendly: true,
      filter: (state, candidate, controller, source) => candidate.kind === 'card'
        && candidate.id !== source
        && creatureYouControl(state, candidate, controller)
        && state.instances[candidate.id]?.pairedWith === undefined,
    }],
    effect: (c) => {
      const partner = firstCardTarget(c);
      return partner === null ? c.state : pairCreatures(c.state, c.source, partner);
    },
  },
  {
    on: { kind: 'etb', who: 'another', of: 'you', what: 'creature' },
    description: 'pair it with the creature that entered',
    /*
      Both halves unpaired, checked as the ability resolves rather than when it was put on the
      stack, which is what an intervening-if clause means (CR 603.4) and what makes two creatures
      entering at once behave: the first pairing takes, and the second ability finds its own source
      already paired and does nothing.
    */
    condition: (c) => c.subject !== undefined
      && c.state.instances[c.source]?.pairedWith === undefined
      && c.state.instances[c.subject]?.pairedWith === undefined,
    decisions: [{
      who: 'controller',
      prompt: 'Pair them?',
      options: [PAIR_THEM, 'Leave them unpaired'],
      /*
        The bot pairs, always, and this is a fact about the pool rather than a weight. Every
        soulbond printed here gives the pair +N/+N, which costs nothing and can only be lost by the
        creature leaving anyway — so there is no board a player would read and decline on. A card
        whose soulbond bonus had a downside would want its own answer here, and would be a different
        card.
      */
      best: () => PAIR_THEM,
    }],
    effect: (c) => {
      if (c.subject === undefined || chosenOption(c) !== PAIR_THEM) return c.state;
      return pairCreatures(c.state, c.source, c.subject);
    },
  },
];

/**
 * Wolfir Silverheart: six mana for a 4/4, and an 8/8 standing next to another 8/8.
 *
 * The card soulbond was printed around, and the reason the mechanic is worth an engine rather than
 * a keyword: +4/+4 **twice** is eight points of board for six mana, and all of it is rented. Kill
 * either creature and the other shrinks by four in the same instant — so the removal spell an
 * opponent has been holding is suddenly worth two cards, and the player who paired has to decide
 * which of the two they can least afford to lose.
 *
 * It is also the pool's first bonus that **moves**: when the pair breaks, this creature may pair
 * again with the next creature to arrive, so the same card can carry a different board later.
 * Nothing else in this pool does that; an Aura and an Equipment both have to be moved by hand or
 * not at all.
 */
const WOLFIR_SILVERHEART: CardScript = {
  name: 'Wolfir Silverheart',
  soulbond: { effect: { power: 4, toughness: 4 } },
  triggers: [...soulbondTriggers()],
};

/**
 * Trusted Forcemage: the same mechanic at three mana, where the pair is the point rather than the
 * payoff.
 *
 * Second card for soulbond (D239's rule: a mechanic on one card is a mechanic one deck change can
 * delete), and deliberately the cheap one. A 2/2 for three that makes a 3/3 and is a 3/3 is a fair
 * body on an empty board and a good one on a board that already has something, which is the choice
 * soulbond is actually about — whether to hold the creature a turn for a better partner.
 */
const TRUSTED_FORCEMAGE: CardScript = {
  name: 'Trusted Forcemage',
  soulbond: { effect: { power: 1, toughness: 1 } },
  triggers: [...soulbondTriggers()],
};

/**
 * Tandem Lookout: the pair does not get bigger, it gets a **card** every time it connects.
 *
 * The card this engine's granting machinery was built for, and the reason the gap was worth
 * closing rather than working around. Soulbond's other two cards hand out a body — +4/+4, +1/+1 —
 * which `PumpOptions` could already say. This one hands out an *ability*, and nothing in the engine
 * could express that at all: "each of those creatures has 'Whenever this creature deals damage to a
 * player, draw a card'" is a triggered ability sitting on a permanent that never printed it, which
 * is the structural hole the myriad docblock named in as many words.
 *
 * It is declared in two halves, which is what `ContinuousEffect.grants` is about: the ability is
 * `grantedTriggers[0]` here, and `soulbond.effect` says `grants: [0]` — so the pair scope that
 * already existed carries it, and the ability comes and goes with the pairing without anything
 * having to notice. Break the pair and both creatures stop drawing; pair the Lookout with
 * something else next turn and that creature starts.
 *
 * **The ability belongs to whichever creature has it** (CR 113.6), and that is the whole value of
 * the card: pair it with something evasive and the *other* creature is the one drawing cards, which
 * is a decision the player makes at the moment of pairing and cannot take back. "This creature" in
 * the granted text means the holder, which falls out of the holder being the trigger's source
 * rather than being special-cased.
 */
const TANDEM_LOOKOUT: CardScript = {
  name: 'Tandem Lookout',
  soulbond: { effect: { grants: [0] } },
  triggers: [...soulbondTriggers()],
  grantedTriggers: [{
    /*
      `combat-damage` without a `to`, for the reason Topan Freeblade's docblock gives: the engine
      raises this event only for damage that actually took a player's life total down, which is
      exactly "deals damage to a player". A blocked attacker and a swing stopped by a Fog draw
      nothing, which is the printed card.
    */
    on: { kind: 'combat-damage' },
    description: 'draw a card',
    effect: (c) => draw(c.state, c.controller, 1),
  }],
};

/**
 * Ophidian Eye: the same granted ability through the **other** route, and the one that proves the
 * claim.
 *
 * Tandem Lookout hands its draw trigger out through a soulbond pair; this hands the identical
 * ability to one creature through an Aura. Two cards rather than one on purpose (D239: a mechanic
 * resting on a single card is one deck change from gone), but the second card is doing more than
 * making a count: the two reach `ContinuousEffect.grants` by completely different paths —
 * `applyStatics`' pair scope and `addAuraEffect`'s `{ kind: 'cards' }` — and the whole argument
 * for putting the grant on `PumpOptions` was that every builder would then carry it for nothing.
 * A second card that used the same builder would have left that untested.
 *
 * Flash is the card's own text and it matters: cast in response to a blocker, the creature that was
 * about to get through connects and draws. And the Aura being removal-bait cuts the other way from
 * the Lookout — killing the enchanted creature takes the Eye with it, where killing the Lookout
 * leaves its partner alive and merely unpaired.
 */
const OPHIDIAN_EYE: CardScript = {
  name: 'Ophidian Eye',
  aura: {
    /*
      A bonus, so the bot aims it at its own side — and at a creature that can *attack*, because
      the trigger it grants reads "deals damage to a player". See `TargetSpec.friendly` and
      `TargetSpec.helpsInCombat`: without the second one this landed on a Wall of Air, which can
      never deal damage to anybody.
    */
    target: {
      kind: 'creature', description: 'enchant creature', friendly: true, helpsInCombat: true,
    },
    effect: { grants: [0] },
  },
  grantedTriggers: [{
    on: { kind: 'combat-damage' },
    description: 'draw a card',
    effect: (c) => draw(c.state, c.controller, 1),
  }],
};

/**
 * Harm's Way: the last member of the replacement-effect family, and the one that *moves* the damage
 * rather than eating it (CR 615.9).
 *
 * Everything else in this pool's prevention family stops damage: a Fog, a Maze of Ith, a Samite
 * Healer's shield. This one stops it and then deals the same points somewhere of your choosing, so
 * the Lightning Bolt pointed at your face kills their two-drop. That is a different card from a
 * shield even though it is built out of one — a shield is worth the life it saves (D90) and this is
 * worth that plus whatever it hits.
 *
 * Two mana of effect for one, which is why the number is small: two points, fixed, and only on your
 * own side. The redirected damage is a new damage event from the **same source**, so a protection
 * from red creature cannot be hit with a redirected Bolt and an infect source poisons with it.
 */
const HARMS_WAY: CardScript = {
  name: "Harm's Way",
  // For the bot: a card whose whole effect expires at end of turn has done nothing unless
  // something was coming. See `preventsDamage`.
  preventsDamage: true,
  targets: [ANY_TARGET],
  onResolve: (c) => redirectToFirstTarget(c, 2),
};

/**
 * Divine Deflection: the same effect with the number paid for.
 *
 * Second card for redirection (D239) and deliberately the scaling one: {X}{W} buys X points of
 * prevention and X points of damage, so late in a game it is a Fog and a burn spell on one card.
 * It is also the pool's eighth {X} spell and the first whose X is spent *twice* — once on what it
 * stops and once on what it deals — which is one number doing two jobs rather than two numbers.
 */
const DIVINE_DEFLECTION: CardScript = {
  name: 'Divine Deflection',
  preventsDamage: true,
  targets: [ANY_TARGET],
  onResolve: (c) => redirectToFirstTarget(c, c.x),
};

const ALL: readonly CardScript[] = [
  basicLand('Mountain', 'R'),
  basicLand('Forest', 'G'),
  basicLand('Plains', 'W'),
  basicLand('Island', 'U'),
  basicLand('Swamp', 'B'),
  guildgate('Selesnya Guildgate', 'G', 'W'),
  guildgate('Dimir Guildgate', 'U', 'B'),
  guildgate('Golgari Guildgate', 'B', 'G'),
  MONASTERY_SWIFTSPEAR, RAGING_GOBLIN, FIREBRAND_ARCHER, SHIVAN_DRAGON,
  LIGHTNING_BOLT, SHOCK, LAVA_SPIKE, FLAME_SLASH, ACT_OF_TREASON, KRENKO, FLAMETONGUE_KAVU,
  LLANOWAR_ELVES, AJANIS_PRIDEMATE, SERRA_ANGEL, GIANT_GROWTH, PACIFISM,
  SWORDS_TO_PLOWSHARES, HARMONIZE, OVERRUN, SIGARDA,
  COUNTERSPELL, NEGATE, DOOM_BLADE, DIVINATION, SIGN_IN_BLOOD, TOME_SCOUR,
  RAVENOUS_RATS, CHILD_OF_NIGHT, WIND_DRAKE, VAMPIRE_NIGHTHAWK, AIR_ELEMENTAL, TALRAND, MAN_O_WAR,
  GRAVEDIGGER, RAISE_DEAD, ZOMBIFY, THORNWEALD_ARCHER, WALL_OF_BLOSSOMS, LOTLETH_GIANT, IZONI,
  VAMPIRE_ARISTOCRAT, BLOODTHRONE_VAMPIRE,
  RAMPANT_GROWTH, DIABOLIC_TUTOR, MIND_ROT, FAITHLESS_LOOTING, FLESHBAG_MARAUDER,
  SELESNYA_CHARM, SOUL_MANIPULATION, GRIM_DISCOVERY,
  DOOMED_TRAVELER, DOOMED_DISSENTER, GOBLIN_ARSONIST, PHYREXIAN_ARENA, GLORIOUS_ANTHEM,
  THERMO_ALCHEMIST,
  // Transform. Insectile Aberration is absent on purpose: its whole back face is "Flying", which
  // `printedKeywords` reads off the oracle text, so it needs no script.
  DELVER_OF_SECRETS, THING_IN_THE_ICE, AWOKEN_HORROR,
  BLOOD_ARTIST, ZULAPORT_CUTTHROAT, SOUL_WARDEN, IMPACT_TREMORS,
  FIREBALL, SECURE_THE_WASTES, MIND_SPRING, EXSANGUINATE, HURRICANE,
  MAGMA_JET, PREORDAIN, OMENSPEAKER,
  DRUDGE_SKELETONS, GOLGARI_CHARM, ENDLESS_ONE,
  LEONIN_SKYHUNTER, RAISE_THE_ALARM, ANGELIC_GIFT, INSPIRED_CHARGE, BALAN,
  JACE_BELEREN, GARRUK_WILDSPEAKER, ARMORY_OF_IROAS,
  guildgate('Boros Guildgate', 'R', 'W'),
  guildgate('Izzet Guildgate', 'U', 'R'),
  equipment('Bonesplitter', '{1}', { power: 2 }, 'equipped creature gets +2/+0'),
  equipment('Loxodon Warhammer', '{3}', { power: 3, keywords: ['trample', 'lifelink'] },
    'equipped creature gets +3/+0 and has trample and lifelink'),
  equipment('Basilisk Collar', '{2}', { keywords: ['deathtouch', 'lifelink'] },
    'equipped creature has deathtouch and lifelink'),
  /*
    And the Equipment that grants a keyword the **engine** acts on rather than the rules read.

    Four lines like every other Equipment here, and that is the whole claim of the engine work
    behind it: myriad is in `KEYWORDS`, `declareAttackers` is where it happens, and a card that
    hands it to a creature is `{ keywords: ['myriad'] }` exactly as the Collar hands out deathtouch.
    See `myriadCopies`, and D229 for what it is worth at four seats and what it is worth at two
    (nothing).
  */
  equipment('Blade of Selves', '{3}', { keywords: ['myriad'] },
    'equipped creature has myriad'),
  cyclingLand('Barren Moor', 'B'),
  cyclingLand('Forgotten Cave', 'R'),
  cyclingLand('Lonely Sandbar', 'U'),
  cyclingLand('Secluded Steppe', 'W'),
  cyclingLand('Tranquil Thicket', 'G'),
  BURST_LIGHTNING, BREATH_OF_DARIGAAZ, AGONIZING_DEMISE, BONE_SPLINTERS, VILLAGE_RITES, JUDITH,
  BANISHER_PRIEST, JOURNEY_TO_NOWHERE, BANISHING_LIGHT,
  NATURALIZE, DISENCHANT, BLOSSOMING_DEFENSE, DIVE_DOWN, JUGGERNAUT, DISRUPT_DECORUM, KALITAS,
  SOL_RING, MIND_STONE, BIRDS_OF_PARADISE, TREASURE, CLUE,
  THRABEN_INSPECTOR, PIRATES_PRIZE, LOTUS_PETAL,
  DAY_OF_JUDGMENT, ESSENCE_SCATTER, UNSUMMON, ICY_MANIPULATOR, TORMODS_CRYPT,
  AMBUSH_VIPER, ELVISH_VISIONARY, READ_THE_BONES,
  HELLRIDER, BALL_LIGHTNING, CLOUDSHIFT, SOULHERDER, FROGMITE,
  YOUTHFUL_KNIGHT, BOGGART_BRUTE, ROBE_OF_MIRRORS, NIGHT_OF_SOULS_BETRAYAL,
  WALL_OF_AIR, HANNA,
  LIGHTNING_STRIKE, CANCEL, MURDER, GIANT_SPIDER, TITANIC_GROWTH, HEALERS_HAWK, LAVA_AXE,
  DARK_RITUAL, BORDERLAND_MARAUDER, PREY_UPON, DIVINE_VERDICT,
  CLONE, TURN_TO_FROG, CACKLING_COUNTERPART,
  MIRKO_VOSK, THIEVING_MAGPIE, MIND_SCULPT, THOUGHT_SCOUR, COMPELLING_ARGUMENT,
  RETURNED_CENTAUR, NEMESIS_OF_REASON, PSYCHIC_STRIKE, JACE_MEMORY_ADEPT,
  FOG, HOLY_DAY, SAMITE_HEALER, HEALING_SALVE, MAZE_OF_ITH, FOG_BANK, CITY_OF_BRASS,
  MANA_CONFLUENCE, DARK_CONFIDANT,
  guildgate('Azorius Guildgate', 'W', 'U'),
  equipment('Darksteel Plate', '{2}', { keywords: ['indestructible'] },
    'equipped creature is indestructible'),
  guildgate('Rakdos Guildgate', 'B', 'R'),
  MUTAVAULT, CRIMSON_WISPS, LHURGOYF, THINK_TWICE, FIREBOLT,
  PHOENIX_OF_ASH, GURMAG_ANGLER, TREASURE_CRUISE, PLANAR_VOID, SCAVENGING_OOZE, WOE_STRIDER,
  REST_IN_PEACE, FIREMANE_AVENGER, SUNHOME_STALWART, TOPAN_FREEBLADE, GOBLIN_WARDRIVER,
  BLOODBRAID_ELF, GRAPESHOT, FIERY_TEMPER, MULLDRIFTER, MARDU_SCOUT, BOON_SATYR,
  SKEWER_THE_CRITICS, MIZZIUM_MORTARS,
  AETHER_HUB, LONGTUSK_CUB, BRISTLING_HYDRA, HARNESSED_LIGHTNING,
  KITCHEN_FINKS,
  DRAGONSGUARD_ELITE, SEDGEMOOR_WITCH, PEST,
  SIEGE_WURM, CONCLAVE_TRIBUNAL,
  ZOETIC_CAVERN, DIRGUR_NEMESIS, BATTERING_CRAGHORN, AINOK_SURVIVALIST, MASTER_OF_PEARLS,
  SKY_SKIFF, RENEGADE_FREIGHTER, CONSULATE_DREADNOUGHT,
  THE_BIRTH_OF_MELETIS, THE_ELDEST_REBORN, BEHOLD_THE_MULTIVERSE, SAW_IT_COMING,
  ADELIZ, STORMCHASER_MAGE, YOUNG_PYROMANCER, GUTTERSNIPE, GELECTRODE, ENIGMA_DRAKE,
  STROMKIRK_CAPTAIN, KNIGHT_EXEMPLAR, IMPERIOUS_PERFECT,
  ZOMBIE_CUTTHROAT, HIDDEN_DRAGONSLAYER,
  WILLBENDER, SWERVE,
  GUARDIANS_OF_AKRASA, CLOUDFIN_RAPTOR,
  SQUELCH, DISALLOW,
  OBELISK_OF_URD, VOICE_OF_ALL,
  IMPASSIONED_ORATOR, BLOODTHIRSTY_AERIALIST, CRUEL_CELEBRANT, REVITALIZE, VRASKAS_CONTEMPT,
  KAMBAL,
  guildgate('Orzhov Guildgate', 'W', 'B'),
  ARC_LIGHTNING,
  STRIONIC_RESONATOR,
  AJANI_CALLER_OF_THE_PRIDE, NISSA_VOICE_OF_ZENDIKAR,
  EXPLORE, TATYOVA, KIORAS_FOLLOWER, PELAKKA_WURM, CHALICE_OF_THE_VOID,
  WALKING_BALLISTA, HANGARBACK_WALKER, TOXIC_DELUGE, TWINCAST,
  GOBLIN_ELECTROMANCER, THALIA_GUARDIAN_OF_THRABEN, TORMENTED_SOUL, RIVER_BOA,
  WALL_OF_FROST, OPHIDIAN, THICKET_BASILISK, FLICKERWISP,
  PALACE_SENTINELS, THORN_OF_THE_BLACK_ROSE,
  YOUNG_WOLF, BUTCHER_GHOUL, MURDEROUS_REDCAP,
  FLEECEMANE_LION, AEROMUNCULUS,
  DREGSCAPE_ZOMBIE, HELLSPARK_ELEMENTAL,
  GLISTENER_ELF, PLAGUE_STINGER, ICHORCLAW_MYR, BLIGHT_MAMBA, CYSTBEARER,
  TAINTED_STRIKE, SKITHIRYX,
  guildgate('Simic Guildgate', 'G', 'U'),
  FIRE, ICE, WAX, WANE, VENTURE_DEEPER, SHIELDS_MIGHT,
  HAGRA_MAULING, VASTWOOD_FORTIFICATION,
  CHROME_STEED, ETCHED_CHAMPION, GALVANIC_BLAST,
  RURIC_THAR, ASSAULT, BATTERY, BURNING_TREE_EMISSARY, GRUUL_RAGEBEAST, SAVAGE_TWISTER,
  RANCOR, THRAGTUSK,
  guildgate('Gruul Guildgate', 'R', 'G'),
  tapLand('Hagra Broodpit', 'B'), tapLand('Vastwood Thicket', 'G'),
  SQUID, CHASM_SKULKER, FATE_UNRAVELER,
  SACRED_CAT, ANGEL_OF_SANCTIONS, ADORNED_POUNCER, SUNSCOURGE_CHAMPION,
  THUNDEROUS_WRATH, TERMINUS, STAGGERSHOCK, DISTORTION_STRIKE, PYROMATICS, TRAIN_OF_THOUGHT,
  BASILICA_SCREECHER, BASILICA_GUARDS, RIFT_BOLT, SEARCH_FOR_TOMORROW,
  SHAMBLING_SHELL, DARKBLAST, CAPSIZE, WHISPERS_OF_THE_MUSE,
  CONTAGION_CLASP, STEADY_PROGRESS,
  MOGG_WAR_MARSHAL, YAVIMAYA_GRANGER, MYSTIC_REMORA,
  STUDENT_OF_WARFARE, BEASTBREAKER_OF_BALA_GED,
  CALCIDERM, BLASTODERM,
  SUDDEN_SHOCK, KROSAN_GRIP,
  NINJA_OF_THE_DEEP_HOURS,
  ARCBOUND_WORKER, ARCBOUND_RAVAGER, ICHOR_WELLSPRING,
  WOLFIR_SILVERHEART, TRUSTED_FORCEMAGE, TANDEM_LOOKOUT, OPHIDIAN_EYE,
  HARMS_WAY, DIVINE_DEFLECTION,
];

export const CARD_SCRIPTS: ReadonlyMap<string, CardScript> = new Map(
  ALL.map((script) => [script.name.trim().toLowerCase(), script]),
);

/** The script for a card, or undefined when it is not automated. */
export const scriptFor = (name: string | undefined): CardScript | undefined =>
  name === undefined ? undefined : CARD_SCRIPTS.get(name.trim().toLowerCase());

export const scriptedCardNames = (): string[] => [...CARD_SCRIPTS.values()].map((s) => s.name).sort();

export { cardTargets, destroy };

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The keyword table: a printed line in, a piece of a CardScript out
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What one printed keyword line is worth, as the fragment of a `CardScript` the hand-written cards
 * in this file set for it — or `null` when nothing here can read the line.
 *
 * This is the first stage of the oracle-text compiler (#317) and the reason it can exist at all:
 * the hand-written scripts above have already been factored into parameterised builders, so for a
 * keyword the printed line *is* the argument. `Modular 1` is `modularTrigger(1)`; `Ward {1}` is
 * `ward(name, '{1}')`; `Undying` takes no argument at all. Nothing is invented — every entry below
 * is the shape of a card in this file, and `scripts.test.ts` compiles each of those cards' own
 * printed text and compares the result against the hand-written script, which is what stops this
 * table drifting away from the cards it is copied from.
 *
 * ## Why a fragment of a script and not a trigger
 *
 * Because a trigger alone is wrong, and three keywords here prove it. `vanishingTrigger(4)` takes a
 * time counter off and sacrifices the permanent when the last one goes — but the counters come from
 * `entersWith`, and the keyword declaration lives in `vanishing`. Emit the trigger on its own and
 * you get a creature with no counters whose trigger is conditioned on having one: a Calciderm that
 * **never dies**, which is a strictly worse card than one left to be moved by hand. Modular and
 * fading have the same three-part shape. So the unit of compilation is a partial `CardScript`, and
 * every field the hand-written twin sets for that keyword has to be in it.
 *
 * ## What is deliberately absent, and why each one would be a lie
 *
 * - **Soulbond.** Its line is the word alone; the bonus the pair gets is on the *next* line. A
 *   `soulbond: { effect: { power: 1, toughness: 1 } }` guessed from the keyword would be a number
 *   this module made up — see D259. It belongs to the stage that reads sentences.
 * - **Level up.** `levelUpAbility(cost)` is readable from the line, but a leveler's `levelBands`
 *   are three blocks of printed text below it, and a level-up ability with no bands to reach is an
 *   ability that costs mana and does nothing.
 * - **Kicker and overload.** Their payoff is printed on *another* line — "If this spell was kicked,
 *   it deals 4 damage instead" — so the declaration alone is an option to pay more for nothing.
 *   Every other alternative cost here changes only *how* the card is cast; these two change what it
 *   does, and overload's field takes an `onResolve` no line can supply.
 * - **Evoke.** `CardScript.evoke` is only half of it. The other half is "when this permanent
 *   enters, if its evoke cost was paid, sacrifice it", which the pool writes out as an ordinary
 *   triggered ability per card. The declaration on its own is a creature you get cheap and keep,
 *   which is a strictly better card than the one printed.
 * - **Embalm, eternalize and bestow.** Each needs characteristics the keyword line does not carry:
 *   the token's type and colour, its base power and toughness, the Aura's bonus. Reading the
 *   reminder text for them would be inventing a card out of a parenthesis.
 * - **Unearth.** Written out as an ability plus `unearthExile()` per card rather than as a field,
 *   so there is no one fragment to emit.
 *
 * Morph and echo *were* in this list, because `keywordWithCost` in `fromCardData.ts` already read
 * them and two readers of one line is two places for them to disagree. They are read here now
 * through that same function, imported: one parse, two call sites.
 *
 * `line` arrives with reminder text already stripped — see `printedRulesLines`.
 */
export function keywordScriptFor(line: string, name: string): Partial<CardScript> | null {
  const text = line.trim();
  const word = text.toLowerCase();

  // ── The keywords whose line is the whole instruction ──────────────────────────────────────────
  if (word === 'cascade') return { triggers: [cascade()] };
  if (word === 'storm') return { triggers: [storm()] };
  if (word === 'extort') return { triggers: [extort()] };
  if (word === 'undying') return { triggers: comesBackWithACounter('undying') };
  if (word === 'persist') return { triggers: comesBackWithACounter('persist') };
  if (word === 'split second') return { splitSecond: true };
  if (word === 'convoke') return { convoke: true };

  // ── The keywords that carry a mana cost ───────────────────────────────────────────────────────
  /*
    Cycling, which is a declaration **and** the ability it declares — `cyclingAbility`'s docblock has
    the argument, and it is D364's rule: "Cycling {2}" with no ability is a card that cannot be
    cycled, and an ability with no declaration has no cost to charge.

    Only plain cycling. "Landcycling {1}{G}", "Basic landcycling" and the typed cyclings search a
    library for a card of a kind this reader would have to invent a filter for, so they are left to
    be reported (D362) rather than read as a draw, which is a different card.
  */
  const cycling = /^cycling\s+((?:\{[^}]*\})+)$/i.exec(text);
  if (cycling !== null) return { abilities: [cyclingAbility(cycling[1]!)] };

  const cost = /^(ward|replicate|cumulative upkeep)\s*[—-]?\s*(\{[^\n]+\})$/i.exec(text);
  if (cost !== null) {
    const which = cost[1]!.toLowerCase();
    const mana = cost[2]!.trim();
    if (which === 'ward') return { triggers: [ward(name, mana)] };
    if (which === 'replicate') return { replicate: { cost: mana }, triggers: [replicate()] };
    return { cumulativeUpkeep: { cost: mana }, triggers: [cumulativeUpkeepTrigger(mana)] };
  }

  // ── The alternative ways to cast a card, which are a cost and nothing else ────────────────────
  /*
    Each of these is one printed cost and one script field, and the hand-written twin of each sets
    exactly that field: `flashback: { cost }` on Think Twice, `madness: { cost }` on Fiery Temper,
    and so on down the list. They are grouped because the shape is identical, and the table in
    `compile.test.ts` names the card that proves each row.

    What they have in common is more than the shape: every one is a **way to cast the card**, so
    reading one adds an option and changes nothing about what the card does. That is what makes
    them safe to read off a card whose resolution is still unread — a Thunderous Wrath with its
    miracle cost and its damage clause both read is a whole card, and the same card with the clause
    unread is flagged for a human to play by hand either way (D362).

    `Kicker` and `Overload` are deliberately **not** in this list, and the difference is exactly
    that. Their payoff is printed on another line — "If this spell was kicked, it deals 4 damage
    instead" — so the declaration alone is an option to pay more for nothing, which is not the card.
    `Overload` also takes an `onResolve` of its own, which no line here can supply.

    **Dash and ninjutsu are in the list but take machinery with them**, which the first six do not,
    and that is D364's rule rather than an exception to it. Six of these keywords are a way to cast
    the card and nothing else: the engine reads the field and offers the cast. The other two name a
    field the engine reads **nowhere** on its own —

      - `dash`'s haste and counter are the engine's, but the return to hand is a delayed ability
        scheduled by finding the card's one `delayed` end-step trigger, and `completeResolution`
        guards that search with `index >= 0`. A dashed creature on a card without `dashReturn()`
        gets haste and **never goes home**.
      - `ninjutsu`'s field is audit-only by its own docblock's admission; the behaviour is an
        activated ability with `AbilityCost.returnsUnblockedAttacker`, and that is the only thing
        `collectLegalActions` can offer a ninjutsu play from.

    So each reads as the declaration *and* what it declares, the way `echo` does below. The pair is
    what the card is; either half alone is a card that does less than it reads.
  */
  const alternative =
    /^(flashback|madness|miracle|foretell|spectacle|buyback|dash|ninjutsu)\s+((?:\{[^}]*\})+)$/i
      .exec(text);
  if (alternative !== null) {
    const mana = alternative[2]!;
    switch (alternative[1]!.toLowerCase()) {
      case 'flashback': return { flashback: { cost: mana } };
      case 'madness': return { madness: { cost: mana } };
      case 'miracle': return { miracle: { cost: mana } };
      case 'foretell': return { foretell: { cost: mana } };
      case 'spectacle': return { spectacle: { cost: mana } };
      case 'dash': return { dash: { cost: mana }, triggers: [dashReturn()] };
      case 'ninjutsu': return { ninjutsu: { cost: mana }, abilities: [ninjutsuAbility(mana)] };
      // The one of the eight that stores its printed line as well, as Capsize does.
      default: return { buyback: { cost: mana, description: text } };
    }
  }

  // ── Morph, megamorph and echo, through the reader the whole-card path uses ─────────────────────
  const costed = keywordWithCost(text);
  if (costed !== null) {
    if (costed.field === 'echo') {
      /*
        The declaration **and** the trigger, which is D364's rule again: `echo` on its own is a
        price the game never asks for, and `echoTrigger` on its own has no cost to charge. Mogg War
        Marshal sets both.
      */
      return { echo: { cost: costed.mana }, triggers: [echoTrigger(costed.mana)] };
    }
    return {
      morph: {
        cost: { mana: costed.mana },
        ...(costed.mega === true ? { mega: true as const } : {}),
      },
    };
  }

  // ── The declarations whose argument is a number, or no argument at all ────────────────────────
  /*
    Three ability words whose **whole instruction is their own reminder text** (D425): exalted
    (CR 702.90a), evolve (CR 702.100a) and battle cry (CR 702.91a). Nothing else is printed on the
    card for them, no number is implied, and each has one card in the pool whose hand-written
    script is now the same factory — so the declaration is the ability and reading it is reading the
    card, which is what D364 asks of a keyword.

    They are the first keywords here that build a *trigger* out of a bare word rather than a field.
    What makes that safe is the same thing that made `echo` safe: the trigger is written once, in a
    factory the hand-written card calls too, so the two readings cannot drift.
  */
  if (word === 'exalted') return { triggers: [exaltedTrigger()] };
  if (word === 'evolve') return { triggers: [evolveTrigger(name)] };
  if (word === 'battle cry') return { triggers: [battleCryTrigger()] };

  if (word === 'delve') return { delve: true };
  if (word === 'affinity for artifacts') return { affinity: 'artifacts' };
  /*
    Rebound is the word alone **plus** the trigger that casts the card again, because the keyword is
    two halves: `rebound` is the replacement that exiles it on resolution and `reboundCast` is the
    upkeep trigger that offers the second cast. Staggershock and Distortion Strike both set both.
  */
  if (word === 'rebound') return { rebound: true, triggers: [reboundCast()] };

  const dredged = /^dredge\s+(\d+)$/i.exec(text);
  if (dredged !== null) return { dredge: { mill: Number(dredged[1]) } };

  /*
    Crew, which is an **ability** rather than a declaration: the Vehicle becomes a creature when
    somebody taps creatures with enough total power to drive it. `animates: true` is the bot rule
    that travels with it — do not press this unless there is an attack or a block to make — and
    Sky Skiff, Renegade Freighter and Consulate Dreadnought all write the same four fields.
  */
  const crewed = /^crew\s+(\d+)$/i.exec(text);
  if (crewed !== null) {
    return {
      abilities: [{
        cost: { crew: Number(crewed[1]) },
        description: text,
        animates: true,
        effect: (c) => pump(c.state, [c.source], c.source, c.controller, { addTypes: ['Creature'] }),
      }],
    };
  }

  // `Suspend 1—{R}`, whose number is the time counters it waits out.
  const suspended = /^suspend\s+(\d+)\s*[—-]\s*((?:\{[^}]*\})+)$/i.exec(text);
  if (suspended !== null) {
    return { suspend: { cost: suspended[2]!, counters: Number(suspended[1]) } };
  }

  /*
    `Escape—{2}{R}{R}, Exile three other cards from your graveyard.` Its count is printed as a
    **word**, which `countFrom` already reads for every other clause in this module, so a card
    printing a digit or a word is one reader either way.
  */
  const escaped =
    /^escape\s*[—-]\s*((?:\{[^}]*\})+),\s*exile\s+([\w]+)\s+other cards? from your graveyard\.?$/i
      .exec(text);
  if (escaped !== null) {
    const exile = countFrom(escaped[2]!);
    if (exile !== null) return { escape: { cost: escaped[1]!, exile } };
  }

  /*
    ── The three that count, and arrive with counters on them ──────────────────────────────────────

    All three set a declaration, an `entersWith` and a trigger, and all three are useless without
    all three. See this function's docblock for the Calciderm that never dies.
  */
  const counted = /^(modular|vanishing|fading)\s+(\d+)$/i.exec(text);
  if (counted !== null) {
    const count = Number(counted[2]);
    switch (counted[1]!.toLowerCase()) {
      case 'modular':
        return {
          modular: { count },
          entersWith: { counter: '+1/+1', amount: count },
          triggers: [modularTrigger(count)],
        };
      case 'vanishing':
        return {
          vanishing: { count },
          entersWith: { counter: TIME, amount: count },
          triggers: [vanishingTrigger(count)],
        };
      default:
        return {
          fading: { count },
          entersWith: { counter: FADE, amount: count },
          triggers: [fadingTrigger(count)],
        };
    }
  }

  return null;
}

/**
 * Oracle text as the readers in this section spell it.
 *
 * Printed card text spells an apostrophe **both ways**, and the pool proves it rather than this
 * being a precaution: 21 of its cards carry an ASCII `'` and 23 a typographic `’`, and the same
 * construct appears in both forms — Unsummon prints "its owner's hand", Journey to Nowhere prints
 * "its owner’s control". Every pattern below is written with the ASCII form, because that is what a
 * person typing a regex writes, so one normalisation at the door is the only place the two
 * spellings have to meet.
 *
 * A reader that forgot would simply never match, which is the failure mode this module is least
 * able to see: an unread line looks exactly like a line nothing was written for. Nothing the
 * compiler reads *today* happens to need it — the cards it reads are all in the ASCII half — so it
 * is pinned by a test on a card printed the other way, which is the corpus #318 will import.
 */
const plain = (text: string): string => text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');

/**
 * Every keyword ability whose *name* this module recognises, which is a longer list than the one
 * `keywordScriptFor` can build.
 *
 * These are rules vocabulary (CR 702), not card text. Writing them down invents nothing: D259's
 * rule — "inventing the text of a real card is worse than leaving the mechanic out" — is about what
 * a card says, and `Flanking` is not a card. Nothing below is given a meaning here; the list says
 * only "this line is a keyword declaration".
 *
 * **Ability words are deliberately absent.** `Magecraft`, `Battalion`, `Metalcraft` and the rest
 * label a whole triggered or static ability printed on the same line — "Magecraft — Whenever you
 * cast or copy an instant or sorcery spell, put two +1/+1 counters on ~". Treating one as a
 * declaration would throw that ability away. `isKeywordDeclaration`'s full-line rule already
 * rejects them, and leaving them out of this list means they are rejected for the right reason
 * rather than by accident.
 */
const KEYWORD_ABILITY_NAMES: readonly string[] = [
  // CR 702, in the rules' own order as far as it goes, with the landwalks spelled out.
  'deathtouch', 'defender', 'double strike', 'enchant', 'equip', 'first strike', 'flash', 'flying',
  'haste', 'hexproof', 'indestructible', 'intimidate', 'landwalk', 'plainswalk', 'islandwalk',
  'swampwalk', 'mountainwalk', 'forestwalk', 'lifelink', 'protection', 'reach', 'shroud', 'trample',
  'vigilance', 'banding', 'rampage', 'cumulative upkeep', 'flanking', 'phasing', 'buyback',
  'shadow', 'cycling', 'echo', 'horsemanship', 'fading', 'kicker', 'multikicker', 'flashback',
  'madness', 'fear', 'morph', 'megamorph', 'amplify', 'provoke', 'storm', 'affinity', 'entwine',
  'modular', 'sunburst', 'bushido', 'soulshift', 'splice', 'offering', 'ninjutsu', 'epic',
  'convoke', 'dredge', 'transmute', 'bloodthirst', 'haunt', 'replicate', 'forecast', 'graft',
  'recover', 'ripple', 'split second', 'suspend', 'vanishing', 'absorb', 'aura swap', 'delve',
  'fortify', 'frenzy', 'gravestorm', 'poisonous', 'transfigure', 'champion', 'changeling', 'evoke',
  'hideaway', 'prowl', 'reinforce', 'conspire', 'persist', 'wither', 'retrace', 'devour', 'exalted',
  'unearth', 'cascade', 'annihilator', 'level up', 'rebound', 'totem armor', 'infect', 'battle cry',
  'living weapon', 'undying', 'miracle', 'soulbond', 'overload', 'scavenge', 'unleash', 'cipher',
  'evolve', 'extort', 'fuse', 'bestow', 'tribute', 'dethrone', 'hidden agenda', 'outlast',
  'prowess', 'dash', 'exploit', 'menace', 'renown', 'awaken', 'devoid', 'ingest', 'myriad',
  'surge', 'skulk', 'emerge', 'escalate', 'melee', 'crew', 'fabricate', 'partner', 'undaunted',
  'improvise', 'aftermath', 'embalm', 'eternalize', 'afflict', 'ascend', 'assist', 'jump-start',
  'mentor', 'afterlife', 'riot', 'spectacle', 'amass', 'companion', 'encore', 'boast', 'foretell',
  'demonstrate', 'daybound', 'nightbound', 'decayed', 'disturb', 'training', 'compleated', 'blitz',
  'casualty', 'enlist', 'read ahead', 'ravenous', 'squad', 'prototype', 'living metal',
  'for mirrodin!', 'toxic', 'backup', 'bargain', 'craft', 'disguise', 'cloak', 'plot', 'saddle',
  'spree', 'freerunning', 'gift', 'offspring', 'impending', 'eerie', 'max speed',
  'start your engines!', 'exhaust', 'harmonize', 'mobilize', 'warp',
];

/**
 * Whether a printed line is a **keyword ability declaration** — `Flying`, `Miracle {R}`,
 * `Enchant creature`, `Suspend 3—{R}` — whether or not anything here can implement it.
 *
 * ## A different question from `keywordScriptFor`, and that is the point
 *
 * `keywordScriptFor` asks *can I build this?* This asks *is this line part of the spell's
 * resolution?*, and only the second question decides whether a spell compiles at all.
 *
 * Before this existed, `spellScriptFor` put every line `keywordScriptFor` could not read into the
 * resolution, and `readResolution` is all-or-nothing by design (see its docblock). So `Miracle {R}`
 * refused Thunderous Wrath, whose other line — "deals 5 damage to any target" — this compiler reads
 * perfectly well. Four spells in the pool were refused by a keyword line rather than by anything
 * about their own effect: Thunderous Wrath, Staggershock, Rift Bolt and Skewer the Critics.
 *
 * ## Why that is safe, which is a claim about the cost of being wrong
 *
 * The all-or-nothing rule exists because a spell that resolves and silently does half of what it
 * prints is worse than one left unread: an unread card is a manual object inside an automated game
 * and says so (D362), a half-read one says nothing. A keyword left unread is not that. Every
 * keyword a spell can carry — miracle, flashback, overload, buyback, replicate, storm, spectacle —
 * is a **cost or a modifier**: a way to cast the card, not a step of resolving it. A Thunderous
 * Wrath that cannot be cast for its miracle cost is still a Thunderous Wrath. So the two kinds of
 * unread line are different kinds of incomplete, `compile.ts` tags them apart, and neither one
 * counts as compiled.
 *
 * ## Why a closed list and not a shape
 *
 * The one test doing most of the work is the full stop: a printed keyword line never ends in one
 * and every sentence of a spell's resolution does. On its own that would also swallow a resolution
 * line that happened to lack a full stop, and *that* mistake is the one this whole module exists to
 * avoid. The list is what stops it — a line is a declaration only if every comma-separated part of
 * it begins with a name the rules define.
 */
export function isKeywordDeclaration(line: string): boolean {
  const text = plain(line).trim();
  if (text === '') return false;
  // `For Mirrodin!` and `Start your engines!` end in an exclamation mark, so only the full stop is
  // disqualifying — which is the only terminator a resolution sentence uses.
  if (text.endsWith('.')) return false;

  const begins = (part: string): boolean => KEYWORD_ABILITY_NAMES.some((kw) =>
    part === kw || part.startsWith(`${kw} `) || part.startsWith(`${kw}{`)
    || part.startsWith(`${kw}—`) || part.startsWith(`${kw}-`));

  const whole = text.toLowerCase();
  // The whole line first, because an argument may itself hold a comma: `Partner with Pir,
  // Imaginative Rascal` is one declaration, and splitting it would reject it.
  if (begins(whole)) return true;
  // Otherwise a list of keywords, which is how a creature prints several: `Flying, first strike`.
  return whole.split(',').every((part) => begins(part.trim()));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The sentence table: a printed trigger line in, a TriggerDef out
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A number as a card prints it, in digits or in words.
 *
 * Both forms appear in one pool and sometimes in one sentence family: "you gain 2 life" is printed
 * in digits and "draw two cards" in words, because Magic writes a count as a word when it is the
 * number of objects and as a digit when it is an amount. So a reader that handled only one would
 * silently drop half of each family.
 */
const WORD_NUMBERS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  /*
    Above ten the words are rare and the pool prints exactly one — Jace Beleren's "mills twenty
    cards", which went unread for want of this row while the two lines around it compiled. The
    others are the round numbers a mill or a token count is printed with; nothing beyond is added,
    because a word nobody prints is a row nobody can test.
  */
  eleven: 11, twelve: 12, thirteen: 13, fifteen: 15, twenty: 20,
};

/** A printed count, or `null` when it is a word this does not know. */
function countFrom(text: string): number | null {
  const word = text.trim().toLowerCase();
  if (/^\d+$/.test(word)) return Number(word);
  return WORD_NUMBERS[word] ?? null;
}

/** The card's own name, as a regex fragment. A name may hold any of `.()'`, so it is escaped. */
const escapeName = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * "enters", and the "enters the battlefield" it was retemplated from.
 *
 * Wizards shortened the phrase in 2024, and the corpus says how completely: of 33,847 cards,
 * **5,898** print "enters," and **47** still print "enters the battlefield" (D426). Every reader in
 * this module was written against the long form, because the engine's own thirteen decks were
 * written by hand from memory and use it — so the single largest miss in all of Magic was a
 * spelling the pool is structurally unable to reveal.
 *
 * Both are accepted everywhere, from one constant, because they are one phrase: a card reprinted
 * with the new wording is not a different card, and two readers for two spellings is two places to
 * forget one.
 */
const ENTERS = 'enters(?: the battlefield)?';

/**
 * A card referring to **itself**, in every spelling Oracle text uses for it.
 *
 * Printed text names the card in the first position — "When Ichor Wellspring enters, draw a card" —
 * and then refers back to it by type: "this creature", "this artifact", "this land". The 2024
 * retemplate made the second form much more common, and the corpus counts 682 cards saying "this
 * creature enters", 82 "this enchantment enters", 54 "this artifact enters" and 29 "this land
 * enters" — about 860 cards whose own trigger the name-only pattern could not match.
 *
 * The third form is a legendary permanent's **short name** — "Bilbo", on a card called *Bilbo,
 * Retired Burglar* — which `shortName` below derives and documents.
 *
 * So every reader that matches the card as a subject or an object matches this instead of the bare
 * name. A non-capturing group, so no reader's capture indices move.
 *
 * It does **not** include "it", which several readers accept separately and deliberately: "it" in
 * printed text refers to whatever the previous clause was about, which is the card on some cards
 * and the target on others, so the readers that allow it say so one at a time.
 */
const selfRef = (name: string): string => {
  const short = shortName(name);
  return `(?:${escapeName(name)}${short === null ? '' : `|${escapeName(short)}`}`
    + '|this (?:creature|artifact|enchantment|permanent|land|planeswalker|battle'
    + '|Vehicle|Equipment|Aura|token|card|spell))';
};

/**
 * The name a card with a title calls itself by: "Bilbo", for "Bilbo, Retired Burglar".
 *
 * Oracle text names a legendary permanent in full the first time and by its short name after —
 * "Whenever Bilbo deals combat damage to a player", on a card called *Bilbo, Retired Burglar*.
 * Neither the full name nor "this creature" matches that, so the line went unread: 924 legal cards
 * use their short name in their own text, and reading it finishes 71 more lines on 70 cards, 11 of
 * which had nothing else left unread (D438).
 *
 * The comma must be followed by a space, which is what separates a title from a thousands
 * separator: *70,000 Light-Years from Home* would otherwise have offered "70" as a name for itself,
 * and so would *Borrowing 100,000 Arrows* ("Borrowing 100") and *Guan Yu's 1,000-Li March*
 * ("Guan Yu's 1") — which is why the space and not "does it contain a letter" is the test. Those
 * three are the only names in 33,847 whose comma is not a title's, and no name with ", " in it has
 * a part before the comma without a letter, so the second check would be a redundant statement of
 * the first: two levers no single break could move (D433).
 *
 * **The alias is matched case-insensitively, like every other reader in this module, and that is a
 * known imprecision rather than an oversight.** Two legal cards in 33,847 print their own short
 * name as an ordinary lowercase word — *Eleven, the Mage* ("your maximum hand size is eleven") and
 * *Storm, Force of Nature* ("has storm") — and both are pinned by a test, because the alias is
 * harmless only as long as no reader matches the clause the collision sits in. JavaScript has no
 * way to switch case-sensitivity off for part of a pattern (`(?-i:…)` is not in V8), so a test that
 * fails the day it starts to matter is the guard available.
 */
function shortName(name: string): string | null {
  const comma = name.indexOf(', ');
  return comma <= 0 ? null : name.slice(0, comma);
}


/**
 * What one printed clause became: the effect, whatever it has to point at or ask, and the
 * script-level flags that belong to a spell built from it.
 *
 * One shape for both the trigger path and the spell path, because the two differ only in the field
 * the effect is stored under — a trigger calls it `effect`, a spell `onResolve` — and a second
 * vocabulary for the second path would be a second place for the readings to drift apart.
 */
interface ReadEffect {
  readonly effect: EffectFn;
  readonly targets?: readonly TargetSpec[];
  readonly decisions?: readonly DecisionSpecOf[];
  /** Bot hints a *spell* of this family carries. The trigger path drops them — see below. */
  readonly spellFlags?: Partial<CardScript>;
  /**
   * Fields an **activated ability** of this family carries, which live on `AbilityDef` and nowhere
   * else — so they cannot travel in `spellFlags`, whose type is `Partial<CardScript>`.
   *
   * One member so far and it is the reason this exists: `untapsOnly`. An ability whose whole effect
   * is an untap can put the board back exactly where it found it, so a bot that did not know would
   * tap and untap for ever — the pathology #124 was opened for. Dropping that flag is therefore not
   * a missing hint but a hang, which is why the untap reader carries it rather than being refused.
   *
   * The spell and trigger paths ignore it, as the ability path ignores `spellFlags`: a field that
   * belongs to one of the three homes a clause has is declared for that home.
   */
  readonly abilityFlags?: Partial<AbilityDef>;
  /**
   * The same clause done **now** rather than owed, for a clause something comes after.
   *
   * One family needs this and the reason is `drawLater`, which owes a card instead of putting it in
   * hand. That is the better primitive for a draw — only a deferred draw can be replaced by a
   * dredge (CR 702.52a) — but `drawLater`'s own docblock bounds it to "a draw that is the last
   * thing the card does", because nothing after a deferred draw can see what it drew. "Draw a card.
   * Discard a card." would discard before the card arrived.
   *
   * In a composition that is a fact about **position**, not about the clause, and the clause cannot
   * know its own position. So it offers both readings and `composeEffects` picks: the deferred one
   * for the last clause, this one for every other. Nothing is lost either way — which is better
   * than the first version of this guard, which refused the whole card instead and so turned a
   * dependency hazard into a coverage hole.
   */
  readonly immediate?: EffectFn;
  /**
   * What the card does **before anybody is asked anything** — `CardScript.beforeDecisions`.
   *
   * One family needs it and Faithless Looting is the family: "Draw two cards, then discard two
   * cards". The cards it offers to discard have to include the two it just drew, so the draw
   * cannot be part of the resolution that runs *after* the question — it has to happen before the
   * question is planned.
   *
   * Only a **spell-shape** reader sets this, never a clause, and `composeEffects` deliberately
   * does not propagate it. That is not an omission: a clause cannot know whether a question comes
   * after it, so a `beforeDecisions` surviving a composition would be a draw moved in front of
   * somebody else's question by accident. Keeping it to the readers that see the whole resolution
   * makes that impossible by construction, which is the same argument that keeps X on the spell
   * path (D399).
   */
  readonly beforeDecisions?: EffectFn;
  /**
   * "The question **is** the whole effect" — so there is nothing left to run afterwards.
   *
   * One family: a clause that is only a decision. `Scry 2` asks the player which cards to put on
   * the bottom and the engine applies the answer itself, so the clause's own `effect` is the
   * identity, and its reader's comment has said so from the start.
   *
   * `ReadEffect.effect` is required, because almost every clause has one — so this is the flag that
   * lets an assembly know the function it was handed does nothing. `CardScript.onResolve` and
   * `AbilityDef.effect` are both optional, so those two omit the field entirely and come out
   * **identical to the hand-written card**, which is what `compiled-vs-written.test.ts` compares.
   * `TriggerDef.effect` is required, so a trigger whose whole content is a question keeps the
   * identity: said here rather than left as a surprise.
   */
  readonly appliesNothing?: true;
}

/**
 * How many a printed bounce quantifier asks for, and whether it excludes the permanent asking.
 *
 * "A permanent you control" and "another permanent you control" are one word apart and a completely
 * different card: Kor Skyfisher may return **itself**, which is the whole reason it is a 2/3 for two,
 * and Invasive Species may not. So the quantifier is read from a table rather than assumed, and a
 * spelling that is not in the table leaves the line unread.
 *
 * `all` is "each other", which asks nobody anything: Denizen of the Deep returns the rest of your
 * board whether you like it or not, so there is no question to put and `min`/`max` are not consulted.
 */
const BOUNCE_COUNTS: Readonly<Record<string, {
  readonly min: number;
  readonly max: number;
  readonly another?: true;
  readonly all?: true;
}>> = {
  a: { min: 1, max: 1 },
  an: { min: 1, max: 1 },
  another: { min: 1, max: 1, another: true },
  two: { min: 2, max: 2 },
  three: { min: 3, max: 3 },
  'up to one': { min: 0, max: 1 },
  'up to two': { min: 0, max: 2 },
  'up to three': { min: 0, max: 3 },
  'up to one other': { min: 0, max: 1, another: true },
  'up to two other': { min: 0, max: 2, another: true },
  'each other': { min: 0, max: 0, all: true, another: true },
};

/**
 * A printed permanent description, as a test on one candidate already in a battlefield zone.
 *
 * "A land", "a nonland permanent", "a red or green creature", "an enchantment" — the adjectives the
 * corpus actually prints in front of the forty-eight cards this was built for, and nothing wider.
 * The noun is read last and the words before it are qualifiers, which is the grammar printed text
 * uses and the reason a list of whole phrases was not written instead: "green or white creature" and
 * "white or blue creature" are the same two rules in a different order.
 *
 * **Everything is read live** (CR 109.2), which is the same discipline `permanentFilter` keeps and
 * the defect #319 recorded in five hand-written filters: an animated Mutavault is a creature for
 * "return a creature you control" and a land that has become a creature is still a land for "a
 * nonland permanent". Reading the printed type line instead would disagree with the board a player
 * is looking at.
 *
 * A colour list is a disjunction — "a red or green creature" is a creature that is red **or** green,
 * not one that is both — and a word that is neither a colour nor `nonland` refuses the whole
 * description rather than being dropped, so an unrecognised adjective leaves the line unread
 * instead of widening what the card may return.
 */
const permanentDescribed = (
  phrase: string,
): ((state: GameState, id: string) => boolean) | null => {
  const words = phrase.trim().toLowerCase().split(/\s+/).filter((word) => word !== 'or');
  const noun = (words.pop() ?? '').replace(/s$/, '');
  /*
    `PERMANENT_TYPES` is the list that was already here for printed board scopes (CR 205.2a), and
    using it rather than a second one is the point: D465 shipped a five-name copy of it that was
    missing `battle`, so "return a battle you control to its owner's hand" would not have read. Two
    lists of one thing is the shape this file keeps removing (D441, D438).
  */
  if (noun !== 'permanent' && !PERMANENT_TYPES.includes(noun)) return null;
  const type = noun === 'permanent' ? null : noun;
  const colours: Color[] = [];
  let nonland = false;
  for (const word of words) {
    if (word === 'nonland') { nonland = true; continue; }
    const colour = COLOUR_WORDS[word];
    if (colour === undefined) return null;
    colours.push(colour);
  }
  return (state: GameState, id: string): boolean => {
    const inst = state.instances[id];
    if (inst === undefined) return false;
    const live = characteristicsOf(state, inst);
    if (type !== null && !hasType(live.typeLine, type)) return false;
    if (nonland && hasType(live.typeLine, 'land')) return false;
    if (colours.length > 0 && !colours.some((colour) => live.colors.includes(colour))) return false;
    return true;
  };
};

/**
 * What one **untargeted** effect clause does, as the fields a `TriggerDef` needs for it.
 *
 * The second stage of the compiler (#317, D366), and deliberately only the untargeted half. A
 * clause like "it deals 4 damage to target creature" needs a target spec as well as an effect, and
 * a target spec is its own sub-vocabulary ("target creature", "target creature an opponent
 * controls", "another target nonland permanent", "any target") with its own failure modes. Reading
 * those is the next increment; reading them *badly* would aim real removal at the wrong thing,
 * which is worse than not reading them at all.
 *
 * So the rule for this stage is: the clause has to determine the effect **completely**, with
 * nothing chosen by anybody. Every reader below is a clause whose text names its own numbers.
 *
 * ## Why `drawLater` and not `draw`
 *
 * `drawLater`'s own docblock states the constraint: it is "only for a draw that is the last thing
 * the card does", because an effect that reads what it drew in the same breath has finished by the
 * time the deferred card arrives. It adds the word "the compiler cannot tell the two apart" — and
 * that is true of a compiler reading a *sentence*, but not of this one, which matches a clause only
 * when the clause is the draw and **nothing else**. A clause that is exactly "draw two cards"
 * cannot read what it drew, so the deferral is safe by construction, and it is the better of the
 * two because only a deferred draw can be replaced by a dredge (CR 702.52a).
 *
 * `clause` arrives with its trailing full stop removed and trimmed.
 */
function untargetedEffect(clause: string, name: string): ReadEffect | null {
  const text = clause.trim();

  /*
    "Investigate", which is one word for a whole sentence: create a colourless Clue artifact token
    with "{2}, Sacrifice this artifact: Draw a card" (CR 701.33a). The token is the engine's own
    `CLUE_TOKEN` — a definition D243 wrote and tested, not a shape invented here — so the reading is
    a call rather than a transcription, which is the only safe way to read a word that stands for
    text the card does not print.
  */
  if (/^investigate$/i.test(text)) {
    return { effect: (c) => createToken(c.state, c.controller, CLUE_TOKEN) };
  }

  /*
    Mana out of a trigger: "Add {R}{G}" — Burning-Tree Emissary, whose whole ability this is.

    The **regex is the validation**, and deliberately so: it admits only the six symbols
    `addToPool` can take, so `{E}` is not read as mana at all and `{2}` — generic mana, which is not
    a thing a pool can hold — refuses the clause. Running `parseManaCost` over a string this pattern
    has already matched would be a check that cannot fail, which this file has caught itself writing
    three times (D386, D394, D398).
  */
  const added = /^add ((?:\{[WUBRGC]\})+)$/i.exec(text);
  if (added !== null) {
    const symbols = [...added[1]!.toUpperCase().matchAll(/\{([WUBRGC])\}/g)].map((m) => m[1]!);
    return {
      effect: (c) => symbols.reduce(
        (state, symbol) => addToPool(state, c.controller, symbol as Parameters<typeof addToPool>[2], 1),
        c.state,
      ),
      /*
        `makesMana` is the bot's hint for a **spell** whose whole effect is mana: without it the
        search casts a Dark Ritual into nothing, because the mana is in the pool and the position
        after the cast looks no better. It is `spellFlags` rather than a merge, which is what makes
        it correct on both cards that print this clause: Dark Ritual's resolution applies it, and
        Burning-Tree Emissary's ETB trigger drops it — which is that card's own rule, measured both
        ways on 192 games (with the flag `cast-counts` read 46%, without it 101%, because a 2/2 for
        two is worth casting on its own).
      */
      spellFlags: { makesMana: true },
    };
  }

  const gain = /^you gain ([\w]+) life$/i.exec(text);
  if (gain !== null) {
    const n = countFrom(gain[1]!);
    if (n !== null) return { effect: (c) => gainLife(c.state, c.controller, n) };
  }

  const lose = /^you lose ([\w]+) life$/i.exec(text);
  if (lose !== null) {
    const n = countFrom(lose[1]!);
    if (n !== null) return { effect: (c) => loseLife(c.state, c.controller, n) };
  }

  /*
    A clause whose number is announced in its own tail: "You gain X life and draw X cards, where X is
    the number of lands you control" — Nissa's ultimate, and the one place in the pool where the same
    count is spent twice in one sentence.

    The tail is read with `boardCount`, as the token clause's is (`tokenEffect` strips the same
    `, where X is …` for its own count). Two call sites rather than one shared stripper, because the
    bodies in front of them are different grammars and the only thing they share is five words; if a
    third appears, that is the moment to lift it.

    The order is the printed order and the hand-written card's: gain, then draw. It matters on an
    empty library — a player who gains the life and then cannot draw has still gained the life.
  */
  const announced = /^(.*?),\s*where X is (.+)$/i.exec(text);
  if (announced !== null) {
    const counted = boardCount(announced[2]!, name);
    if (counted !== null && /^you gain X life and draw X cards$/i.test(announced[1]!.trim())) {
      return {
        effect: (c) => {
          const n = counted(c);
          return draw(gainLife(c.state, c.controller, n), c.controller, n);
        },
      };
    }
  }

  /*
    The drain, which is **one** effect and not two clauses.

    "Each opponent loses 1 life and you gain 1 life" is joined by "and", and `clausesOf`
    deliberately does not split on that word — "gets +2/+2 and gains trample" is one effect too, and
    a splitter that broke on "and" would cut that in half. So the drain is read whole, in the order
    the card prints: the life is lost first and gained second, which is what all three hand-written
    drains do (Zulaport Cutthroat, Cruel Celebrant, Blood Artist).

    The two numbers are read separately rather than assumed equal. Every drain in this pool prints
    the same number twice, and reading one of them twice would be the compiler asserting a symmetry
    the text does not promise — "each opponent loses 2 life and you gain 1 life" is a card somebody
    could print.
  */
  /*
    The drain whose amount is a board count: "Each opponent loses 1 life for each creature card in
    your graveyard" — Lotleth Giant, whose whole card is that one line.

    Read before the flat drain below because its prefix is the same sentence; the tail is what makes
    it a different card, and a reader that matched the flat form first would drain one life per
    opponent and ignore the graveyard entirely. That is a card that works and is wrong, which is
    this file's commonest failure shape.
  */
  const perThing = /^each opponent loses (\d+) life for each (.+)$/i.exec(text);
  if (perThing !== null) {
    const each = Number(perThing[1]);
    const counted = forEachCount(perThing[2]!, name);
    if (counted !== null) {
      /*
        No zero guard, deliberately: `loseLife` refuses a non-positive amount and returns the state
        it was handed, so an empty graveyard already drains nothing. A guard here would be a branch
        no test could tell from its absence, which is the shape of a check that cannot fail — and
        the hand-written Giant does not have one either, so the two read identically at zero.
      */
      return {
        effect: (c) => {
          const n = each * counted(c);
          return opponentsOf(c.state, c.controller)
            .reduce((state, seat) => loseLife(state, seat, n), c.state);
        },
      };
    }
  }

  const drained = /^each opponent loses (\d+) life(?: and you gain (\d+) life)?$/i.exec(text);
  if (drained !== null) {
    const lost = Number(drained[1]);
    const gained = drained[2] === undefined ? 0 : Number(drained[2]);
    return {
      effect: (c) => {
        const after = opponentsOf(c.state, c.controller)
          .reduce((state, seat) => loseLife(state, seat, lost), c.state);
        return gained === 0 ? after : gainLife(after, c.controller, gained);
      },
    };
  }

  /*
    The edict: everybody gives up a creature, and each of them chooses which.

    A question rather than an effect, like the discard — and `who: 'each-player'` expands into one
    question each, asked in turn order starting from the active player (CR 101.4), which is
    sometimes the whole card: the second player to sacrifice has seen what the first gave up.
    `CardsDecisionSpec.who` says so, and that ordering is the reason this cannot be written as a
    reduce over seats inside the effect.

    "Each player" includes you and "each opponent" does not, which is the difference between a
    Fleshbag Marauder and an Eldest Reborn — one line of this reader and a completely different
    card, so the two spellings are captured rather than conflated.
  */
  const edict = /^each (player|opponent) sacrifices a creature$/i.exec(text);
  if (edict !== null) {
    const who = edict[1]!.toLowerCase() === 'player' ? 'each-player' as const : 'each-opponent' as const;
    return {
      decisions: [{
        who,
        from: 'battlefield',
        prompt: 'Sacrifice a creature',
        min: 1,
        max: 1,
        filter: (state: GameState, id: string) => {
          const inst = state.instances[id];
          return inst !== undefined && characteristicsOf(state, inst).isCreature;
        },
      }],
      effect: (c) => c.decisions.reduce((state, answer) => moveToGraveyard(state, answer.ids), c.state),
    };
  }

  /*
    "Return a land you control to its owner's hand" — a bounce the controller **chooses**, which is
    the other half of a family this compiler could only read one member of.

    `targetedEffect` has read `return target <permanent> to its owner's hand` since D366. What it
    cannot read is the far commoner printing, where nothing is targeted and the controller simply
    picks something of their own as the permanent resolves: the Karoo land cycle (Azorius Chancery
    and its nine siblings), Kor Skyfisher, Whitemane Lion, Roaring Primadox, Esperzoa. Measured by
    `phrase-gap.mjs` over 31,654 legal cards, **48 are one unread line from a finished script and
    that line is this one** — twelve of them lands, which is a kind of card the pool has never had.

    ## Why it is a question and not a target

    A target is chosen when the ability goes on the **stack**, is visible to every opponent, and can
    be made illegal in between. This is chosen as the ability **resolves**, from whatever the board
    looks like then, which is what the print means and also what makes Kor Skyfisher playable: you
    pick after seeing whether your opponent answered something. `CardsDecisionSpec` with
    `from: 'battlefield'` is exactly that question, and `DecisionZone` already says that zone is the
    **chooser's own** battlefield — so "you control" is enforced by the zone rather than by a filter
    that could disagree with it.

    ## Mandatory, and doing as much as it can

    `min: 1` is not a suggestion: Kor Skyfisher with nothing else on your board returns **itself**.
    `decisionBounds` clamps both bounds to what the chooser actually has, so a board with no legal
    candidate answers empty and nothing moves — CR 608.2, an ability does as much as it can and no
    more — and a board with exactly one answers itself without putting a one-button prompt on
    anybody's screen.

    ## The one spec that is a function, and the four cards that costs

    "Another permanent you control" has to exclude the permanent whose ability this is, and
    `CardsDecisionSpec.filter` is `(state, id, chooser)` — it is not handed the source. `DecisionSpecOf`
    is, so the `another` spellings are written as the thunk that type exists for (cumulative upkeep
    was the first) and the rest stay literals.

    That split is **not** tidiness, and the cost is named rather than hidden: the bare-`may` reader's
    `gatable` refuses a spec that is a function, because `askOnlyIfChosen` would have to be added to
    whatever the function returns and that cannot be checked where the decision is made. So
    `you may return another permanent you control…` — Ambrosia Whiteheart, Aviary Mechanic, Loyal
    Gryff, Rescuer Chwinga — stays unread, while the same phrase without the "may" is read. Four
    cards, recorded as task #337 rather than bought with a guess, and keeping the non-`another`
    spellings as literals is what lets the other `you may return…` cards (Tazeem Raptor) through.
  */
  const ownBounce = /^return (a|an|another|each other|up to one other|up to two other|up to one|up to two|up to three|two|three) (.+?) you control to (?:its|their) owner's hand$/i
    .exec(text);
  if (ownBounce !== null) {
    const counts = BOUNCE_COUNTS[ownBounce[1]!.toLowerCase()];
    const describes = permanentDescribed(ownBounce[2]!);
    if (counts !== undefined && describes !== null) {
      // "Each other creature you control" asks nothing: every one of them goes back.
      if (counts.all === true) {
        return {
          effect: (c) => moveToHand(
            c.state,
            listAt(c.state, zoneKey(c.controller, 'battlefield'))
              .filter((id) => id !== c.source && describes(c.state, id)),
          ),
        };
      }
      const prompt = `Return ${ownBounce[1]!.toLowerCase()} ${ownBounce[2]!.trim()}`
        + ' you control to its owner\'s hand';
      const shared = {
        who: 'controller' as const,
        from: 'battlefield' as const,
        prompt,
        min: counts.min,
        max: counts.max,
      };
      return {
        decisions: [counts.another === true
          // The thunk, for the one qualifier that needs the source. See the docblock above.
          ? (_state: GameState, source: string): CardsDecisionSpec => ({
            ...shared,
            filter: (state: GameState, id: string) => id !== source && describes(state, id),
          })
          : { ...shared, filter: (state: GameState, id: string) => describes(state, id) }],
        effect: (c) => moveToHand(c.state, chosenCards(c)),
      };
    }
  }


  /*
    "Sacrifice a creature" — the sacrifice the **controller chooses**, which is the third family in
    this row and the one the measurement had to be split to find.

    `phrase-gap.mjs` put `sacrifice <permanent>` at **81 cards** one unread line from finished, and
    that number is three readers rather than one. Classified by sub-shape:

    - **44** print `sacrifice it unless you <cost>` — a demanded price with a consequence, which is
      echo's shape (#196) and needs a cost vocabulary of its own (the Karoo lands' bounce, a
      discard, a mana payment, a second sacrifice). Its own increment.
    - **19** are a *trigger*: `Whenever you sacrifice a <thing>, …`. The substitution rewrote the
      prologue, not an effect — an event kind this engine does not raise, and its own increment too.
    - **16** are this one: the effect, where the printed sentence instructs and the controller picks.

    So the row was never one phrase, and reading it as one would have bought a third of what the
    number promised. Recorded because the same mistake is what `phrase-gap.mjs` itself exists to stop
    (its docblock lists three), and a row can be a family even when the phrase is identical.

    ## Mandatory, and the clamp is CR 608.2

    A sacrifice is not optional and not a target: "sacrifice a creature" with one creature sacrifices
    it, with none does nothing, and with several asks. `min` and `max` are both the printed count and
    `decisionBounds` clamps them to what the chooser actually controls, which is the same reading the
    bounce above leans on and the rule that a player instructed to sacrifice more permanents than
    they control sacrifices as many as they can.

    `from: 'battlefield'` is the chooser's **own** battlefield, so "you control" needs no filter and
    cannot disagree with one (CR 701.17a: a player can only sacrifice a permanent they control).
    The suffix is read and discarded for exactly that reason.

    `BOUNCE_COUNTS` is reused rather than copied: the two families print the same quantifiers and two
    lists of one thing is the shape this file keeps removing (D441, D438, D465).
  */
  const sweepingSacrifice = /^sacrifice (?:all|each) (.+?) you control$/i.exec(text);
  if (sweepingSacrifice !== null) {
    const describes = permanentDescribed(sweepingSacrifice[1]!);
    if (describes !== null) {
      return {
        effect: (c) => moveToGraveyard(
          c.state,
          listAt(c.state, zoneKey(c.controller, 'battlefield'))
            .filter((id) => describes(c.state, id)),
        ),
      };
    }
  }

  /*
    "Sacrifice a creature other than Demonic Taskmaster" is `another` wearing the card's own name,
    which is how the print says it when the permanent is not a creature of the same kind. Read as
    the same exclusion rather than as a second qualifier, and only when the name is **this card's**:
    "other than" naming anything else is a restriction this reader cannot express, so it refuses.
  */
  const sacrificed = /^sacrifice (a|an|another|two|three|up to two|up to three) (.+?)$/i.exec(text);
  if (sacrificed !== null) {
    const selfExcluded = new RegExp(`^(.+?) other than ${escapeName(name)}$`, 'i')
      .exec(sacrificed[2]!.trim());
    const phrase = (selfExcluded === null ? sacrificed[2]! : selfExcluded[1]!)
      .trim().replace(/ you control$/i, '');
    const counts = BOUNCE_COUNTS[sacrificed[1]!.toLowerCase()];
    const describes = permanentDescribed(phrase);
    const another = counts?.another === true || selfExcluded !== null;
    if (counts !== undefined && counts.all !== true && describes !== null) {
      const shared = {
        who: 'controller' as const,
        from: 'battlefield' as const,
        prompt: `Sacrifice ${sacrificed[1]!.toLowerCase()} ${phrase}`,
        min: counts.min,
        max: counts.max,
      };
      return {
        decisions: [another
          // The thunk, for the same reason the bounce needs one: a filter is not handed the source.
          ? (_state: GameState, source: string): CardsDecisionSpec => ({
            ...shared,
            filter: (state: GameState, id: string) => id !== source && describes(state, id),
          })
          : { ...shared, filter: (state: GameState, id: string) => describes(state, id) }],
        effect: (c) => moveToGraveyard(c.state, chosenCards(c)),
      };
    }
  }

  /*
    "Each player draws a card" — symmetrical, the opponent included, which is the card: Jace
    Beleren's +2 is not simply a better Divination. Eliminated seats are skipped, as the
    hand-written ability skips them, and the draw is immediate rather than owed because a draw for
    somebody who is not the controller cannot be put on `drawsOwed` for them to take later.
  */
  const roundTheTable = /^each player draws ([\w]+) cards?$/i.exec(text);
  if (roundTheTable !== null) {
    const n = countFrom(roundTheTable[1]!);
    if (n !== null) {
      return {
        effect: (c) => c.state.seats.reduce(
          (state, seat) => (seat.eliminated ? state : draw(state, seat.index, n)),
          c.state,
        ),
      };
    }
  }

  // "You draw a card" and "Draw a card" are the same sentence; a planeswalker spells it the long way.
  const drawn = /^(?:you )?draw ([\w]+) cards?$/i.exec(text);
  if (drawn !== null) {
    const n = countFrom(drawn[1]!);
    if (n !== null) {
      return {
        effect: (c) => drawLater(c.state, c.controller, n),
        immediate: (c) => draw(c.state, c.controller, n),
      };
    }
  }

  /*
    Regenerate the team: Golgari Charm's third mode, and the clause that card was called
    unscriptable for until this engine had regeneration shields.
  */
  if (/^regenerate each creature you control$/i.test(text)) {
    return {
      effect: (c) => creaturesControlledBy(c.state, c.controller)
        .reduce((state, id) => regenerate(state, id), c.state),
    };
  }

  /*
    The sweep that shrinks instead of destroying: "All creatures get -1/-1 until end of turn".

    `pumpAll` and not `pumpTeam`, because "all creatures" includes the caster's own — which is what
    makes Golgari Charm's first mode a decision rather than a free sweep, and its own comment says
    so. The sign is read rather than assumed: the same sentence with a plus is a mass pump, and
    `sizeBonus` handles either, refusing only `0/0`.
  */
  const shrunk = /^all creatures get (-|\+)(\d+)\/(-|\+)(\d+) until end of turn$/i.exec(text);
  if (shrunk !== null) {
    const bonus = sizeBonus(
      Number(`${shrunk[1]}${shrunk[2]}`), Number(`${shrunk[3]}${shrunk[4]}`),
    );
    if (bonus !== null) {
      return { effect: (c) => pumpAll(c.state, c.source, c.controller, bonus) };
    }
  }

  /*
    Destroy all creatures: the sweeper, and the first clause here that answers a board rather than a
    permanent.

    No target, which is why it belongs with the untargeted sentences rather than beside "destroy
    target creature" — and no `removesACreature` hint either, deliberately. That flag means "do not
    cast this with nothing of theirs to point at", advice about a spell that needs a target; a wrath
    needs none, and Day of Judgment, the pool's ground truth, sets no flag at all. The reason it
    needs none is worth stating: casting a wrath is right when you are behind and catastrophic when
    you are ahead, which is not a fact a flag can carry — it is the position, and the bot's search
    sees it by playing the wrath out.

    The board is read once, before anything dies, and `characteristicsOf` decides what a creature is
    so a crewed Vehicle is swept with the rest (CR 613).
  */
  if (/^destroy all creatures$/i.test(text)) {
    return {
      effect: (c) => {
        let state = c.state;
        for (const id of battlefield(state, (cardId) => {
          const inst = state.instances[cardId];
          return inst !== undefined && characteristicsOf(state, inst).isCreature;
        })) {
          state = destroy(state, id);
        }
        return state;
      },
    };
  }

  /*
    A counter on every permanent a printed **scope** names: "Put a +1/+1 counter on each other
    Dragon creature you control", and the same sentence with `-1/-1` pointed across the table.

    The scope is the new vocabulary and `boardScope` is where it is read; this clause is only the
    counter. **Two keys and no others.** `+1/+1` and `-1/-1` are the two the engine's state-based
    actions know about — they cancel in pairs (CR 704.5q, D269) and `characteristicsOf` reads them
    as size — and they are the two every printed card of this shape uses. A "+2/+2 counter" would be
    a key nothing reads, so that line stays unread rather than compiling to counters that sit on a
    creature and change nothing: D362's badge beats a card that resolves and does nothing.

    The list of permanents is built once, before any counter lands, for the reason `destroy all
    creatures` gives: the clause acts on the board it saw.
  */
  const eachCounter = /^put a (\+1\/\+1|-1\/-1) counter on each (.+)$/i.exec(text);
  if (eachCounter !== null) {
    const kind = eachCounter[1]!.startsWith('+') ? '+1/+1' : '-1/-1';
    const scope = boardScope(eachCounter[2]!);
    if (scope !== null) {
      return {
        effect: (c) => scope.ids(c).reduce((state, id) => addCounters(state, id, kind, 1), c.state),
      };
    }
  }

  /*
    A Fog. `preventCombatDamage` is the primitive and `preventsDamage` is the bot hint that goes
    with it — nothing in the engine reads the flag, the bot does, so a Fog without it is a card
    that works and is cast into an empty board. Fog and Holy Day are the same two fields.
  */
  if (/^prevent all combat damage that would be dealt this turn$/i.test(text)) {
    return {
      effect: (c) => preventCombatDamage(c.state, c.source, c.controller),
      spellFlags: { preventsDamage: true },
    };
  }

  /*
    The two library searches the pool writes, which are one `searchYourLibrary` decision and one
    thing done with what it found. The printed "then shuffle" is not read as a step: shuffling is
    what `searchYourLibrary` does when the search ends, so a reader that emitted a shuffle of its
    own would shuffle twice.

    Narrow on purpose. "Search your library for a card" is Diabolic Tutor and takes no filter at
    all; "a basic land card ... onto the battlefield tapped" is Rampant Growth and takes
    `isBasicLand`. A tutor for some *other* kind of card needs a filter this module cannot build
    from the phrase, and a search that puts the card anywhere else is a different card — both are
    refused rather than approximated.
  */
  if (/^search your library for a card and put that card into your hand$/i.test(text)) {
    return {
      decisions: [searchYourLibrary('Search your library for a card')],
      effect: (c) => moveToHand(c.state, chosenCards(c)),
    };
  }
  {
    const search = searchClause(text, name);
    if (search !== null) return search;
  }
  /*
    Surveil N, which is a question and no effect at all — the engine puts the chosen cards in the
    graveyard, exactly as it bottoms a scry's. See `surveil`.

    The count is bounded at a sane maximum rather than taken from the text unchecked: the largest
    printed surveil is well inside it, and a line reading "surveil 40" would be a corrupt row
    rather than a card.
  */
  {
    const surveilled = /^surveil (\d+)$/i.exec(text.trim());
    if (surveilled !== null) {
      const count = Number(surveilled[1]);
      if (count >= 1 && count <= 20) {
        return { decisions: [surveil(count)], effect: (c) => c.state, appliesNothing: true };
      }
    }
  }

  /*
    The `shuffle` that `clausesOf` leaves behind, and the reason both searches above stop before it.

    A search prints ", then shuffle", and ", then " is exactly where `clausesOf` cuts — so the line
    arrives here as two clauses and the second is the bare word. It reads as the identity because
    `searchYourLibrary` already shuffles when the search ends: a reader that shuffled again would
    shuffle twice, and the one thing a library must not be is shuffled an unknown number of times
    when a test is comparing two boards.

    The bare word and nothing else. "Shuffle your library" names an object and is a step of its own
    on the cards that print it; this clause only ever appears as the tail of a search.
  */
  if (/^shuffle$/i.test(text)) return { effect: (c) => c.state };

  /*
    The same word with the condition newer cards print in front of it: "If you search your library
    this way, shuffle." It reads as the identity for the clause above's reason — `searchYourLibrary`
    shuffles when the search ends — and the condition needs no reading either, because the only
    thing it guards is the shuffle that already happened.

    31 cards print it, and all of them print a search on the line before. A line that printed this
    without a search would shuffle nothing, which is also what this does.
  */
  if (/^if you search your library this way, shuffle$/i.test(text)) {
    return { effect: (c) => c.state };
  }

  /*
    A pump on the whole team, which is `pumpTeam` and not `pump` over a list: the scope is
    "creatures you control" as a continuous effect, so a creature that arrives later in the turn is
    **not** included and one that leaves does not take the bonus with it. Master of Pearls' turn-up
    and the pool's team pumps all call it.

    "Creatures you control get +1/+1" with no duration is a *static* and is read elsewhere
    (`staticFromLine`); this one ends at end of turn, which is what makes it an effect.
  */
  /*
    The team pump, and the hint it was missing.

    `expiresAtEndOfTurn` is "hold this for the combat", and both hand-written cards of this shape set
    it — Inspired Charge and Overrun. The compiled reading did not, so a compiled Inspired Charge was
    a card that *works* and gets cast in a main phase with nothing to attack with: exactly D364's
    trap, in the one clause family whose targeted twin already carried the flag.

    The grant rides with the size in one `PumpOptions`, as it does on the targeted pump and for the
    same reason: Overrun's trample and its +3/+3 are one continuous effect, and two would expire
    independently.
  */
  const team = /^creatures you control get \+(\d+)\/\+(\d+)(?: and gain ([a-z][a-z' ]*?))? until end of turn$/i
    .exec(text);
  if (team !== null) {
    const bonus = pumpAndGrant(Number(team[1]), Number(team[2]), team[3]);
    if (bonus !== null) {
      return {
        effect: (c) => pumpTeam(c.state, c.source, c.controller, bonus),
        spellFlags: { expiresAtEndOfTurn: true },
      };
    }
  }

  if (/^you become the monarch$/i.test(text)) {
    return { effect: (c) => becomeMonarch(c.state, c.controller) };
  }

  const scried = /^scry ([\w]+)$/i.exec(text);
  if (scried !== null) {
    const n = countFrom(scried[1]!);
    // The question is the whole effect, which is why the effect itself is the identity — the same
    // shape the hand-written scrying cards use. `appliesNothing` is how an assembly knows that, so
    // a spell or ability whose resolution is only this comes out with no effect field at all.
    if (n !== null) {
      return { decisions: [scry(n)], effect: (c) => c.state, appliesNothing: true };
    }
  }

  /*
    Energy, printed as one `{E}` per point (CR 107.4f). Counted rather than parsed as a number
    because that is how the card prints it: "you get {E}{E}{E}" is three, and there is no digit
    anywhere in the sentence.
  */
  const energy = /^you get ((?:\{E\}\s*)+)$/i.exec(text);
  if (energy !== null) {
    const n = (energy[1]!.match(/\{E\}/g) ?? []).length;
    if (n > 0) return { effect: (c) => addEnergy(c.state, c.controller, n) };
  }

  // A token: the one family whose characteristics are entirely in the sentence. See `tokenEffect`.
  const token = tokenEffect(text, name);
  if (token !== null) return token;

  /*
    The discard, in every person it is printed about — and the largest concentrated family the
    compiler has left.

    Measured by `phrase-gap.mjs`' method (substitute the whole family in place, then ask whether the
    **whole line** reads): the discard appears on 795 one-line-short cards and **finishes 114**, which
    is more than the bounce family D465 and D466 split between them. The shapes, finishes/appears:

    | | |
    | --- | --- |
    | `you discard a card` | 48 / 348 |
    | `each opponent discards a card` | 14 / 30 |
    | `each player discards a card` | 6 / 11 |
    | `you discard three cards` | 3 / 5 |
    | the `at random` variants | ~6 |
    | `you discard two cards` | 1 / 25 |

    plus a tail of conjunctions ("and you gain 1 life", "and you draw a card") that come free through
    `conjoinedEffect` once the clause itself reads.

    ## The player chooses, except where the card says otherwise

    `CardsDecisionSpec.who`'s own docblock names Mind Rot for this and says getting it wrong "would
    make Mind Rot a very different card": the **discarding** player picks, not the caster. So this is
    a question, and `discardAtRandom` is reached **only** where the printed words say "at random".
    A compiler that took the random primitive because it was simpler would build Ravenous Rats and
    call it Mind Rot — a card that works and is wrong, which is the D362 failure rather than the
    unread line.

    `min` and `max` are both N and `decisionBounds` clamps to the hand, so a player holding one card
    discards one and a player holding none is never asked. The prompt echoes the printed count **and
    its noun** rather than being rebuilt from the number, which keeps "Discard a card" singular.

    "Discard your hand" asks nothing: every card goes, so there is no question to put and it is an
    effect. 20 legal cards print it.

    ## What is not here

    **`target player discards N cards` already reads** — in `targetedEffect`, since D366 — and
    `target opponent …` does **not**, because `targetSpecFrom` has no spec for "target opponent" at
    all (`target opponent loses 2 life` does not read either). That is worth more than this family
    and is its own increment rather than a rider: one spec lifts the discard, the life loss and the
    mill together.

    **`that player discards a card`** (12 cards, plus 6 at random) needs the event's player, which
    `eventRelativeEffect` reads as `c.actor` and `CardsDecisionSpec.who` cannot name — there is no
    `'actor'` among its four values. An engine change, so it waits for one.

    **`discard a creature card`** (17) and `discard a land card` (8) finish **nothing**: every one is
    the opener of a `you may X. If you do, Y` whose construct is also unread, so they arrive with that
    reader and not this one.

    ## The limitation this shares with the edict, stated rather than discovered

    The round-the-table reading sums **every** answer in the context, which is the idiom the
    `each player sacrifices a creature` reader above already uses, and for the same reason: a
    `who: 'each-player'` spec expands into one plan entry per seat, so there is no count of specs to
    index by. In a composition with a *second* question-asking clause it would therefore sum answers
    that are not its own. D467 is why that is written down rather than guarded: the guard for it cost
    two working cards and prevented nothing, because the only other readers that ask questions apply
    their own answers through the engine. The composition that matters — "each opponent discards a
    card and you gain 1 life" — has a test at a real table below rather than an argument here.
  */
  const roundDiscard = /^each (player|opponent) discards ([\w]+) (cards?)( at random)?$/i.exec(text);
  if (roundDiscard !== null) {
    const n = countFrom(roundDiscard[2]!);
    if (n !== null) {
      const opponentsOnly = roundDiscard[1]!.toLowerCase() === 'opponent';
      const seatsOf = (c: EffectContext): readonly SeatIndex[] => (opponentsOnly
        ? opponentsOf(c.state, c.controller)
        : c.state.seats.filter((seat) => !seat.eliminated).map((seat) => seat.index));
      if (roundDiscard[4] !== undefined) {
        return {
          effect: (c) => seatsOf(c).reduce((state, seat) => discardAtRandom(state, seat, n), c.state),
        };
      }
      return {
        decisions: [{
          who: opponentsOnly ? 'each-opponent' : 'each-player',
          from: 'hand',
          prompt: `Discard ${roundDiscard[2]!} ${roundDiscard[3]!}`,
          min: n,
          max: n,
        }],
        effect: (c) => c.decisions.reduce(
          (state, answer) => moveToGraveyard(state, answer.ids), c.state,
        ),
      };
    }
  }

  // "Discard your hand": no question, because there is nothing to choose between.
  if (/^(?:you )?discard your hand$/i.test(text)) {
    return {
      effect: (c) => moveToGraveyard(
        c.state, [...listAt(c.state, zoneKey(c.controller, 'hand'))],
      ),
    };
  }

  /*
    The controller's own discard. "You discard a card" and "Discard a card" are the same sentence —
    a planeswalker and a spell spell it the long way — which is the same `(?:you )?` the draw reader
    above already carries.
  */
  const myDiscard = /^(?:you )?discard ([\w]+) (cards?)( at random)?$/i.exec(text);
  if (myDiscard !== null) {
    const n = countFrom(myDiscard[1]!);
    if (n !== null) {
      if (myDiscard[3] !== undefined) {
        return { effect: (c) => discardAtRandom(c.state, c.controller, n) };
      }
      return {
        decisions: [{
          who: 'controller',
          from: 'hand',
          prompt: `Discard ${myDiscard[1]!} ${myDiscard[2]!}`,
          min: n,
          max: n,
        }],
        effect: (c) => moveToGraveyard(c.state, chosenCards(c)),
      };
    }
  }

  return null;
}

/** The card types a printed board scope can name: the permanent types, and no others (CR 205.2a). */
const PERMANENT_TYPES: readonly string[] = [
  'artifact', 'battle', 'creature', 'enchantment', 'land', 'planeswalker',
];

/**
 * One word of a printed board scope, as a test on a **live** type line.
 *
 * The capitalisation rule is `libraryFilter`'s and the argument for it is the same: Magic prints
 * card types and supertypes lowercase — "artifact creature", "legendary creature" — and subtypes
 * capitalised — "Dragon creature", "each Ooze you control". So a capitalised word is a subtype, and
 * a lowercase one has to be on one of the two lists or the scope is refused.
 *
 * **The lowercase allow-list is the whole guard**, and `PERMANENT_TYPES` is deliberately shorter
 * than `SEARCHABLE_TYPES`: a battlefield scope reading "each instant you control" would match
 * nothing, every time, which is the silent-nothing failure D449 found in the search filters. Here
 * it cannot arise, because `instant` and `sorcery` are not on the list and the line stays unread.
 *
 * The line this reads is the one `characteristicsOf` computed, not the printed one — #319's rule.
 * An animated land is a creature for "each creature you control" and a crewed Vehicle is swept with
 * the rest (CR 613), for the same reason `destroy all creatures` reads it live.
 */
function permanentWordMatch(word: string): ((line: TypeLine) => boolean) | null {
  /*
    **The word has to be a word**, and this is the guard that does the real work.

    A printed scope arrives as the phrase between "each" and the controller clause, so a list comes
    in with its punctuation attached: "Pest, Bat, Insect, Snake, and Spider" splits into `Pest,`
    with the comma still on it. Classified by capitalisation alone, `Pest,` is a subtype — and
    `hasSubtype(line, 'pest,')` is false for every permanent ever printed, so the scope would be
    empty on every board. That is the silent-nothing failure D449 found in the search filters,
    arrived at from a different direction: not a type that does not exist, but a word that is not
    one. A comma, a slash (`and/or`) or a digit refuses the scope instead.
  */
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) return null;
  const lower = word.toLowerCase();
  if (/^[A-Z]/.test(word)) return (line) => hasSubtype(line, lower);
  if (PERMANENT_TYPES.includes(lower)) return (line) => hasType(line, lower);
  if (SUPERTYPES.includes(lower)) {
    return (line) => line.supertypes.some((type) => type.toLowerCase() === lower);
  }
  return null;
}

/**
 * A printed **board scope** — "each other Dragon creature you control" — as the permanents it names.
 *
 * This is the first piece of vocabulary in this file that reads a *set of permanents* off a phrase
 * rather than one target or one count, and it is written as its own reader because Magic prints the
 * same scope into several grammars: a counter on each of them (the clause above), a sweep, a pump.
 * One reader means "each other Dragon creature you control" cannot come to mean two different sets
 * in two clauses.
 *
 * ## What it reads, and what it refuses
 *
 * Three parts, peeled off in the order they are printed: an optional `other`, the type words, and
 * an optional controller clause. So:
 *
 * - `creature you control`, `other creature you control`
 * - `Dragon creature you control`, `artifact creature you control`, `legendary creature you control`
 * - `Ooze you control`, `other Squirrel you control`
 * - `creature your opponents control`, `creature you don't control`, `creature each opponent controls`
 * - `creature` on its own, which is every creature on the battlefield
 *
 * Everything else is refused, and the refusals are the point. "Each creature you control **with a
 * +1/+1 counter on it**" and "each creature **with modular** you control" both put a condition
 * after the noun that this does not read; "each Pest, Bat, Insect, Snake, and Spider you control"
 * is a list; "each creature **that convoked it**" is a fact about the spell. Each of those would
 * compile to a *wider or narrower* set than the card prints, which is worse than an unread line —
 * a counter on the wrong creatures is a board a player cannot argue with (D362).
 *
 * ## "Other" is the source, not the type
 *
 * `other` excludes the permanent whose ability this is, which is `c.source` — the same reading
 * `permanentFilter`'s `another` flag uses, and the reason the two words can share one meaning here:
 * on every card of this shape the scope is printed on the permanent it excludes.
 */
function boardScope(phrase: string): {
  readonly ids: (c: EffectContext) => readonly string[];
} | null {
  let rest = plain(phrase).trim().replace(/\.$/, '');
  /*
    The controller clause, read off the end. "You don't control" and "your opponents control" and
    "each opponent controls" are one set in a duel and the same set in a pod — every permanent whose
    controller is not this effect's — which is the reading `targetSpecFrom` already gives the two
    target phrases of that shape, and its docblock argues the case.
  */
  const CONTROLLERS: readonly (readonly [RegExp, 'you' | 'opponents'])[] = [
    [/\s+you control$/i, 'you'],
    [/\s+you don't control$/i, 'opponents'],
    [/\s+your opponents control$/i, 'opponents'],
    [/\s+each opponent controls$/i, 'opponents'],
  ];
  let who: 'you' | 'opponents' | 'any' = 'any';
  for (const [pattern, seatRule] of CONTROLLERS) {
    if (!pattern.test(rest)) continue;
    who = seatRule;
    rest = rest.replace(pattern, '');
    break;
  }
  const other = /^other\s+/i.test(rest);
  if (other) rest = rest.replace(/^other\s+/i, '');

  /*
    The type words, every one of which has to classify — so a scope is read only when **all** of it
    is understood, and the set is the conjunction.

    There is no upper bound on how many words a scope may have, and a break run is why. The first
    draft bounded it at two, on the theory that a longer phrase was a shape this reader had not
    read; breaking the bound changed nothing in 1,585 tests, so the bound was measured against the
    corpus instead. **Every** printed scope of three words or more is refused by the word
    classification itself: `creature with modular`, `creature target player controls`, `Merfolk
    and/or Knight`, `creature you control with lifelink`, `of up to two target creatures`, `of those
    creatures` — in each one at least one word is a lowercase non-type (`with`, `target`, `and/or`,
    `you`, `of`), which is the same refusal the bound was giving with an extra rule nobody could
    test. The refusal rows in `compile.test.ts` name all six shapes, so the day a word-shape change
    lets one of them through, that is what fails.

    The emptiness check below is the one guard in this function that **no input can reach**, and it
    is kept deliberately. Every controller pattern above begins with `\s+`, so stripping one always
    leaves a word behind: "on each you control" has no space before "you", so that pattern does not
    match and the phrase is refused by `you` not being a card type instead. Breaking the check
    passes the whole suite for exactly that reason, which is recorded here rather than papered over
    with a test that would pass for the wrong one. It stays because `[].every(…)` is **true**: the
    day a controller pattern loses its `\s+`, an empty word list would mean every permanent you
    control, lands included — a silent wrong answer rather than a refusal.
  */
  const words = rest.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length < 1) return null;
  const matchers = words.map(permanentWordMatch);
  if (matchers.some((matcher) => matcher === null)) return null;

  return {
    ids: (c) => battlefield(c.state, (id) => {
      const inst = c.state.instances[id];
      if (inst === undefined) return false;
      if (other && id === c.source) return false;
      if (who === 'you' && inst.zoneSeat !== c.controller) return false;
      if (who === 'opponents' && inst.zoneSeat === c.controller) return false;
      const { typeLine } = characteristicsOf(c.state, inst);
      return matchers.every((matcher) => matcher!(typeLine));
    }),
  };
}

/**
 * A printed `+N/+N` as `PumpOptions`, with a zero component left out.
 *
 * Left out rather than passed as `0` because the hand-written cards leave it out — Borderland
 * Marauder's `+2/+0` is `{ power: 2 }` — and the difference is not cosmetic: the bonus is stored on
 * the game state as a continuous effect, so `{ power: 2 }` and `{ power: 2, toughness: 0 }` produce
 * two states that behave identically and compare unequal. The ground-truth test found it on the
 * first run, by deep-equality on the resulting board.
 *
 * `null` for a `+0/+0`, which no card prints and which would be a pump that does nothing.
 */
function sizeBonus(power: number, toughness: number): PumpOptions | null {
  if (power === 0 && toughness === 0) return null;
  return { ...(power === 0 ? {} : { power }), ...(toughness === 0 ? {} : { toughness }) };
}

/**
 * `gets +N/+N and gains <keyword> until end of turn`, as one `PumpOptions`.
 *
 * Both halves travel in one object because that is what `pump` takes and what the two hand-written
 * twins of this clause store — Selesnya Charm's first mode and Renegade Freighter's attack trigger
 * both pass `{ power, toughness, keywords }` in a single call. Splitting it into a pump and a
 * separate grant would be two continuous effects where the print is one, and the two would expire
 * independently.
 *
 * `isKeyword` is the gate, and it is the whole reason this is safe to read: the engine's keyword
 * list is what `characteristicsOf` consults, so a word that is not in it is a word the rules would
 * ignore. `gains protection from red` would compile to a creature that gains nothing and a spell
 * that looks like it worked — so an unrecognised word refuses the clause instead, and the line is
 * reported unread for a human to play by hand (D362).
 *
 * `null` when there is no bonus at all, carrying `sizeBonus`'s refusal of `+0/+0`, and when the
 * granted word is not a keyword this engine has.
 */
function pumpAndGrant(
  power: number,
  toughness: number,
  granted: string | undefined,
): PumpOptions | null {
  const bonus = sizeBonus(power, toughness);
  if (bonus === null) return null;
  if (granted === undefined) return bonus;
  const words = grantedKeywordList(granted);
  return words === null ? null : { ...bonus, keywords: words };
}

/**
 * The keywords a clause grants, as the list `PumpOptions.keywords` takes — or `null` if any of them
 * is a word this engine would ignore.
 *
 * One or two, joined by "and": "gains trample", "gains flying and double strike". Ajani's ultimate
 * is the second shape and `pump(…, { keywords: ['flying', 'double strike'] })` is how it is written
 * by hand, which is also why the list is one `PumpOptions` and not two calls — two continuous
 * effects would expire independently.
 *
 * `isKeyword` is the gate and the whole reason this is safe: the engine's keyword list is what
 * `characteristicsOf` consults, so an unrecognised word would compile to a creature that gains
 * nothing and a spell that looks like it worked. "Protection from red" is the shape that catches —
 * refused here, reported unread, played by hand (D362).
 */
function grantedKeywordList(granted: string): Keyword[] | null {
  const words = granted.trim().toLowerCase().split(/\s+and\s+/).map((word) => word.trim());
  if (words.length === 0 || words.length > 2) return null;
  if (!words.every((word) => word !== '' && isKeyword(word))) return null;
  return words as Keyword[];
}

/**
 * What one printed clause does to **the permanent itself**, rather than to anything chosen.
 *
 * The third family of clause, after the untargeted ones and the targeted ones, and the one every
 * trigger shape needs most: a creature that grows when it attacks, an engine that untaps when you
 * cast a spell, a creature that takes a counter when you gain life. All three say "~" or "it" where
 * a spell would say "target creature", so they need no target spec and ask nobody anything.
 *
 * ## Deliberately absent: `sacrifice ~`
 *
 * "At the beginning of the end step, sacrifice Ball Lightning" is the pool's shape, and reading the
 * clause alone would be D364's trap for a third time. Ball Lightning also sets
 * **`leavesAtEndOfTurn: true`**, and its own comment says why: "the trigger below is what happens,
 * and the flag is how the bot knows it is coming. Without it the evaluation holds the creature back
 * to protect it." So the flag belongs to the **pair** of shape and clause — a sacrifice at end of
 * turn means the creature is leaving, a sacrifice on some other trigger does not — and this
 * function sees only the clause. A reader here would produce a card that works and plays badly,
 * which is worse than an unread line (D362).
 */
/**
 * Which permanent a clause inside `selfEffect` is about: the card, or whatever the line's subject
 * is.
 *
 * Four of that reader's clauses accept either the card's own name or a bare "it" — `it gets +1/+1
 * until end of turn`, `it gains flying until end of turn`, `regenerate it`, `put a +1/+1 counter on
 * it`. For almost every card the two are the same object, because almost every trigger that prints
 * one of those bodies is about the card printing it, and so the reader resolved all four to
 * `c.source` and nothing noticed.
 *
 * Armory of Iroas is where that stops being true. "Whenever equipped creature attacks, put a +1/+1
 * counter on it" — "it" is the creature, and `c.source` is the Equipment. The reading that resolved
 * "it" to the source compiled the card with `unread: []`, reported it fully automated, and grew the
 * sword instead of the creature holding it. That is the worst shape a reading can take: an unread
 * line is flagged for a human to play by hand (D362), and a line that is read wrongly is flagged
 * nowhere. A break run is what surfaced it — deleting the clause in `targetedEffect` that was
 * supposed to own this body changed nothing, because this reader runs first and had already claimed
 * it.
 *
 * So the two alternatives are now told apart rather than merged, by capturing the named one:
 *
 *  - the clause **named** the card (`Armory of Iroas gets`, `this creature gains`) → `c.source`,
 *    which is what the name means however the trigger was raised;
 *  - the clause said **"it"** → `c.subject ?? c.source`, the permanent the event was about, falling
 *    back to the card when there is no event — an activated ability or a spell, where `subject` is
 *    undefined by construction (see `EffectContext.subject`) and "it" can only be the card.
 *
 * The fallback is what keeps this from being a behaviour change for the rest of the pool: a
 * self-subject trigger has `subject === source`, so every card that read correctly before still
 * reads the same way, and the cards that change are exactly the ones whose subject is somebody
 * else.
 */
/**
 * Where the object a clause calls by its own name, or "it", is expected to be when the clause runs.
 *
 * Only one family of readings needs this and it needs it absolutely: `return ~ to its owner's hand`.
 * The same sentence is printed by a permanent moving itself off the **battlefield** (`{1}{U}: Return
 * Fleeting Image to its owner's hand`) and by a card returning itself from a **graveyard** (`When
 * Endless Cockroaches dies, return it to its owner's hand`), and the guard those two want is the
 * opposite one. CR 400.7 is why a guard is needed at all: an ability that names an object which has
 * since changed zones does as much as it can, which is nothing — so a battlefield self-bounce that
 * resolved after its own permanent died must **not** pull the card out of the graveyard, and a
 * graveyard one must.
 *
 * `null` means the caller does not know, which happens for a spell (whose "itself" is not a
 * permanent at all) and for the three events that leave the subject's zone genuinely open —
 * `leaves`, `to-exile` and `undying`. A reader that needs this refuses when it is `null`, which is
 * D362's rule: an unread line beats a guessed one.
 *
 * It is a parameter rather than a field on `EffectContext` because the engine does not record where
 * an ability's source was when it went on the stack. Adding that would be a wider change than this
 * family justifies, and the compiler **does** know: every caller of `composeEffects` knows which
 * trigger shape or ability it is assembling.
 */
type SubjectZone = 'battlefield' | 'graveyard';

function itMeans(named: string | undefined, c: EffectContext): string {
  return named === undefined ? c.subject ?? c.source : c.source;
}

function selfEffect(
  clause: string, name: string, where: SubjectZone | null,
): ReadEffect | null {
  const text = clause.trim();
  const self = selfRef(name);

  if (new RegExp(`^untap ${self}$`, 'i').test(text)) {
    return { effect: (c) => tap(c.state, c.source, false) };
  }

  /*
    "Return ~ to its owner's hand" — a card that picks itself up, and the reason `SubjectZone` exists.

    The other half of the family D465 measured at 128 one-line-short cards: that increment read the
    bounce the controller *chooses* from their own battlefield, and left this one, which is the same
    sentence pointed at the card printing it. **About 38 legal cards**, and three quite different
    kinds of card print it:

     * a permanent that moves itself off the battlefield — `{1}{U}: Return Fleeting Image to its
       owner's hand`, `At the beginning of the end step, return Glitterfang to its owner's hand`,
       Arcanis, Blinking Spirit, Darting Merfolk, Viashino Sandstalker;
     * an Aura or a card that comes **back from a graveyard** — `When Brilliant Halo is put into a
       graveyard from the battlefield, return Brilliant Halo to its owner's hand`, Whip Silk,
       Shimmering Wings, Endless Cockroaches, Immortal Phoenix;
     * and the pool's own hand-written Rancor, which is the second kind.

    ## Why the zone is a parameter and not a guess

    The two kinds want **opposite** guards, and getting it wrong is a wrong reading rather than an
    unread line (D362). An activated ability whose permanent died while the ability was on the stack
    does **nothing** — CR 400.7, the object it names has changed zones — so a battlefield self-bounce
    must not pull the card back out of the graveyard. A to-graveyard trigger fires *from* the
    graveyard, so it must. Rancor's hand-written twin says exactly this in its own docblock and
    guards on `zone === 'graveyard'`.

    A guard of "battlefield or graveyard" would read both cards and be wrong about the first one in
    precisely the case the rule is for, which is why `where` is threaded from the caller that knows
    (see `SubjectZone`) rather than inferred here. `where === null` — a spell, or a `leaves` or
    `to-exile` event whose subject could be in any of four zones — leaves the line unread.

    ## "It" and the card's own name are one reading

    `itMeans` already resolves the difference: a clause that names the card means `c.source`, and one
    that says "it" means the event's subject when there is one. Both are right here. "When Endless
    Cockroaches dies, return **it** to its owner's hand" is the self; a `dies` trigger watching
    another creature and saying "return it" means that creature, and `moveToHand` sends a card to
    **its own owner's** hand either way, which is what the printed words say.

    Two neighbours stay unread on purpose, both for want of a subject this reader has: `return that
    card to its owner's hand` (2 cards — "that card" is event-relative, `eventRelativeEffect`'s
    business) and `return enchanted creature to its owner's hand` (2 — the Aura's host, which is
    `who: 'attached'` rather than the subject).
  */
  const picksItselfUp = new RegExp(
    `^return (?:(${self})|it) to its owner's hand$`, 'i',
  ).exec(text);
  if (picksItselfUp !== null && where !== null) {
    const named = picksItselfUp[1];
    return {
      effect: (c) => {
        const id = itMeans(named, c);
        // CR 400.7 / 608.2: still where it was, or the ability does as much as it can, which is none.
        return c.state.instances[id]?.zone === where ? moveToHand(c.state, [id]) : c.state;
      },
    };
  }

  const grown = new RegExp(
    `^(?:(${self})|it) gets \\+(\\d+)/\\+(\\d+)(?: and gains ([a-z][a-z' ]*?))? until end of turn$`,
    'i',
  ).exec(text);
  if (grown !== null) {
    const bonus = pumpAndGrant(Number(grown[2]), Number(grown[3]), grown[4]);
    if (bonus !== null) {
      const named = grown[1];
      return {
        effect: (c) => pump(c.state, [itMeans(named, c)], c.source, c.controller, bonus),
      };
    }
  }

  /*
    A grant with no size change: `{B}: Skithiryx gains haste until end of turn.` The same `pump`
    call with only `keywords` in it, which is how the hand-written Skithiryx writes it — a keyword
    granted until end of turn is a continuous effect like a pump, not a different mechanism.
  */
  const gained = new RegExp(
    `^(?:(${self})|it) gains ([a-z][a-z' ]*?) until end of turn$`, 'i',
  ).exec(text);
  if (gained !== null) {
    const word = gained[2]!.trim().toLowerCase();
    if (isKeyword(word)) {
      const named = gained[1];
      return {
        effect: (c) => pump(
          c.state, [itMeans(named, c)], c.source, c.controller, { keywords: [word] },
        ),
      };
    }
  }

  const regenerated = new RegExp(`^regenerate (?:(${self})|it)$`, 'i').exec(text);
  if (regenerated !== null) {
    const named = regenerated[1];
    return { effect: (c) => regenerate(c.state, itMeans(named, c)) };
  }

  const counted = new RegExp(
    `^put ([\\w]+) \\+1/\\+1 counters? on (?:(${self})|it)$`, 'i',
  ).exec(text);
  if (counted !== null) {
    const n = countFrom(counted[1]!);
    if (n !== null) {
      const named = counted[2];
      return { effect: (c) => addCounters(c.state, itMeans(named, c), '+1/+1', n) };
    }
  }

  return null;
}

/**
 * An Aura or an Equipment, read from **two lines at once**.
 *
 * ## Why this is the compiler's first whole-card shape
 *
 * Every other reader here takes one printed line and returns what that line is worth, and the lines
 * path merges the results. An attachment cannot be read that way, and the reason is the trap D364
 * found on Calciderm, in its sharpest form yet:
 *
 *  - `Enchant creature` **alone** is an Aura you can cast, that attaches, and that does nothing.
 *  - `Enchanted creature gets +2/+0` **alone** is a bonus with nothing to attach it to.
 *  - `Equip {1}` alone is an ability that moves a blank Equipment around the battlefield.
 *
 * So neither line is a unit and the pair is. A per-line reader that emitted either half would
 * produce a card that **works and does nothing**, which is worse than an unread card: an unread card
 * is flagged for a human to play by hand (D362) and a blank Aura is flagged nowhere.
 *
 * ## What it reads, and what it refuses
 *
 * The static line's grammar is small and completely regular across the pool's ten attachments:
 * `gets +N/+N`, `has <keyword> and <keyword>`, `gets +N/+N and has <keyword>`, `is indestructible`,
 * `can't attack or block`.
 *
 * Refused: `Enchanted creature has "Whenever this creature deals damage to a player, draw a card."`
 * — a granted **ability**, not a keyword. Ophidian Eye's hand-written script expresses that with
 * `grants`, which names an index into a table of abilities this module has no way to build, and a
 * reader that dropped the quoted text would be an Aura that silently grants nothing. It is refused
 * by the keyword validation rather than by a test for the quote mark: the sentence splits on its own
 * commas into fragments `printedKeywords` does not recognise. Verified by deleting the quote test
 * and watching nothing fail — so the quote test is gone.
 *
 * ## `friendly` and `removesACreature` are facts about the bonus, not about the phrase
 *
 * Every Aura in the pool prints the same `Enchant creature`, and Angelic Gift's spec is `friendly`
 * while Pacifism's is not. The difference is whether the effect **helps**, which is readable here
 * and nowhere else — and Pacifism also sets `removesACreature`, because an Aura that stops a
 * creature attacking or blocking is removal, and a bot that does not know that holds it for nothing.
 * So a harmful bonus gets the flag and drops `friendly`; a helpful one is the other way round.
 */
export interface WholeCardReading {
  readonly fragment: Partial<CardScript>;
  /** The printed lines this reading accounts for, so the caller counts them compiled. */
  readonly claimed: readonly string[];
}

/** The keyword list in `has trample and lifelink`, validated by the reader that reads it back. */
function grantedKeywords(phrase: string): readonly Keyword[] | null {
  const names = phrase.trim().replace(/\.$/, '').split(/,\s*|\s+and\s+/)
    .map((k) => k.trim().toLowerCase()).filter((k) => k !== '');
  if (names.length === 0) return null;
  /*
    Checked through `printedKeywords`, for the reason `tokenEffect` gives: it is the function the
    engine uses to turn a keyword line into keywords, so asking it is asking whether the engine will
    actually read back what is about to be written down. A keyword it does not know would otherwise
    be an Equipment that silently grants nothing.
  */
  const read = printedKeywords(names.join(', '));
  return read.length === names.length ? read : null;
}

/** `Equipped creature gets +2/+0 and has trample.` as the bonus, and whether it harms its host. */
function attachmentBonus(line: string): { bonus: PumpOptions; harmful: boolean } | null {
  const matched = /^(?:equipped|enchanted) creature (.+?)\.?$/i.exec(plain(line).trim());
  if (matched === null) return null;
  const tail = matched[1]!.trim();

  if (/^can't attack or block$/i.test(tail)) {
    return { bonus: { cantAttack: true, cantBlock: true }, harmful: true };
  }
  if (/^is indestructible$/i.test(tail)) {
    return { bonus: { keywords: ['indestructible'] }, harmful: false };
  }

  const got = /^gets ([+-]\d+)\/([+-]\d+)(?: and has (.+))?$/i.exec(tail);
  if (got !== null) {
    const power = Number(got[1]);
    const toughness = Number(got[2]);
    if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
    const size = sizeBonus(power, toughness);
    if (size === null) return null;
    if (got[3] === undefined) {
      // A negative bonus is removal by arithmetic, which is how the one shape covers a Pacifism
      // and a Nameless Inversion-style shrink without a second reader.
      return { bonus: size, harmful: power < 0 || toughness < 0 };
    }
    const keywords = grantedKeywords(got[3]);
    if (keywords === null) return null;
    return { bonus: { ...size, keywords }, harmful: power < 0 || toughness < 0 };
  }

  const has = /^has (.+)$/i.exec(tail);
  if (has !== null) {
    /*
      A quoted ability is refused here too, and by `grantedKeywords` rather than by a test for the
      quote mark. This function had such a test; deleting it left all 93 tests green, because
      Ophidian Eye's quoted sentence splits on its commas into fragments `printedKeywords` does not
      recognise, so the validation already refuses it. An unpinned guard duplicating a pinned one is
      a second thing to keep true, so it is gone and this comment says what does the work.
    */
    const keywords = grantedKeywords(has[1]!);
    if (keywords === null) return null;
    return { bonus: { keywords }, harmful: false };
  }

  return null;
}

/**
 * An Aura or an Equipment, or `null` when this card is neither or its lines do not read.
 *
 * All or nothing per *mechanism*: an Aura is emitted only when both its `Enchant creature` and its
 * bonus line read, so there is no state in which half an Aura is emitted.
 *
 * An **Equipment's bonus is optional**, which this used to get wrong. It required a line starting
 * "Equipped creature …" and returned `null` without one, and every Equipment in the pool had such
 * a line, so the requirement was invisible. Armory of Iroas is the first that does not — its text
 * is a trigger and an equip cost — and it was losing its whole equip ability to a bonus it does
 * not print. The equip ability stands on its own: it moves the Equipment onto a creature and that
 * is a complete, playable mechanic, which `equipFragment` has always allowed with an empty bonus
 * and nothing had yet asked for.
 */
export function attachmentScriptFor(
  def: CardDef, lines: readonly string[],
): WholeCardReading | null {
  const typeLine = parseTypeLine(def.typeLine);
  const isAura = hasSubtype(typeLine, 'aura');
  const isEquipment = hasSubtype(typeLine, 'equipment');
  if (!isAura && !isEquipment) return null;

  const subject = isAura ? /^enchanted creature/i : /^equipped creature/i;
  const staticLine = lines.find((line) => subject.test(plain(line).trim()));
  const read = staticLine === undefined ? null : attachmentBonus(staticLine);
  /*
    **A bonus line this module cannot read no longer refuses the attachment (D456).**

    It used to: `if (staticLine !== undefined && read === null) return null`. The docblock two
    paragraphs up already argued the other way for any *other* unreadable line — "A second line the
    compiler cannot read is fine too: the Aura attaches and the line is flagged, which is the hybrid
    reading working rather than failing" — and the code contradicted it for exactly one line, the one
    starting with the word "Enchanted". So "Enchant creature / When enchanted creature dies, draw a
    card" attached and flagged the trigger, while "Enchant creature / Enchanted creature doesn't
    untap during its controller's untap step" compiled to **nothing at all**: not an Aura, not
    castable, not attachable, 738 legal Auras with no attachment of any kind.

    That is the worse of the two failures by this file's own rule. An unread line is dealt to a
    human (D362) and the card is still *at the table*; a card that cannot be put onto a creature
    cannot be played by hand either, because the engine has no attachment for the player to make.

    So the bonus is taken when it reads, and when it does not the line is left unclaimed and
    flagged, exactly as a trigger the compiler cannot read already is. `claimed` below says so: a
    line that was not understood is not claimed, so it keeps its badge.
  */

  if (isAura) {
    /*
      **What the Aura may be put on, as the card prints it (D456).**

      This read `/^enchant creature$/` exactly, because that is what all ten of the pool's
      attachments print. The corpus prints eleven other phrases, and 356 legal Auras were refused
      for naming one of them: `Enchant land` (82), `Enchant creature you control` (54), `Enchant
      player` (42), `Enchant artifact or creature` (22), `Enchant permanent` (22), `Enchant
      artifact` (19), `Enchant creature or Vehicle` (10), `Enchant land you control` (7), `Enchant
      creature an opponent controls` (5), `Enchant planeswalker` (5).

      The phrase is read through `targetSpecFrom` — the same reader every other target phrase goes
      through — by asking it for `target <thing>`, so the filters are the ones the rest of the file
      already uses and there is no second definition of what a land is. The spec's description is
      then the **printed** phrase, "enchant land", because that is what a player reads in the prompt
      and what the hand-written Auras store.

      **`Enchant player` is refused although `targetSpecFrom` can build it**, and the refusal is the
      point of this comment. The engine attaches an Aura by writing `attachedTo` with the id of a
      **card** — `object.targets.find((t) => t.kind === 'card')` — so an Aura pointed at a seat
      would resolve, find no card among its targets, and sit on the battlefield attached to nothing:
      the "works and does nothing" shape this reader exists to avoid. Enchanting a player needs the
      engine to hold an attachment to a seat, which it does not, so those 42 cards keep their badge
      until it does. `Enchant planeswalker` and the two compound phrases are refused by
      `targetSpecFrom` itself, which has no spec for them.

      **No reminder text is stripped here, and a break run is why.** The first draft ended the
      pattern with `(?:\s*\(.*\))?$` for the printings that carry "(Target a creature as you cast
      this. This card enters attached to that creature.)" — and breaking that group changed nothing
      in 1,758 tests, because `printedRulesLines` has already taken the reminder off every line
      before this reader sees one (CR 207.2). The group was a second place doing a job one place
      already does, so it is gone and the test that covers it says what it is really covering.
    */
    const enchant = lines
      .map((line) => /^enchant ([a-z][a-z' ]*)$/i.exec(plain(line).trim()))
      .find((m) => m !== null);
    if (enchant === undefined || enchant === null) return null;
    const declared = enchant[0]!;
    const thing = enchant[1]!.trim().toLowerCase();
    if (thing === 'player') return null;
    // `false`: an Aura's host vocabulary is the switch's exact phrases only. See `targetSpecFrom`.
    const host = targetSpecFrom(`target ${thing}`, read !== null && !read.harmful, false);
    if (host === null) return null;
    /*
      An Aura whose *whole card* is `Enchant creature` is still refused, and that is the invariant
      the test below the bonus-optional change had to keep: a declaration on its own is an Aura you
      can cast, that attaches, and that does nothing — a card that works and does nothing, which is
      worse than an unread one because the unread one is flagged (D362) and this is not.

      What changed is only *which* second line counts. It had to be a bonus; now any other printed
      line will do, because a trigger is as much the rest of the card as a bonus is. A second line
      the compiler cannot read is fine too: the Aura attaches and the line is flagged, which is the
      hybrid reading working rather than failing.
    */
    if (staticLine === undefined && lines.length <= 1) return null;
    /*
      **The bonus line is optional for an Aura too (D437).**

      It was required, on the argument that `Enchant creature` attaches the Aura and the bonus is
      the whole of what it then does, so half of that pair is nothing. That is true of an Aura whose
      only other line is a bonus and false of one whose other line is a *trigger* — and the corpus
      says the second kind is the majority: of 55 legal Auras printing "enchanted creature dies",
      **29 have no bonus line at all**. Bequeathal is "Enchant creature / When enchanted creature
      dies, you draw two cards", and under the old guard it compiled as a spell with no target that
      attached to nothing and did nothing, which is the "works and does nothing" shape D364's
      docblock is about — the same shape the bonus-less Equipment had until D433, one card type
      along.

      So the Aura claims its `Enchant creature` line and emits the attach; the bonus is taken when
      it is there and the trigger comes through the lines path and merges, exactly as it does for an
      Equipment.
    */
    return {
      fragment: {
        aura: {
          /*
            The spec `targetSpecFrom` built, wearing the printed phrase as its description.

            `friendly` is claimed only when a bonus line says the Aura helps — it is passed to
            `targetSpecFrom` above. With no bonus there is no signal either way: Bequeathal wants to
            be on your own creature and Banewasp Affliction wants to be on theirs, and both print
            nothing but a trigger. So the flag is **omitted** rather than guessed, which is the same
            answer the harmful case gives and leaves the bot to read the board instead of a wrong
            hint.
          */
          target: { ...host, description: `enchant ${thing}` },
          effect: read?.bonus ?? {},
        },
        ...(read?.harmful === true ? { removesACreature: true as const } : {}),
      },
      // Only a line that was **read** is claimed; an unreadable bonus keeps its badge (D456).
      claimed: read === null ? [declared] : [declared, staticLine!],
    };
  }

  const equip = lines
    .map((line) => /^equip\s*(\{[^\n]+\})$/i.exec(plain(line).trim()))
    .find((m) => m !== null);
  if (equip === undefined || equip === null) return null;
  return {
    fragment: equipFragment(
      equip[1]!,
      // No bonus line means no bonus, which is a real Equipment and not a failure to read one.
      read?.bonus ?? {},
      /*
        The printed bonus line as the ability's description, lower-cased at the front the way the
        hand-written Equipment spell theirs — and, with no bonus line, what the equip ability
        actually does instead. Not the bonus phrase with the bonus missing, which would describe a
        card that does not exist.
      */
      read === null
        ? 'attach it to a creature you control'
        : (() => {
          const text = plain(staticLine!).trim().replace(/\.$/, '');
          return text.charAt(0).toLowerCase() + text.slice(1);
        })(),
    ),
    /*
      Only the lines this actually accounted for: with no bonus line there is nothing to claim but
      the equip itself, and claiming one that does not exist would hide a line from the per-line
      readers.

      **`read === null` rather than `staticLine === undefined` (D456)**, and the difference is a
      badge. Since an unreadable bonus no longer refuses the attachment, an Equipment printing
      "Equipped creature has soaring" equips and grants nothing — and if this still claimed that
      line, the card would grant nothing with **nothing anywhere saying so**, which is the silent
      failure the whole hybrid reading exists to avoid. The description above is keyed off the same
      test, so an Equipment whose bonus was not read describes what it does do — attach — rather
      than quoting a bonus it is not giving.
    */
    claimed: read === null ? [equip.input] : [equip.input, staticLine!],
  };
}

/**
 * "Exile target X until ~ leaves the battlefield": the removal that gives the permanent back.
 *
 * The second whole-card shape, and a whole card for the same reason an Aura is: the exile and the
 * return are **two triggers**, and either one without the other is a broken card. An ETB that
 * exiles with nothing to return it is permanent exile printed as temporary; a `leaves` trigger with
 * nothing exiled is dead text. `exileUntilItLeaves` above builds the pair, and this is the printed
 * text that maps onto it.
 *
 * ## The pool prints it two ways, and the difference decides whether the return exists
 *
 * - **Banisher Priest**, one line: `When ~ enters the battlefield, exile target creature an
 *   opponent controls until ~ leaves the battlefield.` The return is inside the `until` clause.
 * - **Journey to Nowhere**, two lines: `When ~ enters the battlefield, exile target creature.` plus
 *   `When ~ leaves the battlefield, return the exiled card to the battlefield under its owner's
 *   control.` The return is its own sentence.
 *
 * So one of those two has to be present, and **a bare `exile target creature` with neither is not
 * this card**: it is permanent exile, and emitting a return for it would hand back a creature the
 * print says is gone for good. That is the one refusal here that is about correctness rather than
 * coverage, and it has its own test.
 *
 * ## `removesACreature`, and why the type line decides it
 *
 * The flag means "this card's whole effect is to remove a creature", and its own docblock says in
 * as many words that it is **not** for "a card that is good without a creature to kill". The two
 * printings above are exactly that distinction, and the hand-written pair already draws it:
 * Journey to Nowhere carries the flag and Banisher Priest deliberately does not, because the Priest
 * is a 2/2 worth casting for the body alone while the Enchantment "sits there doing nothing if its
 * entry trigger finds nothing to point at".
 *
 * What separates them is readable from printed data and nowhere else in this reading: whether the
 * host is a creature. So the flag is set when the exiled thing is a creature and the card that
 * exiles it has no body of its own. The same two tests keep it off Banishing Light, whose spec is a
 * `permanent` — a card that can exile an Equipment or a planeswalker is not waiting for a creature.
 *
 * Decided here rather than in `triggerFromLine`, which drops `spellFlags` on purpose: "advice about
 * casting the card" is a fact about the **whole card**, and this is the one reader that has the
 * whole card. A per-line reading could only ever guess at what the rest of the text does.
 */
function exileUntilLeavesShapeFor(
  def: CardDef, lines: readonly string[],
): WholeCardReading | null {
  const self = selfRef(def.name);
  const exiling = new RegExp(
    `^When ${self} ${ENTERS}, exile (target .+?|another target .+?)`
    + `(\\s+until ${self} leaves the battlefield)?\\.?$`,
    'i',
  );
  let line: string | undefined;
  let matched: RegExpExecArray | null = null;
  for (const candidate of lines) {
    const m = exiling.exec(plain(candidate).trim());
    if (m !== null) { line = candidate; matched = m; break; }
  }
  if (line === undefined || matched === null) return null;

  const spec = targetSpecFrom(matched[1]!, false);
  if (spec === null || !pointsAtAPermanent(spec)) return null;

  // The return, either inside the `until` clause or as its own printed line.
  const returning = lines.find((other) => new RegExp(
    `^When ${self} leaves the battlefield, return the exiled card to the battlefield`
    + ` under its owner's control\\.?$`,
    'i',
  ).test(plain(other).trim()));
  if (matched[2] === undefined && returning === undefined) return null;

  const { name: _ignored, ...pair } = exileUntilItLeaves(def.name, spec);
  // See the docblock: a creature exiled by a card with no body of its own. Both tests matter —
  // Banisher Priest fails the second and Banishing Light the first.
  const bodyless = spec.kind === 'creature' && !hasType(parseTypeLine(def.typeLine), 'creature');
  return {
    fragment: { ...pair, ...(bodyless ? { removesACreature: true as const } : {}) },
    claimed: returning === undefined ? [line] : [line, returning],
  };
}

/**
 * Every shape read from more than one line, or from the type line as well as the text.
 *
 * Two so far — attachments and exile-until-leaves — and they are tried in order because a card is
 * one or the other, never both: an Aura has no ETB exile and an exiling creature has no
 * `Enchant creature`. The order is therefore arbitrary today and stated as such rather than
 * presented as a precedence that means something.
 *
 * `compileCard` calls this once, before the per-line loop, and skips whatever it claimed.
 */
/**
 * Soulbond, which is two printed lines and one mechanic (CR 702.95a).
 *
 * The third shape read from more than one line, and the one `keywordScriptFor`'s docblock named as
 * deliberately absent: "its line is the word alone; the bonus the pair gets is on the *next* line",
 * and a `soulbond: { effect: { power: 1, toughness: 1 } }` guessed from the keyword would be a
 * number this module made up (D259). Reading the pair together is the answer that was waiting for
 * a stage that reads sentences.
 *
 * Neither line is a unit. `Soulbond` on its own is a pairing that does nothing, and "As long as ~
 * is paired with another creature, each of those creatures gets +1/+1" on its own is a bonus with
 * no pairing to hang it from — so this emits both halves or neither, and `soulbondTriggers` comes
 * with them because the pairing is what the triggers do.
 *
 * Only the **bonus** form. Tandem Lookout prints "each of those creatures has 'Whenever this
 * creature deals damage to a player, draw a card'", which is a granted *ability* — declared in the
 * pool as `grants: [0]` against a `grantedTriggers` entry this module has no way to build — so that
 * card is refused rather than compiled into a pair that gets nothing.
 */
function soulbondShapeFor(def: CardDef, lines: readonly string[]): WholeCardReading | null {
  const keyword = lines.find((line) => plain(line).trim().toLowerCase() === 'soulbond');
  if (keyword === undefined) return null;
  const self = selfRef(def.name);
  for (const line of lines) {
    const paired = new RegExp(
      `^As long as ${self} is paired with another creature, each of those creatures gets \\+(\\d+)/\\+(\\d+)\\.?$`,
      'i',
    ).exec(plain(line).trim());
    if (paired === null) continue;
    const effect = sizeBonus(Number(paired[1]), Number(paired[2]));
    if (effect === null) return null;
    return {
      fragment: { soulbond: { effect }, triggers: [...soulbondTriggers()] },
      claimed: [keyword, line],
    };
  }
  return null;
}

export function wholeCardShapeFor(
  def: CardDef, lines: readonly string[],
): WholeCardReading | null {
  return attachmentScriptFor(def, lines)
    ?? exileUntilLeavesShapeFor(def, lines)
    ?? soulbondShapeFor(def, lines);
}

/**
 * The printed trigger prologues this compiler knows, and the events each one names.
 *
 * ## Why a table, and why it is the increment that pays
 *
 * Until now one shape existed — "When ~ enters the battlefield" — so every effect the compiler
 * could read was reachable from exactly one place on a card. D369 made the same observation about
 * composition: a change that adds no vocabulary at all still moves coverage, because it multiplies
 * every reader already present. Shapes multiply the same way, in the other direction. The effect
 * vocabulary is now three families deep, and this is what lets a card reach it from a death, an
 * attack, a cast, an upkeep or a life gain.
 *
 * ## The events are copied from the hand-written cards, not inferred
 *
 * Every `on` below is the one a card in the pool already uses for that printed prologue, named in
 * the comment beside it. Several fields the engine documents as defaults are therefore **absent** —
 * `who: 'self'` on `dies` and `attacks`, for instance — because that is how the card that proves
 * the shape spells it. `of: 'you'` on a step trigger is present for the same reason and is not a
 * default: its own docblock in this file says `of: 'you'` "is the difference between a card that
 * helps its controller and one that helps everybody".
 *
 * ## Two events from one line
 *
 * `on` is a list because Magic prints one: "When Mogg War Marshal enters the battlefield or dies"
 * is two triggered abilities sharing one effect (CR 603.1), so the reading is two `TriggerDef`s
 * with the same clause. The order of the table matters only in that the "or dies" prologue must be
 * tried before the plain one — which the regexes already enforce, since the plain one requires a
 * comma straight after "battlefield".
 */
const TRIGGER_SHAPES: readonly {
  readonly prologue: (self: string) => RegExp;
  readonly on: readonly TriggerDef['on'][];
}[] = [
  /*
    An Aura's or an Equipment's own creature, which is what `who: 'attached'` is for (D433).

    `equipped` and `enchanted` in one row because the only difference between them is which kind of
    permanent is printing the line, and the engine's attachment relation does not distinguish: an
    Aura and an Equipment both point at their host through `attachedTo`. 47 corpus cards print the
    attack line of an Equipment and 18 of an Aura; 45 print the combat-damage line.

    Armory of Iroas is the ground truth for the pair — the hand-written card and this reading build
    the same script, which is what `compiled-vs-written.test.ts` checks on every run.
  */
  {
    prologue: () => /^Whenever (?:equipped|enchanted) creature attacks, (.+)$/i,
    on: [{ kind: 'attacks', who: 'attached' }],
  },
  {
    prologue: () => /^Whenever (?:equipped|enchanted) creature deals combat damage to a player, (.+)$/i,
    on: [{ kind: 'combat-damage', who: 'attached' }],
  },
  // Kitchen Finks, Gravedigger, and thirty others.
  {
    prologue: (self) => new RegExp(`^When ${self} ${ENTERS} or dies, (.+)$`, 'i'),
    on: [{ kind: 'etb', who: 'self' }, { kind: 'dies' }],
  },
  /*
    The same shape spelled the long way, which is what a **noncreature** permanent has to print:
    "dies" is defined for creatures only (CR 700.4), so Ichor Wellspring — an artifact — says
    "or is put into a graveyard from the battlefield" instead. `to-graveyard` is the event the
    engine raises for it, and the hand-written card uses exactly that pair.

    One effect for both events, which is the row's shape and now also correct for this card: the
    guard that used to sit on its graveyard half was wrong (D409).
  */
  {
    prologue: (self) => new RegExp(
      `^When ${self} ${ENTERS} or is put into a graveyard from the battlefield, (.+)$`,
      'i',
    ),
    on: [{ kind: 'etb', who: 'self' }, { kind: 'to-graveyard', who: 'self' }],
  },
  {
    prologue: (self) => new RegExp(`^When ${self} ${ENTERS}, (.+)$`, 'i'),
    on: [{ kind: 'etb', who: 'self' }],
  },
  // Doomed Traveler, Goblin Arsonist: `{ kind: 'dies' }`, with `who` left at its default.
  {
    prologue: (self) => new RegExp(`^When ${self} dies, (.+)$`, 'i'),
    on: [{ kind: 'dies' }],
  },
  // Journey to Nowhere, Banishing Light.
  {
    prologue: (self) => new RegExp(`^When ${self} leaves the battlefield, (.+)$`, 'i'),
    on: [{ kind: 'leaves' }],
  },
  // Ainok Survivalist, Ruthless Ripper: the morph trigger.
  {
    prologue: (self) => new RegExp(`^When ${self} is turned face up, (.+)$`, 'i'),
    on: [{ kind: 'turned-face-up' }],
  },
  // Borderland Marauder.
  {
    prologue: (self) => new RegExp(`^Whenever ${self} attacks, (.+)$`, 'i'),
    on: [{ kind: 'attacks' }],
  },
  // Thieving Magpie.
  {
    prologue: (self) =>
      new RegExp(`^Whenever ${self} deals combat damage to a player, (.+)$`, 'i'),
    on: [{ kind: 'combat-damage' }],
  },
  // City of Brass.
  {
    prologue: (self) => new RegExp(`^Whenever ${self} becomes tapped, (.+)$`, 'i'),
    on: [{ kind: 'becomes-tapped' }],
  },
  /*
    "When ~ is put into a graveyard from the battlefield" on its own (D461).

    The paired form — "When ~ enters **or** is put into a graveyard from the battlefield" — has been
    read since the table was written, because Ichor Wellspring prints it; the solo form is the same
    event with nothing in front of it and **27 legal cards** print it. Brilliant Halo, Audacity and
    Aspect of Mongoose are Auras, which is who prints this sentence at all: "dies" is defined for
    creatures only (CR 700.4), so a noncreature permanent has to spell the zone change out.

    `who: 'self'` is **not** the default on this event — it is `another`, which is Planar Void's
    reading — so it is written out. Without it an Audacity would draw its controller a card every
    time anything reached any graveyard.
  */
  {
    prologue: (self) => new RegExp(
      `^When ${self} is put into a graveyard from the battlefield, (.+)$`, 'i',
    ),
    on: [{ kind: 'to-graveyard', who: 'self' }],
  },
  /*
    "Whenever ~ becomes the target of a spell or ability" (D461). **8 legal cards**, among them
    Angelic Protector and Cephalid Aristocrat.

    `by: 'any'` is written out because the event's default is `opponent`, and that default exists
    for ward — the only thing that used this event before — which never triggers off its own
    controller's spells. The printed sentence here has no "an opponent casts" in it, so it fires off
    either side's spell, and taking the default would have made a card that reads one way behave
    another.
  */
  {
    prologue: (self) => new RegExp(
      `^Whenever ${self} becomes the target of a spell or ability, (.+)$`, 'i',
    ),
    on: [{ kind: 'targeted', by: 'any' }],
  },
  /*
    **The block family is refused, and the count is the reason it is worth writing down.**

    Four printed shapes, 90 legal cards one line short between them, and each is refused for its
    own reason rather than for want of a row:

     * **"Whenever ~ becomes blocked" (52 cards).** The engine's `becomes-blocked` is raised **once
       per blocker** — that is what "by a creature" means and what its own docblock says — while the
       bare printed form fires **once** however many creatures blocked. Reading one off the other
       would pay an Alley Grifters' discard three times against three blockers, which is a wrong
       reading of a real card and the thing D362 ranks below leaving a line unread. It wants the
       batched event, the way D443 built one for combat damage rather than reading the batched line
       off the per-creature one.
     * **"Whenever ~ blocks or becomes blocked by …" (38).** Almost every one carries a filter on
       the other creature — "by a green or white creature", "by one or more blue and/or black
       creatures" — and the event has no such filter. Two events from one line is already supported
       (`on` is a list); the filter is not.
     * **"Whenever ~ blocks" (15) and "becomes blocked by a creature" (12)** map cleanly onto
       `blocks` and `becomes-blocked`, and are held back by their **effects** rather than by their
       prologues: most print "that creature", which is the *other* creature in the combat —
       `EffectContext.blocked` — and the clause vocabulary reads "that creature" as
       `EffectContext.subject`, which on these two events is the card itself. A row without that
       distinction would return the wrong creature to its owner's hand. The reading is worth having
       and wants `blocked` taught to the clause vocabulary first.
  */
  // Thermo-Alchemist, Guttersnipe. `by: 'you'` is printed: "Whenever **you** cast".
  {
    prologue: () => /^Whenever you cast an instant or sorcery spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' }],
  },
  // Firebrand Archer.
  {
    prologue: () => /^Whenever you cast a noncreature spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', spell: 'noncreature' }],
  },
  /*
    ── The rest of the cast family ─────────────────────────────────────────────────────────

    The `spell-cast` event has had `by`, `spell`, `self` and `how` since the engine's first
    Guttersnipe, and until these rows the compiler could read exactly three of the sentences that
    use them. Ten candidate spellings were counted in the legal corpus and judged the way D434
    established — on cards whose **body** this compiler already reads, not on lines printed, because
    a row for a card whose body stays unread changes nothing (D362):

    | printed | lines | cards | trigger |
    | --- | --- | --- | --- |
    | you cast a creature spell | 44 | **11** | `by: 'you', spell: 'creature'` |
    | you cast an enchantment spell | 17 | **9** | `ofType: 'enchantment'` |
    | you cast a spell | 49 | **8** | `by: 'you'` |
    | when you cast this spell | 80 | **7** | `self: true` |
    | you cast an artifact spell | 21 | **7** | `ofType: 'artifact'` |
    | you cast a historic spell | 19 | 4 | — |
    | you cast a multicolored spell | 19 | 4 | — |
    | a player casts a spell | 35 | **2** | `by: 'any'` |
    | an opponent casts a spell | 27 | **1** | `by: 'opponent'` |
    | an opponent casts a creature spell | 7 | 0 | — |

    **Historic and multicolored are refused on the mechanism, not the count.** "Historic" is
    artifact *or* legendary *or* Saga and "multicolored" is a fact about the mana cost; neither is a
    card type, so neither is expressible by `ofType` and a reading that pretended otherwise would
    fire on the wrong spells — which is worse than leaving the line for a human (D362). The
    opponent-creature row is left out on the count alone: nothing it would read has a readable body
    yet, and the row costs nothing to add the day one does.

    `by: 'you'` is printed on every one of these that says "you", and it is also the *default* — so
    the rows that say it are saying what the card says rather than leaning on the default, which is
    the same note the two rows above carry.
  */
  {
    prologue: () => /^Whenever you cast a creature spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', spell: 'creature' }],
  },
  {
    prologue: () => /^Whenever you cast an artifact spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', ofType: 'artifact' }],
  },
  {
    prologue: () => /^Whenever you cast an enchantment spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', ofType: 'enchantment' }],
  },
  /*
    "Whenever you cast a spell" with no filter at all, and it goes **after** the five narrower rows
    above it on purpose. The patterns are anchored and mutually exclusive as English, so the order
    is not load-bearing today — but a reader who widens one of them later should find the general
    case underneath rather than above, because a row that matches everything above a row that
    matches something is how a filter stops being read.
  */
  {
    prologue: () => /^Whenever you cast a spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', spell: 'any' }],
  },
  {
    prologue: () => /^Whenever a player casts a spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'any', spell: 'any' }],
  },
  {
    prologue: () => /^Whenever an opponent casts a spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'opponent', spell: 'any' }],
  },
  /*
    "When you cast **this** spell" — the one trigger that fires from the stack rather than from the
    battlefield, which is what cascade, storm and replicate all abbreviate. 80 printed lines, the
    largest single spelling in the family, and `self: true` is the whole of it: `raise` offers the
    cast event to the card on the stack only for triggers that set it, and `fireTrigger` refuses
    every other trigger while the card is on the stack, so a compiled permanent cannot fire its
    battlefield triggers on the way past.

    `by` is deliberately absent rather than `'you'`: a spell is cast by its own controller, so the
    field would be a second statement of the same fact — and `triggerMatches` answers `self` first
    and on its own terms for exactly that reason.
  */
  {
    prologue: () => /^When you cast this spell, (.+)$/i,
    on: [{ kind: 'spell-cast', self: true }],
  },
  // Ajani's Pridemate.
  {
    prologue: () => /^Whenever you gain life, (.+)$/i,
    on: [{ kind: 'life-gained', by: 'you' }],
  },
  /*
    "Whenever you draw your **second** card each turn" (D436).

    The largest single prologue family left after the cast rows, measured the way D434 and D435
    were — on cards whose body this compiler already reads, not on lines printed: 54 legal lines
    and **24** cards for the "you" spelling, which is more than any other candidate by a factor of
    two.

    The ordinal is carried on the event rather than read off `cardsDrawnThisTurn`, and that is the
    whole of the engine work: the running total has already counted both cards of a `draw(2)` by
    the time either trigger is matched, so a reading taken from the total would fire twice on a
    Divination. Miracle (D204) found this first and its comment in `settle` says so.

    **Only "second" is read.** Of the 65 legal lines that name an ordinal, 63 say second — 54 "you",
    6 "an opponent", 3 "a player" — and the remaining two are a single "first" and a single "fifth".
    Supporting a word-to-number map for five ordinals to gain two lines would be a parser nothing
    exercises, and `TriggerDef.onNth` takes any number the day a card arrives: the field is general
    and the reader is not, which is the right way round.
  */
  {
    prologue: () => /^Whenever you draw your second card each turn, (.+)$/i,
    on: [{ kind: 'draws', by: 'you', onNth: 2 }],
  },
  {
    prologue: () => /^Whenever an opponent draws their second card each turn, (.+)$/i,
    on: [{ kind: 'draws', by: 'opponent', onNth: 2 }],
  },
  {
    prologue: () => /^Whenever a player draws their second card each turn, (.+)$/i,
    on: [{ kind: 'draws', by: 'any', onNth: 2 }],
  },
  /*
    The cast half of the same ordinal: "Whenever you cast your **second** spell each turn" (D440).

    47 legal lines and **17** cards finished, measured the way D434 onward measures — which makes it
    the largest prologue family left. Most of those lines print an ability word in front
    ("Flurry — ", "Eukrasia — "), which `withoutAbilityWord` has taken off before this table is
    reached, so they are one row and not fourteen.

    The count is **per caster**, which is why `GameState.spellsCastThisTurnBy` had to exist:
    `spellsCastThisTurn` is the table's running total and storm needs it to stay that (CR 702.40a),
    while this line counts only your own. At a four-seat table the two are different for most of a
    turn, and a reading taken from the total would fire a Clarion Spirit off an opponent's spell.

    **"first" ships and "third" does not**, on the same measure: 3 legal lines print the first (1
    card finished) and 2 print the third (**0** cards finished), so a third row would read a
    prologue onto cards whose bodies are still unread and change nothing (D362). `onNth` takes any
    number the day one of those two bodies becomes readable.
  */
  {
    prologue: () => /^Whenever you cast your second spell each turn, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', onNth: 2 }],
  },
  {
    prologue: () => /^Whenever you cast your first spell each turn, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'you', onNth: 1 }],
  },
  // Phyrexian Arena. `of: 'you'` is the card, not a default — see this file's step-trigger note.
  {
    prologue: () => /^At the beginning of your upkeep, (.+)$/i,
    on: [{ kind: 'step', step: 'upkeep', of: 'you' }],
  },
  {
    prologue: () => /^At the beginning of your end step, (.+)$/i,
    on: [{ kind: 'step', step: 'end', of: 'you' }],
  },
  /*
    The other two steps a card routinely names, and the two biggest step buckets in the corpus after
    the upkeep: 1,168 cards open "At the beginning of your …" and 258 "At the beginning of combat on
    your turn" (D426). Both are the same `step` trigger as the two above with a different step, and
    the engine has had both steps since #10 — `draw` and `begin-combat` are in `STEPS`.

    "On your turn" rather than "your" is how printed text says it for the combat steps, and the two
    spellings are not interchangeable English: a card that said "at the beginning of your combat"
    would be a card Wizards has not printed, so only the one that is printed is read.
  */
  /*
    Landfall (CR 702.112), which is the ability word `withoutAbilityWord` strips before this table is
    consulted — so "Landfall — Whenever a land you control enters, …" and the same sentence printed
    without the word are one row, which is what an ability word is.

    `what: 'land'` has been in `TriggerDef` since #163 with its own docblock saying it is "the
    landfall templating" and that "until a card asked, nothing could hear it". 184 corpus cards ask.
  */
  {
    prologue: () => new RegExp(`^Whenever a land you control ${ENTERS}, (.+)$`, 'i'),
    on: [{ kind: 'etb', who: 'any', of: 'you', what: 'land' }],
  },
  {
    prologue: () => /^At the beginning of your draw step, (.+)$/i,
    on: [{ kind: 'step', step: 'draw', of: 'you' }],
  },
  {
    prologue: () => /^At the beginning of combat on your turn, (.+)$/i,
    on: [{ kind: 'step', step: 'begin-combat', of: 'you' }],
  },
  /*
    ── The same steps, on somebody else's turn ─────────────────────────────────────────────

    Twelve printed spellings were counted in the legal corpus, and **three rows shipped**, because
    the count that decides a row is not how often the sentence is printed but how many cards the
    compiler can finish once it reads it. A row for a card whose body stays unread changes nothing:
    the line is flagged either way (D362). So each candidate was compiled across the corpus first
    and the column that matters is the last one:

    | printed | lines | compiled cards | trigger |
    | --- | --- | --- | --- |
    | each end step / the end step / each player's end step | 152 | **17** | `end`, any |
    | each player's upkeep / each upkeep | 149 | **10** | `upkeep`, any |
    | your first main phase | 47 | **2** | `precombat-main`, you |
    | each opponent's upkeep | 31 | 0 | — |
    | each combat | 27 | 0 | — |
    | each player's draw step | 13 | 0 | — |
    | your second main phase | 10 | 0 | — |
    | each opponent's end step | 7 | 0 | — |
    | combat on each opponent's turn | 5 | 0 | — |

    "**the** end step" is `any` and not a third thing: an ability on a permanent that says "the end
    step" means the end step of whichever turn it is, which is exactly what each/every says. The
    four `any` spellings across the two steps collapse into one alternation each for that reason —
    they are the same trigger in four hands.

    **The six zero-card rows are not here, and `of: 'opponent'` is not in `TriggerDef` either.**
    Three of those spellings would have needed it: 43 printed lines, not one of which has a body
    this compiler can read. Writing the field, the matcher arm and the rows would have added a
    mechanism no card exercises — and this file already has the entry on what that costs, because
    an untested mechanism added ahead of need is the one that is wrong when the corpus reaches it.
    The counts are recorded here so the next pass can re-ask with one command rather than
    rediscovering the family.

    Also deliberately absent, for reasons that are not about counts:

     - "At the beginning of the upkeep of enchanted creature's controller" (21), "of enchanted
       player's upkeep" (9) and the end-step version (3). These want the seat an *attachment* is
       on, which is not `of` at all — it is `who: 'attached'` one level further out (D433) and
       applied to a step rather than to a permanent. A reading that used `of: 'any'` for them would
       fire the ability on every turn instead of one, which is three or four times the card.
     - "At the beginning of each of your postcombat main phases" (8) — plural, and a card with more
       than one postcombat main phase is a card this engine's turn structure does not have.
     - "At the beginning of your next upkeep" (5) — a *delayed* trigger created by something else
       (CR 603.7), not a permanent's own triggered ability, and `delayed` is set by the effect that
       schedules it rather than read off a prologue.
  */
  {
    prologue: () => /^At the beginning of (?:each|the)(?: player's)? end step, (.+)$/i,
    on: [{ kind: 'step', step: 'end', of: 'any' }],
  },
  {
    prologue: () => /^At the beginning of (?:each|the)(?: player's)? upkeep, (.+)$/i,
    on: [{ kind: 'step', step: 'upkeep', of: 'any' }],
  },
  {
    prologue: () => /^At the beginning of your first main phase, (.+)$/i,
    on: [{ kind: 'step', step: 'precombat-main', of: 'you' }],
  },

  /*
    ── The same two events, watching somebody else's permanent ─────────────────────────────

    `who` and `of` are where most of the pool's etb and dies triggers actually live, and the English
    that distinguishes them is exact rather than approximate — which is the only reason these can be
    read at all:

      "another creature"               who: 'another'   (not itself)
      "a creature you control"         who: 'any', of: 'you'
      "~ or another creature"          who: 'any'       (itself included, by naming itself)

    Soul Warden's own comment makes the first distinction load-bearing: *"'Another' and not 'any': a
    Soul Warden does not gain you life for itself."* A reader that collapsed the three would be a
    card that triggers off its own arrival when the print says it does not — wrong in a way nothing
    refuses, and invisible except in the life total.

    Every `on` below is copied from the card in the pool named beside it, as the rest of this table
    is. `of` is **absent** where the hand-written card omits it and present where it does not: on
    Blood Artist the printed text says nothing about whose creature died, and that is not the same
    event as Zulaport Cutthroat's.
  */
  // Soul Warden, Essence Warden.
  {
    prologue: () => new RegExp(`^Whenever another creature ${ENTERS}, (.+)$`, 'i'),
    on: [{ kind: 'etb', who: 'another', of: 'any', what: 'creature' }],
  },
  // Impact Tremors.
  {
    prologue: () => new RegExp(`^Whenever a creature you control ${ENTERS}, (.+)$`, 'i'),
    on: [{ kind: 'etb', who: 'any', of: 'you', what: 'creature' }],
  },
  // Champion of the Parish's shape, and the one the pool spells with both qualifiers.
  {
    prologue: () => new RegExp(`^Whenever another creature you control ${ENTERS}, (.+)$`, 'i'),
    on: [{ kind: 'etb', who: 'another', of: 'you', what: 'creature' }],
  },
  // Blood Artist: it names itself, so `who` is `any` and nothing is said about whose.
  {
    prologue: (self) => new RegExp(`^Whenever ${self} or another creature dies, (.+)$`, 'i'),
    on: [{ kind: 'dies', who: 'any', what: 'creature' }],
  },
  // Zulaport Cutthroat: the same shape restricted to its controller's side.
  {
    prologue: (self) =>
      new RegExp(`^Whenever ${self} or another creature you control dies, (.+)$`, 'i'),
    on: [{ kind: 'dies', who: 'any', of: 'you', what: 'creature' }],
  },
  {
    prologue: () => /^Whenever another creature dies, (.+)$/i,
    on: [{ kind: 'dies', who: 'another', of: 'any', what: 'creature' }],
  },
  {
    prologue: () => /^Whenever another creature you control dies, (.+)$/i,
    on: [{ kind: 'dies', who: 'another', of: 'you', what: 'creature' }],
  },
  /*
    "Whenever **a** creature you control dies" — the same trigger as Zulaport's row above, which
    spells the card's own name out and then says "or another". 27 legal corpus lines print the
    shorter form and **10** of them are cards this compiler can finish, measured the way D434 onward
    measures (cards finished, not lines printed).

    `who: 'any'` and not `'another'`, because "a creature you control" includes the card saying it
    if the card is a creature — the exact distinction the row above exists to mark, one word along.
  */
  {
    prologue: () => /^Whenever a creature you control dies, (.+)$/i,
    on: [{ kind: 'dies', who: 'any', of: 'you', what: 'creature' }],
  },
  /*
    "Whenever **a creature you control** deals combat damage to a player" — the same sentence as the
    row above with a different verb, and until D439 it could not be written: `combat-damage` had its
    own arm in `triggerMatches` with two values of `who` and no `of` at all. 33 legal lines print
    it and **9** are cards this compiler can finish.

    No `what: 'creature'` and no "to a player" filter, because the event is already both: only a
    creature deals combat damage, and `dealtCombatDamage` records a hit **only** when a player's
    life total actually moved (see `hit` in `combat.ts`). So the printed phrase and the event agree
    without a clause to make them.

    The plural form — "whenever **one or more** creatures you control deal combat damage to a
    player", 26 legal lines and 8 cards — was deliberately not here when D439 shipped: it is a
    batched trigger that fires once however many creatures connected, and reading it off
    `combat-damage` would have paid a Grim Hireling two Treasures per *attacker*. **D443 built the
    batched event and the row is below**, which is the same answer D442 gave the attack declaration.
  */
  {
    prologue: () => /^Whenever a creature you control deals combat damage to a player, (.+)$/i,
    on: [{ kind: 'combat-damage', who: 'any', of: 'you' }],
  },
  // And the batched one, on the event D443 added. The singular row above and this one differ by one
  // word of English and by how many times they fire.
  {
    prologue: () =>
      /^Whenever one or more creatures you control deal combat damage to a player, (.+)$/i,
    on: [{ kind: 'combat-damage-dealt', by: 'you' }],
  },
  /*
    "Whenever **you** attack" — the declaration, once per combat (D442).

    92 legal lines print it and **8** are cards this compiler can finish, which makes it the largest
    prologue family left; 5 more print the longer spelling of the same sentence and map to the same
    trigger. It needed a new event rather than a new filter, because `attacks` is raised once per
    attacking creature and either reading taken off it would fire an Adeline once per attacker.

    The variants are **not** read, and each is a restriction this event cannot express: 8 legal lines
    say "with three or more creatures", 8 "with one or more <type>", 7 "a player", 6 "with two or
    more creatures", 2 "while creatures you control have total power 8 or greater". Reading any of
    them as the bare declaration would be a wrong reading of a real card (D362), so they wait.
  */
  {
    prologue: () => /^Whenever you attack, (.+)$/i,
    on: [{ kind: 'attack-declared', by: 'you' }],
  },
  {
    prologue: () => /^Whenever one or more creatures you control attack, (.+)$/i,
    on: [{ kind: 'attack-declared', by: 'you' }],
  },
  /*
    The attachment's own creature dying, which completes the family D433 opened: `who: 'attached'`
    on `dies` as well as on `attacks` and `combat-damage`. 52 legal lines print "enchanted creature
    dies" (**7** cards finished) and 17 "equipped creature dies" (**5**).

    D433 deferred these on a question about ordering, and the answer turned out to be a defect —
    see D437 and `fireTrigger`'s `attachedHost`.
  */
  {
    prologue: () => /^When (?:equipped|enchanted) creature dies, (.+)$/i,
    on: [{ kind: 'dies', who: 'attached' }],
  },
  {
    prologue: () => /^Whenever (?:equipped|enchanted) creature dies, (.+)$/i,
    on: [{ kind: 'dies', who: 'attached' }],
  },
  /*
    Kambal: "Whenever an opponent casts a noncreature spell". `by: 'opponent'` and
    `spell: 'noncreature'` are both printed and both load-bearing — the same event without them is
    every spell anybody casts, which is a very different card.
  */
  {
    prologue: () => /^Whenever an opponent casts a noncreature spell, (.+)$/i,
    on: [{ kind: 'spell-cast', by: 'opponent', spell: 'noncreature' }],
  },
  /*
    Judith, and the one word that separates this row from the one above it twice over.

    "A nontoken creature you control" is `who: 'any'` and not `'another'`: Judith is a nontoken
    creature you control, so she triggers on her own death, which her hand-written script says in
    as many words. And `nontoken: true` is the rest of the sentence — without it the tokens her own
    deck makes would each ping something on the way out, which is a card that works and is more
    generous than the print.
  */
  {
    prologue: () => /^Whenever a nontoken creature you control dies, (.+)$/i,
    on: [{ kind: 'dies', who: 'any', of: 'you', what: 'creature', nontoken: true }],
  },
  /*
    Battalion, which is a count of the attack rather than a different event: `withAtLeast: 3` is
    "this and at least two others", and the hand-written Firemane Avenger spells it exactly that
    way. The ability word in front of it is stripped before this is tried.
  */
  {
    prologue: (self) =>
      new RegExp(`^Whenever ${self} and at least two other creatures attack, (.+)$`, 'i'),
    on: [{ kind: 'attacks', withAtLeast: 3 }],
  },
  /*
    Hellrider: "Whenever a creature you control attacks". `who: 'any'` includes Hellrider's own
    attack, because it is a creature you control and the card means it — the hand-written script's
    own comment says so.
  */
  {
    prologue: () => /^Whenever a creature you control attacks, (.+)$/i,
    on: [{ kind: 'attacks', who: 'any', of: 'you' }],
  },
  // Chasm Skulker, and Fate Unraveler for the opponent's half. `by` defaults to `you`, which
  // `automation.ts` states outright — "a card that says nothing watches its own controller" — so the
  // bare form is what the hand-written card spells.
  {
    prologue: () => /^Whenever you draw a card, (.+)$/i,
    on: [{ kind: 'draws' }],
  },
  {
    prologue: () => /^Whenever an opponent draws a card, (.+)$/i,
    on: [{ kind: 'draws', by: 'opponent' }],
  },
];

/**
 * The colour words a token's printed description uses, as the letters a `CardDef` stores.
 *
 * `colorless` is in the table with no letter, because it is a thing the card says rather than
 * something it omits: "a 1/1 colorless Thopter artifact creature token" is explicit, and a reader
 * that treated the word as unrecognised would refuse the card.
 */
const TOKEN_COLOURS: Readonly<Record<string, Color | null>> = {
  white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', colorless: null,
};

/**
 * "Create a 1/1 white Spirit creature token with flying", as the token and the count.
 *
 * ## Why this family is readable at all, and exactly
 *
 * A token has no printed card to look up: its characteristics *are* the sentence that makes it. So
 * unlike every other family here, there is nothing to invent and nothing to guess — the clause
 * states the power, the toughness, the colour, the subtype and the keywords, and the pool's twenty
 * token definitions are character-for-character what that sentence says. `SPIRIT_TOKEN` is
 * `{ name: 'Spirit', typeLine: 'Token Creature — Spirit', power: '1', toughness: '1',
 * oracleText: 'Flying', colors: ['W'] }`, which is "a 1/1 white Spirit creature token with flying"
 * transcribed. D259's rule — never invent the text of a real card — is satisfied by construction
 * here in a way it is not anywhere else in this module.
 *
 * ## The keywords are validated by the reader that will have to read them back
 *
 * A token's keywords live in its `oracleText`, and the engine gets them from
 * `printedKeywords(def.oracleText)` with no script involved. So rather than keeping a list of
 * keywords this function believes in, it writes the oracle text and then **asks `printedKeywords`
 * whether that text yields exactly the keywords the clause named**. A token printed "with flying"
 * whose keyword the engine could not read back would be a 1/1 that silently cannot fly, which is
 * the quiet kind of wrong this module exists to avoid; here it refuses the clause instead.
 *
 * ## What it refuses, each for a stated reason
 *
 * - **`create X ... tokens`** — `countFrom` has no reading for `X`, and the pool's two instances
 *   are "where X is the number of Goblins you control" and "the number of +1/+1 counters on Chasm
 *   Skulker": a count read off the board, not the X chosen at cast time.
 * - **`... token for each ...`** — the same thing in another spelling, refused by the `$` anchor.
 * - **`with "When this creature dies, you gain 1 life"`** — a granted *ability*, not a keyword.
 *   `printedKeywords` returns nothing for that text, so the validation above refuses it.
 * - **`Create a Treasure token`** and **`a token that's a copy of target creature`** — no printed
 *   power and toughness, and in both cases the token carries rules text of its own.
 */
/**
 * A **count read off the board**, as the function an effect needs to ask for it.
 *
 * The sub-vocabulary `tokenEffect`'s docblock named as missing: "a count read off the board, not the
 * X chosen at cast time". Several printed grammars want the same number — `create X … tokens, where
 * X is <count>`, `deals damage equal to <count>`, `you gain life equal to <count>` — so the count is
 * read once, here, and the grammars share it. That is the same multiplying shape the trigger table
 * and `composeEffects` were: no new effect vocabulary, more cards.
 *
 * Every reading is a function the hand-written cards already use, which keeps the ground truth
 * exact — `creaturesOfSubtype` was Krenko's `goblinCount` until this needed it.
 *
 * ## The counters, and why the snapshot comes first
 *
 * `the number of +1/+1 counters on ~` is read from `subjectCounters` before the live instance, and
 * that order is the card: Chasm Skulker and Hangarback Walker both count the counters they had as
 * they **died**, and by the time a death trigger resolves the card is in a graveyard with none at
 * all (CR 608.2h). So the snapshot wins where there is one, and the live count answers everywhere
 * else — which is the reading both hand-written cards use and the only one that is right in both
 * places.
 *
 * ## The plural, which is where this could be wrong rather than incomplete
 *
 * A subtype count arrives plural — "the number of Goblins you control" — and the singular has to be
 * derived. Two rules: `-ves` becomes `-f` (Elves, Wolves, Dwarves) and otherwise a trailing `s` is
 * dropped. A word that does **not** end in `s` is refused outright, which is what keeps the
 * irregular plurals out: Fungi, Homunculi and Efreeti would each give a subtype no creature has, and
 * a count of zero is a card that resolves and does nothing — worse than an unread line, because an
 * unread line is flagged for a human (D362). Refusing them is the D259 answer: no reading rather
 * than a guessed one.
 */
function boardCount(phrase: string, name: string): ((c: EffectContext) => number) | null {
  const announced = /^the number of (.+)$/i.exec(plain(phrase).trim().replace(/\.$/, ''));
  return announced === null ? null : countOfThing(announced[1]!, name, 'plural');
}

/**
 * The same count asked the other way round: `… for each <thing>`.
 *
 * Magic writes one count in two grammars — "where X is the number of creature cards in your
 * graveyard" and "for each creature card in your graveyard" — and the difference is not only word
 * order: the first names the thing in the **plural** and the second in the **singular**. That is why
 * the noun's number is a parameter of the shared reader rather than something it guesses.
 */
function forEachCount(phrase: string, name: string): ((c: EffectContext) => number) | null {
  return countOfThing(plain(phrase).trim().replace(/\.$/, ''), name, 'singular');
}

/**
 * The token a `create …` clause names, and the count it printed — kept apart on purpose.
 *
 * `tokenEffect` reads the count from the sentence or from a tail; `xSpellResolution` reads it off
 * the spell's X. Both need the same **token definition**, and a second parser for it would be a
 * second place for "1/1 colorless Thopter artifact creature token with flying" to be read
 * differently. So the definition is parsed once here and the count is returned unread, as the word
 * the card printed, for the caller to make sense of.
 */
function tokenFrom(body: string): { token: CardDef; printed: string } | null {
  const made = /^create ([\w]+) (\d+)\/(\d+) (.+?) creature tokens?(?: with (.+))?$/i
    .exec(body.trim());
  if (made === null) return null;
  /*
    The middle is the colours, the subtype, and possibly the word "artifact": "white Spirit",
    "black and green Insect", "colorless Thopter artifact". Taken a word at a time from the front
    while the words are colours, which is what makes "and" unambiguous — it only ever joins two
    colour words in this phrase.
  */
  const words = made[4]!.trim().split(/\s+/);
  const colors: Color[] = [];
  let i = 0;
  for (; i < words.length; i += 1) {
    const word = words[i]!.toLowerCase();
    if (word === 'and' && colors.length > 0) continue;
    if (!(word in TOKEN_COLOURS)) break;
    const colour = TOKEN_COLOURS[word];
    if (colour !== undefined && colour !== null) colors.push(colour);
  }
  if (i === 0) return null;

  const rest = words.slice(i);
  const isArtifact = rest[rest.length - 1]?.toLowerCase() === 'artifact';
  const subtypeWords = isArtifact ? rest.slice(0, -1) : rest;
  /*
    A subtype is printed capitalised: "Spirit", "Elf Warrior".

    **Nothing in the pool exercises this**, and that is said rather than implied: deleting the check
    leaves all 82 ground-truth tests green, because the regex around it already requires a count, a
    power and toughness, a colour word, and "creature token" with nothing after it. So it is not
    load-bearing here and no test pins it — which by this session's own standard would normally mean
    deleting it.

    It stays, deliberately, because of which way it errs. This slot becomes the token's **name**, the
    pool is 348 cards against the tens of thousands #318 will import, and a lowercase word reaching
    it would produce a token named something that is not a creature type. Over-strictness costs
    coverage on a card nobody can name; over-permissiveness costs a wrong token on a card nobody has
    looked at yet. Revisit it when the bulk corpus can be measured, not before.
  */
  if (subtypeWords.length === 0 || !subtypeWords.every((word) => /^[A-Z][a-z'-]*$/.test(word))) {
    return null;
  }
  const subtype = subtypeWords.join(' ');

  const named = made[5] === undefined
    ? []
    : made[5].trim().replace(/\.$/, '').split(/,\s*|\s+and\s+/).map((k) => k.trim())
      .filter((k) => k !== '');
  const oracleText = named.length === 0
    ? ''
    : (() => {
      const line = named.join(', ');
      return line.charAt(0).toUpperCase() + line.slice(1);
    })();
  /*
    The validation this function's docblock argues for: the engine has to be able to read back every
    keyword the clause named, out of the text about to be written down.

    `printedLandwalk` counts beside `printedKeywords` because landwalk is not a keyword in this
    engine — it is its own characteristic (CR 702.14), so `KEYWORDS` has no `islandwalk` and a token
    "with islandwalk" was refused here even though the rules can express it. That refusal was right
    until #324: printed landwalk did nothing at all, so writing it down would have been a token whose
    text lied. Now that it is read, the token can have it, and this is the line that lets it.
  */
  const readBack = printedKeywords(oracleText).length + printedLandwalk(oracleText).length;
  if (readBack !== named.length) return null;

  const token: CardDef = {
    name: subtype,
    typeLine: `Token ${isArtifact ? 'Artifact ' : ''}Creature — ${subtype}`,
    manaCost: '',
    cmc: 0,
    power: made[2]!,
    toughness: made[3]!,
    oracleText,
    colors,
  };
  return { token, printed: made[1]! };
}

/**
 * The thing a count counts, as the function that counts it.
 *
 * Shared by both grammars above. `number` says whether the caller's grammar names the thing in the
 * plural or the singular, and it decides exactly one thing: how a **creature subtype** is read.
 * Every other row accepts either spelling with an optional `s`, because "lands you control" and
 * "land you control" are the same set.
 *
 * The subtype is the one place a wrong reading would be a card that resolves and does nothing, so
 * each grammar takes only the spelling it actually prints:
 *
 * - plural ("the number of Goblins you control") derives the singular: `-ves` becomes `-f` (Elves,
 *   Wolves, Dwarves), otherwise a trailing `s` is dropped, and a word that does **not** end in `s`
 *   is refused — which keeps Fungi, Homunculi and Efreeti out, each of which would give a subtype no
 *   creature has.
 * - singular ("for each Goblin you control") takes the word as printed and derives nothing, which is
 *   the only safe reading: stripping a letter would turn "Homunculus" into "Homunculu".
 */
function countOfThing(
  thing: string,
  name: string,
  number: 'plural' | 'singular',
): ((c: EffectContext) => number) | null {
  const text = thing.trim();
  const self = selfRef(name);

  if (/^lands? you control$/i.test(text)) {
    return (c) => landsControlled(c.state, c.controller);
  }
  if (/^artifacts? you control$/i.test(text)) {
    return (c) => artifactsControlled(c.state, c.controller);
  }
  if (/^creature cards? in your graveyard$/i.test(text)) {
    return (c) => creatureCardsInGraveyard(c.state, c.controller);
  }
  if (new RegExp(`^\\+1/\\+1 counters? on (?:${self}|it)$`, 'i').test(text)) {
    return (c) => {
      const snapshot = c.subjectCounters?.['+1/+1'];
      if (snapshot !== undefined) return snapshot;
      return c.state.instances[c.source]?.counters['+1/+1'] ?? 0;
    };
  }
  const tribe = /^([A-Z][A-Za-z'-]*) you control$/.exec(text);
  if (tribe !== null) {
    const word = tribe[1]!;
    if (number === 'singular') {
      return (c) => creaturesOfSubtype(c.state, c.controller, word);
    }
    if (!word.endsWith('s')) return null;
    const singular = word.endsWith('ves') ? `${word.slice(0, -3)}f` : word.slice(0, -1);
    if (singular.length < 3) return null;
    return (c) => creaturesOfSubtype(c.state, c.controller, singular);
  }
  return null;
}

/**
 * The two tokens the engine has **definitions** for, looked up by the name a card prints.
 *
 * Magic names a predefined token instead of describing it — "Create a Treasure token" — and the
 * reminder text in brackets after it is not rules text (CR 207.2). So the token's actual
 * characteristics are nowhere in the sentence, and a reader that wrote them out from the reminder
 * would be transcribing text the card does not print as rules: D259's rule, and the same argument
 * `investigate` is read by.
 *
 * The answer is the same one: look the definition up rather than build it. `TREASURE_TOKEN` and
 * `CLUE_TOKEN` are the engine's own, written and tested by D243, so a compiled Treasure is the same
 * object a hand-written card makes — including the sacrifice-for-mana ability that makes the mana
 * solver count it.
 *
 * ## Why only two names
 *
 * Because there are only two definitions. Food, Blood, Map, Powerstone and the rest are real
 * predefined tokens this engine has never needed, and the only way to read one would be to invent
 * its text. An unread line is dealt to a human (D362); an invented Food token is a card that plays
 * and is wrong. So the map **is** the validation, and the table grows when a definition does.
 *
 * The count is returned unread, as the word the card printed, exactly as `tokenFrom` returns it:
 * both go through `tokenEffect`'s own count machinery, so "two Treasure tokens" and "a Clue token
 * for each artifact you control" need nothing new here.
 */
const NAMED_TOKENS: Readonly<Record<string, CardDef>> = {
  Treasure: TREASURE_TOKEN,
  Clue: CLUE_TOKEN,
};

function namedTokenFrom(body: string): { token: CardDef; printed: string } | null {
  const made = /^create (\w+) (\w+) tokens?$/i.exec(body.trim());
  if (made === null) return null;
  /*
    The name is matched **case-sensitively** against the table, for `tokenFrom`'s reason: a token's
    name is a proper noun and every card prints it capitalised, so a lowercase word reaching here is
    not a name this reader recognises.
  */
  const token = NAMED_TOKENS[made[2]!];
  if (token === undefined) return null;
  return { token, printed: made[1]! };
}

function tokenEffect(clause: string, name: string): ReadEffect | null {
  /*
    The count's tail is taken off **before** the token itself is read, because `with (.+)` is greedy
    and would otherwise swallow it as a list of keywords. What is left is the same sentence a
    fixed-count token prints.

    Two tails, which are the two grammars Magic writes one count in:

    - `, where X is <the number of things>` — the count is announced and the token's own count is
      the letter X. Chasm Skulker and Krenko print this.
    - ` for each <thing>` — the count is a multiplier and the token's own count is "a", one per
      thing. Izoni and Hangarback Walker print this, and the noun is **singular**, which is why
      `forEachCount` exists beside `boardCount`.

    Reading both is what `tokenEffect`'s docblock listed as missing in two separate bullets, and they
    turn out to be one gap: the count, not the sentence.
  */
  const flat = clause.trim().replace(/\.$/, '');
  const announced = /^(.*?),\s*where X is (.+)$/i.exec(flat);
  const perThing = announced !== null ? null : /^(.*?) for each (.+)$/i.exec(flat);
  const counted = announced !== null
    ? boardCount(announced[2]!, name)
    : perThing !== null ? forEachCount(perThing[2]!, name) : null;
  if ((announced !== null || perThing !== null) && counted === null) return null;
  const body = announced?.[1] ?? perThing?.[1] ?? flat;

  /*
    Two shapes, one count. A described token carries its own power, toughness, colours and subtype;
    a named one carries none of them and is looked up. Either way what comes back is a definition
    and the printed count word, which is all the rest of this function reads.
  */
  const made = tokenFrom(body.trim()) ?? namedTokenFrom(body.trim());
  if (made === null) return null;

  // Either a printed number, or a board count to supply it — never both and never neither.
  const fixed = counted === null ? countFrom(made.printed) : null;
  if (counted === null && fixed === null) return null;
  /*
    What the printed count has to be when a tail supplies the real one: `X` for the announced
    grammar, and `a`/`an`/`one` for the per-thing one — "a token for each creature card" is one
    token per card, and a sentence that said "two tokens for each" would be a different number this
    reader is not reading.
  */
  if (counted !== null) {
    const word = made.printed.toLowerCase();
    const expected = announced !== null ? ['x'] : ['a', 'an', 'one'];
    if (!expected.includes(word)) return null;
  }

  /*
    The zero guard is the hand-written cards' own: Krenko and Chasm Skulker both return the state
    untouched when the count is nothing, rather than asking `createToken` for no tokens. Keeping it
    is what makes the compiled reading state-for-state equal to theirs.
  */
  if (counted !== null) {
    return {
      effect: (c) => {
        const n = counted(c);
        return n === 0 ? c.state : createToken(c.state, c.controller, made.token, n);
      },
    };
  }
  return { effect: (c) => createToken(c.state, c.controller, made.token, fixed!) };
}

/**
 * A clause about **the player the event was about** — "that player".
 *
 * Trigger-only, and by construction rather than by a rule somebody has to remember. "That player"
 * is `c.actor`, the seat whose action raised the event, and a stack object that is not a triggered
 * ability carries no actor at all: a *spell* printing this sentence would read `undefined` and
 * silently do nothing. That is the same hazard the X spells have in reverse (D399), answered the
 * same way — the reading lives on the path where the word means something, so the other path cannot
 * reach it.
 *
 * Both clauses carry the same guard, which is the hand-written cards' own: an event with no actor,
 * or one whose actor is the controller, does **nothing**. Fate Unraveler had `?? c.controller` there
 * until D407 and that was worse than nothing — it would have drained the controller, the opposite of
 * what the card says.
 */
function eventRelativeEffect(clause: string, name: string): ReadEffect | null {
  const text = plain(clause).trim().replace(/\.\s*$/, '');
  const self = selfRef(name);

  // Kambal: "that player loses 2 life and you gain 2 life".
  const drained = /^that player loses (\d+) life and you gain (\d+) life$/i.exec(text);
  if (drained !== null) {
    const lost = Number(drained[1]);
    const gained = Number(drained[2]);
    return {
      effect: (c) => {
        const who = c.actor;
        if (who === undefined || who === c.controller) return c.state;
        return gainLife(loseLife(c.state, who, lost), c.controller, gained);
      },
    };
  }

  // Fate Unraveler: "~ deals 1 damage to that player" — damage and not a drain, which is the whole
  // of D407.
  const dealt = new RegExp(`^(?:${self}|it) deals (\\d+) damage to that player$`, 'i').exec(text);
  if (dealt !== null) {
    const amount = Number(dealt[1]);
    return {
      effect: (c) => {
        const who = c.actor;
        if (who === undefined || who === c.controller) return c.state;
        return dealDamage(c.state, { kind: 'player', seat: who }, amount, {
          controller: c.controller, source: c.source,
        });
      },
    };
  }

  /*
    Hellrider: "~ deals 1 damage to the player or planeswalker it's attacking".

    `c.attacked` is what *that* attack was declared against, and it travels on the stack object
    rather than being looked up when the trigger resolves — by then the attacker may be dead and
    combat may no longer say what it was aimed at. In a pod three creatures can attack three
    different players and this card has to hit each of them once, which is why the whole attack
    travels and not just the seat.

    A planeswalker that was attacked takes the damage **instead of** its controller, which is the
    printed card and the reason the clause names both.
  */
  const rider = new RegExp(
    `^(?:${self}|it) deals (\\d+) damage to the player or planeswalker it['\u2019]s attacking$`, 'i',
  ).exec(text);
  if (rider !== null) {
    const amount = Number(rider[1]);
    return {
      effect: (c) => {
        if (c.attacked === undefined) return c.state;
        const hit: Target = c.attacked.planeswalker === undefined
          ? { kind: 'player', seat: c.attacked.defender }
          : { kind: 'card', id: c.attacked.planeswalker };
        return dealDamage(c.state, hit, amount, { controller: c.controller, source: c.source });
      },
    };
  }

  return null;
}

/**
 * A printed triggered-ability line, as the `triggers` fragment of a `CardScript`.
 *
 * The prologue says when it fires and comes from `TRIGGER_SHAPES`; the clause says what happens and
 * goes through the same `composeEffects` a spell's resolution does, so a trigger written as two
 * sentences composes and a trigger with one unreadable sentence is refused whole.
 *
 * The `description` is the printed clause, which is both the honest thing to store and what most of
 * the pool's hand-written cards store. The pool is not consistent about it — a few store the whole
 * line including the part `on` already says, and Ajani's Pridemate paraphrases "on Ajani's
 * Pridemate" as "on it" — which is why the ground-truth tests compare triggers by `on` and by
 * behaviour rather than by this string.
 */
function triggerFromLine(line: string, name: string): Partial<CardScript> | null {
  // The ability word comes off first: "Battalion — Whenever ~ and at least two other creatures
  // attack, …" is a trigger whose prologue begins after the dash (CR 207.2c).
  const text = withoutAbilityWord(plain(line).trim());
  const self = selfRef(name);
  for (const shape of TRIGGER_SHAPES) {
    const matched = shape.prologue(self).exec(text);
    if (matched === null) continue;
    const clause = matched[1]!.replace(/\.\s*$/, '').trim();
    /*
      "You may" — the optional triggered ability (D447).

      The commonest two words in all of Magic's trigger clauses, and until now they made the whole
      line unreadable: the clause vocabulary is about what an effect *does*, and "you may" is about
      whether it happens. **82 legal lines on 50 cards** are exactly this — a prologue this compiler
      already reads, a "you may", and an effect it already reads — among them *Gravedigger*,
      *Reclamation Sage*, *Consecrated Sphinx* and *Ninja of the Deep Hours*.

      It is read the way the pool's one hand-written optional trigger is (Ophidian, D116): a
      `ChoiceDecisionSpec` with two words and an effect that returns the board untouched when the
      answer is the second one. The engine has no optional-trigger flag and does not need one — a
      "may" **is** a question with two answers, and the table already draws a row of buttons for one.

      Two things are deliberate about the words.

      `'Yes'` is first, and `ChoiceDecisionSpec.options` documents the first option as the answer a
      bot falls back on when the card gives no `best`. That is the right fallback here and it is a
      measured claim rather than a hope: **every one of the 82 lines this reads is pure upside for
      the controller** — a draw, a counter on your own creature, a destroy, a bounce, an untap. Not
      one of them costs the controller anything, which is why no `best` is written and why the
      refusal below exists to keep that true as the clause vocabulary grows.

      A `may` whose effect asks its own question **was refused here, and is not any more (D450).**
      The engine asked a resolution's questions in order and could not skip a later one on an
      earlier answer, so "you may search your library for a basic land card" opened the library
      *before* the yes-or-no could be read — a player who declined had seen their library anyway,
      which is both a wrong reading and an information leak. It was recorded as a refusal rather
      than taken (D362), and the engine change it asked for is `DecisionSpec.askOnlyIfChosen`,
      which those questions now travel behind. The refusals left are a may whose effect runs
      something *before* its questions, and one whose question cannot be gated — both below.
    */
    /*
      Where the clause's own subject is when it runs, read off the **event** rather than guessed.

      A shape fires at a moment, and the moment says where the object the clause names by its own
      name or calls "it" has got to. `dies` and `to-graveyard` fire from a graveyard, so a card
      returning itself returns from there; every other shape here fires while the permanent is on
      the battlefield. The three that are genuinely open are `null`: a `leaves` subject could be in
      any of four zones, and a `to-exile` subject is in exile, where `return it to its owner's hand`
      is not a sentence this compiler has seen printed. (`undying` is a third open case in the
      engine's event vocabulary and is deliberately absent here: it is not a `TriggerDef['on']` kind
      at all, so naming it would be a comparison TypeScript refuses.)

      Every entry in `shape.on` is consulted rather than the first, because a shape may emit several
      events (the Aura and Equipment row emits two) and a reading that is right for one and wrong for
      another is the kind of drift D463 was. Disagreement means `null`.
    */
    const zones = new Set(shape.on.map((on) => (
      on.kind === 'dies' || on.kind === 'to-graveyard' ? 'graveyard' as const
        : on.kind === 'leaves' || on.kind === 'to-exile' ? null
          : 'battlefield' as const)));
    const where: SubjectZone | null = zones.size === 1 ? [...zones][0]! : null;
    /*
      The event-relative clauses first — "that player" is `c.actor`, which only a trigger has. See
      `eventRelativeEffect` for why that reading cannot live in the shared clause vocabulary.
    */
    const reader = (text: string): ReadEffect | null =>
      eventRelativeEffect(text, name) ?? composeEffects(clausesOf(text), name, where);
    /*
      **The whole clause is tried first, and that order is the guard.** Some clauses in the
      vocabulary already begin with "you may" and read as one phrase — a payment offered to the
      event's own player, for instance — and stripping the two words off those would hand the rest
      to a reader that was never written for it. So the strip is only reached when the clause does
      not read at all, which is the only case where there is nothing to lose.
    */
    const whole = reader(clause);
    /*
      **A "may" with a price on it** (D448): "you may pay {1}. If you do, draw a card."

      The second row of the queue D447 measured, and the same family one step on: 66 legal lines
      print it, of which **39 name a cost this engine can charge** — a mana run, hybrid symbols
      included. `ChoiceDecisionSpec.payIfChosen` is exactly this shape and has been since echo
      (#196): a price on one answer, which the engine pays before the effect runs and does not even
      **offer** when the seat cannot afford it, so a tapped-out player is never asked a question
      with one button.

      Tried before the bare "you may" below, because this clause begins with those two words too
      and stripping them would leave "pay {1}. If you do, …" for a reader that has never seen a
      payment.

      **What is refused, and all of it is a cost the engine cannot charge here.**
      `payIfChosen.cost` is a mana string, so: 19 lines pay energy (`{E}`, the Kaladesh commons —
      energy exists in this engine since #180 but not as a price on an answer), 4 pay life, and 4
      pay a mana cost **and** something else ("{1} and discard a card", "{2} and sacrifice a
      token"). `parseManaCost` is what refuses them rather than a second list of shapes: it records
      an unrecognised symbol instead of reading it as generic mana, which is the same guard D446's
      ability costs lean on.
    */
    /*
      **Energy, which D448 refused and could not then charge (D451).**

      It was the biggest single refusal that increment left behind — 19 lines there, 56 legal cards
      one line short once the whole family is counted — and the reason was narrow:
      `payIfChosen.cost` was a mana string. `payIfChosen.energy` is the same price in the other
      currency, and `AbilityCost.energy` has charged an *activated* ability in energy since #180,
      so the engine always knew how. `{E}{E}` is a count rather than a symbol run, which is why it
      is read here and not by `parseManaCost`: energy has no colours and no sources to tap, so
      there is nothing for a mana parser to do with it.
    */
    const energyPriced = whole === null
      ? /^you may pay ((?:\{E\})+)\.\s*If you do, (.+)$/i.exec(clause)
      : null;
    /*
      The mana price is tried **after** the energy one, and that order is load-bearing rather than
      tidy: `{E}` matches `\{[^}]+\}`, so the mana regex below matches an energy clause too and
      then hands "{E}{E}" to `parseManaCost`, which refuses it — and the whole line reads as
      nothing. That is exactly what the first run of this change did, and the measure caught it:
      coverage did not move a single card. A run of nothing but `{E}` is unambiguously energy, so
      asking that question first costs nothing and leaves the mana reader unchanged.
    */
    const priced = whole === null && energyPriced === null
      ? /^you may pay ((?:\{[^}]+\})+)\.\s*If you do, (.+)$/i.exec(clause)
      : null;
    /*
      The bare "may" regex is **not** guarded on `priced`, and a break run is why.

      It was written as `whole === null && priced === null ? …`, and breaking that guard — letting
      the bare regex match a priced clause too — changed nothing: all 1,506 tests stayed green. The
      guard could not fail, because the ordering between the two readings is decided below, where
      `inner` and `pay` both prefer `priced`. Two statements of one rule is the shape this file
      keeps removing (D441, D438), so the redundant one is gone and the selection below is the only
      lever. Breaking **that** does fail.
    */
    const may = whole === null ? /^you may (.+)$/i.exec(clause) : null;
    const charged = priced ?? energyPriced;
    const inner = charged !== null
      ? charged[2]!.trim()
      : may === null ? clause : may[1]!.trim();
    const read = whole ?? reader(inner);
    if (read === null) return null;
    /*
      Either kind of "may" is refused when its own effect asks a question, and for one reason: the
      engine asks a resolution's questions in order and cannot skip a later one on an earlier
      answer, so the effect's question would be put to a player who has not yet said yes. See the
      note under the bare "may" for what that costs.
    */
    /*
      A "may" whose own effect runs **before** its questions is still refused: `beforeDecisions`
      exists precisely to do something ahead of the asking (D418), so putting a yes-or-no in front
      of it would be putting the question after the effect.

      Its questions, though, are now carried behind `askOnlyIfChosen` (D450) rather than refusing
      the card — which is what lets "you may search your library for a basic land card" ask the
      yes-or-no first and open the library only on a yes. That was the biggest single thing left in
      this compiler's way: 128 legal cards one line short, 42 on the commonest sub-shape.
    */
    /*
      And a question this reader cannot put behind the gate: a retarget or a counter question
      (`askOnlyIfChosen` is declared `never` on both, because neither is a step a player declines),
      or a spec that is a **function** of the board rather than a literal — the flag would have to
      be added to whatever it returns, which cannot be checked here. Neither appears in the family
      this increment is for: every search in the corpus is a literal `CardsDecisionSpec`.
    */
    const gatable = (spec: DecisionSpecOf):
      spec is CardsDecisionSpec | ChoiceDecisionSpec | NumberDecisionSpec => typeof spec !== 'function'
        && (spec.from !== undefined || spec.options !== undefined || spec.range !== undefined);
    if ((may !== null || charged !== null)
      && (read.beforeDecisions !== undefined || !(read.decisions ?? []).every(gatable))) {
      return null;
    }
    const sentence = (text: string): string =>
      `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/\.$/, '')}`;
    const pricedCost = priced === null ? null : priced[1]!;
    if (pricedCost !== null) {
      const parsed = parseManaCost(pricedCost);
      if (parsed.unsupported !== undefined || parsed.x) return null;
    }
    // `{E}{E}` is two energy. The symbols are counted rather than parsed, for the reason above.
    const energyCost = energyPriced === null
      ? null
      : (energyPriced[1]!.match(/\{E\}/gi) ?? []).length;
    /*
      The words, and they are not symmetrical with the free "may" above on purpose.

      **The decline is first here**, where "Yes" is first there, because `options[0]` is the answer
      a bot falls back on and the two questions have different safe answers. A free may is pure
      upside, so taking it is safe; a may with a price can tap a player out, and
      `extort()`'s docblock already says which way that falls — "the engine answers with [the first
      option] when there is no real question to ask, and *do not spend mana* is the safe one of the
      two".

      **And no `best`.** Extort and echo both write one, because each knows something about its own
      question: extort fires after the turn's spell is already paid for, so its mana is mana the
      turn did not use. A compiled card knows nothing of the kind — this same shape covers paying
      {1} to draw a card and paying {4} to untap a Mana Vault — so the honest reading leaves the
      hint out and takes the safe answer. The consequence is stated rather than hidden: **the bot
      never pays one of these**, which is a play-quality gap and not a rules error, since a human
      is asked properly and the card does exactly what it says either way. Whether one generic
      `best` is worth more than the safe answer is a question for the deck table, not for a guess.
    */
    const pay = pricedCost !== null
      ? `Pay ${pricedCost}`
      : energyCost === null ? null : `Pay ${'{E}'.repeat(energyCost)}`;
    /*
      The effect's own questions, asked only if the "may" was taken (D450).

      A spec in `decisions` may be a function of the board rather than a literal
      (`DecisionSpecOf`), so the flag is added either by spreading the object or by wrapping the
      function — not by assuming one shape.
    */
    const gatedOn = (word: string): readonly DecisionSpecOf[] =>
      (read.decisions ?? []).filter(gatable).map((spec) => ({ ...spec, askOnlyIfChosen: word }));
    /*
      **The inner effect must not see this reader's own question.**

      The yes-or-no goes in front of the clause's questions, so every answer after it has shifted
      one place — and the clause's effect reads its answers by index (`chosenCard(c)` is
      `c.decisions[0]`). Handing it the whole list would have it read the yes-or-no's empty answer
      as "nothing was found", which is a search that offers the right cards and then does nothing
      with the one you pick. That is what the first run of this increment's runtime test caught.

      So the context handed on has the first answer dropped. The clause is then written exactly as
      it would be with no "may" in front of it, which is the point: the gate is this reader's
      business and not the clause's.
    */
    const withoutOurs = (c: EffectContext): EffectContext =>
      ({ ...c, decisions: c.decisions.slice(1) });
    const optional: Partial<TriggerDef> = pay !== null ? {
      decisions: [{
        who: 'controller',
        /*
          "Pay {1} — Draw a card?", rather than extort's "pay {W/B} so each opponent loses 1 life".
          A hand-written card can write one sentence because it knows its own clause; these clauses
          are not all the same grammar — "draw a card" is addressed to the player and "target
          creature gains double strike until end of turn" is about the board — and "Pay {R/W}{R/W}
          to target creature gains double strike" is not English. The dash joins the price to the
          printed words without having to inflect them.
        */
        prompt: `${pay} — ${sentence(inner)}?`,
        options: ['Decline', pay],
        payIfChosen: pricedCost !== null
          ? { option: pay, cost: pricedCost }
          : { option: pay, energy: energyCost! },
      }, ...gatedOn(pay)],
      effect: (c) => (chosenOption(c) === pay ? read.effect(withoutOurs(c)) : c.state),
    } : may === null ? {} : {
      decisions: [{
        who: 'controller',
        // The printed clause, as a question in the player's own words: "Draw a card?"
        prompt: `${sentence(inner)}?`,
        options: ['Yes', 'No'],
      }, ...gatedOn('Yes')],
      effect: (c) => (chosenOption(c) === 'Yes' ? read.effect(withoutOurs(c)) : c.state),
    };
    // `spellFlags` is deliberately not spread: it is advice about casting a spell, and a triggered
    // ability is not cast. See `targetedEffect`.
    return {
      triggers: shape.on.map((on) => ({
        on,
        description: clause,
        ...(read.targets === undefined ? {} : { targets: read.targets }),
        ...(read.decisions === undefined ? {} : { decisions: read.decisions }),
        // See the split in `composeEffects` (D418): a trigger asks before it runs, as a spell does.
        ...(read.beforeDecisions === undefined ? {} : { beforeDecisions: read.beforeDecisions }),
        effect: read.effect,
        // Last, so the yes-or-no and its wrapped effect replace the unconditional pair above.
        ...optional,
      } as TriggerDef)),
    };
  }
  return null;
}

/**
 * A permanent target restricted to one or more card types, as a `TargetSpec.filter`.
 *
 * The types are read from `characteristicsOf`, which is the live type line rather than the printed
 * one: a land that has become a creature is a legal "target creature", and an Equipment that has
 * become a creature is a legal "target creature" too (CR 109.2 — an object's characteristics are
 * what they are now). Several of the hand-written specs in this file read
 * `state.cardDefs[...].typeLine` instead, which is the *printed* line and so disagrees with their
 * own docblocks — `destroyAnArtifactOrEnchantment` says in as many words that it reads
 * `characteristicsOf`, and does not. That divergence is recorded as task #319 rather than fixed
 * here, because it changes which permanents five shipped cards may point at and so wants its own
 * measurement and decision-log entry.
 */

/**
 * The three qualifiers a printed permanent phrase can carry, as one `TargetSpec.filter`.
 *
 * "Another", "nonland" and "an opponent controls" compose freely in printed text — the pool prints
 * `another target nonland permanent`, `target nonland permanent an opponent controls` and
 * `another target nonland permanent an opponent controls`, and each has its own hand-written filter
 * spelling the same three tests in a different subset. One composable factory is the honest shape:
 * three independent facts about a candidate, not seven phrases each with its own function.
 *
 * `nonland` reads the **live** type line (CR 109.2), for the reason `permanentOfTypes` gives: an
 * animated Mutavault is still a land and a land that became a creature is still not a legal
 * "nonland permanent".
 */
const permanentFilter = (
  opts: {
    readonly another?: boolean;
    readonly nonland?: boolean;
    readonly opponents?: boolean;
    /** One of these types, read **live** rather than off the printed line — see `permanentOfTypes`. */
    readonly types?: readonly string[];
    /**
     * "with power N or greater", and the power is the **current** one.
     *
     * Both hand-written filters that print this phrase say so in a comment: a 2/2 pumped past five
     * is a legal target for Selesnya Charm and a 6/6 shrunk below it is not, which is the whole
     * reason characteristics are computed on demand rather than stored. Reading the printed power
     * instead would be the #319 defect in a new place.
     */
    readonly powerAtLeast?: number;
    /** "target creature you control" — the other side of `opponents`, and not its negation. */
    readonly yours?: boolean;
    /**
     * A colour the candidate must be, any one of them: "target **black** creature", and
     * "target creature that's white or blue" is the same disjunction spelled out (CR 105.2).
     */
    readonly colours?: readonly Color[];
    /** A colour the candidate must **not** be: "target **nonblack** creature" (CR 105.3). */
    readonly notColours?: readonly Color[];
    /** "target **tapped** creature", and `false` for "untapped". */
    readonly tapped?: boolean;
    /** "target **attacking** creature" / "target **blocking** creature", read off the combat. */
    readonly attacking?: boolean;
    readonly blocking?: boolean;
    /** "target creature **with flying**", read **live** so a granted keyword counts (CR 109.2). */
    readonly keyword?: Keyword;
    /** "target **legendary** creature", and `false` for "nonlegendary" — a supertype (CR 205.4). */
    readonly legendary?: boolean;
    /** "target **nonbasic** land": the other supertype a printed target phrase names. */
    readonly basic?: boolean;
  },
): NonNullable<TargetSpec['filter']> => (state, candidate, controller, source) => {
  if (candidate.kind !== 'card') return false;
  // "Another" means not the permanent whose ability this is — a Banishing Light cannot exile itself.
  if (opts.another === true && candidate.id === source) return false;
  const inst = state.instances[candidate.id];
  if (inst === undefined) return false;
  if (opts.opponents === true && inst.zoneSeat === controller) return false;
  if (opts.yours === true && inst.zoneSeat !== controller) return false;
  /*
    Everything below is read **live** (CR 109.2), which is the discipline this factory exists to
    keep and the defect #319 recorded in five hand-written filters that read the printed line
    instead. An animated Mutavault is a legal "target creature"; a creature given flying is a legal
    "target creature with flying"; a white creature turned black by a Painter's Servant is no longer
    a legal "target nonblack creature". Reading the printed card would disagree with the board the
    player is looking at in every one of those cases.
  */
  const live = characteristicsOf(state, inst);
  if (opts.nonland === true && hasType(live.typeLine, 'land')) return false;
  if (opts.types !== undefined
    && !opts.types.some((type) => hasType(live.typeLine, type))) return false;
  if (opts.powerAtLeast !== undefined && live.power < opts.powerAtLeast) return false;
  if (opts.colours !== undefined
    && !opts.colours.some((colour) => live.colors.includes(colour))) return false;
  if (opts.notColours !== undefined
    && opts.notColours.some((colour) => live.colors.includes(colour))) return false;
  if (opts.tapped !== undefined && inst.tapped !== opts.tapped) return false;
  if (opts.legendary !== undefined && isLegendary(live.typeLine) !== opts.legendary) return false;
  /*
    `basic` is a **supertype**, read off the printed line rather than live, and that is the one
    deliberate exception to the paragraph above: nothing in Magic makes a land basic or unbasic, and
    `characteristicsOf` does not carry supertypes through its type-changing layers — an animated
    Mutavault keeps its printed supertypes, which is what the phrase means. `isBasicLand` is the
    function `RAMPANT_GROWTH` has used since #28 rather than a second one beside it.
  */
  if (opts.basic !== undefined && isBasicLand(state, candidate.id) !== opts.basic) return false;
  if (opts.keyword !== undefined && !live.keywords.has(opts.keyword)) return false;
  /*
    The combat tests, which are the only ones here that read something other than the permanent.
    `attackingOrBlocking` already does this for the phrase that takes either; these are the halves,
    which the corpus prints separately ("target attacking creature", "target blocking creature").
  */
  if (opts.attacking === true
    && !state.combat.attacks.some((a) => a.attacker === candidate.id)) return false;
  if (opts.blocking === true
    && !state.combat.attacks.some((a) => a.blockers.includes(candidate.id))) return false;
  return true;
};


/**
 * A printed target phrase, as the spec the engine points with.
 *
 * `friendly` is not read off the phrase and cannot be: "target creature" is the same four
 * characters on a Doom Blade and on a Giant Growth. It is a fact about the **effect**, so the
 * caller supplies it — see `TargetSpec.friendly`, and D252, which added the flag because the bot's
 * default is "the enemy and the enemy's creatures". A pump that forgets it is not illegal; it is a
 * bot that buffs the creature it is about to kill, which is a silent degradation rather than a
 * refusal, and so exactly the kind of wrong this compiler must not be.
 *
 * ## The description is the printed phrase, and that is not a shortcut
 *
 * Every spec below stores the phrase it was read from. That happens to be character-for-character
 * what the hand-written twin stores — `TARGET_PLAYER` says `'target player'`, `yourGraveyardCreature`
 * says `'target creature card in your graveyard'`, Banisher Priest's spec says `'target creature an
 * opponent controls'` — because a prompt a person reads should say what the card says. The
 * ground-truth tests compare the two strings, so the day a hand-written description stops being the
 * printed phrase, that is the thing that fails.
 *
 * ## "You don't control" and "an opponent controls" share a filter, as they already did
 *
 * They are the same thing in a duel and not quite in a pod, where the difference would be a
 * creature nobody controls. `creatureYouDontControl` is what both hand-written halves of Mizzium
 * Mortars ask, and its docblock there argues the case; this reads them the same way for the same
 * reason rather than inventing a second answer.
 */
function targetSpecFrom(
  phrase: string,
  friendly: boolean,
  /**
   * Whether the **parsed** vocabulary is available, or only the exact phrases in the switch.
   *
   * One caller passes `false`, and it is the Aura host (D469). "What may this phrase be pointed at"
   * and "what may an Aura be attached to" are different questions, and the Aura reader had been
   * answering the second with the first — it accepted whatever `targetSpecFrom` could build and
   * refused what it could not. That worked while the switch was a fixed list and stopped working
   * the moment this function learned to parse: `Enchant planeswalker` and `Enchant land you
   * control` began to read, and `compile.test.ts` had a table of five printed Aura declarations
   * asserting exactly that they do not. Two of the five broke on the first full-suite run.
   *
   * Those refusals are kept as they were rather than widened in passing. An Aura is attached by
   * writing `attachedTo` with a card id and then policed by CR 704.5m (D305), so whether this
   * engine can carry an Aura on a planeswalker or on a land you control is a question about the
   * attachment machinery with its own cards to count — not a side effect of a target-phrase
   * change. The flag makes the Aura's narrower vocabulary a **stated rule** instead of an accident
   * of how much of Magic this switch happened to cover.
   */
  parsed = true,
): TargetSpec | null {
  const trimmed = plain(phrase).trim();
  /*
    Lower-cased at the front, because the same phrase arrives both ways: `Target creature gets
    +3/+3` starts a sentence and `destroy target creature` does not, and they are one phrase. The
    description is prompt text a player reads mid-question — "choose target creature" — so lower
    case is the right form, and it is the form all thirty-odd hand-written descriptions use. The
    first word of a target phrase is always `target`, `another` or `any`, never a name, so there is
    nothing a capital could be carrying. The ground-truth test on Giant Growth found this the first
    time it ran: echoing the printed phrase verbatim gave it `Target creature`.
  */
  const printed = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  const helped = friendly ? { friendly: true as const } : {};
  const spec = (rest: Omit<TargetSpec, 'description'>): TargetSpec =>
    ({ ...rest, description: printed, ...helped });

  switch (printed.toLowerCase()) {
    case 'any target': return spec({ kind: 'any' });
    case 'target creature': return spec({ kind: 'creature' });
    /*
      "with power N or greater", the phrase Selesnya Charm's second mode and Hidden Dragonslayer's
      turned-face-up trigger both print. The number is read rather than fixed, because the two cards
      print different ones — five and four — and a reader that took either as the rule would make
      one of them point at creatures the print excludes.
    */
    case 'target creature with power 4 or greater':
    case 'target creature with power 5 or greater':
    case 'target creature with power 6 or greater':
      return spec({
        kind: 'creature',
        filter: permanentFilter({ powerAtLeast: Number(/(\d+)/.exec(printed)![1]) }),
      });
    case 'target creature an opponent controls with power 4 or greater':
    case 'target creature an opponent controls with power 5 or greater':
    case 'target creature an opponent controls with power 6 or greater':
      return spec({
        kind: 'creature',
        filter: permanentFilter({
          opponents: true, powerAtLeast: Number(/(\d+)/.exec(printed)![1]),
        }),
      });
    case 'target permanent': return spec({ kind: 'permanent' });
    case 'another target permanent':
      return spec({ kind: 'permanent', filter: permanentFilter({ another: true }) });
    case 'target nonland permanent':
      return spec({ kind: 'permanent', filter: permanentFilter({ nonland: true }) });
    case 'another target nonland permanent':
      return spec({ kind: 'permanent', filter: permanentFilter({ another: true, nonland: true }) });
    case 'target nonland permanent an opponent controls':
      return spec({ kind: 'permanent', filter: permanentFilter({ nonland: true, opponents: true }) });
    case 'another target nonland permanent an opponent controls':
      return spec({
        kind: 'permanent',
        filter: permanentFilter({ another: true, nonland: true, opponents: true }),
      });
    case 'target player': return spec({ kind: 'player' });
    case 'target player or planeswalker': return spec({ kind: 'player-or-planeswalker' });
    case 'target spell': return spec({ kind: 'spell' });

    /*
      The objects on the stack, which are three kinds and not one.

      `spell` is a card, `ability` is not, and `spell-or-ability` exists because a card that takes
      either should say so rather than hope whatever it is handed has an `id` — `TargetSpec.kind`'s
      own docblock calls these three "the printed difference between a Cancel, a Stifle and a
      Disallow". Each filter here is the function the hand-written card already uses, so the spec a
      compiled Negate carries is the spec the written one carries, not a lookalike.

      The activated-ability case is the only spec in this switch whose kind is `ability`, and it
      needs the filter: `kind: 'ability'` alone would let a Squelch be pointed at a triggered
      ability, which is a strictly better card than the one printed.
    */
    case 'target creature spell':
      return spec({ kind: 'spell', filter: isCreatureSpell });
    case 'target noncreature spell':
      return spec({ kind: 'spell', filter: isNoncreatureSpell });
    case 'target activated ability':
      return spec({ kind: 'ability', filter: isActivatedAbility });
    case 'target spell or ability':
      return spec({ kind: 'spell-or-ability' });

    // The phrases that restrict by who controls the permanent. `friendly` is still threaded
    // through: the filter makes it moot here, since every legal candidate is already on the side
    // the phrase names, and dropping it would be a special case to remember rather than a rule.
    case 'target creature you control':
      return spec({ kind: 'creature', filter: creatureYouControl });
    case "target creature you don't control":
    case 'target creature an opponent controls':
      return spec({ kind: 'creature', filter: creatureYouDontControl });

    // The phrases that restrict by type. `kind: 'permanent'` plus a filter is how every
    // hand-written one of these is written; there is no `kind: 'artifact'`.
    // The only phrase here that reads the combat rather than the board.
    case 'target attacking or blocking creature':
      return spec({ kind: 'creature', filter: attackingOrBlocking });

    case 'target artifact':
      return spec({ kind: 'permanent', filter: permanentOfTypes('artifact') });
    case 'target enchantment':
      return spec({ kind: 'permanent', filter: permanentOfTypes('enchantment') });
    case 'target land':
      return spec({ kind: 'permanent', filter: permanentOfTypes('land') });
    case 'target artifact or enchantment':
      return spec({ kind: 'permanent', filter: permanentOfTypes('artifact', 'enchantment') });
    /*
      The same two types, restricted to an opponent's, which is Ainok Survivalist's phrase and the
      first place the type list and the controller test compose. Its own comment says why the
      restriction matters more here than on a Naturalize: the trigger is **mandatory**, so without
      it a morph turned up on an otherwise empty board would have to destroy its controller's own
      Sol Ring.
    */
    case 'target artifact or enchantment an opponent controls':
      return spec({
        kind: 'permanent',
        filter: permanentFilter({ opponents: true, types: ['artifact', 'enchantment'] }),
      });

    // A card in a graveyard is a different object from a permanent, with its own target kinds.
    case 'target creature card in your graveyard':
      return spec({ kind: 'graveyard-creature', filter: yourGraveyardCreature.filter });
    case 'target land card in your graveyard':
      return spec({ kind: 'graveyard-land', filter: yourGraveyardLand.filter });

    default: break;
  }

  /*
    Everything the switch above does not spell out, **parsed** rather than enumerated (D469).

    The switch is thirty-odd exact phrases and it cannot grow to cover this family, because printed
    target phrases are **combinatorial**: a quantifier, a run of qualifiers in no fixed order, a
    noun, and a controller clause. `another target nonblack creature you control` is four independent
    facts, and a list of whole phrases would need one entry per combination the corpus happens to
    print — which is exactly how `permanentDescribed` (D465) ended up as a parser rather than a list.

    Measured before it was written, by the `phrase-gap.mjs` method: target phrases appear on **5,978**
    one-line-short cards and substituting one known to read finishes **299**, which is the largest
    family this compiler has had in front of it. It is large because `targetSpecFrom` is the
    chokepoint for *every* targeted reader at once — damage, destroy, exile, bounce, the counters,
    the discard's `target opponent` form — so one phrase read here lifts all of them.

    The switch stays, in front, and is not folded into the parser: those thirty phrases are the ones
    whose specs are compared character-for-character against a hand-written twin by
    `compiled-vs-written.test.ts`, and some carry a hand-written `filter` function by reference
    (`yourGraveyardCreature.filter`). An exact-phrase fast path that cannot drift is worth more there
    than one fewer code path.
  */
  if (!parsed) return null;
  const read = parsedTargetPhrase(printed);
  return read === null ? null : spec(read);
}

/**
 * A printed target phrase's quantifier, as `TargetSpec`'s own `count` and `optional`.
 *
 * Both fields already existed — `count` is "how many of this spec", `optional` is "up to", castable
 * with fewer including none — so the quantifiers needed **no engine change at all**, only reading.
 * That was checked before the increment was scoped rather than assumed.
 *
 * `another` is not a count: it is `permanentFilter`'s `another`, excluding the permanent whose
 * ability this is. It travels in this table because the words it shares a slot with are counts, and
 * a phrase may carry both ("up to one other").
 */
const TARGET_QUANTIFIERS: Readonly<Record<string, {
  readonly count?: number;
  readonly optional?: true;
  readonly another?: true;
}>> = {
  '': {},
  another: { another: true },
  'up to one': { optional: true },
  'up to one other': { optional: true, another: true },
  'up to two': { optional: true, count: 2 },
  'up to two other': { optional: true, count: 2, another: true },
  'up to three': { optional: true, count: 3 },
  'each of up to two': { optional: true, count: 2 },
  'each of up to three': { optional: true, count: 3 },
  two: { count: 2 },
  three: { count: 3 },
};

/**
 * The quantifier words a target phrase may open with, as a regex fragment for the **callers**.
 *
 * `parsedTargetPhrase` reads the quantifier, but it only ever sees a phrase a reader handed it — and
 * every reader's own regex was anchored on the literal word `target`, so `destroy another target
 * creature you control` never reached it at all. Five readers (destroy, exile, return-to-hand,
 * counter, untap) share this fragment rather than each repeating the alternation, which is the
 * difference between adding a quantifier in one place and adding it in six.
 *
 * Kept in step with `TARGET_QUANTIFIERS` by construction: it is built from that table's own keys,
 * longest first so `up to one other` wins over `up to one`.
 */
const TARGET_QUANTIFIER_PREFIX = `(?:${Object.keys(TARGET_QUANTIFIERS)
  .filter((word) => word !== '')
  .sort((a, b) => b.length - a.length)
  // Each alternative carries its own trailing space. Joining on a bare `|` and putting one space
  // at the end gives it to the LAST alternative only, so `another target creature` matched nothing
  // while `two target creatures` matched — which is how this was found.
  .map((word) => `${word} `)
  .join('|')})?`;

/** The nouns a printed target phrase ends in, and the `TargetSpec.kind` each one is. */
const TARGET_NOUNS: Readonly<Record<string, {
  readonly kind: TargetSpec['kind'];
  readonly types?: readonly string[];
}>> = {
  creature: { kind: 'creature' },
  permanent: { kind: 'permanent' },
  artifact: { kind: 'permanent', types: ['artifact'] },
  enchantment: { kind: 'permanent', types: ['enchantment'] },
  land: { kind: 'permanent', types: ['land'] },
  planeswalker: { kind: 'permanent', types: ['planeswalker'] },
};

/**
 * One printed target phrase, decomposed — or `null`, which leaves the line unread.
 *
 * The grammar, in the order it is peeled off, which is the order printed English puts it in:
 *
 * ```
 * [quantifier] target [qualifier…] <noun>[s] [with <keyword>] [<controller clause>]
 * ```
 *
 * **Refusing is the default.** A word that is not in one of the tables below refuses the whole
 * phrase, so an unrecognised qualifier leaves the line unread rather than widening what the card may
 * be pointed at. That is D362 where it matters most: a wrong *target* is not a card that does too
 * little, it is a removal spell aimed at the wrong permanent, and the bot will take that play.
 *
 * ## What is deliberately not here
 *
 * - **Subtypes** ("target Wall", "target Merfolk you control", 3 + 2 + … cards). Printed text
 *   capitalises a subtype and lower-cases a qualifier, which is exactly the signal needed — and
 *   `targetSpecFrom` lower-cases its phrase at the top, for the description's sake, before this is
 *   reached. Reading them means keeping the printed case alongside, which is a change to that
 *   function's contract rather than a line here.
 * - **"defending player controls"** (2 cards). The defending player is a fact about *an attack*, and
 *   a `TargetSpec.filter` is handed the state, the candidate, the controller and the source — not
 *   which attack this is. `attackingOrBlocking` can read `state.combat` because "is this creature
 *   attacking" is a question about the board; "whose defender is it" is not.
 * - **"that was dealt damage this turn"** (5 + 5 cards). Damage marked on a permanent is state the
 *   engine keeps, but "this turn" needs a per-turn record of *who was dealt* damage rather than how
 *   much is on them now — a creature healed to zero marked damage was still dealt it. That is an
 *   engine fact to add, not a filter to write.
 */
function parsedTargetPhrase(printed: string): Omit<TargetSpec, 'description'> | null {
  const whole = printed.trim().toLowerCase();
  const opened = /^(another|up to one other|up to one|up to two other|up to two|up to three|each of up to two|each of up to three|two|three)?\s*target\s+(.+)$/i
    .exec(whole);
  if (opened === null) return null;
  const quantifier = TARGET_QUANTIFIERS[(opened[1] ?? '').trim().toLowerCase()];
  if (quantifier === undefined) return null;
  const counted = {
    ...(quantifier.count === undefined ? {} : { count: quantifier.count }),
    ...(quantifier.optional === true ? { optional: true } : {}),
  };
  let body = opened[2]!.trim();

  /*
    The players, which have no qualifiers and no noun to parse. "Target opponent" is `kind: 'player'`
    with a filter, and that works because `satisfies` runs a spec's filter over a player candidate
    just as it does over a card — checked in `targeting.ts` rather than hoped for.

    It is worth reading early for a second reason: it is what D468 had to leave out of the discard
    family, and the same spec lifts `target opponent loses N life` and `target opponent mills N`
    with it.
  */
  if (body === 'opponent' || body === 'opponent or planeswalker') {
    return {
      kind: body === 'opponent' ? 'player' : 'player-or-planeswalker',
      filter: (_state, candidate, controller) => (candidate.kind === 'player'
        ? candidate.seat !== controller
        // The planeswalker half of "target opponent or planeswalker": not one of yours.
        : candidate.kind === 'card' && _state.instances[candidate.id]?.zoneSeat !== controller),
      ...counted,
    };
  }

  // "with flying" — a keyword, read live, so a granted one counts.
  let keyword: Keyword | undefined;
  const withKeyword = /^(.*?)\s+with\s+([a-z]+)$/i.exec(body);
  if (withKeyword !== null) {
    const word = withKeyword[2]!.toLowerCase();
    // A word the engine cannot test is not a filter (D259's rule applied to one): refuse the phrase.
    if (!isKeyword(word)) return null;
    keyword = word;
    body = withKeyword[1]!.trim();
  }

  // The controller clause, which is always last in the printed phrase.
  let yours: true | undefined;
  let opponents: true | undefined;
  for (const [clause, side] of [
    [' you control', 'yours'],
    [" you don't control", 'opponents'],
    [' an opponent controls', 'opponents'],
  ] as const) {
    if (!body.toLowerCase().endsWith(clause)) continue;
    if (side === 'yours') yours = true; else opponents = true;
    body = body.slice(0, body.length - clause.length).trim();
    break;
  }

  // What is left is a run of qualifiers and then the noun, singular or plural.
  const words = body.split(/\s+/).filter((word) => word !== '');
  const noun = TARGET_NOUNS[(words.pop() ?? '').replace(/s$/, '')];
  if (noun === undefined) return null;

  const colours: Color[] = [];
  const notColours: Color[] = [];
  let tapped: boolean | undefined;
  let attacking: true | undefined;
  let blocking: true | undefined;
  let legendary: boolean | undefined;
  let basic: boolean | undefined;
  const types = [...(noun.types ?? [])];
  for (const word of words) {
    const negated = word.startsWith('non') ? word.slice(3) : null;
    const colour = COLOUR_WORDS[word];
    const negatedColour = negated === null ? undefined : COLOUR_WORDS[negated];
    if (colour !== undefined) { colours.push(colour); continue; }
    if (negatedColour !== undefined) { notColours.push(negatedColour); continue; }
    if (word === 'tapped') { tapped = true; continue; }
    if (word === 'untapped') { tapped = false; continue; }
    if (word === 'attacking') { attacking = true; continue; }
    if (word === 'blocking') { blocking = true; continue; }
    if (word === 'legendary') { legendary = true; continue; }
    if (word === 'nonlegendary') { legendary = false; continue; }
    if (word === 'basic') { basic = true; continue; }
    if (word === 'nonbasic') { basic = false; continue; }
    /*
      A type word in front of the noun — "target **artifact** creature" — which is a second type the
      candidate must also have, not an alternative to the noun's.
    */
    if (PERMANENT_TYPES.includes(word)) { types.push(word); continue; }
    // Anything else: the phrase stays unread. See the docblock.
    return null;
  }

  const filter = permanentFilter({
    ...(quantifier.another === true ? { another: true } : {}),
    ...(yours === undefined ? {} : { yours: true }),
    ...(opponents === undefined ? {} : { opponents: true }),
    ...(types.length === 0 ? {} : { types }),
    ...(colours.length === 0 ? {} : { colours }),
    ...(notColours.length === 0 ? {} : { notColours }),
    ...(tapped === undefined ? {} : { tapped }),
    ...(attacking === undefined ? {} : { attacking }),
    ...(blocking === undefined ? {} : { blocking }),
    ...(legendary === undefined ? {} : { legendary }),
    ...(basic === undefined ? {} : { basic }),
    ...(keyword === undefined ? {} : { keyword }),
  });
  return { kind: noun.kind, filter, ...counted };
}

/** Whether a spec points at something `destroy`, `bounceToHand` and the like can be given. */
const pointsAtAPermanent = (spec: TargetSpec): boolean =>
  spec.kind === 'creature' || spec.kind === 'permanent';

/**
 * Whether a spec points at an object on the **stack**, which is what `counterSpell` can be given.
 *
 * The same job `pointsAtAPermanent` does for destroy and bounce, and needed for the same reason:
 * `targetSpecFrom` can return a creature or a player, and "counter target creature" is not a card.
 * Without the guard the first printed sentence of that shape would compile into a spell that points
 * at a permanent and hands its id to a function that expects a stack object.
 */
const pointsAtTheStack = (spec: TargetSpec): boolean =>
  spec.kind === 'spell' || spec.kind === 'ability' || spec.kind === 'spell-or-ability';

/**
 * The damage family, which is one family because its readings differ only in **where the damage
 * goes**.
 *
 * Two spellings of the subject: a spell names itself ("Lightning Bolt deals 3 damage to any
 * target") and a trigger says "it" ("When Flametongue Kavu enters the battlefield, it deals 4
 * damage to target creature"), because a trigger's subject is already established by the time the
 * clause starts.
 *
 * The destinations are what decides whether the clause needs a target at all. "Any target" and
 * "target creature" are chosen by whoever casts it; "each opponent" and "you" are not, and reading
 * them through `targetSpecFrom` would have produced a spell that asks a question it does not print.
 * Keeping all four in one function is the reason it is not `untargetedEffect` and
 * `targetedEffect` both holding half the family and disagreeing later about the amount.
 */
/**
 * "each creature", "each creature with flying and each player": damage with no target at all.
 *
 * The sweep is a **destination**, not a target spec, which is why it is read here rather than by
 * `targetSpecFrom`: nothing is chosen, nothing can be made illegal, and nothing is put on the stack
 * for an opponent to answer by killing the creature it points at. So the amount is handed in and
 * what comes back is the whole dealing.
 *
 * One function for both callers, which is the point. `xSpellResolution` already read "each
 * creature" for Savage Twister and `damageEffect` read none of this, so the printed-number cards
 * had no path at all — and giving each of them its own grammar would be two readings of one
 * phrase, free to disagree about "and each player" the way the two type-line readings in #319
 * disagreed about a filter.
 *
 * ## Three things taken from the hand-written cards rather than invented
 *
 * - **The keyword must be one the engine knows.** `isKeyword` refuses anything else, so "each
 *   creature with shroud" on a card whose keyword this engine has never implemented is an unread
 *   line (D362) rather than a sweep that quietly hits everything. D259's rule applied to a filter:
 *   a word the engine cannot test is not a filter.
 * - **"and each player" is every seat, including yours.** Hurricane and Breath of Darigaaz both
 *   loop `state.seats` and skip only the eliminated ones, and that is the card: a Hurricane for
 *   four with two fliers out kills its own caster as readily as anybody.
 * - **There is no zero branch, and one would be unfalsifiable.** Both hand-written sweeps open with
 *   `if (c.x === 0) return c.state`, and a break run established that copying it here changes
 *   nothing any test can see: `dealDamage` itself returns the state untouched for a non-positive
 *   amount, so a Savage Twister cast for X=0 deals nothing either way. Rather than keep a check
 *   that cannot fail — D415's lesson, the second time — this relies on `dealDamage`'s refusal, and
 *   a test pins the equality with the hand-written card at zero so a change there is a failure here
 *   rather than a silent divergence.
 *
 * The creature list is taken **once**, before any damage is dealt, which both hand-written cards
 * also do: a creature that dies to the first point is still dealt its share, and one that arrives
 * mid-resolution — nothing in this pool, but a replacement effect could — is not.
 */
function sweepDestination(
  where: string,
): ((c: EffectContext, amount: number) => GameState) | null {
  const matched = /^each creature(?: (with|without) ([a-z]+))?( and each player)?$/i
    .exec(where.trim());
  if (matched === null) return null;
  let keyword: Keyword | null = null;
  if (matched[2] !== undefined) {
    const word = matched[2].toLowerCase();
    if (!isKeyword(word)) return null;
    keyword = word;
  }
  const negated = matched[1]?.toLowerCase() === 'without';
  const players = matched[3] !== undefined;
  return (c, amount) => {
    let state = c.state;
    const hit = battlefield(state, (cardId) => {
      const inst = state.instances[cardId];
      if (inst === undefined) return false;
      const ch = characteristicsOf(state, inst);
      if (!ch.isCreature) return false;
      return keyword === null ? true : ch.keywords.has(keyword) !== negated;
    });
    for (const id of hit) {
      state = dealDamage(state, { kind: 'card', id }, amount, {
        controller: c.controller, source: c.source,
      });
    }
    if (!players) return state;
    for (const seat of state.seats) {
      if (seat.eliminated) continue;
      state = dealDamage(state, { kind: 'player', seat: seat.index }, amount, {
        controller: c.controller, source: c.source,
      });
    }
    return state;
  };
}

/**
 * Whether a reading carries a **divided** quantity, which an activated ability cannot resolve.
 *
 * `AutoActivateAction` carries no division — `autoActions.ts` throws rather than dealing the whole
 * amount to the first target — so an ability built from such a reading is one the engine offers and
 * then refuses. The line stays unread instead, which is the honest half of D362: an unread line is
 * a line a human resolves, where an offered-then-refused one is a button that ends the game with an
 * error.
 *
 * One function and two call sites, because there are two: the ordinary `cost: effect` assembly and
 * the planeswalker `+N:` / `-N:` one. D463 guarded only the first, and the coverage figure caught it
 * — three cards print this and the count moved by one, so the other two were still emitting it.
 * Spells keep division, which the engine implements (#119); only the ability path has no machinery.
 */
const dividesAQuantity = (read: ReadEffect): boolean =>
  (read.targets ?? []).some((spec) => spec.divided !== undefined);

function damageEffect(clause: string, name: string): ReadEffect | null {
  const self = selfRef(name);

  /*
    Damage divided as you choose, announced at cast time (#119): "Arc Lightning deals 3 damage
    divided as you choose among one, two, or three targets".

    Two numbers out of one sentence, and they are **not** the same number. `divided` is the damage
    to share out; `count` is how many targets may be chosen, which the card spells as a list of
    counts — "one, two, or three" is three, and Pyromatics' "one or two" is two with only one
    damage to give. So the list's largest word is the count, and the damage is the damage.

    `optional: true` because the lower numbers in that list are real choices: `count: 3, divided: 3`
    *is* "one, two, or three targets", since a fourth target would have nothing left to assign and
    choosing fewer leaves the rest on the ones chosen. The docblock on `TargetSpec.divided` works
    that arithmetic through.

    The effect is `dividedAmong`, which is one `dealDamage` per target with its own share rather
    than a loop over one amount: each is a separate dealing of damage from the same source, and
    protection, prevention and deathtouch each have to be asked about separately. Both hand-written
    cards are written exactly this way.
  */
  const shared = new RegExp(
    `^(?:${self}|it) deals (\\d+) damage divided as you choose among ([a-z, ]+?) targets$`, 'i',
  ).exec(clause.trim().replace(/\.\s*$/, ''));
  if (shared !== null) {
    // Split on both separators the list uses, and on "or" wherever it sits: "one, two, or three"
    // leaves an empty piece between the comma and the word, which the filter below drops.
    const words = shared[2]!.split(/\s*(?:,|\bor\b)\s*/).map((word) => word.trim())
      .filter((word) => word !== '');
    const counts = words.map((word) => countFrom(word));
    if (counts.length === 0 || counts.some((n) => n === null)) return null;
    const count = Math.max(...(counts as number[]));
    const spec = targetSpecFrom('any target', false);
    if (spec === null || count < 2) return null;
    return {
      targets: [{ ...spec, count, optional: true, divided: Number(shared[1]) }],
      effect: (c) => dividedAmong(c).reduce(
        (state, { target, amount }) => dealDamage(state, target, amount, {
          controller: c.controller, source: c.source,
        }),
        c.state,
      ),
    };
  }

  const dealt = new RegExp(
    `^(?:${self}|it) deals (\\d+|damage equal to (?:its power|the number of [^.]+?)) damage to (.+)$`
      .replace(' damage to ', '(?: damage)? to '),
    'i',
  ).exec(clause.trim());
  if (dealt === null) return null;
  const where = dealt[2]!.trim();
  /*
    The amount, which is either printed or read off the board.

    "deals damage equal to its power" is Murderous Redcap's clause and the power is read **as the
    trigger resolves** — for the body persist brings back that is zero, so a 1/1 with a −1/−1
    counter deals nothing and the state-based actions bury it again. That is the printed card, and
    the hand-written script says so in as many words; a reader that cached the power at any other
    moment would be a different card.
  */
  const printed = /^\d+$/.test(dealt[1]!) ? Number(dealt[1]) : null;
  const byPower = /^damage equal to its power$/i.test(dealt[1]!);
  const counted = byPower
    ? null
    : boardCount(dealt[1]!.replace(/^damage equal to /i, ''), name);
  if (printed === null && !byPower && counted === null) return null;
  const amountOf = (c: EffectContext): number => {
    if (printed !== null) return printed;
    if (counted !== null) return counted(c);
    const inst = c.state.instances[c.source];
    return inst === undefined ? 0 : characteristicsOf(c.state, inst).power;
  };

  const dest = damageDestination(where);
  if (dest === null) return null;
  return {
    ...(dest.targets === undefined ? {} : { targets: dest.targets }),
    ...(dest.spellFlags === undefined ? {} : { spellFlags: dest.spellFlags }),
    effect: (c) => dest.apply(c, amountOf(c)),
  };
}

/**
 * Where a damage clause's damage goes, read apart from **how much** of it there is.
 *
 * Two readers need the same four destinations and disagree about the number: `damageEffect` reads a
 * printed amount or one computed off the board, and `kickerSpellFor` reads *two* printed amounts and
 * picks between them as the spell resolves. Before this they would have been two copies of the same
 * phrase table, which is the shape #319 is a task about — two readings of one phrase that drifted.
 *
 * So the amount is a parameter. Everything a destination decides is here: whether a target is
 * chosen, whether the clause is a removal spell the bot should hold for a board, and who the damage
 * is credited to.
 *
 * ## The zero branches are inherited, and are belt and braces rather than load-bearing
 *
 * Three of the four `apply` bodies open by returning the state untouched for an amount of zero.
 * They came across from `damageEffect` unchanged, and they are Murderous Redcap's reading: the body
 * persist gives back is a 1/1 with a −1/−1 counter, so its power is zero and the printed card deals
 * nothing. Worth being accurate about why they are harmless rather than why they are needed —
 * `dealDamage` refuses a non-positive amount itself, so deleting any of them changes nothing a test
 * can see (established by a break run, D423). They are kept because they were here, and the sweep
 * added below deliberately has none.
 */
function damageDestination(where: string): {
  readonly apply: (c: EffectContext, amount: number) => GameState;
  readonly targets?: readonly TargetSpec[];
  readonly spellFlags?: Partial<CardScript>;
} | null {
  const text = where.trim().replace(/\.\s*$/, '');

  // The two destinations nobody chooses.
  if (/^you$/i.test(text)) {
    // No `controller` in the options, matching City of Brass: damage to your own face is not damage
    // "dealt by" a source you are trying to credit, and the hand-written card is the ground truth.
    return {
      apply: (c, n) => (n <= 0
        ? c.state
        : dealDamage(c.state, { kind: 'player', seat: c.controller }, n, { source: c.source })),
    };
  }
  if (/^each opponent$/i.test(text)) {
    return {
      apply: (c, n) => (n <= 0 ? c.state : opponentsOf(c.state, c.controller).reduce(
        (state, seat) => dealDamage(
          state, { kind: 'player', seat }, n,
          { controller: c.controller, source: c.source },
        ),
        c.state,
      )),
    };
  }

  // The sweep, which is also nobody's choice — see `sweepDestination` for why it is not a spec.
  const sweep = sweepDestination(text);
  if (sweep !== null) return { apply: (c, n) => sweep(c, n) };

  // And the ones somebody does. `damageFirstTarget` takes a creature or a player, so every spec
  // `targetSpecFrom` can return is one it can be handed.
  const spec = targetSpecFrom(text, false);
  if (spec === null) return null;
  return {
    targets: [spec],
    /*
      **`removesACreature` where the spec is creature-only** (D420), which is the same rule the
      destroy and exile families follow — the flag was simply missing from damage.

      It is the bot's way of being told not to cast a removal spell with nothing worth hitting
      (#322), and a Flame Slash is "deals 4 damage to target creature": creature-only by its own
      spec, so there is nothing else it could ever be cast at. `compiled-vs-written.test.ts` found
      the gap by comparing against the hand-written card, which has carried the flag all along.

      Not for "any target": Lava Spike and Magma Jet can be aimed at a player, so a board with no
      creature on it is still a board they do something on, and neither hand-written card carries
      the flag.
    */
    ...(spec.kind === 'creature' ? { spellFlags: { removesACreature: true } } : {}),
    apply: (c, n) => (n <= 0 ? c.state : damageEveryTarget(c, n)),
  };
}

/**
 * Every card target, folded over in the order the player chose them.
 *
 * `firstCardTarget` is the right reader for a spec whose `count` is one, and **D469 made that
 * assumption false the moment it shipped**. Giving the open-phrase readers
 * `TARGET_QUANTIFIER_PREFIX` let `Destroy two target creatures` compile: the engine asks for two
 * targets, fills both, and the effect destroyed the first one and dropped the second. The card
 * read as automated and did half of what it says, which is worse than the unread line it replaced
 * (D259, D362) — an unread line is badged for a human to play by hand, a half-read one is not.
 *
 * It is the fold `untappedMany` has had since the counted untap, lifted out so the five families
 * that take an open target phrase share one spelling of it rather than five.
 *
 * Written as `(state, id) => each(state, id)` rather than handing `each` to `reduce` directly
 * because `reduce` passes an index and the array as third and fourth arguments, and an effect
 * primitive that takes an options object third would silently be handed a number.
 */
const foldCardTargets = (
  c: EffectContext,
  each: (state: GameState, id: string) => GameState,
): GameState => cardTargets(c).reduce((state, id) => each(state, id), c.state);


/**
 * A clause that points at something: its target spec, its effect, and the script-level flags the
 * hand-written cards set for that family.
 *
 * ## The flags are the same trap `keywordScriptFor` found, in a second place
 *
 * D364 learnt that a keyword's unit of compilation is a partial `CardScript` and not a trigger,
 * because `vanishingTrigger(4)` without `entersWith` is a creature that never dies. The targeted
 * families say it again: `Doom Blade` sets **`removesACreature: true`** beside its effect, and
 * `Giant Growth` sets **`expiresAtEndOfTurn: true`**. Both are hints the bot reads — do not cast
 * this with nothing of theirs to point at; hold this for the combat. A compiler that emitted the
 * effect alone would produce a card that *works* and *plays badly*, which is worse than an unread
 * line, because a line left unread is flagged for a human to play by hand (D362) and a badly
 * played one is not flagged at all.
 *
 * They are returned as `spellFlags` rather than merged, because they belong to a **spell**:
 * "removes a creature" is advice about casting, and an ETB trigger is not cast. The trigger path
 * drops them; the spell path applies them.
 */
function targetedEffect(clause: string, name: string): ReadEffect | null {
  const text = clause.trim();

  /*
    Destroy, and the first family read with an open target phrase rather than a fixed one.

    `pointsAtAPermanent` is the guard that keeps that open: `targetSpecFrom` can return a player or
    a spell, and "destroy target player" is not a card. Without it the first printed sentence of
    that shape would compile into something the engine cannot do.
  */
  const destroyed = new RegExp(`^destroy (${TARGET_QUANTIFIER_PREFIX}target .+)$`, 'i').exec(text);
  if (destroyed !== null) {
    const spec = targetSpecFrom(destroyed[1]!, false);
    if (spec !== null && pointsAtAPermanent(spec)) {
      return {
        targets: [spec],
        effect: (c) => foldCardTargets(c, destroy),
        // Only when the target really is a creature. A Disenchant that claimed to remove one would
        // have the bot holding it for a board it cannot answer.
        ...(spec.kind === 'creature' ? { spellFlags: { removesACreature: true } } : {}),
      };
    }
  }

  /*
    Exile, which is destroy's sibling and differs in exactly one way that matters to a card: it is
    not a destruction, so indestructible and regeneration do not answer it (CR 701.19a).

    D377 refuses a bare `exile target creature` **ETB** as an exile-until-leaves *shape*, and that
    refusal stands for what it was about: emitting a return the print does not promise. Reading the
    sentence as what it says — exile, no return — is the faithful reading, and it is what Selesnya
    Charm's second mode and Hidden Dragonslayer's trigger print.
  */
  const exiled = new RegExp(`^exile (${TARGET_QUANTIFIER_PREFIX}target .+)$`, 'i').exec(text);
  if (exiled !== null) {
    const spec = targetSpecFrom(exiled[1]!, false);
    if (spec !== null && pointsAtAPermanent(spec)) {
      return {
        targets: [spec],
        effect: (c) => foldCardTargets(c, exileCard),
        // As on the destroy above, and for the same reason: only when the target really is a
        // creature is this a card the bot should hold for a board it can answer.
        ...(spec.kind === 'creature' ? { spellFlags: { removesACreature: true } } : {}),
      };
    }
  }

  const bounced = new RegExp(
    `^return (${TARGET_QUANTIFIER_PREFIX}target .+) to its owner's hand$`, 'i',
  ).exec(text);
  if (bounced !== null) {
    const spec = targetSpecFrom(bounced[1]!, false);
    if (spec !== null && pointsAtAPermanent(spec)) {
      return {
        targets: [spec],
        effect: (c) => foldCardTargets(c, bounceToHand),
      };
    }
  }

  /*
    The counter family, whose target is an object on the stack — which is why `TargetSpec` has a
    `spell` kind at all.

    Read with an open target phrase rather than four fixed sentences, because the only thing that
    changes between a Cancel, an Essence Scatter, a Negate, a Squelch and a Disallow is what may be
    pointed at. `pointsAtTheStack` is what keeps the phrase open safely.

    **Disallow's phrase is supplied, not captured**, and it is the second place in this function
    that happens (the first is the graveyard return). The card prints "counter target spell,
    activated ability, or triggered ability" — three objects named in a list — and the spec that
    points at all three is described "target spell or ability", which is the description the
    hand-written card stores and the ground-truth test compares. Reading the printed list as a
    phrase would mean teaching `targetSpecFrom` a fourth spelling of a spec it already has.

    One effect for all of them, and it is Disallow's rather than Counterspell's: `counterSpell`
    buries a spell's card and simply removes an ability, which is the difference the rules draw and
    the only one there is, so the reading that handles both kinds of object is the one that
    generalises. For a spell target it does exactly what `firstCardTarget` did.
  */
  const countering = new RegExp(`^counter (${TARGET_QUANTIFIER_PREFIX}target .+)$`, 'i').exec(text);
  if (countering !== null) {
    const phrase = countering[1]!.trim();
    const spec = targetSpecFrom(
      phrase.toLowerCase() === 'target spell, activated ability, or triggered ability'
        ? 'target spell or ability'
        : phrase,
      false,
    );
    if (spec !== null && pointsAtTheStack(spec)) {
      return {
        targets: [spec],
        /*
          Every object pointed at, not the first — see `foldCardTargets`, which this cannot use
          because an ability on the stack is an `ability` target and `cardTargets` keeps only
          cards. A player is skipped rather than refused: `pointsAtTheStack` has already ruled
          out a spec that could fill one, so the branch is unreachable and written for the type.
        */
        effect: (c) => c.targets.reduce(
          (state, object) => (object.kind === 'player' ? state : counterSpell(state, object.id)),
          c.state,
        ),
      };
    }
  }

  /*
    Target player mills N cards.

    The pool prints the count as a word every time — "mills two cards", "mills five cards",
    "mills seven cards" — which is exactly the split `countFrom`'s docblock describes: a number of
    objects is a word, an amount is a digit. A reader that took only digits would have read none of
    the four.
  */
  /*
    The pointed half of the life family: a player named by a target rather than by "each opponent".

    `target player loses N life and you gain N life` is Blood Artist's clause, read whole for the
    reason the untargeted drain is — "and" joins one effect here — and in the printed order, lose
    then gain. `target player gains N life` is Healing Salve's first mode, and its sign is the
    reason `friendly` exists: aimed with the bot's default at "the enemy and the enemy's creatures",
    a Healing Salve heals the opponent.
  */
  const pointedDrain = /^(target player|target opponent) loses (\d+) life and you gain (\d+) life$/i
    .exec(text);
  if (pointedDrain !== null) {
    const lost = Number(pointedDrain[2]);
    const gained = Number(pointedDrain[3]);
    const spec = targetSpecFrom(pointedDrain[1]!, false);
    if (spec !== null) {
      return {
        targets: [spec],
        effect: (c) => {
          const seat = firstPlayerTarget(c);
          return seat === null ? c.state : gainLife(loseLife(c.state, seat, lost), c.controller, gained);
        },
      };
    }
  }

  /*
    "Target opponent loses 2 life" — the bare life loss, which had no reader at all: the only
    targeted one was Kambal's `loses N life and you gain N life` above, and `you lose N life` is the
    controller's own. 15 legal cards print `target opponent` as their only unread phrase and several
    of them are this sentence, which is why it arrives with D469 rather than after it.
  */
  const drained = /^(target player|target opponent) loses (\d+) life$/i.exec(text);
  if (drained !== null) {
    const spec = targetSpecFrom(drained[1]!, false);
    const amount = Number(drained[2]);
    if (spec !== null) {
      return {
        targets: [spec],
        effect: (c) => {
          const seat = firstPlayerTarget(c);
          return seat === null ? c.state : loseLife(c.state, seat, amount);
        },
      };
    }
  }

  const healed = /^(target player|target opponent) gains (\d+) life$/i.exec(text);
  if (healed !== null) {
    const amount = Number(healed[2]);
    const spec = targetSpecFrom(healed[1]!, true);
    if (spec !== null) {
      return {
        targets: [spec],
        effect: (c) => {
          const seat = firstPlayerTarget(c);
          return seat === null ? c.state : gainLife(c.state, seat, amount);
        },
      };
    }
  }

  /*
    Untap, which is the one clause in this file whose reading changes what the **bot** may do rather
    than only what the card does.

    `untapsOnly` goes with it, and it is not a nicety: an ability whose whole effect is an untap can
    return the board to exactly the state it was in, so without the flag the bot can tap and untap
    for ever — the loop #124 exists for. `AbilityDef` is the only place that field lives, so it
    travels in `abilityFlags` rather than `spellFlags`, and the spell and trigger paths drop it the
    way they already drop a bot hint that does not apply to them.

    `friendly` on the spec, because untapping an opponent's land is a card thrown away and the bot's
    default aim is the enemy's board — Kiora's Follower's own comment says exactly that.
  */
  /*
    A **counted** untap: "Untap two target lands", which is Garruk's +1.

    `TargetSpec.count` is the field for it and the engine fills the list before resolution, so the
    effect reduces over `cardTargets` rather than taking the first. The count is read off the printed
    word — `countFrom`, the same reader the token counts use — and the description stays the singular
    phrase, because that is what a player is asked for each time and what the hand-written spec
    stores.
  */
  const untappedMany = /^untap ([\w]+) (target .+?)s$/i.exec(text);
  if (untappedMany !== null) {
    const count = countFrom(untappedMany[1]!);
    const spec = targetSpecFrom(untappedMany[2]!, true);
    if (count !== null && count > 1 && spec !== null && pointsAtAPermanent(spec)) {
      return {
        targets: [{ ...spec, count }],
        abilityFlags: { untapsOnly: true },
        effect: (c) => cardTargets(c).reduce((state, id) => tap(state, id, false), c.state),
      };
    }
  }

  const untapped = new RegExp(`^untap (${TARGET_QUANTIFIER_PREFIX}target .+)$`, 'i').exec(text);
  if (untapped !== null) {
    const spec = targetSpecFrom(untapped[1]!, true);
    if (spec !== null && pointsAtAPermanent(spec)) {
      return {
        targets: [spec],
        abilityFlags: { untapsOnly: true },
        effect: (c) => foldCardTargets(c, (state, id) => tap(state, id, false)),
      };
    }
  }

  const milled = /^(target player|target opponent) mills ([\w]+) cards?$/i.exec(text);
  if (milled !== null) {
    const n = countFrom(milled[2]!);
    const spec = targetSpecFrom(milled[1]!, false);
    if (n !== null && spec !== null) {
      return {
        targets: [spec],
        effect: (c) => {
          const seat = firstPlayerTarget(c);
          return seat === null ? c.state : mill(c.state, seat, n);
        },
      };
    }
  }

  /*
    Target player discards N cards — the mill's mirror, and the first clause this module reads whose
    reading is a **question** rather than an effect.

    The discarding player chooses, which is the whole card: `CardsDecisionSpec.who`'s own docblock
    names Mind Rot for exactly this and says getting it wrong "would make Mind Rot a very different
    card". So it is `who: 'target-player'` and emphatically not `discardAtRandom` — a compiler that
    reached for the random primitive because it was simpler would have built Ravenous Rats and
    called it Mind Rot, which is a card that works and is wrong.

    `min` and `max` are both N and the engine clamps to the hand, so a player holding one card
    discards one and a player holding none is never asked. The prompt echoes the printed count and
    its noun — "Discard two cards", "Discard a card" — rather than being built from the number,
    which keeps the singular right and matches the prompt the hand-written card stores.
  */
  const discarded = /^(target player|target opponent) discards ([\w]+) (cards?)$/i.exec(text);
  if (discarded !== null) {
    const n = countFrom(discarded[2]!);
    const spec = targetSpecFrom(discarded[1]!, false);
    if (n !== null && spec !== null) {
      return {
        targets: [spec],
        decisions: [{
          who: 'target-player',
          from: 'hand',
          prompt: `Discard ${discarded[2]!} ${discarded[3]!}`,
          min: n,
          max: n,
        }],
        effect: (c) => moveToGraveyard(c.state, chosenCards(c)),
      };
    }
  }

  /*
    Return target creature card from your graveyard to your hand.

    The first family whose target phrase is **not** a substring of its own sentence: the card says
    "target creature card … from your graveyard", with the zone in the verb phrase, while the spec
    that points at it is described "target creature card in your graveyard". So the phrase is
    supplied rather than captured, and the string supplied is the one Raise Dead and Gravedigger
    both already store — which is what the ground-truth tests compare.

    Two types, because Grim Discovery prints both halves of the same sentence and the only thing
    that changes is the word: a creature card or a land card, each a different `TargetSpec.kind`
    because a graveyard-land is a different object from a graveyard-creature. The type is captured
    and lower-cased into the supplied phrase rather than written out twice.
  */
  const raised = /^return target (creature|land) card from your graveyard to your hand$/i
    .exec(text);
  if (raised !== null) {
    const spec = targetSpecFrom(
      `target ${raised[1]!.toLowerCase()} card in your graveyard`, false,
    );
    if (spec !== null) {
      return {
        targets: [spec],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : bounceToHand(c.state, id);
        },
      };
    }
  }

  /*
    A pump, and the one family here that **helps** what it points at.

    The keyword grant is read with it rather than after it: "gets +0/+3 and gains hexproof" is one
    printed effect, and `pumpAndGrant` is where the two halves become the one `PumpOptions` that
    `pump` takes. Reading the size and dropping the grant was the earlier behaviour, and it would
    have been a card that silently does less than it prints — a Blossoming Defense that pumps and
    leaves the creature targetable is the opposite of why anybody casts it.
  */
  const sized = /^(target creature(?: you control| an opponent controls| you don't control)?) gets ([-+]\d+)\/([-+]\d+)(?: and gains ([a-z][a-z' ]*?))? until end of turn$/i
    .exec(text);
  /*
    **The sign decides whose creature it is**, and that is the whole reason one regex reads both
    halves of this family.

    "Target creature gets +2/+2 until end of turn" and "Target creature gets -2/-2 until end of
    turn" are the same sentence with one character changed, and 265 legal cards print the second —
    the largest single clause family left unread when this was written, and unread because the
    pattern above it demanded a `+`. What they do differs only in the number passed to `pump`; what
    they *mean* differs completely, and `TargetSpec.friendly` is where that lands (D252). So the
    size is read first and the sign picks the branch, rather than two readers that could drift.

    A **mixed** sign — Auger Spree's "+4/-4", and 14 cards print one — is refused, and the refusal
    is about the bot rather than the effect. `pump` would apply it correctly either way; what cannot
    be read off the sentence is which creature it is for, because a card that gives +4/-4 is
    removal pointed at them and a trick pointed at your own 1/1 depending on the rest of the card.
    `friendly` guessed wrong is a bot that aims the spell at the wrong half of the table every time,
    which is a silent degradation rather than a refusal — the thing D362 says to flag instead.
  */
  const pumped = sized === null ? null
    : Number(sized[2]) >= 0 && Number(sized[3]) >= 0 ? sized : null;
  const shrunk = sized === null || pumped !== null ? null
    : Number(sized[2]) <= 0 && Number(sized[3]) <= 0 ? sized : null;
  if (shrunk !== null) {
    /*
      The shrink, and **Darkblast is the ground truth for every field of it**: the pool's one
      hand-written card of this shape points at `TARGET_CREATURE` — the hostile default, not the
      helped one — and sets `expiresAtEndOfTurn`, with a comment saying why that flag is right on a
      shrink: wearing off at end of turn is what kills the creature before the shrink expires.

      `removesACreature` is deliberately **not** set, for the same reason the pump branch refuses to
      guess a hint for `indestructible`: nothing hand-written pairs that flag with a shrink, and
      -1/-1 kills a Glistener Elf while -1/-1 on a 5/5 is a wasted card. Which it is depends on the
      board, which is what the bot's search sees by playing it out.

      A granted keyword is refused here although the pump branch reads one: no printed shrink has a
      grant (checked across the corpus — the `and gains` tail appears only on `+`/`+` and `+`/`-`
      sizes), so reading one would be inventing the only card it could apply to.
    */
    if (shrunk[4] === undefined) {
      const bonus = sizeBonus(Number(shrunk[2]), Number(shrunk[3]));
      const spec = targetSpecFrom(shrunk[1]!, false);
      if (spec !== null && bonus !== null) {
        return {
          targets: [spec],
          effect: (c) => {
            const id = firstCardTarget(c);
            return id === null
              ? c.state
              : pump(c.state, [id], c.source, c.controller, bonus);
          },
          spellFlags: { expiresAtEndOfTurn: true },
        };
      }
    }
  }
  if (pumped !== null) {
    const bonus = pumpAndGrant(Number(pumped[2]), Number(pumped[3]), pumped[4]);
    const spec = targetSpecFrom(pumped[1]!, true);
    if (spec !== null && bonus !== null) {
      /*
        Which bot hint the spell carries depends on **what the grant is for**, and the pool draws
        that line itself. `protectFromRemoval` — Blossoming Defense and Dive Down — sets
        `protectsACreature` and deliberately *not* `expiresAtEndOfTurn`: the two say different
        things to the bot, "hold this until something threatens one of your creatures" against
        "hold this for the combat", and the measurement behind the first (64 cast, 60 of them with
        nothing on the stack and no combat) is the reason it exists. A hexproof trick told to wait
        for combat is still a card thrown away.

        So hexproof and shroud — the two keywords `targeting.ts` refuses a spell for — make this a
        protection trick, and everything else is the pump hint. `indestructible` is deliberately
        not in the set: nothing hand-written pairs it with this flag, and guessing which hint it
        wants is exactly the invention D259 rules out.
      */
      const protective = (bonus.keywords ?? [])
        .some((word) => word === 'hexproof' || word === 'shroud');
      /*
        And which creature to aim at, which is a second thing the granted keyword decides.

        `helpsInCombat`'s own docblock draws this line and names the cards: it is "only for a bonus
        whose *whole* value is in the attack", and a Giant Growth deliberately does not carry it
        because pumping a blocker to win a fight is half of what that card is for. Of the four
        hand-written specs that do carry it, the two that are keyword grants are Tainted Strike
        (infect) and Crimson Wisps (haste) — a creature that cannot attack gains nothing from
        either. So those two words set it and no others; trample and hexproof are as useful on a
        blocker.
      */
      const forTheAttack = (bonus.keywords ?? [])
        .some((word) => word === 'infect' || word === 'haste');
      return {
        targets: [forTheAttack ? { ...spec, helpsInCombat: true } : spec],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null
            ? c.state
            : pump(c.state, [id], c.source, c.controller, bonus);
        },
        /*
          Three cases, and the middle one is D412's correction, for the reason written out beside
          the grant-only branch: a bonus whose whole value is in the attack carries **no** spell
          flag, because `expiresAtEndOfTurn` tells the bot an instant may wait for blockers and a
          creature that was going to attack with infect cannot. Tainted Strike is the card, and it
          carries no flag by hand.
        */
        ...(protective
          ? { spellFlags: { protectsACreature: true } }
          : forTheAttack ? {} : { spellFlags: { expiresAtEndOfTurn: true } }),
      };
    }
  }

  /*
    The same clause with **no size change at all**: "Target creature gains flying and double strike
    until end of turn", which is Ajani's ultimate.

    Its own branch rather than an optional size on the one above, because `sizeBonus` refuses
    `+0/+0` and should go on refusing it — a clause that pumped by nothing would be a continuous
    effect doing nothing, and that refusal is what keeps a misread sentence from compiling. A grant
    with no size is a different sentence, not a pump of zero.

    The two hints are decided by exactly the rule the sized branch uses, for the reasons written
    there: hexproof and shroud make it a protection trick, infect and haste make it an attacker's
    bonus and carry no spell flag at all (D412). Nothing here is a second rule, which is the point
    of keeping the branches adjacent.
  */
  /*
    A clause that points at a **player**, which is a different shape from everything around it: the
    target is a seat, so `firstPlayerTarget` answers it and none of the card filters apply.

    Two phrases, and the first is one reader rather than two on purpose. "Target player draws two
    cards and loses 2 life" — Sign in Blood — aims **both halves at the same player**, and
    `composeEffects` cannot express that: `targets` is one list per script and two targeting parts
    are refused, which is the rule that keeps "target creature fights target creature" honest. So
    the sentence is read whole.

    Drawing before the loss is the printed order and the hand-written card's comment says why it
    matters: a player taken to 0 by the life loss still drew the cards, and a player with no cards
    left to draw has already lost either way.
  */
  const bled = /^target player draws ([\w]+) cards? and loses (\d+) life$/i.exec(text);
  if (bled !== null) {
    const cards = countFrom(bled[1]!);
    const spec = targetSpecFrom('target player', false);
    if (cards !== null && spec !== null) {
      const life = Number(bled[2]);
      return {
        targets: [spec],
        effect: (c) => {
          const seat = firstPlayerTarget(c);
          return seat === null ? c.state : loseLife(draw(c.state, seat, cards), seat, life);
        },
      };
    }
  }

  /*
    A granted keyword, and optionally a colour it becomes with it: "target creature gains haste
    until end of turn **and becomes red**", which is Crimson Wisps.

    The colour rides in the same `PumpOptions` as the keyword, for `pumpAndGrant`'s reason one
    sentence over: `pump` takes both and the hand-written card passes
    `{ keywords: ['haste'], setColors: ['R'] }` in a single call. Two continuous effects where the
    print is one would expire independently — and this pair especially, because layer 5 *replaces*
    the printed colours (CR 105.3) rather than adding to them, so a colour change that outlived its
    keyword would leave a creature whose colours came from a spell that has finished.

    `TOKEN_COLOURS` is the word list, shared with the token reader so there is one place a colour
    word is spelled. `colorless` maps to `null` there and is refused here: "becomes colorless" is a
    real sentence and `setColors: []` is a different claim from `setColors: null`, which is the
    absence of the effect. Nothing in the pool prints it, so it is left unread rather than guessed.
  */
  const granted =
    /^(target creature(?: you control)?) gains ([a-z][a-z' ]*?) until end of turn(?: and becomes ([a-z]+))?$/i
      .exec(text);
  if (granted !== null) {
    const words = grantedKeywordList(granted[2]!);
    const spec = targetSpecFrom(granted[1]!, true);
    const becomes = granted[3] === undefined
      ? undefined
      : TOKEN_COLOURS[granted[3].toLowerCase()] ?? null;
    const colourOk = granted[3] === undefined || (becomes !== undefined && becomes !== null);
    if (words !== null && spec !== null && colourOk) {
      const protective = words.some((word) => word === 'hexproof' || word === 'shroud');
      const forTheAttack = words.some((word) => word === 'infect' || word === 'haste');
      const options: PumpOptions = becomes === undefined || becomes === null
        ? { keywords: words }
        : { keywords: words, setColors: [becomes] };
      return {
        targets: [forTheAttack ? { ...spec, helpsInCombat: true } : spec],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null
            ? c.state
            : pump(c.state, [id], c.source, c.controller, options);
        },
        /*
          Three cases, not two, and the middle one is a correction (D412).

          This read `protective ? protectsACreature : expiresAtEndOfTurn`, so a haste or infect
          grant carried `expiresAtEndOfTurn` — and both hand-written twins, Crimson Wisps and
          Tainted Strike, deliberately carry **no** spell flag. Comparing the compiled script to
          theirs field by field is what showed it; the increment that wrote this reader proved the
          *target spec* equal and never looked at the flags.

          The flag is wrong here rather than merely extra. Its own docblock says what it does to an
          instant: "an instant can wait for blockers". A haste grant held until blockers is a card
          that never did its job, because the creature it was cast to let attack has not attacked;
          an infect grant waited out is the same. The hint this family needs is already on the
          target spec — `helpsInCombat`, "aim it at something that can attack" — and the two
          together would say hold it and aim it at an attacker, which is a contradiction.

          So the grants that are about the attack carry no flag, and the ones that are about
          surviving or about size keep theirs.
        */
        ...(protective
          ? { spellFlags: { protectsACreature: true } }
          : forTheAttack ? {} : { spellFlags: { expiresAtEndOfTurn: true } }),
      };
    }
  }

  /*
    Counters on the whole team, which is Nissa's `−2` — and a different card from an Overrun, as her
    own comment says: counters stay, they stack with the next activation, and a sweeper that kills
    everything else leaves the survivor bigger. So it is `addCounters` per creature and not a pump,
    and it points at nothing, which is why it is here rather than among the targeted clauses.
  */
  if (/^put a \+1\/\+1 counter on each creature you control$/i.test(text)) {
    return {
      effect: (c) => creaturesControlledBy(c.state, c.controller).reduce(
        (state, id) => addCounters(state, id, '+1/+1', 1),
        c.state,
      ),
    };
  }

  /*
    "put a +1/+1 counter on it" — the counter that goes on **whatever the trigger was about**, which
    is a different clause from the two around it: it points at no target and reads no board, it
    reads the event's own subject. Armory of Iroas prints it after "Whenever equipped creature
    attacks", and 43 corpus cards print it after a prologue of some kind.

    `c.subject === undefined` is a real branch rather than a formality: this clause is only
    meaningful under a trigger that carries a subject, and a spell or an ability that reached it
    with none must do nothing rather than guess at a creature. `-1/-1` is deliberately **not**
    accepted here — "put a -1/-1 counter on it" is a different card and would want the harmful
    flag the clause below sets, and a reader that treated the two alike is the mistake that
    comment is about.

    **The bare "it" is not read here, and a break run is why.** Deleting this clause did not make
    Armory of Iroas's line unread: `selfEffect` runs three readers earlier and its `put a +1/+1
    counter on (?:<name>|it)` clause had already claimed the body — and resolved it to `c.source`,
    which for an Equipment is the Equipment. So the card reported `unread: []`, fully automated,
    and grew the sword instead of the creature holding it. The fix belonged where the shadowing
    was, so "it" is now `itMeans` upstream and what is left here is "that creature", which no
    other reader claims. Narrowing the pattern is deliberate: if that upstream clause is ever
    removed, the line goes **unread** and gets D362's badge, rather than falling through to a
    second reading that might be wrong in a different way.
  */
  if (/^put a \+1\/\+1 counter on that creature$/i.test(text)) {
    return {
      effect: (c) => (c.subject === undefined ? c.state : addCounters(c.state, c.subject, '+1/+1', 1)),
    };
  }

  /*
    A counter put on a creature. `+1/+1` helps and `-1/-1` harms, which is the clearest case in this
    file for why `friendly` cannot be read off the target phrase: the two clauses differ by one
    character and point in opposite directions.
  */
  const countered = /^put a (\+1\/\+1|-1\/-1) counter on (target creature(?: you control)?)$/i
    .exec(text);
  if (countered !== null) {
    const kind = countered[1]!.startsWith('+') ? '+1/+1' : '-1/-1';
    const spec = targetSpecFrom(countered[2]!, kind === '+1/+1');
    if (spec !== null) {
      return {
        targets: [spec],
        effect: (c) => {
          const id = firstCardTarget(c);
          return id === null ? c.state : addCounters(c.state, id, kind, 1);
        },
      };
    }
  }

  return null;
}

/**
 * One clause joined by `and`, read as the sequence it is — and read **last**.
 *
 * `clausesOf` splits a line on the full stop and on `, then `, deliberately not on "and" (D387),
 * because "and" is most often *inside* one clause rather than between two: "target creature gets
 * +2/+2 **and** gains trample" is a single `pump` with a keyword in it, and "you gain X life **and**
 * draw X cards" is one announced count spent twice. Splitting those would produce two continuous
 * effects that expire independently, and two counts where the card prints one.
 *
 * So this is a **fallback**, tried only after all four readers have failed on the whole clause.
 * That ordering is the entire safety argument: any conjunction a single reader understands keeps its
 * single reading, and this sees only the ones nothing else could read at all.
 *
 * What is left over is the genuine sequence — "you draw a card and you lose 1 life" (Phyrexian
 * Arena) — and `composeEffects` already has exactly the right invariants for it:
 *
 * - **All or nothing.** A half nobody can read refuses the whole clause, so a card never resolves
 *   and does one of the two things it prints.
 * - **At most one half may point at something.** `targets` is one list per script, so "destroy
 *   target creature and target enchantment" is refused rather than silently aimed twice at the
 *   same permanent.
 *
 * Every occurrence is split, not just the first, which is also what makes this terminate: each part
 * has no " and " left in it, so the part's own `readEffect` reaches this function, finds nothing to
 * split, and stops.
 */
function conjoinedEffect(
  clause: string, name: string, where: SubjectZone | null,
): ReadEffect | null {
  const parts = clause.trim().split(/\s+and\s+/i).map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return null;
  return composeEffects(parts, name, where);
}

/**
 * Everything one printed clause can become.
 *
 * Untargeted first, since those are exact sentences that cannot be confused for anything else.
 * Damage before the rest of the targeted families because its own destinations include two that
 * are not targets at all, so it has to see the clause before `targetedEffect` reads "to" as a
 * target phrase.
 */
function readEffect(
  clause: string, name: string, where: SubjectZone | null,
): ReadEffect | null {
  return untargetedEffect(clause, name)
    ?? damageEffect(clause, name)
    // `where` goes only here and to the conjunction below: see `SubjectZone`.
    ?? selfEffect(clause, name, where)
    ?? targetedEffect(clause, name)
    // Last, and the docblock on `conjoinedEffect` is about why: a conjunction any reader above
    // understands as one clause must keep that reading.
    ?? conjoinedEffect(clause, name, where);
}

/**
 * One printed line, as the clauses it is a sequence of.
 *
 * Magic writes a sequence three ways and this reads all three: separate sentences ("Target player
 * mills two cards. Draw a card."), a `, then ` joint ("Scry 1, then draw a card."), and — most
 * often — one clause on a line of its own. Splitting on the full stop is what the sentence case
 * needs, and it is safe because nothing in a rules line abbreviates: a full stop followed by
 * whitespace is a sentence boundary and nothing else.
 *
 * The apostrophes are flattened here, at the one door every clause comes through — see `plain`.
 */
function clausesOf(line: string): readonly string[] {
  return plain(line)
    .split(/\.\s+/)
    .flatMap((sentence) => sentence.split(/,\s+then\s+/i))
    .map((clause) => clause.replace(/\.\s*$/, '').trim())
    .filter((clause) => clause !== '');
}

/**
 * A sequence of printed clauses, as one effect — or `null` if **any** of them cannot be read.
 *
 * ## All or nothing, and why that is the invariant rather than "one clause"
 *
 * The first version of the spell path took one line and refused anything longer. That was the right
 * *safety* property for the wrong reason: a spell whose second sentence went unread would resolve
 * and silently do half of what it prints, which is worse than not reading it at all. But "exactly
 * one clause" is a stricter rule than that property needs. The property is **all or nothing**, and
 * a spell of three clauses all of which compile satisfies it completely.
 *
 * The clauses run in printed order, each handed the state the one before it produced. That
 * threading is the whole of what sequencing means, and it is why a composed reading can still be a
 * single `EffectFn` — which is what lets this serve the trigger path and the spell path alike.
 *
 * ## At most one clause may point at something
 *
 * A `CardScript`'s `targets` is one list for the whole spell or trigger, and the engine fills it
 * once before resolution. Two clauses each wanting their own target is an effect with two
 * independent target choices — "Target creature you control fights target creature you don't
 * control" — and composing them here would silently hand both the *same* target. That is a wrong
 * card rather than an unread one, so it is refused.
 */
function composeEffects(
  clauses: readonly string[], name: string, where: SubjectZone | null,
): ReadEffect | null {
  if (clauses.length === 0) return null;
  const parts: ReadEffect[] = [];
  for (const clause of clauses) {
    const read = readEffect(clause, name, where);
    if (read === null) return null;
    parts.push(read);
  }
  if (parts.length === 1) return parts[0]!;

  const targeted = parts.filter((part) => part.targets !== undefined);
  // See the docblock: two target choices cannot share one `targets` list.
  if (targeted.length > 1) return null;

  /*
    **At most one clause may read its own answers**, which is the same rule as the one above it and
    took two goes to get right.

    A resolution's answers are one list and a part reads its own by **index** — `chosenCard(c)` is
    `c.decisions[0]`, `chosenCards(c, 1)` the second. The concatenation below records nothing about
    which part an answer came from, so a *second* answer-reading part reads the **first** one's
    answer. `Draw two cards, then discard two cards. Target player discards a card.` is the shape:
    both discards call `chosenCards(c)`, both get index 0, and the target player discards nothing
    while the caster's cards are moved to the graveyard twice. A wrong card, not an unread one.

    ## Why "answer-reading" and not "asks a question"

    D467 wrote this guard as "at most one part with `decisions`" and **measured it costing two cards
    that work**: Cryptic Annelid (`scry 1, then scry 2, then scry 3`) and Fill with Fright (`Target
    player discards two cards. Scry 2.`). A scry asks a question and reads **nothing** — its effect
    is the identity, because the engine applies a `library-top` answer to its own plan entry. Three
    scries are three plan entries, each applied to itself, and that composition is correct.

    `appliesNothing` is already the field that says so ("the question is the whole effect"), set by
    scry and surveil, so the test is derived from it rather than from a new flag nobody would
    remember to set. It is also **safe by default**: a reader that asks a question and forgets
    `appliesNothing` is treated as answer-reading, which refuses a composition rather than
    mis-reading one.

    D467's own conclusion was that the hazard had no failing case in the corpus. That was right about
    the corpus and wrong about the claim: `compile.test.ts` already had Greedy Rummage, and the
    general discard reader (D468) is what made it reachable. The corpus is not the only source of
    printed text this compiler sees.
  */
  const answerReaders = parts.filter(
    (part) => (part.decisions ?? []).length > 0 && part.appliesNothing !== true,
  );
  if (answerReaders.length > 1) return null;

  /*
    A composition cannot carry two pre-question halves, so a part that already has one refuses it.

    Nothing in the pool produces that — only the shape readers set `beforeDecisions`, and they take
    the whole resolution — but `conjoinedEffect` composes too, so a nested composition is reachable
    and a `beforeDecisions` buried in one would be silently dropped. Refusing is D364's rule: a
    fragment without its companion is not a reading.
  */
  if (parts.some((part) => part.beforeDecisions !== undefined)) return null;

  const decisions = parts.flatMap((part) => part.decisions ?? []);
  const flags = Object.assign({}, ...parts.map((part) => part.spellFlags ?? {})) as
    Partial<CardScript>;
  /*
    One flag does not survive composition, and it is the field's own rule rather than a special
    case: `makesMana` is for a spell whose **whole** effect is mana, where the search cannot see
    what the card did. A spell that adds mana *and* draws a card has a visible effect, so the hint
    would hold it back for a follow-up it does not need. Nothing in the pool prints that pair; the
    deletion is here so the first card that does is read correctly rather than plausibly.
  */
  if (parts.length > 1) delete (flags as { makesMana?: boolean }).makesMana;
  /*
    Each part is handed the state the one before it produced, which is what a printed sequence
    means. Everything else about the context — the targets, the answering object — is unchanged.

    Every part but the last runs in its `immediate` reading where it has one. See `ReadEffect`: the
    only family that offers two is the draw, and the choice is about whether anything comes after it
    that could need to see the card.
  */
  const run = (slice: readonly ReadEffect[], asFinal: boolean) =>
    (c: EffectContext): GameState => slice.reduce(
      (state, part, i) => {
        const final = asFinal && i === slice.length - 1;
        return (final ? part.effect : part.immediate ?? part.effect)({ ...c, state });
      },
      c.state,
    );

  /*
    **The split at the first question** (D418).

    The engine plans a resolution's decisions and asks them *before* the resolution runs — see
    `beforeDecisionsFor` in `automation.ts`, which runs `beforeDecisions` and then plans against the
    state it produced. So a composition that put every part in `effect` would ask the player a
    question about a board the earlier parts have not changed yet.

    Magma Jet is the card and `compiled-vs-written.test.ts` is what found it: "deals 2 damage to any
    target. Scry 2", where the hand-written script puts the damage in `beforeDecisions` and its
    comment says why — "by the time the player is looking at the top of their library the creature
    is already dead … what is drawn next is a different decision once the board has changed".

    It is not one card. **Any** resolution shaped "an effect. a question." had it, which is what
    makes this an assembly rule rather than a reader: the parts before the first part that asks
    something go in `beforeDecisions`, the rest in `effect`. A question in the first part leaves
    nothing before it and nothing changes.

    Those earlier parts are run with `asFinal: false`, because something does come after them — the
    question. That is `ReadEffect.immediate`'s own rule: a draw whose card must be visible to the
    next step is immediate, and a question is a next step.
  */
  const asks = parts.findIndex((part) => (part.decisions ?? []).length > 0);
  const before = asks > 0 ? parts.slice(0, asks) : [];
  const after = asks > 0 ? parts.slice(asks) : parts;
  return {
    effect: run(after, true),
    // Only when **every** remaining part is a question: one real effect after the split makes the
    // composition's effect real again.
    ...(after.every((part) => part.appliesNothing === true) ? { appliesNothing: true } : {}),
    ...(before.length === 0 ? {} : { beforeDecisions: run(before, false) }),
    // Carried outwards, so a composition that is itself followed by something runs every part in
    // its immediate reading.
    ...(parts.some((part) => part.immediate !== undefined) ? { immediate: run(parts, false) } : {}),
    ...(targeted[0]?.targets === undefined ? {} : { targets: targeted[0]!.targets }),
    ...(decisions.length === 0 ? {} : { decisions }),
    ...(Object.keys(flags).length === 0 ? {} : { spellFlags: flags }),
  };
}

/**
 * A printed activated ability, as the `abilities` fragment of a script.
 *
 * ## The third place a clause can live
 *
 * A clause has had two homes: a trigger's resolution and a spell's. This is the third, and it is
 * the same multiplying change the trigger table was (D372) — almost no new vocabulary, much more
 * coverage, because every effect this module can already read becomes reachable from an ability.
 *
 * ## The cost, which is the part that is actually printed
 *
 * `{T}`, a mana cost, or both in either order: `{T}: Add {C}.`, `{B}: Regenerate ~.`,
 * `{1}{G}, {T}: …`. Those two map straight onto `AbilityCost`'s `mana` and `tap`.
 *
 * `Pay N life` is the third, and it is read because `AbilityCost.life` exists and the engine
 * honours it: an ability whose life cost a player cannot pay is never offered, which is the printed
 * difference between a Mana Confluence and a City of Brass. Reading it here is also what finally
 * compiles a **pain land**, which `cardFromData` structurally cannot: `foldManaLines` folds a
 * permanent's mana lines into *one* cost, so it refuses a land with one free tap and one that costs
 * a life rather than flatten the two. A line reader has no such problem — the two lines are two
 * abilities with two costs, which is what the card prints.
 *
 * Deliberately **not** read: every other cost component. `{B}{G}, Sacrifice another creature:` is a
 * cost this reader would have to drop to compile the line, and an ability that is free when the
 * print says it eats a creature is not a cheaper card, it is a different one — the clearest case in
 * this module of a reading that would be worse than no reading. Same for a cost paid by removing a
 * counter or by discarding. They are refused by the cost parse rather than skipped.
 *
 * ## Mana abilities are a separate answer, because they are not an effect
 *
 * `{T}: Add {R}.` has no `effect` at all: the engine reads `produces` and resolves it without ever
 * calling a function (that is what makes a mana ability a mana ability, CR 605). So the reader
 * checks for it first and emits `produces`, exactly as `basicLand` does. A version that built an
 * `effect` adding to the pool would be an ability the mana system cannot see.
 */
/**
 * **A land that turns itself into a creature** — Mutavault's second ability.
 *
 * ## Why the two sentences are read together
 *
 * "Mutavault becomes a 2/2 creature until end of turn. It's still a land." `clausesOf` splits that
 * into two, and the second one is not an effect at all — it is the sentence that **decides what the
 * first one does**. `addTypes: ['Creature']` adds a type where `setTypes` would replace the line,
 * and "it's still a land" is the printed reason to add (CR 613.1c). A reader of the first sentence
 * alone has to guess between them, and guessing wrong makes a Mutavault that cannot be tapped for
 * mana for the rest of the turn.
 *
 * So the pair is one reading, for `pumpAndGrant`'s reason one level up: two sentences, one call.
 * An ability-shape reader rather than a clause one, consulted ahead of `composeEffects` exactly as
 * the spell-shape readers are — and a clause that says "becomes a 2/2 creature" **without** the
 * second sentence is refused rather than read as either (D259). Nothing in the pool prints it, and a
 * permanent that is not a land becoming a creature is a different family anyway (a Vehicle's crew).
 *
 * ## `setPower`, not a pump
 *
 * Layer 7b: a 2/2 **base**, so an anthem lands on top of it rather than under it. That is what the
 * hand-written card does and the engine has had the layer all along.
 *
 * ## `animates` is the hint, and it is load-bearing
 *
 * `AbilityDef.animates` is how the bot knows not to press this unless there is an attack or a block
 * to make with it. Without it the land animates itself at random for no gain and, worse, stops being
 * a mana source the auto-tapper will spend. A compiled animation without the flag is #322's failure
 * again: a card that plays and plays badly.
 */
function animateSelf(clause: string, name: string): ReadEffect | null {
  const self = selfRef(name);
  const becomes = new RegExp(
    `^(?:${self}|it) becomes a (\\d+)/(\\d+) creature until end of turn\\.\\s*it['’]s still a land$`,
    'i',
  ).exec(plain(clause).trim().replace(/\.\s*$/, ''));
  if (becomes === null) return null;
  const power = Number(becomes[1]);
  const toughness = Number(becomes[2]);
  return {
    abilityFlags: { animates: true },
    effect: (c) => pump(c.state, [c.source], c.source, c.controller, {
      addTypes: ['Creature'], setPower: power, setToughness: toughness,
    }),
  };
}

function abilityFromLine(line: string, name: string): Partial<CardScript> | null {
  const text = plain(line).trim();
  /*
    The cost, then a colon, then the clause. Every comma-separated component of the cost has to
    classify as something `AbilityCost` can say, and one that does not refuses the line — see the
    docblock for why a dropped cost component is worse than no reading.

    Classifying the components beats one regex over the whole cost: the printed orders multiply
    (`{1}, {T}`, `{T}, {1}`, `{T}, Pay 1 life`, `{1}, {T}, Pay 2 life`) and a pattern covering them
    is where a component gets quietly dropped. Here an unclassifiable component is the refusal.
  */
  const split = /^([^:]+):\s*(.+)$/.exec(text);
  if (split === null) return null;
  /*
    "Activate only as a sorcery." — a timing restriction, taken off the end before the effect is
    read (D445).

    It is the largest single sentence standing between a card and a finished script: **213 legal
    cards have no other unread line**, and the one-line-short queue (`one-line-short.mjs`) puts it
    at the top by a factor of two. It is also the cheapest, because `AbilityDef.sorcerySpeed`
    already exists and the engine already enforces it — a planeswalker's loyalty cost has carried
    the same restriction since #43, so this reads a sentence into a field rather than teaching the
    engine a rule.

    Stripped here rather than in `composeEffects`, because it is not an effect: the sentence says
    *when* the ability may be activated, and the clause vocabulary below is about what it does. A
    line whose restriction were left in would fail to read at all, which is what has been happening.
  */
  const restricted = /^(.*?)\.?\s*Activate only as a sorcery\.?\s*$/i.exec(split[2]!.trim());
  const clause = (restricted === null ? split[2]! : restricted[1]!)
    .replace(/\.\s*$/, '').trim();
  /** The flag the restriction sets, spread into whichever branch below reads the rest of the line. */
  const timing = restricted === null ? {} : { sorcerySpeed: true as const };

  /*
    A loyalty cost, which is the one cost that is a number rather than a list of components.

    `+1`, `0`, `−3` — and the minus is printed as U+2212, not a hyphen, so both are read. It is
    taken before the component loop because it shares nothing with it: `AbilityCost.loyalty` carries
    its own restrictions (sorcery speed, once a turn, and only by the permanent's controller), which
    is why it is a field rather than a cost component, and a planeswalker's line has no `{T}` or
    mana in it to classify.
  */
  const loyalty = /^([+\u2212-]?)(\d+)$/.exec(split[1]!.trim());
  if (loyalty !== null) {
    // A loyalty ability is activated from the battlefield, so that is where its subject is.
    const read = composeEffects(clausesOf(clause), name, 'battlefield');
    if (read === null) return null;
    // See `dividesAQuantity`: Ral, Caller of Storms and Samut, the Tested both print it on a -2.
    if (dividesAQuantity(read)) return null;
    const amount = loyalty[1] === '+' || loyalty[1] === '' ? Number(loyalty[2]) : -Number(loyalty[2]);
    return {
      abilities: [{
        ...timing,
        cost: { loyalty: amount },
        description: text,
        ...(read.targets === undefined ? {} : { targets: read.targets }),
        ...(read.decisions === undefined ? {} : { decisions: read.decisions }),
        // See the split in `composeEffects` (D418): an ability asks its questions before it runs,
        // exactly as a spell does, so the half that comes first has to be carried here too.
        ...(read.beforeDecisions === undefined ? {} : { beforeDecisions: read.beforeDecisions }),
        /*
          **`untapsOnly` is dropped on a loyalty ability** (D419), and the field's own docblock is
          the authority: "Garruk's +1 untaps two lands *and* puts a loyalty counter on him — both
          have a payoff the question below would miss."

          A `+N` loyalty cost **gains** a counter, so the untap is never the whole effect, and the
          flag exists for exactly one thing: stopping the bot tapping and untapping for ever
          because the board ended where it started. Here the board did not end where it started.
          Found by `compiled-vs-written.test.ts`, which is the only check that compares a compiled
          ability's flags against the hand-written one's.
        */
        ...(() => {
          const { untapsOnly, ...rest } = (read.abilityFlags ?? {}) as { untapsOnly?: boolean };
          return rest;
        })(),
        // See `ReadEffect.appliesNothing`, as the sized branch below.
        ...(read.appliesNothing === true ? {} : { effect: read.effect }),
      } as AbilityDef],
    };
  }

  let taps = 0;
  let life = 0;
  let sacrificesSelf = false;
  let discardsSelf = false;
  let sacrifices: 'creature' | 'another-creature' | 'artifact' | null = null;
  const mana: string[] = [];
  const self = selfRef(name);
  for (const component of split[1]!.split(/,\s*/).map((part) => part.trim())) {
    if (component === '') return null;
    if (/^\{T\}$/i.test(component)) { taps += 1; continue; }
    const paid = /^Pay\s+(\d+)\s+life$/i.exec(component);
    if (paid !== null) { life += Number(paid[1]); continue; }
    /*
      The three costs that are **not** mana, a tap or life, and that `AbilityCost` already carries
      and the payment already enforces (D446).

      This loop refused everything else, so an ability whose cost named one of them read as nothing
      at all — and it is the commonest cost in Magic after mana: of the unread lines whose *effect*
      this compiler can already read once the cost is swapped for `{1}`, **415** print "Sacrifice
      <this permanent>", 143 "Sacrifice a creature / another creature / an artifact", and 14
      "Discard <this card>".

      `selfRef` is what makes the first one one reader rather than five: the corpus prints
      "Sacrifice Abandoned Outpost", "Sacrifice this artifact", "Sacrifice this land" and "Sacrifice
      this creature" for the same cost, and that function already knows all four spellings (D426,
      D438).

      **What is refused is as deliberate as what is read.** "Sacrifice a land" (27 lines),
      "Sacrifice a Goblin" (15), "Tap an untapped creature you control" (18), "Remove a +1/+1
      counter from ~" (35) and "Exile ~ from your graveyard" (17) have **no field on
      `AbilityCost`**, so there is nothing to read them into — and inventing one would be a cost the
      payment does not charge, which is an ability that activates for free. A line naming one stays
      unread, which is the honest half of D362.
    */
    if (new RegExp(`^Sacrifice ${self}$`, 'i').test(component)) { sacrificesSelf = true; continue; }
    if (new RegExp(`^Discard ${self}$`, 'i').test(component)) { discardsSelf = true; continue; }
    const sacrificed = /^Sacrifice (a creature|another creature|an artifact)$/i.exec(component);
    if (sacrificed !== null) {
      // One sacrifice per cost: nothing prints two, and two would need a count the field has not
      // got, so a second one refuses the line rather than being silently dropped.
      if (sacrifices !== null) return null;
      const which = sacrificed[1]!.toLowerCase();
      sacrifices = which === 'a creature'
        ? 'creature'
        : which === 'another creature' ? 'another-creature' : 'artifact';
      continue;
    }
    if (!/^(?:\{[^}]+\})+$/.test(component)) return null;
    /*
      `parseManaCost` records an unrecognised symbol rather than ignoring it, which is what makes it
      the validator here: `{E}` or `{T}` inside a run would otherwise be read as generic mana. `{X}`
      is refused too — announcing X on an activated ability is machinery this reader does not reach,
      and nothing in the pool hand-writes an X ability cost to compare against.
    */
    const parsed = parseManaCost(component);
    if (parsed.unsupported !== undefined || parsed.x) return null;
    mana.push(component);
  }
  /*
    More than one tap is not a cost; a cost that is nothing at all is not a line this reads.

    The three new components count towards "is there a cost at all", which they have to: "Sacrifice
    a creature: Add {C}{C}" is Ashnod's Altar, whose whole cost is the sacrifice.
  */
  const anything = taps > 0 || mana.length > 0 || life > 0
    || sacrificesSelf || discardsSelf || sacrifices !== null;
  if (taps > 1 || !anything) return null;
  const cost: AbilityCost = {
    ...(mana.length === 0 ? {} : { mana: mana.join('') }),
    ...(taps === 1 ? { tap: true } : {}),
    ...(life === 0 ? {} : { life }),
    ...(sacrificesSelf ? { sacrificeSelf: true as const } : {}),
    ...(discardsSelf ? { discardSelf: true as const } : {}),
    ...(sacrifices === null ? {} : { sacrifice: sacrifices }),
  };

  /*
    A mana ability, which is `produces` and no effect at all. `Add {R}{G}` is two symbols and one
    ability.
  */
  const adding = /^add ((?:\{[WUBRGC]\}\s*)+)$/i.exec(clause);
  if (adding !== null) {
    const produces = (adding[1]!.match(/\{([WUBRGC])\}/g) ?? [])
      .map((sym) => sym.slice(1, -1).toUpperCase() as ManaType);
    if (produces.length === 0) return null;
    return { abilities: [{ ...timing, cost, description: text, produces }] };
  }

  /*
    And a mana ability that is a **choice** of colours: "Add {B} or {R}", "Add {W}, {U}, or {B}",
    "Add one mana of any color".

    `AbilityDef` has no "one of these" — the hand-written dual lands and Birds of Paradise express it
    as **one ability per colour**, and `manaSources` collapses several free tap-for-mana abilities on
    one permanent back into a single source that makes one of their colours. So this emits the same
    shape the pool already uses rather than a new one.

    **This branch's docblock used to say the opposite** — that a choice "is left to `cardFromData`'s
    land path rather than guessed at here" — and the corpus says that leaves cards on the floor
    rather than safe: 252 legal lines print "Add {c} or {c}", 112 "Add one mana of any color" and 22
    "Add {c}, {c}, or {c}", and **67 + 55 of those cards have no other unread line at all** (D444).
    `cardFromData` reads a whole card or nothing, so a dual land that also enters tapped and gains
    its controller a life gets no script from it, and this reader is the only thing that can finish
    one.

    The description is **per colour**, not the printed line, for the same reason the Guildgates are
    written that way: the table shows a description on the button a player presses, and two buttons
    both reading "{T}: Add {B} or {R}." cannot be told apart. The cost prefix is kept verbatim, so
    "{1}, {T}: Add {B} or {R}." becomes two abilities reading "{1}, {T}: Add {B}." and "{1}, {T}: Add
    {R}.".

    Everything narrower stays unread, and each is a restriction this shape cannot express: "Spend
    this mana only to cast a creature spell" (37 legal lines), "Add one mana of the chosen color"
    (20 — there is no chosen colour until an `As ~ enters` reader exists), "Add two mana in any
    combination of colors" (10), "Add {c} or one mana of the chosen color" (10). They are refused by
    the anchors rather than by a list: a second sentence or an extra word simply does not match.
  */
  const choice = /^add ((?:\{[WUBRGC]\}, )*\{[WUBRGC]\},? or \{[WUBRGC]\})$/i.exec(clause);
  const anyColour = /^add one mana of any colou?r$/i.test(clause);
  if (choice !== null || anyColour) {
    const options: readonly ManaType[] = choice === null
      ? COLOURS
      : (choice[1]!.match(/\{([WUBRGC])\}/g) ?? [])
        .map((sym) => sym.slice(1, -1).toUpperCase() as ManaType);
    if (options.length === 0) return null;
    return {
      abilities: options.map((colour) => ({
        ...timing,
        cost, description: `${split[1]!.trim()}: Add {${colour}}.`, produces: [colour],
      })),
    };
  }

  /*
    The animation shape before the clause vocabulary, for the reason in `animateSelf`'s docblock: its
    two sentences are one reading, and the second decides what the first does. Only here and not in
    the loyalty branch above — a planeswalker animating itself is a sentence no card in the pool
    prints, and a reader with nothing to check against is a reader written ahead of need.
  */
  // An activated ability on a permanent is activated from the battlefield (see `SubjectZone`).
  const read = animateSelf(clause, name)
    ?? composeEffects(clausesOf(clause), name, 'battlefield');
  if (read === null) return null;
  /*
    A **divided** quantity on an activated ability is refused, and the line stays unread.

    `AutoActivateAction` carries no division — `autoActions.ts` says so and throws rather than
    dealing the whole amount to the first target — so emitting the ability here produces a card the
    engine offers and then refuses. That is not a wrong reading in the D362 sense; it is worse,
    because `legalActions` puts the button on the table and pressing it ends the game with an error.
    `playout.test.ts`' standing invariant says the engine never offers a play it then refuses, and
    this is the second place this session where that assertion was green only because no built-in
    deck had the card (D460 was the first).

    So the honest reading is no reading: the line is flagged, the rest of the card still compiles,
    and the card is cast and played with one line a human has to resolve.

    Found by `corpus-decks.mjs` at seed 30072 of a 100-pod sweep (#336, D463). Three legal cards
    print it on an activated ability — **Mogg Mob** ("Sacrifice Mogg Mob: It deals 3 damage divided
    as you choose among one, two, or three targets"), and the -2 of **Ral, Caller of Storms** and
    **Samut, the Tested**. Counted over the whole corpus rather than guessed, which is what decided
    the fix: three cards is a line here, not a feature in the engine.

    The **spell** path keeps division, because the engine implements it there (#119): the amounts are
    announced as the spell is cast. Only the ability path has no machinery for it.
  */
  if (dividesAQuantity(read)) return null;
  return {
    abilities: [{
      ...timing,
      cost,
      // The printed line, which is what every hand-written ability stores.
      description: text,
      ...(read.targets === undefined ? {} : { targets: read.targets }),
      ...(read.decisions === undefined ? {} : { decisions: read.decisions }),
      // See the split in `composeEffects` (D418).
      ...(read.beforeDecisions === undefined ? {} : { beforeDecisions: read.beforeDecisions }),
      // See `ReadEffect.abilityFlags`: fields that only an ability can hold.
      ...(read.abilityFlags ?? {}),
      // See `ReadEffect.appliesNothing`: `AbilityDef.effect` is optional, so an ability that is
      // only a question carries none rather than an identity.
      ...(read.appliesNothing === true ? {} : { effect: read.effect }),
    } as AbilityDef],
  };
}

/**
* A label with no rules meaning, taken off the front of a line.
 *
 * "Metalcraft — ~ gets +2/+2 as long as …", "Battalion — Whenever ~ and at least two other
 * creatures attack, …", "Blade of Magnus — Whenever Magnus the Red deals combat damage to a
 * player, …". An **ability word** is flavour with no rules meaning (CR 207.2c): it names a pattern
 * for players, and the sentence after the dash is the whole of the ability. Universes Beyond prints
 * the same shape with a one-card flavour name instead of a shared word, which is the same thing
 * wearing a different hat. So the right thing to do with either is drop it.
 *
 * ## It is a refusal list, not an allow list, and the corpus is why
 *
 * This was three words — `metalcraft`, `battalion`, `landfall` — on the argument that a general
 * rule would also eat a Saga's chapter markers. The corpus says an allow list cannot work: of the
 * **2,733 legal lines** carrying a letters-only label and an em dash, there are **540 distinct
 * labels**, and most of the ones whose remainder this compiler can read are *one-card* names —
 * "Rosarius", "Keen Senses", "Gae Bolg". A list naming them would be a list of cards.
 *
 * So the question is inverted: a label comes off **unless** it has a rules meaning. Three things do:
 *
 * 1. **A keyword ability's name.** `KEYWORD_ABILITY_NAMES` is the vocabulary, matched on the whole
 *    label or on its first word, which is what catches "Suspend X" and "Splice onto Arcane". The
 *    em dash there joins a keyword to its **cost**, not a label to an ability:
 *    "Cumulative upkeep—Put a -1/-1 counter on Aboroth", "Escape—{2}{R}, Exile three other cards",
 *    "Flashback—{1}{G}, Pay 3 life". Dropping "Cumulative upkeep" turns a price into an
 *    unconditional effect, which is the worst thing this module can do (D362).
 *
 *    **Including the three whose remainder *would* read**, which is the judgement in this entry:
 *    `Exhaust` (43 lines, 15 readable), `Boast` (18, 8) and `Max speed` (40, 5) print
 *    "<keyword> — <activated ability>", and each keyword *is* the restriction on that ability —
 *    exhaust may be activated only once, boast only during your turn and only after this creature
 *    attacked. Read the remainder on its own and the engine offers an unrestricted ability, which
 *    is a wrong reading of 28 real cards rather than 28 lines left unread.
 *
 * 2. **`ward` and `channel`**, two keyword abilities `KEYWORD_ABILITY_NAMES` does not name — it
 *    lists the keywords whose *declaration* this module recognises, and those two are read
 *    elsewhere. 51 legal lines print "Ward—<cost>" and 40 "Channel — <ability>", and channel's
 *    ability is activated from your **hand**, so the remainder read as an ordinary activated
 *    ability would be activatable from the battlefield.
 *
 * 3. **A Saga's chapter markers** (CR 714), which are letters before an em dash like any label:
 *    `I`, `II`, `III`, `IV` account for **473 legal lines**. "I, II" and "II, III" carry a comma
 *    and the label pattern already refuses them.
 *
 * The label pattern itself does the rest of the refusing: letters, apostrophes and spaces only, at
 * most four words, so a digit ("Suspend 3", "Descend 4", a loyalty die's "3 —"), a bullet
 * ("• Khans"), a mana symbol ("+ {1} —", "{TK}{TK} —") or a comma can never be a label. Modal
 * spells are safe for a different reason, measured rather than assumed: **no** legal line prints
 * "Choose one —" with anything after it on the same line.
 *
 * Em and en dash only. The ASCII hyphen was in the old separator class and never mattered, because
 * the allow list had three entries; with a general rule it would let a hyphen inside a label split
 * the line, so it is gone.
 */
const NOT_AN_ABILITY_WORD: readonly string[] = [
  ...KEYWORD_ABILITY_NAMES, 'ward', 'channel', 'i', 'ii', 'iii', 'iv', 'v',
];

function withoutAbilityWord(line: string): string {
  const split = /^([A-Za-z][A-Za-z'’]*(?: [A-Za-z'’]+){0,3})\s*[—–]\s*(.+)$/
    .exec(line.trim());
  if (split === null) return line;
  const label = plain(split[1]!).toLowerCase();
  // The whole label, and its first word: "Suspend X" and "Splice onto Arcane" are keyword costs,
  // and no ability word in the corpus begins with a keyword's name.
  if (NOT_AN_ABILITY_WORD.includes(label)) return line;
  if (NOT_AN_ABILITY_WORD.includes(label.split(' ')[0]!)) return line;
  return split[2]!.trim();
}

/**
 * A creature whose size **is** a count: a characteristic-defining ability (CR 604.3).
 *
 * Two cards and two counts, which is all `definesSize` has: Lhurgoyf's power is the creature cards
 * in *all* graveyards and its toughness is that number plus one; Enigma Drake's power is the
 * instants and sorceries in *your* graveyard and its toughness is printed. The counts are named in
 * `definesSize` rather than written as a vocabulary, for D57's reason — a count with no card behind
 * it is a count nothing has ever run — so this reads exactly the two phrases the pool prints and
 * refuses every other.
 *
 * ## The two shapes are one sentence with an optional tail
 *
 * "and its toughness is equal to that number plus N" is what makes it a Lhurgoyf. Present, and the
 * count defines **both** (`applies` left off, which is the field's default) with `toughnessPlus`;
 * absent, and it defines the **power** only, which is the Drake printed with a star for power and a
 * number for toughness. Those are precisely the two hand-written scripts.
 *
 * The apostrophe is matched both ways: a card's printed text uses the typographic `’` and plain
 * ASCII `'` turns up in hand-entered rows.
 */
const CDA_COUNTS: Readonly<Record<string, 'creature-cards-in-graveyards' | 'instant-and-sorcery-cards-in-your-graveyard'>> = {
  'creature cards in all graveyards': 'creature-cards-in-graveyards',
  'instant and sorcery cards in your graveyard': 'instant-and-sorcery-cards-in-your-graveyard',
};

function definesSizeFromLine(line: string, name: string): Partial<CardScript> | null {
  const self = selfRef(name);
  const matched = new RegExp(
    `^${self}['’]s power is equal to the number of (.+?)` +
    `(?: and its toughness is equal to that number plus (\\d+))?$`,
    'i',
  ).exec(plain(line).trim().replace(/\.\s*$/, ''));
  if (matched === null) return null;

  const count = CDA_COUNTS[matched[1]!.trim().toLowerCase()];
  if (count === undefined) return null;

  const plus = matched[2];
  return {
    statics: [{
      scope: 'self',
      effect: {
        definesSize: plus === undefined
          // Power only, and the printed toughness left alone.
          ? { count, applies: 'power' as const }
          // Both, which is `applies`' default, with the toughness one higher.
          : { count, toughnessPlus: Number(plus) },
      },
    }],
  };
}

/**
 * "At the beginning of the end step, sacrifice ~" — and the flag that goes with it.
 *
 * A **whole-line** shape rather than a prologue plus a clause, which is the D364 rule in its
 * sharpest form. The trigger alone is a correct rules implementation and a badly played card: the
 * bot reads `leavesAtEndOfTurn` to know the creature is dying anyway, and without it the evaluation
 * holds a Ball Lightning back to protect a 6/1 that will be in the graveyard either way. Both
 * hand-written cards say so in a comment above the flag.
 *
 * It cannot be a clause reader for the same reason. "Sacrifice ~" on its own does not mean the
 * permanent leaves at *end of turn* — behind a different prologue it means something else entirely
 * — so the flag belongs to the pair, and a generic clause would let some other prologue emit the
 * trigger without it. That is exactly the card that works and is wrong.
 *
 * `of: 'any'` and not `of: 'you'`: "the end step" is every player's, which is what makes a Ball
 * Lightning cast on somebody else's turn die on that turn.
 */
function sacrificeAtEndOfTurnFromLine(line: string, name: string): Partial<CardScript> | null {
  const self = selfRef(name);
  const matched = new RegExp(
    `^At the beginning of the end step, sacrifice (?:${self}|it)$`, 'i',
  ).exec(plain(line).trim().replace(/\.\s*$/, ''));
  if (matched === null) return null;
  return {
    leavesAtEndOfTurn: true,
    triggers: [{
      on: { kind: 'step', step: 'end', of: 'any' },
      description: `sacrifice ${name}`,
      effect: sacrificeSelf,
    }],
  };
}

/**
 * A static that is only on while something is true — the shape `while` exists for.
 *
 * Three cards, and all three are a condition the engine already has data for. There are exactly two
 * kinds (see `PumpOptions.while`) and this reads the English of both:
 *
 * - **"as long as you control three or more artifacts"** → `controller-artifacts`, which is
 *   metalcraft. Printed on a size bonus (Chrome Steed) and on protection (Etched Champion).
 * - **"as long as ~ is monstrous"** → `source-has-counter`, because this engine *is* a +1/+1
 *   counter on the creature itself when it is monstrous (D182), which is the modelling the
 *   hand-written Fleecemane Lion uses and not a reading invented here.
 *
 * ## "protection from all colors" is the list with everything in it
 *
 * Not a special case: protection is already a list of colours (D83), so all five is what the card
 * says and every rule protection has applies without anything new. The hand-written Etched Champion
 * stores exactly `['W', 'U', 'B', 'R', 'G']`.
 *
 * ## What is refused
 *
 * Any other number of artifacts, any other condition, and any keyword `isKeyword` cannot read — a
 * static granting a word the engine ignores is a creature that looks protected and is not, which is
 * the same argument the grant family makes for a pump.
 */
function conditionalStaticFromLine(line: string, name: string): Partial<CardScript> | null {
  const text = withoutAbilityWord(plain(line).trim().replace(/\.\s*$/, ''));
  const self = selfRef(name);

  /*
    The condition comes off the end first, because the effect in front of it is the same sentence a
    plain static prints. Both forms put it last, and `as long as` is unambiguous: nothing else in a
    printed line opens with those four words.
  */
  const metalcraft = new RegExp(
    `^(?:${self}|it) (gets \\+(\\d+)\\/\\+(\\d+)|has protection from all colors)` +
    ' as long as you control three or more artifacts$',
    'i',
  ).exec(text);
  if (metalcraft !== null) {
    const condition = { kind: 'controller-artifacts', atLeast: 3 } as const;
    if (metalcraft[2] !== undefined && metalcraft[3] !== undefined) {
      const bonus = sizeBonus(Number(metalcraft[2]), Number(metalcraft[3]));
      if (bonus === null) return null;
      return { statics: [{ scope: 'self', effect: { ...bonus, while: condition } }] };
    }
    return {
      statics: [{
        scope: 'self',
        effect: { protectionFrom: ['W', 'U', 'B', 'R', 'G'], while: condition },
      }],
    };
  }

  const monstrous = new RegExp(
    `^as long as (?:${self}|it) is monstrous, (?:${self}|it) has (.+)$`, 'i',
  ).exec(text);
  if (monstrous !== null) {
    const keywords = grantedKeywordList(monstrous[1]!);
    if (keywords === null) return null;
    return {
      statics: [{
        scope: 'self',
        effect: {
          keywords,
          while: { kind: 'source-has-counter', counter: '+1/+1', atLeast: 1 },
        },
      }],
    };
  }

  return null;
}

/**
 * A printed **static** ability: a continuous effect a permanent applies for as long as it is there.
 *
 * One shape, and it is the commonest static in Magic: `Creatures you control get +1/+1`. The word
 * "other" is the whole of the difference between the two scopes the engine has —
 * `controller-creatures` includes the permanent itself and `other-controller-creatures` does not —
 * and it is load-bearing rather than cosmetic: Judith is a 2/2 and prints "Other creatures you
 * control get +1/+0", so a reader that collapsed the two would make her a 3/2.
 *
 * Not an effect, which is why this is its own reader rather than a clause: a static is never
 * resolved and never put on the stack. `characteristicsOf` consults it every time it computes a
 * creature's size, so the fragment is a `statics` entry and nothing else.
 *
 * `sizeBonus` for the bonus itself, so `+1/+0` is `{ power: 1 }` and not `{ power: 1, toughness:
 * 0 }` — the same rule everywhere a bonus is read, and the one Judith's hand-written script uses.
 */
function staticFromLine(line: string): Partial<CardScript> | null {
  const anthem = /^(other )?creatures you control get \+(\d+)\/\+(\d+)$/i
    .exec(plain(line).trim().replace(/\.\s*$/, ''));
  if (anthem === null) return null;
  const effect = sizeBonus(Number(anthem[2]), Number(anthem[3]));
  if (effect === null) return null;
  return {
    statics: [{
      scope: anthem[1] === undefined ? 'controller-creatures' : 'other-controller-creatures',
      effect,
    }],
  };
}

/**
 * "~ enters the battlefield with N counters on it" (CR 614.1c), as a printed sentence.
 *
 * `entersWith` already existed and three keywords already built it — modular, vanishing and fading
 * each declare a count — but the **sentence** went unread, which is how Endless One, whose whole
 * card is that one line, was a `printed-only` card for a field the engine has had all along.
 *
 * Not a trigger and not a static: a permanent entering with counters is a replacement effect
 * applied as it arrives, so the fragment is the declaration and nothing else. That is why this is
 * its own reader in `lineScriptFor`'s chain rather than a clause.
 *
 * ## The count
 *
 * `X` is the cast's X, which `entersWith` spells `'x'` and the engine resolves to zero for a
 * permanent that arrived any other way (reanimated, copied, made as a token) — the rule, not a
 * shortcut, and written down where `entersWith` is declared.
 *
 * ## Why the counter kinds are an allow-list
 *
 * A counter kind is a key in a plain record, so an unknown one would be *stored* and read by
 * nothing. For `+1/+1`, `charge` and `ice` that is exactly the printed card: `characteristicsOf`
 * reads +1/+1 counters itself, and the charge and ice counters are read by another line of the same
 * card, which is read or unread on its own merits (Chalice of the Void and Thing in the Ice are both
 * hybrids for that reason).
 *
 * `time` and `fade` are refused. Their behaviour does not live in the counters at all — it lives in
 * the trigger that vanishing and fading put on the card — so a sentence that laid them on without
 * that keyword would be a countdown nothing counts down: a permanent that should have left the
 * battlefield and stays. Every pool card that has them declares the keyword, and the keyword reader
 * builds both halves together (D364).
 */
const SENTENCE_COUNTERS: readonly string[] = ['+1/+1', 'charge', 'ice'];

function entersWithFromLine(line: string, name: string): Partial<CardScript> | null {
  const matched = new RegExp(
    `^${selfRef(name)} ${ENTERS} with (X|[\\w+/]+) ([\\w+/]+) counters? on it$`,
    'i',
  ).exec(plain(line).trim().replace(/\.\s*$/, ''));
  if (matched === null) return null;

  const kind = matched[2]!.toLowerCase();
  if (!SENTENCE_COUNTERS.includes(kind)) return null;

  const printed = matched[1]!;
  const amount = printed.toLowerCase() === 'x' ? 'x' as const : countFrom(printed);
  if (amount === null) return null;
  return { entersWith: { counter: kind, amount } };
}

/**
 * "As an additional cost to cast this spell, sacrifice a creature."
 *
 * Not part of the resolution, which is why it needs a reader of its own rather than a clause: a
 * spell's sentences all happen when it resolves, and this one happens as it is **cast** (CR
 * 601.2h). Handing it to `composeEffects` would either refuse the card or, worse, run the sacrifice
 * on resolution — where it can be responded to and the creature can be saved in reply, which is a
 * different card.
 *
 * `additionalCost` is the field, and the engine already honours it: a spell whose additional cost
 * cannot be paid is **not offered** rather than offered and refused, so Bone Splinters with an empty
 * board is not a legal play.
 *
 * Only the sacrifice, because that is the only shape the field has. "Discard a card", "pay 3 life"
 * and the rest are real printed costs this engine cannot express, and a reader that dropped them
 * would make a spell cheaper than the card — the clearest kind of card that works and is wrong.
 */
function additionalCostFromLine(line: string): Partial<CardScript> | null {
  const matched = /^As an additional cost to cast this spell, sacrifice (a|another) creature$/i
    .exec(plain(line).trim().replace(/\.\s*$/, ''));
  if (matched === null) return null;
  return {
    additionalCost: {
      sacrifice: matched[1]!.toLowerCase() === 'another' ? 'another-creature' : 'creature',
    },
  };
}

/**
 * "~ enters tapped", on a line of its own.
 *
 * `cardFromData` already reads this phrase, and that is exactly why it was missing here: it reads it
 * only as part of a **whole** card it can account for, so a land printing nothing else was read and
 * a land printing one more line the whole-card path could not take was reported as two unread lines
 * — the tapped clause among them. The corpus counts 347 cards printing it and 760 printing "enters
 * with", which is how a one-line reader came to be the fourth-biggest bucket in all of Magic.
 *
 * `entersTapped` is a field rather than a replacement effect for the reason the field's own docblock
 * gives: arriving tapped is a property of the permanent's own arrival, so the engine applies it as
 * the card is put onto the battlefield and nothing goes on the stack.
 *
 * Both spellings of the subject, through `selfRef`: the corpus prints "Joined Up enters tapped" and
 * "This land enters tapped" about equally, and `fromCardData`'s own check compares the rest of the
 * string after the name, so it reads the first and not the second.
 */
function entersTappedFromLine(line: string, name: string): Partial<CardScript> | null {
  const text = plain(line).trim().replace(/\.\s*$/, '');
  return new RegExp(`^${selfRef(name)} ${ENTERS} tapped$`, 'i').test(text)
    ? { entersTapped: true }
    : null;
}

/**
 * Everything the compiler can read off one printed line of a **permanent**: a keyword, a triggered
 * ability, or an activated one.
 *
 * Keywords first because they are exact matches on a short line and cannot be confused for a
 * sentence.
 */
export function lineScriptFor(line: string, name: string): Partial<CardScript> | null {
  return keywordScriptFor(line, name)
    ?? additionalCostFromLine(line)
    // Before the statics: "enters tapped" is a fact about arriving, not a continuous effect.
    ?? entersTappedFromLine(line, name)
    ?? staticFromLine(line)
    ?? conditionalStaticFromLine(line, name)
    ?? definesSizeFromLine(line, name)
    ?? entersWithFromLine(line, name)
    /*
      Before `triggerFromLine`, because it is a **more specific** reading of a line that reader
      would also match: see its docblock for why the trigger and the flag are one unit.
    */
    ?? sacrificeAtEndOfTurnFromLine(line, name)
    ?? triggerFromLine(line, name)
    ?? abilityFromLine(line, name);
}

/** What the compiler made of an instant or sorcery: the script, and which lines it accounts for. */
export interface SpellReading {
  readonly script: Partial<CardScript> | null;
  readonly compiled: readonly string[];
  readonly unread: readonly string[];
}

/**
 * An instant or sorcery, read as a whole.
 *
 * ## A spell's lines are not all the same kind of thing
 *
 * A permanent's text is a list of independent abilities, so `lineScriptFor` reads it one line at a
 * time. A spell's **resolution** is not: every sentence of it happens in one go, so a spell whose
 * second sentence went unread would resolve and silently do half of what it prints, with nothing
 * flagged for anybody to notice. That is the one outcome worse than not reading it at all, because
 * an unread spell is a manual object inside an automated game (D362) and a half-read one is not.
 *
 * But a spell's lines are **not** all resolution. Grapeshot is "deals 1 damage to any target" plus
 * *Storm*; Sudden Shock is "deals 2 damage to any target" plus *Split second*; Pyromatics is a
 * damage clause plus *Replicate {1}{R}*. Those keywords are properties of the card, not steps of
 * its resolution — and the first version of this function ignored that, treating every line of a
 * spell as resolution and refusing all three cards outright. It threw away a keyword reading that
 * had worked, which is a new path **replacing** an old one instead of extending it. The
 * ground-truth tests caught it on the first run; nothing else would have.
 *
 * So: partition. Keyword lines are read as keywords, exactly as they are on a permanent. Whatever
 * is left is the resolution, and it is all-or-nothing.
 */
/**
 * "Choose one —", and the bullets under it.
 *
 * ## Why this is a whole-card shape and not a line reader
 *
 * A modal spell's text is **one sentence spread over several lines**: a header that says how many
 * modes to take and a bullet per mode. No line of it means anything alone — a bullet without its
 * header is a sentence the spell does not have, and a header without its bullets is a question with
 * no answers. So it is read as a group, before `readResolution` sees the lines at all, and refused
 * whole if any bullet is refused. A modal card with one unreadable mode is not a card missing an
 * option; `legalActions` would offer the modes it did read as though they were the whole card, which
 * is a different and better spell than the one printed.
 *
 * ## Modes are chosen at cast time, which is why they are not decisions
 *
 * `ModalDef`'s own docblock has the rules argument (CR 601.2b): the choice travels with the cast,
 * before targets, where an opponent can see it and respond. Reading a charm as a mid-resolution
 * decision would let somebody counter it without knowing what it was going to do. Nothing here has
 * to arrange that — putting the reading in `modal` is what gets it.
 *
 * ## The two headers, and nothing else
 *
 * "Choose one —" and "Choose one or both —" are what the pool prints, and they are the only two
 * read. "Choose two", "Choose one. You may choose the same mode more than once", and the entwine and
 * escalate headers are refused rather than guessed at: each is a different `min`/`max`, and a header
 * read as the wrong one is a card that takes the wrong number of modes. "Choose one" leaves `min`
 * and `max` off, which is what they default to and what Selesnya Charm stores.
 *
 * ## What a mode may carry, and the one hint it drops
 *
 * `ModeDef` holds `expiresAtEndOfTurn` and `preventsDamage` and no other flag, which is the shape a
 * person writing the card by hand has too. Both are carried through. `removesACreature` is **not**,
 * and is dropped rather than refused, because it is already enforced structurally for a mode: as
 * `ModalDef` says, "a combination whose targets cannot be filled is not offered at all", so a
 * destroy mode is never offered with no creature to point at — which is the whole of what the flag
 * buys on a spell whose targets are mandatory. Any *other* flag refuses the card, since no such
 * argument exists for it and a silently dropped hint is a card that plays badly with nothing to
 * flag it (D362).
 */
function modalScriptFor(lines: readonly string[], name: string): { modal: ModalDef } | null {
  if (lines.length < 3) return null;
  const header = /^choose (one|one or both)\s*[—-]?$/i.exec(plain(lines[0]!).trim());
  if (header === null) return null;

  const modes: ModeDef[] = [];
  for (const line of lines.slice(1)) {
    const bullet = /^[•\u2022]\s*(.+)$/.exec(plain(line).trim());
    if (bullet === null) return null;
    const printed = bullet[1]!.replace(/\s*\.\s*$/, '').trim();
    // A spell's "itself" is a card on the stack, not a permanent: see `SubjectZone`.
    const read = composeEffects(clausesOf(printed), name, null);
    if (read === null) return null;
    const flags = { ...(read.spellFlags ?? {}) } as Record<string, unknown>;
    const expires = flags['expiresAtEndOfTurn'] === true;
    const prevents = flags['preventsDamage'] === true;
    delete flags['expiresAtEndOfTurn'];
    delete flags['preventsDamage'];
    // See the docblock: this one is structurally redundant on a mode, the rest are not.
    delete flags['removesACreature'];
    if (Object.keys(flags).length > 0) return null;
    modes.push({
      description: printed,
      ...(read.targets === undefined ? {} : { targets: read.targets }),
      ...(read.decisions === undefined ? {} : { decisions: read.decisions }),
      effect: read.effect,
      ...(expires ? { expiresAtEndOfTurn: true } : {}),
      ...(prevents ? { preventsDamage: true } : {}),
    });
  }
  // "one or both" is two modes by definition; a header that says it over three is not a card.
  if (header[1]!.toLowerCase() === 'one or both') {
    return modes.length === 2 ? { modal: { min: 1, max: 2, modes } } : null;
  }
  return { modal: { modes } };
}

/**
 * Kicker, read as the declaration **and** the payoff it declares (CR 702.33).
 *
 * The one keyword `keywordScriptFor`'s docblock named as deliberately absent from its
 * alternative-cost table, and it gave the reason: kicker's payoff "is printed on another line — 'If
 * this spell was kicked, it deals 4 damage instead' — so the declaration alone is an option to pay
 * more for nothing, which is not the card". That argument is right and it is also the specification
 * for this reader: read the pair, or read neither. D364 again.
 *
 * So this is a **whole-spell** shape, the way an Aura is a whole-card shape on the permanent path.
 * It runs before the keyword loop in `spellScriptFor`, because the loop would otherwise push
 * `Kicker {4}` into `declared` and report it as an unimplemented keyword while the resolution line
 * was refused separately — which is what both of the pool's kicker burn spells did.
 *
 * ## What it refuses, and why that is narrow on purpose
 *
 * Exactly two printed lines: the declaration and one resolution line of two clauses, "deals N
 * damage to <somewhere>" then "if this spell was kicked, it deals M damage instead". Agonizing
 * Demise also has kicker and is **not** this shape — its kicked half throws the dead creature's
 * power at its controller, which is a different effect and not a different number — so it stays
 * unread rather than being forced through a reading about numbers.
 *
 * The destination comes from `damageDestination`, so "any target" (Burst Lightning) and "each
 * creature without flying and each player" (Breath of Darigaaz) are read by the same table the
 * unkicked damage family uses. The only thing kicker contributes is **which of two printed numbers**
 * the amount is, chosen as the spell resolves from `EffectContext.kicked` — which is how both
 * hand-written scripts are written, and the reason `kicked` is a flag on the context rather than a
 * second effect function.
 */
function kickerSpellFor(
  lines: readonly string[], name: string,
): { fragment: Partial<CardScript>; claimed: readonly string[] } | null {
  if (lines.length !== 2) return null;
  const declaring = /^kicker\s+((?:\{[^}]*\})+)$/i;
  const declaration = lines.find((line) => declaring.test(plain(line).trim()));
  const body = lines.find((line) => line !== declaration);
  if (declaration === undefined || body === undefined) return null;
  const cost = declaring.exec(plain(declaration).trim())![1]!;

  const clauses = clausesOf(body);
  if (clauses.length !== 2) return null;
  const self = selfRef(name);
  const base = new RegExp(`^(?:${self}|it) deals (\\d+) damage to (.+?)$`, 'i')
    .exec(clauses[0]!.trim().replace(/\.\s*$/, ''));
  const kicked = /^if this spell was kicked, it deals (\d+) damage instead$/i
    .exec(clauses[1]!.trim().replace(/\.\s*$/, ''));
  if (base === null || kicked === null) return null;

  const dest = damageDestination(base[2]!);
  if (dest === null) return null;
  const unkickedAmount = Number(base[1]);
  const kickedAmount = Number(kicked[1]);
  return {
    fragment: {
      // The printed line is the description rather than one rebuilt from the cost, so the table
      // shows a player what the card shows them.
      kicker: { cost, description: plain(declaration).trim() },
      ...(dest.targets === undefined ? {} : { targets: dest.targets }),
      ...(dest.spellFlags ?? {}),
      onResolve: (c) => dest.apply(c, c.kicked === true ? kickedAmount : unkickedAmount),
    },
    // Both lines, in printed order: the shape is the whole card.
    claimed: [...lines],
  };
}

export function spellScriptFor(lines: readonly string[], name: string): SpellReading {
  /*
    The kicker pair, before anything else, because the keyword loop below would split it: the
    declaration would land in `declared` as an unimplemented keyword and the resolution line would
    be refused on its own, which is a card reported as two separate failures rather than read. See
    `kickerSpellFor` for why the two lines are one unit.
  */
  const kicker = kickerSpellFor(lines, name);
  if (kicker !== null) {
    return { script: kicker.fragment, compiled: kicker.claimed, unread: [] };
  }

  const built: Record<string, unknown> = {};
  const compiled: string[] = [];
  const resolution: string[] = [];

  const declared: string[] = [];

  for (const line of lines) {
    /*
      The additional cost is read here beside the keywords, and for the same reason: it is not part
      of the resolution, so it must come out of `resolution` before `readResolution` sees it — a
      sentence about casting handed to the clause readers refuses the card at best and runs the
      sacrifice on resolution at worst.
    */
    const keyword = keywordScriptFor(line, name) ?? additionalCostFromLine(line);
    if (keyword === null) {
      /*
        A keyword nothing here can build is still not part of the resolution. Putting it there is
        what refused Thunderous Wrath over `Miracle {R}` while reading its damage clause perfectly
        well; `isKeywordDeclaration` has the argument for why skipping it is safe where skipping a
        sentence is not.
      */
      if (isKeywordDeclaration(line)) { declared.push(line); continue; }
      resolution.push(line);
      continue;
    }
    for (const [key, value] of Object.entries(keyword)) {
      if (key === 'triggers') {
        const existing = (built['triggers'] ?? []) as readonly unknown[];
        built['triggers'] = [...existing, ...(value as readonly unknown[])];
        continue;
      }
      built[key] = value;
    }
    compiled.push(line);
  }

  /*
    The modal shape is tried before the resolution reader, because a modal spell's lines do not
    compose: `readResolution` would hand "Choose one —" to `readEffect` as a clause, get null, and
    refuse the card without ever seeing that the bullets under it are three readable modes.
  */
  const modal = modalScriptFor(resolution, name);
  if (modal !== null) {
    Object.assign(built, modal);
    return {
      script: built as Partial<CardScript>,
      compiled: [...compiled, ...resolution],
      unread: declared,
    };
  }

  const read = readResolution(resolution, name);
  if (read === null) {
    const script = Object.keys(built).length === 0 ? null : built as Partial<CardScript>;
    return { script, compiled, unread: [...declared, ...resolution] };
  }

  Object.assign(built, read.spellFlags ?? {});
  if (read.targets !== undefined) built['targets'] = read.targets;
  if (read.decisions !== undefined) built['decisions'] = read.decisions;
  // See `ReadEffect.beforeDecisions`: only a shape reader that sees the whole resolution sets this,
  // so there is nothing to merge and nothing a clause could have contributed.
  if (read.beforeDecisions !== undefined) built['beforeDecisions'] = read.beforeDecisions;
  /*
    Omitted where the resolution is nothing but its questions — see `ReadEffect.appliesNothing`.
    `onResolve` is optional and the engine applies a decision itself, so an identity here would be a
    function that cannot be told from its absence, which this file deletes rather than keeps.
  */
  if (read.appliesNothing !== true) built['onResolve'] = read.effect;
  return {
    script: built as Partial<CardScript>,
    compiled: [...compiled, ...resolution],
    // The resolution is read, so the spell plays; the keywords nobody could build are the options
    // it is missing. `compile.ts` tags them apart, and neither is counted as compiled.
    unread: declared,
  };
}

/**
 * A spell whose resolution spends the **X it was cast for**.
 *
 * ## Why this is a spell-shape reader and not a row in the clause vocabulary
 *
 * X is chosen as the spell is cast and paid for then (CR 601.2b), so by the time the effect runs
 * `c.x` is a settled number. On anything that is **not** a spell cast for X, `c.x` is zero: the
 * stack object for a triggered or activated ability carries no X, and `automation.ts` fills the
 * context with `object.x ?? 0`.
 *
 * So a clause reader that understood bare `X` would quietly produce a **card that works and does
 * nothing** the moment the same sentence appeared in a trigger — the failure this module is most
 * careful about, because nothing is left unread for a human to notice (D362). Keeping the reading
 * on the spell path makes that impossible by construction rather than by a rule somebody has to
 * remember, which is the same argument that put `spellFlags` on the spell path only.
 *
 * ## One clause, deliberately
 *
 * Every X card in the pool whose resolution is readable is a single sentence. A second sentence
 * that *also* spends X is a real shape — Exsanguinate's "You gain life equal to the life lost this
 * way" — and reading it needs the life actually lost rather than X, so it is a different reader and
 * not a loop over this one. Refusing the multi-clause case keeps the two apart instead of half
 * reading the second card.
 *
 * Still unread, and named so the next pass has somewhere to start: the drain whose second sentence
 * reads the life actually lost rather than X (Exsanguinate), and `Each opponent loses X life` on
 * its own, which has no card in the pool to check against.
 */
function xSpellResolution(lines: readonly string[], name: string): ReadEffect | null {
  if (lines.length !== 1) return null;
  const clauses = clausesOf(lines[0]!);
  if (clauses.length !== 1) return null;
  const text = clauses[0]!.trim();
  const self = selfRef(name);

  const dealt = new RegExp(`^(?:${self}|it) deals X damage to (.+)$`, 'i').exec(text);
  if (dealt !== null) {
    const where = dealt[1]!.trim();
    /*
      The sweep, which is not a target at all: "X damage to each creature" is Savage Twister and
      "X damage to each creature with flying and each player" is Hurricane. Read through
      `sweepDestination`, the one function `damageEffect` reads a printed-number sweep with — this
      branch used to spell out the "each creature" case on its own, and a second spelling of the
      phrase is a second thing to keep in step.
    */
    const sweep = sweepDestination(where.replace(/\.\s*$/, ''));
    if (sweep !== null) return { effect: (c) => sweep(c, c.x) };
    const spec = targetSpecFrom(where, false);
    // No zero guard here, and Fireball's hand-written script has none either: `dealDamage` refuses
    // a non-positive amount, so a Fireball cast for zero deals nothing without a branch saying so.
    if (spec !== null) return { targets: [spec], effect: (c) => damageEveryTarget(c, c.x) };
  }

  /*
    The tokens, whose count is the X and whose definition comes from the shared `tokenFrom` — the
    same parser `tokenEffect` uses, so "1/1 white Warrior creature token" is read one way only.
    Secure the Wastes is the card, and the zero guard is its hand-written script's own: nothing is
    asked of `createToken` for a spell cast for nothing.
  */
  const tokens = tokenFrom(text);
  if (tokens !== null && tokens.printed.toLowerCase() === 'x') {
    return {
      effect: (c) => (c.x === 0
        ? c.state
        : createToken(c.state, c.controller, tokens.token, c.x)),
    };
  }

  if (/^(?:you )?draw X cards?$/i.test(text)) {
    /*
      `drawLater` and not `draw`, which is Mind Spring's hand-written reading: a draw the controller
      is **owed** is taken as a move they make, so a player drawing their last cards can be asked
      what to do between them. The `immediate` form is offered for the same reason the other draw
      reader offers it — a composition that puts something after the draw needs the cards in hand
      first — even though nothing in the pool follows an X draw with anything.
    */
    return {
      effect: (c) => drawLater(c.state, c.controller, c.x),
      immediate: (c) => draw(c.state, c.controller, c.x),
    };
  }

  return null;
}

/**
 * A spell's whole resolution, however many clauses it is printed in — or `null` if any of them
 * cannot be read.
 *
 * Nothing but `composeEffects` over every clause of every line, which is the point: a trigger's
 * text and a spell's resolution are the same problem, and before this they were two
 * implementations of it that could drift apart. The all-or-nothing argument and the one-target rule
 * live there.
 */
/**
 * A spell that **draws and then makes you discard**: Faithless Looting's whole card.
 *
 * ## Why this is a spell-shape reader rather than two clauses
 *
 * `clausesOf` splits on ", then ", so the sentence arrives as "Draw two cards" and "discard two
 * cards" — two clauses that compose in the right order and still produce the **wrong card**. The
 * discard is a *question*, and a question is planned before the resolution runs: composed, the
 * player would be asked which two cards to discard out of the hand they held before drawing.
 *
 * The hand-written card says so in one line — `beforeDecisions: (c) => draw(c.state, c.controller,
 * 2)` — and its docblock is explicit: "the cards it offers to discard are the ones it has not seen
 * yet". So the thing being read here is not an effect but an **order**: the draw before the
 * question, the discard after it. A clause cannot know whether a question comes after it, which is
 * exactly why this reader sees the whole resolution instead.
 *
 * ## `draw`, not `drawLater`
 *
 * The one place in this module where the immediate primitive is the right one. `drawLater` owes a
 * card instead of putting it in hand, and a card that is owed is not a card you can be asked to
 * discard — the question would be planned against a hand that has not grown yet, which is the very
 * bug this reader exists to avoid. `drawLater`'s own docblock bounds it to "a draw that is the last
 * thing the card does", and this draw is the first.
 *
 * ## The two counts are read separately
 *
 * "Draw two cards, then discard two cards" is Faithless Looting; "Draw two cards, then discard a
 * card" is Thrill of Possibility. Nothing requires them to match, so nothing here assumes it, and
 * the prompt echoes the printed count and its noun rather than being built from the number — which
 * keeps "Discard a card" singular and matches the prompt the hand-written card stores.
 */
function lootResolution(lines: readonly string[], name: string): ReadEffect | null {
  if (lines.length !== 1) return null;
  const loot = /^draw ([\w]+) cards?, then discard ([\w]+) (cards?)\.?$/i
    .exec(plain(lines[0]!).trim());
  if (loot === null) return null;
  const drawn = countFrom(loot[1]!);
  const pitched = countFrom(loot[2]!);
  if (drawn === null || pitched === null || drawn < 1 || pitched < 1) return null;
  return {
    beforeDecisions: (c) => draw(c.state, c.controller, drawn),
    decisions: [{
      who: 'controller',
      from: 'hand',
      prompt: `Discard ${loot[2]!} ${loot[3]!}`,
      min: pitched,
      max: pitched,
    }],
    effect: (c) => moveToGraveyard(c.state, chosenCards(c)),
  };
}

/**
 * A **blink**: exile a permanent you control and bring it straight back — Cloudshift.
 *
 * ## Why this is a spell-shape reader too
 *
 * The same reason as `lootResolution`, arrived at from the other direction. `clausesOf` splits on
 * ", then ", so the sentence arrives as "Exile target creature you control" and "return that card
 * to the battlefield under your control" — and the **second clause is about the first clause's
 * object**. "That card" is not a target and not the source; it is whatever the exile just moved,
 * and no clause reader can be handed that, because a clause is given a context and a target list
 * and nothing about what the clause before it did.
 *
 * Reading the first half alone would be worse than refusing both: the exile clause already has a
 * reader (D404), so a compiler that took it and dropped the rest would turn a blink into
 * **unconditional removal of your own creature** — a card that works, plays, and is the opposite of
 * what it prints. That is the strongest version of the argument for reading the whole shape or none
 * of it.
 *
 * ## `blinks` is the point of the spec
 *
 * `TargetSpec.blinks` is not a restriction and its docblock is long about why: a blink is a help or
 * a hit depending on whose permanent it lands on, because what the permanent loses by leaving is
 * what decides — a token ceases to exist (CR 111.7), counters, Auras and marked damage all go. The
 * bot cannot work that out from a candidate list, so the flag is how it is told, and a compiled
 * blink without it is a card the bot plays blind. Cloudshift's hand-written spec carries it and so
 * does this.
 *
 * ## Deliberately only "under your control"
 *
 * Flickerwisp returns the permanent **under its owner's control** and at the beginning of the next
 * end step, which is a different card in two ways: a different controller and a delayed trigger.
 * Reading it as this shape would be a blink of somebody else's creature that hands it back to you
 * immediately. So the phrase is matched exactly and the other wording is left unread (D362).
 *
 * The trigger form of the same pair — Soulherder's end step — is still hand-written. Reading it
 * needs `triggerFromLine` to gain a clause-pair path of its own, which is its own change rather
 * than a rider on this one.
 */
function blinkResolution(lines: readonly string[], name: string): ReadEffect | null {
  if (lines.length !== 1) return null;
  const blink = /^exile (another target creature you control|target creature you control), then return (?:that card|it) to the battlefield under your control\.?$/i
    .exec(plain(lines[0]!).trim());
  if (blink === null) return null;
  /*
    "Another" is dropped for the spec, because the phrase it excludes is the source and a **spell**
    is never on the battlefield to be excluded. It is kept in the regex so the sentence is matched
    as printed rather than approximately, and so the word is not silently ignored on a card where
    it would matter.
  */
  const spec = targetSpecFrom('target creature you control', true);
  if (spec === null) return null;
  return {
    targets: [{ ...spec, blinks: true }],
    effect: (c) => {
      const id = firstCardTarget(c);
      return id === null ? c.state : putOntoBattlefield(exileCard(c.state, id), id, c.controller);
    },
  };
}

/**
 * **Exile a creature and pay its controller for it** — Swords to Plowshares.
 *
 * ## The dependency, which is a reading rather than an identity
 *
 * The fourth spell-shape reader and the third kind of internal dependency a composition cannot
 * express. `lootResolution`'s was an **order** (draw before the question); `blinkResolution`'s was
 * an **identity** ("that card" is the object the clause before moved). This one is a **reading**:
 * "its power" is a characteristic of the creature the sentence before exiled, and no clause reader
 * is handed the object another clause moved. So the two sentences are read together or not at all.
 *
 * ## What is *not* true about the order, which the break runs settled
 *
 * The power is taken before `exileCard`, which is the printed order and the hand-written card's
 * own, and the comment there says "after exiling there is nothing to read". **In this engine that
 * is not so**, and deliberately reading it afterwards passes every test: `exileCard` leaves the
 * instance in place with its continuous effects still reaching it, because `pump` scopes to an
 * instance id and `relocate` keeps the id across a zone change. `pumpTeam`'s docblock has that
 * limitation written down — a creature that changes zone is a new object (CR 400.7) and should be
 * out of the set, and "it wants the object identity the engine does not yet have".
 *
 * So the order here is **fidelity, not correctness**: it is the sequence the card prints, it is what
 * the hand-written script does, and it is what will be right the day zone changes strip the effects
 * they should. It cannot be told from its absence today, and that is said rather than defended with
 * a test that cannot fail.
 *
 * No clamp on the number, for the same standard applied the other way. The hand-written card writes
 * `Math.max(0, power)`, and `gainLife` already returns the state untouched for any amount `<= 0`
 * (its first line), so the clamp is provably indistinguishable from its absence. A guard that cannot
 * fail reads as care and is noise; the behaviour it stands for — a creature at negative power pays
 * nothing — is asserted instead, and holds because of `gainLife` rather than because of the clamp.
 *
 * ## Whose life, and `removesACreature`
 *
 * "Its controller" is the seat the creature is under, which in this engine's model is
 * `instances[id].zoneSeat` for anything on the battlefield — the same field the hand-written card
 * reads. So aiming this at your own creature pays **you**, which is the printed card and part of
 * why it is a fair answer to a huge attacker.
 *
 * `removesACreature` is carried because the flag is the bot's only way to know this spell wants a
 * creature of somebody else's to point at: `CardScript.removesACreature`'s own job is to keep a
 * removal spell from being cast with nothing worth hitting. Dropping it is a card that plays itself
 * into an empty board, which is the failure #322 was about.
 */
function exileForLifeResolution(lines: readonly string[], name: string): ReadEffect | null {
  if (lines.length !== 1) return null;
  const traded = /^exile (target creature)\. its controller gains life equal to its power\.?$/i
    .exec(plain(lines[0]!).trim());
  if (traded === null) return null;
  const spec = targetSpecFrom(traded[1]!, false);
  if (spec === null) return null;
  return {
    spellFlags: { removesACreature: true },
    targets: [spec],
    effect: (c) => {
      const id = firstCardTarget(c);
      if (id === null) return c.state;
      const inst = c.state.instances[id];
      if (inst === undefined) return c.state;
      // Read before the exile, which is the printed order; see the docblock for why that cannot
      // be told from the other order today, and why it is written this way regardless.
      const power = characteristicsOf(c.state, inst).power;
      const owner = inst.zoneSeat;
      return gainLife(exileCard(c.state, id), owner, power);
    },
  };
}

function readResolution(lines: readonly string[], name: string): ReadEffect | null {
  /*
    The X shapes first, because `composeEffects` would refuse them: the clause vocabulary has no
    reading for a bare `X` on purpose, and `xSpellResolution`'s docblock is why that stays true
    outside the spell path.

    `lootResolution` next, and before `composeEffects` rather than after it: the loot sentence
    composes perfectly well and composes **wrongly**, asking which cards to discard out of the hand
    held before the draw. A fallback consulted only on failure could never correct that, so the
    shape reader has to win.
  */
  return xSpellResolution(lines, name)
    ?? lootResolution(lines, name)
    ?? blinkResolution(lines, name)
    ?? exileForLifeResolution(lines, name)
    // A spell's "itself" is a card on the stack, not a permanent: see `SubjectZone`.
    ?? composeEffects(lines.flatMap(clausesOf), name, null);
}
