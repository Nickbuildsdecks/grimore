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

const GOBLIN_ARSONIST: CardDef = {
  name: 'Goblin Arsonist',
  typeLine: 'Creature — Goblin Shaman',
  manaCost: '{R}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'When Goblin Arsonist dies, it deals 1 damage to any target.',
  colors: ['R'],
};

const THERMO_ALCHEMIST: CardDef = {
  name: 'Thermo-Alchemist',
  typeLine: 'Creature — Human Shaman',
  manaCost: '{2}{R}',
  cmc: 3,
  power: '0',
  toughness: '3',
  oracleText: 'Defender\n{T}: Thermo-Alchemist deals 1 damage to each opponent.\nWhenever you cast an instant or sorcery spell, untap Thermo-Alchemist.',
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

const FAITHLESS_LOOTING: CardDef = {
  name: 'Faithless Looting',
  typeLine: 'Sorcery',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Draw two cards, then discard two cards.',
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

const FLAMETONGUE_KAVU: CardDef = {
  name: 'Flametongue Kavu',
  typeLine: 'Creature — Kavu',
  manaCost: '{3}{R}',
  cmc: 4,
  power: '4',
  toughness: '2',
  oracleText: 'When Flametongue Kavu enters the battlefield, it deals 4 damage to target creature.',
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

const DOOMED_TRAVELER: CardDef = {
  name: 'Doomed Traveler',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{W}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'When Doomed Traveler dies, create a 1/1 white Spirit creature token with flying.',
  colors: ['W'],
};

const GLORIOUS_ANTHEM: CardDef = {
  name: 'Glorious Anthem',
  typeLine: 'Enchantment',
  manaCost: '{2}{W}',
  cmc: 3,
  oracleText: 'Creatures you control get +1/+1.',
  colors: ['W'],
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

const RAMPANT_GROWTH: CardDef = {
  name: 'Rampant Growth',
  typeLine: 'Sorcery',
  manaCost: '{1}{G}',
  cmc: 2,
  oracleText: 'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
  colors: ['G'],
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

const SELESNYA_CHARM: CardDef = {
  name: 'Selesnya Charm',
  typeLine: 'Instant',
  manaCost: '{G}{W}',
  cmc: 2,
  oracleText: 'Choose one —\n• Target creature gets +2/+2 and gains trample until end of turn.\n• Exile target creature with power 5 or greater.\n• Create a 2/2 white Knight creature token with vigilance.',
  colors: ['G', 'W'],
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

// ── Blue-black control ───────────────────────────────────────────────────────────────────────────

const ISLAND = land('Island', 'U', 'Island');
const SWAMP = land('Swamp', 'B', 'Swamp');

const COUNTERSPELL: CardDef = {
  name: 'Counterspell',
  typeLine: 'Instant',
  manaCost: '{U}{U}',
  cmc: 2,
  oracleText: 'Counter target spell.',
  colors: ['U'],
};

const NEGATE: CardDef = {
  name: 'Negate',
  typeLine: 'Instant',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Counter target noncreature spell.',
  colors: ['U'],
};

const DOOM_BLADE: CardDef = {
  name: 'Doom Blade',
  typeLine: 'Instant',
  manaCost: '{1}{B}',
  cmc: 2,
  oracleText: 'Destroy target creature.',
  colors: ['B'],
};

const DIVINATION: CardDef = {
  name: 'Divination',
  typeLine: 'Sorcery',
  manaCost: '{2}{U}',
  cmc: 3,
  oracleText: 'Draw two cards.',
  colors: ['U'],
};

const SIGN_IN_BLOOD: CardDef = {
  name: 'Sign in Blood',
  typeLine: 'Sorcery',
  manaCost: '{B}{B}',
  cmc: 2,
  oracleText: 'Target player draws two cards and loses 2 life.',
  colors: ['B'],
};

const MIND_ROT: CardDef = {
  name: 'Mind Rot',
  typeLine: 'Sorcery',
  manaCost: '{2}{B}',
  cmc: 3,
  oracleText: 'Target player discards two cards.',
  colors: ['B'],
};

const DIABOLIC_TUTOR: CardDef = {
  name: 'Diabolic Tutor',
  typeLine: 'Sorcery',
  manaCost: '{3}{B}',
  cmc: 4,
  oracleText: 'Search your library for a card and put that card into your hand, then shuffle.',
  colors: ['B'],
};

const PHYREXIAN_ARENA: CardDef = {
  name: 'Phyrexian Arena',
  typeLine: 'Enchantment',
  manaCost: '{1}{B}{B}',
  cmc: 3,
  oracleText: 'At the beginning of your upkeep, you draw a card and you lose 1 life.',
  colors: ['B'],
};

const TOME_SCOUR: CardDef = {
  name: 'Tome Scour',
  typeLine: 'Sorcery',
  manaCost: '{U}',
  cmc: 1,
  oracleText: "Target player mills five cards.",
  colors: ['U'],
};

const SOUL_MANIPULATION: CardDef = {
  name: 'Soul Manipulation',
  typeLine: 'Instant',
  manaCost: '{1}{U}{B}',
  cmc: 3,
  oracleText: 'Choose one or both —\n• Counter target creature spell.\n• Return target creature card from your graveyard to your hand.',
  colors: ['U', 'B'],
};

const RAVENOUS_RATS: CardDef = {
  name: 'Ravenous Rats',
  typeLine: 'Creature — Rat',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'When Ravenous Rats enters the battlefield, each opponent discards a card at random.',
  colors: ['B'],
};

const CHILD_OF_NIGHT: CardDef = {
  name: 'Child of Night',
  typeLine: 'Creature — Vampire',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Lifelink',
  colors: ['B'],
};

const WIND_DRAKE: CardDef = {
  name: 'Wind Drake',
  typeLine: 'Creature — Drake',
  manaCost: '{2}{U}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Flying',
  colors: ['U'],
};

const VAMPIRE_NIGHTHAWK: CardDef = {
  name: 'Vampire Nighthawk',
  typeLine: 'Creature — Vampire Shaman',
  manaCost: '{1}{B}{B}',
  cmc: 3,
  power: '2',
  toughness: '3',
  oracleText: 'Flying, deathtouch, lifelink',
  colors: ['B'],
};

const MAN_O_WAR: CardDef = {
  name: "Man-o'-War",
  typeLine: 'Creature — Jellyfish',
  manaCost: '{2}{U}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: "When Man-o'-War enters the battlefield, return target creature to its owner's hand.",
  colors: ['U'],
};

const AIR_ELEMENTAL: CardDef = {
  name: 'Air Elemental',
  typeLine: 'Creature — Elemental',
  manaCost: '{3}{U}{U}',
  cmc: 5,
  power: '4',
  toughness: '4',
  oracleText: 'Flying',
  colors: ['U'],
};

const TALRAND: CardDef = {
  name: 'Talrand, Sky Summoner',
  typeLine: 'Legendary Creature — Merfolk Wizard',
  manaCost: '{2}{U}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake creature token with flying.',
  colors: ['U'],
};

// ── Green-black graveyard ────────────────────────────────────────────────────────────────────────

const FLESHBAG_MARAUDER: CardDef = {
  name: 'Fleshbag Marauder',
  typeLine: 'Creature — Human Warrior',
  manaCost: '{2}{B}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'When Fleshbag Marauder enters the battlefield, each player sacrifices a creature.',
  colors: ['B'],
};

const GRAVEDIGGER: CardDef = {
  name: 'Gravedigger',
  typeLine: 'Creature — Zombie',
  manaCost: '{3}{B}',
  cmc: 4,
  power: '2',
  toughness: '2',
  oracleText: 'When Gravedigger enters the battlefield, return target creature card from your graveyard to your hand.',
  colors: ['B'],
};

const RAISE_DEAD: CardDef = {
  name: 'Raise Dead',
  typeLine: 'Sorcery',
  manaCost: '{B}',
  cmc: 1,
  oracleText: 'Return target creature card from your graveyard to your hand.',
  colors: ['B'],
};

const ZOMBIFY: CardDef = {
  name: 'Zombify',
  typeLine: 'Sorcery',
  manaCost: '{3}{B}',
  cmc: 4,
  oracleText: 'Put target creature card from your graveyard onto the battlefield under your control.',
  colors: ['B'],
};

const THORNWEALD_ARCHER: CardDef = {
  name: 'Thornweald Archer',
  typeLine: 'Creature — Elf Archer',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Reach, deathtouch',
  colors: ['G'],
};

const WALL_OF_BLOSSOMS: CardDef = {
  name: 'Wall of Blossoms',
  typeLine: 'Creature — Plant Wall',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '0',
  toughness: '4',
  oracleText: 'Defender\nWhen Wall of Blossoms enters the battlefield, draw a card.',
  colors: ['G'],
};

const DOOMED_DISSENTER: CardDef = {
  name: 'Doomed Dissenter',
  typeLine: 'Creature — Human',
  manaCost: '{B}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'When Doomed Dissenter dies, create a 2/2 black Zombie creature token.',
  colors: ['B'],
};

const GRIM_DISCOVERY: CardDef = {
  name: 'Grim Discovery',
  typeLine: 'Sorcery',
  manaCost: '{1}{B}',
  cmc: 2,
  oracleText: 'Choose one or both —\n• Return target creature card from your graveyard to your hand.\n• Return target land card from your graveyard to your hand.',
  colors: ['B'],
};

const LOTLETH_GIANT: CardDef = {
  name: 'Lotleth Giant',
  typeLine: 'Creature — Zombie Giant',
  manaCost: '{6}{B}',
  cmc: 7,
  power: '5',
  toughness: '6',
  oracleText: 'When Lotleth Giant enters the battlefield, each opponent loses 1 life for each creature card in your graveyard.',
  colors: ['B'],
};

const VAMPIRE_ARISTOCRAT: CardDef = {
  name: 'Vampire Aristocrat',
  typeLine: 'Creature — Vampire Rogue',
  manaCost: '{2}{B}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Sacrifice a creature: Vampire Aristocrat gets +2/+2 until end of turn.',
  colors: ['B'],
};

const BLOODTHRONE_VAMPIRE: CardDef = {
  name: 'Bloodthrone Vampire',
  typeLine: 'Creature — Vampire',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Sacrifice another creature: Bloodthrone Vampire gets +2/+2 until end of turn.',
  colors: ['B'],
};

const IZONI: CardDef = {
  name: 'Izoni, Thousand-Eyed',
  typeLine: 'Legendary Creature — Elf Shaman',
  manaCost: '{2}{B}{G}',
  cmc: 4,
  power: '2',
  toughness: '3',
  oracleText: 'When Izoni, Thousand-Eyed enters the battlefield, create a 1/1 black and green Insect creature token for each creature card in your graveyard.\n{B}{G}, Sacrifice another creature: You gain 1 life and draw a card.',
  colors: ['B', 'G'],
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
    { card: RAGING_GOBLIN, count: 3 },
    { card: GOBLIN_ARSONIST, count: 3 },
    { card: FIREBRAND_ARCHER, count: 3 },
    { card: THERMO_ALCHEMIST, count: 2 },
    { card: HILL_GIANT, count: 1 },
    { card: FLAMETONGUE_KAVU, count: 2 },
    { card: SHIVAN_DRAGON, count: 3 },
    { card: LIGHTNING_BOLT, count: 4 },
    { card: SHOCK, count: 3 },
    { card: LAVA_SPIKE, count: 3 },
    { card: FAITHLESS_LOOTING, count: 2 },
    { card: FLAME_SLASH, count: 4 },
    { card: ACT_OF_TREASON, count: 1 },
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
    { card: RAMPANT_GROWTH, count: 4 },
    { card: GRIZZLY_BEARS, count: 1 },
    { card: DOOMED_TRAVELER, count: 3 },
    { card: GLORIOUS_ANTHEM, count: 2 },
    { card: CENTAUR_COURSER, count: 3 },
    { card: AJANIS_PRIDEMATE, count: 3 },
    { card: SERRA_ANGEL, count: 3 },
    { card: GIANT_GROWTH, count: 3 },
    { card: SELESNYA_CHARM, count: 3 },
    { card: PACIFISM, count: 2 },
    { card: SWORDS_TO_PLOWSHARES, count: 3 },
    { card: HARMONIZE, count: 2 },
    { card: OVERRUN, count: 2 },
  ],
};

export const TIDAL_MIND: DeckSpec = {
  id: 'tidal-mind',
  name: 'Tidal Mind',
  description: 'Blue-black control. Counter what matters, kill what lands, and win in the air.',
  commander: TALRAND,
  cards: [
    { card: ISLAND, count: 12 },
    { card: SWAMP, count: 11 },
    { card: COUNTERSPELL, count: 3 },
    { card: NEGATE, count: 2 },
    { card: DOOM_BLADE, count: 3 },
    { card: PHYREXIAN_ARENA, count: 3 },
    { card: DIVINATION, count: 2 },
    { card: SIGN_IN_BLOOD, count: 2 },
    { card: TOME_SCOUR, count: 1 },
    { card: MIND_ROT, count: 3 },
    { card: DIABOLIC_TUTOR, count: 2 },
    { card: SOUL_MANIPULATION, count: 3 },
    { card: RAVENOUS_RATS, count: 3 },
    { card: CHILD_OF_NIGHT, count: 2 },
    { card: WIND_DRAKE, count: 1 },
    { card: MAN_O_WAR, count: 2 },
    { card: VAMPIRE_NIGHTHAWK, count: 3 },
    { card: AIR_ELEMENTAL, count: 2 },
  ],
};

export const ROT_HARVEST: DeckSpec = {
  id: 'rot-harvest',
  name: 'Rot Harvest',
  description: 'Green-black graveyard. Trade creatures freely, then buy them all back.',
  commander: IZONI,
  cards: [
    { card: FOREST, count: 11 },
    { card: SWAMP, count: 12 },
    { card: LLANOWAR_ELVES, count: 4 },
    { card: THORNWEALD_ARCHER, count: 2 },
    { card: DOOMED_DISSENTER, count: 3 },
    { card: WALL_OF_BLOSSOMS, count: 3 },
    { card: FLESHBAG_MARAUDER, count: 3 },
    { card: CENTAUR_COURSER, count: 1 },
    { card: BLOODTHRONE_VAMPIRE, count: 3 },
    { card: VAMPIRE_ARISTOCRAT, count: 3 },
    { card: GRAVEDIGGER, count: 4 },
    { card: RAISE_DEAD, count: 2 },
    { card: GRIM_DISCOVERY, count: 2 },
    { card: ZOMBIFY, count: 2 },
    { card: DOOM_BLADE, count: 3 },
    { card: LOTLETH_GIANT, count: 2 },
  ],
};

export const STARTER_DECKS: Readonly<Record<string, DeckSpec>> = Object.freeze({
  [EMBER_RUSH.id]: EMBER_RUSH,
  [VERDANT_GUARD.id]: VERDANT_GUARD,
  [TIDAL_MIND.id]: TIDAL_MIND,
  [ROT_HARVEST.id]: ROT_HARVEST,
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
