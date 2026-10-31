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
cards somebody has scripted — three hundred and thirty-three, today, across thirteen starter decks. A
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
| Pay for it | Nothing. The engine taps what the spell costs — including picking which colour a dual land makes, and spending a Sol Ring's two mana before it taps a second land. Tap lands yourself first if you want particular ones spent. **A hybrid symbol is paid either way**: `{B/R}` is one mana that a Swamp or a Mountain can pay, so **Murderous Redcap** ({2}{B/R}{B/R} in Ashen Rite) comes down off four Swamps, four Mountains, or any mixture, and **Kitchen Finks** ({1}{G/W}{G/W} in Verdant Guard) off any three of that deck's Forests and Plains. The engine works out which half of each symbol to pay — and it has to *search* rather than guess, because two hybrid symbols can compete for the same land. |
| Choose a target | The legal ones light up. Tap one. A spell on the stack is targeted by tapping its row in the stack panel. |
| Respond to their spell | While it is on the stack you hold priority — cast your instant, then pass. |
| Attack | **Declare attackers**, tap the creatures, confirm. One that cannot attack is not tappable, and says why. |
| Attack a planeswalker | Pick it from the row of targets in the attack prompt, then tap the creatures that go at it. Different creatures can go at different players and planeswalkers in the same attack. |
| Use a planeswalker | Tap it on your battlefield and take one of its loyalty abilities. One a turn each, your main phase only, and a minus you cannot pay for is not offered. Four of them are in the pool, one per deck that wants one: **Jace Beleren** in Tidal Mind (cards, including the opponent's), **Garruk Wildspeaker** in Verdant Guard (untap two lands, a 3/3 Beast, or +3/+3 and trample for the team), **Ajani, Caller of the Pride** in Skyward Writ (a +1/+1 counter, or flying and **double strike** until end of turn — on a Serra Angel that is eight damage out of nowhere — or five 2/2 Cats at −8) and **Nissa, Voice of Zendikar** in Verdant Guard (a 0/1 Plant a turn, a +1/+1 counter on your whole team at −2, or life and cards as big as your lands at −7). The ultimates kill their own planeswalker, which is the rules rather than the card: nought loyalty is a state-based action. |
| Play two lands in one turn | **Explore** in Delta Bloom ({G}, sorcery) says "you may play an additional land this turn", and the table simply offers the land again: a land in hand that said **you have already played a land this turn** goes back to saying **playable**. The order does not matter — cast it before or after the turn's land and you still get two — and the permission ends with the turn, so an Explore cast with no land in hand is just a card. With Tatyova out each of those lands is also a card and a life, which is what the deck is for. Nothing else in the pool gives one, and the engine counts them per turn: a third land is refused with **you have already played 2 lands this turn**. |
| Block | **Declare blockers**, tap your creature, then tap the attacker it blocks. Only attackers it may legally block light up. |
| See who is attacking whom | Lines on the board: gold from each attacker to the player it is aimed at, dashed from each blocker to what it blocked. In a pod that is how you know an attack is yours to answer. |
| Work out who has been leaving you alone | In a pod, each opponent's strip also reads **spared you N**: the attacking power that player could legally have aimed at you this game and sent somewhere else. It is the half of the question a player cannot work out by watching — a seat that attacked somebody else looks exactly like a seat that could not attack you, and the engine is the only thing at the table that checked. A creature goaded away from you, held off by a "can't attack you", tapped or summoning-sick leaves nothing here, because none of them could have come at you. Read it beside the badge above: "hit you 12, spared you 5" is somebody coming at you and holding something back; "hit you 0, spared you 20" is somebody who has left you alone all game while they could have done otherwise. |
| Work out who has been hitting you | In a pod, each opponent's strip reads **hit you N** — all the damage that player has dealt you this game, combat and spells alike, from the first turn on. It is the question a four-player table asks every turn and nothing on the screen could answer: life totals are everybody's work added up, and the log tells you one event at a time. Damage that was *prevented* reads as nothing, because it never happened, and a swing your blockers ate reads as nothing either — what you see is what landed on you. A strip with no badge is the other half of the read: that is the player who has left you alone. Nothing here is enforced and nothing is judged; the table just remembers, which is the same line the deals draw. |
| Work out who the threat is | Every seat strip says `board N` — the total power of that seat's creatures — and `· M up` for how much of that power is untapped. The first number is what can kill you eventually; the second is what can kill you on their *next* turn, and what can stop you on yours. A **lethal** badge on an opponent's strip means their untapped power alone is at least your life and you have nothing untapped to block with. |
| Choose who to attack | The attack prompt lists every player and planeswalker you may send an attack at, and each player's button says their life, their untapped power, and how many of your creatures are already pointed at them — plus **lethal** when that swing would finish them with nothing able to block. Tap a player, then tap the creatures that go at them; tap a different player and the next creatures go there instead. |
| Send everything at one player | With two or more creatures declared, **All at ⟨name⟩** re-points the whole swing at whoever is selected. For the turn where somebody's life total drops and the plan changes. |
| Keep a creature **alive** through removal, at a price | Five cards **regenerate**, and the price is the part worth knowing. Pay the cost and the creature gets a **shield**; the next time it would be destroyed the shield is spent instead, and three things happen together — it is **tapped**, its **damage is wiped**, and it is **taken out of combat**. That last one is the cost: a regenerated attacker deals no more damage this turn, and a regenerated blocker stops blocking, so the creature it was holding back gets through. Shields stack and keep until they are used, so paying twice survives two removal spells. What it does **not** beat: anything that *exiles* rather than destroys (Journey to Nowhere, Oblivion Ring), a **sacrifice** (which is not destruction, so a Village Rites eats the creature shield and all), **−1/−1 to nought toughness** (a creature with no toughness is not destroyed, it simply ceases), and **state-based legend and commander rules**. The cards: **Drudge Skeletons** ({1}{B} 1/1 in Rot Harvest, *{B}: Regenerate*) and **River Boa** ({1}{G} 2/1 islandwalk in Kindle Grove, *{G}: Regenerate*) are the cheap ones; **Blight Mamba** ({1}{G} 1/1 infect, *{G}: Regenerate*) and **Skithiryx, the Blight Dragon** ({3}{B}{B} 4/4 flying infect, *{B}{B}: Regenerate*, and *{B}: haste*) carry Blight Vector's win condition and are very hard to remove permanently; and **Golgari Charm** ({B}{G} instant) has *regenerate each creature you control* as one of its three modes, which is the answer to a sweeper rather than to one removal spell. |
| Work out why your creature **got bigger on its own** | **Prowess**, on two cards in Arc Tempest: **Monastery Swiftspear** ({R} 1/1 haste) and **Stormchaser Mage** ({U}{R} 1/2 flying haste). Every **noncreature** spell you cast gives it +1/+1 until end of turn — so a Swiftspear that attacks and then gets a Lightning Bolt and a Shock behind it hits for three, and the board shows the current power and toughness rather than the printed one. You do nothing: it is not a trigger you answer, it resolves as part of the cast. Two things people get wrong at the table — it counts **your** spells only, not the whole table's, and it counts the *cast* rather than the resolution, so a **countered** spell still pumped it. It lasts **until end of turn**, so a creature that survived combat at 3/3 is a 1/1 again on their turn. |
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
| Buy a creature back out of your graveyard for **one turn** | Two cards have **unearth**, and it is not a cast — which is the thing worth knowing at the table. **Dregscape Zombie** ({1}{B} 2/1 in Ashen Rite) reads *Unearth {B}*, and **Hellspark Elemental** ({1}{R} 3/1 trample haste in Kindle Grove) reads *Unearth {1}{R}*. In your own main phase, tap the card in your graveyard and the creature walks straight onto the battlefield with **haste**: nothing goes on the stack, so nobody can counter it and nothing that watches for spells being cast sees it. Then it is **exiled at the beginning of the end step**, so what you bought is one attack. In Ashen Rite that is the whole point: the Zombie attacks, and then a Vampire Aristocrat eats it before the exile and three Blood Artists drain for it — two mana for the body and one to buy it back. The *“or if it would leave the battlefield”* half is enforced too, which matters at the table: an unearthed creature that **dies** this turn is exiled instead of going to the graveyard, so you cannot buy the same body twice. The clause covers **any** way it would leave, not only dying, so an unearthed creature that an opponent Unsummons is exiled rather than handed back — which was a real gap once and is now closed.
| Have a creature **again**, as a Zombie copy of it | Four cards in **Dawn Tithe** can be spent out of your graveyard for a token copy of themselves. **Embalm** gives a white Zombie with no mana cost — **Sacred Cat** ({W} 1/1 lifelink, *Embalm {W}*) and **Angel of Sanctions** ({3}{W}{W} 3/4 flying, *Embalm {3}{W}{W}*). **Eternalize** gives a **black Zombie 4/4** — **Adorned Pouncer** ({1}{W} 1/1 double strike, *Eternalize {4}{W}{W}*) and **Sunscourge Champion** ({2}{W} 2/2, *Eternalize {5}{W}{W}*). Tap the card in your graveyard in your own main phase: it is **exiled as the cost**, so each card buys exactly one token and you cannot do it twice, and nothing goes on the stack to be countered. The token is a **copy**, which is the part worth knowing at the table — it keeps the card's abilities, so the Angel's token exiles another permanent when it arrives and hands it back when the token dies, and the Champion's token gains you two more life. What changes is only what the keyword says: the colour, the Zombie type, no mana cost, and for eternalize the printed 4/4. A token that leaves the battlefield ceases to exist, so there is no third use.
| Cast a **second spell for free** off the top of your library | **Bloodbraid Elf** ({2}{R}{G} 3/2 haste in Kindle Grove) has **cascade**, and the table walks you through it: when you cast the Elf, cards come off the top of your library into **exile, face up**, until one of them is a **nonland card that costs less than four** — and then the bar says *"Bloodbraid Elf cascades into Lightning Bolt: you may cast it without paying its mana cost"*. The card is in **your exile** row with the playable badge on it: tap it and you cast it for nothing, choosing its targets and modes exactly as you would from hand. It can be countered, it rings every "whenever a player casts" trigger on the table, and the stack says **(free)** so your opponent can see it cost you nothing. **Decline** is the other answer, and it is the right one when what came up has no good target. Either way, everything exiled goes to the **bottom of your library in a random order** — that is what the keyword costs you, and it is why a cascade that walks past two lands is a worse library as well as a free spell. Two things the printed card does that this one does not reach: an **X** in the free spell's cost is nought (which is the real rule, CR 107.3b), and a *land* is never the hit however cheap it is. Measured: 20 cascades in 144 games, 1.95 cards off the library each, and the commonest hit a Llanowar Elves. |
| Cast one spell and get **several** | **Grapeshot** ({R} sorcery in Arc Tempest) has **storm**: when you cast it, it is copied once for every spell cast before it this turn — by *anybody*, so an opponent's instant in your main phase counts too. One damage becomes four on the fourth spell of a turn, and the copies resolve before the original, each hitting the same target the original chose (which is the rule: the printed card lets you re-aim the copies and this engine does not offer it). The count is taken **as you cast it**, so an opponent answering it in the window afterwards does not hand you another copy. In practice this is a card for you rather than for the computer: measured over 848 turns of real games, 42% of turns hold no spell at all and only 3% reach three — and every Grapeshot the computer cast was the first spell of its turn, for one damage. Build a turn around it and it is a different card. |
| Throw a card away and **cast it instead** | **Fiery Temper** ({1}{R}{R} sorcery in Ashen Rite) has **madness {R}**. Discard it — to **Faithless Looting**, or at cleanup when you are over seven cards — and it does not go to your graveyard: it goes to **exile face up**, and the table stops to offer it to you for **{R}**, right then, whatever the step and whatever is on the stack. Three damage for one mana is the best rate in the pool, and the catch is the mana: if {R} is not available at the moment of the discard the engine does not even ask, and the card is simply discarded (it says so in the log rather than silently). Decline and it goes to the graveyard it was heading for. The computer opponent plays this badly and knows it: it will give the Temper up first when it has the mana spare, and in measured games it never once did — it spends its mana before it discards. |
| Buy **half a card** for half the mana | **Mulldrifter** ({4}{U} 2/2 flier in Tidal Mind) has **evoke {2}{U}**. The table offers it to you twice from the same hand: cast it for five and you draw two cards and keep a 2/2 flier, or cast it for three and you draw two cards and the Mulldrifter **sacrifices itself the moment it arrives**. The draw happens first either way — both abilities go on the stack together and the sacrifice sits underneath — so the cheap half is a Divination that costs you nothing but the body. The row says which is which: *"Cast Mulldrifter for its evoke cost ({2}{U}, sacrificed as it arrives)"*, and the stack says **(evoked)** so your opponent can see, before they spend a counterspell, that the creature is already on its way to the graveyard. The cheap cast is offered even on a turn you could not pay the printed five, which is the turn the card is really for. |
| Attack **now** and keep the card | **Mardu Scout** ({1}{R} 3/1 in Kindle Grove) has **dash {R}**. Cast it for one mana instead of two and it arrives with haste, attacks the turn it lands, and goes back to your hand at the beginning of the end step — so it is the same card again next turn, for one mana again, for as long as the game lasts. Nothing can answer it on your opponent's turn, because it is not there: a removal spell has nothing to hit and a blocker has nothing to trade with. What you give up is the board — it never blocks, and it is never the creature you win with — which is what the printed {1}{R} is for when the game has stalled and a 3/1 blocker matters more than three damage. The row says which is which, and the stack says **(dashed)**. It sits beside the **Hellspark Elemental** in the same deck on purpose: both are three damage that does not stay, and the Hellspark pays for its second go with {1}{R} out of the graveyard where the Scout pays {R} out of your hand, every turn. |
| Cast a creature **as an Aura**, and get the creature back later | **Boon Satyr** ({1}{G}{G} 4/2 with flash in Verdant Guard) has **bestow {3}{G}{G}**. Cast it for three and it is a 4/2 you can play at the end of their turn; cast it for five and it is not a creature at all — it is an Aura on one of your creatures giving it **+4/+2**, and the moment that creature dies the Satyr **stands up as the 4/2** instead of going to the graveyard with it. That is the whole card: a pump spell that cannot be two-for-oned. While it is an Aura it cannot be hit by anything that answers creatures — a Day of Judgment sweeps the board and leaves it alone, and on the stack a "counter target creature spell" cannot be pointed at it, because a bestowed spell is an **Aura spell** and the stack says **(bestowed)** so both players can see it. The row asks you to pick the creature to enchant before it is cast, and it is only offered when you have one. |
| Buy the **second half of an attack** for one mana | **Skewer the Critics** ({2}{R} sorcery in Ashen Rite, three damage to any target) has **spectacle {R}**, and it is the only cheap cast in the pool you have to **earn**: the row appears on the card in your hand only once an opponent has lost life this turn — a creature got through, a Murderous Redcap arrived, a Blood Artist drained them — and until then the card simply costs three. So the row comes and goes mid-turn, and it says why it is there: *"Cast Skewer the Critics for its spectacle cost ({R}, because an opponent has lost life this turn)"*. Your own life does not count, and neither does poison: an infect hit replaces the damage with poison counters, so nobody lost any life and the row stays away. The stack says **(spectacle)**, which tells your opponent something about the turn as well as about the spell — three damage for one mana after an attack is the half of the turn they may not be able to race. Attack first, then look at your hand: that is the whole card. |
| Pay more and hit **everything** | **Mizzium Mortars** ({1}{R} sorcery in Ember Rush) has **overload {3}{R}{R}{R}**. For two mana it deals four damage to one creature you don't control — the removal a burn deck never had for a 4/4 blocker. For six it deals four damage to **every** creature you don't control, and yours are untouched. The row appears as soon as you can pay for it and says which it is: *"Cast Mizzium Mortars for its overload cost ({3}{R}{R}{R}, each instead of one)"*. The part worth knowing at the table is that the overloaded spell **targets nothing at all**: a ward costs nobody anything, a Willbender has nothing to bend, a protection trick or a Dive Down saves nothing, and the spell cannot fizzle. The only answer to it is a counterspell. It is four damage rather than "destroy", so a Wall of Frost shrugs it off — and the stack says **(overloaded)**, so the player holding the Counterspell knows which of the two they are looking at. |
| Save something up and spend it later | Four cards in Kindle Grove run on **energy**, which is not mana: it is a counter on *you*, it is never emptied between turns, and the table shows it beside your life as soon as you have any. **Aether Hub** arrives with one and taps for colourless, or for any colour by spending it. **Longtusk Cub** ({1}{G} 2/2) gives you two every time it connects, and two of them put a +1/+1 counter on it, so a Cub nobody blocks grows every turn on its own. **Bristling Hydra** ({2}{G}{G} 4/3) arrives with three, and three of them make it bigger **and give it hexproof until end of turn** — the one answer in this deck to a removal spell already on the stack. And **Harnessed Lightning** ({1}{R}) gives you three and then asks how much to spend: that much damage to a creature, so it is three damage on an empty pool and more when you have been saving. Every seat's energy is public, which matters at the table: somebody sitting on six of it is somebody whose Hydra you cannot kill. |
| Make a creature **permanently** bigger | Two cards grow once and stay grown, and the difference between them is one word of placement. **Fleecemane Lion** ({G}{W} 3/3 in Verdant Guard) has *monstrosity 1* for {2}{G}{W}: press it and the Lion takes a +1/+1 counter — which never wears off, unlike every other pump in the pool — and *while it is monstrous it has hexproof and indestructible*, which in this card pool means nothing left can answer it. The ability then **disappears**: "activate only if it isn't monstrous" is a restriction on the ability, so the table stops offering a button that would do nothing. **Aeromunculus** ({1}{G}{U} 2/3 flier in Delta Bloom) has *adapt 3* for {2}{G}{U}, which is the same growth with the condition written inside the effect instead — so the table **keeps** offering it, and paying a second time is legal and buys nothing. That is the printed card rather than a bug, and the computer opponent knows not to do it.
| Play a creature that **comes back by itself** | Three cards do it, and they are two keywords printed almost identically. **Undying** is on **Butcher Ghoul** ({1}{B} 1/1 in Blight Vector) and **Young Wolf** ({G} 1/1 in Rot Harvest): when the creature dies, *if it had no +1/+1 counter on it*, it comes straight back with one — so a 1/1 blocks, dies, and is a 2/2 on the battlefield again before anybody has priority. Kill it a second time and it stays dead, because the counter it is carrying is the same counter the ability asks about. **Persist** is the mirror: **Murderous Redcap** ({2}{B}{R} 1/1 in Ashen Rite) deals damage equal to its power as it enters, dies, comes back with a −​1/−​1 counter — which makes it a 0/0 — deals nothing on the way in, and goes to the graveyard again on its own. The thing worth knowing at the table is that these creatures **really die**: a Blood Artist drains for them, a sacrifice outlet gets its value, and a Village Rites draws its two cards. Undying is not protection; it is a second body, and the first one is spent.
| Cast a card **the moment you draw it**, for one mana | Two cards have **miracle**: **Terminus** ({3}{W}{W} sorcery in Skyward Writ, miracle {W}) and **Thunderous Wrath** ({4}{R}{R} instant in Arc Tempest, miracle {R}). The offer appears in your draw step and **only for the first card you drew that turn**, so a Terminus drawn off a cantrip later in the turn is a five-mana sorcery again. Decline it and the card stays in your hand at its printed cost — the window does not come back. |
| Cast the same spell **twice, a turn apart** | Two cards have **rebound**: **Distortion Strike** ({U} sorcery in Tidal Mind) and **Staggershock** ({1}{R} instant in Arc Tempest). Cast from your hand, the card is exiled as it resolves instead of going to your graveyard, and your next upkeep offers the cast again for free. Only from your hand: a Staggershock cast *off* the rebound does not rebound a third time. |
| Trade a draw for a **card out of your graveyard** | Two cards have **dredge 3**: **Darkblast** ({B} instant in Blight Vector) and **Shambling Shell** ({1}{B}{G} 2/2 in Rot Harvest). Whenever you would draw, the table offers the dredge instead — mill three of your own cards and take the dredger back to your hand. It replaces the draw rather than adding to it, so the cost is this turn's card and three off the top of your library. |
| Pay one cost **several times over** | Two cards have **replicate**: **Pyromatics** ({1}{R} instant in Arc Tempest) and **Train of Thought** ({2}{U} sorcery in Hollow Tide). Each copy you want is the replicate cost again, and the table lists the prices it can actually afford as separate plays — so with six mana a Pyromatics ({1}{R}, replicate {1}{R}) offers one, two and three copies and charges for the one you tap. |
| Drain them **every time you cast a spell** | Two creatures have **extort**: **Basilica Guards** ({1}{W} 0/4 defender in Skyward Writ) and **Basilica Screecher** ({2}{B} 1/2 flier in Hollow Tide). Every spell you cast asks whether you want to pay {W/B} — one of either colour — and each payment costs each opponent a life and gives you one. It is asked **while the trigger resolves**, so the mana has to still be there after the spell it followed. |
| Pay for a spell **now** and cast it later | Two cards have **suspend**, both in Kindle Grove: **Rift Bolt** (suspend 1—{R}) and **Search for Tomorrow** (suspend 2—{G}). Pay the small cost on turn one and the card waits in exile with time counters on it; one comes off each of your upkeeps, and when the last one goes the spell is cast **free**. Public the whole time — both players can count the turns. |
| Keep the spell you just cast | Two cards have **buyback**: **Capsize** ({1}{U}{U} instant in Tidal Mind, buyback {3}) and **Whispers of the Muse** ({U} instant in Hollow Tide, buyback {5}). The dearer row is the same spell with the card returning to your hand instead of your graveyard — so a Capsize with six mana is a bounce you can cast again next turn, forever. Only on instants and sorceries: a permanent spell never reaches a graveyard to be saved from one. |
| Add to **every counter on the board** | Two cards **proliferate**: **Contagion Clasp** ({2} artifact in Blight Vector, `{4}`+tap) and **Steady Progress** ({2}{U} instant in Hollow Tide). You pick any number of permanents *and players* carrying counters, and each gets one more of **each kind it already has** — so a creature with a +1/+1 and a −1/−1 gets one of each, and a permanent with nothing on it is not even offered. Players are picked on their own seat strip, which says **Choose** rather than Target. |
| Pay for a creature **again** next upkeep | Two creatures have **echo**: **Mogg War Marshal** ({1}{R} in Ember Rush, echo {1}{R}) and **Yavimaya Granger** ({2}{G} in Kindle Grove, echo {2}{G}). The upkeep after it arrives, the table asks for the echo cost once — pay it and the creature is yours for good, decline and it is sacrificed. Worth declining on the Marshal, which leaves a Goblin behind either way; worth paying on the Granger, whose land is already in play. A cost you cannot afford is not offered at all: the creature simply goes, and the log says why. |
| Keep something whose rent **goes up** | **Mystic Remora** ({U} enchantment in Tidal Mind) has **cumulative upkeep {1}**: each of your upkeeps puts an age counter on it and then asks for {1} *for every counter on it*, so it is {1}, then {2}, then {3}. While it is out, every noncreature spell an opponent casts lets you draw two cards. The question is rebuilt at the new price each time — what the button says is what you are being charged. |
| Spend spare mana on a **bigger creature** | Two creatures have **level up**: **Student of Warfare** ({W} 1/1 in Dawn Tithe, level up {W}) and **Beastbreaker of Bala Ged** ({1}{G} 2/2 in Kindle Grove, level up {1}{G}). Tap it on your battlefield and the level-up row is there — **your own turn only**, at sorcery speed, as many times as you can pay. The counters change what the creature *is*: a Student at two is a 3/3 with first strike and at seven a 4/4 with double strike, and the card face shows the body it currently has. |
| Play a huge creature that **does not stay** | Two creatures come with a countdown and shroud, so nothing in this pool can target them. **Calciderm** ({3}{W} 5/5 in Forge Alliance) has **vanishing 4** and **Blastoderm** ({2}{G}{G} 5/5 in Kindle Grove) has **fading 3** — and despite the different numbers both give you **three** turns of a 5/5, because vanishing goes when the last counter is removed and fading when there is none left to remove. The counter is on the card face, so count it rather than the turns. A proliferate buys one more. When one of these does go, the log says which it was — *"Calciderm's last time counter is gone"* is the clock running out, and no such line means something answered it. |
| Cast something they **cannot answer** | Two cards have **split second**: **Sudden Shock** ({1}{R} instant in Arc Tempest, two damage) and **Krosan Grip** ({2}{G} instant in Blight Vector, destroy an artifact or enchantment). While one is on the stack nobody may cast a spell or activate anything but a mana ability — including you, which is the half people get wrong — so a hand tapped on in that window says *a spell with split second is on the stack* rather than going quietly grey. It is not uncounterable: a Chalice of the Void already on the battlefield counters it regardless. The window is not free and not always worth it: the Shock deals a damage less than the Lightning Strike beside it, and that damage measured as worth more than the keyword. |
| Swap a creature in **after blockers** | **Ninja of the Deep Hours** ({1}{U} 2/2 in Skyward Writ) has **ninjutsu {1}{U}**: once one of your creatures is through unblocked, pay {1}{U}, send that creature back to your **hand**, and the Ninja arrives tapped and attacking in its place — drawing you a card when it connects. You keep both cards, which is why the bar says "return" rather than "sacrifice". The only play in this pool that happens after blockers and still changes what damage lands, and the one card here worth *not* casting on turn two. |
| Get a **truce offer from the computer** | In a pod the bots now ask, not just answer. When your open board could kill one of them on a swing, that seat offers you a **truce until your next turn** — binding both ways, so it gives up attacking you as well as asking you to leave it alone. The offer appears on the action bar with **Agree** and **No deal**, and it blocks nothing: ignore it and carry on playing if you like. Two things worth knowing. The bots **keep** every deal they take, so an agreed truce is worth something. And they will usually **refuse** yours for the mirror of the same reason — a seat whose board can kill you has no reason to sign anything, which is exactly what a person would say. |
| Attack **three people at once** with one creature | **Blade of Selves** ({3} Equipment in Forge Alliance, equip {3}) gives the creature it is on **myriad**: whenever it attacks, a token copy of it arrives tapped and attacking each *other* opponent, and the copies are exiled at the end of combat. So one 4/4 swing becomes three, at three different players. Two things to know before you equip it. In a **two-player game it does nothing at all** — there is never an opponent other than the one you are attacking — so it is three mana and an equip cost for no effect. And the copies are copies of the **card**, not of the creature: Equipment and counters on the original do not come with them, so a Bonesplitter makes your Angel a 6/4 and leaves the copies 4/4. The copies also were never *declared* as attackers, which is why nothing of yours that triggers on attacking fires for them. |
| Cast a four-mana creature for **nothing** | **Frogmite** in Forge Alliance has **affinity for artifacts**: printed {4} for a 2/2, and **{1} less for every artifact you control**, counted the moment you look at it — so the row on the card changes as the board fills and goes back up the moment your artifacts are answered. Sixteen of this deck's sixty cards are artifacts, and the Frogmite is one itself, so it feeds the Ravager and the Etched Champion's metalcraft on the way past. The reduction only ever eats **generic** mana, which is why you will never see it make a coloured spell free. The floor is nothing rather than a refund: eight artifacts against a printed {4} take four off and the other four take nothing, so the table says what it actually did to the cost. And it never changes the card's **mana value** — a Chalice of the Void on four still counters a Frogmite you paid one mana for. |
| Have a creature **turn over** into something bigger | Two cards in Arc Tempest have a **second face on the back**, and they are not the modal lands you already know. **Delver of Secrets** is a {U} 1/1; at the beginning of each of your upkeeps it looks at the top card of your library and asks whether to reveal it, and if what you reveal is an instant or a sorcery it **transforms** into Insectile Aberration, a 3/2 with flying. You are only asked the question, never forced: declining leaves it a 1/1, and the reveal is the only thing that flips it. **Thing in the Ice** is a {1}{U} 0/4 with defender that arrives with four ice counters; every instant or sorcery you cast takes one off, and when the last one goes it becomes **Awoken Horror**, a 7/8 that returns *every* non-Horror creature to its owner's hand — yours included, so count your own board before you cast the fourth spell. Three things hold for both. A transformed permanent is the **same permanent**, not a new one: it keeps its damage, its counters and its summoning sickness, and the 0/4's defender is simply gone once it is a 7/8. The back face has no mana cost but its **mana value is the front's**, so a Chalice of the Void on two still answers Thing in the Ice. And a transformed creature that leaves the battlefield goes to the graveyard as its **front** face, which is the card you could bring back. |
| Grow a creature by **eating your own artifacts** | **Arcbound Ravager** ({2} 0/0 in Forge Alliance) has **modular 1** and "Sacrifice an artifact: put a +1/+1 counter on it" — the pool's only cost that spends an artifact, so a Bonesplitter that has done its job becomes permanent power. **Arcbound Worker** ({1} 0/0, modular 1) is the cheap version. Both are printed **0/0** and alive only because of their counter, so a −1/−1 from a Contagion Clasp kills them outright; and when either dies you may move its counters to another artifact creature — *may*, because the legal targets include your opponent's, so the bar offers **Choose nothing** beside the prompt and that is a real answer rather than a way out of it. |
| Take somebody's graveyard away | Three cards answer the graveyard, and they answer it three different ways. **Planar Void** in Blight Vector is a {B} enchantment: *whenever another card is put into a graveyard from anywhere, exile that card* — so while it is on the table nobody has a graveyard at all, including its own controller. No flashback, no escape, no delve, no Raise Dead, and a Lhurgoyf stays a 0/1. It is a trigger rather than a replacement, which is exactly how the card is printed: the card really does reach the graveyard and really is exiled afterwards, so a Blood Artist still sees the creature die. **Scavenging Ooze** in Delta Bloom is the patient version — {1}{G} for a 2/2, then {G} as often as you like to exile one card from any graveyard, and if it was a creature card the Ooze gets a +1/+1 counter and you gain a life. Point it at the card somebody is about to escape or delve with and it is removal and a clock at once. **Rest in Peace** in Skyward Writ is the third and the most absolute: {1}{W}, it exiles every graveyard as it arrives, and after that *a card that would be put into a graveyard from anywhere is exiled instead*. The difference from the Void is one word and it matters at the table — “instead” means the card never reaches the graveyard, so a creature that would have died **did not die**: a Blood Artist drains for nothing, a Cruel Celebrant sees nothing, and a Gravedigger has nothing to look at. It is symmetrical and printed that way; Skyward Writ is simply the deck whose sixty cards never wanted a graveyard. In a **pod** that changes, because that deck's commander is Hanna, Ship's Navigator, who buys an artifact or enchantment back out of the graveyard this card has just turned off. |
| Work out why your creature is bigger than its card | Three creatures are **lords**: they change the other creatures of their own type. Stromkirk Captain in Ashen Rite gives other **Vampires** +1/+1 and first strike, Knight Exemplar in Skyward Writ gives other **Knights** +1/+1 and indestructible, and Imperious Perfect in Rot Harvest gives other **Elves** +1/+1. None of them pumps itself — "other" is printed on all three. The board always shows the current size, and it changes the instant the lord arrives or leaves, with nothing to click: a Knight with three damage on it that was surviving because of the Exemplar dies the moment the Exemplar does. |
| Attack with **three** creatures on purpose | Four cards pay you for the *shape* of an attack rather than for the creature making it, and all four decide on the attackers you **declared** — what happens to them afterwards does not change the trigger. **Firemane Avenger** ({2}{R}{W} 3/3 flier in Forge Alliance) has **battalion**: on any turn it and at least two other creatures attack, it throws three damage at anything and you gain three life. **Sunhome Stalwart** ({1}{W} 2/1 first strike, the same deck) has **mentor**: every time it attacks it puts a **permanent** +1/+1 counter on another attacking creature with less power — so a Soldier token that attacks beside it twice is a 3/3, and the table only ever offers you the creatures that are both attacking and smaller. **Goblin Wardriver** ({1}{R} 2/2 in Kindle Grove) has **battle cry**: every *other* attacker gets +1/+0 for the turn, which turns a board of medium creatures into a board of bad blocks. And **Topan Freeblade** ({1}{W} 2/2 vigilance in Verdant Guard) has **renown 1**: the first time it connects with a player it keeps a +1/+1 counter and is *renowned* forever after, so it attacks as a 2/2, comes back a 3/3 and is still untapped to block. Renown happens once — the card checks whether it is renowned already — and only on damage that actually takes life: a blocked swing, or one stopped by a Fog, gives it nothing. |
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
| Cast a spell that costs a creature | Two cards read **"As an additional cost to cast this spell, sacrifice a creature"**: **Bone Splinters** ({B} sorcery, destroy target creature, in Ashen Rite and Dawn Tithe) and **Village Rites** ({B} instant, draw two, in Ashen Rite). Tap it, then tap the creature to feed it — the cost is asked for before the target, the order the rules put them in. An **additional cost** is paid as the spell is cast, so the creature is in the graveyard before anybody may respond: it cannot be saved in reply, and killing it in response cannot deny the spell. And a cost you cannot pay is not one you may pay (CR 601.2h), so with no creature to feed it the spell is not offered at all — it reads *it asks for a creature to sacrifice, and you have none* rather than sitting on the stack waiting for one. |
| Pair two of your creatures | Two cards in Verdant Guard have **soulbond**: **Trusted Forcemage** ({1}{G}{G} 2/2) and **Wolfir Silverheart** ({4}{G}{G} 4/4). As one of them arrives, the table asks which other unpaired creature of yours to pair it with — tap one, or decline. While they are paired **both** get the bonus, so a Silverheart next to a Grizzly Bears is an 8/8 and a 6/6. The pair also forms the other way round: with the soulbond creature already out, the next creature you play asks **Pair them?**. Two things worth knowing. The bonus is **rented** — kill either half and the other shrinks in the same instant, which is why a six-mana 4/4 making eight points of board is fair. And the pair breaks whenever the two stop being two creatures you control, including a **change of control**: an Act of Treason on half of a pair takes four points off the other one as well. A paired creature says **PAIR** on its corner and names its partner on its own sheet. |
| Give a creature an ability it was never printed with | Two cards in Skyward Writ hand a triggered ability out rather than a bonus. **Tandem Lookout** ({2}{U} 1/1) has soulbond, and while it is paired **each of those creatures has "Whenever this creature deals damage to a player, draw a card"**. **Ophidian Eye** ({1}{U} Aura, flash) says **Enchanted creature has** the same thing, on one creature. The ability belongs to whichever creature is holding it, which is the whole decision: pair the Lookout with your flier and the *flier* draws, so a 2/2 nobody can block is suddenly a card a turn. A creature holding a borrowed ability lists it on its own sheet as **has draw a card**, because nothing in its own text box says so. Both halves go away the moment the thing granting them does — kill the Aura, or break the pair, and the drawing stops that instant — but an ability already waiting to resolve still resolves: destroying the Eye in response to the trigger does not deny the card. |
| Spend a token for mana, or for a card | Two decks make **artifact tokens that are meant to be used up**. **Pirate's Prize** ({3}{U}, Tidal Mind) draws two cards and leaves a **Treasure**: `{T}, Sacrifice this artifact: add one mana of any colour`. **Thraben Inspector** ({W} 1/2, Skyward Writ) arrives and **investigates**, which makes a **Clue**: `{2}, Sacrifice this artifact: draw a card`. Both are one-shot — using one puts it in the graveyard and it does not come back at your next untap. You do not have to spend a Treasure by hand: the table counts it as mana you can pay with, and it will **spend your lands first**, so a Treasure only goes when it is the only mana left. The Clue is a button you press when you have two mana spare and nothing better to do with them, which in a slow game is most turns. The one thing to watch: a Treasure is an artifact, so a Disenchant or a Naturalize can take it before you cash it. |
| Send the damage back | Two white instants **move** damage instead of stopping it. **Harm's Way** ({W}, in Forge Alliance): the next 2 damage headed at you or anything you control is dealt to a creature or player you pick instead. **Divine Deflection** ({X}{W}, in Skyward Writ): the same thing for X, so it scales. Both are one shield over your **whole side** — you and every permanent you control share the points, so four damage coming in from two attackers takes two off a Harm's Way and lets the other two through. And both pay out only what they actually stopped: a Divine Deflection for four that only ever meets one damage deals one. The redirected damage is a real hit from the **same source**, so a creature with protection from that colour shrugs it off and an infect source poisons with it. |
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
table. **Rancor** is +2/+0 and trample for one mana that **comes back to your hand** whenever it
reaches a graveyard — from the battlefield, from your hand if somebody makes you discard it, or off
the top of your library if somebody mills it — so killing the creature does not answer the Aura and
neither does making you throw it away. The one card that does is a **Planar Void**, which exiles it
on the way past; the bot casts the two copies in this deck **139 times in the 64 games it draws
one**, which is what a card that will not stay gone is worth. And **Thragtusk** gains five as
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

**And it does not read your hand, which is now a measurement rather than a promise.** The card in
your opponent's hand never reaches your machine (that is the redaction above), but the computer
opponent runs on the server where the whole game state lives, so nothing stopped it peeking except
the code being written not to. Asked properly — the same position put to it twice, the second time
with every card it cannot see dealt out again, 8,945 decisions across 78 games — it chose a
**different move exactly 0 times**. Not one cast, attack, block or activation anywhere depends on
what you are holding, on either library's order, or on what is under a face-down creature. A
deliberate cheat was wired in to prove the test can catch one, and it showed up immediately. The
check now runs in the test suite, so a future version that peeks fails before it reaches you —
`claude/decisions-log.md`, D186.

**The decks are not all equally strong, and now there is a table of it.** Every deck against every
other, both seats, 288 games each (`SEEDS=12 SEED0=4400 node scripts/measure/deck-table.mjs`):

```
 74%  213-75   ember-rush
 69%  198-90   dawn-tithe
 64%  185-103  verdant-guard
 55%  158-130  kindle-grove
 53%  154-134  forge-alliance
 49%  141-147  arc-tempest
 45%  129-159  rot-harvest
 45%  129-159  skyward-writ
 43%  123-165  ashen-rite
 42%  120-168  hollow-tide
 40%  115-173  delta-bloom
 37%  107-181  tidal-mind
 33%  96-192   blight-vector
```

**One deck is clearly ahead, one is clearly second, and one is measurably short.** The spread is
forty-one points. Ember Rush is alone at 74% but no longer unchallenged — Dawn Tithe beats it 14-10
head to head — eleven decks sit between 33% and 69%, and the bottom is Blight Vector at 33%, four
points below the deck above it.

**Three rows moved, and every one of them has a named cause.** Arc Tempest, 42% to 49%, is one
**Thunderous Wrath** (D204). Skyward Writ, 50% to 45%, is one **Terminus** — a symmetric sweeper in
a deck of small white creatures, and the slot is still the first place to look if that deck needs
the games back. And Verdant Guard, 61% to 64%, did not change a card at all: it holds the pool's
other sweeper, Day of Judgment, and the bot stopped casting sweepers into boards it was winning
(D205). That rule is worth **+17 to Skyward Writ and +9 to Verdant Guard** here, which is the two
decks in the pool that hold a card it can fire on and nobody else — the rest of the table moved four
games or fewer. Read the order, not the numbers.

The run before this one priced the same two miracle cards with the bot casting every offer it was
given: Skyward Writ read **39%** there, and the paired probe said the Terminus slot cost 32 games
where it now costs 12 to 24. A slot and a bot rule measured in the same run cannot be told apart,
which is why they were measured in two.

Earlier runs of this table read "the bottom is a cluster now", "the spread is thirty-six points" and
"Verdant Guard and Dawn Tithe are level at 65%"; none of those is true any more, and the sentences
have been replaced rather than left standing — a published number that has been re-measured is worth
more corrected than defended.

The row before these read **Dawn Tithe, 65% to 69%**, which was the four embalm and eternalize cards
and the six they cost (D203); it is 69% still. Worth remembering beside the numbers above: a paired
probe of that swap wanted to call it *forty-seven* games rather than eleven, on a deck whose own
noise reads 55% and 62% for the same unchanged list on two seed sets.

**The run before this one also had one card in it, and the table could only see half of what the
card's own probe saw.** Verdant Guard gained a **Kitchen Finks** in place of a Pacifism (D190), and
its paired probe — the same list against itself, the card in and out, on two seed sets of 288 —
priced that swap at between fifteen and thirty games. The table moved it twelve, from 175-113 to
187-101, which is the same direction and *inside* the instrument's own ±20-game floor. So the
standings confirm the sign and cannot confirm the size: this is the one reading the paired probe
exists for, and the reason both numbers are published rather than the larger one.

**The run before this one had four new cards in it that the table could not see, which is worth saying out
loud.** Battalion, mentor, renown and battle cry went into four different decks (D188), and every
row of the thirteen moved inside the instrument's own ±20-game floor: the biggest move is Kindle
Grove at four games. Measured properly — each change probed against its own deck on the same seeds,
both arms — Forge Alliance's two cards are worth **9 and 36 games** of 288. Both readings are
honest and they are answering different questions: a paired probe compares one list against one
list, and this table is zero-sum across thirteen decks that changed at once. A four-deck pass is not
readable from the standings, and the standings are not the place to look for it.

**This run has one more bot rule in it than the last, and it is deliberately invisible.** The
computer used to pick an Equipment up and put it on a different creature that was no bigger — a
Basilisk Collar moved onto a Wall of Blossoms twenty-one times in 156 games, onto a Gravedigger
twelve, onto Llanowar Elves ten — which is mana spent for nothing. It does not do that any more.
The instrument behind it counts the whole pool's pointless plays at once rather than one card at a
time (`wasted-plays.mjs`), and the fix took the wasted equips from **124 to 36** while moving the
table by nothing: measured both ways on two seed sets, Forge Alliance and Rot Harvest read +5 and +5
on one and 0 and 0 on the other. What you notice across the table is a Bonesplitter that stays where
it is useful, not a stronger opponent — D184.

**Two rows moved for a reason, and neither of them is a card.** Ashen Rite gained **29 games of
288** (39% → 49%, fourth-worst to seventh) when the sacrifice-fodder fix stopped a Vampire
Aristocrat eating the engine it was standing on (D175), and Rot Harvest — the pool's only other deck
with repeatable sacrifice outlets — gained 13 in the same run. Then **Dawn Tithe gained 19** (58% →
65%, which is why it is second now) when the bot stopped casting its own Disenchant on its own
permanents (D180, found by following every creature a deck plays and noticing that 6% of Blight
Vector's were killed by its own Naturalize). Every other row in both runs moved inside this
instrument's own ±20-game noise floor — so the honest reading of the rest of the table is the
shape, not the rows. D177 and D180 have the full before-and-afters.

Every run of this table since the **mana-reservation rule** went in has had it on, and the run that
measured it both ways on the same seeds is the one worth quoting: the five decks that hold
counterspells moved **+1 between them** — Hollow Tide +4, Tidal Mind +2, Arc Tempest −1, Skyward
Writ −2, Delta Bloom −2. The rule is there so the decks do what they are built to do, not to make
them win more — see the window table above.

**The rest of this section is the history of that table, run by run, newest first.**

**The deck at the bottom was reshaped, and the reshape measured worse.** Blight Vector's own
instruments had been clear — it loses a race by a turn, 71% of the time to plain combat damage, and
it never gets more than **five** infect creatures onto the table — so four slots went in at once:
a fourth Blight Mamba and a fourth Plague Stinger, a second Loxodon Warhammer and a new Whispersilk
Cloak, for the two Blossoming Defenses, a Read the Bones and a Cystbearer. Probing the revert:
**+11 and +10** of 288, two arms of the same sign, so the old list is better. The equipment package
on its own measured **−3 and +23**. And the instrument chosen to judge the shape says why: the
reshaped deck got **12% more infect creatures into attack steps** and the widest board it ever had
was still five. It is not short of creatures to draw; it is short of creatures that are still there
next turn. The deck keeps its list, the Cloak was measured in a second deck and deleted, and the
next thing for this deck is an instrument rather than a third guess — D178.


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

The decks share a pool of three hundred and thirty-three cards, which now includes a wrath, a
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

**Start the stack with the launcher, not by hand.** `scripts/play.mjs` sets `VITE_REALTIME_URL`, and
the browser needs it: there is deliberately no `/socket.io` proxy in `vite.config.ts`, so without
that variable the page opens a socket to the dev server and gets nothing. The suites then time out
waiting for the pregame screen, which looks like a broken table and is not.

```bash
PLAY_HOST=127.0.0.1 node scripts/play.mjs &   # both servers, with the variable set

node scripts/e2e-table.mjs      # two browsers, tabletop mode          — 73 checks
node scripts/e2e-arena.mjs      # two browsers, rules engine           — 52-58 checks
node scripts/e2e-pod.mjs        # four browsers, a Commander pod       — 42 checks
node scripts/e2e-solo.mjs       # one browser, against the computer    — 24-26 checks
SOLO_POD=1 node scripts/e2e-solo.mjs   # one browser, a pod against three — 26 checks
LIST=cascade node scripts/e2e-solo.mjs # a deck built to cascade, in a browser — 25-26 checks
LIST=costs   node scripts/e2e-solo.mjs # a deck built to pay evoke, dash and bestow — 27-28 checks
LIST=earned  node scripts/e2e-solo.mjs # a deck built for spectacle and overload — 26-27 checks
LIST=graveyard node scripts/e2e-solo.mjs # a deck built to press a button in the graveyard — 27-29 checks
LIST=miracle node scripts/e2e-solo.mjs # a deck whose first draw is often the card it is built around — 26 checks
LIST=rebound node scripts/e2e-solo.mjs # a deck built to cast the same spell twice, a turn apart — 26-27 checks
LIST=replicate node scripts/e2e-solo.mjs # a deck with the mana to pay one cost several times — 25 checks
LIST=extort node scripts/e2e-solo.mjs  # a deck asked for mana every time it casts a spell — 25 checks
LIST=suspend node scripts/e2e-solo.mjs # a deck that pays for a spell a turn before it casts it — 26 checks
LIST=dredge node scripts/e2e-solo.mjs  # a deck that buys the same spell back every draw step — 27 checks
LIST=buyback node scripts/e2e-solo.mjs # a deck that pays to keep the spell it just cast — 26 checks
LIST=proliferate node scripts/e2e-solo.mjs # a deck that poisons the computer and then picks it out of a list — 25 checks
LIST=echo node scripts/e2e-solo.mjs    # a deck asked for mana in its own upkeep — 26 checks
LIST=upkeep node scripts/e2e-solo.mjs  # a deck whose upkeep question gets dearer every turn — 26-27 checks
LIST=level node scripts/e2e-solo.mjs   # a deck with a creature that grows by being paid for — 26 checks
LIST=vanish node scripts/e2e-solo.mjs  # a deck whose best creatures come with a countdown on them — 26 checks
LIST=artifact node scripts/e2e-solo.mjs # a deck that pays its costs with spare artifacts — 25 checks
LIST=blink node scripts/e2e-solo.mjs   # a deck whose end step asks which of your own creatures to blink — 26 checks
LIST=soulbond node scripts/e2e-solo.mjs # a deck that pairs its creatures off, and the pair named on the card — 27 checks
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
LIST=cascade node scripts/e2e-solo.mjs           # eight Bloodbraid Elves, pasted in as text
LIST=costs   node scripts/e2e-solo.mjs           # evoke, dash and bestow, all three pressed
LIST=earned  node scripts/e2e-solo.mjs           # spectacle and overload, the two odd rows
LIST=graveyard node scripts/e2e-solo.mjs         # embalm and eternalize, pressed in the graveyard
LIST=miracle node scripts/e2e-solo.mjs           # a miracle offered in the draw step, on a card in hand
LIST=rebound node scripts/e2e-solo.mjs           # a rebound offered a turn later, on a card in exile
LIST=replicate node scripts/e2e-solo.mjs         # one card offered at three prices, and the one tapped charged
LIST=extort node scripts/e2e-solo.mjs            # an optional cost paid in the middle of a resolution
LIST=suspend node scripts/e2e-solo.mjs           # a card exiled with time counters, and the free cast two turns later
LIST=dredge node scripts/e2e-solo.mjs            # a draw replaced by a mill, and the card it hands back
LIST=buyback node scripts/e2e-solo.mjs           # the dearer of two rows on one card, and the card coming home
LIST=proliferate node scripts/e2e-solo.mjs       # an answer with a player in it, tapped on the seat's own strip
LIST=echo node scripts/e2e-solo.mjs              # a question raised in the upkeep, and both of its answers
LIST=upkeep node scripts/e2e-solo.mjs            # the same question at two different prices, as it climbs
LIST=level node scripts/e2e-solo.mjs             # a row pressed on the battlefield, and the body the card face then shows
LIST=vanish node scripts/e2e-solo.mjs            # a counter on the card face, read at more than one number
LIST=artifact node scripts/e2e-solo.mjs          # the bar asking for an artifact rather than a creature
LIST=blink node scripts/e2e-solo.mjs             # a question about your own board, and the counter its answer pays for
LIST=soulbond node scripts/e2e-solo.mjs          # two prompts for one keyword, and the partner's name on the card
```

`LIST=cascade` is the one scenario in this list that changes the *deck* rather than the matchup, and
it is there because cascade cannot be reached by playing a normal game: one copy in a sixty-card
deck fires about once every seven games. So it pastes sixty cards built for the keyword — eight
Bloodbraid Elves, twenty-three lands, nothing else over three mana — through the same paste-a-list
path a player uses, and then **requires** the free cast that every other run only reports. It earned
its place immediately: it found a table that stopped dead on its own cascade offer, and a cascade
into Rancor that asked for a target the driver answered by pressing "Cast it" forty times. Both were
in the table rather than the rules, which is what a browser suite is for.

`LIST=costs` is the second of those scenarios and asks a wider question: **evoke, dash and bestow
each add a second row to a card already in your hand**, and the table is the only place the choice
between the two rows is made — the engine's own tests build the action by hand, so a row offered
wrongly, or a bestow that never asked which creature to enchant, would pass all 1173 of them. The
deck is six Mulldrifters, eight Mardu Scouts, six Boon Satyrs and twelve guildgates to cast them
with, and the run **requires all three rows to be pressed**.

What it needed that the cascade scenario did not is **more than one game**. Which of the three a
game reaches depends on what it draws and how long it lasts: three runs of the first version each
pressed a different *two* of them. So the scenario deals again — up to three games, through the
same "play again" button the rematch check presses — until all three have been taken.

The obvious alternative was tried and was worse, which is worth writing down: teaching the driver
to **prefer** the row that pays an alternative cost turned the run into a loop, because a dashed
Mardu Scout is back in your hand at the end of the turn. One run paid the dash cost twenty-one
times across three games and never cast the Mulldrifter at all. Random picking plus dealing again
reached all three in every run.

`LIST=earned` is the third, and it is about the two rows that behave unlike the other three.
**Spectacle's row appears mid-turn** — it is not on the card until an opponent has lost life this
turn, and it is gone again when the turn ends — so pressing it is a claim about a table that redraws
its own sheet while you are looking at it. **Overload's row has no targets at all**, so the table has
to send it the moment you choose it; a table that walked you through picking a creature would hang on
a question the engine refuses. The deck is mono-red: eight Skewer the Critics, eight Mizzium Mortars,
six Lightning Bolts, twelve Monastery Swiftspears, eight Sol Rings and eighteen Mountains, and the
run requires both rows.

Getting that deck right took four tries, and every one of them is a fact about the game rather than
about the harness:

- **Twelve Swiftspears and nothing else to earn it.** An attack lands in *combat*, so the spectacle
  row only exists in that turn's postcombat main phase — which is not where most casting happens. A
  run dealt three games and reached the row in none of them. Six Lightning Bolts earn it in the
  precombat main phase instead, and a Skewer in the same hand then shows both of its rows at once.
- **Twenty-four burn spells and no bodies.** Against Tidal Mind's Wall of Frost that is two decks
  that cannot close: one run passed **450 times without reaching a winner**. The list needed a clock
  — prowess creatures, which grow with every spell in it.
- **Then the clock overshot.** Three games in twenty-nine moves never saw a sixth land, so the
  overload row was never on the sheet: five spectacle presses across three runs and no overloads.
  One row wants a turn of combat behind it and the other wants six mana, and a game short enough for
  the first is too short for the second. **Eight Sol Rings** are what a player would add to a deck
  that means to overload on time — three Mountains and two rocks is {3}{R}{R}{R} on turn four — and
  an artifact spell is a noncreature spell, so each rock is a prowess trigger too.
- **And the opponent went back to Tidal Mind.** Changing it to Ember Rush was the first attempt at
  the stall, and it worked by making games about **six moves long** — too short for a row that needs
  a turn where damage has already landed, so one run of five games never pressed the spectacle row
  at all. The stall was the missing clock rather than the matchup. With the clock and the rocks in,
  Tidal Mind gives games of 36 to 59 moves that press both rows: **three runs out of three**, where
  Ember Rush managed three out of four. A required check that fails one run in four is not a check.

The deals are budgeted at **five games** rather than the three `LIST=costs` uses, for the reason the
runs showed: whichever row a shuffle happens to offer, the other is usually a deal away, and a game
under this list is short enough that a re-deal costs almost nothing.

`LIST=graveyard` is the fourth, and it is the first browser scenario that presses a button on a card
**in the graveyard**. Flashback and escape made that row a place with *casts* in it, and the driver
has walked it since — but embalm and eternalize are **activated abilities**, so nothing is cast,
nothing goes on the stack to be countered, and what arrives is a **token whose characteristics are
not the card's**. Unearth, the only other ability in the pool used from there, had never been pressed
outside the engine's own tests. The deck is mono-white — twenty Plains, eight Mind Stones, eight
Sacred Cats, eight Adorned Pouncers, eight Sunscourge Champions, four Angel of Sanctions and four
Soul Wardens — and the run requires an embalm, an eternalize, and a Zombie on the board that the card
it copied is not.

Two things about it are worth saying rather than hiding:

- **This list has to get its own creatures killed**, which is the opposite problem from every other
  scenario here. One- and two-mana bodies die in any combat the driver walks into, and against the
  default Tidal Mind they also die to two Doom Blades and a Murder — so the graveyard fills from both
  ends. Games run long (173 to 264 moves across three runs) because a deck of lifelinkers against a
  control deck is slow, and the Mind Stones are there so that eternalize's {4}{W}{W} and {5}{W}{W}
  are affordable before the game ends.
- **The eternalized 4/4 is reported, not required, and the reason is measured.** Three runs pressed
  the eternalize row every time and none of them ever had a 4/4 Zombie on the board *when the driver
  looked* — 32 token faces across the three, not one of them a 4/4. That is not the keyword failing.
  The opponent's whole turn runs inside the same write as the pass that resolved the ability, a 4/4 is
  the biggest thing on the board, and a token that is bounced ceases to exist rather than going to a
  hand. What proves the size instead is an engine test: the altered definition survives `viewFor` and
  `packView` with its 4/4 and its empty mana cost intact, beside the printed card in the same
  payload. The browser proves the button and the Zombie; the view test proves the size.

`LIST=miracle` is the fifth, and the only one whose scenario is a *window* rather than a row. The
offer is made in the **draw step**, on a card that is still in the hand it was just drawn into, and
it is gone the moment anything else happens on the turn — so there is no button to find later and
nothing on the board to read afterwards. What the run collects instead is the sentence the bar
showed, which carries the whole claim in one string:

```
took a free cast: Thunderous Wrath is the first card you drew this turn: you may cast it for {R} (miracle)
```

The deck is mono-red — twenty-four Mountains and **eight Thunderous Wraths** over four each of
Lightning Bolt, Shock and five one- and two-drops — because one copy in sixty is offered about once
every ninety first draws, which is not a scenario. Eight copies make a first draw a Wrath about one
turn in eight, and the runs bear it out: three runs, 26 of 26 checks each, with one of them needing
a second deal. Eight copies of a six-mana instant is not a deck anybody would build, and that is the
point — every one of them that gets cast is cast for {R} off the top.

Two things it found that nothing else would have. The driver cut the offer's prompt at eighty
characters for its log, and the prompt is 88, so the keyword's own name at the end of it was thrown
away and the scenario matched none of its own offers. And the driver's fallback for an offer with
several ways to cast it only ever looked in **exile**, where cascade and madness put the card and
where a miracle card never is.

`LIST=rebound` is the sixth, and the first whose claim spans **two turns**. A Staggershock is cast,
resolves, and goes to exile rather than to a graveyard; the opponent takes a whole turn; and the bar
comes back in the player's own upkeep offering a free cast of a card they no longer have. Nothing
else in this suite asks the table to keep a promise across a turn boundary. The deck is the same
mono-red shell `LIST=miracle` uses with eight Staggershocks in place of the Wraths, so the only
difference between the two runs is the keyword. Three runs, 26 to 27 checks each.

`LIST=replicate` is the seventh, and the only one whose subject is the **price list**. A card with
replicate is offered once per count the mana will cover, so one Pyromatics with eight mana up is
three or four rows at three or four prices — and what the run proves is that the row tapped is the
row charged. That is not a hypothetical: the bot sent the printed cast for forty-nine castings
before the count was carried through (D207), and nothing about it looked wrong. The deck is
twenty-eight Mountains and eight Pyromatics, with no curve on purpose so there is spare mana by turn
five. Three runs, 25 of 25 checks each; the driver picks a random row, so it took four games in two
of the three runs to press one.

`LIST=extort` is the eighth, and the only one whose subject is a **question with a price on its
answer**. An extort trigger asks its controller for {W/B} as it resolves, and the bar draws it as
the same two-word question a Voice of All asks for a colour — so what the run proves is that
pressing the paying word spent mana and took a life. Two things it forced: the driver used to press
the first word every time, which for this question is "Decline", so it picks at random now; and the
first version of the check passed on a run that declined every time, because the prompt's own text
contains both button labels. Three runs, 25 of 25 checks each.

`LIST=suspend` is the ninth, and the only one whose two required checks are **two turns apart**. A
Rift Bolt is suspended from the hand for {R} with two time counters on it; a counter comes off at
each of the caster's upkeeps; and when the last one goes the table offers the cast for free. The run
requires both ends — the suspend row pressed, and the cast arriving later — so a mechanic that
exiled the card and then forgot about it would fail rather than pass quietly. The deck is eight Rift
Bolts behind twenty-four Mountains. Three runs, 26 of 26 checks each. It also found the table
offering a **Decline** on an offer the rules do not let you decline, which is now omitted, and the
driver reports a missing Decline instead of pressing it.

`LIST=dredge` is the tenth, and the only one whose subject is a **draw**. A Darkblast is cast, it
lands in the graveyard, and from then on every one of this seat's draw steps stops the table to ask
whether to mill three and take it back instead of drawing. Both halves are required: the dredge
pressed, and a Darkblast cast *after* one was taken — because a prompt that appears and hands back a
card nobody then plays has proved the question rather than the keyword. The deck is eight Darkblasts
and twenty bodies behind twenty-four Swamps, because the spell needs a creature to point at on its
way to the graveyard. A third check reads the **standing answer** back off the bar beside the
question — the setting that stops a dredge card asking in every draw step for the rest of the game.
Three runs, 27 of 27 checks each.

`LIST=buyback` is the eleventh, and the only one where both rows are the **same spell**. A Capsize
is cast for {1}{U}{U}{3} rather than {1}{U}{U}, and what the extra three mana buys is the card
itself: it goes back to the hand it was cast from instead of to the graveyard. Both halves are
required — the dearer row pressed, and a Capsize cast again afterwards, which it could only be if
it came home. The deck is eight Capsizes and twenty-six Islands, because paying both halves takes
six lands. Three runs, 26 of 26 checks each.

Worth saying what the dredge scenario could not have proved by accident. The prompt's own sentence
carries both button labels — "Mill 3 Draw instead" — which is exactly the trap the extort check fell
into, so the check is anchored on the **driver's** report of which button it pressed rather than on
the text of the question. A run that declined every dredge records nothing.

`LIST=proliferate` is the twelfth, and the only one whose required answer is **not a card**. The deck
poisons the computer with sixteen infect creatures, asks the question with eight Contagion Clasps,
and affords the `{4}` with four Sol Rings; the check is that a *player* was chosen, by pressing the
button on their own seat strip — which says **Choose** rather than Target, because a proliferate does
not target. Three runs, 25 of 25 checks each, the question reached on the first or second deal.

It needed two things the table did not have, and neither was about this keyword. The battlefield
never badged a permanent `playable`, although every other zone a play comes from does — so the
Clasp's ability, an equip, a crew and a monstrosity were all invisible until somebody happened to tap
the card. And the driver had never once activated an ability of a permanent, because it only taps
what carries the badge. It can now, and **only when a scenario asks**: turned on for every run, it
cost `LIST=cascade` its free cast, because regenerating a River Boa for {G} spends the Forest the
four-mana Bloodbraid Elf wanted.

`LIST=echo` is the thirteenth, and the only one whose question is raised in a step the table passes
**straight through**. Every other prompt these runs press follows something the player did — a cast,
an activation, an attack. Echo arrives in the upkeep, before anybody has acted, which is the one
place auto-pass could swallow it: a table that passed priority past its own question would lose the
creature silently, and no engine test can see that because no engine test passes priority the way a
table does. Eight Mogg War Marshals, and **both** answers are required — paying taps two lands and
keeps a 1/1, refusing puts it in the graveyard and makes a Goblin on the way out. Three runs, 26 of
26 checks each.

`LIST=upkeep` is the fourteenth, and it exists for the **button** rather than the question. Cumulative
upkeep's price climbs — {1}, then {2}, then {3} — and the question is rebuilt on each asking, so a
table that re-rendered the first one would offer `Pay {1}` against a cost of `{2}`: the engine would
refuse the payment, the permanent would go, and the player would have no way to see why. Eight Mystic
Remoras, and the check is that **two different prices** were pressed in one run. Three runs, 27 of 27
then 26 of 26 twice — the damage-order check is one of the family that only exists when the shuffle
produced the situation it is about. The arithmetic itself is pinned by the engine's own tests, on a
board built by hand.

`LIST=level` is the fifteenth, and the only one whose required check is a **card face**. A Student of
Warfare is a 1/1 that becomes a 3/3 first striker at two level counters, and that growth is printed on
the card rather than layered on it — so the run presses the level-up row on a creature already on the
battlefield, and then reads `3/3` off the card's own face. The engine's tests read the same number out
of `characteristicsOf`, which is the right place to pin the arithmetic and the wrong place to find out
what a player sees: a table still drawing the printed 1/1 would have somebody block a 3/3 with a 2/2
and lose a creature to a number that was on screen the whole time. Eight Students, and this is the
first scenario that needs the driver's **battlefield abilities** turned on — off by default, because
the first version turned it on everywhere and `LIST=cascade` stopped casting Bloodbraid Elves. Three
runs, 26 of 26 each.

`LIST=vanish` is the sixteenth, and the only one whose subject is a **number going down**. A
Calciderm is a 5/5 with shroud that leaves after three of your turns, and the turns are counted by
time counters that come off in the upkeep — a step the table passes straight through. So two things
have to be true for the card to be playable at all, and neither is visible to an engine test: the
counter has to be **on the card face**, because a 5/5 that disappears without warning cannot be
planned around, and it has to **come down**, which only a game can show. The check is that the same
clock was read at more than one number — not that a label exists, and not that two labels exist,
because a Calciderm beside a Blastoderm shows `time 4` and `fade 3` on the first move of the game
with nothing having counted down. Four Calciderms and four Blastoderms; three runs, 26 of 26 each,
having read `fade 3, 2, 1` off one game and `time 4, 3, 2, 1` off another.

`LIST=artifact` is the seventeenth, and the only one whose subject is a **sentence**. One mode of the
bar carries three different costs — sacrifice a creature, return an unblocked attacker to your hand,
sacrifice an artifact — and the words it prints are the only thing on screen that says which. Over an
Arcbound Ravager the default wording is actively wrong: half the cards it lights are not creatures, so
"tap a creature to sacrifice" sends the player looking for one and leaves the bar apparently
unresponsive. The engine knows the cost and cannot know what was said about it, so the check is here.

It found more than it was built for. The first run stopped dead on turn three and sat there for two
thousand moves with a prompt open and nothing on screen able to answer it: a dying Arcbound Worker's
modular trigger asks for "up to one target artifact creature", and the choosing prompt had no button
on it at all — written when every trigger in the pool had a target it *had* to take. A board with
eight Arcbound creatures is the first one to reach it. The prompt now draws **Choose nothing**, and
the sentence under it reads "choose a target, or none" when the trigger says you may.

`LIST=blink` is the eighteenth, and the first whose question is about **your own board**. Every other
prompt in this suite points at the opponent — a removal trigger, a counterspell, a burn spell — so
the worst a wrong answer has ever done is waste a card. Soulherder's end step asks which of *your*
creatures to exile and bring back, and a wrong answer there costs a creature: a token blinked never
returns (CR 111.7) and counters, Auras and damage do not travel with what does (CR 400.7). So the
run checks the two halves an engine test cannot reach — that the question was asked in the ability's
own words, and that the counter its answer pays for arrived **on the card face** — and reports the
third when the shuffle produces it, which is the "Choose nothing" button being the right answer
because the only other creature was a token. Eight Soulherders, four Talrands for the tokens and
Man-o'-Wars and Omenspeakers for the arrivals worth re-running; 26 of 26, with the prompt answered in
the second game of three.

It also made the driver say what it answered. A choose-prompt used to come back as "aimed a trigger",
which is true of every trigger in the pool and useless to a scenario checking that a particular one
reached the table; it now carries the ability's own description, which is what the player reads.

Two of the checks are about how the table **looks** rather than what it does, which is new and
worth saying why. A card at this table leans towards the cursor with a foil sheen that follows it,
and the board has its own mana embers drifting behind it — and both are written as CSS variables a
pointer handler sets, so nothing that does not move a real pointer can see them. The browser suite
hovers a card and reads the variables back, which is the only honest way to check a thing whose
whole existence is in the browser.

The layers under them have their own suites: `packages/rules-engine` (1173 tests, including whole
games played out by bots that only ever send moves the engine offered them — four-seat Commander
pods as well as duels), `apps/web` (224 tests, the interaction reducer behind every prompt and the deck panel) and
`apps/realtime`
(43 tests against live Redis, including two socket clients playing to a finish, one person
playing the server, a deal struck with the server's own seat, and two players rematching on
decks they pasted in).

## What is not done

- **A list of your own plays, but only the pool is automated.** Paste your decklist in the lobby and
  the table deals it (see *Play with your own list*). Every name the engine's pool has — the three
  hundred and thirty-three cards in the thirteen starter decks, commanders included — becomes the real
  card and is fully automated. Every name it does not becomes **cardboard**: a card with a name and
  nothing else, which the tabletop plays by hand with **Move by hand** for whatever it says in
  prose, and which Arena mode refuses by name rather than dealing a game with a card nobody can do
  anything with. Closing that gap needs card data for arbitrary names — type lines, mana costs,
  oracle text — which means a populated `cards` table, which means a machine that can reach
  Scryfall. Loading a saved Grimore deck rather than pasting text is the same gap: the deck source
  exists, the card data does not.
- **The engine knows three hundred and thirty-three cards.** Everything in the thirteen starter decks,
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
  walking into, sends the whole swing at one of them in a press, records a deal — three preset
  things you can say to another player, their answer, and a badge on whoever went back on one — and
  now **remembers what everybody has actually done to you, and what they have not**: each
  opponent's strip reads `hit you N` for the damage that player has dealt you over the whole game,
  combat and spells alike, and `spared you N` for the attacking power they could legally have aimed
  at you and sent somewhere else. The second needed the engine rather than the screen — a player who
  attacked somebody else looks exactly like a player who could not attack you, and the legality
  check that tells them apart happens when the attack is declared. So the political read is three
  things now: what somebody promised, what they did, and what they chose not to do. What the table does not do is enforce any of it,
  deliberately — a table where the software stops you breaking your word is a table where your word
  costs nothing. Anything said beyond those three sentences is still between the people at the
  table, in the chat panel or out loud.
- **Websocket only.** A network that blocks WebSockets cannot play, because the server has polling
  disabled. Rare, but it would look like a table that never connects.
