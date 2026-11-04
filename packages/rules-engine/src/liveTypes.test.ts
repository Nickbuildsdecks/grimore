/**
 * Target filters read the type line a permanent **has**, not the one it was printed with.
 *
 * Five hand-written filters read `cardDefs[...].typeLine` — Disenchant/Naturalize/Krosan Grip,
 * Ainok Survivalist's turn-up, Wane, Awoken Horror's bounce, and metalcraft's artifact count. Four
 * of the five had no comment about it and the fifth, `destroyAnArtifactOrEnchantment`, had a
 * docblock **claiming** the live reading that the code did not do (#319).
 *
 * Nothing in the pool could tell the difference, which is why it lasted: every artifact and
 * enchantment in it is printed as one. The difference appears the moment a continuous effect adds a
 * type — which this engine has done since Vehicles were crewed with `addTypes: ['Creature']` — and
 * then a Disenchant cannot touch a permanent that is an artifact.
 */
import { describe, expect, it } from 'vitest';
import { pump } from './effects.js';
import { scriptFor } from './scripts.js';
import { characteristicsOf, hasType } from './characteristics.js';
import { arena, find } from './testkit.js';
import type { SeatIndex } from './types.js';
import type { TargetSpec } from './scriptTypes.js';

const specOf = (card: string): TargetSpec => {
  const spec = (scriptFor(card)?.targets ?? [])[0];
  if (spec === undefined) throw new Error(`${card} has no target spec`);
  return spec;
};

describe('a filter reads the live type line', () => {
  /**
   * A board where printed and live disagree: a plain green creature that a continuous effect has
   * made an **artifact**, which is what `pump`'s `addTypes` does for a crewed Vehicle.
   */
  const boardWithAnArtifactCreature = () => {
    const base = arena({
      decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
      battlefield: { 0: ['Grizzly Bears'], 1: ['Grizzly Bears'] },
      turn: 3,
    });
    const mine = find(base, 0 as SeatIndex, 'battlefield', 'Grizzly Bears');
    const theirs = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
    const state = pump(base, [theirs], theirs, 1 as SeatIndex, { addTypes: ['Artifact'] });
    return { state, mine, theirs };
  };

  it('the fixture itself disagrees with the print, or it proves nothing', () => {
    const { state, theirs } = boardWithAnArtifactCreature();
    const inst = state.instances[theirs]!;
    // Printed: a bear. Live: an artifact bear.
    expect(state.cardDefs[inst.defKey]?.typeLine).not.toMatch(/artifact/i);
    expect(hasType(characteristicsOf(state, inst).typeLine, 'artifact')).toBe(true);
  });

  it('Wane can destroy a permanent that has been made an enchantment', () => {
    const base = arena({
      decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
      battlefield: { 1: ['Grizzly Bears'] },
      turn: 3,
    });
    const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
    const state = pump(base, [bear], bear, 1 as SeatIndex, { addTypes: ['Enchantment'] });
    expect(hasType(characteristicsOf(state, state.instances[bear]!).typeLine, 'enchantment'))
      .toBe(true);
    expect(specOf('Wane').filter?.(state, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1'))
      .toBe(true);
    // And refuses the same creature before anything made it one.
    expect(specOf('Wane').filter?.(base, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1'))
      .toBe(false);
  });

  it('Golgari Charm’s enchantment mode reads the live type line too', () => {
    /*
      The sixth site of this class, found while giving that mode a compiler reading: it read
      `parseTypeLine(cardDefs[...].typeLine)` inline, so a permanent *made* an enchantment was not a
      legal target for it. It uses the shared `permanentOfTypes` filter now, like every other
      enchantment phrase — which is also what makes the compiled mode's spec comparable to the
      hand-written one.
    */
    const base = arena({
      decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
      battlefield: { 1: ['Grizzly Bears'] },
      turn: 3,
    });
    const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
    const state = pump(base, [bear], bear, 1 as SeatIndex, { addTypes: ['Enchantment'] });
    const mode = (scriptFor('Golgari Charm')?.modal?.modes ?? [])[1];
    const spec = (mode?.targets ?? [])[0];
    expect(spec?.description).toBe('target enchantment');
    expect(spec?.filter?.(state, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1')).toBe(true);
    // And refuses the same creature before anything made it one.
    expect(spec?.filter?.(base, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1')).toBe(false);
  });

  it('Garruk’s +1 can untap a permanent that has been made a land', () => {
    /*
      The seventh site of this class, found like the sixth: by giving the line a compiler reading and
      needing the two specs to agree. "Untap two target lands" should take a permanent that *is* a
      land however it got there (CR 613), and `parseTypeLine` on the card definition could not see
      one.
    */
    const base = arena({
      decks: { 0: 'verdant-guard', 1: 'verdant-guard' },
      battlefield: { 1: ['Grizzly Bears'] },
      turn: 3,
    });
    const bear = find(base, 1 as SeatIndex, 'battlefield', 'Grizzly Bears');
    const state = pump(base, [bear], bear, 1 as SeatIndex, { addTypes: ['Land'] });
    const spec = ((scriptFor('Garruk Wildspeaker')?.abilities ?? [])[0]?.targets ?? [])[0];
    expect(spec?.description).toBe('target land');
    expect(spec?.filter?.(state, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1')).toBe(true);
    // And refuses the same creature before anything made it one.
    expect(spec?.filter?.(base, { kind: 'card', id: bear }, 0 as SeatIndex, 'c1')).toBe(false);
  });

  it.each([
    ['Disenchant'],
    ['Naturalize'],
    ['Krosan Grip'],
  ])('%s can destroy a permanent that has been made an artifact', (card) => {
    const { state, theirs } = boardWithAnArtifactCreature();
    const spec = specOf(card as string);
    expect(spec.filter?.(state, { kind: 'card', id: theirs }, 0 as SeatIndex, 'c1')).toBe(true);
  });

  it('and still refuses one that is neither, however it is printed', () => {
    const { state, mine } = boardWithAnArtifactCreature();
    const spec = specOf('Disenchant');
    expect(spec.filter?.(state, { kind: 'card', id: mine }, 0 as SeatIndex, 'c1')).toBe(false);
  });

  it("Ainok Survivalist's turn-up reads it live too, and still only an opponent's", () => {
    const { state, mine, theirs } = boardWithAnArtifactCreature();
    const spec = (scriptFor('Ainok Survivalist')?.triggers ?? [])
      .flatMap((t) => t.targets ?? [])[0];
    expect(spec, 'no turn-up target').toBeDefined();
    expect(spec?.filter?.(state, { kind: 'card', id: theirs }, 0 as SeatIndex, 'c1')).toBe(true);
    // Mine is not an artifact *and* is mine: the clause the card prints is both halves.
    expect(spec?.filter?.(state, { kind: 'card', id: mine }, 0 as SeatIndex, 'c1')).toBe(false);
  });

  it("Galvanic Blast counts the third artifact a continuous effect made", () => {
    /*
      "Metalcraft — deals 4 damage instead if you control three or more artifacts." The board below
      has **two** printed artifacts and one creature a continuous effect has made an artifact, so the
      live count is three and the printed count is two: 4 damage under the right reading, 1 under the
      wrong one.

      Galvanic Blast and not Chrome Steed, and the difference matters. The Steed's `+2/+2 while
      METALCRAFT` is a conditional *static*, and its condition is evaluated by `conditionMet` inside
      `characteristicsOf` — which reads the printed line deliberately, because asking for a live type
      line from in there would re-enter the whole computation. So that count is **not** fixed by this
      change, and the reason is written at both ends. This spell's count runs while the spell
      resolves, where there is nothing to recurse into.
    */
    const base = arena({
      decks: { 0: 'forge-alliance', 1: 'forge-alliance' },
      battlefield: {
        0: ['Bonesplitter', 'Frogmite', 'Elite Vanguard'],
        // A 2/2 from the same deck, so 4 damage kills it where 1 does not.
        1: ['Youthful Knight'],
      },
      turn: 3,
    });
    const live = (state: typeof base, id: string) =>
      hasType(characteristicsOf(state, state.instances[id]!).typeLine, 'artifact');
    const vanguard = find(base, 0 as SeatIndex, 'battlefield', 'Elite Vanguard');
    const victim = find(base, 1 as SeatIndex, 'battlefield', 'Youthful Knight');
    // Two printed artifacts, and the Vanguard is not one of them.
    expect([
      live(base, find(base, 0 as SeatIndex, 'battlefield', 'Bonesplitter')),
      live(base, find(base, 0 as SeatIndex, 'battlefield', 'Frogmite')),
      live(base, vanguard),
    ]).toEqual([true, true, false]);

    const made = pump(base, [vanguard], vanguard, 0 as SeatIndex, { addTypes: ['Artifact'] });
    expect(live(made, vanguard), 'the fixture did not make it an artifact').toBe(true);

    const resolve = scriptFor('Galvanic Blast')?.onResolve;
    expect(resolve, 'Galvanic Blast has no resolution').toBeDefined();
    const after = resolve!({
      state: made,
      controller: 0 as SeatIndex,
      source: 'c1',
      targets: [{ kind: 'card', id: victim }],
    } as never);
    // A 2/2 Youthful Knight: 4 damage kills it where 1 does not.
    expect(after.instances[victim]?.damage, 'the third artifact did not count').toBe(4);
  });
});
