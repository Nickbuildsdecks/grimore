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
 * table to pick it out of a list of permanents (`PROLIFERATE_LIST`), and `LIST=earned` one
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
  makeMove(page, 0, { aggression: 1, abilities: LIST === 'proliferate' });

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
    let lastTurn = (await readNumber(page, 'turn')) ?? 1;
    let turnsSeen = 0;
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
      || LIST === 'dredge' || LIST === 'buyback' || LIST === 'proliferate'
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
      : !Object.values(altCasts).every((n) => n > 0));
    while ((LIST === 'costs' || LIST === 'earned' || LIST === 'graveyard' || LIST === 'miracle'
      || LIST === 'rebound' || LIST === 'replicate' || LIST === 'extort' || LIST === 'suspend'
      || LIST === 'dredge' || LIST === 'buyback' || LIST === 'proliferate')
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
    check('a solo table fits a phone', overflow <= 1, `overflow ${overflow}px`);

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
    */
    const screens = await page.evaluate(() =>
      document.documentElement.scrollHeight / window.innerHeight);
    const budget = SOLO_POD ? 2.35 : 1.3;
    // Printed whether it passes or not: a budget nobody can see the balance of is one that gets
    // spent without anybody noticing.
    console.log(`      the table is ${screens.toFixed(2)} screens tall (budget ${budget})`);
    check('and does not run to more screens than anybody will scroll',
      screens <= budget, `${screens.toFixed(2)} screens, budget ${budget}`);

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
