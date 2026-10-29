/**
 * Does the computer opponent read what it cannot see?
 *
 * The question a person actually asks about a bot, and the one no win rate answers. D110 built the
 * *reply* — the search letting the opponent answer inside it — measured it level over 240 paired
 * duels, and reverted it with a sentence that has been sitting in the "Next" list ever since: a bot
 * that declines to attack because of the exact card you are holding is not a better opponent, it is
 * a cheating one. The reply is gone, but nothing has ever *checked* the bot that shipped.
 *
 * So this checks it, by the only method that cannot be argued with: ask the bot twice about the
 * same position, once as it is and once with **everything the acting seat cannot see replaced by
 * something else**, and compare the two answers. A bot that uses hidden information must answer
 * differently at least sometimes. A bot that answers identically every time is not reading it.
 *
 * **What counts as hidden** is not this file's opinion — it is `viewFor`, the redaction the engine
 * already sends to a real client:
 *
 * - the **identities** of cards in any other seat's hand (the ids and the count travel, so a hand
 *   is drawn and counted; the cards are not);
 * - the identities and order of **every** library, the acting seat's own included;
 * - the card under a **face-down** permanent somebody else controls (publicly a 2/2, CR 707.2).
 *
 * Everything else is public and stays untouched: life, poison, counters, hand and library *sizes*,
 * both graveyards, both exiles, the battlefield, the stack.
 *
 * **The scramble keeps the position legal, which is what makes the comparison fair.** For each
 * seat, the `defKey`s of the cards in its hidden pool are collected, shuffled with a seeded
 * generator and dealt back to the same ids — so every zone keeps its length, every card keeps its
 * owner, and the only thing that changes is which card is which. The acting seat's own hand and
 * every public zone are left exactly as they were.
 *
 * Two kinds of sample are dropped rather than guessed at:
 *
 * - a position where a **search or a scry** is pending, because reading a library is what the card
 *   on the stack is for, and a seat that is `searching` is entitled to the order;
 * - a position where the scramble cannot run (nothing hidden to permute), which is not a sample.
 *
 * A difference here is not automatically a cheat: a card whose own text reads a hidden zone would
 * show up too. It is a **suspect**, and the output names the card so the next step is reading the
 * one script rather than auditing the bot.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=2 node scripts/measure/hidden-info.mjs
 *     SEEDS=2 BOT='{"blindToShuffle":false}' node scripts/measure/hidden-info.mjs   # the control
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 2);
/*
  The bot under audit, so this instrument can be its own control.

  `BOT='{"blindToShuffle":false}'` is the bot that reads the shuffle — the leak D224 fixed — and it
  is the arm that makes a zero mean something. Run both ways: 9 changed decisions with the flag off,
  0 with it on, over the same 156 games.
*/
const BOT = JSON.parse(process.env.BOT ?? '{}');
const SEED0 = Number(process.env.SEED0 ?? 3300);
/** How many scrambles to ask per position. More is a stronger test and a slower one. */
const DRAWS = Number(process.env.DRAWS ?? 3);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

let games = 0;
let asked = 0;
/**
 * How many card identities the scramble actually moved, summed over every scramble it built.
 *
 * Printed because a zero in the column that matters is only meaningful if this is large: an
 * instrument whose scramble silently did nothing would report a perfectly honest bot about a bot
 * that was reading everything. It is this file's negative control, and it is in the output rather
 * than in a comment so nobody has to trust the claim.
 */
let moved = 0;
let differed = 0;
let skippedSearching = 0;
/** action type → { n, differed } */
const byKind = new Map();
/** A few examples, because a count without a position is not actionable. */
const examples = [];

/** A small deterministic generator, so a difference found here can be found again. */
function rng(seed) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

const note = (kind, same) => {
  const row = byKind.get(kind) ?? { n: 0, differed: 0 };
  row.n += 1;
  if (!same) row.differed += 1;
  byKind.set(kind, row);
};

/**
 * The ids whose identity `seat` is not entitled to, by seat.
 *
 * Grouped by **owner** rather than thrown into one pool, because a card's owner is public: its id
 * is in that seat's zone list either way, and a scramble that moved a card between two players'
 * hands would be changing something a client can see.
 */
function hiddenPools(state, seat) {
  const pools = [];
  for (const other of state.seats) {
    const ids = [];
    // Another seat's hand: the identities only, which is exactly what `viewFor` withholds.
    if (other.index !== seat) ids.push(...(state.zones[`${other.index}:hand`] ?? []));
    // Every library, this seat's own included — an order nobody is entitled to.
    ids.push(...(state.zones[`${other.index}:library`] ?? []));
    // And the card under somebody else's face-down permanent, which is publicly a 2/2.
    if (other.index !== seat) {
      for (const id of state.zones[`${other.index}:battlefield`] ?? []) {
        if (state.instances[id]?.faceDown === true) ids.push(id);
      }
    }
    if (ids.length > 1) pools.push(ids);
  }
  return pools;
}

/** The same position with every hidden card's identity dealt out again. */
function scramble(state, seat, seed) {
  const next = rng(seed);
  const instances = { ...state.instances };
  for (const pool of hiddenPools(state, seat)) {
    const keys = pool.map((id) => state.instances[id]?.defKey);
    if (keys.some((key) => key === undefined)) continue;
    for (let i = keys.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    pool.forEach((id, i) => {
      const inst = instances[id];
      if (inst === undefined) return;
      if (inst.defKey !== keys[i]) moved += 1;
      /*
        `castAs` is the half of a split card that is on the stack and `revealed` is a card somebody
        has been shown on purpose; neither is ever set on a card in a hidden pool, and clearing
        them here would be inventing a difference rather than finding one.
      */
      instances[id] = { ...inst, defKey: keys[i] };
    });
  }
  return { ...state, instances };
}

/** Whether this position is one where reading a library is the card's own job. */
const readingLibrary = (state) => state.pendingDecision !== null
  || state.pendingChoice !== null
  || state.seats.some((seat) => seat.searching);

function duel(seed, decks) {
  const ctx = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, ctx);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, ctx);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, ctx);

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const chosen = botAction(s, seat, BOT);
    if (chosen === null) break;

    if (readingLibrary(s)) {
      skippedSearching += 1;
    } else {
      const truth = JSON.stringify(chosen);
      let same = true;
      for (let draw = 0; draw < DRAWS; draw += 1) {
        const other = botAction(scramble(s, seat, seed * 7919 + move * 31 + draw), seat, BOT);
        if (JSON.stringify(other) !== truth) {
          same = false;
          if (examples.length < 12) {
            const name = chosen.card === undefined
              ? undefined
              : s.cardDefs[s.instances[chosen.card]?.defKey ?? '']?.name;
            examples.push(`${decks[seat]} seat ${seat} turn ${s.turn} ${s.step}:`
              + ` ${chosen.type}${name === undefined ? '' : ` ${name}`}`
              + ` → ${JSON.stringify(other) === 'null' ? 'nothing' : (other?.type ?? '?')}`);
          }
          break;
        }
      }
      asked += 1;
      if (!same) differed += 1;
      note(chosen.type, same);
    }

    const before = s.stateVersion;
    try { s = applyAction(s, chosen, ctx); } catch { break; }
    if (s.stateVersion === before) break;
  }
  games += 1;
}

for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) duel(SEED0 + i, [ALL[a], ALL[b]]);
  }
}

const pc = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}, ${DRAWS} scrambles per decision`);
console.log(`${asked} decisions asked both ways; ${skippedSearching} dropped because a card was`
  + ' reading a library');
console.log(`${moved} card identities were actually moved by the scrambles — the zero below means`
  + ' nothing unless this is large');
console.log('');
console.log(`decisions that changed when the hidden cards changed: ${differed} (${pc(differed, asked)})`);
console.log('');
for (const [kind, row] of [...byKind].sort((a, b) => b[1].differed - a[1].differed)) {
  console.log(`  ${String(row.differed).padStart(5)} of ${String(row.n).padStart(6)}`
    + ` ${pc(row.differed, row.n).padStart(4)}  ${kind}`);
}
if (examples.length > 0) {
  console.log('\nthe first of them, to read the script behind:');
  for (const line of examples) console.log(`  ${line}`);
}
