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
}

// ── Automated actions ────────────────────────────────────────────────────────────────────────────
export interface AutoStartAction { readonly type: 'auto:start'; readonly by: SeatIndex; readonly firstSeat?: SeatIndex }
export interface AutoPlayLandAction { readonly type: 'auto:playLand'; readonly by: SeatIndex; readonly card: string }
export interface AutoCastAction {
  readonly type: 'auto:cast'; readonly by: SeatIndex; readonly card: string;
  readonly targets?: readonly Target[]; readonly x?: number;
}
export interface AutoActivateAction {
  readonly type: 'auto:activate'; readonly by: SeatIndex; readonly card: string;
  readonly abilityIndex: number; readonly targets?: readonly Target[];
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

export type AutoAction =
  | AutoStartAction | AutoPlayLandAction | AutoCastAction | AutoActivateAction
  | AutoPassAction | AutoAttackAction | AutoBlockAction | AutoDiscardAction;

export const AUTO_ACTION_TYPES: readonly AutoAction['type'][] = Object.freeze([
  'auto:start', 'auto:playLand', 'auto:cast', 'auto:activate', 'auto:pass', 'auto:attack',
  'auto:block', 'auto:discard',
]);

export const isAutoAction = (action: { type: string }): action is AutoAction =>
  (AUTO_ACTION_TYPES as readonly string[]).includes(action.type);

