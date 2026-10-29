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
 * `LIST=costs` one built to pay an alternative cost — see `COSTS_LIST` — and `LIST=earned` one
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
 * Which deck the computer plays, and why `LIST=earned` does not take the default.
 *
 * Tidal Mind is the default because it is the deck that asks the table the most questions. It is
 * the wrong opponent for `LIST=earned`, and that cost a run to find out: a mono-red list of burn
 * and sweepers against a control deck holding a Wall of Frost and a Dirgur Nemesis is two decks
 * that cannot close, and the game ran past **450 moves of nothing but Pass** without reaching a
 * winner. Ember Rush ends games — its own and this one's — so the scenario puts the two fastest
 * decks in the pool at the same table and gets a result in twenty turns instead of a hundred.
 */
const OPPONENT_DECK = process.env.OPPONENT_DECK ?? (LIST === 'earned' ? 'ember-rush' : 'tidal-mind');
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
 * each one is a prowess trigger as well. `OPPONENT_DECK` above is the other half of the clock.
 *
 * Mono-red on purpose: `LIST=costs` needed three colours and failed its first run on the mana base
 * rather than on a keyword, and the fix was twelve guildgates. This list has nothing to fix.
 */
const EARNED_LIST = [
  '18 Mountain', '8 Sol Ring',
  '8 Skewer the Critics', '8 Mizzium Mortars',
  '6 Lightning Bolt', '12 Monastery Swiftspear',
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
const takeTurn = (page) => makeMove(page, 0, { aggression: 1 });

async function main() {
  await setShotDir(SHOT_DIR);
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await context.newPage();
  const pageErrors = [];
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
      : { evoke: 0, dash: 0, bestow: 0 };
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
        if (typeof did === 'string') {
          for (const word of Object.keys(altCasts)) {
            if (did.includes(`its ${word} cost`)) altCasts[word] += 1;
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
    const dealBudget = LIST === 'earned' ? 5 : 3;
    while ((LIST === 'costs' || LIST === 'earned') && games < dealBudget
      && !Object.values(altCasts).every((n) => n > 0)) {
      if (!(await has(page, 'game-over'))) break;
      console.log(`      dealing again: ${JSON.stringify(altCasts)} after ${games} game(s)`);
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
