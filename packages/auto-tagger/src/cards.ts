/**
 * Named-card lists where oracle text alone gives the wrong answer.
 *
 * Every entry here exists because a text rule would misfile the card. A fetch land's text says
 * "search your library", which would make it a Tutor; a basic land produces mana, which a naive rule
 * would call Ramp. The directive settles each of these explicitly, so they are data, not heuristics.
 */
export const norm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const set = (...names: string[]): ReadonlySet<string> => new Set(names.map(norm));

/** Basic lands, including snow and Wastes. Never Ramp — they are the mana curve, not acceleration. */
export const BASIC_LANDS = set(
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest', 'Snow-Covered Wastes',
);

/**
 * Fetch lands belong under `Lands` ONLY — never `Utility Lands`, and never `Tutors` despite their
 * "search your library" text. CLAUDE.md names these explicitly.
 */
export const FETCH_LANDS = set(
  'Polluted Delta', 'Misty Rainforest', 'Scalding Tarn', 'Verdant Catacombs', 'Arid Mesa',
  'Marsh Flats', 'Bloodstained Mire', 'Flooded Strand', 'Wooded Foothills', 'Windswept Heath',
  'Prismatic Vista', 'Fabled Passage', 'Terramorphic Expanse', 'Evolving Wilds',
);

/** Non-basic lands whose value is a non-mana ability. CLAUDE.md's canonical list plus close kin. */
export const UTILITY_LANDS = set(
  'Dakmor Salvage', 'Reliquary Tower', "Urza's Saga", 'Bojuka Bog', 'Strip Mine', 'Wasteland',
  'Maze of Ith', "Rogue's Passage", 'High Market', 'Blast Zone', 'Scavenger Grounds',
  'Deserted Temple', 'Homeward Path', 'Kessig Wolf Run', 'Mikokoro, Center of the Sea',
  'Miren, the Moaning Well', 'Phyrexian Tower', 'Volrath\'s Stronghold', 'Academy Ruins',
);

/**
 * Reanimation returns a card from the graveyard directly to the battlefield. These MUST NEVER be
 * tagged `Blink & ETB`, which is strictly exiling and returning a permanent already on the field.
 */
export const REANIMATION = set(
  'Reanimate', 'Animate Dead', 'Necromancy', 'Victimize', 'Life // Death', 'Persist',
  'Exhume', 'Living Death', 'Balthor the Defiled', "Hell's Caretaker", 'Stitch Together',
  'Dread Return', 'Unburial Rites', 'Corpse Dance', 'Shallow Grave',
);

/**
 * Board wipes. A mass-removal spell is NEVER also tagged `Single Target Removal`, even though its
 * text often contains "destroy" — the directive is explicit about the precedence.
 */
export const MASS_REMOVAL = set(
  'Day of Black Sun', 'Culling Ritual', 'Toxic Deluge', 'Wrath of God', 'Damnation',
  'Blasphemous Act', 'Damn', 'Cyclonic Rift', 'Farewell', 'Austere Command', 'Merciless Eviction',
  'Vandalblast', 'Bane of Progress', 'Ravnica at War', 'Fiery Confluence', 'Supreme Verdict',
);

/**
 * Big threats whose indestructible/hexproof protects only themselves. The directive calls these out:
 * self-protection is NOT team `Protection`. Koma belongs under Wincons alone.
 */
export const SELF_PROTECTING_THREATS = set(
  'Koma, Cosmos Serpent', 'Carnage Tyrant', 'Thrun, the Last Troll', 'Blightsteel Colossus',
  'Sigarda, Host of Herons', 'Thrun, Breaker of Silence',
);

/** Cards that filter or dig without net card gain. Distinguished from Card Advantage by the directive. */
export const CARD_SELECTION = set(
  "Titan's Nest", 'Ponder', 'Brainstorm', 'Preordain', 'Sylvan Library', 'Impulse',
  'Sensei\'s Divining Top', 'Scroll Rack', 'Frantic Search', 'Faithless Looting',
);
