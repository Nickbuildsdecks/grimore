/**
 * What takes a deck's creatures away, and how long they live before it does.
 *
 * `infect-clock.mjs` ended on a number nobody could act on: across 144 games Blight Vector's board
 * of infect creatures never got wider than **five**, and a reshape that put 12% more of them into
 * attack steps moved that ceiling by nothing at all (D178). An eighteen-creature deck that never
 * holds more than five is losing them as fast as it plays them, and the three possible reasons
 * point at three different decks:
 *
 * - **blockers** eating 1/1s in combat → the answer is evasion, or bodies that survive a block;
 * - **removal spells** → the answer is resilience: regeneration, hexproof, a card that comes back;
 * - **its own costs** — a sacrifice outlet, a fight spell, a Village Rites → the answer is in the
 *   bot, not in the list (D175 was exactly that, and worth +29 games to Ashen Rite).
 *
 * So this follows every creature the subject puts onto the battlefield and records how it left.
 *
 * **How a cause is attributed, and what that is worth.** The same way `killed-by.mjs` attributes
 * the last point of damage, because it is the only way available from outside the engine: the loop
 * reads the action it is about to apply, applies it, and asks which of the tracked creatures are no
 * longer on the battlefield. An action with no card attached during a damage step is **combat**; an
 * action with a card is that card, and whose action it was separates *their removal* from *our own
 * cost*. The imprecision is real and affordable: "combat", "Doom Blade" and "our own Bone
 * Splinters" are the useful granularity, and the split between the three reasons above is robust to
 * getting a particular card's name wrong.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=blight-vector SEEDS=6 node scripts/measure/creature-fate.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, characteristicsOf, STEPS, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'blight-vector';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
/** Only count creatures with this keyword, e.g. `KEYWORD=infect`. Empty counts all of them. */
const KEYWORD = process.env.KEYWORD ?? '';
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
/*
  Whether the action that was just applied **crossed a damage step**, which is the question the
  obvious version of this got wrong.

  Auto-pass means one action walks the table through several steps: a pass in the declare-blockers
  step applies combat damage, moves to end of combat and stops in the next main phase, so the step
  read *before* the action is never a damage step and the step read after it is already past one.
  The first version of this harness asked `step === 'combat-damage'` and attributed 65% of a
  creature deck's losses to "a state-based action", which is true of the mechanism and useless as
  an answer. So the test is the interval: did the walk from the step before to the step after pass
  through first-strike or combat damage, in the same turn?
*/
const DAMAGE_STEPS = ['first-strike-damage', 'combat-damage'];
const stepIndex = (step) => STEPS.indexOf(step);
const crossedDamage = (before, after) => {
  if (after.turn !== before.turn) return before.step === 'declare-blockers' || before.step === 'declare-attackers';
  const from = stepIndex(before.step);
  const to = stepIndex(after.step);
  return DAMAGE_STEPS.some((step) => {
    const at = stepIndex(step);
    return from <= at && at <= to;
  });
};

let games = 0;
let arrived = 0;
let left = 0;
/** Turns of the table each creature was on the battlefield for, one entry per departure. */
const lifetimes = [];
/** The three answers this instrument exists to separate. */
const buckets = new Map();
/** And the cards behind them, so a bucket can be read as a list of names. */
const byCard = new Map();
/** Where they went, which separates a death from a bounce and from an exile. */
const byZone = new Map();
/** The widest board of them it ever had, as `infect-clock` counts it for the infect half. */
let widest = 0;
/** Creatures still on the battlefield when the game ended: the ones nothing took away. */
let survived = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const mine = (state, seat) => (state.zones[`${seat}:battlefield`] ?? []).filter((id) => {
  const inst = state.instances[id];
  if (inst === undefined) return false;
  const ch = characteristicsOf(state, inst);
  if (!ch.isCreature) return false;
  return KEYWORD === '' || ch.keywords.has(KEYWORD);
});

function duel(seed, decks, subjectSeat) {
  const ctx = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, ctx);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, ctx);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, ctx);

  const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name ?? 'something';
  /** id → the table turn it arrived on. A creature is tracked from the moment it is seen. */
  const tracked = new Map();

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;

    for (const id of mine(s, subjectSeat)) {
      if (tracked.has(id)) continue;
      tracked.set(id, s.turn);
      arrived += 1;
    }
    widest = Math.max(widest, mine(s, subjectSeat).length);

    /*
      Read before the action is applied, because both halves of the attribution are gone
      afterwards: the step is the engine's own answer to "was this combat", and a card that has
      finished resolving is in a graveyard with its name no harder to read but its *action* no
      longer in hand.
    */
    /*
      What was on top of the stack, because the action that kills a creature is usually not the
      action that cast the spell.

      Auto-pass resolves the top of the stack as part of applying a pass, and a pass carries no
      card at all — so a Doom Blade cast last turn and resolving now looked like "a state-based
      action" to the first version of this, which put 22% of the departures in a bucket nobody can
      act on. Read the top object before the action and check afterwards whether the stack got
      shorter: if it did, that object resolved, and it is the cause whatever the action was.
    */
    const stackBefore = [...s.stackOrder];
    const actionCard = action.card === undefined ? undefined : nameOf(s, action.card);
    const byMe = action.by === subjectSeat;

    const before = s.stateVersion;
    let next;
    try { next = applyAction(s, action, ctx); } catch { break; }
    if (next.stateVersion === before) break;

    for (const [id, bornOn] of [...tracked]) {
      const inst = next.instances[id];
      const stillHere = inst !== undefined && inst.zone === 'battlefield'
        && inst.zoneSeat === subjectSeat;
      if (stillHere) continue;
      tracked.delete(id);
      left += 1;
      lifetimes.push(next.turn - bornOn);
      /*
        A token that has ceased to exist has no zone to report (CR 111.7), and a creature whose
        instance is gone from the table altogether is the same case from the outside.
      */
      byZone.set(inst?.zone ?? 'ceased to exist',
        (byZone.get(inst?.zone ?? 'ceased to exist') ?? 0) + 1);
      /*
        Combat first, then whatever resolved, then the action's own card. The ordering is the whole
        attribution: a pump spell cast in the declare-blockers step is the action that applies
        combat damage as well, so reading a card first would blame a Giant Growth for the creature
        the blocker killed.
      */
      /*
        One object resolved, or several, and the second case is not guessable from out here.

        A single pass can empty the whole stack. Whichever end of it you read, the answer is wrong
        half the time: our Naturalize cast on top of their Doom Blade resolves *first* and the
        Doom Blade kills the creature after it, while their removal cast in response to our spell
        resolves first and ours after. Reading the top blamed this deck's own Naturalize for 6% of
        its departures — a card that destroys artifacts and enchantments and has never removed a
        creature in its life — and reading the bottom blames it for exactly the same 6% from the
        other direction. So a single resolution is attributed and several are counted as several,
        which keeps the three buckets this harness exists for honest.
      */
      const gone = stackBefore.filter((objectId) => !next.stackOrder.includes(objectId));
      const blamed = gone.length === 1 ? s.stackObjects[gone[0]] : undefined;
      const resolved = blamed === undefined
        ? undefined
        : (s.cardDefs[blamed.cardKey]?.name ?? 'an ability');
      const cause = resolved ?? (gone.length > 1 ? undefined : actionCard);
      const theirs = resolved === undefined ? !byMe : blamed?.controller !== subjectSeat;
      if (crossedDamage(s, next)) {
        bump(buckets, 'combat');
      } else if (gone.length > 1) {
        bump(buckets, 'several things resolving on one action, so unattributed');
      } else if (cause === undefined) {
        bump(buckets, 'a state-based action, a trigger or a cost with no card');
      } else if (theirs) {
        bump(buckets, "the opponent's card");
        bump(byCard, `theirs: ${cause}`);
      } else {
        bump(buckets, 'its own card');
        bump(byCard, `ours: ${cause}`);
      }
    }
    s = next;
  }
  survived += mine(s, subjectSeat).length;
  games += 1;
}

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other], 0);
    duel(SEED0 + i, [other, SUBJECT], 1);
  }
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pc = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
const rows = (map, of, limit = 99) => [...map]
  .sort((a, b) => b[1] - a[1])
  .slice(0, limit)
  .map(([key, n]) => `  ${String(n).padStart(4)} ${pc(n, of).padStart(4)}  ${key}`)
  .join('\n');

const what = KEYWORD === '' ? 'creatures' : `creatures with ${KEYWORD}`;
console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log('');
console.log(`it put ${arrived} ${what} onto the battlefield; ${left} of them left it`
  + ` (${pc(left, arrived)}), and ${survived} were still there when the games ended`);
console.log(`they last ${mean(lifetimes).toFixed(1)} turns of the table`
  + ` (about ${(mean(lifetimes) / 2).toFixed(1)} of its own), and the widest board of them was ${widest}`);
console.log('\nwhat took them:');
console.log(rows(buckets, left));
console.log('\nwhere they went:');
console.log(rows(byZone, left));
console.log('\nand the cards behind it:');
console.log(rows(byCard, left, 14));
