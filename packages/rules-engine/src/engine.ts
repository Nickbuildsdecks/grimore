import { EMPTY_COMBAT, NO_PRIORITY_STEPS, type StackObject } from './turnTypes.js';
import { EMPTY_POOL } from './mana.js';
import {
  COMMANDER_DAMAGE_THRESHOLD,
  FORMATS,
  POISON_THRESHOLD,
  isFormatId,
} from './formats.js';
import { dealOpeningHands, listAt, reduceCardAction } from './cardActions.js';
import { returnExiledBy } from './effects.js';
import { zoneKey, type CardInstance, type ZoneId } from './cards.js';
import { reduceAutoAction } from './autoActions.js';
import { answerDecision, pendingDeclaration, stateBasedActions } from './automation.js';
import { appendPact, pactLine, pactThrough, PACT_KINDS } from './pacts.js';
import { isAutoAction } from './turnTypes.js';
import {
  assertCounterKey,
  assertDelta,
  assertHost,
  assertInteger,
  assertIntegerInRange,
  assertMayActFor,
  assertNotEliminated,
  assertSeatIndex,
  clampValue,
  hashString,
  MAX_COUNTER_KEY_LENGTH,
  MAX_DICE_COUNT,
  MAX_DICE_SIDES,
  MIN_DICE_COUNT,
  MIN_DICE_SIDES,
  actionSeed,
  deriveNextSeed,
  mulberry32,
  replaceSeat,
  seatName,
} from './internal.js';
import {
  EngineError,
  isCardAction,
  MAX_LOG_ENTRIES,
  type Action,
  type ActionContext,
  type CreateGameOptions,
  type EliminatedReason,
  type GameState,
  type LogEntry,
  type Outcome,
  type Pact,
  type Seat,
  type SeatIndex,
} from './types.js';

// The limits, PRNG and assertion helpers moved to `internal.ts` so the card reducer can share them
// without importing this module back (see that file's header). Re-exported here because they were
// part of this module's public surface before the split.
export {
  MAX_ABS_VALUE,
  MAX_COUNTER_KEY_LENGTH,
  MAX_DELTA,
  MAX_DICE_COUNT,
  MAX_DICE_SIDES,
  MIN_DICE_COUNT,
  MIN_DICE_SIDES,
  actionSeed,
  deriveNextSeed,
  hashString,
  mulberry32,
  shuffled,
} from './internal.js';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function makeSeat(index: number, playerId: string, name: string, life: number): Seat {
  return {
    index,
    playerId,
    name,
    life,
    poison: 0,
    commanderDamage: {},
    damageFrom: {},
    spared: {},
    counters: {},
    eliminated: false,
    eliminatedReason: null,
    commanderTax: 0,
    searching: false,
    mulligans: 0,
    deckId: null,
  };
}

export function createGame(options: CreateGameOptions): GameState {
  const { id, format, players } = options;
  if (typeof id !== 'string' || id.length === 0) {
    throw new EngineError('INVALID_ACTION', 'game id must be a non-empty string');
  }
  if (!isFormatId(format)) {
    throw new EngineError('INVALID_FORMAT', `unknown format: ${String(format)}`);
  }
  const def = FORMATS[format];
  if (!Array.isArray(players) || players.length < def.minPlayers || players.length > def.maxPlayers) {
    throw new EngineError(
      'INVALID_PLAYERS',
      `${def.label} requires ${def.minPlayers}-${def.maxPlayers} players`,
    );
  }
  const seen = new Set<string>();
  for (const p of players) {
    if (!p || typeof p.playerId !== 'string' || p.playerId.length === 0 || typeof p.name !== 'string') {
      throw new EngineError('INVALID_PLAYERS', 'each player needs a playerId and a name');
    }
    if (seen.has(p.playerId)) {
      throw new EngineError('INVALID_PLAYERS', `duplicate playerId: ${p.playerId}`);
    }
    seen.add(p.playerId);
  }
  let seed: number;
  if (options.seed === undefined) {
    seed = hashString(id);
  } else {
    assertInteger(options.seed, 'seed');
    seed = options.seed >>> 0;
  }
  return {
    id,
    format,
    seats: players.map((p, i) => makeSeat(i, p.playerId, p.name, def.startingLife)),
    turn: 0,
    activeSeat: 0,
    monarch: null,
    pacts: [],
    initiative: null,
    started: false,
    finished: false,
    winnerSeat: null,
    stateVersion: 0,
    log: [],
    rngSeed: seed,
    cardDefs: {},
    instances: {},
    zones: {},
    instanceSeq: 0,
    // Automation, empty until a table is switched into automated mode.
    automated: false,
    autoPassOff: [],
    dredgeStops: {},
    kept: [],
    openingHands: false,
    pendingChoice: null,
    pendingPayment: null,
    pendingOfferedCast: null,
    drawsOwed: [],
    pendingDredge: null,
    spellsCastThisTurn: 0,
    lifeLostThisTurn: {},
    cardsDrawnThisTurn: {},
    pendingDecision: null,
    died: [],
    left: [],
    vanished: {},
    replacements: [],
    entered: [],
    dealtCombatDamage: [],
    drew: [],
    toGraveyard: [],
    exiled: [],
    copied: [],
    transformed: [],
    expired: [],
    discarded: [],
    delayed: [],
    step: 'precombat-main',
    priority: null,
    passed: [],
    stackObjects: {},
    stackOrder: [],
    pools: {},
    combat: EMPTY_COMBAT,
    effects: [],
    landsPlayed: {},
    extraLands: {},
    autoSeq: 0,
    drewFromEmpty: [],
    pendingDiscard: null,
  };
}

// ---------------------------------------------------------------------------
// Internal state helpers (all return new objects)
// ---------------------------------------------------------------------------

function aliveSeats(state: GameState): Seat[] {
  return state.seats.filter((s) => !s.eliminated);
}

function nextAliveSeat(state: GameState, from: SeatIndex): SeatIndex {
  const n = state.seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    const seat = state.seats[idx];
    if (seat !== undefined && !seat.eliminated) return idx;
  }
  return from;
}

/**
 * Every zone a player's own cards can be sitting in, which is the list CR 800.4a empties.
 *
 * `stack` is in it because a spell is a card in a zone here too: a departing player's spell on the
 * stack is one of the objects the rule is about, and the stack object above it is removed in the
 * same breath below.
 */
const OWNED_ZONES: readonly ZoneId[] = Object.freeze([
  'battlefield', 'hand', 'library', 'graveyard', 'exile', 'command', 'stack',
]);

/**
 * Has this seat left anything behind? The cheap half of the check, run on the hot path.
 *
 * `leaveTheGame` below is a pass over every instance in the game, and an eliminated seat stays
 * eliminated for the rest of the game — so without this, a pod's last turns would pay for that pass
 * three times per action for ever. Everything it looks at is a length or a short array: once a seat
 * has gone, all seven of its zones are empty and nothing on the stack, in `effects` or in `delayed`
 * names it, so the answer is no and it costs nothing to ask again.
 */
function anythingLeftBehind(state: GameState, seat: SeatIndex): boolean {
  for (const zone of OWNED_ZONES) {
    if (listAt(state, zoneKey(seat, zone)).length > 0) return true;
  }
  if (state.stackOrder.some((id) => state.stackObjects[id]?.controller === seat)) return true;
  if (state.effects.some((effect) => effect.controller === seat)) return true;
  if (state.delayed.some((trigger) => trigger.controller === seat)) return true;
  return false;
}

/**
 * A player who has left the game takes everything they own with them (CR 800.4a).
 *
 * **The engine enforced none of this, and in a pod that is every game.** A seat eliminated on turn
 * nine left its whole board standing: creatures on the battlefield, cards in hand, a library, a
 * graveyard. Found by probe rather than by a test — a live seat's Lightning Bolt listed a dead
 * seat's creature among its legal targets, which is a play the table offers and the rules do not.
 * Three seats are eliminated in every pod that reaches a winner, so until now every pod this engine
 * has played finished with up to three abandoned boards on the table.
 *
 * **What was already right, and why it looked like nothing was wrong.** A dead seat's *abilities*
 * never fired, because `raise` collects its watchers through `apnapSeats`, which filters eliminated
 * seats — a dead player's Chalice of the Void counters nothing, where the same board with its
 * controller alive counters the spell. That is the half of the rule you would notice at the table,
 * and it has been holding by accident for as long as `apnapSeats` has existed. The half nobody
 * noticed is the objects themselves.
 *
 * **Owned, not controlled.** `CardInstance.owner` never changes and `zoneSeat` is the controller, so
 * the rule's two clauses are both expressible. Cards this seat *owns* leave the game wherever they
 * are; a permanent it *controlled without owning* is exiled to its owner instead, which is the
 * rule's own last clause and is reachable here only through `card:control` on a manual table — the
 * one action in this engine that puts a card on a battlefield that is not its owner's.
 *
 * **Leaving the game is not a zone change, so nothing triggers off it.** `relocate` is the only
 * place that raises `leaves`, and this is surgery rather than a move. That is not an unexamined
 * choice: `leaves` is in `raise`'s `selfOnly` set, so the only script that could ever watch a
 * permanent leaving is that permanent's own — and it belongs to the departing player, whose
 * watchers are skipped anyway. So in this card pool the question is not observable, and the
 * cheapest correct answer is the one that raises nothing.
 *
 * **One thing does have to be handed back first.** A card exiled "until this leaves the
 * battlefield" is linked to its exiler by `exiledBy` and nothing else (CR 400.7e), so a live
 * player's creature held by a departing Banisher Priest would be stranded in exile for the rest of
 * the game. `returnExiledBy` runs before the instances are deleted, while there is still something
 * to look it up by.
 *
 * **Deliberately not touched:** the transient per-action lists — `died`, `entered`, `vanished`,
 * `toGraveyard` and the rest. Every reader of those already skips an id with no instance behind it,
 * which is the discipline the whole engine keeps, and `settle` empties them inside the same action.
 * Filtering them here would be a second list of places to keep in step for no change in behaviour.
 * `combat.attacks` is not touched either, because the pass immediately below `leaveTheGame`'s call
 * site already drops an attack whose attacker has no instance — the blockers inside a surviving
 * attack are cleaned here only because that list is the one place a departed card can hide behind a
 * live one.
 */
function leaveTheGame(state: GameState, seat: SeatIndex): GameState {
  let next = state;
  for (const [id, inst] of Object.entries(state.instances)) {
    if (inst.owner === seat && inst.zone === 'battlefield') next = returnExiledBy(next, id);
  }

  // Read after the hand-back above, which can put a card back on the battlefield.
  const departing = new Set<string>();
  const stranded: string[] = [];
  for (const [id, inst] of Object.entries(next.instances)) {
    if (inst.owner === seat) departing.add(id);
    else if (inst.zoneSeat === seat) stranded.push(id);
  }

  const instances: Record<string, CardInstance> = { ...next.instances };
  for (const id of departing) delete instances[id];
  for (const id of stranded) {
    const inst = instances[id];
    if (inst === undefined) continue;
    instances[id] = {
      ...inst, zone: 'exile', zoneSeat: inst.owner, tapped: false,
      attachedTo: null, pairedWith: undefined,
    };
  }
  // Anything still at the table stops pointing at a card that has gone.
  for (const [id, inst] of Object.entries(instances)) {
    const lostHost = inst.attachedTo !== null && instances[inst.attachedTo] === undefined;
    const lostPair = inst.pairedWith !== undefined && instances[inst.pairedWith] === undefined;
    if (!lostHost && !lostPair) continue;
    instances[id] = {
      ...inst,
      ...(lostHost ? { attachedTo: null } : {}),
      ...(lostPair ? { pairedWith: undefined } : {}),
    };
  }

  const moved = new Set(stranded);
  const zones: Record<string, readonly string[]> = {};
  for (const [key, list] of Object.entries(next.zones)) {
    zones[key] = list.filter((id) => instances[id] !== undefined && !moved.has(id));
  }
  for (const id of stranded) {
    const owner = instances[id]?.owner;
    if (owner === undefined) continue;
    const key = zoneKey(owner, 'exile');
    zones[key] = [...(zones[key] ?? []), id];
  }

  const stackOrder = next.stackOrder.filter((id) => next.stackObjects[id]?.controller !== seat);
  const stackObjects: Record<string, StackObject> = {};
  for (const id of stackOrder) {
    const object = next.stackObjects[id];
    if (object !== undefined) stackObjects[id] = object;
  }

  /*
    A question that was waiting on something that has gone is not a question any more.

    This is what the first version got wrong, and `playout.test.ts` caught it inside a minute: a
    trigger of the departing player's was on the stack with its controller being asked for targets,
    and removing the stack object left `pendingChoice` pointing at an id that no longer existed —
    so the next `auto:choose` threw "that ability is no longer on the stack" and the pod died. The
    lesson is the one #269 recorded from the other side: the state that references an object is part
    of what has to go with it, and only a real game found the reference.

    Each one is cleared on **its own referent** rather than on the seat, because a live player can
    be mid-answer on their own ability: the stack object stays (its controller is alive), so the
    question stays too. Priority is not restored here — the pass further down
    `resolveStateBasedActions` already hands it back when nothing is blocking the game, which is
    exactly the invariant a cleared question restores.
  */
  const gone = (stackId: string): boolean => stackObjects[stackId] === undefined;
  const cardGone = (id: string): boolean => instances[id] === undefined;

  const pools = { ...next.pools };
  delete pools[String(seat)];

  return {
    ...next,
    instances,
    zones,
    stackOrder,
    stackObjects,
    pools,
    effects: next.effects.filter(
      (effect) => effect.controller !== seat && !departing.has(effect.source),
    ),
    delayed: next.delayed.filter(
      (trigger) => trigger.controller !== seat && !departing.has(trigger.source),
    ),
    pendingChoice: next.pendingChoice !== null && gone(next.pendingChoice.stackId)
      ? null : next.pendingChoice,
    pendingDecision: next.pendingDecision !== null && gone(next.pendingDecision.stackId)
      ? null : next.pendingDecision,
    pendingPayment: next.pendingPayment !== null && cardGone(next.pendingPayment.source)
      ? null : next.pendingPayment,
    pendingOfferedCast: next.pendingOfferedCast !== null && cardGone(next.pendingOfferedCast.card)
      ? null : next.pendingOfferedCast,
    pendingDredge: next.pendingDredge !== null && cardGone(next.pendingDredge.card)
      ? null : next.pendingDredge,
    pendingDiscard: next.pendingDiscard?.seat === seat ? null : next.pendingDiscard,
    drawsOwed: next.drawsOwed.filter((index) => index !== seat),
    passed: next.passed.filter((index) => index !== seat),
    combat: {
      ...next.combat,
      attacks: next.combat.attacks.map((attack) => ({
        ...attack,
        blockers: attack.blockers.filter((id) => instances[id] !== undefined),
      })),
      blockersDeclaredBy: next.combat.blockersDeclaredBy.filter((index) => index !== seat),
    },
  };
}

interface Elimination {
  readonly seat: SeatIndex;
  readonly reason: EliminatedReason;
}

/** Applies elimination and win-condition checks. Returns new state plus what changed. */
function resolveStateBasedActions(state: GameState): { state: GameState; eliminations: Elimination[] } {
  const def = FORMATS[state.format];
  const eliminations: Elimination[] = [];
  // On an automated table the rules that check themselves — lethal damage, auras with nothing to
  // enchant, drawing from an empty library — run first, because they can produce the very
  // eliminations this function is about to look for.
  let next = state.automated ? stateBasedActions(state) : state;

  for (const seat of state.seats) {
    if (seat.eliminated) continue;
    let reason: EliminatedReason | null = null;
    if (seat.life <= 0) {
      reason = 'life';
    } else if (def.poisonRule && seat.poison >= POISON_THRESHOLD) {
      reason = 'poison';
    } else if (
      def.commanderDamageRule &&
      Object.values(seat.commanderDamage).some((d) => d >= COMMANDER_DAMAGE_THRESHOLD)
    ) {
      reason = 'commanderDamage';
    }
    if (reason !== null) {
      next = replaceSeat(next, seat.index, { eliminated: true, eliminatedReason: reason });
      eliminations.push({ seat: seat.index, reason });
    }
  }

  /*
    And a player who has left the game takes everything they own with them (CR 800.4a).

    Asked of every eliminated seat rather than only the ones eliminated in the loop above, because
    `eliminated` is set in three different places — here, in `stateBasedActions` for a player who
    drew from an empty library, and in the concede action — and this pass is the only thing that
    sees all three. `anythingLeftBehind` is what makes asking again free once a seat has gone.
  */
  /*
    The engine stops waiting on a player who has left the game (#277, D299).

    Six questions can be outstanding when a seat is eliminated, and every one of them names the seat
    it is waiting on. `seatsToAct` reads those fields, so a question left standing on a departed seat
    makes the engine report a dead player as the one it is waiting on — and driving a bot for that
    seat produces an action the engine then refuses. That is not hypothetical: six of the ten pods
    that failed to finish in #268 died on `pact:offer: seat N has been eliminated`, because a dead
    seat's life is 0, so every opponent's open board looks lethal to `offerPact` and it always finds
    somebody to ask (D298).

    A **decision** is resumed rather than dropped, because the rest of the plan belongs to other
    players: "each player sacrifices a creature" must carry on round the table. `answerDecision`
    with an empty answer is exactly what `askOrFinish` already does for a seat eliminated *between*
    two questions — this is the same thing for a question already asked. The loop is bounded by the
    seat count because a plan can hold several departed seats in a row.

    The other five carry no continuation — they are one seat's answer and nothing else's — so
    withdrawing them is the whole of it. Priority is not restored here: the pass below hands it back
    whenever nothing is blocking the game, which is the invariant a withdrawn question restores.
  */
  for (let guard = 0; guard <= next.seats.length; guard++) {
    const asked = next.pendingDecision;
    if (asked === null || next.seats[asked.seat]?.eliminated !== true) break;
    next = answerDecision(next, []).state;
  }
  const leftTheTable = (seat: SeatIndex): boolean => next.seats[seat]?.eliminated === true;
  if (next.pendingChoice !== null && leftTheTable(next.pendingChoice.seat)) {
    next = { ...next, pendingChoice: null };
  }
  if (next.pendingPayment !== null && leftTheTable(next.pendingPayment.seat)) {
    next = { ...next, pendingPayment: null };
  }
  if (next.pendingDredge !== null && leftTheTable(next.pendingDredge.seat)) {
    next = { ...next, pendingDredge: null };
  }
  if (next.pendingOfferedCast !== null && leftTheTable(next.pendingOfferedCast.seat)) {
    next = { ...next, pendingOfferedCast: null };
  }
  if (next.pendingDiscard !== null && leftTheTable(next.pendingDiscard.seat)) {
    next = { ...next, pendingDiscard: null };
  }

  /*
    Only while the game is still going on, which is the other half of the rule.

    CR 800.4 is a **multiplayer** rule: it exists because the game continues after somebody loses,
    and the objects they left behind would otherwise keep affecting it. A two-player game ends the
    moment one player loses (CR 104.2a), so there is no game left for anything to leave — and
    emptying the loser's zones there would delete the final board the table is still showing, which
    D252 decided stays up after the game. The same applies to the last elimination in a pod: it is
    the one that ends the game, and the board it ends on is the board both players look at.

    So this is gated on more than one seat surviving. It is also the only reading of the rule that
    keeps `scripts.test.ts`'s decking test honest — a player who loses to an empty library in a duel
    has ten cards in their graveyard, and the test is entitled to look at them.
  */
  let departed = false;
  if (aliveSeats(next).length > 1) {
    for (const row of next.seats) {
      if (row.eliminated && anythingLeftBehind(next, row.index)) {
        next = leaveTheGame(next, row.index);
        departed = true;
      }
    }
  }
  /*
    And the board is checked again, because taking a board away is a change to the board.

    CR 704.3 runs the self-checking rules until nothing more changes, and the pass at the top of
    this function ran before the departure above. The case it is for: a live player's Aura on a
    creature that has just left the game is left attached to nothing, which is CR 704.5m's job and
    nothing else's. Without this it would sit on the battlefield until the next action — or for
    ever, if that departure was the one that ended the game.
  */
  if (departed && next.automated) next = stateBasedActions(next);

  // Eliminated seats (including concessions) cannot hold the crown or the initiative.
  if (next.monarch !== null && next.seats[next.monarch]?.eliminated) next = { ...next, monarch: null };
  if (next.initiative !== null && next.seats[next.initiative]?.eliminated) next = { ...next, initiative: null };

  const activeSeat = next.seats[next.activeSeat];
  if (next.started && activeSeat !== undefined && activeSeat.eliminated) {
    next = { ...next, activeSeat: nextAliveSeat(next, next.activeSeat) };
  }

  /**
   * Nor can an eliminated seat hold priority (CR 800.4).
   *
   * The case this fixes only exists with more than two players, which is why it survived every
   * two-player game: a seat passes, the combat damage that pass let through eliminates *them*,
   * and `priority` still names them — because it was set while they were alive and the
   * elimination is noticed here, afterwards. With two players the game ends in the same breath
   * and nobody notices. With four it leaves the engine waiting on a player who has left, and the
   * bot cheerfully acting for a dead seat.
   */
  const holder = next.priority === null ? undefined : next.seats[next.priority];
  if (!next.finished && next.priority !== null && holder?.eliminated === true) {
    next = { ...next, priority: nextAliveSeat(next, next.priority) };
  }

  /**
   * And a player who has left the game takes the attacks aimed at them with them (CR 800.4a).
   *
   * Hellrider is what found this, in a four-player pod on turn forty. Its controller declared four
   * attackers at a player on three life; Hellrider's trigger — one damage for each creature that
   * attacked — killed them inside the same action, *after* `advanceStep` had taken the game to
   * declare-blockers and set `priority: null` because a block was owed. With the defender gone the
   * block was no longer owed, so nothing ever handed priority back: four attacks on the table,
   * nobody to declare blockers, nobody holding priority, and `seatsToAct` returning nothing at
   * all. The browser suite saw it as "stopped at Declare blockers on turn 65" with no move on
   * screen to press, and the server's bot loop as a seat it was never asked to move.
   *
   * An attacker whose own controller has left goes too, for the same rule.
   */
  if (next.combat.attacks.length > 0) {
    const live = next.combat.attacks.filter((attack) => {
      if (next.seats[attack.defender]?.eliminated === true) return false;
      const attacker = next.instances[attack.attacker];
      return attacker !== undefined && next.seats[attacker.zoneSeat]?.eliminated !== true;
    });
    if (live.length !== next.combat.attacks.length) {
      next = { ...next, combat: { ...next.combat, attacks: live } };
    }
  }

  /**
   * Somebody holds priority whenever nothing is blocking the game.
   *
   * `resetPriority` withholds it while a question, a discard or a declaration is outstanding, and
   * hands it back when the outstanding thing is *answered* — which is an action, and so runs that
   * code. Nothing runs it when the outstanding thing simply **stops existing**, which is what an
   * elimination does to a block that was owed. So the invariant is restored here instead of at the
   * one call site that happened to break it: priority null with nothing owed is not a state this
   * engine has any legal reading of, and a table in one is a dead table.
   *
   * Untap and cleanup are the two steps where nobody holds priority on purpose (CR 502, CR 514).
   */
  const blockedByAQuestion = next.openingHands || next.pendingDecision !== null
    || next.pendingChoice !== null || next.pendingPayment !== null || next.pendingDiscard !== null
    || next.pendingOfferedCast !== null || next.pendingDredge !== null
    || pendingDeclaration(next) !== null;
  if (
    !next.finished && next.started && next.automated && next.priority === null
    && !blockedByAQuestion && !(NO_PRIORITY_STEPS as readonly string[]).includes(next.step)
  ) {
    next = { ...next, priority: next.activeSeat, passed: [] };
  }

  const alive = aliveSeats(next);
  if (!next.finished && alive.length <= 1) {
    const winner = alive[0];
    /*
      The game ends immediately, and nothing is outstanding when it does (CR 104.1).

      A resolution can be halfway through asking somebody a question when the last opponent dies:
      Magma Jet deals its damage, the engine asks where to put the top of the library, and the
      state-based actions that end the game run in the same action. Leaving the question set
      leaves a prompt on a finished table that nothing will ever answer, and `legalActions`
      refusing priority while a decision is outstanding means the table offers nothing else
      either. Found by a playout: a game that ended on a Magma Jet left its scry standing.
    */
    next = {
      ...next,
      finished: true,
      winnerSeat: winner === undefined ? null : winner.index,
      priority: null,
      passed: [],
      pendingDecision: null,
      pendingChoice: null,
      // A ward outstanding when the game ends is a question with nobody left to answer it.
      pendingPayment: null,
      // And so is a free cast on offer: the cards bound for the bottom of a library stay in exile,
      // which is where a finished game leaves everything else too.
      pendingOfferedCast: null,
      // And a draw nobody is ever going to take, with the dredge that was waiting on it: a
      // finished game owes no cards.
      drawsOwed: [],
      pendingDredge: null,
      pendingDiscard: null,
    };
  }

  return { state: next, eliminations };
}

/** How many consequences one line of the log will carry before it stops listing them. */
const MAX_NOTES = 6;

/**
 * What an action *did*, worked out by comparing the table before and after it.
 *
 * Detected rather than announced, for the same reason triggers are (see `settle`): a consequence
 * that each caller has to remember to mention is a consequence some caller will forget, and the
 * log was the proof of it — a board wipe read "Nick casts Golgari Charm" and nothing else, with
 * four creatures dying silently. Every card written from here on gets this for nothing.
 *
 * Life and death only. Zone changes in general are far too chatty — every draw, every shuffle,
 * every token — and the two things a player scrolling back wants to reconstruct are who took
 * damage and what died.
 */
function consequences(before: GameState, after: GameState): string[] {
  const notes: string[] = [];
  for (const seat of after.seats) {
    const was = before.seats[seat.index];
    if (was === undefined || was.life === seat.life) continue;
    const delta = seat.life - was.life;
    notes.push(`${seat.name} ${delta > 0 ? 'gains' : 'loses'} ${Math.abs(delta)} (${seat.life})`);
  }
  for (const [id, was] of Object.entries(before.instances)) {
    if (was.zone !== 'battlefield') continue;
    const now = after.instances[id];
    // A token that leaves the battlefield ceases to exist, so "gone entirely" is a death too —
    // and is the only way a token's death can be seen at all.
    const zone = now === undefined ? 'graveyard' : now.zone;
    if (zone !== 'graveyard' && zone !== 'exile') continue;
    const name = after.cardDefs[was.defKey]?.name ?? before.cardDefs[was.defKey]?.name ?? 'a permanent';
    notes.push(zone === 'exile' ? `${name} is exiled` : `${name} dies`);
  }
  if (notes.length <= MAX_NOTES) return notes;
  return [...notes.slice(0, MAX_NOTES), `and ${notes.length - MAX_NOTES} more`];
}

function appendLog(state: GameState, entry: Omit<LogEntry, 'version' | 'turn'>): GameState {
  const full: LogEntry = { version: state.stateVersion, turn: state.turn, ...entry };
  const log = state.log.length >= MAX_LOG_ENTRIES
    ? [...state.log.slice(state.log.length - MAX_LOG_ENTRIES + 1), full]
    : [...state.log, full];
  return { ...state, log };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reduce(state: GameState, action: Action, ctx: ActionContext): Outcome {
  switch (action.type) {
    case 'life:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const life = clampValue(seat.life + action.delta);
      return {
        state: replaceSeat(state, action.seat, { life }),
        message: `${seatName(state, action.seat)} life ${seat.life} -> ${life}`,
        data: { seat: action.seat, delta: action.delta, life },
      };
    }

    case 'poison:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const poison = Math.max(0, clampValue(seat.poison + action.delta));
      return {
        state: replaceSeat(state, action.seat, { poison }),
        message: `${seatName(state, action.seat)} poison ${seat.poison} -> ${poison}`,
        data: { seat: action.seat, delta: action.delta, poison },
      };
    }

    case 'commanderDamage:adjust': {
      if (!FORMATS[state.format].commanderDamageRule) {
        throw new EngineError('RULE_NOT_APPLICABLE', `commander damage is not tracked in ${state.format}`);
      }
      assertSeatIndex(state, action.seat);
      assertSeatIndex(state, action.fromSeat, 'fromSeat');
      assertDelta(action.delta);
      if (action.seat === action.fromSeat) {
        throw new EngineError('INVALID_SEAT', 'a commander cannot deal commander damage to its own seat');
      }
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const key = String(action.fromSeat);
      const prev = seat.commanderDamage[key] ?? 0;
      const value = Math.max(0, clampValue(prev + action.delta));
      const commanderDamage = { ...seat.commanderDamage, [key]: value };
      return {
        state: replaceSeat(state, action.seat, { commanderDamage }),
        message: `${seatName(state, action.seat)} commander damage from ${seatName(state, action.fromSeat)} ${prev} -> ${value}`,
        data: { seat: action.seat, fromSeat: action.fromSeat, delta: action.delta, value },
      };
    }

    case 'counter:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      if (
        typeof action.key !== 'string' ||
        action.key.length === 0 ||
        action.key.length > MAX_COUNTER_KEY_LENGTH ||
        !/^[a-z0-9_-]+$/i.test(action.key)
      ) {
        throw new EngineError('INVALID_ACTION', 'counter key must be 1-32 alphanumeric characters');
      }
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const prev = seat.counters[action.key] ?? 0;
      const value = Math.max(0, clampValue(prev + action.delta));
      const counters: Record<string, number> = { ...seat.counters };
      if (value === 0) {
        delete counters[action.key];
      } else {
        counters[action.key] = value;
      }
      return {
        state: replaceSeat(state, action.seat, { counters }),
        message: `${seatName(state, action.seat)} ${action.key} ${prev} -> ${value}`,
        data: { seat: action.seat, key: action.key, delta: action.delta, value },
      };
    }

    case 'commanderTax:adjust': {
      assertSeatIndex(state, action.seat);
      assertDelta(action.delta);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      const seat = state.seats[action.seat]!;
      const commanderTax = Math.max(0, clampValue(seat.commanderTax + action.delta));
      return {
        state: replaceSeat(state, action.seat, { commanderTax }),
        message: `${seatName(state, action.seat)} commander tax ${seat.commanderTax} -> ${commanderTax}`,
        data: { seat: action.seat, delta: action.delta, commanderTax },
      };
    }

    case 'monarch:set': {
      /*
        The engine owns the crown once it is running (CR 720).

        A designation the rules move cannot also be a thing a player sets by hand, or the two
        disagree and the table shows a crown the engine does not believe in. Refused here rather
        than only hidden in the UI — which is what the commander-damage counters do — because this
        one the rules actually change, and a client that offered it would be offering a move the
        engine is about to overwrite. On a tabletop it stays exactly what it was: a thing somebody
        presses, because nothing else is enforced there either.
      */
      if (state.automated) {
        throw new EngineError('RULE_NOT_APPLICABLE', 'the engine moves the crown while it is running');
      }
      if (action.seat === null) {
        // Only the current monarch (or host) may clear the crown.
        if (state.monarch !== null) assertMayActFor(action, state.monarch, ctx);
        return { state: { ...state, monarch: null }, message: 'monarch cleared', data: { seat: null } };
      }
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      return {
        state: { ...state, monarch: action.seat },
        message: `${seatName(state, action.seat)} is the monarch`,
        data: { seat: action.seat },
      };
    }

    /*
      Offering a deal, and answering one. See `GameState.pacts`.

      Deliberately available on a manual tabletop as well as an automated table: a pact is a thing
      two players say to each other, not a rule the engine runs, so nothing about it needs the
      engine to be driving the game. The only authority anywhere in here is who may answer — the
      seat it was offered to, and nobody else, not even the host, because an agreement somebody
      else can accept on your behalf is not an agreement.
    */
    case 'pact:offer': {
      assertSeatIndex(state, action.seat);
      // The offering seat is whoever sent it, never a seat named in the action: a deal offered on
      // somebody else's behalf is not their deal. `action.by` is already a validated seat index.
      const from = action.by;
      if (from === action.seat) throw new EngineError('RULE_NOT_APPLICABLE', 'you cannot make a deal with yourself');
      if (!PACT_KINDS.includes(action.kind)) throw new EngineError('INVALID_ACTION', 'that is not a deal this table offers');
      assertNotEliminated(state, from);
      assertNotEliminated(state, action.seat);
      // One live offer at a time between the same two seats, in the same direction: a table spammed
      // with offers is a table nobody reads.
      if (state.pacts.some((p) => p.status === 'offered' && p.from === from && p.to === action.seat)) {
        throw new EngineError('RULE_NOT_APPLICABLE', 'you already have an offer out to that player');
      }
      const pact: Pact = {
        id: `pact${state.stateVersion + 1}`,
        from,
        to: action.seat,
        kind: action.kind,
        offeredTurn: state.turn,
        status: 'offered',
        throughTurn: null,
      };
      return {
        state: { ...state, pacts: appendPact(state, pact) },
        message: `${seatName(state, from)} offers a deal: ${pactLine(state, from, action.seat, action.kind)}`,
        data: { pact: pact.id, from, to: action.seat, kind: action.kind },
      };
    }

    case 'pact:respond': {
      const pact = state.pacts.find((p) => p.id === action.pact);
      if (pact === undefined || pact.status !== 'offered') {
        throw new EngineError('RULE_NOT_APPLICABLE', 'that deal is no longer on the table');
      }
      /*
        Only the seat it was offered to — deliberately not `assertMayActFor`, which lets the host
        act for anybody. The host runs the table; they do not get to give somebody else's word.
        This is the one action in the engine with no host override, and the reason is the whole
        point of pacts: an agreement a third party can accept for you is not an agreement.
      */
      if (action.by !== pact.to) {
        throw new EngineError('FORBIDDEN', 'only the player a deal was offered to may answer it');
      }
      if (typeof action.accept !== 'boolean') {
        throw new EngineError('INVALID_ACTION', 'accept must be true or false');
      }
      const answered: Pact = action.accept
        ? { ...pact, status: 'accepted', throughTurn: pactThrough(state, pact) }
        : { ...pact, status: 'declined' };
      return {
        state: { ...state, pacts: state.pacts.map((p) => (p.id === pact.id ? answered : p)) },
        message: `${seatName(state, pact.to)} ${action.accept ? 'agrees' : 'declines'}: ${
          pactLine(state, pact.from, pact.to, pact.kind)}`,
        data: { pact: pact.id, accept: action.accept },
      };
    }

    case 'initiative:set': {
      if (action.seat === null) {
        if (state.initiative !== null) assertMayActFor(action, state.initiative, ctx);
        return { state: { ...state, initiative: null }, message: 'initiative cleared', data: { seat: null } };
      }
      assertSeatIndex(state, action.seat);
      assertMayActFor(action, action.seat, ctx);
      assertNotEliminated(state, action.seat);
      return {
        state: { ...state, initiative: action.seat },
        message: `${seatName(state, action.seat)} takes the initiative`,
        data: { seat: action.seat },
      };
    }

    case 'turn:pass': {
      if (!state.started) throw new EngineError('NOT_STARTED', 'the game has not started');
      if (action.by !== state.activeSeat && ctx.isHost !== true) {
        throw new EngineError('NOT_ACTIVE_SEAT', `seat ${action.by} is not the active seat`);
      }
      const next = nextAliveSeat(state, state.activeSeat);
      return {
        state: { ...state, activeSeat: next, turn: state.turn + 1 },
        message: `turn passes to ${seatName(state, next)}`,
        data: { from: state.activeSeat, to: next, turn: state.turn + 1 },
      };
    }

    case 'dice:roll': {
      assertIntegerInRange(action.sides, MIN_DICE_SIDES, MAX_DICE_SIDES, 'sides');
      assertIntegerInRange(action.count, MIN_DICE_COUNT, MAX_DICE_COUNT, 'count');
      const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion));
      const results: number[] = [];
      for (let i = 0; i < action.count; i++) {
        results.push(Math.floor(rng() * action.sides) + 1);
      }
      const total = results.reduce((a, b) => a + b, 0);
      return {
        state,
        message: `${seatName(state, action.by)} rolled ${action.count}d${action.sides}: ${results.join(', ')} (total ${total})`,
        data: { sides: action.sides, count: action.count, results, total },
      };
    }

    case 'coin:flip': {
      const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion));
      const result = rng() < 0.5 ? 'heads' : 'tails';
      return {
        state,
        message: `${seatName(state, action.by)} flipped a coin: ${result}`,
        data: { result },
      };
    }

    case 'concede': {
      const target = action.seat === undefined ? action.by : action.seat;
      assertSeatIndex(state, target);
      assertMayActFor(action, target, ctx);
      assertNotEliminated(state, target);
      return {
        state: replaceSeat(state, target, { eliminated: true, eliminatedReason: 'concede' }),
        message: `${seatName(state, target)} conceded`,
        data: { seat: target },
      };
    }

    case 'game:start': {
      if (state.started) throw new EngineError('ALREADY_STARTED', 'the game has already started');
      assertSeatIndex(state, action.by, 'by');
      const first = action.firstSeat === undefined ? 0 : action.firstSeat;
      assertSeatIndex(state, first, 'firstSeat');
      assertNotEliminated(state, first);
      const started: GameState = { ...state, started: true, turn: 1, activeSeat: first };
      // Deal opening hands only to seats that loaded a deck. A table used purely as a life tracker
      // has no libraries, so it starts exactly as it did before the card layer existed.
      const dealt = dealOpeningHands(started);
      return {
        state: dealt.state,
        message: dealt.dealt > 0
          ? `game started; ${seatName(state, first)} goes first; ${dealt.dealt} opening hand(s) drawn`
          : `game started; ${seatName(state, first)} goes first`,
        data: { firstSeat: first, handsDealt: dealt.dealt },
      };
    }

    case 'game:reset': {
      assertHost(action, ctx);
      const def = FORMATS[state.format];
      const fresh: GameState = {
        ...state,
        seats: state.seats.map((s) => makeSeat(s.index, s.playerId, s.name, def.startingLife)),
        turn: 0,
        activeSeat: 0,
        monarch: null,
        initiative: null,
        // A new game is a new table: last game's deals are not this game's.
        pacts: [],
        started: false,
        finished: false,
        winnerSeat: null,
        rngSeed: deriveNextSeed(state.rngSeed),
        // Without clearing these, a reset would leave the previous game's board on the table.
        cardDefs: {},
        instances: {},
        zones: {},
        instanceSeq: 0,
        // Back to the manual tabletop: an automated table reset mid-game would otherwise be left
        // with no active step and no way to hand priority to anyone, and `auto:start` refuses to
        // run twice, so nobody could restart it.
        automated: false,
        autoPassOff: [],
        dredgeStops: {},
        kept: [],
        openingHands: false,
        pendingChoice: null,
        pendingPayment: null,
        pendingOfferedCast: null,
        drawsOwed: [],
        pendingDredge: null,
        spellsCastThisTurn: 0,
        lifeLostThisTurn: {},
        cardsDrawnThisTurn: {},
        pendingDecision: null,
        died: [],
        left: [],
        vanished: {},
        replacements: [],
        entered: [],
        dealtCombatDamage: [],
        drew: [],
        toGraveyard: [],
        exiled: [],
        copied: [],
        transformed: [],
        expired: [],
        discarded: [],
        delayed: [],
        step: 'precombat-main',
        priority: null,
        passed: [],
        stackObjects: {},
        stackOrder: [],
        pools: {},
        combat: EMPTY_COMBAT,
        effects: [],
        landsPlayed: {},
        extraLands: {},
        autoSeq: 0,
        drewFromEmpty: [],
        pendingDiscard: null,
      };
      return { state: fresh, message: 'game reset', data: { rngSeed: fresh.rngSeed } };
    }

    // Card actions and automated actions each have their own reducer, and each keeps a real
    // exhaustiveness check over its own half because the narrowing happens here.
    default: {
      if (isAutoAction(action)) return reduceAutoAction(state, action, ctx);
      if (isCardAction(action)) return reduceCardAction(state, action, ctx);
      throw new EngineError('INVALID_ACTION', `unknown action type: ${String((action as { type?: unknown }).type)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies one action and returns the resulting state. The input state is never
 * mutated. Throws an EngineError when the action is invalid or not permitted.
 */
export function applyAction(state: GameState, action: Action, ctx: ActionContext = {}): GameState {
  if (typeof action !== 'object' || action === null || typeof action.type !== 'string') {
    throw new EngineError('INVALID_ACTION', 'action must be an object with a type');
  }
  assertSeatIndex(state, action.by, 'by');
  if (state.finished && action.type !== 'game:reset' && action.type !== 'game:rematch') {
    throw new EngineError('GAME_FINISHED', 'the game is finished');
  }
  // A rematch is a *sequence* of actions rather than a rule, so it is composed here out of the
  // reducers that already enforce each step. See `rematch`.
  if (action.type === 'game:rematch') return rematch(state, action, ctx);

  const outcome = reduce(state, action, ctx);
  const isReset = action.type === 'game:reset';
  const resolved = isReset
    ? { state: outcome.state, eliminations: [] as Elimination[] }
    : resolveStateBasedActions(outcome.state);

  let next: GameState = { ...resolved.state, stateVersion: state.stateVersion + 1 };

  const data: Record<string, unknown> = { ...(outcome.data ?? {}) };
  let message = outcome.message;
  // What the action actually did to the board, read off the difference rather than reported by
  // whatever caused it.
  const notes = isReset ? [] : consequences(state, next);
  if (notes.length > 0) message += `; ${notes.join(', ')}`;
  /*
    And the clocks that ran out, which go into the **log** rather than into `raise`.

    This is the one member of the detect-rather-than-announce family whose consumer is the record
    rather than a card — see `GameState.expired` for why it is not an event. Drained here because
    `applyAction` is the one place that writes a log entry for an action, so the fact lands in the
    same entry as everything else the action did, and the list never outlives it.

    Placed with the other consequences and ahead of the eliminations and the win, because a clock
    running out is a thing that happened to the board and those two are what the board then came
    to — a line reading "Nick wins; Blastoderm's last fade counter is gone" has them backwards.
  */
  const ranOut = next.expired ?? [];
  if (ranOut.length > 0) {
    data['expired'] = ranOut.map((e) => ({ ...e }));
    message += `; ${ranOut
      .map((e) => `${e.name}'s last ${e.counter} counter is gone`)
      .join(', ')}`;
    next = { ...next, expired: [] };
  }
  if (resolved.eliminations.length > 0) {
    data['eliminations'] = resolved.eliminations;
    message += '; ' + resolved.eliminations
      .map((e) => `${seatName(next, e.seat)} eliminated (${e.reason})`)
      .join(', ');
  }
  if (next.finished && !state.finished) {
    data['winnerSeat'] = next.winnerSeat;
    message += next.winnerSeat === null
      ? '; game over with no winner'
      : `; ${seatName(next, next.winnerSeat)} wins`;
  }


  next = appendLog(next, { by: action.by, type: action.type, message, data });
  return next;
}

/**
 * Another game at the same table: same seats, same decks, engine still running.
 *
 * Composed out of the actions a player would otherwise have to take by hand — reset, load each
 * deck, start, switch the engine back on — rather than written as a new rule, because every one of
 * those steps already has a reducer that enforces it. A card-legality check or a deck that no
 * longer resolves fails the rematch exactly as it would fail the manual version, and the log reads
 * the same as if a person had done it, which is what a player comparing the two would expect.
 *
 * Three decisions worth naming:
 *
 *  - **Any seated player may ask, and only once the game is over.** A rematch out of a live game
 *    is a reset, and that stays the host's; "again" after a finished game is nobody's privilege.
 *  - **The previous winner goes second.** The table convention everywhere, and the engine knows
 *    who won, so there is no reason to make anybody choose.
 *  - **The steps are taken on the table's behalf.** The permission question is answered once, at
 *    the top, so the sub-actions run as the host — otherwise `deck:load` for the *other* seat
 *    would refuse, and a rematch that only worked for the player who created the table would be a
 *    worse feature than no rematch.
 */
function rematch(state: GameState, action: Action, ctx: ActionContext): GameState {
  if (!state.finished) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'a rematch starts another game once this one is over');
  }
  assertSeatIndex(state, action.by, 'by');
  const decks = state.seats.map((seat) => seat.deckId);
  const automated = state.automated;
  // Each player's stops setting is theirs and survives the rematch, which is part of why it is a
  // list: carrying one boolean would quietly hand one player's preference to the other.
  const stopsOff = [...(state.autoPassOff ?? [])];
  // The winner plays second. With no winner — a draw, or a game nobody finished — the seat that
  // went first goes first again, since there is nothing to take turns about.
  const seats = state.seats.length;
  const first = state.winnerSeat === null
    ? state.activeSeat
    : (((state.winnerSeat + 1) % seats) as SeatIndex);

  const asTable: ActionContext = { ...ctx, isHost: true };
  let next = applyAction(state, { type: 'game:reset', by: action.by }, asTable);
  decks.forEach((deckId, seat) => {
    if (deckId === null) return;
    next = applyAction(next, { type: 'deck:load', by: action.by, seat: seat as SeatIndex, deckId }, asTable);
  });
  next = applyAction(next, { type: 'game:start', by: action.by, firstSeat: first }, asTable);
  if (automated) {
    next = applyAction(next, { type: 'auto:start', by: action.by, firstSeat: first }, asTable);
    for (const seat of stopsOff) {
      next = applyAction(next, { type: 'auto:stops', by: seat, autoPass: false }, asTable);
    }
  }
  return appendLog(next, {
    by: action.by,
    type: 'game:rematch',
    message: `${seatName(next, action.by)} starts another game${
      state.winnerSeat === null ? '' : `; ${seatName(next, first)} goes first`}`,
    data: { firstSeat: first, decks: decks.filter((d) => d !== null).length, automated },
  });
}

/** Applies a sequence of actions in order; useful for deterministic replay. */
export function applyMany(
  state: GameState,
  actions: readonly (Action | { action: Action; ctx?: ActionContext })[],
  ctx: ActionContext = {},
): GameState {
  let current = state;
  for (const item of actions) {
    if ('action' in item) {
      current = applyAction(current, item.action, item.ctx ?? ctx);
    } else {
      current = applyAction(current, item, ctx);
    }
  }
  return current;
}

/** Convenience: the most recent log entry, if any. */
export function lastLogEntry(state: GameState): LogEntry | undefined {
  return state.log[state.log.length - 1];
}
