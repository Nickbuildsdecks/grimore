/**
 * Does a permanent with an ability that eats it ever actually get spent?
 *
 * Treasure and Clue are the pool's first permanents whose whole text is an ability that eats them,
 * and they arrived with an engine change behind them: `manaSources` used to refuse any mana ability
 * that sacrificed its own permanent, so a Treasure could be created and never used. The fix is one
 * line and a flag carried through the solver, and a unit test holds the rules — but a unit test puts
 * the Treasure on the board and the spell in hand on purpose. It cannot say whether the position
 * ever comes up.
 *
 * This asks that. Per game: how many of each were created, how many were **spent by their own
 * controller**, how many were taken away by somebody else, and how many were still sitting there
 * when the game ended. A Treasure that is never spent is a slot that bought nothing; a Treasure
 * that is spent the turn it arrives is a card doing its job.
 *
 * **How a spend is told from a removal**, which is the only part that needed thinking about. A
 * token that leaves the battlefield is deleted from `instances` outright (nothing should ever see a
 * token in a graveyard), so "it is gone" is easy and "why" is not: this pool holds a Disenchant and
 * a Naturalize, and a Treasure can leave because an opponent pointed one at it. So the disappearance
 * is attributed to the **action it happened during**: spending a Treasure for mana happens inside
 * the controller's own cast or activation, where a Disenchant is a cast by somebody else. Anything
 * that vanishes outside its controller's own action is counted as taken rather than spent.
 *
 * **The control.** A run where nothing was created proves nothing and must not read as a clean
 * sheet, so the census is printed and the process exits non-zero when it is empty — the rule
 * `granted-abilities` and `leaving-creatures` follow.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=tidal-mind SEEDS=4 node scripts/measure/spent-permanents.mjs
 *     SUBJECT=skyward-writ node scripts/measure/spent-permanents.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS, CARD_SCRIPTS,
} from '../../packages/rules-engine/dist/index.js';
import { canonicalDecks } from './decks.mjs';

const SUBJECT = process.env.SUBJECT ?? 'tidal-mind';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 4);
const SEED0 = Number(process.env.SEED0 ?? 4400);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const CTX = { isHost: true, ...canonicalDecks(STARTER_DECKS) };

/*
  Every permanent in the pool with an ability that **eats it**, derived from the scripts rather than
  named here.

  Asking the scripts rather than listing the cards is the rule every instrument in this directory
  follows since a hand-written list silently measured an eleven-deck field — and it is what turned
  this from a Treasure-and-Clue counter into a reading of the whole family. The first version read
  the token defs' oracle text for "sacrifice this artifact", which caught exactly the two tokens it
  was written for and would have missed **Lotus Petal** the day it was added: a printed card with
  the same five rows.

  So the set is now every script with a `sacrificeSelf` cost anywhere in its abilities, which also
  takes in Mind Stone, Tormod's Crypt and the Shambling Shell. Those are permanents that are spent
  too, and "does the bot ever press the button that eats the permanent" is the same question about
  all of them.
*/
const SPENDABLE = new Set(
  [...CARD_SCRIPTS.values()]
    .filter((script) => (script.abilities ?? []).some((a) => a.cost?.sacrificeSelf === true))
    .map((script) => script.name),
);

const per = new Map(); // name -> { made, spent, taken, left }
const row = (name) => {
  const found = per.get(name);
  if (found !== undefined) return found;
  const made = { made: 0, spent: 0, taken: 0, left: 0 };
  per.set(name, made);
  return made;
};

function duel(seed, decks, mine) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, CTX);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, CTX);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, CTX);
  const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name;

  /** Live spendable tokens this seat owns: id -> name. */
  const live = new Map();

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, {});
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action, CTX); } catch { break; }
    if (s.stateVersion === before) break;

    /*
      Gone, and attributed to the action it went during: the controller's own cast or activation is
      a spend, anything else is a removal. See the header.

      Two ways of being gone, because the family is no longer all tokens: a token that leaves the
      battlefield is deleted from `instances` outright, where a printed card like Lotus Petal sits
      in a graveyard afterwards. Reading only the first would have counted every Petal as still on
      the battlefield for the rest of the game.
    */
    for (const [id, name] of [...live]) {
      if (s.instances[id]?.zone === 'battlefield') continue;
      const own = action.by === mine && (action.type === 'auto:cast' || action.type === 'auto:activate');
      row(name)[own ? 'spent' : 'taken'] += 1;
      live.delete(id);
    }

    // And the new ones. Read off the battlefield rather than hooked onto the card that made them,
    // because a token's arrival is the resolution of something else and the maker may be a trigger.
    for (const [id, inst] of Object.entries(s.instances)) {
      if (inst.owner !== mine || inst.zone !== 'battlefield' || live.has(id)) continue;
      const name = nameOf(s, id);
      if (name === undefined || !SPENDABLE.has(name)) continue;
      row(name).made += 1;
      live.set(id, name);
    }
  }
  for (const name of live.values()) row(name).left += 1;
}

let games = 0;
// A seed of its own for every game, derived from the loop indices (D240).
const seedFor = (pass, j, order) => SEED0 + ((pass * FIELD.length + j) * 2) + order;
for (let i = 0; i < SEEDS; i++) {
  for (const [j, other] of FIELD.entries()) {
    duel(seedFor(i, j, 0), [SUBJECT, other], 0); games += 1;
    duel(seedFor(i, j, 1), [other, SUBJECT], 1); games += 1;
  }
}

console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log(`permanents with an ability that eats them: ${[...SPENDABLE].join(', ') || 'none'}`);
if (per.size === 0) {
  console.log('!! this deck made none of them in any game, so there is nothing here to read. Check');
  console.log('!! with cast-counts that the card which makes them is being cast at all before');
  console.log('!! believing any conclusion drawn from this run.');
  process.exit(1);
}
console.log('');
for (const [name, r] of [...per].sort((a, b) => b.made - a.made)) {
  const rate = r.made === 0 ? '—' : `${Math.round((100 * r.spent) / r.made)}%`;
  console.log(`${name}`);
  console.log(`  ${String(r.made).padStart(4)} created`);
  console.log(`  ${String(r.spent).padStart(4)} spent by their own controller  (${rate})`);
  console.log(`  ${String(r.taken).padStart(4)} taken away by somebody else`);
  console.log(`  ${String(r.left).padStart(4)} still on the battlefield when the game ended`);
  console.log('');
}
