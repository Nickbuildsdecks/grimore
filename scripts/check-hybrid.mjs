/**
 * Hybrid automation, in two real browsers: the engine plays the cards it can read, and the ones it
 * cannot are flagged for moving by hand.
 *
 * This is the check for the decision in **D362**, and it is the one that matters most as the card
 * pool grows from 348 hand-scripted cards towards every card ever printed. Until that change, one
 * unreadable card in a pasted deck dropped the whole table out of automation; now the game is dealt
 * and that card carries a badge. Everything about whether this project can be *played* with a real
 * Commander deck before coverage is complete rests on it working.
 *
 * ## Its own script, and the reason is the same one `check-table-controls.mjs` gives
 *
 * It starts the rules engine on a deliberately broken deck, which changes what the table **is**. A
 * failure inside `e2e-table.mjs` would leave that suite's remaining seventy-odd checks reading a
 * different game, which is how a real failure turns into a page of noise.
 *
 * ## What it asserts, and why it needs two tables rather than one
 *
 * Table one, a deck that is all real cards bar one:
 *   1. the host is told, in the lobby, that one card cannot be read
 *   2. the engine is offered anyway, and starting it deals the game
 *   3. the log names the card and says to move it by hand
 *   4. **and the engine is really running the rest of the deck**
 *
 * Table two, a deck of which the engine can read nothing at all:
 *   5. the plural half of that same lobby copy, which nothing else exercises
 *   6. the engine still deals the game
 *   7. **and the cards themselves are badged "move by hand" in the hand holding them**
 *
 * (4) is the check that stops the others from being a green light on a broken game: without it the
 * first three would pass on a table that started automation and then did nothing, which is not
 * hybrid mode, it is a worse tabletop with a badge on it. It is checked by asking the engine for a
 * move and making it, because an automated table that offers no moves is the failure being hunted.
 *
 * (7) is why there is a second table, and the reason is worth writing down because the first
 * version of this script got it wrong. A badge only renders on a card the page is drawing, and a
 * deck's library draws nothing — so with one unreadable card in sixty, the badge was absent about
 * seven times in eight *on a working build*. That is a check whose result is a fact about the
 * shuffle. A deck the engine cannot read at all fixes it by construction: every one of the seven
 * cards dealt to that hand is unreadable, so a build that badges them cannot miss, and a build that
 * does not cannot pass. The two decks are not redundant — one proves the engine keeps playing, the
 * other proves the marking is visible — and neither can carry both claims on its own.
 *
 * Run it:
 *   PLAY_HOST=127.0.0.1 node scripts/play.mjs &
 *   node scripts/check-hybrid.mjs          # or: pnpm play:e2e:hybrid
 */
import path from 'node:path';
import {
  chromium, check, setShotDir, summarize, shot, waitFor, tid, has, text,
  watchForReactWarnings, isMyMove, makeMove, expectEventually,
} from './lib/table-driver.mjs';

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'hybrid');
const HEADED = process.env.HEADED === '1';

/**
 * A sixty-card deck that is all real cards bar one.
 *
 * `Nonsense Card` is not a card and never will be, which is what makes it a safe fixture: a name
 * the pool might acquire later would make this check quietly stop testing anything. The rest are
 * pool cards, so the engine can genuinely play fifty-nine sixtieths of this deck — the mix is the
 * point, since a deck of nothing but unreadable cards would prove only that the engine starts.
 *
 * Four lines of forty or fewer, because `DECKLIST_LIMITS.maxPerLine` is 40.
 */
const MOSTLY_REAL = ['24 Mountain', '20 Forest', '15 Grizzly Bears', '1 Nonsense Card'].join('\n');

/**
 * A sixty-card deck of which the engine can read nothing.
 *
 * Two names rather than one because `maxPerLine` is 40, and it is the stronger fixture for that:
 * `manualCards` deduplicates by name, so a two-name deck also checks that both names survive into
 * the view rather than one standing in for the deck.
 */
const NOTHING_REAL = ['30 Mystery Alpha', '30 Mystery Beta'].join('\n');

/** Waits without recording a check, so the caller words its own failure. */
async function until(page, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch { /* keep waiting */ }
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(150);
  }
}

/**
 * Two fresh browser contexts sat down at one new table, both ready, deck controls on screen.
 *
 * Fresh contexts per table rather than leaving and re-joining: a seat that has already started the
 * engine is in the middle of a game, and walking it back to the lobby is a different feature's
 * path. Two contexts in the same browser costs almost nothing.
 */
async function sitDown(browser, pageErrors, reactWarnings, label) {
  const pages = [];
  for (const who of [`${label} host`, `${label} guest`]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
    watchForReactWarnings(page, who, reactWarnings);
    pages.push(page);
  }
  const [host, guest] = pages;

  await host.goto(BASE);
  await waitFor(host, 'lobby');
  await tid(host, 'player-name').fill('Nick');
  await tid(host, 'visibility-public').click();
  await tid(host, 'create-table').click();
  await waitFor(host, 'pregame');
  const code = ((await tid(host, 'table-code').textContent()) ?? '').trim();

  await guest.goto(BASE);
  await waitFor(guest, 'lobby');
  await tid(guest, 'player-name').fill('Ana');
  await until(guest, async () => has(guest, `open-table-${code}`), 20000);
  await tid(guest, `join-open-${code}`).click();
  await waitFor(guest, 'pregame');

  /*
    Both ready up first, and that order is not optional: **readying is what deals the table**, and
    the deck-picking controls do not exist until it has been dealt. The first version of this
    script reached for `paste-list` straight after joining and timed out on a lobby whose only
    controls were `ready` and `leave-table` — which is the lobby behaving correctly.
  */
  await tid(host, 'ready').click();
  await tid(guest, 'ready').click();
  await waitFor(host, 'deck-ember-rush');
  await waitFor(guest, 'deck-ember-rush');
  return { host, guest };
}

/** Loads a pasted list on one seat, and a built-in deck on the other. */
async function pasteOn(paster, picker, list) {
  await tid(paster, 'paste-list').click();
  await waitFor(paster, 'deck-text');
  await tid(paster, 'deck-text').fill(list);
  await tid(paster, 'use-list').click();
  await waitFor(paster, 'deck-custom');
  await tid(picker, 'deck-ember-rush').click();
}

/** Presses whatever the engine offers whichever seat is on the clock, up to `want` times. */
async function playOn(pages, want) {
  let moves = 0;
  for (let i = 0; i < 24 && moves < want; i++) {
    for (const page of pages) {
      if (await isMyMove(page)) {
        await makeMove(page);
        moves += 1;
      }
    }
    await pages[0].waitForTimeout(200);
  }
  return moves;
}

/** Table one: a deck the engine can almost entirely read. */
async function mostlyReadableTable(browser, pageErrors, reactWarnings) {
  const { host, guest } = await sitDown(browser, pageErrors, reactWarnings, 'A');

  // The guest brings the broken deck; the host brings a built-in one, so the only unreadable
  // card at the table belongs to a known seat.
  await pasteOn(guest, host, MOSTLY_REAL);

  await expectEventually(host, 'the host is told the engine cannot read one card', async () =>
    ((await text(host, 'unreadable-note')) ?? '').includes('does not know 1 card'));
  await shot(host, 'lobby-with-one-unreadable');

  // The engine starts. This is the whole of what D362 changed.
  await expectEventually(host, 'the engine is offered despite that card', async () =>
    tid(host, 'start-engine').isEnabled());
  await tid(host, 'start-engine').click();
  const dealt = await until(host, async () => has(host, 'arena-bar'), 25000);
  check('the rules engine takes over a table holding a card it cannot read', dealt,
    dealt ? '' : `no arena bar; table says: ${await text(host, 'table-error')}`);
  await shot(host, 'engine-running-hybrid');

  // The log names it, on the line that says the engine took over.
  const said = await until(host, async () => {
    const log = (await text(host, 'table-feed')) ?? '';
    return log.includes('Nonsense Card') && log.includes('by hand');
  }, 15000);
  check('and the log names the card and says to move it by hand', said,
    said ? '' : `feed read: ${((await text(host, 'table-feed')) ?? '').slice(0, 300)}`);

  /*
    And the engine is really running the rest of the deck.

    The check that stops the three above from being a green light on a broken game. `makeMove`
    presses whatever the engine is offering the seat on the clock — a mulligan decision first,
    then a real turn — so a table that has started automation and offers nothing fails here, and
    only here.
  */
  const moves = await playOn([host, guest], 4);
  check('and the engine is running the rest of the deck: it offered and took real moves',
    moves >= 4, `took ${moves} of the 4 moves asked for`);
  await shot(host, 'hybrid-game-in-progress');
}

/** Table two: a deck the engine can read nothing of, which is where the badge is deterministic. */
async function unreadableTable(browser, pageErrors, reactWarnings) {
  const { host, guest } = await sitDown(browser, pageErrors, reactWarnings, 'B');

  // The host pastes this one, so the hand the badges have to appear in is the host's own.
  await pasteOn(host, guest, NOTHING_REAL);

  await expectEventually(host, 'the plural half of the lobby copy reads for a two-name deck',
    async () => ((await text(host, 'unreadable-note')) ?? '').includes('does not know 2 cards'));

  await expectEventually(host, 'the engine is offered on a deck it can read nothing of', async () =>
    tid(host, 'start-engine').isEnabled());
  await tid(host, 'start-engine').click();
  const dealt = await until(host, async () => has(host, 'arena-bar'), 25000);
  check('the rules engine takes over a table whose whole deck is unreadable', dealt,
    dealt ? '' : `no arena bar; table says: ${await text(host, 'table-error')}`);

  /*
    The cards are badged where their owner will look for them.

    Searched across the whole page rather than inside the hand zone, because `cardBadges` puts the
    badge in every zone deliberately: a card moved by hand onto the battlefield is still a card the
    engine is not running, and still has to say so. Deterministic here and nowhere else — see this
    file's header for why the one-unreadable-card deck could not carry this check.
  */
  const badged = await until(host, async () =>
    (await host.locator('text=move by hand').count()) > 0
    || (await host.locator('[data-testid^="badges-"]:has-text("move by hand")').count()) > 0,
    15000);
  check('every card in that hand is badged "move by hand"', badged,
    badged ? '' : 'no badge anywhere on the page holding seven unreadable cards');
  await shot(host, 'all-unreadable-badged');
}

async function main() {
  setShotDir(SHOT_DIR);
  const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox'] });
  const pageErrors = [];
  const reactWarnings = [];
  try {
    await mostlyReadableTable(browser, pageErrors, reactWarnings);
    await unreadableTable(browser, pageErrors, reactWarnings);
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('no React warnings', reactWarnings.length === 0, reactWarnings.join(' | '));
  } finally {
    await browser.close();
  }
  return summarize();
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((err) => {
  console.error(err);
  process.exit(1);
});
