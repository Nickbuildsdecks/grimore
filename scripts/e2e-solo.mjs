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
const OPPONENT_DECK = process.env.OPPONENT_DECK ?? 'tidal-mind';
/**
 * `SOLO_POD=1` plays the four-seat Commander table instead of the duel.
 *
 * The same script, because it is the same claim — one person, one browser, a whole game — and
 * the only difference is how many seats the server is playing. A second file would be a second
 * copy of the play loop, and this project has already learned what that costs.
 */
const SOLO_POD = process.env.SOLO_POD === '1';
const MAX_MOVES = Number.parseInt(process.env.MAX_MOVES ?? '2000', 10);

/**
 * The solo player's hands are the shared driver's.
 *
 * They used to be a copy of them, and the copy is what broke: the X-cost prompt was taught to
 * `lib/table-driver.mjs`, the two-browser suites learned it for free, and this one sat on a
 * stalled game at turn seven because its own copy had never heard of it. A third copy of "what
 * does this prompt mean" is a third thing to forget.
 */
const myMove = (page) => isMyMove(page);
/** Aggression 1: a solo game has nobody to hold mana up against, so it always develops. */
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

    await tid(page, 'deck-ember-rush').click();
    await waitFor(page, 'start-engine');
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
    let lastTurn = (await readNumber(page, 'turn')) ?? 1;
    let turnsSeen = 0;
    let stuck = 0;
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
      if (moves % 15 === 0) console.log(`      move ${moves}: ${did}`);
      await page.waitForTimeout(60);
      const turn = await readNumber(page, 'turn');
      if (turn !== null && turn > lastTurn) {
        turnsSeen += turn - lastTurn;
        lastTurn = turn;
      }
      if (turnsSeen === 3) await shot(page, 'mid-game');
    }

    console.log(`      played ${moves} moves over ${turnsSeen} turn changes`);
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
