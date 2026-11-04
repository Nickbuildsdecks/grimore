import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import { STARTER_DECKS } from './starterDecks.js';
import { scriptFor } from './scripts.js';
import { printedKeywords } from './characteristics.js';
import type { CardDataRow } from './fromCardData.js';
import type { CardDef } from './cards.js';

/**
 * Does the **compiled** reading of a card agree with the **hand-written** script for it?
 *
 * ## Why this file exists, and what it replaces
 *
 * `compile.test.ts` asks that question one card at a time, by hand, and it is the best check this
 * project has: a describe block per family, each comparing a compiled script against the one a
 * person wrote from the same printed text. It has found real defects — a drain where the card said
 * damage (D407), a guard copied from the wrong card (D409), a bot hint two cards were right to omit
 * (D412), two guards that could not fail (D415).
 *
 * Every one of those was found the same way: **somebody read a card beside its script.** Four
 * increments in a row argued that the reading should be mechanical instead, and this is it.
 *
 * The pool is 348 cards. `compile.test.ts` covers something like sixty of them by hand. This covers
 * **every card that has both a hand-written script and a compiled reading with nothing unread** —
 * 205 of them — and it compares the whole script rather than the fields somebody thought to assert.
 *
 * It matters more for what comes next than for the pool. #318 imports tens of thousands of cards
 * with **no hand-written script to check against**, so the only ground truth the compiler will ever
 * have is the pool. Spending all of it, automatically, is the difference between "the families
 * somebody tested" and "every card we can check".
 *
 * ## How the comparison works, and the three things it deliberately ignores
 *
 * Both scripts are serialised with every function replaced by `[fn]` and every object's keys
 * sorted. So this compares **structure and data** — which fields exist, every scalar, every target
 * spec, every trigger's event, every ability's cost — and not the body of a closure. What a closure
 * does is `compile.test.ts`'s job, card by card, and the two checks are complementary: this one
 * finds a field that is missing or wrong, that one finds an effect that resolves wrongly.
 *
 * Three normalisations, each because the two spellings are the same card:
 *
 * 1. **Key order.** An object is an object; the order its fields were written in is not a fact
 *    about the card. Twelve cards differed by nothing else.
 * 2. **`who: 'self'` on an event.** `TriggerDef`'s docblock makes it the documented default, so
 *    `{ kind: 'etb' }` and `{ kind: 'etb', who: 'self' }` are one event. Most hand-written cards
 *    leave it out and the compiler writes it.
 * 3. **`description`.** A hand-written trigger describes itself for the log in prose a person
 *    chose; the compiler stores the printed line. Both are right and neither is the card's rules.
 *
 * ## `keywords`, which is the one field compared separately
 *
 * Nineteen cards differ **only** by a `keywords: ['flying']`-style declaration the compiled reading
 * does not carry, and that is not a gap: `characteristicsOf` seeds a creature's keywords from
 * `printedKeywords(def.oracleText)` **unconditionally**, so a compiled Shivan Dragon has flying
 * because its text says so, not because a script says so. The declaration on the hand-written card
 * is belt-and-braces.
 *
 * That is asserted rather than assumed — the second test below checks that every keyword those
 * nineteen declare really is printed on the card, so the day one of them declares a keyword its
 * text does not print, this stops calling the difference harmless.
 *
 * ## The known disagreements, and why each row carries a fingerprint
 *
 * `DISAGREE` is the list of cards that still differ, each with what the difference is, **which
 * fields differ, and a digest of the compiled side of them**.
 *
 * The first version compared only the names, and a deliberate break proved that insufficient:
 * removing the `blinks` hint from the compiled blink reader left every test green, because
 * Cloudshift was already on the list and the check only asked *whether* it differed. A known-bad
 * card was a hole the size of the whole script.
 *
 * So the assertion is on the names, the differing fields, **and** the digest — an equality in all
 * three, which fails in every direction that matters: a new disagreement, a card that stopped
 * disagreeing, a known card that started differing in a new field, and a known card whose
 * difference changed shape. Whoever fixes one deletes its row; whoever changes one updates the
 * digest the failure prints and says why in the commit.
 *
 *   npx vitest run src/compiled-vs-written.test.ts
 */

/** Every distinct card in the pool, as its definition. */
function poolDefs(): readonly CardDef[] {
  const seen = new Map<string, CardDef>();
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const entry of deck.cards) if (!seen.has(entry.card.name)) seen.set(entry.card.name, entry.card);
    if (deck.commander !== undefined && !seen.has(deck.commander.name)) {
      seen.set(deck.commander.name, deck.commander);
    }
  }
  return [...seen.values()];
}

/** The same definition as the row an importer would hand `compileCard` — `pool-rows.mjs`'s shape. */
const rowOf = (def: CardDef): CardDataRow => ({
  name: def.name,
  type_line: def.typeLine,
  oracle_text: def.oracleText,
  mana_cost: def.manaCost,
  cmc: def.cmc,
  colors: [...def.colors],
  power: def.power ?? null,
  toughness: def.toughness ?? null,
  loyalty: def.loyalty ?? null,
  layout: def.faces === undefined ? 'normal' : def.faces.kind,
} as CardDataRow);

/** Structure and data, with closures, key order and the two documented defaults normalised away. */
function norm(value: unknown): unknown {
  if (typeof value === 'function') return '[fn]';
  if (Array.isArray(value)) return value.map(norm);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (key === 'description') continue;
      if (key === 'who' && object['kind'] !== undefined && object[key] === 'self') continue;
      out[key] = norm(object[key]);
    }
    return out;
  }
  return value;
}

const withoutKeywords = (script: Record<string, unknown>): Record<string, unknown> => {
  const { keywords, ...rest } = script;
  return rest;
};

/**
 * A short, stable digest of a string — enough to notice that a difference changed shape.
 *
 * Not a cryptographic hash and does not need to be: the only adversary is a silent edit, and the
 * failure prints the new digest beside the old so updating a row is a copy rather than a puzzle.
 * `node:crypto` is deliberately not imported — `packages/shared` was broken in Vite for a week by a
 * barrel that pulled it into a browser graph, and a test file is not worth risking that again.
 */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Which top-level fields differ, and a digest of the compiled side of exactly those. */
function differenceOf(
  mine: Record<string, unknown>, written: Record<string, unknown>,
): { keys: readonly string[]; digest: string } {
  const a = norm(withoutKeywords(mine)) as Record<string, unknown>;
  const b = norm(withoutKeywords(written)) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return { keys, digest: digest(keys.map((k) => `${k}=${JSON.stringify(a[k])}`).join('\n')) };
}

/**
 * The cards whose compiled reading still differs from the hand-written one, and how.
 *
 * Each row is a finding, not an exemption. They are listed rather than fixed here because a fix
 * belongs with the test that proves it, and because several are the same shape and want one change
 * between them rather than four.
 */
const DISAGREE: Readonly<Record<string, { readonly why: string; readonly keys: readonly string[]; readonly digest: string }>> = {
  /*
    **Magma Jet was here and is fixed (D418).** Its row read "damage belongs in beforeDecisions, so
    the scry is offered after it", and the fix was not a reader but an assembly rule: a composition
    now splits at its first question, so the parts before it go in `beforeDecisions`. Any resolution
    shaped "an effect. a question." had the same defect; the row is deleted rather than kept because
    the test asserts an equality and a stale row fails it, which is the point.
  */
  /*
    The same hint, missing for a different reason: the removal is a **trigger** ("When ~ enters the
    battlefield, exile target creature"), and `removesACreature` is a card-level flag that only the
    spell path can set — `spellFlags` is spell-only by construction. A permanent whose ETB trigger
    removes a creature needs a way to say so.
  */
  'Journey to Nowhere': { why: 'missing removesACreature, which only the spell path can currently set', keys: ['removesACreature'], digest: '7895f0f1' },
  /*
    **Ninja of the Deep Hours and Mardu Scout were here and are fixed (D421).** Both rows asked the
    same question — whether the keyword's field is the implementation or only a label — and for
    both the answer was the label. `ninjutsu`'s own docblock says it is "read nowhere but the card
    that declares it"; the play comes from an ability with `AbilityCost.returnsUnblockedAttacker`,
    so the compiled Ninja could never be ninjutsu'd. `dash`'s return is scheduled by finding the
    card's one `delayed` end-step trigger behind an `index >= 0` guard, so the compiled Scout got
    haste and stayed on the battlefield for ever. The reader now emits the machinery with the
    declaration, and the hand-written Ninja shares the compiled card's `ninjutsuAbility` factory.
  */
  /*
    **Five rows were here and are settled (D419).** Four were about `friendly` on a target spec and
    one about defender:

    - **Garruk Wildspeaker** was a real defect in **both** readings. The compiled `+1` carried
      `untapsOnly`, which `AbilityDef.untapsOnly`'s own docblock forbids by name — "Garruk's +1
      untaps two lands *and* puts a loyalty counter on him" — so the loyalty branch drops it; and
      the hand-written spec lacked `friendly`, which on a card that says "target lands" with no "you
      control" is the difference between the bot untapping its own lands and the opponent's.
    - **Cloudshift, Blossoming Defense, Dive Down** carried `friendly` on the compiled side only,
      beside a filter that already restricts to your own side. Harmless either way, and written on
      the hand-written cards too rather than carried here for ever.
    - **Basilica Guards** had a hand-written static for defender. `defender` is a printed keyword and
      `characteristicsOf` sets `cantAttack` from it, so the static restated the card's own text; it
      is deleted, and the test that goes with it declares an attack and checks the refusal.
  */
};
  /*
    **Two more were here and are settled (D420).** `Flame Slash` wanted the `removesACreature` hint
    on damage whose spec is creature-only — the same rule destroy and exile already followed, simply
    missing from damage — and adding it introduced no new disagreement, so it matches every
    hand-written card in the pool. `Capsize` had a hand-written filter requiring the battlefield,
    which `legalTargets` and `isLegalTarget` both require already; deleted as a guard that cannot
    fail.
  */

describe('every compiled reading against the hand-written script for the same card', () => {
  /** Both scripts for every pool card that has both, with nothing left unread. */
  const pairs = (): readonly { def: CardDef; mine: Record<string, unknown>; written: Record<string, unknown> }[] => {
    const out: { def: CardDef; mine: Record<string, unknown>; written: Record<string, unknown> }[] = [];
    for (const def of poolDefs()) {
      const written = scriptFor(def.name) as Record<string, unknown> | undefined;
      if (written === undefined) continue;
      const compiled = compileCard(rowOf(def));
      if (!compiled.ok || compiled.script === undefined || compiled.unread.length > 0) continue;
      out.push({ def, mine: compiled.script as unknown as Record<string, unknown>, written });
    }
    return out;
  };

  it('compares a useful share of the pool, so the counts below are not about four cards', () => {
    /*
      The denominator, asserted so this file cannot quietly stop testing anything. A compiler change
      that refused half the pool would leave every other test here green.
    */
    expect(pairs().length).toBeGreaterThanOrEqual(200);
  });

  it('disagrees with the hand-written script on exactly the cards DISAGREE names', () => {
    /*
      An equality rather than a subset, which fails in both directions on purpose: a new
      disagreement is a regression, and a fixed one fails too, so whoever fixes it deletes the row
      and says what it was. A list that could only grow would rot into a list of excuses.
    */
    const found: Record<string, { why: string; keys: readonly string[]; digest: string }> = {};
    for (const { def, mine, written } of pairs()) {
      if (JSON.stringify(norm(mine)) === JSON.stringify(norm(written))) continue;
      // `keywords` is compared by the next test, for the reason in this file's header.
      if (JSON.stringify(norm(withoutKeywords(mine)))
        === JSON.stringify(norm(withoutKeywords(written)))) continue;
      const seen = differenceOf(mine, written);
      found[def.name] = {
        // The reason is the list's, not the comparison's: a row keeps whatever it was written with,
        // so this compares the names, the fields and the digest and never the prose.
        why: DISAGREE[def.name]?.why ?? 'NEW — not on the list',
        keys: seen.keys,
        digest: seen.digest,
      };
    }
    if (process.env.DISAGREE_DUMP === '1') console.log(JSON.stringify(found, null, 2));
    expect(found).toEqual(DISAGREE);
  });

  it('omits only keyword declarations the card itself prints', () => {
    /*
      Nineteen cards differ by nothing but a `keywords` declaration, and that is harmless **because**
      `characteristicsOf` seeds keywords from the printed text unconditionally. This is what makes
      that reasoning falsifiable: a hand-written card declaring a keyword its own text does not print
      would be a keyword the compiled reading really loses, and this row would fail.
    */
    const unprinted: string[] = [];
    let keywordOnly = 0;
    for (const { def, mine, written } of pairs()) {
      if (JSON.stringify(norm(mine)) === JSON.stringify(norm(written))) continue;
      if (JSON.stringify(norm(withoutKeywords(mine)))
        !== JSON.stringify(norm(withoutKeywords(written)))) continue;
      keywordOnly += 1;
      const printed = printedKeywords(def.oracleText) as readonly string[];
      for (const word of (written['keywords'] as readonly string[] | undefined) ?? []) {
        if (!printed.includes(word)) unprinted.push(`${def.name}: ${word}`);
      }
    }
    expect(unprinted).toEqual([]);
    // Not vacuous: there really are cards in this bucket, so the check above ran.
    expect(keywordOnly).toBeGreaterThanOrEqual(15);
  });
});
