/**
 * Card feature extraction — the part of the recommendation engine that turns a card row into the
 * dimensions the scorer compares against.
 *
 * Ported verbatim (behaviour, not style) from legacy `execution/recommendation_engine.js`. The
 * classification rules are the product's, documented in `directives/auto_tagging_engine.md` and
 * CLAUDE.md, and the legacy test suite pins the ones that were got wrong once already:
 * a pure mana land is `Lands` and not `Utility Lands`, graveyard recursion and blink are not
 * removal, and a basic land is never `Ramp`. `packages/recommender/src/index.test.ts` carries those
 * assertions across, so a regression here fails the build rather than quietly changing what the
 * product recommends.
 *
 * Nothing in this file touches the database or the network: it is a pure function of a card row.
 */

/** Dimensions the profile and the candidate are compared on, and their weight in the match. */
export const DIMENSION_WEIGHTS = {
  themes: 0.28,
  roles: 0.26,
  colors: 0.16,
  types: 0.12,
  manaValues: 0.1,
  priceBands: 0.08,
} as const;

export type Dimension = keyof typeof DIMENSION_WEIGHTS;

/** The role counts a commander deck is assumed to want, used to score "fills a gap in your deck". */
export const ROLE_TARGETS: Record<string, number> = {
  Ramp: 10,
  'Card Advantage': 10,
  'Single Target Removal': 7,
  'Mass Removal': 3,
  Protection: 4,
  Tutors: 2,
  'Wincons / Finishers': 4,
  Recursion: 3,
};

/**
 * Subtypes that say nothing about a deck's theme. `Kindred: Equipment` is not a tribe, so these are
 * dropped before the kindred themes are derived.
 */
const GENERIC_SUBTYPES = new Set([
  'aura',
  'equipment',
  'vehicle',
  'food',
  'treasure',
  'clue',
  'blood',
  'saga',
  'class',
  'room',
  'background',
  'cartouche',
]);

export const MAX_RECOMMENDATION_PAGE = 500;
export const MAX_RECOMMENDATION_CYCLE = 100000;

/**
 * A card as the engine accepts it. Deliberately loose: rows arrive from `scryfall_cards`, from
 * `deck_cards`, and (once api.scryfall.com is reachable) straight from Scryfall, and each names the
 * same field differently. Every alias legacy accepted is accepted here.
 */
export interface CardLike {
  name?: string | null;
  card_name?: string | null;
  type_line?: string | null;
  typeLine?: string | null;
  oracle_text?: string | null;
  oracleText?: string | null;
  mana_cost?: string | null;
  cmc?: number | string | null;
  colors?: unknown;
  color_identity?: unknown;
  colorIdentity?: unknown;
  price?: number | string | null;
  cheapest_card_price?: number | string | null;
  rarity?: string | null;
  artist?: string | null;
  custom_tag?: unknown;
  customTag?: unknown;
  tags?: unknown;
  deck_tags?: unknown;
  deckTags?: unknown;
  /** Object from Scryfall; JSON **text** from `scryfall_cards.legalities`. Both are accepted. */
  legalities?: Record<string, string> | string | null;
  [key: string]: unknown;
}

export interface CardFeatures {
  name: string;
  nameKey: string;
  colors: string[];
  roles: string[];
  themes: string[];
  types: string[];
  manaValues: string[];
  priceBands: string[];
  cmc: number;
  price: number;
  artist: string;
  isBasicLand: boolean;
  isTokenLike: boolean;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
}

/**
 * Legacy stores list-shaped columns (`colors`, `custom_tags`) as JSON text in some rows and as a
 * delimited string in others, because two different writers produced them. Both are accepted.
 */
export function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value
        .split(/[,;|]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

export function manaValueBucket(cmc: unknown): string {
  const value = safeNumber(cmc);
  if (value <= 1) return '0–1';
  if (value <= 2) return '2';
  if (value <= 3) return '3';
  if (value <= 4) return '4';
  return '5+';
}

export function priceBucket(price: unknown): string {
  const value = safeNumber(price);
  if (value < 1) return 'Under $1';
  if (value < 5) return '$1–5';
  if (value < 15) return '$5–15';
  if (value < 40) return '$15–40';
  return '$40+';
}

/** Maps a user's own category tag onto a role where it names one, and a theme otherwise. */
export function mapCustomTag(tag: unknown): { dimension: 'roles' | 'themes'; value: string } | null {
  const value = normalizeName(tag);
  if (!value) return null;
  if (/(ramp|mana rock|mana dork|ritual)/.test(value)) return { dimension: 'roles', value: 'Ramp' };
  if (/(card advantage|card draw|draw engine)/.test(value)) return { dimension: 'roles', value: 'Card Advantage' };
  if (/(card selection|filter|scry|surveil|loot|rummage)/.test(value)) return { dimension: 'roles', value: 'Card Selection' };
  if (/(single target removal|spot removal|interaction|counterspell)/.test(value)) return { dimension: 'roles', value: 'Single Target Removal' };
  if (/(mass removal|board wipe|sweeper)/.test(value)) return { dimension: 'roles', value: 'Mass Removal' };
  if (/(protection|protect)/.test(value)) return { dimension: 'roles', value: 'Protection' };
  if (/(tutor)/.test(value)) return { dimension: 'roles', value: 'Tutors' };
  if (/(wincon|finisher)/.test(value)) return { dimension: 'roles', value: 'Wincons / Finishers' };
  if (/(reanimation|reanimate)/.test(value)) return { dimension: 'roles', value: 'Reanimation' };
  if (/(recursion)/.test(value)) return { dimension: 'roles', value: 'Recursion' };
  if (/(stax|tax|hatebear)/.test(value)) return { dimension: 'roles', value: 'Stax' };
  if (/(graveyard filler|self.?mill)/.test(value)) return { dimension: 'roles', value: 'Graveyard Fillers' };
  if (/(sacrifice outlet)/.test(value)) return { dimension: 'roles', value: 'Sacrifice Outlets' };
  return { dimension: 'themes', value: String(tag).trim() };
}

const TYPE_RULES: Array<[string, RegExp]> = [
  ['Creature', /\bcreature\b/],
  ['Instant', /\binstant\b/],
  ['Sorcery', /\bsorcery\b/],
  ['Artifact', /\bartifact\b/],
  ['Enchantment', /\benchantment\b/],
  ['Planeswalker', /\bplaneswalker\b/],
  ['Land', /\bland\b/],
  ['Battle', /\bbattle\b/],
];

/** Turns a card row into the feature vector the scorer compares. Pure. */
export function extractCardFeatures(card: CardLike = {}): CardFeatures {
  const typeLine = String(card.type_line ?? card.typeLine ?? '');
  const oracle = String(card.oracle_text ?? card.oracleText ?? '');
  const text = `${typeLine}\n${oracle}`.toLocaleLowerCase('en-US');
  const typeLower = typeLine.toLocaleLowerCase('en-US');
  const name = String(card.card_name ?? card.name ?? '');
  const roles: string[] = [];
  const themes: string[] = [];
  const types: string[] = [];

  for (const [label, rule] of TYPE_RULES) {
    if (rule.test(typeLower)) types.push(label);
  }

  const isLand = types.includes('Land');
  const isMassRemoval =
    /(destroy|exile|return) all|each creature gets|all creatures get|deals? \d+ damage to each creature/.test(text);
  // Spot removal per the auto-tagging directive = destroy/exile target, or counter target spell.
  // Graveyard recursion ("return target ... from your graveyard") and blink ("exile target ...
  // return it") both match the naive pattern and are NOT removal.
  const isSpotRemoval =
    /(destroy|exile) target|counter target spell|deals? \d+ damage to target/.test(text) &&
    !/from (a|your) graveyard/.test(text) &&
    !/exile target .+ return (it|that|them)/.test(text);

  if (
    !isLand &&
    (/\badd \{?[wubrgc]\}?|add (one|two|three|an amount of) mana|treasure token/.test(text) ||
      /search your library for [^.\n]{0,55}(basic land|land card|forest card|plains card|island card|swamp card|mountain card)/.test(
        text,
      ) ||
      /you may play an additional land/.test(text))
  ) {
    roles.push('Ramp');
  }
  if (
    /draw (two|three|four|x|that many|a card for each)|whenever .+, draw a card|at the beginning of .+, draw/.test(text) ||
    /exile .+ you may play|look at the top .+ put .+ into your hand/.test(text)
  ) {
    roles.push('Card Advantage');
  }
  if (/\bscry\b|\bsurveil\b|look at the top \w+ cards|draw \w+ cards?, then discard|discard .+, then draw/.test(text)) {
    roles.push('Card Selection');
  }
  if (isMassRemoval) roles.push('Mass Removal');
  else if (isSpotRemoval) roles.push('Single Target Removal');
  if (
    /gains? (hexproof|indestructible|protection from)|permanents? you control (gain|have)|phase out|counter target spell.*targets?/.test(
      text,
    )
  ) {
    roles.push('Protection');
  }
  if (/search your library for (a|an|up to|any) (card|creature|artifact|enchantment|instant|sorcery)/.test(text)) {
    roles.push('Tutors');
  }
  if (/you win the game|opponent loses the game|take an extra turn|extra combat phase|life total becomes 0/.test(text)) {
    roles.push('Wincons / Finishers');
  }
  if (/return target .*card from (a|your) graveyard to (your hand|the top of your library)/.test(text)) {
    roles.push('Recursion');
  }
  if (
    /return target .*card from (a|your) graveyard to the battlefield|put target .*card from a graveyard onto the battlefield/.test(
      text,
    )
  ) {
    roles.push('Reanimation');
  }
  if (/mill \w+ cards|put the top \w+ cards? of your library into your graveyard/.test(text)) {
    roles.push('Graveyard Fillers');
  }
  if (/sacrifice (a|another|one or more) .+[:.,]|sacrifice .+:/.test(text)) roles.push('Sacrifice Outlets');
  if (/spells cost|can'?t cast|don'?t untap|can'?t untap|players can'?t|opponents can'?t|enters the battlefield tapped/.test(text)) {
    roles.push('Stax');
  }
  // A land is "Utility" only when it has a NON-mana ability. Every mana land has a "{T}: Add ..."
  // line, so testing for a colon mislabels Command Tower and every dual and fetch as Utility; the
  // directive lists those under "Lands".
  if (isLand) {
    const landUtility =
      /can'?t be blocked|no maximum hand size|dredge|destroy target|exile target|add loyalty|:\s*(draw|scry|surveil|create|mill|sacrifice|deal|proliferate)/.test(
        text,
      );
    roles.push(landUtility ? 'Utility Lands' : 'Lands');
  }

  if (/\bartifact\b|treasure|clue|food|vehicle|equipment/.test(text)) themes.push('Artifacts');
  if (/\benchantment\b|aura|constellation/.test(text)) themes.push('Enchantments');
  if (/\btoken\b|populate|create \w+ \d+\/\d+/.test(text)) themes.push('Tokens');
  if (/\+1\/\+1 counter|counter on|proliferate|double the number of counters/.test(text)) themes.push('Counters');
  if (/graveyard|mill|dredge|delirium|descend/.test(text)) themes.push('Graveyard');
  if (/sacrifice|dies|death trigger/.test(text)) themes.push('Sacrifice');
  if (/(instant|sorcery) spell|whenever you cast|copy target (instant|sorcery|spell)|magecraft|storm/.test(text)) {
    themes.push('Spellslinger');
  }
  if (/landfall|land enters|play an additional land|lands? you control/.test(text)) themes.push('Lands');
  if (/gain life|you gained life|lifelink/.test(text)) themes.push('Lifegain');
  if (/exile .+ then return|blink|flicker/.test(text)) themes.push('Blink / ETB');
  if (/equipment|equipped creature|aura attached|commander you control gets/.test(text)) themes.push('Voltron');
  if (/poison counter|toxic|infect|proliferate/.test(text)) themes.push('Poison');
  if (/mills?|library into (their|your) graveyard/.test(text)) themes.push('Mill');
  if (/gain control of|you control enchanted creature/.test(text)) themes.push('Theft');
  if (/energy counter|\{e\}/.test(text)) themes.push('Energy');
  if (/venture into the dungeon|take the initiative/.test(text)) themes.push('Dungeons');

  const subtypePart = typeLine.split(/[—-]/)[1] ?? '';
  const subtypes = subtypePart
    .split(/\s+/)
    .map((item) => normalizeName(item.replace(/[^a-zA-Z'-]/g, '')))
    .filter((item) => item.length > 2 && !GENERIC_SUBTYPES.has(item))
    .slice(0, 4);
  if (subtypes.length && types.includes('Creature')) {
    for (const subtype of subtypes) themes.push(`Kindred: ${subtype[0].toUpperCase()}${subtype.slice(1)}`);
  }

  const customTags = [
    ...parseList(card.custom_tag ?? card.customTag),
    ...parseList(card.tags),
    ...parseList(card.deck_tags ?? card.deckTags),
  ];
  for (const tag of customTags) {
    const mapped = mapCustomTag(tag);
    if (mapped?.dimension === 'roles') roles.push(mapped.value);
    else if (mapped?.dimension === 'themes') themes.push(mapped.value);
  }

  // Reminder text is parenthesised and repeats symbols the card does not actually produce, so it is
  // stripped before the rules text is mined for colour.
  const rulesWithoutReminderText = oracle.replace(/\([^)]*\)/g, '');
  const rulesManaSymbols = [...rulesWithoutReminderText.matchAll(/\{([WUBRG])(?:\/[WUBRG])?\}/gi)].map((match) =>
    match[1].toUpperCase(),
  );
  const colors = unique(
    [...parseList(card.color_identity ?? card.colorIdentity ?? card.colors), ...rulesManaSymbols]
      .map((color) => String(color).toUpperCase())
      .filter((color) => ['W', 'U', 'B', 'R', 'G'].includes(color)),
  );

  return {
    name,
    nameKey: normalizeName(name),
    colors,
    roles: unique(roles),
    themes: unique(themes),
    types: unique(types),
    manaValues: [manaValueBucket(card.cmc)],
    priceBands: [priceBucket(card.price ?? card.cheapest_card_price)],
    cmc: safeNumber(card.cmc),
    price: safeNumber(card.price ?? card.cheapest_card_price, 0.15),
    artist: String(card.artist ?? ''),
    isBasicLand: /\bbasic land\b/i.test(typeLine),
    isTokenLike: /\btoken\b/i.test(typeLine) || /\b(emblem|art series)\b/i.test(name),
  };
}
