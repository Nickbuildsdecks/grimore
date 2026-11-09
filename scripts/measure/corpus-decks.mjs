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
 *   POD=1 LEGAL=1 GAMES=100 node scripts/measure/corpus-decks.mjs --file corpus.json
 *   POD=1 GAMES=1 SEED0=30002 TRACE=2000 node scripts/measure/corpus-decks.mjs --file corpus.json
 *   LOOP=0 node scripts/measure/corpus-decks.mjs --file corpus.json   # no loop detector
 *
 * ## Two arms, and the second one is the question Nick actually asked
 *
 * The default is a two-seat duel of random 60-card decks. **`POD=1` is four-player Commander**: four
 * seats, forty life, singleton 100-card decks and a legendary creature in each command zone — which
 * is what "me and some friends play a bunch of games" means, and a materially harder question. A pod
 * is where every stall this project has found actually lived (#297, #302, #330): more seats, longer
 * games, and politics the bot has to resolve. The duel arm stays the default because its figures are
 * recorded across many commits and because it is the faster signal; the pod arm is the one to run
 * before claiming anything about beta readiness.
 *
 * Exits non-zero if any game threw, stalled, looped, or ran out the move cap.
 *
 * **It has read clean and it has not.** The duel arm has been green since it was written — 60 games,
 * 120 random decks, every one to a finish. The pod arm found an engine throw on its **first** run:
 * 3 of 100 pods died on Bonfire of the Damned, whose miracle cost is `{X}{R}`, because the engine
 * offered an X on an offered cast and then refused the action carrying it (D460). So the pod arm
 * earned its place on the day it was written, and the figure to quote is 100/100 after that fix.
 *
 * It is still **not** a gate step, for a reason that is about the corpus
 * rather than the result: `--file` needs the 12 MB JSON that `scripts/corpus/from-forge.mjs`
 * builds, which is somebody else's transcription of copyrighted card text and is deliberately not
 * committed (see that script's docblock). So this is run by hand, with the corpus rebuilt first.
 * What *is* in the gate is `customDeck.test.ts`, which pins the same two claims on fixtures: a
 * compiled creature arrives at its printed size and survives arrival, and a creature nothing can
 * size stays cardboard (D431).
 */
import { readFileSync } from 'node:fs';
import {
  applyAction, botAction, compileCard, createGame, customDeck, scriptForCard, seatsToAct,
  unreadLines,
} from '../lib/engine.mjs';
import { provenanceLine } from '../lib/provenance.mjs';
import { isLegal, legalLine } from '../lib/legal.mjs';

const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];
if (file === null) {
  console.error('usage: node scripts/measure/corpus-decks.mjs --file <corpus.json>');
  process.exit(2);
}
const GAMES = Number(process.env.GAMES ?? 20);
const SEED0 = Number(process.env.SEED0 ?? 1);
/*
  `POD=1` is the beta scenario rather than a variant of this harness's default.

  Nick's own words are "me and some friends … play a bunch of games", and what they will play is
  **four-player Commander with four of their own decks**. The default arm here is a two-seat duel of
  60-card decks, which is the right first question and not that one — and a pod is where every stall
  this project has found actually lived (#297, #302, #330): four seats, forty life, a command zone,
  and games long enough for a loop to form.

  So the pod arm changes the four things that make it a pod, and nothing else: four seats, the
  engine's `pod` format, singleton 100-card decks, and a legendary creature in the command zone.
  Defaults move with it so `POD=1` alone is a sensible run; every one is still overridable.
*/
const POD = process.env.POD === '1';
const SEATS = Number(process.env.SEATS ?? (POD ? 4 : 2));
const SIZE = Number(process.env.SIZE ?? (POD ? 100 : 60));
const LANDS = Number(process.env.LANDS ?? (POD ? 37 : 24));
const MAXCMC = Number(process.env.MAXCMC ?? 6);
// A pod is four seats of forty life: more turns, more moves a turn, and a bound that has to clear
// both. Measured rather than guessed — see the pod figures in D460.
const MOVES = Number(process.env.MOVES ?? (POD ? 20000 : 6000));
const VERBOSE = process.env.VERBOSE === '1';
/*
  **The work queue, ranked by what a player actually meets** (D518).

  `one-line-short.mjs` ranks the unread shapes by how many cards each would finish, which is the
  right question for coverage and the wrong one for a beta. 15,887 legal cards are one line short
  and those lines come in 13,245 distinct shapes, 8,159 printed by a single card — so a queue
  ordered by cards-finished says the next hundred increments are worth a few hundred cards each and
  never says which of them a person sitting at a table would ever notice.

  This asks the other question. A card only costs a player anything if they **see** it, and costs
  them more if they try to **play** it. So with UNREAD=1 each game records the distinct cards that
  left the library at all (hand, battlefield, graveyard, exile, stack, command — everything but the
  library is a card somebody looked at) and the distinct cards a seat actually cast or activated,
  and crosses both with `unreadLines`. The shapes are then ranked by **encounters in play** rather
  than by printings in the corpus.

  Two numbers come out of it that nothing else here reports: how often a hand holds a card the
  engine cannot fully run, and how often one of those is played anyway. The first is the beta
  question; the second is the queue.
*/
const UNREAD = process.env.UNREAD === '1';
const TOP_UNREAD = Number(process.env.TOP_UNREAD ?? 20);
/*
  TRACE=<n> prints where the game has got to every n moves, and is the only arm that can answer
  the question an `unfinished` verdict raises: a game that neither throws nor stalls has been
  *doing* something for twenty thousand moves, and the verdict says only that it was not a win.
  A move cap too low and a game that cannot end look identical in the tally and differ in exactly
  one reading — whether the turn number, the life totals and the libraries move while the moves
  are spent.
*/
const TRACE = Number(process.env.TRACE ?? 0);
/*
  And the bound that tells a game which needs more moves from a game that cannot end.

  `MOVES` alone cannot: a pod that hits it reports `unfinished`, which is the same word for "this
  table was always going to be a long game" and "this table has been doing the same free thing
  2,000 times". D462's loop wore the second disguise, and it took a trace read by eye to tell —
  20,000 legal moves, each one bumping the state version so the stall check could not see it.

  So the harness asks the question itself. Every move it fingerprints what a player would call
  progress — the turn, the step, each seat's life and poison, and the size of each of their five
  zones — and a run of `LOOP` moves that moves none of it is reported as `looping`, with the action
  and the card that filled the window. Not `unfinished`: a different word, because it is a
  different bug, and that difference is the whole of what D462 cost to find.

  Counters, tapped state and the stack are deliberately **out** of the fingerprint, because a loop
  that only moves those is still a loop. That makes the bound the load-bearing choice: 2,000 moves
  is a tenth of the pod cap and about three whole pods' worth of moves, far past any honest run of
  mana taps and activations inside one step. `LOOP=0` turns it off.
*/
const LOOP = Number(process.env.LOOP ?? 2000);
const SEAT_IDS = Array.from({ length: SEATS }, (_, i) => `corpus:${i}`);

const allRows = (() => {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.data ?? []);
})();
/*
  `LEGAL=1` builds the decks out of the cards the goal names — which is the question Nick actually
  asked ("no matter what deck we upload"), since nobody uploads a deck of Archenemy schemes. Off by
  default so the figures recorded before the filter existed stay reproducible.
*/
const rows = allRows.filter(isLegal);

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
/*
  Commanders: legendary creatures, which is CR 903.3's requirement and the only deckbuilding rule
  this harness enforces. Drawn from the same pool as the spells so a commander is as likely to be a
  card the compiler reads nothing of as anything else in the deck — a harness that picked only
  fully-read commanders would be measuring the pool it chose rather than the engine.
*/
const commanders = spells.filter((row) => /\bLegendary\b/.test(row.type_line ?? '')
  && /\bCreature\b/.test(row.type_line ?? ''));

console.log(`Source: ${file}`);
console.log(`  ${provenanceLine({ FILE: file, GAMES: String(GAMES), SEED0: String(SEED0) })}`);
console.log(`${legalLine(allRows.length, rows.length)}`);
console.log(`Castable non-land pool: ${spells.length} of ${rows.length} rows`);
if (POD) console.log(`Legendary creatures to be commanders: ${commanders.length}`);
console.log(`Basics found: ${basics.map((row) => row.name).join(', ')}\n`);
if (basics.length < 5) {
  console.error('!! the corpus is missing a basic land, so decks cannot be given mana');
  process.exit(2);
}
if (POD && commanders.length === 0) {
  console.error('!! no legendary creature in the corpus, so no pod deck can have a commander');
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
  /*
    The commander first, and its name reserved, because a Commander deck is singleton (CR 903.5b)
    and a 99 that happened to contain a second copy of the commander would be a deck no tournament
    and no friend would let you play.
  */
  const commander = POD ? commanders[Math.floor(next() * commanders.length)] : undefined;
  if (commander !== undefined) seen.add(commander.name);
  while (chosen.length < SIZE - LANDS - (commander === undefined ? 0 : 1)) {
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

  const built = customDeck({
    id,
    name: id,
    entries,
    ...(commander === undefined ? {} : { commander: commander.name }),
    data: [...chosen, ...basics, ...(commander === undefined ? [] : [commander])],
  });
  // What the engine made of the list, which is the second half of what this harness reports.
  let scripted = 0;
  let partial = 0;
  for (const entry of built.deck.cards) {
    const def = entry.card;
    if ((def.typeLine ?? '') === '') continue;
    if (scriptForCard(def) !== undefined) scripted += 1;
    if (unreadLines(def).length > 0) partial += 1;
  }
  /*
    The commander is counted too. It is the one card a Commander game is guaranteed to see every
    time, so a commander the engine cannot read is worth far more than one of the 99 — and leaving
    it out of these counts would make the pod arm's numbers quietly better than the deck.
  */
  const commanderDef = built.deck.commander;
  if (commanderDef !== undefined && (commanderDef.typeLine ?? '') !== '') {
    if (scriptForCard(commanderDef) !== undefined) scripted += 1;
    if (unreadLines(commanderDef).length > 0) partial += 1;
  }
  return {
    ...built,
    colours,
    distinct: built.deck.cards.length,
    scripted,
    partial,
    commanderName: commander?.name,
    commanderIsCardboard: commanderDef !== undefined && (commanderDef.typeLine ?? '') === '',
  };
}

/** The name of the card an instance id names, for a trace a person has to read. */
const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name ?? 'something';

/** What a player would call progress, as one string: turn, step, life, poison, zone sizes. */
const progressOf = (st) => `${st.turn}|${st.step}|`
  + st.seats.map((seat) => `${seat.life}/${seat.poison ?? 0}`
    + ['hand', 'battlefield', 'library', 'graveyard', 'exile']
      .map((zone) => (st.zones[`${seat.index}:${zone}`] ?? []).length).join('.')).join(',');

/**
 * One line of "is this game going anywhere": the turn and step, then each seat's life, hand,
 * battlefield and library, then the actions spent since the run began, commonest first.
 *
 * Libraries are in it because decking is a pod's usual terminator — four seats drawing a card a
 * turn end a game the damage never would — and a library that stops emptying says the draw step
 * is no longer happening. The action histogram is cumulative rather than per-period on purpose: a
 * loop shows up as one action type climbing while nothing else does, which a per-period count
 * states less plainly.
 */
const traceLine = (s, moves, counts, whats) => {
  const seats = s.seats.map((seat) => {
    const bf = (s.zones[`${seat.index}:battlefield`] ?? []).length;
    const hand = (s.zones[`${seat.index}:hand`] ?? []).length;
    const lib = (s.zones[`${seat.index}:library`] ?? []).length;
    const gone = seat.eliminated ? `OUT:${seat.eliminatedReason ?? '?'}` : '';
    return `p${seat.index} ${seat.life}life h${hand} b${bf} lib${lib}${gone === '' ? '' : ` ${gone}`}`;
  }).join(' | ');
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([type, n]) => `${type}×${n}`).join(' ');
  const cards = [...whats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([what, n]) => `${what}×${n}`).join(', ');
  return `    move ${moves} turn ${s.turn} ${s.step} :: ${seats} :: ${top}`
    + `${cards === '' ? '' : `\n      cards: ${cards}`}`;
};

/** One game to a finish, or to the first thing that stops it. */
/**
 * The shape of an unread line, with the card's own name, its mana symbols and its numbers taken
 * out — the same grouping `compilable.mjs` and `one-line-short.mjs` use, so a row here can be
 * matched against a row there by eye.
 */
function shapeOf(line, name) {
  const words = line
    .replaceAll(name, '~')
    .replace(/\{[^}]*\}/g, '{M}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/[,.:;"'()]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  return words.slice(0, 7).join(' ');
}

/**
 * Every card a seat could have looked at, by name: everything that is not still in a library.
 *
 * Read once at the end of a game rather than sampled per move, because the question is "did this
 * player ever hold it", and a card that reached the battlefield was held first. A card still in the
 * library cost nobody anything, however unreadable it is — which is the whole point of ranking by
 * encounter.
 */
function namesSeen(st) {
  const seen = new Set();
  for (const inst of Object.values(st.instances ?? {})) {
    if (inst === undefined || inst.zone === 'library') continue;
    const name = st.cardDefs[inst.defKey]?.name;
    if (name !== undefined) seen.add(name);
  }
  return seen;
}

function play(seed) {
  const built = SEAT_IDS.map((id, seat) => buildDeck(id, seed * SEATS + seat));
  const decks = Object.fromEntries(SEAT_IDS.map((id, seat) => [id, built[seat].deck]));
  const host = { isHost: true, decks };

  let s = createGame({
    id: `corpus${seed}`,
    format: POD ? 'pod' : 'modern',
    players: SEAT_IDS.map((_, seat) => ({ playerId: `p${seat}`, name: `P${seat}` })),
    seed,
  });
  for (let seat = 0; seat < SEATS; seat++) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: SEAT_IDS[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);

  let moves = 0;
  const counts = new Map();
  /*
    Which card, not only which kind of action. A loop of `auto:activate` names nothing on its own;
    the same ability of the same permanent taken ten thousand times names the bug.
  */
  const whats = new Map();
  /*
    Card name → how many casts and activations of it this game, and the distinct set of names.

    **Both, because the raw count is not the ranking** (D518). The first 40-pod run put Icatian
    Infantry's `{1}: ~ gains banding until end of turn` at the top of the queue with 360 plays, and
    Orzhov Guildmage next with 103 — one card each. That is not what a table meets; it is the bot
    activating one free repeatable ability over and over, which a person would not do. Ranking by
    raw plays therefore measures how *repeatable* a shape is, not how often it is encountered.

    So the queue is ranked by **games in which a card carrying the shape was played at least once**,
    which is one vote per card per game and cannot be run up by a loop. The raw count is still
    reported as a total, because "how much of the engine's work is on partly-read cards" is a fair
    question for it to answer.
  */
  const played = new Map();
  const playedNames = new Set();
  /*
    Every exit from this function goes through here, so the two UNREAD=1 collections are attached to
    a lost game exactly as they are to a finished one. A game that stalled still showed its players
    cards, and leaving those out would quietly measure only the games that went well.
  */
  const done = (result) => (UNREAD
    ? { ...result, seen: namesSeen(s), played, playedNames }
    : result);
  let sinceProgress = 0;
  const inWindow = new Map();
  let lastWhat = '';
  for (; moves < MOVES && !s.finished; moves++) {
    if (TRACE > 0 && moves % TRACE === 0) console.log(traceLine(s, moves, counts, whats));
    const seat = seatsToAct(s)[0];
    if (seat === undefined) {
      return done({ verdict: 'nobody-to-act', seed, moves, turn: s.turn, decks: built });
    }
    const action = botAction(s, seat, {});
    if (action !== null) {
      counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
      if (action.card !== undefined) {
        const aimed = action.targets?.[0];
        const at = aimed?.kind === 'card' ? ` → ${nameOf(s, aimed.id)}`
          : aimed?.kind === 'player' ? ` → p${aimed.seat}` : '';
        const playedName = nameOf(s, action.card);
        if (UNREAD && (action.type === 'auto:cast' || action.type === 'auto:activate')) {
          played.set(playedName, (played.get(playedName) ?? 0) + 1);
          playedNames.add(playedName);
        }
        lastWhat = `${playedName}`
          + `${action.abilityIndex === undefined ? '' : `#${action.abilityIndex}`}${at}`;
        if (TRACE > 0) whats.set(lastWhat, (whats.get(lastWhat) ?? 0) + 1);
      }
    }
    if (action === null) {
      return done({ verdict: 'no-move', seed, moves, turn: s.turn, decks: built });
    }
    const before = s.stateVersion;
    const movedBefore = LOOP > 0 ? progressOf(s) : '';
    /*
      Deliberately **not** wrapped. A throw here is the thing this harness exists to find, and
      catching it would turn a crash into a short game — which is exactly how 35 harnesses hid the
      engine throwing for weeks (D244). The caller catches, once, and attributes it.
    */
    s = applyAction(s, action);
    if (s.stateVersion === before) {
      return done({
        verdict: 'stalled', seed, moves, turn: s.turn, decks: built,
        detail: `${action.type} by seat ${seat} changed nothing`,
      });
    }
    if (LOOP > 0) {
      if (progressOf(s) === movedBefore) {
        sinceProgress += 1;
        inWindow.set(action.type, (inWindow.get(action.type) ?? 0) + 1);
        if (sinceProgress >= LOOP) {
          const top = [...inWindow.entries()].sort((a, b) => b[1] - a[1])[0];
          return done({
            verdict: 'looping', seed, moves, turn: s.turn, decks: built,
            detail: `${LOOP} moves with no progress in ${s.step} of turn ${s.turn}`
              + `${top === undefined ? '' : `, ${top[1]} of them ${top[0]}`}`
              + `${lastWhat === '' ? '' : ` (${lastWhat})`}`,
          });
        }
      } else {
        sinceProgress = 0;
        inWindow.clear();
      }
    }
  }
  if (!s.finished) {
    if (TRACE > 0) console.log(traceLine(s, moves, counts, whats));
    return done({ verdict: 'unfinished', seed, moves, turn: s.turn, decks: built });
  }
  return done({ verdict: 'finished', seed, moves, turn: s.turn, winner: s.winnerSeat, decks: built });
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
/* UNREAD=1: card name → games in which somebody saw it / played it, and whether it reads whole. */
const sawCard = new Map();
const playedCard = new Map();
/** Card name → games in which it was played at least once. One vote per card per game. */
const playedGames = new Map();
let gamesCounted = 0;

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
  for (const deck of result.decks ?? []) {
    if (deck === undefined) continue;
    decksBuilt += 1;
    scripted += deck.scripted;
    partial += deck.partial;
    cardboard += deck.unknown.length;
    fromData += deck.fromData.length;
  }
  if (UNREAD && result.seen !== undefined && result.seen !== null) {
    gamesCounted += 1;
    for (const name of result.seen) sawCard.set(name, (sawCard.get(name) ?? 0) + 1);
    for (const [name, times] of result.played ?? []) {
      playedCard.set(name, (playedCard.get(name) ?? 0) + times);
    }
    for (const name of result.playedNames ?? []) {
      playedGames.set(name, (playedGames.get(name) ?? 0) + 1);
    }
  }
  if (VERBOSE) {
    const shape = result.decks === undefined
      ? ''
      : ` [${result.decks.map((d) => d.colours.join('')).join(' v ')}]`;
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
if (UNREAD && gamesCounted > 0) {
  /*
    The cards a person met, and what of them the engine could not read. `defOf` goes through the
    same `compileCard` path the engine itself uses, so a row here is the reading that shipped rather
    than a second opinion about it.
  */
  const defOf = new Map();
  for (const row of rows) {
    if (defOf.has(row.name)) continue;
    const read = compileCard(row);
    if (read.ok) defOf.set(row.name, read);
  }
  let seenTotal = 0;
  let seenPartial = 0;
  let playedTotal = 0;
  let playedPartial = 0;
  /** Shape → games in which a card carrying it was played, the raw plays, and which cards. */
  const shapes = new Map();
  for (const [name, games] of sawCard) {
    const read = defOf.get(name);
    if (read === undefined) continue;
    seenTotal += games;
    if (read.unread.length > 0) seenPartial += games;
  }
  for (const [name, times] of playedCard) {
    const read = defOf.get(name);
    if (read === undefined) continue;
    playedTotal += times;
    if (read.unread.length === 0) continue;
    playedPartial += times;
    const games = playedGames.get(name) ?? 0;
    for (const { line } of read.unread) {
      const key = shapeOf(line, name);
      const row = shapes.get(key) ?? { games: 0, plays: 0, cards: new Set() };
      row.games += games;
      row.plays += times;
      row.cards.add(name);
      shapes.set(key, row);
    }
  }
  const pct = (part, whole) => (whole === 0 ? '0.0' : ((part / whole) * 100).toFixed(1));
  console.log(`\nWhat a player actually met, over ${gamesCounted} game(s):`);
  console.log(`  card sightings (a card that left a library):      ${seenTotal}`);
  console.log(`  of those, cards with an unread line:              ${seenPartial}`
    + ` (${pct(seenPartial, seenTotal)}%)`);
  console.log(`  casts and activations:                            ${playedTotal}`);
  console.log(`  of those, of a card with an unread line:          ${playedPartial}`
    + ` (${pct(playedPartial, playedTotal)}%)`);
  console.log(`\nThe queue, ranked by games in which a card carrying the shape was played:`);
  console.log('  (one vote per card per game, so a repeatable ability cannot run the count up)');
  const ranked = [...shapes.entries()]
    .sort((a, b) => (b[1].games - a[1].games) || (b[1].cards.size - a[1].cards.size))
    .slice(0, TOP_UNREAD);
  for (const [shape, row] of ranked) {
    console.log(`  ${String(row.games).padStart(4)} games  ${shape}`);
    console.log(`              ${row.cards.size} card(s), ${row.plays} play(s) in all`
      + `, e.g. ${[...row.cards].slice(0, 3).join(' / ')}`);
  }
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
