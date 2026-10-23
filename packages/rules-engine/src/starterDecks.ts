/**
 * Two complete, playable decks shipped with the engine.
 *
 * They exist so a table can be started with no setup at all, and because this environment cannot
 * reach Scryfall: a deck assembled from the local card tables would be empty on a fresh database.
 * Every card here carries its real name, type line, mana cost and oracle text, so the card faces are
 * fully legible with no artwork — `imageUri` is deliberately absent on all of them.
 *
 * The pair is chosen to exercise the whole action set rather than to be balanced: auras to attach,
 * a creature that accumulates counters, a spell that steals a permanent, a commander that makes
 * tokens, and removal that exiles rather than destroys.
 *
 * Deck legality is not checked anywhere, by design — see the header of `cards.ts`. A 60-card deck
 * loaded into a Commander table gets a command zone and 40 life and plays fine; whether that is a
 * legal Commander deck is the players' business, exactly as it is with physical cards.
 */
import type { CardDef, DeckSpec } from './cards.js';

const land = (name: string, symbol: string, type: string): CardDef => ({
  name,
  typeLine: `Basic Land — ${type}`,
  manaCost: '',
  cmc: 0,
  oracleText: `{T}: Add {${symbol}}.`,
  colors: [],
});

const MOUNTAIN = land('Mountain', 'R', 'Mountain');
const FOREST = land('Forest', 'G', 'Forest');
const PLAINS = land('Plains', 'W', 'Plains');

// ── Mono-red aggro ───────────────────────────────────────────────────────────────────────────────

const MONASTERY_SWIFTSPEAR: CardDef = {
  name: 'Monastery Swiftspear',
  typeLine: 'Creature — Human Monk',
  manaCost: '{R}',
  cmc: 1,
  power: '1',
  toughness: '2',
  oracleText: 'Haste\nProwess (Whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn.)',
  colors: ['R'],
};

const RAGING_GOBLIN: CardDef = {
  name: 'Raging Goblin',
  typeLine: 'Creature — Goblin Berserker',
  manaCost: '{R}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'Haste',
  colors: ['R'],
};

const FIREBRAND_ARCHER: CardDef = {
  name: 'Firebrand Archer',
  typeLine: 'Creature — Human Archer',
  manaCost: '{1}{R}',
  cmc: 2,
  power: '1',
  toughness: '2',
  oracleText: 'Whenever you cast a noncreature spell, Firebrand Archer deals 1 damage to each opponent.',
  colors: ['R'],
};

const HILL_GIANT: CardDef = {
  name: 'Hill Giant',
  typeLine: 'Creature — Giant',
  manaCost: '{3}{R}',
  cmc: 4,
  power: '3',
  toughness: '3',
  oracleText: '',
  colors: ['R'],
};

const SHIVAN_DRAGON: CardDef = {
  name: 'Shivan Dragon',
  typeLine: 'Creature — Dragon',
  manaCost: '{4}{R}{R}',
  cmc: 6,
  power: '5',
  toughness: '5',
  oracleText: 'Flying\n{R}: Shivan Dragon gets +1/+0 until end of turn.',
  colors: ['R'],
};

const LIGHTNING_BOLT: CardDef = {
  name: 'Lightning Bolt',
  typeLine: 'Instant',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Lightning Bolt deals 3 damage to any target.',
  colors: ['R'],
};

const SHOCK: CardDef = {
  name: 'Shock',
  typeLine: 'Instant',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Shock deals 2 damage to any target.',
  colors: ['R'],
};

const LAVA_SPIKE: CardDef = {
  name: 'Lava Spike',
  typeLine: 'Sorcery — Arcane',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Lava Spike deals 3 damage to target player or planeswalker.',
  colors: ['R'],
};

const FLAME_SLASH: CardDef = {
  name: 'Flame Slash',
  typeLine: 'Sorcery',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Flame Slash deals 4 damage to target creature.',
  colors: ['R'],
};

const ACT_OF_TREASON: CardDef = {
  name: 'Act of Treason',
  typeLine: 'Sorcery',
  manaCost: '{2}{R}',
  cmc: 3,
  oracleText: 'Gain control of target creature until end of turn. Untap it. It gains haste until end of turn.',
  colors: ['R'],
};

const KRENKO_MOB_BOSS: CardDef = {
  name: 'Krenko, Mob Boss',
  typeLine: 'Legendary Creature — Goblin Warrior',
  manaCost: '{2}{R}{R}',
  cmc: 4,
  power: '3',
  toughness: '3',
  oracleText: '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.',
  colors: ['R'],
};

// ── Green-white midrange ─────────────────────────────────────────────────────────────────────────

const LLANOWAR_ELVES: CardDef = {
  name: 'Llanowar Elves',
  typeLine: 'Creature — Elf Druid',
  manaCost: '{G}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: '{T}: Add {G}.',
  colors: ['G'],
};

const GRIZZLY_BEARS: CardDef = {
  name: 'Grizzly Bears',
  typeLine: 'Creature — Bear',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: '',
  colors: ['G'],
};

const CENTAUR_COURSER: CardDef = {
  name: 'Centaur Courser',
  typeLine: 'Creature — Centaur Warrior',
  manaCost: '{2}{G}',
  cmc: 3,
  power: '3',
  toughness: '3',
  oracleText: '',
  colors: ['G'],
};

const SERRA_ANGEL: CardDef = {
  name: 'Serra Angel',
  typeLine: 'Creature — Angel',
  manaCost: '{3}{W}{W}',
  cmc: 5,
  power: '4',
  toughness: '4',
  oracleText: 'Flying, vigilance',
  colors: ['W'],
};

const AJANIS_PRIDEMATE: CardDef = {
  name: "Ajani's Pridemate",
  typeLine: 'Creature — Cat Soldier',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: "Whenever you gain life, put a +1/+1 counter on Ajani's Pridemate.",
  colors: ['W'],
};

const GIANT_GROWTH: CardDef = {
  name: 'Giant Growth',
  typeLine: 'Instant',
  manaCost: '{G}',
  cmc: 1,
  oracleText: 'Target creature gets +3/+3 until end of turn.',
  colors: ['G'],
};

const PACIFISM: CardDef = {
  name: 'Pacifism',
  typeLine: 'Enchantment — Aura',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText: "Enchant creature\nEnchanted creature can't attack or block.",
  colors: ['W'],
};

const SWORDS_TO_PLOWSHARES: CardDef = {
  name: 'Swords to Plowshares',
  typeLine: 'Instant',
  manaCost: '{W}',
  cmc: 1,
  oracleText: 'Exile target creature. Its controller gains life equal to its power.',
  colors: ['W'],
};

const HARMONIZE: CardDef = {
  name: 'Harmonize',
  typeLine: 'Sorcery',
  manaCost: '{3}{G}{G}',
  cmc: 5,
  oracleText: 'Draw three cards.',
  colors: ['G'],
};

const OVERRUN: CardDef = {
  name: 'Overrun',
  typeLine: 'Sorcery',
  manaCost: '{2}{G}{G}{G}',
  cmc: 5,
  oracleText: 'Creatures you control get +3/+3 and gain trample until end of turn.',
  colors: ['G'],
};

const SIGARDA_HOST_OF_HERONS: CardDef = {
  name: 'Sigarda, Host of Herons',
  typeLine: 'Legendary Creature — Angel',
  manaCost: '{3}{G}{W}',
  cmc: 5,
  power: '5',
  toughness: '5',
  oracleText: "Flying, hexproof\nSpells and abilities your opponents control can't cause you to sacrifice permanents.",
  colors: ['G', 'W'],
};

// ── The decks ────────────────────────────────────────────────────────────────────────────────────

export const EMBER_RUSH: DeckSpec = {
  id: 'ember-rush',
  name: 'Ember Rush',
  description: 'Mono-red aggro. Cheap hasty creatures, burn to the face, and a dragon to finish.',
  commander: KRENKO_MOB_BOSS,
  cards: [
    { card: MOUNTAIN, count: 22 },
    { card: MONASTERY_SWIFTSPEAR, count: 4 },
    { card: RAGING_GOBLIN, count: 4 },
    { card: FIREBRAND_ARCHER, count: 4 },
    { card: HILL_GIANT, count: 4 },
    { card: SHIVAN_DRAGON, count: 4 },
    { card: LIGHTNING_BOLT, count: 4 },
    { card: SHOCK, count: 4 },
    { card: LAVA_SPIKE, count: 4 },
    { card: FLAME_SLASH, count: 4 },
    { card: ACT_OF_TREASON, count: 2 },
  ],
};

export const VERDANT_GUARD: DeckSpec = {
  id: 'verdant-guard',
  name: 'Verdant Guard',
  description: 'Green-white midrange. Bigger creatures, auras, exile removal and a fliers finish.',
  commander: SIGARDA_HOST_OF_HERONS,
  cards: [
    { card: FOREST, count: 12 },
    { card: PLAINS, count: 10 },
    { card: LLANOWAR_ELVES, count: 4 },
    { card: GRIZZLY_BEARS, count: 4 },
    { card: CENTAUR_COURSER, count: 4 },
    { card: AJANIS_PRIDEMATE, count: 4 },
    { card: SERRA_ANGEL, count: 4 },
    { card: GIANT_GROWTH, count: 4 },
    { card: PACIFISM, count: 4 },
    { card: SWORDS_TO_PLOWSHARES, count: 4 },
    { card: HARMONIZE, count: 4 },
    { card: OVERRUN, count: 2 },
  ],
};

export const STARTER_DECKS: Readonly<Record<string, DeckSpec>> = Object.freeze({
  [EMBER_RUSH.id]: EMBER_RUSH,
  [VERDANT_GUARD.id]: VERDANT_GUARD,
});

export const STARTER_DECK_IDS: readonly string[] = Object.freeze(Object.keys(STARTER_DECKS));

/** Tokens the table offers by name, so making a squad does not mean typing a card out. */
export const COMMON_TOKENS: readonly CardDef[] = Object.freeze([
  { name: 'Goblin', typeLine: 'Token Creature — Goblin', manaCost: '', cmc: 0, power: '1', toughness: '1', oracleText: '', colors: ['R'] },
  { name: 'Soldier', typeLine: 'Token Creature — Soldier', manaCost: '', cmc: 0, power: '1', toughness: '1', oracleText: '', colors: ['W'] },
  { name: 'Beast', typeLine: 'Token Creature — Beast', manaCost: '', cmc: 0, power: '3', toughness: '3', oracleText: '', colors: ['G'] },
  { name: 'Angel', typeLine: 'Token Creature — Angel', manaCost: '', cmc: 0, power: '4', toughness: '4', oracleText: 'Flying', colors: ['W'] },
  { name: 'Treasure', typeLine: 'Token Artifact — Treasure', manaCost: '', cmc: 0, oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.', colors: [] },
  { name: 'Clue', typeLine: 'Token Artifact — Clue', manaCost: '', cmc: 0, oracleText: '{2}, Sacrifice this artifact: Draw a card.', colors: [] },
]);
