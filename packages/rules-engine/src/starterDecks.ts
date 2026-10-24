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

/**
 * The Guildgates: one mana of either of two colours, and they come in tapped.
 *
 * The tapped clause is the whole price of the card, and it is what makes a dual land fair enough
 * to print at common. Between them they are also the first lands in the pool that are not basic.
 */
const SELESNYA_GUILDGATE: CardDef = {
  name: 'Selesnya Guildgate',
  typeLine: 'Land — Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Selesnya Guildgate enters the battlefield tapped.\n{T}: Add {G} or {W}.',
  colors: [],
};

const DIMIR_GUILDGATE: CardDef = {
  name: 'Dimir Guildgate',
  typeLine: 'Land — Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Dimir Guildgate enters the battlefield tapped.\n{T}: Add {U} or {B}.',
  colors: [],
};

const GOLGARI_GUILDGATE: CardDef = {
  name: 'Golgari Guildgate',
  typeLine: 'Land — Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Golgari Guildgate enters the battlefield tapped.\n{T}: Add {B} or {G}.',
  colors: [],
};

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

const IMPACT_TREMORS: CardDef = {
  name: 'Impact Tremors',
  typeLine: 'Enchantment',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Whenever a creature you control enters the battlefield, Impact Tremors deals 1 damage to each opponent.',
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

const BONESPLITTER: CardDef = {
  name: 'Bonesplitter',
  typeLine: 'Artifact — Equipment',
  manaCost: '{1}',
  cmc: 1,
  oracleText: 'Equipped creature gets +2/+0.\nEquip {1}',
  colors: [],
};

const MAGMA_JET: CardDef = {
  name: 'Magma Jet',
  typeLine: 'Instant',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Magma Jet deals 2 damage to any target.\nScry 2.',
  colors: ['R'],
};

const FIREBALL: CardDef = {
  name: 'Fireball',
  typeLine: 'Sorcery',
  manaCost: '{X}{R}',
  cmc: 1,
  oracleText: 'Fireball deals X damage to any target.',
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

const SOUL_WARDEN: CardDef = {
  name: 'Soul Warden',
  typeLine: 'Creature — Human Cleric',
  manaCost: '{W}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'Whenever another creature enters the battlefield, you gain 1 life.',
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

const LOXODON_WARHAMMER: CardDef = {
  name: 'Loxodon Warhammer',
  typeLine: 'Artifact — Equipment',
  manaCost: '{3}',
  cmc: 3,
  oracleText: 'Equipped creature gets +3/+0 and has trample and lifelink.\nEquip {3}',
  colors: [],
};

const GARRUK_WILDSPEAKER: CardDef = {
  name: 'Garruk Wildspeaker',
  typeLine: 'Legendary Planeswalker — Garruk',
  manaCost: '{2}{G}{G}',
  cmc: 4,
  loyalty: '3',
  oracleText: '+1: Untap two target lands.\n−1: Create a 3/3 green Beast creature token.\n−4: Creatures you control get +3/+3 and gain trample until end of turn.',
  colors: ['G'],
};

const SECURE_THE_WASTES: CardDef = {
  name: 'Secure the Wastes',
  typeLine: 'Instant',
  manaCost: '{X}{W}',
  cmc: 1,
  oracleText: 'Create X 1/1 white Warrior creature tokens.',
  colors: ['W'],
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

const DRUDGE_SKELETONS: CardDef = {
  name: 'Drudge Skeletons',
  typeLine: 'Creature — Skeleton',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: '{B}: Regenerate Drudge Skeletons.',
  colors: ['B'],
};

const GOLGARI_CHARM: CardDef = {
  name: 'Golgari Charm',
  typeLine: 'Instant',
  manaCost: '{B}{G}',
  cmc: 2,
  oracleText: 'Choose one —\n• All creatures get -1/-1 until end of turn.\n• Destroy target enchantment.\n• Regenerate each creature you control.',
  colors: ['B', 'G'],
};

const ENDLESS_ONE: CardDef = {
  name: 'Endless One',
  typeLine: 'Creature — Eldrazi',
  manaCost: '{X}',
  cmc: 0,
  power: '0',
  toughness: '0',
  oracleText: 'Endless One enters the battlefield with X +1/+1 counters on it.',
  colors: [],
};

const BASILISK_COLLAR: CardDef = {
  name: 'Basilisk Collar',
  typeLine: 'Artifact — Equipment',
  manaCost: '{1}',
  cmc: 1,
  oracleText: 'Equipped creature has deathtouch and lifelink.\nEquip {2}',
  colors: [],
};

const PREORDAIN: CardDef = {
  name: 'Preordain',
  typeLine: 'Sorcery',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'Scry 1, then draw a card.',
  colors: ['U'],
};

const OMENSPEAKER: CardDef = {
  name: 'Omenspeaker',
  typeLine: 'Creature — Human Wizard',
  manaCost: '{1}{U}',
  cmc: 2,
  power: '1',
  toughness: '3',
  oracleText: 'When Omenspeaker enters the battlefield, scry 2.',
  colors: ['U'],
};

const JACE_BELEREN: CardDef = {
  name: 'Jace Beleren',
  typeLine: 'Legendary Planeswalker — Jace',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  loyalty: '3',
  oracleText: '+2: Each player draws a card.\n−1: You draw a card.\n−10: Target player mills twenty cards.',
  colors: ['U'],
};

const MIND_SPRING: CardDef = {
  name: 'Mind Spring',
  typeLine: 'Sorcery',
  manaCost: '{X}{U}{U}',
  cmc: 2,
  oracleText: 'Draw X cards.',
  colors: ['U'],
};

const EXSANGUINATE: CardDef = {
  name: 'Exsanguinate',
  typeLine: 'Sorcery',
  manaCost: '{X}{B}',
  cmc: 1,
  oracleText: 'Each opponent loses X life. You gain life equal to the life lost this way.',
  colors: ['B'],
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

const BLOOD_ARTIST: CardDef = {
  name: 'Blood Artist',
  typeLine: 'Creature — Vampire',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '0',
  toughness: '1',
  oracleText: 'Whenever Blood Artist or another creature dies, target player loses 1 life and you gain 1 life.',
  colors: ['B'],
};

const ZULAPORT_CUTTHROAT: CardDef = {
  name: 'Zulaport Cutthroat',
  typeLine: 'Creature — Human Rogue',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Whenever Zulaport Cutthroat or another creature you control dies, each opponent loses 1 life and you gain 1 life.',
  colors: ['B'],
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

const HURRICANE: CardDef = {
  name: 'Hurricane',
  typeLine: 'Sorcery',
  manaCost: '{X}{G}',
  cmc: 1,
  oracleText: 'Hurricane deals X damage to each creature with flying and each player.',
  colors: ['G'],
};

// ── Red-white equipment ──────────────────────────────────────────────────────────────────────────

const BOROS_GUILDGATE: CardDef = {
  name: 'Boros Guildgate',
  typeLine: 'Land — Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Boros Guildgate enters the battlefield tapped.\n{T}: Add {R} or {W}.',
  colors: [],
};

const ELITE_VANGUARD: CardDef = {
  name: 'Elite Vanguard',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{W}',
  cmc: 1,
  power: '2',
  toughness: '1',
  oracleText: '',
  colors: ['W'],
};

const LEONIN_SKYHUNTER: CardDef = {
  name: 'Leonin Skyhunter',
  typeLine: 'Creature — Cat Knight',
  manaCost: '{W}{W}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Flying',
  colors: ['W'],
};

const RAISE_THE_ALARM: CardDef = {
  name: 'Raise the Alarm',
  typeLine: 'Instant',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText: 'Create two 1/1 white Soldier creature tokens.',
  colors: ['W'],
};

const ANGELIC_GIFT: CardDef = {
  name: 'Angelic Gift',
  typeLine: 'Enchantment — Aura',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText: 'Enchant creature\nWhen Angelic Gift enters the battlefield, draw a card.\nEnchanted creature has flying.',
  colors: ['W'],
};

const INSPIRED_CHARGE: CardDef = {
  name: 'Inspired Charge',
  typeLine: 'Instant',
  manaCost: '{2}{W}',
  cmc: 3,
  oracleText: 'Creatures you control get +2/+1 until end of turn.',
  colors: ['W'],
};

const BALAN: CardDef = {
  name: 'Balan, Wandering Knight',
  typeLine: 'Legendary Creature — Cat Knight',
  manaCost: '{2}{W}{W}',
  cmc: 4,
  power: '2',
  toughness: '2',
  oracleText: 'Double strike\n{1}{W}: Attach all Equipment you control to Balan, Wandering Knight.',
  colors: ['W'],
};

// ── The decks ────────────────────────────────────────────────────────────────────────────────────

// ── Eight that needed nothing new ────────────────────────────────────────────────────────────────

const DAY_OF_JUDGMENT: CardDef = {
  name: 'Day of Judgment',
  typeLine: 'Sorcery',
  manaCost: '{2}{W}{W}',
  cmc: 4,
  oracleText: 'Destroy all creatures.',
  colors: ['W'],
};

const ESSENCE_SCATTER: CardDef = {
  name: 'Essence Scatter',
  typeLine: 'Instant',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Counter target creature spell.',
  colors: ['U'],
};

const UNSUMMON: CardDef = {
  name: 'Unsummon',
  typeLine: 'Instant',
  manaCost: '{U}',
  cmc: 1,
  oracleText: "Return target creature to its owner's hand.",
  colors: ['U'],
};

const ICY_MANIPULATOR: CardDef = {
  name: 'Icy Manipulator',
  typeLine: 'Artifact',
  manaCost: '{4}',
  cmc: 4,
  oracleText: '{1}, {T}: Tap target artifact, creature, or land.',
  colors: [],
};

const TORMODS_CRYPT: CardDef = {
  name: "Tormod's Crypt",
  typeLine: 'Artifact',
  manaCost: '{0}',
  cmc: 0,
  oracleText: "{T}, Sacrifice Tormod's Crypt: Exile target player's graveyard.",
  colors: [],
};

const AMBUSH_VIPER: CardDef = {
  name: 'Ambush Viper',
  typeLine: 'Creature \u2014 Snake',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Flash\nDeathtouch',
  colors: ['G'],
};

const ELVISH_VISIONARY: CardDef = {
  name: 'Elvish Visionary',
  typeLine: 'Creature \u2014 Elf Shaman',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'When Elvish Visionary enters the battlefield, draw a card.',
  colors: ['G'],
};

const READ_THE_BONES: CardDef = {
  name: 'Read the Bones',
  typeLine: 'Sorcery',
  manaCost: '{2}{B}',
  cmc: 3,
  oracleText: 'Scry 2, then draw two cards. You lose 2 life.',
  colors: ['B'],
};

// ── Attacks that trigger off the board ───────────────────────────────────────────────────────────

const HELLRIDER: CardDef = {
  name: 'Hellrider',
  typeLine: 'Creature \u2014 Devil',
  manaCost: '{2}{R}{R}',
  cmc: 4,
  power: '3',
  toughness: '3',
  oracleText: "Haste\nWhenever a creature you control attacks, Hellrider deals 1 damage to the player or planeswalker it's attacking.",
  colors: ['R'],
};

const BALL_LIGHTNING: CardDef = {
  name: 'Ball Lightning',
  typeLine: 'Creature \u2014 Elemental',
  manaCost: '{R}{R}{R}',
  cmc: 3,
  power: '6',
  toughness: '1',
  oracleText: 'Trample, haste\nAt the beginning of the end step, sacrifice Ball Lightning.',
  colors: ['R'],
};

const CLOUDSHIFT: CardDef = {
  name: 'Cloudshift',
  typeLine: 'Instant',
  manaCost: '{W}',
  cmc: 1,
  oracleText: 'Exile target creature you control, then return that card to the battlefield under your control.',
  colors: ['W'],
};


// ── The keywords nothing in the pool carried ─────────────────────────────────────────────────────

const YOUTHFUL_KNIGHT: CardDef = {
  name: 'Youthful Knight',
  typeLine: 'Creature \u2014 Human Knight',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'First strike',
  colors: ['W'],
};

const BOGGART_BRUTE: CardDef = {
  name: 'Boggart Brute',
  typeLine: 'Creature \u2014 Goblin Berserker',
  manaCost: '{2}{R}',
  cmc: 3,
  power: '3',
  toughness: '2',
  oracleText: 'Menace',
  colors: ['R'],
};

const DARKSTEEL_PLATE: CardDef = {
  name: 'Darksteel Plate',
  typeLine: 'Artifact \u2014 Equipment',
  manaCost: '{3}',
  cmc: 3,
  oracleText: 'Equipped creature is indestructible.\nEquip {2}',
  colors: [],
};

const ROBE_OF_MIRRORS: CardDef = {
  name: 'Robe of Mirrors',
  typeLine: 'Enchantment \u2014 Aura',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'Enchant creature\nEnchanted creature has shroud.',
  colors: ['U'],
};

const NIGHT_OF_SOULS_BETRAYAL: CardDef = {
  name: "Night of Souls' Betrayal",
  typeLine: 'Legendary Enchantment',
  manaCost: '{2}{B}{B}{B}',
  cmc: 5,
  oracleText: 'All creatures get -1/-1.',
  colors: ['B'],
};


// ── White-blue fliers and answers ────────────────────────────────────────────────────────────────

const AZORIUS_GUILDGATE: CardDef = {
  name: 'Azorius Guildgate',
  typeLine: 'Land \u2014 Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Azorius Guildgate enters the battlefield tapped.\n{T}: Add {W} or {U}.',
  colors: [],
};

const HANNA_SHIPS_NAVIGATOR: CardDef = {
  name: "Hanna, Ship's Navigator",
  typeLine: 'Legendary Creature \u2014 Human Artificer',
  manaCost: '{1}{W}{U}',
  cmc: 3,
  power: '1',
  toughness: '3',
  oracleText: '{1}{W}{U}, {T}: Return target artifact or enchantment card from your graveyard to your hand.',
  colors: ['W', 'U'],
};

const WALL_OF_AIR: CardDef = {
  name: 'Wall of Air',
  typeLine: 'Creature \u2014 Wall',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  power: '1',
  toughness: '5',
  oracleText: 'Defender, flying',
  colors: ['U'],
};


// ── Ten more ─────────────────────────────────────────────────────────────────────────────────────

const LIGHTNING_STRIKE: CardDef = {
  name: 'Lightning Strike',
  typeLine: 'Instant',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Lightning Strike deals 3 damage to any target.',
  colors: ['R'],
};

const CANCEL: CardDef = {
  name: 'Cancel',
  typeLine: 'Instant',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  oracleText: 'Counter target spell.',
  colors: ['U'],
};

const MURDER: CardDef = {
  name: 'Murder',
  typeLine: 'Instant',
  manaCost: '{1}{B}{B}',
  cmc: 3,
  oracleText: 'Destroy target creature.',
  colors: ['B'],
};

const GIANT_SPIDER: CardDef = {
  name: 'Giant Spider',
  typeLine: 'Creature \u2014 Spider',
  manaCost: '{3}{G}',
  cmc: 4,
  power: '2',
  toughness: '4',
  oracleText: 'Reach',
  colors: ['G'],
};

const TITANIC_GROWTH: CardDef = {
  name: 'Titanic Growth',
  typeLine: 'Instant',
  manaCost: '{1}{G}',
  cmc: 2,
  oracleText: 'Target creature gets +4/+4 until end of turn.',
  colors: ['G'],
};

const HEALERS_HAWK: CardDef = {
  name: "Healer's Hawk",
  typeLine: 'Creature \u2014 Bird',
  manaCost: '{W}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'Flying, lifelink',
  colors: ['W'],
};

const LAVA_AXE: CardDef = {
  name: 'Lava Axe',
  typeLine: 'Sorcery',
  manaCost: '{4}{R}',
  cmc: 5,
  oracleText: 'Lava Axe deals 5 damage to target player or planeswalker.',
  colors: ['R'],
};

const DARK_RITUAL: CardDef = {
  name: 'Dark Ritual',
  typeLine: 'Instant',
  manaCost: '{B}',
  cmc: 1,
  oracleText: 'Add {B}{B}{B}.',
  colors: ['B'],
};

const BORDERLAND_MARAUDER: CardDef = {
  name: 'Borderland Marauder',
  typeLine: 'Creature \u2014 Human Warrior',
  manaCost: '{1}{R}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Whenever Borderland Marauder attacks, it gets +2/+0 until end of turn.',
  colors: ['R'],
};

const PREY_UPON: CardDef = {
  name: 'Prey Upon',
  typeLine: 'Sorcery',
  manaCost: '{G}',
  cmc: 1,
  oracleText: "Target creature you control fights target creature you don't control.",
  colors: ['G'],
};

const FOG: CardDef = {
  name: 'Fog',
  typeLine: 'Instant',
  manaCost: '{G}',
  cmc: 1,
  oracleText: 'Prevent all combat damage that would be dealt this turn.',
  colors: ['G'],
};

const HOLY_DAY: CardDef = {
  name: 'Holy Day',
  typeLine: 'Instant',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText: 'Prevent all combat damage that would be dealt this turn.',
  colors: ['W'],
};

const FOG_BANK: CardDef = {
  name: 'Fog Bank',
  typeLine: 'Creature \u2014 Wall',
  manaCost: '{1}{U}',
  cmc: 2,
  power: '0',
  toughness: '2',
  // The keywords on their own line, as a printed card has them: `printedKeywords` only reads a
  // line that is nothing *but* keywords, which is what stops it finding "flying" in a sentence.
  oracleText:
    'Defender, flying\nPrevent all combat damage that would be dealt to and dealt by Fog Bank.',
  colors: ['U'],
};

const MAZE_OF_ITH: CardDef = {
  name: 'Maze of Ith',
  typeLine: 'Land',
  manaCost: '',
  cmc: 0,
  oracleText:
    '{T}: Untap target attacking creature. Prevent all combat damage that would be dealt to and '
    + 'dealt by that creature this turn.',
  colors: [],
};

const DIVINE_VERDICT: CardDef = {
  name: 'Divine Verdict',
  typeLine: 'Instant',
  manaCost: '{2}{W}{W}',
  cmc: 4,
  oracleText: 'Destroy target attacking or blocking creature.',
  colors: ['W'],
};


// ── Mana that is not a land ──────────────────────────────────────────────────────────────────────

const SOL_RING: CardDef = {
  name: 'Sol Ring',
  typeLine: 'Artifact',
  manaCost: '{1}',
  cmc: 1,
  oracleText: '{T}: Add {C}{C}.',
  colors: [],
};

const MIND_STONE: CardDef = {
  name: 'Mind Stone',
  typeLine: 'Artifact',
  manaCost: '{2}',
  cmc: 2,
  oracleText: '{T}: Add {C}.\n{1}, {T}, Sacrifice Mind Stone: Draw a card.',
  colors: [],
};

const BIRDS_OF_PARADISE: CardDef = {
  name: 'Birds of Paradise',
  typeLine: 'Creature \u2014 Bird',
  manaCost: '{G}',
  cmc: 1,
  power: '0',
  toughness: '1',
  oracleText: 'Flying\n{T}: Add one mana of any color.',
  colors: ['G'],
};


// ── Exile until this leaves the battlefield ──────────────────────────────────────────────────────

const BANISHER_PRIEST: CardDef = {
  name: 'Banisher Priest',
  typeLine: 'Creature \u2014 Human Cleric',
  manaCost: '{1}{W}{W}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'When Banisher Priest enters the battlefield, exile target creature an opponent controls until Banisher Priest leaves the battlefield.',
  colors: ['W'],
};

const JOURNEY_TO_NOWHERE: CardDef = {
  name: 'Journey to Nowhere',
  typeLine: 'Enchantment',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText: 'When Journey to Nowhere enters the battlefield, exile target creature.\nWhen Journey to Nowhere leaves the battlefield, return the exiled card to the battlefield under its owner\u2019s control.',
  colors: ['W'],
};

/**
 * Banishing Light, and not Oblivion Ring, because of one word.
 *
 * Oblivion Ring says "exile target nonland permanent", and on an empty board that is itself: it
 * exiles itself, its leave trigger returns it, entering exiles it again. A real loop on a real
 * card, which the engine reproduced faithfully and which ended two games in thirty on turn five.
 * Banishing Light is the same card with "another" in it.
 */
const BANISHING_LIGHT: CardDef = {
  name: 'Banishing Light',
  typeLine: 'Enchantment',
  manaCost: '{3}{W}',
  cmc: 4,
  oracleText: 'When Banishing Light enters the battlefield, exile another target nonland permanent until Banishing Light leaves the battlefield.',
  colors: ['W'],
};


// ── Costs that are choices: cycling, kicker, and a creature on the altar ─────────────────────────

/**
 * The cycling lands: a land that is never a dead draw, because the late-game version of it is a
 * cantrip. One per colour, and the first cards in the pool with an ability used from the hand.
 */
const cyclingLand = (name: string, symbol: string, type: string): CardDef => ({
  name,
  typeLine: `Land — ${type}`,
  manaCost: '',
  cmc: 0,
  oracleText: `${name} enters the battlefield tapped.\n{T}: Add {${symbol}}.\nCycling {2} ({2}, Discard this card: Draw a card.)`,
  colors: [],
});

const BARREN_MOOR = cyclingLand('Barren Moor', 'B', 'Swamp');
const FORGOTTEN_CAVE = cyclingLand('Forgotten Cave', 'R', 'Mountain');
const LONELY_SANDBAR = cyclingLand('Lonely Sandbar', 'U', 'Island');
const SECLUDED_STEPPE = cyclingLand('Secluded Steppe', 'W', 'Plains');
const TRANQUIL_THICKET = cyclingLand('Tranquil Thicket', 'G', 'Forest');

const RAKDOS_GUILDGATE: CardDef = {
  name: 'Rakdos Guildgate',
  typeLine: 'Land — Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Rakdos Guildgate enters the battlefield tapped.\n{T}: Add {B} or {R}.',
  colors: [],
};

const BURST_LIGHTNING: CardDef = {
  name: 'Burst Lightning',
  typeLine: 'Instant',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Kicker {4}\nBurst Lightning deals 2 damage to any target. If this spell was kicked, it deals 4 damage instead.',
  colors: ['R'],
};

const BREATH_OF_DARIGAAZ: CardDef = {
  name: 'Breath of Darigaaz',
  typeLine: 'Sorcery',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Kicker {3}\nBreath of Darigaaz deals 1 damage to each creature without flying and each player. If this spell was kicked, it deals 4 damage instead.',
  colors: ['R'],
};

const AGONIZING_DEMISE: CardDef = {
  name: 'Agonizing Demise',
  typeLine: 'Instant',
  manaCost: '{2}{B}',
  cmc: 3,
  oracleText: 'Kicker {1}{R}\nDestroy target nonblack creature. If this spell was kicked, it deals damage equal to that creature\u2019s power to the creature\u2019s controller.',
  colors: ['B'],
};

const BONE_SPLINTERS: CardDef = {
  name: 'Bone Splinters',
  typeLine: 'Sorcery',
  manaCost: '{B}',
  cmc: 1,
  oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDestroy target creature.',
  colors: ['B'],
};

const VILLAGE_RITES: CardDef = {
  name: 'Village Rites',
  typeLine: 'Instant',
  manaCost: '{B}',
  cmc: 1,
  oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.',
  colors: ['B'],
};

const JUDITH: CardDef = {
  name: 'Judith, the Scourge Diva',
  typeLine: 'Legendary Creature \u2014 Human Shaman',
  manaCost: '{1}{B}{R}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Other creatures you control get +1/+0.\nWhenever a nontoken creature you control dies, Judith, the Scourge Diva deals 1 damage to any target.',
  colors: ['B', 'R'],
};

export const EMBER_RUSH: DeckSpec = {
  id: 'ember-rush',
  name: 'Ember Rush',
  description: 'Mono-red aggro. Cheap hasty creatures, burn to the face, and a dragon to finish.',
  commander: KRENKO_MOB_BOSS,
  cards: [
    // Nineteen rather than twenty-two: the Equipment, the X spell, Hellrider and then the second
    // Lightning Strike had to come from somewhere, and a land is the only thing in here no test
    // reaches for by name. The curve came down with it — this deck's most expensive card it
    // actually wants to cast on curve is four.
    { card: MOUNTAIN, count: 19 },
    { card: MONASTERY_SWIFTSPEAR, count: 4 },
    { card: RAGING_GOBLIN, count: 2 },
    { card: GOBLIN_ARSONIST, count: 2 },
    { card: FIREBRAND_ARCHER, count: 2 },
    { card: MAGMA_JET, count: 1 },
    { card: THERMO_ALCHEMIST, count: 2 },
    { card: HILL_GIANT, count: 1 },
    { card: FLAMETONGUE_KAVU, count: 2 },
    // One Dragon rather than two. A deck whose curve tops out at four wants one six-drop to win a
    // stalled board, not two to draw in the opening hand, and the slot went back to the second
    // Shock — which is not a preference: `automation.test.ts` deals a grip with two of them.
    { card: SHIVAN_DRAGON, count: 1 },
    { card: LIGHTNING_BOLT, count: 4 },
    { card: SHOCK, count: 2 },
    { card: BONESPLITTER, count: 2 },
    { card: LAVA_SPIKE, count: 1 },
    // Burn at instant speed between the Bolt and the Flame Slash, a two-drop that is a 4/2 on the
    // swing, and five damage from nowhere when the board has stalled.
    { card: LIGHTNING_STRIKE, count: 2 },
    { card: BORDERLAND_MARAUDER, count: 2 },
    { card: LAVA_AXE, count: 1 },
    // The deck's two best turn-four attacks, and the two cards it lost a Dragon, a Mountain, a
    // Fireball and an Impact Tremors to make room for. Hellrider is the payoff for the three
    // one-drops above it — a board of four creatures swings for four extra damage the blockers
    // cannot touch — and Ball Lightning is six of it from an empty board, once.
    { card: HELLRIDER, count: 2 },
    { card: BALL_LIGHTNING, count: 2 },
    // The deck's X spell, and the reason the burn counts above came down by one each: a Fireball
    // is what a mana-flooded red deck does with a board it cannot get past.
    { card: FIREBALL, count: 1 },
    { card: IMPACT_TREMORS, count: 1 },
    { card: FAITHLESS_LOOTING, count: 1 },
    { card: FLAME_SLASH, count: 2 },
    { card: ACT_OF_TREASON, count: 1 },
  ],
};

export const VERDANT_GUARD: DeckSpec = {
  id: 'verdant-guard',
  name: 'Verdant Guard',
  description: 'Green-white midrange. Bigger creatures, auras, exile removal and a fliers finish.',
  commander: SIGARDA_HOST_OF_HERONS,
  cards: [
    { card: FOREST, count: 8 },
    { card: PLAINS, count: 7 },
    { card: SELESNYA_GUILDGATE, count: 2 },
    // Two of its Forests are cycling lands, which is the one decision this deck's mana base has.
    { card: TRANQUIL_THICKET, count: 2 },
    { card: LLANOWAR_ELVES, count: 2 },
    // The same mana a turn early as the Elves, in either colour, with flying attached — which is
    // what a two-colour deck actually wants from a one-drop.
    { card: BIRDS_OF_PARADISE, count: 2 },
    // Two rather than three: the third was the slot Secure the Wastes came back into, and a deck
    // with four other mana sources on one and two does not need a third copy of the ramp.
    { card: RAMPANT_GROWTH, count: 2 },
    { card: GARRUK_WILDSPEAKER, count: 1 },
    { card: SOUL_WARDEN, count: 2 },
    // Both copies, pinned: `playout.test.ts` asks whether a death reaches its trigger in a real
    // game, and the Spirit it watches for is this card's.
    { card: DOOMED_TRAVELER, count: 2 },
    // A plain 2/2 with no text, kept at one copy on purpose: `testkit.ts` builds its boards by
    // pulling named cards out of a real deck, so the vanilla creature two dozen tests use as
    // their fixture has to be *in* a deck to be reachable. Cutting it breaks them all at once.
    { card: GRIZZLY_BEARS, count: 1 },
    { card: GLORIOUS_ANTHEM, count: 1 },
    { card: CENTAUR_COURSER, count: 1 },
    { card: AJANIS_PRIDEMATE, count: 1 },
    // A blocker that arrives after the attack is declared, and a body that replaces itself.
    { card: AMBUSH_VIPER, count: 1 },
    { card: ELVISH_VISIONARY, count: 1 },
    // A 2/4 that stops a flier without being one, which is the one thing a green deck is short of.
    { card: GIANT_SPIDER, count: 2 },
    { card: SERRA_ANGEL, count: 2 },
    // Removal that gives the creature back if you kill the thing holding it, which is the deck's
    // answer to a creature it cannot block rather than a second Pacifism.
    { card: BANISHER_PRIEST, count: 1 },
    { card: JOURNEY_TO_NOWHERE, count: 2 },
    // A Plains and a Pacifism paid for these. Cloudshift is one mana that saves a creature from
    // removal, draws a card off the Visionary, and re-aims a Banisher Priest at something newer —
    // three cards' worth of work from one line of script, because the return is an arrival like
    // any other and every enter-the-battlefield trigger here fires again on its own.
    { card: CLOUDSHIFT, count: 2 },
    { card: GIANT_GROWTH, count: 1 },
    { card: TITANIC_GROWTH, count: 1 },
    // One mana that beats an alpha strike, and the cheapest card in the game that does. It cost a
    // second Banisher Priest, in a deck already holding five other ways to answer one creature.
    { card: FOG, count: 1 },
    // Removal a green deck is actually allowed: the biggest creature on the table eats something.
    { card: PREY_UPON, count: 2 },
    { card: LOXODON_WARHAMMER, count: 1 },
    { card: SELESNYA_CHARM, count: 1 },
    { card: PACIFISM, count: 1 },
    { card: SWORDS_TO_PLOWSHARES, count: 2 },
    { card: HARMONIZE, count: 1 },
    { card: OVERRUN, count: 1 },
    // The deck's X spell, and the two slots above it that paid for the Spiders and the Prey Upons
    // the first time round. It went out and had to come straight back: a token finisher is the
    // only thing this deck does with a flooded hand, and the X-cost test casts two of them.
    { card: SECURE_THE_WASTES, count: 2 },
    // The deck's answer to a board it is behind on, which nothing in the pool could do before.
    { card: DAY_OF_JUDGMENT, count: 1 },
  ],
};

export const TIDAL_MIND: DeckSpec = {
  id: 'tidal-mind',
  name: 'Tidal Mind',
  description: 'Blue-black control. Counter what matters, kill what lands, and win in the air.',
  commander: TALRAND,
  cards: [
    { card: ISLAND, count: 8 },
    { card: SWAMP, count: 8 },
    { card: DIMIR_GUILDGATE, count: 2 },
    { card: LONELY_SANDBAR, count: 2 },
    // A land that answers an attacker every turn and never taps for mana, which is a trade a
    // control deck is happy to make and nothing else in this pool is. It cost an Island, so the
    // deck is on twenty sources rather than twenty-one.
    { card: MAZE_OF_ITH, count: 1 },
    { card: COUNTERSPELL, count: 2 },
    // A third counter that is not a fourth Counterspell: a hand of answers should not be three
    // copies of one card.
    { card: CANCEL, count: 2 },
    { card: NEGATE, count: 1 },
    // The narrow counter, which answers the half of the format the Negates cannot.
    { card: ESSENCE_SCATTER, count: 2 },
    { card: DOOM_BLADE, count: 2 },
    // Removal that does not care what colour it is, which the Doom Blades do.
    { card: MURDER, count: 2 },
    // Not removal but time — and the only card here that answers something already resolved
    // without killing it.
    { card: UNSUMMON, count: 1 },
    { card: ICY_MANIPULATOR, count: 1 },
    // One Crypt rather than two: a second copy of a card that answers one deck in the pool does
    // nothing a first copy had not already done, and the slot is Tome Scour's.
    { card: TORMODS_CRYPT, count: 1 },
    // Five cards off the top for one mana, which is not what this deck is for — it is what makes
    // a Drake for free, and it is the spell Talrand's own test is written against.
    { card: TOME_SCOUR, count: 1 },
    { card: PREORDAIN, count: 2 },
    // One mana that makes a creature untouchable by anybody, its own controller included — the
    // deck's way of protecting a flier it intends to win with, at the cost of never touching it
    // again.
    { card: ROBE_OF_MIRRORS, count: 1 },
    // A 0/2 that blocks anything in the pool for ever and survives it. The deck that loses 0-15 to
    // the fastest red deck has no creature that can stand in front of one twice; this one does it
    // every turn, and it cost the second Robe.
    { card: FOG_BANK, count: 1 },
    { card: JACE_BELEREN, count: 1 },
    { card: OMENSPEAKER, count: 2 },
    { card: PHYREXIAN_ARENA, count: 1 },
    { card: DIVINATION, count: 1 },
    { card: MIND_SPRING, count: 1 },
    { card: EXSANGUINATE, count: 1 },
    { card: SIGN_IN_BLOOD, count: 1 },
    { card: MIND_ROT, count: 1 },
    { card: DIABOLIC_TUTOR, count: 1 },
    { card: SOUL_MANIPULATION, count: 2 },
    { card: RAVENOUS_RATS, count: 2 },
    { card: CHILD_OF_NIGHT, count: 1 },
    { card: WIND_DRAKE, count: 1 },
    { card: MAN_O_WAR, count: 2 },
    { card: VAMPIRE_NIGHTHAWK, count: 1 },
    { card: AIR_ELEMENTAL, count: 1 },
  ],
};

export const ROT_HARVEST: DeckSpec = {
  id: 'rot-harvest',
  name: 'Rot Harvest',
  description: 'Green-black graveyard. Trade creatures freely, then buy them all back.',
  commander: IZONI,
  cards: [
    { card: FOREST, count: 10 },
    { card: SWAMP, count: 11 },
    { card: GOLGARI_GUILDGATE, count: 2 },
    { card: LLANOWAR_ELVES, count: 3 },
    { card: THORNWEALD_ARCHER, count: 1 },
    { card: DRUDGE_SKELETONS, count: 2 },
    { card: GOLGARI_CHARM, count: 2 },
    { card: ENDLESS_ONE, count: 2 },
    { card: BLOOD_ARTIST, count: 3 },
    { card: ZULAPORT_CUTTHROAT, count: 2 },
    { card: DOOMED_DISSENTER, count: 2 },
    { card: WALL_OF_BLOSSOMS, count: 2 },
    { card: FLESHBAG_MARAUDER, count: 2 },
    { card: BLOODTHRONE_VAMPIRE, count: 1 },
    { card: VAMPIRE_ARISTOCRAT, count: 2 },
    { card: GRAVEDIGGER, count: 2 },
    { card: BASILISK_COLLAR, count: 2 },
    { card: RAISE_DEAD, count: 1 },
    { card: GRIM_DISCOVERY, count: 1 },
    { card: ZOMBIFY, count: 1 },
    { card: DOOM_BLADE, count: 1 },
    { card: LOTLETH_GIANT, count: 2 },
    // Green's X spell. It hits its own controller too, which is the card: a deck of ground
    // creatures pays nothing and a table of fliers pays everything.
    { card: HURRICANE, count: 2 },
    // One copy, for the same reason as the Grizzly Bears in Verdant Guard: the graveyard tests
    // build their boards out of this deck and need a plain creature to bury.
    { card: CENTAUR_COURSER, count: 1 },
  ],
};

/**
 * The fifth deck, and the first built out of what the engine learned rather than what it had.
 *
 * Equipment, X tokens, a dual that enters tapped and an aura that draws a card are all things no
 * deck could use six commits ago. Balan is the commander because the card is the archetype: one
 * activation moves every Equipment onto it, which is also the first card that has to *read*
 * another card's script.
 */
export const FORGE_ALLIANCE: DeckSpec = {
  id: 'forge-alliance',
  name: 'Forge Alliance',
  description: 'Red-white equipment. A board of small creatures, and a sword for one of them.',
  commander: BALAN,
  cards: [
    { card: PLAINS, count: 8 },
    { card: MOUNTAIN, count: 8 },
    { card: BOROS_GUILDGATE, count: 3 },
    { card: SECLUDED_STEPPE, count: 2 },
    { card: ELITE_VANGUARD, count: 2 },
    { card: MONASTERY_SWIFTSPEAR, count: 3 },
    { card: DOOMED_TRAVELER, count: 2 },
    { card: LEONIN_SKYHUNTER, count: 2 },
    // A two-drop that wins the fight it is in rather than trading, which is what a board of small
    // creatures is short of — and the first first-striker in the pool.
    { card: YOUTHFUL_KNIGHT, count: 2 },
    { card: FIREBRAND_ARCHER, count: 2 },
    { card: AJANIS_PRIDEMATE, count: 2 },
    { card: SERRA_ANGEL, count: 2 },
    // The card this deck was already built for: every small creature it plays is another damage
    // on the swing, and the tokens from Raise the Alarm and Secure the Wastes count too.
    { card: HELLRIDER, count: 2 },
    { card: BONESPLITTER, count: 2 },
    { card: LOXODON_WARHAMMER, count: 2 },
    // The deck's only answer to an Equipment or an enchantment, which is what a board of swords
    // is most afraid of.
    { card: BANISHING_LIGHT, count: 2 },
    { card: BASILISK_COLLAR, count: 2 },
    // And the Equipment that answers removal rather than adding power: whatever is holding the
    // swords stops dying to a Doom Blade or a Day of Judgment.
    { card: DARKSTEEL_PLATE, count: 1 },
    { card: RAISE_THE_ALARM, count: 2 },
    { card: SECURE_THE_WASTES, count: 1 },
    { card: ANGELIC_GIFT, count: 2 },
    { card: INSPIRED_CHARGE, count: 2 },
    { card: LIGHTNING_BOLT, count: 2 },
    { card: MAGMA_JET, count: 1 },
    { card: FIREBALL, count: 1 },
  ],
};

/**
 * The sixth deck, and the first whose costs are decisions.
 *
 * Every other starter deck pays what is printed in the corner. This one asks three questions a
 * turn: is this land worth two mana and a card, is this Burst Lightning worth four more, is this
 * creature worth more dead than alive. Judith is the commander because she answers the third one
 * for you — every nontoken creature you control is a Shock on the way out, which turns Bone
 * Splinters from removal that costs a creature into removal that kills two.
 */
export const ASHEN_RITE: DeckSpec = {
  id: 'ashen-rite',
  name: 'Ashen Rite',
  description: 'Black-red sacrifice. Every creature is a resource, and every land is a card.',
  commander: JUDITH,
  cards: [
    { card: SWAMP, count: 8 },
    { card: MOUNTAIN, count: 7 },
    { card: RAKDOS_GUILDGATE, count: 2 },
    // Two mana off one tap on turn two is the most-played card in Commander for a reason, and it
    // is the first thing in this pool that makes more mana than it costs to use.
    { card: SOL_RING, count: 1 },
    { card: MIND_STONE, count: 2 },
    // One mana for three, once: the only card in the pool that makes mana from a spell rather
    // than a permanent, and this deck's way to a turn-two Flametongue.
    { card: DARK_RITUAL, count: 2 },
    // The cycling lands are the mana base's own decision: a land early, a card late. Two of each
    // rather than four, because a deck that cycled every land would never cast anything.
    { card: BARREN_MOOR, count: 2 },
    { card: FORGOTTEN_CAVE, count: 2 },
    // Creatures that want to die: a token on the way out, a drain on the way out, or a body that
    // was only ever fuel.
    { card: GOBLIN_ARSONIST, count: 1 },
    { card: DOOMED_DISSENTER, count: 2 },
    // A body one blocker cannot stop, in the deck that is happy either way: it gets through, or it
    // eats two creatures and feeds the drains on the way out.
    { card: BOGGART_BRUTE, count: 2 },
    { card: BLOOD_ARTIST, count: 3 },
    { card: ZULAPORT_CUTTHROAT, count: 2 },
    { card: VAMPIRE_ARISTOCRAT, count: 2 },
    { card: BLOODTHRONE_VAMPIRE, count: 2 },
    { card: FLESHBAG_MARAUDER, count: 1 },
    { card: VAMPIRE_NIGHTHAWK, count: 1 },
    { card: FLAMETONGUE_KAVU, count: 2 },
    { card: GRAVEDIGGER, count: 2 },
    { card: IMPACT_TREMORS, count: 1 },
    // -1/-1 to every creature on the table, which this deck minds least: its own one-power bodies
    // were only ever fuel, and every death is a drain. One copy, because it is a legend and
    // because a second one in a game would do nothing a first one had not already done.
    { card: NIGHT_OF_SOULS_BETRAYAL, count: 1 },
    // And the spells that spend them.
    { card: BONE_SPLINTERS, count: 3 },
    { card: VILLAGE_RITES, count: 1 },
    { card: AGONIZING_DEMISE, count: 2 },
    { card: BURST_LIGHTNING, count: 2 },
    { card: BREATH_OF_DARIGAAZ, count: 1 },
    { card: LIGHTNING_BOLT, count: 1 },
    { card: FAITHLESS_LOOTING, count: 1 },
    // Card advantage paid for in life, which is this deck's whole idea said twice.
    { card: READ_THE_BONES, count: 1 },
  ],
};

/**
 * The seventh deck, and the pairing the pool had never put together.
 *
 * Every counterspell in it was in a deck beside black removal, and every flier but the Drakes was
 * in a green-white deck that wants to attack on the ground. White-blue is what the pool was
 * missing: hold the ground, win in the air, and answer the one spell that matters. It is also the
 * only deck whose plan is *not* to have the best board — the Walls do not attack and the fliers go
 * over whatever is in the way.
 *
 * Hanna is the commander because her ability is the deck said twice: the Pacifism, the Journey and
 * the Mind Stone are all worth drawing again, and she is the first commander in
 * the pool whose text is an activated ability pointing at a card in a graveyard.
 */
export const SKYWARD_WRIT: DeckSpec = {
  id: 'skyward-writ',
  name: 'Skyward Writ',
  description: 'White-blue fliers. Hold the ground, answer the spell that matters, and win in the air.',
  commander: HANNA_SHIPS_NAVIGATOR,
  cards: [
    { card: PLAINS, count: 8 },
    { card: ISLAND, count: 8 },
    { card: AZORIUS_GUILDGATE, count: 3 },
    { card: LONELY_SANDBAR, count: 2 },
    { card: SECLUDED_STEPPE, count: 2 },
    /*
      The ground, which this deck does not intend to win — and which the first version of it lost
      on, 1-9 against both aggro decks over sixty measured games.

      What fixed it was bodies that block rather than more answers: a 1/5 flier that stops anything
      the air can throw and attacks nowhere, a first striker that wins the fight it is in, two
      blockers for two mana at instant speed, and a one-drop that gains a life for every creature
      anybody plays. The answers were never the problem; having nothing alive to answer *with* was.
    */
    { card: SOUL_WARDEN, count: 2 },
    // A one-drop that blocks in the air and gains the life back, which is what the matchups this
    // deck loses actually ask for.
    { card: HEALERS_HAWK, count: 2 },
    { card: YOUTHFUL_KNIGHT, count: 2 },
    { card: OMENSPEAKER, count: 2 },
    { card: WALL_OF_AIR, count: 3 },
    { card: RAISE_THE_ALARM, count: 2 },
    // And the air, which it does intend to win.
    { card: LEONIN_SKYHUNTER, count: 3 },
    { card: WIND_DRAKE, count: 2 },
    { card: MAN_O_WAR, count: 2 },
    { card: AIR_ELEMENTAL, count: 1 },
    { card: SERRA_ANGEL, count: 2 },
    // The answers. Three different counters rather than four of one, because what needs countering
    // changes: Essence Scatter is for the creature decks and Negate for everything else.
    { card: COUNTERSPELL, count: 2 },
    { card: ESSENCE_SCATTER, count: 1 },
    { card: NEGATE, count: 1 },
    { card: UNSUMMON, count: 1 },
    { card: SWORDS_TO_PLOWSHARES, count: 2 },
    { card: PACIFISM, count: 1 },
    { card: JOURNEY_TO_NOWHERE, count: 1 },
    // The deck that loses to a wide board, holding the card that answers a wide board for two
    // mana. The third Swords paid for it: this deck's problem was never the one big creature.
    { card: HOLY_DAY, count: 1 },
    // Four mana that is dead on your own turn and kills anything that attacks into it. The engine
    // will not even offer it outside combat, which is the card.
    { card: DIVINE_VERDICT, count: 2 },
    // Cards, and the two artifacts Hanna is happy to buy back.
    { card: DIVINATION, count: 1 },
    { card: MIND_STONE, count: 1 },
  ],
};

export const STARTER_DECKS: Readonly<Record<string, DeckSpec>> = Object.freeze({
  [EMBER_RUSH.id]: EMBER_RUSH,
  [VERDANT_GUARD.id]: VERDANT_GUARD,
  [TIDAL_MIND.id]: TIDAL_MIND,
  [ROT_HARVEST.id]: ROT_HARVEST,
  [FORGE_ALLIANCE.id]: FORGE_ALLIANCE,
  [ASHEN_RITE.id]: ASHEN_RITE,
  [SKYWARD_WRIT.id]: SKYWARD_WRIT,
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
