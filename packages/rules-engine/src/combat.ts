/**
 * Combat: who can attack, who can block, and how damage is dealt.
 *
 * The densest rules in the engine and the easiest to get subtly wrong, so everything here is a pure
 * function over the state and each rule is tested on its own. The sequence it implements:
 *
 *   declare attackers → declare blockers → first-strike damage → regular damage
 *
 * Damage is *marked* on creatures rather than subtracted from toughness, and nothing dies here.
 * Lethal damage is a state-based action, checked by the engine after every step — which is what
 * makes "it died because it was already damaged, then got blocked" work, and what lets a creature
 * survive combat damage if it is pumped in response.
 */
import {
  clauseMatches, characteristicsOf, combatDamagePrevented, hasSubtype, keywordBlockRules,
  protectionApplies,
  type BlockerClause, type Characteristics,
} from './characteristics.js';
import { listAt } from './cardActions.js';
import { dealDamage, gainLife } from './effects.js';
import { zoneKey, type CardInstance } from './cards.js';
import type { CombatAttack, CombatState, Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

export interface CombatIssue {
  readonly card: string;
  readonly reason: string;
}

/** The permanent, if it is a creature on the given seat's battlefield. */
function creatureOf(state: GameState, id: string, seat?: SeatIndex): { inst: CardInstance; ch: Characteristics } | null {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return null;
  if (seat !== undefined && inst.zoneSeat !== seat) return null;
  const ch = characteristicsOf(state, inst);
  return ch.isCreature ? { inst, ch } : null;
}

/** A creature is summoning sick unless it has been here since before this turn, or has haste. */
export function canAttack(state: GameState, id: string, seat: SeatIndex): CombatIssue | null {
  const found = creatureOf(state, id, seat);
  if (found === null) return { card: id, reason: 'not a creature you control' };
  const { inst, ch } = found;
  if (inst.tapped) return { card: id, reason: `${ch.name} is tapped` };
  if (ch.cantAttack) return { card: id, reason: `${ch.name} can't attack` };
  if (inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) {
    return { card: id, reason: `${ch.name} has summoning sickness` };
  }
  return null;
}

/**
 * The creatures this seat is *required* to attack with, and could (CR 508.1d).
 *
 * A requirement is not a restriction turned round: "can't attack" is checked against one creature,
 * and "attacks each combat if able" is checked against the whole declaration — the illegal thing
 * is leaving it at home, which is a fact about a list rather than about a card. "If able" carries
 * all the usual excuses with it: tapped, summoning-sick, Pacified, and — the one that is easy to
 * forget — nobody left to attack, which happens in a pod the moment the last opponent is out.
 *
 * Exported because three callers need the same answer: the engine refusing an illegal declaration,
 * `legalActions` telling the table so it never offers one, and the bot building plans that are
 * legal before they are scored.
 */
export function forcedAttackers(state: GameState, seat: SeatIndex): string[] {
  const out: string[] = [];
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (!ch.isCreature || !ch.mustAttack) continue;
    if (canAttack(state, id, seat) !== null) continue;
    out.push(id);
  }
  return out;
}

/**
 * Whether this creature may be aimed at *that* defender — goad's second half (CR 701.38a).
 *
 * Separate from `canAttack` because it is a different question: `canAttack` asks whether a creature
 * may attack at all, and this asks whether a particular aim is legal. Only goad makes the two
 * differ today, and only goad should: an attack has exactly one defender, and the one thing a
 * goaded creature may not do is point at the player who goaded it.
 *
 * "If able" is the whole subtlety. The requirement only binds while there is somebody else to
 * attack, so it lifts when the goader is the last opponent standing — and it lifts when *every*
 * remaining opponent has goaded this creature, because then no choice satisfies anybody and all of
 * them are legal. Both fall out of asking whether a non-goader is left.
 */
export function attackAimIssue(
  state: GameState, id: string, seat: SeatIndex, defender: SeatIndex,
): CombatIssue | null {
  const found = creatureOf(state, id, seat);
  if (found === null) return null;
  const { ch } = found;
  if (!ch.goadedBy.includes(defender)) return null;
  const elsewhere = state.seats.some((s) => (
    s.index !== seat && !s.eliminated && !ch.goadedBy.includes(s.index)
  ));
  if (!elsewhere) return null;
  return {
    card: id,
    reason: `${ch.name} was goaded and must attack another player if able`,
  };
}

/**
 * The defenders a creature this seat controls may legally be aimed at, in seat order.
 *
 * The table's half of `attackAimIssue`: a player should never be able to build an attack the
 * engine then throws out, so the aim it may not choose has to travel with the declaration rather
 * than be discovered by pressing confirm.
 */
export function legalDefenders(state: GameState, id: string, seat: SeatIndex): SeatIndex[] {
  return state.seats
    .filter((s) => s.index !== seat && !s.eliminated)
    .filter((s) => attackAimIssue(state, id, seat, s.index) === null)
    .map((s) => s.index);
}

/**
 * The blockers whose order the attacking player should be asked about (CR 509.2), or none.
 *
 * Asked only when the answer can change something, which is the same line D91 drew for trigger
 * order: two or more blockers, and a budget that kills *some* of them but not all. With power
 * enough for everybody the whole block dies whatever the order; with power below the cheapest
 * nothing does. In between, which creatures die is a real decision and it is the attacking
 * player's.
 *
 * Deathtouch is included rather than excluded: it makes every blocker cost one, so the *count*
 * that die is fixed — but which ones is still a choice, and with a 1/1 deathtoucher blocked by a
 * 2/2 and a 7/7 it is the whole decision.
 *
 * Prevention is read as the rules read it: a Fog Bank still has to be *assigned* lethal damage
 * before anything gets past it (CR 702.19b), so it spends the budget here even though it will not
 * die. That makes the question "whose damage gets spent where", which is what the order is.
 */
export function damageOrderChoice(state: GameState, attack: CombatAttack): string[] | null {
  const blockers = attack.blockers.filter((id) => creatureOf(state, id) !== null);
  if (blockers.length < 2) return null;
  const attacker = creatureOf(state, attack.attacker);
  if (attacker === null || attacker.ch.power <= 0) return null;
  const deathtouch = attacker.ch.keywords.has('deathtouch');
  const costs = blockers.map((id) => {
    const blocker = creatureOf(state, id)!;
    return deathtouch ? 1 : Math.max(1, blocker.ch.toughness - blocker.inst.damage);
  });
  const total = costs.reduce((n, c) => n + c, 0);
  const cheapest = Math.min(...costs);
  if (attacker.ch.power >= total) return null;
  if (attacker.ch.power < cheapest) return null;
  return blockers;
}

/** Every attack of this seat's that still owes a damage assignment order. */
export function damageOrdersOwed(
  state: GameState, seat: SeatIndex,
): { attacker: string; blockers: string[] }[] {
  const owed: { attacker: string; blockers: string[] }[] = [];
  for (const attack of state.combat.attacks) {
    if (state.instances[attack.attacker]?.zoneSeat !== seat) continue;
    const blockers = damageOrderChoice(state, attack);
    if (blockers !== null) owed.push({ attacker: attack.attacker, blockers });
  }
  return owed;
}

/**
 * Whether `blocker` may block `attacker`.
 *
 * Evasion is checked from the attacker's keywords against the blocker's: flying can only be blocked
 * by flying or reach, and menace needs two blockers (checked separately, since it is about the
 * whole block rather than one blocker).
 */
/**
 * One printed blocker clause, as the words a player reads in the refusal.
 *
 * The message is the only place a player finds out *why* a block was turned down, and "can't be
 * blocked" on its own is the least useful thing this engine could say about a Thorn Elemental. So
 * each clause says itself back in the printed phrasing (D498).
 */
function blockerClauseText(clause: BlockerClause): string {
  switch (clause.kind) {
    case 'power':
      return `creatures with power ${clause.n} or ${clause.cmp === 'at-most' ? 'less' : 'greater'}`;
    case 'colour': return `${COLOUR_NAMES[clause.colour] ?? clause.colour} creatures`;
    case 'type': return `${clause.type} creatures`;
    case 'subtype': return `${clause.subtype}s`;
    case 'keyword': return `creatures with ${clause.keyword}`;
    // The two relational clauses (D551). Worded from the attacker's side, because that is the
    // creature every message naming them is about: "it" is the one that prints the restriction.
    case 'shares-a-colour': return 'creatures that share a color with it';
    case 'power-vs':
      return clause.cmp === 'at-most'
        ? 'creatures with power no greater than its own'
        : 'creatures with greater power';
    default: return 'those creatures';
  }
}

/** The colour words a refusal message uses, which are the words the cards print. */
const COLOUR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green',
});

export function canBlock(state: GameState, blockerId: string, attackerId: string, seat: SeatIndex): CombatIssue | null {
  const blocker = creatureOf(state, blockerId, seat);
  if (blocker === null) return { card: blockerId, reason: 'not a creature you control' };
  if (blocker.inst.tapped) return { card: blockerId, reason: `${blocker.ch.name} is tapped` };
  if (blocker.ch.cantBlock) return { card: blockerId, reason: `${blocker.ch.name} can't block` };

  const attacker = creatureOf(state, attackerId);
  if (attacker === null) return { card: blockerId, reason: 'that attacker is gone' };
  if (attacker.ch.keywords.has('flying') && !blocker.ch.keywords.has('flying') && !blocker.ch.keywords.has('reach')) {
    return { card: blockerId, reason: `${blocker.ch.name} can't block a flier` };
  }
  // The one piece of evasion in this pool that is not a keyword, so it is read off the attacker
  // rather than compared keyword to keyword. Wall is a creature type, not an ability: a Wall of
  // Air stopped by this is stopped for what it *is*.
  // Protection from a colour stops a creature of that colour blocking it (CR 702.16b) — read off
  // the *attacker*, like the Wall clause below: protection is a fact about the creature that has
  // it, and here it is the attacking creature that cannot be blocked.
  if (protectionApplies(state, attacker.ch.protectionFrom, blockerId)) {
    return { card: blockerId, reason: `${attacker.ch.name} has protection from ${blocker.ch.name}'s colour` };
  }
  if (attacker.ch.cantBeBlockedByWalls && hasSubtype(blocker.ch.typeLine, 'wall')) {
    return { card: blockerId, reason: `${attacker.ch.name} can't be blocked by Walls` };
  }
  /*
    Printed blocker restrictions — the ban list and the allow list (D498).

    Read off the **attacker**, like the Wall clause above and protection before it: a sentence about
    who may block this creature is a fact about the creature that prints it. Both are checked here
    because both are the same question asked from opposite ends, and both are a *list*: a ban
    refuses a blocker matching any clause, an allow list refuses one matching none.

    After the Wall clause and before the bare "can't be blocked", which is only an ordering of
    reasons rather than of rules — every one of these refuses the block, and the player reads
    whichever message comes first. Put together so a card printing both a ban and the keyword gets
    the more specific sentence.
  */
  const banned = attacker.ch.cantBeBlockedBy
    .find((clause) => clauseMatches(clause, blocker.ch, attacker.ch));
  if (banned !== undefined) {
    return {
      card: blockerId,
      reason: `${attacker.ch.name} can't be blocked by ${blockerClauseText(banned)}`,
    };
  }
  const allowed = attacker.ch.blockableOnlyBy;
  if (allowed !== null
    && !allowed.some((clause) => clauseMatches(clause, blocker.ch, attacker.ch))) {
    return {
      card: blockerId,
      reason: `${attacker.ch.name} can't be blocked except by `
        + allowed.map(blockerClauseText).join(' or '),
    };
  }
  /*
    And the same question from the other end: what this *blocker* may block (D500).

    Read off the **blocker** and asked about the attacker, which is the whole reason these are two
    more fields rather than a reuse of the two above. A Percher with "can block only creatures with
    flying" is not unblockable and does not stop fliers blocking it; it is a ground body that may
    only be put in front of a flier. Fold the two directions into one pair of lists and every card
    in this family gains evasion it does not print.

    Checked after the attacker's own restrictions for the same reason that ordering is: all of them
    refuse the block, and the player sees whichever reason comes first. The attacker's are the ones
    a player is more likely to have forgotten, so they speak first.
  */
  const cannot = blocker.ch.cantBlockThese
    .find((clause) => clauseMatches(clause, attacker.ch, blocker.ch));
  if (cannot !== undefined) {
    return {
      card: blockerId,
      reason: `${blocker.ch.name} can't block ${blockerClauseText(cannot)}`,
    };
  }
  const only = blocker.ch.blocksOnly;
  if (only !== null && !only.some((clause) => clauseMatches(clause, attacker.ch, blocker.ch))) {
    return {
      card: blockerId,
      reason: `${blocker.ch.name} can block only ${only.map(blockerClauseText).join(' or ')}`,
    };
  }
  // Shadow's second half (CR 702.28c), and the only keyword rule in this engine that restricts what
  // the creature carrying it may block. Read off the blocker, like the printed pair above.
  for (const rule of keywordBlockRules(blocker.ch)) {
    const clauses = rule.blocksOnly;
    if (clauses === undefined) continue;
    if (!clauses.some((clause) => clauseMatches(clause, attacker.ch, blocker.ch))) {
      return {
        card: blockerId,
        reason: `${blocker.ch.name} has ${rule.keyword}, so it can block only `
          + clauses.map(blockerClauseText).join(' or '),
      };
    }
  }
  /*
    Keyword evasion whose rule is a list: fear, shadow and horsemanship (D501).

    Applied **alongside** the printed lists above rather than merged into them, which is the point
    of keeping `KEYWORD_BLOCK_RULES` separate — see its docblock, and Dauthi Horror, which prints
    shadow and a printed ban and is entitled to both. Every rule the attacker carries has to be
    answered, and the clauses inside one rule are alternatives.
  */
  for (const rule of keywordBlockRules(attacker.ch)) {
    const clauses = rule.blockedOnlyBy;
    if (clauses === undefined) continue;
    if (!clauses.some((clause) => clauseMatches(clause, blocker.ch, attacker.ch))) {
      return {
        card: blockerId,
        reason: `${attacker.ch.name} has ${rule.keyword}, so it can't be blocked except by `
          + clauses.map(blockerClauseText).join(' or '),
      };
    }
  }
  // "Can't be blocked", with nothing after it. Nothing on the blocker's side can answer it, which
  // is why it is read here and not compared against anything.
  if (attacker.ch.cantBeBlocked) {
    return { card: blockerId, reason: `${attacker.ch.name} can't be blocked` };
  }
  /*
    Landwalk (CR 702.14), and the only evasion in this engine whose answer is on the *defending*
    player's battlefield.

    Everything else here compares the attacker with the blocker. Islandwalk compares the attacker
    with the lands of whoever is declaring blocks — so a River Boa is unblockable against the two
    blue decks and an ordinary 2/1 against the rest, and the same creature changes from one block
    to the next as lands arrive. Checked at the moment a block is offered, which is also when the
    rules check it: a player who cracks their last Island after blockers are declared has still
    blocked.
  */
  if (attacker.ch.landwalk.length > 0) {
    for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
      const inst = state.instances[id];
      if (inst === undefined) continue;
      const ch = characteristicsOf(state, inst);
      if (!ch.isLand) continue;
      const walked = attacker.ch.landwalk.find((subtype) => hasSubtype(ch.typeLine, subtype));
      if (walked !== undefined) {
        return {
          card: blockerId,
          reason: `${attacker.ch.name} can't be blocked while you control a ${walked}`,
        };
      }
    }
  }
  return null;
}

/** Menace: a creature with it cannot be blocked by exactly one creature (CR 702.110a). */
export function menaceSatisfied(state: GameState, attack: CombatAttack): boolean {
  const attacker = creatureOf(state, attack.attacker);
  if (attacker === null) return true;
  if (!attacker.ch.keywords.has('menace')) return true;
  return attack.blockers.length === 0 || attack.blockers.length >= 2;
}

/** Attacking taps the creature, unless it has vigilance. */
export function tapAttackers(state: GameState, combat: CombatState): GameState {
  let next = state;
  for (const attack of combat.attacks) {
    const found = creatureOf(next, attack.attacker);
    if (found === null || found.ch.keywords.has('vigilance')) continue;
    next = {
      ...next,
      instances: { ...next.instances, [attack.attacker]: { ...found.inst, tapped: true } },
    };
  }
  return next;
}

/** True when any creature in combat has first or double strike, so the extra step is needed. */
export function needsFirstStrikeStep(state: GameState, combat: CombatState): boolean {
  const ids = combat.attacks.flatMap((a) => [a.attacker, ...a.blockers]);
  return ids.some((id) => {
    const found = creatureOf(state, id);
    if (found === null) return false;
    return found.ch.keywords.has('first strike') || found.ch.keywords.has('double strike');
  });
}

const dealsInStep = (ch: Characteristics, firstStrike: boolean): boolean =>
  firstStrike
    ? ch.keywords.has('first strike') || ch.keywords.has('double strike')
    : !ch.keywords.has('first strike') || ch.keywords.has('double strike');

/**
 * Deals one combat damage step.
 *
 * An unblocked attacker hits the defending player. A blocked one divides its power among its
 * blockers in the order its controller chose, assigning lethal damage to each before moving on
 * (CR 510.1c) — with deathtouch, one point is lethal (CR 702.2c). Trample lets the excess through
 * to the player. Blockers always hit the attacker they are blocking.
 *
 * An attacker that was blocked but whose blockers have all gone deals no damage: it is still
 * "blocked", which is the rule that makes a chump block work even if the chump dies first.
 */
/**
 * What an unblocked attack hits: the planeswalker it was aimed at, or the player.
 *
 * The planeswalker has to still be there — it can be killed, bounced or stolen between the
 * declaration and the damage step, and CR 506.4 says an attack whose planeswalker has gone deals
 * no combat damage at all rather than falling through to its controller.
 *
 * **Not pinned to an object the way the attacker and the blockers are** (`sameObject` below), and
 * that is a reachability judgement rather than an oversight: a planeswalker that left and came
 * back in this window would be a new object the attack can no longer be aimed at (CR 400.7), and
 * nothing in this pool can produce one. Both immediate blinks — Cloudshift and Soulherder's
 * end-step trigger — say "target **creature** you control", and Flickerwisp gives its card
 * back at the next end step, which is after combat. Give the pool a blink that takes a permanent
 * and returns it at once, and this line needs `attack.planeswalkerSeq` beside the other two.
 */
function defenderTarget(state: GameState, attack: CombatAttack): Target {
  if (attack.planeswalker === undefined) return { kind: 'player', seat: attack.defender };
  const walker = state.instances[attack.planeswalker];
  if (walker === undefined || walker.zone !== 'battlefield' || walker.zoneSeat !== attack.defender) {
    return { kind: 'card', id: '' };
  }
  return { kind: 'card', id: attack.planeswalker };
}

/**
 * Whether the permanent named in combat is still the object that was declared.
 *
 * A permanent that leaves the battlefield is removed from combat (CR 506.4), and the card that
 * comes back is a new object (CR 400.7) — so a creature blinked out and straight back is not an
 * attacking creature any more, even though the engine keeps its id. Without this, a Cloudshift on
 * your own blocked attacker would get its damage through.
 */
const sameObject = (state: GameState, id: string, seq: number | undefined): boolean =>
  seq === undefined || (state.instances[id]?.objectSeq ?? 0) === seq;

/**
 * Combat damage aimed at a player, recorded when it actually lands.
 *
 * "Whenever ~ deals combat damage to a player" needs two things nothing else in the engine knows:
 * which creature dealt it, and to whom. A life total going down says neither — so unlike a death,
 * an arrival or a tap, this one is **recorded** here rather than found by comparing, and `settle`
 * announces it the way it announces the other three.
 *
 * Recorded only if the life total moved, which is the whole of "deals damage": a swing stopped by
 * a Fog, eaten by a prevention shield or turned aside by protection deals nothing, and a Thieving
 * Magpie whose damage was prevented draws no card. The seat is read from the target rather than
 * from the attack, so a trample over a blocker in front of a *planeswalker* records nothing —
 * loyalty is not a player.
 */
function hit(
  state: GameState,
  target: Target,
  amount: number,
  opts: Parameters<typeof dealDamage>[3],
  attacker: string,
): GameState {
  const next = dealDamage(state, target, amount, opts);
  if (target.kind !== 'player') return next;
  const before = state.seats[target.seat]?.life;
  const after = next.seats[target.seat]?.life;
  if (before === undefined || after === undefined || after >= before) return next;
  return {
    ...next,
    dealtCombatDamage: [...next.dealtCombatDamage, { creature: attacker, defender: target.seat }],
  };
}

export function dealCombatDamage(state: GameState, firstStrike: boolean): GameState {
  let next = state;
  /*
    What every creature in this combat *was* when the step began (CR 510.2).

    Combat damage is dealt simultaneously, so every creature deals damage according to what it was
    before any of it landed — and this engine deals it one creature at a time, which is only the
    same thing if nothing a creature deals can change what another creature is. Marked damage does
    not change power or toughness, so that held for every card in the pool right up to **infect**:
    a `-1/-1` counter is a smaller creature at once, and without this snapshot a blocker that had
    just taken two counters hit back for two less. Found by the test that expected a 3/3 Centaur
    Courser to deal three to the 2/3 that killed it and watched it deal one.

    Read off `state` rather than `next` for the same reason, and it covers both halves: the power a
    creature deals with, and the toughness used to work out what is lethal for it.
  */
  const was = new Map<string, NonNullable<ReturnType<typeof creatureOf>>>();
  for (const attack of state.combat.attacks) {
    for (const id of [attack.attacker, ...attack.blockers]) {
      const found = creatureOf(state, id);
      if (found !== null) was.set(id, found);
    }
  }
  /** What it was, or what it is for anything that was not in combat when the step began. */
  const asItWas = (id: string): NonNullable<ReturnType<typeof creatureOf>> | null =>
    was.get(id) ?? creatureOf(next, id);
  /*
    Asked per creature rather than per attack, because prevention is written on the creature: a
    Fog covers every creature on the table, a Maze of Ith covers one, and either way the question
    "does this creature's combat damage happen" answers for the damage it deals and the damage it
    takes. A creature that is both prevented and prevented against is simply asked twice.
  */
  const prevented = (id: string): boolean => {
    const inst = next.instances[id];
    return inst !== undefined && combatDamagePrevented(next, inst);
  };
  for (const attack of next.combat.attacks) {
    // Still in combat and still the same object, but *as it was*: see `was` above.
    const attacker = sameObject(next, attack.attacker, attack.attackerSeq)
      && creatureOf(next, attack.attacker) !== null
      ? asItWas(attack.attacker)
      : null;
    // A blocker that has left is out of combat too — but it stays in `attack.blockers`, because
    // that list is what says the attacker is blocked at all (CR 509.1h).
    const livingBlockers = attack.blockers.filter((id) =>
      creatureOf(next, id) !== null && sameObject(next, id, attack.blockerSeqs?.[id]));

    if (attacker !== null && dealsInStep(attacker.ch, firstStrike) && attacker.ch.power > 0
      && !prevented(attack.attacker)) {
      /*
        Deathtouch is still read here, and only for the **arithmetic**: how much of an attacker's
        power one blocker soaks up before trample lets the rest through is a question about lethal
        damage (CR 702.2c), not about what the damage does when it lands. Whether the damage itself
        is deadly is `dealDamage`'s own business now, read off the source beside infect and wither —
        so lifelink, which has no arithmetic, is no longer read here at all.
      */
      const deathtouch = attacker.ch.keywords.has('deathtouch');
      const controller = attacker.inst.zoneSeat;

      if (attack.blockers.length === 0) {
        // `combatFrom` is what makes commander damage accumulate; see `dealDamage`.
        next = hit(next, defenderTarget(next, attack), attacker.ch.power, {
          controller, combatFrom: attack.attacker, source: attack.attacker,
        }, attack.attacker);
      } else {
        let remaining = attacker.ch.power;
        for (const blockerId of livingBlockers) {
          if (remaining <= 0) break;
          const blocker = asItWas(blockerId);
          if (blocker === null) continue;
          /*
            Assigned and then not dealt, rather than skipped.

            A blocker whose damage is prevented still has to be assigned lethal damage before the
            attacker may trample past it (CR 702.19b): the rule is about what is *assigned*, and an
            attacker under a Maze of Ith's blocker does not get to send its whole power through.
          */
          if (prevented(blockerId)) {
            remaining -= deathtouch ? 1 : Math.max(1, blocker.ch.toughness - blocker.inst.damage);
            continue;
          }
          // Lethal is what is left of its toughness; deathtouch makes one point lethal.
          const lethal = deathtouch ? 1 : Math.max(1, blocker.ch.toughness - blocker.inst.damage);
          const assigned = Math.min(remaining, lethal);
          next = dealDamage(next, { kind: 'card', id: blockerId }, assigned, {
            controller, source: attack.attacker,
          });
          remaining -= assigned;
        }
        if (remaining > 0 && attacker.ch.keywords.has('trample')) {
          // Trample damage to a player is still combat damage from the attacker, so a trampling
          // commander counts towards twenty-one just as an unblocked one does. Trampling over a
          // blocker in front of a planeswalker hits the planeswalker, for the same reason.
          next = hit(next, defenderTarget(next, attack), remaining, {
            controller, combatFrom: attack.attacker, source: attack.attacker,
          }, attack.attacker);
        }
      }
    }

    for (const blockerId of livingBlockers) {
      const blocker = asItWas(blockerId);
      if (blocker === null || !dealsInStep(blocker.ch, firstStrike) || blocker.ch.power <= 0) continue;
      // The attacker may already be gone; blockers deal damage only to something still there,
      // and not to a new permanent wearing the same id.
      if (attacker === null || creatureOf(next, attack.attacker) === null) continue;
      if (prevented(blockerId) || prevented(attack.attacker)) continue;
      next = dealDamage(next, { kind: 'card', id: attack.attacker }, blocker.ch.power, {
        controller: blocker.inst.zoneSeat,
        source: blockerId,
      });
    }
  }
  return next;
}

/** Creatures the given seat could legally declare as attackers right now. */
export function legalAttackers(state: GameState, seat: SeatIndex): string[] {
  return listAt(state, zoneKey(seat, 'battlefield')).filter((id) => canAttack(state, id, seat) === null);
}

/** Creatures the given seat could legally block with, against the current attacks. */
export function legalBlockers(state: GameState, seat: SeatIndex): string[] {
  return listAt(state, zoneKey(seat, 'battlefield')).filter((id) => {
    const found = creatureOf(state, id, seat);
    if (found === null || found.inst.tapped || found.ch.cantBlock) return false;
    // Only attacks aimed at this seat: you cannot block an attack on somebody else (CR 509.1a).
    return state.combat.attacks.some((a) => a.defender === seat && canBlock(state, id, a.attacker, seat) === null);
  });
}

export { gainLife };
