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

/**
 * The echo creature you are *meant* to let die, which is why it is the keyword's best first card.
 *
 * Two mana buys two bodies — the Goblin it is and the Goblin it makes — and then asks for two mana
 * again next upkeep. Declining is not a loss: the Marshal dies, makes a *second* token on the way
 * out, and the board is the same two 1/1s it would have been. So the question it asks is a real one
 * rather than a tax with an obvious answer, which is what makes it worth measuring (D214).
 */
const MOGG_WAR_MARSHAL: CardDef = {
  name: 'Mogg War Marshal',
  typeLine: 'Creature — Goblin Warrior',
  manaCost: '{1}{R}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Echo {1}{R} (At the beginning of your upkeep, if this came under your control since your last upkeep, sacrifice it unless you pay its echo cost.)\nWhen Mogg War Marshal enters the battlefield or dies, create a 1/1 red Goblin creature token.',
  colors: ['R'],
};

/**
 * And the echo creature you pay for: a Rampant Growth that leaves a body behind.
 *
 * The land is already in play by the time the upkeep comes round, so the three mana are spent
 * whatever the answer is — the question is only whether the 2/2 is worth two more. In a deck that
 * ramps, it usually is, which makes this the opposite half of the pair the Marshal starts.
 */
const YAVIMAYA_GRANGER: CardDef = {
  name: 'Yavimaya Granger',
  typeLine: 'Creature — Elf Scout',
  manaCost: '{2}{G}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Echo {2}{G} (At the beginning of your upkeep, if this came under your control since your last upkeep, sacrifice it unless you pay its echo cost.)\nWhen Yavimaya Granger enters the battlefield, search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
  colors: ['G'],
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

/**
 * Crimson Wisps: the colour-changing layer's one card.
 *
 * A cantrip with haste on it, and a clause that in this pool only Paladin en-Vec's protection ever
 * reads. In it for the layer rather than for the deck, and the deck measurement below says what
 * the slot cost.
 */
const CRIMSON_WISPS: CardDef = {
  name: 'Crimson Wisps',
  typeLine: 'Sorcery',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Target creature gains haste until end of turn and becomes red.\nDraw a card.',
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

/**
 * Blade of Selves: the pool's first **myriad**, and a card that is blank in a duel.
 *
 * "Equipped creature has myriad" — whenever it attacks, for each opponent other than the one it is
 * attacking, a token copy of it arrives tapped and attacking that player, and the tokens are exiled
 * at end of combat (CR 702.111a). With one opponent there is never an opponent other than the
 * defending player, so across every two-player table in this pool it is three mana and an equip
 * cost for nothing at all.
 *
 * That is the reason it is here. Every other keyword in this engine is worth something in a duel,
 * and a pod has had no card whose value is a fact about the **number of people at the table** — the
 * monarch is a rule rather than a card, goad points at somebody else but works with one opponent,
 * and the deals and the politics tallies are information rather than text. This is the first card
 * whose rules text reads differently at four seats, which is what makes it worth the engine work:
 * myriad is the only keyword in `KEYWORDS` the engine *acts on*, because an Equipment granting it
 * cannot be a card's triggered ability.
 *
 * On an Equipment rather than on a creature on purpose. It is the version of myriad that can go on
 * the biggest body available rather than being stuck on one, which is the whole of what makes the
 * keyword frightening at a real table, and it is a card I can put in a deck that already runs four
 * Equipment and knows how to equip them.
 */
const BLADE_OF_SELVES: CardDef = {
  name: 'Blade of Selves',
  typeLine: 'Artifact — Equipment',
  manaCost: '{3}',
  cmc: 3,
  oracleText: 'Equipped creature has myriad. (Whenever this creature attacks, for each opponent '
    + 'other than defending player, you may create a token that\u2019s a copy of this creature '
    + 'that\u2019s tapped and attacking that player or a planeswalker they control. Exile those '
    + 'tokens at end of combat.)\nEquip {3}',
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

/*
  The two cards with ward, which is the one evergreen keyword the engine did not have.

  Both are printed with magecraft as well, and both halves are scripted: ward is a triggered
  ability that asks the *other* player for mana (CR 702.21b), and magecraft is the `spell-cast`
  trigger the engine already had for Talrand. The "or copy" half of magecraft is not scripted,
  because nothing in this pool copies an instant — said out loud in `scripts.ts` rather than
  quietly approximated.
*/
const DRAGONSGUARD_ELITE: CardDef = {
  name: 'Dragonsguard Elite',
  typeLine: 'Creature — Human Wizard',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Ward {1}\nMagecraft — Whenever you cast or copy an instant or sorcery spell, put two +1/+1 counters on Dragonsguard Elite.',
  colors: ['G'],
};

const SEDGEMOOR_WITCH: CardDef = {
  name: 'Sedgemoor Witch',
  typeLine: 'Creature — Human Warlock',
  manaCost: '{2}{B}{B}',
  cmc: 4,
  power: '3',
  toughness: '2',
  oracleText: "Menace, ward {3}\nMagecraft — Whenever you cast or copy an instant or sorcery spell, create a 1/1 black Pest creature token with \"When this creature dies, you gain 1 life.\"",
  colors: ['B'],
};

/*
  The two convoke cards (CR 702.51), both Selesnya, both in the Selesnya deck.

  Convoke is only a discount if there is a board to tap, so it belongs in the deck that makes
  creatures and nowhere else in this pool. Printed cost is what these say; what they actually cost
  is four lands and three creatures, or two lands and three creatures.
*/
const SIEGE_WURM: CardDef = {
  name: 'Siege Wurm',
  typeLine: 'Creature — Wurm',
  manaCost: '{5}{G}{G}',
  cmc: 7,
  power: '5',
  toughness: '5',
  oracleText: 'Convoke\nTrample',
  colors: ['G'],
};

/*
  Morph: three cards, one per half of what the mechanic is for (CR 702.37).

  All three are cast the same way — {3}, face down, a 2/2 with no name — and what separates them is
  what turning them up is *worth*, which is the only decision morph asks a player to make.

  Zoetic Cavern is the one that proves the rule rather than using it: a **land** that can be cast as
  a creature spell, which is legal because morph does not care what the card is (CR 702.37a) and
  because a face-down permanent is a 2/2 with no types of its own. A land when the hand is short of
  them and a body when it is not, out of the deck whose documented problem is having nothing to do
  with its twenty-second land.

  Dirgur Nemesis is the one you turn up to *survive*: a 2/2 holding two damage from combat becomes a
  2/6 and lives, because turning face up is not a new object and the damage stays where it was.

  Battering Craghorn is the one you turn up *during* combat. First strike on a 3/1, for {4}{R},
  after blockers are declared and with nothing an opponent can do about it — which is what makes
  morph a special action rather than an ability.
*/
const ZOETIC_CAVERN: CardDef = {
  name: 'Zoetic Cavern',
  typeLine: 'Land',
  manaCost: '',
  cmc: 0,
  oracleText: '{T}: Add {C}.\nMorph {2}',
  colors: [],
};

const DIRGUR_NEMESIS: CardDef = {
  name: 'Dirgur Nemesis',
  typeLine: 'Creature — Serpent',
  manaCost: '{4}{U}',
  cmc: 5,
  power: '2',
  toughness: '6',
  oracleText: 'Defender\nMorph {5}{U}',
  colors: ['U'],
};

const BATTERING_CRAGHORN: CardDef = {
  name: 'Battering Craghorn',
  typeLine: 'Creature — Goat Beast',
  manaCost: '{2}{R}{R}',
  cmc: 4,
  power: '3',
  toughness: '1',
  oracleText: 'First strike\nMorph {4}{R}',
  colors: ['R'],
};

/*
  The two morphs with text on the back, which is what the turned-face-up trigger is for.

  Three cards already prove the mechanic with keywords alone, and these two prove the other half of
  it: a morph is a card you hold *because* of what turning it up does. Ainok Survivalist is the
  answer you did not have to telegraph — a 2/2 on turn three that is removal on any later turn, with
  no window for the artifact's controller to do anything about it. Master of Pearls is the one that
  wins a combat out of nowhere: six creatures attack into a board that can block two of them, and
  the whole team is suddenly two bigger.
*/
const AINOK_SURVIVALIST: CardDef = {
  name: 'Ainok Survivalist',
  typeLine: 'Creature — Hound Shaman',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Morph {1}{G}\nWhen Ainok Survivalist is turned face up, destroy target artifact or enchantment an opponent controls.',
  colors: ['G'],
};

const MASTER_OF_PEARLS: CardDef = {
  name: 'Master of Pearls',
  typeLine: 'Creature — Human Monk',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Morph {2}{W}{W}\nWhen Master of Pearls is turned face up, creatures you control get +2/+2 until end of turn.',
  colors: ['W'],
};

/*
  Three Vehicles, and the first card type in this pool that is not a creature, a land, an
  instant, a sorcery, an enchantment, an artifact or a planeswalker.

  A Vehicle is an artifact that is **not a creature at all** until somebody crews it, which is the
  whole card: it survives a Day of Judgment sitting on the battlefield, it cannot be hit by a Doom
  Blade, and it cannot attack or block either. The trade is that its body is far above its cost,
  and the cost of using it is creatures tapped out of the combat it is joining.

  Three of them because the number on the crew is the card. Sky Skiff asks for one power and gets a
  2/3 flier out of it, which is almost free. Renegade Freighter asks for two and hits like a 5/4
  with trample. Consulate Dreadnought is a **7/11 for one mana** and asks for four power, which on
  most boards is every creature its controller has — a card that is either unplayable or the
  biggest thing anybody has seen, with nothing in between.
*/
const SKY_SKIFF: CardDef = {
  name: 'Sky Skiff',
  typeLine: 'Artifact — Vehicle',
  manaCost: '{2}',
  cmc: 2,
  power: '2',
  toughness: '3',
  oracleText: 'Flying\nCrew 1',
  colors: [],
};

const RENEGADE_FREIGHTER: CardDef = {
  name: 'Renegade Freighter',
  typeLine: 'Artifact — Vehicle',
  manaCost: '{3}',
  cmc: 3,
  power: '4',
  toughness: '3',
  oracleText: 'Whenever Renegade Freighter attacks, it gets +1/+1 and gains trample until end of turn.\nCrew 2',
  colors: [],
};

const CONSULATE_DREADNOUGHT: CardDef = {
  name: 'Consulate Dreadnought',
  typeLine: 'Artifact — Vehicle',
  manaCost: '{1}',
  cmc: 1,
  power: '7',
  toughness: '11',
  oracleText: 'Crew 4',
  colors: [],
};

/*
  Two Sagas, which are enchantments that read themselves out over three turns and then go away.

  The type line is where most of a Saga lives: an enchantment, so nothing that kills creatures or
  artifacts touches it, and its chapters happen whether or not its controller has mana or a board.
  What it costs is time — three turns to get all of it, and the opponent can see every turn of it
  coming.

  The Birth of Meletis is a one-and-a-half-mana wall, two life and a land for a deck that wants to
  reach its fliers. The Eldest Reborn is six mana of grinding: a sacrifice, a discard, and a
  creature back out of **any** graveyard, which is the first card in this pool that can use a pile
  its own mill spells filled.
*/
const THE_BIRTH_OF_MELETIS: CardDef = {
  name: 'The Birth of Meletis',
  typeLine: 'Enchantment — Saga',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText: 'I — Create a 0/4 white Wall creature token with defender.\nII — You gain 2 life.\nIII — Search your library for a Plains card, put it onto the battlefield tapped, then shuffle.',
  colors: ['W'],
};

const THE_ELDEST_REBORN: CardDef = {
  name: 'The Eldest Reborn',
  typeLine: 'Enchantment — Saga',
  manaCost: '{4}{B}{B}',
  cmc: 6,
  oracleText: 'I — Each opponent sacrifices a creature.\nII — Each opponent discards a card.\nIII — Return target creature card from a graveyard to the battlefield under your control.',
  colors: ['B'],
};

/*
  The two foretell cards: pay {2} now to hide a card in exile, cast it later for less.

  Foretell is the one mechanic in Magic that is explicitly about holding up mana, which is this
  pool's hardest problem — Tidal Mind's whole plan is to keep two mana for an answer and its
  documented record says the computer cannot do it. Both cards are in that deck, so one measurement
  covers the mechanic.

  What a person gets out of it and the computer does not: an opponent sees a face-down card in exile
  and knows only that there is one.
*/
const BEHOLD_THE_MULTIVERSE: CardDef = {
  name: 'Behold the Multiverse',
  typeLine: 'Instant',
  manaCost: '{3}{U}',
  cmc: 4,
  oracleText: 'Scry 2, then draw two cards.\nForetell {1}{U}',
  colors: ['U'],
};

const SAW_IT_COMING: CardDef = {
  name: 'Saw It Coming',
  typeLine: 'Instant',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  oracleText: 'Counter target spell.\nForetell {U}{U}',
  colors: ['U'],
};

const CONCLAVE_TRIBUNAL: CardDef = {
  name: 'Conclave Tribunal',
  typeLine: 'Enchantment',
  manaCost: '{3}{W}{W}',
  cmc: 5,
  oracleText: 'Convoke\nWhen Conclave Tribunal enters the battlefield, exile target nonland permanent an opponent controls until Conclave Tribunal leaves the battlefield.',
  colors: ['W'],
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

const MARDU_SCOUT: CardDef = {
  name: 'Mardu Scout',
  typeLine: 'Creature — Human Scout',
  manaCost: '{1}{R}',
  cmc: 2,
  power: '3',
  toughness: '1',
  oracleText: 'Dash {R}',
  colors: ['R'],
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

/**
 * Lhurgoyf, whose size is a fact about the table.
 *
 * Printed `*` and `1+*`, which `numeric` reads as zero — correct, because the number does not come
 * from the card: layer 7a counts the creature cards in every graveyard on every read. In Rot
 * Harvest, a deck that sacrifices its own creatures to drain, that number only goes up.
 */
const LHURGOYF: CardDef = {
  name: 'Lhurgoyf',
  typeLine: 'Creature — Lhurgoyf',
  manaCost: '{3}{G}',
  cmc: 4,
  power: '*',
  toughness: '1+*',
  oracleText:
    "Lhurgoyf's power is equal to the number of creature cards in all graveyards and its toughness "
    + 'is equal to that number plus 1.',
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

/**
 * The pool's first **vanishing** card: five power for four mana, on a clock both players can read.
 *
 * Shroud is the half that makes the clock matter. Every removal spell in this pool targets, so a
 * Calciderm cannot be answered by any of them — the three turns it gets are the three turns the
 * opponent has to find a blocker, a sweeper or a race. Take the shroud away and the keyword is a
 * drawback on a card that was going to die anyway.
 *
 * The time counters come from `entersWith` and the clock from the script's trigger. See
 * `CardScript.vanishing`.
 */
const CALCIDERM: CardDef = {
  name: 'Calciderm',
  typeLine: 'Creature \u2014 Beast',
  manaCost: '{3}{W}',
  cmc: 4,
  power: '5',
  toughness: '5',
  oracleText: 'Shroud\nVanishing 4 (This permanent enters the battlefield with four time counters on it. At the beginning of your upkeep, remove a time counter from it. When the last is removed, sacrifice it.)',
  colors: ['W'],
};

/**
 * The same creature in green, a mana cheaper, with the number printed one lower.
 *
 * Fading 3 and vanishing 4 both hand their controller **three** turns of a 5/5 with shroud, because
 * fading sacrifices when a counter cannot be removed and vanishing when the last one is. Two cards
 * that read differently and play identically, which is the whole reason the second keyword exists.
 * Pinned as a test rather than left as a claim — see `fadingTrigger`.
 */
const BLASTODERM: CardDef = {
  name: 'Blastoderm',
  typeLine: 'Creature \u2014 Beast',
  manaCost: '{2}{G}{G}',
  cmc: 4,
  power: '5',
  toughness: '5',
  oracleText: 'Shroud\nFading 3 (This creature enters the battlefield with three fade counters on it. At the beginning of your upkeep, remove a fade counter from it. If you can\u2019t, sacrifice it.)',
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

const DREGSCAPE_ZOMBIE: CardDef = {
  name: 'Dregscape Zombie',
  typeLine: 'Creature — Zombie Warrior',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Unearth {B} ({B}: Return this card from your graveyard to the battlefield. It gains '
    + 'haste. Exile it at the beginning of the next end step or if it would leave the battlefield. '
    + 'Activate only as a sorcery.)',
  colors: ['B'],
};

const HELLSPARK_ELEMENTAL: CardDef = {
  name: 'Hellspark Elemental',
  typeLine: 'Creature — Elemental',
  manaCost: '{1}{R}',
  cmc: 2,
  power: '3',
  toughness: '1',
  oracleText: 'Trample, haste\nAt the beginning of the end step, sacrifice Hellspark Elemental.\n'
    + 'Unearth {1}{R} ({1}{R}: Return this card from your graveyard to the battlefield. It gains '
    + 'haste. Exile it at the beginning of the next end step or if it would leave the battlefield. '
    + 'Activate only as a sorcery.)',
  colors: ['R'],
};

const FLEECEMANE_LION: CardDef = {
  name: 'Fleecemane Lion',
  typeLine: 'Creature — Cat Hydra',
  manaCost: '{G}{W}',
  cmc: 2,
  power: '3',
  toughness: '3',
  oracleText: '{2}{G}{W}: Monstrosity 1. (If this creature isn\u2019t monstrous, put a +1/+1 counter on '
    + 'it and it becomes monstrous.)\nAs long as Fleecemane Lion is monstrous, it has hexproof and '
    + 'indestructible.',
  colors: ['G', 'W'],
};

const AEROMUNCULUS: CardDef = {
  name: 'Aeromunculus',
  typeLine: 'Creature — Homunculus Mutant',
  manaCost: '{1}{G}{U}',
  cmc: 3,
  power: '2',
  toughness: '3',
  oracleText: 'Flying\n{2}{G}{U}: Adapt 3. (If this creature has no +1/+1 counters on it, put three '
    + '+1/+1 counters on it.)',
  colors: ['G', 'U'],
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

/**
 * The pool's first **ninjutsu** card, and the only creature here that arrives mid-combat.
 *
 * A 2/2 for two that is never cast on turn two: it waits in hand until a creature gets through
 * unblocked, then takes that creature's place on the attack, already tapped and already attacking,
 * after the defending player has decided not to block. The creature it replaced goes back to its
 * owner's hand, which is the half that makes the trade good rather than even — you keep both cards.
 *
 * In Skyward Writ, because ninjutsu needs an unblocked attacker and that deck's whole plan is
 * fliers nobody can block. See `CardScript.ninjutsu`.
 */
const NINJA_OF_THE_DEEP_HOURS: CardDef = {
  name: 'Ninja of the Deep Hours',
  typeLine: 'Creature \u2014 Human Ninja',
  manaCost: '{1}{U}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Ninjutsu {1}{U} ({1}{U}, Return an unblocked attacker you control to hand: Put this card onto the battlefield from your hand tapped and attacking.)\nWhenever Ninja of the Deep Hours deals combat damage to a player, draw a card.',
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

/*
  Hollow Tide's own cards: the library as the thing you attack.

  Everything else in the pool measures a game in life totals. These measure it in cards, which the
  engine has always been able to end a game over — a player who cannot draw has lost (CR 704.5b) —
  and which nothing until now has ever tried to do on purpose.
*/

const CLONE: CardDef = {
  name: 'Clone',
  typeLine: 'Creature \u2014 Shapeshifter',
  manaCost: '{3}{U}',
  cmc: 4,
  power: '0',
  toughness: '0',
  oracleText: 'You may have Clone enter the battlefield as a copy of any creature on the battlefield.',
  colors: ['U'],
};

const TURN_TO_FROG: CardDef = {
  name: 'Turn to Frog',
  typeLine: 'Instant',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Target creature loses all abilities and becomes 1/1 until end of turn.',
  colors: ['U'],
};

const CACKLING_COUNTERPART: CardDef = {
  name: 'Cackling Counterpart',
  typeLine: 'Instant',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  oracleText: "Create a token that's a copy of target creature you control.",
  colors: ['U'],
};

const MIRKO_VOSK: CardDef = {
  name: 'Mirko Vosk, Mind Drinker',
  typeLine: 'Legendary Creature \u2014 Vampire',
  manaCost: '{2}{U}{B}',
  cmc: 4,
  power: '2',
  toughness: '4',
  oracleText: 'Flying\nWhenever Mirko Vosk, Mind Drinker deals combat damage to a player, that player mills until they reveal four land cards.',
  colors: ['U', 'B'],
};

const CHASM_SKULKER: CardDef = {
  name: 'Chasm Skulker',
  typeLine: 'Creature — Squid Horror',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  power: '1',
  toughness: '1',
  oracleText: 'Whenever you draw a card, put a +1/+1 counter on Chasm Skulker.\n'
    + 'When Chasm Skulker dies, create X 1/1 blue Squid creature tokens with islandwalk, where X is '
    + 'the number of +1/+1 counters on Chasm Skulker.',
  colors: ['U'],
};

const THIEVING_MAGPIE: CardDef = {
  name: 'Thieving Magpie',
  typeLine: 'Creature \u2014 Bird',
  manaCost: '{2}{U}{U}',
  cmc: 4,
  power: '1',
  toughness: '3',
  oracleText: 'Flying\nWhenever Thieving Magpie deals combat damage to a player, draw a card.',
  colors: ['U'],
};

const MIND_SCULPT: CardDef = {
  name: 'Mind Sculpt',
  typeLine: 'Sorcery',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Target player mills seven cards.',
  colors: ['U'],
};

const THOUGHT_SCOUR: CardDef = {
  name: 'Thought Scour',
  typeLine: 'Instant',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'Target player mills two cards. Draw a card.',
  colors: ['U'],
};

const COMPELLING_ARGUMENT: CardDef = {
  name: 'Compelling Argument',
  typeLine: 'Sorcery',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Target player mills three cards.\nCycling {U} ({U}, Discard this card: Draw a card.)',
  colors: ['U'],
};

const RETURNED_CENTAUR: CardDef = {
  name: 'Returned Centaur',
  typeLine: 'Creature \u2014 Zombie Centaur',
  manaCost: '{3}{U}',
  cmc: 4,
  power: '2',
  toughness: '4',
  oracleText: 'When Returned Centaur enters the battlefield, target player mills four cards.',
  colors: ['U'],
};

const NEMESIS_OF_REASON: CardDef = {
  name: 'Nemesis of Reason',
  typeLine: 'Creature \u2014 Leviathan Horror',
  manaCost: '{4}{U}{B}',
  cmc: 6,
  power: '3',
  toughness: '7',
  oracleText: 'Whenever Nemesis of Reason attacks, defending player mills ten cards.',
  colors: ['U', 'B'],
};

const PSYCHIC_STRIKE: CardDef = {
  name: 'Psychic Strike',
  typeLine: 'Instant',
  manaCost: '{1}{U}{B}',
  cmc: 3,
  oracleText: "Counter target spell. Its controller mills two cards.",
  colors: ['U', 'B'],
};

const JACE_MEMORY_ADEPT: CardDef = {
  name: 'Jace, Memory Adept',
  typeLine: 'Legendary Planeswalker \u2014 Jace',
  manaCost: '{3}{U}{U}',
  cmc: 5,
  loyalty: '4',
  oracleText: '+1: Target player mills ten cards.\n0: Draw a card.',
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

/*
  Bloodthirsty Aerialist, declared here rather than with Dawn Tithe's own cards.

  It was written for the tenth deck, where every third card gains life; it is read here too, by
  the deck below, because three Vampire Nighthawks and an Exsanguinate are also lifegain and a
  2/2 flier that grows off them is the cheapest clock these colours have. The declaration moved
  up the file because a `const` is only in scope after its own line: `TIDAL_MIND` is built two
  thousand lines before Dawn Tithe's section, and referring to it from there threw at import.
*/

const BLOODTHIRSTY_AERIALIST: CardDef = {
  name: 'Bloodthirsty Aerialist',
  typeLine: 'Creature \u2014 Vampire Soldier',
  manaCost: '{2}{B}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Flying\nWhenever you gain life, put a +1/+1 counter on Bloodthirsty Aerialist.',
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

/**
 * The pool's first printed **0/0**, and its first **modular** card (CR 702.43).
 *
 * Those two facts are one fact: a modular creature enters with its counters and is alive only
 * because of them, so the printed 0/0 is not a typo on the card and not a special case in the
 * engine — `entersWith` puts a +1/+1 on it and the layer system does the rest. Take the counter off
 * and it dies, which is what makes a Contagion Clasp's −1/−1 lethal to it.
 *
 * What it buys for a mana is a body that never quite trades: block with it, let it die, and its
 * counter lands on something bigger.
 */
const ARCBOUND_WORKER: CardDef = {
  name: 'Arcbound Worker',
  typeLine: 'Artifact Creature \u2014 Construct',
  manaCost: '{1}',
  cmc: 1,
  power: '0',
  toughness: '0',
  oracleText: 'Modular 1 (This creature enters the battlefield with a +1/+1 counter on it. When it dies, you may put its +1/+1 counters on target artifact creature.)',
  colors: [],
};

/**
 * The sink the artifact deck has never had: an artifact that eats artifacts.
 *
 * Modular 1 on a two-mana 0/0, plus the pool's first cost that spends an **artifact** — after
 * twenty-odd of them with nothing able to pay with one. Every Equipment that has done its job, every
 * Vehicle nobody is crewing and every spent mana rock is now a +1/+1 counter, and when the Ravager
 * finally dies those counters move on. See `AbilityCost.sacrifice`.
 */
const ARCBOUND_RAVAGER: CardDef = {
  name: 'Arcbound Ravager',
  typeLine: 'Artifact Creature \u2014 Beast',
  manaCost: '{2}',
  cmc: 2,
  power: '0',
  toughness: '0',
  oracleText: 'Sacrifice an artifact: Put a +1/+1 counter on Arcbound Ravager.\nModular 1 (This creature enters the battlefield with a +1/+1 counter on it. When it dies, you may put its +1/+1 counters on target artifact creature.)',
  colors: [],
};

/*
  The card D222 asked for by name: an artifact that **pays you for leaving**.

  Every other non-creature artifact in this pool is Equipment, a Vehicle, a mana source, a standing
  answer or an anthem — five kinds of thing you would rather keep, which is why the Arcbound Ravager's
  "Sacrifice an artifact" had nothing to eat that was not a downgrade. This is the sixth kind, and the
  only one whose text is entirely about going: it draws on the way in and again on the way out, so
  sacrificing it costs a permanent that was doing nothing and pays a card for the privilege.
*/
const ICHOR_WELLSPRING: CardDef = {
  name: 'Ichor Wellspring',
  typeLine: 'Artifact',
  manaCost: '{2}',
  cmc: 2,
  oracleText: 'When Ichor Wellspring enters the battlefield or is put into a graveyard from the battlefield, draw a card.',
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

const WALKING_BALLISTA: CardDef = {
  name: 'Walking Ballista',
  typeLine: 'Artifact Creature — Construct',
  manaCost: '{X}{X}',
  cmc: 0,
  power: '0',
  toughness: '0',
  oracleText: 'Walking Ballista enters the battlefield with X +1/+1 counters on it. '
    + '{1}: Put a +1/+1 counter on Walking Ballista. '
    + 'Remove a +1/+1 counter from Walking Ballista: It deals 1 damage to any target.',
  colors: [],
};

const HANGARBACK_WALKER: CardDef = {
  name: 'Hangarback Walker',
  typeLine: 'Artifact Creature — Construct',
  manaCost: '{X}{X}',
  cmc: 0,
  power: '0',
  toughness: '0',
  oracleText: 'Hangarback Walker enters the battlefield with X +1/+1 counters on it. '
    + 'When Hangarback Walker dies, create a 1/1 colorless Thopter artifact creature token with '
    + 'flying for each +1/+1 counter on it. '
    + '{1}, {T}: Put a +1/+1 counter on Hangarback Walker.',
  colors: [],
};

const TORMENTED_SOUL: CardDef = {
  name: 'Tormented Soul',
  typeLine: 'Creature — Human Warrior',
  manaCost: '{B}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: "Tormented Soul can't block and can't be blocked.",
  colors: ['B'],
};

const RIVER_BOA: CardDef = {
  name: 'River Boa',
  typeLine: 'Creature — Snake',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Islandwalk\n{G}: Regenerate River Boa.',
  colors: ['G'],
};

const WALL_OF_FROST: CardDef = {
  name: 'Wall of Frost',
  typeLine: 'Creature — Wall',
  manaCost: '{2}{U}',
  cmc: 3,
  power: '0',
  toughness: '7',
  oracleText: 'Defender\nWhenever Wall of Frost blocks a creature, that creature doesn\u2019t untap '
    + "during its controller's next untap step.",
  colors: ['U'],
};

const OPHIDIAN: CardDef = {
  name: 'Ophidian',
  typeLine: 'Creature — Serpent',
  manaCost: '{2}{U}',
  cmc: 3,
  power: '1',
  toughness: '3',
  oracleText: "Whenever Ophidian attacks and isn't blocked, you may draw a card. If you do, "
    + 'remove Ophidian from combat.',
  colors: ['U'],
};

const THICKET_BASILISK: CardDef = {
  name: 'Thicket Basilisk',
  typeLine: 'Creature — Basilisk',
  manaCost: '{3}{G}{G}',
  cmc: 5,
  power: '2',
  toughness: '4',
  oracleText: 'Whenever Thicket Basilisk blocks or becomes blocked by a creature, destroy that '
    + 'creature at end of combat.',
  colors: ['G'],
};

const FLICKERWISP: CardDef = {
  name: 'Flickerwisp',
  typeLine: 'Creature — Elemental',
  manaCost: '{1}{W}{W}',
  cmc: 3,
  power: '3',
  toughness: '1',
  oracleText: 'Flying\nWhen Flickerwisp enters the battlefield, exile another target permanent. '
    + "Return it to the battlefield under its owner's control at the beginning of the next end step.",
  colors: ['W'],
};

const PALACE_SENTINELS: CardDef = {
  name: 'Palace Sentinels',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{3}{W}',
  cmc: 4,
  power: '2',
  toughness: '3',
  oracleText: 'When Palace Sentinels enters the battlefield, you become the monarch.',
  colors: ['W'],
};

const FATE_UNRAVELER: CardDef = {
  name: 'Fate Unraveler',
  typeLine: 'Creature — Elder',
  manaCost: '{3}{B}',
  cmc: 4,
  power: '2',
  toughness: '4',
  oracleText: 'Whenever an opponent draws a card, Fate Unraveler deals 1 damage to that player.',
  colors: ['B'],
};

const THORN_OF_THE_BLACK_ROSE: CardDef = {
  name: 'Thorn of the Black Rose',
  typeLine: 'Creature — Human Assassin',
  manaCost: '{2}{B}{B}',
  cmc: 4,
  power: '2',
  toughness: '3',
  oracleText: 'Deathtouch\nWhen Thorn of the Black Rose enters the battlefield, you become the monarch.',
  colors: ['B'],
};

const YOUNG_WOLF: CardDef = {
  name: 'Young Wolf',
  typeLine: 'Creature — Wolf',
  manaCost: '{G}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'Undying (When this creature dies, if it had no +1/+1 counter on it, return it to the '
    + 'battlefield under its owner\u2019s control with a +1/+1 counter on it.)',
  colors: ['G'],
};

const BUTCHER_GHOUL: CardDef = {
  name: 'Butcher Ghoul',
  typeLine: 'Creature — Zombie',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Undying (When this creature dies, if it had no +1/+1 counter on it, return it to the '
    + 'battlefield under its owner\u2019s control with a +1/+1 counter on it.)',
  colors: ['B'],
};

const MURDEROUS_REDCAP: CardDef = {
  name: 'Murderous Redcap',
  typeLine: 'Creature — Goblin Assassin',
  /*
    `{2}{B/R}{B/R}`, which is what is printed on it — and for five entries it was in this pool as
    `{2}{B}{R}`, because the engine refused a hybrid symbol outright rather than mis-reading it.

    The approximation is strictly harsher than the card: the real Redcap is castable off four
    Swamps, and the pool's copy demanded one of each colour. In a deck with seven Swamps, seven
    Mountains and five other sources that is a real difference on turn four, and it is the kind of
    deviation that is invisible until somebody holds the card with the wrong three lands out (D190).
  */
  manaCost: '{2}{B/R}{B/R}',
  cmc: 4,
  power: '1',
  toughness: '1',
  oracleText: 'When Murderous Redcap enters the battlefield, it deals damage equal to its power to '
    + 'any target.\nPersist (When this creature dies, if it had no -1/-1 counter on it, return it to '
    + 'the battlefield under its owner\u2019s control with a -1/-1 counter on it.)',
  colors: ['B', 'R'],
};

const GLISTENER_ELF: CardDef = {
  name: 'Glistener Elf',
  typeLine: 'Creature — Elf Warrior',
  manaCost: '{G}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'Infect',
  colors: ['G'],
};

const PLAGUE_STINGER: CardDef = {
  name: 'Plague Stinger',
  typeLine: 'Artifact Creature — Insect',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Flying, infect',
  colors: ['B'],
};

const ICHORCLAW_MYR: CardDef = {
  name: 'Ichorclaw Myr',
  typeLine: 'Artifact Creature — Myr',
  manaCost: '{2}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Infect\nWhenever Ichorclaw Myr becomes blocked, it gets +2/+2 until end of turn.',
  colors: [],
};

const BLIGHT_MAMBA: CardDef = {
  name: 'Blight Mamba',
  typeLine: 'Creature — Phyrexian Snake',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Infect\n{G}: Regenerate Blight Mamba.',
  colors: ['G'],
};

const CYSTBEARER: CardDef = {
  name: 'Cystbearer',
  typeLine: 'Creature — Phyrexian Beast',
  manaCost: '{2}{G}',
  cmc: 3,
  power: '2',
  toughness: '3',
  oracleText: 'Infect',
  colors: ['G'],
};

const PHYREXIAN_CRUSADER: CardDef = {
  name: 'Phyrexian Crusader',
  typeLine: 'Creature — Phyrexian Zombie Knight',
  manaCost: '{1}{B}{B}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'First strike, protection from red, protection from white, infect',
  colors: ['B'],
};

const TAINTED_STRIKE: CardDef = {
  name: 'Tainted Strike',
  typeLine: 'Instant',
  manaCost: '{B}',
  cmc: 1,
  oracleText: 'Target creature gets +1/+0 and gains infect until end of turn.',
  colors: ['B'],
};

const SKITHIRYX: CardDef = {
  name: 'Skithiryx, the Blight Dragon',
  typeLine: 'Legendary Creature — Phyrexian Dragon Skeleton',
  manaCost: '{3}{B}{B}',
  cmc: 5,
  power: '4',
  toughness: '4',
  oracleText: 'Flying, infect\n{B}: Skithiryx, the Blight Dragon gains haste until end of turn.\n'
    + '{B}{B}: Regenerate Skithiryx, the Blight Dragon.',
  colors: ['B'],
};

const GOBLIN_ELECTROMANCER: CardDef = {
  name: 'Goblin Electromancer',
  typeLine: 'Creature — Goblin Wizard',
  manaCost: '{U}{R}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.',
  colors: ['U', 'R'],
};

const THALIA_GUARDIAN_OF_THRABEN: CardDef = {
  name: 'Thalia, Guardian of Thraben',
  typeLine: 'Legendary Creature — Human Soldier',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'First strike\nNoncreature spells cost {1} more to cast.',
  colors: ['W'],
};

const AETHER_HUB: CardDef = {
  name: 'Aether Hub',
  typeLine: 'Land',
  manaCost: '',
  cmc: 0,
  oracleText: 'When Aether Hub enters the battlefield, you get {E} (an energy counter).\n'
    + '{T}: Add {C}.\n'
    + '{T}, Pay {E}: Add one mana of any color.',
  colors: [],
};

const LONGTUSK_CUB: CardDef = {
  name: 'Longtusk Cub',
  typeLine: 'Creature — Cat Beast',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Whenever Longtusk Cub deals combat damage to a player, you get {E}{E}.\n'
    + 'Pay {E}{E}: Put a +1/+1 counter on Longtusk Cub.',
  colors: ['G'],
};

const BRISTLING_HYDRA: CardDef = {
  name: 'Bristling Hydra',
  typeLine: 'Creature — Hydra',
  manaCost: '{2}{G}{G}',
  cmc: 4,
  power: '4',
  toughness: '3',
  oracleText: 'When Bristling Hydra enters the battlefield, you get {E}{E}{E}.\n'
    + 'Pay {E}{E}{E}: Put a +1/+1 counter on Bristling Hydra. It gains hexproof until end of turn.',
  colors: ['G'],
};

const HARNESSED_LIGHTNING: CardDef = {
  name: 'Harnessed Lightning',
  typeLine: 'Instant',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Choose target creature. You get {E}{E}{E}, then you may pay any amount of {E}. '
    + 'Harnessed Lightning deals that much damage to that creature.',
  colors: ['R'],
};

const MIZZIUM_MORTARS: CardDef = {
  name: 'Mizzium Mortars',
  typeLine: 'Sorcery',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: "Mizzium Mortars deals 4 damage to target creature you don't control.\n"
    + 'Overload {3}{R}{R}{R} (You may cast this spell for its overload cost. If you do, change each '
    + 'instance of "target" to "each.")',
  colors: ['R'],
};

const SKEWER_THE_CRITICS: CardDef = {
  name: 'Skewer the Critics',
  typeLine: 'Sorcery',
  manaCost: '{2}{R}',
  cmc: 3,
  oracleText: 'Spectacle {R}\nSkewer the Critics deals 3 damage to any target.',
  colors: ['R'],
};

const FIERY_TEMPER: CardDef = {
  name: 'Fiery Temper',
  typeLine: 'Sorcery',
  manaCost: '{1}{R}{R}',
  cmc: 3,
  oracleText:
    'Fiery Temper deals 3 damage to any target.\nMadness {R} (If you discard this card, discard it '
    + 'into exile. When you do, cast it for its madness cost or put it into your graveyard.)',
  colors: ['R'],
};

const GRAPESHOT: CardDef = {
  name: 'Grapeshot',
  typeLine: 'Sorcery',
  manaCost: '{R}',
  cmc: 1,
  oracleText:
    'Grapeshot deals 1 damage to any target.\nStorm (When you cast this spell, copy it for each '
    + 'spell cast before it this turn. You may choose new targets for the copies.)',
  colors: ['R'],
};

const TWINCAST: CardDef = {
  name: 'Twincast',
  typeLine: 'Instant',
  manaCost: '{2}{U}{U}',
  cmc: 4,
  oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.',
  colors: ['U'],
};

const TOXIC_DELUGE: CardDef = {
  name: 'Toxic Deluge',
  typeLine: 'Sorcery',
  manaCost: '{2}{B}',
  cmc: 3,
  oracleText: 'Pay X life. All creatures get -X/-X until end of turn.',
  colors: ['B'],
};

const CHALICE_OF_THE_VOID: CardDef = {
  name: 'Chalice of the Void',
  typeLine: 'Artifact',
  // One number paid twice, which is a cost shape nothing here had: see `ManaCost.xCount`.
  manaCost: '{X}{X}',
  cmc: 0,
  oracleText: 'Chalice of the Void enters the battlefield with X charge counters on it. '
    + 'Whenever a player casts a spell with mana value equal to the number of charge counters on '
    + 'Chalice of the Void, counter that spell.',
  colors: [],
};

/**
 * The pool's first **cumulative upkeep** card, and a rate that gets worse every turn.
 *
 * One mana for two cards is the best exchange in the pool; two mana for two cards is still good; by
 * the fourth or fifth upkeep the Remora is asking for more than a control deck can spare while it
 * is also holding up a counterspell. So it is a card you play early, milk, and then let go — which
 * is the whole of what the keyword is for, and the reason it is worth a slot here rather than a
 * vanilla draw spell.
 *
 * Only an **opponent's** noncreature spells, so the turns it draws nothing are the turns nobody is
 * doing anything — which suits the deck that is happy to sit behind Counterspells.
 */
const MYSTIC_REMORA: CardDef = {
  name: 'Mystic Remora',
  typeLine: 'Enchantment',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'Cumulative upkeep {1} (At the beginning of your upkeep, put an age counter on this permanent, then sacrifice it unless you pay its upkeep cost for each age counter on it.)\nWhenever an opponent casts a noncreature spell, you may draw two cards.',
  colors: ['U'],
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

/**
 * Soulherder: the payoff the pool's blink cards have never had.
 *
 * Flickerwisp, Cloudshift, Journey to Nowhere and Banisher Priest have been exiling things since
 * the engine's first month, and not one of those moves was ever worth anything beyond what it did
 * on the spot — because nothing could see a card reach exile. This is the card that reads it.
 *
 * Two abilities that feed each other, which is why it is this card rather than a plain watcher: the
 * end-step blink is its own trigger, so a Soulherder left alone on an empty-ish board still grows
 * every turn, and every other blink in the deck is a free counter on top. Faithful to the printed
 * card, including the "**another**" on the blink — it cannot blink itself.
 */
const SOULHERDER: CardDef = {
  name: 'Soulherder',
  typeLine: 'Creature \u2014 Spirit',
  manaCost: '{1}{U}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Whenever a creature you control is exiled, put a +1/+1 counter on Soulherder.\n'
    + 'At the beginning of your end step, you may exile another target creature you control, then '
    + 'return that card to the battlefield under its owner\'s control.',
  colors: ['U'],
};

/**
 * Frogmite: the body affinity is famous for, and the pool's first spell whose cost is a fact about
 * the board.
 *
 * A {4} 2/2 on paper, which is nobody's idea of a card — and that is the keyword. In a deck with
 * three artifacts out it is a one-mana 2/2, and in a deck with none it is exactly what it says.
 * Forge Alliance is the one list in the pool that can pay it: sixteen of its sixty cards are
 * artifacts, the Frogmite itself among them.
 *
 * An artifact creature itself, as printed, which is the half that makes the keyword snowball in a
 * deck built for it — each one cast makes the next cheaper. This deck runs one, for reasons that
 * are measured rather than argued; see the slot comment in the list and D228.
 *
 * Myr Enforcer, the {7} 4/4 that is the keyword's other famous body, was written at the same time
 * and is not in the pool. The paired probe would not have it: see D228 for the four arms, and note
 * that nothing about affinity goes untested without it — the floor is reachable with a Frogmite
 * too, where five artifacts take four off a printed {4} and the fifth takes nothing.
 */
const FROGMITE: CardDef = {
  name: 'Frogmite',
  typeLine: 'Artifact Creature \u2014 Frog',
  manaCost: '{4}',
  cmc: 4,
  power: '2',
  toughness: '2',
  oracleText: 'Affinity for artifacts (This spell costs {1} less to cast for each artifact you '
    + 'control.)',
  colors: [],
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

/**
 * The pool's first **split second** card: two damage nobody gets a word in about (CR 702.19).
 *
 * A Lightning Strike deals three for the same mana, which is the whole trade on the card — a damage
 * for the certainty that while it is on the stack, nothing can be cast in reply. In a pool where
 * every answer to a spell is a cast counterspell, that is the difference between a removal spell
 * resolving and a removal spell being Counterspelled.
 */
const SUDDEN_SHOCK: CardDef = {
  name: 'Sudden Shock',
  typeLine: 'Instant',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Split second (As long as this spell is on the stack, players can\u2019t cast spells or activate abilities that aren\u2019t mana abilities.)\nSudden Shock deals 2 damage to any target.',
  colors: ['R'],
};

/**
 * The same keyword on the answer this pool has least of: a Naturalize nobody can play around.
 *
 * A mana dearer than Naturalize and it buys the one thing that answer needed. An Equipment about to
 * be moved, a Chalice about to be grown, a Journey to Nowhere about to be sacrificed in response —
 * against each of those a Naturalize is a card the opponent gets to answer, and this is not.
 */
const KROSAN_GRIP: CardDef = {
  name: 'Krosan Grip',
  typeLine: 'Instant',
  manaCost: '{2}{G}',
  cmc: 3,
  oracleText: 'Split second (As long as this spell is on the stack, players can\u2019t cast spells or activate abilities that aren\u2019t mana abilities.)\nDestroy target artifact or enchantment.',
  colors: ['G'],
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

const BOON_SATYR: CardDef = {
  name: 'Boon Satyr',
  typeLine: 'Enchantment Creature — Satyr',
  manaCost: '{1}{G}{G}',
  cmc: 3,
  power: '4',
  toughness: '2',
  oracleText: 'Flash\nBestow {3}{G}{G}\nEnchanted creature gets +4/+2.',
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

const SAMITE_HEALER: CardDef = {
  name: 'Samite Healer',
  typeLine: 'Creature \u2014 Human Cleric',
  manaCost: '{1}{W}{W}',
  cmc: 3,
  power: '1',
  toughness: '1',
  oracleText: '{T}: Prevent the next 1 damage that would be dealt to any target this turn.',
  colors: ['W'],
};

const HEALING_SALVE: CardDef = {
  name: 'Healing Salve',
  typeLine: 'Instant',
  manaCost: '{W}',
  cmc: 1,
  oracleText: 'Choose one \u2014\n\u2022 Target player gains 3 life.\n\u2022 Prevent the next 3 damage that would be dealt to any target this turn.',
  colors: ['W'],
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

/*
  The answers for the half of the board nothing could answer.

  Eight artifacts and six enchantments had accumulated in this pool — a Pacifism, a Journey to
  Nowhere, a Loxodon Warhammer, an Icy Manipulator — and not one card in any deck could remove
  either. A Pacifism on your commander was permanent, for the rest of the game, which is not a
  thing that happens in a game of Magic.
*/
/*
  The first creature in the pool that does not get a choice.

  Every "can't" the engine knew was a restriction on one card — Pacifism, defender, summoning
  sickness. A *requirement* is checked against the whole declaration, which is a different shape,
  and nothing could carry one. Juggernaut is the plainest card that does, and its second line is a
  second small rule worth having: evasion that reads a creature type rather than a keyword.
*/
/*
  Metalcraft, the pool's first "as long as" clause (CR 702.75 — "metalcraft" is the keyword, and the
  clause is an ordinary conditional static).

  Three cards, and only two of them need the engine to learn anything. A static conditioned on the
  board is a shape nothing here could say: every continuous effect was created, applied for a
  duration and expired, while "as long as you control three or more artifacts" has no moment at
  which it turns on. Chrome Steed and Etched Champion carry that; Galvanic Blast reads its condition
  once, as it resolves, and needs nothing new at all — which is the contrast worth having in the
  pool, because it says where the machinery is actually required.

  The two creatures are artifacts themselves, so they are part of meeting the condition they read.
  Forge Alliance controlled ten artifacts before them and twelve after.
*/

const CHROME_STEED: CardDef = {
  name: 'Chrome Steed',
  typeLine: 'Artifact Creature \u2014 Horse',
  manaCost: '{3}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Metalcraft \u2014 Chrome Steed gets +2/+2 as long as you control three or more artifacts.',
  colors: [],
};

const ETCHED_CHAMPION: CardDef = {
  name: 'Etched Champion',
  typeLine: 'Artifact Creature \u2014 Soldier',
  manaCost: '{3}',
  cmc: 3,
  power: '1',
  toughness: '1',
  oracleText: 'Metalcraft \u2014 Etched Champion has protection from all colors as long as you control three or more artifacts.',
  colors: [],
};

const GALVANIC_BLAST: CardDef = {
  name: 'Galvanic Blast',
  typeLine: 'Instant',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Galvanic Blast deals 1 damage to any target.\nMetalcraft \u2014 Galvanic Blast deals 4 damage to that permanent or player instead if you control three or more artifacts.',
  colors: ['R'],
};

const JUGGERNAUT: CardDef = {
  name: 'Juggernaut',
  typeLine: 'Artifact Creature — Juggernaut',
  manaCost: '{4}',
  cmc: 4,
  power: '5',
  toughness: '3',
  oracleText: "Juggernaut attacks each combat if able.\nJuggernaut can't be blocked by Walls.",
  colors: [],
};

/*
  Goad, which is the one mechanic in Magic that only exists because there are more than two players.

  "Attacks each combat if able, and attacks somebody other than me" is a coherent card in a pod and
  nearly a blank in a duel — with one opponent there is nobody else for the creature to attack, so
  goading is paying three mana to be attacked. That makes it the first card here whose worth depends
  on the number of seats, which the bot has to be told rather than shown (see `goadsOpponents`).

  All creatures you don't control rather than one, because the sweeping version is the one that
  reads as politics: every other player's board turns on each other for a turn.
*/
const DISRUPT_DECORUM: CardDef = {
  name: 'Disrupt Decorum',
  typeLine: 'Sorcery',
  manaCost: '{3}{R}',
  cmc: 4,
  oracleText: "Goad all creatures you don't control.",
  colors: ['R'],
};

/*
  The first card here whose effect belongs to one permanent and changes what happens to a different
  one (CR 614) — which is the thing the engine had no answer for at all.

  Regeneration and "enters the battlefield tapped" are both replacement effects and both got away
  with being a shield sitting on the card they affect, because that is where they are printed. "If
  a nontoken creature an opponent controls would die, exile it instead" cannot: it is written on a
  vampire across the table from the creature it is talking about.

  Kalitas is also the plainest possible test of the pass, because it hits every way a creature can
  die — lethal damage, a Doom Blade, a sacrifice paid as a cost — and all three have to reach it.
*/
const KALITAS: CardDef = {
  name: 'Kalitas, Traitor of Ghet',
  typeLine: 'Legendary Creature — Vampire Warrior',
  manaCost: '{2}{B}{B}',
  cmc: 4,
  power: '3',
  toughness: '4',
  oracleText:
    'Lifelink\nIf a nontoken creature an opponent controls would die, instead exile that card and '
    + 'create a 2/2 black Zombie creature token.',
  colors: ['B'],
};

/*
  Protection, which is the only keyword in Magic that is four rules at once (CR 702.16): a creature
  with protection from black cannot be **d**amaged, **e**nchanted or equipped, **b**locked, or
  **t**argeted by anything black. Three of the four were a line each; the damage one is what cost
  something, because it is a fact about the *source* and nothing was telling `dealDamage` what had
  dealt it.

  The Paladin is the plainest version of the card: two fixed colours, no choice to make, and in this
  pool those two colours are most of the removal — a Doom Blade and a Lightning Bolt both bounce off
  it, and neither a black nor a red creature can block it.
*/
const PALADIN_EN_VEC: CardDef = {
  name: 'Paladin en-Vec',
  typeLine: 'Creature — Human Knight',
  manaCost: '{1}{W}{W}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'First strike\nProtection from black and from red',
  colors: ['W'],
};

const NATURALIZE: CardDef = {
  name: 'Naturalize',
  typeLine: 'Instant',
  manaCost: '{1}{G}',
  cmc: 2,
  oracleText: 'Destroy target artifact or enchantment.',
  colors: ['G'],
};

const DISENCHANT: CardDef = {
  name: 'Disenchant',
  typeLine: 'Instant',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText: 'Destroy target artifact or enchantment.',
  colors: ['W'],
};

/*
  And the response to removal, which the pool had none of at all.

  Every answer in it pointed one way: destroy, exile, bounce, pacify. Holding a single mana to save
  the creature somebody is pointing a Doom Blade at is one of the oldest shapes in the game, and
  the only card that granted untargetability was an aura cast on your own main phase.
*/
const BLOSSOMING_DEFENSE: CardDef = {
  name: 'Blossoming Defense',
  typeLine: 'Instant',
  manaCost: '{G}',
  cmc: 1,
  oracleText: 'Target creature you control gets +2/+2 and gains hexproof until end of turn.',
  colors: ['G'],
};

const DIVE_DOWN: CardDef = {
  name: 'Dive Down',
  typeLine: 'Instant',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'Target creature you control gets +0/+3 and gains hexproof until end of turn.',
  colors: ['U'],
};

const CITY_OF_BRASS: CardDef = {
  name: 'City of Brass',
  typeLine: 'Land',
  manaCost: '',
  cmc: 0,
  oracleText:
    'Whenever City of Brass becomes tapped, it deals 1 damage to you.\n{T}: Add one mana of any colour.',
  colors: [],
};

const MANA_CONFLUENCE: CardDef = {
  name: 'Mana Confluence',
  typeLine: 'Land',
  manaCost: '',
  cmc: 0,
  oracleText: '{T}, Pay 1 life: Add one mana of any colour.',
  colors: [],
};

const DARK_CONFIDANT: CardDef = {
  name: 'Dark Confidant',
  typeLine: 'Creature \u2014 Human Wizard',
  manaCost: '{1}{B}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText:
    'At the beginning of your upkeep, reveal the top card of your library and put that card into '
    + 'your hand. You lose life equal to its mana value.',
  colors: ['B'],
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

/**
 * Mutavault, the one card in the pool that is two things at once.
 *
 * Colourless on purpose: it is a land every deck here could play, so the layer it needs is not
 * paid for by one colour's slot. The printed card says "with all creature types"; the script leaves
 * that clause out and says why.
 */
const MUTAVAULT: CardDef = {
  name: 'Mutavault',
  typeLine: 'Land',
  manaCost: '',
  cmc: 0,
  oracleText: '{T}: Add {C}.\n{1}: Mutavault becomes a 2/2 creature until end of turn. It\u2019s still a land.',
  colors: [],
};

/**
 * The two cards flashback was built for. Both are the same card twice for two different prices.
 */
const MULLDRIFTER: CardDef = {
  name: 'Mulldrifter',
  typeLine: 'Creature — Elemental',
  manaCost: '{4}{U}',
  cmc: 5,
  power: '2',
  toughness: '2',
  oracleText: 'Flying\nWhen Mulldrifter enters the battlefield, draw two cards.\nEvoke {2}{U}',
  colors: ['U'],
};

const THINK_TWICE: CardDef = {
  name: 'Think Twice',
  typeLine: 'Instant',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Draw a card.\nFlashback {2}{U}',
  colors: ['U'],
};

/*
  Three cards whose cost is partly the graveyard, which is the pool's first use of that zone as
  something to spend rather than somewhere cards end up.

  Two mechanics, one idea. Escape is a fixed price — the Phoenix comes back for {2}{R}{R} and three
  cards, over and over, which is why it is a 2/2 rather than a 4/4. Delve is a price you choose as
  you cast: a Gurmag Angler is a seven-mana 5/5 on an empty graveyard and a one-mana 5/5 on a full
  one, which makes it the pool's first card whose mana cost is a fact about the game rather than
  about the card.

  The three are deliberately in the three decks that fill a graveyard on their own and sit in the
  bottom cluster of the table: Arc Tempest casts two spells a turn, Tidal Mind mills itself with
  Thought Scour, and Hollow Tide is a mill deck whose own library is the fuel.
*/
const PHOENIX_OF_ASH: CardDef = {
  name: 'Phoenix of Ash',
  typeLine: 'Creature — Phoenix',
  manaCost: '{1}{R}{R}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Flying, haste\n{1}: Phoenix of Ash gets +1/+0 until end of turn.\n'
    + 'Escape—{2}{R}{R}, Exile three other cards from your graveyard.',
  colors: ['R'],
};

/*
  And the two answers to it, because a pool whose graveyard is a resource needs cards that attack
  one.

  Escape, delve, flashback, Raise Dead, Zombify, Gravedigger and a Lhurgoyf whose power *is* the
  graveyard were all printed here before anything could interfere with a graveyard except Tormod's
  Crypt, which is one card in one deck and a single shot. These two are the standing answers: one
  stops a graveyard existing at all, and one eats it a card at a time and grows for it.
*/
const PLANAR_VOID: CardDef = {
  name: 'Planar Void',
  typeLine: 'Enchantment',
  manaCost: '{B}',
  cmc: 1,
  oracleText: 'Whenever another card is put into a graveyard from anywhere, exile that card.',
  colors: ['B'],
};

/*
  Rest in Peace: the printed version of the thing Planar Void only approximates.

  Planar Void is a trigger — the card reaches the graveyard and is exiled afterwards — so a Blood
  Artist still drains and a Gravedigger that resolves first still buys something back. Rest in Peace
  says **instead**, which is a replacement effect over the widest zone change there is: a card going
  to a graveyard from anywhere. It is the card the engine's `replaces` field was generalised for
  (D185), and the only standing answer in the pool that turns a graveyard off rather than eating it.

  Symmetrical and printed that way, which is why the slot matters more than the card: it is in the
  one deck with no graveyard of its own to lose.
*/
const REST_IN_PEACE: CardDef = {
  name: 'Rest in Peace',
  typeLine: 'Enchantment',
  manaCost: '{1}{W}',
  cmc: 2,
  oracleText:
    'When Rest in Peace enters the battlefield, exile all cards from all graveyards.\n'
    + 'If a card would be put into a graveyard from anywhere, exile it instead.',
  colors: ['W'],
};

/*
  Four keywords that read the **attack** rather than the creature.

  Every one of the engine's seventeen keywords is a fact about a permanent — flying, deathtouch,
  first strike — and its combat triggers could already say "whenever this attacks". None of them
  could say anything about the *shape* of a declaration: how many creatures were in it, how their
  power compares, or whether this one has connected before. These four are each a different answer
  to that, and they are in the pool together because they all pay a player for attacking with more
  than one creature, which is the decision the bot's combat search is actually about (D188).
*/
const FIREMANE_AVENGER: CardDef = {
  name: 'Firemane Avenger',
  typeLine: 'Creature — Archon',
  manaCost: '{2}{R}{W}',
  cmc: 4,
  power: '3',
  toughness: '3',
  oracleText:
    'Flying\nBattalion — Whenever Firemane Avenger and at least two other creatures attack, '
    + 'Firemane Avenger deals 3 damage to any target and you gain 3 life.',
  colors: ['R', 'W'],
};

const SUNHOME_STALWART: CardDef = {
  name: 'Sunhome Stalwart',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText:
    'First strike\nMentor (Whenever this creature attacks, put a +1/+1 counter on target attacking '
    + 'creature with lesser power.)',
  colors: ['W'],
};

const TOPAN_FREEBLADE: CardDef = {
  name: 'Topan Freeblade',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText:
    'Vigilance\nRenown 1 (When this creature deals combat damage to a player, if it isn\u2019t '
    + 'renowned, put a +1/+1 counter on it and it becomes renowned.)',
  colors: ['W'],
};

const BLOODBRAID_ELF: CardDef = {
  name: 'Bloodbraid Elf',
  typeLine: 'Creature — Elf Berserker',
  manaCost: '{2}{R}{G}',
  cmc: 4,
  power: '3',
  toughness: '2',
  oracleText:
    'Haste\nCascade (When you cast this spell, exile cards from the top of your library until you '
    + 'exile a nonland card that costs less. You may cast it without paying its mana cost. Put the '
    + 'exiled cards on the bottom of your library in a random order.)',
  colors: ['R', 'G'],
};

const GOBLIN_WARDRIVER: CardDef = {
  name: 'Goblin Wardriver',
  typeLine: 'Creature — Goblin Warrior',
  manaCost: '{1}{R}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText:
    'Battle cry (Whenever this creature attacks, each other attacking creature gets +1/+0 until '
    + 'end of turn.)',
  colors: ['R'],
};

/*
  Kitchen Finks: the card hybrid mana was taught for, and it needed nothing else new.

  `{1}{G/W}{G/W}` is three mana in a two-colour deck that can pay it any way round, a 3/2 that gains
  two life as it lands, and **persist** — which has been in the engine since D181 and had exactly
  one card behind it. A mechanic with one card has one card's worth of coverage.
*/
const KITCHEN_FINKS: CardDef = {
  name: 'Kitchen Finks',
  typeLine: 'Creature — Elemental',
  manaCost: '{1}{G/W}{G/W}',
  cmc: 3,
  power: '3',
  toughness: '2',
  oracleText:
    'When Kitchen Finks enters the battlefield, you gain 2 life.\n'
    + 'Persist (When this creature dies, if it had no -1/-1 counter on it, return it to the '
    + 'battlefield under its owner\u2019s control with a -1/-1 counter on it.)',
  colors: ['G', 'W'],
};

const SCAVENGING_OOZE: CardDef = {
  name: 'Scavenging Ooze',
  typeLine: 'Creature — Ooze',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 '
    + 'counter on Scavenging Ooze and you gain 1 life.',
  colors: ['G'],
};

const WOE_STRIDER: CardDef = {
  name: 'Woe Strider',
  typeLine: 'Creature — Horror',
  manaCost: '{2}{B}',
  cmc: 3,
  power: '3',
  toughness: '2',
  oracleText: 'When Woe Strider enters the battlefield, create a 0/1 white Goat creature token.\n'
    + '{0}: Sacrifice another creature. Scry 1.\n'
    + 'Escape—{4}{B}, Exile three other cards from your graveyard.',
  colors: ['B'],
};

const GURMAG_ANGLER: CardDef = {
  name: 'Gurmag Angler',
  typeLine: 'Creature — Zombie Fish',
  manaCost: '{6}{B}',
  cmc: 7,
  power: '5',
  toughness: '5',
  oracleText: 'Delve (Each card you exile from your graveyard while casting this spell pays for {1}.)',
  colors: ['B'],
};

const TREASURE_CRUISE: CardDef = {
  name: 'Treasure Cruise',
  typeLine: 'Sorcery',
  manaCost: '{7}{U}',
  cmc: 8,
  oracleText: 'Delve (Each card you exile from your graveyard while casting this spell pays for {1}.)\n'
    + 'Draw three cards.',
  colors: ['U'],
};

const FIREBOLT: CardDef = {
  name: 'Firebolt',
  typeLine: 'Sorcery',
  manaCost: '{R}',
  cmc: 1,
  oracleText: 'Firebolt deals 2 damage to any target.\nFlashback {4}{R}',
  colors: ['R'],
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

/*
  The pool's two-faced cards: one split card, and two adventurers (CR 708).

  Each is one physical card with more than one castable face, and the faces are nested on the
  definition rather than written as separate deck entries — a deck list holds one Fire // Ice, not a
  Fire and an Ice. `deck:load` registers each face under its own key as well, which is what lets a
  spell cast as one of them be an ordinary spell everywhere downstream. See `CardDef.faces`.

  The two kinds differ in what the *card* is, and the printed cost is where that shows:

  - A **split card** has the combined cost and the summed mana value in every zone but the stack
    (CR 708.4), which is why Fire // Ice is written here as `{1}{R}{1}{U}` with a mana value of 4
    even though neither half costs more than two. A Chalice of the Void set to 2 does not counter
    it, and that is the rule rather than an oversight.
  - An **adventurer** is a creature card. Its printed cost, type and mana value are the creature's,
    and the adventure half exists only while it is on the stack — so Merfolk Secretkeeper is a
    one-mana creature card that can also be a two-mana sorcery, and the card in the graveyard
    afterwards is a creature card.
*/

const FIRE_ICE: CardDef = {
  name: 'Fire // Ice',
  typeLine: 'Instant // Instant',
  manaCost: '{1}{R} // {1}{U}',
  cmc: 4,
  oracleText: 'Fire deals 2 damage divided as you choose among one or two targets.\nTap target permanent. Draw a card.',
  colors: ['R', 'U'],
  faces: {
    kind: 'split',
    cards: [
      {
        name: 'Fire',
        typeLine: 'Instant',
        manaCost: '{1}{R}',
        cmc: 2,
        oracleText: 'Fire deals 2 damage divided as you choose among one or two targets.',
        colors: ['R'],
      },
      {
        name: 'Ice',
        typeLine: 'Instant',
        manaCost: '{1}{U}',
        cmc: 2,
        oracleText: 'Tap target permanent.\nDraw a card.',
        colors: ['U'],
      },
    ],
  },
};

const WAX_WANE: CardDef = {
  name: 'Wax // Wane',
  typeLine: 'Instant // Instant',
  manaCost: '{G} // {W}',
  cmc: 2,
  oracleText: 'Target creature gets +2/+2 until end of turn.\nDestroy target enchantment.',
  colors: ['G', 'W'],
  faces: {
    kind: 'split',
    cards: [
      {
        name: 'Wax',
        typeLine: 'Instant',
        manaCost: '{G}',
        cmc: 1,
        oracleText: 'Target creature gets +2/+2 until end of turn.',
        colors: ['G'],
      },
      {
        name: 'Wane',
        typeLine: 'Instant',
        manaCost: '{W}',
        cmc: 1,
        oracleText: 'Destroy target enchantment.',
        colors: ['W'],
      },
    ],
  },
};

/*
  And the third kind of printing: a modal double-faced card, where the back is a **land**
  (CR 712).

  The card's printed cost, type and mana value are the **front** face's, in every zone but the
  battlefield: a Hagra Mauling in a hand or a graveyard is a three-mana instant, which is what a
  Chalice of the Void counts and what a discard spell sees. The back face is not a cheaper way to
  cast it — it is a different thing to do with the card, and it costs that turn's land drop.

  Both lands come in tapped, which is the printed price of the flexibility and the whole reason the
  cycle is fair: a deck playing one of these is a deck with twenty-two lands that are sometimes
  spells, and the tempo it gives up for that is a turn.
*/

/*
  And the fourth kind: a **transforming** double-faced card (CR 712).

  The difference from the modal pair below is *when* the pointer moves rather than how. A modal card
  decides which face it is as it is played and stays that face; a transforming one is cast and
  enters as its front face like any other creature, and an effect turns it over later. Both are one
  field — `defKey` — and `transformPermanent` is the whole of the second case.

  Two things about the back faces are printed data and easy to get wrong. They have **no mana cost**,
  because nothing ever casts them. And their **mana value is the front face's** (CR 712.4c): a
  transformed Thing in the Ice is still a two-mana permanent to anything that counts mana values on
  the battlefield, so `cmc` carries the front's number even though `manaCost` is empty.
*/

const DELVER_OF_SECRETS: CardDef = {
  name: 'Delver of Secrets',
  typeLine: 'Creature — Human Wizard',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.',
  colors: ['U'],
  power: '1',
  toughness: '1',
  faces: {
    kind: 'transform',
    cards: [{
      // No script at all: the back face is a keyword-only line, which `printedKeywords` reads.
      name: 'Insectile Aberration',
      typeLine: 'Creature — Human Insect',
      manaCost: '',
      cmc: 1,
      oracleText: 'Flying',
      colors: ['U'],
      power: '3',
      toughness: '2',
    }],
  },
};

const THING_IN_THE_ICE: CardDef = {
  name: 'Thing in the Ice',
  typeLine: 'Creature — Horror',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Defender\nThing in the Ice enters the battlefield with four ice counters on it.\nWhenever you cast an instant or sorcery spell, remove an ice counter from Thing in the Ice. Then if it has no ice counters on it, transform it.',
  colors: ['U'],
  power: '0',
  toughness: '4',
  faces: {
    kind: 'transform',
    cards: [{
      name: 'Awoken Horror',
      typeLine: 'Creature — Kraken Horror',
      manaCost: '',
      cmc: 2,
      oracleText: "When this creature transforms into Awoken Horror, return all non-Horror creatures to their owners' hands.",
      colors: ['U'],
      power: '7',
      toughness: '8',
    }],
  },
};

const HAGRA_MAULING: CardDef = {
  name: 'Hagra Mauling',
  typeLine: 'Instant',
  manaCost: '{2}{B}',
  cmc: 3,
  oracleText: 'Destroy target creature.',
  colors: ['B'],
  faces: {
    kind: 'modal',
    cards: [{
      name: 'Hagra Broodpit',
      typeLine: 'Land',
      manaCost: '',
      cmc: 0,
      oracleText: 'Hagra Broodpit enters the battlefield tapped.\n{T}: Add {B}.',
      colors: [],
    }],
  },
};

const VASTWOOD_FORTIFICATION: CardDef = {
  name: 'Vastwood Fortification',
  typeLine: 'Instant',
  manaCost: '{1}{G}',
  cmc: 2,
  oracleText: 'Put a +1/+1 counter on target creature.',
  colors: ['G'],
  faces: {
    kind: 'modal',
    cards: [{
      name: 'Vastwood Thicket',
      typeLine: 'Land',
      manaCost: '',
      cmc: 0,
      oracleText: 'Vastwood Thicket enters the battlefield tapped.\n{T}: Add {G}.',
      colors: [],
    }],
  },
};

const MERFOLK_SECRETKEEPER: CardDef = {
  name: 'Merfolk Secretkeeper',
  typeLine: 'Creature \u2014 Merfolk Wizard',
  manaCost: '{U}',
  cmc: 1,
  power: '0',
  toughness: '4',
  oracleText: 'Venture Deeper {1}{U} (Sorcery) \u2014 Target player mills four cards. Then exile this card. You may cast the creature later from exile.',
  colors: ['U'],
  faces: {
    kind: 'adventure',
    cards: [{
      name: 'Venture Deeper',
      typeLine: 'Sorcery \u2014 Adventure',
      manaCost: '{1}{U}',
      cmc: 2,
      oracleText: 'Target player mills four cards.',
      colors: ['U'],
    }],
  },
};

const GARENBRIG_CARVER: CardDef = {
  name: 'Garenbrig Carver',
  typeLine: 'Creature \u2014 Human Warrior',
  manaCost: '{2}{G}',
  cmc: 3,
  power: '3',
  toughness: '3',
  oracleText: "Shield's Might {1}{G} (Instant) \u2014 Target creature gets +3/+3 until end of turn. Then exile this card. You may cast the creature later from exile.",
  colors: ['G'],
  faces: {
    kind: 'adventure',
    cards: [{
      name: "Shield's Might",
      typeLine: 'Instant \u2014 Adventure',
      manaCost: '{1}{G}',
      cmc: 2,
      oracleText: 'Target creature gets +3/+3 until end of turn.',
      colors: ['G'],
    }],
  },
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
    { card: MOUNTAIN, count: 18 },
    /*
      One land of the nineteen is a Mutavault, which in a mono-red deck of {R} costs is a real
      price rather than a free upgrade: it taps for {C}, so it pays for generic costs and nothing
      else, and a hand of Bolts and a Mutavault is a hand that cannot cast them. What it buys is a
      land that attacks for two once the deck has run out of things to do with its mana — see the
      measurement in the progress doc for what that trade was worth.
    */
    { card: MUTAVAULT, count: 1 },
    { card: MONASTERY_SWIFTSPEAR, count: 4 },
    /*
      One Raging Goblin rather than two, and a Mizzium Mortars for the other.

      **Overload** (D198) is the fifth alternative cost and the first that changes what the spell
      does: {1}{R} for four damage to one of their creatures, or {3}{R}{R}{R} for four damage to
      *every* creature they have. This is the deck that can pay either — eighteen Mountains and a
      Mutavault, so six lands is six red — and the deck that most wants both halves: the cheap one
      is the removal a burn deck never had for a 4/4 blocker, and the dear one is the card that
      wins the game this deck has otherwise already lost, where it is on three lands' worth of
      spells against a board it cannot attack into.

      The cut is the second copy of the weakest card in the list, which is this list's own rule: a
      1/1 with haste is three damage over three turns if nothing ever blocks it. One stays, so the
      script and the tests that use it by name are untouched.
    */
    { card: RAGING_GOBLIN, count: 1 },
    { card: MIZZIUM_MORTARS, count: 1 },
    { card: GOBLIN_ARSONIST, count: 1 },
    /*
      The second Arsonist's slot, spent on the same two mana of goblins with **echo** on it.

      Both are small red bodies that leave something behind: the Arsonist pings on the way out, the
      Marshal makes a token coming and going. What the slot buys is the question — two mana again
      next upkeep, or it dies and makes its second Goblin — and because declining costs almost
      nothing, it is a question worth asking rather than a tax. See D214.
    */
    { card: MOGG_WAR_MARSHAL, count: 1 },
    // One Archer rather than two: the slot went to Crimson Wisps, which is a card the Archer would
    // have pinged for anyway and which gives the Dragon, the Kavu or a Hill Giant haste.
    { card: FIREBRAND_ARCHER, count: 1 },
    { card: CRIMSON_WISPS, count: 1 },
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

const AJANI_CALLER_OF_THE_PRIDE: CardDef = {
  name: 'Ajani, Caller of the Pride',
  typeLine: 'Legendary Planeswalker — Ajani',
  manaCost: '{1}{W}{W}',
  cmc: 3,
  loyalty: '4',
  oracleText: '+1: Put a +1/+1 counter on target creature.\n−3: Target creature gains flying and double strike until end of turn.\n−8: Create five 2/2 white Cat creature tokens.',
  colors: ['W'],
};

const NISSA_VOICE_OF_ZENDIKAR: CardDef = {
  name: 'Nissa, Voice of Zendikar',
  typeLine: 'Legendary Planeswalker — Nissa',
  manaCost: '{1}{G}{G}',
  cmc: 3,
  loyalty: '3',
  oracleText: '+1: Create a 0/1 green Plant creature token.\n−2: Put a +1/+1 counter on each creature you control.\n−7: You gain X life and draw X cards, where X is the number of lands you control.',
  colors: ['G'],
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
    { card: GARRUK_WILDSPEAKER, count: 1 },
    /*
      **Renown 1**, and the slot is the measurement rather than the theory.

      It went into Skyward Writ first — the other white deck, and the one whose plan is to still be
      alive later, which a 2/2 with vigilance that grows looked built for. `cast-counts` said no:
      **3 casts in the 16 games it was in hand**, against 44 for a Leonin Skyhunter and 53 for an
      Omenspeaker at the same cost. Not the mana-reservation rule either (2 casts with that rule
      switched off) — it was simply the 61st-best card in a deck that already has two better
      two-drops and bigger things to do by turn four.

      Here, in place of the last **Soul Warden** (60%, 25 casts in 42 games it was in hand — a
      lifegain engine in the one white deck that is not built around lifegain, and Dawn Tithe and
      Skyward Writ both keep theirs), the same card is cast **27 times in the 42 games it was in
      hand**. Same card, same cost, three times the usage of the Skyward Writ slot: a slot is worth
      more than a card's text (D188).

      (A first probe of this card put it in place of Verdant Guard's **Centaur Courser** instead and
      measured 50 casts in 48 — higher again, and not the slot that shipped, because cutting the
      Courser breaks 49 tests that use it as the board's default creature. The number quoted above
      is the one this list actually produces.)
    */
    { card: TOPAN_FREEBLADE, count: 1 },
    /*
      Ainok Survivalist for the second Soul Warden, and the first morph in the pool with text on its
      back.

      A {1}{G} 2/1 that is also a {3} 2/2 on turn three and removal on any turn after that — and the
      removal half cannot be played around, because turning a permanent face up uses no stack. This
      deck already answers an artifact with a Naturalize it has to be holding *as* a Naturalize; the
      Ainok is the same answer attached to a body, held as a creature and revealed as the answer at
      the moment it is wanted.

      The second Soul Warden, because one is already as much lifegain as this deck's one payoff for
      it — a single Ajani's Pridemate — can use, and a 1/1 that gains a life per creature is the
      weakest body on a curve that wants to be attacking.
    */
    { card: AINOK_SURVIVALIST, count: 1 },
    // Both copies, pinned: `playout.test.ts` asks whether a death reaches its trigger in a real
    // game, and the Spirit it watches for is this card's.
    { card: DOOMED_TRAVELER, count: 2 },
    /*
      The pool's first card with ward, in the deck whose instants make it grow: a 2/2 for two that
      an opponent has to pay a mana to touch, and a 4/4 the moment you cast a Giant Growth.

      It cost the second Naturalize, which is the most situational card this deck ran — in a pool
      with four artifacts and a handful of enchantments across eight decks, the first copy is
      already more than it needs.
    */
    { card: DRAGONSGUARD_ELITE, count: 1 },
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
    { card: GIANT_SPIDER, count: 1 },
    { card: SERRA_ANGEL, count: 1 },
    /*
      Seven mana printed and castable off four lands and three creatures, which is the whole point
      of convoke and the clearest card in the pool for showing it. It cost the second Serra Angel:
      the same job at the top of the curve, for a card the deck's own board helps pay for.
    */
    { card: SIEGE_WURM, count: 1 },
    // Removal that gives the creature back if you kill the thing holding it, which is the deck's
    // answer to a creature it cannot block rather than a second Pacifism.
    { card: BANISHER_PRIEST, count: 1 },
    { card: JOURNEY_TO_NOWHERE, count: 2 },
    /*
      River Boa, for the Rampant Growth.

      The pool's first **landwalk** card (CR 702.14), and the only evasion here whose answer is on
      the other player's battlefield: islandwalk makes it unblockable against the five decks with
      Islands in them and an ordinary {1}{G} 2/1 against the rest. The regeneration is the other
      half and the reason it is a two-drop worth drawing late — {G} answers a blocker, a burn spell
      or a sweeper, and this deck is the one with spare green mana in the late turns.

      **Which slot it took was measured twice.** The second Journey to Nowhere paid for it first,
      and that cost eight games of 240; the Rampant Growth paid for it instead and the slot came
      back +1 — free, and nine games better than the other arrangement. The reading is about the
      *cut* rather than the card: a deck with five other answers to one creature can spare neither
      a sixth nor its ramp cheaply, and the instrument says which. The Growth is not lost from the
      pool — Delta Bloom runs two, which is the deck ramp belongs to.

      A noncreature slot either way, because every creature slot here is load-bearing somewhere
      else: the Grizzly Bears, the Centaur Courser and the Elvish Visionary are the fixtures two
      dozen tests build their boards out of (see the note above the Bears).
    */
    { card: RIVER_BOA, count: 1 },
    // A Plains and a Pacifism paid for these. Cloudshift is one mana that saves a creature from
    // removal, draws a card off the Visionary, and re-aims a Banisher Priest at something newer —
    // three cards' worth of work from one line of script, because the return is an arrival like
    // any other and every enter-the-battlefield trigger here fires again on its own.
    { card: CLOUDSHIFT, count: 1 },
    { card: GIANT_GROWTH, count: 1 },
    { card: TITANIC_GROWTH, count: 1 },
    // One mana that beats an alpha strike, and the cheapest card in the game that does. It cost a
    // second Banisher Priest, in a deck already holding five other ways to answer one creature.
    { card: FOG, count: 1 },
    // Removal a green deck is actually allowed: the biggest creature on the table eats something.
    /*
      **Fleecemane Lion, for the Prey Upon**, and it is the pool's first monstrosity.

      A 3/3 for two is already the best rate in this deck; the five mana after it is what makes the
      card famous. *{2}{G}{W}: Monstrosity 1* puts a +1/+1 counter on it **once** — the growth does
      not wear off and the ability cannot be pressed twice — and *as long as it is monstrous it has
      hexproof and indestructible*, which in this pool means no Doom Blade, no Murder, no Day of
      Judgment and no Prey Upon answers it at all.

      The slot is this deck's own Prey Upon (59%): a fight spell is a creature's worth of removal
      that needs a creature, and a deck with eighteen of them would rather have the nineteenth. Two
      other decks keep theirs — Kindle Grove runs the pool's pair and the red-green plan is built
      around them (D162).
    */
    { card: FLEECEMANE_LION, count: 1 },
    { card: LOXODON_WARHAMMER, count: 1 },
    { card: SELESNYA_CHARM, count: 1 },
    /*
      Three mana for a 3/2 that gains two life and comes back once, in the deck that can pay
      `{1}{G/W}{G/W}` any way round.

      It replaced this deck's **Pacifism** (64% of the games it was in hand, 27 casts in 96) — the
      fifth piece of removal in a list that already holds two Journeys to Nowhere, a Swords, a
      Conclave Tribunal, a Selesnya Charm and a Banisher Priest. What the deck is short of is
      bodies that survive, which is exactly what persist is.
    */
    { card: KITCHEN_FINKS, count: 1 },
    { card: SWORDS_TO_PLOWSHARES, count: 1 },
    /*
      Five mana of removal is unplayable on a creature deck's curve; three is not, and with a board
      it is sometimes one. It answers anything nonland rather than only a creature, which is the
      half of the board this deck's other removal cannot touch — and it cost the second Swords to
      Plowshares, which is the better card and the one there is already a copy of.
    */
    { card: CONCLAVE_TRIBUNAL, count: 1 },
    /*
      The split card, for the Naturalize that was this deck's deadest slot at 38%.

      Wane is a narrower Naturalize — enchantments only — and Wax is a one-mana +2/+2 on a deck
      full of creatures, which is the half that is never dead. Trading the artifact half for a
      combat trick is the trade this pool rewards: four enchantments and a handful of artifacts
      between twelve decks, and twenty-odd creatures in this one.
    */
    { card: WAX_WANE, count: 1 },
    { card: BLOSSOMING_DEFENSE, count: 1 },
    { card: HARMONIZE, count: 1 },
    { card: OVERRUN, count: 1 },
    // The deck's X spell, and the two slots above it that paid for the Spiders and the Prey Upons
    // the first time round. It went out and had to come straight back: a token finisher is the
    // only thing this deck does with a flooded hand, and the X-cost test casts two of them.
    /*
      Boon Satyr for the second Secure the Wastes: the first card in this pool that is a creature
      or a pump spell, and the player picks which as they cast it.

      **Bestow** (D196) is the third alternative cost and the one that changes what the spell *is*:
      for {1}{G}{G} this is a 4/2 with flash, and for {3}{G}{G} it is an Aura giving +4/+2 that
      becomes a 4/2 the moment the creature it enchants dies. That second half is why it goes in
      this list rather than anywhere else — Verdant Guard's plan is a board that grows, and its
      recurring problem is a removal spell answering two cards at once (a Loxodon Warhammer on a
      creature that then dies, a Giant Growth that fizzles). A bestowed Satyr is the only card here
      that cannot be two-for-oned: answer the creature and the Aura stands up as a creature itself.

      The slot is a **second copy** rather than a card the deck only has one of, which is this
      list's own rule for a cut: Secure the Wastes is the deck's instant-speed X spell and one copy
      is still in it, so the mechanic, the script and the turn it is for are all still here.
    */
    { card: BOON_SATYR, count: 1 },
    { card: SECURE_THE_WASTES, count: 1 },
    /*
      Nissa, Voice of Zendikar for the second Rampant Growth, and this deck's second planeswalker.

      Three mana for a permanent that makes a blocker every turn, puts a +1/+1 counter on the whole
      board for −2, and at −7 draws and gains as much as you have lands. In a deck that already
      wants to stand still and go wide, the +1 alone is what the second Doomed Traveler was for and
      it never runs out.

      **The largest consistent reading a new card has had here, and still inside the floor.**
      Removing it is −15 on one seed set and −5 on the other over 270 paired duels: the same sign
      twice, which is more than most of these get, and both under the eighteen-game floor. So it
      ships as free with the number written down rather than as an improvement — and if the
      refreshed table moves this deck up, that is where it will show.

      The cut is the second Rampant Growth: six accelerants plus nineteen lands was the most
      redundant thing in the list, and a three-mana permanent is exactly what the second one was
      ramping towards. Cutting the Centaur Courser instead measured −6 and +1 — no consistent sign,
      so the instrument cannot tell the two cuts apart and the cards decided it.
    */
    { card: NISSA_VOICE_OF_ZENDIKAR, count: 1 },
    // The deck's answer to a board it is behind on, which nothing in the pool could do before.
    { card: DAY_OF_JUDGMENT, count: 1 },
  ],
};

// ── The two cards that change what a spell is pointed at ────────────────────────────────────────

const WILLBENDER: CardDef = {
  name: 'Willbender',
  typeLine: 'Creature — Human Wizard',
  manaCost: '{1}{U}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Morph {1}{U}\nWhen Willbender is turned face up, change the target of target spell or ability with a single target.',
  colors: ['U'],
};

const SWERVE: CardDef = {
  name: 'Swerve',
  typeLine: 'Instant',
  manaCost: '{1}{U}{R}',
  cmc: 3,
  oracleText: 'Change the target of target instant or sorcery spell with a single target.',
  colors: ['U', 'R'],
};

// ── The two cards that answer an ability ────────────────────────────────────────────────────────

/*
  An ability on the stack has never been answerable in this pool, and these two are what that half
  of interaction looks like: the narrow one that replaces itself, and the wide one that takes
  either kind of object.
*/

const SQUELCH: CardDef = {
  name: 'Squelch',
  typeLine: 'Instant',
  manaCost: '{1}{U}',
  cmc: 2,
  oracleText: 'Counter target activated ability.\nDraw a card.',
  colors: ['U'],
};

const DISALLOW: CardDef = {
  name: 'Disallow',
  typeLine: 'Instant',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  oracleText: 'Counter target spell, activated ability, or triggered ability.',
  colors: ['U'],
};

/*
  The two rebound cards, and why they go where they go.

  Rebound's price is a turn, so the keyword is worth most to a deck that was going to still be
  there next turn and worth least to one racing. Both of these are cheap spells in decks that
  already read "whenever you cast" or "whenever this deals damage" — so the second casting is not
  only a second spell, it is a second trigger on a different turn.
*/
const STAGGERSHOCK: CardDef = {
  name: 'Staggershock',
  typeLine: 'Instant',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Staggershock deals 2 damage to any target.\nRebound (If you cast this spell from '
    + 'your hand, exile it as it resolves. At the beginning of your next upkeep, you may cast this '
    + 'card from exile without paying its mana cost.)',
  colors: ['R'],
};

const DISTORTION_STRIKE: CardDef = {
  name: 'Distortion Strike',
  typeLine: 'Sorcery',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'Target creature gets +1/+0 and can\u2019t be blocked this turn.\nRebound (If you cast '
    + 'this spell from your hand, exile it as it resolves. At the beginning of your next upkeep, '
    + 'you may cast this card from exile without paying its mana cost.)',
  colors: ['U'],
};

/**
 * The buyback card: bounce anything, and keep the card if you can pay for it.
 *
 * Capsize is the keyword's clearest statement — {1}{U}{U} for a bounce is a fair rate and
 * {3} more to **keep the spell** is the whole mechanic, because what the extra mana buys is not a
 * better effect but the same effect again next turn, and the turn after that. A deck that reaches
 * six mana with this in hand has an answer it never runs out of.
 */
const CAPSIZE: CardDef = {
  name: 'Capsize',
  typeLine: 'Instant',
  manaCost: '{1}{U}{U}',
  cmc: 3,
  oracleText: "Buyback {3} (You may pay an additional {3} as you cast this spell. If you do, put this card into your hand as it resolves.)\nReturn target permanent to its owner's hand.",
  colors: ['U'],
};

/**
 * Buyback's other half of the bargain: a cheap cantrip whose buyback costs more than the card.
 *
 * One mana to draw a card is a filler spell; six mana to draw a card and keep the spell is a
 * **mana sink**, which is the other thing the keyword was printed to do. Where Capsize asks
 * whether an answer is worth keeping, this asks what a deck does with its eighth land.
 */
const WHISPERS_OF_THE_MUSE: CardDef = {
  name: 'Whispers of the Muse',
  typeLine: 'Instant',
  manaCost: '{U}',
  cmc: 1,
  oracleText: 'Buyback {5} (You may pay an additional {5} as you cast this spell. If you do, put this card into your hand as it resolves.)\nDraw a card.',
  colors: ['U'],
};

/**
 * The repeatable proliferate, and the reason the keyword is an engine rather than a trick.
 *
 * Two mana for a -1/-1 counter is a fair answer to a one-toughness creature. Four more and a tap,
 * every turn afterwards, grows every counter on the table that its controller wants grown — which
 * in an infect deck is the poison it has already dealt, and in any deck is whatever it has been
 * building.
 */
const CONTAGION_CLASP: CardDef = {
  name: 'Contagion Clasp',
  typeLine: 'Artifact',
  manaCost: '{2}',
  cmc: 2,
  oracleText: 'When Contagion Clasp enters the battlefield, put a -1/-1 counter on target creature.\n{4}, {T}: Proliferate. (Choose any number of permanents and/or players with counters on them, then give each another counter of each kind already there.)',
  colors: [],
};

/**
 * Proliferate at instant speed, with a card attached.
 *
 * The other shape the keyword comes in: once, for three mana, at the moment it is worth most — the
 * end of an opponent's turn, after the blocks are in and the counters are where they are going to
 * be. It replaces itself, which is what stops it being a card you regret drawing on an empty board.
 */
const STEADY_PROGRESS: CardDef = {
  name: 'Steady Progress',
  typeLine: 'Instant',
  manaCost: '{2}{U}',
  cmc: 3,
  oracleText: 'Proliferate, then draw a card. (Choose any number of permanents and/or players with counters on them, then give each another counter of each kind already there.)',
  colors: ['U'],
};

export const TIDAL_MIND: DeckSpec = {
  id: 'tidal-mind',
  name: 'Tidal Mind',
  description: 'Blue-black control. Counter what matters, kill what lands, and win in the air.',
  commander: TALRAND,
  cards: [
    /*
      Ten Islands' worth of blue and eleven Swamps' worth of black, where it used to be level.

      One land, and the only change in this deck's history that shipped without clearing the
      floor: +2 and +3 on two seed sets, which is nothing. It ships on the pips rather than on the
      number. After the rebuild at the bottom of this list the deck casts four double-black spells
      — three Nighthawks, a Murder, a Sedgemoor Witch and a Thorn of the Black Rose — against two
      double-blue, and nine black sources was already the thinner half before six more black cards
      arrived. The measurement's job here was only to show the swap costs nothing, and it did.
    */
    { card: ISLAND, count: 6 },
    { card: SWAMP, count: 8 },
    { card: DIMIR_GUILDGATE, count: 2 },
    { card: LONELY_SANDBAR, count: 2 },
    /*
      Two lands that are also creatures, for an Island and a Swamp.

      Twenty-one lands either way, so the mana is one source of each colour thinner and nothing
      else has moved. What it buys is the thing this deck's own notes keep coming back to: it
      survives and then has nothing to win with, and it floods doing it. A Zoetic Cavern is a land
      on the turn the hand is short of one and a {3} 2/2 on the turn it is not — the cheapest clock
      this deck has ever had, and the only card in the pool that is whichever of the two you need.
    */
    { card: ZOETIC_CAVERN, count: 2 },
    // A land that answers an attacker every turn and never taps for mana, which is a trade a
    // control deck is happy to make and nothing else in this pool is. It cost an Island, so the
    // deck is on twenty sources rather than twenty-one.
    { card: MAZE_OF_ITH, count: 1 },
    /*
      Three counterspells rather than six, and three more bodies in their place.

      Measured against the rest of the pool, this deck won 108 of 476 games — a fifth of them,
      where Ember Rush won three quarters. Nothing in it was dead: every card got cast in a
      majority of the games it reached hand, and the counterspells most of all. What it did not
      have was a way to *win* the games it survived, and the per-opponent split is what says so.
      Trading three counterspell copies for three cheap creatures is worth nothing at all against
      the two fastest decks — 3-31 against Ember Rush before and 3-31 after — and five to ten
      games each against every slower one, including beating Skyward Writ where it used to lose
      8-26. A deck that answers everything and kills nobody loses the long game to whoever draws
      a threat last.

      Cutting deeper measures better still: taking all four of the Counterspell and Negate copies
      for four bodies is worth another ten games. It is not shipped, because the only counterspells
      left to cut are the ones worth keeping — Counterspell itself, with Cancel costing a mana more
      for the same text, and Cancel and Soul Manipulation are this pool's only copies of their
      cards, so cutting them would orphan two scripts. The pool's structure sets where this stops,
      not the measurement.

      **The Counterspell did eventually go**, in the six-slot rebuild at the bottom of this list,
      and the reason it could is the reason it was kept twice: it is the one counterspell here that
      the pool holds four other copies of. Cancel, Disallow, Saw It Coming and Soul Manipulation are
      all still in the deck, so a hand of answers is still a hand of answers — what left was the
      fourth copy of a card the opponent has already seen.
    */
    // Three counters, none of them a second copy of another: a hand of answers should not be two
    // copies of one card.
    { card: CANCEL, count: 1 },
    /*
      Clone, which is the first card here that asks a question about the *whole* board.

      Every other mid-resolution question this engine asks looks in one of the chooser's own zones —
      your library, your hand, your graveyard. "Any creature on the battlefield" is a question about
      the table, and in a deck holding three counterspells and four removal spells the answer is
      usually whatever the opponent just resolved: the card is removal that leaves you the creature.

      It cost the second Cancel, the most replaceable counterspell this deck had at the time.
    */
    { card: CLONE, count: 1 },
    /*
      Disallow, and the Essence Scatter it replaced.

      The third counter in a deck that holds three, and the one that answers what nothing here
      could: an **ability** on the stack. Everything else in this pool answers the permanent and
      not what the permanent is doing — a Doom Blade kills the Icy Manipulator and not the tap it
      already activated, a Murder kills the Jace and not the loyalty ability above it. That is the
      whole reason this card is in the deck whose plan is answering things.

      The Essence Scatter went because Disallow does its job as well as the two others: "counter
      target creature spell" is a subset of "counter target spell, activated ability, or triggered
      ability", so the swap costs one mana and gains two halves of the stack. It was also this
      deck's least-cast card at 36% of the copies drawn over 96 games, which is the same number
      that cut the Negate before it.

      **The instrument could not price it, which D131 predicted.** 240 paired duels against the
      field, two seed sets: +8 one way and −10 the other, with no consistent sign — exactly the
      finding that the deck at the bottom of the table has the least reliable record in the pool,
      because a deck winning three games in ten wins most of them narrowly. So this ships on the
      rules argument rather than on a number, and the number is written down as unknown.
    */
    { card: DISALLOW, count: 1 },
    { card: DOOM_BLADE, count: 1 },
    /*
      The second Doom Blade's slot, spent on a **closer** rather than on another answer.

      This deck has never been short of removal — a Murder, an Agonizing Demise, two Man-o'-Wars,
      an Unsummon, a Turn to Frog and a Maze of Ith beside the Blade — and it has always been short
      of a way to finish. A Distortion Strike makes a Thieving Magpie connect, which draws a card,
      and rebound makes it connect again next turn for nothing: one mana, two unblockable attacks,
      on the two creatures in the deck that are *paid* for connecting.
    */
    { card: DISTORTION_STRIKE, count: 1 },
    // Removal that does not care what colour it is, which the Doom Blade does.
    { card: MURDER, count: 1 },
    { card: SAW_IT_COMING, count: 1 },
    // Not removal but time — and the only card here that answers something already resolved
    // without killing it.
    { card: UNSUMMON, count: 1 },
    { card: ICY_MANIPULATOR, count: 1 },
    // One Crypt rather than two: a second copy of a card that answers one deck in the pool does
    // nothing a first copy had not already done, and the slot is Tome Scour's.
    { card: TORMODS_CRYPT, count: 1 },
    // Five cards off the top for one mana, which is not what this deck is for — it is what makes
    // a Drake for free, and it is the spell Talrand's own test is written against.
    /*
      The two cards that needed layers, in the deck that wants tricks.

      Turn to Frog is the pool's first effect that *sets* power and toughness rather than adding to
      it — a 5/5 attacker becomes a 1/1 with no flying, no deathtouch and no trample for the turn,
      which is removal that costs two mana and leaves the body behind. Cackling Counterpart is its
      first copy effect: a second one of your own best creature, printed values only.

      They cost the Tome Scour, which belongs to Hollow Tide's plan rather than this one, and the
      second Preordain, which is the cheapest card in the deck to be holding one fewer of.
    */
    { card: TURN_TO_FROG, count: 1 },
    { card: CACKLING_COUNTERPART, count: 1 },
    // One mana that makes a creature untouchable by anybody, its own controller included — the
    // deck's way of protecting a flier it intends to win with, at the cost of never touching it
    // again.
    { card: ROBE_OF_MIRRORS, count: 1 },
    /*
      One wall, where there used to be two.

      The pair was deliberate and it is written down why: a Fog Bank blanks one attacker every
      combat for ever and never kills anything, a 0/7 blocks every creature in this pool, survives,
      and holds whatever it blocked down through the next untap step, so each is the better answer
      to a different board. The Bank went in the rebuild at the bottom of this list, and the Wall
      stayed, because the second half of that reasoning is the half that also wins a game: a
      permanent that stops a creature *for two turns* is a tempo card, and a permanent that stops
      one for ever while the game stays level is the deck's old problem written on a card.

      The Bank's script is still in the pool — three copies in Hollow Tide and one in Delta Bloom
      — so the prevention-replacement path it is the test case for is still walked.
    */
    { card: WALL_OF_FROST, count: 1 },
    { card: JACE_BELEREN, count: 1 },
    { card: OMENSPEAKER, count: 1 },
    /*
      Behold the Multiverse for the Divination, and Saw It Coming for the Essence Scatter: the two
      foretell cards, in the deck foretell is for.

      This list's documented problem is that holding mana for an answer is its whole plan and the
      computer cannot do it. Foretell is the mechanic that turns that into something anybody can
      do: {2} on a turn with nothing else to spend it on, and then the spell for {1}{U} or {U}{U}
      on a turn when it matters.

      Behold the Multiverse is a Divination that also scrys and costs less when it was paid for in
      advance. Saw It Coming is a universal counterspell, and the slot it takes is **the second
      Murder** rather than the Essence Scatter it most resembles — which is a measurement and not a
      preference. Cutting the Essence Scatter cost this deck 13 and 8 games on two seed sets (D127):
      a {1}{U} answer to a creature is worth more to it than a {1}{U}{U} answer to anything, and
      trading the cheap one away is the opposite of what its record asks for. A three-mana
      counterspell for a three-mana removal spell is the trade that leaves the curve alone.

      **One of the two foretell cards is gone and the mechanic is not.** The rebuild at the bottom
      of this list took the Behold the Multiverse — four mana spread over two turns to draw two
      cards, in a deck whose diagnosis was that it draws cards instead of winning — and kept the
      Saw It Coming, which is the half of foretell this deck was built around: an answer paid for
      on a turn with nothing else to spend the mana on. Arc Tempest still runs a Behold, so the
      draw-and-scry half of the mechanic is still cast and still tested; what left this list was
      the copy whose own cast rate here was 48%. The Mind Spring went with it, for the same reason
      and with less to say about it: {X}{U}{U} to draw X is the most mana this deck can spend on
      nothing happening.
    */
    { card: EXSANGUINATE, count: 1 },
    /*
      Dirgur Nemesis for the Sign in Blood: a 2/2 on turn three that becomes a 2/6 when it has to.

      The card this deck wanted and the pool did not have. Its documented loss is to the fastest
      red deck, 0-15 at the time, for want of anything that can stand in front of a creature twice
      — and morph is how a five-mana wall gets onto the board on turn three. Turning it up is also
      the one trick in the deck that cannot be answered: a 2/2 holding two damage goes to 2/6 and
      lives, because turning face up is not a new object and the damage stays where it was.

      Sign in Blood rather than a counterspell or a removal spell, because two cards for two life
      is the most replaceable thing in a deck already holding a Phyrexian Arena, a Divination, a
      Mind Spring and a Read the Bones' worth of drawing. The script keeps its other home.
    */
    { card: DIRGUR_NEMESIS, count: 1 },
    { card: MIND_ROT, count: 1 },
    { card: SOUL_MANIPULATION, count: 1 },
    /*
      Think Twice for the second Soul Manipulation: a cantrip you cast twice is better in the long
      games this deck wants than a second three-mana counterspell that only answers creatures. It
      sits beside the Cackling Counterpart above, which is the other card here with flashback —
      both slots are in this deck so one measurement covers the mechanic.
    */
    /*
      Mulldrifter for the Think Twice: the same slot played twice, and the player picks which.

      Evoke is the first alternative cost in this engine that changes what happens *after* the
      spell resolves (D194), and this deck is where the choice it offers is worth the most. Its
      diagnosis has not moved since `killed-by.mjs` read it: it answers four or five things and
      kills nobody, and what it does on a turn with three mana and nothing to answer is draw a
      card and pass. A Mulldrifter is that turn's Divination for {2}{U} and, on a turn the game
      has gone long, five mana for a 2/2 flier that draws two — one slot doing the deck's two
      jobs rather than one of them twice.

      The Think Twice is the right slot for it because it is the other card here that draws a card
      and does nothing else, and because Arc Tempest runs two copies of it: the flashback path
      keeps a home, which is what the pool's own structure asks before any slot is cut.
    */
    { card: MULLDRIFTER, count: 1 },
    /*
      Willbender for the Dive Down, which is one trick for another and not an even trade.

      The Dive Down saves a creature; this saves a creature *and* is one. Face down for {3} it is a
      2/2 blocker on a turn this deck has nothing else to do, and turned up for {1}{U} it sends the
      removal that was aimed at that blocker somewhere else entirely — which is the half D114 said
      this deck was short of, since a deck that answers everything and kills nobody loses the long
      game. It is also the third morph here, after two Zoetic Caverns and a Dirgur Nemesis, so a
      face-down 2/2 on this side of the table is already a question the opponent cannot answer.

      Dive Down stays in Skyward Writ, so the protection trick and the bot rule that fires it are
      both still exercised.
    */
    { card: WILLBENDER, count: 1 },
    { card: RAVENOUS_RATS, count: 1 },
    /*
      Ophidian for the Child of Night, and the Wall of Frost below for a Fog Bank.

      A 2/1 lifelink was the weakest card in a deck that wins on cards rather than on life: it
      trades with everything in the pool and gains two doing it. A 1/3 that draws when it gets
      through is the same two mana spent on the plan the rest of the deck is built around — and it
      asks a real question every time it attacks, which the 2/1 never did.
    */
    { card: OPHIDIAN, count: 1 },
    { card: WIND_DRAKE, count: 1 },
    /*
      The other two bodies the counterspell cuts paid for, and the deck's clock.

      A third Man-o'-War because it is the card this deck gets the most out of — a body *and* an
      Unsummon on the same card, which buys the turn and then attacks — and a second Nighthawk
      because deathtouch, flying and lifelink is the one creature in these colours that both holds
      the ground against anything and wins the game on its own if the game goes long.
    */
    { card: MAN_O_WAR, count: 1 },
    /*
      The second Man-o'-War's slot, spent on **cumulative upkeep** — and the payer is the honest
      problem with this probe.

      There is no card in this deck that does nearly what a Mystic Remora does at nearly its price,
      so this slot cannot read the keyword the way the Rift Bolt and Search for Tomorrow slots do: a
      {U} draw engine against a {2}{U} body-and-a-bounce is two different good cards rather than one
      card twice. The direction is at least the honest one — the Remora has to beat a card this deck
      is known to get a lot out of, which makes the reading conservative rather than flattering, and
      D215 prices it against a second and much more marginal payer to bracket it.
    */
    { card: MYSTIC_REMORA, count: 1 },
    /*
      Chalice of the Void, for the third Man-o'-War.

      The card this deck has never had: an answer that costs two mana *once* and then answers
      every one-mana spell for the rest of the game. The arithmetic is why it is here rather than
      anywhere else in the pool — Tidal Mind casts four one-mana spells of its own, and the field
      it is measured against casts twenty-two in Ember Rush, fifteen in Verdant Guard and thirteen
      each in Forge Alliance and Arc Tempest. It is symmetrical and it does not care: a Chalice on
      one costs this deck a Preordain and costs the deck opposite its first three turns.

      `{X}{X}` is one number paid twice, the charge counters are X rather than the mana value, and
      the trigger is an intervening-if clause so a spell it would not counter never puts anything
      on the stack. See the script in `scripts.ts` for all three.
    */
    { card: CHALICE_OF_THE_VOID, count: 1 },
    /*
      A third Vampire Nighthawk, paid for by cutting the Diabolic Tutor above, and it is the
      biggest single measurement in this deck's history: **+27 of 264**, with nine of the eleven
      matchups up, two level and **not one down**.

      The Tutor was this deck's deadest card — cast in 8 of the 46 games it was in hand, 17% — and
      why is the whole diagnosis. Four mana for a card you then have to cast is a turn spent doing
      nothing, and a deck that spends turns doing nothing against this field dies holding answers.
      The Nighthawk is the opposite card: three mana, flies, kills whatever it blocks, gains the
      life back, and it is the only creature in these colours that is a clock and a wall at once.
      The Tutor's script keeps a home in Hollow Tide, where a tutor has two cards worth finding.

      **Counted in place rather than appended**, which matters more than it looks: `deck-probe`
      builds its variant by adjusting counts where the entries already are, and a library is
      expanded in list order *before* it is shuffled — so the same sixty cards written in a
      different order shuffle differently and measure differently. Moving this entry to the
      Tutor's slot was worth sixteen games of nothing at all.
    */
    { card: VAMPIRE_NIGHTHAWK, count: 3 },
    { card: AIR_ELEMENTAL, count: 1 },
    /*
      Six slots at once: the change that worked after twelve that did not.

      `killed-by.mjs` said what was wrong in one line. Of the games this deck lost, almost none
      were lost to running out of cards or out of time — they were lost to combat damage, on a
      turn by which the deck had answered four or five things and killed nobody. So the fix was
      never in doubt. **Finding a fix the instrument could see was.**

      Twelve changes were priced one and two slots at a time, and all twelve read as nothing:
      a second Air Elemental −14, a second Exsanguinate 0, a Fog Bank cut −2, a Wall of Frost cut
      +4, one Thieving Magpie for one Counterspell −14, and the best of them — two Magpies for a
      Counterspell and a Cancel — read +6, +37, +23 and −6 across four seed sets of 288 duels. The
      same four seed sets measure the *unchanged* list at 83, 64, 88 and 90 wins, so a swing of
      twenty games is what this instrument does when nothing has changed at all. Eleven of the
      twelve probes were inside that.

      Six slots are not. On two seed sets the rebuild is **+47 (83-205 to 130-157) and +38 (64-224
      to 102-186)**, with 22 of the 24 per-opponent splits level or up, and it is the first change
      in this deck's history that beats Forge Alliance (3-21 to 12-12) and Rot Harvest (9-15 to
      17-6). As a win rate against the field: 29% to 45%.

      **Split in half it disappears again**, which is the finding worth keeping. Magpies and the
      Witch alone, for the Twincast, the Arena and the Counterspell: +8 and +20. Aerialists and the
      Thorn alone, for the Behold, the Mind Spring and the Fog Bank: +12 and +19. Each half is
      inside the floor; together they are more than the two of them added up. A deck that loses for
      want of a clock does not have a slot wrong with it — it has a *shape* wrong with it, and a
      shape is not priceable one card at a time. That is why eleven probes found nothing: they were
      all asking a question whose answer is no.

      What the six cards are, in the order they were added:

      - **Two Thieving Magpies.** A 1/3 flier that draws a card when it connects — the only card in
        these colours that is the clock and the card advantage on one body, which is exactly the
        trade this deck kept getting wrong by playing the two separately.
      - **A Sedgemoor Witch.** 3/2 menace, ward {3}, and a 1/1 for every instant or sorcery cast.
        The deck still holds fifteen of those, so the Witch is the one card here whose body grows
        out of the half of the deck that was already working.
      - **Two Bloodthirsty Aerialists.** A 2/2 flier for three that takes a +1/+1 counter whenever
        you gain life, and three Vampire Nighthawks and an Exsanguinate are the lifegain. It is the
        deck's first card that gets *bigger* for playing its own game.
      - **A Thorn of the Black Rose.** 2/3 deathtouch, and the monarch (CR 720). A deck with a 0/7
        wall, four fliers and five removal spells is the deck in this pool best placed to keep the
        crown, and the crown is a card every turn for no mana — the Phyrexian Arena's job, done by
        something that also blocks.

      **Two of the six cuts had to find homes first.** Twincast and Phyrexian Arena were the pool's
      only copies of their cards, and cutting the last copy of a card deletes a script's only test.
      So they moved rather than went: the Twincast to Arc Tempest for a second Behold the
      Multiverse (+3 and +2 — free, and the deck whose whole plan is casting spells is a better
      home for a card that copies one), and the Arena to Ashen Rite for its Sedgemoor Witch (0 and
      −12, which is the price of this change and it is paid by the *strongest* deck in the field, so
      the pool's spread narrows at both ends).

      That constraint is this deck's own doing, and it is worth writing down: **nineteen of Tidal
      Mind's forty-one card slots are the pool's only copy of that card.** It is where every card
      nobody else wanted ended up, which is why its ten least-cast cards — the Twincast at 20%, the
      Arena at 44%, the Turn to Frog, the Clone, the Cackling Counterpart, the Robe of Mirrors —
      could not simply be cut. The deck at the bottom of the table was the deck holding the pool's
      script coverage hostage.
    */
    { card: THIEVING_MAGPIE, count: 1 },
    /*
      Capsize for the second Thieving Magpie, and the slot was moved once after being measured.

      It went in for the second **Man-o'-War** first, which reads like the fairer comparison — a
      bounce for a bounce, both at three mana — and measured **+23 and +12 of 288 against the deck**
      on two seed sets. Re-priced against the Magpie it reads **+12 and +4**: the same card, the
      same deck, the same seeds, and half the loss. What the first arrangement was mostly measuring
      was the 2/2 body that comes with a Man-o'-War's bounce, which is the rule D207 wrote down and
      this is the second card to need it.

      Still a loss and kept anyway, inside the floor on the arrangement that stands: six mana to
      bounce one permanent is a slow play against an aggressive field, and what it buys — never
      running out of the answer — is a long game this pool rarely reaches. See D211.
    */
    { card: CAPSIZE, count: 1 },
    { card: SEDGEMOOR_WITCH, count: 1 },
    { card: BLOODTHIRSTY_AERIALIST, count: 2 },
    { card: THORN_OF_THE_BLACK_ROSE, count: 1 },
    /*
      The Preordain, back where it was, because the card that replaced it did not earn the slot.

      A Treasure Cruise went here for one night: three cards for {U} once the graveyard is deep,
      against one card deeper for {U}. The probe disagreed four times — **−9, −1, −4 and −3** of
      288 on four seed sets, every set the same sign — and four negatives out of four is a verdict
      even when each one is inside the floor.

      The reason is in the mana base rather than in the card. This deck runs **six Islands** and
      eight Swamps, so a {U} on turn four is not a given; and its graveyard is already spoken for
      by a Think Twice that wants to be cast out of it. Delve works in the deck whose graveyard
      nothing else is spending — which is Hollow Tide, where the Gurmag Angler measured +17 and +2,
      and where the Cruise now lives.
    */
    { card: PREORDAIN, count: 1 },
  ],
};

// ── The three tribal lords ──────────────────────────────────────────────────────────────────────

/*
  One card each for the three deepest creature types in the pool, in the three decks that have
  them. Together they are what makes a subtype-scoped static effect worth having: a size, two
  keywords, and a lord that makes more of its own tribe.
*/

const STROMKIRK_CAPTAIN: CardDef = {
  name: 'Stromkirk Captain',
  typeLine: 'Creature — Vampire Soldier',
  manaCost: '{R}{B}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'First strike\nOther Vampire creatures you control get +1/+1 and have first strike.',
  colors: ['R', 'B'],
};

const KNIGHT_EXEMPLAR: CardDef = {
  name: 'Knight Exemplar',
  typeLine: 'Creature — Human Knight',
  manaCost: '{1}{W}{W}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Other Knight creatures you control get +1/+1 and have indestructible.',
  colors: ['W'],
};

const IMPERIOUS_PERFECT: CardDef = {
  name: 'Imperious Perfect',
  typeLine: 'Creature — Elf Warrior',
  manaCost: '{2}{G}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Other Elf creatures you control get +1/+1.\n{1}{G}, {T}: Create a 1/1 green Elf Warrior creature token.',
  colors: ['G'],
};

// ── The two cards that ask for a word ───────────────────────────────────────────────────────────

/*
  A creature type and a colour, each chosen as the card enters. See `scripts.ts` for why that is
  the resolution and not a trigger.
*/

const OBELISK_OF_URD: CardDef = {
  name: 'Obelisk of Urd',
  typeLine: 'Artifact',
  manaCost: '{5}',
  cmc: 5,
  oracleText: 'Convoke\nAs Obelisk of Urd enters the battlefield, choose a creature type.\nCreatures you control of the chosen type get +2/+2.',
  colors: [],
};

const VOICE_OF_ALL: CardDef = {
  name: 'Voice of All',
  typeLine: 'Creature — Angel',
  manaCost: '{3}{W}',
  cmc: 4,
  power: '2',
  toughness: '2',
  oracleText: 'Flying\nAs Voice of All enters the battlefield, choose a color.\nVoice of All has protection from the chosen color.',
  colors: ['W'],
};

// ── The two keywords that point at another creature ─────────────────────────────────────────────

/*
  Exalted and evolve: the first two cards in the pool whose text is about a creature that is not
  them. Everything else that watches the board talks about itself or about a player — these two
  have to say "that creature", which is the whole reason they are here.
*/

const GUARDIANS_OF_AKRASA: CardDef = {
  name: 'Guardians of Akrasa',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{2}{W}',
  cmc: 3,
  power: '2',
  toughness: '3',
  // The reminder text in brackets, as printed, which is also what keeps the keyword parser off it:
  // only a line that is nothing but keywords is read as keywords, and "Defender" is on its own.
  oracleText:
    'Defender\nExalted (Whenever a creature you control attacks alone, that creature gets +1/+1 until end of turn.)',
  colors: ['W'],
};

const CLOUDFIN_RAPTOR: CardDef = {
  name: 'Cloudfin Raptor',
  typeLine: 'Creature — Bird Mutant',
  manaCost: '{U}',
  cmc: 1,
  power: '0',
  toughness: '1',
  oracleText:
    'Flying\nEvolve (Whenever a creature enters the battlefield under your control, if that creature has greater power or toughness than this creature, put a +1/+1 counter on this creature.)',
  colors: ['U'],
};

const STRIONIC_RESONATOR: CardDef = {
  name: 'Strionic Resonator',
  typeLine: 'Artifact',
  manaCost: '{2}',
  cmc: 2,
  // The printed text, including the clause the script does not offer — see its comment in
  // `scripts.ts`. A card that said less than it says would be a worse lie than a documented gap.
  oracleText: '{1}, {T}: Copy target triggered ability you control. You may choose new targets for the copy.',
  colors: [],
};

/**
 * A body that feeds a sacrifice outlet and then comes back out of the graveyard to be fed again.
 *
 * A creature on purpose. The first card written for this slot was a dredge **land**, and the
 * instrument said it was offered three times in 96 games: a dredge card only works from the
 * graveyard, and nothing in this pool destroys a land. A creature in the sacrifice deck reaches a
 * graveyard every game — by its own ability if nothing else obliges.
 */
const SHAMBLING_SHELL: CardDef = {
  name: 'Shambling Shell',
  typeLine: 'Creature — Plant Zombie',
  manaCost: '{1}{B}{G}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Sacrifice Shambling Shell: Put a +1/+1 counter on target creature.\nDredge 3 (If you would draw a card, you may mill three cards instead. If you do, return this card from your graveyard to your hand.)',
  colors: ['B', 'G'],
};

/**
 * One mana for -1/-1, and then one mana for -1/-1 again next turn, and the turn after.
 *
 * The removal spell dredge was printed for: it kills almost nothing on its own and never runs out,
 * so a board of one-toughness creatures is answered by a single card and three draws. In this pool
 * that is Glistener Elf, Blight Mamba, Llanowar Elves, Monastery Swiftspear and every token — which
 * is why it goes in the deck that wants its own attackers to get through.
 */
const DARKBLAST: CardDef = {
  name: 'Darkblast',
  typeLine: 'Instant',
  manaCost: '{B}',
  cmc: 1,
  oracleText: 'Target creature gets -1/-1 until end of turn.\nDredge 3 (If you would draw a card, you may mill three cards instead. If you do, return this card from your graveyard to your hand.)',
  colors: ['B'],
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
    { card: DRUDGE_SKELETONS, count: 1 },

    { card: GOLGARI_CHARM, count: 2 },
    /*
      **Young Wolf, for the Naturalize**, and it is the sacrifice deck's half of undying.

      One mana for a 1/1 that comes back as a 2/2 the first time it dies, in the deck with a Vampire
      Aristocrat, a Bloodthrone Vampire and a Lotleth Giant in it: a body that can be spent twice is
      two activations of an outlet for one card, and the fodder fix (D175) means the bot now reaches
      for the cheap end of the board when it feeds one. The Naturalize was the slot because it is
      this deck's second-least-cast card at 70%, and because Blight Vector keeps the pool's other
      copy — the artifact-and-enchantment answer is covered either way.

      **It measured −36 and −10 on its revert**, which is the largest single-card result this pool
      has produced: 142 wins of 288 with it and 106 without, on the same seeds. The card is one
      mana; the number is the deck.
    */
    { card: YOUNG_WOLF, count: 1 },
    { card: BLOSSOMING_DEFENSE, count: 1 },
    /*
      The pool's first tribal lord, and the deck that has the Elves for it.

      Four Elves and a commander who is one, which is not a tribe so much as a rumour — except that
      the lord makes more. Every token it taps for is an Elf Warrior, so it grows its own scope, and
      in a deck built on feeding creatures to a Blood Artist a repeatable body is worth more than
      the +1/+1: this is a sacrifice outlet's fuel supply that happens to pump the Llanowar Elves.

      **The cut was measured twice, and the first answer was wrong.** It went in for the Blossoming
      Defense first — this deck's least-cast card that can be cut without orphaning a script, since
      Grim Discovery, Raise Dead, Lhurgoyf, Hurricane and Zombify are each the pool's only copy —
      and that arrangement measured +2 on one seed set and -8 on the other, which is a change that
      has not been measured but sampled twice. Taking the **third Blood Artist** instead measures
      +4 and +13 against it. Three Blood Artists is one more than the deck needs to find one; the
      Blossoming Defense is the only card in the list that answers a removal spell. See D129, and
      D127 for the rule that says to ask this question separately.
    */
    { card: IMPERIOUS_PERFECT, count: 1 },
    { card: ENDLESS_ONE, count: 1 },
    /*
      Shambling Shell for the second Endless One: a creature for a creature, and the deck that can
      actually use a dredge card.

      Three mana for a 2/2 that sacrifices itself to grow something, in a list with a Blood Artist,
      a Zulaport Cutthroat and two sacrifice outlets in it — so the body is spent on purpose and
      lands in the graveyard, which is the only place a dredge card does anything. After that every
      draw step offers it back for three cards off the top, in the deck that wanted a full graveyard
      anyway. See D210.
    */
    { card: SHAMBLING_SHELL, count: 1 },
    { card: BLOOD_ARTIST, count: 1 },
    { card: ZULAPORT_CUTTHROAT, count: 1 },
    /*
      Strionic Resonator for the second Basilisk Collar, and this is the deck for it.

      {2} for the artifact and {1} and a tap to copy a triggered ability you control — and this
      deck is built out of triggers: a Zulaport Cutthroat on every death, a Doomed Dissenter that
      leaves a Zombie behind, a Wall of Blossoms and a Gravedigger and a Fleshbag Marauder and a
      Lotleth Giant as they arrive. Copying any of those is a second card out of one, every turn
      there is one worth copying.

      **It measures as nothing, and it is used.** Removing it is +4 on one seed set and −2 on the
      other over 270 paired duels: no consistent sign, which is this instrument saying the card is
      free. The half of that worth saying out loud is that the bot is not ignoring it — over 108
      games it cast the Resonator in 19 of the 20 games it drew one and activated it 14 times, so
      the number is a measurement of the card rather than of a card nobody touched.

      The cut is the Collar rather than an Endless One: cutting one of those instead measured −1
      and −5, which is worse on both sets though also inside the floor. Two copies of an equipment
      is the most redundant thing in a deck whose creatures are meant to die.
    */
    { card: STRIONIC_RESONATOR, count: 1 },
    /*
      Obelisk of Urd for the second Blood Artist, and the first card here that asks a question
      whose answer is a word.

      Convoke makes a five-mana artifact a turn-three play on a board of creatures, and +2/+2 for a
      whole creature type turns this deck's row of 0/1s and 1/1 tokens into a board that attacks.
      Which type is the card: Imperious Perfect keeps making **Elf** Warriors, so the Obelisk gets
      better every turn it is left alone, and the engine's own opponent picks whichever type it
      controls most of rather than being told one.

      The second Blood Artist went because it was the lowest-cast card in the deck with a copy to
      spare — 66% of the copies drawn over 96 games — and because one is enough to find one: the
      drain is a floor, and this deck's problem is that the floor is all it has.

      Measured against the field twice, 240 paired duels each: 101-138 and 100-140 with the
      Obelisk against 97-142 and 103-137 without, so +4 one seed set and −3 the other. No
      consistent sign and both arms far inside the eighteen games this instrument can resolve,
      which is the honest reading — the swap is free, and free is all a new primitive's card has to
      be.
    */
    { card: OBELISK_OF_URD, count: 1 },
    /*
      Consulate Dreadnought, for the second Zulaport Cutthroat.

      Crew is a cost paid in creatures tapped out of the combat they are joining, so it is cheapest
      for whoever has the most of them — and this deck's whole plan is a board of small bodies it is
      happy to lose. A **7/11 for one mana** crewed by creatures it was going to sacrifice anyway is
      the single largest thing anybody in this pool can put on the table, and is unplayable in six
      of the other seven decks.

      One Vehicle here rather than three, which is a measurement and not a preference: all three in
      this list cost the deck 7 and 20 games on two seed sets of 238 (see D125). The Dreadnought is
      the one with the ratio — seven power of attack for four power of tapping — and the two cheaper
      ones went to Forge Alliance, whose creatures are tokens.

      The second Zulaport Cutthroat was the cut: a second drain-on-death behind three Blood Artists.
    */
    { card: CONSULATE_DREADNOUGHT, count: 1 },
    { card: DOOMED_DISSENTER, count: 2 },
    { card: WALL_OF_BLOSSOMS, count: 2 },
    { card: FLESHBAG_MARAUDER, count: 2 },
    { card: VAMPIRE_ARISTOCRAT, count: 2 },
    { card: GRAVEDIGGER, count: 2 },
    { card: BASILISK_COLLAR, count: 1 },
    { card: BLOODTHRONE_VAMPIRE, count: 1 },
    { card: RAISE_DEAD, count: 1 },
    { card: GRIM_DISCOVERY, count: 1 },
    { card: ZOMBIFY, count: 1 },
    { card: DOOM_BLADE, count: 1 },
    { card: LOTLETH_GIANT, count: 1 },
    // Green's X spell. It hits its own controller too, which is the card: a deck of ground
    // creatures pays nothing and a table of fliers pays everything. One copy rather than two
    // since the Lhurgoyf below took the slot — a four-mana creature that grows all game is a
    // better use of it in a deck that fills graveyards on purpose.
    { card: HURRICANE, count: 1 },
    { card: LHURGOYF, count: 1 },
    { card: CENTAUR_COURSER, count: 1 },
    // One copy, for the same reason as the Grizzly Bears in Verdant Guard: the graveyard tests
    // build their boards out of this deck and need a plain creature to bury.
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
    { card: ELITE_VANGUARD, count: 1 },
    /*
      The second Vanguard's slot, spent on **modular**.

      Both are one-mana creatures and the trade is the keyword: a 2/1 that hits harder now against a
      1/1 whose counter outlives it. In a deck with four other artifact creatures to catch it, the
      Worker is the one that is never quite a clean trade for the opponent. See D221.
    */
    { card: ARCBOUND_WORKER, count: 1 },
    /*
      Affinity, in the one deck in the pool that can pay it: one card, for one Monastery Swiftspear,
      with the land count untouched (D228).

      **That shape is a measurement, and the first two attempts at it were wrong.** Affinity was
      written with both of its famous bodies — Frogmite and the {7} Myr Enforcer — and they were
      paid for with one Swiftspear and one Plains, on the argument that a deck whose spells get
      cheaper as the board fills needs fewer lands. That argument is true of an affinity deck and
      false of this one. Sixteen of these sixty cards are artifacts, but the curve is twelve
      one-drops and seven four-drops, and the cards affinity makes cheaper were two of sixty: the
      archetype's land count does not transfer to a deck that merely contains the keyword. The
      paired probe priced it at −23 games of 288 on one seed set, and restoring the land recovered
      nineteen of them.

      So: one card in, one card out, twenty-one lands either way. What `cast-counts` pointed at is
      **Serra Angel** (45%) and **Elite Vanguard** (49%), and neither is takeable, because both are
      named by tests that place them out of *this* deck's library — the crew tests pay "crew 2" with
      the Angel's four power and the Gift tests enchant the Vanguard. A Swiftspear is the honest
      price instead: prowess wants a hand full of spells, and this is a deck of artifacts.

      The Frogmite is an artifact itself, so it feeds the Ravager, the Etched Champion's metalcraft
      and its own cost.
    */
    { card: FROGMITE, count: 1 },
    { card: MONASTERY_SWIFTSPEAR, count: 1 },
    // Both copies: a vehicles test crews a Sky Skiff with two of them, and `playout.test.ts`
    // watches one die for its Spirit.
    { card: DOOMED_TRAVELER, count: 2 },
    { card: LEONIN_SKYHUNTER, count: 1 },
    /*
      The second Skyhunter's slot, spent on the card the Ravager had nothing to eat without.

      Paid from a two-of on purpose, and the reason is a lesson this project has already paid for
      twice: `arena()` places a card by finding it in that seat's **library**, so a test naming a
      card in this deck breaks the moment the deck stops carrying it. Every one-of that the usage
      instrument offered is named by a test somewhere — the Angelic Gift and Firemane Avenger
      included — and cutting a copy of a two-of leaves the card in the library and every test
      standing.

      It is also a **hard** payer rather than a convenient one, which is the discipline D211 asks
      for: same mana value as the Wellspring, and the bot casts a Skyhunter in 96% of the games it
      holds one. The dead slot the instrument actually pointed at is Disrupt Decorum — 0 casts in
      144 games — and it stays, because it is the pool's only goad card and goad is a mechanic only
      a pod can use. A duel measurement is not a reason to delete the pod's card.

      What the Wellspring buys that a 2/2 flier does not is a cost this deck could not pay. See D223.
    */
    { card: ICHOR_WELLSPRING, count: 1 },
    // A two-drop that wins the fight it is in rather than trading, which is what a board of small
    // creatures is short of — and the first first-striker in the pool.
    { card: YOUTHFUL_KNIGHT, count: 1 },
    /*
      **Mentor**, in the deck with the most attackers in the pool.

      It replaced a **Firebrand Archer** (63% of the games it was in hand, 20 casts in 96) — a
      two-mana 1/2 that pings for each noncreature spell, in a deck that casts about four of them a
      game. A two-mana 2/1 first striker that puts a permanent +1/+1 counter on a smaller attacker
      every time it swings is the same slot spent on what this deck actually does: Elite Vanguards,
      Doomed Travelers and the Soldier tokens from Raise the Alarm and Secure the Wastes are all
      smaller than a 2/1. Measured at **29 casts in 96 games**.
    */
    { card: SUNHOME_STALWART, count: 1 },
    /*
      Two colourless {X}{X} artifacts, for a Firebrand Archer and a Monastery Swiftspear.

      This deck's plan is a board of small creatures and a sword for one of them, which makes it
      the right home for both: a **Walking Ballista** is a creature on any curve, a mana sink on
      the turns the hand is empty, and — the half no other card here has — removal that can be
      aimed at an X/1 without spending a card, because the counter is the cost. A **Hangarback
      Walker** is the same arrival and the opposite end of the trade: it grows instead of shooting,
      and when it dies it leaves a Thopter for every counter, which is a board of small creatures
      for the Loxodon Warhammer to pick up. The slots came from the places this deck was deepest:
      a third Swiftspear and a second Archer, both of which it has plenty of.
    */
    { card: WALKING_BALLISTA, count: 1 },
    { card: HANGARBACK_WALKER, count: 1 },
    /*
      Metalcraft, in the deck that already controlled ten artifacts and counted none of them.

      Three cards for three slots, and the three slots are the argument. The deck ran **two**
      Ajani's Pridemates on incidental lifegain (65% cast, the weakest creature slot), a Disenchant
      against a pool with four enchantments in it (69%, the same complaint that priced Wane), and a
      **second** Hellrider — four mana for a 3/3 is a lot of top end for a deck now adding a
      three-mana 4/4 and a one-mana burn spell. All three keep other homes in the pool.

      Chrome Steed and Etched Champion are both artifacts themselves, so the count goes from ten to
      twelve rather than staying put: the cards that want the condition are part of meeting it,
      which is how the printed mechanic is meant to work. The Champion is the one worth reading
      twice — a 1/1 that no coloured removal in this pool can target, block or damage while three
      artifacts are out, in a deck whose Equipment wants a creature that survives.
    */
    { card: CHROME_STEED, count: 1 },
    { card: ETCHED_CHAMPION, count: 1 },
    // One damage, or four with the condition met — read as it resolves, so answering an artifact in
    // between turns it back into a Shock.
    { card: GALVANIC_BLAST, count: 1 },
    /*
      Myriad, for **Ajani's Pridemate** (D229).

      The slot is the cheapest one in the deck by the standard D228 arrived at the hard way, and
      this is the first time that standard has been applied before the fact rather than after: an
      audit of what every test in the repository names found the Pridemate referenced by **nothing
      at all**, and it keeps two other homes in the pool (Verdant Guard and Dawn Tithe both run it),
      so taking this copy costs the engine no card. It is also the right card to cut on its own
      terms — a 2/2 that grows on lifegain, in a deck whose lifegain is two Equipment and a
      Warhammer.

      What it buys is a card that is **blank in a duel and frightening at four seats**, which is
      something this pool has never had. Three mana and equip {3} is a real price for an effect that
      does nothing at all in half the games this deck plays; whether that trade is worth a slot is
      a question for the pod instrument rather than for this comment.
    */
    { card: BLADE_OF_SELVES, count: 1 },
    { card: SERRA_ANGEL, count: 1 },
    /*
      The second Angel's slot, spent on **vanishing**.

      The fairest payer this deck has for a 5/5 with shroud and three turns on it: both are the big
      white body the curve tops out on, both are cast with the deck's whole turn, and the choice
      between them is the one the keyword is about — four mana for more power that cannot be
      answered and does not stay, against five for less power that flies and does. The mana
      difference is a mana and is written here rather than hidden, because a slot's number is a fact
      about what paid for it. See D217.
    */
    { card: CALCIDERM, count: 1 },
    // The card this deck was already built for: every small creature it plays is another damage
    // on the swing, and the tokens from Raise the Alarm and Secure the Wastes count too. A
    // Whispersilk Cloak was measured against this slot over four seed sets and lost 52 games of
    // 1152 — the write-up is D178.
    /*
      **Battalion**, and a like-for-like swap: it replaced this deck's **Hellrider** (28%, 7 casts
      in 96), which is the pool's second copy — Ember Rush keeps the other, and keeps the deck
      that wants a haste body more than a trigger.

      Four mana for a 3/3 flier that, on any turn three creatures attack, throws three damage
      anywhere and gains three life. The condition is the deck rather than a build-around: between
      Raise the Alarm, Secure the Wastes and the Thopters a Hangarback leaves behind, three
      attackers is an ordinary turn here. Measured at **25 casts in 96 games**, every game it was
      in hand.
    */
    { card: FIREMANE_AVENGER, count: 1 },
    { card: BONESPLITTER, count: 1 },
    /*
      The two cheap Vehicles, in the deck whose creatures are tokens.

      Crew is paid in creatures tapped out of the combat they are joining, so the question a Vehicle
      asks is whether the body it puts in is worth more than the bodies it takes out — and a deck
      that makes 1/1 Soldiers is the one with the best answer. Two Soldiers crew a Renegade
      Freighter into a 5/4 with trample; the same two Soldiers attacking are two damage into a
      blocker.

      A Vehicle is also the one thing in this list that a sweeper cannot touch, which matters in a
      deck whose board is wide and small.

      For the second Bonesplitter (a +2/+0 behind a Loxodon Warhammer and a Darksteel Plate) and the
      second Youthful Knight (a 2/1 first striker whose job the Sky Skiff does with flying). Both
      keep their other homes.
    */
    { card: SKY_SKIFF, count: 1 },
    { card: RENEGADE_FREIGHTER, count: 1 },
    { card: LOXODON_WARHAMMER, count: 2 },
    // The deck's only answer to an Equipment or an enchantment, which is what a board of swords
    // is most afraid of. Two Banishing Lights and no Disenchant since the metalcraft slots: the
    // Light answers any nonland permanent, which is the half of the job this pool actually needs.
    { card: BANISHING_LIGHT, count: 2 },
    { card: BASILISK_COLLAR, count: 1 },
    // The one creature in the pool that does not get a choice about attacking.
    { card: JUGGERNAUT, count: 1 },
    // And the Equipment that answers removal rather than adding power: whatever is holding the
    // swords stops dying to a Doom Blade or a Day of Judgment.
    { card: DARKSTEEL_PLATE, count: 1 },
    { card: RAISE_THE_ALARM, count: 1 },
    /*
      The second Alarm's slot, spent on the **sink** — and the payer was chosen the second time
      round, after the first one said no.

      The Ravager was measured against the second **Loxodon Warhammer** first, because an artifact
      that eats artifacts and the best artifact in the deck are the same conversation. It came back
      at 7 and 13 games of 288 against it, which is the Capsize lesson again: the Hammer is this
      deck's best card and it does two things at once, so "a two-mana artifact for a three-mana one"
      was never the fair comparison. A two-mana instant that makes two 1/1s is — both are two mana
      of board, and the question is whether a growing body beats two small ones. Both readings are in
      D221, because a slot's number is a fact about the payer.
    */
    { card: ARCBOUND_RAVAGER, count: 1 },
    { card: SECURE_THE_WASTES, count: 1 },
    { card: ANGELIC_GIFT, count: 1 },
    // One Charge rather than two, and the slot went to the Decorum. The pump rule (D86) measured
    // this deck's Inspired Charges down to two casts across 160 games — a card that is only right
    // on a wide board in a precombat main — while goad is a card this deck has no other version
    // of: every answer in here kills something, and this one turns a pod's boards on each other.
    { card: INSPIRED_CHARGE, count: 1 },
    { card: DISRUPT_DECORUM, count: 1 },
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
// ── The two morphs the first pass could not express ─────────────────────────────────────────────

/*
  A cost that is not mana, and megamorph. Both exist because CR 702.37a lets a card print whatever
  it likes for turning itself up, and the pool's first five morphs all happened to print mana.
*/

const ZOMBIE_CUTTHROAT: CardDef = {
  name: 'Zombie Cutthroat',
  typeLine: 'Creature — Zombie',
  manaCost: '{3}{B}',
  cmc: 4,
  power: '3',
  toughness: '3',
  oracleText: 'Morph — Pay 3 life.',
  colors: ['B'],
};

const HIDDEN_DRAGONSLAYER: CardDef = {
  name: 'Hidden Dragonslayer',
  typeLine: 'Creature — Human Warrior',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Lifelink\nMegamorph {2}{W}\nWhen Hidden Dragonslayer is turned face up, destroy target creature an opponent controls with power 4 or greater.',
  colors: ['W'],
};

export const ASHEN_RITE: DeckSpec = {
  id: 'ashen-rite',
  name: 'Ashen Rite',
  description: 'Black-red sacrifice. Every creature is a resource, and every land is a card.',
  commander: JUDITH,
  cards: [
    { card: SWAMP, count: 7 },
    { card: MOUNTAIN, count: 7 },
    { card: RAKDOS_GUILDGATE, count: 2 },
    // Two mana off one tap on turn two is the most-played card in Commander for a reason, and it
    // is the first thing in this pool that makes more mana than it costs to use.
    { card: SOL_RING, count: 1 },
    { card: MIND_STONE, count: 1 },
    // One mana for three, once: the only card in the pool that makes mana from a spell rather
    // than a permanent, and this deck's way to a turn-two Flametongue.
    { card: DARK_RITUAL, count: 1 },
    /*
      The second Ritual became the pool's deepest tribe's lord.

      Eight Vampires here — three Blood Artists, two Aristocrats, a Bloodthrone, a Nighthawk and
      Kalitas — which is more creatures of one type than any other deck has of anything. +1/+1 on
      all eight is the obvious half; first strike is the half that changes what the deck *is*. A
      board of 0/1 Blood Artists blocks nothing; a board of 1/2 first strikers kills an attacking
      1/1 and takes nothing back, and each of those deaths is a drain.

      It also reads with the card above it rather than against it: Night of Souls' Betrayal gives
      everything -1/-1, so with the Captain out the Vampires are level and everything else on the
      table has shrunk — a one-sided sweeper assembled from two cards that were already here.
    */
    { card: STROMKIRK_CAPTAIN, count: 1 },
    // Two cards a turn in a deck that spends them, and a life total it is already paying from.
    // It cost the second Mind Stone, which this deck has the Rituals and the Guildgates for.
    { card: DARK_CONFIDANT, count: 1 },
    // The painland that triggers: tapping it is the cost of a two-colour deck with eight basics
    // of each. It cost a Swamp.
    { card: CITY_OF_BRASS, count: 1 },
    // The cycling lands are the mana base's own decision: a land early, a card late. Two of each
    // rather than four, because a deck that cycled every land would never cast anything.
    { card: BARREN_MOOR, count: 2 },
    { card: FORGOTTEN_CAVE, count: 2 },
    // Creatures that want to die: a token on the way out, a drain on the way out, or a body that
    // was only ever fuel.
    /*
      Tormented Soul, for the Goblin Arsonist.

      A {B} 1/1 that **can't be blocked** — the pool's first creature with evasion that nothing on
      the other side can answer — and that can't block either, which is what it is paid for. In
      this deck it is both halves of a one-drop: a clock that never stops ticking while three Blood
      Artists and two Zulaport Cutthroats are on the table, and a body to feed to them when it is
      time. The Arsonist's own death trigger is not lost from the pool: Ember Rush runs two.
    */
    { card: TORMENTED_SOUL, count: 1 },
    /*
      One Doomed Dissenter rather than two, for the Fate Unraveler at the bottom of this list.

      A 1/1 that leaves a 2/2 behind is sacrifice fodder, and this deck has more of that than it
      can use: two Vampire Aristocrats, a Bloodthrone Vampire, a Bone Splinters and a Village
      Rites all want a body, and between the Doomed Dissenter, the Tormented Soul, three Blood
      Artists and two Zulaport Cutthroats there is always one. The deck's two deadest cards are
      the Bone Splinters at 34% and the Night of Souls' Betrayal at 43%, and both are the pool's
      only copy of their card — the Bone Splinters is also the only card that pays a cost by
      sacrificing, which is a rules path rather than a slot.
    */
    { card: DOOMED_DISSENTER, count: 1 },
    // A body one blocker cannot stop, in the deck that is happy either way: it gets through, or it
    // eats two creatures and feeds the drains on the way out.
    { card: BOGGART_BRUTE, count: 1 },
    /*
      The Sedgemoor Witch was here, and it is in Tidal Mind now.

      The argument for keeping it was good and it is still written down: ward {3} in the deck that
      least wants its creatures answered, and every instant or sorcery making a 1/1 that three
      Blood Artists and two Zulaport Cutthroats know what to do with. What beat it is that Tidal
      Mind holds fifteen instants and sorceries against this deck's ten, and that Tidal Mind had
      nothing to attack with at all while this deck is the strongest in the pool. The Witch left
      with the Phyrexian Arena arriving in its place at the bottom of this list, and the pair cost
      this deck **0 and −12 games on two seed sets**. That is the whole price of the rebuild Tidal
      Mind's write-up measures at +47 and +38, and the deck best able to pay it is this one.
    */
    { card: BLOOD_ARTIST, count: 2 },
    /*
      **Fiery Temper, for the third Blood Artist**: the pool's first madness card, in the deck with
      the pool's busiest discard outlet.

      {1}{R}{R} for three damage is a fair card and not why it is here. **Faithless Looting** is in
      this list and cast in 23 games of 96 — it draws three and discards two, and every discard it
      has ever made has been a pure cost until now. A Temper discarded to it is a Lightning Bolt for
      {R}, cast the moment the discard happens and at whatever speed the discard happened at.

      **The slot is a redundant copy rather than the least-cast card, and that is a finding about
      this list rather than a preference.** Every card below the Temper in usage is the only card in
      any deck behind some engine path: Hagra Mauling is the pool's one modal double-faced card (0
      casts in 96 and staying), Bone Splinters is the one removal spell with an additional cost,
      Phyrexian Arena and Dark Confidant each carry tests nothing else can carry. A third Blood
      Artist is one more than a deck needs to find one — the same argument D129 made when it took
      the third copy out of Rot Harvest — and two Artists, two Zulaport Cutthroats and a Fate
      Unraveler are still five cards that drain on a death.
    */
    { card: FIERY_TEMPER, count: 1 },
    /*
      Skewer the Critics for the second Zulaport Cutthroat: three damage for one mana, once the
      board has earned it.

      **Spectacle** (D197) is the fourth alternative cost and the first the board has to earn: for
      {R} instead of {2}{R}, if an opponent lost life this turn. This is the deck that earns it
      without trying — two Blood Artists, a Zulaport Cutthroat, a Fate Unraveler, an Impact Tremors
      and five burn spells all take life off the other seat, so the condition is usually already
      true by the time the card is in hand.

      The slot is a **second copy of a card the deck already has four of in effect**: Blood Artist
      and Zulaport Cutthroat are the same card at different rates, and this list runs four such
      drains between them. One Cutthroat stays, so the script and the "your own side only" rule it
      is the test case for are both still in the pool.
    */
    { card: SKEWER_THE_CRITICS, count: 1 },
    { card: ZULAPORT_CUTTHROAT, count: 1 },
    { card: VAMPIRE_ARISTOCRAT, count: 2 },
    { card: BLOODTHRONE_VAMPIRE, count: 1 },
    /*
      Battering Craghorn for the second Bloodthrone Vampire, and the half of morph the other two
      cards do not show: turning one up **during** combat.

      3/1 first strike, face down as a 2/2 for {3}, and {4}{R} after blockers are declared. There
      is no window for an answer because turning face up is a special action and uses no stack
      (CR 702.37b) — which is the only unanswerable trick in the pool, and the reason a player
      holds a morph instead of casting the creature.

      In this deck rather than one of the two fast red ones, which are already the top of the
      table: a cheap body that trades up in combat is what an aristocrats deck wants, and what it
      cannot trade it feeds to a Blood Artist. The second Bloodthrone Vampire was the most
      redundant card in it — a third sacrifice outlet behind two others with better text.
    */
    { card: BATTERING_CRAGHORN, count: 1 },
    { card: FLESHBAG_MARAUDER, count: 1 },
    { card: VAMPIRE_NIGHTHAWK, count: 1 },
    { card: FLAMETONGUE_KAVU, count: 2 },
    /*
      **Dregscape Zombie, for the Gravedigger**, and it is the same idea one card cheaper.

      A Gravedigger is three mana for a 2/2 that buys a creature back; a Dregscape Zombie is two
      mana for a 2/1 that buys **itself** back for {B}, as an activated ability out of the graveyard
      rather than a cast — so nothing goes on the stack, nothing can counter it, and the body is one
      attack before it is exiled at end of turn (D183). In the deck with a Vampire Aristocrat, a
      Bloodthrone Vampire, three Blood Artists and two Zulaport Cutthroats, a creature that can be
      eaten twice for three mana in total is the cheapest version of this deck's whole plan.

      The slot is this deck's last Gravedigger (59%, 19 casts in the 32 games a copy was in hand),
      and Rot Harvest keeps the pool's pair — the reanimation the engine needs covered is covered
      there.

      **It measured level** (−5 and +1 on the revert) and the deck presses it every game it draws
      one: 33 casts and **32 unearths** in 32 games.
    */
    { card: DREGSCAPE_ZOMBIE, count: 1 },
    { card: IMPACT_TREMORS, count: 1 },
    // -1/-1 to every creature on the table, which this deck minds least: its own one-power bodies
    // were only ever fuel, and every death is a drain. One copy, because it is a legend and
    // because a second one in a game would do nothing a first one had not already done.
    { card: NIGHT_OF_SOULS_BETRAYAL, count: 1 },
    // And the spells that spend them.
    /*
      One Splinters rather than three, and the same sentence explains both cuts: this deck has more
      ways to spend a creature than creatures to spend. The first slot bought Kalitas — the pool's
      first replacement effect, a vampire who denies the other side its graveyard, in the deck that
      lives off its own. The second bought the Zombie Cutthroat below, which is a creature, which
      is the thing the Splinters were short of.
    */
    { card: KALITAS, count: 1 },
    { card: BONE_SPLINTERS, count: 1 },
    /*
      **Murderous Redcap, for the third Blood Artist**, and persist is the other half of the family
      undying belongs to.

      Four mana for two damage now, a 1/1, and then one more damage later: it dies, comes back as a
      0/0 with a −1/−1 counter on it, deals its damage on the way in and goes straight back to the
      graveyard when the state-based actions catch up. Which is the printed card — the second body
      is a trigger rather than a creature — and in *this* deck it is a third thing as well: eight
      cards here read a creature dying, and a Redcap dies **twice** for one draw.

      The slot is the second Gravedigger (83%), and the first slot it was tried in is worth writing
      down: against the **third Blood Artist** it measured +7 and +29 on the revert, which is to say
      a Blood Artist is simply a better card than a Redcap and the drain payoff was never the thing
      this deck had too much of.
    */
    { card: MURDEROUS_REDCAP, count: 1 },
    /*
      The morph whose cost is not mana: three life, and no mana at all (CR 702.37a).

      Here rather than anywhere else because this is the deck whose whole identity is costs that are
      decisions — a kicker you may pay for, removal paid for with your own creature, a Dark
      Confidant and a City of Brass that both charge life. A 2/2 on turn three that becomes a 3/3
      for three life on a turn you had no mana to spare is the same card as the rest of that list.

      It is also the one card in the pool whose play the engine refuses on *life* rather than on
      mana: at three life the turn-up is not offered, because a cost you cannot pay is not a cost
      you may choose to pay.
    */
    { card: ZOMBIE_CUTTHROAT, count: 1 },
    { card: VILLAGE_RITES, count: 1 },
    /*
      One Agonizing Demise. The Thorn of the Black Rose that used to sit beside it — the crown in
      the deck that can take it back, because a Tormented Soul cannot be blocked at all — went for
      the Woe Strider at the end of this list, and the argument for it was always better than its
      cast count: 65%, the weakest card here that is not the pool's only copy. Tidal Mind runs the
      other one, so the monarch keeps a card and this deck keeps the Tormented Soul that made the
      case.
    */
    { card: AGONIZING_DEMISE, count: 1 },
    { card: BURST_LIGHTNING, count: 1 },
    // Two damage now and two more from the graveyard later, for a deck that is happy to spend its
    // whole turn on removal. One Burst Lightning stays, because the kicker is what that card is
    // for and this deck reaches eight mana often enough to use it.
    { card: FIREBOLT, count: 1 },
    { card: BREATH_OF_DARIGAAZ, count: 1 },
    { card: LIGHTNING_BOLT, count: 1 },
    { card: FAITHLESS_LOOTING, count: 1 },
    /*
      The modal card, for the Read the Bones that was this deck's deadest slot at 31% — cast in 16
      of the 51 games it was in hand, because three mana and two life for two cards is a turn this
      deck would rather spend killing something.

      Hagra Mauling is the same decision made for you every game: a Murder when there is something
      to murder, and the land this deck's eighteen were one short of when there is not. Both halves
      are what the deck already wants, which is the only reason a card that comes in tapped is worth
      a slot here.
    */
    { card: HAGRA_MAULING, count: 1 },
    /*
      Phyrexian Arena, out of Tidal Mind, for the Sedgemoor Witch that went the other way.

      A card every turn for two life, in the deck that gains life back off three Blood Artists and
      two Zulaport Cutthroats and whose commander wants the board refilled faster than it empties.
      It was Tidal Mind's second-deadest card at 44% — four mana and a life a turn is a slow engine
      in a deck already drawing — and it is this deck's second Dark Confidant, which is a card this
      deck was already happy to run.

      It is here rather than nowhere because cutting it from Tidal Mind would have deleted the
      pool's only copy and with it the only test of its upkeep trigger. That is the constraint
      Tidal Mind's own write-up is about.
    */
    { card: PHYREXIAN_ARENA, count: 1 },
    /*
      Fate Unraveler: the other half of the `draws` event, on a body this deck can cast.

      "Whenever an opponent draws a card, that player loses 1 life" — a drain stapled to the one
      thing every deck does every turn, in the deck whose whole plan is a life total going down a
      point at a time beside three Blood Artists and two Zulaport Cutthroats. A 2/4 also blocks,
      which the drains do not.

      **The card this deck would rather have is Underworld Dreams, and it is not here on purpose.**
      Same trigger, one mana cheaper, and {B}{B}{B} in a list with eleven black sources and seven
      Mountains is a card that sits in hand — which is the exact failure `cast-counts` keeps
      finding and the reason the Diabolic Tutor and the Behold the Multiverse have both been cut
      from decks this week. Four mana for the same text on a creature is the version this pool can
      actually put on the table.
    */
    { card: FATE_UNRAVELER, count: 1 },
    /*
      The free sacrifice outlet this deck has wanted since it was built, and escape's second
      card (CR 702.139).

      Eight cards here read a creature dying — three Blood Artists, two Aristocrats, a
      Bloodthrone Vampire, a Judith and a Village Rites — and not one of them could make one die
      for free. A Woe Strider is `{0}`: sacrifice another creature, scry 1, as many times as
      there are bodies, and it **arrives with its own first meal** in the 0/1 Goat. Then it comes
      back for {4}{B} and three cards out of the graveyard, which is the half that makes it an
      engine rather than a creature: killing the outlet does not remove it.

      It replaced this deck's **Thorn of the Black Rose** (65%, the deck's weakest card that is
      not the pool's only copy of itself — Tidal Mind runs the other, so the monarch keeps its
      coverage). A 2/3 deathtouch that draws a card a turn while it holds the crown is a fine
      card; it is also four mana in a deck whose curve is built to spend turn three on a body it
      intends to sacrifice.
    */
    { card: WOE_STRIDER, count: 1 },
  ],
};

/*
  The two miracle cards, and why each one is in the deck it is in.

  Miracle is the only keyword in this pool whose two prices are a whole card apart. A Thunderous
  Wrath for {4}{R}{R} is six mana for five damage, which no deck here would ever cast; for {R} it is
  the best burn spell in the pool. A Terminus for {3}{W}{W} is a fair sweeper; for {W} it is not.
  So both go into decks that would **not** play them at the printed cost — which is the honest test
  of the keyword rather than of the cards, because every game they are cast in is a game the
  keyword paid for.
*/
const THUNDEROUS_WRATH: CardDef = {
  name: 'Thunderous Wrath',
  typeLine: 'Instant',
  manaCost: '{4}{R}{R}',
  cmc: 6,
  oracleText: 'Miracle {R} (You may cast this card for its miracle cost when you draw it if it\u2019s '
    + 'the first card you drew this turn.)\nThunderous Wrath deals 5 damage to any target.',
  colors: ['R'],
};

const TERMINUS: CardDef = {
  name: 'Terminus',
  typeLine: 'Sorcery',
  manaCost: '{3}{W}{W}',
  cmc: 5,
  oracleText: 'Miracle {W} (You may cast this card for its miracle cost when you draw it if it\u2019s '
    + 'the first card you drew this turn.)\nPut all creatures on the bottom of their owners\u2019 '
    + 'libraries.',
  colors: ['W'],
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
/*
  The two extort cards: a 1/2 flier and a 0/4 wall, both bought for their text rather than their
  bodies. Extort is a clock that costs no cards — one life per spell for a mana the turn was not
  spending — so it goes to the two decks whose problem is finishing games they are already winning.
*/
const BASILICA_SCREECHER: CardDef = {
  name: 'Basilica Screecher',
  typeLine: 'Creature — Bat Cleric',
  manaCost: '{2}{B}',
  cmc: 3,
  power: '1',
  toughness: '2',
  oracleText: 'Flying\nExtort (Whenever you cast a spell, you may pay {W/B}. If you do, each '
    + 'opponent loses 1 life and you gain that much life.)',
  colors: ['B'],
};

const BASILICA_GUARDS: CardDef = {
  name: 'Basilica Guards',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '0',
  toughness: '4',
  oracleText: 'Defender\nExtort (Whenever you cast a spell, you may pay {W/B}. If you do, each '
    + 'opponent loses 1 life and you gain that much life.)',
  colors: ['W'],
};

export const SKYWARD_WRIT: DeckSpec = {
  id: 'skyward-writ',
  name: 'Skyward Writ',
  description: 'White-blue fliers. Hold the ground, answer the spell that matters, and win in the air.',
  commander: HANNA_SHIPS_NAVIGATOR,
  cards: [
    { card: PLAINS, count: 7 },
    { card: ISLAND, count: 7 },
    { card: AZORIUS_GUILDGATE, count: 3 },
    // The painland that charges rather than triggers, in the deck most likely to be at one life
    // and have to decide whether it can afford its own mana. It cost a Plains.
    { card: MANA_CONFLUENCE, count: 1 },
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
    { card: SOUL_WARDEN, count: 1 },
    /*
      Master of Pearls for the second Soul Warden, and the other half of what a morph is for.

      This deck wins in the air with small fliers, which means it wins by attacking into a board it
      cannot profitably attack into — and a 2/2 that turns up for {2}{W}{W} and makes the whole team
      two bigger is exactly the card that turns that attack from bad to lethal. Nothing in it could
      do that before: Overrun is green and the deck's only mass effect was a Holy Day.

      Held face down it is also a blocker, which is the trade the card asks you to think about and
      the reason it belongs in a deck that is usually the one being attacked.

      The second Soul Warden, because one is already more lifegain than this deck's plan needs and
      the card's own payoff, Ajani's Pridemate, is not in this list at all.
    */
    { card: MASTER_OF_PEARLS, count: 1 },
    // A one-drop that blocks in the air and gains the life back, which is what the matchups this
    // deck loses actually ask for.
    { card: HEALERS_HAWK, count: 1 },
    /*
      The second Healer's Hawk's slot, spent on the pool's first **extort** card.

      A 0/4 for two mana stops nearly every one- and two-drop in this pool dead, and every spell
      cast behind it is a life off each opponent and a life back. Which is the thing this deck has
      never had: a reason for the game going long to be *good* for it. It holds two Fog Banks, a
      Wall of Air, a Samite Healer and a Holy Day, and all of them only buy time.
    */
    { card: BASILICA_GUARDS, count: 1 },
    /*
      Thalia, Guardian of Thraben, for the Youthful Knight.

      The same slot and the same shape — {1}{W} for a first striker — with one toughness traded for
      a line of text that taxes *every* noncreature spell on the table, this deck's own included.
      It is here rather than in the other two white decks because this is the white deck with the
      fewest noncreature spells of its own (seventeen, against twenty and twenty-five across the
      field), so the tax is asymmetric in its favour by the margin a deckbuilder would want. The
      Knight is not lost: Forge Alliance still runs one.
    */
    { card: THALIA_GUARDIAN_OF_THRABEN, count: 1 },
    { card: OMENSPEAKER, count: 1 },
    /*
      The second Omenspeaker's slot, spent on **ninjutsu**.

      Same cost, same colour, same two-drop slot, and the trade is the whole keyword: a 1/3 that
      scries two as it arrives against a 2/2 that is never cast at all — it waits in hand for a
      flier to get through and takes its place on the attack, drawing a card when it connects. This
      is the deck for it because this is the deck whose creatures get through. See D219.
    */
    { card: NINJA_OF_THE_DEEP_HOURS, count: 1 },
    /*
      The prevention pair, one copy each, and the two cards they cost.

      A Samite Healer stops one damage a turn for ever, and the tap is a real decision rather than
      a freebie because a tapped Healer is not blocking; Healing Salve is one mana for three life
      or three damage that never happens. They cost a Wind Drake and the second Youthful Knight.

      **Two cards and not six, and the slot is not free.** Three shapes of this swap were measured
      over 240 paired duels each against the rest of the pool, twice, against a baseline of 164-76
      and 153-87: two Healers and a Salve for three bodies gave 141-99 and 145-95; one of each for
      two bodies gave 146-94 and 146-94; one of each for two *spells* instead gave 153-87 and
      139-101. Every version costs this deck about five per cent, and which cards come out moves it
      less than the two seed sets move each other — a three-mana 1/1 is a weak card whatever its
      text. This is the version that keeps every answer: the Healer stands in for the second
      Youthful Knight on the ground and the Salve for the Wind Drake. It is carried on purpose, and
      why is in `claude/decisions-log.md` (D102).
    */
    { card: SAMITE_HEALER, count: 1 },
    { card: HEALING_SALVE, count: 1 },
    { card: WALL_OF_AIR, count: 1 },
    /*
      Exalted, and the Negate it replaced.

      A 2/3 for {2}{W} that cannot attack, in the deck that keeps losing on the ground — and that
      pays the creature that attacks alone. Both halves are this deck. It holds the ground against
      anything the aggro decks put down for two mana, and the Serra Angel that swings into an empty
      sky while the Guardians stay home swings as a 5/5.

      The exalted trigger is the one place the engine has ever had to say *which* creature an event
      happened to: "that creature gets +1/+1" has no referent at all otherwise, and the Guardians
      are never the creature in question because they can never attack.

      The Negate went because it was this deck's least-cast card — 55% of its copies over 96 games,
      against 90% for the Hawks — and because what it answers is the half of the field this deck
      already beats. Two Counterspells and an Essence Scatter stay: the creature decks are the
      matchups it loses, and a counter that cannot touch a creature is the wrong answer to them.

      **Which card came out was worth more than the card going in.** Measured against the field
      twice, 240 paired duels each: cutting the Negate for the Guardians is 120-120 and 113-127
      against 103-137 and 97-143 for the list it replaced, so +17 and +16 — on the same side both
      times and right at this instrument's floor. The first version of this swap cut the *Wall of
      Air* instead, and that arrangement measured 103-137 and 100-140 — level with doing nothing.
      Same new card, two cuts, seventeen games between them. See `claude/decisions-log.md` (D133).
    */
    { card: GUARDIANS_OF_AKRASA, count: 1 },
    /*
      The Birth of Meletis for the second Wall of Air, and the first Saga in the pool.

      Three turns of exactly what this deck is short of: a 0/4 wall that stops a ground creature
      dead, two life, and a land. It is also the one card here that an opponent cannot answer by
      killing a creature or an artifact — a Saga is an enchantment, and in this pool only three
      cards destroy one.

      The second Wall of Air, because chapter I makes a better wall than it: 0/4 blocks everything
      on the ground forever, and this deck already has two Fog Banks for the things that fly.
    */
    { card: THE_BIRTH_OF_MELETIS, count: 1 },
    { card: RAISE_THE_ALARM, count: 1 },
    /*
      Ajani, Caller of the Pride for the second Raise the Alarm.

      The pool's third planeswalker and the first with a *combat* ability on it: −3 gives a creature
      flying and double strike until end of turn, which on a Serra Angel is eight damage out of a
      board that was holding the ground. The +1 is a counter on a Knight that the Exemplar then
      makes indestructible, and the −8 is five 2/2 Cats — the deck's only way to go wide.

      **It measures as free:** removing it is −1 and −5 of 270 on two seed sets, both well inside
      the floor, and the sign is the same twice.

      The cut is the second Raise the Alarm, because the Cats and the Alarm do the same job and the
      planeswalker does it repeatedly. The alternative — cutting an Omenspeaker — measured +19 and
      −3, which is this instrument's way of saying it cannot tell: one set above the floor, the
      other the wrong way round. So the argument is the cards', and the Omenspeaker stays because it
      is this deck's only early card selection.
    */
    { card: AJANI_CALLER_OF_THE_PRIDE, count: 1 },
    // And the air, which it does intend to win.
    { card: LEONIN_SKYHUNTER, count: 1 },
    /*
      A Flickerwisp for the third Skyhunter, and the first card in the pool whose text happens
      **later**.

      The body is the same plan one mana along — a 3/1 flier instead of a 2/2 — and the arrival is
      a blink of *any* permanent, which in this deck is three different cards at once: reset an
      opponent's Journey to Nowhere and the creature under it comes back to you, take a blocker out
      of a combat your Skyhunters are losing, or re-use one of your own entry triggers. It gives
      the permanent back at the next end step, so it buys a turn rather than answering anything —
      which is exactly what a deck full of two-power fliers wants.
    */
    { card: FLICKERWISP, count: 1 },
    /*
      And the card that reads what every one of those blinks does, which nothing in the pool could.

      Soulherder came in for the **Disenchant**, named by `cast-counts` as this deck's worst
      conversion: in hand in 64 of 144 games and cast 35 times, which is what a card with no legal
      target half the time looks like. The deck keeps its answers — two Counterspells, two Swords,
      an Essence Scatter, an Unsummon, a Pacifism, a Journey, a Holy Day and a Terminus — and the
      card it gives up is the one that needs the opponent to have played an artifact first. The copy
      in Dawn Tithe stays, so the pool keeps Disenchant and a pasted list can still play it.

      It belongs **here** rather than in any other deck for three reasons the list already contains.
      The blink has something to blink: two Man-o'-Wars, an Omenspeaker, a Voice of All and a
      Flickerwisp all do their work on arrival, and a Soul Warden pays a life for every one of them
      coming back. It has something to grow into: this deck wins in the air, and a 1/1 that is a 4/4
      by turn eight is a clock that costs two mana. And the one line nobody would guess — **Rest in
      Peace** is in these sixty, so while it is out every creature this deck loses is exiled from
      the battlefield instead of buried, which is a creature of yours being exiled, which is a
      counter. That is the printed ruling rather than a quirk of this engine, and it falls out of
      recording the event where the move happens.
    */
    { card: SOULHERDER, count: 1 },
    // Two Skyhunters' worth of white two-drops already fly; this one does not and does not need
    // to. Against the two colours that hold this pool's removal it simply cannot be answered, and
    // it is the only card here that proves protection does all four of its jobs.
    { card: PALADIN_EN_VEC, count: 2 },
    { card: MAN_O_WAR, count: 2 },
    { card: SERRA_ANGEL, count: 1 },
    /*
      Voice of All for the second Serra Angel, which is this deck trading power for a turn.

      A {3}{W} 2/2 flier that chooses a colour as it enters and cannot be touched by it — not
      targeted, not blocked, not damaged, and it wins every fight with a creature of that colour
      (CR 702.16). Against the two decks this one actually loses to, both of which hold their
      removal in red and black, that is a flier nothing in their list answers.

      The second Serra Angel went because this deck's problem has never been its top end. It lost
      1-9 to both aggro decks on turns three and four and then had two five-drops to show for it; a
      three-mana flier that the aggro decks cannot remove is the card those games wanted.

      The colour is chosen as it enters rather than by a trigger, which is the rules difference and
      a real one: there is no window in which the Voice is on the battlefield with no protection
      yet, so a removal spell held for exactly that moment does not exist.

      **It costs this deck about one per cent, and it is carried on purpose.** 240 paired duels
      against the field, two seed sets: 114-126 and 108-132 with the Voice against 117-123 and
      110-130 without — −3 and −2, the same side both times and a long way inside the floor. The
      cut was re-asked per D127: taking a *Raise the Alarm* instead gives 113-127 and 105-134,
      worse again, so the Serra Angel is the better of the two cuts and the card itself is the
      marginal part.

      Why it stays: a person piloting this deck chooses the colour from the matchup in front of
      them, and the engine's opponent chooses it by counting what it can already see. That is the
      one card in the pool where the gap between those two is the whole card, so the bot's record
      is the least informative number here — and the closed-set half of a new primitive needs a
      reader. D102 carries the Samite Healer at five times this cost for a weaker reason.
    */
    { card: VOICE_OF_ALL, count: 1 },
    /*
      Megamorph, and the Air Elemental it replaced.

      Three cards in one, which is what this deck wants from a slot more than it wants a fifth-turn
      4/4: a {1}{W} 2/1 lifelink when the board is empty, a {3} 2/2 when it needs a blocker, and a
      {2}{W} "destroy their best creature" when the thing that beats it has already landed. The
      power-4 filter names what the white decks actually lose to, and because the trigger is
      mandatory and a trigger with no legal target never reaches the stack, turning it up into a
      board of small creatures is simply a 3/2 lifelinker.

      The Air Elemental went because the deck already intends to win in the air with two Serra
      Angels, three Skyhunters and two Hawks, and Tidal Mind keeps its own copy.
    */
    { card: HIDDEN_DRAGONSLAYER, count: 1 },
    // The answers. Two Counterspells and an Essence Scatter: the Negate that used to sit beside
    // them became the Guardians of Akrasa, because what beats this deck is a creature.
    { card: COUNTERSPELL, count: 2 },
    { card: ESSENCE_SCATTER, count: 1 },
    { card: UNSUMMON, count: 1 },
    { card: SWORDS_TO_PLOWSHARES, count: 2 },
    { card: DIVE_DOWN, count: 1 },
    { card: PACIFISM, count: 1 },
    { card: JOURNEY_TO_NOWHERE, count: 1 },
    // The deck that loses to a wide board, holding the card that answers a wide board for two
    // mana. The third Swords paid for it: this deck's problem was never the one big creature.
    { card: HOLY_DAY, count: 1 },
    /*
      The graveyard, turned off for both players — which costs this deck's **sixty** nothing.

      It replaced a **Divine Verdict** (57% of the games it was in hand, 16 casts in 96), and the
      reason it is here rather than in Dawn Tithe is that none of Skyward Writ's sixty cards reads
      a graveyard: no flashback, no escape, no Gravedigger, nothing that buys back a card it has
      already spent. A symmetrical card in a deck that pays nothing for it is a one-sided card, and
      against Ashen Rite's Gravedigger loops, Arc Tempest's flashback, Hollow Tide's delve and Rot
      Harvest's recursion it is two mana for half a deck.

      **The one place it costs something is a pod**, and it is worth saying rather than glossing:
      this deck's commander is **Hanna, Ship's Navigator**, whose whole ability is returning an
      artifact or enchantment from its own graveyard. In a duel Hanna is not in the game and the
      card is pure upside; at a Commander table the two cards fight, and the player holding both
      has a real decision rather than an automatic one.
    */
    { card: REST_IN_PEACE, count: 1 },
    // Cards, and the artifact Hanna is happy to buy back.
    { card: MIND_STONE, count: 1 },
    /*
      Six Knights, and the lord that makes them unkillable.

      Three Leonin Skyhunters, two Paladin en-Vec and a Youthful Knight: the second-deepest tribe in
      the pool, in the deck whose whole plan is to still be alive later. Indestructible is the
      keyword that plan actually wants — a Paladin en-Vec already cannot be touched by a red or a
      black spell, and with the Exemplar out it cannot be killed in combat either.

      The honest caveat is in the same sentence: kill the Exemplar and the Knights are mortal again
      *immediately*, including in the middle of the combat where somebody has already assigned
      lethal damage to one. That falls out of a static lasting exactly as long as its source is on
      the battlefield, and it is the sharpest version of the trade this card is.

      It cost the Divination, this deck's least-cast spell, which Hollow Tide and Arc Tempest both
      still run.
    */
    { card: KNIGHT_EXEMPLAR, count: 1 },
    /*
      Terminus, and the two fliers it cost.

      The card for the board this deck cannot hold. Its plan is to stop the ground and win in the
      air, and the matchup it loses is the one where the ground arrives faster than the Walls do —
      so a sweeper that puts **every** creature on the bottom of its owner's library, for {W}, off
      the top of the library, is the answer it has never had. Nothing dies, which matters against
      the three decks whose cards come back out of a graveyard: there is no graveyard to come back
      from.

      Its own Walls go too, and that is the decision the card is for rather than a drawback to
      apologise for. At {3}{W}{W} it is a fair five-mana sweeper this deck can also simply cast.

      It cost the second Healer's Hawk and the second Leonin Skyhunter, which are the two least of
      its fliers and both of which the pool keeps a copy of elsewhere.
    */
    { card: TERMINUS, count: 1 },
  ],
};

/**
 * Hollow Tide: the deck that never looks at your life total.
 *
 * Seven decks measure a game in damage. This one measures it in cards, and the engine has always
 * been able to end a game that way — a player who cannot draw has lost (CR 704.5b) — so what this
 * deck really is is a win condition the rules already enforced and nobody had ever aimed at.
 *
 * It needs three things to work and all three are the deck list. **A clock**: a Nemesis of Reason
 * is ten cards a swing whether it is blocked or not, Mirko Vosk is eleven or so a connection, and
 * Jace is ten a turn for as long as he is left alone. **Something to do with the early turns**,
 * which is where a mill deck dies — so every cheap creature here blocks rather than attacks (a 0/2
 * Fog Bank, a 1/3 Wall, two 1/3 Magpies that happen to fly, a 2/4 Centaur) and the mill spells are
 * one and two mana. And **answers**, because the one thing that beats this deck is a creature it
 * cannot stop: four counterspells, four pieces of removal and a Man-o'-War.
 *
 * Mirko Vosk is the commander because the deck's problem is reach: its spells can mill about forty
 * cards across a whole game, and sixty minus forty is still a deck. A flier that takes eleven on
 * every connection and comes back from the command zone when it dies is the half the spells cannot
 * do.
 */
/*
  The two replicate cards. Both are mana sinks rather than spells, which is what the keyword is:
  a bad card early and a card that scales with the turn you cast it in.
*/
const PYROMATICS: CardDef = {
  name: 'Pyromatics',
  typeLine: 'Instant',
  manaCost: '{1}{R}',
  cmc: 2,
  oracleText: 'Pyromatics deals 1 damage divided as you choose among one or two targets.\n'
    + 'Replicate {1}{R} (When you cast this spell, copy it for each time you paid its replicate '
    + 'cost. You may choose new targets for the copies.)',
  colors: ['R'],
};

const TRAIN_OF_THOUGHT: CardDef = {
  name: 'Train of Thought',
  typeLine: 'Sorcery',
  manaCost: '{2}{U}',
  cmc: 3,
  oracleText: 'Draw a card.\nReplicate {2}{U} (When you cast this spell, copy it for each time '
    + 'you paid its replicate cost.)',
  colors: ['U'],
};

export const HOLLOW_TIDE: DeckSpec = {
  id: 'hollow-tide',
  name: 'Hollow Tide',
  description: 'Blue-black mill. Block the early turns, answer the one threat, and take the game from the top of their library.',
  commander: MIRKO_VOSK,
  cards: [
    { card: ISLAND, count: 8 },
    { card: SWAMP, count: 7 },
    { card: DIMIR_GUILDGATE, count: 3 },
    // Two cycling lands in each colour: a mill deck's flood is worse than most, because a land it
    // does not need is a card it could have milled with.
    { card: LONELY_SANDBAR, count: 2 },
    { card: BARREN_MOOR, count: 2 },
    // The clock. Ten cards a swing, blocked or not, is this deck's Serra Angel.
    { card: NEMESIS_OF_REASON, count: 1 },
    { card: JACE_MEMORY_ADEPT, count: 1 },
    // The payload, all of it cheap enough to cast on a turn that also does something else.
    { card: TOME_SCOUR, count: 1 },
    /*
      And the Diabolic Tutor's new home, for one Tome Scour.

      It was cut from Tidal Mind for being that deck's deadest card, and a tutor is a different
      card in a deck with two cards worth finding: a Nemesis of Reason or a Jace is the game, and
      five mill rather than seven is not. Measured as its own change rather than assumed — see the
      log — because moving a card that cost one deck games is not the same as giving another deck
      a card it wants.
    */
    { card: DIABOLIC_TUTOR, count: 1 },
    { card: MIND_SCULPT, count: 2 },
    /*
      Steady Progress for the third Mind Sculpt: one three-mana instant for one, both doing one
      thing.

      This deck has the two things proliferate wants and had no way to use them — a Chasm Skulker
      that grows a counter every draw, and a Jace whose loyalty is the whole card. See D213.
    */
    { card: STEADY_PROGRESS, count: 1 },
    { card: THOUGHT_SCOUR, count: 1 },
    /*
      Whispers of the Muse for the second Thought Scour: a one-mana cantrip for a one-mana cantrip.

      The Thought Scour mills two and replaces itself, which in this deck is a small piece of the
      plan. This replaces itself too, and then costs six to do it again every turn afterwards — so
      the slot asks what a mill deck's long game is worth, which is the half of buyback that is not
      about answers. See D211.
    */
    { card: WHISPERS_OF_THE_MUSE, count: 1 },
    /*
      One Compelling Argument rather than two, for the Chasm Skulker at the bottom of this list.

      Three cards off the top for two mana, cycling for {2} when the board needs something else —
      the most replaceable of this deck's mill spells, because the three Mind Sculpts do the same
      job for the same mana and the cycling half is what the second copy was for. It is the only
      slot here that could go: `cast-counts` puts the deck's deadest cards at the Diabolic Tutor
      (52%) and The Eldest Reborn (52%), and both are the pool's only copy of their card.
    */
    { card: COMPELLING_ARGUMENT, count: 1 },
    { card: RETURNED_CENTAUR, count: 1 },
    /*
      Toxic Deluge, for the second Returned Centaur.

      A mill deck wins by not dying, and until now the only way it answered a board was one
      creature at a time. A sweeper whose size you choose is the right one for it twice over: it
      answers four one-drops for one life each, and it answers the 5/5 it could never block
      profitably — and the life it costs is the one resource a deck that is not racing has to
      spend. It is the pool's only card whose number is chosen *as it resolves* rather than as it
      is cast, which is why it could not be written before (see `NumberDecisionSpec`).
    */
    { card: TOXIC_DELUGE, count: 1 },
    /*
      The ground, which is the half of a mill deck that is not the mill. None of these want to
      attack and all of them are happy to block for ever.

      **A third Fog Bank, for the Essence Scatter below**, and `mill.mjs` is what asked the
      question. The instrument says the plan works and the clock does not: half this deck's wins
      are already empty libraries (23 of 48), it mills eighteen cards a game, and the opponent's
      library is still at **24 on average** when the game ends. So the deck does not need more mill
      — it needs the turns. Measured both ways against the same stock, with the same card cut: a
      fourth Mind Sculpt is **+12 of 288** and this is **+16**, and **+23** on a second seed set.
      The four games between the two adds are deep inside the floor, so the honest reading is that
      most of the gain is **the cut** rather than either card — which is the README's own warning
      about measuring the cut as well as the card, landing on the deck that asked the question.
    */
    // attack and all of them are happy to block for ever.
    { card: FOG_BANK, count: 2 },
    /*
      The third Fog Bank's slot, spent on a **mana sink** instead of a third blocker.

      This deck's late turns have always had mana and nothing to spend it on — a Treasure Cruise
      for {U} and a Gurmag Angler for {B} both get *cheaper* as the graveyard fills, which is the
      opposite of a sink. A Train of Thought is a bad card for three mana and a refill for nine, so
      it is the card this list was short of rather than another card it already has three of.
    */
    { card: TRAIN_OF_THOUGHT, count: 1 },
    /*
      Evolve, and the second Psychic Strike it replaced.

      A {U} 0/1 that this deck turns into a 3/4 flier without doing anything it was not doing
      anyway. Every creature here is a blocker that enters bigger than the Raptor is — a 0/2 Fog
      Bank evolves it on toughness, a 1/3 Wall of Air on both, a 2/4 Returned Centaur again — so
      the card that is worst on turn one is the best blocker in the deck by turn five, and the deck
      whose losses all look like "died before the mill got there" has one more turn-one play.

      Evolve is also the pool's first intervening-if clause, which is the half of it that is a rule
      rather than a card: the condition is checked when the trigger would go on the stack *and*
      again as it resolves (CR 603.4), so a Raptor that is already the biggest thing out puts no
      trigger on the stack at all, and bouncing the creature that caused one is an answer to it.

      The second Psychic Strike went because this deck counters six things and needs to survive
      five turns. Measured against the field twice, 240 paired duels each: 88-152 and 101-139 with
      the Raptor against 85-155 and 97-143 without, so +3 and +4. Both seed sets lean the same way
      and both by far less than the eighteen games this instrument can resolve, which is the
      honest reading: the swap costs this deck nothing, and nothing is all a new keyword's card
      has to cost.
    */
    { card: CLOUDFIN_RAPTOR, count: 1 },
    /*
      The Eldest Reborn for the second Wall of Air, and the card this deck has been missing.

      Hollow Tide spends the whole game putting creatures into graveyards and has never had a way
      to take one back out. Chapter III returns a creature from **any** graveyard — every other
      reanimation in the pool reads "your graveyard" — so the Nemesis of Reason that mills ten a
      turn is finally filling a pile this deck can spend.

      Six mana is a lot, and a deck whose plan is to survive is the one list that reliably reaches
      it: twelve black sources, and the two chapters before the reanimation are a sacrifice and a
      discard, which are what a slow deck wants from its early turns.
    */
    { card: THE_ELDEST_REBORN, count: 1 },
    { card: OMENSPEAKER, count: 1 },
    /*
      And the second Omenspeaker's slot, spent on extort's other card.

      This deck answers everything and then needs the game to end. A 1/2 flier is almost
      incidental; what the slot buys is one life a spell, for a mana a control deck is not
      spending — and two spells a turn for ten turns is twenty life out of a card that was never
      part of the board.
    */
    { card: BASILICA_SCREECHER, count: 1 },
    { card: THIEVING_MAGPIE, count: 1 },
    { card: VAMPIRE_NIGHTHAWK, count: 2 },
    // The answers. Three counters, four removal spells and two Man-o'-Wars, because the thing that
    // beats this deck is one creature it cannot block. The fourth counter was the second Psychic
    // Strike, now a Cloudfin Raptor: a deck this slow would rather have the turn-one blocker.
    { card: COUNTERSPELL, count: 2 },
    { card: PSYCHIC_STRIKE, count: 1 },
    // The Essence Scatter that paid for the third Fog Bank: a creature counterspell in a deck with
    // two Counterspells, a Psychic Strike and a Negate was the answer this list had most of.

    { card: NEGATE, count: 1 },
    { card: DOOM_BLADE, count: 2 },
    { card: MURDER, count: 1 },
    { card: AGONIZING_DEMISE, count: 1 },
    { card: MAN_O_WAR, count: 2 },
    // And enough card flow to find the clock, since the deck wins with about four cards.
    { card: PREORDAIN, count: 1 },
    { card: DIVINATION, count: 1 },
    /*
      The adventurer, for the Sign in Blood: two cards for two life in the deck that already runs
      two Thought Scours, a Divination, a Preordain and two Thieving Magpies.

      Mill four and *then* a one-mana 0/4 is the same card twice in the deck whose win condition is
      the opponent's library — and the 0/4 is the turn-one body this deck has never had. Cast in 62%
      of the games it was in hand, the Sign in Blood was the weakest slot here that is not one of
      this deck's own one-of engines; the Psychic Strike below it at 35% would have been the cut, and
      it is the only copy of that card in the pool.
    */
    { card: MERFOLK_SECRETKEEPER, count: 1 },
    /*
      Chasm Skulker, and the deck that draws the most cards in the pool.

      A 1/1 for three that is worth whatever the deck draws: two Thought Scours, a Preordain, a
      Divination, two Thieving Magpies and a Jace, Memory Adept, on top of a draw step. It is the
      first card in the pool to read the `draws` event, which until now was raised by nothing —
      `draw` is the one place a card is drawn and it announced it to nobody.

      The other half is the reason it is in *this* deck rather than Tidal Mind, which also draws:
      when it dies it leaves a 1/1 **islandwalker** for every counter, and the two decks it is
      measured against most often are the two with Islands in them. A 1/1 that cannot be blocked is
      a clock a mill deck can afford to wait behind.
    */
    { card: CHASM_SKULKER, count: 1 },
    /*
      A 5/5 for one mana on a full graveyard, which is this deck's answer to the thing every
      instrument has said about it: it mills beautifully and it cannot close (delve, CR 702.112).

      Delve reads this deck's own graveyard, and a mill deck fills one on both sides of the
      table — its own, from three Mind Sculpts, two Thought Scours and a Tome Scour it cast.
      Printed at {6}{B} and cast for {B} about as often, which makes it the first card in the
      pool whose mana cost is a fact about the game rather than about the card.

      It replaced the **Wall of Air** (79%): the deck already holds the ground with three Fog
      Banks, so the fourth defensive body was the slot that overlapped most, and the pool keeps
      its Wall of Air in Skyward Writ. A deck that wins by decking somebody still has to survive
      long enough — but a 1/5 flier was buying turns this deck had no way to spend.
    */
    { card: GURMAG_ANGLER, count: 1 },
    /*
      And the second delve card, which arrived here by being wrong somewhere else.

      The Treasure Cruise spent one night in Tidal Mind and the probe disagreed four times —
      −9, −1, −4 and −3 of 288 on four seed sets, every set the same sign. The reason was the
      mana base and the competition: six Islands there against eight here, and a graveyard
      already being spent by a Think Twice that wants to be cast out of it.

      This deck is where delve already works. The Angler above it measured +17 and +2, the
      library it mills is its own, and three Mind Sculpts and two Thought Scours put cards in a
      graveyard nothing else in the list wants. Three cards for {U} is also the one thing a mill
      deck is short of: it wins with about four cards and has to find them.

      It replaced the **second Thieving Magpie** (81%, and the deck keeps the first). The Magpie
      is two cards over two turns if it connects and nothing at all if it is blocked; the Cruise is
      three cards the turn it is cast. The Divination beside it measured a point worse and is the
      card seven engine tests reach for when they want a plain draw-two, which is a reason to cut
      the Magpie rather than a reason the Magpie is worse — the two are within the noise of each
      other and the pool's test coverage broke the tie.
    */
    { card: TREASURE_CRUISE, count: 1 },
  ],
};

// ── Arc Tempest: red-blue, and the cards it needed ──────────────────────────────────────────────

const IZZET_GUILDGATE: CardDef = {
  name: 'Izzet Guildgate',
  typeLine: 'Land — Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Izzet Guildgate enters the battlefield tapped.\n{T}: Add {U} or {R}.',
  colors: [],
};

const ADELIZ: CardDef = {
  name: 'Adeliz, the Cinder Wind',
  typeLine: 'Legendary Creature — Human Wizard',
  manaCost: '{1}{U}{R}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Flying, haste\nWhenever you cast an instant or sorcery spell, each Wizard you control gets +1/+1 until end of turn.',
  colors: ['U', 'R'],
};

const STORMCHASER_MAGE: CardDef = {
  name: 'Stormchaser Mage',
  typeLine: 'Creature — Human Monk Wizard',
  manaCost: '{U}{R}',
  cmc: 2,
  power: '1',
  toughness: '3',
  oracleText: 'Flying, haste, prowess',
  colors: ['U', 'R'],
};

const YOUNG_PYROMANCER: CardDef = {
  name: 'Young Pyromancer',
  typeLine: 'Creature — Human Shaman',
  manaCost: '{1}{R}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Whenever you cast an instant or sorcery spell, create a 1/1 red Elemental creature token.',
  colors: ['R'],
};

const GUTTERSNIPE: CardDef = {
  name: 'Guttersnipe',
  typeLine: 'Creature — Goblin Shaman',
  manaCost: '{2}{R}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent.',
  colors: ['R'],
};

const GELECTRODE: CardDef = {
  name: 'Gelectrode',
  typeLine: 'Creature — Weird Wizard',
  manaCost: '{1}{U}{R}',
  cmc: 3,
  power: '0',
  toughness: '1',
  oracleText: '{T}: Gelectrode deals 1 damage to any target.\nWhenever you cast an instant or sorcery spell, untap Gelectrode.',
  colors: ['U', 'R'],
};

/**
 * The second star in the pool's power boxes, and the first that is only in the power box.
 *
 * Lhurgoyf is printed `*` over `1+*`; this one is printed `*` over `4`, so the engine had to learn
 * that a characteristic-defining size can define one half and leave the other printed. The `*`
 * here is a real asterisk rather than a 0 for the same reason Lhurgoyf's is: the card face should
 * say what the card says, and the number the player wants is on the battlefield, computed.
 */
const ENIGMA_DRAKE: CardDef = {
  name: 'Enigma Drake',
  typeLine: 'Creature — Drake',
  manaCost: '{2}{U}{R}',
  cmc: 4,
  power: '*',
  toughness: '4',
  oracleText: "Flying\nEnigma Drake's power is equal to the number of instant and sorcery cards in your graveyard.",
  colors: ['U', 'R'],
};

const ARC_LIGHTNING: CardDef = {
  name: 'Arc Lightning',
  typeLine: 'Sorcery',
  manaCost: '{2}{R}',
  cmc: 3,
  oracleText: 'Arc Lightning deals 3 damage divided as you choose among one, two, or three targets.',
  colors: ['R'],
};

/**
 * Arc Tempest: the ninth deck, and the first whose creatures are paid for by its spells.
 *
 * Eight decks, and the gap between them was not a colour pair — it was a *way of winning*. Six won
 * by attacking with creatures, one by attacking a library, one by draining a life total; all nine
 * of the pool's `spell-cast` readers were cards inside decks that would have been fine without
 * them. Nothing had ever been built so that casting a spell was itself the thing that advanced the
 * board, which is the one archetype Magic has had since Urza's block and this pool had never had.
 *
 * So the deck list is twenty-five instants and sorceries and seven creatures that read them.
 * **Guttersnipe** turns each cast into two damage at the face and **Young Pyromancer** turns it
 * into a body; **Gelectrode** and **Thermo-Alchemist** untap on each cast, which makes a tap
 * ability into a once-per-spell ability; **Monastery Swiftspear** and **Stormchaser Mage** grow.
 * **Enigma Drake** is the one that needs nothing to have resolved first — a 1/4 flier early, and
 * whatever the graveyard has become by turn eight.
 *
 * Adeliz is the commander because she is the half of the deck a deck list cannot have: a 2/2 flier
 * with haste that is a four-power flier the turn two spells are cast, and a Wizard herself, so the
 * line works on an empty board. Three of the deck's creatures are Wizards and the other four are
 * not, which is the honest version of this card — she pumps the ones that share her type and the
 * Pyromancer tokens are on their own.
 *
 * What the deck does not have, said out loud: a sweeper, a way to answer a resolved permanent that
 * is not a creature, and any card that gains life. It expects to be the deck with the shorter
 * clock, and against the two decks whose clock is shorter still it has to be the one holding
 * Counterspell. Where that actually leaves it is measured rather than claimed — see the table in
 * claude/play-realm-setup.md.
 */
export const ARC_TEMPEST: DeckSpec = {
  id: 'arc-tempest',
  name: 'Arc Tempest',
  description: 'Red-blue spells. Every creature here is paid for by the instant you were casting anyway.',
  commander: ADELIZ,
  cards: [
    { card: MOUNTAIN, count: 7 },
    { card: ISLAND, count: 7 },
    { card: IZZET_GUILDGATE, count: 3 },
    /*
      Two cycling lands in each colour, and this deck wants them more than the two decks that
      already run them.

      A deck of one- and two-mana spells floods on the fourth land and keeps flooding, and a land
      that becomes a card for {2} is a land that is never the eighth one. It is also two spells out
      of one card for everything here that counts casts — the cycling is an ability, not a cast, so
      it does not feed Guttersnipe, but drawing into the spell it finds does.
    */
    { card: FORGOTTEN_CAVE, count: 2 },
    { card: LONELY_SANDBAR, count: 2 },
    /*
      Twenty-one lands for a curve that stops at four, which is a land fewer than most of the pool.

      Twelve sources of each colour, counting the Guildgates on both sides. The two cards that want
      more than that are Counterspell and Saw It Coming at {U}{U}, and Saw It Coming is the one card
      in the deck that can be put somewhere for {2} on the turn the second Island has not arrived.
    */

    // ── The creatures that read the spells ──
    /*
      Seven creatures, which is fewer than any other deck in the pool and is the point: a creature
      here is not the plan, it is the multiplier on the plan. The deck wins with a Guttersnipe in
      play and twelve burn spells in the library, or with a Swiftspear and two cantrips, and it can
      win with neither — twelve of the spells point at a face.
    */
    { card: MONASTERY_SWIFTSPEAR, count: 2 },
    /*
      And the third Swiftspear's slot, which went to the pool's first **rebound** card.

      A Staggershock is two spells for one card on two consecutive turns, and this is the deck where
      that is worth more than a 1/2 with prowess: a Guttersnipe, a Thermo-Alchemist and two
      Swiftspears all read "whenever you cast", so the second casting arrives on a turn when the
      board is already set up to notice it. The Swiftspear is the right card to pay for it — three
      copies of a one-drop in a deck whose curve starts at one and whose other eight copies live in
      Ember Rush and Forge Alliance.
    */
    { card: STAGGERSHOCK, count: 1 },
    { card: STORMCHASER_MAGE, count: 1 },
    /*
      Goblin Electromancer, for the second Stormchaser Mage.

      Twenty-five of this deck's sixty cards are instants and sorceries, so a 2/2 that makes every
      one of them cost {1} less is the most generic-mana a single card in this pool can save. What
      it does *not* touch is the coloured half (CR 601.2f): Counterspell stays {U}{U}, and the cards
      it helps most are the ones with generic in them — Arc Lightning, Behold the Multiverse,
      Twincast, Fireball's X.
    */
    { card: GOBLIN_ELECTROMANCER, count: 1 },
    { card: YOUNG_PYROMANCER, count: 2 },
    { card: GUTTERSNIPE, count: 2 },
    // The two that untap on a cast, which is the deck's inevitability: a board the deck cannot
    // attack into still loses to a Gelectrode and three cantrips. The Alchemist has defender and
    // cannot be aimed; Gelectrode can be, and is also the deck's answer to an X/1.
    { card: GELECTRODE, count: 2 },
    { card: THERMO_ALCHEMIST, count: 2 },
    { card: ENIGMA_DRAKE, count: 1 },
    /*
      And the two **transform** creatures, paid for by the second Lightning Bolt and the second
      Counterspell.

      This is the deck they belong in and it is not close. Delver of Secrets wants a library that is
      twenty-five instants and sorceries out of sixty; Thing in the Ice wants four of them cast,
      which this deck does by turn five on an ordinary draw. They are also what the deck was
      shortest of — it ran seven creatures, fewer than anything else in the pool — and a one-mana
      1/1 that becomes a 3/2 flier and a two-mana 0/4 that holds the ground until it is a 7/8 are
      bodies that cost the plan nothing.

      **Two doubles trimmed rather than two singletons cut**, which is a deliberate choice about
      this file rather than about the deck: nearly every one-of in here is the pool's only copy of a
      mechanic or the card a test reaches for by name, and cutting one orphans work elsewhere for no
      gain. The second Bolt is the most redundant card in a deck that keeps ten other pieces of
      burn, and Counterspell's {U}{U} is the hardest cost in a twelve-blue-source deck by the
      description's own account — one copy plus Saw It Coming, Squelch and Swerve is still the
      interaction the deck had.

      **No claim that this is stronger.** The slot has not been priced, and D229's rule applies: a
      keyword needs a card in a deck to exist in the pool at all, and that is why these are here.
    */
    { card: DELVER_OF_SECRETS, count: 1 },
    { card: THING_IN_THE_ICE, count: 1 },

    // ── Twelve spells that point at a face ──
    { card: LIGHTNING_BOLT, count: 1 },
    /*
      The pool's split card, for the last Shock.

      **Not for the slot `cast-counts` pointed at**, which is the part worth writing down. The
      deadest card in this deck by a distance is the Squelch at 19% — cast five times in the
      twenty-six games it was in hand — and cutting it would have taken the pool's only "counter
      target activated ability" out of every deck, orphaning a script and three tests to buy one
      slot. Cast rate measures how often a card is *castable*, not how much it does when it is: the
      Shock is cast in nine games out of ten and is the weakest card in a deck that already runs two
      Lightning Bolts, two Lightning Strikes, a Lava Spike, a Burst Lightning, two Magma Jets and a
      Firebolt. One mana for two damage is the one piece of burn here that nothing misses.

      Fire is a better Shock in this deck — two damage for two mana, divisible between two things —
      and Ice is the half that makes it never a dead card: tap a blocker, tap a land on their upkeep,
      draw. It is also the one card in the pool that can be either of this deck's two colours, which
      is what a split card is for.
    */
    { card: FIRE_ICE, count: 1 },
    { card: LIGHTNING_STRIKE, count: 1 },
    /*
      Arc Lightning for the second Shock, and the one card here that kills two creatures.

      Three damage for {2}{R}, divided as you choose among one, two or three targets — the first
      card in the pool that announces numbers along with its targets (CR 601.2d). Against the two
      token decks and the three decks with an X/1 on turn one, one card answers two creatures; and
      the half that is not the division is that a deck of twelve burn spells now has one that is
      not a one-for-one.

      **It measures as free, and that is the honest reading.** 270 paired duels against the field,
      two seed sets: taking it back out for a second Shock is −9 and −1, so the card is worth +9
      and +1 — the same sign both times and both well inside the eighteen-game floor. A new card's
      bar is "costs nothing", and it clears that.

      **The cut is unpriceable, so the cards decided it.** Cutting the Magma Jet instead measured
      −10 and +1 — no consistent sign, which means this instrument cannot tell the two cuts apart.
      So the argument is the one the Squelch cut used (D134): the second Shock is the most
      redundant card in a deck that already holds twelve spells pointing at a face, where Magma
      Jet's scry is the half this deck is short of — a deck that needs its one Guttersnipe needs
      to find it.
    */
    { card: ARC_LIGHTNING, count: 1 },
    // Magma Jet over a third Lightning Strike: the scry is the half this deck is short of, since a
    // deck that needs its one Guttersnipe needs to find it.
    { card: MAGMA_JET, count: 1 },
    { card: BURST_LIGHTNING, count: 1 },
    { card: LAVA_SPIKE, count: 1 },
    /*
      **Grapeshot, for the second Magma Jet**: the pool's first storm card, in the only deck that
      casts three cheap spells in a turn as a matter of course.

      {R} for one damage is unplayable on its own, which is the point — the card is the deck's own
      plan written down, and the fourth spell of a turn is four damage. Every other card in this
      list that rewards a turn full of spells rewards it *once* per spell (Guttersnipe, Young
      Pyromancer, Thermo-Alchemist); this one multiplies by how many there were.

      **The slot is not the obvious one, and that is worth saying.** Twincast is the least-cast
      card in this deck by a distance — 2 casts in 96 games, 8% of the games it was in hand — and
      cutting it would have left `copySpellOnStack`'s "you may choose new targets for the copy"
      with no card in any deck, which is the one thing this pool does not do: a path with no card
      behind it is a path nobody plays. So the slot is the second Magma Jet (9 casts per copy),
      and Twincast stays in as the card that keeps that clause honest.
    */
    { card: GRAPESHOT, count: 1 },
    // Firebolt, which is two casts out of one card — the flashback is the second trigger for every
    // creature on the board, and the pool's only burn spell that is.
    /*
      Twincast was tried here, measured out, went to Tidal Mind, and has come back.

      All three steps are worth leaving written down, because together they are the clearest thing
      this project has measured about *slots*. It reads like an Izzet card in the Izzet deck: a
      second Fireball on the turn the game ends, a second Counterspell against the decks that go
      over the top of this one. In the **burn** slots it cost about nine games in 240 whatever it
      replaced — −8 and −10 in the Lava Spike's on two seed sets, −9 against a second Faithless
      Looting — and the instrument said why rather than leaving it a mystery: of 23 casts across
      120 duels, seven copied a Lightning Bolt and seven copied a *cantrip*, which is four mana for
      one card in a deck whose clock starts on turn three.

      So it went to Tidal Mind, where four mana is affordable. There it was that deck's **least-cast
      card at 20%** — 18 casts in the 89 games it reached hand — and it came out in the six-slot
      rebuild that finally moved that deck's record. It is back here in the **second Behold the
      Multiverse's** slot rather than a burn spell's, and there it is **+3 and +2 on two seed sets**:
      free, inside the floor, and the deck keeps the pool's only copy of a card that copies a spell.
      The same card, the same deck, and the slot is the whole difference.
    */
    // The X spell, which is what the deck's unspent mana is for on the turn the game ends.
    { card: FIREBALL, count: 1 },

    // ── Eight that find the next spell ──
    { card: PREORDAIN, count: 1 },
    /*
      The second Preordain's slot, spent on **split second** — and the payer is a cantrip because
      every burn spell in this deck is a better burn spell.

      Sudden Shock was first measured against the **Lightning Strike**: same cost, same colour, same
      card type, a damage fewer, which is as clean as a slot probe gets. It came back at **22 and 17
      games of 288 against it** — the one slot reading in this project outside the ±20 floor on the
      first try, and it says plainly that in this pool the window is worth less than the third
      damage. A Bolt and a Magma Jet would say the same thing, so there is no burn slot here the
      keyword wins.

      So the committed slot is the second cantrip's, and the number for it is reported beside the
      Lightning Strike reading rather than instead of it. Both are in D218, because a slot's number
      is a fact about the payer and quoting only the flattering one would be the mistake D211 is
      about.
    */
    { card: SUDDEN_SHOCK, count: 1 },
    // Think Twice, for the same reason as Firebolt: one card, two casts, and the second one comes
    // on a turn the hand is empty.
    { card: THINK_TWICE, count: 1 },
    /*
      The second Think Twice's slot, which went to the pool's first **replicate** card.

      Pyromatics is a *bad card* at its printed rate and that is the point of the slot: one damage
      for two mana is unplayable, and the same card on turn eight is three damage divided wherever
      it is needed at instant speed. What it replaces is the deck's second copy of a cantrip it
      already has six other ways to do — two Preordains, a Behold the Multiverse, a Faithless
      Looting and the first Think Twice — so what the deck gives up is redundancy and what it buys
      is a mana sink, which it had none of.

      It was first tried in the **Firebolt's** slot and measured at ten and nineteen games of 288
      across two seed sets (D207). A Firebolt is two damage for {R} and two more from the graveyard;
      losing that for a one-damage spell is a real cost, and the number said so twice. This is the
      cheaper slot, measured the same way.
    */
    { card: PYROMATICS, count: 1 },
    // Behold the Multiverse, which is the deck's two-mana play on a turn it has nothing else to do
    // and its four-mana draw-two on a turn it does.
    // One Behold rather than two, and the pool's last copy: Tidal Mind's went in its rebuild, so
    // this is the card that keeps foretell's draw-and-scry half cast and tested. The second copy
    // is the Twincast's slot, measured above.
    { card: BEHOLD_THE_MULTIVERSE, count: 1 },
    { card: FAITHLESS_LOOTING, count: 1 },

    // ── Five that say no ──
    /*
      The concession that this deck is not actually the fastest in the pool.

      Ember Rush and Forge Alliance both put a creature on the board on turn one, and a deck whose
      own clock starts on turn three has to survive theirs. Counterspell is the card; Saw It Coming
      is the one that can be paid for on a turn when the mana was needed elsewhere; Essence Scatter
      is the narrow one, and it is narrow in the right direction, since six of the nine decks here
      win with creatures.
    */
    { card: COUNTERSPELL, count: 1 },
    /*
      Squelch for the Essence Scatter, and the cut was worth more than the card again.

      Two mana at instant speed that counters an **activated ability** and draws a card. The narrow
      half has something to point at more often in this pool than it sounds — an Icy Manipulator, a
      Jace, an equip, a crew, a cycling land — and when it has nothing, it is not castable at all
      rather than wasted; the draw is what makes a counter this narrow worth a slot. The honest
      limit is in the same sentence: on a turn nobody activates anything it sits in hand.

      **Which card came out decided this twice over.** Three arrangements, 240 paired duels against
      the field each, two seed sets: no Squelch at all is 100-140 and 99-141; Squelch for the
      *Divination* is 98-142 and 89-151, which is worse both times; Squelch for the Essence Scatter
      is 102-137 and 103-137, which is better both times. Four and fourteen games between the two
      cuts of one card — the fourth time this project has measured that (D133, D134).

      Why the Essence Scatter rather than the Divination, read off the cards: a Divination is this
      deck's only way to refill, and Stormchaser Mage, Gelectrode, Young Pyromancer and Enigma
      Drake all pay it for *any* cast, so three mana on its own turn still buys two of those. The
      Essence Scatter was the redundant answer — this deck beats the slow decks it could counter a
      creature from and loses to the fast ones it cannot counter enough of.
    */
    { card: SQUELCH, count: 1 },
    { card: SAW_IT_COMING, count: 1 },
    /*
      Swerve for the Negate, and the difference is what the deck does with the half-turn.

      A Negate stops a removal spell. A Swerve sends it at something of theirs — so against the two
      decks that beat this one, a card that was going to kill a Guttersnipe kills one of their own
      creatures instead, which is a two-card swing out of one {1}{U}{R}. It is also the only card in
      these colours that answers a *burn spell aimed at the face*, by aiming it back.

      Negate was this deck's least-cast answer at 62%, and Hollow Tide and Skyward Writ both keep
      their copies.
    */
    { card: SWERVE, count: 1 },
    { card: TWINCAST, count: 1 },
    /*
      And the first card in the pool whose cost is partly its own graveyard: a 2/2 flier that
      comes back for {2}{R}{R} and three cards, as often as the graveyard can stand it
      (escape, CR 702.139).

      Here rather than in Ember Rush because the price is the graveyard and this is the deck that
      fills one: two Think Twices, a Firebolt, a Faithless Looting and twenty-odd one-mana spells
      put four or five cards in there by turn five, and nothing else in the list wanted them.
      Against the three fastest decks it is the card this deck has never had — a threat that does
      not care about a Doom Blade, in a deck whose creatures all die to one.

      It replaced the **Divination** (cast in 65% of games, the deck's weakest card that is not
      the pool's only copy of itself — three others run one, so cutting this one deletes no
      script's coverage). Four mana for two cards in a deck whose curve stops at four was the
      slot that bought the least.
    */
    { card: PHOENIX_OF_ASH, count: 1 },
    /*
      Thunderous Wrath, and the two burn spells it cost.

      Five damage for {R} when it is the first card drawn this turn, and six mana for five damage
      when it is not — which is a card this deck would never cast, and exactly the point. Its curve
      stops at four and its plan is spells, so a six-mana burn spell is dead weight the moment it is
      in an opening hand; off the top of the library it is better than anything else in the list.

      It cost the Firebolt and the second Lightning Strike, which are two of the deck's eleven burn
      spells and the two it misses least; both survive elsewhere in the pool. The two Preordains
      stay, and they are the reason this is the right deck for the keyword rather than only a deck
      that can cast it: a Preordain puts the Wrath on **top** of the library, and the next card you
      draw is the first card you drew that turn.
    */
    { card: THUNDEROUS_WRATH, count: 1 },
    { card: FIREBOLT, count: 1 },
  ],
};

// ── The tenth deck's own cards ──────────────────────────────────────────────────────────────────

const ORZHOV_GUILDGATE: CardDef = {
  name: 'Orzhov Guildgate',
  typeLine: 'Land \u2014 Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Orzhov Guildgate enters the battlefield tapped.\n{T}: Add {W} or {B}.',
  colors: [],
};

const IMPASSIONED_ORATOR: CardDef = {
  name: 'Impassioned Orator',
  typeLine: 'Creature \u2014 Human Cleric',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '2',
  toughness: '1',
  oracleText: 'Whenever another creature enters the battlefield, you gain 1 life.',
  colors: ['W'],
};

const CRUEL_CELEBRANT: CardDef = {
  name: 'Cruel Celebrant',
  typeLine: 'Creature \u2014 Vampire Soldier',
  manaCost: '{W}{B}',
  cmc: 2,
  power: '1',
  toughness: '2',
  oracleText: 'Whenever another creature you control dies, each opponent loses 1 life and you gain 1 life.',
  colors: ['W', 'B'],
};

const REVITALIZE: CardDef = {
  name: 'Revitalize',
  typeLine: 'Instant',
  manaCost: '{W}',
  cmc: 1,
  oracleText: 'You gain 3 life.\nDraw a card.',
  colors: ['W'],
};

const VRASKAS_CONTEMPT: CardDef = {
  name: "Vraska's Contempt",
  typeLine: 'Instant',
  manaCost: '{2}{B}{B}',
  cmc: 4,
  oracleText: 'Exile target creature or planeswalker. You gain 2 life.',
  colors: ['B'],
};

const KAMBAL: CardDef = {
  name: 'Kambal, Consul of Allocation',
  typeLine: 'Legendary Creature \u2014 Human Advisor',
  manaCost: '{2}{W}{B}',
  cmc: 4,
  power: '2',
  toughness: '3',
  oracleText: 'Whenever an opponent casts a noncreature spell, that player loses 2 life and you gain 2 life.',
  colors: ['W', 'B'],
};

/*
  Embalm and eternalize, and the four cards that carry them.

  All four are white Amonkhet cards and all four go into one deck on purpose: a keyword spread over
  four lists is four noisy slots, and a keyword whose whole point is "a second use of a card you
  already spent" has to be in one list often enough to be seen. Dawn Tithe is the deck that most
  wants what they do — its archetype is that gaining life is an **input** other cards read, so a
  lifelinking blocker you get twice for two mana in total is two of its cards in one, and a body
  whose arrival gains two life is worth arriving twice.

  It is also the only white deck with no graveyard hate of its own. Skyward Writ runs the pool's one
  Rest in Peace, and a symmetric graveyard hoser and six cards that need a graveyard cannot sensibly
  be in the same sixty — which is a deckbuilding fact rather than an engine one, and the reason
  these are here and not there.

  Their oracle text carries the reminder text in full, because a token whose characteristics are not
  the card's is the one case where a player cannot work out what they are getting from the card face.
*/
/**
 * The pool's first **level up** card, and a one-drop that is three different creatures.
 *
 * A 1/1 for {W} is a bad card. Three more white mana, spread over whichever turns had nothing better
 * to do, make it a 3/3 with first strike; four more after that make it a 4/4 with double strike. The
 * card never changes — what changes is how much of the game's spare mana went into it.
 *
 * The bands are printed data rather than script behaviour, which is why they are here: what a
 * leveler *is* at each level is a line on the card, exactly as its base 1/1 is. See
 * `CardDef.levelBands` and `CardScript.levelUp`.
 */
const STUDENT_OF_WARFARE: CardDef = {
  name: 'Student of Warfare',
  typeLine: 'Creature — Human Soldier',
  manaCost: '{W}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'Level up {W} (Activate only as a sorcery.)\nLEVEL 2-6: 3/3, first strike\nLEVEL 7+: 4/4, double strike',
  colors: ['W'],
  levelBands: [
    { from: 2, power: 3, toughness: 3, keywords: ['first strike'] },
    { from: 7, power: 4, toughness: 4, keywords: ['double strike'] },
  ],
};

/**
 * The same bargain in green, in the deck that has the mana to take it.
 *
 * A 2/2 for two that becomes a 4/4 and then a 6/6 with trample. Kindle Grove ramps, so it reaches
 * the second band a turn or two earlier than a white deck would — which is the difference a slot
 * probe can actually see.
 */
const BEASTBREAKER_OF_BALA_GED: CardDef = {
  name: 'Beastbreaker of Bala Ged',
  typeLine: 'Creature — Human Warrior',
  manaCost: '{1}{G}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'Level up {1}{G} (Activate only as a sorcery.)\nLEVEL 1-3: 4/4\nLEVEL 4+: 6/6, trample',
  colors: ['G'],
  levelBands: [
    { from: 1, power: 4, toughness: 4 },
    { from: 4, power: 6, toughness: 6, keywords: ['trample'] },
  ],
};

const SACRED_CAT: CardDef = {
  name: 'Sacred Cat',
  typeLine: 'Creature \u2014 Cat',
  manaCost: '{W}',
  cmc: 1,
  power: '1',
  toughness: '1',
  oracleText: 'Lifelink\nEmbalm {W} ({W}, Exile this card from your graveyard: Create a token '
    + 'that\u2019s a copy of it, except it\u2019s a white Zombie Cat with no mana cost. '
    + 'Embalm only as a sorcery.)',
  colors: ['W'],
};

const ADORNED_POUNCER: CardDef = {
  name: 'Adorned Pouncer',
  typeLine: 'Creature \u2014 Cat',
  manaCost: '{1}{W}',
  cmc: 2,
  power: '1',
  toughness: '1',
  oracleText: 'Double strike\nEternalize {4}{W}{W} ({4}{W}{W}, Exile this card from your '
    + 'graveyard: Create a token that\u2019s a copy of it, except it\u2019s a black Zombie Cat '
    + 'with base power and toughness 4/4 and no mana cost. Eternalize only as a sorcery.)',
  colors: ['W'],
};

const SUNSCOURGE_CHAMPION: CardDef = {
  name: 'Sunscourge Champion',
  typeLine: 'Creature \u2014 Human Cleric',
  manaCost: '{2}{W}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'When Sunscourge Champion enters the battlefield, you gain 2 life.\n'
    + 'Eternalize {5}{W}{W} ({5}{W}{W}, Exile this card from your graveyard: Create a token '
    + 'that\u2019s a copy of it, except it\u2019s a black Zombie Human Cleric with base power and '
    + 'toughness 4/4 and no mana cost. Eternalize only as a sorcery.)',
  colors: ['W'],
};

const ANGEL_OF_SANCTIONS: CardDef = {
  name: 'Angel of Sanctions',
  typeLine: 'Creature \u2014 Angel',
  manaCost: '{3}{W}{W}',
  cmc: 5,
  power: '3',
  toughness: '4',
  oracleText: 'Flying\nWhen Angel of Sanctions enters the battlefield, exile another target '
    + 'nonland permanent an opponent controls until Angel of Sanctions leaves the battlefield.\n'
    + 'Embalm {3}{W}{W} ({3}{W}{W}, Exile this card from your graveyard: Create a token that\u2019s '
    + 'a copy of it, except it\u2019s a white Zombie Angel with no mana cost. '
    + 'Embalm only as a sorcery.)',
  colors: ['W'],
};

/**
 * Dawn Tithe: the tenth deck, and the first whose life total goes up on purpose.
 *
 * Nine decks, and eight of them measured the game in damage while one measured it in cards. Not one
 * of them gained life as a *plan* — and `life-gained` has been a trigger event since the triggers
 * were written, with exactly one card in the whole pool reading it: an Ajani's Pridemate, sitting
 * in a red-white deck that gains life by accident. An engine path with one reader is a gap in the
 * pool rather than a gap in the engine, which is the same argument the ninth deck was built on.
 *
 * What makes it an archetype rather than a theme is that the gain is an **input**. Two creatures
 * turn it into a body that grows (Ajani's Pridemate on the ground, Bloodthirsty Aerialist in the
 * air); two turn a death into both totals moving at once (Blood Artist, Cruel Celebrant); and the
 * removal spell gains two life while it removes, so the same four mana that answers the thing
 * killing you puts a counter on the thing killing them. Exsanguinate is the end of it: X life from
 * each opponent and X to you, which in this deck is cast for five or six.
 *
 * Kambal is the commander because he is the half a deck list cannot be. "Whenever an opponent casts
 * a noncreature spell, that player loses 2 life and you gain 2 life" is an answer to the four decks
 * whose plan is spells rather than creatures, it needs nothing to have resolved first, and it is the
 * first card in this pool to say "**that** player" and mean one of them.
 *
 * What the deck does not have, said out loud: a sweeper, a counterspell, any haste, and no way to
 * win in one turn. Its removal is one-for-one and its clock is two fliers that have to survive a
 * few turns to be worth attacking with — so against the fastest decks it is racing from behind on
 * the board while ahead on life, which is the trade the whole list is built around. Where that
 * actually leaves it is measured rather than claimed: see the table in
 * `claude/play-realm-setup.md`.
 */
export const DAWN_TITHE: DeckSpec = {
  id: 'dawn-tithe',
  name: 'Dawn Tithe',
  description: 'White-black lifegain. Gain life on everything that happens, turn it into counters and drain, and take the difference.',
  commander: KAMBAL,
  cards: [
    { card: PLAINS, count: 8 },
    { card: SWAMP, count: 8 },
    { card: ORZHOV_GUILDGATE, count: 3 },
    // Two cycling lands in each colour, as every slow deck in this pool runs: a land this deck does
    // not need is a card it could have gained life with.
    { card: SECLUDED_STEPPE, count: 2 },
    { card: BARREN_MOOR, count: 2 },

    // ── The engine: everything that puts the life total up ──
    /*
      Three one- and two-drops that gain life off the whole table rather than off this deck.

      "Whenever another creature enters" is every creature anybody plays, which is what makes a
      lifegain deck work at all in a pool where six of ten decks flood the board: the opponent's
      own Goblin is a +1/+1 counter on an Aerialist. The Orator is the Warden with a body, because
      a 1/1 that the whole plan runs through is a 1/1 the aggro decks remove for free.
    */
    { card: SOUL_WARDEN, count: 1 },
    { card: IMPASSIONED_ORATOR, count: 1 },
    // A one-drop flier with lifelink, which is the cheapest repeatable trigger there is: it gains
    // life every time it connects and every time it blocks.
    { card: HEALERS_HAWK, count: 1 },
    // Three, and the third is one of the four slots the balance pass below bought back.
    { card: CHILD_OF_NIGHT, count: 2 },

    // ── The payoffs: what the life is for ──
    /*
      The two halves of "whenever you gain life", and the air is the half that matters.

      A Pridemate grows on the ground, where a 1/1 Hawk or a 0/4 Wall stops it dead. The Aerialist
      flies, so the counters are a clock rather than a cushion — and in a deck where the lifegain
      happens on everybody's turn, a 2/2 that is a 5/5 by turn six is the whole win condition.

      **One Aerialist and not two, and the measurement is why.** The first version of this list
      came in at 66% against the nine-deck field — second in the pool, and winning the four
      slowest matchups 19-5 to 22-2, which is a matchup nobody enjoys being on either side of. The
      second copy of the card the deck is built around is the single biggest part of that. Said
      plainly because it is uncomfortable: the archetype's best card is a one-of so that the
      archetype is a game.
    */
    { card: AJANIS_PRIDEMATE, count: 1 },
    /*
      The second Pridemate's slot, spent on **level up**.

      Both are white creatures that get bigger, which is as close to a fair payer as this deck has:
      the Pridemate grows when the deck does what it already does, and the Student grows when the
      deck has mana it had nothing else to spend — which is the thing a deck that holds mana up and
      passes has never had a use for. See D216.

      Not the second Sacred Cat, which was the first choice and is load-bearing: a test embalms one
      copy and then reads the *other* out of the library to prove the printed definition was left
      alone, so a deck with one Cat in it has no way to make that claim.
    */
    { card: STUDENT_OF_WARFARE, count: 1 },
    { card: BLOODTHIRSTY_AERIALIST, count: 1 },
    /*
      The two drains, and why both: the Artist aims and the Celebrant does not.

      Blood Artist targets a player, which in a pod means the one closest to dead and in a duel
      means the only one there is. Cruel Celebrant says "each opponent" and needs no target at all,
      so it keeps working when the Artist's target is gone — and it only reads this deck's own
      creatures dying, which with a Bone Splinters is a cost that pays for itself twice.
    */
    { card: BLOOD_ARTIST, count: 1 },
    { card: CRUEL_CELEBRANT, count: 2 },
    { card: ZULAPORT_CUTTHROAT, count: 1 },
    { card: VAMPIRE_NIGHTHAWK, count: 2 },
    // One five-drop, and it is the only creature here that is good without the engine running.

    // ── The answers, three of which gain life on the way ──
    /*
      Vraska's Contempt is the card that argues for the whole deck: four mana to exile the thing
      that is killing you and two life, which is a +1/+1 counter on an Aerialist and another on a
      Pridemate. Exile rather than destroy answers the two things in this pool that come back.

      Swords to Plowshares is the other half of the joke — its own text gains *them* life, and it
      is still the best removal spell in the pool.
    */
    { card: VRASKAS_CONTEMPT, count: 1 },
    { card: SWORDS_TO_PLOWSHARES, count: 2 },
    { card: DOOM_BLADE, count: 1 },
    { card: HEALING_SALVE, count: 1 },
    { card: MURDER, count: 1 },
    { card: PACIFISM, count: 1 },
    { card: JOURNEY_TO_NOWHERE, count: 1 },
    { card: DISENCHANT, count: 1 },
    // Four mana that is dead on your own turn and kills whatever attacked into it, which is the
    // card a deck that blocks for five turns actually wants.
    { card: DIVINE_VERDICT, count: 1 },
    // A removal spell whose cost is a creature, in the one deck where losing a creature is two
    // drains and a +1/+1 counter.
    { card: BONE_SPLINTERS, count: 1 },

    // ── Cards, life, and the end of it ──
    { card: REVITALIZE, count: 2 },
    /*
      One Healing Salve, and Palace Sentinels for the other — the crown, in the deck that can keep
      it (CR 720).

      A 2/3 for four that draws an extra card at the beginning of every one of your own end steps
      is a fair rate; the catch is that the crown goes to whoever deals you combat damage, so the
      card is only as good as your ability to stop being hit. This deck gains life, blocks with
      Nighthawks and plays four removal spells, which is the shape that holds a crown — and if it
      loses it, the Soul Wardens and the Pridemates are still a deck. The Salve was its weakest
      card and the one nothing else in the list reads.
    */
    { card: PALACE_SENTINELS, count: 1 },
    { card: SIGN_IN_BLOOD, count: 1 },
    { card: READ_THE_BONES, count: 1 },
    { card: MIND_STONE, count: 1 },
    /*
      Embalm and eternalize, and the six cards they cost.

      Four cards that are each two cards, in the deck whose plan is to be gaining life while it is
      behind on board: a {W} 1/1 lifelinker that blocks twice for two mana in total, a {1}{W} double
      striker that comes back as a 4/4 double striker, a {2}{W} body that gains two life on arrival
      and arrives twice, and a 3/4 flier whose Journey to Nowhere happens again after it dies.
      Nothing in the list did that before — every card it had was spent the moment it was cast,
      and this deck is the one that most often reaches turn eight with mana to spare and an empty
      hand.

      The six that came out are the redundant copies of what these four already are. The second
      Healer's Hawk is the Sacred Cat and the third Child of Night is the Adorned Pouncer \u2014 the
      same one- and two-drop lifelinkers with a second use. The second Impassioned Orator and the
      third Revitalize are the deck's two most replaceable cards by its own notes, which is to say
      the ones whose job is to be a card rather than to do something. The Serra Angel is the
      five-drop flier the Angel of Sanctions is, with removal attached; and the second Doom Blade is
      the removal spell that cannot point at a black creature, in a field where five decks are
      black — where the Angel exiles anything, and exiles a second thing after it has died.
    */
    { card: SACRED_CAT, count: 2 },
    { card: ADORNED_POUNCER, count: 2 },
    { card: SUNSCOURGE_CHAMPION, count: 1 },
    { card: ANGEL_OF_SANCTIONS, count: 1 },
    /*
      And no Exsanguinate, which the first version of this list had.

      X life from each opponent and X to you is *inevitability*: against the four decks that cannot
      end a game quickly it turned a long position into a won one, and those were exactly the
      matchups this deck was winning 19-5. Cutting it, the second Aerialist and the second Vraska's
      Contempt for two more one-mana lifegain spells and a third Child of Night measured −14 and
      −14 over 270 paired duels on two seed sets: consistent, and the right fourteen games.

      What it costs the deck is the ability to win a game it is not already winning, which is a
      real loss and the intended one. The clock is now the Pridemates and one Aerialist, and if
      they are answered the game goes long with nothing at the end of it.
    */
  ],
};

const GRUUL_GUILDGATE: CardDef = {
  name: 'Gruul Guildgate',
  typeLine: 'Land \u2014 Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Gruul Guildgate enters the battlefield tapped.\n{T}: Add {R} or {G}.',
  colors: [],
};

/*
  The thirteenth deck's own cards, and the colour pair twelve decks had missed.

  Red-green is the one pairing nothing in this pool played, which is how the split cards found out:
  Assault // Battery is {R} and {3}{G}, and when the split card shipped there was no deck that could
  cast both halves, so the card sat unused while Fire // Ice and Wax // Wane went into decks. It is
  here now, which is the cleanest kind of reason to build a deck.
*/

const RURIC_THAR: CardDef = {
  name: 'Ruric Thar, the Unbowed',
  typeLine: 'Legendary Creature \u2014 Ogre Warrior',
  manaCost: '{4}{R}{G}',
  cmc: 6,
  power: '6',
  toughness: '6',
  oracleText: 'Vigilance, reach\nAll creatures must attack each combat if able.\nWhenever a player casts a noncreature spell, Ruric Thar, the Unbowed deals 6 damage to that player.',
  colors: ['R', 'G'],
};

const ASSAULT_BATTERY: CardDef = {
  name: 'Assault // Battery',
  typeLine: 'Sorcery // Sorcery',
  manaCost: '{R} // {3}{G}',
  cmc: 5,
  oracleText: 'Assault deals 2 damage to any target.\nCreate a 3/3 green Elephant creature token.',
  colors: ['R', 'G'],
  faces: {
    kind: 'split',
    cards: [
      {
        name: 'Assault',
        typeLine: 'Sorcery',
        manaCost: '{R}',
        cmc: 1,
        oracleText: 'Assault deals 2 damage to any target.',
        colors: ['R'],
      },
      {
        name: 'Battery',
        typeLine: 'Sorcery',
        manaCost: '{3}{G}',
        cmc: 4,
        oracleText: 'Create a 3/3 green Elephant creature token.',
        colors: ['G'],
      },
    ],
  },
};

const BURNING_TREE_EMISSARY: CardDef = {
  name: 'Burning-Tree Emissary',
  typeLine: 'Creature \u2014 Human Shaman',
  manaCost: '{R}{G}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: 'When Burning-Tree Emissary enters the battlefield, add {R}{G}.',
  colors: ['R', 'G'],
};

const GRUUL_RAGEBEAST: CardDef = {
  name: 'Gruul Ragebeast',
  typeLine: 'Creature \u2014 Beast',
  manaCost: '{5}{R}{G}',
  cmc: 7,
  power: '6',
  toughness: '5',
  oracleText: 'Whenever Gruul Ragebeast or another creature enters the battlefield under your control, that creature fights target creature you don\u2019t control.',
  colors: ['R', 'G'],
};

const SAVAGE_TWISTER: CardDef = {
  name: 'Savage Twister',
  typeLine: 'Sorcery',
  manaCost: '{X}{R}{G}',
  cmc: 2,
  oracleText: 'Savage Twister deals X damage to each creature.',
  colors: ['R', 'G'],
};

const RANCOR: CardDef = {
  name: 'Rancor',
  typeLine: 'Enchantment \u2014 Aura',
  manaCost: '{G}',
  cmc: 1,
  oracleText: 'Enchant creature\nEnchanted creature gets +2/+0 and has trample.\nWhen Rancor is put into a graveyard from anywhere, return Rancor to its owner\u2019s hand.',
  colors: ['G'],
};

const THRAGTUSK: CardDef = {
  name: 'Thragtusk',
  typeLine: 'Creature \u2014 Beast',
  manaCost: '{4}{G}',
  cmc: 5,
  power: '5',
  toughness: '3',
  oracleText: 'When Thragtusk enters the battlefield, you gain 5 life.\nWhen Thragtusk leaves the battlefield, create a 3/3 green Beast creature token.',
  colors: ['G'],
};

const SIMIC_GUILDGATE: CardDef = {
  name: 'Simic Guildgate',
  typeLine: 'Land — Gate',
  manaCost: '',
  cmc: 0,
  oracleText: 'Simic Guildgate enters the battlefield tapped.\n{T}: Add {G} or {U}.',
  colors: [],
};

const EXPLORE: CardDef = {
  name: 'Explore',
  typeLine: 'Sorcery',
  manaCost: '{G}',
  cmc: 1,
  oracleText: 'You may play an additional land this turn.\nDraw a card.',
  colors: ['G'],
};

const KIORAS_FOLLOWER: CardDef = {
  name: "Kiora's Follower",
  typeLine: 'Creature — Merfolk Elemental',
  manaCost: '{G}{U}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: '{T}: Untap another target permanent.',
  colors: ['G', 'U'],
};

const PELAKKA_WURM: CardDef = {
  name: 'Pelakka Wurm',
  typeLine: 'Creature — Wurm',
  manaCost: '{4}{G}{G}{G}',
  cmc: 7,
  power: '7',
  toughness: '7',
  oracleText: 'Trample\nWhen Pelakka Wurm enters the battlefield, you gain 7 life.\nWhen Pelakka Wurm dies, draw a card.',
  colors: ['G'],
};

const TATYOVA: CardDef = {
  name: 'Tatyova, Benthic Druid',
  typeLine: 'Legendary Creature — Merfolk Druid',
  manaCost: '{3}{G}{U}',
  cmc: 5,
  power: '2',
  toughness: '2',
  oracleText: 'Whenever a land you control enters the battlefield, draw a card and you gain 1 life.',
  colors: ['G', 'U'],
};

/**
 * Delta Bloom: the eleventh deck, and the first whose plan is its own mana.
 *
 * Every other deck here spends mana on a plan. This one's plan *is* the mana: nine accelerants and
 * twenty-three lands into a top end nothing else in the pool can cast on curve, with a commander
 * who turns every land drop after the fifth into a card and a life. Explore is the piece that
 * makes it a deck rather than a pile of ramp — a land drop is a card with Tatyova out, so "play an
 * additional land this turn" is "draw two" at five mana.
 *
 * Green-blue is the last colour pair in the ten-deck pool that nothing used, and the plan is new
 * too: the only other deck that ramps at all is Verdant Guard, which ramps into creatures it would
 * have cast anyway. This one ramps into X spells — a Mind Spring, an Endless One, a Hurricane —
 * which is what makes the mana itself the win condition.
 */
export const DELTA_BLOOM: DeckSpec = {
  id: 'delta-bloom',
  name: 'Delta Bloom',
  description: 'Green-blue ramp. The lands are the engine, and the top of the curve is the plan.',
  commander: TATYOVA,
  cards: [
    /*
      Twenty-three lands, which is two more than any other deck here, and the reason is the
      commander: with Tatyova out a land is a card and a life, so the eighth land is never the dead
      draw it is in every other list. Two cycling lands in each colour for the games she is not.
    */
    { card: FOREST, count: 9 },
    { card: ISLAND, count: 7 },
    { card: SIMIC_GUILDGATE, count: 3 },
    { card: TRANQUIL_THICKET, count: 2 },
    { card: LONELY_SANDBAR, count: 2 },

    // ── Nine that make mana faster than a land does ──
    { card: LLANOWAR_ELVES, count: 3 },
    { card: BIRDS_OF_PARADISE, count: 2 },
    { card: RAMPANT_GROWTH, count: 2 },
    /*
      Explore, and the one new permission in the engine: an extra land drop (CR 505.5b).

      One mana for a card and a second land, which in this deck is two cards and two life with the
      commander out. It is also the only card in the pool that changes what a *player* may do for
      the turn rather than what a permanent is — see `allowExtraLand`.
    */
    { card: EXPLORE, count: 2 },

    // ── Eight that find the next land, or the next spell ──
    { card: ELVISH_VISIONARY, count: 2 },
    { card: WALL_OF_BLOSSOMS, count: 2 },
    { card: DIVINATION, count: 1 },
    // Two Preordains rather than one: the second is the slot the second Kiora's Follower left.
    { card: PREORDAIN, count: 2 },
    /*
      The adventurer, for the Harmonize that was this deck's weakest slot at 71%.

      A three-mana 3/3 that was a +3/+3 trick two turns earlier is two cards in a deck that wants
      bodies early and has plenty of card draw already — and a ramp deck's problem is always the
      four turns before its mana matters, which is the half of the card that gets cast first.
    */
    { card: GARENBRIG_CARVER, count: 1 },

    // ── Nine that buy the time the plan needs ──
    /*
      A ramp deck's problem is the four turns before its mana matters, and this is the answer:
      two walls that block anything and die to nothing, two Man-o'-Wars that undo a turn of theirs,
      and the counterspells for the one card that would end the game before turn seven.
    */
    { card: FOG_BANK, count: 2 },
    { card: MAN_O_WAR, count: 2 },
    { card: GIANT_SPIDER, count: 1 },
    { card: UNSUMMON, count: 1 },
    { card: COUNTERSPELL, count: 2 },
    { card: ESSENCE_SCATTER, count: 1 },

    // ── Eleven that spend it ──
    /*
      Four of these are X spells, which is the point: a deck that ramps into creatures it would
      have cast anyway is Verdant Guard. Mind Spring for seven is the refill nothing else here
      has, Endless One is a creature as big as the mana, and Hurricane ends a game the board has
      already stalled — it hits its own controller too, which is why there is only one.

      Kiora's Follower is the deck's second accelerant and its only trick: untapping a land is a
      mana, and untapping a *blocker* after it has blocked is a second block nobody expects.

      **One copy, and the reason is a measurement.** Two of them untap *each other* for ever — A
      taps to untap B, B taps to untap A — and that is a loop this bot walks straight into: the
      first version of this list, with two, used the ability 13,581 times across 120 games, about
      a hundred and forty-six a game. A person would never, and the engine is right to allow it (an
      untap ability may point at anything), so the fix is the deck list: with one copy there is
      nothing to untap it, so it is at most one activation a turn. The general problem — a bot that
      will repeat a cycle of legal actions returning the board to where it started — is written
      down rather than solved.
    */
    { card: KIORAS_FOLLOWER, count: 1 },
    { card: SIEGE_WURM, count: 2 },
    { card: PELAKKA_WURM, count: 1 },
    /*
      One Air Elemental, and a Thicket Basilisk for the other: the same five mana spent two ways.

      A 4/4 flier takes four turns to win on its own and blocks nothing on the ground; a 2/4 that
      destroys whatever it fights — at end of combat, so it takes its damage first — ends the
      ground war instead. This is the deck that can ask the question honestly, because it ramps:
      five mana arrives on turn four as often as turn five, and nothing else it does at five is a
      blocker. The Elemental stays in the pool and in this deck at one copy.
    */
    /*
      **Aeromunculus, for the Air Elemental**, and it is adapt's half of the family monstrosity
      belongs to.

      {1}{G}{U} for a 2/3 flier, and {2}{G}{U} to make it a 5/6 — once. Adapt's "if" is inside the
      ability rather than on it, which is the printed difference from a Fleecemane Lion's
      monstrosity: the table still offers this to a creature that already has a +1/+1 counter on
      it, and paying for it then gets nothing.

      The slot is the **Air Elemental** (76%, four mana for a 4/4 flier): the same role one mana
      earlier, and a card that keeps scaling in a deck whose mana outgrows its spells. Skyward Writ
      keeps the pool's other copy.
    */
    { card: AEROMUNCULUS, count: 1 },
    { card: THICKET_BASILISK, count: 1 },
    { card: ENDLESS_ONE, count: 2 },
    { card: MIND_SPRING, count: 1 },
    { card: HURRICANE, count: 1 },
    /*
      A two-mana creature that is also a mana sink, which is the shape a ramp deck is always
      short of.

      This deck makes more mana than it has things to spend it on by about turn six — the lands
      are the engine and the top of the curve is one Pelakka Wurm — so a 2/2 that turns every
      spare {G} into a +1/+1 counter and a life is a better late card than a fourth way to draw
      two. It is also the pool's only *repeatable* interaction with a graveyard: a Planar Void
      stops one existing, and this eats one at a card a turn while getting bigger for it.

      It replaced the **second Divination** (81%): four mana for two cards, in a deck that
      already runs two Preordains, a Mind Spring and a Tatyova drawing a card for every land.
    */
    { card: SCAVENGING_OOZE, count: 1 },
  ],
};

/**
 * The twelfth deck, and the only one that does not try to take anybody's life total to nought.
 *
 * Poison counters, `-1/-1` counters and the ten-poison elimination have been in this engine since
 * it was written, and until infect existed not one card in the pool produced a single point of any
 * of them: the second way to lose a game of Magic was unreachable by construction. This deck is
 * what makes it a game rather than a rule.
 *
 * **Why it is a deck and not three cards sprinkled around.** Ten poison needs bodies that connect
 * again and again, so a list with one infect creature in it has a dead card rather than a plan.
 * Eighteen of these sixty cards have infect, every one of them is small, and the deck's whole job is
 * to make small creatures connect — which is why the other half of the list is pump and protection
 * rather than more creatures.
 *
 * **The two things that make it frightening, and both are already in the engine.** `-1/-1` counters
 * are *permanent*: marked damage is wiped in the cleanup step, so a 1/1 with infect that trades
 * blows with a 3/3 leaves a 1/1 behind for the rest of the game, and a deck of 1/1s beats a deck of
 * 3/3s on the ground given two turns. And **Phyrexian Crusader** has protection from red and from
 * white, which is where almost all of this pool's cheap removal lives (D83) — five of the eleven
 * other decks simply cannot answer it.
 *
 * **What it is bad at, said up front.** Every creature in it dies to a single blocker, two of the
 * three sweepers in the pool wipe the board, and ten poison is further away than twenty life when
 * nothing connects. A Fog Bank or a Wall of Air stops the whole plan for as long as it lives, and
 * the deck's answer to a wall is the same as its answer to everything: a Tainted Strike on
 * something bigger.
 */
export const BLIGHT_VECTOR: DeckSpec = {
  id: 'blight-vector',
  name: 'Blight Vector',
  description: 'Green-black infect. Small creatures, permanent counters, and ten poison instead of twenty damage.',
  commander: SKITHIRYX,
  cards: [
    /*
      **Twenty lands, which is fewer than any other deck in the pool**, and the instrument asked
      for it.

      The first version ran twenty-two and measured 82-182. Cutting a Forest and a Swamp for a
      fourth Glistener Elf and a fourth Ichorclaw Myr came back **96-168 — fourteen games better**,
      with seven of the eleven matchups up, three down and one level. It is the shape the deck
      wanted: nothing here costs more than three, every spell is one or two mana, and a seventh
      land in play does nothing at all. The two cycling lands below are what keeps twenty from
      being a gamble.
    */
    { card: FOREST, count: 7 },
    { card: SWAMP, count: 6 },
    { card: GOLGARI_GUILDGATE, count: 3 },
    // Two cycling lands in each colour, as every deck in this pool that can flood runs: a land
    // this deck does not need is a pump spell it could have drawn instead.
    { card: TRANQUIL_THICKET, count: 2 },
    { card: BARREN_MOOR, count: 2 },

    // ── The eighteen that win the game ──
    /*
      Four one-drops, because the clock starts on turn one or it does not start.

      A Glistener Elf on turn one and a pump spell on turn two is four poison before anybody has a
      blocker, which is nearly half the game — and it is also the reason this deck mulligans hands
      without a one-drop in them.
    */
    { card: GLISTENER_ELF, count: 4 },
    /*
      Three Mambas, and the regeneration is the point rather than a bonus.

      A 1/1 that can be regenerated for {G} is a creature a blocker cannot profitably eat: the
      block happens, the Mamba comes back tapped, and the `-1/-1` counters it put on the blocker
      stay there for ever. In a deck of one-power creatures the card that survives combat is worth
      more than the card that wins it.

      **A fourth copy was measured and is not here.** It was part of the reshape D178 rejected, and
      `cast-counts` still says this is the deck's most-pressed card by a distance: **471%**, 126
      casts and **406 regenerations** across the 144 games a copy was in hand. Being the best card
      in a deck is not the same as wanting a fourth of it.
    */
    { card: BLIGHT_MAMBA, count: 3 },
    /*
      Four Myrs, and the first card in the pool that reads the `becomes-blocked` event (D154).

      "Whenever it becomes blocked, it gets +2/+2" turns the obvious answer to a 1/1 into three
      `-1/-1` counters on whatever blocked it. Colourless, so it is the one creature here that is
      castable on turn two whichever two lands turned up.
    */
    { card: ICHORCLAW_MYR, count: 4 },
    { card: PLAGUE_STINGER, count: 3 },
    // The only infect creature in the deck that is not a 1/1, and the only one that blocks: a 2/3
    // holds the ground for two turns while the fliers do the work. Cutting the second copy was
    // part of the reshape D178 rejected, and it is one of the two cards that reshape missed most:
    // this deck's worst matchups are the fast ones, and a 2/3 is what it has against them.
    { card: CYSTBEARER, count: 2 },
    /*
      Two Crusaders, which is as many as the deck can cast and the best card in it.

      First strike plus infect kills a blocker with counters before the blocker deals its damage
      back, and protection from red and from white is the half that reads the field rather than the
      board: Ember Rush, Forge Alliance, Skyward Writ and Dawn Tithe hold nearly every cheap
      removal spell in the pool between them, and none of it can be pointed at this.
    */
    { card: PHYREXIAN_CRUSADER, count: 2 },

    // ── The ten that make them connect ──
    { card: GIANT_GROWTH, count: 3 },
    /*
      One Titanic Growth for the pool's other modal card, which is three cards in one slot here.

      Titanic Growth was this deck's deadest card at 23% — cast seven times in the thirty games a
      copy was in hand, because {2}{G} for +4/+4 until end of turn is a trick a deck full of
      one-mana infect creatures cannot usually afford on the turn it matters. A **+1/+1 counter**
      does not wear off, which on a creature with infect is a permanent extra poison counter every
      time it connects; and when the hand has no creature worth growing, the card is the
      twenty-first land this twenty-land deck wanted.
    */
    { card: VASTWOOD_FORTIFICATION, count: 1 },
    // Hexproof and +2/+2 for one mana: this deck's removal-spell answer and its combat trick in
    // the same card, and the only card in it that protects a creature somebody is trying to kill.
    // It is the deck's least-cast card at 44% and it survived a reshape that cut it anyway (D178):
    // a card the bot only gets to use in a third of the games it holds one is still better here
    // than five mana of Equipment in a deck whose curve stops at three. One copy went for the
    // Butcher Ghoul below, which is the body D180 asked for.
    { card: BLOSSOMING_DEFENSE, count: 1 },
    /*
      **A 1/1 that arrives twice, which is the shape the instrument asked for rather than a card
      anybody would pick by reading it.**

      `creature-fate.mjs` put every deck's creatures side by side and this one's problem was the
      denominator: **261 creatures onto the battlefield where Skyward Writ puts 401**, each living
      1.5 of its own turns, with the causes (half combat, half their removal) in the same ratio as
      everybody else's. So what it is short of is bodies per card, and undying is the cheapest
      bodies-per-card in Magic: two blockers for one draw, and the second one is bigger.

      It has no infect, which is the honest cost — it does not advance the poison clock at all. It
      blocks, twice, in the deck that loses 71% of its games to plain combat damage (D176), and it
      is the only creature here that an opponent's removal spell does not actually answer.

      **And it measured level — 0 and +2 of 288 — which makes it this deck's fourth null in a row.**
      The bodies did arrive: `creature-fate` reads 279 creatures onto the battlefield where it read
      261, and 120 still standing at the end where it read 113. The record did not move. A blocker
      (D176), evasion and an equipment package (D178), and now bodies per card have each been asked
      for by an instrument, delivered exactly what they were added to do, and changed nothing — so
      the thing to say about this deck is in D181 and it is not about its next card. The Ghoul stays
      because level is no reason to revert and it is the pool's cheapest undying creature.
    */
    { card: BUTCHER_GHOUL, count: 1 },
    /*
      Two Tainted Strikes, which are the deck's reach and the card that reads the whole table.

      One mana to put infect on something that is already huge: a Siege Wurm, a stolen creature, or
      — the line worth knowing — an opponent's own trampling 5/5 the turn before it kills you. It
      is also the only card here that can win a game the creatures have already lost.
    */
    { card: TAINTED_STRIKE, count: 1 },
    /*
      Contagion Clasp for the second Tainted Strike, and the payer does one thing on purpose.

      Both are cheap and both are about counters: the Strike turns one hit into poison, and the
      Clasp answers a blocker and then grows every poison counter already dealt, every turn. The
      payer is a spell rather than a body for the reason D211 wrote down — a creature that also does
      the thing makes the number a fact about the creature. See D213.
    */
    { card: CONTAGION_CLASP, count: 1 },
    /*
      The equipment, and the single most poison the deck can put on anybody in one swing: +3/+0
      trample on a 1/1 with infect is four counters and no profitable block — and `cast-counts`
      says the deck knows it: **149%**, 38 casts and 53 equips in the 61 games a copy was in hand,
      second only to the Blight Mamba.

      **A second copy was measured and is not here either.** Paired with a Whispersilk Cloak for
      the two Blossoming Defenses, the package measured −3 and **+23** on its revert — opposite
      signs with one arm well outside the floor, which is not a card that earns a slot. Five mana
      to make one 1/1 unblockable is a different deck's plan; D178 has the whole of it.
    */
    { card: LOXODON_WARHAMMER, count: 1 },

    // ── The eight that answer what gets in the way ──
    { card: DOOM_BLADE, count: 1 },
    /*
      Darkblast for the second Doom Blade: removal for removal, and the honest comparison.

      One kills anything once; the other kills a one-toughness creature every turn for the rest of
      the game. This deck's problem is a blocker in front of a Glistener Elf, and most of the
      blockers it meets are small — so the recurring half is the half it wants, and the probe is
      asked whether that is true. See D210.
    */
    { card: DARKBLAST, count: 1 },
    { card: MURDER, count: 1 },
    // The charm's three modes are all live here: regenerate the team through a sweeper, kill a
    // Fog Bank, or shrink a blocker out of the way.
    { card: GOLGARI_CHARM, count: 1 },
    /*
      The second Charm's slot, spent on **split second**, and chosen because the two overlap.

      One of the Charm's three modes destroys an enchantment, which is half of what the Grip does —
      so the comparison is a cheap modal answer against a dearer unconditional one that also hits
      artifacts and cannot be responded to. The deck keeps a Charm and the pool keeps three. See
      D218.
    */
    { card: KROSAN_GRIP, count: 1 },
    // A fight spell in a deck whose creatures put permanent counters on what they fight, which is
    // the one removal spell in the pool that gets *better* for being cast by this deck.
    { card: PREY_UPON, count: 1 },
    { card: NATURALIZE, count: 1 },

    // ── And four cards to find the rest ──
    { card: READ_THE_BONES, count: 2 },
    { card: SIGN_IN_BLOOD, count: 2 },
    /*
      The pool's standing answer to a graveyard, in the deck that has the least use for its own
      (CR 400.7).

      Every other black deck wants its graveyard: Ashen Rite buys creatures back, Hollow Tide
      delves and mills, Rot Harvest has a Lhurgoyf whose power *is* a graveyard. This one wants a
      poison counter on a creature nobody blocks, and the cards it has spent are spent — so a
      one-mana enchantment that exiles every card the table discards, mills, destroys or resolves
      costs it nothing and takes a dimension away from four decks at once.

      **It replaced the Raise Dead, and the probe is why.** The first version of this change cut
      the Titanic Growth (25%, the deck's least-cast card by twelve points) and measured **0 and
      −12** of 288 on two seed sets — a card that costs its own deck games. The reason was a
      conflict I had not looked for: this deck's one graveyard card is a Raise Dead, cast in 40 of
      144 games, and a Planar Void turns it off completely. A deck that denies graveyards cannot
      be playing a card that needs its own.

      So the Raise Dead is the slot, which gives up a card used three times as often for one the
      deck can actually hold. Pool coverage is safe either way: Rot Harvest runs the other Raise
      Dead, and the Titanic Growth stays.
    */
    { card: PLANAR_VOID, count: 1 },
    /*
      A 0/4 that draws a card, in the deck the instruments say is losing a race by one turn.

      `killed-by` is unusually clear about this deck: it dies on the table's turn 20.4 holding
      2.2 cards — not flooding, not starving — and **71% of the time to plain combat damage**,
      while the games it wins it wins on turn 18.4 with 15.6 life left. `poison` says the plan
      itself is fine: 81% of games deal poison, 903 counters in all, and **50 of its 53 wins come
      by poison**. Nothing is broken. It is a turn short.

      The split by opponent says the same thing twice: against Ember Rush it deals 40 poison over
      twelve games and goes 2-10, and against Hollow Tide it deals 108 and goes 6-6. It never
      gets going against fast red and nearly gets there against everything slow — so what it
      needs is not more reach, it is the two turns that let the reach it already has arrive.

      A Wall of Blossoms is the cheapest version of those turns in these colours. It blocks every
      one- and two-power creature Ember Rush and Forge Alliance have, it replaces itself so the
      hand does not shrink for playing defence, and **it is never dead**: an infect deck's
      creatures all have to attack, so a card that only blocks is a card none of the others can
      be. It replaced the **Titanic Growth** (25%, the deck's least-cast card by ten points, and
      Kindle Grove runs the other copy).
    */
    { card: WALL_OF_BLOSSOMS, count: 1 },
  ],
};

/**
 * The thirteenth deck, and the one that exists because a card had nowhere to live.
 *
 * Twelve decks covered every pair of colours but one. There was no **red-green** deck, and that was
 * invisible until the split cards shipped: Assault // Battery is {R} on one half and {3}{G} on the
 * other, and no deck in the pool could cast both — so while Fire // Ice went into Arc Tempest and
 * Wax // Wane into Verdant Guard, the third split card sat unwritten. A gap in a card pool is
 * easier to see from a card than from a list of decks.
 *
 * **What the pair is for.** Red is the colour that kills a creature for one mana and green is the
 * colour that plays a bigger one for five, and the deck is the two in that order: eight cheap
 * interactive cards, four ways to get to five mana early, and then creatures the rest of the pool
 * cannot block profitably. It is the only deck here whose removal is mostly *combat* — two Prey
 * Upons and a Gruul Ragebeast, which point your creature at theirs rather than pointing a spell at
 * anything — and that is the red-green trade in one sentence: the answers cost a creature instead
 * of a card.
 *
 * **Ruric Thar is a commander that taxes the table, including its own side.** "Whenever a player
 * casts a noncreature spell, Ruric Thar deals 6 damage to that player" is symmetric, which is the
 * half that makes it a card rather than a beating — this deck runs fourteen noncreature cards and
 * has to mean each one. Against the pool's three control decks it is the hardest card in the
 * format: Tidal Mind, Hollow Tide and Skyward Writ are all counterspells and removal, and every
 * one of those costs them a third of their life. And "all creatures must attack each combat if
 * able" is the clause that stops a board stalling — a Fog Bank cannot sit there, and neither can
 * ours.
 *
 * **The honest limit, named before it is measured:** the bot plays a deck of big creatures better
 * than it plays a deck of answers, so expect this one to read higher on the table than it would in
 * a person's hands. The opposite of Tidal Mind's problem, and the same cause.
 */
/*
  The two suspend cards, and both are deliberately a card the deck already plays with the keyword
  bolted on — three damage, and a basic land. What the measurement reads is then the *keyword*
  rather than the card: a turn of waiting against two mana, twice over.
*/
const RIFT_BOLT: CardDef = {
  name: 'Rift Bolt',
  typeLine: 'Sorcery',
  manaCost: '{2}{R}',
  cmc: 3,
  oracleText: 'Rift Bolt deals 3 damage to any target.\nSuspend 1—{R} (Rather than cast this card '
    + 'from your hand, you may pay {R} and exile it with a time counter on it. At the beginning of '
    + 'your upkeep, remove a time counter. When the last is removed, cast it without paying its '
    + 'mana cost.)',
  colors: ['R'],
};

const SEARCH_FOR_TOMORROW: CardDef = {
  name: 'Search for Tomorrow',
  typeLine: 'Sorcery',
  manaCost: '{2}{G}',
  cmc: 3,
  oracleText: 'Search your library for a basic land card, put it onto the battlefield, then shuffle.'
    + '\nSuspend 2—{G} (Rather than cast this card from your hand, you may pay {G} and exile it with '
    + 'two time counters on it. At the beginning of your upkeep, remove a time counter. When the '
    + 'last is removed, cast it without paying its mana cost.)',
  colors: ['G'],
};

export const KINDLE_GROVE: DeckSpec = {
  id: 'kindle-grove',
  name: 'Kindle Grove',
  description: 'Red-green: cheap interaction, four ways to reach five mana, and creatures nothing else in the pool blocks profitably. Ruric Thar makes every noncreature spell at the table cost six life.',
  commander: RURIC_THAR,
  cards: [
    // ── Twenty-three lands, and two of them are a card when they are not a land ──
    { card: MOUNTAIN, count: 8 },
    { card: FOREST, count: 9 },
    { card: GRUUL_GUILDGATE, count: 3 },
    /*
      And the twenty-third land is an **Aether Hub**, in for a Mountain.

      Energy (D202) is the first resource in this pool that is neither mana, life, cards nor
      counters on a permanent, and this is the card that ties it to the mana: the Hub taps for
      colourless all game, or for either of this deck's colours once, by spending the energy it
      arrived with. A land for a land, so the count is untouched — and in a two-colour deck whose
      commander costs {4}{R}{G}, one guaranteed colour on the turn it matters is worth more than
      the ninth Mountain.
    */
    { card: AETHER_HUB, count: 1 },
    // The cycling pair: a land that is never a dead draw, which a deck with a six-mana commander
    // and a seven-mana Ragebeast can afford to want.
    { card: FORGOTTEN_CAVE, count: 1 },
    { card: TRANQUIL_THICKET, count: 1 },

    // ── Four that get to five mana a turn early ──
    { card: LLANOWAR_ELVES, count: 2 },
    /*
      The last Rampant Growth's slot, spent on the same land with a 2/2 attached and **echo** on it.

      A Yavimaya Granger puts a tapped basic onto the battlefield exactly as the Growth does, one
      mana dearer, and leaves a body that asks for {2}{G} in the next upkeep. The land is already in
      play by then, so the question is only whether the 2/2 is worth two more mana — which is the
      opposite half of the question Mogg War Marshal asks, and the reason the keyword has two cards
      rather than one. See D214.
    */
    { card: YAVIMAYA_GRANGER, count: 1 },
    /*
      The second Rampant Growth's slot, spent on the same card with **suspend** on it.

      A Search for Tomorrow is a Rampant Growth that costs {G} on turn one instead of {1}{G} on
      turn two, puts the land in untapped rather than tapped, and arrives on turn three. Which is
      the fair comparison the slot is for: the two cards do nearly the same thing at nearly the same
      price, so what the probe reads is the keyword rather than the card.
    */
    { card: SEARCH_FOR_TOMORROW, count: 1 },

    // ── Nineteen creatures, in the order the curve wants them ──
    /*
      The two-drop that pays for the next two-drop. Two mana back as it arrives means a second
      Emissary, or a Borderland Marauder, on turn two — and in a deck whose commander punishes
      noncreature spells, a creature that ramps is the only ramp that costs nothing.
    */
    { card: BURNING_TREE_EMISSARY, count: 1 },
    /*
      The second Emissary's slot: a 2/2 for two, for a 2/2 for two.

      Both cost two and both arrive as a 2/2, so the comparison is about what else the card does —
      the Emissary refunds its mana into the next two-drop, the Beastbreaker takes every spare {1}{G}
      afterwards and becomes a 4/4 and then a 6/6 trampler. In the deck that ramps, which is the
      point of putting it here. See D216.
    */
    { card: BEASTBREAKER_OF_BALA_GED, count: 1 },
    /*
      One Borderland Marauder and one Ambush Viper rather than two of each, for the two creatures
      that **make** and **spend** energy.

      **Longtusk Cub** is a 2/2 for two that is a 3/3 the moment it connects, and this is the deck
      that gets creatures through — Rancor, Prey Upon and a Goblin Wardriver all exist to make one
      attack profitable. **Bristling Hydra** is the payoff: a 4/3 that arrives with three energy
      and can spend them to grow and gain hexproof, which is the only answer to removal this deck
      has ever had besides casting its threats one at a time.

      Both cuts keep a copy, which is this list's rule: the Marauder and the Viper are still in the
      pool and still in their own tests.
    */
    { card: BORDERLAND_MARAUDER, count: 1 },
    { card: LONGTUSK_CUB, count: 1 },
    { card: AMBUSH_VIPER, count: 1 },
    { card: BRISTLING_HYDRA, count: 1 },
    { card: RIVER_BOA, count: 1 },
    { card: THORNWEALD_ARCHER, count: 1 },
    /*
      Mardu Scout for the second Centaur Courser: a 3/1 that can be cast for one mana a turn,
      for ever.

      **Dash** (D195) is evoke's mirror — the cheap cast keeps the body and gives up keeping it —
      and this is the deck that can use that half. Kindle Grove's plan is damage now, and the Scout
      is the only card in the pool that offers the same damage every turn for one mana without ever
      being on the board to be answered: dashed for {R} it attacks the turn it lands and is in hand
      again at the end step, so a removal spell aimed at it has nothing to hit and a blocker has
      nothing to trade with. Cast for its printed {1}{R} it is a 3/1 that stays, which is the other
      half of the card and the one for a board that has stalled.

      The Courser is the right slot because it is the most replaceable card in this list: a vanilla
      3/3 for three in a deck that already runs a Burning-Tree Emissary, two Borderland Marauders
      and two Ambush Vipers on the way up the curve. One copy stays, so the body is still there on
      the turns the deck wants one.

      It sits beside the **Hellspark Elemental** on purpose: both are three damage that does not
      stay, and the two pay for it differently — the Hellspark goes to the graveyard and costs
      {1}{R} to buy back once, the Scout goes to hand and costs {R} every turn. One list, two
      answers to the same question, and the comparison is the point.
    */
    { card: MARDU_SCOUT, count: 1 },
    { card: CENTAUR_COURSER, count: 1 },
    // Four damage to a creature *and* a 4/2, which is the best rate in the pool for what this deck
    // does: the removal and the body in one card, so the commander's tax never applies to it.
    { card: FLAMETONGUE_KAVU, count: 2 },
    { card: GIANT_SPIDER, count: 1 },
    { card: LHURGOYF, count: 1 },
    /*
      Thragtusk, and the reason it is in a deck that is not a control deck: answering it is not
      answering it. Five life as it lands and a 3/3 when it **leaves** — exiled, bounced or
      sacrificed, not only killed — so a removal spell spent on it trades one card for half a card
      and five life.
    */
    { card: THRAGTUSK, count: 1 },
    /*
      The second Thragtusk's slot, spent on **fading**, and chosen because the two cards answer the
      same question in opposite directions.

      Both are four-mana green fat. A removal spell spent on the Thragtusk trades for half a card
      and five life; a removal spell spent on the Blastoderm cannot be cast at all, because every
      one in this pool targets. What the Blastoderm gives up for that is the thing the Thragtusk
      keeps — it is gone in three turns whatever happens. See D217.
    */
    { card: BLASTODERM, count: 1 },
    { card: SHIVAN_DRAGON, count: 1 },
    /*
      **Battle cry**, for the seven-drop this deck almost never reached.

      It replaced the **Pelakka Wurm** — 18% of the games it was in hand and **3 casts in 96**,
      the lowest usage of any nonland card measured in this pool (Delta Bloom keeps the other copy,
      where seven mana is reachable). A two-mana 2/2 that gives every *other* attacker +1/+0 is the
      opposite card in every way, and it is the right opposite: this deck's whole plan is a board of
      medium creatures walking into a block, and battle cry turns each of those blocks into a worse
      one. Measured at **15 casts in 96 games**.
    */
    { card: GOBLIN_WARDRIVER, count: 1 },
    // Seven mana for a 6/5 that kills something as it lands, and then kills something every time
    // another creature of yours does. The deck's top end, and the card its ramp is for.
    { card: GRUUL_RAGEBEAST, count: 1 },

    // ── Fourteen cards that are not creatures, and the commander means every one of them ──
    { card: LIGHTNING_BOLT, count: 2 },
    /*
      One Lightning Strike, and a **Harnessed Lightning** for the other: the same two mana, and the
      first spell in the pool that asks how much of a resource to spend.

      Three damage either way on an empty board, because the card gives you three energy before it
      asks — and more than three when this deck has been saving, which is what makes it the right
      removal spell for a list that now has two other cards putting energy in the pool.
    */
    /*
      And the Lightning Strike's slot, for suspend's other card and the other half of the bargain.

      Three damage for {1}{R} now, against three damage for {R} and a turn of waiting — and a turn
      in which the other player can see it coming. The deck keeps two Lightning Bolts for the damage
      it needs immediately; this slot is the one that buys a turn of mana back.
    */
    { card: RIFT_BOLT, count: 1 },
    { card: HARNESSED_LIGHTNING, count: 1 },
    { card: FLAME_SLASH, count: 1 },
    // Removal that costs a creature rather than a card, which is the red-green trade and the
    // reason this deck can run fourteen noncreature cards under its own commander.
    { card: PREY_UPON, count: 2 },
    /*
      **Bloodbraid Elf, for the last Giant Growth**: the pool's first cascade card.

      {2}{R}{G} for a 3/2 with haste that casts a second spell for nothing, and this is the deck
      with the curve to feed it — eleven nonland cards at three mana or less, which is where a
      cascade hit comes from. Under this deck's own commander it is better than it looks and worse
      than it reads: Ruric Thar taxes the *cast*, so a cascaded Lightning Bolt still costs its
      caster six life, and a cascaded creature costs nothing at all.

      The slot is the Giant Growth, which was the least-cast card in the list at **10 casts in 96
      games** (45% of the games it was in hand) — and a pump spell is the wrong card here twice
      over: it is a noncreature spell in a deck whose commander charges six life for one, and the
      same slot already lost its other copy to D183's Hellspark Elemental for the same reason.
    */
    { card: BLOODBRAID_ELF, count: 1 },
    /*
      **Hellspark Elemental, for the second Giant Growth**, and it is three damage twice for a deck
      whose commander taxes every spell that is not a creature.

      {1}{R} for a 3/1 with trample and haste that sacrifices itself at the end of the turn — and
      then **unearth {1}{R}** buys the same three damage again out of the graveyard, as an ability
      rather than a cast, which under Ruric Thar is the difference between six damage and six
      damage plus twelve to its own controller. The second Giant Growth (64%) is the slot because a
      pump spell *is* a noncreature spell here, and this deck pays six life for each one.

      **+4 and +6 of 288 on the revert**, which is the number *after* a fidelity fix took half of it
      away: the first version could be unearthed twice (18 casts, 42 unearths) because the card's
      own end-step sacrifice was moving it out of exile, and that version measured +10 and +19.
      D183 has the whole story — it is the clearest example in this project of what an unnoticed
      rules deviation is worth.
    */
    { card: HELLSPARK_ELEMENTAL, count: 1 },
    /*
      Rancor, the Aura that comes back: +2/+0 and trample for one mana, and answering the creature
      does not answer the Aura. It is the one card in this list that makes a removal spell a bad
      trade twice.
    */
    { card: RANCOR, count: 2 },
    // The split card the deck was built around. {R} for two damage, or {3}{G} for a 3/3 — the same
    // card at either end of the curve, which is exactly what a deck of two colours wants.
    { card: ASSAULT_BATTERY, count: 1 },
    // The X sweeper, which this deck is the only one that can aim: everything it keeps is bigger
    // than everything it kills.
    { card: SAVAGE_TWISTER, count: 1 },
    { card: HURRICANE, count: 1 },
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
  [HOLLOW_TIDE.id]: HOLLOW_TIDE,
  [ARC_TEMPEST.id]: ARC_TEMPEST,
  [DAWN_TITHE.id]: DAWN_TITHE,
  [DELTA_BLOOM.id]: DELTA_BLOOM,
  [BLIGHT_VECTOR.id]: BLIGHT_VECTOR,
  [KINDLE_GROVE.id]: KINDLE_GROVE,
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
