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
  addCounters, battlefield, bounceToHand, cardTargets, chosenCard, chosenCards, counterSpell, createToken,
  dealDamage, destroy, discardAtRandom, draw, exileCard, firstCardTarget, firstPlayerTarget,
  gainControl, gainLife, loseLife, mill, moveToGraveyard, moveToHand, opponentsOf, pump, pumpTeam,
  putOntoBattlefield, tap, equipTo, creaturesControlledBy, pumpAll, regenerate,
  exileUntilLeaves, returnExiledBy,
  type EffectContext, type PumpOptions,
} from './effects.js';
import type { CardScript, DecisionSpec, TargetSpec } from './scriptTypes.js';
import type { GameState, SeatIndex } from './types.js';
import type { Target } from './turnTypes.js';

// ── Target specs used by more than one card ──────────────────────────────────────────────────────

/** The five colours, for a card that offers one of each. */
const COLOURS = ['W', 'U', 'B', 'R', 'G'] as const;

const ANY_TARGET: TargetSpec = { kind: 'any', description: 'any target' };
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
      effect: (c) => draw(c.state, c.controller, 1),
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
          (state, seat) => dealDamage(state, { kind: 'player', seat }, 1, { controller: c.controller }),
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
    return seat === null ? c.state : dealDamage(c.state, { kind: 'player', seat }, 3, { controller: c.controller });
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

const scry = (count: number): DecisionSpec => ({
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
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : dealDamage(c.state, { kind: 'card', id }, 4, { controller: c.controller });
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
        return id === null ? c.state : dealDamage(c.state, { kind: 'card', id }, 4, { controller: c.controller });
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
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : pump(c.state, [id], c.source, c.controller, { power: 3, toughness: 3 });
  },
};

const PACIFISM: CardScript = {
  name: 'Pacifism',
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
  onResolve: (c) => draw(c.state, c.controller, 3),
};

const OVERRUN: CardScript = {
  name: 'Overrun',
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
  targets: [TARGET_CREATURE],
  onResolve: (c) => {
    const id = firstCardTarget(c);
    return id === null ? c.state : destroy(c.state, id);
  },
};

const DIVINATION: CardScript = {
  name: 'Divination',
  onResolve: (c) => draw(c.state, c.controller, 2),
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
  onResolve: (c) => draw(c.state, c.controller, c.x),
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
  onResolve: (c) => draw(c.state, c.controller, 1),
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
      state = dealDamage(state, { kind: 'card', id }, c.x, { controller: c.controller });
    }
    for (const seat of state.seats) {
      if (seat.eliminated) continue;
      state = dealDamage(state, { kind: 'player', seat: seat.index }, c.x, { controller: c.controller });
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
      effect: (c) => draw(c.state, c.controller, 1),
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
      effect: (c) => draw(c.state, c.controller, 1),
    },
  ],
};

const INSPIRED_CHARGE: CardScript = {
  name: 'Inspired Charge',
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

export const KNIGHT_TOKEN: CardDef = {
  name: 'Knight', typeLine: 'Token Creature — Knight', manaCost: '', cmc: 0,
  power: '2', toughness: '2', oracleText: 'Vigilance', colors: ['W'],
};

export const BEAST_TOKEN: CardDef = {
  name: 'Beast', typeLine: 'Token Creature — Beast', manaCost: '', cmc: 0,
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
        (state, seat) => dealDamage(state, { kind: 'player', seat }, 1, { controller: c.controller }),
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
        (state, seat) => dealDamage(state, { kind: 'player', seat }, 1, { controller: c.controller }),
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
const searchYourLibrary = (prompt: string, filter?: DecisionSpec['filter']): DecisionSpec => ({
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

// ── Helpers the scripts above share ──────────────────────────────────────────────────────────────

/** "deals N damage to any target" — the target may be a creature or a player. */
function damageFirstTarget(c: EffectContext, amount: number): GameState {
  const target = c.targets[0];
  if (target === undefined) return c.state;
  return dealDamage(c.state, target, amount, { controller: c.controller });
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
    effect: (c) => draw(c.state, c.controller, 1),
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
      effect: (c) => draw(c.state, c.controller, 1),
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

/** Journey to Nowhere: the same deal for one less mana, with no body attached. */
const JOURNEY_TO_NOWHERE: CardScript = exileUntilItLeaves('Journey to Nowhere', TARGET_CREATURE);

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
      state = dealDamage(state, { kind: 'card', id }, amount, { controller: c.controller });
    }
    for (const seat of state.seats) {
      if (seat.eliminated) continue;
      state = dealDamage(state, { kind: 'player', seat: seat.index }, amount, { controller: c.controller });
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
      state = dealDamage(state, { kind: 'player', seat: owner }, power, { controller: c.controller });
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
  onResolve: (c) => draw(c.state, c.controller, 2),
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
        return dealDamage(c.state, hit, 1, { controller: c.controller });
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
const BALL_LIGHTNING: CardScript = {
  name: 'Ball Lightning',
  triggers: [
    {
      on: { kind: 'step', step: 'end', of: 'any' },
      description: 'sacrifice Ball Lightning',
      effect: (c) => moveToGraveyard(c.state, [c.source]),
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

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

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
  SOL_RING, MIND_STONE, BIRDS_OF_PARADISE,
  DAY_OF_JUDGMENT, ESSENCE_SCATTER, UNSUMMON, ICY_MANIPULATOR, TORMODS_CRYPT,
  AMBUSH_VIPER, ELVISH_VISIONARY, READ_THE_BONES,
  HELLRIDER, BALL_LIGHTNING, CLOUDSHIFT,
  guildgate('Rakdos Guildgate', 'B', 'R'),
];

export const CARD_SCRIPTS: ReadonlyMap<string, CardScript> = new Map(
  ALL.map((script) => [script.name.trim().toLowerCase(), script]),
);

/** The script for a card, or undefined when it is not automated. */
export const scriptFor = (name: string | undefined): CardScript | undefined =>
  name === undefined ? undefined : CARD_SCRIPTS.get(name.trim().toLowerCase());

export const scriptedCardNames = (): string[] => [...CARD_SCRIPTS.values()].map((s) => s.name).sort();

export { cardTargets, destroy };
