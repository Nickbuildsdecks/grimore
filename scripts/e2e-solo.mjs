/**
 * One person, one browser, a whole game of Magic against the computer.
 *
 * The third of the browser suites. `e2e-table.mjs` proves two people can share a tabletop,
 * `e2e-arena.mjs` proves two people can play with the rules engine running the game, and this one
 * proves a single person can sit down and play right now — no code to share, nobody to wait for.
 *
 * It is a short script because that is the point: the lobby has one button for it, and from there
 * the only thing the player does is take the move the table offers. Everything the opponent does
 * happens server-side, inside the same pod write as the move that provoked it, so there is never a
 * state on screen that the opponent has not finished moving in.
 *
 * Run it yourself (the launcher starts both servers):
 *   PLAY_HOST=127.0.0.1 node scripts/play.mjs &
 *   node scripts/e2e-solo.mjs
 */
import path from 'node:path';
import {
  chromium, check, checks, setShotDir, summarize, shot, waitFor, tid, cardsIn, has, text,
  isMyMove, makeMove, press, readNumber, expectEventuallyTrue, watchForReactWarnings, tap,
  textOf,
} from './lib/table-driver.mjs';

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'solo');
const HEADED = process.env.HEADED === '1';
/**
 * `SOLO_POD=1` plays the four-seat Commander table instead of the duel.
 *
 * The same script, because it is the same claim — one person, one browser, a whole game — and
 * the only difference is how many seats the server is playing. A second file would be a second
 * copy of the play loop, and this project has already learned what that costs.
 */
const SOLO_POD = process.env.SOLO_POD === '1';
/**
 * `LIST=cascade` pastes a deck built to cascade instead of Ember Rush's own sixty,
 * `LIST=costs` one built to pay an alternative cost — see `COSTS_LIST` — `LIST=graveyard` one built
 * to press an ability on a card in the graveyard (`GRAVEYARD_LIST`), `LIST=miracle` one whose
 * first draw is often the card it is built around (`MIRACLE_LIST`), `LIST=rebound` one built to
 * cast the same spell twice a turn apart (`REBOUND_LIST`), `LIST=replicate` one with the mana to
 * pay one cost several times over (`REPLICATE_LIST`), `LIST=extort` one that is asked for mana
 * every time it casts a spell (`EXTORT_LIST`), `LIST=suspend` one that spends its first turn on a
 * card it will cast two turns later (`SUSPEND_LIST`), `LIST=dredge` one that keeps buying the same
 * spell back out of its graveyard (`DREDGE_LIST`), `LIST=buyback` one that pays to keep the spell
 * it just cast (`BUYBACK_LIST`), `LIST=proliferate` one that poisons the computer and then asks the
 * table to pick it out of a list of permanents (`PROLIFERATE_LIST`), `LIST=echo` one that is asked
 * for mana in its own upkeep (`ECHO_LIST`), `LIST=upkeep` one whose upkeep question gets **dearer**
 * every turn (`UPKEEP_LIST`), `LIST=level` one whose creatures grow by being paid for
 * (`LEVEL_LIST`), `LIST=vanish` one whose creatures arrive on a clock the card face shows running
 * down (`VANISH_LIST`), `LIST=artifact` one that pays a cost with a spare artifact rather than a
 * creature (`ARTIFACT_LIST`), `LIST=soulbond` one built to **pair** its creatures, for the two
 * prompts and the badge the mechanic raises (`SOULBOND_LIST`), and `LIST=earned` one
 * built for the two alternative costs whose **rows** behave unlike any other row, see
 * `EARNED_LIST`.
 *
 * Cascade is the one mechanic in the pool a browser suite cannot reach by playing a real game: the
 * keyword fires about once every seven games with one copy in a sixty-card deck, and what it finds
 * has to be a nonland card cheaper than four. So the scenario stacks the odds the only way a player
 * could — by building a deck for it — with four Bloodbraid Elves and thirty-three cards at three
 * mana or less, and then **requires** what the default run only samples.
 *
 * It is still the pasted-list path, so it is still a check on the engine with nothing special about
 * it: the deck is text a player could type, and every card in it is one of the pool's.
 */
const LIST = process.env.LIST ?? '';
/**
 * Which deck the computer plays. Tidal Mind, because it is the deck that asks the table the most
 * questions — and `LIST=earned` keeps it, which was not obvious and is worth the paragraph.
 *
 * When that list had no clock, Tidal Mind looked like the problem: burn and sweepers against a
 * Wall of Frost and a Dirgur Nemesis is two decks that cannot close, and one run went past **450
 * moves of nothing but Pass** without reaching a winner. Switching the opponent to Ember Rush
 * fixed that and broke the other end — games of about six moves, too short for a spectacle row
 * that needs a turn where damage has already landed, and one run of five games pressed it not
 * once. The stall was the missing clock rather than the matchup: with the Swiftspears and the Sol
 * Rings in the list (see `EARNED_LIST`), Tidal Mind gives games of 36 to 59 moves that press both
 * rows, three runs out of three, where Ember Rush managed three out of four.
 */
const OPPONENT_DECK = process.env.OPPONENT_DECK ?? 'tidal-mind';
const MAX_MOVES = Number.parseInt(process.env.MAX_MOVES ?? '2000', 10);

/**
 * The solo player's hands are the shared driver's.
 *
 * They used to be a copy of them, and the copy is what broke: the X-cost prompt was taught to
 * `lib/table-driver.mjs`, the two-browser suites learned it for free, and this one sat on a
 * stalled game at turn seven because its own copy had never heard of it. A third copy of "what
 * does this prompt mean" is a third thing to forget.
 */
/**
 * Sixty cards built to cascade: twenty-three lands, **eight** Bloodbraid Elves, and nothing else
 * over three mana.
 *
 * Every card is one the pool already holds and scripts, so the engine is offered on it — which is
 * the whole point of the pasted path. The curve is the scenario: a cascade off a four-mana Elf
 * needs a nonland card of mana value three or less, and in this list every nonland card but the
 * Elves themselves is one.
 *
 * Eight rather than the four it started with, and the number is a measurement rather than a
 * preference: with four, one run in three finished before an Elf was ever cast and the required
 * check failed on a game that was fine. A scenario that is only usually reached is not a scenario,
 * and eight copies is what a player building a deck for one card would actually do.
 */
const CASCADE_LIST = [
  '12 Mountain', '11 Forest',
  '8 Bloodbraid Elf',
  '4 Lightning Bolt', '4 Lightning Strike', '4 Llanowar Elves', '4 Ambush Viper',
  '4 Borderland Marauder', '4 Burning-Tree Emissary', '3 River Boa', '2 Rancor',
].join('\n');

/**
 * Sixty cards built to pay an **alternative cost**: eight each of the three cards that offer one.
 *
 * The same problem `LIST=cascade` solves and a wider version of it. Evoke, dash and bestow each add
 * a second row to a card already in your hand, and the table is the only place the choice between
 * the two rows is actually made — the engine's tests build the action by hand, so a row that was
 * offered wrongly, or a bestow that never asked which creature to enchant, would pass every one of
 * them. A normal game reaches these cards once or twice, and the driver picks a row at random, so
 * one copy apiece is a coin flip on a coin flip.
 *
 * **Eight apiece**, and each count is a measurement rather than a preference. Six of each read
 * "dash: 0" on a game of 27 moves in sixteen turns — a three-colour mana base failing rather than a
 * keyword, which is why twelve of the twenty-four lands are guildgates, four from each of the three
 * guilds involved. With that fixed, six still left one of the three unpressed in most single games:
 * the cards are three colours and a game reaches what it draws. Eight of each, with Birds of
 * Paradise and Llanowar Elves for the mana and Grizzly Bears so a bestowed Satyr always has
 * something to enchant, is what a player building this deck would do — and the scenario deals again
 * if a game still misses one. Every card is one the pool already scripts, which is what keeps this
 * the pasted-list path rather than a special case.
 */
const COSTS_LIST = [
  '5 Forest', '4 Island', '3 Mountain',
  '4 Gruul Guildgate', '4 Izzet Guildgate', '4 Simic Guildgate',
  '8 Mulldrifter', '8 Mardu Scout', '8 Boon Satyr',
  '4 Birds of Paradise', '4 Llanowar Elves', '4 Grizzly Bears',
].join('\n');

/**
 * Sixty cards built for the two cheap rows that behave unlike every other cheap row.
 *
 * `LIST=costs` above asks whether a second row on a card in hand can be pressed at all. These two
 * ask something the other three cannot:
 *
 * - **Spectacle** ({R} instead of {2}{R} on Skewer the Critics) is the only row in the game that
 *   *appears mid-turn*. It is absent until an opponent has lost life this turn and gone again when
 *   the turn ends, so pressing it is a claim about a table that redraws its own sheet while the
 *   player is looking at it.
 *
 *   Two ways to earn it are in the list on purpose, because the first one alone was not enough.
 *   Eight Monastery Swiftspears earn it the way a player would — by attacking — but an attack lands
 *   in combat, so the row only exists in the *postcombat* main phase of that turn, and a run that
 *   dealt three games reached it in none of them. Eight Lightning Bolts earn it in the **precombat**
 *   main phase instead, where the driver does most of its casting, and a Skewer in the same hand
 *   then shows both of its rows at once. (A Skewer aimed at the other player earns it for the next
 *   Skewer, too.)
 * - **Overload** ({3}{R}{R}{R} on Mizzium Mortars) is the only row with **no targets at all**. The
 *   table has to send it the moment it is chosen rather than walking the player through a pick, and
 *   a table that asked would hang on a question the engine refuses. It is also dearer than printed,
 *   so twenty lands is not greed — six of them have to be out at once.
 *
 * Twelve Monastery Swiftspears are the **clock** and eight Sol Rings are the **mana**, and both are
 * here because of what the list did without them. Twenty-four burn spells and no bodies against a
 * control deck is a game neither side can close: one run passed four hundred and fifty times
 * without reaching a winner. A prowess creature that grows with every spell in this list fixed
 * that — and then fixed it too well, because the next run played **three whole games in
 * twenty-nine moves** and never saw a sixth land, so the overloaded row was never on the sheet.
 *
 * Which is the honest shape of the problem: one row wants a turn of combat behind it and the other
 * wants six mana, and those pull in opposite directions. Mana rocks are what a player would add to
 * a deck that means to overload on time, so eight Sol Rings are what the list adds: three Mountains
 * and two Sol Rings is {3}{R}{R}{R} on turn four, and an artifact spell is a noncreature spell, so
 * each one is a prowess trigger as well. `OPPONENT_DECK` above has the rest of that story,
 * including the version of this fix that changed the opponent instead and why it was reverted.
 *
 * Mono-red on purpose: `LIST=costs` needed three colours and failed its first run on the mana base
 * rather than on a keyword, and the fix was twelve guildgates. This list has nothing to fix.
 */
const EARNED_LIST = [
  '18 Mountain', '8 Sol Ring',
  '8 Skewer the Critics', '8 Mizzium Mortars',
  '6 Lightning Bolt', '12 Monastery Swiftspear',
].join('\n');

/**
 * Sixty cards built to press a button on a card in the **graveyard**.
 *
 * The one zone no browser suite has ever activated an ability from. Flashback and escape made the
 * graveyard a row with *casts* in it, and the driver has walked that row since — but embalm and
 * eternalize are **activated abilities**, so nothing goes on the stack and nothing is cast, and
 * what arrives is a token whose characteristics are not the card's. Unearth, the only other ability
 * in the pool used from there, has never been pressed outside the engine's own tests.
 *
 * Which makes this the list that has to get its own creatures killed. Four cards carry the two
 * keywords and all four are white, so the mana base is twenty Plains and nothing to fix — the
 * lesson `LIST=costs` paid for twice. Eight Sacred Cats and eight Adorned Pouncers are one- and
 * two-mana bodies that die in any combat the driver walks into, and eight **Mind Stones** are there
 * for the far end of the curve: eternalize is {4}{W}{W} and {5}{W}{W}, which is six and seven mana
 * in a game this list wants to be short.
 *
 * Soul Wardens fill the last four slots rather than a fifth copy of something: they are a body for
 * one mana that the deck is happy to lose, and the life they gain keeps the game going long enough
 * for the seven-mana row to be affordable once.
 *
 * Against the default Tidal Mind, which is what makes the dying reliable from both ends — walls
 * that eat a 1/1 attacking into them, and two Doom Blades and a Murder for the ones that stay home.
 */
const GRAVEYARD_LIST = [
  '20 Plains', '8 Mind Stone',
  '8 Sacred Cat', '8 Adorned Pouncer', '8 Sunscourge Champion', '4 Angel of Sanctions',
  '4 Soul Warden',
].join('\n');

const myMove = (page) => isMyMove(page);
/**
 * Aggression 1: a solo game has nobody to hold mana up against, so it always develops.
 *
 * The driver picks a random row when a card offers several, and under `LIST=costs` that was nearly
 * replaced with a preference for the row paying an alternative cost — which made the scenario
 * **worse** and is worth the sentence. A dashed Mardu Scout is back in hand at the end of the turn,
 * so "always take the cheap row" is a loop: one run paid the dash cost twenty-one times across
 * three games and never once cast the Mulldrifter, because the Scout was always the cheapest thing
 * to do and always came back. Random picking plus dealing again reached all three in every run.
 */
/*
  `abilities` under `LIST=proliferate` only, because an ability spends mana a spell wanted.

  The Clasp's proliferate is an activated ability on the battlefield, which is the one place the
  driver does not look by default — see `tryToPlayFromHand`. Turning it on everywhere cost the
  cascade scenario its free cast: its River Boas regenerate for {G}, and a Forest spent on a shield
  is a Forest the Bloodbraid Elf needed.
*/
const takeTurn = (page) =>
  /*
    And under `LIST=artifact`, where the cost is the whole point and costs no mana at all: the
    Ravager's row is "Sacrifice an artifact" with no mana part, so turning abilities on here takes
    nothing away from the spells, which is the objection that keeps it off everywhere else.
  */
  makeMove(page, 0, {
    aggression: 1,
    abilities: LIST === 'proliferate' || LIST === 'level' || LIST === 'artifact',
  });

async function main() {
  await setShotDir(SHOT_DIR);
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await context.newPage();
  const pageErrors = [];

/**
 * Sixty cards built so the turn's **first draw** is often a Thunderous Wrath.
 *
 * Miracle is the narrowest window in the pool: one card, one draw, and only the first of the turn.
 * In its own deck it fires about once every six games (`offers.mjs`: 59 offers in 288 games off a
 * single copy), which is not a scenario — so this list carries eight, where a first draw is a
 * Wrath about one turn in eight and a game of fifteen turns offers one or two.
 *
 * Mono-red for the lesson `LIST=costs` paid for twice: a scenario that needs two colours fails on
 * its mana base rather than on the thing being tested. Eight copies of a six-mana instant is not a
 * deck anybody would build, and that is the point — every one of them cast is cast for {R} off the
 * top, which is the only claim this list makes.
 */
const MIRACLE_LIST = [
  '24 Mountain',
  '8 Thunderous Wrath',
  '4 Lightning Bolt', '4 Shock', '4 Monastery Swiftspear', '4 Goblin Arsonist',
  '4 Borderland Marauder', '4 Firebrand Archer', '4 Raging Goblin',
].join('\n');

/**
 * Sixty cards whose first draw is beside the point: eight **Staggershocks**, cast for the keyword
 * that fires a turn later.
 *
 * `LIST=miracle` is built around a card being drawn; this one is built around a card being *cast*,
 * which is a much easier thing to arrange — so the eight copies are here for the same reason the
 * Wraths are, to make the window frequent rather than to make the deck good. Mono-red again, and
 * the same shell, so the only difference between the two runs is the keyword under test.
 */
const REBOUND_LIST = [
  '24 Mountain',
  '8 Staggershock',
  '4 Lightning Bolt', '4 Shock', '4 Monastery Swiftspear', '4 Goblin Arsonist',
  '4 Borderland Marauder', '4 Firebrand Archer', '4 Raging Goblin',
].join('\n');

/**
 * Sixty cards built to have mana left over: eight **Pyromatics** and twenty-eight Mountains.
 *
 * Replicate is a cost paid as many times as you can afford it, so the scenario is not about drawing
 * the card — it is about *having the mana when you cast it*. A normal red deck spends its mana on
 * its curve; this one deliberately does not have a curve, so by turn five there is enough spare to
 * pay the cost twice and the table has three rows to offer on one card.
 *
 * Which is the claim: `legalActions` offers one play per affordable count (CR 702.56), the table
 * draws them as separate rows with their own prices, and the engine accepts the count the player
 * tapped rather than the printed cast. That last part is not hypothetical — the bot sent the
 * printed cast for 49 castings before the count was carried through (D207).
 */
const REPLICATE_LIST = [
  '28 Mountain',
  '8 Pyromatics',
  '4 Lightning Bolt', '4 Shock', '4 Monastery Swiftspear', '4 Goblin Arsonist',
  '4 Firebrand Archer', '4 Raging Goblin',
].join('\n');

/**
 * Sixty cards whose every spell is a toll: eight **Basilica Screechers** and nothing but black.
 *
 * Extort asks its question once per spell its controller casts, so the scenario is about casting
 * *often* with a Screecher on the board — cheap removal, cheap bodies and Mind Stones, so the mana
 * is there for the spell and for the {W/B} after it.
 *
 * It is the only list here whose subject is a **question**: the first optional mana cost in this
 * engine that a player is asked for in the middle of a resolution (D208). What the run proves is
 * that the table drew the two words, that pressing the paying one *spent mana*, and that the
 * opponent's life went down for it.
 */
const EXTORT_LIST = [
  '24 Swamp',
  '8 Basilica Screecher',
  '4 Doom Blade', '4 Ravenous Rats', '4 Vampire Nighthawk', '4 Mind Rot',
  '4 Agonizing Demise', '4 Tormod\'s Crypt', '4 Mind Stone',
].join('\n');

/**
 * Sixty cards built to spend turn one on turn two: eight **Rift Bolts** and nothing to hold them up.
 *
 * Suspend is the only mechanic here whose payoff is in a *later turn*, so the scenario needs two
 * things a normal deck will not give it: a reason to suspend (a hand full of cards that are better
 * suspended than cast) and games long enough for the counters to come off. Eight copies of a
 * three-mana sorcery that costs {R} suspended is both.
 *
 * What the run proves is the pair of joints the engine's own tests cannot reach through a table: the
 * suspend **row** on a card in hand — a fourth thing to do with one card, beside casting it — and
 * the cast that arrives in a later upkeep with **no Decline button**, because that cast is not a
 * request (CR 702.62c).
 */
const SUSPEND_LIST = [
  '24 Mountain',
  '8 Rift Bolt',
  '4 Lightning Bolt', '4 Shock', '4 Monastery Swiftspear', '4 Goblin Arsonist',
  '4 Firebrand Archer', '4 Raging Goblin', '4 Borderland Marauder',
].join('\n');

/**
 * A deck with nothing to spend its mana on but the same spell, over and over (CR 702.26a).
 *
 * Buyback is a price list rather than an effect: the card is the same either way, and what the
 * extra mana buys is the card itself, back in your hand. So the scenario needs two things a normal
 * deck will not reliably give it — **enough lands to pay both halves** (six for a Capsize with its
 * buyback) and a board worth pointing at, which the computer's own creatures supply.
 *
 * What the run proves is the pair the engine's tests cannot reach through a table: the **second
 * row** on a card already in hand, priced at the printed cost plus the buyback, and the card
 * arriving back in the hand it was cast from rather than in the graveyard.
 */
const BUYBACK_LIST = [
  '26 Island',
  '8 Capsize',
  '4 Whispers of the Muse', '4 Preordain', '4 Thieving Magpie', '4 Wind Drake',
  '4 Air Elemental', '2 Mulldrifter', '4 Omenspeaker',
].join('\n');

/**
 * A deck that spends every draw step buying the same spell back (CR 702.52a).
 *
 * Dredge is the one keyword in the pool whose prompt is about a **draw** rather than about a card
 * somebody played, and it needs two things a normal deck does not reliably give it: a dredge card
 * that actually reaches the graveyard, and creatures on the table for it to point at on the way
 * there. Eight Darkblasts and twenty bodies is both — the spell is cast, it lands in the graveyard,
 * and from then on every draw step is a question.
 *
 * What the run proves is the pair of joints no engine test can reach through a table: the prompt
 * itself — two buttons about a draw, with the price in cards — and the **card coming back**, which
 * is the half that makes dredge a keyword rather than a drawback.
 */
const DREDGE_LIST = [
  '24 Swamp',
  '8 Darkblast',
  '4 Child of Night', '4 Vampire Nighthawk', '4 Ravenous Rats', '4 Drudge Skeletons',
  '4 Doom Blade', '4 Gravedigger', '4 Sign in Blood',
].join('\n');

/**
 * A deck that poisons the computer and then asks the table to point at it (CR 701.27a).
 *
 * Proliferate is the only question at this table whose answer can be a **player**, and a player is
 * only an answer while they have a counter on them — so the scenario has to arrange the one thing
 * no other list needs: poison on the opposite side of the board. Sixteen infect creatures do that
 * by attacking, eight Contagion Clasps ask the question, and the Fortifications and the Wolves
 * keep permanents with counters on this side so the answer is a mixed one rather than a seat alone.
 *
 * The Sol Rings are the difference between a scenario that reaches the question and one that runs
 * out of games waiting: the Clasp's proliferate costs {4} on top of the {2} that put it on the
 * table, so without them the question is a turn-six question and four of the five deals ended
 * before it was ever asked.
 *
 * What the run proves is the joint the engine's own tests cannot reach: a seat strip lit as part of
 * an answer, with a button that says Choose rather than Target, and the counter landing on a player
 * who was never pointed at by a spell.
 */
const PROLIFERATE_LIST = [
  '24 Forest',
  '8 Contagion Clasp',
  '4 Glistener Elf', '4 Blight Mamba', '4 Cystbearer', '4 Ichorclaw Myr',
  '4 Vastwood Fortification', '4 Young Wolf', '4 Sol Ring',
].join('\n');

/**
 * A deck that is asked for mana in its own upkeep, over and over (CR 702.29).
 *
 * Echo is the only question in this pool the **game** asks rather than the player, and the only one
 * raised in a step a table is normally passing straight through — which is exactly the kind of thing
 * a browser run can check and an engine test cannot: the upkeep is where auto-pass lives.
 *
 * Eight Mogg War Marshals, because the question has to be reached several times for the run to see
 * both answers: paying keeps a 1/1, declining makes a second Goblin, and the deck is happy either
 * way. Twenty-four Mountains so the {1}{R} is affordable whenever the question comes.
 */
const ECHO_LIST = [
  '24 Mountain',
  '8 Mogg War Marshal',
  '4 Monastery Swiftspear', '4 Goblin Arsonist', '4 Raging Goblin', '4 Borderland Marauder',
  '4 Lightning Bolt', '4 Shock', '4 Firebrand Archer',
].join('\n');

/**
 * A deck whose upkeep question costs one more every time it is asked (CR 702.24).
 *
 * The echo row proves a table can be asked something in its own upkeep. This one proves the thing
 * only a *climbing* price can test: the words on the button change between one asking and the next,
 * and a table that re-rendered the old question would offer `Pay {1}` for a cost of `{2}` — a
 * payment the engine would then refuse, with the permanent going anyway and the player unable to
 * see why.
 *
 * Eight Mystic Remoras and twenty-six Islands, because the claim needs **two different prices** in
 * one run: the first upkeep asks {1}, the second {2}, and a deck with one copy that dies to the
 * first refusal never gets there.
 */
const UPKEEP_LIST = [
  '26 Island',
  '8 Mystic Remora',
  '4 Omenspeaker', '4 Man-o\'-War', '4 Wind Drake', '4 Preordain',
  '4 Air Elemental', '4 Thieving Magpie', '2 Mulldrifter',
].join('\n');

/**
 * A deck whose creatures are bigger the more mana went into them (CR 702.87).
 *
 * Level up is the first thing in this pool where what a creature **is** depends on a count on
 * itself, and the engine's own tests read that off `characteristicsOf` on a board built by hand.
 * What they cannot see is the **card face**: a Student of Warfare at level two is a 3/3 on the
 * board, and a table that drew its printed 1/1 would be showing the player a creature that does not
 * exist — which is the sort of thing you discover by blocking wrongly.
 *
 * Eight Students and twenty-four Plains, so a game reaches the second band with mana left over.
 */
const LEVEL_LIST = [
  '24 Plains',
  '8 Student of Warfare',
  '4 Soul Warden', '4 Healer\'s Hawk', '4 Topan Freeblade', '4 Guardians of Akrasa',
  '4 Swords to Plowshares', '4 Pacifism', '4 Leonin Skyhunter',
].join('\n');

/**
 * A deck whose best creatures come with a countdown printed on them (CR 702.63, CR 702.32).
 *
 * Both halves of the claim are things only a browser can see. The **counter is on the card face**,
 * so a player can tell how many turns are left — a 5/5 that vanishes with no warning is a 5/5
 * nobody can plan around. And the number has to **come down between turns**, which is the part an
 * engine test pins on a board built by hand and cannot pin on a board a game produced.
 *
 * Four Calciderms and four Blastoderms, so one of the two clocks is usually running by the time the
 * run has a few turns on it, and twenty-six lands split evenly, because a four-drop that has to land
 * early enough for its clock to run is a four-drop worth being greedy about.
 */
/**
 * Whether a set of `time N` / `fade N` readings is a **countdown** rather than a label.
 *
 * Two readings of the *same* clock at different numbers. Two different clocks at one number each
 * is two creatures, not a turn passing, which is the mistake a plain `size > 1` would make: a
 * Calciderm and a Blastoderm on the board at once give `time 4` and `fade 3` on the very first
 * move, and nothing has counted down at all.
 */
const hasACountdown = (faces) => {
  const byClock = new Map();
  for (const face of faces) {
    const [clock, n] = face.split(' ');
    byClock.set(clock, (byClock.get(clock) ?? new Set()).add(n));
  }
  return [...byClock.values()].some((seen) => seen.size > 1);
};

const VANISH_LIST = [
  '13 Plains', '13 Forest',
  '4 Calciderm', '4 Blastoderm',
  '4 Llanowar Elves', '4 Topan Freeblade', '4 Centaur Courser',
  '4 Swords to Plowshares', '4 Giant Growth', '4 Rampant Growth', '2 Pacifism',
].join('\n');

/**
 * A deck whose costs are paid with **artifacts**, for the one sentence on the table that says so.
 *
 * The bar asks three different questions through one mode — sacrifice a creature, return an
 * unblocked attacker to your hand, sacrifice an artifact — and the sentence it prints is the only
 * thing on screen that distinguishes them. The third of those is new (D222) and no other list can
 * produce it: the Arcbound Ravager is the pool's only artifact cost, it lives in one deck, and
 * `LIST=vanish` and the rest never put one on the board.
 *
 * Twelve Equipment and four Vehicles against eight artifact creatures, which is the ratio the
 * scenario needs rather than a deck anybody would build. The Ravager is an artifact itself, so a
 * board with nothing but Ravagers offers the row and has nothing the rule will pay it with — the
 * pool instrument found exactly that in 434 windows of 434. Twelve spare Equipment is how a browser
 * run gets a board where something *else* can pay.
 *
 * Mono-white plus colourless, for the lesson `LIST=costs` paid for twice: a scenario needing two
 * colours fails on its mana base rather than on the thing it is testing.
 */
/**
 * A deck whose end step asks a question about **your own** board, for the prompt only a blink
 * raises.
 *
 * Soulherder's trigger is the first in the pool that stops the table to ask which of *your*
 * creatures to point at, and the first whose answer can be "none" for a reason other than an empty
 * board — a token blinked does not come back (CR 111.7), so declining is sometimes the play. Both
 * halves live entirely in the table: the engine's own tests build the answer by hand, so a prompt
 * that never appeared, or one with no way to decline, would pass all of them.
 *
 * Eight Soulherders rather than the one Skyward Writ runs, because the scenario needs one on the
 * board early enough for the end steps to add up; four Talrands for the tokens, which is where the
 * decline comes from; and Man-o'-Wars and Omenspeakers so the blink has arrivals worth re-running
 * and the run says so in the log.
 *
 * Mono-blue, for the lesson `LIST=costs` paid for twice: a scenario that needs two colours fails on
 * its mana base rather than on the thing being tested.
 */
const BLINK_LIST = [
  '24 Island',
  '8 Soulherder', '4 Talrand, Sky Summoner',
  '4 Man-o\'-War', '4 Omenspeaker',
  '4 Counterspell', '4 Essence Scatter', '4 Unsummon', '4 Tome Scour',
].join('\n');

/**
 * A deck that **pairs**, for the two prompts and the badge only soulbond raises.
 *
 * Soulbond is the first link in this engine between two permanents that is not an attachment
 * (D247), and it asks the player two different questions through two different prompts: the
 * soulbonded creature arriving asks *which* unpaired creature of yours to pair with (a declinable
 * target), and any other creature arriving asks *whether* to pair with it (a word). The engine's
 * own tests build both answers by hand, so a prompt that never appeared, or a pair the board never
 * drew, would pass every one of them.
 *
 * Eight soulbond creatures rather than the two Verdant Guard runs, and sixteen cheap bodies for
 * them to pair with: the scenario needs a creature already standing when the Forcemage lands, which
 * is the whole of the mechanic and a fact about the shuffle otherwise. The Forcemage carries it at
 * three mana; the Silverheart is six and arrives in the games that go long.
 *
 * Mono-green, for the lesson `LIST=costs` paid for twice: a scenario needing two colours fails on
 * its mana base rather than on the thing it is testing.
 */
const SOULBOND_LIST = [
  '24 Forest',
  '4 Trusted Forcemage', '4 Wolfir Silverheart',
  '4 Grizzly Bears', '4 Llanowar Elves', '4 Centaur Courser', '4 Giant Spider',
  '4 Giant Growth', '4 Rampant Growth', '4 Prey Upon',
].join('\n');

/**
 * A deck whose spells get cheaper as the board fills, for the badge that says so.
 *
 * The table has drawn "what the board did to this cost" beside the printed one since D132 — a
 * Goblin Electromancer's reduction, a Thalia's tax — and **no browser run had ever looked at it**.
 * The engine's tests read `costChange` off the play and the web unit tests read the reducer; neither
 * of them can say whether the number reaches the screen, which is the only place a player meets it.
 *
 * Affinity is the card that makes it unmissable: forty artifacts in sixty cards, so a
 * Frogmite printed at {4} is routinely a one-mana 2/2 and often a free one. The run requires a row
 * with a reduction on it to have been **pressed**, which is the badge and the payment agreeing in
 * the one place they can disagree.
 *
 * Sixteen Frogmites rather than a mixed pair, because a pasted list is not a deck list: the pool
 * holds one of them (D228 took the Myr Enforcer back out on the slot probe) and a custom list can
 * ask for any number of a name the pool knows. Sixteen of a card that pays for the next one is the
 * fastest way to put a big reduction on the screen.
 *
 * Mono-white plus colourless, for the lesson `LIST=costs` paid for twice.
 */
const AFFINITY_LIST = [
  '20 Plains',
  '16 Frogmite',
  '12 Bonesplitter', '12 Sky Skiff',
].join('\n');

const ARTIFACT_LIST = [
  '24 Plains',
  '4 Arcbound Ravager', '4 Arcbound Worker',
  '4 Bonesplitter', '4 Basilisk Collar', '4 Darksteel Plate', '4 Sky Skiff',
  '4 Juggernaut', '4 Elite Vanguard', '4 Doomed Traveler',
].join('\n');
  const reactWarnings = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  watchForReactWarnings(page, '', reactWarnings);

  try {
    await page.goto(BASE);
    await waitFor(page, 'lobby');
    await tid(page, 'player-name').fill('Nick');

    // One button. That is the whole of starting a game on your own.
    const entry = SOLO_POD ? 'solo-pod' : `solo-${OPPONENT_DECK}`;
    await waitFor(page, entry);
    await tid(page, entry).click();
    await waitFor(page, 'pregame');
    check(SOLO_POD
      ? 'the lobby offers a Commander pod against the computer'
      : 'the lobby offers a game against the computer', true);

    // No ready-up: there is nobody to wait for, so the table deals itself.
    await waitFor(page, 'deck-ember-rush', 20000);
    check('the table deals without anybody having to ready up', true);
    const seatText = await text(page, 'lobby-seat-1');
    check('and says which seat the computer plays', /computer/i.test(seatText), seatText);
    if (SOLO_POD) {
      const seats = await page.locator('[data-testid^="lobby-seat-"]').count();
      check('four seats, three of them the computer’s', seats === 4, `seats ${seats}`);
    }
    await shot(page, 'solo-lobby');

    /*
      The deck, pasted in as text rather than picked off the shelf.

      It is Ember Rush's own sixty cards, written out the way a player keeps their deck — which
      makes this the same game this suite has always played, with one thing changed: where the
      cards came from. So every check below is still a check on the engine, and the pasted path
      either deals a real game or the whole suite says so. The Commander pod keeps the built-in
      deck, because a pasted list has no commander and a pod needs one.
    */
    if (SOLO_POD) {
      await tid(page, 'deck-ember-rush').click();
    } else {
      const { STARTER_DECKS } = await import(
        new URL('../packages/rules-engine/dist/index.js', import.meta.url));
      const asText = LIST === 'cascade'
        ? CASCADE_LIST
        : LIST === 'costs'
        ? COSTS_LIST
        : LIST === 'earned'
        ? EARNED_LIST
        : LIST === 'graveyard'
        ? GRAVEYARD_LIST
        : LIST === 'miracle'
        ? MIRACLE_LIST
        : LIST === 'rebound'
        ? REBOUND_LIST
        : LIST === 'replicate'
        ? REPLICATE_LIST
        : LIST === 'extort'
        ? EXTORT_LIST
        : LIST === 'suspend'
        ? SUSPEND_LIST
        : LIST === 'dredge'
        ? DREDGE_LIST
        : LIST === 'buyback'
        ? BUYBACK_LIST
        : LIST === 'proliferate'
        ? PROLIFERATE_LIST
        : LIST === 'echo'
        ? ECHO_LIST
        : LIST === 'upkeep'
        ? UPKEEP_LIST
        : LIST === 'level'
        ? LEVEL_LIST
        : LIST === 'vanish'
        ? VANISH_LIST
        : LIST === 'artifact'
        ? ARTIFACT_LIST
        : LIST === 'blink'
        ? BLINK_LIST
        : LIST === 'affinity'
        ? AFFINITY_LIST
        : LIST === 'soulbond'
        ? SOULBOND_LIST
        : STARTER_DECKS['ember-rush'].cards
          .map((entry) => `${entry.count} ${entry.card.name}`).join('\n');
      await tid(page, 'paste-list').click();
      await waitFor(page, 'deck-text');
      await tid(page, 'deck-text').fill(asText);
      await tid(page, 'use-list').click();
      await waitFor(page, 'deck-custom');
      const note = await text(page, 'list-note');
      check('a list pasted in as text is read, counted and loaded as a deck',
        note.includes('60 cards') && note.includes('every one of them scripted'), note);
    }
    await waitFor(page, 'start-engine');
    check('and the engine is offered on it, because it knows every card in it',
      await expectEventuallyTrue(page, async () => tid(page, 'start-engine').isEnabled()));
    await tid(page, 'start-engine').click();

    await waitFor(page, 'table');
    await waitFor(page, 'phase-bar');
    await waitFor(page, 'mulligan-prompt');
    check('the game starts and asks for an opening-hand decision', true);
    if (SOLO_POD) {
      const lives = [];
      for (let s = 0; s < 4; s++) lives.push(await readNumber(page, `life-${s}`));
      check('everybody starts on forty', lives.every((l) => l === 40), JSON.stringify(lives));
    }
    // The opponent settled its own hand in the same write, so the table is waiting only on you.
    const waiting = await text(page, 'waiting-on');
    check('the computer has already settled its hand', /you/i.test(waiting), waiting);
    await shot(page, 'opening-hand');

    /*
      The card leans towards the cursor, checked where it actually happens.

      The tilt is four CSS variables written onto the card by a pointer handler, which means it is
      invisible to every test that does not move a real pointer: `apps/web`'s reducer tests never
      touch the DOM, and a card's own component test would be asserting that a handler it called by
      hand did what it says. Playwright's `hover` dispatches a genuine pointermove at the element's
      centre, so what this reads is the browser's own answer.

      The centre is deliberate: `--tilt-x` and `--tilt-y` are both zero there, so the check is that
      the variables **exist** rather than that they have a particular value — a card nobody has
      pointed at has never had them set at all.
    */
    const anyCard = cardsIn(page, 'zone-hand-0').first();
    let tilt = { x: '', y: '', sheen: '' };
    if (await anyCard.count() > 0) {
      await anyCard.hover({ position: { x: 20, y: 8 } });
      await page.waitForTimeout(80);
      tilt = await anyCard.evaluate((el) => ({
        x: el.style.getPropertyValue('--tilt-x'),
        y: el.style.getPropertyValue('--tilt-y'),
        sheen: el.style.getPropertyValue('--sheen-a'),
      }));
    }
    check('a card leans towards the cursor, and lights up where it is pointed at',
      tilt.x !== '' && tilt.y !== '' && tilt.sheen === '1', JSON.stringify(tilt));
    // And the board has its own atmosphere behind it, which the app shell's backdrop is not.
    check('the board has mana embers behind it', await has(page, 'arena-embers'));


    // ── Play it out ─────────────────────────────────────────────────────────────────────────────
    let moves = 0;
    /** Whether this game ever asked for a damage assignment order. Sampled, not required. */
    let ordered = false;
    /**
     * How many free casts the table offered, which `LIST=cascade` turns into a requirement.
     *
     * Counted rather than flagged because the interesting failure is "once": a cascade that fired
     * and left the table unable to answer it again would show up here as a one and nowhere else.
     */
    let freeCasts = 0;
    /**
     * How many times each alternative cost was actually paid, read off the row the driver chose.
     *
     * The row's own words rather than anything on the board, because the row is what is being
     * tested: the engine already knows what an evoked Mulldrifter does, and what nothing else
     * checks is that the table offered the cheap cast, said what it costs, and sent the flag with
     * it. `LIST=costs` turns all three into requirements.
     */
    const altCasts = LIST === 'earned'
      ? { spectacle: 0, overload: 0 }
      : LIST === 'graveyard'
      ? { embalm: 0, eternalize: 0 }
      : { evoke: 0, dash: 0, bestow: 0 };
    /*
      What the token's own face said, under `LIST=graveyard`.

      Read off the battlefield straight after the row is pressed rather than asserted at the end,
      because a token is the one permanent that can stop existing: a Zombie Cat that dies two moves
      later leaves nothing to look at, and a check that reads the board at the end of the game would
      pass or fail on whether the token survived.

      A `Set` of card faces, deduplicated by the text itself, because the board is read on every
      move and one token sits there for many of them.
    */
    const tokenFaces = new Set();
    /**
     * The miracle offers this run took, by the sentence the bar showed, under `LIST=miracle`.
     *
     * The prompt rather than a count, because the prompt is the claim: the engine writes "X is the
     * first card you drew this turn: you may cast it for {R} (miracle)", and a run that collected
     * that sentence off the bar has proved the window, the condition and the cost in one string.
     * A `Set`, so eight copies of the same card do not read as eight different findings.
     */
    const miracleOffers = new Set();
    /**
     * And the rebound offers, by the same sentence and for the same reason, under `LIST=rebound`.
     *
     * Separate from the miracle set because the two prompts say different things and each list
     * requires its own: one is "the first card you drew this turn", the other is "cast it from
     * exile", and a run that collected either would pass the wrong check.
     */
    const reboundOffers = new Set();
    /** The replicate rows this run pressed, by the row's own words, under `LIST=replicate`. */
    const replicateRows = new Set();
    /** The extort questions this run answered by **paying**, under `LIST=extort`. */
    const extortPaid = new Set();
    /** The suspend rows pressed and the casts they bought back, under `LIST=suspend`. */
    const suspendRows = new Set();
    const suspendCasts = new Set();
    /**
     * The dredges taken, and the casts of a card that had been dredged back, under `LIST=dredge`.
     *
     * Two halves on purpose. The first is the prompt; the second is the point — a dredge that
     * returns a card nobody then casts has proved the question and not the keyword. Counted only
     * *after* a dredge has been taken, so the Darkblast cast that put the card in the graveyard in
     * the first place is not mistaken for the one it bought back.
     */
    const dredgesTaken = new Set();
    let castsAfterADredge = 0;
    /**
     * The buyback rows pressed, and the casts that happened *after* one, under `LIST=buyback`.
     *
     * The second half is the keyword: a row that charges three more mana and then puts the card in
     * the graveyard anyway is a worse card, so what the run has to see is the same card cast again.
     * Counted by name rather than by instance because the table does not say which Capsize is
     * which — eight of them are in the deck — so the claim is the weaker and honest one: a buyback
     * row was pressed, and a Capsize was cast again afterwards.
     */
    const buybackRows = new Set();
    let castsAfterABuyback = 0;
    /**
     * The proliferate answers that included a **player**, under `LIST=proliferate`.
     *
     * One set rather than two, because the question and the answer cannot come apart here: the
     * driver only reports this line when it has pressed a seat strip inside a decision, and a seat
     * strip is only pressable when the engine listed that player as a candidate. So a run with one
     * of these has seen the whole joint — the question asked with a player in it, and the player
     * chosen by tapping their own strip on the board.
     */
    const playersChosen = new Set();
    /**
     * The echo questions this run answered, by the answer it gave, under `LIST=echo`.
     *
     * Keyed on the whole line so the two answers count separately: the point of eight Marshals is
     * that both are reachable, and a run that only ever paid has not seen the half where a
     * permanent the player still wanted goes to the graveyard.
     */
    const echoAnswers = new Set();
    /**
     * The distinct **prices** a cumulative upkeep asked for, under `LIST=upkeep`.
     *
     * Prices rather than answers, because the price is the whole claim: two different ones in a run
     * means the question was rebuilt as it climbed rather than re-rendered from the first asking.
     */
    const upkeepPrices = new Set();
    /**
     * Level-up activations pressed, and the **bodies the board then showed**, under `LIST=level`.
     *
     * The second half is the claim. An activation proves the row exists; the printed card is a 1/1
     * and the first band is a 3/3, so a card face reading `3/3` is the only evidence that what the
     * table draws is the creature the engine is playing with.
     */
    const levelPlays = new Set();
    const levelledBodies = new Set();
    /**
     * Every `time N` / `fade N` label read off this seat's battlefield, under `LIST=vanish`.
     *
     * Two claims in one set. That the clock is **on the card face at all** — a 5/5 that disappears
     * with no warning cannot be planned around, and the engine's tests read counters out of state
     * where no player can see them. And that it **comes down**: two readings of the same clock at
     * different numbers is a countdown, one reading is a decoration.
     */
    const clockFaces = new Set();
    /**
     * Every sentence the feeding bar printed this run, under `LIST=artifact`.
     *
     * The words rather than the fact, because one mode now carries three costs and the sentence is
     * all that tells them apart. "Tap a creature to sacrifice" over an Arcbound Ravager would be
     * naming the wrong half of the board — half the cards it is pointing at are not creatures —
     * and the engine cannot catch that: it knows the cost, and what it is asked here is what the
     * table *said* about it.
     */
    const feedWords = new Set();
    /*
      The blink prompt, in three parts, because three different things can go wrong with it.

      `blinkPrompts` is the question being asked at all — the words the bar printed, so a run cannot
      pass on some other trigger's prompt. `blinkDeclines` is the "Choose nothing" button being
      pressed, which is the half the engine's tests cannot reach. And `herderBodies` is the counter
      arriving on the card face, which is the only check here that reads the *board* rather than the
      bar: a Soulherder showing 2/2 is the trigger having resolved and the layer system having put
      the counter through to the screen.
    */
    /*
      The rows whose cost the **board** changed, in the table's own words.

      The driver returns the row it pressed, and the row's text is the description, the printed cost
      and the badge beside it — so a reduction that reached the screen is in the string and one that
      did not is not. That is the whole claim: `costChange` is asserted in the engine's own tests,
      and this is the only check in the project that the number is drawn.
    */
    const cheapRows = new Set();
    /*
      Soulbond's three readings, and they are three different claims.

      `pairTargets` is the prompt the soulbonded creature raises as it lands — which of your
      creatures to pair with. `pairWords` is the other prompt, the one any *other* creature raises:
      whether to pair at all, answered with a word. `pairedFaces` is the badge, read off the board,
      which is the only evidence the answer reached the screen rather than only the state.
    */
    const pairTargets = new Set();
    const pairWords = new Set();
    const pairedFaces = new Set();
    const blinkPrompts = new Set();
    const blinkDeclines = new Set();
    const herderBodies = new Set();
    let lastTurn = (await readNumber(page, 'turn')) ?? 1;
    let turnsSeen = 0;
    /*
      The phone measured while the game is still going, which is the board that found D267.

      Every other layout reading in this file is taken after `playOutGame` has reached a winner, and
      that is the emptiest board of the game: the sweep and the concessions have cleared it, and
      `view.finished` has taken the primary action and Concede out of the control bar. A bar that
      had been overflowing since it replaced the manual one read as fitting, for exactly that reason
      (#251).

      So this one is taken mid-game, at a fixed point rather than wherever a move cap happened to
      fall — the first turn change past six, which is late enough for four seats to have developed
      a board and early enough that every game reaches it. Recorded here and asserted after the
      loop, because a check inside the loop would report once per game rather than once per run.

      Only the sideways overflow, deliberately. The screens-tall budgets want their own mid-game
      numbers and the mid-game spread (2.88-3.21 screens) is wider than one reading can set a budget
      from, so those stay post-game until somebody measures them properly. Sideways overflow has no
      such problem: it either fits a phone or it does not.
    */
    let midPhone = null;
    let stuck = 0;
    /*
      One game, played to its end — and under `LIST=costs`, possibly not the only one.

      A function rather than a bare loop because the scenario needs to be able to say "deal again":
      which of the three cheap rows a game reaches depends on what it draws and how long it lasts,
      and three runs of this suite each pressed a different two of them. Pressing all three is a
      claim about the *table*, not about one shuffle, so the scenario keeps dealing until it has
      pressed all three or has played three games — which is what a person checking this by hand
      would do, and is the same button the rematch check below presses.
    */
    const playOutGame = async () => {
      while (moves < MAX_MOVES && !(await has(page, 'game-over'))) {
        if (!(await myMove(page))) {
          // The opponent moves inside the same write as the action that provoked it, so there
          // should never be a moment where nobody is on the clock. A few ticks of grace for the
          // socket, then it is a stall worth reporting.
          stuck += 1;
          if (stuck > 40) break;
          await page.waitForTimeout(100);
          continue;
        }
        stuck = 0;
        const did = await takeTurn(page);
        moves += 1;
        /*
          The damage assignment order (CR 509.2), recorded when the game happens to produce one.

          It needs the bots to gang up on one of this player's attackers, which they do — but only
          when they have two creatures able to block it, so about one run in three gets there. Not a
          required check for that reason: a check that fails for a board the game never built says
          nothing about the code. Reported when it is reached, which is how the scry and the library
          search are handled in the arena suite.
        */
        if (did === 'assigned combat damage') ordered = true;
        if (typeof did === 'string' && /a free cast/.test(did)) freeCasts += 1;
        if (typeof did === 'string' && /miracle/i.test(did)) miracleOffers.add(did);
        if (typeof did === 'string' && /rebounds/i.test(did)) reboundOffers.add(did);
        if (typeof did === 'string' && /replicate x[1-9]/i.test(did)) replicateRows.add(did);
        /*
          The **word that was chosen**, not the question that was asked.

          The first version of this matched `Pay {W/B}` anywhere in the line and passed on a run
          whose every answer was *Decline*: the prompt's own text carries both button labels, so the
          paying word is in the string either way. The driver puts the chosen word first for exactly
          this reason — a check that cannot tell the two answers apart is not a check.
        */
        if (typeof did === 'string' && /^chose a word: Pay \{W\/B\}/.test(did)) {
          extortPaid.add(did);
        }
        if (typeof did === 'string' && /Suspend .*time counter/i.test(did)) suspendRows.add(did);
        if (typeof did === 'string' && /last time counter is gone/i.test(did)) suspendCasts.add(did);
        if (typeof did === 'string' && /^took a dredge: /.test(did)) dredgesTaken.add(did);
        if (typeof did === 'string' && /^chose a player: /.test(did)) playersChosen.add(did);
        if (typeof did === 'string' && /^chose a word: .*Echo \{1\}\{R\}/.test(did)) {
          echoAnswers.add(did.replace(/—.*$/, '').trim());
        }
        if (typeof did === 'string'
          && /^(fed a sacrifice outlet|backed out of a sacrifice): /.test(did)) {
          feedWords.add(did.replace(/^[^:]+: /, ''));
        }
        if (typeof did === 'string' && /^chose a play: .*[−-]\{\d+\}/.test(did)) {
          cheapRows.add(did.replace(/^chose a play: /, ''));
        }
        if (typeof did === 'string' && /^aimed a trigger: .*blink/i.test(did)) {
          blinkPrompts.add(did.replace(/^aimed a trigger: /, ''));
        }
        if (typeof did === 'string' && /^aimed a trigger: .*unpaired/i.test(did)) {
          pairTargets.add(did.replace(/^aimed a trigger: /, ''));
        }
        if (typeof did === 'string' && /^chose a word: .*Pair them/i.test(did)) {
          pairWords.add(did.replace(/^chose a word: /, ''));
        }
        if (LIST === 'soulbond') {
          /*
            The badge, read on **every** move rather than after the answer.

            A pair is made as a creature enters and broken the moment either half leaves, so the
            window is whatever the run happens to be looking at — the same reason the vanishing
            clocks are sampled this way rather than once at the end, where the creature is usually
            dead.
          */
          const board = await page.locator('[data-testid="zone-battlefield-0"]').innerText()
            .catch(() => '');
          /*
            Case-insensitively, because `innerText` is what the badge **looks** like rather than
            what the code wrote. The badge span carries `uppercase`, and Chromium applies
            `text-transform` before handing the text over — so `cardBadges` writes "paired with
            Grizzly Bears" and the board reads "PAIRED WITH GRIZZLY BEARS". The first run of this
            mode caught both prompts and no badge at all, which read as a pair the screen never
            drew; it was the flag on this regex. Every other board scan here matches a card name or
            a body like "3/3", neither of which a transform touches, which is why this is the first
            place it has come up.
          */
          for (const hit of board.matchAll(/paired with ([^\n]{1,40})/gi)) {
            pairedFaces.add(hit[0].replace(/\s+/g, ' ').trim());
          }
        }
        if (typeof did === 'string' && /^declined an optional trigger: .*blink/i.test(did)) {
          blinkDeclines.add(did.replace(/^declined an optional trigger: /, ''));
        }
        if (LIST === 'blink' && typeof did === 'string' && /blink/i.test(did)) {
          /*
            Read straight after the answer rather than at the end of the game, for the reason the
            levelled bodies are: a grown Soulherder is a 2/2 until somebody kills it, and by the
            last turn it usually has been.
          */
          const board = await page.locator('[data-testid="zone-battlefield-0"]').innerText()
            .catch(() => '');
          for (const body of ['2/2', '3/3', '4/4']) {
            if (/Soulherder/.test(board) && board.includes(body)) herderBodies.add(body);
          }
        }
        if (LIST === 'level' && typeof did === 'string' && /chose a play: Level up/.test(did)) {
          levelPlays.add(did);
          /*
            The board, read straight after the activation rather than at the end of the game: a
            levelled Student is a 3/3 until somebody kills it, and by the last turn it usually has
            been. The badge is the body `cardBadges` computes, which is the engine's own
            characteristics — so a face that says 3/3 is the layer system reaching the screen.
          */
          const board = await page.locator('[data-testid="zone-battlefield-0"]').innerText()
            .catch(() => '');
          for (const body of ['3/3', '4/4']) {
            if (/Student of Warfare/.test(board) && board.includes(body)) levelledBodies.add(body);
          }
        }
        if (typeof did === 'string' && /Cumulative upkeep: pay /.test(did)) {
          const price = /Cumulative upkeep: pay (\{[^ ]*?\}) for/.exec(did);
          if (price !== null) upkeepPrices.add(price[1]);
        }
        if (typeof did === 'string' && /chose a play: Cast .* with buyback/i.test(did)) {
          buybackRows.add(did);
        } else if (buybackRows.size > 0 && typeof did === 'string'
          && /chose a play: Cast Capsize/.test(did)) {
          castsAfterABuyback += 1;
        }
        if (dredgesTaken.size > 0 && typeof did === 'string'
          && /chose a play: Cast Darkblast/.test(did)) castsAfterADredge += 1;
        if (typeof did === 'string') {
          for (const word of Object.keys(altCasts)) {
            /*
              Two shapes of row, matched differently because they *are* different rows. An
              alternative cost is a second way to cast a card and the table words it "Cast X for
              its evoke cost"; embalm and eternalize are abilities, so the row is the ability's own
              printed text and begins with the keyword. Matching the keyword rather than the
              wrapper is also what keeps this honest: the word only appears because the engine put
              that ability's description on the button.
            */
            const hit = LIST === 'graveyard'
              ? new RegExp(`\\b${word}\\b`, 'i').test(did)
              : did.includes(`its ${word} cost`);
            if (hit) altCasts[word] += 1;
          }
        }
        /*
          And what arrived, which is the half the engine's tests cannot see: the token's *face*.

          Sampled on **every** move rather than on the move that pressed the row, which is the
          mistake the first run of this scenario made. Embalm is an activated ability, so pressing
          it puts the ability on the stack and the token does not exist until it resolves a move or
          two later — the first version read the board straight after the tap, found only the
          Zombies from earlier presses, and reported "no 4/4 token" on a game that had made one.
          A set, because the same token is on the board for many moves after it arrives.
        */
        /*
          The countdown, sampled on every move for the reason the token faces are: the counter comes
          off in the upkeep, which is a step the table passes straight through, so the only honest
          place to read it is wherever the run happens to be looking.
        */
        if (LIST === 'vanish') {
          const board = await page.locator('[data-testid="zone-battlefield-0"]').innerText()
            .catch(() => '');
          for (const hit of board.matchAll(/\b(time|fade) (\d+)\b/g)) clockFaces.add(hit[0]);
        }
        if (LIST === 'graveyard') {
          const mine = page.locator('[data-testid="zone-battlefield-0"] [data-testid^="card-"]');
          for (let i = 0; i < await mine.count(); i += 1) {
            const face = (await textOf(mine.nth(i))).replace(/\s+/g, ' ');
            if (/Zombie/.test(face)) tokenFaces.add(face.slice(0, 120));
          }
        }
        if (process.env.VERBOSE === '1') console.log(`      move ${moves}: ${did}`);
        else if (moves % 15 === 0) console.log(`      move ${moves}: ${did}`);
        await page.waitForTimeout(60);
        const turn = await readNumber(page, 'turn');
        if (turn !== null && turn > lastTurn) {
          turnsSeen += turn - lastTurn;
          lastTurn = turn;
        }
        if (turnsSeen === 3) await shot(page, 'mid-game');
        if (turnsSeen >= 6 && midPhone === null) {
          const was = page.viewportSize() ?? { width: 1280, height: 720 };
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForTimeout(250);
          midPhone = await page.evaluate(() => {
            const docW = document.documentElement.clientWidth;
            const scrolls = (el) => {
              const o = getComputedStyle(el).overflowX;
              return o === 'auto' || o === 'scroll' || o === 'hidden';
            };
            const free = [];
            for (const el of document.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || Math.round(r.right - docW) <= 1) continue;
              let contained = false;
              for (let q = el.parentElement; q && q !== document.documentElement; q = q.parentElement) {
                if (scrolls(q)) { contained = true; break; }
              }
              if (!contained) {
                free.push(`+${Math.round(r.right - docW)}px ${el.tagName.toLowerCase()}`
                  + `${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`);
              }
            }
            return {
              overflow: document.documentElement.scrollWidth - docW,
              free: free.slice(0, 6),
            };
          });
          await shot(page, 'mid-game-phone');
          await page.setViewportSize(was);
          await page.waitForTimeout(250);
        }
      }
    };

    /** Presses "play again" and waits for a fresh seven-card hand. Used only by `LIST=costs`. */
    const dealAgain = async () => {
      let pressed = false;
      for (let i = 0; i < 3 && !pressed; i += 1) {
        pressed = await press(page, 'rematch');
        if (!pressed) await page.waitForTimeout(250);
      }
      if (!pressed) return false;
      return expectEventuallyTrue(page, async () =>
        !(await has(page, 'game-over')) && (await cardsIn(page, 'zone-hand-0').count()) === 7);
    };

    await playOutGame();
    let games = 1;
    /*
      Deal again until both rows have been pressed, or the budget is out.

      `LIST=earned` gets **five** games where `LIST=costs` gets three, and the reason is in the
      numbers rather than in the keywords: a game under this list is about ten moves long — three
      of them fit in twenty-seven — so a re-deal costs almost nothing, and which of the two rows a
      game offers is a fact about the shuffle. Three runs of three games pressed spectacle five
      times and overload none; three runs after the Sol Rings went in pressed overload three times
      in one run and spectacle none. Both rows exist on every table; one shuffle does not see both.
    */
    const dealBudget = LIST === 'earned' || LIST === 'graveyard' || LIST === 'miracle'
      || LIST === 'rebound' || LIST === 'replicate' || LIST === 'extort' || LIST === 'suspend'
      || LIST === 'dredge' || LIST === 'buyback' || LIST === 'proliferate' || LIST === 'echo'
      || LIST === 'upkeep' || LIST === 'level' || LIST === 'vanish' || LIST === 'artifact'
      || LIST === 'blink' || LIST === 'affinity' || LIST === 'soulbond'
      ? 5 : 3;
    /*
      What "not yet" means for this list.

      Every list but `miracle` is waiting for a set of rows to each have been pressed once; miracle
      is waiting for a single sentence, because the keyword fires on the shuffle rather than on
      anything the player can arrange. Same budget, different question.
    */
    const wantsAnotherGame = () => (LIST === 'miracle'
      ? miracleOffers.size === 0
      : LIST === 'rebound'
      ? reboundOffers.size === 0
      : LIST === 'replicate'
      ? replicateRows.size === 0
      : LIST === 'extort'
      ? extortPaid.size === 0
      : LIST === 'suspend'
      ? suspendRows.size === 0 || suspendCasts.size === 0
      : LIST === 'dredge'
      ? dredgesTaken.size === 0 || castsAfterADredge === 0
      : LIST === 'buyback'
      ? buybackRows.size === 0 || castsAfterABuyback === 0
      : LIST === 'proliferate'
      ? playersChosen.size === 0
      /*
        Both answers, not just one. A run that paid every echo has proved the question and not the
        keyword — the half that matters is the permanent going to the graveyard because its
        controller said no.
      */
      : LIST === 'echo'
      ? echoAnswers.size < 2
      // Two prices, because one price is a question and two prices are a climb.
      : LIST === 'upkeep'
      ? upkeepPrices.size < 2
      // A pressed row and a changed face: the second is what the engine's tests cannot see.
      : LIST === 'level'
      ? levelPlays.size === 0 || levelledBodies.size === 0
      // Two readings of one clock, which is a countdown rather than a label.
      : LIST === 'vanish'
      ? !hasACountdown(clockFaces)
      /*
        The artifact sentence, and only that one. A run that fed a creature outlet has proved the
        mode and not the wording — and the wording is the claim, because it is the half the engine
        cannot make. Several games, because the board has to have a Ravager and a spare Equipment at
        the same moment, which is a fact about the shuffle.
      */
      : LIST === 'artifact'
      ? ![...feedWords].some((w) => /tap an artifact to sacrifice/i.test(w))
      /*
        The prompt and the counter, which are two different claims: a run that answered the question
        has proved the bar, and a run whose Soulherder grew has proved the answer reached the board.
        The **decline** is not on this list on purpose — it needs a board whose only other creature
        is a token, which is a fact about the shuffle rather than something the scenario can arrange,
        so it is reported when it happens the way the damage-assignment order is.
      */
      : LIST === 'blink'
      ? blinkPrompts.size === 0 || herderBodies.size === 0
      /*
        One pressed row with a reduction on it. Not a count and not both cards: which of the two
        affinity creatures a game draws first is the shuffle's business, and the claim is about the
        badge rather than about either card.
      */
      : LIST === 'affinity'
      ? cheapRows.size === 0
      /*
        All three: the two prompts and the badge. A run that answered one of the two questions has
        proved half a mechanic, and a run that answered both without the badge appearing has proved
        the bar rather than the board. Which of the two prompts a game raises first is the shuffle's
        business, which is what the extra deals are for.
      */
      : LIST === 'soulbond'
      ? pairTargets.size === 0 || pairWords.size === 0 || pairedFaces.size === 0
      : !Object.values(altCasts).every((n) => n > 0));
    while ((LIST === 'costs' || LIST === 'earned' || LIST === 'graveyard' || LIST === 'miracle'
      || LIST === 'rebound' || LIST === 'replicate' || LIST === 'extort' || LIST === 'suspend'
      || LIST === 'dredge' || LIST === 'buyback' || LIST === 'proliferate' || LIST === 'echo'
      || LIST === 'upkeep' || LIST === 'level' || LIST === 'vanish' || LIST === 'artifact'
      || LIST === 'blink' || LIST === 'affinity' || LIST === 'soulbond')
      && games < dealBudget && wantsAnotherGame()) {
      if (!(await has(page, 'game-over'))) break;
      console.log(`      dealing again: ${LIST === 'miracle' ? `${miracleOffers.size} miracle offers`
        : LIST === 'rebound' ? `${reboundOffers.size} rebound offers`
        : LIST === 'replicate' ? `${replicateRows.size} replicate rows`
        : LIST === 'extort' ? `${extortPaid.size} extort payments`
        : LIST === 'suspend' ? `${suspendRows.size} suspends, ${suspendCasts.size} casts`
        : LIST === 'dredge' ? `${dredgesTaken.size} dredges, ${castsAfterADredge} casts after one`
        : LIST === 'buyback' ? `${buybackRows.size} buyback rows, ${castsAfterABuyback} casts after one`
        : LIST === 'proliferate' ? `${playersChosen.size} answers with a player in them`
        : LIST === 'echo' ? `${echoAnswers.size} of the two echo answers`
        : LIST === 'upkeep' ? `${upkeepPrices.size} distinct upkeep prices`
        : LIST === 'level' ? `${levelPlays.size} level-ups, ${levelledBodies.size} levelled bodies`
        : LIST === 'vanish' ? `clocks seen: ${[...clockFaces].join(', ') || 'none'}`
        : LIST === 'artifact' ? `feeding sentences: ${[...feedWords].join(' | ') || 'none'}`
        : LIST === 'blink' ? `${blinkPrompts.size} blink prompts, bodies: ${[...herderBodies].join(', ') || 'none'}`
        : LIST === 'affinity' ? `${cheapRows.size} rows with a reduction drawn on them`
        : LIST === 'soulbond' ? `${pairTargets.size} pairing targets, ${pairWords.size} answers, ${pairedFaces.size} badges`
        : JSON.stringify(altCasts)} after ${games} game(s)`);
      if (!(await dealAgain())) break;
      games += 1;
      moves = 0;
      await playOutGame();
    }

    console.log(`      played ${moves} moves over ${turnsSeen} turn changes`
      + (games > 1 ? ` across ${games} games` : ''));
    if (ordered) {
      check('the attacker is asked which blocker the damage goes to first, and the engine takes it', true);
    } else {
      console.log('      (nothing was blocked by two creatures in this game — combat.test.ts '
        + 'covers the damage order on a fixed board)');
    }
    /*
      A spell cast for nothing, which is the one play on the table with no cost at all.

      Required under `LIST=cascade` and reported otherwise, which is the same rule this suite uses
      for the damage order: a check that can fail for a board the game never built says nothing
      about the code. The scenario builds the board on purpose — four Bloodbraid Elves and nothing
      else over three mana — so under it the absence of a single cascade is a real failure.
    */
    if (LIST === 'cascade') {
      check('a cascade offers its hit as a free cast, and the table answers it',
        freeCasts > 0, `free casts offered: ${freeCasts}`);
    } else if (freeCasts > 0) {
      console.log(`      (${freeCasts} free casts were offered and answered in this game)`);
    }
    /*
      The three alternative costs, each paid at least once through the table.

      Required under `LIST=costs` and reported otherwise, the same rule the cascade check follows.
      What each one proves is the half the engine's own tests cannot: the row was offered on a card
      in hand, its words said what the cheap cast costs, the flag went with the cast (a cast sent
      without it is refused or is the expensive one), and for bestow the table walked through
      choosing a creature to enchant before anything was sent.
    */
    if (LIST === 'costs') {
      const where = JSON.stringify(altCasts);
      check('a Mulldrifter is cast for its evoke cost through the table', altCasts.evoke > 0, where);
      check('a Mardu Scout is cast for its dash cost through the table', altCasts.dash > 0, where);
      check('a Boon Satyr is cast as an Aura for its bestow cost, enchanting a creature it chose',
        altCasts.bestow > 0, where);
    } else if (LIST === 'earned') {
      /*
        And the two rows that are not simply cheaper.

        What each proves is about the *table* rather than the engine: that a row which was not there
        a moment ago was offered, said why it was on offer, and sent its flag — and that a row with
        no targets was sent on one tap instead of waiting for a pick nobody can make.
      */
      const where = JSON.stringify(altCasts);
      check('a Skewer the Critics is cast for the spectacle cost a turn of combat earned',
        altCasts.spectacle > 0, where);
      check('a Mizzium Mortars is overloaded, on a row that asks for no targets at all',
        altCasts.overload > 0, where);
    } else if (LIST === 'miracle') {
      /*
        The one offer in the family that is made on a card in **hand**.

        What this proves that the engine's own tests cannot: the table stopped in the *draw step*,
        before anything else could happen on the turn, said which card it was and that it was the
        first one drawn, named a cost that is not the card's own, and took a cast of a six-mana
        instant for one red mana. Cascade and madness make their offer on a card in exile, and the
        bar's sentence is the only place the difference is visible to a player.
      */
      const sentences = [...miracleOffers];
      check('a miracle is offered on the turn\'s first draw, and the table takes it',
        sentences.length > 0, `offers seen: ${sentences.length}`);
      check('the offer says it was the first card drawn, and names the miracle cost',
        sentences.some((did) => /first card you drew this turn/.test(did) && /\{R\}/.test(did)),
        sentences[0] ?? 'nothing was offered');
      for (const did of sentences.slice(0, 3)) console.log(`      ${did}`);
    } else if (LIST === 'rebound') {
      /*
        The offer that arrives a **turn** after the card was cast, on a card in exile.

        What this proves that the engine's own tests cannot: the table kept the promise across a
        turn boundary — the spell resolved, the card went somewhere no other spell goes, the
        opponent took a whole turn, and the bar came back in the player's own upkeep with a free
        cast of a card they no longer had. Nothing else in the suite spans two turns like that.
      */
      const sentences = [...reboundOffers];
      check('a spell cast last turn is offered again in the upkeep, from exile',
        sentences.length > 0, `offers seen: ${sentences.length}`);
      check('the offer says where the card is and that the cast is free',
        sentences.some((did) => /from exile/.test(did) && /without paying its mana cost/.test(did)),
        sentences[0] ?? 'nothing was offered');
      for (const did of sentences.slice(0, 3)) console.log(`      ${did}`);
    } else if (LIST === 'replicate') {
      /*
        One card, three rows, and the engine charging for the one that was tapped.

        What this proves that the engine's own tests cannot: the table *drew* the counts as separate
        plays with their own prices, and the cast it sent carried the count. The second half is the
        one that was broken in the bot and would have been broken here too — a count dropped on the
        way out looks exactly like a cheap cast that worked.
      */
      const rows = [...replicateRows];
      check('a replicate row is offered on one card at several prices, and pressed',
        rows.length > 0, `rows pressed: ${rows.length}`);
      for (const did of rows.slice(0, 3)) console.log(`      ${did}`);
    } else if (LIST === 'extort') {
      /*
        The first optional mana cost a *player* is asked for in the middle of a resolution.

        What this proves that the engine's own tests cannot: the table drew the two words, the
        paying one was pressed, and the engine charged for it — a question with a price on its
        answer, asked while the ability was resolving and answered through the bar like any other
        word question.
      */
      const answers = [...extortPaid];
      check('an extort question is asked mid-resolution, and paying it is one tap',
        answers.length > 0, `payments: ${answers.length}`);
      for (const did of answers.slice(0, 3)) console.log(`      ${did}`);
    } else if (LIST === 'suspend') {
      /*
        A card put away on one turn and cast on another, through the table.

        Two halves, and the second is the one that needed something new in the engine: the row on a
        card in hand that is neither a cast nor a morph nor a foretell, and the cast that turns up in
        a later upkeep with **no Decline** — a suspended card's last counter is not a permission
        (CR 702.62c), so the bar offers the cast and nothing else.
      */
      check('a card is suspended from hand, for its own cost', suspendRows.size > 0,
        `suspends: ${suspendRows.size}`);
      check('and cast in a later upkeep, off the last time counter', suspendCasts.size > 0,
        `casts: ${suspendCasts.size}`);
      for (const did of [...suspendRows].slice(0, 2)) console.log(`      ${did}`);
      for (const did of [...suspendCasts].slice(0, 2)) console.log(`      ${did}`);
    } else if (LIST === 'dredge') {
      /*
        The one prompt at this table that is about a **draw** (CR 702.52a).

        Two halves again, and they are the question and the point. The question is the thing the
        engine had to grow a sixth stopped-table state for — a draw deferred rather than taken, two
        buttons, and a price in cards off your own library. The point is the card arriving back in
        hand and being cast again, which is the only way a run can tell a working keyword from a
        prompt that merely appears.
      */
      check('a dredge is offered in the draw step, and milling for it is one tap',
        dredgesTaken.size > 0, `dredges: ${dredgesTaken.size}`);
      check('and the card it bought back is cast again', castsAfterADredge > 0,
        `casts after a dredge: ${castsAfterADredge}`);
      /*
        And the way out of being asked every turn, which is the other half of a keyword that fires
        in every draw step. The control lives beside the question so it is reachable at the moment
        a player is tired of it; what it does when pressed is three engine tests, because a run that
        changed a preference mid-game would make every later move a different test.
      */
      check('a standing answer is offered beside the question',
        [...dredgesTaken].some((did) => /\[standing: /.test(did)),
        `${[...dredgesTaken].filter((did) => /\[standing: /.test(did)).length} offered it`);
      for (const did of [...dredgesTaken].slice(0, 2)) console.log(`      ${did}`);
    } else if (LIST === 'buyback') {
      /*
        A price list where both rows are the same spell (CR 702.26a).

        The kicker's shape at a different price, and the only one in the pool where what the extra
        mana buys is **the card**. So the two checks are the row and the consequence: a Cast row at
        the printed cost plus the buyback was pressed, and the same card was cast again afterwards —
        which it could only be if it came back to the hand instead of the graveyard.
      */
      check('a buyback row is offered on a card in hand, at the dearer price',
        buybackRows.size > 0, `rows: ${buybackRows.size}`);
      check('and the card it kept is cast again', castsAfterABuyback > 0,
        `casts after a buyback: ${castsAfterABuyback}`);
      for (const did of [...buybackRows].slice(0, 2)) console.log(`      ${did}`);
    } else if (LIST === 'proliferate') {
      /*
        The one answer at this table that is not a card (CR 701.27a).

        Everything else a player is ever asked to choose is a card somewhere — in hand, on the
        battlefield, in a graveyard, in the library during a search — and the table answers all of
        them the same way, by lighting cards. Proliferate breaks that: a poisoned player is a legal
        choice with no card to light, so the seat strip has to become part of the answer, and the
        only way to know it did is to press it and watch the counter land.

        One check, not two. The question and the answer cannot be separated here — the driver
        reports this line only when it pressed a seat strip inside a decision, and it can only do
        that when the engine offered that player — so a second check would be the same claim twice.
      */
      check('a player is offered as part of an answer, and chosen by tapping their own strip',
        playersChosen.size > 0, `answers with a player: ${playersChosen.size}`);
      for (const did of [...playersChosen].slice(0, 2)) console.log(`      ${did}`);
    } else if (LIST === 'echo') {
      /*
        The only question in this pool the **game** asks, in the step a table passes through.

        Every other prompt these runs press follows something the player did — a cast, an
        activation, an attack. Echo arrives in the upkeep, before anybody has done anything, which
        is the one place auto-pass could swallow it: a table that passed priority past its own
        question would lose the creature silently, and no engine test can see that because no engine
        test passes priority the way a table does.

        Both answers are required, because they are different claims: paying taps two lands and
        keeps a 1/1, declining puts it in the graveyard and makes a Goblin on the way out.
      */
      check('an echo is asked in the upkeep, and answered with a tap',
        echoAnswers.size > 0, `echo answers: ${echoAnswers.size}`);
      check('and both answers are reachable: paid, and refused',
        echoAnswers.size >= 2, [...echoAnswers].join(' / '));
      for (const did of [...echoAnswers].slice(0, 2)) console.log(`      ${did}`);
    } else if (LIST === 'upkeep') {
      /*
        The one thing a climbing price can prove and a fixed one cannot.

        The engine's tests pin the arithmetic — {1}, then {2}, then {3} — on a board built by hand.
        What they cannot see is the **button**: the question is rebuilt on each asking, so a table
        that re-rendered the first one would offer `Pay {1}` for a cost of `{2}`, the engine would
        refuse the payment, and the permanent would go with the player unable to see why.

        Two distinct prices in one run is that claim, and it is the whole check.
      */
      check('a cumulative upkeep is asked through the table', upkeepPrices.size > 0,
        `prices: ${[...upkeepPrices].join(', ')}`);
      check('and the price on the button climbs between askings',
        upkeepPrices.size >= 2, [...upkeepPrices].join(', '));
    } else if (LIST === 'level') {
      /*
        What a creature **is**, drawn on the card rather than computed in a test.

        The engine's tests read the bands off `characteristicsOf`, which is the right place to pin
        the arithmetic and the wrong place to find out what a player sees. A Student of Warfare is a
        printed 1/1 and a level-two Student is a 3/3; a table that drew the printed body would have
        the player blocking a 3/3 with a 2/2 and losing a creature to a number that was on screen
        the whole time.
      */
      check('a level-up row is pressed on a creature on the battlefield',
        levelPlays.size > 0, `level-ups: ${levelPlays.size}`);
      check('and the card face shows the body the band gives it',
        levelledBodies.size > 0, `bodies seen: ${[...levelledBodies].join(', ')}`);
      for (const did of [...levelPlays].slice(0, 2)) console.log(`      ${did}`);
    } else if (LIST === 'artifact') {
      /*
        The sentence the bar prints over an artifact cost, which is the half of D222 no engine test
        can make.

        `legalActions` knows the cost is an artifact one, and `scripts.test.ts` pins that it is and
        pins what the bot feeds it. Neither of them can say what the player reads, and over this
        cost the default wording is actively wrong: "tap a creature to sacrifice" above a board
        where the lit cards are a Bonesplitter and a Darksteel Plate names the wrong half of the
        board, and a player who takes it at its word looks for a creature and finds the bar
        unresponsive.

        One check and not two, because the question here is a single sentence rather than a
        progression — unlike the clocks below, where one reading is a label and two are a countdown.
      */
      check('the bar asks for an artifact when the cost is an artifact',
        [...feedWords].some((w) => /tap an artifact to sacrifice/i.test(w)),
        `sentences seen: ${[...feedWords].join(' | ') || 'none'}`);
      for (const w of [...feedWords].slice(0, 3)) console.log(`      ${w}`);
    } else if (LIST === 'blink') {
      /*
        The first prompt in this suite that asks about **your own** board, and the first whose right
        answer is sometimes nothing.

        `scripts.test.ts` builds the answer by hand — it knows which creature the trigger should
        take and asserts the counter arrives. What it cannot see is the question: the whole prompt
        had no control on it until D225, so a Soulherder alone on the battlefield left the ability on
        the stack with nothing on screen able to answer it, and the table stopped for good. That bug
        shipped in a release and was found by a different card's scenario.

        Two required checks and one reported. The **question** has to be asked in this run's own
        words, so a pass cannot come from some other trigger's prompt. The **counter** has to reach
        the card face, which is the answer having resolved and the layer system having drawn it. The
        **decline** needs a board whose only other creature is a token, which is a fact about the
        shuffle rather than something a deck list can arrange, so it is reported when it happens the
        way the damage-assignment order is.
      */
      check('the table asks which of your own creatures to blink, in the ability’s own words',
        blinkPrompts.size > 0, `prompts: ${[...blinkPrompts].join(' | ') || 'none'}`);
      check('and the counter the blink pays for reaches the card face',
        herderBodies.size > 0, `bodies seen: ${[...herderBodies].join(', ') || 'none'}`);
      if (blinkDeclines.size > 0) {
        check('and "Choose nothing" answers it when the only other creature is a token', true,
          [...blinkDeclines][0]);
      } else {
        console.log('      no decline this run: every end step had something worth blinking');
      }
      for (const w of [...blinkPrompts].slice(0, 2)) console.log(`      ${w}`);
    } else if (LIST === 'affinity') {
      /*
        The nineteenth scenario, and the first to look at a number the table has been drawing since
        D132: what the **board** did to a cost, beside the cost printed on the card.

        A row that quietly rewrote {4} to {1} would be telling the player the card says something it
        does not, and a row that showed {4} and then charged {1} would be a table nobody could
        trust. Both halves are checked here in one press: the badge is in the row's own text, and
        the row was taken — so the spell was cast at the number the table showed.
      */
      check('a row says what the board did to its cost, and the cast is taken at that price',
        cheapRows.size > 0, `rows seen: ${[...cheapRows].slice(0, 3).join(' | ') || 'none'}`);
      for (const row of [...cheapRows].slice(0, 3)) console.log(`      ${row}`);
    } else if (LIST === 'soulbond') {
      /*
        The two prompts and the badge, which are three claims nothing else in the project can make.

        The engine's tests answer both pairing questions by hand — they build the choice and the
        word and assert `pairedWith` on both halves — so a table that raised neither prompt, or
        raised them with no way to answer, would pass all seven of them. And the badge is the only
        evidence the pair reached the **screen**: a Grizzly Bears reading 3/3 with nothing on the
        card to say why is a board a player cannot read, which is the whole reason `cardBadges`
        names the partner.

        The two prompts are different questions on purpose (D247): the soulbonded creature arriving
        asks *which* of your creatures, and any other creature arriving asks *whether*. One trigger
        would have asked the harder question in both cases, and this is the run that proves both
        shapes exist on a real table.
      */
      check('a soulbond creature arriving asks which of your creatures to pair it with',
        pairTargets.size > 0, `prompts: ${[...pairTargets].slice(0, 2).join(' | ') || 'none'}`);
      check('and a creature arriving beside one already out asks whether to pair them',
        pairWords.size > 0, `answers: ${[...pairWords].slice(0, 2).join(' | ') || 'none'}`);
      check('and the pair is named on the card, so a 3/3 Grizzly Bears is legible',
        pairedFaces.size > 0, `badges: ${[...pairedFaces].slice(0, 3).join(' | ') || 'none'}`);
      for (const face of [...pairedFaces].slice(0, 3)) console.log(`      ${face}`);
    } else if (LIST === 'vanish') {
      /*
        A clock the player can read, and a clock that is actually running.

        The first check is the one a missing readout would fail: the counters live on the instance
        and the engine's own tests read them straight out of state, where nobody playing the game
        can see them. A 5/5 with shroud that vanishes without warning is not the card either
        keyword prints.

        The second is what no engine test can claim, because it asks a *game* rather than a board:
        the counter comes off in the upkeep, a step the table passes straight through, so two
        different numbers on the same clock is the only evidence the countdown survived the
        auto-passing the table does on the player's behalf.
      */
      check('a vanishing or fading creature shows its clock on the card face',
        clockFaces.size > 0, `clocks seen: ${[...clockFaces].join(', ') || 'none'}`);
      check('and the number comes down as the turns pass',
        hasACountdown(clockFaces), [...clockFaces].sort().join(', '));
      console.log(`      clocks read off the board: ${[...clockFaces].sort().join(', ')}`);
    } else if (LIST === 'graveyard') {
      /*
        The two rows pressed on a card in the graveyard, and the face of what arrived.

        What this proves that nothing else can: the table badged a card in the **graveyard** as
        playable for an *ability* rather than a cast, put the ability's printed text on the button,
        sent it with no targets to pick, and then drew the token — which is a copy of the card with
        the keyword's exceptions on it, so the player is looking at a Zombie and not at the card
        they just spent.
      */
      const where = JSON.stringify(altCasts);
      check('a Sacred Cat or an Angel of Sanctions is embalmed off a card in the graveyard',
        altCasts.embalm > 0, where);
      check('and an Adorned Pouncer or a Sunscourge Champion is eternalized from there too',
        altCasts.eternalize > 0, where);
      const faces = [...tokenFaces];
      check('the token that arrives reads as a Zombie, which the card it copied is not',
        faces.length > 0, faces[0] ?? 'no Zombie reached the battlefield');
      /*
        The eternalized 4/4, reported rather than required — and the reason is a measurement rather
        than caution.

        Three runs pressed the eternalize row every time and **none of them ever had a 4/4 Zombie on
        the board when this sampler looked**, across 32 token faces. That is not the keyword failing:
        the token really is made, and `scripts.test.ts` proves the altered definition survives
        `viewFor` and `packView` with its 4/4 intact, which is the whole of what a client is handed.
        What happens instead is that the opponent's entire turn runs inside the same write as the
        pass that resolved the ability — a 4/4 is the biggest thing on the board, Tidal Mind holds
        two Doom Blades and a Man-o'-War, and a token that is bounced ceases to exist rather than
        going to a hand. So the board between two of this driver's moves is simply not a place a
        4/4 token reliably sits.

        Which leaves the division of labour honest: the browser proves the button on a card in the
        graveyard and the Zombie that arrives, and the engine's own view test proves the size.
      */
      const big = faces.find((face) => /\b4\s*\/\s*4\b/.test(face));
      if (big !== undefined) check('and an eternalized one is a printed 4/4', true, big);
      else console.log(`      (no 4/4 Zombie on the board between moves: ${faces.length} token faces seen `
        + '— see the view round-trip test in scripts.test.ts)');
    } else if (Object.values(altCasts).some((n) => n > 0)) {
      console.log(`      (alternative costs paid: ${JSON.stringify(altCasts)})`);
    }
    check('the opponent plays its own turns without being asked to', turnsSeen >= 4, `turns ${turnsSeen}`);
    check('the game reaches a winner', await has(page, 'game-over'),
      `stopped at ${await text(page, 'step-label')} on turn ${lastTurn} after ${moves} moves`);
    if (await has(page, 'game-over')) {
      const over = await text(page, 'game-over');
      check('and says who won', /wins/.test(over), over.slice(0, 60));
      await shot(page, 'game-over');
    }

    // The opponent is a real player as far as the rules are concerned: it drew, it played, it died
    // or it killed. A board that never changed would mean a seat that never moved.
    const theirBoard = await page.locator('[data-testid="zone-battlefield-1"] [data-testid^="card-"]').count();
    const theirGraveyard = await page.locator('[data-testid="zone-graveyard-1"] [data-testid^="card-"]').count();
    check('the computer played a real game', theirBoard + theirGraveyard > 0,
      `board ${theirBoard}, graveyard ${theirGraveyard}`);
    if (SOLO_POD) {
      // Every seat, not just the one next to you: a pod where two of the three bots sat still
      // would pass every check above and be no kind of game.
      const played = [];
      for (const s of [1, 2, 3]) {
        const board = await page.locator(`[data-testid="zone-battlefield-${s}"] [data-testid^="card-"]`).count();
        const yard = await page.locator(`[data-testid="zone-graveyard-${s}"] [data-testid^="card-"]`).count();
        played.push(board + yard);
      }
      check('all three of them played', played.every((n) => n > 0), JSON.stringify(played));
    }

    // And its hand was never readable, for exactly the same reason a person's is not.
    const theirHand = await cardsIn(page, 'zone-hand-1').evaluateAll((els) =>
      els.map((e) => ({ hidden: e.getAttribute('data-hidden'), name: e.getAttribute('data-card-name') })));
    check('and its hand is as unreadable as a person’s', theirHand.every((c) => c.hidden === 'true' && !c.name),
      JSON.stringify(theirHand).slice(0, 120));

    /*
      And "again" is one tap.

      The thing being checked is not the button but what is behind it: the same decks dealt again,
      the engine still running, and a fresh opening hand to decide — which is five actions and a
      deck picker if the table only offers a reset. Last of the game checks, because it clears the
      board every other one of them is reading.
    */
    if (await has(page, 'game-over')) {
      /*
        Nothing a player can tap leaves something open over the end of the game.

        This suite spent weeks failing one run in a dozen on the rematch press below, with nothing
        to go on but "pressed: false". What it was: a play sheet left open when the game ended,
        covering the whole table — `<div data-testid="play-sheet"> intercepts pointer events`,
        which only showed up once the press started keeping Playwright's whole call log instead of
        its first line.

        Driven rather than waited for, because waiting for it is what made it one in twelve: tap a
        card now that the game is over, and no sheet may open. A sheet full of plays nobody can
        make, over "Nick wins" and the button for another game, is a dead end whether it was
        opened a moment before the last damage or a moment after.
      */
      /*
        One of *this* player's own cards, and loudly if there is none.

        Two earlier versions of this tap chose badly. A card in hand: the loser's hand is often
        empty by then, so 16/16 passed with the check never running. The first card in the
        document: sometimes an opponent's face-down hand, which is not wired to open anything, so
        the check passed by tapping something that could never have failed. Your own graveyard is
        full by the time a game ends, and every card in it opens a sheet.
      */
      const mine = page.locator(
        '[data-testid="zone-graveyard-0"] [data-testid^="card-"], '
        + '[data-testid="zone-creatures-0"] [data-testid^="card-"], '
        + '[data-testid="zone-lands-0"] [data-testid^="card-"]',
      );
      const cards = await mine.count();
      if (cards === 0) {
        check('tapping a card over a finished game opens nothing', false,
          'this seat had no card of its own to tap');
      } else {
        await tap(mine.first());
        await page.waitForTimeout(150);
        check('tapping a card over a finished game opens nothing', !(await has(page, 'play-sheet')),
          `tapped 1 of ${cards} of this seat's cards, sheet: ${await has(page, 'play-sheet')}`);
      }
      const turnBefore = (await readNumber(page, 'turn').catch(() => null)) ?? 0;
      // Pressed up to three times rather than once: the game-over panel re-renders as the last
      // state events land, and a press that misses is not a feature that failed.
      let pressed = false;
      for (let i = 0; i < 3 && !pressed; i += 1) {
        pressed = await press(page, 'rematch');
        if (!pressed) await page.waitForTimeout(250);
      }
      /*
        Why the press did not land, kept rather than thrown away.

        `press` returns a bare false, and a run of this suite failed with "pressed: false" and
        nothing else to go on — the button was on screen, the game was over, and there was no table
        error. One more click with the reason recorded turns the next occurrence into a diagnosis
        instead of another coin flip: Playwright says in its own message whether the element was
        covered by something, detached mid-click or simply not there.
      */
      const why = pressed
        ? 'it landed'
        : await tid(page, 'rematch').first().click({ timeout: 2000 }).then(
          () => 'landed on the fourth try',
          // The whole call log, not its first line. Playwright puts the useful half underneath —
          // "element is not stable", "intercepts pointer events", "outside of the viewport" — and
          // a run that reported only "Timeout 2000ms exceeded" was one coin flip short of useless.
          (err) => String(err.message).split('\n').slice(0, 14).map((line) => line.trim()).join(' | '),
        );
      const dealt = await expectEventuallyTrue(page, async () =>
        !(await has(page, 'game-over')) && (await cardsIn(page, 'zone-hand-0').count()) === 7);
      check('and “play again” deals another game at the same table', dealt,
        `pressed: ${pressed} (${why}), game-over still up: ${await has(page, 'game-over')}, `
        + `hand ${await cardsIn(page, 'zone-hand-0').count()}, `
        + `error: ${(await has(page, 'table-error')) ? await text(page, 'table-error') : 'none'}`);
      if (dealt) {
        const turnAfter = (await readNumber(page, 'turn').catch(() => null)) ?? 0;
        check('the new game starts from turn one with the engine still running',
          turnAfter === 1 && turnBefore >= turnAfter && await has(page, 'arena-bar'),
          `turn ${turnBefore} -> ${turnAfter}`);
        // And nothing from the last game came with it. A card tapped while the old game was
        // over leaves a sheet that the new game's first render puts straight back on screen.
        check('and the new game starts with nothing left open from the last one',
          !(await has(page, 'play-sheet')), `sheet: ${await has(page, 'play-sheet')}`);
        await shot(page, 'rematch');
      }
    }

    const refusal = (await has(page, 'table-error')) ? await text(page, 'table-error') : '';
    check('the engine never refused anything the table offered', refusal === '', refusal);
    check('no uncaught errors in the browser', pageErrors.length === 0, pageErrors.join(' | '));
    check('no React warnings in the browser', reactWarnings.length === 0, reactWarnings.join(' | '));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    /*
      And when it does not fit, say what is doing it.

      `overflow 17px` is a true sentence that sends you hunting. The first thing anybody does with
      it is list every element whose right edge is past 390px — which on this table is 42 of them,
      the worst 265px over, every one a card inside a zone row. All noise: a row that scrolls
      sideways is *meant* to, and an element inside an `overflow-x: auto` ancestor cannot widen the
      document at all.

      What can widen it is an element with no scrolling ancestor between it and the root, and that
      is a short list worth printing. The failure mode it is looking for is known and has bitten
      this table before — `PlayTable.tsx` carries a comment about it: a flex child without
      `min-w-0` defaults to `min-width: auto`, sizes itself to its widest child, refuses to shrink,
      and stops the inner `overflow-x-auto` ever taking effect.

      Computed only when the check fails, because walking every element and reading a computed
      style on each is not something to do on every run for a line nobody reads.
    */
    /*
      The mid-game reading first, because it is the one with a bug behind it. A game that somehow
      never reached seven turns reports that rather than passing quietly: a check that passes
      because its fixture never arrived is the thing this whole entry is about.
    */
    check('a solo table fits a phone while the game is still going',
      midPhone !== null && midPhone.overflow <= 1,
      midPhone === null
        ? `the game never reached a seventh turn, so this was never measured (${turnsSeen} turn changes)`
        : `overflow ${midPhone.overflow}px${midPhone.free.length === 0 ? ''
          : `; widened by ${midPhone.free.join(' | ')}`}`);

    const fits = overflow <= 1;
    const culprits = fits ? null : await page.evaluate(() => {
      const docW = document.documentElement.clientWidth;
      const scrolls = (el) => {
        const o = getComputedStyle(el).overflowX;
        return o === 'auto' || o === 'scroll' || o === 'hidden';
      };
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || Math.round(r.right - docW) <= 1) continue;
        let contained = false;
        for (let q = el.parentElement; q && q !== document.documentElement; q = q.parentElement) {
          if (scrolls(q)) { contained = true; break; }
        }
        if (contained) continue;
        out.push({
          over: Math.round(r.right - docW),
          tid: el.getAttribute('data-testid') ?? '',
          tag: el.tagName.toLowerCase(),
          cls: (el.className?.toString?.() ?? '').slice(0, 80),
        });
      }
      out.sort((x, y) => y.over - x.over);
      return out.slice(0, 6);
    });
    check('a solo table fits a phone', fits, culprits === null
      ? `overflow ${overflow}px`
      : `overflow ${overflow}px; widened by ${culprits.length === 0
        ? 'nothing with an unscrolled ancestor — look at the root containers'
        : culprits.map((c) => `+${c.over}px ${c.tag}${c.tid ? `[${c.tid}]` : ''} "${c.cls}"`).join(' | ')}`);

    /*
      And fits it in a number of screens a person will actually scroll.

      Measured rather than eyeballed, because "it fits" was already true and said nothing: the
      table scrolled sideways not at all and downwards for two thousand pixels, almost all of it
      empty rows reading "no creatures" and "no lands" for seats that had not played a card yet.
      A fresh pod is the worst case and the first thing anybody sees.

      The bound is a budget, not a measurement. A fresh pod was 2.51 screens and is 2.23 now that
      an empty zone is one line instead of two; a duel was 1.37 and is 1.18. The budgets are set
      just above those, so the next thing added to a seat has to be paid for out of them rather
      than quietly doubling the scroll on the format this product is named for.

      What is left is almost all the opponents' face-down hands — seven identical card backs, a
      hundred pixels a seat, saying only a number the seat header already shows. Worth revisiting,
      and not worth changing on my own: it is the tabletop metaphor, and style is the player's call.

      **These two budgets are post-game on purpose, and the overflow check below is not.** That
      asymmetry is deliberate rather than an oversight, so it is written down here (#252).

      Sideways overflow is a defect or it is nothing: the table fits a phone or it does not, one
      reading settles it, and it had a real bug behind it that only a live game could show (D267).
      So that one is taken mid-game at a fixed point.

      Height is a density question, and at a mid-game pod it reads 2.88-3.21 screens against the
      2.35 below. Nothing there is broken — a board with cards on it is taller than a board without,
      and the one density item anybody has identified is the face-down hands above, which is Nick's
      call and not a number. Two more budgets to maintain would buy a guard against a regression in
      something nobody has called wrong.

      What would change this: somebody deciding a mid-game pod is too tall to play on a phone. Then
      measure at the same fixed point the overflow check uses, twice, and set budgets from readings
      that reproduce — the way these two were, and the way the laptop pair in the next block was.
      **Do not raise 2.35 or 1.6 to accommodate a mid-game reading**; those protect the post-game
      case and are the only numbers doing it.
    */
    const screens = await page.evaluate(() =>
      document.documentElement.scrollHeight / window.innerHeight);
    const budget = SOLO_POD ? 2.35 : 1.3;
    // Printed whether it passes or not: a budget nobody can see the balance of is one that gets
    // spent without anybody noticing.
    console.log(`      the table is ${screens.toFixed(2)} screens tall (budget ${budget})`);
    check('and does not run to more screens than anybody will scroll',
      screens <= budget, `${screens.toFixed(2)} screens, budget ${budget}`);

    /*
      And the same question on a laptop, which nothing had ever asked.

      Every screens-tall reading in this directory is taken at 390x844. That is the right worst
      case for *width* — a phone is where a row overflows sideways — and the wrong one for
      **height**, because a phone screen is tall relative to a card and a laptop is not. 844px of
      phone holds more of this table than 800px of laptop, and the laptop is where somebody
      actually sits down to play a long game. Checked rather than assumed: of the seven
      `setViewportSize` calls in the four browser suites, six set the phone, and the only desktop
      one (`e2e-table.mjs`) is restoring the viewport after the phone check, not measuring at it.

      What the numbers are for. At more than one screen you cannot see both boards at once, and
      reading your board against the opponent's is the thing a player does constantly — Arena
      shows both. So the height is one reading and **the span of the creature rows against one
      viewport** is the other, because the second is the actual question and the first is only a
      proxy for it.

      The duel answers both, and the answer is that the premise this check was written from was
      wrong: 1.16 screens, and the two creature rows inside 229px of the 800px viewport. Both
      boards are already on the screen together with room to spare. The budgets below are set from
      those readings the way the phone ones above were.

      The pod answers both too, now that a run has reached this block: 1.41 screens, and all
      **four** creature rows inside 331px of the same 800px viewport. Four boards at once, which is
      the reading that matters most — a pod is the format this product is named for and the one
      where "can I see everybody" is a real question rather than a rhetorical one.

      It took three attempts to get that number, and the reason is worth leaving here. One
      `SOLO_POD=1` run played 270 moves in fifteen minutes — about 3.3 seconds a move — and never
      reached this block, which is what made the pod look unmeasurable (#250). It is not: the same
      mode read a flat 253 ms/move over 220 moves, and a later run finished the game and printed
      both figures. So a budget here is set from readings, like the ones above, and the outlier is
      recorded as an outlier rather than as the pod's pace.
    */
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.waitForTimeout(400);
    const laptop = await page.evaluate(() =>
      document.documentElement.scrollHeight / window.innerHeight);
    const boards = await page.evaluate(() => {
      // Can a player see their own creatures and an opponent's at the same time? The outer bounds
      // of every creature row against one viewport, which is the question the page height only
      // approximates.
      const rows = [...document.querySelectorAll('[data-testid^="zone-creatures-"]')];
      if (rows.length < 2) return null;
      const tops = rows.map((r) => r.getBoundingClientRect().top + window.scrollY);
      const bottoms = rows.map((r) => r.getBoundingClientRect().bottom + window.scrollY);
      return {
        rows: rows.length,
        span: Math.round(Math.max(...bottoms) - Math.min(...tops)),
        viewport: window.innerHeight,
      };
    });
    console.log(`      on a 1440x800 laptop: ${laptop.toFixed(2)} screens tall`);
    console.log(boards === null
      ? '      only one creature row on screen, so there are no two boards to fit'
      : `      ${boards.rows} creature rows span ${boards.span}px of ${boards.viewport}px`);
    await shot(page, 'laptop');
    // Set from the readings above, and the same shape as the phone budgets: just enough headroom
    // that the next thing added to a seat has to be paid for out of it.
    const laptopBudget = SOLO_POD ? 1.6 : 1.3;
    check('and on a laptop, where the screen is shorter rather than narrower',
      laptop <= laptopBudget, `${laptop.toFixed(2)} screens, budget ${laptopBudget}`);
    /*
      Asserted against the whole viewport rather than a fraction of it, because this is the
      player-facing claim and not a density budget: at a span wider than one screen you cannot read
      your board against theirs without scrolling, and at anything under it you can. The duel uses
      229px of 800 and the pod 331px, so both have room — but the threshold worth defending is the
      screen, and the figures print either way.
    */
    check(SOLO_POD
      ? 'so all four boards are on the screen at once, which is what the height is for'
      : 'so both boards are on the screen at once, which is what the height is for',
      boards !== null && boards.span <= boards.viewport, JSON.stringify(boards));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);

    // Whatever the table is asking for has to be readable while it asks. The feed sits at the
    // bottom of the board and the prompt sits in the control bar, and on a phone they were the
    // same place: three lines of "Opponent III mulliganed to 6" straight over "Keep or mulligan?".
    const clash = await page.evaluate(() => {
      const feed = document.querySelector('[data-testid="table-feed"]');
      const bar = document.querySelector('[data-testid="arena-bar"]');
      if (!feed || !bar) return 'nothing to compare';
      const a = feed.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      if (a.height === 0 || b.height === 0) return 'ok';
      const over = a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
      return over ? `feed ${Math.round(a.top)}..${Math.round(a.bottom)} over bar ${Math.round(b.top)}..${Math.round(b.bottom)}` : 'ok';
    });
    check('the feed does not sit on top of what the table is asking for',
      clash === 'ok' || clash === 'nothing to compare', String(clash));
    await shot(page, 'phone');
  } catch (err) {
    check('the run completed without throwing', false, err.message);
    await shot(page, 'at-failure').catch(() => {});
  } finally {
    await browser.close();
  }

  summarize();
}

await main();
