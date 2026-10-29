/*
  What the bot does with a blink: does it take it, what does it point at, and what did that cost?

  Soulherder's end step asks a question the bot has never been asked before. Every other optional
  target in the pool points at the enemy — a removal trigger, a counters trigger, a shield — and the
  worst a bad answer does is waste the card. This one points at **your own** board and the card is
  on the table either way, so a bad answer is not a wasted card, it is a creature destroyed: a token
  blinked ceases to exist (CR 111.7), and a creature with +1/+1 counters, an Equipment or an Aura on
  it comes back as a new object with none of them (CR 400.7).

  So the three questions, all in one pass over the same games:

  1. **Is the trigger taken?** The window count, which is what told a zone problem from a judgement
     problem for ninjutsu (D219) and the artifact cost (D221).
  2. **What does it blink?** By name, because an aggregate cannot be argued with and a list can.
  3. **What did the blink cost?** Four kinds of loss, counted where the choice is made: a token that
     will not come back, counters dropped, an attachment dropped, and a creature that was not doing
     anything on arrival — a blink whose only product is the Soulherder's own counter.

  And one reading of the upside, so the two can be weighed: the counters that ended up on the
  Soulherder, split by whether its own blink put them there or something else in the deck did — a
  Flickerwisp, a creature Rest in Peace exiled instead of burying. That split is computed rather
  than observed, because `GameState.exiled` is drained by `settle` *inside* the action that caused
  it: a harness standing between actions never sees the list, which is the right design for the
  engine and a thing to know before trying to read it from out here.

    node scripts/measure/blink-use.mjs
    SEEDS=4 node scripts/measure/blink-use.mjs
    BOT='{"lookahead":false}' node scripts/measure/blink-use.mjs

  Reads `packages/rules-engine/dist/index.js`, so build first:

    pnpm --filter @grimore/rules-engine build
*/
import {
  applyAction, botAction, characteristicsOf, createGame, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'skyward-writ';
const CARD = process.env.CARD ?? 'Soulherder';
const SEED0 = Number(process.env.SEED0 ?? 3300);
const SEEDS = Number(process.env.SEEDS ?? 2);
const BOT = JSON.parse(process.env.BOT ?? '{}');
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const FIELD = Object.keys(STARTER_DECKS).filter((d) => d !== SUBJECT);
const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name;

const c = {
  games: 0,
  cast: 0,
  /** Games the card reached the battlefield in, so the per-game numbers have a denominator. */
  gamesOnBoard: 0,
  asked: 0,
  declined: 0,
  blinked: {},
  lost: { token: 0, counters: 0, attachment: 0, nothingOnArrival: 0 },
  counters: { total: 0, best: 0, notItsOwnBlink: 0 },
};

const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

/** Whether a creature has an enter-the-battlefield trigger worth re-running. */
const arrivesWithSomething = (s, id) => {
  const script = s.cardDefs[s.instances[id]?.defKey ?? ''] === undefined ? undefined : true;
  if (script === undefined) return false;
  const name = nameOf(s, id);
  const def = STARTER_DECKS[SUBJECT]?.cards.find((entry) => entry.card.name === name)?.card;
  // Read off the oracle text rather than the script, because what matters is whether a *player*
  // would say the blink did something — and the printed card is what they are reading.
  return /enters the battlefield/i.test(def?.oracleText ?? '');
};

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    for (const [a, b] of [[SUBJECT, other], [other, SUBJECT]]) {
      const host = { isHost: true };
      let s = createGame({
        id: `g${c.games}`, format: 'modern', players: PLAYERS, seed: SEED0 + c.games,
      });
      s = applyAction(s, { type: 'deck:load', by: 0, seat: 0, deckId: a }, host);
      s = applyAction(s, { type: 'deck:load', by: 1, seat: 1, deckId: b }, host);
      s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
      s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);
      const me = a === SUBJECT ? 0 : 1;
      let onBoard = false;
      let best = 0;
      let blinks = 0;

      for (let m = 0; m < 3000 && !s.finished; m++) {
        const seat = seatsToAct(s)[0];
        if (seat === undefined) break;

        // The trigger's own prompt, which is the only place this choice is made.
        if (s.pendingChoice !== null && s.pendingChoice.seat === me
          && nameOf(s, s.stackObjects[s.pendingChoice.stackId]?.source ?? '') === CARD) {
          c.asked += 1;
          const action = botAction(s, seat, BOT);
          const picked = action?.targets?.[0]?.id;
          if (picked === undefined) {
            c.declined += 1;
          } else {
            blinks += 1;
            const inst = s.instances[picked];
            bump(c.blinked, nameOf(s, picked) ?? '?');
            if (inst?.isToken === true) c.lost.token += 1;
            if (Object.keys(inst?.counters ?? {}).length > 0) c.lost.counters += 1;
            const carried = Object.values(s.instances).some(
              (other) => other.attachedTo === picked,
            );
            if (carried) c.lost.attachment += 1;
            if (!arrivesWithSomething(s, picked)) c.lost.nothingOnArrival += 1;
          }
        }

        const action = botAction(s, seat, BOT);
        if (action === null) break;
        if (seat === me && action.type === 'auto:cast' && nameOf(s, action.card) === CARD) {
          c.cast += 1;
          onBoard = true;
        }
        s = applyAction(s, action, host);

        for (const inst of Object.values(s.instances)) {
          if (inst.zone !== 'battlefield' || inst.zoneSeat !== me) continue;
          if (nameOf(s, inst.id) !== CARD) continue;
          best = Math.max(best, inst.counters['+1/+1'] ?? 0);
        }
      }
      if (onBoard) {
        c.gamesOnBoard += 1;
        c.counters.total += best;
        c.counters.best = Math.max(c.counters.best, best);
        /*
          Counters it got from an exile that was not its own end step.

          A lower bound rather than a count: `best` is the most it ever had at once, so a Soulherder
          that died and was replaced, or one whose counters this misses because the game ended first,
          reads as zero here rather than as a negative. What it is for is answering "does the rest of
          the deck ever feed it" without claiming a precision it does not have.
        */
        c.counters.notItsOwnBlink += Math.max(0, best - blinks);
      }
      c.games += 1;
    }
  }
}

const per = (n) => (c.gamesOnBoard === 0 ? '—' : (n / c.gamesOnBoard).toFixed(1));
console.log(`${SUBJECT} v the field, ${c.games} games, bot ${JSON.stringify(BOT)}`);
console.log(`  ${CARD}s cast                      ${c.cast} (in ${c.gamesOnBoard} games)`);
console.log(`  end steps it was asked about        ${c.asked}  (${per(c.asked)} per game on board)`);
console.log(`    declined                         ${c.declined}`);
console.log(`  what it blinked                     ${JSON.stringify(c.blinked)}`);
console.log(`  blinks that cost something:`);
console.log(`    a token, which does not come back ${c.lost.token}`);
console.log(`    counters dropped                  ${c.lost.counters}`);
console.log(`    an attachment dropped             ${c.lost.attachment}`);
console.log(`    nothing to re-trigger on arrival  ${c.lost.nothingOnArrival}`);
console.log(`  counters on it, best per game       ${per(c.counters.total)} average, ${c.counters.best} highest`);
console.log(`    of those, not from its own blink  ${c.counters.notItsOwnBlink} (a lower bound)`);
