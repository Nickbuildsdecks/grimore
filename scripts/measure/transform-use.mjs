/**
 * Do the transform cards actually turn over, and on which turn?
 *
 * `deck-probe` says the Delver + Thing in the Ice pair is worth seven to thirteen points over the
 * second Lightning Bolt and second Counterspell it replaced (D234, two seed sets). **It does not
 * say why**, and the candidate stories want opposite follow-ups: a Delver flipping on turn two into
 * a 3/2 flier is a clock, an Awoken Horror resetting a board on turn six is a sweeper, and if
 * neither happens then seven points is a 1/1 and a 0/4 being better bodies than two spells — which
 * is a third thing, and a reason to doubt the pair rather than to celebrate it.
 *
 * `morph-use.mjs` makes the argument this file reuses: `cast-counts.mjs` answers "is this slot
 * dead", and for a card with a second state that is not enough, because the casts can look
 * perfectly healthy while the mechanic goes unused. The two numbers that say whether the second
 * face is in the deck for a reason are **how often it is reached** and **when**.
 *
 * **It watches state rather than actions, and that is the one real difference from morph.** A morph
 * turning up is an action (`auto:turnUp`), so a harness can read it off the action stream. A
 * transform happens inside an effect's resolution and is recorded in `GameState.transformed`, which
 * `settle` drains before anything outside the engine could read it. So this reads the battlefield
 * after each action and asks whether any permanent is now showing a back face.
 *
 * The last face seen is tracked **per instance**, so a flip *back* counts as its own transition
 * rather than being missed. Nothing in this pool flips back, so that column reading zero is the
 * honest check on D234's claim that the symmetric half of `transformPermanent` is exercised by no
 * card — if it ever reads non-zero, a card has started using it and the claim needs rewriting.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/transform-use.mjs
 */
import {
  applyAction, createGame, botAction, characteristicsOf, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

/*
  Every deck in the pool, read from the registry rather than written out here — the same reason
  every other harness here does it. A literal list is a place to forget the next deck, and a
  measurement that silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/** Front face name -> back face name, for every transforming card in the pool. */
const backOf = new Map();
/** Back face name -> the front it belongs to, which is how a flip is recognised on the board. */
const frontOf = new Map();
const deckOf = new Map();
for (const [deckId, spec] of Object.entries(STARTER_DECKS)) {
  for (const entry of spec.cards) {
    if (entry.card.faces?.kind !== 'transform') continue;
    const back = entry.card.faces.cards[0];
    if (back === undefined) continue;
    backOf.set(entry.card.name, back.name);
    frontOf.set(back.name, entry.card.name);
    deckOf.set(entry.card.name, deckId);
  }
}
if (backOf.size === 0) {
  console.log('no card in the pool transforms.');
  process.exit(0);
}

const stats = new Map();
const row = (name) => {
  const found = stats.get(name) ?? {
    cast: 0, flipped: 0, flippedBack: 0, flipTurns: [], boardAtFlip: [], games: 0,
  };
  stats.set(name, found);
  return found;
};

/** Creatures on the battlefield right now, both sides — the size of a reset, read as it happens. */
function creatureCount(s) {
  let n = 0;
  for (const inst of Object.values(s.instances)) {
    if (inst.zone !== 'battlefield') continue;
    if (characteristicsOf(s, inst).isCreature) n += 1;
  }
  return n;
}

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name;
  const seen = new Set();
  /*
    The face each instance was last seen wearing. Keyed by instance rather than by card name,
    because two copies of the same card are two permanents and a flip belongs to one of them — and
    because this is what lets a flip *back* be a transition rather than a repeat.
  */
  const face = new Map();

  const readBoard = (st) => {
    for (const [id, inst] of Object.entries(st.instances)) {
      /*
        **Forgotten the moment it leaves the battlefield, and the first run of this file is why.**

        It reported two "flips back to a front face" in a pool where no card flips back, which would
        have been an engine bug if it were true. It was this instrument: `relocate` restores the
        front face on the way off the battlefield (CR 712.4a), so a transformed Insectile Aberration
        that is bounced and recast arrives as Delver of Secrets — and a detector that remembered the
        back face across the two zones read that as the permanent turning over. It is a card being
        cast again, which is the rule working.

        So the face is only ever compared against the face this *same stay* on the battlefield
        started with.
      */
      if (inst.zone !== 'battlefield') { face.delete(id); continue; }
      const name = nameOf(st, id);
      if (name === undefined) continue;
      const isBack = frontOf.has(name);
      const isFront = backOf.has(name);
      if (!isBack && !isFront) continue;
      const was = face.get(id);
      face.set(id, name);
      if (was === undefined || was === name) continue;
      // A name that changed between a front and its own back is a transform rather than, say, a
      // Clone pointing somewhere new.
      if (isBack && frontOf.get(name) === was) {
        const r = row(was);
        r.flipped += 1;
        r.flipTurns.push(st.turn);
        r.boardAtFlip.push(creatureCount(st));
        seen.add(was);
      } else if (isFront && backOf.get(name) === was) {
        row(name).flippedBack += 1;
        seen.add(name);
      }
    }
  };

  readBoard(s);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    if (action.type === 'auto:cast' && action.card !== undefined) {
      const name = nameOf(s, action.card);
      if (name !== undefined && backOf.has(name)) { row(name).cast += 1; seen.add(name); }
    }
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
    readBoard(s);
  }
  for (const name of seen) row(name).games += 1;
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

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (n, d) => (d === 0 ? ' n/a' : `${Math.round((n / d) * 100)}%`.padStart(4));
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}`);
/*
  `turn` counts every player's turn, not rounds, which is worth saying where the number is printed:
  "turn 8" in a duel is a seat's fourth turn, and a column that quietly meant one and was read as
  the other would make a turn-four flip look like a turn-eight one.
*/
console.log('turns count every seat\'s turn, so a duel\'s turn 8 is a seat\'s fourth\n');
console.log('card                     deck          cast  flipped   of casts  turn  board  back');
for (const [name, back] of backOf) {
  const r = stats.get(name) ?? { cast: 0, flipped: 0, flippedBack: 0, flipTurns: [], boardAtFlip: [] };
  const turn = r.flipTurns.length === 0 ? '  -' : mean(r.flipTurns).toFixed(1).padStart(4);
  const first = r.flipTurns.length === 0 ? '' : ` (first t${Math.min(...r.flipTurns)})`;
  const board = r.boardAtFlip.length === 0 ? '  -' : mean(r.boardAtFlip).toFixed(1).padStart(5);
  console.log(
    `${name.padEnd(24)} ${(deckOf.get(name) ?? '').padEnd(13)} ${String(r.cast).padStart(4)}`
    + `  ${String(r.flipped).padStart(7)}  ${pct(r.flipped, r.cast).padStart(8)}`
    + `  ${turn}  ${board}  ${String(r.flippedBack).padStart(4)}${first}`,
  );
  console.log(`  -> ${back}`);
}
/*
  And the one line that says whether the symmetric half of `transformPermanent` is in use.

  D234 says no card flips back and that the half is tested by itself rather than by a card. Printed
  on every run so the day that stops being true, the run says so rather than the claim quietly
  going stale.
*/
const backs = [...stats.values()].reduce((n, r) => n + r.flippedBack, 0);
console.log(`\n${backs} flips back to a front face`
  + `${backs === 0 ? ' — the symmetric half is still exercised by no card (D234)' : ' — D234 needs rewriting'}`);
