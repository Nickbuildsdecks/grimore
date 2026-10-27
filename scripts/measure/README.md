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

| | question | run it |
| --- | --- | --- |
| `deck-table.mjs` | how does every deck do against every other? | `SEEDS=12 SEED0=4400 node scripts/measure/deck-table.mjs` |
| `deck-probe.mjs` | what would this slot change be worth? | `SUBJECT=tidal-mind CHANGE='Fog Bank:+1,Cancel:-1' SEEDS=17 node scripts/measure/deck-probe.mjs` |
| `deck-probe.mjs` | what is the **commander** worth? | `SUBJECT=dawn-tithe COMMANDER='Balan, Wandering Knight' SEEDS=15 node scripts/measure/deck-probe.mjs` |
| `cast-counts.mjs` | which of a deck's sixty cards does the bot actually use? | `SUBJECT=tidal-mind SEEDS=6 node scripts/measure/cast-counts.mjs` |
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
| `held-answers.mjs` | …and does the reservation rule fix it? | `BOT='{"reserveForAnswers":true}' SUBJECT=tidal-mind SEEDS=6 node scripts/measure/held-answers.mjs` |

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
