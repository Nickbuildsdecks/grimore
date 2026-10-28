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
cards somebody has scripted — two hundred and seventy, today, across thirteen starter decks. A
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
| Use a planeswalker | Tap it on your battlefield and take one of its loyalty abilities. One a turn each, your main phase only, and a minus you cannot pay for is not offered. Four of them are in the pool, one per deck that wants one: **Jace Beleren** in Tidal Mind (cards, including the opponent's), **Garruk Wildspeaker** in Verdant Guard (untap two lands, a 3/3 Beast, or +3/+3 and trample for the team), **Ajani, Caller of the Pride** in Skyward Writ (a +1/+1 counter, or flying and **double strike** until end of turn — on a Serra Angel that is eight damage out of nowhere — or five 2/2 Cats at −8) and **Nissa, Voice of Zendikar** in Verdant Guard (a 0/1 Plant a turn, a +1/+1 counter on your whole team at −2, or life and cards as big as your lands at −7). The ultimates kill their own planeswalker, which is the rules rather than the card: nought loyalty is a state-based action. |
| Play two lands in one turn | **Explore** in Delta Bloom ({G}, sorcery) says "you may play an additional land this turn", and the table simply offers the land again: a land in hand that said **you have already played a land this turn** goes back to saying **playable**. The order does not matter — cast it before or after the turn's land and you still get two — and the permission ends with the turn, so an Explore cast with no land in hand is just a card. With Tatyova out each of those lands is also a card and a life, which is what the deck is for. Nothing else in the pool gives one, and the engine counts them per turn: a third land is refused with **you have already played 2 lands this turn**. |
| Block | **Declare blockers**, tap your creature, then tap the attacker it blocks. Only attackers it may legally block light up. |
| See who is attacking whom | Lines on the board: gold from each attacker to the player it is aimed at, dashed from each blocker to what it blocked. In a pod that is how you know an attack is yours to answer. |
| Work out who the threat is | Every seat strip says `board N` — the total power of that seat's creatures — and `· M up` for how much of that power is untapped. The first number is what can kill you eventually; the second is what can kill you on their *next* turn, and what can stop you on yours. A **lethal** badge on an opponent's strip means their untapped power alone is at least your life and you have nothing untapped to block with. |
| Choose who to attack | The attack prompt lists every player and planeswalker you may send an attack at, and each player's button says their life, their untapped power, and how many of your creatures are already pointed at them — plus **lethal** when that swing would finish them with nothing able to block. Tap a player, then tap the creatures that go at them; tap a different player and the next creatures go there instead. |
| Send everything at one player | With two or more creatures declared, **All at ⟨name⟩** re-points the whole swing at whoever is selected. For the turn where somebody's life total drops and the plan changes. |
| Cast a spell out of your graveyard | Three cards have **flashback**: Think Twice, Firebolt and Cackling Counterpart. Once one is in your graveyard, tap it there — it says **playable** like a card in hand — and it offers a second casting for its flashback cost, which replaces the printed one. It keeps its own timing (the Firebolt is still a sorcery), and it is **exiled** rather than buried afterwards, so there is no third casting. |
| Cast a spell with **convoke** | Two cards have it, both in Verdant Guard: Siege Wurm ({5}{G}{G}) and Conclave Tribunal ({3}{W}{W}). Each creature you tap as you cast it pays one generic mana or one of that creature's colour, so a seven-mana Wurm is castable off four lands and three creatures. The play says how many it will tap — **Cast Siege Wurm (convoking 3)** — and it taps none that your lands already cover, because a tapped creature cannot block. A creature that arrived this turn may still be tapped for it. |
| Cast a card **face down** | Eight cards have **morph**: Dirgur Nemesis, Zoetic Cavern and Willbender in Tidal Mind, Battering Craghorn and Zombie Cutthroat in Ashen Rite, Ainok Survivalist in Verdant Guard, and Master of Pearls and Hidden Dragonslayer in Skyward Writ. Each offers a second play — **Cast it face down ({3}, a 2/2)** — which is there even when you cannot afford the printed cost, and that is what the mechanic is for: a five-mana creature on turn three. Face down it is a 2/2 with no name and no abilities and nobody else can see which card it is. Tap it later → **Turn it face up**, pay the morph cost printed on it, and it is itself again — keeping its damage, its counters, whether it is tapped and how long it has been there, so one that has been down since last turn can attack the moment it is turned up. **Nobody can respond to that.** Turning a permanent face up uses no stack, so you can do it after blockers are declared: a 2/2 that becomes a 3/1 with first strike kills the creature blocking it and takes nothing back. Two of them have text on the back, which is what you hold them for: Ainok Survivalist destroys an opponent's artifact or enchantment when it is turned up, and Master of Pearls gives your creatures +2/+2 until end of turn — turn it up after blockers are declared and the attack they blocked correctly kills them instead. What they trigger goes on the stack and *can* be answered; the turning up cannot. Zoetic Cavern is the strange one — a *land* you may cast as a 2/2 instead of playing it, for the turn your hand has lands and nothing to do with them. Two of the seven do not cost mana the way the others do. **Zombie Cutthroat**'s morph cost is **pay 3 life** and no mana at all, so it turns up on a turn you spent everything — and at three life or less the table stops offering it, because a cost that would lose you the game is not a cost you may choose to pay. **Hidden Dragonslayer** has **megamorph**: same {3} face down, and turning it up for {2}{W} also puts a +1/+1 counter on it, so it comes up a 3/2 rather than a 2/1 — and its trigger destroys an opponent's creature with power 4 or greater, which is the card you were holding a 2/2 for. The counter goes on in the same breath as the turn-up: there is no window where it is face up and not yet bigger. |
| Cast **one half** of a split card | Two cards are **split cards**: **Fire // Ice** in Arc Tempest and **Wax // Wane** in Verdant Guard. One card, two spells, and you cast one of them — so the card shows up as **two** plays in your list, **Cast Fire** and **Cast Ice**, each with its own cost. There is no play that casts the card as itself, because there is no such spell. Fire is {1}{R} for two damage split between one or two things; Ice is {1}{U} to tap any permanent and draw a card; Wax is {G} for +2/+2 until end of turn; Wane is {W} to destroy an enchantment. Two things to know. On the stack it is **only** the half you cast, so a Counterspell aimed at your Fire is answering a red instant and nothing else, and "counter target creature spell" cannot touch either half. And in your graveyard afterwards it is the **whole card** again, mana value four for a Fire // Ice — which is what a Chalice of the Void set to two does *not* catch. If a half has nothing to point at, that half is simply not offered: a Wane with no enchantment on the table is not a play, and the other half still is. |
| Send a creature on an **adventure** first | Two cards are **adventurers**: **Merfolk Secretkeeper** in Hollow Tide and **Garenbrig Carver** in Delta Bloom. Each is a creature card with a spell printed on it, so it is offered twice — **Cast Garenbrig Carver** for {2}{G} as a 3/3, or **Cast Shield's Might** for {1}{G} to give a creature +3/+3 until end of turn. Cast the spell half and the card does not go to your graveyard: it goes to **exile**, and from then on your list offers **Cast Garenbrig Carver from exile (back from its adventure)** — the same creature, for its printed cost, whenever you can afford it. That is the whole point of the mechanic: one card, used twice, a turn or two apart. Merfolk Secretkeeper's half is **Venture Deeper**, {1}{U} to mill four, and the creature is a one-mana 0/4 wall. Two things to know. The adventure half is **not** a creature spell, so an Essence Scatter cannot counter it — but it can counter the creature when it comes back. And an adventure that gets **countered** never went on an adventure: that card goes to the graveyard like any other countered spell, and there is nothing to cast later. |
| Play a spell as a **land** instead | Two cards have a land on the back: **Hagra Mauling // Hagra Broodpit** in Ashen Rite and **Vastwood Fortification // Vastwood Thicket** in Blight Vector. The card in your hand is the spell — a three-mana instant that destroys a creature, a two-mana instant that puts a +1/+1 counter on one — and beside its cast your list also offers **Play Hagra Broodpit (the back of Hagra Mauling)**, which is a land drop rather than a spell. It comes in **tapped**: that is the printed price of never drawing a dead card, and it is why the engine's own opponent plays a basic first and keeps this one in hand until there is nothing better. Two things to know. The back face is a land *drop*, so it is one per turn like any other land, and playing it means not playing a Swamp this turn. And the card is still the **spell** everywhere else — in your hand, in your graveyard, and to anything that reads what a card costs — so a Chalice of the Void set to two does not catch a Hagra Mauling, and a Hagra Broodpit that gets destroyed goes to the graveyard as Hagra Mauling. Measured over 660 games: the Mauling was cast as removal 30 times and played as a land 30 times, and **every one of those 30 land drops was made with no other land in hand.** |
| Use a card whose text has an **if** in it | Three cards in Forge Alliance read the board rather than just doing a thing. **Chrome Steed** is a 2/2 that is a **4/4 while you control three or more artifacts** — and the deck has twelve, counting the Steed itself. **Etched Champion** is a 1/1 with **protection from every colour** on the same condition, which in this pool means no removal spell can be pointed at it, nothing coloured can block it and nothing coloured can damage it. Both turn on and off with no announcement: play a third artifact and the board shows the new numbers, lose one and it shows the old ones. There is nothing to respond to, because nothing happened — it is what the card has always said. **Galvanic Blast** is the one that is different: one damage, or **four** if you control three artifacts **when it resolves**. Answer one of those artifacts while the Blast is on the stack and it deals one, which is the play worth knowing on both sides of the table. Measured over 660 games: Chrome Steed is a 4/4 on 56% of the turns it is in play, and the Blast deals four on 21% of its casts. |
| Drive a **Vehicle** | Three cards are Vehicles: Sky Skiff and Renegade Freighter in Forge Alliance, Consulate Dreadnought in Rot Harvest. A Vehicle is an artifact and **not a creature at all** until it is crewed — it cannot attack, cannot block, and a sweeper that kills every creature leaves it sitting there, which is why its printed body is far above its cost. Tap it → **Crew N**, and the table taps enough of your own untapped creatures to reach N power and tells you how many before you press it (**Crew 2 (tapping 2)**). It picks your smallest creatures, because the big one is the one you want left standing. A creature that arrived this turn can still crew. The Vehicle is a creature until end of turn, and then an artifact again, still on the battlefield. Crewing *is* an activated ability, so unlike turning a morph face up it can be answered — and the creatures are tapped as the cost, so an answer leaves them sideways and the Vehicle inert. The board says **not crewed** on one that nobody is driving. |
| Use **Walking Ballista** | Cast it and pick the number: `{X}{X}` again, so X=2 costs four mana and it arrives as a 2/2. **{1}** puts another counter on it, and **removing a counter** shoots 1 damage at any target — a creature, a player or a planeswalker. The counter is the *cost*, so it comes off before the damage resolves: firing the last one makes it a 0/0 that dies on the spot, and the damage still happens. With no counters left the shoot option is simply not offered. |
| Use **Hangarback Walker** | Same `{X}{X}` arrival, and **{1}, {T}** grows it — so it cannot grow and attack in the same turn, which is the card. When it dies you get a 1/1 flying Thopter for **each counter it had**, counted from what was on it when it died rather than from the empty card in the graveyard. |
| Use **Chalice of the Void** | Cast it and pick the number. `{X}{X}` is that number paid **twice**, so X=1 costs two mana and X=2 costs four — the table only offers an X you can actually pay for. It enters with that many charge counters, and from then on **any** spell whose mana value matches is countered as it is cast, including yours. It is not a target and nothing chooses: a spell that matches is countered, a spell that does not puts nothing on the stack at all. Take the counters off it and it stops matching, which is the printed answer to one. |
| Use **Toxic Deluge** | {2}{B} in Hollow Tide, and the only card here whose whole text is a number you choose **while it is resolving**. Cast it, let it resolve, and the table asks "Pay how much life?" with a row of numbers to tap. Every creature on the table gets -X/-X until end of turn for X life — **yours too**, which is the card and the reason the question is worth thinking about. Two things about the numbers on offer. They stop one short of your life total, because a cost that kills you is not a cost you may choose to pay (CR 118.4), and they stop at the biggest toughness on the board, because -9/-9 and -4/-4 kill exactly the same creatures when nothing has five toughness. If that leaves only one number, the table takes it and does not ask. This is **not** an X cost: X is announced as a spell is cast and can be countered knowing how big it is, whereas this is chosen after every response, from the board as it ended up — which is why you hold it up rather than casting it on your own turn. |
| Use **Twincast** | {2}{U}{U} in Arc Tempest: copy any instant or sorcery on the stack, yours or theirs, and **you may point the copy somewhere else**. Cast it while the spell you want to copy is still waiting — your own Fireball on the turn the game ends, or their removal spell on the way to one of your creatures. The copy appears *above* the original, so it resolves first, and the table then asks "Point the copy somewhere else?" with one button per legal target and **Leave it** for keeping what the original chose. Three things follow from the rules and all three are worth knowing at the table. The copy is **not cast**, so a Guttersnipe or a Young Pyromancer across the table does not fire for it (CR 707.10). The copy is **not a card**: it does nothing on the way out and there is no second card in any graveyard afterwards. And the copy **can be countered** like any other spell, which is the answer the other player still has. A spell with two targets, or with damage divided among them, is copied exactly as it was aimed — the question is only asked when there is a single target to move. |
| Make your spells cheaper, or theirs dearer | Two permanents change what spells **cost**, which is a thing the table does to cards still in your hand. **Goblin Electromancer** ({U}{R} 2/2 in Arc Tempest): every instant and sorcery *you* cast costs {1} less. **Thalia, Guardian of Thraben** ({1}{W} 2/1 first strike in Skyward Writ): every noncreature spell costs {1} more — yours as well as theirs, which is the card. Three things follow from the rules. Only the **generic** part moves (CR 601.2f): an Electromancer leaves Counterspell at {U}{U} and Lightning Bolt at {R}, and takes Arc Lightning from {2}{R} to {1}{R}. A reduction stops at nought and never eats a coloured symbol or hands mana back. And the two cancel out when both are on the table: a {1}{R} spell with a Thalia and an Electromancer costs exactly {1}{R}. The card's printed cost never changes — the play sheet shows it with **−{1}** or **+{1}** beside it, so what you are paying and what the card says are both on the screen. |
| Get a creature past a blocker | Four ways, now that the pool has two more. **Flying** (and **reach** to block it) and **menace** have been here since combat was written. **Tormented Soul** ({B} 1/1 in Ashen Rite) **can't be blocked** at all — and can't block either, which is what pays for it. **River Boa** ({1}{G} 2/1 in Verdant Guard) has **islandwalk**: it cannot be blocked while the player it is attacking controls an Island, which is five of the eleven decks and nobody else. Landwalk is the one piece of evasion that is not a fact about the creature — it is a fact about the *other* player's lands at the moment blockers are declared, so the same Boa is unblockable in one combat and an ordinary 2/1 in the next. The table refuses a block it would not take and says why in the card's words. One more thing worth knowing: if the only creature attacking you cannot be blocked, you are not asked to block at all — a question with one answer is not asked. |
| Hold a creature down, or draw off one that gets through | Two cards in Tidal Mind that only exist because combat now tells a script what happened in it. **Wall of Frost** ({2}{U} 0/7 defender): whenever it blocks a creature, that creature **doesn't untap during its controller's next untap step** — so the turn it buys is two turns, not one. Attacking already tapped the creature, and it stays that way through its own untap step; the board shows **won't untap** on it, which is worth looking for before you plan a block around a creature that will not be there to make it. It holds down whatever it blocked, never a second attacker, and two Walls blocking the same creature do not hold it for two turns. **Ophidian** ({2}{U} 1/3): whenever it attacks and **isn't blocked**, you may draw a card — and if you do, it is removed from combat and deals no damage. The table asks after blockers are declared, which is the first moment anybody knows the answer: **Draw** takes the card and calls the attack off, **Attack** keeps the one point of damage. Almost always take the card. The exception is the turn one damage wins the game, which is the only reason the card asks. |
| Make something happen **later** | Two cards schedule something instead of doing it now, and the table shows it: under the stack there is a **later** row with the step it is waiting for. **Thicket Basilisk** ({3}{G}{G} 2/4 in Delta Bloom) destroys whatever it blocks or whatever blocks it — **at end of combat**, not at once, so the creature still deals its combat damage first and a 2/4 that survives it wins the exchange anyway. It is a deterrent more than a removal spell: nothing on the ground attacks into it twice. **Flickerwisp** ({1}{W}{W} 3/1 flying in Skyward Writ) exiles **another** target permanent on arrival and gives it back at the beginning of the next end step, under its owner's control. Three things it is good for: taking a blocker out of one combat, resetting an opponent's Journey to Nowhere so the creature under it comes straight back, and re-using one of your own arrival triggers. Killing the Wisp does **not** keep the card in exile — once the delay is scheduled it no longer belongs to the Wisp (CR 603.7d), which is the opposite of how a Journey works. |
| Take, keep and lose the **crown** | Two cards make you the **monarch** (CR 720): **Palace Sentinels** ({3}{W} 2/3 in Dawn Tithe) and **Thorn of the Black Rose** ({2}{B}{B} 2/3 deathtouch in Tidal Mind and Ashen Rite). Whoever holds it draws an extra card at the beginning of **their own** end step — not anybody else's — and the seat strip shows **monarch** beside their name, for everybody. The catch is the other half of the rule: **any creature that deals you combat damage takes the crown**, so it goes to whoever can get through, and an unblockable creature takes it back every turn. Damage that never landed — a Fog, a Healing Salve's shield, a blocker that ate it — steals nothing. Over 660 games the crown changed hands 142 times and drew 74 cards, which is the honest summary of what it is in a duel: less a card engine than a reason to attack. While the engine is running the crown is the engine's to move; on a tabletop it is still a thing somebody presses, like everything else there. The computer plays the rule too: in a pod it sends its attacks at whoever holds the crown before whoever is closest to dying. |
| Win without dealing any damage to anybody's life total | **Blight Vector** does it with **poison**. Eighteen of its cards have **infect**, and infect changes what the damage becomes: a player takes that many **poison counters** instead of losing life, and a creature takes that many **`-1/-1` counters** instead of marked damage. **Ten poison eliminates a player** (CR 704.5c) whatever their life total says, and the seat strip shows a **poison** count as soon as anybody has one. Two things are worth knowing at the table. The counters on creatures are **permanent** — marked damage is wiped at the end of every turn and a counter never is — so blocking a 1/1 with infect costs your 3/3 a point of size for the rest of the game, which is why the deck's creatures are all 1/1s and why nobody wants to block them. And **Tainted Strike** ({B}, instant) puts infect on *any* creature until end of turn, including one of yours that is already huge and, in a pod, somebody else's: ten poison arrives a lot faster on a 5/5 than on an Elf. |
| Play a **Saga** | Two cards are Sagas: The Birth of Meletis in Skyward Writ and The Eldest Reborn in Hollow Tide. A Saga is an enchantment that reads itself out over three turns. It arrives with one lore counter and **chapter I happens immediately** — you do not wait a turn for it — and it gets another counter at the start of each of your own main phases, never on anybody else's turn. Each chapter goes on the stack like any other trigger, so an opponent can answer the chapter even though they cannot stop the counter. Once the last chapter has resolved the Saga is sacrificed and goes to your graveyard; the card shows **lore** counters so you can see which chapter is next. Nothing can be killed in response to a Saga except the Saga: a creature removal spell does not touch it, and in this pool only three cards destroy an enchantment. |
| **Foretell** a card | Two cards have it: **Behold the Multiverse** in Arc Tempest and **Saw It Coming** in both Arc Tempest and Tidal Mind. On your own turn, tap the card in hand → **Foretell** and pay {2}; the card goes into exile **face down**, and nobody else can see what it is — only that there is a card there. From your next turn onwards it is a play again, out of exile, for the smaller cost printed on it (**{1}{U}** and **{U}{U}**). You cannot cast it on the turn you foretold it. The point is that it splits a four-mana spell across two turns, so you can hold up a counterspell without holding up the mana — which is the hardest thing in this pool to do and the one thing the computer genuinely cannot. Foretelling cannot be answered: no stack, nothing to respond to. |
| **Escape** a creature out of your graveyard | Two cards escape, and they are different kinds of card. **Phoenix of Ash** in Arc Tempest is a 2/2 flier with haste for {1}{R}{R}, and the line under it reads *Escape—{2}{R}{R}, Exile three other cards from your graveyard.* Once it has died, the card in your graveyard says **playable**: tap it and the table offers "Cast Phoenix of Ash from your graveyard (escape {2}{R}{R}, exiling 3)". Both halves of that are the cost. The three cards go the moment you cast it, before anybody can answer, and which three is the engine's choice — it spends the cards nothing else in your deck can use first, so a Think Twice down there is the last thing to go. **It is not flashback:** a Phoenix that escaped is an ordinary creature, so when it dies it is in the graveyard again, and it can escape again for three more cards. The graveyard is the limit, not the card. You need three *other* cards in there — three cards counting the Phoenix is not enough, and then the play is simply not offered. **Woe Strider** in Ashen Rite is the other kind: a {2}{B} 3/2 that arrives with a 0/1 Goat and has `{0}: Sacrifice another creature. Scry 1.` — a free sacrifice outlet for a deck with eight cards that read a creature dying, and one the opponent cannot answer by killing it, because it escapes for {4}{B} and three cards and arrives with a *new* Goat. It cannot eat itself: "another" is part of the cost, so the table never offers it. |
| Cast a seven-mana spell for one | Two cards have **delve**, both in Hollow Tide: **Gurmag Angler** (a {6}{B} 5/5) and **Treasure Cruise** ({7}{U}, draw three cards). Each card you exile from your own graveyard pays for {1} of the cost, so the Angler is a seven-mana creature on turn three and a one-mana creature once your graveyard is six deep. You do not choose the number: the table works out the fewest cards that make the spell payable and says so on the play — "Cast Gurmag Angler (delving 3)" — because your graveyard is also what your Think Twice and your Phoenix are waiting for, and spending it to save mana you were not going to use is the way to lose a long game. Delve only ever pays **generic** mana: seven Islands and a full graveyard still cannot cast the Angler, because nothing turns a card into a {B}. |
| Take somebody's graveyard away | Two cards answer the graveyard, and they are opposites. **Planar Void** in Blight Vector is a {B} enchantment: *whenever another card is put into a graveyard from anywhere, exile that card* — so while it is on the table nobody has a graveyard at all, including its own controller. No flashback, no escape, no delve, no Raise Dead, and a Lhurgoyf stays a 0/1. It is a trigger rather than a replacement, which is exactly how the card is printed: the card really does reach the graveyard and really is exiled afterwards, so a Blood Artist still sees the creature die. **Scavenging Ooze** in Delta Bloom is the patient version — {1}{G} for a 2/2, then {G} as often as you like to exile one card from any graveyard, and if it was a creature card the Ooze gets a +1/+1 counter and you gain a life. Point it at the card somebody is about to escape or delve with and it is removal and a clock at once. |
| Work out why your creature is bigger than its card | Three creatures are **lords**: they change the other creatures of their own type. Stromkirk Captain in Ashen Rite gives other **Vampires** +1/+1 and first strike, Knight Exemplar in Skyward Writ gives other **Knights** +1/+1 and indestructible, and Imperious Perfect in Rot Harvest gives other **Elves** +1/+1. None of them pumps itself — "other" is printed on all three. The board always shows the current size, and it changes the instant the lord arrives or leaves, with nothing to click: a Knight with three damage on it that was surviving because of the Exemplar dies the moment the Exemplar does. |
| Attack with **one** creature on purpose | **Guardians of Akrasa** in Skyward Writ is a 2/3 that cannot attack and has **exalted**: whenever exactly one creature you control attacks, *that* creature gets +1/+1 until end of turn. It is the number of attackers you **declared** that decides, not what is left in combat afterwards — so two attackers get nothing even if one of them is removed from combat before damage, and one attacker keeps the +1/+1 even if it is blocked by three creatures. The Guardians themselves are never the creature that grows, because a creature with defender never attacks. The pump goes on the stack as a trigger, so it resolves before blockers are declared and both players can see it coming. |
| Watch a creature grow itself | **Cloudfin Raptor** in Hollow Tide is a 0/1 flier for one mana with **evolve**: whenever another creature you control enters that has **greater power or greater toughness** than the Raptor, it gets a +1/+1 counter. Either one is enough — a 0/2 Fog Bank grows it on toughness alone — and once the Raptor is the biggest thing you control it stops growing. The condition is checked **twice**, which is worth knowing at the table: nothing goes on the stack at all when the creature that arrived is not bigger, and it is checked again when the trigger resolves, so killing or bouncing that creature in reply means no counter. The counters stay on the Raptor through anything that does not kill it. |
| Read a creature whose power is a **\*** | Two creatures are printed with a star instead of a number, and what it means is that their power is a count of something, read fresh every time anybody looks. Lhurgoyf in Rot Harvest counts the creature cards in *every* graveyard and its toughness is that plus one; Enigma Drake in Arc Tempest counts the instants and sorceries in *your* graveyard and keeps its printed toughness of 4. In hand the card still shows the star, because that is what the card says; on the battlefield the board shows the number it currently is. It changes with nothing announcing it — including downwards, if a graveyard gets exiled. |
| Send their removal somewhere else | Two cards change what a spell already on the stack is pointed at. **Willbender** in Tidal Mind is a morph: {3} face down, and {1}{U} to turn it up at the moment their removal is on the stack aimed at one of your creatures — then pick the spell, and pick where it goes instead. **Swerve** in Arc Tempest does the same for {1}{U}{R} as an instant, for an instant or a sorcery, and a burn spell aimed at your face can be aimed back at theirs. Three things to know. The new target has to be legal **for their spell** — a "target creature" spell cannot be sent at a player, and if the one you pick is illegal the spell simply keeps the target it had rather than being countered. The spell has to have exactly **one** target. And the table will not offer you a spell with nowhere else to go: if the thing it is aimed at is the only legal target on the table, changing it would change nothing. And Willbender is printed "spell **or ability**", which it now does: an ability is a row in the stack list rather than a card, so you tap the row. Swerve is spells only, because that is what *it* says. |
| Choose a word rather than a card | Two cards ask something no card can answer. **Obelisk of Urd** in Rot Harvest asks for a **creature type**: it has convoke, so a board of creatures pays for it on turn three, and every creature you control of the type you name gets +2/+2 for as long as the Obelisk is out — including ones that arrive later, so an Imperious Perfect making Elf Warriors keeps feeding it. **Voice of All** in Skyward Writ asks for a **colour**: a 2/2 flier with protection from whichever colour you name, which against the two decks holding this pool's removal is a creature they cannot target, block, damage or kill in combat. The bar shows the words as buttons and one tap is the whole answer — nothing to confirm, nothing to count. Both ask **while the card is still resolving**, which is what "as this enters the battlefield" means: there is no moment where the Obelisk is on the battlefield with no type chosen, so a removal spell held for exactly that window does not exist. The thirteen types offered are the ones this pool actually contains in numbers (eight copies or more); the real card says "any creature type", and a table cannot draw several hundred buttons. |
| Copy one of your own triggers | **Strionic Resonator** in Rot Harvest is an artifact for {2}: `{1}`, tap it, and copy a triggered ability **you control** that is waiting on the stack. Abilities are the rows in the stack list, so you tap the row — the same gesture Squelch and Disallow use, except that this one is looking for *your* trigger rather than anybody's. The copy is put on the stack above the original, so it resolves first, and it is a copy rather than a second activation: nothing is cast, no cost is paid twice, and anything that watches for spells being cast does not see it. Two things are worth knowing. The Resonator is not offered at all unless there is a trigger of yours there to copy, which is the table refusing to let you waste it. And the copy keeps whatever the original was **pointed at** — the printed card says "you may choose new targets for the copy" and that half is not offered yet, so copying a Gravedigger's trigger aimed at a card the original already returned gets you one creature back rather than two, with the copy countered for having nothing left to point at. Copy the triggers with no targets (a Zulaport Cutthroat's drain, a Wall of Blossoms' card, a Lotleth Giant's damage) and that never comes up. |
| Answer what a permanent is **doing** | Two cards counter an ability on the stack rather than the permanent that made it, and that is a different thing: by the time an Icy Manipulator's tap or a Jace's loyalty ability is waiting to resolve, destroying the card does not stop it — an ability on the stack is its own object and does not care whether its source is still there (CR 113.7a). **Squelch** in Arc Tempest is {1}{U}: counter target **activated** ability, and draw a card. **Disallow** in Tidal Mind is {1}{U}{U}: counter target spell **or** ability, either kind. Abilities are the rows in the stack list, so you tap the row; there is no card to tap, because an ability is a thing a permanent is doing and not an object anybody owns. Two things follow from that. Neither card is castable with nothing there to point at, which is the table refusing to let you throw it away. And a cost that was already paid stays paid: countering an Icy Manipulator's tap does not untap the Icy Manipulator, because the tap was the price of putting the ability on the stack in the first place. |
| Split one spell's damage between two things | **Arc Lightning** in Arc Tempest is {2}{R}: three damage divided as you choose among one, two, or three targets. Tap the card, then tap a target once for each point you want it to take — the bar counts down what is left ("2 of 3 left") and shows what each target has so far, and the spell is cast the moment the last point is spent. Tapping a target you have already picked adds **another** point to it rather than dropping it, which is how all three go in one place; **Back** peels the last point off. Three things follow from the rules. Every target has to be assigned at least one, which is why it is "one, two, or three" and not "up to three" — there is no way to point it at something and give it nothing. The division is announced as the spell is cast, so both players can read it off the stack (`Arc Lightning → Grizzly Bears (2), you (1)`) before deciding whether to answer it. And if one of those targets is gone by the time it resolves, only *its* share is lost: the rest still lands, and nothing is re-divided. |
| Have a creature with **ward** targeted | Two creatures have it: Dragonsguard Elite (ward {1}) in Verdant Guard and Sedgemoor Witch (ward {3}) in Tidal Mind. When an opponent aims a spell or an ability at one, their spell stops on the stack and **they** are asked: pay the ward cost, or let it be countered. Both answers are offered, because declining is often right — the removal is answered either way, and it cost them the card. If they cannot produce the cost at all they are not asked, and the log says the ward was not paid. It never triggers off its own controller's spells, so you can pump your own warded creature for free. |
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
| Play my own deck | In the lobby: **Paste a list of your own** → paste the text → **Use this list**. See *Play with your own list*. |
| Make tokens | **Token** has the common ones. A token that leaves the battlefield disappears, as it should. |
| Take something back | **Undo** in the top bar puts the table back to just before the last move — one step, and only the host sees the button. It takes back whatever the engine or the computer's seats did in answer to that move as well, because that is what happened, and everybody is told in the chat that it was used. With nothing left to take back the button is simply gone. It restores the state exactly, so a card that was drawn and then taken back has still been seen by whoever drew it — the same as at a kitchen table, and the reason it is one step and the host's call. For anything further back, move the cards by hand; the log shows what actually happened. |

**The table rolls for who goes first**, in both modes, across every seated player including the
computer's seats. (It used to be whoever created the table, every time.) The log says who won it,
and a rematch gives the previous winner the second turn, the way a table does.

The turn counter and the **Pass turn** button are bookkeeping, not enforcement — you can act on
anybody's turn, which is what makes instants and responses work at all.

### Eleven starter decks

**Ember Rush** (mono-red aggro), **Verdant Guard** (green-white midrange, and the one deck with
**two** planeswalkers in it now — Garruk Wildspeaker and **Nissa, Voice of Zendikar**, who makes a
0/1 Plant every turn and can put a +1/+1 counter on the whole board), **Tidal Mind**
(blue-black control, with counterspells, and **rebuilt** — six of its sixty slots at once, which is
the first change in its history that moved its record more than a point or two. Two **Thieving
Magpies** draw a card every time they connect, a **Sedgemoor Witch** makes a 1/1 for every instant
and sorcery in a deck still holding fifteen, two **Bloodthirsty Aerialists** grow off three
Nighthawks' lifelink, and a **Thorn of the Black Rose** takes the crown behind a 0/7 wall. What
left were its six least-cast cards. The deck that answered everything and killed nobody now wins
nearly three table turns sooner) and **Rot Harvest** (green-black, built on getting
creatures back out of the graveyard and on feeding them to sacrifice outlets, now with an
**Imperious Perfect** that taps for an Elf a turn to feed them with, an **Obelisk of Urd**
that names a creature type as it lands and makes every one of them +2/+2 — including the Elves the
Perfect has not made yet — and a **Strionic Resonator**, which copies one of its own triggers a
turn: a second Gravedigger's worth of creature, a second Wall of Blossoms' worth of cards, a second
drain off the same death — and which now offers the printed "you may choose new targets for the
copy", so the second Gravedigger's worth is a *second* creature rather than the same one), 60 cards each plus a commander, so a table can start with no setup at all. **Forge Alliance** (red-white) is the fifth:
a board of small creatures and a sword for one of them, with Balan — who pulls every Equipment you
control onto himself — as its commander. Its two newest cards are the pool's first `{X}{X}`
creatures: **Walking Ballista**, which is a creature on any curve, a mana sink on the turns the hand
is empty and the only removal here that costs no card, and **Hangarback Walker**, which grows
instead of shooting and leaves a flying Thopter for every counter when it dies — a board of small
creatures for the Loxodon Warhammer to pick up. **Ashen Rite** (black-red) is the first
deck whose costs are decisions: cycling lands that are a land early and a card late, spells with a
kicker you may pay for a bigger version of the same card, and removal whose cost is one of your own
creatures. Judith leads it, and makes every creature you lose a Shock on the way out. Eight of its creatures
are Vampires, which is more of one creature type than any other deck in the pool has, so it is also
where **Stromkirk Captain** lives: +1/+1 and first strike for the other eight, which turns a row of
0/1 Blood Artists into 1/2s that kill an attacker and take nothing back. Its newest card is a
**Fate Unraveler**, a 2/4 that takes a point off an opponent for every card they draw — the drain
plan attached to the one thing every deck does every turn, and the other half of the pool's new
draw trigger. Over 144 games it fires 75 times, and against the field the slot measures +5 on both
seed sets it was priced on.
**Skyward Writ** (white-blue) is the first deck whose plan is not to have the best
board: Walls that hold the ground and attack nowhere, two Counterspells and an Essence Scatter
because what beats it is a creature, a 2/3 that cannot attack and makes your lone flier bigger, a
flier that takes protection from whichever colour you name as it lands, and more fliers to win over
the top. Its newest card is **Ajani, Caller of the Pride**,
whose middle ability is the fastest clock in the pool: flying and double strike on a Serra Angel is
eight damage off a board that was holding the ground. Hanna leads it and buys an artifact or
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
deck is every creature it has. Its newest card is **Toxic Deluge**, in the Returned Centaur's old
slot: {2}{B} for "pay X life, all creatures get -X/-X", and the only card in the pool whose whole
text is a number you choose *while it is resolving*. It hits your own blockers too, so the number is
a real decision rather than a maximum — and against the field the slot measures three games of 240
either way, which is well inside the noise. It is in the deck because a mill deck with four removal
spells and no sweeper has no answer to a board it has already fallen behind. Beside it now sits a
**Chasm Skulker**, the first card in the pool that reads a *draw*: a 1/1 for three that takes a
+1/+1 counter every time you draw a card — the draw step, two Thought Scours, a Preordain, a
Divination, two Thieving Magpies and a Jace, Memory Adept — and leaves a 1/1 **islandwalker** for
every counter when it dies. Measured over 144 games it reaches the battlefield in about a third of
them and got as big as 13/13; against the field the slot is level, which is what a card that exists
to give a new rule something to read should be.

**And it does win that way, which somebody finally measured.** `mill.mjs` over 144 games: the deck
mills 22 cards a game, gets somebody's library to nought in **28% of its games**, and **40 of its
58 wins are empty libraries rather than damage**. The number that fixed it was the other one in the
same run — before a recent change the opponent's library was still at **24 on average** when the
game ended, which is a deck that is not short of mill but short of *turns*. A third Fog Bank for the
Essence Scatter (its fourth counterspell) measured +16 and +23 of 288 on two seed sets, and the
instrument then showed why: mill a game 18 → 22, the library at the end 24 → 20, mill wins 23 → 40.
One more blocker, and the plan got to finish.

**Arc Tempest** (red-blue) is the ninth, and it is the first deck here whose
creatures are paid for by its spells. Twenty-five of its sixty cards are instants and sorceries and
only seven are creatures, and every one of those seven reads the spells: Guttersnipe turns each cast
into two damage at the face, Young Pyromancer turns it into a 1/1, Gelectrode and Thermo-Alchemist
untap on each cast so their tap abilities become once-per-spell, and Monastery Swiftspear and
Stormchaser Mage get bigger. Enigma Drake is the one that does not wait for the rest: a 1/4 flier on
turn three whose power is however many instants and sorceries are in your graveyard by turn eight.
Its newest cards are **Swerve**, the only answer in these colours to a burn spell aimed at the
face — it aims it back — **Squelch**, two mana at instant speed that counters an activated
ability and draws a card, which is a cheap spell this deck's creatures all get paid for whether the
counter half matters or not, **Arc Lightning**, three damage split however you like among one,
two or three targets: the one card in the pool that kills two creatures without being a sweeper.
Adeliz, the Cinder Wind leads it and is the part a deck list cannot be — a 2/2 flier with haste that
is swinging for four the turn you cast two spells, and a Wizard herself, so the line works on an
empty board. It has no sweeper, no answer to a resolved noncreature permanent and no lifegain: it
expects to be the deck with the shorter clock, and against the two faster than it, to be the one
holding Counterspell.

**Dawn Tithe** (white-black) is the tenth and the newest, and it is the first deck here whose life
total goes **up** on purpose. Eight of the others measure the game in damage and one measures it in
cards; this one measures it in the gap between two life totals. Everything that enters the
battlefield — yours or theirs — gains it a life, and the gain is an *input*: Ajani's Pridemate grows
on the ground, Bloodthirsty Aerialist grows in the air, Blood Artist and Cruel Celebrant turn a
death into both totals moving at once, and Vraska's Contempt gains two life while it exiles the
thing that was killing you. Exsanguinate is the end of it — X from each opponent and X to you.
Kambal, Consul of Allocation leads it: an opponent's noncreature spell costs them two life and buys
you two, which is the one answer in these colours to the four decks whose plan is spells rather than
creatures. It has no sweeper, no counterspell and no haste, and its clock is two fliers that have to
survive a few turns — so against the fastest decks it is behind on the board and ahead on life,
which is the trade the whole list is built around.

**Delta Bloom** (green-blue) is the eleventh and the newest, and it is the first deck here whose
plan is its own **mana**. Every other list spends mana on a plan; this one's plan *is* the mana:
twenty-three lands — two more than anything else in the pool — nine things that make it faster than
a land does, and a top end nothing else here can reach on curve. Four of its eleven expensive cards
are X spells, which is the difference between this and Verdant Guard's ramp: a Mind Spring for seven
is a refill nothing else has, an Endless One is a creature as big as the mana, and a Hurricane ends a
game the board has already stalled — it hits its own controller too, which is why there is only one.
Tatyova, Benthic Druid leads it and turns the whole plan into a card draw engine: **every land you
play after her is a card and a life**, so the eighth land stops being the dead draw it is in every
other deck. **Explore** is the card that makes that a deck rather than a pile of ramp — one mana for
a card and *a second land this turn*, which with her out is two cards and two life. Its early turns
are the deliberate weakness: two Fog Banks, two Man-o'-Wars and three counterspells to survive to
turn six, and nothing at all that attacks before it.

**Blight Vector** (green-black) is the twelfth, and the only deck here that does not try to take
anybody's life total to nought. It wins with **poison**: eighteen of its sixty cards have **infect**,
so their damage is poison counters on a player and `-1/-1` counters on a creature, and **ten poison
ends the game** however much life you have left. Everything in it is small — four Glistener Elves,
four Ichorclaw Myrs, three Blight Mambas, three Plague Stingers — and the other half of the list is
there to make small creatures connect: six pump spells, two Tainted Strikes, a Loxodon Warhammer,
and Blossoming Defense for the removal spell aimed at the one creature that matters. Two things make
it frightening. `-1/-1` counters are **permanent** where marked damage is wiped at end of turn, so a
1/1 that trades blows with a 3/3 leaves a 1/1 behind for the rest of the game — and **Phyrexian
Crusader** has protection from red *and* white, which is where nearly all of this pool's cheap
removal lives. Skithiryx, the Blight Dragon leads it: a 4/4 flier with infect is four poison a swing
and regenerates for {B}{B}. Its weakness is the one the numbers show plainly — every creature in it
dies to one blocker, and it loses 3-21 to Ember Rush.

**Kindle Grove** (red-green) is the thirteenth, and it exists because a card had nowhere to live:
twelve decks covered every pair of colours but this one, which was invisible until Assault // Battery
turned up as a split card with a red half and a green half and no deck that could cast both. Red
kills a creature for one mana, green plays a bigger one for five, and the deck is those two in that
order — eight cheap interactive cards, four ways to reach five mana a turn early (two Llanowar
Elves, two Rampant Growths), and then Thragtusks, a Shivan Dragon, a Pelakka Wurm and a Gruul
Ragebeast. It is the only deck here whose removal is mostly **combat**: two Prey Upons and the
Ragebeast point your creature at theirs rather than pointing a spell at anything, which is the
red-green trade — the answer costs a creature instead of a card. Two cards are worth knowing at the
table. **Rancor** is +2/+0 and trample for one mana that **comes back to your hand** when it leaves
the battlefield, so killing the creature does not answer the Aura. And **Thragtusk** gains five as
it arrives and leaves a 3/3 behind when it *leaves* — exiled or bounced as well as killed — so a
removal spell spent on it trades a card for half a card and five life. **Ruric Thar, the Unbowed**
leads it, and he is a tax on the whole table including his own side: six damage to **whoever** casts
a noncreature spell, and every creature in play must attack each combat if able. Against the pool's
three control decks that is a good matchup — it beat Tidal Mind 20-4 before that deck was rebuilt and
15-9 after — and against Ember Rush it is a 10-14 underdog, because a six-mana commander is four
turns too slow for that one.

Each two-colour deck runs a pair or three of Guildgates: one mana of either colour, and they come in
tapped, and eight of the ten also run a pair of cycling lands. Any pairing works, including a deck
against itself. They are not the only decks you can play, though: see *Play with your own list*.

A note on what to expect from each: played against each other by the engine's own opponent, the
aggressive decks win more. Skyward Writ is the clearest case of the bot rather than the deck: it is
level with the field and loses to the two fastest decks there — holding mana for a counterspell is
half its plan and the bot cannot do it. A person plays it better. The same caveat applies twice over
to Arc Tempest: holding up Counterspell is half its plan against the fast decks, and the bot casts
it the turn it can afford it.

**That caveat is now a number rather than an impression.** `held-answers.mjs` counts every moment an
opponent had a spell on the stack and the deck held a counterspell, and says what happened — cast
it, answered the spell with a different card, could afford it and chose otherwise, was never
actually offered it, could not pay, or had nothing to point at. Over 144 games each, with the fix
below turned off:

| | windows | cast | **affordable, declined** | **could not pay** |
| --- | --- | --- | --- | --- |
| Tidal Mind | 229 | 7% | **0%** | **87%** |
| Arc Tempest | 151 | 12% | **3%** | **77%** |
| Skyward Writ | 218 | 30% | **0%** | **54%** |

It is not that the computer counters the wrong things. It is that it has already spent the mana: a
seat that taps out in its own main phase has none for the whole of your turn, because lands untap in
their own controller's untap step. Tidal Mind's Disallow was cast **4 times** in 144 games against
**118** moments it could not pay for.

**That is fixed now, and the fix does not make the decks stronger.** The bot keeps back the mana its
cheapest answer in hand needs, on its own turn only, and only when a play would actually take that
answer away — so Tidal Mind's windows read **44% cast and 41% could-not-pay** where they read 7% and
87%. Its record barely moves for it (the five counterspell decks gained one game between them across
288 each), because the turns it spends holding two mana up cost roughly what the counterspells buy.
What changes is that the deck now does the thing it is built to do, which is what you will notice
sitting across from it. If you would rather play against the old tapped-out version, that is
`reserveForAnswers: false` in the bot's options.

**And the judgement half turned out not to be a problem.** The worry was that a bot which can now
pay would spend its Counterspell on a Rampant Growth while the Shivan Dragon waited a turn. Over 432
games across the three decks it declined an affordable answer **13 times in 556 windows**, every one
of those 13 spent on another instant in the same window, and the spells it let through were cheaper
than the ones it countered rather than more expensive. So there is nothing here to fix, which is
also why it does not read as a cheat: it counters your creatures and lets your cantrips through.

**The decks are not all equally strong, and now there is a table of it.** Every deck against every
other, both seats, 288 games each (`SEEDS=12 node scripts/measure/deck-table.mjs`):

```
 75%  217-71   ember-rush
 63%  181-107  dawn-tithe
 62%  178-110  verdant-guard
 58%  168-120  forge-alliance
 57%  164-124  kindle-grove
 53%  153-135  skyward-writ
 42%  120-168  arc-tempest
 41%  119-169  ashen-rite
 41%  118-170  hollow-tide
 41%  118-170  delta-bloom
 39%  111-177  tidal-mind
 39%  112-176  rot-harvest
 39%  111-177  blight-vector
```

**The bottom of that table used to be a cliff and is now a cluster.** Tidal Mind spent five runs
eleven points below the next-worst deck; the six-slot rebuild described below moved it **28% → 39%**,
and the bottom five decks are now within two points of each other. The spread across the whole field
is thirty-six points where it was forty-eight.

That run is also the first with the **mana-reservation rule** on, so the aggressive decks at the top
each give up a point or two — their opponents now answer things. Measured both ways on the same
seeds, the five decks that hold counterspells moved **+1 between them**: Hollow Tide +4, Tidal Mind
+2, Arc Tempest −1, Skyward Writ −2, Delta Bloom −2. That is the point of the rule rather than a
disappointment about it — see the window table above.

**The rest of this section is the history of that table, run by run, newest first.**

**Six slots at once, which is what finally moved Tidal Mind.** Twelve single- and two-slot changes
had been priced against this deck and all twelve came back inside the instrument's own noise — the
same list measures 83, 64, 88 and 90 wins of 288 on four seed sets, so a twenty-game swing is what
the harness does when nothing has changed. The six-slot rebuild came back **+47 and +38 on two seed
sets**, and **split into two halves of three it vanishes again** (+8/+20 and +12/+19, both inside the
floor). What went in: two **Thieving Magpies**, a **Sedgemoor Witch**, two **Bloodthirsty Aerialists**
and a **Thorn of the Black Rose** — four fliers, a token engine and the crown, for the deck's six
least-cast cards. `killed-by.mjs` had asked for exactly this and confirms it got it: on the same 144
games the deck went **42-102 to 77-67**, and its **wins come on table turn 24.9 rather than 27.6**,
from the same comfortable 20-odd life. It was never close to losing the games it won; it just took
too long to end them. Two of the cuts had to be *relocated* rather than dropped, because nineteen of
this deck's forty-one slots were the pool's only copy of that card: the Twincast went to Arc Tempest
and the Phyrexian Arena to Ashen Rite. D167 has all of it.

**Tidal Mind was 27% in an earlier run rather than 22%, and one card did it.** The table had said
"the worst deck in the pool by sixteen points" three times without anybody acting on it, so that run
was the first where somebody did. `cast-counts` found the problem in one line: **Diabolic Tutor, cast in
8 of the 46 games it was in hand — 17%**, the deadest card in any deck in the pool. Four mana for a
card you then have to cast is a turn spent doing nothing, and a deck that spends turns doing nothing
against this field dies holding answers. A **third Vampire Nighthawk** in its place measured **+27 of
264** with nine matchups up, two level and none down, and it is the largest single slot change this
project has measured. **Six other candidates were priced and six did nothing**: a second Wind Drake
for the Mind Rot (+2), a third Man-o'-War for the Twincast (−5), Cancel for a Man-o'-War (−6), a
Swamp for an Omenspeaker (−19), a second Dirgur Nemesis (−2) and a **fourth** Nighthawk (−13). The
honest reading is that the rest of the list is not the problem: it is still the deck whose plan —
hold mana, answer the threat, win later — is the one the computer cannot pilot, and a person plays
it better than 27%.

**That run is also the twelfth deck's debut, and Blight Vector lands eleventh at 37%** — every row is 264
games rather than 240 because there is one more opponent, and the order is the order it has been for
four of these runs with the new row near the bottom. Three movements are worth naming rather than
leaving to be noticed: **Dawn Tithe is up five points** (57% to 62%), which is Palace Sentinels and
matches the +15 of 240 the paired probe measured for that slot; and **Blight Vector's own row understates it** — it beats Tidal Mind 15-9
and Arc Tempest 14-10 and loses 3-21 to Ember Rush, which is a deck with matchups rather than a deck
that is simply bad. What the row cannot show at all is the thing the deck is for: **80% of its games
put poison on somebody, and every one of its wins in the last measured run was a poison kill rather
than a damage kill.**

**That run is also the pool's first four two-faced cards, and the field did not move for them.**
Fire // Ice is in Arc Tempest, Wax // Wane in Verdant Guard, Merfolk Secretkeeper in Hollow Tide and
Garenbrig Carver in Delta Bloom — one card each, in place of one card each — and the spread is the
same 28%–78% it was before. Three of the four priced inside the duel floor and one above it: **Wax //
Wane is +19 of 264** in Verdant Guard, which is the only one of the four that is an improvement
rather than a free swap, and it is +19 *while never once casting the Wane half* — four enchantments
in twelve decks is a pool where "destroy target enchantment" has nothing to point at, so the card is
a one-mana +2/+2 and that is better than the Naturalize it replaced. Delta Bloom's +4 points
(45% → 47%) is the other movement worth naming, and it is the adventurer: the bot casts Shield's
Might and then casts the creature back out of exile 95% of the time, which is two cards in one slot
in a deck that wants bodies early.

**That run is the thirteenth deck's debut, and Kindle Grove lands fifth of thirteen at 59%** — every
row is 288 games rather than 264 because there is one more opponent, and the order above it is
unchanged. Its own row is the matchups rather than the total: it beats **Tidal Mind 20-4**, Ashen
Rite 19-5, Rot Harvest 17-7 and both mill decks, and it loses 10-14 to each of the three decks above
it. That is the deck working as written — a commander that costs the whole table six life per
noncreature spell is close to unanswerable for three control decks and four turns too slow against
the 76% aggro deck — and it is also the limit named in the deck's own write-up before it was
measured: the computer plays a deck of big creatures better than it plays a deck of answers, so
expect this row to read higher than a person would make it.

**Forge Alliance is four points lower in that run than in the one before it, and the change that
did it measured +9 and +8 of 264 on two other seed sets.** All three readings are inside the
eighteen-game floor, so the three metalcraft cards are **free rather than good** — and the −12 is
printed beside the two positives because a measurement at the floor is one the instruments cannot
resolve. What `deck-table` cannot show at all is whether the ability those cards are *for* was ever
live, and `metalcraft.mjs` can: Chrome Steed is a 4/4 on **56%** of the turns it is on the board, at
a mean of 2.6 artifacts.

**And the two modal cards before them moved nothing either**, which is what "free" looks like on a
table: Ashen Rite 44% to 42% and Blight Vector unchanged at 38%, against paired probes of +2 and −4
of 264 — the same two points, read twice. What the table cannot show is the thing those two cards
are for, and `halves-use` can: Hagra Mauling was cast as removal 30 times and played as a land 30
times over 660 games, and **all 30 of those land drops were made with no other land in hand**. It is
also the first card in the pool that `cast-counts` reads at **100%** — used in every game it was in
hand, because its worst case is a land.

The table before these four, for comparison: Ember Rush 77%, Forge Alliance 64%, Verdant Guard 63%,
Dawn Tithe 61%, Skyward Writ 58%, Ashen Rite 45%, Delta Bloom 45%, Arc Tempest 43%, Hollow Tide 41%,
Rot Harvest 38%, Blight Vector 37%, Tidal Mind 27%.

The eleven-deck table before that: Ember Rush 78%, Forge Alliance 67%, Verdant
Guard 63%, Dawn Tithe 57%, Skyward Writ 55%, Ashen Rite 46%, Delta Bloom 42%, Arc Tempest 40%,
Hollow Tide 38%, Rot Harvest 37%, Tidal Mind 27%.

**The eleventh deck's debut, kept because the note is still true:** Every row is 240
games rather than 216 because there is one more opponent, and every other deck moved by a point or
two in consequence — the field effect D108 found, for the third time, with the order unchanged apart
from the new row. The new deck's shape is in its matchups rather than its total: it is 12-12 with
both mill decks and beats the two grind decks (16-8, 15-7), and it loses **4-20 to Ember Rush** and
5-19 to the two white midrange decks. That is the deck working as written — nothing in it attacks
before turn six — and it is the clearest statement in the table of what the bottom of this pool
actually is: a deck that needs to survive to turn seven against a field with a 78% aggro deck in it.

The run before it was the two planeswalkers, and the two decks that got one were the two that
moved up.
Verdant Guard 52% → 61% (+18 games of 216) for Nissa, Voice of Zendikar, and Skyward Writ 50% → 53%
(+7) for Ajani, Caller of the Pride, on the same seeds as the run before. Both cards' paired probes
had called them free — Nissa at +15 and +5 of 270, Ajani at +1 and +5 — so this is the clearest case
yet of the thing the measurement README warns about: a reading at the floor is a reading the paired
probe cannot resolve, and the table found Nissa's the larger of the two. Verdant Guard is third now
rather than fourth; it is the same band as Dawn Tithe and well under Forge Alliance, with no matchup
worse than 20-4 against the deck at the bottom of the table. If the next change pushes it further,
it is the deck to look at.

**The same seeds were also run with Arc Lightning and the Strionic Resonator in and the two
planeswalkers out**, and that run came back 78/66/61/52/50/48/40/39/38/27 — the same order and
within a point of the ten-deck run above it on every row. Two cards whose paired probes said "free"
moved the table by nothing at all, which is the first time this project has had both instruments
agree on a *null* result.

The run before it was the first with **ten** decks in it, and it was the field effect D108 found
happening again on a bigger scale: every row is 216 games rather than 192 because there is one more
opponent, and nine decks that changed nothing at all moved by one to four points because the field
they are measured against changed. Read the order, not the numbers.

Dawn Tithe arrives at 62% and third, which is the second number it had. **The first version of the
list came in at 66%** — second in the pool, winning the four slowest matchups between 19-5 and
22-2, which is a matchup nobody enjoys from either side. Cutting the second Bloodthirsty Aerialist,
the second Vraska's Contempt and the Exsanguinate for two more one-mana lifegain spells and a third
Child of Night measured −14 and −14 over 270 paired duels on two seed sets, and the version above is
the one that measurement approved. What is left lopsided is Dawn Tithe against Tidal Mind (22-2),
Arc Tempest (20-4) and the two mill-and-grind decks (18-6 each) — and those four are the bottom of
this table against *everybody*: Ember Rush beats Tidal Mind 23-1. The deck is third; the bottom of
the table is the open problem, and it is a bot problem rather than a card problem.

The run before it was after the two cards that ask for a word, with nine decks, and it was the
quietest this table has ever been: nothing moved by more than two games in a hundred and ninety-two,
and the two decks that changed a card moved by one game and none — which is what it should look like
when both slot measurements say the change is free.

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

Delta Bloom's Kiora's Follower is the clearest single example of that gap. "{T}: untap another
target permanent" is a card you untap a Guildgate with to hold up the Counterspell in your hand,
which is the one thing three separate measurements say this bot cannot do — so it presses the
ability about once in a hundred and twenty games, and only ever to pay for a spell it is casting
right now. Before the rule that asks what an untap *buys*, it pressed it 165 times in those games
and 29,432 with a second copy in the deck, because two of them untap each other for ever and the
board ends where it started (`claude/decisions-log.md`, D143). The card stays in the list for the
person playing it.

Tidal Mind is the deck most of this work has gone into and still the one at the bottom. Its
newest cards are the two that answer what a permanent is *doing* rather than the permanent:
**Disallow** counters a spell or an ability, either kind, and **Willbender** — a {3} face-down 2/2
that blocks on a turn it has nothing else to do, and a {1}{U} turn-up — now sends an ability
somewhere else as readily as a spell. A trick that is also a body, and the deck's whole plan is
answers.

Its newest card is **Chalice of the Void**, and it is the clearest case in this document of a card
the computer cannot use. For {X}{X} it enters with X charge counters and counters every spell —
yours as well as theirs — whose mana value is that number: on one, it is a wall in front of Ember
Rush's twenty-two one-drops and costs this deck four spells of its own. In a person's hands that is
a turn-two play that decides the game. The computer draws one copy of it out of sixty cards on about
its seventh turn and casts it then, which is after the spells it would have stopped, so over 240
measured games it moved *nothing at all* against the three fastest decks. If you play this deck
yourself, it is a different card.

Tidal Mind used to be the outlier at 25%, and what fixed it was not the obvious thing. Nothing in
the deck was dead — every card got cast in a majority of the games it was drawn — and the deck's
own counterspells were among its most-used cards. What it lacked was a way to *win* the games it
survived, so three counterspell copies became a second Fog Bank, a second Vampire Nighthawk and a
third Man-o'-War. That is worth nothing at all against the fastest deck in the pool and five to ten
games against every slower one. D114 has the whole measurement.

**It took one more pass to finish, and the useful part is how long it took.** Twelve further
changes were priced one and two slots at a time and every one of them came back inside the
measurement's own noise — a twenty-game swing on 288 duels is what the instrument does when nothing
has changed at all. Six slots at once came back **+47 and +38 on two seed sets**, and split into two
halves of three it vanished again. A deck that loses for want of a clock does not have a slot wrong
with it; it has a shape wrong with it, and a shape is not priceable one card at a time. D167 has it,
along with the reason the earlier passes were boxed in: nineteen of this deck's forty-one slots were
the pool's only copy of that card, so its deadest cards could not be cut without deleting a script's
only test. Two of them moved to decks that wanted them instead.

The decks share a pool of two hundred and seventy cards, which now includes a wrath, a
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

### Seeing what is in a deck

Under every deck in the lobby and in the deck picker there is a **What's in it** line. It opens the
list: lands, creatures and spells, each sorted by cost, with the deck's colours, its commander and
a small curve across the top. It is shut until you ask, because the first thing on that screen
should still be "pick one and start" — and it is the quickest way to answer the question the deck
names cannot ("does this one have a sweeper in it?").

Cards are text rather than pictures here for the reason given further down: there is no card
artwork in this product, so a face is its name, cost, type line and rules text.

### Play with your own list

The decks above are what the engine has scripts for. They are not the limit of what you can sit down
and play: in the lobby, under your deck, there is **Paste a list of your own**. Paste the text you
already keep your deck in and press **Use this list**.

**Your browser keeps the last list you pasted.** Press *Paste a list of your own* again on any
table and there is a **Last list I pasted** button beside the box: one tap and the text is back.
It lives in this browser's storage and nowhere else — it survives a reload and a new table, it does
not follow you to another device or another browser, and private browsing simply never offers it.

It is deliberately relaxed about format. Counts can be `4`, `4x` or missing; set codes and collector
numbers (`Forest (M21) 262`) are thrown away; `Deck`, `Commander`, `Sideboard` and `Maybeboard`
headers are understood, the first card under `Commander` goes to the command zone, and a sideboard is
left out with a note saying so. It is strict about size — 250 cards, 150 different names, 40 per line
— and a list it cannot read is **refused** rather than half-loaded, with the reason on screen.

What comes back is one line: how many cards it found, and how many of them the engine has no script
for. For example:

```
60 cards · 2 the engine does not know (Sol Ring, Dockside Extortionist) — tabletop only
```

Those two cards are **cardboard**: a card with a name and nothing else, which is exactly what it is
at a kitchen table. You move it by hand, and you read it off the card you are holding.

**That decides which of the two games you can start.** The tabletop plays anything, so it is always
offered. Arena mode is not: with one unreadable card in the deck, **Play with the rules engine** is
disabled and the table says which card and why, because an automated game containing a card the
engine cannot read is a game with a card nobody — engine or player — can do anything with. Paste a
list built out of the pool and the engine runs it like any built-in deck: the lobby says *every one
of them scripted*, and the cards play exactly as they do in the deck they came from.

Everybody at the table sees the name, the size and that unreadable count on your seat — never your
cards. It is there because the host is the one pressing Start, and a disabled button that does not
say whose deck is the problem explains nothing. **Play again** re-deals both lists.

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
node scripts/e2e-table.mjs      # two browsers, tabletop mode          — 73 checks
node scripts/e2e-arena.mjs      # two browsers, rules engine           — 52-58 checks
node scripts/e2e-pod.mjs        # four browsers, a Commander pod       — 42 checks
node scripts/e2e-solo.mjs       # one browser, against the computer    — 23 checks
SOLO_POD=1 node scripts/e2e-solo.mjs   # one browser, a pod against three — 24 checks
```

Counts move by one or two between runs: a handful of checks only exist when the shuffle produced the
situation they are about (a block being called for, a counterspell being castable), and those are
reported rather than asserted when it did not. A failure is a failure; a different total is not.

The combat-arrow check is the subtlest member of that family, and it took two passes to get the
guard right. An *empty* attack declaration draws no arrow, so it used not to count as a swing; and
with auto-pass on, a **non-empty** attack against a defender with no legal block runs blockers,
damage and end of combat inside one applied action — the browser renders the board after all of
that, so there is no moment at which an arrow exists to be found. The arrow is now required only
when one was seen or the table is still sitting in a combat step, and a declaration that ran past
combat in one action is reported instead. `arena.test.ts` owns the deterministic version of the
overlay's claim.

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

The solo suite plays its duel on a **pasted list** rather than a deck it picked: it writes Ember
Rush's own sixty cards out as text, pastes them into the lobby and plays the whole game under the
engine, which is how the paste path is proved rather than described. The tabletop suite pastes a
list with a card the engine has never scripted, checks the engine is refused and the tabletop is
not, then pastes one without it and plays the rest of its game on it.

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
DECK_A=rot-harvest DECK_B=skyward-writ node scripts/e2e-arena.mjs  # a question whose answer is a word
DECK_A=dawn-tithe DECK_B=ember-rush node scripts/e2e-arena.mjs     # lifegain against the fastest deck
FORCE_MULLIGAN=1   node scripts/e2e-arena.mjs    # both players mulligan, whatever they drew
OPPONENT_DECK=rot-harvest node scripts/e2e-solo.mjs                # which deck the computer plays
SOLO_POD=1 node scripts/e2e-solo.mjs             # four seats, three of them the computer's
```

The layers under them have their own suites: `packages/rules-engine` (923 tests, including whole
games played out by bots that only ever send moves the engine offered them — four-seat Commander
pods as well as duels), `apps/web` (210 tests, the interaction reducer behind every prompt and the deck panel) and
`apps/realtime`
(43 tests against live Redis, including two socket clients playing to a finish, one person
playing the server, a deal struck with the server's own seat, and two players rematching on
decks they pasted in).

## What is not done

- **A list of your own plays, but only the pool is automated.** Paste your decklist in the lobby and
  the table deals it (see *Play with your own list*). Every name the engine's pool has — the two
  hundred and thirty-seven cards in the eleven starter decks, commanders included — becomes the real
  card and is fully automated. Every name it does not becomes **cardboard**: a card with a name and
  nothing else, which the tabletop plays by hand with **Move by hand** for whatever it says in
  prose, and which Arena mode refuses by name rather than dealing a game with a card nobody can do
  anything with. Closing that gap needs card data for arbitrary names — type lines, mana costs,
  oracle text — which means a populated `cards` table, which means a machine that can reach
  Scryfall. Loading a saved Grimore deck rather than pasting text is the same gap: the deck source
  exists, the card data does not.
- **The engine knows two hundred and seventy cards.** Everything in the thirteen starter decks,
  plus the ten castable *faces* of the seven cards printed with more than one. It
  stops and asks for every decision those cards need: a spell's targets, a trigger's targets (CR 603.3d), a
  sacrifice paid as a cost, how big X is, a mode on a modal spell, how a divided quantity is spent
  among its targets (CR 601.2d), a number chosen *as a spell resolves* rather than as it is cast
  (Toxic Deluge), where a **copy** is pointed once it exists (Twincast, Strionic Resonator), and a
  decision made *while a card is resolving*. What a spell costs is a question about the board as
  well: a Goblin Electromancer takes {1} off yours and a Thalia puts {1} on everybody's, and the
  play sheet shows the change beside the printed cost rather than instead of it. That last one is what makes a tutor work: Rampant Growth and Diabolic Tutor open your
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
- **Watching is read-only about the game, and not about the table.** A watcher sees both boards,
  both graveyards, the stack and the log, with both hands as face-down counts, and is offered no
  moves at all. It **can** talk: the chat drawer is on a watcher's screen now, and the line it
  sends is marked `watching` by the server so the people playing can tell a spectator's "I'm
  responding to that" from an opponent's. That mark is the reason the drawer was worth adding
  rather than the other way round — the server had accepted a spectator's chat since the day
  watching was built, and with no name it arrived reading "Player".
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
