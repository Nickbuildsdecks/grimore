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
| `scripts.ts` | All 90 scripted cards, the five basic lands among them |
| `targeting.ts` | Legal targets, the duplicate-target rule, the fizzle rule |
| `combat.ts` | Who can attack, who can block, damage assignment |
| `automation.ts` | Steps, priority, triggers, state-based actions, resolution |
| `autoActions.ts` | The reducer for `auto:*` — what a player may do and what happens |
| `legalActions.ts` | What a seat can legally do right now, for the client |
| `bot.ts` | A player that only ever does what the engine offers |
| `view.ts` | Per-seat redaction, the automation block, and the wire form |

In the web app: `lib/arena.ts` (the interaction reducer), `components/table/{PhaseBar, StackPanel,
ArenaBar, PlaySheet, CombatArrows}.tsx`, and `pages/PlayTable.tsx` branching on `view.automation`.

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

- **Most replacement effects.** Two are in — regeneration (CR 701.15) and "enters with counters"
  (CR 614.1c) — and they are the two the card pool wanted, which is how Golgari Charm came to be
  scripted after two checkpoints of being the standing example of what could not be. What is still
  missing is a replacement *layer*: "if it would die, exile it instead", damage prevention and
  protection all need an effect that other permanents contribute, rather than a shield sitting on
  the one card. Cards needing those are left unscripted rather than approximated.
- **Copy effects** and **characteristic-setting effects**: still no vocabulary for either.
- **True layer interaction** (CR 613). What is here is a fixed order — printed, then effects, then
  counters — which is right for every effect the card pool produces. Characteristic-setting and copy
  effects need the real thing.
- **A stronger bot.** It attacks with everything, blocks when the trade is good, and casts the
  biggest thing it can afford. A better opponent needs a search, and a search needs a position
  evaluator, and neither was worth writing before the rules underneath them were trustworthy.
- **Multiplayer combat nuance.** Pods work — declarations are per defender, a seat can only block
  what attacks it, and an attack can be aimed at a planeswalker — but there is no "each opponent"
  combat maths beyond what the scripts do, and no goading or forced attacks.
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

## Next

1. More scripts. The vocabulary in `effects.ts` covers far more than the cards currently using
   it, and the four ways a card can ask a player something — a mode, targets, a cost, a
   mid-resolution decision — are all in place. Adding a card is a few declarative lines. Every
   keyword and every static scope now has a card behind it; `becomes-tapped` is the one trigger
   left without one, and deliberately so (see the entry above).
2. Loading a real Grimore deck into an automated table. **Blocked here rather than undone:**
   `deck:load` already resolves any deck handed to it, but a real list needs card data — type
   lines, mana costs, oracle text — and the `cards` table has never been populated while this
   environment cannot reach Scryfall. A deck of bare names has no type line, so the engine cannot
   tell a land from a spell and Arena mode would be unusable; the tabletop would be fine. Worth
   building where the data exists, not here.
3. A stronger opponent still. It plays each option out — plays, attacks and blocks — and keeps the
   position it likes best, which is worth better than two games in three against the bot it
   replaced. But one ply is one ply: the simulation stops at the end of the current combat, so it
   cannot see the swing back on the opponent's next turn, keep mana up for the counterspell in its
   hand, or tell that a spell is worth more next turn than this one. All three need the *reply*,
   which is this same function recursing with the opponent choosing against it — and the cheap
   substitute for the first of them (scoring an untapped creature above a tapped one) was tried and
   measurably lost games, which is written up in `claude/decisions-log.md`.
4. The pod interface beyond "it works". Three opponents side by side, combat drawn rather than
   described, a threat read on every seat and on every button that sends an attack, and one press
   to send the whole swing at one player. What is still missing is everything a pod is *socially*:
   no table talk beyond the chat panel, no way to offer or take a deal, and nothing that records
   who was politically on whose side — which is the half of Commander a screen is worst at.
