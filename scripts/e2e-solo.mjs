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
  isMyMove, makeMove, readNumber,
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
  page.on('pageerror', (err) => pageErrors.push(err.message));

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

    const refusal = (await has(page, 'table-error')) ? await text(page, 'table-error') : '';
    check('the engine never refused anything the table offered', refusal === '', refusal);
    check('no uncaught errors in the browser', pageErrors.length === 0, pageErrors.join(' | '));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('a solo table fits a phone', overflow <= 1, `overflow ${overflow}px`);
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
