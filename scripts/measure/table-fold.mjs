/**
 * How much of a real table fits on one screen, **mid-game**, measured in the DOM.
 *
 *   node scripts/play.mjs            # in another shell: this one drives a real browser
 *   node scripts/measure/table-fold.mjs
 *
 * Written because every reading that had ever answered this question was taken **post-game**
 * (#273, D293). D266 refuted #249's premise with two figures at 1440x800 — a duel is 1.16 screens
 * and its two creature rows sit inside 229px of the viewport — and both are measured after the
 * last creature has died, on a board with nothing on it. The question is a mid-game one. The gap
 * survived because the post-game answer was so comfortable that nobody asked whether a board with
 * cards on it still fits.
 *
 * **Two numbers, and only the second is the question.** The page height is a proxy: it says how
 * far you would scroll, not whether you can read your board against an opponent's. The span of the
 * creature rows against one viewport is the actual thing a player does constantly, which is why
 * `e2e-solo.mjs` measures both and says so. This file keeps the same pair, mid-game.
 *
 * **And a third that is deliberately *not* the question.** It also prints the span of the creature
 * rows *plus your hand*, because that is the number a screenshot makes you want to read, and it is
 * a different and weaker claim: nothing has ever asserted the hand fits beside both boards, and it
 * often does not. Reading that one as though it answered D266 is precisely how #249 produced a
 * confident false premise, and it was very nearly repeated while writing this file. The two are
 * printed next to each other, labelled, so the mistake has to be made on purpose.
 *
 * **Why this is a measurement and not a check.** It asserts nothing and sets no budget. The comment
 * above the budgets in `e2e-solo.mjs` rules that mid-game budgets wait on somebody deciding the
 * mid-game table is too tall, that two more budgets would guard a regression in something nobody
 * has called wrong, and that 1.3 and 2.35 must not be raised to accommodate a mid-game reading.
 * This file exists so that decision can be made against figures rather than against a screenshot.
 *
 * **Not a screenshot, on purpose.** `shot()` in the browser suites captures `fullPage: true`, which
 * renders the sticky control bar at the viewport's bottom edge with the rest of the page stitched
 * below it — so a full-page capture shows the bar floating mid-image with content underneath, which
 * is not what anybody sees. Harmless for the suites, which measure geometry with
 * `getBoundingClientRect` against `innerHeight` the way this file does, and a trap for anyone
 * trying to settle a layout question by looking at `e2e-shots/`.
 *
 * The readings it produced, three solo duels driven to mid-game at 1440x900 (D293):
 *
 *   page height          1.59 / 1.33 / 1.59 screens
 *   both creature rows   568 / 331 / 568 px of the 900px viewport   <- fits every time
 *   rows plus the hand   1019 / 782 / 1019 px                        <- fits once of three
 *
 * Runs one and three agree to the pixel and run two is a shorter game, which is the spread a
 * board-dependent reading should have. Both boards are on the screen together mid-game, so D266's
 * conclusion holds where it actually matters.
 */
import {
  chromium, waitFor, tid, makeMove, isMyMove,
} from '../lib/table-driver.mjs';

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
/** How many moves to play before measuring. Enough that both seats have a board. */
const MOVES = Number(process.env.MOVES ?? 26);
const OPPONENT_DECK = process.env.OPPONENT_DECK ?? 'tidal-mind';
const MY_DECK = process.env.MY_DECK ?? 'ember-rush';

/**
 * The sizes worth asking at.
 *
 * The laptop first, because it is the one nothing had ever measured and the one somebody sits down
 * at for a long game: 844px of phone holds more of this table than 800px of laptop. The phone is
 * kept because it is the right worst case for *width* and every other reading in the tree is taken
 * there, so a figure here can be compared with one there.
 */
const SIZES = [
  { name: 'laptop  1440x900', width: 1440, height: 900 },
  { name: 'desktop 1280x950', width: 1280, height: 950 },
  { name: 'phone    390x844', width: 390, height: 844 },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(BASE);
  await waitFor(page, 'lobby');
  await tid(page, 'player-name').fill('Nick');
  await waitFor(page, `solo-${OPPONENT_DECK}`);
  await tid(page, `solo-${OPPONENT_DECK}`).click();
  await waitFor(page, 'pregame');
  await waitFor(page, `deck-${MY_DECK}`, 20000);
  await tid(page, `deck-${MY_DECK}`).click();
  await waitFor(page, 'start-engine', 20000);
  await tid(page, 'start-engine').click();
  await waitFor(page, 'table', 20000);

  // Into the middle of a real game. `makeMove` is the same driver the browser suites play with, so
  // the board this measures is the board those suites produce rather than one arranged by hand.
  for (let i = 0; i < MOVES; i += 1) {
    if (await isMyMove(page)) await makeMove(page, 0, { aggression: 1 });
    else await page.waitForTimeout(250);
  }

  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const span = (selector) => {
        const rows = [...document.querySelectorAll(selector)];
        if (rows.length < 2) return null;
        const boxes = rows.map((el) => el.getBoundingClientRect());
        const top = Math.min(...boxes.map((b) => b.top + window.scrollY));
        const bottom = Math.max(...boxes.map((b) => b.bottom + window.scrollY));
        return Math.round(bottom - top);
      };
      const hand = document.querySelector('[data-testid="zone-hand-0"]');
      const creatures = [...document.querySelectorAll('[data-testid^="zone-creatures-"]')];
      let withHand = null;
      if (hand && creatures.length >= 2) {
        const boxes = [...creatures, hand].map((el) => el.getBoundingClientRect());
        withHand = Math.round(
          Math.max(...boxes.map((b) => b.bottom + window.scrollY))
          - Math.min(...boxes.map((b) => b.top + window.scrollY)));
      }
      return {
        viewport: window.innerHeight,
        screens: document.documentElement.scrollHeight / window.innerHeight,
        boards: span('[data-testid^="zone-creatures-"]'),
        withHand,
      };
    });
    const fit = (v) => (v === null ? 'n/a'
      : v <= r.viewport ? `fits, ${r.viewport - v}px to spare` : `DOES NOT FIT by ${v - r.viewport}px`);
    console.log(`\n${size.name}`);
    console.log(`  page height        ${r.screens.toFixed(2)} screens`);
    console.log(`  both creature rows ${String(r.boards).padStart(5)}px of ${r.viewport}px — ${fit(r.boards)}   <- the question`);
    console.log(`  rows plus the hand ${String(r.withHand).padStart(5)}px of ${r.viewport}px — ${fit(r.withHand)}   <- not the question; see the docblock`);
  }
  if (errors.length > 0) console.log(`\npage errors: ${errors.length}\n  ${errors.join('\n  ')}`);
} finally {
  await browser.close();
}
