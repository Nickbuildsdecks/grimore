/**
 * Two browsers, one game of Magic with the rules engine running it.
 *
 * The sibling of `e2e-table.mjs`, which does the same for the manual tabletop. This one is the
 * acceptance test for Arena mode, and the question it answers is the only one that matters: can two
 * people sit down at two machines, start a game, and have the computer play Magic with them —
 * steps, priority, the stack, targeting, combat, damage — without getting stuck.
 *
 * ## How it plays
 *
 * Mostly by taking whatever the UI offers, which is deliberate. A script that clicked a fixed
 * sequence would only ever test the one game it was written against; this one reads the primary
 * action button, the play sheet and the declaration prompts and acts on them, so it plays whatever
 * game the shuffle deals. That makes it the browser-side twin of the engine's own `playout` test:
 * if the UI ever offers something the engine refuses, or stops offering anything at all, the game
 * stops advancing and this fails.
 *
 * On top of that it asserts the specific things a player would notice:
 *
 *   - the phase bar says which step it is and who the game is waiting for
 *   - a land played from hand turns into mana when tapped, and the pool shows it
 *   - a spell with a target waits for the target, puts an object on the stack, and resolves
 *   - a creature's power on screen is the one the engine computed, not the printed one
 *   - combat asks the attacker to declare, then the defender to block
 *   - life totals move on their own, because the rules moved them
 *   - the opponent's hand is still unreadable, with the engine running
 *   - the whole thing fits a phone
 *
 * Run it yourself (the launcher starts both servers):
 *   PLAY_HOST=127.0.0.1 node scripts/play.mjs &
 *   node scripts/e2e-arena.mjs
 *
 * Screenshots land in SHOT_DIR (default ./e2e-shots/arena), so a failure can be looked at.
 */
import path from 'node:path';
import {
  chromium, check, checks, setShotDir, summarize, shot, waitFor, tid, cardsIn, has, text,
  readNumber, expectEventually, isMyMove, makeMove as drive, notePrompts, noteMove,
} from './lib/table-driver.mjs';

const BASE = process.env.TABLE_URL ?? 'http://127.0.0.1:5100/react/play';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join('e2e-shots', 'arena');
const HEADED = process.env.HEADED === '1';
/** How many clicks the auto-player is allowed before it gives up and reports where it stopped. */
const MAX_MOVES = Number.parseInt(process.env.MAX_MOVES ?? '600', 10);
/** Which decks the two players pick. `tidal-mind` is the one with counterspells. */
const DECK_A = process.env.DECK_A ?? 'ember-rush';
const DECK_B = process.env.DECK_B ?? 'verdant-guard';
/**
 * Makes both players mulligan once, whatever they were dealt.
 *
 * Mulliganing is rare — one hand in nine — so left to the shuffle, the flow that follows it
 * (choosing which card goes back to the bottom) would almost never be exercised. The run with
 * this on is the one that tests it.
 */
const FORCE_MULLIGAN = process.env.FORCE_MULLIGAN === '1';

/** `makeMove` with this suite's mulligan policy attached. */
const makeMove = (page, seat, opts = {}) => drive(page, seat, { forceMulligan: FORCE_MULLIGAN, ...opts });

/**
 * Nothing taps mana by hand, on purpose.
 *
 * The engine taps for a cost it can pay, so a driver that tapped lands first would only be
 * spending mana it did not need — and, worse, leaving nothing untapped at the end of its own turn,
 * which is exactly the mana a counterspell is held up for. Playing without touching a land is
 * also how a person would play: you pick the spell and the mana follows.
 */

async function main() {
  await setShotDir(SHOT_DIR);
  const browser = await chromium.launch({ headless: !HEADED });
  const nickCtx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const friendCtx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const nick = await nickCtx.newPage();
  const friend = await friendCtx.newPage();

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
    // ── Sit down ────────────────────────────────────────────────────────────────────────────────
    await nick.goto(BASE);
    await waitFor(nick, 'lobby');
    await tid(nick, 'player-name').fill('Nick');
    await tid(nick, 'format-modern').click();
    await tid(nick, 'create-table').click();
    await waitFor(nick, 'pregame');
    const code = (await tid(nick, 'table-code').textContent())?.trim() ?? '';

    await friend.goto(BASE);
    await waitFor(friend, 'lobby');
    await tid(friend, 'player-name').fill('Friend');
    await tid(friend, 'join-code').fill(code);
    await tid(friend, 'join-table').click();
    await waitFor(friend, 'pregame');

    await tid(nick, 'ready').click();
    await tid(friend, 'ready').click();
    await waitFor(nick, `deck-${DECK_A}`);
    await tid(nick, `deck-${DECK_A}`).click();
    await tid(friend, `deck-${DECK_B}`).click();

    // ── Hand the table to the rules engine ──────────────────────────────────────────────────────
    await expectEventually(nick, 'the host is offered a game run by the rules engine', async () =>
      (await has(nick, 'start-engine')) && (await tid(nick, 'start-engine').isEnabled()));
    await tid(nick, 'start-engine').click();

    await waitFor(nick, 'table');
    await waitFor(friend, 'table');
    await expectEventually(nick, 'the engine takes over and asks for an opening-hand decision', async () =>
      (await has(nick, 'phase-bar')) && (await has(nick, 'mulligan-prompt')));
    await expectEventually(friend, 'and asks the other player too, at the same time', async () =>
      has(friend, 'mulligan-prompt'));
    await shot(nick, 'opening-hand');
    // Checked here, with the opening hand on the table: after the decision a player who
    // mulliganed is holding six.
    await expectEventually(nick, 'Nick is dealt seven cards', async () =>
      (await cardsIn(nick, 'zone-hand-0').count()) === 7);
    await expectEventually(friend, 'Friend is dealt seven cards', async () =>
      (await cardsIn(friend, 'zone-hand-1').count()) === 7);

    // Both keep (or mulligan) before anybody has priority.
    for (const [page, seat] of [[nick, 0], [friend, 1]]) {
      for (let i = 0; i < 6 && (await isMyMove(page)); i++) {
        if (!(await has(page, 'mulligan-prompt')) && !(await has(page, 'bottom-prompt'))) break;
        await makeMove(page, seat);
        await page.waitForTimeout(150);
      }
    }
    await expectEventually(nick, 'and the first turn begins once both hands are settled', async () =>
      !(await has(nick, 'mulligan-prompt')) && !(await has(friend, 'mulligan-prompt')));
    if (FORCE_MULLIGAN) {
      // A London mulligan draws a fresh seven and puts one back, so the hand is six.
      await expectEventually(nick, 'a mulliganed hand is six cards, not seven', async () =>
        (await cardsIn(nick, 'zone-hand-0').count()) === 6);
      await expectEventually(friend, 'and the same for the other player', async () =>
        (await cardsIn(friend, 'zone-hand-1').count()) === 6);
      await shot(nick, 'after-mulligan');
    }
    await expectEventually(friend, 'both players see it, not just the host', async () =>
      has(friend, 'phase-bar'));
    await expectEventually(nick, 'the manual control bar is replaced by the engine’s own', async () =>
      (await has(nick, 'arena-bar')) && !(await has(nick, 'controls')));
    await shot(nick, 'engine-started');

    // The engine begins the first turn at its upkeep, with the active player holding priority.
    await expectEventually(nick, 'the step is named rather than left to be guessed at', async () => {
      const label = await text(nick, 'step-label');
      return label.length > 0 && /upkeep|main|draw/i.test(label);
    });
    await expectEventually(nick, 'the bar says who the game is waiting for', async () =>
      /priority|waiting/i.test(await text(nick, 'waiting-on')));
    await expectEventually(nick, 'the stack starts empty and says so', async () => has(nick, 'stack-empty'));

    // ── Hidden information still holds ──────────────────────────────────────────────────────────
    const friendHandAsNickSees = await cardsIn(nick, 'zone-hand-1').evaluateAll((els) =>
      els.map((e) => ({ hidden: e.getAttribute('data-hidden'), name: e.getAttribute('data-card-name') })));
    check(
      'with the engine running, the opponent’s hand is still unreadable',
      // Four, not seven: a London mulligan settles at seven minus the number taken, so a hand of
      // five is a player who mulliganed twice rather than a bug. The floor is only here to stop
      // the claim going vacuous against an empty hand — the claim itself is the `every`.
      friendHandAsNickSees.length >= 4 && friendHandAsNickSees.every((c) => c.hidden === 'true' && !c.name),
      JSON.stringify(friendHandAsNickSees).slice(0, 160),
    );
    // Not merely hidden by a CSS rule: there is no card text inside those elements at all,
    // because the server never sent any. Scoped to the hand itself rather than to the whole page,
    // because two decks can legitimately contain the same card — a page-wide grep for a card name
    // fails the moment both players are playing green.
    const leaked = await nick.evaluate(() => {
      const zone = document.querySelector('[data-testid="zone-hand-1"]');
      return zone === null ? 'missing' : (zone.textContent ?? '');
    });
    check(
      'and there is no card text inside the opponent’s hand at all',
      leaked !== 'missing' && !/[a-z]{4}/.test(leaked.replace(/GRIMORE/gi, '')),
      leaked.slice(0, 120),
    );

    // ── Only one player is asked to act at a time ───────────────────────────────────────────────
    const nickMoves = await isMyMove(nick);
    const friendMoves = await isMyMove(friend);
    check(
      'exactly one player is being asked to act',
      nickMoves !== friendMoves,
      `nick=${nickMoves} friend=${friendMoves}`,
    );
    await expectEventually(friend, 'and the other is told they are waiting', async () =>
      (await has(friend, 'not-your-move')) || (await isMyMove(friend)));

    // ── Play the game out ───────────────────────────────────────────────────────────────────────
    // From here the script takes whatever the UI offers, as a player would, and watches for the
    // milestones that prove each part of the engine is wired through.
    const seen = {
      land: false, mana: false, stack: false, attackers: false, blockers: false,
      lifeChanged: false, combatStep: false, computedBody: false, countered: false, turnsPassed: 0,
      decided: false, searched: false, modal: false, x: false, xCast: null,
    };
    const startLifeNick = await readNumber(nick, 'life-0');
    const startLifeFriend = await readNumber(friend, 'life-1');
    let lastTurn = await readNumber(nick, 'turn');
    let moves = 0;
    let finished = false;
    let lastMove = '';
    let repeats = 0;

    while (moves < MAX_MOVES) {
      if (await has(nick, 'game-over')) {
        finished = true;
        break;
      }
      const actor = (await isMyMove(nick)) ? { page: nick, seat: 0, who: 'Nick' }
        : (await isMyMove(friend)) ? { page: friend, seat: 1, who: 'Friend' }
        : null;
      if (actor === null) {
        // Nobody has anything to do: either the sockets are mid-flight, or the game is stuck.
        await nick.waitForTimeout(250);
        moves += 1;
        if (moves % 20 === 0) {
          const where = `${await text(nick, 'step-label')} / turn ${await readNumber(nick, 'turn')}`;
          console.log(`      (waiting — ${where})`);
        }
        continue;
      }

      // Milestones, read before the move so the prompt that is on screen is the one recorded.
      // Being *asked* counts, which is what the primary button says before the declaration screen
      // opens — the question is whether the engine asks the right player, not how many clicks it
      // takes to answer.
      if (await has(actor.page, 'attack-prompt')) seen.attackers = true;
      if (await has(actor.page, 'block-prompt')) seen.blockers = true;
      await notePrompts(seen, actor.page, actor.seat);
      if (await has(actor.page, 'primary-move')) {
        const label = await text(actor.page, 'primary-move');
        if (/declare attackers/i.test(label)) seen.attackers = true;
        if (/declare blockers/i.test(label)) seen.blockers = true;
      }
      if (/declare|combat/i.test(await text(actor.page, 'step-label'))) seen.combatStep = true;

      const did = await makeMove(actor.page, actor.seat);
      moves += 1;
      if (did !== null && moves % 10 === 0) {
        console.log(`      move ${moves}: ${actor.who} ${did}`);
      }
      await actor.page.waitForTimeout(90);

      // The same move being made over and over without the game moving on is the failure mode
      // worth catching early: it means the table offered something the engine refused.
      const here = `${actor.who}:${did}:${await text(nick, 'step-label')}:${await readNumber(nick, 'turn')}`;
      repeats = here === lastMove ? repeats + 1 : 0;
      lastMove = here;
      if (repeats >= 8) {
        const err = (await has(nick, 'table-error')) ? await text(nick, 'table-error')
          : (await has(friend, 'table-error')) ? await text(friend, 'table-error')
          : 'no error shown';
        check('the table never offers a move the engine refuses', false, `stuck on "${did}" at ${here} — ${err}`);
        break;
      }

      // Did anything the engine owns happen?
      if (!seen.stack && (await nick.locator('[data-testid^="stack-"]').count()) > 0) {
        seen.stack = true;
        await shot(nick, 'stack-in-use');
      }
      // Looked for on whichever page is acting: targeting is a state of that one browser, so the
      // other player never sees the prompt at all.
      if (!seen.countered && (await actor.page.locator('[data-testid^="target-stack-"]').count()) > 0) {
        seen.countered = true;
        await shot(actor.page, 'countering-a-spell');
      }
      if (did !== null && /counter/i.test(did)) seen.countered = true;
      await noteMove(seen, actor.page, did);
      if (!seen.mana) {
        // Either floating mana, or the dimmed "what you could still make" display. With the engine
        // tapping for a spell's cost the pool is usually spent in the same action it was filled,
        // so what the player actually reads most of the time is the second one.
        const floating = await nick.locator('[data-testid^="pool-"]').count();
        const available = await nick.locator('[data-testid="mana-potential"]').count();
        if (floating > 0 || available > 0) seen.mana = true;
      }
      if (!seen.land && (await cardsIn(nick, 'zone-battlefield-0').count()) > 0) seen.land = true;
      if (!seen.computedBody) {
        const gold = await nick.locator('[data-testid^="body-"].text-\\[var\\(--g-gold-400\\)\\]').count();
        if (gold > 0) {
          seen.computedBody = true;
          await shot(nick, 'computed-power');
        }
      }
      const turn = await readNumber(nick, 'turn');
      if (turn > lastTurn) {
        seen.turnsPassed += turn - lastTurn;
        lastTurn = turn;
      }
      if (!seen.lifeChanged) {
        const l0 = await readNumber(nick, 'life-0');
        const l1 = await readNumber(nick, 'life-1');
        if (l0 !== startLifeNick || l1 !== startLifeFriend) {
          seen.lifeChanged = true;
          await shot(nick, 'life-changed-by-the-rules');
        }
      }
      // Enough has been seen to prove every part is wired; stop before a long game times out.
      const enough = seen.land && seen.mana && seen.stack && seen.attackers && seen.blockers &&
        seen.lifeChanged && seen.turnsPassed >= 4;
      if (enough) break;
    }

    console.log(`      played ${moves} moves over ${seen.turnsPassed} turn changes`);
    check('the game keeps advancing — the engine never gets stuck', seen.turnsPassed >= 4, JSON.stringify(seen));
    // The stack is drawn as a list rather than as cards, so a spell on it needs its own way to be
    // pointed at. Whether the situation comes up is the shuffle's business — a counterspell has to
    // be drawn, be affordable, and have something worth countering — so it is asserted when the
    // game produced it and reported when it did not. `playout.test.ts` asserts deterministically
    // that counterspells get cast; this is about the one thing only a browser can show, which is
    // that a row in the stack panel can be tapped as a target.
    // A question asked mid-resolution. Whether one comes up is the shuffle's business — a tutor or
    // a looting spell has to be drawn and affordable — so it is asserted when the game produced
    // one and reported when it did not. The deterministic version lives in `scripts.test.ts`; what
    // only a browser can show is that the prompt has a visible answer, and the search case is the
    // one worth naming because the cards are in a library the table draws nowhere else.
    if (seen.decided) {
      check('a question asked mid-resolution can be answered from the table', true);
      if (seen.searched) check('a library search shows the library and lights what may be taken', true);
      else console.log('      (nothing searched a library in this game)');
    } else {
      console.log('      (no card stopped to ask a question in this game — scripts.test.ts covers '
        + 'that path on a fixed board)');
    }
    if (seen.countered) {
      check('a spell on the stack can be targeted', true);
    } else if (DECK_A === 'tidal-mind' || DECK_B === 'tidal-mind') {
      console.log('      (no counterspell was castable in this game — nothing to aim at the stack)');
    }
    check('a land played from hand reaches the battlefield', seen.land);
    check('the bar shows the mana available to spend', seen.mana);
    check('a spell or ability goes on the stack and resolves', seen.stack);
    check('combat asks the attacking player to declare', seen.attackers);
    // Whether a *block* is ever required depends on the shuffle: a defender with no untapped
    // creature is not asked, and the engine declares an empty block for them. So this is asserted
    // when the game produced the situation and reported when it did not — `combat.test.ts` owns
    // the deterministic version of the claim, on a board built to need a block.
    if (seen.blockers) {
      check('and asks the defending player to block', true);
    } else {
      console.log('      (no block was called for in this game — the defender was never attacked '
        + 'with a creature able to block; combat.test.ts covers that path on a fixed board)');
    }
    check('life totals move because the rules moved them', seen.lifeChanged);
    await shot(nick, 'mid-game-nick');
    await shot(friend, 'mid-game-friend');

    // ── The board agrees with the engine ────────────────────────────────────────────────────────
    // Every creature on screen shows the power the engine computed. A card whose body came from the
    // printed values would disagree the moment a counter or a pump existed.
    const bodies = await nick.locator('[data-testid^="body-"]').evaluateAll((els) =>
      els.map((e) => e.textContent?.trim() ?? ''));
    check(
      'creatures on the battlefield show a current power and toughness',
      bodies.length === 0 || bodies.every((b) => /^\d+\/\d+$/.test(b)),
      JSON.stringify(bodies).slice(0, 120),
    );

    // ── A refresh mid-game must not lose the seat ───────────────────────────────────────────────
    const handBeforeReload = await cardsIn(friend, 'zone-hand-1').count();
    await friend.reload();
    await expectEventually(friend, 'a mid-game refresh rejoins the same automated game', async () => {
      if (!(await has(friend, 'table'))) return false;
      if (!(await has(friend, 'phase-bar'))) return false;
      return (await cardsIn(friend, 'zone-hand-1').count()) === handBeforeReload;
    }, 20000);
    await shot(friend, 'after-reload');

    // ── Finish it, if it has not finished itself ────────────────────────────────────────────────
    if (!finished) {
      // A longer budget than the first loop: that one stops as soon as it has seen every part of
      // the engine work, while this one has to actually finish a game — and a slow matchup can run
      // past turn forty before somebody dies or decks out.
      let idle = 0;
      for (let i = 0; i < MAX_MOVES * 4 && !(await has(nick, 'game-over')); i++) {
        const actor = (await isMyMove(nick)) ? { page: nick, seat: 0 }
          : (await isMyMove(friend)) ? { page: friend, seat: 1 }
          : null;
        if (actor === null) {
          // Nobody on the clock for a long stretch means the game is stuck, not slow. Without
          // this the run burns its whole budget and then reports only where it stopped.
          idle += 1;
          if (idle > 60) break;
          await nick.waitForTimeout(200);
          continue;
        }
        idle = 0;
        await notePrompts(seen, actor.page, actor.seat);
        const did = await makeMove(actor.page, actor.seat, { aggression: 0.85 });
        await noteMove(seen, actor.page, did);
        if (did !== null && i % 20 === 0) console.log(`      finishing ${i}: ${did}`);
        if (did === null) {
          // The table is asking for something this script cannot answer, which is worth saying
          // out loud rather than letting it look like a slow game.
          check('every prompt the table shows can be answered', false,
            `no answer at ${await text(actor.page, 'step-label')} on turn ${await readNumber(nick, 'turn')}`);
          break;
        }
        await actor.page.waitForTimeout(40);
      }
      finished = await has(nick, 'game-over');
    }
    check('the game reaches a winner through the real UI', finished,
      finished ? '' : `stopped at ${await text(nick, 'step-label')} turn ${await readNumber(nick, 'turn')}`);

    // Reported here rather than mid-game, because most of a game is played in the loop above: a
    // modal spell cast on turn fifteen was being announced as "never castable" by a check that had
    // already run. Whether one is drawn and affordable at all is the shuffle's business, so it is
    // asserted when the game produced one and reported when it did not; `scripts.test.ts` owns the
    // deterministic version, on a board built to need it.
    if (seen.x) {
      check('an X spell asks how big it is, and is cast for what was chosen', Boolean(seen.xCast),
        seen.xCast ?? 'the prompt appeared but no cast came out of it');
    } else {
      console.log('      (no X spell came up in this game — scripts.test.ts covers that path '
        + 'on a fixed board)');
    }
    if (seen.modal) {
      check('a modal spell offers its modes as plays and one can be cast', true);
    } else {
      console.log('      (no modal spell came up in this game — scripts.test.ts covers that path '
        + 'on a fixed board)');
    }
    if (finished) {
      const over = await text(nick, 'game-over');
      check('and both players are told who won', /wins/.test(over), over.slice(0, 80));
      await expectEventually(friend, 'the loser sees the same result', async () =>
        /wins/.test(await text(friend, 'game-over')));
      await shot(nick, 'game-over');
    }

    // ── Phone layout ────────────────────────────────────────────────────────────────────────────
    await nick.setViewportSize({ width: 390, height: 844 });
    await nick.waitForTimeout(400);
    const overflow = await nick.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('the automated table fits a phone with no sideways scrolling', overflow <= 1, `overflow ${overflow}px`);
    const barVisible = await nick.evaluate(() => {
      const bar = document.querySelector('[data-testid="arena-bar"]');
      if (!bar) return 'missing';
      const box = bar.getBoundingClientRect();
      return box.left >= -1 && box.right <= window.innerWidth + 1 ? 'ok' : `clipped (${box.left}..${box.right})`;
    });
    check('and the engine’s control bar stays fully on screen', barVisible === 'ok', String(barVisible));
    await shot(nick, 'phone');

    // The strongest form of "the table only offers what the engine accepts": a refusal would have
    // left its message on screen, because the banner stays until it is dismissed and nothing in
    // this script dismisses one.
    const refusals = [];
    for (const [who, page] of [['Nick', nick], ['Friend', friend]]) {
      if (await has(page, 'table-error')) refusals.push(`${who}: ${await text(page, 'table-error')}`);
    }
    check('the engine never refused anything the table offered', refusals.length === 0, refusals.join(' | '));

    check('no uncaught errors in either browser', pageErrors.length === 0, pageErrors.join(' | '));
    check('no failed requests other than the API this table does not need', badRequests.length === 0, badRequests.join(' | '));
  } catch (err) {
    check('the run completed without throwing', false, err.message);
    await shot(nick, 'nick-at-failure').catch(() => {});
    await shot(friend, 'friend-at-failure').catch(() => {});
  } finally {
    await browser.close();
  }

  summarize();
}

await main();
