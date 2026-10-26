/**
 * A deck somebody pasted in: what the pool gives it, and what it does with a name the pool lacks.
 *
 * The split these tests hold in place is the point of the feature. A name the engine knows becomes
 * the real card — the same script, cost and type line it has in the deck it came from — and a name
 * it does not becomes cardboard, playable on the tabletop and refused by Arena mode. Either half
 * failing quietly would be worse than the feature not existing: a list that lost half its cards, or
 * an automated game dealt with a card nobody can do anything with.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction, createGame, customDeck, deckIsAutomatable, poolCardNamed, STARTER_DECKS,
} from './index.js';
import { PLAYERS } from './testkit.js';
import type { Action, ActionContext, GameState } from './types.js';

describe('looking a pasted name up in the pool', () => {
  it('finds the card, whatever case and spacing the list was written in', () => {
    const bolt = poolCardNamed('Lightning Bolt');
    expect(bolt?.name).toBe('Lightning Bolt');
    expect(poolCardNamed('  lightning bolt  ')).toBe(bolt);
    expect(poolCardNamed('LIGHTNING BOLT')).toBe(bolt);
  });

  it('finds a commander, which is in the pool but in no deck list', () => {
    // Commanders live on `deck.commander`, not in `deck.cards`, so a pool built only from the
    // lists would quietly refuse every Commander deck anybody pasted.
    expect(poolCardNamed('Tatyova, Benthic Druid')?.typeLine).toContain('Legendary');
  });

  it('has nothing for a card the engine has never scripted', () => {
    expect(poolCardNamed('Black Lotus')).toBeUndefined();
    expect(poolCardNamed('Rhystic Study')).toBeUndefined();
  });
});

describe('building a deck out of a pasted list', () => {
  const list = (entries: readonly { name: string; count: number }[], commander?: string) =>
    customDeck({
      id: 'custom:0', name: 'Nick’s list', entries,
      ...(commander === undefined ? {} : { commander }),
    });

  it('uses the pool’s card, with its script and its cost, for a name it knows', () => {
    const { deck, unknown } = list([{ name: 'lightning bolt', count: 4 }]);
    expect(unknown).toEqual([]);
    expect(deck.cards[0]!.count).toBe(4);
    expect(deck.cards[0]!.card).toBe(poolCardNamed('Lightning Bolt'));
  });

  it('makes cardboard for a name it does not, and says which names those were', () => {
    const { deck, unknown } = list([
      { name: 'Lightning Bolt', count: 4 },
      { name: 'Black Lotus', count: 1 },
      { name: 'Mana Crypt', count: 1 },
    ]);
    // In the spelling the list used, because the player has to find those lines in their own text.
    expect(unknown).toEqual(['Black Lotus', 'Mana Crypt']);
    const ring = deck.cards.find((e) => e.card.name === 'Black Lotus')!.card;
    // The empty type line is the marker the engine reads. A type line it invented would make this
    // card look like something it can reason about, which is exactly what it is not.
    expect(ring.typeLine).toBe('');
    expect(ring.oracleText).toContain('by hand');
  });

  it('keeps the list’s order and its counts', () => {
    const { deck } = list([
      { name: 'Mountain', count: 24 },
      { name: 'Shock', count: 2 },
    ]);
    expect(deck.cards.map((e) => [e.card.name, e.count])).toEqual([['Mountain', 24], ['Shock', 2]]);
  });

  it('puts a commander it knows in the command zone', () => {
    const { deck, unknown } = list([{ name: 'Forest', count: 1 }], 'Tatyova, Benthic Druid');
    expect(unknown).toEqual([]);
    expect(deck.commander?.name).toBe('Tatyova, Benthic Druid');
  });

  it('reports a commander it does not know, and still seats it as cardboard', () => {
    const { deck, unknown } = list([{ name: 'Forest', count: 1 }], 'Atraxa, Praetors’ Voice');
    expect(unknown).toEqual(['Atraxa, Praetors’ Voice']);
    expect(deck.commander?.typeLine).toBe('');
  });

  it('leaves the command zone empty when the list named no commander', () => {
    expect(list([{ name: 'Forest', count: 1 }]).deck.commander).toBeUndefined();
  });
});

describe('whether the engine can play the list', () => {
  it('says yes to a list built entirely out of the pool', () => {
    const { deck } = customDeck({
      id: 'custom:0', name: 'All pool',
      entries: [{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 20 }],
      commander: 'Tatyova, Benthic Druid',
    });
    expect(deckIsAutomatable(deck)).toBe(true);
  });

  it('says no to one card of cardboard', () => {
    const { deck } = customDeck({
      id: 'custom:0', name: 'Nearly',
      entries: [{ name: 'Mountain', count: 59 }, { name: 'Black Lotus', count: 1 }],
    });
    expect(deckIsAutomatable(deck)).toBe(false);
  });

  it('says no to a commander of cardboard, even when every other card is real', () => {
    const { deck } = customDeck({
      id: 'custom:0', name: 'Blank general',
      entries: [{ name: 'Forest', count: 60 }],
      commander: 'Atraxa, Praetors’ Voice',
    });
    expect(deckIsAutomatable(deck)).toBe(false);
  });

  it('says yes to every built-in deck, which is the pool it is asking about', () => {
    for (const deck of Object.values(STARTER_DECKS)) expect(deckIsAutomatable(deck)).toBe(true);
  });
});

describe('dealing a pasted list at a table', () => {
  const ctxFor = (entries: readonly { name: string; count: number }[]): ActionContext => ({
    isHost: true,
    // `custom:0` is the id the server gives seat zero's list; the engine takes whatever key it
    // is handed, and this is the one it is handed in practice.
    decks: { 'custom:0': customDeck({ id: 'custom:0', name: 'A list', entries }).deck },
  });
  const deal = (entries: readonly { name: string; count: number }[]): GameState => {
    const ctx = ctxFor(entries);
    let s = createGame({ id: 'g-custom', format: 'modern', players: PLAYERS, seed: 77 });
    for (const action of [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'custom:0' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'ember-rush' },
      { type: 'game:start', by: 0, firstSeat: 0 },
    ] as readonly Action[]) s = applyAction(s, action, ctx);
    return s;
  };
  const refusalOf = (s: GameState, action: Action): string | null => {
    try {
      applyAction(s, action, { isHost: true });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  it('deals the pasted list like any other deck', () => {
    const s = deal([{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 56 }]);
    expect(s.started).toBe(true);
    const mine = Object.values(s.instances).filter((i) => i.owner === 0);
    expect(mine).toHaveLength(60);
    expect(s.seats[0]!.deckId).toBe('custom:0');
  });

  it('runs the engine on it when every card is one the engine knows', () => {
    const s = deal([{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 56 }]);
    expect(refusalOf(s, { type: 'auto:start', by: 0 })).toBeNull();
  });

  it('refuses Arena mode when one card is cardboard, and names it', () => {
    // The tabletop is the honest answer here, so the refusal has to say which card and why rather
    // than failing somewhere in the first upkeep.
    const s = deal([{ name: 'Black Lotus', count: 1 }, { name: 'Mountain', count: 59 }]);
    const why = refusalOf(s, { type: 'auto:start', by: 0 });
    expect(why).toContain('Black Lotus');
    // And the tabletop still plays it, which is the point of refusing rather than dropping the card.
    expect(refusalOf(s, { type: 'zone:draw', by: 0, seat: 0, count: 1 })).toBeNull();
  });
});
