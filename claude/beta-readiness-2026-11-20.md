# Human testing — where the rules engine stands (20 November 2026)

A checkpoint for moving to human testing. The detail of every change is in `claude/decisions-log.md`.
`claude/play-realm-setup.md` is the guide for running a game.

## The numbers

Measured on the branch `claude/fervent-einstein-3j5j49` with
`LEGAL=1 node scripts/measure/compilable.mjs`. The pool is every card legal in at least one of
Standard, Pioneer, Modern, Legacy, Vintage, Pauper or Commander, un-cards excluded.

| | Cards | |
|---|---|---|
| Legal single-faced cards measured | 31,900 | |
| **Fully automated**: every printed line read | **14,376** | 45.1% |
| At least partly automated | about 18,600 | 58% |
| Rules lines read | 35,820 of 59,888 | 59.8% |
| Commander staples fully automated | 243 of 244 | Castle Garenbrig is the one left |

"Partly automated" means the card is cast and played for the lines the engine reads, and carries a
badge naming the line it does not. That line is the players' to apply, with **Move by hand**. The
engine never guesses at a line it cannot read.

In real games the engine meets staples more than the long tail. In a 40-pod sample about half of the
card sightings were partly-read cards.

## Stability

Each sweep is 100 four-player Commander games between bots, on random decks drawn from the whole
legal pool (`LEGAL=1 POD=1 GAMES=100 node scripts/measure/corpus-decks.mjs`).

| Sweep (first seed) | Build | Result |
|---|---|---|
| 59501 to 60101 (six sweeps) | D767 to D768 | every game finished |
| 60301 | D769 | 99 finished; 1 runaway board (below) |
| 60401 | D772 | every game finished |
| 60501 | D773 | every game finished |
| 60601 | D775 | every game finished, 61.8 turns and 354 moves on average |
| 60701 | D776 | every game finished, 58.6 turns and 373 moves on average |

No sweep today had an engine throw or a stall.

The one runaway was **Troubling Tribbles** (seed 60315). It copies itself every upkeep and every copy
does the same, so one player had 2,900 of them by turn 60. The engine played it correctly and kept
pace at a few thousand permanents. A human table will meet the same board: the game stays playable
for a while and then slows. The sweep harness now ends such a game as `runaway-board` (D771).

## What changed today (D769 to D777)

- **D769 Snow mana `{S}`**: paid only from snow sources. Floating mana never pays it.
- **D770, D772 "Assign combat damage as though it weren't blocked"**: Thorn Elemental, Lone Wolf,
  Predatory Focus, Indomitable Might and others. The damage prompt has an **As though unblocked**
  button.
- **D771**: the sweep harness ends a runaway board instead of hanging.
- **D773**: combat-damage triggers for a legendary, modified, enchanted, token, land or
  "Wolf or Werewolf" creature.
- **D774 Bestow** from the printed text: 31 of the 42 bestow cards.
- **D775 Reconfigure**: 18 of the 21 cards.
- **D776 Saddle**: all 32 Mounts.
- **D777**: "untap it" on a permanent's own trigger.

## Before testers sit down: Nick's decisions

Nothing here is blocking on the engine side. These are the decisions that are Nick's, in the order
they matter for testing:

1. **Merge PR #35.** Everything above is on its branch.
2. **The production Scryfall import.** A pasted decklist is read out of `scryfall_cards` (D459).
   Until the VM's table is filled, a pasted list outside the thirteen starter decks is mostly
   cardboard. The one command is in `play-realm-setup.md`, *What is not done*.
3. **The migration cutover (#320).** `claude/cutover-runbook.md` has the exact steps and the
   rollback for each.
4. **The VM environment variables** (step 0 of the runbook).
5. **GitHub Actions.**

Nothing in this work touched the live VM, DNS or production data.

## What testers are likely to report, and what each one is

- **"This card did nothing."** Look for its badge: a line the engine does not read is named on the
  card. That is the expected state for about half of the legal cards. Move by hand covers it.
- **A board that grows without end** (Troubling Tribbles and similar): correct by the rules. The game
  slows once there are thousands of permanents.
- **The computer opponent is cautious with Mounts.** It saddles only with creatures that could not
  have attacked that turn. It never unattaches a Reconfigure Equipment. Both are deliberate.
- **Snow costs refuse floating mana.** `{S}` has to come from tapping a snow permanent while paying.
  Tap snow lands as part of the payment, not beforehand.
- **Known rules gaps**: Castle Garenbrig's restricted mana; hybrid Phyrexian `{G/U/P}` (four
  planeswalkers); choosing to pay life for a Phyrexian symbol when mana is available (the engine
  pays mana first); counts of snow mana spent (Graven Lore); bestow bonuses with a drawback or a
  granted ability.

## Useful when a tester reports a game

- `SEED0=<seed> GAMES=1 VERBOSE=1 TRACE=50 node scripts/measure/corpus-decks.mjs --file <corpus>`
  replays a bot game and prints the board every 50 moves, with the commonest cards on the biggest
  battlefield.
- `bash scripts/gate.sh` is the full check before any push: typecheck, guards and every suite
  against live Postgres and Redis. `node scripts/services-up.js` says which service is down if it
  stops early.
