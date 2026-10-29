/**
 * Is a dredge ever offered, and is taking it right?
 *
 * Dredge is the only keyword in this pool whose price is paid in **cards you will never see**
 * (CR 702.52a), which makes it the only one where the bot's rule could be confidently wrong and
 * still look fine: a line that dredged its library away wins the simulation it was scored in and
 * loses the game. So the instrument counts the four things a rule needs and cannot guess.
 *
 * 1. **How often is a dredge offered at all?** It needs the card in a graveyard and the library
 *    long enough to pay — two conditions that a land-based dredger and a removal-based one reach by
 *    completely different routes (one has to be *destroyed* or milled, the other is cast).
 * 2. **Taken or declined**, and by which card.
 * 3. **What it cost**: cards milled, which is the half of the keyword a win rate cannot see.
 * 4. **Where the library ended up.** The failure mode is decking yourself, so the number that
 *    matters is the smallest library each seat reached and how many games ended with somebody out
 *    of cards.
 *
 * It reads `GameState.pendingDredge` rather than the log, which keeps one thing honest: the
 * question is in the *state*, so a dredge offered and answered inside the same action cannot hide
 * from it.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=rot-harvest  SEEDS=4 node scripts/measure/dredge.mjs   # the land
 *     SUBJECT=blight-vector SEEDS=4 node scripts/measure/dredge.mjs  # the removal spell
 */
import {
  applyAction, botAction, createGame, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'rot-harvest';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 4);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
/*
  `BotOptions` as JSON, so the same counts can be read with the dredge rule on, off or changed.

  The question this instrument is for — how often is it offered, how often taken, and does the deck
  run itself out of cards — is a question about a *rule*, and a count taken under one configuration
  only says what that configuration does. `deck-probe` takes the same env for the same reason.

    BOT='{"dredgesForValue":false}' SUBJECT=rot-harvest node scripts/measure/dredge.mjs
*/
const BOT = JSON.parse(process.env.BOT ?? '{}');

let games = 0;
/** Offers made, by the card that made them. */
const offered = new Map();
/** Offers taken, by card. */
const taken = new Map();
/** Offers declined, by card. */
const declined = new Map();
/** Cards milled to dredges, in total. */
let milled = 0;
/** The shortest library the subject seat ever stood on, per game. */
const lows = [];
/**
 * Games the **subject** ended having drawn from an empty library.
 *
 * The subject's own and not "somebody's", which the first version counted and which answers a
 * different question: against Hollow Tide the opponent decks you on purpose, so a count that
 * includes every seat reads a mill deck's win as a dredge deck's mistake.
 */
let decked = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name ?? '?';
const librarySize = (s, seat) => (s.zones[`${seat}:library`] ?? []).length;

function duel(seed, decks) {
  const host = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);

  const subjectSeat = decks[0] === SUBJECT ? 0 : 1;
  let low = librarySize(s, subjectSeat);

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, BOT);
    if (action === null) break;
    /*
      The question, read off the state before the answer is applied.

      `pendingDredge` names the card and the price, and the action that answers it says which half
      was pressed — so one pass through the loop records the offer and its outcome together, with no
      second visit needed to find out what happened.
    */
    const ask = s.pendingDredge;
    if (ask !== null && action.type === 'auto:dredge') {
      const name = nameOf(s, ask.card);
      bump(offered, name);
      if (action.dredge) {
        bump(taken, name);
        milled += ask.mill;
      } else {
        bump(declined, name);
      }
    }
    s = applyAction(s, action, host);
    low = Math.min(low, librarySize(s, subjectSeat));
  }
  lows.push(low);
  if (s.drewFromEmpty.includes(subjectSeat)) decked += 1;
  games += 1;
}

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i * 97, { 0: SUBJECT, 1: other });
    duel(SEED0 + i * 97 + 1, { 0: other, 1: SUBJECT });
  }
}

const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);
const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

console.log(`${SUBJECT}: ${games} games against the field`);
console.log(`  offers ${total(offered)}  taken ${total(taken)}  declined ${total(declined)}`);
console.log(`  cards milled to dredges: ${milled}`);
for (const [name, n] of sorted(offered)) {
  console.log(`    ${name}: offered ${n}, taken ${taken.get(name) ?? 0}, declined ${declined.get(name) ?? 0}`);
}
lows.sort((a, b) => a - b);
const median = lows[Math.floor(lows.length / 2)] ?? 0;
console.log(`  ${SUBJECT}'s library at its shortest: median ${median}, worst ${lows[0] ?? 0}`);
console.log(`  games ${SUBJECT} drew from an empty library: ${decked}`);
