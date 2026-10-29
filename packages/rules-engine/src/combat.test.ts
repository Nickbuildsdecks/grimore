/**
 * Combat, which is the densest rules in the engine and the easiest to get subtly wrong.
 *
 * Each test sets up the smallest board that can show one rule and then plays the combat out through
 * the real actions. The keyword tests matter most: a creature pool is mostly keywords, and a wrong
 * one is the kind of bug that looks like the engine working until the game it decides.
 */
import { describe, it, expect } from 'vitest';
import { legalActions, pendingDeclaration } from './index.js';
import { damageOrdersOwed } from './index.js';
import {
  advanceTo, apply, arena, damageOn, find, ids, life, namesIn, nextTurn, passBoth, refusal,
} from './testkit.js';
import type { GameState, SeatIndex } from './types.js';

/** Gets to the declare-attackers step of the active seat's turn with combat still to happen. */
const toAttackers = (s: GameState): GameState => advanceTo(s, 'declare-attackers');

const attack = (s: GameState, by: SeatIndex, attackers: readonly string[], defender: SeatIndex): GameState =>
  apply(s, { type: 'auto:attack', by, attackers: attackers.map((attacker) => ({ attacker, defender })) });

const block = (s: GameState, by: SeatIndex, blocks: readonly { blocker: string; attacker: string }[]): GameState =>
  apply(s, { type: 'auto:block', by, blocks });

/** Plays combat out from the declare-blockers step through both damage steps. */
function resolveCombat(s: GameState): GameState {
  let next = s;
  for (let i = 0; i < 20; i++) {
    if (next.step === 'postcombat-main') return next;
    const owed = pendingDeclaration(next);
    if (owed !== null) {
      for (const seat of owed.seats) {
        next = owed.kind === 'attackers'
          ? apply(next, { type: 'auto:attack', by: seat, attackers: [] })
          : owed.kind === 'order'
            // Left as declared, which is what every test written before CR 509.2 was asked
            // assumed — so those tests keep testing what they were written to test.
            ? apply(next, { type: 'auto:order', by: seat, orders: damageOrdersOwed(next, seat) })
            : apply(next, { type: 'auto:block', by: seat, blocks: [] });
      }
      continue;
    }
    next = passBoth(next);
  }
  throw new Error(`combat never finished (stuck at ${next.step})`);
}

describe('declaring attackers', () => {
  it('waits for the declaration before giving anybody priority (CR 508.1)', () => {
    const s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    expect(s.priority).toBeNull();
    expect(pendingDeclaration(s)).toEqual({ kind: 'attackers', seats: [0] });
    expect(legalActions(s, 0).mustDeclare).toBe('attackers');
    // The attacking player cannot pass the step away without declaring — which, left possible,
    // is how a defender ends up never being asked to block.
    expect(refusal(s, { type: 'auto:pass', by: 0 })).toContain('must be declared');
  });

  it('stops asking the moment the game is over (CR 104.1)', () => {
    /*
      The one outstanding question the game-over block in `engine.ts` cannot clear by setting a
      field to null, because this one is not a field: it is derived from the step and the combat
      record. So a game that ended while a declaration was owed went on asking for it, and the
      table reads that as a game-over screen that is also demanding attackers — with nothing else
      on offer, because `legalActions` holds priority back while a declaration stands.

      Found by CI: `apps/realtime`'s whole-game test failed once with
      `awaiting: { kind: 'attackers', seats: [1] }` where it expects null, on a commit that had
      changed nothing but a browser script.
    */
    const owed = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    expect(pendingDeclaration(owed)).toEqual({ kind: 'attackers', seats: [0] });

    const over: GameState = { ...owed, finished: true, winnerSeat: 0 };
    expect(pendingDeclaration(over)).toBeNull();
    expect(legalActions(over, 0).mustDeclare).toBeNull();
  });

  it('taps an attacking creature, but not one with vigilance (CR 508.1f)', () => {
    let s = toAttackers(arena({ battlefield: { 1: ['Centaur Courser', 'Serra Angel'] }, turn: 2, firstSeat: 1 }));
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    s = attack(s, 1, [courser, angel], 0);
    expect(s.instances[courser]!.tapped).toBe(true);
    expect(s.instances[angel]!.tapped).toBe(false);
  });

  it('refuses a summoning-sick creature, and allows one with haste (CR 302.6)', () => {
    let s = advanceTo(arena({
      hands: { 0: ['Hill Giant', 'Raging Goblin'] },
      battlefield: { 0: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] },
      turn: 2, firstSeat: 0,
    }), 'precombat-main');
    s = tapFive(s);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Hill Giant') });
    s = passBoth(s);
    s = apply(s, { type: 'auto:cast', by: 0, card: find(s, 0, 'hand', 'Raging Goblin') });
    s = passBoth(s);
    s = toAttackers(s);
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: giant, defender: 1 }] }))
      .toContain('summoning sickness');
    s = attack(s, 0, [goblin], 1);
    expect(s.combat.attacks.map((a) => a.attacker)).toEqual([goblin]);
  });

  it('refuses a tapped creature and a creature the seat does not control', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'] }, turn: 2, firstSeat: 0 }));
    const theirs = find(s, 1, 'battlefield', 'Grizzly Bears');
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: theirs, defender: 1 }] }))
      .toContain('not a creature you control');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = { ...s, instances: { ...s.instances, [giant]: { ...s.instances[giant]!, tapped: true } } };
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: giant, defender: 1 }] }))
      .toContain('is tapped');
  });

  it('refuses the same creature twice, and attacking yourself', () => {
    const s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    expect(refusal(s, {
      type: 'auto:attack', by: 0,
      attackers: [{ attacker: giant, defender: 1 }, { attacker: giant, defender: 1 }],
    })).toContain('only attack once');
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [{ attacker: giant, defender: 0 }] }))
      .toContain('attack yourself');
  });

  it('refuses a declaration from the defending seat', () => {
    const s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    expect(refusal(s, { type: 'auto:attack', by: 1, attackers: [] })).toContain('attacking player');
  });

  it('skips the whole of combat when the active seat has nothing that can attack (CR 508.1h)', () => {
    // Four steps of passing with nothing to decide is not a rules question, it is a bad table.
    let s = advanceTo(arena({ battlefield: { 0: ['Mountain'] } }), 'precombat-main');
    s = passBoth(s);
    expect(s.step).toBe('begin-combat');
    s = passBoth(s);
    expect(s.step).toBe('end-combat');
  });

  it('skips the blockers and damage steps when nothing was declared', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    s = attack(s, 0, [], 1);
    expect(s.combat.attackersDeclared).toBe(true);
    s = passBoth(s);
    expect(s.step).toBe('end-combat');
  });

  it('refuses a second declaration in the same combat', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    s = attack(s, 0, [], 1);
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [] })).toContain('already been declared');
  });
});

describe('declaring blockers', () => {
  it('asks the defender, who holds no priority at the time (CR 509.1)', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'] }, turn: 2, firstSeat: 0,
    }));
    s = attack(s, 0, [find(s, 0, 'battlefield', 'Hill Giant')], 1);
    s = passBoth(s);
    expect(s.step).toBe('declare-blockers');
    expect(s.priority).toBeNull();
    expect(pendingDeclaration(s)).toEqual({ kind: 'blockers', seats: [1] });
    const actions = legalActions(s, 1);
    expect(actions.mustDeclare).toBe('blockers');
    expect(actions.blockers.map((b) => b.name)).toEqual(['Grizzly Bears']);
    expect(actions.blockers[0]!.canBlock.length).toBe(1);
  });

  it('does not stop for a defender with nothing that could block', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'], 1: ['Forest'] }, turn: 2, firstSeat: 0 }));
    s = attack(s, 0, [find(s, 0, 'battlefield', 'Hill Giant')], 1);
    s = passBoth(s);
    expect(s.step).toBe('declare-blockers');
    expect(pendingDeclaration(s)).toBeNull();
    expect(s.priority).toBe(0);
  });

  it('refuses a block from the attacking player, or against an attacker that is not real', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'] }, turn: 2, firstSeat: 0,
    }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = attack(s, 0, [giant], 1);
    s = passBoth(s);
    expect(refusal(s, { type: 'auto:block', by: 0, blocks: [{ blocker: giant, attacker: giant }] }))
      .toContain('does not block');
    expect(refusal(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bear, attacker: bear }] }))
      .toContain('not attacking');
  });

  it('refuses one creature blocking two attackers', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant', 'Raging Goblin'], 1: ['Grizzly Bears'] }, turn: 2, firstSeat: 0,
    }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = attack(s, 0, [giant, goblin], 1);
    s = passBoth(s);
    expect(refusal(s, {
      type: 'auto:block', by: 1,
      blocks: [{ blocker: bear, attacker: giant }, { blocker: bear, attacker: goblin }],
    })).toContain('only block one attacker');
  });

  it('refuses a second declaration from the same defender', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears'] }, turn: 2, firstSeat: 0,
    }));
    s = attack(s, 0, [find(s, 0, 'battlefield', 'Hill Giant')], 1);
    s = passBoth(s);
    s = block(s, 1, []);
    expect(refusal(s, { type: 'auto:block', by: 1, blocks: [] })).toContain('already declared');
  });
});

describe('evasion', () => {
  it('stops a ground creature blocking a flier (CR 702.9b)', () => {
    let s = toAttackers(arena({
      battlefield: { 1: ['Serra Angel'], 0: ['Hill Giant'] }, turn: 2, firstSeat: 1,
    }));
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = attack(s, 1, [angel], 0);
    s = passBoth(s);
    // The defender is not even asked: nothing it controls can block a flier.
    expect(pendingDeclaration(s)).toBeNull();
    expect(refusal(s, { type: 'auto:block', by: 0, blocks: [{ blocker: giant, attacker: angel }] }))
      .toMatch(/flier|already declared|nothing is attacking/);
  });

  it('lets a flier block a flier', () => {
    let s = toAttackers(arena({
      battlefield: { 1: ['Serra Angel'], 0: ['Shivan Dragon'] }, turn: 2, firstSeat: 1,
    }));
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    s = attack(s, 1, [angel], 0);
    s = passBoth(s);
    s = block(s, 0, [{ blocker: dragon, attacker: angel }]);
    expect(s.combat.attacks[0]!.blockers).toEqual([dragon]);
    s = resolveCombat(s);
    // A 5/5 dragon kills a 4/4 angel and survives.
    expect(namesIn(s, 1, 'graveyard')).toContain('Serra Angel');
    expect(namesIn(s, 0, 'battlefield')).toContain('Shivan Dragon');
  });

  it('lets a creature with reach block a flier', () => {
    let s = toAttackers(arena({ battlefield: { 1: ['Serra Angel'], 0: ['Hill Giant'] }, turn: 2, firstSeat: 1 }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = { ...s, effects: [reachFor(giant)] };
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    s = attack(s, 1, [angel], 0);
    s = passBoth(s);
    s = block(s, 0, [{ blocker: giant, attacker: angel }]);
    expect(s.combat.attacks[0]!.blockers).toEqual([giant]);
  });

  it('requires two blockers for menace (CR 702.110a)', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant'], 1: ['Grizzly Bears', 'Centaur Courser'] }, turn: 2, firstSeat: 0,
    }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = { ...s, effects: [menace(giant)] };
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = attack(s, 0, [giant], 1);
    s = passBoth(s);
    expect(refusal(s, { type: 'auto:block', by: 1, blocks: [{ blocker: bear, attacker: giant }] }))
      .toContain('menace');
    s = block(s, 1, [{ blocker: bear, attacker: giant }, { blocker: courser, attacker: giant }]);
    expect(s.combat.attacks[0]!.blockers.length).toBe(2);
  });

  /*
    Several creatures on one attacker, with no menace forcing it.

    The engine has always collected blockers per attacker and assigned damage to them in order,
    but the only test that reached more than one of them was the menace one above — which is D57's
    warning exactly: a rule exercised only through the card that makes it compulsory. This is the
    ordinary case, the one a player makes by choice, and it is now also one the bot can offer
    itself (see `gangBlock`).

    Seven power between the three of them against six toughness, so the big creature dies. Its own
    five is spent down the line: two to kill the 2/2, three into the 2/4 — not enough — and nothing
    left for the third.

    **A simplification, named rather than asserted as a rule.** CR 509.2 gives the *attacking*
    player the damage assignment order; this engine uses the order the blocks were declared in,
    which is the defending player's. It matters when the attacker could choose to kill a different
    blocker, and nothing in this pool makes it matter enough to ask a second question in the middle
    of combat. Recorded in `claude/arena-engine-2026-10-23.md` with the other known gaps.
  */
  /*
    The first requirement in the engine, as opposed to a restriction.

    Everything the rules could say before this was about one card — Pacifism, defender, summoning
    sickness, all of them "this creature may not". "Attacks each combat if able" (CR 508.1d) is
    checked against the *declaration*: the illegal thing is the list that leaves it at home, which
    is why it lives in `declareAttackers` rather than in `canAttack`.
  */
  it('makes a creature that must attack attack (CR 508.1d)', () => {
    let s = toAttackers(arena({
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      battlefield: { 0: ['Juggernaut', 'Leonin Skyhunter'] },
      turn: 3, firstSeat: 0,
    }));
    const juggernaut = find(s, 0, 'battlefield', 'Juggernaut');
    const knight = find(s, 0, 'battlefield', 'Leonin Skyhunter');
    s = { ...s, effects: [juggernautStatics(juggernaut)] };
    // Attacking with nothing, or with the other creature, leaves it at home.
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [] })).toContain('each combat');
    expect(refusal(s, {
      type: 'auto:attack', by: 0, attackers: [{ attacker: knight, defender: 1 }],
    })).toContain('each combat');
    // With it in the declaration, the rest is the player's choice as usual.
    s = attack(s, 0, [juggernaut], 1);
    expect(s.combat.attacks.map((a) => a.attacker)).toEqual([juggernaut]);
  });

  it('and excuses it when it is not able', () => {
    // "If able" carries every ordinary excuse with it. Tapped is the one a player meets most.
    let s = toAttackers(arena({
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      battlefield: { 0: ['Juggernaut'] },
      turn: 3, firstSeat: 0,
    }));
    const juggernaut = find(s, 0, 'battlefield', 'Juggernaut');
    s = {
      ...s,
      effects: [juggernautStatics(juggernaut)],
      instances: { ...s.instances, [juggernaut]: { ...s.instances[juggernaut]!, tapped: true } },
    };
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [] })).toBeNull();
  });

  it('and does not require an attack on a table with nobody left to attack', () => {
    // The pod case, and the one that would otherwise deadlock a game that is already over: the
    // last opponent is out, nothing is a legal defender, so nothing is able.
    let s = toAttackers(arena({
      format: 'pod', seats: 4,
      decks: { 0: 'forge-alliance' },
      battlefield: { 0: ['Juggernaut'] },
      turn: 3, firstSeat: 0,
    }));
    const juggernaut = find(s, 0, 'battlefield', 'Juggernaut');
    s = {
      ...s,
      effects: [juggernautStatics(juggernaut)],
      seats: s.seats.map((seat) => (seat.index === 0 ? seat : { ...seat, eliminated: true })),
    };
    expect(refusal(s, { type: 'auto:attack', by: 0, attackers: [] })).toBeNull();
  });

  it("a Juggernaut can't be blocked by a Wall, and anything else may block it", () => {
    let s = toAttackers(arena({
      decks: { 0: 'forge-alliance', 1: 'skyward-writ' },
      battlefield: { 0: ['Juggernaut'], 1: ['Wall of Air', 'Leonin Skyhunter'] },
      turn: 3, firstSeat: 0,
    }));
    const juggernaut = find(s, 0, 'battlefield', 'Juggernaut');
    s = { ...s, effects: [juggernautStatics(juggernaut)] };
    const wall = find(s, 1, 'battlefield', 'Wall of Air');
    const knight = find(s, 1, 'battlefield', 'Leonin Skyhunter');
    s = attack(s, 0, [juggernaut], 1);
    s = passBoth(s);
    expect(refusal(s, { type: 'auto:block', by: 1, blocks: [{ blocker: wall, attacker: juggernaut }] }))
      .toContain('Walls');
    // Wall is a creature *type*, not an ability: the knight has no trouble at all.
    s = block(s, 1, [{ blocker: knight, attacker: juggernaut }]);
    expect(s.combat.attacks[0]!.blockers).toEqual([knight]);
  });

  /*
    Goad (CR 701.38): a requirement *and* a restriction on the same creature, which no other card
    in the pool is.

    The requirement half is the Juggernaut's — it attacks each combat if able — and lives in the
    declaration. The restriction half is new: it may not be aimed at the player who goaded it,
    *while there is somebody else to aim it at*. That "while" is the whole rule, and the two cases
    where it lifts are the two tests below it.
  */
  it('makes a goaded creature attack, and attack somebody other than the goader', () => {
    let s = toAttackers(arena({
      format: 'pod', seats: 4,
      decks: { 1: 'verdant-guard' },
      battlefield: { 1: ['Grizzly Bears'] },
      turn: 3, firstSeat: 1,
    }));
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = { ...s, effects: [goadedBy(bear, 0)] };
    // It has to attack: leaving it at home is the Juggernaut's refusal.
    expect(refusal(s, { type: 'auto:attack', by: 1, attackers: [] })).toContain('each combat');
    // And it may not be sent at seat 0, who goaded it, while seats 2 and 3 are there to attack.
    expect(refusal(s, {
      type: 'auto:attack', by: 1, attackers: [{ attacker: bear, defender: 0 }],
    })).toContain('goaded');
    // The table is told the same thing rather than left to find out by pressing confirm.
    expect(legalActions(s, 1).attackAims).toEqual([{ card: bear, defenders: [2, 3] }]);
    // Any other player is fine, and which one is still the attacking player's choice.
    s = attack(s, 1, [bear], 3);
    expect(s.combat.attacks[0]!.defender).toBe(3);
  });

  it('lets a goaded creature attack the goader when there is nobody else left', () => {
    // "If able" (CR 701.38a). With one opponent the requirement cannot be met by anybody, so it
    // stops binding — and a duel is this case from the first turn, which is why goad is a pod card.
    let s = toAttackers(arena({
      decks: { 1: 'verdant-guard' },
      battlefield: { 1: ['Grizzly Bears'] },
      turn: 3, firstSeat: 1,
    }));
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = { ...s, effects: [goadedBy(bear, 0)] };
    expect(legalActions(s, 1).attackAims).toEqual([]);
    s = attack(s, 1, [bear], 0);
    expect(s.combat.attacks[0]!.defender).toBe(0);
  });

  it('lets a creature every opponent has goaded attack any of them', () => {
    // Two requirements that contradict each other are both unmeetable, so neither binds: the
    // creature attacks one of its goaders and the declaration is legal. Worked out by asking
    // whether a non-goader is left rather than by counting goaders, which is the same question.
    let s = toAttackers(arena({
      format: 'pod', seats: 3,
      decks: { 1: 'verdant-guard' },
      battlefield: { 1: ['Grizzly Bears'] },
      turn: 3, firstSeat: 1,
    }));
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    s = { ...s, effects: [goadedBy(bear, 0), goadedBy(bear, 2)] };
    expect(legalActions(s, 1).attackAims).toEqual([]);
    expect(refusal(s, {
      type: 'auto:attack', by: 1, attackers: [{ attacker: bear, defender: 0 }],
    })).toBeNull();
  });

  it('does not require a goaded Wall to attack, because it cannot', () => {
    // A restriction beats a requirement: `defender` means the creature cannot attack at all, so
    // "attacks each combat if able" asks nothing of it. The same line covers a goaded Pacifism.
    let s = toAttackers(arena({
      format: 'pod', seats: 4,
      decks: { 1: 'skyward-writ' },
      // The knight is there so the step happens at all: a board whose only creature cannot attack
      // skips declare-attackers outright, which is a different (and also correct) answer.
      battlefield: { 1: ['Wall of Air', 'Leonin Skyhunter'] },
      turn: 3, firstSeat: 1,
    }));
    const wall = find(s, 1, 'battlefield', 'Wall of Air');
    s = { ...s, effects: [goadedBy(wall, 0)] };
    expect(refusal(s, { type: 'auto:attack', by: 1, attackers: [] })).toBeNull();
  });

  it('lets creatures gang up on one attacker, and assigns damage down the line', () => {
    let s = toAttackers(arena({
      decks: { 0: 'rot-harvest', 1: 'verdant-guard' },
      battlefield: { 0: ['Lotleth Giant'], 1: ['Grizzly Bears', 'Giant Spider', 'Centaur Courser'] },
      turn: 3, firstSeat: 0,
    }));
    const giant = find(s, 0, 'battlefield', 'Lotleth Giant');
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    const spider = find(s, 1, 'battlefield', 'Giant Spider');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = attack(s, 0, [giant], 1);
    s = passBoth(s);
    s = block(s, 1, [
      { blocker: bear, attacker: giant },
      { blocker: spider, attacker: giant },
      { blocker: courser, attacker: giant },
    ]);
    expect(s.combat.attacks[0]!.blockers).toEqual([bear, spider, courser]);

    s = resolveCombat(s);
    expect(namesIn(s, 0, 'graveyard')).toContain('Lotleth Giant');
    expect(namesIn(s, 1, 'graveyard')).toContain('Grizzly Bears');
    // Three damage on a 2/4 is not lethal, and the third blocker was never reached at all.
    expect(namesIn(s, 1, 'battlefield')).toContain('Giant Spider');
    expect(damageOn(s, spider)).toBe(3);
    expect(damageOn(s, courser)).toBe(0);
    // Nobody was hit: a blocked attacker without trample deals nothing to the player.
    expect(life(s, 1)).toBe(20);
  });
});

describe('combat damage', () => {
  it('hits the defending player with an unblocked attacker', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    s = attack(s, 0, [find(s, 0, 'battlefield', 'Hill Giant')], 1);
    s = resolveCombat(s);
    expect(life(s, 1)).toBe(17);
  });

  it('trades damage between an attacker and its blocker', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant'], 1: ['Centaur Courser'] }, turn: 2, firstSeat: 0,
    }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = attack(s, 0, [giant], 1);
    s = passBoth(s);
    s = block(s, 1, [{ blocker: courser, attacker: giant }]);
    s = resolveCombat(s);
    // Two 3/3s kill each other, and the player takes nothing.
    expect(namesIn(s, 0, 'graveyard')).toContain('Hill Giant');
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    expect(life(s, 1)).toBe(20);
  });

  it('deals no damage to the player when the attacker is blocked by a creature that survives', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Raging Goblin'], 1: ['Centaur Courser'] }, turn: 2, firstSeat: 0,
    }));
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = attack(s, 0, [goblin], 1);
    s = passBoth(s);
    s = block(s, 1, [{ blocker: courser, attacker: goblin }]);
    s = resolveCombat(s);
    expect(life(s, 1)).toBe(20);
    expect(namesIn(s, 0, 'graveyard')).toContain('Raging Goblin');
    expect(damageOn(s, courser)).toBe(1);
  });

  it('assigns lethal damage to each blocker in order before moving to the next (CR 510.1c)', () => {
    let s = toAttackers(arena({
      battlefield: { 1: ['Sigarda, Host of Herons'], 0: ['Raging Goblin', 'Monastery Swiftspear'] },
      turn: 2, firstSeat: 1,
    }));
    const sigarda = find(s, 1, 'battlefield', 'Sigarda, Host of Herons');
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    const spear = find(s, 0, 'battlefield', 'Monastery Swiftspear');
    // Reach goes on the blockers: without it neither 1/1 may block a flier, and the engine would
    // (correctly) never ask seat 0 to declare at all.
    s = { ...s, effects: [reachFor(goblin), reachFor(spear)] };
    s = attack(s, 1, [sigarda], 0);
    s = passBoth(s);
    s = block(s, 0, [{ blocker: goblin, attacker: sigarda }, { blocker: spear, attacker: sigarda }]);
    s = resolveCombat(s);
    // A 5/5 into a 1/1 and a 1/2: one point kills the goblin, two kill the Swiftspear, and the
    // remaining two are simply lost because Sigarda has no trample.
    expect(namesIn(s, 0, 'graveyard').sort()).toEqual(['Monastery Swiftspear', 'Raging Goblin']);
    expect(life(s, 0)).toBe(20);
  });

  /*
    The damage assignment order is the *attacking* player's (CR 509.2).

    It was the defending player's: the engine spent an attacker's power down the `blockers` list,
    which is the order the blocks were declared in. Measured over 160 four-seat pods, 276 attacks
    were blocked by two or more creatures, the order changed which of them died in 54, and in 32 of
    those the defender's order cost the attacker a kill it could have had.

    The question is only asked when it can change something — two or more blockers, and power
    enough to kill some of them but not all. With enough for everybody the whole block dies
    whatever the order, and with less than the cheapest nothing does.
  */
  const orderSetup = (): GameState => {
    let s = toAttackers(arena({
      decks: { 0: 'verdant-guard', 1: 'ember-rush' },
      battlefield: { 1: ['Hill Giant'], 0: ['Grizzly Bears', 'Giant Spider'] },
      turn: 2, firstSeat: 1,
    }));
    const giant = find(s, 1, 'battlefield', 'Hill Giant');
    s = attack(s, 1, [giant], 0);
    s = passBoth(s);
    return block(s, 0, [
      { blocker: find(s, 0, 'battlefield', 'Grizzly Bears'), attacker: giant },
      { blocker: find(s, 0, 'battlefield', 'Giant Spider'), attacker: giant },
    ]);
  };

  it('asks the attacking player for the damage order, and nobody holds priority until it is given', () => {
    const s = orderSetup();
    const giant = find(s, 1, 'battlefield', 'Hill Giant');
    const bear = find(s, 0, 'battlefield', 'Grizzly Bears');
    const spider = find(s, 0, 'battlefield', 'Giant Spider');
    // A 3/3 into a 2/2 and a 2/4: enough to kill the bear, or to put three on the spider, never
    // both — so which of them the damage goes to first is a real decision and it is the
    // attacker's. It is a turn-based action, so it comes before priority (CR 509.2).
    expect(pendingDeclaration(s)).toEqual({ kind: 'order', seats: [1] });
    expect(s.priority).toBeNull();
    const actions = legalActions(s, 1);
    expect(actions.mustDeclare).toBe('order');
    expect(actions.mustOrder).toEqual([{ attacker: giant, blockers: [bear, spider] }]);
    // And the defending player is not the one being asked.
    expect(legalActions(s, 0).mustDeclare).toBeNull();
  });

  it('kills whichever blocker the attacker puts first', () => {
    let s = orderSetup();
    const giant = find(s, 1, 'battlefield', 'Hill Giant');
    const bear = find(s, 0, 'battlefield', 'Grizzly Bears');
    const spider = find(s, 0, 'battlefield', 'Giant Spider');
    // Bear first: two kills it, and the last point lands on the spider.
    let killsBear = apply(s, {
      type: 'auto:order', by: 1, orders: [{ attacker: giant, blockers: [bear, spider] }],
    });
    killsBear = resolveCombat(killsBear);
    expect(namesIn(killsBear, 0, 'graveyard')).toEqual(['Grizzly Bears']);
    expect(damageOn(killsBear, spider)).toBe(1);

    // Spider first: all three points are spent on it, so nothing dies at all — which is a worse
    // choice here and a perfectly legal one. The point is that the attacker gets to make it.
    s = apply(s, {
      type: 'auto:order', by: 1, orders: [{ attacker: giant, blockers: [spider, bear] }],
    });
    s = resolveCombat(s);
    expect(namesIn(s, 0, 'graveyard')).toEqual([]);
    expect(damageOn(s, spider)).toBe(3);
  });

  it('does not ask when the order cannot change which blockers die', () => {
    // Enough power for both: the whole block dies whatever the order (CR 510.1c), and the step
    // runs on without a question. The same line covers power below the cheapest blocker.
    let s = toAttackers(arena({
      decks: { 0: 'verdant-guard', 1: 'rot-harvest' },
      battlefield: { 1: ['Lotleth Giant'], 0: ['Grizzly Bears', 'Elvish Visionary'] },
      turn: 2, firstSeat: 1,
    }));
    const giant = find(s, 1, 'battlefield', 'Lotleth Giant');
    const blockers = [...ids(s, 0, 'battlefield')];
    s = attack(s, 1, [giant], 0);
    s = passBoth(s);
    s = block(s, 0, blockers.map((blocker) => ({ blocker, attacker: giant })));
    // A 5/6 into a 2/2 and a 1/1: three points kill both, so no order can save either of them.
    expect(pendingDeclaration(s)).toBeNull();
    expect(legalActions(s, 1).mustDeclare).toBeNull();
    s = resolveCombat(s);
    expect(namesIn(s, 0, 'graveyard').sort()).toEqual(['Elvish Visionary', 'Grizzly Bears']);
  });

  it('refuses an order that is not the creatures doing the blocking', () => {
    const s = orderSetup();
    const giant = find(s, 1, 'battlefield', 'Hill Giant');
    const bear = find(s, 0, 'battlefield', 'Grizzly Bears');
    const spider = find(s, 0, 'battlefield', 'Giant Spider');
    // A short order would leave a blocker out of the damage it is owed.
    expect(refusal(s, {
      type: 'auto:order', by: 1, orders: [{ attacker: giant, blockers: [bear] }],
    })).toContain('not the creatures blocking');
    // An order for an attack that was not asked about is a client working the rules out for
    // itself, which is the disagreement `legalActions` exists to prevent.
    expect(refusal(s, {
      type: 'auto:order', by: 1,
      orders: [{ attacker: giant, blockers: [bear, spider] }, { attacker: bear, blockers: [] }],
    })).toContain('does not need a damage order');
    // And it is not the defending player's to give.
    expect(refusal(s, {
      type: 'auto:order', by: 0, orders: [{ attacker: giant, blockers: [bear, spider] }],
    })).toContain('only the attacking player');
  });

  it('pushes excess damage through with trample (CR 702.19b)', () => {
    let s = toAttackers(arena({
      battlefield: { 1: ['Sigarda, Host of Herons'], 0: ['Raging Goblin'] }, turn: 2, firstSeat: 1,
    }));
    const sigarda = find(s, 1, 'battlefield', 'Sigarda, Host of Herons');
    s = { ...s, effects: [reachFor(find(s, 0, 'battlefield', 'Raging Goblin')), trample(sigarda)] };
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    s = attack(s, 1, [sigarda], 0);
    s = passBoth(s);
    s = block(s, 0, [{ blocker: goblin, attacker: sigarda }]);
    s = resolveCombat(s);
    // One point kills the 1/1, four trample over.
    expect(life(s, 0)).toBe(16);
  });

  it('kills a creature with deathtouch damage however small (CR 702.2b)', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Raging Goblin'], 1: ['Sigarda, Host of Herons'] }, turn: 2, firstSeat: 0,
    }));
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    const sigarda = find(s, 1, 'battlefield', 'Sigarda, Host of Herons');
    s = { ...s, effects: [deathtouch(goblin), reachFor(sigarda)] };
    s = attack(s, 0, [goblin], 1);
    s = passBoth(s);
    s = block(s, 1, [{ blocker: sigarda, attacker: goblin }]);
    s = resolveCombat(s);
    expect(namesIn(s, 1, 'graveyard')).toContain('Sigarda, Host of Herons');
  });

  it('gains life for its controller with lifelink (CR 702.15b)', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = { ...s, effects: [lifelink(giant)] };
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 0 ? { ...seat, life: 10 } : seat)) };
    s = attack(s, 0, [giant], 1);
    s = resolveCombat(s);
    expect(life(s, 1)).toBe(17);
    expect(life(s, 0)).toBe(13);
  });

  it('deals first-strike damage in its own step, killing before being hit back (CR 510.4)', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant'], 1: ['Centaur Courser'] }, turn: 2, firstSeat: 0,
    }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = { ...s, effects: [firstStrike(giant)] };
    s = attack(s, 0, [giant], 1);
    s = passBoth(s);
    s = block(s, 1, [{ blocker: courser, attacker: giant }]);

    // The first-strike step exists because something in combat has it.
    s = passBoth(s);
    expect(s.step).toBe('first-strike-damage');
    s = passBoth(s);
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    s = resolveCombat(s);
    // The blocker died before the regular step, so it never dealt its damage.
    expect(namesIn(s, 0, 'battlefield')).toContain('Hill Giant');
    expect(damageOn(s, giant)).toBe(0);
  });

  it('does not create a first-strike step when nothing in combat has it', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Hill Giant'], 1: ['Centaur Courser'] }, turn: 2, firstSeat: 0,
    }));
    s = attack(s, 0, [find(s, 0, 'battlefield', 'Hill Giant')], 1);
    s = passBoth(s);
    s = block(s, 1, [{ blocker: find(s, 1, 'battlefield', 'Centaur Courser'), attacker: s.combat.attacks[0]!.attacker }]);
    s = passBoth(s);
    expect(s.step).toBe('combat-damage');
  });

  it('deals damage twice with double strike', () => {
    let s = toAttackers(arena({
      battlefield: { 0: ['Raging Goblin'], 1: ['Centaur Courser'] }, turn: 2, firstSeat: 0,
    }));
    const goblin = find(s, 0, 'battlefield', 'Raging Goblin');
    const courser = find(s, 1, 'battlefield', 'Centaur Courser');
    s = { ...s, effects: [doubleStrike(goblin), { ...pump(goblin, 2, 4), id: 'fx-pump' }] };
    s = attack(s, 0, [goblin], 1);
    s = passBoth(s);
    s = block(s, 1, [{ blocker: courser, attacker: goblin }]);
    s = resolveCombat(s);
    // A 3/5 double striker deals 3 then 3 to a 3/3, which only needed the first.
    expect(namesIn(s, 1, 'graveyard')).toContain('Centaur Courser');
    expect(namesIn(s, 0, 'battlefield')).toContain('Raging Goblin');
  });

  it('lets a creature that was blocked by something now dead deal no damage at all', () => {
    // The chump block: the blocker dies to first strike, and the attacker is still "blocked".
    let s = toAttackers(arena({
      battlefield: { 1: ['Serra Angel'], 0: ['Shivan Dragon'] }, turn: 2, firstSeat: 1,
    }));
    const angel = find(s, 1, 'battlefield', 'Serra Angel');
    const dragon = find(s, 0, 'battlefield', 'Shivan Dragon');
    s = { ...s, effects: [firstStrike(dragon)] };
    s = attack(s, 1, [angel], 0);
    s = passBoth(s);
    s = block(s, 0, [{ blocker: dragon, attacker: angel }]);
    s = resolveCombat(s);
    expect(namesIn(s, 1, 'graveyard')).toContain('Serra Angel');
    expect(life(s, 0)).toBe(20);
    expect(damageOn(s, dragon)).toBe(0);
  });

  it('clears combat and untaps nothing at end of combat', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Hill Giant'] }, turn: 2, firstSeat: 0 }));
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = attack(s, 0, [giant], 1);
    s = resolveCombat(s);
    expect(s.combat.attacks).toEqual([]);
    expect(s.combat.attackersDeclared).toBe(false);
    // Attacking tapped it, and end of combat is not when that is undone.
    expect(s.instances[giant]!.tapped).toBe(true);
    s = nextTurn(s);
    s = nextTurn(s);
    expect(s.instances[giant]!.tapped).toBe(false);
  });

  it('kills a player with combat damage and ends the game', () => {
    let s = toAttackers(arena({ battlefield: { 0: ['Shivan Dragon'] }, turn: 2, firstSeat: 0 }));
    s = { ...s, seats: s.seats.map((seat) => (seat.index === 1 ? { ...seat, life: 4 } : seat)) };
    s = attack(s, 0, [find(s, 0, 'battlefield', 'Shivan Dragon')], 1);
    s = passBoth(s); // into declare-blockers; nothing can block a flier, so it is declared for them
    s = passBoth(s); // into the combat damage step
    expect(s.finished).toBe(true);
    expect(s.winnerSeat).toBe(0);
    expect(s.seats[1]!.eliminated).toBe(true);
  });
});

describe('combat and the stack together', () => {
  it('lets the defender remove an attacker before damage, and the attack deals nothing', () => {
    let s = arena({
      hands: { 1: ['Swords to Plowshares'] },
      battlefield: { 0: ['Hill Giant'], 1: ['Plains'] },
      turn: 2, firstSeat: 0,
    });
    s = toAttackers(s);
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = attack(s, 0, [giant], 1);
    // Priority is back with the attacker in the declare-attackers step; the defender answers.
    s = apply(s, { type: 'auto:pass', by: 0 });
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Plains'), abilityIndex: 0 });
    s = apply(s, {
      type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Swords to Plowshares'),
      targets: [{ kind: 'card', id: giant }],
    });
    s = passBoth(s);
    expect(ids(s, 0, 'exile').length).toBe(1);
    s = resolveCombat(s);
    expect(life(s, 1)).toBe(20);
    expect(life(s, 0)).toBe(23); // Swords gave the giant's controller 3 life
  });

  it('lets the attacker pump a blocked creature so it survives', () => {
    let s = arena({
      hands: { 1: ['Giant Growth'] },
      battlefield: { 1: ['Grizzly Bears', 'Forest'], 0: ['Hill Giant'] },
      turn: 2, firstSeat: 1,
    });
    s = toAttackers(s);
    const bear = find(s, 1, 'battlefield', 'Grizzly Bears');
    const giant = find(s, 0, 'battlefield', 'Hill Giant');
    s = attack(s, 1, [bear], 0);
    s = passBoth(s);
    s = block(s, 0, [{ blocker: giant, attacker: bear }]);
    // Still in the declare-blockers step, with priority back: pump before damage.
    s = apply(s, { type: 'auto:activate', by: 1, card: find(s, 1, 'battlefield', 'Forest'), abilityIndex: 0 });
    s = apply(s, { type: 'auto:cast', by: 1, card: find(s, 1, 'hand', 'Giant Growth'), targets: [{ kind: 'card', id: bear }] });
    s = passBoth(s);
    s = resolveCombat(s);
    // A 5/5 bear kills the 3/3 and lives.
    expect(namesIn(s, 0, 'graveyard')).toContain('Hill Giant');
    expect(namesIn(s, 1, 'battlefield')).toContain('Grizzly Bears');
  });
});

// ── Keyword grants, so a rule can be tested without a card that happens to have it ───────────────

const grant = (id: string, keyword: 'reach' | 'menace' | 'trample' | 'deathtouch' | 'lifelink' | 'first strike' | 'double strike') => ({
  id: `fx-${keyword}`, source: id, controller: 0 as SeatIndex,
  scope: { kind: 'cards' as const, ids: [id] }, keywords: [keyword],
  duration: 'permanent' as const, createdTurn: 0,
});
const reachFor = (id: string) => grant(id, 'reach');
const menace = (id: string) => grant(id, 'menace');
const trample = (id: string) => grant(id, 'trample');
const deathtouch = (id: string) => grant(id, 'deathtouch');
const lifelink = (id: string) => grant(id, 'lifelink');
const firstStrike = (id: string) => grant(id, 'first strike');
const doubleStrike = (id: string) => grant(id, 'double strike');
/**
 * Juggernaut's two statics, installed by hand.
 *
 * The testkit puts a permanent on the battlefield with the tabletop's own `card:move`, which is
 * not an *arrival* — so `applyStatics` never runs and a card whose whole behaviour is a static
 * does nothing at all. True at a real table too, and the same thing Fog Bank's test ran into.
 */
const juggernautStatics = (id: string) => ({
  id: 'fx-juggernaut', source: id, controller: 0 as SeatIndex,
  scope: { kind: 'cards' as const, ids: [id] },
  mustAttack: true, cantBeBlockedByWalls: true,
  duration: 'permanent' as const, createdTurn: 0,
});
/** Goad, as the card leaves it: both halves, keyed to the goading seat's next turn. */
const goadedBy = (id: string, by: SeatIndex) => ({
  id: `fx-goad-${by}`, source: 'spell-goad', controller: by,
  scope: { kind: 'cards' as const, ids: [id] },
  mustAttack: true, mustAttackAnotherPlayer: true,
  duration: 'until-controllers-next-turn' as const, createdTurn: 0,
});
const pump = (id: string, power: number, toughness: number) => ({
  id: 'fx-pump', source: id, controller: 0 as SeatIndex,
  scope: { kind: 'cards' as const, ids: [id] }, power, toughness,
  duration: 'permanent' as const, createdTurn: 0,
});

/** Taps five Mountains, which is enough for anything in the red deck. */
function tapFive(s: GameState): GameState {
  let next = s;
  for (const id of [...ids(next, 0, 'battlefield')]) {
    if (next.cardDefs[next.instances[id]!.defKey]!.name !== 'Mountain') continue;
    if (next.instances[id]!.tapped) continue;
    next = apply(next, { type: 'auto:activate', by: 0, card: id, abilityIndex: 0 });
  }
  return next;
}
