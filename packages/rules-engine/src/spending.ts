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
  const text = phrase.trim().replace(/\.$/, '');
  const words = (run: string): ((t: TypeLine) => boolean) | null => {
    const parts = run.trim().split(/\s+(?:and\/or|or|and)\s+|,\s*(?:or\s+)?/).map((p) => p.trim()).filter((p) => p !== '');
    const alternatives: ((t: TypeLine) => boolean)[] = [];
    for (const part of parts) {
      const tests: ((t: TypeLine) => boolean)[] = [];
      for (const raw of part.split(/\s+/)) {
        const word = raw.replace(/s$/, '');
        const lower = word.toLowerCase();
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
      alternatives.push((t) => tests.every((test) => test(t)));
    }
    return alternatives.length === 0 ? null : (t) => alternatives.some((test) => test(t));
  };
  /** "cast X spells" / "cast a X spell" / "cast spells", as a test of the spell's type line. */
  const castPart = (run: string): ((t: TypeLine) => boolean) | null => {
    const m = /^cast (?:an? )?(.*?)\s*spells?$/i.exec(run.trim());
    if (m === null) return null;
    return m[1]!.trim() === '' ? () => true : words(m[1]!);
  };
  /** "activate abilities [of Xs]" / "activate an ability [of an X source]". */
  const activatePart = (run: string): ((t: TypeLine) => boolean) | null => {
    const m = /^activate (?:abilities|an ability)(?: of (?:an? )?(.+?)(?: sources?)?)?$/i.exec(run.trim());
    if (m === null) return null;
    return m[1] === undefined ? () => true : words(m[1]);
  };
  const body = /^to (.+)$/i.exec(text)?.[1];
  if (body === undefined) return null;
  // One half, or both joined by "or" — either order, "to" repeated or not.
  const halves = body.split(/\s+or\s+(?:to\s+)?(?=cast\b|activate\b)/i);
  if (halves.length > 2) return null;
  let spells: ((t: TypeLine) => boolean) | undefined;
  let abilities: ((t: TypeLine) => boolean) | undefined;
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
    words: text,
    allows: (paying) => (paying.spell !== undefined && spells !== undefined && spells(paying.spell))
      || (paying.abilityOf !== undefined && abilities !== undefined && abilities(paying.abilityOf)),
  };
}

