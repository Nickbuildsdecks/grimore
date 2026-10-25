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
| `cast-counts.mjs` | which of a deck's sixty cards does the bot actually use? | `SUBJECT=tidal-mind SEEDS=6 node scripts/measure/cast-counts.mjs` |
| `bot-duel.mjs` | what is this change to the *opponent* worth? | `TESTED='{"lookahead":false}' SEEDS=3 node scripts/measure/bot-duel.mjs` |
| `disagree.mjs` | does that change alter any decisions at all? | `TESTED='{"lookahead":false}' SEEDS=2 node scripts/measure/disagree.mjs` |
| `step-drift.mjs` | how far does the table move on one action? | `SEEDS=2 node scripts/measure/step-drift.mjs` |
| `morph-use.mjs` | which half of a morph does the bot take, and does it follow through? | `SEEDS=3 node scripts/measure/morph-use.mjs` |

A `CHANGE` has to keep the deck at sixty cards, and `deck-probe` says so rather than quietly
measuring deck size instead of the change: a name it cannot find in the subject deck is looked up
anywhere in the pool, and a `-1` on a card the deck no longer runs subtracts nothing.

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
concluding anything about the card added. **It has now happened twice in three entries** — D129's
Elf lord went from (+2, -8) to (+4, +13) on the same two seed sets by taking a redundant third copy
of a creature instead of the deck's only protection spell. Treat measuring the cut as half of what a
slot change is, not as an extra step taken when the first number disappoints.

**A `deck-table` percentage is a statement about a field, not about a deck.** Adding Arc Tempest
moved four of the other eight decks by three to six games with **not one card of theirs changing**
(D128): Tidal Mind down six, Skyward Writ up five. So a percentage from a run with a different
number of decks in it is not comparable to a current one — re-run the table rather than quoting the
old row, and never read a deck's own move across such a boundary as a change in that deck.

**Read `deck-probe`'s per-opponent split before believing the total.** A trim that wins ten games
each against the slow decks and none at all against the fast ones is a change about having a clock,
whatever the total says — and that is exactly what happened the one time the total was trusted on
its own.
