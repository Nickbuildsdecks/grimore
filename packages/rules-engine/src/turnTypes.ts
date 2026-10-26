/**
 * The shapes the automated engine adds to the game state: steps, priority, the stack, combat.
 *
 * Kept in their own module rather than bolted onto `types.ts` because they are the vocabulary of a
 * different layer. The tabletop needs none of them — two people passing priority verbally is the
 * whole of its turn structure — and a table running in manual mode leaves every one of these at its
 * empty value.
 */
import type { CardInstance } from './cards.js';
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

/**
 * One scheduled delayed trigger (CR 603.7).
 *
 * It names a trigger the card already has — `abilityIndex` into `CardScript.triggers`, marked
 * `delayed` there so the ordinary event path never fires it — plus everything the ability will
 * need when it does fire, because by then the board may say none of it: which permanent it was
 * about, who controls it, and what to call it in the log.
 */
export interface DelayedTrigger {
  readonly id: string;
  /** The card whose script holds the ability. May have left the battlefield by now. */
  readonly source: string;
  readonly controller: SeatIndex;
  /** Index into that card's `triggers`. */
  readonly abilityIndex: number;
  /** The step it fires at the beginning of. */
  readonly step: Step;
  /**
   * Whose turn's step. `you` is the controller's own next one — "at the beginning of **your** next
   * end step" — and `any` is the next occurrence whoever's turn it is, which is what "at end of
   * combat" means: the combat is happening on somebody else's turn as often as not.
   */
  readonly of: 'you' | 'any';
  /** The permanent the ability is about, for "that creature". See `StackObject.subject`. */
  readonly subject?: string;
  readonly description: string;
  /**
   * The turn it was scheduled on, so "the **next** end step" cannot be the one already in
   * progress. A delayed trigger created during an end step waits for the following turn's
   * (CR 603.7b).
   */
  readonly createdTurn: number;
  /** The step it was scheduled in, for the same reason. */
  readonly createdStep: Step;
}

/** Steps in which a player may cast a sorcery-speed spell (their own main phase, empty stack). */
export const MAIN_STEPS: readonly Step[] = Object.freeze(['precombat-main', 'postcombat-main']);
export const COMBAT_STEPS: readonly Step[] = Object.freeze([
  'begin-combat', 'declare-attackers', 'declare-blockers', 'first-strike-damage', 'combat-damage', 'end-combat',
]);
/** Steps in which nobody receives priority (CR 502.1, 514.1). */
export const NO_PRIORITY_STEPS: readonly Step[] = Object.freeze(['untap', 'cleanup']);

/**
 * Something a spell or ability can be pointed at.
 *
 * Three shapes, and the third one is the odd one. A **card** covers a permanent on the battlefield,
 * a card in a graveyard, and a spell on the stack — a spell *is* a card, which is why "counter
 * target spell" needed nothing of its own. A **player** is a seat.
 *
 * An **ability** on the stack is neither. It has no card anywhere: `pushAbility` gives it a
 * synthetic `ab<n>` id and the object in `stackObjects` is all there is of it, which is exactly why
 * it needs its own kind rather than borrowing `card`. Everything that reads a target has to answer
 * for it honestly, and the answers are mostly "nothing":
 *
 * - it is in no zone, so the zone checks do not apply and "still on the stack" is the whole of its
 *   legality;
 * - it has no `objectSeq`, so it cannot be a *different object* the way a bounced creature is
 *   (CR 400.7) — it either is still there or it is gone;
 * - it has no permanent to carry hexproof, shroud, protection or ward, so none of those touch it;
 * - and it ceases to exist the moment it resolves, which is what makes "counter target ability" a
 *   card you have to hold rather than a card you cast on your own turn.
 */
export type Target =
  | { readonly kind: 'card'; readonly id: string }
  | { readonly kind: 'player'; readonly seat: SeatIndex }
  | { readonly kind: 'ability'; readonly id: string };

export const targetKey = (t: Target): string => {
  switch (t.kind) {
    case 'card': return `card:${t.id}`;
    case 'ability': return `ability:${t.id}`;
    default: return `player:${t.seat}`;
  }
};

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
  /**
   * The stack object this triggered ability is *about*, for a trigger that watched something
   * happen to an object rather than to a player or a permanent.
   *
   * Ward is the only thing that needs it and needs it absolutely: "counter it unless that player
   * pays" has no referent at all without knowing which `it`, and by the time the ward ability
   * resolves the spell is one of several on the stack. It travels on the object for exactly the
   * reason `attacked` does — the event is gone by the time anything reads it.
   */
  readonly answering?: string;
  /**
   * Which **object** each card target was when it was chosen, by instance id (CR 400.7).
   *
   * A separate map rather than a field on `Target` so that nothing downstream — the wire, the
   * table, the bot — has to know this exists: a target is still `{kind, id}` everywhere it is
   * read. The one reader is the fizzle check in `resolveTop`, which treats a card that has since
   * changed zones as gone, so a creature exiled and returned is not the creature the removal was
   * aimed at. See `CardInstance.objectSeq`.
   */
  /**
   * The counters the permanent this ability is about had **before** the event (CR 608.2h).
   *
   * Carried on the object because the board cannot answer it any more: `relocate` wipes a
   * permanent's counters as it leaves the battlefield, so by the time a death trigger resolves
   * there is nothing left to count. A Hangarback Walker makes one Thopter per +1/+1 counter it
   * *had*, which is the only thing in this pool that asks — and the reason this is a counters map
   * rather than a whole snapshot of the instance.
   */
  readonly subjectCounters?: Readonly<Record<string, number>>;
  readonly targetSeqs?: Readonly<Record<string, number>>;
  readonly x?: number;
  /**
   * How much of a divided quantity each of `targets` was assigned, position by position
   * (CR 601.2d). Absent on everything that divides nothing, which is almost everything.
   *
   * Aligned with `targets` rather than keyed by target, and that alignment is maintained where
   * the list is: a target dropped by the fizzle check takes its share out with it, and a
   * redirected target keeps the share of the slot it took over (CR 114.6 changes what a spell is
   * pointed at and not how it was divided). Keyed by target would survive both on its own and
   * would mean every reader learning what a target's key is to ask a question about a number.
   */
  readonly division?: readonly number[];
  /**
   * Whether this spell's kicker was paid.
   *
   * On the stack object for the same reason X is: it was chosen as the spell was cast, both
   * players can read it before deciding whether to respond, and the effect needs it on
   * resolution. Absent on everything without a kicker.
   */
  readonly kicked?: boolean;
  /**
   * Whether this spell was cast with flashback (CR 702.33a).
   *
   * On the stack object because the card's destination depends on it and the card does not: a
   * spell cast from the graveyard is **exiled** as it leaves the stack, countered or resolved, and
   * by then the only thing that remembers how it was cast is this.
   */
  readonly flashback?: true;
  /**
   * Whether this spell is the adventure half of an adventurer card.
   *
   * Beside `flashback` because it answers the same question — where the card goes as it leaves the
   * stack — and because, like flashback, nothing else remembers by then which half was cast. An
   * adventure that finishes resolving is exiled, and its owner may cast the creature from there.
   */
  readonly adventure?: true;
  /**
   * The modes chosen for a modal spell, as indices into its script's `modal.modes`, in printed
   * order. Chosen as the spell was cast (CR 601.2b) and public from that moment, which is why it
   * lives on the stack object rather than anywhere private.
   */
  readonly modes?: readonly number[];
  /**
   * For a triggered ability that fired off an attack: what that attack was aimed at.
   *
   * Carried here because "deals 1 damage to the player or planeswalker it's attacking" is about
   * the attack that caused the trigger, and by the time the ability resolves the board no longer
   * says what it was aimed at — the attacker may be dead and the attack removed from combat.
   */
  readonly attacked?: AttackedTarget;
  /**
   * For a block trigger: the attacker the block was against (CR 509.1a).
   *
   * Travels for the same reason `attacked` does, and a sharper one. "That creature" in a block
   * trigger is the attacker this creature blocked, and nothing on the board says which that was by
   * the time the ability resolves: another creature may have been declared on the same attacker,
   * the attack may have been removed from combat, and a blocker is only a tapped creature.
   */
  readonly blocked?: string;
  /**
   * For a triggered ability that fired off something happening to a permanent: which permanent.
   *
   * Travels with the object for the same reason `attacked` does, and the reason is sharper here.
   * "That creature" is resolved when the ability resolves, not when it triggered — and by then the
   * board may hold two more creatures that entered after this one, so looking for "the creature
   * that entered" would find the wrong one. The id is enough: if the permanent has gone, the
   * ability finds nothing and does nothing, which is what the rules say happens (CR 603.3d).
   */
  readonly subject?: string;
  /**
   * The player whose action caused this triggered ability, for a trigger that has to say "**that**
   * player" (CR 603.3d).
   *
   * The third of the same family as `attacked` and `subject`, and the one that is about a person
   * rather than a thing: "whenever an opponent casts a noncreature spell, **that player** loses 2
   * life" has no referent without it, and in a two-player game the wrong reading — every opponent
   * — is indistinguishable from the right one, which is exactly the kind of bug a pod finds a year
   * later. Not the ability's controller: that is `controller`, and for every card that needs this
   * the two are different seats.
   */
  readonly actor?: SeatIndex;
  /**
   * The stack object this one is a **copy** of (CR 707.10), when it is one.
   *
   * Its presence is also what says there is no card here: a copy of a spell is not a card, so
   * `instances[id]` is empty for it and nothing may put it in a graveyard when it has resolved.
   * Readers that need a card off a spell go through `source`, which on a copy is still the
   * original's instance — the characteristics are the original's, and that is where they are read
   * from.
   */
  readonly copyOf?: string;
  /** What to show in the stack, written when the object was put there. */
  readonly description: string;
}

/**
 * What one attack was declared against, kept small enough to copy onto a trigger.
 *
 * The seat is always there, because it is that player's planeswalker being attacked and that
 * player who declares blockers; the planeswalker is only there when the attack was aimed at one.
 */
export interface AttackedTarget {
  readonly defender: SeatIndex;
  readonly planeswalker?: string;
}

export interface CombatAttack {
  readonly attacker: string;
  readonly defender: SeatIndex;
  /**
   * A planeswalker this attack is aimed at instead of the player (CR 506.2).
   *
   * The seat stays, because it is still *that player's* planeswalker being attacked and it is
   * still that player who declares blockers. Only where the damage lands changes.
   */
  readonly planeswalker?: string;
  /** In damage-assignment order, which is the order the attacker's controller chose. */
  readonly blockers: readonly string[];
  /**
   * Which object the attacker was when it was declared, and which objects the blockers were.
   *
   * A permanent that leaves the battlefield is removed from combat (CR 506.4), and a card that
   * comes back is a new object (CR 400.7) — so a creature blinked out and back mid-combat is not
   * the creature that was declared, however much its id says otherwise. Compared in
   * `dealCombatDamage`, which is the only place it changes an outcome.
   *
   * It is the blockers' *seqs* that are compared rather than their presence in the list, because
   * the list is also what says the attacker is **blocked**: a chump blocker that dies still
   * stops the damage (CR 509.1h), so nothing may be removed from it.
   */
  readonly attackerSeq?: number;
  readonly blockerSeqs?: Readonly<Record<string, number>>;
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
  /**
   * Whether the attacking player has settled the damage assignment order (CR 509.2).
   *
   * Its own flag for the same reason as the two above: once the order is answered, each attack's
   * `blockers` list *is* the order, so there is nothing left in the board to say whether anybody
   * was asked. Only set when an order was actually owed, and never asked twice.
   */
  readonly damageOrdered: boolean;
}

export const EMPTY_COMBAT: CombatState = Object.freeze({
  attacks: [], firstStrikeDealt: false, attackersDeclared: false, blockersDeclaredBy: [],
  damageOrdered: false,
});

/** The automation half of the game state. Absent values mean a table in manual mode. */
export interface AutomationState {
  /** True when the engine runs the rules. False is the manual tabletop. */
  readonly automated: boolean;
  /**
   * The seats that asked to be offered *every* priority, rather than have the engine pass for them
   * when passing is their only legal move.
   *
   * Auto-pass is on by default, because without it a real game asks each player twenty-five times
   * a turn to confirm they still cannot do anything. A player who wants every priority — to bluff,
   * or to watch each step go by — turns it off, and this is the list of who has.
   *
   * **Per seat rather than per table, which is the point of the list.** It was one boolean, so one
   * player asking to see every step made the engine stop for *both* of them: the other player was
   * then pestered twenty-five times a turn for a setting they never touched. Stops are a preference
   * about how you want to be asked, not a rule about the game, and two people at one table can
   * reasonably want different answers.
   *
   * Read through `autoPassFor`, which treats a missing entry as "on" — so a game stored before
   * this list existed comes back with everybody auto-passing, which is what it had.
   */
  readonly autoPassOff: readonly SeatIndex[];
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
  /**
   * Extra land drops a seat has been given this turn (CR 505.5b): an Explore, a Azusa.
   *
   * A separate count rather than a smaller `landsPlayed`, because the two mean different things
   * and a card may read either: how many lands you have played is a fact about the turn, and how
   * many more you may play is a permission that something gave you. Reset in the untap step with
   * `landsPlayed`, since a permission that outlived its turn would be a different card.
   */
  readonly extraLands: Readonly<Record<string, number>>;
  /** Source of synthetic ids for ability stack objects and effects. */
  readonly autoSeq: number;
  /**
   * Abilities scheduled to trigger later, each exactly once (CR 603.7).
   *
   * The family of printed text this exists for is "**at end of combat**, destroy that creature"
   * and "**at the beginning of the next end step**, return it to the battlefield": something
   * happens now, and something else happens at a named time, once. Every other trigger in the
   * engine fires at the moment its event happens, so none of this was expressible — and it cannot
   * be faked with a step trigger, because a step trigger fires every turn for as long as its
   * permanent is on the battlefield and this one fires once whether or not the permanent is still
   * there.
   *
   * On the state rather than on the permanent for exactly that reason: the Flickerwisp that exiled
   * something can be destroyed before the end step and the card still comes back, because the
   * delayed ability has already been created and stopped belonging to it (CR 603.7d). Drained by
   * the step it names.
   */
  readonly delayed: readonly DelayedTrigger[];
  /** Set when a player has lost by trying to draw from an empty library (CR 704.5b). */
  readonly drewFromEmpty: readonly SeatIndex[];
  /**
   * Permanents that have moved from the battlefield to a graveyard and whose death nobody has
   * announced yet. Drained by `settle`, which raises a `dies` event for each.
   *
   * This exists because "dies" means *put into a graveyard from the battlefield* (CR 700.4) — not
   * "noticed by state-based actions", which is all it used to mean. A creature destroyed by Doom
   * Blade, or sacrificed to pay a cost, never passes through the lethal-damage check, so its
   * trigger never fired; two call sites had been patched to announce their own deaths by hand and
   * every other one was silently wrong. `relocate` is the single place a card changes zone, so it
   * records the fact and `settle` interprets it: a script cannot be forgotten because nothing
   * announces itself.
   */
  readonly died: readonly string[];
  /**
   * Permanents that have left the battlefield since the last `settle`, for leave-the-battlefield
   * triggers (CR 603.6c). Wider than `died`, which is only the ones that reached a graveyard: a
   * permanent that was exiled or bounced left too, and the cards that exiled something "until this
   * leaves" have to give it back either way.
   */
  readonly left: readonly string[];
  /**
   * Tokens that have ceased to exist since the last `settle`, kept just long enough to raise their
   * own triggers (CR 111.7, CR 603.6d).
   *
   * A token that leaves the battlefield stops existing immediately, which used to mean its death
   * trigger found no source and never fired — written down in `relocate` as "a real limitation,
   * and no token in the pool has one", and true right up until Sedgemoor Witch's Pest. The rules
   * are clear that it should fire: a leave-the-battlefield ability triggers from the game state as
   * it was *before* the event, so a 1/1 that says "when this dies, you gain 1 life" pays the life
   * even though nothing is left to point at.
   *
   * So the instance is removed from its zone and detached immediately, as it must be — nothing
   * should see a token sitting in a graveyard — and its last state is kept here for `raise` to
   * read. `settle` clears the list once it has drained `died` and `left`, which is the moment the
   * token has no further business in the game.
   */
  readonly vanished: Readonly<Record<string, CardInstance>>;
  /**
   * What replacement effects did since the last action was announced, in words.
   *
   * Recorded and drained the way `died` is, and for a reason that is about the *player* rather than
   * about triggers: a replaced death produces no event anybody can log, so without this a creature
   * dies to a Doom Blade and silently turns up in exile with a Zombie beside it, and the card that
   * did it is nowhere on screen. `reduceAutoAction` drains the notes onto the message of the action
   * that provoked them, which is where a player is already looking.
   */
  readonly replacements: readonly string[];
  /**
   * Creatures that have dealt combat damage to a *player* and whose damage nobody has announced
   * yet, with the seat each one hit. Drained by `settle` alongside `died` and `entered`.
   *
   * The fourth member of the detect-rather-than-announce family, and it has to be recorded rather
   * than compared: the other three can be found by looking at the board, and a life total going
   * down does not say which creature took it there. `dealCombatDamage` is the one place combat
   * damage is dealt, so it is the one place that knows — and it records a hit only when the damage
   * actually landed, so a swing stopped by a Fog, a prevention shield or protection raises nothing,
   * which is what "deals damage" means (CR 702.15a says the same for lifelink).
   *
   * The seat travels with it because the ability needs it: "that player mills" is about whoever was
   * hit, which in a pod is not the only opponent. It is handed to the ability through the same
   * `attacked` channel an attack trigger uses, so there is one way an ability learns which player
   * its event was about rather than two.
   */
  readonly dealtCombatDamage: readonly { readonly creature: string; readonly defender: SeatIndex }[];
  /**
   * Permanents that have arrived on the battlefield and whose entry nobody has announced yet.
   * Drained by `settle` alongside `died`.
   *
   * The same story as `died`, and found the same way. `etb` was raised at exactly one call site —
   * a permanent spell finishing its resolution — so a creature put onto the battlefield by
   * Zombify never triggered, and a token never triggered at all. Krenko's Goblins, Izoni's
   * Insects and Talrand's Drakes all arrived silently. Recorded where the card actually moves,
   * announced in one place.
   *
   * A permanent changing controller is **not** entering the battlefield, so only a move from
   * somewhere else counts.
   */
  readonly entered: readonly string[];
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
  /**
   * A ward waiting to be paid (CR 702.21), and the spell or ability it will counter if it is not.
   *
   * The third thing that stops the table dead, and the one that stops it for the player who is
   * *not* resolving anything: a ward's triggered ability belongs to the warded permanent's
   * controller, but the question it asks belongs to whoever did the targeting. So `seat` here is
   * never the controller of the ability that set it — which is the whole reason it could not be
   * folded into `pendingDecision`, whose `seat` is a chooser inside somebody else's resolution.
   *
   * `counters` is the stack object that goes away when the answer is no. It is remembered here
   * rather than worked out later because by the time the answer arrives the ward's own ability has
   * left the stack, and nothing else on the table says what it was about.
   */
  readonly pendingPayment: {
    /** Who may pay: the controller of the spell or ability that did the targeting. */
    readonly seat: SeatIndex;
    /** The ward cost, in the printed `{2}` form. */
    readonly cost: string;
    /** Shown to the player paying, in their own words. */
    readonly prompt: string;
    /** The stack object countered if they decline, or cannot pay. */
    readonly counters: string;
    /** The warded permanent, for the table to point at. */
    readonly source: string;
  } | null;
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
    /**
     * Where they are being chosen from, which is what the table needs to draw the picker. Absent
     * for a question whose answer is a word rather than a card — see `options`.
     */
    readonly from?: DecisionZone;
    /**
     * The words to choose between, when that is what the question is: a creature type, a colour,
     * "tap" or "untap". Present exactly when `from` is absent, and the table draws a row of
     * buttons instead of lighting up cards.
     */
    readonly options?: readonly string[];
    /**
     * The numbers on offer, when the answer is a number rather than a card or a word. Present
     * exactly when `from`, `options` and `targetChoices` are all absent, and the table draws a row
     * of numbers.
     */
    readonly numbers?: { readonly min: number; readonly max: number };
    /**
     * The targets on offer, when the answer is **where something else on the stack is pointed**:
     * "you may choose new targets for the copy".
     *
     * Full targets rather than ids, because a target is a card *or* a player and the table has to
     * draw both. The one it already has is in the list, since choosing the same target again is a
     * legal answer to "you may choose new targets" — and `min` is nought, because declining is as
     * well. See `TargetDecisionSpec`.
     */
    readonly targetChoices?: readonly Target[];
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
/**
 * Where the cards a decision is about live.
 *
 * `library` is a search — the whole library, open to its owner while they look. `library-top` is
 * the other way a player ever sees their own library: the top few cards, face up to them and to
 * nobody else, which is scry and everything shaped like it.
 */
/**
 * Where a mid-resolution question looks.
 *
 * All but the last are the **chooser's own** zone, which is what every card asking one of these
 * questions means: your library, your hand, your graveyard, your battlefield.
 *
 * `any-battlefield` is the exception and the only one that crosses the table: "choose any creature
 * on the battlefield" is a question about the whole board, which is what a Clone asks. It is its
 * own zone rather than a flag because the candidate list *is* the authorisation the answer is
 * checked against — a question that looked at one battlefield and accepted an answer from another
 * would be a hole, and keeping the two in the same place is what stops that.
 */
export type DecisionZone =
  | 'library' | 'library-top' | 'hand' | 'graveyard' | 'battlefield' | 'any-battlefield';

/** One answered decision, in the order the card asked. */
export interface DecisionAnswer {
  readonly seat: SeatIndex;
  readonly ids: readonly string[];
  /**
   * The word chosen, for a question whose answer is not a card — "Vampire", "white", "untap".
   *
   * The string rather than its index, because the string is what the effect needs and an index is
   * a second thing that can be out of step with the list it indexes. It is checked against the
   * spec's own `options` when the answer arrives, so a crafted action cannot invent one.
   */
  readonly option?: string;
  /**
   * The number chosen, for a question whose answer is neither a card nor a word — "pay X life".
   *
   * Checked against the range the spec computed when the question was asked, so a crafted action
   * cannot pay nine life out of a four-life range. See `NumberDecisionSpec`.
   */
  readonly amount?: number;
  /**
   * The target chosen, for a question about where something else on the stack is pointed.
   *
   * Absent when the answer was to decline, which "you may choose new targets" always allows — so
   * the effect reads "absent means leave it alone" rather than needing a second field to say so.
   */
  readonly target?: Target;
}

// ── Automated actions ────────────────────────────────────────────────────────────────────────────
export interface AutoStartAction {
  readonly type: 'auto:start'; readonly by: SeatIndex; readonly firstSeat?: SeatIndex;
  /**
   * Defaults to true, for every seat. False starts the table with auto-pass off for everybody,
   * which is what a test that wants to walk a game in lock-step asks for. See
   * `AutomationState.autoPassOff`.
   */
  readonly autoPass?: boolean;
}
/** Turns auto-passing on or off mid-game, which is a table setting rather than a game rule. */
/**
 * The attacking player's damage assignment order (CR 509.2), for every attack that needed one.
 *
 * One action for the whole combat rather than one per attacker: the order is a turn-based action
 * taken once, and asking a player four questions in a row for a four-creature swing is four
 * chances to lose track of which creature the prompt is about.
 */
export interface AutoOrderAction {
  readonly type: 'auto:order';
  readonly by: SeatIndex;
  readonly orders: readonly { readonly attacker: string; readonly blockers: readonly string[] }[];
}

/** One seat's own stops setting. `by` is whose preference it is, and nobody else's changes. */
export interface AutoStopsAction { readonly type: 'auto:stops'; readonly by: SeatIndex; readonly autoPass: boolean }
export interface AutoPlayLandAction { readonly type: 'auto:playLand'; readonly by: SeatIndex; readonly card: string }
export interface AutoCastAction {
  readonly type: 'auto:cast'; readonly by: SeatIndex; readonly card: string;
  readonly targets?: readonly Target[]; readonly x?: number;
  /** For a modal spell: which modes, as indices into its script's `modal.modes`. */
  readonly modes?: readonly number[];
  /**
   * For a spell that divides a quantity among its targets (CR 601.2d): how much each of `targets`
   * is assigned, in the same order.
   *
   * Announced with the spell, like X and the modes, because that is when the division is chosen
   * and it cannot be changed afterwards. Refused on a spell that divides nothing, and refused
   * when it does not add up — a client that sent a short division would be casting a spell whose
   * damage went nowhere.
   */
  readonly division?: readonly number[];
  /** Pay the kicker (CR 702.32a). Refused on a spell that has none. */
  readonly kicked?: boolean;
  /**
   * Cast it from your graveyard for its flashback cost (CR 702.33). Refused on a card with no
   * flashback, and on one that is not in your graveyard.
   */
  readonly flashback?: boolean;
  /** The creature sacrificed for an additional cost, when the spell asks for one. */
  readonly sacrifice?: string;
  /**
   * Cast it out of exile for its foretell cost (CR 702.143b). Refused on a card that was not
   * foretold, on one foretold by somebody else, and on one foretold this turn.
   */
  readonly foretold?: boolean;
  /**
   * Cast it face down as a 2/2 creature for {3} (CR 702.37a). Refused on a card with no morph.
   *
   * No targets, no modes, no X and no kicker travel with it, and each of those is refused rather
   * than ignored: a face-down spell has no text, so there is nothing on it for any of them to be
   * about.
   */
  readonly faceDown?: boolean;
  /**
   * Which face of a card printed with more than one to cast: an index into `CardDef.faces.cards`
   * (CR 708).
   *
   * Required on a split card, which has no castable face of its own — "Cast Fire // Ice" is not a
   * play — and optional on an adventurer, where leaving it out casts the creature. Refused on a
   * card with no second face, rather than ignored: a client sending one has misread the card, and
   * a cast that silently fell back to the printed face would resolve the wrong spell.
   */
  readonly half?: number;
}
/**
 * Exile a card from your hand face down for {2}, to be cast later (CR 702.143a).
 *
 * A **special action**, like turning a morph face up: no stack, nothing to respond to. The two are
 * the engine's only special actions and they are opposites — one hides a card and the other
 * reveals one.
 */
export interface AutoForetellAction {
  readonly type: 'auto:foretell'; readonly by: SeatIndex; readonly card: string;
}
/**
 * Turn your own face-down permanent face up for its morph cost (CR 702.37b).
 *
 * A **special action**, not an ability and not a cast: it uses no stack, so there is no window in
 * which an opponent may answer it, which is most of what players use morph for. All it needs is
 * the card — the cost is the one printed on it, and a client naming its own cost would be a client
 * deciding what the card says.
 */
export interface AutoTurnUpAction {
  readonly type: 'auto:turnUp'; readonly by: SeatIndex; readonly card: string;
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
  readonly attackers: readonly {
    readonly attacker: string;
    readonly defender: SeatIndex;
    /** A planeswalker that seat controls, attacked instead of the player (CR 506.2). */
    readonly planeswalker?: string;
  }[];
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
  /**
   * The word chosen, for a question whose answer is a word. Carried on the same action as `cards`
   * rather than on one of its own, because it is the same question at the same moment in the same
   * resolution — a second action would be a second thing the table has to know when to send.
   */
  readonly option?: string;
  /** The number chosen, for a question whose answer is a number. Same action, same reason. */
  readonly amount?: number;
  /**
   * The target chosen, for a question about where a copy is pointed. Omitted to decline, which is
   * why this action has no separate "no thank you" — see `TargetDecisionSpec.optional`.
   */
  readonly target?: Target;
}
/**
 * Answers a ward (CR 702.21): pay the cost, or let the spell or ability be countered.
 *
 * The only question in this engine that is asked of a player because of *somebody else's*
 * permanent, and the only one whose answer is mana rather than a card — which is why it is its own
 * action rather than another `auto:decide`. `pay: false` is a real answer and not a refusal to
 * answer: declining is often right, and the engine has to be able to tell the difference between
 * "no" and a table that has stopped.
 */
export interface AutoPayAction {
  readonly type: 'auto:pay'; readonly by: SeatIndex; readonly pay: boolean;
}
/** Settles on an opening hand, putting back one card for each mulligan taken. */
export interface AutoKeepAction {
  readonly type: 'auto:keep'; readonly by: SeatIndex;
  /** Cards to put on the bottom of the library, exactly as many as are owed. */
  readonly bottom?: readonly string[];
}

export type AutoAction =
  | AutoStartAction | AutoPlayLandAction | AutoCastAction | AutoActivateAction
  | AutoPassAction | AutoAttackAction | AutoBlockAction | AutoOrderAction | AutoDiscardAction
  | AutoStopsAction | AutoKeepAction | AutoChooseAction | AutoDecideAction | AutoPayAction
  | AutoTurnUpAction | AutoForetellAction;

export const AUTO_ACTION_TYPES: readonly AutoAction['type'][] = Object.freeze([
  'auto:start', 'auto:playLand', 'auto:cast', 'auto:activate', 'auto:pass', 'auto:attack',
  'auto:block', 'auto:order', 'auto:discard', 'auto:stops', 'auto:keep', 'auto:choose',
  'auto:decide', 'auto:pay', 'auto:turnUp', 'auto:foretell',
]);

export const isAutoAction = (action: { type: string }): action is AutoAction =>
  (AUTO_ACTION_TYPES as readonly string[]).includes(action.type);

