/**
 * Restricted mana: what a mana ability's "Spend this mana only to …" lets it pay for (D595).
 *
 * Its own module because both mana readers need it — the line reader in `scripts.ts` and the
 * mana-line parser in `fromCardData.ts`, which reads every land's mana and does not import the
 * scripts — and a second copy of a vocabulary is a second place for it to drift.
 */
import { hasSubtype, hasType, type TypeLine } from './characteristics.js';
import type { SpendRestriction } from './scriptTypes.js';

/**
 * "Spend this mana only to …" as a test of a payment (D595), or `null` for a restriction the
 * engine cannot check.
 *
 * Two halves, either or both printed: **casting** — "to cast creature spells", "to cast an instant
 * or sorcery spell", "to cast a noncreature spell", "to cast Dragon spells", "to cast spells" — and
 * **activating** — "to activate abilities", "or activate abilities of artifacts", "or activate an
 * ability of an artifact source". The nouns are type words, read against the **live** type line of
 * the spell or of the ability's source: lowercase is a card type (or "noncreature", or
 * "legendary"), capitalised is a subtype, and a disjunction ("instant or sorcery") is any of them.
 *
 * Refused, and so left unread: anything that is not a type — "on costs that contain {X}", "to cast
 * kicked spells", "a multicolored spell", "spells with flashback", "a creature spell of the chosen
 * type" (no chosen type is kept yet), and every rider ("and that spell can't be countered").
 */
export function spendRestriction(phrase: string): SpendRestriction | null {
  // The rider (D783): "…, and that spell can't be countered". The rest is read as it would be alone.
  const rider = /^(.+?),? and that spell can't be countered\.?$/i.exec(phrase.trim());
  if (rider !== null) {
    const rest = spendRestriction(rider[1]!);
    return rest === null ? null : { ...rest, words: phrase.trim().replace(/\.$/, ''), uncounterable: true };
  }
  const printed = phrase.trim().replace(/\.$/, '');
  // "Spend this mana only to cast your commander" (D697): Jeweled Lotus, Command Beacon's kin.
  if (/^to cast (?:your|a) commanders?$/i.test(printed)) {
    return { words: 'to cast your commander', allows: (paying) => paying.commander === true };
  }
  /*
    "…a creature spell **of the chosen type**" (D644): Unclaimed Territory, Pillar of Origins,
    Secluded Courtyard. The words are read without the phrase, and the restriction is marked so the
    one place that checks it — `manaSources`, which knows the source — also asks the spell or the
    ability's source for the creature type the land chose as it entered.
  */
  const chosenType = / of the chosen type\b/i.test(printed);
  const text = printed.replace(/ of the chosen type\b/gi, '');
  type Test = (t: TypeLine, colours: readonly string[] | undefined) => boolean;
  const words = (run: string): Test | null => {
    const parts = run.trim().split(/\s+(?:and\/or|or|and)\s+|,\s*(?:or\s+)?/).map((p) => p.trim()).filter((p) => p !== '');
    const alternatives: Test[] = [];
    for (const part of parts) {
      const tests: Test[] = [];
      for (const raw of part.split(/\s+/)) {
        // The colour words (D1399), read before the plural is taken off "colorless".
        const colourWord = raw.toLowerCase();
        if (colourWord === 'colorless') { tests.push((_t, c) => c !== undefined && c.length === 0); continue; }
        if (colourWord === 'multicolored') { tests.push((_t, c) => c !== undefined && c.length >= 2); continue; }
        if (colourWord === 'monocolored') { tests.push((_t, c) => c !== undefined && c.length === 1); continue; }
        const word = raw.replace(/s$/, '');
        const lower = word.toLowerCase();
        // "a creature **card** of the chosen type" (Secluded Courtyard): the card in another zone,
        // whose type line is the same question.
        if (lower === 'card') continue;
        // "an ability of a colorless permanent" (D1399): the source is one.
        if (lower === 'permanent') continue;
        if (lower === 'noncreature') { tests.push((t) => !hasType(t, 'creature')); continue; }
        if (lower === 'legendary') { tests.push((t) => t.supertypes.some((s) => s.toLowerCase() === 'legendary')); continue; }
        if (/^[a-z]/.test(word)) {
          if (!['creature', 'artifact', 'enchantment', 'instant', 'sorcery', 'planeswalker', 'land'].includes(lower)) return null;
          tests.push((t) => hasType(t, lower));
          continue;
        }
        if (!/^[A-Z][A-Za-z'-]*$/.test(word)) return null;
        tests.push((t) => hasSubtype(t, lower));
      }
      if (tests.length === 0) return null;
      alternatives.push((t, c) => tests.every((test) => test(t, c)));
    }
    return alternatives.length === 0 ? null : (t, c) => alternatives.some((test) => test(t, c));
  };
  /** "cast X spells" / "cast a X spell" / "cast spells", as a test of the spell's type line. */
  const castPart = (run: string): Test | null => {
    const m = /^cast (?:an? )?(.*?)\s*spells?$/i.exec(run.trim());
    if (m === null) return null;
    return m[1]!.trim() === '' ? () => true : words(m[1]!);
  };
  /** "activate abilities [of Xs]" / "activate an ability [of an X source]". */
  const activatePart = (run: string): Test | null => {
    const m = /^activate (?:abilities|an ability)(?: of (?:an? )?(.+?)(?: sources?)?)?$/i.exec(run.trim());
    if (m === null) return null;
    return m[1] === undefined ? () => true : words(m[1]);
  };
  const body = /^to (.+)$/i.exec(text)?.[1];
  if (body === undefined) return null;
  // One half, or both joined by "or" — either order, "to" repeated or not.
  const halves = body.split(/\s+or\s+(?:to\s+)?(?=cast\b|activate\b)/i);
  if (halves.length > 2) return null;
  let spells: Test | undefined;
  let abilities: Test | undefined;
  for (const half of halves) {
    if (/^cast\b/i.test(half)) {
      if (spells !== undefined) return null;
      const read = castPart(half);
      if (read === null) return null;
      spells = read;
    } else if (/^activate\b/i.test(half)) {
      if (abilities !== undefined) return null;
      const read = activatePart(half);
      if (read === null) return null;
      abilities = read;
    } else {
      return null;
    }
  }
  return {
    words: printed,
    ...(chosenType ? { chosenType: true as const } : {}),
    allows: (paying) => (paying.spell !== undefined && spells !== undefined && spells(paying.spell, paying.spellColors))
      || (paying.abilityOf !== undefined && abilities !== undefined && abilities(paying.abilityOf, paying.abilityColors)),
  };
}

/**
 * "This mana can't be spent to cast a nonartifact spell" (D740, Powerstone): the opposite shape of
 * "Spend this mana only …". Any ability may use it; a spell only when it is not of the banned kind.
 * The kind is one word, a "non-" of a card type or a card type.
 */
export function spendBan(phrase: string): SpendRestriction | null {
  const printed = phrase.trim().replace(/\.$/, '');
  const m = /^can't be spent to cast (?:an? )?(non)?(artifact|creature|enchantment|instant|sorcery|planeswalker) spells?$/i.exec(printed);
  if (m === null) return null;
  const type = m[2]!.toLowerCase();
  const banned = (t: TypeLine): boolean => (m[1] === undefined ? hasType(t, type) : !hasType(t, type));
  return {
    words: printed,
    allows: (paying) => (paying.spell !== undefined ? !banned(paying.spell) : paying.abilityOf !== undefined),
  };
}
