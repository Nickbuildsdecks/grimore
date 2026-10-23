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
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core',
    '/opt/node-tools/node_modules/playwright/index.js',
  ].filter(Boolean);
  for (const spec of candidates) {
    try {
      return require(spec);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('playwright not found. Install it (npm i -D playwright) or set PLAYWRIGHT_PATH.');
}
const { chromium } = loadPlaywright();

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'solo');
const HEADED = process.env.HEADED === '1';
const OPPONENT_DECK = process.env.OPPONENT_DECK ?? 'tidal-mind';
const MAX_MOVES = Number.parseInt(process.env.MAX_MOVES ?? '2000', 10);

let step = 0;
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}${detail && !ok ? ` — ${detail}` : ''}`);
};

async function shot(page, name) {
  step += 1;
  await page.screenshot({ path: path.join(SHOT_DIR, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
}

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const has = async (page, id) => (await tid(page, id).count()) > 0;
const text = async (page, id) => ((await tid(page, id).first().textContent()) ?? '').trim();
const cardsIn = (page, zone) => page.locator(`[data-testid="${zone}"] [data-testid^="card-"]`);

async function waitFor(page, testId, timeout = 20000) {
  try {
    await page.waitForSelector(`[data-testid="${testId}"]`, { timeout, state: 'visible' });
  } catch {
    throw new Error(`timed out waiting for [data-testid="${testId}"]`);
  }
}

async function readNumber(page, testId) {
  const raw = (await tid(page, testId).first().textContent()) ?? '';
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Whether the table is asking this player for anything. */
async function myMove(page) {
  for (const id of ['mulligan-prompt', 'bottom-prompt', 'decide-prompt', 'choose-prompt', 'feed-prompt', 'target-prompt', 'attack-prompt', 'block-prompt', 'discard-prompt', 'primary-move']) {
    if (await has(page, id)) return true;
  }
  return false;
}

/** Takes whatever the table offers, which on a solo table is the whole of playing. */
async function takeTurn(page) {
  if (await has(page, 'bottom-prompt')) {
    const hand = cardsIn(page, 'zone-hand-0');
    const count = await hand.count();
    for (let i = 0; i < count && !(await has(page, 'confirm-bottom')); i++) {
      await hand.nth(i).click({ timeout: 2000 }).catch(() => {});
    }
    if (await has(page, 'confirm-bottom')) {
      await tid(page, 'confirm-bottom').click();
      return 'kept a mulliganed hand';
    }
    await tid(page, 'cancel-mode').click();
    return 'backed out';
  }
  if (await has(page, 'mulligan-prompt')) {
    await tid(page, 'primary-move').click();
    return 'kept the opening hand';
  }
  // A card that stopped mid-resolution to ask this player something blocks everything, including
  // the player whose spell it is. Answered before priority is even looked at.
  if (await has(page, 'decide-prompt')) {
    const prompt = await text(page, 'decide-prompt');
    // The candidates are lit wherever they are — hand, battlefield, graveyard, or the library,
    // which is the one zone the table draws only while a search is open.
    for (let pick = 0; pick < 4; pick++) {
      const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
      if ((await lit.count()) === 0) break;
      await lit.first().click({ timeout: 2000 }).catch(() => {});
      // An exact count sends itself; a range needs confirming, and "choose nothing" is an answer.
      if (!(await has(page, 'decide-prompt'))) return `answered: ${prompt}`;
      if (await has(page, 'confirm-decision')) {
        await tid(page, 'confirm-decision').click();
        return `answered: ${prompt}`;
      }
    }
    if (await has(page, 'confirm-decision')) {
      await tid(page, 'confirm-decision').click();
      return `answered with nothing: ${prompt}`;
    }
    // Nothing lit and nothing to confirm: the table is asking a question it is not showing an
    // answer to, which stops the game — a defect to report rather than wait out.
    return null;
  }

  if (await has(page, 'feed-prompt')) {
    // An ability whose cost is a sacrifice: the creatures that can pay for it are lit.
    const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
    if ((await lit.count()) > 0) {
      await lit.first().click();
      return 'fed a sacrifice outlet';
    }
    await tid(page, 'cancel-mode').click();
    return 'backed out of a sacrifice';
  }

  if (await has(page, 'choose-prompt')) {
    // A triggered ability waiting to be aimed. Its legal targets light up like a spell's.
    const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
    if ((await lit.count()) > 0) {
      await lit.first().click();
      return 'aimed a trigger';
    }
    const seatButton = page.locator('[data-testid^="target-seat-"]');
    if ((await seatButton.count()) > 0) {
      await seatButton.first().click();
      return 'aimed a trigger at a player';
    }
    return 'nothing to aim at';
  }
  if (await has(page, 'target-prompt')) {
    const onStack = page.locator('[data-testid^="target-stack-"]');
    if ((await onStack.count()) > 0) {
      await onStack.first().click();
      return 'countered something';
    }
    const seatButton = page.locator('[data-testid="target-seat-1"]');
    if ((await seatButton.count()) > 0) {
      await seatButton.first().click();
      return 'aimed at the opponent';
    }
    const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
    if ((await lit.count()) > 0) {
      await lit.first().click();
      return 'aimed at a card';
    }
    await tid(page, 'cancel-mode').click();
    return 'cancelled a spell with nothing to aim at';
  }
  if (await has(page, 'attack-prompt')) {
    const mine = cardsIn(page, 'zone-battlefield-0');
    const count = await mine.count();
    for (let i = 0; i < count; i++) await mine.nth(i).click({ timeout: 2000 }).catch(() => {});
    await tid(page, 'confirm-attackers').click();
    return 'attacked';
  }
  if (await has(page, 'block-prompt')) {
    const mine = cardsIn(page, 'zone-battlefield-0');
    const count = await mine.count();
    for (let i = 0; i < count; i++) {
      await mine.nth(i).click({ timeout: 2000 }).catch(() => {});
      const lit = page.locator('[data-testid^="card-"].ring-\\[var\\(--g-status-info\\)\\]');
      if ((await lit.count()) === 0) continue;
      await lit.first().click({ timeout: 2000 }).catch(() => {});
      break;
    }
    await tid(page, 'confirm-blockers').click();
    return 'blocked';
  }
  if (await has(page, 'discard-prompt')) {
    await cardsIn(page, 'zone-hand-0').first().click();
    return 'discarded to hand size';
  }

  const label = await text(page, 'primary-move');
  // Develop the board when there is time to: tapping a card the table marks playable opens the
  // sheet listing what the engine says can be done with it.
  if (/^Pass$/.test(label) || /^Resolve/.test(label)) {
    const hand = page.locator('[data-testid="zone-hand-0"] [data-testid^="card-"]');
    const count = await hand.count();
    // Random order, not left to right. Left to right takes the leftmost playable card every time,
    // which is nearly always a land or the cheapest creature, so anything further along in hand
    // can sit there for a whole game and never be cast.
    for (const i of [...Array(count).keys()].sort(() => Math.random() - 0.5)) {
      const card = hand.nth(i);
      if (!/playable/i.test((await card.textContent()) ?? '')) continue;
      await card.click();
      await waitFor(page, 'play-sheet', 5000);
      const options = page.locator('[data-testid^="play-"]:not([data-testid="play-sheet"]):not([data-testid="play-sheet-close"])');
      const choices = await options.count();
      if (choices > 0) {
        // And a random one of the plays it offers: a modal spell is one play per mode, so always
        // taking the top option would only ever exercise mode one.
        const pick = options.nth(Math.floor(Math.random() * choices));
        const name = ((await pick.textContent()) ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        await pick.click();
        return `played ${name}`;
      }
      await tid(page, 'play-sheet-close').click();
      break;
    }
  }
  await tid(page, 'primary-move').click();
  return `primary: ${label}`;
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
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
    await waitFor(page, `solo-${OPPONENT_DECK}`);
    await tid(page, `solo-${OPPONENT_DECK}`).click();
    await waitFor(page, 'pregame');
    check('the lobby offers a game against the computer', true);

    // No ready-up: there is nobody to wait for, so the table deals itself.
    await waitFor(page, 'deck-ember-rush', 20000);
    check('the table deals without anybody having to ready up', true);
    const seatText = await text(page, 'lobby-seat-1');
    check('and says which seat the computer plays', /computer/i.test(seatText), seatText);
    await shot(page, 'solo-lobby');

    await tid(page, 'deck-ember-rush').click();
    await waitFor(page, 'start-engine');
    await tid(page, 'start-engine').click();

    await waitFor(page, 'table');
    await waitFor(page, 'phase-bar');
    await waitFor(page, 'mulligan-prompt');
    check('the game starts and asks for an opening-hand decision', true);
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

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${SHOT_DIR}/`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

await main();
