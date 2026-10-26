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
| `pod-duel.mjs` | is a bot setting worth anything in a **four-seat pod**? | `ALWAYS=dawn-tithe TESTED='{"chaseTheCrown":false}' SEEDS=3 node scripts/measure/pod-duel.mjs` |

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

**`pod-duel`'s negative control is arithmetic and must not be read as a floor.** With both arms
identical, all four rotations of a table are the same game, so the winning seat is credited to each
arm exactly twice — 66-66 of 132, by construction. Get a floor by running a *real* arm on two
disjoint seed sets: "chase the crown" came back 70-62 and then 62-70, which is how we know this
harness wobbles by at least ±8 games in 132. Do not believe a smaller pod result than that.
