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
| `scripts.ts` | All 63 scripted cards |
| `targeting.ts` | Legal targets, the duplicate-target rule, the fizzle rule |
| `combat.ts` | Who can attack, who can block, damage assignment |
| `automation.ts` | Steps, priority, triggers, state-based actions, resolution |
| `autoActions.ts` | The reducer for `auto:*` — what a player may do and what happens |
| `legalActions.ts` | What a seat can legally do right now, for the client |
| `bot.ts` | A player that only ever does what the engine offers |
| `view.ts` | Per-seat redaction, the automation block, and the wire form |

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

**365 tests in the rules engine, 95 in the web app, 955 across the workspace.**

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
- **`scripts/e2e-solo.mjs`** plays a whole game in one browser against the server — thirteen checks,
  and a game takes thirty-three moves. `OPPONENT_DECK` picks which deck the server plays, so the
  solo game is run against each of the four.
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

- **Replacement effects** (regenerate, "if it would die instead exile it"), **copy effects** and
  **characteristic-setting effects**. These are the shapes `effects.ts` has no vocabulary for, and
  the reason Golgari Charm is not scripted while Selesnya Charm is: one of its three modes
  regenerates, and a modal card with one unscriptable mode is an unscriptable card. A card like
  that is left alone and resolved by hand rather than approximated.
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

---

## Added after the first checkpoint

Twelve things, in the order they mattered.

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

## Next

1. More scripts. The vocabulary in `effects.ts` covers far more than the 63 cards currently using
   it, and the four ways a card can ask a player something — a mode, targets, a cost, a
   mid-resolution decision — are all in place. Adding a card is a few declarative lines. The
   `becomes-tapped` trigger and the `all-creatures` static scope are still unused: both exist,
   and the clean cards for them need something else the engine lacks.
2. Loading a real Grimore deck into an automated table. **Blocked here rather than undone:**
   `deck:load` already resolves any deck handed to it, but a real list needs card data — type
   lines, mana costs, oracle text — and the `cards` table has never been populated while this
   environment cannot reach Scryfall. A deck of bare names has no type line, so the engine cannot
   tell a land from a spell and Arena mode would be unusable; the tabletop would be fine. Worth
   building where the data exists, not here.
3. A stronger opponent. The current one plays a real game but does not plan one. It now answers
   mid-resolution questions in the direction that helps it and prefers taking more of a modal
   spell, which is judgement rather than search — a search needs a position evaluator.
4. A pod driven through four real browsers. The engine plays pods and the server seats four, but
   every browser suite here opens two contexts, so the four-seat *interface* — whose turn it is
   with three opponents on screen, who is being asked to block, a phone showing three other
   boards — has been reasoned about rather than looked at.
