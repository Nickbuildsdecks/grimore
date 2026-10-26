/**
 * Every deck against every other deck, both seats, on one instrument.
 *
 * One number per deck: how many of its games it wins against the rest of the pool. Both
 * orientations of every pairing on the same seeds, so who goes first cancels out.
 */
import { applyAction, createGame, botAction, seatsToAct } from '../../packages/rules-engine/dist/index.js';

const ALL = ['ember-rush', 'verdant-guard', 'tidal-mind', 'rot-harvest', 'forge-alliance',
  'skyward-writ', 'hollow-tide', 'ashen-rite',
  'arc-tempest', 'dawn-tithe', 'delta-bloom'];
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 4400);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

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
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  return s.finished ? s.winnerSeat : null;
}

const won = Object.fromEntries(ALL.map((d) => [d, 0]));
const played = Object.fromEntries(ALL.map((d) => [d, 0]));
const head = {};
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      for (const decks of [[ALL[a], ALL[b]], [ALL[b], ALL[a]]]) {
        const winner = duel(SEED0 + i, decks);
        played[decks[0]] += 1; played[decks[1]] += 1;
        if (winner === null) continue;
        won[decks[winner]] += 1;
        const key = `${ALL[a]} v ${ALL[b]}`;
        head[key] ??= { [ALL[a]]: 0, [ALL[b]]: 0 };
        head[key][decks[winner]] += 1;
      }
    }
  }
}
const rows = ALL.map((d) => ({ deck: d, won: won[d], played: played[d],
  pct: Math.round((won[d] / Math.max(1, played[d])) * 100) }))
  .sort((x, y) => y.pct - x.pct);
console.log(`seeds ${SEEDS} from ${SEED0}: ${played[ALL[0]]} games per deck`);
for (const r of rows) console.log(`${String(r.pct).padStart(3)}%  ${r.won}-${r.played - r.won}  ${r.deck}`);
console.log(JSON.stringify(head));
