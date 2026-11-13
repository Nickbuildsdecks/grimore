/**
 * What a permanent currently is, as opposed to what it was printed as.
 *
 * Power, toughness and keywords are **computed on demand** rather than stored on the instance. That
 * is not a style preference: a creature's power is its printed value plus its counters plus every
 * continuous effect currently applying to it, and effects expire. Writing a total into the instance
 * means the moment a "+3/+3 until end of turn" wears off there is nothing left that knows what to
 * subtract, and a stored number drifts from the truth every time two effects overlap.
 *
 * This is a deliberately simplified layer system. Real Magic applies continuous effects in seven
 * layers with timestamps and dependency ordering (CR 613). What is here is a fixed order that
 * produces the same answer for everything the pool contains: copying (layer 1), type and colour
 * changes (4 and 5), granted and removed abilities (6), then the three sublayers of power and
 * toughness in the order the rules put them — characteristic-setting (7b) before a pump (7c)
 * before counters (7d). Each of those arrived with a card behind it (D88, D93, D94), so a Clone
 * that copied a creature under a Giant Growth and three +1/+1 counters answers correctly.
 *
 * What is still missing is **timestamps and dependency**: two effects that disagree inside one
 * layer are applied in the order the list happens to hold them rather than in the order they were
 * created. Nothing in the pool produces that disagreement, and a card that would is better left
 * unscripted than answered plausibly and wrongly.
 */
import {
  isFaceDownObject, isFaceDownPermanent, zoneKey,
  type CardDef, type CardInstance, type LevelBand,
} from './cards.js';
import type { Color } from './mana.js';
/*
  Type-only, and the one import in this file that points back at a module which imports this one.

  `turnTypes` needs `ContinuousEffect` for the state and this needs `Target` for a redirect's
  destination. Both are erased at build time, so the cycle exists in the type graph and nowhere in
  the output — which is the one kind of cycle worth accepting rather than breaking a type in half to
  avoid.
*/
import type { Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

export const KEYWORDS = [
  'flying', 'reach', 'vigilance', 'haste', 'trample', 'first strike', 'double strike',
  'deathtouch', 'lifelink', 'hexproof', 'shroud', 'indestructible', 'menace', 'defender',
  'prowess', 'flash', 'infect',
  /*
    Myriad, and the one keyword in this list the engine *acts on* rather than reads (CR 702.111a).

    Every other entry here is a fact the rules consult — a flier cannot be blocked by a ground
    creature, deathtouch makes any damage lethal, infect changes what damage does. Myriad is an
    instruction: "whenever this creature attacks, for each opponent other than the defending
    player, you may create a token that's a copy of this creature that's tapped and attacking that
    player". It is in this list rather than in a card's `triggers` because **Blade of Selves grants
    it**, and granting a keyword is all `PumpOptions.keywords` can do — there is no machinery in
    this engine for handing another permanent a triggered ability. So the keyword is the
    declaration and `declareAttackers` is the implementation.
  */
  'myriad',
  /*
    Three evasion keywords whose rules text **is** a `BlockerClause` list (D501).

      fear          CR 702.36a  can't be blocked except by artifact creatures and/or black creatures
      shadow        CR 702.28b  can block or be blocked by only creatures with shadow
      horsemanship  CR 702.5b   can't be blocked except by creatures with horsemanship

    They are here rather than in a card's script because they are printed on 101 legal lines and a
    keyword is what the cards print — but a word in this list is a word `printedKeywords` returns and
    `compile.ts` therefore counts **read**, so each one has to be enforced or the count is a lie
    (D362 ranks a wrong reading below an unread line). `KEYWORD_BLOCK_RULES` below is the
    enforcement, and `canBlock` consults it.

    Shadow is the one that needed D500: it restricts **both** directions, so it is the first rule in
    this engine that is an allow list on who may block the creature *and* an allow list on what the
    creature may block.

    Intimidate (21 lines) and skulk (14) **were** deliberately absent, because each needs a clause
    whose answer depends on both creatures — "creatures that share a color with it", "creatures with
    greater power" — and `clauseMatches` read one creature. D551 hands it the other one as well and
    both are in the table now, with the two relational clauses that carry them.

    That also settles #345, and corrects its count while settling it: the row was recorded as "nine
    relative-power printings", and measuring the corpus says **three** print "creatures with greater
    power" (plus one "…this combat", whose duration this does not read). The forty-odd power
    printings that row was sized from are the *absolute* comparisons — "creatures with power 2 or
    less" — which the plain `power` clause has read since D498. So the value here is the two
    keywords, not the printed cards.
  */
  'fear', 'shadow', 'horsemanship', 'intimidate', 'skulk',
  /*
    Wither (CR 702.78a), which is **infect's creature half and nothing else** (D504).

    "Damage this source would deal to a creature is dealt in the form of -1/-1 counters" is word for
    word what infect does to a creature; what infect adds is the player half, where its damage is
    poison instead of life (CR 702.90b). So `dealDamage` reads this keyword in the creature branch
    beside `infect` and *not* in the player branch — a Boggart Ram-Gang hits you for three life, and
    a Glistener Elf for three poison.

    26 bare `Wither` lines in the legal corpus, and a dozen more printings that grant it, which read
    for free because every grant reader asks `isKeyword`.
  */
  'wither',
  /*
    Flanking (CR 702.25a), the first entry in this list whose rules text is an **instruction** about
    other creatures rather than a fact about this one — myriad's company, and placed here for
    myriad's reason (D554).

    "Whenever a creature without flanking blocks this creature, that creature gets -1/-1 until end
    of turn." It belongs in this list rather than in a card's `triggers` because the rule has to ask
    a *blocker* whether it has flanking, and the only thing in this engine that can answer that is
    `characteristicsOf(...).keywords`. A per-card trigger could emit the penalty but could not ask
    the question, and the pool prints the question: **Cavalry Master** gives other flankers flanking,
    **Sidewinder Sliver** gives it to every Sliver, **Jabari's Banner** hands it out for a turn, and
    **Barbed Foliage** takes it away. Every one of those is a grant or a loss of a keyword, which is
    machinery this list already has and a `triggers` entry has none of.

    27 legal cards print the bare line, and two more print it in a mixed list — "Flying; flanking",
    "Protection from black; flanking" — which `printedPart` reads whole, so those come along.
    **The grants come along too, and were measured rather than assumed**: Jabari's Banner's "gains
    flanking until end of turn" and Agility's "has flanking" both read now, because every grant
    reader asks `isKeyword` and the answer changed. Sidewinder Sliver's "All Sliver creatures have
    flanking" does **not** — that is a tribal static, a shape nothing here reads yet, and it stays
    reported. 31 lines in all against the 27 the audit counted, which is a keyword row behaving
    like a vocabulary change for once: the word is consumed in more than one printed shape.

    `flankingPenalties` in `combat.ts` is the enforcement and `declareBlockers` calls it, which is
    exactly myriad's arrangement: the keyword is the declaration and a combat function is the
    implementation. What that costs is stated in that function's docblock — the penalty lands as
    blockers are declared rather than going on the stack, so there is no window to answer the
    trigger. What it buys is that granted, lost and copied flanking all work without a line of new
    code.

    **Cumulative flanking (CR 702.25b) is not represented**, because a `ReadonlySet` cannot hold a
    count — bushido's limitation, and the same answer: measured, **no legal card prints the line
    twice**, so nothing in this pool can tell. A card that did would take one -1/-1 instead of two.
  */
  'flanking',
  /*
    Changeling (CR 702.73a), the one keyword here that changes what a creature **is** rather than
    what it does: "This object is every creature type." 23 cards print nothing else at all (D506).

    A keyword in this list rather than a field of its own, which is also the rule: it is a
    characteristic-defining ability, so "loses all abilities" takes it away and a frogged changeling
    is a Shapeshifter again. `characteristicsOf` reads it off `keywords` and extends the subtype
    list, so every question the engine asks about a creature type answers correctly without a single
    call site changing. See `CREATURE_TYPES`.
  */
  'changeling',
  /*
    Daybound and nightbound (CR 702.145), D593. Keywords for changeling's reason — the rule asks a
    permanent whether it **has** one, live, so a creature that loses all abilities stops turning
    over with the time of day — and the enforcement is the engine's, in `matchDayNight`, rather
    than a trigger: turning over for day or night does not use the stack.
  */
  'daybound',
  'nightbound',
] as const;
export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET = new Set<string>(KEYWORDS);
export const isKeyword = (value: string): value is Keyword => KEYWORD_SET.has(value.toLowerCase());

export interface TypeLine {
  readonly supertypes: readonly string[];
  readonly types: readonly string[];
  readonly subtypes: readonly string[];
}

const EM_DASH = /\s[—-]\s/;

/** Splits `Legendary Creature — Goblin Warrior` into its three parts. */
export function parseTypeLine(line: string | null | undefined): TypeLine {
  const text = (line ?? '').trim();
  if (!text) return { supertypes: [], types: [], subtypes: [] };
  const [front, back] = text.split(EM_DASH);
  const words = (front ?? '').split(/\s+/).filter(Boolean);
  const SUPER = new Set(['legendary', 'basic', 'snow', 'world', 'ongoing', 'token']);
  const supertypes: string[] = [];
  const types: string[] = [];
  for (const word of words) {
    if (SUPER.has(word.toLowerCase())) supertypes.push(word);
    else types.push(word);
  }
  return {
    supertypes,
    types,
    subtypes: (back ?? '').split(/\s+/).filter(Boolean),
  };
}

/**
 * The type line of a card whose bestow cost was paid: an Aura, and not a creature (CR 702.103b).
 *
 * The creature type goes and the Aura subtype arrives; everything else about the line is kept,
 * because the card is still an Enchantment and still a Satyr on paper. Written as a function of
 * the printed line rather than as a second type line on the script, so a card that gains bestow
 * from somewhere else — or a bestow card whose printed line is something this pool has not seen —
 * still reads correctly.
 */
function bestowTypeLine(printed: TypeLine, instance: CardInstance): TypeLine {
  if (instance.bestowed !== true) return printed;
  return {
    supertypes: printed.supertypes,
    types: printed.types.filter((t) => t.toLowerCase() !== 'creature'),
    subtypes: printed.subtypes.some((t) => t.toLowerCase() === 'aura')
      ? printed.subtypes
      : [...printed.subtypes, 'Aura'],
  };
}

export const hasType = (line: TypeLine, type: string): boolean =>
  line.types.some((t) => t.toLowerCase() === type.toLowerCase());
export const hasSubtype = (line: TypeLine, sub: string): boolean =>
  line.subtypes.some((t) => t.toLowerCase() === sub.toLowerCase());
export const isLegendary = (line: TypeLine): boolean =>
  line.supertypes.some((t) => t.toLowerCase() === 'legendary');

/**
 * Keywords printed on a card, read from its oracle text.
 *
 * Scripts declare their keywords explicitly, and that is the authority. This exists so an
 * **unscripted** card still behaves: a creature whose text begins "Flying, vigilance" should fly
 * and should not tap to attack even though nobody has written a script for it. Only matched at the
 * start of a line and as a whole word, so "Flying" counts and "creatures with flying can't block"
 * does not.
 */
/** The five basic land types, in the order the rules list them, for printed landwalk. */
const LAND_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] as const;

/** The colour each printed colour word names, for "protection from red". */
const COLOUR_WORDS: Readonly<Record<string, Color>> = Object.freeze({
  white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G',
});

/**
 * The words printed text uses to refer back to the card it is printed on, after naming it once.
 *
 * "This creature can't block", on a card whose first line already said its name. The 2024
 * retemplate made this the normal second reference, and the list is the engine's one vocabulary for
 * it: `scripts.ts` builds its `selfRef` pattern from this same array, so a word added here is a
 * word every reader in both modules accepts. Two lists would be two places to forget one.
 */
export const SELF_TYPE_WORDS = [
  'creature', 'artifact', 'enchantment', 'permanent', 'land', 'planeswalker', 'battle',
  'Vehicle', 'Equipment', 'Aura', 'token', 'card', 'spell',
] as const;

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
 * **The alias is matched case-insensitively, like every other reader, and that is a known
 * imprecision rather than an oversight.** Two legal cards in 33,847 print their own short name as
 * an ordinary lowercase word — *Eleven, the Mage* ("your maximum hand size is eleven") and *Storm,
 * Force of Nature* ("has storm") — and both are pinned by a test, because the alias is harmless
 * only as long as no reader matches the clause the collision sits in. JavaScript has no way to
 * switch case-sensitivity off for part of a pattern (`(?-i:…)` is not in V8), so a test that fails
 * the day it starts to matter is the guard available.
 *
 * It lives here rather than in `scripts.ts` because both modules need it and the import only runs
 * one way: `scripts.ts` imports this file, never the reverse (D494).
 */
export function shortName(name: string): string | null {
  const comma = name.indexOf(', ');
  return comma <= 0 ? null : name.slice(0, comma);
}

/** A combat restriction or requirement a creature can have printed on it as a bare statement. */
type CombatStatic = 'cantBlock' | 'cantBeBlocked' | 'mustAttack' | 'doesntUntap';

/**
 * The three one-line combat statics, each spelled exactly as cards print it.
 *
 * `Characteristics` has had `cantBlock`, `cantBeBlocked` and `mustAttack` since #76, and the pool's
 * hand-written cards set them through `statics` — but `characteristicsOf` only ever read them off
 * `state.effects`, so a card that simply *prints* one had none of it. That is 209 printed lines on
 * 192 legal cards, among them Aesthir Glider, Aether Figment, Akoum Firebird and Changeling
 * Outcast: the engine already knew how to play all three rules and could not see any of them
 * (D495).
 *
 * The map is the whole reading. Anything else that ends in these words is a different sentence —
 * "can't be blocked except by creatures with flying", "gets +2/+2 and can't block" behind a
 * threshold clause, "Enchanted creature can't block" — and is refused rather than approximated,
 * because a wrong reading is worse than an unread line (D362).
 */
const COMBAT_STATICS: Readonly<Record<string, CombatStatic>> = Object.freeze({
  "can't block": 'cantBlock',
  "can't be blocked": 'cantBeBlocked',
  'attacks each combat if able': 'mustAttack',
  // Not a combat rule, but the same kind of sentence: the card's own drawback, stated of itself
  // (D589). "This artifact doesn't untap during your untap step" is Basalt Monolith.
  "doesn't untap during your untap step": 'doesntUntap',
});

/** One comma-part of a printed ability line, once it is known to be something the engine has. */
type PrintedPart =
  | { readonly kind: 'keyword'; readonly keyword: Keyword }
  /** `Devoid` — the card has no colour (CR 702.114a). See `printedColors` (D515). */
  | { readonly kind: 'devoid' }
  | { readonly kind: 'landwalk'; readonly type: string }
  | { readonly kind: 'protection'; readonly colours: readonly Color[]; readonly qualities: readonly string[] }
  /** `Toxic N` — a number, so not a `Keyword`. See `printedToxic` (D556). */
  | { readonly kind: 'toxic'; readonly amount: number }
  | { readonly kind: 'combat-static'; readonly statics: readonly CombatStatic[] }
  | { readonly kind: 'blocker-ban'; readonly clauses: readonly BlockerClause[] }
  | { readonly kind: 'blocker-only'; readonly clauses: readonly BlockerClause[] }
  | { readonly kind: 'blocks-ban'; readonly clauses: readonly BlockerClause[] }
  | { readonly kind: 'blocks-only'; readonly clauses: readonly BlockerClause[] };

/**
 * One part of a printed ability line, or `null` if this engine has nothing for it.
 *
 * The three readers below each want a different slice of the same classification, and before this
 * they each had their own copy of the whole-line rule — which is how Phyrexian Crusader's line
 * ended up read by none of them. "First strike, protection from red, protection from white, infect"
 * is four printed abilities in one list: `printedKeywords` refused the whole line because two parts
 * were not keywords, and `printedLandwalk` refused it because none were landwalks. So the card's
 * printed first strike and infect were unreachable for want of a script, and so was its protection.
 *
 * One classifier fixes all three at once, and widens the rule in the direction that is more
 * faithful rather than less: a printed ability line is a comma-separated list in which **every**
 * part is an ability this engine can model, mixed freely. A part it cannot model still refuses the
 * whole line, which is the half of the old rule that mattered — "target creature gains islandwalk"
 * is a sentence, not a list, and must not hand anything to the creature printing it.
 *
 * Protection's colour words are spelled out in full ("protection from black and from red" is
 * Paladin en-Vec's printing, "protection from red" Phyrexian Crusader's), and anything that is not
 * a colour — *protection from everything*, *from all colors*, *from creatures* — is refused rather
 * than approximated: `Characteristics.protectionFrom` is a list of colours, and a card promising
 * more than that is a card this engine should leave to a human (D362).
 */
function printedPart(part: string): PrintedPart | null {
  const text = part.trim().toLowerCase();
  if (KEYWORD_SET.has(text)) return { kind: 'keyword', keyword: text as Keyword };
  /*
    **Devoid** (CR 702.114a) — a part rather than a `Keyword`, because it says nothing about how the
    permanent behaves on the battlefield and everything about what the *card* is: it has no colour,
    in every zone. `Characteristics.keywords` is the battlefield vocabulary, so a devoid entry there
    would be a word no rule reads; `printedColors` is where the fact belongs (D515).
  */
  if (text === 'devoid') return { kind: 'devoid' };
  const walk = LAND_TYPES.find((type) => `${type.toLowerCase()}walk` === text);
  if (walk !== undefined) return { kind: 'landwalk', type: walk };
  // Digits only: every legal printing carries one, and a spelled-out or missing count is a shape
  // this has not seen — reading it would be inventing a number (D259).
  const toxic = /^toxic (\d+)$/.exec(text);
  if (toxic !== null) return { kind: 'toxic', amount: Number(toxic[1]) };
  const protection = /^protection from (.+)$/.exec(text);
  if (protection !== null) {
    // "black and from red" and "black and red" are both printed; neither is a third rule.
    const words = protection[1]!.split(/\s+and\s+(?:from\s+)?/).map((word) => word.trim());
    const colours: Color[] = [];
    const qualities: string[] = [];
    for (const word of words) {
      const colour = COLOUR_WORDS[word];
      if (colour !== undefined) { colours.push(colour); continue; }
      // Anything else must be a quality the engine can test (D596), or the line is refused.
      const quality = protectionQuality(word);
      if (quality === null) return null;
      qualities.push(quality);
    }
    if (words.length > 0) return { kind: 'protection', colours, qualities };
  }
  return null;
}

/**
 * A protection quality that is not a colour (D596), as a tag `protectionApplies` tests against the
 * source: a card type ("from artifacts", "from creatures", "from instants"), a creature type
 * ("from Goblins", "from Werewolves"), the snow supertype, "multicolored", "monocolored" and
 * "everything" (CR 702.16). The word arrives lower-cased and plural; `null` is a quality nothing
 * here can test — "non-Spirit creatures", "permanents with corruption counters on them" — and
 * refuses the line.
 */
function protectionQuality(word: string): string | null {
  if (word === 'everything' || word === 'multicolored' || word === 'monocolored') return word;
  if (word === 'snow') return 'super:snow';
  const CARD_TYPES: Readonly<Record<string, string>> = {
    artifacts: 'artifact', creatures: 'creature', enchantments: 'enchantment', instants: 'instant',
    sorceries: 'sorcery', planeswalkers: 'planeswalker', lands: 'land',
  };
  if (CARD_TYPES[word] !== undefined) return `type:${CARD_TYPES[word]}`;
  if (!/^[a-z][a-z'-]*$/.test(word)) return null;
  // A creature type in its plural, or Arcane, the one spell subtype a protection line names.
  const singulars = [word, word.replace(/s$/, ''), word.replace(/ves$/, 'f'), word.replace(/ves$/, 'fe')];
  if (word === 'arcane') return 'subtype:arcane';
  const known = singulars.find((one) => CREATURE_TYPES.some((type) => type.toLowerCase() === one));
  return known === undefined ? null : `subtype:${known}`;
}

/**
 * A whole printed line that is one or more of the three combat statics about the card itself.
 *
 * Read **before** the comma split rather than as one of its parts, and that is not a stylistic
 * choice: the subject is the card's own name, and 11 of the 192 cards have a comma in theirs.
 * "Etrata, the Silencer can't be blocked." split on commas is "Etrata" and "the Silencer can't be
 * blocked", and neither half is anything at all.
 *
 * The subject must be the card itself — its full name, its short name (*Bilbo*, for *Bilbo,
 * Luckwearer*: 9 of the 192 print only that), or "this creature" — and the predicate must be one
 * of the three statics, or several joined by "and" ("Changeling Outcast can't block and can't be
 * blocked", 4 cards). Every other subject is somebody else's: "Enchanted creature can't block" is
 * an Aura granting the restriction to its host, "Creatures can't block" is a one-sided Fog, and
 * both belong to machinery this reader has no part in. Accepting them would hand the Aura itself a
 * restriction it only grants — exactly the mistake the whole-line rule above exists to prevent.
 */
function printedCombatLine(line: string, name: string | undefined): PrintedPart | null {
  const low = line.toLowerCase().replace(/\.$/, '').trim();
  const subject = selfSubjects(name).find((candidate) => low.startsWith(`${candidate} `));
  if (subject === undefined) return null;
  const clauses = low.slice(subject.length + 1).trim().split(/\s+and\s+/)
    .map((clause) => clause.trim()).filter((clause) => clause !== '');
  if (clauses.length === 0) return null;
  const statics: CombatStatic[] = [];
  for (const clause of clauses) {
    const found = COMBAT_STATICS[clause];
    if (found === undefined) return null;
    statics.push(found);
  }
  return { kind: 'combat-static', statics };
}

/**
 * `printedParts` memoised on the text it reads.
 *
 * **A measured regression, not a precaution.** `printedParts` is a pure function of a card's oracle
 * text and its name, and `characteristicsOf` calls it three times per read — once each for the
 * statics, the blocker limits and the landwalk. `characteristicsOf` in turn is called thousands of
 * times per bot decision, because every position the search looks at re-reads every creature on the
 * board. So each reader added to this file re-splits and re-regexes the same unchanged string a few
 * thousand times a move, and the cost lands on the whole engine rather than on the reader.
 *
 * D498 is where that stopped being theoretical: adding the blocker reader took one playout test
 * from 42.8s to over 60s and the suite's 60s timeout caught it. The reader was not the problem —
 * doing its work repeatedly was. With this cache that same test runs in **18.2s**: less than half
 * the time it took on the tree *before* D498, because the four readers already here stopped
 * re-parsing too. The regression is gone and so is a cost the engine had been paying since the
 * first of these readers shipped.
 *
 * Safe to share because the value is never handed out: every caller below iterates it and builds
 * its own result, so the arrays are read-only in practice and `readonly` in the type. Keyed on
 * name-then-text with a NUL between, since either may contain any other character.
 *
 * The cap is a long-running server's bound rather than a tuning knob. The key space is the distinct
 * (name, text) pairs a process sees — about 34k cards for the whole corpus, plus one entry per
 * distinct line from `isPrintedAbilityLine` during a compile sweep. Both are finite, so the cache
 * cannot grow without end; the cap is there so that a process which somehow sees more than that
 * clears rather than climbs. Clearing is correct at any moment, which is the whole merit of
 * memoising a pure function.
 */
/**
 * The header of a leveler's level band: `LEVEL 2-6`, `LEVEL 7+` (CR 711.2).
 *
 * Everything printed from the first of these to the end of the card belongs to a band — it is what
 * the creature has **while it has that many level counters**, not what the card has. Oracle prints
 * a band as a header line, a power/toughness line and then one ability to a line, so to a reader
 * that goes line by line a band's `Flying` is indistinguishable from the card's own.
 *
 * It was not distinguished until D572, and every leveler read from printed data came out holding
 * its top band at level zero: Coralhelm Commander flew, Hada Spy Patrol was unblockable with
 * shroud, Brimstone Mage tapped for one damage *and* for three. 26 legal cards. Nothing noticed,
 * because the pool's own two levelers were typed in a one-line form (`LEVEL 2-6: 3/3, first
 * strike`) that no reader could parse — so the pool's text hid the bug its real text would have
 * shown, which is what D571's comparison against the Oracle rows turned up.
 *
 * Both forms are matched, so a pool card written the old way stops here too.
 */
export const LEVEL_BAND_HEADER = /^LEVEL \d+(?:-\d+|\+)(?![\w/])/i;

const PARTS_CACHE = new Map<string, readonly PrintedPart[]>();
const PARTS_CACHE_CAP = 200_000;

/**
 * Every printed ability line of a card, classified — lines with anything unreadable in them left
 * out entirely.
 *
 * Reminder text in brackets describes an ability rather than granting one, so it comes off first.
 *
 * The result is shared and must not be mutated; see `PARTS_CACHE`.
 */
function printedParts(
  oracleText: string | null | undefined,
  name?: string,
): readonly PrintedPart[] {
  const text = oracleText ?? '';
  const key = `${name ?? ''}\u0000${text}`;
  const hit = PARTS_CACHE.get(key);
  if (hit !== undefined) return hit;
  const found: PrintedPart[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\([^)]*\)/g, '').trim();
    if (!line) continue;
    // A level band and everything under it: not this card's abilities. See `LEVEL_BAND_HEADER`.
    if (LEVEL_BAND_HEADER.test(line)) break;
    const combat = printedCombatLine(line, name);
    if (combat !== null) { found.push(combat); continue; }
    const blockers = printedBlockerLine(line, name);
    if (blockers !== null) { found.push(blockers); continue; }
    const blocks = printedBlocksLine(line, name);
    if (blocks !== null) { found.push(blocks); continue; }
    /*
      A semicolon separates keywords exactly as a comma does, and 33 legal lines use one:
      `Vigilance; horsemanship`, `Flying; fear`, `Defender; reach`, `First strike; banding`. Before
      D501 the split was on commas alone, so every one of those lines came out as a single part that
      is not a keyword and the whole line was refused — including five printings of the three
      keywords D501 adds, which is how it was noticed.

      Safe because the whole-line rule is unchanged: **every** part still has to be a part, so a
      line carrying a semicolon and anything unreadable (the banding lines, which this engine has no
      keyword for) is refused exactly as before.
    */
    /*
      A protection list printed with commas — "Protection from Vampires, from Werewolves, and from
      Zombies" — is one part, not three: joined back into the "and from" form the part reads (D596).
    */
    const joined = line.replace(/,\s*(?:and\s+)?(?=from\s)/gi, ' and ');
    const parts = joined.split(/[,;]\s*/).map((part) => part.trim()).filter(Boolean)
      .map((part) => printedPart(part));
    if (parts.length === 0 || !parts.every((part) => part !== null)) continue;
    for (const part of parts) found.push(part!);
  }
  if (PARTS_CACHE.size >= PARTS_CACHE_CAP) PARTS_CACHE.clear();
  PARTS_CACHE.set(key, found);
  return found;
}

/**
 * Whether this one line is a printed ability line the engine reads off the card definition itself.
 *
 * For `compile.ts`, which counts such a line **compiled and emits nothing**: restating it in a
 * script would be a second source for one fact. Before the classifier above, that check asked
 * `printedKeywords` alone, so River Boa's `Islandwalk` and Paladin en-Vec's protection were
 * reported as unread lines on cards the engine was already playing correctly.
 */
export function isPrintedAbilityLine(line: string, name?: string): boolean {
  return printedParts(line, name).length > 0;
}

export function printedKeywords(oracleText: string | null | undefined): Keyword[] {
  const found = new Set<Keyword>();
  for (const part of printedParts(oracleText)) {
    if (part.kind === 'keyword') found.add(part.keyword);
  }
  return [...found];
}

/**
 * Protection printed on a card, read from its oracle text (CR 702.16).
 *
 * `printedLandwalk`'s sibling, added for the same reason and closing the same kind of hole: before
 * this, `protectionFrom` was set **only** by a continuous effect, so a card with no script had no
 * protection however plainly its text printed it. Paladin en-Vec and Phyrexian Crusader each carry
 * a `statics` entry for exactly that, and both work — what has nothing to fall back on is the card
 * that arrives from printed data, and the corpus #318 imports is unscripted by definition.
 *
 * As with landwalk, the two scripted cards are now redundant rather than wrong and they stay:
 * deleting a shipping card's static to rely on a reading added the same day buys nothing.
 */
/**
 * A card's printed toxic value: the sum of every `Toxic N` it prints (CR 702.164b).
 *
 * "Players dealt combat damage by this creature also get N poison counters" (CR 702.164a). The
 * engine's first printed ability that is a **number** rather than a word, a colour or a land type,
 * which is why it is its own part and its own field instead of an entry in `KEYWORDS`: a
 * `ReadonlySet<Keyword>` cannot say *how much*, and toxic is nothing but how much. Bushido met the
 * same wall and went round it as a pair of triggers, which was right for bushido — it **is** a
 * triggered ability (CR 702.45a) — and would be wrong here: toxic is a static ability, its poison
 * arrives with the damage rather than after it, and a trigger would put a stack object and a
 * round of priority where the rules have neither. `hit` in `combat.ts` is the enforcement.
 *
 * Summed rather than maxed, which is the rule and not a guess: 702.164b says a creature's total
 * toxic value is the sum of all its toxic abilities. No legal card prints the line twice, so the
 * sum is one term today; it is written as a sum so a granted instance has somewhere to go.
 *
 * 40 legal lines: `Toxic 1` on 26 cards, `Toxic 2` on nine, and 3, 4 and 6 on the rest.
 */
export function printedToxic(oracleText: string | null | undefined): number {
  let total = 0;
  for (const part of printedParts(oracleText)) {
    if (part.kind === 'toxic') total += part.amount;
  }
  return total;
}

/** Printed protection from qualities that are not colours (D596). See `protectionQuality`. */
export function printedProtectionQualities(oracleText: string | null | undefined): string[] {
  const found: string[] = [];
  for (const part of printedParts(oracleText)) {
    if (part.kind !== 'protection') continue;
    for (const quality of part.qualities) if (!found.includes(quality)) found.push(quality);
  }
  return found;
}

export function printedProtection(oracleText: string | null | undefined): Color[] {
  const found: Color[] = [];
  for (const part of printedParts(oracleText)) {
    if (part.kind !== 'protection') continue;
    for (const colour of part.colours) if (!found.includes(colour)) found.push(colour);
  }
  return found;
}

/**
 * The one-line combat statics printed on a card, read from its oracle text (CR 506.3, CR 509.1b).
 *
 * `printedKeywords`, `printedLandwalk` and `printedProtection`'s fourth sibling, and the one whose
 * absence was hardest to see: the three fields it fills already existed, the pool's hand-written
 * cards already set them, and a dozen tests already covered the rules. What was missing was the
 * only path an **imported** card has — its printed text. Aesthir Glider blocked, Aether Figment was
 * blocked and Akoum Firebird sat home, each in flat contradiction of its own card (D495).
 *
 * It needs the card's name because, unlike the other three, these lines name their own subject.
 */
export function printedCombatStatics(
  oracleText: string | null | undefined,
  name?: string,
): { cantBlock: boolean; cantBeBlocked: boolean; mustAttack: boolean; doesntUntap: boolean } {
  const found = { cantBlock: false, cantBeBlocked: false, mustAttack: false, doesntUntap: false };
  for (const part of printedParts(oracleText, name)) {
    if (part.kind !== 'combat-static') continue;
    for (const one of part.statics) found[one] = true;
  }
  return found;
}

/**
 * Every creature type, which is the vocabulary changeling needs (CR 702.73a, D506).
 *
 * **Derived from the corpus, not written from memory** (D57, D259). The rule that produced it: a
 * word in the subtype section of a type line whose head says Creature, Tribal or **Kindred** is a
 * creature type; a word that also appears in the subtype section of a line with none of those is
 * not. That second clause is what keeps `Equipment`, `Saga`, `Shrine`, `Aura`, `Clue`, `Food`,
 * `Treasure`, `Background`, `Book` and `Forest` out — all ten appear on creature type lines
 * (Gingerbrute is an "Artifact Creature — Food Golem") and all ten are artifact, enchantment or
 * land subtypes rather than creature types. A changeling that was an Equipment would be a creature
 * the engine could equip something to.
 *
 * `Kindred` is the whole of why the first two derivations were wrong. Tribal cards print a creature
 * type on a noncreature card ("Kindred Sorcery — Goblin"), and Scryfall now renders that word as
 * Kindred rather than Tribal — so the first pass classified **Goblin, Elf, Wizard, Demon,
 * Elemental, Soldier, Warrior, Merfolk, Kithkin, Faerie, Giant, Shaman, Shapeshifter, Rebel, Rogue,
 * Treefolk, Eldrazi and Lhurgoyf** as noncreature subtypes and dropped eighteen of the most-played
 * tribes in the game. Caught by spot-checking the output against names I expected rather than by
 * trusting the count.
 *
 * **316 types**, and two of them are not types: `Time` and `Lord` are the halves of "Time Lord",
 * the one creature type in Magic that is two words, split by a derivation that works a word at a
 * time. Nothing asks for either, so they are left in rather than special-cased — named here so
 * the next reader knows they were seen.
 */
export const CREATURE_TYPES: readonly string[] = [
  'Advisor', 'Aetherborn', 'Alien', 'Ally', 'Andorian', 'Angel', 'Antelope', 'Ape', 'Archer', 'Archon',
  'Armadillo', 'Artificer', 'Assassin', 'Assembly-Worker', 'Astartes', 'Atog', 'Aurochs', 'Avatar',
  'Azra', 'Badger', 'Barbarian', 'Bard', 'Basilisk', 'Bat', 'Bear', 'Beast', 'Beaver', 'Beeble',
  'Beholder', 'Berserker', 'Bird', 'Bison', 'Boar', 'Borg', 'Bringer', 'Brushwagg', "C'tan", 'Caitian',
  'Camel', 'Capybara', 'Carrier', 'Cat', 'Centaur', 'Chimera', 'Citizen', 'Cleric', 'Clown', 'Cockatrice',
  'Construct', 'Coward', 'Coyote', 'Crab', 'Crocodile', 'Custodes', 'Cyberman', 'Cyclops', 'Dalek',
  'Dauthi', 'Demigod', 'Demon', 'Detective', 'Devil', 'Dinosaur', 'Djinn', 'Doctor', 'Dog', 'Dragon',
  'Drake', 'Dreadnought', 'Drix', 'Drone', 'Druid', 'Dryad', 'Dwarf', 'Echidna', 'Efreet', 'Egg',
  'Elder', 'Eldrazi', 'Elemental', 'Elephant', 'Elf', 'Elk', 'Eternal', 'Eye', 'Faerie', 'Ferret',
  'Fish', 'Flagbearer', 'Fox', 'Fractal', 'Frog', 'Fungus', 'Gamma', 'Gargoyle', 'Giant', 'Giraffe',
  'Gith', 'Glimmer', 'Gnoll', 'Gnome', 'Goat', 'Goblin', 'God', 'Golem', 'Gorgon', 'Gorn', 'Gremlin',
  'Griffin', 'Hag', 'Halfling', 'Hamster', 'Harpy', 'Hedgehog', 'Hellion', 'Hero', 'Hippo', 'Hippogriff',
  'Homarid', 'Homunculus', 'Horror', 'Horse', 'Human', 'Hydra', 'Hyena', 'Illusion', 'Imp', 'Incarnation',
  'Inhuman', 'Inkling', 'Inquisitor', 'Insect', 'Jackal', 'Jellyfish', 'Juggernaut', 'Kangaroo',
  'Kavu', 'Kelpien', 'Kirin', 'Kithkin', 'Klingon', 'Knight', 'Kobold', 'Kor', 'Kraken', 'Kree',
  'Lamia', 'Lammasu', 'Lanthanite', 'Leech', 'Lemur', 'Leviathan', 'Lhurgoyf', 'Licid', 'Lizard',
  'Lobster', 'Lord', 'Manticore', 'Masticore', 'Mercenary', 'Merfolk', 'Metathran', 'Minion', 'Minotaur',
  'Mite', 'Mole', 'Monger', 'Mongoose', 'Monk', 'Monkey', 'Moogle', 'Moonfolk', 'Mount', 'Mouse',
  'Mutant', 'Myr', 'Mystic', 'Nautilus', 'Necron', 'Nephilim', 'Nightmare', 'Nightstalker', 'Ninja',
  'Noble', 'Noggle', 'Nomad', 'Nymph', 'Octopus', 'Officer', 'Ogre', 'Ooze', 'Orc', 'Orgg', 'Orion',
  'Otter', 'Ouphe', 'Ox', 'Oyster', 'Pangolin', 'Peasant', 'Pegasus', 'Performer', 'Pest', 'Phelddagrif',
  'Phoenix', 'Phyrexian', 'Pilot', 'Pirate', 'Plant', 'Platypus', 'Porcupine', 'Possum', 'Praetor',
  'Primarch', 'Processor', 'Q', 'Qu', 'Rabbit', 'Raccoon', 'Ranger', 'Rat', 'Rebel', 'Rhino', 'Rigger',
  'Robot', 'Rogue', 'Sable', 'Salamander', 'Samurai', 'Sand', 'Saproling', 'Satyr', 'Scarecrow',
  'Scientist', 'Scorpion', 'Scout', 'Seal', 'Serpent', 'Shade', 'Shaman', 'Shapeshifter', 'Shark',
  'Sheep', "Shi'ar", 'Siren', 'Skeleton', 'Skrull', 'Skunk', 'Slith', 'Sliver', 'Sloth', 'Slug',
  'Snail', 'Snake', 'Soldier', 'Soltari', 'Sorcerer', 'Spawn', 'Specter', 'Spellshaper', 'Sphinx',
  'Spider', 'Spike', 'Spirit', 'Sponge', 'Spy', 'Squid', 'Squirrel', 'Starfish', 'Surrakar', 'Survivor',
  'Symbiote', 'Synth', 'Talosian', 'Tellarite', 'Thalakos', 'Tholian', 'Thopter', 'Thrull', 'Tiefling',
  'Time', 'Tosk', 'Toy', 'Treefolk', 'Trilobite', 'Troll', 'Turtle', 'Tyranid', 'Unicorn', 'Utrom',
  'Vampire', 'Varmint', 'Vedalken', 'Villain', 'Volver', 'Vorta', 'Vulcan', 'Wall', 'Walrus', 'Warlock',
  'Warrior', 'Weasel', 'Weird', 'Werewolf', 'Whale', 'Wizard', 'Wolf', 'Wolverine', 'Wombat', 'Worm',
  'Wraith', 'Wurm', 'Xindi', 'Yeti', 'Zombie', 'Zubera',
];

const CREATURE_TYPE_SET = new Set(CREATURE_TYPES.map((type) => type.toLowerCase()));

/** Whether a printed word names a creature type. */
export const isCreatureType = (word: string): boolean => (
  CREATURE_TYPE_SET.has(word.trim().toLowerCase())
);

/**
 * One thing a printed combat restriction says about a creature.
 *
 * Declarative rather than a closure, because `Characteristics` is data that the view packs, the bot
 * copies and the tests compare — a predicate in it would be a function crossing every one of those
 * boundaries. The vocabulary is the one the corpus actually prints (D498).
 *
 * **Asked about either side of a block.** D498 asks it about the would-be *blocker* ("~ can't be
 * blocked by white creatures"); D500 asks the identical question about the *attacker* ("~ can block
 * only creatures with flying"). The clause does not know or care which — it is a filter on a
 * creature — which is why one vocabulary and one matcher serve both directions and the name says
 * `clause` rather than `blocker`.
 */
export type BlockerClause =
  | { readonly kind: 'power'; readonly cmp: 'at-most' | 'at-least'; readonly n: number }
  | { readonly kind: 'colour'; readonly colour: Color }
  | { readonly kind: 'type'; readonly type: string }
  | { readonly kind: 'subtype'; readonly subtype: string }
  | { readonly kind: 'keyword'; readonly keyword: Keyword }
  /*
    ── The two **relational** clauses (D551) ──────────────────────────────────────────────────────

    Every clause above is a fact about one creature. These two are about **the pair**, and they are
    why `clauseMatches` now takes the other creature as a second argument rather than reading one.
    The docblock above this type used to say the matcher "sees one creature on purpose" and name
    these as #345's problem; they are two rules of the game rather than a wider vocabulary, and both
    are keyword reminder text, so writing them down invents nothing (D259).

    `shares-a-colour` — intimidate (CR 702.13a): "can't be blocked except by artifact creatures
    and/or creatures that share a color with it". A colourless creature shares a colour with
    nothing, including another colourless creature, which is the rule and not an edge case.

    `power-vs` — skulk (CR 702.118a): "can't be blocked by creatures with greater power", and the
    three printed cards that say the same thing in their own words. Both forms are needed because
    both occur: the printed cards state it as a **ban** on greater power, and the keyword table
    states it as an **allow list** of power at most this creature's, which is the same rule read
    from the other end.
  */
  | { readonly kind: 'shares-a-colour' }
  | { readonly kind: 'power-vs'; readonly cmp: 'at-most' | 'greater' };

/**
 * Whether a creature answers to this clause, in a block where `other` is the creature facing it.
 *
 * `creature` is the would-be blocker for D498's two lists and the attacker for D500's two; `other`
 * is whichever of the pair `creature` is not. One matcher still serves both ends — the clause does
 * not know which side it is being asked about — and that is exactly what makes the relational
 * clauses work from either direction.
 *
 * **`other` is required rather than optional, and that is the whole safety argument.** An optional
 * parameter would compile at all six call sites in `canBlock` and silently answer a relational
 * clause against nothing; and because these clauses appear in *allow* lists, "no clause matched"
 * means the block is refused — so a forgotten argument would make a skulk creature unblockable
 * rather than failing loudly. Required, the compiler names every site that has not been told.
 */
export function clauseMatches(
  clause: BlockerClause, creature: Characteristics, other: Characteristics,
): boolean {
  switch (clause.kind) {
    case 'power':
      return clause.cmp === 'at-most' ? creature.power <= clause.n : creature.power >= clause.n;
    case 'colour': return creature.colors.includes(clause.colour);
    case 'type': return hasType(creature.typeLine, clause.type);
    case 'subtype': return hasSubtype(creature.typeLine, clause.subtype);
    case 'keyword': return creature.keywords.has(clause.keyword);
    /*
      Colourless shares a colour with nothing — not even with another colourless creature — because
      "shares a color" is about colours held in common and neither of them holds any (CR 702.13a,
      and the same reading protection has always had here). So an intimidating colourless creature
      is blockable only by artifact creatures, which is what the card does.
    */
    case 'shares-a-colour':
      return creature.colors.some((colour) => other.colors.includes(colour));
    case 'power-vs':
      return clause.cmp === 'at-most'
        ? creature.power <= other.power
        : creature.power > other.power;
    default: return false;
  }
}

/**
 * One evasion keyword whose rule is a restriction on blocking, expressed in the clause vocabulary.
 *
 * **Separate from the printed-list fields, and Dauthi Horror is why.** Its text is
 * `Shadow` + `Dauthi Horror can't be blocked by white creatures` — a keyword allow list and a
 * printed ban on one card. D498 refuses a card that prints both a ban and an allow list, because
 * merging them is a judgement; stuffing shadow's rule into `blockableOnlyBy` would trip that
 * refusal and the card would lose *both* restrictions. They are not in conflict: a white shadow
 * creature may not block it, for two independent reasons. So the keyword rules live here and
 * `canBlock` applies them **alongside** whatever the card prints, each list satisfied on its own.
 *
 * That is also the correct rule for a creature carrying two of these at once: every list must be
 * answered, and the clauses *within* one list are alternatives.
 */
export interface KeywordBlockRule {
  readonly keyword: Keyword;
  /** A would-be blocker must answer one of these, or it may not block this creature. */
  readonly blockedOnlyBy?: readonly BlockerClause[];
  /** This creature may block only an attacker answering one of these. */
  readonly blocksOnly?: readonly BlockerClause[];
}

/** The keyword block restrictions this engine knows, each straight from its rule (D501). */
export const KEYWORD_BLOCK_RULES: readonly KeywordBlockRule[] = [
  // CR 702.36a. Artifact *or* black, which is why a clause list is a list of alternatives.
  {
    keyword: 'fear',
    blockedOnlyBy: [{ kind: 'type', type: 'artifact' }, { kind: 'colour', colour: 'B' }],
  },
  // CR 702.28b-c, and the only rule here that restricts both directions at once.
  {
    keyword: 'shadow',
    blockedOnlyBy: [{ kind: 'keyword', keyword: 'shadow' }],
    blocksOnly: [{ kind: 'keyword', keyword: 'shadow' }],
  },
  // CR 702.5b. One direction: a creature with horsemanship may block anything it likes.
  {
    keyword: 'horsemanship',
    blockedOnlyBy: [{ kind: 'keyword', keyword: 'horsemanship' }],
  },
  /*
    Intimidate (CR 702.13a), the first rule here that needs a **relational** clause: "can't be
    blocked except by artifact creatures and/or creatures that share a color with it". Fear's
    shape with the fixed colour replaced by a comparison — which is exactly why it had to wait for
    `clauseMatches` to be handed both creatures (D551). 21 legal lines.
  */
  {
    keyword: 'intimidate',
    blockedOnlyBy: [{ kind: 'type', type: 'artifact' }, { kind: 'shares-a-colour' }],
  },
  /*
    Skulk (CR 702.118a): "can't be blocked by creatures with greater power". 14 legal lines.

    Written as an **allow list of power at most this creature's**, rather than as a ban on greater
    power, because `KeywordBlockRule` has no ban field — and the two are exactly equivalent, since
    "not greater" and "at most" are the same comparison. Stated once, in the form the table can
    hold, rather than giving the table a second field for one keyword.
  */
  {
    keyword: 'skulk',
    blockedOnlyBy: [{ kind: 'power-vs', cmp: 'at-most' }],
  },
];

/** The keyword block rules this creature's keywords impose, in `KEYWORD_BLOCK_RULES` order. */
export function keywordBlockRules(ch: Characteristics): readonly KeywordBlockRule[] {
  return KEYWORD_BLOCK_RULES.filter((rule) => ch.keywords.has(rule.keyword));
}

/** The creature types a printed blocker filter may name, capitalised as cards print them. */
const BLOCKER_SUBTYPES: readonly string[] = ['Wall', 'Walls', 'Wizard', 'Wizards'];

/**
 * One printed noun phrase describing would-be blockers, as a list of clauses any one of which the
 * blocker may answer to — or `null` for a phrase this engine cannot read.
 *
 * "creatures with power 3 or less", "artifact creatures", "white creatures", "creatures with
 * flying", "Walls", and any of those joined by "or" or "and/or". A phrase it cannot read refuses
 * the whole line, which is the half that matters: "creatures you control", "more than one creature"
 * and "three or more creatures" are all real printings and all a different rule, and reading any of
 * them as one of these would be a creature that blocks when it may not (D362).
 */
function blockerFilter(phrase: string): readonly BlockerClause[] | null {
  /*
    **The whole phrase first, and that is not an optimisation.** Splitting on "or" before trying the
    phrase whole turned "creatures with power 3 or greater" into "creatures with power 3" and
    "greater" — Amrou Kithkin read as nothing, and the 40-line power family with it. The comparison
    words are part of one clause; "flying or reach" is two. Only a phrase that is not itself a
    clause is a list.
  */
  const whole = oneBlockerClause(phrase.trim());
  if (whole !== null) return [whole];
  /*
    "creatures with flying or reach" — one noun carrying a list of keywords, which is a different
    shape from "artifact creatures and/or white creatures" because the list is *inside* the phrase.
    Split naively and the parts come out as "creatures with flying" and a bare "reach", and the
    second is not a phrase this reader knows.

    Every word has to be a keyword the engine has, which is the gate that keeps this safe: "creatures
    with shadow" is refused, because shadow is not in `KEYWORDS` and a creature that ignored it
    would be blocked by things that cannot block it.
  */
  const withList = /^creatures? with (.+)$/i.exec(phrase.trim());
  if (withList !== null) {
    const words = withList[1]!.split(/\s*,?\s*and\/or\s+|\s*,\s*or\s+|\s+or\s+|\s*,\s*/)
      .map((word) => word.trim().toLowerCase()).filter((word) => word !== '');
    if (words.length > 1 && words.every((word) => isKeyword(word))) {
      return words.map((word) => ({ kind: 'keyword', keyword: word as Keyword } as const));
    }
  }
  const parts = phrase.trim().split(/\s*,?\s*and\/or\s+|\s*,\s*or\s+|\s+or\s+|\s*,\s*/)
    .map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) return null;
  const clauses: BlockerClause[] = [];
  for (const part of parts) {
    const clause = oneBlockerClause(part);
    if (clause === null) return null;
    clauses.push(clause);
  }
  return clauses;
}

/** One part of a printed blocker filter. */
function oneBlockerClause(part: string): BlockerClause | null {
  const lower = part.toLowerCase();
  const power = /^creatures? with power (\d+) or (less|greater)$/.exec(lower);
  if (power !== null) {
    return { kind: 'power', cmp: power[2] === 'less' ? 'at-most' : 'at-least', n: Number(power[1]) };
  }
  /*
    "creatures with greater power" (D551), which three legal cards print in their own words rather
    than through skulk. Greater than *what* is the attacker, which is the creature printing the
    line — the relational reading `clauseMatches` now supports.
  */
  if (/^creatures? with greater power$/.test(lower)) return { kind: 'power-vs', cmp: 'greater' };
  const keyword = /^creatures? with ([a-z][a-z' ]*)$/.exec(lower);
  if (keyword !== null) {
    const word = keyword[1]!.trim();
    return isKeyword(word) ? { kind: 'keyword', keyword: word } : null;
  }
  const colour = /^([a-z]+) creatures?$/.exec(lower);
  if (colour !== null) {
    const found = COLOUR_WORDS[colour[1]!];
    if (found !== undefined) return { kind: 'colour', colour: found };
    if (colour[1] === 'artifact') return { kind: 'type', type: 'artifact' };
    return null;
  }
  const subtype = BLOCKER_SUBTYPES.find((type) => type.toLowerCase() === lower);
  if (subtype !== undefined) {
    return { kind: 'subtype', subtype: subtype.replace(/s$/, '') };
  }
  return null;
}

/**
 * One printed line about who may block this creature, or `null`.
 *
 * Read per line and classified as a `PrintedPart`, which is the same shape D495 gave the combat
 * statics and for the same two reasons: `compile.ts` counts such a line **compiled and emits
 * nothing**, because `characteristicsOf` reads it straight off the card; and the whole-line rule
 * applies, so a sentence this cannot read refuses the line rather than handing over the half it
 * understood (D487).
 *
 * A **ban** ("can't be blocked by X") and an **allow** ("can't be blocked except by X") are not the
 * same rule and do not share a list: a ban refuses a blocker matching any clause, an allow refuses
 * one matching none.
 *
 * Counts are deliberately out. "Can't be blocked by more than one creature" (17 printed lines) and
 * "can't be blocked except by three or more creatures" (6) are about how **many** creatures block,
 * not which — a fact about the whole declaration rather than about one blocker, which is
 * `menaceSatisfied`'s family and belongs with it (D498).
 */
function printedBlockerLine(line: string, name: string | undefined): PrintedPart | null {
  const low = line.toLowerCase().replace(/\.$/, '').trim();
  const opener = " can't be blocked ";
  const subject = selfSubjects(name).find((self) => low.startsWith(`${self}${opener}`));
  if (subject === undefined) return null;
  const rest = low.slice(subject.length + opener.length).trim();
  const allow = /^except by (.+)$/.exec(rest);
  const deny = allow === null ? /^by (.+)$/.exec(rest) : null;
  const phrase = (allow ?? deny)?.[1];
  if (phrase === undefined) return null;
  const clauses = blockerFilter(phrase);
  if (clauses === null) return null;
  return { kind: allow !== null ? 'blocker-only' : 'blocker-ban', clauses };
}

/**
 * What a card prints about who may block it: a ban list, an allow list, or neither.
 *
 * The fifth printed-characteristic reader, after keywords, landwalk, protection and the combat
 * statics. 244 printed lines in 126 shapes say something about who may block this creature, and
 * these two sentences are most of them:
 *
 *     ~ can't be blocked by creatures with power 2 or less.      (31 printed lines)
 *     ~ can't be blocked except by creatures with flying.        (the allow-list half)
 *
 * **A card printing both is refused rather than merged**, and so is a second allow list, because
 * the merge rule would be a judgement nothing in the corpus asks for — and a guessed merge is a
 * creature that blocks when it may not (D362).
 */
export function printedBlockerLimit(
  oracleText: string | null | undefined,
  name?: string,
): { readonly ban: readonly BlockerClause[]; readonly only: readonly BlockerClause[] | null } {
  const ban: BlockerClause[] = [];
  let only: readonly BlockerClause[] | null = null;
  let twoAllowLists = false;
  for (const part of printedParts(oracleText, name)) {
    if (part.kind === 'blocker-ban') ban.push(...part.clauses);
    else if (part.kind === 'blocker-only') {
      if (only !== null) twoAllowLists = true;
      only = part.clauses;
    }
  }
  if (twoAllowLists || (ban.length > 0 && only !== null)) return { ban: [], only: null };
  return { ban, only };
}

/**
 * One printed line about what **this creature may block**, or `null`.
 *
 * D498's mirror, and a separate pair of fields rather than a reuse of its two. The distinction is
 * not pedantry: `~ can't be blocked by creatures with flying` keeps fliers from blocking *it*,
 * `~ can block only creatures with flying` keeps *it* from blocking anything else, and a creature
 * carrying the second is a ground blocker that happens to hit fliers — read either as the other and
 * the engine either lets a block through that the card forbids or forbids one it allows. Both are
 * wrong readings of a line it could simply have left unread (D362).
 *
 * The family, from 33,847 printings:
 *
 *     ~ can block only creatures with flying.              (29 lines, the whole allow-list half)
 *     ~ can't block creatures with power 3 or greater.      (6)
 *     ~ can't block creatures with power 2 or less.         (2)
 *
 * Every other `can block only` printing hands the restriction to **somebody else** — an Aura's
 * "Enchanted creature", Chaosphere's "Creatures with flying", or a token-making spell quoting the
 * sentence onto the token it creates — so the whole-line subject rule refuses them all, as it does
 * for D495's statics and D498's lists.
 *
 * `~ can't block` and `~ can't block and can't be blocked` are **D495's** statics and are read
 * there: `printedParts` asks `printedCombatLine` first, and in any case the ban regex here needs a
 * filter phrase after "block" and finds none. `~ can't block if you control an untapped land` is
 * refused for its filter, which is a condition and not a creature.
 */
function printedBlocksLine(line: string, name: string | undefined): PrintedPart | null {
  const low = line.toLowerCase().replace(/\.$/, '').trim();
  const subject = selfSubjects(name).find((self) => low.startsWith(`${self} can`));
  if (subject === undefined) return null;
  const rest = low.slice(subject.length).trim();
  const allow = /^can block only (.+)$/.exec(rest);
  const deny = allow === null ? /^can't block (.+)$/.exec(rest) : null;
  const phrase = (allow ?? deny)?.[1];
  if (phrase === undefined) return null;
  const clauses = blockerFilter(phrase);
  if (clauses === null) return null;
  return { kind: allow !== null ? 'blocks-only' : 'blocks-ban', clauses };
}

/**
 * What a card prints about what **it** may block: a ban list, an allow list, or neither.
 *
 * `printedBlockerLimit`'s mirror, with the same refusal when a card prints both — the merge rule
 * would be a judgement nothing in the corpus asks for, and a guessed merge is a creature that
 * blocks when it may not, or refuses a block it may make (D362, D498).
 */
export function printedBlocksLimit(
  oracleText: string | null | undefined,
  name?: string,
): { readonly ban: readonly BlockerClause[]; readonly only: readonly BlockerClause[] | null } {
  const ban: BlockerClause[] = [];
  let only: readonly BlockerClause[] | null = null;
  let twoAllowLists = false;
  for (const part of printedParts(oracleText, name)) {
    if (part.kind === 'blocks-ban') ban.push(...part.clauses);
    else if (part.kind === 'blocks-only') {
      if (only !== null) twoAllowLists = true;
      only = part.clauses;
    }
  }
  if (twoAllowLists || (ban.length > 0 && only !== null)) return { ban: [], only: null };
  return { ban, only };
}

/** The spellings a card uses for itself as the subject of a printed sentence. */
function selfSubjects(name?: string): readonly string[] {
  return [
    ...(name === undefined
      ? []
      : [name.toLowerCase(), shortName(name)?.toLowerCase()].filter((x): x is string => x !== undefined)),
    ...SELF_TYPE_WORDS.map((word) => `this ${word.toLowerCase()}`),
  ];
}

/**
 * Landwalk printed on a card, read from its oracle text (CR 702.14).
 *
 * The sibling of `printedKeywords`, and separate for the reason `Characteristics.landwalk` is its
 * own field rather than a keyword: there is one landwalk rule and a dozen land types, so the
 * engine stores the *types* and not a dozen keyword strings.
 *
 * It exists for the **unscripted** card. `KEYWORDS` has no `islandwalk`, so `printedKeywords` could
 * never return one, and before this `landwalk` was set only by a continuous effect — which is why
 * River Boa and the Squid token each carry a `statics` entry for the islandwalk their own text
 * already prints. Both of them work, and a test pins the Squid's; what has no script to fall back on
 * is a card that arrives from printed data, and the corpus #318 imports is unscripted by definition.
 *
 * So the two scripted cards are now redundant rather than wrong, and they stay: deleting a shipping
 * card's static to rely on a reading added the same day buys nothing. What this closes is the hole
 * underneath them.
 *
 * Read with the same whole-line rule as `printedKeywords`: a landwalk line is a comma-separated
 * list of landwalks and nothing else, so "Islandwalk" counts and "target creature gains islandwalk"
 * does not.
 */
export function printedLandwalk(oracleText: string | null | undefined): string[] {
  const found = new Set<string>();
  for (const part of printedParts(oracleText)) {
    if (part.kind === 'landwalk') found.add(part.type);
  }
  return [...found];
}

/**
 * Colours a card is, from its mana cost's colour requirements plus any colour indicator — **unless
 * it prints Devoid, in which case it has none** (CR 702.114a).
 *
 * ## Why devoid is read here and nowhere else
 *
 * 132 legal printings say `Devoid`, and every one of them arrives from card data with a non-empty
 * `colors` array, because that field is derived from the mana cost: Abstruse Interference is
 * `{2}{U}` and the row says blue. The card is **colorless**, and the engine was playing all 132 as
 * coloured — a Counterspell-for-blue could counter one, protection from black turned aside a devoid
 * Eldrazi, and the colour filters counted them.
 *
 * This function is the one place the engine asks what colour a card is: `characteristicsOf` calls it
 * for every permanent and every spell on the stack, and `copySpell` calls it for a copy's own
 * characteristics. So the reading goes here rather than in `printedDef`, which would leave anything
 * holding a def built another way still wrong, and rather than in both, which is two sources for one
 * fact — the thing this file keeps removing.
 *
 * Colour **identity** is deliberately untouched (CR 903.4): a devoid card's identity still comes
 * from the mana symbols on it, which is why a Commander deck may not run one outside its colours.
 * Nothing in this package computes identity, and the field this reads is not it.
 */
export function printedColors(def: CardDef | undefined): Color[] {
  if (printedParts(def?.oracleText).some((part) => part.kind === 'devoid')) return [];
  const declared = (def?.colors ?? []).map((c) => String(c).toUpperCase());
  return (['W', 'U', 'B', 'R', 'G'] as Color[]).filter((c) => declared.includes(c));
}

/**
 * Whether a printed line is **devoid** — the one keyword declaration whose entire effect is a fact
 * about the `CardDef` rather than anything a script could carry (D516).
 *
 * Exists because the two compile paths disagreed about it. A permanent's lines go through
 * `isPrintedAbilityLine`, which counts `Devoid` compiled and emits nothing, exactly right: the
 * reading lives in `printedColors` above. A spell's lines go through `spellScriptFor`, where a
 * keyword declaration nothing can *build* lands in `declared` and is reported unread — which was
 * right until D515, when `printedColors` started reading it. After that the same printed word was
 * compiled on Turn Against's Eldrazi cousins and unread on Turn Against, while the engine played
 * both colourlessly. Five legal spells had this as their only unread line.
 *
 * Narrow on purpose. The other members of `PrintedPart` — landwalk, protection, the combat statics,
 * the blocker bans — are facts about a permanent on the battlefield and cannot appear on an instant
 * or a sorcery, so widening this to "any part read off the def" would buy nothing and would let a
 * genuinely unread battlefield line through on a card type that cannot have one.
 */
export function isDevoidLine(line: string): boolean {
  return printedParts(line).some((part) => part.kind === 'devoid');
}

export type EffectDuration =
  | 'end-of-turn'
  | 'end-of-combat'
  /**
   * "Until your next turn", where *you* is the effect's own `controller`.
   *
   * The first duration here anchored to a seat rather than to a point in the current turn, and goad
   * is why: a goad cast on somebody else's turn has to survive the end of that turn and every turn
   * in between, then end when the goading player's own turn begins. `end-of-turn` would expire it
   * before the combat it exists to force, which is worse than not having the card.
   *
   * Expired in the untap step, which is the first thing a turn does — so the effect is gone before
   * anybody could read it, rather than lingering through the turn that ends it.
   */
  | 'until-controllers-next-turn'
  | 'permanent';

/**
 * A continuous effect currently modifying the battlefield.
 *
 * `scope` decides who it applies to. `source` is kept so an effect can be removed when the
 * permanent that made it leaves, which is what makes a static anthem work.
 */
export interface ContinuousEffect {
  readonly id: string;
  readonly source: string;
  readonly controller: SeatIndex;
  readonly scope:
    | { readonly kind: 'cards'; readonly ids: readonly string[] }
    | { readonly kind: 'controller-creatures' }
    /**
     * Every creature its controller has **except the one that made it**.
     *
     * The usual templating on a creature that buffs a team — "*other* creatures you control get
     * +1/+0" — and the difference matters in combat: a 2/2 lord that pumped itself attacks as a
     * 3/2. `source` is what it excludes, which is why a continuous effect keeps it.
     */
    | { readonly kind: 'other-controller-creatures' }
    /**
     * Every creature of one type its controller has — "other Goblin creatures you control get
     * +1/+1", and every tribal lord ever printed.
     *
     * The only scope here that carries a value, which is why `other` is a field on it rather than a
     * second `kind` the way `other-controller-creatures` is: a parameterised scope already has to
     * be read rather than matched, so one more field costs nothing, where two bare tags would have
     * become four.
     *
     * Matched against the type line **after layer 4** wherever the caller has one (CR 613.1d before
     * 613.1f), so a permanent that was *given* a creature type is in the scope. No card in the pool
     * adds a subtype yet, so that half is ordering rather than a feature anything uses — it has a
     * test built on a hand-made effect, because the ordering is the kind of thing that is free to
     * get right now and expensive to discover later. The two callers that have only the printed
     * line are the layer-4 pass itself, which cannot have its own output, and
     * `combatDamagePrevented`, where nothing in the pool cares.
     */
    | {
        readonly kind: 'controller-subtype';
        readonly subtype: string;
        /** "**Other** Goblin creatures", which is how almost every lord is worded. */
        readonly other?: boolean;
      }
    | { readonly kind: 'all-creatures' }
    /**
     * **The two creatures of a soulbond pair**, read off the board rather than written down
     * (CR 702.95a).
     *
     * The only scope here whose membership *changes* while the effect sits there, and that is the
     * whole reason it is a scope rather than an `ids` list. Every other static is created as its
     * permanent enters, with the cards it reaches fixed at that moment; a pair is made and broken
     * by state-based action long after the Wolfir Silverheart arrived, and an `ids` list would
     * have to be edited in step with it from three places that break pairs.
     *
     * So the effect is created once, with `duration: 'permanent'`, and asks `source.pairedWith`
     * every time it is read. Unpaired, it reaches nobody at all — "as long as this creature is
     * paired with another creature" is a condition that holds itself.
     */
    | { readonly kind: 'pair' }
    /**
     * One player, rather than any permanent.
     *
     * The only scope here that names a seat, and the only one `characteristicsOf` can never match,
     * because a player has no characteristics to modify. It exists for the one kind of effect that
     * has to be able to point at a player the same way it points at a creature: a prevention
     * shield, whose printed target is "any target" (CR 115.4). `effectApplies` says so out loud
     * rather than falling through the default, so the next effect that wants a seat scope finds
     * the question already asked.
     */
    | { readonly kind: 'seat'; readonly seat: SeatIndex }
    /**
     * **One player and the permanents they control** — "you and/or permanents you control".
     *
     * The second scope `characteristicsOf` can never match, and it exists for the same reason
     * `seat` does: a prevention shield has to be able to cover something that is not a permanent.
     * This one covers *both*, which is what the two redirection cards say and what no other scope
     * here can express — `seat` is the player alone and `controller-creatures` is the creatures
     * alone, and a card that covers the pair with **one** quantity cannot be two effects, because
     * two would prevent twice as much.
     *
     * Read live rather than fixed as an id list, so a creature that arrives after the shield is
     * under it too. That is the printed card: "damage that would be dealt to you and/or permanents
     * you control this turn" does not name them when it resolves.
     */
    | { readonly kind: 'seat-side'; readonly seat: SeatIndex };
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  /** Removes keywords, for effects like "loses flying". */
  readonly removeKeywords?: readonly Keyword[];
  /** Blanket "can't attack or block", which is Pacifism and friends. */
  readonly cantAttack?: boolean;
  readonly cantBlock?: boolean;
  /**
   * "Doesn't untap during its controller's untap step" (D589) — Apathy's Aura, Basalt Monolith's
   * own drawback, a Cement Shoes. Read by the untap step (`untapAll`), which leaves the permanent
   * as it is. Not the one-shot "next untap step", which is `CardInstance.frozen` and is spent by
   * the step happening; this lasts as long as the effect does.
   */
  readonly doesntUntap?: boolean;
  /**
   * "Attacks each combat if able" (CR 508.1d). The opposite of `cantAttack`, and the harder of the
   * two: a restriction is checked against one creature, a *requirement* is checked against the
   * whole declaration — a creature that could have attacked and did not makes the declaration
   * illegal, and "could have" has to account for being tapped, summoning-sick, Pacified, or
   * having nobody legal to attack.
   */
  readonly mustAttack?: boolean;
  /**
   * "Can't be blocked by Walls." A restriction on the *blocker*, read from the attacker, which is
   * the only shape of evasion in this pool that is not a keyword — so it lives here rather than
   * in `Keyword`, and `canBlock` reads it the way `dealCombatDamage` reads `preventsCombatDamage`.
   */
  readonly cantBeBlockedByWalls?: boolean;
  /**
   * "Can't be blocked" with nothing after it — the absolute kind of evasion, which this pool had
   * none of. Read off the attacker by `canBlock`, like `cantBeBlockedByWalls`.
   */
  readonly cantBeBlocked?: boolean;
  /**
   * **Landwalk**: the land subtypes this creature cannot be blocked while the *defending player*
   * controls (CR 702.14). "Islandwalk" is `['Island']`.
   *
   * A list rather than a flag, and a list of subtypes rather than an enum, because the question is
   * a parameter: there is one landwalk rule and a dozen land types, which is the same argument
   * `statics`' subtype scope settled (D57). What makes it different from every other evasion here
   * is *where* it is read — the attacker says which subtype, and the answer is on the other
   * player's battlefield at the moment blockers are declared, which is why it cannot be a keyword
   * and cannot be decided when the attack is declared.
   */
  readonly landwalk?: readonly string[];
  /**
   * "Attacks a player other than you if able" (CR 701.38a) — goad's second half, where *you* is
   * this effect's `controller`.
   *
   * The Comprehensive Rules call this a requirement, like `mustAttack`, but it is enforced as a
   * conditional restriction: the creature may not be aimed at the goading player *while there is
   * another player it could attack instead*. Those are the same rule from two directions, and the
   * restriction is the half a declaration can actually be checked against — and the half a table
   * can keep a player from building.
   *
   * Two goaders cancel out rather than stacking into an impossible demand: if every player the
   * creature could attack has goaded it, no requirement can be met and all of them are legal,
   * which is what "if able" means and what `attackAimIssue` works out.
   */
  readonly mustAttackAnotherPlayer?: boolean;
  /**
   * Protection from each of these colours (CR 702.16).
   *
   * One flag for four rules, which is what makes protection the awkward keyword it is: a creature
   * with protection from red cannot be **d**amaged, **e**nchanted or equipped, **b**locked or
   * **t**argeted by anything red. Each of those four lives somewhere different in this engine —
   * `dealDamage`, `equipTo`, `canBlock`, and target legality — and a keyword that only did three of
   * them would be worse than none, because a player would trust it.
   *
   * Carried as colours rather than as a predicate because that is how every printed version reads,
   * and because the thing it is compared against — a source's colours — is itself a list.
   */
  readonly protectionFrom?: readonly Color[];
  /**
   * **Triggered abilities this effect hands the permanents in scope** (CR 113.6, 603.2) — the
   * indices of entries in the *source card's* `grantedTriggers`.
   *
   * Indices rather than the ability itself, and that is the whole design. A `TriggerDef` is a bag
   * of functions — a condition, an effect, a target filter — and `GameState` is data that is
   * cloned, serialised and handed between a socket layer and a bot search. Putting a closure on an
   * effect would have made the state uncloneable at the first card that used it. So the effect
   * carries a *reference* and the script is still the single definition: the grantor is `source`,
   * its card name comes off its instance, and `scriptFor(name).grantedTriggers[i]` is the ability.
   *
   * It rides here rather than on a declaration of its own because the hard parts are already
   * solved on this object. Who gets it is `scope`, which can name one card (an Aura's host), a
   * team, a creature type, or — the one that made this worth building — a soulbond `pair`, whose
   * membership changes under the effect while it sits there. How long for is `duration`, and the
   * effect is removed with the permanent that made it by the same pass that takes away an anthem.
   * A second declaration would have had to re-answer all of that.
   */
  readonly grants?: readonly number[];
  /**
   * **Activated abilities this effect hands the permanents in scope** (CR 113.6) — the indices of
   * entries in the *source card's* `grantedAbilities`.
   *
   * `grants`' sibling, and a second field rather than a second meaning for it, because the two
   * index different arrays on the script: one holds `TriggerDef`s, the other `AbilityDef`s, and a
   * shared index list would make every reader guess which array an index belonged to. Everything
   * `grants`' docblock says about *why indices* applies unchanged — an `AbilityDef` is a bag of
   * functions and this object has to stay cloneable.
   *
   * Collected by `grantedAbilitiesOn`, which is `grantedTriggersOn` with the other field read:
   * same scope, same duration, same layer-6 erasure.
   */
  readonly grantsAbilities?: readonly number[];
  /**
   * Combat damage involving the permanents in scope does not happen — dealt **by** them and dealt
   * **to** them. A Fog is this with an all-creatures scope; a Maze of Ith is it scoped to one card.
   *
   * Carried on a continuous effect rather than built as a prevention subsystem, because everything
   * such an effect needs already exists here: a scope that can name one card or every creature, a
   * duration, an expiry pass, and a source. The engine applies it in exactly one place —
   * `dealCombatDamage` — which is also what keeps the name honest.
   *
   * **Combat damage only, and deliberately so.** "Prevent the next 3 damage" is a different shape:
   * a shield with a quantity that is spent, which has to survive partial use and interact with
   * every source of damage rather than one. Nothing in this pool needs it, and a flag that claimed
   * to prevent damage in general while only covering combat would be worse than one that says what
   * it does.
   */
  readonly preventsCombatDamage?: boolean;
  /**
   * "~ **assigns no combat damage** this turn" (D578) — the one-directional half of the flag above.
   *
   * `preventsCombatDamage` answers for damage dealt **by and to** a creature, which is a Fog. This
   * is only the first half and is not prevention at all: the creature assigns none (CR 510.1), so
   * nothing is dealt, nothing is there to prevent, and a blocker in front of it still hits back.
   * 26 legal cards print the phrase — Ophidian, the Laccoliths, Master of Cruelties — and reading
   * it as a Fog would make each of them unkillable in the combat it is declining to fight.
   */
  readonly assignsNoCombatDamage?: boolean;
  /**
   * "If that creature would die this turn, **exile it instead**" (CR 614.1, D539).
   *
   * The first field here that is not a characteristic and is not read by `effectApplies`. Every
   * other member of this interface answers "what is this permanent like"; this one answers "what
   * happens instead when it dies", which is a replacement effect — so the reader is
   * `replaceZoneChange` in `automation.ts`, and the layer passes never see it at all.
   *
   * It lives on a `ContinuousEffect` rather than on the dying permanent's own `CardScript.replaces`
   * because **the spell that creates it is not a permanent**. Bleed Dry resolves and goes to the
   * graveyard; the thing that must still be there when the creature dies two combat steps later is
   * a floating effect with a duration, which is exactly what this list is for. A flag on the
   * instance would have worked too and would have needed its own line in `endTurnCleanup`, where
   * this expires for free.
   *
   * **Only the `cards` scope is honoured.** The printed sentences this reads name their subject
   * through a referent — "that creature", "it" — so the effect covers the objects the clause
   * borrowed and nothing else. "If **a** creature would die this turn, exile it instead" (Flaying
   * Tendrils, 2 printings) wants every creature *including ones that arrive later*, and the
   * engine's until-end-of-turn scopes are snapshotted on purpose (CR 611.2c, #280): `pumpAll`
   * refuses to leave a board-wide effect unresolved for exactly that reason. A live board-wide
   * scope is its own question, so that row stays unread rather than half-read.
   */
  readonly exiledInsteadOfDying?: boolean;
  /**
   * A shield with a quantity: "prevent the next N damage that would be dealt to <this> this turn"
   * (CR 615.1), where N is what is **left** of it.
   *
   * The shape `preventsCombatDamage` deliberately refused, and the three differences are the whole
   * of it. It is **spent**: each damage event takes what it needs and the remainder stays, so the
   * effect is rewritten rather than only read, and it is removed when it reaches zero rather than
   * when the turn ends. It covers **every** source of damage, not only combat, because that is
   * what the cards say — a Samite Healer answers a Lightning Bolt. And its target can be a
   * **player**, which is why the scope union now has a seat in it.
   *
   * Applied in `dealDamage`, which is the single place damage is ever marked or lost, and applied
   * *before* anything is marked: prevention is not something that can be undone afterwards, and
   * damage that is wholly prevented must also not gain life for a lifelink source or mark a
   * creature deathtouched, because none of it was dealt.
   */
  readonly preventsDamageAmount?: number;
  /**
   * Where the damage this shield absorbs is **dealt instead** (CR 615.9) — redirection.
   *
   * The last member of the replacement-effect family the engine had neither built nor approximated,
   * and it turned out to be the shield plus one field rather than a subsystem: "the next 2 damage
   * that would be dealt to you is dealt to target creature instead" is "prevent 2" and "deal what
   * was prevented over there". So `preventsDamageAmount` is still what is spent and still what the
   * table shows; this says what happens to the points it took.
   *
   * A `Target` fixed when the effect is created, which is what the two cards in the pool say: both
   * choose the creature or player as they are cast. A redirect whose destination is *computed* when
   * the damage happens — "deals that much damage to that source's controller" — is a different
   * shape and no card here asks for it.
   *
   * The redirected damage is a new damage event from the **same source**, so protection, infect and
   * lifelink all apply to it again; `dealDamage` recurses to get that for free, with a depth guard
   * for a redirect pointed at something that redirects.
   */
  readonly redirectTo?: Target;
  /**
   * Power and toughness **set** to these, rather than added to: layer 7b (CR 613.4c).
   *
   * The difference from `power`/`toughness` is the whole of why this engine needed layers at all.
   * A +3/+3 and a -1/-1 can be summed in any order and come to the same answer; "becomes 1/1"
   * cannot be summed with anything — it replaces the base, and every modification applies *after*
   * it however early it was cast. A Giant Growth cast before a Turn to Frog leaves a 4/4, not a
   * 1/1, and that is not a quirk: setting is layer 7b and modifying is 7c, and the layers run in
   * order regardless of timestamps.
   *
   * Two settings on one creature resolve by timestamp, last one wins, which `characteristicsOf`
   * gets for free by reading `state.effects` in the order they were created.
   */
  readonly setPower?: number;
  readonly setToughness?: number;
  /**
   * "Loses all abilities": layer 6 (CR 613.1f), and the one layer where timestamps are the rule
   * rather than a tie-break.
   *
   * An ability granted *before* this effect is gone; one granted *after* it survives. That is why
   * abilities are accumulated in effect order and this clears what has been collected so far
   * rather than setting a flag read at the end — the order of the list is the timestamp order, so
   * the rule falls out of the loop instead of needing a second pass.
   *
   * Printed keywords go too, which is what makes a Turn to Frog answer a flier.
   */
  readonly losesAllAbilities?: boolean;
  /**
   * Card types this effect adds: layer 4 (CR 613.1c). "Becomes a creature", and nothing yet takes
   * a type away.
   *
   * Applied in a pass of its own before anything else, because what a permanent *is* decides which
   * later effects apply to it: an animated land is a creature, so an anthem that pumps "creatures
   * you control" pumps it (CR 613.1c runs before 613.1g).
   */
  readonly addTypes?: readonly string[];
  /** Subtypes this effect adds, for the same layer. */
  readonly addSubtypes?: readonly string[];
  /**
   * "Becomes a blue **Frog**" (D577): the creature types this effect leaves the permanent with,
   * replacing the ones it had. Same layer. A subtype that is not a creature type — an Equipment
   * that is also a creature keeps being an Equipment — is left alone.
   */
  readonly setCreatureTypes?: readonly string[];
  /**
   * "…becomes a 2/2 creature **with all creature types**" (D577), which is Mutavault's.
   *
   * A flag and not three hundred entries in `addSubtypes`: an effect is game state, the state is
   * sent over the wire, and a list of every creature type on one animated land is most of a
   * kilobyte per activation. And not the changeling keyword either — that is an ability, so a
   * creature that loses all abilities loses it, where a type-changing effect does not care.
   */
  readonly allCreatureTypes?: boolean;
  /**
   * A characteristic-defining ability: layer 7a (CR 613.4a), and the one layer whose answer is a
   * fact about the board rather than a number somebody wrote down.
   *
   * "Lhurgoyf's power is equal to the number of creature cards in all graveyards and its toughness
   * is equal to that plus 1" — so it shrinks when a graveyard is exiled and grows when anything
   * dies, with no event anywhere and nothing to recompute. That is why it is a `count` to perform
   * rather than a closure to call: `GameState` is stored in Redis and sent over a socket, so an
   * effect carrying a function would be an effect that cannot be saved. The engine owns the
   * counting; the card says which count it is.
   *
   * It defines the *base*, so layer 7b still beats it (a Turn to Frog on a Lhurgoyf is a 1/1) and
   * 7c and 7d still land on top (a Giant Growth makes it three bigger than whatever it is).
   */
  /**
   * A condition the whole effect depends on, asked **every time** the effect is read.
   *
   * Every other continuous effect here is on or off for a duration: it is created, it applies, and
   * it expires. Metalcraft is a different shape — "as long as you control three or more artifacts"
   * — and the difference is that there is no moment at which it turns on. The board changes and the
   * creature is a 4/4; something dies and it is a 2/2 again, with nothing to announce and no
   * trigger to see. So this is asked in `effectApplies` rather than stored, which is the same thing
   * `definesSize` does one field below and for the same reason.
   *
   * **Data rather than a predicate**, which is not a style choice: `state.effects` is part of the
   * game state and the state is serialised to Redis, so a function here would not survive the trip.
   * One kind per card shape, and the second one arrived with monstrosity: a Fleecemane Lion has
   * hexproof and indestructible *while it is monstrous*, and "monstrous" is a +1/+1 counter on the
   * creature itself rather than a count of the board (D182).
   */
  readonly while?:
    | {
        /**
         * "As long as two or more Equipment are attached to it" (D577) — Balan's double strike.
         * Counted off what is attached to the effect's own **source**, by printed type line, for
         * the reason `controller-artifacts` gives: this is asked inside `characteristicsOf`.
         */
        readonly kind: 'source-equipment';
        readonly atLeast: number;
      }
    | {
        readonly kind: 'controller-artifacts';
        /** "three or more", which is what every metalcraft card printed says. */
        readonly atLeast: number;
      }
    | {
        /**
         * "As long as this creature is monstrous" — read off the effect's own **source**, which is
         * what makes it different from every other condition here: the question is about one
         * permanent rather than about a player's board, so a Fleecemane Lion that has been
         * answered and recast is not monstrous again until it is paid for again.
         */
        readonly kind: 'source-has-counter';
        readonly counter: string;
        readonly atLeast: number;
      }
    | {
        /**
         * "As long as there are seven or more cards in your graveyard" — threshold (D502).
         *
         * The third kind, and the first that counts a **zone** rather than a battlefield or a
         * permanent's counters. That makes it the cheapest of the three to answer honestly: the
         * metalcraft count above has to read the *printed* type line, because it runs inside
         * `characteristicsOf` and asking for a live type line would re-enter the whole computation.
         * A graveyard count reads a list of ids and nothing else, so it has no such gap and the
         * number it gives is simply correct.
         *
         * "Your" is the effect's own `controller`, as everywhere else here — a threshold creature
         * stolen by its opponent counts *their* graveyard, which is what the card says.
         */
        readonly kind: 'controller-graveyard';
        /** "seven or more", which is what every threshold card printed says. */
        readonly atLeast: number;
        /**
         * Descend (D612): "four or more **permanent** cards in your graveyard" — cards whose printed
         * type line has a permanent type. Absent counts every card, which is threshold.
         */
        readonly permanents?: true;
      }
    /*
      The general "as long as" family (D604/D605), each answered without a live characteristic: a
      zone's printed cards, the source instance's own facts, the combat record, a life total, a hand,
      whose turn it is, or a printed type line on the battlefield (metalcraft's compromise).
    */
    /** Delirium: "N or more card types among cards in your graveyard" (CR 207.2c types only). */
    | { readonly kind: 'graveyard-card-types'; readonly atLeast: number }
    /** "As long as ~ is untapped / tapped". */
    | { readonly kind: 'source-tapped'; readonly tapped: boolean }
    /** "As long as it's attacking". */
    | { readonly kind: 'source-attacking' }
    /** "As long as ~ is enchanted": Auras attached to the source. */
    | { readonly kind: 'source-auras'; readonly atLeast: number }
    /** Hellbent and its cousins: "you have no cards in hand", "N or more cards in hand". */
    | { readonly kind: 'controller-hand'; readonly atLeast?: number; readonly atMost?: number }
    /** "You control a Plains", "… a Gate": a printed subtype among your permanents. */
    | { readonly kind: 'controller-subtype'; readonly subtype: string; readonly atLeast: number }
    /** "You have N or more life". */
    | { readonly kind: 'controller-life'; readonly atLeast: number }
    /** "It's your turn" / "it's not your turn". */
    | { readonly kind: 'turn'; readonly yours: boolean };
  /**
   * A size that is a **count times a rate**: layer 7c, `~ gets +1/+1 for each Equipment you
   * control` (D523).
   *
   * The sibling of `definesSize` and deliberately not a case of it. `definesSize` is layer 7a and
   * *sets* a base — a Lhurgoyf **is** the creature cards in all graveyards — while this *adds* to
   * whatever the base turns out to be, which is layer 7c (CR 613.4c). Folding the two together
   * would make Adelbert Steiner a 1/1 whose printed 3/3 had been thrown away.
   *
   * **Data rather than a function**, for `while`'s reason one field above: `state.effects` is part
   * of the game state and the state is serialised to Redis, so a closure here would not survive
   * the trip. That is the whole reason the temporary half of this family (D522) is reader work and
   * this half is engine work — a pump computes its number once, as the effect is created
   * (CR 611.2c), and has nothing to serialise.
   *
   * ## What it may count, and the constraint that decides the list
   *
   * `staticCount` answers these **without** asking any permanent for its live characteristics, and
   * that is not a style choice: this is read from inside `characteristicsOf`, so a live read would
   * re-enter the whole computation for every other conditional effect on the board, and two
   * effects that read each other's types would not terminate. The same constraint shapes
   * metalcraft's count one field above, and the cost is the same one, stated rather than hidden: a
   * permanent whose type or subtype comes from a continuous effect is not counted. A changeling
   * (D506) is not seen by a tribal count here, and a crewed Vehicle is not seen as a creature.
   * `countOfThing` in `scripts.ts` has no such limit, because it runs while an effect resolves —
   * so the *same printed phrase* is counted live in a one-shot clause and printed in a static one.
   * That difference is real and is tested, not argued.
   */
  readonly sizePerCount?: {
    readonly of: StaticCountable;
    /** Added to power per thing counted. `+1/+1 for each` is 1 and 1; `+2/+0` is 2 and 0. */
    readonly power: number;
    readonly toughness: number;
  };
  readonly definesSize?: {
    /**
     * One count, because one card needs one count. "Cards in your hand", "lands you control" and
     * the rest are each a line in `cdaCount` and a card away — and a clause with no card behind it
     * is a clause nothing has ever run (D57), so they are named here rather than written.
     */
    readonly count:
      | 'creature-cards-in-graveyards'
      | 'instant-and-sorcery-cards-in-your-graveyard';
    /**
     * Which of the two the count defines. `both` is a Lhurgoyf, whose power and toughness are both
     * the count; `power` is the Drake printed with a star for power and a 4 for toughness, where
     * only the power is counted. Defaulting to `both` leaves the card that shipped first unchanged.
     */
    readonly applies?: 'both' | 'power';
    readonly powerPlus?: number;
    readonly toughnessPlus?: number;
  };
  /**
   * The colours this permanent becomes: layer 5 (CR 613.1d).
   *
   * Setting rather than adding, because that is what the cards say — "becomes red" *replaces* the
   * printed colours (CR 105.3), while "is also red" would add to them and nothing in the pool does.
   * Last one wins, like layer 7b.
   */
  readonly setColors?: readonly Color[];
  readonly duration: EffectDuration;
  readonly createdTurn: number;
  /**
   * Set by a temporary control-change effect (Act of Treason and friends): the seat the permanent
   * goes back to when the effect ends. Control is a move between battlefields rather than a
   * modification, so it cannot be expressed as a power or keyword change — the turn logic reads
   * this when the effect expires and moves the permanent home.
   */
  readonly controlRevertTo?: SeatIndex;
}

export interface Characteristics {
  readonly name: string;
  readonly typeLine: TypeLine;
  readonly colors: readonly Color[];
  readonly power: number;
  readonly toughness: number;
  readonly keywords: ReadonlySet<Keyword>;
  readonly isCreature: boolean;
  readonly isLand: boolean;
  readonly cantAttack: boolean;
  readonly cantBlock: boolean;
  /** "Doesn't untap during its controller's untap step". See `ContinuousEffect.doesntUntap`. */
  readonly doesntUntap: boolean;
  /** "Attacks each combat if able" (CR 508.1d). Checked against the whole declaration. */
  readonly mustAttack: boolean;
  /** "Can't be blocked by Walls", read from the attacker when a block is offered. */
  readonly cantBeBlockedByWalls: boolean;
  /** "Can't be blocked" outright, read from the attacker when a block is offered. */
  readonly cantBeBlocked: boolean;
  /**
   * Printed bans on who may block this creature: a blocker answering **any** of these may not.
   *
   * "~ can't be blocked by creatures with power 2 or less", "~ can't be blocked by artifact
   * creatures and/or white creatures". See `printedBlockerLimit` for the family and for why the ban
   * and the allow list below are two fields rather than one (D498).
   */
  readonly cantBeBlockedBy: readonly BlockerClause[];
  /**
   * A printed allow list: a blocker must answer **at least one** of these, or it may not block.
   *
   * "~ can't be blocked except by creatures with flying or reach". `null` when the card prints no
   * such sentence, which is not the same as an empty list — an empty list would mean nothing at all
   * may block it, and that is `cantBeBlocked`'s job.
   */
  readonly blockableOnlyBy: readonly BlockerClause[] | null;
  /**
   * Printed bans on what this creature may block: it may not block an attacker answering **any**
   * of these.
   *
   * "~ can't block creatures with power 3 or greater". The mirror of `cantBeBlockedBy` above and
   * deliberately not the same field — one is about who may block *it*, this is about what *it* may
   * block, and `canBlock` reads the first off the attacker and this off the blocker. See
   * `printedBlocksLimit` (D500).
   */
  readonly cantBlockThese: readonly BlockerClause[];
  /**
   * A printed allow list on what this creature may block: the attacker must answer **at least one**
   * of these.
   *
   * "~ can block only creatures with flying", which is most of this family. `null` when the card
   * prints no such sentence; an empty list would mean it may block nothing at all, and that is
   * `cantBlock`'s job.
   */
  readonly blocksOnly: readonly BlockerClause[] | null;
  /** Landwalk subtypes, checked against the *defending* player's lands (CR 702.14). */
  readonly landwalk: readonly string[];
  /** Protection from these colours (CR 702.16). Empty for almost everything. */
  readonly protectionFrom: readonly Color[];
  /** And from these qualities that are not colours (D596). See `protectionQuality`. */
  readonly protectionQualities: readonly string[];
  /**
   * Total toxic value (CR 702.164b): the poison counters a player gets, on top of the damage, for
   * being dealt combat damage by this creature. 0 for almost everything. See `printedToxic`.
   */
  readonly toxic: number;
  /**
   * The seats that have goaded this creature: the controllers of every `mustAttackAnotherPlayer`
   * effect applying to it.
   *
   * A list rather than a flag because the rule is about *who* — "a player other than you" is a
   * different demand from each goader, and the answer to "may this attack seat 2" depends on which
   * of them did it. `attackAimIssue` is the only thing that should read it.
   */
  readonly goadedBy: readonly SeatIndex[];
}

/** Shared empties, so the common case allocates nothing at all. */
const NO_SEATS: readonly SeatIndex[] = Object.freeze([]);
/** Shared empty list, so a creature with no landwalk allocates nothing. */
const NO_SUBTYPES: readonly string[] = Object.freeze([]);
const NO_COLORS: readonly Color[] = Object.freeze([]);

const numeric = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `typeLine` is passed separately from `creature` rather than derived from it, because `creature`
 * is computed once per `characteristicsOf` call and this runs once per effect: re-deriving it here
 * would put a type-line scan on the hottest loop in the engine for the sake of one scope that
 * almost nothing uses.
 */
/**
 * Whether a conditional effect's condition holds right now.
 *
 * Counted off the **printed** type line, which is load-bearing rather than lazy: this is called
 * from inside `characteristicsOf`, so asking for a permanent's current characteristics here would
 * recurse until the stack ran out. Nothing in the pool gives something the artifact type, so the
 * printed line and the current one are the same answer for every board that exists — and a card
 * that changed that would need this count to be computed in a pass of its own, like layer 4 is.
 */
/**
 * A static's condition asked on its own (D607), for a trigger's intervening "if": the same answer
 * `conditionMet` gives a continuous effect with this source and controller.
 */
export function conditionHolds(
  state: GameState, cond: NonNullable<ContinuousEffect['while']>, controller: SeatIndex, source: string,
): boolean {
  return conditionMet(state, {
    id: '', source, controller, scope: { kind: 'cards', ids: [] }, while: cond,
  } as unknown as ContinuousEffect);
}

function conditionMet(state: GameState, effect: ContinuousEffect): boolean {
  const cond = effect.while;
  if (cond === undefined) return true;
  /*
    A condition about the effect's own source, which is the whole of monstrosity's second half.

    Read live like the artifact count below and for the same reason: there is no moment at which it
    turns on that anything could announce. The counter is put on by an ability, and from then on the
    static applies because the counter is there — nothing stores the fact of being monstrous.
  */
  /*
    One correction to that, about the artifact count below: it reads the **printed** type line, not
    the live one, and that is deliberate rather than an oversight — this function is called from
    inside `characteristicsOf`, so asking for a permanent's live type line here would re-enter the
    whole computation for every other conditional effect on the board, and two conditional effects
    that read each other's types would not terminate.
    
    The cost is a real rules gap, stated rather than hidden: a permanent that a continuous effect has
    *made* an artifact does not turn metalcraft on, where the rules say it should (CR 702.105a).
    Nothing in this pool can make one, so nothing observes it. `artifactsControlled` in `scripts.ts`
    — Galvanic Blast's count — runs while a spell resolves rather than inside this computation, so
    it reads live and is not subject to this.
  */
  if (cond.kind === 'source-has-counter') {
    const source = state.instances[effect.source];
    return source !== undefined && (source.counters[cond.counter] ?? 0) >= cond.atLeast;
  }
  /*
    Threshold, and the one condition here that is a plain length (D502). No face-down rule to apply
    and no type line to read, so none of the caveat above about printed types reaches it: a card in
    a graveyard is a card in a graveyard.
  */
  if (cond.kind === 'controller-graveyard') {
    const cards = state.zones[zoneKey(effect.controller, 'graveyard')] ?? [];
    if (cond.permanents !== true) return cards.length >= cond.atLeast;
    return cards.filter((id) => isPermanentCard(state.cardDefs[state.instances[id]?.defKey ?? '']?.typeLine)).length >= cond.atLeast;
  }
  // The general family (D605): see the union.
  if (cond.kind === 'graveyard-card-types') {
    const seen = new Set<string>();
    for (const id of state.zones[zoneKey(effect.controller, 'graveyard')] ?? []) {
      const inst = state.instances[id];
      if (inst === undefined) continue;
      for (const type of parseTypeLine(state.cardDefs[inst.defKey]?.typeLine).types) seen.add(type.toLowerCase());
    }
    return seen.size >= cond.atLeast;
  }
  if (cond.kind === 'source-tapped') {
    const source = state.instances[effect.source];
    return source !== undefined && source.zone === 'battlefield' && source.tapped === cond.tapped;
  }
  if (cond.kind === 'source-attacking') {
    return state.combat.attacks.some(({ attacker }) => attacker === effect.source);
  }
  if (cond.kind === 'source-auras') {
    let attached = 0;
    for (const inst of Object.values(state.instances)) {
      if (inst.attachedTo !== effect.source || inst.zone !== 'battlefield') continue;
      if (hasSubtype(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), 'Aura')) attached += 1;
    }
    return attached >= cond.atLeast;
  }
  if (cond.kind === 'controller-hand') {
    const held = (state.zones[zoneKey(effect.controller, 'hand')] ?? []).length;
    return held >= (cond.atLeast ?? 0) && held <= (cond.atMost ?? Infinity);
  }
  if (cond.kind === 'controller-subtype') {
    let n = 0;
    for (const id of state.zones[zoneKey(effect.controller, 'battlefield')] ?? []) {
      const inst = state.instances[id];
      if (inst === undefined || isFaceDownPermanent(inst)) continue;
      if (hasSubtype(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), cond.subtype)) n += 1;
    }
    return n >= cond.atLeast;
  }
  if (cond.kind === 'controller-life') {
    return (state.seats[effect.controller]?.life ?? 0) >= cond.atLeast;
  }
  if (cond.kind === 'turn') {
    return (state.activeSeat === effect.controller) === cond.yours;
  }
  // Equipment attached to the source, whoever controls it: the sentence says "attached to it".
  if (cond.kind === 'source-equipment') {
    let attached = 0;
    for (const inst of Object.values(state.instances)) {
      if (inst.attachedTo !== effect.source || inst.zone !== 'battlefield') continue;
      if (hasSubtype(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), 'Equipment')) attached += 1;
    }
    return attached >= cond.atLeast;
  }
  let count = 0;
  for (const id of state.zones[zoneKey(effect.controller, 'battlefield')] ?? []) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    // A face-down permanent is a 2/2 creature with no text, and no artifact (CR 707.2).
    if (isFaceDownPermanent(inst)) continue;
    if (hasType(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), 'artifact')) count += 1;
  }
  return count >= cond.atLeast;
}

function effectApplies(
  state: GameState, effect: ContinuousEffect, instance: CardInstance,
  creature: boolean, typeLine: TypeLine,
): boolean {
  // The condition first, because it is about the whole effect rather than about who it reaches: an
  // effect whose condition is not met applies to nothing at all.
  if (!conditionMet(state, effect)) return false;
  switch (effect.scope.kind) {
    case 'cards':
      return effect.scope.ids.includes(instance.id);
    case 'controller-creatures':
      return creature && instance.zoneSeat === effect.controller;
    case 'other-controller-creatures':
      return creature && instance.zoneSeat === effect.controller && instance.id !== effect.source;
    case 'controller-subtype':
      return creature && instance.zoneSeat === effect.controller
        && !(effect.scope.other === true && instance.id === effect.source)
        && hasSubtype(typeLine, effect.scope.subtype);
    case 'all-creatures':
      return creature;
    /*
      A pair reaches its two members and nobody else, and the source has to still be there.

      Read live, which is the point of the scope: unpaired, `pairedWith` is absent and this is
      false for everything, so the static is off without anybody having removed it.
    */
    case 'pair': {
      const source = state.instances[effect.source];
      if (source === undefined || source.zone !== 'battlefield') return false;
      if (source.pairedWith === undefined) return false;
      return instance.id === effect.source || instance.id === source.pairedWith;
    }
    // A seat scope is about the player, not their permanents: nothing on the battlefield is in it.
    case 'seat':
      return false;
    /*
      And a side scope reaches permanents, but only for *damage*: it carries a prevention quantity
      and nothing else, so there is no characteristic here for it to modify. Said out loud rather
      than left to the default, for the reason `seat` is.
    */
    case 'seat-side':
      return false;
    default:
      return false;
  }
}

/**
 * What a characteristic-defining ability counts, right now.
 *
 * Counted on every read, which is what makes it a CDA rather than an effect: there is no moment at
 * which the number is decided, so there is nothing to store and nothing to invalidate.
 */
/**
 * What a static counted size may count, as data.
 *
 * Named rather than written as a vocabulary, which is `definesSize`'s discipline and D57's rule: a
 * count with no card behind it is a count nothing has ever run. Every row here is a phrase the
 * corpus prints on a static size, measured over the legal pool — zone counts first (13 cards), then
 * the battlefield counts that a printed type line can answer (27).
 */
export type StaticCountable =
  | { readonly kind: 'cards-in-hand' }
  | { readonly kind: 'cards-in-graveyard' }
  | { readonly kind: 'creature-cards-in-graveyard' }
  | { readonly kind: 'creature-cards-in-all-graveyards' }
  | { readonly kind: 'instants-and-sorceries-in-graveyard' }
  | { readonly kind: 'artifacts-you-control' }
  | { readonly kind: 'counters-on-self'; readonly counter: string }
  | { readonly kind: 'permanents-of-subtype'; readonly subtype: string }
  /**
   * "for each enchantment you control", "… artifact and/or enchantment you control", "… land on the
   * battlefield" (D604): permanents with any of `types` on their printed type line, yours or
   * everybody's. Printed for the reason `artifacts-you-control` is (see `sizePerCount`), and never
   * "creature", which D523 refuses for the reason given there.
   */
  | { readonly kind: 'permanents-of-type'; readonly types: readonly string[]; readonly whose: 'you' | 'all' };

/**
 * A static counted size's count, answered without reading any permanent's live characteristics.
 *
 * See `ContinuousEffect.sizePerCount` for why that restriction exists and what it costs. Each row
 * reads one of three things, and none of them re-enters `characteristicsOf`:
 *
 * - a **zone's** cards, through `cardDefs`, which is printed data. A card in a hand or a graveyard
 *   has no continuous effects on it, so its printed type line *is* what it is.
 * - the source's own **counters**, which are instance data rather than a characteristic.
 * - a battlefield permanent's **printed** type line, which is metalcraft's compromise.
 */
function staticCount(
  state: GameState,
  of: StaticCountable,
  controller: SeatIndex,
  source: string,
): number {
  const inZone = (seat: SeatIndex, zone: 'hand' | 'graveyard') =>
    state.zones[zoneKey(seat, zone)] ?? [];
  const typed = (seat: SeatIndex, zone: 'hand' | 'graveyard', wanted: readonly string[]) => {
    let n = 0;
    for (const id of inZone(seat, zone)) {
      const inst = state.instances[id];
      if (inst === undefined) continue;
      const line = parseTypeLine(state.cardDefs[inst.defKey]?.typeLine);
      if (wanted.some((type) => hasType(line, type))) n += 1;
    }
    return n;
  };

  switch (of.kind) {
    case 'cards-in-hand':
      return inZone(controller, 'hand').length;
    case 'cards-in-graveyard':
      return inZone(controller, 'graveyard').length;
    case 'creature-cards-in-graveyard':
      return typed(controller, 'graveyard', ['creature']);
    case 'creature-cards-in-all-graveyards':
      return state.seats.reduce(
        (total, seat) => total + typed(seat.index, 'graveyard', ['creature']), 0,
      );
    case 'instants-and-sorceries-in-graveyard':
      return typed(controller, 'graveyard', ['instant', 'sorcery']);
    case 'counters-on-self':
      return state.instances[source]?.counters[of.counter] ?? 0;
    /*
      The two that read the battlefield, and the two that pay metalcraft's price. `parseTypeLine` on
      the **printed** line, never `characteristicsOf` — see `sizePerCount`.
    */
    case 'artifacts-you-control': {
      let n = 0;
      for (const id of state.zones[zoneKey(controller, 'battlefield')] ?? []) {
        const inst = state.instances[id];
        if (inst === undefined) continue;
        if (hasType(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), 'artifact')) n += 1;
      }
      return n;
    }
    case 'permanents-of-type': {
      let n = 0;
      const seats = of.whose === 'you' ? [controller] : state.seats.map((seat) => seat.index);
      for (const seat of seats) {
        for (const id of state.zones[zoneKey(seat, 'battlefield')] ?? []) {
          const inst = state.instances[id];
          if (inst === undefined) continue;
          const line = parseTypeLine(state.cardDefs[inst.defKey]?.typeLine);
          if (of.types.some((type) => hasType(line, type))) n += 1;
        }
      }
      return n;
    }
    case 'permanents-of-subtype': {
      let n = 0;
      const wanted = of.subtype.toLowerCase();
      for (const id of state.zones[zoneKey(controller, 'battlefield')] ?? []) {
        const inst = state.instances[id];
        if (inst === undefined) continue;
        if (hasSubtype(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), wanted)) n += 1;
      }
      return n;
    }
    default:
      return 0;
  }
}

function cdaCount(
  state: GameState,
  kind: NonNullable<ContinuousEffect['definesSize']>['count'],
  controller: SeatIndex,
): number {
  // Whose graveyards are counted is part of what the card says, so it is read off the kind rather
  // than passed in: "in all graveyards" and "in your graveyard" are two different counts, and a
  // card that said one while the engine performed the other would be wrong in the quiet way.
  const seats = kind === 'instant-and-sorcery-cards-in-your-graveyard'
    ? [controller]
    : state.seats.map((row) => row.index);
  let total = 0;
  for (const seat of seats) {
    for (const id of state.zones[zoneKey(seat, 'graveyard')] ?? []) {
      const inst = state.instances[id];
      if (inst === undefined) continue;
      const line = parseTypeLine(state.cardDefs[inst.defKey]?.typeLine);
      const counts = kind === 'creature-cards-in-graveyards'
        ? hasType(line, 'creature')
        : hasType(line, 'instant') || hasType(line, 'sorcery');
      if (counts) total += 1;
    }
  }
  return total;
}

/**
 * The type line with layer 4 applied, or the printed one when nothing changes it.
 *
 * Returns the *same object* when no effect adds a type, which is the common case by a very long
 * way: this runs on the hottest path in the engine, and a type line rebuilt on every call would be
 * two array copies per permanent per candidate per playout.
 */
function withAddedTypes(
  state: GameState, instance: CardInstance, printed: TypeLine, printedCreature: boolean,
): TypeLine {
  let types: string[] | null = null;
  // The subtypes as they stand so far, or `null` while nothing has touched the printed ones.
  let subtypes: string[] | null = null;
  const add = (sub: string): void => {
    if ((subtypes ?? printed.subtypes).includes(sub)) return;
    subtypes = [...(subtypes ?? printed.subtypes), sub];
  };
  for (const effect of state.effects ?? []) {
    if (effect.addTypes === undefined && effect.addSubtypes === undefined
      && effect.setCreatureTypes === undefined && effect.allCreatureTypes !== true) continue;
    if (silenced(state, effect.source)) continue;
    if (!effectApplies(state, effect, instance, printedCreature, printed)) continue;
    for (const type of effect.addTypes ?? []) {
      if (hasType(printed, type) || (types !== null && types.includes(type))) continue;
      types = [...(types ?? []), type];
    }
    /*
      "Becomes a Frog" (D577): the creature types go and these replace them. In effect order, which
      is timestamp order (CR 613.7), so a type added by an earlier effect is replaced too and one
      added later lands on top.
    */
    if (effect.setCreatureTypes !== undefined) {
      subtypes = [
        ...(subtypes ?? printed.subtypes).filter((sub) => !isCreatureType(sub)),
        ...effect.setCreatureTypes,
      ];
    }
    for (const sub of effect.addSubtypes ?? []) add(sub);
    if (effect.allCreatureTypes === true) for (const sub of CREATURE_TYPES) add(sub);
  }
  if (types === null && subtypes === null) return printed;
  return {
    supertypes: printed.supertypes,
    types: types === null ? printed.types : [...printed.types, ...types],
    subtypes: subtypes ?? printed.subtypes,
  };
}

/**
 * What a face-down permanent is, instead of what its card says (CR 707.2).
 *
 * A 2/2 creature with no name, no mana cost, no creature types and no abilities, whether it is on
 * the battlefield or still a spell on the stack (CR 707.4). Substituted for the card at the top of
 * `characteristicsOf` rather than special-cased through it, so every layer
 * below applies to *this* instead: a Giant Growth on a face-down creature still makes it a 5/5, a
 * +1/+1 counter still makes it a 3/3, and an anthem still lifts it, which is the rule.
 *
 * The bug this fixes was visible from both sides of a table. Any player may turn a permanent face
 * down, and `viewFor` has always hidden its identity from everybody else — but nothing hid it from
 * the *rules*, so a face-down Hill Giant was a card the opponent could not see and a 3/3 that
 * fought like a Hill Giant. Two players looking at one board with different facts.
 */
const FACE_DOWN: CardDef = Object.freeze({
  name: 'a face-down creature',
  typeLine: 'Creature',
  manaCost: '',
  cmc: 0,
  power: '2',
  toughness: '2',
  oracleText: '',
  colors: [],
});

/**
 * Whether a continuous effect's source has been turned face down, and so has no abilities to grant.
 *
 * A face-down permanent has no abilities at all (CR 707.2), including the static ones it was
 * handing out while it was face up: turn a Glorious Anthem face down and the team shrinks. Checked
 * where each effect is read rather than by removing the effect when the card is turned over —
 * "detect, don't announce" — because a permanent turned back face up has its abilities again, and
 * an effect that was deleted could not come back.
 *
 * One lookup rather than a filtered copy of `state.effects`: `characteristicsOf` runs on every
 * read of every permanent, and the comments in it about allocating nothing mean it.
 */
function silenced(state: GameState, source: string | undefined): boolean {
  if (source === undefined) return false;
  const inst = state.instances[source];
  return inst !== undefined && isFaceDownPermanent(inst);
}

/**
 * Changeling, applied as part of layer 4: every creature type, written into the subtype list
 * rather than carried as a flag (CR 702.73a, CR 604.3, D506).
 *
 * **One place, and that is the whole design.** Subtype matching is spread over eighteen call sites
 * — `clauseMatches`'s Wall and Wizard clauses, the `controller-subtype` effect scope that every
 * tribal lord uses, `canBlock`'s Wall clause, three counts in `scripts.ts`, two filter builders
 * that receive only a `TypeLine` and could never see a flag. Extending the list here answers all
 * of them at once and changes none of them.
 *
 * **Inside layer 4, not after the effects loop**, and the first attempt had it in the wrong place
 * for a reason worth keeping: changeling is a characteristic-defining ability, so it is applied
 * with the other type-changing effects (CR 613.1d) — and *every later layer's scope is judged
 * against the result*. Written after the loop instead, the extended line was handed to callers and
 * invisible to the one reader that matters most: an Imperious Perfect did not pump a changeling,
 * because the lord's scope had already been matched against a bare Shapeshifter. The runtime test
 * for the lord is what said so; nothing in the reader could have.
 *
 * **Read off the printed text, with a "loses all abilities" pre-scan**, because a frogged
 * changeling is a Shapeshifter again. Layer 6 is *after* layer 4, so that is CR 613.8 dependency
 * rather than plain layer order: the type-changing application depends on the ability still being
 * there, so it is applied after the removal and sees it. Judging the scan against the
 * pre-changeling line is the same simplification `withAddedTypes` already documents for its own
 * scopes, and it costs nothing in practice — no printing in the corpus *grants* changeling to
 * another creature. The two that come close (Moritte of the Frost, Omni-Changeling) copy a
 * permanent and add it to the copy, which is layer 1 and arrives here as a printed keyword.
 *
 * **Only when the object is a creature.** A changeling card is every creature type in every zone
 * (CR 702.73a), but the only question this engine asks of a noncreature object is about artifact
 * and enchantment subtypes, and those are not creature types. See `CREATURE_TYPES` for what is in
 * the list and what is deliberately out.
 *
 * The printed subtypes stay at the front, so a Woodland Changeling still reads as a Shapeshifter
 * first; and `def.typeLine` is untouched, which is what the view sends to a player.
 */
function withChangeling(
  state: GameState, instance: CardInstance, line: TypeLine, def: CardDef | undefined,
): TypeLine {
  if (!hasType(line, 'creature')) return line;
  if (!printedKeywords(def?.oracleText).includes('changeling')) return line;
  const frogged = (state.effects ?? []).some(
    (effect) => effect.losesAllAbilities === true
      && !silenced(state, effect.source)
      && effectApplies(state, effect, instance, true, line),
  );
  if (frogged) return line;
  return {
    ...line,
    subtypes: [
      ...line.subtypes,
      ...CREATURE_TYPES.filter((type) => !line.subtypes.some(
        (printed) => printed.toLowerCase() === type.toLowerCase(),
      )),
    ],
  };
}

/**
 * What this permanent currently is.
 *
 * **The layers, in the order CR 613 runs them**, for the four this engine has cards for:
 *
 *  1. **copy** (613.1a) — not computed here at all. A copy is a copy of a *printed* card, so the
 *     engine makes one by pointing the instance at the copied card's definition: by the time this
 *     function runs there is nothing left to apply, and `scriptFor` finds the copied card's
 *     abilities for free. That is also why a token copy of a Fog Bank prevents damage.
 *  2. **type-changing** (613.1c) — "becomes a creature", in a pass of its own; see
 *     `withAddedTypes` for why it cannot share the loop below.
 *  3. **colour-changing** (613.1d) — "becomes red", replacing the printed colours, last one wins.
 *  4. **abilities** (613.1f) — keywords granted and removed, and "loses all abilities", which
 *     clears everything collected *before* it and lets later grants through. Accumulated in effect
 *     order, which is timestamp order, so the rule needs no second pass.
 *  5. **a defined size** (7a, 613.4a) — a characteristic-defining ability, which is a count of
 *     something on the table rather than a number: it changes when the board does, with no event
 *     and nothing to recompute. See `cdaCount`.
 *  6. **setting power and toughness** (7b, 613.4c) — replaces the printed base; two of them resolve
 *     last-one-wins.
 *  7. **modifying power and toughness** (7c) — every pump and anthem, summed, applied *after* any
 *     setting however early it was cast.
 *  8. **counters** (7d) — `+1/+1` and `-1/-1`, last of all.
 *
 * Type-changing (layer 4) and colour-changing (5) are in as well, and layer 4 is the reason this
 * function makes two passes rather than one: a permanent's types decide which *other* effects
 * apply to it, so "becomes a creature" has to be known before the scope of an anthem is judged.
 * Which is all of CR 613 that the cards in this pool need. What is not here is dependency ordering
 * between effects in the same layer (613.8), which no two cards in the pool argue about.
 */
/**
 * Which level band a permanent is in, or none (CR 711.3).
 *
 * Highest `from` that its level counters reach, so the bands may be written in printed order and
 * the last one needs no upper bound. No counters means no band: a leveler with none is the creature
 * its P/T line prints, which is also what the card says.
 *
 * Only on the battlefield. A leveler in a graveyard or on the stack is its printed self — level
 * counters are on a *permanent*, and a card elsewhere that still had some would otherwise be
 * counting them.
 */
function levelBandOf(def: CardDef | undefined, instance: CardInstance): LevelBand | undefined {
  const bands = def?.levelBands;
  if (bands === undefined || instance.zone !== 'battlefield') return undefined;
  const level = instance.counters['level'] ?? 0;
  if (level <= 0) return undefined;
  let best: LevelBand | undefined;
  for (const candidate of bands) {
    if (candidate.from > level) continue;
    if (best === undefined || candidate.from > best.from) best = candidate;
  }
  return best;
}

/**
 * Whether a **card** — not a permanent — has a creature subtype, changeling included.
 *
 * The printed-card twin of `hasSubtype`, and the thing D506 named and left. A card in a graveyard,
 * a hand or a library has no continuous effects applied to it, so its printed type line *is* what
 * it is (which is why `TargetSpec`'s `graveyard-*` kinds exist at all) — but changeling is not a
 * continuous effect. It is a characteristic-defining ability (CR 604.3), so it works in **every**
 * zone, and a Woodland Changeling card in a graveyard is a Spirit for soulshift.
 *
 * D506 extended the *live* type line inside layer 4 and recorded this hole in the same breath: at
 * the time nothing asked the question of a printed card, so the omission was correct only by
 * accident. Soulshift is the first thing that asks.
 *
 * **The general reader still cannot.** `cardWordMatch` in `scripts.ts` builds filters of the shape
 * `(line: TypeLine) => boolean` from a printed word, and a bare type line cannot carry a keyword —
 * so every compiled "target Spirit card" filter that goes through *that* path is still blind to a
 * changeling. Widening it means widening the signature at nineteen call sites, which is its own
 * change; this function is where that change will land, and the filters that can call it today do.
 */
export function cardHasSubtype(def: CardDef | undefined, subtype: string): boolean {
  const line = parseTypeLine(def?.typeLine);
  if (hasSubtype(line, subtype)) return true;
  return hasType(line, 'creature')
    && printedKeywords(def?.oracleText).includes('changeling')
    && isCreatureType(subtype);
}

export function characteristicsOf(state: GameState, instance: CardInstance): Characteristics {
  /*
    Face down matters on the battlefield and on the stack, and nowhere else. A card face down in
    exile is a card nobody can read, which is what `viewFor` is for; it has no characteristics to
    get wrong because nothing fights it, and treating it as a 2/2 creature there would make exile
    a battlefield.
  */
  /*
    And the face a split card or an adventurer was cast as, which is read in preference to the card
    itself (CR 708.4): a spell on the stack has the characteristics of only the half being cast.

    One line, and it is what makes the mechanic cost nothing anywhere else. "Counter target creature
    spell" hands a card id to a filter that asks for its characteristics, and with this it gets
    "Venture Deeper, Sorcery" for the adventure half and "Merfolk Secretkeeper, Creature" for the
    creature — off the same lookup, with no reader knowing that two-faced cards exist. `castAs` is
    set only while the card is on the stack; `relocate` clears it on the way off.
  */
  const def = isFaceDownObject(instance)
    ? FACE_DOWN
    : state.cardDefs[instance.castAs ?? instance.defKey];
  /*
    And bestow, which changes what kind of permanent this *is* (CR 702.103b).

    A Boon Satyr is an Enchantment Creature — Satyr; cast for its bestow cost it is an Enchantment
    — Aura and **not a creature**, until the creature it enchants leaves. That is a change to the
    printed type line rather than a continuous effect, which is both what the rules say (the
    alternative cost changes the spell's characteristics as it is announced) and the only version
    that is read correctly everywhere: layer 4 below adds types to this result, and an Aura that
    something animates should become a creature once rather than twice.

    Here rather than in a layer, and above layer 4 rather than inside it, for the same reason the
    face-down profile is above it: both answer "what card is this object" rather than "what has
    been done to it".
  */
  const printed = bestowTypeLine(parseTypeLine(def?.typeLine), instance);
  /*
    Layer 4 first, in a pass of its own (CR 613.1c).

    It has to be separate because every later layer's *scope* depends on its result: "creatures you
    control get +1/+1" applies to a land that has become a creature, and a single pass in effect
    order would have judged that against the printed type line and missed it. The scope of a
    type-changing effect itself is judged against the printed types, which is the one simplification
    left in here — a card that animates something another effect animated first would need this pass
    to iterate, and nothing in the pool asks for it.
  */
  const layered = withAddedTypes(state, instance, printed, hasType(printed, 'creature'));
  // Changeling is part of the same layer, and `typeLine` is what every later layer's scope
  // is judged against — see `withChangeling` for why that sentence is the whole increment.
  const typeLine = withChangeling(state, instance, layered, def);
  const creature = hasType(typeLine, 'creature');

  // Layer 7b and 7c are collected separately, because the first replaces the base and the second
  // adds to whatever the base ended up being.
  let definedPower: number | null = null;
  let definedToughness: number | null = null;
  let setPower: number | null = null;
  let setToughness: number | null = null;
  let modPower = 0;
  let modToughness = 0;
  /*
    The level band this creature is in, which is part of what the card *is* (CR 711.3).

    Read here rather than installed as a continuous effect because it is not one: nothing has
    happened to the creature — it is the card's own text, conditioned on its own counters, and a
    Student of Warfare that loses its counters is a 1/1 again with nothing to undo.

    Its keywords are seeded alongside the printed ones, which puts them at the earliest timestamp
    and gets "loses all abilities" right for free: a Turn to Frog cast on a levelled creature clears
    the band's first strike in the loop below, exactly as it clears a printed keyword.
  */
  const band = levelBandOf(def, instance);
  const keywords = new Set<Keyword>([
    ...printedKeywords(def?.oracleText),
    ...(band?.keywords ?? []).filter(isKeyword),
  ]);
  let cantAttack = false;
  /*
    Printed combat statics, seeded exactly as printed landwalk and printed protection are below and
    for the same reason: a line that simply states "this creature can't block" is a *base*
    characteristic, so it starts here and is cleared by "loses all abilities" in the loop below
    rather than being layered on top of it (CR 613.1f). See `printedCombatStatics` for the hole this
    closes — the three fields existed and nothing but a script could ever set them.
  */
  const printedCombat = printedCombatStatics(def?.oracleText, def?.name);
  let cantBlock = printedCombat.cantBlock;
  let doesntUntap = printedCombat.doesntUntap;
  let mustAttack = printedCombat.mustAttack;
  let cantBeBlockedByWalls = false;
  let cantBeBlocked = printedCombat.cantBeBlocked;
  /*
    Printed blocker restrictions, seeded here with the other printed characteristics and for the
    same reason: a sentence about who may block this creature is an ability, so it is a *base*
    characteristic and "loses all abilities" clears it in the loop below (CR 613.1f). See
    `printedBlockerLimit`.
  */
  const printedBlockers = printedBlockerLimit(def?.oracleText, def?.name);
  let cantBeBlockedBy: readonly BlockerClause[] = printedBlockers.ban;
  let blockableOnlyBy: readonly BlockerClause[] | null = printedBlockers.only;
  /*
    And the mirror: what this creature may block. Same argument for seeding it here, same clearing
    below — a printed sentence is an ability, so it is a base characteristic (CR 613.1f). See
    `printedBlocksLimit` for why these are their own two fields rather than the two above (D500).
  */
  const printedBlocks = printedBlocksLimit(def?.oracleText, def?.name);
  let cantBlockThese: readonly BlockerClause[] = printedBlocks.ban;
  let blocksOnly: readonly BlockerClause[] | null = printedBlocks.only;
  /*
    Printed landwalk, which is a *base* characteristic exactly as a printed keyword is — so it is
    read here rather than left to the effects loop, and "loses all abilities" clears it below just
    as it clears the printed keywords (CR 613.1f). See `printedLandwalk` for why it was missing.
  */
  const printedWalk = printedLandwalk(def?.oracleText);
  let landwalk: string[] | null = printedWalk.length === 0 ? null : [...printedWalk];
  /*
    Allocated only if something actually sets them, because this is the hottest function in the
    engine: the search calls it for every candidate of every target of every play it plays out. Two
    `Set`s and two array copies on every call, for two rules that one card in the pool has between
    them, is work done for nothing.

    Not justified by a measurement. The slow tail of a pod soak was what first pointed here, and
    that tail turned out to be divergence noise rather than cost (D101) — the mean per decision
    kind, which is the instrument that does work, puts this below its resolution. It stays because
    allocating nothing is simpler than allocating something, not because a number says so.
  */
  let goadedBy: SeatIndex[] | null = null;
  /*
    Printed protection, seeded exactly as printed landwalk is above and for the same reason: it is a
    *base* characteristic, so it starts here and is cleared by "loses all abilities" in the loop
    below rather than being layered on top of it (CR 613.1f). See `printedProtection` for the hole
    this closes — an unscripted card had none at all.
  */
  const printedProt = printedProtection(def?.oracleText);
  let protectionFrom: Color[] | null = printedProt.length === 0 ? null : [...printedProt];
  // And the printed qualities, a base characteristic cleared with the colours (D596).
  let protectionQualities: readonly string[] = printedProtectionQualities(def?.oracleText);
  // Printed toxic, a base characteristic like the two above and cleared with them (CR 613.1f).
  let toxic = printedToxic(def?.oracleText);
  let setColors: readonly Color[] | null = null;

  for (const effect of state.effects ?? []) {
    if (silenced(state, effect.source)) continue;
    if (!effectApplies(state, effect, instance, creature, typeLine)) continue;
    /*
      Layer 6, and the one place the order of this loop is load-bearing.

      "Loses all abilities" takes away what the creature has *now* — its printed keywords and
      anything granted before this effect — and leaves anything granted after it alone (CR 613.1f).
      `state.effects` is in creation order, so clearing here is exactly that rule: a Turn to Frog
      cast after a Giant Growth's trample still removes it, and a trample granted after the Frog
      still flies.
    */
    if (effect.losesAllAbilities === true) {
      keywords.clear();
      cantAttack = false;
      doesntUntap = false;
      cantBlock = false;
      mustAttack = false;
      cantBeBlockedByWalls = false;
      cantBeBlocked = false;
      cantBeBlockedBy = [];
      blockableOnlyBy = null;
      cantBlockThese = [];
      blocksOnly = null;
      landwalk = null;
      goadedBy = null;
      protectionFrom = null;
      protectionQualities = NO_SUBTYPES;
      toxic = 0;
    }
    // Layer 7a before 7b, which is the whole of the ordering: a defined size is a *base*, and a
    // setting effect replaces it however early the definition was installed (CR 613.4a, 613.4c).
    if (effect.definesSize !== undefined) {
      const counted = cdaCount(state, effect.definesSize.count, effect.controller);
      definedPower = counted + (effect.definesSize.powerPlus ?? 0);
      if (effect.definesSize.applies !== 'power') {
        definedToughness = counted + (effect.definesSize.toughnessPlus ?? 0);
      }
    }
    if (effect.setPower !== undefined) setPower = effect.setPower;
    if (effect.setToughness !== undefined) setToughness = effect.setToughness;
    modPower += effect.power ?? 0;
    modToughness += effect.toughness ?? 0;
    /*
      Layer 7c with a live count (D523). A rate times a count, added to whatever the base turns out
      to be — which is why it sits here beside the fixed modifiers and not with `definesSize` above,
      where it would replace a printed size instead of lifting it.
    */
    if (effect.sizePerCount !== undefined) {
      const per = staticCount(state, effect.sizePerCount.of, effect.controller, effect.source);
      modPower += per * effect.sizePerCount.power;
      modToughness += per * effect.sizePerCount.toughness;
    }
    for (const k of effect.keywords ?? []) keywords.add(k);
    for (const k of effect.removeKeywords ?? []) keywords.delete(k);
    if (effect.cantAttack) cantAttack = true;
    if (effect.doesntUntap) doesntUntap = true;
    if (effect.cantBlock) cantBlock = true;
    if (effect.mustAttack) mustAttack = true;
    if (effect.cantBeBlockedByWalls) cantBeBlockedByWalls = true;
    if (effect.cantBeBlocked) cantBeBlocked = true;
    for (const subtype of effect.landwalk ?? []) {
      landwalk ??= [];
      if (!landwalk.includes(subtype)) landwalk.push(subtype);
    }
    if (effect.mustAttackAnotherPlayer) {
      goadedBy ??= [];
      if (!goadedBy.includes(effect.controller)) goadedBy.push(effect.controller);
    }
    for (const colour of effect.protectionFrom ?? []) {
      protectionFrom ??= [];
      if (!protectionFrom.includes(colour)) protectionFrom.push(colour);
    }
    // Layer 5 (CR 613.1d), which only has to be in effect order to be right: two effects that both
    // set a colour resolve last-one-wins, the same way two that set power do.
    if (effect.setColors !== undefined) setColors = effect.setColors;
  }

  // 7b, then 7c, then 7d: the base is whatever the last setting effect said (or the printed
  // value), every modification lands on top of it, and counters land on top of those.
  const plus = instance.counters['+1/+1'] ?? 0;
  const minus = instance.counters['-1/-1'] ?? 0;
  // 7a, then 7b, then 7c, then 7d: a defined size replaces the printed one, a setting effect
  // replaces either, every modification lands on top, and counters land on top of those.
  /*
    A level band **sets** the size (layer 7b), so it beats a characteristic-defining ability (7a)
    and loses to a later setting effect — which in practice is every one of them, because the band's
    timestamp is the permanent's own arrival. A Turn to Frog on a level-seven Student makes a 1/1.
  */
  const base = setPower ?? band?.power ?? definedPower ?? numeric(def?.power);
  const baseToughness = setToughness ?? band?.toughness ?? definedToughness ?? numeric(def?.toughness);
  const power = base + modPower + plus - minus;
  const toughness = baseToughness + modToughness + plus - minus;

  if (hasType(typeLine, 'creature') && keywords.has('defender')) cantAttack = true;


  return {
    name: def?.name ?? 'a card',
    typeLine,
    colors: setColors ?? printedColors(def),
    power,
    toughness,
    keywords,
    isCreature: creature,
    isLand: hasType(typeLine, 'land'),
    cantAttack,
    cantBlock,
    doesntUntap,
    // A creature that cannot attack at all is not required to: a restriction beats a requirement
    // (CR 509.1a is the blocking half of the same idea, and 508.1d says "if able").
    mustAttack: mustAttack && !cantAttack,
    cantBeBlockedByWalls,
    cantBeBlocked,
    cantBeBlockedBy,
    blockableOnlyBy,
    cantBlockThese,
    blocksOnly,
    landwalk: landwalk ?? NO_SUBTYPES,
    goadedBy: goadedBy ?? NO_SEATS,
    protectionFrom: protectionFrom ?? NO_COLORS,
    protectionQualities,
    toxic,
  };
}

/**
 * Whether this permanent's combat damage is prevented, in either direction.
 *
 * Asked of the *creature*, not of the attack, because both cards in a fight ask it: an attacker
 * under a Fog deals none, and a blocker under the same Fog deals none back. One question, both
 * directions, which is also how the printed cards read.
 */
export function combatDamagePrevented(state: GameState, instance: CardInstance): boolean {
  const def = state.cardDefs[instance.defKey];
  const line = parseTypeLine(def?.typeLine);
  const creature = hasType(line, 'creature');
  return (state.effects ?? []).some(
    (effect) => effect.preventsCombatDamage === true
      && effectApplies(state, effect, instance, creature, line),
  );
}

/** Whether this permanent assigns no combat damage: see `ContinuousEffect.assignsNoCombatDamage`. */
export function assignsNoCombatDamage(state: GameState, instance: CardInstance): boolean {
  const def = state.cardDefs[instance.defKey];
  const line = parseTypeLine(def?.typeLine);
  const creature = hasType(line, 'creature');
  return (state.effects ?? []).some(
    (effect) => effect.assignsNoCombatDamage === true
      && effectApplies(state, effect, instance, creature, line),
  );
}

/**
 * Whether every ability this permanent had has been taken away — layer 6, "loses all abilities"
 * (CR 613.1f).
 *
 * Asked of a permanent rather than of an ability, because that is the shape of the effect: a Turn
 * to Frog does not remove one thing, it empties the text box. `characteristicsOf` has always
 * honoured it for *keywords* and for the statics that reach the layer system; this is the same
 * question for the two kinds of ability the layers never see — the triggers `raise` collects and
 * the activations `legalActions` offers. Without it a Frogged Blood Artist still drained on a
 * death and a Frogged Llanowar Elves still tapped for mana, which is a 1/1 with no abilities doing
 * two things its text box no longer says.
 *
 * No timestamp reading, unlike `grantedTriggersOn`, and that is a fact about printed abilities
 * rather than a simplification: a card's own text is there from the moment it is on the
 * battlefield, so every "loses all abilities" is later than it and takes it. Only a *granted*
 * ability can arrive after the Frog, which is why that function walks the list and this one does
 * not.
 */
export function allAbilitiesLost(state: GameState, instance: CardInstance): boolean {
  const def = state.cardDefs[instance.defKey];
  const line = parseTypeLine(def?.typeLine);
  const creature = hasType(line, 'creature');
  return (state.effects ?? []).some(
    (effect) => effect.losesAllAbilities === true
      && effectApplies(state, effect, instance, creature, line),
  );
}

/**
 * A triggered ability one permanent is currently handing another: whose card defines it, and which
 * of that card's `grantedTriggers` it is.
 *
 * The card **name** rather than the grantor's instance id, because this reference outlives the
 * grantor. An ability on the stack is independent of its source (CR 608.2), so a Tandem Lookout
 * killed while its draw trigger is waiting to resolve still draws the card — and by then the
 * effect is gone and the instance is in a graveyard. A name is the key `scriptFor` already uses,
 * and it is as serialisable as the rest of the state.
 */
export interface GrantedTriggerRef {
  readonly card: string;
  readonly index: number;
  /**
   * The grantor's **card key** as well as its name, so a *compiled* grantor can be looked up.
   *
   * The name was enough while `grantedTriggers` was a hand-written field only, and the collection
   * site's docblock said so in as many words — "the one field the oracle-text compiler never
   * emits". **D511 made that false**: an Aura or Equipment whose printed line grants a quoted
   * triggered ability now compiles, and `scriptFor(name)` is a lookup in the hand-written registry,
   * which has no entry for it. The grant was built, installed and then silently never fired, which
   * is #322's bug surviving in the one place that change did not reach.
   *
   * A key rather than the grantor's instance id, for the reason the name was chosen over one:
   * `state.cardDefs[key]` outlives the grantor, so a trigger already on the stack still resolves
   * after the Aura has gone. The name is kept beside it as the fallback for a hand-written card
   * whose key is not in `cardDefs`.
   */
  readonly defKey?: string;
}

/**
 * Every triggered ability this permanent has been **given** by something else, in the order the
 * effects granting them were created.
 *
 * Its printed triggers are not here: those come off its own script, and this is the other half —
 * the one the engine had no machinery for at all, which is the gap the myriad docblock named and
 * the reason Blade of Selves had to be a keyword the combat code reads rather than an ability.
 *
 * **Layer 6, with the timestamps that layer needs** (CR 613.1f), which is the whole reason this
 * walks the list rather than filtering it: "loses all abilities" takes away what the creature has
 * *now* and leaves anything granted afterwards alone. A Turn to Frog cast on a paired Tandem
 * Lookout takes the draw trigger with it; pair the Frog with a Lookout afterwards and it draws
 * again. Same loop, same ordering argument, same `state.effects` creation order as the keyword
 * clearing in `characteristicsOf` — and deliberately the same shape, so the two cannot drift.
 *
 * A face-down permanent has no abilities at all (CR 707.2) and so can be handed none: an effect
 * pointed at one reaches a 2/2 with no text.
 */
export function grantedTriggersOn(
  state: GameState, instance: CardInstance,
): readonly GrantedTriggerRef[] {
  if (isFaceDownPermanent(instance)) return [];
  const def = state.cardDefs[instance.defKey];
  const line = parseTypeLine(def?.typeLine);
  const creature = hasType(line, 'creature');
  let out: GrantedTriggerRef[] | null = null;
  for (const effect of state.effects ?? []) {
    if (effect.grants === undefined && effect.losesAllAbilities !== true) continue;
    if (!effectApplies(state, effect, instance, creature, line)) continue;
    if (effect.losesAllAbilities === true) {
      out = null;
      continue;
    }
    const grantor = state.instances[effect.source];
    const defKey = grantor?.defKey;
    const name = state.cardDefs[defKey ?? '']?.name;
    if (name === undefined) continue;
    for (const index of effect.grants ?? []) {
      (out ??= []).push({ card: name, index, ...(defKey === undefined ? {} : { defKey }) });
    }
  }
  return out ?? [];
}

/**
 * The **activated** abilities continuous effects are handing this permanent (CR 113.6).
 *
 * `grantedTriggersOn` with `grantsAbilities` read instead of `grants`, and deliberately a copy of
 * that function rather than a parameterised version of it: the two differ in one field name, and
 * the shared part — the scope test, the face-down guard, layer 6 clearing everything collected
 * before it — is four lines. A `which: 'triggers' | 'abilities'` parameter would have put a
 * discriminator in every caller to save those four.
 *
 * Returns `GrantedTriggerRef`s, the same shape, because the question each answers is identical:
 * *which card defines this, and at what index*. `StackObject.grantedBy` is typed with it and
 * carries either kind — which of the two arrays to read is decided by the object's `kind`, since
 * an activated object was pushed by `activate` and a triggered one by `fireTrigger`.
 */
export function grantedAbilitiesOn(
  state: GameState, instance: CardInstance,
): readonly GrantedTriggerRef[] {
  if (isFaceDownPermanent(instance)) return [];
  const def = state.cardDefs[instance.defKey];
  const line = parseTypeLine(def?.typeLine);
  const creature = hasType(line, 'creature');
  let out: GrantedTriggerRef[] | null = null;
  for (const effect of state.effects ?? []) {
    if (effect.grantsAbilities === undefined && effect.losesAllAbilities !== true) continue;
    if (!effectApplies(state, effect, instance, creature, line)) continue;
    // CR 613.1f: everything granted *before* this effect is gone, and later grants still land.
    if (effect.losesAllAbilities === true) {
      out = null;
      continue;
    }
    const grantor = state.instances[effect.source];
    const defKey = grantor?.defKey;
    const name = state.cardDefs[defKey ?? '']?.name;
    if (name === undefined) continue;
    for (const index of effect.grantsAbilities ?? []) {
      (out ??= []).push({ card: name, index, ...(defKey === undefined ? {} : { defKey }) });
    }
  }
  return out ?? [];
}

/**
 * Whether `target` has protection from anything `source` is (CR 702.16).
 *
 * One answer for all four of protection's rules — damage, equipping, blocking and targeting — so
 * that the four cannot disagree about what "red" means. `source` is an instance id: a permanent, or
 * a spell on the stack, whose id *is* its card instance. A source with no instance (a game rule, or
 * damage from nowhere) is colourless and so gets past protection, which is correct: protection is
 * from colours, not from everything.
 */
export function protectedFrom(state: GameState, targetId: string, source: string | null): boolean {
  if (source === null) return false;
  const target = state.instances[targetId];
  if (target === undefined) return false;
  const ch = characteristicsOf(state, target);
  return protectionApplies(state, ch.protectionFrom, source, ch.protectionQualities);
}

/**
 * The same question for a caller that already has the characteristics in hand.
 *
 * Which is every caller in a hot loop: target legality computes the characteristics for each
 * candidate, and `canBlock` for each blocker, so asking through `protectedFrom` would compute them
 * a second time per candidate — the one measurable part of which is that it is twice the work for
 * the same answer. The empty-list check first is what makes the whole rule free for the 152 cards
 * in the pool that have no protection, which is the case that matters.
 */
export function protectionApplies(
  state: GameState, protection: readonly Color[], source: string | null,
  /** The qualities that are not colours (D596), tested against the source's live characteristics. */
  qualities: readonly string[] = [],
): boolean {
  if ((protection.length === 0 && qualities.length === 0) || source === null) return false;
  const inst = state.instances[source];
  if (inst === undefined) return false;
  if (qualities.length > 0) {
    const from = characteristicsOf(state, inst);
    const hit = qualities.some((quality) => {
      if (quality === 'everything') return true;
      if (quality === 'multicolored') return from.colors.length > 1;
      if (quality === 'monocolored') return from.colors.length === 1;
      if (quality.startsWith('type:')) return hasType(from.typeLine, quality.slice(5));
      if (quality.startsWith('subtype:')) return hasSubtype(from.typeLine, quality.slice(8));
      if (quality.startsWith('super:')) {
        return from.typeLine.supertypes.some((s) => s.toLowerCase() === quality.slice(6));
      }
      return false;
    });
    if (hit) return true;
    if (protection.length === 0) return false;
  }
  /*
    The source's *current* colours, not its printed ones — which is what layer 5 is for and what
    this read got wrong until a card could change a colour. A creature made red is red to
    protection from red, and this is the only rule in the engine that asks.

    `characteristicsOf` rather than `printedColors` costs a characteristics computation per source,
    and it is behind the empty-protection check above: 152 of the cards in the pool have no
    protection at all, so for them nothing here runs. For the two that do, the right answer is
    worth the work.
  */
  return characteristicsOf(state, inst).colors.some((colour) => protection.includes(colour));
}

/** Convenience for the many places that only need to ask about one keyword. */
export function hasKeyword(state: GameState, instance: CardInstance, keyword: Keyword): boolean {
  return characteristicsOf(state, instance).keywords.has(keyword);
}

/**
 * Drops effects whose duration has run out, and those whose source has left the battlefield.
 *
 * `seat` is only read for `until-controllers-next-turn`, where the duration names a seat rather
 * than a moment: that effect ends on its own controller's turn and nobody else's, so the untap
 * step passes the seat whose turn has just begun. Leaving it out can never expire one, which is
 * what the end-of-turn and end-of-combat passes want.
 */
export function expireEffects(
  state: GameState, when: EffectDuration, seat?: SeatIndex,
): ContinuousEffect[] {
  return (state.effects ?? []).filter((effect) => {
    if (effect.duration === 'until-controllers-next-turn') {
      // Not on the turn it was made in: a goad cast in a player's own turn lasts until their
      // *next* one, and the untap it was created after has already gone by.
      const ends = when === 'until-controllers-next-turn'
        && effect.controller === seat && effect.createdTurn < state.turn;
      return !ends;
    }
    if (effect.duration === when) return false;
    // A static effect only exists while its source is on the battlefield.
    if (effect.duration === 'permanent') {
      const source = state.instances[effect.source];
      return source !== undefined && source.zone === 'battlefield';
    }
    return true;
  });
}

/**
 * Whether a printed type line names a permanent type (CR 110.4): artifact, battle, creature,
 * enchantment, land or planeswalker. Only the types before the dash, so a "Kindred Instant — Elf"
 * is not one. What "permanent card" means to descend (D612).
 */
export function isPermanentCard(typeLine: string | undefined): boolean {
  const types = (typeLine ?? '').split(/[—–]/)[0] ?? '';
  return /\b(?:artifact|battle|creature|enchantment|land|planeswalker)\b/i.test(types);
}
