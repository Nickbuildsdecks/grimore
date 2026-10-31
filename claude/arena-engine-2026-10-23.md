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
- **Four seats, with commanders.** Pick Commander in the lobby and the table deals four 40-life
  seats, each with its commander in the command zone: cast it for its cost plus {2} a time, it goes
  back there when it dies, 21 damage from one commander kills, and a conceded seat is skipped by
  everything from turn order to who is asked to block.

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
| `scripts.ts` | All 225 scripted cards, the five basic lands among them |
| `targeting.ts` | Legal targets, the duplicate-target rule, the fizzle rule |
| `combat.ts` | Who can attack, who can block, damage assignment |
| `automation.ts` | Steps, priority, triggers, state-based actions, resolution |
| `autoActions.ts` | The reducer for `auto:*` — what a player may do and what happens |
| `legalActions.ts` | What a seat can legally do right now, for the client |
| `bot.ts` | A player that only ever does what the engine offers |
| `pacts.ts` | Deals between players: the words, the term, and who broke one — never a rule |
| `view.ts` | Per-seat redaction, the automation block, and the wire form |

In the web app: `lib/arena.ts` (the interaction reducer), `lib/sound.ts` (which cue a view change
is worth, and the oscillators that play it) and `lib/feed.ts` (which of the engine's log lines is
worth saying out loud), each with a hook beside it holding the timers,
`components/table/{PhaseBar, StackPanel, ArenaBar, PlaySheet, CombatArrows, TableFeed}.tsx`, and
`pages/PlayTable.tsx` branching on `view.automation`.

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

**A decision made during resolution is a different thing from a target, and is modelled as one.**
A target is chosen as the spell goes on the stack, by its controller, from a public zone, and an
opponent may respond to it. A decision is made as the spell resolves, possibly by somebody else,
possibly from a hidden zone, and nobody can respond — the spell is already resolving. Writing
"search your library for a creature card" as a target would get every one of those wrong, which is
why it took its own mechanism rather than a filter.

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
| **The engine could never cast a commander** | `legalActions` had one list of castable cards: the hand. The command zone is a zone a spell is cast *from* (CR 903.8), so in a Commander game the commander sat there uncastable for the whole game — the headline format of the product, missing from the function that decides what a seat may do. Never hard; never reached, because every automated game before this was 1v1 with no command zone. |
| **Commander damage was never recorded by combat** | `dealDamage` knew nothing about where the damage came from, so the 21-damage rule (CR 903.10) could only ever fire from the tabletop's **cmd** button. The automated game had the rule and no way to feed it. |
| **An eliminated seat could hold priority** (CR 800.4) | Impossible to see in a two-player game — when one player loses the game ends in the same breath. With four seats the state outlives the elimination, and a conceded player's table was offered a Pass the engine refused. |
| `game:reset` left an unplayable table | Reset kept `automated: true` but cleared the step and priority, and `auto:start` refuses to run twice. Nobody could do anything. Reset now hands the table back to manual. |

### Found by playing it in two real browsers

| Bug | Mechanism |
| --- | --- |
| **A reanimated creature and a token entered the battlefield silently** | `etb` was raised at exactly one call site — a permanent *spell* finishing its resolution. So Zombify put a Gravedigger onto the battlefield and its trigger never fired, and a **token triggered nothing at all**: Krenko's Goblins, Izoni's Insects and Talrand's Drakes were all mute, as was anything watching for them. Entering means arriving from anywhere (CR 603.6a). The same fix as `dies` — recorded where the card moves, announced in one place — which is itself the evidence the architecture wanted it that way. |
| **"When this dies" never fired for a creature killed by a spell** | `dies` meant "noticed by state-based actions", which only sees *lethal damage* and a toughness at zero. A creature **destroyed** by Doom Blade is already in the graveyard by the time those run, so nothing announced it — and the two call sites that did care had each been patched to announce their own deaths by hand, which is the shape of a rule nobody owns. "Dies" means put into a graveyard from the battlefield (CR 700.4), so `relocate` — the one place a card changes zone — records the fact and `settle` raises it. Found by writing the first card with a death trigger: the engine had gone its whole life without one. |
| **The other player's table offered Pass forever** | A suspended resolution left `state.priority` naming whoever last passed. That seat's table offered Pass, the engine refused it because a question was outstanding, and the two disagreed for as long as the question stood — on turn ten of a real game, with a red banner and no way forward. Nobody holds priority in the middle of a resolution, and the state now says so; `legalActions` also refuses to report `hasPriority` while anything is blocking, because one of the two has to be hard to get wrong and that is the field the table keys its one button on. |
| **Nothing castable was ever cast** | `legalActions` offered spells against potential mana; `auto:cast` required mana already floating. Every cast was refused. With no creatures there was then no combat and no damage — a whole half of the game missing, from one absent function. Fixed by `solveTap`. |
| **A deadlock on blocking** | The table let a blocker be assigned to an attacker it could not legally block (a ground creature onto a flier). The engine refused the whole declaration, the step never ended, the player was asked again, made the same choice, and the game stopped. Assignment is now restricted to each creature's own `canBlock` list. |
| Every land drew as a 0/0 | The view sent the zeroes `characteristicsOf` computes for a non-creature. P/T now travels only for creatures. |
| Every tapped card overlapped its neighbour | A tapped card is rotated a quarter turn, and a CSS transform does not change the box the layout reserved. Cards now sit in a wrapper that is the right shape for the orientation. |
| The bottom of every card in hand was cut off | The hand row had a fixed minimum height ten pixels shorter than a card. |
| Life buttons could silently contradict the rules | With the engine running, a stray tap on a life button disagrees with what the engine just did. They are a tabletop affordance and now only exist on one. |

---

## How it is tested

**478 tests in the rules engine, 119 in the web app, 1,100 across the workspace.**

The ones that carry the most weight:

- **`playout.test.ts`** plays whole games from shuffled decks with bots that only ever send actions
  `legalActions` offered them. Twenty different shuffles, both seats going first, all reaching a
  winner — 12 to 27 turns and 267 to 600 actions each, every one decided on life totals. A game that
  finishes proves three things no single assertion covers: the engine never offers a play it then
  refuses, never reaches a state where nobody can act, and keeps every seat's view inside the
  socket budget for the whole game. Four-seat pods play out the same way, which is where turn order
  has to skip eliminated seats and several defenders can owe a block at once.
- **`scripts/e2e-arena.mjs`** does the same through two real browsers, taking whatever the UI offers
  rather than a fixed sequence, so it plays whatever the shuffle deals. Thirty-two checks, including
  that the opponent's hand is still unreadable with the engine running, that the engine never
  refused anything the table offered, that a mid-game refresh rejoins the same automated game, and
  that the whole thing fits a phone. `DECK_B=tidal-mind` brings counterspells into it and
  `FORCE_MULLIGAN=1` makes both players mulligan, because at one hand in nine the flow after a
  mulligan would otherwise almost never run.
- **`scripts/e2e-pod.mjs`** plays a four-player Commander pod through four browser contexts —
  four seats on one code, four opening hands at once, a commander cast *from the command zone* and
  back in it after it died, attacks sent at more than one opponent, a seat conceding while the
  other three play on, and one survivor. Thirty-three checks. It is also the suite that proves the
  things only a four-player table can get wrong: that one player's screen hides all **three**
  opponents' hands, and that four seats fit a phone.
- **`scripts/e2e-solo.mjs`** plays a whole game in one browser against the server — fifteen checks,
  and a game takes thirty-three moves. `OPPONENT_DECK` picks which deck the server plays, so the
  solo game is run against each of the four. `SOLO_POD=1` turns it into a one-person Commander pod
  against three bots — sixteen checks, with two a duel cannot make: that the lobby really seated
  four, and that *all three* bots played, since a pod where two of them sat still would pass every
  other check and be no kind of game.
- **`combat.test.ts`** asserts each combat rule on a board built to need it, with the CR reference
  in the test name — so a failure says which rule broke rather than which line did.
- **`scripts.test.ts`** plays every scripted card the way a player would, and checks that no card in
  either starter deck is left unscripted unless it is a vanilla creature that needs no script.

Measured, not assumed: the raw `GameState` reaches 57.7KB in a long two-player game while a redacted
view peaks at 22.3KB — of which the whole automation block is 2.6KB. Redaction is still what keeps
the game on the wire, and a four-player pod is where that stops being a nicety: 98KB of state
against a 36KB view.

**The number that had no headroom was a library search, and it has headroom now.** Ordinary play
peaks at 18.5KB; a view with a library open reached **45.8KB** inlined, because a zone that normally
travels as a count suddenly travels as fifty cards. Inside the 64KB cap for a 60-card deck and
*outside* it for a 100-card Commander one — which is this project's stated centre. The view now
travels in a wire form (`packView`/`unpackView`) that says each card definition once instead of once
per copy and leaves out the fields that are false on almost every card: **25.3KB at worst, 23.3KB
during a search**, so the search is no longer even the peak. Packing is a transport concern and
nothing else — `viewFor` is unchanged, the client unpacks once in `lib/table.ts`, and
`unpackView(packView(v))` is asserted equal to `v` for every state of a whole game.

**And the cap it is measured against is now derived rather than observed.** A four-player pod with
259 permanents packed to 68.5KB — an ordinary long game of Commander — against a 64KB cap set when
the Play Realm was two players. Two avoidable wastes came out first (the card id travelled as a
field *and* as its map key; `keywords: []` travelled on every card without any), taking it to
60.8KB. Then the cap itself: `MAX_INSTANCES` is 600 and a packed card costs about a hundred bytes,
so a table at the engine's own hard limit is roughly 100KB and **128KB is a limit a legal game
cannot reach** — which is the property a safety cap should have, because then what trips it is a
bug rather than a board.

---

## What is deliberately not done

- **Most replacement effects.** Three are in now — regeneration (CR 701.15), "enters with counters"
  (CR 614.1c) and, from the increment below, **"if it would die, exile it instead" (CR 614)**, which
  is the first one that belongs to a permanent and changes what happens to a *different* one. The
  shape it needed — a pass that asks every permanent whether it wants to replace what is about to
  happen — now exists and is what the next one should use. **Protection from a colour (CR 702.16) is
  in as well**, all four of its rules, and so is **damage prevention with a quantity (CR 615)** —
  the shield that is spent a point at a time, survives partial use, covers every source of damage
  and can sit on a player. **And redirection is in now too** (#239, D255) — "the next 2 damage that
  would be dealt to you and/or permanents you control is dealt to target creature or player
  instead", which is that shield plus a destination, dealt by `dealDamage` calling itself so the
  moved damage is a real damage event. That was the last named gap in this family, and the paragraph
  here used to say it was neither needed nor approximated.
- ~~**Copy effects** and **characteristic-setting effects**~~: both in, as a token copy of a printed
  card, as "becomes 1/1 and loses all abilities", and — since `DecisionZone` grew
  `any-battlefield` — as a Clone that chooses what to enter as. What is left of the family is a copy
  effect that keeps copying something as it *changes*, which needs layer 1 recomputed rather than
  applied once; nothing in the pool asks for it.
- ~~**Three of the layers**~~ — **none** (CR 613). All seven the cards use are in: copy (1),
  type-changing (4), colour-changing (5), abilities (6), a defined size (7a), setting power and
  toughness (7b) and modifying it (7c, with counters in 7d). Type-changing is the one that changed
  the shape of `characteristicsOf`, which makes two passes now rather than one, because what a
  permanent *is* decides which other effects apply to it; a defined size is the one that is a
  *count of the board* rather than a number, read fresh on every ask. What is left of CR 613 is
  dependency ordering between effects in the same layer (613.8), which no two cards in this pool
  argue about — and layers 2 and 3 (control and text changes), which exist in the engine as moves
  rather than as layers: control is a change of battlefield, and nothing rewrites a card's text.
- **A stronger bot.** It attacks with everything, blocks when the trade is good, and casts the
  biggest thing it can afford. A better opponent needs a search, and a search needs a position
  evaluator, and neither was worth writing before the rules underneath them were trustworthy.
- **Multiplayer combat nuance.** Pods work — declarations are per defender, a seat can only block
  what attacks it, and an attack can be aimed at a planeswalker — but there is no "each opponent"
  combat maths beyond what the scripts do. Forced attacks and goad are both in now — "attacks each
  combat if able" and "attacks a player other than you if able", enforced, pre-selected at the
  table, and kept out of the bot's hands in a duel where goad does the opposite of what it is for.
- **Anything touching production.** No VM, no DNS, no deploy. Everything here runs on localhost and
  on the branch.

---

## Added after the first checkpoint

Twenty-four things, in the order they mattered.

**A control deck, which makes the stack a place you can fight.** Tidal Mind (blue-black) brings
counterspells, and with them the first spells that target something on the stack — so the stack
panel had to become targetable, since in Arena mode it is drawn as a list and had no card face to
tap. Twelve more scripted cards: countering, destroy, mill, card draw, random discard, and the
flying / deathtouch / lifelink keywords. "Discards a card at random" is scripted and "discards a
card" of the player's choosing is not, for the reason in the table above.

**Passing for a player who has nothing to do.** The measurement that justifies it: 21.6 actions per
turn before, 3.2 after — a whole game from 359 decisions to 56. It only ever acts when passing is
the *only* legal move, a mana ability does not count as something to do, and four things always
stop it: a combat declaration, a discard, any play including a land, and the start of somebody's
turn. It is a table setting (`auto:stops`) with a toggle in the control bar, because a player who
is bluffing or learning the turn structure wants every priority.

**Opening hands.** Roughly one hand in nine opens with nought or one land, and until this the game
was over before it started. Mulligans sit between the engine taking over and the first turn
(CR 103.4): nobody holds priority, no step has begun, both players decide at once. The London
mulligan is a redraw plus a debt — a fresh seven, one card owed to the bottom per mulligan — and
`auto:keep` collects it. Which cards go back is the player's call, always.

**Playing on your own.** A pod can seat the server. It readies itself, loads its own deck, settles
its own opening hand and plays its turns, and it does all of that *inside the same pod write as the
action that provoked it* — a reply in a separate write would show the player their own move, then a
gap, then the answer, and would race another node against a state the opponent had not finished
moving in.

Two more bugs, both of which had been waiting for a second player who was never going to arrive:
"which seat is the engine waiting on" returned one seat, which is wrong during opening hands (every
seat decides at once) and wrong in a pod (every defender declares); and leaving a table left the
server playing alone until the pod expired.

**A triggered ability that asks who it is pointed at.** "When this enters the battlefield, destroy
target creature" is one of the most common things a creature does, and until this it could not be
scripted at all: a trigger went on the stack with no targets and no way to get any. Targets for a
trigger are chosen as it is put on the stack (CR 603.3d), and only one of the three cases is a
question — no legal target means the trigger never goes on the stack (CR 603.3c), exactly one legal
target is taken, and anything else stops the game and asks its controller. Flametongue Kavu's famous
drawback falls straight out of those rules rather than being written anywhere: played with nothing
else on the board, the only thing it can point at is itself, so it kills itself and the engine does
not even ask.

**A fourth deck, and the graveyard as somewhere to point at.** Rot Harvest (green-black) is built on
getting creatures back, which needed a target that is a *card in a graveyard* — a different object in
a different zone from a creature on the battlefield, so it is its own target kind rather than a
filter. A card in a graveyard has no continuous effects on it and its printed type is what it is.
One real UI bug came out of playing it: targets were only lit on the battlefield, so "return target
creature card from your graveyard" was a prompt with no visible answer and the game stopped dead.
Every zone a spell can point at now lights its legal targets.

**A cost paid by sacrificing a creature.** "Sacrifice another creature:" is a **cost**, not a target,
and the difference is the whole reason to implement it properly: a cost is paid as the ability is
activated, so the creature is in the graveyard before the ability is on the stack, it cannot be
answered by killing the creature in response, and anything watching for a death sees it then rather
than on resolution. Modelled as a target it would have looked right and been wrong exactly where it
mattered — which is why these two cards were cut from the deck a commit earlier rather than
approximated. The choice travels with the activation, so no new engine phase was needed: an outlet
with nothing to feed it is not offered at all, and the table asks for the sacrifice first and the
targets second, in the order the rules pay them. The bot got judgement rather than just capability —
it feeds the outlet only when what goes in is worth less than what is being fed, because one that
ate its best creature every turn would play itself out of the game while passing every other test in
the file.

**A card that stops and asks while it is resolving.** The capability behind every tutor, every
own-choice discard and every "each player sacrifices", and the one the first checkpoint named as
missing. A spell declares `decisions`; the engine stops, asks, and hands the answers to the effect.
The spell stays **on the stack** while the question is outstanding, so both tables still show what
is resolving, and nothing else happens at all until it is answered — no priority, not even for the
player who cast it. Three questions are answered by the engine rather than asked, and each is a
stopped game avoided: one with nothing to choose from is never asked (an opponent with no creature
is not asked to sacrifice one), one that must take exactly what is available is taken, and a player
who has left the game between one question and the next is not asked. `each-player` and
`each-opponent` expand into one question each in turn order from the active player (CR 101.4),
because who answers first is sometimes the whole card.

Two things in it are worth naming separately. **A library search opens that seat's own library to
it, and only to it** — which needed no new mechanism, because the tabletop's **Search deck** already
did exactly that, and the view is keyed on the same `searching` flag. Answering shuffles (CR
701.19e), which is both what the cards say and what stops the searcher keeping the order they were
just shown. And **the candidate list is the whole authorisation**: it travels only inside the
answering seat's own `you` block, and `auto:decide` refuses any id that is not on it — without that
check a crafted action could fetch any card out of any library.

Five cards, each exercising a different facet, taking the engine to 50. Rampant Growth searches for
a basic land and may fail to find, because failing to find is legal (CR 701.19c) and occasionally
right. Diabolic Tutor takes anything. Mind Rot is answered by the player *discarding*, not by the
caster — the thing that makes it a different card from Ravenous Rats. Fleshbag Marauder makes every
player sacrifice, including its controller, including itself when it is the only creature they have.
And Faithless Looting is the one that needed `beforeDecisions`: the cards it offers to discard are
the ones it has not drawn yet, so the draw has to happen before the question can be asked.

Izoni's second ability is scripted now too — it was printed in prose with "Move by hand" underneath
it two commits ago, for want of a sacrifice cost.

**Modal spells, which turned out not to need a new phase at all.** "Choose one —" looked like the
hardest thing left, and the reason it was not is a rules detail: modes are announced **as the spell
is cast** (CR 601.2b), *before* its targets (CR 601.2c) — not while it resolves. So it is not a
mid-resolution decision, and scripting it as one would have been actively wrong: a player could
counter a Charm without knowing which half of it was coming.

Because the choice travels with the cast, `legalActions` just offers **one play per legal
combination of modes** — a shape it already had for a permanent with several abilities — and the
table needed no new interface whatsoever. A combination whose targets cannot be filled is not
offered, so "destroy target creature; or draw two cards" offers only the draw against an empty
board, and a Charm's exile-power-5 mode appears the moment a creature grows into it and disappears
when it shrinks. `min`/`max` on the modal block covers "choose one", "choose one or both" and
"choose two" with the same subset enumeration.

Three cards, each exercising a different part. Selesnya Charm is a plain choose-one with all three
modes supported. Soul Manipulation and Grim Discovery are "choose one or both", which offers three
plays: each half, and the pair. The one thing that could have been silently wrong is which target
belongs to which mode — they arrive as one flat list — so a mode taking the wrong slice would
return the right *kind* of card and the wrong card, and that is asserted directly on a graveyard
holding two creatures and two lands.

Two smaller things fell out. `graveyard-land` and `graveyard-card` joined `graveyard-creature` as
target kinds, from one table keyed on the printed type, because a card in a graveyard is read from
its type line in every case. And the play sheet now wraps instead of truncating: three Charm modes
are three plays on the same card that differ only at the end of the sentence, and they had been
sharing one `data-testid` as well, which breaks React and every selector that reads it.

**Six cards for the parts of the engine no card reached.** Written by reading the engine rather than
the card pool: `statics` had never been used by anything, nor had a `dies` trigger, a `step`
trigger, or untapping. Untested code in a rules engine is where the bugs are, and this found one
immediately — a creature killed by a *spell* never fired its death trigger, because "dies" had been
implemented as "noticed by state-based actions" rather than as what the rules say it is.

Glorious Anthem is the first static effect, and it is the clearest demonstration of why
characteristics are computed instead of stored: it lifts a creature that arrives later, stops when
the enchantment is destroyed, and saves a 2/2 with two damage already marked on it. Phyrexian Arena
is the first "at the beginning of your upkeep". Thermo-Alchemist taps for damage and is untapped by
casting an instant, which is the only card that untaps anything. Doomed Traveler and Doomed
Dissenter leave something behind. And Goblin Arsonist is a death trigger that has to be *aimed* —
the creature is already in the graveyard, and the trigger still asks.

Two engine limits came out of writing them, both worth stating because they rule out whole families
of cards. A `dies` trigger fires for the creature that died and **no other**, so "whenever another
creature dies" (Blood Artist, Zulaport Cutthroat) is not scriptable; the same is true of `etb`, so
"whenever another creature enters" is out too. And exiling is not dying (CR 700.4) — Swords to
Plowshares fires nothing, which is the whole point of the card and is now asserted in both
directions, because getting the second half wrong is how the first half comes back.

**Triggers that watch the board rather than themselves.** `dies` and `etb` only ever reached the
permanent the event happened to, which ruled out a whole family: "whenever ~ **or another** creature
dies" is one of the commonest black cards there is. The events now carry `who` (self, another, any),
`of` (you, opponent, any) and `what` (creature, permanent), all defaulting to what every existing
script already meant, so nothing written before this changed behaviour.

Blood Artist, Zulaport Cutthroat, Soul Warden and Impact Tremors, to 63. They are also the cards
that make a sacrifice deck a deck rather than a pile: a Fleshbag Marauder with a Blood Artist out
is a drain, and a Doomed Dissenter dying is two triggers rather than one.

`what` was not in the first draft and the test caught why: an Impact Tremors fired for *its own
arrival*, because `who`/`of` say whose and not what, and an enchantment entering is not "a creature
you control enters". The default is `permanent`, since a `who: 'self'` trigger already knows what
its own card is.

Writing them also found the **second** bug of the same shape as the `dies` one, which is the part
worth remembering: `etb` was announced at a single call site too, so a creature put onto the
battlefield by Zombify arrived silently and a token triggered nothing at all. Both are now recorded
where the card actually moves and announced in one place — `settle` drains a list of deaths and a
list of arrivals, in a loop, because a creature dying can leave a token behind.

**A four-player Commander pod, played rather than asserted.** Four seats have been supported since
the first checkpoint and nobody had sat at one, which is how the product's headline format turned
out to be the one thing the engine could not do: `legalActions` scanned the hand and nothing else,
so the commander sat in the command zone, uncastable, for the whole game.

What a pod needed was four rules, each small and each in exactly one place. The commander is cast
from the command zone, for its cost plus {2} for every previous cast — carried as extra generic
rather than a rewritten cost string, because a rewritten string has to be re-parsed and a hybrid
pip would not survive the trip. It returns to the command zone instead of dying (CR 903.9), in
`relocate`, which is the one choke point every zone change goes through. Combat damage records who
dealt it so 21 from one commander ends a game (CR 903.10) — keyed by the commander's *owner seat*,
not its instance, because the tabletop's **cmd** button has keyed by seat since the manual table
shipped and two key spaces in one record never add up to 21. And an eliminated seat is skipped by
everything, including the thing nothing had ever checked: holding priority.

The bot learned to spread its attacks across the table rather than hammering one seat, because a
pod where everybody attacks the same player is not a pod. Measured over ten games: all ten finish,
46–50 commander casts, tax reaching {6}–{8}, 19–26 returns to the command zone, commander damage
to 22 — and attacks in all twelve directions, which is the assertion that says a four-seat game is
being played rather than three sequential duels.

**The same pod through four real browsers, which is where the interface was wrong.** The engine
playing a pod says nothing about whether four people can play one, and three things were missing
from the *table* — each invisible from the engine's side, because the engine had always been right.

Attacking could only ever be aimed at one player: the reducer sent every attacker at
`firstOpponent(view)`, the lowest-numbered living opponent, while the engine has accepted a
defender per attack since combat was written. In a duel that is the only answer and the code reads
as though it meant it. The prompt now offers the players who can be attacked and each creature
keeps the one it was tapped for, so one attack goes left and the next right. Nothing on the board
named a defender either — `attackSummary` existed and no component called it — so an attacking
creature now says who it is attacking and how many creatures are in its way. And the engine's
control bar had no **Concede**, which the manual bar has always had: a player in an automated game
had no way out of one, which is a stuck table in a duel and three people waiting on a fourth in a
pod. It arms on the first tap and acts on the second.

Two smaller ones, both Commander-specific. The command zone carried no badges, so the one card a
Commander player always wants to cast was the only card on the table that never said it was
playable. And the `cmd` button was a tabletop affordance rendered in both modes, so a tap on it
with the engine running added a second count on top of the damage combat had already recorded —
the same trap the life buttons were, one rule along.

`scripts/e2e-pod.mjs` is the suite: four browser contexts, one Commander table, 33 checks, played
to one survivor over 80-odd turn changes. The driver the arena suite had grown is now shared
(`scripts/lib/table-driver.mjs`), because four browsers playing Commander ask for exactly the same
moves as two playing a duel.

**Spells with {X} in the cost, which were half-built — the worse half of missing.** The mana layer
had parsed `{X}` since it was written, `payCost` took an amount for it, the stack object had a
field for it, and `EffectContext.x` was documented as "the chosen value of X". Nothing ever set
it: no card had an X, `legalActions` never reported one, and the table had no way to choose one.
A missing feature is a gap you can see; one wired at both ends and never connected in the middle
looks finished in every file you open.

X is chosen as the spell is cast and before its targets (CR 601.2b, 601.2c), which is the same
shape modal spells turned out to have — so again no new engine phase, only a step in front of
targeting. `legalActions` reports `xMax`, because what X can be is a mana question and a client
working it out would be a second mana engine disagreeing with the first. An X of zero is a legal
cast and travels as a number rather than as a missing field, and an `x` on a card without one is
refused rather than ignored. The stack says `Fireball (X=3)`, for the same reason it names a
Charm's mode: the player holding a counterspell needs to know whether their 2/2 lives.

Five cards, one per colour and each a different shape: Fireball, Mind Spring, Exsanguinate (X from
*each opponent*, which is a different card at a pod than at a duel), Secure the Wastes (X tokens at
instant speed) and Hurricane (X to every flier and every player, its controller included).

It also caught a test method that had been quietly lucky. The modal test read `stackObjects` after
each action to see what the bot had cast — but with auto-pass on, a spell nobody can respond to is
cast *and resolved* inside one action, and of fifteen X spells cast across ten games exactly one
was still on the stack to be seen. Both tests now watch the bot's own action.

**And the number that decides a Commander game is on screen.** Each opponent's row showed the
commander damage *you* had dealt them; your own row showed nothing, so a player could not see how
close they were to losing to the 21-damage rule. Your row now carries the worst incoming total and
whose it is — one number, because "cmd 7/0/14" is three numbers and no decision.

**Scry, which needed a second hole in the one zone hidden from its own owner.** A library is
secret from everybody including the player who owns it, with exactly one exception —
`searching`, which opens the whole thing. Scry is the other exception and a much smaller one: the
top two cards, face up to you and to nobody else.

The reveal is authorised by the question itself. `canIdentify` lets a seat read a library card
when there is a decision from `library-top`, it is that seat's, and the card is on *that
question's own candidate list* — the same list `auto:decide` checks an answer against. One list,
two uses, so an unauthorised read and a crafted answer fail for the same reason and cannot drift
apart. The cards travel as cards with no zone attached, so the table learns "these two cards" and
not "here is the order of your deck", and the row is drawn from the candidate list rather than
from a zone.

Putting them back is the engine's job rather than the card's: scry is a keyword action with fixed
semantics, so `answerDecision` bottoms what was chosen and leaves the rest on top, in the same
place a search's shuffle already lived. Preordain's own effect is the draw and nothing else, which
is exactly what the card says. Where the engine stops is written next to the type: the cards kept
stay in the order they were in, because reordering needs a question whose answer is a sequence
rather than a set and no card in the pool turns on it.

Preordain, Magma Jet (which damages *before* it asks, through the same `beforeDecisions` hook
Faithless Looting needed) and Omenspeaker, for the trigger path. The bot bottoms a land once it
has five and otherwise keeps what it is shown — the one scry decision that is obviously right
without knowing anything else about the game.

**Equipment, which is an Aura that outlives its creature.** Saying it that way is most of the
design: everything the engine had for Auras applies, and the two differences are where the work
is. Equip is an ordinary sorcery-speed activated ability — no new card-type machinery, no new
resolution path, nothing in `legalActions` that knows what an Equipment is, because a card type
that needs an engine change is a card type the engine does not really support. And the attachment
ends while the Equipment stays (CR 301.5c), which is why a board wipe leaves the gear behind.

The bug in it was the Aura bug wearing a different hat. The first version looked at `attachedTo`
and found nothing wrong, because `relocate` detaches everything pointing at a card *as that card
leaves* — so the state-based action has to check for an Equipment with no host **and a bonus still
in `state.effects`**, or a dead creature's +2/+0 sits there for the rest of the game waiting to be
applied to whatever next holds that instance id.

A target filter can now see the card it belongs to, which is what stopped equip offering the
creature it is already on: legal by the rules, useless in practice, a trap for a player and a
waste of mana for a bot. Measured over ten games — 51 equips of which 35 were re-equipping the
same creature, down to 26 of which none were. "Another target creature" is printed on hundreds of
cards and now has somewhere to live.

Bonesplitter, Loxodon Warhammer and Basilisk Collar, which turns a Llanowar Elves into a creature
nobody wants to block. And one more bug the new cards exposed: **a game could end with a question
still on the table** — Magma Jet's damage ends the game in the same action the scry is asked in,
and the prompt stayed on a finished board with the control bar refusing everything else. The game
ending now clears priority and every pending question, which is what CR 104.1 means by it ending
immediately.

**A land that makes one of two colours, which the mana layer could not express.** A source's
`produces` was a multiset — `['U','B']` meant one of each — so a Guildgate would have been two
mana off one land. `solveTap` now returns *picks* rather than keys, because a choice source does
not settle which colour it made until it is tapped, and the greedy rule already there turns out to
be exactly right for duals: the least flexible source that makes a short colour goes first, so a
Guildgate is saved for the colour only it can provide.

The bigger change is behind it. Affordability was **two** answers to one question: `legalActions`
counted an optimistic pool of every untapped source's colours, while the payment used `solveTap`.
A dual land is exactly where those part company — counted as both its colours it looks like two
mana and it is one — so the table would have offered a two-drop off one Guildgate and the engine
would have refused to pay for it, which is the one failure this whole design is organised against.
`canAfford` is now the only answer, and `potentialMana` survives as what it always really was: the
dimmed pips on the control bar, optimistic on purpose, deciding nothing.

"Enters the battlefield tapped" came with it — a replacement effect (CR 614.1c) applied in
`settle`'s arrival drain, before the entry trigger, so the land is never observably untapped.
Measured over twelve bot games: 19 gates played, **71 gate taps paying for spells**, no refusals,
every game finished.

**Regeneration, and the card both checkpoints called unscriptable.** Golgari Charm was the stated
limit — "a modal card with one unscriptable mode is an unscriptable card" — and the mode was
*regenerate each creature you control*. A shield is a counter, because that is already a
per-permanent, serialised, visible number, and the destruction is replaced in **both** places it
can happen: in `destroy`, where a spell says so, and in the lethal-damage state-based action,
which is the half players actually use. A shield that saved a creature from Doom Blade but not
from the 3/3 it just blocked would be the wrong half of the card.

All three parts of the replacement are real (CR 701.15a) — tapped, damage removed, **out of
combat** — and the damage matters mechanically, because without clearing it the next pass of
state-based actions kills the creature again and the shield buys nothing. A toughness of zero or
less still cannot be regenerated away (CR 704.5a), which is the difference between regeneration
and indestructible. An unspent shield expires with the turn, which the first version of the test
got wrong in the player's favour.

"Enters with N +1/+1 counters" came with it, applied where the X is known — so Endless One is as
big as the mana poured into it, and a *reanimated* one comes back a 0/0 and dies, which is the
rule rather than a shortcut. Drudge Skeletons, Golgari Charm and Endless One, to 82 cards. The bot
puts shields up and never spends one: it activates on its own main phase rather than when
something is about to die, the same shallowness as aiming a pump spell at an enemy creature.

**The combat is drawn on the board now, not described beside it.** An attacking creature carried a
badge reading "attacking Ana", which is the right first answer and not enough: with three
opponents that is a sentence you read four times to work out what is happening to *you*, and the
only question a defender has is whether the attack is theirs to block. `CombatArrows` draws a line
from each attacker to the seat row it is aimed at, and a dashed one from each blocker to what it
blocked — a block is an answer, not a threat, and the two should not look the same at a glance.

Every position is measured from the DOM rather than computed, because the board is flex rows that
wrap inside containers that scroll on a page that rotates: an overlay that knew where the cards
were would be a second layout engine disagreeing with the first. It re-measures on resize, on
captured scroll, and on any body resize, lands on the edge of the row facing the attacker, and
passes pointer events straight through — without that, every card under it would stop being
tappable at the exact moment the defender needs to tap their creatures.

**The bot stopped throwing creatures away.** "Attacks with everything" has been the honest
description since the first checkpoint, and it is the worst thing a bot can do: it ran a 1/1 into
an untapped 3/3 every turn because the engine said it was allowed to. Each attack is now weighed
against the blocks it could actually face — free damage, survives it, trades up, or stays home —
with one exception that overrules all of it, which is lethal: a creature saved on the turn you
could have won is a creature saved for nothing. Blocking picks the biggest attacker a creature can
actually handle instead of the first legal pairing, which is what let a 4/4 eat a 1/1 while a 5/5
walked past.

All of it is read off the board. No card knowledge, no search, nothing the bot could not work out
by looking — and the measurement is the point: **292 attackers declared and 40 dead, down to 240
declared and 16 dead**, with the average game getting *shorter* (19.4 turns to 18.6). That last
number is the one that says it did not solve the problem by refusing to fight, and all three are
asserted in `playout.test.ts`.

**A fifth deck, and the first built out of what the engine learned.** The four starter decks were
written against the engine as it was: creatures, burn, counterspells, a graveyard. **Forge
Alliance** is red-white Equipment and tokens, and nothing in it would have worked ten commits ago
— which is the point of building it, because a deck is the honest test of whether a feature is
usable rather than merely present.

Balan, Wandering Knight is the commander and the reason for the one engine change: "attach all
Equipment you control to Balan" is the first card that has to read *another card's script*, and a
`+2/+0` closed over inside the Bonesplitter's own effect cannot be asked what it is. An
Equipment's bonus is declared on its script now, which costs the helper one line.

Most of the deck is cards the other decks already define — a `CardDef` is data and a script is
keyed by name, so a deck list is genuinely just a list, and the next deck costs almost nothing.
Five new cards for what it needed, including a vanilla 2/1 with no script at all and an Aura with
a trigger on it. Five decks mean fifteen pairings, and `playout.test.ts` plays all of them to a
finish: when a new deck arrives the question is not whether its cards work, it is whether a game
between it and every other deck ends.

**The log says what happened, not only what was played.** It read `Friend attacks with 2
creature(s)`, `Nick blocks with 2 creature(s)`, `Friend passes`, `Friend passes` — a record of
actions sent, with nothing about who was attacked, what blocked what, who took damage or what
died. A board wipe read "Nick casts Golgari Charm" and four creatures died in silence.

Consequences are **detected by comparing the table before and after**, which is the same rule as
triggers one layer up: a consequence each caller has to remember to mention is one some caller
will forget. `applyAction` diffs life totals and permanents that left the battlefield, and
appends them — capped at six with the overflow counted, so a sweep is a line rather than a
paragraph. Every card written from here on gets it for nothing. Combat names names, because
"attacks with 2 creature(s)" is true and useless. And the client drops a pass that did nothing,
because a hundred lines of "Friend passes" is how a player loses the four that mattered.

**Planeswalkers, which needed rules rather than vocabulary.** Every other addition this session
was a verb — scry, equip, regenerate. A planeswalker is a set of rules: it enters with loyalty,
its abilities are paid for in counters, one per turn, it dies at zero, damage removes loyalty
instead of being marked, and it can be attacked instead of its controller. All of it in one go,
because abilities without attacking would have been exactly the state `{X}` was in — present and
not connected — and worse, since a planeswalker nobody can attack is not an approximation but a
different card.

A script writes `{ loyalty: -1 }` and gets sorcery speed, once per turn and "not without the
loyalty to pay for it", because every loyalty ability in the game has all three. The cost is paid
as the ability is activated (CR 606.2), so a planeswalker that goes to zero on its own minus is
already dying while the ability it paid for waits on the stack — and the ability still resolves.

Two bugs of the same shape came out of it, both about a new field having to be carried by
everything that copies a card: the printed loyalty was applied in `settle`'s arrival drain, so a
planeswalker put onto a *manual* table had none and was swept away the moment the engine took over
(it belongs in `relocate`, the third rule this session to end up there after `dies` and `etb`);
and `normaliseDef` was dropping `loyalty` entirely, because it lists the fields it keeps.

Jace Beleren and Garruk Wildspeaker, with all three printed abilities each and nothing simplified
to make it fit. Garruk's "+1: untap two target lands" found the last one: the bot sent a single
target for a spec that wanted two, because no card before it had `count: 2`.

**And the in-game help was for the other table.** The panel behind the **?** had one list, all of
it about the manual tabletop: tap your own lands, say who you are attacking in chat, settle combat
with the life buttons. With the engine running two of those are impossible and the rest are things
it does for you, so a new player reading it goes looking for buttons that are not there. There are
two lists now, chosen by which table you are at — and the arena suite reads the panel and fails if
it is showing the wrong one, because every feature in this document is invisible until something
in the app says it exists.

**A pod of one, and the two bugs that were hiding behind it.** The server could always seat three
bots; the lobby only ever offered one, and the server gave every bot the same deck — so the format
this product is named after was the one game a solo player could not set up, and three opponents
would have been one opponent three times. `botDecks` gives each seat its own deck in seat order,
the lobby's **Solo pod** button sends the first three starter decks, and `SOLO_POD=1` on the solo
browser suite plays one to a survivor.

Which is how the real find turned up. The suite failed every run on the check that matters most —
"the engine never refused anything the table offered" — with `GAME_FINISHED: the game is finished`,
displayed in red over "Nick wins". The pass that killed the last opponent and the pass queued
behind it both went out, and the engine refused the second, correctly. The existing guard could not
see it: it swallows a refusal when the table has moved on since the action was sent, and a queued
action re-composes against the version the previous ack just handed back, so by that test nothing
had moved. The engine's `GAME_FINISHED` now travels as its own `game_finished` code rather than
being flattened into `illegal_action` — the server stating the one thing it knows for certain,
instead of the client guessing from a view that can arrive *after* the refusal does. And the
`pod:error` listener was undoing the guard anyway: every handler answers the ack *and* emits the
error, and the listener had none of the context `send` uses to judge a refusal, so it put the
banner back up for everything `send` had deliberately swallowed. While a call is in flight, the ack
decides.

**And `scripts/play.mjs` builds the table server before it starts it.** Three debugging sessions
have now ended with "the code was right, the running server was old": Vite serves the web app from
source so the UI is never stale, while `apps/realtime` runs from `dist/` and the script only
checked that the file existed. The last instance cost an hour and three fixes that were all
correct and none of which was running. `tsc` on an unchanged tree is two seconds, and the question
cannot come up again. The browser driver's clicks are bounded for the same reason a different way:
a press used to wait Playwright's default thirty seconds for a button to hold still, so a control
bar re-rendering under the cursor — which is what four seats on one table do — ended a whole run
with a stack trace instead of a move.

**Costs that are choices.** Every deck before this one paid what was printed in the corner. Three
things it could not express, all of them a cost that is a decision:

- **Cycling**, which is the first ability in the pool used from the *hand*. The cost says so —
  `discardSelf` — and the zone follows from the cost rather than from a flag beside it that could
  disagree with it, exactly as a loyalty cost already implies sorcery speed. Five cycling lands, one
  per colour, and four of the six starter decks now run a pair: a land early, a card late.
- **Kicker**, the third member of the family that already holds X and modes, and chosen the same
  way — the engine offers the kicked spell as a *second play* beside the plain one, so paying it is
  one tap and the table needed no new interface. It is offered only when the whole cost can be paid,
  because the kicker's symbols are appended to the printed cost rather than paid separately: a
  player who can afford half of a coloured kicker is offered neither half.
- **An additional cost that is not optional**: "sacrifice a creature" on a *cast*. The sacrifice
  machinery has existed since activated abilities; a spell could not ask for one. A spell whose
  additional cost cannot be paid is not castable at all (CR 601.2h), so it is not offered — and the
  creature is in the graveyard before anybody holds priority, which is the whole point of Bone
  Splinters.

Six cards for them (Burst Lightning, Breath of Darigaaz, Agonizing Demise, Bone Splinters, Village
Rites, and Judith) and a sixth deck, **Ashen Rite**, built out of all three. Two small engine gaps
turned up on the way and were worth closing in themselves: a static that skips its own source
("*other* creatures you control get +1/+0" — a lord that pumped itself would attack as a 3/2), and
"a **nontoken** creature you control dies", which is how nearly every death payoff is printed and
the clause that stops a deck of tokens draining a table by accident.

Measured over 24 unsteered games on the new deck: 21 spells kicked, 38 cast by sacrificing a
creature, 6 lands cycled out of 46 chances, every game finished, 22.5 turns on average. The bot
needed teaching for two of those — it would have sent a kicked play without the kicker (casting the
cheap half of a card the table offered as the expensive one) and a Bone Splinters with nothing
named to feed it, which the engine would have refused.

**A stronger opponent, and the measurement that made it one.** The bot took the most expensive
play it could afford. Now it builds every play it could make, plays each one out until the stack
is empty, scores the position with a four-weight evaluator, and keeps the best — one ply, no
further, because a second ply needs an opponent model and that is only worth writing once the
evaluation has been shown to be any good.

It has been. Head-to-head against the bot it replaced, alternating which seat searched so neither
deck nor turn order could explain it: **105 wins to 55 over 160 games**, every game finished, 17.9
turns on average, no refused actions. The old bot is still there behind `{ lookahead: false }`,
because a claim like that needs a control to be re-measured against — and because the tests that
play dozens of games want the cheap, wilder bot that casts whatever is most expensive and so
wanders into more of the engine.

Two things came out of the measurement that no amount of reasoning had produced. The first: the
evaluator must value **a land in play above a card in hand**, or a land drop *lowers* the score and
the bot stops making it — that version lost 60 games out of 60 while looking exactly like a tuning
problem. The land drop is a rule now, taken before the search, which is also what the old ranking's
"always make your land drop" was saying. The second: weighing each play against *doing nothing* —
the obvious way to stop a bot spending a Shock on a 1/1 — made it measurably worse, 28 wins of 60
against 40 with no baseline at all. A card kept is a card the evaluation scores; the turn it cost
is invisible. So the search decides *which* play, and the old bias to act stands.

What it buys, as two tests rather than an adjective: it will not cast a Hurricane that hits its own
board for nothing when a Doom Blade kills the Serra Angel, and it will not pay a kicker that turns
a ping into a wipe of its own creatures. Both of those were the expensive play, and the expensive
play is what the old bot took.

Cost, measured, because an opponent that thinks is only better if nobody waits for it: a decision
takes 0.1–0.3ms at the median, under 9ms at the 95th percentile, 32ms at the very worst in a
four-player pod.

**Combat, searched too.** Attacks and blocks were the last two judgements still made by
arithmetic: `exchange()` asks "would this creature die to that one" and nothing about what the
whole exchange leaves behind. Now the bot builds a handful of *plans* — what the heuristic would
do, nothing at all, everything that can attack, and the heuristic minus its biggest creature — and
plays each one through blockers, damage and the triggers that damage raises, with the defender
blocking by the bot's own policy. Four plans rather than every subset, because the subsets of ten
attackers are a thousand combats and these four are the shapes a player chooses between.

Paired against the same 400 games on the same seeds: **270 wins to 130 with the combat search, 253
to 147 without it** — 17 games that turned on a declaration. It changes the attack in 126 of 479
combats, attacking with *fewer* creatures in 85 of them and more in 41, and changes the blocks in
40 of 161. Finishing the triggers before scoring was worth another 5 games: the step moves on the
moment damage is dealt, so stopping at the step boundary scored two creatures dying in front of a
Blood Artist without the four points of life that follow, and the bot traded into a drain engine
every time. It now declines that attack, which is a test.

**Two things the measurement said no to.** Scoring an untapped creature above a tapped one — the
cheap way to make the bot hold a blocker back — changed nothing at one point, cost 26 games in 400
at two, and at four made the bot *worse than the one it replaced*. In this pool attacking is right,
and a bot that keeps blockers home never closes. And the search had quietly stopped using
planeswalkers (three activations in sixteen games) because a loyalty counter was worth nothing in
the evaluation: a plus ability bought something it could not see. Loyalty is scored now, at about
the value of a point of life, which is what it is.

**Exile until this leaves the battlefield**, which is the commonest removal in Magic and was
missing because the engine could not express the link. Two pieces: a **leave-the-battlefield
trigger** (CR 603.6c), recorded at the same choke point as `dies` so that destroyed, exiled,
bounced and sacrificed all count and no caller has to remember it; and the link itself, kept on the
exiled card (`exiledBy`) the way an Aura's host is kept on the Aura, so the permanent that leaves
knows exactly what to give back — to its **owner**, not to whoever took it, which is the difference
between Journey to Nowhere and a Mind Control. Three cards: Banisher Priest, Journey to Nowhere and
Banishing Light, the first card in the pool to point at a *permanent* rather than a creature. The
table names what a permanent is holding ("holding Shivan Dragon"), because otherwise killing the
Journey is a guess.

**And it found a real loop, printed on a real card.** The first version used Oblivion Ring, whose
text is "exile target nonland permanent" — which, alone on an empty board, is itself. It exiles
itself, leaving fires its own return trigger, the return brings it back, entering exiles it again:
fifty iterations and a game over on turn five, in two of thirty unsteered games. The fix is not a
house rule in the engine but the card that says **"another"**, which is what Wizards printed ten
years later. Banishing Light is in the deck and Oblivion Ring is in the comment.

**The word "another" also found a bug that had been there for weeks.** A trigger waiting to be
aimed had its candidates listed *without the source*, so every filter that says "another" was
offering the ability's own permanent — while the engine, which does pass the source, refused the
choice. A table offering what the engine refuses is the one bug class `legalActions` exists to
prevent, and nothing had shown it because no card until now needed the word.

Measured over 30 unsteered games: 25 of these cards cast, 18 of them finding a legal target and
exiling something (the rest correctly doing nothing, by CR 603.3c). No game destroyed the exiler,
so the giving-back half is proved by tests — one per way of leaving: destroyed, exiled, bounced.

**Mana that is not a land**, which was a live code path with no card behind it. The mana solver has
distinguished a *sum* of mana from a *choice* of mana since it was written — the comment on the
Guildgates names Sol Ring as the thing a dual land is not — and nothing in the pool had ever made
two mana off one tap, or offered five colours instead of two. Sol Ring, Mind Stone and Birds of
Paradise now do, in the decks that want them.

**And the first card to make two mana found the solver tapping one permanent too many.** For the
generic part of a cost it took whatever was first in the list: a Swamp for one, still short, then
the Ring as well — three permanents spent on a cost two could pay, and a land left face down for
nothing. It now takes the largest source that still fits, and the smallest overshoot when nothing
does, which is the tap a player would make. Two tests, because "fewest taps" and "do not overshoot"
pull in opposite directions and the second is the one that keeps a Sol Ring from paying for a
one-drop.

**Reading the table.** A four-player board shows everything and says nothing: life, hand size and
graveyard are on every seat strip, and the number a pod turn actually turns on — how much power is
pointed at you, and how much of it can still block — was nowhere. Working it out meant counting
creatures across three columns while the clock ran. Each strip now says `board 11 (2 up)`: the
total *computed* power of that seat's creatures, and how many are untapped. Two numbers, because
they answer two different questions — what can kill you on their turn, and what can stop you on
yours — and both are read from the same view the board is drawn from, so neither can disagree with
what is on screen.

**And tapping as fast as the server plays found a real bug in the client.** The solo pod suite
failed with "Firebrand Archer can only be cast in your main phase with an empty stack" — a refusal
on a button the table was showing. A play is composed from the view React last rendered, but the
action went out stamped with the *newest* version, because that is what the store accepts, so the
one guard that tells a stale play from an illegal one ("has the table moved since this was sent?")
could never fire. Every action now carries the version of the view it was composed from, which is
the question that was actually being asked. In a pod with three server seats the table moves
constantly, and a human finger is slower than a Playwright click, so this was a bug a player would
have hit and reported as "it said no for no reason".

The browser driver's text reads are bounded too, for the same reason its clicks already were: a
read of an element that had just been re-rendered away ended a whole run with
`locator.textContent: Timeout 30000ms exceeded` on a game that was going fine.

**"Again" is one tap.** The table had a "New game" button that emptied it back to an unstarted
tabletop — right when somebody is changing decks, wrong when two people have just finished a game
and said "again": that took a reset, two deck picks, a start, and a switch back into Arena mode.
`game:rematch` does all of it in one action, atomically, with the same decks, the engine still
running, and the previous winner going second — the table convention, and the engine knows who won,
so nobody has to choose.

It is composed out of the reducers a player would otherwise drive by hand rather than written as a
new rule, so every step is enforced by the thing that already enforces it: a deck that no longer
resolves fails the rematch exactly as it fails the manual version, and the log reads the same as if
somebody had done it themselves. Two rules of its own: **any seated player may ask** (a rematch
after a finished game is nobody's privilege, unlike a reset mid-game, which stays the host's), and
**only once the game is over**.

**Eight more cards, and the first sweeper.** Day of Judgment (no deck could answer a board it was
behind on), Icy Manipulator (the first card to point at *any* permanent and do something other than
exile it — a tapper is removal that gives the thing back every turn, and `tapped` is a fact the
attack rules, the block rules and `manaSources` all already respect), Tormod's Crypt (the first card
to touch a whole zone, and the only answer any deck has to a Gravedigger loop), Essence Scatter,
Unsummon, Ambush Viper, Elvish Visionary and Read the Bones. Every one of them needed nothing new
from the engine, which is the point: the vocabulary is now wider than the pool.

The wrath is also the sharpest test of the search there is, since casting it is right when behind
and catastrophic when ahead. Measured over 40 games: castable on 24 moves, cast 5 times, **three of
those from behind on board** and two because it was the only play available — which is the standing
cost of the bot having no "do nothing" option (D53), stated here rather than hidden.

**A draw is a legal ending, and the arena suite had never seen one.** Two players died in the same
event and the game ended with no winner, which is the rule (CR 104.4b) — and the suite failed,
because it asserted somebody wins. It now checks that the table *says* what happened and that both
screens say the same thing.

**Watching a table.** The server has built a spectator view since redaction went in — public zones,
both hands as face-down counts, no legal moves — and nothing could ask for one. `pod:watch` joins a
table's room without taking a seat, at any point in a game, and the client renders a read-only
table for it.

A **separate component**, not `Board` with the interaction switched off: `Board` is a thousand lines
of "what may I do with this card", a watcher may do nothing with any of them, and a `readOnly` flag
threaded through all of it would be a branch on every tap handler in the file — where the one
forgotten branch is a watcher who can play somebody else's turn. There is nothing to redact in the
watching view either, because the hidden cards never left the server.

The arena suite now opens a third browser mid-game and checks the property that matters: a watcher
is a *third party*, so the redaction that keeps two players honest has to keep it honest too — both
boards visible, neither hand, and no control bar at all.

**And it found the last send that was not saying which view it came from.** Every button on the
control bar goes through one dispatch, and that dispatch was the one path still sending without the
rendered version — so a Pass pressed as blockers became owed read to the client as an illegal
action rather than a late one. Same bug as D58, one path further along, found by the same suite.

**A keyword is worth something, and depth is not what was holding the bot back.** Two things were
tried on the opponent this round and only one of them worked.

**Looking one swing ahead did nothing.** The search stops at the end of its own move, so the swing
back is invisible to it — the obvious next step is to project the opponent's next attack and score
*that*. Built, and measured twice on the same 400 games: for every candidate play, and then for
attack declarations alone, where it should matter most. **276 wins either way, with it and without,
at twice the time.** The code is gone and the finding is in the comment where the next person will
look for it: one more ply is not the limit, the evaluation is. In a pool this size a lot of games
are decided by what was drawn, and better decisions have a ceiling.

**Knowing that a flier is not a 2/2 was worth eight games.** `creatureValue` was power plus
toughness, so a 2/2 flier and a 2/2 ground creature were the same creature — to the evaluation
*and* to the combat heuristics that decide whether a trade is good. Keywords are now worth a little
each (flying and deathtouch most, reach least), in the same units as a body: **284 wins to 116,
from 276 to 124**, on the same seeds.

**And a non-linear life total was not worth anything.** Being at two life is worse than being at
twenty minus eighteen, which is true and made no measurable difference in 400 games (285 against
284), so that one is gone too — along with a note, because it is the kind of idea that comes back.

**An attack is now an event the whole board can watch.** Hellrider is one line of printed text —
"whenever a creature you control attacks" — and the engine had no way to say it: the `attacks` event
went to the attacking creature's own script and nowhere else, which is right for the triggers that
talk about themselves and wrong for every one that watches the board. It takes the same `who`/`of`
pair `etb` and `dies` already took now, and a trigger that says nothing about `who` still means
itself, so nothing written before this changed meaning.

It needed one thing the other board-watchers do not: **what the attack was aimed at.** "Deals 1
damage to the player or planeswalker it's attacking" is about that attack, and by the time the
trigger resolves the attacker may be dead and the attack gone from combat — so the declaration
copies it onto the event and the stack object, and the script reads it off `EffectContext.attacked`.
Three creatures attacking three players in a pod produce three triggers that each hit the right one.

**Ball Lightning needed nothing at all**, which is the better half of the increment: six power with
haste and trample, and an end-step trigger that sacrifices it, written in the vocabulary that was
already there.

**And Cloudshift found a rule the engine had never needed.** One mana, exile your own creature and
return it — two `relocate` calls, no new vocabulary, and it re-triggered an Elvish Visionary's draw
and cleared the damage for free. What it did *not* do was the thing players cast it for: blinking a
creature in response to a Doom Blade left the Doom Blade resolving happily, because the engine keeps
one id per physical card and the removal found its target where it left it. A card that changes
zones becomes a new object (CR 400.7), and a spell does not resolve against an object it did not
target (CR 608.2b). Each instance carries an `objectSeq` that the one place a card changes zone
bumps, each stack object records which object its card targets *were*, and a resolution drops the
ones that have since become something else — so a spell that lost one of two targets resolves
against the one it still has and never sees the other. Ids stay stable, nothing new goes on the
wire, and the fizzle rule finally distinguishes "chose nothing" from "lost everything it chose".

The same question turned out to be wrong in combat too: a permanent that leaves the battlefield is
removed from combat (CR 506.4), and the engine found the attack's id back on the battlefield and
swung with it — so blinking your own blocked attacker got its damage through. Each attack records
which objects its attacker and blockers were when they were declared, and the damage step ignores
the ones that are something else now. The blockers are compared rather than dropped from the list,
because that list is also what says the attacker is blocked: a chump blocker that dies still stops
the damage.

**The pod decision, on the button that makes it.** A four-player board showed everything and
concluded nothing. Every seat strip has carried its total power and how many creatures are untapped
since the table read went in; what no screen answered is the question a pod turn is actually spent
on — *which of these three people do I attack* — which needs their life, what they have left to
block with, and whether this swing finishes them, at the moment you are choosing.

Each defender in the attack prompt now says all of it: `Bo 34 · 5 up · 2`, their life, their
untapped power, and how many of your creatures are already pointed at them. The strip's second
number is untapped **power** rather than a headcount, because three untapped 1/1s and one untapped
7/7 are the same count and nothing like the same turn.

`lethal` is the one conclusion the table draws, and it is the strict version: the attack is at least
their life *and* they have no untapped creature, so there is nothing to block with. A seat holding
blockers is never marked, even at one life, because whether the block saves them depends on how the
damage is assigned — and a table that cried lethal and was wrong would be worse than a table that
said nothing. The same marker appears on an opponent's own strip the other way round: their
untapped power alone would kill you and you have nothing untapped to stop it.

And **"all at them" is one press.** Re-pointing a single attacker was already a second tap on it;
what was missing is the commonest decision in the format — four creatures aimed around the table,
then one life total drops and all of them should go at that player. By hand that was four untaps
and four retaps with the aim changed in between, which is long enough for the moment to pass.

What this deliberately does *not* add is a verdict on who is winning. Four life totals sit side by
side already, and a composite score of life and board and cards would be a guess dressed as a fact.

**Four keywords the engine enforced for nobody.** First strike, menace, indestructible and shroud
were all written and all checked in the rules, and no card in the pool had any of them;
`all-creatures` was a static scope with nothing behind it. A live path with no card behind it is the
same risk as an untested one, so five cards now carry them: **Youthful Knight** (the first-strike
damage step had never happened in a game), **Boggart Brute** (a single-blocker declaration is
refused whole, and the table only lights blocks the engine would take), **Darksteel Plate** (four
lines using the Equipment helper's keyword grant: a 2/1 with three damage marked on it stays on the
battlefield and Doom Blade accomplishes nothing), **Robe of Mirrors** (shroud rather than hexproof
on purpose — it stops the *controller* targeting it too, which is the rule hexproof would not test),
and **Night of Souls' Betrayal** (-1/-1 to every creature on the table, which is also the hardest
thing in the pool for the state-based actions: every 1/1 dies at once, and every 1/1 token
afterwards arrives dead).

Measured over thirty unsteered games, because a card in a deck that is never cast has not been
tested: Boggart Brute cast 20 and attacked, Robe of Mirrors 17, Youthful Knight 11, Darksteel Plate
twice (one copy in one deck) holding a creature up with lethal damage on it twice, and Night of
Souls' Betrayal three times, killing a creature as it landed. The first-strike damage step happened
*once* in thirty games — not because the card is broken but because the step only exists when a
first striker is actually in combat and the searching bot rarely blocks, which is what the
deterministic test is for.

`becomes-tapped` is the one trigger left with no card behind it, and it stays that way on purpose:
the bare template is not on a card this pool would carry, and the cards that look like it ("whenever
enchanted land is tapped for mana") are triggers on an *Aura* about the permanent it is attached to,
which a self-only event cannot express.

**And the misclick, which was the last thing at a real table nothing here could recover from.**
An unscripted card has Move by hand, a dropped phone reclaims its seat, a game that cannot continue
has never happened in thousands of playouts — but a creature tapped into the wrong attack, a land
played before the Guildgate, or a Pass pressed a beat early was permanent.

`pod:undo` puts the table back to before the last move. It belongs to the table rather than to the
rules: the engine is an immutable reducer, so the previous state *is* the previous state — there is
nothing to invert and `packages/rules-engine` does not know the feature exists. The store keeps one
step, written inside the same compare-and-set that applies the action so the history cannot tear
away from the state it belongs to, and only for actions that changed the game.

Three things keep it honest. Only the host may press it, because rewriting what already happened in
a hidden-information game is not a power to hand round. The pod says whether there is anything to
take back, so the button is simply absent rather than erroring. And the table announces in chat
that somebody took something back — an undo nobody can see is indistinguishable from the server
losing a move. The limit is stated rather than hidden: the previous state is exactly the previous
state, so a card drawn and then taken back has still been seen by whoever drew it, which is true
across a kitchen table too.

**A seventh deck, and the measurement rewrote it twice.** The two colours with the most answers in
the pool had never been played together: every counterspell was in a deck beside black removal, and
every flier but the Drakes was in a green-white deck that wants to attack on the ground.
**Skyward Writ** is white-blue tempo, and the first deck whose plan is not to have the best board.

Three new cards: Azorius Guildgate (one line through the gate helper), **Wall of Air** — the first
card in the pool carrying `defender` and flying at once — and **Hanna, Ship's Navigator** as the
commander, the first whose text is an activated ability pointing into a graveyard, which needed no
new vocabulary at all.

Then it was played against all six other decks with the searching bot on both sides. The first
version lost 19-41, including **1-9 against both aggro decks**, while casting everything it was
supposed to — so nothing was broken; it simply had nothing alive to answer with. Four Walls instead
of two, a third first striker, instant-speed blockers, a lifegain one-drop and a land fewer took it
to 29-31. The current version is **50-70 over 120 games — 42% against the field**, with the spread a
tempo deck should have: 16-4 against Tidal Mind, 13-7 against Rot Harvest, 9-11 against Ashen Rite,
and 5-15, 5-15, 2-18 against the three decks that attack fastest.

A card was cut by the same numbers: Moon Heron, a 3/2 flier for five, was written, scripted, played
sixty games across two versions and deleted, because it never earned the slot.

And the honest half of the win rate: **holding mana for a counterspell is this deck's whole plan and
the bot cannot do it** — it counters what is counterable, not what matters. That is the limitation
D62 measured, and it means a person plays this deck better than the opponent can.

**And the obvious fix for the control decks, measured and deleted.** A land is worth the same
tapped or untapped, so spending mana costs the search nothing: the bot taps out every turn and is
then holding a counterspell with no mana when the spell worth answering arrives. The term was built
— a little for each untapped land, only while the hand holds an instant, capped at the cheapest
one's cost — and measured over 84 paired games per weight on the same seeds:

| mana-up weight | control decks | counterspells cast |
| --- | --- | --- |
| 0 (none) | 23-61 | 75 |
| 0.5 | 23-61 | 80 |
| 1.0 | 20-64 | 79 |
| 2.0 | 18-66 | 78 |

Monotone in the wrong direction. Removed, with the table in the comment where the next person will
look for it — the third idea about this search built, measured and deleted.

The measurement also corrected the premise, which is the half worth keeping: **every counterspell
the bot casts is already cast in response**, 75 of 75 with the term off, because a counterspell
targets a spell on the stack and with an empty stack it has no legal target to be offered at all.
The handicap is not *when* it counters; it is that it is tapped out when the moment comes, and
pricing untapped mana does not fix that, because the board the mana bought is worth more than the
answer kept for it. Beating an aggressive deck with a control one needs the bot to know *which*
spell is worth answering — a judgement about the opponent, not a price on a land.

**And the ceiling, named rather than walked into again.** D69's diagnostic found what the search
actually gets wrong: over sixty games it never declined to counter a spell it could pay for, so
Counterspells go on Rampant Growths. Pricing an answer in hand above a generic card is the obvious
fix and it was measured over 84 paired games per value:

| answer in hand | control decks | counterspells cast |
| --- | --- | --- |
| 1.5 (as any card) | 23-61 | 75 |
| 2.5 | 22-62 | 82 |
| 3.5 | 21-63 | 83 |
| 5.0 | 21-63 | 83 |

Worse, and the second column goes the wrong way: valuing an answer more made it cast *more*
counterspells, because holding answers made its games longer and the extra turns spent them. Four
ideas have now been measured against this ceiling and all four deleted — a second ply, a swing
projection, untapped mana, and this.

The wall is the shape of the evaluation, not a weight in it: **a sum of material cannot say "this is
worth more later than now"**, so every weight that makes holding a card attractive also makes doing
nothing attractive. What is missing is which of the opponent's spells is the one that beats you — a
judgement that depends on their deck, board, hand and the race, none of which the sum reads. The two
things that would move it are written down in `claude/decisions-log.md` (D70), along with the note
that the one bot change in this series that *did* win games was Magic knowledge rather than a
weight: knowing that a flier is not a 2/2.

**Eleven more cards, and the first filter that reads combat.** Lightning Strike, Lava Axe, Cancel,
Murder, Giant Spider, Titanic Growth, Healer's Hawk, Dark Ritual, Borderland Marauder, Prey Upon and
Divine Verdict, one test each, across five of the seven decks.

Three of them needed something the pool had not had. **Divine Verdict** destroys an attacking or
blocking creature, so its target filter asks the *combat state* whether the creature is in combat —
the first script whose castability depends on the step rather than on the board. Outside combat it
has no legal target and the engine does not offer the card at all, which is exactly what the printed
card does on your own main phase (CR 601.2c). **Dark Ritual** is the first spell in the pool that
makes mana instead of spending it, and it needed nothing at all: the mana goes in the pool and the
next play asks the pool what it can afford. **Prey Upon** reads both creatures' power before dealing
either (CR 701.12a), so two 3/3s fighting kill each other rather than the second one dying for free.

Then they were measured the way the last three card increments were: **120 unsteered games** with the
searching bot on both sides, across every pairing of the five decks that gained a card, counting
what each card *did* rather than that its script ran.

| card | cast | and what it did |
| --- | --- | --- |
| Dark Ritual | 35 | **3** were followed by a spell in the same step |
| Giant Spider | 31 | 3 blocks, 1 of them a flier |
| Borderland Marauder | 26 | 13 attacks, **all 13** as a 4/2 |
| Prey Upon | 24 | 19 kills |
| Healer's Hawk | 24 | 23 life gained off its own damage |
| Lightning Strike | 21 | 13 at a player, 8 at a creature |
| Murder | 20 | **9** on a black creature, which a Doom Blade cannot touch |
| Cancel | 19 | 19 countered a spell on the stack |
| Titanic Growth | 17 | **0** cast during a combat |
| Divine Verdict | 11 | 7 killed the attacker outright |
| Lava Axe | 3 | 15 damage to players |

Every card gets cast, and two rows are findings rather than confirmations. **Dark Ritual is thrown
away 32 times out of 35**: the bot casts it and then casts nothing with the mana, which empties at
the end of the step. And **Titanic Growth is never cast in combat** — the bot plays instants at
sorcery speed in its own main phase, so a pump spell is a permanent +4/+4 on an empty board instead
of a blowout on a block. Both are bot behaviour rather than engine faults, and both are written down
rather than fixed in passing.

**A deck slot is not free, and the fallout proved it twice over.** Making room for eleven cards had
quietly cut three others — the second Shock, Tome Scour and both Secure the Wastes — and every one
of them was *pinned* by a test that places it by name out of a real deck. They are back, paid for
out of a second Shivan Dragon in a deck whose curve tops at four, a second Tormod's Crypt that
answered nothing the first had not, a third Rampant Growth and a second Selesnya Charm. Each pinned
card now says so in the deck list beside it.

Reshuffling those decks then turned two playout tests red, and **neither was really about the
decks** — both had been passing on luck:

- *"fires death triggers in real games"* looked for the trigger's description in `stackObjects`
  after each bot action. With auto-pass on, a trigger nobody can respond to is put on the stack and
  resolved inside the same action, so the snapshot almost always misses it. Measured over sixteen of
  these games: six Doomed Travellers died, six Spirits arrived, and the stack was caught holding the
  trigger **exactly once**. It now counts the consequence, which is the stronger claim anyway —
  every Traveller that died left a Spirit behind, whatever killed it.
- *"casts modal spells"* failed, passed and failed again on three consecutive runs of identical
  code, which reads exactly like a nondeterministic engine. It is not: the same twelve games produce
  the same seventeen modal casts and the same six mode combinations, byte-identical across
  processes. The test was 4.5s of work against vitest's 5s default and failed whenever another
  package's suite ran beside it. The package now sets the timeout once, in `vitest.config.ts`.

**The render loop nothing was watching for.** The dev server's log from one run of the browser
suites held **7,555** copies of React's "Maximum update depth exceeded". `CombatArrows` built a
fresh array of attacks on every render, a `useCallback` depended on it by identity, the effect
depended on the callback, and the effect's measurement set state — so while anything was attacking,
the table re-rendered as fast as React would let it. The no-combat path already returned the
existing state unchanged, which is why it only happened during combat, and why a four-player pod
spent its declare-blockers step re-rendering instead of answering taps. That is how it was found at
all: the pod suite stalled with nothing on screen to press.

The fix is to depend on the combat *by value* — a string that changes when the attacks or the blocks
do — to keep the measurement in a ref so the callback can be stable, and to return the existing
state when a new measurement is identical, which also makes a scroll that moved nothing cost
nothing.

**And the reason no test caught it: `pageerror` only fires for an exception nobody caught.** React
logs a render loop to the console and carries on. All five browser suites now watch the console for
React's own complaints and fail on them, and the check was verified the only way a check can be —
by putting the bug back and watching it go red, then taking it out again.

**The bot stops casting Dark Ritual into nothing — and the two ways a rule like this goes wrong.**
The 120-game measurement above found it: cast 35 times, followed by a spell in the same step 3
times. The cause is structural rather than a bad weight. `candidateActions` never offers "pass" as
an option — that was measured and is right in general, because the search cannot see what holding a
card buys — so whenever a ritual is the only affordable play, it gets cast. Mana empties at the end
of the step (CR 500.4), and by the evaluation all that happened is a card left the hand.

The rule is the same shape as the two already in the search ("do not cast an X spell for X=0", "do
not eat a better creature than the one you are feeding it to"): a card spent on nothing is a fact
about the line, not an opinion about the position, which is why it does not run into D70's ceiling.
A ritual is declared on the card (`makesMana` on the script, which the engine itself never reads)
and dropped from the options unless the line it opens contains a cast that was not legal before.

Both of its first two versions were wrong, and both were found by instrumenting rather than
reasoning:

- It compared **pool sizes** before and after — and changed nothing at all. Identical records,
  casts and follow-ups over 84 paired games, because a simulated line does not stop where the
  action does: with auto-pass on, the engine keeps passing for any seat with nothing to do, so the
  state `simulate` returns can be a step later with the pool long since emptied. Half the time the
  pool had not grown at all.
- Then it fired on exactly the right lines and *still* changed nothing, because `best` was seeded
  with `options[0]` — a loop that skipped every option returned the first one anyway. The search
  had no way to say "none of these". It does now, and that is the piece worth keeping: a filter is
  only as good as the default it falls back to.

**Measured, paired on seeds, Ashen Rite against the other six decks, 240 games per arm and then 240
more on a fresh seed set:**

| | casts | followed by a spell | left in hand | record |
| --- | --- | --- | --- | --- |
| without | 164 | 17 (10%) | 7 | 92-148 |
| with | 124 | **115 (93%)** | 44 | 89-151 |
| without, fresh seeds | 148 | 20 (14%) | 5 | 110-130 |
| with, fresh seeds | 107 | **102 (95%)** | 45 | 118-122 |

The card does its job nine times in ten instead of one, and the record moves three games one way
and eight the other — nothing, which is the honest answer for two cards out of sixty. Kept for the
first column rather than the last: a bot that casts a Dark Ritual and then does nothing with it
looks broken to the person sitting opposite, and that is worth more here than a win rate.

Two things that came with the measurement and are worth more than the rule. **An 18-game swing
between two seed sets of the same configuration** — 92-148 and 110-130 — which is the scale the
earlier 84-game sweeps in `claude/decisions-log.md` were being read at, so a 3-game difference there
was never a result. And one hypothesis about the three games measured and **refuted** rather than
written up as a cause: that a hand full of unspendable rituals would discard real cards at cleanup,
since the discard rule pitches the most expensive card. Over those 240 games there were 18 cleanup
discards, 12 with a ritual in hand, and not one ritual discarded.

**The table has a voice.** The Play Realm spec has named eight sound cues since before the rules
engine existed — `card_draw`, `land_play`, `spell_cast`, `creature_cast`, `combat_hit`, `tap_mana`,
`phase_step`, `game_over` — and the React table had none of them. A game where the only way to know
the opponent did something is to read a log is a game you play with your eyes on the wrong thing.

Split the way `arena.ts` is split, for the same reason. `cuesFor(before, after)` is a pure function
over two consecutive views with eighteen tests and no browser in sight; `createSoundEngine` is a few
oscillators with no rules in it at all. Nothing is fetched: eight short recipes synthesised on the
spot, every gain between 0.03 and 0.12, and the longest one is the one that plays when the game is
over.

The cues come from the **view diff**, not from `view.log`. The log is prose written for a player to
read, so matching on it would be matching on wording that is free to change; a life total that went
down is a life total that went down. And they come from the views rather than from the taps that
caused them, which is the only way the table can also speak for the other player's turn — and for
the bots', which is where most of what a solo player needs to hear happens.

Four rules in it are there because the obvious version is worse than silence:

- **The first view makes no sound.** Sitting down at a table, or reconnecting to one in progress, is
  a hand, a board and a life total arriving at once.
- **A stateVersion that does not advance makes no sound.** The host taking the last move back
  restores an older engine state and a rematch starts a new one; neither is a draw step, and the
  difference between those two views reads as both.
- **Only your own draws.** A card the opponent drew is a card you cannot see, and a table that
  announced it would be telling you something a real table does not.
- **Triggered abilities are silent, unlike spells.** A sacrifice deck puts two or three abilities on
  the stack for one creature dying. At most two cues survive any one update, loudest first, and the
  step tick — the quietest and by far the most frequent — is dropped whenever anything else fired.

The toggle is in the table's own toolbar, remembered in `localStorage`, an SVG icon rather than an
emoji, and the state is on the element (`data-sound`) rather than only in the icon, because a test
cannot read an icon and a screen reader should not have to.

And the check that matters most: **the arena suite counts the audio nodes the page builds.** Without
it the whole feature could be dead and every other check would still pass — the toggle would flip,
the preference would persist, and nothing would ever make a noise. A headless browser has no
speaker, so what is proved is that the cue was reached and the oscillators were created. It also now
proves something no other check did: a reloaded table reclaims its seat, which is what `table.ts`
keeps the code and player id in `localStorage` for.

**And it says what just happened.** The engine has written a line for every action since the log was
rewritten to say what *happened* rather than what was played — and the only way to read it was to
open a panel. A player whose creature was destroyed on somebody else's turn should not have to go
looking for that.

The same split as the cues, for the same reason: `newEntries(before, after)` is a pure function with
its own tests, the timers are in a hook, and the markup knows nothing. The three silent cases are
the three `cuesFor` has — the first view, a stateVersion that does not advance, a different table.

**The filter is the feature.** Three things are dropped, each structurally rather than by matching
on wording:

- a **mana ability**, which carries `produced` in its data and happens three times before every
  spell;
- a **bare pass**, which the engine makes for a seat with nothing to do several times a turn — but
  not a pass that resolved something, because the engine appends the consequence to the same
  message after a semicolon;
- a **step beginning**, which carries `step` in its data and which the phase bar has been saying in
  bigger letters since long before this existed.

The last of those was found by looking at a screenshot of the feature working. The first line the
feed ever put on a real table was *"Nick passes — postcombat main"*, which is where the game is
rather than what happened. Two more came from the same screenshot: the lines were landing at the
bottom of the **document** rather than the screen, because the board is a column taller than the
viewport and `absolute bottom-*` means something different there; and left-aligned they sat across
the first card's name, when the right end of the hand row is the emptiest place on the board. The
browser suite now measures the rectangles — on screen, clear of the control bar — rather than
trusting the offset.

A duplicated rule went with it: the log panel's own "a pass with no consequence is noise" regex now
reads `isBarePass` from the same module. The two filters stay different in the one way that matters
— the log keeps the mana taps, because *"why is that Mountain tapped"* is a question a record should
answer and a headline should not.

**And one test was fixed by the render-loop fix, which is worth recording.** The arena suite checks
that an attack is drawn on the board by looking for an arrow immediately after the declaration. The
overlay measures the DOM, so the arrow appears a render *later* — a race the suite used to win every
time, because `CombatArrows` was re-measuring continuously in the infinite loop described above.
Fixing the loop made the overlay measure once, correctly, and turned that line into a coin flip: it
passed four runs and failed the fifth. It waits up to a second now, which is what the claim always
needed.

**Damage that does not happen.** Every answer in the pool removed something — kill it, exile it,
bounce it, stop it attacking — and all of them are permanent and all of them cost a card for a card.
Nothing could prevent damage, which rules out the family a casual player expects first: a Fog is the
cheapest card in the game that beats an alpha strike.

Built as a flag on the continuous effects rather than as a prevention subsystem, because everything
such an effect needs was already there: a scope that can name one card or every creature, a
duration, an expiry pass and a source. `preventsCombatDamage` says "combat damage involving these
permanents does not happen — dealt by them *and* dealt to them", which is the sentence both printed
cards use, and the engine reads it in exactly one place, `dealCombatDamage`. It is combat-only and
named so: "prevent the next 3 damage" is a shield with a quantity that is spent, a different shape
that no card here needed at the time. Two cards need it now, and it is built as its own thing rather
than as a stretch of this flag — see "A shield with a number on it" below.

Four cards, and each one is a different shape of the same flag:

| card | what it is |
| --- | --- |
| **Fog** {G} | the effect with an all-creatures scope, until end of turn |
| **Holy Day** {1}{W} | the same card in white, for the deck that holds the ground |
| **Maze of Ith** | a land that answers one attacker every turn and never taps for mana — the scope is one card, and the untap is what lets it attack *and* block in a Commander game |
| **Fog Bank** {1}{U} | a 0/2 that blocks anything in the pool and survives it: the same effect as a permanent static on itself |

Fog Bank is also the only card that reaches one branch of combat — a blocker whose damage is
prevented while the attacker's is not. A Ball Lightning blocked by one still has to *assign* lethal
damage to it before it may trample past (CR 702.19b), so four of its six get through rather than
six. A Fog never produces that case, because it covers the attacker too.

**The player has to be able to see it**, and this is the one effect in the pool that changes nothing
on any card: no power, no toughness, no keyword. So `VisibleCard` carries a computed
`damagePrevented` the way it already carries power and keywords, and the badge says "damage
prevented" — because the block you make under a Fog is the opposite of the block you would make
without one.

**And the bot had to be taught, twice.** A Fog cast with nothing attacking is a card in the
graveyard, and the evaluation sees a card leaving the hand either way — the same blind spot the
rituals sat in. The first version of the rule asked the state *after* the cast whether a prevention
effect had appeared, and let every pointless Fog through: **21 cast across 160 games, 11 of them
into an empty board.** With auto-pass on, a spell nobody can respond to resolves inside the same
action and the engine keeps passing, so a simulated line can end the turn — by which point an
end-of-turn effect is gone. (The ritual rule's own comment says this. Reading your own notes is the
lesson.)

Declared on the card instead, like `makesMana`, and asked of the board before the cast. Then the
first measurement of the working rule found the second mistake: a Fog is symmetric, so fogging your
*own* alpha strike prevents your damage and nobody else's — nine Holy Days had stopped eight points
of attacking power between them. The question is now "is there an attack **aimed at this seat**".

**Measured over 160 unsteered games, across eight pairings:**

| card | used | attacking power stopped |
| --- | --- | --- |
| Maze of Ith | 76 | 202 |
| Fog Bank | 23 cast, 24 blocks | 49 |
| Fog | 14 | 53 |
| Holy Day | 9 | 41 |

Every one of them gets used and every one of them stops real damage — and nothing is cast into an
empty board any more.

**And it says why it will not let you.** Tapping a card the engine is not offering said *"Nothing
you can do with Lava Axe right now."* — true, and useless. The next question a player asks is
always *why*, and the answer is the difference between waiting a turn for the mana and waiting for
something to point it at.

`castablePlays` already knew: every `continue` in it is a reason. They are collected into
`LegalActions.blocked` — a card id and a short sentence, first reason met wins — and the play sheet
says it: *"Nothing you can do with Lightning Bolt right now: not enough mana, counting every land
you could still tap."*

Read from the engine rather than worked out in the client, which is the point. A table knows the
step and the pool and could guess most of them, but **a spell with no legal target looks exactly
like a spell you cannot afford**, and those want different answers from the player. A second
implementation of "can this be cast" is the one thing `legalActions` exists to prevent.

Six reasons, one test each: a land outside your main phase, a land when you have had your one, a
sorcery at the wrong time, a cost you cannot pay (counting every land you could still tap, not only
what is floating), a spell with nothing to target, and a spell that eats a creature when you have
none. A card the engine *is* offering is not in the list at all, however many of its modes were
rejected on the way.

### The trigger with no card, and a cost that is not mana

`becomes-tapped` was the last trigger in the engine with no card behind it, and the reason it had
none is that every card that uses it charges you for its own mana. So: the two painlands, and the
creature that charges you for the card it draws.

**City of Brass** — *"Whenever City of Brass becomes tapped, it deals 1 damage to you."* The
trigger, not the mana ability, which is the distinction that matters: an Icy Manipulator tapping
your City still deals you the damage, and a hook on "tapped for mana" would miss it. `settle`
raises it the way it raises a death — by comparing the board before an action to the board after
and noticing a permanent that was untapped and now is not — so every way of tapping it is covered
without any of them being enumerated. A land that *entered* tapped did not become tapped, and the
comparison gets that right for free (a Guildgate costs no life), which a "set tapped" hook would
have charged for.

**Mana Confluence** — the same card with the cost and the trigger swapped: *"{T}, Pay 1 life: Add
one mana of any colour."* Life on `AbilityCost`, paid as the ability is activated, checked before
it is offered. Nothing goes on the stack and nothing can be done about it, because that is what a
cost is (CR 118.4, CR 605.1a). At one life the ability is simply not offered: a cost you cannot pay
is not a cost you may pay, and the engine stops one short of paying down to zero.

**Dark Confidant** — *"At the beginning of your upkeep, reveal the top card of your library and put
that card into your hand. You lose life equal to its mana value."* One trigger that draws and then
charges for what it drew, including nothing for a land.

**The half that was missing, and that the first measurement hid.** `manaSources` is the engine's one
answer to "can this be paid for at all" — it drives both affordability and the auto-tap — and it
only admitted abilities that needed *nothing but a tap*:

```ts
if (ability.cost.mana !== undefined) continue;
if (!ability.cost.tap) continue;
if (ability.cost.sacrificeSelf) continue;
```

So Mana Confluence was a dead land. It paid for nothing, it never showed in the dimmed pips, and a
player holding a Soul Warden with a Confluence in play was told the card could not be cast while
looking straight at the mana for it. A life cost is the one non-mana cost that belongs in that
list, because it is the one a seat can always decide about from its own life total: it is admitted
while there is life to pay it, the life is paid in `tapSources` as the tap happens, and painful
sources are listed **last** so that every tie-break in `solveTap` — each of which keeps the first
source it found — reaches for a Plains before it reaches for your life.

**And the measurement was wrong before the cards were.** The first pass counted bot *actions*
naming the painlands and came back with `cityTaps: 0, cityDamage: 0`, which reads as two dead
cards. It is not: `candidateActions` never offers a mana ability, so a land the engine taps while
paying for a spell is never an action anybody took. Counted off the board instead — untapped
before an action, tapped after it — over 120 unsteered games:

| card | copies drawn | taps | life it cost |
| --- | --- | --- | --- |
| City of Brass | 25 | 107 | 85 |
| Mana Confluence | 23 | 66 | 62 |
| Dark Confidant | 14 cast | 50 upkeeps | 65 |

A second attempt at City's damage watched its trigger on the stack and found **none in 120 games**,
for the third outing of the same trap: with auto-pass on, a trigger nobody can respond to goes on
the stack and resolves inside the same write, so it is never visible between two actions. The state
between actions is not the state during one. Both halves are attributed the same way in the end —
life the owner lost in the action that tapped their land, bounded by the number of taps — which is
a lower bound and an honest one.

### The pod that stopped at declare-blockers

A four-seat pod could reach a position with no legal reading: attacks on the table, nobody owed a
declaration, and nobody holding priority. Every caller behaved correctly and the table was dead —
the player's bar showed no move, the server's own seats were never asked to move one, and the
browser suite reported it four seconds later as *"stopped at Declare blockers on turn 65"* with
nothing on screen to press.

**Hellrider gets there.** Its controller declares four attackers at a player on three life; the
trigger — one damage for each creature that attacked — kills them while the attack is still on the
table. By then the step has moved to declare-blockers and set `priority: null` because a block was
owed. The block is not owed any more, and the code that hands priority back only runs when a
question is *answered*. Two of the first eight pods played with a rotating deck list died this way,
on turns 40 and 48.

Fixed twice over, in the one place that already repairs this family of state:

- **The cause.** A player who leaves the game takes the attacks aimed at them with them
  (CR 800.4a), and an attacker whose own controller has left goes with it.
- **The invariant.** If the game is running and nothing is owed, somebody holds priority. Untap and
  cleanup excepted, being the two steps where nobody holds it on purpose. Written as an invariant
  rather than as a patch to the one action that broke it, which is D81.

**It is also the first bug this project found in its own unaccounted-for failure.** The suite had
been flaking at that check for a while and the entry in the open list said "intermittent". It was
not intermittent: it was a reproducible deadlock behind a deck list the pod playouts held constant.
Four-seat pods with the decks rotated through all seven found it in eight games.

**Measured on the same sixty seeds, before and after:**

| | games | finished | deadlocked |
| --- | --- | --- | --- |
| before | first 10 | 8 | **2** |
| after | 60 | 58 | **0** |

The two that did not finish after the fix did not deadlock either — they ran out of a 25-second
wall-clock budget while the bot was still *deciding*, at over 140ms a move against under 1ms
everywhere else. The same two seeds are slow before the fix as after it, so that is its own bug and
is written up as one: the searching bot enumerates every attack and block declaration, and a
forty-turn four-seat board is where that stops being free. It matters beyond a sweep, because the
server plays the bots' whole turns inside the human's write and the browser gives up on an answer
after eight seconds.

Three things changed on the way to it, all worth keeping:

- **`runBots` says why it stopped.** It returns silently on four different conditions, every one of
  which leaves the pod waiting on a seat nobody will move, and it was called with nothing to report
  them to. The realtime server now warns with the seat, the step and the reason, and the
  whole-game test asserts that a solo game produces none.
- **One owner for a refusal, by code rather than by timing.** The table's `pod:error` handler
  deferred to `send` by counting calls in flight, which reads zero in the gap between a retry's
  attempts and again after the eight-second ack timeout — so a refusal `send` had deliberately
  swallowed could still put the banner up, with no move named in front of it. That is what
  *"FORBIDDEN: you do not have priority"* on a solo pod screen was. The codes an action's ack
  carries are now refused there outright.
- **The test runner's own flake is fixed.** `vitest run` on the engine package had been reporting
  `[vitest-worker]: Timeout calling "onTaskUpdate"` beside a full set of passing tests and exiting
  1 — about one run in two, and by this point every run. The config had already ruled out four
  mitigations and named the remaining candidate: a playout test is eleven seconds of *synchronous*
  game-playing in one body, and a worker that never yields cannot answer the reporter. One `await`
  per game in the five longest tests cleared it, and `turbo run test --force` has run green four
  times in a row since. Written up as D82.

### The opponent that would not win

A pod in sixty took over 140ms a decision where every other took under 1ms, and the profile said
declare-attackers: 2.8 seconds a call, with **1859 creatures on the battlefield**. It looked like a
search that could not cope with a wide board. It was the opposite.

The seat with the board was playing Krenko, Mob Boss — *"{T}: Create X 1/1 red Goblin tokens, where
X is the number of Goblins you control"* — and activating him every turn he was untapped: 7, 15,
31, 61, 116, 230, 461, 923, 1847. Meanwhile his three opponents sat on 3, 6 and 1 life, and he
attacked with nothing. Captured the position and replayed the two plans:

| plan | result | score |
| --- | --- | --- |
| attack with nothing | nothing happens | **1877.3** |
| attack with all 462 ready creatures | an opponent dies on the spot | 1875.0 |

`evaluate` is "my side, less the average opponent", and the average was taken over the opponents
**still alive** — so killing the weakest raised the average of the ones left and the score went
down. The bot was not failing to see the alpha strike; it was correctly maximising a number that
said winning was bad.

The fix is one word: divide by the seats the table *started* with. It keeps the reason the average
is there (a pod is "am I ahead of the table", not "is the rest of the table small") and makes an
elimination what it is. A two-player game computes the same number either way, so none of the duel
measurements in `bot.ts` move.

**Measured on sixty four-seat pods, the same seeds before and after:**

| | finished | median turns | mean turns | whole sweep | slowest game |
| --- | --- | --- | --- | --- | --- |
| before | 58/60 | 65 | 65.2 | 327s | 25.3s (gave up) |
| after | **60/60** | **51** | **53.6** | **184s** | **9.9s** |

Forty-seven of the sixty finish sooner. Both of the games that had not finished at all now do. The
performance bug closed itself: nothing in the search got faster, the games just stopped going on
long enough to build a board nobody could think about.

**One loose end, recorded rather than claimed closed.** During this increment a single realtime test
failed once under `turbo run test --force`, with all ten packages' suites running at once, and did
not recur in eight direct runs of that suite or four more `--force` runs. Its name was lost, because
the command's output had been filtered down to its summary line before anything read it — the same
mistake as reading one line of a Playwright timeout, and the reason the verification runs here now
write their whole output to a file first. If it comes back, the log will say which test.

### Answering a permanent, and answering an answer

Two holes a pair of friends would hit in their first game.

**Nothing in any deck could answer an artifact or an enchantment.** Fourteen of the pool's cards
are one or the other — a Pacifism, a Journey to Nowhere, a Loxodon Warhammer, an Icy Manipulator,
a Night of Souls' Betrayal that shrinks everybody — and not one card could remove either. A
Pacifism on your commander was permanent, for the rest of the game.

**And nothing protected a creature at instant speed.** Every answer in the pool pointed one way:
destroy, exile, bounce, pacify. The only card that granted untargetability was Robe of Mirrors, an
aura cast on your own main phase onto a creature nobody was threatening yet.

Four cards, no new engine surface: Naturalize and Disenchant destroy target artifact or
enchantment (`kind: 'permanent'` with a filter, which the targeting layer has expressed since
Banishing Light), and Blossoming Defense and Dive Down give one of your creatures +2/+2 or +0/+3
and hexproof until end of turn (a `pump` with a keyword, which is how Robe of Mirrors already
grants shroud).

**Measured over 160 unsteered games across eight pairings:**

| card | drawn | cast | what it destroyed |
| --- | --- | --- | --- |
| Naturalize | 80 | 62 | 20 Journeys, 8 Bonesplitters, 7 Warhammers, 6 Pacifisms, 4 Icy Manipulators |
| Disenchant | 31 | 20 | 5 Journeys, 4 Bonesplitters, 3 Warhammers, a Glorious Anthem |

Seven of the 62 Naturalizes destroyed nothing, which is what a Darksteel Plate is for. Three
destroyed a *creature* — removing a Loxodon Warhammer from a creature that had already taken three
damage is lethal, and the engine worked that out without being told.

The two interactions that make these cards feel like Magic are both free. Destroying a Journey to
Nowhere gives the creature back, through the Journey's own `leaves` trigger — `destroy` is just one
more way for it to leave. And hexproof cast in response to a Doom Blade makes the Doom Blade miss,
because its target has become illegal and a spell with no legal targets is countered on resolution
(CR 608.2b). Cloudshift proves that rule from the other side; this proves it without the card
moving.

**The bot had to be taught, and the measurement had to be taught first.** The protection spells
were thrown away — 64 cast, 60 of them with an empty stack — which is the third card in the family
D63 and D77 named, so it got the same treatment: a flag on the card, a question asked of the board
before the cast. What was new is that the first measurement could not see whether the rule worked,
because it had two buckets and a pump cast *during a combat* landed in the waste one. With three:

| | cast | in response | in combat | at nothing |
| --- | --- | --- | --- | --- |
| Blossoming Defense, before | 34 | 1 | 0 | **33** |
| Blossoming Defense, after | 30 | 5 | 25 | **0** |
| Dive Down, before | 30 | 3 | 0 | **27** |
| Dive Down, after | 29 | 1 | 28 | **0** |

Before the rule, `inCombat` is **zero**: every copy was spent on the caster's own main phase, so
the card was in the graveyard before it could matter. The rule's real effect is not that it stops
a bad cast — it is that holding the card is what lets the search find the good one.

Deck slots were paid for, not found: a Giant Spider, a Cloudshift, a Prey Upon, a Drudge
Skeletons, a Lotleth Giant, a Wall of Air, a Divine Verdict, an Angelic Gift and a Ravenous Rats.
Every deck is still exactly 60 plus a commander; 149 cards have scripts.

**And the oldest open flake in the project closed itself along the way.** The solo suites had been
failing about one run in twelve on *"and 'play again' deals another game at the same table"*, with
nothing to go on but `pressed: false`. An earlier increment answered that with an instrument
rather than a fix — a last click that keeps Playwright's whole call log instead of its first line.
This run it fired: `<div data-testid="play-sheet"> intercepts pointer events`. A card sheet, left
open over the end of the game, covering the button for the next one.

The sheet now clears when the game finishes **and** cannot open on a finished table, which are two
different bugs: the first version shipped only the clear, and a sheet opened *after* the game ended
goes straight past it. The check that caught that is deterministic — tap any card once the game is
over, and nothing may open — and it took three attempts to write, because the first could not press
concede (the sheet was covering it) and the second quietly never ran (the losing hand is usually
empty). Written up as D85.

### The pump cast at the wrong time

The protection spells showed the shape of this: before the rule that held them back, they were
cast 64 times and **never once during a combat**. The pool has five more cards shaped exactly the
same way, and an earlier increment had already noticed one of them — *"Titanic Growth cast 17
times and never in combat"* — and filed it as something the bot could not do.

Measured properly, it was worse than that. Across 160 unsteered games the five pumps were cast 95
times, none of them in a combat, and **59 of those in the caster's own upkeep or draw step** —
before a land had been played, on a board where nothing could be attacking.

The cause is the search's horizon rather than its judgement. A cast is scored with `simulate`,
which stops once the stack is empty, so "+3/+3 until end of turn" reads as a creature that is
bigger *now*. The combat is past where the simulation looks, and no weight fixes that, because the
creature really is bigger.

So: **do not spend now what you can spend better later** — which is the first time the
instant/sorcery line has done real work here. An instant can wait for blockers, so it is held
unless a combat is happening or something on the stack is pointing at one of this seat's
creatures. A sorcery cannot wait past this main phase, so it is allowed precombat when there is
something to attack with, which is the Overrun line and the only reason that card is playable.

| card | before: cast / in combat / wasted | after: cast / in combat / wasted |
| --- | --- | --- |
| Giant Growth | 17 / 0 / 16 | 15 / 12 / 0 |
| Titanic Growth | 25 / 0 / 24 | 21 / 15 / 0 |
| Inspired Charge | 23 / 0 / 23 | 2 / 2 / 0 |
| Overrun (sorcery) | 23 / 0 / 23 | 22, all precombat with an attack to make |
| Selesnya Charm (pump mode) | 7 / 0 / 7 | 0 |

**It wins no more games, and that is recorded rather than buried.** Against a fixed shallow-bot
opponent over 240 paired games on two seed sets: 182-58 against 181-59, then 184-56 against
185-55 — one game either way, against a noise floor of eighteen. It is kept for two reasons that
are not win rate. A card thrown away is a card a *person* would have used, so the rule is worth
more across the table from a human than against the reference bot. And an opponent that casts
Giant Growth in its own upkeep is the most obvious way a table can feel like it is being played by
a program.

### A pod you can read on a phone

Opened the solo-pod suite's own phone screenshot — D76's rule, applied again — and a fresh
four-seat Commander pod on a 390px screen was two and a half screens tall at **turn one with
nothing on any board**. Almost all of it was empty: every seat spent two rows apiece on "no
creatures", "no lands", "empty" and "empty", sixteen of them before anybody had played a card.

The same screenshot showed the feed sitting across the mulligan prompt — three lines of *"Opponent
III mulliganed to 6"* over *"Keep this hand, or mulligan?"* — and a card sheet from the **previous**
game open over the new one.

| | before | after |
| --- | --- | --- |
| a fresh four-seat pod, on a phone | 2.51 screens | **2.23** |
| a fresh duel, on a phone | 1.37 screens | **1.18** |

An empty zone is now one line with its label inside it, and keeps its `data-testid`, so a graveyard
a player goes looking for is where it was — just not shouting about being empty. The number is
printed by the suite on every run and fails over a budget, so the next thing added to a seat has to
be paid for out of it.

What is left is almost all the opponents' face-down hands: seven identical card backs a seat, a
hundred pixels, saying only a number the seat header already shows. Worth revisiting and
deliberately not changed here — it is the tabletop metaphor, and style is the player's call.

**Three constants that should have been measurements.** The feed's offset was 104px against a bar
that is 111 on a phone; it asks the bar where it is now. An empty zone's height was two rows
because that is what a row costs. And "declared attackers" was reported for a declaration with
nothing in it, so the arena suite demanded an attack arrow after a turn where everything was
summoning-sick — a check that could only fail, taking three seconds to do it, which had been read
as the overlay's old race and waited out with more patience. Written up as D87.

### Two on one

`chooseBlocks` pairs each blocker with one attacker and marks that attacker taken, and has said so
in its own comment since it was written: *"menace needs two blockers, which this bot does not
coordinate."* The engine never had that problem — blockers are collected per attacker, menace is
enforced, and combat damage assigns lethal to each of them in order before anything tramples past.
Only the opponent could not ask the question, so a creature too big for anything on the board was
either chump-blocked by one creature that died for nothing, or waved through.

**Measured over 160 unsteered games, paired on the same seeds:**

| | before | after |
| --- | --- | --- |
| blocks with one blocker | 471 | 393 |
| blocks with two or more | 50 | **134** |
| the attacker survived the block | 235 | 171 |
| …where a second blocker was there and would have killed it | **53** | **12** |
| a blocker died and the attacker lived | 116 | 93 |

A tenth of every block the bot made had been leaving a kill on the table. Against the fixed
shallow-bot reference it is worth three games in 240, in the same direction on both seed sets —
inside the noise floor, so the table above is what this is justified by, not the win rate.

The plan is offered rather than taken: gang the most valuable attacker two or more creatures can
block, cheapest blockers first until they add up to lethal, then let the heuristic place the rest
of the blockers on the rest of the attack. Whether two creatures are worth one is answered where
every other combat question is — by playing it out.

**A rule the engine had and nothing reached, and a simplification now named.** The only test that
touched multiple blockers was the menace one, the card that makes ganging compulsory, which is
D57's warning exactly; there is an ordinary one now. Writing it surfaced this: **CR 509.2 gives
the attacking player the damage assignment order, and this engine uses the order the blocks were
declared in, which is the defending player's.** It only matters when the attacker would choose to
kill a different blocker, and nothing in this pool makes it worth a second question in the middle
of combat — so it is written down here rather than asserted as correct in a test. **That last
sentence was a guess, and it was wrong: measured four increments later it cost the attacker a kill
32 times in 160 pods, and the question is now asked. See "The attacker chooses which blocker dies"
below.**

### The creature with no choice

Every rule in this engine so far answered "may I?", and `legalActions` answered it by listing what
was allowed. "Attacks each combat if able" (CR 508.1d) answers "must I?", which a list of allowed
moves cannot say — so it is the first rule here whose job at the table is not to *offer* a move.

The engine half is a `mustAttack` continuous effect, `forcedAttackers` reading it off the board, and
a refusal in `declareAttackers` when a declaration leaves one out. It refuses rather than quietly
adding the creature: a declaration is the player's statement about their own combat, and an engine
that edits it is an engine they cannot predict. Which puts the weight on the table, because a
refusal nobody can act on is worse than no rule — press confirm, read an error, and have no idea
what to change. So the declaration now starts with the forced attackers already in it, a second tap
on one does nothing, and the bar names the card and says *"attacks each combat if able"* rather than
counting it. Re-pointing it at another player still works, which is the line the rule draws:
whether it attacks is not the attacking player's choice; who it attacks still is.

Juggernaut is the card, and it carries the other half of the pair — **"can't be blocked by Walls"**,
read off the attacker and matched against a creature *type* rather than a keyword, so a Wall of Air
stopped by it is stopped for what it is.

**Measured over 160 unsteered games**, the Juggernaut counted off the board at each of its
controller's declare-attackers steps rather than off the action:

| | |
| --- | --- |
| Juggernauts cast | 38 |
| declare-attackers steps with one on the battlefield | 63 |
| …in the declaration | 32 |
| …excused, with the engine's reason: summoning sickness | 31 |
| …excused with no reason, which would be a bug | **0** |

Thirty-one excused of sixty-three reads like a rule that half-works and is the opposite: a creature
cast this turn is not *able* to attack, so the only excuse ever given was the correct one. And for
the Wall half, asking `canBlock` about every untapped Wall a defender held while a Juggernaut was
attacking: **7 (Wall, Juggernaut) pairs across the 160 games, all 7 refused for that reason, no Wall
block declared on a Juggernaut anyway.** Thin, which is why it is unit-tested four ways — but
reached, which is more than D57's warning could say about several rules before it.

**Goad is the companion to this and is blocked, not skipped.** `EffectDuration` is `end-of-turn`,
`end-of-combat` or `permanent`, and goad lasts *until your next turn*. End-of-turn would make a goad
expire before the combat it is meant to force, so it needs a fourth duration keyed to a seat's turn
rather than to a card — a change to how effects expire, not a card to script.

### A duration that names a seat

D89 wrote goad up as blocked: it lasts *until your next turn*, and the engine's durations were
`end-of-turn`, `end-of-combat` and `permanent`. That gap is closed with one variant,
`until-controllers-next-turn`, expired in the untap step of the turn it names — the first thing a
turn does, so the effect is gone before anybody can read a board it was still changing.

It is the first duration here keyed to a *player* rather than to a moment, which is the whole
difficulty: an effect made on somebody else's turn has to outlive that turn and the ones after it,
so the expiry pass had to learn to ask whose turn has begun. Writing it also turned up
**`end-of-combat`, a duration that was declared and that nothing ever expired** — the first card to
use it would have had an effect lasting the rest of the game.

**Goad is two rules on one creature, and the second is new in kind.** "Attacks each combat if able"
is D89's requirement, checked against the declaration. "Attacks a player other than you if able"
(CR 701.38a) is checked against one attack's *aim*, which nothing had asked before — every rule
until now was about whether a creature may attack at all. "If able" is where the care goes: the
requirement lifts when the goader is the last opponent, and lifts again when every remaining
opponent has goaded the creature, since then no choice satisfies anybody. One question answers
both — is a non-goader left.

Which made three other things learn about aims, or they would have offered moves the engine
refuses: the bot's declaration builder (three of its four plans send everything at whoever has the
least life, exactly what goad forbids), `legalActions` (which now carries the defenders each
restricted creature may be sent at), and the table — where a goaded creature is pre-selected
somewhere legal, "all at them" moves everything except it, and the bar names the card and the
player it may not be sent at. A tap that silently moves an arrow reads as a bug unless the reason
is on screen.

**Measured over 160 four-seat pods and 160 duels:**

| | pods | duels |
| --- | --- | --- |
| Disrupt Decorums cast | 5 | **0** |
| creatures goaded | 9 | 0 |
| declare-steps with a goaded creature in the declaration | 8 | 0 |
| …aimed away from the goader | **8** | 0 |
| actions the engine refused | 0 | 0 |

The duel column is the fifth "spent on nothing" rule working, and its negative control is the
clearest of the five: **with the rule removed the bot cast it 10 times in those same 160 duels and
7 of the goaded creatures attacked the goader** — four mana to be attacked. Five casts in 160 pods
is thin, and is said rather than dressed up: one copy, one of four decks, four mana and a board
needed. The rule is unit-tested five ways for that reason.

**Five hand-copied lists, found on the way.** A card's options become a continuous effect in five
places, and each copied the subset it knew about: `pump` had no `mustAttack`, `staticEffect` had
neither that nor `preventsCombatDamage` (and an Equipment's bonus goes through it), the aura builder
had four of ten, and the statics builder had no `cantAttack` — so a card whose printed static was
"this creature can't attack" would have done nothing. No card in the pool was wrong; the next one
would have been. One translator now, with a test that every option in is every flag out.

**And the realtime flake, named and measured.** "Plays a whole game on its own against the server"
failed once weeks ago, never reproduced, and failed again here — this time the instrument added
earlier said why: *stopped after 400 moves on turn 48*. Each pod seeds its shuffle from an id
carrying a timestamp, so every run is a different game, and that test's client casts nothing: the
game is the bot grinding a do-nothing opponent from twenty to zero. Over 200 random shuffles with
the same decks and the same loop: **median 137 moves, p99 307, longest 488, and one game in two
hundred over 400.** The cap was 400. Nothing was flaky but the shuffle; it is 1200 now, with the
measurement beside it.

### Whose trigger goes first

Two rules cover simultaneous triggers: the active player puts theirs on the stack first so they
resolve last (CR 603.3b), and a player holding more than one of their own chooses the order. The
engine did neither — it walked the seats by index, which is APNAP only when the active player
happens to hold the lowest seat number.

**Measured over 60 four-seat pods**, counting every action that put more than one trigger on the
stack: **131 batches, 33 of them belonging to more than one player, and 2 of those ordered
wrongly.** Not dramatic, but the kind of thing that decides one game in thirty and leaves no trace.
The fix is an ordering rather than a special case, and the re-measurement is 0 of 33.

**The player's own choice is not built, and the same measurement is why.** 111 batches had one
player holding two or more triggers, but only 20 where those were *different* abilities — and of
those, 7 included a trigger with a target, which is the only way two of your own triggers can
interact: one resolving first and removing what the other is aimed at. In all seven the companion
was "you gain 1 life" or "1 damage to each opponent", neither of which removes a creature. **No
reordering available in those 60 pods could have changed the outcome**, so the order is written
down as a simplification — battlefield order, nobody asked — rather than paid for with a prompt
once every three games. When a card does make it matter, the measurement says how: prompt only for
two triggers with *different* descriptions, which never fires on the 33-trigger Hellrider batch a
naive version would put in front of a player.

### Stops are one player's preference

The toggle's tooltip said *"Skipping priority when you have nothing to do"* — "you", singular — and
it was not true. `autoPass` was a single boolean on the game, so pressing it turned auto-pass off
for the other player too, who was then asked twenty-five times a turn to confirm they still had
nothing to do, about a setting they never touched.

It is a list of the seats that asked for every priority now, read through one `autoPassFor` by its
three callers: the auto-pass loop, the per-seat view, and the toggle by way of that view. No UI
changed — the view's `autoPass` means "mine", which is what the button had always claimed.

A list rather than a map or a second boolean, for the reason the bug exists: a list of who opted
out has one reading and one default, where a per-seat map would carry three states for a two-state
setting and a table-wide boolean beside a per-seat one would be two sources of truth for the same
question. It also reads correctly out of a game stored before the field existed — absent means
everybody auto-passes, which is the default that state had.

**The test that could not be written before.** With it off for seat 1 and on for seat 0, seat 0
playing a land stops play on seat 1 in the same step, and seat 1 passing then walks the rest of the
turn without asking seat 0 anything. The old test asserted the opposite — *"with it off, the other
seat is offered priority even with nothing to do"* — which was the bug written down as the
specification. Each seat's setting survives a rematch too, the other place one boolean would have
handed a preference to the wrong player.

And the claim is checked where the player is: the arena suite presses the toggle in one browser and
reads the switch in the other. Computed table-wide instead, the other player's switch flips as
well, and the suite says so.

### The attacker chooses which blocker dies

CR 509.2 gives the attacking player the order a blocked creature's damage is assigned in. The
engine spent the attacker's power down each attack's `blockers` list, which is the order the blocks
were *declared* in — the defending player's. D88 named that a simplification and said nothing in
the pool made it matter enough to ask about. That was a guess.

**Over 160 four-seat pods: 276 attacks blocked by two or more creatures, reordering changed how
many died in 54, and in 32 of those the declared order cost the attacker a kill** — 35 kills in
total, about one lost every five games. And the count understates it, because *which* creature dies
changes far more often than how many: a 5/5 into a 2/2 and a 4/4 kills one of them either way, and
which one is the whole decision.

So it is asked, as a third turn-based action beside declaring attackers and declaring blockers —
`pendingDeclaration` is where those live, which is what withholds priority until it is answered.
One action settles every attack that needed one. And only when it can change something: two or more
blockers, and power enough to kill some but not all. That brings **276 multi-blocks down to 144
askings, about one a game.**

Nothing changed in the damage step. It already spent power down the list in order, so the rule
needed somebody to *ask*, not new code to apply it: the answer rewrites the list.

The bot gets the choice too, and the search was already the right shape — three candidate orders
per attack (as declared, cheapest first, most valuable first), each played through the combat the
way attacks and blocks already are. With the rule live over 160 pods: **asked 144 times, kept the
order 83 and reordered 61; of those 8 killed more blockers and 43 killed better ones**, with no
refusals.

**One gap, named rather than papered over.** No browser suite reached the prompt: the engine only
asks when a creature is blocked by two or more, and the driver — now taught to put two blockers on
one attacker when it can — never had two creatures able to block in five full runs. The interaction
has five reducer tests and the rule four engine tests, and the driver answers the prompt if a game
produces one, but no browser has yet watched a person tap two blockers into order.

### The cards nobody ever casts

A card in a deck that never gets played is three different problems wearing one face: the deck does
not want it, the bot cannot use it, or the engine will not let it be cast. Nothing here would have
noticed any of them — `scripts.test.ts` proves every card *can* be cast, which is a different claim
from "it ever is".

So every deck was played against every other, both seat orders: **252 games, 72 for each of the
seven decks**, with every cast, land and activation attributed to its card, and every card ever
seen in a hand recorded separately so "never drawn" could be told from "drawn and never cast".

**Every card in all seven decks gets cast or activated, with two exceptions, and both are rules
working rather than cards failing.** Disrupt Decorum was drawn 23 times and cast none: it is goad,
this measurement is all duels, and the rule that keeps the bot from goading in a duel is doing its
job (5 casts in 160 four-seat pods). Inspired Charge was cast twice in 72 games, which is the pump
rule holding a card that is only right in a precombat main with a wide board.

One thing it did surface, recorded rather than fixed: Forge Alliance now carries a card nobody
should cast in a duel. That is one dead slot in sixty as a duel deck and a live one in a pod, and
there is no pod-only deck to move it to — the alternative was keeping goad out of the pool, which
costs more than the slot.

### A replacement effect from across the table

The project's own biggest named gap, closed in the smallest honest way. Two replacement effects were
already here — regeneration and "enters the battlefield tapped" — and both got away with being a
shield on the card they affect, because that is where they are printed. "If a nontoken creature an
opponent controls would die, exile it instead" cannot: it is written on a vampire across the table
from the creature it is talking about, so there has to be a *pass* that asks every permanent on the
board whether it wants to replace what is about to happen.

**Where that pass lives is the whole design, and the engine had already answered it once.** `relocate`
is the one place a card changes zone, and it *records* what happened rather than announcing it, so
`settle` holds the single list of what just died — and `settle` is where "enters tapped" is already
applied, with a comment saying it is as close to a replacement as a state the engine computes in
one action can be. The death replacement went in beside it, which is why the dying permanent touches
its graveyard for the length of one function call.

What that costs is said rather than glossed: a true replacement means the card was never in the
graveyard at all, and the only thing that could tell the difference is something reading a graveyard
*between* the move and the pass. Nothing does — the death event is raised after, so a replaced death
is correctly not a death and triggers nothing. A card that counted creature cards in graveyards as
it resolved would be the one to break it, and the reason to move this upstream into `relocate`.

**`replaces` is a predicate, not a scope enum**, for the reason `TargetSpec.filter` is: every printed
version of this words it differently — an opponent's, a nontoken one, a creature rather than a
permanent — and an enum would be either short of what the next card needs or carrying values no card
uses, which is D57's warning.

Kalitas, Traitor of Ghet is the card, and it is the plainest possible test of the pass because it
hits every way a creature can die: lethal damage in combat, a Doom Blade, and a sacrifice paid as an
ability cost. All three reach it, and the sharpest test is the Blood Artist one — **a replaced death
is not a death, so nothing that watches for a creature dying may see it.** If the drain happens, the
engine has implemented a trigger wearing a replacement's name.

**And it says what it did.** A replaced death raises no event, so nothing logs it: without a note the
card works invisibly, and a creature dies to a Doom Blade and turns up in exile with a Zombie beside
it for no reason on screen. Replacements are recorded the way deaths are and drained onto the
message of the action that provoked them.

**Measured over 60 four-seat pods:** Kalitas cast 19 times, 1155 creature deaths, and **48 creatures
exiled while an opposing Kalitas was out** against 76 exiled by the pool's other exile effects — so
the pass fires about two and a half times a game it is in, with no action refused.

### What two hundred pods say

Five rules went into combat and the stack in quick succession — forced attacks, goad, APNAP trigger
order, the damage assignment order and a death replacement — each with its own tests and its own
measurement. None of them answers whether the engine, with all five in it, plays hundreds of games
to the end without getting stuck.

**200 unsteered four-seat pods, all seven decks: 200 reached a winner.** No action refused, no
action that changed nothing, no game over the 400-turn cap, no moment with nobody to act. Median 52
turns, p90 77, longest 122. 89,188 bot decisions at a mean of 7.6ms.

The number worth looking at is the slowest single decision: **2011ms**, which is the shape of the
bug D71 was about. Measured over a second soak of 60 pods and 27,261 decisions: **p50 2.0ms, p99
65ms, p99.9 173ms, 96 over 100ms, six over 250ms, none at all over 500ms.** So the two-second
outlier is about one decision in ninety thousand, on turn 39 of a long game, and the ordinary
experience of playing this bot is a reply in two milliseconds. Recorded rather than chased: a tail
that thin is not a performance problem, and if it thickens, this is the number it thickened from.

**And the damage order, seen in a browser.** D93 named the gap — no suite reached the prompt. The
arena suite was instrumented rather than guessed about: over a whole run it declared blocks *once*,
with two cards in the defender's row. So a two-browser duel cannot get there; the game never builds
the board. The solo-pod suite can, because the player attacks into three bots that gang up, and in
one run of three it happened: the driver tapped the blockers in order and the engine took it. The
suite records it and reports it when it happens, with a line saying why not when it does not —
sampled rather than required, the way the scry and the library search already are.

### Protection, and three cards' abilities that were never there

Protection from a colour (CR 702.16) is the only keyword in Magic that is four rules at once: a
creature with protection from black cannot be **d**amaged, **e**nchanted or equipped, **b**locked,
or **t**argeted by anything black. Three of the four were a line each, in the place that already
answers that question — target legality, `canBlock`, `equipTo`.

**The damage one cost something, and what it cost is the interesting part.** Protection is a fact
about the *source*, and `dealDamage` did not know what had dealt the damage: twenty-one call sites,
none of them saying. So `source` is now a **required** option — `string | null`, where null is the
honest answer for damage with no source a colour can be read from. Required rather than optional
because an optional one is a silent hole: a site that forgot it would quietly let protection fail,
and nothing would say so. Making it required turned the question into twenty-one compile errors,
each answered where the caller already had the answer in hand.

Paladin en-Vec is the card — protection from black and from red, which in this pool is most of the
removal. A Lightning Bolt and an Agonizing Demise both bounce off it, neither a black nor a red
creature can block it, and a 3/3 red creature it blocks deals it nothing. Each of the four rules is
tested on its own, and three of them fail with the shared check short-circuited. The fourth —
equipping — is correct and unreachable: every Equipment in the pool is colourless, so what is
asserted is the fact it rests on, and the gap is named rather than hidden.

**And the bug it uncovered, which was worth more than the keyword.** The Paladin's protection did
not work in a test board, for the same reason a Fog Bank's and a Juggernaut's had not: **static
abilities were installed where a permanent *spell* resolved**, which is one of several ways onto the
battlefield. A reanimated Fog Bank prevented no damage. A Juggernaut put onto the battlefield by an
effect did not have to attack. A board laid out by hand — which is the whole tabletop half of this
app, and how every test here builds a board — had no abilities at all. The trap caught three cards
in a row and was read each time as a quirk of the test helper.

It is fixed where everything else of this shape is fixed: arrivals are *detected* rather than
announced, so the arrivals pass in `settle` is the one place that sees every way onto the
battlefield, and that is where statics are installed now. The engine taking over a table does the
same for whatever is already in play — which is what a handover from the tabletop half means.

### The block it was never shown

Whether the opponent ever lets itself die with blockers up. It did, once in 120 duels, and finding
that one took three instruments — two of which were wrong before the engine was.

The first one did the arithmetic: power faced against life, minus what the chosen blocks absorb. It
reported eleven mistakes and **every one of them was false.** The position it flagged most often had
a Blood Artist in the attack, so each blocker that died drained the blocking player — the "better"
block killed its own controller. Arithmetic cannot see a trigger. Rewritten to play each candidate
block out through the engine and ask only whether the seat was still alive at the end, it found one
real mistake: a seat on four life blocking a 1/1 and a 4/4 while a 3/3 went past, where blocking the
3/3 and the 4/4 lived. The 1/1 was an Elvish Visionary, priced above a Centaur Courser because it
draws a card.

The cause was not a weight. `blockPlans` already built an alternative to the heuristic's block and
already offered it to the search — but only when that alternative had *more* blocks in it. The
heuristic had already blocked two attackers, so the plan that blocked the two *right* ones was the
same size, and the search never saw it. There is now a second spread ordered by power rather than
value, offered when it is *different* rather than when it is longer, and a test that sets the board
up by hand: a seat on three life with one 3/3 blocker, facing a 3/3 and a 1/1, blocks the 3/3 and
ends the turn on two life.

It is offered only when the attack is actually lethal, because the unconditional version cost too
much: over 60 pods, decisions above half a second went from 1 to 19 and the slowest from 604ms to
two and a half seconds — the pod-stall bug beginning to come back, for a mistake that costs one game
in 120. Confined to the lethal attack it costs 28.12ms → 28.54ms on the mean block decision.

**The measurement lesson is the part worth keeping.** That tail comparison was the second wrong
instrument. Baselines taken at two adjacent commits with no behaviour change gave `over500` of 0 and
1, so 19 was outside the noise and the direction was real — but the games diverge the moment
behaviour changes, so a slow position in one run may simply not exist in the other, and the
magnitude is not readable. A tail says whether; it cannot say how much. The mean per decision kind
can, because every run has thousands of each kind. The paired win rate against the fixed shallow
reference moved 148-92 → 150-90 and 149-91 → 150-90 on the two seed sets, both inside the documented
18-game noise floor, so the case for the change is the death that no longer happens rather than the
win rate — which is written down that way rather than rounded up.

### A shield with a number on it

The last named gap in prevention. A Fog is all-or-nothing for a turn; "prevent the next 3 damage" is
an amount that whatever damage arrives spends a point at a time. Two cards carry it — **Samite
Healer**, which taps for one damage a turn for ever, and **Healing Salve**, one mana for three life
or three damage that never happens — and between them they needed three things the blanket version
had deliberately refused: an effect that is rewritten as it absorbs, one that covers a burn spell as
well as a combat, and one that can sit on a *player*, which is the first effect scope here that
names a seat.

It all happens in `dealDamage`, before anything is marked, which is the rule and not tidiness:
damage that was prevented was never dealt, so it reduces no life, marks no creature, counts towards
no commander's twenty-one, marks no deathtouch and gains no life for a lifelink source. Four of the
five tests fail with the spend removed.

**The table is told.** A shield is not a counter, not a keyword, and the card that made it is in a
graveyard — three points that will quietly not happen, with nothing on the board to say so. The view
now carries it on the permanent and on the seat, and the board shows "prevents 3". It is public, for
the same reason it is public at a real table: a block made against a shield the attacker could not
see would be the table lying to them instead of to the defender.

**Two bot rules, each with its control run red.** The Healer's ability taps it, so it is the first
card whose cost is a blocker — and the search cannot see that cost, because one move out a tapped
1/1 and an untapped one score the same. So it waits for the blocks: 113 activations in 240 duels,
every one in the declare-blockers step, against 45 in 60 duels all in declare-attackers without the
rule. And the bot's default aim is the enemy, which for a shield is the one aim that makes the card
do nothing at all: 113 of 113 aimed at itself with `friendly` on the target spec, 26 of 27 aimed at
the opponent without it.

**And the card is weak, which the measurement said three times.** Skyward Writ beats the pool
164-76 and 153-87 over 240 paired duels; the pair costs it about five per cent however the slot is
paid for, and which cards come out matters less than the seed sets differ from each other. It is
carried anyway for two reasons, both written down in full in `claude/decisions-log.md`: without it
the pool has no card that reaches this rule at all, and the measurement is of the bot, which takes
one point a turn and — 72 casts out of 72 — always takes the Salve's three life over its shield,
because three life is worth something to `evaluate` and a shield is worth nothing it can see. A
player who shields the blocker about to die gets a card the instrument cannot score. (Why it does is not what this entry guessed: see "A shield is worth the life it saves, and that
changes nothing" below.)

### The aim the search was never shown

A comment in the bot has said for months that a pump spell gets aimed at an enemy creature —
"legal, and wasteful" — and that fixing it would need the bot to read what a card does. It needed
one line of the opposite: the search had to be handed the other aim.

Counted over 60 duels, the waste is three casts: Giant Growth twice, Titanic Growth once. Smaller
than the comment implies, because most helping cards in this pool already restrict their targets
with a filter and the engine offers nothing else. What keeps the last three alive is sharper than a
missing weight. `aimings` offers the search up to three ways of aiming a spell — the heuristic's
pick plus the top of the enemy-first ranking — and on a board with three enemy creatures the top of
that ranking *is* three enemy creatures. The bot's own side was never in the list, so the search
could not throw out an aim it had never been handed. It would have thrown it out at once: pumping
their creature raises their side of the evaluation and lowers its own.

The alternatives now come from both orderings — the best two enemy-first and the best one own-side —
and misaimed helping spells went 3 → 0 over the same duels. The paired reference win rate did not
move (150-90 → 149-91, 150-90 → 147-93, both inside the noise floor), and a 200-pod soak finished
all 200 with the mean per decision slightly *down*, so the fourth option costs nothing measurable.

**And a wart it did not cause.** The same count says the bot points removal at its own creatures a
handful of times per 60 duels — four Swords to Plowshares, three Murders, a Doom Blade — with the
same figures before and after, so it is older than this change. A Swords on your own creature gains
you its power in life and the evaluation can see that; the rest are probably mistakes. Written down
with a number rather than guessed at.

### An eighth deck, and a win condition the rules already enforced

**Hollow Tide** is blue-black, and the first deck in the pool that never looks at your life total.
It wins by emptying your library — which the engine has enforced as a loss since state-based actions
were written (CR 704.5b), which `mill` has been able to cause for just as long, and which nothing
had ever tried to do on purpose. Building the deck that does found three things wrong.

**The loss said the wrong thing.** A seat that decked out was eliminated with reason `life`, so the
table printed "out (life)" beside a life total of nineteen. `EliminatedReason` had no case for an
empty library because nothing had ever produced one; it does now, and the table says "out (empty
library)" instead of echoing a field name — which also fixed "out (commanderDamage)", wrong on
screen since commander damage went in.

**The most-printed trigger in Magic was missing.** "Whenever this deals combat damage to a player"
is on hundreds of cards and on none of ours. It is recorded in `dealCombatDamage` and announced by
`settle`, beside the deaths and the arrivals — recorded rather than compared, which is the one
departure from the house pattern and a forced one: a life total going down does not say which
creature took it there. It fires only when the damage actually landed, so a Magpie stopped by a Fog,
a prevention shield or protection draws nothing, and the seat that was hit travels with it through
the same channel an attack trigger already uses.

**And the bot could not see the win.** `evaluate` counted life, hand, board and loyalty; a library
was worth nothing, so milling seven cards was a card spent for no change in the score — and the
search declined, correctly by its own lights. Over 56 duels the deck won 37 games and *not one of
them by milling*: it won by beating down with Magpies, which is not the deck. One weight fixes it
(a card in a library is worth 0.3, linear, counted like life, so a sixty-card library is worth about
a twenty-point life total): the same 56 duels become 38 wins with **24 of them by decking the
opponent out**, and the other seven decks lose nothing measurable — the paired reference win rate
moved 149-91 → 153-87 and 147-93 → 147-93, inside the noise floor.

Nine new cards, with the rest of the deck drawn from what the pool already had: Mirko Vosk as the
commander (a 2/4 flier that mills until the fourth land turns up — a loop rather than a number,
because the variance is the card), Thieving Magpie, Mind Sculpt, Thought Scour, Compelling Argument
(mill with cycling, so a hand of mill against a board that is killing you has an out), Returned
Centaur, Nemesis of Reason (ten cards a swing, blocked or not), Psychic Strike (a Counterspell that
mills the *spell's* controller, read off the stack rather than assumed to be the only opponent) and
Jace, Memory Adept. The dead-card audit over every pairing says every card in the deck gets cast,
and a 200-pod soak with eight decks finished all 200 with nothing refused and nothing stalled.

### The layers, and the two cards that needed them

`characteristicsOf` made one pass — printed values, every effect summed, then counters — and its
own comment said why that would not last: "an effect that *sets* power would not be" right under it.
Two cards now set one, and the function runs the layers in order instead.

The difference is not a detail. A +3/+3 and a -1/-1 can be summed in any order; "becomes 1/1"
replaces the base that modifications then apply to, *by layer rather than by timestamp* (CR 613.4c),
so a Giant Growth cast before a Turn to Frog leaves a 4/4. "Loses all abilities" is the opposite
case: there the timestamp *is* the rule, and what it took away stays gone while anything granted
after it survives (CR 613.1f) — which falls out of clearing inside the loop rather than at the end.
And a copy needs no layer at all, because a copy copies the *printed* card: the engine makes one by
pointing the new permanent at the copied card's definition, and the token's abilities and statics
then arrive by themselves.

**Turn to Frog** ({1}{U}) turns a 6/6 flying trampler into a 1/1 with nothing until end of turn —
removal that leaves the body behind. **Cackling Counterpart** ({1}{U}{U}) makes a token copy of your
own best creature, printed values only: copying a Fog Bank under two +1/+1 counters and a +3/+3
gives a 0/2 that prevents damage. Five tests, each about a layer boundary rather than a card, and
two control runs red — one with setting treated as a modification (four tests fail), one with "loses
all abilities" applied at the end (the grant-after test fails).

They went into Tidal Mind for a Tome Scour and the second Preordain, measured at 81-159 → 82-158
and 80-160 → 82-158 over 240 paired duels on two seed sets: one and two games, which is as close to
"no effect" as the instrument reports and the honest reading of two cards in a sixty. (The first
version of the slot cut a Wind Drake, which left that card in no deck at all — caught by the
orphaned-script check, and the reason the cut moved rather than the measurement.) Three layers
remain named rather than faked — type-changing, colour-changing and characteristic-defining
abilities — and a card needing one is still not scriptable rather than approximated.

### A question about the whole table, and the Clone that asks it

Every mid-resolution question the engine could ask looked in one of the chooser's own zones — your
library, your hand, your graveyard, your battlefield. "Any creature on the battlefield" is a
question about the *table*, and until now that made Clone and everything printed like it
unscriptable. `DecisionZone` has `any-battlefield`, and it is a zone rather than a flag because the
candidate list is also the authorisation the answer is checked against: one place, so a question
that looked at one battlefield and took an answer from another cannot happen.

The copy itself needed almost nothing. A spell's script runs *before* the permanent moves, so a
Clone that points its own instance at the copied card's definition **enters** as the copy — the
arrivals pass installs the copied card's statics, raises its entry trigger, and `scriptFor` gives it
its abilities, because what gives a permanent its abilities here is the name on it. The one piece of
new state is `printedDefKey`, and the one new rule is that `relocate` puts the printed card back
when the permanent leaves the battlefield: a Clone that copied a Shivan Dragon is a Clone in the
graveyard, which is what Zombify brings back.

It also needed the **sixth** "spent on nothing" rule, and for the most literal waste yet: a Clone
cast with an empty battlefield is a 0/0 that dies as it arrives. Over 24 duels the search mostly saw
that for itself — nine casts, eight with something to copy — and the one that was not is the
auto-pass trap, so the board is asked instead of the state after. Eight casts after, none into
nothing.

**It is also the best deck change measured this session.** Clone cost Tidal Mind its second Cancel:
82-158 → 101-139 and 82-158 → 94-146 over 240 paired duels on two seed sets, nineteen and twelve
games in the same direction, the first above the noise floor. In a deck with four counterspells and
four removal spells the best creature on the table is usually the opponent's, and copying it is
removal that leaves you the creature.

And two tests that had quietly stopped being true, both failing here and neither this increment's
fault: "does not throw creatures away" counted dead attackers *per game*, which grows with the deck
list rather than with the policy (it is a rate now — 9.4% of attackers, against 13.7% for the policy
it replaced), and "answers the questions cards ask mid-resolution" needed a one-of Diabolic Tutor to
turn up in twelve specific games, which after a two-card deck change it did not. It plays
twenty-four now.

### The removal with nothing to remove

An earlier entry counted the bot pointing removal at its own creatures and left the judgement open.
Judging it took the instrument from the block work — finish the game twice from the same position,
once with the aim it chose and once with the best aim it had — and the answer was not what the count
suggested. **Six of the seven cases had nothing else to kill at all**: a Doom Blade on its own
Talrand, a Pacifism on its own Serra Angel, a Swords on its own Soul Warden, with the opponent's
board empty, so its own side was the only legal target left. The seventh was a choice — Agonizing
Demise on its own Goblin Arsonist, whose death pings something — and played out it changed nothing.

So the fix is the seventh "spent on nothing" rule rather than an aiming fix: a card whose whole
effect is to remove a creature is not cast unless there is a creature the caster does not control.
Ten cards carry the flag; three that look like removal do not, and the reasons are the cards —
a Lightning Bolt can hit a player, a Man-o'-War is a body, and an Unsummon on your own creature is a
trick that saves it. Afterwards: two self-aimed casts in the same duels, both deliberate, and one of
them won its game.

The paired reference win rate moved 151-89 → 155-85 and 146-94 → 152-88, both inside the noise
floor, so the case is the cards it stops throwing away rather than the rate. The dead-card audit is
unchanged, which is where a rule that went too far would show first.

### A shield is worth the life it saves, and that changes nothing

An earlier entry said the bot never takes Healing Salve's shield half because the evaluation cannot
see a shield at all — three life against nothing. That was wrong, and two weights were written and
taken back out again to find out.

A point of prevention on a player *is* a point of life, so the evaluation counted it as one. Paired
over 60 duels on the same seeds: 44-16 before, 44-16 after, every tally identical — same casts, same
activations, same aims. Then the aiming: a helping spell could only ever be aimed at a life total,
because the own-side ordering puts the player first, so the alternatives grew an own-creature entry.
No change either.

The instrument then said why. The shield half was **offered 22 times in those 60 duels, exactly as
often as the life half, and chosen zero times**. With the weight in, the two halves score the same
number and the tie-break keeps the printed order; with it out, the life wins outright. And for a
player the life is the better half anyway: three prevented is three saved this turn, three life is
three saved for the rest of the game.

What makes prevention better is beyond the search's horizon — a shield on a blocker that would
otherwise die, or one kept for a burn spell — and `simulate` stops when the stack empties, so the
creature that survives because of a shield is not in the position being scored. No weight fixes a
horizon. Both terms are gone, the evaluation keeps six honest weights instead of eight decorative
ones, and the finding is in `claude/decisions-log.md` (D108): the Salve's halves are worth the same
to this bot, and taking the life is a defensible play rather than a bug.

### A deal at the table, and a table that remembers it

The pod could read the board and could not say a word to it. Threat reads, goad, one press to send
the whole swing at one player — all facts about creatures — and the thing players actually say to
each other had nowhere to live but the chat panel, where it scrolls away.

Deals are state now. Three fixed wordings, offered by one seat to another: a truce until the asked
player's next turn, or not attacking them this turn or next. They are offered from a sheet on the
bottom bar, answered by **Agree** or **No deal** in the words the log will use, shown as a badge on
both seat strips while they last, and sent to everybody at the table — the only unredacted part of
the state, because a deal struck out loud is heard by the other two players and that is most of what
makes it mean anything.

**Nothing enforces one.** An attack on somebody you promised not to attack is declared, the attack's
own log line says it broke a deal, and that seat's strip says **broke a deal** for the rest of the
game. A table where the software stops you breaking your word is a table where your word costs
nothing; the pressure at a pod is the other players, and all a program owes them is the record.

The opponent answers deals and never offers one. It takes a deal unless the player offering it is
dead on the board already, and keeping its word is a filter over every attack plan rather than one
option in the search — a deal weighed against half a point of board advantage is a deal nobody can
rely on. Over 30 pods with a truce going on the table every third turn, same seeds both arms: **0 of
672 attack declarations broke a live deal, against 161 of 753 with the filter off.** The one
exception is the rules' own: with two Juggernaut decks at the table 10 of 882 declarations broke a
deal, and all 10 were creatures that attack each combat if able with nobody else legal to attack —
the engine refuses the declaration that leaves one at home, so the promise goes and the log says so.
Deals cost the table attacks and time, which is the point: 672 declarations against 724 with no
deals, and 24 of 30 games finished inside the move budget against 28. The full write-up is D109.

What is still only the chat panel's: anything said beyond those three sentences, and any record of
who was on whose side. Three preset deals is not a conversation; it is the part of one that can be
pointed at three turns later.

### The reply, built and measured

Three entries above end at the same wall: the search plays every line out against an opponent who
does nothing, so a removal spell always resolves and an attack is never answered. The pump, the
ritual and the shield were each solved by asking the board a question instead, and each write-up
says the real fix is the reply. So it was built — each other seat gets priority once per simulated
line and takes its best answer, chosen greedily and scored from its own side, gated on there being
something to answer and the mana to answer it with.

It works. Over 240 paired duels an answer was taken 398 times, and the list reads like a player's
hand: Negate 67, Titanic Growth 67, Counterspell 40, Turn to Frog 37, Maze of Ith 12. It changes
decisions, including the one three entries have asked for — a Serra Angel against two untapped
Swamps and a Doom Blade is **not attacked with** by the bot that can see the answer coming, and is
attacked with by the bot that cannot.

And it wins nothing. 120-120 over 240 paired duels on identical seeds with the sides swapped, after
121-119 for two earlier versions, against an 18-game noise floor — at a quarter more time per
decision in a pod (10.39ms against 8.40ms mean, worst case 3.0s against 2.5s). So it is reverted,
and the finding is D110: this is the third time depth has been measured at zero here, and the
evaluation is the limit rather than the depth.

The write-up also records the reason it should not be kept even if it had won. `botAction` takes the
whole game state, so the reply reads the opponent's *hand*: a bot that declines to attack because of
the exact card you are holding is a cheating opponent rather than a better one. An honest version
has to reason from the same redacted view a person gets, plus a model of what the deck could hold —
which is a different piece of work from a deeper search, and the one that is actually missing.

### A land that becomes a creature, and the three ways the bot wasted it

Layers 4 and 5 of CR 613 — type-changing and colour-changing — were the last two named as not built.
Mutavault needs the first ({1}: becomes a 2/2 creature until end of turn, and is still a land) and
Crimson Wisps the second ({R}: haste, becomes red, draw a card).

Layer 4 is the one that changed the shape of `characteristicsOf`, which makes two passes now: what a
permanent *is* decides which other effects apply to it, so an animated land has to be a creature
before an anthem's scope is judged (613.1c before 613.1g). The test that pins it is an anthem over an
animated land — a 3/3 with the layers, a 2/2 without. Layer 5 found a bug in shipped code: protection
read the *printed* colours of a damage source, which was right for exactly as long as nothing could
change one.

Then the deck measurement said the cards were a disaster: ember-rush with one Mountain and one
Firebrand Archer swapped out went **183-53 → 156-81 and 181-55 → 155-82** over 238 games per arm on
two seed sets. The instrument said why, and it was not the cards: in 56 games the bot **animated the
Mutavault 854 times and attacked with it zero times.** Three failures, each needing its own fix — the
moment (animating in postcombat main, where it buys nothing: the eighth "spent on nothing" rule), the
payment (the cost solver tapped the Mutavault to animate the Mutavault, so the 2/2 was always
tapped), and the repeat (with the first animation on the stack the board looks untouched, so it
animated again until the mana ran out). Afterwards: 45 animations, 37 attacks, and the deck measures
**189-48 and 177-60** — six up, four down, both inside the noise floor, which is what a two-card
change in a sixty should look like. D111 has the detail.

The table needed nothing: the view sends power and toughness exactly when the engine says the
permanent is a creature, so an animated land moves into the creature row and draws its own arrow.

### The last layer, and a creature that is as big as the graveyards

Characteristic-defining abilities (CR 613, layer 7a) were the last layer this engine had named and
not built. Lhurgoyf needs one — power equal to the creature cards in every graveyard, toughness that
plus one — and with it every layer the cards in this pool use is in.

A CDA is unlike everything else in `characteristicsOf`: nothing resolves. There is no moment at
which the number is decided, so there is nothing to store and nothing to invalidate — something dies
anywhere and it is bigger, a graveyard is exiled and it is smaller, with no event anywhere. It is
counted fresh on every read. The count is *declared* rather than carried as a function, because the
game state is written to Redis and sent down a socket, and it names exactly one count — the one the
card needs — rather than three that nothing would ever run (D57).

The ordering is the rest of it, and each boundary has a test: a setting effect beats it (a Turn to
Frog on a Lhurgoyf is a 1/1 however full the graveyards are), modifying and counters land on top,
and a Clone of it copies the *ability* rather than the number, so both of them shrink together.

It went into Rot Harvest for the second Hurricane, and it is live rather than decorative: 12 casts in
42 games, attacking at a mean power of 4.3 and a maximum of 8, with the deck's paired record moving
**104-132 → 107-131 and 93-144 → 103-135** — three and ten games up, both inside the noise floor.
D112 has the detail, and what is left of CR 613 with it.

### Flashback, and the second zone a spell is cast from

An earlier entry said of Cackling Counterpart that the printed card's flashback was out of reach
because "casting from a graveyard is a mechanism, not a cost". The mechanism is in.

The cost half is the easy half: flashback *replaces* the printed cost rather than adding to it. The
half that matters is the zone — a card with flashback is cast from its owner's graveyard, so the
graveyard is now the second zone a spell is ever cast from, and it went in beside the hand and the
command zone as a third list in `legalActions`, filtered to cards that actually have a flashback
cost. The other half of the card is the end of it: "exile it instead of putting it anywhere else",
and *anywhere else* is load-bearing — a spell leaves the stack three ways here, and all three now go
through one function rather than deciding for themselves. The test that would have caught the miss
is a Counterspell answering a flashback casting; the card is still exiled.

Three cards, one per shape: Cackling Counterpart (both halves now), Think Twice (a cantrip whose
point is the second casting) and Firebolt (the sorcery that proves flashback did not make a sorcery
castable at instant speed). The bot needed nothing taught — over 48 duels it cast Firebolt 8 times
and flashed it back 8, the Counterpart 4 and 4, Think Twice 11 and 10 — and the table needed one
line: the graveyard row says "playable" now, which it never had reason to before.

The slots were a wash: 45-193 → 45-193 and 64-174 → 63-175 for Tidal Mind, 108-130 → 114-124 and
100-138 → 103-135 for Ashen Rite, over 238 games per arm on two seed sets. D113 has the detail — and
one number that is not about flashback: Tidal Mind wins about a fifth of its games against the rest
of the pool, where Ember Rush wins three quarters. That is a balance problem rather than a card
problem, and it is the next thing worth measuring.

### What each deck is worth, and the deck that had no way to win

Eight decks, every pairing, both seats, 168 games each. Before this pass the pool ran from Ember
Rush at 80% to Tidal Mind at 25%, and Ember Rush beat Tidal Mind 23-1.

The useful part was measuring the *deck* before measuring a change. A new harness asks, for every
one of a list's sixty slots, how often the bot casts it as a share of the games it reached hand —
and the answer for Tidal Mind was that nothing is dead. Its least-cast spell is Diabolic Tutor at
35%; the counterspells it was supposedly wasting are at 92% and above. Ember Rush at 80% has the
same shape, and so do Ashen Rite and Rot Harvest. **Four decks spanning fifty-five points of win
rate, and not one dead card between them.** Whatever explains a deck's record here, it is not cards
the bot refuses to cast.

What did explain it came out of the per-opponent split. Trading counterspell copies for cheap
creatures is worth *nothing at all* against the two fastest decks — 3-31 against Ember Rush before
and 4-30 after — and five to ten games each against every slower one, including beating Skyward
Writ where it used to lose 8-26. The hypothesis going in had been "six counterspells cannot answer
eighteen one-drops", which predicts exactly the opposite shape. The deck's fault was not that it
could not survive; it was that it had no way to win the games it survived.

So Tidal Mind is on three counterspells rather than six, paying for a second Fog Bank, a second
Vampire Nighthawk and a third Man-o'-War: +31 and +25 over 238 games on two seed sets, confirmed
out of sample on a third at 25% → 36%. The pool now runs 36% to 78% rather than 25% to 80%, and the
floor is shared rather than an outlier. Cutting deeper measures better still and is deliberately not
shipped — it would mean deleting Counterspell while keeping Cancel, which costs a mana more for the
same text, and two of the remaining counterspells are the pool's only copies of their cards.

The first change tried was the obvious one, and it is in the log as nothing: two three-mana answers
for two cheap blockers, +4 and +10 on 238 games, both inside the noise floor. Same direction twice
is not a measurement.

Three harnesses moved into `scripts/measure/` with a README that states the noise floor and the two
seed sets. They had lived in a scratch directory, which means every number this document has quoted
up to here was produced by a tool nobody could re-run.

### Ward, and the three places a token that does not exist still had to be found

Ward was the last evergreen keyword the engine did not have, and it could not be a keyword at all: a
keyword with a cost in it is not a flag. It is shorthand for a triggered ability — *whenever this
becomes the target of a spell or ability an opponent controls, counter it unless that player pays* —
so it went in as the ability it abbreviates, and nothing about it is special-cased anywhere else.

The interesting part is whose question it is. Every mid-resolution question the engine had asked
belonged to whoever was resolving something; a ward's ability belongs to the warded creature's
controller and the question belongs to the player who did the targeting. So it is its own pending
state with its own action, the authorisation check is written out rather than reusing the one that
lets a host drive a seat, and it is two buttons on the control bar rather than the primary one —
because declining is a real answer and often the right one.

A ward nobody can pay is not a question, so it is not asked. That turned out to be the common case:
**six of the eleven wards in a 224-game soak were never shown to anybody**, and the spell simply
vanished off the stack with no prompt and no message. It now says so in the log, through the same
channel a replaced death uses.

Then Sedgemoor Witch's 1/1 Pest — "when this creature dies, you gain 1 life" — walked straight into
a limitation the code had written down in advance: *"a token is recorded too and then ceases to
exist below, so its trigger finds no source and does not fire — a real limitation, and no token in
the pool has one."* Now one does. It was three separate reads of a thing that was no longer there
(the watcher list's subject seat, the stack object's card key, and the script lookup), each found by
instrumenting rather than by reasoning, and all three fixed by keeping the token's last state just
long enough for its own events to be raised.

The deadlock invariant in `playout.test.ts` — a list of every way the engine can be waiting on a
seat, exhaustive on purpose — broke the moment the new pending state existed. That is the test
doing its job: the engine had grown a new way to stop and the client had no answer for it.

Both cards measured as washes: +3 games on 238 for Dragonsguard Elite, and the same record to the
game for Sedgemoor Witch. That is the right outcome for a mechanic rather than a power addition —
the engine gained a keyword and the pool did not move. 224 games, 224 finished.

### Where the search stops, and four deletions that were facts about the instrument

The opponent's evaluation has had five terms added and deleted over this project: a second ply, a
swing projection, untapped mana, an answer held in hand, and — this checkpoint — unblocked power.
Each deletion was written down as a fact about the term. Four of them were facts about the *pair*.

`applyAction` runs the engine's auto-pass loop, so the position the search scored was wherever the
table had drifted to rather than where the action happened. Measured over 13,907 actions in real
games: only 51% of casts leave the table on the same step, 19% advance a whole turn, and **half of
all attack declarations are scored after the turn has already ended.** A swing projection read after
the swing is over is not a weak term — it is a term reading a different position.

So the search now turns auto-pass off in the state it simulates. The simulated state is scored and
thrown away, never applied, so this changes what the bot sees and never how the game runs. On the
scoreboard it is worth nothing (166-170 over 336 paired games, inside the noise floor), and a flat
result needed one more check before being called a wash, because a setting that changes no decisions
cannot win or lose any: it changes 1% of decisions overall, 10% of attack declarations and 6% of
blocks.

What it is worth is time. Per decision, mean and worst: **2.62ms / 77ms → 0.91ms / 17ms** in a duel,
and **10.42ms / 407ms → 4.78ms / 292ms** in a four-seat pod. It ships on the clock rather than the
scoreboard — three times faster, the same player, and a worst case a person waiting at a table will
notice.

Then the newest deleted term went back in and was asked again on the fixed search: **170-166 and
168-168, where it had been 165-171 and 161-175.** Level, not losing. The term was never harmful; the
drift was. It stays out — level is level — but the entry that deleted it has been corrected in place,
and three of the other four deletions are now worth re-asking for the same reason.

The transferable part is about keeping records: every one of those five entries wrote down its
numbers, which is the only reason any of this was recoverable. A log that had said "tried valuing
evasion, didn't work" would have closed the question permanently.

### Convoke, and the second answer this file nearly grew

The first cost in this engine that is neither mana nor a sacrifice. Each creature tapped as the
spell is cast pays one generic mana, or one of that creature's colour — so a seven-mana Siege Wurm
is castable off four lands and three creatures.

The tempting implementation was a few lines and wrong. A convoked creature is almost exactly a dual
land — "one generic or one of my colour" — so adding untapped creatures to the mana-source list
would have reused the solver already there. It fails for one reason that cannot be patched later: a
mana source that over-produces leaves mana floating, convoke cannot do that, and nothing downstream
could clean it up, because Dark Ritual is in the pool and floating mana is therefore sometimes real.
So convoke reduces the cost instead, and the payment function learned to take a cost already worked
out rather than only a string to parse.

One planner, called from both sides: `legalActions` asks it whether to offer the cast, `castSpell`
asks it again as it pays. That is the bug class `legalActions` exists to prevent, and convoke is the
closest this pool has come to growing a second answer to "can this be paid for" — so the test that
matters is a sweep over every board from nought to seven lands and nought to four creatures, where
either the play is offered and the cast reaches the stack or it is not offered at all.

It taps nothing the lands already cover, because a tapped creature cannot block. The visible
consequence reads oddly until you see it: four Forests, two creatures and a Llanowar Elves casting
the Wurm says **convoking 2**, because the Elf taps for {G} and the planner counts mana first.

Two cards, both Selesnya, both in the Selesnya deck, because convoke is only a discount where there
is a board to tap. The slot change is a wash (149-89 against 152-86), but the castability is not:
Siege Wurm is cast in 79% of the games it reaches hand and Conclave Tribunal in 88%, where the Serra
Angel the Wurm replaced manages 63%. Over 168 games the bot convoked thirteen of its twenty casts,
tapping 2.7 creatures a time, and needed nothing taught — the search prices the tapped creatures
because it scores the board after they are tapped.

### Face down, and two players who could disagree about one board

Scoping morph turned up a live bug instead. Any player may turn a permanent face down — the card
menu has offered it since the tabletop existed, and an automated table reaches the same move through
**Move by hand** — and `viewFor` has always hidden the card's identity from everybody else. Nothing
hid it from the rules. A face-down Hill Giant was a card the opponent could not read and a 3/3 that
fought like a Hill Giant, tapped for what its card taps for, and kept handing out its static. A
probe test printed both halves before anything changed: the rules said
`{"name":"Hill Giant","power":3,"toughness":3}`, and the opponent's copy of the card had no name
**and no power or toughness at all**.

`characteristicsOf` now swaps a frozen 2/2 profile in for the card at the top — no name, no cost, no
types but Creature, no colours, no text — so all of CR 613 runs on *that*. Which is the rule rather
than a convenience: a Giant Growth makes a face-down creature a 5/5, a +1/+1 counter makes it a 3/3,
an anthem lifts it. Had it been a branch through the function instead, each of those layers would
have been a separate thing to get right.

It loses what it was giving, not only what it has: turn a Glorious Anthem face down and the team
shrinks. The effect is not deleted, because a permanent turned back face up has its abilities again
and a deleted effect could not come back — so the check sits where each effect is read, which is the
same "detect, don't announce" rule the death triggers follow.

One predicate, `isFaceDownPermanent`, read by five callers: the trigger watcher, the mana sources,
the ability offer, the effect loops and the characteristics. Two clauses written out five times
would have worked; a list of five places is a list somebody adds a sixth to without noticing. A
face-down Forest is not a Forest, and a face-down Llanowar Elves taps for nothing.

The view had to be restructured rather than patched. `redact` used to return early the moment a card
could not be identified, and that early return was what cost the opponent the stats; it now computes
characteristics for every battlefield permanent and attaches the card definition only when the
viewer may have it. That reads like a leak and is the opposite: what goes out is the 2/2, and the
sixth test checks that the string `"Hill Giant"` appears nowhere in the opponent's payload or the
spectator's.

Nothing to measure, and that is stated rather than papered over: no card in this pool turns a
permanent face down, so no number of bot games touches any of it. Six tests, 649 in the package, and
the five browser suites on the rebuilt stack. Morph is unblocked, but the fix stands on its own —
the table offered the move already and did the wrong thing with it.

### Morph, and the pack that was dropping a field

Three cards, one script field each, and no new rules — which is the argument for having done the
face-down work first. A card with morph may be cast face down as a 2/2 creature spell for {3} and
turned up later for the cost printed on it; what a face-down thing *is* was already answered.

Two actions, because they are two different things. The face-down cast is a `cast` with a flag; the
turn-up is a **special action** — no stack, no priority window, nothing an opponent may do about it
(CR 702.37b). That is the reason a player holds a morph instead of casting the creature, and a table
that drew it as an ability would promise a window to respond that does not exist.

The face-down cast is its own function, called before anything else in `castSpell`, because a
face-down spell has no text: no modes, no {X}, no kicker, no convoke, nothing to target. Each is
refused rather than dropped. And the play is offered *above* the affordability check, which is the
whole point — a morph you cannot afford is still castable face down, and that is what the mechanic
is for.

Zoetic Cavern is in the pool to prove the rule rather than to use it: a **land** cast as a 2/2
creature spell, legal because morph does not read the card. A face-down Cavern taps for nothing,
does not use the land drop, and turning it up gives back a land that is not a creature — three
sentences that a patch would have needed a special case for each of.

The bug this turned up was in the wire. `packView` leaves out an empty keyword list and
`unpackView` put it back under a condition that read "a battlefield card whose definition
travelled"; a face-down permanent has characteristics and no definition, and a face-down spell has
them on the stack. The whole-game round-trip assertion caught it on the first game, twice — the
second time because `power` looked like a tidier signal and is not, since a land has keywords and no
power. It now reads the same condition `redact` uses, which is the only version that cannot drift.

Measured: over 168 games on two seed sets the bot cast 20 of 23 Dirgur Nemesis face down (87%) and
4 of 7 (57%), and 8 of 18 Battering Craghorn (44%) and 6 of 18 (33%) — used, and used more by the
card whose printed cost is further out of reach. The follow-through is lower and is the honest
number: 4 of 20 face-down Nemesis were turned up, 3 of 8 Craghorn. `simulate` stops when the stack
empties, so "turn it up and win the combat" is past the horizon unless the combat is already
happening.

The slot changes are a wash, as convoke's were: Tidal Mind with the morphs against without is
77-161 vs 75-163 on one seed set and 84-153 vs 73-165 on the other, Ashen Rite 114-124 vs 112-126
and 115-123 vs 112-126. The games are in the split — +6 against Rot Harvest, +7 against Ashen Rite,
+5 against Forge Alliance, and nothing against the two fastest decks either time.

One rule was written and reverted: play a morph land last, so a Zoetic Cavern is not spent as a land
while an Island is in hand. Sound reasoning, three casts in 336 games, so it came out and the number
went into the log. The cause is upstream — the land drop is taken before the search, so the bot
never weighs the Cavern's two halves at all. That half of the card is a person's option rather than
the computer's.

And one thing was drawn that had been missing since before morph: a face-down permanent rendered as
a plain card back, with no power, no toughness and no counters. Right while the only face-down cards
were somebody's hidden hand; wrong the moment one sat on the battlefield, where the opponent is
entitled to read the 2/2. The back now carries both, and five checks in the tabletop suite turn a
permanent over in two real browsers and assert each half of what the two players should see.

### The turned-face-up trigger, and the number it moved

Morph's one missing hook, and the last paragraph of the entry above said what it would be for. A new
trigger event raised from the turn-up, and the two cards that wanted it: Ainok Survivalist (destroy
target artifact or enchantment an opponent controls) and Master of Pearls (creatures you control get
+2/+2 until end of turn).

It had to be its own event. A morph enters the battlefield face down with no abilities at all, so an
entry trigger has already come and gone by the time the card is itself — and turning it up is not a
new object, so an `etb` never comes round again. An entry trigger on a morph fires while the card
has no abilities to fire it; this one fires when the card gets them.

Raised before `settle`, which is what gives the opponent their one window: the reveal uses no stack
and cannot be answered, but what it triggers goes on the stack like anything else. A Master of
Pearls turned up after blockers cannot be stopped from being a 4/4, and the +2/+2 can be countered.
That is the right way round.

**The prediction held.** The entry above recorded that the bot turns up only 15–50% of the morphs it
casts face down, because `simulate` stops when the stack empties and "turn it up and win the combat"
is past that horizon. A trigger is immediate value the search *can* see. Over 168 games on each of
two seed sets, **every single Ainok Survivalist the bot turned down it turned back up** — 24 of 24,
about one turn later — and Master of Pearls came back at 44% and 76%, against 15–25% for Dirgur
Nemesis and 33–50% for Battering Craghorn. Not that the bot got better: a mechanic the one-ply
search could not price became one it can, by giving the moment an effect.

The slot changes measure as nothing, with signs worth writing down. Master of Pearls is up 2 and up
9 in 238; Ainok Survivalist is down 4, and down 4 again. Both a fraction of the noise floor. The
second has a mechanism, and it is about the bot rather than the card: it casts the Ainok face down
94% and 89% of the time, paying {3} for a {1}{G} 2/1 and wasting a mana every time, because a
face-down 2/2 scores above a 2/1 and unspent mana scores as nothing — the term D119 measured as
exactly level. A person casts it face up when they want the body. The bot knows one of the two
reasons to play the card.

### Vehicles, and a deck placement the instrument refused twice

A Vehicle is an artifact that is not a creature at all until somebody crews it, and almost none of
that needed new code. `isCreature` comes off the type line, so attacking, blocking, a sweeper and a
Doom Blade's filter already say no; crewing is layer 4, which the land-that-becomes-a-creature built.
What the engine gets free: a Vehicle cast this turn is summoning-sick when crewed, it stops being a
creature at end of turn and stays on the battlefield, and one that dies is an artifact again.

Crew is the third cost here that is not mana. `crewPlan` is convoke's sibling, built the same way for
the same reason — one planner for the offer and the payment — and it taps the **smallest** creatures
that reach the number, which is the opposite of what reads naturally: the big one is the one you want
left standing. Summoning sickness does not stop a creature crewing, and the Vehicle stays untapped.

The ninth of the "spent on nothing" family, and the first that is arithmetic rather than an empty
board: after a crew the Vehicle genuinely is a creature, so the search sees one more attacker and
nothing for the creatures lying sideways. `crewBuysMoreThanItCosts` compares the Vehicle's power with
the power the plan would tap, counting only the creatures that *could* have attacked — a creature
that arrived this turn was not going into this combat anyway.

**The instrument refused the first placement twice.** All three Vehicles in Rot Harvest measured
88-149 against 95-141 and 77-161 against 97-141 — down 7 and down 20 in 238, the second past the
noise floor. The crew rule recovered 3 and 5 and left it negative. The mechanism is obvious in
hindsight: Rot Harvest attacks and trades with its creatures, and crew taps them.

The arrangement that measures as a wash puts each Vehicle where its ratio works. The Dreadnought
stayed in Rot Harvest, the only deck that can reach crew 4 at all: down 8, then exactly level. Sky
Skiff and Renegade Freighter went to Forge Alliance, whose creatures are 1/1 tokens: up 9, then
exactly level. The lesson is not about Vehicles — **a cost paid in creatures is priced by what those
creatures were going to do**, so the same three cards are a wash in one list and twenty games in
another.

And the table had to learn a question it could not derive. `VisibleCard` now carries `isCreature`,
because "has power printed on it" and "is a creature right now" part company in exactly two places:
a Vehicle has a printed 7/11 and is not one, and a Mutavault is one with no printed power. The board
read the first as the second, so it told a player their uncrewed Vehicle was *not ready*. It says
**not crewed** now, and the Mutavault had been quietly wrong there since it was scripted.

### Sagas, and three kinds of thing for one card

The first permanent here whose whole shape is that it says three different things on three different
turns and then is gone. Everything else in the engine is an entry trigger that fires at a moment, an
activated ability a player presses, a static that is simply true, or an effect that expires. A Saga
is a permanent that **keeps a count**, and what each number means is printed on it.

So it took three pieces, each a different kind of thing. A **turn-based action** adds the lore
counter as its controller's precombat main phase begins, beside the untap and the draw, because
nothing can be done in response to a counter going on. A **triggered ability** keyed to the counter
reaching a number is the chapter, which goes on the stack and can be answered. And a **state-based
action** sacrifices the Saga once its last chapter has gone.

`saga: true` is the only new field. The chapters are ordinary triggers with `on: { kind: 'chapter',
n }`, so they get the stack, targets and mid-resolution questions for free, and the chapter count is
derived from them rather than declared beside them — a `chapters: 3` field next to three chapter
triggers is a field that eventually disagrees with them.

The counter being the state is what makes the awkward cases free. Nothing records which chapters
have fired, so a Saga that leaves stops counting, one that comes back starts at chapter I, and a
face-down Saga does nothing at all. The sacrifice checks the counters and an empty stack rather than
whether an ability resolved, which is the rule and also what lets chapter III sit on the stack and
read the board it is about.

Two cards, and the second is placed for a clause rather than a colour: The Birth of Meletis (a wall,
two life, a land) in the deck that wants to survive to its fliers, and The Eldest Reborn in the mill
deck — its last chapter returns a creature from **any** graveyard, where every other reanimation in
the pool reads *your* graveyard, so it is Hollow Tide finally able to spend the pile it spent the
game filling.

Both slots measure as a wash: down 1 and down 5 for the Eldest Reborn, up 3 and up 1 for the Birth
of Meletis, all a fraction of the noise floor. What is not a wash is that they get cast — 86% and
100% of the games they reach hand, with no bot teaching at all. A Saga asks nothing of the player
after it is cast, which is the one kind of card this bot pilots perfectly.

### Foretell, and the cut that mattered more than the card

The fourth zone a spell is cast from here, and the only one where the card is hidden while it waits.
{2} to exile a card from hand face down during your own turn, and a smaller cost to cast it on any
later turn.

Two rules travel with the cost: it is taken during your own turn, and a foretold card cannot be cast
on the turn it was foretold — which is what stops foretell being a straight discount on a spell you
were casting anyway, and the only reason the engine remembers anything. `foretoldTurn` is also what
tells a foretold card apart from a creature a Banisher Priest took: both are face down in exile, and
only one of them is castable, by its foreteller rather than its owner.

Two mechanics want opposite things from one field. `relocate` carries `faceDown` onto the stack for
morph's sake, and a foretold card must turn face up as it is cast. One line says which is which, and
it has a test, because a counterspell on the stack that nobody could read would be unplayable.

The bot was taught, as the tenth of the "spent on nothing" family: the gain from a foretell is
entirely in the future, so the search sees two mana spent for nothing. The rule asks the board
whether there is anything else to do with the mana. What the measurement then said is more
interesting than the rule — over 56 games it foretold a **Saw It Coming eight times and a Behold the
Multiverse not once**, because a counterspell has no sorcery-speed use and the Behold is castable
whenever there is mana for it. Foretell helps this bot on exactly the card the mechanic was printed
for.

**And then the slot measurement said the hypothesis was wrong, twice.** Saw It Coming most resembles
Essence Scatter, so that was the first cut: it cost Tidal Mind 13 and 8 games in 238 on two seed
sets. A {1}{U} answer to a creature is worth more to the pool's slowest deck than a {1}{U}{U} answer
to anything, and six of the eight decks win with creatures. Cutting the second Murder instead
measures −1 and +7 — same two cards added, one different card removed, a swing of about twelve games.

That is the finding worth keeping and it is not about foretell: **which card a slot change removes
matters more than which card it adds.** Both arrangements were measured on both seed sets before
either shipped, which is the only reason the first one did not.

### A ninth deck, and the trigger that already had the vocabulary for an archetype

Eight decks, and the gap between them was never a colour pair — it was a *way of winning*. Six won
by attacking with creatures, one by attacking a library, one by draining a life total. Nothing had
ever been built so that **casting a spell was itself the thing that advanced the board**, which is
the one archetype Magic has had since Urza's block and this pool had never had. The `spell-cast`
trigger was older than most of the engine and had nine readers, every one of them a card sitting
inside a deck that would have been fine without it.

**Arc Tempest** is twenty-five instants and sorceries, seven creatures that read them, and
twenty-one lands. Five of the six new cards needed nothing new: Guttersnipe is Firebrand Archer at
twice the damage, Young Pyromancer is Talrand at a third of the cost, Gelectrode is
Thermo-Alchemist with a target, Stormchaser Mage is prowess on a flier, and Adeliz is a pump with a
list of ids the card chooses itself. That last one is the useful shape: "each Wizard you control" is
narrower than any scope `ContinuousEffect` has, and it did not need one, because `pump` takes ids
and so the filtering is the card's business. A *static* "Wizards you control get +1/+1" could not
be written at that point — a real hole, and the next entry is the one that closed it — but a
one-shot pump reading a subtype never needed it.

The sixth card is the one that cost engine work. **Enigma Drake** is printed with a star for power
and a 4 for toughness, and the pool's only previous characteristic-defining ability — Lhurgoyf —
counts creature cards in *all* graveyards and defines *both* halves of its size. So `definesSize`
learned two things: a second count (`instant-and-sorcery-cards-in-your-graveyard`, which needed the
effect's controller passed into `cdaCount`), and `applies: 'power'`, for a card where only one half
is counted. Both are additions to the mechanism rather than a second mechanism, which is the point
of having built a CDA properly the first time: the number is still read fresh on every
characteristic lookup, so the Drake grows as the deck does its own thing and shrinks if somebody
exiles the graveyard, with no trigger, no event and nothing to invalidate.

**Where it landed: 47%, 90-102, fourth of nine** (192 games each, two seeds-sets' worth of games on
one run). The per-opponent split is the deck's own design document read back:

```
beats    tidal-mind   19-5     rot-harvest  16-8     hollow-tide  13-11    ashen-rite  13-11
loses to ember-rush    5-19    forge-alliance 5-19   verdant-guard 8-16    skyward-writ 11-13
```

A deck of cheap removal and counterspells beats everything slower than it and loses to everything
faster. The 5-19 against both one-drop decks is also the bot's limitation showing through for the
third time (D108, D110): holding Counterspell up is half this deck's plan against them, and the
one-ply search casts it on the turn it can afford it.

**The more interesting number is what happened to the other eight decks, none of which changed a
card.** Skyward Writ up five, Hollow Tide up two, Rot Harvest down three, Tidal Mind down six. The
whole of that is Arc Tempest's record against each of them, arriving in a table where every deck's
percentage is a function of the entire rest of the field. The doc has carried a caveat about this
since the first balance pass, illustrated by Hollow Tide once falling eight points without a card
changing; this is the cleaner demonstration, because *nothing* changed except the size of the field.

The cast counts say no slot is dead: the weakest is the single Enigma Drake at 46% (cast in 13 of
the 28 games it reached hand — a four-drop in a deck whose curve stops at three), then the two
narrow counters at 61% and 62%. At the other end, Gelectrode was activated 144 times in 128 games
and Thermo-Alchemist 100, which is the untap-on-cast line doing exactly what the deck is built
around, and Think Twice was cast 171 times from 88 games in hand, which is flashback doing the same.

**One bug, and the browser suite found it.** `e2e-arena` has a check called "creatures on the
battlefield show a current power and toughness", and it read every `body-` element on the page —
hand included. A card in hand is *supposed* to show its printed body, so the check had been passing
on a false premise for as long as it had existed: every other card in the pool prints a number, so
reading the hand looked the same as reading the board. Enigma Drake prints a `*`, and the suite went
red the first time it was dealt one. The fix is in the check, not the card: scope the selector to
`zone-battlefield-*`. Verified non-vacuous rather than assumed — the narrowed selector was made to
print what it found, and it came back `["2/2","2/3","7/4"]`, the 7/4 being a Drake with seven spells
in its graveyard. This is the third check in this project that was wrong by being broader than its
own sentence, after the face-down leak check that read the game log and the crew test that asserted
the wrong arithmetic.

### The scope that reads a creature type, and three lords to prove it

The hole this file had named three times. `ContinuousEffect`'s scope could say "this card",
"creatures you control", "other creatures you control" or "all creatures", and nothing narrower —
so "other Goblin creatures you control get +1/+1", which is every tribal lord ever printed, could
not be written. Adeliz got round it one entry ago because a **one-shot** pump takes a list of ids
and the card may filter however it likes. A static cannot: it is a declarative object that goes to
Redis and down a socket, so the filter has to be something the engine can perform from what was
stored.

`{ kind: 'controller-subtype', subtype, other }`, then — the only scope here that carries a value,
which is why `other` is a field rather than a second `kind` the way `other-controller-creatures` is.
A parameterised scope already has to be read rather than matched, so one more field costs nothing,
where two bare tags would have become four.

**The one judgement call was where to match it.** `effectApplies` is called from three places, and
only one of them has a type line with layer 4 applied: the main `characteristicsOf` loop. The other
two are the layer-4 pass itself, which cannot have its own output, and `combatDamagePrevented`.
So the subtype is matched against the best line each caller has, which is CR 613.1d before 613.1f
where it matters and the printed line where nothing in the pool cares. `typeLine` is passed in
rather than derived from the `creature` boolean already being passed, because that boolean is
computed once per `characteristicsOf` call and this runs once per effect.

**Three cards, because one would not have proved it.** The three halves worth checking are
separate: that the scope carries a size (all three), that it carries **keywords** (first strike,
indestructible), and that it follows the board rather than a list — Imperious Perfect makes Elf
Warrior tokens, so it grows its own scope with nothing recomputed and no event saying a new Elf
exists, and a second copy pumps the first while neither pumps itself.

Knight Exemplar is the one that tests the *duration*. A Knight carrying three damage survives
because it is a 3/3 and indestructible; move the Exemplar to the graveyard and the same Knight is a
2/2 with three damage on it and the next state-based action kills it. That falls out of
`duration: 'permanent'` meaning "while the source is on the battlefield" and needed nothing of its
own.

**The lord this pool most obviously wanted is deliberately absent.** Goblin Chieftain in Ember Rush,
with Krenko making Goblin tokens to pump, is the strongest version of this card anywhere in the
pool — and Ember Rush already wins 82% of its games. Proving a scope is worth a card; handing the
best deck in the field a free upgrade is not. The three that shipped are in the three decks between
36% and 45%.

**What they measure as**, each as a single slot swap *as first arranged*, priced on both seed sets
at 240 games a side (the Perfect's cut changed afterwards — see below):

```
Stromkirk Captain  (for the 2nd Dark Ritual, Ashen Rite)   122-117 v 123-116,  118-122 v 117-123
Knight Exemplar    (for the Divination, Skyward Writ)      107-133 v 102-138,  105-135 v  99-141
Imperious Perfect  (for the Blossoming Defense, Rot H.)     99-138 v  97-142,  103-137 v 111-127
```

The first pair in each row is the deck *with* the lord. The Captain is level — one game each way
across the two seed sets, which is as close to nothing as this instrument reports. The Exemplar is
**+5 and +6**: consistent in sign on both sets and still under the eighteen-game floor, so it is
not priced either, and it ships because it is the card that tests keyword-granting rather than
because of the five games. The Perfect is **+2 and −8** — opposite signs, which by this file's own
rule means it has not been measured, it has been sampled twice.

**And then the Perfect's own cut was re-asked, which is D127's rule earning its place a second
time.** The arrangement above has the lord replacing the Blossoming Defense. Taking the **third
Blood Artist** instead, and keeping the trick, measures **+4 and +13** against it on the two seed
sets — consistent in sign, with one of them at the floor. So that is what shipped. The mechanism is
not subtle once seen: three Blood Artists is one more than a deck needs to find one, while the
Blossoming Defense is the only card in that list that answers a removal spell. Same card added,
same deck, one different card removed, and a swing of roughly fifteen games — which is the second
time that has happened in three entries. **Measuring the cut is not an optional extra step; it is
half of what a slot change is.**

**The full table says the same thing, and says it more sharply.** Re-run over all nine decks (192
games each), the only record that moved is Rot Harvest's — up five, which is the deck whose cut was
re-asked. Ashen Rite came back 86-106 and Skyward Writ 85-107, identical totals to the run before
the lords went in. That is a coincidence rather than a card doing nothing: half a dozen of their
individual matchups moved by a game or two each and the sums happened to land on the same numbers.
It is worth stating precisely, because "the total did not change" and "nothing changed" are
different claims and only the first one is true.



### Megamorph, and the morph cost that is not mana

Two of the three things the morph entry listed as missing, and they turned out to be one
observation from two ends. CR 702.37a lets a card print whatever it likes for turning itself up;
the pool's first five morphs all printed mana; so the engine held the cost as a mana string. That
is not a design, it is a shortcut that reads as one until the sixth card arrives.

The cost is an `AbilityCost` now — the same vocabulary an activated ability's cost uses — which
made **Zombie Cutthroat** expressible: `{ life: 3 }`, and no mana at all. Reusing the type rather
than growing a second one brought the life clause's own rule with it for free: a cost you cannot
pay is not a cost you may choose to pay (CR 118.4), so at three life the turn-up is not *offered*,
which is exactly what `AbilityCost.life` already said about a Mana Confluence. Only `mana` and
`life` are paid, and the type comment says so rather than letting a script ask for a `tap` on a
turn-up cost and get a quiet approximation.

**Megamorph is one flag, and the reason it is a flag matters more than the flag.** CR 702.37c says
turning the permanent up also puts a +1/+1 counter on it, and the obvious implementation is a
`turned-face-up` trigger on each megamorph card — the engine already has that event and two cards
using it. It would be wrong. A trigger goes on the stack, which would hand an opponent a window
between "it is face up" and "it is bigger": a window to kill a 2/1 in response to its own +1/+1
counter. Turning a permanent face up is specifically the one thing in this mechanic nobody may
respond to, so both halves happen inside `turnUp`, before anybody has priority again.

**Hidden Dragonslayer** is the card that makes the point for the mechanic rather than for itself:
a {1}{W} 2/1 lifelink if the board is empty, a {3} 2/2 if it needs a blocker, and a {2}{W} "destroy
their best creature" if the thing that beats this deck has already landed — one card, one hand,
decided late, and the opponent cannot see which of the three it is. Its trigger is mandatory and a
trigger with no legal target never reaches the stack, so turning it up into a board of 1/1s is a
3/2 lifelinker and nothing more.

**What the measurement said, and the one number worth keeping.** Both slots are level: Zombie
Cutthroat for the second Bone Splinters measured **+3 and 0** over 240 games a side on the two seed
sets, and Hidden Dragonslayer for the Air Elemental **+9 and 0** — non-negative on both sets and
under the floor on both, so neither is priced and both ship for the mechanic.

`morph-use.mjs` is where the interesting number is. Of the seven morphs, Zombie Cutthroat is the
only one with a **100% follow-through — 10 of 10 turned up** — and its mean turn face down and mean
turn turned up are the *same number*, 6.8. That is the cost doing it: every other morph has to find
mana on a later turn, and a cost paid in life can be paid on the turn the 2/2 lands. The bot needed
no teaching for it at all, because paying three life is something `evaluate` can already see.

**And one bug in the harness, found by the change rather than by a test.** `morph-use.mjs` printed
the morph cost straight into its header, which had been a string and was now an object, so every
line read `morph [object Object]`. It goes through the engine's own `morphCostText` now — the same
formatter the offer uses, so the harness and the table cannot disagree about what a card costs.

**The full table moved the way the probes said, and moved two decks that did not change.** After
both slots: Skyward Writ up eight (44% to 48%) and Ashen Rite up three, which is each card in the
direction its own probe gave. Verdant Guard is down five and Forge Alliance down two with no card
of theirs touched — they are the two decks that beat Skyward Writ most often, and a stronger
Skyward Writ takes those games off them (18-6 became 16-8; 17-7 became 15-9). D128's rule about a
deck-table percentage being a statement about a field now has an example *inside a single run*
rather than across two.


### Changing what a spell is pointed at, and a deck the instrument cannot price

The last thing on this file's own "Next" list that was neither blocked nor open-ended, and a
different *kind* of work from everything above it. Every effect in the engine reads the board and
changes the board. This one reaches into an object already on the stack and alters a choice its
controller made.

`retarget` lives in `targeting.ts` beside the legality rules rather than in `effects.ts` with the
things that deal damage, because that is what it is about, and three rules travel with it:

- The new target must be legal **for that spell**, judged with the spell's *own* controller as the
  chooser (CR 114.6c). Not "may the Willbender's controller target that" — "may the Doom Blade".
- It must be a *different* target, or "change the target" changed nothing.
- If either fails, **nothing happens**: the spell keeps the target it had (CR 115.7b). It is not an
  error and it is not a counter.

**The second target is declared wider than the spell's own spec, on purpose.** Both cards ask for
two targets — the spell, and where it is going — which nothing in the pool had done before, and the
second is `any`. So a player *may* point a Doom Blade at a player, the engine accepts the choice,
and `retarget` then declines to make the change. That is CR 115.7b rather than a leniency, and it
has a test: the Doom Blade resolves against the creature it was always aimed at.

**The offer and the effect agree**, which is the rule convoke, crew and morph are all built on:
`soleTargetSpecOf` returns `null` for an ability, a spell with no targets or several, and a modal
spell whose targets belong to the mode rather than the card — and a spell it returns `null` for is
not *offered* as a target rather than being offered and quietly failing. The same filter also
requires there be **somewhere else to send it**: at least one legal target for that spell other than
the one it already has. A Flame Slash aimed at the only creature on the table is not a Swerve
target, because changing it would change nothing.

**Spells, and not abilities.** Willbender is printed "target spell **or ability** with a single
target" and the engine does the spell half. The reason is the shape of a `Target`, which is a card
or a player: a spell on the stack *is* a card, while a triggered or activated ability has a
synthetic id and no card anywhere, so naming one needs a third kind of `Target` threaded through
some thirty call sites for one clause. Said out loud rather than approximated — the same decision
the magecraft cards' "or copy" half got — and **Move by hand** covers it meanwhile.

**The bot needed no teaching and the number says why.** `morph-use.mjs`: Willbender is cast 27
times in 432 games, 85% of them face down, and **turned up 17 of 23 (74%)** — second only to Zombie
Cutthroat's 100%. That is a sharper number than it looks, because turning a Willbender up makes it
*smaller*: a face-down 2/2 becomes a 1/1. The only reason to do it is the redirect, the trigger only
exists when a redirect is available, and the one-ply search can see what the redirected spell does.

**And the honest part. Tidal Mind is a deck this instrument cannot price.** Willbender for the Dive
Down measured **+11 and −10** on the two seed sets — opposite signs, so by this file's own rule it
has been sampled twice rather than measured. Re-asking the cut, as D127's rule says to, gave **+5
and −2** for taking the Behold the Multiverse instead: also opposite signs. Three results, all
inside the eighteen-game floor, none with a consistent direction. So the shipped arrangement stays
and the number is written down as *unknown*.

The interesting part is why. The same unchanged list came back 69-170 and 71-169 on the two sets —
two games apart — while its one-card variants came back 58-182 and 81-159, which is a **23-game
spread for a single slot**. The deck at the bottom of the table has the least reliable record in the
pool, and that is not a coincidence: a deck that wins 29% of its games wins most of the ones it wins
narrowly, so a single card moves more of them either way. **A noise floor established on the pool's
average deck is too generous for the pool's worst one** — which is a limit on the instrument that
this entry found and did not fix.

Swerve, in a deck at 46%, behaved exactly as the others have: **+1 and −2** for the Negate, which is
a wash, and it ships because it is the second reader of the primitive.

### The creature the event was about, and the clause that is asked twice

Two keywords, and the two things the engine was missing to write either of them. Every
board-watching trigger before this could only talk about **itself** or about a player: `etb`, `dies`
and `attacks` carried *whose* creature it was and whether it was a creature at all, and never
*which*. A Blood Artist never has to know. Exalted and evolve both do — "**that** creature gets
+1/+1", "if **that** creature has greater power or toughness" — so the subject's id now rides the
event, the stack object and `EffectContext`, exactly the way `attacked` and `answering` already do
and for the same reason: the event is gone by the time anything reads it.

The other half is a rule rather than a convenience. `TriggerDef.condition` is the intervening-if
clause (CR 603.4), and the whole of it is that it is asked **twice** — before the ability would go
on the stack, and again as it resolves — with a false answer either time meaning the ability does
nothing at all. Both asks are things a player sees:

- The **first** is why a Cloudfin Raptor that is already the biggest thing you control puts nothing
  on the stack when a 1/1 arrives. Without it, every creature an evolve deck plays for the rest of
  the game puts an ability on the stack that resolves into nothing — which reads as a broken engine,
  not as a rule.
- The **second** is why bouncing the creature that caused the trigger is an *answer* to it. Unsummon
  the Wall of Air while the evolve trigger is waiting and the counter never arrives.

Both were confirmed load-bearing the way the project has been confirming them: disable each check in
turn, watch exactly one assertion fail, put it back.

**And the measurement is the loudest version of a rule this file already had.** Guardians of Akrasa
went into Skyward Writ twice, with two different cuts, 240 paired duels against the field and two
seed sets each. Cutting the **Wall of Air**: 103-137 and 100-140, against 103-137 and 97-143 for the
list before it — nothing, inside the noise, twice. Cutting the **Negate** instead: 120-120 and
113-127, which is **+17 and +16** on the same side both times and right at this instrument's
eighteen-game floor. Same card, two cuts, seventeen games between them.

The reason is readable on the cards rather than only in the numbers. The Wall of Air was the wrong
cut because its *flying* was the redundant part — this deck already answers the air with two Fog
Banks and the Birth of Meletis holds the ground — and the Negate was the right one because it was
the deck's least-cast card at 55% of its copies and what it answers is the half of the field Skyward
Writ already beats. D127 said measuring the cut is half of what a slot change is; D129 confirmed it;
this is the third data point and it is worth more than either.

Cloudfin Raptor went into Hollow Tide for the second Psychic Strike at +3 and +4 — both sets the
same way, both far inside the floor. Written down as free rather than as good, which is the bar a
new keyword's card has to clear: it has to live somewhere to be playable at all.

### An ability on the stack is a thing you can point at

The last item on this file's own "Next" list, and the estimate in it was wrong by an order of
magnitude. D131 said Willbender's printed "or ability" half needed a third `Target` shape "threaded
through thirty call sites for one clause". The union has **seventy** readers and **five** of them
needed changing — because almost every reader reaches for `.seat` on the non-card branch, and a
third member with no `seat` makes that a type error rather than a silent fall-through. The five were
`targetKey` and four hand-rolled copies of it in `bot.ts`; they are now one call to the shared one,
which is the fix they should have had anyway. `apps/web` had a sixth copy, and now imports the
engine's.

What was actually left was four **honest refusals**, and each is a sentence about what an ability is:
it is in no zone, so "still on the stack" is the whole of its legality; it has no `objectSeq`, so it
cannot be a *different object* the way a bounced creature is (CR 400.7); it has no permanent to
carry hexproof, shroud, protection or ward; and it cannot be damaged or shielded (CR 120.3), so
`dealDamage` and `preventDamage` refuse it at the top rather than falling into the creature branch
with an id that names nothing. That fall-through would have returned the same state by accident, and
the point of writing the refusal is that the next reader cannot tell those two apart.

One real bug fell out: `retarget` passed the *stack object's* id as the source for its legality
check. Right for a spell, whose id is its card; wrong for an ability, whose id names nothing in
`instances` — so protection from black would have missed an ability from a black permanent, which is
a fact about the permanent (CR 702.16b).

**Three cards, because the shape has three uses.** Squelch ({1}{U}, counter target *activated*
ability, draw a card) is the narrow one and the first spec in the pool to put a `filter` on an
ability candidate — it reads the stack object's own kind to tell an activated ability from a
triggered one. Disallow ({1}{U}{U}, counter target spell *or* ability) is the wide one and the whole
argument for `spell-or-ability` being a kind. Willbender does what its card says.

What this adds is not a card but a kind of answer. Everything in this pool that answers a permanent
answers the *permanent*: a Doom Blade kills the Icy Manipulator and not the tap it already
activated, a Murder kills the Jace and not the loyalty ability above it. An ability on the stack is
independent of its source (CR 113.7a) and was the one object at this table nothing could touch. The
cost staying paid comes free with it — countering an Icy's tap does not untap the Icy, because the
tap was the price of putting the ability on the stack.

**And the cut decided it, for the fourth time.** Squelch in Arc Tempest, 240 paired duels against
the field, two seed sets each: no Squelch is 100-140 and 99-141; Squelch for the *Divination* is
98-142 and 89-151, worse both times; Squelch for the *Essence Scatter* is 102-137 and 103-137,
better both times. Four and fourteen games between two cuts of one card. Both wrong cuts this
project has measured took a deck's only copy of something it needed — here the Divination, which is
Arc Tempest's only refill and which all four of its spell-payoff creatures get paid for.

Disallow went into Tidal Mind for its Essence Scatter and came back +8 on one seed set and −10 on
the other: unpriceable, exactly as D131 said that deck's record is. It ships on the rules argument —
"counter target creature spell" is a subset of what Disallow does — and the number is written down
as unknown.

### The question whose answer is a word

Every mid-resolution question this engine could ask was "choose some cards from a zone" — a search,
a discard, a scry, a sacrifice. "Choose a creature type", "choose a colour", "tap or untap" and "you
may" name no object at all, so an entire family of printed cards was unwritable rather than
approximated: the only yes-or-no in the engine was `pendingPayment`, which is ward's special case
with a mana cost attached.

`DecisionSpec` is now a union, and the new half is `{ who, prompt, options }`. One shape for all of
them rather than a separate yes-or-no, because "you may" *is* a choice between two words: the table
draws the same row of buttons either way, and one mechanism is one place for the rules to live. A
list of fewer than two words is answered by the engine rather than asked — the rule that already
keeps a discard of two from a hand of two off the screen.

**The card answers its own question for the bot**, through `ChoiceDecisionSpec.best`, and it has to
live on the card because only the card knows what its words *mean*: "Vampire" is a type to count on
a battlefield and "black" is a colour to fear in a graveyard, and nothing generic tells those lists
apart without guessing. Both implementations read the board rather than carrying a weight, and the
colour one reads only other seats' *public* zones — a bot that read their hands would be answering a
question no player can answer. The engine checks the card's hint against the offered list anyway,
because a hint naming something unoffered would be a refused action and a stopped table.

**Both cards choose as they enter, and that is the rules point.** A `decisions` list is asked during
the spell's own resolution, before the permanent is on the battlefield, which is exactly what "as ~
enters the battlefield" means (CR 614.12). A trigger would be a different card: it would go on the
stack after the permanent arrived, both players would get priority, and killing the Obelisk in that
window would leave a type chosen and nothing pumped. The test says it directly — after the answer
the stack is empty, the Obelisk is on the battlefield and the Elf is already a 3/3, in one action.

Obelisk of Urd ({5}, convoke) in Rot Harvest is three things the engine already had and one it did
not: convoke from D101, the subtype-scoped static from D129 (so an Elf token made four turns later
is pumped with nothing recomputed), `duration: 'permanent'` ending it when the Obelisk leaves — and
the choice. Voice of All ({3}{W} 2/2 flier) in Skyward Writ is the closed-set half: five options, no
approximation, and the card that makes protection's four rules (D83) worth having had.

The honest deviation is the Obelisk's list. The card says "any creature type"; a table cannot draw
several hundred buttons, so the options are the thirteen types this pool contains in numbers — every
one with eight copies or more. A derived rule rather than a judged list.

**The numbers, and one of them is a carry.** The Obelisk is +4 and −3 over 240 paired duels on two
seed sets: no consistent sign, free. The Voice is −3 and −2, the same side both times and still
inside the floor; the cut was re-asked per D127 and a Raise the Alarm instead gives −4 and −5, so
the Serra Angel is the better cut and the card is the marginal part. It is carried on purpose and
the number is written down: this is the one card in the pool where the gap between a bot's answer
and a person's *is* the card, because a player chooses the colour from the matchup in front of them
and the engine chooses it by counting what it can already see.

### A tenth deck, and the first time anybody measured a commander

`life-gained` has been a trigger event since the triggers were written and until now **one card in
the pool read it** — an Ajani's Pridemate in a red-white deck that gains life by accident. Nine
decks measured the game in damage or in cards; none went up on purpose. So Dawn Tithe, white-black,
where the gain is an *input*: two creatures turn it into a body that grows, two turn a death into
both totals moving at once, and the removal spell gains two life while it removes. Six new cards and
a guildgate; the other fifty-odd slots were already here.

One engine addition came with it and it is the third of a family. `EffectContext` could say which
permanent an event happened to (`subject`) and what an attack was aimed at (`attacked`), and not
*who did it*. Kambal says "whenever an opponent casts a noncreature spell, **that player** loses 2
life", so `actor` now rides the stack object the same way — set only when it is somebody other than
the watcher, because a card that means its own controller says `controller` and always could. The
test is a four-seat pod, since in a duel the wrong reading is indistinguishable from the right one.

**The deck came in too strong and the number said so first.** 66% against the nine-deck field,
second in the pool, winning the four slowest matchups between 19-5 and 22-2. Two weakenings were
measured over 270 paired duels each on two seed sets: −1 Aerialist and −1 Vraska's Contempt gave
−15 and −7; adding −1 Exsanguinate gave **−14 and −14**, and the consistent one shipped. What it
costs is the deck's inevitability — the Exsanguinate was the only card that ended a game it was not
already winning — and the card the archetype is built around is a one-of as a result. That is in the
deck list in those words.

**And the finding that was not the plan.** The hypothesis was Kambal: a deck of twenty-five
noncreature spells losing two life a cast looks like a lock, and Arc Tempest was losing 22-2. So
`deck-probe` gained a `COMMANDER` lever — point it at a legend whose text is dead in the subject
deck (Balan in a deck with no Equipment is a plain 2/2 double striker) and the gap is what the real
commander is worth.

Kambal is worth **−2 and −7 of 270**, both inside the floor, and against Arc Tempest the arms are
23-7 and 21-9 with him against 23-7 and 22-8 without. The 22-2 was never the commander. Every deck
here has a write-up calling its commander "the half a deck list cannot be"; the first time one was
measured it was worth at most two per cent. The likely reason is dull — the commander tax, four
mana, and a bot with sixty other cards to cast — and the lesson is to stop making that claim without
a number.

**And the browser suite caught something nothing else could.** A pod stalled on turn 110 with "Cleo
stuck at Main phase 1": a prompt nobody could answer. The cause was the previous entry's own work —
Rot Harvest now holds an Obelisk of Urd, which asks a question whose answer is a *word*, and the
driver only knew how to answer by tapping a lit card. It found nothing lit and reported the table as
stuck, which is precisely what `every prompt the table shows can be answered` is for. The engine was
right the whole time; 729 tests pass. What had never happened was a *browser* being asked that
question. The driver now taps a `decide-option-` button and the arena suite reports it the way it
reports a modal spell, which makes `DECK_A=rot-harvest DECK_B=skyward-writ` the first run in which
either of those two cards was answered through the real buttons.

### The watcher who could already talk, and the label that was missing

The last line of the setup doc's *what is not done* about watching said a spectator "reads the
table's chat and cannot write to it". It was wrong in the easy direction, the same way D132's gap
was: `pod:chat` calls `requireSeat`, and `requireSeat` asks only that the socket is **in** a pod.
The server has accepted a watcher's chat since the day watching was built. Nothing had ever sent
one, because the watcher screen had no chat in it.

Two real defects, neither of them a permission. **The drawer was missing** — `Watching` showed both
boards, both graveyards, the stack and the log, and no way to say anything; the chat markup lived
inline in the player's screen, so the fix began by extracting `ChatPanel.tsx`, one component now
used on both screens, which is the only way they stay the same thing as either changes. And **the
line read "Player"** — with no seat and no name the server fell back to `'Player'`, which is what
one of the two people playing is called, so a spectator's "I'm responding to that" arrived looking
like an opponent's. That is a wrong move made in good faith, the worst kind to debug.

`watching` is set on the server from the socket's own seat, not inferred downstream from
`seat === null`. The client could work it out; it does not, because that is a second answer to a
question with one, and the second answer is the one that goes stale. Same rule as D132's privacy
default — asserted where it is enforced — applied to a label rather than a guarantee, with a
realtime test that seats one client, watches with another, has both talk, and checks that exactly
one line comes back marked. The name a watcher sends is optional and is about the chat only; with
none it talks as "Watcher", which is at least not a player's name. Nothing else about watching
moved: no seat token, no state pushed to the table, the same redacted view.

The proof is in the browser, because it is a two-screen fact. In `e2e-arena` the watcher fills its
name, opens the drawer, sends "good luck", and the *player's* screen is checked for the
`chat-watching-` badge on that line — 55 of 55. One harness note that cost more than the feature:
the first run showed "Player" and no badge with the handler change plainly in the file, because the
realtime server under `scripts/play.mjs` predated it. Rebuild and restart the play stack before a
browser suite, every time; a stale server fails in the shape of a bug in the code you just wrote.

### Damage divided as you choose, and the range that comes free of the amount

The last shape on this list's own *Next* — a choice whose answer is a number — turned out to be
better answered by the card that prints it than by a prompt: "three damage divided as you choose
among one, two, or three targets" is a budget announced with the spell (CR 601.2d), not a question
asked while it resolves. `TargetSpec` carries `divided: 3` beside `count: 3` and `optional: true`,
and the printed range falls out of the rules rather than out of a fourth field: every target must be
assigned at least one and the whole amount must be spent, so zero targets cannot pay for three and a
fourth has nothing left to take.

The division travels positionally with the targets — on the action, on the stack object, in the view
— so the one place that filters the target list filters both. A target that is no longer the object
it was chosen as takes its own share out with it and nothing else (CR 608.2b): three split two and
one, with the two bounced in response, deals one, and is not redistributed. `checkDivision` refuses
four different mistakes, and the one that matters is the total, because a spell cast with two of its
three damage assigned is a card that quietly did less than it says.

The bot is handed three divisions and no judgement: all of it on the best target, *lethal first*
(walk their creatures and pay exactly what each costs to kill while the budget lasts), and one each
as wide as the card allows. `simulate` prices them, which is the same rule the rest of that file
follows — read a fact, do not carry a weight — and the lethal-first aim is the one a heuristic would
never find, since it scores worst by every "biggest target" measure and kills two creatures. The bot
casts the card in 88% of the games it draws one.

At the table a tap on a target the spell already points at adds *another* point rather than dropping
it, so three damage split two and one is three taps and the cast goes on the last one. That costs the
gesture every other prompt uses for "I changed my mind", so the division has a **Back** button that
peels one point off and no Cast button at all — a Cast on a half-spent division is one the engine
would refuse. Both players read the division off the stack row, because it is announced rather than
chosen on resolution.

**Arc Lightning** goes into Arc Tempest for its second Shock and measures as free: taking it back out
is −9 and −1 of 270 on two seed sets, both inside the floor. Cutting the Magma Jet instead measured
−10 and +1 — unpriceable — so the cut was decided by the cards, the way the Squelch cut was: the
second Shock is the most redundant card in a deck holding twelve spells that point at a face, and
Magma Jet's scry is the half this deck is short of.

Two things are worth writing down about *how* that was measured. `deck-probe` can only add a card
that is already in some deck's list, so a new card cannot be priced before it is slotted; the way
round is to slot it and measure taking it out, with the sign negated. And the browser suite reports
the division only when the shuffle produces one — a one-of is a coin flip, and three runs did not —
so rather than call it covered, the UI was driven in a solo game until the card was drawn: the prompt
counted 3 → 2 → 1, the second tap on an already-picked target added to it, and the spell resolved.

### Copying an ability, and the clause that is not offered

The last item on this list's own *Next*, and the second half of a sentence D134 started: that entry
made an ability on the stack a thing you can point at, and this makes one a thing you can duplicate.
They are not neighbours. Countering removes an object; copying builds a second one with the first
one's targets, `subject`, `actor`, the object it was answering and its division, and puts it above
the original so the copy resolves first.

`copyAbilityOnStack` is a few fields rather than a call into the engine, because a copy is *created*
on the stack: nothing is cast or activated, no cost is paid, and no cast trigger sees it. It lives in
`effects.ts` beside `counterSpell` for the reason that function already gives. A spell is refused
rather than copied — that is a token copy or a new object with its own card, which this pool has a
Cackling Counterpart for.

What is **not** offered is the printed "you may choose new targets for the copy": that needs a way to
ask for a target mid-resolution the engine has not got. Declining is always a legal play of the card,
so the deviation makes the card worse rather than wrong — and it has a visible consequence, which is
why it is a test and not a comment. A copied Gravedigger trigger points at the card the original
already returned: the copy resolves first and returns it, and the original is countered for having no
legal target left (CR 608.2b, CR 400.7). One creature back rather than two, which is exactly the case
the printed clause exists to fix.

**Strionic Resonator** goes into Rot Harvest, the deck made of triggers, and the filter it needs is
the one the engine had no card for: an ability on the stack that is *triggered* and is *yours*. An
opponent's trigger is refused and never offered; a Vampire Aristocrat's activated ability, waiting
under the death triggers its own cost caused, is refused by name.

It measures as nothing — removing it is +4 and −2 of 270 — and it is used: in 108 games the bot cast
it in 19 of the 20 games it drew one and activated it 14 times, so the number is about the card
rather than about a card nobody touched. And it needed no bot teaching whatsoever, which the last
four cards all did: `legalActions` offers the ability only when there is a trigger of yours on the
stack, and the search prices activating it like anything else.

### Two more planeswalkers, and the reading the paired probe could not resolve

Ten decks shared two planeswalkers, and a planeswalker is the one card type here that plays unlike
everything else: it arrives, it survives, and it does something every turn without being tapped or
sacrificed. **Ajani, Caller of the Pride** goes into Skyward Writ and **Nissa, Voice of Zendikar**
into Verdant Guard — six abilities between them, and not one needed anything new in the engine. A
counter, a pump carrying two keywords, five tokens, one token, counters across a team, and a pair of
numbers read off the board as it resolves: that is the "a card is a few declarative lines" claim
tested six lines at a time.

The constraint that chose these two is the **emblem**. An emblem is a permanent ability with no
permanent behind it and the engine has nowhere to put one, so a Liliana of the Dark Realms cannot be
carried honestly. Both of these end in something that happens once — five Cats, and a gain-and-draw
as big as your lands — and both ultimates kill their own planeswalker, which is the rules rather than
the card.

Ajani measures as free (−1 and −5 of 270 removing it) and is used constantly: over 108 games the bot
cast it in 52 of the 61 games it drew one and activated it **186 times**, with nothing taught.

Nissa produced a finding about the instrument. The paired probe said −15 and −5 — same sign twice,
both under the eighteen-game floor, so "free with the number written down". The refreshed ten-deck
table, same seeds as the run before, then moved Verdant Guard **52% → 61% (+18 of 216)** with Skyward
Writ +7 for the Ajani: the two decks that changed a card are the two that moved up. A reading at the
floor is a reading the paired probe cannot resolve, and when a second instrument of a different
design agrees on the sign and lands above the floor, the second one is the one to read. Nissa ships
at third in the table, in Dawn Tithe's band and under Forge Alliance, with a note in the deck list
that Verdant Guard is the deck to look at if the next change pushes it further.

And the second instrument gap of the session, in the same place as the first: `deck-probe` split
`CHANGE` on commas, and every legendary name has one, so "Nissa, Voice of Zendikar:-1" became two
names it could not find. A `;` in the string now switches the separator for the whole of it. Neither
gap was in the engine — an instrument only ever pointed at the cards it was built for has corners
nobody has stood in.

### An eleventh deck whose plan is its mana, and two things the engine had never been asked

Green-blue was the last colour pair the pool did not use, and the plan is newer than the colours:
every other list spends mana on a plan, and **Delta Bloom's plan is the mana**. Twenty-three lands,
nine accelerants, and a top end of four X spells rather than creatures — which is exactly the
difference between this and Verdant Guard, a deck that ramps into creatures it would have cast
anyway.

Two engine additions, one line each where they are used. An `etb` trigger can watch a **land**
(`what: 'land'`) — the event was always raised for a land entering and nothing could hear it — and
**Tatyova, Benthic Druid** turns every land after her into a card and a life. And a **per-turn extra
land drop** (CR 505.5b), the first permission here that changes what a *player* may do rather than
what a permanent is: `extraLands` sits beside `landsPlayed`, is read by both places that enforce the
rule, and is reset in the untap step. It is read rather than decremented when given, so an Explore
cast before the turn's land and one cast after it both leave you able to play two.

**The first card to hear that event found a bug months old.** Tatyova's first test drew two cards off
one Forest: `auto:playLand` raised `etb` itself and then called `settle`, whose arrivals loop raises
it for everything that arrived. A land played from hand fired the event twice, and nothing in the
pool could hear it, so it sat there. The fix is deleting the raise in `playLand` — the arrivals loop
is the one place that sees every way onto the battlefield, which is the lesson this doc already
recorded when statics and `dies` moved there.

**And a finding about the bot.** The deck's first version ran two Kiora's Followers ("{T}: untap
another target permanent") and `cast-counts` reported the ability used **13,581 times across 120
games**. Two of them untap each other for ever and the board ends where it started; the engine is
right to allow it and a person would never, so the fix is the deck list. One copy has nothing to
untap it: 164 uses in 46 games, about three a game, which is a land untapped once a turn. The
general problem — a bot that will repeat a cycle of legal actions returning the board to its start —
was written down rather than solved here, and is solved in *The cycle that changes nothing* below.

Five new cards for a whole deck: Explore, Tatyova, Kiora's Follower, Pelakka Wurm and a Simic
Guildgate. The ninth deck needed six, the tenth six, this one five.

### A list of your own, and the card the engine is honest about

The table only ever dealt the eleven decks in this repo. Now there is a box in the lobby: paste the
text you keep your deck in — `4 Lightning Bolt`, a Moxfield export with a Commander section, a
sideboard — and play it.

**Two halves, and the split is the design.** The parser is in `@grimore/shared` and **knows nothing
about cards**: counts may be `4`, `4x` or absent, set codes and collector numbers are dropped,
section headers are understood, a sideboard is left out with a word about it. That is what lets the
browser preview a list before the server has seen it and the server validate one without trusting
the browser. The other half is in the engine, because the *pool* is: every name is looked up across
all eleven decks and their commanders, and a hit is the real card — same script, same cost, same
type line, plays exactly as it does in the deck it came from.

**A miss becomes cardboard**: a card with a name and nothing else, which is what a kitchen table is.
Its type line is left **empty** rather than filled in, because a type line the engine invented would
make the card look like something it can reason about. The tabletop plays cardboard perfectly — you
read it off the card in your hand — and `auto:start` **refuses** a table holding any, naming the
card. That refusal is in the engine where it is enforced; the lobby badge ("1 the engine cannot
read") is a report of it, which is D132's rule applied to a refusal. The deck still *loads*, because
loading it is exactly what the tabletop wants.

**What the table learns about your list is its name, its size and that count.** Never its cards. It
is shown to everybody because the host is the one pressing Start, and a disabled button with no
indication of whose deck is the problem explains nothing.

**The id took a second pass.** One shared `custom` worked — `ctx.decks` is built per action and an
action is stamped with its sender, so it always meant the actor's own list — right up until **play
again**, which the engine composes by reloading the deck id each seat already has. The host's
rematch asked for a `custom` only the guest's actions could resolve, so a rematch was refused at any
table where the other player had pasted a deck. The ids are per seat now, and which of them an
action may resolve is the server's decision: its own sender's always, every seat's for a rematch and
only for a rematch, since a rematch takes no id from anybody and cannot be aimed. Otherwise a host
could load the guest's list onto their own seat and read it out of their own library — a test now.

**Proved by playing with one.** `e2e-solo` no longer clicks a deck: it writes Ember Rush's own sixty
cards out as text, pastes them, and plays a whole game against the computer under the engine — the
same game that suite always played, with one thing changed, which is where the cards came from.
`e2e-table` pastes a list containing a card the engine has never scripted, checks the engine is
refused and the tabletop is not, then pastes one without it and plays out a two-browser game on a
deck nobody built into this repo.

### The cycle that changes nothing, and what an untap has to buy

The eleventh deck shipped with a note instead of a fix: two Kiora's Followers ("{T}: untap another
target permanent") untap each other for ever, A taps to untap B and B taps to untap A, and the board
ends where it started. **29,432 activations across 120 games** with two copies; 165 with the one the
list runs. Every step of it is legal and the search is content, because `evaluate` sums material and
which of two permanents is tapped is worth the same either way.

The fix is not "do not repeat yourself" — a Gelectrode pinging twice in a step is the same shape and
right — it is the ritual rule's question asked of a different resource: **what did the untap buy?**
The target has to be tapped at all; then a cast that was not affordable is, or one more creature can
block an attack already on the table, or one more can attack before the swing is declared, or an
ability that does something other than untap or make mana comes back. The last clause is where the
cycle dies: untapping a Kiora's Follower does hand back an ability, and that ability is another
untap, so counting it would make the cycle its own justification.

**Two traps, and the second is new.** The step has to be unchanged, which the ritual rule learned
first. And the stack has to be *empty*, because `simulate` drains it — so with anything on the stack
every sorcery-speed play in hand is missing from the before state and present in the after state,
and the untap takes credit for a Preordain it had nothing to do with. That was the whole of the
first version's surviving 57 activations, 36 of them pointing at a permanent that was already
untapped. Any rule in this family that compares two states has to compare states whose stacks match.

| | activations | record |
| --- | --- | --- |
| one copy, without the rule | 165 | 47-73 |
| one copy, with it | **1** | 52-68 |
| two copies, without | 29,432 | 45-75 |
| two copies, with | **10** | 48-72 |

Paired on identical seeds, 120 games an arm. The records move by five games and three, both inside
the floor: free, with the number written down. It is kept for the first column — a hundred presses a
turn that change nothing looks broken to the person opposite — and nine of the ten remaining
activations with two copies point at a **tapped land**, which is what the card is actually for.

The last row is also the honest answer about this card in *this bot's* hands: one activation in 120
games, because untapping a land only helps a player with a second spell waiting, and this bot cannot
hold mana. That is a reason to leave it in the list rather than cut it — a person untaps a Guildgate
for the Counterspell they are holding — and the deck stays at one copy, since two is four games
worse and four games is noise.

### The spell a trigger is about, a cost with two X's, and a card the bot cannot use

A `spell-cast` trigger has been here since the first red deck and it could say what *kind* of spell
was cast, never which one — so nothing could read a spell's mana value or counter it. It carries
the object now, reaching the ability as `answering`, the channel ward already used. The
intervening-if clause got the same field: it is asked twice (CR 603.4) and the first ask had less
context than the second, which is invisible until a condition needs it. Without it, Chalice of the
Void would put a trigger on the stack for every spell anybody cast and then take it off again —
an opponent responding to a trigger for a spell that was never going to be countered.

And `{X}{X}`, which is one number paid twice (CR 107.3b). `ManaCost` had a boolean; it is a count
now, written only when it is more than one so every cost parsed before reads identically. With
three Islands the table offers X=1 and refuses X=2. Walking Ballista and Hangarback Walker are the
same shape and now need no new code.

**Chalice of the Void** enters with X charge counters and counters any spell — including its
controller's — whose mana value equals that number, read on the stack, which is the one place {X} is
not nought (CR 202.3b). It is in Tidal Mind by arithmetic: four one-mana spells of its own against
twenty-two in Ember Rush. The bot's X is the first in this engine where bigger is worse, so it is
chosen from what the opponents have **shown** — the mana values in their graveyards and on their
battlefields, commonest first, one when they have shown nothing. Public zones only.

**And then the measurement said the card does nothing, for a reason worth keeping.** Over 120 paired
games it reached hand in 25, was cast in 21 of those, and was *never cast before turn fourteen* —
because that is when one copy of a sixty-card deck arrives. Nought games moved against the three
decks it is in the deck for. A rule that cast it before the search saw anything else, written in
the land drop's shape, moved the turn by nothing and was reverted. The slot is −4 of 240, inside
the floor, and it ships: correct, tested nine ways, worth nothing to this bot and a great deal to a
person who casts it on turn two — or who runs four copies of it in a list of their own. Which is
D143's conclusion about Kiora's Follower reached by a second road.

### A counter as a cost, and the counters a dying permanent leaves behind

The `{X}{X}` cost made two famous artifacts expressible, and finishing them needed two small rules.

**A counter as a cost.** "Remove a +1/+1 counter: 1 damage to any target" is the fifth non-mana
cost here, and it is a cost rather than an effect, which is the whole of Walking Ballista: the
counter comes off as the ability is activated, so the Ballista firing its last one is a 0/0 while
its own damage is on the stack above it. The state-based actions kill it and the damage is dealt
anyway (CR 608.2). It also inherits the family rule — a cost that cannot be paid is not offered —
so a Ballista with no counters shows no damage ability at all.

**Last known information** (CR 608.2h). Hangarback Walker makes a Thopter per +1/+1 counter it
*had*, and a card in a graveyard has none, because leaving the battlefield takes them off. Tokens
already had this solved: a token that stops existing leaves its last state in `vanished` for its own
death trigger to read. That now covers every permanent leaving the battlefield, with the same
lifetime, and the one fact the trigger needs rides on the stack object as `subjectCounters` —
because the trigger resolves after `settle` has cleared the map.

| the slot | measured |
| --- | --- |
| Walking Ballista for a third Monastery Swiftspear | **−1** |
| Hangarback Walker for a second Firebrand Archer | **−6** |
| the Walker in Rot Harvest instead | −7 |
| the Walker in Hollow Tide instead | −9 |

All inside the floor, all negative. The Ballista is free. The Walker is not, and this time it is
**not** the bot misplaying it: instrumented, it was cast in 37 of the 40 games it was drawn, 18 of
those on its second turn for X=1 or 2 — what a person does. It is just a grindy card, and a 1/1
that grows is worth less to this bot than a 2/1 that pings. Three homes were measured; it ships in
the least bad one, where the Thopters have a Warhammer and a Hellrider to play with.

That makes three cards in a row whose value a one-ply search cannot realise — Kiora's Follower,
Chalice of the Void, Hangarback Walker — all measured negative-but-noise and all shipped. A pool
containing only what the bot pilots well would be a worse pool for the two people this is for.

### Two things a player does every session

**A deck says what is in it.** Eleven decks offered as a name and a line of prose is a choice made
blind — "blue-black control" does not say whether there is a sweeper in it. The cards were already
in the browser (the table deals from them), so the panel is presentation and nothing else: lands,
creatures, spells, each sorted by cost, the curve drawn as bars, the colours read off the cards.
Shut by default, in both the places a deck is chosen — the pregame picker and the lobby's solo list.

**And the list you pasted is kept.** Pasting a decklist survived exactly one table, which is the
friction that decides whether a feature gets used twice. It is in `localStorage` now and offered
back as one button, with the three properties that come from choosing storage over an account: it
survives a reload and a new table, it does not follow you to another device, and a browser that
refuses storage never offers it. The server keeps nothing it did not already keep.

Checked through a real reload, because that is the whole mechanism. `e2e-table` is at 72 checks.

### The host went first in every game ever played here

`game:start` with no seat named starts seat zero, and the lobby never sent one — so whoever created
the table went first, every time, on every table. Going first is a real edge and this engine knows
it: a rematch gives the previous winner the second turn. The first game was the one nobody rolled
for.

The roll goes in the pod layer rather than the engine, because the engine's default is explicit and
three hundred tests, the rematch and the testkit all lean on it; "the table rolls" is a fact about a
table, and `apps/realtime` is the table. A start that names a seat passes through untouched.
Uniform across seated players, the computer's seats included.

The randomness is an argument rather than a global, so the tests assert the mapping instead of the
distribution — a test that started twenty tables and checked both seats came up would fail one run
in a million for being unlucky, which is how a suite earns a retry flag.

### The number chosen while the spell is resolving

The engine could ask two kinds of question in the middle of a resolution — *which cards* and *which
word* — and Toxic Deluge is neither. "Pay X life. All creatures get -X/-X until end of turn" is a
number, and it is chosen **as the spell resolves**, which is what made it unscriptable until now.

That is not an X cost, and the difference is the card. An X in a cost is announced on the stack, is
part of the spell an opponent is deciding whether to counter, and is locked in before anybody
responds; a Deluge is chosen after every response, from the board as it actually ended up. Holding
one up and choosing four after the opponent flashes in a fifth creature *is* the card, so folding it
into `xMax` would have been a lie about it in the way a player notices.

The card owns the range, computed when the question is asked: nought up to the smaller of one less
than the caster's life (CR 118.4 — a cost that kills you is not one you may choose to pay) and the
biggest toughness on the board, because -9/-9 and -4/-4 kill exactly the same creatures when
nothing has five toughness. A range with one answer in it is not a question — the engine takes it
and carries on. The table draws a row of numbers, and nothing but the numbers the engine said were
answerable: `auto:decide` refuses a number outside the range, and the browser's reducer refuses it
before it ever gets sent.

**And then the instrument found something the record did not.** Over 120 Hollow Tide duels the bot
cast the Deluge 18 times and chose well — 30 of the opponent's creatures dead against 3 of its own —
but **three of those casts chose nought**, which is a card put in the graveyard to do nothing at all.
The search cannot see that, for a structural reason rather than a missing term: a cast puts the
spell on the *stack*, the number is not chosen until it resolves, so one ply out the board after the
cast is the board before it plus a stack object. So the twelfth member of the "spent on nothing"
family, and the first about a question rather than a play: if the card's own answer is the bottom of
its own range, casting it is not a play. Same 18 casts afterwards, none for nought, and three more
of the opponent's creatures dead for the same three of its own.

The slot measures **−3 of 240** against the field, paired on identical seeds, and the drop rule
moved it by exactly nothing — 81-159 with the Deluge and 84-156 without it, the same in both runs,
every per-opponent row identical. Both numbers are
far inside the eighteen-game noise floor, which is the fourth card in a row to measure that way
(Kiora's Follower, Chalice of the Void, Hangarback Walker) and for the same reason: a one-ply search
cannot realise a card whose value is in *when* you cast it. The rule is kept anyway, on the same
grounds as the untap cycle: a bot that spends a card to choose nothing looks broken to the person
sitting opposite, and three more dead creatures for the same life is not worse.

**And two races in `e2e-table`, found by running it against a stack that had just started.** Both
were in the test rather than in the table, and both were the same mistake: a check that presses a
button on every retry. The reclaimed-seat check clicked *life down* and demanded exactly one less,
so a click slow to land was clicked twice and the one number it would accept was already behind it;
it now reads before it clicks, accepts any decrease as proof the seat can act, and puts the total
back where the reload found it. The search check pressed a *toggle*, so a second press shut the
drawer it was waiting for; it now lets the library decide, reads the button's own label to see
whether a press is still wanted, and gives a press a second and a half to land. Seventy-three checks
now, and green on a cold stack as well as a warm one — which is the run that found this.

### The target chosen while something resolves, and the copy that is not a card

Three shapes of mid-resolution question existed — which cards, which word, which number. "You may
choose new targets for the copy" is none of them, and it is the clause every printed copy effect
ends with. Strionic Resonator arrived without it and said so: the copy kept whatever the original
chose, and a copied Gravedigger trigger pointing at a card the original had already returned was
countered for having no legal target. That limitation was a test. It is now the test one line above
the one that undoes it.

The question is asked about the object being **copied**, not about the copy. A copy's
characteristics are the original's (CR 707.2), so the legal targets are the same set — which means
the answer can be handed to the copy as it is made, rather than making one aimed at the old target
and re-aiming it. Only a single-target object is asked about, which is the restriction Swerve and
Willbender already live under and a sharper one here: the rules copy a divided quantity as it was
divided (CR 706.10c), and "choose new targets" is not permission to re-divide. No targets, several,
or one legal target and it is the one already chosen — all three are no question at all.

And the thing that makes a *spell* copy different from an ability copy: **a spell is a card and the
copy is not.** A spell's stack id has always been its card instance, so the copy takes a new id,
keeps `source` pointing at the original's card, and has no instance — which is how the resolution
knows to run the effect and let the copy cease to exist instead of putting a second card in a
graveyard it was never in. Three things follow and all three are asserted: the copy is **not cast**,
so Arc Tempest's Guttersnipe does not fire for it (ten damage, not twelve); the copy leaves no card
behind; and the copy **can be countered**, which needed a second fix nobody would have found without
the first — spell targets were read out of the stack *zone*, which holds cards, so a copy was
invisible to "counter target spell". They now come off `stackOrder`, which is the shape the
abilities already used, and a real Counterspell countering a real copy is the test.

**Twincast is the card, and where it goes was measured twice.** It went into Arc Tempest first and
cost about nine games in 240 whatever it replaced (−8 and −10 in the Lava Spike's slot on two seed
sets, −9 against a second Faithless Looting). The instrument said why: 23 casts across 120 duels,
seven of them copying a *cantrip* — four mana for one card in a deck whose clock starts on turn
three. In **Tidal Mind** it measures −4 of 240, inside the floor, and the usage is different in
kind: 7 casts in 120 duels, **all seven copying the opponent's spell**, with three of four
new-target questions moving the copy. Rarely, and for the thing the clause is printed for. The cut
inside Tidal Mind the instrument could not call (two games between two cuts), so the rule did: Turn
to Frog is the only card in any deck covering the characteristic-setting layer, and cutting it would
take a rule out of the game rather than a card out of a deck.

**And a test that had quietly been assuming the host went first.** `e2e-table` failed one run in
three on "passing the turn moves it to the other player" — not because passing was broken, but
because the roll added two days earlier (the table now rolls for who starts) meant Nick sometimes
pressed Pass turn on a turn that was not his. The turn moved *to* him and Friend was never told
anything. The check reads which page says "your turn" before the press now. It is worth recording
that the first fix tried was a longer timeout: the failure looked exactly like a socket that had
not delivered.

**One case the bot gets wrong, knowingly.** A copied Gravedigger trigger has both corpses in the
bot's own graveyard, so its ranking sees two of its own cards, ties, and declines — and then the
copy returns the card and the original is countered for pointing at an object that has changed
zones. One creature back instead of two. Answering it needs "would declining make the original
fizzle", which is a question about what the copied effect does rather than a fact about the board;
the card the measurement is about is the other one, and there the bot's answer is right. A person
answering gets both creatures, which is a test.

**One gap, stated rather than papered over.** The table's new row — one button per target and
**Leave it** — is covered by the reducer's own tests and by the engine's, but not by a *fixed*
browser check, because a browser suite plays a real game and this card comes up in seven games in a
hundred and twenty. It is driven when it does come up: the pod suite caught the hole the hard way,
with a seat "stuck at Draw on turn 43" whose table was showing a Strionic Resonator's copy waiting
to be aimed and whose driver had never heard of that row. The same hole was already there for the
*number* prompt added one change earlier and had simply not come up yet. Both are answered now, and
the rule is written down as D152: a question added to the table is three places, not two.

One prediction worth recording as wrong: the card's own comment, written before any of this ran,
said the computer would be poor with it because copying needs mana held through somebody else's
turn. It does not — a seat's lands are already untapped on an opponent's turn and the engine taps
for a cost as it pays it. The bot used the card three times more than expected, and badly, which is
a different problem from the one that was predicted.

### What a spell costs is a question about the board

The engine could *replace* a cost — flashback, foretell, morph — and the command zone could tax
one. What nothing could do was reach a card in somebody's hand and make it cheaper or dearer, which
is the whole "costs {1} less" family and one of the most common static effects printed. So a Goblin
Electromancer was unwritable, and so was every card that taxes.

It is one declaration (`costModifiers`) and **one function with two callers**: `legalActions` asks
it what a cast costs and whether this seat can afford it, and `castSpell` asks it what to charge.
That is the rule convoke, crew and morph are built on — a table that offers a spell for two and then
takes three is a table nobody can play on — and it is why this is a dozen lines in two places rather
than a cost calculator on each side.

The rules that travel with it: only **generic** mana moves (CR 601.2f), so an Electromancer leaves
Counterspell at {U}{U} and Lightning Bolt at {R} and takes Arc Lightning from {2}{R} to {1}{R}; the
generic floors at nought and stops; increases and reductions net out with a single floor, which is
the answer the rules' staged order gives; the commander tax goes on *before* a reduction comes off;
and a face-down permanent contributes nothing, because it is a 2/2 with no text (CR 707.2). The
printed cost is never rewritten — the play carries the change beside it and the sheet draws "−{1}",
so what the card says and what you are paying are both on the screen.

**Both cards measure free, and the instrument says what they actually did.** Goblin Electromancer
into Arc Tempest for the second Stormchaser Mage: **−2 of 240**, and over 120 duels the deck cast
1390 spells of which **24 were discounted**, saving 24 mana — about one cast in sixty, because one
copy in sixty cards has to be drawn, survive, and then meet a spell with generic in it. The cards it
cheapened read like the deck's own curve: Behold the Multiverse ten times, Arc Lightning five,
Swerve four.

Thalia into Skyward Writ for the Youthful Knight: **−4 of 240**, and here the instrument found the
more interesting thing. Over 120 duels she taxed **85 of the opponent's spells and 70 of her
own** — an asymmetry of fifteen spells in a hundred and fifty-five. Skyward Writ is the white deck
with the fewest noncreature spells in the pool (seventeen against a field averaging twenty), and a
symmetric tax is *still* nearly symmetric. That is the honest read of a hate card in a 60-card
starter pool rather than a constructed format: the tax is real, both players pay it, and the margin
is thinner than the deckbuilding argument suggested.

### Evasion the engine never had, and a slot the instrument moved

Flying, reach, menace, protection, and one card that cannot be blocked by Walls — that was all the
evasion in the pool. Two families were missing, and they are not variations of each other.

**"Can't be blocked"**, full stop, is one flag on the attacker and one line in `canBlock`: nothing
on the blocker's side answers it. **Landwalk** (CR 702.14) is the only evasion in this engine whose
answer is somewhere else entirely — every other check compares the attacker with the blocker, and
islandwalk compares the attacker with the *defending player's lands*. It is a list of subtypes
rather than a keyword, because a keyword is a fact about a creature and this is a fact about
somebody else's board at the moment blockers are declared.

**Tormented Soul** ({B} 1/1, can't block and can't be blocked) went into Ashen Rite, and the
instrument is unusually clean: over 120 duels it was drawn in 78 games, attacked **104 times, and
not one of those attacks could have been blocked by anything the other player controlled**. The
card does exactly what it says, every time. It still measures **−10 of 240**, because what it
replaced — a Goblin Arsonist, in a deck with three Blood Artists — was a death trigger this deck is
built to care about. Cutting a Doomed Dissenter instead measured three games worse, so the Arsonist
cut is the better of the two and the card ships at a price that is written down.

**River Boa** ({1}{G} 2/1 islandwalk, {G} to regenerate) went into Verdant Guard, and here the
instrument moved the slot. Islandwalk turned on in **10 of its 20 attacks** — five of the eleven
decks run Islands, and the measurement matched the deck list almost exactly. The first cut, a second
Journey to Nowhere, cost eight games of 240. Cutting the **Rampant Growth** instead came back nine
games better, so that is the slot it ships in — and the shipped deck was then priced on its own
terms: 157-83 with the Boa against 148-92 with the Growth put back, **+9 of 240** for the card. Nine
is half the noise floor, so the honest claim is not "better" but **free**: the Boa pays for itself
in the slot it is in, and that is all 240 games can say. The reading is about the cut rather than
the card: a deck with five other answers to one creature can spare neither a sixth nor its ramp
cheaply, and only the instrument knows which. The Growth is not lost — Delta Bloom runs two, which
is the deck ramp belongs to, and the six tests that had been pulling it out of Verdant Guard's
library now pull it out of Delta Bloom's.

One thing the engine already did right, found while writing the tests: an attack by a single
unblockable creature is **not a decision**, so the defender is never asked to block it. Proving that
a block *is* refused needs a second attacker to make blocking a real choice.

### The two triggers combat never raised

Combat raised one event — an attack was declared — and nothing that happened afterwards. A creature
blocking and an attacker getting through were invisible to every script in the pool, which rules
out a shelf of printed cards and both of the ones here.

**"Whenever ~ blocks a creature"** is somebody else's declaration, made a step later. The blocking
creature is the subject and the attacker it blocked travels on the event, because by the time the
ability resolves the board says only that the Wall is blocking *something*. It fires once per
block, so two Walls on one attacker put two triggers on the stack. **"Whenever ~ attacks and isn't
blocked"** cannot be a filter on the attack event at all: when attackers are declared nobody has
blocked yet, so the answer does not exist. It is raised once every defender has spoken.

**Wall of Frost** ({2}{U} 0/7 defender) needed one more thing the engine had never had: "that
creature doesn't untap during its controller's next untap step". That is a flag on the permanent
rather than a continuous effect, because nothing about a frozen creature is *different* — same
power, same abilities, same keywords — and the only thing in the game that reads it is the untap
step, which clears it as it declines to untap. Over 660 games the Wall blocked 47 times and froze
46, every one of them a creature that was already tapped (attacking taps it), and **34 of those
were still tapped when their controller's next turn came round**: 34 turns taken off an attacker.
In its slot — the deck's second Fog Bank — it measures +4 of 240, which is free rather than better,
and keeping one of each is deliberate: the Bank is the better answer to one huge creature, because
toughness does not matter to it.

**Ophidian** ({2}{U} 1/3, "you may draw a card; if you do, remove it from combat") is the decision
half. It attacked 41 times, got through 25 of them, and the bot drew the card 24 times and kept the
damage once — and the once is the honest part: the board that said "attack" was a lethal swing,
which is exactly the case the card asks about. Anybody reading it as a hard choice every turn would
be wrong, and the measurement says so rather than the write-up guessing. In its slot (a Child of
Night, the weakest card in a deck that wins on cards rather than on life) it measures +3 of 240.

Two things worth keeping from the build. The first is a **bug the Ophidian found**: a seat can come
to have declared blockers in two different places — it said so, or it had nothing that could
legally block and the step declared for it — and the first version raised the unblocked event only
in the first place. So an Ophidian attacking into an empty board, the one board where it is certain
to get through, triggered nothing. The second is that **the instrument was wrong before the
mechanism was**: the first measurement watched for the untap step and reported zero freezes held,
and nobody ever holds priority in the untap step, so the check could never have fired. 46 freezes
and none of them holding is not a story about Magic, which is the only reason it was caught.

### The trigger that happens later

Every trigger in the engine fired the moment its event happened, which left a whole shelf of
printed text unwritable: "destroy that creature **at end of combat**", "return it to the battlefield
**at the beginning of the next end step**". A delayed trigger (CR 603.7) is now an ordinary entry in
the card's own triggers, marked so the event path never fires it, plus a scheduled record on the
state that the named step drains exactly once.

It cannot be a step trigger with a flag: a step trigger fires every turn for as long as its
permanent is on the battlefield, and this fires once whether or not the permanent is still there.
That last part is a rule rather than a convenience — a **Flickerwisp** ({1}{W}{W} 3/1 flying, "exile
another target permanent, return it at the beginning of the next end step") can be killed before the
end step and the card still comes back, because the delayed ability stopped belonging to it the
moment it was created. The pool now holds both halves of that distinction: a Journey to Nowhere
keeps its creature only while the Journey lives, and a Flickerwisp's blink survives the Wisp.

The table says what is coming. A delayed trigger is the one thing on the board that is going to
happen and is not on the stack, so the stack panel draws a **later** row under it with the step —
"destroy Centaur Courser · End of combat" — for the same reason the prevention shield and the freeze
are drawn: a board that changes two steps later with nothing on screen to have warned anybody is a
board nobody can plan against.

**The two cards came back differently honest.** Over 660 games, 33 delayed triggers were scheduled
and 32 fired. The Flickerwisp blinked **43 permanents and every single one was an opponent's** — 36
creatures, six lands, one artifact — which is the lookahead working with no help at all: the card
carries no hint about what blinking is *for*, and the search still never pointed it at its own
Plains. It measures **0 of 240** in its slot, exactly level, with eight of ten matchups identical
game for game: a blink that gives the permanent back a step later is one turn of tempo, and one turn
of tempo against this field is worth nothing measurable.

**Thicket Basilisk** is the other kind of answer. It was on the battlefield in 42 games and its
clause fired **three times**, for one kill. That is not a bug and not a dead card — a creature that
destroys whatever it fights is a *deterrent*, and a deterrent is invisible to an instrument that
counts what happened. What the measurement can say is that the clause almost never resolves, so in
practice the card is a 2/4 for five; it prices at **−1 of 240**, which is the same answer from the
other side. Whatever it is worth in attacks that were never declared is not something this
instrument can see, and saying so is better than claiming it. What the card does earn outright is
the engine path: `becomes-blocked` has a card behind it now, and so does the delayed trigger.

### The crown, which was a sticker and is now a rule

`monarch` has been a field on the game state since the tabletop was written, with a button anybody
could press and nothing in the rules touching it: no card gave the crown, combat damage did not take
it, and the monarch never drew a card. All three of those are now the engine's.

Only one of them belongs on a card. "You become the monarch" is one line in an effect; the extra
card at the beginning of your **own** end step and the crown going to whoever deals you combat
damage are rules of the game, so they sit beside the other turn-based actions. The steal is applied
where the engine drains the list of combat damage that actually *landed*, so a swing a Fog or a
prevention shield stopped takes nothing and steals nothing — one list, one answer to "did it
connect". Both are applied immediately rather than as triggered abilities, which is a simplification
written down rather than hidden: at a real table a Disallow could counter the crown changing hands,
and nothing here can put an ability on the stack without a card to own it.

The button is refused once the engine is running, because a designation the rules move cannot also
be something a player sets by hand. On a tabletop it is exactly what it was.

**Two cards, and the instrument liked one of them.** Over 660 duels a crown existed in 57 games —
given by a card 57 times, **stolen in combat 142 times**, and drawing 74 cards in all. That ratio is
the whole character of the mechanic in a duel: it changed hands nearly twice as often as it drew
anything, so it is less a card engine than a reason to attack. **Palace Sentinels** in Dawn Tithe
measures +15 of 240 — under the noise floor as a total, but not one of the ten matchups moved the
other way, which is a sign test at about p=0.004 and the kind of evidence a single total cannot
give. It takes that deck from 57% to about 63%, third in the pool and inside the existing spread.
**Thorn of the Black Rose** in Ashen Rite measures −2 and ships because it costs nothing: the
argument for putting the crown in the deck with an unblockable creature (it can always take it back)
is also the argument against (an aggressive deck is the one most likely to be hit back).

One number is in the log for being striking rather than causal: the winner held the crown at the end
in 53 of the 57 games it appeared in. That is the winner taking the crown, not the crown making a
winner — stealing it requires connecting, and connecting is what winning looks like.

What is left undone on purpose: in a duel there is one player to attack, so the bot takes the crown
142 times without being taught anything. In a pod, "prefer the player holding the crown" would be a
bot rule worth having, and the measuring harness is duel-only — so it stays a question rather than
becoming an unmeasured weight.

### An instrument for the pod, and the trap in its own control

Every measuring harness in this project was a duel, and a duel cannot answer a question about
*which opponent*. Goad, the three deals, the threat read and now "attack the player holding the
crown" had all been argued rather than priced. `scripts/measure/pod-duel.mjs` closes that: two bots
against two in a four-seat pod, four rotations per table so each arm plays every seat, and
`ALWAYS=<deck>` to seat the deck that can produce the thing being measured.

**Its negative control is a tautology, and the first draft of its documentation claimed it as a
floor.** With both arms empty all four rotations are the same game, so the same seat wins all four
and the rotation credits it to each arm exactly twice: 66-66 of 132, and it could not have been
anything else. The floor has to come from somewhere else — re-running a real arm on a different seed
set — and that is now written at the top of the script, because a 50-50 control that *looks* like
evidence is worse than no control at all.

**The rule it was built for measures nothing.** Turning off "chase the crown" came back 70-62 one
seed set and 62-70 on the next: the sign flips, so this harness wobbles by at least ±8 games in 132
and the rule is level. It ships on anyway, and the honest reason is not the number. It is a fact
about the board rather than a weight — the monarch draws a card every turn and combat damage is the
only thing that takes the crown — and it makes the bot **legible**: a pod where nobody ever contests
the crown looks broken to a person who knows the rule, and a table that plays its own mechanics
visibly is most of what "this feels like a real game" means. That is a fine reason to ship something
as long as it is said out loud instead of dressed up as a win.

### The second way to lose a game of Magic

Poison counters, `-1/-1` counters and the ten-poison elimination have been in this engine since it
was written, and not one card in the pool produced a point of any of them. Infect (CR 702.90) is the
keyword that connects the three, and it is a damage **replacement** read off whatever is dealing the
damage: a player takes poison instead of losing life, a creature takes `-1/-1` counters instead of
marked damage, and a granted keyword works for free because the branch asks the source's current
characteristics rather than its printed text — which is the whole of Tainted Strike.

**It needed a deck, not three cards.** Ten poison takes bodies that connect over and over, so one
infect creature in a sixty-card list is a bad card rather than a plan. **Blight Vector** is the
twelfth deck: eighteen infect cards, eight of them new, Skithiryx leading it, and the other half of
the list spent entirely on making 1/1s connect. Two things make it real rather than cute. `-1/-1`
counters are **permanent** where marked damage is wiped every turn, so blocking a 1/1 with infect
costs a 3/3 a point of size for the rest of the game; and Phyrexian Crusader's protection from red
and white walls off where nearly all of this pool's cheap removal lives.

**The win condition is reached, not theoretical.** Over 132 duels poison was dealt in **80% of its
games**, and **every one of its wins was a poison elimination** — none by damage. The deck itself
lands eleventh of twelve at 38%: it beats Tidal Mind 15-9, loses 3-21 to Ember Rush, and every
creature in it dies to one blocker. That is an archetype with matchups rather than a strong deck, and
it is the honest result for a pile of 1/1s in a field with a 78% aggro deck in it.

**Infect found a bug that had been in combat since combat was written.** The damage step read each
blocker's power *after* the attacker's damage had landed, so a creature that had just been shrunk hit
back for less — against CR 510.2, which makes combat damage simultaneous. Nothing in the pool could
change a creature's size mid-step, because marked damage does not, so for two hundred and fifty
cards the two readings agreed exactly. The first test written for a `-1/-1` counter watched a 3/3
Centaur Courser deal one damage instead of three. The fix is a snapshot of every combatant taken
before any damage is dealt, and the lesson is worth more than the fix: **a rule that is only ever
asked where two readings agree is a rule nobody has tested.**

**And the twelfth deck exposed a maintenance bug in the instruments.** Seven of the twelve harnesses
in `scripts/measure/` had the deck list written out by hand, so the first table run after the new
deck quietly measured the same eleven-deck field as the day before. They all read the registry now.
A list in seven files is a list that goes stale in six of them.

### The worst deck in the pool, and the one card that was most of it

The table had said the same thing three times — Tidal Mind last, 22%, sixteen points behind the next
deck — and three write-ups had noted it without anybody acting. The diagnosis took one run of an
instrument that already existed: `cast-counts` put **Diabolic Tutor at 17%**, cast in 8 of the 46
games it was in hand, the deadest card in any deck in the pool. Four mana for a card you then have to
cast is a turn spent doing nothing, and a deck that spends turns doing nothing against a field with a
77% aggro deck in it dies holding answers.

A **third Vampire Nighthawk** in its place measured **+27 of 264**, nine matchups up, two level, none
down: the largest and most consistent slot change this project has measured, and it takes the deck
from 22% to 27%. The Tutor moved to Hollow Tide, where a tutor has two cards worth finding, and cost
that deck one game of 264.

**Six other candidates were priced and six did nothing** — a second Wind Drake (+2), a third
Man-o'-War for the Twincast (−5), Cancel for a Man-o'-War (−6), a second Dirgur Nemesis (−2), a Swamp
for an Omenspeaker (−19) and a **fourth** Nighthawk (−13). The last two are the ones to keep: cutting
a land from a 21-land control deck is a mulligan rather than a tempo gain, and the fourth copy of the
card that was worth +27 is worth −13. The rest of the list is not the problem; the pilot is, and that
was already written down twice.

**And a measurement trap worth more than the deck change.** The first version of the edit moved the
Nighthawk entry to where the Tutor had been, and the same sixty cards measured sixteen games worse
than the variant the probe had approved: a library is expanded in **list order** and shuffled
afterwards, so the same multiset in a different order is a different sequence of shuffles.
`deck-probe` adjusts counts in place, so a measured change has to be applied in place too. It is now
written in the deck list at the slot where it happened, because the next person to ship a measured
change will make exactly this mistake.

**Moving one card between two decks failed three tests, and all three deserved to fail.** A Diabolic
Tutor script test, the whole-game test that asserts the bot answers mid-resolution questions in the
direction that helps it, and the view-payload budget test had each named `tidal-mind` as "the deck
that has a tutor in it". A fixture that quietly stops containing the card the test is about leaves
the assertion passing on nothing, so they now name the deck that runs the card, and the
mid-resolution one names both on purpose: Tidal Mind for the Mind Rot that asks a player to discard,
Hollow Tide for the Tutor that asks its controller to search. The new matchup then found a real bug
in that test's instrumentation — it read the chosen card's cost out of the state *after* the answer,
which throws the moment the choice is a token, because a token that reaches a graveyard ceases to
exist (CR 111.7) and Talrand's Drakes are in this field now. It reads the state the question was
asked in instead. The wire peak moved with the deck: **25.7KB packed, 55.6KB inlined**, against a
64KB cap.

### A card with two halves you can cast

Four cards wanted a mechanic the engine had no shape for: one piece of cardboard with **more than
one castable face**. A split card — **Fire // Ice** — is two spells and is never cast as itself. An
adventurer — **Garenbrig Carver // Shield's Might** — is a creature card that can instead be cast as
an instant, which then exiles itself and may be cast as the creature later.

**It cost one line in `characteristicsOf`.** A card instance gained `castAs`, a definition key read
in preference to its own for as long as the card is on the stack, and `relocate` clears it on every
other zone change. That is exactly the rule (CR 708.4: a spell on the stack has the characteristics
of only the half being cast), and with it everything else came for free — the cost paid, the timing,
the targets offered, the script that resolves, and what a counterspell is allowed to point at.
"Counter target creature spell" misses an adventure's instant half and catches the creature off that
one line, with no reader knowing two-faced cards exist. The card in the graveyard afterwards is the
whole card again: a Fire // Ice cast as Fire is a *four*-mana card in the bin, which is what a
Chalice of the Void counts.

The two refusals are the opposite mistakes, and both are said out loud: a split card cast with no
half named is refused rather than falling back to the first half, and a card with no second face
refuses a half outright. An adventure that **resolves** is exiled with a flag that makes the creature
castable; one that is **countered** goes to the graveyard, because it never went on an adventure.

**`halves-use.mjs` is the instrument, and it found three different things in 660 games.** Garenbrig
Carver is the mechanic working as printed: 65 adventures cast, and the creature came back out of
exile **62 times (95%)**. Wax // Wane casts Wax 23 times and **Wane zero** — "destroy target
enchantment" in a pool with four enchantments in it is a half that is usually not castable, which
the script said before the instrument measured it. And Merfolk Secretkeeper is the opposite
surprise: 62 casts as the one-mana 0/4 and **one** as the mill-four, which is a fact about the bot's
evaluation rather than about the card.

**A half nobody casts is not the same as a bad card.** Wax // Wane measured **+19 of 264** against
the field — nine matchups down for the old list, none up by more than one — because the half it does
cast is better than the Naturalize it replaced. The other three are inside the duel floor: Garenbrig
Carver +5, Merfolk Secretkeeper −2, Fire // Ice −8. The twelve-deck table is unmoved at 28%–78%.

**One harness bug fell out of it.** The arena browser suite asks for a combat arrow only when a
creature actually attacked — and the flag carrying that condition was set by `declared 0 attackers`
too, which is a real answer on every turn whose creatures are all summoning-sick. The check could
therefore fail on a game that was fine, and once four deck lists moved the shuffle, it did. It now
needs at least one attacker, and skips the three-second wait for the overlay on an empty
declaration.

**And the cut was not the slot the cast-count pointed at**, which is the lesson worth keeping. Arc
Tempest's deadest card is the Squelch at 19%, and cutting it would have taken the pool's only
"counter target activated ability" out of every deck — a script, a definition and three tests
orphaned to buy one slot. The Shock went instead: cast in nine games out of ten and still the
weakest card in a deck holding two Lightning Bolts, two Lightning Strikes, a Lava Spike, a Burst
Lightning, two Magma Jets and a Firebolt. Cast rate measures how often a card is *castable*, not how
much it does when it is.

### The land on the back of a spell

The third kind of two-faced printing, and the one a person notices across a whole game: a **modal
double-faced card** (CR 712) with a spell on the front and a land on the back. **Hagra Mauling //
Hagra Broodpit** is in Ashen Rite and **Vastwood Fortification // Vastwood Thicket** is in Blight
Vector, and the card is whichever of the two the game asks for — a Murder, or the land the deck's
eighteen were one short of.

**It is a `defKey` swap, not a third mechanic.** The field D160 added describes a card *on the
stack* and is cleared as it leaves, which is right for a split card and wrong for a permanent: an
MDFC that arrived as its back face is that face for as long as it is on the battlefield. The
mechanism that already does exactly that is the one copy effects use — `defKey` for what it is now,
`printedDefKey` for what it is printed as — so `playLand` sets both and everything downstream works:
the land's mana ability, the fact that it enters tapped, and the card in the graveyard afterwards
being the front face again at mana value three (CR 712.4a). Sixty-three places in the engine look a
definition up from an instance; none of them changed.

**The bot's land tie-break had the same bug twice.** "Play the land that is ready now" read
`entersTapped` off the card rather than the face, so a Hagra Mauling looked like an untapped land and
got played over a basic Swamp that was free. Reading the face makes it play correctly for nothing:
the basic first, and the flexible card kept in hand until there is nothing better.

**And the measurement is the cleanest this project has taken.** `halves-use` now counts the land
plays too, with the number that matters beside them — whether the hand held another land at the time:

```
Hagra Mauling (ashen-rite, modal) — cast 60 over 60 games
  Hagra Mauling              30 (50%)  mean turn 10.6
  Hagra Broodpit             30 (50%)  mean turn 7.8
  played as a land with no other land in hand    30 of 30 (100%)
```

Thirty land drops the deck would otherwise have missed, no tapped land ever played over an untapped
one, the land down on turn 7.8 and the spell cast on 10.6. And `cast-counts` reads the card at
**100%** — used in every one of the 50 games it was in hand, which makes it the first card in the
pool that is never a dead draw, because its worst case is a land.

Both slot changes are free: +2 of 263 for Hagra Mauling over Ashen Rite's Read the Bones, −4 of 264
for Vastwood Fortification over one of Blight Vector's two Titanic Growths, both inside the duel
floor, and both slots used more often than the cards they replaced. The twelve-deck table is
unmoved at 28%–78%.

### A static that comes and goes

Every continuous effect in the engine had the same life: created, applies for a duration, expires.
**Metalcraft** is a different shape — "as long as you control three or more artifacts" — and the
difference is that nothing turns it on. The board changes and the creature is a 4/4; something
leaves and it is a 2/2 again, with nothing announced and no trigger to watch.

`ContinuousEffect.while` is asked every time the effect is read, which is what `definesSize` already
does for a size that is a count of the board. **Data rather than a predicate**, because
`state.effects` is part of the game state and the state goes to Redis — a function there would not
survive the trip. And counted off the **printed** type line, which is load-bearing: the check runs
inside `characteristicsOf`, so asking a permanent for its current characteristics there would
recurse until the stack ran out.

Three cards into **Forge Alliance**, which already controlled ten artifacts and counted none of
them: **Chrome Steed** (+2/+2 while it holds), **Etched Champion** (protection from all five
colours, which is the keyword half of the same machinery), and **Galvanic Blast** — one damage or
four, read **once** as the spell resolves. The Blast is the contrast worth having: a condition only
needs to live in the effect when the thing it controls persists, and answering an artifact while
the Blast is on the stack turns it back into a Shock. The two creatures are artifacts themselves, so
the deck's count went from ten to twelve: the cards that read the condition are part of meeting it.

**`metalcraft.mjs` is the new instrument, and the mean beside the share is the half that matters.**
Over 660 games Chrome Steed is on the board 152 turns and the condition holds on **56%** of them,
**mean artifacts 2.6** — "nearly there, often". The same 56% on a mean of 0.8 would be "never close,
occasionally lucky", and those are two different cards to fix. Galvanic Blast deals four damage on
21% of its casts, which is an honest reading of a one-mana spell rather than a complaint.

**The bundle is free rather than good, and three seed sets is how that got said.** Two paired probes
measured +9 of 264 and +8 of 263; the twelve-deck table, on a third seed set, puts Forge Alliance
four points *lower*. All three are inside the 18-game floor, so the change is unmeasurable — and
recording the −12 beside the two positives is the only honest way to report it.

**Three traps in the instruments fell out of measuring one change**, and all three are now in
`scripts/measure/README.md`: a 1-of's "in hand" count is a fact about a handful of *shuffles* rather
than games (at four seeds two 1-ofs in one deck read 54 and 4; at twelve, 84 and 29); Forge
Alliance's **Disrupt Decorum reads 0%** and is not dead — goading is a pod card and this harness
plays duels, so a cut on that reading would have removed the pool's only goad card for being
unmeasurable; and "cast every game" is not "does what it says" — Etched Champion is cast in 28% of
the games it reaches hand while its ability is live on 69% of the turns it is out, which is a card
that is strong for a person and weak for this opponent.

### The thirteenth deck, and the gap only a card could show

Twelve decks covered every pair of colours but one. There was no **red-green** deck, and nothing
noticed until a card had nowhere to live: Assault // Battery is {R} on one half and {3}{G} on the
other, so when the split cards shipped, Fire // Ice went into Arc Tempest, Wax // Wane into Verdant
Guard, and the third card of the cycle was left out because no deck could cast both halves. A hole
in a card pool is easier to see from a card than from a list of decks.

**Kindle Grove** is eight new cards and **no new machinery**, which is what the entry is really
about. Ruric Thar, the Unbowed is a `spell-cast` trigger plus `mustAttack` on an `all-creatures`
scope; Gruul Ragebeast is the `etb` event's `subject` plus the same `fight` Prey Upon already had;
Rancor is a `dies` trigger on a permanent that is not a creature (and is a `to-graveyard` trigger
now — see *Rancor, from anywhere* below); Thragtusk is `leaves`, which fires for exile and bounce as
well as death. The only refactor was pulling `fight` out of Prey Upon so
both cards share it — both powers have to be read before either is dealt, and writing that twice
gets the simultaneity wrong eventually.

**Two bugs, both in the engine's edges rather than in the cards.** `raise` leaves `actor` off a
stack object when the actor is the trigger source's own controller, which was free while every card
asking "that player" asked about an opponent — Ruric Thar taxes the table **including its own side**,
and the first version dealt no damage at all to its controller. And `makesMana` is for a spell whose
*whole* effect is mana: declared on Burning-Tree Emissary it made the bot hold a 2/2 in hand waiting
for something to spend the mana on. Measured both ways on the same 192 games: **46% cast with the
flag, 101% without**.

**It debuts fifth of thirteen at 59%**, and the row is its matchups: Tidal Mind **20-4**, Ashen Rite
19-5, Rot Harvest 17-7, both mill decks, and 10-14 against each of the three decks above it. A
commander that costs the whole table six life per noncreature spell is close to unanswerable for
three control decks and four turns too slow against the 76% aggro deck. The limit was written into
the deck before it was measured, which is the only honest way to publish a 59%: the computer plays a
deck of big creatures better than it plays a deck of answers, so this reads higher than a person
would make it.

### Evasion priced against the board: built, measured, deleted

The evaluation prices flying at a flat 1.5 whatever is opposite it, and that is two different cards:
a 2/2 flier against a board with no flying and no reach is an unanswerable clock, and the same 2/2
against two Giant Spiders is a 2/2. Nothing in the evaluation could tell those boards apart, which
is the first thing a person reads off a battlefield — so it was built: a creature with flying that
the opponents cannot block, or one that cannot be blocked at all, worth **its power again** times a
weight, computed once per seat rather than once per creature.

**Level at 0.5, 1.0 and 2.0**, on the paired bot-against-bot instrument over 936 games a run:
467-469 and 470-464 on two seed sets at 0.5, 471-465 at 1.0, 468-468 at 2.0 — against a negative
control of exactly **468-468**, which is what makes those rows readable rather than arguable. And it
is a genuine wash rather than a setting that never fired: `disagree.mjs` says **83 of 30,176
decisions differed**. It also costs about **8% of the decision time** (157s against 169s, identical
arms, identical seeds).

So it is gone, with its numbers kept in `claude/decisions-log.md` beside the five terms deleted
before it. The lesson is narrower than the idea that motivated it: the bot's attacks and blocks
already ask whether a creature can be blocked — `canBlock` knows — and what the evaluation was
being asked to add is a judgement about the *next few turns*, which a bot that cannot plan a turn
ahead has nothing to do with.

### The mill deck does win by decking, and the instrument came with the fix attached

Drawing from an empty library has been an elimination since the engine was written, and Hollow Tide
is thirteen cards' worth of trying to cause it — but nobody had ever measured whether it happens.
Poison got an instrument the day it shipped; milling had gone five deck revisions without one.

**It happens, and the deck's problem is somewhere else.** Over 144 games the deck milled 18 cards a
game and **half its wins were already empty libraries** (23 of 48) — a second archetype rather than
a theory. And at the same time **the opponent's library was still at 24 on average when the game
ended**. A deck that leaves its win condition at 24 is not short of mill; it is short of turns, and
that is a hypothesis no win-rate can produce.

So the two candidates were priced against the same cut: a fourth Mind Sculpt at **+12 of 288**, a
third Fog Bank at **+16** and **+23** on a second seed set. Four games between the two adds is deep
inside the floor, so the probes alone say "most of the gain is the cut". Then the instrument showed
the mechanism, which is the half a record cannot give:

| | before | after |
| --- | --- | --- |
| milled a game | 18.0 | **22.1** |
| library at the end | 24.3 | **19.9** |
| games it decked somebody | 16% | **28%** |
| wins by empty library | 23 | **40** |
| record on those seeds | 33% | **40%** |

One extra blocker bought four more cards of milling a game and nearly doubled the mill wins. The
deck did not get better at milling — it got to keep doing it for longer. The thirteen-deck table
agrees from a third seed set: 38% → 40%.

### What kills the worst deck, and why the mill deck's fix did nothing for it

Tidal Mind is 28% and eleven points below the next-worst deck, and three balance passes have moved
it two. `killed-by.mjs` records how a game actually ends: what took the last of the subject's life,
the turn, and how many cards it was still holding.

**It does not lose fast and it does not lose to spells.** Three quarters of its deaths are combat
damage, its games run to the table's twenty-third turn, and it dies **holding three and a half
cards**. The contrast with the best deck in the pool is what makes that legible:

| | Tidal Mind (28%) | Ember Rush (80%) |
| --- | --- | --- |
| wins on table turn | 27.6, with 21.2 life | **15.5**, with 15.6 life |
| loses on table turn | 23.1 | 19.1 |
| cards in hand at death | **3.5** | 1.1 |
| deaths to combat | 76% | 93% |

Tidal Mind's games run twelve table turns longer than Ember Rush's *wins* and it is still holding
cards when they end. **It has the time and cannot use it** — which is exactly why the fix that took
Hollow Tide from 33% to 40% did nothing here: a third blocker is worth something to a deck that
turns turns into an empty library, and nothing to one with no clock. Both blocker adds, priced
against Tidal Mind's weakest shared slot, came back **−2 and +4 of 288**.

So nothing shipped, and the conclusion is one a deck list can act on rather than the "the pilot is
bad" the last three passes stopped at: **this deck needs a way to win, not more time.**

### Six slots at once, and why twelve single-slot probes had to find nothing

The brief above got answered, and the deck list is the least interesting part of it.

Every change to Tidal Mind had been priced one or two slots at a time, and twelve of them read as
noise — a second Air Elemental −14, a second Exsanguinate 0, cutting the Fog Bank −2, cutting the
Wall of Frost +4, a Magpie for a Counterspell −14, and the best of them, two Magpies for two
counterspells, at **+6, +37, +23 and −6 on four seed sets of 288 duels**. The same four seed sets
measure the *unchanged* list at 83, 64, 88 and 90 wins: a twenty-game swing is what this instrument
does when nothing has changed at all.

Six slots came back **+47 and +38** on two seed sets, 29% to 45% against the field — and split in
half it vanishes again:

| | seeds 3300 | seeds 8800 |
| --- | --- | --- |
| two Magpies + a Sedgemoor Witch (3 slots) | +8 | +20 |
| two Bloodthirsty Aerialists + a Thorn of the Black Rose (3 slots) | +12 | +19 |
| **all six** | **+47** | **+38** |

Each half is inside the floor; together they are more than the two added up. **A deck that loses for
want of a clock does not have a slot wrong with it, it has a shape wrong with it** — and a shape is
not priceable one card at a time. Twelve probes found nothing because they were all asking a
question whose answer is no.

`killed-by.mjs` was the instrument that asked for this, and it answered. Same 144 games, same seed
set as the baseline above:

| | before | after |
| --- | --- | --- |
| record | 42-102 (29%) | **77-67 (53%)** |
| wins on table turn | 27.6, with 21.2 life | **24.9**, with 20.6 life |
| deaths to combat damage | 76% | 66% |

The wins come nearly three table turns sooner from the same comfortable life total. It was never
close to losing the games it won; it just took too long to end them.

**And the deck at the bottom of the table turned out to be holding the pool hostage.** Nineteen of
its forty-one card slots were the pool's only copy of that card — the Twincast, the Clone, the Turn
to Frog, the Cackling Counterpart, the Robe of Mirrors, the Chalice of the Void — so cutting its
deadest cards would have deleted a script's only test. That, not the measurement, is what had
bounded three previous passes. Two cuts moved rather than went: the **Twincast to Arc Tempest** for
a second Behold the Multiverse (+3 and +2, free — the same card tried there before measured about −9
in a *burn* slot, so the slot was the whole difference), and the **Phyrexian Arena to Ashen Rite**
for its Sedgemoor Witch (0 and −12, which is the entire price of the change, paid by the strongest
deck in the field).

One side-finding, in the harness rather than the pool: the rebuild turned the bot's attacker-loss
assertion red at 13.1% against a 12% threshold, and it was not a regression. Of 44 dead attackers,
**7 sacrificed themselves** (a Ball Lightning is sacrificed at end of turn whatever happens to it,
so attacking with it costs nothing), **10 traded**, killing a blocker, and **27 were thrown away** —
8.0%, which is the only one of the three the test's claim was ever about. The number had already
drifted twice as the pool grew, and this is why.

### Why the counterspell is still in hand

Three decks' records have been explained by the same sentence for months — holding mana for an
answer is half their plan and the bot cannot do it — and nothing had ever measured which part of
that was true. `held-answers.mjs` counts one *window* per (opponent's spell on the stack, answer in
hand) and asks `legalActions` what it would offer. A counterspell's life has six ends, and which one
it meets decides what kind of fix would help — 144 games each with the rule off:

| deck | windows | cast | the other card | **declined** | never offered | **could not pay** | no target |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tidal Mind | 229 | 7% | 0% | **0%** | 0% | **87%** | 6% |
| Arc Tempest | 151 | 12% | 0% | **3%** | 0% | **77%** | 8% |
| Skyward Writ | 218 | 30% | 7% | **0%** | 1% | **54%** | 8% |

**It is not a judgement problem.** Over 229 of Tidal Mind's windows the bot declined an affordable
answer **not once**: it almost never gets to make the bad choice two deleted evaluation terms were
aimed at. It is a tempo
problem with a precise shape — a seat that taps out in its own main phase has no mana for the whole
of the opponent's turn, because lands untap in their controller's own untap step. The severity
tracks the counter's **cost**: Skyward Writ's {U}{U} Counterspell is cast in 30% of its windows,
where Tidal Mind's {1}{U}{U} Disallow was cast **4 times** in 144 games against **118** windows it
could not pay for.

**Two of those six columns were added after this was first written, and they corrected it.** The
first instrument had four buckets and folded both into "passed", which is the one column a
conclusion gets drawn from: a hand with two answers facing one spell is two windows, so spending
either left the other looking passed over (26 of Skyward Writ's 31 "declines" were `cast
Counterspell`), and a pair only ever seen on a move this seat was not making was never a decision at
all (8 of Tidal Mind's 14). The table above and everything below is the corrected instrument; D168
in the decisions log lists what it supersedes.

**The instrument could not see any of that until it moved priority.** Its first version found 163
moments with an opponent's spell on the stack and the subject seat offered priority in *three* of
them — auto-pass passes for a seat whose only legal move is to pass, inside the same applied
action, so the 160 moments it could not see were exactly the ones it existed to explain. It now puts
the question counterfactually: `priority` moved to that seat on a local copy of the state, nothing
applied. That is the second instrument this week whose quarry was something the engine never stops
to ask about; the first was the combat arrow that is never on screen because auto-pass runs the
whole of combat inside one action.

### Whenever you draw a card

`draw` in `effects.ts` is the single choke point for every card anybody draws — the draw step, the
crown, and about two dozen card effects — and it announced the fact to nobody. So the most frequent
event in the engine was the one event no card could read, and a shelf of printed Magic was
unwritable. It is now the fifth member of the detect-rather-than-announce family beside `died`,
`entered`, `left` and `dealtCombatDamage`.

**It has to be recorded rather than compared, and the two failures are opposite.** A card arriving
in a hand is not a card being drawn — a Diabolic Tutor, a Gravedigger and a Man-o'-War all put one
there without a draw, and a hand-size comparison would fire on all three. And a draw does not always
change hand size: draw a card, discard it in the same breath, and the comparison comes out level
while the trigger that should have fired does not. One entry per *card*, which is what makes a
Harmonize three counters rather than one, and raised before the deaths in the same pass so a Skulker
that draws as it dies takes its counter before the death trigger counts them.

Two cards read it, one per half. **Chasm Skulker** in Hollow Tide grows on your own draws and leaves
a 1/1 islandwalker per counter — reading counters the permanent no longer has, through the channel
Hangarback Walker opened. **Fate Unraveler** in Ashen Rite drains on the opponents'. `any` is
deliberately not offered: nothing printed here wants it, and an option nothing fires is worse than no
option.

Both slots were priced by probing the revert, two seed sets of 288 duels: the Skulker is **level**
(−0.5) and the Unraveler **+5**, positive on both sets. Neither loses, which is the bar for a slot
whose job is to give a new event a card. And `draw-triggers.mjs` confirms the thing a unit test
cannot — 36 Skulker triggers and 75 Unraveler triggers over 144 games each, with the Skulker
reaching 13/13 in its best game.

In both decks the genuinely deadest card was untouchable: Hollow Tide's Diabolic Tutor and The
Eldest Reborn, Ashen Rite's Bone Splinters and Night of Souls' Betrayal, are each the pool's only
copy of their card — and the Bone Splinters is the only card in the game that pays a cost by
sacrificing. That is D167's orphanage constraint biting a second time in a week.

### The counterspell it declines, which turned out not to be a problem

D168 shipped the reservation rule and closed by naming the next thing to fix: now that the bot can
pay, *which* spells does it wrongly let through? That is D69's judgement problem, unanswered since
July. The measurement says it is not there.

With the rule on, across 432 games, the three counterspell decks declined an affordable answer **13
times in 556 windows** — 3% of Tidal Mind's, 1% of Skyward Writ's, 4% of Arc Tempest's. And both
diagnostics added to describe those declines say there is nothing to describe:

- **What it did instead was another instant, all thirteen times.** Murder ×2, Cackling Counterpart
  ×2, Unsummon ×2; Swerve ×4, a Think Twice, a Twincast; one activated ability. The mana never went
  on a creature or a sorcery — the bot was responding, it just responded with the other card.
- **It counters the expensive half.** Mana value countered against declined is 2.6/2.0, 2.4/2.0 and
  2.2/1.0, and twelve of the thirteen declined spells have mana value 2 or less: a Burst Lightning,
  a Galvanic Blast, a Think Twice, a Chalice of the Void for {0}. The countered lists are headed by
  Vampire Nighthawk, Shivan Dragon and Flametongue Kavu. That is the opposite of the failure D69
  predicted.

So no filter was written, and D69 is closed by measurement rather than argument: the thing that made
it true was that the bot could almost never pay.

**The instrument had been counting two things that are not decisions, and both inflated the one
column a conclusion gets drawn from.** A hand holding two answers facing one spell is two windows,
so casting either left the other recorded as passed over — 26 of Skyward Writ's 31 "declines" were
`cast Counterspell`. And a (spell, answer) pair is usually first seen on a move this seat was not
making, which is not a decision either — 8 of Tidal Mind's 14. Both are now their own columns. It is
the same lesson as the priority counterfactual one entry up: **the unit a harness counts in is a
claim about the engine, and it has to be said out loud.** "One window per spell the deck could have
answered" and "one decision per spell the deck was asked about" differ by a factor of three here,
and the numbers published in D168 answered the first question while the sentence beside them
answered the second. Every figure is corrected in place, and D168 lists what it supersedes.

The real cost of the reservation rule is somewhere else and nothing has measured it yet: **20% of
Arc Tempest's windows and 12% of Skyward Writ's have nothing to point at** — a Squelch or an Essence
Scatter holding mana up for a spell type that is not coming.

### A cost paid out of the graveyard

Everything that paid for anything in this engine paid with something on the battlefield — tap it,
sacrifice it, crew with it — or with a life total. `additionalCost` was one field wide and the
graveyard was a place cards went. So the pool had no card whose price was its own graveyard, and
the three decks that fill one by playing their own game had nothing to do with it.

**Two mechanics, one primitive, opposite ends of it.** Escape (CR 702.139) is a fixed price printed
on the card — Phoenix of Ash comes back for {2}{R}{R} and three *other* cards, as often as the
graveyard can stand it. Delve (CR 702.112) is a price chosen as the spell is cast: each card exiled
pays for {1}, so a Gurmag Angler is a seven-mana 5/5 on an empty graveyard and a one-mana 5/5 on a
full one — the first card in the pool whose mana cost is a fact about the game rather than about
the card.

The difference that carries the balance is at the **end** rather than the start. Flashback cast a
card out of the graveyard too, and what made it fair was the exile as it leaves the stack: there is
no third casting. An escaped permanent is ordinary — it dies back into the graveyard it came from,
ready to go again for three more cards.

Three rules are easy to get almost right, and each has a test. **"Other" is load-bearing**: a
Phoenix with exactly three cards in the graveyard including itself cannot escape, and the play is
absent rather than offered and refused (CR 601.2h). **The cards go as the spell is cast**, so a
countered Angler does not give them back and nobody can answer an escape by exiling the graveyard
in reply. And **delve pays generic only** (CR 702.112a) — seven Islands and nine cards still cannot
cast a {6}{B} creature.

**Which cards get spent is the engine's choice, and the ordering rule is the only judgement in
either mechanic.** A graveyard in this pool is not a pile: a Think Twice can be cast out of it, a
Phoenix can escape out of it, a Gravedigger can take a creature back from it. So `graveyardFodder`
spends the cards with no second life of their own first, and `delvePlan` takes the **fewest** cards
that make a spell payable rather than the most — the maximum is free in mana and expensive in
everything else, and these three cards are each other's evidence for that.

Three slots, one per deck, all three in the table's bottom cluster, every cut taken off
`cast-counts` and every cut card still in the pool somewhere else: the **Phoenix of Ash** into Arc
Tempest for a Divination (65%), the **Gurmag Angler** into Hollow Tide for a Wall of Air (79%, and
the deck already holds the ground with three Fog Banks), the **Treasure Cruise** into Tidal Mind for
a Preordain (75%, with four others in the pool).

**And `graveyard-costs.mjs` says the bot pays these costs**, which no instrument here could have
said before. Its first version read the **stack**, where the engine writes down "(escaped, 3 cards)"
and "(delved 6)", and over 144 games each it reported 5 escapes in Arc Tempest, 11 delved Anglers in
Hollow Tide and 10 delved Cruises in Tidal Mind.

**Those counts were about one in eight of the truth, and the paragraph that used to follow them drew
exactly the wrong conclusion from the shortfall.** See D203: reading the stack between actions only
sees the objects somebody held priority over, and with `autoPass: true` the rest are put on the
stack and resolved inside the same `applyAction`. The harness counts the action now; the re-measured
numbers are in D203, and the *shape* of the delve spread survives because that was never about the
count.

**Priced by probing the revert**, two seed sets of 288 duels each: the Phoenix is **+10 and +5** and
the Angler **+17 and +2**, both positive on both sets. The Cruise is the one that lost its slot:
−9, −1, −4 and −3 on four seed sets, every one of them negative, which is a verdict even though
each is inside the ±20 floor. The measurement README has said since D143 that two seed sets are
enough to *kill* a change; this is the first time that rule has had to be applied to a card already
written up.

Its reason was the deck rather than the mechanic — **six Islands** against eight Swamps, and a
graveyard already being spent by a Think Twice that wants to be cast out of it — so it **moved**
into Hollow Tide for that deck's second Thieving Magpie (81%), where it reads −9 and +15: opposite
signs, which is level, and level is the bar for a slot whose job is to give a mechanic its second
card.

### The graveyard as a thing you can answer

The entry above made the graveyard something you spend. It was already something the pool *used* —
flashback, Raise Dead, Zombify, a Gravedigger, a Lhurgoyf whose power is a graveyard — and the only
card in thirteen decks that could interfere with one was a Tormod's Crypt: one copy, one deck, one
shot. A whole dimension with no answer in it.

**`to-graveyard` is the sixth member of the detect-rather-than-announce family**, and the reason it
is a sixth event rather than a `who` on `dies` is that three of the four printed anywheres are not
deaths: a card milled off a library, a card discarded out of a hand, and a spell that has finished
resolving. Recorded in `relocate` like the five before it — the one place a card changes zone, so no
path can forget — with a test per anywhere, because "no path can forget" is a claim and four callers
are four chances to be wrong about it. Both events are raised for the same card, death first, so a
Blood Artist's drain sits on the stack under a Planar Void's exile.

**Planar Void is a trigger because Planar Void is printed as a trigger.** The tempting version is a
replacement effect — "if a card *would* be put into a graveyard, exile it instead" — which is Rest
in Peace, is a stronger card, and would have meant moving the replacement pass upstream into
`relocate`. The card as printed means the card really does reach the graveyard and is exiled
afterwards, so a Blood Artist still sees the creature die. Building the replacement would have been
building a different card and calling it this one. "Another" is the whole of the matcher and not a
formality: a Planar Void that is destroyed would otherwise exile itself on the way down, and a
Naturalize that kills it is *not* exiled, because a spell reaches its graveyard as the last step of
its own resolution (CR 608.2m) and by then nothing is watching.

The event has **no `by` and no `what`**, for the third time and the same reason: an option with no
card behind it is worse than no option. It carries the subject and the seat, so the day something
wants "whenever a creature card is put into *your* graveyard" the facts are already there.

**Scavenging Ooze needed nothing at all**, which is the other half of why the pair ships together: a
`graveyard-card` target and a mana-cost ability have been in the engine for months, so the second
answer to a graveyard is twelve lines of script — {G}, exile one card from any graveyard, and a
counter and a life if it was a creature. One card asked for a new event; the other proved the
vocabulary was already there for a card nobody had written.

Both went into the bottom cluster, both cuts off `cast-counts`: the **Planar Void** into Blight
Vector (the one black deck with almost no use for its own graveyard) and the **Ooze** into Delta
Bloom for a second Divination (81%, in a ramp deck short of a mana sink). The Ooze measures **+14
and +4**.

**The Void took two attempts and the first one is the finding.** Cutting Blight Vector's Titanic
Growth (25%, its least-cast card by twelve points) for it read **0 and −12** — a card costing its
own deck games — because the deck's one graveyard card is a **Raise Dead**, cast in 40 of 144
games, and a Planar Void turns it off completely. A deck that denies graveyards cannot play a card
that needs its own, which is obvious written down and invisible while choosing a cut by cast count
alone. On the Raise Dead slot it reads **+4 and −3**, which is level. All four numbers are inside
the floor, so the improvement is consistent with that conflict rather than proof of it; what it
does establish is that the card no longer costs its deck anything measurable. `graveyard-costs.mjs` now counts both ends of the dimension in one
run, and with Blight Vector as the subject **132 Planar Void triggers reached the stack over 144
games** — the bot does cast the one-mana enchantment that does nothing for its own board, and once
it is down nobody at the table has a graveyard.

### The one card the reservation rule should never have held mana for

D170 left exactly one loose end: *nothing to point at*, 20% of Arc Tempest's windows, the only
column where holding mana back costs its own deck something. The per-card rows say where it came
from — **11 of Squelch's 17 windows had no legal target** — and the cause was one word in a regular
expression. `affordableAnswerInHand` matched "counter target", and Squelch reads "Counter target
activated ability": its target is an *ability*, so it can do nothing at all about the spell the
opponent is about to cast. The bot was holding two mana on its own turn for a card that could never
be cast when the moment came.

It now matches "counter target … spell", which keeps every real answer in the pool (Counterspell,
Cancel, Negate, Essence Scatter, Psychic Strike, Saw It Coming, Disallow, Soul Manipulation's first
mode) and drops Squelch and Chalice of the Void's "counter it". It stays a **text** match rather
than a look at the card's target spec, because the spec says what the engine will *offer* and this
question is asked on a turn when the engine offers nothing — the counterfactual the whole rule is
built around.

**It is not measurable in isolation and the write-up says so**: one card in one deck, in hand in
about 19 games in 144, with the rule it changes not behind a flag. It ships on the same ground every
member of the drop-this-option family shipped on — the play was wrong — and the check that it costs
nothing is the thirteen-deck table below.

### Escape's second card, and the outlet eight cards had been waiting for

A mechanic with one card has one card's worth of coverage. **Woe Strider** ({2}{B} 3/2 Horror) is
escape's second, and a different kind of escape card: a Phoenix of Ash comes back because it is a
threat that will not stay dead, and a Woe Strider comes back because it is an engine the opponent
cannot answer by killing it.

Ashen Rite has eight cards that read a creature dying — three Blood Artists, two Aristocrats, a
Bloodthrone Vampire, a Judith, a Village Rites — and not one of them could make a creature die for
**free**. `{0}: Sacrifice another creature. Scry 1.` is the thing that list has been short of since
the deck was built, and the card **arrives with its own first meal** in the 0/1 Goat.

**It needed no new engine vocabulary**, which is the other half of why it is a good second card.
`AbilityCost.sacrifice` has been there since the Bone Splinters went in and no card had ever asked
for it on an *ability* — Bone Splinters is a spell with an additional cost — so the path was built,
tested through its cousin, and otherwise dead. A token on an entry trigger and a scry as an
ability's decision were both already there too. The only new line in the engine is the Goat.

Five tests, and two of them are about something other than the card: the Goat is **gone** rather
than in a graveyard when it is eaten, because a token that leaves the battlefield ceases to exist
(CR 111.7); and the free outlet puts a Blood Artist's drain on the stack, which is the combination
rather than the card. It replaced the Thorn of the Black Rose (65%, and Tidal Mind runs the other,
so the monarch keeps its coverage).

**Priced at −20 and −8, which turned out to be a bot bug rather than a card** — see the entry
below. With that fixed it reads **−4, −2, +1 and −4** on four seed sets: mean −2.25 of 288, every
reading inside the floor, three of four with a negative sign. That is a weaker signal than the one
that moved the Treasure Cruise out of Tidal Mind (−9, −1, −4, −3), there is no better home for a
`{0}` outlet in the pool — Rot Harvest is the only other deck that wants one and its Lhurgoyf's
power *is* the graveyard an escape cost exiles — and escape needs a second card. So it is kept with
the condition written down: measure it again when the field next changes.

### Blight Vector: the diagnosis was clear and the obvious fix measured level

The re-run table put Blight Vector last at 31% (88-200). Measured before touching it, and the two
instruments agreed in one voice. `killed-by`: it loses on the table's turn 20.4 **holding 2.2
cards** — not flooding, not starving — **71% to plain combat damage**, and the games it wins it wins
on turn 18.4 with 15.6 life left. `poison`: dealt in 81% of games, 903 counters in all, and **50 of
its 53 wins come by poison**. The win condition D138 built the deck for is the one it wins with. It
is losing a race by about a turn.

The obvious change for that is a card that buys turns, and a **Wall of Blossoms** ({1}{G} 0/4 that
draws a card) is the cheapest two turns in these colours — never dead in a deck whose other
creatures all have to attack. It measured **−3 and +5**: level, and the deck's absolute level barely
moved (34% and 39% across the two stock arms).

**So the diagnosis does not translate into the obvious fix.** The sharper hypothesis was in the same
data — the deck goes 2-10, 3-9 and 3-9 against three decks that are red and white between them, and
it already runs the card none of them can block in **Phyrexian Crusader** (protection from red *and*
white, cast in 85% of games off two copies) — so a third was probed against the Wall directly rather
than committed first. It measures **−7 and −15**. The deck does not want another attacker either, and
the Wall is better than the card that was supposed to beat it.

**`infect-clock.mjs` explains both nulls in one line.** Poison only counts when a creature connects,
and the bot's combat rule is "do not throw creatures away" — correct for a damage deck and possibly
fatal for one whose 1/1s have to get through. Over 144 games, at every declare-attackers step where
it held an infect creature it could send: it **sent 663 of 736 (90%)**, sent all of them in 90% of
declarations, sent nothing in 8% — and the **widest board of infect creatures it ever had was five**.

It attacks with everything; the bot is not the problem. An eighteen-creature deck that never gets
more than five bodies down, swinging with 90% of them, needing ten poison, is an **attrition**
problem: one- and two-power creatures in a field of 3/3s and removal. That is D167's lesson a second
time — a shape is not priceable one card at a time — and this deck has now spent six probe arms and
three instruments on two slots to find level and worse. The next pass is a reshape judged by
`infect-clock` (widest board, share that connects) rather than by a win rate three noisy points
away from anything one card can move.

### The field re-measured, and the largest move anything has made in this pool

The thirteen-deck table, re-run on the same twelve seeds as the one D176 quotes
(`SEEDS=12 SEED0=4400`, 288 games a deck):

```
 75%  215-73   ember-rush      44%  128-160  delta-bloom
 64%  185-103  dawn-tithe      43%  124-164  rot-harvest
 61%  175-113  verdant-guard   43%  124-164  hollow-tide
 56%  162-126  kindle-grove    41%  117-171  arc-tempest
 56%  160-128  forge-alliance  34%  99-189   tidal-mind
 50%  143-145  skyward-writ    34%  99-189   blight-vector
 47%  134-154  ashen-rite
```

(Re-run with all nine of the pass's new cards in it. The two rows that moved most are the two those
cards were measured in: Verdant Guard +7 with a Fleecemane Lion, Kindle Grove +7 with a Hellspark
Elemental — the latter being that card's own probe number, +4 and +6, arriving in the field.)

(Dawn Tithe's second place is D180's 19 games, not a card: this run already has the fifteenth
drop-this-option rule in it.)

The three things that changed between the two runs are Woe Strider, the sacrifice-fodder fix and
Blight Vector's Wall of Blossoms — and **one row of thirteen moved outside the ±20-game floor**.
Ashen Rite gained **29 games of 288** (39% → 49%, fourth-worst to seventh), which is the fodder fix
whose own probe had measured +32 on that deck in isolation: a prediction and an arrival three games
apart. It is the largest move any single change has made in this pool — larger than the six-slot
Tidal Mind rebuild, larger than any card ever priced here — and it was a bot bug rather than a card.

**The second-largest is the same fix on the only other deck it could touch.** Rot Harvest gained 13
games, and Rot Harvest is the one remaining deck with repeatable sacrifice outlets in it (a Vampire
Aristocrat and a Bloodthrone Vampire, the exact two cards the fix guards). Thirteen games is inside
the floor and proves nothing by itself; it is the right sign on the right deck, which is the most a
noisy instrument can offer as corroboration.

Everything else moved between −11 and +2 games, noise and the other half of a zero-sum table. Two
sentences in the published write-ups did not survive the run and have been corrected rather than
left standing: the spread is **forty-two points** where it was described as thirty-six, and the
bottom is two decks rather than a cluster — Tidal Mind at 36% and Blight Vector at 33%, five points
below the deck above them. D177 has the full before-and-after, and the caveat that the previously
published table was a different seed set, so comparing those two run-to-run carries the floor twice.

### The reshape it asked for, measured and taken back out

D176's direction — resilience over count, evasion over bodies, the Warhammer package — was built as
four slots: a fourth **Blight Mamba** (471% use, 406 regenerations off three copies), a fourth
**Plague Stinger**, a second **Loxodon Warhammer** (149%), and a new **Whispersilk Cloak** ({3},
equip {2}, *can't be blocked and has shroud*), for the two Blossoming Defenses (44%), a Read the
Bones (62%) and a Cystbearer.

Probing the revert: **+11 and +10** of 288. Two arms, same sign, so the old shape is better than the
new one — and the narrow version, the equipment package alone, measured **−3 and +23**, which is
not a slot either. On the same seeds the committed deck won 114, the package 117 and the full
reshape 103, so the four creature-and-draw slots cost about fourteen games by themselves, concentrated
against the three fastest decks in the field. That is what cutting a 2/3 blocker does.

**`infect-clock` is why neither worked, and it is one line.** The reshaped deck put **12% more
infect creatures into attack steps** (826 able where the committed deck had 736, 89% of them sent)
and the **widest board of infect creatures was five in both**. The deck is not short of creatures to
draw; it is short of creatures that are still there next turn, and more bodies buy attack windows
rather than board. Nine probe arms have now been spent on this deck's slots and the ceiling has not
moved once, so the next thing is an instrument rather than a third guess: what *takes* its creatures
away — blockers, removal, or its own costs — because the three answers point at three different
decks.

**And the Cloak itself was deleted after being measured in a second deck.** `cantBeBlocked` had
existed since D133 with one creature behind it that could not block either, so an Equipment carrying
it looked like a mechanic rather than a slot — and shroud is what makes it wrong in an infect deck,
where nine cards target. Measured in **Forge Alliance** instead, against that deck's Hellrider
(32% cast), the bot used the Cloak as heavily as it uses the Loxodon Warhammer (**149%**, 29 casts
and 26 equips in 37 games) and the record went **617–669 of 1152** across four seed sets. A card the
bot reaches for eagerly while losing is a trap rather than an option, so the definition, the script
and the tests are gone: D144's precedent, *built, measured, deleted*.

### Rancor, from anywhere — and the self-subject half of the newest event

Rancor has been in the pool since the thirteenth deck, scripted as a `dies` trigger on a permanent
that is not a creature. That is the **old** printing: the card says *put into a graveyard from
**anywhere***, and the three other anywheres — a discard, a mill, anything that is not a death —
were invisible to that event. D172 had built the event for exactly that difference and had given it
no way to watch *itself*, because the card it was built for (Planar Void) says "another".

So `to-graveyard` has a `who` now, with `another` as its default — the opposite of the five board
events, and the default is the card rather than a convention, since every script written against
this event so far means "another". `who: 'self'` brings two things with it. The watcher fires **from
the graveyard it has just reached**, which `raise` previously allowed only for the subject of a
`dies` or a `leaves`; and the effect is **guarded**, because by the time the ability resolves the
card may have been exiled by the Planar Void whose own trigger was on the stack beside it (CR
608.2 — an ability does as much as it can and no more).

The two new tests are the two new directions: a Rancor discarded out of hand by a Mind Rot, never
cast and never on the battlefield, back in hand a moment later; and the Planar Void, which is the
one card in the pool that beats it. Worth nothing in a win rate and said so — the paths it adds are
rare — but `cast-counts` has the number that makes the card: Kindle Grove casts its two copies
**139 times in the 64 games it draws one**, which is 217%, and that was true before this fix as
well. It ships on fidelity, which is the same reason the Squelch narrowing shipped.

### What takes a deck's creatures away, and the bot bug it found in its first run

The instrument D178 asked for. `creature-fate.mjs` follows every creature a deck puts onto the
battlefield and says how it left, where it went and how long it lived — because the five-wide
ceiling on Blight Vector's board had three possible causes pointing at three different decks:
blockers (answer: evasion), removal (answer: resilience) or its own costs (answer: a bot rule).

**It found the third on its first run, in a card nobody suspected.** Six percent of that deck's
creatures were being killed by **its own Naturalize**: "destroy target artifact or enchantment" is a
legal aim at an artifact creature, a Plague Stinger is one, and with nothing of the opponent's to
point at the only legal targets the engine can offer are its own. So the fifteenth member of the
drop-this-option family is `destroysOneOfItsOwn` — drop a cast whose card says "destroy target" and
whose chosen target is a permanent this seat controls. D89 had fixed the creature half of exactly
this; the difference is that this one has to read the *target*, because the same Naturalize with a
real target is a fine card. Worth **+19 games of 288 to Dawn Tithe** (58% → 65%, a Disenchant beside
its own ten artifacts and enchantments) and nothing measurable to the other three decks that can
fire it, which is the honest report.

**And the answer the instrument was built for is not a card at all.** Across four decks the causes
split the same way — roughly half combat, half the opponent's removal, everywhere:

```
                 creatures   left   widest   lifetime (table/own)   combat   theirs   ours
blight-vector          261    148        7            3.0 / 1.5       47%      47%      4%
rot-harvest            415    228        9            3.9 / 2.0       45%      41%     14%
skyward-writ           401    203       12            4.5 / 2.2       47%      51%      1%
dawn-tithe             362    256        8            3.4 / 1.7       49%      41%      7%
```

Blight Vector's ceiling is the same two causes at the same ratio as everybody else's. What is
different is the denominator: **261 creatures where Skyward Writ puts 401**, each living 1.5 of its
own turns against 2.2. The infect deck is not losing creatures to something unusual — it has fewer,
they are cheaper, and nothing in the list replaces them. So the question for it is where more bodies
come from (tokens, or a creature that leaves one behind), and both shapes D178 priced were answers
to a different question.

Two caveats travel with the harness and are written into it: *where they went* is read in the first
state after the creature left, so a deck running its own graveyard hate turns its own deaths into
exiles (Blight Vector's Planar Void is why 32% of its creatures end there), and a cause is
attributed only when **one** stack object resolved on the action — several at once goes in its own
bucket, because whichever end of the stack you read is wrong about half the time.

### Undying and persist, which look like replacement effects and are not

Three cards and one helper: **Young Wolf** ({G} 1/1, Rot Harvest), **Butcher Ghoul** ({1}{B} 1/1,
Blight Vector) and **Murderous Redcap** ({2}{B}{R} 1/1 with an entry trigger, Ashen Rite). "When
this creature dies, if it had no +1/+1 counter on it, return it to the battlefield under its owner's
control with a +1/+1 counter on it" — and persist is the same sentence with −1/−1 in both halves.

**The obvious implementation is a `replaces` on `dies`, and it is wrong.** Both keywords are
*triggered* abilities, so the creature really does die: a Blood Artist drains for it, a sacrifice
outlet gets its value, a Village Rites draws its two cards, and only then does the body come back.
Written as a replacement it would have been a creature that cannot be drained for and cannot be
profitably sacrificed — the opposite of what the cards are played for — and the engine already had
everything the faithful version needs, so the whole mechanic is a `dies` trigger with `who: 'self'`
and an intervening-if.

The **if** is the mechanic, and it reads the counters the creature had *as it died* (CR 603.4) —
which is why the 1/1 that has already come back once stays in the graveyard the second time. Those
counters are gone from the card by the time anything can look: `relocate` takes them off on the way
to the graveyard, as the rules require. So both asks read `subjectCounters`, the snapshot the event
carries, and the **first** ask did not have it until this card needed it: without that the ability
would have gone on the stack for an opponent to respond to and then done nothing, which is the shape
of wrongness an intervening-if exists to prevent.

Persist's second body is worth seeing once: a 1/1 with a −1/−1 counter on it is a 0/0, so the Redcap
comes back, deals damage equal to its power (nothing), and the state-based actions put it in the
graveyard again. That is the printed card rather than a limitation — the second body is a *trigger*,
not a creature — and with a Blood Artist out it means two drains for one card.

**The three slots measured nothing like each other, and that is the entry's real content.** Probing
each revert on two seed sets: the **Young Wolf** is worth **+36 and +10** games of 288 to Rot
Harvest — one mana for a body that can be fed to a Vampire Aristocrat *twice*, and it is the deck
rather than the card. The table re-run after all three cards reads **+7** on a third seed set, so
the honest version is "positive and inside the spread" rather than the +36. The **Redcap** is worse
than both cards it was tried against (+7/+29 against a third Blood Artist, +6/+11 against a second
Gravedigger) and ships for the mechanic with that said out loud, because persist has no other card
in the pool. And the **Butcher Ghoul** is level (0 and +2) in Blight Vector, which makes it that
deck's **fourth null in a row** — a blocker (D176), evasion and equipment (D178), and now bodies per
card, each asked for by an instrument and each one delivering exactly what it was added to do:
`creature-fate` reads 279 creatures played where it read 261, and 120 still standing where it read
113, with the record unmoved. Ten poison counters off one-power creatures is simply a slower clock
than twenty life off three-power ones. D181 says what that means for the deck.

### Monstrosity and adapt, and the rule the second one asked for

Two keywords one word apart. **Fleecemane Lion** ({G}{W} 3/3, Verdant Guard) has *monstrosity 1*:
"activate only if this creature isn't monstrous", which is a restriction on the **ability**, so the
engine grew `AbilityDef.activateOnlyIf` and the table stops offering the button once it has been
pressed. **Aeromunculus** ({1}{G}{U} 2/3 flier, Delta Bloom) has *adapt 3*: "if it has no +1/+1
counters on it, put three on it", which is a condition inside the **effect** — so the ability stays
offered and paying a second time is legal and buys nothing. Both grow the creature permanently,
which is what makes them unlike every other pump in the pool.

The Lion's other half is the second thing `ContinuousEffect.while` has ever been asked: *hexproof and
indestructible while it is monstrous* is a condition about the permanent's own counters rather than
a count of its controller's board, so that field grew a `source-has-counter` kind. The
simplification is in the test rather than hidden — the engine's answer to "monstrous" is the counter
it is carrying, so a Toxic Deluge takes the hexproof with the counter where a real Lion stays
monstrous.

**And adapt found a bot bug in one run.** `cast-counts` on the first version: **29 casts and 88
adapt activations** across 34 games — three payments of {2}{G}{U} per creature for one effect,
because after the first the ability still appears and still resolves and does nothing. So
`AbilityDef.buysNothingIf` is the sixteenth member of the drop-this-option family and the twin of
`activateOnlyIf`: the rules keep offering what the card allows and the **bot alone** reads this one.
After it, 29 casts and 24 activations.

What they measured: the Lion is **level** over four seed sets (−28, +11, +6, −1 on the revert — the
−28 being a reminder of why two arms are the minimum and four better) with 47 casts and 21
monstrosities in 56 games; the Aeromunculus is about **eight games short** of the four-mana 4/4
flier it replaced and ships for the mechanic with that said out loud, because adapt has no other
card in this pool. Pteramander, the famous one, is deliberately absent: its adapt cost is reduced by
the instants and sorceries in a graveyard, which is a cost modification on an *ability*, and
`costModifiers` is about spells with a fixed number.

### Unearth, and the sacrifice that was moving cards out of exile

The third thing a cost can be paid out of a graveyard, and the first that is not a cast. Escape and
delve put the card on the stack; unearth is an **activated ability** that puts the creature straight
onto the battlefield with haste, so nothing can be countered and nothing that watches for spells
sees it — and then a delayed trigger exiles it at the beginning of the next end step. One engine
line: `AbilityCost.fromGraveyard`, which is cycling's `discardSelf` one zone along, with
`activatablePlays` walking the graveyard as a third zone. **Dregscape Zombie** ({1}{B} 2/1, unearth
{B}) is in Ashen Rite and **Hellspark Elemental** ({1}{R} 3/1 trample haste, unearth {1}{R}) in
Kindle Grove.

**The clause that looked optional was worth half the card.** Unearth reads "exile it … or if it
would leave the battlefield", and `cast-counts` on the first version read **18 casts and 42
unearths** across 22 games. The cause was not unearth: a Hellspark carries its own end-step
sacrifice as well, the exile resolved first and did its job, and then the sacrifice called
`moveToGraveyard` and moved the card **out of exile** into a graveyard it could be bought from
again. A sacrifice is something you do to a permanent you control (CR 701.17a), so `sacrificeSelf`
guards it — and the same latent bug had been sitting on Ball Lightning since D55 with nothing in the
pool able to exile it first.

The ordinary case still needs the clause, so `replaceDeaths` now considers the **dying permanent's
own** replacement effects first (CR 616.1), which D181 had decided not to add for undying because
undying does not want one. It applies to the unearthed body alone, read off an `UNEARTHED` counter
in the `vanished` snapshot: a Hellspark that was cast and died is in a graveyard it can be unearthed
from, which is the point of the card. The remaining gap is written into the script — "would leave
the battlefield" also covers a bounce, and `replaces` only knows `dies`.

Measured: the Dregscape Zombie is level (−5 and +1) with **33 casts and 32 unearths in 32 games**,
and the Hellspark is worth **+4 and +6** — where the leaky version measured +10 and +19. A rules
deviation nobody notices is worth real games, which is the argument for fidelity as a number rather
than a principle.

### An instrument for plays that bought nothing, and the seventeenth drop-this-option rule

Sixteen members of the drop-this-option family exist and **every one was found by hand** — a Dark
Ritual into nothing, a Fog with nothing attacking, a pump that wears off, an animated land that
never attacks, a Clone with nothing to copy, removal with nothing to remove, a goad in a duel, a
foretell with nothing spare, an untap cycle, a Naturalize aimed at its own board, a second adapt.
Each cost a session of suspicion and measurement, and each was worth between nothing and
twenty-nine games of 288. `wasted-plays.mjs` asks the question generically instead: for every
`auto:cast` and `auto:activate`, it fingerprints everything a player would call value — life,
poison, permanents per seat, total power, toughness, counters, granted keywords, untapped
permanents, and every zone's size — before the action and again once it has finished resolving, and
reports the plays where nothing in it moved.

Three things it had to get right before it could say anything. **The stack has to be drained**,
because a cast only puts an object on it — the first version called 94% of a Basilisk Collar's
equips waste. **Samples where the turn advanced have to be dropped**, which is D99's trap and 771 of
3,771 plays here. And **the fingerprint must not count the cost**: counting untapped permanents
naively counts the payer's own tapped lands, which collapsed the flagged list from two hundred
suspects to five until those were excluded. Granted keywords and untapped permanents are both in
there because leaving them out made a Basilisk Collar's deathtouch and an Icy Manipulator's tap read
as nothing.

What it found, over 156 games and 3,771 plays: **170 suspects, and 124 of them equips** — the four
Equipment in the pool are the top four rows (Basilisk Collar 62 of 106, Darksteel Plate 27 of 57,
Loxodon Warhammer 20 of 67, Bonesplitter 15 of 44). Most of the rest is the instrument's own blind
spots answering back, which is how it is calibrated rather than broken: Fog is prevention, Disallow
and Soul Manipulation are denial, Dark Ritual's mana is in the pool. The five blind spots —
information, later, denial, mana, and where a bonus is — are in the file's header, and the output is
a list of **suspects** rather than bugs for that reason.

So the seventeenth rule is `equipMovesSideways`: drop an equip that moves an Equipment off a
creature this seat controls and onto one whose power is no greater. D35 had already stopped the
engine *offering* an equip onto the creature it is already on; this is the shell outside it, a
different creature with the same bonus. The Collar was moved onto a Wall of Blossoms twenty-one
times, onto a Gravedigger twelve, onto Llanowar Elves ten. **Power is the test and it is a proxy**,
said out loud: deathtouch is worth more on the creature that will block than on the bigger one that
will not, and the rule drops that move too. It keeps every first equip, every move onto something
bigger, and every move off a host that has left, tapped or stopped being a creature.

After it: **79 suspects of 3,597 plays, and 36 equips** — Loxodon Warhammer off the list entirely.
The 36 left are the blind spot the header now names, because the fingerprint *sums* power across the
battlefield: an Equipment moved onto a bigger creature changes nothing in it, same sum and a
different carrier. Those are the upgrades, and only the bot rule can tell them apart.

**And it is level in the standings, which took two seed sets to say.** Paired thirteen-deck tables,
the rule off and on, on the same seeds. At `SEED0=4400` the two decks whose Equipment it governs
both gained five games of 288 — Forge Alliance 160→165, Rot Harvest 124→129 — and nothing else moved
more than four. That looks like a signal. At `SEED0=5600` the same pairing gives Forge Alliance
**0** and Rot Harvest **0**, and the largest move anywhere in the table is +4 on Ember Rush, the
Bonesplitter deck. So the +5s were the ±20 floor talking, and the discipline that usually kills a
change here confirmed a level one instead. The rule ships the way D35 did: on the play being wrong,
and on the instrument's own count going from 124 wasted equips to 36.

And one rule was built, measured and deleted. `equipAddsNothing` — drop an equip onto a creature the
bonus cannot help — fired **zero times** in 156 games, because every Equipment here grants either
power or a keyword any creature can use. A rule with no measured waste behind it is a rule that will
be wrong about a card nobody has written yet.

### A replacement for any zone change, and the card that asked for it

`CardScript.replaces` had one event in it from the day it was written for Kalitas (D82): `dies`, a
permanent going to a graveyard from the battlefield. Printed cards use three widths of the same
move, and two cards had already settled for less than they say — Rest in Peace could not be written
at all, and unearth's "or if it would leave the battlefield" shipped as a replacement on death
alone. So the field is `'dies' | 'to-graveyard' | 'leaves-battlefield'` now.

**One move is replaced once, and that is the whole of the bookkeeping.** A creature destroyed in
combat is in `left`, `toGraveyard` and `died` at the same time: three names for one zone change. The
wide passes run first and whatever they handled is dropped from the narrower lists; the narrow pass
returns the favour, because a creature a Kalitas exiles instead of letting die did not reach a
graveyard either. `ReplacementContext.dying` became `subject`, since the card it names is no longer
always dying.

**Rest in Peace** ({1}{W} enchantment, Skyward Writ) is the first card on the widest wording, and
the pair with Planar Void is the reason the distinction is worth having. The Void is a *trigger*:
the card arrives in the graveyard, an ability goes on the stack, the exile happens after — so a
Blood Artist still drains and a Gravedigger resolving first still buys something back. Rest in Peace
says **instead**, so the creature never died at all. Its arrival empties the graveyards that already
exist, because the replacement only covers the rest of the game, and it applies to itself: a
destroyed Rest in Peace exiles itself, which works because the engine asks the moving card's own
effects first (D183's change, reused here without a line).

**Measured: level, and the number says as much about the bot as about the card.** Probing the
revert — Rest in Peace out, the Divine Verdict back — gives **+10 and 0** of 288 on two seed sets.
Both are inside the ±20 floor and neither is in the card's favour, so it ships the way D182's
Aeromunculus did: for the mechanic, with the number said out loud rather than buried.

And there is a reason to expect that number to be low which is not about the card. The evaluation
has **no term for an opponent's graveyard**, so a two-mana enchantment whose whole effect is denying
one scores as a blank — the deck holding it cannot see what it bought, while a person sitting across
from Ashen Rite's Gravedigger loops or Arc Tempest's flashback can. That is the same shape as the
counterspell (D148): the handicap was never the card. Teaching the search to read a graveyard is a
term rather than a slot, and it is on the list.

**And unearth's remaining half is closed, for nothing.** D183 shipped the clause as `on: 'dies'`
because nothing in this pool bounces its own creature — true, and beside the point, since the
*opponent's* Unsummon and Man-o'-War do it just as well and four decks run one. An unearthed
Dregscape Zombie Unsummoned in response went to its owner's hand where the card says exile. Fixed,
tested, and measured at **exactly zero**: `cast-counts` reads 28 casts and 21 unearths for the
Zombie and 17 and 16 for the Hellspark, identical with the fix and without it across 96 games each.
The window is narrow where the sacrifice leak's was not — an unearthed creature is exiled at the end
of its own turn anyway, so the bounce has to land inside that turn. D183's leak was worth half a
card; this one is worth nothing, and the two being the same kind of change is the argument for
measuring a fidelity fix rather than assuming it either way.

### Does the opponent read your hand? Asked properly, and the answer is no

The "Next" list has said for five months that the search reasons "from everybody's hand". That was
true of the **reply** (D110) and is why the reply was reverted; nobody had ever checked the bot that
stayed. Reading the code says it probably does not — `evaluate` sums life, hand *count*, library
*count* and the battlefield, and hand size is public — but "probably does not" is the kind of claim
this project has been wrong about before, and it is the exact claim a person would most want to be
true.

`hidden-info.mjs` asks it in the only way that cannot be argued with: the same position twice, the
second time with **every card the acting seat cannot identify dealt out again**. Hidden means
`viewFor`'s own redaction — another seat's hand identities, every library's identities and order, and
the card under somebody else's face-down permanent — and the scramble permutes `defKey`s inside one
seat's hidden pool, so every zone keeps its length and every card keeps its owner. A scry or a tutor
pending is dropped, because reading a library is what the card on the stack is for.

**0 of 8,945 decisions changed**, across 78 games, with **1,583,797** card identities moved by the
scrambles. Not one cast, attack, block, activation or pass.

Both halves of that are controls. The moved-identities count is in the output rather than in a
comment, because a scramble that silently did nothing would report a perfectly honest bot about a bot
reading everything. And a **deliberate cheat** was wired into `legalDeclaration` — refuse to attack
whenever any opponent holds a Lightning Bolt — built to its own `dist` and run on the same 78 games:
26 of 764 attack declarations changed and nothing else did, so the harness can see a leak and name
the kind of decision that leaked. The floor it sets is honest too: a cheat keyed to one card name in
a thirteen-deck field only shows up when the scramble moves that card at the moment an attack is
declared, so a rarer leak could hide. What the zero rules out is any leak of the size a person would
notice.

`playout.test.ts` keeps the check — three pairings, every decision asked both ways, and two
assertions that stop it being vacuous — in about a second, so a future search that peeks fails the
suite rather than shipping (D186).


### Keywords that read the attack, and the one field they needed

Seventeen keywords, all of them facts about a permanent, and combat triggers that could already say
"whenever this attacks" with `who`, `of` and what it was `attacked` into. What the vocabulary could
not say was anything about the **shape of a declaration**.

Exalted's `alone` was the one exception and its comment says why it has to live on the event: a
creature removed from combat before the trigger resolves leaves a board that cannot be counted
(CR 506.4). Battalion is the same question with a number, so the event carries `declared` now and a
trigger may ask `withAtLeast: 3`. `alone` stays separate — it means *exactly* one, and this means
**at least** N, which is what every printed card that counts attackers says. That is the entire
engine change for four keywords.

- **Firemane Avenger** ({2}{R}{W} 3/3 flier, Forge Alliance) — battalion. Three damage anywhere and
  three life on any turn three creatures attack.
- **Sunhome Stalwart** ({1}{W} 2/1 first strike, Forge Alliance) — mentor. A target filter rather
  than a new primitive: *attacking*, and *lesser power than the source*, both read off
  `state.combat.attacks` and `characteristicsOf` as the trigger goes on the stack.
- **Topan Freeblade** ({1}{W} 2/2 vigilance, Verdant Guard) — renown 1. "If it isn't renowned" is an
  intervening-if about a state the creature holds, so the answer is a counter (`RENOWNED`, beside
  `REGENERATION` and `UNEARTHED`); a creature that leaves and comes back is a new object and renown
  is available again, which is the rule.
- **Goblin Wardriver** ({1}{R} 2/2, Kindle Grove) — battle cry. The one whose *effect* reads the
  declaration: every other attacker gets +1/+0, as the list stands when it resolves.

Renown needs no "to a player" option on `combat-damage`, which was checked rather than assumed: the
engine raises that event only for damage that actually took a player's life total down, so blocked
damage and a swing stopped by a Fog raise nothing at all.

**What they measured.** Probing each revert on two seed sets of 288: Forge Alliance **−9 and −36**,
Verdant Guard **−10 and −3**, Kindle Grove **−2 and +8**. The Forge Alliance pair is the real result
— two arms of the same sign with one outside the ±20 floor — and it is a two-card change, so it says
the pair beats the pair it replaced rather than anything about battalion or mentor alone. The other
two are level: a positive sign twice for renown, a wash for battle cry, which ships for the mechanic
and for taking a seven-drop out of a deck that cast it three times in 96 games.

**And the slot mattered more than the card.** Renown went into Skyward Writ first and was cast
**3 times in the 16 games it was in hand**, against 44 for a Leonin Skyhunter and 53 for an
Omenspeaker at the same cost. Not the mana-reservation rule (2 casts with it switched off) — just
the 61st-best card in a deck with two better two-drops. The same card in Verdant Guard is cast
**27 times in 42**. `cast-counts` answered that before any win rate could have, which is the whole
argument for reading usage before pricing a slot (D188).

### The pod's politics, recorded

`Seat.damageFrom` is all damage dealt to a seat by each other seat this game, keyed by seat index —
`commanderDamage`'s wider sibling, sitting beside it because that record was already per-seat,
already in the view and already keyed by the *player* rather than the card.

It is the **first field in this state that no rule reads.** Twenty-one commander damage eliminates
a player, so that tally is machinery; this one decides nothing and no state-based action looks at
it. It exists because a four-player table asks a question every turn that nothing on the screen
could answer — *who has been coming at me, and who has left me alone* — which the pod's own notes
had listed as the missing half of its politics for as long as deals have existed.

Attribution is the most specific thing the caller passed: the attacking creature for combat, then
`source` (a permanent belongs to the seat controlling it, a spell on the stack to its owner), then
`controller`, which callers pass for lifelink rather than for attribution. Damage with no source is
counted against nobody rather than against a guess. Prevented damage is not in it, because it was
never dealt; life *paid* as a cost is not in it either, so a player bleeding themselves for cards
does not read as somebody attacking them.

Each opponent's strip in a pod reads `hit you N`, beside the deal badge and the broke-a-deal badge,
and only when it is not nought — a strip with no badge is itself the answer to the other half of the
question. `damageTakenFrom` is the helper, beside `pactBadge` and `brokeADeal`, so it is tested
where the other political reads are.

What it deliberately is not: an aggression score, a most-hated badge, or anything the software acts
on. The deals drew that line first and it is the right one (D189).


### Hybrid mana, and the cost this pool had been carrying wrong

`parseManaCost` refused every slashed symbol from the day it was written, and the refusal was the
right call with the reasoning in its own header: reading `{R/G}` as generic would offer a player a
spell they cannot cast. What it was hiding is that a deck already held one. **Murderous Redcap is
`{2}{B/R}{B/R}`** and went into Ashen Rite as `{2}{B}{R}` — the closest thing the parser could read,
and strictly harsher than the card, which is castable off four Swamps.

`ManaCost.hybrids` is a list of symbols, each listing the types that may pay it, because the choice
is **per symbol**: `{2}{B/R}{B/R}` is four mana paid in any mixture of black and red.

**The payment cannot be greedy**, which is the one interesting line here. `{G/W}{W/U}` against one
white and one blue has exactly one answer, and a greedy pass in symbol order that spends the white
on `{W/U}` leaves `{G/W}` unpayable. So `payCost` searches — depth-first over the symbols, a few
dozen possibilities at the very worst — and assigns hybrids after the coloured symbols and before
the generic part, for the reason colours come first: a hybrid can be paid two ways and generic any
way. `solveTap` learns it through `shortColors`, which reports the union of the halves it cannot
pay ("any of these would help") and re-asks after every land. A hybrid symbol is one towards the
mana value (CR 202.3f).

Phyrexian (`{R/P}`), snow (`{S}`) and *monocoloured* hybrid (`{2/W}`: two generic **or** one white)
are still refused, each being a different shape that approximating into this one would get wrong in
a way a player would feel.

**Kitchen Finks** ({1}{G/W}{G/W} 3/2, gain 2 life, persist — Verdant Guard, for its Pacifism) is two
declarative lines and nothing else new. It is here because **persist had one card behind it**, and
that card is a 1/1: the body persist returns is a 0/0 the state-based actions bury immediately,
which is correct and not a demonstration. The Finks is a 3/2, so what comes back is a 2/1 still
standing. Measured at 36 casts in the 43 games it was in hand.

**Measured: the largest single-slot card result this pool has produced.** Probing the revert — the
Finks out, the Pacifism back — on two seed sets of 288:

```
seeds 3300   203 against 173   revert -30
seeds 5100   196 against 181   revert -15
```

Both negative and one of them **outside the ±20 floor**, which no card in this pool had managed
before: the biggest previous card number was D183's Hellspark at +4 and +6, and the only larger
moves of any kind were bot rules (D175's +29, D180's +19).

Three things to keep it honest. It prices the **pair** — this Pacifism out, this Finks in — and
cannot say how much of thirty games is the body arriving and how much is the fifth removal spell
leaving; a deck with six answers and fourteen creatures was probably over-answered. One arm outside
the floor is one arm, and the second is inside it, so "between fifteen and thirty" is the honest
range rather than thirty. And a gain this size is a **balance fact** as much as a card result:
Verdant Guard was third at 61%, and a card worth twenty-odd games moves it towards the top of the
field, which is why the thirteen-deck table is republished with this entry rather than after it.

**And the Redcap's corrected cost is worth nothing in measured games**: 35 casts in 67 games in hand
either way. Seven Swamps, seven Mountains, two Guildgates and a City of Brass mean that by the turn
four mana is available one of each colour almost always is too, so the harsher cost never bit. That
is the second fidelity fix in a row measured at zero (D185's unearth bounce was the first), which is
enough to say plainly: measure a rules deviation rather than assuming it, in either direction —
D183's leak was worth half a card and these two were worth nothing. The reason to ship them is the
same either way: the card says so (D190).

### Cascade, and the two engine firsts behind it (D191)

**A trigger that fires from the stack.** Every watcher in this engine was a permanent on a
battlefield, with three exceptions that fire from wherever a permanent *went* — a death, a leave, a
card arriving in a graveyard. "When you cast this spell" is none of those: it is an ability of a
card **on the stack**, which is the shape cascade, storm, replicate, conspire and ripple all
abbreviate. So the `spell-cast` trigger gained a `self` flag and `raise` puts the card being cast at
the head of the watcher list for that one event.

The guard matters more than the feature. A card's script may hold an ordinary battlefield cast
trigger, and a stack watcher that answered those would fire them off the card's own casting on the
way past — **Chalice of the Void would have countered itself on the way in**, because its trigger is
`by: 'any', spell: 'any'` and a Chalice cast for X=0 is a nought-cost spell with no charge counters
on it yet. The loop skips a stack watcher for any trigger that does not say `self`, and there is a
test on exactly that cast.

**A cast with nothing paid.** The five places a spell could be cast from were all player actions
with a cost paid and a timing checked. Cascade's cast happens inside the resolution of a triggered
ability, with a spell on the stack underneath it, and nothing is paid at all — so the resolution
stops and *offers*: `pendingFreeCast` names a seat, a card in exile, and the rest of the pile bound
for the bottom of the library. The engine does not cast the card itself, because casting is a choice
with every other choice inside it; `legalActions` narrows that seat's plays to the casts of that one
card and `auto:cast` with `free: true` claims the offer. Declining is a pass, which is all a pass can
mean for a seat holding no priority.

Everything else is ordinary, deliberately: it chooses targets and modes, pays an additional cost,
rings every cast trigger, can be countered, and reads `(free)` on the stack beside `(flashback)` and
`(foretold)`. Three refusals make the flag a claim rather than a licence — nothing offered, somebody
else's offer, a different card — and a fourth refuses an X, because X is nought in a cost that is not
paid (CR 107.3b).

**Bloodbraid Elf** goes into Kindle Grove for its last Giant Growth, the least-cast card in that
list (10 casts in 96 games). What the keyword is actually worth is a new instrument,
`scripts/measure/offers.mjs`, and the answer is small:

```
144 games: 20 cascades fired, 1.95 cards exiled each (the hit included)
of them: 18 cast, 2 declined
the commonest hit: Llanowar Elves, 8 of 20
```

Twenty firings in 144 games — a one-of four-drop fires about as often as it is drawn — each buying
about half a card. Probing the revert on **four** seed sets of 288 gives −9, +7, −17 and −21: three
say the card is worth something, one says it is worth less than nothing, and the mean of about ten
games is half the noise floor. Under this project's own rule (two seed sets kill a change, four ship
a small one) that is a keep, and the number is published as a range rather than a figure.

The web path is a sentence in the arena bar with **Cast it** and **Decline** beside it, the playable
badge on the exile row, and the `free` flag on the action the table builds — and it is **driven in a
browser**: `LIST=cascade node scripts/e2e-solo.mjs` pastes sixty cards built for the keyword and
requires the free cast the default run only samples. That run found the two defects the engine's own
tests could not, both of them in the table: nobody holds priority while the offer stands, so the
suite read a stopped table as "nobody has anything to do"; and a cascade into **Rancor** needs a
target, so taking the offer opens the targeting prompt while the offer is still up, which a driver
branch placed too early answered by pressing "Cast it" forty times.

### Storm, the count of a turn's spells, and a rule deleted on a zero (D192)

Cascade built the path; storm is the second card down it and cost **one new fact**:
`GameState.spellsCastThisTurn`, a running total of everybody's spells reset in the cleanup step, plus
`StackObject.castNumber` — the total as each spell was cast. The snapshot is the part that matters:
a spell cast in response to a storm spell is not a spell cast *before* it (CR 702.40a), so reading
the live total on resolution would turn every answer into a copy for the caster.

**Grapeshot** ({R}, one damage, storm) goes into Arc Tempest for its second Magma Jet — not for
Twincast, which is cast twice in 96 games but is the only card anywhere that copies a *spell* with a
re-aim, and this pool does not keep paths with no card behind them.

What the new instrument says is more interesting than the card:

```
848 turns: 42% held no spell at all, 37% one, 18% two, 3% three
7 storm spells cast, 7 of them with a count of nought
```

**The bot cannot use the keyword.** Every Grapeshot it cast was the first spell of its turn, for one
damage. The obvious fix — an eighteenth drop-this-option filter, "not as the first spell of a turn
when there is another to cast" — was built, wired in and **measured at zero firings**, because the
explanation was wrong: asked a position with a Grapeshot, a Lightning Bolt and three mana, the bot
already casts the Bolt first. The Grapeshots at nought are the turns where nothing else was
castable, and 42% of turns hold no spell at all. The filter is deleted and the number kept: the
ceiling on storm here is the mana curve rather than the bot's judgement, which makes it a card for
the two people at the table. The paired probe agrees it costs the deck nothing: 126-128 and 114-113
on two seed sets of 288, level to within two games.

### Madness, the offer with a price on it, and a rule that is right and worth nothing (D193)

Cascade's `pendingFreeCast` is now `pendingOfferedCast` with a **cost**, because madness
(CR 702.35a) is the same question with a price on it: you may cast this card, now, out of exile.
One field, two keywords, and the action flag is `offered` rather than `free`.

Two things madness needed that cascade did not. **A discard has to be tellable from every other way
a card reaches a graveyard** — a mill, a spell finishing its resolution — and by the time a
replacement runs the card has moved and the zone it came from is gone; so `relocate` records
hand-to-graveyard moves in `discarded`, in the one place a card changes zone. And **an offer nobody
can pay for is not a choice**, so `settleOffer` takes it back and says so, the way a ward nobody can
pay is answered without a prompt.

**Fiery Temper** goes into Ashen Rite for its third Blood Artist — a redundant copy rather than the
least-cast card, because every card below it in usage is the only card in any deck behind some
engine path. The slot measures level: 153-150 and 132-133 on two seed sets of 288.

The instrument found the interesting part. Over 96 games: **281 discards, none of them a madness
card, 41 of them made out of a hand that was holding one.** Both of the bot's discard policies rank
by mana value — one pitches the cheapest card, the other the dearest — and a three-mana sorcery is
neither. So the rule writes itself: when a discard is owed and a madness card is in hand whose cost
is payable, give up that card first.

It fires **zero times in 96 games**, and the reason is a ceiling this project has measured three
times from three directions (D108, D110, D119): **the bot does not hold mana.** The chances were
payable before the action and gone by the moment of the discard, because the Faithless Looting was
cast with the mana that would have paid for the madness cast. The rule stays — there is a position
where it changes the play and a test that holds it there — and the number stays with it.

### Evoke, the first cost that changes what the permanent does afterwards (D194)

Flashback, escape and foretell each replaced a cost and were done. Evoke (CR 702.74) is the first
where the cost is half the sentence: cast a Mulldrifter for {2}{U}, it resolves, it draws its two
cards, and then it sacrifices itself.

The sacrifice needed nothing new. It is printed as a triggered ability with an intervening-if
clause — "when this enters, **if its evoke cost was paid**, sacrifice it" — and all three pieces of
that were already here, so it is written out as `evokeSacrifice()` beside `cascade()` and `storm()`.
What the condition reads is the `EVOKED` counter, written onto the permanent as it arrives, because
by the time the trigger resolves the stack object is gone and a Mulldrifter is a Mulldrifter however
it was paid for. The sacrifice is **listed first** in the card's triggers so it goes on the stack
underneath the draw and resolves after it; the other order is three mana for nothing.

The cast is the kicker's shape with the trade reversed — one card, one zone, two plays — and that
reversal is the one thing that moved in `legalActions`: a kicker can only make a cast dearer, so it
can be offered last, while this one is cheaper and has to be offered **above** the affordability
check, beside morph's and foretell's. The turn the card is in the deck for is the turn the printed
cost cannot be paid.

**Mulldrifter into Tidal Mind**, for the Think Twice: the pool's weakest deck, whose diagnosis is
that it answers things and kills nobody, gets one slot that is a Divination on a three-mana turn and
a 2/2 flier that draws two on a five-mana one. The slot measures level — +10 and −14 on two seed
sets of 288, opposite signs inside the floor — so it ships on the role and the number is recorded as
nothing.

`cast-counts.mjs` now splits a card's castings by which cost was paid (any alternative-cost flag,
so later keywords are counted without being told about). Over 96 games the Mulldrifter is cast in
**33 of the 44 games it reached hand**, and **one** of those thirty-three paid the evoke cost: the
bot reaches a five-mana card on a turn it has five lands. The choice the keyword exists for is a
choice about this turn's mana, and it comes up about once in a hundred games.

### Dash, evoke's mirror, and the keyword the bot actually takes (D195)

Dash (CR 702.109) is the other half of the trade evoke makes. Evoke buys the spell and gives up the
body; dash buys the body for one turn — haste, an attack, and back to hand at the beginning of the
next end step — and gives up keeping it.

The engine difference is where the consequence lives. Evoke's sacrifice is a **triggered ability
printed on the card**, so the card carries it. Dash's haste and return are part of the **resolution
of the spell** (CR 702.109a): nothing goes on the stack for either, so there is no window between
the creature arriving and it having haste, and no trigger to counter to keep it on the battlefield.
`completeResolution` does both as the permanent arrives. The return is a delayed trigger, so it
outlives the creature and does nothing when the creature has gone — which is the rule (CR 603.7d)
and has a test.

In `legalActions` the two keywords are one block: both are a second play on a card in hand, cheaper
than printed, offered above the affordability check, with one sentence each saying what the cheap
cast costs besides mana.

**Mardu Scout into Kindle Grove**, for the second Centaur Courser, beside the Hellspark Elemental it
makes a pair with — both are three damage that does not stay, and they pay for it differently. The
slot measures level (+2 and −5 on two seed sets of 288), like the Mulldrifter's.

The usage is where the two keywords part. Over 96 games the Scout is cast **60 times in the 47 games
it reached hand** — more than once a game, which is only possible because the dashed copies came
back — and **14** of those paid the dash cost, against the Mulldrifter's **one** evoke in the same
number of games. Dash's choice is "spend one mana now"; evoke's is "give up a creature you could
have had". A bot that does not hold mana (D108, D110, D119) takes the first and not the second.

### Bestow, and the first permanent that changes type where it stands (D196)

Evoke and dash change what happens to the permanent afterwards. Bestow (CR 702.103) changes what
the spell **is**: a Boon Satyr for {1}{G}{G} is a 4/2 with flash, and for {3}{G}{G} it is an Aura
giving +4/+2 that is not a creature at all — until the creature it enchants leaves, when it becomes
the 4/2 where it stands.

The fact lives on the card, as `CardInstance.bestowed`, read by `characteristicsOf` beside `castAs`
and the face-down profile: all three answer *what is this object*, and everything downstream asks
that one function. So "counter target creature spell" misses it on the stack, a Day of Judgment
misses it on the battlefield, and neither of them was told anything. It is set as the spell is
announced, because the difference is public from that moment, and cleared by `relocate` everywhere
but the stack and the battlefield — the card in the graveyard is a creature card again.

Becoming a creature is a **state-based action**, not a replacement: the rule that sends a hostless
Aura to the graveyard (CR 704.5m) grew a clause, because nothing is being replaced — the Aura never
begins to go anywhere, it stops meeting the condition that would send it.

`legalActions` now offers all three keywords from one list of alternatives, and this is the one that
carries **its own target specs**: a bestowed cast enchants a creature where the ordinary cast of the
same card targets nothing, and an Aura with nothing to enchant is not a cast at all.

**Boon Satyr into Verdant Guard**, for the second Secure the Wastes: the deck's recurring problem is
being two-for-oned, and a bestowed Satyr is the only card in the pool that cannot be. The slot
measures level (−3 and −4 on two seed sets of 288), like the other two.

The usage is the finding. Over 288 games the Satyr is cast **63 times in the 66 games it reached
hand** and **not once** for its bestow cost: the bot takes the cheap half because the cheap half is
cheaper, and a 4/2 on the board beats +4/+2 on a creature already there for two more mana. Evoke's
one-in-thirty-three with the volume turned up, and no rule written for it — a bot rule gets written
when an instrument says what it is worth.

And `cast-counts` needed twelve seeds rather than four to say it: the subject deck gets one shuffle
per seed per seating, so four seeds is eight library orders, and a single card can sit deep in all
eight. The README says so now.

**All three keywords are driven in a browser**, through `LIST=costs` — the cascade scenario's idea
applied to three cards at once: a pasted deck of Mulldrifters, Mardu Scouts and Boon Satyrs, and a
run that requires each of the three cheap rows to be pressed. It needed one thing the cascade one did not,
because one game is not enough: the scenario deals again, up to three games, through the rematch
button, until all three have been taken. Biasing the driver towards the cheap row instead was tried
and was worse — a dashed Scout comes back to hand, so "always take the cheap row" is a loop that
paid the dash cost twenty-one times and never cast the Mulldrifter.

### Spectacle, the cheap cast the board has to earn (D197)

Evoke, dash and bestow are always on offer. Spectacle (CR 702.137) is the first alternative cost
here that is **earned**: the row appears on the card only once an opponent has lost life this turn,
so it comes and goes mid-turn, and a Skewer the Critics is a Lightning Bolt after an attack and a
bad Lava Spike before one.

That needed a fact nothing in the engine held. Life totals do not say it — a player on eighteen may
have been on twenty a moment ago or for four turns — and `Seat.damageFrom` is the whole game rather
than this turn, and counts damage rather than life. So `GameState.lifeLostThisTurn`, the second
thing this engine remembers about a *turn* after storm's spell count, written by one function
(`recordLifeLost`) from the only two places a seat's life goes down — the player half of
`dealDamage` and `loseLife` — and cleared in `endTurnCleanup` beside the spell count. Damage
replaced by poison is **not** life lost (CR 120.3), so an infect deck's hits do not turn the cheap
cast on; there is a test.

`legalActions` builds this alternative **conditionally** — the first of the four that is not simply
pushed — so on a turn nobody has been hit the row is absent rather than present and unpayable, and
when it is there it says why: *"spectacle cost ({R}, because an opponent has lost life this turn)"*.
"An opponent" is any other seat still in the game, so in a pod a hit on anybody but you pays for it.
`castSpell` refuses a spectacle cast whose condition is false, the same belt-and-braces the other
three flags have. There is nothing else to build: spectacle changes the price and nothing else,
which is why the card is two declarative lines.

**Skewer the Critics into Ashen Rite**, for the second Zulaport Cutthroat — the deck earns the
condition without trying, with four drains and five burn spells. The slot measures level (−3 and −4
on two seed sets of 288), the fourth in a row to do so.

The usage is where this one parts from the other three. Over 288 games the Skewer is cast **102
times in the 124 games it reached hand**, and **28 of those 102 paid the spectacle cost** — 27%,
against dash's 23%, evoke's one in thirty-three and bestow's nought in sixty-three. The bot takes
an alternative cost when the cost is simply smaller and nothing is given up, and spectacle gives up
nothing at all: the spell is identical either way. So 28 is much less a reading of its judgement
than of how often this deck has already drawn blood by the time it wants three mana of burn — about
a quarter of the time. No bot rule again, for the fourth time, and for the cleanest reason yet:
there is nothing to decide.

### Overload, the cost that rewrites the spell (D198)

Overload (CR 702.96) is the fifth alternative cost and the first that changes what the spell
**does**: "change each instance of 'target' to 'each'". A Mizzium Mortars for {1}{R} deals four
damage to one creature you don't control; for {3}{R}{R}{R} it deals four to every creature you don't
control and points at nothing while it does it.

So `CardScript.overload` holds a cost **and an `onResolve` of its own**, and `completeResolution`
picks between the card's two effects on the stack object's `overloaded` — the only one of the five
flags the resolution reads at all, since the other four are spent by the time the spell resolves.
Two functions rather than one that branches: the printed half reads `cardTargets`, which is empty on
an overloaded cast, so a shared effect would have to guard every line against a target it will never
have.

The empty target list is most of what the keyword is worth. A ward never triggers (the printed
Mortars at a Sedgemoor Witch pays {3} or is countered; the sweep walks through), a Willbender has
nothing to redirect, protection and a Dive Down save nothing, and the spell cannot fizzle — the only
answer left is a counterspell, which is why the stack says `(overloaded)`. And it is four damage
rather than "destroy", which a Wall of Frost demonstrates by standing up to it.

It is the first of the five that is **dearer** than printed, which makes it the kicker's neighbour on
price and its opposite in mechanics: a kicker is paid on top, an overload cost replaces. Being dearer
costs nothing in the alternatives list, because that loop asks `canAfford` per entry — so the row is
simply absent on a turn six mana is out of reach.

**Mizzium Mortars into Ember Rush**, for the second Raging Goblin: the deck that can pay either half
(eighteen Mountains and a Mutavault) and wants both — the removal a burn deck never had for a 4/4
blocker, and the card that wins the game it has otherwise already lost. The slot measures level (+2
and +5 on two seed sets of 288), the fifth in a row inside the floor, and the first where both arms
lean the same way.

The usage is the most interesting of the five. Over 288 games the Mortars is cast **62 times in the
98 games it reached hand**, and **11 of those 62 were the sweep** — 18%, against spectacle's 27%,
dash's 23%, evoke's one in thirty-three and bestow's nought in sixty-three. It is also the only one
of the five that is a *judgement*: the cheap ones are cheaper and give up nothing, the body ones cost
a creature a greedy evaluation will not give up, and this one costs **four more mana** and the bot
still pays it one time in five, which it can only do because the one-ply search sees the board it
clears. `wasted-plays.mjs` confirms the other half of that: over 576 plays the suspects are a Goblin
Arsonist and a Flame Slash, and the Mortars is **not in the list** — it is not being overloaded into
an empty board, so no bot rule was needed for a better reason than "it never presses it".

One more thing came out of it, in `apps/web`. `playAction` had grown one
`const withX = play.flag === true ? { flag: true } : {}` per alternative cost, spread into the action
it builds, and the eleventh made the web typecheck fail outright: **TS2590, "union type that is too
complex to represent"** — eleven spreads of `{} | { flag: true }` is a union of 2,048 object types.
They are now one `COST_FLAGS` list and one loop, with one comment that says what the family is
instead of eleven that each say it once. A type error is not usually a design note; this one was
counting the shape the code had drifted into.

### The two odd rows in a browser, and a finished game that was still asking (D199, D200)

`LIST=earned` is the third purpose-built list in `scripts/e2e-solo.mjs`, and it exists for the two
alternative-cost rows that behave unlike the other three: **spectacle's row appears mid-turn** (and
is gone when the turn ends), and **overload's row has no targets at all**, so the table must send it
on one tap rather than asking for a creature. Both are table behaviour the engine's own 1012 tests
cannot see.

Four attempts, each failing for a reason about the game: twelve Swiftspears could only earn the
spectacle row in the *postcombat* main phase, so Bolts were added to earn it precombat; twenty-four
burn spells with no bodies could not close a game at all (**450 moves of nothing but Pass**); the
clock plus a fast opponent swung it the other way (three games in twenty-nine moves, never a sixth
land, so the overload row never appeared); and the answer was eight Sol Rings plus the original
opponent — 36-to-59-move games that press both rows, three runs out of three. The deal budget is
five games, because whichever row a shuffle offers, the other is usually one deal away.

One engine bug came out of CI while that was being built, and it had been there since the automation
layer. `engine.ts` ends a game by setting every outstanding question to null — decision, choice,
ward payment, offered cast, discard — because a resolution can be mid-question when the last
opponent dies (CR 104.1). But a **combat declaration is not a field**: `pendingDeclaration` derives
it from the step and the combat record, so a game that ended while attackers or blockers were owed
kept asking for them, with `legalActions` withholding priority the whole time — a game-over screen
that is also demanding attackers, and no way out. It now returns null on a finished game.

A rule that clears outstanding questions has to enumerate them, and the derived one is the one that
escapes the list.

### The table's own atmosphere (D201)

The engine had got a long way ahead of the table it is played on. Two of the pieces CLAUDE.md
specifies for the Play Realm were missing, and they are the two that make a board read as a game
rather than as a form.

**`ArenaEmbers`** is a second canvas, and the difference from the app's `AmbientCanvas` is the
point: that one is the backdrop every page shares, violet runes fixed to the viewport. This one
belongs to the game — WUBRG embers at the table's own layer, so they move with the board, leaning
towards the cursor inside the spec's 160px aura with friction applied every frame so a long hover
bends the field instead of collapsing it. It allocates nothing under `prefers-reduced-motion`, stops
its loop on `visibilitychange` rather than animating a table nobody is looking at, and caps its
count by screen width, because a four-seat pod on a phone is the smallest screen with the most to
draw. Each ember is a bright core inside a dim halo — two cheap arcs rather than `shadowBlur`, which
is the one canvas property that reliably costs a frame on a phone.

**The cards lean towards the cursor.** Three transforms have to compose on one element — the
centring on its slot, the quarter turn when it is tapped, and the tilt — so they are written as one
arbitrary transform in the order that reads correctly, with the tapped rotation travelling as a
variable so the tilt never has to know about it. The pointer handler writes custom properties
straight onto the node instead of going through React state: forty cards times a pointermove each is
the one place in this app where a re-render per frame would be felt. Mouse only, because a touch
hover is a tap in progress.

Reduced motion needed a rule of its own rather than the blanket transition-killer already in
`index.css`: zeroing a duration only makes a tilt *instant*, which for somebody who asked for less
movement is worse than a smooth one.

And both are checked in a browser, because neither can be seen any other way: the solo suite hovers
a card and reads the tilt variables back off it. That is the general shape of this kind of work —
an effect that lives entirely in the browser is one only a browser can be asked about.

### Energy, and the bug an instrument found by its absence (D202)

Energy (CR 122) is the first resource in this engine that is none of mana, life, tapping, graveyard
cards or counters on a permanent: it is a counter on the **player**, never emptied, saved across
turns. It needed no new state — `Seat.counters` was always meant for it and nothing had used it — so
the work is in the cost (`AbilityCost.energy`), the offer, the payment, and one place for the
arithmetic (`addEnergy`/`spendEnergy`/`energyOf`). Nothing in `endTurnCleanup` touches it, and that
absence has a test.

Four cards are the whole mechanic: **Aether Hub** (a land that arrives with one and spends it for a
colour), **Longtusk Cub** (two when it connects, two for a counter), **Bristling Hydra** (three on
arrival, three to grow and gain hexproof — an answer to removal already on the stack) and
**Harnessed Lightning**, the first spell here whose effect asks *how much of a resource to spend*.
They go into Kindle Grove, and the slot measures level and faintly negative (−7 and −3 on two seed
sets of 288) from a four-card swap.

`scripts/measure/energy.mjs` exists because nothing else could see the mechanic: `cast-counts` counts
casts and three of the four spend through an activated ability. Its first run found a real bug **by
an absence** — the Hub gave out thirty-six energy and none was ever spent, because `manaSources` read
mana, tap, sacrifice and life on an ability and never energy, so the auto-tapper would tap a Hub for
any colour with none at all. Fixed twice over: an unpayable row is not a source, and a permanent with
both a free tap and a paid one gives the auto-tapper the free one, because spending a saved resource
to fix a colour is a judgement about the next three turns.

Measured over 288 games the bot **spends** it — 401 given, 326 spent, 81% — which is the opposite of
the worry the task was written around. The surprise is elsewhere: **Longtusk Cub gave nine energy in
288 games**, because a 2/2 that must connect rarely does. The mechanic runs on the payoff card's own
arrival trigger rather than on its enabler.

### Embalm and eternalize, and the instrument that was wrong by a factor of eight (D203)

Embalm (CR 702.89) and eternalize (CR 702.100) are the fourth and fifth things payable out of a
graveyard and the first two whose product is **not the card**: they exile it for good and hand over a
token copy "except it's a white Zombie with no mana cost", or a black Zombie with base power and
toughness 4/4.

The exception clause was the only missing piece. `copyAsToken` already built a token from the copied
card's own definition, which is what a copy is — but a copy with *different* characteristics needs a
different definition, and `defKey` is a card's lowercased **name**, so an altered one registered
under its own name would have rewritten the printed card every other copy reads. So
`TokenCopyProfile` is a short list of printed fields to replace, registered under the card's key
plus a suffix (`sacred cat#embalmed`), with the token's `name` left alone — which is what still
gives it the copied card's abilities, because `scriptFor` looks a script up by name. That is the
whole reason these keywords are printed on cards with text: an **Angel of Sanctions** token exiles
another permanent when it arrives and hands it back when the token dies.

`AbilityCost.exileSelf` is `discardSelf` one zone along and a **cost**, not an effect: embalm exiles
the card as the cost, so the same Sacred Cat cannot be embalmed twice while the first ability is
still on the stack.

Four cards into Dawn Tithe — Sacred Cat, Adorned Pouncer, Sunscourge Champion, Angel of Sanctions —
and not into Skyward Writ, which runs the pool's only Rest in Peace; a symmetric graveyard hoser and
six cards that need a graveyard cannot share a sixty, and moving the hoser was worse than moving the
cards.

**The measurement is the part worth reading, and it had to be fixed before it could be read.** The
new block in `graveyard-costs.mjs` first reported a Sacred Cat embalmed 12 times in 288 games;
`cast-counts`, on the same seeds, read **125**. At two seeds the two agree to the game, so the
disagreement was about where they look: `cast-counts` counts the **action**, and this block was
reading the **stack between actions** — and with `autoPass: true` an object nobody wants to respond
to is put on the stack and resolved *inside the same `applyAction`*. Roughly one in eight survives
to be seen. Every escape and delve number this harness ever printed was that fraction, D171's
included, and the "escape is rare" conclusion there was an artefact of the instrument. The block now
counts actions, reads the cost as the cards that left the seat's graveyard for exile while the
action was applied, and counts only the casts that actually spent it — because a Phoenix of Ash cast
from *hand* is the same card and the same action type.

With that fixed: the bot takes **87% to 100%** of the chances it is offered (125 of 144 for the Cat,
32 of 32 for the Angel), and all four cards are among the deck's most-used — Sacred Cat at 202% of
the games it is drawn in.

**And the slot is worth four points, not the forty-seven the probe wanted.** Probing the revert gave
+47 on one seed set and +19 on another, against a deck whose own noise is wider than ±20 (the old
list reads 55% and 62% on those two sets); isolating Angel of Sanctions over Serra Angel gave +11,
inside the floor. The **field table**, on the seeds the published one already uses, says Dawn Tithe
went 187-101 (65%, joint second) to **198-90 (69%, clear second)** — eleven games — with the pool's
spread unchanged at 41-42 points and Verdant Guard four points down without changing a card. So the
deck needs no trim: it has two losing matchups and its arrival in second narrows the gap at the top
from twelve points to seven. The general lesson points the other way from D183, where the table found
a change *larger* than the probes: a paired probe amplifies whatever its seeds gave it, the table
lets the field move too, and where they disagree the table is the one to publish.

**And it is pressed in a browser now**, which no cost paid out of a graveyard had been before:
`LIST=graveyard` badges a card in the graveyard as playable for an *ability*, puts the ability's own
printed text on the button, sends it with no targets to pick and draws the token. Three runs, both
rows every time. The one thing the browser cannot check honestly is the eternalized **4/4** — three
runs never had one on the board when the driver looked, because the opponent's whole turn runs inside
the same write that resolved the ability and a bounced token ceases to exist. That claim moved one
layer in, to the better test: the altered definition survives `viewFor` and `packView` with its 4/4
and empty mana cost intact, beside the printed card in the same payload, which is the name collision
`TokenCopyProfile.as` exists to prevent asked of the wire format rather than of the engine.

### Miracle, the offer made as the card is drawn, and the sweep fired at its own board (D204, D205)

The third keyword on `pendingOfferedCast`, and the first whose offer is made on a card in **hand**:
the engine stops the table as the card is drawn, says it was the first card drawn this turn, and
names a cost that is not the card's own. Cascade's hit goes back to the library when declined and
madness's goes to the graveyard; miracle's **stays where it is**, which is the one disposition the
other two have no use for and the reason `pendingOfferedCast.stays` exists.

Beside it the engine keeps a fact it never had: *which* draw of the turn a card was. A count cannot
tell the first card of a `draw(2)` from the second, so `drew` carries `{ seat, card, nth }` now and
`cardsDrawnThisTurn` resets in cleanup beside `spellsCastThisTurn` and `lifeLostThisTurn`.

**How narrow the window is, measured rather than guessed:** one copy in sixty is offered about once
every ninety first draws, and twelve of Skyward Writ's sixty-one offers were taken back because {W}
was not up when the card arrived — the offer happens in the draw step, before the land drop. The
thirteen-deck table moved exactly two rows outside its own ±20-game floor and they are the two decks
that got a card: **Arc Tempest 42% to 50%** with Thunderous Wrath, **Skyward Writ 50% to 39%** with
Terminus. Three instruments agree on the Terminus number to within three games; the Wrath's own
paired probe disagrees with itself in sign across two seed sets, which is D203's lesson again — the
table is the one to publish.

**Why Terminus loses is a fact the instrument can state:** across 52 casts it bottomed 32 of the
caster's own creatures against 41 of the opponent's, and nine of those casts were fired by the seat
that was *ahead* on board, in its own draw step, before the turn those creatures were for. Which led
to the finding behind D205: **the bot took 126 of 126 offered casts and declined none**, because in
the offer window the search picks the best of a one-element list. `sparesItsOwnBoard` is the
sixteenth member of the drop-this-option family — decline a sweep that would take more of this seat's
creatures *and* more of its power than everybody else's — and it is level bot against bot (470-464 of
936, 16 of 7192 casts changed) while being worth **+8 and +17 of 288** to the one deck in the pool
that holds a sweeper. The thirteen-deck table says the same thing from the other side: with the rule
on, the two rows that move are **Skyward Writ +17** and **Verdant Guard +9** — the two decks holding
a card it can fire on, one of which never had a miracle card at all — and nothing else moves more
than four. Kept for the play as much as the record, the same reason `ritualBoughtSomething` is kept.

**And it is driven in a browser**, where the window is the whole difficulty: `LIST=miracle` plays a
deck whose first draw is often the card it is built around, and asserts on the sentence the bar
showed rather than on anything left behind — because by the next move there is nothing to look at.
Three runs, 26 of 26 checks each.

### Rebound, and the rule that would have declined it every time (D206)

The fourth way a card gets cast twice here, and the first that pays with **time**: cast it from
hand, it exiles itself as it resolves, and at the beginning of your next upkeep you may cast it from
exile for nothing. Almost all of it is machinery that existed — a delayed trigger for the promise
(the arrangement dash and unearth use), `pendingOfferedCast` for the offer, and miracle's `stays`
for declining, because "do not move the card" is the same disposition in an exile as in a hand. What
is new is two small facts that keep it from being infinite: the spell has to have been cast **from a
hand** (`StackObject.rebounding`, read as it is announced), and it has to have **resolved** — a
countered Staggershock goes to the graveyard like anything else.

**The interesting part is a bot rule, found by reading.** `expiringPumpCanMatter` drops a pump cast
outside a combat because "a better moment is coming", which is right about a card in hand and false
about an offer: the offer is the only moment there is. Distortion Strike's rebound cast, which
happens in an upkeep, would have been declined every single time. `offerCannotWait` fixes it off a
fact rather than a flag — a declined offer leaves the card where it is, so the card's **zone** says
what declining costs: a miracle card is in a hand and can be cast later, while a cascade hit, a
madness card and a rebound card are in exile, where declining is final. The rest of the family (a
Fog with nothing attacking, a ritual that buys nothing) is about the board rather than the clock and
was left alone.

Both slots measure inside the instrument's floor — Staggershock +3 and +1, Distortion Strike +4 and
−14 on two seed sets, against a Tidal Mind whose unchanged list swings 29 games between those same
seed sets. The keyword does fire: 39 rebound offers in 192 games of Arc Tempest and 24 in Tidal
Mind's, one copy each. And `LIST=rebound` is the first browser scenario whose claim spans two turns:
three runs, 26 to 27 checks, the bar offering a free cast in the upkeep of a card the player no
longer has.

### Replicate, and the slot that was worth −19 or +1 depending on what paid for it (D207)

The first cost in this engine that can be paid **more than once on one casting**, and the first
announced number that is not {X}. The copies are storm's trigger with the count read from the
casting instead of the turn, and `copySpellOnStack` already carried targets and division — so the
engine work was the cost: a count on the cast action, one offered play per affordable number (the
kicker's arrangement rather than {X}'s picker), and a cap of four because the fifth row is not a
play anybody chooses between.

**The bot cast Pyromatics 49 times in 96 games and paid the replicate cost not once.** The rows were
offered and the search chose between them; the action it sent dropped the count, so a chosen "x2"
was quietly the printed cast — charged {1}{R}, resolved, no refusal and no failing test. Twelve cost
flags travel on a cast now and the twelfth is a number. Found by counting what the bot paid, which
is a five-minute script, and the comment block that block already carried had predicted it.

**And then the slot measurement said something general.** Pyromatics in the Firebolt's slot costs Arc
Tempest 10 and 19 games of 288 on two seed sets; the same card in the same deck in the second Think
Twice's slot gains 1 and 1. What a slot is worth is a fact about the card that *pays* for it, and a
probe run once would have drawn a conclusion about the keyword that was wrong either way round.
Train of Thought, in Hollow Tide for a Fog Bank, reads −7 and −2 — inside the floor both times.

### Extort, and the first optional mana cost paid mid-resolution (D208)

The engine could ask for mana as a spell was cast, as an ability was activated, and from an opponent
answering a ward. What it could not do was let a card ask **its own controller** for mana while that
card's ability was resolving — and the card cannot do it itself, because paying means tapping lands
and the only thing that taps lands is the automation layer. So the price goes on the **answer**:
`ChoiceDecisionSpec.payIfChosen` names an option and a cost, the engine pays it between the answer
and the effect, and the option is not offered at all to a seat that cannot pay — which leaves one
word, and a question with one answer is answered without a prompt.

Nothing in the client changed: it is the same word question Obelisk of Urd already asks, so the bar
draws it and the socket carries it. Basilica Screecher goes in Hollow Tide and Basilica Guards in
Skyward Writ, the two decks whose problem is finishing games they are not losing. The numbers are
small and honest: the creature lands in 40% of games, about four payments in those, one life each,
and the slots read −4/−3 and +1/+5 of 288 — all inside the floor. What the piece bought is the
capability.

Two things the browser forced. The driver always pressed the **first** word, which for extort is
`Decline`, so a scenario about paying an optional cost could never have paid one; it picks at random
now, the same argument the play-row picker already made. And the first version of the check passed on
a run that declined every time, because the prompt's text carries both button labels — the check
anchors on the chosen word now, and it passed before it was right.

### Suspend, the mechanic that spends turns, and the offer with no Decline (D209)

The first thing in this engine that spends **turns** as a resource: pay a cheaper cost, exile the
card with time counters, lose one at each of your upkeeps, and cast it free when the last comes off.
Two of its three joints were already built. The special action is foretell's — a play from hand that
is not a cast, pays its own cost and ends in exile — with the cost read off the card and the card
left **public**, which is half of what the mechanic costs you. And "suspended" is nothing but
counters: they live on the instance rather than on the battlefield, so a card in exile can carry them,
and `addCounters` deleting a counter that reaches zero is why a card whose cast is impossible is left
exiled and never offered again. That is the rule, for free.

The third joint is the offer family's fourth use and the one thing it had never needed. Cascade,
madness and miracle all say "you may"; suspend says you cast it. So `pendingOfferedCast` carries
`mandatory`, `legalActions` hands that seat the casts and **no pass** — the whole rule in one line —
and `settleOffer` answers the question itself when there is no legal cast, because an offer with
neither a pass nor a play is a table stopped for good.

The bar's missing **Decline** is a browser finding rather than a design decision. The first
`LIST=suspend` run passed every check and printed `cast it without paying its mana cost Cast it
Decline`: the engine right, the table offering a button whose only outcome is a refused action. The
flag travels to the client now, the bar omits it, and the driver *reports* a missing Decline instead
of pressing one, because a run that reaches that branch has found something real.

Both cards are a card Kindle Grove already plays with suspend bolted on, so the probe reads the
keyword rather than the card: **Rift Bolt** for the Lightning Strike and **Search for Tomorrow** for
the second Rampant Growth. It gains 2 of 288 on one seed set and costs 6 on the other — level twice,
and for once the dull answer is the interesting one: **a turn is worth about the two mana it saves**
in this pool. It is used, too: 21 Search for Tomorrow and 6 Rift Bolt suspended over 96 games, 24 of
those 27 cast off the last counter, two still waiting when the game ended. `foretellIsSpareMana` is
`specialIsSpareMana` now and answers for both. Three browser runs, 26 of 26 checks, and the first
scenario here whose two required checks are two turns apart in the same game.

### Dredge, the first replacement effect on a draw, and the sixth stopped table (D210)

Every replacement effect in this engine until now has been a **zone change**: a card is already
moving, `settle` finds it in one of the three lists it keeps, and whatever replaces it gets handed
the card. Dredge replaces the **draw** (CR 702.52a), and that is a different problem in two ways
that only showed up once it was written. The question has to be answered *before* the card is taken,
because afterwards it is in a hand and the answer is moot. And the only place that can ask is
`draw` — which lives in `effects.ts`, below the layer that knows what a card's script is, and
cannot stop a resolution because nothing can except a decision spec.

So the draw is **deferred** rather than paused. `drawLater` adds it to `GameState.drawsOwed`, the
card's effect finishes, and the first thing the next `settle` does is drain the queue: each owed
draw either raises `pendingDredge` or is simply taken. The deferral is invisible to everything else
because the drain happens *before* the lists of deaths and draws are announced — a card deferred by
`drawLater` reaches its `draws` trigger and its miracle offer in the same settle pass an immediate
draw would have.

What the deferral costs is a rule a card has to respect: **only a draw that is the last thing the
card does may be deferred.** Dark Confidant charges you for the card's mana value and Faithless
Looting offers the two cards it just drew to discard; both call `draw` and get no dredge, because by
the time a deferred card arrives their effect has finished. The compiler cannot tell those apart
from a terminal draw, so the rule is written at `drawLater` and the pool opts in one call site at a
time — the eighteen places where `draw(c.state, c.controller, n)` *is* the whole effect, plus the
draw step, which is where dredge actually lives.

The sixth thing that stops this table dead is also the first that is about nothing on the stack: no
spell, no target, no cast. Two buttons like a ward, because declining is the other half of a
question rather than a gesture the table already means something by — and the decline has a job no
other decline here has: it takes the draw. `auto:dredge` with `dredge: false` draws the card itself
rather than handing the owed draw back to the drain, which would offer the same dredge again
forever. That was a real bug for one run of the tests: the first version sliced the queue and
declining ate the draw.

**Both cards cost their decks.** Rot Harvest wins 8 and 14 more games of 288 without the Shambling
Shell, Blight Vector 6 and 13 more without the Darkblast — four readings on the same side of the ±20
floor, so the cards are simply worse than the Endless One and the Doom Blade they replaced.

**And the thing that was read off those numbers about the *bot* was wrong.** Running the same probes
with the rule off gave 5, 10, 3 and 7, and the difference was published as "taking every dredge
costs a further 3 to 6 games". It does not. Measured head to head with `bot-duel`, which varies the
rule and cancels the deck, the matchup and the seat, always-dredging, never-dredging and a tighter
rule are **level within two games of 624** — on a harness whose negative control is *exactly*
312-312. The 3-to-6 was the difference of two noisy numbers, each a probe with a ±20 floor. D212 has
the four runs and the lesson: **a bot rule is measured with the bot instrument**, and no amount of
running a slot probe twice turns it into an answer about the opponent.

**And the question it asks every turn now has an answer you can give once.** A dredge card stays in
the graveyard, so the table stops in every draw step for the rest of the game — correct, and twenty
taps for an answer most players repeat. `GameState.dredgeStops` holds a standing `always` or
`never` per seat, the same shape `autoPassOff` uses and for the same reason: being asked is a
preference, not a rule. Absent is "ask" and that is the default, because a mechanic that answers
itself unasked is the bug the offer family exists to avoid; both standing branches say what they did
through the replacement channel, since this is the one path where cards move with nobody pressing
anything; and the control is drawn whenever a standing answer is set as well as when the question is
up, so choosing `always` — after which you are never asked again — is not a one-way door.

**And the first card chosen for it was wrong in a way only an instrument could say.** Dredge went on
a dredge *land* first — a Swamp that enters tapped and buys itself back — which is minimal and
readable and, `dredge.mjs` reported, **offered three times in 96 games**: a dredge card works only
from a graveyard, and nothing in this pool destroys a land. The same keyword on Shambling Shell, a
2/2 that sacrifices itself, in the deck that already has two sacrifice outlets and a Blood Artist
watching for deaths, is **offered 137 times, taken 130, declined 7, for 390 cards milled**. Before
asking what a keyword is worth, ask how often the card gets to use it.

### Buyback, the cost that changes where the card goes rather than what it does (D211)

The pool has had an optional additional cost since the kicker, and every one since has been a
variation on *what the spell does*: kicker changes the effect, replicate multiplies it, the five
alternative costs replace the price. Buyback changes neither. The spell is the same spell, the
targets are the same targets — and the card goes back to its owner's **hand** instead of their
graveyard (CR 702.26a). It is the only cost here whose purchase is the card itself.

Which made it cheap to build, because both joints already existed. The second row at the printed
cost plus the buyback is the kicker's arrangement, so the table needed nothing new — a player sees
`Cast Capsize` and `Cast Capsize with buyback {3}` and the row's own words say what the three mana
buys. And "somewhere other than the graveyard as it leaves the stack" is the branch flashback and
the adventure already share in `spellLeavesStack`, which takes a `resolved` flag precisely because
*some* of those dispositions depend on the spell having finished and some do not.

Buyback depends on it, and a test proved the dependency rather than assuming it: **a countered
bought-back Capsize goes to the graveyard**, because the promise is about resolving. The first
version of that test failed for a different reason and was the more useful failure — it targeted the
spell with `{ kind: 'spell' }`, the engine's counterspells target a spell on the stack as a
`{ kind: 'card' }`, and the Cancel resolved without countering anything. A test that had been
written to pass would have hidden it.

Two refusals keep the keyword honest. The row is offered only on an **instant or a sorcery**,
because a permanent spell resolving becomes a permanent and never leaves the stack for a graveyard
at all, so the extra mana would buy nothing — `legalActions` does not draw it and `auto:cast`
refuses it, which is the same two-sided rule every cost flag here keeps. And buyback is not paid
beside an alternative cost, for the plain reason that an alternative cost replaces the printed one
it is added to.

**The bot pays it**, which is the check D207 made permanent: 25 of 54 Capsize casts and 5 of 44
Whispers of the Muse casts over 96 games apiece, counted off `action.buyback` rather than inferred.
A cost flag dropped between the chosen play and the action sent is silently the other play, and the
replicate bug is what that looks like when nobody counts.

**And the slot had to be moved after it was measured, which is the same lesson a second time.**
Whispers of the Muse is level (+3 and −5 of 288). Capsize, in for the second Man-o'-War, costs Tidal
Mind **23 and 12** — the first outside the ±20 floor. Re-priced against the second Thieving Magpie:
**12 and 4**, same card, same deck, same seeds. Half of it was the payer, because a Man-o'-War
bounces a creature *and leaves a 2/2 behind*, so "a bounce for a bounce" was never fair. The
committed slot is the Magpie's now. And what is left is not a wasted play — Capsize does not appear
in `wasted-plays.mjs` at all over 312 games — it is a slow one: six mana to bounce one permanent,
buying a long game this pool rarely reaches.

### Proliferate, and the first question whose answer can be a player (D213)

Every question this table has ever asked is answered with **cards**: a sacrifice, a scry, a
search, a discard, a damage order, a copy's new target. Proliferate chooses "any number of permanents
and/or players with counters on them" (CR 701.27a), and poison lives on a *seat* — so this is the
first answer with no card in it.

It cost a prefix rather than a question type. `CountersDecisionSpec` is an ordinary decision with
`counters: true`, which swaps the candidate list for `proliferateCandidates` — every battlefield
permanent carrying a counter, plus `seat:N` for every player carrying one — in the **same**
`candidates: string[]`. Two lists would have taught the reducer, the bot, the view and the driver
that an answer has two kinds; one list left all of them alone, so `min`/`max` still count the answer
and `auto:decide` still carries it. The client got half of it free: the lit-cards set reads
`ask.candidates` wholesale, so the permanents lit themselves and only the seat strip was new. It
borrows the targetable ring it already had, and its button says **Choose Nick** rather than *Target*
Nick, because a proliferate does not target.

The rule is one more of **each kind already there**, which is the keyword's whole subtlety: a
permanent with a +1/+1 and a -1/-1 gets one of each, and a permanent with nothing is not a candidate
at all. And the thing people expect of it that it does not do — **a suspended card is left alone**,
because time counters sit on a card in exile and exile holds no permanents. That is a test rather
than a comment.

Contagion Clasp went into Blight Vector and Steady Progress into Hollow Tide, both **level** on two
seed sets: −8/+4 and −11/+4 of 288, each pair disagreeing in sign and every reading inside the ±20
floor. Expected for a two-mana artifact whose ability costs four, in a format these decks usually
finish before turn eight.

**And the browser row found two defects that had nothing to do with the keyword.** The board never
said a permanent had something to do: hand, graveyard, exile and the command zone all badge a card
`playable` and the battlefield did not, so an Equipment that could move, a Vehicle that could be
crewed, a monstrosity and a regenerate were all invisible — the plays were on the card's own sheet
the whole time and nothing told a player to open it. It badges them now, mana abilities excluded,
because every untapped land has one and a badge on half the board says nothing. And no browser suite
had ever **activated an ability of a permanent**, for exactly that reason. It can now, off by
default: the first version turned it on everywhere and `LIST=cascade` stopped casting Bloodbraid
Elves, because regenerating a River Boa costs {G} and a Forest spent on a shield nobody needed is a
Forest the four-mana Elf wanted.

### Echo, the first cost the game asks for rather than offers (D214)

Every cost in this engine is one a player reaches for: a cast, an activation, a kicker, a replicate
count, a ward, an extort. Echo (CR 702.29) arrives on its own, in the controller's upkeep, before
anybody has done anything — and declining it does not mean missing out on something. The permanent
goes to the graveyard. It is the first question here whose **no** destroys the thing that asked it.

It needed nothing new, which is the part worth recording. `{ kind: 'step', step: 'upkeep' }` already
defaulted to the controller's own upkeep; `TriggerDef.condition` is the intervening-if clause, reading
a new instance flag; and `ChoiceDecisionSpec.payIfChosen` is extort's question-with-a-price. The
composition even carries the half that would have been a rule: a cost the seat cannot pay is **not
offered**, so nobody is shown a question with one button — the permanent goes and the engine says so.

The flag is `echoDue`, set wherever a permanent **comes under a controller's control** (the arrivals
pass, and a change of control) and cleared by the trigger that read it. Arithmetic on `enteredTurn`
was the obvious alternative and is wrong: "since your last upkeep" is not "this turn or last turn" at
a four-seat table, where a creature that entered on an opponent's turn has had no upkeep of its
controller's in between.

**And one test could not be written the obvious way.** "Tapped out in your own upkeep" is impossible
for a creature you *cast* — lands untap before the upkeep, so a seat that could cast it can always
pay for it. The first attempt tapped the lands by hand during the opponent's turn and proved nothing,
because the untap step undid it. The honest scenario is a permanent that reached the battlefield
without being cast: reanimated, put there by an effect, or taken off somebody. Which is also the only
way it happens in a real game.

Mogg War Marshal went into Ember Rush and Yavimaya Granger into Kindle Grove: **+8/+6 and +7/+2** of
288 on two seed sets — inside the ±20 floor, so not a result, but four readings with the same sign,
which is the most a probe can honestly say for a card this small. The pair is deliberate: the Marshal
is the echo you **decline** (it leaves a Goblin behind either way) and the Granger the one you **pay**
(its land is already in play, so only the 2/2 is in question).

The bot's rule is "pay", and it is **not priced head to head** — a card's `best` receives
`(state, chooser)` and cannot see `BotOptions`, so there is no flag for `bot-duel` to vary. Threading
the options into that call would make every card-authored bot answer measurable at once; D214 leaves
it as an open question rather than doing it badly here.

### Cumulative upkeep, and the question a card works out when it is asked (D215)

Echo is a cost the game asks for, once. Cumulative upkeep (CR 702.24) is the same question every
upkeep with the one thing echo did not have: **the price climbs**. An age counter goes on as the
ability resolves, the cost is that counter's worth for each one on the card, and a permanent worth a
mana a turn stops being worth it somewhere around the fourth.

`payIfChosen` is a static pair, and here the cost, the prompt and the words on the buttons are facts
about *this* resolution. Two shapes could carry that: widen `pendingPayment` — the ward-only stopped
table — into a general "a cost the game demands", or let a card **compute its question when it is
asked**, the way `NumberDecisionSpec.range` already computes its bounds. The second, because echo
already asks through the decision machinery and the first would have given the pool two mechanisms
for one question shape, with two reducer paths and two places for the next keyword to go wrong.

`DecisionSpecOf` is "a spec, or a function of the state and the source", resolved in exactly one
place — `decisionSpecsFor`, which the plan, the asking, the payment and the impossible-payment
fallback all already went through. Four readers, one funnel. Two orderings keep it honest and both
are on the type: the counter is added in `beforeDecisions`, before any question is planned, and the
function must be pure, because the engine resolves it more than once and the resolutions must agree.

Mystic Remora went into Tidal Mind, and **there is no fair payer for it in that deck** — so the slot
is bracketed rather than reported as one number: **−9/−10** of 288 against the second Man-o'-War (a
card the deck gets a lot out of) and **+2/−8** against Tormod's Crypt (the most marginal card in the
list). Both inside the ±20 floor, so neither is a result; the honest summary is that the card is a
wash in this deck, and the slot is justified by the pool needing a card behind the keyword rather
than by a win-rate gain.

`LIST=upkeep` requires **two different prices** to have been pressed through a real browser, which is
the one thing the engine tests cannot see: the question is rebuilt on each asking, so a table that
re-rendered the first one would offer `Pay {1}` against a cost of `{2}`, the engine would refuse, and
the permanent would go with the player unable to see why.

### Level up, a creature whose characteristics are a count on itself (D216)

Every permanent in this pool is what its card prints plus whatever has been layered on it. A leveler
(CR 702.87, CR 711.3) is the first whose **printed** characteristics depend on its own counters: a
Student of Warfare is a 1/1, a 3/3 first striker at two level counters and a 4/4 double striker at
seven. One card, nothing layered on it, three creatures.

The bands live on the **definition**, as `CardDef.levelBands`, and the ability that adds a counter
lives in the script, as the ability `levelUpAbility` builds. What the creature *is* at each level is
a printed line on the card, exactly as its base 1/1 is — and that split is forced as well as tidy,
because `characteristics.ts` **cannot read the script registry**: `scripts.ts` imports it, so the
dependency runs one way only.
Bands in the script would have meant either a cycle or a second mechanism for "what is this
permanent", which is the thing the layer system exists to be.

A band **sets** the size, so it is layer 7b (CR 613.4), and the two interactions that prove it are
tests: a **pump lands on top** (a level-two Student with a Giant Growth is a 6/6, not a 3/3 and not a
4/4) and a **later setting effect beats it** (a Turn to Frog on a level-seven Student makes a 1/1
with no abilities, because the band's timestamp is the permanent's own arrival and every setting
effect is later than that). The band's keywords are seeded alongside the printed ones, which gets
"loses all abilities" right without a line of its own. And one interaction nobody planned, pinned
because the two keywords were built two pieces apart: **proliferate finds level counters**, so a
Student at level two proliferated is at level three and the band reads that without being told.

**The slot found a field-shaped bug of a kind this pool has now had twice.** `normaliseDef` is an
allow-list — a caller-supplied deck reaches it and a field it does not name is dropped — so the first
level-up card arrived in `cardDefs` with `levelBands: undefined` and sat at level seven as a 1/1,
with every engine test agreeing. Printed **loyalty** was eaten the same way once; its comment is
still in that function. The fix is the copy plus a validation block: bands are checked for shape,
capped at four and clamped to ±99, all payload limits rather than rules limits, because a
caller-supplied card claiming a power of a billion breaks every readout that prints it.

Student of Warfare went into Dawn Tithe and Beastbreaker of Bala Ged into Kindle Grove: **0, 0 and
+1** for the Student across three seed sets, **+4 and +4** for the Beastbreaker across two. Exactly
zero twice is not a measurement, it is a smell — 208-80 against 208-80 reads like a swap that never
happened — so two things were run before any of it was written down. A **third seed set**, which came
back +1 rather than zero; and a **control that must move the number**, two Swords to Plowshares
swapped for two Plains in the same deck on the same seeds, which moved it by **23**. The harness can
see changes in this deck; it simply had nothing to see in this one. The honest reading is that a
one-mana 1/1 eating spare white mana is level with a two-mana 2/2 that grows on lifegain, in a deck
that wins 72% of its games either way. **The bot does level**: 19 Students cast and 60 level-ups
across 48 games, counted off `auto:activate` by card name rather than inferred — which is what ruled
out the other explanation of a zero, that the card was never played at all.

`LIST=level` presses the row and then **reads the card face**, because `3/3` beside `Student of
Warfare` is the only evidence that what the table draws is the creature the engine is playing with.
The engine's own tests read the bands off `characteristicsOf`, which is the right place to pin the
arithmetic and the wrong place to find out what a player sees — a table drawing the printed 1/1 would
have somebody blocking a 3/3 with a 2/2 and losing a creature to a number that was on screen the
whole time. It also closes a loop from D213 for free: the battlefield badges a permanent `playable`
when it has a non-mana play, so a Student with white mana up *says* it has something to do. That
badge was added for the Contagion Clasp and the first card to benefit from it was this one.

### Vanishing and fading, the same clock read one turn apart (D217)

Echo and cumulative upkeep are costs the game demands. These two demand nothing: a vanishing or
fading permanent arrives with counters on it, spends one each of your upkeeps, and is sacrificed when
they run out. The only decision either keyword involves was made before the card was cast.

Vanishing N (CR 702.63) removes a time counter and sacrifices **when the last one is removed**.
Fading N (CR 702.32) removes a fade counter and sacrifices **if it cannot**. Read twice they look
like one rule; counted they are not — a Calciderm with vanishing 4 goes 4→3→2→1 and leaves on the
fourth upkeep, and a Blastoderm with fading 3 goes 3→2→1→0 and leaves on the fourth upkeep too. Both
hand their controller **three** turns of a 5/5 with shroud, and only one of them says three on the
card. That is the whole history of the pair: fading was printed first, players counted the printed
number as the turns they were getting, and the keyword came back under a name whose number means what
they thought.

The asymmetry lives in one line — the `condition` vanishing has and fading does not — and it is
visible in play for any permanent on the battlefield **with no counters**. Entering gives a leveler
its counters by any route, a token copy included, because "enters with four time counters" is one of
its own abilities. What does not is a permanent that reached the battlefield without entering: put
there by hand in tabletop mode, or one that *became* a copy of one of these. A clockless Calciderm
sits there indefinitely and a clockless Blastoderm is sacrificed next upkeep, which is what the two
cards say.

**It needed nothing new, for the third keyword running.** The upkeep step trigger already defaults to
the controller's own upkeep, `entersWith` already puts counters on an arriving permanent,
`TriggerDef.condition` is the intervening-if, and `moveToGraveyard` is the sacrifice. `FADE` is its
own counter rather than a second user of `TIME`, because the table draws the counter's **name** and a
Blastoderm reading `time 3` would be wrong on the card face even where it was right in the
arithmetic. And **proliferate finds both clocks** without being told — the third keyword it has
reached into on its own, after level counters, which is the argument for its candidate list reading
the counters a permanent *has* rather than a list the engine keeps.

Calciderm went into Forge Alliance for the second Serra Angel and Blastoderm into Kindle Grove for
the second Thragtusk: **−3 and +1** for the Calciderm across two seed sets, **+2 and 0** for the
Blastoderm, every reading inside the ±20 floor and each pair disagreeing in sign. The zero needs no
separate control, because the other three readings are one — the same harness on the same two swaps
moved the number three times, so it can see changes here and had nothing to see on that seeding. And
**the bot casts both more often than what they replaced** (31 Calciderms of 55 games holding one
against 8 Serra Angels of 25; 18 Blastoderms of 29 against 16 Thragtusks of 32), which rules out the
other reading of a zero: both new cards are a mana cheaper, and a four-drop gets cast in a game a
five-drop sits in hand for. The payers were chosen for the argument rather than the arithmetic: the Angel is the deck's other big white body, five mana for a 4/4 that flies and
stays against four for a 5/5 that cannot be answered and does not; and a removal spell spent on the
Thragtusk trades for half a card and five life, while one aimed at the Blastoderm cannot be cast at
all, because every removal spell in this pool targets.

**Seven tests passed on the first run, so one of them was made to fail.** An off-by-one that holds
first time is either right or untested and the green tick cannot tell you which, so `fadingTrigger`
was temporarily given vanishing's body and the suite re-run: the central test failed exactly as it
must, and the clockless test did not — under vanishing's body a counter removed from nothing is still
nothing, so that one discriminates the condition rather than the ordering. Knowing which test carries
the claim was worth the two minutes.

`LIST=vanish` reads the clock off the **card face**, because a 5/5 with shroud that disappears with no
warning is not the card either keyword prints — and every engine test reads these counters straight
out of state, where nobody playing can see them. The check is not that a label exists but that the
same clock was seen at more than one number: two clocks at one reading each is two creatures, and a
Calciderm beside a Blastoderm shows `time 4` and `fade 3` on the first move with nothing having
counted down at all. Across runs it has read `fade 3, 2, 1` and `time 3, 2, 1` off a real game.

### Split second, the pool's first rule about the stack (D218)

Every rule in this engine about what a player may do reads the board, the step or the seat. Split
second (CR 702.19) reads **the stack**: while a spell with the keyword is on it, nobody may cast a
spell or activate anything that is not a mana ability. It is the first thing here whose answer to
"may I?" depends on an object somebody else put on the stack a moment ago.

It lives in `legalActions`, in two places, because that is the one function that decides what a seat
may do: `splitSecondHeld` walks `stackOrder` for a **spell** whose script declares it, the cast loop
skips every card and the activation loop skips every ability whose `produces` is undefined. Nothing
else needed to know — the table draws an empty list, the bot passes, and `auto:cast` refuses, all off
the same gate. Two details are the rule rather than the code: **spells only**, because the keyword
says "while this *spell* is on the stack", so an ability on the stack stops nothing; and **mana
abilities are exempt**, read off the same flag `isManaAbility` is built from, so the gate and the
label can never disagree.

**The hand is told why.** A hand that goes grey with no explanation is the complaint `blocked` exists
to answer, so the gate records `a spell with split second is on the stack` — the only reason in that
list which is about something on the stack rather than about the card the player is holding. And it
needed no client work, which is a result rather than an omission: `reasonCannotPlay` reads `blocked`
off the view and hands it to the card sheet, so a new reason is **data** rather than a new path, on a
pass-through that already has its own test. That is also why there is no browser row — the claim is a
legality rule, pinned where legality lives, and the only thing the screen does with it is print a
sentence it is already tested to print.

Two tests had to be rewritten after passing for the wrong reason. The first versions asked
`legalActions` of the seat **not** holding priority and got an empty list both ways: that function
answers "what may you do now", so a seat nobody is asking is told nothing rather than told it is
blocked. The honest version reads the caster's own Lightning Bolt while the caster holds priority,
and the opponent's Cancel once priority has passed to them with the Shock still waiting — which is
the one window a Cancel was ever going to be used in.

And one test pins what the keyword is **not**. It is not uncounterable: a Chalice of the Void set to
two is already on the battlefield, its trigger goes on the stack above the spell, and the Shock is
countered by a permanent that could not care less about the keyword. In this pool the practical
consequence is sharper than the rule — every *cast* answer here is a counterspell, so against two
Counterspells, a Cancel, a Disallow and a Saw It Coming, split second is close to "this resolves" —
and that is still not what the rule says.

**And the slot probe said no, for the first time in this project.** Sudden Shock against Arc
Tempest's Lightning Strike is as clean as a slot probe gets — same cost, same colour, same card
type, same deck, a damage fewer — and it came back **−22 and −17 of 288**: one reading outside the
±20 floor, both the same sign, which says plainly that in this pool the window is worth less than
the third damage. A Bolt or a Magma Jet would say the same, so no burn slot here wins. The committed
slot is the **second Preordain's** instead, at **−1 and −1**, and both numbers are reported because a
slot's number is a fact about the payer. Finding that slot took two tries the pool refused: the Lava
Spike looked ideal (three damage, but to a player only) and turned out to be **escape fodder named by
deck in several tests** — the third pool-keeps-a-copy lesson, and the first where it was a *deck*
rather than the pool doing the keeping. Krosan Grip went into Blight Vector for the second Golgari
Charm, whose three modes include destroying an enchantment, at **+2 and +9**. The bot casts Sudden
Shock in 80% of the games it holds one, exactly the Lightning Strike's rate, so the −22 is two decks
playing the same number of burn spells and one of them dealing less damage.

Worth writing down what the bot does not know: split second makes an opponent's held counterspell
worthless and the bot holding it has no idea, because its "keep mana up for an answer" rule reads the
board and its own hand. Nothing here tries to teach it, and nothing should until there is an
instrument that would notice the difference.

### Ninjutsu, a creature that arrives already attacking (D219)

Every creature in this pool reaches the battlefield outside combat, or at least outside one that is
half-resolved. Ninjutsu (CR 702.49) is the first that arrives **in the middle of one**: an unblocked
attacker goes back to its owner's hand and the ninja takes its place, tapped and attacking the same
player, after the defender has already decided not to block. It is the only play here that happens
*after* blockers and still changes what damage lands.

Two things the engine had never done. **A cost paid with a permanent that is not destroyed** — the
creature goes to a *hand*, so you keep both cards, and a sacrifice cost's whole arithmetic does not
apply. It is its own cost field, its own candidate list on the play and its own field on the action,
because one field for both would make every reader guess which; the bot's branch is separate for the
same reason, since the sacrifice branch declines plays whose fodder has text on it and would refuse a
**free** swap. And **a creature put onto the battlefield already in combat** — `enterAttacking`
appends to `combat.attacks` directly, which is the rule rather than a shortcut: the creature was never
*declared* (CR 506.3c), so nothing that triggers on attacking triggers, and the engine gets that free
because `raise('attacks')` lives in the declaration path this never goes through.

The defender travels on the stack object, as `attacked` and `answering` do: by the time the ability
resolves, the attacker whose place the ninja is taking is in a hand and its attack is gone from the
board, so there is nothing left to read. And the timing is the candidate list rather than a step
check — but that took a correction. The first filter was `blockers.length === 0` alone, which is true
the instant an attacker is declared, so a ninja could have been swapped in before the defender had
any say. "Unblocked" means the player who could have blocked it did not, so the filter also requires
the defending seat to be in `blockersDeclaredBy`; the test that caught it is the one asserting the
ability is *not* offered yet.

**The UI needed one field and one sentence.** A cost paid by tapping your own permanent is the
`feeding` mode, built for sacrifice outlets; ninjutsu reuses it with the mode now saying *which* cost
it is, so the bar reads "tap an unblocked attacker to return to your hand" rather than "tap a creature
to sacrifice" — which over this swap would tell the player they are losing the creature they are in
fact getting back. One mode, two costs: D213's lesson in a third place.

**The slot is level and the keyword does not happen in a bot game**, and the second half is the part
worth reading. Ninja of the Deep Hours went into Skyward Writ for the second Omenspeaker at **+2 and
−1 of 288** — the right home, because that deck's plan is fliers nobody blocks. But across 48 games
there were **zero** ninjutsu activations. The bot is not refusing: asked directly on a board with a
Ninja in hand and a Hawk through, it returns the activation with the right attacker named. Counting
the windows says which part never happens — in 95 of its own declare-blockers steps it had an
unblocked attacker 19 times and a Ninja in hand 2 times, and the two never coincided, because it
casts the Ninja as a 2/2 the moment it can (13 casts in 48 games). So the keyword is implemented,
tested and **unmeasured in bot play**, which is written down rather than papered over: the rule it
needs is a holding rule, it belongs to the family of hand-taught facts D148 and D152 are about, and
it is its own piece.

**And that piece is done, in the same stretch.** `BotOptions.holdsNinjas` — on by default — drops a
cast of a card with ninjutsu while `aSwapIsComing`: one question about the board, do I control a
creature that could attack and that nothing untapped could block. It joins the family of filters that
drop a play which bought nothing (the ritual, the Fog, the protection trick, the animated land), and
it is that family turned the other way up: this drops a play that bought something **small**, because
the card is about to buy something bigger. The second half of the rule is the half that stops it
being a trap — with nothing able to attack, the bot casts the ninja rather than holding it for a
moment that never comes.

It creates the windows it was built for: same 48 games, same seeds, **0 ninjutsu activations becomes
3**, and the steps holding both a ninja and an attacker through go from 0 to 2. And it costs nothing —
`bot-duel` across every pairing, both seatings, three seed sets: **467-467 of 936**, identical to the
identical-bots control. That identical reading is D216's smell, so a **positive control** was run on
the same harness: `lookahead: false` came back **90-221 of 312**. The instrument is live; it has
nothing to see in a rule that changes three plays in 48 games of one deck. Level, and what it changes
is the play — which is `reserveForAnswers`'s summary word for word, and the reason it is kept on is
the same: a bot that holds a card with a keyword printed on it and never uses the keyword looks broken
to the person opposite. See D220.

### Modular, the pool's first 0/0, and a zero that means the opposite of the last one (D221)

Modular N (CR 702.43): the creature enters with N +1/+1 counters, and when it dies you may move its
counters to another artifact creature. Arcbound Worker and Arcbound Ravager, both into Forge
Alliance, which is the deck where "another artifact creature" is a sentence with somewhere to point.

**The first printed 0/0, which is the same fact as the keyword.** A modular creature is alive only
because of its own counters, and that needed no special case: `entersWith` puts a +1/+1 on it and the
layer system does the rest. Three consequences, all tests. A **−1/−1 counter kills it**, because the
two annihilate and a 0/0 is lethal to itself — a Contagion Clasp is removal for this card. A 0/0 **put
onto the battlefield without entering** never ran `entersWith`, so it is a literal 0/0 and the
state-based actions take it at once: the third keyword to find that fact after echo and vanishing, and
the sharpest, because here it is the difference between a card and no card. And that state-based
action runs **when a player would receive priority** (CR 704.3), which is why a test that adds the
counter with a bare effect call and then drains sees nothing happen — with an empty stack there is
nothing to drain, so the pass is part of the test.

**The counters move, and the number comes from the past.** This is the first ability here that moves
counters off a dying permanent rather than counting them, and the number cannot be read off the
creature: a card leaving the battlefield loses its counters on the way out. `subjectCounters` carries
what it had, and that field was built two keywords ago for the other shape of the same problem — it
needed nothing added. The printed `count` is deliberately not what moves: a Worker that picked up a
second counter passes two on. Two printed details are easy to get wrong and are both tests — **"you
may"**, so the spec is `optional: true`, which matters because the legal targets include the
*opponent's* artifact creatures and a forced version would make a dying Worker grow an enemy
Juggernaut; and the trigger is **not asked at all** with nothing to move, which is echo's principle
(a question whose every answer is identical is not a question).

**A cost that spends an artifact**, which the pool has never had: `AbilityCost.sacrifice` gained
`'artifact'`, the fourth member of that union and the first not about creatures. Twenty-odd artifacts
in this pool and until now nothing could pay with one.

**The slots took two payers and gave four readings of one sign.** The Worker is level for the second
Elite Vanguard (−1 and +3). The Ravager is a **downgrade**: −7 and −13 against the second Loxodon
Warhammer, which is the Capsize lesson again (that card is the deck's best and does two things at
once — cast 24 times and *equipped 57* in 41 games), and still **−9 and −7** re-priced against the
second Raise the Alarm, two mana of board against two mana of board. Inside the ±20 floor every time,
so not a result by this project's standard, but four same-sign readings is the most a probe can say.

**And the reason is a zero that means the opposite of the last one.** The Ravager is cast in
essentially every game it is drawn, so it is not a stranded card — but its ability was activated
**zero** times, and the instrument says why:

| across 48 games | |
| --- | --- |
| times the "Sacrifice an artifact" row was **offered** | **437** |
| times the bot took it | **0** |

Ninjutsu's zero was a **zone** problem: the situation never arose. This zero is a **judgement**
problem: it arises constantly and the bot declines every time, because its sacrifice branch refuses
to feed anything with its own text — a rule that exists so it will not eat a Blood Artist, and that
refuses every artifact in Forge Alliance because they all have text. A spent Bonesplitter, an
uncrewed Vehicle and a tapped Mind Stone are all declined, so the Ravager stays a 1/1 all game, and a
1/1 for two that never grows is worse than two 1/1s for two. That is what the −9 and −7 measure. Same
instrument as ninjutsu, opposite diagnosis, and the README lesson written one piece earlier is what
told them apart. The rule it needs is its own piece (D221 says which rule); the alternative was to
drop the Ravager quietly and lose the only card that can pay an artifact cost, hiding an engine gap
behind a tidy number.

### Feeding the artifact cost, and the stall the scenario found (D222)

The rule that answers D221's zero. `LegalPlay.sacrificeKind` says when a cost eats an **artifact**
rather than a creature — a field rather than an inference, because an artifact cost on a board whose
only artifact is a Juggernaut offers one artifact *creature*, which is indistinguishable from a
creature cost. Two readers need it and would otherwise each invent it: the bar, which has to ask in
the right words, and the bot, whose judgement about what it minds losing is a different judgement for
a Bonesplitter than for a Centaur Courser.

`spentArtifact` is the judgement, and it asks **"is this artifact doing anything right now"** rather
than the creature branch's "is this a card or a body". Three clauses, each a fact about the board:
not currently a creature (read off characteristics, so a crewed Sky Skiff is a body and the same card
idle is not), not attached (an equipped Darksteel Plate is why its holder is alive), and not a mana
source (unexercised by this pool and in anyway, with a deck the test builds for itself). Cheapest by
mana value among the rest, which is the weak part and is said so.

**0 → 4 activations** across the same 48 games, and then the default went back off, because the four
were the wrong four. Of them, **four of four** were eaten with a creature standing by that could have
carried them and **two were Loxodon Warhammers**, the deck's best card; paired on the same seeds with
the flag the only difference, the deck was **7 games of 288 worse** with feeding on at one seed set
and 6 at the other. That is the weakness the rule's own docblock had already named — an unattached
Warhammer with a carrier is live — found by the instrument rather than hoped away.

It is a default rather than a patch because there is no clause to add. "Unattached and nothing could
carry it" collapses to never (the Ravager is itself a creature that can hold Equipment), and a
syntactic test for inert — no activated ability, no static — passes an Obelisk of Urd, whose anthem
lives in an enters-the-battlefield choice. Audited card by card, **every** non-creature artifact in
this pool is Equipment, a Vehicle, a mana source, a standing answer or an anthem. There is nothing
spent here to find, which makes it a deck question; the rule stays written and switched on by its own
flag, waiting on an Ichor Wellspring shape (#206).

Four, of 434 windows — and the first explanation of *why* was wrong, which is the more useful half.
The candidate tally that produced it was read off the arm with feeding **on**, where the bot had
already eaten the idle artifacts before anything counted them. Read on the shipping bot:

| across 48 games | feeding on | feeding off |
| --- | --- | --- |
| windows the row was offered in | 434 | **437** |
| of those, nothing but the Ravager on offer | 383 | **220** |
| other artifacts on offer, already **attached** | 89 | **191** |
| other artifacts on offer, **idle** | 1 | **104** |

"There was nothing to eat" was the instrument reading its own effect. Idle Equipment is on offer in
about half those windows; the four eats are the *search* rarely preferring the activation. What stands
is narrower: in **220 of 437** windows the only artifact on offer is the Ravager itself, which the
engine offers because the card says "an artifact" and not "another", so the self-refusal is still the
single commonest thing the rule does.

**And the browser row found a stall it was not built for.** `LIST=artifact` exists for one sentence
(the bar now carries three costs through one mode, and the words are all that distinguish them). Its
first run caught that — and then stopped dead on turn three for two thousand moves, a prompt open with
nothing on screen able to answer it. A dying Arcbound Worker's modular trigger asks for "up to one
target artifact creature", zero is a legal answer, and the choosing prompt **had no control on it at
all**: the reducer's own comment said "a trigger's targets are never optional", which was true until
modular shipped one commit earlier. The engine's tests answer with `auto:choose, targets: []`
directly, a path the table never offered, and no starter deck puts enough Arcbound creatures on one
board to reach it. `specsWanted`/`specsRequired` are now lifted out so the two readings of "how many
targets" cannot drift again, a tap sends at the most the specs can take, and the button — **Choose
nothing** — sends at the fewest. Second defect running that a browser row found in code three suites
had passed, and the same shape both times: a claim about what the *player* can see, which no layer
below the browser can make.

### The card the pool was missing, and "is it idle" replaced with "is it a loss" (D223)

D222's rule asked whether an artifact was **doing anything right now**, and ate two Loxodon
Warhammers in 48 games for it. The question was wrong, not the implementation: an Equipment doing
nothing this instant is a card you equip next turn. The right question is whether sacrificing it is a
**loss at all**, and `paysForLeaving` is that clause — a trigger of its own on reaching a graveyard.
It subsumes the mana-source clause it replaced (a Sol Ring has nothing to say about graveyards), and
the "no activated ability, no static" test that looked equivalent was audited against the pool and
**rejected**: it passes an Obelisk of Urd, whose +2/+2 lives in an enters-the-battlefield choice.

Which took a card, because the pool had none. **Ichor Wellspring**, {2}, "enters the battlefield or is
put into a graveyard from the battlefield — draw a card": the sixth kind of artifact here, after
Equipment, Vehicles, mana sources, standing answers and anthems, and the only one whose whole text is
about **going**. Two triggers rather than one, because that templating *means* two and the rules read
them separately (CR 603.2); `who: 'self'` named on both, load-bearing on the graveyard event where the
default is `another`.

| across 48 games, feeding on | D222's rule | this one |
| --- | --- | --- |
| artifacts eaten | 4 | **1** |
| eaten with a carrier standing by | 4 | 1 |
| Loxodon Warhammers eaten | 2 | **0** |

The slot is the **second Leonin Skyhunter**, and paying from a two-of is the point: `arena()` places a
card by finding it in that seat's library, so cutting a one-of breaks every test naming it — which
cost one wasted swap before the grep. `cast-counts` named the deck's actually-dead slot (Disrupt
Decorum, 0 casts in 144 games) and it **stays**, because goad is a mechanic only a pod can use and a
duel measurement is not a reason to delete the pod's card.

Priced with `BOT=` on both arms: taking the Wellspring out costs **1 to 6** games of 288 across four
arms, same sign every time, so the card is level to slightly good against a Skyhunter the bot casts
96% of the time it holds one. And feeding on against feeding off reads **+1 and +3**, against D222's
**−7 and −6** before the narrowing — so `feedsArtifacts` goes back **on**, its third default set by
its third measurement. The +1 and +3 is inside the ±20 floor and is deliberately *not* the argument:
that is D220's, the one that keeps `holdsNinjas` on, and the probe's job was only to rule out the
harm so the judgement could decide.

### The bot was reading its own shuffle (D224)

A fairness bug, found by accident. The search plays a candidate out with `applyAction` on the **real
state**, so anything the engine reveals inside that line it learns — and with a Mirko Vosk, Mind
Drinker attacking, a simulated mill ("reveal until four lands are revealed") made the bot's blocks
depend on the order of its own library. A person in that seat knows their decklist and not the
shuffle; the bot knew both.

`asTheySee` flattens every hidden zone into **one canonical order** before the search looks at it,
once per decision rather than once per candidate. Sorted, which is what makes it canonical — two
permutations of the same cards sort identically, so the order carries no information — then shuffled
from a **constant** seed, which stops the canonical order being a lie: alphabetically every Mountain
clumps, and "reveal until four lands" off that predicts a mill wrong by the length of the deck.
Contents survive and only order dies, which is the real line and the same one the audit draws by
permuting *within* a pool. Inside the search only, on `noAutoPass`'s argument: the simulated state is
scored and thrown away, so this changes what the bot sees and never how the game runs.

| across 156 pairings, 16,804 decisions asked three ways | |
| --- | --- |
| decisions that changed, bot reading the shuffle | **9** |
| decisions that changed, bot blind to it | **0** |

**How it was found is the part worth keeping.** Not by the audit. #164 built exactly the right
instrument — `hidden-info.mjs`, all 156 pairings — and nobody had run it; what stood in for it was a
unit test over **three fixed pairings** that passed because those three games never reached the
position. One card added to Forge Alliance for an unrelated piece changed which games they play, and
the luck ran out. Then the obvious fix for the *check* was tried and thrown away: widening those
three so every deck appears **still passed against the leaking bot**, because the leak is about one
decision in 1,900 and seven games are about 800. Breadth is not a check; naming the position is
(`hollow-tide` v `kindle-grove`, seed 4242, now a regression case), with the sweep kept for the
release loop.

`BotOptions.blindToShuffle` exists so that table has two rows, and the audit is now **two** tests —
the sweep with blinding on, and the named position with it off asserting the bot *does* change its
mind. A test that asserts "no difference" is worth exactly as much as the proof a difference was
reachable.

**And the cheat was worth nothing.** `bot-duel`, three seed sets, the cheating bot against the fair
one: 467-467, 468-468 and 472-462 of 936, with the positive control (`lookahead: false`) at 91-220 of
312 — the same 91-220 the build *before* the blinding gave, so the search lost no measurable strength
by losing the shuffle. Correctness with no price to argue about, and the flat reading needs no
apology: `hidden-info` already showed the flag moving 9 decisions of 16,804, and nine in seventeen
thousand cannot move a win rate over 936 games.

### Exile, the last zone change nothing could read (D225)

`to-exile` finishes the family `died` started. Seven callers put a card into exile — a blink, an
exile-until-this-leaves, a foretell, a suspend, an escape cost, a replacement that exiles instead of
burying, and a spell exiled rather than buried — and not one of them raised anything, which is why
the pool's whole blink package had no payoff.

It is the only event here whose list carries more than an id, and each of the three fields is a fact
the move destroys: an exile zone belongs to the card's **owner**, so the controller is gone; a card
in exile has lost its counters, so asking what it was answers about a different object; and a
creature card exiled out of a graveyard is afterwards indistinguishable from a creature that was on
the battlefield. One field per word of "a **creature** **you control** is **exiled**".

The interaction that paid for that design was a failing test first. **Rest in Peace** is in Skyward
Writ's sixty, so while it is out every creature you lose is exiled instead of buried — a creature of
yours being exiled, by the printed rulings. The engine said otherwise, because a replacement runs
*after* the physical move and corrected it from the graveyard the card had already reached: two hops
where the rules have one (CR 614.1). `exileCameFrom` fixes it, using the one list that is non-empty
only during the replacement pass.

**Soulherder** is the card, {1}{U} for a 1/1 that grows on every exile of yours and exiles one
itself each end step — two abilities that feed each other, so it needs no other card to be worth a
slot. It came in for the Disenchant that `cast-counts` named as this deck's worst conversion (35
casts in the 64 games it was in hand). And the card found a general bug on the way: an optional
target spec with no legal candidates was still being asked about, so a lone Soulherder would have
put an empty prompt in front of a player at the end of every turn.

`blink-use.mjs` is the instrument, over 48 games: 18 cast, 34 end steps asked about, 0 declined,
best counters 2.5 average and 8 highest — and 4 blinks of 34 that cost something real (a token
destroyed, three creatures stripped of counters). The card works; the bot's *choice* of what to
blink is the next piece, and it is a new kind of judgement problem, because this is the pool's first
optional target where a bad answer destroys one of your own creatures rather than wasting a card.

### What a blink costs (D226)

The number D225 left on the table: of 34 blinks across 48 games the bot destroyed one of its own
tokens and stripped three of its own creatures of counters. A blink is the pool's first target where
a bad answer costs a creature rather than a card, because the permanent comes back as a *new object*
— a token ceases to exist, and counters, Auras and damage do not travel (CR 111.7, CR 400.7).

`TargetSpec.blinks` is the card declaring that, the way `friendly` declares which side to aim at,
and `blinkLoss` is the four terms the instrument counted: the token, the counters (a +1/+1 is a loss
and a −1/−1 is a creature healed), the Aura (whose it is decides the sign — your Pacifism on their
creature is *freed* by the blink), and the Equipment that merely falls off. One function for both
readings, with the sign flipped for an opponent's permanent, which is what makes Flickerwisp aim at
their token and Soulherder refuse its own.

The token needed a refusal rather than a weight, and the instrument proved it: a ranking only picks
the best candidate, and a board whose only other creature is a token leaves the worst play as the
best one. Afterwards: 31 blinks, **no** tokens destroyed, **no** counters stripped, and the arrival
triggers blinked nearly twice as often.

`bot-duel` reads +4 and +2 of 288 on Skyward Writ's pairings and −2 and +2 of 624 across the whole
field — four readings that do not agree on the sign and are all inside the floor, which is what a
rule that changes four choices in forty-eight games looks like. Not the argument, then: the instrument is, the
same way it was for D220's ninja and D223's artifact. Two measurement notes came out of it. `SUBJECT` is new on that harness and buys **time rather than signal**: an untouched
pairing is the same game twice and contributes nothing to the difference either way, so the field
was never diluted. And it drops the decks it does not name, which matters here because this rule
fires off Cloudshift in Verdant Guard as well as Soulherder in Skyward Writ.

### The pod's other half: who has been leaving you alone (D227)

D189 answered *who has been coming at me* and left the mirror open, with the reason written beside
it: a player who attacked somebody else instead of you looks identical to a player who could not
attack you at all. The difference is a legality check, and the engine is the only thing at the table
that ran one — so `Seat.spared` records, per declaring seat, the attacking **power that could
legally have come at you and went elsewhere**.

Goad, a "can't attack you", a tapped or summoning-sick creature: none of them leaves anything
behind, which is exactly the distinction. Read from the state *before* `tapAttackers` runs, because
a tapped attacker has no legal defenders and the tally computed afterwards is empty every time. And
in power rather than attacks, so the pair reads in one unit: "hit you 12, spared you 5" against
"hit you 0, spared you 20".

Twelve bot pods: 12 of 12 ended with a tally, biggest single number 174, and the per-seat totals
land in the same tens as the damage ones — which is what makes the two badges weighable against each
other. Information and never enforcement, like the deals: no rule reads it and the bot does not
either.

### Affinity, a cost the board decides (D228)

D132's cost modification only ran one way: a permanent on the battlefield changing what *other*
spells cost. Affinity is the mirror — a reduction printed on the card being cast, reading its own
caster's board (CR 702.41a) — and it needed one declaration (`CardScript.affinity`) and five lines
inside `costChangeFor`, because that function already answered "what does this cost here, for this
seat" and is called from every place a cast cost is computed. The offer and the payment therefore
cannot disagree, and affinity works under an alternative cost for free.

Three things are the keyword rather than the code: it is counted **as the cost is computed**, so the
row goes back up when the artifacts are answered; it moves **generic** mana only; and the floor is
reported honestly — eight artifacts against a printed {7} take seven off, because that is what the
board actually did.

One Frogmite, in Forge Alliance, whose sixteen artifacts are the only board in the pool that can
pay it — and the slot took four probe arms to settle, because the first answer was wrong and the
measurement is what said so. Affinity shipped with both of its famous bodies, Frogmite and the {7}
Myr Enforcer, paid for with a Swiftspear and a **Plains**, on the argument that an affinity deck
needs fewer lands. The paired probe priced that at −23 games of 288 on one seed set; restoring the
land recovered nineteen of them, and swapping the Enforcer out recovered four. So the argument was
the error, and specifically: an archetype's land count does not transfer to a deck that merely
contains the keyword. What shipped is one card for one Swiftspear with the land count untouched, and
Myr Enforcer is out of the pool. See D228 for all four arms.

### Myriad, and the pod's first card of its own (D229)

Every keyword in this engine is worth something in a duel, and a pod has had no card of its own: the
monarch is a rule, goad works with one opponent, the deals and the two politics tallies are
information rather than text. Myriad is the first card whose printed text does **nothing at all** at
two seats — "for each opponent other than defending player" — and three things at four (CR 702.111a).

It is the seventeenth entry in `KEYWORDS` and the only **instruction** among sixteen facts, because
**Blade of Selves grants it** and granting is all `PumpOptions.keywords` can do. So the keyword is a
declaration and `declareAttackers` is the implementation, and the card is four lines like the
Basilisk Collar handing out deathtouch. The composition is three primitives that existed separately
and had never met: a token copy of a nontoken's printed card (embalm), a permanent that arrives in a
combat already in progress (ninjutsu), and a marker the end-of-combat step reads (dash's shape).
`addTokens` is the one new thing — `createToken` returns a state, and myriad is the only caller that
needs the **ids** of what it made.

Where it runs is the rules rather than tidiness: after the attacks, the broken pacts, the sparing
tally and the tapping, because a myriad token was never **declared** (CR 508.4) — so it breaks no
promise, moves no tally, counts towards no battalion and raises no `attacks` event. That last one is
load-bearing: a token that triggered the keyword would make tokens of its own, forever.

What is missing is the printed "**you may**", and there is nowhere to ask — this engine's questions
are asked while a stack object resolves and this happens inside a declaration. In a duel that is
right; in a pod it is a real deviation, and the measurement went straight at it. `pod-slot.mjs` is the new harness it needed —
`deck-probe` makes every game a duel and therefore cannot see this card at all — and it says the
Blade costs Forge Alliance **11 of 52 pods on one seed set and 4 on another**, with the *unchanged*
variant arm itself reading 15 and 6 across those seed sets. A spread of nine on a deck that did not
change is the floor, so the direction is consistent and the size is unmeasured. **D229 does not claim
the card is good**: it ships because a keyword needs a card in a deck to exist in the pool at all,
and the likely repair is making the printed "may" real, because a cost past the one-ply horizon is
something this project teaches by hand.

### The bot asks for peace (D232)

`answerPact` has only ever answered, for a reason its own docblock gives: a deal buys somebody's
future behaviour and nothing in the bot models that. The exception is the one offer whose value is in
the **present** — asking for peace from the player whose open board can already kill you — and that
is the same board fact `answerPact` reads from the other side to decline a deal from somebody who is
dead on the board. One reading, two directions, and it makes the pod's conversation two-way for the
first time.

It offers a **truce**, which binds both ways, so the bot pays for what it asks rather than begging.
Three conditions bound the noise: the seat must be able to kill it, no live pact may cover it
already, and one offer may be outstanding at a time — a seat that has said no this turn is not asked
again, answered from the record rather than a counter.

The measurement is the interesting part. **`pod-duel` cannot price this**: bot to bot the two mirrored
rules always disagree, so 26 offers across thirteen pods produced 25 refusals and 12 of 13 pods ended
identically. Near-inert between bots is what makes it safe to turn on; the value is the table a
person sits at, and that is stated as itself rather than dressed up as a win.

### The Postgres flake, closed, and it was never about Postgres (D233)

The one CI failure this branch has carried unexplained since 25 October — `legacy-postgres`, 25 of 26
passing, green on a rerun of a superset of the same code. Three sessions ruled out suspects in the
Postgres container's log. The answer was in the test file.

`newPlayer` built its username from six random base-36 characters, and `server.js` runs every
registration past a filter that lowercases the name, strips the punctuation and asks whether one of
eleven words is a **substring** of what is left. Sooner or later six random characters spell one.
Measured over 20,000,000 draws of the exact generator against the exact filter: once in 113,000
registrations, so **once in 3,552 runs of this suite**. We drew it once in ~380.

Two things are worth carrying forward more than the fix is.

**The job's name was the misdirection.** `legacy-postgres` prints the service container's whole log
after the step, which is ~300 alarming lines, and the diff was in the rules engine, so the search
kept looking for a database fault. The failing line was in neither the container log nor the diff,
and it would flake identically against SQLite.

**A log tail that contains no test output has told you nothing.** The earlier session concluded that
switching to the spec reporter would make "a tail enough next time". It would not: the container
teardown is appended *after* the test output, so a 150-line tail of this job is all Postgres and no
tests, whatever the reporter does. The whole log comes back in one call — `get_job_logs` with
`return_content: true` and no `tail_lines` — and run 235's named the test, the assertion and the
server's refusal on the first read.

The fix is arithmetic rather than a smaller probability, because #111's standing instruction was *do
not add a retry* and re-rolling the name would have been one in spirit. The suffix is a counter now,
over `j m q v w x z` — the seven letters that appear in no word on the filter's list — so a refused
name is impossible rather than rare. Letters and not digits on purpose: `packages/shared`'s filter,
which legacy is expected to adopt, folds `1` to `i` and `5` to `s` and wildcards the rest, so digits
read as words there *more* readily.

And a guard with its own positive control, because `SAFE_LETTERS` is only safe relative to a word
list that lives elsewhere and can grow: a plain test reads `badWords` out of `server.js` rather than
copying it, reimplements the server's check, and runs it over every tag this file uses against 400
suffixes each. Verified by breaking it — `SAFE_LETTERS = 'crapjmq'` fails with
`wp_g_rcrap would be refused for "crap"`. The suite reads 28 of 28.

### Transform, which turned out to be one field moved at a third moment (D234)

The pool had two of the three double-faced shapes. A modal DFC points the instance's `defKey` at its
back face as it is **played**; a morph points `defKey` at the real card when it is **turned up**.
Transform is the same pointer moved while the permanent sits on the battlefield, so
`transformPermanent` is eleven lines — and that is the finding, not a disappointment. `defKey` is
what characteristics, the script registry, combat, the bot and the table all look a face up through,
so a 1/1 Human Wizard that turns over **is** a 3/2 flying Insect to every one of them without any of
them being told that cards have backs. `printedDefKey` and `relocate` already gave CR 712.4a for
free: a transformed Delver in a graveyard is a Delver.

`transformed` is the ninth member of the detect-rather-than-announce family and the simplest — a
list of ids, because **which face it became needs no recording.** The flip moves `defKey` before
`settle` raises the event, so the script receiving it is already the face the permanent now is:
"when this creature transforms into Awoken Horror" is a trigger *written on Awoken Horror*, and the
printed wording is the name of the script it lives on.

Two cards. **Thing in the Ice // Awoken Horror** needed nothing new — `entersWith` for the four ice
counters, one trigger for "remove one, then transform if none remain" because the card prints it as
one sentence, and defender simply gone once the 0/4 is a 7/8 because defender was on the front
face's script. **Delver of Secrets** needed one hook, and the reason is hidden information rather
than transform: "look at the top card of your library, you may reveal it" needs the player to see a
card, and a prompt naming it would leak — `awaiting` carries one prompt to every seat. So it asks a
`library-top` cards question, the channel scry already uses, which goes to the asked seat alone. The
question is put *every* upkeep over anything, because a question asked only when it mattered would
leak through its own existence.

That left the bot answering backwards — `library-top`'s one standing answer is scry's "choose a
land so it goes to the bottom", and here choosing *reveals*. `CardsDecisionSpec.pick` is the card
twin of `ChoiceDecisionSpec.best`, and the card now answers its own question.

Insectile Aberration has **no script at all**: its whole text is "Flying", which `printedKeywords`
grants. The deck-coverage test had to learn that was allowed, and its exemption is now the real rule
— a card needs no script when its whole printed text is keywords the engine already grants — which
is better than a transform-shaped exemption would have been.

And the slot is priced rather than asserted, on **two disjoint seed sets**. `deck-probe` with the
change reversed, all twelve opponents, 408 paired games each: the transform pair reads **196-212
(48.0%)** and **201-207 (49.3%)**; the second Bolt and second Counterspell it replaced read
**168-240 (41.2%)** and **148-260 (36.3%)**. The stock arm's own spread across the two seed sets is
five games, which is the floor measured rather than assumed, and both effects (−28, −53) clear it.
Across twenty-four matchup readings the old list is worse in twenty-one, level in two, better in
one. **The direction is settled; the size is not pinned tighter than seven to thirteen points**,
because the two measurements of one change differ by more than the floor.

Two things worth carrying forward that have nothing to do with transform. **A starter deck's
one-ofs are load-bearing for the test suite**: cutting Burst Lightning and Lava Spike to make room
broke twenty-six existing tests, every candidate cut was referenced somewhere (Firebolt least at
three mentions, Twincast most at forty), and the payment came from two doubles instead. And moving
the deck at all turned a playout test red with `auto:foretell` where it expected `auto:pass` —
**not noise**: `spendsAnAnswersMana` only looks at `auto:cast` and `auto:activate`, so a foretell
spends the very mana the rule exists to protect. That is #218.

### And then the transform cards were measured, and the slot's gain is not the mechanic (D236)

`transform-use.mjs` asks what D234's probe could not: does the second face ever get reached? 936
games, six seed sets —

```
card                 cast  flipped  of casts  turn  board  first
Delver of Secrets      85       38      45%   10.3    3.2   t4
Thing in the Ice       49        2       4%   18.5    1.0   t14
```

Delver flips **fewer than half** the times it is cast, around its controller's fifth turn. Thing in
the Ice flipped **twice in forty-nine**, and both times the board held one creature — so Awoken
Horror's "return all non-Horror creatures", the whole reason its back face is a 7/8, has never
mattered.

So Arc Tempest's seven to thirteen points came from **a 1/1 that sometimes grows wings and a 0/4
that blocks**, which is a good two-drop in a deck whose problem is living long enough to cast its
spells, and is not the card the slot was chosen for. D234's measurement stands; crediting it to
transform would have been wrong, and nobody had yet.

**The thing worth keeping is about the first run, not the cards.** One seed set read Delver at
12 of 16 — **75%**. The full field reads 38 of 85 — **45%**. Same instrument, thirty points apart.
The harness commit said at the time that 16 casts was too small to carry a conclusion and the
write-up would wait; had it not waited, the cheat sheet would now be telling players a card flips
three times in four. The rule is not "take bigger samples" — it is that a denominator under about
twenty earns a direction and not a rate, and there is now an example of how far wrong the rate goes.

The cards stay: transform needs a card in the pool to exist at all (D229), and Thing in the Ice
carries the only `transformed` trigger. What it *needs* is #220's question — the ice counters left
when it stops being able to flip, which tells "never gets there" apart from "dies first" and is the
difference between a reshape and a cut.

### And the answer for Thing in the Ice is "change nothing" (D237)

`countdowns.mjs` reads how many counters were left when a clock stopped being spendable. 936 games:
**21 clocks on Thing in the Ice, 2 ran out, and it never once reached one counter left.** Fourteen of
the twenty-one still had all four, meaning its controller cast not one instant or sorcery while it
was alive; nine were still on the battlefield when the game ended, eight of those with four.

So neither diagnosis #220 proposed was right, and the third is sharper: the card is not answered
before it converts and it is not one spell short — **it arrives too late to start**. Which means a
reshape has nothing to work with. One fewer counter converts the four cases that reached two and
none of the fourteen that reached four.

**Three measurements on this slot and the conclusion is that the deck is right and the card is
misnamed.** D234 priced the swap and it won; D236 found the win was the bodies; D237 finds the clock
unreachable. The card stays because transform needs a card in the pool (D229) and this one carries
the only `transformed` trigger. Recording a no-change is the point — inventing an edit to justify
three measurements is the quieter failure mode than being wrong.

Incidentally: **suspend resolves 29 clocks out of 29** (Rift Bolt in 1.5 turns, Search for Tomorrow
in 3). And the two rows the harness cannot split — vanishing and fading, where expiry destroys the
object and so looks identical to being answered — are what #221 is for.

## A clock running out is a fact in the log now (#221, D238)

The engine wipes an object's counters when it changes zone, and three of the pool's four clocks
destroy or move their object the moment they expire. So "the clock ran out" and "something answered
it holding its last counter" were **the same observation**, and the harness above had to print `?`
for two of its rows.

`GameState.expired` is the tenth member of the detect-rather-than-announce family and the only one
**not raised as an event**. Nothing printed watches a clock expire — vanishing and fading have no
payoff cards, suspend's cast is a rule the engine runs itself — so a trigger kind for it would fire
for nobody, which is what this engine declines to add — and the true version of that claim is
stronger than the one first written here. This section said `becomes-tapped` was the card-less
precedent; `mechanic-coverage.mjs` then found **City of Brass** sitting on it (#223, D239). The
engine has in fact **never** shipped a trigger kind with no card behind it, so `expired` as a
trigger would have been the first rather than the second.
And a list drained into `raise` would have been invisible to the one consumer that wanted it, which
is the trap `transformed` sprang. So it is recorded at the four expiry sites and drained into the
**persistent log**: `LogEntry.data.expired`, plus a line a player can read — *"Calciderm's last time
counter is gone"*, which is the difference between a creature that went to its own clock and one
that was answered.

```
card                     clock  started  ran out    left  ended  turns held
Calciderm                time        32     4  13%      11     17    4.5
Search for Tomorrow      time        23    23 100%       0      0    3.0
Thing in the Ice         ice         21     2  10%      10      9    2.9
Blastoderm               fade        18     4  22%       2     12    5.8
Rift Bolt                time         6     6 100%       0      0    1.5
```

**Three of the five rows are identical to D237's, and the two that moved are exactly the two that
printed `?`** — which is the measurement checking itself. The old zone comparison was wholly wrong
for vanishing (0 recorded, 4 real, all four hidden in the "left with 1 counter" bucket) and
accidentally nearly right for fading (5 recorded, 4 real). An inference right on three rows and
nearly right on a fourth is the worst kind to ship: no amount of staring finds it.

And the cards: **the printed price is collected 8 times in 50.** One Calciderm or Blastoderm in six
pays its drawback; the rest of the time the game ends around it (29 of 50 still on the battlefield)
or something answers it first. Blastoderm's clock lasts 5.8 table turns, about 2.9 of its
controller's, which is the three turns the player cheat sheet promises — so that claim is measured
now. Whether a 5/5 for four with a drawback that fires one time in six is priced right is a real
`deck-probe` question and is **filed, not answered**: D237's lesson was that inventing an edit to
justify a measurement is the quieter failure than being wrong.

The harness needed one fix the engine change exposed. Its first full-field run read **Blastoderm
0%**, impossible for a creature sacrificed if it survives four upkeeps: `countdowns.mjs` closed a
clock as soon as the counters were gone, and fading's expiry is the upkeep *after* that. Third
finding in a row from a rate that **could not be true** rather than one that looked wrong.

## Nineteen mechanics rest on one card, and none on none (#223, D239)

The suite asserts every card has a script and every script has a card. Neither direction asks how
many cards hold a **mechanic** up — and #220 found what that costs by accident: two singletons cut
from `arc-tempest` broke 26 tests, because each was the only card in the pool exercising its
mechanic.

`mechanic-coverage.mjs` counts 78 mechanics (41 `CardScript` fields, 19 trigger kinds, 18 keywords),
read out of the TypeScript rather than from a list beside it, so one added tomorrow shows up without
anybody remembering.

**Zero are declared with no card at all**, which is the better finding: D229's rule — a keyword needs
a card in a deck to exist — has been kept without exception. It is a test now as well as a
convention, with a standing control, because a negative result nobody re-runs stops being true
quietly.

**Seventeen rest on exactly one card, and none of them is a gap.** Every one is a `script` field or
a `trigger` kind — a keyword mechanic whose single card *is* the pool's whole use of it. Ninjutsu
has one card because the pool has one ninja. **No keyword is thin at all**: myriad is at one by
design (D228) and every other one of the eighteen has two or more cards putting it on the board.

That number arrived third. The instrument's first two runs **undercounted** the keyword rows, and
both errors were published before being caught. A keyword is readable from properties — printed in
the text, `script.keywords` — and it is also handed out three ways that properties do not show: an
`equipBonus`, a `statics` entry's effect, and a `pump(..., { keywords: [...] })` inside a closure.
Run one said hexproof rested on one card; it is on five. Run two read closure source and still
missed Knight Exemplar, whose grant is a plain object. The scan now walks the whole script tree, and
the two columns are the line that means something — **the keywords a card has, and the ones it gives
away**. Indestructible, the row that looked thinnest, has three cards giving it away by three
different routes.

**Both errors pointed the same way: they made the pool look worse than it is**, which is the
direction that gets acted on, and both were found by trying to act rather than by re-reading. So the
file over-counts on purpose now, calls its second column a reader's signal, and says in its own
docblock which bound it is.

And the run falsified a sentence rather than a number: the docs said in five places that
`becomes-tapped` is the engine's card-less trigger, and the #221 write-up above used it as the
precedent for not making `expired` one. **City of Brass has carried that trigger since #69.** The
true version is stronger — no trigger kind here has ever had no card — so that decision is better
supported than the argument given for it. Fourth finding in two days from a reading that could not
be true, and the first about a claim rather than a count.

## The evaluation is honest but blunt, and one term points the wrong way (#225, D240, D241)

`Next` has said for months that *"what is missing is not depth, it is an evaluation worth searching
with"*. Nobody had asked the testable version: `evaluate` is a sum of life, hand, library, lands and
creature power-plus-toughness, which is a theory about Magic, and a theory that says who is ahead
can be read against who won.

936 games, one position per round, recorded from both seats' views so the base rate is exactly 50%:

```
win rate by margin, turns 5-12        sign accuracy by turn band
       < -20      7%                  turn   total  life  board  lands  hand  library
   -10 .. -3     33%                  5-8      61%   58%    60%    51%   46%     50%
     -3 .. 3     50%                  9-12     70%   66%    67%    53%   42%     50%
     3 .. 10     66%                  13-16    73%   69%    70%    53%   44%     48%
       >= 20     93%                  25+      78%   74%    72%    55%   55%     59%
```

**It is well calibrated.** Monotonic, symmetric, crossing 50% at exactly a margin of zero. No
systematic bias — which is the property that matters for a search, since a biased evaluation makes a
deeper search prefer worse lines with more confidence. And **the sum beats every one of its parts in
every band**, which is a direct defence of the shape four deleted terms left behind.

**What it is not is sharp early.** 61% at turns 5-8 is the number that bounds what depth can buy,
because that is the band where a search can still change an outcome. An evaluation that is honest
but blunt cannot be fixed by looking further ahead — every leaf is scored by the same blunt
function. That is a sharper statement of the open problem than the one `Next` was making: the
trouble is discrimination, not bias.

**And cards in hand point the wrong way** — 46%, 42%, 44% across turns 5-16, worse than a coin in
the bands that matter, on the second-largest weight in the function. Not a licence to flip the sign:
hand size is a *symptom* of being behind (you could not cast what you drew), not a cause. But a
function scoring a position partly by hand size is scoring part of "I am behind" as "I am ahead",
and that is testable. It also explains D68 and D69 rather than contradicting them: both raised the
price of a card in hand and both made the bot worse, which is what raising an already-inverted term
should do. #227 lowers it and measures.

Three harness bugs before any of it was readable, each caught by a number that could not be true —
two turn-parity bugs in the sampling, and the seeding finding that became D240.

## A seed per game, and the first re-measurement halves two published rates (#226, D242)

D240 found that one `seed` was one RNG stream shuffling every deck in a pass over the field with the
same index permutation, so 156 games at one seed were one shuffle wearing 156 pairings. The fix is
in, across all twenty-nine harnesses that had it.

**It is not "a seed per game" everywhere**, which is what made it worth doing by hand. Twenty-two
absolute readings want one. `deck-probe` and `pod-slot` want one too, and get it safely because
their arms are two calls to the same loop, so a seed from the loop indices is the same seed in both.
**`bot-duel` and `pod-duel` want the opposite** — their repeated calls are the *arms*, the same
decks with the bots swapped and the same table with the seats rotated, so they must keep sharing a
seed. Giving those a seed each would have destroyed the pairing silently. The negative control says
it worked and says it exactly: **`bot-duel` with the same bot in both arms reads 156-156.**

`countdowns` was re-measured first, over two independent bases:

```
card                  D238 (shared)   base 3300   base 9000
Calciderm                 13%            26%         30%
Thing in the Ice          10%            20%         18%
Search for Tomorrow      100%            93%         82%
Blastoderm                22%            22%         21%
```

**Two of five were off by half**, and the two new bases agree with each other — which is what says
they are measurements rather than samples of one shuffle. Thing in the Ice's *denominator* moved as
much as its rate (21 clocks became 10 and 11), because a shared shuffle changes how often a card is
drawn at all.

Three published statements restated: the vanishing/fading price is collected about **one in four**
rather than one in six; **suspend converts about nine times in ten** rather than 29 of 29, which was
the shuffle and not the mechanic; and D237's "never once reaches one counter" was true of its sample
and not a law — one of eleven did. No **paired** conclusion in the log moves, which is D240's point
confirmed.

The other twenty-eight harnesses are changed but not re-run. Any absolute rate dated before this has
the error bars of its seed count rather than its game count.

## The inverted term is inert, and the reason reframes the problem (#227, D243)

D241 found cards-in-hand predicting the winner at 42-46% in the mid-game, on the second-largest
weight in the evaluation. #227 lowered it. 936 paired games per arm against the stock 1.5:

```
handCardValue   1.0 → 467-468     0.6 → 467-468     0.3 → 466-468
```

Level across a five-fold cut. And a real wash rather than a dead switch: `disagree.mjs` says the
setting changes **112 of 16,761 decisions**, almost all casts and activations, and those changes are
worth nothing. (Two identical records across different settings is exactly the reading the README's
standing rule exists for.)

**Why a badly calibrated term can be an irrelevant one, which is the part worth keeping.** A
calibration measures *positions*; a search compares *plays*. What decides a choice is not a term's
correlation with outcomes but its **variation across the options on offer at one decision** — and
hand size barely varies across them. Nearly every play under comparison is a cast, every cast moves
one card out of the hand, so the term contributes a near-constant amount to the whole slate and
cancels out of the comparison.

So the open problem's question changes shape: **not which terms predict the winner, but which terms
discriminate between the plays actually offered.** Those can be measured apart, and #228 is the
instrument for it.

The weight stays at 1.5, with a floor nobody had noticed: `LIBRARY_CARD` is 0.3, a draw is worth
`handCardValue − 0.3`, and below 0.3 the bot would be paid to avoid drawing.

## No term is both decisive and wrong (#228, D244)

D243 said to stop asking which terms predict the winner and start asking which ones separate the
plays. `term-leverage.mjs` answers it by ablation — each term removed, every arm asked the same
position the shipping bot played — which is exact rather than estimated. 16,761 decisions, crossed
with D241's calibration:

```
term        leverage   sign accuracy (turns 9-12)
creature      6.4%        67%     decides most, predicts best
life          2.3%        66%     decides much, predicts well
hand          0.9%        42%     decides little, predicts worst
library       0.2%        50%     decides little, predicts nothing
land          0.1%        53%     decides least, predicts nothing
control       0.0%         —
```

**The cell that would be a problem is empty.** High leverage *and* poor calibration is where a weight
costs games, and nothing is in it. The weights are already sorted: the terms that decide are the
terms that are right. **No weight in this function is costing games** — which closes the
retune-a-weight avenue on evidence rather than by exhaustion, after four deleted terms (D116), two
failed attempts (D68, D69) and a wash (D243) had only managed it between them.

Two rows that look like dead weight and are not. **`library` at 0.2% is a field average drowning a
term that belongs to one deck** — it is in the evaluation *for* the mill deck, and measured on
hollow-tide's own decisions it reads 1.0% and 3.8% of its casts. Added `SUBJECT` to the harness for
it, and the lesson generalises: before calling a term inert, ask whether the instrument could see it
being otherwise. And **`land` at 0.1% is a constraint, not a discriminator** — the land drop is a
rule taken before the search runs, so `playLand` is 0.0% for every term, and a weight whose job is to
make an inequality hold should have no leverage.

Also a map worth having: the evaluation reaches **casts, activations, attacks, blocks and turn-ups
and nothing else** — pass, decide, choose, discard, order and playLand are 0.0% for every term. And
**blocks are the most weight-sensitive decision in the game**, 27.7% changing without `creature` and
20.9% without `life`.

## The whole stack, driven through real browsers after today's engine change

Worth recording because none of it is in CI — the browser suites need a running stack and a
Chromium, so the thing that proves "two people can sit down and play" is the thing nobody runs
automatically. Run against the branch as it stands, after the `expired` engine change, the
`BotOptions.weights` refactor and twenty-nine harness edits:

```
scripts/e2e-table.mjs    two browsers, tabletop mode          73/73
scripts/e2e-arena.mjs    two browsers, rules engine           51/51
scripts/e2e-pod.mjs      four browsers, a Commander pod       42/42
scripts/e2e-solo.mjs     one browser, against the computer    24/24
                                                             ------
                                                             190/190
```

Including the checks that are not about features: no uncaught exceptions in any browser, no React
warnings, nothing the table depends on failing to load, the opponent's hand genuinely absent from
the other browser rather than merely hidden, and the whole table fitting a phone without sideways
scrolling.

**And a documentation bug worth more than the green ticks**, because it cost two attempts and the
failure lies about its cause. `e2e-table.mjs` is the oldest of the four and kept hand-rolled launch
instructions when `scripts/play.mjs` arrived; those instructions omit `VITE_REALTIME_URL`. There is
deliberately **no** `/socket.io` proxy in `vite.config.ts` — the WebSocket upgrade was reset before
reaching the target — so without that variable the browser opens a socket to the dev server, gets
nothing, and the suite times out on `[data-testid="pregame"]`. Which reads exactly like a broken
pregame screen, and is not. Fixed to point at the launcher like its three siblings, with the
by-hand form kept and the variable in it, and the same warning added to the setup doc's
*Proving it works*.

## The cheat-sheet audit became a guard, and the guard found a third gap

The audit that found `regenerate` and `prowess` was a pass over 80 mechanics done by hand, which is
the kind of check that is right the day it is run and wrong the next time a card is scripted. So it
is a guard now, and **the list of mechanics is derived rather than written down**: the candidates
are the engine's `KEYWORDS` and the `CardScript` field names (de-camelCased, so `splitSecond`
becomes "split second"), and a candidate is *required* to be documented only when its name appears
in some card's printed `oracleText`. That filter is what keeps it honest in both directions —
`removesACreature` is a hint for the bot, names nothing on any card, and is skipped without anybody
having to maintain an exception list; a keyword a player can read cannot be.

It reads source rather than `dist`, because `scripts/guards.js` runs **before** the build in CI.

It found a third gap immediately, and the gap is instructive: there *was* a row for the mechanic —
"Cast a spell that costs a creature" — and it never used the words printed on the card. A player
holding **Bone Splinters** ({B} sorcery in Ashen Rite and Dawn Tithe) or **Village Rites** ({B}
instant in Ashen Rite) reads *"As an additional cost to cast this spell, sacrifice a creature"* and
searches the sheet for that phrase. The row now carries it, plus the two things the phrase implies,
both read off the implementation rather than asserted from the rules:

- It is a **cost**, not a target. `autoActions.ts` takes the sacrifice as part of the cast and the
  creature is in the graveyard before anybody holds priority, so it cannot be saved in reply and
  killing it in response cannot deny the spell. The UI asks in that order too: `arenaReducer` goes
  to `feeding` before `targeting`, because the rules put the cost before the targets.
- A cost you cannot pay is not one you may pay (CR 601.2h). `legalActions.ts` does not offer the
  spell at all with no creature on the board — it reads *it asks for a creature to sacrifice, and
  you have none* rather than sitting on the stack waiting for one.

**And the guard carries its own control**, by the same standard the measure directory holds its
instruments to: its passing result is a zero, and a broken extraction is also a zero. So both
halves of the filter are asserted against `flying`, a mechanic known to be printed and known to be
documented — if `printed` ever comes back empty, every candidate is filtered out and the check
passes by seeing nothing, which is the one way it could be silently useless. Checked the other way
too, by renaming the phrase in the doc and watching it fail on exactly one mechanic.

The first draft of the filter asked whether the word appeared anywhere in `starterDecks.ts`, which
is a different question and said so at once: it demanded a cheat-sheet row for `decisions`, a
`CardScript` field printed on no card in any game of Magic. It was matching the file's own comments.

## A clock is not priced, and the search was overruling the fix (#222, D246)

D244 closed the retune-a-weight avenue on evidence and said the next change would have to be a term
that sees something the evaluation cannot. A clock is the plainest such thing: `creatureValue` is
power, toughness and keyword values, so a Ball Lightning scores as a creature you keep.

`scripts/measure/leaving-creatures.mjs` priced the mistake before anything was written, over 936
games, and the pool has exactly one of this kind: **18 attacks declined** by a Ball Lightning or a
Hellspark Elemental that was sacrificed at the end of that same turn — 13% and 14% of the attacks
they were offered, and these are the two cards whose whole function is one attack.

The rule is a **dominance argument** rather than a weight, which is a first for `bot.ts`: a creature
that will not exist after this turn cannot block in between and cannot attack again, so the worst
case of attacking is no damage and the certain case of staying home is no damage. It is deliberately
narrower than "has a clock" — a *dashed* creature returns to its owner's hand, and a vanishing one on
its last counter dies at the next upkeep, which is after the opponent's turn, so both can still lose
something real.

**And then the search overruled it, which is the finding.** The rule went into `worthAttacking` and
the field count moved from 18 to 16. Asking both bots the same positions said why: across 97 offers
the heuristic declined **0** and the search declined **10** — `evaluate` scores a board with the
creature still on it higher. So the fix that works is in the **plan set**, where `attackPlans` folds
a leaver into every plan the way CR 508.1d's forced attackers already are, and the dominated
declaration is never offered. All four end-of-turn rows then read 0, and every row that should not
have moved did not. Not in the evaluation, deliberately: the position after casting a Ball Lightning
is scored before its damage, so a leaver worth nothing on the board is a cast worth nothing.

Worth, paired: 473-463 of 936 on the field, and 148-140, 145-143 and 146-142 of 288 on the three
decks that hold the cards. Small and honestly small — none of those is distinguishable from zero on
its own — but four readings agreeing in sign with none of them losing. The case for the rule is the
dominance argument; the win rate is the check that it cost nothing.

**One finding came out with the opposite sign to the one it first had**, and it is the reason the
harness records the step. Its first reading said five cards had been spent on an opponent's creature
that was leaving anyway. Every one turned out to be cast in `declare-attackers` or earlier: the Maze
of Ith and the Darkblast aimed at an attacking Ball Lightning stopped six damage, which is the whole
job of both cards. Nor is the own-creature column waste — a Rancor returns to hand and a Bonesplitter
stays on the battlefield. So the honest statement is the opposite of the draft one: **the bot does
not waste cards on creatures that are leaving.**

## Soulbond, and the first link between two permanents that is not an attachment (#229, D247)

Every join this engine had between two permanents was an **attachment** — `attachedTo` on the Aura
or the Equipment, pointing one way, because one host carries several Auras. A pair is the opposite
shape: symmetric, exclusive, and it breaks by state-based action rather than by anything moving.

Three pieces, and the middle one is the interesting part:

- `CardInstance.pairedWith`, written on **both** halves, because either card is the one a player
  happens to tap. On the instance for the reason `MYRIAD` is: a register elsewhere is a register
  that falls out of step with the battlefield.
- `ContinuousEffect.scope` gained `{ kind: 'pair' }` — **the only scope here whose membership
  changes while the effect sits there**. Every other static fixes the cards it reaches as its
  permanent enters; a pair is made and broken turns later. So the effect is created once and asks
  `source.pairedWith` every time it is read, which makes "as long as this creature is paired" a
  condition that holds itself rather than an `ids` list to edit from the three places a pair breaks.
- Two pairing triggers rather than one, because one printed line is two questions: this creature
  arriving asks *which* of several candidates (a declinable target), and somebody else arriving
  asks *whether* to pair with the newcomer (a word).

**Breaking it is a pass over the board, and one case is why.** A member can die, be exiled, be
bounced, stop being a creature — or **change controller**, which moves nothing and raises nothing.
An Act of Treason on half a pair leaves both creatures alive and ends the pair anyway (CR 702.95b),
so a hook-based version would have missed the case the rules spell out.

The cards are **Wolfir Silverheart** ({4}{G}{G} 4/4, +4/+4 to each half) and **Trusted Forcemage**
({1}{G}{G} 2/2, +1/+1), both into Verdant Guard — the only deck here that plays four creatures,
which is the only deck a pair is worth anything in. Checked rather than assumed, because this is
where ninjutsu failed before D219: across 96 games they landed **37 times and paired 33 of them**,
the four misses being boards whose other creatures were already spoken for.

Both cuts kept their card in the pool — the Ambush Viper at Kindle Grove, Secure the Wastes at
Forge Alliance — which is this list's own rule for a cut and cost two tests a change of deck.

**And the slot is where this entry earns its keep, because the probe lied about the sign.**
`deck-probe` priced the two cards at **+16 of 288** (191-97 against 175-113). The field table at the
canonical seeds, run once with them and once with them reverted, reads Verdant Guard at **60% with
and 63% without** — eight games the other way. D203 had already found a probe overstating a slot by
a factor of ten; this is the first time one has had the sign wrong, and it is the strongest case yet
for the rule that entry wrote down: never publish the probe alone.

**Both halves of that are corrected by D258.** Neither reading had paired arms, the probe-against-
table comparison was never valid in the first place, and re-asked properly the paired probe reads
−18, −1 and +4 on three seed sets against the table's −2 — so what these cards are worth to this
deck is below what 288 games can resolve, and the eight games above is a reading from inside that
floor rather than a measurement of it.

The cards ship anyway, and for the mechanic rather than the record: a keyword needs a card in a deck
to exist (D229), Verdant Guard is the only deck here a pair is worth anything in, and a deck fourth
of thirteen at 60% can afford three points. Hunting a neutral slot at the fourth row would be
optimising the wrong end of a table whose problem is the top two.

A player sees the pair: a **PAIR** badge on the card's corner and "paired with ⟨name⟩" on its own
sheet, because a Grizzly Bears reading 6/6 is only legible if the thing lending it the points is
on screen.

**Driven through a real browser now, which it was not when this entry was first written** — see
the section below.

## The spread is the pilot as much as the decks (#231, D248)

Ember Rush has read 74–82% in every field table since D114 and had never had a card cut, so #231 set
out to cut one. It does not need one, and finding that out settled a bigger question.

**Nine changes, 2,448 probed games, and the biggest moved seven of 288.** Six single swaps
(a Lightning Bolt for a Shock, a Swiftspear for a Hill Giant, a Bonesplitter, a Thermo-Alchemist, a
Ball Lightning, a Hellrider) and three multi-card shape changes to the curve and to the reach. Not
one made the deck worse than the noise floor, and four read as *improvements*, which is what a probe
does when nothing is happening. `cast-counts` agrees from the other side: the deck casts everything
— Lightning Bolt 135 times in 144 games, a Thermo-Alchemist activated 191 times — and its weakest
cards still get cast in 55% of games. There is no slot to take out.

**So the pilot was measured instead, which nobody had done.** The same field on the same seeds, once
with the shipping bot and once with `lookahead: false` on both seats:

```
                deep   shallow   move
kindle-grove     64%      72%     +8
ember-rush       77%      66%    -11   (223 -> 191, thirty-two games)
dawn-tithe       75%      64%    -11
verdant-guard    60%      57%     -3
delta-bloom      45%      53%     +8
arc-tempest      44%      50%     +6
skyward-writ     45%      48%     +3
ashen-rite       50%      45%     -5
forge-alliance   50%      43%     -7
rot-harvest      41%      42%     +1
tidal-mind       28%      39%    +11   (82 -> 113, thirty-one games)
hollow-tide      38%      38%      0
blight-vector    30%      31%     +1
```

That is **thirty-two games to Ember Rush and thirty-one away from Tidal Mind** — four to five
times the best cut anybody could find in Ember Rush's sixty cards.

**It is not "one move of lookahead", though, and the next section is the correction.**
`lookahead: false` returns the first candidate before the filter loop runs, so it turns off the
search *and* the twenty board-reading rules at once. Split properly, the filters are +37 of Ember
Rush's thirty-two and the search is −5. The spread
narrows from 49 points to 41 and the deviation across the thirteen decks from 14.8 to 11.6, so
**about two fifths of the pool's imbalance is the pilot rather than the decks.** The direction is
what the search's shape predicts: its gain is "do not throw creatures away, and point removal well",
which is most of what an aggro deck and a removal deck do and almost none of what a control deck's
value is.

Three consequences. Every balance entry in these docs is a measurement of **deck × pilot**, and the
pilot's share is large — so "Tidal Mind is the worst deck by eleven points" is a statement about
this bot, and with a shallower one it is eleventh by one. Trimming the top is closed on evidence
rather than exhaustion. And the lever that is left is the one this project has circled since D110:
an evaluation worth searching with, because every point of pilot skill that helps a slow deck
narrows the table a person picking a deck actually feels.

## The filter family is the biggest pilot effect, and one of them refused a deck's removal (D249)

D248's switch turned off two things at once. `bestPlay` returns the first candidate *before* the
filter loop when lookahead is off, so `lookahead: false` skips the search **and** the twenty
board-reading "this play buys nothing" rules — the ritual with nothing to spend it on, the Fog with
nothing attacking, removal with nothing to remove, the pump that wears off, all of them.
`BotOptions.wasteFilters` separates them, and the three arms say something nobody expected:

```
                 search      search      neither     filters   search
                 + filters   only                    worth     worth
ember-rush          223        186         191         +37       -5
dawn-tithe          216        196         185         +20      +11
kindle-grove        185        220         207         -35      +13
ashen-rite          144        155         131         -11      +24
arc-tempest         128        144         145         -16       -1
delta-bloom         131        134         152          -3      -18
tidal-mind           82         99         113         -17      -14
```

**The filters are the largest pilot effect in the pool** — +37 games to the best deck, −35 to the
third — and D248's "one move of lookahead is thirty-two games to Ember Rush" was +37 from the
filters and −5 from the search.

**And −35 to Kindle Grove was one filter being wrong.** `cast-counts` with the family on and off,
read by card, found it in one line: `Harnessed Lightning, 7 casts with the filters on and 39 with
them off`. The card asks "pay how much energy?" and its own `beforeDecisions` puts three energy in
the pool **before** the question — so `chosenNumberIsNothing`, which asked that question from the
board before the cast, got `{min: 0, max: 0}`, got nought back from the card's own `best`, read it
as "the card says nought buys this", and dropped the cast in 82% of the games the deck drew it.

Fixed by narrowing the rule rather than simulating the card: a script with a `beforeDecisions` is
not this rule's business, which is the line the function already draws around a question the card
computes for itself. The field with the fix in: **+11 games to Kindle Grove and nothing anywhere
else**, nine of the other twelve decks within a single game. It widens the spread by a point because
the deck it fixes was already third, which is worth saying and is not a reason to leave a bot
refusing to cast a deck's removal spell.

**The second row read does not come apart the same way, and that is the methodological half.**
`arc-tempest −16` diffs into one rule's trade rather than a mistake: holding mana up for an answer
buys ten more Counterspells and costs forty-six firebreathing pumps on a Phoenix of Ash. Pricing
that rule on the field says it is **worth +13 of 288 to Hollow Tide and +5 to Arc Tempest** — the
opposite of the hypothesis, and a number nobody had per deck before.

So the lesson: **a cast-count diff between two pilots is confounded by divergence.** The arms play
different games from move one, so a card's count drifts for reasons unrelated to the rule under
test. Only a signal far larger than drift is readable, and Harnessed Lightning's 7-against-39 with a
mechanism confirmed in the code was that; Arc Tempest's rows are drift-sized, and reading them as
causes would have produced a confident wrong answer of the kind D119 warns about.

`ashen-rite +24` and `delta-bloom −18` in the **search** column are still open and need a different
instrument, because there is no "search off, filters on" arm to compare against.

## The pair is drawn, and the badge was invisible to the instrument (#234)

Soulbond was the one mechanic with a prompt that shipped without a browser drive, and #229's closing
note said so in as many words: every other prompt-carrying mechanic got one (#174, #177, #210), this
one had unit coverage for both prompt shapes and nothing that had seen either on a screen.
`LIST=soulbond node scripts/e2e-solo.mjs` is that drive, and it is **27 of 27**.

It is three claims rather than one, because soulbond asks two different questions through two
different prompts and then draws a third thing:

- the soulbonded creature arriving asks *which* of your unpaired creatures to pair with — a
  declinable `optional/friendly` target, captured off `aimed a trigger: …unpaired…`;
- any *other* creature arriving beside an unpaired soulbond creature asks *whether* to pair, whose
  answer is a word rather than a card — the table drew it as a primary button reading
  `Pair them?`;
- and the board names the partner on the card, read off `zone-battlefield-0` on every move:
  `PAIRED WITH TRUSTED FORCEMAGE`, `PAIRED WITH CENTAUR COURSER`, `PAIRED WITH GIANT SPIDER` across
  two games.

The list is eight soulbond creatures and sixteen cheap bodies, because both prompts need *two*
creatures and a stock Verdant Guard draws its two pair cards in a game or two out of five.

**The finding is in the third claim, and it is about the instrument.** The first run caught both
prompts and **zero** badges, which reads as a pair the engine made and the screen never drew — a
real bug, if it were true. It was the regex: the badge span carries `uppercase`, Chromium applies
`text-transform` *before* handing text to `innerText`, so `cardBadges` writes "paired with Grizzly
Bears" and the board reads "PAIRED WITH GRIZZLY BEARS". Case-insensitive, three distinct partners
appear immediately.

Worth writing down because the mistake was invisible from either side: `arena.test.ts` asserts the
exact lowercase string on `cardBadges` and passes, the browser draws the badge correctly, and only
the scan between them was wrong. Every other board scan in that suite matches a card name or a body
like `3/3` — neither of which a transform touches — which is why 24 checks' worth of innerText
reading has never met this. A measurement that fails for a reason that has nothing to do with the
thing measured is the failure mode D119 is about, and the only defence here was that the claim was
specific enough to be worth a second look rather than filing as a bug.

## A static can hand another permanent a triggered ability (#230, D251)

The structural hole the myriad docblock named: a continuous effect could change what a creature
**is** — bigger, flying, unable to block, a different type — and nothing could give it something it
**does**. "Each of those creatures has 'whenever this creature deals damage to a player, draw a
card'" was unscriptable, which is why Blade of Selves' myriad had to be a keyword the combat code
reads rather than an ability the Equipment hands out.

It is two halves, and the reason is serialisation: a `TriggerDef` is a bag of functions and
`GameState` is data that gets cloned and handed to a bot search, so the ability lives in
`CardScript.grantedTriggers` and `PumpOptions.grants` carries *indices into it*. Putting it on
`PumpOptions` is the whole of why this was small: `modsFrom` is the one translation from what a card
says to what an effect holds, and the five builders that read it — an Aura's bonus, a bestowed one,
an Equipment's, a `statics` entry, soulbond's pair — are the complete list of ways a printed card
grants anything. Every scope the engine already has answers "who gets it", including the soulbond
`pair` whose membership changes under the effect while it sits there; duration and removal come free.

The ability belongs to the **holder**, not the grantor (CR 113.6), so "this creature" means the
creature and the controller is its controller. The exception is `StackObject.grantedBy`, which
carries the granting card's *name*: an ability is independent of its source once it is on the stack
(CR 608.2), so an Aura destroyed in the window before the trigger resolves still draws the card —
and a test holds that window open in the damage step and kills the Aura in it.

Collection is one function rather than two: `fireTrigger` came out of `raise`'s watcher loop so the
printed and granted cases share the intervening-if clause, the five fields saying what the event
was, the obvious targets and the prompt when they are not. `abilityTargetSpecs` is the same move on
the other side — three places looked target specs up in the holder's script and all three now ask
one function. Layer 6 falls out of the same loop shape the keyword clearing uses, so a Turn to Frog
cast after an Ophidian Eye takes the trigger away and one cast before it does not (CR 613.1f).

**Two cards, two routes in**: Tandem Lookout ({2}{U} 1/1, soulbond) hands the ability to a pair and
Ophidian Eye ({1}{U} Aura, flash) to one creature. Two for D239's reason, but the second is also the
only evidence that the `PumpOptions` decision reached every builder — one goes through
`applyStatics`, the other through `addAuraEffect`. A creature carrying a borrowed ability says what
it is on its own sheet (`has draw a card`), because nothing in its text box does.

**And the slot is a negative result.** Skyward Writ over 288 games at the canonical seeds: 139-149
stock, **121-167** with the two cards in — eighteen games, about six points, 48% to 42%. A second
arm cutting a Pacifism and a Rest in Peace instead read 124-164, three games of 288, so the cards
are the cost rather than the slots; that arm was also illegal, which only the deck-coverage test
knew, because Skyward Writ is the only deck holding either card. `cast-counts` says the bot casts
both of the new ones (70% and 101% of the games it draws them), so this is a card being bad rather
than dead — and the 101% is the suspected reason: the Aura is spent at the first opportunity on
whatever creature is there, and an Aura on a creature an opponent can kill is a two-for-one. That is
a bot rule with a task of its own rather than a guess folded in here. The cards ship for the
mechanic, with the number in the open.

## The bot was enchanting the opponent's creature (#235, D252)

D251 left Skyward Writ eighteen games of 288 worse and guessed that the bot was spending its Aura
too eagerly. The guess was wrong in the right direction, and a new instrument settled it.

`granted-abilities.mjs` asks the one question that separates "the effect is weak" from "the bot
misplays it": per grant that reaches the battlefield, how many times did the granted ability
trigger, and how often was everything holding it gone before it fired once. It counts by reading
`StackObject.grantedBy`, the engine's own record of a granted ability, so it cannot drift from what
the rules did.

Its first output: **Ophidian Eye reached the battlefield ten times and the ability triggered zero
times**, and six of the eight creatures it was handed to belonged to the *opponent*. A granted
ability belongs to the creature holding it (CR 113.6), so the Eye on their Gurmag Angler draws cards
for them — not a wasted card, a card given away.

The cause was a hint nobody had applied. `TargetSpec.friendly` has existed since the prevention
shields and is advice to the bot rather than a restriction; the bot's default is "the enemy and the
enemy's creatures", which is right for removal and burn and backwards for a bonus. Seven specs
carried it, and both `chooseTargets` and `TargetSpec.friendly` named the pump spells as the gap and
called it waste. The word for an Eye on their creature is not waste. Eleven specs carry it now — a
shared `TARGET_CREATURE_HELPED` for eight spells, three Aura targets, and `BESTOW_TARGET`, which is
a fact about the keyword rather than about Boon Satyr. A derived test holds it, with Pacifism as the
control in the other direction.

**The win rate does not move**: biggest change three games of 288, four decks unchanged, which is
inside this instrument's noise. Worth saying plainly — a correctness fix worth nothing measurable,
because eleven one-ofs get to make the play three times a game set. It does not recover D251's
eighteen games. What it buys is a bot that no longer makes a play a person would call a misclick.

Still open: aimed at its own side, the Eye still fires zero times in 48 games, because `friendly`
says which *side* and not which creature — the hosts are a Wall of Air and an Omenspeaker, and a
combat-damage trigger on a 0/4 defender is worth nothing. "Aim a combat-damage bonus at a creature
that can attack" is a board reading rather than a flag, and this instrument would now price it.

## Which creature, not which side — a rule that works and is worth nothing (#238, D253)

D252 taught the bot which *side* to put a bonus on; the Ophidian Eye then landed on a Wall of Air,
because `creatureValue` is power plus toughness plus keywords and a 0/4 flying Wall (5.5) outranks a
1/1 flying lifelink Healer's Hawk (4). It does, for every purpose except a trigger that reads
"whenever this creature deals damage to a player".

`TargetSpec.helpsInCombat` is the third hint of that family, after `friendly` and `blinks`: rank the
creatures that can **never** attack below the ones that can. A fact rather than a weight —
`defender` and a blanket `cantAttack` are permanent, where tapped and summoning-sick wear off. Four
specs carry it; Giant Growth deliberately does not, because pumping a blocker is half of what that
card is for.

It does what it says — the hosts go from Walls and Basilica Guards to Healer's Hawks and Hidden
Dragonslayers — and **it is worth nothing**: the granted ability fired 6 times with the rule on and
6 times with it off over 144 games, and the field table moves one game in each direction. The reason
is in the same output: 28 of 49 grants lost every creature holding them before firing once. Skyward
Writ's creatures die, and which one wears the Aura when they die does not matter.

Kept on D216's terms rather than on a win rate: a person playing against this engine will see the
Aura go onto a wall and draw the obvious conclusion, and no measurement here prices that. The rule
is declarative, has no number in it, ships with the flag that proves it inert, and a unit test
asserts both arms. It is not a recovery of D251's eighteen games, and two rules in a row have now
measured flat on that deck.

## Layer 6 reaches further than the keywords (#237, D254)

A rules bug found while building #230 and deliberately left out of it. "Loses all abilities" is
layer 6 (CR 613.1f) and `characteristicsOf` has honoured it since #88 — for keywords, and for the
statics the layers read. Nothing honoured it for the two kinds of ability the layers never see: the
triggers `raise` collects off the script, and the activations `legalActions` offers in all three
places it offers them. So a Frogged Blood Artist went on draining when something died, and a Frogged
Llanowar Elves went on tapping for green — and that second one means `manaSources`, the single
answer to "what can this seat pay", was offering plays it could not afford.

`allAbilitiesLost` is the one question, asked in those four places. No timestamp reading, unlike
`grantedTriggersOn`: a card's own text is there from the moment it is on the battlefield, so every
"loses all abilities" is later than it. Only a *granted* ability can arrive after the Frog, which is
why the collection loop clears the **script** rather than skipping the watcher — a Frogged creature
still gets what something else grants it afterwards.

Worth nothing on the field: the table at the canonical seeds is identical, all thirteen decks. That
is three flat results in a row (D252, D253, D254), and the pattern is worth naming rather than
repeating — a change that corrects what one card does to one permanent cannot move a thirteen-deck
field, and measuring it is still right, because the alternative is a changelog full of improvements
nobody priced.

## Redirection, the last named gap in the replacement-effect family (#239, D255)

"What is left is redirection" has been in the not-done list since #85. It is in now, and it is the
shield plus one field rather than a subsystem: `preventsDamageAmount` is already a quantity spent by
the damage it absorbs, and `redirectTo` says where the absorbed points go. `dealDamage` deals them
by calling **itself**, which is what makes the redirected damage a real damage event — protection on
the destination stops it, infect poisons with it, lifelink gains the life, a shield there takes its
share — with a four-deep bound, because two redirects pointed at each other's protectees is a legal
board and a real loop.

The part that is not obvious is the **scope**. Both printed cards say "you and/or permanents you
control", which is one quantity over a player *and* everything they have, and no existing scope
could say it: `seat` is the player alone, `controller-creatures` the creatures alone, and two
effects would prevent twice as much. So `{ kind: 'seat-side' }` is the pool's second scope
`characteristicsOf` can never match, read live so a creature arriving later is under it too.

Two cards: **Harm's Way** ({W}, two points, Forge Alliance) and **Divine Deflection** ({X}{W},
Skyward Writ) — the pool's eighth {X} spell and the first whose X is spent twice, once on what it
stops and once on what it deals. Tests hold the three new claims: the points land on the chosen
target, the card pays out what it **absorbed** rather than what it printed, and the side scope is
one shield rather than one each.

**The slot cost ten games and the slot is not why**: Forge Alliance reads 148-140 stock, 138-150
with Harm's Way in for a Loxodon Warhammer, 137-151 with it in for a land. One game apart — D251's
finding reproduced on a different deck and card. Two cut-set comparisons on two decks have now come
back within three games of each other, so the next negative card is a question about the card rather
than about its slot.

## The instrument could not see a shield (D256)

Found by reading `wasted-plays` on the deck that had just been given a redirection card: `3 of 3
100%  Harm's Way`. A card that bought nothing every time it was cast — and neither a card problem
nor a bot one. The fingerprint it compares either side of a play is counts of cards, bodies and
life, and a prevention shield changes none of them, so a shield cast with a Bolt in the air and one
cast into an empty board looked identical.

The fingerprint sums the prevention on the table now. Before and after, 48 games a deck: Harm's Way
3 of 3 → 1 of 3; Holy Day 3 of 7 and Divine Deflection 3 of 4 → both gone; Skyward Writ's whole
list 9 of 543 → 3 of 543. Six false positives removed, one real suspect left, which is what the row
is supposed to mean.

Why it survived eleven increments is the part worth keeping: nothing in the pool had a shield as its
*whole* effect until these cards, so prevention was never near the top of the list — Holy Day sat at
3 of 7 under a top row of 79%. A new card put a 100% row in front of the question. That is the
argument for adding cards to a pool with instruments pointed at it, and for reading an instrument's
whole output rather than its top line.

## Two tables of the same thirteen decks disagree by thirty games (D257)

The most consequential finding in a while, and it is about the measurement rather than the engine.

**Deck list order changes the games.** `deck:load` builds the library in entry order and then
shuffles, and a shuffle permutes *indices*: the same seed over two arrays holding the same sixty
cards in a different order gives two different libraries. `deck-order.mjs` rotates one entry of
Forge Alliance's own list to the end and reads **9 of 40 games reached a different winner**. That
mattered here because `CHANGE` appends an added card at the end of the list while the same change
typed into the registry sits beside the cards it is like — so two arms meant to differ by one card
differed by one card *and* a reshuffle of the other fifty-nine. `canonicalDecks` sorts every deck
the same way in the harnesses (not in the engine, where the order is arbitrary anyway and where
sorting broke twelve tests pinned to their boards), and `deck-order` now reads 0 of 40 canonical.

**And then the control that matters more.** Two canonical tables of the same thirteen decks,
differing only in which seeds they used: blight-vector −30, ember-rush −24, verdant-guard −19,
forge-alliance +18, rot-harvest +18, hollow-tide +14. **Up to thirty games — ten points — between
two honest measurements of the same deck.** That is the error bar on a 288-game table, and it is
wider than almost every per-deck effect in these documents.

**So two of today's slot claims were re-priced with arms that are actually paired** — `deck-probe`
runs stock and variant over the same seeds, which with canonical ordering now means the same
libraries. #230's two granting cards cost Skyward Writ **14 of 288** (the unpaired reading was −18:
confirmed). **#239's Harm's Way is +12 of 288 to Forge Alliance** where the unpaired reading said
−10 — a sign reversal, and D255 is corrected in place.

The rule that follows: an unpaired comparison at 288 games cannot resolve a one-card change. A
paired one can. It also re-opens D203 and D247, whose "believe the table over the probe" rule was
drawn from disagreements between two unpaired readings — not evidence about either instrument.

**And "a paired one can" is too strong — D258 measured it.** Four changes on three seed sets each:
+30/+18/+21, −14/−19/−29, −18/−1/+4 and +12/+5/−13. **Two of the four change sign between sets**, so
the floor is about ±20 games in direction and not only in size. The granting cards survive it
(negative three times); **Harm's Way does not** — D257's sign reversal and D255's +12 are both
withdrawn, and that card's effect is simply below what 288 games can see.

**The new baseline** (canonical, SEEDS=12 SEED0=4400, ±10 points a row): ember-rush 75%,
dawn-tithe 73%, verdant-guard 68%, kindle-grove 67%, ashen-rite 50%, forge-alliance 45%,
arc-tempest 44%, delta-bloom 42%, blight-vector 41%, rot-harvest 40%, skyward-writ 39%,
hollow-tide 36%, tidal-mind 30%. Read as: four decks clearly ahead, one clearly behind, and eight
this instrument cannot order.

### The rule that was never testable, and the error bar on the one instrument we trust (D258)

#240 re-asked the two entries D257 re-opened, and the answer closed them and re-opened D257.

**"Believe the table" was never a comparison.** D203 and D247 both read a `deck-probe` number
against a `deck-table` number, disagreed, and concluded the table was the honest instrument. The two
harnesses derive their seeds differently, so those are **two different samples of the same
quantity** — on decks with no change at all they differ by 3 and 17 games in these very runs. And
the mechanism the rule proposed, that a probe amplifies its seeds while the table lets the field
move, does not apply to the row that was being read: `deck-table` plays each pairing once per seed
per order and credits both decks, so the subject's own row is the same 288 pairings the probe plays.
Letting the field move changes the other twelve rows.

Paired on both sides, the instruments agree on the sign in both cases:

```
dawn-tithe     209-79 with D203's six cards   189-99 reverted   +20   (probe: +30)
verdant-guard  195-93 with D247's soulbond    193-95 reverted    -2   (probe: -18)
```

So D203's six cards are worth **about +20 of 288**, two to three times the +11 that entry believed —
the probe it dismissed was the closer of the two — and what D247's two cards are worth is not
resolvable here at all, which the three-set table below is why.

**And pairing is nowhere near sufficient**, which is the finding worth carrying forward. Four
changes on three disjoint seed sets each:

```
                                        4400    7000    4688
D203  six cards into Dawn Tithe          +30     +18     +21
D251  granting cards into Skyward Writ   -14     -19     -29
D247  two cards into Verdant Guard       -18      -1      +4
D255  Harm's Way into Forge Alliance     +12      +5     -13
```

**Two of the four change sign between sets.** The two that hold are around ±20; the two that flip
each have a reading near zero. So the floor here at 288 games a set is roughly ±20 games **in
direction**, a smaller change is not measured however many times it is run, and the failure mode is
two sets agreeing by luck — which is exactly the mistake this entry's own first draft made and
published. `deck-probe` now reads three sets by default, prints each delta with the spread and the
mean, and says in words whether the change was measured at all.

The consequence for the balance work: a slot worth less than about twenty games of 288 cannot be
priced by any instrument in this project, and several published numbers are smaller than that. Those
slots get decided on the mechanic and on what a person sees at the table, which is what D229 and
D216 already do.

Three rules replace the one: pair the arms; read two seed sets and publish the range, because a
change that does not clear it on both has not been measured; and never set a probe reading against a
table reading at all — run the table for the question only it answers, which is what the change did
to everybody else.

### Treasure and Clue, and the mana source that is spent (D259)

The pool had no Treasure, Clue or Food, and the reason was an engine refusal rather than an
oversight: `manaSources` skipped any mana ability that sacrificed its own permanent, so a Treasure
was a token the engine could **create and never spend** — the auto-tapper would not count its mana,
the cast would be refused, and nothing anywhere would say why.

`ManaSource.sacrifices` now carries "this source is consumed" from `manaSources` through `solveTap`
to `tapSources`, which sacrifices the permanent instead of leaving it tapped. The ordering needed no
new preference: the solver already reaches for the *least* flexible source that can pay a coloured
pip, so a Swamp beats a Treasure to a {B} on its own, and the generic tie is broken by putting the
consumed sources behind the free ones in the list.

**The Clue is the control and needed nothing** — `{2}, Sacrifice: Draw a card` is Mind Stone's
second row, and a sacrifice has been a payable activation cost since that card. Two cards make them:
**Thraben Inspector** ({W} 1/2, investigate) into Skyward Writ and **Pirate's Prize** ({3}{U}, two
cards and a Treasure) into Tidal Mind.

And `spent-permanents.mjs` asks what a unit test cannot — whether the position ever comes up. Tidal
Mind over 96 games: **16 Treasures created, 13 spent by their own controller (81%)**, none removed,
three left standing when the game ended. Skyward Writ's Clues over the same count: **35 created, 35
spent (100%)**, none left over. Against the line this deleted both numbers are zero by construction.

Which is the right way round for what the two cards are: a Clue is two mana for a card whenever you
like, and a deck that holds mana up always has a turn with two spare, where a Treasure is mana for a
turn that may never arrive.

Food is deliberately left out: it needs a real card, and a Food card's printed text cannot be
verified from this container. The engine work it will need is none.

### Seven readers of one field, and a guard for the class (D260)

D251 gave a card two ways to carry a triggered ability — printed, or handed to it by something else
— and everything written before that reads only the first. The failure mode is the worst kind: **it
goes quiet rather than wrong.** Nothing errors; a number comes back smaller than the truth and looks
like a finding.

Two had already been found separately this session (#236's three bot readers, `card-promises`
calling Ophidian Eye unscripted), so the question became how many there are. A grep found four more;
turning the grep into a CI guard found **two more again**, because they reach the field by a spelling
the hand-grep missed. Seven readers, one field.

The one that matters is `mechanic-coverage`, whose whole job is "which mechanics are held up by too
few cards": it counted trigger kinds off printed triggers only, so a kind no printed card carries
would read as **absent from the pool**, by the instrument built to notice exactly that. All four real
cases are **inert today and measured so** — the only granted kind here is `combat-damage`, which five
printed cards carry, so coverage reads the same 17 thin rows before and after. Two were genuinely out
of scope and carry their reasons as exemptions.

**Why a guard and not a control.** The obvious move was a planted control per instrument, like
`card-promises` has. It would not have caught any of the seven: a planted positive is written by the
same author at the same moment as the predicate, so it encodes the same blind spot. No self-test
catches an unknown unknown. What a grep *can* do is notice the pairing and fail on the PR that adds
the eighth — and the guard's own limit is written into it, found by trying to break it: a file passes
by *mentioning* the second list, comments included, so it is a tripwire for "did the author know",
not proof the reading is right.

### The exception thirty-five harnesses swallow, and the clean sheet (D261)

Every game-playing instrument here ends its loop with `try { ... } catch { break; }` and none report
catching anything, so a throw would end a game early and still be counted as a game played.
`deck-probe` says `(1 unfinished)` and that was the whole of what the project knew — "unfinished"
being four things wearing one word: the move cap, a null action, no progress, and a throw.

`unfinished.mjs` separates them, keeps every fault's message and action type, and exits non-zero on
any throw. **Every game reaches a winner**: 156 of 156 on one seed, 1248 of 1248 on eight, 1248 again
on the comparison arm, and `deck-probe`'s own 288 replayed with `SCHEME=probe`. So the swallowing is
harmless on this build, which is a claim about all thirty-five.

Two findings the clean sheet does not contain. The instrument **was not reproducing the harness it
audits** and caught itself doing it — it passed the `ActionContext` inside the move loop where every
harness drops it; the leftover arm then answered a question nobody had asked, which is that dropping
the context mid-game changes nothing, 1248 to 1248. And the probe's unfinished game **cannot be
replayed**, because that reading predates D259: three decks in the field changed, so today's engine
plays different games. A historical harness reading stops being reproducible once the engine moves,
which is D258's lesson arriving from the other direction.

### Four browser suites in no gate, and the half of that a test can hold (#245, D262)

D259 changed three decks, and the four `scripts/e2e-*.mjs` suites are in neither
`.github/workflows/ci.yml` (no browser job at all) nor `pnpm v2:test` (which filters to
`./packages/*` and `./apps/*`, and `scripts/` is not a workspace package). So the only way to answer
"did my deck changes break a browser suite" was to run them: `e2e-table` 73/73, `e2e-solo` 24/24
against the changed Tidal Mind. Nothing broke.

Two things could rot silently between those manual runs, and one of them already had once.
`e2e-table` asserted a card **by name** on Tidal Mind's deck-peek panel; its own comment records
that it first named the deck's single Counterspell, a balance pass cut that card, and the check went
red while the panel worked perfectly. Naming the three-of instead had moved the trap rather than
removing it — D259 edited this very deck. It now reads the deepest non-land slot out of
`STARTER_DECKS`, with a control for the derivation coming back with a one-of: the claim "the panel
names the deck's cards, and the name survives the socket and the render" is kept, and the claim
"Tidal Mind contains a Vampire Nighthawk" is given up to `starterDecks.ts`, where it belongs.

The second is bigger. `e2e-solo` carries twenty hand-written sixty-card lists — one per mechanic it
drives through a browser — and 178 of their slots are **strings looked up in a pool that is the
union of the starter decks**. Cut the last copy of a card from the last deck holding it and every
list naming it becomes cardboard, `auto:start` refuses the table, and the suite times out on a
screen that looks like a broken pregame and is not. Two of D259's three cuts went 2→1. So
`customDeck.test.ts` now extracts every pasted list and puts it through the real `poolCardNamed`,
`customDeck` and `deckIsAutomatable` — 41 tests, in a package CI already runs. Both failure paths
were exercised rather than assumed: a renamed card fails two tests and prints the name, and
defeating the extraction fails the control.

What that does **not** gate is the browser suites themselves — a broken selector, a feed over a
control, a React warning. It narrows the silent rot to the data dependency and leaves the browser
dependency a manual step, which is the honest summary.

### A check that existed and never ran, and the assertion it hid (#246, D263)

`packages/rules-engine` has had a `typecheck:tests` script since the suite was written, and nothing
ever ran it: CI runs `typecheck`, which points at `tsconfig.json` and excludes the test files, and
vitest transpiles rather than typechecks. Found while verifying D262 rather than while looking for
it, 22 errors deep.

One of them was a test that could not fail. `expect(s.seats[0]!.energy ?? 0).toBe(0)` — `Seat` has
no `energy`; it lives at `counters['energy']`. So the expression was `undefined ?? 0`, and "Harnessed
Lightning is cast with no energy banked, because the spell brings its own" would have passed with
three energy in the pool, which is the one condition it exists to rule out. That is the argument for
typechecking tests in a sentence: a wrong assertion is invisible by construction, because the thing
that would notice it is the thing being tested.

One of the 22 was the *type* being wrong rather than the test. `AutoDecideAction.cards` was
required, while `decide` — its only reader in the workspace — declares `cards?` and reads
`action.cards ?? []`. Making the declaration agree with the handler fixed twelve errors in one line,
and immediately produced a new one at a test reading `chosen.cards` without a guard, which is the
type doing its job. The rest were a stray argument to `proliferateCandidates`, a `who` read off
trigger-event union members that do not all carry it, a target ternary that assumed player-or-card
where an ability is also legal (#115), a `Set<Keyword>` asked about arbitrary card lines, and some
optional chaining.

`typecheck:tests` is now a CI step and `pnpm run v2:typecheck:tests`. Engine suite unchanged at 1292
passing, because every fix was a type and not a behaviour — except the energy assertion, which now
tests what it claims to. **A script in a package.json that no pipeline calls is not a check, it is a
comment.**

### The evaluation's first term about two boards, measured and switched off (#241, D264)

`evaluate` is a sum of independent piles — life, hand, library, a value per permanent, one seat's
total minus the average of the others. It can say "their board is bigger than mine" and
structurally cannot say "their board can attack into mine and mine cannot attack back", which is a
fact about the *pairing* and the thing a player reads before swinging with everything. #241 had
been open since D244, and I argued against it twice on the grounds that D258's ±20 floor made it
unmeasurable. **That was wrong and is corrected here**: the floor is about win rates. `term-leverage`
ablates on the real positions the real bot played, so a term's leverage is exact.

Built it — reusing the engine's own `canBlock`, so flying, reach, Walls, protection and landwalk
come for free, and vigilance falls out of reading `tapped` with no code about vigilance anywhere.
Nine tests pin the arithmetic. Then measured it three ways, and only one came back in its favour:
**1.5% of all decisions changed, 7.9% of attack declarations and 11.3% of blocks** (so not inert —
D243's hand term was 0.67% and was); **the win rate did not move**, 153-159, 157-155, 160-152 across
three seed sets with the sign disagreeing, which is "not measured"; and **it did not do the thing it
was written to do** — a new instrument, `crack-back.mjs`, asks whether a seat that swings with its
blockers dies to the return attack less often, and across three seed sets the answer was 17-15,
21-21 and 11-10: never lower, and the one reading whose three sets agree. Games also
run ~9% longer and the bot declines to swing in 19% of combats instead of 8%.

So the weight ships at **zero** and everything else is kept: the computation, the tests, the
`term-leverage` row, the instrument, and a test that fails if the default moves. "The evaluation
cannot express this" is a reason to try, not a reason to keep.

Four of my own measurement errors are written up in D264 because each is a reusable trap: a cost
reading that compared two arms playing different games (the real figure, with behaviour held fixed,
is 0.23ms a move); an attribution probe whose `process.env` read dominated what it measured; an
early exit kept for a reason other than the one first claimed for it; and a damage attribution that
read the step before the action and never matched `first-strike-damage`. Plus one about process:
twice I rebuilt `dist` in the middle of a three-seed-set run, and **a measurement that spans a
rebuild is not a measurement**.

### A three-line CSS change that presented as four gameplay failures (#248, D265)

A permanent turns a quarter turn when it taps and everything drawn inside it turns too, so an
attacking creature read "1/2 ATTACKING FRIEND" up the side of the card. Counter-rotating the strip
inside the card fails on geometry — the card's box is portrait, so a child rotated back overflows a
landscape footprint — but the **slot** wrapper is already the right box in both orientations and is
never rotated, so the badges move there and need no transform at all. Vigilance falls out for free.

Then the arena suite went 54/54 to **46/50**, and the four failures were a land not reaching the
battlefield, the mana bar, attackers never being declared and life never moving. None of them
mentions a badge. The move log gave it away: twenty turns of `primary: Pass` where a passing run
shows `chose a play: Play Plains`. `tryToPlayFromZone` decided a card was playable by reading
`textContent` of the **card** and matching /playable/ — and the badges had just left the card, so
every card in every zone read as unplayable and the driver stopped casting anything.

The driver reads the slot and taps the card inside it now, with the failure written into its
docblock. Same family as D262 and D263: a coupling nobody wrote down, failing somewhere other than
where it was made — except this one is load-bearing for all four browser suites at once, and was
loud but misdirected, which sends you to the engine rather than to the layout.

Three suites passed and the fourth found a **second reader**: `tryCommander` in `e2e-pod.mjs`,
which is its own function precisely because the command zone is the one place a spell is cast from
that is not the hand — so the shared driver never looks there and the fix did not reach it. "The
command zone was read 845 times and never said playable." Two readers one suite apart is where
patching call sites stops being the answer, so `slotsIn` now sits beside `cardsIn` with the rule in
its docblock, and the tree was checked for others before fixing.

Why that one cost minutes where the arena failure cost hours: the pod check counts its reads and
prints the text it saw, so the message names the bug. The arena check said a land did not reach the
battlefield. Same class of bug, opposite diagnostic quality, and the difference is entirely in what
each check chose to report on failure.

All four green on the final head: arena 53/53 with the four recovered, table 73/73, solo 24/24, pod
42/42 with the commander cast restored. What is asserted is structural — the strip is outside the
element carrying `--card-rot` — and not photographic: both badge-bearing creatures in the new
screenshots have vigilance, so they attacked untapped.

### The laptop nobody had measured, and a premise that did not survive it (#249, D266)

#249 said a player on a laptop cannot see both boards at once, and called it the single biggest gap
between this and a premium table. It is not true. On a 1440x800 laptop a duel reads **1.16 screens**
and its two creature rows span **229px of the 800px viewport** — both boards on screen together with
571px spare, reproduced across two independent games.

Two things I had not checked before writing the task. The density pass had already happened, and the
comment above the screens-tall budget says so (*"a duel was 1.37 and is 1.18"*) — the task's own last
sentence quotes that number, so I read it off the suite and still wrote the premise from the
screenshots. And that same comment records the one remaining item, the opponents' face-down hands, as
deliberately left alone: *"it is the tabletop metaphor, and style is the player's call."* Still the
position; still Nick's call rather than mine.

What genuinely had never been measured is the laptop. Six of the seven `setViewportSize` calls in the
four suites set 390x844, and the only desktop one is restoring the viewport after the phone check.
Phone width is the right worst case sideways and the wrong one for height — 844px of phone holds more
of this table than 800px of laptop. So the claim nothing could answer is the one the task asserted
hardest, and the absence of a measurement read like permission to assert one.

Both figures are now guards in `e2e-solo.mjs` with budgets set from the readings, printed pass or
fail — **and the pod is asserted too**, which it was not when this section was first written. The
pod reads **1.41 screens with all four creature rows inside 331px of the 800px viewport**: four
boards at once, which is the reading that matters most in the format the product is named for.

Getting that number took three attempts, and the detour is the more useful half. One `SOLO_POD=1`
run played 270 moves in fifteen minutes — 3.3 seconds a move — and never reached the layout block,
which is what made the pod look unmeasurable. Three explanations were ruled out by measurement
rather than argument: the engine plays a four-seat pod in **7–10 ms a move** (now
`scripts/measure/pod-pace.mjs`, so the next "the bots are slow" claim costs one command to refuse);
the driver's own cost is **flat at 253 ms/move** over 220 moves with no growth as the board fills;
and the `stuck` poll that was the leading suspect fires **0.0 times a move**. A later run finished
the game and printed both figures. The outlier is recorded as an outlier (#250), machine contention
being the cheapest remaining explanation and not provable after the fact.

Leaving the pod unasserted rather than guessing a budget for it cost nothing, which was the point:
the gap was recorded as a gap, so closing it was an edit rather than a correction to a shipped
number. A third finding fell out of forcing the checks against a mid-game board instead of a
post-game one — a full four-seat board overflows a phone by 17px, and every layout check in the
suite has only ever measured the emptiest board of the game (#251).

### A check whose premise was wider than its fixture (#251, D267)

One row in `ArenaBar` — mana pips, step, primary action, stops toggle, Concede — was
`flex items-center gap-2` where every other row in that bar wraps. On a phone it sized itself to its
content and pushed the whole table sideways, for the length of every automated game, which is every
game a player using the rules engine has ever played.

The fix was already written down one file away: the tabletop's own bar carries `overflow-x-auto`, and
`PlayTable.tsx` explains why a flex child needs `min-w-0` for it to work at all. The engine's bar
inherited neither when it replaced the manual one.

Finding it needed the right filter rather than more looking. Every element past 390px is 42 of them,
the worst 265px over, all of it cards inside rows that are *meant* to scroll — and an element inside
an `overflow-x: auto` ancestor cannot widen the document. Elements with no scrolling ancestor:
exactly one, the Concede button, `+41px`, the whole overflow. The check reports that now instead of
`overflow 17px`, computed only on failure.

**Why nothing caught it is the part worth keeping.** Every layout check in the solo suite runs after
the game reaches a winner — when the board is emptiest *and* `view.finished` has removed Concede and
the primary action from the bar. The row under test was never on screen when the check ran. That is
the fourth instance this week of one shape, and it now has a name: a check whose premise is wider
than its fixture. D262 named a card by hand, D263 existed and never ran, D266 could not be
contradicted, this one asserted "any board" and only ever saw one. None was a wrong assertion; each
was a correct assertion pointed somewhere it could not fail.

Verified against the failing condition, which took three attempts because a run that finishes inside
its move cap measures a post-game board: a mid-game stop that read `overflow 41px` now passes, arena
53/53 with both control-bar checks, web 226/226. The mid-game screens-tall budgets are deliberately
**not** raised to match — a pod reads 2.88–3.21 screens mid-game against 2.35 set from a post-game
2.23, and raising it would discard the only number protecting the post-game case (#251).

### The same shape in the instrument: an arm that never reached the bot (#254, D270)

`bot-duel` hands `TESTED` straight to `botAction` as `BotOptions`, and `botAction` ignores a key it
does not know — correct for an options bag, and silent. A weight lives at `opts.weights.castable`,
so `TESTED='{"castable":1}'` sets a field nobody reads and **both arms become the stock bot**. Three
seed sets, fifteen minutes each: **467-467, 467-467, 466-466**. That is not a weak signal, it is this
harness's own arithmetic negative control — identical bots play the same games and each is credited
one win per pairing, so the tie is exact by construction. I was composing "level across three seed
sets" as a statement about the term when the perfection of the tie stopped me.

The README already carried the lesson, from the day the ninja holding rule read 467-467: *a reading
identical to the control needs a positive control before you call it level*, and `lookahead: false`
duly came back 90-221. Right question, wrong subject. `lookahead` is a real field, so that control
passes while a *different* arm's key is being dropped on the floor. Fair, connected, and
**this-arm-connected** are three questions, and only the third was at issue.

So the check is now a per-arm pre-flight, and deliberately not a list of `BotOptions` field names —
that would be a second reader of a type that already has one, going quiet rather than wrong the next
time the type grows (D260). Both arms are asked the same ~2000 positions the shipping bot plays; no
disagreement anywhere means a non-zero exit before 936 games are spent. A real arm is found in a
second: `{"weights":{"castable":1}}` diverges at decision 71 on a targeted spell against an X spell.

The part worth keeping is what it cannot tell apart. `holdsNinjas` is a real field, read on every
filter decision, and it trips the guard across all thirteen pairings — because the window never
opens: 19 unblocked attackers, 2 ninjas in hand, **0** both, in 95 declare-blockers steps. So that
rule's 467-467 was a true reading of a rule that almost never fires, and the guard would have said so
in twenty seconds rather than fifteen minutes. Two causes, opposite fixes, so the message names both.

D267's shape, moved from the code into the instrument: **ask what the check would do if the thing it
checks were broken.** The positive control passed identically whether the arm's key was real or
nonsense, which means it was never evidence about the key.

### The hand term was the wrong shape, not the wrong weight (#253, D271)

#227 lowered the weight on cards-in-hand, and D243 closed the subject: the term anti-predicts the
winner at 42%, and a five-fold cut moved 936 paired games by one. The diagnosis was right and it was
about *variation* — what decides a choice is how a term differs across the options on offer, and hand
size barely differs, because nearly every candidate is a cast and every cast moves one card out.

What it did not cover is that **"cards in hand" and "cards in hand I can pay for" are different
terms**, and only the first had ever been measured. The second varies precisely where the first does
not: the candidates at a cast decision differ in what they leave the seat able to do next. #227's
conclusion and "the evaluation is asking the wrong question about the hand" produce the same number,
and nothing could tell them apart until there was a second term to compare.

Both instruments agree. Leverage: 157 of 17451 decisions, nearly the same total as `hand` and
pointed somewhere else entirely — **4.8% of cast decisions** against `hand`'s 2.8%, while `hand`'s own
leverage sits on activations. Win rate, three disjoint seed sets of 936 paired games: **479-454,
469-465, 471-462** — 1419-1381, +1.35 points, sign holding every time. That is D242's bar, and the
first evaluation term to clear it since; D264's `exposed` had no consistent direction and is still
shipped at zero. So `CASTABLE_IN_HAND` goes to **1**: a castable card at 2.5, level with a land and
under a permanent. A hand you can use is nearly a land; a hand you cannot is a hand.

The spread is worth stating rather than averaging away — +25 clears the harness's observed ±6, +4
does not, +9 does — which is the whole reason three disjoint sets are run rather than one long one.
Other weights are unmeasured and the deck table was baselined with the term off; both are recorded at
the constant rather than implied.

The part that nearly went wrong: `term-leverage`'s `castable` arm ran *on* rather than off, because
ablating a term that ships at zero reads a clean 0.0%. Flipping the default turns that arm into an
override that overrides nothing — and the zero-row check added hours earlier would have reported the
term as one the evaluation cannot see, the exact silence it was written to break, on the exact change
it was written beside. **A default and its ablation are one change, not two.** The six arithmetic
tests needed no edit at all, which is the payoff from naming both weights instead of leaning on the
default: they measure the term, not the configuration.

### The pod had never been audited for engine throws (#256, D272)

`unfinished.mjs` exists because thirty-five harnesses here end their move loop with
`try { ... } catch { break; }` and none of them reports catching anything — so a throw truncates a
game, the harness counts it as played, and its number is computed from a game that stopped at an
error. It audited two-seat games only. The three pod harnesses carry the identical catch and had
never been asked, and the pod is where the `nobody to act` end state stops being hypothetical: the
engine's own pod tests exist for CR 800.4a, and a table nobody can move at is worse than a throw.

**234 pods, two deck mixes, every one to a winner.** No throw, no stuck table, no move cap. So the
catch in all three pod harnesses has caught nothing and their published numbers are not short by
games they ate — and it is the strongest evidence yet for the claim the project cares about most,
in the format with three opponents and the 800.4a risk rather than the duel.

Tables, seeds and `ALWAYS` seating are copied from `pod-duel` rather than shared, because the point
is to replay *that* harness's games. One deliberate difference, on its own docblock's authority: it
plays each table four times rotating the arms, and with one bot in every seat all four rotations are
the same game on the same seed — so the audit plays each table once, which is every *distinct* game
it plays rather than every game it counts.

Narrow on purpose. It says nothing about a pod seating a card these tables never did, nor about a
pod a person is sitting at. The audit is as wide as its pairings — D267's shape — and the honest
version of the claim is the narrow one.

## Next

1. More scripts. The vocabulary in `effects.ts` covers far more than the cards currently using
   it, and the four ways a card can ask a player something — a mode, targets, a cost, a
   mid-resolution decision — are all in place. Adding a card is a few declarative lines. Every
   keyword and every static scope now has a card behind it, the subtype scope included;
   **every trigger kind now has at least one card**, `becomes-tapped` included — City of Brass
   since #69, and `mechanic-coverage.mjs` confirms 0 of 78 mechanics are declared with no card at
   all (#223, D239). What this list used to say about `becomes-tapped` being the card-less one is
   stale. And a **clock running out is deliberately not a trigger at all** (#221, D238): nothing
   printed watches one, so it is a fact in the log instead of an event with no listener.
   **A draw is an event now** (`draws`, with `you` and `opponent` halves and no `any`, because
   nothing printed here wants one), which was the most frequent thing in the engine and the one
   nothing could read — so "whenever you draw a card" and its mirror are both a few declarative
   lines.
   **And a cost can now be paid out of the graveyard**, which was the last zone nothing could
   spend: `escape` is a cost and a zone (a mana string plus a count of other cards), `delve: true`
   is a reduction chosen as the spell is cast, and `graveyardFodder` decides which cards go — so
   every card printed with either keyword is a line or two, and the shape beyond them (a cost paid
   by exiling cards from *somebody else's* graveyard, or from exile) is the same primitive with a
   different zone key.
   **A card reaching a graveyard is an event too** (`to-graveyard`, carrying which card it was), so
   "whenever another card is put into a graveyard from anywhere" is a line. **And a card reaching
   exile** (`to-exile`, D225), which was the last destination nothing could see and the one the pool
   has been sending cards to since Journey to Nowhere — so the family is complete: every zone change
   the engine makes is now visible to a card.
   `turned-face-up` has two cards behind it, morph has megamorph and a cost paid in life, target
   redirection has Willbender and Swerve, the three board-watching events carry *which* permanent
   they were about, and an ability on the stack can be pointed at — so exalted, evolve, "that
   creature" and "counter target ability" are all a few declarative lines now. Copying one is there as well:
   `copyAbilityOnStack` builds a second stack object with the first one's targets, its `subject`
   and its division, and **Strionic Resonator** in Rot Harvest copies a triggered ability its
   controller owns. It now also offers the printed "you may choose new targets for
   the copy" (`TargetDecisionSpec`), and so does **Twincast**, which copies a *spell* — an object
   with no card behind it, which is the half of the family that needed the stack to hold something
   that is not a card at all.
   A question whose answer is a **word** now exists too, so "you may", "tap or untap" and "choose
   one —" on a trigger are all a few declarative lines. The *number* half of that family is now
   answered both ways round. A quantity **divided among targets** is announced with the spell and
   checked as a sum (`divided` on a target spec, Arc Lightning), which covers the shape printed
   cards mostly use — damage or counters split among one, two or three things. And a number with
   nothing to divide it between, chosen **as the spell resolves** rather than as it is cast, is
   `NumberDecisionSpec`: a range the card computes from the board when the question is asked, with
   **Toxic Deluge** in Hollow Tide behind it. (The Chalice of the Void this list used to name as the
   example turned out not to need it: its number is the X in its cost, which is chosen at cast time
   and was already in the engine — see *The spell a trigger is about* above.) And the fourth and last shape, a
   **target** for something else on the stack, is `TargetDecisionSpec`: "you may choose new targets
   for the copy", asked while the copy effect resolves, with **Twincast** in Tidal Mind and the
   Strionic Resonator's printed clause behind it. So all four shapes of mid-resolution question are
   in, and a copy effect is a few declarative lines like everything else.
2. Loading a real Grimore deck into an automated table. **Half answered, and the other half still
   blocked.** A player can now paste a list and play it: names the engine's pool has become the real
   cards and are fully automated, which is the whole of the feature for a list built out of the pool.
   What is still missing is the rest of Magic — a name the pool does not have becomes cardboard the
   tabletop plays by hand, and Arena mode refuses it by name. Closing that needs card data for
   arbitrary names (type lines, mana costs, oracle text), the `cards` table has never been populated
   while this environment cannot reach Scryfall, and a type line is the minimum the engine needs to
   tell a land from a spell. Worth building where the data exists, not here — and the refusal is
   written so that it starts working the moment the data does.
3. **A stronger opponent still — and this item's diagnosis is now settled (D241, D243, D244).**
   The claim below is that *"what is missing is not depth: it is an evaluation worth searching
   with"*, and it stood for months with no evidence about **how** the evaluation fell short. Three
   measurements have now answered that, and between them they rule out the entire family of fixes
   that consists of changing a number:

   - The function is **honest**. Its ladder is monotonic, crosses 50% at a margin of zero, carries
     no systematic bias, and the sum beats every one of its components in every turn band — so depth
     was never being wasted on a function that lies about which side is ahead.
   - It is **blunt early**: 61% sign accuracy at turns 5-8, the only band where a search can still
     change an outcome. No amount of depth repairs that, because every leaf is scored by the same
     blunt function.
   - Its one badly calibrated term is **inert** (cards in hand, 42-46% mid-game: a five-fold cut
     moved 936 paired games by one), and **no term is both decisive and wrong** — the high-leverage,
     poor-calibration cell is empty.

   So the next move is a **term that sees something the function currently cannot**, and the open
   question is what a player reads off a turn-six board that none of life, creatures, lands, hand or
   library can express. The rest of this item stands as written.

   A stronger opponent still. It plays each option out — plays, attacks and blocks — and keeps the
   position it likes best, which is worth better than two games in three against the bot it
   replaced. But one ply is one ply: the simulation stops at the end of the current combat, so it
   cannot see the swing back on the opponent's next turn. "A spell is worth more later than now" has
   been taught by hand instead — the ritual, the Fog, the protection trick, the pump, and now the
   mana an answer in hand is waiting for — and each time it was a fact about the board rather than a
   weight, because the weight cannot be made to work. The counterspell is the clearest case of that:
   the same idea failed twice as a *weight* (D68, D69) and works as a *filter*, and the instrument
   that said why is `held-answers.mjs` — the handicap was never when it counters, it was that it had
   already spent the mana — and with the mana there, the judgement is fine (13 declines in 556
   windows, every one of them spent on another instant, and the spells it lets through cheaper than
   the ones it counters). All three need the *reply*,
   which is this same function recursing with the opponent choosing against it — and the cheap
   substitute for the first of them (scoring an untapped creature above a tapped one) was tried and
   measurably lost games, which is written up in `claude/decisions-log.md`. The reply itself has now
   been built and measured too — level over 240 paired duels, at a quarter more time per decision,
   and clairvoyant into the bargain because the search reads the whole game state (D110). What is
   missing is not depth: it is an evaluation worth searching with.
   **The clairvoyance half of this item was a stale claim and is now measured rather than asserted.**
   It was true of the *reply*, which is why the reply was reverted; the bot that shipped is honest,
   and `hidden-info.mjs` says so by asking it the same position twice with every card it cannot
   identify dealt out again — **0 of 8,945 decisions changed** across 78 games, with 1.58 million
   identities moved by the scrambles, and a deliberate cheat wired in as a control shows up at 26
   of 764 attack declarations. `playout.test.ts` holds the regression test (D186). What a *future*
   deeper search would still need is the honest version of the opponent model: the redacted view
   plus what their deck could be holding and whether their open mana pays for it.
4. The pod interface beyond "it works". Three opponents side by side, combat drawn rather than
   described, a threat read on every seat and on every button that sends an attack, one press to
   send the whole swing at one player, and three preset deals that the table records and never
   enforces. What is still missing is the rest of what a pod is *socially*: no table talk beyond the
   chat panel and those three sentences, and nothing that records who was politically on whose side
   over a game. **Half of that is now built**: every opponent's strip reads `hit you N`, all the
   damage that player has dealt you this game, so the table remembers what people did as well as
   what they promised (D189). **And the other direction is now recorded too** (D227): every strip also reads
   `spared you N`, the attacking power that seat could legally have aimed at you and sent somewhere
   else, which is the one reading that tells a player who chose to leave you alone from a player
   who was never able to attack you. **And the table talks back now** (D232): a bot *offers* a truce
   to the seat whose open board can already kill it, which is the one deal it can price without
   modelling anybody's future — the same board reading `answerPact` uses from the other side. Before
   that nothing at this table had ever spoken to the player first.

   Bot to bot it is near-inert and honestly so, because the two rules are one reading from opposite
   sides: 26 offers across thirteen pods produced 25 refusals, and the winner was identical in 12 of
   13. It is on by default because the value is the table a person sits at rather than a win rate,
   which is a claim made on its own terms. What is still missing is the rest of the conversation —
   asking for help, pointing at a threat, making one, trading a target for a target — and none of
   those is priceable from the present board, which is the line `offerPact` draws.
