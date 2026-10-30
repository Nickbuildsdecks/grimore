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
  all three and cost this file its first reading.

  `age` and `level` are deliberately absent: they count up, so "how many left" is not a question
  about them.

  **The zone is not hardcoded, and the first draft's was wrong.** `time` is shared between suspend,
  whose clock runs in **exile**, and vanishing, whose clock runs on the **battlefield** — the
  engine's own docblock on `TIME` says so in as many words, and this file read it and pinned the
  zone to exile anyway. The result was Calciderm reading "ran out 0%", which is impossible for a
  vanishing creature that is not answered, and that impossibility is what found the bug. So the zone
  an object is spending its counters in is **observed** rather than assumed, and "ran out" means the
  counters went while the object stayed where it was spending them.

  And what that is worth differs per clock, which is why the output labels each one instead of
  printing a single percentage as though higher were better:

   - `ice` — running out is the **payoff**. Thing in the Ice becomes a 7/8.
   - `time` in exile — running out is the **payoff**. The suspended card is cast.
   - `time` on the battlefield (vanishing) and `fade` — running out is the **price**. The creature
     is sacrificed, which is what the card charges for having been cheap, so a high percentage there
     means the card was *allowed to work*, not that it failed.

  **And for two of the three the split cannot be observed at all, which is the limit of this file
  and was found the hard way.** The split depends on telling "the clock expired" from "the object
  left holding its last counter", and the engine wipes an object's counters when it changes zone —
  so both end as "counters gone, object elsewhere" and the two are the *same observation*. That is
  fine for `ice`, whose expiry **transforms** the permanent and leaves it on the battlefield, so the
  object is still where it was spending and the reading is clean. It is not fine for `fade` or for
  vanishing's `time`, whose expiry *sacrifices* the creature, or for suspend, whose expiry *casts*
  the card out of exile: in all three the object is gone either way.

  Calciderm reading "ran out 0%" is what exposed it — impossible for an unanswered vanishing
  creature — and Blastoderm's "100%" was the same coin landing the other way, a read that happened
  to catch the one action boundary where the counters were gone and the sacrifice had not yet
  happened. Both numbers were artifacts of **where a read landed**, not facts about the cards.

  So `expiryLeavesObject` says which rows to believe, and the rows that cannot be split say so
  instead of printing a percentage that looks like an answer. Closing that gap needs the engine to
  record the expiry — a tenth member of the detect-rather-than-announce family — and that is a
  change to the engine rather than to this harness.
*/
const CLOCKS = [
  { key: 'ice', meaning: 'payoff', expiryLeavesObject: true },
  { key: 'fade', meaning: 'price', expiryLeavesObject: false },
  { key: 'time', meaning: 'payoff in exile, price on the battlefield', expiryLeavesObject: false },
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
          The counters are gone, and *why* is the whole measurement. `addCounters` deletes the key at
          zero, so an absent key means either the clock ran out or the object left — and the zone
          tells them apart. **Against the zone it was observed spending them in**, not against a
          zone this file guessed: see `CLOCKS`.
        */
        const r = row(was.name, clock.key);
        if (inst.zone === was.zone) r.ranOut += 1;
        else r.leftWith.push(was.count);
        r.turnsHeld.push(Math.max(0, st.turn - was.since));
        live.delete(tag);
      }
    }
  };

  read(s);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
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
for (const c of CLOCKS) {
  console.log(`  ${c.key.padEnd(5)} running out is the ${c.meaning}`
    + `${c.expiryLeavesObject ? '' : ' — expiry is NOT separable from being answered, see CLOCKS'}`);
}
console.log('');
console.log('card                     clock  started  ran out    left  ended  turns held');
for (const r of [...stats.values()].sort((a, b) => b.started - a.started)) {
  const clean = CLOCKS.find((c) => c.key === r.key)?.expiryLeavesObject === true;
  /*
    No percentage on a row whose split is an artifact. A number that cannot mean what its column
    heading says is worse than a blank, because a blank gets asked about.
  */
  const pct = !clean ? '   ?' : r.started === 0 ? ' n/a' : `${Math.round((r.ranOut / r.started) * 100)}%`;
  console.log(
    `${r.name.padEnd(24)} ${r.key.padEnd(6)} ${String(r.started).padStart(7)}`
    + `  ${String(r.ranOut).padStart(4)} ${pct.padStart(4)}`
    + `  ${String(r.leftWith.length).padStart(6)}  ${String(r.endedWith.length).padStart(5)}`
    + `  ${mean(r.turnsHeld).toFixed(1).padStart(5)}`
    + `${clean ? '' : '   (expiry not separable)'}`,
  );
  /*
    The distribution, which is the whole point and the reason a mean is not printed for it. "One
    counter left, nineteen times" and "four counters left, nineteen times" have the same average and
    opposite conclusions.
  */
  if (r.leftWith.length > 0) console.log(`    left with — ${tally(r.leftWith)}`);
  if (r.endedWith.length > 0) console.log(`    game ended with — ${tally(r.endedWith)}`);
}
