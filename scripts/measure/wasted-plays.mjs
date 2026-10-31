/**
 * Which of the bot's plays buy nothing at all — asked of every card at once, instead of one at a
 * time.
 *
 * Sixteen members of the "spent on nothing" family exist and every one of them was found by hand: a
 * ritual into nothing (D63), a Fog with nothing attacking (D66), a pump that wears off before it
 * matters (D73), an animated land that never attacks, a Clone with nothing to copy, removal with
 * nothing to remove (D89), a goad in a duel, a foretell with nothing spare, an untap cycle (D124),
 * a Naturalize aimed at its own board (D180), a second adapt (D182). Each one cost a session of
 * suspicion, instrumentation and measurement, and each was worth between nothing and twenty-nine
 * games of 288. This is the generic version of the question they are all special cases of.
 *
 * **What it does.** For every `auto:cast` and `auto:activate` the bot takes, it fingerprints
 * everything a player would call value — life and poison, permanents per seat, total power,
 * toughness and granted keywords on the battlefield, hand, graveyard, exile and library sizes,
 * counters on permanents — before the action and after it has finished resolving. A play where
 * **nothing** in that fingerprint changed except the card leaving its owner's hand is a suspect,
 * and suspects are grouped by card name.
 *
 * "After it has finished resolving" is the part the first version got wrong, and it is worth
 * naming: a cast or a non-mana activation only puts an object on the **stack**, so comparing the
 * two states either side of the action said "nothing moved" for every spell in the game — 78% of a
 * Scavenging Ooze's activations and 94% of a Basilisk Collar's equips. So the stack is drained
 * first, by passing priority while there is anything on it and nothing is owed. Passing never buys
 * the acting seat anything, which is what makes that fair; it does let the opponent respond, which
 * is the same question asked of a board that includes their answer.
 *
 * **Two rules that keep it honest.**
 *
 * The turn must not have advanced during the action. With auto-pass on, applying one action can
 * resolve the stack, finish the combat and hand the turn over — and two positions a turn apart are
 * not comparable. That is the trap every member of this family fell into, and samples where it
 * happens are dropped rather than guessed at.
 *
 * And the fingerprint has blind spots, which is why the output is a list of **suspects** rather than
 * a list of bugs:
 *
 * - **Information.** A scry, a Preordain's look at the top of the library, a morph cast face down:
 *   the board is identical and the player knows something they did not.
 * - **Later.** A foretold card is cheaper next turn; a delayed trigger fires in the end step; a
 *   counter put on a Saga is a chapter closer. Nothing moves now.
 * - **Denial.** A counterspell that counters a spell leaves a board that looks like the board where
 *   the spell was never cast, which is the whole point of it.
 * - **Mana.** A ritual's mana is in the pool, which this does not read, and the play that spends it
 *   is the next action rather than this one.
 * - **Prevention** was one of these and is not any more. A shield changes no count of cards, bodies
 *   or life, so every prevention spell in the pool read as a play that bought nothing: Harm's Way
 *   scored 3 of 3 and Divine Deflection 3 of 4 on the runs that found it. The fingerprint sums the
 *   prevention on the table now, so a shield cast *is* a change and only a shield that bought
 *   nothing reads as one — which is what the row is supposed to mean. It is worth leaving the story
 *   here rather than only the fix: this blind spot was invisible for eleven increments because
 *   nothing in the pool had a shield as its *whole* effect until the redirection cards (D255), and
 *   the two that did have one, a Holy Day and a Samite Healer, were never near the top of the list.
 * - **Where a bonus is.** The fingerprint sums power and keywords across the battlefield, so an
 *   Equipment *moved* from one creature to a bigger one changes nothing in it — the sum is the same
 *   and only the carrier is different. That is why the equipment rows do not fall to zero after
 *   D184's rule: what is left is the moves that are upgrades, and this cannot tell them from the
 *   ones that are not. Reading those needs the board, which is what the bot rule does.
 *
 * So a card near the top of this list is worth looking at; it is not proof of anything. Read it
 * with `cast-counts` (how often the card is played at all) and settle it with `deck-probe`.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=4 node scripts/measure/wasted-plays.mjs
 *     SUBJECT=arc-tempest SEEDS=6 node scripts/measure/wasted-plays.mjs   # one deck's own plays
 */
import {
  applyAction, createGame, botAction, seatsToAct, characteristicsOf, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
/** One deck's plays, or every deck's. Empty means every deck's. */
const SUBJECT = process.env.SUBJECT ?? '';
const SEEDS = Number(process.env.SEEDS ?? 4);
const SEED0 = Number(process.env.SEED0 ?? 3300);
/** How many rows to print. */
const TOP = Number(process.env.TOP ?? 14);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

let games = 0;
let plays = 0;
let skippedTurnChanged = 0;
/** name → { wasted, total, decks: Set } */
const byCard = new Map();

const zone = (state, seat, name) => (state.zones[`${seat}:${name}`] ?? []).length;

/**
 * Everything a player would call value, as one comparable string.
 *
 * Deliberately coarse: the question is "did anything move", and a fingerprint that reads every
 * field would answer "yes" for the turn counter and the priority seat on every single play.
 */
function fingerprint(state, payer) {
  const parts = [];
  for (const seat of state.seats) {
    const battlefield = state.zones[`${seat.index}:battlefield`] ?? [];
    let power = 0;
    let toughness = 0;
    let counters = 0;
    let keywords = 0;
    /*
      Untapped permanents, because tapping something is value and leaves everything else alone — an
      Icy Manipulator read as a play that bought nothing until this line.

      **The payer's own lands are left out of it**, and that is the whole subtlety: paying for a
      spell taps lands, so counting them made every paid play look like it had changed the board and
      the instrument reported five suspects out of 3,771 instead of two hundred. A land tapped for
      mana is the cost, not the thing bought.
    */
    let untapped = 0;
    for (const id of battlefield) {
      const inst = state.instances[id];
      if (inst === undefined) continue;
      const ch = characteristicsOf(state, inst);
      if (ch.isCreature) {
        power += ch.power;
        toughness += ch.toughness;
      }
      // Counted because an equipment can grant deathtouch and lifelink and no body at all: without
      // this a Basilisk Collar's equip reads as a play that bought nothing.
      keywords += ch.keywords.size;
      if (!inst.tapped && !(seat.index === payer && ch.isLand)) untapped += 1;
      for (const n of Object.values(inst.counters)) counters += n;
    }
    parts.push([
      seat.life, seat.poison ?? 0, battlefield.length, power, toughness, counters, keywords, untapped,
      zone(state, seat.index, 'hand'), zone(state, seat.index, 'graveyard'),
      zone(state, seat.index, 'exile'), zone(state, seat.index, 'library'),
    ].join(','));
  }
  /*
    And the prevention sitting on the table, which is the one kind of value with nowhere to live.

    Everything above is a count of cards, bodies or life. A shield is none of those: a Holy Day, a
    Samite Healer's tap, a Harm's Way all leave every number above exactly as it was, so **every
    prevention spell in the pool read as a play that bought nothing** — Harm's Way scored 3 of 3 on
    the run that found this, which is as wrong as a row in this list can be.

    Summed as a quantity rather than counted as effects, because that is what is bought: a shield
    for two is worth twice a shield for one, and a blanket Fog has no quantity at all and so is
    counted as one. Only the shields and the blankets, not every continuous effect — an anthem is
    already visible in the power sum above and would be double-counted here.
  */
  let prevention = 0;
  for (const effect of state.effects ?? []) {
    prevention += effect.preventsDamageAmount ?? 0;
    if (effect.preventsCombatDamage === true) prevention += 1;
  }
  parts.push(`fx${prevention}`);
  return parts.join('|');
}

/**
 * The fingerprint with the acting seat's hand and graveyard adjusted by the cost of the play
 * itself, so "the card left my hand and is in my graveyard" does not count as something bought.
 */
function fingerprintPayingFor(state, seat) {
  const parts = fingerprint(state, seat).split('|');
  const mine = parts[seat]?.split(',') ?? [];
  // Index 8 and 9 are the hand and the graveyard: see `fingerprint`.
  mine[8] = String(Number(mine[8]) - 1);
  mine[9] = String(Number(mine[9]) + 1);
  parts[seat] = mine.join(',');
  return parts.join('|');
}

function note(name, deck, wasted) {
  const row = byCard.get(name) ?? { wasted: 0, total: 0, decks: new Set() };
  row.total += 1;
  if (wasted) row.wasted += 1;
  row.decks.add(deck);
  byCard.set(name, row);
}

function duel(seed, decks) {
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
    const interesting = (action.type === 'auto:cast' || action.type === 'auto:activate')
      && (SUBJECT === '' || decks[seat] === SUBJECT);
    const name = interesting && action.card !== undefined
      ? s.cardDefs[s.instances[action.card]?.defKey ?? '']?.name
      : undefined;
    const before = interesting ? fingerprint(s, seat) : '';
    const payingFor = interesting ? fingerprintPayingFor(s, seat) : '';
    const turnBefore = s.turn;

    const version = s.stateVersion;
    let next;
    try { next = applyAction(s, action, ctx); } catch { break; }
    if (next.stateVersion === version) break;

    /*
      Drain the stack before looking, and only while there is something on it.

      A pass with an empty stack advances the step, which walks into combat damage and would credit
      this play with whatever the attack did. A pass with something on it resolves that something,
      which is what the play was.
    */
    if (interesting) {
      for (let i = 0; i < 24 && next.stackOrder.length > 0 && !next.finished; i++) {
        if (next.pendingChoice !== null || next.pendingDecision !== null) break;
        if (next.priority === null) break;
        const at = next.stateVersion;
        let drained;
        try { drained = applyAction(next, { type: 'auto:pass', by: next.priority }, ctx); } catch { break; }
        if (drained.stateVersion === at) break;
        next = drained;
      }
    }

    if (interesting && name !== undefined) {
      if (next.turn !== turnBefore) {
        skippedTurnChanged += 1;
      } else {
        const after = fingerprint(next, seat);
        plays += 1;
        // Nothing moved, or the only thing that moved is this card paying for itself.
        note(name, decks[seat], after === before || after === payingFor);
      }
    }
    s = next;
  }
  games += 1;
}

const field = SUBJECT === '' ? ALL : [SUBJECT];
/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles each seat's
  deck in turn, and the same stream yields the same index permutation however different the deck
  list is — so a whole pass over the field on one seed was one shuffle wearing every pairing, and an
  absolute rate printed below had the error bars of its seed count rather than its game count.
  Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, ai, bi) =>
  SEED0 + (((pass * field.length + ai) * ALL.length) + bi);

for (let i = 0; i < SEEDS; i++) {
  for (const [ai, a] of field.entries()) {
    for (const [bi, b] of ALL.entries()) {
      if (a === b) continue;
      duel(seedFor(i, ai, bi), [a, b]);
    }
  }
}

const pc = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}`
  + `${SUBJECT === '' ? ' (every deck)' : ` (${SUBJECT}'s plays)`}`);
console.log(`${plays} casts and activations watched; ${skippedTurnChanged} dropped because the turn`
  + ' advanced inside the action');
console.log('');
console.log('plays where nothing a player would call value moved:');
const rows = [...byCard]
  .filter(([, row]) => row.wasted > 0)
  .sort((a, b) => b[1].wasted - a[1].wasted)
  .slice(0, TOP);
for (const [name, row] of rows) {
  console.log(`  ${String(row.wasted).padStart(4)} of ${String(row.total).padStart(4)}`
    + ` ${pc(row.wasted, row.total).padStart(4)}  ${name}`
    + `  [${[...row.decks].join(', ')}]`);
}
const totalWasted = [...byCard.values()].reduce((n, row) => n + row.wasted, 0);
console.log('');
console.log(`${totalWasted} of ${plays} plays (${pc(totalWasted, plays)}) moved nothing this reads —`
  + ' read the header before believing any of it');
