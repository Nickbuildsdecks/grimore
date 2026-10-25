# The instrument

Three harnesses that measure the starter decks against each other, using the engine's own bot for
both seats. They are here rather than in a scratch directory because `claude/decisions-log.md`
quotes their numbers: a measurement nobody can re-run is an anecdote.

All three read `packages/rules-engine/dist/index.js`, so **build first** and rebuild after any
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

A `CHANGE` has to keep the deck at sixty cards, and `deck-probe` says so rather than quietly
measuring deck size instead of the change: a name it cannot find in the subject deck is looked up
anywhere in the pool, and a `-1` on a card the deck no longer runs subtracts nothing.

## Reading the numbers

**The noise floor is about eighteen games in two hundred and forty.** It was established by running
changes that cannot matter and watching them move the record anyway (see D108 and D110). A change
worth less than that is a change this instrument cannot price, and the discipline is to revert it
and write down that it measured as nothing — not to keep it because the sign looked right.

**Run two seed sets, not one.** `SEED0=3300` and `SEED0=8800` are the two used so far. A change
that helps on one and not the other has not been measured; it has been sampled once.

**Read `deck-probe`'s per-opponent split before believing the total.** A trim that wins ten games
each against the slow decks and none at all against the fast ones is a change about having a clock,
whatever the total says — and that is exactly what happened the one time the total was trusted on
its own.
