/**
 * Which of the evaluation's terms actually decide anything?
 *
 * D241 calibrated `evaluate` against outcomes and named cards-in-hand as the component pointing the
 * wrong way. D243 lowered it over 936 paired games and found it **inert** — level across a five-fold
 * cut, while genuinely changing 112 of 16,761 decisions. The reason is the finding, and it is why
 * this file exists:
 *
 * **A calibration measures positions. A search compares plays.**
 *
 * What decides a choice is not a term's correlation with outcomes, it is the term's **variation
 * across the options on offer at one decision**. Hand size barely varies across them — nearly every
 * candidate is a cast, every cast moves one card out of the hand — so the term contributes a
 * near-constant amount to the whole slate and cancels out of the comparison. It can be badly wrong
 * about which *player* is ahead while being almost silent about which *play* is best.
 *
 * So the useful question is not which terms predict the winner. It is which terms **separate the
 * plays**, and that is answered by taking each one away and counting what the bot does differently.
 *
 *   SEEDS=1 node scripts/measure/term-leverage.mjs
 *   SEEDS=2 node scripts/measure/term-leverage.mjs      # the field twice
 *   TERMS=hand,life node scripts/measure/term-leverage.mjs           # just these
 *   SUBJECT=hollow-tide TERMS=library node scripts/measure/term-leverage.mjs   # where it acts
 *
 * **`SUBJECT` exists because a field average drowns a term that matters to one deck**, which is a
 * lesson this directory already learned about `bot-duel` and the slot probe and which applies here
 * for the same reason. `library` reads 0.2% across the whole field — and it is in the evaluation
 * *for* the mill deck, whose whole plan it is the only term that can see. A number that low is a
 * statement about twelve decks that do not care, not about the one that does. With `SUBJECT` set,
 * only that deck's own decisions are counted.
 *
 * **Leverage is measured by ablation, which is exact.** The game is played by the shipping bot, and
 * at every decision each ablated bot is asked the same position. A term whose removal changes no
 * decision decides nothing, whatever its weight says and whatever a calibration says about it.
 * There is no sampling argument to make: it is the real search on the real positions.
 *
 * Read with D241's calibration beside it, because **the interesting cell is high leverage and poor
 * calibration** — a term that does separate the slate and separates it the wrong way. That is where
 * a weight would actually be costing games, and nothing has looked there before.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=1 node scripts/measure/term-leverage.mjs
 */
import {
  applyAction, botAction, createGame, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 1);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const SUBJECT = process.env.SUBJECT ?? '';
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
if (SUBJECT !== '' && STARTER_DECKS[SUBJECT] === undefined) {
  console.log(`no deck called ${SUBJECT}. Known: ${ALL.join(', ')}`);
  process.exit(1);
}

/*
  The terms, and what taking one away means.

  Zeroing rather than nudging, on purpose. A nudge measures a weight; zero measures the **term** —
  "does the bot play differently when it cannot see this at all" — and that is the question. A term
  whose removal changes nothing is not mispriced, it is absent, and no amount of tuning reaches it.

  `creature` is the one exception and takes a small value rather than zero: at zero the evaluation
  cannot see creatures at all, and a bot that scores a board of 5/5s the same as an empty one is not
  a useful comparison, it is a different program. A tenth of its value keeps creatures ordered
  against each other while making them nearly irrelevant against everything else.
*/
const TERMS = {
  life: { life: 0 },
  hand: { hand: 0 },
  library: { library: 0 },
  land: { land: 0 },
  permanent: { permanent: 0 },
  creature: { creature: 0.1 },
};

const want = (process.env.TERMS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const terms = Object.entries(TERMS).filter(([name]) => want.length === 0 || want.includes(name));
if (terms.length === 0) {
  console.log(`TERMS matched nothing. Known: ${Object.keys(TERMS).join(', ')}`);
  process.exit(1);
}

/** term -> action kind -> { n, differed }. The stock bot's own row is the denominator. */
const tally = new Map(terms.map(([name]) => [name, new Map()]));
const note = (term, kind, same) => {
  const rows = tally.get(term);
  const row = rows.get(kind) ?? { n: 0, differed: 0 };
  row.n += 1;
  if (!same) row.differed += 1;
  rows.set(kind, row);
};

/*
  And the control, which has to be in every run rather than in a note about a run.

  An empty override is the shipping bot by construction — every key falls back to its constant — so
  it must differ on **zero** decisions. If it ever differs, the override plumbing is reaching
  something it should not and every number above it is measuring that instead of a term. Same
  standard the measure README sets for `card-promises`: an instrument whose interesting result is a
  zero has to carry its own positive and negative controls, and run them every time.
*/
const CONTROL_TERM = '(control: no override)';
tally.set(CONTROL_TERM, new Map());
const arms = [[CONTROL_TERM, {}], ...terms.map(([name, w]) => [name, w])];

function duel(seed, decks) {
  /*
    Whose decisions count. With no `SUBJECT`, both seats' — the field reading. With one, only the
    seat playing it, because the question becomes "what does this term decide *for this deck*" and
    an opponent's decisions are the field average again, wearing a filter.
  */
  const counted = SUBJECT === ''
    ? [0, 1]
    : [0, 1].filter((seat) => decks[seat] === SUBJECT);
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    /*
      The stock bot decides, and every arm is asked the *same* position. That is what makes this an
      ablation rather than a comparison of two games: the moment one arm were allowed to play on,
      the positions would diverge and the counts would be about different games.
    */
    const stock = botAction(s, seat, {});
    if (stock === null) break;
    if (counted.includes(seat)) {
      const want = JSON.stringify(stock);
      for (const [name, weights] of arms) {
        const theirs = botAction(s, seat, { weights });
        note(name, stock.type, JSON.stringify(theirs) === want);
      }
    }
    const before = s.stateVersion;
    try { s = applyAction(s, stock); } catch { break; }
    if (s.stateVersion === before) break;
  }
}

/*
  A seed of its own for every game (D240): one seed is one RNG stream, and the same stream yields the
  same index permutation however different the deck list is, so a pass over the field on one seed is
  one shuffle wearing every pairing.
*/
const seedFor = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;

let games = 0;
const started = Date.now();
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      // With a SUBJECT, only its own pairings are worth playing at all.
      if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
      duel(seedFor(i, a, b, 0), [ALL[a], ALL[b]]); games += 1;
      duel(seedFor(i, a, b, 1), [ALL[b], ALL[a]]); games += 1;
    }
  }
}

const KINDS = ['auto:cast', 'auto:activate', 'auto:attack', 'auto:block', 'auto:playLand',
  'auto:pass', 'auto:decide', 'auto:choose', 'auto:discard', 'auto:order', 'auto:turnUp'];
const total = (rows) => [...rows.values()].reduce((t, r) => t + r.n, 0);
const differed = (rows) => [...rows.values()].reduce((t, r) => t + r.differed, 0);

const decisions = total(tally.get(CONTROL_TERM));
console.log(`${games} games, ${SEEDS} pass${SEEDS === 1 ? '' : 'es'} over `
  + `${SUBJECT === '' ? 'the field' : `${SUBJECT}'s pairings`}, ${decisions} `
  + `${SUBJECT === '' ? '' : `of ${SUBJECT}'s own `}decisions, `
  + `${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log('each arm is asked the same position the shipping bot played, so this is an ablation');
console.log('');

const pct = (n, of) => (of === 0 ? '   —' : `${((100 * n) / of).toFixed(1)}%`.padStart(6));
const head = ['term'.padEnd(26), 'changed'.padStart(9), 'of all'.padStart(7)];
console.log([...head, ...KINDS.map((k) => k.replace('auto:', '').padStart(9))].join(''));

/*
  Ordered by how much each term decides, which is the whole point of the table: the question is
  which terms separate the plays, so the answer should be readable top to bottom.
*/
const ordered = [...tally.entries()]
  .sort((x, y) => differed(y[1]) - differed(x[1]) || x[0].localeCompare(y[0]));

for (const [name, rows] of ordered) {
  const cells = KINDS.map((kind) => {
    const row = rows.get(kind);
    return row === undefined || row.n === 0 ? '   —'.padStart(9) : pct(row.differed, row.n).padStart(9);
  });
  console.log([
    name.padEnd(26),
    String(differed(rows)).padStart(9),
    pct(differed(rows), total(rows)),
    ...cells,
  ].join(''));
}

const bad = tally.get(CONTROL_TERM);
console.log('');
if (differed(bad) > 0) {
  console.log(`CONTROL FAILED: an empty override changed ${differed(bad)} decisions, which it cannot`);
  console.log('do if it is the shipping bot. Every row above is measuring the plumbing, not a term.');
  process.exit(1);
}
console.log('control held: an empty override changed 0 decisions, so the rows above are terms');
