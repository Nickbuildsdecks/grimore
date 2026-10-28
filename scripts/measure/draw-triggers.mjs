/**
 * Does "whenever you draw a card" actually fire, and what does it add up to?
 *
 * The `draws` event is raised from `draw` in `effects.ts`, which every path that draws a card comes
 * through — the draw step, the crown, and two dozen card effects. That makes it the most frequent
 * event in the engine by a wide margin, and the most frequent event is the one it is easiest to be
 * wrong about in a direction a unit test cannot see: a trigger that fires on the draw step and
 * nothing else would pass every test in `scripts.test.ts` and still mean the card does nothing.
 *
 * So this counts the ability reaching the **stack**, which is the one place a trigger is
 * observable from outside the engine: a triggered ability is a stack object carrying the card it
 * came from and which of its abilities it is. Nothing here reads `GameState.drew`, deliberately —
 * that list is filled and drained inside a single applied action, so a harness watching between
 * actions would see an empty list every time and report a confident zero.
 *
 * It also reports what the triggers *bought*, because a count on its own cannot tell a Chasm
 * Skulker that grew to 8/8 from one that was a 2/2 when it died: the biggest one each game, the
 * Squids it left behind, and the life the opponents' draws cost them.
 *
 * **What this cannot tell you** is whether the cards are worth their slots. Thirty triggers and a
 * 6/6 Skulker is a card doing its job; whether the deck wins more for it is `deck-probe`'s
 * question and the answer is written in `starterDecks.ts` beside each slot.
 */
import {
  applyAction, createGame, botAction, seatsToAct, scriptFor, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'hollow-tide';
/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  Which abilities to watch, worked out from the scripts rather than listed here.

  A card is in this table because its script has a `draws` trigger, so a third card added tomorrow
  is measured without anybody remembering to come back — the same reason every harness in this
  directory reads `STARTER_DECKS` instead of naming the decks.
*/
const WATCHED = new Map();
for (const deck of Object.values(STARTER_DECKS)) {
  for (const entry of deck.cards) {
    const script = scriptFor(entry.card.name);
    (script?.triggers ?? []).forEach((trigger, index) => {
      if (trigger.on.kind !== 'draws') return;
      WATCHED.set(`${entry.card.name}:${index}`, {
        card: entry.card.name, index, by: trigger.on.by ?? 'you',
      });
    });
  }
}

const fired = new Map([...WATCHED.keys()].map((k) => [k, 0]));
let games = 0;
let biggest = 0;
let squids = 0;
let skulkerGames = 0;
let skulkerSeen = 0;

function duel(seed, decks, mine) {
  const ctx = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, ctx);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, ctx);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, ctx);

  /** Stack objects already counted, so an ability sitting on the stack is one firing. */
  const counted = new Set();
  let best = 0;
  let sawSkulker = false;
  for (let move = 0; move < 4000 && !s.finished; move++) {
    for (const id of s.stackOrder) {
      const object = s.stackObjects[id];
      if (object?.kind !== 'triggered' || counted.has(id)) continue;
      const name = s.cardDefs[object.cardKey]?.name;
      const key = `${name}:${object.abilityIndex ?? 0}`;
      if (!fired.has(key)) continue;
      counted.add(id);
      fired.set(key, fired.get(key) + 1);
    }
    /*
      The Skulker's size, sampled every move rather than read when it dies.

      A creature that dies has its counters taken off on the way to the graveyard, as the rules
      require, so "how big did it get" is not a question the end of the game can answer. Sampling
      is honest about what it is: the biggest it was seen at, which is the biggest it was.
    */
    for (const inst of Object.values(s.instances)) {
      if (inst.zone !== 'battlefield' || inst.zoneSeat !== mine) continue;
      const name = s.cardDefs[inst.defKey]?.name;
      if (name === 'Chasm Skulker') {
        sawSkulker = true;
        best = Math.max(best, 1 + (inst.counters['+1/+1'] ?? 0));
      }
      if (name === 'Squid') squids += 1;
    }
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action, ctx); } catch { break; }
    if (s.stateVersion === before) break;
  }
  if (sawSkulker) {
    skulkerGames += 1;
    skulkerSeen += best;
    biggest = Math.max(biggest, best);
  }
}

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other], 0); games += 1;
    duel(SEED0 + i, [other, SUBJECT], 1); games += 1;
  }
}

console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log('');
if (WATCHED.size === 0) {
  console.log('no card in the pool has a `draws` trigger — nothing to count');
} else {
  console.log('abilities that reached the stack:');
  for (const [key, count] of fired) {
    const row = WATCHED.get(key);
    console.log(`  ${String(count).padStart(5)}  ${row.card} (whenever ${row.by} draws)`);
  }
}
if (skulkerGames > 0) {
  console.log('');
  console.log(`Chasm Skulker reached the battlefield in ${skulkerGames} of ${games} games`);
  console.log(`  biggest it ever got: ${biggest}/${biggest}`);
  console.log(`  average best per game: ${(skulkerSeen / skulkerGames).toFixed(1)}`);
  // Squids are sampled per move, so this is "Squid-moves" rather than Squids: a token that lives
  // ten moves counts ten times. Reported as a yes/no about the death trigger rather than a count.
  console.log(`  its death trigger made Squids: ${squids > 0 ? 'yes' : 'no'}`);
}
