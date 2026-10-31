/**
 * The bot cannot see that a creature is leaving. How often does that cost it something?
 *
 * D244 closed the retune-a-weight avenue on evidence: of the six terms in `evaluate`, the two that
 * decide things are the two that predict well, and the one that predicts badly decides almost
 * nothing. So the next move has to be **a term that sees something the function cannot** — and the
 * plainest such thing is a clock. `creatureValue` is power + toughness + keyword values, and
 * `seatValue` counts permanents and creatures. **Nothing anywhere reads a countdown.** A Calciderm
 * with one time counter left scores exactly as a permanent 4/4; a dashed Mardu Scout about to
 * bounce scores as a 3/1 that is staying; a Ball Lightning scores as a 6/1 the turn it is sacrificed.
 *
 * Measure before writing the term, which is the discipline every bot rule in this project has been
 * held to and the reason four of them were deleted (D116) and two never shipped (D68, D69). So this
 * counts the four decisions a clock would change the **sign** of:
 *
 *  1. a card **spent on an opponent's creature that was leaving anyway** — removal, a counterspell,
 *     anything with a target. The clearest waste there is: the creature was going nowhere but away.
 *  2. an **attack declined** by a creature on its last turn. The bot holds a creature home when it
 *     would lose the trade; a creature that will be gone at the next upkeep loses nothing by
 *     trading, so every one of these is a free attack given up.
 *  3. a **block declined** by one, for the same reason and more sharply: a chump block by a body
 *     that is leaving anyway costs nothing at all.
 *  4. a **pump or aura spent on one** — a card invested in a body that will not be there.
 *
 *     SEEDS=2 node scripts/measure/leaving-creatures.mjs
 *     SEEDS=6 node scripts/measure/leaving-creatures.mjs     # the field six times
 *
 * **What it found, over 936 games (D246).** One mistake, and it is the one that cannot be argued
 * with: **18 attacks declined** by a Ball Lightning or a Hellspark Elemental that was sacrificed at
 * the end of that same turn — 13% and 14% of the attacks they were offered, and these are the two
 * cards whose entire function is one attack. All four end-of-turn rows read **0** after the fix.
 *
 * And one finding with the opposite sign to the one it first appeared to have, which is why the
 * **step** is in the table. Five cards were spent on an opponent's creature that was leaving
 * anyway, and not one of them was waste: every one was cast in `declare-attackers` or earlier, so
 * the Maze of Ith and the Darkblast aimed at an attacking Ball Lightning stopped six damage, which
 * is the whole job of both cards. Nor is the own-creature column waste — a Rancor returns to its
 * owner's hand and a Bonesplitter stays on the battlefield, so both outlive the body they pumped.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 */
import {
  applyAction, botAction, createGame, legalAttackers, legalBlockers, scriptFor, seatsToAct,
  DASHED, FADE, MYRIAD, TIME, UNEARTHED, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

/*
  Every deck in the pool, read from the registry rather than written out here — the reason every
  harness in this directory does it. A literal list is a place to forget the next deck.
*/
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 2);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const nameOf = (state, id) => state.cardDefs[state.instances[id]?.defKey ?? '']?.name ?? '?';

/*
  The two cards whose clock is a plain trigger with no marker on the permanent, found by reading the
  engine rather than by listing them here.

  Ball Lightning and Hellspark Elemental sacrifice themselves at the beginning of the end step, and
  that is printed text rather than a keyword, so there is no counter to read. What there *is* is the
  trigger's own `description`, which the engine writes for the table — "sacrifice Ball Lightning" —
  and an end-step trigger that describes itself as a sacrifice is exactly the thing being looked
  for. Derived, so a third such card is covered the day it is scripted; and the census below prints
  what the detector found, so a reader can see whether it found anything.
*/
const sacrificesItselfAtEnd = (name) => (scriptFor(name)?.triggers ?? []).some((t) => (
  t.on?.kind === 'step' && t.on.step === 'end' && (t.description ?? '').startsWith('sacrifice')));

/*
  How many more of its controller's combats this creature will see, and `null` when it has no clock
  at all. Zero means **this is its last turn on the board**, which is the number every count below
  keys on.

  The off-by-one between vanishing and fading is the one in the keywords and is worth stating,
  because it is the whole difference between them (D217): vanishing removes a counter at upkeep and
  sacrifices the permanent when the **last one is removed**, so a Calciderm holding one counter dies
  at the next upkeep and gets no further attack. Fading removes one and sacrifices the permanent
  when it **cannot**, so a Blastoderm holding one counter survives that upkeep and dies at the one
  after — one more combat than the identical-looking number suggests.
*/
function combatsLeft(state, id) {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return null;
  const c = inst.counters ?? {};
  // End of this turn, whatever else is true of it: these three are gone before the next combat.
  if ((c[DASHED] ?? 0) > 0 || (c[UNEARTHED] ?? 0) > 0 || (c[MYRIAD] ?? 0) > 0) return 0;
  if (sacrificesItselfAtEnd(nameOf(state, id))) return 0;
  if ((c[TIME] ?? 0) > 0) return (c[TIME] ?? 0) - 1;
  const script = scriptFor(nameOf(state, id));
  // Fading declares itself on the card, because a fading permanent holding zero counters is
  // indistinguishable from a permanent with no clock by its counters alone — and zero is the
  // reading that matters most, since it dies at the very next upkeep.
  if (script?.fading !== undefined) return c[FADE] ?? 0;
  return null;
}

const census = new Map();      // card -> times seen on the battlefield with a clock
const tally = {
  removalSpent: [],            // { spell, victim, clock } — a card pointed at a leaving creature
  pumpSpent: [],               // the same, pointed at one of your own
  attackDeclined: new Map(),   // card -> { offered, declined }
  blockDeclined: new Map(),    // card -> { offered, declined }
};
const bump = (map, card, declined) => {
  const row = map.get(card) ?? { offered: 0, declined: 0 };
  row.offered += 1;
  if (declined) row.declined += 1;
  map.set(card, row);
};

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const counted = new Set();
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, {});
    if (action === null) break;

    /*
      The census counts instances rather than sightings, so a Blastoderm that sits on the board for
      five turns is one creature on a clock and not five. Same reason `countdowns.mjs` keys on the
      instance: the question is how many bodies the measurement saw, not how long it looked at them.
    */
    for (const other of [0, 1]) {
      for (const id of Object.keys(s.instances)) {
        if (counted.has(id)) continue;
        const inst = s.instances[id];
        if (inst?.zone !== 'battlefield' || inst.zoneSeat !== other) continue;
        if (combatsLeft(s, id) === null) continue;
        counted.add(id);
        const card = nameOf(s, id);
        census.set(card, (census.get(card) ?? 0) + 1);
      }
    }

    // 1 and 4: a card with targets, pointed at a creature that is leaving on its own.
    if ((action.type === 'auto:cast' || action.type === 'auto:activate')
        && Array.isArray(action.targets)) {
      for (const target of action.targets) {
        if (target?.kind !== 'card') continue;
        const left = combatsLeft(s, target.id);
        /*
          One combat left counts as well as none, and deliberately. "It is leaving anyway" is a
          judgement about whether the card spent on it buys anything, and a removal spell aimed at a
          creature that gets exactly one more attack has bought one attack's worth — which is the
          case worth seeing next to the free one rather than the case to exclude.
        */
        if (left === null || left > 1) continue;
        /*
          The **step** is recorded, and the first reading without it was misleading in a way worth
          keeping a note of. "A card spent on a creature that was leaving anyway" sounds like pure
          waste and often is not: a Maze of Ith or a Darkblast pointed at an attacking Ball
          Lightning *before damage* stops six, which is the whole job of both cards, while the same
          Darkblast in the second main phase buys nothing at all. Same spell, same target, same
          clock, opposite plays — and only the step tells them apart.
        */
        const row = {
          spell: `${nameOf(s, action.card)} in ${s.step}`,
          victim: `${nameOf(s, target.id)} (${left} left)`,
        };
        const theirs = s.instances[target.id]?.zoneSeat !== seat;
        (theirs ? tally.removalSpent : tally.pumpSpent).push(row);
      }
    }

    // 2: an attack declined by a creature on its last turn.
    if (action.type === 'auto:attack') {
      const declared = new Set(action.attackers.map((a) => a.attacker));
      for (const id of legalAttackers(s, seat)) {
        const left = combatsLeft(s, id);
        if (left === null) continue;
        /*
          Bucketed by combats left rather than filtered to zero, because the two buckets ask
          different questions and want different answers. **Zero is a dominance argument**: a
          creature that is gone before the opponent's turn cannot block, so attacking with it risks
          nothing it was going to keep and declining is strictly worse. **One or more is a
          judgement**, where the clock should shift what a trade is worth without deciding it. If
          the mistakes are all in the zero row, the fix is a rule and not a term.
        */
        bump(tally.attackDeclined, `${nameOf(s, id)} (${Math.min(left, 2)}${left > 1 ? '+' : ''} left)`,
          !declared.has(id));
      }
    }

    // 3: a block declined by one. Same question, and the free one: the body is leaving either way.
    if (action.type === 'auto:block') {
      const declared = new Set(action.blocks.map((b) => b.blocker));
      for (const id of legalBlockers(s, seat)) {
        const left = combatsLeft(s, id);
        if (left === null) continue;
        bump(tally.blockDeclined, `${nameOf(s, id)} (${Math.min(left, 2)}${left > 1 ? '+' : ''} left)`,
          !declared.has(id));
      }
    }

    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
}

/*
  A seed of its own for every game (D240): one seed is one RNG stream, and the same stream yields
  the same index permutation however different the deck list is, so a pass over the field on one
  seed is one shuffle wearing every pairing.
*/
const seedFor = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;

let games = 0;
const started = Date.now();
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      duel(seedFor(i, a, b, 0), [ALL[a], ALL[b]]); games += 1;
      duel(seedFor(i, a, b, 1), [ALL[b], ALL[a]]); games += 1;
    }
  }
}

console.log(`${games} games, ${SEEDS} pass${SEEDS === 1 ? '' : 'es'} over the field, `
  + `${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log('"combats left" counts this creature\'s own future combats; 0 is its last turn');
console.log('');

console.log('creatures seen on a clock');
const seen = [...census.entries()].sort((x, y) => y[1] - x[1]);
for (const [card, n] of seen) console.log(`  ${card.padEnd(24)} ${String(n).padStart(5)}`);
if (seen.length === 0) console.log('  none at all');
console.log('');

const table = (title, rows) => {
  console.log(title);
  const grouped = new Map();
  for (const r of rows) {
    const key = `${r.spell} -> ${r.victim}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  const ordered = [...grouped.entries()].sort((x, y) => y[1] - x[1]);
  for (const [key, n] of ordered) console.log(`  ${String(n).padStart(5)}  ${key}`);
  if (ordered.length === 0) console.log('  none');
  console.log('');
};
table(`a card pointed at an OPPONENT'S creature with 0 or 1 combats left (${tally.removalSpent.length})`,
  tally.removalSpent);
table(`a card pointed at its controller's OWN such creature (${tally.pumpSpent.length})`,
  tally.pumpSpent);

const declined = (title, map) => {
  console.log(title);
  const rows = [...map.entries()].sort((x, y) => y[1].declined - x[1].declined);
  for (const [card, r] of rows) {
    console.log(`  ${card.padEnd(32)} ${String(r.declined).padStart(5)} of ${String(r.offered).padStart(5)}`
      + `  ${((100 * r.declined) / r.offered).toFixed(0)}%`.padStart(7));
  }
  if (rows.length === 0) console.log('  never offered');
  console.log('');
};
declined('attacks declined by a creature on a clock', tally.attackDeclined);
declined('blocks declined by a creature on a clock', tally.blockDeclined);

/*
  And the control, because every count above can read zero for two completely different reasons —
  "the bot does not make this mistake" and "the detector cannot see a clock" — and only this tells
  them apart. The census is the positive control: the pool has vanishing, fading, dash, unearth and
  two cards that sacrifice themselves, so a field pass that saw **no** creature on a clock has a
  broken `combatsLeft` rather than an interesting result. Same standard the README sets for
  `card-promises` and `term-leverage`.
*/
if (census.size === 0) {
  console.log('CONTROL FAILED: not one creature on a clock in the whole field, which cannot be true');
  console.log('of a pool with vanishing, fading, dash, unearth and two end-step sacrifices. The');
  console.log('clock detector is broken, so every zero above is measuring that instead.');
  process.exit(1);
}
console.log(`control held: ${census.size} card(s) seen on a clock, so the zeros above are readings`);
