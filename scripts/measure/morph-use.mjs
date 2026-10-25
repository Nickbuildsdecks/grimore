/**
 * Which half of a morph the bot reaches for, and whether it ever follows through.
 *
 * `cast-counts.mjs` answers "is this slot dead", and for a morph that is not enough: a card with
 * two ways to cast it can look perfectly healthy at 107% while the mechanic goes unused, because
 * every one of those casts was the printed cost. The two numbers that say whether morph is in the
 * deck for a reason are **how many of its casts were face down** and **how many of those were
 * turned back up** — and the second one is the honest one, because a 2/2 that is never turned up
 * is a card the bot paid {3} for and then forgot.
 *
 * Also reports the turn each thing happened on, which is the whole argument for the mechanic: a
 * five-mana creature on turn three is the point, and a measurement that said "cast face down 40
 * times" without saying when would not have shown it.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/morph-use.mjs
 */
import {
  applyAction, createGame, botAction, morphCostText, scriptFor, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = ['ember-rush', 'verdant-guard', 'tidal-mind', 'rot-harvest', 'forge-alliance',
  'skyward-writ', 'hollow-tide', 'ashen-rite',
  'arc-tempest'];
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/** Every card in the pool with a morph cost, and which deck runs it. */
const morphs = new Map(); // name -> { deck, cost }
for (const [deckId, spec] of Object.entries(STARTER_DECKS)) {
  for (const entry of spec.cards) {
    // Through the engine's own formatter, because a morph cost stopped being a string the day one
    // of them became "pay 3 life": printed raw it came out as `[object Object]`.
    const raw = scriptFor(entry.card.name)?.morph?.cost;
    const cost = raw === undefined ? undefined : morphCostText(raw);
    if (cost !== undefined) morphs.set(entry.card.name, { deck: deckId, cost });
  }
}
if (morphs.size === 0) {
  console.log('no card in the pool has morph.');
  process.exit(0);
}

const stats = new Map(); // name -> counters
const row = (name) => {
  const found = stats.get(name) ?? {
    printed: 0, faceDown: 0, turnedUp: 0, downTurns: [], upTurns: [], games: 0,
  };
  stats.set(name, found);
  return found;
};

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name;
  const seen = new Set();
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const name = action.card === undefined ? undefined : nameOf(s, action.card);
    if (name !== undefined && morphs.has(name)) {
      seen.add(name);
      if (action.type === 'auto:cast') {
        const r = row(name);
        if (action.faceDown === true) { r.faceDown += 1; r.downTurns.push(s.turn); }
        else r.printed += 1;
      }
      if (action.type === 'auto:turnUp') {
        const r = row(name);
        r.turnedUp += 1;
        r.upTurns.push(s.turn);
      }
    }
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  for (const name of seen) row(name).games += 1;
}

let games = 0;
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      duel(SEED0 + i, [ALL[a], ALL[b]]); games += 1;
      duel(SEED0 + i, [ALL[b], ALL[a]]); games += 1;
    }
  }
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}\n`);
for (const [name, { deck, cost }] of morphs) {
  const r = stats.get(name) ?? { printed: 0, faceDown: 0, turnedUp: 0, downTurns: [], upTurns: [] };
  const casts = r.printed + r.faceDown;
  const share = casts === 0 ? 0 : Math.round((100 * r.faceDown) / casts);
  const followed = r.faceDown === 0 ? 0 : Math.round((100 * r.turnedUp) / r.faceDown);
  console.log(`${name} (${deck}, morph ${cost})`);
  console.log(`  cast ${casts}: ${r.faceDown} face down (${share}%), ${r.printed} for the printed cost`);
  console.log(`  turned up ${r.turnedUp} of ${r.faceDown} (${followed}%)`);
  console.log(`  mean turn: face down ${mean(r.downTurns).toFixed(1)}, turned up ${mean(r.upTurns).toFixed(1)}`);
}
