/**
 * How often a conditional static is actually **on**.
 *
 * A static conditioned on the board is the one card shape whose text can be true and worthless: a
 * Chrome Steed reads "+2/+2 as long as you control three or more artifacts", and in a deck that
 * rarely holds three artifacts it is a three-mana 2/2 with a paragraph on it. Nothing else measures
 * this. `cast-counts` says the card gets cast; `deck-probe` says whether the deck won more; neither
 * can say whether the ability the card is *for* was ever live.
 *
 * So: sample the condition once per turn for every such permanent on the battlefield, and report
 * the share of turns it held. Sampled per turn rather than per action deliberately — a turn with
 * forty actions in it is one turn of board state, and counting each action would weight a long turn
 * forty times over.
 *
 * Reports the mean artifact count beside it, because the share alone cannot tell "two artifacts,
 * nearly there" from "no artifacts, never close" — and those are different cards to fix.
 *
 * Galvanic Blast is the contrast and is counted separately: its condition is read once, as the
 * spell resolves, so what matters is how many of its casts dealt four rather than one.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/metalcraft.mjs
 */
import {
  applyAction, createGame, botAction, scriptFor, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/** Every card in the pool with a static that carries a condition, and which deck runs it. */
const conditional = new Map(); // name -> { deck, atLeast, text }
for (const [deckId, spec] of Object.entries(STARTER_DECKS)) {
  for (const entry of spec.cards) {
    for (const stat of scriptFor(entry.card.name)?.statics ?? []) {
      const cond = stat.effect.while;
      if (cond === undefined) continue;
      conditional.set(entry.card.name, { deck: deckId, atLeast: cond.atLeast, kind: cond.kind });
    }
  }
}
if (conditional.size === 0) {
  console.log('no card in the pool has a conditional static.');
  process.exit(0);
}

const stats = new Map(); // name -> { turns, on, artifacts: [] }
const row = (name) => {
  const found = stats.get(name) ?? { turns: 0, on: 0, artifacts: [], games: 0 };
  stats.set(name, found);
  return found;
};
/** Galvanic Blast, whose condition is read once rather than continuously. */
const blast = { casts: 0, big: 0 };

const isArtifact = (st, id) => /\bartifact\b/i.test(st.cardDefs[st.instances[id]?.defKey ?? '']?.typeLine ?? '');
const artifactsOf = (st, seat) =>
  (st.zones[`${seat}:battlefield`] ?? []).filter((id) => isArtifact(st, id)).length;

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name;
  const seen = new Set();
  let lastTurn = -1;
  for (let move = 0; move < 4000 && !s.finished; move++) {
    /*
      One sample per turn, taken on the turn changing, for every conditional permanent on the board.

      On the change rather than at some point inside the turn, because that is the one moment in a
      turn that happens exactly once however much is played in it.
    */
    if (s.turn !== lastTurn) {
      lastTurn = s.turn;
      for (const seat of [0, 1]) {
        const artifacts = artifactsOf(s, seat);
        for (const id of s.zones[`${seat}:battlefield`] ?? []) {
          const name = nameOf(s, id);
          const card = name === undefined ? undefined : conditional.get(name);
          if (card === undefined) continue;
          seen.add(name);
          const r = row(name);
          r.turns += 1;
          r.artifacts.push(artifacts);
          if (artifacts >= card.atLeast) r.on += 1;
        }
      }
    }
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    if (action.type === 'auto:cast' && nameOf(s, action.card) === 'Galvanic Blast') {
      blast.casts += 1;
      // Counted from the board as the spell is cast, which is the best this harness can do from
      // outside: the engine reads it again on resolution, and the two differ only when something
      // answers an artifact in between — which is exactly the case `scripts.test.ts` owns.
      if (artifactsOf(s, seat) >= 3) blast.big += 1;
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
for (const [name, { deck, atLeast }] of conditional) {
  const r = stats.get(name) ?? { turns: 0, on: 0, artifacts: [], games: 0 };
  const share = r.turns === 0 ? 0 : Math.round((100 * r.on) / r.turns);
  console.log(`${name} (${deck}, needs ${atLeast})`);
  console.log(`  on the board for ${r.turns} turns over ${r.games} games`);
  console.log(`  condition met on ${r.on} of them (${share}%), mean artifacts ${mean(r.artifacts).toFixed(1)}`);
}
if (blast.casts > 0) {
  const share = Math.round((100 * blast.big) / blast.casts);
  console.log(`\nGalvanic Blast: ${blast.casts} casts, ${blast.big} for four damage (${share}%)`);
}
