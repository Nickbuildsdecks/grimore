/**
 * Whether a delayed trigger ever happens, and whether it mattered when it did.
 *
 * Two questions a win-rate cannot answer. A Thicket Basilisk whose clause never fires is a 2/4 for
 * five, and a Flickerwisp that blinks a land is a 3/1 flier that cost a card — both would look
 * identical in `deck-probe`, which is exactly what happened the first time these two were priced.
 *
 * So this counts the mechanism: how many delayed triggers were created, how many of them fired at
 * the step they named, and — for the Wisp — **what the bot aimed it at**, because "exile another
 * target permanent" is a choice and a blink pointed at your own Plains is a wasted card.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SEEDS=6 node scripts/measure/delayed-triggers.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const stats = {
  scheduled: 0, fired: 0,
  basiliskGames: 0, basiliskMarks: 0, basiliskKills: 0,
  wispGames: 0, wispBlinks: 0, blinkedMine: 0, blinkedTheirs: 0,
  blinkedKinds: new Map(),
};

const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name;
const typeOf = (s, id) => {
  const line = (s.cardDefs[s.instances[id]?.defKey ?? '']?.typeLine ?? '').toLowerCase();
  for (const t of ['creature', 'land', 'artifact', 'enchantment', 'planeswalker']) {
    if (line.includes(t)) return t;
  }
  return 'other';
};

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  let sawBasilisk = false;
  let sawWisp = false;
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;

    /*
      What the Wisp was pointed at, read off the choice the bot is about to send.

      `auto:choose` answers a triggered ability's targets, so the stack object it belongs to says
      whose trigger it is — which is the only way to tell a Flickerwisp's choice from any other.
    */
    if (action.type === 'auto:choose' && s.pendingChoice !== null) {
      const object = s.stackObjects[s.pendingChoice.stackId];
      if (object !== undefined && nameOf(s, object.source) === 'Flickerwisp') {
        for (const target of action.targets ?? []) {
          if (target.kind !== 'card') continue;
          stats.wispBlinks += 1;
          const mine = s.instances[target.id]?.zoneSeat === seat;
          if (mine) stats.blinkedMine += 1; else stats.blinkedTheirs += 1;
          const kind = `${mine ? 'my ' : 'their '}${typeOf(s, target.id)}`;
          stats.blinkedKinds.set(kind, (stats.blinkedKinds.get(kind) ?? 0) + 1);
        }
      }
    }

    const before = s.stateVersion;
    let next;
    try { next = applyAction(s, action); } catch { break; }
    if (next.stateVersion === before) break;

    for (const inst of Object.values(next.instances)) {
      if (inst.zone !== 'battlefield') continue;
      if (nameOf(next, inst.id) === 'Thicket Basilisk') sawBasilisk = true;
      if (nameOf(next, inst.id) === 'Flickerwisp') sawWisp = true;
    }
    // Delayed triggers created and drained, by watching the list rather than the cards: one
    // counter for the whole mechanism, so a third card that schedules something is counted
    // without touching this file.
    const added = next.delayed.filter((e) => !s.delayed.some((p) => p.id === e.id));
    stats.scheduled += added.length;
    for (const entry of added) {
      if (nameOf(next, entry.source) === 'Thicket Basilisk') stats.basiliskMarks += 1;
    }
    const gone = s.delayed.filter((e) => !next.delayed.some((p) => p.id === e.id));
    stats.fired += gone.length;
    for (const entry of gone) {
      if (nameOf(s, entry.source) !== 'Thicket Basilisk' || entry.subject === undefined) continue;
      // Did the thing it marked actually die? Checked a few moves later rather than at once,
      // because the ability goes on the stack here and resolves when priority comes back round.
      const victim = entry.subject;
      const was = s.instances[victim]?.zone;
      if (was === 'battlefield') stats.pendingVictims = [...(stats.pendingVictims ?? []), victim];
    }
    for (const victim of stats.pendingVictims ?? []) {
      if (next.instances[victim]?.zone === 'graveyard') {
        stats.basiliskKills += 1;
        stats.pendingVictims = stats.pendingVictims.filter((v) => v !== victim);
      }
    }
    s = next;
  }
  stats.pendingVictims = [];
  if (sawBasilisk) stats.basiliskGames += 1;
  if (sawWisp) stats.wispGames += 1;
}

let games = 0;
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      duel(SEED0 + i, [ALL[a], ALL[b]]); games += 1;
      duel(SEED0 + i, [ALL[b], ALL[a]]); games += 1;
    }
  }
}

const pct = (n, of) => (of === 0 ? '—' : `${Math.round((100 * n) / of)}%`);
console.log(`${games} games, seeds ${SEEDS} from ${SEED0}\n`);
console.log(`delayed triggers: ${stats.scheduled} scheduled, ${stats.fired} fired (${pct(stats.fired, stats.scheduled)})`);
console.log('Thicket Basilisk');
console.log(`  on the battlefield in ${stats.basiliskGames} games`);
console.log(`  marked ${stats.basiliskMarks} creatures, and ${stats.basiliskKills} of them died of it`);
console.log('Flickerwisp');
console.log(`  on the battlefield in ${stats.wispGames} games`);
console.log(`  blinked ${stats.wispBlinks}: ${stats.blinkedMine} of its own, ${stats.blinkedTheirs} of an opponent's`);
for (const [kind, n] of [...stats.blinkedKinds].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${kind}: ${n}`);
}
