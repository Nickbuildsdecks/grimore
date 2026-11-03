/**
 * Does the in-flight marker appear while a move is actually with the server? (#299)
 *
 * #299 shipped a marker beside the table code that reads "opponents deciding" while a move is in
 * flight, and `table.test.ts` pins the *decision* — three unit tests on `waitingNote`, and the
 * reducer's own `waiting` flag. What no test pinned is the **moment**: whether the thing appears
 * on a real page, during a real write, and stops when the answer lands. A marker that renders
 * correctly and never shows is the same to a player as no marker at all, and it is exactly the
 * kind of claim this project has learned to stop asserting from the unit test alone.
 *
 * A browser is the only instrument that can answer it, and the reading has to be taken *during*
 * the write — so this does not poll. An init script installs a MutationObserver before any app
 * code runs, and every appearance of the marker is recorded with its text and the time it was
 * seen. Polling at any interval this script could afford would miss a 400ms window.
 *
 * It has two arms, because one arm proves nothing:
 *
 *   ARM=slow   the play server runs with BOT_MOVES_PER_WRITE high, so one write plays whole bot
 *              turns and every move the person makes is long. The marker MUST appear.
 *   ARM=quick  the play server runs with BOT_MOVES_PER_WRITE=1, so each write does one bot move
 *              and the continuation carries the rest in further writes. Writes are short, and the
 *              marker should stay away.
 *
 * The pair is the measurement. `slow` alone would pass on a marker stuck permanently on screen;
 * `quick` alone would pass on a marker that never renders at all.
 *
 * Run it yourself, one arm at a time (the budget is server-side, so the server restarts between):
 *   BOT_MOVES_PER_WRITE=500 PLAY_HOST=127.0.0.1 node scripts/play.mjs &
 *   ARM=slow node scripts/check-in-flight.mjs
 *   # then, with the server restarted at BOT_MOVES_PER_WRITE=1
 *   ARM=quick node scripts/check-in-flight.mjs
 */
import path from 'node:path';
import {
  chromium, check, checks, setShotDir, summarize, shot, waitFor, tid, has, text,
  isMyMove, makeMove, press, pressFailures, readNumber, watchForReactWarnings,
} from './lib/table-driver.mjs';

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'in-flight');
const HEADED = process.env.HEADED === '1';
/** Which arm this run is: see the file docblock. Anything else is a mistake worth stopping on. */
const ARM = process.env.ARM ?? '';
/** How many of the person's moves to play. Enough turns for the server's seats to take some. */
const MOVES = Number(process.env.MOVES ?? 18);

if (ARM !== 'slow' && ARM !== 'quick') {
  console.error(`ARM must be "slow" or "quick" (got ${JSON.stringify(ARM)}); see the docblock.`);
  process.exit(2);
}

/**
 * Records every appearance of the marker, from before the app's first render.
 *
 * `subtree: true` from `document.documentElement` because the marker is mounted and unmounted by
 * React rather than hidden, so there is no element to watch for attribute changes — the record has
 * to be of nodes arriving. Both halves are kept: when it appeared and when it went, so a marker
 * that never leaves is distinguishable from one that behaves.
 */
const WATCH = () => {
  const seen = [];
  window.__inFlight = seen;
  const id = 'move-in-flight';
  const find = (root) => {
    if (!(root instanceof HTMLElement)) return null;
    if (root.dataset?.testid === id) return root;
    return root.querySelector?.(`[data-testid="${id}"]`) ?? null;
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const found = find(node);
        if (found !== null) seen.push({ at: Math.round(performance.now()), gone: false, text: found.textContent ?? '' });
      }
      for (const node of record.removedNodes) {
        if (find(node) !== null) seen.push({ at: Math.round(performance.now()), gone: true, text: '' });
      }
    }
  });
  /*
    `document`, not `document.documentElement`.

    An init script runs before the page has an `<html>`, so `documentElement` is null and
    `observe` throws "parameter 1 is not of type 'Node'" — which is what the first run of this did,
    silently, while reporting **0 appearances across 18 moves**. A broken instrument reporting
    nothing looks exactly like a marker that never shows, and the only reason that reading was not
    believed is that this script also checks for page errors. `document` is a Node from the start
    and `subtree: true` covers everything under it.
  */
  observer.observe(document, { childList: true, subtree: true });
};

async function main() {
  setShotDir(SHOT_DIR);
  const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(WATCH);
  const page = await context.newPage();
  const pageErrors = [];
  const reactWarnings = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  watchForReactWarnings(page, '', reactWarnings);

  try {
    await page.goto(BASE);
    await waitFor(page, 'lobby');
    await tid(page, 'player-name').fill('Nick');
    // The four-seat pod on purpose: three server seats taking whole turns is what makes a write
    // long, and a long write is the only thing the marker is for.
    await waitFor(page, 'solo-pod');
    await tid(page, 'solo-pod').click();
    await waitFor(page, 'pregame');
    await waitFor(page, 'deck-ember-rush', 20000);
    await tid(page, 'deck-ember-rush').click();
    // `start-engine`, not `start-game`: the first run of this waited fifteen seconds for a
    // mulligan prompt that was never going to come, because the button that starts the rules
    // engine on a dealt table is the one the lobby actually offers.
    await waitFor(page, 'start-engine');
    await tid(page, 'start-engine').click();
    await waitFor(page, 'table');
    await waitFor(page, 'phase-bar');
    await waitFor(page, 'mulligan-prompt', 30000);
    const lives = [];
    for (let s = 0; s < 4; s++) lives.push(await readNumber(page, `life-${s}`));
    check('a four-seat pod against the computer is dealt', lives.every((l) => l === 40), JSON.stringify(lives));

    /*
      The instrument's own health, checked before any reading is taken from it.

      The first run of this reported 0 appearances with the observer never attached, and the second
      reported 0 appearances with it attached — and the two readings are indistinguishable without
      a positive control. So one marker is planted by hand and the observer has to see it. If this
      check fails, nothing below it means anything, and the script says so rather than reporting a
      confident zero.
    */
    const control = await page.evaluate(() => {
      const span = document.createElement('span');
      span.dataset.testid = 'move-in-flight';
      span.textContent = 'planted by the self-test';
      document.body.appendChild(span);
      return new Promise((resolve) => {
        setTimeout(() => {
          const saw = (window.__inFlight ?? []).some((s) => !s.gone && /planted/.test(s.text));
          span.remove();
          setTimeout(() => { if (window.__inFlight !== undefined) window.__inFlight.length = 0; resolve(saw); }, 50);
        }, 50);
      });
    });
    check('the watcher sees a marker planted in front of it', control === true, `control=${control}`);

    let played = 0;
    for (let move = 0; move < MOVES; move += 1) {
      if (await has(page, 'game-over')) break;
      if (!(await isMyMove(page))) {
        // The table is answering. Give it the client's own patience, not a guess.
        await page.waitForTimeout(250);
        continue;
      }
      await makeMove(page, 0);
      played += 1;
    }
    check('the person got moves in', played > 0, `played ${played}`);

    const seen = await page.evaluate(() => window.__inFlight ?? []);
    const appearances = seen.filter((s) => !s.gone);
    const departures = seen.filter((s) => s.gone);
    const words = [...new Set(appearances.map((a) => a.text.trim()))];
    console.log(`arm=${ARM} moves=${played} appearances=${appearances.length} departures=${departures.length}`);
    if (words.length > 0) console.log(`  said: ${JSON.stringify(words)}`);

    if (ARM === 'slow') {
      check(
        'the marker appears while a move is with the server',
        appearances.length > 0,
        `${appearances.length} appearances across ${played} moves`,
      );
      // A pod's opponents are the computer's, so this is the branch `waitingNote` picks for bots.
      check(
        'and it says the opponents are deciding',
        words.some((w) => /opponents deciding/i.test(w)),
        JSON.stringify(words),
      );
      // It has to go away again: a marker that never leaves is a permanent "please wait".
      check(
        'and it goes away when the answer lands',
        departures.length > 0 && departures.length >= appearances.length - 1,
        `${appearances.length} in, ${departures.length} out`,
      );
    } else {
      check(
        'short writes leave the marker alone',
        appearances.length === 0,
        `${appearances.length} appearances across ${played} moves: ${JSON.stringify(words)}`,
      );
    }

    await shot(page, `in-flight-${ARM}`);
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('no React warnings', reactWarnings.length === 0, reactWarnings.join(' | '));
  } finally {
    await browser.close();
  }

  if (pressFailures.length > 0) {
    console.log(`${pressFailures.length} press(es) did not land:`);
    for (const f of pressFailures) console.log(`  ${f.id}: ${f.why}`);
  }
  const ok = summarize();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
