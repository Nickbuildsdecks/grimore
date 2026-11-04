/**
 * Can two decks of **arbitrary real cards** be played to a finish?
 *
 * This is the question the project is actually for — "no matter what deck we upload, it enforces
 * the rules" — and until D426 there was no way to ask it, because the only cards on hand were the
 * 348 somebody had written scripts for. With a corpus of 33,847 (`scripts/corpus/from-forge.mjs`)
 * the question is answerable, and it is **not** the same question as compiler coverage.
 *
 * ## Why coverage is the wrong number to read for this
 *
 * Hybrid automation (D362) means a card with an unread line is still dealt into an automated game,
 * with that line flagged for a human to apply. So a deck of cards the compiler reads badly is not
 * an unplayable deck — it is a playable deck with more manual steps. What would make a deck
 * unplayable is the engine **throwing**, or the table **stalling** with nobody able to move, and
 * neither of those is measured by a percentage of lines.
 *
 * So this harness reads three things a coverage figure cannot:
 *
 * 1. **Throws.** `applyAction` is called without a `try` around the bot's own move, so an exception
 *    is a crash this run attributes to a seed and a deck rather than swallowing. (`deck-table.mjs`
 *    and friends catch and `break`, which is right for a win-rate harness and wrong here: a crash
 *    that ends a game early silently becomes a loss.)
 * 2. **Stalls.** A move that does not change `stateVersion`, or a position with nobody to act and
 *    the game unfinished, is a table two people would be sitting at for ever.
 * 3. **How automated the game actually was** — the share of the deck's cards that are cardboard
 *    (nothing could make them playable), that came from printed data rather than a hand-written
 *    script, and that have at least one line the compiler could not read.
 *
 * ## The decks
 *
 * Random, which is the point: a deck somebody *built* is a deck whose cards work together, and the
 * failure this looks for is a card nobody anticipated. Each is `LANDS` basics in the colours its
 * spells actually need plus `SIZE - LANDS` distinct non-land cards drawn from the corpus, filtered
 * only for what the engine can be dealt at all — a single-face card with a type line. Cards with a
 * mana value over `MAXCMC` are left out because a 60-card deck of eight-drops never casts anything
 * and the game it plays is a land-drop contest, not a rules test.
 *
 * Deterministic from `SEED0`: the same seed is the same two decks and the same shuffle, so a crash
 * can be re-run.
 *
 *   node scripts/measure/corpus-decks.mjs --file corpus.json
 *   GAMES=50 SEED0=100 node scripts/measure/corpus-decks.mjs --file corpus.json
 *   VERBOSE=1 node scripts/measure/corpus-decks.mjs --file corpus.json   # every game, one line
 *
 * Exits non-zero if any game threw or stalled. It reads clean — 40 games, 80 random decks, every
 * one to a finish — and it is still **not** a gate step, for a reason that is about the corpus
 * rather than the result: `--file` needs the 12 MB JSON that `scripts/corpus/from-forge.mjs`
 * builds, which is somebody else's transcription of copyrighted card text and is deliberately not
 * committed (see that script's docblock). So this is run by hand, with the corpus rebuilt first.
 * What *is* in the gate is `customDeck.test.ts`, which pins the same two claims on fixtures: a
 * compiled creature arrives at its printed size and survives arrival, and a creature nothing can
 * size stays cardboard (D431).
 */
import { readFileSync } from 'node:fs';
import {
  applyAction, botAction, createGame, customDeck, scriptForCard, seatsToAct, unreadLines,
} from '../lib/engine.mjs';
import { provenanceLine } from '../lib/provenance.mjs';

const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];
if (file === null) {
  console.error('usage: node scripts/measure/corpus-decks.mjs --file <corpus.json>');
  process.exit(2);
}
const GAMES = Number(process.env.GAMES ?? 20);
const SEED0 = Number(process.env.SEED0 ?? 1);
const SIZE = Number(process.env.SIZE ?? 60);
const LANDS = Number(process.env.LANDS ?? 24);
const MAXCMC = Number(process.env.MAXCMC ?? 6);
const MOVES = Number(process.env.MOVES ?? 6000);
const VERBOSE = process.env.VERBOSE === '1';

const rows = (() => {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.data ?? []);
})();

const BASICS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
const BASIC_OF = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/**
 * The cards a deck may be built from.
 *
 * Only two filters, and both are about what can be *dealt* rather than about what plays well: a
 * card with no type line is cardboard by `customDeck`'s own marker, and a multi-face layout is
 * refused by `printedDef` with a reason. Everything else is in, including the cards the compiler
 * reads nothing of — those are the interesting ones.
 */
const spells = rows.filter((row) => (row.type_line ?? '') !== ''
  && (row.layout ?? 'normal') === 'normal'
  && !/\bLand\b/.test(row.type_line)
  && (row.cmc ?? 0) <= MAXCMC);
const basics = BASICS
  .map((name) => rows.find((row) => row.name === name))
  .filter((row) => row !== undefined);

console.log(`Source: ${file}`);
console.log(`  ${provenanceLine({ FILE: file, GAMES: String(GAMES), SEED0: String(SEED0) })}`);
console.log(`Castable non-land pool: ${spells.length} of ${rows.length} rows`);
console.log(`Basics found: ${basics.map((row) => row.name).join(', ')}\n`);
if (basics.length < 5) {
  console.error('!! the corpus is missing a basic land, so decks cannot be given mana');
  process.exit(2);
}

/** A seeded stream, so a crash is reproducible from the seed alone. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One random deck, plus what the engine was able to make of its cards. */
function buildDeck(id, seed) {
  const next = rng(seed);
  const chosen = [];
  const seen = new Set();
  while (chosen.length < SIZE - LANDS) {
    const row = spells[Math.floor(next() * spells.length)];
    if (row === undefined || seen.has(row.name)) continue;
    seen.add(row.name);
    chosen.push(row);
  }
  /*
    Basics for the colours the spells actually ask for, which is the one piece of deckbuilding this
    does: a random pile's mana is otherwise unrelated to its spells and every game is a mulligan.
    Shared evenly, with the remainder going to the commonest colour.
  */
  const want = new Map();
  for (const row of chosen) for (const colour of row.colors ?? []) {
    want.set(colour, (want.get(colour) ?? 0) + 1);
  }
  const ranked = [...want.entries()].sort((a, b) => b[1] - a[1]).map(([colour]) => colour);
  const colours = ranked.length === 0 ? ['R'] : ranked.slice(0, 3);
  const entries = chosen.map((row) => ({ name: row.name, count: 1 }));
  for (let i = 0; i < colours.length; i++) {
    const share = Math.floor(LANDS / colours.length) + (i === 0 ? LANDS % colours.length : 0);
    entries.push({ name: BASIC_OF[colours[i]], count: share });
  }

  const built = customDeck({ id, name: id, entries, data: [...chosen, ...basics] });
  // What the engine made of the list, which is the second half of what this harness reports.
  let scripted = 0;
  let partial = 0;
  for (const entry of built.deck.cards) {
    const def = entry.card;
    if ((def.typeLine ?? '') === '') continue;
    if (scriptForCard(def) !== undefined) scripted += 1;
    if (unreadLines(def).length > 0) partial += 1;
  }
  return { ...built, colours, distinct: built.deck.cards.length, scripted, partial };
}

/** One game to a finish, or to the first thing that stops it. */
function play(seed) {
  const a = buildDeck('corpus:a', seed * 2);
  const b = buildDeck('corpus:b', seed * 2 + 1);
  const decks = { 'corpus:a': a.deck, 'corpus:b': b.deck };
  const host = { isHost: true, decks };

  let s = createGame({
    id: `corpus${seed}`,
    format: 'modern',
    players: [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }],
    seed,
  });
  for (const [seat, id] of [[0, 'corpus:a'], [1, 'corpus:b']]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: id }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);

  let moves = 0;
  for (; moves < MOVES && !s.finished; moves++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) {
      return { verdict: 'nobody-to-act', seed, moves, turn: s.turn, a, b };
    }
    const action = botAction(s, seat, {});
    if (action === null) {
      return { verdict: 'no-move', seed, moves, turn: s.turn, a, b };
    }
    const before = s.stateVersion;
    /*
      Deliberately **not** wrapped. A throw here is the thing this harness exists to find, and
      catching it would turn a crash into a short game — which is exactly how 35 harnesses hid the
      engine throwing for weeks (D244). The caller catches, once, and attributes it.
    */
    s = applyAction(s, action);
    if (s.stateVersion === before) {
      return {
        verdict: 'stalled', seed, moves, turn: s.turn, a, b,
        detail: `${action.type} by seat ${seat} changed nothing`,
      };
    }
  }
  if (!s.finished) return { verdict: 'unfinished', seed, moves, turn: s.turn, a, b };
  return { verdict: 'finished', seed, moves, turn: s.turn, winner: s.winnerSeat, a, b };
}

const tally = new Map();
const problems = [];
let totalMoves = 0;
let totalTurns = 0;
let scripted = 0;
let partial = 0;
let cardboard = 0;
let fromData = 0;
let decksBuilt = 0;

for (let i = 0; i < GAMES; i++) {
  const seed = SEED0 + i;
  let result;
  try {
    result = play(seed);
  } catch (error) {
    result = { verdict: 'threw', seed, detail: `${error?.message ?? error}` };
    problems.push(result);
  }
  tally.set(result.verdict, (tally.get(result.verdict) ?? 0) + 1);
  if (result.verdict !== 'finished' && result.verdict !== 'threw') problems.push(result);
  totalMoves += result.moves ?? 0;
  totalTurns += result.turn ?? 0;
  for (const deck of [result.a, result.b]) {
    if (deck === undefined) continue;
    decksBuilt += 1;
    scripted += deck.scripted;
    partial += deck.partial;
    cardboard += deck.unknown.length;
    fromData += deck.fromData.length;
  }
  if (VERBOSE) {
    const shape = result.a === undefined ? '' : ` [${result.a.colours.join('')} v ${result.b.colours.join('')}]`;
    console.log(`  seed ${seed}: ${result.verdict}${shape} turn ${result.turn ?? '-'} `
      + `moves ${result.moves ?? '-'}${result.detail === undefined ? '' : ` — ${result.detail}`}`);
  }
}

console.log(`\nGames: ${GAMES}`);
for (const [verdict, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${verdict.padEnd(14)} ${String(n).padStart(5)}`);
}
const finished = tally.get('finished') ?? 0;
if (finished > 0) {
  console.log(`\nOf the games that finished: ${(totalTurns / GAMES).toFixed(1)} turns and `
    + `${Math.round(totalMoves / GAMES)} moves on average`);
}
if (decksBuilt > 0) {
  const per = (n) => (n / decksBuilt).toFixed(1);
  console.log(`\nPer deck of ${SIZE} (${decksBuilt} decks built):`);
  console.log(`  distinct cards the engine was given a script for: ${per(scripted)}`);
  console.log(`  cards with at least one line nothing could read:  ${per(partial)}`);
  console.log(`  cards playable only because of the printed data:  ${per(fromData)}`);
  console.log(`  cardboard — nothing could make them playable:     ${per(cardboard)}`);
}
if (problems.length > 0) {
  console.log(`\n${problems.length} game(s) did not reach a finish:`);
  for (const problem of problems.slice(0, 20)) {
    console.log(`  seed ${problem.seed}: ${problem.verdict}`
      + `${problem.detail === undefined ? '' : ` — ${problem.detail}`}`);
  }
  console.log('\nRe-run one with: SEED0=<seed> GAMES=1 VERBOSE=1 node scripts/measure/corpus-decks.mjs --file <corpus>');
  process.exit(1);
}
console.log('\nEvery game reached a finish, with no throw and no stall.');
