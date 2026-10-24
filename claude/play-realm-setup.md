# Play Realm — running a real game

Two people, two devices, one game of Magic. This is what to run and what to expect.

## Two ways to play

**Arena mode** is a rules engine. It runs the turn, tracks priority, resolves the stack, declares
combat and refuses a play that is not legal — the computer plays Magic with you. Spells do what
they say, creatures die when they should, and the mana for a spell is tapped for you. Start it with
**Play with the rules engine**.

**Tabletop mode** is the same board with no rules at all: every card in every zone can be moved
anywhere, exactly as it can with cardboard, and the players apply the rules themselves. Start it
with **Play as a tabletop**.

Neither replaces the other. A rules engine has to be written card by card, so it only knows the
cards somebody has scripted — ninety, today, across five starter decks. A tabletop works with
every card ever printed on day one. So the engine handles what it knows, and **Move by hand** is
one tap away inside Arena mode for anything it does not: an unscripted card is cast and resolved
normally, and the log says it was not automated rather than pretending.

You can also start a tabletop game and hand it to the engine later, with the **Rules engine**
button in the control bar.

**You can play on your own.** The lobby has a *Play on your own* section: one seat for you, one the
server plays. No code to share and nobody to wait for. The opponent mulligans, plays lands, casts
spells, attacks and blocks; it is not a strong player, but it is a real one.

**Up to four of you.** Pick **Commander** when you create the table and it seats four at 40 life
with a command zone each — cast your commander for its cost plus {2} a time, it goes back to the
command zone when it dies, and 21 damage from one commander ends that player's game. Turn order,
blocking and every "each opponent" on a card work with three opponents; a player who concedes is
skipped by all of it and the rest of you play on.

What both modes do is the bookkeeping that is tedious and easy to get wrong: shuffling, drawing,
untapping, counters, tokens, commander damage, and a complete log you can scroll back through when
you disagree about what happened — it names who attacked whom, what blocked what, who took damage
and what died, and it leaves out the hundred lines of passing priority in between. There is a chat
panel too.

**Nobody can see your hand.** That is enforced on the server, not in the browser — the identity of a
card in your opponent's hand is never sent to your machine at all. Same for both libraries,
including your own, except while you are searching it. This holds in Arena mode, where the server
also computes each player's legal moves separately, so one seat's options never travel to the other.

## Running it at home

Only one dependency: **Redis**. No Postgres, no `apps/api`, no Grimore account — so there is very
little to misconfigure.

```bash
# Once
redis-server --daemonize yes --save '' --appendonly no
pnpm install
pnpm -r --filter './packages/*' run build
pnpm --filter @grimore/realtime run build

# Every time
node scripts/play.mjs
```

It prints the address to open:

```
  Play Realm is up. Open this on both devices:
    http://192.168.1.42:5100/react/play
```

Open that on both devices — your laptop and your friend's laptop, or a laptop and a phone. One of
you presses **Create table** and reads out the code (`GOBLIN-VAULT-51`); the other types it into
**Join**. Ready up, pick a deck each, and the host presses **Play with the rules engine** (or
**Play as a tabletop**). For a pod, the host picks **Commander** before creating the table and up
to three other people join on the same code.

To play on your own, open it on one device and press one of the buttons under *Play on your own*.

Ctrl-C stops both servers.

If the printed address is wrong — a VPN or a Docker bridge can win the guess on a machine with
several network interfaces — override it:

```bash
PLAY_HOST=192.168.1.42 node scripts/play.mjs     # the address your phone can actually reach
PLAY_HOST=127.0.0.1    node scripts/play.mjs     # both players on this one machine
REALTIME_PORT=4101 WEB_PORT=5101 node scripts/play.mjs
```

### Playing in Arena mode

Almost all of it is one button. The control bar at the bottom always shows the one thing the game
is waiting for — **Pass**, **Resolve Lightning Bolt**, **Next step**, **Declare attackers**,
**Keep** — and the phase bar at the top says which step it is and who is holding things up.

| What you want to do | How |
| --- | --- |
| Play a land, cast a spell, use an ability | Tap the card. Everything you can legally do with it is listed; everything else is not. A card you can play right now says **playable**. |
| Pay for it | Nothing. The engine taps what the spell costs — including picking which colour a dual land makes. Tap lands yourself first if you want particular ones spent. |
| Choose a target | The legal ones light up. Tap one. A spell on the stack is targeted by tapping its row in the stack panel. |
| Respond to their spell | While it is on the stack you hold priority — cast your instant, then pass. |
| Attack | **Declare attackers**, tap the creatures, confirm. One that cannot attack is not tappable, and says why. |
| Attack a planeswalker | Pick it from the row of targets in the attack prompt, then tap the creatures that go at it. Different creatures can go at different players and planeswalkers in the same attack. |
| Use a planeswalker | Tap it on your battlefield and take one of its loyalty abilities. One a turn each, your main phase only, and a minus you cannot pay for is not offered. |
| Block | **Declare blockers**, tap your creature, then tap the attacker it blocks. Only attackers it may legally block light up. |
| See who is attacking whom | Lines on the board: gold from each attacker to the player it is aimed at, dashed from each blocker to what it blocked. In a pod that is how you know an attack is yours to answer. |
| Cast a spell with {X} in its cost | Tap it and pick X from the numbers offered — the list stops at what your mana covers, and it opens on the largest. X is chosen before the target, because that is when the rules choose it. |
| Equip something | Tap the Equipment → **Equip**, then tap one of your creatures. Only on your own turn, and the creature it is already on is not offered. It stays on the battlefield when that creature dies. |
| Scry | The top cards appear in a row of their own, visible to you alone. Tap the ones to put on the bottom and confirm; what you leave stays on top. |
| Mulligan | At the start, **Mulligan** draws a fresh seven; keeping then asks which card goes to the bottom. |
| Something the engine does not know | Tap the card → **Move by hand**, and the tabletop's full move list is underneath. |
| Be asked at every step | The **skipping** toggle in the control bar. On by default, it passes for you whenever passing is your only legal move — which is most of a game. |

### Playing in tabletop mode

The table never decides anything for you, so a few actions are idioms rather than buttons. Tap any
card to see what you can do with it. The same list is in the game behind the **?** in the top bar,
so neither of you needs this page open while playing.

| At a real table | Here |
| --- | --- |
| Play a land, cast a creature | Tap the card in hand → **Play to battlefield** |
| Cast a spell and let it sit while they respond | Tap it in hand → **Cast (to the stack)**. It sits in the shared stack row where you can both see it. |
| It resolves | Tap it on the stack → **Resolves onto the battlefield**, or **Resolves and goes to the graveyard** for an instant or sorcery |
| They counter it | **You** move your own spell to the graveyard, the same as you would reach over and do yourself. Nobody can move a card off your side of the table. |
| Tap for mana | Tap the land → **Tap**. The table does not track mana; you pay it the way you do with cardboard. |
| Attack | Tap your attackers, say who they are attacking (the chat panel is there for this), then settle damage with the life buttons |
| A creature dies | Tap it → **Destroy (to graveyard)** |
| Commander damage | The **cmd** button on the opponent's row adds one at a time. At 21 the table ends the game by itself. |
| Put a counter on something | Tap it → **Add +1/+1** (or **Add loyalty** for a planeswalker) |
| Equip or enchant | Tap the aura or equipment → **Attach to…**, then tap what it goes on. It shows **ATT** and detaches by itself if that creature leaves. |
| Search your library | **Search deck** opens it to you and nobody else; **Shuffle** closes it again |
| Make tokens | **Token** has the common ones. A token that leaves the battlefield disappears, as it should. |
| Take something back | There is no undo. Move the card back by hand, and the log shows what actually happened. |

The turn counter and the **Pass turn** button are bookkeeping, not enforcement — you can act on
anybody's turn, which is what makes instants and responses work at all.

### Five starter decks

**Ember Rush** (mono-red aggro), **Verdant Guard** (green-white midrange), **Tidal Mind**
(blue-black control, with counterspells) and **Rot Harvest** (green-black, built on getting
creatures back out of the graveyard and on feeding them to sacrifice outlets), 60 cards each plus a
commander, so a table can start with no setup at all. **Forge Alliance** (red-white) is the fifth
and the newest: a board of small creatures and a sword for one of them, with Balan — who pulls
every Equipment you control onto himself — as its commander. Each two-colour deck runs a pair of
Guildgates: one mana of either colour, and they come in tapped. Any pairing works, including a
deck against itself. They are also the only decks right now — see *What is not done* below.

Cards are drawn as text, not pictures. That is deliberate: there is no card artwork available (the
card table on the server has never been populated, and this environment cannot reach Scryfall), so
every card face is fully legible from its name, cost, type line, oracle text and power/toughness. If
images do arrive later, the face uses them automatically.

## Putting it on the VM

The table server is a new container behind the existing `v2` profile, so it does not start with a
plain `docker compose up -d`. **These are your commands to run, not mine** — I do not touch the VM.

```bash
# On the VM, in the deployed directory
docker compose --profile v2 up -d --build realtime
docker compose restart caddy        # picks up the new /socket.io route
docker compose logs -f realtime     # expect: "realtime listening"
```

Then `https://grimore.gg/react/play` works for both of you over the internet.

Two things worth setting once it is public:

```bash
# In the VM's .env — restricts who may open a table socket. Unset means any origin may.
SOCKET_ALLOWED_ORIGINS=https://grimore.gg,https://www.grimore.gg
```

**A caveat I have to be straight about:** the `Caddyfile` change is the one piece of this I could not
test, because there is no Docker daemon in my environment. If I got it wrong, Caddy refuses to start
and the whole site goes down with it — so run `docker compose restart caddy` while you can watch
`docker compose logs caddy`, and `git revert` the Caddyfile if it complains. Everything else here was
run end to end.

## When it does not work

| What you see | What it is |
| --- | --- |
| `Redis is not answering` on startup | Redis is not running. The command is in *Running it at home*. |
| `Port 5100 is already in use` | A server from last time. `lsof -i :5100`, or use `WEB_PORT=5101`. |
| The lobby loads but **Create table** does nothing | The browser cannot reach the table server. Usually the printed address is not reachable from that device — set `PLAY_HOST`. |
| Handshake fails with **403** | An origin is being refused. Either `SOCKET_ALLOWED_ORIGINS` does not list the address you are browsing from, or clear it to allow any. |
| `/api/auth/status` fails in the console | Expected. The table does not use `apps/api`; this is the rest of the SPA asking whether you are signed in. |
| A reload loses the game | It should not — your seat is held for two minutes and reclaimed automatically. Past that the seat is gone. |
| A change to the rules engine does not show up | Restart `scripts/play.mjs`. The web app hot-reloads; the table server does not — it holds the build it loaded at startup, so an engine change needs `pnpm -r --filter './packages/*' run build` and a restart. This looks exactly like a bug in the new code, and it caught me twice. |

## Proving it works

Three browser suites, one per way of playing. All need the stack running and Playwright available
(`npm i -D playwright`, or `PLAYWRIGHT_PATH=...`). Screenshots land in `e2e-shots/`.

```bash
node scripts/e2e-table.mjs      # two browsers, tabletop mode          — 47 checks
node scripts/e2e-arena.mjs      # two browsers, rules engine           — 35 checks
node scripts/e2e-pod.mjs        # four browsers, a Commander pod       — 33 checks
node scripts/e2e-solo.mjs       # one browser, against the computer    — 13 checks
```

The tabletop suite plays a complete game through the real UI — lobby, decks, opening hands, card
movement across every zone, tokens, auras, searching, turns, chat, a winner — and checks that
neither browser ever receives the other's hand. The Arena suite does the same with the engine
running, taking whatever the UI offers rather than a fixed sequence, so it plays whatever the
shuffle deals; it checks that the engine never refuses something the table offered, and has modes
for the cases the shuffle makes rare:

The pod suite is the four-player one: four seats on one code, four opening hands at once, a
commander cast from the command zone and back in it after it died, attacks sent at more than one
opponent, a player conceding while the other three carry on, and one survivor. `DECKS=` picks who
plays what, in seat order.

```bash
DECKS=rot-harvest,tidal-mind,ember-rush,verdant-guard node scripts/e2e-pod.mjs
DECK_B=tidal-mind node scripts/e2e-arena.mjs     # counterspells, so the stack gets targeted
DECK_A=rot-harvest DECK_B=rot-harvest node scripts/e2e-arena.mjs   # graveyards and sacrifice outlets
FORCE_MULLIGAN=1   node scripts/e2e-arena.mjs    # both players mulligan, whatever they drew
OPPONENT_DECK=rot-harvest node scripts/e2e-solo.mjs                # which deck the computer plays
```

The layers under them have their own suites: `packages/rules-engine` (414 tests, including whole
games played out by bots that only ever send moves the engine offered them — four-seat Commander
pods as well as duels), `apps/web` (104 tests, the interaction reducer behind every prompt) and
`apps/realtime`
(22 tests against live Redis, including two socket clients playing to a finish and one person
playing the server).

## What is not done

- **Only the five starter decks.** Loading one of your own Grimore decks, or pasting a decklist, is
  a small addition — `deck:load` already accepts any deck passed through `ActionContext.decks`, so
  it is a deck-source function and a picker in the lobby, not a redesign. In Arena mode an
  unscripted card still works as cardboard, with **Move by hand** for whatever it says in prose.
- **The engine knows ninety cards.** Everything in the five starter decks. It stops and asks
  for every decision those cards need: a spell's targets, a trigger's targets (CR 603.3d), a
  sacrifice paid as a cost, how big X is, a mode on a modal spell, and a decision made *while a
  card is resolving*. That last one is what makes a tutor work: Rampant Growth and Diabolic Tutor open your
  library to you and nobody else, Mind Rot is answered by the player discarding rather than by
  whoever cast it, and Fleshbag Marauder asks each player in turn order. A modal spell shows up as
  one play per mode when you tap it — Selesnya Charm offers three, and Grim Discovery offers each
  half and both — and a mode whose target is not on the board is not offered at all.
- **Copy effects and characteristic-setting effects** are deliberately not scripted rather than
  approximated, because `effects.ts` has no honest way to express them. Regeneration and "enters
  with counters" *are* in now, which is why Golgari Charm is in a deck after two checkpoints of
  being the example of what could not be scripted. Anything still beyond the engine resolves by
  hand, and the log says it was not automated.
- **The computer opponent is not a strong player.** It attacks only where the trade is not a
  loss, swings with everything when that is lethal, blocks the biggest thing each creature can
  handle, casts the biggest spell it can afford and mulligans a hand with no land in it. What it
  does not do is think about next turn: it will not hold a creature back to block or keep mana up
  for the counterspell in its hand. It plays a real game; it does not plan one.
- **No card images**, for the reason above.
- **A pod plays, and the pod *interface* is plain.** Four browsers play one to a survivor every
  test run — commanders cast from the command zone and taxed, attacks aimed at whichever opponent
  you choose, a conceding seat skipped by everything. What is missing is everything a pod is
  socially: three opponents are three strips above your own board, whose turn it is reads as a gold
  border rather than a layout, and there is no politics anywhere beyond the chat panel.
- **No spectators in the UI.** The server already builds a spectator view that hides both hands;
  nothing in the lobby joins as one yet.
- **No undo.** The log records everything, but putting a card back is a manual move.
- **Websocket only.** A network that blocks WebSockets cannot play, because the server has polling
  disabled. Rare, but it would look like a table that never connects.
