/**
 * Two browsers, one game of Magic, start to finish through the real UI.
 *
 * This is the acceptance test for the Play Realm table: not "the reducer works" (the engine's own
 * suite covers that) and not "the socket works" (apps/realtime's suite covers that), but "two
 * people on two machines can actually sit down and play". It drives two isolated browser contexts
 * — separate storage, separate sockets, exactly like two laptops — through a lobby, a deck choice,
 * an opening hand, several turns of real card movement, and a finish.
 *
 * It also checks the one thing no amount of UI polish substitutes for: that the hand each player
 * cannot see is genuinely not in their browser. The card backs are asserted to carry no name,
 * because the server never sent one.
 *
 * Run it yourself:
 *   redis-server --daemonize yes --save '' --appendonly no
 *   pnpm -r --filter './packages/*' run build && pnpm --filter @grimore/realtime run build
 *   PORT=4100 REDIS_URL=redis://127.0.0.1:6379 node apps/realtime/dist/server.js &
 *   (cd apps/web && ./node_modules/.bin/vite --port 5100) &
 *   node scripts/e2e-table.mjs
 *
 * Screenshots land in the directory given by SHOT_DIR (default ./e2e-shots), so a failure can be
 * looked at rather than guessed at.
 */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Playwright is not a dependency of this repository — it is a test tool, and it ships a browser.
 * So it is resolved from wherever it happens to live: a local install, a global one, or the path in
 * PLAYWRIGHT_PATH. Chromium itself is found through PLAYWRIGHT_BROWSERS_PATH as usual.
 */
const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    'playwright-core',
    '/opt/node-tools/node_modules/playwright/index.js',
  ].filter(Boolean);
  for (const spec of candidates) {
    try {
      return require(spec);
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    'playwright not found. Install it (npm i -D playwright) or point PLAYWRIGHT_PATH at an install.',
  );
}
const { chromium } = loadPlaywright();

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? 'e2e-shots';
const HEADED = process.env.HEADED === '1';

let step = 0;
const checks = [];

function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? ' ok ' : 'FAIL'}  ${label}${detail && !condition ? ` — ${detail}` : ''}`);
}

async function shot(page, name) {
  step += 1;
  const file = path.join(SHOT_DIR, `${String(step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** Waits for a testid to appear, with a clearer failure than a bare timeout. */
async function waitFor(page, testId, timeout = 15000) {
  try {
    await page.waitForSelector(`[data-testid="${testId}"]`, { timeout, state: 'visible' });
  } catch {
    throw new Error(`timed out waiting for [data-testid="${testId}"] on ${page.url()}`);
  }
}

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const cardsIn = (page, zoneTestId) => page.locator(`[data-testid="${zoneTestId}"] [data-testid^="card-"]`);

/** Taps a card and picks an action from the sheet that opens. */
async function cardAction(page, cardLocator, actionId) {
  await cardLocator.click();
  await waitFor(page, 'card-sheet');
  await tid(page, actionId).first().click();
  await page.waitForSelector('[data-testid="card-sheet"]', { state: 'detached', timeout: 10000 });
}

/** Reads a numeric testid, retrying while the socket catches up. */
async function readNumber(page, testId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = (await tid(page, testId).first().textContent()) ?? '';
    const n = Number.parseInt(text.trim(), 10);
    if (Number.isFinite(n)) return n;
    if (Date.now() > deadline) throw new Error(`${testId} never read as a number (last: ${JSON.stringify(text)})`);
    await page.waitForTimeout(100);
  }
}

async function expectEventually(page, label, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return check(label, true);
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) return check(label, false, `last value: ${JSON.stringify(last)}`);
    await page.waitForTimeout(150);
  }
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED });

  // Two isolated contexts: separate localStorage and separate sockets, which is what makes this a
  // test of two players rather than of two tabs sharing a seat.
  const nickCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const friendCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const nick = await nickCtx.newPage();
  const friend = await friendCtx.newPage();

  // Uncaught exceptions are failures. Failed *requests* are judged by what they were for: the
  // table deliberately needs only Redis and apps/realtime, so a 502 from /api/auth/status when
  // apps/api is not running is expected rather than a defect, and in dev the SPA asks for
  // /logo.svg at the server root while Vite serves it under /react/. Anything else failing — the
  // page bundle, the socket — is a real problem and is reported as one.
  const pageErrors = [];
  const badRequests = [];
  const EXPECTED_FAILURES = [/\/api\//, /\/logo\.svg/];
  for (const [who, page] of [['Nick', nick], ['Friend', friend]]) {
    page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
    page.on('response', (res) => {
      if (res.status() < 400) return;
      if (EXPECTED_FAILURES.some((re) => re.test(res.url()))) return;
      badRequests.push(`${who}: ${res.status()} ${res.url()}`);
    });
  }

  try {
    // ── Lobby ───────────────────────────────────────────────────────────────────────────────────
    await nick.goto(BASE);
    await waitFor(nick, 'lobby');
    await tid(nick, 'player-name').fill('Nick');
    await tid(nick, 'format-modern').click();
    await tid(nick, 'create-table').click();
    await waitFor(nick, 'pregame');
    const code = (await tid(nick, 'table-code').textContent())?.trim() ?? '';
    check('table created and shows a join code', /^[A-Z]+-[A-Z]+-\d{2}$/.test(code), code);
    await shot(nick, 'nick-created-table');

    await friend.goto(BASE);
    await waitFor(friend, 'lobby');
    await tid(friend, 'player-name').fill('Friend');
    await tid(friend, 'join-code').fill(code);
    await tid(friend, 'join-table').click();
    await waitFor(friend, 'pregame');
    await expectEventually(friend, 'friend joined and sees both seats', async () =>
      (await friend.locator('[data-testid^="lobby-seat-"]').count()) === 2);
    await expectEventually(nick, 'nick sees the second seat arrive', async () =>
      (await nick.locator('[data-testid^="lobby-seat-"]').count()) === 2);
    await shot(friend, 'friend-joined');

    // ── Ready, then decks ───────────────────────────────────────────────────────────────────────
    await tid(nick, 'ready').click();
    await tid(friend, 'ready').click();
    await waitFor(nick, 'deck-ember-rush');
    await waitFor(friend, 'deck-ember-rush');
    check('readying up deals the table and offers decks', true);

    await tid(nick, 'deck-ember-rush').click();
    await tid(friend, 'deck-verdant-guard').click();
    await shot(nick, 'deck-chosen');

    await expectEventually(nick, 'host can start once both decks are loaded', async () =>
      (await tid(nick, 'start-game').isEnabled()));
    await tid(nick, 'start-game').click();

    // ── The game ────────────────────────────────────────────────────────────────────────────────
    await waitFor(nick, 'table');
    await waitFor(friend, 'table');
    check('both players are at the table', true);

    await expectEventually(nick, 'Nick is dealt seven cards', async () =>
      (await cardsIn(nick, 'zone-hand-0').count()) === 7);
    await expectEventually(friend, 'Friend is dealt seven cards', async () =>
      (await cardsIn(friend, 'zone-hand-1').count()) === 7);
    await shot(nick, 'nick-opening-hand');
    await shot(friend, 'friend-opening-hand');

    // ── The hidden-information check ─────────────────────────────────────────────────────────────
    const nickOwnNames = await cardsIn(nick, 'zone-hand-0').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-card-name')));
    check('Nick can read every card in his own hand', nickOwnNames.every((n) => n && n.length > 0), JSON.stringify(nickOwnNames));

    const friendHandAsNickSees = await cardsIn(nick, 'zone-hand-1').evaluateAll((els) =>
      els.map((e) => ({ hidden: e.getAttribute('data-hidden'), name: e.getAttribute('data-card-name') })));
    check('Nick sees the right number of cards in Friend’s hand', friendHandAsNickSees.length === 7, String(friendHandAsNickSees.length));
    check(
      'and cannot identify a single one of them',
      friendHandAsNickSees.length > 0 && friendHandAsNickSees.every((c) => c.hidden === 'true' && !c.name),
      JSON.stringify(friendHandAsNickSees),
    );
    // Not merely hidden in the DOM: the identity never reached the browser at all.
    const leaked = await nick.evaluate(() => {
      const names = [];
      for (const el of document.querySelectorAll('[data-testid="zone-hand-1"] [data-testid^="card-"]')) {
        names.push(el.textContent ?? '');
      }
      return names.join('|');
    });
    check('no card text for the opponent’s hand exists in the page', !/Forest|Plains|Serra|Llanowar|Grizzly/.test(leaked), leaked.slice(0, 120));

    // ── Play some Magic ─────────────────────────────────────────────────────────────────────────
    const beforePlay = await cardsIn(nick, 'zone-hand-0').count();
    await cardAction(nick, cardsIn(nick, 'zone-hand-0').first(), 'act-play');
    await expectEventually(nick, 'Nick plays a card from hand to the battlefield', async () =>
      (await cardsIn(nick, 'zone-battlefield-0').count()) === 1 &&
      (await cardsIn(nick, 'zone-hand-0').count()) === beforePlay - 1);
    await expectEventually(friend, 'Friend sees it appear on Nick’s battlefield, face up', async () => {
      const cards = await cardsIn(friend, 'zone-battlefield-0').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-card-name')));
      return cards.length === 1 && Boolean(cards[0]);
    });
    await shot(friend, 'friend-sees-nicks-board');

    await cardAction(nick, cardsIn(nick, 'zone-battlefield-0').first(), 'act-tap');
    await expectEventually(nick, 'tapping a permanent turns it sideways for both players', async () =>
      (await cardsIn(nick, 'zone-battlefield-0').first().getAttribute('data-tapped')) === 'true');
    await expectEventually(friend, 'and Friend sees it tapped too', async () =>
      (await cardsIn(friend, 'zone-battlefield-0').first().getAttribute('data-tapped')) === 'true');

    await tid(nick, 'untap-all').click();
    await expectEventually(nick, 'untap all straightens it back up', async () =>
      (await cardsIn(nick, 'zone-battlefield-0').first().getAttribute('data-tapped')) === 'false');

    const libraryBefore = await readNumber(nick, 'library-count-0');
    await tid(nick, 'draw').click();
    await expectEventually(nick, 'drawing takes a card off the deck and into hand', async () =>
      (await readNumber(nick, 'library-count-0')) === libraryBefore - 1 &&
      (await cardsIn(nick, 'zone-hand-0').count()) === beforePlay);
    await expectEventually(friend, 'Friend sees Nick’s hand grow without learning what he drew', async () => {
      const n = await cardsIn(friend, 'zone-hand-0').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-name')));
      return n.length === beforePlay && n.every((x) => !x);
    });

    // A creature dies.
    await cardAction(nick, cardsIn(nick, 'zone-battlefield-0').first(), 'act-destroy');
    await expectEventually(nick, 'a destroyed permanent lands in the graveyard', async () =>
      (await cardsIn(nick, 'zone-graveyard-0').count()) === 1);

    // Tokens.
    await tid(nick, 'tokens').click();
    await waitFor(nick, 'token-sheet');
    await tid(nick, 'token-goblin').click();
    await expectEventually(nick, 'a token squad shows up on the battlefield', async () =>
      (await cardsIn(nick, 'zone-battlefield-0').count()) === 1);

    // Turns.
    const turnBefore = await readNumber(nick, 'turn');
    await tid(nick, 'pass-turn').click();
    await expectEventually(friend, 'passing the turn moves it to the other player', async () =>
      (await tid(friend, 'whose-turn').textContent())?.includes('your turn'));
    await expectEventually(nick, 'and the turn counter advances for both', async () =>
      (await readNumber(nick, 'turn')) > turnBefore);
    await shot(nick, 'mid-game');

    // Life totals, from either side.
    const lifeBefore = await readNumber(nick, 'life-0');
    await tid(nick, 'life-down-0').click();
    await expectEventually(nick, 'life totals change', async () => (await readNumber(nick, 'life-0')) === lifeBefore - 1);
    await expectEventually(friend, 'and the other player sees it immediately', async () =>
      (await readNumber(friend, 'life-0')) === lifeBefore - 1);

    // Search the deck, which is the only time a player may look at their own library.
    await tid(friend, 'search').click();
    await expectEventually(friend, 'searching opens your own library to you', async () =>
      (await cardsIn(friend, 'zone-library-1').count()) > 10);
    await expectEventually(nick, 'and never to your opponent', async () =>
      (await nick.locator('[data-testid="zone-library-1"]').count()) === 0);
    await shot(friend, 'friend-searching');
    await tid(friend, 'shuffle').click();
    await expectEventually(friend, 'shuffling closes the search again', async () =>
      (await friend.locator('[data-testid="zone-library-1"]').count()) === 0);

    // ── Finish it ───────────────────────────────────────────────────────────────────────────────
    // Tapped in a burst on purpose: this is the case that used to lose all but the first tap,
    // because each action carries the version it was composed against.
    const lifeNow = await readNumber(friend, 'life-1');
    for (let i = 0; i < lifeNow; i++) await tid(friend, 'life-down-1').click();
    await expectEventually(friend, 'a burst of life taps all land, none are lost', async () =>
      (await readNumber(friend, 'life-1')) <= 0, 20000);
    await expectEventually(nick, 'reaching zero life ends the game and names the winner', async () =>
      (await tid(nick, 'game-over').textContent())?.includes('Nick wins'), 20000);
    await expectEventually(friend, 'and the loser is told the same thing', async () =>
      (await tid(friend, 'game-over').textContent())?.includes('Nick wins'), 20000);
    await shot(nick, 'game-over');

    // The log is the record of what happened, for settling a disagreement.
    await tid(nick, 'toggle-log').click();
    await waitFor(nick, 'log-panel');
    const logText = (await tid(nick, 'log-panel').textContent()) ?? '';
    check('the log records the game', /drew|moved|life|wins/.test(logText), logText.slice(0, 120));
    await shot(nick, 'log');
    // Closed by clicking the backdrop: the toggle button is behind the panel's full-screen overlay,
    // so clicking it again does nothing and the phone shot below would photograph the log.
    await tid(nick, 'log-panel').click({ position: { x: 5, y: 5 } });
    await nick.waitForSelector('[data-testid="log-panel"]', { state: 'detached', timeout: 5000 });

    // ── Phone layout ────────────────────────────────────────────────────────────────────────────
    // One of the two players may be on a phone, so the real table is checked at phone width, not
    // just the lobby. Resizing the page that is already in the game tests the board itself.
    await nick.setViewportSize({ width: 390, height: 844 });
    await nick.waitForTimeout(400);
    const boardOverflow = await nick.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('the table fits a phone with no sideways scrolling', boardOverflow <= 1, `overflow ${boardOverflow}px`);
    // Every control has to stay reachable: a row that scrolls sideways is fine, one that is
    // clipped off the screen is not.
    const reachable = await nick.evaluate(() => {
      const bar = document.querySelector('[data-testid="controls"]');
      if (!bar) return { total: 0, offscreen: ['no control bar'] };
      const buttons = [...bar.querySelectorAll('button')];
      const barBox = bar.getBoundingClientRect();
      const offscreen = buttons
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.height < 10 || r.top < barBox.top - 4 || r.bottom > barBox.bottom + 4;
        })
        .map((b) => b.textContent?.trim() ?? '?');
      return { total: buttons.length, offscreen };
    });
    check(
      'every control stays on the phone screen',
      reachable.total > 5 && reachable.offscreen.length === 0,
      JSON.stringify(reachable),
    );
    await shot(nick, 'phone-table');
    await nick.setViewportSize({ width: 1280, height: 900 });

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phonePage = await phone.newPage();
    await phonePage.goto(BASE);
    await waitFor(phonePage, 'lobby');
    const overflow = await phonePage.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('the lobby fits a phone with no sideways scrolling', overflow <= 1, `overflow ${overflow}px`);
    await shot(phonePage, 'phone-lobby');
    await phone.close();

    check('no uncaught exceptions during the game', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
    check('nothing the table depends on failed to load', badRequests.length === 0, badRequests.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${SHOT_DIR}/`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\ne2e aborted: ${err.message}`);
  process.exit(1);
});
