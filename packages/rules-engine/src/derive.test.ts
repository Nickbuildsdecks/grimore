/**
 * Which lookup the engine's own code uses to ask what a card does.
 *
 * `scripts.ts` exports `scriptFor(name)` — the **hand-written** registry. `derive.ts` exports
 * `scriptForCard(def)`, which answers from the registry first and falls back to the oracle-text
 * compiler. For the 348 cards in the pool the two are identical, because every one of them has a
 * hand-written script. For a card nobody wrote a script for they are not: the registry says
 * `undefined` and the compiler says whatever it could read off the printed text.
 *
 * That difference is invisible in the existing suite, which plays pool cards, and it is the whole
 * point of this file: when the compiler landed, the resolution and legality paths moved to
 * `scriptForCard` and **the bot did not**. So a pasted deck resolved correctly and was played by an
 * opponent that could not see a single one of its abilities, triggers or bot hints.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { scriptForCard } from './derive.js';
import { scriptFor } from './scripts.js';
import type { CardDef } from './cards.js';

/** A real card with no hand-written script: the printed text of Blossoming Defense, renamed. */
const COMPILED_ONLY: CardDef = {
  name: 'Nonesuch Defense',
  typeLine: 'Instant',
  manaCost: '{G}',
  cmc: 1,
  colors: ['G'],
  oracleText: 'Target creature you control gets +2/+2 and gains hexproof until end of turn.',
};

describe('the lookup the engine asks with', () => {
  it('sees a compiled card where the hand-written registry sees nothing', () => {
    expect(scriptFor(COMPILED_ONLY.name), 'this fixture must not be a pool card').toBeUndefined();
    const script = scriptForCard(COMPILED_ONLY);
    expect(script, 'the compiler read nothing off this card').toBeDefined();
    /*
      The bot hint, which is the part that was invisible. `castsAProtection` reads
      `protectsACreature` to keep a trick in hand until something threatens a creature — measured
      at 64 casts across 160 games with 60 of them into an empty board (D379). A lookup that cannot
      see the field is a bot that throws the card away, and nothing refuses it.
    */
    expect(script?.protectsACreature).toBe(true);
    expect(script?.targets?.[0]?.description).toBe('target creature you control');
  });

  /*
    A source-level check, which is unusual here and is the right shape for this one.

    The defect was not a wrong answer from a function; it was ~30 call sites asking the wrong
    function, in files whose tests all pass either way because the pool cannot tell the two apart.
    Nothing a behavioural test can assert distinguishes them on a pool card — so what is pinned is
    the thing that was actually wrong, and the thing a future edit would get wrong again.
  */
  /**
   * The file with its comments removed.
   *
   * Needed rather than tidy: every one of these files *names* `scriptFor` in a docblock, explaining
   * which lookup it uses and why, so matching the raw text finds the explanation and reports it as
   * the defect. The first version of this test did exactly that and failed on all three files.
   */
  const code = (file: string): string =>
    readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  it.each([
    ['bot.ts'],
    ['autoActions.ts'],
    ['legalActions.ts'],
  ])('%s asks by definition, never by name', (file) => {
    const calls = code(file as string).match(/\bscriptFor\(/g) ?? [];
    expect(calls, `${file as string} still asks the hand-written registry by name`).toEqual([]);
  });

  it('automation.ts keeps exactly the two name lookups that have no definition', () => {
    /*
      A granted ability is recorded on the continuous effect as the granting card's **name** plus an
      index into its `grantedTriggers`, so there is no definition to ask with — and `grantedTriggers`
      is the one field the compiler never emits, because granting another permanent a triggered
      ability has no reader and is a refusal rather than a gap. So the registry is the complete
      answer at those two sites, not a partial one. Counted rather than left alone, so a third
      name lookup appearing in this file has to justify itself here.
    */
    const lines = code('automation.ts').split('\n').filter((line) => /\bscriptFor\(/.test(line));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toContain('grantedTriggers');
  });
});
