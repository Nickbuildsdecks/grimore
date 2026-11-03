/**
 * Is the engine's **state** self-consistent after every action of a real game?
 *
 *   pnpm --filter @grimore/rules-engine build
 *   SEEDS=6 node scripts/measure/state-invariants.mjs
 *   SEEDS=2 POD=1 node scripts/measure/state-invariants.mjs
 *
 * `unfinished.mjs` and `pod-unfinished.mjs` ask whether a game *stops* wrongly — a throw, a stall,
 * a cap. This asks the quieter question: whether the state the engine hands back is a state the
 * engine's own rules could describe. A game that plays to a winner can still have left something
 * behind, and the two bugs that prompted this were both of that kind:
 *
 *  - **An effect whose source has gone.** `relocate` clears `attachedTo` and leaves `effects`
 *    alone, which is invisible while the only way an Aura leaves is its host leaving first — and
 *    was a Pacifism still pacifying from the graveyard the moment an Aura could be binned off a
 *    *living* host (#284, D305).
 *  - **An id that is not an identity.** A creature blinked out and back wears the same instance id,
 *    so a register keyed on one finds the wrong object (#283, #285, #286). Three registers had it;
 *    the third was found by looking rather than by a failing test.
 *
 * Neither showed up as a throw, a stall or a wrong winner. Both would show up here.
 *
 * **What an invariant is allowed to be.** Every check below has to be something the rules make
 * true of *every* state, not something that happens to hold today — a check that encodes a
 * coincidence fails on the next correct card and gets turned off, which is worse than not having
 * it. Three candidates were rejected on exactly that ground and are written down with the others,
 * because the next person to think of them deserves the reason:
 *
 *  - *"every blocker in an attack is on the battlefield"* — **wrong**: a blocker that has left
 *    stays in `attack.blockers`, because that list is what says the attacker is blocked at all
 *    (CR 509.1h).
 *  - *"every effect's source is on the battlefield"* — **wrong**: a Giant Growth's source is a
 *    spell in the graveyard by the time its pump matters.
 *  - *"the stack is empty whenever somebody has priority"* — **wrong** and backwards; holding
 *    priority with a spell on the stack is the whole of responding.
 *  - *"a delayed trigger names a card the game still has"* — **wrong**, and this one was written,
 *    run, and deleted: a pod turned up `delayed dl34 is about t2_245, which is gone`, and a token
 *    that has ceased to exist is exactly the case CR 603.7d covers. The ability still fires and
 *    finds nothing, which is the rule rather than a leak.
 *
 * A violation prints the seed, the move, the invariant and the offending ids, and the run exits
 * non-zero. Like the throw hunt, **a non-zero exit is the point**.
 */
import {
  STARTER_DECKS, applyAction, botAction, createGame, seatsToAct, zoneKey,
} from '../../packages/rules-engine/dist/index.js';
import { provenanceLine } from '../lib/provenance.mjs';

const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 4);
const SEED0 = Number(process.env.SEED0 ?? 50000);
const MOVES = Number(process.env.MOVES ?? 8000);
const POD = process.env.POD === '1';
const PLAYERS = [
  { playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' },
  { playerId: 'p2', name: 'C' }, { playerId: 'p3', name: 'D' },
];

/*
  The engine's own `zoneKey`, imported rather than rebuilt — which the first run of this file is
  the argument for: a hand-rolled `${seat}:${zone}` reported 43 violations in 52 games, every one
  of them a card on the **stack**, which is a single shared zone keyed `stack` with no seat in it.
  An invariant that reimplements the thing it is checking tests the reimplementation.
*/
const keyFor = (seat, zone) => zoneKey(seat, zone);

/**
 * How many real cards each seat **owns**, by owner rather than by where the card is sitting.
 *
 * By owner because a card can be in somebody else's zone — stolen, exiled by their spell, on the
 * stack — and it is still that player's card: owner is the one thing about an instance that never
 * changes. Tokens are left out because a token is created by an effect and ceases to exist when it
 * leaves the battlefield (CR 111.7), so a count including them moves legally all game.
 */
function ownedBySeat(s) {
  const owned = new Map();
  for (const inst of Object.values(s.instances)) {
    if (inst.isToken === true) continue;
    owned.set(inst.owner, (owned.get(inst.owner) ?? 0) + 1);
  }
  return owned;
}

/**
 * Every invariant, as a function returning the ids that break it.
 *
 * One function each rather than one pass with a switch, because the *name* is what a failure
 * prints and a name that covers two rules tells you half of what you need.
 */
const INVARIANTS = [
  {
    name: 'every instance is in exactly one zone list, where its own zone says it is',
    check: (s) => {
      const bad = [];
      const seatsAt = new Map();
      for (const [key, ids] of Object.entries(s.zones)) {
        for (const id of ids) {
          if (seatsAt.has(id)) bad.push(`${id} is in ${seatsAt.get(id)} and ${key}`);
          seatsAt.set(id, key);
        }
      }
      for (const [id, inst] of Object.entries(s.instances)) {
        const where = seatsAt.get(id);
        const want = keyFor(inst.zoneSeat, inst.zone);
        if (where === undefined) bad.push(`${id} says ${want} and is in no zone list`);
        else if (where !== want) bad.push(`${id} says ${want} and is in ${where}`);
      }
      for (const [id, key] of seatsAt) {
        if (s.instances[id] === undefined) bad.push(`${key} holds ${id}, which is not an instance`);
      }
      return bad;
    },
  },
  {
    /*
      **Per living seat**, and both halves of that were learned by running it.

      Counting every card on the table read "123 of 122" the first time anything made a Soldier —
      tokens are created and cease to exist by the rules (CR 111.7), so they are left out. And in a
      pod it read "183 of 244", which is one 60-card deck and a commander: a seat had been knocked
      out and its cards had left the game, exactly as CR 800.4a says (#276). A whole-table total
      cannot tell that from a leak, so the check is per seat and asks only about seats still in.

      Stronger than the total it replaced, as it happens: it would catch *my* cards disappearing
      when somebody else leaves the game, which is the half of CR 800.4a that is easy to get wrong.
    */
    name: 'no living seat loses a card it owns',
    check: (s, started) => {
      const now = ownedBySeat(s);
      const bad = [];
      for (const seat of s.seats) {
        if (seat.eliminated !== false) continue;
        const have = now.get(seat.index) ?? 0;
        const dealt = started.get(seat.index) ?? 0;
        if (have !== dealt) bad.push(`seat ${seat.index} owns ${have} cards and was dealt ${dealt}`);
      }
      return bad;
    },
  },
  {
    name: 'an attachment points at a permanent on the battlefield',
    check: (s) => {
      const bad = [];
      for (const [id, inst] of Object.entries(s.instances)) {
        if (inst.attachedTo === null || inst.attachedTo === undefined) continue;
        const host = s.instances[inst.attachedTo];
        if (host === undefined) bad.push(`${id} is attached to ${inst.attachedTo}, which is gone`);
        else if (host.zone !== 'battlefield') bad.push(`${id} is attached to ${inst.attachedTo} in ${host.zone}`);
        else if (inst.zone !== 'battlefield') bad.push(`${id} is attached from ${inst.zone}`);
      }
      return bad;
    },
  },
  {
    name: 'a pair is two living creatures that name each other',
    check: (s) => {
      const bad = [];
      for (const [id, inst] of Object.entries(s.instances)) {
        if (inst.pairedWith === undefined) continue;
        const other = s.instances[inst.pairedWith];
        if (other === undefined) bad.push(`${id} is paired with ${inst.pairedWith}, which is gone`);
        else if (other.pairedWith !== id) bad.push(`${id} names ${inst.pairedWith}, which names ${other.pairedWith}`);
        else if (inst.zone !== 'battlefield' || other.zone !== 'battlefield') {
          bad.push(`${id} and ${inst.pairedWith} are paired off the battlefield`);
        }
      }
      return bad;
    },
  },
  {
    /*
      The one the Aura leak would have tripped. Not "the source is on the battlefield" — a Giant
      Growth's source is a card in a graveyard — but "the source is a card this game has", which
      catches an effect left behind by a permanent that has stopped existing, and an effect scoped
      to a card that no longer exists.
    */
    name: 'every continuous effect names cards the game still has',
    check: (s) => {
      const bad = [];
      for (const effect of s.effects) {
        if (s.instances[effect.source] === undefined && s.stackObjects[effect.source] === undefined) {
          bad.push(`an effect is sourced from ${effect.source}, which is not a card or an object`);
        }
        if (effect.scope?.kind !== 'cards') continue;
        for (const id of effect.scope.ids) {
          if (s.instances[id] === undefined) bad.push(`an effect from ${effect.source} scopes ${id}, which is gone`);
        }
      }
      return bad;
    },
  },
  {
    name: 'no counter is negative',
    check: (s) => {
      const bad = [];
      for (const [id, inst] of Object.entries(s.instances)) {
        for (const [kind, n] of Object.entries(inst.counters ?? {})) {
          if (n < 0) bad.push(`${id} has ${n} ${kind} counters`);
        }
      }
      return bad;
    },
  },
  {
    /*
      The invariant #277 was: the engine must never be waiting on a player who has left.

      That bug took 2444 pods to find through a harness that printed "(N unfinished)" over it, and
      what it looked like from outside was a table that stopped. Here it is a named check on every
      state rather than a stop reason nobody reads — and it covers all six questions at once,
      because every one of them is a seat the engine is waiting for.
    */
    name: 'nothing is being waited on from a seat that has left the game',
    check: (s) => {
      const out = (seat) => seat !== undefined && s.seats[seat]?.eliminated !== false;
      const bad = [];
      const asked = [
        ['a choice', s.pendingChoice?.seat], ['a decision', s.pendingDecision?.seat],
        ['a payment', s.pendingPayment?.seat], ['an offered cast', s.pendingOfferedCast?.seat],
        ['a dredge', s.pendingDredge?.seat], ['a discard', s.pendingDiscard?.seat],
        ['priority', s.priority ?? undefined],
      ];
      for (const [what, seat] of asked) {
        if (out(seat)) bad.push(`${what} is pending on seat ${seat}, which has left`);
      }
      return bad;
    },
  },
  {
    name: 'the crown and the initiative are held by a seat still in the game',
    check: (s) => {
      const bad = [];
      if (s.monarch !== null && s.seats[s.monarch]?.eliminated !== false) bad.push(`seat ${s.monarch} holds the crown`);
      if (s.initiative !== null && s.seats[s.initiative]?.eliminated !== false) bad.push(`seat ${s.initiative} holds the initiative`);
      return bad;
    },
  },
  {
    name: 'a pending question is about something that is still there',
    check: (s) => {
      const bad = [];
      const choice = s.pendingChoice;
      if (choice !== null && choice !== undefined && choice.stackId !== undefined
        && s.stackObjects[choice.stackId] === undefined) {
        bad.push(`a choice is pending on ${choice.stackId}, which is off the stack`);
      }
      for (const [id, obj] of Object.entries(s.stackObjects)) {
        if (!s.stackOrder.includes(id)) bad.push(`${id} (${obj.description}) is an object off the stack order`);
      }
      for (const id of s.stackOrder) {
        if (s.stackObjects[id] === undefined) bad.push(`${id} is in the stack order with no object`);
      }
      return bad;
    },
  },
];

/** Plays one game, checking every invariant after every applied action. */
function play(seed, decks) {
  const seats = decks.map((_, i) => i);
  let s = createGame({
    id: `inv${seed}`, format: POD ? 'pod' : 'modern',
    players: PLAYERS.slice(0, decks.length), seed,
  });
  for (const seat of seats) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const started = ownedBySeat(s);

  const found = [];
  for (let move = 0; move < MOVES && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    /*
      A table with nobody to act and nothing finished is the shape of #277, so it is a finding
      here rather than a quiet `break` — the one thing every harness in this directory used to do
      with it, and the reason that bug lived for 2444 pods.
    */
    if (seat === undefined) {
      found.push({ move, name: 'the game is unfinished and no seat has anything to do', why: `turn ${s.turn} step ${s.step}` });
      break;
    }
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    try {
      s = applyAction(s, action);
    } catch (err) {
      found.push({ move, name: 'the engine refused an action it offered', why: `${action.type}: ${err?.message ?? err}` });
      break;
    }
    if (s.stateVersion === before) break;
    for (const invariant of INVARIANTS) {
      for (const why of invariant.check(s, started)) found.push({ move, name: invariant.name, why });
    }
    // One game's worth of the same broken thing says no more than the first; move on.
    if (found.length > 0) break;
  }
  return found;
}

process.stdout.write(`${provenanceLine({ SEED0, SEEDS, MOVES, POD: POD ? 1 : 0 })}\n`);

let games = 0;
const byInvariant = new Map();
for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    const decks = POD
      ? [0, 1, 2, 3].map((k) => ALL[(a * 3 + k * 4) % ALL.length])
      : [ALL[a], ALL[(a + 1 + i) % ALL.length]];
    const seed = SEED0 + i * ALL.length + a;
    games += 1;
    for (const bad of play(seed, decks)) {
      const seen = byInvariant.get(bad.name) ?? { n: 0, where: [] };
      seen.n += 1;
      if (seen.where.length < 4) seen.where.push(`seed ${seed} move ${bad.move}: ${bad.why}`);
      byInvariant.set(bad.name, seen);
    }
  }
  process.stdout.write(`  after ${i + 1} of ${SEEDS} passes: ${games} games, ${byInvariant.size} invariant(s) broken\n`);
}

console.log(`\n${games} games, ${INVARIANTS.length} invariants checked after every action`);
if (byInvariant.size === 0) {
  console.log('every state was self-consistent');
} else {
  for (const [name, { n, where }] of [...byInvariant].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(n).padStart(3)}x  ${name}`);
    for (const w of where) console.log(`        ${w}`);
  }
  process.exitCode = 1;
}
