/**
 * A permanent with a clock on it — how far did it actually get?
 *
 * Three keywords in this pool put a counter on an object and take one off every upkeep until there
 * are none left, and for all three the printed card is a *promise about the future*: Thing in the
 * Ice is a 7/8 four spells from now, a vanishing creature is a body you keep for three turns, a
 * suspended card is a spell you cast on turn five for two mana on turn two. **None of that is worth
 * anything if the clock never runs out**, and a cast count cannot tell: the card was cast, the
 * counters went on, and then the game happened.
 *
 * So this reads the one number that says whether the promise was kept — **how many counters were
 * left when the object stopped being able to spend them** — and the distribution is the diagnosis
 * rather than the mean. Four left is a card that never started. One left is a card that needs one
 * fewer, which is a reshape (D156's shape with Blight Vector) and not a cut. Those want opposite
 * fixes and a single average hides which you have.
 *
 * Written for #220 — Thing in the Ice flipped twice in forty-nine casts (D236) and nobody knew
 * whether the deck never gets there or the permanent dies first — but written general, because the
 * question is the same for every clock and the engine already has three.
 *
 * **It reads state, not actions** (the lesson `transform-use.mjs` learned the hard way): counters
 * live on the instance and nothing in the action stream announces one coming off. And it keys on the
 * instance, so a card that leaves and comes back is a new clock rather than a continuation — which
 * is what the rules say, since a permanent that changes zones is a new object with no counters.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/countdowns.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

/*
  Every deck in the pool, read from the registry rather than written out here — the reason every
  harness in this directory does it. A literal list is a place to forget the next deck, and a
  measurement that silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  The counters that count **down**, and what running out of them *means*, which is not the same for
  all three.

  `age` and `level` are deliberately absent: they count up, so "how many left" is not a question
  about them.

  **The zone is observed rather than assumed, and the first draft's was wrong.** `time` is shared
  between suspend, whose clock runs in **exile**, and vanishing, whose clock runs on the
  **battlefield** — the engine's `TIME` docblock says so and this file pinned it to exile anyway.
  Calciderm read "ran out 0%", impossible for an unanswered vanishing creature, and that
  impossibility is what found it.

  **And the same impossible number caught the next draft, one card along.** With the engine
  recording expiries (below) Blastoderm read `0 ran out, 0%` across 936 games — impossible too, for
  a creature that is sacrificed if it survives four upkeeps. The cause was this file's, not the
  engine's: it closed a clock the moment the counters were gone, and **fading's expiry is the upkeep
  after that** (see the zero-count branch in `read`). Twice now the tell has been a rate that could
  not be true rather than a rate that looked wrong, which is the only kind of error a harness can
  catch about itself.

  What running out is worth differs per clock, which is why each is labelled rather than scored by a
  single percentage as though higher were better:

   - `ice` — running out is the **payoff**. Thing in the Ice becomes a 7/8.
   - `time` in exile — running out is the **payoff**. The suspended card is cast.
   - `time` on the battlefield (vanishing) and `fade` — running out is the **price**. The creature
     is sacrificed, which is what the card charges for having been cheap, so a high number there
     means the card was *allowed to work*.

  **Two of these rows used to be unreadable, and #221 fixed the engine rather than this file.** The
  split needs "the clock expired" told apart from "the object left holding its last counter", and
  the engine wipes counters on a zone change — so for the three clocks that destroy or move their
  object on expiry, both were the same observation and this harness printed a `?` (D237). The engine
  now records the expiry into the log (`LogEntry.data.expired`, see `GameState.expired`), which is
  persistent, so the fact survives for something outside the engine to read. That is why the `?`
  is gone.
*/
const CLOCKS = [
  { key: 'ice', meaning: 'payoff' },
  { key: 'fade', meaning: 'price' },
  { key: 'time', meaning: 'payoff in exile, price on the battlefield' },
];

const stats = new Map();
const row = (name, key) => {
  const id = `${name}\u0000${key}`;
  const found = stats.get(id) ?? {
    name, key, started: 0, ranOut: 0, leftWith: [], endedWith: [], turnsHeld: [],
  };
  stats.set(id, found);
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

  /** instance+clock -> what we last saw: the count, the zone, and the turn it started. */
  const live = new Map();
  /*
    How much of the log has been read. The engine writes one entry per action and the log is
    **persistent**, which is the whole reason the expiry can be read from outside at all — a fact
    drained into `raise` would have been gone before this loop saw the state again.
  */
  let logRead = 0;
  /** instance+counter that the engine has said ran out, since the last read. */
  const expired = new Set();

  const readLog = (st) => {
    for (const entry of st.log.slice(logRead)) {
      for (const e of entry.data?.expired ?? []) expired.add(`${e.card}\u0000${e.counter}`);
    }
    logRead = st.log.length;
  };

  const read = (st) => {
    for (const clock of CLOCKS) {
      for (const [id, inst] of Object.entries(st.instances)) {
        const held = inst.counters?.[clock.key] ?? 0;
        const tag = `${id}\u0000${clock.key}`;
        const was = live.get(tag);
        if (held > 0) {
          if (was === undefined) {
            const name = nameOf(st, id);
            if (name === undefined) continue;
            live.set(tag, { count: held, zone: inst.zone, name, since: st.turn });
            row(name, clock.key).started += 1;
          } else {
            live.set(tag, { ...was, count: held, zone: inst.zone });
          }
          continue;
        }
        if (was === undefined) continue;
        /*
          **No counters left is not the same as the clock having run out**, and conflating the two is
          what the first two drafts of this file both did, in opposite directions.

          `addCounters` deletes the key at zero, so an absent key means one of three things: the
          clock expired, the object left, or — and this is the one that is easy to miss — the object
          is still sitting there having spent every counter, because **fading's expiry is the upkeep
          on which there is nothing to remove**. A Blastoderm with fading 3 spends its last counter
          on its third upkeep and is sacrificed on its fourth, so for a whole turn it is a creature
          with a finished countdown and an unpaid bill.

          So a zero is read in this order: the engine's word first, then the object leaving, and a
          zero on an object that is still where it was closes nothing at all.
        */
        const r = row(was.name, clock.key);
        if (expired.has(tag)) {
          /*
            **The engine's word, not an inference.** Before #221 this compared zones, which could
            only ever be right for `ice`: for the other three the object is gone either way and the
            comparison was reading where a poll happened to land. `readLog` runs before this, so an
            expiry and the move it causes arrive together.
          */
          r.ranOut += 1;
        } else if (inst.zone !== was.zone) {
          r.leftWith.push(was.count);
        } else {
          /*
            Still here with nothing left to spend: fading's last turn. Kept open, because the expiry
            has not happened yet and closing now would both miss it and credit the card with one
            counter more than it has. The count drops to 0 so that a creature answered during this
            window is recorded as having spent its whole clock and dodged the price, which is a
            different thing from being answered with a counter in hand.
          */
          live.set(tag, { ...was, count: 0, zone: inst.zone });
          continue;
        }
        r.turnsHeld.push(Math.max(0, st.turn - was.since));
        live.delete(tag);
      }
    }
  };

  readLog(s);
  read(s);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
    // The log first: an expiry and the object's disappearance land in the same action, so the fact
    // has to be in hand before the board is asked what happened.
    readLog(s);
    read(s);
  }
  /*
    And the clocks still ticking when the game ended, which are their own outcome and not a failure
    to be lumped in with the ones that were answered: a vanishing creature with two counters left on
    the turn somebody died did its job.
  */
  for (const [tag, was] of live) {
    // The key is on the tag, which is where it has been all along — the first draft looked it up by
    // card name and would have filed a card's clock under another card's.
    const key = tag.split('\u0000')[1] ?? '';
    row(was.name, key).endedWith.push(was.count);
  }
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

if (stats.size === 0) {
  console.log(`${games} games and no object ever carried a countdown counter.`);
  console.log('That is either a pool with no vanishing, fading or suspend in it, or a broken harness');
  console.log('— check `CLOCKS` against the engine\'s counter keys before believing it.');
  process.exit(0);
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const tally = (xs) => {
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([n, c]) => `${n}:${c}`).join(' ');
};
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log('turns count every seat\'s turn, so a duel\'s turn 8 is a seat\'s fourth\n');
/*
  The legend, printed above the table rather than left to the reader, because "ran out 100%" is a
  card working for a Blastoderm and a card failing for a Thing in the Ice and nothing in a column
  heading can carry that.
*/
for (const c of CLOCKS) console.log(`  ${c.key.padEnd(5)} running out is the ${c.meaning}`);
console.log('');
console.log('card                     clock  started  ran out    left  ended  turns held');
for (const r of [...stats.values()].sort((a, b) => b.started - a.started)) {
  const pct = r.started === 0 ? ' n/a' : `${Math.round((r.ranOut / r.started) * 100)}%`;
  console.log(
    `${r.name.padEnd(24)} ${r.key.padEnd(6)} ${String(r.started).padStart(7)}`
    + `  ${String(r.ranOut).padStart(4)} ${pct.padStart(4)}`
    + `  ${String(r.leftWith.length).padStart(6)}  ${String(r.endedWith.length).padStart(5)}`
    + `  ${mean(r.turnsHeld).toFixed(1).padStart(5)}`,
  );
  /*
    The distribution, which is the whole point and the reason a mean is not printed for it. "One
    counter left, nineteen times" and "four counters left, nineteen times" have the same average and
    opposite conclusions.
  */
  if (r.leftWith.length > 0) console.log(`    left with — ${tally(r.leftWith)}`);
  if (r.endedWith.length > 0) console.log(`    game ended with — ${tally(r.endedWith)}`);
}
