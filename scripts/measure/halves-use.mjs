/**
 * Which half of a two-faced card the bot reaches for, and whether the adventure ever comes back.
 *
 * `cast-counts` answers "is this slot dead", and for a card with two castable faces that is not
 * enough — the same reason `morph-use` exists. A split card at 85% looks perfectly healthy while
 * one of its halves has never been cast, and the whole argument for putting it in a deck is that
 * both halves get used. So this counts **casts per face**.
 *
 * For an adventurer there is a second number, and it is the honest one: an adventure that is cast
 * and then never followed up is a sorcery that cost its controller a creature. "Cast 40 adventures,
 * cast 9 creatures back out of exile" is a different card from "40 and 38", and a measurement that
 * only counted the adventures would call both of them fine.
 *
 * Reports the turn each thing happened on too, for the reason `morph-use` does: a one-mana 0/4 on
 * turn one and a mill-four on turn three are the same card doing two different jobs, and a count
 * with no turn in it cannot tell them apart.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/halves-use.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
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

/** Every card in the pool with more than one castable face, and which deck runs it. */
const twoFaced = new Map(); // name -> { deck, kind, faces: [names] }
for (const [deckId, spec] of Object.entries(STARTER_DECKS)) {
  for (const entry of spec.cards) {
    const faces = entry.card.faces;
    if (faces === undefined) continue;
    twoFaced.set(entry.card.name, {
      deck: deckId, kind: faces.kind, faces: faces.cards.map((f) => f.name),
    });
  }
}
if (twoFaced.size === 0) {
  console.log('no card in the pool has more than one castable face.');
  process.exit(0);
}

const stats = new Map(); // card name -> counters
const row = (name) => {
  const found = stats.get(name) ?? {
    byFace: new Map(), printed: 0, back: 0, backTurns: [], games: 0, onlyLand: 0, landPlays: 0,
  };
  stats.set(name, found);
  return found;
};

/**
 * Whether this seat's hand holds any *other* land it could have played instead.
 *
 * The number that says whether a modal card's land half earned its slot. A deck playing one of
 * these is a deck with twenty-one lands that are sometimes spells, and the claim is that it misses
 * fewer land drops — so the honest question at the moment the back face is played is "was this the
 * only land you had?". A yes is a land drop the deck would otherwise have missed; a no is a card
 * spent as a tapped land while an untapped one sat in hand, which is the bot playing badly.
 *
 * Counts a *modal* card's land face as a land in hand too, because that is what it is: two Hagra
 * Maulings in hand is two land drops available, however it feels.
 */
const hasOtherLand = (st, seat, exceptId) => {
  for (const id of st.zones[`${seat}:hand`] ?? []) {
    if (id === exceptId) continue;
    const def = st.cardDefs[st.instances[id]?.defKey ?? ''];
    if (def === undefined) continue;
    if (/\bland\b/i.test(def.typeLine)) return true;
    if (def.faces?.kind === 'modal'
      && def.faces.cards.some((f) => /\bland\b/i.test(f.typeLine))) return true;
  }
  return false;
};
const face = (r, name) => {
  const found = r.byFace.get(name) ?? { casts: 0, turns: [] };
  r.byFace.set(name, found);
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
    const card = name === undefined ? undefined : twoFaced.get(name);
    /*
      A modal card's back face is **played**, not cast, so it never reaches the branch below.

      Counted here as a use of that face, like any other half — and with the one number the
      mechanic is actually for beside it: whether the hand held another land at the time.
    */
    if (card !== undefined && action.type === 'auto:playLand' && action.half !== undefined) {
      seen.add(name);
      const r = row(name);
      const f = face(r, card.faces[action.half] ?? `face ${action.half}`);
      f.casts += 1;
      f.turns.push(s.turn);
      r.landPlays += 1;
      if (!hasOtherLand(s, seat, action.card)) r.onlyLand += 1;
    }
    if (card !== undefined && action.type === 'auto:cast') {
      seen.add(name);
      const r = row(name);
      if (action.half === undefined) {
        /*
          The card cast as itself, which means two different things and the zone says which.

          From hand it is an adventurer cast as its creature, straight off — the half of the card
          that skips the adventure entirely. From **exile** it is the creature coming back after an
          adventure resolved, which is the number this instrument exists to report.
        */
        if (s.instances[action.card]?.zone === 'exile') {
          r.back += 1;
          r.backTurns.push(s.turn);
        } else {
          r.printed += 1;
          const f = face(r, name);
          f.casts += 1;
          f.turns.push(s.turn);
        }
      } else {
        const f = face(r, card.faces[action.half] ?? `face ${action.half}`);
        f.casts += 1;
        f.turns.push(s.turn);
      }
    }
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
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
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}\n`);
for (const [name, { deck, kind, faces }] of twoFaced) {
  const r = stats.get(name) ?? { byFace: new Map(), printed: 0, back: 0, backTurns: [], games: 0 };
  const names = kind === 'split' ? faces : [name, ...faces];
  const total = names.reduce((n, f) => n + (r.byFace.get(f)?.casts ?? 0), 0);
  console.log(`${name} (${deck}, ${kind}) — cast ${total} over ${r.games} games`);
  for (const f of names) {
    const got = r.byFace.get(f) ?? { casts: 0, turns: [] };
    const share = total === 0 ? 0 : Math.round((100 * got.casts) / total);
    console.log(`  ${f.padEnd(24)} ${String(got.casts).padStart(4)} (${share}%)  mean turn ${mean(got.turns).toFixed(1)}`);
  }
  if (kind === 'modal') {
    const share = r.landPlays === 0 ? 0 : Math.round((100 * r.onlyLand) / r.landPlays);
    console.log(`  played as a land with no other land in hand  ${String(r.onlyLand).padStart(4)}`
      + ` of ${r.landPlays} (${share}%)`);
  }
  if (kind === 'adventure') {
    const adventures = r.byFace.get(faces[0])?.casts ?? 0;
    const followed = adventures === 0 ? 0 : Math.round((100 * r.back) / adventures);
    console.log(`  came back out of exile      ${String(r.back).padStart(4)} of ${adventures} adventures (${followed}%)`
      + `, mean turn ${mean(r.backTurns).toFixed(1)}`);
  }
}
