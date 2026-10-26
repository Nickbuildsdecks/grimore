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
| `scripts.ts` | All 207 scripted cards, the five basic lands among them |
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
  and can sit on a player. That was the last of the named gaps in this family; what is left is
  redirection ("the next time ~ would deal damage, it deals it to ~ instead"), which nothing in the
  pool needs and which is not approximated.
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

## Next

1. More scripts. The vocabulary in `effects.ts` covers far more than the cards currently using
   it, and the four ways a card can ask a player something — a mode, targets, a cost, a
   mid-resolution decision — are all in place. Adding a card is a few declarative lines. Every
   keyword and every static scope now has a card behind it, the subtype scope included;
   `becomes-tapped` is the one trigger left without one, and deliberately so (see the entry above).
   `turned-face-up` has two cards behind it, morph has megamorph and a cost paid in life, target
   redirection has Willbender and Swerve, the three board-watching events carry *which* permanent
   they were about, and an ability on the stack can be pointed at — so exalted, evolve, "that
   creature" and "counter target ability" are all a few declarative lines now. What is left on that
   list is **copying** an ability: "copy target activated or triggered ability" (a Strionic
   Resonator, a Lithoform Engine) means duplicating a stack object with its targets and its
   `subject`, which is different work from pointing at one, and nothing in the pool wants it yet.
2. Loading a real Grimore deck into an automated table. **Blocked here rather than undone:**
   `deck:load` already resolves any deck handed to it, but a real list needs card data — type
   lines, mana costs, oracle text — and the `cards` table has never been populated while this
   environment cannot reach Scryfall. A deck of bare names has no type line, so the engine cannot
   tell a land from a spell and Arena mode would be unusable; the tabletop would be fine. Worth
   building where the data exists, not here.
3. A stronger opponent still. It plays each option out — plays, attacks and blocks — and keeps the
   position it likes best, which is worth better than two games in three against the bot it
   replaced. But one ply is one ply: the simulation stops at the end of the current combat, so it
   cannot see the swing back on the opponent's next turn or keep mana up for the counterspell in
   its hand. "A spell is worth more later than now" has been taught four times by hand instead —
   the ritual, the Fog, the protection trick and the pump — and each time it was a fact about the
   board rather than a weight, because the weight cannot be made to work. All three need the *reply*,
   which is this same function recursing with the opponent choosing against it — and the cheap
   substitute for the first of them (scoring an untapped creature above a tapped one) was tried and
   measurably lost games, which is written up in `claude/decisions-log.md`. The reply itself has now
   been built and measured too — level over 240 paired duels, at a quarter more time per decision,
   and clairvoyant into the bargain because the search reads the whole game state (D110). What is
   missing is not depth: it is an evaluation worth searching with, and a search that reasons from
   the redacted view a person gets rather than from everybody's hand.
4. The pod interface beyond "it works". Three opponents side by side, combat drawn rather than
   described, a threat read on every seat and on every button that sends an attack, one press to
   send the whole swing at one player, and three preset deals that the table records and never
   enforces. What is still missing is the rest of what a pod is *socially*: no table talk beyond the
   chat panel and those three sentences, and nothing that records who was politically on whose side
   over a game — the badge says who broke a deal, not who was helping whom.
