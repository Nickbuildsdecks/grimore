/**
 * Does the bot ever **spend** energy, or does it sit on a pile of counters?
 *
 * Energy (CR 122) is the first resource in this pool that is saved rather than spent on the turn it
 * arrives, and that makes it the first one a player — or a bot — can get wrong by doing nothing at
 * all. Every other instrument here is blind to it:
 *
 * - `cast-counts.mjs` counts **casts**, and three of the four energy cards spend it through an
 *   *activated ability*, which never appears there.
 * - `deck-probe.mjs` says whether the deck won more games, which answers whether the cards are
 *   worth their slots and not whether the mechanic is being used.
 * - `wasted-plays.mjs` would see an activation that moved nothing, but spending energy always moves
 *   something — a counter, a colour of mana, a point of damage — so it is never a suspect.
 *
 * So this one watches the pot itself. Every game, for every seat: how much energy came in and from
 * what, how much went out and on what, the high-water mark a seat ever sat on, and how much was
 * still unspent when the game ended. The last of those is the number this was built for — energy
 * left on the table is a resource the bot was given and never used.
 *
 * Both halves are counted from the **action**, before it is applied, which is the only place the
 * intent is visible: after the fact, a seat with four energy and a seat that just spent two look
 * identical in the state.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/energy.mjs
 *     SUBJECT=kindle-grove SEEDS=12 node scripts/measure/energy.mjs
 */
import {
  applyAction, createGame, botAction, scriptFor, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
/** One deck's games only, which is what you want while a mechanic lives in one list. */
const SUBJECT = process.env.SUBJECT ?? '';
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  Which cards can spend energy, read off the scripts rather than written out here.

  The same rule every harness in this directory follows: a list of card names in a measurement
  script is a list that goes stale the day somebody adds the fifth energy card, and a measurement
  that silently answers last week's question is worse than one that fails.
*/
const spenders = new Map(); // name -> [{ index, cost, description }]
for (const name of new Set(Object.values(STARTER_DECKS).flatMap((d) => d.cards.map((c) => c.card.name)))) {
  const abilities = scriptFor(name)?.abilities ?? [];
  const rows = abilities
    .map((ability, index) => ({ index, cost: ability.cost.energy ?? 0, description: ability.description }))
    .filter((row) => row.cost > 0);
  if (rows.length > 0) spenders.set(name, rows);
}

const gained = new Map(); // "card" -> total energy given
const spent = new Map(); // "card — ability" -> total energy spent
const bump = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n);

let games = 0;
let seatGames = 0;
let peakSum = 0;
let peakMax = 0;
let leftoverSum = 0;
let seatsThatSpentNone = 0;
let seatsThatEverHadAny = 0;

const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name;
const energyOfSeat = (st, seat) => st.seats[seat]?.counters['energy'] ?? 0;

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });

  const peak = [0, 0];
  const before = [0, 0];
  for (let move = 0; move < 4000 && !s.finished; move++) {
    for (const seat of [0, 1]) peak[seat] = Math.max(peak[seat], energyOfSeat(s, seat));

    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;

    /*
      An activation that pays energy, counted here because this is where the choice is.

      The ability's own index is what names it: two abilities on one card can both cost energy
      (nothing printed in this pool does, but the Hub's five colours are five rows), so the key is
      the card and the row rather than the card alone.
    */
    if (action.type === 'auto:activate') {
      const card = nameOf(s, action.card);
      const rows = card === undefined ? undefined : spenders.get(card);
      const row = rows?.find((r) => r.index === (action.abilityIndex ?? 0));
      if (row !== undefined) bump(spent, `${card} — ${row.description}`, row.cost);
    }

    const prior = [energyOfSeat(s, 0), energyOfSeat(s, 1)];
    /*
      What is about to resolve, captured before the action rather than after.

      Energy arrives from triggers and from spells resolving, and both of those happen when
      somebody **passes** — so `action.card` is empty exactly when the interesting thing is
      happening. The top of the stack is what is resolving, and the card behind it is the card that
      gave the energy. Without this the whole breakdown reads "(a trigger)", which is true and
      useless: a first run attributed thirty-six of fifty-three that way.
    */
    const top = s.stackOrder[s.stackOrder.length - 1];
    const resolving = top === undefined ? undefined : nameOf(s, s.stackObjects[top]?.source ?? '');
    const version = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === version) break;

    /*
      And what came in, read as a difference rather than from the card that gave it.

      Energy arrives from triggers and from a spell's own resolution, neither of which is an action
      this loop can see — so the honest reading is "the pot went up by two while this action was
      applied", attributed to the card that was played. It is approximate in exactly one way worth
      saying: a turn where two sources fire inside one action is credited to the action's card.
    */
    for (const seat of [0, 1]) {
      const delta = energyOfSeat(s, seat) - prior[seat];
      if (delta <= 0) continue;
      const card = (action.card === undefined ? undefined : nameOf(s, action.card))
        ?? resolving ?? '(something with no card behind it)';
      bump(gained, card, delta);
    }
  }

  for (const seat of [0, 1]) {
    peak[seat] = Math.max(peak[seat], energyOfSeat(s, seat));
    if (peak[seat] === 0) continue;
    seatsThatEverHadAny += 1;
    peakSum += peak[seat];
    peakMax = Math.max(peakMax, peak[seat]);
    leftoverSum += energyOfSeat(s, seat);
    if (energyOfSeat(s, seat) >= peak[seat]) seatsThatSpentNone += 1;
  }
  void before;
  seatGames += 2;
}

for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      if (SUBJECT !== '' && ALL[a] !== SUBJECT && ALL[b] !== SUBJECT) continue;
      duel(SEED0 + i, [ALL[a], ALL[b]]); games += 1;
      duel(SEED0 + i, [ALL[b], ALL[a]]); games += 1;
    }
  }
}

const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}${SUBJECT === '' ? '' : ` (${SUBJECT}'s games)`}\n`);

if (spenders.size === 0) {
  console.log('no card in the pool spends energy.');
} else {
  console.log(`energy in: ${total(gained)}`);
  for (const [card, n] of [...gained.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(5)}  ${card}`);
  }
  console.log(`\nenergy out: ${total(spent)}`);
  if (spent.size === 0) console.log('      0  nothing was ever paid for');
  for (const [key, n] of [...spent.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(5)}  ${key}`);
  }
  const share = total(gained) === 0 ? 0 : Math.round((100 * total(spent)) / total(gained));
  console.log(`\n${share}% of the energy given out was spent.`);
  if (seatsThatEverHadAny > 0) {
    console.log(`${seatsThatEverHadAny} seat-games had any energy at all, of ${seatGames}.`);
    console.log(`  most held at once: ${peakMax}, mean peak ${(peakSum / seatsThatEverHadAny).toFixed(1)}`);
    console.log(`  still unspent when the game ended: ${(leftoverSum / seatsThatEverHadAny).toFixed(1)} on average`);
    console.log(`  seats that spent none of it: ${seatsThatSpentNone} of ${seatsThatEverHadAny}`);
  }
}
