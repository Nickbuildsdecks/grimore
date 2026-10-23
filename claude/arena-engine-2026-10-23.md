# The Arena engine — checkpoint, 2026-10-23

An MTG Arena-style rules engine on top of the Play Realm tabletop: steps and priority, the stack,
targeting, combat, continuous effects, state-based actions, and a script per card. A table opts in
with `auto:start`; one that does not is the tabletop exactly as it was.

This is the follow-on from `claude/play-realm-setup.md`, which built the manual tabletop and said
of it: *"The action model is shaped so per-card automation can be layered on later without redoing
any of this."* That turned out to be true — no tabletop action changed, and the two modes share one
`GameState`.

---

## What a player can now do

Start a table and choose **Play with the rules engine** instead of **Play as a tabletop**. From
there the computer plays Magic with you:

- The turn runs itself: untap, upkeep, draw (skipping the first player's first draw), main phases,
  combat, end step, and a cleanup that stops and asks you to discard to hand size.
- Priority is tracked and shown. The table always says which step it is and who it is waiting for.
- Casting a spell puts it on the stack, where the other player can respond; passing resolves it.
- Targets are chosen from the list the engine computed, so an illegal target cannot be picked, and
  a spell whose targets have all gone is countered on resolution (CR 608.2b).
- Mana is tapped for you. You can still tap lands yourself first if you want particular ones spent.
- Combat asks the attacker to declare, then the defender to block, then deals damage — with flying,
  reach, menace, trample, deathtouch, lifelink, first and double strike, and vigilance.
- Creatures die when they should, auras fall off when their host leaves, life totals move on their
  own, and the game ends when somebody hits zero.
- A card nobody has scripted still works as cardboard, and **Move by hand** is one tap away.

A one-player table is a short step from here: `packages/rules-engine/src/bot.ts` already plays.

---

## Where it lives

| Module | What it owns |
| --- | --- |
| `mana.ts` | Costs, pools, payment, and `solveTap` — which lands to tap for a cost |
| `characteristics.ts` | What a permanent currently *is*: P/T, keywords, continuous effects |
| `turnTypes.ts` | Steps, the stack object, combat state, the automated action shapes |
| `effects.ts` | The vocabulary scripts are written in (damage, draw, pump, tokens, control) |
| `scriptTypes.ts` | The shape of a card script |
| `scripts.ts` | All 22 scripted cards |
| `targeting.ts` | Legal targets, the duplicate-target rule, the fizzle rule |
| `combat.ts` | Who can attack, who can block, damage assignment |
| `automation.ts` | Steps, priority, triggers, state-based actions, resolution |
| `autoActions.ts` | The reducer for `auto:*` — what a player may do and what happens |
| `legalActions.ts` | What a seat can legally do right now, for the client |
| `bot.ts` | A player that only ever does what the engine offers |
| `view.ts` | Per-seat redaction, now carrying the automation block |

In the web app: `lib/arena.ts` (the interaction reducer), `components/table/{PhaseBar, StackPanel,
ArenaBar, PlaySheet}.tsx`, and `pages/PlayTable.tsx` branching on `view.automation`.

---

## The decisions, and why

**Nothing dies in combat.** Damage is marked on the creature; lethal damage is noticed by
state-based actions after every action (CR 704). That is the rule, and it is also what makes "pump
it in response to the bolt" work with no special case anywhere — the pump changes the toughness, the
marked damage is re-read, and the creature lives.

**Triggers are raised by the engine, never announced by scripts.** A script declares *when* it wants
to fire; the moments themselves — a permanent entering, a creature dying, a spell being cast, life
being gained — are detected in `settle`, by comparing the state before and after. A script cannot
forget to announce itself because it never announces itself. Life gain in particular is detected by
comparing totals, which is the only way lifelink, a spell and an ability all reach the same trigger.

**Power and toughness are computed on demand.** Printed values, then continuous effects, then
counters, in that order. A stored total drifts from the truth the moment an until-end-of-turn pump
wears off, because nothing is left that knows what to subtract.

**The client asks `legalActions` and renders it.** A UI that worked out for itself whether a card
was castable would be a second, worse copy of the engine, and the two would disagree the moment
either changed. Every move the table offers — every castable card, every legal target, every legal
block — comes from the engine.

**Affordability is judged against mana you *could* make, and the engine taps for it.** Nobody taps
five lands and then decides what to cast. This pairing is load-bearing in both directions: offering
a spell against potential mana without auto-tapping means offering plays the engine then refuses
(see below), and auto-tapping without the potential-mana basis means a castable spell looks
unaffordable.

**Hybrid and phyrexian costs are reported unpayable rather than read as generic.** Offering a spell
that cannot actually be cast is worse than refusing a card no current deck contains.

**A card that needs a decision during resolution is left unscripted, not approximated.** Searching a
library, "choose one", an opponent discarding — the engine has no way to interrupt a resolution and
ask. Such a card is resolved by hand, and the log says it was not automated. A tutor that silently
picks for you is worse than one you resolve yourself.

**Combat declarations are turn-based actions, not priority actions** (CR 508.1, 509.1). This is
the rule, and getting it wrong deadlocks the game — see below.

**Steps that exist only to hold a decision nobody can make are skipped.** No attackers declared goes
straight to end of combat (CR 508.1h); the first-strike damage step only exists if something has
first or double strike (CR 510.4). A turn with no creatures is otherwise four extra rounds of
passing.

---

## Bugs found, and how

Each of these would have reached a player. The method mattered more than the care: every one was
found by executing the code, not by reading it.

### Found by writing the engine's own tests

| Bug | Mechanism |
| --- | --- |
| The defender could not block | Declaring blockers required priority, but it is a turn-based action that happens *before* anybody gets priority. The defender held none, so the engine refused every declaration — and the attacker could pass the step away before the defender was ever asked. |
| "Attacked with nothing" was indistinguishable from "has not declared yet" | Both leave `combat.attacks` empty. The first must end the step and the second must block it, so each needs its own flag. |
| A player could block an attack aimed at somebody else | `legalBlockers` filtered on whether the creature *could* block the attacker, never on whether the attack was aimed at that seat. |
| A pod defender's blocks were thrown away | `declareBlockers` rewrote **every** attack's blockers, not only its own seat's. |
| `auto:start` gave the first turn to the wrong seat | Entering from the cleanup step is what runs the start-of-turn actions, and that roll advances the active seat — so starting *on* `firstSeat` skipped it. |
| A "target player" spell accepted a creature | None of the checks after the player branch look at the spec's kind, so a hand-built action went straight past them. The UI never offered it; an action sent directly would have been accepted. |
| An Aura outlived the creature it enchanted | `relocate` detaches an Aura when its host leaves the battlefield, so by the time state-based actions ran the Aura was attached to **nothing** rather than to something illegal — and only the second case was checked. CR 704.5m covers both; now so does the engine. |
| `game:reset` left an unplayable table | Reset kept `automated: true` but cleared the step and priority, and `auto:start` refuses to run twice. Nobody could do anything. Reset now hands the table back to manual. |

### Found by playing it in two real browsers

| Bug | Mechanism |
| --- | --- |
| **Nothing castable was ever cast** | `legalActions` offered spells against potential mana; `auto:cast` required mana already floating. Every cast was refused. With no creatures there was then no combat and no damage — a whole half of the game missing, from one absent function. Fixed by `solveTap`. |
| **A deadlock on blocking** | The table let a blocker be assigned to an attacker it could not legally block (a ground creature onto a flier). The engine refused the whole declaration, the step never ended, the player was asked again, made the same choice, and the game stopped. Assignment is now restricted to each creature's own `canBlock` list. |
| Every land drew as a 0/0 | The view sent the zeroes `characteristicsOf` computes for a non-creature. P/T now travels only for creatures. |
| Every tapped card overlapped its neighbour | A tapped card is rotated a quarter turn, and a CSS transform does not change the box the layout reserved. Cards now sit in a wrapper that is the right shape for the orientation. |
| The bottom of every card in hand was cut off | The hand row had a fixed minimum height ten pixels shorter than a card. |
| Life buttons could silently contradict the rules | With the engine running, a stray tap on a life button disagrees with what the engine just did. They are a tabletop affordance and now only exist on one. |

---

## How it is tested

**257 tests in the rules engine, 69 in the web app, 819 across the workspace.**

The ones that carry the most weight:

- **`playout.test.ts`** plays whole games from shuffled decks with bots that only ever send actions
  `legalActions` offered them. Twenty different shuffles, both seats going first, all reaching a
  winner — 12 to 27 turns and 267 to 600 actions each, every one decided on life totals. A game that
  finishes proves three things no single assertion covers: the engine never offers a play it then
  refuses, never reaches a state where nobody can act, and keeps every seat's view inside the 64KB
  socket budget for the whole game.
- **`scripts/e2e-arena.mjs`** does the same through two real browsers, taking whatever the UI offers
  rather than a fixed sequence, so it plays whatever the shuffle deals. Thirty checks, including
  that the opponent's hand is still unreadable with the engine running, that the engine never
  refused anything the table offered, that a mid-game refresh rejoins the same automated game, and
  that the whole thing fits a phone.
- **`combat.test.ts`** asserts each combat rule on a board built to need it, with the CR reference
  in the test name — so a failure says which rule broke rather than which line did.
- **`scripts.test.ts`** plays every scripted card the way a player would, and checks that no card in
  either starter deck is left unscripted unless it is a vanilla creature that needs no script.

Measured, not assumed: the raw `GameState` reaches 57.7KB in a long game against a 64KB cap, while a
redacted view peaks at 22.3KB — of which the whole automation block is 2.6KB. Redaction is still
what keeps the game on the wire.

---

## What is deliberately not done

- **A card needing a decision mid-resolution.** The engine cannot interrupt a resolution to ask.
  Those cards are resolved by hand and the log says so.
- **True layer interaction** (CR 613). What is here is a fixed order — printed, then effects, then
  counters — which is right for every effect the card pool produces. Characteristic-setting and copy
  effects need the real thing.
- **A stronger bot.** It attacks with everything, blocks when the trade is good, and casts the
  biggest thing it can afford. A better opponent needs a search, and a search needs a position
  evaluator, and neither was worth writing before the rules underneath them were trustworthy.
- **Multiplayer combat nuance.** Pods work — declarations are per defender and a seat can only block
  what attacks it — but there is no attacking a planeswalker and no "each opponent" combat maths
  beyond what the scripts do.
- **Anything touching production.** No VM, no DNS, no deploy. Everything here runs on localhost and
  on the branch.

## Next

1. A one-player table against `bot.ts`, which is the shortest path to the engine being useful alone.
2. More scripts. The vocabulary in `effects.ts` covers far more than the 22 cards currently using
   it; adding a card is a few declarative lines.
3. Loading a real Grimore deck into an automated table. `deck:load` already resolves any deck handed
   to it; the gap is that unscripted cards are common in a real list, which the "move by hand"
   escape hatch covers but has not been played against at volume.
