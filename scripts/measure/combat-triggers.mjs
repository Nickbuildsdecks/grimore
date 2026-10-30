/**
 * What the two new combat triggers actually do in real games.
 *
 * `deck-probe` prices a slot; this says whether the mechanism inside it ever happens, which is the
 * other half and the one a record cannot answer. A Wall of Frost that wins games by being a 0/7
 * and never freezes anything is a wall, not a tempo card — and the only way to tell those apart is
 * to count the freezes and then count how many of them were on a creature that was *tapped*, which
 * is the only freeze that costs its controller a turn.
 *
 * Ophidian is the same question asked of a decision rather than an effect: how often it gets
 * through at all, and which of the two answers the bot gives when it does. A card whose question
 * always has the same answer is a card that did not need to ask.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/combat-triggers.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const stats = {
  wallGames: 0, wallBlocks: 0, freezes: 0, freezesOnTapped: 0, heldThroughUntap: 0,
  ophidianGames: 0, ophidianAttacks: 0, gotThrough: 0, drew: 0, keptTheDamage: 0,
};

const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name;

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  let sawWall = false;
  let sawOphidian = false;
  // Which creatures are frozen and tapped right now, so the next untap step can be checked.
  let watching = new Map(); // id -> the seat whose untap step is the one that matters
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;

    if (action.type === 'auto:block') {
      for (const block of action.blocks ?? []) {
        if (nameOf(s, block.blocker) !== 'Wall of Frost') continue;
        stats.wallBlocks += 1;
      }
    }
    if (action.type === 'auto:attack') {
      for (const attack of action.attackers ?? []) {
        if (nameOf(s, attack.attacker) === 'Ophidian') stats.ophidianAttacks += 1;
      }
    }
    // The question itself, read off the state rather than off the action: the bot's answer is
    // what `auto:decide` carries, and the prompt is what says which question it answered.
    if (action.type === 'auto:decide' && (s.pendingDecision?.prompt ?? '').startsWith('Draw a card')) {
      stats.gotThrough += 1;
      if (action.option === 'Draw') stats.drew += 1;
      else stats.keptTheDamage += 1;
    }

    const before = s.stateVersion;
    const prevActive = s.activeSeat;
    let next;
    try { next = applyAction(s, action); } catch { break; }
    if (next.stateVersion === before) break;

    for (const inst of Object.values(next.instances)) {
      if (inst.zone !== 'battlefield') continue;
      if (nameOf(next, inst.id) === 'Wall of Frost') sawWall = true;
      if (nameOf(next, inst.id) === 'Ophidian') sawOphidian = true;
      const was = s.instances[inst.id];
      if (inst.frozen === true && was?.frozen !== true) {
        stats.freezes += 1;
        if (inst.tapped) {
          stats.freezesOnTapped += 1;
          watching.set(inst.id, inst.zoneSeat);
        }
      }
    }
    /*
      A frozen creature that is still tapped once its controller's turn has come round is the
      freeze doing the thing the card promises.

      Checked on the turn changing to that player rather than on the untap step, because nobody
      ever holds priority in the untap step (CR 502.1) — the engine passes through it inside one
      action and no state this loop sees is ever at `step: 'untap'`. The first version watched for
      that step and reported a flat zero, which is what a measurement looks like when the
      instrument is wrong rather than the mechanism.
    */
    if (next.activeSeat !== prevActive) {
      for (const [id, owner] of [...watching]) {
        if (next.activeSeat !== owner) continue;
        const inst = next.instances[id];
        if (inst !== undefined && inst.zone === 'battlefield' && inst.tapped) stats.heldThroughUntap += 1;
        watching.delete(id);
      }
    }
    s = next;
  }
  if (sawWall) stats.wallGames += 1;
  if (sawOphidian) stats.ophidianGames += 1;
}

let games = 0;
/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles seat 0's deck
  and then seat 1's, and the same stream yields the same index permutation however different the
  deck list is — so a whole pass over the field on one seed was one shuffle wearing every pairing,
  and an absolute rate printed below had the error bars of its seed count rather than its game
  count. Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      duel(seedFor(i, a, b, 0), [ALL[a], ALL[b]]); games += 1;
      duel(seedFor(i, a, b, 1), [ALL[b], ALL[a]]); games += 1;
    }
  }
}

const pct = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}\n`);
console.log('Wall of Frost');
console.log(`  on the battlefield in ${stats.wallGames} games`);
console.log(`  blocked ${stats.wallBlocks} times`);
console.log(`  froze ${stats.freezes}, of which ${stats.freezesOnTapped} were already tapped (${pct(stats.freezesOnTapped, stats.freezes)})`);
console.log(`  still tapped after its own untap step: ${stats.heldThroughUntap}`);
console.log('Ophidian');
console.log(`  on the battlefield in ${stats.ophidianGames} games`);
console.log(`  attacked ${stats.ophidianAttacks} times, got through ${stats.gotThrough} (${pct(stats.gotThrough, stats.ophidianAttacks)})`);
console.log(`  drew the card ${stats.drew}, kept the damage ${stats.keptTheDamage}`);
