# Play Realm — running a real game

Two people, two devices, one game of Magic. This is what to run and what to expect.

## What it is, and what it deliberately is not

It is a **shared digital tabletop**, the same idea as Cockatrice or a webcam pointed at a kitchen
table: the server owns the zones, the life totals and the turn counter, and both players see the
same board live. Every card can be moved anywhere, because **the players apply the rules**, not the
computer.

It is **not** a rules engine. It does not know that Lightning Bolt deals three damage, it will not
stop you attacking with a creature that has summoning sickness, and it will not put a trigger on the
stack for you. That is a choice, not a gap: a rules engine has to be written card by card, so it
only works for the few dozen cards somebody has implemented, and your actual decks would mostly not
function. A tabletop works with every card ever printed on day one. The action model is shaped so
per-card automation can be layered on later without redoing any of this.

What it *does* do is the bookkeeping that is tedious and easy to get wrong: shuffling, drawing,
untapping, counters, tokens, commander damage, the turn counter, and a complete log you can scroll
back through when you disagree about what happened.

**Nobody can see your hand.** That is enforced on the server, not in the browser — the identity of a
card in your opponent's hand is never sent to your machine at all. Same for both libraries,
including your own, except while you are searching it.

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
**Join**. Ready up, pick a deck each, and the host presses **Start the game**.

Ctrl-C stops both servers.

If the printed address is wrong — a VPN or a Docker bridge can win the guess on a machine with
several network interfaces — override it:

```bash
PLAY_HOST=192.168.1.42 node scripts/play.mjs     # the address your phone can actually reach
PLAY_HOST=127.0.0.1    node scripts/play.mjs     # both players on this one machine
REALTIME_PORT=4101 WEB_PORT=5101 node scripts/play.mjs
```

### Two starter decks

**Ember Rush** (mono-red aggro) and **Verdant Guard** (green-white midrange), 60 cards each plus a
commander, so a table can start with no setup at all. They are also the only decks right now — see
*What is not done* below.

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

## Proving it works

```bash
node scripts/e2e-table.mjs      # two real browsers play a whole game; screenshots in e2e-shots/
```

Needs the stack running and Playwright available (`npm i -D playwright`, or `PLAYWRIGHT_PATH=...`).
It plays a complete game through the real UI — lobby, decks, opening hands, card movement across
every zone, tokens, auras, searching, turns, a winner — and checks that neither browser ever
receives the other's hand. It also reloads one player mid-game to prove a refresh rejoins the same
seat rather than losing the game. 42 checks.

The layers under it have their own suites: `packages/rules-engine` (78 tests, including a full game
and a Commander game ending on 21 commander damage) and `apps/realtime` (20 tests, including two
socket clients playing a game to a finish against live Redis).

## What is not done

- **Only the two starter decks.** Loading one of your own Grimore decks, or pasting a decklist, is a
  small addition — `deck:load` already accepts any deck passed through `ActionContext.decks`, so it
  is a deck-source function and a picker in the lobby, not a redesign.
- **No card images**, for the reason above.
- **Up to four seats** is supported by the engine and the server, but only two-player tables have
  been played end to end. A Commander pod should work; it has not been sat at.
- **No spectators in the UI.** The server already builds a spectator view that hides both hands;
  nothing in the lobby joins as one yet.
- **No undo.** The log records everything, but putting a card back is a manual move.
- **Websocket only.** A network that blocks WebSockets cannot play, because the server has polling
  disabled. Rare, but it would look like a table that never connects.
