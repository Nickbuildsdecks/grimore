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
cards somebody has scripted — two hundred and nine, today, across nine starter decks. A
tabletop works with every card ever printed on day one. So the engine handles what it knows, and **Move by hand** is
one tap away inside Arena mode for anything it does not: an unscripted card is cast and resolved
normally, and the log says it was not automated rather than pretending.

You can also start a tabletop game and hand it to the engine later, with the **Rules engine**
button in the control bar.

**You can play on your own.** The lobby has a *Play on your own* section: one seat for you, one the
server plays. No code to share and nobody to wait for. The opponent mulligans, plays lands, casts
spells, attacks and blocks, and before each play it tries every option it has and keeps the one
that leaves the board it likes best — so it will not throw a sweeper at its own creatures or spend
removal on the smallest thing you own. It is still not a strong player: it cannot see your reply,
hold a creature back to block, or keep mana up for the counterspell in its hand. It is a real one,
and it beats the version before it two games in three.

**Or a whole Commander pod on your own.** *Solo pod* in the same section deals a four-player
Commander game against three opponents on three different decks — forty life each, a command zone
each, the full politics of a pod minus the people. It is the same server opponent three times over,
so it will not scheme against you, but it does attack whoever is most worth attacking.

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
| Pay for it | Nothing. The engine taps what the spell costs — including picking which colour a dual land makes, and spending a Sol Ring's two mana before it taps a second land. Tap lands yourself first if you want particular ones spent. |
| Choose a target | The legal ones light up. Tap one. A spell on the stack is targeted by tapping its row in the stack panel. |
| Respond to their spell | While it is on the stack you hold priority — cast your instant, then pass. |
| Attack | **Declare attackers**, tap the creatures, confirm. One that cannot attack is not tappable, and says why. |
| Attack a planeswalker | Pick it from the row of targets in the attack prompt, then tap the creatures that go at it. Different creatures can go at different players and planeswalkers in the same attack. |
| Use a planeswalker | Tap it on your battlefield and take one of its loyalty abilities. One a turn each, your main phase only, and a minus you cannot pay for is not offered. |
| Block | **Declare blockers**, tap your creature, then tap the attacker it blocks. Only attackers it may legally block light up. |
| See who is attacking whom | Lines on the board: gold from each attacker to the player it is aimed at, dashed from each blocker to what it blocked. In a pod that is how you know an attack is yours to answer. |
| Work out who the threat is | Every seat strip says `board N` — the total power of that seat's creatures — and `· M up` for how much of that power is untapped. The first number is what can kill you eventually; the second is what can kill you on their *next* turn, and what can stop you on yours. A **lethal** badge on an opponent's strip means their untapped power alone is at least your life and you have nothing untapped to block with. |
| Choose who to attack | The attack prompt lists every player and planeswalker you may send an attack at, and each player's button says their life, their untapped power, and how many of your creatures are already pointed at them — plus **lethal** when that swing would finish them with nothing able to block. Tap a player, then tap the creatures that go at them; tap a different player and the next creatures go there instead. |
| Send everything at one player | With two or more creatures declared, **All at ⟨name⟩** re-points the whole swing at whoever is selected. For the turn where somebody's life total drops and the plan changes. |
| Cast a spell out of your graveyard | Three cards have **flashback**: Think Twice, Firebolt and Cackling Counterpart. Once one is in your graveyard, tap it there — it says **playable** like a card in hand — and it offers a second casting for its flashback cost, which replaces the printed one. It keeps its own timing (the Firebolt is still a sorcery), and it is **exiled** rather than buried afterwards, so there is no third casting. |
| Cast a spell with **convoke** | Two cards have it, both in Verdant Guard: Siege Wurm ({5}{G}{G}) and Conclave Tribunal ({3}{W}{W}). Each creature you tap as you cast it pays one generic mana or one of that creature's colour, so a seven-mana Wurm is castable off four lands and three creatures. The play says how many it will tap — **Cast Siege Wurm (convoking 3)** — and it taps none that your lands already cover, because a tapped creature cannot block. A creature that arrived this turn may still be tapped for it. |
| Cast a card **face down** | Eight cards have **morph**: Dirgur Nemesis, Zoetic Cavern and Willbender in Tidal Mind, Battering Craghorn and Zombie Cutthroat in Ashen Rite, Ainok Survivalist in Verdant Guard, and Master of Pearls and Hidden Dragonslayer in Skyward Writ. Each offers a second play — **Cast it face down ({3}, a 2/2)** — which is there even when you cannot afford the printed cost, and that is what the mechanic is for: a five-mana creature on turn three. Face down it is a 2/2 with no name and no abilities and nobody else can see which card it is. Tap it later → **Turn it face up**, pay the morph cost printed on it, and it is itself again — keeping its damage, its counters, whether it is tapped and how long it has been there, so one that has been down since last turn can attack the moment it is turned up. **Nobody can respond to that.** Turning a permanent face up uses no stack, so you can do it after blockers are declared: a 2/2 that becomes a 3/1 with first strike kills the creature blocking it and takes nothing back. Two of them have text on the back, which is what you hold them for: Ainok Survivalist destroys an opponent's artifact or enchantment when it is turned up, and Master of Pearls gives your creatures +2/+2 until end of turn — turn it up after blockers are declared and the attack they blocked correctly kills them instead. What they trigger goes on the stack and *can* be answered; the turning up cannot. Zoetic Cavern is the strange one — a *land* you may cast as a 2/2 instead of playing it, for the turn your hand has lands and nothing to do with them. Two of the seven do not cost mana the way the others do. **Zombie Cutthroat**'s morph cost is **pay 3 life** and no mana at all, so it turns up on a turn you spent everything — and at three life or less the table stops offering it, because a cost that would lose you the game is not a cost you may choose to pay. **Hidden Dragonslayer** has **megamorph**: same {3} face down, and turning it up for {2}{W} also puts a +1/+1 counter on it, so it comes up a 3/2 rather than a 2/1 — and its trigger destroys an opponent's creature with power 4 or greater, which is the card you were holding a 2/2 for. The counter goes on in the same breath as the turn-up: there is no window where it is face up and not yet bigger. |
| Drive a **Vehicle** | Three cards are Vehicles: Sky Skiff and Renegade Freighter in Forge Alliance, Consulate Dreadnought in Rot Harvest. A Vehicle is an artifact and **not a creature at all** until it is crewed — it cannot attack, cannot block, and a sweeper that kills every creature leaves it sitting there, which is why its printed body is far above its cost. Tap it → **Crew N**, and the table taps enough of your own untapped creatures to reach N power and tells you how many before you press it (**Crew 2 (tapping 2)**). It picks your smallest creatures, because the big one is the one you want left standing. A creature that arrived this turn can still crew. The Vehicle is a creature until end of turn, and then an artifact again, still on the battlefield. Crewing *is* an activated ability, so unlike turning a morph face up it can be answered — and the creatures are tapped as the cost, so an answer leaves them sideways and the Vehicle inert. The board says **not crewed** on one that nobody is driving. |
| Play a **Saga** | Two cards are Sagas: The Birth of Meletis in Skyward Writ and The Eldest Reborn in Hollow Tide. A Saga is an enchantment that reads itself out over three turns. It arrives with one lore counter and **chapter I happens immediately** — you do not wait a turn for it — and it gets another counter at the start of each of your own main phases, never on anybody else's turn. Each chapter goes on the stack like any other trigger, so an opponent can answer the chapter even though they cannot stop the counter. Once the last chapter has resolved the Saga is sacrificed and goes to your graveyard; the card shows **lore** counters so you can see which chapter is next. Nothing can be killed in response to a Saga except the Saga: a creature removal spell does not touch it, and in this pool only three cards destroy an enchantment. |
| **Foretell** a card | Two cards have it, in Tidal Mind and in Arc Tempest: Behold the Multiverse and Saw It Coming. On your own turn, tap the card in hand → **Foretell** and pay {2}; the card goes into exile **face down**, and nobody else can see what it is — only that there is a card there. From your next turn onwards it is a play again, out of exile, for the smaller cost printed on it (**{1}{U}** and **{U}{U}**). You cannot cast it on the turn you foretold it. The point is that it splits a four-mana spell across two turns, so you can hold up a counterspell without holding up the mana — which is the hardest thing in this pool to do and the one thing the computer genuinely cannot. Foretelling cannot be answered: no stack, nothing to respond to. |
| Work out why your creature is bigger than its card | Three creatures are **lords**: they change the other creatures of their own type. Stromkirk Captain in Ashen Rite gives other **Vampires** +1/+1 and first strike, Knight Exemplar in Skyward Writ gives other **Knights** +1/+1 and indestructible, and Imperious Perfect in Rot Harvest gives other **Elves** +1/+1. None of them pumps itself — "other" is printed on all three. The board always shows the current size, and it changes the instant the lord arrives or leaves, with nothing to click: a Knight with three damage on it that was surviving because of the Exemplar dies the moment the Exemplar does. |
| Attack with **one** creature on purpose | **Guardians of Akrasa** in Skyward Writ is a 2/3 that cannot attack and has **exalted**: whenever exactly one creature you control attacks, *that* creature gets +1/+1 until end of turn. It is the number of attackers you **declared** that decides, not what is left in combat afterwards — so two attackers get nothing even if one of them is removed from combat before damage, and one attacker keeps the +1/+1 even if it is blocked by three creatures. The Guardians themselves are never the creature that grows, because a creature with defender never attacks. The pump goes on the stack as a trigger, so it resolves before blockers are declared and both players can see it coming. |
| Watch a creature grow itself | **Cloudfin Raptor** in Hollow Tide is a 0/1 flier for one mana with **evolve**: whenever another creature you control enters that has **greater power or greater toughness** than the Raptor, it gets a +1/+1 counter. Either one is enough — a 0/2 Fog Bank grows it on toughness alone — and once the Raptor is the biggest thing you control it stops growing. The condition is checked **twice**, which is worth knowing at the table: nothing goes on the stack at all when the creature that arrived is not bigger, and it is checked again when the trigger resolves, so killing or bouncing that creature in reply means no counter. The counters stay on the Raptor through anything that does not kill it. |
| Read a creature whose power is a **\*** | Two creatures are printed with a star instead of a number, and what it means is that their power is a count of something, read fresh every time anybody looks. Lhurgoyf in Rot Harvest counts the creature cards in *every* graveyard and its toughness is that plus one; Enigma Drake in Arc Tempest counts the instants and sorceries in *your* graveyard and keeps its printed toughness of 4. In hand the card still shows the star, because that is what the card says; on the battlefield the board shows the number it currently is. It changes with nothing announcing it — including downwards, if a graveyard gets exiled. |
| Send their removal somewhere else | Two cards change what a spell already on the stack is pointed at. **Willbender** in Tidal Mind is a morph: {3} face down, and {1}{U} to turn it up at the moment their removal is on the stack aimed at one of your creatures — then pick the spell, and pick where it goes instead. **Swerve** in Arc Tempest does the same for {1}{U}{R} as an instant, for an instant or a sorcery, and a burn spell aimed at your face can be aimed back at theirs. Three things to know. The new target has to be legal **for their spell** — a "target creature" spell cannot be sent at a player, and if the one you pick is illegal the spell simply keeps the target it had rather than being countered. The spell has to have exactly **one** target. And the table will not offer you a spell with nowhere else to go: if the thing it is aimed at is the only legal target on the table, changing it would change nothing. And Willbender is printed "spell **or ability**", which it now does: an ability is a row in the stack list rather than a card, so you tap the row. Swerve is spells only, because that is what *it* says. |
| Choose a word rather than a card | Two cards ask something no card can answer. **Obelisk of Urd** in Rot Harvest asks for a **creature type**: it has convoke, so a board of creatures pays for it on turn three, and every creature you control of the type you name gets +2/+2 for as long as the Obelisk is out — including ones that arrive later, so an Imperious Perfect making Elf Warriors keeps feeding it. **Voice of All** in Skyward Writ asks for a **colour**: a 2/2 flier with protection from whichever colour you name, which against the two decks holding this pool's removal is a creature they cannot target, block, damage or kill in combat. The bar shows the words as buttons and one tap is the whole answer — nothing to confirm, nothing to count. Both ask **while the card is still resolving**, which is what "as this enters the battlefield" means: there is no moment where the Obelisk is on the battlefield with no type chosen, so a removal spell held for exactly that window does not exist. The thirteen types offered are the ones this pool actually contains in numbers (eight copies or more); the real card says "any creature type", and a table cannot draw several hundred buttons. |
| Answer what a permanent is **doing** | Two cards counter an ability on the stack rather than the permanent that made it, and that is a different thing: by the time an Icy Manipulator's tap or a Jace's loyalty ability is waiting to resolve, destroying the card does not stop it — an ability on the stack is its own object and does not care whether its source is still there (CR 113.7a). **Squelch** in Arc Tempest is {1}{U}: counter target **activated** ability, and draw a card. **Disallow** in Tidal Mind is {1}{U}{U}: counter target spell **or** ability, either kind. Abilities are the rows in the stack list, so you tap the row; there is no card to tap, because an ability is a thing a permanent is doing and not an object anybody owns. Two things follow from that. Neither card is castable with nothing there to point at, which is the table refusing to let you throw it away. And a cost that was already paid stays paid: countering an Icy Manipulator's tap does not untap the Icy Manipulator, because the tap was the price of putting the ability on the stack in the first place. |
| Have a creature with **ward** targeted | Two creatures have it: Dragonsguard Elite (ward {1}) in Verdant Guard and Sedgemoor Witch (ward {3}) in Ashen Rite. When an opponent aims a spell or an ability at one, their spell stops on the stack and **they** are asked: pay the ward cost, or let it be countered. Both answers are offered, because declining is often right — the removal is answered either way, and it cost them the card. If they cannot produce the cost at all they are not asked, and the log says the ward was not paid. It never triggers off its own controller's spells, so you can pump your own warded creature for free. |
| Turn a permanent face down | Tap it on the battlefield → **Turn face down**. Nobody else can read what it is, and at an automated table it stops being that card for the rules too: it is a **2/2 creature with no name, no colours and no abilities** (CR 707.2) until it is turned back up. A face-down Llanowar Elves taps for nothing, a face-down Glorious Anthem stops lifting the team, and a face-down land is not a land. Counters and pumps still apply to it — a +1/+1 counter makes it a 3/3 — and your opponent sees the 2/2 rather than a blank card. No card in the decks does this to itself yet; it is here as a move you can make. |
| Offer somebody a deal | **Deal** on the bottom bar: pick a player and one of three things to say to them — a truce until their next turn, or not attacking them this turn or next. They see it in those words with **Agree** and **No deal**, and once it is agreed both seat strips carry a badge for as long as it lasts. **Nothing enforces it.** You can attack them anyway; the log says you broke a deal, and their strip says **broke a deal** for the rest of the game. The computer's seats take a deal unless they can kill you right now, and keep every one they take unless a creature that must attack leaves them no choice. |
| Watch somebody else's game | Put their code in the **Join a table** box and press **Watch** instead of **Join**. You take no seat, it works mid-game, and you see both boards and neither hand. |
| Play another game | **Play again** on the game-over banner deals a fresh game at the same table, with the same decks and the engine still running — the winner of the last one goes second. **New game** beside it empties the table instead, for when somebody is changing decks. |
| Cast a spell with {X} in its cost | Tap it and pick X from the numbers offered — the list stops at what your mana covers, and it opens on the largest. X is chosen before the target, because that is when the rules choose it. |
| Pay a kicker | The kicked version is listed as its own play — "Cast Burst Lightning with kicker {4}" — and it only appears when you can pay for the whole thing. Choosing it *is* paying it. |
| Cycle a land from your hand | Tap it in hand: beside **Play**, it offers its cycling ability. It costs the mana and the card, and draws you another. |
| Cast a spell that costs a creature | Tap it, then tap the creature to feed it. The creature is gone before the spell is on the stack, which is the rules and not a shortcut — nobody can save it in response. |
| Take a creature away | Journey to Nowhere, Banisher Priest and Banishing Light exile something *until they leave the battlefield*. The card holding it says what it is holding, and destroying it gives the card back to its owner. |
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
| Take something back | **Undo** in the top bar puts the table back to just before the last move — one step, and only the host sees the button. It takes back whatever the engine or the computer's seats did in answer to that move as well, because that is what happened, and everybody is told in the chat that it was used. With nothing left to take back the button is simply gone. It restores the state exactly, so a card that was drawn and then taken back has still been seen by whoever drew it — the same as at a kitchen table, and the reason it is one step and the host's call. For anything further back, move the cards by hand; the log shows what actually happened. |

The turn counter and the **Pass turn** button are bookkeeping, not enforcement — you can act on
anybody's turn, which is what makes instants and responses work at all.

### Nine starter decks

**Ember Rush** (mono-red aggro), **Verdant Guard** (green-white midrange), **Tidal Mind**
(blue-black control, with counterspells) and **Rot Harvest** (green-black, built on getting
creatures back out of the graveyard and on feeding them to sacrifice outlets, now with an
**Imperious Perfect** that taps for an Elf a turn to feed them with, and an **Obelisk of Urd**
that names a creature type as it lands and makes every one of them +2/+2 — including the Elves the
Perfect has not made yet), 60 cards each plus a commander, so a table can start with no setup at all. **Forge Alliance** (red-white) is the fifth:
a board of small creatures and a sword for one of them, with Balan — who pulls every Equipment you
control onto himself — as its commander. **Ashen Rite** (black-red) is the first
deck whose costs are decisions: cycling lands that are a land early and a card late, spells with a
kicker you may pay for a bigger version of the same card, and removal whose cost is one of your own
creatures. Judith leads it, and makes every creature you lose a Shock on the way out. Eight of its creatures
are Vampires, which is more of one creature type than any other deck in the pool has, so it is also
where **Stromkirk Captain** lives: +1/+1 and first strike for the other eight, which turns a row of
0/1 Blood Artists into 1/2s that kill an attacker and take nothing back.
**Skyward Writ** (white-blue) is the first deck whose plan is not to have the best
board: Walls that hold the ground and attack nowhere, two Counterspells and an Essence Scatter
because what beats it is a creature, a 2/3 that cannot attack and makes your lone flier bigger, a
flier that takes protection from whichever colour you name as it lands, and more fliers to win over
the top. Hanna leads it and buys an artifact or
enchantment back out of your graveyard once a turn. Its six Knights are the pool's second-deepest
tribe, and **Knight Exemplar** makes all of them +1/+1 and **indestructible** — with the caveat
that matters at the table: kill the Exemplar and they are mortal again immediately, including in
the middle of a combat somebody has already assigned damage in. **Hollow Tide** (blue-black) is the newest, and
the first deck in the pool that **does not care about your life total**: it wins by emptying your
library, which the engine has always enforced as a loss (CR 704.5b) and which nothing had ever tried
to do on purpose. Blockers that never attack, three counterspells and four removal spells to survive
the early turns, and then ten cards a swing from a Nemesis of Reason, ten a turn from Jace, or
eleven a connection from Mirko Vosk, who leads it. Its cheapest blocker is a **Cloudfin Raptor**,
a 0/1 for one mana that grows itself every time a bigger creature of yours arrives — which in this
deck is every creature it has.

**Arc Tempest** (red-blue) is the ninth and the newest, and it is the first deck here whose
creatures are paid for by its spells. Twenty-five of its sixty cards are instants and sorceries and
only seven are creatures, and every one of those seven reads the spells: Guttersnipe turns each cast
into two damage at the face, Young Pyromancer turns it into a 1/1, Gelectrode and Thermo-Alchemist
untap on each cast so their tap abilities become once-per-spell, and Monastery Swiftspear and
Stormchaser Mage get bigger. Enigma Drake is the one that does not wait for the rest: a 1/4 flier on
turn three whose power is however many instants and sorceries are in your graveyard by turn eight.
Its newest cards are **Swerve**, the only answer in these colours to a burn spell aimed at the
face — it aims it back — and **Squelch**, two mana at instant speed that counters an activated
ability and draws a card, which is a cheap spell this deck's creatures all get paid for whether the
counter half matters or not.
Adeliz, the Cinder Wind leads it and is the part a deck list cannot be — a 2/2 flier with haste that
is swinging for four the turn you cast two spells, and a Wizard herself, so the line works on an
empty board. It has no sweeper, no answer to a resolved noncreature permanent and no lifegain: it
expects to be the deck with the shorter clock, and against the two faster than it, to be the one
holding Counterspell.

Each two-colour deck runs a pair or three of Guildgates: one mana of either colour, and they come in
tapped, and seven of the nine also run a pair of cycling lands. Any pairing works, including a deck
against itself. They are also the only decks right now — see *What is not done* below.

A note on what to expect from each: played against each other by the engine's own opponent, the
aggressive decks win more. Skyward Writ is the clearest case of the bot rather than the deck: it is
level with the field at 51% and loses to the two fastest decks there — holding mana for a
counterspell is half its plan and the bot cannot do it. A person
plays it better. The same caveat applies twice over to Arc Tempest: holding up Counterspell is half
its plan against the fast decks, and the bot casts it the turn it can afford it.

**The decks are not all equally strong, and now there is a table of it.** Every deck against every
other, both seats, 192 games each (`SEEDS=12 node scripts/measure/deck-table.mjs`):

```
 81%  156-36   ember-rush
 66%  126-66   forge-alliance
 53%  102-90   verdant-guard
 51%   97-95   skyward-writ
 46%   89-103  ashen-rite
 44%   84-108  arc-tempest
 40%   77-115  hollow-tide
 39%   75-117  rot-harvest
 30%   57-135  tidal-mind
```

That run is after the two cards that ask for a word, and it is the quietest this table has ever
been: **nothing moved by more than two games in a hundred and ninety-two**, three rows are identical
to the last run, and the two decks that changed a card moved by one game and none. Which is what it
should look like, because both slot measurements said the same thing — the Obelisk is free and the
Voice costs about one per cent. A table that had moved a lot here would have meant one of those
numbers was wrong.

The run before it was after the two cards that counter an ability, and it was the clearest
demonstration of the caveat two paragraphs down. **Both decks that changed a card are the two this table says
nothing useful about.** Tidal Mind came back on *exactly* the same record as the run before — 57-135
to the game — with a card swapped, and Arc Tempest came back three points **down** after a swap its
own paired measurement scored at +2 and +4 on two other seed sets. Six games in a hundred and
ninety-two, on a third seed set, against a field where the other changed deck also moved: that is
what a row inside the noise floor looks like, and reading it as "the card was bad" would be reading
the instrument instead of the deck. Everything else moved by one game or none, Rot Harvest's row
being identical to the last run as well.

The run before it was after exalted and evolve, and **both decks that changed a card moved up**:
Skyward Writ from 48% to 51% for the Guardians of Akrasa, Hollow Tide from 35% to 40% for the
Cloudfin Raptor. The sharpest single move was the matchup where both cards were in play: Skyward
Writ beat Hollow Tide 14-10 before and lost it 10-14 after.

The run before that was after the two redirection cards, and it was the quietest refresh this table
has had: every row moved by three games or fewer and three did not move at all. Which is what it
should look like when both new slots measured as washes — a table that moved a lot there would have
meant the slot measurements were wrong.

The run before it was after the three tribal lords and the two new morphs. **Skyward Writ is up eight and
Ashen Rite up three**, which is both of the decks that got a card and both in the direction their
own slot measurement said (D130). The two decks that *lost* ground, Verdant Guard down five and
Forge Alliance down two, changed nothing at all: they are the two that beat Skyward Writ most
often, and a stronger Skyward Writ takes those games off them — 18-6 became 16-8, and 17-7 became
15-9. That is the caveat below happening in the same table as the change that caused it.

The run before this one was after the three lords, where the only record that moved was Rot
Harvest's, up five: the one deck whose cut was re-measured with a different card removed (D129).
Ashen Rite and Skyward Writ landed on identical totals to the run before that one, which was a
coincidence rather than a card doing nothing — several of their matchups moved by a game or two
each and the sums happened to come out the same.

The run before this one was the first with nine decks in it, and **not one of the other eight
changed a card** for it. Four of them still moved by three to six points — Skyward Writ up five,
Hollow Tide up two, Rot Harvest down three, Tidal Mind down six — and all of it was Arc Tempest's
own record against them. It beats Tidal Mind 19-5 and Rot Harvest 14-10, and loses to Ember Rush
and Forge Alliance 5-19 each. A deck of cheap removal and counterspells is a bad matchup for the
slowest decks in the pool and a hopeless one against the two fastest, which is the shape it was
built to have.

**Read the order, not the individual numbers.** Every deck's record here depends on all eight of
the others, so a deck moves when its opponents change even if it does not — and the row above is
the cleanest demonstration of that this table has produced, since nothing but the size of the field
changed. The previous clearest case was Hollow Tide falling eight points between one run and the
next, also without a card of its own changing. Row-to-row moves of a dozen games on a hundred and
ninety-two are inside the noise anyway. What a table like this is good for is the shape: two decks
clearly ahead, a long middle, and nothing unplayable at the bottom.

Some of that spread is the decks and some of it is the opponent: a burn deck with four Lightning
Bolts is the easiest thing in the pool for a one-ply search to pilot, and a control deck that wants
to hold mana up and answer the right spell is the hardest (see `claude/decisions-log.md`, D108 and
D110). **If you want an even game against the computer, give it Ember Rush or Forge Alliance and
take whichever deck you like; if you want an easy one, give it Tidal Mind or Hollow Tide.** Two
people playing each other can ignore all of this — these numbers are about how well the *bot*
pilots each deck, and the two decks it handles worst are the two a person gets the most out of.

Tidal Mind is the deck most of this work has gone into and still the one at the bottom. Its
newest cards are the two that answer what a permanent is *doing* rather than the permanent:
**Disallow** counters a spell or an ability, either kind, and **Willbender** — a {3} face-down 2/2
that blocks on a turn it has nothing else to do, and a {1}{U} turn-up — now sends an ability
somewhere else as readily as a spell. A trick that is also a body, and the deck's whole plan is
answers.

Tidal Mind used to be the outlier at 25%, and what fixed it was not the obvious thing. Nothing in
the deck was dead — every card got cast in a majority of the games it was drawn — and the deck's
own counterspells were among its most-used cards. What it lacked was a way to *win* the games it
survived, so three counterspell copies became a second Fog Bank, a second Vampire Nighthawk and a
third Man-o'-War. That is worth nothing at all against the fastest deck in the pool and five to ten
games against every slower one. D114 has the whole measurement.

The decks share a pool of two hundred and nine scripted cards, which now includes a wrath, a
tapper, graveyard hate, a creature counterspell, a bounce spell, mana rocks and a bird that taps
for any colour — the engine's vocabulary is wider than the pool, so adding a card is usually a few
declarative lines rather than new rules. The newest three are the clearest example of both halves
of that: Hellrider ("whenever a creature you control attacks") needed the attack event widened so a
trigger can watch the whole board, while Ball Lightning and Cloudshift needed nothing new at all —
and Cloudshift blinking a creature in response to removal makes the spell miss, because a card that
leaves and comes back is a new object (CR 400.7).

The five after those exist for a different reason: **every keyword the engine enforces now has a
card that carries it.** First strike (Youthful Knight), menace (Boggart Brute), indestructible
(Darksteel Plate) and shroud (Robe of Mirrors) were all implemented and checked in the rules with
nothing in the pool to trigger them, and Night of Souls' Betrayal is the first card whose static
effect reaches across the table rather than down one side. Shroud is the one worth knowing as a
player: a creature with it cannot be targeted by **anybody**, you included — no pump, no targeted
equip, no rescue.

Four of them answer the half of the board nothing could touch, or answer an answer. **Naturalize**
and **Disenchant** destroy target artifact or enchantment, which is what a Pacifism on your
commander needed; destroying a Journey to Nowhere also gives the creature back. **Blossoming
Defense** and **Dive Down** cost one mana and give one of your own creatures +2/+2 or +0/+3 and
hexproof until end of turn — held up rather than cast, because the window they are for is while
somebody else's removal is on the stack. Cast then, the removal misses entirely.

Three of the newest are the ones that cost you something to play them. **City of Brass** deals you
a damage every time it becomes tapped — including when an opponent's Icy Manipulator taps it, which
is the half a "tapped for mana" rule would miss. **Mana Confluence** charges a life as a cost
instead, so it happens the moment you tap it and nothing can be done about it; at one life the
engine stops offering it, because a cost you cannot pay is not a cost you may pay. Both are tapped
last when the table pays for a spell on your behalf: it reaches for a basic before it reaches for
your life total. **Dark Confidant** reveals your top card each upkeep and charges you its mana
value, which over 120 measured games cost its controller 65 life and drew 50 cards.

The three newest are in for the rules rather than for the decks. **Lhurgoyf** is as big as the
graveyards are: its power is the number of creature cards in every graveyard at the table and its
toughness is that plus one, counted fresh every time anybody looks — so it grows when anything dies
anywhere, shrinks when a graveyard is exiled, and a Clone of it copies the *ability* rather than the
number. In Rot Harvest, a deck that feeds its own creatures to a Blood Artist, it tends to arrive as
a four-power attacker and keep going. **Mutavault** is a land that becomes
a 2/2 creature for {1} until end of turn and stays a land: it attacks, an anthem pumps it, it is
summoning-sick on the turn you play it, and it dies to a Doom Blade like anything else — and it taps
for {C} only, which in Ember Rush's deck of {R} costs is the price you pay for the body. Tap it for
mana and it cannot attack, which is the choice the card is. **Crimson Wisps** gives a creature haste
and makes it red, and draws a card; the colour matters against Paladin en-Vec's protection from red
and nowhere else in this pool.

**The six newest all belong to one deck, and five of them needed nothing new at all.** Arc Tempest's
creatures each read the spells you were casting anyway: **Guttersnipe** sends two damage at each
opponent per instant or sorcery, **Young Pyromancer** makes a 1/1 instead, **Gelectrode** untaps on
every cast so its "{T}: 1 damage to any target" becomes once-per-spell rather than once-per-turn,
**Stormchaser Mage** is prowess on a hasty flier, and **Adeliz, the Cinder Wind** — the deck's
commander — gives every Wizard you control +1/+1 until end of turn, herself included. All five are
the `spell-cast` trigger that has been in the engine since the first red deck, pointed at five
different things. The sixth is **Enigma Drake**, and it is the one that needed engine work: a
characteristic-defining power that counts one player's own graveyard, and that defines the power
while leaving the printed toughness alone.

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
| A change to the rules engine does not show up | Restart `scripts/play.mjs`, and that is all — it rebuilds the packages and the table server itself on the way up (two seconds when nothing changed). The web app hot-reloads from source; the table server runs from `dist/` and holds whatever it loaded at startup, so for three debugging sessions "the code is right and the server is old" looked exactly like a bug in the new code. It cannot now: restarting is rebuilding. |

### Finding a table

Two ways in, and the first one is new. **Open tables** in the lobby lists every table whose host
chose to list it, with the code, the format, how many of its seats are taken, and a **Join** or
**Watch** on each row — so the second player needs nothing from the first. A table is **unlisted by
default**: creating one offers *Just us* (shared by code only) and *Open table* (listed for anyone),
and the first is selected until you say otherwise, because a shared server that listed every game
as it was made would show strangers each other's tables. The server enforces the same rule from its
own side — a table is only ever listed while it is in its lobby *and* its host asked for it, so one
that has started, filled up or gone away is simply not in the list.

The code box is still there and still the way into an unlisted table. **Join** takes a seat;
**Watch** takes none and works mid-game.

## Proving it works

Four browser suites, one per way of playing. All need the stack running and Playwright available
(`npm i -D playwright`, or `PLAYWRIGHT_PATH=...`). Screenshots land in `e2e-shots/`.

```bash
node scripts/e2e-table.mjs      # two browsers, tabletop mode          — 62 checks
node scripts/e2e-arena.mjs      # two browsers, rules engine           — 51-54 checks
node scripts/e2e-pod.mjs        # four browsers, a Commander pod       — 42 checks
node scripts/e2e-solo.mjs       # one browser, against the computer    — 20-21 checks
SOLO_POD=1 node scripts/e2e-solo.mjs   # one browser, a pod against three — 23 checks
```

Counts move by one or two between runs: a handful of checks only exist when the shuffle produced the
situation they are about (a block being called for, a counterspell being castable), and those are
reported rather than asserted when it did not. A failure is a failure; a different total is not.

Run them one at a time. They are real browsers playing real games, and three of them at once on one
machine starves the others — a suite that times out under that load looks exactly like a suite that
found something.

The same caution applies to `pnpm run v2:test`. On a small machine a full-workspace run sometimes
exits 1 with `[vitest-worker]: Timeout calling "onTaskUpdate"` while reporting every test passed:
that is the runner failing to reach its own reporter, not a failure. Read the test counts, and if
in doubt run the changed package's suite on its own (`pnpm --filter @grimore/rules-engine test`),
which has never shown it. Four mitigations were measured and none fixed it — the details are in
`packages/rules-engine/vitest.config.ts`.

Every suite also watches the browser console for React's own complaints and fails on them, which is
not the same check as "no uncaught errors": `pageerror` only fires for an exception nobody caught,
and a render loop is something React logs before carrying on. One was found the hard way — 7,555
copies of "Maximum update depth exceeded" in the dev server's log, and a pod that stopped answering
taps during combat because the page was re-rendering instead (see `claude/decisions-log.md`, D73).

The tabletop suite plays a complete game through the real UI — lobby, decks, opening hands, card
movement across every zone, tokens, auras, searching, turns, chat, a winner — and checks that
neither browser ever receives the other's hand. The Arena suite does the same with the engine
running, taking whatever the UI offers rather than a fixed sequence, so it plays whatever the
shuffle deals; it checks that the engine never refuses something the table offered, and has modes
for the cases the shuffle makes rare:

The pod suite is the four-player one: four seats on one code, four opening hands at once, a
commander cast from the command zone and back in it after it died, attacks sent at more than one
opponent, a deal offered to another player and accepted on their table, a player conceding while the
other three carry on, and one survivor. `DECKS=` picks who plays what, in seat order.

```bash
DECKS=rot-harvest,tidal-mind,ember-rush,verdant-guard node scripts/e2e-pod.mjs
DECK_B=tidal-mind node scripts/e2e-arena.mjs     # counterspells, so the stack gets targeted
DECK_A=rot-harvest DECK_B=rot-harvest node scripts/e2e-arena.mjs   # graveyards and sacrifice outlets
DECK_A=arc-tempest DECK_B=arc-tempest node scripts/e2e-arena.mjs   # the spells deck, and a creature whose power is a *
DECK_A=skyward-writ DECK_B=hollow-tide node scripts/e2e-arena.mjs  # exalted one side, evolve the other
DECK_A=tidal-mind DECK_B=arc-tempest node scripts/e2e-arena.mjs    # the two cards that counter an ability
FORCE_MULLIGAN=1   node scripts/e2e-arena.mjs    # both players mulligan, whatever they drew
OPPONENT_DECK=rot-harvest node scripts/e2e-solo.mjs                # which deck the computer plays
SOLO_POD=1 node scripts/e2e-solo.mjs             # four seats, three of them the computer's
```

The layers under them have their own suites: `packages/rules-engine` (643 tests, including whole
games played out by bots that only ever send moves the engine offered them — four-seat Commander
pods as well as duels), `apps/web` (179 tests, the interaction reducer behind every prompt) and
`apps/realtime`
(31 tests against live Redis, including two socket clients playing to a finish, one person
playing the server, and a deal struck with the server's own seat).

## What is not done

- **Only the nine starter decks.** Loading one of your own Grimore decks, or pasting a decklist, is
  a small addition — `deck:load` already accepts any deck passed through `ActionContext.decks`, so
  it is a deck-source function and a picker in the lobby, not a redesign. In Arena mode an
  unscripted card still works as cardboard, with **Move by hand** for whatever it says in prose.
- **The engine knows two hundred and three cards.** Everything in the nine starter decks. It
  stops and asks for every decision those cards need: a spell's targets, a trigger's targets (CR 603.3d), a
  sacrifice paid as a cost, how big X is, a mode on a modal spell, and a decision made *while a
  card is resolving*. That last one is what makes a tutor work: Rampant Growth and Diabolic Tutor open your
  library to you and nobody else, Mind Rot is answered by the player discarding rather than by
  whoever cast it, and Fleshbag Marauder asks each player in turn order. A modal spell shows up as
  one play per mode when you tap it — Selesnya Charm offers three, and Grim Discovery offers each
  half and both — and a mode whose target is not on the board is not offered at all.
- **Every layer of the rules' own ordering is in** (CR 613), which is the paragraph that used to say
  the opposite. Copy effects and characteristic-setting effects were the long-standing example of
  what `effects.ts` could not express honestly, and they are now cards: Clone copies a creature as
  it printed, Turn to Frog *sets* a creature to 1/1 with no abilities, Mutavault becomes a creature
  without stopping being a land, Crimson Wisps changes a creature's colour, and Lhurgoyf is as big
  as the graveyards are. What is left is dependency ordering between two effects that each change
  what the other applies to (CR 613.8), which no card in the pool needs. Anything still beyond the
  engine resolves by hand, and the log says it was not automated.
- **The computer opponent is not a strong player.** It attacks only where the trade is not a
  loss, swings with everything when that is lethal, blocks the biggest thing each creature can
  handle, casts the biggest spell it can afford and mulligans a hand with no land in it. What it
  does not do is think about next turn: it will not hold a creature back to block or keep mana up
  for the counterspell in its hand. It plays a real game; it does not plan one. It is, however,
  **quick about it** — under a millisecond a decision in a duel and about five in a four-seat pod,
  so the wait at a table is the network rather than the opponent.
- **No card images**, for the reason above.
- **A pod plays, and the pod *interface* is plain.** Four browsers play one to a survivor every
  test run — commanders cast from the command zone and taxed, attacks aimed at whichever opponent
  you choose, a conceding seat skipped by everything. What is missing is everything a pod is
  socially: three opponents are three strips above your own board, whose turn it is reads as a gold
  border rather than a layout, and the politics is three preset deals and a badge rather than a
  table you can talk at.
- **Watching is read-only, and that is all it is.** A watcher sees both boards, both graveyards,
  the stack and the log, with both hands as face-down counts — and is offered no moves at all.
  There is no spectator chat: a watcher reads the table's chat and cannot write to it.
- **Undo is one step, and the host's.** It puts the table back to before the last move, including
  anything the engine or the computer's seats did in answer to it, and the chat says it was used.
  What it is not is a rewind: there is no second step back, no undoing an undo, and no taking back
  something three moves ago — for that, move the cards by hand and read the log. It also cannot
  unsee: the state it restores is exact, so a card drawn and taken back has still been looked at.
- **Pod politics is half the pod's own business.** The table says what going at each player is
  walking into, sends the whole swing at one of them in a press, and now records a deal: three
  preset things you can say to another player, their answer, and a badge on whoever went back on
  one. What it does not do is enforce any of it, deliberately — a table where the software stops
  you breaking your word is a table where your word costs nothing. Anything said beyond those three
  sentences is still between the people at the table, in the chat panel or out loud.
- **Websocket only.** A network that blocks WebSockets cannot play, because the server has polling
  disabled. Rare, but it would look like a table that never connects.
