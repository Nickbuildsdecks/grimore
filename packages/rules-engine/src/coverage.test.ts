import { describe, expect, it } from 'vitest';
import { manualCards, manualNote } from './coverage.js';
import { STARTER_DECKS } from './starterDecks.js';
import { arena } from './testkit.js';
import type { CardDef } from './cards.js';
import type { GameState } from './types.js';

/**
 * `manualCards` reads exactly one field of the state — `cardDefs` — so a test can hand it that
 * field and nothing else.
 *
 * The cast is argued rather than hoped (D362): the function's whole body is one loop over
 * `Object.values(state.cardDefs)`, so a field this fixture omits is a field it cannot read. If that
 * ever stops being true the compiler stops accepting this file, because `GameState`'s other fields
 * are not optional.
 */
const withDefs = (defs: readonly CardDef[]): GameState =>
  ({ cardDefs: Object.fromEntries(defs.map((def, i) => [`k${i}`, def])) } as unknown as GameState);

const card = (over: Partial<CardDef> & { name: string }): CardDef => ({
  typeLine: 'Creature — Human', manaCost: '{1}{W}', cmc: 2, colors: ['W'],
  power: '1', toughness: '1', oracleText: '', ...over,
});

describe('manualCards', () => {
  /*
    The false-positive guard, and the reason this file exists at the same time as the compiler being
    wired into the engine's live path.

    Every card in the pool has a hand-written script, so `unreadLines` returns nothing for it and
    the compiler is never asked what *it* could read off the same text. Without that rule this check
    would report a Kitchen Finks as partly manual — the compiler cannot read every line of it — and
    the lobby would tell a player to hand-play thirteen decks that have been fully automated since
    task #15.
  */
  it('reports nothing for any of the thirteen built-in decks', () => {
    for (const id of Object.keys(STARTER_DECKS)) {
      const state = arena({ decks: { 0: id, 1: id } });
      expect(manualCards(state), `${id} reported cards as manual`).toEqual([]);
    }
  });

  it('still reports a name that resolved to no printed data at all', () => {
    const manual = manualCards(withDefs([
      { name: 'Nonsense Card', typeLine: '', manaCost: '', cmc: 0, colors: [], oracleText: '' },
    ]));
    expect(manual).toHaveLength(1);
    expect(manual[0]?.reason).toBe('no-printed-data');
    expect(manual[0]?.detail).toContain('no card data under this name');
  });

  it('reports a real card whose printed sentence nothing is running', () => {
    /*
      A card with a type line, a cost and a body, so the engine deals it, casts it and attacks with
      it — and a line of text the compiler has no reader for. Before the compiler was wired in,
      this card passed for fully automated and its text silently did nothing.
    */
    const manual = manualCards(withDefs([card({
      name: 'Unread Thing',
      oracleText: 'Whenever Unread Thing becomes the target of a spell, scry 7 and dance.',
    })]));
    expect(manual).toHaveLength(1);
    expect(manual[0]?.reason).toBe('text-not-automated');
    // The detail quotes the line, because "this card is partly manual" is not actionable and
    // "this sentence does nothing" is.
    expect(manual[0]?.detail).toContain('scry 7 and dance');
  });

  it('does not report a card whose only unread line is a keyword it cannot build', () => {
    /*
      D370's distinction, carried all the way to the player. `Equip {1}` is a keyword the compiler
      recognises and has no builder for, so the Equipment is cast and sits on the battlefield and
      the equip ability is the option that is missing. Telling a player to move it by hand would be
      wrong about a card the engine is running — and `Vigilance`, which the engine reads straight off
      the oracle text with no script at all, would be wronger still.
    */
    const manual = manualCards(withDefs([card({
      name: 'Plain Blade',
      typeLine: 'Artifact — Equipment',
      power: undefined, toughness: undefined,
      oracleText: 'Equip {1}',
    })]));
    expect(manual).toEqual([]);
  });

  it('does not report a card the compiler reads completely', () => {
    const manual = manualCards(withDefs([card({
      name: 'Fully Read',
      oracleText: 'When Fully Read enters the battlefield, you gain 2 life.',
    })]));
    expect(manual).toEqual([]);
  });

  it('reports both kinds in one game, and counts the lines of the partial one', () => {
    const manual = manualCards(withDefs([
      { name: 'Nonsense Card', typeLine: '', manaCost: '', cmc: 0, colors: [], oracleText: '' },
      card({
        name: 'Half Read',
        oracleText: 'When Half Read enters the battlefield, you gain 2 life.\nDance whenever you'
          + ' like.\nSing twice as often.',
      }),
    ]));
    expect(manual.map((m) => m.reason)).toEqual(['Half Read', 'Nonsense Card']
      .map((n) => (n === 'Half Read' ? 'text-not-automated' : 'no-printed-data')));
    expect(manual.find((m) => m.name === 'Half Read')?.detail).toContain('2 of its lines');
  });
});

describe('manualNote', () => {
  it('says "cannot fully play", because the list holds two different things', () => {
    /*
      It used to say "cannot play", which was true when every entry was a card with no printed data
      and is a lie about a card the engine casts and attacks with. A player who catches the line
      lying once stops reading it, and this line is the only warning some of them will see.
    */
    const note = manualNote([
      { name: 'Half Read', reason: 'text-not-automated', detail: 'x' },
    ]);
    expect(note).toContain('cannot fully play this card');
    expect(note).toContain('Half Read');
  });

  it('says nothing when there is nothing to say', () => {
    expect(manualNote([])).toBeNull();
  });

  it('caps the names and counts the rest', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `Card ${i}`, reason: 'no-printed-data' as const, detail: 'x',
    }));
    const note = manualNote(many) ?? '';
    expect(note).toContain('and 3 more');
    expect(note).not.toContain('Card 8');
  });
});

describe('the size of what travels', () => {
  it('caps the quoted line, because this list rides inside a capped view', () => {
    /*
      The per-seat view has a hard 128 KiB cap and `wire-growth.mjs` cannot measure this list —
      every deck it can build is a pool deck, every pool card has a hand-written script, so
      `manual` is empty in every game it plays. The bound is therefore arithmetic: a hundred
      distinct cards each quoting one unabridged paragraph is about 47 KiB added to a 47 KiB peak.
      See `QUOTE_CAP`.
    */
    const long = `Whenever ${'something tremendously long happens '.repeat(12)}, dance.`;
    const manual = manualCards(withDefs([card({ name: 'Wordy', oracleText: long })]));
    expect(manual).toHaveLength(1);
    const detail = manual[0]?.detail ?? '';
    // 227 at the cap: 107 bytes of fixed prose plus the quote. A hundred of these is 23 KiB, which
    // is the figure `QUOTE_CAP`'s arithmetic rests on, so the assertion is the figure and not a
    // round number near it.
    expect(detail.length).toBeLessThanOrEqual(227);
    expect(detail).toContain('…');
    // Still enough of the line to recognise which one it is.
    expect(detail).toContain('Whenever something tremendously long happens');
  });
});
