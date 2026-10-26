/**
 * How often do two bot settings actually choose differently?
 *
 * **Run this before calling a flat `bot-duel` result a wash.** A setting that changes no decisions
 * cannot win or lose games, so a level scoreboard means one of two completely different things, and
 * only this tells them apart: "it changes the choices and they are worth nothing" against "it
 * changes nothing". D117's result needed it — 1% of decisions overall, but 10% of attack
 * declarations — and without it the entry would have said "a wash" about something that was not.
 *
 * Asked of the same positions: play the game with the control, and at every decision ask both.
 */
import { applyAction, createGame, botAction, seatsToAct } from '../../packages/rules-engine/dist/index.js';

const ALL = ['ember-rush', 'verdant-guard', 'tidal-mind', 'rot-harvest', 'forge-alliance',
  'skyward-writ', 'hollow-tide', 'ashen-rite',
  'arc-tempest', 'dawn-tithe', 'delta-bloom'];
const SEEDS = Number(process.env.SEEDS ?? 2);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const TESTED = JSON.parse(process.env.TESTED ?? '{}');
const CONTROL = JSON.parse(process.env.CONTROL ?? '{}');
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const byKind = new Map();

function note(kind, same) {
  const row = byKind.get(kind) ?? { n: 0, differed: 0 };
  row.n += 1;
  if (!same) row.differed += 1;
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
    const control = botAction(s, seat, CONTROL);
    const tested = botAction(s, seat, TESTED);
    if (control === null) break;
    note(control.type, JSON.stringify(control) === JSON.stringify(tested));
    const before = s.stateVersion;
    try { s = applyAction(s, control); } catch { break; }
    if (s.stateVersion === before) break;
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
let n = 0; let differed = 0;
console.log('action            decisions   differed');
for (const [kind, r] of rows) {
  n += r.n; differed += r.differed;
  console.log(`${kind.padEnd(16)} ${String(r.n).padStart(9)}   ${String(r.differed).padStart(6)}  ${Math.round((100 * r.differed) / r.n)}%`);
}
console.log(`${'all'.padEnd(16)} ${String(n).padStart(9)}   ${String(differed).padStart(6)}  ${Math.round((100 * differed) / n)}%`);
