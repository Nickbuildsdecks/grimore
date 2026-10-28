/**
 * Why an infect deck that deals 903 poison counters still loses: does it attack?
 *
 * `poison.mjs` answered the first question about Blight Vector — the win condition is real, 50 of
 * its 53 wins come by poison — and `killed-by` answered the second: it loses a race by about a
 * turn, 71% of the time to plain combat damage. Then two single-slot changes measured level and
 * −7, which is D167's lesson repeating: a shape is not priceable one card at a time, and before
 * reshaping anything it is worth knowing whether the deck's problem is its cards at all.
 *
 * **Poison only counts when a creature connects.** An infect creature that stays home deals
 * nothing, and an infect creature that is blocked deals its damage to the *blocker* as −1/−1
 * counters, which is not poison and does not win the game. The bot's combat rule is "do not throw
 * creatures away" (D40, D47) — correct for a deck that wins by damage and possibly catastrophic
 * for a deck whose 1/1s have to get through — so the number nobody has is:
 *
 *   **of the infect creatures it could attack with, how many does it actually send?**
 *
 * So this watches the declare-attackers step on the subject's own turns and counts three things:
 * the creatures it could have attacked with (the engine's own `legalAttackers`, filtered to the
 * ones with infect), the ones it declared, and the turns it declared nothing at all while holding
 * at least one. A deck that sends 90% of them has a card problem; a deck that sends 40% has a bot
 * problem, and no slot change will fix it.
 */
import {
  applyAction, createGame, botAction, seatsToAct, legalAttackers, characteristicsOf, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'blight-vector';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

let games = 0;
/** Declare-attackers steps where it held at least one infect creature it could have sent. */
let windows = 0;
let couldSend = 0;
let sent = 0;
/** Windows where it sent nothing at all. */
let heldEverything = 0;
/** Windows where it sent every one of them. */
let sentEverything = 0;
/** The biggest board of infect creatures it ever had, and the biggest attack it ever declared. */
let widestBoard = 0;
let widestAttack = 0;

const infectOnly = (state, seat, ids) => ids.filter((id) => {
  const inst = state.instances[id];
  if (inst === undefined || inst.zoneSeat !== seat) return false;
  return characteristicsOf(state, inst).keywords.has('infect');
});

function duel(seed, decks, mine) {
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
    const action = botAction(s, seat);
    if (action === null) break;
    /*
      The one moment worth counting, and it has to be caught *before* the action is applied: an
      attack declaration is the only move that says what the bot decided to do with its board, and
      once it is applied the creatures that stayed home are indistinguishable from the ones that
      were never able to go.
    */
    if (seat === mine && action.type === 'auto:attack') {
      const able = infectOnly(s, mine, legalAttackers(s, mine));
      if (able.length > 0) {
        windows += 1;
        couldSend += able.length;
        const declared = infectOnly(s, mine, action.attackers.map((a) => a.attacker));
        sent += declared.length;
        if (declared.length === 0) heldEverything += 1;
        if (declared.length === able.length) sentEverything += 1;
        widestBoard = Math.max(widestBoard, able.length);
        widestAttack = Math.max(widestAttack, declared.length);
      }
    }
    const before = s.stateVersion;
    try { s = applyAction(s, action, ctx); } catch { break; }
    if (s.stateVersion === before) break;
  }
}

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other], 0); games += 1;
    duel(SEED0 + i, [other, SUBJECT], 1); games += 1;
  }
}

const pc = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log('');
if (windows === 0) {
  console.log('it never reached a declare-attackers step holding an infect creature it could send');
} else {
  console.log(`${windows} attack declarations with at least one infect creature able to go`);
  console.log(`  it could have sent ${couldSend} and sent ${sent} — ${pc(sent, couldSend)}`);
  console.log(`  sent nothing at all: ${heldEverything} (${pc(heldEverything, windows)})`);
  console.log(`  sent every one of them: ${sentEverything} (${pc(sentEverything, windows)})`);
  console.log(`  widest board of infect creatures: ${widestBoard}; widest attack: ${widestAttack}`);
}
