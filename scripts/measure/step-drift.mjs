/**
 * How far does the table move when the bot takes one action?
 *
 * `applyAction` runs the engine's auto-pass loop, so the position it returns can be a step — or a
 * turn — past the action. That matters to anything that reads the state after an action and means
 * it to be about that action: D116 inferred it, this measured it, and D117 acted on it.
 *
 * For every action a real game takes: how many steps and how many turns the state advanced, split
 * by what kind of action it was. The numbers that mattered were `auto:cast` at 51% same-step and
 * `auto:attack` at 50% *a whole turn on*.
 */
import { applyAction, createGame, botAction, seatsToAct, STEPS } from '../../packages/rules-engine/dist/index.js';

const ALL = ['ember-rush', 'verdant-guard', 'tidal-mind', 'rot-harvest', 'forge-alliance',
  'skyward-writ', 'hollow-tide', 'ashen-rite',
  'arc-tempest'];
const SEEDS = Number(process.env.SEEDS ?? 2);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const stepIndex = (step) => STEPS.indexOf(step);
const byKind = new Map();

function note(kind, stepsMoved, turnsMoved) {
  const row = byKind.get(kind) ?? { n: 0, sameStep: 0, movedStep: 0, movedTurn: 0 };
  row.n += 1;
  if (turnsMoved > 0) row.movedTurn += 1;
  else if (stepsMoved > 0) row.movedStep += 1;
  else row.sameStep += 1;
  byKind.set(kind, row);
}

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const beforeStep = stepIndex(s.step);
    const beforeTurn = s.turn;
    const before = s.stateVersion;
    let next;
    try { next = applyAction(s, action); } catch { break; }
    if (next.stateVersion === before) break;
    if (!next.finished) {
      note(action.type, Math.max(0, stepIndex(next.step) - beforeStep), next.turn - beforeTurn);
    }
    s = next;
  }
}

for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      duel(SEED0 + i, [ALL[a], ALL[b]]);
      duel(SEED0 + i, [ALL[b], ALL[a]]);
    }
  }
}

const rows = [...byKind.entries()].sort((x, y) => y[1].n - x[1].n);
console.log('action              actions  same step   a step on   a turn on');
for (const [kind, r] of rows) {
  const pct = (v) => `${Math.round((100 * v) / r.n)}%`.padStart(5);
  console.log(`${kind.padEnd(18)} ${String(r.n).padStart(7)}  ${pct(r.sameStep)}      ${pct(r.movedStep)}       ${pct(r.movedTurn)}`);
}
