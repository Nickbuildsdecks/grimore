# The instrument

Harnesses that measure the starter decks against each other, using the engine's own bot for
both seats. They are here rather than in a scratch directory because `claude/decisions-log.md`
quotes their numbers: a measurement nobody can re-run is an anecdote.

All of them read `packages/rules-engine/dist/index.js`, so **build first** and rebuild after any
engine or deck change:

```sh
pnpm --filter @grimore/rules-engine build
```

Every one of them is deterministic: the same seeds play the same games, which is what makes two
arms comparable at all. They take no database and no server — just the engine.

**Count the action, not the stack.** A harness that walks `stackOrder` between actions sees only the
objects somebody held priority over: with `autoPass: true` an object nobody wants to answer is put
on the stack and resolved *inside the same `applyAction`*. `graveyard-costs.mjs` read the stack for
its first three months and was wrong by about a factor of eight — 17 escaped Woe Striders across 288
games where `cast-counts`, which counts the action, reads 23 in 48 (D203). If what you want to count
is something a player *did*, count the action; the stack is only safe for things the engine puts
there itself, such as a triggered ability.

**How many seeds a question needs depends on whose question it is.** A deck's *record* against the
field moves with every game, so twelve seeds of 288 duels is a usable number. A single *card's*
usage does not: the subject deck is shuffled once per seed per seating, so `SEEDS=4` is eight
library orders in total, and a card that happens to sit deep in all eight is drawn in almost no
games and reads as dead. That happened on the first run of `cast-counts` for a Boon Satyr — "in
hand 4 games" at four seeds, 66 of 288 at twelve, same card and same build (D196). For a per-card
question use twelve seeds or more, and read the "in hand" column before believing the rate beside
it.

| | question | run it |
| --- | --- | --- |
| `deck-table.mjs` | how does every deck do against every other? | `SEEDS=12 SEED0=4400 node scripts/measure/deck-table.mjs` |
| `deck-probe.mjs` | what would this slot change be worth? | `SUBJECT=tidal-mind CHANGE='Fog Bank:+1,Cancel:-1' SEEDS=17 node scripts/measure/deck-probe.mjs` |
| `deck-probe.mjs` | is this slot bad, or badly played? | `BOT='{"sparesItsOwnBoard":false}' SUBJECT=skyward-writ CHANGE='Terminus:-1,Leonin Skyhunter:+1' SEEDS=12 node scripts/measure/deck-probe.mjs` |
| `deck-probe.mjs` | what is the **commander** worth? | `SUBJECT=dawn-tithe COMMANDER='Balan, Wandering Knight' SEEDS=15 node scripts/measure/deck-probe.mjs` |
| `cast-counts.mjs` | which of a deck's sixty cards does the bot actually use? | `SUBJECT=tidal-mind SEEDS=6 node scripts/measure/cast-counts.mjs` |
| `cast-counts.mjs` | …and **which cost** did it pay — the printed one, or the evoke, dash, bestow, spectacle, overload, flashback or foretell? | `SUBJECT=tidal-mind SEEDS=12 node scripts/measure/cast-counts.mjs` (the block under the table) |
| `energy.mjs` | does the bot **spend** the energy it is given, or sit on it? | `SUBJECT=kindle-grove SEEDS=12 node scripts/measure/energy.mjs` |
| `cast-counts.mjs` | …and how often does it press *this* button? | `SUBJECT=delta-bloom CHANGE="Kiora's Follower:+1,Rampant Growth:-1" SEEDS=6 node scripts/measure/cast-counts.mjs` |
| `bot-duel.mjs` | what is this change to the *opponent* worth? | `TESTED='{"lookahead":false}' SEEDS=3 node scripts/measure/bot-duel.mjs` |
| `disagree.mjs` | does that change alter any decisions at all? | `TESTED='{"lookahead":false}' SEEDS=2 node scripts/measure/disagree.mjs` |
| `step-drift.mjs` | how far does the table move on one action? | `SEEDS=2 node scripts/measure/step-drift.mjs` |
| `morph-use.mjs` | which half of a morph does the bot take, and does it follow through? | `SEEDS=3 node scripts/measure/morph-use.mjs` |
| `combat-triggers.mjs` | do the block and unblocked triggers ever happen, and do they matter? | `SEEDS=6 node scripts/measure/combat-triggers.mjs` |
| `delayed-triggers.mjs` | do the scheduled abilities fire, and what does the bot blink? | `SEEDS=6 node scripts/measure/delayed-triggers.mjs` |
| `monarch.mjs` | who takes the crown, how long it is held, and what it drew | `SEEDS=6 node scripts/measure/monarch.mjs` |
| `poison.mjs` | is the poison win condition reached, or only theoretical? | `SEEDS=6 node scripts/measure/poison.mjs` |
| `pod-duel.mjs` | is a bot setting worth anything in a **four-seat pod**? | `ALWAYS=dawn-tithe TESTED='{"chaseTheCrown":false}' SEEDS=3 node scripts/measure/pod-duel.mjs` |
| `halves-use.mjs` | which face of a two-faced card gets used, and was the land the only one? | `SEEDS=5 node scripts/measure/halves-use.mjs` |
| `metalcraft.mjs` | how often is a conditional static actually **on**? | `SEEDS=5 node scripts/measure/metalcraft.mjs` |
| `mill.mjs` | does the mill deck win by decking, and how close does it get? | `SUBJECT=hollow-tide SEEDS=6 node scripts/measure/mill.mjs` |
| `killed-by.mjs` | what took the last of this deck's life, on what turn, holding what? | `SUBJECT=tidal-mind SEEDS=6 node scripts/measure/killed-by.mjs` |
| `held-answers.mjs` | why is the counterspell still in hand — no mana, no target, or no nerve? | `SUBJECT=tidal-mind SEEDS=6 node scripts/measure/held-answers.mjs` |
| `held-answers.mjs` | …and what did the reservation rule change? (it is on by default, so this is the control arm) | `BOT='{"reserveForAnswers":false}' SUBJECT=tidal-mind SEEDS=6 node scripts/measure/held-answers.mjs` |
| `draw-triggers.mjs` | does "whenever you draw a card" fire in real games, and what does it add up to? | `SUBJECT=hollow-tide SEEDS=6 node scripts/measure/draw-triggers.mjs` |
| `graveyard-costs.mjs` | does the bot ever escape or delve, how many cards does it spend, and does the hate ever meet the cost? | `SUBJECT=arc-tempest SEEDS=6 node scripts/measure/graveyard-costs.mjs` |
| `graveyard-costs.mjs` | …and the costs out of a graveyard that are **abilities** rather than casts: does it ever unearth, embalm or eternalize? | `SUBJECT=dawn-tithe SEEDS=12 node scripts/measure/graveyard-costs.mjs` (the last block) |
| `infect-clock.mjs` | of the infect creatures it could attack with, how many does it send? | `SUBJECT=blight-vector SEEDS=6 node scripts/measure/infect-clock.mjs` |
| `creature-fate.mjs` | what takes its creatures away, and how long do they live? | `SUBJECT=blight-vector SEEDS=6 node scripts/measure/creature-fate.mjs` |
| `wasted-plays.mjs` | which of the bot's plays bought nothing at all? | `SEEDS=4 node scripts/measure/wasted-plays.mjs` |
| `hidden-info.mjs` | does the computer opponent read what it cannot see? | `SEEDS=2 node scripts/measure/hidden-info.mjs` |
| `offers.mjs` | what does the engine offer you to cast — a cascade hit, a madness card, a **miracle** off the top — and is it taken? | `SUBJECT=arc-tempest SEEDS=12 node scripts/measure/offers.mjs` |
| `storm.mjs` | how many spells does a turn actually hold, and what was the count on each storm spell? | `SUBJECT=arc-tempest SEEDS=4 node scripts/measure/storm.mjs` |
| `dredge.mjs` | is a dredge ever offered, is it taken, and how short does the library get? | `SUBJECT=rot-harvest SEEDS=4 node scripts/measure/dredge.mjs` |

`hidden-info` asks the fairness question, and it is the one no win rate answers: it puts the same
position to the bot twice, the second time with **every card the acting seat cannot identify dealt
out again** — another seat's hand, every library, the card under somebody else's face-down
permanent — and compares the two answers. What counts as hidden is `viewFor`'s own redaction rather
than the harness's opinion, and the scramble only permutes `defKey`s inside one seat's hidden pool,
so hand and library sizes (which are public) never move.

Read two numbers, not one. The second line of the output says how many card identities the
scrambles actually moved, because a zero in the column that matters means nothing if the scramble
did nothing. And its sensitivity is bounded: a deliberate cheat wired in as a control — refuse to
attack whenever an opponent holds a Lightning Bolt — showed up as **26 of 764 attack declarations**,
so a leak about one rarely-hidden card is visible but not loud. A difference is a **suspect**, not a
verdict: a card whose own text reads a hidden zone would show up too, which is why the output names
the position.

`offers` is the instrument for the two keywords that read better than they measure, and it watches
the machinery they share — the engine stopping the table to say "you may cast this". For madness it
answers the only question that matters about the card: whether the mana was up when the discard
happened. For cascade: A free spell off the
top of a sixty-card deck is a free spell twenty-three times out of sixty-ish lands, and the output
is the distribution that says which: how many cascades fired, how many cards came off the library
each time (the hit included), what the hit was by name, and whether the offer was **cast or
declined** — the bot declines whenever there is no legal way to cast the card, which is the gap
between what the keyword offers and what it is worth. It watches `pendingFreeCast` in the state
rather than the log, so a cascade answered inside one action cannot hide from it, and it counts
casts of cascade cards separately so a cascade that read the whole library and found nothing shows
up as the difference.

`storm` answers a question about the *pool* rather than about a card, and that is why it is worth
keeping after the card that prompted it: how many spells a turn of this format actually holds. The
answer is the second table in its output — 42% of turns hold no spell at all, 37% hold one, 18% hold
two and 3% reach three — and it bounds every card that multiplies by a turn's spell count. The first
table is the card's own number, read off `StackObject.castNumber` (the snapshot taken as the spell
was cast, not the live total), and the first reading was **7 of 7 at nought**: every Grapeshot the
bot cast was the first spell of its turn. That is not a sequencing mistake, which is the thing the
instrument was then used to rule out: asked a position with a Grapeshot and a Lightning Bolt and
three mana, the bot casts the Bolt first already.

`wasted-plays` is the generic form of a question sixteen bot rules had each answered once, by
hand: a ritual into nothing, a Fog with nothing attacking, a pump that wears off, removal with
nothing to remove, a Naturalize aimed at its own board. It fingerprints everything a player would
call value — life, poison, permanents, power, toughness, counters, granted keywords, untapped
permanents, every zone's size — before each cast and activation and again once the stack has
drained, and reports the plays where nothing in it moved. Read it as a list of **suspects**: its
five blind spots are information, later, denial, mana in the pool and where a bonus is, and they
are documented in the file's own header. `SUBJECT=arc-tempest` narrows it to one deck's plays.

`creature-fate` takes a `KEYWORD` as well — `KEYWORD=infect` counts only the creatures that carry
it, which is `infect-clock`'s population measured the other way round. Two of its columns are worth
reading with their caveats in hand. **Where they went** is read in the first state after the
creature left the battlefield, so a deck running its own graveyard hate turns its own deaths into
exiles (Blight Vector's Planar Void does exactly that, which is why 32% of its creatures end in
exile). And a cause is attributed to the **one** stack object that resolved on the action: when a
single pass resolves several, the harness says so in its own bucket rather than guessing, because
whichever end of the stack you read is wrong about half the time.

`COMMANDER` answers the one question this instrument could not ask. Every deck's write-up calls its
commander "the half a deck list cannot be" and until D136 that was a claim rather than a number.
Point it at a legend whose text is **dead** in the subject deck — Balan, Wandering Knight in a deck
with no Equipment is a plain 2/2 double striker — and the gap between the two arms is what the real
commander is worth. It is the only lever here that is not a card in the sixty.

`cast-counts` takes a `CHANGE` as well, with the same grammar, and hands the variant list to the
engine the way a pasted decklist arrives — so "what does a second copy do to how often the bot uses
it" is askable without a commit. D143's two-copy row is that invocation. Its `used` column is the
number to read for an activated ability: `cast 47 + used 164` is one card cast forty-seven times
and its ability pressed a hundred and sixty-four.

A `CHANGE` is `Name:+1,Other:-1` — or `Name:+1;Other:-1` when a name has a **comma** in it, which
every legendary creature's does. A `;` anywhere in the string makes `;` the separator for the whole
of it; without that, `Nissa, Voice of Zendikar:-1` splits into two names the probe cannot find.

A `CHANGE` has to keep the deck at sixty cards, and `deck-probe` says so rather than quietly
measuring deck size instead of the change: a name it cannot find in the subject deck is looked up
anywhere in the pool, and a `-1` on a card the deck no longer runs subtracts nothing.

**"Anywhere in the pool" means anywhere in the ten deck lists**, which is the one thing this
harness cannot do for a card that is *new*: its definition lives in `starterDecks.ts` but nothing
runs it yet, so `defNamed` cannot find it and the probe refuses the change. The way round is exact
rather than approximate, and it is the recipe every new card should be priced with:

```sh
# 1. Put the card in the list and rebuild.
# 2. Measure taking it back OUT, which is the same pair of lists with the labels swapped:
SUBJECT=arc-tempest CHANGE='Arc Lightning:-1,Shock:+1' SEEDS=15 node scripts/measure/deck-probe.mjs
# 3. Negate the sign. "variant is -9" means the card is worth +9.
```

A registry of every card in the pool would let step 2 read the other way round, and is deliberately
not here: it would be a second list of two hundred and eighteen names to keep in step with the
first, to save a sign flip. See D138.

## Reading the numbers

**The noise floor is about eighteen games in two hundred and forty.** It was established by running
changes that cannot matter and watching them move the record anyway (see D108 and D110). A change
worth less than that is a change this instrument cannot price, and the discipline is to revert it
and write down that it measured as nothing — not to keep it because the sign looked right.

**A change to the bot is measured against the bot, not against a field.** That is what
`bot-duel.mjs` is for, and its negative control — two identical bots — came back exactly level at
56-56 of 112. Run that control whenever you touch the harness: a paired design with no seat bias and
no matchup bias is what makes a six-game difference readable instead of arguable.

**A term can change the bot's mind and still win nothing, and both halves have to be reported.**
The contextual evasion term (D164) is the cleanest case this project has: `disagree.mjs` said **83
of 30,176 decisions differed**, so it was firing; `bot-duel` said 467-469 and 470-464 at one weight,
471-465 and 468-468 at two others, against a negative control of exactly 468-468. Level at every
weight that changed anything, and **8% slower** on identical arms over identical seeds (157s against
169s). A term that is level and free might be kept; a term that is level and costs time is a delete,
and the numbers go in the log so nobody builds it twice.

**A flat `bot-duel` result is not a wash until `disagree.mjs` says the setting changed something.**
A level scoreboard means one of two unrelated things — the choices changed and were worth nothing,
or nothing changed — and only the disagreement rate tells them apart. D117 came back level and
turned out to change 10% of attack declarations; calling that "a wash" without checking would have
been wrong about what was measured.

**Run two seed sets, not one.** `SEED0=3300` and `SEED0=8800` are the two used so far. A change
that helps on one and not the other has not been measured; it has been sampled once.

**And the floor is not the same height for every deck.** Eighteen games in two hundred and forty was
established on decks in the middle of the table. Tidal Mind, at the bottom, returned +11 and -10 for
one card and then +5 and -2 for a different cut of the same card — while its *unchanged* list came
back two games apart on the same two sets (D131). A deck that wins 29% of its games wins most of
those narrowly, so one slot moves more of them in both directions. Treat a result from the bottom
of the table as needing more games than one from the middle, or treat it as unknown and say so.

**A card with two ways to cast it needs more than a cast count.** `cast-counts.mjs` reads a morph
at 107% and says nothing about whether the mechanic was ever used, because every one of those casts
could have been the printed cost. `morph-use.mjs` is the split, and the number that matters in it is
not how often the bot casts face down — it is how often it then **turns the card up**, because a 2/2
that stays down for the rest of the game is three mana spent on a card the bot forgot about.

**A card with two castable faces needs the same split, and one more number.** `halves-use.mjs` is
`morph-use` for split cards and adventurers, and it has earned its keep twice already. Wax // Wane
reads 23 casts in 660 games and looks fine; the split says **Wax 23, Wane 0** — a "destroy target
enchantment" half that is never castable in a pool with four enchantments in it, so the card is a
one-mana +2/+2 wearing a second name. And for an adventurer the honest number is not how many
adventures were cast, it is **how many creatures came back out of exile**: Garenbrig Carver is 65
adventures and 62 returns, which is the mechanic working, while a card at 65 and 9 would be a
sorcery that had quietly eaten a creature.

**For a modal card the question is not "which half" but "was the other one needed".** The back face
of a modal double-faced card is a *land*, so a split of the uses says almost nothing on its own —
50/50 is what a reasonable bot does with a card that is a removal spell when there is something to
kill and a land when there is not. The number that means something is the one beside it: **how many
of those land plays were made with no other land in hand**. Hagra Mauling reads 30 spells, 30 lands,
and **30 of 30 land plays with nothing else to play** — thirty land drops the deck would otherwise
have missed, which is the whole argument for the card. A reading of, say, 12 of 30 would be the
opposite finding: a bot spending a flexible card as a tapped land while an untapped one sat in hand.

**A card whose text is conditional can be cast every game and still never do what it says.**
`cast-counts` reads Chrome Steed at 50% and `deck-probe` says the deck won nine more games; neither
can say whether "+2/+2 as long as you control three or more artifacts" was ever live.
`metalcraft.mjs` samples the condition once per turn for every such permanent on the board, and
reports the **mean count** beside the share — because 56% on a mean of 2.6 artifacts ("nearly
there, often") and 56% on a mean of 0.8 ("never close, occasionally lucky") are the same percentage
and two different cards to fix.

**A 1-of's denominator in `cast-counts` is a handful of shuffles, not a handful of games.** The seed
drives the shuffle, so twelve seeds against eleven opponents in two seats is 264 games built from
about two dozen distinct libraries — and whether a single copy sits near the top or near the bottom
of those is most of its "in hand" count. Measured: at `SEEDS=4` two 1-ofs in the same deck read "in
hand 54 games" and "in hand 4 games", which is a fact about four shuffles rather than about the
cards; at `SEEDS=12` the same pair read 84 and 29. **Read the rate (cast ÷ in hand), not the
denominator**, and distrust a 1-of's row at fewer than a dozen seeds.

**And an instrument that cannot see a mechanic prints zero for it.** `cast-counts` reads Forge
Alliance's **Disrupt Decorum at 0% — never cast in 24 games it was in hand** — which looks like the
deadest card in the pool and is nothing of the kind: goading every creature you do not control is a
pod card, this harness plays duels, and with one opponent there is nobody else for a goaded creature
to attack. It was left in the deck for that reason — a cut made on this
reading would have taken the pool's only goad card out for being unmeasurable rather than for being
bad. The same trap in a different instrument is the "an instrument that cannot observe the thing
reports zero" note below.

**A half nobody casts is not automatically a bad card.** The same Wax // Wane that never casts one
of its halves measured **+19 of 264** against the field, because the half it does cast is better
than the card it replaced. "This half is dead" and "this card is bad" are two different findings and
this instrument only produces the first; `deck-probe` produces the second.

**Two decks can want opposite things from the same number of extra turns, and only a contrast
shows it.** `killed-by.mjs` put the worst deck in the pool beside the best, same instrument, same
field:

| | Tidal Mind (28%) | Ember Rush (80%) |
| --- | --- | --- |
| wins on table turn | 27.6, with 21.2 life | **15.5**, with 15.6 life |
| loses on table turn | 23.1 | 19.1 |
| cards still in hand when it dies | **3.5** | 1.1 |
| deaths to combat damage | 76% | 93% |

Tidal Mind's games run **twelve table turns longer** than Ember Rush's wins and it is still holding
three and a half cards when they end. It does not lack time and it does not lose to spells — it
cannot convert the time into a win. Which is why the fix that moved Hollow Tide seven points
measured **nothing** here: a third blocker is worth something to a deck that turns turns into a win
condition, and nothing at all to one that does not. Both blocker adds priced against Tidal Mind's
weakest shared slot came back **−2 and +4 of 288**. Read the two rows together before deciding what
a deck is short of.

**Instrument the mechanism and the record will explain itself.** `mill.mjs` was written to answer
one question — does Hollow Tide ever actually deck anybody — and the answer came with the deck's fix
attached. Half its wins were already empty libraries (23 of 48) and it milled 18 cards a game, but
**the opponent's library was still at 24 on average when the game ended**: the plan worked and the
clock did not, so the deck needed *turns* rather than more mill. A third Fog Bank for an Essence
Scatter measured +16 and +23 of 288 on two seed sets, and the instrument then showed the mechanism
rather than just the number — mill a game 18.0 → **22.1**, the library at the end 24.3 → **19.9**,
games it decks somebody 16% → **28%**, wins by library 23 → **40**. A win-rate alone would have said
"seven points better" and nothing about why.

**And measure the two candidate adds against the same cut, then distrust the difference.** The same
run priced a fourth Mind Sculpt (+12) against the third Fog Bank (+16) **with the same card cut in
both arms**: four games apart, which is deep inside the floor. So the honest reading is that most of
the gain is the cut, and "more mill or more time" is a question those two probes cannot separate —
even though the instrument above makes a strong case for one of them.

**Measure the cut as well as the card.** A `CHANGE` is two halves and the instrument prices the
pair, so a result that looks like "this card is bad" is often "that cut was bad". D127 is the case:
the same two cards added to the same deck measured 13 and 8 games *down* when they replaced the
deck's cheapest answer and 1 down and 7 up when they replaced a three-mana removal spell instead.
If a slot change measures worse than it should, re-run it with a different card removed before
concluding anything about the card added. **It has now happened three times** — D129's Elf lord went
from (+2, -8) to (+4, +13) on the same two seed sets by taking a redundant third copy of a creature
instead of the deck's only protection spell, and D133 is the widest: Guardians of Akrasa measured
(-2, +1) cutting Skyward Writ's Wall of Air and **(+17, +16)** cutting its Negate — one card, two
cuts, seventeen games, with the better arrangement landing on the instrument's own floor. Treat
measuring the cut as half of what a slot change is, not as an extra step taken when the first number
disappoints.

The corollary is a sharper way to pick the cut than "whatever is least cast". Both wrong cuts in
D129 and D133 removed the deck's *only* copy of a thing it needed — a protection spell, a flying
blocker — while the right cuts removed something the deck had another answer for. `cast-counts.mjs`
ranks by how often a card is used and cannot see that difference, so read its bottom five and then
ask which of them the deck would still be fine without.

**Build first, and let the build finish before launching anything.** Every harness here reads
`packages/rules-engine/dist/index.js`, so a probe started while `pnpm --filter @grimore/rules-engine
build` is still running measures the *previous* deck lists and says nothing about it. The one tell is
`deck-probe`'s own size warning — "the two lists are not the same size" means the `CHANGE` named a
card the stale `STARTER_DECKS` did not have, which is how this was caught rather than published.
Treat that warning as "stop and re-run", never as a rounding error.

**A `deck-table` percentage is a statement about a field, not about a deck.** Adding Arc Tempest
moved four of the other eight decks by three to six games with **not one card of theirs changing**
(D128): Tidal Mind down six, Skyward Writ up five. So a percentage from a run with a different
number of decks in it is not comparable to a current one — re-run the table rather than quoting the
old row, and never read a deck's own move across such a boundary as a change in that deck.

**Read `deck-probe`'s per-opponent split before believing the total.** A trim that wins ten games
each against the slow decks and none at all against the fast ones is a change about having a clock,
whatever the total says — and that is exactly what happened the one time the total was trusted on
its own.

**An instrument that cannot observe the thing reports zero, and zero reads like an answer.**
`combat-triggers`' first version watched for `step: 'untap'` to see whether a freeze had held, and
nobody ever holds priority in the untap step (CR 502.1) — no state it saw was ever at that step, so
the check could not have fired once. It printed 46 freezes and 0 held, and the only reason that was
caught is that it is not a story about Magic. Before believing a zero from a new harness, make it
print the thing it is counting *from*, and check the two numbers can be true together.

**A deterrent cannot be measured by counting what happened.** Thicket Basilisk's clause fired three
times in 42 games it was on the battlefield, and the card is not dead: a creature that destroys
whatever it fights changes which attacks get declared, and an instrument that counts resolutions
sees none of that. When a mechanism's whole point is to stop something, say what you measured —
"the clause fired three times" — and say plainly that what it was worth in attacks nobody made is
not in the number.

**Ten matchups all pointing one way is evidence a total cannot give.** Palace Sentinels came back
+15 of 240 — under the 18-game floor — with eight of ten matchups the deck's way and two level, none
against. The floor is derived for a single total; a sign test across ten paired matchups is a
different question and a sharper one (p≈0.004 here). Read the split before deciding a sub-floor
total means nothing.

**Do not rebuild `dist/` while a measurement is running.** These harnesses import the built engine,
and a loop like `for S in 3300 8800 5500; do ... node scripts/measure/bot-duel.mjs; done` starts a
*fresh* node for each seed set — so a `pnpm --filter @grimore/rules-engine build` in the middle of
it leaves the finished sets measuring one version of the rule and the rest measuring another, with
nothing in the output to say so. The already-running process is safe, because it loaded the module
at startup; the next one in the loop is not. Finish the run, then edit.

**A window `legalActions` would not have offered is still a window, and the harness has to move
priority to see it.** `held-answers` asked where a counterspell's windows went and the first version
saw almost nothing: across 24 games there were 163 moments with an opponent's spell on the stack and
the subject seat was offered priority in **three** of them. Auto-pass is why — it passes for a seat
whose only legal move is to pass, inside the same applied action — so the 160 moments it could not
see were exactly the ones it existed to explain. The fix is to put the question to the engine with
`priority` moved to that seat on a local copy of the state: *if you were asked now, what would you
offer and what would you refuse?* Nothing is applied. Any instrument that reads `legalActions` for a
seat that is not the one acting needs the same trick, and an instrument that does not do it will
print a confident zero.

**The unit a harness counts in is a claim about the engine, and it has to be said out loud.**
`held-answers` counts one window per (opponent's spell on the stack, answer in hand), which is the
right unit for *could this card have been cast* and the wrong unit for *what did this seat decide* —
and the column everybody reads is the second question. Two kinds of non-decision ended up in it, and
both inflated it: a hand holding two answers facing one spell is two windows, so casting either left
the other recorded as affordable and passed over (**26 of Skyward Writ's 31 "declines" were `cast
Counterspell`**), and a (spell, answer) pair is usually *first* seen on a move this seat was not
making, which was never a decision at all (**8 of Tidal Mind's 14**). They are now `covered` and
`unseen`, their own columns, and the numbers D168 published off the four-bucket version are
corrected there. Before publishing a bucket, ask what one row of it is a row *of*.

**`bot-duel`'s total is not diluted by the decks a rule cannot touch, and that is worth knowing
before narrowing it.** A rule that only fires for the five decks holding counterspells looks like it
should be measured on those five, and the instinct is wrong: the harness plays each ordered pairing
twice with only the bots swapped, so a pairing where the rule is inactive for *both* arms is the
**same game twice** on the same seed — one win credited to each arm, zero variance added. That is
why the negative control is exactly 468-468 rather than approximately. So leave the field alone: the
difference between the arms already comes only from the games the rule changed. What narrowing the
deck list *would* do is break the pairing, because the cancellation is what makes a matchup
disappear.

**`pod-duel`'s negative control is arithmetic and must not be read as a floor.** With both arms
identical, all four rotations of a table are the same game, so the winning seat is credited to each
arm exactly twice — 66-66 of 132, by construction. Get a floor by running a *real* arm on two
disjoint seed sets: "chase the crown" came back 70-62 and then 62-70, which is how we know this
harness wobbles by at least ±8 games in 132. Do not believe a smaller pod result than that.

**Four seed sets, not two, before believing a `deck-probe` result near the floor.** The best of
twelve single- and two-slot probes at Tidal Mind came back **+6, +37, +23 and −6 of 288** — two of
those four would have shipped it, and two would have buried it. The same four seed sets measure the
*unchanged* list at 83, 64, 88 and 90 wins, which is the honest floor for a twelve-opponent 288-game
aggregate: about twenty games, and the per-seed-set spread is the way to see it. Two seed sets are
enough to kill a change; four are what it takes to ship a small one.

**And a change too small to measure may still be the wrong size rather than the wrong change.** Each
half of Tidal Mind's six-slot rebuild reads +8/+20 and +12/+19 — both inside that floor — and the
whole thing reads +47/+38. The halves are not wrong about their halves; a deck whose problem is its
*shape* has no three-card version of the fix, so probing one slot at a time can only ever return
noise. When a dozen probes in a row come back flat, ask whether the question is the wrong size
before concluding the deck is fine.

**Before cutting a card, check whether the pool has another copy.** `defKeyFor` registers one script
per card name and a test asserts every script has a real card behind it, so cutting the pool's last
copy of a card deletes that script's only coverage. Nineteen of Tidal Mind's forty-one slots were the
pool's only copy, which is what had bounded three balance passes before anybody noticed. The way out
is to move the card to a deck that wants it rather than to keep it in a deck that does not:
```
node -e "const {STARTER_DECKS}=require('./packages/rules-engine/dist/index.js');
const n='Twincast';
console.log(Object.entries(STARTER_DECKS).filter(([,d])=>d.cards.some(e=>e.card.name===n)).map(([i])=>i))"
```

**The deck list lives in the registry, not in the harness.** Seven of these files used to write it
out by hand, and the first `deck-table` run after the twelfth deck was added measured the same
eleven-deck field as the day before with no warning at all. They all read
`Object.keys(STARTER_DECKS)` now; keep it that way, because a measurement that silently answers last
week's question is worse than one that fails.

**A keyword's name is the last word of the sentence, and the last word is what a harness matches
on.** `offers.mjs` asked the *script* whether a card has cascade, by looking for a trigger that
fires on its controller casting it — which is the shape cascade, storm, replicate and conspire all
share, so every Grapeshot in Arc Tempest counted as a cascade and the line "60 of 62 found nothing
at all" was printed about a deck holding no cascade card. The browser driver made the mirror-image
mistake on the other side of the same keyword family: it cut the offer's prompt at eighty
characters for the log, and the prompt is 88 — so `LIST=miracle` matched none of its own offers,
because `(miracle)` had been thrown away. **Both were found by a number that was obviously wrong
rather than by a failing check.** Where a keyword can only be told from its siblings by the card's
own text, read the card's own text, and never truncate the string a scenario asserts on.

**Ask whether a slot is a bad card or a badly played one, because the answer is sometimes both.**
`deck-probe` takes `BOT` now for exactly this: Terminus cost Skyward Writ 32 and 29 games of 288
with the bot casting every one it was offered, and 24 and 12 with `sparesItsOwnBoard` on (D205). A
third of that slot was the bot. The probe's *other* arm is the check that the rule is as narrow as
it claims — the list with the sweeper cut comes back byte-identical with the rule on and off.

**What a slot is worth is a fact about the card that pays for it, not about the card.** Pyromatics
in Arc Tempest measured **−10 and −19** of 288 in the Firebolt's slot and **+1 and +1** in the second
Think Twice's — same card, same deck, same two seed sets (D207). Both readings are right, and a
probe run once against one filler would have concluded something about the keyword that was wrong
either way round. When a slot comes back negative, re-run it against a *different* card of the
deck's before concluding anything about the card that went in.

**Count what the bot actually paid, not only what it cast.** The replicate count was dropped on the
way from the chosen play to the action sent, so the bot cast Pyromatics 49 times in 96 games and paid
the replicate cost **zero** times — with no refusal, no failing test and no stuck game, because a
cast with the count missing is a legal cheap cast. A twenty-line script that counted `action.replicate`
by value found it in one run. Every announced number and every cost flag is worth that script the
first time a card uses it; `scripts/measure/offers.mjs` is the permanent version of the same idea for
the offer family.

**A card that only works from one zone is worth nothing until something puts it there — and that is
a question about the deck, not about the keyword.** Dredge's first card here was a dredge *land*, and
`dredge.mjs` said it was offered **three times in 96 games**: a dredge card does nothing except from
a graveyard, and nothing in this pool destroys a land. The same keyword on a 2/2 that sacrifices
itself, in the deck with two sacrifice outlets in it, was offered **137 times**. Before measuring
what a keyword is worth, measure how often the card gets to use it — a slot probe on the land would
have read as nothing and the honest reading of that nothing is "this card never happened", which is
not a fact about dredge.
