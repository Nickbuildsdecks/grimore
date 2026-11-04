/**
 * Deals between players: the words, the term, who may answer, and what happens when somebody
 * goes back on one.
 *
 * The thing under test here is unlike everything else in this engine, and the tests are written to
 * hold that shape: a pact is **never enforced**. Half of these assert that an attack which breaks
 * a promise is accepted — if one of them ever starts failing because the engine refused the
 * attack, the feature has turned into a rule and the point of it is gone.
 */
import { describe, it, expect } from 'vitest';
import {
  botAction, legalActions, packView, pactIsLive, pactProtects, pactShort, seatsToAct, unpackView,
  viewFor,
} from './index.js';
import { advanceTo, apply, arena, find, ids, nextTurn, refusal } from './testkit.js';
import type { Action, GameState, PactKind, SeatIndex } from './types.js';

const offer = (s: GameState, by: SeatIndex, to: SeatIndex, kind: PactKind): GameState =>
  apply(s, { type: 'pact:offer', by, seat: to, kind });

const answer = (s: GameState, by: SeatIndex, accept: boolean): GameState =>
  apply(s, { type: 'pact:respond', by, pact: s.pacts.find((p) => p.status === 'offered')!.id, accept });

const struck = (s: GameState, by: SeatIndex, to: SeatIndex, kind: PactKind): GameState =>
  answer(offer(s, by, to, kind), to, true);

const lastMessage = (s: GameState): string => s.log[s.log.length - 1]!.message;

const pod = (setup: Parameters<typeof arena>[0] = {}): GameState => arena({
  format: 'pod', seats: 4, decks: { 0: 'forge-alliance', 1: 'skyward-writ', 2: 'ember-rush', 3: 'verdant-guard' },
  ...setup,
});

describe('offering a deal and answering it', () => {
  it('records the offer in words both players can read', () => {
    const s = offer(arena({ turn: 2 }), 0, 1, 'truce-until-your-turn');
    expect(s.pacts).toHaveLength(1);
    expect(s.pacts[0]).toMatchObject({ from: 0, to: 1, status: 'offered', throughTurn: null });
    // Named, both of them: "a deal" in a four-seat pod is a log line nobody can act on.
    expect(lastMessage(s)).toContain('Nick offers a deal');
    expect(lastMessage(s)).toContain('Nick and Friend will not attack each other');
  });

  it('is not live until it is accepted, and never if it is declined', () => {
    const open = offer(arena({ turn: 2 }), 0, 1, 'no-attack-this-turn');
    expect(pactIsLive(open, open.pacts[0]!)).toBe(false);
    expect(pactProtects(open, 0, 1)).toBe(false);

    const no = answer(open, 1, false);
    expect(no.pacts[0]!.status).toBe('declined');
    expect(pactIsLive(no, no.pacts[0]!)).toBe(false);
    expect(lastMessage(no)).toContain('Friend declines');

    const yes = answer(open, 1, true);
    expect(yes.pacts[0]!.status).toBe('accepted');
    expect(pactProtects(yes, 0, 1)).toBe(true);
    expect(lastMessage(yes)).toContain('Friend agrees');
  });

  it('may only be answered by the player it was offered to — the host included', () => {
    const open = offer(arena({ turn: 2 }), 0, 1, 'no-attack-this-turn');
    const id = open.pacts[0]!.id;
    // `apply` here is the *host* context, which every other seat-scoped action in the engine
    // accepts. This one does not, and that is the whole authority a pact has.
    expect(refusal(open, { type: 'pact:respond', by: 0, pact: id, accept: true }))
      .toContain('only the player a deal was offered to');
    expect(refusal(open, { type: 'pact:respond', by: 1, pact: id, accept: true })).toBeNull();
  });

  it('refuses a deal with yourself, an unknown deal, and a second offer in the same direction', () => {
    const s = arena({ turn: 2 });
    expect(refusal(s, { type: 'pact:offer', by: 0, seat: 0, kind: 'no-attack-this-turn' }))
      .toContain('with yourself');
    expect(refusal(s, { type: 'pact:offer', by: 0, seat: 1, kind: 'be-my-friend' as PactKind }))
      .toContain('not a deal this table offers');
    const open = offer(s, 0, 1, 'no-attack-this-turn');
    expect(refusal(open, { type: 'pact:offer', by: 0, seat: 1, kind: 'truce-until-your-turn' }))
      .toContain('already have an offer out');
    // The other direction is a different conversation, and so is a second offer after an answer.
    expect(refusal(open, { type: 'pact:offer', by: 1, seat: 0, kind: 'truce-until-your-turn' })).toBeNull();
    expect(refusal(answer(open, 1, false), { type: 'pact:offer', by: 0, seat: 1, kind: 'no-attack-this-turn' }))
      .toBeNull();
  });

  it('cannot be answered twice', () => {
    const done = struck(arena({ turn: 2 }), 0, 1, 'no-attack-this-turn');
    expect(refusal(done, { type: 'pact:respond', by: 1, pact: done.pacts[0]!.id, accept: false }))
      .toContain('no longer on the table');
  });
});

describe('how long a deal lasts', () => {
  it('runs out at the end of the turn it was made for', () => {
    const s = struck(arena({ turn: 2, firstSeat: 0 }), 0, 1, 'no-attack-this-turn');
    expect(s.pacts[0]!.throughTurn).toBe(s.turn);
    expect(pactProtects(s, 0, 1)).toBe(true);
    const later = nextTurn(s);
    expect(pactProtects(later, 0, 1)).toBe(false);
    // Expired, not gone: the table still remembers it was made and kept.
    expect(later.pacts).toHaveLength(1);
    expect(later.pacts[0]!.broken).toBeUndefined();
  });

  it('covers the offering player’s next turn, which is a rotation away in a pod', () => {
    // Seat 0 is active, so seat 0's next turn is four turn changes off in a four-seat pod.
    const s = struck(pod({ turn: 2, firstSeat: 0 }), 0, 2, 'no-attack-next-turn');
    expect(s.pacts[0]!.throughTurn).toBe(s.turn + 4);
    let next = s;
    for (let i = 0; i < 4; i++) {
      next = nextTurn(next);
      expect(pactProtects(next, 0, 2)).toBe(true);
    }
    expect(pactProtects(nextTurn(next), 0, 2)).toBe(false);
  });

  it('ends a truce the moment the asked player’s turn begins, and binds both of them until then', () => {
    // Seat 0 is active and offers seat 1, who is next: the truce covers the rest of this turn only.
    const s = struck(pod({ turn: 2, firstSeat: 0 }), 0, 1, 'truce-until-your-turn');
    expect(s.pacts[0]!.throughTurn).toBe(s.turn);
    // Both ways, which is the only kind that does.
    expect(pactProtects(s, 0, 1)).toBe(true);
    expect(pactProtects(s, 1, 0)).toBe(true);
    // And nothing to do with the other two seats.
    expect(pactProtects(s, 0, 2)).toBe(false);
    const theirTurn = nextTurn(s);
    expect(theirTurn.activeSeat).toBe(1);
    expect(pactProtects(theirTurn, 1, 0)).toBe(false);
  });

  it('covers nothing when the player who offered it is out of the game', () => {
    // Offered, then the player who offered it concedes before the answer comes. A deal is still
    // answerable — the table should be able to close the conversation — but "my next turn" is now
    // a turn nobody will ever take.
    let s = offer(pod({ turn: 2, firstSeat: 0 }), 3, 0, 'no-attack-next-turn');
    s = apply(s, { type: 'concede', by: 3, seat: 3 });
    const deal = answer(s, 0, true);
    expect(deal.pacts[0]!.throughTurn).toBeLessThan(deal.turn);
    expect(pactProtects(deal, 3, 0)).toBe(false);
  });

  it('refuses a deal offered to a player who is out of the game', () => {
    let s = pod({ turn: 2, firstSeat: 0 });
    s = apply(s, { type: 'concede', by: 3, seat: 3 });
    expect(refusal(s, { type: 'pact:offer', by: 0, seat: 3, kind: 'truce-until-your-turn' }))
      .toContain('eliminated');
    // And they are off the list the table offers, so it never comes up.
    expect(legalActions(s, 0).pacts.offer.map((o) => o.seat)).toEqual([1, 2]);
  });
});

describe('breaking one', () => {
  const withSoldier = (setup: Parameters<typeof arena>[0]): GameState => arena({
    decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
    battlefield: { 0: ['Leonin Skyhunter'] },
    turn: 3, firstSeat: 0, ...setup,
  });

  it('lets the attack through, marks the deal broken, and says so', () => {
    let s = advanceTo(withSoldier({}), 'declare-attackers');
    s = struck(s, 0, 1, 'no-attack-this-turn');
    const knight = find(s, 0, 'battlefield', 'Leonin Skyhunter');
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: knight, defender: 1 }] });
    // The attack happened. Nothing in the engine stops a player going back on their word.
    expect(s.combat.attacks.map((a) => a.attacker)).toEqual([knight]);
    expect(s.pacts[0]!.broken).toBe(true);
    expect(pactProtects(s, 0, 1)).toBe(false);
    expect(lastMessage(s)).toContain('breaking a deal');
    expect(lastMessage(s)).toContain('Nick will not attack Friend this turn');
  });

  it('says nothing when the attack keeps it, or when the deal was declined or spent', () => {
    let s = advanceTo(pod({
      battlefield: { 0: ['Leonin Skyhunter'] }, turn: 3, firstSeat: 0,
    }), 'declare-attackers');
    const knight = find(s, 0, 'battlefield', 'Leonin Skyhunter');
    // A deal with seat 1, an attack on seat 2: the deal is untouched.
    s = struck(s, 0, 1, 'no-attack-this-turn');
    // And a declined offer to seat 2, which protects nobody.
    s = answer(offer(s, 0, 2, 'no-attack-this-turn'), 2, false);
    s = apply(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: knight, defender: 2 }] });
    expect(lastMessage(s)).not.toContain('breaking');
    expect(s.pacts.some((p) => p.broken === true)).toBe(false);
  });

  it('is one-way unless it is a truce', () => {
    // Seat 1 promised nothing, so seat 1 attacking seat 0 breaks nothing.
    let s = advanceTo(arena({
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      battlefield: { 1: ['Leonin Skyhunter'] }, turn: 3, firstSeat: 1,
    }), 'declare-attackers');
    s = struck(s, 0, 1, 'no-attack-this-turn');
    const knight = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    s = apply(s, { type: 'auto:attack', by: 1, attackers: [{ attacker: knight, defender: 0 }] });
    expect(s.pacts[0]!.broken).toBeUndefined();
    expect(lastMessage(s)).not.toContain('breaking');
  });

  it('counts an attack on a planeswalker as an attack on its controller', () => {
    let s = advanceTo(arena({
      decks: { 0: 'forge-alliance', 1: 'hollow-tide' },
      battlefield: { 0: ['Leonin Skyhunter'], 1: ['Jace, Memory Adept'] },
      turn: 3, firstSeat: 0,
    }), 'declare-attackers');
    s = struck(s, 0, 1, 'no-attack-this-turn');
    const knight = find(s, 0, 'battlefield', 'Leonin Skyhunter');
    const jace = find(s, 1, 'battlefield', 'Jace, Memory Adept');
    s = apply(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: knight, defender: 1, planeswalker: jace }],
    });
    // "I won't attack you" and then swinging at their planeswalker is the loophole a player would
    // try, and the defending seat travels on the attack either way (CR 506.2).
    expect(s.pacts[0]!.broken).toBe(true);
  });
});

describe('the opponent, which keeps its word', () => {
  it('aims its attack at somebody it has not made a deal with', () => {
    let s = advanceTo(pod({
      battlefield: { 0: ['Leonin Skyhunter'] }, turn: 3, firstSeat: 0, autoPass: true,
    }), 'declare-attackers');
    s = struck(s, 0, 1, 'no-attack-this-turn');
    const plan = botAction(s, 0) as Action & { attackers: readonly { defender: SeatIndex }[] };
    expect(plan.type).toBe('auto:attack');
    for (const entry of plan.attackers) expect(entry.defender).not.toBe(1);
  });

  it('holds a creature back rather than break a deal in a duel', () => {
    let s = advanceTo(arena({
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      battlefield: { 0: ['Leonin Skyhunter'] }, turn: 3, firstSeat: 0, autoPass: true,
    }), 'declare-attackers');
    s = struck(s, 0, 1, 'no-attack-this-turn');
    const plan = botAction(s, 0) as Action & { attackers: readonly unknown[] };
    expect(plan.type).toBe('auto:attack');
    // One opponent and a promise not to attack them: the only word-keeping attack is no attack.
    expect(plan.attackers).toHaveLength(0);
    expect(refusal(s, plan)).toBeNull();
  });

  it('breaks one only when the rules leave it no choice', () => {
    let s = advanceTo(arena({
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      battlefield: { 0: ['Juggernaut'] }, turn: 3, firstSeat: 0, autoPass: true,
    }), 'declare-attackers');
    const juggernaut = find(s, 0, 'battlefield', 'Juggernaut');
    s = {
      ...s,
      effects: [{
        id: 'fx-juggernaut', source: juggernaut, controller: 0,
        scope: { kind: 'cards', ids: [juggernaut] },
        mustAttack: true, duration: 'permanent', createdTurn: 0,
      }],
    };
    s = struck(s, 0, 1, 'no-attack-this-turn');
    const plan = botAction(s, 0) as Action & { attackers: readonly { attacker: string }[] };
    // "Attacks each combat if able" beats a promise, because the engine refuses the declaration
    // that leaves it at home and accepts the one that breaks the deal. The record shows it.
    expect(plan.attackers.map((a) => a.attacker)).toEqual([juggernaut]);
    const after = apply(s, plan);
    expect(after.pacts[0]!.broken).toBe(true);
    expect(lastMessage(after)).toContain('breaking a deal');
  });

  it('answers an offer before it declares its attack, and takes the deal', () => {
    let s = advanceTo(pod({
      battlefield: { 0: ['Leonin Skyhunter'] }, turn: 3, firstSeat: 0, autoPass: true,
    }), 'declare-attackers');
    s = offer(s, 1, 0, 'truce-until-your-turn');
    // The engine is waiting on seat 0 for attackers, and seat 0 answers the deal first: a truce
    // accepted after the declaration would be a truce about a decision already made.
    expect(seatsToAct(s)).toContain(0);
    const first = botAction(s, 0)!;
    expect(first.type).toBe('pact:respond');
    s = apply(s, first);
    expect(s.pacts[0]!.status).toBe('accepted');
    const plan = botAction(s, 0) as Action & { attackers: readonly { defender: SeatIndex }[] };
    for (const entry of plan.attackers) expect(entry.defender).not.toBe(1);
  });

  it('declines a deal from somebody it could kill right now', () => {
    // Seat 1 on four life, seat 0 with a 4/4 and a 2/2 untapped: there is nothing in a truce for
    // the player holding the board, and a bot that signed one would be throwing the game away.
    let s = advanceTo(arena({
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      battlefield: { 0: ['Juggernaut', 'Leonin Skyhunter'] }, turn: 3, firstSeat: 0, autoPass: true,
    }), 'declare-attackers');
    s = apply(s, { type: 'life:adjust', by: 1, seat: 1, delta: -16 });
    s = offer(s, 1, 0, 'truce-until-your-turn');
    const reply = botAction(s, 0) as Action & { accept: boolean };
    expect(reply.type).toBe('pact:respond');
    expect(reply.accept).toBe(false);
  });

  it('never offers one itself', () => {
    const s = advanceTo(pod({
      battlefield: { 0: ['Leonin Skyhunter'] }, turn: 3, firstSeat: 0, autoPass: true,
    }), 'precombat-main');
    // Over a whole turn of bot decisions, nothing the bot does is an offer: proposing a deal needs
    // a model of what the other player does next, and this bot has none. See `answerPact`.
    let next = s;
    for (let i = 0; i < 40 && !next.finished; i++) {
      const seat = seatsToAct(next)[0];
      if (seat === undefined) break;
      const action = botAction(next, seat);
      if (action === null) break;
      expect(action.type).not.toBe('pact:offer');
      next = apply(next, action);
    }
  });
});

describe('what the table can see', () => {
  it('shows every deal to everybody, and survives the wire', () => {
    let s = struck(pod({ turn: 2, firstSeat: 0 }), 0, 1, 'truce-until-your-turn');
    s = offer(s, 2, 3, 'no-attack-this-turn');
    for (const viewer of [0, 1, 2, 3, null] as const) {
      const view = viewFor(s, viewer);
      // Unredacted on purpose: a deal struck at a table is struck out loud, and the seat it was
      // not offered to hearing it is most of what makes it mean anything.
      expect(view.pacts).toHaveLength(2);
      expect(view.pacts[0]).toMatchObject({ from: 0, to: 1, status: 'accepted' });
      expect(view.pacts[1]).toMatchObject({ from: 2, to: 3, status: 'offered' });
    }
    const wired = unpackView(packView(viewFor(s, 0)));
    expect(wired.pacts).toEqual(viewFor(s, 0).pacts);
  });

  it('offers the deals and the answer through legalActions', () => {
    const s = pod({ turn: 2, firstSeat: 0 });
    // Nothing gates a pact on priority or on a step, which is what lets a player answer one in the
    // middle of somebody else's turn — so the only thing to assert is that the kinds are shown.
    const mine = legalActions(s, 1).pacts;
    expect(mine.offer.map((o) => o.seat)).toEqual([0, 2, 3]);
    expect(mine.offer[0]!.kinds).toEqual([
      'truce-until-your-turn', 'no-attack-this-turn', 'no-attack-next-turn',
    ]);
    expect(mine.answer).toEqual([]);

    const open = offer(s, 0, 1, 'no-attack-this-turn');
    expect(legalActions(open, 1).pacts.answer).toEqual([open.pacts[0]!.id]);
    // Nothing to answer for the seat that offered it, and seat 1 is off its own list of people to
    // offer: one live offer per direction, said where the table can see it rather than refused.
    expect(legalActions(open, 0).pacts.answer).toEqual([]);
    expect(legalActions(open, 0).pacts.offer.map((o) => o.seat)).toEqual([2, 3]);
    // The other direction is untouched — seat 1 may still put a deal to seat 0.
    expect(legalActions(open, 1).pacts.offer.map((o) => o.seat)).toEqual([0, 2, 3]);
  });

  it('says each deal short enough for a badge', () => {
    expect(pactShort('truce-until-your-turn')).toBe('truce');
    expect(pactShort('no-attack-this-turn')).toBe('no attack this turn');
    expect(pactShort('no-attack-next-turn')).toBe('no attack next turn');
  });
});
