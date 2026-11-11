/**
 * The shape of a card script.
 *
 * The aim is that adding a card is a few declarative lines, because the engine has to grow one card
 * at a time and a scripting API that is tedious stops getting used. A script says what a card
 * *needs* (targets, costs) and what it *does* (an effect built from `effects.ts`); the engine owns
 * everything else — paying the cost, putting it on the stack, checking targets are still legal,
 * putting it in the graveyard afterwards, and noticing that something died.
 *
 * A card with no script still works. It can be cast if its mana cost parses, it resolves onto the
 * battlefield if it is a permanent, and its printed keywords are read from its oracle text — so an
 * unscripted Grizzly Bears attacks and blocks correctly. What it will not do is anything written in
 * prose, and the table says so rather than pretending: an unscripted spell resolves with no effect
 * and the log records that it was not automated, which is the honest version of "the computer did
 * something you did not expect".
 */
import type { CardDef, ZoneId } from './cards.js';
import type { Keyword, TypeLine } from './characteristics.js';
import type { EffectFn, PumpOptions } from './effects.js';
import type { Color, ManaType } from './mana.js';
import type { GameState, SeatIndex } from './types.js';
import type { ActivationTiming, AttackedTarget, DecisionZone, Step, Target } from './turnTypes.js';

/** What a spell or ability needs pointed at it before it can be put on the stack. */
export interface TargetSpec {
  /**
   * What may be pointed at. The `graveyard-*` kinds point at a *card* in a graveyard rather than a
   * permanent on the battlefield — a different object in a different zone, which is why they are
   * their own kinds rather than a filter on `creature`. A card in a graveyard has no continuous
   * effects applied to it, so its **printed** type is what it is; `graveyard-card` takes any card
   * and leaves the rest to `filter`.
   *
   * `spell` and `ability` are both objects on the stack and are *not* interchangeable: a spell is a
   * card and an ability is not, so they arrive as different `Target` shapes and a card that takes
   * either says `spell-or-ability` rather than hoping. Those three are the printed difference
   * between a Cancel, a Stifle and a Disallow.
   *
   * `player-or-planeswalker` is `any` minus the creatures, and it exists because the difference is
   * printed: a Shock says "any target" and a Lava Spike says "target player or planeswalker", and
   * the whole of what makes Lava Spike a worse card for its cost is that it cannot kill a creature.
   * Reading it as `player` loses the planeswalker half, reading it as `any` gains a creature the
   * card may not touch, and both are a different card.
   */
  readonly kind:
    | 'creature' | 'permanent' | 'player' | 'any' | 'player-or-planeswalker' | 'spell'
    | 'ability' | 'spell-or-ability'
    | 'graveyard-creature' | 'graveyard-land' | 'graveyard-card';
  /** Shown to the player choosing, e.g. "target creature an opponent controls". */
  readonly description: string;
  /** How many of this spec. Defaults to 1. */
  readonly count?: number;
  /** "up to": the spell is castable with fewer, including none. */
  readonly optional?: boolean;
  /**
   * Advice to the bot: how many of an "any number of targets" spec to take (D579).
   *
   * The bot fills a spec to its `count`, which is right for "up to two target creatures" and
   * wrong for a number that is only a ceiling — a Fireball aimed at everything on the table,
   * its caster's own creatures included, with the damage divided to nothing. Not a restriction:
   * a person may take as many as the spec allows.
   */
  readonly botTakes?: number;
  /**
   * Extra restriction beyond the kind, e.g. only creatures you control.
   *
   * `source` is the card the targeting belongs to, when there is one — the permanent whose
   * ability this is, or the spell being cast. That is what "another target creature" and "a
   * creature this is not already attached to" need, and without it a script would have to guess
   * which of the candidates was itself.
   */
  readonly filter?: (
    state: GameState, candidate: Target, controller: SeatIndex, source?: string,
  ) => boolean;
  /**
   * Advice to the bot: what this points at is being **helped**, not hit.
   *
   * Not a restriction, and deliberately not one. "Prevent the next 3 damage that would be dealt to
   * any target" may legally be aimed at an opponent's creature, and at a four-player table there
   * are reasons to; a filter that stopped it would be a different card. What it changes is which
   * legal target the bot *picks*, because its default is "the enemy and the enemy's creatures" —
   * sensible for the removal and the burn that are most of what targets anything, and exactly
   * backwards for a shield, which is simply thrown away on an opponent.
   *
   * Declared on the spec, like `preventsDamage` is declared on the card, the mode or the ability:
   * the engine does not read either, and both exist because the bot cannot work out intent from an
   * effect it has not run yet.
   *
   * **The pump spells carry it now** (D252), and the paragraph that used to sit here said they did
   * not and that fixing it would be "a change to five cards' measured behaviour rather than a
   * flag". That was right about the cost and wrong about the size: it is eleven specs, eight on
   * spells and three on Auras, plus `BESTOW_TARGET` — and what made it worth doing was finding out
   * what the omission had been doing. `granted-abilities` caught an Ophidian Eye enchanting the
   * **opponent's** creature, which hands the opponent the card draw: not a wasted spell, a gift.
   */
  readonly friendly?: boolean;
  /**
   * Advice to the bot: what this points at is **exiled and comes back as a new object**
   * (CR 400.7) — a blink.
   *
   * The second hint of its kind and the first that cuts both ways, which is why it is not folded
   * into `friendly`. A blink is not a help or a hit; it is a help *or* a hit depending on whose
   * permanent it lands on, and the thing that decides is what the permanent loses by leaving. A
   * token ceases to exist (CR 111.7), so blinking an opponent's is the best removal on the board
   * and blinking your own destroys a creature for nothing. Counters, Auras and the damage marked on
   * it all go the same way, and an Aura's owner decides the sign: your Pacifism on their creature is
   * freed by the blink, their Pacifism on yours is shed by it.
   *
   * The bot could not possibly work any of that out from a spec it has not run — `chooseTargets`
   * reads a candidate list and a `filter`, neither of which says "and then it comes back". Three
   * cards carry it: Soulherder's end step, Cloudshift and Flickerwisp, which between them cover the
   * friendly and the hostile reading.
   *
   * Not a restriction, like `friendly`: pointing a Soulherder at your own token is legal and stays
   * legal, because a player may have a reason (a token about to be exiled by something worse, or a
   * board where the Soulherder's counter is the last point of damage needed). It changes what the
   * **bot** picks, and `BotOptions.blinksWell` is the flag that prices the change.
   */
  readonly blinks?: boolean;
  /**
   * Advice to the bot: this bonus is only paid off by the creature **dealing combat damage**.
   *
   * The third hint of its kind, and it exists because `friendly` turned out to answer only half the
   * question. `friendly` says which *side* to aim at; D252 applied it to eleven specs and the
   * Ophidian Eye promptly started landing on a Wall of Air and an Omenspeaker, where a trigger that
   * reads "whenever this creature deals damage to a player" fires exactly never. The bot's
   * ordering among its own creatures is `creatureValue` — power plus toughness plus keywords — and
   * by that measure a 0/4 flying Wall (5.5) is a better creature than a 1/1 flying lifelink
   * Healer's Hawk (4). It is, for every purpose except this one.
   *
   * So this is not "the best creature" but "a creature that can attack at all", and it is a fact
   * rather than a weight: `defender` and a blanket `cantAttack` are permanent, where tapped and
   * summoning-sick wear off and a bonus that lasts outlives them. A spec carrying this ranks the
   * creatures that can never attack below the ones that can, and changes nothing else.
   *
   * Only for a bonus whose *whole* value is in the attack. A Giant Growth deliberately does not
   * carry it: pumping a blocker to win a fight is half of what the card is for, and a Wall is often
   * the right answer. Four specs do: Ophidian Eye's Aura, Distortion Strike ("can't be blocked"),
   * Tainted Strike (infect damage) and Crimson Wisps (haste).
   *
   * Not a restriction, like `friendly` and `blinks`: enchanting the Wall stays legal, because a
   * player may have a reason this cannot see. `BotOptions.helpsAnAttacker` is the flag that prices
   * the change.
   */
  readonly helpsInCombat?: boolean;
  /**
   * A quantity split among the targets of this spec, announced as the spell is cast (CR 601.2d):
   * "Arc Lightning deals 3 damage divided as you choose among one, two, or three targets."
   *
   * The number is the whole amount, and the division is a fact about the *cast* rather than about
   * the resolution — both players can read it off the stack before deciding whether to respond,
   * the way they can read X and the chosen modes.
   *
   * **Two rules come free of the amount, and that is why there is no `min` field here.** Each
   * chosen target must be assigned at least one (CR 601.2d), and the whole amount must be
   * assigned — so `count: 3, divided: 3` *is* "one, two, or three targets": zero targets leaves
   * three unassigned, and a fourth target would have nothing left to give it. A card that divided
   * four among up to three would read "one, two, or three" the same way, and both are exactly
   * what the printed cards say.
   *
   * What a target that becomes illegal takes with it is its share, and nothing else (CR 608.2b):
   * the spell still resolves against the targets it has left, and the damage assigned to the one
   * that is gone is simply not dealt. It is not redistributed — a player who could move it would
   * be re-dividing after the window to respond had closed.
   */
  readonly divided?: number;
}

/**
 * When a triggered ability fires.
 *
 * `step` covers "at the beginning of your upkeep" and the end step. The rest are the events the
 * engine raises as it works, and adding a new one means raising it in the engine as well — which is
 * deliberate friction: a trigger nothing fires is worse than no trigger at all.
 */
export type TriggerEvent =
  | {
      readonly kind: 'etb';
      /**
       * Whose entry it watches. `self` — the default, and what most cards do — is the permanent's
       * own arrival. `another` is every creature *but* this one, and `any` is both, which is the
       * "~ or another creature" templating.
       */
      readonly who?: 'self' | 'another' | 'any';
      /** Who controls the permanent entering. Ignored for `who: 'self'`. */
      readonly of?: 'you' | 'opponent' | 'any';
      /**
       * What kind of permanent. `permanent` is the default because a `who: 'self'` trigger already
       * knows what its own card is — but a trigger watching the *board* almost always says
       * "creature", and without this an Impact Tremors fires for its own arrival as an enchantment.
       *
       * `land` is the landfall templating — "whenever a land you control enters" — and it is a
       * separate value rather than a filter because a land is not a creature and the two questions
       * are asked by different cards. A land entering has always raised this event; until a card
       * asked, nothing could hear it.
       */
      /**
       * `artifact` and `enchantment` are the two the board-watchers print as often as `creature`
       * and that nothing could read until D477: *Contraband Kingpin*, *Reckless Fireweaver*,
       * constellation and eerie. They are answered from `subjectTypes` below rather than from a
       * boolean of their own.
       */
      readonly what?: 'creature' | 'permanent' | 'land' | 'artifact' | 'enchantment';
      /**
       * "a **nontoken** creature you control enters" (D484) — `dies`' own filter, on the entry.
       *
       * **101 legal corpus lines** print it across the board prologues, 68 of them on a plain
       * "nontoken creature", and the reason it is printed is always the same: a deck that makes
       * tokens would otherwise trigger its own payoff off its own chaff. A token entering is still
       * a permanent entering; it is just not this trigger's business.
       *
       * Answered from `subjectIsToken` below, which the engine now sets on an entry as well as on
       * a death — that one-word asymmetry is the whole of what blocked these lines.
       */
      readonly nontoken?: boolean;
      /** Set by the engine when it raises the event. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine when it raises the event: whether the subject is a creature. */
      readonly subjectIsCreature?: boolean;
      /** Set by the engine when it raises the event: whether the subject is a token (D484). */
      readonly subjectIsToken?: boolean;
      /** Set by the engine when it raises the event: whether the subject is a land. */
      readonly subjectIsLand?: boolean;
      /**
       * Set by the engine when it raises the event: the subject's **live** card types, lowercased.
       *
       * **Deliberately not merged with the two booleans above**, which look like the same fact and
       * are not. `isCreature` is the characteristics answer — a crewed Vehicle and an animated land
       * reach it by routes a type line read at face value does not — and every board-watching
       * creature trigger in the pool is tested against it. Re-expressing those two filters on the
       * type line would be a behaviour change on all of them, which D477 is not; this field answers
       * the type-line questions nothing else asks.
       */
      readonly subjectTypes?: readonly string[];
      /**
       * Set by the engine: the counters it entered with, by name — a permanent can arrive with
       * them (CR 614.1c, a replacement effect), which is what `withCounter` is asked of.
       */
      readonly subjectCounters?: Readonly<Record<string, number>>;
      /**
       * **The characteristic filters** (D478): "a creature you control **with power 3 or greater**
       * enters", "**with toughness 4 or greater** dies", "**with a +1/+1 counter on it** dies",
       * "**with flying** enters".
       *
       * ~19 legal cards one unread line from a finished script print one of these, which made it
       * the largest thing D477's board parse had to refuse. All four are asked of what the event
       * carries — `subjectPower`, `subjectToughness`, `subjectCounters`, `subjectKeywords` — and
       * not of the board, because by the time a death trigger resolves the permanent is in a
       * graveyard with no counters and no keywords at all (CR 603.6e, and `subjectCounters`'
       * docblock is where this reading was first written down).
       *
       * Both bounds of each, because both halves are printed: "power 3 or greater" is Elemental
       * Bond and "power 2 or less" is Mentor of the Meek.
       */
      readonly powerAtLeast?: number;
      readonly powerAtMost?: number;
      readonly toughnessAtLeast?: number;
      readonly toughnessAtMost?: number;
      /** One counter the permanent has to have at least one of, by name: `'+1/+1'`. */
      readonly withCounter?: string;
      /** One keyword it has to have — "a creature you control **with flying** enters". */
      readonly withKeyword?: Keyword;
      /** Set by the engine when it raises the event: the subject's power and toughness as it was. */
      readonly subjectPower?: number;
      readonly subjectToughness?: number;
      /** Set by the engine when it raises the event: the keywords it had, lowercased. */
      readonly subjectKeywords?: readonly string[];
      /**
       * "Whenever a **Dragon** you control enters", "whenever another **Zombie** you control dies"
       * — the subtypes the permanent has to be one of (D479).
       *
       * The board's half of the question D474 added to the cast event, and it arrives second for a
       * reason worth keeping: the cast event carried the spell's subtypes from the start, so the
       * cast parse could read "a Spirit or Arcane spell" on day one, while this event carried only
       * types and the board parse had to refuse every tribe. **About 40 legal cards** print one,
       * spread over 30-odd shapes with one or two cards each — Dragon, Cartouche, Ally, Human,
       * Zombie, Vampire and a long tail.
       *
       * Any-of, and matched case-insensitively, exactly as the cast event's `ofSubtypes` is.
       */
      readonly ofSubtypes?: readonly string[];
      /** Set by the engine when it raises the event: the subject's live subtypes, as printed. */
      readonly subjectSubtypes?: readonly string[];
      /** Set by the engine when it raises the event: *which* permanent entered. See `subject`. */
      readonly subject?: string;
    }
  | {
      readonly kind: 'dies';
      /**
       * As `etb`: `self` is this creature dying, `another` is any other, `any` is both.
       *
       * `attached` is the fourth, and it is the Aura's or the Equipment's own creature — "when
       * enchanted creature dies" (52 legal corpus lines), "whenever equipped creature dies" (17).
       * D433 added it to `attacks` and `combat-damage` and deferred it here on a question about
       * ordering, and the answer was a defect: the dying creature is relocated *before* the event
       * is raised, and `relocate` detaches everything pointing at it, so by the time the trigger is
       * matched the attachment is gone. The event carries the hosts it had as it left (D437) — the
       * third reader in three increments to need a fact the state no longer holds.
       */
      readonly who?: 'self' | 'another' | 'any' | 'attached';
      readonly of?: 'you' | 'opponent' | 'any';
      /**
       * "Whenever a creature **dealt damage by ~ this turn** dies" — Sengir Vampire's sentence
       * (D566). `self` is this permanent as the thing that dealt the damage, and the only value:
       * the "dealt damage by enchanted creature" form is one card, refused where the row would be.
       *
       * Not a fact about the creature that died so much as about the pair, which is why it is not
       * one of the characteristic filters below: it is answered from `subjectDamagedBy`, the list
       * the engine copies onto the event from `AutomationState.damagedBy`, and matched in
       * `fireTrigger`, the one place that knows which permanent is watching. Any damage counts —
       * the Vampire's bite did not have to be what killed it (CR 603.10a reads the turn's record).
       */
      readonly damagedBy?: 'self';
      /** Set by the engine: the source refs that dealt this permanent damage this turn. */
      readonly subjectDamagedBy?: readonly string[];
      /** As `etb`'s, minus `land`: "whenever a land dies" is not a sentence Magic prints. */
      /** `creature-or-planeswalker` is Cruel Celebrant's: "dies" is said of exactly those two (CR 700.4). */
      readonly what?: 'creature' | 'permanent' | 'artifact' | 'enchantment' | 'creature-or-planeswalker';
      /**
       * Set by the engine when it raises the event: what was attached to the dying permanent as it
       * left the battlefield, which is what `who: 'attached'` is answered from.
       *
       * It has to travel with the event because `relocate` has already detached everything pointing
       * at the card by the time this is matched — the live board says the Aura is on nothing. See
       * `GameState.detached`.
       */
      readonly attachments?: readonly string[];
      /**
       * "a **nontoken** creature you control dies", which is how nearly every death payoff is
       * printed — and the clause that stops a deck of 1/1 tokens draining the table to zero by
       * accident. A token dying is still a creature dying; it is just not this trigger's business.
       */
      readonly nontoken?: boolean;
      readonly subjectSeat?: SeatIndex;
      readonly subjectIsCreature?: boolean;
      /** Set by the engine when it raises the event. */
      readonly subjectIsToken?: boolean;
      /**
       * Set by the engine: the counters the permanent had **before** it left, by counter name.
       *
       * Last known information (CR 608.2h / 603.6e), and the one piece of it a card in this pool
       * actually needs: a Hangarback Walker has to make a Thopter for each +1/+1 counter it had,
       * and by the time its own death trigger resolves the card is in a graveyard with no counters
       * at all — `relocate` wipes them on the way out, which is the rule. Read in the effect as
       * `EffectContext.subjectCounters`. Nothing wider is snapshotted: when a card needs the power
       * it had, or the types, this is where that goes.
       */
      readonly subjectCounters?: Readonly<Record<string, number>>;
      /**
       * **The characteristic filters** (D478): "a creature you control **with power 3 or greater**
       * enters", "**with toughness 4 or greater** dies", "**with a +1/+1 counter on it** dies",
       * "**with flying** enters".
       *
       * ~19 legal cards one unread line from a finished script print one of these, which made it
       * the largest thing D477's board parse had to refuse. All four are asked of what the event
       * carries — `subjectPower`, `subjectToughness`, `subjectCounters`, `subjectKeywords` — and
       * not of the board, because by the time a death trigger resolves the permanent is in a
       * graveyard with no counters and no keywords at all (CR 603.6e, and `subjectCounters`'
       * docblock is where this reading was first written down).
       *
       * Both bounds of each, because both halves are printed: "power 3 or greater" is Elemental
       * Bond and "power 2 or less" is Mentor of the Meek.
       */
      readonly powerAtLeast?: number;
      readonly powerAtMost?: number;
      readonly toughnessAtLeast?: number;
      readonly toughnessAtMost?: number;
      /** One counter the permanent has to have at least one of, by name: `'+1/+1'`. */
      readonly withCounter?: string;
      /** One keyword it has to have — "a creature you control **with flying** enters". */
      readonly withKeyword?: Keyword;
      /** Set by the engine when it raises the event: the subject's power and toughness as it was. */
      readonly subjectPower?: number;
      readonly subjectToughness?: number;
      /** Set by the engine when it raises the event: the keywords it had, lowercased. */
      readonly subjectKeywords?: readonly string[];
      /**
       * "Whenever a **Dragon** you control enters", "whenever another **Zombie** you control dies"
       * — the subtypes the permanent has to be one of (D479).
       *
       * The board's half of the question D474 added to the cast event, and it arrives second for a
       * reason worth keeping: the cast event carried the spell's subtypes from the start, so the
       * cast parse could read "a Spirit or Arcane spell" on day one, while this event carried only
       * types and the board parse had to refuse every tribe. **About 40 legal cards** print one,
       * spread over 30-odd shapes with one or two cards each — Dragon, Cartouche, Ally, Human,
       * Zombie, Vampire and a long tail.
       *
       * Any-of, and matched case-insensitively, exactly as the cast event's `ofSubtypes` is.
       */
      readonly ofSubtypes?: readonly string[];
      /** Set by the engine when it raises the event: the subject's live subtypes, as printed. */
      readonly subjectSubtypes?: readonly string[];
      /** Set by the engine when it raises the event: *which* creature died. See `subject`. */
      readonly subject?: string;
    }
  /**
   * "Whenever **you** attack" — one event for the whole declaration, not one per creature.
   *
   * The same moment as `attacks` below and a different question. `attacks` is about a creature, so
   * it is raised once per attacker; this is about the *declaration*, so it is raised once however
   * many creatures were in it (CR 508.1). 92 legal corpus lines print "Whenever you attack" and 5
   * the longer spelling of the same sentence, "Whenever one or more creatures you control attack" —
   * and until this event existed neither could be written, because reading them off `attacks` would
   * have fired an Adeline for every attacker instead of once per combat (D442).
   *
   * Raised only when at least one attack was declared, which is what "one or more" means: a seat
   * that attacks with nothing has not attacked.
   *
   * **A myriad token raises nothing here either**, for the reason the declaration handler's own
   * comment gives: a myriad token was never declared as an attacker (CR 508.4), so it is not part
   * of this declaration any more than it is part of battalion's count.
   *
   * There is no size filter and no type filter, and the corpus is why: 8 legal lines print
   * "with three or more creatures", 8 "with one or more <type>", 7 "a player", and each of those is
   * a restriction this event cannot express — so they stay unread rather than being read as the
   * bare declaration, which would be a wrong reading of a real card (D362). `withAtLeast` can
   * arrive here the day one of them is worth finishing.
   */
  | {
      readonly kind: 'attack-declared';
      /**
       * Whose declaration it watches. `you` is the default and the only form printed: "whenever
       * **you** attack" is about the watcher's own controller. The other two values exist because
       * every `by` in this file means the same three things, and a reader that needed "whenever an
       * opponent attacks" would otherwise be the one to invent a fourth vocabulary.
       */
      readonly by?: 'you' | 'opponent' | 'any';
    }
  | {
      readonly kind: 'attacks';
      /**
       * Whose attack it watches, exactly as `etb` and `dies`: `self` — the default, and what every
       * script written before this meant — is this permanent attacking, `another` is any other
       * creature, `any` is both.
       *
       * `attached` is the fourth, and it is the one an Aura or an Equipment needs: "Whenever
       * **equipped** creature attacks" watches neither this permanent (an Equipment does not
       * attack) nor any other creature (it is one particular creature) but *the permanent this one
       * is attached to*. 47 corpus cards print it of an Equipment and 18 of an Aura, and before
       * this value there was no way to say it, so every one of them was read as an unread line.
       *
       * Resolved at the call site in `fireTrigger` rather than inside `triggerMatches`, for the
       * reason that function's `self` clause gives: it is a fact about where the watcher is, not
       * about what the event was.
       *
       * It reads the **holder** rather than the defining card, which is what CR 113.6 says about a
       * granted ability — but that choice is **reasoning and not a tested property**, and a break
       * run is what established the difference: swapping `holder` for the defining card failed no
       * test at all. Nothing in the pool grants an attachment trigger, so for every card that
       * exists today the two are the same object. Said plainly here rather than left as a claim
       * the tests appear to support.
       */
      readonly who?: 'self' | 'another' | 'any' | 'attached';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the attacking creature. */
      readonly subjectSeat?: SeatIndex;
      /**
       * Set by the engine: what this attack was declared against.
       *
       * The one thing the other board-watching events do not need, and the reason it is on the
       * event rather than looked up on resolution: "deals 1 damage to the player or planeswalker
       * it's attacking" is about *that* attack, and by the time the trigger resolves the creature
       * may be dead, the attack may have been removed from combat, and the board will not say
       * what it was aimed at.
       */
      readonly attacked?: AttackedTarget;
      /**
       * Whether this creature was the only one declared as an attacker (CR 702.90b).
       *
       * One field read from both sides, because there is only one question: the engine writes it
       * on the event, and a trigger that asks for `alone: true` fires only when it was. Exalted
       * is the whole reason it exists, and exalted is unusual in caring — "attacks alone" is a
       * fact about the *declaration* and not about the creature, so nothing on the board can be
       * read later to find it out.
       */
      readonly alone?: boolean;
      /**
       * "Whenever this creature **and at least two other creatures** attack" — battalion's clause,
       * asked as a minimum size for the whole declaration (CR 702.102a).
       *
       * `alone` is the same question with the answer one, and the two are kept apart rather than
       * folded together because `alone: true` is five entries old and means something a number
       * cannot: *exactly* one. This is **at least** N, which is what every printed card that counts
       * attackers says.
       *
       * It has to travel on the event for exactly the reason `alone` does: a creature removed from
       * combat before the trigger resolves leaves a board that cannot be counted (CR 506.4), so the
       * size of the declaration is only knowable where the declaration happened.
       */
      readonly withAtLeast?: number;
      /** Set by the engine: how many creatures were declared as attackers in this declaration. */
      readonly declared?: number;
      /** Set by the engine when it raises the event: *which* creature attacked. See `subject`. */
      readonly subject?: string;
    }
  /**
   * "Whenever this creature blocks" — the blocker's half of the declaration (CR 509.1a).
   *
   * Raised once per block, so a creature that is allowed to block two attackers sees the event
   * twice, which is what the printed cards mean. The *blocking* creature is the subject, so `who`
   * and `of` mean exactly what they mean on `attacks`: a card watching its own block says nothing
   * and gets `self`.
   *
   * Which attacker it blocked travels on the event as `blocked`, for the same reason `attacks`
   * carries what it was aimed at: "**that creature** doesn't untap during its controller's next
   * untap step" is about the creature this block was against, and by the time the ability resolves
   * the board holds nothing that says which one that was — a second blocker may have been declared
   * on it, the attack may be gone from combat, and the blocker is just a tapped creature. Read in
   * the effect as `EffectContext.blocked`.
   */
  | {
      readonly kind: 'blocks';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the blocking creature. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: which creature blocked. See `subject`. */
      readonly subject?: string;
      /** Set by the engine: the attacker it blocked. See `EffectContext.blocked`. */
      readonly blocked?: string;
    }
  /**
   * "Whenever this creature becomes blocked by a creature" (CR 509.1h).
   *
   * The attacker is the subject and each blocker travels as `blocked`, which is the same pair of
   * roles the `blocks` event has and the opposite way round — so a card with both ("whenever ~
   * blocks **or becomes blocked by** a creature") reads `c.blocked` in either case and means the
   * other creature both times.
   *
   * Raised **once per blocker**, which is what "by a creature" means: a basilisk blocked by three
   * creatures destroys all three. Note the plain "becomes blocked", with no "by a creature", is a
   * different trigger that fires once however many blockers there are — nothing in the pool is
   * printed that way, and a card that was would want a separate event rather than this one with a
   * flag.
   */
  | {
      readonly kind: 'becomes-blocked';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the attacking creature. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: which creature became blocked. See `subject`. */
      readonly subject?: string;
      /** Set by the engine: one of the creatures blocking it. See `EffectContext.blocked`. */
      readonly blocked?: string;
    }
  /**
   * "Whenever this creature becomes blocked" — becoming a blocked creature, **once** (CR 509.1h).
   *
   * The batched half of `becomes-blocked`, and the same relation `combat-damage-dealt` has to
   * `combat-damage` (D443): that event is about the *other* creature and is raised once per
   * blocker, this one is about the creature becoming blocked and is raised once however many
   * creatures blocked it. **57 legal corpus lines** print it, and the event above says in so many
   * words that such a card wants its own event rather than that one with a flag — reading them off
   * `becomes-blocked` would pay an Alley Grifters' discard three times against three blockers,
   * which is a wrong reading of a real card (D362, D482).
   *
   * **Nothing travels on it about the blockers, deliberately.** There may be several, and the cards
   * that want them say "each creature blocking it", which is a question about the board when the
   * ability resolves rather than a fact about the declaration. A `blocked` field here would invite
   * exactly the per-blocker reading this event exists to avoid.
   */
  | {
      readonly kind: 'blocked-creature';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the creature that became blocked. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: the creature that became blocked. See `subject`. */
      readonly subject?: string;
    }
  /**
   * "Whenever this creature blocks" — becoming a blocking creature, **once** (CR 509.1a).
   *
   * `blocked-creature`'s mirror and `blocks`' batched half: raised once for a creature that blocked
   * at all, where `blocks` is raised once per attacker it blocked. The two readings agree for every
   * creature that blocks one attacker, which is nearly all of them — and the exception is a real
   * card rather than a hypothetical, because a creature that "can block an additional creature"
   * would otherwise pay this effect twice. **24 legal corpus lines** print it.
   *
   * Carries no attacker, for the reason `blocked-creature` carries no blocker.
   */
  | {
      readonly kind: 'blocking-creature';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the blocking creature. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: the creature that blocked. See `subject`. */
      readonly subject?: string;
    }
  /**
   * "Whenever this creature attacks and isn't blocked" (CR 509.1h).
   *
   * Not a filter on `attacks`, and the difference is the whole of the event: an attack trigger
   * fires as attackers are declared, when nobody has blocked yet and the answer is not knowable.
   * This one is raised at the end of the declare-blockers step, once every defender has said what
   * it is doing, which is the only moment at which "isn't blocked" is a fact.
   *
   * Carries `attacked` for the same reason `attacks` does — the ability may want the player it is
   * through to — and nothing else: the subject is the attacker, and there is no blocker to name.
   */
  | {
      readonly kind: 'attacks-unblocked';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the attacking creature. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: what the attack was declared against. */
      readonly attacked?: AttackedTarget;
      /** Set by the engine: which creature attacked. See `subject`. */
      readonly subject?: string;
    }
  /**
   * This permanent has left the battlefield, however it left (CR 603.6c) — destroyed, exiled,
   * bounced or sacrificed. Only its own script can care, which is why it takes no `who`: a card
   * that wants to watch *another* permanent leave would be watching the board rather than itself,
   * and nothing in the pool does.
   */
  | { readonly kind: 'leaves' }
  | { readonly kind: 'becomes-tapped' }
  /**
   * "Whenever ~ **is dealt damage**" — enrage, and every card printed before the word (D566).
   *
   * About the permanent the damage landed on, whoever dealt it and however much: one point from a
   * pinger and seven from a blocker are both "is dealt damage". It fires for a creature the damage
   * **killed**, which is the half that cannot be read off the board — a Ripjaw Raptor that takes
   * lethal damage still draws its card, from the graveyard, because the ability triggered when the
   * damage was dealt and state-based actions only noticed the body afterwards (CR 603.2, 704.3).
   * The engine raises it from `AutomationState.damageDealt`, once per landing of damage, and once
   * per **combat damage step** however many creatures dealt it — combat damage is simultaneous
   * (CR 510.2), so three blockers are one event where three pings are three.
   *
   * Its own permanent only, like `becomes-tapped` and `leaves`, so it takes no `who`: the board
   * forms ("a creature you control is dealt damage", "equipped creature is dealt damage") are two
   * legal cards between them and are refused where the row is.
   */
  | {
      readonly kind: 'damaged';
      /** Set by the engine: which permanent was dealt the damage. */
      readonly subject?: string;
    }
  /**
   * "Whenever ~ **deals damage to an opponent**" — any damage, not only combat damage (D566).
   *
   * `combat-damage` is the narrower sentence and stays its own event: that one is raised from the
   * combat step's own list and carries nothing about a burn spell or a pinger. This one is every
   * landing of damage **on a player** from a **permanent** — a Curiosity on a Prodigal Pyromancer
   * draws for the ping, which is the card the difference was printed for. A spell's damage raises
   * nothing here: the sentence is an ability of a permanent, about that permanent or the one it is
   * attached to, and an instant is neither.
   *
   * `to: 'opponent'` is asked from the **watcher's** side — an opponent of whoever controls the
   * permanent the trigger is printed on, which for an Aura on somebody else's creature is not the
   * creature's controller. `player` is the wider form, kept so the field means something when it
   * is absent. The seat that was hit travels as `defender`, down the same `attacked` channel the
   * combat events use, for an effect that says "that player".
   */
  | {
      readonly kind: 'deals-damage';
      readonly who?: 'self' | 'attached' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      readonly to?: 'opponent' | 'player';
      /**
       * "deals **combat** damage to an opponent" — the narrow form of the same sentence, for the
       * handful of cards that print "opponent" where `combat-damage` prints "player".
       */
      readonly combatOnly?: boolean;
      /** Set by the engine: who was dealt the damage, and whether it was combat damage. */
      readonly defender?: SeatIndex;
      readonly combat?: boolean;
      /** Set by the engine: which permanent dealt it, and who controlled it. */
      readonly subject?: string;
      readonly subjectSeat?: SeatIndex;
    }
  /**
   * "When this permanent is turned face up" — morph's own trigger (CR 702.37d).
   *
   * Its own permanent only, like `becomes-tapped`: a card that watched somebody *else's* morph
   * turn over would be reading the board, and nothing is printed that does.
   *
   * It is **not** an entry trigger, and that is the whole reason it exists as its own kind. A
   * morph entered the battlefield face down, turns after the fact, and is not a new object when it
   * does — so an `etb` trigger has already fired and will not fire again, and a card whose text
   * only works once it is face up has nowhere else to hang. The two are a pair of opposites worth
   * saying out loud: an entry trigger on a morph fires while the card has no abilities to fire it,
   * and this one fires when the card gets them.
   */
  | { readonly kind: 'turned-face-up' }
  /**
   * "When this creature transforms into ~" — a transforming double-faced card's own trigger
   * (CR 701.28, CR 603.2).
   *
   * Its own permanent only, like `turned-face-up` and for the same reason: a card that watched
   * somebody else's werewolf turn over would be reading the board, and nothing is printed that
   * does.
   *
   * **Which face it became is not a field on the event, and that is the design rather than a
   * shortcut.** A transform moves the instance's `defKey` before `settle` raises this, so the
   * script that receives it is already the face the permanent now *is* — put the trigger on the
   * back face and it fires on transforming into that face, put it on the front and it fires on
   * transforming back. The printed wording "transforms into Awoken Horror" is therefore the name
   * of the script it is written on, which is the same trick that lets a modal card's back face
   * carry its own abilities.
   *
   * Like `turned-face-up` it is **not** an entry trigger: the permanent was already on the
   * battlefield, is not a new object, and its `etb` has long since fired.
   */
  | { readonly kind: 'transformed' }
  /**
   * "Whenever day becomes night or night becomes day" (CR 726, D593).
   *
   * The change itself, not the time of day: raised when one becomes the other as a turn begins,
   * and **not** when a game that was neither first becomes day — "day becomes night" needs a day
   * to have been. Watched from the battlefield, like a step.
   */
  | { readonly kind: 'day-night' }
  /**
   * "Whenever ~ deals combat damage to a player."
   *
   * To a *player*, always: that is the half of the templating the cards in this pool use and the
   * half the engine records. Damage to a creature or a planeswalker raises nothing, which is said
   * out loud here because the shorter name would promise more than it does.
   *
   * Watched by the whole battlefield, like a death and unlike `becomes-tapped`. It was its own
   * permanent only until D433 found that an Equipment could never see its own printed line, and
   * `who: 'any'` is the other half of the same widening: "whenever **a creature you control** deals
   * combat damage to a player" is 33 legal lines and 9 compilable cards (D439).
   *
   * The seat that was hit reaches the ability through `EffectContext.attacked`, the same channel an
   * attack trigger uses: `c.attacked.defender` is "the player this event was about". In a duel that
   * is the only opponent; in a pod it is the one who was actually attacked, which is the whole
   * reason it travels rather than being worked out.
   */
  | {
      readonly kind: 'combat-damage';
      readonly defender?: SeatIndex;
      /**
       * Which seat controlled the creature that dealt it. Set by the engine when the event is
       * raised, never by a script — it is what `of` is answered from.
       */
      readonly subjectSeat?: SeatIndex;
      /**
       * `self` — the default, and what every script written before this meant — is this creature
       * dealing the damage. `attached` is the Equipment's reading of the same line: "Whenever
       * equipped creature deals combat damage to a player" is about the creature it is attached
       * to, which is 45 corpus cards. `any` is somebody's creature — narrowed by `of` to yours,
       * which is the only form printed.
       *
       * `another` exists because this event is resolved in the same branch of `triggerMatches` as
       * `etb`, `dies` and the three combat events, where `who` has to mean one thing on all of
       * them (D439). No card in the corpus asks for it.
       */
      readonly who?: 'self' | 'attached' | 'another' | 'any';
      /**
       * Whose creature dealt it — "a creature **you control**", which is how every printed line in
       * this family narrows `who: 'any'`. Defaults to `any` in the matcher, so nothing written
       * before this changes meaning.
       */
      readonly of?: 'you' | 'opponent' | 'any';
    }
  /**
   * "Whenever **one or more** creatures you control deal combat damage to a player."
   *
   * The batched half of `combat-damage`, and the same relation `attack-declared` has to `attacks`:
   * that event is about a creature and is raised once per creature that connected, this one is
   * about the hit and is raised **once** however many creatures were in it. 26 legal corpus lines
   * print it and 8 are cards this compiler can finish — D439 refused the prologue on exactly this
   * ground, because read off `combat-damage` a Grim Hireling would make two Treasures *per
   * attacker* instead of two per hit (D443).
   *
   * **Once per damaged player**, not once per combat, and the templating is the evidence: Anowon,
   * the Ruin Thief prints "whenever one or more Rogues you control deal combat damage to a player,
   * **that player** mills a card for each 1 damage dealt to them", and "that player" can only mean
   * one. So a swing that connects with two opponents at once is two triggers, each about one of
   * them, which is also the only reading that makes `defender` a single seat. In a duel the two
   * readings agree, which is why this is said out loud rather than left to a test.
   */
  | {
      readonly kind: 'combat-damage-dealt';
      /**
       * Whose creatures dealt it. `you` is the default and the only form printed — "creatures
       * **you control**" — with the other two values present so `by` means the same three things
       * here as everywhere else in this file.
       */
      readonly by?: 'you' | 'opponent' | 'any';
      /**
       * Set by the engine: the player who was hit, carried for "that player". It reaches the
       * ability through `EffectContext.attacked`, the same channel `attacks` and `combat-damage`
       * use, so there is one way an ability learns which player its event was about.
       */
      readonly defender?: SeatIndex;
    }
  | {
      readonly kind: 'spell-cast';
      readonly by?: 'you' | 'opponent' | 'any';
      /**
       * "Your **second** spell each turn" — the ordinal this cast has to be for the trigger to
       * fire, counted per caster rather than for the table. 47 legal lines print the second and 3
       * the first (D440).
       *
       * The same pair as the draw family's `onNth`: this field is what the script asks for and
       * `nth` below is what the engine puts on the event. Two names for the two directions, so a
       * script cannot accidentally read the engine's answer as its own question.
       */
      readonly onNth?: number;
      /**
       * Which of its caster's spells this was, this turn — 1 for the first. Set by the engine when
       * the event is raised, never by a script.
       */
      readonly nth?: number;
      /**
       * "When you cast **this** spell" — the card's own cast, watched from the stack (CR 603.2d).
       *
       * The one trigger in this engine that does not fire from the battlefield. Every other
       * watcher is a permanent in play; this one is the spell itself, sitting on the stack with its
       * own ability going on top of it, which is what cascade, storm, replicate and conspire all
       * abbreviate. `raise` includes the card being cast in the watcher list **only** for triggers
       * that set this, so an ordinary cast watcher — a Guttersnipe, a prowess creature — cannot
       * accidentally fire off its own casting on the way to the battlefield.
       *
       * It implies the caster is you, so `by` is not asked: a spell is cast by its own controller.
       */
      readonly self?: true;
      /**
       * Which spells count. `noncreature` is prowess; `instant-or-sorcery` is the narrower one
       * Talrand and friends want, and it is a separate option rather than being folded into
       * `noncreature` because an artifact is a noncreature spell and is not an instant.
       */
      readonly spell?: 'creature' | 'noncreature' | 'instant-or-sorcery' | 'any';
      /**
       * "Whenever you cast an **artifact** spell" — one lowercased card type the spell must have.
       *
       * The question `types` below is the answer to, which is the same split `spell`/`types` and
       * `from`/`cameFrom` already keep: one field is what a card asks and the other is what the
       * engine supplies, and a field that is both ends up being neither.
       *
       * Separate from `spell` rather than another value in it, because `spell` is answered from the
       * engine's own creature/noncreature split and this is answered from the type line. An
       * artifact creature spell is a creature spell *and* an artifact spell, so the two filters
       * have to be askable together rather than instead of each other.
       *
       * Measured before it was added (D435): 17 legal corpus lines print "an enchantment spell" and
       * 21 "an artifact spell", with 9 and 7 cards respectively whose body this compiler already
       * reads. "A **historic** spell" (19 lines, 4 cards) is deliberately **not** expressible here —
       * artifact-or-legendary-or-Saga is not a card type, and a reading that pretended otherwise
       * would fire on the wrong spells. "A **multicolored** spell" was refused beside it on the
       * stated ground that it is "a fact about the mana cost"; that was wrong — CR 105.1 makes it a
       * fact about the card's colours — and it has its own field below since D474.
       */
      readonly ofType?: string;
      /** Set by the engine when it raises the event: the spell's card types, lowercased. */
      readonly types?: readonly string[];
      /**
       * "Whenever you cast a **white** spell", and "a **blue or black** spell" — the colours the
       * spell has to be one of (CR 105.2).
       *
       * Measured before it was added (D474): the cast prologue is the biggest family in the
       * `prologue-gap.mjs` ranking, and **46 legal cards** one unread line from a finished script
       * print a colour in it — 16 for "you", 20 for "a player", 10 for "an opponent". It is a
       * question about the spell on the stack rather than about a card type, so it cannot ride in
       * `ofType`: a white artifact spell is both, and an artifact spell is not a colour.
       *
       * A **list, answered any-of**, because the corpus prints both widths and the two-colour
       * spelling means exactly that: a Mold Adder's "a blue or black spell" fires on a spell that
       * is either, and a Snake Pit's does too. A spell that is both still fires it once, which is
       * what one event per cast already gives.
       */
      readonly ofColours?: readonly Color[];
      /**
       * "Whenever a player casts a **multicolored** spell" — two or more colours (CR 105.1).
       *
       * **This was refused twice before it was read** (D435, D440), on the ground that multicolored
       * "is a fact about the mana cost" rather than a card type. The first half of that was simply
       * wrong: CR 105.1 makes it a fact about the card's *colours*, which the engine has always
       * computed and, since D474, puts on this event. So the refusal came off with the field it was
       * waiting for, and the 8 legal cards behind it read.
       *
       * Asked of the event's colours rather than of a count on the card, so a spell made
       * multicoloured by an effect counts and a face-down one — colourless, CR 708.2 — does not.
       */
      readonly multicoloured?: true;
      /** Set by the engine when it raises the event: the spell's colours (CR 202.2). */
      readonly colors?: readonly Color[];
      /**
       * "Whenever you cast a **Spirit or Arcane** spell" — the subtypes the spell has to be one of.
       *
       * Kamigawa's whole block prints this one line, and it is the largest single cast spelling in
       * the corpus after the colours: **16 legal cards** one unread line from a finished script say
       * "Spirit or Arcane", and another eight name a single tribe (Goblin, Giant, Wizard, Elf,
       * Pirate, Knight, Aura, Eldrazi).
       *
       * Separate from `ofType` rather than folded into it, because the two sides of a type line are
       * different questions: *Arcane* is a subtype of an instant and *artifact* is a type, and a
       * field that accepted either would make "an Aura spell" and "an artifact spell" look like the
       * same kind of filter when one is read off the back of the dash and one off the front.
       * Compared case-insensitively, since the printed line capitalises a subtype and the engine
       * lowercases nothing on the way past.
       */
      readonly ofSubtypes?: readonly string[];
      /** Set by the engine when it raises the event: the spell's subtypes, as printed. */
      readonly subtypes?: readonly string[];
      /**
       * "Whenever you cast a spell **that targets** this creature" — heroic (CR 702.86a).
       *
       * **40 legal cards** one unread line from a finished script print it, which made it the
       * largest single thing the D474 cast parse had to refuse: 22 under the `Heroic` ability word,
       * 7 under `Repartee`, and 11 that print the sentence bare. It is the second-biggest prologue
       * family in the corpus after the cast filters themselves (D476).
       *
       * Answered in `fireTrigger` rather than in `triggerMatches`, beside `self` and the
       * attachment, and for the same reason their own comments give: it is a question about
       * **which permanent is watching**, not about what the event was, and `triggerMatches` is not
       * told the holder. The targets travel on the event as `targetIds` because a trigger resolves
       * after the spell may have left the stack.
       *
       * Card targets only. A spell that targets *you* does not trigger your creature's heroic, and
       * "a spell that targets you or a creature you control" — Reparations, Danitha — is a
       * different sentence this does not read.
       */
      readonly targetsSelf?: true;
      /**
       * Set by the engine when it raises the event: the **card** targets the spell was cast with,
       * as instance ids. Player and ability targets are deliberately absent — see `targetsSelf`.
       */
      readonly targetIds?: readonly string[];
      /**
       * "Whenever you cast a spell with **mana value 4 or greater**" — the floor, inclusive.
       *
       * 16 legal cards print a mana-value bound in a cast prologue (D474). Two fields rather than
       * one signed comparison, because both halves are printed — "or greater" and "or less" — and
       * a card that printed both would be asking for a range rather than for two readings of one
       * bound.
       *
       * The value is the spell's **mana value as it was cast**, which the event carries: by the
       * time the trigger resolves the object may be gone, and an {X} spell's mana value on the
       * stack counts X as chosen (CR 202.3b) — which is what the engine supplies in `manaValue`.
       */
      readonly manaValueAtLeast?: number;
      /** "…with mana value 3 or less" — the ceiling, inclusive. See `manaValueAtLeast`. */
      readonly manaValueAtMost?: number;
      /** Set by the engine when it raises the event: the spell's mana value as cast. */
      readonly manaValue?: number;
      /**
       * Set by the engine: the spell on the stack, so a trigger can read it or answer it.
       *
       * The `spell` and `types` fields above say what *kind* of spell was cast, which is all
       * prowess and Talrand ever needed. This is *which one*, and it is what a card has to have to
       * say "counter **it**" — a Chalice of the Void reads the spell's mana value and counters that
       * spell, and neither half is expressible from a kind. It reaches the ability as
       * `EffectContext.answering`, the same channel ward uses for the spell that targeted it.
       */
      readonly object?: string;
      /**
       * Whether a **cast** or a **copy** counts — magecraft's "whenever you cast **or copy** an
       * instant or sorcery spell" (CR 702.?? reminder text; the rule underneath is CR 707.12,
       * which is why the card has to say both).
       *
       * **A copy of a spell is not cast.** It is put onto the stack by an effect, nobody announces
       * it, and no cost is paid — which is exactly why every card with magecraft spells the two
       * out and why storm, cascade, Chalice of the Void and prowess must *not* see it. So the
       * default is `cast`, and every watcher written before this one keeps counting what it always
       * counted: `storm` counts spells cast this turn, a Chalice answers a spell somebody cast.
       *
       * `any` is the magecraft reading and the only one in the pool. `copied` alone is not printed
       * on anything here and exists because the other two make it free.
       *
       * It took a Twincast to matter. The two magecraft cards carried a comment saying the copy
       * half was unreachable — "nothing in this pool copies an instant or a sorcery" — which was
       * true when it was written and stopped being true when Twincast arrived (D131), and nothing
       * noticed for eight entries. See D231.
       */
      readonly how?: 'cast' | 'copied' | 'any';
    }
  /**
   * "Whenever this permanent becomes the target of a spell or ability" (CR 115.7, CR 702.21b).
   *
   * Its own permanent only, like `becomes-tapped`: a card that watched *another* permanent being
   * targeted would be watching the stack rather than itself, and nothing is printed that does.
   *
   * `by` is the half that matters, and it defaults to `opponent` rather than to `you` — the
   * opposite of every other event here. Ward is the only reason this exists and ward never
   * triggers off its own controller's spells, so the default is the one that is right for the one
   * caller; a card that wanted both would say `any` out loud.
   */
  | {
      readonly kind: 'targeted';
      readonly by?: 'you' | 'opponent' | 'any';
      /** Set by the engine when it raises the event: the stack object that did the targeting. */
      readonly object?: string;
    }
  | { readonly kind: 'life-gained'; readonly by?: 'you' | 'any' }
  /**
   * "Whenever you **discard** a card" — and "whenever you **cycle or discard** a card", which is
   * the same event (D567).
   *
   * One event per card discarded, from a hand to a graveyard, whoever or whatever caused it: an
   * opponent's Mind Rot, your own looter, a cost. A card whose discard was replaced by madness was
   * still discarded (CR 702.35a replaces where it goes, not whether it happened), and it is in the
   * same list. Raised from `AutomationState.discarded`, with the discarding seat as the actor, so
   * `by` is answered the way `life-gained` and `draws` answer theirs.
   *
   * "Cycle or discard" needs no second event because cycling **is** discarding: the printed ruling
   * on Drake Haven is that the ability triggers once when you cycle a card, not twice.
   */
  | { readonly kind: 'discards'; readonly by?: 'you' | 'opponent' | 'any' }
  /**
   * "Whenever you **sacrifice** a permanent" — the act, not the death (D570).
   *
   * Raised once per permanent sacrificed, from `AutomationState.sacrificed`, with the seat that
   * sacrificed it as the actor. Not the `dies` event with a filter: an artifact, a Clue or a
   * Treasure is sacrificed without dying, and a creature killed by a Doom Blade died without being
   * sacrificed. The two overlap only when a creature is sacrificed, and then both are raised —
   * which is right, because Mayhem Devil and Blood Artist are both entitled to that creature.
   *
   * | field | printed |
   * | --- | --- |
   * | `by` | "**you** sacrifice", "an **opponent** sacrifices", "a **player** sacrifices" |
   * | `what` | "a permanent", "a **creature**", "an **artifact**", "a **token**" |
   * | `ofSubtypes` | "a **Clue**", "a **Treasure**", "a **Food**" |
   * | `who` | `another` is "**another** permanent"; `self` is "when you sacrifice **this**" |
   *
   * `who` defaults to `any`, and that includes the watcher itself: a Korvold sacrificed to an
   * edict still sees a permanent of yours sacrificed (CR 603.10a — a zone-change trigger looks
   * back). `another` is the printed word that rules it out. Every filter is asked of what the
   * permanent was **as it left**, carried on the event, because a token has ceased to exist and a
   * card in a graveyard has no types the layers gave it.
   */
  | {
      readonly kind: 'sacrifices';
      readonly by?: 'you' | 'opponent' | 'any';
      readonly who?: 'self' | 'another' | 'any';
      readonly what?: 'permanent' | 'creature' | 'artifact' | 'token';
      readonly ofSubtypes?: readonly string[];
      /** Set by the engine: which permanent, and what it was as it left. */
      readonly subject?: string;
      readonly subjectSeat?: SeatIndex;
      readonly subjectIsCreature?: boolean;
      readonly subjectIsToken?: boolean;
      readonly subjectTypes?: readonly string[];
      readonly subjectSubtypes?: readonly string[];
    }
  /**
   * "Whenever you **cycle** a card", and a card's own "when you cycle this card" (D567).
   *
   * Narrower than `discards`: only a discard that paid a cycling cost. The activation records it
   * (`AutomationState.cycled`) because nothing else can tell a cycled card from a discarded one.
   *
   * `self` is the card watching its **own** cycling — Decree of Silence's "When you cycle ~, you
   * may counter target spell" — and it is the second trigger in the engine that fires from a card
   * that is not on the battlefield and never was: the cycled card is in a graveyard, having gone
   * there from a hand. `raise` offers the event to it for exactly that trigger and no other, the
   * way a spell on the stack is offered its own cast.
   */
  | {
      readonly kind: 'cycles';
      readonly by?: 'you' | 'opponent' | 'any';
      readonly self?: boolean;
      /** Set by the engine: which card was cycled. */
      readonly subject?: string;
    }
  /**
   * "Whenever you draw a card" (CR 121.2), and the opponents' half of it.
   *
   * One event per card, so "draw three cards" fires it three times. `by` works the way it does on
   * `spell-cast` rather than the way it does on `life-gained`: `you` is the default, `opponent` is
   * Underworld Dreams, and `any` is a card that does not care whose draw it was.
   *
   * It does **not** fire for a card put into a hand by anything other than a draw — a tutor, a
   * Gravedigger, a Man-o'-War. That is the rules rather than a simplification, and it is the whole
   * reason the event is recorded where a draw happens instead of being noticed afterwards. See
   * `GameState.drew`.
   */
  /**
   * A card drawn, one event per card (CR 121.1).
   *
   * `onNth` is "whenever you draw your **second** card each turn" — the seat's own ordinal since
   * the turn began, and the only printed ordinal worth reading: 63 of the 65 legal corpus lines
   * that name one say "second" (54 of them "you", 6 "an opponent", 3 "a player"), with a single
   * "first" and a single "fifth" left unread and counted in `TRIGGER_SHAPES` (D436).
   *
   * It is the **question**, and `nth` below is the engine's answer, which is the same split
   * `withAtLeast`/`declared` already keeps for battalion. Asked of the event's own ordinal rather
   * than of `cardsDrawnThisTurn`: a `draw(2)` on an untouched turn raises two events and the
   * running total has already reached 2 by the time either is matched, so a reading taken from the
   * total would fire both times. Miracle learned this first (D204) and its comment says so.
   */
  | {
      readonly kind: 'draws';
      readonly by?: 'you' | 'opponent' | 'any';
      readonly onNth?: number;
      /** Set by the engine when it raises the event: this card's place in the seat's own turn. */
      readonly nth?: number;
    }
  /**
   * "Whenever another card is put into a graveyard from anywhere" (CR 400.7).
   *
   * The wider half of `dies`, and the four ways it happens are four different callers: a permanent
   * destroyed, a card milled off a library, a card discarded out of a hand, and a spell that has
   * finished resolving. Only the first of those is a death, which is why this is its own event and
   * not a `who` on that one — see `GameState.toGraveyard`.
   *
   * **`who` defaults to `another`, which is the opposite of every other event here**, and the
   * default is the card rather than a convention: Planar Void was written first and says "another
   * card", so a trigger that says nothing means what that card means. `self` is Rancor — "when
   * Rancor is put into a graveyard from anywhere, return it to its owner's hand" — which is the
   * one shape that needs a watcher to fire from the graveyard it has just reached, the way a
   * `dies` trigger fires from the one its creature is in.
   *
   * There is still no `by` and no `what`. Both would be fields nothing fires, and the rule this
   * engine keeps is that an option with no card behind it is worse than no option: `becomes-tapped`
   * is the trigger with no card at all and it is deliberate, `draws` has no `any` for the same
   * reason. The day a card wants "whenever a *creature* card is put into *your* graveyard", the
   * event already carries the subject and the seat to ask with.
   */
  | {
      readonly kind: 'to-graveyard';
      /**
       * Which card the trigger is about: `another` (the default, Planar Void), `self` (Rancor), or
       * `any`. The same three words the five board events take, so a reader who knows one knows
       * this — except for the default, which is `another` here and `self` there.
       */
      readonly who?: 'self' | 'another' | 'any';
      /**
       * Where the card has to have come from. `anywhere` — the default — is what the event has
       * always meant: Planar Void exiles a card that was milled, discarded or countered as readily
       * as one that died. `battlefield` is the narrower printed sentence and by far the commoner:
       * "When ~ is put into a graveyard **from the battlefield**", which is how a noncreature
       * permanent says "dies" (CR 700.4).
       *
       * **The narrow one was read as the wide one until D569**, by both table rows and by the pool's
       * own Rancor: an Undying Rage discarded to hand size returned itself to its owner's hand. It
       * went unseen for a hundred increments because a card coming back a turn late looks like
       * nothing, and then D568 made the cleanup step hold priority and a pod looped on it for two
       * thousand moves — discard, return, discard.
       */
      readonly from?: 'battlefield' | 'anywhere';
      /**
       * Set by the engine when it raises the event: **which** card arrived in a graveyard, so the
       * ability can say "exile that card" (CR 400.7). Read through `EffectContext.subject`, the
       * same channel exalted and evolve read their creature through.
       */
      readonly subject?: string;
      /** Set by the engine: whose graveyard it arrived in. Nothing reads it yet; see above. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: `battlefield` when the card arrived from there, absent otherwise. */
      readonly cameFrom?: 'battlefield';
    }
  /**
   * "Whenever a creature you control is exiled" (CR 400.7) — the last zone change nothing could
   * read.
   *
   * The family `to-graveyard` opened, finished. Seven callers put a card into exile — a blink, an
   * exile-until-this-leaves, a foretell, a suspend, an escape cost, a replacement that exiles
   * instead of burying, and a spell exiled rather than put into a graveyard — and until this event
   * existed every one of them happened in silence, which is why the pool's whole blink package had
   * nothing to pay it off.
   *
   * **No `who`, which is the one place this differs from the rest of the family**, and the reason
   * is where a watcher has to be. `dies`, `leaves` and `to-graveyard` each let their own subject
   * fire from the zone it has just reached, and each of those exceptions was carved for a printed
   * card. Nothing is printed that fires from exile: a card there is gone, and a Soulherder caught
   * by its own blink would put a counter on an object that no longer exists (CR 400.7). So the
   * event is watched from the battlefield only.
   *
   * The three fields it does take are the three words of the one printed phrase it exists for, and
   * each is a fact the move itself destroys — see `ExiledCard`, where they are recorded.
   */
  | {
      readonly kind: 'to-exile';
      /**
       * Where it came from. `battlefield` is "a creature **you control**", which only a permanent
       * can be: a creature card exiled out of a graveyard to pay for escape is not that, and after
       * the move the two look identical.
       *
       * Two options rather than the seven zones, because the record carries the real zone and a
       * narrower filter is a line the day a card wants one.
       */
      readonly from?: 'battlefield' | 'anywhere';
      /**
       * Set by the engine: the zone it actually came from, which is what `from` above is compared
       * against. Separate from the filter for the reason `spell-cast` keeps `spell` and `types`
       * apart — one is the question a card asks, the other is the answer the engine supplies, and
       * a field that is both ends up being neither.
       */
      readonly cameFrom?: ZoneId;
      /** "A **creature**", asked of what it was as it left rather than of its printed type line. */
      readonly what?: 'creature' | 'any';
      /** Whose it was as it left: `you` is Soulherder's word, and the default asks nothing. */
      readonly whose?: 'you' | 'opponent' | 'any';
      /** Set by the engine: which card was exiled, so an ability can say "that card". */
      readonly subject?: string;
      /** Set by the engine: who controlled it as it left — not where its exile zone is. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: whether it was a creature as it left. */
      readonly subjectIsCreature?: boolean;
    }
  /**
   * A step of the turn beginning, which every step now raises (D434).
   *
   * `of` is whose turn it has to be, and the three values are three different printed sentences
   * rather than a convenience:
   *
   *  - `you` — "At the beginning of **your** upkeep", 804 legal corpus lines. The default, because
   *    it is what a card says when it says nothing else, and because every script written before
   *    `of` existed meant it.
   *  - `any` — "At the beginning of **each** end step", "of **each player's** upkeep", "of **the**
   *    end step". 341 legal lines across the steps, and already what several hand-written cards
   *    ask for.
   *
   * There is deliberately **no** `opponent`, and the reason is measured rather than stylistic: 43
   * legal corpus lines print "each opponent's upkeep" or its two siblings, and the compiler can
   * finish the body of **none** of them, so the field, its matcher arm and its three prologue rows
   * would all be machinery no card exercises. The counts are in `TRIGGER_SHAPES`' step-family
   * table so the question can be re-asked in one command. In a duel it would be `any` minus your
   * own turn; in a pod it is three turns of four, so it cannot be approximated by either of the
   * values above when a card does arrive.
   */
  | { readonly kind: 'step'; readonly step: Step; readonly of?: 'you' | 'any' }
  /**
   * A Saga's chapter, which fires when its lore counter *reaches* this number (CR 714.2b).
   *
   * Not a step trigger and not an entry trigger, and it is worth being clear why neither would do.
   * A step trigger would fire on a turn the Saga had already finished, and would fire on the same
   * chapter twice if the counters were ever changed by something else. An entry trigger fires once,
   * at a moment, and a Saga's whole shape is that it says three different things on three different
   * turns. The counter is the state and the chapter is what reaching a number *means*.
   *
   * `n` is the chapter the ability is printed as: I is 1. Two chapters may share a number only by
   * being written as one ability, the way the printed cards do ("I, II — ...").
   */
  | { readonly kind: 'chapter'; readonly n: number };

/**
 * A question a card asks *while it is resolving* (CR 608.2).
 *
 * The distinction from a `TargetSpec` is the whole point. A target is chosen as the spell goes on
 * the stack, by its controller, from a public zone, and an opponent may respond to it. A decision
 * is made as the spell resolves, possibly by somebody else, possibly from a hidden zone, and
 * nobody can respond — the spell is already resolving. Writing "search your library for a creature
 * card" as a target would get every one of those wrong.
 *
 * The engine asks each spec in turn and hands the answers to the effect as `ctx.decisions`, in the
 * same order. A spec whose zone turns out to hold nothing it would accept is not asked at all: a
 * prompt with no answer is a stuck game, which is exactly what the old graveyard-targeting bug was.
 */
/**
 * A question a card asks while it is resolving, and whose answer is a set of **cards**.
 *
 * One of the two shapes of `DecisionSpec`. See `ChoiceDecisionSpec` for the other.
 */
export interface CardsDecisionSpec {
  /**
   * Ask this question **only if** an earlier answer in the same resolution was this word (D450).
   *
   * The engine asks a resolution's questions in order and applies the answers at the end. Without
   * this, every question in the list is asked — so "you may search your library for a basic land
   * card" opened the library *before* the yes-or-no could be read, and a player who declined had
   * seen their library anyway. That is both a wrong reading and an information leak, and it is why
   * the compiler refused the whole family (D447, D448). **128 legal cards are one line short on it.**
   *
   * The word is matched against the **most recent earlier answer that carries one** — a
   * `ChoiceDecisionSpec` answer, since those are the only ones with an `option`. Most recent rather
   * than "the one before", because a question can expand into several plan entries (`each-opponent`
   * asks one per seat) and the index of "the one before" is then not a fact the card knows.
   *
   * A question that is skipped is **answered empty**, not dropped: the answers keep their positions,
   * so `chosenCards(c, 1)` still means the second question whether or not the first one ran. An
   * empty answer is what every other unasked question already produces — an eliminated seat, a
   * zone with nothing in it — so nothing downstream needed teaching.
   */
  readonly askOnlyIfChosen?: string;
  /**
   * Ask this question **only if** the board says so, as the question comes up (D590).
   *
   * `askOnlyIfChosen`'s sibling, for a condition that is a fact rather than an earlier answer:
   * explore's "you may put that card into your graveyard" is asked only when the card it revealed
   * is **not** a land. Asked of the state as it stands when the question is reached — after the
   * resolution's `beforeDecisions` — with the controller and the source. Skipped the same way, as
   * an empty answer, so the positions effects index by do not move.
   */
  readonly askOnlyIf?: (state: GameState, controller: SeatIndex, source: string) => boolean;
  /**
   * Who chooses. "Target player discards two cards" is chosen by the player discarding, not by the
   * caster — getting that wrong would make Mind Rot a very different card. `each-player` and
   * `each-opponent` expand into one question each, asked in turn order starting from the active
   * player (CR 101.4), because who answers first is sometimes the whole card: the second player to
   * sacrifice has seen what the first gave up.
   *
   * ## `hit-player` and `acting-player`: the player a TRIGGER'S EVENT was about (D530)
   *
   * "Whenever ~ deals combat damage to a player, that player discards a card" is Abyssal Specter,
   * and the question it asks is the same one Mind Rot asks — chosen by the player discarding — but
   * aimed at a player nobody targeted. `target-player` cannot express it: `decisionPlan` resolves
   * that word off the stack object's **targets**, a trigger has none, and the question would be
   * asked of nobody while the ability resolved and said so in the log. That is the D362 failure in
   * its worst form, so the word is the fix rather than a target nobody chose.
   *
   * Two words and not one, matching the two gates in `eventRelativeEffect` exactly:
   *
   * - **`hit-player`** is `StackObject.attacked.defender`, the seat a combat-damage or
   *   combat-damage-dealt event says was hit. Asks nobody if the object carries no attack.
   * - **`acting-player`** is `StackObject.actor`, the seat whose action raised the event, falling
   *   back to the **controller** — and that fallback is the value rather than a guess: `fireTrigger`
   *   leaves `actor` off when the actor *is* the watcher's own controller, so an absent actor on
   *   such a trigger means "me" (D474, and `EffectContext.actor` says so too).
   *
   * They are kept apart rather than merged into one "the event's player", because merging them
   * needs a fallback between them and that fallback is where a wrong player would hide: a
   * combat-damage object with no `attacked` would quietly ask the attacking creature's own
   * controller to discard.
   */
  readonly who: 'controller' | 'target-player' | 'each-player' | 'each-opponent'
  | 'hit-player' | 'acting-player' | 'referent-player';
  /**
   * Which zone. From the chooser's own side unless `fromSeat` says otherwise. `library` is a
   * search: the chooser may look through the whole library while deciding, as they would at a
   * table, and it is shuffled afterwards (CR 701.19e) — which is also what stops them keeping the
   * order they just read.
   */
  readonly from: DecisionZone;
  /**
   * **Whose** zone the candidates come out of, when that is not the chooser's (D531).
   *
   * Default `chooser`, which is every question written before this field existed, so nothing had
   * to change. `target-player` is the pool on the spell's player target while the *chooser* stays
   * whoever `who` names.
   *
   * One family needs it and it is the one this field was measured for: "Target opponent reveals
   * their hand. You choose a nonland card from it. That player discards that card." — Dark Inquiry,
   * Distress, Despise, Brainbite, Collective Brutality and the rest, **95 unread legal lines** on
   * the sentence. The whole point of the card is that the **caster** picks. Asking the discarding
   * player instead is a different card, and that card already exists: it is Mind Rot.
   *
   * Splitting chooser from pool is therefore not a convenience. Before this, `who` meant both at
   * once — `decisionCandidates` read `zoneKey(chooser, from)` — so the family could not be
   * expressed at all, and reading it with `who: 'target-player'` would have compiled a card that
   * works and does the wrong thing (D362), which is worse than the unread line.
   *
   * It does **not** widen what a player may see on its own. `canIdentify` decides that, and it
   * authorises reading a hidden card off the engine's own candidate list — the same list an
   * `auto:decide` answer is checked against — rather than off a second rule that could disagree
   * with it. That is the discipline scry already uses for a library.
   */
  readonly fromSeat?: 'chooser' | 'target-player';
  /**
   * For `library-top`: how many cards off the top the question is about. Ignored everywhere else.
   *
   * The cards not chosen stay on top in the order they were already in. That is scry as far as
   * this engine goes — the printed keyword also lets you reorder the ones you keep, which needs a
   * question whose answer is a sequence rather than a set, and no card in the pool turns on it.
   */
  readonly look?: number;
  /**
   * For `library-top`: where the cards the chooser picks go. `'bottom'` by default (D452).
   *
   * Scry and surveil are the **same question** with two destinations (CR 701.18, CR 701.42): look
   * at the top N, and the ones you pick either go to the bottom of your library or into your
   * graveyard. The putting-away is part of the keyword rather than part of what the card does
   * afterwards — Preordain's own effect is the draw — so the engine does it, and this says which.
   *
   * It is a field rather than a second `DecisionZone` because everything else about the two is
   * identical: the candidates, the `min: 0` that makes keeping them all a legal answer, the "no
   * shuffle" rule, and the order the cards left behind stay in. A `'library-top-graveyard'` zone
   * would have duplicated all of that to change one line.
   *
   * **227 unread legal lines mention surveil, 120 of them on cards one line short** — and every
   * prologue those lines hang off was already read, so this one field is what they were waiting
   * for.
   */
  readonly chosenGoTo?: 'bottom' | 'graveyard' | 'hand';
  /**
   * For `library-top`: where the cards that were looked at and **not** picked go (D584).
   *
   * Absent, they stay on top in the order they were in, which is scry and surveil. Present, they
   * leave the top, which is the other thing a card does with the top of a library — "Look at the
   * top three cards of your library. Put one of them into your hand and the rest on the bottom of
   * your library in any order." Together with `chosenGoTo: 'hand'` that sentence is one question:
   * which card do you take.
   *
   * - `'bottom'` is "in any order", and the engine keeps the order they were already in. That is
   *   one of the orders the player could have chosen; choosing a different one needs a question
   *   whose answer is a sequence, which is the same thing `look` says scry does without.
   * - `'bottom-random'` is "in a random order", shuffled among themselves by the game's own RNG.
   * - `'graveyard'` is "and the rest into your graveyard".
   *
   * It counts the cards **looked at**, not the candidates: with a `filter` ("you may reveal a
   * creature card from among them") the cards that did not qualify were still looked at and still
   * go wherever the rest goes. See `pendingDecision.looked`.
   */
  readonly restGoTo?: 'bottom' | 'bottom-random' | 'graveyard';
  /**
   * For `library-top` with `chosenGoTo: 'hand'`: the picked card is **revealed** on its way there
   * — "you may reveal a creature card from among them and put it into your hand" (D584).
   *
   * The reveal is what lets the table check the card was one the filter allowed, so it is part of
   * the sentence and not decoration. The engine marks the card revealed in the hand it arrives
   * in, where it stays readable to every seat until it moves again; an unfiltered dig ("put one of
   * them into your hand") reveals nothing and does not set this.
   */
  readonly revealPicked?: true;
  /** Shown to whoever is choosing, in their own words: "Search your library for a creature card". */
  readonly prompt: string;
  /** Both default to 1, and both are clamped to what the zone actually holds. */
  readonly min?: number;
  readonly max?: number;
  /** Which cards in that zone qualify. Without one, any card in the zone does. */
  readonly filter?: (state: GameState, id: string, chooser: SeatIndex) => boolean;
  /**
   * Which cards the engine's own opponent picks, written by the card.
   *
   * The twin of `ChoiceDecisionSpec.best` and here for the same reason: only the card knows what
   * its question *means*. **Named `pick` rather than `best` deliberately**: two members of the
   * `DecisionSpec` union carrying a field of the same name and different signatures leaves
   * TypeScript unable to infer the parameters of *either* inside a spec literal, so sharing the
   * name would have put `state: GameState, chooser: SeatIndex` annotations on every existing
   * `best` in the pool to pay for one new field here. The bot has one standing answer per zone — bottom a land once you have
   * five, take the best card out of a library or a graveyard, give up the worst out of a hand —
   * and those answers are right for the questions they were written for.
   *
   * They are wrong for Delver of Secrets, which is the card that needed this. "Look at the top
   * card of your library. You may reveal that card" shares its zone with scry and means the
   * opposite: choosing the card is *revealing* it, so the scry rule — which chooses a card in
   * order to bottom it — would reveal exactly the cards Delver does not care about and hide the
   * instants it transforms on.
   *
   * Undefined falls back to the standing answer, which is why almost every card leaves it out. The
   * engine checks the returned ids against the question's own candidate list, so a hint that named
   * something else is ignored rather than becoming a refused action and a stopped table.
   */
  readonly pick?: (
    state: GameState, chooser: SeatIndex, candidates: readonly string[],
  ) => readonly string[] | undefined;
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly options?: never;
  readonly range?: never;
  readonly retargets?: never;
}

/**
 * A question whose answer is a **word**: a creature type, a colour, "tap" or "untap", yes or no.
 *
 * The other half of what printed cards ask, and the half this engine could not say until now.
 * Everything in `CardsDecisionSpec` is about objects in a zone, and "choose a creature type" names
 * no object at all — so a card that wanted one had to be left out of the pool rather than
 * approximated.
 *
 * One shape for all of them rather than a separate yes-or-no: "you may" is a choice between two
 * words, the table draws the same row of buttons either way, and a single mechanism is a single
 * place for the rules about it to live. A spec with fewer than two options is answered by the
 * engine rather than asked, for the same reason a discard of two cards from a hand of two is —
 * a prompt with one button is noise.
 */
export interface ChoiceDecisionSpec {
  /**
   * Ask this question **only if** an earlier answer in the same resolution was this word (D450).
   *
   * The engine asks a resolution's questions in order and applies the answers at the end. Without
   * this, every question in the list is asked — so "you may search your library for a basic land
   * card" opened the library *before* the yes-or-no could be read, and a player who declined had
   * seen their library anyway. That is both a wrong reading and an information leak, and it is why
   * the compiler refused the whole family (D447, D448). **128 legal cards are one line short on it.**
   *
   * The word is matched against the **most recent earlier answer that carries one** — a
   * `ChoiceDecisionSpec` answer, since those are the only ones with an `option`. Most recent rather
   * than "the one before", because a question can expand into several plan entries (`each-opponent`
   * asks one per seat) and the index of "the one before" is then not a fact the card knows.
   *
   * A question that is skipped is **answered empty**, not dropped: the answers keep their positions,
   * so `chosenCards(c, 1)` still means the second question whether or not the first one ran. An
   * empty answer is what every other unasked question already produces — an eliminated seat, a
   * zone with nothing in it — so nothing downstream needed teaching.
   */
  readonly askOnlyIfChosen?: string;
  readonly who: 'controller' | 'target-player' | 'each-player' | 'each-opponent'
  | 'hit-player' | 'acting-player' | 'referent-player';
  readonly prompt: string;
  /** The words, in the order the table shows them. The first is the default a bot falls back on. */
  readonly options: readonly string[];
  /**
   * Which word the engine's own opponent picks, written by the card.
   *
   * It has to live here, because only the card knows what its words *mean*: "Vampire" is a
   * creature type to count on a battlefield and "white" is a colour to fear in a graveyard, and
   * nothing generic can tell those two lists apart without guessing. So the card answers its own
   * question the way a player would, from the board — which is the same rule the rest of the bot
   * follows: read a fact, do not carry a weight.
   *
   * Never shown to a person, and never consulted when a person is answering. Returning
   * `undefined` falls back to the first option, which is why the order of `options` is not
   * arbitrary.
   */
  readonly best?: (state: GameState, chooser: SeatIndex) => string | undefined;
  /**
   * A **mana cost the engine pays** when this word is the answer (CR 601.2h).
   *
   * The shape extort needed and the first optional cost in this engine that is paid *during* a
   * resolution rather than as something is cast or activated. "You may pay {W/B}. If you do, each
   * opponent loses 1 life" is one question with a price on one of its two answers, and the card
   * cannot pay it itself: paying means tapping lands, which is the engine's job — see `payFrom`.
   *
   * Two rules make it behave. The option is **not offered** when the seat cannot pay for it, which
   * is the same discipline `legalActions` keeps about every other play, and leaves a one-word
   * question that the engine answers without a prompt. And the payment happens **before the
   * effect**, so an effect that reads `chosenOption` is reading an answer that has already been
   * paid for.
   */
  readonly payIfChosen?: {
    readonly option: string;
    /** Mana, in the printed `{1}{R}` form. Omitted when the price is energy. */
    readonly cost?: string;
    /**
     * Energy instead of mana (CR 122), as a count of `{E}` (D451).
     *
     * `AbilityCost.energy` has priced an *activated* ability in energy since #180; this is the
     * same price on an **answer**, which is what the Kaladesh commons print: "Whenever ~ attacks,
     * you may pay {E}{E}. If you do, create a 1/1 colorless Servo artifact creature token."
     * **56 legal cards are one unread line short on it.**
     *
     * Energy and mana are different enough to be two fields rather than one string. Mana is paid
     * by tapping things, so only the engine can do it and the pool has to be read; energy is a
     * number on the seat, so paying is subtraction. Folding energy into the mana string would mean
     * `parseManaCost` growing a symbol that is not mana and every reader of a cost having to know
     * it. Exactly one of the two is set.
     */
    readonly energy?: number;
  };
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly from?: never;
  readonly range?: never;
  readonly retargets?: never;
}

/**
 * A question whose answer is a **number**: "pay X life", "choose a number".
 *
 * The third and last shape of mid-resolution question, and the one this engine has been missing
 * since it learned to ask the other two. A card is not an answer and neither is a word: Toxic
 * Deluge's whole card is a number chosen *as it resolves*, bounded by the life its caster can
 * actually pay, and spent before anything else happens.
 *
 * It is not an X cost, which is the distinction worth being careful about. X is chosen as a spell
 * is **cast**, it is part of what gets countered, and an opponent sees it before deciding whether
 * to respond. A number chosen on resolution is chosen *after* every response, from a board that
 * may have changed — which is exactly why a player would rather have it that way, and why this
 * cannot be folded into `xMax`.
 *
 * **The card decides the range**, because only the card knows what the number means. Toxic Deluge
 * asks for nought up to the smaller of "life you can survive paying" and "the biggest toughness on
 * the board", since -9/-9 and -4/-4 kill exactly the same creatures when nothing has five
 * toughness — and a question offering forty answers where six matter is a worse question, not a
 * more honest one. The range is computed when the question is asked, so it reads the board as it
 * is at that moment rather than as it was when the spell was cast.
 */
export interface NumberDecisionSpec {
  /**
   * Ask this question **only if** an earlier answer in the same resolution was this word (D450).
   *
   * The engine asks a resolution's questions in order and applies the answers at the end. Without
   * this, every question in the list is asked — so "you may search your library for a basic land
   * card" opened the library *before* the yes-or-no could be read, and a player who declined had
   * seen their library anyway. That is both a wrong reading and an information leak, and it is why
   * the compiler refused the whole family (D447, D448). **128 legal cards are one line short on it.**
   *
   * The word is matched against the **most recent earlier answer that carries one** — a
   * `ChoiceDecisionSpec` answer, since those are the only ones with an `option`. Most recent rather
   * than "the one before", because a question can expand into several plan entries (`each-opponent`
   * asks one per seat) and the index of "the one before" is then not a fact the card knows.
   *
   * A question that is skipped is **answered empty**, not dropped: the answers keep their positions,
   * so `chosenCards(c, 1)` still means the second question whether or not the first one ran. An
   * empty answer is what every other unasked question already produces — an eliminated seat, a
   * zone with nothing in it — so nothing downstream needed teaching.
   */
  readonly askOnlyIfChosen?: string;
  readonly who: 'controller' | 'target-player' | 'each-player' | 'each-opponent'
  | 'hit-player' | 'acting-player' | 'referent-player';
  readonly prompt: string;
  /** The numbers on offer, inclusive, read off the board when the question is asked. */
  readonly range: (state: GameState, chooser: SeatIndex) => { readonly min: number; readonly max: number };
  /**
   * Which number the engine's own opponent picks, written by the card — the same hook, and for the
   * same reason, as `ChoiceDecisionSpec.best`: only the card knows what its number *buys*. Out of
   * range or absent falls back to the bottom of the range, which is the answer that does least.
   */
  readonly best?: (state: GameState, chooser: SeatIndex) => number | undefined;
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly from?: never;
  readonly options?: never;
  readonly retargets?: never;
}

/**
 * A question whose answer is a **target**: "you may choose new targets for the copy".
 *
 * The fourth and last shape, and the only one about an object that is not the card asking. Every
 * printed copy effect — Twincast, Reverberate, Fork, Strionic Resonator, Lithoform Engine — ends
 * with that clause, and until this existed the engine had to leave it off: the copy kept whatever
 * the original chose, which is a strictly worse card and was asserted as a limitation rather than
 * fixed.
 *
 * It cannot be a cast-time target, which is the distinction that makes this a shape of its own.
 * Swerve and Willbender *do* choose where a spell is going as they are cast, and they are
 * different cards for it: both targets are announced on the stack and both can be answered. A copy
 * effect chooses after every response, from the board as it ended up — a creature that arrived
 * since is a legal new target, and one that died is not.
 *
 * **The question is asked about the object being copied, not about the copy**, which is the one
 * design decision here worth writing down. A copy's characteristics are the original's (CR 707.2),
 * so its legal targets are the same set, and asking before the copy exists means the answer can
 * simply be handed to `copySpellOnStack` — rather than making a copy aimed at the old target and
 * re-aiming it, which is two states where one will do.
 *
 * Only an object with a **single** target is offered the question, which is the same restriction
 * `soleTargetSpecOf` puts on Swerve and Willbender and for a sharper reason here: the rules copy a
 * divided quantity as it was divided (CR 706.10c), so a re-aimed Arc Lightning would need its
 * three points re-divided as well, and "choose new targets" is not permission to re-divide. An
 * object with no targets, with several, or with only one legal target to choose is not asked.
 */
export interface TargetDecisionSpec {
  /**
   * Not offered on this shape. A retarget and a counter question are both parts of one effect
   * rather than steps a player may decline, so neither has a "may" in front of it to be
   * conditional on. See `CardsDecisionSpec.askOnlyIfChosen`.
   */
  readonly askOnlyIfChosen?: never;
  readonly who: 'controller';
  readonly prompt: string;
  /**
   * Which object on the stack this question is about, read off the resolution that is asking.
   *
   * Twincast and the Resonator both answer `object.targets[0]?.id`: the spell or ability they were
   * pointed at. An object that has left the stack by now means no question — the copy effect has
   * nothing to copy, and the resolution says so on its own terms.
   */
  readonly retargets: (state: GameState, object: StackObjectLike) => string | undefined;
  /**
   * Whether declining is an answer. Every printed card that asks this says "you **may**", so this
   * is set everywhere today — but a card that must re-aim would be a different card and the field
   * says which this is.
   */
  readonly optional?: true;
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly from?: never;
  readonly options?: never;
  readonly range?: never;
}

/**
 * What a `TargetDecisionSpec` needs off a stack object, which is its id and what it is aimed at.
 *
 * Narrower than `StackObject` on purpose: this module is below `turnTypes.ts` in the import order,
 * and a spec that asked for the whole object would drag the stack's shape into the script API for
 * the sake of two fields.
 */
export interface StackObjectLike {
  readonly id: string;
  readonly controller: SeatIndex;
  readonly targets: readonly { readonly kind: string; readonly id?: string }[];
}

/**
 * A question whose answer is a set of **permanents and players**: proliferate's (CR 701.27a).
 *
 * The fifth shape, and the first whose candidates are not all cards. Every other question here is
 * about objects in a zone — a hand, a graveyard, the top of a library — and a *player* is not in a
 * zone at all. Poison and energy counters live on a seat, so "choose any number of permanents
 * and/or players with counters on them" could not be asked with the four shapes that existed; the
 * nearest approximation, asking only about permanents, would have left the keyword unable to do the
 * thing it is famous for.
 *
 * So the candidate list is mixed: an instance id is a permanent, and `seat:N` is the player at that
 * seat. The engine computes it — **everything with at least one counter already on it**, which is
 * the rule and is also what makes the question answerable without the chooser hunting the board.
 *
 * The scope is `permanents`, which is narrower than it reads and is the rule: a suspended card in
 * exile carries time counters and is **not** a permanent, so it is not a legal choice. That is why
 * proliferate does not accelerate a suspended spell in paper either.
 */
export interface CountersDecisionSpec {
  /**
   * Not offered on this shape. A retarget and a counter question are both parts of one effect
   * rather than steps a player may decline, so neither has a "may" in front of it to be
   * conditional on. See `CardsDecisionSpec.askOnlyIfChosen`.
   */
  readonly askOnlyIfChosen?: never;
  readonly who: 'controller';
  readonly prompt: string;
  /** The discriminator. The shapes are told apart by which of these fields is present. */
  readonly counters: true;
  /** Both default to "any number", which is what the keyword says: 0 to everything. */
  readonly min?: number;
  readonly max?: number;
  /** Never set on this shape. */
  readonly from?: never;
  readonly options?: never;
  readonly range?: never;
  readonly retargets?: never;
}

export type DecisionSpec =
  | CardsDecisionSpec | ChoiceDecisionSpec | NumberDecisionSpec | TargetDecisionSpec
  | CountersDecisionSpec;

/**
 * A question, or a **card that works out its question when it is asked** (CR 702.24b).
 *
 * Four of the five shapes are facts about the card: the words of a modal choice, the zone a search
 * reads, how many to sacrifice. Cumulative upkeep is not. Its price is "its upkeep cost for each age
 * counter on it", and the counter goes on as the ability resolves — so the cost, the words on the
 * buttons and the prompt are all facts about *this* resolution, and a static spec cannot hold any of
 * them.
 *
 * `NumberDecisionSpec.range` had already met half of this problem and solved it the same way: a
 * function, evaluated when the question is put. This widens that from one field to the whole spec,
 * which is cheaper than it sounds — **every** reader of a card's questions goes through
 * `decisionSpecsFor`, so the thunk is resolved in one place and nothing downstream knows it existed.
 *
 * The function must be **pure** and must read only things that cannot change between the question
 * being asked and the answer being applied: the engine resolves it more than once (to plan the
 * questions, to ask one, to pay for the answer) and the three must agree. An age counter put on by
 * `beforeDecisions` is safe, because that runs before any of them.
 */
export type DecisionSpecOf = DecisionSpec | ((state: GameState, source: string) => DecisionSpec);

/** Whether a question is the kind whose answer is a word. Narrows for TypeScript as well. */
export const isChoiceDecision = (spec: DecisionSpec): spec is ChoiceDecisionSpec =>
  spec.options !== undefined;

/** Whether a question is the kind whose answer is a set of cards: the one with a zone. */
export const isCardsDecision = (spec: DecisionSpec): spec is CardsDecisionSpec =>
  spec.from !== undefined;

/** Whether a question is the kind whose answer is a number. */
export const isNumberDecision = (spec: DecisionSpec): spec is NumberDecisionSpec =>
  spec.range !== undefined;

/** Whether a question is proliferate's: a set of permanents and players carrying counters. */
export const isCountersDecision = (spec: DecisionSpec): spec is CountersDecisionSpec =>
  (spec as CountersDecisionSpec).counters === true;

/** Whether a question is the kind whose answer is a target for something else on the stack. */
export const isTargetDecision = (spec: DecisionSpec): spec is TargetDecisionSpec =>
  spec.retargets !== undefined;

/**
 * A yes-or-no question asked of the board, for an intervening-if clause. See `TriggerDef.condition`.
 *
 * The same context an effect gets, so that the condition and the effect read the same board the
 * same way — a condition that answered from a narrower view than its effect could say yes to
 * something the effect then cannot do.
 */
export type ConditionFn = (ctx: Parameters<EffectFn>[0]) => boolean;

export interface TriggerDef {
  readonly on: TriggerEvent;
  readonly description: string;
  /**
   * This ability is **scheduled** rather than watched for: a delayed trigger (CR 603.7).
   *
   * `on` still says *when* — a step, which is the only shape a printed delayed trigger takes
   * ("at end of combat", "at the beginning of the next end step") — but the ordinary event path
   * never fires it. Something else creates it with `scheduleDelayed`, and the step it names drains
   * it exactly once. Without this flag a step trigger fires every turn for as long as its
   * permanent is on the battlefield, which is a different card entirely.
   */
  readonly delayed?: true;
  /**
   * "This ability triggers only once each turn." — the printed restriction, and **143 legal corpus
   * printings across 140 cards carry it** (8 of those cards were one line away on nothing else; the
   * rest are blocked by a second reader too). Measured by compiling rather than by matching clauses — see D532 in
   * `claude/decisions-log.md` for why the two numbers differ by 4.9x.
   *
   * **Enforced where the ability *triggers*, not where it resolves**, which is what the sentence
   * says and not a detail. A gate on resolution would let two copies of the ability go on the
   * stack, let an opponent respond to both, and then silently do nothing on the second — a Morbid
   * Opportunist whose controller sacrifices three creatures would show three triggers and draw one
   * card. The restriction is spent in `fireTrigger`, before the ability is put on the stack, so the
   * second event in a turn produces no trigger at all.
   *
   * Spent even when the ability never reaches the stack for want of a legal target (CR 603.3d):
   * it triggered, and the rule is about triggering. The alternative reading — "it only counts if it
   * resolved" — is the one that would let a player dodge the restriction by emptying the board of
   * targets, which no printing allows.
   *
   * Declarative rather than a `condition`, for the reason `AbilityDef.onceEachTurn` is declarative:
   * a condition is handed the context and not the ability index, so it could not tell which of a
   * card's triggers it guards, and the engine has to *record* the firing, which only something that
   * knows the restriction exists can do. Recorded onto `CardInstance.abilityUsedTurn` under
   * `triggerFireKey`, whose `t:` namespace is what keeps it from colliding with an activated
   * ability's record at the same index.
   *
   * A printed ability the compiler splits into several `TriggerDef`s — one shape, several events —
   * **refuses this restriction rather than carrying it**, because each `TriggerDef` gets its own
   * index and so its own record, and one printed ability that fired once per event kind would be a
   * different card. No corpus printing is affected today (of the 140 legal cards whose restricted
   * line this compiler reads at all, 11 emit one event and none emit several), so the refusal costs
   * nothing measurable and is the reading that is right by construction (D487).
   */
  readonly onceEachTurn?: true;
  /**
   * The intervening-if clause: "**if** that creature's power is greater than this creature's, put
   * a +1/+1 counter on it" (CR 603.4).
   *
   * Not a filter on the event, and the difference is the whole rule. A condition here is checked
   * twice — once when the trigger would go on the stack, and again as it resolves — and if it is
   * false either time the ability does nothing at all. So an evolve trigger whose creature was
   * killed in response does not put a counter on, and a trigger that would not have fired is
   * never put on the stack for an opponent to respond to.
   *
   * It is given the same context an effect is, which is what makes it able to answer the question
   * at all: `ctx.subject` is the creature the event was about, and `ctx.source` is the card
   * asking. A condition must not change the game — it is asked, not run.
   */
  readonly condition?: ConditionFn;
  readonly targets?: readonly TargetSpec[];
  /** Questions asked while it resolves. See `DecisionSpec`. */
  readonly decisions?: readonly DecisionSpecOf[];
  /** What it does before those questions are asked. See `CardScript.beforeDecisions`. */
  readonly beforeDecisions?: EffectFn;
  readonly effect: EffectFn;
}

export interface AbilityCost {
  /** Mana part, in the printed `{1}{R}` form. */
  readonly mana?: string;
  /** The `{T}` symbol: requires the permanent to be untapped and not summoning sick. */
  readonly tap?: boolean;
  readonly sacrificeSelf?: boolean;
  /**
   * "Sacrifice a creature:" — the player picks which, and it is gone before the ability is on the
   * stack. A **cost**, not a target: it cannot be responded to, and an opponent cannot save the
   * creature in reply. Modelling it as a target would be close enough to look right and wrong
   * exactly where it matters.
   */
  readonly sacrifice?: 'creature' | 'another-creature' | 'artifact' | 'artifact-or-creature';
  /**
   * Narrows `sacrifice` to permanents with **one of** these subtypes: "Sacrifice another Vampire
   * or Zombie" (D578).
   *
   * A narrowing of the field above rather than a fifth member of it, because the subtype is a
   * parameter — sixty creature types and one rule, which is D57's point about an enum of them.
   * Read off `characteristicsOf`, so a changeling counts and a creature that lost its types does
   * not.
   *
   * Paired with `'another-creature'` on the one card that uses it, and that pairing is exact for
   * what is printed rather than a near miss: the card says "another Vampire or Zombie", not
   * "creature", and the corpus has **no** noncreature card with either subtype (measured, D578).
   * A kindred Zombie enchantment would be the card that needs a permanent-wide member.
   */
  readonly sacrificeSubtypes?: readonly string[];
  /**
   * `'artifact'` is the fourth member and the first that is not about creatures at all.
   *
   * Worth its own note because of what it eats in this pool: there are Equipment, mana rocks, a
   * Chalice, a Bonesplitter and a Mind Stone, and until now no cost could spend any of them. An
   * artifact **creature** satisfies it too, which is the rule rather than a convenience — a card
   * that is both is both, and `characteristicsOf` is where that is decided rather than the printed
   * type line.
   */
  /**
   * "Pay 1 life:" — life as part of the cost rather than as something the ability does.
   *
   * The difference is not cosmetic. A cost is paid as the ability is activated and cannot be
   * responded to, and an ability whose cost you cannot pay is never offered at all — so a player
   * on one life is not shown a Mana Confluence's mana, where "it deals 1 damage to you" on a City
   * of Brass would happily take them to zero. That is the printed difference between those two
   * cards, and it is the reason both of them are in the pool.
   */
  readonly life?: number;
  /**
   * A planeswalker's loyalty cost: `+1`, `0`, `-3`. Paid by adding or removing loyalty counters
   * as the ability is activated (CR 606.2), which is why a minus ability cannot be used without
   * the loyalty to pay for it — and why using one is how a planeswalker runs out.
   *
   * Sorcery speed and once per turn per planeswalker are implied by the cost existing, rather
   * than asked for separately: every loyalty ability in the game has both restrictions.
   */
  readonly loyalty?: number;
  /**
   * "Discard this card:" — the card itself is the cost, which is what makes cycling work.
   *
   * It carries its own restrictions, the way `loyalty` does: an ability that discards the card to
   * pay for it is used **from the hand**, and nowhere else. Nothing in Magic discards itself from
   * the battlefield to pay for something, and a script that had to say "from hand" separately
   * would be one more thing to forget. The card is in the graveyard by the time the ability
   * resolves (CR 702.29a), which is why the ability's effect must not read its own source.
   */
  readonly discardSelf?: boolean;
  /**
   * "Discard a card:" — a card out of the hand as part of the cost, chosen by whoever is paying
   * (D579). Sunscourge Champion's eternalize is "{2}{W}{W}, Discard a card".
   *
   * `discardSelf`'s neighbour and not the same thing: that one spends the card the ability is
   * printed on, this one spends any **other** card in the hand. Chosen as the ability is
   * activated and gone before it is on the stack, so it travels on the action as `discarded` and
   * its candidates on the play as `discardOptions` — the arrangement a sacrifice cost already
   * has, for the same reason. An ability with this cost is not offered to an empty hand.
   *
   * It is a real discard: the card goes to its owner's graveyard through `relocate`, so madness
   * may take it and "whenever you discard a card" sees it.
   */
  readonly discardACard?: true;
  /**
   * "Exile this card from your graveyard:" — embalm's cost, and the second time the card itself is
   * what you are paying with (CR 702.89a, CR 702.100a).
   *
   * `discardSelf` one zone along in the other direction: cycling spends a card out of your hand,
   * this spends one out of your graveyard, and both are paid as the ability is activated rather
   * than when it resolves. Paying it at activation is the whole point and not a detail — embalm
   * exiles the card as a **cost**, so the same Sacred Cat cannot be embalmed twice by activating
   * it again while the first ability is still on the stack. An effect that exiled on resolution
   * would be two Cats for the price of one.
   *
   * Unlike `discardSelf`, the effect here *is* expected to read its own source: the card sits in
   * exile with its instance intact, which is what `copyAsToken` copies. It is paired with
   * `fromGraveyard`, which is what says the ability is activated from there at all — this field
   * says what the cost spends, not where the ability is used from.
   */
  readonly exileSelf?: boolean;
  /**
   * "Return an unblocked attacker you control to hand:" — ninjutsu's cost (CR 702.49a).
   *
   * The first cost in this engine paid with a permanent that is **not** destroyed: a sacrifice
   * puts a creature in a graveyard and this puts one back in a hand, which is a very different
   * trade — the creature that got through is the one you keep, and the card you were holding is
   * the one that replaces it mid-combat.
   *
   * It also makes the ability the first one in this pool activated **from the hand without
   * spending the card**: cycling and madness discard it, embalm exiles it from the graveyard, and
   * the ninja is simply put onto the battlefield instead. So the zone this ability is used from is
   * the hand, and the card is still there when the effect runs.
   *
   * Which attacker goes back is a choice, so it travels on the action as `returned` and the
   * candidates travel on the play as `returnOptions`, exactly as a sacrifice cost's do. The engine
   * recomputes and re-checks the list rather than trusting it, for the same reason.
   *
   * The timing is a fact about the cost rather than about the ability: an unblocked attacker only
   * exists once blockers have been declared, so an ability with this cost is offered in the
   * declare-blockers step after the defending player has finished declaring and not before.
   */
  readonly returnsUnblockedAttacker?: true;
  /**
   * "Crew N" — tap any number of untapped creatures you control with total power N or greater
   * (CR 702.122a).
   *
   * The third kind of cost in this engine that is not mana, after the sacrifice and the life, and
   * the second that is paid by tapping somebody else's permanent — convoke was the first. What it
   * is *not* is a tap cost on the Vehicle: the Vehicle stays untapped, which is the whole point,
   * because it is about to attack.
   *
   * Two rules travel with it rather than being asked for separately. Summoning sickness does not
   * stop a creature crewing, because tapping it is a cost being paid and not an ability it is
   * activating (CR 302.6 is about {T} abilities and attacking). And **any number** means the count
   * is the engine's to choose, like convoke's: see `crewPlan`.
   */
  /**
   * "Remove a +1/+1 counter from this permanent:" — a counter as the cost, not as the effect.
   *
   * The fifth cost here that is not mana, and the first paid out of the permanent's own counters.
   * The difference from an effect that removes one is the difference every cost in this list has:
   * it is paid as the ability is activated, it cannot be responded to, and an ability whose cost
   * cannot be paid is never offered — so a Walking Ballista with no counters left shows no damage
   * ability rather than one that would be refused.
   *
   * It is also what makes the last counter work the way the card does. The counter is gone before
   * the ability is on the stack, so a Ballista that removes its last one is a 0/0 that dies to a
   * state-based action while its own damage is still waiting to resolve — and the damage is dealt
   * anyway, because the ability no longer needs its source (CR 608.2). A loyalty cost is the same
   * shape and already worked this way: see `loyalty`.
   */
  readonly removeCounter?: { readonly counter: string; readonly amount: number };
  /**
   * "Pay {E}{E}:" — energy, which is a counter on the **player** rather than on a permanent
   * (CR 122.1, CR 107.17).
   *
   * The sixth cost here that is not mana, and the first paid out of something the seat owns that
   * is neither its life nor its cards. Energy is unlike every other resource this engine has in
   * one way that matters: it **does not empty**. Mana drains at the end of a step, life is a
   * number you are trying to keep, cards in a graveyard are a pile that only grows — energy is
   * saved up deliberately over several turns and then spent all at once, which makes it the first
   * resource in this pool with a *plan* attached to it.
   *
   * Stored in `Seat.counters` under the key `energy`, which that field was always for ("arbitrary
   * named counters (energy, experience, rad, tickets, ...)") and which nothing had used until now.
   * That is why the engine needed no new field for it: a counter on a player is a thing the state
   * already models, and the work is in the cost, the offer and the payment.
   *
   * The same rule as the life and the counter above: an ability whose energy you do not have is
   * never offered (CR 118.4), so a Longtusk Cub with one energy shows no growth ability rather
   * than one the engine would refuse.
   */
  readonly energy?: number;
  /**
   * "Activate this only from your graveyard" — unearth's zone, and the third thing a cost can be
   * paid out of the graveyard for (CR 702.84a).
   *
   * The sibling of `discardSelf`, which is cycling's "from your hand". Escape and delve (D171) are
   * *casts* from the graveyard and go through the cast path; unearth is not a cast at all — the
   * creature is put onto the battlefield by an **activated ability**, so nothing is put on the
   * stack, an opponent cannot counter it, and "whenever a player casts a spell" does not see it.
   * That is the whole reason it is an ability here rather than another flag on the cast path.
   */
  readonly fromGraveyard?: true;
  readonly crew?: number;
}

/**
 * Affinity for anything but artifacts (D597): "affinity for creatures", "for Equipment", "for
 * Islands", "for Cats", "for historic permanents", "for outlaws", "for tokens". `counts` asks one
 * permanent the caster controls, live; `words` is the printed phrase, for the cost note.
 */
export interface AffinityFor {
  readonly words: string;
  readonly counts: (state: GameState, id: string) => boolean;
}

/**
 * What a payment is for, as a restriction on mana asks it (D595): a spell being cast, by its type
 * line, or an activated ability, by the type line of its source. Read live — an animated land's
 * ability is a creature's.
 */
export interface PaymentFor {
  readonly spell?: TypeLine;
  readonly abilityOf?: TypeLine;
}

/** "Spend this mana only to …", as a test of a payment, and the words, for the table. */
export interface SpendRestriction {
  readonly words: string;
  readonly allows: (paying: PaymentFor) => boolean;
}

export interface AbilityDef {
  readonly cost: AbilityCost;
  readonly description: string;
  /**
   * This ability is **cycling** (CR 702.29), which is more than its cost says (D567).
   *
   * `discardSelf` is how cycling is paid for, and it is also how channel and bloodrush are: a card
   * that discards itself for an effect has not been cycled, and "whenever you cycle a card" must
   * not fire for it. So the keyword says so here, and activating an ability carrying this is what
   * records the card in `AutomationState.cycled`.
   */
  readonly cycling?: true;
  readonly targets?: readonly TargetSpec[];
  /**
   * A mana ability. It produces these types, resolves immediately and never uses the stack
   * (CR 605.3a) — which is what makes tapping a land for mana in response to something work.
   */
  readonly produces?: readonly ManaType[];
  /**
   * "Spend this mana only to …" (CR 106.6, D595): what the mana this ability makes may pay for.
   *
   * The mana never floats. A restricted mana ability is not offered as a button — the engine taps
   * it **while paying** for something it is allowed to pay for, the only moment the restriction
   * can be checked — and a mana it made beyond the cost is lost rather than left in the pool,
   * where nothing could tell it from mana that may be spent on anything.
   */
  readonly spendOnly?: SpendRestriction;
  /** Questions asked while it resolves. See `DecisionSpec`. */
  readonly decisions?: readonly DecisionSpecOf[];
  /** What it does before those questions are asked. See `CardScript.beforeDecisions`. */
  readonly beforeDecisions?: EffectFn;
  readonly effect?: EffectFn;
  /** Only activatable when you could cast a sorcery. */
  readonly sorcerySpeed?: boolean;
  /**
   * "Activate only once each turn." — CR 602.5f, and **38 legal corpus cards are one printed line
   * away on nothing but this sentence** (measured by `scripts/measure/one-away.mjs`, broken down in
   * `claude/decisions-log.md` under D508).
   *
   * Declarative rather than another `activateOnlyIf` predicate, and the choice is load-bearing in
   * three ways. The predicate is handed `(state, source, controller)` and **not the ability index**,
   * so it could not tell which of a card's abilities it is guarding — Basking Rootwalla's pump and
   * its madness cost are different questions. The engine also has to *record* the activation, which
   * only something that knows the restriction exists can do. And the refusal can name the rule
   * ("already used that ability this turn") instead of the generic "cannot be activated right now",
   * which is what D67 asks of every refusal.
   *
   * Checked in `legalActions` so the table never offers it, and again in the activation path so an
   * action arriving from anywhere is refused — the two places every ability restriction here is
   * checked in, for the reason D67 and D89 share. Recorded onto
   * `CardInstance.abilityUsedTurn` as the cost is paid.
   */
  readonly onceEachTurn?: true;
  /**
   * "Activate only during your turn / your upkeep / your turn, before attackers are declared."
   * — CR 602.5d, and **32 legal corpus cards across the three clauses** (18, 8 and 6), measured
   * the same way D508's 38 were and recorded under D509 in `claude/decisions-log.md`.
   *
   * One field with three values rather than three booleans, because the clauses are mutually
   * exclusive readings of the same question — *when* — and a card prints exactly one of them. Three
   * flags would have let a script say "during your upkeep" and "before attackers are declared" at
   * once, which no printing says and which the engine would then have had to decide about.
   *
   * Beside `sorcerySpeed` rather than folded into it: see `atActivationTiming` for why reusing the
   * sorcery check would refuse plays these cards allow.
   */
  readonly timing?: ActivationTiming;
  /**
   * "Activate only if …" — a restriction on the ability itself, asked where the ability is
   * *offered* rather than where it resolves.
   *
   * Monstrosity is the card shape that needs it: "Activate only if this creature isn't monstrous"
   * is the clause that makes the growth one-shot, and a creature that has already paid for it has
   * no ability left to press. Asked in `legalActions` so the table never offers it, and again in
   * the activation path so an action arriving from anywhere is refused with a reason — the same
   * two places every other ability restriction is checked in, for the reason D67 and D89 are both
   * about: an option offered and then refused is worse than an option that was never there.
   *
   * A predicate rather than data, which `ContinuousEffect.while` could not be: a script is code
   * and is never serialised, so the restriction can read whatever the card's words read.
   */
  readonly activateOnlyIf?: (state: GameState, source: string, controller: SeatIndex) => boolean;
  /**
   * "The rules let you, and it would do nothing" — read by the **bot** and by nothing else.
   *
   * The twin of `activateOnlyIf` and the opposite half of it. Monstrosity's restriction is printed
   * on the card, so the table must not offer the ability at all; **adapt's** is printed inside the
   * effect, so a player may legally pay {2}{G}{U} for a creature that already has a +1/+1 counter
   * on it and get nothing back. Both readings have to be available: the engine owes the player the
   * play the card allows, and the search owes itself not to take it.
   *
   * Measured before it existed, with one Aeromunculus in Delta Bloom: **29 casts and 88 adapt
   * activations across 34 games** — three payments per creature for one effect, and the deck lost
   * about ten games of 288 for it (D182). The sixteenth member of the drop-this-option family, and
   * the first that is about an ability rather than a card in hand.
   */
  readonly buysNothingIf?: (state: GameState, source: string, controller: SeatIndex) => boolean;
  /**
   * See `CardScript.preventsDamage`. On the ability because that is what is spent: a Samite
   * Healer's ability taps it, so using it when no damage is coming costs a blocker for nothing,
   * while the creature itself is a perfectly good play.
   */
  readonly preventsDamage?: boolean;
  /**
   * "This ability turns the permanent into a creature until end of turn" — layer 4, bought with
   * mana.
   *
   * Declared for the bot, and the eighth member of the "spent on nothing" family. The evaluation
   * cannot see what animating a land buys: a Mutavault that is a 2/2 still scores as a land, so
   * the gain is zero and the mana is free — and with no baseline for doing nothing, the search
   * pressed it whenever it had a spare {1}. Measured before the rule: **854 animations in 56
   * games, and not one attack with it.** The question the board is asked instead is whether there
   * is an attack to make or a block to make; see `animationCouldMatter`.
   */
  readonly animates?: boolean;
  /**
   * "{T}: Untap another target permanent" — an ability whose *whole* effect is untapping something.
   *
   * Declared for the bot, and the eleventh member of the "spent on nothing" family. It is the one
   * that is not about a card spent on nothing but about a **cycle**: two Kiora's Followers untap
   * each other for ever, and a board that ends where it started is a legal line the search is
   * happy with. Measured before the rule, with one copy in the deck: the ability was activated
   * **164 times across 120 games**, about three and a half per game it was drawn.
   *
   * Only for an ability that does nothing else. Maze of Ith untaps an attacking creature *and*
   * prevents its damage, and Garruk's +1 untaps two lands *and* puts a loyalty counter on him —
   * both have a payoff the question below would miss. See `untapBoughtSomething`.
   */
  readonly untapsOnly?: boolean;
  /**
   * "{0}: ~ gets -1/-0 and gains flying until end of turn" — an ability whose whole effect is a
   * self-pump that does **not** make the creature bigger, and the keywords it grants in exchange.
   *
   * Declared for the bot, and the fourteenth member of the "spent on nothing" family. The second
   * about a loop rather than a card, after `untapsOnly`.
   *
   * **Found by `corpus-decks.mjs` on the very run that measured the increment that caused it.**
   * D496 taught the compiler to read a self-pump whose halves may be negative, and one pod in forty
   * then stopped finishing: *seed 34819 — 2000 moves with no progress in precombat-main of turn 94,
   * 2000 of them `auto:activate` (Hyalopterous Lemure#0)*. The card is real and free and
   * repeatable, and before D496 its line was unread, so the loop could not exist. It is #334's
   * Umbral Mantle shape with the sign reversed: every activation is legal and changes the board, so
   * no stall detector that compares states can see it — the power simply walks down for ever inside
   * one step, the step never passes, and the game cannot end.
   *
   * **`grants` is why this is a field and not a boolean.** The rule is not "never shrink yourself":
   * Hyalopterous Lemure's *first* activation buys flying, and that is the card. What the bot asks is
   * whether the creature **already has** every word this would grant it — and after the first
   * activation it does, so the second buys nothing and the loop dies at one.
   *
   * It is read off the script rather than measured before and after, which was the first attempt and
   * does not work: an activated ability goes on the stack, so `simulate` returns a board where the
   * pump has not happened yet. An instrument said so in one run — `[shrink] no: stack`, 2001 times —
   * rather than being reasoned about (the D489 lesson). The sign is a fact the compiler knows while
   * it is reading the clause, which is where this is set.
   *
   * Only for an ability that does nothing else, like `untapsOnly` beside it. A shrink with a target
   * is somebody else's creature and `TargetSpec` carries that; a shrink that also drains a life is a
   * real play.
   */
  readonly selfShrink?: { readonly grants: readonly Keyword[] };
}

/** An Aura: what it may enchant, and what it does to the thing it is attached to. */
export interface AuraDef {
  readonly target: TargetSpec;
  readonly effect: PumpOptions;
}

/** One mode of a modal spell: what it says, what it points at, and what it does. */
export interface ModeDef {
  /** The mode as printed, e.g. "Exile target creature with power 5 or greater". */
  readonly description: string;
  readonly targets?: readonly TargetSpec[];
  /** Questions asked while this mode resolves. See `DecisionSpec`. */
  readonly decisions?: readonly DecisionSpecOf[];
  readonly effect: EffectFn;
  /**
   * See `CardScript.expiresAtEndOfTurn`. On the mode rather than the card, because a charm's other
   * modes are not pumps: Selesnya Charm exiles a big creature or makes a token, and holding it
   * back for a combat would be wrong for either.
   */
  readonly expiresAtEndOfTurn?: boolean;
  /**
   * See `CardScript.preventsDamage`. On the mode for the same reason: Healing Salve's other mode
   * gains three life, which is never spent on nothing the way a shield is — the life stays until
   * something takes it, so dropping the whole card when no damage is coming would throw away the
   * half that was fine.
   */
  readonly preventsDamage?: boolean;
}

/**
 * "Choose one —", and the handful of shapes around it.
 *
 * Modes are chosen **as the spell is cast** (CR 601.2b), before its targets (CR 601.2c) — not
 * while it resolves. That is the whole reason this is not a `DecisionSpec`: which mode you take
 * decides what the spell is allowed to point at, and an opponent gets to see both before they
 * respond. Scripting a mode as a mid-resolution decision would let a player counter a Charm
 * without knowing what it was going to do, which is a different and much better card.
 *
 * Because the choice travels with the cast, no new engine phase was needed and the table needed no
 * new interface: `legalActions` offers **one play per legal combination of modes**, which is a
 * shape it already had for a permanent with several abilities. A combination whose targets cannot
 * be filled is not offered at all, so "Choose one — destroy target creature; or draw two cards"
 * offers only the draw when there is no creature on the board.
 *
 * `min` and `max` default to 1, which is "choose one". `max: 2` over two modes is "choose one or
 * both"; `min: 2, max: 2` over four is "choose two". Both are clamped to the number of modes.
 */
export interface ModalDef {
  readonly modes: readonly ModeDef[];
  readonly min?: number;
  readonly max?: number;
}

export interface CardScript {
  /** Matched case-insensitively against the card's printed name. */
  readonly name: string;
  /** Keywords the card has, overriding what would be read from its oracle text. */
  readonly keywords?: readonly Keyword[];
  /**
   * Convoke (CR 702.51): each creature tapped as this is cast pays one generic mana, or one mana of
   * that creature's colour.
   *
   * A flag rather than a cost, because it does not change what the spell costs — it changes what
   * may pay for it. `tapToPayPlan` works out which creatures, and taps none that the lands already
   * cover.
   */
  readonly convoke?: boolean;
  /**
   * Improvise (CR 702.126): each artifact tapped as this is cast pays one generic mana.
   *
   * Convoke's sibling and the same kind of flag, through the same `tapToPayPlan` with
   * `'improvise'` for its rule. The two differences are the whole of the mechanic: what may be
   * tapped is an artifact rather than a creature, and what it pays is generic **only** — an
   * artifact's colours never enter into it (CR 702.126a), so a blue artifact cannot pay a {U} pip.
   *
   * Which artifacts get tapped is the engine's choice, exactly as convoke's creatures are, and for
   * the reason that file argues at length: the offer and the payment have to agree about a cost,
   * and they can only do that by asking one function.
   */
  readonly improvise?: boolean;
  /** What the spell targets when cast. For a modal spell the targets live on each mode. */
  readonly targets?: readonly TargetSpec[];
  /** "Choose one —". See `ModalDef`. */
  readonly modal?: ModalDef;
  /**
   * Questions asked while the spell resolves, answered before `onResolve` runs. See `DecisionSpec`.
   */
  readonly decisions?: readonly DecisionSpecOf[];
  /**
   * What the spell does *before* its questions are asked.
   *
   * "Draw two cards, then discard two cards" cannot ask first: the cards it offers to discard are
   * the ones it has not drawn yet. So a card whose question depends on what it has already done
   * puts that half here, the engine asks, and `onResolve` finishes with the answers. Only useful
   * alongside `decisions` — without them it is just a slower `onResolve`.
   */
  readonly beforeDecisions?: EffectFn;
  /** What happens when the spell resolves. A permanent enters the battlefield either way. */
  readonly onResolve?: EffectFn;
  readonly aura?: AuraDef;
  /**
   * "Enters the battlefield tapped": a replacement effect (CR 614.1c) rather than a trigger, so
   * the permanent is never untapped and nothing can be done with it on the way in.
   */
  readonly entersTapped?: boolean;
  /**
   * "~ enters tapped **unless** <condition>" (D587): the check lands, fast lands, slow lands, bond
   * lands and their cousins — the dual lands every Commander deck plays.
   *
   * The same replacement as `entersTapped` (CR 614.1c), with the condition asked as the permanent
   * arrives. `test` answers true when it enters **untapped**; it is given the seat that will control
   * the permanent and the permanent's own id, and it does not count the permanent itself, because
   * the rule asks about the board it is entering — "two or fewer other lands" is about the lands
   * that were already there. `words` is the printed condition, for the table and the log.
   */
  readonly entersUntappedIf?: {
    readonly test: (state: GameState, controller: SeatIndex, self: string) => boolean;
    readonly words: string;
  };
  /**
   * "As ~ enters, you may pay N life. If you don't, it enters tapped." (D587) — the shock lands.
   *
   * A choice made as the land is played, so it is offered as two land plays, one paying and one
   * not, and the answer travels on the action (`AutoPlayLandAction.payLife`). A shock land that
   * arrives any other way — fetched, or put onto the battlefield by an effect — enters **tapped**:
   * the rules give its controller the same choice then, and this engine has no question to ask it
   * with yet, so it takes the answer that costs nothing. Named in the player guide.
   */
  readonly payLifeToEnterUntapped?: number;
  /**
   * "This spell's whole effect is mana": a ritual, and Dark Ritual is the only one in the pool.
   *
   * Nothing in the engine reads it — the mana goes in the pool through `addToPool` like any other
   * mana, and the solver never needs to know where it came from. It is here for the *bot*, which
   * does: mana empties at the end of the step (CR 500.4), so a ritual cast with nothing to spend
   * it on is a card put in the graveyard for nothing, and the search has no other way to tell a
   * spell that did nothing from a spell whose effect it cannot see. Measured before the bot knew:
   * cast 35 times in 120 unsteered games, followed by a spell in the same step 3 times.
   *
   * Declared rather than inferred because inferring it is wrong twice over: the pool in a
   * simulated line can be empty because the step ended, and a permanent that makes mana is a
   * different card that the evaluation already prices correctly.
   */
  readonly makesMana?: boolean;
  /**
   * X is a **number to match**, not an amount of effect: bigger is not better.
   *
   * Declared for the bot, which otherwise casts every X spell for as much as its mana allows —
   * right for a Fireball and a Mind Spring, and nonsense for a Chalice of the Void, where X is the
   * mana value the card then answers. A Chalice cast for four stops nothing anybody plays; a
   * person casts it on one.
   *
   * The search cannot tell the difference on its own, for the reason every other rule in that
   * family exists: the board after the cast is a permanent with some counters on it either way,
   * and what the number is *worth* is a fact about the cards the opponents are holding. So the
   * number is chosen from what they have actually shown. See `xToMatch` in `bot.ts`.
   */
  readonly xIsANumberToMatch?: boolean;
  /**
   * "This spell's whole effect is to prevent combat damage" — a Fog, and its white reprint.
   *
   * Declared for the bot, like `makesMana`, and for the same reason twice over. A Fog cast with
   * nothing attacking is a card in the graveyard, and the evaluation sees a card leaving the hand
   * either way; and the state *after* the cast cannot be asked, because with auto-pass on a spell
   * nobody can respond to resolves inside the same action and the engine keeps passing — a line
   * that ends the turn has already expired the effect the question was about. That mistake was
   * made first, measured (21 Fogs cast, 11 of them into an empty board) and replaced by this.
   *
   * Not on Maze of Ith, which needs no flag: its ability can only target an attacking creature, so
   * the engine does not offer it when there is nothing to prevent.
   */
  readonly preventsDamage?: boolean;
  /**
   * "This card's whole point is to become a copy of a creature" — a Clone.
   *
   * The sixth of the family, and the one whose waste is the most literal: a Clone cast with nothing
   * on the battlefield to copy is a 0/0 that dies as it arrives, four mana for a card in the
   * graveyard. The search should see that — it plays the cast out and the state-based actions kill
   * it inside the same action — and measured over 24 duels it mostly does: nine Clones cast, eight
   * of them with a creature on the table and one into an empty board. The one is the auto-pass trap
   * again, so the board is asked instead of the state after.
   */
  readonly copiesACreature?: boolean;
  /**
   * "This card's whole effect is to remove a creature" — a Doom Blade, a Pacifism, a Turn to Frog.
   *
   * The seventh of the family, and the one found by *playing the mistake out* rather than by
   * counting it. Over 60 duels the bot aimed removal at its own creature seven times, and six of
   * those had **no enemy creature on the board at all**: a Doom Blade on its own Talrand, a
   * Pacifism on its own Serra Angel, a Swords to Plowshares on its own Soul Warden. So the waste
   * is not a mis-aimed spell — it is a spell cast when there was nothing to kill, and the only
   * legal target left was its own side.
   *
   * The search cannot see it for the reason the whole family exists: killing your own creature
   * scores worse than passing, but with auto-pass on, the state after a one-mana instant can be a
   * turn later, and two positions a turn apart do not compare. So the board is asked instead: is
   * there a creature this seat does not control?
   *
   * Not for a card that is good without a creature to kill. A Lightning Bolt can hit a player, a
   * Man-o'-War is a body, and an Unsummon aimed at your own creature is a trick that saves it from
   * removal — none of those is this flag.
   */
  readonly removesACreature?: boolean;
  /**
   * "This body is not a permanent" — it sacrifices itself at the beginning of the end step.
   *
   * A Ball Lightning, a Hellspark Elemental: six or four damage once, and then the card is gone. The
   * sacrifice is **printed text rather than a keyword**, so it is a trigger like any other and this
   * flag changes nothing the engine does — the trigger does all of the work, and a card declaring
   * the flag without the trigger would be a lie a test catches.
   *
   * What it is for is the bot, which cannot otherwise know. `creatureValue` is power, toughness and
   * keywords and `seatValue` counts permanents; **nothing in the evaluation reads a clock**, so a
   * creature that is sacrificed in an hour's time scores as a creature you keep. That costs the bot
   * a specific, provable mistake rather than a judgement: measured over 936 games
   * (`scripts/measure/leaving-creatures.mjs`), it declined 18 attacks with a Ball Lightning or a
   * Hellspark Elemental that was going to die at the end of that same turn — holding back a creature
   * it could not hold, which is the whole card thrown away.
   *
   * Deliberately **not** the same question as "does it have a countdown". A vanishing creature with
   * one counter left is still there to block on the opponent's turn, and a *dashed* creature returns
   * to its owner's **hand**, so losing either in combat costs something real. This flag is only for
   * a body that will not exist after this turn however the combat goes, which is what makes the
   * conclusion a dominance argument instead of a weight.
   */
  readonly leavesAtEndOfTurn?: boolean;
  /**
   * "This spell's whole effect is to keep one of your own creatures alive" — a protection trick.
   *
   * The third of the family, and the one whose measurement was the most lopsided: 64 cast across
   * 160 games and **60 of them with nothing on the stack and no combat in progress**, which is a
   * card thrown away to give a creature +2/+2 until end of turn for no reason at all.
   *
   * It is not the search's fault. The evaluation sees a creature get bigger and a card leave the
   * hand, and both of those are true; what it cannot see is that the bigger creature stops being
   * bigger in a minute. The *board* can say whether the card could matter — is something pointing
   * at one of my creatures, or is there a combat with one of my creatures in it — and that is a
   * fact rather than a weight, which is the line D74 drew.
   *
   * The rule also does something the measurement did not predict: it leaves the card in hand for
   * the moment it is for. Held rather than spent, the search finds it when an opponent's removal
   * is on the stack, because then "cast it" and "pass" play out to different boards.
   */
  readonly protectsACreature?: boolean;
  /**
   * "This spell's whole effect wears off at end of turn" — a pump.
   *
   * The fourth and last of the family, and the one with the widest measurement behind it. Across
   * 160 unsteered games the five pumps in the pool were cast 95 times and **not once during a
   * combat**: 59 of them in the caster's own upkeep or draw step, before a land had been played,
   * on a board where nothing could possibly be attacking.
   *
   * It is the search's horizon rather than its judgement. A cast is scored with `simulate`, which
   * stops when the stack empties, so "+3/+3 until end of turn" is read as a creature that is
   * bigger *now*; the combat it was printed for is past where the simulation looks.
   * `scoreDeclaration` does play through combat, which is why the same bot blocks and attacks
   * well — the gap is only on the cast.
   *
   * So the rule is not "a pump is bad" but **"do not spend now what you can spend better later"**.
   * An instant can wait for blockers; a sorcery cannot wait past this main phase, so one is
   * allowed precombat when there is something to attack with. The bot held nothing back before
   * this and has no other way to learn it: the card is gone two steps before the question.
   */
  readonly expiresAtEndOfTurn?: boolean;
  /**
   * "This spell's whole effect is to goad other people's creatures" — Disrupt Decorum.
   *
   * The fifth of the family and the only one that is about the *table* rather than the board: goad
   * makes a creature attack somebody other than you, so with one opponent there is nobody else and
   * the card does the opposite of what it is for. Paying four mana to be attacked is not a line a
   * search can find its way out of either, because `simulate` stops at the end of this combat and
   * the attack goad forces comes on somebody else's turn — the same horizon that hid the pumps.
   *
   * Declared rather than inferred for the usual reason: "it goads" is a fact about the card, while
   * "there is more than one opponent" is a fact about the board, and the bot asks the board.
   */
  readonly goadsOpponents?: boolean;
  /**
   * What this Equipment gives the creature it is attached to.
   *
   * Declared rather than left inside the equip ability's own effect, because other cards read it:
   * a commander that moves every Equipment you control onto itself has to know what each of them
   * does, and a bonus closed over by one function cannot be asked.
   */
  readonly equipBonus?: PumpOptions;
  /**
   * "Enters the battlefield with N counters on it" (CR 614.1c), where N may be the X it was cast
   * for. A permanent that arrives any other way — reanimated, copied, made as a token — enters
   * with X of zero, which is the rule and not a shortcut.
   */
  readonly entersWith?: { readonly counter: string; readonly amount: number | 'x' };
  /**
   * Bloodthirst N (CR 702.54a): this creature enters with N +1/+1 counters **if an opponent was
   * dealt damage this turn**.
   *
   * Its own field rather than a condition bolted onto `entersWith`, because the two are read by
   * different cards for different reasons and one of them is unconditional: a Triskelion always
   * has its counters, and a reader of `entersWith` should not have to ask whether it does. The
   * condition is the engine's `damagedThisTurn` — damage, not life lost, which is a different
   * record for the reason that field's docblock gives.
   */
  readonly bloodthirst?: number;
  /**
   * "If it's neither day nor night, it becomes day as ~ enters" (D593) — a replacement on the
   * arrival, so it is day before anything that watches the entry looks.
   */
  readonly becomesDayAsItEnters?: true;
  /**
   * **Riot** and **unleash** (CR 702.136a, 702.98a): a choice made as the permanent enters.
   *
   * Both are replacement effects with a question in them — riot is "enters with your choice of a
   * +1/+1 counter or haste", unleash is "you may have this enter with a +1/+1 counter" — so neither
   * is a trigger and neither can be responded to. The question is the spell's one resolution
   * `decisions` entry, asked before the permanent moves, and this field tells the arrival what the
   * answer means: `ENTERS_COUNTER_OPTION` is a counter for either, and anything else is haste for
   * riot and nothing for unleash.
   *
   * Unleash's other half — "can't block as long as it has a +1/+1 counter on it" — is an ordinary
   * conditional static and lives in `statics`, where a counter from any source turns it on, which
   * is what the card says.
   */
  readonly entersChoice?: 'riot' | 'unleash';
  /**
   * Kicker: an optional additional cost, announced as the spell is cast (CR 702.32a).
   *
   * The third member of the family that already holds X and modes, and for the same reason: it is
   * chosen at cast time, both players can see it on the stack, and what it does cannot be decided
   * on resolution without letting a player counter a spell they could not read. The effect reads
   * `ctx.kicked` and branches — one effect function per card rather than two, because a kicked
   * spell is usually the same spell with a number changed.
   */
  readonly kicker?: {
    /** The extra mana, in the printed `{3}` form, on top of the card's own cost. */
    readonly cost: string;
    /** As printed: "Kicker {3}". */
    readonly description: string;
  };
  /**
   * "If this was kicked, it enters with N +1/+1 counters on it [and with haste]" (D561).
   *
   * `entersWith` behind the kicker rather than a condition bolted onto it, for the reason
   * `bloodthirst` is its own field: `entersWith` is unconditional and is applied to **every**
   * arrival (D560), and this is applied only to a spell that was cast and kicked — the one place
   * that knows. A creature put onto the battlefield any other way was not kicked.
   *
   * The keywords are the "and with flying" tail five legal cards print. They are the creature's
   * for as long as it is this object, like riot's haste.
   */
  readonly kickedEntersWith?: {
    readonly counter: string;
    readonly amount: number;
    readonly keywords?: readonly Keyword[];
  };
  /**
   * Buyback: an optional additional cost that changes where the card **goes** (CR 702.26).
   *
   * The kicker's twin and its opposite in the one way that matters. Both are extra mana announced
   * as the spell is cast, both are a second row on the same card at a higher price, and both are
   * read off the stack object so an opponent can see what they are answering. The difference is
   * what they buy: a kicker changes what the spell *does*, and this changes where the card ends up
   * when it is finished — its owner's hand instead of their graveyard.
   *
   * So the effect never reads it. `ctx.kicked` exists because a kicked spell is a different spell;
   * there is no `ctx.boughtBack`, because a bought-back spell is the same spell you get to keep.
   *
   * Two things it is not. It is not a cost that can be paid on a **permanent** spell — a creature
   * that resolves becomes a permanent and never leaves the stack for a graveyard at all, so the
   * cost would buy nothing; `legalActions` offers the row only on an instant or a sorcery and the
   * cast refuses it otherwise. And it does nothing for a spell that is **countered**: the card goes
   * to the graveyard like any other, because the promise is about resolving. See
   * `StackObject.boughtBack`, which is where both of those are enforced.
   */
  readonly buyback?: {
    /** The extra mana, in the printed `{3}` form, on top of the card's own cost. */
    readonly cost: string;
    /** As printed: "Buyback {3}". */
    readonly description: string;
  };
  /**
   * Echo: in the first upkeep after it came under your control, pay again or sacrifice it
   * (CR 702.29).
   *
   * Every other cost in this engine is one a player **chooses** to pay — a cast, an activation, a
   * kicker, a replicate, a ward, an extort. This is the first the *game* asks for: the question
   * arrives on its own in a step nobody was planning to act in, and the consequence of declining is
   * imposed by the rules rather than being "you do not get the thing". So it is the first question
   * here whose "no" **destroys the permanent that asked it**.
   *
   * The field is read in two places and does nothing on its own. `echoDue` is set on the instance
   * wherever a permanent comes under a controller's control, so the trigger knows which upkeep is
   * the one; and the trigger itself is an ordinary `step` trigger built by `echo()` in `scripts.ts`,
   * because everything it needs already existed — a question with a price on one answer
   * (`ChoiceDecisionSpec.payIfChosen`) and an intervening-if condition (`TriggerDef.condition`).
   *
   * What that buys is the half nobody has to write: **a cost that cannot be paid is not offered**,
   * so a player tapped out in their own upkeep is not asked a question with one button — the
   * permanent simply goes, with the words said through the same channel every other unaskable
   * question uses.
   */
  readonly echo?: {
    /** The echo cost, in the printed `{2}{G}` form. Usually the card's own mana cost. */
    readonly cost: string;
  };
  /**
   * Cumulative upkeep: an age counter each upkeep, then that cost **for each counter**
   * (CR 702.24).
   *
   * Echo's shape with a price that climbs, and the reason `DecisionSpecOf` exists: the words, the
   * prompt and the cost are facts about this resolution rather than about the card, so the question
   * is computed when it is asked. Unlike echo there is no flag and no "once" — it is asked every
   * upkeep for as long as the permanent is there, and the keyword *is* the climb.
   *
   * Read nowhere but the card that declares it, like `echo`: the trigger built by
   * `cumulativeUpkeepTrigger` carries the behaviour. It is here so the pool can be audited for the
   * keyword and so the table can say what a permanent owes.
   */
  readonly cumulativeUpkeep?: {
    /** One lot of the upkeep cost, in the printed `{1}` form; the climb multiplies it. */
    readonly cost: string;
  };
  /**
   * Split second: while this spell is on the stack, nobody may cast a spell or activate an ability
   * that is not a mana ability (CR 702.19).
   *
   * The first thing in this pool that restricts what a player may do **because of what is on the
   * stack**, which makes it the first rule here that is about the stack rather than about a card.
   * Everything else that stops a play reads the board, the step or the seat.
   *
   * What it is not is uncounterable. A split-second spell can be countered by anything already on
   * the stack, by a permanent's static answer, and by a triggered ability — Chalice of the Void
   * counters it on cast and does not care in the slightest. In this pool, where every answer to a
   * spell is a *cast* counterspell, that distinction has one consequence in practice and the rule
   * still has to be the rule rather than the consequence.
   *
   * Mana abilities are the exception written into the rule, and they matter: a player who had to
   * tap a land to pay for something else can still do it, which is why the gate reads
   * `AbilityDef.produces` rather than refusing every activation.
   *
   * Read by `legalActions`, which is the one place that decides what a seat may do. A card declares
   * it and nothing else needs to know.
   */
  /**
   * Modular N: this enters with N +1/+1 counters, and when it dies you may move them to another
   * artifact creature (CR 702.43).
   *
   * The first ability in this pool that **moves** counters off a dying permanent rather than
   * reading them, which is what makes it interesting: a card leaving the battlefield loses its
   * counters as it goes, so the number has to come from what was true when it died. That is exactly
   * what `StackObject.subjectCounters` was built for, two keywords ago, for the other shape of the
   * same problem — "for each +1/+1 counter on it" on a creature that is already in a graveyard.
   *
   * It also makes the pool's first printed **0/0**: a modular creature is alive only because of its
   * own counters, which means a Turn to Frog on one kills it, and a −1/−1 counter from a Contagion
   * Clasp cancels a +1/+1 and takes it with it.
   *
   * Read nowhere but the card that declares it, like `echo` and `ninjutsu`: `entersWith` puts the
   * counters on and the trigger `modularTrigger` builds moves them. It is here so the pool can be
   * audited for the keyword.
   */
  readonly modular?: {
    /** Counters it enters with, and — barring anything else — the number that moves on. */
    readonly count: number;
  };
  /**
   * Ninjutsu: swap an unblocked attacker for this card, mid-combat (CR 702.49).
   *
   * Read nowhere but the card that declares it, like `echo` and `splitSecond`: the ability in
   * `abilities` carries the behaviour, with `AbilityCost.returnsUnblockedAttacker` as its cost. It
   * is here so the pool can be audited for the keyword.
   */
  readonly ninjutsu?: {
    /** The mana half of the cost, in the printed `{1}{U}` form. */
    readonly cost: string;
  };
  readonly splitSecond?: true;
  /**
   * "This spell can't be countered." (CR 701.5a, and the "can't" of CR 101.2.)
   *
   * Declared on the **script** and copied onto the stack object as the spell is cast, which is the
   * only arrangement that works: `counterSpell` lives in `effects.ts`, and `effects.ts` cannot
   * reach `scriptForCard` — `derive.ts` imports `compile.ts`, which imports `scripts.ts`, which
   * imports `effects.ts`. So the flag travels the way `x`, `flashback` and `answering` already do,
   * on `StackObject`, read at the moment the caster has the script in hand.
   *
   * It is a flag rather than a dropped line because dropping it makes the card **worse** than
   * printed — answerable when it should not be — and a reading that is wrong in the generous
   * direction is still wrong (D259, D362).
   */
  readonly cantBeCountered?: true;
  /**
   * Vanishing N: this permanent arrives with N time counters and spends one each of your upkeeps,
   * and when the **last one is removed** it is sacrificed (CR 702.63).
   *
   * A clock the owner can read, which is the half the keyword was printed for: fading says the same
   * thing in a way players kept miscounting, so vanishing was given the number people actually
   * wanted — the number of your turns you get. See `fading` for the one-turn difference and
   * `vanishingTrigger` for where it lives.
   *
   * Read nowhere but the card that declares it, like `echo`: the counters come from `entersWith`
   * and the clock is the trigger `vanishingTrigger` builds. It is here so the pool can be audited
   * for the keyword.
   */
  readonly vanishing?: {
    /** Time counters it enters with, which is how many of your turns it gets. */
    readonly count: number;
  };
  /**
   * Fading N: the same clock as vanishing, sacrificed when a counter **cannot** be removed
   * (CR 702.32).
   *
   * Which is one turn longer than it reads, and that is the whole history of the two keywords. A
   * fading 3 creature spends its three counters over three of your upkeeps and is still there — it
   * goes on the fourth, when there is nothing left to remove. So fading N and vanishing N+1 give a
   * player exactly the same number of turns, and the second wording is the one that says so.
   *
   * Read nowhere but the card that declares it, like `vanishing`.
   */
  readonly fading?: {
    /** Fade counters it enters with; it gets one more of your turns than this number. */
    readonly count: number;
  };
  /**
   * Level up: pay to put a level counter on this creature, at sorcery speed (CR 702.87).
   *
   * Only the **ability** is here. What the creature *becomes* at each level is printed data and
   * lives on the definition as `CardDef.levelBands`, read by `characteristics.ts` — the module that
   * turns printed values into current ones, and the one place a script cannot reach back into.
   *
   * So this field is the cost and nothing else, and `levelUpAbility` builds the one ability every
   * leveler has: sorcery speed, repeatable, and no cap. The counters simply accumulate, which is
   * what the printed cards do — a Student of Warfare with nine level counters is in its last band
   * and the tenth counter changes nothing, and that is not a rule the engine has to know.
   *
   * Read nowhere but the card that declares it, like `echo` and `cumulativeUpkeep`: the ability
   * `levelUpAbility` builds, listed in `abilities`, is what the engine offers and charges for. It is
   * here so the pool can be audited for the keyword, and so the table can say what a creature's next
   * level costs without going through the ability list to find out.
   */
  readonly levelUp?: {
    /** The level-up cost, in the printed `{W}` form. */
    readonly cost: string;
  };
  /**
   * Flashback: a second casting, out of the graveyard, for a different cost (CR 702.33).
   *
   * The second zone a spell is ever cast *from* in this engine — the command zone was the first,
   * and that one was a whole missing branch of `legalActions` when it went in. What makes flashback
   * more than a cost is the end of it: the card is **exiled instead of going anywhere else** as it
   * leaves the stack, countered or resolved, which is what stops a one-mana spell being an engine.
   *
   * Replaces the printed cost rather than adding to it, unlike the kicker, and keeps the card's own
   * timing: a sorcery with flashback is still a sorcery.
   */
  readonly flashback?: {
    /** The whole cost of the flashback casting, in the printed `{2}{U}` form. */
    readonly cost: string;
  };
  /**
   * Escape: cast this from your graveyard for a cost that is partly mana and partly cards
   * (CR 702.139).
   *
   * The same zone flashback cast from and a different kind of cost. Flashback replaced the mana and
   * nothing else; escape says "Escape—{2}{R}{R}, Exile three other cards from your graveyard", and
   * the second half of that is the engine's first cost paid out of a **zone** rather than out of
   * the board or the mana pool. Everything already in the engine that pays a cost pays it with
   * something on the battlefield (tap it, sacrifice it, crew with it) or with a life total; the
   * graveyard was a place cards went, and escape is what makes it a resource.
   *
   * It is an **alternative cost**, so it replaces the printed one and nothing else is paid with it
   * — no kicker, no flashback, no commander tax. And unlike flashback the card is not exiled as it
   * leaves the stack: a Phoenix that escaped is an ordinary permanent, and when it dies it goes to
   * the graveyard it came from, ready to escape again for the price of three more cards. That
   * difference is the whole balance of the mechanic, and it is why escape has no `flashback` flag
   * on the stack object.
   *
   * **"Other" is load-bearing.** The card being cast is in the graveyard too, and it is not one of
   * the cards exiled for its own cost — a Phoenix of Ash with exactly three cards in the graveyard
   * including itself cannot escape, and the engine does not offer it. That is CR 601.2h territory:
   * a cost that cannot be paid is not a cost you may pay, so the play is absent rather than
   * offered and refused.
   *
   * Which cards go is the engine's to decide, the way convoke's taps are — see `graveyardFodder`
   * for the order and why it prefers cards nothing else in the deck can use.
   */
  /**
   * **Retrace** (CR 702.81, D599): "You may cast this card from your graveyard by discarding a land
   * card in addition to paying its other costs." Flashback's zone, the printed cost, and D585's
   * discard as the additional cost, narrowed to land cards.
   */
  readonly retrace?: true;
  readonly escape?: {
    /** The mana half, in the printed `{2}{R}{R}` form. */
    readonly cost: string;
    /** How many *other* cards leave the graveyard with it. */
    readonly exile: number;
    /** "~ escapes with N +1/+1 counters on it" (D577): only when it was cast this way. */
    readonly counters?: number;
  };
  /**
   * Delve: each card you exile from your graveyard while casting this pays for {1} (CR 702.112).
   *
   * The other half of escape's idea and the opposite shape. Escape is a fixed cost paid from a
   * fixed zone; delve is a **cost reduction of a size you choose as you cast**, which puts it in
   * the family X belongs to rather than the family flashback belongs to. A Gurmag Angler is a
   * {6}{B} 5/5 with eight cards in the graveyard and a {B} 5/5 with fourteen.
   *
   * Only generic mana, which is the rule rather than a simplification (CR 702.112a): a card
   * exiled this way pays for {1} and can never pay a coloured pip, so delving a {6}{B} spell
   * six times leaves {B} and never less.
   *
   * **The engine delves as little as it can get away with, not as much as it can.** The maximum
   * is free in mana and expensive in everything else — a graveyard is what the escape card, the
   * flashback card and the Gravedigger all spend — so `delvePlan` finds the *smallest* number of
   * cards that makes the spell castable and stops there. A player at a tabletop would make that
   * trade differently on different turns; an engine that always took the maximum would quietly
   * empty the resource two other mechanics in this pool are built on.
   */
  readonly delve?: true;
  /**
   * Foretell: {2} to exile this from your hand face down, and a cheaper cost to cast it later
   * (CR 702.143).
   *
   * The fourth zone a spell is cast *from* in this engine, after the hand, the command zone and the
   * graveyard — and the only one where the card is **hidden** while it waits. An opponent sees a
   * face-down card in exile and knows only that it is something, which is most of what the mechanic
   * is for.
   *
   * Two rules travel with it rather than being asked for separately. Foretelling is a special
   * action taken during your own turn, so it is sorcery-speed by nature; and a foretold card cannot
   * be cast on the turn it was foretold (CR 702.143b), which is why `CardInstance.foretoldTurn`
   * exists. Both are checked in one place rather than left to the scripts.
   *
   * The cost here **replaces** the printed one, like flashback and unlike the kicker — and unlike
   * flashback, the card is not exiled afterwards: it was already in exile and it goes to the
   * graveyard like any other spell.
   */
  readonly foretell?: {
    /** The cost of casting it out of exile, in the printed `{1}{U}` form. */
    readonly cost: string;
  };
  /**
   * Evoke: cast this creature for a cheaper cost, and sacrifice it as it arrives (CR 702.74).
   *
   * The first alternative cost in this engine that changes what happens to the permanent
   * **afterwards**. Flashback, escape and foretell each replaced a cost and were done with it; a
   * Mulldrifter cast for its evoke cost is still a Mulldrifter spell, still resolves onto the
   * battlefield, still draws two cards — and then goes away, which is the whole trade. So the
   * keyword is two halves that have to be kept together: the cost, here, and the sacrifice, which
   * is an ordinary triggered ability on the card itself.
   *
   * The sacrifice is **not** in this declaration, and that is deliberate. CR 702.74a words it as
   * "When this permanent enters, if its evoke cost was paid, sacrifice it" — a triggered ability
   * with an intervening-if clause, which is a shape the engine already has. So the card carries
   * `evokeSacrifice()` in its `triggers` and the engine's only job is to record, on the permanent
   * as it arrives, that the evoke cost was what paid for it. That record is the `EVOKED` counter,
   * for the reason unearth's is: a fact about this body rather than about the card, already
   * per-permanent, already serialised, already visible.
   *
   * Which means the ETB ability the card is actually in the deck for resolves **first** and the
   * sacrifice second, because both go on the stack together and the controller orders their own
   * (CR 603.3b) — the Mulldrifter draws its two cards and only then dies. A player who read the
   * other order would be reading a card nobody would play.
   */
  readonly evoke?: {
    /** The whole cost of an evoked casting, in the printed `{1}{U}` form. */
    readonly cost: string;
  };
  /**
   * Dash: cast this creature for a cheaper cost, attack with it now, and give it back at the end
   * of the turn (CR 702.109).
   *
   * Evoke's mirror, and the second cost in this engine that changes what happens to the permanent
   * afterwards. Evoke buys the spell and gives up the body; dash buys the **body, this turn** and
   * gives up keeping it: the creature has haste, swings on the turn it arrives, and goes back to
   * its owner's hand at the beginning of the next end step — so it is the same card again next
   * turn, for the same price, and it can never be killed by anything that happens on somebody
   * else's turn.
   *
   * Both consequences are the engine's rather than the card's, which is the difference from evoke.
   * Evoke's sacrifice is a *triggered ability* printed on the card, so the card carries it; dash's
   * haste and return are part of the **resolution of the spell** (CR 702.109a) — nothing goes on
   * the stack, so nothing can be countered in between and no opponent gets a window. So
   * `completeResolution` grants the haste and schedules the return as the permanent arrives, and
   * what it writes on the permanent is the `DASHED` counter.
   *
   * The return is a **delayed trigger** (CR 603.7), which is the machinery unearth's end-step exile
   * already uses — and like unearth's, the ability lives on the card as the script's one `delayed`
   * trigger, so it gets a resolution path, a description and a place on the stack without a second
   * mechanism. A card declaring `dash` must carry exactly one, which `dashReturn()` is for and
   * which a test holds.
   */
  readonly dash?: {
    /** The whole cost of a dashed casting, in the printed `{1}{R}` form. */
    readonly cost: string;
  };
  /**
   * Bestow: cast this creature as an **Aura** for a different cost, and get the creature back when
   * the creature it enchants leaves (CR 702.103).
   *
   * The third way to cast one card for a different cost, and the first where what arrives is a
   * different *kind of permanent*. Evoke and dash change what happens to the creature afterwards;
   * this one changes what the spell **is**: a bestowed Boon Satyr is an Aura spell on the stack,
   * so "counter target creature spell" misses it, and an Enchantment — Aura on the battlefield,
   * so a board wipe misses it too. It is not a creature at all while it is attached.
   *
   * And then the half the keyword is printed for: when the enchanted creature leaves, the Aura
   * **becomes a creature** where it stands rather than going to the graveyard (CR 702.103c). That
   * is the only rule in this engine that changes a permanent's type without the permanent moving,
   * and it is what makes bestow a creature with removal insurance rather than an Aura.
   *
   * `effect` is what the enchanted creature gets, in the same vocabulary `aura` uses — a bestowed
   * card has two bodies' worth of text and this is the one that applies to somebody else. The
   * target is not declared: every card printed with bestow says "enchant creature", so the engine
   * supplies that spec rather than letting thirty cards each spell it differently.
   */
  readonly bestow?: {
    /** The whole cost of a bestowed casting, in the printed `{3}{G}{G}` form. */
    readonly cost: string;
    /** What the enchanted creature gets while this is attached to it. */
    readonly effect: PumpOptions;
  };
  /**
   * Spectacle: a cheaper cost you may pay **only if an opponent lost life this turn**
   * (CR 702.137).
   *
   * The fourth alternative cost in this engine and the first with a *condition on the game's
   * history*. Evoke, dash and bestow are always on offer; this one has to be earned, and what earns
   * it is not on the board — a player on eighteen may have been on twenty a moment ago or for four
   * turns. So it needed the engine's second fact about a turn, after storm's spell count:
   * `GameState.lifeLostThisTurn`.
   *
   * "An opponent", not "a player": your own life does not pay for it, which is the rule and also
   * the whole shape of the card — a Skewer the Critics for {R} is the second half of an attack
   * rather than a card you cast on turn one.
   *
   * There is no second effect to declare. The spell does exactly what it does for its printed
   * cost; what the keyword changes is the price and the sentence on the row that says why it is
   * being offered.
   */
  readonly spectacle?: {
    /** The whole cost of a spectacle casting, in the printed `{R}` form. */
    readonly cost: string;
  };
  /**
   * Overload: pay more and the spell stops pointing at one thing and happens to everything
   * (CR 702.96).
   *
   * The fifth alternative cost here and the first that changes **what the spell does**. Evoke and
   * dash change what happens to the permanent afterwards; bestow changes what kind of object the
   * spell is; spectacle changes only the price. This one rewrites the text: "change each instance
   * of 'target' to 'each'", so a Mizzium Mortars for {1}{R} kills one creature and the same card
   * for {3}{R}{R}{R} kills all of theirs.
   *
   * Two consequences, and they are the reason the field holds an effect rather than a number.
   *
   * The spell **targets nothing** when it is overloaded, which is not a detail: it cannot be
   * Willbendered, a ward does not see it, "sacrifice this creature when it becomes the target of a
   * spell" never fires, and it does not fizzle when the one creature worth killing is saved. So the
   * alternative carries `specs: []` the way bestow carries its own, and the overloaded play asks
   * the player nothing.
   *
   * And the effect is a different effect, so the card writes it out. The printed `onResolve` reads
   * `cardTargets`, which is empty on an overloaded cast, so a shared effect that tried to serve
   * both halves would have to branch on a flag inside every such card — and a card whose two halves
   * are two functions is the honest shape, because the two halves are two different spells with one
   * name. `completeResolution` picks between them on the stack object's `overloaded`.
   *
   * It is dearer than printed, like the kicker, and replaces the printed cost, unlike the kicker.
   */
  readonly overload?: {
    /** The whole cost of an overloaded casting, in the printed `{3}{R}{R}{R}` form. */
    readonly cost: string;
    /**
     * What the spell does when it was overloaded, instead of its printed `onResolve`.
     *
     * Runs with no targets, because an overloaded spell has none, and with the same context
     * everything else gets — so it reads the board through `battlefield` and `c.controller` the way
     * a sweeper does.
     */
    readonly onResolve: EffectFn;
  };
  /**
   * Morph: cast this face down as a 2/2 for {3}, and turn it up later for this cost (CR 702.37).
   *
   * Only the *turn-up* cost lives here. The face-down casting costs {3} for every card that has
   * morph, which is printed in the rule rather than on the card, so the engine holds it as a
   * constant and a script that tried to name a different one would be describing a card that does
   * not exist.
   *
   * What makes morph more than two costs is that both halves are already built: a face-down
   * permanent is a 2/2 with no abilities (CR 707.2), which `characteristicsOf` does by substituting
   * a profile for the card, and `isFaceDownPermanent` keeps its triggers, mana and abilities from
   * applying. Morph is the card-facing half of that — the cast, and the special action that turns
   * it over.
   *
   * Turning it face up is **not** casting it and does not use the stack (CR 702.37b): nobody may
   * respond, which is the point of the mechanic. It is also not a new object, so the creature keeps
   * its damage, its counters, whether it is tapped, what is attached to it, and how long it has
   * been on the battlefield — a morph that has been down since last turn can attack the moment it
   * is turned up.
   */
  readonly morph?: {
    /**
     * The whole turn-up cost, in the same vocabulary an activated ability's cost uses.
     *
     * An `AbilityCost` rather than a mana string, because a morph cost is not always mana: Zombie
     * Cutthroat's is "pay 3 life" and nothing else. Reusing the type rather than growing a second
     * one means the life clause's own rule comes with it — a cost you cannot pay is not a cost you
     * may pay, so a player on three life is not offered a turn-up that would kill them, which is
     * exactly what `AbilityCost.life` already says about Mana Confluence.
     *
     * Not every field of it makes sense here and the engine only pays the two that do, `mana` and
     * `life`. A `tap` on a turn-up cost would be a card that does not exist, and `crew` and
     * `loyalty` belong to other mechanics; a script asking for one of those gets nothing rather
     * than a quiet approximation, which is what `morphCostText` and `payMorphCost` both say.
     */
    readonly cost: AbilityCost;
    /**
     * Megamorph: turning it face up also puts a +1/+1 counter on it (CR 702.37c).
     *
     * One flag, because that is the whole difference between the two keywords. The counter is part
     * of the *same* action as the turn-up rather than something that happens afterwards — a
     * megamorph whose counter arrived from a trigger could be answered between the two halves, and
     * turning a permanent face up is specifically the thing nobody may respond to.
     */
    readonly mega?: true;
    /**
     * Disguise: the face-down creature also has ward {2} (CR 702.168a, D598). See
     * `DISGUISED_FACE_DOWN`. The turn-up is the same special action as morph's.
     */
    readonly disguise?: true;
  };
  /**
   * An additional cost that is not optional: "As an additional cost to cast this spell, sacrifice
   * a creature."
   *
   * A **cost**, like the sacrifice on an activated ability: paid as the spell is cast, so it
   * cannot be responded to and the creature cannot be saved in reply. A spell whose additional
   * cost cannot be paid is not castable at all (CR 601.2h), which is why it is not offered rather
   * than offered and refused.
   */
  readonly additionalCost?:
    /**
     * A permanent of the caster's choosing. `sacrificeSubtypes` narrows it the way it narrows
     * `AbilityCost.sacrifice` — "sacrifice a Goblin" (D585).
     */
    | {
        readonly sacrifice: NonNullable<AbilityCost['sacrifice']>;
        readonly sacrificeSubtypes?: readonly string[];
      }
    /**
     * "As an additional cost to cast this spell, discard a card" (D585).
     *
     * One card of the caster's choosing, out of the hand the spell is being cast from — never the
     * spell itself, which is on its way to the stack. Chosen as the spell is cast and carried on
     * the action as `discarded`, the field an ability's "Discard a card" cost already uses.
     */
    | { readonly discard: true }
    /**
     * "As an additional cost to cast this spell, pay N life" (D585), with N printed.
     *
     * Nothing to choose, so nothing on the action: the spell is offered only to a player who can
     * pay it, by the rule every life cost here keeps, and the life is lost as it is cast.
     */
    | { readonly life: number }
    /**
     * "As an additional cost to cast this spell, pay X life" (D579) — Toxic Deluge.
     *
     * X with no `{X}` in the mana cost: it is still announced as the spell is cast (CR 601.2b) and
     * paid then, so the number is on the stack for an opponent to read and the life is gone
     * whether or not the spell resolves. The pool's Deluge chose its number **on resolution**,
     * which was a different card twice over: a countered Deluge cost no life, and nobody could
     * see how big it was before deciding to answer it.
     *
     * It reuses the X a mana cost already carries — `action.x`, `StackObject.x`, `LegalPlay.xMax`
     * — because that is what it is; only the currency differs. `xMax` is the life the caster may
     * pay, by the rule every life cost here keeps.
     */
    | { readonly lifeX: true };
  /**
   * Which X to open on, for a spell whose best X is not its largest (D579).
   *
   * Read twice: by `legalActions`, which reports it as `LegalPlay.xDefault` so a table opens the
   * question on a sensible number, and by the bot, which casts for it. A Fireball has no need of
   * one — more is better and the default is everything available — but a Toxic Deluge opened on
   * "pay 19 life" would be a table suggesting the worst answer it has. Clamped to `xMax` by the
   * caller, so a hint cannot offer a number the seat may not choose.
   */
  readonly bestX?: (state: GameState, seat: SeatIndex, xMax: number) => number;
  /**
   * "This spell costs {N} more to cast for each target beyond the first" (D579) — Fireball.
   *
   * Generic mana added as the spell is cast, counted off the targets it was announced with: a
   * cost that depends on a choice made in the same announcement (CR 601.2b then 601.2f), which is
   * why it is charged in `castSpell` rather than computed by `costChangeFor` — that function
   * prices a card before anybody has aimed it. `LegalPlay.extraTargetCost` carries the number to
   * the table so the X it offers and the targets it takes can be kept inside what the seat can
   * pay.
   */
  readonly extraTargetCost?: number;
  /**
   * A Saga: it enters with a lore counter, gains one at the beginning of its controller's
   * precombat main phase, and is sacrificed once its last chapter has resolved (CR 714).
   *
   * A flag rather than a chapter list, and the chapters live in `triggers` with
   * `on: { kind: 'chapter', n }` like any other triggered ability — which means they get targets,
   * mid-resolution questions and the stack for free, and means **the number of chapters is derived
   * from them** rather than declared beside them. A `chapters: 3` field that could disagree with
   * the triggers is a field that eventually does.
   *
   * The sacrifice is a state-based action and not a fourth chapter, which is the rule and also the
   * only version that behaves: a Saga whose last chapter is countered still goes away, because what
   * the game checks is the counters and an empty stack rather than whether an ability resolved.
   */
  readonly saga?: true;
  readonly triggers?: readonly TriggerDef[];
  readonly abilities?: readonly AbilityDef[];
  /**
   * Static effects the permanent creates while it is on the battlefield.
   *
   * The scope is a bare name for the four that need no argument, and an object for the one that
   * does: `{ subtype: 'Goblin', other: true }` is every lord ever printed. An object rather than
   * four more names, because the thing being named is a *parameter* — there is one subtype scope
   * and sixty creature types, and an enum of them is the mistake D57 is about.
   */
  readonly statics?: readonly {
    readonly scope:
      | 'self' | 'controller-creatures' | 'other-controller-creatures' | 'all-creatures'
      | { readonly subtype: string; readonly other?: boolean };
    readonly effect: PumpOptions;
  }[];
  /**
   * **Soulbond** (CR 702.95): pair this creature with another unpaired creature you control as
   * either of them enters, and while they are paired each of them gets what this says.
   *
   * Declared rather than written as a `statics` entry, although it ends up as one, because the
   * scope is the thing that is new. Every other static reaches a set of cards fixed when the
   * permanent arrived; this one reaches *the pair*, which is made and broken by state-based action
   * afterwards — so it is created with `scope: 'pair'` and asks `pairedWith` every time it is read.
   * See `ContinuousEffect`'s `pair` scope for why that is better than editing an `ids` list from
   * the three places a pair can break.
   *
   * `effect` is in the `PumpOptions` vocabulary because every soulbond ever printed reads "each of
   * those creatures gets +N/+N" or "each of those creatures has <keyword>" — the keyword's whole
   * grammar is a continuous effect on two creatures, and a card that said anything else would be a
   * different mechanic.
   *
   * **The pairing itself is two triggers on the card**, not something the engine does, and a card
   * declaring `soulbond` must carry both — which `soulbondTriggers()` is for and which a test
   * holds, the same arrangement `dash` and `dashReturn()` have. Two rather than one because the
   * printed ability fires on either creature entering and the two cases ask the player different
   * questions: when the soulbonded creature arrives there may be several unpaired creatures to
   * choose between, and when somebody else arrives the only question is whether to pair with *it*.
   */
  readonly soulbond?: { readonly effect: PumpOptions };
  /**
   * Triggered abilities this card **gives to other permanents**: "both creatures have 'Whenever
   * this creature deals damage to a player, draw a card'".
   *
   * A list on the card rather than an ability inside the `PumpOptions` that grants it, because a
   * `TriggerDef` holds functions and the effect that carries it has to stay serialisable — see
   * `ContinuousEffect.grants`, which holds *indices into this array*. So a grant is declared in
   * two halves: the ability here, and `grants: [0]` on whichever `PumpOptions` hands it out. Any
   * of them will do, which is the point: an Aura's `effect`, a bestowed one, an Equipment's bonus,
   * a `statics` entry or `soulbond`'s pair all reach it through the same `modsFrom`.
   *
   * **The ability belongs to the creature that was given it, not to this card** (CR 113.6). It
   * fires off that creature's events, its `c.source` is that creature, and its controller is that
   * creature's controller — which is what makes "whenever **this creature** deals damage" read
   * correctly when the thing saying it is an Aura on somebody else. Nothing extra is needed for
   * that: the trigger is collected as though the holder had printed it.
   */
  readonly grantedTriggers?: readonly TriggerDef[];
  /**
   * **Activated** abilities this card gives to other permanents: `Enchanted creature has "{T}: This
   * creature deals 1 damage to any target."` — Fire Whip, Lavamancer's Skill, Quicksilver Dagger.
   *
   * `grantedTriggers`' sibling, the same two halves for the same reason: an `AbilityDef` holds
   * functions, so the effect carries `grantsAbilities: [0]` — *indices into this array* — and the
   * script stays the single definition. Two arrays rather than one tagged list, because the two
   * are used at different moments and by different code: a trigger is collected when an event
   * happens, an activated ability is offered in `legalActions` and paid for in `autoActions`, and
   * a single list would have every reader of it ask which kind each entry was.
   *
   * **The ability belongs to the permanent that was given it** (CR 113.6): its cost is paid by
   * that permanent — `{T}` taps the host, not the Aura — its controller is that permanent's
   * controller, and "this creature" in its text means the host. The engine gets that by pushing
   * the ability with the *host* as `StackObject.source` and the grantor only in
   * `StackObject.grantedBy`, which is what the definition is looked up by.
   *
   * ## Why this is not reachable through `abilities`
   *
   * A permanent's own `abilities` are indexed by position in its script, and `AutoActivateAction`
   * carries that index. A granted ability has no position on the host's script, so the action
   * carries `grantedBy` — the grantor and the index in *this* array — rather than an index into a
   * list assembled on the fly. An assembled list would renumber itself whenever an Aura arrived or
   * left, which is to say between a bot composing an action and the engine applying it.
   */
  readonly grantedAbilities?: readonly AbilityDef[];
  /**
   * What this permanent does to the **cost of other people's spells** while it is on the
   * battlefield: a Goblin Electromancer, a Thalia, a Sphere of Resistance.
   *
   * Its own declaration rather than another `statics` entry, because it is not the same kind of
   * thing: `statics` change a creature's characteristics and are read by the layer system, while
   * this changes what a *spell* costs and is read by the cost planner. Sharing a shape would mean
   * a `PumpOptions` with a mana field in it, which is the sort of union D57 warns about.
   *
   * `generic` is mana added (positive) or taken off (negative). Only generic, which is the rule
   * rather than a simplification: a reduction never touches a coloured requirement (CR 601.2f), so
   * "{1} less" on a `{U}{R}` spell changes nothing at all and a card that says otherwise is a
   * different card.
   *
   * `applies` is a predicate on the card being cast rather than an enum of spell kinds, for the
   * reason `TargetSpec.filter` is: every card words it differently — instant and sorcery, every
   * noncreature spell, artifact spells, spells with a creature type in them — and an enum would be
   * short of what the next card needs.
   */
  readonly costModifiers?: readonly {
    /**
     * Whose spells this applies to. `everyone` includes the permanent's own controller, which is
     * the whole of what makes a Thalia a cost rather than an advantage.
     */
    readonly whose: 'controller' | 'opponents' | 'everyone';
    readonly applies: (state: GameState, caster: SeatIndex, card: CardDef) => boolean;
    /** Generic mana added, or taken off when negative. */
    readonly generic: number;
    /** Shown on the play when the cost changed: "costs {1} less". */
    readonly description: string;
  }[];
  /**
   * **Affinity for artifacts**: this spell costs {1} less to cast for each artifact you control
   * (CR 702.41a).
   *
   * `costModifiers`' mirror, and the two are worth keeping apart rather than folding together. A
   * Goblin Electromancer is a permanent on the battlefield changing what *other* spells cost, so it
   * is declared where it sits and found by a pass over the battlefield. Affinity is a word on the
   * card *being cast*, reading its own caster's board — nothing on the battlefield has to be asked
   * about it, and the only seat it can ever read is the one casting.
   *
   * They meet in `costChangeFor`, which is the one function that answers "what does this cost here,
   * for this seat". That is what makes the offer and the payment agree, and what makes affinity work
   * under an alternative cost for free.
   *
   * Counted **as the cost is computed**, which is what the keyword says rather than a shortcut: a
   * Frogmite offered at {1} with three artifacts out goes back to {4} the moment they are answered,
   * and the number is never stored anywhere. Only generic mana moves, like every other reduction
   * (CR 601.2f), so an affinity card with a coloured requirement keeps it.
   *
   * A value rather than a bare `true` because the keyword is parameterised in print — affinity for
   * artifacts, for Plains, for Slivers — and `artifacts` is the one the pool has cards for. The day
   * another arrives it is a second member of this union rather than a second field.
   */
  readonly affinity?: 'artifacts' | AffinityFor;
  /**
   * A change to **this spell's own** cost that the board decides: "This spell costs {1} less to
   * cast if an opponent controls no basic lands" (D578).
   *
   * Affinity's neighbour and the same arrangement: a clause on the card being cast, reading the
   * table as the cost is computed, so the offer and the payment agree because `costChangeFor`
   * answers both. A predicate rather than a list of conditions for `costModifiers.applies`'
   * reason — 108 legal lines print "costs {N} less to cast if …" and they name 83 different
   * conditions.
   *
   * Generic only, negative for less, and floored at nought with every other reduction.
   */
  readonly selfCostChange?: {
    readonly generic: number;
    /** `card` is the instance being cast, when the caller has one. */
    readonly when: (state: GameState, caster: SeatIndex, card?: string) => boolean;
    /**
     * "for each …" (D601): `generic` is the rate and this the count, so "{1} less for each creature
     * card in your graveyard" is `generic: -1` times however many there are as the cost is computed.
     * Absent means once.
     */
    readonly per?: (state: GameState, caster: SeatIndex, card?: string) => number;
    /** Shown on the play when it applies: "costs {1} less". */
    readonly description: string;
  };
  /**
   * Replacement effects this permanent contributes, for an event happening to *another* object
   * (CR 614).
   *
   * The two replacement effects already in the engine — regeneration and "enters tapped" — are
   * shields that sit on the card they affect, and they got away with it because that is where they
   * are printed. "If a nontoken creature an opponent controls would die, exile it instead" cannot:
   * the effect belongs to one permanent and changes what happens to a different one, so there has
   * to be a *pass* that asks every permanent on the table whether it wants to replace what is
   * about to happen. This is the declaration side of that pass.
   *
   * `applies` is a predicate rather than a scope enum for the same reason `TargetSpec.filter` is:
   * every card words this differently — an opponent's, a nontoken one, a creature rather than a
   * permanent — and an enum would either be short of what the next card needs or carry values no
   * card uses, which D57 is the warning about.
   *
   * `instead` is handed the dying permanent and returns the state with it dealt with. It is run
   * before the death event is raised, so a replaced death is not a death and nothing triggers off
   * it — which is what the rules say and the whole reason this is a replacement rather than a
   * trigger of its own.
   */
  /**
   * Madness: if you discard this card, it goes to exile instead and you may cast it for this cost
   * (CR 702.35a).
   *
   * A field rather than a `replaces` entry the card writes itself, for the reason flashback and
   * escape are fields: the **cost** has to be readable by everything that wants it. `legalActions`
   * prices the play from it, `settleOffer` asks whether it can be paid, and the bot's discard
   * policy reads it to decide that a madness card is not a discard at all but a cheap spell. A
   * cost buried inside a replacement effect's closure is a cost only that closure can see.
   *
   * The replacement itself is installed by the engine — see `replaceZoneChange` — which also keeps
   * the keyword's two halves from disagreeing: the engine that offers the cast is the engine that
   * replaced the discard.
   */
  readonly madness?: { readonly cost: string };
  /**
   * Miracle: if this is the **first card you drew this turn**, you may cast it for this cost as it
   * is drawn (CR 702.94a).
   *
   * A field rather than a trigger the card writes itself, and the shape is madness's exactly: the
   * **cost** has to be readable by everything that wants it, and the thing that offers the cast is
   * the engine rather than the card. `settle` raises the offer as it drains the draws, which is the
   * only moment the engine knows a card was *drawn* rather than put into a hand, and `settleOffer`
   * asks whether the cost can be paid before stopping the table with a one-button question.
   *
   * It is the first cost in this engine conditioned on **when in the turn** a card arrived. The
   * three things it needs are a draw that says which card it was, a count of the turn's draws, and
   * an offer that leaves the card where it is when declined — `GameState.drew`'s `nth`,
   * `GameState.cardsDrawnThisTurn` and `pendingOfferedCast.stays`.
   *
   * What it deliberately does not model is the **reveal**. The printed card is revealed from your
   * hand as you draw it, whether or not you then cast it; here the offer is a question put to its
   * own seat and the opponent learns the card only if it is cast. That is a hidden-information
   * difference in the player's favour and it is small — but it is a difference, and a card that
   * punished an opponent for the reveal would need the reveal to be real.
   */
  readonly miracle?: { readonly cost: string };
  /**
   * Rebound: cast it from your hand and it comes back next turn, for nothing (CR 702.88).
   *
   * The fourth card in the engine that is cast twice and the first that pays for the second casting
   * with **time** rather than with a cost. Flashback charges a second price; escape charges mana and
   * a graveyard; madness and miracle charge less than the printed cost once. Rebound charges
   * nothing at all — and the reason it is fair is that you have to still be alive next turn, and
   * your opponent gets a whole turn in between to make the second copy matter less.
   *
   * `true` rather than a cost, because there is no cost: everything about the keyword is the
   * engine's. As the spell resolves it goes to **exile** instead of to the graveyard, and the card
   * schedules a delayed trigger for its controller's next upkeep (CR 603.7) whose resolution offers
   * the free cast — so a card declaring `rebound` must carry exactly one `delayed` upkeep trigger,
   * which `reboundCast()` is for and which a test holds. The same arrangement dash and unearth use:
   * the ability lives on the card, so it gets a description, a place on the stack and a resolution
   * path without a second mechanism.
   *
   * Two halves of the rule are load-bearing and both are about the *second* casting. It only
   * happens if the spell was cast **from a hand** — see `StackObject.rebounding` — so the rebound
   * cast, which comes from exile, does not rebound again. And declining leaves the card in exile
   * for good: `pendingOfferedCast.stays` is miracle's flag doing a second job, because "do not move
   * it" is the same disposition whether the card is sitting in a hand or in an exile.
   *
   * What it deliberately does not model is the one-shot nature of the *offer* beyond the exile: a
   * card still in exile when its upkeep comes round again is not offered twice, because the delayed
   * trigger is consumed when it resolves and nothing schedules another.
   */
  readonly rebound?: true;
  /**
   * Replicate: pay this cost as many times as you like, and copy the spell for each (CR 702.56).
   *
   * The engine's first cost that can be paid **more than once on one casting**, and the first
   * number announced as a spell is cast that is not {X}. Everything else in the cost family is a
   * yes or a no: a kicker is paid or not, an alternative cost replaces the printed one or does not.
   * This is a count, and what it buys is copies rather than a bigger effect.
   *
   * Offered as **one play per count** rather than as a number picker, which is the kicker's
   * arrangement rather than {X}'s and is deliberate. The table already draws a second play on the
   * same card with a different cost; a count whose ceiling is the mana available is exactly that
   * list, one entry per affordable number, and it needs nothing new in the client. {X}'s picker
   * exists because X ranges to twenty; replicate in this pool ranges to three.
   *
   * The copies are the card's own **self spell-cast trigger**, the shape storm uses
   * (`replicate()`), reading the count off `StackObject.replicated`. Each copy keeps the original's
   * targets and its division, like storm's: the printed card offers new targets for the copies and
   * the engine does not, which is the narrower reading and the one that cannot be wrong in the
   * player's favour.
   */
  readonly replicate?: { readonly cost: string };
  /**
   * Suspend: pay a cost now to exile the card with time counters, and cast it for nothing when the
   * last counter comes off (CR 702.62).
   *
   * The only mechanic in this engine that spends **turns** as a resource. Rebound buys a second
   * casting with a turn of waiting; suspend buys a *first* casting cheaply with several — a {R}
   * sorcery on turn one that deals three damage on turn two, out of mana nobody had.
   *
   * Three pieces, each of which already existed on its own. The special action is foretell's: a
   * play from hand that is not a cast, pays a cost of its own and puts the card in exile (see
   * `auto:suspend`). The counters are ordinary counters on a card that happens not to be on the
   * battlefield. And the free cast is the offer family for the fourth time — with the one thing it
   * needed: the cast is **mandatory** when it can be made (CR 702.62c), so the offer carries
   * `mandatory` and the table offers no pass while it stands. A suspended card that *cannot* be
   * cast — no legal target — stays in exile, which is the rule and also what falls out of an offer
   * nobody can take.
   *
   * A creature cast this way gains **haste** until end of turn (CR 702.62e); nothing in this pool
   * suspends a creature yet, and the engine grants it where the cast resolves rather than making
   * each card say so.
   */
  readonly suspend?: { readonly cost: string; readonly counters: number };
  /**
   * Dredge: a draw you may replace by milling this many cards and taking this card back
   * (CR 702.52a).
   *
   * The first replacement effect in this engine that applies to a **draw** rather than to a card
   * that is moving, and the difference is the whole of why it needed new machinery. A replaced
   * zone change can be asked about after the fact — the card has moved, `settle` finds it in the
   * list and hands it to whatever replaces it. A replaced draw cannot: the question has to be
   * answered before the card is taken, and by then it is in a hand and the answer is moot.
   *
   * So the draw is deferred rather than paused. See `drawLater` and `GameState.drawsOwed` — and the
   * rule that follows from it: dredge is offered for a draw the *engine* performs (the draw step)
   * and for a card whose draw is the last thing it does, because only a draw with nothing after it
   * can be moved to the end of the action without changing what the card does.
   *
   * The cost is cards off your own library, which is the keyword's real price: a dredge with the
   * library too short to pay is not offered at all (CR 702.52a), so it cannot be used to deck
   * yourself and it stops working exactly when you most want it.
   */
  readonly dredge?: { readonly mill: number };
  readonly replaces?: readonly {
    /**
     * Which zone change this replaces. The three are the same move seen at three widths, and a
     * card that says the widest one really does mean it:
     *
     * - `dies` — a permanent going to a graveyard **from the battlefield** (CR 700.4). Kalitas.
     * - `to-graveyard` — a card going to a graveyard **from anywhere**: a death, a discard, a
     *   mill, a spell finishing its resolution. Rest in Peace, Leyline of the Void.
     * - `leaves-battlefield` — a permanent going anywhere that is not another battlefield: dying,
     *   exiled, bounced, sacrificed. Unearth's "or if it would leave the battlefield".
     *
     * **One move is replaced once, and the widest applicable wording wins.** A creature dying
     * while an opponent has a Leyline of the Void is one event, and whichever effect replaces it
     * the creature is exiled and did not die — so no death trigger fires and nothing sees a card
     * reaching a graveyard. `settle` therefore asks the wide wordings first and drops the ids they
     * handled out of the narrower lists; see `replaceZoneChange`.
     */
    readonly on: ReplacementEvent;
    readonly description: string;
    readonly applies: (ctx: ReplacementContext) => boolean;
    readonly instead: (ctx: ReplacementContext) => GameState;
    /**
     * "If a card **or token** would be put into a graveyard…" — Rest in Peace's wording (D576).
     *
     * A token has ceased to exist by the time a replacement is asked (CR 111.7), so there is no
     * instance to hand `applies` or `instead`. What the rule changes for a token is only what it
     * did **not** do: it was exiled, so it did not reach a graveyard and did not die, and nothing
     * watching for either sees it. Set only on a rule whose `applies` is unconditional, because
     * for a token it is not consulted.
     */
    readonly tokens?: boolean;
  }[];
}

/** The zone changes a card's `replaces` entry can be written against. See `CardScript.replaces`. */
export type ReplacementEvent = 'dies' | 'to-graveyard' | 'leaves-battlefield';

/**
 * What a replacement effect is asked about: the card it is replacing the event for, and the
 * permanent whose effect this is.
 *
 * `subject` has **already made the move** by the time this runs — it is in the graveyard, the hand
 * or the exile it was heading for — which is the shape of the engine's answer to replacement
 * effects generally; see `settle`. Read it for what the card *was*, not for where it is, and read
 * `state.vanished[subject]` when what matters is the counters it was carrying on the battlefield.
 */
export interface ReplacementContext {
  readonly state: GameState;
  /** The card the event is happening to. */
  readonly subject: string;
  /** The permanent whose replacement effect this is. */
  readonly source: string;
  /** Who controls `source`. */
  readonly controller: SeatIndex;
  /**
   * Whether the move being replaced was a **discard**: a card going from a hand to a graveyard.
   *
   * Only madness asks (CR 702.35a), and only madness could: a Fiery Temper milled off the top of a
   * library, or put into a graveyard after resolving as a spell, is in the same `to-graveyard` list
   * as one that was discarded, and the card is already in the graveyard by the time this runs — so
   * the zone it came from is not readable from the board. See `GameState.discarded`.
   */
  readonly discarded: boolean;
}

export const targetCount = (spec: TargetSpec): number => Math.max(1, spec.count ?? 1);

/**
 * What every morph costs to cast face down: {3} (CR 702.37a).
 *
 * In the rule rather than on the card, so it is one constant rather than a field on each script —
 * and a constant both halves read, because `legalActions` offers the play and `castSpell` pays for
 * it, and this file exists to keep an offer and a payment from disagreeing.
 */
export const MORPH_COST = '{3}';

/**
 * A morph cost as a player reads it: "{2}{U}", "pay 3 life", or both.
 *
 * Here rather than in `legalActions` because the offer and the log both want the same sentence,
 * and two formatters would eventually disagree about one of them.
 */
export function morphCostText(cost: AbilityCost): string {
  const parts: string[] = [];
  if (cost.mana !== undefined && cost.mana !== '') parts.push(cost.mana);
  if (cost.life !== undefined) parts.push(`pay ${cost.life} life`);
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}

/**
 * What foretelling costs: {2} (CR 702.143a).
 *
 * In the rule rather than on the card, like morph's {3}, and a constant both halves read —
 * `legalActions` offers the special action and the reducer pays for it.
 */
export const FORETELL_COST = '{2}';
