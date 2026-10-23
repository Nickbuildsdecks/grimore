/**
 * Card scripts: the registry of what each card actually does.
 *
 * Every card in both starter decks is here. Adding another is a few lines, and anything not here
 * still functions as cardboard — castable, a permanent if it is one, with its printed keywords read
 * from its text — it simply has no automated effect, and the log says so.
 *
 * What is **not** scriptable with this vocabulary, stated so nobody discovers it by surprise:
 * anything needing a decision during resolution (searching a library, "choose one", an opponent
 * discarding), copy effects, characteristic-setting effects, and replacement effects. Those need a
 * way to interrupt resolution and ask a player, which the engine does not have. A card like that
 * should be left unscripted and resolved by hand rather than approximated.
 */
import { characteristicsOf, hasSubtype, hasType, parseTypeLine } from './characteristics.js';
import type { CardDef } from './cards.js';
import {
  addCounters, bounceToHand, cardTargets, counterSpell, createToken, dealDamage, destroy,
  discardAtRandom, draw, exileCard, firstCardTarget, firstPlayerTarget, gainControl, gainLife,
  loseLife, mill, opponentsOf, pump, pumpTeam, putOntoBattlefield, tap, type EffectContext,
} from './effects.js';
import type { CardScript, TargetSpec } from './scriptTypes.js';
import type { GameState, SeatIndex } from './types.js';
import type { Target } from './turnTypes.js';

// ── Target specs used by more than one card ──────────────────────────────────────────────────────

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
  // Izoni's second ability — sacrificing creatures to drain — is not automated: paying a cost by
  // sacrificing something the player chooses is a decision the engine cannot ask for yet. It is
  // printed on the card face, and "Move by hand" is there for it.
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

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

const ALL: readonly CardScript[] = [
  basicLand('Mountain', 'R'),
  basicLand('Forest', 'G'),
  basicLand('Plains', 'W'),
  basicLand('Island', 'U'),
  basicLand('Swamp', 'B'),
  MONASTERY_SWIFTSPEAR, RAGING_GOBLIN, FIREBRAND_ARCHER, SHIVAN_DRAGON,
  LIGHTNING_BOLT, SHOCK, LAVA_SPIKE, FLAME_SLASH, ACT_OF_TREASON, KRENKO, FLAMETONGUE_KAVU,
  LLANOWAR_ELVES, AJANIS_PRIDEMATE, SERRA_ANGEL, GIANT_GROWTH, PACIFISM,
  SWORDS_TO_PLOWSHARES, HARMONIZE, OVERRUN, SIGARDA,
  COUNTERSPELL, NEGATE, DOOM_BLADE, DIVINATION, SIGN_IN_BLOOD, TOME_SCOUR,
  RAVENOUS_RATS, CHILD_OF_NIGHT, WIND_DRAKE, VAMPIRE_NIGHTHAWK, AIR_ELEMENTAL, TALRAND, MAN_O_WAR,
  GRAVEDIGGER, RAISE_DEAD, ZOMBIFY, THORNWEALD_ARCHER, WALL_OF_BLOSSOMS, LOTLETH_GIANT, IZONI,
];

export const CARD_SCRIPTS: ReadonlyMap<string, CardScript> = new Map(
  ALL.map((script) => [script.name.trim().toLowerCase(), script]),
);

/** The script for a card, or undefined when it is not automated. */
export const scriptFor = (name: string | undefined): CardScript | undefined =>
  name === undefined ? undefined : CARD_SCRIPTS.get(name.trim().toLowerCase());

export const scriptedCardNames = (): string[] => [...CARD_SCRIPTS.values()].map((s) => s.name).sort();

export { cardTargets, destroy };
