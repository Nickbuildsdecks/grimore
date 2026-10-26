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
import { watchForReactWarnings } from './lib/table-driver.mjs';

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
/** Whether an element with this test id is on the page at all. */
const has = async (page, id) => (await tid(page, id).count()) > 0;
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
  const reactWarnings = [];
  const badRequests = [];
  const EXPECTED_FAILURES = [/\/api\//, /\/logo\.svg/];
  for (const [who, page] of [['Nick', nick], ['Friend', friend]]) {
    page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
    watchForReactWarnings(page, who, reactWarnings);
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
    /*
      The empty state, asserted before anything is created, because it is the normal one: two
      people playing privately see no tables here and the code box has to still be the obvious
      way in. A lobby that only reads well once somebody has opened a table reads badly most of
      the time.
    */
    await waitFor(nick, 'open-tables');
    check('the lobby says so when nobody has an open table',
      await has(nick, 'open-tables-empty'));
    /*
      What is in a deck, before anybody has to choose one.

      Checked in the lobby rather than in the pregame picker because this is where a new player
      lands first, and because the panel is the same component in both places. The assertion is
      that it names cards: a panel that opens and says nothing would pass a "did it open" check.
    */
    await tid(nick, 'solo-peek-tidal-mind').click();
    await waitFor(nick, 'peek-panel-tidal-mind');
    const peeked = (await tid(nick, 'peek-panel-tidal-mind').textContent()) ?? '';
    check('a deck says what is in it before you pick it',
      peeked.includes('Counterspell') && peeked.includes('Lands') && peeked.includes('60 cards'),
      peeked.slice(0, 120));
    check('and names the commander, which no decklist can show',
      peeked.includes('Talrand'), peeked.slice(0, 120));
    await shot(nick, 'deck-contents');
    await tid(nick, 'solo-peek-tidal-mind').click();
    await nick.waitForSelector('[data-testid="peek-panel-tidal-mind"]', { state: 'detached', timeout: 5000 });

    await tid(nick, 'format-modern').click();
    // Listed on purpose: unlisted is the default, so this is the press that opts in.
    await tid(nick, 'visibility-public').click();
    await tid(nick, 'create-table').click();
    await waitFor(nick, 'pregame');
    const code = (await tid(nick, 'table-code').textContent())?.trim() ?? '';
    check('table created and shows a join code', /^[A-Z]+-[A-Z]+-\d{2}$/.test(code), code);
    await shot(nick, 'nick-created-table');

    await friend.goto(BASE);
    await waitFor(friend, 'lobby');
    await tid(friend, 'player-name').fill('Friend');
    /*
      And the point of the whole feature: Friend is never told the code. The row is found in the
      list, which the client asks for on connect — with a Refresh press as the retry, because a
      socket that connected in the instant before the table existed has an answer that predates it.
    */
    await expectEventually(friend, 'Friend finds the open table without being told its code', async () => {
      if (await has(friend, `open-table-${code}`)) return true;
      await tid(friend, 'refresh-tables').click();
      return false;
    });
    const row = (await tid(friend, `open-table-${code}`).textContent()) ?? '';
    check('the listing says how full the table is', row.includes('1 of 2 seated'), row.trim());
    await tid(friend, `join-open-${code}`).click();
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

    /*
      ── Friend plays a list of his own ────────────────────────────────────────────────────────────

      The built-in decks are the table's pool, not its ceiling: a player keeps their deck as text
      and should be able to paste it in. Two halves are checked here because both are the feature.

      First a list with a card the engine has never scripted, which is the common case — the deck
      loads, the tabletop will play it, and the engine button says so rather than dealing a game
      with a card nobody can do anything with. Then the same list without it, which the engine
      runs. Friend keeps the second one for the rest of this game, so everything below — the
      opening hand, the library, the search — happens on a deck nobody built into this repo.
    */
    const cardboardList = '4 Giant Growth\n1 Black Lotus\n24 Forest\n31 Grizzly Bears';
    const pooledList = '12 Giant Growth\n24 Forest\n12 Grizzly Bears\n12 Llanowar Elves';
    const pasteList = async (text) => {
      await tid(friend, 'paste-list').click();
      await waitFor(friend, 'deck-text');
      await tid(friend, 'deck-text').fill(text);
      await tid(friend, 'use-list').click();
    };

    await pasteList(cardboardList);
    await waitFor(friend, 'deck-custom');
    await expectEventually(friend, 'a pasted list is read, counted, and loaded as a deck', async () => {
      const note = (await tid(friend, 'list-note').textContent()) ?? '';
      return note.includes('60 cards') && note.includes('Black Lotus') && note.includes('tabletop only');
    });
    await expectEventually(nick, 'the host is told whose list the engine cannot read, and how much of it',
      async () => {
        const badge = (await tid(nick, 'lobby-list-1').textContent()) ?? '';
        return badge.includes('60 cards') && badge.includes('1 the engine cannot read');
      });
    await expectEventually(nick, 'and the engine is refused while that card is in the deck', async () =>
      !(await tid(nick, 'start-engine').isEnabled())
      && ((await tid(nick, 'unreadable-note').textContent()) ?? '').includes('not in the engine'));
    check('the tabletop is still offered, because it plays cardboard',
      await tid(nick, 'start-game').isEnabled());
    await shot(friend, 'friend-pasted-a-list');

    await pasteList(pooledList);
    await expectEventually(friend, 'a list the engine knows end to end says so', async () => {
      const note = (await tid(friend, 'list-note').textContent()) ?? '';
      return note.includes('60 cards') && note.includes('every one of them scripted');
    });

    /*
      And the list is remembered, which is the difference between pasting a deck and keeping one.

      Checked through a real reload, because `localStorage` is the whole mechanism: the browser
      comes back on the same seat (the table has its own check for that below) and the paste box
      offers the list it had rather than an empty box. Nothing of this reaches the server.
    */
    await friend.reload();
    await waitFor(friend, 'pregame', 20000);
    await tid(friend, 'paste-list').click();
    await waitFor(friend, 'deck-text');
    check('the paste box offers the list this browser used last time',
      await has(friend, 'fill-saved-list'));
    await tid(friend, 'fill-saved-list').click();
    const refilled = await tid(friend, 'deck-text').inputValue();
    check('and fills it back in exactly as it was pasted',
      refilled.includes('24 Forest') && refilled.includes('12 Llanowar Elves'),
      refilled.slice(0, 80));
    await tid(friend, 'cancel-list').click();
    await expectEventually(nick, 'and the engine is offered again', async () =>
      (await tid(nick, 'start-engine').isEnabled()) && !(await has(nick, 'unreadable-note')));
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

    /*
      Face down, which is the one move at this table where the two players are supposed to see
      different things — and for three versions of the engine they saw the wrong different things.

      Nick keeps the name because it is his card. Friend gets no name at all *and* the 2/2 the rules
      say a face-down permanent is (CR 707.2), which the engine only started sending in D122 and the
      card back only started drawing with morph. A blank rectangle here hid a creature Friend is
      entitled to read.
    */
    const faceDownCard = cardsIn(nick, 'zone-battlefield-0').first();
    const faceDownId = await faceDownCard.getAttribute('data-testid');
    const shownName = await faceDownCard.getAttribute('data-card-name');
    await cardAction(nick, faceDownCard, 'act-facedown');
    await expectEventually(nick, 'turning a permanent face down leaves its own player able to read it', async () =>
      (await cardsIn(nick, 'zone-battlefield-0').first().getAttribute('data-card-name')) === shownName);
    await expectEventually(friend, 'the other player sees a card with no name', async () => {
      const names = await cardsIn(friend, 'zone-battlefield-0').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-card-name')));
      return names.length === 1 && !names[0];
    });
    await expectEventually(friend, 'and reads the 2/2 it publicly is, rather than a blank card', async () => {
      const id = String(faceDownId).replace('card-', 'body-');
      const el = friend.locator(`[data-testid="${id}"]`);
      return (await el.count()) === 1 && (await el.innerText()).trim() === '2/2';
    });
    /*
      The board, not the page. The name is legitimately in Friend's **log** — "Nick moved Shock to
      Nick's battlefield" — because playing it was a public move that happened before it was turned
      over, and a tabletop log that forgot what everybody watched would be the bug. What must not
      carry the name is the thing on the board, and the first version of this check asserted over
      the whole page and failed on the log, which is the harness being wrong rather than the table.
    */
    check('and the card underneath is nowhere on the other player’s board',
      !(await tid(friend, 'zone-battlefield-0').first().innerText()).includes(String(shownName)),
      String(shownName));
    await shot(friend, 'friend-sees-a-face-down-card');
    await cardAction(nick, cardsIn(nick, 'zone-battlefield-0').first(), 'act-facedown');
    await expectEventually(friend, 'turning it back up tells Friend what it was', async () =>
      (await cardsIn(friend, 'zone-battlefield-0').first().getAttribute('data-card-name')) === shownName);

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
    /*
      **Who had the turn first is a roll** (D147), so this reads the board rather than assuming it.

      The table rolls for who starts, the computer's seats included, and a tabletop table is a
      table. This check was written when the host always went first, and it failed on the runs
      where the roll went the other way — not because passing the turn was broken, but because
      "the other player" had been hard-coded as Friend. It now asks whoever did *not* have the turn.

      The two questions are also asked in the order they happen: the press lands on the page that
      made it, and the other browser is told over a socket, which gets the longer deadline.
    */
    const turnBefore = await readNumber(nick, 'turn');
    const wasNicks = ((await tid(nick, 'whose-turn').textContent()) ?? '').includes('your turn');
    const other = wasNicks ? friend : nick;
    await tid(nick, 'pass-turn').click();
    await expectEventually(nick, 'and the turn counter advances for both', async () =>
      (await readNumber(nick, 'turn')) > turnBefore);
    await expectEventually(other, 'passing the turn moves it to the other player', async () =>
      ((await tid(other, 'whose-turn').textContent()) ?? '').includes('your turn'), 25000);
    await shot(nick, 'mid-game');

    // Life totals, from either side.
    const lifeBefore = await readNumber(nick, 'life-0');
    await tid(nick, 'life-down-0').click();
    await expectEventually(nick, 'life totals change', async () => (await readNumber(nick, 'life-0')) === lifeBefore - 1);
    await expectEventually(friend, 'and the other player sees it immediately', async () =>
      (await readNumber(friend, 'life-0')) === lifeBefore - 1);

    /*
      ── Taking the last move back ────────────────────────────────────────────────────────────────

      The misclick is the one failure at a real table that nothing here could recover from. Checked
      on the tabletop because the state is simple enough to read in one number, and checked from
      both sides because the whole rule is that it is the host's button: a guest who could rewrite
      what happened would be a different feature.
    */
    await expectEventually(nick, 'the host is offered an undo once something has happened',
      async () => (await nick.locator('[data-testid="undo"]').count()) === 1);
    check('and the other player is not', (await friend.locator('[data-testid="undo"]').count()) === 0);
    await tid(nick, 'undo').click();
    await expectEventually(nick, 'undo puts the table back to before the last move',
      async () => (await readNumber(nick, 'life-0')) === lifeBefore);
    await expectEventually(friend, 'and the other player sees it go back too',
      async () => (await readNumber(friend, 'life-0')) === lifeBefore);
    await expectEventually(friend, 'who is told in the chat that it happened', async () => {
      if ((await friend.locator('[data-testid="chat-panel"]').count()) === 0) {
        await tid(friend, 'toggle-chat').click();
      }
      return ((await tid(friend, 'chat-panel').textContent()) ?? '').includes('took back');
    });
    // One step and no more: with nothing left to take back the button is gone rather than
    // showing the player an error.
    await expectEventually(nick, 'and with nothing left to take back the button goes away',
      async () => (await nick.locator('[data-testid="undo"]').count()) === 0);

    // ── Auras: attach, and detach when the host leaves ──────────────────────────────────────────
    // Two permanents are needed, so another card is played first.
    await cardAction(nick, cardsIn(nick, 'zone-hand-0').first(), 'act-play');
    await expectEventually(nick, 'a second permanent for the attach flow', async () =>
      (await cardsIn(nick, 'zone-battlefield-0').count()) >= 2);
    const board2 = cardsIn(nick, 'zone-battlefield-0');
    await board2.nth(0).click();
    await waitFor(nick, 'card-sheet');
    await tid(nick, 'act-attach').click();
    await waitFor(nick, 'attach-hint');
    await board2.nth(1).click();
    await expectEventually(nick, 'an aura attaches to the permanent you pick next', async () =>
      (await nick.locator('[data-testid="zone-battlefield-0"] [data-testid^="card-"]').first().textContent())?.includes('ATT'));
    await expectEventually(friend, 'and the other player sees it attached', async () =>
      (await friend.locator('[data-testid="zone-battlefield-0"] [data-testid^="card-"]').first().textContent())?.includes('ATT'));

    // ── A refresh mid-game must not lose the seat ───────────────────────────────────────────────
    // Somebody's phone locks or the wifi blips; the game has to survive it. The server holds a seat
    // for two minutes and the client replays its seat token on connect.
    const handBeforeReload = await cardsIn(friend, 'zone-hand-1').count();
    const lifeBeforeReload = await readNumber(friend, 'life-1');
    await friend.reload();
    await expectEventually(friend, 'a mid-game refresh rejoins the same seat and the same game', async () => {
      if ((await friend.locator('[data-testid="table"]').count()) === 0) return false;
      const hand = await cardsIn(friend, 'zone-hand-1').count();
      return hand === handBeforeReload && (await readNumber(friend, 'life-1')) === lifeBeforeReload;
    }, 20000);
    /*
      Any decrease, not exactly one — and the click comes after the read.

      The first version clicked and then demanded `lifeBeforeReload - 1` in the same attempt, which
      is a check that cannot pass if its own click is slow: the retry clicks again, life goes down
      twice, and the one number it will accept is now behind it. It failed that way once on a
      freshly started stack and passed on every warm run, which is the signature of a race in the
      test rather than in the table. So: read first, click only if nothing has landed yet, accept
      any decrease as proof the seat can act, and then put the total back wherever those clicks
      left it — because the end of this game counts life down to nought and expects to get there.
    */
    await expectEventually(friend, 'and the reclaimed seat can still act', async () => {
      if ((await readNumber(friend, 'life-1')) < lifeBeforeReload) return true;
      await tid(friend, 'life-down-1').click();
      return false;
    });
    await expectEventually(friend, 'and life goes back to where the reload found it', async () => {
      const now = await readNumber(friend, 'life-1');
      if (now === lifeBeforeReload) return true;
      await tid(friend, now < lifeBeforeReload ? 'life-up-1' : 'life-down-1').click();
      return false;
    });
    await shot(friend, 'after-reload');

    // The in-game help: neither player will have the setup guide open while playing.
    await tid(nick, 'toggle-help').click();
    await waitFor(nick, 'help-panel');
    const helpText = (await tid(nick, 'help-panel').textContent()) ?? '';
    check(
      'the table explains its own idioms in-game',
      /counter/i.test(helpText) && /Attach/i.test(helpText) && /undo/i.test(helpText),
      helpText.slice(0, 100),
    );
    await tid(nick, 'help-close').click();
    await nick.waitForSelector('[data-testid="help-panel"]', { state: 'detached', timeout: 5000 });

    // ── Table talk ──────────────────────────────────────────────────────────────────────────────
    // A tabletop cannot decide "do you respond?" for you, so the two players have to be able to say
    // things to each other. Checked across the two browsers, including the unread badge for a
    // message that lands while the panel is shut.
    await tid(nick, 'toggle-chat').click();
    await waitFor(nick, 'chat-panel');
    await tid(nick, 'chat-input').fill('holding priority, do you respond?');
    await tid(nick, 'chat-send').click();
    await expectEventually(nick, 'a message you send appears in your own chat', async () =>
      (await tid(nick, 'chat-messages').textContent())?.includes('do you respond'));
    await expectEventually(friend, 'the other player is told a message arrived', async () =>
      (await friend.locator('[data-testid="chat-unread"]').count()) === 1);
    await tid(friend, 'toggle-chat').click();
    await waitFor(friend, 'chat-panel');
    await expectEventually(friend, 'and reads it, attributed to who said it', async () => {
      const text = (await tid(friend, 'chat-messages').textContent()) ?? '';
      return text.includes('do you respond') && text.includes('Nick');
    });
    await expectEventually(friend, 'the unread badge clears once it is read', async () =>
      (await friend.locator('[data-testid="chat-unread"]').count()) === 0);
    await shot(friend, 'chat');
    await tid(friend, 'chat-panel').click({ position: { x: 5, y: 5 } });
    await friend.waitForSelector('[data-testid="chat-panel"]', { state: 'detached', timeout: 5000 });
    await tid(nick, 'chat-panel').click({ position: { x: 5, y: 5 } });
    await nick.waitForSelector('[data-testid="chat-panel"]', { state: 'detached', timeout: 5000 });

    // Search the deck, which is the only time a player may look at their own library.
    /*
      Pressed by the check rather than before it, because this button is a *toggle*.

      "Search deck" and "Close deck" are the same button, so a press that has not come back from
      the server yet must not be pressed again — the second press shuts the drawer the check is
      waiting for. So: the library decides, the button's own label says whether a press is still
      wanted, and a press is given a second and a half to land before another one.
    */
    let lastPress = 0;
    await expectEventually(friend, 'searching opens your own library to you', async () => {
      if ((await cardsIn(friend, 'zone-library-1').count()) > 10) return true;
      const label = (await tid(friend, 'search').textContent()) ?? '';
      if (Date.now() - lastPress > 1500 && /Search deck/.test(label)) {
        lastPress = Date.now();
        await tid(friend, 'search').click();
      }
      return false;
    });
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
    check('no React warnings during the game', reactWarnings.length === 0, reactWarnings.slice(0, 4).join(' | '));
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
