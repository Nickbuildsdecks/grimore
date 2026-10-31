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
| `deck-table.mjs` | …and the same table with **one deck's list changed**, which is the step a probe owes | `SUBJECT=verdant-guard CHANGE='Wolfir Silverheart:-1,Secure the Wastes:+1' SEEDS=12 SEED0=4400 node scripts/measure/deck-table.mjs` |
| `deck-probe.mjs` | what would this slot change be worth? | `SUBJECT=tidal-mind CHANGE='Fog Bank:+1,Cancel:-1' SEEDS=17 node scripts/measure/deck-probe.mjs` |
| `deck-probe.mjs` | is this slot bad, or badly played? | `BOT='{"sparesItsOwnBoard":false}' SUBJECT=skyward-writ CHANGE='Terminus:-1,Leonin Skyhunter:+1' SEEDS=12 node scripts/measure/deck-probe.mjs` |
| `deck-probe.mjs` | what is the **commander** worth? | `SUBJECT=dawn-tithe COMMANDER='Balan, Wandering Knight' SEEDS=15 node scripts/measure/deck-probe.mjs` |
| `cast-counts.mjs` | which of a deck's sixty cards does the bot actually use? | `SUBJECT=tidal-mind SEEDS=6 node scripts/measure/cast-counts.mjs` |
| `cast-counts.mjs` | …and **which cost** did it pay — the printed one, or the evoke, dash, bestow, spectacle, overload, flashback or foretell? | `SUBJECT=tidal-mind SEEDS=12 node scripts/measure/cast-counts.mjs` (the block under the table) |
| `energy.mjs` | does the bot **spend** the energy it is given, or sit on it? | `SUBJECT=kindle-grove SEEDS=12 node scripts/measure/energy.mjs` |
| `cast-counts.mjs` | …and how often does it press *this* button? | `SUBJECT=delta-bloom CHANGE="Kiora's Follower:+1,Rampant Growth:-1" SEEDS=6 node scripts/measure/cast-counts.mjs` |
| `bot-duel.mjs` | what is this change to the *opponent* worth? | `TESTED='{"lookahead":false}' SEEDS=3 node scripts/measure/bot-duel.mjs` |
| `bot-duel.mjs` | …the same question six times faster, for a rule only one deck can fire | `SUBJECT=skyward-writ TESTED='{"blinksWell":false}' SEEDS=6 node scripts/measure/bot-duel.mjs` |
| `bot-duel.mjs` | …price a term that changes no decision anyway, past the pre-flight that refuses to | `ALLOW_INERT=1 TESTED='{"holdsNinjas":false}' node scripts/measure/bot-duel.mjs` |
| `disagree.mjs` | does that change alter any decisions at all? | `TESTED='{"lookahead":false}' SEEDS=2 node scripts/measure/disagree.mjs` |
| `step-drift.mjs` | how far does the table move on one action? | `SEEDS=2 node scripts/measure/step-drift.mjs` |
| `morph-use.mjs` | which half of a morph does the bot take, and does it follow through? | `SEEDS=3 node scripts/measure/morph-use.mjs` |
| `combat-triggers.mjs` | do the block and unblocked triggers ever happen, and do they matter? | `SEEDS=6 node scripts/measure/combat-triggers.mjs` |
| `delayed-triggers.mjs` | do the scheduled abilities fire, and what does the bot blink? | `SEEDS=6 node scripts/measure/delayed-triggers.mjs` |
| `monarch.mjs` | who takes the crown, how long it is held, and what it drew | `SEEDS=6 node scripts/measure/monarch.mjs` |
| `poison.mjs` | is the poison win condition reached, or only theoretical? | `SEEDS=6 node scripts/measure/poison.mjs` |
| `pod-duel.mjs` | is a bot setting worth anything in a **four-seat pod**? | `ALWAYS=dawn-tithe TESTED='{"chaseTheCrown":false}' SEEDS=3 node scripts/measure/pod-duel.mjs` |
| `pod-slot.mjs` | is a **deck slot** worth anything in a four-seat pod, for a card that is blank in a duel? | `SUBJECT=forge-alliance CHANGE='Blade of Selves:-1' node scripts/measure/pod-slot.mjs` |
| `pod-pace.mjs` | how fast is the engine itself, when a browser suite blames the bots for being slow? | `SEATS=4 GAMES=3 node scripts/measure/pod-pace.mjs` |
| `pod-pace.mjs` | …and **what does a bot setting cost in milliseconds**, timed as an ablation on identical positions rather than as two races | `BOT='{"weights":{"castable":0}}' SEATS=4 GAMES=3 node scripts/measure/pod-pace.mjs` |
| `unfinished.mjs` | **does the engine ever throw mid-game?** Every harness here swallows one; this is the only thing that reports it | `SEEDS=6 node scripts/measure/unfinished.mjs` |
| `unfinished.mjs` | …and the same question for a **four-seat pod**, where a table with nobody to act (CR 800.4a) is the worse fault | `SEATS=4 SEEDS=12 node scripts/measure/unfinished.mjs` |
| `card-promises.mjs` | does every card **do what its own text says**, or does a script carry less than the card reads? | `node scripts/measure/card-promises.mjs` |
| `mechanic-coverage.mjs` | **how many cards hold each mechanic up** — which are on one card, and which the engine declares and nothing reaches? | `node scripts/measure/mechanic-coverage.mjs` |
| `eval-calibration.mjs` | **does the bot's evaluation predict who wins**, and which of its components carries the signal? | `SEEDS=6 node scripts/measure/eval-calibration.mjs` |
| `term-leverage.mjs` | **which of the evaluation's terms actually decide anything** — what changes when each is taken away? | `SEEDS=1 node scripts/measure/term-leverage.mjs` |
| `term-leverage.mjs` | …and measured where a term acts, rather than drowned in a field average | `SUBJECT=hollow-tide TERMS=library node scripts/measure/term-leverage.mjs` |
| `crack-back.mjs` | does a seat that **swings with its blockers** die to the attack that comes back? | `node scripts/measure/crack-back.mjs` |
| `halves-use.mjs` | which face of a two-faced card gets used, and was the land the only one? | `SEEDS=5 node scripts/measure/halves-use.mjs` |
| `transform-use.mjs` | does a **transforming** card ever turn over, on which turn, and into what board? | `SEEDS=6 node scripts/measure/transform-use.mjs` |
| `leaving-creatures.mjs` | a creature the bot **cannot see is leaving** — what does it decline, and what gets spent on it? | `SEEDS=6 node scripts/measure/leaving-creatures.mjs` |
| `countdowns.mjs` | a permanent with a **clock** on it — how many counters were left when it stopped being able to spend them? | `SEEDS=6 node scripts/measure/countdowns.mjs` |
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
| `deck-order.mjs` | does the order a deck's entries were written in change the games? (it did — D257) | `node scripts/measure/deck-order.mjs` |
| `granted-abilities.mjs` | when one permanent hands another a triggered ability, does it ever fire — and what is it handed to? | `SUBJECT=skyward-writ SEEDS=6 node scripts/measure/granted-abilities.mjs` |
| `hidden-info.mjs` | does the computer opponent read what it cannot see? | `SEEDS=2 node scripts/measure/hidden-info.mjs` |
| `offers.mjs` | what does the engine offer you to cast — a cascade hit, a madness card, a **miracle** off the top — and is it taken? | `SUBJECT=arc-tempest SEEDS=12 node scripts/measure/offers.mjs` |
| `storm.mjs` | how many spells does a turn actually hold, and what was the count on each storm spell? | `SUBJECT=arc-tempest SEEDS=4 node scripts/measure/storm.mjs` |
| `dredge.mjs` | is a dredge ever offered, is it taken, and how short does the library get? | `SUBJECT=rot-harvest SEEDS=4 node scripts/measure/dredge.mjs` |

**Pair your arms, or do not believe the difference.** Two canonical 288-game tables of the same
thirteen decks, differing only in which seeds they used, disagree by up to **thirty games** on one
deck (D257). So an *unpaired* comparison — today's table against a table from a previous commit, or
a stock table against a variant table — cannot resolve a one-card change, and one such reading
published a sign that the paired measurement reversed. What works is the same instrument, the same
seeds, the same canonically ordered lists, differing only by the change: `deck-probe` runs both arms
that way in one go, and `deck-table`'s `SUBJECT`/`CHANGE` is comparable to a `deck-table` run of the
stock list at the same seeds **because** both now canonicalise. `deck-order.mjs` is the regression
check on that last clause.

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

`blink-use` is also the instrument that set a bot rule on its own, which is worth noting because the
duel could not have: `blinksWell` reads +4, +2, −2 and +2 across four arms — inside the floor every
time and not even agreeing on the sign — while the instrument reads 4 bad blinks going to 0 and the
useful ones nearly doubling.
A rule that changes four choices in forty-eight games is a rule only a count of *what it chose* can
price. It asks the three questions a *friendly* optional target raises, which no instrument here
had asked before: is the trigger taken, what does it point at, and what did pointing there cost?
Every other optional target in the pool aims at the enemy, where a bad answer wastes a card;
Soulherder's end step aims at your own board, so a bad answer destroys one of your creatures — a
token blinked never comes back, and counters and attachments are gone (CR 400.7, CR 111.7). It reads
the bot's answer at the prompt rather than afterwards, because that is where the choice is and the
`exiled` list is drained by `settle` inside the same action.

**Which is worth knowing before trying to read that list from a harness.** Every event list on
`GameState` is drained inside the action that filled it, so a loop standing between actions sees it
empty every time — and an empty column looks exactly like "this never happens". The first version of
`blink-use` printed one. What works from outside is a consequence the board keeps: counters on the
Soulherder, compared against the blinks it was seen to take.

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

**And a card with a second *state* needs the same split asked of the state rather than the cast —
which is the one case in this family where the action stream is no use.** `transform-use.mjs` is
`morph-use` for a transforming card, and the mechanics differ in a way that decides the whole
design: a morph turning up is an **action** (`auto:turnUp`), so a harness can watch what the bot
does, while a transform happens inside an effect's resolution and is recorded in
`GameState.transformed`, which `settle` drains before anything outside the engine could read it. So
this one watches the **board** after every action and asks whether a permanent is now wearing a
different face.

Which brings its own trap, and it sprang on the first run. The file reported **two "flips back to a
front face" in a pool where no card flips back** — a result that, if real, would have been a bug in
the transform code shipped an hour earlier. It was the instrument: `relocate` restores the front
face on the way off the battlefield (CR 712.4a), so a transformed Insectile Aberration that is
bounced and recast arrives as a Delver of Secrets, and a detector that remembered the back face
across the two zones read a fresh cast as a permanent turning over. **The lesson is the one this
file keeps relearning from a new direction: a state-watching instrument has to forget state when
the thing it is watching stops existing**, and the tell was that the surprising number pointed at
somebody else's bug rather than at its own.

That column is now the standing check on the claim it falsified: D234 says the symmetric half of
`transformPermanent` is exercised by no card in the pool, and every run of this harness prints
whether that is still true, so the claim cannot quietly go stale.

**A clock on a permanent needs the same question asked of the counters rather than the card, and the
last counter coming off took an engine change to be observable at all.** `countdowns.mjs` reads how
many counters were left when a clock stopped being able to spend them, because a cast count cannot
say whether the promise printed on the card was ever kept: Thing in the Ice was cast forty-nine
times and flipped twice (D236), and that is either a deck that never gets there or a permanent that
dies first. **The distribution is the diagnosis rather than the mean** — one counter left is a
reshape (D156's shape) and four left is a cut — and a single average of 2.5 hides which you have.
For Thing in the Ice the answer was neither (D237): fourteen of twenty-one clocks still had all four.

It reads state rather than actions for `transform-use`'s reason, since nothing in the action stream
announces a counter coming off, and it keys on the **instance**, so a permanent that leaves and
comes back is a new clock rather than a continuation. That is what the rules say: a permanent that
changes zones is a new object with no counters on it.

Two traps, and both were caught by a number that could not be true. The first draft pinned a zone
per counter key, and `time` is **shared** between suspend, whose clock runs in exile, and vanishing,
whose runs on the battlefield; Calciderm read `ran out 0%`, impossible for an unanswered vanishing
creature, and that impossibility is what found it. The second was not the harness's fault and could
not be fixed here: three of the pool's four clocks **destroy or move their object on expiry**, and
counters are wiped on the way out, so "the clock ran out" and "somebody killed it holding its last
counter" leave an identical board. Those rows printed `?` and said so. The fix was in the engine
(D238) — `GameState.expired` is recorded where the last counter comes off and drained into the
persistent log — and the harness now asks the log instead of trying to infer it from the board.

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
difference between the arms already comes only from the games the rule changed.

**`SUBJECT` narrows it anyway, and the honest description of what that buys is *time*.** Dropping
the pairings a rule cannot touch removes games that contributed exactly nothing to the difference
and exactly nothing to its variance, so the number comes out the same and arrives six times sooner —
which is worth having, and is not a sharper reading. Two things to keep straight when using it:
quote the **difference** rather than the ratio, because the denominator moved; and remember it
drops the pairings of every deck you did not name, so a rule whose cards live in two decks is only
three-quarters priced by one subject. `blinksWell` was measured both ways for exactly that reason —
Soulherder is in Skyward Writ and Cloudshift is in Verdant Guard.

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

**Measure a bot rule with `bot-duel`, never by differencing two slot probes.** A probe prices a
*slot* — the deck with a card against the deck without it — and running it twice, once per bot
setting, does not turn it into an answer about the bot: each probe carries a ±20 floor, and the
difference of two of them carries both. D210 did exactly that and published "taking every dredge
costs 3 to 6 games of 288, four times out of four"; `bot-duel` then found every dredge configuration
**level within two games of 624**, and D212 withdrew the claim. The giveaway was available
beforehand: this harness's negative control is not approximately level, it is *exactly* 312-312, and
that is the property that makes two games readable and three-of-288 arguable.

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

**The second card to need that rule paid half its loss back.** Capsize in Tidal Mind measured **+23
and +12 of 288 against the deck** in the second Man-o'-War's slot and **+12 and +4** in the second
Thieving Magpie's (D211) — and the first of those is outside the floor, which is the reading that
would have been published as a fact about buyback. A Man-o'-War bounces a creature *and leaves a 2/2
behind*; "a bounce for a bounce" reads like the fair comparison and is not one. Prefer a payer that
does **one** thing.

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

**A bot answer written on a card cannot be priced with `bot-duel`, and saying so is better than
pricing it with the wrong instrument.** `ChoiceDecisionSpec.best` is how a card answers its own
question — extort's "pay", proliferate's choice of counters, echo's "pay or let it die" — and it
receives `(state, chooser)`. It cannot see `BotOptions`, so there is **no flag to vary**, and
`bot-duel` varies flags. The temptation is to reach for the slot probe instead and call the
difference a fact about the rule, which is exactly what D212 had to withdraw. What a slot probe can
honestly say about a card whose bot answer is fixed is "the slot is paid for"; the rule itself stays
unmeasured until the options are threaded into that call (D214). An unmeasured rule declared as such
costs nothing; a measured-looking number from the wrong harness costs a day.

**The cleanest payer is the one most likely to say no, and a slot reading outside the floor is an
instruction rather than a disappointment.** Sudden Shock against Arc Tempest's Lightning Strike is
the fairest comparison this project has run — same cost, same colour, same card type, same deck, a
damage fewer — and it came back **−22 and −17 of 288**, the first slot reading here outside the ±20
floor on the first try. The reflex is to re-price it against something weaker until the number looks
level. That is fine *as long as both readings are published*: the honest conclusion was "split second
is worth less than a damage in this pool, and the committed slot is a cantrip's at −1", not "split
second is level". A probe that only ever reports the flattering payer is D211's mistake with extra
steps.

**Grep the tests for the payer *and* the deck before the probe runs.** The pool-keeps-a-copy rule
(Tormod's Crypt, the second Sacred Cat) has a sharper version: a test can name a card in a
**particular deck's** graveyard or hand, because `arena()` places cards by finding them in that
seat's library. So a card can be safe to reduce from two to one and still unsafe to remove from one
list — Lava Spike is escape fodder named by deck in several arc-tempest tests, and looked like the
ideal payer right up to the point the suite went red. Checking costs one grep; not checking costs a
probe run and a rewrite.

**When a keyword never fires, count the *windows* rather than the activations.** Ninjutsu measured
**zero** activations in 48 bot games, and the first instinct — "the bot will not take the play" — was
wrong: asked directly on a board with a ninja in hand and an attacker through, it returns the
activation with the right creature named. What the zero was about took three counters at one
declare-blockers step, over 95 of them: an unblocked attacker 19 times, a ninja in hand **2** times,
and the two together **0**. The bot casts the card as a two-drop the moment it can, so it is never
there when the swap exists. One instrument, one run, and the difference between "the bot judges this
badly" and "the card is in the wrong zone" — which are different pieces of work with different fixes.


**A reading identical to the control needs a *positive* control before you call it level.** The ninja
holding rule came back **467-467 of 936** on `bot-duel`, which is exactly what the identical-bots
control returns — a number that could mean "the rule is level" or "the flag never reached the games".
One more run told them apart: `lookahead: false` on the same harness is **90-221 of 312**, so the
instrument is emphatically live and the rule really is level. The negative control (identical bots
scoring exactly even) proves the harness is *fair*; a positive control proves it is *connected*, and
they are different questions.


**A positive control proves the harness is connected, not that *this arm* is.** The lesson above is
right about the question and tests the wrong subject, and it took a second run of the same shape to
see it. `TESTED='{"castable":1}'` is a plausible-looking typo for `{"weights":{"castable":1}}` — a
weight lives under `weights`, not at the top level — and `botAction` ignores a `BotOptions` key it
does not know, which is correct for an options bag and silent. So the field was never set, **both
arms were the stock bot**, and three seed sets came back **467-467, 467-467, 466-466**: fifteen
minutes each to reproduce this file's own arithmetic negative control. `lookahead: false` would have
passed its positive control the whole time, because `lookahead` is a real field; what was broken was
one arm's key, not the instrument.

So `bot-duel` now asks the question per-arm and up front: both arms are handed the same ~2000
positions played by the shipping bot, and if **no decision ever differs** the run stops non-zero
before spending 936 games. A real arm is found in a second or two (`{"weights":{"castable":1}}`
disagrees by decision 71, a targeted spell against an X spell; `lookahead: false` by decision 10).
It is deliberately not a list of the keys `BotOptions` has — that is a second reader of a type that
already has one, and it would go quiet rather than wrong the next time the type grows (D260).

**And it cannot tell a typo from a window that never opens, which is a fact about the measurement
rather than a hole in the check.** `holdsNinjas` is a real field, read on every filter decision —
and it trips the guard, across all 13 pairings, because the ninja-in-hand-with-an-unblocked-attacker
window opened **0** times in 95 declare-blockers steps. Its 467-467 was a true reading of a rule
that almost never fires, and the guard would have said so in twenty seconds rather than fifteen
minutes. Both causes read as "no decision differed", so the failure message names both and the knob
for each: the field name for the first, `SUBJECT` and `PROBE_DECISIONS` for the second. If the probe
cannot find a disagreement, 936 games will not find one either, and the thing worth measuring is how
often the window exists at all.


**The same silence one level down, where it is cheap to break.** `term-leverage` nests correctly —
it builds `{ weights }` itself — but a misspelled *weight name* inside that object is dropped just as
quietly, and its symptom is a row reading `changed 0`, which is indistinguishable from a term that
simply never decides anything. The tell is the **score**: ask `evaluate` the same positions, and a
real weight moves the number even when it does not move the play. So every row that ends at zero now
says which it was — `scored and never decisive`, which is a finding about the game, or `never changed
the score in any of the N positions`, which is a name the evaluation cannot see. Proven by injecting
`{ castabel: 1 }` next to `{ castable: 1 }`: 7 decisions and 0, and only the second gets the warning.

**Two zeros, two diagnoses, one instrument.** Ninjutsu fired zero times and the Arcbound Ravager's
sacrifice ability fired zero times, and the fixes are nothing alike. Counting the **windows** told
them apart in one run each: ninjutsu had 19 unblocked attackers and 2 ninjas in hand and never both
— the situation never arose, a **zone** problem. The Ravager's row was **offered 437 times** and taken
**0** — the situation arose constantly and the bot declined, a **judgement** problem. "The keyword
never fires" is not a diagnosis; it is the question. Count how often the play was *available* before
deciding whether the bot or the card is at fault.


**Count the candidates, not only the windows — and count them on the arm where the rule is off.**
The lesson above got the Ravager half right: its row was offered 437 times and taken 0, which said
*judgement* rather than *zone*, and the rule moved it to 4. Asking why, the candidates were tallied
one by one — on the arm with the rule **on**, where the bot had already eaten the idle artifacts
before the tally saw them. It reported one idle Equipment in the whole run and the conclusion "there
is nothing to eat", which was the instrument reading its own effect:

| across 48 games | rule on | rule off |
| --- | --- | --- |
| windows the row was offered in | 434 | 437 |
| of those, nothing but the source itself on offer | 383 | **220** |
| other candidates, already attached | 89 | **191** |
| other candidates, idle | 1 | **104** |

**A filter changes the board it is measured on.** Any tally of what a rule *could* have chosen has to
be read with the rule off, or it describes the aftermath instead of the choice. The corrected reading
still turns a bot question into a deck question — all 104 of those idle candidates are unattached
Equipment and uncrewed Vehicles, which is to say things to use rather than things to spend — but it
gets there by auditing the pool (below) rather than by a number that was measuring itself.

**The browser suite is where a wording claim lives, and it finds more than wording.** `LIST=artifact`
exists for one sentence: the feeding bar now carries three different costs through one mode, and the
words are all that distinguish them. An engine test knows the cost and cannot know what was said
about it. The scenario's first run caught the sentence correctly — and also stopped dead on turn
three for two thousand moves, because a dying Arcbound Worker's "up to one target" trigger opened a
prompt the table had **no button on at all**. Every trigger in the pool before modular had a target
it was obliged to take, so nothing had ever needed one. A scenario built to read one string found an
unanswerable prompt in the same run; that is the argument for building the deck rather than trusting
the claim.

**A rule that fires rarely still has to be priced, because rare and harmless are different things.**
The artifact-feeding rule fired four times in 48 games, which looked too thin to matter — and
`bot-duel` across 936 games agreed, flat three times. The slot probe did not: run with `BOT=` so the
same slot is priced by both players on the same seeds, the deck was 7 games of 288 worse with the rule
on at one seed set and 6 at the other. Four plays, both readings the same sign, and the reason was one
tally away — four of the four had a creature standing by that could have carried the Equipment, and
two were the deck's best card. **`bot-duel` prices a rule across the field and drowns a rule that
touches one deck; the slot probe with `BOT=` prices it where it acts.** Reach for the second when the
rule is about one card. Four plays were enough to send a default back, which is the other half of
this: a rule can be too rare for a win rate to see and still be wrong every time it fires, and the
count of *what it chose* says so when the count of *how often* cannot.

**Two probe arms on the same seeds carry their own control, so look for it before running one.** The
`BOT=` arrangement runs stock and variant for each bot, and when the change removes the card the flag
is about, the *variant* column must come out identical in both arms — 151-137 and 151-137, then
181-107 and 181-107. That is not a coincidence to note, it is the pairing being proved: with no
Ravager on the board the flag cannot change anything, and any difference there would mean the two arms
were not playing the same games. A control you get for free beats one you have to schedule.

**The suite checks both directions of the card question and neither direction of the mechanic
question, and that gap costs an afternoon when you find it by accident.** `deck coverage` asserts
every card has a script and every script has a card. Nothing asked how many cards hold a *mechanic*
up — and #220 found out the expensive way: two singletons were cut from `arc-tempest` to pay for two
new cards, and 26 tests broke, because each was the only card in the pool exercising its mechanic.
A starter-deck one-of is load-bearing and nothing said which. `mechanic-coverage.mjs` counts, and
sorts ascending so the fragile rows are the first thing on the screen: **17 mechanics in this pool
rest on one card**, and none of them is a gap — every one is a keyword mechanic whose single card
*is* the pool's whole use of it, the way ninjutsu has one card because the pool has one ninja.

Its first run also found the other shape, the quiet one. **Zero of 78 mechanics are declared with no
card at all** — which is a better result than it sounds, because it means the rule that a keyword
needs a card in a deck to exist (D229) has been kept without exception. And it falsified a claim
five places in the docs still made, one of them written the same morning: `becomes-tapped` is not
the engine's card-less trigger, because City of Brass has carried it since #69. The true version is
stronger, which is the usual way round — no trigger kind in this engine has *ever* had no card.

**A term's weight tells you nothing about whether it decides anything, and the two questions have
different instruments.** `eval-calibration` asks whether a term predicts the winner — a property of
**positions**. `term-leverage` asks what the bot does differently when the term is removed — a
property of **choices**. A term can be badly wrong about the first and silent on the second, which is
what happened to cards-in-hand (D243): it anti-predicts at 42% and a five-fold cut to it moved 936
paired games by one. The reason is that what decides a choice is a term's *variation across the
options on offer*, and hand size barely varies — nearly every candidate is a cast, every cast moves
one card out of the hand, so the term contributes a near-constant amount to the whole slate and
cancels out.

**Leverage by ablation is exact, which is rare here.** Every arm is asked the same position the
shipping bot played, so there is no sampling argument to make: it is the real search on the real
positions, and a term whose removal changes no decision decides nothing whatever its weight says.
Crossed with the calibration, the table sorts itself (D244) — creature 6.4% leverage and 67%
accuracy, life 2.3% and 66%, hand 0.9% and 42%, land 0.1% and 53%. **The cell that would be a
problem, high leverage with poor calibration, is empty**, which closes the retune-a-weight avenue on
evidence rather than by exhaustion.

**The hand term was the wrong shape, not the wrong weight — and the shape is worth 1.35 points.**
D243 closed the retune-a-weight avenue on cards-in-hand: it anti-predicts at 42%, and cutting its
weight five-fold moved 936 paired games by one. The diagnosis above says why — hand size barely
varies across the options on offer. But "a count of cards in hand" and "a count of cards in hand I
can pay for" are different *terms*, and only the first was ever measured. The second varies exactly
where the first does not: the candidates at a cast decision differ in what they leave you able to do
next, which a raw count cannot see.

It reads that way in both instruments. Leverage: **157 of 17451 decisions, 4.8% of casts** against
`hand`'s 2.8% — concentrated on the one decision kind a count cannot inform, while `hand`'s own
leverage sits on activations. Win rate on `bot-duel`, three **disjoint** seed sets:

| seed set | `{castable: 1}` vs stock |
| --- | --- |
| 3300 | **479-454** (+25) |
| 4100 | 469-465 (+4) |
| 5200 | 471-462 (+9) |

1419-1381 of 2808 paired games, +1.35 points, sign holding all three times. That is the bar D242 set
when a third seed set flipped Harm's Way's sign, and it is the first evaluation term to clear it
since — D264's `exposed` had no consistent direction and is still shipped at zero. So this one ships
**on**, at a weight of 1, which puts a castable card at 2.5 against a land's 2.5 and a permanent's 3.

**And then the weight turned out not to matter, which is the same lesson arriving twice.** 0.5 and 2
were each run against the shipping 1 over three disjoint seed sets: 0.5 came back −2, +6, −11 and 2
came back +13, +4, −7. Disagreeing signs mean not measured (D258), so across a **fourfold range
nothing separates them from 1**. D243 closed the retune-a-weight avenue on the raw count — a
fivefold cut moved 936 games by one — and this term's whole argument was that the *shape* was wrong
rather than the weight; its own weight is just as flat. Two terms, one conclusion: **this evaluation
is insensitive to its weights and sensitive to what it can see.** The next gain is another thing the
function cannot see, not another number.

Its time cost is below a noise floor too (D273): an ablation timing both arms on identical positions
put it at about +0.09 ms per decision against a 1.2–9.4 ms baseline, with **two of seven readings
negative**, and the whole-game pace unchanged at 7.0/11.3/9.5 ms/move against a pre-term
8.4/11.3/9.6. Worth checking rather than assuming, because `canAfford` runs the mana solver per hand
card and the zero short-circuit that used to skip it no longer fires.

One thing still not re-measured: the published deck table was baselined with the term **off**. A
symmetric change to both seats' evaluation largely cancels in the *relative* win rates that table
reads, which is why shipping did not wait on it.

**And flipping a default means flipping the instrument that measures it.** `term-leverage`'s
`castable` arm ran the `exposed` way round, turning the term *on*, because an ablation of a term that
ships at zero reads a clean 0.0% and means nothing. The moment the default became 1 that arm became
an override that overrides nothing — and the zero-row check added the same day would have called the
term unscorable, which is precisely the silence it exists to break. A default and its ablation are
one change, not two.

**And the first change that came out of that closed avenue was not a weight, and it took two
attempts because the first one was overruled.** D244 said the next move would have to be a term
that sees something the function cannot, and a clock is the plainest such thing: `creatureValue` is
power, toughness and keyword values, so a Ball Lightning scores as a creature you keep.
`leaving-creatures.mjs` priced the mistake before anything was written — **18 attacks declined**
over 936 games by a Ball Lightning or a Hellspark Elemental that was sacrificed at the end of that
same turn, which is the whole card thrown away, and these are the two cards whose entire function
is one attack.

The lesson is what happened next. A rule in the attack heuristic moved the field count from 18 to
**16**, and a reading that small against a rule that unit tests prove fires is the sort of
impossibility this directory has learned to chase. Asking both bots the same 97 positions said why:
the *heuristic* declined 0 and the *search* declined 10. **The rule was right and the search was
overruling it**, because `evaluate` scores a board with the creature still standing on it higher
and cannot see it is going away. The fix that worked is in the **plan set** — a creature that
cannot be kept is folded into every plan, the way CR 508.1d's forced attackers already are, so the
dominated declaration is never offered — and all four end-of-turn rows then read **0 of 158**,
while every row that should not have moved did not. Not in the evaluation, deliberately: the
position after casting a Ball Lightning is scored *before* its damage, so a leaver worth nothing on
the board is a cast worth nothing, and the bot would have stopped casting the card.

**And the exception every harness here swallows is, on this build, swallowing nothing.** Each of
these files ends its move loop with `try { ... } catch { break; }` and none of them report catching
anything, so a throw would end a game early and be counted as a game played. `unfinished.mjs`
separates the four causes of a game stopping without a winner — the move cap, a null action, no
progress, and a throw — reports faults deduplicated with their message and first seed, and exits
non-zero on any. 1248 games across the field, twice (once passing the context in the loop and once
dropping it as these harnesses do), plus `deck-probe`'s own 288 replayed with `SCHEME=probe`: every
game reached a winner. Run it after any change to the engine's action handling, which is the only
place a throw would come from; one seed over the field takes under a minute (D261).

**Read the whole output after adding a card, because an instrument fails by going quiet.** Three
instruments in this directory have reported numbers that were wrong in one identical shape: a card
gained a new way to carry something, and the reader that enumerated the old ways kept returning a
number that was simply too small. `wasted-plays` could not see a prevention shield, so every Harm's
Way read as a wasted play (D256). `card-promises` could not see a granted trigger, so Ophidian Eye —
whose whole text is an ability it hands out — read as an unscripted card. `spent-permanents` derived
its set from token oracle text, so Lotus Petal, a printed card with the same five rows, would have
been invisible (D259). D260 then found that **seven** files read `script.triggers` without knowing
`grantedTriggers` exists.

None of them errored. Every one of them was found by a person reading a whole output and asking why
a row looked too clean — never by a failing test, and a planted control would not have caught any of
them, because a control written beside a predicate encodes the same blind spot its author had.

So two rules. **One is mechanical**: `guards.js` fails a file that reads a card's triggers without
mentioning the second list, which turns that one pairing into a CI failure (and its own limit is
written in the guard: it checks that the author knew, not that the reading is right). **The other is
not**: after adding a card or a new carrier shape, run the instruments over the deck that holds it
and read **every** row, not the top one. D256 is the case for it — a new card put a 100% row in
front of a question nobody had asked for eleven increments.

**Pair the arms, read two seed sets, and never set a probe reading against a table reading.** Three
rules, replacing the one this page carried for four entries, and D258 has the measurement behind
each.

The old rule was *believe the table*: D203 found a `deck-probe` calling a six-card change +47 of 288
where the table said +4, D247 found a probe pricing two soulbond cards at **+16** where the table
said **−8** — a sign reversal rather than an overstatement — and both concluded that a probe
amplifies whatever its seeds gave it while the table lets the whole field move. **That comparison
was never valid.** The two harnesses derive their seeds differently, so a probe reading and a table
reading of the same deck are two different samples: on decks with *no change at all* they differ by
3 and 17 games here, which is the whole of D257's thirty-game spread before either arm has moved a
card. And the amplification mechanism does not apply to the row that was being read — `deck-table`
plays each pairing once per seed per order and credits both decks, so the subject's own row is the
same 288 pairings the probe plays. Letting the field move changes the *other* twelve rows.

Re-asked with both sides paired, the instruments agree on the sign on both changes. What neither
gives is a number. Four changes through the same paired probe on three disjoint seed sets each, every
figure the value of the **change**:

```
                                        4400    7000    4688   spread
D203  six cards into Dawn Tithe          +30     +18     +21      12
D251  granting cards into Skyward Writ   -14     -19     -29      15
D247  two cards into Verdant Guard       -18      -1      +4      22
D255  Harm's Way into Forge Alliance     +12      +5     -13      25
```

**Two of the four change sign between sets**, and both of those have a reading near zero while the
two that hold are around ±20. So the floor on this harness at 288 games a set is roughly **±20 games
in direction, not merely in size**: a smaller change is not measured here however many times it is
run, and the failure mode is two sets agreeing by luck. D258's first draft had the first two columns
only, said "the sign agreed in all eight readings", and was published before the third set existed.

`deck-probe` enforces the lesson now. `SETS` defaults to 3; every set's delta prints with the spread
and the mean; and the verdict is either "every set agrees, the change is worth the mean, in this
range" or "the sets disagree, so this change is NOT measured at this sample count". Two sets agreeing
is flagged as the weak case rather than the good one. `SETS=1` labels its own output a look rather
than a measurement.

**The practical consequence for this directory**: a slot worth less than about twenty games of 288
cannot be priced by anything here, and several published numbers are smaller than that. The answer
is not a bigger run every time — it is to stop asking for a number where the honest output is a
direction, and to decide those slots on the mechanic and on what a person sees at the table, the way
D229 and D216 do.

So "confirm it on the table" is the step every slot change owes, and `deck-table.mjs` now takes
`SUBJECT` and `CHANGE` so taking it is an argument rather than an edit to `starterDecks.ts`, a
rebuild, a run, a revert and a second rebuild. Four of those five steps were chances to publish a
table of a deck list that is not in the repository.

**The step column in that harness is the part worth copying.** Its first reading said five cards
had been spent on an opponent's creature that was leaving anyway, which sounds like pure waste and
was not: a Maze of Ith or a Darkblast pointed at an attacking Ball Lightning *before damage* stops
six, which is the whole job of both cards. Recording the step turned an accusation into a finding
with the opposite sign — the bot does not waste removal on leavers — and without it the write-up
would have been confidently wrong.

Two rows that look like dead weight and are not, and both are lessons about the instrument rather
than the engine. **`library` at 0.2% is a field average drowning a term that belongs to one deck** —
it exists for the mill deck, and `SUBJECT=hollow-tide` reads it at 1.0% and 3.8% of that deck's
casts, five times its field number. That is the same lesson this page already records about
`bot-duel` against the slot probe, and the general form is: **before calling a term inert, ask
whether the instrument could see it being otherwise.** And **`land` at 0.1% is a constraint rather
than a discriminator** — the land drop is taken as a rule before the search runs, so the one decision
that weight is about is not a search decision at all (`playLand` is 0.0% for every term). Its job is
to make an inequality hold, and **zero leverage is success for that kind of term.**

**An evaluation can be asked whether it is right, and ours had never been asked.** `eval-calibration`
samples one position per round and reads the bot's own `evaluate` against who actually won. Over 936
games the ladder is monotonic and crosses 50% at a margin of zero — 7% at worse than -20, 93% at
better than +20 — and **the sum beats every one of its components in every turn band**, which is the
best defence the function's shape has ever had. What the same table shows is that it is **blunt
early**: 61% sign accuracy at turns 5-8, the only band where a search can still change an outcome.
That bounds what depth can buy, because every leaf a deeper search reaches is scored by the same
blunt function (D241).

The component columns are the actionable half, and they are why the harness reports them separately
rather than only scoring the total. Lands and library sit at 50% and are inert; **cards in hand sit
at 42-46% in the mid-game and are inverted**, on the second-largest weight in the function. A
component that anti-predicts is not automatically a weight with the wrong sign — hand size is a
symptom of being behind rather than a cause — but it is a testable claim about a weight instead of a
theory about Magic, which is more than this problem had before. The general form: **when a composite
score disappoints, calibrate its parts separately; the part that points the wrong way is a lead and
the part that points nowhere is dead weight, and a single accuracy figure tells you neither.**

Three bugs before the first believable output, each caught by a number that could not be true, and
the first two are the same bug twice. Sampling once per `turn` lands on alternate seats, and at the
start of seat 1's turn seat 0 has had one more land drop — the land row read **38% in every band**.
Fixing it by sampling each seat on its own turn has the identical problem with the sign reversed: on
its own turn a seat has had one more land drop than its opponent, and the row came back at **41%**.
**A parity bug fixed by changing which parity is not fixed.** There is exactly one moment in a round
where both seats have had the same number of turns, and a comparison between seats has to be taken
there or not at all. The third was the seed, below.

**One seed is one shuffle wearing 156 deck pairings, and every harness in this directory has been
treating it as 156 games.** This is the most load-bearing thing on this page, so it goes before the
rest.

Every file here loops `for (let i = 0; i < SEEDS; i++)` and hands `SEED0 + i` to every game in that
pass over the field. One `seed` is one RNG stream; the stream shuffles seat 0's deck and then seat
1's; and **the same stream produces the same index permutation however different the deck list is.**
Every starter deck is built the same way, so at a fixed seed the opening hand holds the same number
of lands in every pairing. Measured, 156 pairings per seed:

```
seed 3300: seat 0 opens on 4.00 lands, mean over 156 pairings — and the variance is ZERO
seed 3302: 3.00, again zero
seed 3303: 1.15, with 144 of the 156 opening on one land or none
```

The field-level consequence is as large as that implies. Seat 0 is always on the play here, so it
should win a little over half of a balanced field. By seed it won **42-114, 63-93, 108-47,
115-41** — a swing from 27% to 74%, settling at 53% over the four, which is the play/draw advantage
and is the right answer. Give every game its own seed instead and the passes agree: **79-76 and
82-74**, seat 0 at 52%.

**Paired designs are immune, and that is why no conclusion here has broken on it.** `deck-probe` and
`bot-duel` run both arms over the same seeds, so the shared shuffle cancels in the difference they
report — and it is exactly why their negative control comes out *identical* (151-137 and 151-137,
468-468) rather than merely close. That identity was never luck; it was the shared shuffle doing its
job. What is **not** immune is an absolute rate, and this page is full of them.

Worse than noise: the shared seed **biased** the one reading that could be compared both ways.
`eval-calibration`'s mid-game sign accuracy read 70-79% with shared seeds and 62-73% with
independent ones. Correlated games make an outcome more predictable from a position than it really
is, so the bias flattered the thing being measured. The general form: **a sample that shares a
random stream is smaller than its denominator and not merely noisier — check which of your readings
is a difference and which is a level, because only the difference is safe.**

**The fix is in, across all twenty-nine harnesses (D242), and it is not "a seed per game"
everywhere.** Three kinds of file want three different things, and getting the difference wrong
would have been silent:

- the twenty-two **absolute** readings want a seed per game — they are what the bug hurt;
- `deck-probe` and `pod-slot` also want one, and get it safely because their two arms are two calls
  to the same `record(ctx)` loop, so a seed derived from the loop indices is the same seed in both;
- **`bot-duel` and `pod-duel` want the opposite.** Their repeated calls are not two games, they are
  the two arms — the same decks with the bots swapped, the same table with the seats rotated — and
  they must keep sharing a seed or the pairing the file is built on is gone. A seed per *pairing*
  and per *table* instead.

Always from the loop indices, never a counter: a counter works today and desynchronises the arms
the first time one of them skips a game, which produces a plausible number and no error. The
negative control is the proof and it is exact — **`bot-duel` with the same bot in both arms reads
156-156.**

**What a rate published before this is worth.** `countdowns` was re-measured first, over two
independent bases, and **two of its five rates were off by half**: Calciderm 13% became 26% and 30%,
Thing in the Ice 10% became 20% and 18%, and Search for Tomorrow's perfect 100% became 93% and 82%.
The two new bases agree with each other to within a few points, which is what says they are
measurements. Thing in the Ice's *denominator* moved too — 21 clocks became 10 and 11 — because a
shared shuffle changes how often a card is even drawn, not just what happens to it.

The other twenty-eight are changed but **not re-run**: re-deriving every absolute rate in the log is
a much larger job than the fix. So read any absolute rate dated before D242 as having the error
bars of its seed count rather than its game count, with those three as the measured example of how
far that can be off.

**A static audit of a dynamic engine undercounts, and it took this one three passes to stop.** A
keyword is readable from properties — printed in the text, `script.keywords` — and it is also handed
out three ways that properties do not show: an `equipBonus`, a `statics` entry's effect, and a
`pump(..., { keywords: [...] })` inside a closure. Pass one read properties and published **hexproof
rests on one card**; it rests on five. Pass two read every closure's source and still missed Knight
Exemplar, whose grant is a plain object and says nothing when stringified. Pass three walks the
whole script tree for a string equal to a keyword as well as reading the closures, and moved the
line between the two columns to the one that means something: **the keywords a card has, and the
ones it gives away.** `equipBonus` used to sit in the first column, which is exactly how the gap
hid — a Darksteel Plate is not indestructible, it makes something else so.

Two consequences for the shape of the file. The grant column is a **reader's signal rather than a
count**, because a function mentioning `'hexproof'` may be granting it or filtering for it, so it
prints separately and is never silently added; and the thin filter uses the sum, because for "could
cutting one card take this out of the pool" an over-count is the safe direction.

**And both published errors were found by trying to act on the output, not by re-reading it** — the
hexproof miss when the follow-up task needed a slot picked, the indestructible miss when it needed a
card chosen. Re-reading found nothing either time. Both pointed the same way, too: they made the
pool look worse than it is, which is the direction that gets acted on. The general form: **an audit
that cannot be exactly right should be wrong in the direction that makes you look, and should say in
its own docblock which bound it is and which way.**

**Where the list of mechanics comes from is the whole design, and the alternative is a count of last
month's engine.** It is read out of the source: the field names of `CardScript`, the `kind` literals
of `TriggerEvent`, and the exported `KEYWORDS`. A literal list written beside them would be a second
thing to forget, which is `card-promises.mjs`'s own lesson and this file nearly repeated it. The cost
is that a reformatting of either declaration could silently empty the list, so the parse is checked
and the run **exits non-zero** rather than reporting that the engine can do nothing.

Two bugs before the first believable output, both caught by a count that could not be true. The
declaration parse ended the union at `/^\n/m`, which matches at offset zero because `^` is also the
start of the string, so every trigger kind read zero — the guard caught that one. Then the counts
read `TriggerDef.event` where the field is `on`, so every trigger kind read zero *again*, this time
with the parse working. An optional-chained read of a field that does not exist throws nothing and
logs nothing; what caught it was `0 trigger etb` in a pool with 41 of them.

**An audit that reports nothing is indistinguishable from an audit that *cannot* report
anything — so make it prove otherwise on every run.** `card-promises` read 172 gaps, then 25, then
0, and only the last number was ever about the pool: the first was a bug in its own field lookup,
the second a table of script field names written from memory rather than derived from the cards. It
now plants two cards every run — one promising flying with no script to carry it, one promising
nothing — and prints what each reported, so a clean run is evidence instead of an absence. The
general form: **an instrument whose negative result is the interesting one has to carry its own
positive control**, and that control has to run every time rather than the day somebody wonders.

**A harness's shape decides which cards it can see at all, and `deck-probe` could not see a whole
class of them.** Every one of its games is a duel, so a card whose text reads "for each opponent"
measures as exactly the noise floor: myriad in a two-player game is blank, the probe returns zero,
and the number is true and useless. That is not noise to push through with more seeds — no sample
size fixes an instrument that cannot produce the effect. `pod-slot.mjs` is the sibling that can, and
the general lesson is worth more than the card: **before trusting a flat reading, ask whether the
harness is capable of a non-flat one.**

**A conversion rate is castability, not value, and the two come apart hardest on the cards you
most want to read it about.** `cast-counts`' percentage is "cast, of the games it was in hand", and
affinity put three numbers side by side that make the point: a Frogmite converts **94%**, a Myr
Enforcer **32%**, and the Serra Angel the Enforcer displaced **45%**. Read as a quality score that
says the swap made the deck worse. Read as what it is — a {7} creature is castable about a third of
the time even with the keyword, and a five-mana flier in a deck whose curve stops at four is
castable not much more often — it says nothing at all about which slot is better, and the paired slot
probe is the only thing that does. Use the conversion to find a card that is **stuck** (the
Disenchant with no target, the Ravager's row nobody presses) and the probe to find a card that is
**bad**.

**Audit the pool before writing a rule about a card type.** "Feed it a spent artifact" assumed spent
artifacts exist. Printing every non-creature artifact in the pool with its abilities, statics and
triggers took one script and showed there are none: all of them are Equipment, Vehicles, mana sources,
standing answers or an anthem. It also killed the fix that looked obvious — a syntactic "no ability,
no static" test passes an Obelisk of Urd, whose +2/+2 lives in an enters-the-battlefield choice, so the
bot would have eaten a lord. The audit was twenty lines and it answered a question two probes and a
duel could only hint at.

**An instrument nobody runs is not a check, and a sample a one-card change can flip is not one
either.** `hidden-info.mjs` existed for months, sweeps all 156 deck pairings and asks 16,804
decisions three ways each. Run on the shipping bot it read **9 changed decisions** — a real leak, the
search learning its own shuffle by simulating a Mirko Vosk mill — and nobody had run it. What stood
in for it was a unit test over **three fixed pairings**, which passed; adding one card to one deck
changed which games those three pairings play and turned it red, which is how the leak was finally
seen. Widening that test to cover every deck was tried and **still passed against the leaking bot**:
the leak is about 1 decision in 1,900 and seven games are about 800. Breadth is not the fix. What
caught it was naming the position that reproduces (`hollow-tide` v `kindle-grove`, seed 4242) as a
regression case, with the exhaustive sweep kept for the release loop. Three lessons, one bug: run the
instruments you have, pin the bug you found, and do not mistake a bigger sample for a check.

**Give a fairness fix a flag, so the cheat can be priced.** `BotOptions.blindToShuffle` exists for
one reason: a test that asserts "the bot's answer does not change" is worth exactly as much as the
proof that it *could* have changed. With the flag off the same sweep reads 9 and the same regression
position moves; with it on both read zero. That pairing is in `playout.test.ts` as two tests rather
than one, and `hidden-info.mjs` takes `BOT=` so it can run both arms itself.

**A starter deck's one-ofs are load-bearing, and changing a deck changes what the bot draws.** Two
cards had to go into Arc Tempest for D234, and cutting the two most redundant pieces of burn broke
**twenty-six existing tests**: nearly every one-of in that deck is either the pool's only copy of a
mechanic or the card a test reaches for by name, and every candidate was referenced somewhere —
Firebolt least at three mentions, Twincast most at forty. Reducing a *double* to a single breaks
nothing, because a test only needs one copy to find, so that is where a new slot should come from
unless the measurement says otherwise.

The second half is less obvious and more useful. The same change turned a `playout.test.ts` control
red with `auto:foretell` where it expected `auto:pass` — because `advanceTo` crosses the draw step,
so a deck's order decides what the bot is holding when a test asks it to choose. **That was a real
hole in the bot rather than a brittle test** (#218: `spendsAnAnswersMana` never looks at
`auto:foretell`, so a foretell spends the exact mana the rule exists to keep free). A bot test that
reads a drawn card is an instrument whose reading can change for two different reasons, and telling
them apart is worth the minute it takes: the question to ask is not "which deck change broke this"
but "is the new answer wrong".
