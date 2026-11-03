/**
 * The four tabletop controls that no check had ever pressed.
 *
 * `scripts/surface-coverage.mjs` asks which rendered controls no suite even names. Four of its
 * answers are things two people would reach for on the night, and all four are here:
 *
 *   roll            the d6, for who goes first and for everything else a table rolls for
 *   hand-to-engine  hand a game started by hand to the rules engine
 *   new-game        empty the table back to unstarted, when somebody is changing deck
 *   leave-table     get up
 *
 * **Its own script, not a block in `e2e-table.mjs`.** Two of these change what the table *is*, so
 * a failure here would leave that suite's remaining 70-odd checks reading a different game. The
 * first attempt did exactly that, and the same attempt is why each assertion below says what it
 * found rather than that it did not find what it wanted.
 *
 * Three wrong guesses went into this file before it worked, each recorded where it was made:
 * the d6 is not in the feed, the engine will not start on a finished game, and a reset clears the
 * decks along with the board.
 *
 * Run it:
 *   PLAY_HOST=127.0.0.1 node scripts/play.mjs &
 *   node scripts/check-table-controls.mjs
 */
import path from 'node:path';
import {
  chromium, check, setShotDir, summarize, shot, waitFor, tid, has, cardsIn,
  watchForReactWarnings, isMyMove, makeMove, readNumber,
} from './lib/table-driver.mjs';

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'controls');
const HEADED = process.env.HEADED === '1';

/** Waits without recording a check, so the caller can put the reason in the failure message. */
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

/** Whatever the table is complaining about, or nothing. */
const complaint = async (page) =>
  ((await has(page, 'table-error')) ? ((await tid(page, 'table-error').textContent()) ?? '') : '(nothing)').trim();

async function main() {
  setShotDir(SHOT_DIR);
  const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox'] });
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const pageErrors = [];
  const reactWarnings = [];
  for (const [who, page] of [['Host', host], ['Guest', guest]]) {
    page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
    watchForReactWarnings(page, who, reactWarnings);
  }

  try {
    await host.goto(BASE);
    await waitFor(host, 'lobby');
    await tid(host, 'player-name').fill('Nick');
    /*
      Commander, not Modern, and for two reasons.

      It is the format this project is built around ("Casual Commander First"), so it is the table
      two people are most likely to sit at. And `cmd-dmg-*` — the commander-damage counter — is a
      **button** only when the format is Commander, the seat is somebody else's, and the table is
      being tracked by hand; on your own seat it renders as a read-only span with the same testid,
      which is part of why the audit's control/passive split found it confusing. A Modern table
      cannot reach it at all.
    */
    await tid(host, 'format-commander').click();
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
      ── Watching from the listing, and stopping ──────────────────────────────────────────────────

      There are two doors into watching: the code box (`watch-table`, which `e2e-arena` presses)
      and the **Watch** button beside an open table in the lobby list (`watch-open-<code>`), which
      nothing had ever pressed. The way out, `stop-watching`, had never been pressed either — so a
      spectator could get in but no check had ever seen one leave.

      **Before either player readies up, because that is the only time this door exists.**
      `listPublic` lists a pod only while its status is `lobby`, and *readying deals the table* — so
      it drops off the lobby list one step earlier than I assumed twice: not at "start game" but at
      "ready" — the first version of this watched after the hand-over and failed with "a public table
      in the lobby offers itself to be watched", which was true: it no longer did. Watching a game
      *in progress* is the code box's job (`watch-table`, which `e2e-arena` covers). Whether a game
      in progress should be findable from the lobby at all is a product question and is left as
      one; see D328.

      What a watcher may see is `e2e-arena`'s claim and is not re-made here. This is about the door.
    */
    const watcherCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const watcher = await watcherCtx.newPage();
    watcher.on('pageerror', (err) => pageErrors.push(`Watcher: ${err.message}`));
    watchForReactWarnings(watcher, 'Watcher', reactWarnings);
    await watcher.goto(BASE);
    await waitFor(watcher, 'lobby');
    await tid(watcher, 'player-name').fill('Nosy');
    const listed = await until(watcher, async () => {
      if (await has(watcher, `watch-open-${code}`)) return true;
      // The listing is a snapshot, so ask for a fresh one rather than waiting out the check.
      if (await has(watcher, 'refresh-tables')) await tid(watcher, 'refresh-tables').click();
      return false;
    }, 25000);
    check('a public table in the lobby offers itself to be watched', listed);
    if (listed) {
      await tid(watcher, `watch-open-${code}`).click();
      /*
        `watching-waiting`, not `watching-code`: the second is the dealt-table watcher header, and
        this door only opens before the table is dealt, so what the press lands on is the waiting
        screen — "Waiting for the table to deal. Nothing is being hidden from you that the players
        can see." Which is good behaviour, and was being read as a blank page by a check looking
        for the wrong element. Neither that screen nor its Stop button had a testid until now,
        which is why the audit could not see them either.
      */
      const landed = await until(watcher, async () => has(watcher, 'watching-waiting'), 20000);
      const where = [];
      for (const id of ['watching-waiting', 'watching-code', 'table', 'pregame', 'lobby', 'connecting', 'table-error']) {
        if (await has(watcher, id)) where.push(id);
      }
      const onScreen = ((await watcher.locator('body').textContent()) ?? '').replace(/\s+/g, ' ').trim();
      check('and watching from the listing puts a spectator at the table', landed,
        `landed on: ${where.join(', ') || '(no known screen)'}; the page reads: "${onScreen.slice(0, 180)}"`);
      await shot(watcher, 'watching-from-the-listing');
      if (await has(watcher, 'stop-watching')) {
        await tid(watcher, 'stop-watching').click();
        check('and "Stop watching" puts them back in the lobby',
          await until(watcher, async () => has(watcher, 'lobby'), 20000));
      } else {
        check('and "Stop watching" is offered to a spectator', false,
          `no stop-watching; the watcher is on: ${where.join(', ')}`);
      }
    }
    await watcherCtx.close();

    await tid(host, 'ready').click();
    await tid(guest, 'ready').click();
    await waitFor(host, 'deck-ember-rush', 20000);
    await waitFor(guest, 'deck-ember-rush', 20000);
    await tid(host, 'deck-ember-rush').click();
    await tid(guest, 'deck-verdant-guard').click();
    await waitFor(host, 'start-game', 20000);
    await tid(host, 'start-game').click();
    await waitFor(host, 'table', 25000);
    await waitFor(guest, 'table', 25000);
    check('a tabletop game is dealt for two people', (await cardsIn(host, 'zone-hand-0').count()) > 0);

    /*
      ── Life, upwards ────────────────────────────────────────────────────────────────────────────

      `e2e-table` presses `life-down-0` and nothing had ever pressed `life-up-*` — so the control
      a player uses for every Thragtusk, every lifelink hit and every "wait, undo that" had been
      read by checks and never clicked. Found only once the audit learned to follow a prefix
      selector into a tap, which cut its false-alarm list from 23 to 12 and left this standing.

      Both directions, and read from the other player's screen as well, because a life total that
      only moves locally is the oldest bug in a tracker.
    */
    const lifeBefore = await readNumber(host, 'life-0');
    await tid(host, 'life-up-0').click();
    check('life goes up, and the other player sees it',
      await until(guest, async () => (await readNumber(guest, 'life-0')) === lifeBefore + 1, 20000),
      `host read ${lifeBefore}, guest reads ${await readNumber(guest, 'life-0')}`);
    await tid(host, 'life-down-0').click();
    check('and back down again',
      await until(guest, async () => (await readNumber(guest, 'life-0')) === lifeBefore, 20000));

    /*
      ── Commander damage, by hand ────────────────────────────────────────────────────────────────

      Twenty-one from one commander is a way to lose that only this counter records on a tabletop,
      and nothing had ever pressed it. Pressed on the *other* seat, because that is the only seat
      it is a button on: your own reads back what others have dealt you.
    */
    const cmdBefore = ((await tid(host, 'cmd-dmg-1').textContent()) ?? '').trim();
    await tid(host, 'cmd-dmg-1').click();
    /*
      Two elements, and the first version of this read the wrong one.

      `cmd-dmg-<seat>` on an opponent's row is what *you* record — damage your commander dealt
      them. `cmd-taken-<seat>` on **your own** row is what you read: the worst single commander's
      damage against you and whose it is, because "cmd 7/0/14" tells a player nothing they can act
      on (CR 903.10 is per-commander). So the host presses the first and the guest reads the
      second, which also renders only once there is damage to show — a good assertion, since it is
      absent until the press lands.
    */
    check('commander damage can be counted by hand, and the player taking it sees whose it is',
      await until(guest, async () => {
        if (!(await has(guest, 'cmd-taken-1'))) return false;
        return /cmd taken 1\b/.test(((await tid(guest, 'cmd-taken-1').textContent()) ?? ''));
      }, 20000),
      `host read "${cmdBefore}" before; the guest's own row now reads "${
        (await has(guest, 'cmd-taken-1')) ? ((await tid(guest, 'cmd-taken-1').textContent()) ?? '').trim() : '(no cmd-taken row)'
      }"`);

    /*
      ── The d6 ───────────────────────────────────────────────────────────────────────────────────

      Read out of the log, not off the table. `TableFeed` is a transient overlay of notable lines
      that renders nothing at all when there are none, so the first version of this waited thirty
      seconds for an element that is absent by design — and reported it as the d6 not working.
    */
    await tid(host, 'roll').click();
    await tid(host, 'toggle-log').click();
    await waitFor(host, 'log-panel');
    const hostLog = (await tid(host, 'log-panel').textContent()) ?? '';
    check('rolling a d6 is recorded where the table can read it', /rolled/i.test(hostLog), hostLog.slice(0, 160));
    const result = /rolled 1d6: (\d)/.exec(hostLog)?.[1];
    check('and the log says what it came up', result !== undefined && Number(result) >= 1 && Number(result) <= 6,
      `read "${result}" out of: ${hostLog.slice(0, 120)}`);
    await tid(host, 'log-panel').click({ position: { x: 5, y: 5 } });
    await host.waitForSelector('[data-testid="log-panel"]', { state: 'detached', timeout: 5000 });

    await tid(guest, 'toggle-log').click();
    await waitFor(guest, 'log-panel');
    const guestLog = (await tid(guest, 'log-panel').textContent()) ?? '';
    check('and the other player sees the same roll', result !== undefined && guestLog.includes(`rolled 1d6: ${result}`),
      guestLog.slice(0, 160));
    await tid(guest, 'log-panel').click({ position: { x: 5, y: 5 } });
    await guest.waitForSelector('[data-testid="log-panel"]', { state: 'detached', timeout: 5000 });

    /*
      ── Handing a game played by hand to the rules engine ────────────────────────────────────────

      On a *live* table, which is the correction that made this work: `startAutomation` refuses on a
      finished game ("deal the table first"), and the first attempt pressed it after the tabletop
      suite had already played to a winner. A control that is only reachable mid-game has to be
      checked mid-game.
    */
    await tid(host, 'hand-to-engine').click();
    const started = await until(host, async () => has(host, 'phase-bar'), 25000);
    check('handing the table to the rules engine starts a real game', started,
      started ? '' : `no phase bar; the table said: ${await complaint(host)}`);
    check('and the other player is in the same game',
      await until(guest, async () => has(guest, 'phase-bar'), 25000));
    await shot(host, 'handed-to-the-engine');

    /*
      ── Starting over ────────────────────────────────────────────────────────────────────────────

      Reached by conceding, because "New game" sits in the **post-game** block beside "Play again" —
      which is the third wrong guess this file cost: the first version pressed it on a live table
      and waited thirty seconds for a button that only exists once a game has ended. Conceding is
      also the quickest honest way to end a game from here, and it presses `concede`, which was
      itself on the audit's list.

      `game:reset` clears `cardDefs` and `instances`, which means it clears the **decks** as well as
      the board — so "New game" leaves a table that cannot be dealt until both players pick again,
      and `start-game` is present but disabled rather than absent. That is the behaviour the
      button's own comment describes ("what you want when somebody is changing decks"), so it is
      what gets asserted.
    */
    /*
      ── The escape hatch inside an automated game ────────────────────────────────────────────────

      "Move by hand" is the thing two people need when the engine will not let them do something it
      does not script — a real rule it has no card for, or a mistake to tidy up. It is the only way
      back to tabletop moves without abandoning the game, and nothing had ever pressed it.

      The sheet is opened by tapping a card, so the hands are settled first: the control bar shows
      the mulligan row until they are, and a card tapped then opens nothing.
    */
    for (let move = 0; move < 20 && !(await has(host, 'concede')); move += 1) {
      if (await isMyMove(host)) await makeMove(host, 0);
      else if (await isMyMove(guest)) await makeMove(guest, 1);
      else await host.waitForTimeout(250);
    }
    const aCard = cardsIn(host, 'zone-hand-0').first();
    if ((await aCard.count()) > 0) {
      await aCard.click();
      const sheet = await until(host, async () => has(host, 'play-sheet'), 10000);
      check('tapping a card in an automated game offers what the engine will do with it', sheet);
      if (sheet) {
        check('and nothing is offered by hand until it is asked for',
          (await host.locator('[data-testid^="act-"]').count()) === 0);
        await tid(host, 'toggle-manual').click();
        check('"Move by hand" offers the tabletop moves the engine does not script',
          await until(host, async () => (await host.locator('[data-testid^="act-"]').count()) > 0, 10000),
          `act-* buttons: ${await host.locator('[data-testid^="act-"]').count()}`);
        await shot(host, 'move-by-hand');
        await tid(host, 'play-sheet-close').click();
        await host.waitForSelector('[data-testid="play-sheet"]', { state: 'detached', timeout: 5000 });
      }
    }

    /*
      The opening hands first, which is the fourth wrong guess this file cost.

      `concede` is on the control bar, and the bar shows the mulligan row instead while a seat is
      still settling its hand — so the button is simply not rendered yet, the click waited thirty
      seconds, and the failure read "the table said: (nothing)" because the table had nothing to
      complain about. Answering the prompts with the driver's own move loop is what a player does.
    */
    for (let move = 0; move < 20 && !(await has(host, 'concede')); move += 1) {
      if (await isMyMove(host)) await makeMove(host, 0);
      else if (await isMyMove(guest)) await makeMove(guest, 1);
      else await host.waitForTimeout(250);
    }
    check('the engine asks for opening hands, and the bar comes back once they are settled',
      await has(host, 'concede'));
    /*
      Twice, because the button arms on the first press and concedes on the second — it reads
      "Concede", then "really?". That is deliberate: conceding is irreversible and a misclick on a
      phone would end somebody's game. It is also the fifth thing this file got wrong by assuming:
      a single click armed it, nothing was sent, and the failure read "no concede in the log, so
      the click did not land" — which is exactly what a failure message is for.
    */
    await tid(host, 'concede').click();
    check('conceding asks for confirmation rather than ending the game on one tap',
      /really/i.test((await tid(host, 'concede').textContent()) ?? ''),
      (await tid(host, 'concede').textContent()) ?? '');
    await tid(host, 'concede').click();
    const conceded = await until(host, async () => has(host, 'game-over'), 25000);
    /*
      The log in the failure message, because the first three versions of this reported only that
      no game-over appeared — which cannot distinguish "the click missed" from "the action applied
      and the game did not end". The log says `<name> conceded` the moment the action lands, so the
      message now names which of the two it was.
    */
    let whyNotOver = '';
    if (!conceded) {
      await tid(host, 'toggle-log').click();
      await waitFor(host, 'log-panel');
      const text = (await tid(host, 'log-panel').textContent()) ?? '';
      whyNotOver = /conceded/i.test(text)
        ? `the concede landed ("${/[^.]*conceded[^.]*/i.exec(text)?.[0]?.trim()}") but the game did not end`
        : `no concede in the log, so the click did not land; the table said: ${await complaint(host)}`;
      await tid(host, 'log-panel').click({ position: { x: 5, y: 5 } });
      await host.waitForSelector('[data-testid="log-panel"]', { state: 'detached', timeout: 5000 });
    }
    check('conceding ends the game', conceded, whyNotOver);
    check('and the other player is told who won',
      await until(guest, async () => has(guest, 'game-over'), 25000));
    await tid(host, 'new-game').click();
    check('"New game" takes the rules engine back off the table',
      await until(host, async () => !(await has(host, 'phase-bar')), 20000));
    const deckOffered = await until(host, async () => has(host, 'deck-ember-rush'), 20000);
    check('and asks for decks again, because a reset empties them too', deckOffered);
    check('with the deal held until somebody picks one',
      deckOffered && !(await tid(host, 'start-game').isEnabled()));
    await shot(host, 'started-over');

    /*
      ── Getting up ───────────────────────────────────────────────────────────────────────────────

      The guest leaves and the host is left at a table with one seat filled. Checked from both
      sides, because "I left" and "they left" are two different pieces of state.
    */
    await tid(guest, 'leave-table').click();
    check('leaving puts that player back in the lobby',
      await until(guest, async () => has(guest, 'lobby'), 20000));
    check('and the table they left says the seat is empty',
      await until(host, async () => {
        const seats = await host.locator('[data-testid^="lobby-seat-"]').count();
        return seats === 1;
      }, 20000),
      `seats still shown: ${await host.locator('[data-testid^="lobby-seat-"]').count()}`);

    check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('no React warnings', reactWarnings.length === 0, reactWarnings.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
  process.exit(summarize() ? 0 : 1);
}

main().catch((err) => {
  console.error(`\ncheck aborted: ${err.message}`);
  process.exit(1);
});
