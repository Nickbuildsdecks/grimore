/**
 * Does a granted triggered ability ever actually fire, and what does the bot hand it to?
 *
 * D251 shipped the machinery for one permanent handing another a triggered ability, and the two
 * cards that use it cost Skyward Writ eighteen games of 288. `cast-counts` says the bot casts both
 * of them in nearly every game it draws them, so the cards are being *played* — which leaves two
 * very different explanations and no way to tell them apart from a win rate:
 *
 * - **the effect is weak**: the ability fires, the card is drawn, and a card a turn is not worth
 *   the slot in this deck;
 * - **the bot misplays it**: the ability never fires at all, because the Aura goes on whatever
 *   creature happens to be there and that creature is dead or walled before it connects.
 *
 * The second is a bot rule with a fix; the first is a slot decision. This asks the question whose
 * answer separates them: **per cast, how many times did the granted ability trigger, and how often
 * was the thing holding it gone before it fired once.**
 *
 * **What it counts.** Every cast of a card declaring `grantedTriggers`, with the creature it was
 * handed to; then every ability that goes on the stack carrying `grantedBy` (which is the engine's
 * own record of a granted trigger, so this cannot drift from what the rules did); then, for each
 * host, whether it left the battlefield and whether anything had fired for it by then.
 *
 * A pair and an Aura are both handled, because the two cards grant the same ability by different
 * routes: the host of an Aura is its `attachedTo`, and the "host" of a soulbond grant is each half
 * of `pairedWith`. Both are read off the state rather than guessed from the card name.
 *
 * **The control.** A run where nothing was ever granted proves nothing and must not read as a clean
 * sheet, so a census of casts is printed and the process exits non-zero when it is empty. The same
 * rule `leaving-creatures` and `mechanic-coverage` follow.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=skyward-writ SEEDS=6 node scripts/measure/granted-abilities.mjs
 *     SUBJECT=skyward-writ BOT='{"wasteFilters":false}' node scripts/measure/granted-abilities.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS, CARD_SCRIPTS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'skyward-writ';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 4400);
const BOT = JSON.parse(process.env.BOT ?? '{}');
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
const CTX = { isHost: true };

/*
  Which cards grant an ability, derived from the scripts rather than named here.

  The same rule every instrument in this directory follows since the twelfth deck was added and a
  table silently measured the eleven-deck field: a list written out by hand answers last week's
  question. The next granting card is counted here the day it is written.
*/
const GRANTORS = new Set(
  [...CARD_SCRIPTS.values()]
    .filter((script) => script.grantedTriggers !== undefined).map((script) => script.name),
);

const per = new Map(); // grantor name -> { casts, fires, hostsLost, lostBeforeFiring, hosts: Map }
const row = (name) => {
  const found = per.get(name);
  if (found !== undefined) return found;
  const made = { casts: 0, fires: 0, hostsLost: 0, lostBeforeFiring: 0, hosts: new Map() };
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
  /*
    One record per *grant that reached the battlefield*, keyed by the granting instance.

    Keyed by the grantor rather than by the host, because a soulbond grant reaches two creatures and
    an Aura one, and "did this card ever buy anything" is a question about the card. `fired` is a
    flag rather than a count so a host lost after the first draw is not counted as a waste.
  */
  const live = new Map(); // grantor instance id -> { name, hosts: Set<string>, fired: boolean }
  const counted = new Set(); // stack object ids already tallied

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, BOT);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action, CTX); } catch { break; }
    if (s.stateVersion === before) break;

    /*
      The grants currently on the battlefield, re-read every move rather than hooked onto the cast.

      An Aura's host is only known once the spell has resolved, and a pair is made by a trigger that
      resolves later still — so a version that recorded the target at cast time would have recorded
      the target of a spell that was countered, or nothing at all for the pair. Reading the state is
      also what keeps this honest about a *moved* bonus: a Lookout that pairs again after its first
      partner dies is a second grant, and shows up as one.
    */
    for (const [id, inst] of Object.entries(s.instances)) {
      if (inst.owner !== mine || inst.zone !== 'battlefield') continue;
      const name = nameOf(s, id);
      if (name === undefined || !GRANTORS.has(name)) continue;
      const hosts = new Set();
      if (inst.attachedTo !== null && inst.attachedTo !== undefined) hosts.add(inst.attachedTo);
      if (inst.pairedWith !== undefined) { hosts.add(id); hosts.add(inst.pairedWith); }
      if (hosts.size === 0) continue;
      const already = live.get(id);
      if (already === undefined) {
        row(name).casts += 1;
        for (const host of hosts) {
          const hostName = nameOf(s, host);
          if (hostName !== undefined) {
            row(name).hosts.set(hostName, (row(name).hosts.get(hostName) ?? 0) + 1);
          }
        }
        live.set(id, { name, hosts, fired: false });
      } else {
        for (const host of hosts) already.hosts.add(host);
      }
    }

    // Every granted ability that has gone on the stack since the last look. `grantedBy` is the
    // engine's own record of where the ability was defined, so this counts what the rules did.
    for (const stackId of s.stackOrder) {
      if (counted.has(stackId)) continue;
      counted.add(stackId);
      const object = s.stackObjects[stackId];
      const by = object?.grantedBy?.card;
      if (by === undefined || object.controller !== mine) continue;
      row(by).fires += 1;
      for (const record of live.values()) if (record.name === by) record.fired = true;
    }

    /*
      And the hosts that are gone. Checked here rather than at the end of the game, because by the
      last turn almost everything is dead and a count taken there would read 100% for every card.
    */
    for (const [id, record] of [...live]) {
      const stillThere = [...record.hosts].some((host) => s.instances[host]?.zone === 'battlefield');
      if (stillThere) continue;
      row(record.name).hostsLost += 1;
      if (!record.fired) row(record.name).lostBeforeFiring += 1;
      live.delete(id);
    }
  }
}

let games = 0;
// A seed of its own for every game, derived from the loop indices: one seed is one RNG stream and
// one stream is one shuffle, so a pass over the field on one seed had the error bars of its seed
// count rather than its game count (D240).
const seedFor = (pass, j, order) => SEED0 + ((pass * FIELD.length + j) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (const [j, other] of FIELD.entries()) {
    duel(seedFor(i, j, 0), [SUBJECT, other], 0); games += 1;
    duel(seedFor(i, j, 1), [other, SUBJECT], 1); games += 1;
  }
}

console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}${
  Object.keys(BOT).length === 0 ? '' : `, bot ${JSON.stringify(BOT)}`}`);
console.log(`cards that grant an ability: ${[...GRANTORS].join(', ') || 'none in the pool'}`);
if (per.size === 0) {
  console.log('!! nothing in this deck granted an ability in any game, so there is nothing here to');
  console.log('!! read. Either the subject holds no granting card or they were never cast: check');
  console.log('!! with cast-counts before believing any conclusion drawn from this run.');
  process.exit(1);
}
console.log('');
for (const [name, r] of [...per].sort((a, b) => b[1].casts - a[1].casts)) {
  const rate = r.casts === 0 ? '—' : (r.fires / r.casts).toFixed(2);
  const wasted = r.hostsLost === 0 ? '—' : `${Math.round((100 * r.lostBeforeFiring) / r.hostsLost)}%`;
  console.log(`${name}`);
  console.log(`  ${String(r.casts).padStart(4)} grants reached the battlefield`);
  console.log(`  ${String(r.fires).padStart(4)} times the granted ability triggered  (${rate} per grant)`);
  console.log(`  ${String(r.hostsLost).padStart(4)} grants lost every creature holding them, ${r.lostBeforeFiring} of them before firing once (${wasted})`);
  const hosts = [...r.hosts].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  handed to: ${hosts.map(([h, n]) => `${h} x${n}`).join(', ')}`);
  console.log('');
}
