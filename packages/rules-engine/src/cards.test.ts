/**
 * The card layer: zones, movement, redaction, and one complete game.
 *
 * The last test in this file is the point of all of it — it plays a real game from two shuffled
 * decks to a winner using only the actions a client can send. If that passes, two people can play.
 */
import { describe, it, expect } from 'vitest';
import {
  STARTER_DECKS,
  applyAction,
  applyMany,
  createGame,
  defKeyFor,
  deckSize,
  viewFor,
  zoneKey,
  type Action,
  type GameState,
  type SeatIndex,
} from './index.js';
import { WIRE_CAP } from './testkit.js';

const TWO = [
  { playerId: 'p-nick', name: 'Nick' },
  { playerId: 'p-friend', name: 'Friend' },
];

const newTable = (format: 'modern' | 'edh' | 'pod' = 'modern'): GameState =>
  createGame({ id: 'game-test', format, players: TWO, seed: 20261023 });

const ids = (s: GameState, seat: SeatIndex, zone: Parameters<typeof zoneKey>[1]): readonly string[] =>
  s.zones[zoneKey(seat, zone)] ?? [];
const count = (s: GameState, seat: SeatIndex, zone: Parameters<typeof zoneKey>[1]): number =>
  ids(s, seat, zone).length;
const nameOf = (s: GameState, id: string): string => s.cardDefs[s.instances[id]!.defKey]!.name;

/** Loads both starter decks without starting, which is the pre-game state every test wants. */
function loaded(format: 'modern' | 'edh' | 'pod' = 'modern'): GameState {
  return applyMany(newTable(format), [
    { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
    { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
  ]);
}

const firstInZone = (s: GameState, seat: SeatIndex, zone: Parameters<typeof zoneKey>[1]): string => {
  const id = ids(s, seat, zone)[0];
  if (id === undefined) throw new Error(`seat ${seat} has nothing in ${zone}`);
  return id;
};

describe('starter decks', () => {
  it('ships decks that are exactly 60 cards plus a commander', () => {
    expect(Object.keys(STARTER_DECKS).sort())
      .toEqual([
        'arc-tempest', 'ashen-rite', 'blight-vector', 'dawn-tithe', 'delta-bloom', 'ember-rush',
        'forge-alliance', 'hollow-tide', 'rot-harvest', 'skyward-writ', 'tidal-mind',
        'verdant-guard',
      ]);
    for (const deck of Object.values(STARTER_DECKS)) {
      expect(deckSize(deck)).toBe(61);
      expect(deck.commander).toBeDefined();
    }
  });

  it('gives every card a legible face without needing artwork', () => {
    // This environment cannot reach Scryfall and a fresh database has no images, so a card that
    // relied on one would render blank. Name and type line are the minimum to play with.
    for (const deck of Object.values(STARTER_DECKS)) {
      for (const entry of [...deck.cards.map((c) => c.card), deck.commander!]) {
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.typeLine.length).toBeGreaterThan(0);
        expect(entry.imageUri).toBeUndefined();
      }
    }
  });
});

describe('deck:load', () => {
  it('shuffles 60 cards into the library and the commander into the command zone', () => {
    const s = loaded('edh');
    expect(count(s, 0, 'library')).toBe(60);
    expect(count(s, 0, 'command')).toBe(1);
    expect(nameOf(s, firstInZone(s, 0, 'command'))).toBe('Krenko, Mob Boss');
    expect(count(s, 1, 'library')).toBe(60);
    expect(nameOf(s, firstInZone(s, 1, 'command'))).toBe('Sigarda, Host of Herons');
    expect(s.seats[0]!.deckId).toBe('ember-rush');
  });

  it('puts the commander in the library in a format with no command zone', () => {
    const s = loaded('modern');
    expect(count(s, 0, 'library')).toBe(61);
    expect(count(s, 0, 'command')).toBe(0);
  });

  it('shuffles deterministically from the game seed', () => {
    expect(ids(loaded(), 0, 'library')).toEqual(ids(loaded(), 0, 'library'));
  });

  it('actually shuffles rather than dealing the list in order', () => {
    // Ember Rush lists 22 Mountains first, so an unshuffled library would open with 22 of them.
    const first22 = ids(loaded(), 0, 'library').slice(0, 22).map((id) => nameOf(loaded(), id));
    expect(first22.every((n) => n === 'Mountain')).toBe(false);
  });

  it('replaces rather than stacks when a seat loads a second deck', () => {
    const s = applyAction(loaded(), { type: 'deck:load', by: 0, seat: 0, deckId: 'verdant-guard' });
    expect(count(s, 0, 'library')).toBe(61);
    expect(count(s, 1, 'library')).toBe(61);
    expect(Object.values(s.instances).filter((i) => i.owner === 0)).toHaveLength(61);
  });

  it('refuses an unknown deck, and refuses to load after the game starts', () => {
    expect(() => applyAction(newTable(), { type: 'deck:load', by: 0, seat: 0, deckId: 'nope' }))
      .toThrow(/no deck with id/);
    const started = applyAction(loaded(), { type: 'game:start', by: 0 });
    expect(() => applyAction(started, { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' }))
      .toThrow(/before the game starts/);
  });

  it('accepts a deck supplied by the caller, which is the seam for real Grimore decks', () => {
    const custom = {
      id: 'custom',
      name: 'One Bolt',
      description: 'test',
      cards: [{ card: { name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}', cmc: 1, oracleText: 'x', colors: ['R'] }, count: 3 }],
    };
    const s = applyAction(newTable(), { type: 'deck:load', by: 0, seat: 0, deckId: 'custom' }, { decks: { custom } });
    expect(count(s, 0, 'library')).toBe(3);
  });
});

describe('game:start', () => {
  it('deals seven to each seat that loaded a deck', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    expect(count(s, 0, 'hand')).toBe(7);
    expect(count(s, 1, 'hand')).toBe(7);
    expect(count(s, 0, 'library')).toBe(61 - 7);
    expect(s.started).toBe(true);
    expect(s.turn).toBe(1);
  });

  it('leaves a table with no decks exactly as it was, so a life-tracker table is unaffected', () => {
    const s = applyAction(newTable(), { type: 'game:start', by: 0 });
    expect(s.started).toBe(true);
    expect(Object.keys(s.instances)).toHaveLength(0);
    expect(s.log.at(-1)!.message).not.toMatch(/opening hand/);
  });
});

describe('drawing and the library', () => {
  it('draws from the top of the library into hand', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const top = firstInZone(s, 0, 'library');
    const next = applyAction(s, { type: 'zone:draw', by: 0, seat: 0, count: 1 });
    expect(count(next, 0, 'hand')).toBe(8);
    expect(ids(next, 0, 'hand').at(-1)).toBe(top);
  });

  it('refuses to draw from an empty library rather than silently doing nothing', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    // 54 left after the opening hand; empty it.
    for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'zone:draw', by: 0, seat: 0, count: 18 });
    expect(count(s, 0, 'library')).toBe(0);
    expect(() => applyAction(s, { type: 'zone:draw', by: 0, seat: 0, count: 1 })).toThrow(/no cards left/);
  });

  it('reports a short draw honestly when the library runs out mid-draw', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'zone:draw', by: 0, seat: 0, count: 17 });
    expect(count(s, 0, 'library')).toBe(3);
    const next = applyAction(s, { type: 'zone:draw', by: 0, seat: 0, count: 10 });
    expect(next.log.at(-1)!.data!['drawn']).toBe(3);
    expect(next.log.at(-1)!.data!['requested']).toBe(10);
  });

  it('will not let one seat draw for another', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    expect(() => applyAction(s, { type: 'zone:draw', by: 1, seat: 0, count: 1 })).toThrow(/may not modify/);
  });
});

describe('moving cards', () => {
  it('moves a card between every zone and back', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const card = firstInZone(s, 0, 'hand');
    for (const zone of ['battlefield', 'graveyard', 'exile', 'hand', 'command'] as const) {
      s = applyAction(s, { type: 'card:move', by: 0, card, toZone: zone });
      expect(s.instances[card]!.zone).toBe(zone);
      expect(ids(s, 0, zone)).toContain(card);
    }
    s = applyAction(s, { type: 'card:move', by: 0, card, toZone: 'library', position: 'top' });
    expect(firstInZone(s, 0, 'library')).toBe(card);
  });

  it('puts a card on the bottom of the library when asked', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const card = firstInZone(s, 0, 'hand');
    s = applyAction(s, { type: 'card:move', by: 0, card, toZone: 'library', position: 'bottom' });
    expect(ids(s, 0, 'library').at(-1)).toBe(card);
  });

  it('clears tapped, counters and attachment when a card leaves the battlefield', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const card = firstInZone(s, 0, 'hand');
    s = applyMany(s, [
      { type: 'card:move', by: 0, card, toZone: 'battlefield' },
      { type: 'card:tap', by: 0, card },
      { type: 'card:counter', by: 0, card, key: '+1/+1', delta: 2 },
    ]);
    expect(s.instances[card]!.tapped).toBe(true);
    expect(s.instances[card]!.counters['+1/+1']).toBe(2);
    s = applyAction(s, { type: 'card:move', by: 0, card, toZone: 'graveyard' });
    expect(s.instances[card]!.tapped).toBe(false);
    expect(s.instances[card]!.counters).toEqual({});
  });

  it('sends a card home to its owner by default, even from the other side of the table', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const card = firstInZone(s, 0, 'hand');
    s = applyMany(s, [
      { type: 'card:move', by: 0, card, toZone: 'battlefield' },
      // Seat 1 steals it, then it dies.
      { type: 'card:control', by: 0, card, toSeat: 1 },
    ]);
    expect(s.instances[card]!.zoneSeat).toBe(1);
    expect(s.instances[card]!.owner).toBe(0);
    expect(ids(s, 1, 'battlefield')).toContain(card);
    s = applyAction(s, { type: 'card:move', by: 1, card, toZone: 'graveyard' });
    // Owner's graveyard, not the thief's — that is why owner and zoneSeat are separate.
    expect(ids(s, 0, 'graveyard')).toContain(card);
    expect(ids(s, 1, 'graveyard')).not.toContain(card);
  });

  it('refuses to let a seat reach across the table for a card it does not hold', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const theirs = firstInZone(s, 1, 'hand');
    expect(() => applyAction(s, { type: 'card:move', by: 0, card: theirs, toZone: 'graveyard' }))
      .toThrow(/may not move a card/);
  });

  it('lets the host move anything, which is how a table fixes a mistake', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const theirs = firstInZone(s, 1, 'hand');
    const next = applyAction(s, { type: 'card:move', by: 0, card: theirs, toZone: 'graveyard' }, { isHost: true });
    expect(ids(next, 1, 'graveyard')).toContain(theirs);
  });

  it('rejects an unknown card id and an unknown zone', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    expect(() => applyAction(s, { type: 'card:move', by: 0, card: 'nope', toZone: 'hand' })).toThrow(/no card with id/);
    const card = firstInZone(s, 0, 'hand');
    expect(() => applyAction(s, { type: 'card:move', by: 0, card, toZone: 'pocket' as 'hand' })).toThrow(/unknown zone/);
  });
});

describe('attachments', () => {
  it('attaches an aura to a creature and detaches it when the creature leaves', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const [aura, creature] = ids(s, 0, 'hand');
    s = applyMany(s, [
      { type: 'card:move', by: 0, card: aura!, toZone: 'battlefield' },
      { type: 'card:move', by: 0, card: creature!, toZone: 'battlefield' },
      { type: 'card:attach', by: 0, card: aura!, to: creature! },
    ]);
    expect(s.instances[aura!]!.attachedTo).toBe(creature);
    // The creature dies; nothing may be left pointing at a card that is gone.
    s = applyAction(s, { type: 'card:move', by: 0, card: creature!, toZone: 'graveyard' });
    expect(s.instances[aura!]!.attachedTo).toBeNull();
  });

  it('refuses to attach a card to itself, off the battlefield, or onto another attachment', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const [a, b, c] = ids(s, 0, 'hand');
    s = applyMany(s, [
      { type: 'card:move', by: 0, card: a!, toZone: 'battlefield' },
      { type: 'card:move', by: 0, card: b!, toZone: 'battlefield' },
      { type: 'card:move', by: 0, card: c!, toZone: 'battlefield' },
    ]);
    expect(() => applyAction(s, { type: 'card:attach', by: 0, card: a!, to: a! })).toThrow(/attached to itself/);
    s = applyAction(s, { type: 'card:attach', by: 0, card: a!, to: b! });
    expect(() => applyAction(s, { type: 'card:attach', by: 0, card: c!, to: a! })).toThrow(/itself attached/);
    const inHand = firstInZone(s, 0, 'hand');
    expect(() => applyAction(s, { type: 'card:attach', by: 0, card: inHand, to: b! })).toThrow(/must be on the battlefield/);
  });
});

describe('tokens', () => {
  it('creates tokens on the battlefield and destroys them when they leave it', () => {
    const goblin = { name: 'Goblin', typeLine: 'Token Creature — Goblin', manaCost: '', cmc: 0, power: '1', toughness: '1', oracleText: '', colors: ['R'] };
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    s = applyAction(s, { type: 'token:create', by: 0, seat: 0, card: goblin, count: 3 });
    expect(count(s, 0, 'battlefield')).toBe(3);
    const token = firstInZone(s, 0, 'battlefield');
    s = applyAction(s, { type: 'card:move', by: 0, card: token, toZone: 'graveyard' });
    // A token in a graveyard is not a thing; it ceases to exist, as it does on a table.
    expect(s.instances[token]).toBeUndefined();
    expect(count(s, 0, 'graveyard')).toBe(0);
    expect(count(s, 0, 'battlefield')).toBe(2);
  });

  it('caps how many tokens one action can make', () => {
    const t = { name: 'Goblin', typeLine: 'Token Creature', manaCost: '', cmc: 0, oracleText: '', colors: [] };
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    expect(() => applyAction(s, { type: 'token:create', by: 0, seat: 0, card: t, count: 999 }))
      .toThrow(/must be between/);
  });
});

describe('untap and turns', () => {
  it('untaps only the asking seat’s permanents', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const mine = firstInZone(s, 0, 'hand');
    const theirs = firstInZone(s, 1, 'hand');
    s = applyMany(s, [
      { type: 'card:move', by: 0, card: mine, toZone: 'battlefield' },
      { type: 'card:tap', by: 0, card: mine, tapped: true },
      { type: 'card:move', by: 1, card: theirs, toZone: 'battlefield' },
      { type: 'card:tap', by: 1, card: theirs, tapped: true },
      { type: 'turn:untapAll', by: 0, seat: 0 },
    ]);
    expect(s.instances[mine]!.tapped).toBe(false);
    expect(s.instances[theirs]!.tapped).toBe(true);
  });
});

describe('mulligan', () => {
  it('puts the hand back, shuffles, draws seven and counts the mulligan', () => {
    const start = applyAction(loaded(), { type: 'game:start', by: 0 });
    const opening = ids(start, 0, 'hand');
    const s = applyAction(start, { type: 'mulligan', by: 0, seat: 0 });
    expect(count(s, 0, 'hand')).toBe(7);
    expect(count(s, 0, 'library')).toBe(61 - 7);
    expect(s.seats[0]!.mulligans).toBe(1);
    expect(ids(s, 0, 'hand')).not.toEqual(opening);
    // The opponent is untouched.
    expect(ids(s, 1, 'hand')).toEqual(ids(start, 1, 'hand'));
  });

  it('refuses on a seat with no deck', () => {
    const s = applyAction(newTable(), { type: 'game:start', by: 0 });
    expect(() => applyAction(s, { type: 'mulligan', by: 0, seat: 0 })).toThrow(/no deck loaded/);
  });
});

describe('redaction', () => {
  it('shows a seat its own hand and withholds the other hand', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const mine = viewFor(s, 0);
    for (const id of ids(s, 0, 'hand')) expect(mine.cards[id]!.card).toBeDefined();
    // The ids travel so the grip can be counted and drawn; the identities do not.
    for (const id of ids(s, 1, 'hand')) {
      expect(mine.cards[id]).toBeDefined();
      expect(mine.cards[id]!.card).toBeUndefined();
    }
    expect(mine.seats[1]!.handCount).toBe(7);
  });

  it('hides a library from its own owner, because otherwise they know every draw', () => {
    const s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const mine = viewFor(s, 0);
    expect(mine.zones[zoneKey(0, 'library')]).toBeUndefined();
    expect(mine.seats[0]!.libraryCount).toBe(54);
    for (const id of ids(s, 0, 'library')) expect(mine.cards[id]).toBeUndefined();
  });

  it('opens a library only to the seat searching it, and shuffling closes it again', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    s = applyAction(s, { type: 'zone:search', by: 0, seat: 0, searching: true });
    const searching = viewFor(s, 0);
    expect(searching.zones[zoneKey(0, 'library')]).toHaveLength(54);
    expect(searching.cards[firstInZone(s, 0, 'library')]!.card).toBeDefined();
    // Not to the opponent, even while it is open.
    expect(viewFor(s, 1).zones[zoneKey(0, 'library')]).toBeUndefined();

    s = applyAction(s, { type: 'zone:shuffle', by: 0, seat: 0, zone: 'library' });
    expect(s.seats[0]!.searching).toBe(false);
    expect(viewFor(s, 0).zones[zoneKey(0, 'library')]).toBeUndefined();
  });

  it('shows a face-down permanent only to the seat it sits with', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const card = firstInZone(s, 0, 'hand');
    s = applyMany(s, [
      { type: 'card:move', by: 0, card, toZone: 'battlefield' },
      { type: 'card:faceDown', by: 0, card, faceDown: true },
    ]);
    expect(viewFor(s, 0).cards[card]!.card).toBeDefined();
    expect(viewFor(s, 1).cards[card]!.card).toBeUndefined();
    expect(viewFor(s, 1).cards[card]!.faceDown).toBe(true);
    // And the public log must not name it either.
    expect(s.log.at(-1)!.message).not.toContain(nameOf(s, card));
  });

  it('lets a seat deliberately reveal a card from hand to everyone', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const card = firstInZone(s, 0, 'hand');
    expect(viewFor(s, 1).cards[card]!.card).toBeUndefined();
    s = applyAction(s, { type: 'card:reveal', by: 0, card, revealed: true });
    expect(viewFor(s, 1).cards[card]!.card).toBeDefined();
  });

  it('gives a spectator the public zones and nothing hidden', () => {
    let s = applyAction(loaded(), { type: 'game:start', by: 0 });
    const card = firstInZone(s, 0, 'hand');
    s = applyAction(s, { type: 'card:move', by: 0, card, toZone: 'battlefield' });
    const watcher = viewFor(s, null);
    expect(watcher.cards[card]!.card).toBeDefined();
    for (const id of ids(s, 1, 'hand')) expect(watcher.cards[id]!.card).toBeUndefined();
    expect(watcher.zones[zoneKey(0, 'library')]).toBeUndefined();
  });

  it('keeps a view comfortably inside the realtime payload cap', () => {
    // The full state is far larger than a view, which is the other reason redaction matters: a
    // board mid-game must still fit inside STATE_MAX_BYTES to reach the other player at all.
    let s = applyAction(loaded('edh'), { type: 'game:start', by: 0 });
    for (const seat of [0, 1] as const) {
      for (let i = 0; i < 7; i++) {
        s = applyAction(s, { type: 'card:move', by: seat, card: firstInZone(s, seat, 'hand'), toZone: 'battlefield' });
        s = applyAction(s, { type: 'zone:draw', by: seat, seat, count: 1 });
        s = applyAction(s, { type: 'card:move', by: seat, card: firstInZone(s, seat, 'hand'), toZone: 'graveyard' });
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(viewFor(s, 0))).length;
    expect(bytes).toBeLessThan(WIRE_CAP);
  });
});

describe('the log, which is how a player reconstructs a game', () => {
  it('says what an action did to the board, not only what was played', () => {
    // Detected by comparing the table before and after, the same way triggers are — so a card
    // written next year gets it without anyone remembering to add a line. Before this, a board
    // wipe read "Nick casts Golgari Charm" and four creatures died in silence.
    let s = applyMany(newTable('modern'), [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
      { type: 'game:start', by: 0, firstSeat: 0 },
    ]);
    const bear = firstInZone(s, 1, 'library');
    s = applyAction(s, { type: 'card:move', by: 1, card: bear, toZone: 'battlefield' });
    const name = nameOf(s, bear);

    s = applyAction(s, { type: 'card:move', by: 1, card: bear, toZone: 'graveyard' });
    expect(s.log[s.log.length - 1]!.message).toContain(`${name} dies`);

    s = applyAction(s, { type: 'life:adjust', by: 0, seat: 0, delta: -3 });
    // The new total is in the line, because "loses 3" without it means scrolling to find out.
    expect(s.log[s.log.length - 1]!.message).toContain('loses 3 (17)');

    s = applyAction(s, { type: 'life:adjust', by: 0, seat: 0, delta: 2 });
    expect(s.log[s.log.length - 1]!.message).toContain('gains 2 (19)');
  });

});

describe('a complete two-player game', () => {
  it('plays from shuffled decks to a winner using only actions a client can send', () => {
    // Nick on Ember Rush, his friend on Verdant Guard, 1v1 at 20 life.
    let s = applyMany(newTable('modern'), [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
      { type: 'game:start', by: 0, firstSeat: 0 },
    ]);
    expect(s.started).toBe(true);
    expect(count(s, 0, 'hand')).toBe(7);

    // Seat 1 does not like the grip and mulligans, then bottoms one.
    s = applyAction(s, { type: 'mulligan', by: 1, seat: 1 });
    s = applyAction(s, { type: 'card:move', by: 1, card: firstInZone(s, 1, 'hand'), toZone: 'library', position: 'bottom' });
    expect(count(s, 1, 'hand')).toBe(6);

    const act = (action: Action): void => { s = applyAction(s, action); };

    // Four turns each: untap, draw, play a card to the battlefield, tap it for mana, pass.
    for (let turn = 0; turn < 8; turn++) {
      const seat = (turn % 2) as SeatIndex;
      act({ type: 'turn:untapAll', by: seat, seat });
      // The player on the first turn of the game does not draw, as in a real game.
      if (turn > 0) act({ type: 'zone:draw', by: seat, seat, count: 1 });
      const inHand = ids(s, seat, 'hand')[0];
      if (inHand !== undefined) {
        act({ type: 'card:move', by: seat, card: inHand, toZone: 'battlefield' });
        act({ type: 'card:tap', by: seat, card: inHand, tapped: true });
      }
      act({ type: 'turn:pass', by: seat });
    }
    expect(s.turn).toBeGreaterThan(1);
    expect(count(s, 0, 'battlefield')).toBeGreaterThan(0);
    expect(count(s, 1, 'battlefield')).toBeGreaterThan(0);

    // Combat and spells are resolved by the players; the table records the result.
    act({ type: 'life:adjust', by: 0, seat: 0, delta: -3 });
    act({ type: 'life:adjust', by: 1, seat: 1, delta: -6 });
    expect(s.seats[0]!.life).toBe(17);
    expect(s.seats[1]!.life).toBe(14);

    // A creature trades, an aura gets attached, something is exiled, a token squad shows up.
    const mine = firstInZone(s, 0, 'battlefield');
    act({ type: 'card:move', by: 0, card: mine, toZone: 'graveyard' });
    expect(ids(s, 0, 'graveyard')).toContain(mine);
    const theirs = firstInZone(s, 1, 'battlefield');
    act({ type: 'card:move', by: 1, card: theirs, toZone: 'exile' });
    expect(ids(s, 1, 'exile')).toContain(theirs);
    act({ type: 'token:create', by: 0, seat: 0, card: { name: 'Goblin', typeLine: 'Token Creature — Goblin', manaCost: '', cmc: 0, power: '1', toughness: '1', oracleText: '', colors: ['R'] }, count: 4 });
    expect(count(s, 0, 'battlefield')).toBeGreaterThanOrEqual(4);

    // Dice for a coin-flip effect, and a search that gets closed by the shuffle.
    act({ type: 'dice:roll', by: 0, sides: 6, count: 2 });
    act({ type: 'zone:search', by: 1, seat: 1, searching: true });
    expect(viewFor(s, 1).zones[zoneKey(1, 'library')]).toBeDefined();
    act({ type: 'zone:shuffle', by: 1, seat: 1, zone: 'library' });
    expect(viewFor(s, 1).zones[zoneKey(1, 'library')]).toBeUndefined();

    // Burn finishes it.
    act({ type: 'life:adjust', by: 1, seat: 1, delta: -14 });
    expect(s.finished).toBe(true);
    expect(s.winnerSeat).toBe(0);
    expect(s.seats[1]!.eliminated).toBe(true);
    expect(s.seats[1]!.eliminatedReason).toBe('life');
    expect(s.log.at(-1)!.message).toMatch(/Nick wins/);

    // The game is over, so the table refuses further play until it is reset.
    expect(() => applyAction(s, { type: 'zone:draw', by: 0, seat: 0, count: 1 })).toThrow(/finished/);
    const fresh = applyAction(s, { type: 'game:reset', by: 0 }, { isHost: true });
    expect(fresh.finished).toBe(false);
    expect(Object.keys(fresh.instances)).toHaveLength(0);
    expect(fresh.seats[0]!.life).toBe(20);
  });

  it('ends a Commander game on 21 commander damage with the board still standing', () => {
    let s = applyMany(newTable('edh'), [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
      { type: 'game:start', by: 0 },
    ]);
    expect(s.seats[0]!.life).toBe(40);
    // Krenko comes out of the command zone and starts connecting.
    const krenko = firstInZone(s, 0, 'command');
    s = applyAction(s, { type: 'card:move', by: 0, card: krenko, toZone: 'battlefield' });
    expect(nameOf(s, krenko)).toBe('Krenko, Mob Boss');
    for (let i = 0; i < 7; i++) {
      s = applyAction(s, { type: 'commanderDamage:adjust', by: 1, seat: 1, fromSeat: 0, delta: 3 });
    }
    expect(s.seats[1]!.commanderDamage['0']).toBe(21);
    expect(s.finished).toBe(true);
    expect(s.winnerSeat).toBe(0);
    expect(s.seats[1]!.eliminatedReason).toBe('commanderDamage');
    // Still on 19 life — the point of the rule.
    expect(s.seats[1]!.life).toBe(40);
  });

  it('deals a four-seat Commander pod without the card layer tripping over the extra seats', () => {
    // Only two-player tables have actually been played, and the lobby is built for that, but the
    // format allows four. If a third person joins, the deal must not quietly break.
    const four = createGame({
      id: 'pod-of-four',
      format: 'pod',
      players: [
        { playerId: 'p1', name: 'Nick' },
        { playerId: 'p2', name: 'Friend' },
        { playerId: 'p3', name: 'Third' },
        { playerId: 'p4', name: 'Fourth' },
      ],
      seed: 7,
    });
    let s = applyMany(four, [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
      { type: 'deck:load', by: 2, seat: 2, deckId: 'ember-rush' },
      { type: 'deck:load', by: 3, seat: 3, deckId: 'verdant-guard' },
      { type: 'game:start', by: 0 },
    ]);
    for (const seat of [0, 1, 2, 3] as const) {
      expect(count(s, seat, 'hand')).toBe(7);
      expect(count(s, seat, 'library')).toBe(53);
      expect(count(s, seat, 'command')).toBe(1);
      expect(s.seats[seat]!.life).toBe(40);
      // Each seat sees its own grip and nobody else's, with three opponents rather than one.
      const view = viewFor(s, seat);
      for (const other of [0, 1, 2, 3].filter((i) => i !== seat)) {
        for (const id of ids(s, other, 'hand')) expect(view.cards[id]!.card).toBeUndefined();
      }
    }
    // Redaction is not only a privacy measure — it is what makes a pod fit on the wire at all.
    // Play it out and the raw state dwarfs any one seat's view. Stated as a ratio between the two
    // rather than against the byte cap, because the cap has moved once already and the claim being
    // made here is about redaction, not about this month's limit: broadcasting the raw state, as
    // the socket layer used to, sends several times what a seat is entitled to see.
    let played = s;
    for (let turn = 0; turn < 40; turn++) {
      const seat = (turn % 4) as SeatIndex;
      if (count(played, seat, 'library') > 0) {
        played = applyAction(played, { type: 'zone:draw', by: seat, seat, count: 1 });
      }
      for (const card of [...ids(played, seat, 'hand')].slice(0, 3)) {
        played = applyAction(played, { type: 'card:move', by: seat, card, toZone: 'battlefield' });
      }
      const board = ids(played, seat, 'battlefield');
      if (board.length > 6) {
        played = applyAction(played, { type: 'card:move', by: seat, card: board[0]!, toZone: 'graveyard' });
      }
      played = applyAction(played, { type: 'turn:pass', by: seat });
    }
    const size = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
    const widest = Math.max(...[0, 1, 2, 3].map((seat) => size(viewFor(played, seat as SeatIndex))));
    expect(size(played)).toBeGreaterThan(widest * 2);
    // And the view a seat is actually sent still fits the realtime contract.
    expect(widest).toBeLessThan(WIRE_CAP);

    // The turn passes round all four, and an eliminated seat is skipped.
    expect(s.activeSeat).toBe(0);
    s = applyAction(s, { type: 'turn:pass', by: 0 });
    expect(s.activeSeat).toBe(1);
    s = applyAction(s, { type: 'concede', by: 2 });
    s = applyAction(s, { type: 'turn:pass', by: 1 });
    expect(s.activeSeat).toBe(3);
    expect(s.finished).toBe(false);
  });

  it('survives a long game: 40 turns, full boards and graveyards, still inside the wire limit', () => {
    // The short game above proves the mechanics. This asks the other question: does a game that
    // actually runs its course stay inside STATE_MAX_BYTES, which is what a view has to fit in to
    // reach the other player at all. A board and two graveyards full of real cards is the worst
    // realistic case, and the log is the part that grows without bound.
    let s = applyMany(newTable('edh'), [
      { type: 'deck:load', by: 0, seat: 0, deckId: 'ember-rush' },
      { type: 'deck:load', by: 1, seat: 1, deckId: 'verdant-guard' },
      { type: 'game:start', by: 0 },
    ]);

    for (let turn = 0; turn < 40; turn++) {
      const seat = (turn % 2) as SeatIndex;
      s = applyAction(s, { type: 'turn:untapAll', by: seat, seat });
      if (count(s, seat, 'library') > 0) s = applyAction(s, { type: 'zone:draw', by: seat, seat, count: 1 });
      // Play everything in hand, tap it, and send a third of the board to the graveyard.
      for (const card of [...ids(s, seat, 'hand')].slice(0, 3)) {
        s = applyAction(s, { type: 'card:move', by: seat, card, toZone: 'battlefield' });
        s = applyAction(s, { type: 'card:tap', by: seat, card, tapped: true });
        s = applyAction(s, { type: 'card:counter', by: seat, card, key: '+1/+1', delta: 1 });
      }
      const board = ids(s, seat, 'battlefield');
      if (board.length > 6) {
        s = applyAction(s, { type: 'card:move', by: seat, card: board[0]!, toZone: 'graveyard' });
        s = applyAction(s, { type: 'card:move', by: seat, card: board[1]!, toZone: 'exile' });
      }
      s = applyAction(s, { type: 'life:adjust', by: seat, seat, delta: -1 });
      s = applyAction(s, { type: 'turn:pass', by: seat });
    }

    expect(s.turn).toBeGreaterThan(20);
    expect(s.finished).toBe(false);
    // The log is bounded, so a long game cannot grow it without limit.
    expect(s.log.length).toBeLessThanOrEqual(200);

    const bytes = (seat: SeatIndex): number =>
      new TextEncoder().encode(JSON.stringify(viewFor(s, seat))).length;
    // WIRE_CAP is STATE_MAX_BYTES in the realtime contract; a view over it cannot be sent.
    expect(bytes(0)).toBeLessThan(WIRE_CAP);
    expect(bytes(1)).toBeLessThan(WIRE_CAP);
    // And a spectator, who sees both boards and neither hand.
    expect(new TextEncoder().encode(JSON.stringify(viewFor(s, null))).length).toBeLessThan(WIRE_CAP);

    // Redaction still holds this far in, which is the thing most likely to quietly regress.
    const view = viewFor(s, 0);
    for (const id of ids(s, 1, 'hand')) expect(view.cards[id]?.card).toBeUndefined();
    expect(view.zones[zoneKey(1, 'library')]).toBeUndefined();
  });

  it('defines a key for a card the same way whoever asks', () => {
    expect(defKeyFor({ name: ' Lightning Bolt ', typeLine: '', manaCost: '', cmc: 1, oracleText: '', colors: [] }))
      .toBe('lightning bolt');
  });
});
