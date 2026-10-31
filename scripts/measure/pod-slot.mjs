/**
 * A deck list's slot, priced in a four-seat pod instead of a duel.
 *
 * `deck-probe` prices a slot against the field and every one of its games is a duel, which makes a
 * whole class of card unmeasurable: a card whose text reads "for each opponent" is **blank** at two
 * seats, so the probe returns the noise floor and says nothing. Myriad is the first card in this
 * pool like that (D229) and this is the instrument that stops it being argued instead of measured.
 *
 * **The subject sits at every table, at a seat that rotates.** Each table seats three decks chosen
 * from the seed plus the subject, and is played four times with the subject moved one seat along —
 * so the subject occupies every seat equally often and turn order cancels, which in a pod is worth
 * more than it is in a duel because the player to your left is the one you can attack cheaply.
 *
 * **Paired, like `deck-probe`.** The stock arm is whatever `STARTER_DECKS` says today; the variant
 * is built from it in memory out of `CHANGE`, so a slot can be priced before it is written. Both
 * arms play the same seeds, the same opponents and the same seats.
 *
 * **Its zero is arithmetic rather than evidence, exactly as in `pod-duel`.** With an empty `CHANGE`
 * the two arms are the same games twice and the difference is necessarily nought — that says
 * nothing about how noisy a pod is. Get the floor by running a real arm twice on disjoint seeds:
 *
 *   SUBJECT=forge-alliance CHANGE='Blade of Selves:-1' node scripts/measure/pod-slot.mjs
 *   SUBJECT=forge-alliance CHANGE='Blade of Selves:-1' SEED0=5100 node scripts/measure/pod-slot.mjs
 *
 * and disbelieve anything smaller than the gap between them. **Measured the first time it was used:
 * an unchanged arm read 15 of 52 and 6 of 52 across two seed sets, so the floor at `SEEDS=1` is
 * around nine pods and a one-card change cannot be resolved there at all.** A pod is noisier than a
 * duel by construction — three opponents, three chances to be attacked, and a win rate that starts
 * at 25% rather than 50% — so budget several times the games a duel question needs.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first.
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'forge-alliance';
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 3);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const MOVES = Number(process.env.MOVES ?? 8000);
const BOT = JSON.parse(process.env.BOT ?? '{}');
const PLAYERS = [
  { playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' },
  { playerId: 'p2', name: 'C' }, { playerId: 'p3', name: 'D' },
];

/*
  "Name:+1,Other:-1", or "Name:+1;Other:-1" when a name has a comma in it — `deck-probe`'s syntax,
  deliberately, because a slot priced in a duel and the same slot priced in a pod should be two
  invocations that differ in one word.
*/
const CHANGE = (process.env.CHANGE ?? '')
  .split((process.env.CHANGE ?? '').includes(';') ? ';' : ',')
  .filter(Boolean)
  .map((part) => {
    const at = part.lastIndexOf(':');
    return { name: part.slice(0, at).trim(), delta: Number(part.slice(at + 1)) };
  });

const defNamed = (name) => Object.values(STARTER_DECKS)
  .flatMap((d) => d.cards).find((e) => e.card.name === name)?.card;

function variant() {
  const stock = STARTER_DECKS[SUBJECT];
  if (stock === undefined) throw new Error(`no deck called ${SUBJECT}`);
  const cards = [];
  for (const entry of stock.cards) {
    const change = CHANGE.find((c) => c.name === entry.card.name);
    const count = entry.count + (change?.delta ?? 0);
    if (count > 0) cards.push({ card: entry.card, count });
  }
  for (const change of CHANGE) {
    if (change.delta <= 0) continue;
    if (stock.cards.some((e) => e.card.name === change.name)) continue;
    const card = defNamed(change.name);
    if (card === undefined) throw new Error(`no card named ${change.name} in the pool`);
    cards.push({ card, count: change.delta });
  }
  return { ...stock, cards };
}

const VARIANT = variant();
const size = (d) => d.cards.reduce((n, e) => n + e.count, 0);
console.log(`stock ${size(STARTER_DECKS[SUBJECT])} cards, variant ${size(VARIANT)} cards`);
if (size(VARIANT) !== size(STARTER_DECKS[SUBJECT])) {
  console.log('!! the two lists are not the same size, so this measures deck size too');
}

/** The winning seat, or null for a pod that did not finish. */
function pod(seed, decks, ctx) {
  let s = createGame({ id: `pod${seed}`, format: 'pod', players: PLAYERS, seed });
  const host = { isHost: true, ...ctx };
  for (const seat of [0, 1, 2, 3]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);
  for (let move = 0; move < MOVES && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, BOT);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  return s.finished ? s.winnerSeat : null;
}

/*
  Which three decks sit with the subject, from the seed rather than at random — `pod-duel`'s stride,
  for the reason it gives: four out of thirteen is a small window, and a stride coprime with the
  pool size walks the whole field instead of pairing the same four all night. The subject is seated
  afterwards, at `shift`, so it never faces itself.
*/
const others = (n) => [0, 1, 2].map((i) => ALL[(n * 3 + i * 4) % ALL.length])
  .filter((id) => id !== SUBJECT);

/** The subject's record across every table and every seat it can occupy. */
/*
  A seed per game, which is safe here where it would not be in `pod-duel`: the arms of this probe
  are the two `record()` calls, which re-run this identical loop, so a seed derived from the loop
  indices is the same seed in both. One seed for a whole pass meant the tables in it shared a
  shuffle (D240).
*/
const seedFor = (pass, t, shift) => SEED0 + ((pass * ALL.length + t) * 4) + shift;

function record(ctx) {
  let won = 0; let lost = 0; let unfinished = 0;
  const bySeat = [0, 0, 0, 0];
  for (let i = 0; i < SEEDS; i++) {
    for (let t = 0; t < ALL.length; t++) {
      const field = others(t);
      for (let shift = 0; shift < 4; shift++) {
        // The subject at `shift`, the rest of the table filled round it in order.
        const decks = [];
        let k = 0;
        for (let seat = 0; seat < 4; seat++) {
          if (seat === shift) decks.push(SUBJECT);
          else decks.push(field[k++ % field.length]);
        }
        const winner = pod(seedFor(i, t, shift), decks, ctx);
        if (winner === null) unfinished += 1;
        else if (winner === shift) { won += 1; bySeat[shift] += 1; } else lost += 1;
      }
    }
  }
  return { won, lost, unfinished, bySeat };
}

const started = Date.now();
const before = record({});
const elapsed = () => `[${Math.round((Date.now() - started) / 1000)}s]`;
console.log(`stock:   ${before.won}-${before.lost}`
  + `${before.unfinished ? ` (${before.unfinished} unfinished)` : ''} ${elapsed()}`);
const after = record({ decks: { [SUBJECT]: VARIANT } });
console.log(`variant: ${after.won}-${after.lost}`
  + `${after.unfinished ? ` (${after.unfinished} unfinished)` : ''} ${elapsed()}`);
const move = after.won - before.won;
console.log(`the change: ${move >= 0 ? '+' : ''}${move} of ${before.won + before.lost + before.unfinished} pods`);
/*
  And the per-seat split, which a duel has no equivalent of.

  Worth printing because it is the one way to tell a real effect from a rotation that did not
  cancel: a change that gains only in the seat to the left of the biggest deck is a change about
  turn order, not about the card.
*/
console.log(`  by seat, stock:   ${before.bySeat.join(' ')}`);
console.log(`  by seat, variant: ${after.bySeat.join(' ')}`);
