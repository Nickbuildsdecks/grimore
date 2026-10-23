/**
 * The shapes the automated engine adds to the game state: steps, priority, the stack, combat.
 *
 * Kept in their own module rather than bolted onto `types.ts` because they are the vocabulary of a
 * different layer. The tabletop needs none of them — two people passing priority verbally is the
 * whole of its turn structure — and a table running in manual mode leaves every one of these at its
 * empty value.
 */
import type { ContinuousEffect } from './characteristics.js';
import type { ManaPool } from './mana.js';
import type { SeatIndex } from './types.js';

/**
 * Every step of a turn, in order. Phases that contain no steps (the main phases) appear once.
 *
 * `first-strike-damage` is a real step that only exists when a creature in combat has first or
 * double strike (CR 510.4); modelling it as an always-present step that is skipped when empty is
 * simpler than conditionally inserting one, and produces the same sequence.
 */
export const STEPS = [
  'untap',
  'upkeep',
  'draw',
  'precombat-main',
  'begin-combat',
  'declare-attackers',
  'declare-blockers',
  'first-strike-damage',
  'combat-damage',
  'end-combat',
  'postcombat-main',
  'end',
  'cleanup',
] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Readonly<Record<Step, string>> = Object.freeze({
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  'precombat-main': 'Main phase 1',
  'begin-combat': 'Beginning of combat',
  'declare-attackers': 'Declare attackers',
  'declare-blockers': 'Declare blockers',
  'first-strike-damage': 'First strike damage',
  'combat-damage': 'Combat damage',
  'end-combat': 'End of combat',
  'postcombat-main': 'Main phase 2',
  end: 'End step',
  cleanup: 'Cleanup',
});

/** Steps in which a player may cast a sorcery-speed spell (their own main phase, empty stack). */
export const MAIN_STEPS: readonly Step[] = Object.freeze(['precombat-main', 'postcombat-main']);
export const COMBAT_STEPS: readonly Step[] = Object.freeze([
  'begin-combat', 'declare-attackers', 'declare-blockers', 'first-strike-damage', 'combat-damage', 'end-combat',
]);
/** Steps in which nobody receives priority (CR 502.1, 514.1). */
export const NO_PRIORITY_STEPS: readonly Step[] = Object.freeze(['untap', 'cleanup']);

export type Target =
  | { readonly kind: 'card'; readonly id: string }
  | { readonly kind: 'player'; readonly seat: SeatIndex };

export const targetKey = (t: Target): string => (t.kind === 'card' ? `card:${t.id}` : `player:${t.seat}`);

/**
 * Something waiting to resolve.
 *
 * A spell's id is its card instance id, so the card physically sits in the stack zone and the
 * object describes how it was cast. An ability has no card, so it gets a synthetic id — which is
 * why the stack zone and this map are separate: an ability on the stack has no card to put there.
 */
export interface StackObject {
  readonly id: string;
  readonly kind: 'spell' | 'activated' | 'triggered';
  /** Instance the spell is, or the permanent the ability came from. */
  readonly source: string;
  readonly controller: SeatIndex;
  readonly cardKey: string;
  /** Which of the source's abilities, for activated and triggered objects. */
  readonly abilityIndex?: number;
  readonly targets: readonly Target[];
  readonly x?: number;
  /** What to show in the stack, written when the object was put there. */
  readonly description: string;
}

export interface CombatAttack {
  readonly attacker: string;
  readonly defender: SeatIndex;
  /** In damage-assignment order, which is the order the attacker's controller chose. */
  readonly blockers: readonly string[];
}

export interface CombatState {
  readonly attacks: readonly CombatAttack[];
  /** Set once the first-strike damage step has happened, so it does not happen twice. */
  readonly firstStrikeDealt: boolean;
  /**
   * Whether the attacking player has finished declaring. Needed as its own flag because "attacked
   * with nothing" and "has not declared yet" both leave `attacks` empty, and the first must end the
   * step while the second must block it.
   */
  readonly attackersDeclared: boolean;
  /** Defending seats that have finished declaring blockers, for the same reason. */
  readonly blockersDeclaredBy: readonly SeatIndex[];
}

export const EMPTY_COMBAT: CombatState = Object.freeze({
  attacks: [], firstStrikeDealt: false, attackersDeclared: false, blockersDeclaredBy: [],
});

/** The automation half of the game state. Absent values mean a table in manual mode. */
export interface AutomationState {
  /** True when the engine runs the rules. False is the manual tabletop. */
  readonly automated: boolean;
  /**
   * Whether the engine passes priority for a player whose only legal move is to pass.
   *
   * On by default, because without it a real game asks each player twenty-five times a turn to
   * confirm they still cannot do anything. A player who wants to be offered every priority —
   * to bluff, or to watch each step go by — turns it off.
   */
  readonly autoPass: boolean;
  readonly step: Step;
  /** Seat holding priority, or null in a step where nobody gets it. */
  readonly priority: SeatIndex | null;
  /** Seats that have passed since the last time something happened. */
  readonly passed: readonly SeatIndex[];
  readonly stackObjects: Readonly<Record<string, StackObject>>;
  /** Stack order, bottom first — the last id is the one that resolves next. */
  readonly stackOrder: readonly string[];
  /** Mana pools, keyed by seat index as a string so the state stays JSON-safe. */
  readonly pools: Readonly<Record<string, ManaPool>>;
  readonly combat: CombatState;
  readonly effects: readonly ContinuousEffect[];
  /** Lands played this turn per seat, for the one-per-turn rule. */
  readonly landsPlayed: Readonly<Record<string, number>>;
  /** Source of synthetic ids for ability stack objects and effects. */
  readonly autoSeq: number;
  /** Set when a player has lost by trying to draw from an empty library (CR 704.5b). */
  readonly drewFromEmpty: readonly SeatIndex[];
  /**
   * A cleanup-step discard that is blocking the turn from ending. Hand size is a real decision a
   * player has to make, so the engine stops and waits rather than discarding for them.
   */
  readonly pendingDiscard: { readonly seat: SeatIndex; readonly count: number } | null;
  /**
   * Seats that have settled on their opening hand.
   *
   * A London mulligan draws a fresh seven and owes one card to the bottom of the library for each
   * mulligan taken (CR 103.4c). The redraw is a physical move the tabletop already makes; what
   * needs tracking is the debt, because a player who mulliganed twice and started with seven cards
   * has not mulliganed at all. `auto:start` refuses while anybody still owes.
   */
  readonly kept: readonly SeatIndex[];
  /**
   * True between the engine taking over and the first turn beginning, while opening hands are
   * settled. Nobody holds priority and no step has started.
   */
  readonly openingHands: boolean;
  /**
   * A triggered ability on the stack that still needs its targets chosen.
   *
   * Targets for a trigger are chosen as it is put on the stack (CR 603.3d), by its controller —
   * which is a decision, and the engine will not make it. Nothing else happens until it is
   * answered: no priority, no resolution, no step change. The same shape as `pendingDiscard`, for
   * the same reason.
   */
  readonly pendingChoice: {
    readonly seat: SeatIndex;
    /** The stack object the targets belong to. */
    readonly stackId: string;
    /** What is being asked for, in words. */
    readonly description: string;
    /** How many targets are still to choose, in order. */
    readonly remaining: number;
  } | null;
  /**
   * A resolution that has stopped to ask somebody a question.
   *
   * Targets are chosen before a spell is on the stack; *this* is the other kind of decision — the
   * one a card asks for while it is resolving, and the one that kept tutors, "choose one" and an
   * opponent's own-choice discard off the scripted list entirely. Searching a library for a card is
   * not a target: it is not chosen when the spell is cast, it cannot be responded to, and the cards
   * it chooses between are in a hidden zone.
   *
   * The spell stays **on the stack** while this is outstanding, so both tables still show what is
   * resolving, and nothing else happens until it is answered: no priority, no further resolution,
   * no step change. `resume` is what the engine needs to pick the resolution back up — the answers
   * so far and which question is next — and it is part of the state rather than a closure because
   * the state is serialised to Redis between one action and the next.
   */
  readonly pendingDecision: {
    /** Who answers. Not always the controller: a discard is chosen by the player discarding. */
    readonly seat: SeatIndex;
    /** The stack object that is resolving. */
    readonly stackId: string;
    readonly prompt: string;
    /** Instance ids that may be chosen, computed when the question is asked. */
    readonly candidates: readonly string[];
    readonly min: number;
    readonly max: number;
    /** Where they are being chosen from, which is what the table needs to draw the picker. */
    readonly from: DecisionZone;
    readonly resume: {
      /** Every question this resolution asks, in order: a spec index and who answers it. */
      readonly plan: readonly { readonly seat: SeatIndex; readonly specIndex: number }[];
      /** Which question in the plan is outstanding. */
      readonly at: number;
      readonly answers: readonly DecisionAnswer[];
    };
  } | null;
}

/** Where a mid-resolution decision chooses its cards from. */
export type DecisionZone = 'library' | 'hand' | 'graveyard' | 'battlefield';

/** One answered decision, in the order the card asked. */
export interface DecisionAnswer {
  readonly seat: SeatIndex;
  readonly ids: readonly string[];
}

// ── Automated actions ────────────────────────────────────────────────────────────────────────────
export interface AutoStartAction {
  readonly type: 'auto:start'; readonly by: SeatIndex; readonly firstSeat?: SeatIndex;
  /** Defaults to true. See `AutomationState.autoPass`. */
  readonly autoPass?: boolean;
}
/** Turns auto-passing on or off mid-game, which is a table setting rather than a game rule. */
export interface AutoStopsAction { readonly type: 'auto:stops'; readonly by: SeatIndex; readonly autoPass: boolean }
export interface AutoPlayLandAction { readonly type: 'auto:playLand'; readonly by: SeatIndex; readonly card: string }
export interface AutoCastAction {
  readonly type: 'auto:cast'; readonly by: SeatIndex; readonly card: string;
  readonly targets?: readonly Target[]; readonly x?: number;
}
export interface AutoActivateAction {
  readonly type: 'auto:activate'; readonly by: SeatIndex; readonly card: string;
  readonly abilityIndex: number; readonly targets?: readonly Target[];
  /** The creature sacrificed to pay for it, when the ability's cost asks for one. */
  readonly sacrifice?: string;
}
export interface AutoPassAction { readonly type: 'auto:pass'; readonly by: SeatIndex }
export interface AutoAttackAction {
  readonly type: 'auto:attack'; readonly by: SeatIndex;
  readonly attackers: readonly { readonly attacker: string; readonly defender: SeatIndex }[];
}
export interface AutoBlockAction {
  readonly type: 'auto:block'; readonly by: SeatIndex;
  readonly blocks: readonly { readonly blocker: string; readonly attacker: string }[];
}
export interface AutoDiscardAction { readonly type: 'auto:discard'; readonly by: SeatIndex; readonly card: string }
/** Answers a triggered ability's request for targets. */
export interface AutoChooseAction {
  readonly type: 'auto:choose'; readonly by: SeatIndex; readonly targets: readonly Target[];
}
/** Answers a question a card asked while it was resolving. */
export interface AutoDecideAction {
  readonly type: 'auto:decide'; readonly by: SeatIndex; readonly cards: readonly string[];
}
/** Settles on an opening hand, putting back one card for each mulligan taken. */
export interface AutoKeepAction {
  readonly type: 'auto:keep'; readonly by: SeatIndex;
  /** Cards to put on the bottom of the library, exactly as many as are owed. */
  readonly bottom?: readonly string[];
}

export type AutoAction =
  | AutoStartAction | AutoPlayLandAction | AutoCastAction | AutoActivateAction
  | AutoPassAction | AutoAttackAction | AutoBlockAction | AutoDiscardAction | AutoStopsAction
  | AutoKeepAction | AutoChooseAction | AutoDecideAction;

export const AUTO_ACTION_TYPES: readonly AutoAction['type'][] = Object.freeze([
  'auto:start', 'auto:playLand', 'auto:cast', 'auto:activate', 'auto:pass', 'auto:attack',
  'auto:block', 'auto:discard', 'auto:stops', 'auto:keep', 'auto:choose', 'auto:decide',
]);

export const isAutoAction = (action: { type: string }): action is AutoAction =>
  (AUTO_ACTION_TYPES as readonly string[]).includes(action.type);

