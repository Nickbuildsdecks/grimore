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
import { characteristicsOf, hasSubtype, hasType, parseTypeLine } from './characteristics.js';
import { zoneKey, type CardDef } from './cards.js';
import { listAt } from './cardActions.js';
import {
  addCounters, addToPool, battlefield, bounceToHand, cardTargets, chosenCard, chosenCards, counterSpell, createToken,
  dealDamage, destroy, discardAtRandom, draw, drawLater, exileCard, firstCardTarget,
  firstPlayerTarget,
  chosenOption, firstAbilityTarget, dividedAmong, copyAbilityOnStack, copySpellOnStack,
  allowExtraLand, proliferate,
  gainControl, gainLife, goad, loseLife, mill, moveToGraveyard, moveToHand, opponentsOf, pump,
  pumpTeam,
  putOntoBattlefield, tap, equipTo, creaturesControlledBy, pumpAll, regenerate,
  exileUntilLeaves, returnExiledBy, preventCombatDamage, preventDamage, copyAsToken,
  becomeMonarch, freezeNextUntap, removeFromCombat, scheduleDelayed, EVOKED, UNEARTHED, RENOWNED,
  becomeCopyOf, wardAsks, staticEffect, manaValueOnStack, cascadeFrom,
  addEnergy, energyOf, spendEnergy, bottomPile, reboundOffer,
  type EffectContext, type PumpOptions,
} from './effects.js';
import type {
  AbilityDef, CardScript, CardsDecisionSpec, CountersDecisionSpec, TargetDecisionSpec,
  TargetSpec, TriggerDef,
} from './scriptTypes.js';
import type { Color } from './mana.js';
import type { GameState, SeatIndex } from './types.js';
import { legalTargets, retarget } from './targeting.js';
import { targetKey, type Target } from './turnTypes.js';

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
/** The same spec on a card that *helps* what it points at. See `TargetSpec.friendly`. */
const ANY_TARGET_HELPED: TargetSpec = { kind: 'any', description: 'any target', friendly: true };
const TARGET_CREATURE: TargetSpec = { kind: 'creature', description: 'target creature' };
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

const LAVA_SPIKE: CardScript = {
  name: 'Lava Spike',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return seat === null ? c.state : dealDamage(c.state, { kind: 'player', seat }, 3, { controller: c.controller, source: c.source });
  },
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
const equipment = (name: string, cost: string, bonus: PumpOptions, text: string): CardScript => ({
  name,
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

const scry = (count: number): CardsDecisionSpec => ({
  who: 'controller',
  from: 'library-top',
  look: count,
  prompt: `Scry ${count} — put any of these on the bottom`,
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
        const goblins = goblinCount(c.state, c.controller);
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
  targets: [TARGET_CREATURE],
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
      targets: [{
        kind: 'permanent',
        description: 'target land',
        count: 2,
        filter: (state, candidate) => candidate.kind === 'card'
          && hasType(parseTypeLine(state.cardDefs[state.instances[candidate.id]?.defKey ?? '']?.typeLine), 'land'),
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
    target: { kind: 'creature', description: 'enchant creature' },
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
        targets: [{
          kind: 'permanent',
          description: 'target enchantment',
          filter: (state, candidate) => candidate.kind === 'card'
            && hasType(parseTypeLine(state.cardDefs[state.instances[candidate.id]?.defKey ?? '']?.typeLine), 'enchantment'),
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

// ── Modal spells: "Choose one —" ─────────────────────────────────────────────────────────────────

const SELESNYA_CHARM: CardScript = {
  name: 'Selesnya Charm',
  modal: {
    modes: [
      {
        description: 'Target creature gets +2/+2 and gains trample until end of turn',
        // Only this mode of the three wears off; the other two exile and make a token.
        expiresAtEndOfTurn: true,
        targets: [TARGET_CREATURE],
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
        targets: [{
          kind: 'spell', description: 'target creature spell',
          filter: (state, candidate) => candidate.kind === 'card'
            && state.instances[candidate.id] !== undefined
            && characteristicsOf(state, state.instances[candidate.id]!).isCreature,
        }],
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
        targets: [{
          kind: 'graveyard-land', description: 'target land card in your graveyard',
          filter: (state, candidate, controller) =>
            candidate.kind === 'card' && state.instances[candidate.id]?.zoneSeat === controller,
        }],
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
  prompt: string, filter?: CardsDecisionSpec['filter'],
): CardsDecisionSpec => ({
  who: 'controller', from: 'library', prompt, min: 0, max: 1,
  ...(filter === undefined ? {} : { filter }),
});

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
      description: '{0}: Sacrifice another creature. Scry 1.',
      decisions: [scry(1)],
      effect: (c) => c.state,
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
const GOBLIN_WARDRIVER: CardScript = {
  name: 'Goblin Wardriver',
  triggers: [{
    on: { kind: 'attacks' },
    description: 'each other attacking creature gets +1/+0 until end of turn',
    effect: (c) => {
      const others = c.state.combat.attacks
        .map((attack) => attack.attacker)
        .filter((id) => id !== c.source);
      return pump(c.state, others, c.source, c.controller, { power: 1 });
    },
  }],
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
const COMPELLING_ARGUMENT: CardScript = {
  name: 'Compelling Argument',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return seat === null ? c.state : mill(c.state, seat, 3);
  },
  abilities: [{
    cost: { mana: '{U}', discardSelf: true },
    description: '{U}, Discard this card: Draw a card.',
    effect: (c) => drawLater(c.state, c.controller, 1),
  }],
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

/** "Prevent the next N damage that would be dealt to any target" — a creature or a player. */
function shieldFirstTarget(c: EffectContext, amount: number): GameState {
  const target = c.targets[0];
  if (target === undefined) return c.state;
  return preventDamage(c.state, c.source, c.controller, target, amount);
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

function goblinCount(state: GameState, seat: SeatIndex): number {
  let n = 0;
  for (const id of state.zones[`${seat}:battlefield`] ?? []) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (ch.isCreature && hasSubtype(ch.typeLine, 'goblin')) n += 1;
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
  targets: [{
    kind: 'spell',
    description: 'target creature spell',
    filter: (state, candidate) => {
      if (candidate.kind !== 'card') return false;
      const inst = state.instances[candidate.id];
      return inst !== undefined && characteristicsOf(state, inst).isCreature;
    },
  }],
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
  targets: [{
    kind: 'permanent',
    description: 'target permanent',
    filter: (state, candidate) => {
      if (candidate.kind !== 'card') return false;
      return state.instances[candidate.id]?.zone === 'battlefield';
    },
  }],
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
 * `kind: 'permanent'` with a filter, which the targeting layer has expressed since Banishing Light:
 * the type line is read from `characteristicsOf` rather than from the printed line, so a creature
 * that is *also* an artifact is a legal target and an animated land is not.
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
      const types = parseTypeLine(state.cardDefs[inst.defKey]?.typeLine);
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
    filter: creatureYouControl,
  }],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null
      ? c.state
      : pump(c.state, [id], c.source, c.controller, { power, toughness, keywords: ['hexproof'] });
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
        const types = parseTypeLine(state.cardDefs[inst.defKey]?.typeLine);
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
  triggers: [
    {
      on: { kind: 'step', step: 'end', of: 'any' },
      description: 'sacrifice Ball Lightning',
      effect: sacrificeSelf,
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
    target: { kind: 'creature', description: 'enchant creature' },
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
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : pump(c.state, [id], c.source, c.controller, { power: 4, toughness: 4 });
  },
};

const HEALERS_HAWK: CardScript = { name: "Healer's Hawk", keywords: ['flying', 'lifelink'] };

const LAVA_AXE: CardScript = {
  name: 'Lava Axe',
  targets: [TARGET_PLAYER],
  onResolve: (c) => {
    const seat = firstPlayerTarget(c);
    return seat === null ? c.state : dealDamage(c.state, { kind: 'player', seat }, 5, { controller: c.controller, source: c.source });
  },
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
    filter: (state, candidate) => {
      if (candidate.kind !== 'card') return false;
      return state.combat.attacks.some(
        (a) => a.attacker === candidate.id || a.blockers.includes(candidate.id),
      );
    },
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
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    if (id === null) return draw(c.state, c.controller, 1);
    // Haste first so the draw happens whatever the target did, then the card: "draw a card" is not
    // conditional on the creature still being there.
    const hasted = pump(c.state, [id], c.source, c.controller, {
      keywords: ['haste'], setColors: ['R'],
    });
    return draw(hasted, c.controller, 1);
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
const PALADIN_EN_VEC: CardScript = {
  name: 'Paladin en-Vec',
  statics: [{ scope: 'self', effect: { protectionFrom: ['B', 'R'] } }],
};

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
const GUARDIANS_OF_AKRASA: CardScript = {
  name: 'Guardians of Akrasa',
  triggers: [{
    on: { kind: 'attacks', who: 'any', of: 'you', alone: true },
    description: 'Exalted: the attacking creature gets +1/+1 until end of turn.',
    effect: (c) => (c.subject === undefined
      ? c.state
      : pump(c.state, [c.subject], c.source, c.controller, { power: 1, toughness: 1 })),
  }],
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
const CLOUDFIN_RAPTOR: CardScript = {
  name: 'Cloudfin Raptor',
  triggers: [{
    on: { kind: 'etb', who: 'another', of: 'you', what: 'creature' },
    description: 'Evolve: put a +1/+1 counter on Cloudfin Raptor.',
    condition: (c) => evolvesInto(c.state, c.source, c.subject),
    effect: (c) => addCounters(c.state, c.source, '+1/+1', 1),
  }],
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
  const source = state.instances[object.source];
  const script = scriptFor(state.cardDefs[source?.defKey ?? '']?.name);
  if (script === undefined || object.abilityIndex === undefined) return null;
  const def = object.kind === 'activated'
    ? script.abilities?.[object.abilityIndex]
    : script.triggers?.[object.abilityIndex];
  const specs = def?.targets ?? [];
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
 * `raiseWard`, the ability goes on the stack above the spell and resolves first, and the question
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
  The two ward cards, and the one thing about them that is not scripted.

  Both are printed "Magecraft — Whenever you cast **or copy** an instant or sorcery spell", and the
  copy half is not here: the engine's cast event fires on casting, and nothing in this pool copies
  an instant or a sorcery, so a `spell-cast` trigger is the whole of what these cards do at this
  table. Said out loud rather than silently approximated, because the day something does copy one
  this is the line that is wrong.
*/
const DRAGONSGUARD_ELITE: CardScript = {
  name: 'Dragonsguard Elite',
  triggers: [
    ward('Dragonsguard Elite', '{1}'),
    {
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
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
      on: { kind: 'spell-cast', by: 'you', spell: 'instant-or-sorcery' },
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

/** The two specs Ajani wants: a creature being *helped*, which is advice the bot needs. */
const CREATURE_HELPED: TargetSpec = {
  kind: 'creature', description: 'target creature', friendly: true,
};

const AJANI_CALLER_OF_THE_PRIDE: CardScript = {
  name: 'Ajani, Caller of the Pride',
  abilities: [
    {
      cost: { loyalty: 1 },
      description: '+1: Put a +1/+1 counter on target creature.',
      targets: [CREATURE_HELPED],
      effect: (c) => {
        const id = firstCardTarget(c);
        return id === null ? c.state : addCounters(c.state, id, '+1/+1', 1);
      },
    },
    {
      cost: { loyalty: -3 },
      description: '−3: Target creature gains flying and double strike until end of turn.',
      targets: [CREATURE_HELPED],
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

const RIVER_BOA: CardScript = {
  name: 'River Boa',
  statics: [{ scope: 'self', effect: { landwalk: ['Island'] } }],
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
      // "Whenever a land you control enters" — `another`, because she is not a land and her own
      // arrival is not one; `of: 'you'`, because an opponent's land is not yours.
      on: { kind: 'etb', who: 'another', of: 'you', what: 'land' },
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
  targets: [TARGET_CREATURE],
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
const BASILICA_GUARDS: CardScript = {
  name: 'Basilica Guards',
  statics: [{ scope: 'self', effect: { cantAttack: true } }],
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
      targets: [TARGET_CREATURE],
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
          Scheduled before the exile, and it matters: once the card is in exile `nameOfCard` still
          reads it, but the *owner* the return needs is read when the delayed ability resolves, off
          an instance that is still there. Exile is a zone the engine keeps cards in, so both are
          safe — the order here is only so the log reads in the order a player saw it.
        */
        const scheduled = scheduleDelayed(c.state, {
          source: c.source,
          controller: c.controller,
          abilityIndex: delayedIndexOf(FLICKERWISP),
          step: 'end',
          of: 'any',
          subject: id,
          description: `return ${name} to the battlefield`,
        });
        return exileCard(scheduled, id);
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
const PHYREXIAN_CRUSADER: CardScript = {
  name: 'Phyrexian Crusader',
  keywords: ['first strike', 'infect'],
  statics: [{ scope: 'self', effect: { protectionFrom: ['R', 'W'] } }],
};

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
  targets: [{ kind: 'creature', description: 'target creature' }],
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
  targets: [TARGET_CREATURE],
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
      return hasType(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), 'enchantment');
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
  targets: [TARGET_CREATURE],
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

/** How many artifacts a seat controls, off the printed type line (see `conditionMet`). */
const artifactsControlled = (state: GameState, seat: SeatIndex): number => {
  let count = 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    if (hasType(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), 'artifact')) count += 1;
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
  Islandwalk on a token, which needs a script rather than a line of oracle text.

  Flying on the Thopter token is read straight off `oracleText` by `printedKeywords`, and landwalk
  cannot be: it is a land *type* plus a rule, so it is declared the way River Boa declares it — a
  static scoped to the card itself, which `canBlock` reads off the attacker. The token finds this
  script the same way the Pest does, by its name.
*/
const SQUID: CardScript = {
  name: 'Squid',
  statics: [{ scope: 'self', effect: { landwalk: ['Island'] } }],
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
      description: 'that player loses 1 life',
      effect: (c) => loseLife(c.state, c.actor ?? c.controller, 1),
    },
  ],
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
  BLOOD_ARTIST, ZULAPORT_CUTTHROAT, SOUL_WARDEN, IMPACT_TREMORS,
  FIREBALL, SECURE_THE_WASTES, MIND_SPRING, EXSANGUINATE, HURRICANE,
  MAGMA_JET, PREORDAIN, OMENSPEAKER,
  DRUDGE_SKELETONS, GOLGARI_CHARM, ENDLESS_ONE,
  LEONIN_SKYHUNTER, RAISE_THE_ALARM, ANGELIC_GIFT, INSPIRED_CHARGE, BALAN,
  JACE_BELEREN, GARRUK_WILDSPEAKER,
  guildgate('Boros Guildgate', 'R', 'W'),
  guildgate('Izzet Guildgate', 'U', 'R'),
  equipment('Bonesplitter', '{1}', { power: 2 }, 'equipped creature gets +2/+0'),
  equipment('Loxodon Warhammer', '{3}', { power: 3, keywords: ['trample', 'lifelink'] },
    'equipped creature gets +3/+0 and has trample and lifelink'),
  equipment('Basilisk Collar', '{2}', { keywords: ['deathtouch', 'lifelink'] },
    'equipped creature has deathtouch and lifelink'),
  cyclingLand('Barren Moor', 'B'),
  cyclingLand('Forgotten Cave', 'R'),
  cyclingLand('Lonely Sandbar', 'U'),
  cyclingLand('Secluded Steppe', 'W'),
  cyclingLand('Tranquil Thicket', 'G'),
  BURST_LIGHTNING, BREATH_OF_DARIGAAZ, AGONIZING_DEMISE, BONE_SPLINTERS, VILLAGE_RITES, JUDITH,
  BANISHER_PRIEST, JOURNEY_TO_NOWHERE, BANISHING_LIGHT,
  NATURALIZE, DISENCHANT, BLOSSOMING_DEFENSE, DIVE_DOWN, JUGGERNAUT, DISRUPT_DECORUM, KALITAS,
  PALADIN_EN_VEC,
  SOL_RING, MIND_STONE, BIRDS_OF_PARADISE,
  DAY_OF_JUDGMENT, ESSENCE_SCATTER, UNSUMMON, ICY_MANIPULATOR, TORMODS_CRYPT,
  AMBUSH_VIPER, ELVISH_VISIONARY, READ_THE_BONES,
  HELLRIDER, BALL_LIGHTNING, CLOUDSHIFT,
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
  GLISTENER_ELF, PLAGUE_STINGER, ICHORCLAW_MYR, BLIGHT_MAMBA, CYSTBEARER, PHYREXIAN_CRUSADER,
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
];

export const CARD_SCRIPTS: ReadonlyMap<string, CardScript> = new Map(
  ALL.map((script) => [script.name.trim().toLowerCase(), script]),
);

/** The script for a card, or undefined when it is not automated. */
export const scriptFor = (name: string | undefined): CardScript | undefined =>
  name === undefined ? undefined : CARD_SCRIPTS.get(name.trim().toLowerCase());

export const scriptedCardNames = (): string[] => [...CARD_SCRIPTS.values()].map((s) => s.name).sort();

export { cardTargets, destroy };
