/**
 * How often does a seat swing, tap out, and die to the attack that comes back?
 *
 * The one reading the win rate cannot give. D264 added the evaluation's first term about the
 * *pairing* of two boards — power opposite me that nothing of mine can block — and the field win
 * rate came back level across three seed sets, which at 312 games is what D258 says to expect from
 * any single term. Level is not the same as inert, and `term-leverage` already showed it is not
 * inert: 1.5% of all decisions, 7.9% of attack declarations, 11.3% of blocks.
 *
 * But "it changes attack declarations" is not a claim about whether the changes are *right*. The
 * term's actual claim is narrower and testable: **a seat that attacks with its blockers should die
 * to the return attack less often.** That is one number, it is exact, and nothing here measured it.
 *
 * A **fatal crack-back** is recorded when, in the same game:
 *
 *  1. the seat declared a non-empty attack on turn N, and
 *  2. an opponent declared a non-empty attack **against that seat** on turn N+1, and
 *  3. the seat lost on turn N+1.
 *
 * All three clauses matter. Without (1) this counts every loss, including the seat that never
 * attacked at all; without (2) it counts a seat that swung and then died to a Lightning Bolt,
 * which has nothing to do with the blockers it tapped; and without (3) it counts a swing that was
 * answered and survived, which is the ordinary case rather than the failure.
 *
 * **All three are read off actions, which is the second design and the one that is right.** The
 * first version's clause (3) was "the last damage was combat damage", attributed by watching life
 * move and classifying the action it moved during — and that classification was wrong twice over:
 * it read `state.step` *before* applying the action, where the pass that advances into damage is
 * issued in `declare-blockers`, and it tested `includes('combat-damage')`, which does not match
 * `first-strike-damage`. Both errors undercount, silently. Asking instead whether somebody
 * declared an attack at this seat needs no attribution at all: it is a fact about an action the
 * instrument already sees, and `dealDamage`'s source — which the log does not keep, the constraint
 * `killed-by` works under — never comes into it.
 *
 * **The arms are the term on and off, playing the same games**, which is the shape `bot-duel` uses
 * and for the same reason: the deck pairing and the seat cancel, so what is left is the setting.
 * Both seats get the setting under test, because a crack-back has two sides — the seat that dies to
 * one and the seat that delivers it — and a run where only one seat has the term measures the
 * matchup rather than the term.
 *
 * **The control.** A run where nobody ever attacked, or nobody ever lost to combat, proves nothing
 * and must not read as an improvement, so the denominators are printed and an empty one exits
 * non-zero — the rule `granted-abilities` and `spent-permanents` follow.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     node scripts/measure/crack-back.mjs
 *     SEEDS=2 node scripts/measure/crack-back.mjs
 *     SUBJECT=ember-rush node scripts/measure/crack-back.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';
import { canonicalDecks } from './decks.mjs';

const ALL = Object.keys(STARTER_DECKS);
const SUBJECT = process.env.SUBJECT ?? '';
const SEEDS = Number(process.env.SEEDS ?? 1);
const SEED0 = Number(process.env.SEED0 ?? 4400);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const CTX = { isHost: true, ...canonicalDecks(STARTER_DECKS) };

/*
  The two arms, **both weights named**, which matters since D264 left the default at zero: writing
  `on: {}` would have compared the shipping bot against itself and read a clean zero for every
  column. Naming both is what keeps this an ablation of the term rather than of nothing — the same
  trap `playout.test.ts` guards with its default test.

  `EXPOSED` is the weight under test, so a later attempt at a different one needs no edit here:
  `EXPOSED=0.5 node scripts/measure/crack-back.mjs`.
*/
const EXPOSED = Number(process.env.EXPOSED ?? 1);
const ARMS = { on: { weights: { exposed: EXPOSED } }, off: { weights: { exposed: 0 } } };

function duel(seed, decks, opts) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, CTX);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, CTX);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, CTX);

  /** The turn each seat last declared a non-empty attack on, or -1. */
  const swungOn = [-1, -1];
  /** The turn each seat was last attacked on by somebody else, or -1. */
  const attackedOn = [-1, -1];
  const out = { swings: 0, losses: 0, attackedBack: 0, fatalCrackBacks: 0, won: 0 };

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, opts);
    if (action === null) break;
    if (action.type === 'auto:attack' && action.attackers.length > 0) {
      swungOn[seat] = s.turn;
      out.swings += 1;
      // And who it was aimed at, which is what makes clause (2) a fact rather than a guess. In a
      // duel this is always the other seat; it is read off the declaration anyway, because the
      // instrument should not know how many seats there are.
      for (const entry of action.attackers) attackedOn[entry.defender] = s.turn;
    }
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }

  if (!s.finished) return out;
  for (const row of s.seats) {
    if (s.winnerSeat === row.index) { out.won += 1; continue; }
    out.losses += 1;
    /*
      Swung on turn N, attacked back on turn N+1, dead on turn N+1. The turn the game ended on is
      `s.turn`, so "dead on N+1" is the same comparison as "the swing was one turn ago".

      A gap of 0 would be the same turn, which happens when the attack itself kills the attacker
      through a Ball Lightning trade or a Hellrider trigger, and is not a crack-back.
    */
    if (swungOn[row.index] < 0) continue;
    if (s.turn - swungOn[row.index] !== 1) continue;
    out.attackedBack += 1;
    if (attackedOn[row.index] === s.turn) out.fatalCrackBacks += 1;
  }
  return out;
}

// A seed per game derived from the loop indices (D240), identical across arms so the two play the
// same games — the whole point of an ablation.
const seedFor = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;

const totals = {};
for (const [name, opts] of Object.entries(ARMS)) {
  const sum = { swings: 0, losses: 0, attackedBack: 0, fatalCrackBacks: 0, won: 0, games: 0 };
  for (let i = 0; i < SEEDS; i++) {
    for (let a = 0; a < ALL.length; a++) {
      for (let b = a + 1; b < ALL.length; b++) {
        if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
        for (const [o, decks] of [[ALL[a], ALL[b]], [ALL[b], ALL[a]]].entries()) {
          const r = duel(seedFor(i, a, b, o), decks, opts);
          for (const key of ['swings', 'losses', 'attackedBack', 'fatalCrackBacks', 'won']) sum[key] += r[key];
          sum.games += 1;
        }
      }
    }
  }
  totals[name] = sum;
}

const { on, off } = totals;
console.log(`${on.games} games per arm, ${SEEDS} seed(s) from ${SEED0}${
  SUBJECT === '' ? '' : `, ${SUBJECT} only`}, exposed weight ${EXPOSED} against 0`);
console.log('');
if (off.swings === 0 || off.losses === 0) {
  console.log('!! nobody attacked, or nobody lost, so there is no crack-back to count and a zero');
  console.log('!! here means the run is broken rather than the bot is safe. Check aggression');
  console.log('!! before believing anything from this.');
  process.exit(1);
}
const row = (name, s) => {
  console.log(`${name.padEnd(5)} ${String(s.swings).padStart(5)} swings  ${
    String(s.losses).padStart(4)} losses  ${
    String(s.attackedBack).padStart(4)} died the turn after swinging  ${
    String(s.fatalCrackBacks).padStart(4)} of those to an attack  (${
    (100 * s.fatalCrackBacks / Math.max(1, s.losses)).toFixed(0)}% of losses)`);
};
row('on', on);
row('off', off);
console.log('');
const delta = on.fatalCrackBacks - off.fatalCrackBacks;
console.log(`${delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta} fatal crack-backs`} with the term on.`);
console.log(delta < 0
  ? 'Fewer: the term is doing the thing it was written to do.'
  : delta === 0
    ? 'Level: the term changes which attacks happen without changing how often one is punished.'
    : 'MORE, which is the term pointing the wrong way on its own claim. Read the weight again.');
